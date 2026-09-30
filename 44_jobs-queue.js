
// --- Background jobs: the queue (Phase 5, P5-1) --------------------------------
//
// Work that nobody is waiting on moves off requests and cron ticks onto a
// Cloudflare Queue, `mylists-jobs`, which this same Worker consumes. A message
// is one job: `{ v, type, payload, enqueuedAt }`. The consumer (the `queue`
// export in 26_api-creator-and-admin-routes.js) runs the job type's handler for
// each message, acknowledges it when the handler returns, and asks the queue to
// deliver it again later when the handler throws. After JOBS_MAX_RETRIES failed
// retries the queue moves the message to the dead-letter queue,
// `mylists-jobs-dlq`, where it can be read in the dashboard. Both queues and
// the consumer are set up in the dashboard (docs/OPERATIONS.md section 18).
//
//   Producer: `enqueueJob(env, type, payload, { delaySeconds })`, or
//   `enqueueJobs(env, jobs)` for many at once. Both need the `JOBS` binding
//   (a Queue producer) and say so rather than throw when it is missing, so a
//   caller can fall back to doing the work itself.
//
//   Job types: `defineJobType(type, { run, retryDelaySec })` at module level.
//   `run(env, payload, job)` gets the invocation's env (with the same wrapping
//   the fetch handler applies) and `job = { id, type, attempts, enqueuedAt,
//   ctx }`. It returns normally when done, throws to be retried, or returns
//   `{ retryAfterSeconds }` to be delivered again later without counting as a
//   failure in the logs (a lease held elsewhere, a provider that asked us to
//   wait). A handler must be safe to run twice with the same payload: a queue
//   delivers at least once, and a message can arrive again after it succeeded.
//
//   Messages are processed one after another within a batch. A batch (up to 25
//   messages) is one invocation and shares its limits: 30 s CPU by default, 15
//   minutes of wall time, about 1,000 D1 queries.
//
// `jobs.ping` is the one job type here: the admin's "Send a test job" button
// (Maintenance tab) enqueues it and waits for it to come back, which proves the
// producer binding, the queue and the consumer are all set up.
//
// Its answer is kept in D1 as well as KV, and read from D1 first. KV alone
// could not show it in time: the consumer runs in another data center, and
// the admin page's first read of the not-yet-written key is cached there as
// "missing" for up to a minute -- the page's whole wait. On the live site the
// button said "not picked up within a minute" with the queue set up right.
//
// Metrics: one Analytics Engine point per job type per batch, index `job`:
// blobs ["job", type, queue], doubles [messages, done, retried, dropped,
// milliseconds spent].
//
// Module level, after the Worker's exports, like 27_ onward.

const JOBS_QUEUE_NAME = "mylists-jobs";
const JOBS_DLQ_NAME = "mylists-jobs-dlq";
const JOB_MESSAGE_VERSION = 1;
// What the consumer is configured with in the dashboard (batch size 25, 5
// retries). The code does not enforce them; they are here so the tests and the
// admin panel say the same thing as docs/OPERATIONS.md.
const JOBS_BATCH_SIZE = 25;
const JOBS_MAX_RETRIES = 5;
// Retry delays: 30 s, 1 min, 2 min, 4 min, 8 min... capped at an hour.
const JOB_RETRY_BASE_SEC = 30;
const JOB_RETRY_MAX_SEC = 60 * 60;
// A message of a type this Worker does not know (sent by a newer deployment
// that was rolled back) is kept, not dropped: it is retried slowly, so a
// redeploy picks it up, and reaches the dead-letter queue otherwise.
const JOB_UNKNOWN_TYPE_RETRY_SEC = 10 * 60;
// Queues refuses a message over 128 KB and a sendBatch over 256 KB or 100
// messages. Payloads are ids and small settings, so these are far away; the
// checks turn a mistake into a clear error instead of a failed send.
const JOB_MESSAGE_MAX_BYTES = 120 * 1024;
const JOB_SEND_BATCH_MAX_MESSAGES = 100;
const JOB_SEND_BATCH_MAX_BYTES = 240 * 1024;
const JOB_PING_KV_PREFIX = "jobs:ping:";
const JOB_PING_TTL_SEC = 60 * 60;
// The answer's row in the jobs table (migration 0016): type jobs.ping, which
// no dispatcher query names, so nothing ever runs or counts it.
const JOB_PING_ROW_PREFIX = "ping:";

const JOB_HANDLERS = new Map(); // type -> { type, run, retryDelaySec }

function defineJobType(type, spec) {
  if (typeof type !== "string" || !/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(type)) {
    throw new Error(`Job type "${type}" must be dotted lowercase words, like "show.refresh".`);
  }
  if (!spec || typeof spec.run !== "function") throw new Error(`Job type "${type}" needs a run function.`);
  if (JOB_HANDLERS.has(type)) throw new Error(`Job type "${type}" is defined twice.`);
  JOB_HANDLERS.set(type, { type, run: spec.run, retryDelaySec: spec.retryDelaySec || null });
}

