// Where each person stopped, recorded from the media server webhook (Plex, Jellyfin,
// Emby) and from Trakt's playback list, into watch_positions (activity migration A0003).
//
// The payload fields are the ones each service documents, not captured from a live
// server: Plex Metadata.viewOffset and Metadata.duration (milliseconds); the Jellyfin
// webhook plugin's PlaybackPositionTicks and RunTimeTicks, and Emby's
// PlaybackInfo.PositionTicks and Item.RunTimeTicks (100 ns ticks, 10,000 per
// millisecond); Trakt's /sync/playback progress (percent) with the runtime (minutes)
// that extended=full adds. Without a length nothing is stored: a length is never invented.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { call, createUser, makeD1, makeEnv, makeKv, nextIp, runScheduledTick } from "./harness.mjs";

let restore = null;
afterEach(() => { if (restore) restore(); restore = null; });

async function setup(name) {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1(), DB_ACTIVITY: makeD1({ schema: "activity" }) });
  const u = await createUser(env, name);
  const accountId = env.DB._db.prepare("SELECT id FROM accounts WHERE username = ? COLLATE NOCASE").get(name).id;
  env.DB._db.prepare("INSERT INTO jobs (type, dedupe_key, account_id, status, run_after, created_at, updated_at) VALUES ('migrate.activity', ?, ?, 'done', 0, 0, 0)").run(`migrate.activity:acct:${accountId}`, accountId);
  const cred = { creatorName: u.creatorName, creatorKey: u.creatorKey };
  const tok = await call(env, "/api/creator/scrobble-token", { method: "POST", ip: nextIp(), json: cred });
  return { env, accountId, token: tok.body.token };
}

const send = (ctx, payload) => call(ctx.env, "/api/scrobble?st=" + encodeURIComponent(ctx.token), { method: "POST", ip: nextIp(), json: payload });
const mainRows = (ctx) => {
  const imdb = new Map(ctx.env.DB._db.prepare("SELECT id, imdb_id FROM media").all().map((m) => [m.id, m.imdb_id]));
  return ctx.env.DB_ACTIVITY._db.prepare("SELECT source, media_id, season, episode, position_ms, duration_ms FROM watch_positions ORDER BY source, media_id").all()
    .map((r) => ({ source: r.source, imdb: imdb.get(r.media_id), season: r.season, episode: r.episode, position: r.position_ms, duration: r.duration_ms }));
};

const plexMovie = (event, viewOffset, duration) => ({ event, Account: { title: "owner" }, Metadata: { type: "movie", title: "Movie P", guid: "imdb://tt1010101", Guid: [{ id: "imdb://tt1010101" }], ...(viewOffset != null ? { viewOffset } : {}), ...(duration != null ? { duration } : {}) } });

