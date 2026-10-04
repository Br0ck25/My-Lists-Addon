// Phase 5: background jobs. P5-1 is the queue itself: the producer
// (enqueueJob / enqueueJobs), the consumer (the Worker's `queue` export) and
// the admin's test-job round trip. The queue is modelled by makeQueue and
// drainQueue in harness.mjs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { worker, freshIsolate, makeEnv, makeD1, makeQueue, drainQueue, call, runScheduledTick } from "./harness.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadSourceFunctions(...relFiles) {
  const sandbox = {
    console, URL, URLSearchParams, atob, btoa, Uint8Array, TextDecoder, TextEncoder,
    Response, Headers, Request,
    crypto: globalThis.crypto,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const relFile of relFiles) {
    const src = fs.readFileSync(path.join(REPO_ROOT, relFile), "utf8");
    vm.runInContext(src, sandbox, { filename: relFile });
  }
  return sandbox;
}

async function adminCookie(env) {
  const r = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
  const m = (r.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/);
  return m ? m[1] : "";
}

function jobsEnv(extra = {}) {
  return makeEnv({ DB: makeD1(), JOBS: makeQueue(), ...extra });
}

async function sendPing(env, cookie) {
  const r = await call(env, "/admin/api/jobs/ping", { method: "POST", json: {}, cookie });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  return r.body.nonce;
}

async function pingAnswer(env, cookie, nonce) {
  const r = await call(env, `/admin/api/jobs/ping?nonce=${encodeURIComponent(nonce)}`, { cookie });
  assert.equal(r.status, 200);
  return r.body;
}

// A hand-made batch, for messages the producer would never send.
async function deliver(bodies, env, { attempts = 1 } = {}) {
  const outcome = [];
  const messages = bodies.map((body, i) => ({
    id: `hand-${i}`,
    timestamp: new Date(),
    body,
    attempts,
    ack() { outcome[i] = outcome[i] || { what: "ack" }; },
    retry(opts = {}) { outcome[i] = outcome[i] || { what: "retry", delaySeconds: opts.delaySeconds }; },
  }));
  await worker.queue({ queue: "mylists-jobs", messages, ackAll() {}, retryAll() {} }, env, { waitUntil() {} });
  return outcome;
}