function jobsQueueBound(env) {
  return !!(env && env.JOBS && typeof env.JOBS.send === "function");
}

function jobMessage(type, payload, now = Date.now()) {
  return { v: JOB_MESSAGE_VERSION, type, payload: payload == null ? {} : payload, enqueuedAt: now };
}

// Checks one job before it is sent. Returns the message and its size, or the
// reason it cannot go.
function prepareJobMessage(type, payload, now) {
  if (!JOB_HANDLERS.has(type)) return { error: "unknownType" };
  const body = jobMessage(type, payload, now);
  let bytes;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(body)).length;
  } catch {
    return { error: "unserializable" };
  }
  if (bytes > JOB_MESSAGE_MAX_BYTES) return { error: "tooLarge" };
  return { body, bytes };
}

function jobDelaySeconds(delaySeconds) {
  const n = Math.floor(Number(delaySeconds) || 0);
  return n > 0 ? Math.min(n, JOB_RETRY_MAX_SEC * 12) : 0;
}

// Sends one job. Resolves to { ok: true } or { ok: false, reason } with reason
// "unbound" (no JOBS binding), "unknownType", "tooLarge", "unserializable" or
// "sendFailed". Never throws.
async function enqueueJob(env, type, payload = {}, opts = {}) {
  if (!jobsQueueBound(env)) return { ok: false, reason: "unbound" };
  const prepared = prepareJobMessage(type, payload, Date.now());
  if (prepared.error) {
    console.error(`[Jobs] not sending ${type}: ${prepared.error}`);
    return { ok: false, reason: prepared.error };
  }
  const delaySeconds = jobDelaySeconds(opts.delaySeconds);
  try {
    await env.JOBS.send(prepared.body, delaySeconds ? { contentType: "json", delaySeconds } : { contentType: "json" });
    return { ok: true };
  } catch (err) {
    console.error(`[Jobs] sending ${type} failed:`, err);
    return { ok: false, reason: "sendFailed" };
  }
}

// Sends many jobs, `[{ type, payload, delaySeconds }]`, in as few sendBatch
// calls as the limits allow. Resolves to { ok, sent, failed, reason }: `ok` is
// true only when every job went. Never throws.
async function enqueueJobs(env, jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  if (!list.length) return { ok: true, sent: 0, failed: 0 };
  if (!jobsQueueBound(env)) return { ok: false, sent: 0, failed: list.length, reason: "unbound" };
  const now = Date.now();
  const chunks = [];
  let chunk = [];
  let chunkBytes = 0;
  let failed = 0;
  let reason = null;
  for (const job of list) {
    const prepared = prepareJobMessage(job && job.type, job && job.payload, now);
    if (prepared.error) {
      console.error(`[Jobs] not sending ${job && job.type}: ${prepared.error}`);
      failed++;
      reason = reason || prepared.error;
      continue;
    }
    if (chunk.length && (chunk.length >= JOB_SEND_BATCH_MAX_MESSAGES || chunkBytes + prepared.bytes > JOB_SEND_BATCH_MAX_BYTES)) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
    const delaySeconds = jobDelaySeconds(job.delaySeconds);
    chunk.push(delaySeconds ? { body: prepared.body, contentType: "json", delaySeconds } : { body: prepared.body, contentType: "json" });
    chunkBytes += prepared.bytes;
  }
  if (chunk.length) chunks.push(chunk);
  let sent = 0;
  for (const messages of chunks) {
    try {
      if (typeof env.JOBS.sendBatch === "function") {
        await env.JOBS.sendBatch(messages);
      } else {
        for (const m of messages) await env.JOBS.send(m.body, m.delaySeconds ? { contentType: "json", delaySeconds: m.delaySeconds } : { contentType: "json" });
      }
      sent += messages.length;
    } catch (err) {
      console.error("[Jobs] sendBatch failed:", err);
      failed += messages.length;
      reason = reason || "sendFailed";
    }
  }
  return { ok: failed === 0, sent, failed, reason };
}

// How long before a failed job is delivered again. `attempts` is the queue's
// count of deliveries so far, 1 on the first.
function jobRetryDelaySec(attempts, spec) {
  const base = (spec && spec.retryDelaySec) || JOB_RETRY_BASE_SEC;
  const n = Math.max(1, Math.floor(Number(attempts) || 1));
  return Math.min(JOB_RETRY_MAX_SEC, base * Math.pow(2, Math.min(n - 1, 16)));
}

function jobRetry(msg, delaySeconds) {
  try {
    msg.retry({ delaySeconds: Math.max(0, Math.min(JOB_RETRY_MAX_SEC * 12, Math.floor(delaySeconds) || 0)) });
  } catch {
    // Already acknowledged or retried: the first call wins.
  }
}

