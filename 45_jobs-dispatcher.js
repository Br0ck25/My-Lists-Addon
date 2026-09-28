
// --- Background jobs: the dispatcher (Phase 5, P5-2) ---------------------------
//
// The cron tick stops doing work and hands it to the queue (44_jobs-queue.js).
// What it hands over is kept in the `jobs` table (migration 0016), one row per
// job, so nothing is lost when a message is, and a job that died half way is
// noticed and run again.
//
// Two kinds of row-backed job, both defined at module level in the file that
// owns the work:
//
//   definePeriodicJob(type, { everyMs, leaseMs, legacy, run })
//     Runs every `everyMs`. Its row (`dedupe_key` "periodic:{type}") is made by
//     the dispatcher and never finishes: after each run it waits for its next
//     turn. A run that fails is tried again sooner (the retry delays of
//     44_, capped at everyMs). The cron's own work (the Continue Watching and
//     Airing Next sweeps, New on Streaming, chart and poster warming, channel
//     presets, housekeeping) is periodic jobs marked `legacy`: see below.
//
//   defineDurableJob(type, { leaseMs, maxAttempts, run })
//     One-off work somebody asked for (an import, an account purge), started
//     with createJob(env, type, { dedupeKey, accountId, payload }). `run`
//     returns nothing when done, `{ progress, again: true }` to carry on in a
//     new run straight away (long work in bounded steps), or `{ progress,
//     waitMs }` to carry on later. It throws to be tried again after a delay;
//     after `maxAttempts` failed runs the row is `failed`. `progress` is kept in
//     `progress_json`, where a page can read it.
//
// A row's life: `queued` (waiting until `run_after`) -> sent to the queue
// (`run_after` becomes a token, now + JOBS_DISPATCH_GRACE_MS) -> `running`
// (`run_after` is the lease expiry) -> back to `queued` (periodic, or a
// durable job carrying on or waiting), `done` or `failed`. Every change is a
// compare-and-set on (status, run_after), so a message delivered twice, two
// overlapping ticks, or a dispatcher and a consumer racing, run a job once.
//
// The dispatcher (every cron tick, dispatchJobs):
//   - makes sure every periodic job has its row (one statement);
//   - finds the rows that are due: waiting and past `run_after`, or `running`
//     past their lease (their run stopped: counted as a failed attempt);
//   - sends each to the queue with its token.
//   A row that was sent and not picked up within JOBS_DISPATCH_GRACE_MS (the
//   message was lost, or the queue has no consumer) is run by the tick itself
//   instead, at most JOBS_INLINE_LIMIT a tick, so a queue that is not
//   delivering slows the work down but never stops it.
//
// Without the JOBS binding, or without the `jobs` table (migration 0016 not
// applied yet), or if dispatching fails, the tick does the cron's work itself
// exactly as before this change (runLegacyCronTasks), and runs other due jobs
// itself (the fallback of NEXT_VERSION_ARCHITECTURE.md section 6.4).
//
// Rows of other types (the list and history copies' `migrate.*` rows) are
// never touched: every query names the job types defined here.
//
// Module level, after the Worker's exports, like 27_ onward.

// How long a row sent to the queue waits to be picked up before the tick runs
// it itself. Well above a healthy queue's delay (seconds), well below an hour.
const JOBS_DISPATCH_GRACE_MS = 10 * 60 * 1000;
// A running job's lease: the queue consumer's wall-time limit. A row still
// `running` after it has died.
const JOBS_DEFAULT_LEASE_MS = 15 * 60 * 1000;
const JOBS_DISPATCH_LIMIT = 100;
const JOBS_INLINE_LIMIT = 10;
const JOBS_DURABLE_MAX_ATTEMPTS = JOBS_MAX_RETRIES + 1;
// A periodic job is next due this much before a whole period has passed since
// it started, so a job meant for every tick is due at the next tick whether
// the trigger fires every 5 or every 6 minutes, and an hourly job is not
// pushed a whole tick later every hour.
const JOBS_PERIODIC_SLACK_MS = 90 * 1000;
// The cron's own work runs every tick.
const LEGACY_CRON_EVERY_MS = 4 * 60 * 1000;
const PERIODIC_JOB_KEY_PREFIX = "periodic:";

const ROW_JOB_TYPES = new Map(); // type -> spec

