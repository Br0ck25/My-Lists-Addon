// The scrobble queue (56_scrobble-queue.js): a recent play removed from Watch
// History or Continue Watching stays removed, through the real Worker with
// TMDB faked. It used to come straight back on the next load, because
// sync/load merged creatorscrobblequeue:{user} in whatever the record said.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { call, createUser, makeD1, makeEnv, makeKv, nextIp } from "./harness.mjs";

const FIGHT_CLUB = { id: 550, title: "Fight Club", release_date: "1999-10-15", poster_path: "/fc.jpg" };
const MATRIX = { id: 603, title: "The Matrix", release_date: "1999-03-31", poster_path: "/mx.jpg" };
const SHOW = { id: 1399, name: "A Show", first_air_date: "2011-04-17", poster_path: "/show.jpg" };
const SHOW_IMDB = "tt0944947";

// TMDB knows two films and one show with three aired episodes.
let restoreFetch = null;
function fakeTmdb() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname !== "api.themoviedb.org") return new Response("{}", { status: 404 });
    const p = url.pathname;
    if (p === "/3/find/tt0137523") return Response.json({ movie_results: [FIGHT_CLUB], tv_results: [] });
    if (p === "/3/find/tt0133093") return Response.json({ movie_results: [MATRIX], tv_results: [] });
    if (p === "/3/find/" + SHOW_IMDB) return Response.json({ movie_results: [], tv_results: [SHOW] });
    if (p === "/3/movie/550") return Response.json({ ...FIGHT_CLUB, external_ids: { imdb_id: "tt0137523" } });
    if (p === "/3/movie/603") return Response.json({ ...MATRIX, external_ids: { imdb_id: "tt0133093" } });
    if (p === "/3/tv/1399") {
      return Response.json({ ...SHOW, external_ids: { imdb_id: SHOW_IMDB }, number_of_seasons: 1, seasons: [{ season_number: 1, episode_count: 3 }] });
    }
    if (p === "/3/tv/1399/season/1") {
      return Response.json({
        season_number: 1,
        episodes: [1, 2, 3].map((n) => ({ id: 100 + n, episode_number: n, season_number: 1, name: "Episode " + n, air_date: "2011-04-1" + n })),
      });
    }
    return new Response("{}", { status: 404 });
  };
  restoreFetch = () => { globalThis.fetch = realFetch; };
}
afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

async function account(env, name) {
  const u = await createUser(env, name);
  const cred = { creatorName: u.creatorName, creatorKey: u.creatorKey };
  const tok = await call(env, "/api/creator/scrobble-token", { method: "POST", ip: nextIp(), json: cred });
  assert.equal(tok.body.ok, true, tok.body.error);
  return { cred, token: tok.body.token };
}

// A Plex webhook, as Plex sends it.
async function plexPlays(env, token, metadata) {
  const r = await call(env, "/api/scrobble?st=" + encodeURIComponent(token), {
    method: "POST", ip: nextIp(), json: { event: "media.scrobble", Metadata: metadata },
  });
  assert.equal(r.status, 200);
  assert.match(String(r.body.matched), /^yes/, JSON.stringify(r.body));
  return r.body;
}
const movie = (imdb, title) => ({ type: "movie", title, Guid: [{ id: "imdb://" + imdb }] });
const episode = (n) => ({ type: "episode", grandparentTitle: SHOW.name, title: "Episode " + n, parentIndex: 1, index: n, grandparentGuid: "imdb://" + SHOW_IMDB });

async function load(env, cred) {
  const r = await call(env, "/api/creator/sync/load", { method: "POST", json: cred });
  assert.equal(r.body.ok, true, r.body.error);
  return r.body.data;
}

// What pushTrackingSync sends: the browser's whole copy, built on the load
// it last had.
async function push(env, cred, loaded, fields) {
  const r = await call(env, "/api/creator/sync/save-tracking", { method: "POST", json: {
    ...cred,
    watchHistory: loaded.watchHistory,
    continueWatching: loaded.continueWatching,
    fullyWatchedShowIds: loaded.fullyWatchedShowIds,
    dismissedContinueWatching: loaded.dismissedContinueWatching,
    trackPlayback: true,
    expectedClientVersion: loaded.trackingClientVersion,
    baseTrackingUpdatedAt: loaded.trackingUpdatedAt,
    ...fields,
  }});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true, r.body.error);
  return r.body;
}

const whIds = (data) => (data.watchHistory || []).map((it) => String(it.id));
const cwShows = (data) => (data.continueWatching || []).map((it) => String(it.showId || it.id));