function jobAck(msg) {
  try {
    msg.ack();
  } catch {
    // Already acknowledged or retried: the first call wins.
  }
}

// Runs one batch. Every message is acknowledged or retried explicitly, so one
// job failing never makes the others run again. Never throws.
async function handleJobsBatch(batch, env, ctx) {
  const messages = batch && Array.isArray(batch.messages) ? batch.messages : [];
  const queue = (batch && batch.queue) || JOBS_QUEUE_NAME;
  const stats = new Map(); // type -> { n, done, retried, dropped, ms }
  const stat = (type) => {
    let s = stats.get(type);
    if (!s) {
      s = { n: 0, done: 0, retried: 0, dropped: 0, ms: 0 };
      stats.set(type, s);
    }
    return s;
  };
  for (const msg of messages) {
    const body = msg && msg.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.type !== "string" || !body.type) {
      // Nothing can ever run this: acknowledged, so it does not sit in the
      // dead-letter queue as if it were a job that failed.
      console.error(`[Jobs] dropping a message that is not a job (${msg && msg.id}).`);
      const s = stat("invalid");
      s.n++;
      s.dropped++;
      jobAck(msg);
      continue;
    }
    const s = stat(body.type);
    s.n++;
    const spec = JOB_HANDLERS.get(body.type);
    if (!spec) {
      console.warn(`[Jobs] no handler for job type "${body.type}" in this deployment; trying again later.`);
      s.retried++;
      jobRetry(msg, JOB_UNKNOWN_TYPE_RETRY_SEC);
      continue;
    }
    const startedAt = Date.now();
    const attempts = Math.max(1, Math.floor(Number(msg.attempts) || 1));
    try {
      const out = await spec.run(env, body.payload && typeof body.payload === "object" ? body.payload : {}, {
        id: msg.id,
        type: body.type,
        attempts,
        enqueuedAt: Number(body.enqueuedAt) || null,
        queue,
        ctx,
      });
      if (out && Number(out.retryAfterSeconds) > 0) {
        s.retried++;
        jobRetry(msg, Number(out.retryAfterSeconds));
      } else {
        s.done++;
        jobAck(msg);
      }
    } catch (err) {
      const delay = jobRetryDelaySec(attempts, spec);
      console.error(`[Jobs] ${body.type} failed (delivery ${attempts} of ${JOBS_MAX_RETRIES + 1}); ${attempts > JOBS_MAX_RETRIES ? "moving to the dead-letter queue" : `trying again in ${delay} s`}:`, err);
      s.retried++;
      jobRetry(msg, delay);
    }
    s.ms += Date.now() - startedAt;
  }
  const analytics = env && env.ANALYTICS && typeof env.ANALYTICS.writeDataPoint === "function" ? env.ANALYTICS : null;
  if (analytics) {
    for (const [type, s] of stats) {
      try {
        analytics.writeDataPoint({
          blobs: ["job", type, queue],
          doubles: [s.n, s.done, s.retried, s.dropped, s.ms],
          indexes: ["job"],
        });
      } catch {
        // Metrics must never affect a job.
      }
    }
  }
  return Object.fromEntries(stats);
}

// The consumer: called by the `queue` export (26_) with the invocation's own
// env. It gets the same setup as a request or a cron tick.
async function runJobsQueue(batch, env, ctx) {
  try {
    applyEnvApiKeys(env);
    configureProviderBreaker(env);
    // FF_EVENT_TRACKING, as in the fetch and scheduled handlers.
    const runEnv = eventTrackingEnv(env);
    return await handleJobsBatch(batch, runEnv, ctx);
  } catch (err) {
    // Only the setup above can get here (handleJobsBatch does not throw). A
    // message already acknowledged or retried keeps that answer; the rest run
    // again.
    console.error("[Jobs] queue() failed before its jobs ran:", err);
    try {
      if (batch && typeof batch.retryAll === "function") batch.retryAll({ delaySeconds: JOB_RETRY_BASE_SEC });
    } catch {
      // Nothing more to do; the queue retries un-answered messages anyway.
    }
    return null;
  } finally {
    try {
      const flush = providerBreakerFlush(env).catch(() => {});
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(flush);
    } catch {
      // Never affects the batch.
    }
  }
}

// --- jobs.ping: the round trip the admin's "Send a test job" button makes ------

