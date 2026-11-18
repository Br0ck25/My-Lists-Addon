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
function tick(ms = 20 * 60 * 1000) {
  if (!clock) clock = realNow.call(Date);
  clock += ms;
  Date.now = () => clock;
}

async function tvPlay(ctx, body) {
  tick();
  const r = await call(ctx.env, "/api/nuvio-tv/history", { method: "POST", ip: nextIp(), headers: HEADERS, json: { targetId: ctx.tv, completed: true, progress: 95, ...body } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.success, true);
}
const movie = (ctx, id, extra = {}) => tvPlay(ctx, { type: "movie", contentId: id, imdbId: id, watchedAt: Date.now() + 1, ...extra });
const episode = (ctx, season, ep, extra = {}) => tvPlay(ctx, { type: "series", contentId: `${SHOW}:${season}:${ep}`, imdbId: SHOW, season, episode: ep, ...extra });

async function snapshot(ctx) {
  const data = (await call(ctx.env, "/api/creator/sync/load", { method: "POST", json: creds(ctx.user) })).body.data;
  const label = (it) => `${it.showId || it.id}:${it.seasonNum ?? ""}:${it.episodeNum ?? ""}`;
  const status = {};
  const imdbOf = (id) => (ctx.env.DB._db.prepare("SELECT imdb_id FROM media WHERE id = ?").get(id) || {}).imdb_id;
  for (const r of ctx.env.DB_ACTIVITY._db.prepare("SELECT media_id, status FROM show_progress").all()) status[imdbOf(r.media_id)] = r.status;
  return { history: data.watchHistory.slice(0, 6).map(label), cw: data.continueWatching.map(label), fullyWatched: [...data.fullyWatchedShowIds], status, watchlist: (data.watchlist || []).map((x) => x.id), updatedAt: data.trackingUpdatedAt };
}
const events = (ctx) => ctx.env.DB_ACTIVITY._db.prepare("SELECT COUNT(*) AS c FROM watch_events").get().c;

for (const direct of [false, true]) {
  describe(`PERF-01 Nuvio TV history add: behaviours kept (${direct ? "FF_DIRECT_PLAY on" : "old path"})`, () => {
    it("an episode lands in Watch History newest first, and counts one play", async () => {
      noTmdb();
      const ctx = await setup({ direct, name: "tvep" + direct });
      await episode(ctx, 1, 1);
      await episode(ctx, 1, 2);
      const s = await snapshot(ctx);
      assert.deepEqual(s.history.slice(0, 2), [`${SHOW}:1:2`, `${SHOW}:1:1`]);
      assert.equal(events(ctx), 2, "two episodes, two plays");
    });

    it("a movie lands in Watch History with the TV's watched time", async () => {
      noTmdb();
      const ctx = await setup({ direct, name: "tvmovie" + direct });
      const at = Date.parse("2026-03-04T05:06:07Z");
      await movie(ctx, "tt0137523", { watchedAt: at });
      const s = await snapshot(ctx);
      assert.deepEqual(s.history, ["tt0137523::"]);
      assert.equal(ctx.env.DB_ACTIVITY._db.prepare("SELECT MAX(watched_at) AS t FROM watch_events").get().t, at);
    });

    it("a play takes the show off Continue Watching", async () => {
      noTmdb();
      const ctx = await setup({ direct, name: "tvcw" + direct });
      const load = (await call(ctx.env, "/api/creator/sync/load", { method: "POST", json: creds(ctx.user) })).body.data;
      const saved = await call(ctx.env, "/api/creator/sync/save-tracking", {
        method: "POST", json: { ...creds(ctx.user), ...load, updatedAt: Date.now() + 1000, expectedClientVersion: load.trackingClientVersion,
          continueWatching: [{ id: `${SHOW}:1:1`, type: "episode", showId: SHOW, showTitle: "S", seasonNum: 1, episodeNum: 1 }] },
      });
      assert.equal(saved.body.ok, true, JSON.stringify(saved.body));
      assert.deepEqual((await snapshot(ctx)).cw, [`${SHOW}:1:1`]);
      await episode(ctx, 1, 1);
      const s = await snapshot(ctx);
      assert.deepEqual(s.cw, [], "the show's Continue Watching entry is gone");
    });

    it("a finished show stays finished and an unfinished one stays unfinished", async () => {
      noTmdb();
      const ctx = await setup({ direct, name: "tvfin" + direct });
      await episode(ctx, 1, 1);
      assert.notEqual((await snapshot(ctx)).status[SHOW], "completed");
      const load = (await call(ctx.env, "/api/creator/sync/load", { method: "POST", json: creds(ctx.user) })).body.data;
      await call(ctx.env, "/api/creator/sync/save-tracking", {
        method: "POST", json: { ...creds(ctx.user), ...load, fullyWatchedShowIds: [SHOW], updatedAt: Date.now() + 1000, expectedClientVersion: load.trackingClientVersion },
      });
      await episode(ctx, 1, 2);
      const s = await snapshot(ctx);
      assert.deepEqual(s.fullyWatched, [SHOW]);
      assert.equal(s.status[SHOW], "completed");
    });

    it("the record's updated stamp moves, so other tabs reload", async () => {
      noTmdb();
      const ctx = await setup({ direct, name: "tvstamp" + direct });
      const meta = async () => (await call(ctx.env, "/api/creator/sync/meta", { method: "POST", json: creds(ctx.user) })).body;
      const before = await meta();
      await movie(ctx, "tt0111161");
      const after = await meta();
      assert.ok(after.tracking > before.tracking, `stamp ${after.tracking} must exceed ${before.tracking}`);
      assert.equal(after.tracking, (await snapshot(ctx)).updatedAt, "meta and load agree");
    });
  });
}

// Reads of the account's whole watch_events (no LIMIT, only the account id).
function countFullReads(env) {
  const seen = { n: 0, statements: 0 };
  const prep = env.DB_ACTIVITY.prepare.bind(env.DB_ACTIVITY);
  env.DB_ACTIVITY.prepare = (sql, ...a) => {
    seen.statements++;
    const s = String(sql).trim();
    if (/FROM watch_events/i.test(s) && !/\bLIMIT\b/i.test(s) && /WHERE (w\.|e\.)?account_id = \?\s*(ORDER BY[^;]*)?$/i.test(s)) seen.n++;
    return prep(sql, ...a);
  };
  return seen;
}

describe("PERF-01 Nuvio TV history add: the cost of one play does not grow with the history", () => {
  for (const kind of ["movie", "episode"]) {
    it(`${kind}: 200 and 3,200 plays cost the same, with no full history read, and no play is dropped`, { timeout: 240000 }, async () => {
      noTmdb();
      const cost = {};
      for (const plays of [200, 3200]) {
        const ctx = await setup({ direct: true, plays, name: `tvcost${kind}${plays}` });
        const seen = countFullReads(ctx.env);
        let kvTrackingGets = 0;
        const kvGet = ctx.env.CONFIGS.get.bind(ctx.env.CONFIGS);
        ctx.env.CONFIGS.get = async (k, ...r) => { if (String(k).startsWith("creatorsynctracking:")) kvTrackingGets++; return kvGet(k, ...r); };
        if (kind === "movie") await movie(ctx, "tt0111161"); else await episode(ctx, 1, 1);
        cost[plays] = { fullReads: seen.n, statements: seen.statements, kvTrackingGets };
        assert.equal(events(ctx), plays + 1, `all ${plays} old plays kept and the new one recorded`);
        assert.equal((await snapshot(ctx)).history[0], kind === "movie" ? "tt0111161::" : `${SHOW}:1:1`);
      }
      assert.equal(cost[3200].fullReads, 0, `read the whole history ${cost[3200].fullReads} times`);
      assert.equal(cost[3200].kvTrackingGets, 0, "asked for the whole assembled record");
      assert.equal(cost[3200].statements, cost[200].statements, `activity statements grew with history: ${JSON.stringify(cost)}`);
      assert.ok(cost[3200].statements <= 12, `a play made ${cost[3200].statements} activity statements`);
    });
  }

  it("old path (FF_DIRECT_PLAY unset), for contrast: the same play does read the whole history", async () => {
    noTmdb();
    const ctx = await setup({ direct: false, plays: 200, name: "tvcostold" });
    const seen = countFullReads(ctx.env);
    await movie(ctx, "tt0111161");
    assert.ok(seen.n >= 1, "the counter must see the old path's full reads, or the test above guards nothing");
  });
});