describe("P5-1: the job queue", () => {
  it("the Worker exports a queue consumer", () => {
    assert.equal(typeof worker.queue, "function");
  });

  it("a test job round-trips: the admin sends it, the consumer picks it up, the admin sees it back", async () => {
    const env = jobsEnv();
    const cookie = await adminCookie(env);

    const status = await call(env, "/admin/api/jobs/status", { cookie });
    assert.equal(status.body.ok, true);
    assert.equal(status.body.bound, true);
    assert.equal(status.body.queue, "mylists-jobs");
    assert.equal(status.body.deadLetterQueue, "mylists-jobs-dlq");
    assert.equal(status.body.batchSize, 25);
    assert.equal(status.body.maxRetries, 5);
    assert.ok(status.body.types.includes("jobs.ping"));

    const nonce = await sendPing(env, cookie);
    assert.equal(env.JOBS._pending.length, 1);
    const body = env.JOBS._pending[0].body;
    assert.equal(body.v, 1);
    assert.equal(body.type, "jobs.ping");
    assert.equal(body.payload.nonce, nonce);
    assert.equal(typeof body.enqueuedAt, "number");

    assert.deepEqual(await pingAnswer(env, cookie, nonce), { ok: true, received: false });
    const log = await drainQueue(env);
    assert.deepEqual(log.deliveries.map((d) => [d.type, d.outcome]), [["jobs.ping", "ack"]]);
    const answer = await pingAnswer(env, cookie, nonce);
    assert.equal(answer.received, true);
    assert.equal(answer.attempts, 1);
    assert.equal(typeof answer.roundTripMs, "number");
    assert.ok(answer.roundTripMs >= 0);
  });

  it("the admin sees the answer at once, even where KV has not caught up", async () => {
    // On the live site the consumer runs in another data center, and the
    // admin page's first read of the missing KV key is cached there as missing
    // for up to a minute: KV alone made a working queue look broken. The
    // answer is in D1 too, and read from there first.
    const env = jobsEnv();
    const cookie = await adminCookie(env);
    const nonce = await sendPing(env, cookie);
    await drainQueue(env);
    env.CONFIGS._store.delete("jobs:ping:" + nonce); // what that data center still sees
    const answer = await pingAnswer(env, cookie, nonce);
    assert.equal(answer.received, true);
    assert.equal(answer.attempts, 1);
    const row = env.DB._db.prepare("SELECT type, status FROM jobs WHERE dedupe_key = ?").get("ping:" + nonce);
    assert.deepEqual({ ...row }, { type: "jobs.ping", status: "done" });
  });

  it("a test job's answer row is cleared a day on, and nothing else in the jobs table is", async () => {
    const env = jobsEnv();
    const cookie = await adminCookie(env);
    const old = await sendPing(env, cookie);
    await drainQueue(env);
    const twoDaysAgo = Date.now() - 2 * 86400000;
    env.DB._db.prepare("UPDATE jobs SET created_at = ? WHERE dedupe_key = ?").run(twoDaysAgo, "ping:" + old);
    env.DB._db.prepare(
      "INSERT INTO jobs (type, dedupe_key, status, run_after, created_at, updated_at) VALUES ('migrate.lists', 'migrate.lists:acct:1', 'done', 0, ?, ?)"
    ).run(twoDaysAgo, twoDaysAgo);
    await sendPing(env, cookie);
    assert.equal(env.DB._db.prepare("SELECT count(*) AS n FROM jobs WHERE dedupe_key = ?").get("ping:" + old).n, 0);
    assert.equal(env.DB._db.prepare("SELECT count(*) AS n FROM jobs WHERE dedupe_key = 'migrate.lists:acct:1'").get().n, 1, "an old row of another type stays");
  });

  it("the admin's queue routes need the admin", async () => {
    const env = jobsEnv();
    assert.equal((await call(env, "/admin/api/jobs/status")).status, 401);
    assert.equal((await call(env, "/admin/api/jobs/ping", { method: "POST", json: {} })).status, 401);
    assert.equal((await call(env, "/admin/api/jobs/ping?nonce=abcdefgh1234")).status, 401);
    assert.equal(env.JOBS._pending.length, 0);
  });

  it("without the JOBS binding nothing is sent, and the admin says why", async () => {
    const env = makeEnv({ DB: makeD1() });
    const cookie = await adminCookie(env);
    const status = await call(env, "/admin/api/jobs/status", { cookie });
    assert.equal(status.body.bound, false);
    const ping = await call(env, "/admin/api/jobs/ping", { method: "POST", json: {}, cookie });
    assert.equal(ping.status, 503);
    assert.match(ping.body.error, /JOBS/);
    const page = await call(env, "/admin", { cookie });
    assert.match(page.text, /JOBS is not bound\./);
    assert.match(page.text, /id="jobsPingBtn" data-act="runJobsPing" disabled/);
  });

  it("the admin page offers the test job once JOBS is bound", async () => {
    const env = jobsEnv();
    const page = await call(env, "/admin", { cookie: await adminCookie(env) });
    assert.match(page.text, /Background jobs queue: <span style="color:#30d158;">bound<\/span>/);
    assert.match(page.text, /id="jobsPingBtn" data-act="runJobsPing" >/);
  });

  it("a job that fails is delivered again with a growing delay, then reaches the dead-letter queue", async () => {
    const env = jobsEnv();
    const cookie = await adminCookie(env);
    const nonce = await sendPing(env, cookie);
    env.CONFIGS._hooks.beforePut = async (key) => {
      if (key.startsWith("jobs:ping:")) throw new Error("KV write failed");
    };
    const log = await drainQueue(env);
    env.CONFIGS._hooks.beforePut = null;
    // One delivery plus five retries, as the consumer is configured.
    assert.deepEqual(log.deliveries.map((d) => d.attempts), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(log.retries.map((r) => r.delaySeconds), [30, 60, 120, 240, 480, 960]);
    assert.equal(env.JOBS._dlq.length, 1);
    assert.equal(env.JOBS._dlq[0].body.payload.nonce, nonce);
    assert.equal(env.JOBS._pending.length, 0);
    assert.equal((await pingAnswer(env, cookie, nonce)).received, false);
  });

  it("a job that fails once succeeds on its next delivery", async () => {
    const env = jobsEnv();
    const cookie = await adminCookie(env);
    const nonce = await sendPing(env, cookie);
    let failures = 1;
    env.CONFIGS._hooks.beforePut = async (key) => {
      if (key.startsWith("jobs:ping:") && failures-- > 0) throw new Error("KV write failed");
    };
    const log = await drainQueue(env);
    assert.deepEqual(log.deliveries.map((d) => d.outcome), ["retry", "ack"]);
    const answer = await pingAnswer(env, cookie, nonce);
    assert.equal(answer.received, true);
    assert.equal(answer.attempts, 2);
    assert.equal(env.JOBS._dlq.length, 0);
  });

  it("one failing job does not make the rest of its batch run again", async () => {
    const env = jobsEnv();
    const cookie = await adminCookie(env);
    const nonces = [await sendPing(env, cookie), await sendPing(env, cookie), await sendPing(env, cookie)];
    const puts = new Map();
    let failFirst = true;
    env.CONFIGS._hooks.beforePut = async (key) => {
      if (!key.startsWith("jobs:ping:")) return;
      if (key.endsWith(nonces[0]) && failFirst) {
        failFirst = false;
        throw new Error("KV write failed");
      }
      puts.set(key, (puts.get(key) || 0) + 1);
    };
    const log = await drainQueue(env);
    assert.equal(log.batches, 2);
    assert.deepEqual(log.deliveries.map((d) => d.outcome), ["retry", "ack", "ack", "ack"]);
    for (const n of nonces) assert.equal(puts.get(`jobs:ping:${n}`), 1, n);
  });

  it("a job delivered twice is done once", async () => {
    const env = jobsEnv();
    const cookie = await adminCookie(env);
    const nonce = await sendPing(env, cookie);
    // At-least-once delivery: the same message arrives again.
    env.JOBS._pending.push({ ...env.JOBS._pending[0], id: "again", attempts: 1 });
    let puts = 0;
    env.CONFIGS._hooks.beforePut = async (key) => {
      if (key.startsWith("jobs:ping:")) puts++;
    };
    const log = await drainQueue(env);
    assert.deepEqual(log.deliveries.map((d) => d.outcome), ["ack", "ack"]);
    assert.equal(puts, 1);
    assert.equal((await pingAnswer(env, cookie, nonce)).received, true);
  });

  it("a job of a type this deployment does not know is kept, not dropped", async () => {
    const env = jobsEnv();
    const [out] = await deliver([{ v: 1, type: "future.job", payload: {} }], env);
    assert.deepEqual(out, { what: "retry", delaySeconds: 600 });

    // Through the queue it ends in the dead-letter queue, where it can be read.
    env.JOBS._pending.push({ id: "unknown", body: { v: 1, type: "future.job", payload: {} }, attempts: 1, delaySeconds: 0, timestamp: new Date() });
    await drainQueue(env);
    assert.equal(env.JOBS._dlq.length, 1);
    assert.equal(env.JOBS._dlq[0].body.type, "future.job");
  });

  it("a message that is not a job is acknowledged and dropped", async () => {
    const env = jobsEnv();
    const out = await deliver(["hello", null, [], {}, { type: "" }, { type: 7 }], env);
    assert.deepEqual(out.map((o) => o.what), ["ack", "ack", "ack", "ack", "ack", "ack"]);
  });

  it("writes one metrics point per job type per batch", async () => {
    const points = [];
    const env = jobsEnv({ ANALYTICS: { writeDataPoint: (p) => points.push(p) } });
    const cookie = await adminCookie(env);
    await sendPing(env, cookie);
    await sendPing(env, cookie);
    env.JOBS._pending.push({ id: "odd", body: "not a job", attempts: 1, delaySeconds: 0, timestamp: new Date() });
    points.length = 0;
    await drainQueue(env);
    const jobPoints = points.filter((p) => p.indexes && p.indexes[0] === "job");
    assert.deepEqual(jobPoints.map((p) => p.blobs), [["job", "jobs.ping", "mylists-jobs"], ["job", "invalid", "mylists-jobs"]]);
    assert.deepEqual(jobPoints[0].doubles.slice(0, 4), [2, 2, 0, 0]);
    assert.deepEqual(jobPoints[1].doubles.slice(0, 4), [1, 0, 0, 1]);
  });

  it("a send that fails is reported, not thrown", async () => {
    const env = jobsEnv();
    const cookie = await adminCookie(env);
    env.JOBS._hooks.beforeSend = async () => { throw new Error("queue unavailable"); };
    const r = await call(env, "/admin/api/jobs/ping", { method: "POST", json: {}, cookie });
    assert.equal(r.status, 502);
    assert.match(r.body.error, /sendFailed/);
  });

  describe("enqueueJob and enqueueJobs", () => {
    const sb = loadSourceFunctions("44_jobs-queue.js");
    const run = (src) => vm.runInContext(src, sb);
    // Objects made in the sandbox have its prototypes; compare them as data.
    const plain = (o) => JSON.parse(JSON.stringify(o));
    const enqueueJob = async (...a) => plain(await run("enqueueJob")(...a));
    const enqueueJobs = async (...a) => plain(await run("enqueueJobs")(...a));

    it("refuses what the queue would refuse, without throwing", async () => {
      const env = { JOBS: makeQueue() };
      assert.deepEqual(await enqueueJob({}, "jobs.ping", {}), { ok: false, reason: "unbound" });
      assert.deepEqual(await enqueueJob(env, "no.such-type", {}), { ok: false, reason: "unknownType" });
      assert.deepEqual(await enqueueJob(env, "jobs.ping", { big: "x".repeat(130 * 1024) }), { ok: false, reason: "tooLarge" });
      const loop = {};
      loop.self = loop;
      assert.deepEqual(await enqueueJob(env, "jobs.ping", loop), { ok: false, reason: "unserializable" });
      assert.equal(env.JOBS._pending.length, 0);
      assert.deepEqual(await enqueueJob(env, "jobs.ping", { nonce: "abc" }, { delaySeconds: 90 }), { ok: true });
      assert.equal(env.JOBS._pending[0].delaySeconds, 90);
    });

    it("sends many jobs in batches of at most 100 messages", async () => {
      const env = { JOBS: makeQueue() };
      let batches = 0;
      const sendBatch = env.JOBS.sendBatch.bind(env.JOBS);
      env.JOBS.sendBatch = async (messages) => {
        batches++;
        assert.ok(messages.length <= 100);
        return sendBatch(messages);
      };
      const jobs = Array.from({ length: 250 }, (_, i) => ({ type: "jobs.ping", payload: { nonce: `n${i}` } }));
      jobs.push({ type: "no.such-type", payload: {} });
      const out = await enqueueJobs(env, jobs);
      assert.deepEqual(out, { ok: false, sent: 250, failed: 1, reason: "unknownType" });
      assert.equal(batches, 3);
      assert.equal(env.JOBS._pending.length, 250);
      assert.deepEqual(await enqueueJobs(env, []), { ok: true, sent: 0, failed: 0 });
      assert.deepEqual(await enqueueJobs({}, jobs.slice(0, 2)), { ok: false, sent: 0, failed: 2, reason: "unbound" });
    });

    it("keeps each sendBatch under 256 KB", async () => {
      const env = { JOBS: makeQueue() };
      const jobs = Array.from({ length: 5 }, (_, i) => ({ type: "jobs.ping", payload: { nonce: `n${i}`, pad: "x".repeat(100 * 1024) } }));
      const out = await enqueueJobs(env, jobs);
      assert.equal(out.ok, true);
      assert.equal(out.sent, 5);
    });

    it("a job type must be named like the others, and defined once", () => {
      const defineJobType = run("defineJobType");
      assert.throws(() => defineJobType("Ping", { run() {} }), /dotted lowercase/);
      assert.throws(() => defineJobType("nodot", { run() {} }), /dotted lowercase/);
      assert.throws(() => defineJobType("jobs.norun", {}), /run function/);
      assert.throws(() => defineJobType("jobs.ping", { run() {} }), /defined twice/);
    });
  });
});

// Keep the harness honest: the queue model enforces Queues' own limits.
describe("makeQueue", () => {
  it("refuses a message over 128 KB and a sendBatch over 100 messages", async () => {
    const q = makeQueue();
    await assert.rejects(q.send({ big: "x".repeat(129 * 1024) }), /too large/);
    await assert.rejects(q.sendBatch(Array.from({ length: 101 }, () => ({ body: {} }))), /at most 100/);
  });

  it("is not bound unless a test binds it", () => {
    assert.equal(makeEnv().JOBS, undefined);
  });
});

// --- P5-2: the dispatcher (45_jobs-dispatcher.js) ------------------------------

// Every periodic job, in the order they are defined (and first sent), with
// its period: the cron's own work every tick, then the show schedule (P5-3).
const PERIODIC_EVERY = {
  "cron.episodes": 4 * 60000, "cron.airing-next": 4 * 60000, "nos.sweep": 4 * 60000, "cron.charts": 4 * 60000,
  "cron.better-posters": 4 * 60000, "cron.housekeeping": 4 * 60000,
  "show.watchers": 24 * 3600000, "show.refresh": 3600000,
  "shelf.shadow": 3600000, "chart.refresh": 3600000, "token.refresh": 24 * 3600000,
  "channel.presets": 24 * 3600000, "recs.build": 3600000, "rollup.daily": 24 * 3600000,
  "media.retry": 3600000, "activity.copy-new": 3600000,
};
const CRON_JOBS = Object.keys(PERIODIC_EVERY);

// Every outbound call fails at once and is counted: nothing here is testing a
// provider, and a tick that only dispatches must make none.
function blockNetwork() {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url && url.url ? url.url : url));
    throw new Error("network disabled in test");
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