defineJobType("jobs.ping", {
  async run(env, payload, job) {
    const nonce = typeof payload.nonce === "string" ? payload.nonce : "";
    if (!/^[A-Za-z0-9-]{8,64}$/.test(nonce) || !env || !env.CONFIGS) return;
    const key = JOB_PING_KV_PREFIX + nonce;
    // Delivered twice: the first answer stands.
    if (await env.CONFIGS.get(key)) return;
    const answer = JSON.stringify({
      receivedAt: Date.now(),
      sentAt: Number(payload.sentAt) || job.enqueuedAt || null,
      attempts: job.attempts,
      queue: job.queue,
    });
    await env.CONFIGS.put(key, answer, { expirationTtl: JOB_PING_TTL_SEC });
    // The copy the admin page reads first (see the header). Best effort: KV
    // above already holds the answer.
    if (env.DB) {
      try {
        const now = Date.now();
        await env.DB.prepare(
          "INSERT OR IGNORE INTO jobs (type, dedupe_key, status, attempts, run_after, progress_json, created_at, updated_at) VALUES ('jobs.ping', ?, 'done', ?, 0, ?, ?, ?)"
        ).bind(JOB_PING_ROW_PREFIX + nonce, Number(job.attempts) || 1, answer, now, now).run();
      } catch {
        // No jobs table (migration 0016): the KV answer is the only one.
      }
    }
  },
});

// The answer to a test job: from D1, else KV. Null while there is none.
async function readJobPingAnswer(env, nonce) {
  if (env && env.DB) {
    try {
      const row = await env.DB.prepare("SELECT progress_json FROM jobs WHERE dedupe_key = ?").bind(JOB_PING_ROW_PREFIX + nonce).first();
      if (row && row.progress_json) return row.progress_json;
    } catch {
      // No jobs table: KV below.
    }
  }
  return env && env.CONFIGS ? await env.CONFIGS.get(JOB_PING_KV_PREFIX + nonce) : null;
}

function newJobPingNonce() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// /admin/api/jobs/* -- the Maintenance tab's queue panel.
//   GET  /admin/api/jobs/status          is JOBS bound; the job types known
//   POST /admin/api/jobs/ping            send a test job -> { nonce }
//   GET  /admin/api/jobs/ping?nonce=...  has it come back yet
async function handleJobsAdminApi(request, env, url, path) {
  if (!path.startsWith("/admin/api/jobs/")) return null;
  if (!(await isAdminRequest(request, env))) return json({ ok: false, error: "Not authorized." }, 401);
  try {
    if (path === "/admin/api/jobs/status" && request.method === "GET") {
      return json({
        ok: true,
        bound: jobsQueueBound(env),
        queue: JOBS_QUEUE_NAME,
        deadLetterQueue: JOBS_DLQ_NAME,
        batchSize: JOBS_BATCH_SIZE,
        maxRetries: JOBS_MAX_RETRIES,
        types: [...JOB_HANDLERS.keys()].sort(),
        // The jobs table's view (45_jobs-dispatcher.js): periodic jobs' last
        // runs, and one-off jobs by state. Null without migration 0016.
        jobs: typeof jobsTableStatus === "function" ? await jobsTableStatus(env) : null,
      });
    }
    if (path === "/admin/api/jobs/ping" && request.method === "POST") {
      if (!jobsQueueBound(env)) {
        return json({ ok: false, error: `No queue bound as JOBS. Create the ${JOBS_QUEUE_NAME} queue and bind it (docs/OPERATIONS.md section 18).` }, 503);
      }
      if (!env.CONFIGS) return json({ ok: false, error: "No CONFIGS KV binding." }, 503);
      const nonce = newJobPingNonce();
      // Earlier test jobs' answers, a day on: nothing reads them any more.
      if (env.DB) {
        try {
          await env.DB.prepare("DELETE FROM jobs WHERE type = 'jobs.ping' AND created_at < ?").bind(Date.now() - 86400000).run();
        } catch {}
      }
      const sent = await enqueueJob(env, "jobs.ping", { nonce, sentAt: Date.now() });
      if (!sent.ok) return json({ ok: false, error: `Could not send to the queue (${sent.reason}). See the Worker's logs.` }, 502);
      return json({ ok: true, nonce });
    }
    if (path === "/admin/api/jobs/ping" && request.method === "GET") {
      const nonce = url.searchParams.get("nonce") || "";
      if (!/^[A-Za-z0-9-]{8,64}$/.test(nonce)) return json({ ok: false, error: "Missing or malformed nonce." }, 400);
      const raw = await readJobPingAnswer(env, nonce);
      if (!raw) return json({ ok: true, received: false });
      let rec = {};
      try {
        rec = JSON.parse(raw) || {};
      } catch {
        rec = {};
      }
      return json({
        ok: true,
        received: true,
        attempts: rec.attempts || 1,
        roundTripMs: rec.sentAt && rec.receivedAt ? Math.max(0, rec.receivedAt - rec.sentAt) : null,
      });
    }
    return json({ ok: false, error: "Not found." }, 404);
  } catch (e) {
    return json({ ok: false, error: safeErrorMessage(e) }, 500);
  }
}
