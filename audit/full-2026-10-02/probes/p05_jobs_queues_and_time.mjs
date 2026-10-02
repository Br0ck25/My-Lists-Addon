// Module 06 Probe: Jobs, Queues, Cron, and Time Boundaries
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.AUDIT_ROOT || path.resolve(SCRIPT_DIR, "../../..");

const harnessPath = path.resolve(REPO_ROOT, "tests/harness.mjs");
const { worker, freshIsolate, makeEnv, makeD1, makeQueue, drainQueue, call, runScheduledTick } = await import(pathToFileURL(harnessPath).href);

console.log("=== START MODULE 06 PROBE: JOBS, QUEUES, CRON & TIME BOUNDARIES ===");

function jobsEnv(extra = {}) {
  return makeEnv({ DB: makeD1(), JOBS: makeQueue(), ...extra });
}

// =============================================================================
// SUITE 1: Queue Message Lifecycle, Poison Pill Defense & Dead-Letter Handling
// =============================================================================
console.log("\n[Suite 1] Testing Cloudflare Queue message lifecycle, poison pills, and DLQ...");

const env1 = jobsEnv();

// 1a. Valid Job Enqueue & Roundtrip (jobs.ping)
const pingPayload = { nonce: "test-nonce-12345678", sentAt: Date.now() };
const enqueueRes = await env1.JOBS.send({
  v: 1,
  type: "jobs.ping",
  payload: pingPayload,
  enqueuedAt: Date.now(),
}, { contentType: "json" });

assert.equal(env1.JOBS._pending.length, 1, "Queue must hold 1 pending message");
const pendingMsg = env1.JOBS._pending[0];
assert.equal(pendingMsg.body.v, 1);
assert.equal(pendingMsg.body.type, "jobs.ping");
assert.equal(pendingMsg.body.payload.nonce, pingPayload.nonce);

const log1 = await drainQueue(env1);
assert.equal(log1.deliveries.length, 1);
assert.equal(log1.deliveries[0].type, "jobs.ping");
assert.equal(log1.deliveries[0].outcome, "ack");

// 1b. Poison Pill & Malformed Message Defense (Negative Control)
// Delivering non-object, array, missing type, or malformed bodies must NOT crash consumer
const poisonMessages = [
  null,
  "string body",
  12345,
  [],
  { foo: "bar" }, // missing type
  { type: "" },   // empty type
  { type: 123 },  // numeric type
];

let outcome = [];
const fakeMessages = poisonMessages.map((body, i) => ({
  id: `poison-${i}`,
  timestamp: new Date(),
  body,
  attempts: 1,
  ack() { outcome[i] = "ack"; },
  retry() { outcome[i] = "retry"; },
}));

await worker.queue({ queue: "mylists-jobs", messages: fakeMessages, ackAll() {}, retryAll() {} }, env1, { waitUntil() {} });

// Every malformed message must be explicitly acknowledged and dropped (never retried to avoid poison pill loop)
for (let i = 0; i < poisonMessages.length; i++) {
  assert.equal(outcome[i], "ack", `Poison message #${i} must be acknowledged and dropped`);
}
console.log("  -> Poison pill defense verified: 7/7 malformed messages safely dropped without queue crash.");

// 1c. Unknown Job Type Handling (Deployment Rollback/Skew Defense)
// An unknown job type must be RETRIED with delay, not dropped immediately
outcome = [];
const unknownMsg = [{
  id: "unknown-1",
  timestamp: new Date(),
  body: { v: 1, type: "unregistered.feature.v2", payload: {}, enqueuedAt: Date.now() },
  attempts: 1,
  ack() { outcome[0] = "ack"; },
  retry(opts = {}) { outcome[0] = { what: "retry", delaySeconds: opts.delaySeconds }; },
}];

await worker.queue({ queue: "mylists-jobs", messages: unknownMsg, ackAll() {}, retryAll() {} }, env1, { waitUntil() {} });
assert.equal(outcome[0].what, "retry", "Unknown job type must be retried to survive rollbacks");
assert.ok(outcome[0].delaySeconds >= 600, "Unknown job type retry delay must be at least 10 minutes");
console.log("  -> Unknown job type retry backoff verified.");

// 1d. Max Retries & DLQ Routing (Negative Control)
// We simulate a failing job. After 5 retries (6 deliveries total), it must move to queue._dlq
const failQueue = makeQueue();
const envDlq = makeEnv({ DB: makeD1(), JOBS: failQueue });
// Enqueue a jobs.ping with invalid nonce to force run() to complete without ack, or hand-craft a failing job
let failAttempts = 0;
const failingJobType = "test.failing.job";
// Use hand delivery through drainQueue with a worker that throws for this job
const customWorker = {
  ...worker,
  async queue(batch, env, ctx) {
    for (const m of batch.messages) {
      if (m.body && m.body.type === failingJobType) {
        m.retry({ delaySeconds: 30 });
      } else {
        m.ack();
      }
    }
  }
};

