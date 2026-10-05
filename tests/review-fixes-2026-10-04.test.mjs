// Fixes from the 2026-10-04 review of the Phase 8-10 work.
//
//  - ensureTrackingMigrated (05_catalog-core.js) was emptied by P10-4. An
//    account whose tracking still sat inside creatorsync:{username} then lost
//    it on its first autosave, because /api/creator/sync/save writes that record
//    without the tracking fields.
//  - sync/load's sunset_notices were sent but never shown. The page shows the
//    one a visitor can act on, once per browser session.
//  - wrangler.toml names the live Worker, so a plain `wrangler deploy` must not
//    be able to drop its dashboard variables or its activity database.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { call, createUser, makeEnv } from "./harness.mjs";
import { loadClient } from "./client-harness.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

describe("an old account's watch history survives its first autosave", () => {
  it("moves tracking out of creatorsync: before sync/save rewrites it", async () => {
    const env = makeEnv();
    const u = await createUser(env, "oldtracker");
    const history = [{ id: "tt0111161", type: "movie", watchedAt: 1000 }];
    env.CONFIGS._store.delete(`creatorsynctracking:${u.creatorName}`);
    env.CONFIGS._store.set(`creatorsync:${u.creatorName}`, JSON.stringify({
      config: [], updatedAt: 1, watchHistory: history, continueWatching: [], trackPlayback: true,
    }));

    const r = await call(env, "/api/creator/sync/save", {
      method: "POST",
      json: { creatorName: u.creatorName, creatorKey: u.creatorKey, config: [] },
    });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));

    const tracking = JSON.parse(env.CONFIGS._store.get(`creatorsynctracking:${u.creatorName}`) || "null");
    assert.ok(tracking, "the tracking record was written before the save");
    assert.deepEqual(tracking.watchHistory, history);
    assert.equal(tracking.trackPlayback, true);
  });

  it("leaves an account that already has its own tracking record alone", async () => {
    const env = makeEnv();
    const u = await createUser(env, "newtracker");
    const own = { watchHistory: [{ id: "tt1", watchedAt: 5 }], continueWatching: [], updatedAt: 5 };
    env.CONFIGS._store.set(`creatorsynctracking:${u.creatorName}`, JSON.stringify(own));
    env.CONFIGS._store.set(`creatorsync:${u.creatorName}`, JSON.stringify({ config: [], watchHistory: [{ id: "tt-stale" }] }));
    await call(env, "/api/creator/sync/save", {
      method: "POST",
      json: { creatorName: u.creatorName, creatorKey: u.creatorKey, config: [] },
    });
    assert.deepEqual(JSON.parse(env.CONFIGS._store.get(`creatorsynctracking:${u.creatorName}`)).watchHistory, own.watchHistory);
  });
});

describe("sunset notices on the page", () => {
  const NOTICES = [
    { feature: "sync-shims", urgency: "info", daysRemaining: 40, message: "routes going" },
    { feature: "scrobble-legacy-auth", urgency: "urgent", daysRemaining: 5, message: "Update your media server webhook URL." },
  ];

  it("shows only the webhook notice, and only once per session", () => {
    const client = loadClient({});
    const shown = [];
    client.set("showToast", (msg, type) => shown.push({ msg, type }));
    client.call("showSunsetNoticesOnce", NOTICES);
    client.call("showSunsetNoticesOnce", NOTICES);
    assert.deepEqual(shown, [{ msg: "Update your media server webhook URL.", type: "error" }]);
  });

  it("shows nothing when the server sends none, or none for people", () => {
    const client = loadClient({});
    const shown = [];
    client.set("showToast", (msg) => shown.push(msg));
    client.call("showSunsetNoticesOnce", []);
    client.call("showSunsetNoticesOnce", undefined);
    client.call("showSunsetNoticesOnce", [NOTICES[0]]);
    assert.equal(shown.length, 0);
  });
});

describe("wrangler.toml cannot quietly undo the live settings", () => {
  const toml = fs.readFileSync(path.join(REPO_ROOT, "wrangler.toml"), "utf8");
  const top = toml.slice(0, toml.indexOf("[env.staging]"));

  it("keeps the dashboard's variables on deploy", () => {
    assert.match(top, /^keep_vars = true$/m);
  });

  it("binds DB_ACTIVITY, with an id that fails a deploy until it is filled in", () => {
    const block = top.match(/\[\[d1_databases\]\]\s*\nbinding = "DB_ACTIVITY"\s*\ndatabase_name = "mylists-activity"\s*\ndatabase_id = "([^"]+)"/);
    assert.ok(block, "an uncommented DB_ACTIVITY binding");
    assert.doesNotMatch(block[1], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "a placeholder until the owner fills it in");
  });
});

