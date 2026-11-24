// My Lists TV: whole-show watched/unwatched, and the watched read-back.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, makeD1, makeKv, call, accountProof, realFetch } from "./harness.mjs";

const HDR = { "origin": "https://mylistsaddon.com" };
const hist = (env, json) => call(env, "/api/nuvio-tv/history", { method: "POST", headers: HDR, json });
const remove = (env, json) => call(env, "/api/nuvio-tv/history/remove", { method: "POST", headers: HDR, json });
const watched = (env, json) => call(env, "/api/nuvio-tv/watched", { method: "POST", headers: HDR, json });
const record = async (env, user) => JSON.parse(await env.CONFIGS.get(`creatorsynctracking:${user}`));

async function pairTv(env, name) {
  const proof = await accountProof(env, name);
  const code = await call(env, "/api/nuvio-tv/device/code", { method: "POST" });
  const claim = await call(env, "/api/nuvio-tv/device/claim", { method: "POST", json: { userCode: code.body.userCode, creatorName: name, creatorKey: proof.creatorKey } });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  return claim.body.installId;
}

// A show with one aired season of 2 episodes, a second season with 1 aired and 1 future episode.
const FUTURE = "2999-01-01";
function stubTmdb() {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (!u.includes("api.themoviedb.org")) throw new Error("network disabled in test: " + u);
    const ok = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    if (u.includes("/find/")) return ok({ tv_results: [{ id: 99 }], movie_results: [] });
    const season = u.match(/\/tv\/99\/season\/(\d+)/);
    if (season) {
      return ok(Number(season[1]) === 1
        ? { episodes: [{ episode_number: 1, name: "Pilot", air_date: "2020-01-01" }, { episode_number: 2, name: "Two", air_date: "2020-01-08", still_path: "/s2.jpg" }] }
        : { episodes: [{ episode_number: 1, name: "Back", air_date: "2021-01-01" }, { episode_number: 2, name: "Future", air_date: FUTURE }, { episode_number: 3, name: "Undated", air_date: null }] });
    }
    if (u.includes("/tv/99")) return ok({ id: 99, name: "Test Show", poster_path: "/p.jpg", seasons: [{ season_number: 0, episode_count: 1 }, { season_number: 1, episode_count: 2 }, { season_number: 2, episode_count: 3 }], external_ids: { imdb_id: "tt0000099" } });
    return new Response("{}", { status: 404 });
  };
}
afterEach(() => { globalThis.fetch = realFetch; });

