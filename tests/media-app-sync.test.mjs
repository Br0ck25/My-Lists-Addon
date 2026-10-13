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
import { deflateSync } from "node:zlib";

import { call, createUser, makeD1, makeEnv, makeQueue, runScheduledTick } from "./harness.mjs";

const TEST_KEY = "k1:" + Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => 120 + i)).toString("base64");
const HOUR = 3600 * 1000;
const NOW = Date.now();

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let restore = null;
afterEach(() => { if (restore) restore(); restore = null; });

// --- The fakes ---------------------------------------------------------------

function fakeServices(state) {
  const seen = { stremio: [], nuvio: [], nuvioRefresh: [], nuvioSignIns: [], cinemeta: [] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const href = typeof input === "string" ? input : input.url;
    const url = new URL(href);
    const body = init.body ? JSON.parse(init.body) : {};
    if (url.hostname === "link.stremio.com") {
      if (url.pathname.endsWith("/create")) return json({ result: { code: "ABCD1234", link: "https://link.stremio.com/?code=ABCD1234", qrcode: "data:image/png;base64,AA" } });
      if (url.pathname.endsWith("/read")) {
        seen.stremio.push("read:" + url.searchParams.get("code"));
        return state.approved ? json({ result: { authKey: "AUTHKEY-SECRET" } }) : json({ error: { code: 101, message: "pending" } });
      }
    }
    if (url.hostname === "api.strem.io") {
      const method = url.pathname.replace("/api/", "");
      seen.stremio.push(method);
      if (body.authKey !== "AUTHKEY-SECRET") return json({ error: { message: "Session does not exist" } });
      if (method === "getUser") return json({ result: { _id: "u1", email: "viewer@example.test" } });
      if (method === "logout") return json({ result: { success: true } });
      if (method === "datastoreGet") return json({ result: state.library });
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
        if (fn === "sync_pull_watched_items") return json(body.p_page === 1 ? state.watched || [] : []);
        if (fn === "sync_pull_watch_progress") return json(state.progress || []);
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
  return { env, cookie, accountId };
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
  state.approved = true;
  const r = await call(ctx.env, "/api/connections/stremio/link/poll", { method: "POST", cookie: ctx.cookie, json: { code: "abcd1234" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r;
}

describe("Stremio: connecting with the Link flow", () => {
  it("starts a link, waits while it is not approved, then stores the authKey encrypted", async () => {
    const state = { approved: false, library: [], episodes: {} };
    const seen = fakeServices(state);
    const ctx = await setup("stremconn");
    const started = await call(ctx.env, "/api/connections/stremio/link/start", { method: "POST", cookie: ctx.cookie, json: {} });
    assert.equal(started.body.code, "ABCD1234");
    assert.match(started.body.link, /^https:\/\/link\.stremio\.com\//);

    const waiting = await call(ctx.env, "/api/connections/stremio/link/poll", { method: "POST", cookie: ctx.cookie, json: { code: "abcd1234" } });
    assert.equal(waiting.body.status, "pending");
    assert.equal(ctx.env.DB._db.prepare("SELECT count(*) AS n FROM provider_connections").get().n, 0, "nothing is stored before the person approves");

    const done = await connectStremio(ctx, state);
    assert.equal(done.body.status, "connected");
    assert.equal(done.body.username, "viewer@example.test");
    const row = ctx.env.DB._db.prepare("SELECT access_token_enc, status FROM provider_connections WHERE provider = 'stremio'").get();
    assert.equal(row.status, "ok");
    assert.ok(row.access_token_enc && !row.access_token_enc.includes("AUTHKEY-SECRET"), "the authKey is encrypted at rest");
    assert.ok(seen.stremio.includes("read:ABCD1234"), "the code is sent upper case");
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
    const anon = await call(ctx.env, "/api/connections/stremio/link/start", { method: "POST", json: {} });
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
    await connectStremio(ctx, state);
    // The ping fired when the film started, two hours before Stremio's lastWatched.
    const start = Date.parse(state.library[0].state.lastWatched) - 2 * HOUR;
    const refMedia = ctx.env.DB._db.prepare("INSERT INTO media (kind, imdb_id, title, created_at, updated_at) VALUES ('movie', 'tt1111111', 'Movie A', 1, 1)").run().lastInsertRowid;
    ctx.env.DB_ACTIVITY._db.prepare("INSERT INTO watch_events (account_id, media_id, watched_at, source, dedupe_key) VALUES (?, ?, ?, 'ping', 'ping-1')").run(ctx.accountId, refMedia, start);
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
    await pull(ctx.env, 2);
    // The shared renewal path marks it "expired" (28_); either way it is no longer "ok".
    assert.notEqual(ctx.env.DB._db.prepare("SELECT status FROM provider_connections WHERE provider = 'nuvio'").get().status, "ok");
    assert.match(ctx.env.DB._db.prepare("SELECT last_error FROM media_app_sync").get().last_error, /sign in again/);
    assert.equal(events(ctx.env, ctx.accountId).length, 0);
  });
});

describe("the hourly sweep", () => {
  it("starts a pull for connected accounts whose last pull is old, and not for others", async () => {
    const state = { approved: true, library: [], episodes: {} };
    fakeServices(state);
    const ctx = await setup("sweepacct", { JOBS: makeQueue() });
    await connectStremio(ctx, state);
    ctx.env.DB._db.exec("UPDATE jobs SET status = 'done' WHERE type = 'mediaapp.sync-account'");
    ctx.env.DB._db.prepare("UPDATE media_app_sync SET last_pull_at = ?").run(Date.now() - 5 * 60 * 1000);
    ctx.env.DB._db.exec("UPDATE jobs SET run_after = 1 WHERE dedupe_key = 'periodic:mediaapp.sync'");
    await runScheduledTick(ctx.env);
    assert.equal(ctx.env.DB._db.prepare("SELECT status FROM jobs WHERE type = 'mediaapp.sync-account'").get().status, "done", "pulled five minutes ago: left alone");
    ctx.env.DB._db.prepare("UPDATE media_app_sync SET last_pull_at = ?").run(Date.now() - 2 * HOUR);
    ctx.env.DB._db.exec("UPDATE jobs SET run_after = 1 WHERE dedupe_key = 'periodic:mediaapp.sync'");
    await runScheduledTick(ctx.env);
    assert.notEqual(ctx.env.DB._db.prepare("SELECT status FROM jobs WHERE type = 'mediaapp.sync-account'").get().status, "done", "two hours ago: started again");
  });
});