describe("scrobble queue: a removed recent play stays removed", () => {
  it("a Watch History entry removed after a Plex play does not come back", async () => {
    fakeTmdb();
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1(), TMDB_API_KEY: "test-tmdb-key" });
    const { cred, token } = await account(env, "sqremovewh");

    await plexPlays(env, token, movie("tt0137523", "Fight Club"));
    await plexPlays(env, token, movie("tt0133093", "The Matrix"));
    const first = await load(env, cred);
    assert.deepEqual(whIds(first).sort(), ["tt0133093", "tt0137523"]);

    // removeFromWatchHistory: the shorter list, as an intentional removal.
    await push(env, cred, first, {
      watchHistory: first.watchHistory.filter((it) => it.id !== "tt0137523"),
      intentionalRemoval: true,
    });
    const second = await load(env, cred);
    assert.deepEqual(whIds(second), ["tt0133093"], "the removed play came back on the next load");

    // The next routine autosave must not bring it back either.
    await push(env, cred, second, {});
    assert.deepEqual(whIds(await load(env, cred)), ["tt0133093"]);
  });

  it("a show dismissed from Continue Watching after a Plex play does not come back", async () => {
    fakeTmdb();
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1(), TMDB_API_KEY: "test-tmdb-key" });
    const { cred, token } = await account(env, "sqremovecw");

    await plexPlays(env, token, episode(1));
    const first = await load(env, cred);
    assert.deepEqual(cwShows(first), [SHOW_IMDB], "the play should have queued the next episode");

    // dismissContinueWatchingShow: off the shelf, and marked caught up.
    await push(env, cred, first, {
      continueWatching: [],
      fullyWatchedShowIds: [SHOW_IMDB],
      dismissedContinueWatching: { [SHOW_IMDB]: { seasonNum: 1, episodeNum: 1 } },
      intentionalRemoval: true,
    });
    const second = await load(env, cred);
    assert.deepEqual(cwShows(second), [], "the dismissed show came back on the next load");

    await push(env, cred, second, {});
    assert.deepEqual(cwShows(await load(env, cred)), []);
  });

  it("a play scrobbled after the browser loaded survives a removal made from that load", async () => {
    fakeTmdb();
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1(), TMDB_API_KEY: "test-tmdb-key" });
    const { cred, token } = await account(env, "sqlateplay");

    await plexPlays(env, token, movie("tt0137523", "Fight Club"));
    const loaded = await load(env, cred);
    // Clocks move on between requests in real life; make sure they do here.
    await new Promise((r) => setTimeout(r, 5));

    // Played on the TV while the website sat open, not reloaded since.
    await plexPlays(env, token, movie("tt0133093", "The Matrix"));

    await push(env, cred, loaded, { watchHistory: [], intentionalRemoval: true });
    assert.deepEqual(whIds(await load(env, cred)), ["tt0133093"],
      "the removal took a play this browser never had");
  });

  it("still covers a record that does not have the latest play", async () => {
    fakeTmdb();
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1(), TMDB_API_KEY: "test-tmdb-key" });
    const { cred, token } = await account(env, "sqbehind");

    await plexPlays(env, token, movie("tt0137523", "Fight Club"));
    const before = await load(env, cred);
    await new Promise((r) => setTimeout(r, 5));
    const recordRaw = await env.CONFIGS.get(`creatorsynctracking:${cred.creatorName}`);
    const d1Before = env.DB.q("SELECT updated_at FROM creator_tracking_meta")[0].updated_at;

    await plexPlays(env, token, movie("tt0133093", "The Matrix"));

    // Put both copies of the record back to before that play: a D1 write that
    // failed, read through a KV edge that is a minute behind.
    await env.CONFIGS.put(`creatorsynctracking:${cred.creatorName}`, recordRaw);
    env.DB._db.prepare("DELETE FROM watch_history WHERE item_id = 'tt0133093'").run();
    env.DB._db.prepare("UPDATE creator_tracking_meta SET updated_at = ?").run(d1Before);

    const after = await load(env, cred);
    assert.deepEqual(whIds(after), ["tt0133093", "tt0137523"], "the queue no longer covers a lagging record");
    assert.ok(after.trackingUpdatedAt > before.trackingUpdatedAt);
  });

  it("ignores a queue written before the stamp existed once there is a record", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1(), TMDB_API_KEY: "test-tmdb-key" });
    const u = await createUser(env, "sqlegacy");
    const cred = { creatorName: u.creatorName, creatorKey: u.creatorKey };

    await push(env, cred, { watchHistory: [], continueWatching: [] }, {
      watchHistory: [{ id: "tt0133093", type: "movie", name: "The Matrix", watchedAt: 20 }],
    });
    // What the old code left behind: no recordUpdatedAt, holding a play the
    // owner has since removed.
    await env.CONFIGS.put(`creatorscrobblequeue:${cred.creatorName}`, JSON.stringify({
      watchHistory: [{ id: "tt0137523", type: "movie", name: "Fight Club", watchedAt: 10 }],
      continueWatching: [{ id: "101", type: "episode", showId: SHOW_IMDB, seasonNum: 1, episodeNum: 2 }],
    }));

    const loaded = await load(env, cred);
    assert.deepEqual(whIds(loaded), ["tt0133093"]);
    assert.deepEqual(cwShows(loaded), []);
  });
});