// Counts the statements a D1 binding runs (batches count each statement).
function countD1(db) {
  const counter = { n: 0 };
  const prepare = db.prepare.bind(db);
  const batch = db.batch.bind(db);
  db.prepare = (sql) => {
    const wrap = (st) => ({
      ...st,
      run: (...a) => { counter.n++; return st.run(...a); },
      all: (...a) => { counter.n++; return st.all(...a); },
      first: (...a) => { counter.n++; return st.first(...a); },
      bind: (...a) => wrap(st.bind(...a)),
    });
    return wrap(prepare(sql));
  };
  db.batch = (stmts) => { counter.n += stmts.length; return batch(stmts); };
  return counter;
}

function jobRow(env, type) {
  const row = env.DB._db.prepare("SELECT * FROM jobs WHERE dedupe_key = ?").get(`periodic:${type}`);
  if (!row) return null;
  return { ...row, q: JSON.parse(row.progress_json || "{}")._q || {} };
}

// The periodic jobs sent. Some periodic jobs send work of their own (one
// channel.pool.build per network, P5-10), which these tests leave aside.
const sentTypes = (env) => env.JOBS._pending.map((m) => m.body.type).filter((t) => t in PERIODIC_EVERY);

describe("P5-2: the cron tick only dispatches", () => {
  it("with the queue bound, a tick sends one job per piece of work and does none of it", async () => {
    const net = blockNetwork();
    try {
      const env = jobsEnv({ TMDB_API_KEY: "k" });
      const d1 = countD1(env.DB);
      let kvWrites = 0;
      env.CONFIGS._hooks.beforePut = async () => { kvWrites++; };
      const startedAt = performance.now();
      await runScheduledTick(env, { cron: "*/5 * * * *" });
      const tookMs = performance.now() - startedAt;

      assert.deepEqual(sentTypes(env), CRON_JOBS);
      for (const m of env.JOBS._pending) {
        assert.equal(typeof m.body.payload.jobId, "number");
        assert.equal(typeof m.body.payload.token, "number");
      }
      assert.deepEqual(net.calls, [], "a dispatching tick calls no provider");
      assert.equal(kvWrites, 0, "and writes nothing to KV");
      // Make sure the rows exist, read the due ones, mark each one sent.
      assert.ok(d1.n <= 2 + CRON_JOBS.length, `${d1.n} D1 statements`);
      assert.ok(tookMs < 1000, `the tick took ${tookMs} ms`);
      for (const type of CRON_JOBS) {
        const row = jobRow(env, type);
        assert.equal(row.status, "queued");
        assert.ok(row.q.dispatchedAt > 0);
        assert.equal(row.run_after, env.JOBS._pending.find((m) => m.body.type === type).body.payload.token);
      }
    } finally {
      net.restore();
    }
  });

  it("the queue then does the work, and each job waits for its next turn", async () => {
    const net = blockNetwork();
    try {
      const env = jobsEnv();
      await runScheduledTick(env);
      const beforeDrain = Date.now();
      const log = await drainQueue(env);
      assert.deepEqual(log.deliveries.filter((d) => d.type in PERIODIC_EVERY).map((d) => d.outcome), CRON_JOBS.map(() => "ack"));
      for (const type of CRON_JOBS) {
        const row = jobRow(env, type);
        assert.equal(row.status, "queued", type);
        assert.equal(row.attempts, 0, `${type}: ${row.last_error}`);
        assert.equal(row.q.runs, 1);
        assert.ok(row.q.lastOkAt >= beforeDrain);
        // Due again after its period, less 90 s of slack (the cron's work:
        // at the next tick).
        const wait = row.run_after - row.q.lastStartedAt;
        const expected = PERIODIC_EVERY[type] - 90000;
        assert.ok(wait >= expected && wait <= expected + 1000, `${type} next due in ${wait} ms`);
      }
      // Straight away, nothing is due.
      await runScheduledTick(env);
      assert.deepEqual(sentTypes(env), []);
      // Once due, each is sent again.
      env.DB._db.exec("UPDATE jobs SET run_after = 1 WHERE dedupe_key LIKE 'periodic:%'");
      await runScheduledTick(env);
      assert.deepEqual(sentTypes(env), CRON_JOBS);
    } finally {
      net.restore();
    }
  });

  it("a tick through the queue does what a tick without it does", async () => {
    const net = blockNetwork();
    try {
      const run = async (withQueue) => {
        const w = await freshIsolate();
        const env = makeEnv({ DB: makeD1(), TMDB_API_KEY: "k", ...(withQueue ? { JOBS: makeQueue() } : {}) });
        const written = new Set();
        env.CONFIGS._hooks.beforePut = async (key) => { written.add(key); };
        await runScheduledTick(env, {}, w);
        if (withQueue) await drainQueue(env, { w });
        // The channel presets' rotation cursor is the one key that differs on
        // purpose: with the queue, channel.presets builds every network once
        // a day instead (P5-10).
        return [...written].filter((k) => k !== "cron:channelpresets:cursor").sort();
      };
      const inline = await run(false);
      const queued = await run(true);
      assert.ok(inline.length > 0, "the tick wrote something to compare");
      assert.deepEqual(queued, inline);
    } finally {
      net.restore();
    }
  });

  it("a job that is still running is not started again; one whose run stopped is, and counts as a failure", async () => {
    const net = blockNetwork();
    try {
      const env = jobsEnv();
      await runScheduledTick(env);
      await drainQueue(env);
      const now = Date.now();
      env.DB._db.prepare("UPDATE jobs SET run_after = 1 WHERE dedupe_key LIKE 'periodic:%'").run();
      env.DB._db.prepare("UPDATE jobs SET status = 'running', run_after = ? WHERE dedupe_key = 'periodic:cron.episodes'").run(now + 60000);
      await runScheduledTick(env);
      assert.deepEqual(sentTypes(env), CRON_JOBS.filter((t) => t !== "cron.episodes"));
      env.JOBS._pending.length = 0;

      // Its lease runs out: the run died.
      env.DB._db.prepare("UPDATE jobs SET run_after = ? WHERE dedupe_key = 'periodic:cron.episodes'").run(now - 1);
      await runScheduledTick(env);
      assert.deepEqual(sentTypes(env), ["cron.episodes"]);
      const row = jobRow(env, "cron.episodes");
      assert.equal(row.status, "queued");
      assert.equal(row.attempts, 1);
      assert.match(row.last_error, /Did not finish/);
      await drainQueue(env);
      const after = jobRow(env, "cron.episodes");
      assert.equal(after.attempts, 0, "a good run clears the count");
      assert.equal(after.last_error, null);
    } finally {
      net.restore();
    }
  });

  it("a job delivered twice runs once, and a message that arrives after it ran is ignored", async () => {
    const net = blockNetwork();
    try {
      const env = jobsEnv();
      await runScheduledTick(env);
      const copy = env.JOBS._pending.find((m) => m.body.type === "cron.housekeeping");
      env.JOBS._pending.push({ ...copy, id: "duplicate" });
      const log = await drainQueue(env);
      assert.equal(log.deliveries.filter((d) => d.type === "cron.housekeeping").length, 2);
      assert.equal(jobRow(env, "cron.housekeeping").q.runs, 1);
      env.JOBS._pending.push({ ...copy, id: "late" });
      await drainQueue(env);
      assert.equal(jobRow(env, "cron.housekeeping").q.runs, 1);
    } finally {
      net.restore();
    }
  });

  it("a job sent to the queue and never picked up is run by the tick itself", async () => {
    const net = blockNetwork();
    try {
      const env = jobsEnv();
      await runScheduledTick(env);
      // The messages are lost (or the queue has no consumer)...
      env.JOBS._pending.length = 0;
      // ...and the ten minutes they get to be picked up pass.
      env.DB._db.exec("UPDATE jobs SET run_after = 1 WHERE dedupe_key LIKE 'periodic:%'");
      await runScheduledTick(env);
      assert.deepEqual(sentTypes(env), [], "run here, not sent again");
      for (const type of CRON_JOBS) {
        const row = jobRow(env, type);
        assert.equal(row.q.runs, 1, type);
        assert.equal(row.status, "queued");
      }
      // The next time they are due, the queue gets another chance.
      env.DB._db.exec("UPDATE jobs SET run_after = 1 WHERE dedupe_key LIKE 'periodic:%'");
      await runScheduledTick(env);
      assert.deepEqual(sentTypes(env), CRON_JOBS);
    } finally {
      net.restore();
    }
  });

  it("without the queue, a tick does the work itself and leaves the jobs table alone", async () => {
    const net = blockNetwork();
    try {
      const env = makeEnv({ DB: makeD1() });
      const d1 = countD1(env.DB);
      await runScheduledTick(env);
      assert.equal(env.DB._db.prepare("SELECT count(*) AS n FROM jobs").get().n, 0);
      assert.ok(d1.n > 0, "the work ran");
      assert.ok(env.CONFIGS._store.size > 0, "and wrote what it writes");
    } finally {
      net.restore();
    }
  });

  it("with the queue bound but no jobs table (migration 0016 not applied), a tick does the work itself", async () => {
    const net = blockNetwork();
    try {
      const w = await freshIsolate();
      const env = jobsEnv();
      env.DB._db.exec("DROP TABLE jobs");
      const written = new Set();
      env.CONFIGS._hooks.beforePut = async (key) => { written.add(key); };
      await runScheduledTick(env, {}, w);
      assert.deepEqual(sentTypes(env), []);
      assert.ok(written.size > 0, "the work ran");
    } finally {
      net.restore();
    }
  });

  it("the admin's Check jobs lists each job's last run", async () => {
    const net = blockNetwork();
    try {
      const env = jobsEnv();
      const cookie = await adminCookie(env);
      const empty = await call(env, "/admin/api/jobs/status", { cookie });
      assert.deepEqual(empty.body.jobs, { periodic: [], durable: {} });
      await runScheduledTick(env);
      const sent = await call(env, "/admin/api/jobs/status", { cookie });
      assert.deepEqual(sent.body.jobs.periodic.map((j) => [j.type, j.status]), CRON_JOBS.map((t) => [t, "sent"]));
      await drainQueue(env);
      const ran = await call(env, "/admin/api/jobs/status", { cookie });
      for (const j of ran.body.jobs.periodic) {
        assert.equal(j.status, "queued");
        assert.equal(j.runs, 1);
        assert.equal(j.failuresInARow, 0);
        assert.equal(typeof j.nextAt, "number");
        assert.equal(typeof j.lastMs, "number");
      }
      const page = await call(env, "/admin", { cookie });
      assert.match(page.text, /id="jobsStatusBtn" data-act="runJobsStatus" >/);

      env.DB._db.exec("DROP TABLE jobs");
      const none = await call(env, "/admin/api/jobs/status", { cookie });
      assert.equal(none.body.jobs, null);
    } finally {
      net.restore();
    }
  });

  it("writes one metrics point per dispatching tick", async () => {
    const net = blockNetwork();
    try {
      const points = [];
      const env = jobsEnv({ ANALYTICS: { writeDataPoint: (p) => points.push(p) } });
      await runScheduledTick(env);
      const tick = points.filter((p) => p.indexes && p.indexes[0] === "jobs-dispatch");
      assert.equal(tick.length, 1);
      assert.deepEqual(tick[0].blobs, ["jobs-dispatch", "queue"]);
      assert.deepEqual(tick[0].doubles.slice(0, 5), [CRON_JOBS.length, CRON_JOBS.length, 0, 0, 0]);
    } finally {
      net.restore();
    }
  });
});