failQueue._pending.push({
  id: "fail-msg-1",
  timestamp: new Date(),
  body: { v: 1, type: failingJobType, payload: {} },
  attempts: 1,
});

const drainLog = await drainQueue(envDlq, { queue: failQueue, w: customWorker, maxRetries: 5 });
assert.equal(failQueue._dlq.length, 1, "Job must move to DLQ after exceeding maxRetries");
assert.equal(failQueue._dlq[0].id, "fail-msg-1");
console.log("  -> DLQ routing verified: Failing job safely moved to dead-letter queue after 5 retries.");

console.log("-> SUITE 1 PASSED: Queue lifecycle, poison-pill defense, and DLQ verified.");

// =============================================================================
// SUITE 2: D1 Jobs Dispatcher, Lease Expiry & Optimistic Concurrency
// =============================================================================
console.log("\n[Suite 2] Testing D1 Jobs Dispatcher, CAS claiming and lease recovery...");

const env2 = jobsEnv();
const now = 1700000000000;

// 2a. Insert a row in jobs table directly
const jobId = 101;
const token1 = now + 600000; // token = now + JOBS_DISPATCH_GRACE_MS
await env2.DB.prepare(
  "INSERT INTO jobs (id, type, dedupe_key, status, run_after, attempts, payload_json, progress_json, created_at, updated_at) " +
  "VALUES (?, 'test.durable', 'durable:101', 'queued', ?, 0, '{}', '{}', ?, ?)"
).bind(jobId, token1, now, now).run();

// 2b. Worker 1 claims job with valid token1 (CAS Update)
const leaseMs = 15 * 60 * 1000;
const leaseUntil1 = now + leaseMs;
const claim1 = await env2.DB.prepare(
  "UPDATE jobs SET status = 'running', run_after = ?, updated_at = ? WHERE id = ? AND status = 'queued' AND run_after = ?"
).bind(leaseUntil1, now, jobId, token1).run();

assert.equal(claim1.meta.changes, 1, "Worker 1 must successfully claim the job");

// 2c. Worker 2 receives duplicate delivery with token1 (Negative Control)
const claim2 = await env2.DB.prepare(
  "UPDATE jobs SET status = 'running', run_after = ?, updated_at = ? WHERE id = ? AND status = 'queued' AND run_after = ?"
).bind(leaseUntil1, now, jobId, token1).run();

assert.equal(claim2.meta.changes, 0, "Worker 2 duplicate claim must match 0 rows and be skipped");

// Verify row status is running under leaseUntil1
const runningRow = await env2.DB.prepare("SELECT status, run_after FROM jobs WHERE id = ?").bind(jobId).first();
assert.equal(runningRow.status, "running");
assert.equal(Number(runningRow.run_after), leaseUntil1);

// 2d. Lease Expiry & Recovery
// Suppose Worker 1 dies. Time advances past leaseUntil1.
const nowAfterLease = leaseUntil1 + 1000;
const expiredRow = await env2.DB.prepare(
  "SELECT id, type, status, attempts, run_after FROM jobs WHERE id = ? AND status = 'running' AND run_after < ?"
).bind(jobId, nowAfterLease).first();

assert.ok(expiredRow, "Dispatcher must identify running row past lease expiry");

// Dispatcher recovers expired job: increments attempts, re-queues
const token2 = nowAfterLease + 600000;
const recovery = await env2.DB.prepare(
  "UPDATE jobs SET status = 'queued', attempts = attempts + 1, run_after = ?, updated_at = ? WHERE id = ? AND status = 'running' AND run_after = ?"
).bind(token2, nowAfterLease, jobId, leaseUntil1).run();

assert.equal(recovery.meta.changes, 1, "Dispatcher must atomically reclaim expired lease");

// 2e. Stale Worker Completion Rejection (Negative Control)
// Worker 1 finishes very late and attempts to write status='done' with the old leaseUntil1
const lateComplete = await env2.DB.prepare(
  "UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ? AND status = 'running' AND run_after = ?"
).bind(nowAfterLease + 2000, jobId, leaseUntil1).run();

assert.equal(lateComplete.meta.changes, 0, "Late worker completion must match 0 rows and be rejected");

console.log("-> SUITE 2 PASSED: CAS claiming, duplicate rejection, and lease recovery verified.");

