import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { call, createUser, makeD1, makeEnv, makeKv, seedAnonPublishedList } from "./harness.mjs";

// Phase 3b: lists, likes and channels as rows (migrations/0016_lists_v2.sql).
//
// Nothing in the Worker reads these tables yet. These tests pin down what the
// later tasks (P3b-2 to P3b-9) will lean on, so a change to the migration that
// breaks one of those promises fails here rather than in the backfill.
// makeD1 provisions from schema.sql, which the drift tests in worker.test.mjs
// keep identical to running every migration in order.

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION = fs.readFileSync(path.join(REPO_ROOT, "migrations/0016_lists_v2.sql"), "utf8");

function freshDb() {
  const db = makeD1()._db;
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  run("INSERT INTO accounts (id, username, display_name, key_hash, created_at) VALUES (1, 'ann', 'Ann', 'h', 0)");
  run("INSERT INTO accounts (id, username, display_name, key_hash, created_at) VALUES (2, 'ben', 'Ben', 'h', 0)");
  return { db, run, all, get };
}

function addMedia(t, id, kind, cols = {}) {
  t.run("INSERT INTO media (id, kind, tmdb_id, imdb_id, alt_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0)",
    id, kind, cols.tmdb ?? null, cols.imdb ?? null, cols.alt ?? null);
}