// One-off jobs (defineDurableJob / createJob). No job type uses them yet
// (imports and account purges will), so these define one in a sandbox.
describe("P5-2: one-off jobs", () => {
  const plain = (o) => JSON.parse(JSON.stringify(o));
  function setup(behavior, { maxAttempts = 3, queue = true } = {}) {
    const sb = loadSourceFunctions("44_jobs-queue.js", "45_jobs-dispatcher.js");
    const seen = [];
    sb.defineDurableJob("test.work", {
      maxAttempts,
      run: async (env, payload, job) => {
        seen.push({ payload: plain(payload), attempts: job.attempts, progress: plain(job.progress) });
        return behavior(payload, job, seen.length);
      },
    });
    const env = { DB: makeD1(), CONFIGS: makeEnv().CONFIGS, ...(queue ? { JOBS: makeQueue() } : {}) };
    // Deliver only this test's jobs (the cron's own need the whole Worker).
    const deliver = async () => {
      env.JOBS._pending.splice(0, env.JOBS._pending.length, ...env.JOBS._pending.filter((m) => m.body.type === "test.work"));
      return drainQueue(env, { w: { queue: (batch, e, ctx) => sb.handleJobsBatch(batch, e, ctx) } });
    };
    const row = (id) => {
      const r = env.DB._db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
      return { ...r, progress: JSON.parse(r.progress_json || "{}") };
    };
    // One tick. `sent` counts this test's jobs only: the dispatcher also
    // sends the cron's own periodic jobs, which these tests leave aside.
    const tick = async () => {
      const pending = [];
      const ctx = { waitUntil: (p) => pending.push(p) };
      const work = () => (env.JOBS ? env.JOBS._pending.filter((m) => m.body.type === "test.work").length : 0);
      const before = work();
      const out = queue ? await sb.dispatchJobs(env, ctx) : await sb.runDueJobsInline(env, ctx);
      await Promise.all(pending);
      return { ...plain(out), sent: work() - before };
    };
    return { sb, env, seen, deliver, row, tick };
  }

  it("runs once through the queue, and the same dedupe key while it waits is the same job", async () => {
    const t = setup(() => ({ progress: { step: "all" } }));
    const a = plain(await t.sb.createJob(t.env, "test.work", { dedupeKey: "work:1", accountId: 7, payload: { n: 1 } }));
    assert.deepEqual([a.ok, a.created, a.sent], [true, true, true]);
    const b = plain(await t.sb.createJob(t.env, "test.work", { dedupeKey: "work:1", payload: { n: 2 } }));
    assert.deepEqual([b.ok, b.id, b.created, b.sent], [true, a.id, false, false]);
    await t.deliver();
    assert.deepEqual(t.seen, [{ payload: { n: 1 }, attempts: 1, progress: {} }]);
    const r = t.row(a.id);
    assert.equal(r.status, "done");
    assert.equal(r.account_id, 7);
    assert.equal(r.progress.step, "all");
    // Done: the same key starts it again, with the new payload.
    const c = plain(await t.sb.createJob(t.env, "test.work", { dedupeKey: "work:1", payload: { n: 3 } }));
    assert.deepEqual([c.id, c.created, c.sent], [a.id, true, true]);
    await t.deliver();
    assert.deepEqual(t.seen.map((s) => s.payload.n), [1, 3]);
  });

  it("carries on in bounded steps, keeping its progress", async () => {
    const t = setup((payload, job) => {
      const done = (job.progress.done || 0) + 1;
      return done < 3 ? { progress: { done }, again: true } : { progress: { done } };
    });
    const { id } = plain(await t.sb.createJob(t.env, "test.work", {}));
    await t.deliver();
    assert.deepEqual(t.seen.map((s) => s.progress), [{}, { done: 1 }, { done: 2 }]);
    assert.equal(t.row(id).status, "done");
    assert.equal(t.row(id).progress.done, 3);
  });

  it("a failing job is tried again after a delay, then marked failed", async () => {
    const t = setup(() => { throw new Error("provider said no"); }, { maxAttempts: 3 });
    const { id } = plain(await t.sb.createJob(t.env, "test.work", { payload: { n: 1 } }));
    await t.deliver();
    let r = t.row(id);
    assert.equal(r.status, "queued");
    assert.equal(r.attempts, 1);
    assert.match(r.last_error, /provider said no/);
    const wait = r.run_after - r.progress._q.lastFinishedAt;
    assert.equal(wait, 30000, "the first retry waits 30 s");
    // Not due yet: nothing is sent.
    assert.equal((await t.tick()).sent, 0);
    for (let attempt = 2; attempt <= 3; attempt++) {
      t.env.DB._db.prepare("UPDATE jobs SET run_after = 1 WHERE id = ?").run(id);
      assert.equal((await t.tick()).sent, 1);
      await t.deliver();
    }
    r = t.row(id);
    assert.equal(r.status, "failed");
    assert.equal(r.attempts, 3);
    assert.deepEqual(t.seen.map((s) => s.attempts), [1, 2, 3]);
    assert.equal((await t.tick()).sent, 0, "a failed job is not sent again");
  });

  it("a run that stopped part way is started again after its lease, and fails for good at the limit", async () => {
    const t = setup(() => ({}), { maxAttempts: 2 });
    const { id } = plain(await t.sb.createJob(t.env, "test.work", {}));
    t.env.JOBS._pending.length = 0;
    // Claimed by a run that then died.
    t.env.DB._db.prepare("UPDATE jobs SET status = 'running', run_after = 1 WHERE id = ?").run(id);
    assert.equal((await t.tick()).sent, 1);
    assert.equal(t.row(id).attempts, 1);
    t.env.JOBS._pending.length = 0;
    t.env.DB._db.prepare("UPDATE jobs SET status = 'running', run_after = 1 WHERE id = ?").run(id);
    const out = await t.tick();
    assert.equal(out.sent, 0);
    assert.equal(out.failed, 1);
    assert.equal(t.row(id).status, "failed");
    assert.deepEqual(t.seen, []);
  });

  it("without the queue, the tick runs due one-off jobs itself", async () => {
    const t = setup((payload) => ({ progress: { n: payload.n } }), { queue: false });
    const a = plain(await t.sb.createJob(t.env, "test.work", { payload: { n: 1 } }));
    assert.deepEqual([a.created, a.sent], [true, false]);
    const out = await t.tick();
    assert.equal(out.ran, 1);
    assert.equal(t.row(a.id).status, "done");
    assert.equal(t.row(a.id).progress.n, 1);
  });

  it("refuses to create a job of a type that is not a one-off job", async () => {
    const t = setup(() => ({}));
    await assert.rejects(t.sb.createJob(t.env, "cron.episodes", {}), /not a job type that can be created/);
    await assert.rejects(t.sb.createJob(t.env, "no.such-type", {}), /not a job type that can be created/);
    assert.deepEqual(plain(await t.sb.createJob({}, "test.work", {})), { ok: false, reason: "noDatabase" });
  });
});