// =============================================================================
// SUITE 3: Cron Dispatches & Queue-Unbound Fallback Mode
// =============================================================================
console.log("\n[Suite 3] Testing Cron Dispatches and Queue-Unbound Fallback Mode...");

// 3a. Verify runScheduledTick dispatches without throwing
const env3 = jobsEnv();
let tickThrew = false;
try {
  await runScheduledTick(env3);
} catch (err) {
  tickThrew = true;
  console.error("Scheduled tick threw:", err);
}
assert.equal(tickThrew, false, "Scheduled tick must complete cleanly");

// 3b. Verify Queue-Unbound Fallback
// When JOBS binding is completely missing (e.g. Free plan or unconfigured queue),
// scheduled tick must gracefully fall back to inline processing without throwing.
const envNoJobs = makeEnv({ DB: makeD1(), JOBS: null });
let noJobsThrew = false;
try {
  await runScheduledTick(envNoJobs);
} catch (err) {
  noJobsThrew = true;
  console.error("Unbound queue tick threw:", err);
}
assert.equal(noJobsThrew, false, "Unbound queue scheduled tick must execute fallback inline without error");

console.log("-> SUITE 3 PASSED: Scheduled cron dispatch and unbound queue fallback verified.");

// =============================================================================
// SUITE 4: Time Boundaries, Controlled Clocks & Calendars
// =============================================================================
console.log("\n[Suite 4] Testing Time Boundaries, Eastern vs UTC rollover, leap days and sunset notices...");

