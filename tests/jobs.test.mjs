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

import { worker, makeEnv, makeD1, makeQueue, drainQueue, call } from "./harness.mjs";

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
    assert.match(page.text, /id="jobsPingBtn" onclick="runJobsPing\(\)" disabled/);
  });

  it("the admin page offers the test job once JOBS is bound", async () => {
    const env = jobsEnv();
    const page = await call(env, "/admin", { cookie: await adminCookie(env) });
    assert.match(page.text, /Background jobs queue: <span style="color:#30d158;">bound<\/span>/);
    assert.match(page.text, /id="jobsPingBtn" onclick="runJobsPing\(\)" >/);
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
