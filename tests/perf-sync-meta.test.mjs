import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { activityBackfillStep, call, createUser, makeD1, makeEnv } from "./harness.mjs";

// PERF-03: sync/meta is polled every 60 s by every open tab. For an account on the
// activity database it assembled the whole tracking record (every play plus both
// shelves) just to read one timestamp. It must now read the record's own stamp.

const creds = (u) => ({ creatorName: u.creatorName, creatorKey: u.creatorKey });

async function setup() {
  const env = makeEnv({ DB: makeD1(), DB_ACTIVITY: makeD1({ schema: "activity" }), FF_EVENT_TRACKING: "1" });
  const user = await createUser(env, "metawatch");
  const config = "cfgmetawa";
  await env.CONFIGS.put(`cfg:${config}`, JSON.stringify({
    track: true, trackCreatorName: user.creatorName, trackCreatorKey: user.creatorKey, showBadgesStremio: false,
    entries: [{ id: "wh", type: "movie", name: "Watch History", url: `autotrack:watch-history:movie:${user.creatorName}` }],
  }));
  // Legacy tracking first, then the copy into the activity database.
  const T = Date.parse("2026-01-01T00:00:00Z");
  await env.CONFIGS.put(`creatorsynctracking:${user.creatorName}`, JSON.stringify({
    updatedAt: T + 1000, trackPlayback: true,
    watchHistory: Array.from({ length: 30 }, (_, i) => ({ id: `tt${3000000 + i}`, type: "movie", name: `Old ${i}`, watchedAt: T - i * 60000 })),
    continueWatching: [{ id: "x1", type: "episode", showId: "tt0386676", showTitle: "The Office", seasonNum: 2, episodeNum: 1, updatedAt: T - 5000 }],
  }));
  for (let i = 0; i < 500; i++) {
    const r = await activityBackfillStep(env, { restart: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    if (r.body.done) break;
  }
  return { env, user, config };
}

const meta = async (env, user) => (await call(env, "/api/creator/sync/meta", { method: "POST", json: creds(user) })).body;

function countWatchEventReads(env) {
  const seen = { n: 0 };
  const prep = env.DB_ACTIVITY.prepare.bind(env.DB_ACTIVITY);
  env.DB_ACTIVITY.prepare = (sql, ...a) => {
    if (/\bwatch_events\b/i.test(String(sql))) seen.n++;
    return prep(sql, ...a);
  };
  return seen;
}

describe("PERF-03: sync/meta does not assemble the tracking record", () => {
  it("reads no watch_events, and the tracking stamp still moves on save-tracking and on a ping", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, ...rest) => {
      const u = String(typeof input === "string" ? input : input?.url || input);
      if (/cinemeta|themoviedb\.org/i.test(u)) return new Response("{}", { status: 404 });
      return realFetch(input, ...rest);
    };
    try {
      const { env, user, config } = await setup();
      // The first read after the switch assembles (and migrates) the record; that
      // is the one allowed fallback. Everything after it must not.
      const load = (await call(env, "/api/creator/sync/load", { method: "POST", json: creds(user) })).body.data;
      const seen = countWatchEventReads(env);

      const m0 = await meta(env, user);
      assert.equal(m0.ok, true, JSON.stringify(m0));
      assert.equal(m0.exists, true);
      assert.ok(m0.tracking > 0, "the account has a tracking stamp");
      assert.equal(seen.n, 0, "sync/meta must not read watch_events");

      // The same number the full load hands the browser to compare against.
      assert.equal(m0.tracking, load.trackingUpdatedAt, "meta and load agree, so an idle tab never reloads");

      // A save from the website moves the stamp.
      const stamp = load.trackingUpdatedAt + 5000;
      const saved = await call(env, "/api/creator/sync/save-tracking", {
        method: "POST",
        json: { ...creds(user), ...load, updatedAt: stamp, trackPlayback: true, expectedClientVersion: load.trackingClientVersion },
      });
      assert.equal(saved.body.ok, true, JSON.stringify(saved.body));
      seen.n = 0;
      const m1 = await meta(env, user);
      assert.ok(m1.tracking > m0.tracking, `stamp after save-tracking (${m1.tracking}) must exceed ${m0.tracking}`);
      assert.equal(seen.n, 0);

      // A playback ping moves it too.
      await new Promise((r) => setTimeout(r, 5));
      const ping = await call(env, `/${config}/subtitles/movie/tt0000777.json`);
      assert.equal(ping.status, 200);
      seen.n = 0;
      const m2 = await meta(env, user);
      assert.ok(m2.tracking > m1.tracking, `stamp after a ping (${m2.tracking}) must exceed ${m1.tracking}`);
      assert.equal(seen.n, 0);
    } finally { globalThis.fetch = realFetch; }
  });

  it("an account not on the activity database still gets its stamp from the stored record", async () => {
    const env = makeEnv({ DB: makeD1() });
    const user = await createUser(env, "legacymeta");
    await env.CONFIGS.put(`creatorsynctracking:${user.creatorName}`, JSON.stringify({ updatedAt: 4242, watchHistory: [] }));
    const m = await meta(env, user);
    assert.equal(m.tracking, 4242);
  });
});
