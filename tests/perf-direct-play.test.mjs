import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { activityBackfillStep, call, createUser, makeD1, makeEnv, nextIp } from "./harness.mjs";

// PERF-01 (audit 2026-11-10): recording one play for an account on the activity database
// re-read and re-diffed the account's whole watch history (303 statements at 5,000 plays).
// With FF_DIRECT_PLAY the Plex/Jellyfin/Emby webhook and the Stremio/Nuvio ping record the
// play directly, at a cost that does not grow with the history.
//
// The old way also did three things recordActivityPlay alone does not. Each is pinned here
// with the result the old way gave, and every pin runs on BOTH paths:
//   1. next episode / fully watched: the next aired episode goes into Continue Watching, a
//      show with nothing ahead is marked completed (show_progress.status), and a completed
//      show with a next episode is un-completed;
//   2. the first play of a show puts its next episode into Continue Watching straight away
//      (the schedule job only fills it in later);
//   3. the record's own updatedAt moves, which is what other open tabs poll (sync/meta).

const SHOW_IMDB = "tt0944947";
const OTHER_IMDB = "tt0386676";
const creds = (u) => ({ creatorName: u.creatorName, creatorKey: u.creatorKey });

let restoreFetch = null;
afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

// TMDB with two shows: SHOW has 3 aired episodes in season 1 and nothing after, OTHER has 3.
function fakeTmdb() {
  const realFetch = globalThis.fetch;
  const shows = {
    [SHOW_IMDB]: { id: 1399, name: "Show A", poster_path: "/a.jpg" },
    [OTHER_IMDB]: { id: 2316, name: "Show B", poster_path: "/b.jpg" },
  };
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname !== "api.themoviedb.org") return new Response("{}", { status: 404 });
    const p = url.pathname;
    const find = p.match(/^\/3\/find\/(tt\d+)$/);
    if (find) return Response.json({ tv_results: shows[find[1]] ? [{ ...shows[find[1]], first_air_date: "2011-04-17" }] : [], movie_results: [], tv_episode_results: [] });
    for (const [imdb, s] of Object.entries(shows)) {
      if (p === `/3/tv/${s.id}`) return Response.json({ ...s, first_air_date: "2011-04-17", external_ids: { imdb_id: imdb }, number_of_seasons: 1, seasons: [{ season_number: 1, episode_count: 3 }] });
      if (p === `/3/tv/${s.id}/season/1`) {
        return Response.json({ season_number: 1, episodes: [1, 2, 3].map((n) => ({ id: s.id * 100 + n, episode_number: n, season_number: 1, name: `Episode ${n}`, air_date: "2011-04-1" + n })) });
      }
    }
    return new Response("{}", { status: 404 });
  };
  restoreFetch = () => { globalThis.fetch = realFetch; };
}

