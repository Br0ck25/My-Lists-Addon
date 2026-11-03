import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, makeD1, makeKv } from "./harness.mjs";
import { loadWorkerWithHooks } from "./perf-hooks.mjs";

// PERF-04 (owner accepted the trade-off, 2026-11-03): counters are added up in the
// isolate and written to D1 in one batch about once a minute, instead of two
// upserts per event on the same two hot rows. If an isolate is recycled between
// flushes, up to a minute of its counts is lost; the admin numbers are approximate
// by that much.

const load = () => loadWorkerWithHooks(`export const __s = { bumpStat, bumpStatBy, flushPendingStats, readStatCount, loadStatsByDay, statsToday };`);

function setup() {
  const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
  const batches = [];
  const batch = env.DB.batch.bind(env.DB);
  env.DB.batch = (stmts, ...a) => { batches.push(stmts.length); return batch(stmts, ...a); };
  const rows = (kind) => env.DB._db.prepare("SELECT day, n FROM stats WHERE kind = ? ORDER BY day").all(kind).map((r) => [r.day, Number(r.n)]);
  return { env, batches, rows };
}

async function withClock(startIso, fn) {
  const realNow = Date.now;
  let t = Date.parse(startIso);
  Date.now = () => t;
  try { return await fn({ advance: (ms) => { t += ms; } }); } finally { Date.now = realNow; }
}

describe("PERF-04: stat counters are batched", () => {
  it("100 bumps inside a minute write nothing, then one batch holds exactly 100", async () => {
    const { __s: s } = await load();
    const { env, batches, rows } = setup();
    await withClock("2026-11-03T15:00:00Z", async () => {
      for (let i = 0; i < 100; i++) await s.bumpStat(env, "pageviews");
      assert.equal(batches.length, 0, "nothing is written per event");
      assert.deepEqual(rows("pageviews"), []);
      await s.flushPendingStats(env);
      assert.equal(batches.length, 1, "one batch for the whole minute");
      assert.deepEqual(rows("pageviews"), [["2026-11-03", 100], ["total", 100]]);
      assert.equal(await s.readStatCount(env, "pageviews", "total"), 100, "the admin read sees exactly 100");
    });
  });

  it("the first bump after a minute has passed flushes the earlier ones too", async () => {
    const { __s: s } = await load();
    const { env, batches, rows } = setup();
    await withClock("2026-11-03T15:00:00Z", async (clock) => {
      for (let i = 0; i < 10; i++) await s.bumpStat(env, "installs");
      assert.equal(batches.length, 0);
      clock.advance(61_000);
      await s.bumpStat(env, "installs");
      assert.equal(batches.length, 1);
      assert.deepEqual(rows("installs").find((r) => r[0] === "total"), ["total", 11]);
      // And the next minute's bumps start a new window.
      for (let i = 0; i < 5; i++) await s.bumpStat(env, "installs");
      assert.equal(batches.length, 1);
    });
  });

  it("a map past 50 kinds flushes without waiting for the minute", async () => {
    const { __s: s } = await load();
    const { env, batches } = setup();
    await withClock("2026-11-03T15:00:00Z", async () => {
      for (let i = 0; i < 49; i++) await s.bumpStat(env, "k" + i);
      assert.equal(batches.length, 0);
      await s.bumpStat(env, "k49");
      assert.equal(batches.length, 1, "the 50th kind triggers the flush");
    });
  });

  it("a bump either side of midnight Eastern lands in two day rows", async () => {
    const { __s: s } = await load();
    const { env, batches, rows } = setup();
    // 2026-11-04T04:59:00Z = 23:59 EST on the 3rd; 05:01Z = 00:01 EST on the 4th.
    await withClock("2026-11-04T04:59:00Z", async (clock) => {
      await s.bumpStat(env, "daysplit");
      await s.bumpStat(env, "daysplit");
      clock.advance(2 * 60_000);
      await s.bumpStat(env, "daysplit"); // also past the minute: flushes
      await s.flushPendingStats(env);
      assert.deepEqual(rows("daysplit"), [["2026-11-03", 2], ["2026-11-04", 1], ["total", 3]]);
      assert.ok(batches.length >= 1);
    });
  });

  it("bumpStatBy batches too (total only), and counts add up with bumpStat", async () => {
    const { __s: s } = await load();
    const { env, batches, rows } = setup();
    await withClock("2026-11-03T15:00:00Z", async () => {
      await s.bumpStatBy(env, "apiuse:tmdb", 5);
      await s.bumpStat(env, "apiuse:tmdb");
      assert.equal(batches.length, 0);
      await s.flushPendingStats(env);
      assert.deepEqual(rows("apiuse:tmdb"), [["2026-11-03", 1], ["total", 6]]);
    });
  });

  it("a failed flush keeps the counts for the next one", async () => {
    const { __s: s } = await load();
    const { env, rows } = setup();
    await withClock("2026-11-03T15:00:00Z", async () => {
      await s.bumpStat(env, "retry");
      const good = env.DB.batch;
      env.DB.batch = async () => { throw new Error("D1 down"); };
      await s.flushPendingStats(env);
      assert.deepEqual(rows("retry"), []);
      env.DB.batch = good;
      await s.flushPendingStats(env);
      assert.deepEqual(rows("retry").find((r) => r[0] === "total"), ["total", 1]);
    });
  });

  it("without D1 the KV path is unchanged: written at once", async () => {
    const { __s: s } = await load();
    const env = makeEnv({ CONFIGS: makeKv() });
    delete env.DB;
    await s.bumpStat(env, "kvonly");
    assert.equal(await env.CONFIGS.get("stats:kvonly:total"), "1");
  });
});