describe("positions from the media server webhook", () => {
  it("Plex: keeps the viewOffset and duration of a paused movie, replaces it, and drops it when finished", async () => {
    const ctx = await setup("posplex");
    const r = await send(ctx, plexMovie("media.pause", 1800000, 7200000));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(mainRows(ctx), [{ source: "plex", imdb: "tt1010101", season: null, episode: null, position: 1800000, duration: 7200000 }]);
    await send(ctx, plexMovie("media.stop", 3600000, 7200000));
    assert.deepEqual(mainRows(ctx).map((r) => r.position), [3600000], "one point per title");
    await send(ctx, plexMovie("media.scrobble", 6800000, 7200000));
    assert.deepEqual(mainRows(ctx), [], "90% or more is finished");
  });

  it("Plex: an episode keeps its season and episode; a start at the very beginning stores nothing", async () => {
    const ctx = await setup("posplex2");
    await send(ctx, { event: "media.pause", Account: { title: "owner" }, Metadata: { type: "episode", title: "Ep", grandparentTitle: "Show E", parentIndex: 2, index: 5, grandparentGuid: "imdb://tt2020202", viewOffset: 600000, duration: 2400000 } });
    assert.deepEqual(mainRows(ctx).map((r) => [r.imdb, r.season, r.episode, r.position, r.duration]), [["tt2020202", 2, 5, 600000, 2400000]]);
    const ctx2 = await setup("posplex3");
    await send(ctx2, plexMovie("media.play", 1000, 7200000));
    assert.deepEqual(mainRows(ctx2), []);
  });

  it("stores no position without a length, and never makes one up", async () => {
    const ctx = await setup("posnolen");
    await send(ctx, plexMovie("media.pause", 1800000, null));
    assert.deepEqual(mainRows(ctx), []);
  });

  it("Jellyfin: converts ticks to milliseconds", async () => {
    const ctx = await setup("posjelly");
    const r = await send(ctx, { NotificationType: "PlaybackStop", ItemType: "Movie", Name: "Movie J", NotificationUsername: "owner", Provider_imdb: "tt3030303", PlaybackPositionTicks: 18000000000, RunTimeTicks: 72000000000 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(mainRows(ctx), [{ source: "jellyfin", imdb: "tt3030303", season: null, episode: null, position: 1800000, duration: 7200000 }]);
  });

  it("Emby: reads PlaybackInfo.PositionTicks and Item.RunTimeTicks", async () => {
    const ctx = await setup("posemby");
    const r = await send(ctx, { Event: "playback.stop", User: { Name: "owner" }, Item: { Type: "Movie", Name: "Movie E", ProviderIds: { Imdb: "tt4040404" }, RunTimeTicks: 72000000000 }, PlaybackInfo: { PositionTicks: 36000000000, PlayedToCompletion: false } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(mainRows(ctx), [{ source: "emby", imdb: "tt4040404", season: null, episode: null, position: 3600000, duration: 7200000 }]);
  });
});

describe("positions from Trakt, sent on to Nuvio", () => {
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const TEST_KEY = "k1:" + Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => 120 + i)).toString("base64");
  const PAUSED = "2026-11-08T20:00:00.000Z";
  const playback = () => [
    { id: 1, progress: 25, paused_at: PAUSED, type: "movie", movie: { title: "Movie T", year: 2020, runtime: 120, ids: { trakt: 11, imdb: "tt5050505", tmdb: 50 } } },
    { id: 2, progress: 50, paused_at: PAUSED, type: "episode", episode: { season: 1, number: 3, runtime: 40, ids: { trakt: 22 } }, show: { title: "Show T", ids: { trakt: 33, imdb: "tt6060606" } } },
    { id: 3, progress: 30, paused_at: PAUSED, type: "movie", movie: { title: "No Length", ids: { trakt: 44, imdb: "tt7070707" } } },
    { id: 4, progress: 95, paused_at: PAUSED, type: "movie", movie: { title: "Nearly Done", runtime: 100, ids: { trakt: 55, imdb: "tt8080808" } } },
  ];

  async function ready(name, rowsFromTrakt) {
    const real = globalThis.fetch;
    const seen = { progressPushed: [], traktUrls: [] };
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      const body = init.body ? JSON.parse(init.body) : {};
      if (url.hostname === "api.trakt.tv" && url.pathname === "/users/me") return json({ username: "viewer" });
      if (url.hostname === "api.trakt.tv" && url.pathname === "/sync/playback") { seen.traktUrls.push(url.search); return json(rowsFromTrakt); }
      if (url.hostname === "api.nuvio.tv") {
        if (url.pathname === "/auth/v1/token") return json({ access_token: "ACCESS-1", refresh_token: "REFRESH-1", expires_in: 3600, user: { id: "u1", email: "viewer@example.test" } });
        if (url.pathname.startsWith("/rest/v1/rpc/")) {
          const fn = url.pathname.split("/").pop();
          if (fn === "sync_pull_profiles") return json([{ profile_index: 1, name: "Main" }]);
          if (["sync_pull_watched_items", "sync_pull_watch_progress", "sync_pull_library", "sync_pull_library_delta"].includes(fn)) return json([]);
          if (fn === "sync_get_library_delta_cursor") return json(0);
          if (fn === "sync_push_watch_progress") { seen.progressPushed.push(...body.p_entries); return new Response(null, { status: 204 }); }
          return new Response(null, { status: 204 });
        }
      }
      return new Response("{}", { status: 404 });
    };
    restore = () => { globalThis.fetch = real; };
    const env = makeEnv({ DB: makeD1(), DB_ACTIVITY: makeD1({ schema: "activity" }), TOKEN_ENCRYPTION_KEY: TEST_KEY, FF_MEDIA_APP_PUSH: "1" });
    const u = await createUser(env, name);
    const session = await call(env, "/api/session", { method: "POST", json: { username: name, key: u.creatorKey } });
    const cookie = (session.headers.get("set-cookie") || "").split(";")[0];
    const accountId = env.DB._db.prepare("SELECT id FROM accounts WHERE username = ? COLLATE NOCASE").get(name).id;
    env.DB._db.prepare("INSERT INTO jobs (type, dedupe_key, account_id, status, run_after, created_at, updated_at) VALUES ('migrate.activity', ?, ?, 'done', 0, 0, 0)").run(`migrate.activity:acct:${accountId}`, accountId);
    const imported = await call(env, "/api/connections/import-local", { method: "POST", cookie, json: { keys: { traktAccessToken: "TRAKT-TOKEN", traktKey: "trakt-client", traktUsername: "viewer" } } });
    assert.equal(imported.body.results.trakt, "imported", JSON.stringify(imported.body));
    await call(env, "/api/connections/nuvio/login", { method: "POST", cookie, json: { email: "viewer@example.test", password: "right-password" } });
    const ctx = { env, accountId, cookie, seen };
    await settle(ctx);
    await call(env, "/api/connections/nuvio/settings", { method: "POST", cookie, json: { push: true } });
    await settle(ctx);
    return ctx;
  }
  async function settle(ctx) {
    for (let i = 0; i < 4; i++) {
      ctx.env.DB._db.exec("UPDATE jobs SET run_after = 1 WHERE type = 'mediaapp.sync-account' AND status = 'queued'");
      await runScheduledTick(ctx.env);
    }
  }
  const again = async (ctx) => {
    await call(ctx.env, "/api/connections/nuvio/sync", { method: "POST", cookie: ctx.cookie, json: {} });
    await settle(ctx);
  };

  it("asks Trakt for the runtime, stores each position with a length, and sends them to Nuvio once", async () => {
    const ctx = await ready("postrakt", playback());
    await again(ctx);
    assert.ok(ctx.seen.traktUrls.some((q) => q.includes("extended=full")), "the runtime comes with extended=full");
    assert.deepEqual(mainRows(ctx).filter((r) => r.source === "trakt").map((r) => [r.imdb, r.season, r.episode, r.position, r.duration]), [
      ["tt5050505", null, null, 1800000, 7200000],
      ["tt6060606", 1, 3, 1200000, 2400000],
    ], "no length (tt7070707) and finished (tt8080808) are not stored");
    const pushed = ctx.seen.progressPushed.map((e) => [e.content_id, e.video_id, e.position, e.duration, e.last_watched]);
    assert.deepEqual(pushed, [
      ["tt5050505", "tt5050505", 1800000, 7200000, Date.parse(PAUSED)],
      ["tt6060606", "tt6060606:1:3", 1200000, 2400000, Date.parse(PAUSED)],
    ]);
    await again(ctx);
    assert.equal(ctx.seen.progressPushed.length, 2, "each position is sent once");
  });

  it("does not ask Trakt unless two-way sync is on", async () => {
    const ctx = await ready("postrakt2", playback());
    await call(ctx.env, "/api/connections/nuvio/settings", { method: "POST", cookie: ctx.cookie, json: { push: false } });
    ctx.seen.traktUrls.length = 0;
    await again(ctx);
    assert.equal(ctx.seen.traktUrls.length, 0);
  });
});