async function setup({ direct, plays = 0, name = "directplay" }) {
  const env = makeEnv({
    DB: makeD1(), DB_ACTIVITY: makeD1({ schema: "activity" }),
    FF_EVENT_TRACKING: "1", FF_SHOW_SCHEDULE: "1", TMDB_API_KEY: "test-tmdb-key",
    ...(direct ? { FF_DIRECT_PLAY: "1" } : {}),
  });
  const user = await createUser(env, name);
  const accountId = env.DB._db.prepare("SELECT id FROM accounts WHERE username = ? COLLATE NOCASE").get(name).id;
  const config = "cfgdirect1";
  await env.CONFIGS.put(`cfg:${config}`, JSON.stringify({
    track: true, trackCreatorName: user.creatorName, trackCreatorKey: user.creatorKey, showBadgesStremio: false, tmdbKey: "test-tmdb-key",
    entries: [{ id: "wh", type: "movie", name: "Watch History", url: `autotrack:watch-history:movie:${user.creatorName}` }],
  }));
  if (plays > 0) {
    // The account's old history lives in the legacy record, then is copied for real.
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
  const tok = await call(env, "/api/creator/scrobble-token", { method: "POST", ip: nextIp(), json: creds(user) });
  // The first read after the switch assembles and stores the record's settings; accounts
  // that have been in use have it, and the direct path relies on it.
  await call(env, "/api/creator/sync/load", { method: "POST", json: creds(user) });
  return { env, user, accountId, config, token: tok.body.token };
}

let clock = 0;
const realNow = Date.now;
afterEach(() => { Date.now = realNow; });
function tick(ms = 20 * 60 * 1000) {
  if (!clock) clock = realNow.call(Date);
  clock += ms;
  Date.now = () => clock;
}

// One finished episode, reported the way each source does.
async function playEpisode(ctx, via, imdb, season, episode) {
  tick();
  if (via === "ping") {
    const r = await call(ctx.env, `/${ctx.config}/subtitles/series/${imdb}:${season}:${episode}.json`, { ip: nextIp() });
    assert.equal(r.status, 200);
    const diag = JSON.parse(await ctx.env.CONFIGS.get(`creatortrack:${ctx.user.creatorName}`));
    assert.match(diag.matched, /^yes/, diag.matched);
    return;
  }
  const r = await call(ctx.env, "/api/scrobble?st=" + encodeURIComponent(ctx.token), {
    method: "POST", ip: nextIp(),
    json: { NotificationType: "PlaybackStop", PlayedToCompletion: true, ItemType: "Episode", SeriesName: imdb === SHOW_IMDB ? "Show A" : "Show B", Name: `Episode ${episode}`,
      SeasonNumber: season, EpisodeNumber: episode, SeriesProviderIds: { Imdb: imdb }, NotificationUsername: "owner" },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(String(r.body.matched), /^yes/, JSON.stringify(r.body));
}

async function playMovie(ctx, via, imdb) {
  tick();
  if (via === "ping") {
    const r = await call(ctx.env, `/${ctx.config}/subtitles/movie/${imdb}.json`, { ip: nextIp() });
    assert.equal(r.status, 200);
    return;
  }
  const r = await call(ctx.env, "/api/scrobble?st=" + encodeURIComponent(ctx.token), {
    method: "POST", ip: nextIp(),
    json: { NotificationType: "PlaybackStop", PlayedToCompletion: true, ItemType: "Movie", Name: "A Movie", Provider_imdb: imdb, NotificationUsername: "owner" },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

// What the website's own load shows, and the stored show state.
async function snapshot(ctx) {
  const data = (await call(ctx.env, "/api/creator/sync/load", { method: "POST", json: creds(ctx.user) })).body.data;
  const label = (it) => `${it.showId || it.id}:${it.seasonNum ?? ""}:${it.episodeNum ?? ""}`;
  const status = {};
  const imdbOf = (id) => (ctx.env.DB._db.prepare("SELECT imdb_id FROM media WHERE id = ?").get(id) || {}).imdb_id;
  for (const r of ctx.env.DB_ACTIVITY._db.prepare("SELECT media_id, status FROM show_progress").all()) status[imdbOf(r.media_id)] = r.status;
  return { history: data.watchHistory.slice(0, 6).map(label), cw: data.continueWatching.map(label), fullyWatched: [...data.fullyWatchedShowIds], status, updatedAt: data.trackingUpdatedAt };
}

const meta = async (ctx) => (await call(ctx.env, "/api/creator/sync/meta", { method: "POST", json: creds(ctx.user) })).body;

for (const direct of [false, true]) {
  for (const via of ["webhook", "ping"]) {
    describe(`PERF-01 behaviours kept (${direct ? "FF_DIRECT_PLAY on" : "old path"}, ${via})`, () => {
      it("next episode: a play puts the next aired episode into Continue Watching", async () => {
        fakeTmdb();
        const ctx = await setup({ direct, name: "nextep" + via });
        await playEpisode(ctx, via, SHOW_IMDB, 1, 1);
        await playEpisode(ctx, via, SHOW_IMDB, 1, 2);
        const s = await snapshot(ctx);
        assert.deepEqual(s.history.slice(0, 2), [`${SHOW_IMDB}:1:2`, `${SHOW_IMDB}:1:1`]);
        assert.deepEqual(s.cw, [`${SHOW_IMDB}:1:3`], "Continue Watching offers episode 3 only, not the episode just seen");
        assert.deepEqual(s.fullyWatched, []);
        assert.notEqual(s.status[SHOW_IMDB], "completed");
      });

      it("fully watched: the last episode marks the show completed and takes it off Continue Watching", async () => {
        fakeTmdb();
        const ctx = await setup({ direct, name: "fullywatched" + via });
        await playEpisode(ctx, via, SHOW_IMDB, 1, 2);
        await playEpisode(ctx, via, SHOW_IMDB, 1, 3);
        const s = await snapshot(ctx);
        assert.deepEqual(s.fullyWatched, [SHOW_IMDB]);
        assert.equal(s.status[SHOW_IMDB], "completed", "the stored show state is completed");
        assert.deepEqual(s.cw.filter((x) => x.startsWith(SHOW_IMDB)), []);
      });

      it("playing an earlier episode leaves the show where its furthest episode put it", async () => {
        fakeTmdb();
        const ctx = await setup({ direct, name: "earlier" + via });
        await playEpisode(ctx, via, SHOW_IMDB, 1, 2);
        await playEpisode(ctx, via, SHOW_IMDB, 1, 3);
        await playEpisode(ctx, via, SHOW_IMDB, 1, 1);
        const s = await snapshot(ctx);
        assert.deepEqual(s.fullyWatched, [SHOW_IMDB], "still finished: episode 3 is the furthest watched");
        assert.equal(s.status[SHOW_IMDB], "completed");
        assert.deepEqual(s.cw.filter((x) => x.startsWith(SHOW_IMDB)), [], "no pointer back to episode 2");
        assert.equal(s.history[0], `${SHOW_IMDB}:1:1`);
      });

      it("a completed show with an episode ahead is un-completed by the next play", async () => {
        fakeTmdb();
        const ctx = await setup({ direct, name: "uncomplete" + via });
        // The website marked Show B watched; its first episode played now has two more after it.
        const load = (await call(ctx.env, "/api/creator/sync/load", { method: "POST", json: creds(ctx.user) })).body.data;
        const saved = await call(ctx.env, "/api/creator/sync/save-tracking", {
          method: "POST", json: { ...creds(ctx.user), ...load, fullyWatchedShowIds: [OTHER_IMDB], updatedAt: Date.now() + 1000, expectedClientVersion: load.trackingClientVersion },
        });
        assert.equal(saved.body.ok, true, JSON.stringify(saved.body));
        assert.equal((await snapshot(ctx)).fullyWatched.includes(OTHER_IMDB), true);
        await playEpisode(ctx, via, OTHER_IMDB, 1, 1);
        const s = await snapshot(ctx);
        assert.deepEqual(s.fullyWatched, [], "no longer fully watched");
        assert.deepEqual(s.cw, [`${OTHER_IMDB}:1:2`]);
        assert.notEqual(s.status[OTHER_IMDB], "completed");
      });

      it("the first play of a show gives it a Continue Watching entry at once", async () => {
        fakeTmdb();
        const ctx = await setup({ direct, name: "firstplay" + via });
        assert.deepEqual((await snapshot(ctx)).cw, []);
        await playEpisode(ctx, via, OTHER_IMDB, 1, 1);
        const s = await snapshot(ctx);
        assert.deepEqual(s.cw, [`${OTHER_IMDB}:1:2`], "no waiting for the schedule job");
        const cw = (await call(ctx.env, "/api/creator/sync/load", { method: "POST", json: creds(ctx.user) })).body.data.continueWatching[0];
        assert.equal(cw.showTitle, "Show B");
        assert.match(String(cw.showPoster || cw.poster), /\/b\.jpg$/);
      });

      it("the record's updated stamp moves, so other tabs reload", async () => {
        fakeTmdb();
        const ctx = await setup({ direct, name: "stamp" + via });
        const before = await meta(ctx);
        await playEpisode(ctx, via, SHOW_IMDB, 1, 1);
        const after = await meta(ctx);
        assert.ok(after.tracking > Date.now() - 60 * 60 * 1000, "the stamp is the time of the play");
        assert.ok(after.tracking > before.tracking, `stamp ${after.tracking} must exceed ${before.tracking}`);
        assert.equal(after.tracking, (await snapshot(ctx)).updatedAt, "meta and load agree, so an idle tab does not reload forever");
      });

      it("a movie play lands in Watch History once and counts one play", async () => {
        fakeTmdb();
        const ctx = await setup({ direct, name: "movie" + via });
        await playMovie(ctx, via, "tt0111161");
        const s = await snapshot(ctx);
        assert.deepEqual(s.history, ["tt0111161::"]);
        assert.equal(ctx.env.DB_ACTIVITY._db.prepare("SELECT COUNT(*) AS c FROM watch_events").get().c, 1);
        assert.equal(ctx.env.DB_ACTIVITY._db.prepare("SELECT watched_count AS c FROM user_media_state").get().c, 1);
      });
    });
  }
}

describe("PERF-01: what the direct path leaves to the old one", () => {
  it("an account whose settings were never stored yet still records the play (old path migrates)", async () => {
    fakeTmdb();
    const ctx = await setup({ direct: true, name: "nosettings" });
    ctx.env.DB._db.prepare("DELETE FROM account_settings").run();
    await playEpisode(ctx, "webhook", SHOW_IMDB, 1, 1);
    assert.deepEqual((await snapshot(ctx)).cw, [`${SHOW_IMDB}:1:2`]);
  });

  it("an account not yet copied to the activity database stays on the old path", async () => {
    fakeTmdb();
    const ctx = await setup({ direct: true, name: "notcopied" });
    ctx.env.DB._db.prepare("DELETE FROM jobs WHERE type = 'migrate.activity'").run();
    ctx.env.DB._db.prepare("DELETE FROM account_settings").run();
    await playEpisode(ctx, "webhook", SHOW_IMDB, 1, 1);
    assert.equal(ctx.env.DB_ACTIVITY._db.prepare("SELECT COUNT(*) AS c FROM watch_events").get().c, 0, "nothing written to the activity database");
    assert.ok(await ctx.env.CONFIGS.get(`creatorsynctracking:${ctx.user.creatorName}`), "the legacy record got the play");
  });

  it("the switch is off by default, and FF_DIRECT_PLAY=0 turns it off", async () => {
    fakeTmdb();
    for (const value of [undefined, "0"]) {
      const ctx = await setup({ direct: false, name: "sw" + String(value), plays: 40 });
      if (value !== undefined) ctx.env.FF_DIRECT_PLAY = value;
      const reads = countFullReads(ctx.env);
      await playMovie(ctx, "webhook", "tt0111161");
      assert.ok(reads.n >= 1, `FF_DIRECT_PLAY=${value}: the old path reads the whole history`);
    }
  });
});

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

describe("PERF-01: the cost of one play does not grow with the history", () => {
  for (const via of ["webhook", "ping"]) {
    it(`${via}: 200 and 3,200 plays cost the same, with no full history read, and no play is dropped`, { timeout: 240000 }, async () => {
      fakeTmdb();
      const cost = {};
      for (const plays of [200, 3200]) {
        const ctx = await setup({ direct: true, plays, name: `cost${via}${plays}` });
        const seen = countFullReads(ctx.env);
        let kvTrackingGets = 0;
        const kvGet = ctx.env.CONFIGS.get.bind(ctx.env.CONFIGS);
        ctx.env.CONFIGS.get = async (k, ...r) => { if (String(k).startsWith("creatorsynctracking:")) kvTrackingGets++; return kvGet(k, ...r); };
        await playMovie(ctx, via, "tt0111161");
        cost[plays] = { fullReads: seen.n, statements: seen.statements, kvTrackingGets };
        const events = ctx.env.DB_ACTIVITY._db.prepare("SELECT COUNT(*) AS c FROM watch_events").get().c;
        assert.equal(events, plays + 1, `all ${plays} old plays kept and the new one recorded`);
        assert.equal((await snapshot(ctx)).history[0], "tt0111161::");
      }
      assert.equal(cost[3200].fullReads, 0, `read the whole history ${cost[3200].fullReads} times`);
      assert.equal(cost[3200].kvTrackingGets, 0, "asked for the whole assembled record");
      assert.equal(cost[3200].statements, cost[200].statements, `activity statements grew with history: ${JSON.stringify(cost)}`);
      assert.ok(cost[3200].statements <= 12, `a play made ${cost[3200].statements} activity statements`);
    });
  }

  it("old path, for contrast: the same play does read the whole history (guards the counter)", async () => {
    fakeTmdb();
    const ctx = await setup({ direct: false, plays: 200, name: "costold" });
    const seen = countFullReads(ctx.env);
    await playMovie(ctx, "webhook", "tt0111161");
    assert.ok(seen.n >= 1, "the counter must see the old path's full reads, or the test above guards nothing");
  });
});
