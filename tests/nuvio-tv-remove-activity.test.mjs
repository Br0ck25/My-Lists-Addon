import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { activityBackfillStep, call, createUser, makeD1, makeEnv, nextIp } from "./harness.mjs";

// PERF-01 (audit 2026-11-10), third play route: a paired Nuvio TV reporting a watched title
// (POST /api/nuvio-tv/history) read the account's whole watch history and wrote it back, so one
// play cost work proportional to everything the account ever watched. With FF_DIRECT_PLAY it
// records the play directly (41_direct-play.js), at a cost that does not grow with the history.
// Every behaviour pin runs on BOTH paths and must give the same result.

const SHOW = "tt0903747";
const HEADERS = { "x-nuvio-client": "NuvioTVLauncher" };
const creds = (u) => ({ creatorName: u.creatorName, creatorKey: u.creatorKey });

let restoreFetch = null;
afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });
// No network: every TMDB lookup misses, so titles fall back to the ids.
function noTmdb() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 404 });
  restoreFetch = () => { globalThis.fetch = realFetch; };
}

async function setup({ direct, plays = 0, name }) {
  const env = makeEnv({
    DB: makeD1(), DB_ACTIVITY: makeD1({ schema: "activity" }),
    FF_EVENT_TRACKING: "1", FF_INSTALLS: "1", TMDB_API_KEY: "test-tmdb-key",
    ...(direct ? { FF_DIRECT_PLAY: "1" } : {}),
  });
  const user = await createUser(env, name);
  const accountId = env.DB._db.prepare("SELECT id FROM accounts WHERE username = ? COLLATE NOCASE").get(name).id;
  if (plays > 0) {
    const T = Date.parse("2026-01-01T00:00:00Z");
    await env.CONFIGS.put(`creatorsynctracking:${user.creatorName}`, JSON.stringify({
      updatedAt: T, trackPlayback: true,
      watchHistory: Array.from({ length: plays }, (_, i) => ({ id: `tt${4000000 + i}`, type: "movie", name: `Old ${i}`, watchedAt: T - i * 3600000 })),
    }));
    for (let i = 0; i < 1000; i++) {
      const r = await activityBackfillStep(env, { restart: false });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      if (r.body.done) break;
    }
  } else {
    env.DB._db.prepare("INSERT INTO jobs (type, dedupe_key, account_id, status, run_after, created_at, updated_at) VALUES ('migrate.activity', ?, ?, 'done', 0, 0, 0)").run(`migrate.activity:acct:${accountId}`, accountId);
  }
  const code = await call(env, "/api/nuvio-tv/device/code", { method: "POST", ip: nextIp() });
  const claim = await call(env, "/api/nuvio-tv/device/claim", { method: "POST", ip: nextIp(), json: { userCode: code.body.userCode, ...creds(user) } });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  // The first read after the switch stores the record's settings, as for any account in use.
  await call(env, "/api/creator/sync/load", { method: "POST", json: creds(user) });
  return { env, user, accountId, tv: claim.body.installId };
}

let clock = 0;
const realNow = Date.now;
afterEach(() => { Date.now = realNow; });
function tick(ms = 20 * 60 * 1000) { if (!clock) clock = realNow.call(Date); clock += ms; Date.now = () => clock; }

const post = (ctx, path, json) => call(ctx.env, path, { method: "POST", ip: nextIp(), headers: HEADERS, json: { targetId: ctx.tv, ...json } });
const add = async (ctx, json) => { tick(); const r = await post(ctx, "/api/nuvio-tv/history", { completed: true, progress: 95, watchedAt: Date.now(), ...json }); assert.equal(r.status, 200, JSON.stringify(r.body)); };
const watched = async (ctx) => (await post(ctx, "/api/nuvio-tv/watched", { action: "get" })).body;
const website = async (ctx) => (await call(ctx.env, "/api/creator/sync/load", { method: "POST", json: creds(ctx.user) })).body.data;
const events = (ctx) => ctx.env.DB_ACTIVITY._db.prepare("SELECT COUNT(*) AS c FROM watch_events").get().c;
const showStatus = (ctx) => (ctx.env.DB_ACTIVITY._db.prepare("SELECT status FROM show_progress").all()[0] || {}).status;

for (const direct of [false, true]) {
  describe(`TV history/remove undoes the play everywhere (${direct ? "FF_DIRECT_PLAY on" : "old path"})`, () => {
    it("a removed episode leaves /watched, the website's history and the activity database", async () => {
      noTmdb();
      const ctx = await setup({ direct, name: direct ? "rmdirect" : "rmold" });
      await add(ctx, { type: "series", contentId: `${SHOW}:1:1`, imdbId: SHOW, season: 1, episode: 1 });
      await add(ctx, { type: "series", contentId: `${SHOW}:1:2`, imdbId: SHOW, season: 1, episode: 2 });
      assert.deepEqual((await watched(ctx)).shows, [{ id: SHOW, complete: false, episodes: ["1:1", "1:2"] }]);
      // The show was finished: removing an episode un-finishes it.
      const rec = await website(ctx);
      await call(ctx.env, "/api/creator/sync/save-tracking", { method: "POST", json: { ...creds(ctx.user), ...rec, fullyWatchedShowIds: [SHOW], trackingUpdatedAt: undefined } });
      const before = (await website(ctx)).trackingUpdatedAt;
      tick();
      const r = await post(ctx, "/api/nuvio-tv/history/remove", { type: "series", contentId: `${SHOW}:1:2`, imdbId: SHOW, season: 1, episode: 2 });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual((await watched(ctx)).shows.map((s) => [s.id, s.complete, s.episodes]), [[SHOW, false, ["1:1"]]]);
      const site = await website(ctx);
      assert.deepEqual(site.watchHistory.map((x) => `${x.seasonNum}:${x.episodeNum}`), ["1:1"], "the website no longer lists the removed episode");
      assert.deepEqual(site.fullyWatchedShowIds, [], "an unfinished show is not fully watched");
      assert.ok(site.trackingUpdatedAt > before, "open tabs are told to refresh");
      assert.equal(events(ctx), 1, "its row in watch_events is gone");
      assert.notEqual(showStatus(ctx), "completed");
    });

    it("whole:true and a movie are removed from the activity database too", async () => {
      noTmdb();
      const ctx = await setup({ direct, name: direct ? "rmdirect2" : "rmold2" });
      await add(ctx, { type: "movie", contentId: "tt0137523", imdbId: "tt0137523" });
      await add(ctx, { type: "series", contentId: `${SHOW}:1:1`, imdbId: SHOW, season: 1, episode: 1 });
      await add(ctx, { type: "series", contentId: `${SHOW}:2:1`, imdbId: SHOW, season: 2, episode: 1 });
      assert.equal((await post(ctx, "/api/nuvio-tv/history/remove", { type: "series", imdbId: SHOW, whole: true })).status, 200);
      let w = await watched(ctx);
      assert.deepEqual([w.movies, w.shows], [["tt0137523"], []]);
      assert.equal(events(ctx), 1);
      assert.equal((await post(ctx, "/api/nuvio-tv/history/remove", { type: "movie", imdbId: "tt0137523" })).status, 200);
      w = await watched(ctx);
      assert.deepEqual([w.movies, w.shows], [[], []]);
      assert.equal(events(ctx), 0);
      assert.deepEqual((await website(ctx)).watchHistory, []);
    });
  });
}
