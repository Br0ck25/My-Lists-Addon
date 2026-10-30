// Stremio and Nuvio accounts (61_media-app-sync.js): connect, then pull the
// real watch history and Continue Watching into the activity database.
//
// Through the real Worker, with both services faked. The fakes follow the
// calls the services' own apps make (stremio-core's library item, Nuvio's
// Supabase RPCs as the NuvioTV docs name their fields): they were not captured
// from a live account, so tests/media-app-sync.test.mjs is where a changed
// shape shows up first. TMDB has no key here, so a title becomes a stub row
// with its IMDb id, which is all these tests need.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { deflateSync, inflateSync } from "node:zlib";

import { call, createUser, makeD1, makeEnv, makeQueue, runScheduledTick } from "./harness.mjs";

const TEST_KEY = "k1:" + Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => 120 + i)).toString("base64");
const HOUR = 3600 * 1000;
const NOW = Date.now();

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let restore = null;
afterEach(() => { if (restore) restore(); restore = null; });

// --- The fakes ---------------------------------------------------------------

function fakeServices(state) {
  const seen = { stremio: [], nuvio: [], nuvioRefresh: [], nuvioSignIns: [], cinemeta: [], puts: [], pushed: [] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const href = typeof input === "string" ? input : input.url;
    const url = new URL(href);
    const body = init.body ? JSON.parse(init.body) : {};
    if (url.hostname === "api.strem.io") {
      const method = url.pathname.replace("/api/", "");
      seen.stremio.push(method);
      if (state.stremioDown) return new Response("down", { status: state.stremioDown });
      if (body.authKey !== "AUTHKEY-SECRET") return json({ error: { message: "Session does not exist" } });
      if (method === "getUser") return json({ result: { _id: "u1", email: "viewer@example.test" } });
      if (method === "logout") return json({ result: { success: true } });
      if (method === "datastoreGet") return json({ result: state.library });
      if (method === "datastorePut") {
        seen.puts.push(body.changes);
        if (state.putFails) return json({ result: { success: false } });
        for (const c of body.changes) {
          const i = state.library.findIndex((x) => x._id === c._id);
          if (i >= 0) state.library[i] = c;
        }
        return json({ result: { success: true } });
      }
    }
    if (url.hostname === "v3-cinemeta.strem.io") {
      const id = url.pathname.split("/").pop().replace(".json", "");
      seen.cinemeta.push(id);
      const eps = state.episodes[id];
      return eps ? json({ meta: { videos: eps } }) : json({}, 404);
    }
    if (url.hostname === "api.nuvio.tv") {
      if (url.pathname === "/auth/v1/token") {
        const grant = url.searchParams.get("grant_type");
        if (grant === "password") {
          seen.nuvioSignIns.push(body);
          if (body.password !== "right-password") return json({ error_code: "invalid_credentials" }, 400);
          state.nuvioToken = "ACCESS-1";
          state.nuvioRefresh = "REFRESH-1";
          return json({ access_token: "ACCESS-1", refresh_token: "REFRESH-1", expires_in: 3600, user: { id: "nu1", email: "viewer@example.test" } });
        }
        seen.nuvioRefresh.push(body.refresh_token);
        // Single use: only the newest refresh token works.
        if (body.refresh_token !== state.nuvioRefresh) return json({ error_code: "refresh_token_already_used" }, 400);
        const n = seen.nuvioRefresh.length + 1;
        state.nuvioToken = "ACCESS-" + n;
        state.nuvioRefresh = "REFRESH-" + n;
        return json({ access_token: state.nuvioToken, refresh_token: state.nuvioRefresh, expires_in: 3600 });
      }
      if (url.pathname.startsWith("/rest/v1/rpc/")) {
        const fn = url.pathname.split("/").pop();
        const auth = new Headers(init.headers || {}).get("authorization");
        seen.nuvio.push({ fn, auth, body });
        if (state.nuvioRejects || auth !== "Bearer " + state.nuvioToken) return json({ message: "JWT expired" }, 401);
        if (fn === "sync_pull_profiles") return json(state.profiles || [{ profile_index: 1, name: "Main" }]);
        if (fn === "sync_pull_watched_items") return state.pullFails ? json({ message: "boom" }, 500) : json(body.p_page === 1 ? state.watched || [] : []);
        if (fn === "sync_pull_watch_progress") return json(state.progress || []);
        if (fn === "sync_delete_watched_items") {
          if (state.deleteFails) return json({ message: "boom" }, 500);
          seen.deleted = (seen.deleted || []).concat(body.p_keys);
          const same = (w, k) => String(mediaAppId(w)) === String(mediaAppId(k)) && (w.season ?? null) === (k.season ?? null) && (w.episode ?? null) === (k.episode ?? null);
          state.watched = (state.watched || []).filter((w) => !body.p_keys.some((k) => same(w, k)));
          return new Response(null, { status: 204 });
        }
        if (fn === "sync_push_watch_progress") {
          seen.progressPushed = (seen.progressPushed || []).concat(body.p_entries);
          for (const e of body.p_entries) {
            const i = (state.progress || []).findIndex((p) => mediaAppId(p) === mediaAppId(e) && (p.season ?? null) === (e.season ?? null) && (p.episode ?? null) === (e.episode ?? null));
            if (i >= 0) state.progress[i] = e;
          }
          return new Response(null, { status: 204 });
        }
        if (fn === "sync_push_collections") {
          seen.collectionsPushed = (seen.collectionsPushed || []).concat([body.p_collections_json]);
          return new Response(null, { status: 204 });
        }
        if (fn === "sync_push_watched_items") {
          if (state.pushFails) return json({ message: "boom" }, 500);
          seen.pushed.push(...body.p_items);
          return new Response(null, { status: 204 });
        }
      }
    }
    return new Response("{}", { status: 404 });
  };
  restore = () => { globalThis.fetch = realFetch; };
  return seen;
}

function bitfield(episodes, watchedIdx) {
  const last = Math.max(...watchedIdx);
  const length = last + 1;
  const bytes = new Uint8Array(Math.ceil(length / 8));
  for (const i of watchedIdx) bytes[i >> 3] |= 1 << (i & 7);
  return `${episodes[last].id}:${length}:${deflateSync(Buffer.from(bytes)).toString("base64")}`;
}

const mediaAppId = (o) => o.content_id || o.contentId;
const SHOW = "tt2222222";
const SHOW_EPS = [1, 2, 3, 4, 5].map((n) => ({ id: `${SHOW}:1:${n}`, season: 1, episode: n }));

// --- The account -------------------------------------------------------------

let idBase = 31000;
async function setup(name, extra = {}) {
  const env = makeEnv({ DB: makeD1(), DB_ACTIVITY: makeD1({ schema: "activity" }), TOKEN_ENCRYPTION_KEY: TEST_KEY, ...extra });
  idBase += 1000;
  await env.DB.prepare("INSERT INTO accounts (id, username, display_name, key_hash, created_at) VALUES (?, ?, 'placeholder', 'x', 1)").bind(idBase, "placeholder" + idBase).run();
  const u = await createUser(env, name);
  const r = await call(env, "/api/session", { method: "POST", json: { username: name, key: u.creatorKey } });
  const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  const accountId = env.DB._db.prepare("SELECT id FROM accounts WHERE username = ? COLLATE NOCASE").get(name).id;
  // The account's history copy is done, as for any account that has been around.
  env.DB._db.prepare("INSERT INTO jobs (type, dedupe_key, account_id, status, run_after, created_at, updated_at) VALUES ('migrate.activity', ?, ?, 'done', 0, 0, 0)").run(`migrate.activity:acct:${accountId}`, accountId);
  return { env, cookie, accountId, user: u };
}

// Runs due jobs until the account's pull has nothing left.
async function pull(env, ticks = 4) {
  for (let i = 0; i < ticks; i++) {
    env.DB._db.exec("UPDATE jobs SET run_after = 1 WHERE type = 'mediaapp.sync-account' AND status = 'queued'");
    await runScheduledTick(env);
  }
}

// The activity database holds media ids; the titles are in the main database.
const events = (env, accountId) => {
  const imdb = new Map(env.DB._db.prepare("SELECT id, imdb_id FROM media").all().map((m) => [m.id, m.imdb_id]));
  return env.DB_ACTIVITY._db.prepare("SELECT media_id, season, episode, watched_at, source FROM watch_events WHERE account_id = ? ORDER BY watched_at, season, episode")
    .all(accountId).map((r) => ({ imdb: imdb.get(r.media_id), season: r.season, episode: r.episode, watched_at: r.watched_at, source: r.source }));
};
const progressRows = (env, accountId) => env.DB_ACTIVITY._db.prepare("SELECT media_id, last_season, last_episode, last_watched_at, companion_json FROM show_progress WHERE account_id = ?").all(accountId);