function addList(t, id, owner, slug, extra = {}) {
  t.run(`INSERT INTO lists (id, public_id, owner_account_id, slug, name, media_type, visibility, kind, legacy_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    id, extra.publicId || `p${id}`, owner, slug, extra.name || slug, extra.mediaType || "mixed",
    extra.visibility || "private", extra.kind || "custom", extra.legacyId ?? null);
}

function addItem(t, listId, mediaId, position, season = null, episode = null) {
  return t.run("INSERT INTO list_items (list_id, media_id, season, episode, position, added_at) VALUES (?, ?, ?, ?, ?, 0)",
    listId, mediaId, season, episode, position);
}

describe("P3b-1: the lists v2 schema", () => {
  it("records itself in the migration ledger and applies twice without error", () => {
    const t = freshDb();
    t.run("DELETE FROM schema_migrations WHERE version = '0016'");
    t.db.exec(MIGRATION);
    t.db.exec(MIGRATION);
    const row = t.get("SELECT applied_at FROM schema_migrations WHERE version = '0016'");
    assert.ok(row && row.applied_at > 0, "0016 is in the ledger with a real timestamp");
  });

  it("can be pasted into the D1 Console as it is: no semicolon or apostrophe in a comment", () => {
    // A console that splits statements on semicolons, or tracks quotes, would
    // cut a statement in half on one of these. The SQL itself is fine.
    const bad = MIGRATION.split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => line.trim().startsWith("--") && /[;']/.test(line));
    assert.deepEqual(bad, [], "comment lines with ; or ' in 0016_lists_v2.sql");
  });

  it("keeps one media row per title, with TMDB ids scoped by kind", () => {
    const t = freshDb();
    addMedia(t, 1, "movie", { tmdb: 550 });
    addMedia(t, 2, "series", { tmdb: 550 }); // TMDB reuses numbers across movies and TV
    assert.throws(() => addMedia(t, 3, "movie", { tmdb: 550 }), /UNIQUE/);
    addMedia(t, 4, "series", { imdb: "tt0903747" });
    assert.throws(() => addMedia(t, 5, "movie", { imdb: "tt0903747" }), /UNIQUE/);
    addMedia(t, 6, "series", { alt: "kitsu:1" });
    assert.throws(() => addMedia(t, 7, "series", { alt: "kitsu:1" }), /UNIQUE/);
    assert.throws(() => addMedia(t, 8, "show"), /CHECK/, "kind is movie or series, as everywhere else in the add-on");
  });

  it("lets an unresolved title exist with only the id it came with", () => {
    const t = freshDb();
    addMedia(t, 1, "movie", { imdb: "tt9999999" });
    const row = t.get("SELECT title, resolved_at FROM media WHERE id = 1");
    assert.equal(row.title, null);
    assert.equal(row.resolved_at, null);
    const due = t.all("SELECT id FROM media WHERE resolved_at IS NULL ORDER BY updated_at LIMIT 90");
    assert.deepEqual(due.map((r) => r.id), [1]);
  });

  it("holds a whole title once per list, but each episode of a show separately", () => {
    const t = freshDb();
    addMedia(t, 1, "series", { imdb: "tt0944947" });
    addList(t, 10, 1, "crossover");
    addItem(t, 10, 1, 1);
    assert.throws(() => addItem(t, 10, 1, 2), /UNIQUE/, "the same whole show twice");
    // Storyline and crossover lists hold single episodes of one show.
    addItem(t, 10, 1, 3, 1, 1);
    addItem(t, 10, 1, 4, 1, 2);
    addItem(t, 10, 1, 5, 0, 1); // a special: season 0 is a real season
    assert.throws(() => addItem(t, 10, 1, 6, 1, 2), /UNIQUE/, "the same episode twice");
    // What the item API will use for an idempotent add.
    const again = t.run("INSERT OR IGNORE INTO list_items (list_id, media_id, position, added_at) VALUES (10, 1, 9, 0)");
    assert.equal(again.changes, 0);
    assert.equal(t.get("SELECT count(*) AS n FROM list_items WHERE list_id = 10").n, 4);
  });

  it("does not let a title in a list be deleted out from under it", () => {
    const t = freshDb();
    addMedia(t, 1, "movie", { imdb: "tt0111161" });
    addList(t, 10, 1, "faves");
    addItem(t, 10, 1, 1);
    assert.throws(() => t.run("DELETE FROM media WHERE id = 1"), /FOREIGN KEY/);
  });

  it("gives each live list its own address, and frees it when the list is deleted", () => {
    const t = freshDb();
    addList(t, 10, 1, "top-10");
    assert.throws(() => addList(t, 11, 1, "top-10"), /UNIQUE/);
    addList(t, 12, 2, "top-10"); // another account: unrelated
    t.run("UPDATE lists SET deleted_at = 1 WHERE id = 10");
    addList(t, 13, 1, "top-10");
    assert.throws(() => addList(t, 14, 1, "x", { visibility: "friends" }), /CHECK/);
    assert.throws(() => addList(t, 15, 1, "y", { mediaType: "anime" }), /CHECK/);
  });

  it("keeps legacy anonymous lists ownerless and apart by their legacy id", () => {
    const t = freshDb();
    addList(t, 20, null, "cozy", { kind: "legacy_anonymous", legacyId: "a:cozy" });
    addList(t, 21, null, "cozy-2", { kind: "legacy_anonymous", legacyId: "a:cozy-2" });
    // The backfill runs again safely: the same legacy record is not copied twice.
    const again = t.run(`INSERT OR IGNORE INTO lists (public_id, owner_account_id, slug, name, media_type, kind, legacy_id, created_at, updated_at)
                         VALUES ('p99', NULL, 'cozy', 'cozy', 'mixed', 'legacy_anonymous', 'a:cozy', 0, 0)`);
    assert.equal(again.changes, 0);
    const found = t.get("SELECT id FROM lists WHERE owner_account_id IS NULL AND slug = 'cozy' AND deleted_at IS NULL");
    assert.equal(found.id, 20);
  });

  it("removes an account's lists, items, preferences, presets and old addresses with it, but keeps its shared channels", () => {
    const t = freshDb();
    addMedia(t, 1, "movie", { imdb: "tt0068646" });
    addList(t, 10, 1, "mine");
    addItem(t, 10, 1, 1);
    t.run("INSERT INTO list_slug_history (owner_account_id, old_slug, list_id, created_at) VALUES (1, 'old-mine', 10, 0)");
    t.run("INSERT INTO account_list_prefs (account_id, pref, target, created_at) VALUES (1, 'liked', 'c:ben:faves', 0)");
    t.run("INSERT INTO presets (account_id, name, config_json, created_at, updated_at) VALUES (1, 'Main', '{}', 0, 0)");
    t.run(`INSERT INTO channels (public_code, owner_account_id, name, visibility, created_at, updated_at)
           VALUES ('abc123', 1, 'Saturday Mornings', 'public', 0, 0)`);
    addList(t, 11, 2, "bens"); // someone else's, untouched

    t.run("DELETE FROM accounts WHERE id = 1");
    const count = (table) => t.get(`SELECT count(*) AS n FROM ${table}`).n;
    assert.equal(t.get("SELECT count(*) AS n FROM lists WHERE owner_account_id = 1").n, 0);
    assert.equal(count("list_items"), 0);
    assert.equal(count("list_slug_history"), 0);
    assert.equal(count("account_list_prefs"), 0);
    assert.equal(count("presets"), 0);
    assert.equal(t.get("SELECT count(*) AS n FROM lists WHERE owner_account_id = 2").n, 1);
    // People who added a shared channel keep it.
    const ch = t.get("SELECT owner_account_id FROM channels WHERE public_code = 'abc123'");
    assert.equal(ch.owner_account_id, null);
  });

  it("counts a like once per voter, so like_count can follow changes()", () => {
    const t = freshDb();
    const like = (voter) => t.run("INSERT OR IGNORE INTO likes (target_type, target_id, voter, created_at) VALUES ('list', 'p10', ?, 0)", voter);
    assert.equal(like("acct:1").changes, 1);
    assert.equal(like("acct:1").changes, 0, "a repeat like changes nothing");
    assert.equal(like("a:9f86d081").changes, 1, "a legacy signed-out vote is carried as it is (D-9)");
    const unlike = t.run("DELETE FROM likes WHERE target_type = 'list' AND target_id = 'p10' AND voter = 'acct:1'");
    assert.equal(unlike.changes, 1);
    assert.equal(t.get("SELECT count(*) AS n FROM likes WHERE target_type = 'list' AND target_id = 'p10'").n, 1);
  });

  it("keeps one row per synced channel for each account", () => {
    const t = freshDb();
    const add = (code, owner, clientId) => t.run(
      "INSERT INTO channels (public_code, owner_account_id, client_id, name, created_at, updated_at) VALUES (?, ?, ?, 'C', 0, 0)",
      code, owner, clientId);
    add("c1", 1, "ch_1");
    assert.throws(() => add("c2", 1, "ch_1"), /UNIQUE/);
    add("c3", 2, "ch_1"); // another account's browser can use the same id
    add("c4", 1, null); // a shared channel with no synced copy
    add("c5", 1, null);
    assert.throws(() => add("c1", 2, "ch_9"), /UNIQUE/, "share codes are unique");
  });

  it("maintains search by rowid, and a removed list stops matching", () => {
    const t = freshDb();
    t.run("INSERT INTO lists_fts2 (rowid, name, description, owner_name) VALUES (10, 'Crème de la crème', 'The best films', 'Ann')");
    t.run("INSERT INTO lists_fts2 (rowid, name, description, owner_name) VALUES (11, 'Cozy mysteries', 'Rainy day watching', 'Ben')");
    const match = (q) => t.all("SELECT rowid FROM lists_fts2 WHERE lists_fts2 MATCH ? ORDER BY rank", q).map((r) => r.rowid);
    assert.deepEqual(match("creme"), [10], "accents are folded");
    assert.deepEqual(match("ben"), [11], "the owner name is searchable");
    // A rename is a delete and an insert by rowid: no old values needed.
    t.run("DELETE FROM lists_fts2 WHERE rowid = 10");
    t.run("INSERT INTO lists_fts2 (rowid, name, description, owner_name) VALUES (10, 'Top picks', 'The best films', 'Ann')");
    assert.deepEqual(match("creme"), []);
    assert.deepEqual(match("picks"), [10]);
    t.run("DELETE FROM lists_fts2 WHERE rowid = 11");
    assert.deepEqual(match("cozy"), []);
    t.run("INSERT INTO lists_fts2 (lists_fts2) VALUES ('integrity-check')");
  });

  it("serves the directory, a list page and a jobs sweep from indexes", () => {
    const t = freshDb();
    const plan = (sql) => t.all(`EXPLAIN QUERY PLAN ${sql}`).map((r) => r.detail).join(" | ");
    const expectIndex = (sql, index) => {
      const p = plan(sql);
      assert.match(p, new RegExp(`INDEX ${index}\\b`), `${sql}\n  plan: ${p}`);
      assert.doesNotMatch(p, /TEMP B-TREE/, `no sort step for: ${sql}\n  plan: ${p}`);
    };
    // Today's directory order (likes, then most recently updated), first page and the next by cursor.
    expectIndex("SELECT id FROM lists WHERE visibility = 'public' AND deleted_at IS NULL ORDER BY like_count DESC, updated_at DESC, id DESC LIMIT 100", "idx_lists_dir_popular");
    expectIndex("SELECT id FROM lists WHERE visibility = 'public' AND deleted_at IS NULL AND (like_count, updated_at, id) < (5, 100, 9) ORDER BY like_count DESC, updated_at DESC, id DESC LIMIT 100", "idx_lists_dir_popular");
    expectIndex("SELECT id FROM lists WHERE visibility = 'public' AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 100", "idx_lists_dir_new");
    expectIndex("SELECT id FROM lists WHERE owner_account_id = 1 AND deleted_at IS NULL ORDER BY position", "idx_lists_owner");
    expectIndex("SELECT id FROM lists WHERE owner_account_id = 1 AND slug = 'x' AND deleted_at IS NULL", "idx_lists_owner_slug");
    expectIndex("SELECT media_id FROM list_items WHERE list_id = 10 ORDER BY position LIMIT 100 OFFSET 100", "idx_list_items_order");
    expectIndex("SELECT id FROM channels WHERE visibility = 'public' AND deleted_at IS NULL ORDER BY published_at DESC, id DESC LIMIT 60", "idx_channels_dir_new");
    expectIndex("SELECT id FROM channels WHERE visibility = 'public' AND deleted_at IS NULL ORDER BY add_count DESC, like_count DESC, id DESC LIMIT 60", "idx_channels_dir_added");
    expectIndex("SELECT id FROM jobs WHERE status = 'queued' AND run_after <= 5 ORDER BY run_after LIMIT 10", "idx_jobs_due");
  });
});

// --- P3b-2: the media resolver (29_media.js) ----------------------------------
//
// Loaded into a sandbox with a fake TMDB, over the real-SQLite D1 from the
// harness (which enforces D1's 100-parameter limit). Values made inside the
// sandbox belong to another realm, so they are compared after a JSON round trip.

const plain = (v) => JSON.parse(JSON.stringify(v));

function loadMedia() {
  const sandbox = { console, URL, URLSearchParams, TextEncoder, TextDecoder, Response, Headers, Request, crypto: globalThis.crypto };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of ["00_constants.js", "29_media.js"]) {
    vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"), sandbox, { filename: rel });
  }
  return sandbox;
}

// A fake TMDB: `movies` and `shows` by TMDB id, `finds` by IMDb id.
function fakeTmdb(sb, { movies = {}, shows = {}, finds = {}, fail = false, delayMs = 0 } = {}) {
  const calls = [];
  let inFlight = 0;
  const tmdb = { calls, maxInFlight: 0 };
  sb.fetch = async (url) => {
    const u = new URL(String(url));
    calls.push(u.pathname);
    inFlight++;
    tmdb.maxInFlight = Math.max(tmdb.maxInFlight, inFlight);
    try {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (fail) return new Response("upstream down", { status: 500 });
      const [, , kind, id] = u.pathname.split("/");
      let body = null;
      if (kind === "movie") body = movies[id];
      else if (kind === "tv") body = shows[id];
      else if (kind === "find") body = finds[id] || { movie_results: [], tv_results: [] };
      if (!body) return new Response(JSON.stringify({ status_code: 34 }), { status: 404 });
      return new Response(JSON.stringify(body), { status: 200 });
    } finally {
      inFlight--;
    }
  };
  return tmdb;
}

const BREAKING_BAD = { id: 1396, name: "Breaking Bad", first_air_date: "2008-01-20", poster_path: "/bb.jpg", backdrop_path: "/bbb.jpg" };
const FIGHT_CLUB = { id: 550, title: "Fight Club", release_date: "1999-10-15", poster_path: "/fc.jpg" };

function mediaEnv(extra = {}) {
  return { DB: makeD1(), TMDB_API_KEY: "test-key", ...extra };
}

const mediaRows = (env) => env.DB._db.prepare("SELECT * FROM media ORDER BY id").all();

describe("P3b-2: the media resolver", () => {
  it("reads every id form list items use", () => {
    const sb = loadMedia();
    const n = (item, hint) => plain(sb.normalizeMediaRef(item, hint));
    assert.deepEqual(n({ id: "tt0903747:1:2", type: "series" }),
      { kind: "series", imdbId: "tt0903747", tmdbId: null, altId: null, title: null, year: null });
    assert.equal(n({ id: "tmdb:550", type: "movie", name: "Fight Club", year: "1999" }).tmdbId, 550);
    assert.equal(n({ id: "tmdb:550", name: "Fight Club", year: "1999" }).year, 1999);
    assert.equal(n({ id: "tmdb:tv:1396" }).kind, "series", "the id itself can say it is a show");
    assert.equal(n({ id: "1396", type: "tv" }).tmdbId, 1396, "a bare number is a TMDB id");
    assert.equal(n({ id: "kitsu:1", type: "series" }).altId, "kitsu:1");
    assert.equal(n({ id: "tt0137523" }).kind, "movie", "no type: a movie, as the legacy list code assumes");
    assert.equal(n({ id: "tt0137523" }, "series").kind, "series", "unless the list says otherwise");
    assert.equal(n({ id: "tt0137523", name: "Untitled" }).title, null, "the page's placeholder name is not a title");
    assert.equal(n({ id: "" }), null);
    assert.equal(n({ name: "No id at all" }), null);
    assert.equal(n(null), null);
  });

  it("files an episode entry under its show, never under the episode's own id", () => {
    const sb = loadMedia();
    // The storyline list builder's shape: `id` is TMDB's EPISODE id.
    const ep = plain(sb.normalizeMediaRef({ id: "62085", type: "episode", showId: "1396", showTitle: "Breaking Bad", name: "Pilot", seasonNum: 1, episodeNum: 1 }));
    assert.equal(ep.kind, "series");
    assert.equal(ep.tmdbId, 1396);
    assert.equal(ep.title, "Breaking Bad", "the show's title, not the episode's");
    assert.equal(sb.normalizeMediaRef({ id: "62085", type: "episode" }), null, "an episode with no show id has nothing to file it under");
  });

  it("resolves an IMDb id through /find, stores what TMDB says, and asks only once", async () => {
    const sb = loadMedia();
    const tmdb = fakeTmdb(sb, { finds: { tt0903747: { movie_results: [], tv_results: [BREAKING_BAD] } } });
    const env = mediaEnv();
    const first = await sb.resolveMediaBatch(env, [{ id: "tt0903747", type: "series", name: "BB" }]);
    assert.deepEqual(plain(first.stats), { total: 1, unusable: 0, found: 0, resolved: 1, stubs: 0, lookups: 1 });
    const [row] = mediaRows(env);
    assert.equal(row.id, first.ids[0]);
    assert.deepEqual(
      { kind: row.kind, tmdb: row.tmdb_id, imdb: row.imdb_id, title: row.title, year: row.year, poster: row.poster_path, resolved: row.resolved_at > 0 },
      { kind: "series", tmdb: 1396, imdb: "tt0903747", title: "Breaking Bad", year: 2008, poster: "/bb.jpg", resolved: true });

    const again = await sb.resolveMedia(env, { imdbId: "tt0903747" });
    assert.equal(again, first.ids[0]);
    assert.equal(tmdb.calls.length, 1, "the second time is answered by the database");
  });

  it("resolves a TMDB id through /{kind}/{id}, picking up its IMDb and TVDB ids", async () => {
    const sb = loadMedia();
    fakeTmdb(sb, { shows: { 1396: { ...BREAKING_BAD, external_ids: { imdb_id: "tt0903747", tvdb_id: 81189 } } } });
    const env = mediaEnv();
    const id = await sb.resolveMedia(env, { id: "tmdb:1396", type: "series" });
    const [row] = mediaRows(env);
    assert.equal(row.id, id);
    assert.equal(row.imdb_id, "tt0903747");
    assert.equal(row.tvdb_id, 81189);
    // The same show named by its IMDb id is the same row.
    assert.equal(await sb.resolveMedia(env, { id: "tt0903747" }), id);
  });

  it("recognises a title met under a new id, and adds the id to its row", async () => {
    const sb = loadMedia();
    const tmdb = fakeTmdb(sb, { finds: { tt0903747: { tv_results: [BREAKING_BAD] } } });
    const env = mediaEnv();
    // Known so far only by its TMDB id.
    env.DB._db.prepare("INSERT INTO media (id, kind, tmdb_id, title, resolved_at, created_at, updated_at) VALUES (7, 'series', 1396, 'Breaking Bad', 1, 1, 1)").run();
    const id = await sb.resolveMedia(env, { id: "tt0903747", type: "series" });
    assert.equal(id, 7);
    assert.equal(tmdb.calls.length, 1);
    const rows = mediaRows(env);
    assert.equal(rows.length, 1, "no second row for the same show");
    assert.equal(rows[0].imdb_id, "tt0903747");
  });

  it("lets TMDB decide the kind when a list filed a show as a movie", async () => {
    const sb = loadMedia();
    fakeTmdb(sb, { finds: { tt0903747: { movie_results: [], tv_results: [BREAKING_BAD] } } });
    const env = mediaEnv();
    await sb.resolveMedia(env, { id: "tt0903747", type: "movie" });
    assert.equal(mediaRows(env)[0].kind, "series");
  });

  it("keeps a stub for what TMDB cannot place, with only the ids it came with", async () => {
    const sb = loadMedia();
    fakeTmdb(sb, {}); // /find answers with no results
    const env = mediaEnv();
    const { ids, stats } = await sb.resolveMediaBatch(env, [{ id: "tt9999999", name: "Lost Film", year: "1931" }]);
    assert.equal(stats.stubs, 1);
    const [row] = mediaRows(env);
    assert.equal(row.id, ids[0]);
    assert.deepEqual(
      { kind: row.kind, imdb: row.imdb_id, tmdb: row.tmdb_id, title: row.title, year: row.year, resolved: row.resolved_at },
      { kind: "movie", imdb: "tt9999999", tmdb: null, title: "Lost Film", year: 1931, resolved: null });
  });

  it("makes stubs, and loses nothing, when TMDB is down or there is no key", async () => {
    const sb = loadMedia();
    const tmdb = fakeTmdb(sb, { fail: true });
    const env = mediaEnv();
    const down = await sb.resolveMediaBatch(env, [{ id: "tt0137523" }, { id: "tmdb:1396", type: "series" }]);
    assert.equal(down.stats.stubs, 2);
    assert.ok(down.ids.every((id) => Number.isInteger(id)));

    const noKey = mediaEnv({ TMDB_API_KEY: "" });
    tmdb.calls.length = 0;
    const res = await sb.resolveMediaBatch(noKey, [{ id: "tt0137523" }, { id: "kitsu:1", type: "series" }]);
    assert.equal(tmdb.calls.length, 0, "nothing is asked without a key");
    assert.equal(res.stats.stubs, 2);
    assert.equal(mediaRows(noKey).find((r) => r.alt_id === "kitsu:1").kind, "series");
  });

  it("stays within the caller's lookup budget", async () => {
    const sb = loadMedia();
    const tmdb = fakeTmdb(sb, { finds: {} });
    const env = mediaEnv();
    const { stats } = await sb.resolveMediaBatch(env, [{ id: "tt0000001" }, { id: "tt0000002" }, { id: "tt0000003" }], { maxLookups: 1 });
    assert.equal(tmdb.calls.length, 1);
    assert.equal(stats.lookups, 1);
    assert.equal(stats.stubs, 3);
    assert.equal(mediaRows(env).length, 3, "every title still gets its row");
  });

  it("asks TMDB once for a title that appears many times in one batch", async () => {
    const sb = loadMedia();
    const tmdb = fakeTmdb(sb, { movies: { 550: { ...FIGHT_CLUB, external_ids: { imdb_id: "tt0137523" } } } });
    const env = mediaEnv();
    const items = [{ id: "tmdb:550", type: "movie" }, { id: "tmdb:550", type: "movie" }, { tmdbId: 550, type: "movie" }];
    const { ids, stats } = await sb.resolveMediaBatch(env, items);
    assert.equal(tmdb.calls.length, 1);
    assert.equal(new Set(ids).size, 1);
    assert.equal(stats.resolved, 3, "counted per input");
    assert.equal(mediaRows(env).length, 1);
  });

  it("files every episode of a show on the show's one row", async () => {
    const sb = loadMedia();
    fakeTmdb(sb, { shows: { 1396: { ...BREAKING_BAD, external_ids: { imdb_id: "tt0903747" } } } });
    const env = mediaEnv();
    const eps = [1, 2, 3].map((e) => ({ id: String(62084 + e), type: "episode", showId: "1396", seasonNum: 1, episodeNum: e }));
    const { ids } = await sb.resolveMediaBatch(env, eps);
    assert.equal(new Set(ids).size, 1);
    assert.equal(mediaRows(env)[0].tmdb_id, 1396);
  });

  it("answers null for an input with no usable id, and keeps the order of the rest", async () => {
    const sb = loadMedia();
    fakeTmdb(sb, { finds: { tt0903747: { tv_results: [BREAKING_BAD] } } });
    const env = mediaEnv();
    const { ids, stats } = await sb.resolveMediaBatch(env, [{ name: "nothing" }, { id: "tt0903747" }, null]);
    assert.equal(ids[0], null);
    assert.ok(Number.isInteger(ids[1]));
    assert.equal(ids[2], null);
    assert.equal(stats.unusable, 2);
  });

  it("handles a large batch inside D1's 100-parameter limit", async () => {
    const sb = loadMedia();
    fakeTmdb(sb, {});
    const env = mediaEnv({ TMDB_API_KEY: "" });
    const items = [];
    for (let i = 0; i < 250; i++) items.push({ id: `tt${String(1000000 + i)}` }, { id: `tmdb:${5000 + i}`, type: "series" });
    const { ids, stats } = await sb.resolveMediaBatch(env, items); // the harness throws past 100 bound parameters
    assert.equal(stats.stubs, 500);
    assert.equal(new Set(ids).size, 500);
    // Found again, all of them, from the database.
    const again = await sb.resolveMediaBatch(env, items);
    assert.equal(again.stats.found, 500);
    assert.deepEqual(plain(again.ids), plain(ids));
  });

  it("never has more than six TMDB requests open at once", async () => {
    const sb = loadMedia();
    const tmdb = fakeTmdb(sb, { finds: {}, delayMs: 5 });
    const env = mediaEnv();
    const items = Array.from({ length: 20 }, (_, i) => ({ id: `tt${2000000 + i}` }));
    await sb.resolveMediaBatch(env, items);
    assert.equal(tmdb.calls.length, 20);
    assert.ok(tmdb.maxInFlight <= 6, `saw ${tmdb.maxInFlight} at once`);
  });

  it("retries stubs later, upgrading them in place, and sends the still-unknown to the back", async () => {
    const sb = loadMedia();
    fakeTmdb(sb, {}); // TMDB knows nothing yet
    const env = mediaEnv();
    const { ids } = await sb.resolveMediaBatch(env, [{ id: "tt0903747", type: "series" }, { id: "tt9999999" }]);
    env.DB._db.prepare("UPDATE media SET updated_at = 1").run();

    fakeTmdb(sb, { finds: { tt0903747: { tv_results: [BREAKING_BAD] } } }); // now it knows one
    const res = await sb.retryUnresolvedMedia(env, { limit: 10 });
    assert.deepEqual(plain(res), { tried: 2, resolved: 1 });
    const rows = mediaRows(env);
    const bb = rows.find((r) => r.imdb_id === "tt0903747");
    assert.equal(bb.id, ids[0], "the same row, so list entries already on it follow");
    assert.equal(bb.title, "Breaking Bad");
    assert.ok(bb.resolved_at > 0);
    const lost = rows.find((r) => r.imdb_id === "tt9999999");
    assert.equal(lost.resolved_at, null);
    assert.ok(lost.updated_at > 1, "moved to the back of the queue");
  });

  it("looks titles up through 0016's indexes", () => {
    const t = freshDb();
    const plan = (sql) => t.all(`EXPLAIN QUERY PLAN ${sql}`).map((r) => r.detail).join(" | ");
    assert.match(plan("SELECT id FROM media WHERE imdb_id IN ('tt1', 'tt2')"), /INDEX idx_media_imdb/);
    assert.match(plan("SELECT id FROM media WHERE kind = 'movie' AND tmdb_id IN (1, 2)"), /INDEX idx_media_tmdb/);
    assert.match(plan("SELECT id FROM media WHERE kind = 'series' AND alt_id IN ('kitsu:1')"), /INDEX idx_media_alt/);
    assert.match(plan("SELECT id FROM media WHERE resolved_at IS NULL ORDER BY updated_at LIMIT 90"), /INDEX idx_media_unresolved/);
  });
});

// --- P3b-3: copying the legacy lists into v2 (30_lists-backfill.js) -----------
//
// Through the real Worker: the fixture is built with the site's own routes
// (so the legacy records have exactly the shape production writes), copied by
// the admin backfill in deliberately tiny steps, and compared field by field.
// TMDB is faked through globalThis.fetch, which the Worker's fetch guard calls.

async function adminCookie(env) {
  const r = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
  const m = (r.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/);
  return m ? m[1] : "";
}

function withFakeTmdb({ finds = {}, shows = {}, movies = {} } = {}) {
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    if (u.hostname !== "api.themoviedb.org") return new Response("{}", { status: 404 });
    const [, , kind, id] = u.pathname.split("/");
    const body = kind === "find" ? (finds[id] || { movie_results: [], tv_results: [] })
      : kind === "tv" ? shows[id] : kind === "movie" ? movies[id] : null;
    return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response("{}", { status: 404 });
  };
  return () => { globalThis.fetch = real; };
}

const TMDB_FIXTURE = {
  finds: {
    tt0137523: { movie_results: [FIGHT_CLUB], tv_results: [] },
    tt0903747: { movie_results: [], tv_results: [BREAKING_BAD] },
  },
  shows: { 1396: { ...BREAKING_BAD, external_ids: { imdb_id: "tt0903747" } } },
  movies: { 550: { ...FIGHT_CLUB, external_ids: { imdb_id: "tt0137523" } } },
};

async function saveList(env, user, body) {
  const r = await call(env, "/api/creator/lists/save", {
    method: "POST", json: { creatorName: user.creatorName, creatorKey: user.creatorKey, ...body },
  });
  assert.equal(r.body && r.body.ok, true, `save ${body.name}: ${JSON.stringify(r.body)}`);
  return r.body.slug;
}

async function runBackfill(env, cookie, opts = {}) {
  const responses = [];
  for (let i = 0; i < 500; i++) {
    const r = await call(env, "/admin/api/lists-backfill/step", { method: "POST", cookie, json: { ...opts, restart: i === 0 && !!opts.restart } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    responses.push(r.body);
    if (r.body.done) return responses;
  }
  throw new Error("backfill did not finish");
}

// Everything the legacy store holds, to prove the copy leaves it alone.
function legacySnapshot(env) {
  const kv = [...env.CONFIGS._store.entries()].sort();
  const tables = {};
  for (const t of ["creators", "creator_lists", "published_lists", "list_likes"]) {
    tables[t] = env.DB._db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all();
  }
  return JSON.stringify({ kv, tables });
}

async function buildLegacyFixture(env) {
  const ann = await createUser(env, "annlists");
  const ben = await createUser(env, "benlikes");
  const cat = await createUser(env, "catmixes");

  const top = await saveList(env, ann, {
    name: "Top Films", type: "movie", visibility: "public",
    items: [
      { id: "tt0137523", type: "movie", name: "Fight Club", year: "1999", poster: "https://image.tmdb.org/t/p/w500/fc.jpg" },
      { name: "No id at all", type: "movie" },
      { id: "tmdb:550", type: "movie", name: "Fight Club again" },
      { id: "tt9999999", type: "movie", name: "Lost Film", year: "1931" },
    ],
  });
  const crossover = await saveList(env, ann, {
    name: "Crossover", type: "series", visibility: "private",
    items: [
      { id: "62085", type: "episode", showId: "1396", showTitle: "Breaking Bad", name: "Pilot", seasonNum: 1, episodeNum: 1 },
      { id: "62086", type: "episode", showId: "1396", showTitle: "Breaking Bad", name: "Cat's in the Bag", seasonNum: 1, episodeNum: 2 },
      { id: "tt0137523", type: "movie", name: "Fight Club", isCompanion: true, companionType: "bridge_movie", companionNote: "Canon Bridge Movie" },
    ],
  });
  const imported = await saveList(env, ann, {
    name: "Imported", type: "series", visibility: "private",
    sourceUrl: "https://mdblist.com/lists/someone/good-shows", synced: true, lastSyncedAt: 1700000000000, baseItemIds: ["tt0903747"],
    items: [{ id: "tt0903747", type: "series", name: "Breaking Bad" }],
  });
  const reorder = await call(env, "/api/creator/lists/reorder", {
    method: "POST", json: { creatorName: ann.creatorName, creatorKey: ann.creatorKey, order: [crossover, top, imported] },
  });
  assert.equal(reorder.body.ok, true);

  // Likes: one through the route, plus voters only the KV ledger remembers --
  // a signed-out vote from before D-6, and an account that no longer exists --
  // and a legacy total higher than every voter on record.
  const like = await call(env, "/api/lists/like", {
    method: "POST", json: { username: "annlists", slug: top, creatorName: ben.creatorName, creatorKey: ben.creatorKey },
  });
  assert.equal(like.body.ok, true, JSON.stringify(like.body));
  const ledgerKey = `listlikevoters:annlists:${top}`;
  const ledger = JSON.parse(env.CONFIGS._store.get(ledgerKey) || "[]");
  env.CONFIGS._store.set(ledgerKey, JSON.stringify([...ledger, "a:deadbeef", "u:ghost"]));
  env.DB._db.prepare("UPDATE creator_lists SET likes = 10 WHERE id = ?").run(`annlists:${top}`);

  // A list whose KV copy is fresher than its D1 row (a dropped D1 write).
  const catSlug = await saveList(env, cat, { name: "Mixed Bag", type: "mixed", visibility: "public", items: [{ id: "tt0903747", type: "series" }] });
  const catKey = `creatorlist:catmixes:${catSlug}`;
  const catRecord = JSON.parse(env.CONFIGS._store.get(catKey));
  env.CONFIGS._store.set(catKey, JSON.stringify({ ...catRecord, name: "Mixed Bag (edited)", updatedAt: catRecord.updatedAt + 60000 }));

  // A legacy anonymous list with legacy votes, and a like on an outside list.
  seedAnonPublishedList(env, "cozy-picks", { name: "Cozy Picks", items: [{ id: "tt0903747", type: "series" }], likes: 2 });
  env.CONFIGS._store.set("listlikevoters:user:cozy-picks", JSON.stringify(["a:111", "a:222"]));
  const ext = await call(env, "/api/lists/like-external", {
    method: "POST", json: { url: "https://mdblist.com/lists/someone/good-shows", creatorName: ben.creatorName, creatorKey: ben.creatorKey },
  });
  assert.equal(ext.body.ok, true, JSON.stringify(ext.body));

  return { ann, ben, cat, slugs: { top, crossover, imported, catSlug } };
}

describe("P3b-3: copying the legacy lists into v2", () => {
  it("copies every list, item and like, in the dashboard's order, and leaves the legacy store untouched", async () => {
    const restore = withFakeTmdb(TMDB_FIXTURE);
    try {
      const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1(), TMDB_API_KEY: "test-key" });
      const fx = await buildLegacyFixture(env);
      const cookie = await adminCookie(env);
      // Not read through the dashboard route here: that route rewrites its KV
      // cache copies (getCreatorList), and in doing so drops an imported list's
      // sourceUrl, synced and baseItemIds -- a legacy bug, recorded in
      // HANDOFF.md. The order check against the route is its own test below.
      const before = legacySnapshot(env);

      // Tiny steps, so every list and the long one are resumed mid-way.
      const steps = await runBackfill(env, cookie, { maxOps: 25, maxItems: 2 });
      assert.ok(steps.length > 5, `expected many steps, got ${steps.length}`);
      assert.equal(legacySnapshot(env), before, "the legacy KV keys and tables are exactly as they were");

      const db = env.DB._db;
      const annId = db.prepare("SELECT id FROM accounts WHERE username = 'annlists'").get().id;
      const benId = db.prepare("SELECT id FROM accounts WHERE username = 'benlikes'").get().id;
      const lists = db.prepare("SELECT * FROM lists WHERE owner_account_id = ? AND deleted_at IS NULL ORDER BY position").all(annId);
      assert.deepEqual(lists.map((l) => l.slug), [fx.slugs.crossover, fx.slugs.top, fx.slugs.imported], "the order set on the dashboard");
      const bySlug = Object.fromEntries(lists.map((l) => [l.slug, l]));

      const top = bySlug[fx.slugs.top];
      assert.deepEqual({ name: top.name, kind: top.kind, type: top.media_type, vis: top.visibility, legacy: top.legacy_id },
        { name: "Top Films", kind: "custom", type: "movie", vis: "public", legacy: `c:annlists:${fx.slugs.top}` });
      const topItems = db.prepare(
        "SELECT li.position, m.imdb_id, m.title, m.resolved_at, li.extra_json FROM list_items li JOIN media m ON m.id = li.media_id WHERE li.list_id = ? ORDER BY li.position"
      ).all(top.id);
      assert.deepEqual(topItems.map((r) => [r.position, r.imdb_id]), [[0, "tt0137523"], [3, "tt9999999"]],
        "Fight Club once (its tmdb:550 duplicate is the same title), the item with no id left out, the unknown title kept as a stub");
      assert.equal(topItems[0].extra_json, null, "nothing beyond what the media row says");
      assert.equal(topItems[1].resolved_at, null);
      assert.equal(top.item_count, 2);

      const crossItems = db.prepare(
        "SELECT li.season, li.episode, m.kind, m.tmdb_id, li.extra_json FROM list_items li JOIN media m ON m.id = li.media_id WHERE li.list_id = ? ORDER BY li.position"
      ).all(bySlug[fx.slugs.crossover].id);
      assert.deepEqual(crossItems.map((r) => [r.kind, r.tmdb_id, r.season, r.episode]),
        [["series", 1396, 1, 1], ["series", 1396, 1, 2], ["movie", 550, null, null]]);
      assert.deepEqual(JSON.parse(crossItems[0].extra_json), { id: "62085", name: "Pilot" }, "an episode keeps its own id and name");
      assert.deepEqual(JSON.parse(crossItems[2].extra_json), { isCompanion: true, companionType: "bridge_movie", companionNote: "Canon Bridge Movie" });

      const imported = bySlug[fx.slugs.imported];
      assert.deepEqual({ kind: imported.kind, provider: imported.source_provider, ref: imported.source_ref, synced: imported.synced_at, src: JSON.parse(imported.source_json) },
        { kind: "synced", provider: "mdblist", ref: "https://mdblist.com/lists/someone/good-shows", synced: 1700000000000, src: { baseItemIds: ["tt0903747"] } });

      const voters = db.prepare("SELECT voter FROM likes WHERE target_type = 'list' AND target_id = ? ORDER BY voter").all(top.public_id).map((r) => r.voter);
      assert.deepEqual(voters, ["a:deadbeef", `acct:${benId}`, "u:ghost"].sort());
      assert.equal(top.like_count, 10, "the higher legacy total is kept (D-9)");

      const search = db.prepare("SELECT rowid FROM lists_fts2 WHERE lists_fts2 MATCH ?").all("films").map((r) => r.rowid);
      assert.deepEqual(search, [top.id], "public lists are searchable, private ones are not");

      const cat = db.prepare("SELECT l.name FROM lists l JOIN accounts a ON a.id = l.owner_account_id WHERE a.username = 'catmixes'").get();
      assert.equal(cat.name, "Mixed Bag (edited)", "the fresher KV copy wins, as getCreatorList decides");

      const cozy = db.prepare("SELECT * FROM lists WHERE legacy_id = 'a:cozy-picks'").get();
      assert.deepEqual({ owner: cozy.owner_account_id, kind: cozy.kind, vis: cozy.visibility, likes: cozy.like_count, items: cozy.item_count },
        { owner: null, kind: "legacy_anonymous", vis: "unlisted", likes: 2, items: 1 });

      const ext = db.prepare("SELECT target_id, voter FROM likes WHERE target_type = 'external'").all();
      assert.equal(ext.length, 1);
      assert.equal(ext[0].voter, `acct:${benId}`);
      assert.ok(env.CONFIGS._store.has(`externallike:${ext[0].target_id}`), "keyed by the same URL hash as the legacy count");

      const status = await call(env, "/admin/api/lists-backfill/status", { cookie });
      assert.equal(status.body.run.phase, "done");
      assert.deepEqual(status.body.accounts, { done: 3, running: 0, failed: 0 });
      const t = status.body.totals;
      assert.deepEqual({ lists: t.lists.legacy, copied: t.lists.copied, items: t.items.legacy, itemsCopied: t.items.copied, unusable: t.items.unusable, dup: t.items.duplicates },
        { lists: 4, copied: 4, items: 9, itemsCopied: 7, unusable: 1, dup: 1 });
      assert.equal(t.likes.keptFromCount, 7);
      assert.ok(Math.abs(status.body.mismatchRate - 2 / 9) < 1e-9);
      const samples = status.body.worst[0].samples;
      assert.equal(samples.unusable[0].name, "No id at all", "every difference comes with an example");
      assert.equal(samples.duplicates.length, 1);
    } finally {
      restore();
    }
  });

  it("puts lists in the order /api/creator/lists shows them, including records its order key lost", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    const u = await createUser(env, "orderly");
    const slugs = [];
    for (const name of ["Alpha", "Bravo", "Charlie", "Delta"]) {
      slugs.push(await saveList(env, u, { name, type: "movie", visibility: "private", items: [{ id: "tt0000001" }] }));
    }
    await call(env, "/api/creator/lists/reorder", { method: "POST", json: { creatorName: u.creatorName, creatorKey: u.creatorKey, order: [slugs[2], slugs[0], "watchlist", slugs[3]] } });
    // D1 holds no order at all (rows written before sort_order existed), so
    // the KV order key decides; Bravo is in neither, so it comes last.
    env.DB._db.prepare("UPDATE creator_lists SET sort_order = NULL WHERE username = 'orderly'").run();
    const dashboard = await call(env, "/api/creator/lists", { method: "POST", json: { creatorName: u.creatorName, creatorKey: u.creatorKey } });
    await runBackfill(env, await adminCookie(env));
    const copied = env.DB._db.prepare("SELECT slug FROM lists WHERE owner_account_id IS NOT NULL ORDER BY position").all().map((r) => r.slug);
    assert.deepEqual(copied, dashboard.body.order.filter((s) => slugs.includes(s)));
    assert.deepEqual(copied, [slugs[2], slugs[0], slugs[3], slugs[1]]);
  });

  it("copies only what changed on a second run, and retires copies of deleted lists", async () => {
    const restore = withFakeTmdb(TMDB_FIXTURE);
    try {
      const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1(), TMDB_API_KEY: "test-key" });
      const fx = await buildLegacyFixture(env);
      const cookie = await adminCookie(env);
      await runBackfill(env, cookie);
      const db = env.DB._db;
      const idsBefore = db.prepare("SELECT legacy_id, id, public_id FROM lists ORDER BY legacy_id").all();

      await saveList(env, fx.ann, { slug: fx.slugs.imported, name: "Imported", type: "series", visibility: "private",
        items: [{ id: "tt0903747", type: "series" }, { id: "tt0137523", type: "movie" }] });
      const del = await call(env, "/api/creator/lists/delete", { method: "POST", json: { creatorName: fx.ann.creatorName, creatorKey: fx.ann.creatorKey, slug: fx.slugs.top } });
      assert.equal(del.body.ok, true);

      await runBackfill(env, cookie, { restart: true });
      const idsAfter = db.prepare("SELECT legacy_id, id, public_id FROM lists ORDER BY legacy_id").all();
      assert.deepEqual(idsAfter, idsBefore, "the same rows and public ids: nothing copied twice");
      const imported = db.prepare("SELECT id, item_count FROM lists WHERE legacy_id = ?").get(`c:annlists:${fx.slugs.imported}`);
      assert.equal(imported.item_count, 2, "the edited list was copied again");
      const top = db.prepare("SELECT id, deleted_at FROM lists WHERE legacy_id = ?").get(`c:annlists:${fx.slugs.top}`);
      assert.ok(top.deleted_at > 0, "the deleted list's copy is marked deleted");
      assert.deepEqual(db.prepare("SELECT rowid FROM lists_fts2 WHERE rowid = ?").all(top.id), [], "and taken out of search");

      const status = await call(env, "/admin/api/lists-backfill/status", { cookie });
      assert.equal(status.body.totals.lists.copied, 1, "only the edited list");
      assert.equal(status.body.totals.lists.removed, 1);
      assert.ok(status.body.totals.lists.unchanged >= 2);
    } finally {
      restore();
    }
  });

  it("works through a long list in bounded steps", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() }); // no TMDB key: every title is a stub, nothing is fetched
    const u = await createUser(env, "longlists");
    const items = Array.from({ length: 1200 }, (_, i) => ({ id: `tt${3000000 + i}`, type: "movie" }));
    await saveList(env, u, { name: "Everything", type: "movie", visibility: "private", items });
    const steps = await runBackfill(env, await adminCookie(env));
    assert.ok(steps.length >= 3, "500 items a step at most");
    for (const s of steps) assert.ok(s.ops < 700, `a step used ${s.ops} D1 and KV operations`);
    const row = env.DB._db.prepare("SELECT item_count FROM lists WHERE owner_account_id IS NOT NULL").get();
    assert.equal(row.item_count, 1200);
    const order = env.DB._db.prepare("SELECT position FROM list_items ORDER BY position").all().map((r) => r.position);
    assert.deepEqual(order, items.map((_, i) => i));
  });

  it("records a failed account and carries on with the rest", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    const a = await createUser(env, "breaksalot");
    const b = await createUser(env, "worksfine");
    await saveList(env, a, { name: "Bad", type: "movie", visibility: "private", items: [{ id: "tt0000001" }] });
    await saveList(env, b, { name: "Good", type: "movie", visibility: "private", items: [{ id: "tt0000002" }] });
    env.DB.failWhen((sql, args) => /^\s*INSERT INTO lists\b/i.test(sql) && args.includes("bad"));
    const cookie = await adminCookie(env);
    await runBackfill(env, cookie);
    env.DB.failWhen(null);
    const status = await call(env, "/admin/api/lists-backfill/status", { cookie });
    assert.deepEqual(status.body.accounts, { done: 1, running: 0, failed: 1 });
    assert.match(status.body.failed[0].error, /injected failure/);
    assert.equal(env.DB._db.prepare("SELECT count(*) AS n FROM lists WHERE slug = 'good'").get().n, 1);
  });

  it("asks for the accounts table first, takes one step at a time, and is admin only", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    const cookie = await adminCookie(env);
    const empty = await call(env, "/admin/api/lists-backfill/step", { method: "POST", cookie, json: {} });
    assert.equal(empty.status, 409);
    assert.match(empty.body.error, /Migrate Accounts/);

    await createUser(env, "someoneelse");
    env.DB._db.prepare("UPDATE jobs SET run_after = ? WHERE dedupe_key = 'migrate.lists:run'").run(Date.now() + 60000);
    const busy = await call(env, "/admin/api/lists-backfill/step", { method: "POST", cookie, json: {} });
    assert.equal(busy.body.busy, true, "a step already holds the lease");

    const anon = await call(env, "/admin/api/lists-backfill/step", { method: "POST", json: {} });
    assert.equal(anon.status, 401);
    const anonStatus = await call(env, "/admin/api/lists-backfill/status");
    assert.equal(anonStatus.status, 401);
  });

  it("can only write to the v2 tables, and cannot write KV at all", () => {
    const sandbox = { console, URL, TextEncoder, crypto: globalThis.crypto };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    for (const rel of ["00_constants.js", "29_media.js", "30_lists-backfill.js"]) {
      vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"), sandbox, { filename: rel });
    }
    const meter = { ops: 0 };
    const guarded = sandbox.listsBackfillEnv({ DB: makeD1(), CONFIGS: makeKv(), TMDB_API_KEY: "k" }, meter);
    for (const sql of [
      "UPDATE creator_lists SET likes = 0",
      "DELETE FROM list_likes WHERE list_id = 'x'",
      "INSERT INTO published_lists (slug) VALUES ('x')",
      "INSERT OR REPLACE INTO creators (username) VALUES ('x')",
      "update accounts set version = 1",
      "DROP TABLE lists",
      "CREATE TABLE sneaky (x)",
    ]) {
      assert.throws(() => guarded.DB.prepare(sql), /refusing/, sql);
    }
    for (const sql of ["INSERT INTO lists (public_id) VALUES ('x')", "UPDATE OR IGNORE media SET title = 'x'", "DELETE FROM list_items WHERE list_id = 1", "SELECT * FROM creator_lists"]) {
      assert.doesNotThrow(() => guarded.DB.prepare(sql), sql);
    }
    assert.equal(guarded.CONFIGS.put, undefined);
    assert.equal(guarded.CONFIGS.delete, undefined);
    assert.equal(guarded.TMDB_API_KEY, "k", "everything else passes through");
  });
});

// --- P3b-4: the list API (31_lists-api.js) -------------------------------------
//
// Owner, someone else, and nobody, for every route. Sessions come from
// POST /api/session, as the Phase 6 pages will get them.

async function signInSession(env, username, key) {
  const r = await call(env, "/api/session", { method: "POST", json: { username, key } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return (r.headers.get("set-cookie") || "").split(";")[0];
}

async function listsApiSetup() {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1(), FF_V2_LISTS_API: "1" });
  const ann = await createUser(env, "annapi");
  const ben = await createUser(env, "benapi");
  const annCookie = await signInSession(env, "annapi", ann.creatorKey);
  const benCookie = await signInSession(env, "benapi", ben.creatorKey);
  const db = env.DB._db;
  const annId = db.prepare("SELECT id FROM accounts WHERE username = 'annapi'").get().id;
  const accountVersion = () => db.prepare("SELECT version FROM accounts WHERE id = ?").get(annId).version;
  return { env, db, ann, ben, annCookie, benCookie, annId, accountVersion };
}

async function createApiListFor(env, cookie, body) {
  const r = await call(env, "/api/lists", { method: "POST", cookie, json: body });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

const ifMatch = (v) => ({ "If-Match": `"${v}"` });

describe("P3b-4: the list API", () => {
  it("is off without FF_V2_LISTS_API, needs a session to list or create, and leaves the legacy like routes alone", async () => {
    const off = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    assert.equal((await call(off, "/api/lists")).status, 404);
    const { env, benCookie, ben } = await listsApiSetup();
    const anonList = await call(env, "/api/lists");
    assert.equal(anonList.status, 401);
    assert.equal(anonList.body.signInRequired, true);
    assert.equal((await call(env, "/api/lists", { method: "POST", json: { name: "x", mediaType: "movie" } })).status, 401);
    // /api/lists/like is still the legacy route, flag or no flag.
    const like = await call(env, "/api/lists/like", { method: "POST", cookie: benCookie, json: { username: "nobody", slug: "nothing", creatorName: ben.creatorName, creatorKey: ben.creatorKey } });
    assert.equal(like.status, 404);
    assert.equal(like.body.error, "List not found.");
  });

  it("creates a list with its first items, finds it a free address, and keeps search and versions in step", async () => {
    const { env, db, ann, annCookie, accountVersion } = await listsApiSetup();
    // A legacy list the backfill has not copied yet holds its address.
    await saveList(env, ann, { name: "Top Films", type: "movie", visibility: "private", items: [{ id: "tt0000001" }] });
    const v0 = accountVersion();
    const created = await createApiListFor(env, annCookie, {
      name: "Top Films", mediaType: "movie", visibility: "public", description: "The best",
      items: [{ id: "tt0137523", name: "Fight Club" }, { id: "tt0137523" }, { name: "no id" }, { id: "tt0903747", note: "  watch first  " }],
    });
    assert.equal(created.list.slug, "top-films-2", "not the legacy list's address");
    assert.deepEqual(created.results.map((r) => r.status), ["added", "duplicate", "unusable", "added"]);
    assert.equal(created.list.itemCount, 2);
    assert.equal(created.list.version, 1);
    assert.equal(created.list.owner.username, "annapi");
    assert.ok(accountVersion() > v0, "the account's version moves with every write");
    const row = db.prepare("SELECT id FROM lists WHERE public_id = ?").get(created.list.publicId);
    assert.deepEqual(db.prepare("SELECT rowid FROM lists_fts2 WHERE lists_fts2 MATCH 'best'").all().map((r) => r.rowid), [row.id]);
    const note = db.prepare("SELECT note FROM list_items WHERE list_id = ? AND note IS NOT NULL").get(row.id);
    assert.equal(note.note, "watch first");

    const again = await createApiListFor(env, annCookie, { name: "Top Films", mediaType: "movie" });
    assert.equal(again.list.slug, "top-films-3");
    assert.equal(again.list.visibility, "private", "private unless asked");

    const bad = await call(env, "/api/lists", { method: "POST", cookie: annCookie, json: { name: "x", mediaType: "anime" } });
    assert.equal(bad.status, 400);
    const tooMany = await call(env, "/api/lists", { method: "POST", cookie: annCookie, json: { name: "x", mediaType: "movie", items: new Array(501).fill({ id: "tt0000001" }) } });
    assert.equal(tooMany.status, 400);

    const mine = await call(env, "/api/lists", { cookie: annCookie });
    assert.deepEqual(mine.body.lists.map((l) => l.slug), ["top-films-2", "top-films-3"], "in their order");
    assert.equal(mine.body.accountVersion, accountVersion());
    assert.equal(mine.headers.get("cache-control"), "no-store");
  });

  it("shows a public or unlisted list to anyone, a private one only to its owner, and pages through items", async () => {
    const { env, annCookie, benCookie } = await listsApiSetup();
    const items = [1, 2, 3, 4, 5].map((i) => ({ id: `tt000000${i}` }));
    const pub = await createApiListFor(env, annCookie, { name: "Pub", mediaType: "movie", visibility: "public", items });
    const unl = await createApiListFor(env, annCookie, { name: "Unl", mediaType: "movie", visibility: "unlisted" });
    const priv = await createApiListFor(env, annCookie, { name: "Priv", mediaType: "movie", visibility: "private" });

    for (const cookie of [undefined, benCookie, annCookie]) {
      assert.equal((await call(env, `/api/lists/${pub.list.publicId}`, { cookie })).status, 200);
      assert.equal((await call(env, `/api/lists/${unl.list.publicId}`, { cookie })).status, 200);
    }
    assert.equal((await call(env, `/api/lists/${priv.list.publicId}`)).status, 404);
    assert.equal((await call(env, `/api/lists/${priv.list.publicId}`, { cookie: benCookie })).status, 404, "not 403: a private list is not given away");
    assert.equal((await call(env, `/api/lists/${priv.list.publicId}`, { cookie: annCookie })).status, 200);
    assert.equal((await call(env, "/api/lists/nosuchlist12")).status, 404);

    const page1 = await call(env, `/api/lists/${pub.list.publicId}?limit=2`);
    assert.equal(page1.headers.get("etag"), '"1"');
    assert.deepEqual(page1.body.items.map((i) => i.id), ["tt0000001", "tt0000002"]);
    assert.equal(page1.body.items[0].kind, "movie");
    assert.ok(page1.body.nextCursor);
    const page2 = await call(env, `/api/lists/${pub.list.publicId}?limit=2&cursor=${page1.body.nextCursor}`);
    const page3 = await call(env, `/api/lists/${pub.list.publicId}?limit=2&cursor=${page2.body.nextCursor}`);
    assert.deepEqual([...page2.body.items, ...page3.body.items].map((i) => i.id), ["tt0000003", "tt0000004", "tt0000005"]);
    assert.equal(page3.body.nextCursor, null);
  });

  it("lets only the owner change a list: someone else gets 403, nobody gets 401", async () => {
    const { env, annCookie, benCookie } = await listsApiSetup();
    const pub = await createApiListFor(env, annCookie, { name: "Mine", mediaType: "movie", visibility: "public", items: [{ id: "tt0000001" }] });
    const id = pub.list.publicId;
    const mediaId = (await call(env, `/api/lists/${id}`)).body.items[0].mediaId;
    const attempts = [
      ["PATCH", `/api/lists/${id}`, { name: "Theirs" }],
      ["DELETE", `/api/lists/${id}`, undefined],
      ["PUT", `/api/lists/${id}/visibility`, { visibility: "private" }],
      ["POST", `/api/lists/${id}/items`, { items: [{ id: "tt0000002" }] }],
      ["DELETE", `/api/lists/${id}/items/${mediaId}`, undefined],
      ["POST", `/api/lists/${id}/items/move`, { mediaId, after: null }],
    ];
    for (const [method, p, body] of attempts) {
      const other = await call(env, p, { method, cookie: benCookie, json: body, headers: ifMatch(1) });
      assert.equal(other.status, 403, `${method} ${p} as someone else`);
      const nobody = await call(env, p, { method, json: body, headers: ifMatch(1) });
      assert.equal(nobody.status, 401, `${method} ${p} signed out`);
    }
    const after = await call(env, `/api/lists/${id}`);
    assert.equal(after.body.list.version, 1, "nothing changed");
    assert.equal(after.body.list.name, "Mine");
  });

  it("needs If-Match to rename or delete, refuses a stale one, and keeps the old address answering", async () => {
    const { env, db, annCookie } = await listsApiSetup();
    const created = await createApiListFor(env, annCookie, { name: "Old Name", mediaType: "series", visibility: "public" });
    await createApiListFor(env, annCookie, { name: "Taken", mediaType: "movie" });
    const id = created.list.publicId;
    const path = `/api/lists/${id}`;

    assert.equal((await call(env, path, { method: "PATCH", cookie: annCookie, json: { name: "New" } })).status, 428);
    const stale = await call(env, path, { method: "PATCH", cookie: annCookie, json: { name: "New" }, headers: ifMatch(7) });
    assert.equal(stale.status, 412);
    assert.equal(stale.body.version, 1);
    assert.equal((await call(env, path, { method: "PATCH", cookie: annCookie, json: { slug: "taken" }, headers: ifMatch(1) })).status, 409);

    const renamed = await call(env, path, { method: "PATCH", cookie: annCookie, json: { name: "Fresh Name", slug: "fresh-name", description: "Now described" }, headers: ifMatch(1) });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.list.version, 2);
    assert.equal(renamed.body.list.slug, "fresh-name");
    const listRow = db.prepare("SELECT id FROM lists WHERE public_id = ?").get(id);
    assert.deepEqual(db.prepare("SELECT old_slug, list_id FROM list_slug_history").all().map((r) => [r.old_slug, r.list_id]), [["old-name", listRow.id]]);
    assert.deepEqual(db.prepare("SELECT rowid FROM lists_fts2 WHERE lists_fts2 MATCH 'fresh'").all().map((r) => r.rowid), [listRow.id], "search follows the new name");
    assert.deepEqual(db.prepare("SELECT rowid FROM lists_fts2 WHERE lists_fts2 MATCH 'old'").all(), []);

    // The same stale version a second writer might still hold.
    assert.equal((await call(env, path, { method: "PATCH", cookie: annCookie, json: { name: "Lost" }, headers: ifMatch(1) })).status, 412);

    assert.equal((await call(env, path, { method: "DELETE", cookie: annCookie })).status, 428);
    assert.equal((await call(env, path, { method: "DELETE", cookie: annCookie, headers: ifMatch(1) })).status, 412);
    const del = await call(env, path, { method: "DELETE", cookie: annCookie, headers: ifMatch(2) });
    assert.equal(del.status, 200);
    assert.equal((await call(env, path, { cookie: annCookie })).status, 404);
    assert.deepEqual(db.prepare("SELECT rowid FROM lists_fts2 WHERE rowid = ?").all(listRow.id), []);
    const mine = await call(env, "/api/lists", { cookie: annCookie });
    assert.deepEqual(mine.body.lists.map((l) => l.slug), ["taken"]);
  });

  it("changes visibility, and search follows", async () => {
    const { env, db, annCookie } = await listsApiSetup();
    const created = await createApiListFor(env, annCookie, { name: "Hidden Gems", mediaType: "movie", visibility: "public" });
    const id = created.list.publicId;
    const row = db.prepare("SELECT id FROM lists WHERE public_id = ?").get(id);
    const unl = await call(env, `/api/lists/${id}/visibility`, { method: "PUT", cookie: annCookie, json: { visibility: "unlisted" } });
    assert.equal(unl.body.list.visibility, "unlisted");
    assert.equal(unl.body.list.version, 2);
    assert.deepEqual(db.prepare("SELECT rowid FROM lists_fts2 WHERE rowid = ?").all(row.id), [], "unlisted is not searchable");
    assert.equal((await call(env, `/api/lists/${id}`)).status, 200, "but anyone with the link can open it");
    await call(env, `/api/lists/${id}/visibility`, { method: "PUT", cookie: annCookie, json: { visibility: "private" } });
    assert.equal((await call(env, `/api/lists/${id}`)).status, 404);
    await call(env, `/api/lists/${id}/visibility`, { method: "PUT", cookie: annCookie, json: { visibility: "public" } });
    assert.equal(db.prepare("SELECT count(*) AS n FROM lists_fts2 WHERE lists_fts2 MATCH 'gems'").get().n, 1);
    const bad = await call(env, `/api/lists/${id}/visibility`, { method: "PUT", cookie: annCookie, json: { visibility: "friends" } });
    assert.equal(bad.status, 400);
  });

  it("adds, removes and moves entries, updating the count and both versions in the same batch", async () => {
    const { env, db, annCookie, accountVersion } = await listsApiSetup();
    const created = await createApiListFor(env, annCookie, { name: "Queue", mediaType: "mixed", items: [{ id: "tt0000001" }] });
    const id = created.list.publicId;
    const ids = async () => (await call(env, `/api/lists/${id}`, { cookie: annCookie })).body.items.map((i) => i.id + (i.season != null ? `:${i.season}:${i.episode}` : ""));

    let v = accountVersion();
    const add = await call(env, `/api/lists/${id}/items`, { method: "POST", cookie: annCookie, json: {
      items: [{ id: "tt0000001" }, { id: "tt0000002" }, { showId: "tt0903747", type: "episode", seasonNum: 1, episodeNum: 1 }, { showId: "tt0903747", type: "episode", seasonNum: 1, episodeNum: 2 }],
    } });
    assert.deepEqual({ added: add.body.added, dup: add.body.duplicates, count: add.body.list.itemCount, version: add.body.list.version },
      { added: 3, dup: 1, count: 4, version: 2 });
    assert.ok(accountVersion() > v);
    assert.deepEqual(await ids(), ["tt0000001", "tt0000002", "tt0903747:1:1", "tt0903747:1:2"]);

    const front = await call(env, `/api/lists/${id}/items`, { method: "POST", cookie: annCookie, json: { items: [{ id: "tt0000009" }], at: "start" } });
    assert.equal(front.body.list.version, 3);
    assert.deepEqual((await ids())[0], "tt0000009");

    // Adding only what is already there changes nothing, so bumps nothing.
    const nothing = await call(env, `/api/lists/${id}/items`, { method: "POST", cookie: annCookie, json: { items: [{ id: "tt0000002" }] } });
    assert.equal(nothing.body.list.version, 3);

    const entries = (await call(env, `/api/lists/${id}`, { cookie: annCookie })).body.items;
    const show = entries.find((e) => e.season === 1 && e.episode === 2);
    const removeEp = await call(env, `/api/lists/${id}/items/${show.mediaId}?season=1&episode=2`, { method: "DELETE", cookie: annCookie });
    assert.equal(removeEp.body.list.itemCount, 4);
    assert.equal(removeEp.body.list.version, 4);
    assert.equal((await call(env, `/api/lists/${id}/items/${show.mediaId}?season=1&episode=2`, { method: "DELETE", cookie: annCookie })).status, 404);
    assert.equal((await call(env, `/api/lists/${id}/items/${show.mediaId}`, { method: "DELETE", cookie: annCookie })).status, 404,
      "the whole show was never in the list, only its episodes");
    assert.deepEqual(await ids(), ["tt0000009", "tt0000001", "tt0000002", "tt0903747:1:1"]);

    const first = entries.find((e) => e.id === "tt0000001");
    const last = entries.find((e) => e.season === 1 && e.episode === 1);
    const moved = await call(env, `/api/lists/${id}/items/move`, { method: "POST", cookie: annCookie, json: { mediaId: last.mediaId, season: 1, episode: 1, after: null } });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.deepEqual(await ids(), ["tt0903747:1:1", "tt0000009", "tt0000001", "tt0000002"]);
    await call(env, `/api/lists/${id}/items/move`, { method: "POST", cookie: annCookie, json: { mediaId: last.mediaId, season: 1, episode: 1, after: { mediaId: first.mediaId } } });
    assert.deepEqual(await ids(), ["tt0000009", "tt0000001", "tt0903747:1:1", "tt0000002"]);

    // No room left between two neighbours: the list is renumbered first.
    const listRow = db.prepare("SELECT id FROM lists WHERE public_id = ?").get(id);
    db.prepare("UPDATE list_items SET position = 1 WHERE list_id = ? AND media_id = ?").run(listRow.id, first.mediaId);
    db.prepare("UPDATE list_items SET position = 1 WHERE list_id = ? AND season = 1").run(listRow.id);
    const two = entries.find((e) => e.id === "tt0000002");
    db.prepare("UPDATE list_items SET position = 5 WHERE list_id = ? AND media_id = ?").run(listRow.id, two.mediaId);
    const nine = entries.find((e) => e.id === "tt0000009");
    const squeezed = await call(env, `/api/lists/${id}/items/move`, { method: "POST", cookie: annCookie, json: { mediaId: nine.mediaId, after: { mediaId: first.mediaId } } });
    assert.equal(squeezed.status, 200);
    assert.deepEqual(await ids(), ["tt0000001", "tt0000009", "tt0903747:1:1", "tt0000002"]);

    assert.equal((await call(env, `/api/lists/${id}/items/move`, { method: "POST", cookie: annCookie, json: { mediaId: 999999, after: null } })).status, 404);
  });

  it("bumps a list's version only when its item count really moved (an add that lost a race to the same title)", async () => {
    // Two adds of one title at the same moment both pass the duplicate check;
    // the second INSERT OR IGNORE then inserts nothing. Its batch must not
    // bump the version for a change it did not make. The harness cannot
    // interleave two requests that finely, so the statement is run directly.
    const sandbox = { console, URL, TextEncoder, crypto: globalThis.crypto };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    for (const rel of ["00_constants.js", "29_media.js", "30_lists-backfill.js", "31_lists-api.js"]) {
      vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"), sandbox, { filename: rel });
    }
    const env = { DB: makeD1() };
    env.DB._db.exec(`INSERT INTO accounts (id, username, display_name, key_hash, created_at) VALUES (1, 'ann', 'Ann', 'h', 0);
      INSERT INTO media (id, kind, imdb_id, created_at, updated_at) VALUES (1, 'movie', 'tt1', 0, 0), (2, 'movie', 'tt2', 0, 0);
      INSERT INTO lists (id, public_id, owner_account_id, slug, name, media_type, item_count, version, created_at, updated_at) VALUES (10, 'p10', 1, 'x', 'X', 'movie', 1, 5, 0, 0);
      INSERT INTO list_items (list_id, media_id, position, added_at) VALUES (10, 1, 0, 0);`);
    const version = () => env.DB._db.prepare("SELECT version, item_count FROM lists WHERE id = 10").get();
    await sandbox.listCountStatement(env, 10, 99).run();
    assert.deepEqual({ ...version() }, { version: 5, item_count: 1 }, "nothing inserted: no bump");
    env.DB._db.exec("INSERT INTO list_items (list_id, media_id, position, added_at) VALUES (10, 2, 1, 0)");
    await sandbox.listCountStatement(env, 10, 99).run();
    assert.deepEqual({ ...version() }, { version: 6, item_count: 2 });
  });

  it("refuses to grow a list past the item limit", async () => {
    const { env, db, annCookie } = await listsApiSetup();
    const created = await createApiListFor(env, annCookie, { name: "Huge", mediaType: "movie" });
    db.prepare("UPDATE lists SET item_count = ? WHERE public_id = ?").run(9999, created.list.publicId);
    const r = await call(env, `/api/lists/${created.list.publicId}/items`, { method: "POST", cookie: annCookie, json: { items: [{ id: "tt0000001" }, { id: "tt0000002" }] } });
    assert.equal(r.status, 413);
  });

  it("serves a legacy anonymous copy read-only", async () => {
    const { env, db, annCookie } = await listsApiSetup();
    db.prepare(`INSERT INTO lists (public_id, owner_account_id, slug, name, kind, media_type, visibility, legacy_id, created_at, updated_at)
                VALUES ('anonpublic01', NULL, 'cozy', 'Cozy', 'legacy_anonymous', 'movie', 'unlisted', 'a:cozy', 1, 1)`).run();
    const r = await call(env, "/api/lists/anonpublic01");
    assert.equal(r.status, 200);
    assert.equal(r.body.list.owner, null);
    assert.equal((await call(env, "/api/lists/anonpublic01/visibility", { method: "PUT", cookie: annCookie, json: { visibility: "public" } })).status, 403);
    assert.equal((await call(env, "/api/lists/anonpublic01/visibility", { method: "PUT", json: { visibility: "public" } })).status, 401);
  });
});

// --- P3b-5: the likes API (32_likes-api.js) ------------------------------------

describe("P3b-5: the likes API", () => {
  async function likesSetup() {
    const s = await listsApiSetup();
    const pub = await createApiListFor(s.env, s.annCookie, { name: "Liked One", mediaType: "movie", visibility: "public" });
    // As the backfill leaves a list: a legacy signed-out vote on record, and
    // a legacy total higher than the votes on record.
    s.db.prepare("INSERT INTO likes (target_type, target_id, voter, created_at) VALUES ('list', ?, 'a:legacyvote', 1)").run(pub.list.publicId);
    s.db.prepare("UPDATE lists SET like_count = 5 WHERE public_id = ?").run(pub.list.publicId);
    return { ...s, pub, likePath: `/api/likes/list/${pub.list.publicId}` };
  }

  it("is off without the flag, reads signed out, and needs an account to like (D-6)", async () => {
    const off = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    assert.equal((await call(off, "/api/likes/list/abc")).status, 404);
    const { env, likePath } = await likesSetup();
    const read = await call(env, likePath);
    assert.deepEqual({ ok: read.body.ok, liked: read.body.liked, likes: read.body.likes }, { ok: true, liked: false, likes: 5 });
    for (const method of ["PUT", "DELETE"]) {
      const r = await call(env, likePath, { method });
      assert.equal(r.status, 401);
      assert.equal(r.body.signInRequired, true);
    }
  });

  it("likes and unlikes once each however many times it is asked, and leaves legacy votes alone (D-9)", async () => {
    const { env, db, annCookie, benCookie, likePath, pub, accountVersion } = await likesSetup();
    const v0 = accountVersion();
    const first = await call(env, likePath, { method: "PUT", cookie: annCookie });
    assert.deepEqual({ liked: first.body.liked, likes: first.body.likes }, { liked: true, likes: 6 }, "the kept legacy total moves by one");
    const v1 = accountVersion();
    assert.ok(v1 > v0, "the account's likes changed, so its version moves");
    const again = await call(env, likePath, { method: "PUT", cookie: annCookie });
    assert.equal(again.body.likes, 6);
    assert.equal(accountVersion(), v1, "a repeat changes nothing, so bumps nothing");
    assert.equal((await call(env, likePath, { cookie: annCookie })).body.liked, true);
    assert.equal((await call(env, likePath, { cookie: benCookie })).body.liked, false, "likes are per account");

    const ben = await call(env, likePath, { method: "PUT", cookie: benCookie });
    assert.equal(ben.body.likes, 7);
    const off = await call(env, likePath, { method: "DELETE", cookie: annCookie });
    assert.deepEqual({ liked: off.body.liked, likes: off.body.likes }, { liked: false, likes: 6 });
    assert.equal((await call(env, likePath, { method: "DELETE", cookie: annCookie })).body.likes, 6);
    const voters = db.prepare("SELECT voter FROM likes WHERE target_type = 'list' AND target_id = ? ORDER BY voter").all(pub.list.publicId).map((r) => r.voter);
    assert.equal(voters.length, 2);
    assert.ok(voters.includes("a:legacyvote"), "the legacy signed-out vote still counts");
  });

  it("moves the count by one when the same account likes from two places at once", async () => {
    // Both requests pass the "already liked?" check, so both batches run. The
    // harness cannot interleave two requests that finely, so the batch the
    // route sends is run twice directly.
    const sandbox = { console, URL, TextEncoder, crypto: globalThis.crypto };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    for (const rel of ["00_constants.js", "29_media.js", "30_lists-backfill.js", "31_lists-api.js", "32_likes-api.js"]) {
      vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"), sandbox, { filename: rel });
    }
    const env = { DB: makeD1() };
    env.DB._db.exec(`INSERT INTO accounts (id, username, display_name, key_hash, created_at) VALUES (1, 'ann', 'Ann', 'h', 0);
      INSERT INTO lists (id, public_id, owner_account_id, slug, name, media_type, visibility, like_count, created_at, updated_at)
        VALUES (10, 'p10', 1, 'x', 'X', 'movie', 'public', 5, 0, 0);`);
    const target = { type: "list", targetId: "p10", table: "lists", key: "public_id" };
    const likes = () => env.DB._db.prepare("SELECT like_count AS n FROM lists WHERE id = 10").get().n;
    await env.DB.batch(sandbox.likeWriteStatements(env, target, "acct:1", true, 1));
    await env.DB.batch(sandbox.likeWriteStatements(env, target, "acct:1", true, 1));
    assert.equal(likes(), 6);
    await env.DB.batch(sandbox.likeWriteStatements(env, target, "acct:1", false, 1));
    await env.DB.batch(sandbox.likeWriteStatements(env, target, "acct:1", false, 1));
    assert.equal(likes(), 5);
  });

  it("has no cap", async () => {
    const { env, db, annCookie, likePath, pub } = await likesSetup();
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 6000)
                INSERT INTO likes (target_type, target_id, voter, created_at) SELECT 'list', ?, 'a:' || i, 1 FROM n`).run(pub.list.publicId);
    db.prepare("UPDATE lists SET like_count = 6001 WHERE public_id = ?").run(pub.list.publicId);
    const r = await call(env, likePath, { method: "PUT", cookie: annCookie });
    assert.equal(r.status, 200);
    assert.equal(r.body.likes, 6002, "past the legacy ledger's 5,000-voter cap");
  });

  it("likes only lists people can see: not private, deleted or legacy anonymous ones", async () => {
    const { env, db, annCookie, benCookie } = await likesSetup();
    const priv = await createApiListFor(env, annCookie, { name: "Mine Only", mediaType: "movie", visibility: "private" });
    const unl = await createApiListFor(env, annCookie, { name: "By Link", mediaType: "movie", visibility: "unlisted" });
    assert.equal((await call(env, `/api/likes/list/${priv.list.publicId}`, { method: "PUT", cookie: benCookie })).status, 404);
    assert.equal((await call(env, `/api/likes/list/${priv.list.publicId}`, { method: "PUT", cookie: annCookie })).status, 404, "not even by its owner");
    assert.equal((await call(env, `/api/likes/list/${unl.list.publicId}`, { method: "PUT", cookie: benCookie })).body.likes, 1);
    db.prepare(`INSERT INTO lists (public_id, owner_account_id, slug, name, kind, media_type, visibility, legacy_id, created_at, updated_at)
                VALUES ('anonpublic02', NULL, 'old', 'Old', 'legacy_anonymous', 'movie', 'unlisted', 'a:old', 1, 1)`).run();
    assert.equal((await call(env, "/api/likes/list/anonpublic02", { method: "PUT", cookie: benCookie })).status, 404);
    db.prepare("UPDATE lists SET deleted_at = 1 WHERE public_id = ?").run(unl.list.publicId);
    assert.equal((await call(env, `/api/likes/list/${unl.list.publicId}`, { method: "PUT", cookie: benCookie })).status, 404);
    assert.equal((await call(env, "/api/likes/list/nosuchlist12", { method: "PUT", cookie: benCookie })).status, 404);
    assert.equal((await call(env, "/api/likes/playlist/x", { method: "PUT", cookie: benCookie })).status, 404);
  });

  it("likes a channel listed in Explore Channels, and no other", async () => {
    const { env, db, benCookie } = await likesSetup();
    db.prepare(`INSERT INTO channels (public_code, owner_account_id, name, visibility, like_count, created_at, updated_at)
                VALUES ('chanpub', NULL, 'Saturday Mornings', 'public', 3, 1, 1), ('chanunl', NULL, 'Shared', 'unlisted', 0, 1, 1)`).run();
    const r = await call(env, "/api/likes/channel/chanpub", { method: "PUT", cookie: benCookie });
    assert.deepEqual({ liked: r.body.liked, likes: r.body.likes }, { liked: true, likes: 4 });
    assert.equal(db.prepare("SELECT like_count AS n FROM channels WHERE public_code = 'chanpub'").get().n, 4);
    assert.equal((await call(env, "/api/likes/channel/chanunl", { method: "PUT", cookie: benCookie })).status, 404);
    assert.equal((await call(env, "/api/likes/channel/nope", { method: "PUT", cookie: benCookie })).status, 404);
  });

  it("likes an outside list by its URL, under the same key the legacy route uses", async () => {
    const { env, db, ben, benCookie, annCookie } = await likesSetup();
    const url = "https://mdblist.com/lists/someone/good-shows";
    const legacy = await call(env, "/api/lists/like-external", { method: "POST", json: { url, creatorName: ben.creatorName, creatorKey: ben.creatorKey } });
    assert.equal(legacy.body.ok, true);
    const legacyKey = [...env.CONFIGS._store.keys()].find((k) => k.startsWith("externallike:")).slice("externallike:".length);
    db.prepare("INSERT INTO likes (target_type, target_id, voter, created_at) VALUES ('external', ?, 'a:oldvote', 1)").run(legacyKey);

    const p = `/api/likes/external/${encodeURIComponent(url)}`;
    const r = await call(env, p, { method: "PUT", cookie: annCookie });
    assert.deepEqual({ liked: r.body.liked, likes: r.body.likes }, { liked: true, likes: 2 }, "an outside list's count is its votes");
    const rows = db.prepare("SELECT target_id FROM likes WHERE target_type = 'external' AND voter LIKE 'acct:%'").all();
    assert.deepEqual(rows.map((x) => x.target_id), [legacyKey]);
    assert.equal((await call(env, p, { cookie: benCookie })).body.likes, 2);
    const bad = await call(env, `/api/likes/external/${encodeURIComponent("https://example.com/whatever")}`, { method: "PUT", cookie: annCookie });
    assert.equal(bad.status, 400);
    assert.equal(db.prepare("SELECT count(*) AS n FROM likes WHERE target_type = 'external'").get().n, 2, "nothing stored for a URL that isn't a list");
  });
});