// --- Release 17 ------------------------------------------------------------------

describe("the old Continue Watching does not keep an episode just watched", () => {
  // TMDB, for a show whose newest episode is S5E8 and that has no season 6 yet.
  function fakeTmdb() {
    const realFetch = globalThis.fetch;
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    globalThis.fetch = async (input, init) => {
      const url = String(input && input.url ? input.url : input);
      if (!url.includes("api.themoviedb.org")) return realFetch(input, init);
      if (url.includes("/find/")) return json({ tv_results: [{ id: 555, name: "Latest Show" }], movie_results: [] });
      if (/\/tv\/555\/season\/5\b/.test(url)) {
        return json({ episodes: Array.from({ length: 8 }, (_, i) => ({ id: 9000 + i + 1, episode_number: i + 1, name: `Ep ${i + 1}`, air_date: "2026-01-0" + Math.min(9, i + 1) })) });
      }
      if (/\/tv\/555\/season\//.test(url)) return json({ status_message: "not found" }, 404);
      if (/\/tv\/555\b/.test(url)) return json({ id: 555, name: "Latest Show", genres: [], first_air_date: "2020-01-01", seasons: [{ season_number: 5, episode_count: 8 }] });
      return json({});
    };
    return () => { globalThis.fetch = realFetch; };
  }

  it("drops the stale entry and marks the show fully watched, so the sweep finds the next episode", async () => {
    const restore = fakeTmdb();
    try {
      const env = makeEnv();
      env.TMDB_API_KEY = "test-key";
      const u = await createUser(env, "latestep");
      await env.CONFIGS.put("cfg:latestcfg", JSON.stringify({ track: true, trackCreatorName: u.creatorName, trackCreatorKey: u.creatorKey, entries: [] }));
      env.CONFIGS._store.set(`creatorsynctracking:${u.creatorName}`, JSON.stringify({
        watchHistory: [{ id: "9007", type: "episode", showId: "tt0005555", seasonNum: 5, episodeNum: 7, watchedAt: 1000 }],
        continueWatching: [{ id: "9008", type: "episode", showId: "tt0005555", seasonNum: 5, episodeNum: 8 }],
        fullyWatchedShowIds: [], dismissedContinueWatching: {}, trackPlayback: true, updatedAt: 1000,
      }));

      await call(env, "/latestcfg/subtitles/series/tt0005555:5:8.json");

      const blob = JSON.parse(env.CONFIGS._store.get(`creatorsynctracking:${u.creatorName}`));
      assert.ok(blob.watchHistory.some((e) => e.seasonNum === 5 && e.episodeNum === 8), "the play was recorded");
      assert.deepEqual(blob.continueWatching.filter((e) => e.showId === "tt0005555"), [], "S5E8 is not offered again");
      assert.ok(blob.fullyWatchedShowIds.includes("tt0005555"), "the episode sweep will look for S5E9 / S6E1");
    } finally {
      restore();
    }
  });

  it("still keeps an entry that is ahead of what was watched", async () => {
    const restore = fakeTmdb();
    try {
      const env = makeEnv();
      env.TMDB_API_KEY = "test-key";
      const u = await createUser(env, "rewatcher");
      await env.CONFIGS.put("cfg:rewatchcfg", JSON.stringify({ track: true, trackCreatorName: u.creatorName, trackCreatorKey: u.creatorKey, entries: [] }));
      // Watched up to S5E8 already; Continue Watching offers a hand-added S6E1.
      env.CONFIGS._store.set(`creatorsynctracking:${u.creatorName}`, JSON.stringify({
        watchHistory: [{ id: "9008", type: "episode", showId: "tt0005555", seasonNum: 5, episodeNum: 8, watchedAt: 1000 }],
        continueWatching: [{ id: "x601", type: "episode", showId: "tt0005555", seasonNum: 6, episodeNum: 1 }],
        fullyWatchedShowIds: [], dismissedContinueWatching: {}, trackPlayback: true, updatedAt: 1000,
      }));
      // Re-watching an older episode.
      await call(env, "/rewatchcfg/subtitles/series/tt0005555:5:3.json");
      const blob = JSON.parse(env.CONFIGS._store.get(`creatorsynctracking:${u.creatorName}`));
      assert.deepEqual(blob.continueWatching.filter((e) => e.showId === "tt0005555").map((e) => `${e.seasonNum}:${e.episodeNum}`), ["6:1"]);
    } finally {
      restore();
    }
  });
});