async function connectStremio(ctx, state) {
  // The page runs the Link flow in the browser and hands over the authKey it got.
  const r = await call(ctx.env, "/api/connections/stremio/link/complete", { method: "POST", cookie: ctx.cookie, json: { authKey: "AUTHKEY-SECRET" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r;
}

describe("Stremio: connecting with the Link flow", () => {
  it("checks the authKey with Stremio, then stores it encrypted", async () => {
    const state = { library: [], episodes: {} };
    const seen = fakeServices(state);
    const ctx = await setup("stremconn");
    const bad = await call(ctx.env, "/api/connections/stremio/link/complete", { method: "POST", cookie: ctx.cookie, json: { authKey: "NOT-A-KEY" } });
    assert.equal(bad.status, 400);
    assert.equal(ctx.env.DB._db.prepare("SELECT count(*) AS n FROM provider_connections").get().n, 0, "nothing is stored for a key Stremio refuses");
    const none = await call(ctx.env, "/api/connections/stremio/link/complete", { method: "POST", cookie: ctx.cookie, json: {} });
    assert.equal(none.status, 400);

    const done = await connectStremio(ctx, state);
    assert.equal(done.body.status, "connected");
    assert.equal(done.body.username, "viewer@example.test");
    const row = ctx.env.DB._db.prepare("SELECT access_token_enc, status FROM provider_connections WHERE provider = 'stremio'").get();
    assert.equal(row.status, "ok");
    assert.ok(row.access_token_enc && !row.access_token_enc.includes("AUTHKEY-SECRET"), "the authKey is encrypted at rest");
    assert.ok(seen.stremio.includes("getUser"));
    assert.ok(!JSON.stringify(done.body).includes("AUTHKEY-SECRET"), "and not echoed back");
  });

  it("never hands the authKey back to the browser, and refuses a signed-out caller", async () => {
    const state = { approved: true, library: [], episodes: {} };
    fakeServices(state);
    const ctx = await setup("stremtok");
    await connectStremio(ctx, state);
    const bridge = await call(ctx.env, "/api/connections/stremio/token", { method: "POST", cookie: ctx.cookie, json: {} });
    assert.equal(bridge.status, 404);
    assert.ok(!JSON.stringify(bridge.body).includes("AUTHKEY-SECRET"));
    const listed = await call(ctx.env, "/api/connections", { cookie: ctx.cookie });
    assert.ok(!JSON.stringify(listed.body).includes("AUTHKEY-SECRET"));
    const anon = await call(ctx.env, "/api/connections/stremio/link/complete", { method: "POST", json: { authKey: "AUTHKEY-SECRET" } });
    assert.equal(anon.status, 401);
  });

  it("disconnecting logs out at Stremio and stops the sync, and keeps what was imported", async () => {
    const state = {
      approved: true, episodes: {},
      library: [{ _id: "tt1111111", type: "movie", name: "Movie A", state: { lastWatched: new Date(NOW - 5 * HOUR).toISOString(), timesWatched: 1, duration: 7200000, timeOffset: 7000000 }, _mtime: new Date(NOW - HOUR).toISOString() }],
    };
    const seen = fakeServices(state);
    const ctx = await setup("stremdisc");
    await connectStremio(ctx, state);
    await pull(ctx.env);
    assert.equal(events(ctx.env, ctx.accountId).length, 1);
    const gone = await call(ctx.env, "/api/connections/stremio", { method: "DELETE", cookie: ctx.cookie });
    assert.equal(gone.body.removed, true);
    assert.ok(seen.stremio.includes("logout"));
    assert.equal(ctx.env.DB._db.prepare("SELECT count(*) AS n FROM media_app_sync").get().n, 0);
    assert.equal(events(ctx.env, ctx.accountId).length, 1, "history already imported stays");
  });
});

describe("Stremio: pulling the library", () => {
  const library = () => [
    { _id: "tt1111111", type: "movie", name: "Movie A", poster: "https://img.test/a.jpg", _mtime: new Date(NOW - HOUR).toISOString(),
      state: { lastWatched: new Date(NOW - 30 * HOUR).toISOString(), timesWatched: 1, duration: 7200000, timeOffset: 7100000 } },
    { _id: "tt3333333", type: "movie", name: "Movie Half", poster: "https://img.test/h.jpg", _mtime: new Date(NOW - 2 * HOUR).toISOString(),
      state: { lastWatched: new Date(NOW - 2 * HOUR).toISOString(), timesWatched: 0, duration: 6000000, timeOffset: 3000000 } },
    { _id: SHOW, type: "series", name: "Show S", _mtime: new Date(NOW - 3 * HOUR).toISOString(),
      state: { video_id: `${SHOW}:1:3`, lastWatched: new Date(NOW - 3 * HOUR).toISOString(), duration: 2400000, timeOffset: 2350000, watched: bitfield(SHOW_EPS, [0, 1, 2]) } },
    { _id: "kitsu:123", type: "series", name: "Not ours", _mtime: new Date(NOW).toISOString(), state: {} },
  ];

  it("records dated plays, moves a show forward from its bitfield, and keeps a half-watched movie", async () => {
    const state = { approved: true, library: library(), episodes: { [SHOW]: SHOW_EPS } };
    fakeServices(state);
    const ctx = await setup("stremsync");
    await connectStremio(ctx, state);
    await pull(ctx.env);

    const ev = events(ctx.env, ctx.accountId);
    assert.deepEqual(ev.map((e) => [e.imdb, e.season, e.episode, e.source]), [
      ["tt1111111", null, null, "stremio"],
      [SHOW, 1, 3, "stremio"],
    ], "only titles with a play date get a Watch History entry; E1 and E2 have none");
    assert.equal(ev[0].watched_at, Date.parse(state.library[0].state.lastWatched));
    assert.equal(ev[1].watched_at, Date.parse(state.library[2].state.lastWatched));

    const mediaId = (imdb) => ctx.env.DB._db.prepare("SELECT id FROM media WHERE imdb_id = ?").get(imdb).id;
    const prog = progressRows(ctx.env, ctx.accountId);
    const show = prog.find((p) => p.media_id === mediaId(SHOW));
    assert.deepEqual([show.last_season, show.last_episode], [1, 3], "furthest episode from the bitfield");
    const half = prog.find((p) => p.media_id === mediaId("tt3333333"));
    assert.equal(half.last_season, null);
    assert.equal(JSON.parse(half.companion_json).progress, 50, "a movie part way through is kept as a Continue Watching entry");
    assert.equal(JSON.parse(half.companion_json).type, "movie");
    assert.equal(ctx.env.DB._db.prepare("SELECT count(*) AS n FROM media WHERE imdb_id = 'kitsu:123' OR alt_id LIKE 'kitsu%'").get().n, 0, "ids Stremio uses for anime are skipped");
  });

  it("offers an episode that is part way through as the next one to watch", async () => {
    const lib = [{ _id: SHOW, type: "series", name: "Show S", _mtime: new Date(NOW - HOUR).toISOString(),
      state: { video_id: `${SHOW}:1:4`, lastWatched: new Date(NOW - HOUR).toISOString(), duration: 2400000, timeOffset: 1200000, watched: bitfield(SHOW_EPS, [0, 1, 2]) } }];
    const state = { approved: true, library: lib, episodes: { [SHOW]: SHOW_EPS } };
    fakeServices(state);
    const ctx = await setup("stremresume");
    await connectStremio(ctx, state);
    await pull(ctx.env);
    assert.equal(events(ctx.env, ctx.accountId).length, 0, "an unfinished episode is not a watched play");
    const show = progressRows(ctx.env, ctx.accountId)[0];
    assert.deepEqual([show.last_season, show.last_episode], [1, 3], "the show stands at E3, so Continue Watching offers E4");
  });

  it("is idempotent, and a later pull adds only what changed", async () => {
    const state = { approved: true, library: library(), episodes: { [SHOW]: SHOW_EPS } };
    fakeServices(state);
    const ctx = await setup("stremagain");
    await connectStremio(ctx, state);
    await pull(ctx.env);
    const first = events(ctx.env, ctx.accountId);
    await call(ctx.env, "/api/connections/stremio/sync", { method: "POST", cookie: ctx.cookie, json: {} });
    await pull(ctx.env);
    assert.deepEqual(events(ctx.env, ctx.accountId), first, "pulling twice stores nothing twice");

    // E4 is watched later in Stremio.
    state.library[2] = { ...state.library[2], _mtime: new Date(NOW).toISOString(),
      state: { ...state.library[2].state, video_id: `${SHOW}:1:4`, lastWatched: new Date(NOW).toISOString(), timeOffset: 2390000, watched: bitfield(SHOW_EPS, [0, 1, 2, 3]) } };
    await call(ctx.env, "/api/connections/stremio/sync", { method: "POST", cookie: ctx.cookie, json: {} });
    await pull(ctx.env);
    const after = events(ctx.env, ctx.accountId);
    assert.equal(after.length, first.length + 1);
    assert.deepEqual([after[after.length - 1].season, after[after.length - 1].episode], [1, 4]);
  });

  it("reads the furthest episode from the bitfield, even when the last one played was an earlier one", async () => {
    // Watching E1 again after finishing E1 to E4: lastWatched and video_id say E1.
    const lib = [{ _id: SHOW, type: "series", name: "Show S", _mtime: new Date(NOW - HOUR).toISOString(),
      state: { video_id: `${SHOW}:1:1`, lastWatched: new Date(NOW - HOUR).toISOString(), duration: 2400000, timeOffset: 2399000, watched: bitfield(SHOW_EPS, [0, 1, 2, 3]) } }];
    const state = { approved: true, library: lib, episodes: { [SHOW]: SHOW_EPS } };
    fakeServices(state);
    const ctx = await setup("stremfar");
    await connectStremio(ctx, state);
    await pull(ctx.env);
    assert.deepEqual(events(ctx.env, ctx.accountId).map((e) => [e.season, e.episode]), [[1, 1]], "only the play with a date is a Watch History entry");
    const show = progressRows(ctx.env, ctx.accountId)[0];
    assert.deepEqual([show.last_season, show.last_episode], [1, 4], "the show stands at E4, the furthest one the bitfield marks");
  });

  it("still lines the bitfield up when the show has gained an episode since it was written", async () => {
    // Written when E1 to E3 existed (anchor E3, length 3). Stremio later lists a new episode ahead of it.
    const bits = bitfield(SHOW_EPS, [0, 2]);
    const grown = [{ id: `${SHOW}:1:0`, season: 1, episode: 0 }, ...SHOW_EPS];
    const lib = [{ _id: SHOW, type: "series", name: "Show S", _mtime: new Date(NOW - HOUR).toISOString(),
      state: { video_id: `${SHOW}:1:5`, lastWatched: new Date(NOW - 20 * HOUR).toISOString(), duration: 2400000, timeOffset: 10000, watched: bits } }];
    const state = { approved: true, library: lib, episodes: { [SHOW]: grown } };
    fakeServices(state);
    const ctx = await setup("stremgrown");
    await connectStremio(ctx, state);
    await pull(ctx.env);
    const show = progressRows(ctx.env, ctx.accountId)[0];
    assert.deepEqual([show.last_season, show.last_episode], [1, 3], "E1 and E3 are watched, whatever got added ahead of them");
  });

  it("asks Cinemeta only about titles that changed since the last pull", async () => {
    const OTHER = "tt4444444";
    const otherEps = [1, 2].map((n) => ({ id: `${OTHER}:1:${n}`, season: 1, episode: n }));
    const item = (id, eps, mtime) => ({ _id: id, type: "series", name: id, _mtime: new Date(mtime).toISOString(),
      state: { video_id: `${id}:1:2`, lastWatched: new Date(mtime).toISOString(), duration: 1000, timeOffset: 1000, watched: bitfield(eps, [0, 1]) } });
    const state = { approved: true, library: [item(SHOW, SHOW_EPS, NOW - 3 * HOUR), item(OTHER, otherEps, NOW - 40 * HOUR)], episodes: { [SHOW]: SHOW_EPS, [OTHER]: otherEps } };
    const seen = fakeServices(state);
    const ctx = await setup("stremsince");
    await connectStremio(ctx, state);
    await pull(ctx.env);
    assert.equal(seen.cinemeta.length, 2, "the first pull reads everything");
    state.library[0] = item(SHOW, SHOW_EPS, NOW);
    await call(ctx.env, "/api/connections/stremio/sync", { method: "POST", cookie: ctx.cookie, json: {} });
    await pull(ctx.env);
    assert.equal(seen.cinemeta.length, 3, "the second reads only the show that changed");
  });

  it("does not repeat a play the subtitles ping already recorded for the same viewing", async () => {
    const state = { approved: true, library: library().slice(0, 1), episodes: {} };
    fakeServices(state);
    const ctx = await setup("stremping");
    // The ping fired when the film started, two hours before Stremio's lastWatched.
    const start = Date.parse(state.library[0].state.lastWatched) - 2 * HOUR;
    const refMedia = ctx.env.DB._db.prepare("INSERT INTO media (kind, imdb_id, title, created_at, updated_at) VALUES ('movie', 'tt1111111', 'Movie A', 1, 1)").run().lastInsertRowid;
    ctx.env.DB_ACTIVITY._db.prepare("INSERT INTO watch_events (account_id, media_id, watched_at, source, dedupe_key) VALUES (?, ?, ?, 'ping', 'ping-1')").run(ctx.accountId, refMedia, start);
    await connectStremio(ctx, state);
    await pull(ctx.env);
    const ev = events(ctx.env, ctx.accountId);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].source, "ping");
  });

  it("waits while the account's existing history is still being copied, and says why", async () => {
    const state = { approved: true, library: library().slice(0, 1), episodes: {} };
    fakeServices(state);
    const ctx = await setup("stremwait");
    ctx.env.DB._db.exec("UPDATE jobs SET status = 'running' WHERE type = 'migrate.activity'");
    await connectStremio(ctx, state);
    await pull(ctx.env, 2);
    assert.equal(events(ctx.env, ctx.accountId).length, 0);
    const row = ctx.env.DB._db.prepare("SELECT last_error, last_pull_at FROM media_app_sync").get();
    assert.match(row.last_error, /still being copied/);
    assert.equal(row.last_pull_at, null, "a pull that wrote nothing is not recorded as done");
  });

  it("asks the person to reconnect when Stremio refuses the authKey", async () => {
    const state = { approved: true, library: library(), episodes: {} };
    fakeServices(state);
    const ctx = await setup("stremrefuse");
    await connectStremio(ctx, state);
    ctx.env.DB._db.exec("UPDATE jobs SET status = 'done' WHERE type = 'mediaapp.sync-account'");
    // Stremio forgets the session.
    const real = globalThis.fetch;
    globalThis.fetch = async (input, init) => (String(input.url || input).includes("datastoreGet") ? json({ error: { message: "Session does not exist" } }) : real(input, init));
    const prev = restore;
    restore = () => { globalThis.fetch = real; prev(); };
    await call(ctx.env, "/api/connections/stremio/sync", { method: "POST", cookie: ctx.cookie, json: {} });
    await pull(ctx.env, 2);
    assert.equal(ctx.env.DB._db.prepare("SELECT status FROM provider_connections WHERE provider = 'stremio'").get().status, "reauth_required");
    assert.match(ctx.env.DB._db.prepare("SELECT last_error FROM media_app_sync").get().last_error, /Sign in again/);
  });
});

describe("Nuvio: connecting and pulling", () => {
  const watched = () => [
    { content_id: "tt1111111", content_type: "movie", title: "Movie A", watched_at: NOW - 30 * HOUR },
    { content_id: SHOW, content_type: "series", title: "Show S", season: 1, episode: 1, watched_at: NOW - 10 * HOUR },
    { content_id: SHOW, content_type: "series", title: "Show S", season: 1, episode: 2, watched_at: NOW - 9 * HOUR },
  ];
  const progress = () => [
    { content_id: "tt3333333", content_type: "movie", name: "Movie Half", position: 1500000, duration: 6000000, last_watched: NOW - 2 * HOUR },
    { content_id: SHOW, content_type: "series", name: "Show S", season: 1, episode: 3, position: 600000, duration: 2400000, last_watched: NOW - HOUR },
  ];

  async function connectNuvio(ctx, state) {
    const r = await call(ctx.env, "/api/connections/nuvio/login", { method: "POST", cookie: ctx.cookie, json: { email: "viewer@example.test", password: "right-password" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r;
  }

  it("signs in once, keeps only the tokens, and picks the only profile", async () => {
    const state = { watched: [], progress: [] };
    const seen = fakeServices(state);
    const ctx = await setup("nuvconn");
    const bad = await call(ctx.env, "/api/connections/nuvio/login", { method: "POST", cookie: ctx.cookie, json: { email: "viewer@example.test", password: "nope" } });
    assert.equal(bad.status, 400);
    assert.equal(ctx.env.DB._db.prepare("SELECT count(*) AS n FROM provider_connections").get().n, 0);

    const ok = await connectNuvio(ctx, state);
    assert.equal(ok.body.profileIndex, 1);
    assert.deepEqual(ok.body.profiles, [{ index: 1, name: "Main" }]);
    const dump = JSON.stringify([
      ctx.env.DB._db.prepare("SELECT * FROM provider_connections").all(),
      ctx.env.DB._db.prepare("SELECT * FROM media_app_sync").all(),
      ctx.env.DB._db.prepare("SELECT payload_json, progress_json FROM jobs").all(),
    ]);
    assert.ok(!dump.includes("right-password"), "the password is never stored");
    assert.ok(!dump.includes("ACCESS-1") && !dump.includes("REFRESH-1"), "the tokens are encrypted");
    assert.equal(seen.nuvioSignIns.filter((b) => b.password === "right-password").length, 1, "signed in once");
  });

  it("asks which profile to read when the account has several, and reads nothing until chosen", async () => {
    const state = { watched: watched(), progress: [], profiles: [{ profile_index: 1, name: "Me" }, { profile_index: 2, name: "Kids" }] };
    const seen = fakeServices(state);
    const ctx = await setup("nuvprof");
    const ok = await connectNuvio(ctx, state);
    assert.equal(ok.body.profileIndex, null);
    assert.equal(ok.body.profiles.length, 2);
    await pull(ctx.env, 2);
    assert.equal(seen.nuvio.filter((c) => c.fn === "sync_pull_watched_items").length, 0);
    const bad = await call(ctx.env, "/api/connections/nuvio/settings", { method: "POST", cookie: ctx.cookie, json: { profileIndex: 9 } });
    assert.equal(bad.status, 400);
    await call(ctx.env, "/api/connections/nuvio/settings", { method: "POST", cookie: ctx.cookie, json: { profileIndex: 2 } });
    await pull(ctx.env);
    const calls = seen.nuvio.filter((c) => c.fn === "sync_pull_watched_items");
    assert.ok(calls.length > 0 && calls.every((c) => c.body.p_profile_id === 2), "reads the chosen profile");
    assert.equal(events(ctx.env, ctx.accountId).length, 3);
  });

  it("keeps Nuvio's own dates, and turns progress into Continue Watching", async () => {
    const state = { watched: watched(), progress: progress() };
    fakeServices(state);
    const ctx = await setup("nuvsync");
    await connectNuvio(ctx, state);
    await pull(ctx.env);
    assert.deepEqual(events(ctx.env, ctx.accountId).map((e) => [e.imdb, e.season, e.episode, e.watched_at, e.source]), [
      ["tt1111111", null, null, NOW - 30 * HOUR, "nuvio"],
      [SHOW, 1, 1, NOW - 10 * HOUR, "nuvio"],
      [SHOW, 1, 2, NOW - 9 * HOUR, "nuvio"],
    ]);
    const mediaId = (imdb) => ctx.env.DB._db.prepare("SELECT id FROM media WHERE imdb_id = ?").get(imdb).id;
    const prog = progressRows(ctx.env, ctx.accountId);
    const show = prog.find((p) => p.media_id === mediaId(SHOW));
    assert.deepEqual([show.last_season, show.last_episode], [1, 2], "E3 is part way through, so the show stands at E2");
    const movie = prog.find((p) => p.media_id === mediaId("tt3333333"));
    assert.equal(JSON.parse(movie.companion_json).progress, 25);
  });

  it("drops a movie's resume point once Nuvio says it was watched", async () => {
    const state = { watched: [], progress: [{ content_id: "tt3333333", content_type: "movie", name: "Movie Half", position: 1500000, duration: 6000000, last_watched: NOW - 5 * HOUR }] };
    fakeServices(state);
    const ctx = await setup("nuvdone");
    await connectNuvio(ctx, state);
    await pull(ctx.env);
    const id = ctx.env.DB._db.prepare("SELECT id FROM media WHERE imdb_id = 'tt3333333'").get().id;
    assert.ok(progressRows(ctx.env, ctx.accountId).find((p) => p.media_id === id).companion_json);
    state.watched = [{ content_id: "tt3333333", content_type: "movie", title: "Movie Half", watched_at: NOW - HOUR }];
    state.progress = [];
    await call(ctx.env, "/api/connections/nuvio/sync", { method: "POST", cookie: ctx.cookie, json: {} });
    await pull(ctx.env);
    assert.equal(progressRows(ctx.env, ctx.accountId).find((p) => p.media_id === id).companion_json, null);
    assert.equal(events(ctx.env, ctx.accountId).length, 1);
  });

  it("renews the single-use refresh token once, saves the new one, and uses it next time", async () => {
    const state = { watched: watched(), progress: [] };
    const seen = fakeServices(state);
    const ctx = await setup("nuvrefresh");
    await connectNuvio(ctx, state);
    ctx.env.DB._db.prepare("UPDATE provider_connections SET expires_at = ? WHERE provider = 'nuvio'").run(Date.now() - 1000);
    await pull(ctx.env);
    assert.deepEqual(seen.nuvioRefresh, ["REFRESH-1"]);
    assert.ok(seen.nuvio.every((c) => c.auth === "Bearer ACCESS-2" || c.fn === "sync_pull_profiles"), "the renewed access token is the one used");
    assert.equal(events(ctx.env, ctx.accountId).length, 3);
    ctx.env.DB._db.prepare("UPDATE provider_connections SET expires_at = ? WHERE provider = 'nuvio'").run(Date.now() - 1000);
    await call(ctx.env, "/api/connections/nuvio/sync", { method: "POST", cookie: ctx.cookie, json: {} });
    await pull(ctx.env);
    assert.deepEqual(seen.nuvioRefresh, ["REFRESH-1", "REFRESH-2"], "the second renewal used the token the first one returned");
    assert.equal(ctx.env.DB._db.prepare("SELECT status FROM provider_connections WHERE provider = 'nuvio'").get().status, "ok");
  });

  it("asks the person to sign in again when Nuvio refuses the renewal", async () => {
    const state = { watched: watched(), progress: [] };
    fakeServices(state);
    const ctx = await setup("nuvrefused");
    await connectNuvio(ctx, state);
    ctx.env.DB._db.prepare("UPDATE provider_connections SET expires_at = ? WHERE provider = 'nuvio'").run(Date.now() - 1000);
    state.nuvioRefresh = "SOMETHING-ELSE";
    await call(ctx.env, "/api/connections/nuvio/sync", { method: "POST", cookie: ctx.cookie, json: { wait: true, force: true } });
    // The shared renewal path marks it "expired" (28_); either way it is no longer "ok".
    assert.notEqual(ctx.env.DB._db.prepare("SELECT status FROM provider_connections WHERE provider = 'nuvio'").get().status, "ok");
    assert.match(ctx.env.DB._db.prepare("SELECT last_error FROM media_app_sync").get().last_error, /sign in again/);
    assert.equal(events(ctx.env, ctx.accountId).length, 3, "what was imported when connecting stays");
  });
});

describe("the hourly sweep", () => {
  it("starts a pull for connected accounts whose last pull is old, and not for others", async () => {
    const state = { approved: true, library: [], episodes: {} };
    fakeServices(state);
    const ctx = await setup("sweepacct", { JOBS: makeQueue() });
    await connectStremio(ctx, state);
    const jobs = () => ctx.env.DB._db.prepare("SELECT status FROM jobs WHERE type = 'mediaapp.sync-account'").all();
    // Connecting did the first pull itself, so no job is waiting.
    assert.deepEqual(jobs(), []);
    ctx.env.DB._db.prepare("UPDATE media_app_sync SET last_pull_at = ?").run(Date.now() - 5 * 60 * 1000);
    ctx.env.DB._db.exec("UPDATE jobs SET run_after = 1 WHERE dedupe_key = 'periodic:mediaapp.sync'");
    await runScheduledTick(ctx.env);
    assert.deepEqual(jobs(), [], "pulled five minutes ago: left alone");
    ctx.env.DB._db.prepare("UPDATE media_app_sync SET last_pull_at = ?").run(Date.now() - 2 * HOUR);
    ctx.env.DB._db.exec("UPDATE jobs SET run_after = 1 WHERE dedupe_key = 'periodic:mediaapp.sync'");
    await runScheduledTick(ctx.env);
    assert.equal(jobs().length, 1, "two hours ago: started again");
  });
});

// --- Two-way sync -----------------------------------------------------------------

// Node's own reading of the documented bitfield, so the test does not lean on the code under test.
function decodeBits(str, eps) {
  const last = str.lastIndexOf(":");
  const mid = str.lastIndexOf(":", last - 1);
  const anchor = eps.findIndex((e) => e.id === str.slice(0, mid));
  const length = Number(str.slice(mid + 1, last));
  const data = inflateSync(Buffer.from(str.slice(last + 1), "base64"));
  const out = [];
  for (let p = 0; p < length; p++) if (data[p >> 3] & (1 << (p & 7))) out.push(eps[p + anchor + 1 - length].episode);
  return out;
}

function addEvent(ctx, imdb, kind, season, episode, at, source = "ping") {
  const db = ctx.env.DB._db;
  let m = db.prepare("SELECT id FROM media WHERE imdb_id = ?").get(imdb);
  if (!m) m = { id: Number(db.prepare("INSERT INTO media (kind, imdb_id, title, created_at, updated_at) VALUES (?, ?, ?, 1, 1)").run(kind, imdb, "Title " + imdb).lastInsertRowid) };
  ctx.env.DB_ACTIVITY._db.prepare("INSERT INTO watch_events (account_id, media_id, season, episode, watched_at, source, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(ctx.accountId, m.id, season, episode, at, source, `${ctx.accountId}:${imdb}:${season}:${episode}:${at}:${source}`);
}

const runAgain = async (ctx, provider) => {
  await call(ctx.env, `/api/connections/${provider}/sync`, { method: "POST", cookie: ctx.cookie, json: {} });
  await pull(ctx.env);
};
const cursorOf = (ctx) => JSON.parse(ctx.env.DB._db.prepare("SELECT cursor_json FROM media_app_sync").get().cursor_json || "{}");

describe("two-way sync: Stremio", () => {
  const movieItem = () => ({ _id: "tt1111111", type: "movie", name: "Movie A", poster: "https://img.test/a.jpg", behaviorHints: { defaultVideoId: "tt1111111" }, _mtime: new Date(NOW - 50 * HOUR).toISOString(),
    state: { lastWatched: new Date(NOW - 50 * HOUR).toISOString(), timesWatched: 0, flaggedWatched: 0, duration: 0, timeOffset: 0 } });
  const showItem = (watchedIdx) => ({ _id: SHOW, type: "series", name: "Show S", _mtime: new Date(NOW - 50 * HOUR).toISOString(),
    state: { video_id: `${SHOW}:1:1`, lastWatched: new Date(NOW - 50 * HOUR).toISOString(), watched: bitfield(SHOW_EPS, watchedIdx), duration: 0, timeOffset: 0 } });

  async function ready(name, library, extra = {}) {
    const state = { approved: true, library, episodes: { [SHOW]: SHOW_EPS }, ...extra };
    const seen = fakeServices(state);
    const ctx = await setup(name, { FF_MEDIA_APP_PUSH: "1" });
    await connectStremio(ctx, state);
    await pull(ctx.env);
    const on = await call(ctx.env, "/api/connections/stremio/settings", { method: "POST", cookie: ctx.cookie, json: { push: true } });
    assert.equal(on.body.sync.push, true);
    await pull(ctx.env);
    return { state, seen, ctx };
  }

  it("is refused unless the server switched it on", async () => {
    const state = { approved: true, library: [movieItem()], episodes: {} };
    const seen = fakeServices(state);
    const ctx = await setup("pushoff");
    await connectStremio(ctx, state);
    const r = await call(ctx.env, "/api/connections/stremio/settings", { method: "POST", cookie: ctx.cookie, json: { push: true } });
    assert.equal(r.status, 409);
    addEvent(ctx, "tt1111111", "movie", null, null, NOW - HOUR);
    ctx.env.DB._db.exec("UPDATE media_app_sync SET push_enabled = 1");
    await runAgain(ctx, "stremio");
    assert.equal(seen.puts.length, 0, "even with the row set by hand, nothing is written while the flag is off");
    const settings = await call(ctx.env, "/api/connections/stremio/settings", { cookie: ctx.cookie });
    assert.equal(settings.body.pushAvailable, false);
  });

  it("marks a movie watched in the library, keeping everything else on the item", async () => {
    const { seen, state, ctx } = await ready("pushmovie", [movieItem()]);
    const at = NOW - 3 * HOUR;
    addEvent(ctx, "tt1111111", "movie", null, null, at);
    await runAgain(ctx, "stremio");
    assert.equal(seen.puts.length, 1);
    const sent = seen.puts[0][0];
    assert.equal(sent._id, "tt1111111");
    assert.equal(sent.state.flaggedWatched, 1);
    assert.equal(sent.state.timesWatched, 1);
    assert.equal(sent.state.lastWatched, new Date(at).toISOString());
    assert.deepEqual([sent.name, sent.poster, sent.behaviorHints], ["Movie A", "https://img.test/a.jpg", { defaultVideoId: "tt1111111" }], "the item as it was read, plus the watched state");
    assert.ok(Date.parse(sent._mtime) > Date.parse(movieItem()._mtime), "a newer _mtime, so Stremio takes the change");
    assert.equal(state.library[0].state.timesWatched, 1);
  });

  it("adds episodes to a show's bitfield without losing the ones already marked", async () => {
    const { seen, ctx } = await ready("pushshow", [showItem([0])]);
    addEvent(ctx, SHOW, "series", 1, 2, NOW - 4 * HOUR);
    addEvent(ctx, SHOW, "series", 1, 3, NOW - 3 * HOUR);
    await runAgain(ctx, "stremio");
    assert.equal(seen.puts.length, 1);
    assert.deepEqual(decodeBits(seen.puts[0][0].state.watched, SHOW_EPS), [1, 2, 3], "E1 was there; E2 and E3 are added");
    assert.equal(seen.puts[0][0].state.video_id, `${SHOW}:1:1`, "where Stremio thinks you are is left alone");
  });

  it("leaves titles that are not in the library alone, and never writes a play Stremio already has", async () => {
    const watchedMovie = movieItem();
    watchedMovie.state = { ...watchedMovie.state, timesWatched: 2 };
    const { seen, ctx } = await ready("pushskip", [watchedMovie]);
    addEvent(ctx, "tt1111111", "movie", null, null, NOW - HOUR);
    addEvent(ctx, "tt9999999", "movie", null, null, NOW - HOUR);
    await runAgain(ctx, "stremio");
    assert.equal(seen.puts.length, 0);
  });

  it("does not send a play back to Stremio that came from Stremio, and sends each play once", async () => {
    const lib = [movieItem()];
    lib[0].state = { ...lib[0].state, timesWatched: 1, lastWatched: new Date(NOW - 8 * HOUR).toISOString() };
    const { seen, ctx } = await ready("pushecho", lib);
    assert.equal(ctx.env.DB_ACTIVITY._db.prepare("SELECT count(*) AS n FROM watch_events WHERE source = 'stremio'").get().n, 1, "the pull brought the play in");
    await runAgain(ctx, "stremio");
    assert.equal(seen.puts.length, 0, "echo: its own play is not sent back");
    addEvent(ctx, SHOW, "series", 1, 1, NOW - HOUR);
    seen.puts.length = 0;
    await runAgain(ctx, "stremio");
    await runAgain(ctx, "stremio");
    assert.ok(cursorOf(ctx).pushedId > 0, "the position is kept");
    assert.equal(seen.puts.length, 0, "a show that is not in the library is skipped, and not retried forever");
  });

  it("keeps its place after a failed write and sends again next time", async () => {
    const { seen, state, ctx } = await ready("pushfail", [movieItem()]);
    addEvent(ctx, "tt1111111", "movie", null, null, NOW - HOUR);
    state.putFails = true;
    await runAgain(ctx, "stremio");
    assert.match(ctx.env.DB._db.prepare("SELECT last_error FROM media_app_sync").get().last_error, /Could not send/);
    assert.equal(cursorOf(ctx).pushedId || 0, 0, "not moved past a play that was not sent");
    state.putFails = false;
    await runAgain(ctx, "stremio");
    assert.equal(state.library[0].state.timesWatched, 1);
    assert.equal(ctx.env.DB._db.prepare("SELECT last_error FROM media_app_sync").get().last_error, null);
  });

  it("round-trips the bitfield it writes with the one it reads", async () => {
    const { seen, ctx } = await ready("pushbits", [showItem([1])]);
    for (const e of [1, 3, 5]) addEvent(ctx, SHOW, "series", 1, e, NOW - (6 - e) * HOUR);
    await runAgain(ctx, "stremio");
    assert.deepEqual(decodeBits(seen.puts[0][0].state.watched, SHOW_EPS), [1, 2, 3, 5]);
    // And the pull reads what was written as the furthest episode.
    await runAgain(ctx, "stremio");
    const show = progressRows(ctx.env, ctx.accountId).find((p) => p.last_season === 1);
    assert.equal(show.last_episode, 5);
  });
});

describe("two-way sync: Nuvio", () => {
  const rows = (style) => style === "camel"
    ? [{ contentId: "tt1111111", contentType: "movie", title: "Movie A", watchedAt: NOW - 30 * HOUR }]
    : [{ content_id: "tt1111111", content_type: "movie", title: "Movie A", watched_at: Math.round((NOW - 30 * HOUR) / 1000) }];

  async function ready(name, watched) {
    const state = { watched, progress: [] };
    const seen = fakeServices(state);
    const ctx = await setup(name, { FF_MEDIA_APP_PUSH: "1" });
    await call(ctx.env, "/api/connections/nuvio/login", { method: "POST", cookie: ctx.cookie, json: { email: "viewer@example.test", password: "right-password" } });
    await pull(ctx.env);
    await call(ctx.env, "/api/connections/nuvio/settings", { method: "POST", cookie: ctx.cookie, json: { push: true } });
    await pull(ctx.env);
    return { state, seen, ctx };
  }

  it("sends plays from elsewhere in the shape Nuvio's own rows have, and not the ones it already has", async () => {
    const { seen, ctx } = await ready("nuvpush", rows("snake"));
    assert.equal(seen.pushed.length, 0, "nothing of Nuvio's own is sent back");
    addEvent(ctx, "tt1111111", "movie", null, null, NOW - 29 * HOUR);
    addEvent(ctx, "tt5555555", "movie", null, null, NOW - 2 * HOUR);
    addEvent(ctx, SHOW, "series", 1, 2, NOW - HOUR);
    await runAgain(ctx, "nuvio");
    assert.deepEqual(seen.pushed.map((p) => [p.content_id, p.content_type, p.season, p.episode]), [["tt5555555", "movie", undefined, undefined], [SHOW, "series", 1, 2]], "the movie Nuvio has is skipped");
    assert.equal(seen.pushed[0].watched_at, Math.round((NOW - 2 * HOUR) / 1000), "seconds, as in its own rows");
    assert.equal(seen.pushed[0].title, "Title tt5555555");
    seen.pushed.length = 0;
    await runAgain(ctx, "nuvio");
    assert.equal(seen.pushed.length, 0, "each play is sent once");
  });

  it("follows camelCase rows with camelCase, and milliseconds with milliseconds", async () => {
    const { seen, ctx } = await ready("nuvcamel", rows("camel"));
    addEvent(ctx, "tt5555555", "movie", null, null, NOW - 2 * HOUR);
    await runAgain(ctx, "nuvio");
    assert.deepEqual(Object.keys(seen.pushed[0]).sort(), ["contentId", "contentType", "title", "watchedAt"]);
    assert.equal(seen.pushed[0].watchedAt, NOW - 2 * HOUR);
  });

  it("carries plays between the two apps, and not back to where they came from", async () => {
    const { seen, ctx } = await ready("nuvfrom", rows("snake"));
    // A play that came in from Stremio is Nuvio's to receive.
    addEvent(ctx, "tt6666666", "movie", null, null, NOW - HOUR, "stremio");
    await runAgain(ctx, "nuvio");
    assert.deepEqual(seen.pushed.map((p) => p.content_id), ["tt6666666"]);
    // And Nuvio's own play is not sent to Nuvio again, however often it runs.
    await runAgain(ctx, "nuvio");
    assert.equal(seen.pushed.length, 1);
  });

  it("does not bring back a play the person deleted in Nuvio", async () => {
    const two = [...rows("snake"), { content_id: "tt7777777", content_type: "movie", title: "Movie B", watched_at: Math.round((NOW - 20 * HOUR) / 1000) }];
    const state = { watched: two, progress: [] };
    const seen = fakeServices(state);
    const ctx = await setup("nuvdeleted", { FF_MEDIA_APP_PUSH: "1" });
    await call(ctx.env, "/api/connections/nuvio/login", { method: "POST", cookie: ctx.cookie, json: { email: "viewer@example.test", password: "right-password" } });
    await pull(ctx.env);
    assert.equal(ctx.env.DB_ACTIVITY._db.prepare("SELECT count(*) AS n FROM watch_events WHERE source = 'nuvio'").get().n, 2);
    // Movie B is removed from the Nuvio profile before two-way sync is ever on. Our copy of the
    // play stays (we never delete), but it is Nuvio's own play: sending it back would undo the deletion.
    state.watched = rows("snake");
    await call(ctx.env, "/api/connections/nuvio/settings", { method: "POST", cookie: ctx.cookie, json: { push: true } });
    await pull(ctx.env);
    assert.equal(seen.pushed.length, 0);
    assert.equal(ctx.env.DB_ACTIVITY._db.prepare("SELECT count(*) AS n FROM watch_events WHERE source = 'nuvio'").get().n, 2, "nothing deleted here either");
  });

  it("waits, and says so, when Nuvio has no row to copy the format from", async () => {
    const { seen, ctx } = await ready("nuvempty", []);
    addEvent(ctx, "tt5555555", "movie", null, null, NOW - HOUR);
    await runAgain(ctx, "nuvio");
    assert.equal(seen.pushed.length, 0);
    assert.match(ctx.env.DB._db.prepare("SELECT last_error FROM media_app_sync").get().last_error, /something watched in Nuvio/);
    assert.equal(cursorOf(ctx).pushedId || 0, 0, "not moved: it will send once it can");
  });

  it("records a failed send and tries again from the same place", async () => {
    const { seen, state, ctx } = await ready("nuvfail", rows("snake"));
    addEvent(ctx, "tt5555555", "movie", null, null, NOW - HOUR);
    state.pushFails = true;
    await runAgain(ctx, "nuvio");
    assert.match(ctx.env.DB._db.prepare("SELECT last_error FROM media_app_sync").get().last_error, /Could not send/);
    state.pushFails = false;
    await runAgain(ctx, "nuvio");
    assert.deepEqual(seen.pushed.map((p) => p.content_id), ["tt5555555"]);
  });
});


describe("saying why a connection could not be made", () => {
  it("names the missing migration when media_app_sync is not there", async () => {
    const state = { watched: [], progress: [] };
    fakeServices(state);
    const ctx = await setup("nodetail1");
    ctx.env.DB._db.exec("DROP TABLE media_app_sync");
    const r = await call(ctx.env, "/api/connections/nuvio/login", { method: "POST", cookie: ctx.cookie, json: { email: "viewer@example.test", password: "right-password" } });
    assert.equal(r.status, 503);
    assert.match(r.body.detail, /migration 0023/);
    assert.equal(ctx.env.DB._db.prepare("SELECT count(*) AS n FROM provider_connections").get().n, 0, "nothing is stored without its settings row");
  });

  it("names the missing encryption key", async () => {
    fakeServices({});
    const ctx = await setup("nodetail2", { TOKEN_ENCRYPTION_KEY: undefined });
    const r = await call(ctx.env, "/api/connections/stremio/link/complete", { method: "POST", cookie: ctx.cookie, json: { authKey: "AUTHKEY-SECRET" } });
    assert.equal(r.status, 503);
    assert.match(r.body.detail, /TOKEN_ENCRYPTION_KEY/);
  });

  it("says what Stremio answered when it cannot be asked", async () => {
    fakeServices({ stremioDown: 500 });
    const ctx = await setup("nodetail3");
    const r = await call(ctx.env, "/api/connections/stremio/link/complete", { method: "POST", cookie: ctx.cookie, json: { authKey: "AUTHKEY-SECRET" } });
    assert.equal(r.status, 502);
    assert.match(r.body.detail, /Stremio answered 500/);
  });

  it("says when the request itself failed", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = async (input, init) => { if (String(input.url || input).includes("api.strem.io")) throw new TypeError("network lost"); return real(input, init); };
    restore = () => { globalThis.fetch = real; };
    const ctx = await setup("nodetail4");
    const r = await call(ctx.env, "/api/connections/stremio/link/complete", { method: "POST", cookie: ctx.cookie, json: { authKey: "AUTHKEY-SECRET" } });
    assert.equal(r.status, 502);
    assert.match(r.body.detail, /api\.strem\.io request failed \(TypeError\)/);
  });

  it("keeps the Nuvio profile names, and keeps them when the profile is changed", async () => {
    const state = { watched: [], progress: [], profiles: [{ profile_index: 1, name: "Me" }, { profile_index: 3, name: "Kids" }] };
    fakeServices(state);
    const ctx = await setup("profnames");
    await call(ctx.env, "/api/connections/nuvio/login", { method: "POST", cookie: ctx.cookie, json: { email: "viewer@example.test", password: "right-password" } });
    const names = async () => (await call(ctx.env, "/api/connections/nuvio/settings", { cookie: ctx.cookie })).body.profiles;
    assert.deepEqual(await names(), [{ index: 1, name: "Me" }, { index: 3, name: "Kids" }], "a later page load still has them");
    await pull(ctx.env, 1);
    await call(ctx.env, "/api/connections/nuvio/settings", { method: "POST", cookie: ctx.cookie, json: { profileIndex: 3 } });
    assert.deepEqual(await names(), [{ index: 1, name: "Me" }, { index: 3, name: "Kids" }], "choosing a profile does not lose them");
    await pull(ctx.env);
    assert.deepEqual(await names(), [{ index: 1, name: "Me" }, { index: 3, name: "Kids" }], "nor does a pull");
  });
});


// --- The lists under Lists, My Lists ------------------------------------------------

describe("Nuvio and Stremio lists as Stremio/Nuvio catalog rows", () => {
  const ROWS = ["watch-history", "continue-watching"].flatMap((slug) => ["nuvio", "stremio"].flatMap((app) => ["movie", "series"].map((type) => [app, slug, type])));

  // A stored config, the shape an install link points at, owned by `ownerName` with its Creator Key.
  async function storeConfig(env, id, owner, urlsFor = owner.creatorName) {
    await env.CONFIGS.put(`cfg:${id}`, JSON.stringify({
      track: true, trackCreatorName: owner.creatorName, trackCreatorKey: owner.creatorKey, showBadgesStremio: false,
      entries: ROWS.map(([app, slug, type]) => ({ id: `${app}-${slug}-${type}`, type, name: `${app} ${slug}`, url: `autotrack:${app}-${slug}:${type}:${urlsFor}` })),
    }));
  }
  const row = async (env, config, app, slug, type) =>
    ((await call(env, `/${config}/catalog/${type}/${app}-${slug}-${type}.json`)).body.metas || []).map((m) => m.id).sort();

  async function connected(name, extra) {
    const state = { watched: [
      { content_id: "tt1111111", content_type: "movie", title: "Movie A", watched_at: NOW - 30 * HOUR },
      { content_id: SHOW, content_type: "series", title: "Show S", season: 1, episode: 1, watched_at: NOW - 10 * HOUR },
      { content_id: SHOW, content_type: "series", title: "Show S", season: 1, episode: 2, watched_at: NOW - 9 * HOUR },
    ], progress: [
      { content_id: "tt3333333", content_type: "movie", name: "Movie Half", position: 1500000, duration: 6000000, last_watched: NOW - 2 * HOUR },
      { content_id: SHOW, content_type: "series", name: "Show S", season: 1, episode: 3, position: 600000, duration: 2400000, last_watched: NOW - HOUR },
    ] };
    fakeServices(state);
    const ctx = await setup(name, extra || { FF_EVENT_TRACKING: "1" });
    // The account the sync runs for is the one this user signed in as.
    ctx.owner = ctx.user;
    await call(ctx.env, "/api/connections/nuvio/login", { method: "POST", cookie: ctx.cookie, json: { email: "viewer@example.test", password: "right-password" } });
    await pull(ctx.env);
    return { ...ctx, state };
  }

  it("a list shows only the plays that came from that app, movies and shows apart", async () => {
    const ctx = await connected("lsmain");
    addEvent(ctx, "tt5555555", "movie", null, null, NOW - 5 * HOUR, "ping");
    addEvent(ctx, "tt6666666", "movie", null, null, NOW - 4 * HOUR, "stremio");
    await storeConfig(ctx.env, "lsmaincfg", ctx.owner);
    assert.deepEqual(await row(ctx.env, "lsmaincfg", "nuvio", "watch-history", "movie"), ["tt1111111"], "not the ping play, not the Stremio one");
    assert.deepEqual(await row(ctx.env, "lsmaincfg", "nuvio", "watch-history", "series"), [SHOW]);
    assert.deepEqual(await row(ctx.env, "lsmaincfg", "stremio", "watch-history", "movie"), ["tt6666666"]);
    assert.deepEqual(await row(ctx.env, "lsmaincfg", "stremio", "watch-history", "series"), []);
  });

  it("Continue Watching has the movie Nuvio left part way through, and the next episode of its shows", async () => {
    const ctx = await connected("lscw");
    const mediaId = ctx.env.DB._db.prepare("SELECT id FROM media WHERE imdb_id = ?").get(SHOW).id;
    // The schedule says the show has five episodes in season 1.
    ctx.env.DB._db.prepare("UPDATE show_schedule SET status = 'Ended', last_aired_season = 1, last_aired_episode = 5, last_aired_date = '2020-01-01', season_episode_counts = '{\"1\":5}', checked_at = 1 WHERE media_id = ?").run(mediaId);
    await storeConfig(ctx.env, "lscwcfg", ctx.owner);
    assert.deepEqual(await row(ctx.env, "lscwcfg", "nuvio", "continue-watching", "movie"), ["tt3333333"]);
    assert.deepEqual(await row(ctx.env, "lscwcfg", "nuvio", "continue-watching", "series"), [SHOW]);
    assert.deepEqual(await row(ctx.env, "lscwcfg", "stremio", "continue-watching", "movie"), [], "not Stremio's");
    assert.deepEqual(await row(ctx.env, "lscwcfg", "stremio", "continue-watching", "series"), []);
  });

  it("previews a list as movies and shows together, each with its own type", async () => {
    const ctx = await connected("lsprev");
    const ask = (url, creator = ctx.owner) => call(ctx.env, "/api/preview", { method: "POST", json: { url, type: "mixed", sample: 20, creatorName: creator.creatorName, creatorKey: creator.creatorKey } });
    const r = await ask(`autotrack:nuvio-watch-history:mixed:${ctx.owner.creatorName}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.sample.map((m) => [m.id, m.type]).sort(), [["tt1111111", "movie"], [SHOW, "series"]].sort(), "a show once, not once per episode");
    assert.equal(r.body.count, 2);
    const none = await ask(`autotrack:stremio-watch-history:mixed:${ctx.owner.creatorName}`);
    assert.equal(none.body.count, 0, "only that app's plays");
    const other = await createUser(ctx.env, "lsprevother");
    const denied = await ask(`autotrack:nuvio-watch-history:mixed:${ctx.owner.creatorName}`, other);
    assert.equal(denied.body.count, 0, "another account's key reads nothing");
  });

  it("answers a movies request with movies only and a shows request with shows only, so a card does not list each title twice", async () => {
    const ctx = await connected("lsonce");
    const url = `autotrack:nuvio-watch-history:mixed:${ctx.owner.creatorName}`;
    const ask = (type) => call(ctx.env, "/api/preview", { method: "POST", json: { url, type, sample: 20, creatorName: ctx.owner.creatorName, creatorKey: ctx.owner.creatorKey } });
    assert.deepEqual((await ask("movie")).body.sample.map((m) => m.id), ["tt1111111"]);
    assert.deepEqual((await ask("series")).body.sample.map((m) => m.id), [SHOW]);
    assert.equal((await ask("mixed")).body.sample.length, 2, "and a mixed request still answers both");
  });

  it("previews for a signed-in page that holds a session and no Creator Key", async () => {
    const ctx = await connected("lssess", { FF_EVENT_TRACKING: "1", FF_SESSIONS: "1" });
    const url = `autotrack:nuvio-watch-history:mixed:${ctx.owner.creatorName}`;
    const ask = (cookie) => call(ctx.env, "/api/preview", { method: "POST", cookie, json: { url, type: "mixed", sample: 20, creatorName: ctx.owner.creatorName } });
    const mine = await ask(ctx.cookie);
    assert.equal(mine.body.count, 2, "the session proves whose list it is");
    assert.equal((await ask("")).body.count, 0, "no session, no key: nothing");
    const other = await createUser(ctx.env, "lssessother");
    const r = await call(ctx.env, "/api/session", { method: "POST", json: { username: "lssessother", key: other.creatorKey } });
    const otherCookie = (r.headers.get("set-cookie") || "").split(";")[0];
    assert.equal((await ask(otherCookie)).body.count, 0, "another account's session reads nothing");
  });

  it("reports what the last pull found, and keeps it across a profile change", async () => {
    const ctx = await connected("lsfound");
    const found = async () => (await call(ctx.env, "/api/connections/nuvio/settings", { cookie: ctx.cookie })).body.sync.lastResult;
    assert.deepEqual(await found(), { found: 3, plays: 3, progress: 0, resumes: 2, unresolved: 0 }, "titles, plays, undated progress, part-way, and ones with no usable id");
    await runAgain(ctx, "nuvio");
    assert.deepEqual(await found(), { found: 3, plays: 0, progress: 1, resumes: 1, unresolved: 0 }, "a later pull that changes nothing still says how many titles the app holds");
    await call(ctx.env, "/api/connections/nuvio/settings", { method: "POST", cookie: ctx.cookie, json: { profileIndex: 1 } });
    assert.equal((await found()).found, 3, "choosing a profile does not lose it");
  });

  describe("how far through, and how long is left", () => {
    const ask = (ctx, app, type, creator = ctx.owner) => call(ctx.env, "/api/preview", {
      method: "POST",
      json: { url: `autotrack:${app}-continue-watching:mixed:${creator.creatorName}`, type, sample: 20, creatorName: creator.creatorName, creatorKey: creator.creatorKey },
    }).then((r) => r.body.sample || []);
    const schedule = (ctx) => {
      const mediaId = ctx.env.DB._db.prepare("SELECT id FROM media WHERE imdb_id = ?").get(SHOW).id;
      ctx.env.DB._db.prepare("UPDATE show_schedule SET status = 'Ended', last_aired_season = 1, last_aired_episode = 5, last_aired_date = '2020-01-01', season_episode_counts = '{\"1\":5}', checked_at = 1 WHERE media_id = ?").run(mediaId);
    };

    it("gives a movie and an episode part way through their percentage and the minutes left", async () => {
      const ctx = await connected("lsbar");
      schedule(ctx);
      const movies = await ask(ctx, "nuvio", "movie");
      assert.deepEqual(movies.map((m) => [m.id, m.progress, m.timeLeftMin]), [["tt3333333", 25, 75]], "a quarter of 100 minutes: 75 left");
      const shows = await ask(ctx, "nuvio", "series");
      assert.deepEqual(shows.map((m) => [m.id, m.seasonNum, m.episodeNum, m.progress, m.timeLeftMin]), [[SHOW, 1, 3, 25, 30]], "a quarter of 40 minutes: 30 left");
    });

    it("rounds the minutes left up, so an item with a few seconds under a whole minute does not read one short", async () => {
      const ctx = await connected("lsbarround");
      ctx.state.progress = [{ content_id: "tt3333333", content_type: "movie", name: "Movie Half", position: 1500500, duration: 6000000, last_watched: NOW - 60 * 1000 }];
      await call(ctx.env, "/api/connections/nuvio/sync", { method: "POST", cookie: ctx.cookie, json: { wait: true, force: true } });
      const movies = await ask(ctx, "nuvio", "movie");
      assert.deepEqual(movies.map((m) => [m.progress, m.timeLeftMin]), [[25, 75]], "74.99 minutes left reads 75");
    });

    it("shows no bar for an episode once the show has been watched past it, or for a movie once it is finished", async () => {
      const ctx = await connected("lsbardone");
      schedule(ctx);
      ctx.state.watched.push({ content_id: SHOW, content_type: "series", title: "Show S", season: 1, episode: 3, watched_at: NOW - 60 * 1000 });
      ctx.state.watched.push({ content_id: "tt3333333", content_type: "movie", title: "Movie Half", watched_at: NOW - 60 * 1000 });
      ctx.state.progress = [];
      await call(ctx.env, "/api/connections/nuvio/sync", { method: "POST", cookie: ctx.cookie, json: { wait: true, force: true } });
      const shows = await ask(ctx, "nuvio", "series");
      assert.ok(shows.every((m) => m.progress === undefined && m.timeLeftMin === undefined), JSON.stringify(shows));
      assert.deepEqual(await ask(ctx, "nuvio", "movie"), [], "a finished movie is no longer in Continue Watching");
    });

    it("keeps the bar of an episode only while the show still stands at it", async () => {
      const ctx = await connected("lsbarstale");
      schedule(ctx);
      // The show moves on in another app: the next episode is E4, so E3's numbers do not belong to it.
      const mediaId = ctx.env.DB._db.prepare("SELECT id FROM media WHERE imdb_id = ?").get(SHOW).id;
      ctx.env.DB_ACTIVITY._db.prepare("UPDATE show_progress SET last_episode = 3 WHERE account_id = ? AND media_id = ?").run(ctx.accountId, mediaId);
      const shows = await ask(ctx, "nuvio", "series");
      assert.deepEqual(shows.map((m) => [m.episodeNum, m.progress]), [[4, undefined]]);
    });

    it("does not give Stremio's list Nuvio's numbers, and gives Stremio its own", async () => {
      const ctx = await connected("lsbarapp");
      schedule(ctx);
      assert.deepEqual(await ask(ctx, "stremio", "movie"), []);
      // Stremio's own movie, half watched.
      const lib = [{ _id: "tt8888888", type: "movie", name: "Stremio Half", _mtime: new Date(NOW - HOUR).toISOString(), state: { lastWatched: new Date(NOW - HOUR).toISOString(), timesWatched: 0, duration: 6000000, timeOffset: 3000000 } }];
      ctx.state.approved = true;
      ctx.state.library = lib;
      ctx.state.episodes = {};
      await connectStremio(ctx, ctx.state);
      const movies = await ask(ctx, "stremio", "movie");
      assert.deepEqual(movies.map((m) => [m.id, m.progress, m.timeLeftMin]), [["tt8888888", 50, 50]]);
    });

    it("rebuilds the numbers when the profile changes, and drops them when the account is disconnected", async () => {
      const ctx = await connected("lsbarkeep");
      schedule(ctx);
      const resumes = () => {
        const row = ctx.env.DB._db.prepare("SELECT cursor_json FROM media_app_sync").get();
        return row ? Object.keys(JSON.parse(row.cursor_json || "{}").resumes || {}).sort() : null;
      };
      assert.deepEqual(resumes(), [SHOW, "tt3333333"].sort());
      await call(ctx.env, "/api/connections/nuvio/settings", { method: "POST", cookie: ctx.cookie, json: { profileIndex: 1 } });
      assert.deepEqual(resumes(), [], "another profile's numbers are not kept");
      await call(ctx.env, "/api/connections/nuvio/sync", { method: "POST", cookie: ctx.cookie, json: { wait: true, force: true } });
      assert.deepEqual(resumes(), [SHOW, "tt3333333"].sort(), "the pull of the profile brings them back");
      await call(ctx.env, "/api/connections/nuvio", { method: "DELETE", cookie: ctx.cookie });
      assert.equal(resumes(), null, "gone with the connection");
    });
  });

  it("belongs to its owner alone", async () => {
    const ctx = await connected("lsown");
    const other = await createUser(ctx.env, "lsother");
    // Another account's config naming this account's lists is refused.
    await storeConfig(ctx.env, "lsothercfg", other, ctx.owner.creatorName);
    assert.deepEqual(await row(ctx.env, "lsothercfg", "nuvio", "watch-history", "movie"), []);
    await storeConfig(ctx.env, "lsownercfg", ctx.owner);
    assert.deepEqual(await row(ctx.env, "lsownercfg", "nuvio", "watch-history", "movie"), ["tt1111111"]);
  });

  it("is empty, not the whole history, when the account is not served from the activity database", async () => {
    const ctx = await connected("lsoff", { FF_EVENT_TRACKING: undefined });
    await storeConfig(ctx.env, "lsoffcfg", ctx.owner);
    assert.deepEqual(await row(ctx.env, "lsoffcfg", "nuvio", "watch-history", "movie"), []);
  });
});


// --- Fresh when you look --------------------------------------------------------------

describe("refreshing when the person looks, not only every hour", () => {
  const watchedRows = () => [
    { content_id: "tt1111111", content_type: "movie", title: "Movie A", watched_at: NOW - 30 * HOUR },
    { content_id: SHOW, content_type: "series", title: "Show S", season: 1, episode: 1, watched_at: NOW - 10 * HOUR },
  ];
  const login = (ctx) => call(ctx.env, "/api/connections/nuvio/login", { method: "POST", cookie: ctx.cookie, json: { email: "viewer@example.test", password: "right-password" } });
  const sync = (ctx, body) => call(ctx.env, "/api/connections/nuvio/sync", { method: "POST", cookie: ctx.cookie, json: body });
  const watchedCalls = (seen) => seen.nuvio.filter((c) => c.fn === "sync_pull_watched_items").length;

  it("has the history in place the moment the account is connected, with no job having run", async () => {
    const state = { watched: watchedRows(), progress: [] };
    fakeServices(state);
    const ctx = await setup("freshconn");
    await login(ctx);
    assert.equal(events(ctx.env, ctx.accountId).length, 2, "imported by the connect request itself");
    const settings = await call(ctx.env, "/api/connections/nuvio/settings", { cookie: ctx.cookie });
    assert.equal(settings.body.sync.lastResult.found, 2);
    assert.ok(settings.body.sync.lastPullAt > 0);
  });

  it("brings in a play added in the app since, when asked to wait, and leaves a fresh copy alone otherwise", async () => {
    const state = { watched: watchedRows(), progress: [] };
    const seen = fakeServices(state);
    const ctx = await setup("freshwait");
    await login(ctx);
    state.watched.push({ content_id: "tt4444444", content_type: "movie", title: "Movie New", watched_at: NOW - 60 * 1000 });
    const before = watchedCalls(seen);
    const quiet = await sync(ctx, { wait: true });
    assert.equal(quiet.body.skipped, "fresh", "checked a minute ago: not asked again");
    assert.equal(watchedCalls(seen), before, "no call to Nuvio");
    assert.equal(events(ctx.env, ctx.accountId).length, 2);
    const forced = await sync(ctx, { wait: true, force: true });
    assert.equal(forced.status, 200);
    assert.equal(forced.body.done, true);
    assert.equal(events(ctx.env, ctx.accountId).length, 3, "the new play is in the list when the call returns");
    // And once the copy is two minutes old, an ordinary look refreshes it.
    state.watched.push({ content_id: "tt5555555", content_type: "movie", title: "Movie Newer", watched_at: NOW - 30 * 1000 });
    ctx.env.DB._db.prepare("UPDATE media_app_sync SET last_pull_at = ?").run(Date.now() - 3 * 60 * 1000);
    await sync(ctx, { wait: true });
    assert.equal(events(ctx.env, ctx.accountId).length, 4);
  });

  it("does not run alongside a pull that is already running for the account", async () => {
    const state = { watched: watchedRows(), progress: [] };
    const seen = fakeServices(state);
    const ctx = await setup("freshbusy");
    await login(ctx);
    ctx.env.DB._db.prepare("INSERT INTO jobs (type, dedupe_key, account_id, status, run_after, created_at, updated_at) VALUES ('mediaapp.sync-account', ?, ?, 'running', ?, 1, 1) ON CONFLICT(dedupe_key) DO UPDATE SET status = 'running', run_after = excluded.run_after")
      .run(`mediaapp:${ctx.accountId}:nuvio`, ctx.accountId, Date.now() + 10 * 60 * 1000);
    const before = watchedCalls(seen);
    const r = await sync(ctx, { wait: true, force: true });
    assert.equal(r.body.skipped, "busy");
    assert.equal(watchedCalls(seen), before);
  });

  it("still connects when the first pull fails, and the hourly job tries again", async () => {
    const state = { watched: watchedRows(), progress: [], pullFails: true };
    fakeServices(state);
    const ctx = await setup("freshfail");
    const r = await login(ctx);
    assert.equal(r.status, 200, "the connection is made");
    assert.equal(ctx.env.DB._db.prepare("SELECT status FROM provider_connections WHERE provider = 'nuvio'").get().status, "ok");
    assert.equal(events(ctx.env, ctx.accountId).length, 0);
    state.pullFails = false;
    ctx.env.DB._db.exec("UPDATE jobs SET run_after = 1 WHERE type = 'mediaapp.sync-account'");
    await pull(ctx.env);
    ctx.env.DB._db.exec("UPDATE jobs SET run_after = 1 WHERE dedupe_key = 'periodic:mediaapp.sync'");
    await runScheduledTick(ctx.env);
    await pull(ctx.env);
    assert.equal(events(ctx.env, ctx.accountId).length, 2, "imported by the job instead");
  });

  it("hands what a connect request could not finish to the background job, from where it stopped", async () => {
    const library = Array.from({ length: 300 }, (_, i) => ({
      _id: "tt" + String(7000000 + i), type: "movie", name: "Movie " + i, _mtime: new Date(NOW - i * 1000).toISOString(),
      state: { lastWatched: new Date(NOW - (i + 5) * 3600 * 1000).toISOString(), timesWatched: 1, duration: 100, timeOffset: 100 },
    }));
    const state = { library, episodes: {} };
    const seen = fakeServices(state);
    const ctx = await setup("freshbig");
    await connectStremio(ctx, state);
    const first = events(ctx.env, ctx.accountId).length;
    assert.ok(first > 0 && first < 300, "a bounded part was done in the request: " + first);
    const job = ctx.env.DB._db.prepare("SELECT payload_json FROM jobs WHERE type = 'mediaapp.sync-account'").get();
    assert.ok(JSON.parse(job.payload_json).offset > 0, "the job starts where the request stopped");
    await pull(ctx.env, 6);
    assert.equal(events(ctx.env, ctx.accountId).length, 300);
  });
});


// --- Removing from the app ---------------------------------------------------------------

describe("removing an item from the app, from the website", () => {
  const remove = (ctx, provider, body, cookie = ctx.cookie) => call(ctx.env, `/api/connections/${provider}/remove`, { method: "POST", cookie, json: body });
  const flags = { FF_EVENT_TRACKING: "1", FF_MEDIA_APP_PUSH: "1" };
  const eventsOf = (ctx, source) => ctx.env.DB_ACTIVITY._db.prepare("SELECT media_id, season, episode FROM watch_events WHERE account_id = ? AND source = ?").all(ctx.accountId, source);

  async function nuvio(name, extra = flags) {
    const state = {
      watched: [
        { content_id: "tt1111111", content_type: "movie", title: "Movie A", watched_at: NOW - 30 * HOUR },
        { content_id: SHOW, content_type: "series", title: "Show S", season: 1, episode: 1, watched_at: NOW - 10 * HOUR },
        { content_id: SHOW, content_type: "series", title: "Show S", season: 1, episode: 2, watched_at: NOW - 9 * HOUR },
      ],
      progress: [
        { content_id: "tt3333333", content_type: "movie", name: "Movie Half", position: 1500000, duration: 6000000, last_watched: NOW - 2 * HOUR },
        { content_id: SHOW, content_type: "series", name: "Show S", season: 1, episode: 3, position: 600000, duration: 2400000, last_watched: NOW - HOUR },
      ],
    };
    const seen = fakeServices(state);
    const ctx = await setup(name, extra);
    await call(ctx.env, "/api/connections/nuvio/login", { method: "POST", cookie: ctx.cookie, json: { email: "viewer@example.test", password: "right-password" } });
    await pull(ctx.env);
    const mediaId = (imdb) => ctx.env.DB._db.prepare("SELECT id FROM media WHERE imdb_id = ?").get(imdb).id;
    ctx.env.DB._db.prepare("UPDATE show_schedule SET status = 'Ended', last_aired_season = 1, last_aired_episode = 5, last_aired_date = '2020-01-01', season_episode_counts = '{\"1\":5}', checked_at = 1 WHERE media_id = ?").run(mediaId(SHOW));
    return { ...ctx, state, seen, mediaId };
  }
  const list = (ctx, app, slug, type) => call(ctx.env, "/api/preview", {
    method: "POST",
    json: { url: `autotrack:${app}-${slug}:mixed:${ctx.user.creatorName}`, type, sample: 20, creatorName: ctx.user.creatorName, creatorKey: ctx.user.creatorKey },
  }).then((r) => (r.body.sample || []).map((m) => m.id));

  it("Nuvio, Watch History, a show: every watched episode is deleted there, here, and does not come back", async () => {
    const ctx = await nuvio("rmhist");
    const r = await remove(ctx, "nuvio", { target: "history", id: SHOW, mediaType: "series" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(ctx.seen.deleted.map((k) => [mediaAppId(k), k.season, k.episode]).sort(), [[SHOW, 1, 1], [SHOW, 1, 2]], "both episodes' keys, and nothing of any other title");
    assert.equal(ctx.state.watched.length, 1, "Nuvio keeps its other title");
    assert.equal(eventsOf(ctx, "nuvio").length, 1, "only the movie's play is left here");
    assert.deepEqual(await list(ctx, "nuvio", "watch-history", "series"), []);
    await call(ctx.env, "/api/connections/nuvio/sync", { method: "POST", cookie: ctx.cookie, json: { wait: true, force: true } });
    assert.deepEqual(await list(ctx, "nuvio", "watch-history", "series"), [], "the next pull does not bring it back");
  });

  it("Nuvio, Watch History, a movie: only that movie", async () => {
    const ctx = await nuvio("rmhistmovie");
    // The same film was also played earlier through the subtitles ping: that play is not Nuvio's to remove.
    addEvent(ctx, "tt1111111", "movie", null, null, NOW - 5 * 24 * HOUR, "ping");
    await remove(ctx, "nuvio", { target: "history", id: "tt1111111", mediaType: "movie" });
    assert.equal(eventsOf(ctx, "ping").length, 1, "plays from other sources are kept");
    assert.deepEqual(ctx.seen.deleted.map((k) => mediaAppId(k)), ["tt1111111"]);
    assert.deepEqual(await list(ctx, "nuvio", "watch-history", "movie"), []);
    assert.deepEqual(await list(ctx, "nuvio", "watch-history", "series"), [SHOW]);
  });

  it("Nuvio, Continue Watching: the position is set to zero there, and the item leaves the list, keeping the history", async () => {
    const ctx = await nuvio("rmcw");
    await remove(ctx, "nuvio", { target: "continue-watching", id: "tt3333333", mediaType: "movie" });
    await remove(ctx, "nuvio", { target: "continue-watching", id: SHOW, mediaType: "series" });
    assert.deepEqual(ctx.seen.progressPushed.map((e) => [mediaAppId(e), e.position]).sort(), [[SHOW, 0], ["tt3333333", 0]]);
    assert.ok(ctx.seen.progressPushed.every((e) => e.duration > 0), "the rest of each row is sent as it was read");
    assert.deepEqual(await list(ctx, "nuvio", "continue-watching", "movie"), []);
    assert.deepEqual(await list(ctx, "nuvio", "continue-watching", "series"), []);
    const kept = JSON.parse(ctx.env.DB._db.prepare("SELECT cursor_json FROM media_app_sync").get().cursor_json).resumes || {};
    assert.deepEqual(Object.keys(kept), [], "its bar numbers are gone too");
    assert.equal(eventsOf(ctx, "nuvio").length, 3, "Watch History is not touched");
    await call(ctx.env, "/api/connections/nuvio/sync", { method: "POST", cookie: ctx.cookie, json: { wait: true, force: true } });
    assert.deepEqual(await list(ctx, "nuvio", "continue-watching", "series"), [], "and it stays out after the next pull");
  });

  it("does nothing, and says so, while two-way sync is not switched on for the site", async () => {
    const ctx = await nuvio("rmoff", { FF_EVENT_TRACKING: "1" });
    const r = await remove(ctx, "nuvio", { target: "history", id: "tt1111111", mediaType: "movie" });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /isn't switched on/);
    assert.equal(ctx.seen.deleted, undefined);
    assert.equal(eventsOf(ctx, "nuvio").length, 3);
  });

  it("leaves everything as it was when the app refuses", async () => {
    const ctx = await nuvio("rmfail");
    ctx.state.deleteFails = true;
    const r = await remove(ctx, "nuvio", { target: "history", id: "tt1111111", mediaType: "movie" });
    assert.equal(r.status, 502);
    assert.match(r.body.detail, /Nuvio answered 500/);
    assert.equal(eventsOf(ctx, "nuvio").length, 3, "nothing is deleted here for a removal that did not happen there");
    assert.deepEqual(await list(ctx, "nuvio", "watch-history", "movie"), ["tt1111111"]);
  });

  it("is for the signed-in account's own connection only", async () => {
    const ctx = await nuvio("rmown");
    assert.equal((await remove(ctx, "nuvio", { target: "history", id: "tt1111111", mediaType: "movie" }, "")).status, 401);
    const other = await createUser(ctx.env, "rmother");
    const r = await call(ctx.env, "/api/session", { method: "POST", json: { username: "rmother", key: other.creatorKey } });
    const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
    const denied = await remove(ctx, "nuvio", { target: "history", id: "tt1111111", mediaType: "movie" }, cookie);
    assert.equal(denied.status, 404, "an account with no Nuvio connection removes nothing");
    assert.equal(ctx.seen.deleted, undefined);
    const bad = await remove(ctx, "nuvio", { target: "everything", id: "tt1111111" });
    assert.equal(bad.status, 400);
    const noId = await remove(ctx, "nuvio", { target: "history", id: "not an id" });
    assert.equal(noId.status, 400);
  });

  describe("Stremio", () => {
    const item = (extra = {}) => ({ _id: "tt1111111", type: "movie", name: "Movie A", poster: "https://img.test/a.jpg", _mtime: new Date(NOW - 50 * HOUR).toISOString(),
      state: { lastWatched: new Date(NOW - 30 * HOUR).toISOString(), timesWatched: 1, flaggedWatched: 1, duration: 7200000, timeOffset: 7000000 }, ...extra });
    async function stremio(name, library) {
      const state = { approved: true, library, episodes: { [SHOW]: SHOW_EPS } };
      const seen = fakeServices(state);
      const ctx = await setup(name, flags);
      await connectStremio(ctx, state);
      return { ...ctx, state, seen };
    }

    it("History, a movie: marked unwatched and its position cleared, keeping the rest of the item, and it stays out after a pull", async () => {
      const ctx = await stremio("rmsthist", [item()]);
      assert.equal(eventsOf(ctx, "stremio").length, 1);
      const r = await remove(ctx, "stremio", { target: "history", id: "tt1111111", mediaType: "movie" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const sent = ctx.seen.puts[0][0];
      assert.deepEqual([sent.state.timesWatched, sent.state.flaggedWatched, sent.state.timeOffset], [0, 0, 0]);
      assert.deepEqual([sent.name, sent.poster], ["Movie A", "https://img.test/a.jpg"], "the library item is otherwise as it was");
      assert.ok(Date.parse(sent._mtime) > Date.parse(item()._mtime));
      assert.equal(eventsOf(ctx, "stremio").length, 0);
      await call(ctx.env, "/api/connections/stremio/sync", { method: "POST", cookie: ctx.cookie, json: { wait: true, force: true } });
      assert.equal(eventsOf(ctx, "stremio").length, 0, "not brought back");
    });

    it("History, a show: every watched mark is cleared", async () => {
      const lib = [{ _id: SHOW, type: "series", name: "Show S", _mtime: new Date(NOW - 5 * HOUR).toISOString(),
        state: { video_id: `${SHOW}:1:3`, lastWatched: new Date(NOW - 5 * HOUR).toISOString(), duration: 2400000, timeOffset: 2390000, timesWatched: 1, watched: bitfield(SHOW_EPS, [0, 1, 2]) } }];
      const ctx = await stremio("rmstshow", lib);
      await remove(ctx, "stremio", { target: "history", id: SHOW, mediaType: "series" });
      const sent = ctx.seen.puts[0][0];
      assert.ok(!sent.state.watched, "no watched bits left");
      assert.equal(sent.state.timeOffset, 0);
      await call(ctx.env, "/api/connections/stremio/sync", { method: "POST", cookie: ctx.cookie, json: { wait: true, force: true } });
      assert.equal(eventsOf(ctx, "stremio").length, 0);
    });

    it("Continue Watching: only the position is cleared, so the movie stays in Watch History", async () => {
      const ctx = await stremio("rmstcw", [item({ state: { lastWatched: new Date(NOW - HOUR).toISOString(), timesWatched: 1, flaggedWatched: 0, duration: 7200000, timeOffset: 3600000 } })]);
      await remove(ctx, "stremio", { target: "continue-watching", id: "tt1111111", mediaType: "movie" });
      const sent = ctx.seen.puts[0][0];
      assert.equal(sent.state.timeOffset, 0);
      assert.equal(sent.state.timesWatched, 1, "its Watch History is kept");
    });

    it("says what happened when Stremio does not accept it, and keeps what is here", async () => {
      const ctx = await stremio("rmstfail", [item()]);
      ctx.state.putFails = true;
      const r = await remove(ctx, "stremio", { target: "history", id: "tt1111111", mediaType: "movie" });
      assert.equal(r.status, 502);
      assert.equal(eventsOf(ctx, "stremio").length, 1);
    });

    it("says it is not in the library when it is not", async () => {
      const ctx = await stremio("rmstmiss", [item()]);
      const r = await remove(ctx, "stremio", { target: "history", id: "tt9999999", mediaType: "movie" });
      assert.equal(r.status, 404);
      assert.equal(ctx.seen.puts.length, 0);
    });
  });
});

describe("marking something watched on the website reaches the app soon", () => {
  it("starts a push for each app with two-way sync on, when the website records a new play", async () => {
    const state = { watched: [{ content_id: "tt1111111", content_type: "movie", title: "Movie A", watched_at: NOW - 30 * HOUR }], progress: [] };
    const seen = fakeServices(state);
    const ctx = await setup("nudge", { FF_EVENT_TRACKING: "1", FF_MEDIA_APP_PUSH: "1" });
    await call(ctx.env, "/api/connections/nuvio/login", { method: "POST", cookie: ctx.cookie, json: { email: "viewer@example.test", password: "right-password" } });
    await call(ctx.env, "/api/connections/nuvio/settings", { method: "POST", cookie: ctx.cookie, json: { push: true } });
    await pull(ctx.env, 3);
    ctx.env.DB._db.exec("UPDATE jobs SET status = 'done' WHERE type = 'mediaapp.sync-account'");
    const saved = await call(ctx.env, "/api/creator/sync/save-tracking", {
      method: "POST",
      json: { creatorName: ctx.user.creatorName, creatorKey: ctx.user.creatorKey, watchHistory: [{ id: "tt5555555", type: "movie", name: "Movie Site", title: "Movie Site", watchedAt: Date.now() - 1000 }], updatedAt: Date.now() },
    });
    assert.equal(saved.body.ok, true, JSON.stringify(saved.body));
    const job = ctx.env.DB._db.prepare("SELECT status FROM jobs WHERE type = 'mediaapp.sync-account'").get();
    assert.notEqual(job.status, "done", "a push job is waiting");
    await pull(ctx.env, 3);
    assert.deepEqual(seen.pushed.map((p) => p.content_id), ["tt5555555"], "the play reached Nuvio without waiting for the hourly job");
  });

  it("starts nothing when no app has two-way sync on", async () => {
    const state = { watched: [], progress: [] };
    fakeServices(state);
    const ctx = await setup("nudgeoff", { FF_EVENT_TRACKING: "1", FF_MEDIA_APP_PUSH: "1" });
    await call(ctx.env, "/api/connections/nuvio/login", { method: "POST", cookie: ctx.cookie, json: { email: "viewer@example.test", password: "right-password" } });
    await pull(ctx.env, 2);
    ctx.env.DB._db.exec("UPDATE jobs SET status = 'done' WHERE type = 'mediaapp.sync-account'");
    await call(ctx.env, "/api/creator/sync/save-tracking", {
      method: "POST",
      json: { creatorName: ctx.user.creatorName, creatorKey: ctx.user.creatorKey, watchHistory: [{ id: "tt5555555", type: "movie", name: "Movie Site", title: "Movie Site", watchedAt: Date.now() - 1000 }], updatedAt: Date.now() },
    });
    assert.equal(ctx.env.DB._db.prepare("SELECT status FROM jobs WHERE type = 'mediaapp.sync-account'").all().filter((j) => j.status !== "done").length, 0);
  });
});


// --- Pushing collections to Nuvio ------------------------------------------------

describe("Nuvio collections push: install modes", () => {
  const STREAMING = { id: "community-streaming", title: "Streaming", folders: [{ id: "f_netflix", title: "Netflix", catalogSources: [{ addonId: "other", catalogId: "nf", type: "movie" }] }] };
  const OTHER = { id: "community-other", title: "Other Provider", folders: [{ id: "f_o", title: "Other", catalogSources: [{ addonId: "other", catalogId: "o", type: "movie" }] }] };
  const incoming = () => [{ id: "my-lists-collections", title: "My Lists Collections", folders: [{ id: "f_mine", title: "Mine", catalogSources: [{ addonId: "app.my-list", catalogId: "mine", name: "Mine (Movies)", type: "movie" }] }] }];

  async function push(mode, extra = {}) {
    const state = { watched: [], progress: [], profiles: [{ profile_index: 1, name: "Main", collections_json: [STREAMING, OTHER] }] };
    const seen = fakeServices(state);
    const ctx = await setup("nuvcol" + mode + Math.random().toString(36).slice(2, 6));
    const login = await call(ctx.env, "/api/connections/nuvio/login", { method: "POST", cookie: ctx.cookie, json: { email: "viewer@example.test", password: "right-password" } });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const r = await call(ctx.env, "/api/connections/nuvio/collections", { method: "POST", cookie: ctx.cookie, json: { profileId: 1, installMode: mode, collections: incoming(), manifestUrl: "https://x.test/manifest.json", ...extra } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { pushed: seen.collectionsPushed[0], body: r.body };
  }

  it("new: adds a separately named collection and keeps every existing one", async () => {
    const { pushed } = await push("new", { collectionName: "Weekend Picks" });
    assert.deepEqual(pushed.map((c) => c.title), ["Streaming", "Other Provider", "Weekend Picks"]);
    assert.deepEqual(pushed[0], STREAMING, "another provider's collection is untouched");
    assert.notEqual(pushed[2].id, "community-streaming");
  });

  it("every collection My Lists writes carries the My Lists logo as its backdrop", async () => {
    const { pushed } = await push("new");
    assert.match(pushed[2].backdropImageUrl, /\/icon\.png$/);
  });

  it("merge: folders go only into the collection that was picked", async () => {
    const { pushed } = await push("merge", { targetCollectionId: "community-other" });
    assert.deepEqual(pushed[0], STREAMING);
    assert.deepEqual(pushed[1].folders.map((f) => f.id), ["f_o", "f_mine"]);
    assert.equal(pushed[1].title, "Other Provider", "the picked collection is not renamed");
    assert.equal(pushed[1].folders[1].catalogSources[0].name, "Mine");
  });

  it("merge: a collection that is no longer in Nuvio is refused, nothing is pushed", async () => {
    const state = { watched: [], progress: [], profiles: [{ profile_index: 1, name: "Main", collections_json: [STREAMING] }] };
    const seen = fakeServices(state);
    const ctx = await setup("nuvcolgone");
    await call(ctx.env, "/api/connections/nuvio/login", { method: "POST", cookie: ctx.cookie, json: { email: "viewer@example.test", password: "right-password" } });
    const r = await call(ctx.env, "/api/connections/nuvio/collections", { method: "POST", cookie: ctx.cookie, json: { profileId: 1, installMode: "merge", targetCollectionId: "gone", collections: incoming() } });
    assert.equal(r.status, 400);
    assert.equal(seen.collectionsPushed, undefined);
  });

  it("replace: only the pushed collection is left", async () => {
    const { pushed } = await push("replace");
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].folders[0].id, "f_mine");
  });
});