function defineRowJobType(type, spec) {
  defineJobType(type, {
    run: (env, payload, job) => runRowJob(env, spec, payload, job),
  });
  ROW_JOB_TYPES.set(type, spec);
}

function definePeriodicJob(type, { everyMs, leaseMs, legacy = false, run }) {
  if (!(Number(everyMs) > 0)) throw new Error(`Periodic job "${type}" needs everyMs.`);
  defineRowJobType(type, {
    type,
    periodic: true,
    legacy: !!legacy,
    everyMs: Number(everyMs),
    leaseMs: Number(leaseMs) || JOBS_DEFAULT_LEASE_MS,
    maxAttempts: Infinity,
    run,
  });
}

function defineDurableJob(type, { leaseMs, maxAttempts, run }) {
  defineRowJobType(type, {
    type,
    periodic: false,
    legacy: false,
    everyMs: 0,
    leaseMs: Number(leaseMs) || JOBS_DEFAULT_LEASE_MS,
    maxAttempts: Math.max(1, Number(maxAttempts) || JOBS_DURABLE_MAX_ATTEMPTS),
    run,
  });
}

function parseJobProgress(raw) {
  if (!raw) return {};
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// The job's own progress, without the dispatcher's bookkeeping (`_q`).
function jobUserProgress(progress) {
  const out = { ...progress };
  delete out._q;
  return out;
}

function jobErrorText(err) {
  let msg = "";
  try {
    msg = err && typeof err.message === "string" ? err.message : String(err);
  } catch {
    msg = "error";
  }
  return (typeof redactForLog === "function" ? redactForLog(msg) : msg).slice(0, 500);
}

function jobRowRetryMs(spec, failures) {
  const ms = jobRetryDelaySec(failures, spec) * 1000;
  return spec.periodic ? Math.min(ms, spec.everyMs) : ms;
}

// Runs one row-backed job: claims its row with the token it was sent with,
// runs it, and writes what happened. Called by the queue consumer (through the
// job type's handler) and by the tick for a job it runs itself. Returns
// { skipped } when the row is not this token's to run (a duplicate or late
// message, or the job was cancelled). Throws only when D1 does, so the queue
// delivers the message again; the row then stays `running` until its lease
// runs out and the dispatcher picks it up.
async function runRowJob(env, spec, payload, job = {}) {
  const jobId = Math.floor(Number(payload && payload.jobId));
  const token = Math.floor(Number(payload && payload.token));
  if (!(jobId > 0) || !(token > 0) || !env || !env.DB) return { skipped: "malformed" };
  const row = await env.DB.prepare(
    "SELECT id, type, status, attempts, run_after, payload_json, progress_json FROM jobs WHERE id = ?"
  ).bind(jobId).first();
  if (!row || row.type !== spec.type || row.status !== "queued" || Number(row.run_after) !== token) return { skipped: "stale" };

  const startedAt = Date.now();
  const leaseUntil = startedAt + spec.leaseMs;
  const progress = parseJobProgress(row.progress_json);
  const q = { ...(progress._q || {}), claimedAt: startedAt };
  const claim = await env.DB.prepare(
    "UPDATE jobs SET status = 'running', run_after = ?, progress_json = ?, updated_at = ? WHERE id = ? AND status = 'queued' AND run_after = ?"
  ).bind(leaseUntil, JSON.stringify({ ...progress, _q: q }), startedAt, jobId, token).run();
  if (!claim || !claim.meta || claim.meta.changes !== 1) return { skipped: "stale" };

  const attempts = (Number(row.attempts) || 0) + 1;
  let out = null;
  let error = null;
  try {
    out = await spec.run(env, parseJobProgress(row.payload_json), {
      ...job,
      jobId,
      attempts,
      progress: jobUserProgress(progress),
    });
  } catch (err) {
    error = err;
  }
  const finishedAt = Date.now();
  const tookMs = finishedAt - startedAt;
  const nextQ = { ...q, lastStartedAt: startedAt, lastFinishedAt: finishedAt, lastMs: tookMs, runs: (Number(q.runs) || 0) + 1 };
  const userProgress = out && out.progress && typeof out.progress === "object" ? out.progress : jobUserProgress(progress);

  let status;
  let runAfter;
  let newAttempts;
  let lastError = null;
  let sendToken = 0;
  if (error) {
    console.error(`[Jobs] ${spec.type} #${jobId} failed (run ${attempts}):`, error);
    newAttempts = attempts;
    lastError = jobErrorText(error);
    nextQ.failures = (Number(q.failures) || 0) + 1;
    if (!spec.periodic && newAttempts >= spec.maxAttempts) {
      status = "failed";
      runAfter = 0;
    } else {
      status = "queued";
      runAfter = finishedAt + jobRowRetryMs(spec, newAttempts);
    }
  } else if (spec.periodic) {
    status = "queued";
    newAttempts = 0;
    nextQ.lastOkAt = finishedAt;
    runAfter = Math.max(finishedAt, startedAt + spec.everyMs - JOBS_PERIODIC_SLACK_MS);
  } else if (out && out.again) {
    // Carry on straight away, in a new run: through the queue when there is
    // one, otherwise at the next tick.
    status = "queued";
    newAttempts = 0;
    if (jobsQueueBound(env)) {
      sendToken = finishedAt + JOBS_DISPATCH_GRACE_MS;
      runAfter = sendToken;
      nextQ.dispatchedAt = finishedAt;
    } else {
      runAfter = finishedAt;
    }
  } else if (out && Number(out.waitMs) > 0) {
    status = "queued";
    newAttempts = 0;
    runAfter = finishedAt + Number(out.waitMs);
  } else {
    status = "done";
    newAttempts = 0;
    runAfter = 0;
  }
  const saved = await env.DB.prepare(
    "UPDATE jobs SET status = ?, attempts = ?, run_after = ?, progress_json = ?, last_error = ?, updated_at = ? WHERE id = ? AND status = 'running' AND run_after = ?"
  ).bind(status, newAttempts, runAfter, JSON.stringify({ ...userProgress, _q: nextQ }), lastError, finishedAt, jobId, leaseUntil).run();
  if (!saved || !saved.meta || saved.meta.changes !== 1) {
    // The lease ran out and the dispatcher took the row back: its next run
    // repeats this one, which every job must allow for.
    console.warn(`[Jobs] ${spec.type} #${jobId} finished after its lease; its next run will repeat it.`);
    return { ran: true, late: true };
  }
  if (sendToken) {
    const sent = await enqueueJob(env, spec.type, { jobId, token: sendToken });
    if (!sent.ok) console.warn(`[Jobs] ${spec.type} #${jobId}: could not send its next step (${sent.reason}); the next tick will run it.`);
  }
  return { ran: true, status, failed: !!error };
}

// Starts a one-off job. A job with the same dedupe key that is still waiting
// or running is the same job (nothing new is made); one that is done or
// failed is started again with the new payload. Resolves to { ok, id, created,
// sent } or { ok: false, reason }. Throws only for a type that is not a
// durable job (a mistake in the code).
async function createJob(env, type, { dedupeKey = null, accountId = null, payload = {} } = {}) {
  const spec = ROW_JOB_TYPES.get(type);
  if (!spec || spec.periodic) throw new Error(`"${type}" is not a job type that can be created.`);
  if (!env || !env.DB) return { ok: false, reason: "noDatabase" };
  let payloadJson;
  try {
    payloadJson = JSON.stringify(payload == null ? {} : payload);
  } catch {
    return { ok: false, reason: "unserializable" };
  }
  const now = Date.now();
  const viaQueue = jobsQueueBound(env);
  const runAfter = viaQueue ? now + JOBS_DISPATCH_GRACE_MS : now;
  const progressJson = JSON.stringify(viaQueue ? { _q: { dispatchedAt: now } } : {});
  let id = null;
  let changed = false;
  try {
    const res = await env.DB.prepare(
      `INSERT INTO jobs (type, dedupe_key, account_id, status, attempts, run_after, payload_json, progress_json, last_error, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(dedupe_key) DO UPDATE SET
         status = 'queued', attempts = 0, run_after = excluded.run_after, payload_json = excluded.payload_json,
         progress_json = excluded.progress_json, last_error = NULL, account_id = excluded.account_id, updated_at = excluded.updated_at
       WHERE jobs.status IN ('done', 'failed') AND jobs.type = excluded.type`
    ).bind(type, dedupeKey, accountId, runAfter, payloadJson, progressJson, now, now).run();
    changed = !!(res && res.meta && res.meta.changes === 1);
    if (dedupeKey != null) {
      const row = await env.DB.prepare("SELECT id, type FROM jobs WHERE dedupe_key = ?").bind(dedupeKey).first();
      if (!row) return { ok: false, reason: "notSaved" };
      if (row.type !== type) return { ok: false, reason: "dedupeKeyTaken" };
      id = row.id;
    } else {
      id = res && res.meta ? res.meta.last_row_id : null;
    }
  } catch (err) {
    console.error(`[Jobs] could not create ${type}:`, err);
    return { ok: false, reason: /no such table/i.test(jobErrorText(err)) ? "noJobsTable" : "databaseError" };
  }
  if (!changed) return { ok: true, id, created: false, sent: false };
  let sent = false;
  if (viaQueue) {
    const r = await enqueueJob(env, type, { jobId: id, token: runAfter });
    sent = r.ok;
    // Not sent: the tick runs it once JOBS_DISPATCH_GRACE_MS has passed.
  }
  return { ok: true, id, created: true, sent };
}

function rowJobTypes({ includeLegacy = true } = {}) {
  const out = [];
  for (const [type, spec] of ROW_JOB_TYPES) {
    if (!includeLegacy && spec.legacy) continue;
    out.push(type);
  }
  return out;
}

// Takes the due rows of `types` for this tick: each is set to a fresh token
// (a compare-and-set, so an overlapping tick or a consumer cannot take the
// same row) and returned with what to do with it: "send" to the queue, or
// "inline" (run here). `inline: true` runs everything here (no queue).
async function takeDueJobs(env, types, now, { inline = false } = {}) {
  if (!types.length) return [];
  const { results } = await env.DB.prepare(
    `SELECT id, type, status, attempts, run_after, progress_json FROM jobs
     WHERE status IN ('queued', 'running') AND run_after <= ? AND type IN (SELECT value FROM json_each(?))
     ORDER BY run_after, id LIMIT ?`
  ).bind(now, JSON.stringify(types), JOBS_DISPATCH_LIMIT).all();
  const plans = [];
  let inlineCount = 0;
  for (const row of results || []) {
    const spec = ROW_JOB_TYPES.get(row.type);
    if (!spec) continue;
    const progress = parseJobProgress(row.progress_json);
    const q = { ...(progress._q || {}) };
    let attempts = Number(row.attempts) || 0;
    let lastError = null;
    let status = "queued";
    if (row.status === "running") {
      attempts++;
      lastError = "Did not finish: its run stopped, or took longer than its lease.";
      q.failures = (Number(q.failures) || 0) + 1;
      if (!spec.periodic && attempts >= spec.maxAttempts) status = "failed";
    }
    const undelivered = row.status === "queued" && Number(q.dispatchedAt) > 0 && !(Number(q.claimedAt) >= Number(q.dispatchedAt));
    const action = status === "failed" ? "fail" : inline || undelivered ? "inline" : "send";
    if (action === "inline") {
      if (inlineCount >= JOBS_INLINE_LIMIT) continue;
      inlineCount++;
    }
    const token = action === "fail" ? 0 : now + JOBS_DISPATCH_GRACE_MS;
    if (action === "send") q.dispatchedAt = now;
    else if (action === "inline") delete q.dispatchedAt;
    plans.push({
      row,
      spec,
      action,
      token,
      undelivered,
      stmt: env.DB.prepare(
        `UPDATE jobs SET status = ?, attempts = ?, run_after = ?, progress_json = ?, last_error = COALESCE(?, last_error), updated_at = ?
         WHERE id = ? AND status = ? AND run_after = ?`
      ).bind(status, attempts, token, JSON.stringify({ ...progress, _q: q }), lastError, now, row.id, row.status, row.run_after),
    });
  }
  if (!plans.length) return [];
  const outcomes = await env.DB.batch(plans.map((p) => p.stmt));
  return plans.filter((p, i) => outcomes[i] && outcomes[i].meta && outcomes[i].meta.changes === 1);
}

function runTakenJobsInline(env, ctx, plans) {
  return Promise.all(plans.map((p) =>
    runRowJob(env, p.spec, { jobId: p.row.id, token: p.token }, { id: `tick-${p.row.id}`, type: p.spec.type, attempts: 1, queue: "cron", ctx })
      .catch((err) => console.error(`[Jobs] ${p.spec.type} #${p.row.id} could not be run here:`, err))
  ));
}

// One tick with the queue: dispatch only. Resolves to a summary; throws when
// the jobs table cannot be used (the caller then does the work itself).
async function dispatchJobs(env, ctx, { now = Date.now() } = {}) {
  const startedAt = Date.now();
  const periodic = [];
  for (const [type, spec] of ROW_JOB_TYPES) if (spec.periodic) periodic.push(type);
  if (periodic.length) {
    await env.DB.prepare(
      `INSERT INTO jobs (type, dedupe_key, status, attempts, run_after, progress_json, created_at, updated_at)
       SELECT value, ? || value, 'queued', 0, 0, '{}', ?, ? FROM json_each(?) WHERE true
       ON CONFLICT(dedupe_key) DO NOTHING`
    ).bind(PERIODIC_JOB_KEY_PREFIX, now, now, JSON.stringify(periodic)).run();
  }
  const taken = await takeDueJobs(env, rowJobTypes(), now);
  const toSend = taken.filter((p) => p.action === "send");
  const toRun = taken.filter((p) => p.action === "inline");
  const failed = taken.filter((p) => p.action === "fail");
  for (const p of failed) console.error(`[Jobs] ${p.spec.type} #${p.row.id} failed for good: it stopped part way ${p.spec.maxAttempts} times.`);
  let sent = { ok: true, sent: 0, failed: 0 };
  if (toSend.length) {
    sent = await enqueueJobs(env, toSend.map((p) => ({ type: p.spec.type, payload: { jobId: p.row.id, token: p.token } })));
    // Not sent: those rows are run here once JOBS_DISPATCH_GRACE_MS has passed.
    if (!sent.ok) console.error(`[Jobs] ${sent.failed} of ${toSend.length} jobs could not be sent to the queue (${sent.reason}).`);
  }
  if (toRun.length) {
    for (const p of toRun) {
      console.warn(`[Jobs] ${p.spec.type} #${p.row.id} was sent to the queue and not picked up within ${Math.round(JOBS_DISPATCH_GRACE_MS / 60000)} minutes; running it here. Check the queue's consumer (docs/OPERATIONS.md section 18).`);
    }
    const running = runTakenJobsInline(env, ctx, toRun);
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(running);
    else await running;
  }
  const summary = { ok: true, mode: "queue", due: taken.length, sent: sent.sent, sendFailed: sent.failed, inline: toRun.length, failed: failed.length, ms: Date.now() - startedAt };
  writeJobsDispatchMetric(env, summary);
  return summary;
}

// No queue: the tick runs due jobs itself (other than the cron's own work,
// which runLegacyCronTasks does), a few per tick, one after another.
async function runDueJobsInline(env, ctx, { now = Date.now() } = {}) {
  const types = rowJobTypes({ includeLegacy: false });
  if (!types.length || !env || !env.DB) return { ok: true, ran: 0 };
  let taken;
  try {
    taken = await takeDueJobs(env, types, now, { inline: true });
  } catch (err) {
    if (!/no such table/i.test(jobErrorText(err))) console.error("[Jobs] could not read due jobs:", err);
    return { ok: false, ran: 0 };
  }
  for (const p of taken.filter((t) => t.action === "inline")) {
    await runTakenJobsInline(env, ctx, [p]);
  }
  return { ok: true, ran: taken.length };
}

function writeJobsDispatchMetric(env, s) {
  const analytics = env && env.ANALYTICS && typeof env.ANALYTICS.writeDataPoint === "function" ? env.ANALYTICS : null;
  if (!analytics) return;
  try {
    analytics.writeDataPoint({
      blobs: ["jobs-dispatch", s.mode],
      doubles: [s.due || 0, s.sent || 0, s.sendFailed || 0, s.inline || 0, s.failed || 0, s.ms || 0],
      indexes: ["jobs-dispatch"],
    });
  } catch {
    // Metrics must never affect a tick.
  }
}

// The cron tick (the `scheduled` export, 26_). With the queue: dispatch, and
// nothing else. Otherwise, or if dispatching fails: the work, here, as before.
async function runCronTick(event, env, ctx) {
  if (jobsQueueBound(env) && env.DB) {
    try {
      const summary = await dispatchJobs(env, ctx);
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(providerBreakerFlush(env).catch(() => {}));
      return summary;
    } catch (err) {
      const msg = jobErrorText(err);
      if (/no such table/i.test(msg)) {
        console.warn("[Jobs] JOBS is bound but the jobs table is missing (apply migration 0016); this tick does the work itself.");
      } else {
        console.error("[Jobs] dispatching failed; this tick does the work itself:", err);
      }
    }
  }
  runLegacyCronTasks(env, ctx);
  if (env && env.DB) {
    ctx.waitUntil(runDueJobsInline(env, ctx).catch((err) => console.error("[Jobs] running due jobs failed:", err)));
  }
  return { ok: true, mode: "inline" };
}

// The cron's work as it ran before the queue, unchanged: used when there is no
// queue (or no jobs table).
function runLegacyCronTasks(env, ctx) {
  // `ctx.waitUntil(Promise.all([...]))` rejects the moment any one task
  // does, so each task gets its own catch and the tick is judged on whether it
  // ran, not on whether everything inside it succeeded.
  const guard = (label, p) => Promise.resolve(p).catch((err) => {
    console.error(`[Cron] ${label} failed:`, err);
  });
  // No outbound-fetch budget is divided between the tasks any more. That
  // arithmetic (CRON_SUBREQUEST_BUDGET and its shares) existed to fit a tick
  // inside the Workers Free plan's 50 subrequests; the hosted Worker runs on
  // Workers Paid (10,000 per invocation), and each task below keeps its own
  // per-tick limit for its own reasons (TMDB politeness, RapidAPI's monthly
  // quota, the per-account sweep size).
  //
  // The ordering is kept: the Continue Watching sweep writes first, because
  // it is the part a person is waiting on, and everything that spends
  // provider calls runs after it.
  const episodeSweep = guard("checkForNewEpisodes", checkForNewEpisodes(env));
  const streamingSweep = guard(
    "sweepNewOnStreaming",
    episodeSweep.then(() => sweepNewOnStreaming(env, ctx))
  );
  const airingNextSweep = guard(
    "refreshAiringNextSweep",
    episodeSweep.then(() => refreshAiringNextSweep(env, ctx))
  );
  const betterPosterWarm = guard(
    "prewarmBetterPosters",
    episodeSweep.then(() => prewarmBetterPosters(env, ctx))
  );
  ctx.waitUntil(
    Promise.all([
      episodeSweep,
      streamingSweep,
      airingNextSweep,
      betterPosterWarm,
      guard("bumpNewOnStreamingEpisodes", streamingSweep.then(() => bumpNewOnStreamingEpisodes(env, ctx))),
      guard("prewarmSharedCatalogs", streamingSweep.then(() => prewarmSharedCatalogs(env, ctx))),
      // One Quick Add network per tick (see prewarmChannelPresets,
      // 07_source-fetchers-tmdb-simkl.js) -- independent of the streaming
      // sweep chain above since it spends TMDB requests, not RapidAPI's
      // capped quota, and has nothing to wait on.
      guard("prewarmChannelPresets", prewarmChannelPresets(env, ctx)),
      guard("d1SchemaCheck", runD1SchemaCheckTask(env)),
      guard("pruneTombstones", pruneTombstones(env)),
    ]).then(() => guard("providerBreakerFlush", providerBreakerFlush(env)))
  );
}

// Cheap (one sqlite_master read) and the only thing that puts "you have not
// run migration N" somewhere an operator will see it without going looking.
// The admin panel shows the same thing on demand; this is for the case where
// nobody thought to look.
async function runD1SchemaCheckTask(env) {
  const status = await checkD1Schema(env);
  if (status.bound && status.checked && !status.ok) {
    console.warn(
      `[Cron] This Worker is running ahead of its D1 schema. Unapplied migration(s): ${status.pendingMigrations.join(", ")}. ` +
      status.missing.map((m) => `${m.name}: ${m.consequence}`).join(" | ")
    );
  }
  return status;
}

// Runs each of `tasks` ([label, () => promise]) whatever the others do, then
// throws the first failure, so the job's row records it.
async function runJobSteps(tasks) {
  let first = null;
  for (const [label, fn] of tasks) {
    try {
      await fn();
    } catch (err) {
      console.error(`[Jobs] ${label} failed:`, err);
      if (!first) first = err;
    }
  }
  if (first) throw first;
}

// --- The cron's work as periodic jobs -------------------------------------------
// With the queue, each piece of what runLegacyCronTasks does is its own job:
// its own retries, its own time limit, and never two runs of it at once (the
// row's lease). Same functions, same arguments. P5-3 onward replace them one
// by one.

definePeriodicJob("cron.episodes", {
  everyMs: LEGACY_CRON_EVERY_MS,
  legacy: true,
  run: (env) => checkForNewEpisodes(env),
});

definePeriodicJob("cron.airing-next", {
  everyMs: LEGACY_CRON_EVERY_MS,
  legacy: true,
  run: (env, payload, job) => refreshAiringNextSweep(env, job.ctx),
});

definePeriodicJob("cron.new-on-streaming", {
  everyMs: LEGACY_CRON_EVERY_MS,
  legacy: true,
  run: (env, payload, job) => runJobSteps([
    ["sweepNewOnStreaming", () => sweepNewOnStreaming(env, job.ctx)],
    ["bumpNewOnStreamingEpisodes", () => bumpNewOnStreamingEpisodes(env, job.ctx)],
  ]),
});

definePeriodicJob("cron.charts", {
  everyMs: LEGACY_CRON_EVERY_MS,
  legacy: true,
  run: (env, payload, job) => prewarmSharedCatalogs(env, job.ctx),
});

definePeriodicJob("cron.better-posters", {
  everyMs: LEGACY_CRON_EVERY_MS,
  legacy: true,
  run: (env, payload, job) => prewarmBetterPosters(env, job.ctx),
});

definePeriodicJob("cron.channel-presets", {
  everyMs: LEGACY_CRON_EVERY_MS,
  legacy: true,
  run: (env, payload, job) => prewarmChannelPresets(env, job.ctx),
});

definePeriodicJob("cron.housekeeping", {
  everyMs: LEGACY_CRON_EVERY_MS,
  legacy: true,
  run: (env) => runJobSteps([
    ["d1SchemaCheck", () => runD1SchemaCheckTask(env)],
    ["pruneTombstones", () => pruneTombstones(env)],
  ]),
});

// For the admin's queue panel (44_): the periodic jobs' last runs, and how
// many one-off jobs of each type are in each state. Null without the table.
async function jobsTableStatus(env) {
  if (!env || !env.DB) return null;
  try {
    const now = Date.now();
    const { results } = await env.DB.prepare(
      `SELECT type, status, attempts, run_after, last_error, progress_json FROM jobs
       WHERE dedupe_key IN (SELECT ? || value FROM json_each(?)) ORDER BY id`
    ).bind(PERIODIC_JOB_KEY_PREFIX, JSON.stringify(rowJobTypes().filter((t) => ROW_JOB_TYPES.get(t).periodic))).all();
    const periodic = (results || []).map((r) => {
      const all = parseJobProgress(r.progress_json);
      const q = all._q || {};
      // Sent to the queue and not picked up yet.
      const inQueue = r.status === "queued" && Number(q.dispatchedAt) > 0 && !(Number(q.claimedAt) >= Number(q.dispatchedAt));
      return {
        type: r.type,
        status: inQueue ? "sent" : r.status,
        failuresInARow: Number(r.attempts) || 0,
        lastError: r.last_error || null,
        runs: Number(q.runs) || 0,
        lastStartedAt: q.lastStartedAt || null,
        lastOkAt: q.lastOkAt || null,
        lastMs: q.lastMs == null ? null : q.lastMs,
        sentAt: inQueue ? q.dispatchedAt : null,
        nextAt: r.status === "queued" && !inQueue ? Math.max(now, Number(r.run_after) || 0) : null,
        // A job's own report of its last full pass, when it keeps one
        // (shelf.shadow, 47_).
        last: all.last && typeof all.last === "object" ? all.last : null,
      };
    });
    const durableTypes = rowJobTypes().filter((t) => !ROW_JOB_TYPES.get(t).periodic);
    const durable = {};
    if (durableTypes.length) {
      const counts = await env.DB.prepare(
        "SELECT type, status, count(*) AS n FROM jobs WHERE type IN (SELECT value FROM json_each(?)) GROUP BY type, status"
      ).bind(JSON.stringify(durableTypes)).all();
      for (const c of counts.results || []) {
        durable[c.type] = durable[c.type] || {};
        durable[c.type][c.status] = Number(c.n) || 0;
      }
    }
    return { periodic, durable };
  } catch (err) {
    if (!/no such table/i.test(jobErrorText(err))) console.error("[Jobs] reading job status failed:", err);
    return null;
  }
}