describe("My Lists TV whole-show watched", () => {
  it("series with neither season/episode nor whole:true is a 400, and a single episode still works", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const tv = await pairTv(env, "tvwhole0");
    assert.equal((await hist(env, { targetId: tv, type: "series", imdbId: "tt0000099" })).status, 400);
    assert.equal((await hist(env, { targetId: tv, type: "series", imdbId: "tt0000099", whole: false })).status, 400);
    assert.equal((await hist(env, { targetId: tv, type: "series", imdbId: "notanid", whole: true })).status, 400);
    assert.equal((await hist(env, { targetId: tv, type: "series", imdbId: "tt0000099", season: 2, episode: 5 })).status, 200);
    const rec = await record(env, "tvwhole0");
    assert.deepEqual(rec.watchHistory.map((e) => e.id), ["tt0000099:2:5"], "only the named episode, not S1E1");
  });

  it("whole:true records every aired episode, marks the show fully watched and clears its shelves; remove undoes it", async () => {
    stubTmdb();
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), TMDB_API_KEY: "k" });
    const tv = await pairTv(env, "tvwhole1");
    const seed = await record(env, "tvwhole1").catch(() => null) || {};
    await env.CONFIGS.put("creatorsynctracking:tvwhole1", JSON.stringify({
      ...seed, watchHistory: [{ id: "tt1", type: "movie", name: "M", watchedAt: 1 }, { id: "tt0000088:1:1", type: "episode", showId: "tt0000088", seasonNum: 1, episodeNum: 1, watchedAt: 1 }],
      continueWatching: [{ id: "tt0000099:1:1", type: "episode", showId: "tt0000099", seasonNum: 1, episodeNum: 1 }, { id: "tt5", showId: "tt5" }],
      watchlist: [{ id: "tt0000099" }, { id: "tt7" }], fullyWatchedShowIds: [], updatedAt: 1,
    }));
    const res = await hist(env, { targetId: tv, type: "series", imdbId: "tt0000099", whole: true, watchedAt: 1730000000000 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const rec = await record(env, "tvwhole1");
    const mine = rec.watchHistory.filter((e) => e.showId === "tt0000099").map((e) => `${e.seasonNum}:${e.episodeNum}`).sort();
    assert.deepEqual(mine, ["1:1", "1:2", "2:1"], "aired episodes only: no season 0, no future, no undated");
    assert.ok(rec.watchHistory.every((e) => e.showId !== "tt0000099" || e.watchedAt === 1730000000000));
    assert.equal(rec.watchHistory.find((e) => e.id === "tt0000099:1:2").poster.includes("/s2.jpg"), true);
    assert.ok(rec.watchHistory.some((e) => e.id === "tt1") && rec.watchHistory.some((e) => e.showId === "tt0000088"), "other titles untouched");
    assert.deepEqual(rec.fullyWatchedShowIds, ["tt0000099"]);
    assert.deepEqual(rec.continueWatching.map((e) => e.id), ["tt5"]);
    assert.deepEqual(rec.watchlist.map((e) => e.id), ["tt7"]);
    // Doing it twice does not duplicate anything.
    await hist(env, { targetId: tv, type: "series", imdbId: "tt0000099", whole: true });
    const again = await record(env, "tvwhole1");
    assert.equal(again.watchHistory.filter((e) => e.showId === "tt0000099").length, 3);
    assert.deepEqual(again.fullyWatchedShowIds, ["tt0000099"]);

    assert.equal((await remove(env, { targetId: tv, type: "series", imdbId: "tt0000099", whole: true })).status, 200);
    const gone = await record(env, "tvwhole1");
    assert.equal(gone.watchHistory.some((e) => e.showId === "tt0000099"), false);
    assert.deepEqual(gone.fullyWatchedShowIds, []);
    assert.ok(gone.watchHistory.some((e) => e.id === "tt1") && gone.watchHistory.some((e) => e.showId === "tt0000088"), "other titles survive the removal");
  });

  it("whole:true on a show TMDB cannot find is a 404 and changes nothing", async () => {
    globalThis.fetch = async () => new Response("{}", { status: 404 });
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), TMDB_API_KEY: "k" });
    const tv = await pairTv(env, "tvwhole2");
    const res = await hist(env, { targetId: tv, type: "series", imdbId: "tt0000077", whole: true });
    assert.equal(res.status, 404);
    const rec = await env.CONFIGS.get("creatorsynctracking:tvwhole2");
    assert.ok(!rec || !JSON.parse(rec).fullyWatchedShowIds.includes("tt0000077"));
  });
});

describe("My Lists TV watched read-back", () => {
  it("lists finished movies, shows, their episodes and which shows are complete", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const tv = await pairTv(env, "tvwatched");
    await env.CONFIGS.put("creatorsynctracking:tvwatched", JSON.stringify({
      watchHistory: [
        { id: "tt1", type: "movie", watchedAt: 5 }, { id: "tt1", type: "movie", watchedAt: 4 }, { id: "tmdb:9", type: "movie", watchedAt: 3 },
        { id: "tt2:2:1", type: "episode", showId: "tt2", seasonNum: 2, episodeNum: 1, watchedAt: 9 },
        { id: "tt2:1:10", type: "episode", showId: "tt2", seasonNum: 1, episodeNum: 10, watchedAt: 8 },
        { id: "tt2:1:2", type: "episode", showId: "tt2", seasonNum: 1, episodeNum: 2, watchedAt: 7 },
        { id: "tt3:1:1", type: "episode", showId: "tt3", seasonNum: 1, episodeNum: 1, watchedAt: 1 },
        { id: "tmdb:5:1:1", type: "episode", showId: "tmdb:5", seasonNum: 1, episodeNum: 1, watchedAt: 1 },
      ],
      fullyWatchedShowIds: ["tt3", "tt4", "tmdb:5"], continueWatching: [], watchlist: [], updatedAt: 1,
    }));
    const res = await watched(env, { targetId: tv, action: "get" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(res.body.movies, ["tt1"], "IMDb ids only, no repeats");
    assert.deepEqual(res.body.shows, [
      { id: "tt2", complete: false, episodes: ["1:2", "1:10", "2:1"] },
      { id: "tt3", complete: true, episodes: ["1:1"] },
      { id: "tt4", complete: true, episodes: [] },
    ]);
  });

  it("needs the pairing token and the get action", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const tv = await pairTv(env, "tvwatched2");
    assert.equal((await watched(env, { targetId: "tvwatched2", action: "get" })).status, 404, "a username is not a proof");
    assert.equal((await watched(env, { targetId: tv })).status, 400);
    const empty = await watched(env, { targetId: tv, action: "get" });
    assert.deepEqual([empty.body.ok, empty.body.movies, empty.body.shows], [true, [], []]);
  });
});
