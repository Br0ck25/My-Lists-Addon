// Stremio and Nuvio accounts (src/api/61_media-app-sync.js): connect, then pull the
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
      (seen.stremioCalls = seen.stremioCalls || []).push({ method, body });
      if (method === "addonCollectionGet" && state.stremioAddons) {
        if (state.addonsMalformed) return json({ result: { addons: "nope" } });
        for (const u of body.addFromURL || []) if (!state.addFromUrlIgnored && !state.stremioAddons.some((x) => x.transportUrl === u)) state.stremioAddons.push({ transportUrl: u, transportName: "http", manifest: { id: "app.my-list", name: "My Lists" }, flags: {} });
        return json({ result: { addons: state.stremioAddons, lastModified: new Date().toISOString() } });
      }
      if (method === "addonCollectionSet") return json({ result: { success: true } });
      if (state.stremioRateLimited > 0) { state.stremioRateLimited--; return new Response("{}", { status: 429, headers: { "retry-after": "0" } }); }
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
          if (i >= 0) state.library[i] = c; else state.library.push(c);
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
      if (url.pathname === "/functions/v1/health-check") {
        seen.healthChecks = (seen.healthChecks || 0) + 1;
        return state.health ? json({ status: state.health, database: "connected", latency_ms: 40 }, state.health === "down" ? 503 : 200) : new Response("{}", { status: 404 });
      }
      if (url.pathname === "/auth/v1/logout") {
        seen.nuvioLogouts = (seen.nuvioLogouts || []).concat([{ auth: new Headers(init.headers || {}).get("authorization"), apikey: new Headers(init.headers || {}).get("apikey") }]);
        return new Response(null, { status: state.logoutFails ? 500 : 204 });
      }
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
      if (url.pathname === "/rest/v1/addons") {
        const profileId = Number(url.searchParams.get("profile_id").replace("eq.", ""));
        seen.addonReads = (seen.addonReads || []).concat(profileId);
        if (state.addonsReadFails) return json({ message: "boom" }, 500);
        return json(state.addonsResponse !== undefined ? state.addonsResponse : ((state.addonsByProfile || {})[profileId] || state.addons || []));
      }
      if (url.pathname.startsWith("/rest/v1/rpc/")) {
        const fn = url.pathname.split("/").pop();
        const auth = new Headers(init.headers || {}).get("authorization");
        seen.nuvio.push({ fn, auth, body });
        if (state.nuvioRejects || auth !== "Bearer " + state.nuvioToken) return json({ message: "JWT expired" }, 401);
        if (state.rateLimited > 0) { state.rateLimited--; return new Response("{}", { status: 429, headers: { "retry-after": "0" } }); }
        if (state.rpcStatus && state.rpcStatus[fn]) return json({ message: "no" }, state.rpcStatus[fn]);
        // The documented shape: profile rows carry no collections; those come from sync_pull_collections.
        if (fn === "sync_pull_profiles") return json((state.profiles || [{ profile_index: 1, name: "Main" }]).map(({ collections_json, ...profile }) => profile));
        if (fn === "sync_pull_collections") {
          if (state.collectionsPullFails) return json({ message: "boom" }, 500);
          const p = (state.profiles || []).find((r) => r.profile_index === body.p_profile_id);
          return json(p && p.collections_json ? [{ profile_id: p.profile_index, collections_json: p.collections_json, updated_at: "2026-01-01T00:00:00Z" }] : []);
        }
        if (fn === "get_sync_overview" && state.overview) return state.overviewFails ? json({ message: "boom" }, 500) : json(state.overview);
        if (fn === "sync_get_library_delta_cursor") return json(state.libraryCursor || 0);
        if (fn === "sync_pull_library") {
          if (state.libraryReadFails) return json({ message: "boom" }, 500);
          return json((state.nuvioLibrary || []).slice(body.p_offset, body.p_offset + body.p_limit));
        }
        if (fn === "sync_pull_library_delta") return json((state.libraryDelta || []).filter((e) => e.event_id > body.p_since_event_id).slice(0, body.p_limit));
        if (fn === "sync_push_library_items") {
          if (state.libraryWriteFails) return json({ message: "boom" }, 500);
          seen.libraryPushed = (seen.libraryPushed || []).concat(body.p_items);
          state.nuvioLibrary = (state.nuvioLibrary || []).concat(body.p_items);
          return new Response(null, { status: 204 });
        }
        if (fn === "sync_delete_library_items") {
          if (state.libraryWriteFails) return json({ message: "boom" }, 500);
          seen.libraryDeleted = (seen.libraryDeleted || []).concat(body.p_keys);
          state.nuvioLibrary = (state.nuvioLibrary || []).filter((r) => !body.p_keys.some((k) => k.content_id === r.content_id && k.content_type === r.content_type));
          return new Response(null, { status: 204 });
        }
        if (fn === "sync_pull_watched_items") return state.pullFails ? json({ message: "boom" }, 500) : json((state.watched || []).slice((body.p_page - 1) * body.p_page_size, body.p_page * body.p_page_size));
        if (fn === "sync_pull_watch_progress") {
          const all = state.progress || [];
          const range = new Headers(init.headers || {}).get("range");
          const match = /^(\d+)-(\d+)$/.exec(range || "");
          const start = match ? Number(match[1]) : 0, end = match ? Number(match[2]) : all.length - 1;
          seen.nuvio[seen.nuvio.length - 1].range = range;
          if (state.ignoreProgressRange) return json(all.slice(0, 500));
          if (match && start >= all.length && all.length) return new Response("", { status: 416, headers: { "Content-Range": `*/${all.length}` } });
          return new Response(JSON.stringify(all.slice(start, end + 1)), { status: 200, headers: { "content-type": "application/json", "content-range": `${start}-${Math.min(end, all.length - 1)}/${all.length}` } });
        }
        // The documented incremental endpoints. Only answered when a test sets *Events, so older tests see none.
        if (fn === "sync_get_watched_items_delta_cursor" && state.historyEvents) return json(state.historyCursor ?? Math.max(0, ...state.historyEvents.map((e) => e.event_id)));
        if (fn === "sync_get_watch_progress_delta_cursor" && state.progressEvents) return json(state.progressCursor ?? Math.max(0, ...state.progressEvents.map((e) => e.event_id)));
        if ((fn === "sync_pull_watched_items_delta" && state.historyEvents) || (fn === "sync_pull_watch_progress_delta" && state.progressEvents)) {
          if (state.deltaFails) return json({ message: "boom" }, 500);
          const all = fn === "sync_pull_watched_items_delta" ? state.historyEvents : state.progressEvents;
          return json(all.filter((e) => e.event_id > body.p_since_event_id).slice(0, Math.min(body.p_limit, 1000)));
        }
        if (fn === "sync_delete_watched_items") {
          if (state.deleteFails) return json({ message: "boom" }, 500);
          seen.deleted = (seen.deleted || []).concat(body.p_keys);
          const same = (w, k) => String(mediaAppId(w)) === String(mediaAppId(k)) && (w.season ?? null) === (k.season ?? null) && (w.episode ?? null) === (k.episode ?? null);
          state.watched = (state.watched || []).filter((w) => !body.p_keys.some((k) => same(w, k)));
          return new Response(null, { status: 204 });
        }
        if (fn === "sync_delete_watch_progress") {
          if (state.deleteFails) return json({ message: "boom" }, 500);
          seen.progressDeleted = (seen.progressDeleted || []).concat(body.p_keys);
          state.progress = (state.progress || []).filter((p) => {
            const id = mediaAppId(p);
            const key = p.season != null && p.episode != null ? `${id}_s${p.season}e${p.episode}` : id;
            return !body.p_keys.includes(key);
          });
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
        if (fn === "sync_pull_home_catalog_settings") {
          if (state.homeReadFails || (state.homeReadbackFails && seen.homePushed)) return json({ message: "boom" }, 500);
          if (state.homeByPlatform) {
            if (state.homeFailPlatform === body.p_platform) return json({ message: "boom" }, 500);
            return json(state.homeByPlatform[body.p_platform] || []);
          }
          return json(state.homeRows || []);
        }
        if (fn === "sync_push_home_catalog_settings") {
          if (state.homeWriteFails) return json({ message: "boom" }, 500);
          seen.homePushed = body;
          if (!state.homeWriteIgnored) state.homeRows = [{ profile_id: body.p_profile_id, settings_json: structuredClone(body.p_settings_json) }];
          return new Response(null, { status: 204 });
        }
        if (fn === "sync_push_addons") {
          if (state.addonsWriteFails) return json({ message: "boom" }, 500);
          seen.addonsPushed = body;
          state.addonsByProfile = { ...state.addonsByProfile, [body.p_profile_id]: structuredClone(body.p_addons) };
          return new Response(null, { status: 204 });
        }
        if (fn === "sync_push_collections") {
          seen.collectionsPushed = (seen.collectionsPushed || []).concat([body.p_collections_json]);
          const profile = (state.profiles || []).find((p) => p.profile_index === body.p_profile_id);
          if (profile) profile.collections_json = structuredClone(body.p_collections_json);
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

  it("sends plays using the documented Nuvio format and not ones it already has", async () => {
    const { seen, ctx } = await ready("nuvpush", rows("snake"));
    assert.equal(seen.pushed.length, 0, "nothing of Nuvio's own is sent back");
    addEvent(ctx, "tt1111111", "movie", null, null, NOW - 29 * HOUR);
    addEvent(ctx, "tt5555555", "movie", null, null, NOW - 2 * HOUR);
    addEvent(ctx, SHOW, "series", 1, 2, NOW - HOUR);
    await runAgain(ctx, "nuvio");
    assert.deepEqual(seen.pushed.map((p) => [p.content_id, p.content_type, p.season, p.episode]), [["tt5555555", "movie", undefined, undefined], [SHOW, "series", 1, 2]], "the movie Nuvio has is skipped");
    assert.equal(seen.pushed[0].watched_at, NOW - 2 * HOUR, "the API uses milliseconds");
    assert.equal(seen.pushed[0].title, "Title tt5555555");
    seen.pushed.length = 0;
    await runAgain(ctx, "nuvio");
    assert.equal(seen.pushed.length, 0, "each play is sent once");
  });

  it("writes the documented snake_case even when incoming rows use camelCase", async () => {
    const { seen, ctx } = await ready("nuvcamel", rows("camel"));
    addEvent(ctx, "tt5555555", "movie", null, null, NOW - 2 * HOUR);
    await runAgain(ctx, "nuvio");
    assert.deepEqual(Object.keys(seen.pushed[0]).sort(), ["content_id", "content_type", "title", "watched_at"]);
    assert.equal(seen.pushed[0].watched_at, NOW - 2 * HOUR);
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

  it("sends a first play to an empty Nuvio history", async () => {
    const { seen, ctx } = await ready("nuvempty", []);
    addEvent(ctx, "tt5555555", "movie", null, null, NOW - HOUR);
    await runAgain(ctx, "nuvio");
    assert.equal(seen.pushed.length, 1);
    assert.equal(seen.pushed[0].content_id, "tt5555555");
    assert.equal(seen.pushed[0].watched_at, NOW - HOUR);
    assert.ok(cursorOf(ctx).pushedId > 0);
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
    assert.match(r.body.detail, /Stremio had a problem \(500\)/, "the status stays in the message");
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

  it("retains Nuvio provenance on a play already recorded by another source without duplicating it", async () => {
    const state = { watched: [{ content_id: "tt7777777", content_type: "movie", title: "Shared Film", watched_at: NOW - HOUR }], progress: [] };
    const seen = fakeServices(state);
    const ctx = await setup("nuvprovenance", { FF_EVENT_TRACKING: "1", FF_MEDIA_APP_PUSH: "1" });
    ctx.owner = ctx.user;
    addEvent(ctx, "tt7777777", "movie", null, null, NOW - 2 * HOUR, "ping");
    await call(ctx.env, "/api/connections/nuvio/login", { method: "POST", cookie: ctx.cookie, json: { email: "viewer@example.test", password: "right-password" } });
    await pull(ctx.env);
    await storeConfig(ctx.env, "nuvprov", ctx.owner);
    assert.deepEqual(await row(ctx.env, "nuvprov", "nuvio", "watch-history", "movie"), ["tt7777777"]);
    assert.equal(events(ctx.env, ctx.accountId).length, 1, "the global play is not duplicated");
    const link = ctx.env.DB_ACTIVITY._db.prepare("SELECT source, watched_at FROM watch_event_sources").get();
    assert.equal(link.source, "nuvio");
    assert.equal(link.watched_at, NOW - HOUR, "Nuvio's own watch time is preserved");
    await call(ctx.env, "/api/connections/nuvio/settings", { method: "POST", cookie: ctx.cookie, json: { push: true } });
    await pull(ctx.env);
    assert.equal(seen.pushed.length, 0, "a linked play is not pushed back to Nuvio");
    const removed = await call(ctx.env, "/api/connections/nuvio/remove", { method: "POST", cookie: ctx.cookie, json: { target: "history", id: "tt7777777", mediaType: "movie" } });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(events(ctx.env, ctx.accountId).length, 1, "removing Nuvio history preserves the ping");
    assert.equal(events(ctx.env, ctx.accountId)[0].source, "ping");
    assert.deepEqual(await row(ctx.env, "nuvprov", "nuvio", "watch-history", "movie"), []);
  });

  it("backfills links for an old Nuvio play when upgrading from an incremental cursor", async () => {
    const state = { watched: [], progress: [] };
    fakeServices(state);
    const ctx = await setup("nuvprovenanceupgrade", { FF_EVENT_TRACKING: "1" });
    ctx.owner = ctx.user;
    addEvent(ctx, "tt8888888", "movie", null, null, NOW - 100 * HOUR, "ping");
    await call(ctx.env, "/api/connections/nuvio/login", { method: "POST", cookie: ctx.cookie, json: { email: "viewer@example.test", password: "right-password" } });
    state.watched.push({ content_id: "tt8888888", content_type: "movie", title: "Old Film", watched_at: NOW - 99 * HOUR });
    ctx.env.DB._db.prepare("UPDATE media_app_sync SET cursor_json = ? WHERE provider = 'nuvio'").run(JSON.stringify({ mtime: NOW }));
    await runAgain(ctx, "nuvio");
    await storeConfig(ctx.env, "nuvprovold", ctx.owner);
    assert.deepEqual(await row(ctx.env, "nuvprovold", "nuvio", "watch-history", "movie"), ["tt8888888"]);
    assert.equal(events(ctx.env, ctx.accountId).length, 1);
    const cursor = JSON.parse(ctx.env.DB._db.prepare("SELECT cursor_json FROM media_app_sync WHERE provider = 'nuvio'").get().cursor_json);
    assert.equal(cursor.provenanceVersion, 1);
  });

  it("preserves a linked second app when the originating Nuvio history is removed", async () => {
    const ctx = await connected("nuvtransfer", { FF_EVENT_TRACKING: "1", FF_MEDIA_APP_PUSH: "1" });
    const event = ctx.env.DB_ACTIVITY._db.prepare("SELECT id FROM watch_events WHERE account_id = ? AND source = 'nuvio' AND season IS NULL").get(ctx.accountId);
    ctx.env.DB_ACTIVITY._db.prepare("INSERT INTO watch_event_sources (event_id, source, watched_at) VALUES (?, 'stremio', ?)").run(event.id, NOW - HOUR);
    const result = await call(ctx.env, "/api/connections/nuvio/remove", { method: "POST", cookie: ctx.cookie, json: { target: "history", id: "tt1111111", mediaType: "movie" } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    await storeConfig(ctx.env, "nuvtranscfg", ctx.owner);
    assert.deepEqual(await row(ctx.env, "nuvtranscfg", "nuvio", "watch-history", "movie"), []);
    assert.deepEqual(await row(ctx.env, "nuvtranscfg", "stremio", "watch-history", "movie"), ["tt1111111"]);
  });

  it("shows a Nuvio resume for a first episode without watch events or a schedule, and drops it when removed remotely", async () => {
    const state = { watched: [], progress: [{ content_id: SHOW, content_type: "series", season: 1, episode: 1, position: 600000, duration: 2400000, last_watched: NOW - HOUR }] };
    fakeServices(state);
    const ctx = await setup("nuvnoschedule", { FF_EVENT_TRACKING: "1" });
    ctx.owner = ctx.user;
    await call(ctx.env, "/api/connections/nuvio/login", { method: "POST", cookie: ctx.cookie, json: { email: "viewer@example.test", password: "right-password" } });
    await pull(ctx.env);
    const ask = () => call(ctx.env, "/api/preview", { method: "POST", json: { url: `autotrack:nuvio-continue-watching:mixed:${ctx.owner.creatorName}`, type: "series", sample: 20, creatorName: ctx.owner.creatorName, creatorKey: ctx.owner.creatorKey } });
    const first = (await ask()).body.sample;
    assert.deepEqual(first.map((m) => [m.id, m.seasonNum, m.episodeNum, m.progress]), [[SHOW, 1, 1, 25]]);
    assert.equal(events(ctx.env, ctx.accountId).length, 0);
    state.progress = [];
    const sync = await call(ctx.env, "/api/connections/nuvio/sync", { method: "POST", cookie: ctx.cookie, json: { wait: true, force: true } });
    assert.equal(sync.status, 200);
    assert.deepEqual((await ask()).body.sample, [], "a disappeared remote resume does not linger");
  });

  it("keeps separate resume points for a movie and show sharing a TMDB number", async () => {
    const state = { watched: [], progress: [
      { content_id: "tmdb:550", content_type: "movie", position: 1000, duration: 4000, last_watched: NOW - HOUR },
      { content_id: "tmdb:550", content_type: "series", season: 1, episode: 1, position: 2000, duration: 4000, last_watched: NOW - 2 * HOUR },
    ] };
    fakeServices(state);
    const ctx = await setup("nuvcwcollision", { FF_EVENT_TRACKING: "1", FF_MEDIA_APP_PUSH: "1" });
    ctx.owner = ctx.user;
    await call(ctx.env, "/api/connections/nuvio/login", { method: "POST", cookie: ctx.cookie, json: { email: "viewer@example.test", password: "right-password" } });
    const ask = (type) => call(ctx.env, "/api/preview", { method: "POST", json: { url: `autotrack:nuvio-continue-watching:mixed:${ctx.owner.creatorName}`, type, sample: 20, creatorName: ctx.owner.creatorName, creatorKey: ctx.owner.creatorKey } });
    assert.deepEqual((await ask("movie")).body.sample.map((m) => [m.type, m.progress]), [["movie", 25]]);
    assert.deepEqual((await ask("series")).body.sample.map((m) => [m.type, m.progress]), [["series", 50]]);
    const refused = await call(ctx.env, "/api/connections/nuvio/remove", { method: "POST", cookie: ctx.cookie, json: { target: "continue-watching", id: "tmdb:550" } });
    assert.equal(refused.status, 400, "ambiguous removal requires a media type");
    const removed = await call(ctx.env, "/api/connections/nuvio/remove", { method: "POST", cookie: ctx.cookie, json: { target: "continue-watching", id: "tmdb:550", mediaType: "movie" } });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual((await ask("movie")).body.sample, []);
    assert.deepEqual((await ask("series")).body.sample.map((m) => [m.type, m.progress]), [["series", 50]]);
    assert.deepEqual(state.progress.map((p) => p.content_type), ["series"]);
  });

  it("requires the provenance migration rather than advancing the Nuvio cursor without it", async () => {
    const state = { watched: [{ content_id: "tt7777777", content_type: "movie", title: "Film", watched_at: NOW - HOUR }], progress: [] };
    fakeServices(state);
    const ctx = await setup("nuvmigration", { FF_EVENT_TRACKING: "1" });
    ctx.env.DB_ACTIVITY._db.exec("DROP TABLE watch_event_sources; DELETE FROM schema_migrations WHERE version = 'A0002'");
    await call(ctx.env, "/api/connections/nuvio/login", { method: "POST", cookie: ctx.cookie, json: { email: "viewer@example.test", password: "right-password" } });
    const settings = await call(ctx.env, "/api/connections/nuvio/settings", { cookie: ctx.cookie });
    assert.match(settings.body.sync.error, /A0002/);
    assert.equal(events(ctx.env, ctx.accountId).length, 0);
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

  it("removes one episode from Nuvio and from here, and nothing else of the show", async () => {
    const ctx = await connected("lsepremove", { FF_EVENT_TRACKING: "1", FF_MEDIA_APP_PUSH: "1" });
    const ask = () => call(ctx.env, "/api/preview", { method: "POST", json: { url: `autotrack:nuvio-watch-episodes:mixed:${ctx.owner.creatorName}`, type: "mixed", sample: 20, creatorName: ctx.owner.creatorName, creatorKey: ctx.owner.creatorKey } });
    assert.deepEqual((await ask()).body.sample.map((m) => m.episodeNum).sort(), [1, 2]);
    const r = await call(ctx.env, "/api/connections/nuvio/remove", { method: "POST", cookie: ctx.cookie, json: { target: "history", id: SHOW, mediaType: "series", season: 1, episode: 1 } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.removedInApp, true);
    assert.deepEqual(ctx.state.watched.map((w) => [w.content_id, w.season ?? null, w.episode ?? null]).sort(), [[SHOW, 1, 2], ["tt1111111", null, null]].sort(), "only S1E1 left Nuvio");
    assert.deepEqual((await ask()).body.sample.map((m) => m.episodeNum), [2], "and only that episode left the list here");
    assert.ok(events(ctx.env, ctx.accountId).some((e) => e.imdb === SHOW && e.episode === 2), "the other episode's play is still recorded");
    const cursor = JSON.parse(ctx.env.DB._db.prepare("SELECT cursor_json FROM media_app_sync WHERE provider = 'nuvio'").get().cursor_json);
    assert.ok(cursor.resumes[SHOW], "the show's Continue Watching point is not touched by removing a watched episode");
  });

  it("asks for a season and an episode together, and only for Watch History", async () => {
    const ctx = await connected("lsepbad", { FF_EVENT_TRACKING: "1", FF_MEDIA_APP_PUSH: "1" });
    const remove = (provider, json) => call(ctx.env, `/api/connections/${provider}/remove`, { method: "POST", cookie: ctx.cookie, json });
    assert.equal((await remove("nuvio", { target: "history", id: SHOW, mediaType: "series", season: 1 })).status, 400, "a season alone");
    assert.equal((await remove("nuvio", { target: "continue-watching", id: SHOW, mediaType: "series", season: 1, episode: 3 })).status, 400, "not for Continue Watching");
    assert.equal((await remove("stremio", { target: "continue-watching", id: SHOW, mediaType: "series", season: 1, episode: 1 })).status, 400, "not for Continue Watching on Stremio either");
    assert.equal(ctx.state.watched.length, 3, "nothing was removed by any of them");
  });

  it("lists every watched episode, not one tile per show, from the app's episodes list", async () => {
    const ctx = await connected("lsepisodes");
    const ask = (url, creator = ctx.owner) => call(ctx.env, "/api/preview", { method: "POST", json: { url, type: "mixed", sample: 20, creatorName: creator.creatorName, creatorKey: creator.creatorKey } });
    const r = await ask(`autotrack:nuvio-watch-episodes:mixed:${ctx.owner.creatorName}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.sample.map((m) => [m.id, m.showId, m.seasonNum, m.episodeNum]).sort(), [[`${SHOW}:1:1`, SHOW, 1, 1], [`${SHOW}:1:2`, SHOW, 1, 2]], "each episode on its own, no movies");
    assert.equal(r.body.count, 2);
    assert.ok(r.body.sample.every((m) => m.showTitle), "the tile can name its show");
    const byEp = Object.fromEntries(r.body.sample.map((m) => [m.episodeNum, m]));
    assert.equal(byEp[2].name, `${byEp[2].showTitle} S01E02`, "the tile says which episode, as the main Watch History does");
    assert.equal(byEp[2].subtitle, undefined, "a generic 'Episode 2' name is not repeated as a subtitle");
    // A named episode keeps its own title as the subtitle.
    ctx.env.DB._db.prepare("INSERT INTO media_episodes (media_id, season, episode, title, updated_at) VALUES (?, 1, 2, 'The Second One', 1)").run(ctx.env.DB._db.prepare("SELECT id FROM media WHERE imdb_id = ?").get(SHOW).id);
    const named = await ask(`autotrack:nuvio-watch-episodes:mixed:${ctx.owner.creatorName}`);
    assert.equal(Object.fromEntries(named.body.sample.map((m) => [m.episodeNum, m]))[2].subtitle, "The Second One");
    assert.equal((await ask(`autotrack:stremio-watch-episodes:mixed:${ctx.owner.creatorName}`)).body.count, 0, "only that app's plays");
    const other = await createUser(ctx.env, "lsepiother");
    assert.equal((await ask(`autotrack:nuvio-watch-episodes:mixed:${ctx.owner.creatorName}`, other)).body.count, 0, "another account's key reads nothing");
  });

  it("pages all app history beyond the first 100 plays without repeating titles", async () => {
    const ctx = await connected("lspages");
    for (let i = 0; i < 120; i++) addEvent(ctx, `tt${String(2000000 + i)}`, "movie", null, null, NOW - i * 1000, "nuvio");
    const url = `autotrack:nuvio-watch-history:mixed:${ctx.owner.creatorName}`;
    const ask = (skip) => call(ctx.env, "/api/preview", { method: "POST", json: { url, type: "mixed", skip, sample: 100, creatorName: ctx.owner.creatorName, creatorKey: ctx.owner.creatorKey } });
    const first = (await ask(0)).body;
    const second = (await ask(100)).body;
    assert.equal(first.sample.length, 100);
    assert.equal(first.totalItems, 122);
    assert.equal(first.maybeMore, true);
    assert.equal(second.sample.length, 22);
    assert.equal(second.maybeMore, false);
    assert.equal(new Set([...first.sample, ...second.sample].map((m) => m.id)).size, 122);
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

  it("pages the full Nuvio snapshot rather than stopping at 200 progress entries", async () => {
    const state = { watched: [], progress: Array.from({ length: 505 }, (_, i) => ({
      id: `progress-${i}`, content_id: `tt${String(3000000 + i)}`, content_type: "movie",
      name: `Movie ${i}`, position: 3000, duration: 6000, last_watched: NOW - i * 1000,
    })) };
    const seen = fakeServices(state);
    const ctx = await setup("nuvprogresspages", { FF_EVENT_TRACKING: "1" });
    await login(ctx);
    await pull(ctx.env, 10);
    assert.equal(progressRows(ctx.env, ctx.accountId).length, 505);
    const ranges = seen.nuvio.filter((c) => c.fn === "sync_pull_watch_progress").map((c) => c.range);
    assert.ok(ranges.includes("0-499") && ranges.includes("500-999"), JSON.stringify(ranges));
    const last = (await call(ctx.env, "/api/connections/nuvio/settings", { cookie: ctx.cookie })).body.sync.lastResult;
    assert.equal(last.found, 505);
    const stored = JSON.parse(ctx.env.DB._db.prepare("SELECT cursor_json FROM media_app_sync WHERE provider = 'nuvio'").get().cursor_json);
    assert.equal(Object.keys(stored.resumes).length, 505, "resume points are not cut off at 300");
  });

  it("keeps a movie and a show distinct when their TMDB numbers match", async () => {
    const state = { watched: [
      { content_id: "tmdb:550", content_type: "movie", title: "Film", watched_at: NOW - 10000 },
      { content_id: "tmdb:550", content_type: "series", title: "Show", season: 1, episode: 1, watched_at: NOW - 20000 },
    ], progress: [] };
    fakeServices(state);
    const ctx = await setup("nuvcollidingid", { FF_EVENT_TRACKING: "1" });
    await login(ctx);
    const ask = (type) => call(ctx.env, "/api/preview", { method: "POST", json: {
      url: `autotrack:nuvio-watch-history:mixed:${ctx.user.creatorName}`, type, sample: 20,
      creatorName: ctx.user.creatorName, creatorKey: ctx.user.creatorKey,
    } });
    const both = (await ask("mixed")).body.sample;
    assert.deepEqual(both.map((m) => m.type).sort(), ["movie", "series"]);
    assert.equal((await ask("movie")).body.sample.length, 1);
    assert.equal((await ask("series")).body.sample.length, 1);
  });

  it("keeps a later movie rewatch in Continue Watching", async () => {
    const state = { watched: [{ content_id: "tt7654321", content_type: "movie", title: "Film", watched_at: NOW - 100 * HOUR }],
      progress: [{ content_id: "tt7654321", content_type: "movie", name: "Film", position: 3000, duration: 6000, last_watched: NOW - HOUR }] };
    fakeServices(state);
    const ctx = await setup("nuvrewatch", { FF_EVENT_TRACKING: "1" });
    await login(ctx);
    const res = await call(ctx.env, "/api/preview", { method: "POST", json: {
      url: `autotrack:nuvio-continue-watching:mixed:${ctx.user.creatorName}`, type: "movie", sample: 20,
      creatorName: ctx.user.creatorName, creatorKey: ctx.user.creatorKey,
    } });
    assert.deepEqual(res.body.sample.map((m) => m.id), ["tt7654321"]);
  });

  it("a forced Nuvio sync recovers older history previously skipped by an incremental cursor", async () => {
    const state = { watched: watchedRows(), progress: [] };
    fakeServices(state);
    const ctx = await setup("nuvforceold", { FF_EVENT_TRACKING: "1" });
    await login(ctx);
    state.watched.push({ content_id: "tt8888888", content_type: "movie", title: "Older", watched_at: NOW - 100 * HOUR });
    await sync(ctx, { wait: true, force: true });
    assert.ok(events(ctx.env, ctx.accountId).some((e) => e.imdb === "tt8888888"));
  });

  it("rejects a server that repeats the first full progress page", async () => {
    const state = { watched: [], ignoreProgressRange: true, progress: Array.from({ length: 501 }, (_, i) => ({
      id: `progress-${i}`, content_id: `tt${String(4000000 + i)}`, content_type: "movie", position: 1, duration: 2, last_watched: NOW - i,
    })) };
    fakeServices(state);
    const ctx = await setup("nuvrangefail", { FF_EVENT_TRACKING: "1" });
    await login(ctx);
    const result = await sync(ctx, { wait: true, force: true });
    assert.equal(result.status, 502);
    assert.match(result.body.detail || result.body.error, /repeated a watch progress page/i);
    assert.equal(progressRows(ctx.env, ctx.accountId).length, 0);
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


describe("live Nuvio and Stremio libraries", () => {
  const flags = { FF_EVENT_TRACKING: "1", FF_MEDIA_APP_PUSH: "1" };
  const preview = (ctx, app, user = ctx.user, skip = 0) => call(ctx.env, "/api/preview", { method: "POST", json: { url: `autotrack:${app}-library:mixed:${ctx.user.creatorName}`, type: "mixed", sample: 100, skip, creatorName: user.creatorName, creatorKey: user.creatorKey } });
  const mutate = (ctx, app, body, cookie = ctx.cookie) => call(ctx.env, `/api/connections/${app}/library-item`, { method: "POST", cookie, json: body });

  it("reads a private Nuvio snapshot, replays concurrent deltas and reflects remote edits", async () => {
    const state = { watched: [], progress: [], nuvioLibrary: [
      { content_id: "tt1111111", content_type: "movie", name: "One", added_at: 4 },
      { content_id: "tt2222222", content_type: "series", name: "Two", added_at: 3 },
    ], libraryCursor: 3, libraryDelta: [
      { event_id: 4, operation: "delete", content_id: "tt1111111", content_type: "movie" },
      { event_id: 5, operation: "upsert", content_id: "tt3333333", content_type: "movie", name: "Three", added_at: 5 },
    ] };
    fakeServices(state);
    const ctx = await setup("nuvlibread", flags);
    await call(ctx.env, "/api/connections/nuvio/login", { method: "POST", cookie: ctx.cookie, json: { email: "viewer@example.test", password: "right-password" } });
    let res = await preview(ctx, "nuvio");
    assert.deepEqual(res.body.sample.map((x) => [x.id, x.type]), [["tt3333333", "movie"], ["tt2222222", "series"]]);
    const other = await createUser(ctx.env, "nuvlibother");
    assert.equal((await preview(ctx, "nuvio", other)).body.count, 0);
    state.libraryCursor = 5; state.libraryDelta = [];
    state.nuvioLibrary = [{ content_id: "tt4444444", content_type: "movie", name: "External change" }];
    res = await preview(ctx, "nuvio");
    assert.deepEqual(res.body.sample.map((x) => x.id), ["tt4444444"]);
  });

  it("paginates a large Nuvio library and reports a failed read instead of an empty list", async () => {
    const state = { watched: [], progress: [], nuvioLibrary: Array.from({ length: 510 }, (_, i) => ({ content_id: `tt${2000000 + i}`, content_type: "movie", name: `Movie ${i}`, added_at: i })) };
    const seen = fakeServices(state);
    const ctx = await setup("nuvliblarge", flags);
    await call(ctx.env, "/api/connections/nuvio/login", { method: "POST", cookie: ctx.cookie, json: { email: "viewer@example.test", password: "right-password" } });
    const first = (await preview(ctx, "nuvio")).body;
    const next = (await preview(ctx, "nuvio", ctx.user, 100)).body;
    assert.equal(first.totalItems, 510);
    assert.equal(first.sample.length, 100);
    assert.equal(next.sample.length, 100);
    assert.equal(new Set([...first.sample, ...next.sample].map((m) => m.id)).size, 200);
    assert.ok(seen.nuvio.some((c) => c.fn === "sync_pull_library" && c.body.p_offset === 500));
    state.libraryReadFails = true;
    const failed = (await preview(ctx, "nuvio")).body;
    assert.equal(failed.ok, false);
  });

  it("uses incremental Nuvio library writes and preserves unrelated items on failure", async () => {
    const state = { watched: [], progress: [], nuvioLibrary: [{ content_id: "tt1111111", content_type: "movie", name: "Keep", description: "original" }] };
    const seen = fakeServices(state);
    const ctx = await setup("nuvlibwrite", flags);
    await call(ctx.env, "/api/connections/nuvio/login", { method: "POST", cookie: ctx.cookie, json: { email: "viewer@example.test", password: "right-password" } });
    const add = { action: "add", id: "tmdb:550", mediaType: "movie", title: "New" };
    assert.equal((await mutate(ctx, "nuvio", add)).status, 200);
    assert.deepEqual(seen.libraryPushed.map((x) => x.content_id), ["tmdb:550"]);
    assert.equal(state.nuvioLibrary[0].description, "original");
    assert.deepEqual((await preview(ctx, "nuvio")).body.sample.map((x) => x.id).sort(), ["tmdb:550", "tt1111111"]);
    state.libraryWriteFails = true;
    assert.equal((await mutate(ctx, "nuvio", { action: "remove", id: "tmdb:550", mediaType: "movie" })).status, 502);
    assert.equal(state.nuvioLibrary.length, 2);
    state.libraryWriteFails = false;
    assert.equal((await mutate(ctx, "nuvio", { action: "remove", id: "tmdb:550", mediaType: "movie" })).status, 200);
    assert.deepEqual(state.nuvioLibrary.map((r) => r.content_id), ["tt1111111"]);
    assert.equal((await mutate(ctx, "nuvio", add, "")).status, 401);
  });

  it("reads and updates Stremio library membership without destroying watch state", async () => {
    const state = { approved: true, library: [{ _id: "tt1111111", type: "movie", name: "Movie", removed: false, temp: false, _mtime: new Date().toISOString(), state: { timesWatched: 2, timeOffset: 300 } }], episodes: {} };
    const seen = fakeServices(state);
    const ctx = await setup("stlib", flags);
    await connectStremio(ctx, state);
    assert.deepEqual((await preview(ctx, "stremio")).body.sample.map((x) => x.id), ["tt1111111"]);
    assert.equal((await mutate(ctx, "stremio", { action: "remove", id: "tt1111111", mediaType: "movie" })).status, 200);
    assert.equal(seen.puts.at(-1)[0].removed, true);
    assert.equal(seen.puts.at(-1)[0].state.timesWatched, 2);
    assert.deepEqual((await preview(ctx, "stremio")).body.sample, []);
    assert.equal((await mutate(ctx, "stremio", { action: "add", id: "tt1111111", mediaType: "movie", title: "Movie" })).status, 200);
    assert.equal(seen.puts.at(-1)[0].removed, false);
    assert.equal(seen.puts.at(-1)[0].state.timeOffset, 300);
    assert.equal((await mutate(ctx, "stremio", { action: "add", id: "tt2222222", mediaType: "series", title: "Show" })).status, 200);
    assert.equal(state.library.find((x) => x._id === "tt2222222").temp, false);
    state.library.find((x) => x._id === "tt2222222").removed = true;
    assert.deepEqual((await preview(ctx, "stremio")).body.sample.map((x) => x.id), ["tt1111111"]);
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

  it("adds a movie directly to Nuvio history using the documented payload", async () => {
    const ctx = await nuvio("directhist");
    const r = await call(ctx.env, "/api/connections/nuvio/add-history", { method: "POST", cookie: ctx.cookie, json: { id: "tt7777777", mediaType: "movie", title: "New movie" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(ctx.seen.pushed[0].content_id, "tt7777777");
    assert.equal(ctx.seen.pushed[0].content_type, "movie");
    assert.ok(ctx.seen.pushed[0].watched_at > 1e12);
    assert.equal(r.body.mirrored, true);
    assert.deepEqual(await list(ctx, "nuvio", "watch-history", "movie"), ["tt7777777", "tt1111111"]);
    const bad = await call(ctx.env, "/api/connections/nuvio/add-history", { method: "POST", cookie: ctx.cookie, json: { id: SHOW, mediaType: "series" } });
    assert.equal(bad.status, 400);
    const anon = await call(ctx.env, "/api/connections/nuvio/add-history", { method: "POST", json: { id: "tt7777777", mediaType: "movie" } });
    assert.equal(anon.status, 401);
  });

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

  it("matches an IMDb shelf item against Nuvio's TMDB history identity", async () => {
    const ctx = await nuvio("rmtmdb");
    ctx.env.DB._db.prepare("UPDATE media SET tmdb_id = ? WHERE imdb_id = ?").run(550, "tt1111111");
    ctx.state.watched[0].content_id = "tmdb:550";
    const r = await remove(ctx, "nuvio", { target: "history", id: "tt1111111" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(ctx.seen.deleted[0].content_id, "tmdb:550");
    assert.equal(ctx.state.watched.some((w) => w.content_id === "tmdb:550"), false);
  });

  it("deletes movie progress with null season and episode using the movie key", async () => {
    const ctx = await nuvio("rmnullprogress");
    ctx.state.progress[0].season = null;
    ctx.state.progress[0].episode = null;
    const r = await remove(ctx, "nuvio", { target: "continue-watching", id: "tt3333333" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(ctx.seen.progressDeleted, ["tt3333333"]);
  });

  it("Nuvio, Continue Watching: progress is deleted there and history is kept", async () => {
    const ctx = await nuvio("rmcw");
    await remove(ctx, "nuvio", { target: "continue-watching", id: "tt3333333", mediaType: "movie" });
    await remove(ctx, "nuvio", { target: "continue-watching", id: SHOW, mediaType: "series" });
    assert.deepEqual(ctx.seen.progressDeleted.sort(), [`${SHOW}_s1e3`, "tt3333333"].sort());
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

    it("adds a movie to history without replacing its Stremio library metadata", async () => {
      const ctx = await stremio("addsthist", [item({ state: { timesWatched: 0, flaggedWatched: 0 } })]);
      const r = await call(ctx.env, "/api/connections/stremio/add-history", { method: "POST", cookie: ctx.cookie, json: { id: "tt1111111", mediaType: "movie", title: "Movie A" } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(ctx.seen.puts[0][0].state.timesWatched, 1);
      assert.equal(ctx.seen.puts[0][0].poster, "https://img.test/a.jpg");
      const missing = await call(ctx.env, "/api/connections/stremio/add-history", { method: "POST", cookie: ctx.cookie, json: { id: "tt8888888", mediaType: "movie" } });
      assert.equal(missing.status, 400);
      assert.match(missing.body.error, /library first/);
    });

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
  const incoming = () => [{ id: "my-lists-collections", title: "My Lists Collections", folders: [{ id: "f_mine", title: "Mine", catalogSources: [{ addonId: "app.my-list", catalogId: "mine", name: "Mine (Movies)", type: "movie", url: "tmdb:popular" }] }] }];

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

  async function homePush(extra = {}, stateExtra = {}) {
    const state = { watched: [], progress: [], profiles: [{ profile_index: 2, name: "Other", collections_json: [STREAMING] }], ...stateExtra };
    const seen = fakeServices(state);
    const ctx = await setup("nuvhome" + Math.random().toString(36).slice(2, 8));
    await call(ctx.env, "/api/connections/nuvio/login", { method: "POST", cookie: ctx.cookie, json: { email: "viewer@example.test", password: "right-password" } });
    const response = await call(ctx.env, "/api/connections/nuvio/collections", { method: "POST", cookie: ctx.cookie, json: { profileId: 2, installMode: "new", collections: incoming(), hideHomeCatalogs: true, ...extra } });
    return { seen, response, ctx, state };
  }

  it("hides only incoming catalog rows using Nuvio's shared home payload, keeping collections available", async () => {
    const mine = { addon_id: "app.my-list.collections", type: "movie", catalog_id: "mine", enabled: true, order: 7, custom_title: "My title", hero: true };
    const otherType = { ...mine, type: "series" };
    const otherAddon = { ...mine, addon_id: "other" };
    const collection = { is_collection: true, collection_id: "community-streaming", enabled: true, order: 1 };
    const settings = { items: [mine, otherType, otherAddon, collection], hide_unreleased_content: true, future_setting: { value: 42 } };
    const { seen, response } = await homePush({}, { homeRows: [{ profile_id: 2, settings_json: settings }] });
    assert.equal(response.status, 200);
    assert.equal(response.body.homeVisibilityUpdated, true);
    assert.deepEqual(seen.homePushed, { p_profile_id: 2, p_platform: "home_catalog_shared", p_origin_client_id: "my-lists-addon", p_settings_json: { ...settings, items: [{ ...mine, key: "app.my-list.collections:movie:mine", enabled: false }, otherType, otherAddon, collection] } });
    assert.deepEqual(seen.collectionsPushed[0][0], STREAMING);
    assert.equal(seen.collectionsPushed[0][1].folders[0].hidden, false);
    assert.deepEqual(seen.collectionsPushed[0][1].folders[0].catalogSources, incoming()[0].folders[0].catalogSources.map((s) => ({ ...s, addonId: "app.my-list.collections", name: "Mine", title: "Mine" })));
    const pull = seen.nuvio.find((c) => c.fn === "sync_pull_home_catalog_settings");
    assert.deepEqual(pull.body, { p_profile_id: 2, p_platform: "home_catalog_shared" });
  });

  it("creates missing home entries once per addon/type/catalog, not per folder", async () => {
    const cols = incoming();
    cols[0].folders.push({ ...cols[0].folders[0], id: "duplicate" });
    const { seen, response } = await homePush({ collections: cols });
    assert.equal(response.status, 200);
    assert.deepEqual(seen.homePushed.p_settings_json.items, [{ key: "app.my-list.collections:movie:mine", addon_id: "app.my-list.collections", type: "movie", catalog_id: "mine", enabled: false, order: 0, custom_title: "", is_collection: false, collection_id: "" }]);
  });

  it("turning the toggle off shows these catalogs again without touching others", async () => {
    const hidden = { addon_id: "app.my-list.collections", type: "movie", catalog_id: "mine", enabled: false, order: 2 };
    const unrelated = { ...hidden, catalog_id: "unrelated" };
    const { seen, response } = await homePush({ hideHomeCatalogs: false, installMode: "replace" }, { homeRows: [{ settings_json: { items: [hidden, unrelated] } }] });
    assert.equal(response.status, 200);
    assert.deepEqual(seen.homePushed.p_settings_json.items, [{ ...hidden, key: "app.my-list.collections:movie:mine", enabled: true }, unrelated]);
  });

  it("merge hides incoming catalogs, not other catalogs in the target collection", async () => {
    const other = { addon_id: "other", type: "movie", catalog_id: "nf", enabled: true, order: 12 };
    const { seen, response } = await homePush({ installMode: "merge", targetCollectionId: STREAMING.id }, { homeRows: [{ settings_json: { items: [other] } }] });
    assert.equal(response.status, 200);
    assert.deepEqual(seen.homePushed.p_settings_json.items[0], other);
    assert.equal(seen.homePushed.p_settings_json.items[1].catalog_id, "mine");
    assert.equal(seen.homePushed.p_settings_json.items[1].enabled, false);
    assert.equal(seen.homePushed.p_settings_json.items[1].order, 13);
    assert.equal(seen.collectionsPushed[0][0].folders.length, 2);
  });

  it("old callers that omit the option leave home preferences alone", async () => {
    const { seen, response } = await homePush({ hideHomeCatalogs: undefined });
    assert.equal(response.status, 200);
    assert.equal(response.body.homeVisibilityUpdated, null);
    assert.ok(!seen.nuvio.some((c) => c.fn.includes("home_catalog_settings")));
  });

  it("failed or malformed home reads stop all writes instead of replacing settings", async () => {
    for (const state of [{ homeReadFails: true }, { homeRows: [{ settings_json: { items: {} } }] }, { homeRows: [{ settings_json: null }] }]) {
      const { seen, response } = await homePush({}, state);
      assert.equal(response.status, 502);
      assert.equal(seen.collectionsPushed, undefined);
      assert.equal(seen.homePushed, undefined);
      assert.ok(!seen.nuvio.some((c) => c.fn.startsWith("sync_push_")));
    }
  });

  it("reports partial success when collections save but home visibility fails", async () => {
    const { seen, response } = await homePush({}, { homeWriteFails: true });
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.homeVisibilityUpdated, false);
    assert.equal(seen.collectionsPushed.length, 1);
  });

  it("updates every explicit-key entry without creating an enabled duplicate on Desktop/mobile", async () => {
    const key = "app.my-list.collections:movie:mine";
    const legacy = { key: "   ", addon_id: "app.my-list.collections", type: "movie", catalog_id: "mine", enabled: true, order: 1 };
    const keyed = { key, enabled: true, order: 2, custom_title: "Keep me" };
    // An explicit key takes precedence even when separate fields disagree.
    const unrelated = { ...legacy, key: "other:movie:mine", custom_title: "Unrelated" };
    for (const hidden of [true, false]) {
      const { seen, response } = await homePush({ hideHomeCatalogs: hidden }, { homeRows: [{ settings_json: { items: [legacy, keyed, unrelated] } }] });
      assert.equal(response.body.homeVisibilityUpdated, true);
      const items = seen.homePushed.p_settings_json.items;
      assert.equal(items.length, 3);
      assert.equal(items[0].enabled, !hidden);
      assert.equal(items[1].enabled, !hidden);
      assert.equal(items[1].addon_id, "app.my-list.collections");
      assert.equal(items[1].type, "movie");
      assert.equal(items[1].catalog_id, "mine");
      assert.equal(items[1].custom_title, "Keep me");
      assert.equal(items[1].order, 2);
      assert.deepEqual(items[2], unrelated);
      // Mirrors Desktop/mobile applyFromRemote: the last item for a key wins.
      const byKey = new Map(items.map((i) => [i.key && i.key.trim() ? i.key : `${i.addon_id}:${i.type}:${i.catalog_id}`, i]));
      assert.equal(byKey.get(key).enabled, !hidden);
    }
  });

  it("does not claim success when the RPC accepts a write but read-back has no saved visibility", async () => {
    for (const state of [{ homeWriteIgnored: true }, { homeReadbackFails: true }]) {
      const { seen, response } = await homePush({}, state);
      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.homeVisibilityUpdated, false);
      assert.equal(seen.collectionsPushed.length, 1);
      assert.equal(seen.nuvio.filter((c) => c.fn === "sync_pull_home_catalog_settings").length, 2);
    }
  });

  it("rejects a non-boolean visibility option", async () => {
    const { seen, response } = await homePush({ hideHomeCatalogs: "false" });
    assert.equal(response.status, 400);
    assert.equal(seen.collectionsPushed, undefined);
  });

  it("installs My Lists Collections independently and survives home link edits, revocation and reinstall", async () => {
    const ctx = await setup("separateaddons", { FF_INSTALLS: "1" });
    const homeRow = { id: "home", type: "movie", name: "Home", url: "tmdb:popular" };
    const createHome = () => call(ctx.env, "/api/installs", { method: "POST", cookie: ctx.cookie, json: { name: "My home", entries: [homeRow], betterPosters: true } });
    const home = await createHome();
    assert.equal(home.status, 201);
    const regular = { url: home.body.manifestUrl, name: "My Lists", enabled: true, sort_order: 4 };
    const external = { url: "https://other.test/manifest.json", name: "Other", enabled: false, sort_order: 9 };
    const state = { watched: [], progress: [], episodes: {}, addons: [regular, external], profiles: [{ profile_index: 1, name: "Main" }] };
    const seen = fakeServices(state);
    await call(ctx.env, "/api/connections/nuvio/login", { method: "POST", cookie: ctx.cookie, json: { email: "viewer@example.test", password: "right-password" } });
    const listUrl = 'customlist:v1:' + JSON.stringify({ listSlug: "collectiononly", items: [{ id: "tt1111111", type: "movie", title: "Stored Movie" }] });
    const post = (extra = {}) => call(ctx.env, "/api/connections/nuvio/collections", { method: "POST", cookie: ctx.cookie, json: {
      profileId: 1, installMode: "merge", targetCollectionId: "my-lists-collections", collections: incoming(),
      collectionLists: [{ catalogId: "mine", name: "Mine", type: "movie", url: listUrl }], manifestUrl: home.body.manifestUrl, hideHomeCatalogs: true, ...extra
    } });
    const first = await post({ installMode: "new" });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(seen.addonsPushed.p_addons.slice(0, 2), [regular, external]);
    const collectionAddon = seen.addonsPushed.p_addons[2];
    assert.equal(collectionAddon.name, "My Lists Collections");
    assert.notEqual(collectionAddon.url, home.body.manifestUrl);
    assert.equal(collectionAddon.url.includes("collections=1"), false);
    assert.equal(first.body.collections[0].folders[0].catalogSources[0].addonId, "app.my-list.collections");
    const manifestPath = new URL(collectionAddon.url).pathname;
    const manifest = await call(ctx.env, manifestPath);
    assert.equal(manifest.body.id, "app.my-list.collections");
    assert.equal(manifest.body.name, "My Lists Collections");
    assert.deepEqual(manifest.body.catalogs.map((c) => c.id), ["mine"]);
    assert.ok(manifest.headers.get("cache-control").includes("no-store"));
    assert.equal((await call(ctx.env, new URL(home.body.manifestUrl).pathname)).body.id, "app.my-list");
    const rows = ctx.env.DB._db.prepare("SELECT id, config_json FROM installs WHERE account_id = ? ORDER BY id").all(ctx.accountId);
    const saved = JSON.parse(rows[1].config_json);
    assert.equal(saved.nuvioCollectionsProfile, 1);
    assert.equal(saved.betterPosters, true);
    assert.equal(saved.entries[0].url, listUrl);
    assert.ok(![...ctx.env.CONFIGS._store.keys()].some((k) => k.startsWith("col_cat:mine:")), "custom sources are account-scoped and durable, not global expiring mappings");
    const hidden = seen.homePushed.p_settings_json.items.find((i) => i.catalog_id === "mine");
    assert.equal(hidden.addon_id, "app.my-list.collections");
    const edit = await call(ctx.env, `/api/installs/${home.body.install.id}`, { method: "PATCH", cookie: ctx.cookie, json: { entries: [{ ...homeRow, id: "new-home" }], betterPosters: false } });
    assert.equal(edit.status, 200);
    assert.equal((await call(ctx.env, manifestPath)).body.catalogs[0].id, "mine");
    await call(ctx.env, `/api/installs/${home.body.install.id}`, { method: "DELETE", cookie: ctx.cookie });
    const reinstall = await createHome();
    assert.equal(reinstall.status, 201);
    state.addonsByProfile[1][0] = { ...regular, url: reinstall.body.manifestUrl };
    // Nuvio clients may persist the addon base URL rather than manifest.json.
    state.addonsByProfile[1][2].url = collectionAddon.url.replace("/manifest.json", "/");
    const again = await post({ manifestUrl: reinstall.body.manifestUrl });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.collectionsManifestUrl, collectionAddon.url, "reuses the existing collections token");
    assert.equal(seen.addonsPushed.p_addons.length, 3);
    assert.equal(state.profiles[0].collections_json[0].folders.length, 1, "merge does not duplicate the folder");
    assert.equal(JSON.parse(ctx.env.DB._db.prepare("SELECT config_json FROM installs WHERE id = ?").get(rows[1].id).config_json).betterPosters, true, "home appearance edits do not change the collections config");
    const page = await call(ctx.env, manifestPath.replace("manifest.json", "catalog/movie/mine.json"));
    assert.ok(page.body.metas.some((m) => m.id === "tt1111111"), JSON.stringify(page.body));
    const notInstalled = await call(ctx.env, manifestPath.replace("manifest.json", "catalog/movie/tmdb-chart-netflix.json"));
    assert.deepEqual(notInstalled.body.metas, []);
    const managedEdit = await call(ctx.env, `/api/installs/${rows[1].id}`, { method: "PATCH", cookie: ctx.cookie, json: { betterPosters: false } });
    assert.equal(managedEdit.status, 200);
    assert.equal((await call(ctx.env, manifestPath)).body.id, "app.my-list.collections", "editing a managed link preserves its addon identity");
    await call(ctx.env, `/api/installs/${rows[1].id}`, { method: "DELETE", cookie: ctx.cookie });
    const revoked = await call(ctx.env, manifestPath);
    assert.equal(revoked.body.id, "app.my-list.collections");
    assert.deepEqual(revoked.body.catalogs, []);
  });

  it("stops before replacing collections or addons if the addon list cannot be read", async () => {
    for (const state of [{ addonsReadFails: true }, { addonsResponse: {} }, { addonsResponse: [{}] }]) {
      const { response, seen } = await homePush({}, state);
      assert.equal(response.status, 502);
      assert.equal(seen.collectionsPushed, undefined);
      assert.equal(seen.addonsPushed, undefined);
      assert.equal(seen.homePushed, undefined);
    }
  });

  it("leaves regular My Lists home preferences alone even for the same catalog ID", async () => {
    const home = { addon_id: "app.my-list", type: "movie", catalog_id: "mine", key: "app.my-list:movie:mine", enabled: true, custom_title: "My home", order: 3 };
    const { response, seen } = await homePush({}, { homeRows: [{ settings_json: { items: [home] } }] });
    assert.equal(response.status, 200);
    assert.deepEqual(seen.homePushed.p_settings_json.items[0], home);
    assert.equal(seen.homePushed.p_settings_json.items[1].addon_id, "app.my-list.collections");
    assert.equal(seen.homePushed.p_settings_json.items[1].enabled, false);
  });

  it("keeps separate collection configs per profile and cannot reuse another profile's token", async () => {
    const { ctx, state, response, seen } = await homePush();
    assert.equal(response.status, 200);
    const firstUrl = response.body.collectionsManifestUrl;
    state.addonsByProfile[1] = structuredClone(state.addonsByProfile[2]);
    const second = await call(ctx.env, "/api/connections/nuvio/collections", { method: "POST", cookie: ctx.cookie, json: { profileId: 1, installMode: "new", collections: incoming() } });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.notEqual(second.body.collectionsManifestUrl, firstUrl);
    assert.equal(seen.addonsPushed.p_profile_id, 1);
    const configs = ctx.env.DB._db.prepare("SELECT config_json FROM installs WHERE account_id = ?").all(ctx.accountId).map((r) => JSON.parse(r.config_json));
    assert.deepEqual(configs.map((c) => c.nuvioCollectionsProfile).sort(), [1, 2]);
  });

  it("updates the same manifest when custom sources change and clears it when the last source is removed", async () => {
    const { ctx, response } = await homePush();
    const url = response.body.collectionsManifestUrl;
    const post = (collections) => call(ctx.env, "/api/connections/nuvio/collections", { method: "POST", cookie: ctx.cookie, json: { profileId: 2, installMode: "replace", collections } });
    const changed = incoming();
    changed[0].folders[0].catalogSources.push({ addonId: "app.my-list", type: "series", catalogId: "second", name: "Second", url: "tmdb:trending" });
    const update = await post(changed);
    assert.equal(update.status, 200, JSON.stringify(update.body));
    assert.equal(update.body.collectionsManifestUrl, url);
    const manifestPath = new URL(url).pathname;
    assert.deepEqual((await call(ctx.env, manifestPath)).body.catalogs.map((c) => c.id), ["mine", "second"]);
    const empty = incoming(); empty[0].folders[0].catalogSources = [];
    assert.equal((await post(empty)).status, 200);
    assert.deepEqual((await call(ctx.env, manifestPath)).body.catalogs, []);
  });

  it("new: adds a separately named collection and keeps every existing one", async () => {
    const { pushed } = await push("new", { collectionName: "Weekend Picks" });
    assert.deepEqual(pushed.map((c) => c.title), ["Streaming", "Other Provider", "Weekend Picks"]);
    assert.deepEqual(pushed[0], STREAMING, "another provider's collection is untouched");
    assert.notEqual(pushed[2].id, "community-streaming");
  });

  it("new: preserves each parent title and folder when pushing multiple collections", async () => {
    const services = incoming()[0];
    services.id = "col_mylists_services";
    services.title = "Streaming Services";
    const family = structuredClone(services);
    family.id = "col_mylists_family";
    family.title = "Family";
    family.folders[0].id = "family-folder";
    const { pushed } = await push("new", { collections: [services, family], collectionName: "My Lists Collections" });
    assert.deepEqual(pushed.slice(0, 2), [STREAMING, OTHER]);
    assert.deepEqual(pushed.slice(2).map((c) => [c.id, c.title, c.folders[0].id]), [
      ["col_mylists_services", "Streaming Services", "f_mine"],
      ["col_mylists_family", "Family", "family-folder"]
    ]);
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

  it("a failed read of Nuvio's collections stops the push, so nothing is wiped", async () => {
    const state = { watched: [], progress: [], collectionsPullFails: true, profiles: [{ profile_index: 1, name: "Main", collections_json: [STREAMING] }] };
    const seen = fakeServices(state);
    const ctx = await setup("nuvcolfail");
    await call(ctx.env, "/api/connections/nuvio/login", { method: "POST", cookie: ctx.cookie, json: { email: "viewer@example.test", password: "right-password" } });
    for (const mode of ["new", "merge"]) {
      const r = await call(ctx.env, "/api/connections/nuvio/collections", { method: "POST", cookie: ctx.cookie, json: { profileId: 1, installMode: mode, targetCollectionId: "community-streaming", collections: incoming() } });
      assert.equal(r.status, 502, mode);
    }
    assert.equal(seen.collectionsPushed, undefined);
  });

  it("preserves empty collections and refuses malformed provider data", async () => {
    const empty = { id: "empty", folders: [], customField: "keep" };
    const state = { watched: [], progress: [], profiles: [{ profile_index: 1, name: "Main", collections_json: [empty, STREAMING] }] };
    const seen = fakeServices(state);
    const ctx = await setup("nuvcolempty");
    await call(ctx.env, "/api/connections/nuvio/login", { method: "POST", cookie: ctx.cookie, json: { email: "viewer@example.test", password: "right-password" } });
    const doPush = () => call(ctx.env, "/api/connections/nuvio/collections", { method: "POST", cookie: ctx.cookie, json: { profileId: 1, installMode: "new", collections: incoming() } });
    assert.equal((await doPush()).status, 200);
    assert.deepEqual(seen.collectionsPushed[0][0], empty);
    state.profiles[0].collections_json = { unexpected: true };
    assert.equal((await doPush()).status, 502);
    assert.equal(seen.collectionsPushed.length, 1);
  });

  it("updates only the linked folder and rejects stale snapshots", async () => {
    const mine = { ...STREAMING, id: "my-lists-collections" };
    const state = { watched: [], progress: [], profiles: [{ profile_index: 1, name: "Main", collections_json: [mine, OTHER] }] };
    const seen = fakeServices(state);
    const ctx = await setup("nuvcolupdate");
    await call(ctx.env, "/api/connections/nuvio/login", { method: "POST", cookie: ctx.cookie, json: { email: "viewer@example.test", password: "right-password" } });
    const read = await call(ctx.env, "/api/connections/nuvio/collections", { cookie: ctx.cookie });
    assert.equal(read.status, 200);
    assert.ok(read.body.scope);
    const original = STREAMING.folders[0];
    const updated = { ...original, title: "Edited", custom: "preserved", catalogSources: [] };
    const body = { profileId: 1, scope: read.body.scope, installMode: "update-folder", targetCollectionId: mine.id, folderId: original.id, expectedFolder: original, updatedFolder: updated, collections: [updated] };
    const write = (b) => call(ctx.env, "/api/connections/nuvio/collections", { method: "POST", cookie: ctx.cookie, json: b });
    assert.equal((await write({ ...body, scope: "another-account" })).status, 409);
    assert.equal(seen.collectionsPushed, undefined);
    assert.equal((await write({ ...body, targetCollectionId: OTHER.id })).status, 403);
    assert.equal(seen.collectionsPushed, undefined);
    assert.equal((await write(body)).status, 200);
    assert.deepEqual(seen.collectionsPushed[0], [{ ...mine, folders: [updated] }, OTHER]);
    state.profiles[0].collections_json = [{ ...mine, folders: [{ ...original, title: "Changed remotely" }] }, OTHER];
    assert.equal((await write(body)).status, 409);
    assert.equal(seen.collectionsPushed.length, 1);
    assert.equal((await write({ ...body, profileId: 2 })).status, 409);
    assert.equal(seen.collectionsPushed.length, 1);
  });

  async function collectionLifecycleState(collections = [STREAMING, OTHER], extra = {}) {
    const state = { watched: [], progress: [], profiles: [{ profile_index: 1, name: "Main", collections_json: structuredClone(collections) }], ...extra };
    const seen = fakeServices(state);
    const ctx = await setup("nuvlife" + Math.random().toString(36).slice(2, 8));
    await call(ctx.env, "/api/connections/nuvio/login", { method: "POST", cookie: ctx.cookie, json: { email: "viewer@example.test", password: "right-password" } });
    const read = await call(ctx.env, "/api/connections/nuvio/collections", { cookie: ctx.cookie });
    const post = body => call(ctx.env, "/api/connections/nuvio/collections", { method: "POST", cookie: ctx.cookie, json: { profileId: 1, scope: read.body.scope, ...body } });
    return { state, seen, post };
  }

  it("keeps sibling folder and collection snapshots valid during an individual folder update", async () => {
    const legacy = { id: "legacy", catalogSources: [{ addonId: "app.my-list", catalogId: "old", type: "movie" }] };
    const mine = { ...STREAMING, id: "my-lists-collections", folders: [...STREAMING.folders, legacy] };
    const untouched = { ...OTHER, folders: [legacy] };
    const { post, seen } = await collectionLifecycleState([mine, untouched]);
    const original = mine.folders[0], updated = { ...original, title: "Edited", catalogSources: [] };
    const result = await post({ installMode: "update-folder", targetCollectionId: mine.id, folderId: original.id, expectedFolder: original, updatedFolder: updated, collections: [updated] });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(seen.collectionsPushed[0], [{ ...mine, folders: [updated, legacy] }, untouched]);
  });

  it("deletes exactly the selected Nuvio collection, preserving other collections, addons and home settings", async () => {
    const untouched = { ...OTHER, unknown: { keep: true }, folders: [{ id: "legacy", catalogSources: [{ addonId: "app.my-list", catalogId: "legacy", type: "movie" }] }] };
    const { seen, post } = await collectionLifecycleState([STREAMING, untouched], { addonsReadFails: true });
    const r = await post({ installMode: "delete-collection", targetCollectionId: STREAMING.id, expectedCollection: STREAMING });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(seen.collectionsPushed, [[untouched]]);
    assert.equal(seen.addonsPushed, undefined);
    assert.equal(seen.homePushed, undefined);
  });

  it("can delete the final collection without uninstalling any addon", async () => {
    const { seen, post } = await collectionLifecycleState([STREAMING]);
    assert.equal((await post({ installMode: "delete-collection", targetCollectionId: STREAMING.id, expectedCollection: STREAMING })).status, 200);
    assert.deepEqual(seen.collectionsPushed, [[]]);
    assert.equal(seen.addonsPushed, undefined);
  });

  it("updates one whole collection and keeps foreign fields and unrelated legacy sources", async () => {
    const target = { ...STREAMING, custom: { keep: true } };
    const untouched = { ...OTHER, folders: [{ id: "old", catalogSources: [{ addonId: "app.my-list", catalogId: "old", type: "movie" }] }] };
    const { seen, post } = await collectionLifecycleState([target, untouched]);
    const updated = { id: target.id, title: "Renamed", folders: [{ id: "new", title: "New", catalogSources: [] }] };
    const r = await post({ installMode: "update-collection", targetCollectionId: target.id, expectedCollection: target, updatedCollection: updated });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(seen.collectionsPushed[0], [{ ...target, ...updated }, untouched]);
    assert.equal(seen.addonsPushed, undefined);
    assert.equal(seen.homePushed, undefined);
  });

  it("preserves unknown folder/source metadata when an edited collection omits future fields", async () => {
    const source = { addonId: "third-party", catalogId: "one", type: "movie", future: { keep: true } };
    const target = { ...STREAMING, folders: [{ id: "one", title: "One", hidden: true, future: { keep: true }, catalogSources: [source] }] };
    const { post, seen } = await collectionLifecycleState([target, OTHER], { addonsReadFails: true });
    const edited = { id: target.id, title: "Edited", folders: [{ id: "one", title: "Edited folder", catalogSources: [{ addonId: source.addonId, catalogId: source.catalogId, type: source.type, title: "Edited source" }] }] };
    const result = await post({ installMode: "update-collection", targetCollectionId: target.id, expectedCollection: target, updatedCollection: edited });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(seen.collectionsPushed[0], [{ ...target, title: "Edited", folders: [{ ...target.folders[0], title: "Edited folder", catalogSources: [{ ...source, title: "Edited source" }] }] }, OTHER]);
    assert.equal(seen.addonsPushed, undefined);
  });

  it("fails closed on unreadable collections for both whole-collection actions", async () => {
    const { post, seen, state } = await collectionLifecycleState();
    state.profiles[0].collections_json = "{broken";
    for (const installMode of ["update-collection", "delete-collection"]) {
      assert.equal((await post({ installMode, targetCollectionId: STREAMING.id, expectedCollection: STREAMING, updatedCollection: STREAMING })).status, 502);
      assert.equal(seen.collectionsPushed, undefined);
      assert.equal(seen.addonsPushed, undefined);
      assert.equal(seen.homePushed, undefined);
    }
  });

  // Update Nuvio used to skip home settings, so a list added to a "hidden"
  // collection later showed on the Nuvio home screen. The saved choice is now
  // sent, and only this collection's own rows change.
  it("applies the collection's saved home-row choice on a whole-collection update, and only to its own rows", async () => {
    const target = { ...STREAMING, folders: [] };
    const elsewhere = { key: "app.my-list.collections:movie:elsewhere", addon_id: "app.my-list.collections", type: "movie", catalog_id: "elsewhere", enabled: true, order: 0, is_collection: false };
    for (const hidden of [true, false]) {
      const { post, seen } = await collectionLifecycleState([target, OTHER], { homeRows: [{ settings_json: { items: [elsewhere] } }] });
      const updated = { ...target, folders: [{ id: "own", title: "Own", catalogSources: [{ addonId: "app.my-list", catalogId: "added-later", type: "movie" }] }] };
      const result = await post({ installMode: "update-collection", targetCollectionId: target.id, expectedCollection: target, updatedCollection: updated,
        collectionLists: [{ catalogId: "added-later", url: "tmdb:popular", name: "Added later", type: "movie" }], hideHomeCatalogs: hidden });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.homeVisibilityUpdated, true);
      const items = seen.homePushed.p_settings_json.items;
      assert.equal(items.find((i) => i.key === "app.my-list.collections:movie:added-later").enabled, !hidden);
      assert.deepEqual(items.find((i) => i.key === elsewhere.key), elsewhere, "another collection's row is untouched");
    }
  });

  it("rejects a non-boolean home-row choice on a whole-collection update before writing anything", async () => {
    const { post, seen } = await collectionLifecycleState();
    const result = await post({ installMode: "update-collection", targetCollectionId: STREAMING.id, expectedCollection: STREAMING, updatedCollection: STREAMING, hideHomeCatalogs: "yes" });
    assert.equal(result.status, 400);
    assert.equal(seen.collectionsPushed, undefined);
  });

  it("does not change the collection when Nuvio home settings cannot be read", async () => {
    const { post, seen } = await collectionLifecycleState(undefined, { homeReadFails: true });
    const result = await post({ installMode: "update-collection", targetCollectionId: STREAMING.id, expectedCollection: STREAMING, updatedCollection: STREAMING, hideHomeCatalogs: true });
    assert.equal(result.status, 502);
    assert.equal(seen.collectionsPushed, undefined);
  });

  it("applies the home-row choice to the updated folder's rows on a single-folder update", async () => {
    const mine = { ...STREAMING, id: "my-lists-collections", folders: [{ id: "f1", title: "F1", catalogSources: [] }] };
    const { post, seen } = await collectionLifecycleState([mine, OTHER]);
    const updated = { id: "f1", title: "F1", catalogSources: [{ addonId: "app.my-list", catalogId: "new-list", type: "series" }] };
    const result = await post({ installMode: "update-folder", targetCollectionId: mine.id, folderId: "f1", expectedFolder: mine.folders[0], updatedFolder: updated,
      collections: [updated], collectionLists: [{ catalogId: "new-list", url: "tmdb:popular", name: "New", type: "series" }], hideHomeCatalogs: true });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(seen.homePushed.p_settings_json.items.find((i) => i.key === "app.my-list.collections:series:new-list").enabled, false);
  });

  it("maintains the independent Collections addon on whole updates and keeps it on remote deletion", async () => {
    const regular = { url: "https://example.test/home/manifest.json", name: "My Lists", enabled: true, sort_order: 3 };
    const target = { ...STREAMING, folders: [] };
    const { post, seen } = await collectionLifecycleState([target, OTHER], { addons: [regular] });
    const updated = { ...target, folders: [{ id: "own", title: "Own", catalogSources: [{ addonId: "app.my-list", catalogId: "own", type: "movie" }] }] };
    const result = await post({ installMode: "update-collection", targetCollectionId: target.id, expectedCollection: target, updatedCollection: updated,
      collectionLists: [{ catalogId: "own", url: "tmdb:popular", name: "Own", type: "movie" }] });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(seen.addonsPushed.p_addons[0], regular);
    assert.equal(seen.addonsPushed.p_addons[1].name, "My Lists Collections");
    assert.equal(result.body.collections[0].folders[0].catalogSources[0].addonId, "app.my-list.collections");
    assert.deepEqual(result.body.collections[1], OTHER);
    const addonWrites = seen.nuvio.filter(c => c.fn === "sync_push_addons").length;
    const deleted = await post({ installMode: "delete-collection", targetCollectionId: target.id, expectedCollection: result.body.collections[0] });
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.body.collections, [OTHER]);
    assert.equal(seen.nuvio.filter(c => c.fn === "sync_push_addons").length, addonWrites);
    assert.equal(seen.homePushed, undefined);
  });

  it("rejects stale, wrong-connection, wrong-profile, missing and ambiguous collection targets before writing anything", async () => {
    const { seen, post, state } = await collectionLifecycleState();
    const body = { installMode: "delete-collection", targetCollectionId: STREAMING.id, expectedCollection: STREAMING };
    for (const change of [{ scope: "another-account" }, { profileId: 2 }, { expectedCollection: { ...STREAMING, title: "stale" } }, { targetCollectionId: "missing" }]) {
      assert.equal((await post({ ...body, ...change })).status, 409);
      assert.equal(seen.collectionsPushed, undefined);
    }
    state.profiles[0].collections_json = [STREAMING, STREAMING];
    assert.equal((await post(body)).status, 409);
    assert.equal(seen.collectionsPushed, undefined);
  });

  it("compares snapshots semantically after JSONB reorders object keys, but rejects array reordering", async () => {
    const target = { ...STREAMING, custom: { z: 1, a: 2 }, folders: [STREAMING.folders[0], { id: "second", catalogSources: [] }] };
    const reverseKeys = value => Array.isArray(value) ? value.map(reverseKeys) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverseKeys(v)])) : value;
    const { post, seen } = await collectionLifecycleState([target, OTHER]);
    const body = { installMode: "delete-collection", targetCollectionId: target.id, expectedCollection: { ...target, folders: target.folders.slice().reverse() } };
    assert.equal((await post(body)).status, 409);
    assert.equal(seen.collectionsPushed, undefined);
    assert.equal((await post({ ...body, expectedCollection: reverseKeys(target) })).status, 200);
    assert.deepEqual(seen.collectionsPushed, [[OTHER]]);
  });

  it("rejects malformed whole-collection updates before touching addons or collections", async () => {
    const { seen, post } = await collectionLifecycleState();
    for (const updatedCollection of [{ id: "wrong", folders: [] }, { id: STREAMING.id, folders: "bad" }, { id: STREAMING.id, folders: [{ id: "same", catalogSources: [] }, { id: "same", catalogSources: [] }] }]) {
      const r = await post({ installMode: "update-collection", targetCollectionId: STREAMING.id, expectedCollection: STREAMING, updatedCollection });
      assert.equal(r.status, 400);
      assert.equal(seen.collectionsPushed, undefined);
      assert.equal(seen.addonsPushed, undefined);
    }
  });

  it("replace: only the pushed collection is left", async () => {
    const { pushed } = await push("replace");
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].folders[0].id, "f_mine");
  });
});

describe("Nuvio: incremental pull from the documented event cursors", () => {
  const cursorOf = (env) => JSON.parse(env.DB._db.prepare("SELECT cursor_json FROM media_app_sync WHERE provider = 'nuvio'").get().cursor_json);
  const fns = (seen) => seen.nuvio.map((c) => c.fn);
  const resync = async (ctx) => {
    await call(ctx.env, "/api/connections/nuvio/sync", { method: "POST", cookie: ctx.cookie, json: {} });
    await pull(ctx.env);
  };
  const upsertHistory = (id, over) => ({ event_id: id, operation: "upsert", content_id: "tt4444444", content_type: "movie", title: "Movie D", watched_at: NOW - HOUR, ...over });
  async function bootstrapped(name, over = {}) {
    const state = {
      watched: [{ content_id: "tt1111111", content_type: "movie", title: "Movie A", watched_at: NOW - 30 * HOUR }],
      progress: [{ content_id: "tt3333333", content_type: "movie", name: "Movie Half", position: 1500000, duration: 6000000, last_watched: NOW - 2 * HOUR }],
      historyEvents: [{ event_id: 5, operation: "upsert", content_id: "tt1111111", content_type: "movie", title: "Movie A", watched_at: NOW - 30 * HOUR }],
      progressEvents: [{ event_id: 7, operation: "upsert", progress_key: "tt3333333", content_id: "tt3333333", content_type: "movie", position: 1500000, duration: 6000000, last_watched: NOW - 2 * HOUR }],
      ...over,
    };
    const seen = fakeServices(state);
    const ctx = await setup(name);
    await call(ctx.env, "/api/connections/nuvio/login", { method: "POST", cookie: ctx.cookie, json: { email: "viewer@example.test", password: "right-password" } });
    await pull(ctx.env);
    return { state, seen, ctx };
  }

  it("takes the cursors before reading the snapshot, and keeps them", async () => {
    const { seen, ctx } = await bootstrapped("nudbase");
    const f = fns(seen);
    assert.ok(f.indexOf("sync_get_watched_items_delta_cursor") >= 0 && f.indexOf("sync_get_watched_items_delta_cursor") < f.indexOf("sync_pull_watched_items"), "history cursor first");
    assert.ok(f.indexOf("sync_get_watch_progress_delta_cursor") >= 0 && f.indexOf("sync_get_watch_progress_delta_cursor") < f.indexOf("sync_pull_watch_progress"), "progress cursor first");
    const c = cursorOf(ctx.env);
    assert.deepEqual([c.delta.history, c.delta.progress, c.delta.profile], [5, 7, 1]);
    assert.equal(c.pendingDelta, undefined, "the pending mark is promoted once the pull finishes");
  });

  it("later pulls read only what changed, not the whole profile", async () => {
    const { state, seen, ctx } = await bootstrapped("nudlater");
    seen.nuvio.length = 0;
    // The snapshot lists below are left stale on purpose: only the events can supply this play.
    state.historyEvents.push(upsertHistory(6));
    await resync(ctx);
    const f = fns(seen);
    assert.ok(f.includes("sync_pull_watched_items_delta") && f.includes("sync_pull_watch_progress_delta"));
    assert.ok(!f.includes("sync_pull_watched_items") && !f.includes("sync_pull_watch_progress"), `no full read: ${f.join(",")}`);
    assert.deepEqual(events(ctx.env, ctx.accountId).filter((e) => e.imdb === "tt4444444").map((e) => [e.watched_at, e.source]), [[NOW - HOUR, "nuvio"]]);
    assert.equal(cursorOf(ctx.env).delta.history, 6, "the cursor moved to the last event read");
    const asked = seen.nuvio.find((c) => c.fn === "sync_pull_watched_items_delta").body;
    assert.equal(asked.p_since_event_id, 5);
  });

  it("uses the last write for a title and pages past 1000 events", async () => {
    const { state, seen, ctx } = await bootstrapped("nudpage");
    seen.nuvio.length = 0;
    for (let i = 0; i < 1200; i++) state.historyEvents.push(upsertHistory(10 + i, { watched_at: NOW - 3000 * HOUR + i * 1000 }));
    await resync(ctx);
    assert.equal(seen.nuvio.filter((c) => c.fn === "sync_pull_watched_items_delta").length, 2, "1000, then the rest");
    assert.deepEqual(events(ctx.env, ctx.accountId).filter((e) => e.imdb === "tt4444444").map((e) => e.watched_at), [NOW - 3000 * HOUR + 1199 * 1000]);
    assert.equal(cursorOf(ctx.env).delta.history, 1209);
  });

  it("a change to a watched title does not lose its stored Continue Watching point", async () => {
    const { state, ctx } = await bootstrapped("nudkeep");
    const id = ctx.env.DB._db.prepare("SELECT id FROM media WHERE imdb_id = 'tt3333333'").get().id;
    assert.equal(JSON.parse(ctx.env.DB_ACTIVITY._db.prepare("SELECT companion_json FROM show_progress WHERE media_id = ?").get(id).companion_json).progress, 25);
    // An older play of the same movie arrives with no progress event of its own.
    state.historyEvents.push(upsertHistory(6, { content_id: "tt3333333", title: "Movie Half", watched_at: NOW - 40 * HOUR }));
    await resync(ctx);
    assert.equal(JSON.parse(ctx.env.DB_ACTIVITY._db.prepare("SELECT companion_json FROM show_progress WHERE media_id = ?").get(id).companion_json).progress, 25, "still part way through");
    assert.ok(cursorOf(ctx.env).resumes["tt3333333"], "and still in the resume map");
  });

  it("a deleted progress entry clears only the resume point it was", async () => {
    const { state, ctx } = await bootstrapped("nuddel");
    const gone = (episode) => ({ event_id: 8, operation: "delete", progress_key: `tt2222222_s1e${episode}`, content_id: SHOW, content_type: "series", season: 1, episode, position: 1, duration: 2 });
    state.progressEvents.push({ event_id: 8, operation: "delete", progress_key: "tt3333333", content_id: "tt3333333", content_type: "movie", position: 1500000, duration: 6000000 });
    await resync(ctx);
    assert.equal(cursorOf(ctx.env).resumes["tt3333333"], undefined, "Nuvio dropped it, so the map does");
    // A delete for some other episode of a show leaves the show's stored point alone.
    state.progressEvents.push({ event_id: 9, operation: "upsert", progress_key: `${SHOW}_s1e3`, content_id: SHOW, content_type: "series", season: 1, episode: 3, position: 600000, duration: 2400000, last_watched: NOW - HOUR });
    await resync(ctx);
    assert.equal(cursorOf(ctx.env).resumes[SHOW].episode, 3);
    state.progressEvents.push({ ...gone(1), event_id: 10 });
    await resync(ctx);
    assert.equal(cursorOf(ctx.env).resumes[SHOW].episode, 3, "E1's delete is not E3's resume");
    state.progressEvents.push({ ...gone(3), event_id: 11 });
    await resync(ctx);
    assert.equal(cursorOf(ctx.env).resumes[SHOW], undefined);
  });

  it("never deletes local history because Nuvio deleted a watched item", async () => {
    const { state, ctx } = await bootstrapped("nudhist");
    const before = events(ctx.env, ctx.accountId).length;
    assert.ok(before >= 1);
    state.historyEvents.push({ event_id: 6, operation: "delete", content_id: "tt1111111", content_type: "movie", title: "Movie A", watched_at: NOW - 30 * HOUR });
    await resync(ctx);
    assert.equal(events(ctx.env, ctx.accountId).length, before, "history here is merge-only");
    assert.equal(cursorOf(ctx.env).delta.history, 6, "but the event is consumed, not read again");
  });

  it("falls back to a full read when the change feed fails, and still syncs", async () => {
    const { state, seen, ctx } = await bootstrapped("nudfall");
    seen.nuvio.length = 0;
    state.deltaFails = true;
    state.watched.push({ content_id: "tt4444444", content_type: "movie", title: "Movie D", watched_at: NOW - HOUR });
    state.historyEvents.push(upsertHistory(6));
    await resync(ctx);
    assert.ok(fns(seen).includes("sync_pull_watched_items"), "read it all instead");
    assert.ok(events(ctx.env, ctx.accountId).some((e) => e.imdb === "tt4444444"));
  });

  it("a forced sync and a new profile read everything again", async () => {
    const { state, seen, ctx } = await bootstrapped("nudforce");
    seen.nuvio.length = 0;
    await call(ctx.env, "/api/connections/nuvio/sync", { method: "POST", cookie: ctx.cookie, json: { wait: true, force: true } });
    await pull(ctx.env);
    assert.ok(fns(seen).includes("sync_pull_watched_items"), "force means a full read");
    assert.ok(state.historyEvents.length > 0);
  });

  // --- Positions, mirroring and recovery --------------------------------------
  const positions = (env) => env.DB_ACTIVITY._db.prepare("SELECT p.*, 0 AS x FROM watch_positions p ORDER BY media_id").all();
  const mediaIdOf = (env, imdb) => env.DB._db.prepare("SELECT id FROM media WHERE imdb_id = ?").get(imdb).id;
  const setMirror = (ctx, on) => call(ctx.env, "/api/connections/nuvio/settings", { method: "POST", cookie: ctx.cookie, json: { mirror: on } });
  const goneMovie = (id, over) => ({ event_id: id, operation: "delete", content_id: "tt1111111", content_type: "movie", title: "Movie A", watched_at: NOW - 30 * HOUR, ...over });

  it("keeps Nuvio's position and length for a title part way through", async () => {
    const { ctx } = await bootstrapped("nupos");
    const rows = positions(ctx.env);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].media_id, rows[0].source, rows[0].position_ms, rows[0].duration_ms, rows[0].season, rows[0].episode], [mediaIdOf(ctx.env, "tt3333333"), "nuvio", 1500000, 6000000, null, null]);
  });

  it("moves a show's position to the newer episode, and drops it when finished or deleted", async () => {
    const { state, ctx } = await bootstrapped("nupos2");
    const ep = (n, position, id) => ({ event_id: id, operation: "upsert", progress_key: `${SHOW}_s1e${n}`, content_id: SHOW, content_type: "series", season: 1, episode: n, position, duration: 2400000, last_watched: NOW - HOUR + id });
    state.progressEvents.push(ep(3, 600000, 8));
    await resync(ctx);
    const show = mediaIdOf(ctx.env, SHOW);
    const row = () => positions(ctx.env).find((r) => r.media_id === show);
    assert.deepEqual([row().season, row().episode, row().position_ms], [1, 3, 600000]);
    state.progressEvents.push(ep(4, 900000, 9));
    await resync(ctx);
    assert.deepEqual([row().season, row().episode], [1, 4], "one point per title");
    state.progressEvents.push(ep(4, 2300000, 10));
    await resync(ctx);
    assert.equal(row(), undefined, "90% or more is a finished play, not a position");
    state.progressEvents.push(ep(5, 500000, 11), { ...ep(5, 1, 12), operation: "delete" });
    await resync(ctx);
    assert.equal(row(), undefined, "Nuvio deleted it");
  });

  it("mirroring is off until asked for, and only for Nuvio", async () => {
    const { ctx } = await bootstrapped("numirdef");
    const r = await call(ctx.env, "/api/connections/nuvio/settings", { cookie: ctx.cookie });
    assert.equal(r.body.sync.mirror, false);
    assert.equal((await setMirror(ctx, true)).status, 200);
    assert.equal((await call(ctx.env, "/api/connections/nuvio/settings", { cookie: ctx.cookie })).body.sync.mirror, true);
  });

  it("with mirroring on, a play only Nuvio reported is removed here and kept for 30 days", async () => {
    const { state, ctx } = await bootstrapped("numir1");
    await setMirror(ctx, true);
    state.historyEvents.push(goneMovie(6));
    await resync(ctx);
    assert.ok(!events(ctx.env, ctx.accountId).some((e) => e.imdb === "tt1111111"), "gone from history");
    const kept = ctx.env.DB_ACTIVITY._db.prepare("SELECT * FROM watch_events_removed").all();
    assert.equal(kept.length, 1);
    assert.deepEqual([kept[0].media_id, kept[0].source, kept[0].watched_at], [mediaIdOf(ctx.env, "tt1111111"), "nuvio", NOW - 30 * HOUR]);
  });

  it("with mirroring on, a play another app also reported stays, and only Nuvio's claim goes", async () => {
    const { state, ctx } = await bootstrapped("numir2");
    const act = ctx.env.DB_ACTIVITY._db;
    const id = mediaIdOf(ctx.env, "tt1111111");
    const ev = act.prepare("SELECT id FROM watch_events WHERE media_id = ?").get(id).id;
    act.prepare("UPDATE watch_events SET source = 'trakt' WHERE id = ?").run(ev);
    act.prepare("INSERT OR REPLACE INTO watch_event_sources (event_id, source, watched_at) VALUES (?, 'nuvio', ?)").run(ev, NOW - 30 * HOUR);
    await setMirror(ctx, true);
    state.historyEvents.push(goneMovie(6));
    await resync(ctx);
    assert.equal(act.prepare("SELECT count(*) AS n FROM watch_events WHERE id = ?").get(ev).n, 1, "Trakt's play is not Nuvio's to delete");
    assert.equal(act.prepare("SELECT count(*) AS n FROM watch_event_sources WHERE event_id = ? AND source = 'nuvio'").get(ev).n, 0, "but Nuvio no longer claims it");
    assert.equal(act.prepare("SELECT count(*) AS n FROM watch_events_removed").get().n, 0, "nothing was lost, so nothing to restore");
  });

  it("a removed play comes back with restore, and is purged after 30 days", async () => {
    const { state, ctx } = await bootstrapped("numir3");
    await setMirror(ctx, true);
    state.historyEvents.push(goneMovie(6));
    await resync(ctx);
    const back = await call(ctx.env, "/api/connections/nuvio/restore-removed", { method: "POST", cookie: ctx.cookie, json: {} });
    assert.equal(back.status, 200);
    assert.equal(back.body.restored, 1);
    assert.deepEqual(events(ctx.env, ctx.accountId).filter((e) => e.imdb === "tt1111111").map((e) => [e.watched_at, e.source]), [[NOW - 30 * HOUR, "nuvio"]]);
    state.historyEvents.push(goneMovie(7));
    await resync(ctx);
    ctx.env.DB_ACTIVITY._db.prepare("UPDATE watch_events_removed SET removed_at = ?").run(Date.now() - 31 * 24 * HOUR);
    state.historyEvents.push({ event_id: 8, operation: "upsert", content_id: "tt4444444", content_type: "movie", title: "Movie D", watched_at: NOW - HOUR });
    await resync(ctx);
    assert.equal(ctx.env.DB_ACTIVITY._db.prepare("SELECT count(*) AS n FROM watch_events_removed").get().n, 0, "older than 30 days is gone");
  });

  it("turning mirroring on does not remove anything Nuvio deleted before", async () => {
    const { state, ctx } = await bootstrapped("numir4");
    state.historyEvents.push(goneMovie(6));
    await resync(ctx);
    await setMirror(ctx, true);
    await resync(ctx);
    assert.ok(events(ctx.env, ctx.accountId).some((e) => e.imdb === "tt1111111"), "only deletions from now on");
  });

  it("a full read never deletes, even with mirroring on", async () => {
    const { state, ctx } = await bootstrapped("numir5");
    await setMirror(ctx, true);
    state.watched = [];
    await call(ctx.env, "/api/connections/nuvio/sync", { method: "POST", cookie: ctx.cookie, json: { wait: true, force: true } });
    await pull(ctx.env);
    assert.ok(events(ctx.env, ctx.accountId).some((e) => e.imdb === "tt1111111"), "a snapshot cannot tell a delete from a gap");
  });
});

describe("two-way sync: Nuvio positions", () => {
  async function ready(name, progress = []) {
    const state = { watched: [], progress };
    const seen = fakeServices(state);
    const ctx = await setup(name, { FF_MEDIA_APP_PUSH: "1" });
    await call(ctx.env, "/api/connections/nuvio/login", { method: "POST", cookie: ctx.cookie, json: { email: "viewer@example.test", password: "right-password" } });
    await pull(ctx.env);
    await call(ctx.env, "/api/connections/nuvio/settings", { method: "POST", cookie: ctx.cookie, json: { push: true } });
    await pull(ctx.env);
    return { state, seen, ctx };
  }
  function addPosition(ctx, imdb, kind, season, episode, position, duration, at, source = "plex") {
    const db = ctx.env.DB._db;
    let m = db.prepare("SELECT id FROM media WHERE imdb_id = ?").get(imdb);
    if (!m) m = { id: Number(db.prepare("INSERT INTO media (kind, imdb_id, title, created_at, updated_at) VALUES (?, ?, ?, 1, 1)").run(kind, imdb, "Title " + imdb).lastInsertRowid) };
    ctx.env.DB_ACTIVITY._db.prepare("INSERT INTO watch_positions (account_id, media_id, source, season, episode, position_ms, duration_ms, watched_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(ctx.accountId, m.id, source, season, episode, position, duration, at, at);
  }

  it("sends a position recorded here to Nuvio as progress, once", async () => {
    const { seen, ctx } = await ready("nupush1");
    addPosition(ctx, "tt5555555", "movie", null, null, 600000, 6000000, NOW - 2 * HOUR);
    addPosition(ctx, SHOW, "series", 1, 2, 900000, 2400000, NOW - HOUR);
    await runAgain(ctx, "nuvio");
    const sent = (seen.progressPushed || []).map((e) => [e.content_id, e.content_type, e.video_id, e.season, e.episode, e.position, e.duration, e.last_watched]);
    assert.deepEqual(sent, [
      ["tt5555555", "movie", "tt5555555", undefined, undefined, 600000, 6000000, NOW - 2 * HOUR],
      [SHOW, "series", `${SHOW}:1:2`, 1, 2, 900000, 2400000, NOW - HOUR],
    ]);
    await runAgain(ctx, "nuvio");
    assert.equal(seen.progressPushed.length, 2, "each position is sent once");
  });

  it("never overwrites a position Nuvio has that is as new or newer", async () => {
    const { state, seen, ctx } = await ready("nupush2");
    state.progress = [{ content_id: "tt5555555", content_type: "movie", position: 3000000, duration: 6000000, last_watched: NOW }];
    addPosition(ctx, "tt5555555", "movie", null, null, 600000, 6000000, NOW - HOUR);
    await runAgain(ctx, "nuvio");
    assert.equal((seen.progressPushed || []).length, 0);
  });

  it("does not send a finished title as progress, nor Nuvio's own positions back to it", async () => {
    const { state, seen, ctx } = await ready("nupush3");
    addPosition(ctx, "tt5555555", "movie", null, null, 5800000, 6000000, NOW - HOUR);
    state.progress = [{ content_id: "tt3333333", content_type: "movie", position: 1500000, duration: 6000000, last_watched: NOW - 2 * HOUR }];
    await runAgain(ctx, "nuvio");
    assert.equal((seen.progressPushed || []).length, 0);
    assert.equal(ctx.env.DB_ACTIVITY._db.prepare("SELECT count(*) AS n FROM watch_positions WHERE source = 'nuvio'").get().n, 1, "Nuvio's own is stored, just not returned");
  });
});

describe("Nuvio: rate limits, errors and signing out", () => {
  const watched = () => [{ content_id: "tt1111111", content_type: "movie", title: "Movie A", watched_at: NOW - 30 * HOUR }];
  async function connected(name, extra = {}) {
    const state = { watched: watched(), progress: [], ...extra };
    const seen = fakeServices(state);
    const ctx = await setup(name);
    await call(ctx.env, "/api/connections/nuvio/login", { method: "POST", cookie: ctx.cookie, json: { email: "viewer@example.test", password: "right-password" } });
    await pull(ctx.env);
    return { state, seen, ctx };
  }
  const lastError = (ctx) => ctx.env.DB._db.prepare("SELECT last_error FROM media_app_sync").get().last_error;

  it("waits and tries again when Nuvio answers 429, and the sync still finishes", async () => {
    const { state, seen, ctx } = await connected("nu429");
    state.watched.push({ content_id: "tt4444444", content_type: "movie", title: "Movie D", watched_at: NOW - HOUR });
    state.rateLimited = 2;
    seen.nuvio.length = 0;
    await call(ctx.env, "/api/connections/nuvio/sync", { method: "POST", cookie: ctx.cookie, json: { wait: true, force: true } });
    assert.ok(events(ctx.env, ctx.accountId).some((e) => e.imdb === "tt4444444"), "the play arrived despite two refusals");
    assert.equal(state.rateLimited, 0, "both refusals were used up");
    const repeated = seen.nuvio.some((c, i) => i >= 2 && c.fn === seen.nuvio[i - 1].fn && c.fn === seen.nuvio[i - 2].fn && JSON.stringify(c.body) === JSON.stringify(seen.nuvio[i - 1].body));
    assert.ok(repeated, "the refused call was sent again, three times in all, not given up on");
  });

  it("says Nuvio is busy, instead of a bare status, when it keeps answering 429", async () => {
    const { state, ctx } = await connected("nu429b");
    state.rateLimited = 99;
    await call(ctx.env, "/api/connections/nuvio/sync", { method: "POST", cookie: ctx.cookie, json: { wait: true, force: true } }).catch(() => null);
    assert.match(lastError(ctx) || "", /busy/i);
    assert.doesNotMatch(lastError(ctx) || "", /429/);
  });

  it("explains a conflict and an unprocessable request in words", async () => {
    const { state, ctx } = await connected("nu409");
    for (const [status, pattern] of [[409, /conflict/i], [422, /could not accept/i]]) {
      state.rpcStatus = { sync_pull_watched_items: status };
      await call(ctx.env, "/api/connections/nuvio/sync", { method: "POST", cookie: ctx.cookie, json: { wait: true, force: true } }).catch(() => null);
      assert.match(lastError(ctx) || "", pattern, `status ${status}`);
    }
  });

  it("signs out at Nuvio when the account is disconnected, with the stored token", async () => {
    const { seen, ctx } = await connected("nulogout");
    const gone = await call(ctx.env, "/api/connections/nuvio", { method: "DELETE", cookie: ctx.cookie });
    assert.equal(gone.body.removed, true);
    assert.equal(gone.body.revokedAtProvider, true);
    assert.equal(seen.nuvioLogouts.length, 1);
    assert.match(seen.nuvioLogouts[0].auth, /^Bearer ACCESS-/);
    assert.ok(seen.nuvioLogouts[0].apikey);
  });

  it("still disconnects here when Nuvio's sign-out fails", async () => {
    const { ctx } = await connected("nulogout2", { logoutFails: true });
    const gone = await call(ctx.env, "/api/connections/nuvio", { method: "DELETE", cookie: ctx.cookie });
    assert.equal(gone.body.removed, true);
    assert.equal(ctx.env.DB._db.prepare("SELECT count(*) AS n FROM provider_connections WHERE provider = 'nuvio'").get().n, 0);
  });

  const OVERVIEW = { addons: { "1": 5, "2": 3 }, library_items: { "1": 42, "2": 10 }, watch_progress: { "1": 150, "2": 30 }, watched_items: { "1": 200, "2": 50 }, profiles: { "1": { name: "Main", color: "#1E88E5" } } };
  const settings = async (ctx) => (await call(ctx.env, "/api/connections/nuvio/settings", { cookie: ctx.cookie })).body.sync;

  it("keeps the selected profile's counts from Nuvio's sync overview for the settings card", async () => {
    const { ctx } = await connected("nuover", { overview: OVERVIEW });
    assert.deepEqual((await settings(ctx)).lastResult.overview, { library: 42, progress: 150, watched: 200, addons: 5 }, "profile 1's, not profile 2's");
  });

  it("still finishes the sync, with no counts, when the overview fails or is missing", async () => {
    const bad = await connected("nuover2", { overview: OVERVIEW, overviewFails: true });
    const sync = await settings(bad.ctx);
    assert.equal(sync.lastResult.overview, undefined);
    assert.ok(sync.lastPullAt, "the pull itself completed");
    const none = await connected("nuover3");
    assert.equal((await settings(none.ctx)).lastResult.overview, undefined);
  });

  it("says Nuvio is down, and not that the sign-in failed, when its health check says so", async () => {
    const { state, seen, ctx } = await connected("nuhealth", { health: "down" });
    state.pullFails = true;
    seen.healthChecks = 0;
    await call(ctx.env, "/api/connections/nuvio/sync", { method: "POST", cookie: ctx.cookie, json: { wait: true, force: true } }).catch(() => null);
    assert.ok(seen.healthChecks >= 1, "the health check was asked");
    assert.match(lastError(ctx) || "", /down/i);
    assert.doesNotMatch(lastError(ctx) || "", /sign in/i);
  });

  it("keeps the plain error when Nuvio's health check says it is fine", async () => {
    const { state, ctx } = await connected("nuhealth2", { health: "healthy" });
    state.pullFails = true;
    await call(ctx.env, "/api/connections/nuvio/sync", { method: "POST", cookie: ctx.cookie, json: { wait: true, force: true } }).catch(() => null);
    assert.match(lastError(ctx) || "", /answered 500/);
    assert.doesNotMatch(lastError(ctx) || "", /down/i);
  });

  it("does not call the health check when the sync works", async () => {
    const { seen } = await connected("nuhealth3", { health: "healthy" });
    assert.equal(seen.healthChecks || 0, 0);
  });

  const ROW = (platform, settings_json) => ({ id: "r-" + platform, profile_id: 1, platform, settings_json, updated_at: "2026-01-01T00:00:00Z" });
  const check = (ctx) => call(ctx.env, "/api/connections/nuvio/home-settings-check", { cookie: ctx.cookie });

  it("shows what Nuvio holds for both home catalog platforms, and which one this site uses, reading only", async () => {
    const { seen, ctx } = await connected("nuhome", { homeByPlatform: {
      tv: [ROW("tv", { rows: [1, 2, 3], hidden_catalogs: [], theme: "dark" })],
      home_catalog_shared: [ROW("home_catalog_shared", { items: [{ key: "a" }, { key: "b" }], enabled: true })],
    } });
    seen.nuvio.length = 0;
    const r = await check(ctx);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.usedByThisSite, "home_catalog_shared");
    assert.deepEqual(r.body.platforms, [
      { platform: "tv", rows: 1, updatedAt: "2026-01-01T00:00:00Z", keys: { rows: 3, hidden_catalogs: 0, theme: "string" } },
      { platform: "home_catalog_shared", rows: 1, updatedAt: "2026-01-01T00:00:00Z", keys: { items: 2, enabled: true, items_hidden: 0, my_collection_rows_shown: 0, my_collection_rows_hidden: 0, collection_tiles: 0 } },
    ]);
    assert.deepEqual([...new Set(seen.nuvio.map((c) => c.fn))].sort(), ["sync_pull_home_catalog_settings"], "nothing is written");
    assert.deepEqual(seen.nuvio.map((c) => c.body.p_platform).sort(), ["home_catalog_shared", "tv"]);
  });

  it("reports an empty platform as empty, and one that cannot be read without losing the other", async () => {
    const { ctx } = await connected("nuhome2", { homeByPlatform: { home_catalog_shared: [ROW("home_catalog_shared", { items: [] })] }, homeFailPlatform: "tv" });
    const r = await check(ctx);
    assert.equal(r.status, 200);
    const by = Object.fromEntries(r.body.platforms.map((p) => [p.platform, p]));
    assert.match(by.tv.error, /answered 500/);
    assert.deepEqual([by.home_catalog_shared.rows, by.home_catalog_shared.keys.items], [1, 0]);
    const { ctx: ctx2 } = await connected("nuhome3", { homeByPlatform: {} });
    const empty = await check(ctx2);
    assert.deepEqual(empty.body.platforms.map((p) => [p.platform, p.rows, p.keys]), [["tv", 0, {}], ["home_catalog_shared", 0, {}]]);
  });

  it("needs a connected Nuvio account", async () => {
    const fake = { watched: [], progress: [] };
    fakeServices(fake);
    const ctx = await setup("nuhome4");
    const r = await check(ctx);
    assert.equal(r.status, 404);
  });

  it("counts, among the home rows, which of this site's collection rows Nuvio shows and hides", async () => {
    const mine = (id, enabled) => ({ key: `app.my-list.collections:movie:${id}`, addon_id: "app.my-list.collections", type: "movie", catalog_id: id, enabled, is_collection: false });
    const { ctx } = await connected("nuhome5", { homeByPlatform: { home_catalog_shared: [ROW("home_catalog_shared", { items: [
      mine("a", false), mine("b", false), mine("c", true),
      { key: "com.other:movie:top", enabled: true, is_collection: false },
      { key: "com.other:movie:old", enabled: false, is_collection: false },
      { key: "collection:1", enabled: true, is_collection: true, collection_id: "1" },
    ] })] } });
    const keys = (await check(ctx)).body.platforms.find((p) => p.platform === "home_catalog_shared").keys;
    assert.deepEqual(keys, { items: 6, items_hidden: 3, my_collection_rows_shown: 1, my_collection_rows_hidden: 2, collection_tiles: 1 });
  });
});

describe("Stremio: rate limits and errors", () => {
  const library = () => [{ _id: "tt1111111", type: "movie", name: "Movie A", poster: "https://img.test/a.jpg", _mtime: new Date(NOW - HOUR).toISOString(), state: { lastWatched: new Date(NOW - 30 * HOUR).toISOString(), timesWatched: 1, duration: 7200000, timeOffset: 7100000 } }];
  async function connected(name) {
    const state = { library: library(), episodes: {} };
    const seen = fakeServices(state);
    const ctx = await setup(name);
    await connectStremio(ctx, state);
    await pull(ctx.env);
    return { state, seen, ctx };
  }
  const syncNow = (ctx) => call(ctx.env, "/api/connections/stremio/sync", { method: "POST", cookie: ctx.cookie, json: { wait: true, force: true } }).catch(() => null);
  const lastError = (ctx) => ctx.env.DB._db.prepare("SELECT last_error FROM media_app_sync WHERE provider = 'stremio'").get().last_error;

  it("waits and tries again when Stremio answers 429, and the pull still finishes", async () => {
    const { state, seen, ctx } = await connected("st429");
    state.library.push({ _id: "tt4444444", type: "movie", name: "Movie D", _mtime: new Date(NOW).toISOString(), state: { lastWatched: new Date(NOW - HOUR).toISOString(), timesWatched: 1, duration: 6000000, timeOffset: 5900000 } });
    seen.stremio.length = 0;
    state.stremioRateLimited = 2;
    await syncNow(ctx);
    assert.equal(state.stremioRateLimited, 0, "both refusals were used up");
    assert.ok(seen.stremio.filter((m) => m === "datastoreGet").length >= 3, "the library read was repeated, not given up on");
    assert.ok(events(ctx.env, ctx.accountId).some((e) => e.imdb === "tt4444444"), "and the play arrived");
  });

  it("says Stremio is busy, not a bare status, when it keeps answering 429", async () => {
    const { state, ctx } = await connected("st429b");
    state.stremioRateLimited = 99;
    await syncNow(ctx);
    assert.match(lastError(ctx) || "", /busy/i);
    assert.doesNotMatch(lastError(ctx) || "", /429/);
  });

  it("says Stremio had a problem when it answers with a server error", async () => {
    const { state, ctx } = await connected("st503");
    state.stremioDown = 503;
    await syncNow(ctx);
    assert.match(lastError(ctx) || "", /Stremio had a problem \(503\)/);
  });

  it("does not turn a refused sign-in into a busy or outage message", async () => {
    const { ctx } = await connected("st401");
    const real = globalThis.fetch;
    globalThis.fetch = async (input, init) => (String(input.url || input).includes("datastoreGet") ? json({ error: { message: "Session does not exist" } }) : real(input, init));
    const prev = restore;
    restore = () => { globalThis.fetch = real; prev(); };
    await syncNow(ctx);
    assert.match(lastError(ctx) || "", /Sign in again/);
  });
});

describe("Stremio: installing the addon in the account", () => {
  const URL_OK = "https://example.test/i/" + "a".repeat(43) + "/manifest.json";
  const OTHER = { transportUrl: "https://v3-cinemeta.strem.io/manifest.json", transportName: "http", manifest: { id: "com.linvo.cinemeta", name: "Cinemeta" }, flags: { official: true, protected: true } };
  async function connected(name, extra = {}, env = { FF_MEDIA_APP_PUSH: "1" }) {
    const state = { library: [], episodes: {}, stremioAddons: [structuredClone(OTHER)], ...extra };
    const seen = fakeServices(state);
    const ctx = await setup(name, env);
    await connectStremio(ctx, state);
    return { state, seen, ctx };
  }
  const install = (ctx, manifestUrl = URL_OK) => call(ctx.env, "/api/connections/stremio/install-addon", { method: "POST", cookie: ctx.cookie, json: { manifestUrl } });
  const methods = (seen) => (seen.stremioCalls || []).map((c) => c.method);

  it("asks Stremio to add the addon from its URL, without replacing the collection", async () => {
    const { state, seen, ctx } = await connected("stinst1");
    const r = await install(ctx);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.installed, true);
    assert.ok(!methods(seen).includes("addonCollectionSet"), "no full replace of the person's addons");
    const add = seen.stremioCalls.filter((c) => c.method === "addonCollectionGet" && (c.body.addFromURL || []).length);
    assert.deepEqual(add.map((c) => c.body.addFromURL), [[URL_OK]]);
    assert.ok(state.stremioAddons.some((a) => a.transportUrl === OTHER.transportUrl), "their other addons are untouched");
    assert.ok(state.stremioAddons.some((a) => a.transportUrl === URL_OK));
  });

  it("does nothing when the addon is already there", async () => {
    const { seen, ctx } = await connected("stinst2", { stremioAddons: [structuredClone(OTHER), { transportUrl: URL_OK, manifest: { id: "app.my-list" }, flags: {} }] });
    const r = await install(ctx);
    assert.equal(r.status, 200);
    assert.equal(r.body.alreadyInstalled, true);
    assert.equal(seen.stremioCalls.filter((c) => (c.body.addFromURL || []).length).length, 0, "nothing was asked of Stremio");
  });

  it("says so, and does not claim success, when Stremio did not add it", async () => {
    const { ctx } = await connected("stinst3", { addFromUrlIgnored: true });
    const r = await install(ctx);
    assert.equal(r.status, 502);
    assert.match(r.body.error, /did not add/i);
  });

  it("never sends anything when it could not read the collection", async () => {
    const { seen, ctx } = await connected("stinst4", { addonsMalformed: true });
    const r = await install(ctx);
    assert.notEqual(r.status, 200);
    assert.ok(!methods(seen).includes("addonCollectionSet"));
    assert.equal(seen.stremioCalls.filter((c) => (c.body.addFromURL || []).length).length, 0);
  });

  it("only installs this site's own manifest links", async () => {
    const { seen, ctx } = await connected("stinst5");
    for (const bad of ["https://evil.example/manifest.json", "https://example.test/not-a-manifest", "javascript:alert(1)", "", "https://example.test/i/x/manifest.json?next=https://evil.example"]) {
      assert.equal((await install(ctx, bad)).status, 400, bad);
    }
    assert.equal(methods(seen).filter((m) => m === "addonCollectionGet").length, 0, "Stremio was never asked");
  });

  it("is off until app writes are switched on, and needs a connected account", async () => {
    const off = await connected("stinst6", {}, {});
    assert.equal((await install(off.ctx)).status, 409);
    fakeServices({ library: [], episodes: {} });
    const ctx = await setup("stinst7", { FF_MEDIA_APP_PUSH: "1" });
    assert.equal((await install(ctx)).status, 404);
  });

  it("is for Stremio only", async () => {
    const { ctx } = await connected("stinst8");
    const r = await call(ctx.env, "/api/connections/nuvio/install-addon", { method: "POST", cookie: ctx.cookie, json: { manifestUrl: URL_OK } });
    assert.ok(r.status === 400 || r.status === 404);
  });
});

describe("Stremio: removing one episode", () => {
  // The bitfield as Stremio stores it: "<anchor episode id>:<length>:<deflated bits>".
  const watchedOf = (value, eps) => {
    const last = value.lastIndexOf(":"), mid = value.lastIndexOf(":", last - 1);
    const anchor = eps.findIndex((e) => e.id === value.slice(0, mid));
    const length = Number(value.slice(mid + 1, last));
    const data = inflateSync(Buffer.from(value.slice(last + 1), "base64"));
    const out = [];
    for (let p = 0; p < length; p++) if (data[p >> 3] & (1 << (p & 7))) out.push(eps[p + anchor + 1 - length].episode);
    return out;
  };
  async function connected(name, watchedIdx, extra = {}) {
    const state = { library: [{ _id: SHOW, type: "series", name: "Show S", _mtime: new Date(NOW - HOUR).toISOString(), state: { watched: watchedIdx.length ? bitfield(SHOW_EPS, watchedIdx) : undefined, lastWatched: new Date(NOW - 2 * HOUR).toISOString(), timeOffset: 0 } }], episodes: { [SHOW]: SHOW_EPS }, ...extra };
    const seen = fakeServices(state);
    const ctx = await setup(name, { FF_MEDIA_APP_PUSH: "1" });
    await connectStremio(ctx, state);
    await pull(ctx.env);
    return { state, seen, ctx };
  }
  const remove = (ctx, body) => call(ctx.env, "/api/connections/stremio/remove", { method: "POST", cookie: ctx.cookie, json: { target: "history", id: SHOW, mediaType: "series", ...body } });
  const stored = (state) => state.library.find((i) => i._id === SHOW).state;

  it("clears only that episode's bit and leaves the others watched", async () => {
    const { state, seen, ctx } = await connected("strmep1", [0, 1, 2]);
    const r = await remove(ctx, { season: 1, episode: 2 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.removedInApp, true);
    assert.deepEqual(watchedOf(stored(state).watched, SHOW_EPS), [1, 3], "E2 is no longer watched; E1 and E3 still are");
    assert.equal(seen.puts.length, 1);
    assert.equal(seen.puts[0].length, 1, "one library item written, nothing else touched");
  });

  it("removing the only watched episode leaves the show with none watched", async () => {
    const { state, ctx } = await connected("strmep2", [1]);
    const r = await remove(ctx, { season: 1, episode: 2 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(stored(state).watched, undefined);
  });

  it("changes nothing in Stremio for an episode it does not have as watched", async () => {
    const { state, seen, ctx } = await connected("strmep3", [0]);
    const before = JSON.stringify(stored(state));
    const r = await remove(ctx, { season: 1, episode: 4 });
    assert.equal(r.status, 200);
    assert.equal(r.body.removedInApp, false);
    assert.equal(seen.puts.length, 0, "nothing was written");
    assert.equal(JSON.stringify(stored(state)), before);
  });

  it("writes nothing when the show's episode list cannot be had", async () => {
    const { state, seen, ctx } = await connected("strmep4", [0, 1]);
    state.episodes = {};
    const r = await remove(ctx, { season: 1, episode: 2 });
    assert.notEqual(r.status, 200);
    assert.equal(seen.puts.length, 0, "an unreadable list must never turn into a rewritten bitfield");
  });

  it("a title removal still clears the whole watched state", async () => {
    const { state, ctx } = await connected("strmep5", [0, 1, 2]);
    const r = await remove(ctx, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(stored(state).watched, undefined);
  });
});


describe("two-way sync: Stremio positions", () => {
  const old = new Date(NOW - 50 * HOUR).toISOString();
  const movie = (state = {}) => ({ _id: "tt5555555", type: "movie", name: "Movie P", _mtime: old, state: { lastWatched: old, timesWatched: 0, flaggedWatched: 0, duration: 0, timeOffset: 0, ...state } });
  const show = (state = {}) => ({ _id: SHOW, type: "series", name: "Show S", _mtime: old, state: { video_id: `${SHOW}:1:1`, lastWatched: old, watched: bitfield(SHOW_EPS, [0, 1]), duration: 0, timeOffset: 0, ...state } });

  async function ready(name, library, { push = true } = {}) {
    const state = { approved: true, library, episodes: { [SHOW]: SHOW_EPS } };
    const seen = fakeServices(state);
    const ctx = await setup(name, { FF_MEDIA_APP_PUSH: "1" });
    await connectStremio(ctx, state);
    await pull(ctx.env);
    if (push) { await call(ctx.env, "/api/connections/stremio/settings", { method: "POST", cookie: ctx.cookie, json: { push: true } }); await pull(ctx.env); }
    return { state, seen, ctx };
  }
  function addPosition(ctx, imdb, kind, season, episode, position, duration, at, source = "plex") {
    const db = ctx.env.DB._db;
    let m = db.prepare("SELECT id FROM media WHERE imdb_id = ?").get(imdb);
    if (!m) m = { id: Number(db.prepare("INSERT INTO media (kind, imdb_id, title, created_at, updated_at) VALUES (?, ?, ?, 1, 1)").run(kind, imdb, "Title " + imdb).lastInsertRowid) };
    ctx.env.DB_ACTIVITY._db.prepare("INSERT INTO watch_positions (account_id, media_id, source, season, episode, position_ms, duration_ms, watched_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(ctx.accountId, m.id, source, season, episode, position, duration, at, at);
  }
  const item = (state, id) => state.library.find((i) => i._id === id);

  it("puts a movie's position from another app on the library item, and nothing else", async () => {
    const { state, seen, ctx } = await ready("stpos1", [movie({ timesWatched: 2 })]);
    const at = NOW - 2 * HOUR;
    addPosition(ctx, "tt5555555", "movie", null, null, 600000, 6000000, at);
    await runAgain(ctx, "stremio");
    const st = item(state, "tt5555555").state;
    assert.deepEqual([st.timeOffset, st.duration, st.lastWatched], [600000, 6000000, new Date(at).toISOString()]);
    assert.deepEqual([st.timesWatched, st.flaggedWatched], [2, 0], "the watched counts are not touched");
    assert.equal(st.video_id, undefined, "a movie has no episode id");
    await runAgain(ctx, "stremio");
    assert.equal(seen.puts.length, 1, "each position is sent once");
  });

  it("points a show at the episode, leaving which episodes are watched alone", async () => {
    const { state, ctx } = await ready("stpos2", [show()]);
    const before = item(state, SHOW).state.watched;
    addPosition(ctx, SHOW, "series", 1, 3, 900000, 2400000, NOW - HOUR);
    await runAgain(ctx, "stremio");
    const st = item(state, SHOW).state;
    assert.deepEqual([st.video_id, st.timeOffset, st.duration], [`${SHOW}:1:3`, 900000, 2400000]);
    assert.equal(st.watched, before, "the watched bitfield is exactly as it was");
  });

  it("carries Nuvio's own positions too, but never Stremio's back to Stremio", async () => {
    const { state, ctx } = await ready("stpos3", [movie(), show()]);
    addPosition(ctx, "tt5555555", "movie", null, null, 500000, 5000000, NOW - 3 * HOUR, "nuvio");
    addPosition(ctx, SHOW, "series", 1, 3, 700000, 2400000, NOW - HOUR, "stremio");
    await runAgain(ctx, "stremio");
    assert.equal(item(state, "tt5555555").state.timeOffset, 500000, "from Nuvio");
    assert.equal(item(state, SHOW).state.timeOffset, 0, "Stremio's own is left alone");
  });

  it("never overwrites a resume point that is as new or newer, or sends a finished title", async () => {
    const fresh = new Date(NOW).toISOString();
    const { state, seen, ctx } = await ready("stpos4", [movie({ lastWatched: fresh, timeOffset: 1234, duration: 9999 }), show()]);
    addPosition(ctx, "tt5555555", "movie", null, null, 600000, 6000000, NOW - HOUR);
    addPosition(ctx, SHOW, "series", 1, 3, 2300000, 2400000, NOW - HOUR);
    await runAgain(ctx, "stremio");
    assert.deepEqual([item(state, "tt5555555").state.timeOffset, item(state, "tt5555555").state.duration], [1234, 9999], "Stremio's newer point stays");
    assert.equal(item(state, SHOW).state.timeOffset, 0, "95% is a finished play, not a resume point");
    assert.equal(seen.puts.length, 0, "nothing was written");
  });

  it("leaves titles that are not in the Stremio library alone", async () => {
    const { seen, ctx } = await ready("stpos5", [movie()]);
    addPosition(ctx, "tt8888888", "movie", null, null, 600000, 6000000, NOW - HOUR);
    await runAgain(ctx, "stremio");
    assert.equal(seen.puts.length, 0);
  });

  it("does not push positions while two-way sync is off", async () => {
    const { seen, ctx } = await ready("stpos6", [movie()], { push: false });
    addPosition(ctx, "tt5555555", "movie", null, null, 600000, 6000000, NOW - HOUR);
    await runAgain(ctx, "stremio");
    assert.equal(seen.puts.length, 0);
  });

  it("a position that arrives later is sent without resending the earlier ones", async () => {
    const { state, seen, ctx } = await ready("stpos7", [movie(), show()]);
    addPosition(ctx, "tt5555555", "movie", null, null, 600000, 6000000, NOW - 3 * HOUR);
    await runAgain(ctx, "stremio");
    assert.equal(seen.puts.length, 1);
    addPosition(ctx, SHOW, "series", 1, 3, 900000, 2400000, NOW - HOUR);
    await runAgain(ctx, "stremio");
    assert.equal(seen.puts.length, 2);
    assert.deepEqual(seen.puts[1].map((c) => c._id), [SHOW], "only the new one");
    assert.equal(item(state, SHOW).state.timeOffset, 900000);
  });
});

describe("playback pings (Auto-track) and a connected Stremio", () => {
  const STREMIO_UA = "Mozilla/5.0 (Linux; Android 13) stremio/1.6.0";
  async function account(name, { connect = true, pulling = true } = {}) {
    const state = { approved: true, library: [], episodes: {} };
    fakeServices(state);
    const ctx = await setup(name);
    await ctx.env.CONFIGS.put(`creatorsync:${name}`, JSON.stringify({ config: [], trackOwner: name, trackCreatorName: name, track: true }));
    if (connect) {
      await connectStremio(ctx, state);
      await pull(ctx.env);
      if (!pulling) ctx.env.DB._db.exec("UPDATE media_app_sync SET pull_enabled = 0");
    }
    return ctx;
  }
  const ping = (ctx, name, ua) => call(ctx.env, `/${name}/subtitles/movie/tt0468569.json`, { headers: { "user-agent": ua } });
  const diag = async (ctx, name) => JSON.parse((await ctx.env.CONFIGS.get(`creatortrack:${name}`)) || "{}");
  const recorded = async (ctx, name) => (await ctx.env.CONFIGS.get(`creatorsynctracking:${name}`)) !== null;

  it("does not record a play from Stremio when the account is connected and pulling its real history", async () => {
    const ctx = await account("pingskip");
    const r = await ping(ctx, "pingskip", STREMIO_UA);
    assert.equal(r.status, 200);
    assert.equal(await recorded(ctx, "pingskip"), false);
    assert.match((await diag(ctx, "pingskip")).matched, /skipped \(Stremio is connected/);
  });

  it("still records a play from any other app, even with Stremio connected", async () => {
    const ctx = await account("pingwako");
    await ping(ctx, "pingwako", "Wako/2.1 (iOS)");
    assert.doesNotMatch((await diag(ctx, "pingwako")).matched || "", /skipped/);
    assert.equal(await recorded(ctx, "pingwako"), true);
  });

  it("still records a play from Stremio when the account is not connected, or its pull is off", async () => {
    const none = await account("pingnone", { connect: false });
    await ping(none, "pingnone", STREMIO_UA);
    assert.equal(await recorded(none, "pingnone"), true, "not connected");
    const off = await account("pingoff", { pulling: false });
    await ping(off, "pingoff", STREMIO_UA);
    assert.equal(await recorded(off, "pingoff"), true, "pull switched off");
  });

  it("records again once the connection needs signing in again", async () => {
    const ctx = await account("pingreauth");
    ctx.env.DB._db.prepare("UPDATE provider_connections SET status = 'reauth_required' WHERE provider = 'stremio'").run();
    await ping(ctx, "pingreauth", STREMIO_UA);
    assert.equal(await recorded(ctx, "pingreauth"), true, "nothing is syncing, so the ping is the only record");
  });
});