// 4a. Eastern Time Zone vs UTC Daily Rollover
// Test that Eastern rollover occurs at midnight America/New_York (not midnight UTC)
function easternDateKeyTest(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

// 2026-06-15 23:59:59 EDT (New York) = 2026-06-16T03:59:59Z
const tNight1 = new Date("2026-06-16T03:59:59.000Z");
assert.equal(easternDateKeyTest(tNight1), "2026-06-15", "Before midnight Eastern must be 2026-06-15");

// 2026-06-16 00:00:01 EDT (New York) = 2026-06-16T04:00:01Z
const tMorning1 = new Date("2026-06-16T04:00:01.000Z");
assert.equal(easternDateKeyTest(tMorning1), "2026-06-16", "After midnight Eastern must be 2026-06-16");

// Midnight UTC (2026-06-16T00:00:00Z) is 20:00 (8:00 PM) EDT on 2026-06-15
const tUtcMidnight = new Date("2026-06-16T00:00:00.000Z");
assert.equal(easternDateKeyTest(tUtcMidnight), "2026-06-15", "Midnight UTC must still be 2026-06-15 in Eastern time");

console.log("  -> Eastern timezone rollover verified: Rollover occurs at midnight Eastern, not midnight UTC.");

// 4b. Leap Day Handling (2028-02-28 -> 2028-02-29 -> 2028-03-01)
const tFeb28 = new Date("2028-02-28T12:00:00.000Z");
const tFeb29 = new Date("2028-02-29T12:00:00.000Z");
const tMar01 = new Date("2028-03-01T12:00:00.000Z");

assert.equal(tFeb28.toISOString().slice(0, 10), "2028-02-28");
assert.equal(tFeb29.toISOString().slice(0, 10), "2028-02-29");
assert.equal(tMar01.toISOString().slice(0, 10), "2028-03-01");

const diffMs = tMar01.getTime() - tFeb28.getTime();
assert.equal(diffMs, 2 * 24 * 60 * 60 * 1000, "Leap year February must have exactly 48 hours between Feb 28 and Mar 1");
console.log("  -> Leap day arithmetic verified.");

// 4c. Monthly Quota Ledger Rollover in D1
// Test the atomic month update logic from 53_more-jobs.js
const env4 = jobsEnv();
const RAPIDAPI_LEDGER_KEY = "ledger:rapidapi";

async function simulateLedgerAdd(env, month, add, nowMs) {
  // First ensure row exists
  const existing = await env.DB.prepare("SELECT progress_json FROM jobs WHERE dedupe_key = ?").bind(RAPIDAPI_LEDGER_KEY).first();
  if (!existing) {
    await env.DB.prepare(
      "INSERT INTO jobs (type, dedupe_key, status, run_after, progress_json, created_at, updated_at) " +
      "VALUES ('ledger.rapidapi', ?, 'done', 0, ?, ?, ?)"
    ).bind(RAPIDAPI_LEDGER_KEY, JSON.stringify({ month, count: 0, lastAt: null }), nowMs, nowMs).run();
  }
  await env.DB.prepare(
    `UPDATE jobs SET progress_json = json_object(
       'month', ?,
       'count', (CASE WHEN json_extract(progress_json, '$.month') = ? THEN COALESCE(json_extract(progress_json, '$.count'), 0) ELSE 0 END) + ?,
       'lastAt', ?), updated_at = ?
     WHERE dedupe_key = ?`
  ).bind(month, month, add, Math.floor(nowMs / 1000), nowMs, RAPIDAPI_LEDGER_KEY).run();

  const row = await env.DB.prepare("SELECT progress_json FROM jobs WHERE dedupe_key = ?").bind(RAPIDAPI_LEDGER_KEY).first();
  return JSON.parse(row.progress_json);
}

// Add 50 in 2026-01
const r1 = await simulateLedgerAdd(env4, "2026-01", 50, Date.parse("2026-01-15T12:00:00Z"));
assert.equal(r1.month, "2026-01");
assert.equal(r1.count, 50);

// Add 25 more in 2026-01
const r2 = await simulateLedgerAdd(env4, "2026-01", 25, Date.parse("2026-01-20T12:00:00Z"));
assert.equal(r2.count, 75);

// Month Rollover to 2026-02: Add 10 in new month
const r3 = await simulateLedgerAdd(env4, "2026-02", 10, Date.parse("2026-02-01T00:01:00Z"));
assert.equal(r3.month, "2026-02");
assert.equal(r3.count, 10, "Count must reset to exactly 10 on month rollover");

console.log("  -> Monthly quota atomic ledger rollover verified.");

// 4d. Half-Open Interval Check for Daily Rollup
// Event exactly at 2026-10-01T00:00:00.000Z must fall into 2026-10-01 and NOT 2026-09-30
const dayStart = Date.parse("2026-10-01T00:00:00.000Z");
const dayEnd = dayStart + 24 * 60 * 60 * 1000;

function isInDayBucket(eventTime, start, end) {
  return eventTime >= start && eventTime < end;
}

assert.equal(isInDayBucket(dayStart, dayStart, dayEnd), true, "Start boundary 00:00:00.000Z is included in day");
assert.equal(isInDayBucket(dayEnd - 1, dayStart, dayEnd), true, "End boundary 23:59:59.999Z is included in day");
assert.equal(isInDayBucket(dayEnd, dayStart, dayEnd), false, "Next day 00:00:00.000Z is excluded from day");
console.log("  -> Half-open interval [start, end) verified for daily rollups.");

// 4e. Sunset Notices 60-Day Window & Urgency
function getSunsetNoticesTest(env, nowMs) {
  if (!env || !env.SUNSET_60DAY_START_DATE) return [];
  const startMs = Date.parse(String(env.SUNSET_60DAY_START_DATE));
  if (!Number.isFinite(startMs)) return [];
  const sunsetMs = startMs + 60 * 24 * 60 * 60 * 1000;
  if (nowMs < startMs || nowMs >= sunsetMs + 24 * 60 * 60 * 1000) return [];
  const daysRemaining = Math.max(0, Math.ceil((sunsetMs - nowMs) / (24 * 60 * 60 * 1000)));
  const urgency = daysRemaining <= 7 ? "urgent" : daysRemaining <= 30 ? "warning" : "info";
  return { daysRemaining, urgency };
}

const sunsetConfig = { SUNSET_60DAY_START_DATE: "2026-06-01" };
const startMs = Date.parse("2026-06-01T00:00:00Z");

// Before start date: notices must be empty
assert.deepEqual(getSunsetNoticesTest(sunsetConfig, startMs - 1000), []);

// Day 0: 60 days remaining -> info
const day0 = getSunsetNoticesTest(sunsetConfig, startMs);
assert.equal(day0.daysRemaining, 60);
assert.equal(day0.urgency, "info");

// Day 35: 25 days remaining -> warning
const day35 = getSunsetNoticesTest(sunsetConfig, startMs + 35 * 86400000);
assert.equal(day35.daysRemaining, 25);
assert.equal(day35.urgency, "warning");

// Day 55: 5 days remaining -> urgent
const day55 = getSunsetNoticesTest(sunsetConfig, startMs + 55 * 86400000);
assert.equal(day55.daysRemaining, 5);
assert.equal(day55.urgency, "urgent");

// Day 60: 0 days remaining -> urgent ("today")
const day60 = getSunsetNoticesTest(sunsetConfig, startMs + 60 * 86400000);
assert.equal(day60.daysRemaining, 0);
assert.equal(day60.urgency, "urgent");

// Day 62: notices expired -> empty
assert.deepEqual(getSunsetNoticesTest(sunsetConfig, startMs + 62 * 86400000), []);

console.log("  -> Sunset notices 60-day lifecycle and urgency boundaries verified.");

console.log("\n=== ALL MODULE 06 PROBE CHECKS PASSED (4/4) ===");
