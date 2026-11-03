import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { activityBackfillStep, call, createUser, makeD1, makeEnv } from "./harness.mjs";

// PERF-02 (measuring test, step 1 of the plan). A playback ping for an account on the
// activity database used to cost: the shim's read of the whole record (get), the race
// check (get again), saveTrackingRecord's own read of every watch_events row, the
// O(n^2) match (PERF-01, fixed), and rebuildActivityProgress; then the targeted writes
// recordActivityPlay makes. This counts the full watch_events reads per ping.
//
// The fix in the plan (skip the blob round trip and call recordActivityPlay directly)
// was NOT built: the blob path is also where a ping computes the show's next episode
// and "fully watched" state from TMDB, which recordActivityPlay does not do. See
// docs/HANDOFF.md. So the CURRENT cost is pinned as a ceiling (it must not rise), and
// the plan's target is kept as a todo.

const N = 500;

async function setup() {
  const env = makeEnv({ DB: makeD1(), DB_ACTIVITY: makeD1({ schema: "activity" }), FF_EVENT_TRACKING: "1" });
  const user = await createUser(env, "pingcost");
  const config = "cfgpingco";
  await env.CONFIGS.put(`cfg:${config}`, JSON.stringify({
    track: true, trackCreatorName: user.creatorName, trackCreatorKey: user.creatorKey, showBadgesStremio: false,
    entries: [{ id: "wh", type: "movie", name: "Watch History", url: `autotrack:watch-history:movie:${user.creatorName}` }],
  }));
  const T = Date.parse("2026-01-01T00:00:00Z");
  await env.CONFIGS.put(`creatorsynctracking:${user.creatorName}`, JSON.stringify({
    updatedAt: T, trackPlayback: true,
    watchHistory: Array.from({ length: N }, (_, i) => ({ id: `tt${4000000 + i}`, type: "movie", name: `Old ${i}`, watchedAt: T - i * 3600000 })),
  }));
  for (let i = 0; i < 500; i++) {
    const r = await activityBackfillStep(env, { restart: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    if (r.body.done) break;
  }
  return { env, user, config };
}

describe("PERF-02: cost of one playback ping on the activity database", () => {
  it("reads the full watch history a bounded number of times (current cost, must not rise)", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, ...rest) => {
      const u = String(typeof input === "string" ? input : input?.url || input);
      if (/cinemeta|themoviedb\.org/i.test(u)) return new Response("{}", { status: 404 });
      return realFetch(input, ...rest);
    };
    try {
      const { env, config } = await setup();
      let fullReads = 0, statements = 0;
      const prep = env.DB_ACTIVITY.prepare.bind(env.DB_ACTIVITY);
      env.DB_ACTIVITY.prepare = (sql, ...a) => {
        statements++;
        if (/FROM watch_events/i.test(String(sql)) && !/\bLIMIT\b/i.test(String(sql)) && /WHERE (e\.)?account_id = \?\s*(ORDER BY[^;]*)?$/i.test(String(sql).trim())) fullReads++;
        return prep(sql, ...a);
      };
      const ping = await call(env, `/${config}/subtitles/movie/tt0000888.json`);
      assert.equal(ping.status, 200);
      // Measured 2026-11-03 with 500 plays: 2 full reads, 14 activity statements.
      assert.ok(fullReads >= 1, "the counter must see the full reads, or this test guards nothing");
      assert.ok(fullReads <= 2, `a ping read the whole history ${fullReads} times (measured 2)`);
      assert.ok(statements <= 14, `a ping made ${statements} activity statements (measured 14)`);
      console.log(`# PERF-02 baseline, ${N} plays: ${fullReads} full watch_events reads, ${statements} activity statements per ping`);
    } finally { globalThis.fetch = realFetch; }
  });

  it("target: a ping on an activity account reads no more than one page of history", { todo: "PERF-02 not built; see docs/HANDOFF.md" }, async () => {
    assert.fail("the blob round trip is still in the ping path");
  });
});
