import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { call, createUser, makeD1, makeEnv, makeKv, makeR2, seedAnonPublishedList } from "./harness.mjs";

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
    // Explore Channels' orders, ties broken as the legacy index breaks them (newest listing first).
    expectIndex("SELECT id FROM channels WHERE visibility = 'public' AND deleted_at IS NULL ORDER BY like_count DESC, add_count DESC, published_at DESC, id DESC LIMIT 60", "idx_channels_dir_liked");
    expectIndex("SELECT id FROM channels WHERE visibility = 'public' AND deleted_at IS NULL ORDER BY add_count DESC, like_count DESC, published_at DESC, id DESC LIMIT 60", "idx_channels_dir_added");
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

// Every legacy route now mirrors its change into v2 as it saves (34_). To
// test the backfill on lists that were saved before the v2 tables existed --
// which is what it copies in production -- the fixture's v2 rows are cleared.
function forgetV2(env) {
  env.DB._db.exec(`DELETE FROM lists_fts2; DELETE FROM likes; DELETE FROM account_list_prefs; DELETE FROM jobs;
    DELETE FROM list_items; DELETE FROM list_slug_history; DELETE FROM lists; DELETE FROM media; DELETE FROM channels;`);
  if (env.BLOBS && env.BLOBS._store) env.BLOBS._store.clear();
}

function loadBackfillFns() {
  const sandbox = { console, URL, TextEncoder, crypto: globalThis.crypto };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of ["00_constants.js", "29_media.js", "30_lists-backfill.js"]) {
    vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"), sandbox, { filename: rel });
  }
  return sandbox;
}

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

  forgetV2(env);
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
      // cache copies (getCreatorList), which would change the snapshot. The
      // order check against the route is its own test below.
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
        `SELECT li.season, li.episode, li.extra_json, m.kind, m.imdb_id, m.tmdb_id, m.alt_id, m.title, m.year, m.poster_path
         FROM list_items li JOIN media m ON m.id = li.media_id WHERE li.list_id = ? ORDER BY li.position`
      ).all(bySlug[fx.slugs.crossover].id);
      assert.deepEqual(crossItems.map((r) => [r.kind, r.tmdb_id, r.season, r.episode]),
        [["series", 1396, 1, 1], ["series", 1396, 1, 2], ["movie", 550, null, null]]);
      // Every entry rebuilds into exactly the item that was saved: an
      // episode keeps its own id and name, a companion its notes.
      const bf = loadBackfillFns();
      const savedCrossover = JSON.parse(env.CONFIGS._store.get(`creatorlist:annlists:${fx.slugs.crossover}`)).items;
      assert.deepEqual(crossItems.map((r) => plain(bf.legacyItemFromEntryRow(r))), savedCrossover);
      // Only what the media row cannot say; "~k" records that this item had
      // no year or poster, though the media row has both.
      const { "~k": companionKeys, ...companionExtra } = JSON.parse(crossItems[2].extra_json);
      assert.deepEqual(companionExtra, { isCompanion: true, companionType: "bridge_movie", companionNote: "Canon Bridge Movie" });
      assert.deepEqual(companionKeys, ["id", "type", "name", "isCompanion", "companionType", "companionNote"]);

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
      assert.deepEqual(status.body.accounts, { done: 3, running: 0, failed: 0, queued: 0 });
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
    forgetV2(env);
    await runBackfill(env, await adminCookie(env));
    const copied = env.DB._db.prepare("SELECT slug FROM lists WHERE owner_account_id IS NOT NULL ORDER BY position").all().map((r) => r.slug);
    assert.deepEqual(copied, dashboard.body.order.filter((s) => slugs.includes(s)));
    assert.deepEqual(copied, [slugs[2], slugs[0], slugs[3], slugs[1]]);
  });

  it("copies only what changed on a second run, and retires copies of deleted lists", async () => {
    const restore = withFakeTmdb(TMDB_FIXTURE);
    try {
      const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1(), TMDB_API_KEY: "test-key" });
      // Reads still on the legacy store: once they are on v2 a finished
      // account is never copied again (P3b-7 has its own test of that).
      delete env.FF_V2_LISTS_READ;
      const fx = await buildLegacyFixture(env);
      const cookie = await adminCookie(env);
      await runBackfill(env, cookie);
      const db = env.DB._db;
      const idsBefore = db.prepare("SELECT legacy_id, id, public_id FROM lists ORDER BY legacy_id").all();

      // Changed in the legacy store without a mirror (as before the v2 tables
      // existed, or a mirror that could not finish): one list edited, one deleted.
      const importedKey = `creatorlist:annlists:${fx.slugs.imported}`;
      const importedRecord = JSON.parse(env.CONFIGS._store.get(importedKey));
      importedRecord.items = [{ id: "tt0903747", type: "series" }, { id: "tt0137523", type: "movie" }];
      importedRecord.updatedAt += 1000;
      env.CONFIGS._store.set(importedKey, JSON.stringify(importedRecord));
      db.prepare("UPDATE creator_lists SET items_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(importedRecord.items), importedRecord.updatedAt, `annlists:${fx.slugs.imported}`);
      env.CONFIGS._store.delete(`creatorlist:annlists:${fx.slugs.top}`);
      db.prepare("DELETE FROM creator_lists WHERE id = ?").run(`annlists:${fx.slugs.top}`);

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
    forgetV2(env);
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
    forgetV2(env);
    env.DB.failWhen((sql, args) => /^\s*INSERT INTO lists\b/i.test(sql) && args.includes("bad"));
    const cookie = await adminCookie(env);
    await runBackfill(env, cookie);
    env.DB.failWhen(null);
    const status = await call(env, "/admin/api/lists-backfill/status", { cookie });
    assert.deepEqual(status.body.accounts, { done: 1, running: 0, failed: 1, queued: 0 });
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
    assert.deepEqual(mine.body.lists.map((l) => l.slug), ["top-films", "top-films-2", "top-films-3"],
      "in their order, starting with the legacy list the save mirrored into v2");
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
    // Ben's like through the legacy route was mirrored into v2 as it was cast.
    assert.deepEqual({ liked: r.body.liked, likes: r.body.likes }, { liked: true, likes: 3 }, "an outside list's count is its votes");
    const rows = db.prepare("SELECT DISTINCT target_id FROM likes WHERE target_type = 'external' AND voter LIKE 'acct:%'").all();
    assert.deepEqual(rows.map((x) => x.target_id), [legacyKey]);
    assert.equal((await call(env, p, { cookie: benCookie })).body.likes, 3);
    const bad = await call(env, `/api/likes/external/${encodeURIComponent("https://example.com/whatever")}`, { method: "PUT", cookie: annCookie });
    assert.equal(bad.status, 400);
    assert.equal(db.prepare("SELECT count(*) AS n FROM likes WHERE target_type = 'external'").get().n, 3, "nothing stored for a URL that isn't a list");
  });
});

// --- P3b-6: the directory and search on v2 (33_lists-directory.js) -------------
//
// One fixture, read twice: through the legacy paths (flag off) and through v2
// after the backfill has copied it (flag on). The answers must agree. 130
// lists, 118 of them public, so "the top 100" is a real cut.

function seedLegacyList(env, username, slug, rec) {
  const record = { name: rec.name, slug, type: rec.type, items: rec.items, visibility: rec.visibility, likes: rec.likes, createdAt: rec.createdAt, updatedAt: rec.updatedAt };
  env.CONFIGS._store.set(`creatorlist:${username}:${slug}`, JSON.stringify(record));
  env.DB._db.prepare(
    "INSERT INTO creator_lists (id, username, name, type, visibility, items_json, created_at, updated_at, likes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(`${username}:${slug}`, username, rec.name, rec.type, rec.visibility, JSON.stringify(rec.items), rec.createdAt, rec.updatedAt, rec.likes);
}

async function directoryFixture() {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
  const owners = [];
  for (let o = 0; o < 5; o++) {
    const name = `dirowner${o}`;
    await createUser(env, name, { displayName: o % 2 ? `Curator ${o}` : undefined });
    owners.push(name);
  }
  const words = ["Drama", "Comedy", "Space", "Noir", "Heist", "Western", "Anime", "Horror"];
  const types = ["movie", "series", "mixed"];
  for (let i = 0; i < 130; i++) {
    const owner = owners[i % owners.length];
    const count = i % 5; // some public lists are empty: the directory shows them, search does not
    seedLegacyList(env, owner, `list-${i}`, {
      name: `${words[i % words.length]} ${words[(i * 3) % words.length]} ${i}`,
      type: types[i % 3],
      visibility: i % 11 === 0 ? "private" : "public",
      items: Array.from({ length: count }, (_, k) => ({ id: `tt${String(5000000 + i * 10 + k)}`, type: "movie" })),
      likes: (i * 7) % 23,                       // plenty of ties on likes
      createdAt: 1700000000000 + ((i * 37) % 131) * 1000,
      updatedAt: 1750000000000 + ((i * 53) % 131) * 1000, // unique, so today's order is fully defined
    });
  }
  seedAnonPublishedList(env, "anon-drama", { name: "Anonymous Drama", items: [{ id: "tt0000001" }], likes: 99 });
  const cookie = await adminCookie(env);
  await runBackfill(env, cookie);
  const rebuilt = await call(env, "/admin/api/rebuild-search-index", { method: "POST", cookie });
  assert.equal(rebuilt.status, 200, JSON.stringify(rebuilt.body));
  return env;
}

async function readBoth(env, p) {
  delete env.FF_V2_LISTS_READ;
  const legacy = await call(env, p);
  env.FF_V2_LISTS_READ = "1";
  const v2 = await call(env, p);
  delete env.FF_V2_LISTS_READ;
  return { legacy, v2 };
}

describe("P3b-6: the directory and search on v2", () => {
  let env;
  it("builds the fixture", async () => {
    env = await directoryFixture();
  });

  it("lists the same top 100, in the same order, with the same fields", async () => {
    const { legacy, v2 } = await readBoth(env, "/lists/public.json?limit=100");
    assert.equal(legacy.body.lists.length, 100);
    assert.deepEqual(v2.body.lists, legacy.body.lists);
    assert.equal(v2.body.total, legacy.body.total);
    assert.equal(v2.body.count, 100);
    assert.ok(v2.body.cursor, "and a cursor for the next page");
    assert.equal(legacy.body.cursor, undefined, "the legacy answer is unchanged");
    assert.equal(v2.headers.get("cache-control"), legacy.headers.get("cache-control"));
    assert.ok(!v2.body.lists.some((l) => l.name === "Anonymous Drama"), "legacy anonymous lists stay out (D-6)");
  });

  it("pages by cursor and by offset to the same sequence", async () => {
    env.FF_V2_LISTS_READ = "1";
    try {
      const all = (await call(env, "/lists/public.json?limit=500")).body;
      const walked = [];
      let cursor = "";
      for (let page = 0; page < 20; page++) {
        const r = await call(env, `/lists/public.json?limit=17${cursor ? `&cursor=${cursor}` : ""}`);
        walked.push(...r.body.lists);
        if (!r.body.cursor) break;
        cursor = r.body.cursor;
      }
      assert.deepEqual(walked.map((l) => l.url), all.lists.map((l) => l.url));
      assert.equal(new Set(walked.map((l) => l.url)).size, walked.length, "no list twice");
      assert.equal(walked.length, all.total);
      const byOffset = (await call(env, "/lists/public.json?limit=17&offset=34")).body.lists;
      assert.deepEqual(byOffset, all.lists.slice(34, 51));
      assert.equal((await call(env, "/lists/public.json?cursor=garbage")).status, 400);
      // "added" and "popular" cursors have the same shape (three numbers), so
      // only the order's own mark tells them apart.
      const addedCursor = (await call(env, "/lists/public.json?sort=added&limit=5")).body.cursor;
      assert.equal((await call(env, `/lists/public.json?cursor=${addedCursor}`)).status, 400, "a cursor from another order is refused");
    } finally {
      delete env.FF_V2_LISTS_READ;
    }
  });

  it("orders by newest and by most added", async () => {
    env.FF_V2_LISTS_READ = "1";
    try {
      const rows = env.DB._db.prepare("SELECT slug, created_at, add_count, like_count, id FROM lists WHERE visibility = 'public' AND owner_account_id IS NOT NULL AND deleted_at IS NULL").all();
      const byNew = rows.slice().sort((a, b) => b.created_at - a.created_at || b.id - a.id).map((r) => r.slug);
      const byAdded = rows.slice().sort((a, b) => b.add_count - a.add_count || b.like_count - a.like_count || b.id - a.id).map((r) => r.slug);
      assert.deepEqual((await call(env, "/lists/public.json?sort=new&limit=500")).body.lists.map((l) => l.slug), byNew);
      const added = await call(env, "/lists/public.json?sort=added&limit=500");
      assert.deepEqual(added.body.lists.map((l) => l.slug), byAdded);
      assert.equal(added.body.sort, "added");
      assert.equal((await call(env, "/lists/public.json?sort=nonsense&limit=1")).body.sort, "popular");
    } finally {
      delete env.FF_V2_LISTS_READ;
    }
  });

  it("finds the same lists as the legacy search, in its order", async () => {
    const key = (l) => `${l.likes}:${l.items}`;
    for (const q of ["drama", "comedy noir", "dirowner3", "curator", "spa", "my lists", "", "zzznothing"]) {
      const { legacy, v2 } = await readBoth(env, `/api/search-published-lists?q=${encodeURIComponent(q)}`);
      assert.equal(v2.body.ok, true);
      const sorted = (arr) => arr.slice().sort((a, b) => a.url.localeCompare(b.url));
      // v2 also says when each list was made and changed and how many added
      // it (Search's Newest / Most added chips); the legacy path cannot.
      const legacyShape = (arr) => arr.map(({ createdAt, updatedAt, adds, ...rest }) => rest);
      assert.ok(v2.body.lists.every((l) => "createdAt" in l && "updatedAt" in l && "adds" in l));
      assert.deepEqual(sorted(legacyShape(v2.body.lists)), sorted(legacy.body.lists), `the same lists for "${q}"`);
      // Legacy orders by likes then items and leaves ties in no set order;
      // v2 gives the same order with ties broken by most recently updated.
      assert.deepEqual(v2.body.lists.map(key), legacy.body.lists.map(key), `the same order for "${q}"`);
      assert.ok(v2.body.lists.every((l) => l.items > 0), "only lists with items");
      if (q !== "zzznothing") assert.ok(legacy.body.lists.length > 0, `"${q}" finds something, so the comparison means something`);
    }
  });

  it("falls back to the legacy paths if v2 cannot answer", async () => {
    const { legacy } = await readBoth(env, "/lists/public.json?limit=10");
    env.FF_V2_LISTS_READ = "1";
    env.DB.failWhen((sql) => /FROM lists l JOIN accounts|FROM lists_fts2 f/.test(sql));
    try {
      const r = await call(env, "/lists/public.json?limit=10");
      assert.deepEqual(r.body.lists, legacy.body.lists);
      const s = await call(env, "/api/search-published-lists?q=drama");
      assert.equal(s.body.ok, true);
      assert.ok(s.body.lists.length > 0);
    } finally {
      env.DB.failWhen(null);
      delete env.FF_V2_LISTS_READ;
    }
  });

  it("walks the directory's indexes, with no sort step, for every order and every page", () => {
    const plan = (sql) => env.DB._db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(" | ");
    const base = "SELECT l.id FROM lists l JOIN accounts a ON a.id = l.owner_account_id WHERE l.visibility = 'public' AND l.deleted_at IS NULL AND l.owner_account_id IS NOT NULL";
    for (const [cols, index] of [
      [["like_count", "updated_at", "id"], "idx_lists_dir_popular"],
      [["created_at", "id"], "idx_lists_dir_new"],
      [["add_count", "like_count", "id"], "idx_lists_dir_added"],
    ]) {
      const order = `ORDER BY ${cols.map((c) => `l.${c} DESC`).join(", ")} LIMIT 101`;
      for (const sql of [`${base} ${order}`, `${base} AND (${cols.map((c) => "l." + c).join(", ")}) < (${cols.map(() => "1").join(", ")}) ${order}`]) {
        const p = plan(sql);
        assert.match(p, new RegExp(`INDEX ${index}\\b`), p);
        assert.doesNotMatch(p, /TEMP B-TREE/, p);
      }
    }
  });
});

// --- P3b-7: the legacy routes over v2, and the read switch -------------------

function loadBridgeFns() {
  const sandbox = { console, URL, TextEncoder, crypto: globalThis.crypto };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of ["00_constants.js", "29_media.js", "30_lists-backfill.js", "33_lists-directory.js", "34_lists-v2-bridge.js"]) {
    vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"), sandbox, { filename: rel });
  }
  return sandbox;
}

async function bridgeSetup() {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1(), FF_V2_LISTS_READ: "1" });
  const ann = await createUser(env, "annbridge");
  const ben = await createUser(env, "benbridge");
  const db = env.DB._db;
  const annId = db.prepare("SELECT id FROM accounts WHERE username = 'annbridge'").get().id;
  const benId = db.prepare("SELECT id FROM accounts WHERE username = 'benbridge'").get().id;
  const job = () => db.prepare("SELECT status, run_after, payload_json FROM jobs WHERE dedupe_key = ?").get(`migrate.lists:acct:${annId}`);
  return { env, db, ann, ben, annId, benId, job };
}

function dashboard(env, u, extra = {}) {
  return call(env, "/api/creator/lists", { method: "POST", json: { creatorName: u.creatorName, creatorKey: u.creatorKey, includeItems: true, ...extra } });
}

// The same request with reads on the legacy store, then on v2. The flag is
// left on.
async function legacyThenV2(env, fn) {
  delete env.FF_V2_LISTS_READ;
  const legacy = await fn();
  env.FF_V2_LISTS_READ = "1";
  const v2 = await fn();
  return { legacy, v2 };
}

function v2Items(db, legacyId) {
  return db.prepare(
    "SELECT li.id, li.position, m.imdb_id, m.alt_id FROM list_items li JOIN lists l ON l.id = li.list_id JOIN media m ON m.id = li.media_id WHERE l.legacy_id = ? ORDER BY li.position"
  ).all(legacyId);
}

const RICH_ITEMS = [
  { id: "tt0137523", type: "movie", name: "Fight Club", year: "1999", poster: "https://image.tmdb.org/t/p/w500/custom.jpg", addedAt: 1700000000000 },
  { id: "tt0903747", type: "series", name: "Breaking Bad" },
  { id: "62085", type: "episode", showId: "1396", showTitle: "Breaking Bad", name: "Pilot", seasonNum: 1, episodeNum: 1, airDate: "2008-01-20" },
  { id: "tt0111161", type: "movie", name: "Shawshank", isCompanion: true, companionType: "bridge_movie", companionNote: "Canon", later: { nested: [1, 2] } },
  { id: "tmdb:550", type: "movie" },
  { id: "tt0000001", type: "movie", name: null, year: 1931 },
  { year: "2001", id: "tt0172495", name: "Gladiator", type: "movie" },
  { id: "kitsu:1376", type: "series", name: "An anime by another id" },
];

describe("P3b-7: the legacy routes over v2", () => {
  it("plans the smallest change to a list's items", () => {
    const sb = loadBridgeFns();
    // Through JSON: the sandbox's arrays are not this realm's.
    const plan = (c, d) => JSON.parse(JSON.stringify(sb.planListEntryDiff(c, d)));
    const cur = Array.from({ length: 10 }, (_, i) => ({ id: 100 + i, key: `k${i}`, position: i, extra: null }));
    const want = (keys, extra = {}) => keys.map((key) => ({ key, extra: extra[key] || null }));
    const keys = cur.map((c) => c.key);
    const none = plan(cur, want(keys));
    assert.deepEqual([none.deletes.length, none.inserts.length, none.updates.length, none.renumber], [0, 0, 0, false]);

    const moved = plan(cur, want(["k9", ...keys.slice(0, 9)]));
    assert.deepEqual(moved.updates.map((u) => u.id), [109], "moving one item rewrites that item only");
    assert.ok(moved.updates[0].position < 0);
    assert.deepEqual([moved.deletes.length, moved.inserts.length], [0, 0]);

    const added = plan(cur, want([...keys.slice(0, 5), "new", ...keys.slice(5)]));
    assert.deepEqual([added.inserts.length, added.updates.length, added.deletes.length], [1, 0, 0]);
    assert.ok(added.inserts[0].position > 4 && added.inserts[0].position < 5, "placed between its neighbours");

    const removed = plan(cur, want(keys.filter((k) => k !== "k3")));
    assert.deepEqual([removed.deletes, removed.updates.length, removed.inserts.length], [[103], 0, 0]);

    const edited = plan(cur, want(keys, { k2: '{"note":1}' }));
    assert.deepEqual(edited.updates.map((u) => [u.id, u.position, u.extra]), [[102, 2, '{"note":1}']]);

    const reversed = plan(cur, want(keys.slice().reverse()));
    assert.equal(reversed.updates.length, 9, "all but one item has to move");
    const byId = new Map(cur.map((c) => [c.id, c.position]));
    for (const u of reversed.updates) byId.set(u.id, u.position);
    const order = [...byId.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    assert.deepEqual(order, cur.map((c) => c.id).reverse());

    const tight = plan([{ id: 1, key: "a", position: 0, extra: null }, { id: 2, key: "b", position: 1e-8, extra: null }], want(["a", "x", "b"]));
    assert.equal(tight.renumber, true, "no room left between two items: space the list out first");
  });

  it("gives back every item exactly as it was saved, on every read path", async () => {
    const { env, ann } = await bridgeSetup();
    const slug = await saveList(env, ann, { name: "Rich", type: "mixed", visibility: "public", items: RICH_ITEMS });
    await saveList(env, ann, { name: "Plain", type: "movie", visibility: "private", items: [{ id: "tt0068646", type: "movie" }] });
    await dashboard(env, ann); // the account's first v2 read finishes its copy

    const dash = await legacyThenV2(env, () => dashboard(env, ann));
    assert.deepEqual(dash.v2.body.lists, dash.legacy.body.lists);
    assert.deepEqual(dash.v2.body.order, dash.legacy.body.order);
    assert.deepEqual(dash.v2.body.lists.find((l) => l.slug === slug).items, RICH_ITEMS);
    const items = await legacyThenV2(env, () => call(env, "/api/creator/lists/items", {
      method: "POST", json: { creatorName: ann.creatorName, creatorKey: ann.creatorKey, slugs: [slug, "plain", "nope"] },
    }));
    assert.deepEqual(items.v2.body, items.legacy.body);
    const page = await legacyThenV2(env, () => call(env, `/lists/annbridge/${slug}.json`));
    assert.equal(page.v2.status, 200);
    assert.deepEqual(page.v2.body, page.legacy.body);
    const priv = await legacyThenV2(env, () => call(env, "/lists/annbridge/plain.json"));
    assert.equal(priv.v2.status, priv.legacy.status, "a private list stays private");
  });

  it("copies each save as a diff, keeping the rows that did not change", async () => {
    const { env, db, ann } = await bridgeSetup();
    const items = ["tt0000011", "tt0000012", "tt0000013", "tt0000014", "tt0000015"].map((id) => ({ id, type: "movie" }));
    const slug = await saveList(env, ann, { name: "Diffed", type: "movie", visibility: "private", items });
    const before = v2Items(db, `c:annbridge:${slug}`);
    assert.deepEqual(before.map((r) => r.imdb_id), items.map((i) => i.id));

    // Last to first, one out, one in.
    const next = [items[4], items[0], items[1], { id: "tt0000016", type: "movie" }, items[3]];
    await saveList(env, ann, { slug, name: "Diffed", type: "movie", visibility: "private", items: next });
    const after = v2Items(db, `c:annbridge:${slug}`);
    assert.deepEqual(after.map((r) => r.imdb_id), next.map((i) => i.id));
    const rowId = (rows, imdb) => rows.find((r) => r.imdb_id === imdb).id;
    for (const id of ["tt0000011", "tt0000012", "tt0000014", "tt0000015"]) {
      assert.equal(rowId(after, id), rowId(before, id), `${id} kept its row`);
    }
    const unmoved = ["tt0000011", "tt0000012", "tt0000014"];
    for (const id of unmoved) {
      assert.equal(after.find((r) => r.imdb_id === id).position, before.find((r) => r.imdb_id === id).position, `${id} kept its place`);
    }
    const list = db.prepare("SELECT item_count, legacy_hash FROM lists WHERE legacy_id = ?").get(`c:annbridge:${slug}`);
    assert.equal(list.item_count, 5);
    assert.ok(list.legacy_hash, "and the copy knows which legacy record it matches");

    // Saved again as it is: the list's version moves, its items are not
    // touched.
    const writes = [];
    env.DB.failWhen((sql) => {
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql) && /\blist_items\b/.test(sql) && !/SELECT count/.test(sql)) writes.push(sql);
      return false;
    });
    await saveList(env, ann, { slug, name: "Diffed", type: "movie", visibility: "private", items: next });
    env.DB.failWhen(null);
    assert.deepEqual(writes, []);
    assert.deepEqual(v2Items(db, `c:annbridge:${slug}`), after);

    // Mirrored again with nothing new (a Watchlist sync that left it alone):
    // nothing is written at all, not even the lease.
    const all = [];
    env.DB.failWhen((sql) => {
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) all.push(sql);
      return false;
    });
    await call(env, "/api/creator/lists/delete", { method: "POST", json: { creatorName: ann.creatorName, creatorKey: ann.creatorKey, slug: "no-such-list" } });
    env.DB.failWhen(null);
    assert.ok(!all.some((q) => /\b(lists|list_items|jobs|lists_fts2)\b/.test(q)), all.join("\n"));
  });

  it("copies an account on its first read, and until then reads the legacy store", async () => {
    const { env, db, ann, job } = await bridgeSetup();
    const slug = await saveList(env, ann, { name: "Old Faves", type: "movie", visibility: "public", items: [{ id: "tt0068646", type: "movie" }] });
    forgetV2(env); // saved before the v2 tables existed
    const page = await call(env, `/lists/annbridge/${slug}.json`);
    assert.equal(page.status, 200, "a public page reads the legacy store for an account not copied yet");
    assert.equal(db.prepare("SELECT count(*) AS n FROM lists").get().n, 0, "and does not copy it");

    const { legacy, v2 } = await legacyThenV2(env, () => dashboard(env, ann));
    assert.deepEqual(v2.body, legacy.body);
    assert.equal(job().status, "done", "the dashboard read copied the account");
    assert.equal(db.prepare("SELECT count(*) AS n FROM lists WHERE owner_account_id IS NOT NULL").get().n, 1);
  });

  it("reads from v2 once an account is copied, the catalogs included", async () => {
    const { env, ann } = await bridgeSetup();
    const slug = await saveList(env, ann, { name: "Catalogued", type: "movie", visibility: "public", items: [{ id: "tt0068646", type: "movie", name: "The Godfather" }] });
    await dashboard(env, ann);
    const custom = "customlist:v1:" + JSON.stringify({ creatorOwner: "annbridge", creatorSlug: slug, items: [] });
    env.CONFIGS._store.set("cfg:bridgecat01", JSON.stringify({ entries: [{ id: "mine", name: "Mine", type: "movie", url: custom }] }));
    const cat = await legacyThenV2(env, () => call(env, "/bridgecat01/catalog/movie/mine.json"));
    assert.equal(cat.v2.body.metas.length, 1);
    assert.deepEqual(cat.v2.body, cat.legacy.body);

    // Changed behind every route's back: the legacy reads see it, v2 does not.
    const key = `creatorlist:annbridge:${slug}`;
    const rec = JSON.parse(env.CONFIGS._store.get(key));
    env.CONFIGS._store.set(key, JSON.stringify({ ...rec, name: "Changed Underneath", items: [] }));
    env.DB._db.prepare("UPDATE creator_lists SET name = 'Changed Underneath', items_json = '[]' WHERE id = ?").run(`annbridge:${slug}`);
    const after = await legacyThenV2(env, () => call(env, `/lists/annbridge/${slug}.json`));
    assert.deepEqual(after.legacy.body, []);
    assert.equal(after.v2.body.length, 1);
    assert.equal(after.v2.body[0].title, "The Godfather");
    const cat2 = await legacyThenV2(env, () => call(env, "/bridgecat01/catalog/movie/mine.json"));
    assert.equal(cat2.legacy.body.metas.length, 0);
    assert.equal(cat2.v2.body.metas.length, 1);
    const dash = await dashboard(env, ann);
    assert.equal(dash.body.lists.find((l) => l.slug === slug).name, "Catalogued");

    // A save is seen on the catalog's next request, not when its cache lapses.
    await saveList(env, ann, { slug, name: "Catalogued", type: "movie", visibility: "public", items: [{ id: "tt0068646", type: "movie" }, { id: "tt0071562", type: "movie" }] });
    assert.equal((await call(env, "/bridgecat01/catalog/movie/mine.json")).body.metas.length, 2);
  });

  it("a mirror that fails sends the account back to the legacy store until it is copied again", async () => {
    const { env, db, ann, job } = await bridgeSetup();
    const slug = await saveList(env, ann, { name: "Flaky", type: "movie", visibility: "private", items: [{ id: "tt0000021", type: "movie" }] });
    await dashboard(env, ann);
    assert.equal(job().status, "done");

    env.DB.failWhen((sql) => /INSERT OR IGNORE INTO list_items/.test(sql));
    const items = [{ id: "tt0000021", type: "movie" }, { id: "tt0000022", type: "movie" }];
    await saveList(env, ann, { slug, name: "Flaky", type: "movie", visibility: "private", items });
    assert.notEqual(job().status, "done", "the copy is marked stale");
    const during = await dashboard(env, ann);
    assert.deepEqual(during.body.lists[0].items, items, "and reads fall back to the legacy store, which has the save");
    env.DB.failWhen(null);

    const { legacy, v2 } = await legacyThenV2(env, () => dashboard(env, ann));
    assert.deepEqual(v2.body, legacy.body);
    assert.equal(job().status, "done", "the next read copied it again");
    assert.deepEqual(v2Items(db, `c:annbridge:${slug}`).map((r) => r.imdb_id), ["tt0000021", "tt0000022"]);
  });

  it("a D1 write that failed during a save still reaches v2", async () => {
    const { env, ann, job } = await bridgeSetup();
    const slug = await saveList(env, ann, { name: "Before", type: "movie", visibility: "private", items: [] });
    await dashboard(env, ann);
    env.DB.failWhen((sql) => /INTO creator_lists/.test(sql));
    await saveList(env, ann, { slug, name: "After", type: "movie", visibility: "private", items: [{ id: "tt0000031", type: "movie" }] });
    env.DB.failWhen(null);
    assert.equal(job().status, "done", "the mirror read the newer KV copy and finished");
    const dash = await dashboard(env, ann);
    assert.equal(dash.body.lists[0].name, "After");
    assert.deepEqual(dash.body.lists[0].items, [{ id: "tt0000031", type: "movie" }]);
  });

  it("a save during a copy marks it dirty, and the copy goes round again", async () => {
    const { env, db, ann, annId, job } = await bridgeSetup();
    const slug = await saveList(env, ann, { name: "Busy", type: "movie", visibility: "private", items: [] });
    await dashboard(env, ann);
    const key = `migrate.lists:acct:${annId}`;
    db.prepare("UPDATE jobs SET run_after = ? WHERE dedupe_key = ?").run(Date.now() + 60000, key); // a copy holds the lease

    await saveList(env, ann, { slug, name: "Busy", type: "movie", visibility: "private", items: [{ id: "tt0000041", type: "movie" }] });
    assert.equal(job().status, "queued");
    assert.match(job().payload_json, /"dirty":true/);
    const during = await dashboard(env, ann);
    assert.deepEqual(during.body.lists[0].items, [{ id: "tt0000041", type: "movie" }], "the legacy store answers meanwhile");

    db.prepare("UPDATE jobs SET run_after = 0 WHERE dedupe_key = ?").run(key);
    const cookie = await adminCookie(env);
    await runBackfill(env, cookie);
    assert.equal(job().status, "done");
    assert.equal(job().payload_json, null, "the dirty mark is cleared by the copy that took it in");
    assert.deepEqual(v2Items(db, `c:annbridge:${slug}`).map((r) => r.imdb_id), ["tt0000041"]);
  });

  it("keeps a finished account as it is when the copy runs again with reads on v2", async () => {
    const { env, db, ann } = await bridgeSetup();
    const slug = await saveList(env, ann, { name: "Settled", type: "movie", visibility: "private", items: [] });
    await dashboard(env, ann);
    const key = `creatorlist:annbridge:${slug}`;
    env.CONFIGS._store.set(key, JSON.stringify({ ...JSON.parse(env.CONFIGS._store.get(key)), name: "Changed Underneath", updatedAt: Date.now() + 1000 }));
    const cookie = await adminCookie(env);
    await runBackfill(env, cookie, { restart: true });
    const name = () => db.prepare("SELECT name FROM lists WHERE legacy_id = ?").get(`c:annbridge:${slug}`).name;
    assert.equal(name(), "Settled", "v2 is what people see, and saves keep it current");
    delete env.FF_V2_LISTS_READ;
    await runBackfill(env, cookie, { restart: true });
    assert.equal(name(), "Changed Underneath", "with reads on the legacy store the copy is refreshed");
  });

  it("likes through the legacy routes move the v2 counts", async () => {
    const { env, db, ann, ben, benId } = await bridgeSetup();
    const slug = await saveList(env, ann, { name: "Likeable", type: "movie", visibility: "public", items: [{ id: "tt0000051", type: "movie" }] });
    await dashboard(env, ann);
    const like = (action) => call(env, "/api/lists/like", {
      method: "POST", json: { username: "annbridge", slug, creatorName: ben.creatorName, creatorKey: ben.creatorKey, ...(action ? { action } : {}) },
    });
    const count = () => db.prepare("SELECT like_count FROM lists WHERE legacy_id = ?").get(`c:annbridge:${slug}`).like_count;
    const liked = await like();
    assert.equal(liked.body.ok, true, JSON.stringify(liked.body));
    assert.equal(count(), 1);
    assert.equal(liked.body.likes, 1);
    assert.deepEqual(db.prepare("SELECT voter FROM likes WHERE target_type = 'list'").all().map((r) => r.voter), [`acct:${benId}`]);
    const unliked = await like("unlike");
    assert.equal(unliked.body.ok, true);
    assert.equal(count(), 0);
    assert.equal(unliked.body.likes, 0);

    const ext = (action) => call(env, "/api/lists/like-external", {
      method: "POST", json: { url: "https://mdblist.com/lists/someone/good-shows", creatorName: ben.creatorName, creatorKey: ben.creatorKey, ...(action ? { action } : {}) },
    });
    assert.equal((await ext()).body.ok, true);
    const extRows = db.prepare("SELECT target_id, voter FROM likes WHERE target_type = 'external'").all();
    assert.equal(extRows.length, 1);
    assert.equal(extRows[0].voter, `acct:${benId}`);
    assert.ok(env.CONFIGS._store.has(`externallike:${extRows[0].target_id}`), "under the hash the legacy route uses");
    assert.equal((await ext("unlike")).body.ok, true);
    assert.equal(db.prepare("SELECT count(*) AS n FROM likes WHERE target_type = 'external'").get().n, 0);
  });

  it("a reorder keeps the shelves in their places", async () => {
    const { env, db, ann, annId } = await bridgeSetup();
    for (const name of ["Alpha", "Beta", "Gamma"]) await saveList(env, ann, { name, type: "movie", visibility: "private", items: [] });
    await dashboard(env, ann);
    const r = await call(env, "/api/creator/lists/reorder", {
      method: "POST", json: { creatorName: ann.creatorName, creatorKey: ann.creatorKey, order: ["gamma", "continue-watching", "alpha", "beta"] },
    });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    const { legacy, v2 } = await legacyThenV2(env, () => dashboard(env, ann));
    assert.deepEqual(v2.body.order, legacy.body.order);
    assert.deepEqual(v2.body.lists.map((l) => l.slug), legacy.body.lists.map((l) => l.slug));
    assert.deepEqual(db.prepare("SELECT target FROM account_list_prefs WHERE account_id = ? AND pref = 'section'").all(annId).map((x) => x.target), ["continue-watching"]);
  });

  it("an account reset takes its v2 copy with it", async () => {
    const { env, db, ann, ben, annId } = await bridgeSetup();
    const slug = await saveList(env, ann, { name: "Doomed", type: "movie", visibility: "public", items: [{ id: "tt0000061", type: "movie" }] });
    await call(env, "/api/creator/lists/reorder", { method: "POST", json: { creatorName: ann.creatorName, creatorKey: ann.creatorKey, order: ["continue-watching", slug] } });
    await call(env, "/api/lists/like", { method: "POST", json: { username: "annbridge", slug, creatorName: ben.creatorName, creatorKey: ben.creatorKey } });
    await dashboard(env, ann);
    assert.equal(db.prepare("SELECT count(*) AS n FROM likes WHERE target_type = 'list'").get().n, 1);
    const r = await call(env, "/api/creator/account/reset", { method: "POST", json: { creatorName: ann.creatorName, creatorKey: ann.creatorKey, confirm: "RESET" } });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.equal(db.prepare("SELECT count(*) AS n FROM lists WHERE owner_account_id = ?").get(annId).n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM likes WHERE target_type = 'list'").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM account_list_prefs WHERE account_id = ?").get(annId).n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM jobs WHERE dedupe_key = ?").get(`migrate.lists:acct:${annId}`).n, 0);
    const { legacy, v2 } = await legacyThenV2(env, () => dashboard(env, ann));
    assert.deepEqual(v2.body, legacy.body);
  });

  it("a list saved before lists had a version reports none from v2 either", async () => {
    const { env, ann } = await bridgeSetup();
    const slug = await saveList(env, ann, { name: "Ancient", type: "movie", visibility: "private", items: [] });
    const key = `creatorlist:annbridge:${slug}`;
    const rec = JSON.parse(env.CONFIGS._store.get(key));
    delete rec.updatedAt;
    env.CONFIGS._store.set(key, JSON.stringify(rec));
    const dash = await legacyThenV2(env, () => dashboard(env, ann));
    assert.ok(!("updatedAt" in dash.v2.body.lists[0]), JSON.stringify(dash.v2.body.lists[0]));
    assert.deepEqual(dash.v2.body, dash.legacy.body);
    const items = await call(env, "/api/creator/lists/items", { method: "POST", json: { creatorName: ann.creatorName, creatorKey: ann.creatorKey, slugs: [slug] } });
    assert.ok(!("updatedAt" in items.body.lists[0]));
  });

  it("the Watchlist is read from the legacy store, and its v2 copy kept current", async () => {
    const { env, db, ann } = await bridgeSetup();
    const track = (watchlist) => call(env, "/api/creator/sync/save-tracking", {
      method: "POST", json: { creatorName: ann.creatorName, creatorKey: ann.creatorKey, watchlist },
    });
    await saveList(env, ann, { name: "Other", type: "movie", visibility: "private", items: [] });
    assert.equal((await track([{ id: "tt0000071", type: "movie" }, { id: "tt0000072", type: "movie" }])).body.ok, true);
    await dashboard(env, ann);
    const count = () => db.prepare("SELECT item_count, kind FROM lists WHERE legacy_id = 'c:annbridge:watchlist'").get();
    assert.deepEqual({ ...count() }, { item_count: 2, kind: "watchlist" });
    await track([{ id: "tt0000071", type: "movie" }, { id: "tt0000072", type: "movie" }, { id: "tt0000073", type: "movie" }]);
    assert.equal(count().item_count, 3);
    const { legacy, v2 } = await legacyThenV2(env, () => dashboard(env, ann));
    assert.deepEqual(v2.body, legacy.body);
  });

  it("the directory and search wait for the copy to finish", async () => {
    const { env, ann } = await bridgeSetup();
    await saveList(env, ann, { name: "Shared Early", type: "movie", visibility: "public", items: [{ id: "tt0000081", type: "movie" }] });
    const before = await call(env, "/lists/public.json");
    assert.ok(!("cursor" in before.body), "the legacy directory answers while the copy has not run");
    assert.equal(before.body.lists.length, 1);
    // A name only the v2 copy has, to tell the two searches apart.
    const db = env.DB._db;
    const row = db.prepare("SELECT id FROM lists WHERE legacy_id = 'c:annbridge:shared-early'").get();
    db.prepare("UPDATE lists_fts2 SET name = 'Zanzibar' WHERE rowid = ?").run(row.id);
    assert.deepEqual((await call(env, "/api/search-published-lists?q=zanzibar")).body.lists, [], "search too");
    await runBackfill(env, await adminCookie(env));
    const after = await call(env, "/lists/public.json");
    assert.ok("cursor" in after.body, "and v2 once it has");
    assert.deepEqual(after.body.lists, before.body.lists);
    db.prepare("UPDATE lists_fts2 SET name = 'Zanzibar' WHERE rowid = ?").run(row.id);
    assert.equal((await call(env, "/api/search-published-lists?q=zanzibar")).body.lists.length, 1);
  });

  it("spaces a list's positions out again when moves have used up the room", async () => {
    const { env, db, ann } = await bridgeSetup();
    const a = { id: "tt0000101", type: "movie" };
    const b = { id: "tt0000102", type: "movie" };
    const slug = await saveList(env, ann, { name: "Crowded", type: "movie", visibility: "private", items: [a, b] });
    const rows = v2Items(db, `c:annbridge:${slug}`);
    // Two neighbours with no double left between them.
    db.prepare("UPDATE list_items SET position = ? WHERE id = ?").run(1 + 2 ** -52, rows[0].id);
    db.prepare("UPDATE list_items SET position = ? WHERE id = ?").run(1 + 2 ** -51, rows[1].id);
    await saveList(env, ann, { slug, name: "Crowded", type: "movie", visibility: "private", items: [a, { id: "tt0000103", type: "movie" }, b] });
    const after = v2Items(db, `c:annbridge:${slug}`);
    assert.deepEqual(after.map((r) => r.imdb_id), ["tt0000101", "tt0000103", "tt0000102"]);
    for (let i = 1; i < after.length; i++) assert.ok(after[i].position - after[i - 1].position >= 1e-7, JSON.stringify(after));
  });

  it("copies a list of 10,000 titles on save, in one request, well inside D1's limits", async () => {
    const { env, db, ann, job } = await bridgeSetup();
    await saveList(env, ann, { name: "Small", type: "movie", visibility: "private", items: [] });
    await dashboard(env, ann);
    assert.equal(job().status, "done");
    const items = Array.from({ length: 10000 }, (_, i) => ({ id: `tt${2000000 + i}`, type: "movie", name: `Title ${i}`, note: i % 7 ? undefined : `note ${i}` }));
    let queries = 0;
    env.DB.failWhen(() => { queries++; return false; });
    const slug = await saveList(env, ann, { name: "Huge", type: "movie", visibility: "private", items });
    env.DB.failWhen(null);
    assert.ok(queries < 200, `the save and its copy took ${queries} D1 queries (D1 allows about 1,000)`);
    assert.equal(job().status, "done", "copied on save, so the account stays on v2");
    assert.equal(db.prepare("SELECT item_count FROM lists WHERE legacy_id = ?").get(`c:annbridge:${slug}`).item_count, 10000);
    const { legacy, v2 } = await legacyThenV2(env, () => call(env, "/api/creator/lists/items", {
      method: "POST", json: { creatorName: ann.creatorName, creatorKey: ann.creatorKey, slugs: [slug] },
    }));
    assert.deepEqual(v2.body, legacy.body);

    // Most of it moved at once (reversed): still a few statements.
    queries = 0;
    env.DB.failWhen(() => { queries++; return false; });
    await saveList(env, ann, { slug, name: "Huge", type: "movie", visibility: "private", items: items.slice().reverse() });
    env.DB.failWhen(null);
    assert.ok(queries < 200, `reversing it took ${queries} D1 queries`);
    const order = db.prepare(
      "SELECT m.imdb_id FROM list_items li JOIN lists l ON l.id = li.list_id JOIN media m ON m.id = li.media_id WHERE l.legacy_id = ? ORDER BY li.position, li.id LIMIT 3"
    ).all(`c:annbridge:${slug}`).map((r) => r.imdb_id);
    assert.deepEqual(order, ["tt2009999", "tt2009998", "tt2009997"]);
  });

  it("saves and reads carry on as before when migration 0016 is not applied", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1(), FF_V2_LISTS_READ: "1" });
    env.DB._db.exec("DROP TABLE list_items; DROP TABLE list_slug_history; DROP TABLE lists_fts2; DROP TABLE lists; DROP TABLE jobs;");
    const ann = await createUser(env, "annold");
    const slug = await saveList(env, ann, { name: "Still Works", type: "movie", visibility: "public", items: [{ id: "tt0000091", type: "movie" }] });
    const { legacy, v2 } = await legacyThenV2(env, () => dashboard(env, ann));
    assert.deepEqual(v2.body, legacy.body);
    assert.equal((await call(env, `/lists/annold/${slug}.json`)).status, 200);
    assert.equal((await call(env, "/lists/public.json")).body.lists.length, 1);
  });
});

// --- P3b-8: shared channels on v2 --------------------------------------------

const CH_SHOWS = [
  { id: "tt0903747", name: "Breaking Bad" },
  { id: "tt0141842", name: "The Sopranos" },
  { id: "tt0098904", name: "Seinfeld" },
  { id: "tt0108778", name: "Friends" },
];

function channelItems(shows) {
  const items = [];
  shows.forEach((show, s) => {
    for (let season = 1; season <= 2; season++) {
      for (let ep = 1; ep <= 4; ep++) {
        items.push({
          kind: "episode", imdbId: show.id, season, episode: ep, showName: show.name, epName: `${show.name} ${season}x${ep}`,
          released: `20${10 + s}-0${season}-${String(ep * 3).padStart(2, "0")}`, runtime: 30 + s,
          thumbnail: `https://img.example.com/${show.id}/${season}/${ep}.jpg`,
        });
      }
    }
  });
  return items;
}

function channelPayload(name, shows, extra = {}) {
  return { name, description: `${name}, described`, items: channelItems(shows), ...extra };
}

const CH_FIXTURES = {
  rotating: channelPayload("Night Shift", CH_SHOWS, {
    dailyRotate: true, rotateShows: 2, rotateEpisodes: 2, storyLocked: ["tt0903747"], poster: "https://img.example.com/night.jpg",
  }),
  shuffled: {
    name: "Mixed Bag", shuffle: true, pairParts: true, pairedGroups: [["tt0903747:1:1", "tt0903747:1:2"]],
    items: [...channelItems(CH_SHOWS.slice(0, 2)), { kind: "movie", imdbId: "tt0137523", title: "Fight Club", released: "1999-10-15", runtime: 139 }],
  },
  aired: channelPayload("Oldies", CH_SHOWS.slice(2), { sortByAired: true, autoSort: "interleave" }),
};

async function channelsSetup(opts = {}) {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1(), FF_V2_LISTS_READ: "1", ...opts });
  const ann = await createUser(env, "annchan");
  const ben = await createUser(env, "benchan");
  const cat = await createUser(env, "catchan");
  const db = env.DB._db;
  const idOf = (name) => db.prepare("SELECT id FROM accounts WHERE username = ?").get(name).id;
  return { env, db, ann, ben, cat, annId: idOf("annchan"), benId: idOf("benchan"), catId: idOf("catchan") };
}

const creds = (u) => ({ creatorName: u.creatorName, creatorKey: u.creatorKey });

async function shareChannel(env, u, channel, extra = {}) {
  const r = await call(env, "/api/channel/share", { method: "POST", json: { ...creds(u), channel, ...extra } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

const channelRow = (db, code) => db.prepare("SELECT * FROM channels WHERE public_code = ?").get(code);

async function channelLineup(env, channel, now) {
  const r = await call(env, "/api/channel-lineup", { method: "POST", json: { url: "channel:v1:" + JSON.stringify(channel), now } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.items;
}

const LINEUP_DAYS = [1767225600000, 1767312000000, 1769904000000 + 3600000 * 5];

describe("P3b-8: shared channels on v2", () => {
  it("copies every shared channel, likes and adds included, and each plays the same lineup for the same day", async () => {
    const { env, db, ann, ben, cat, benId, catId } = await channelsSetup();
    const rotating = await shareChannel(env, ann, CH_FIXTURES.rotating, { publish: true });
    const shuffled = await shareChannel(env, ann, CH_FIXTURES.shuffled, { publish: true });
    const aired = await shareChannel(env, ben, CH_FIXTURES.aired);
    for (const u of [ben, cat]) {
      const r = await call(env, "/api/channel/like", { method: "POST", json: { ...creds(u), code: rotating.code } });
      assert.equal(r.body.ok, true, JSON.stringify(r.body));
    }
    const added = await call(env, "/api/channel/added", { method: "POST", json: { ...creds(ben), code: rotating.code } });
    assert.equal(added.body.counted, true);
    // What only the legacy store remembers: a signed-out vote from before
    // D-6, a total above its voters, shares from before accounts, one whose
    // owner has gone, and a record nothing can read.
    const kv = env.CONFIGS._store;
    kv.set(`channellikevoters:${shuffled.code}`, JSON.stringify(["a:deadbeef"]));
    const index = JSON.parse(kv.get("index:publicchannels"));
    index.entries.find((e) => e.code === shuffled.code).likes = 7;
    kv.set("index:publicchannels", JSON.stringify(index));
    const oldShare = (code, owner) => JSON.stringify({ code, channel: CH_FIXTURES.aired, description: "", owner, published: false, publishedAt: 1600000000000, updatedAt: 1600000000000 });
    kv.set("channelshare:OLDANON1", oldShare("OLDANON1", ""));
    kv.set("channelshare:GHOSTOWN", oldShare("GHOSTOWN", "ghostuser"));
    kv.set("channelshare:BROKEN01", "{not json");
    forgetV2(env); // shared before the v2 tables existed

    const cookie = await adminCookie(env);
    const before = legacySnapshot(env);
    const steps = await runBackfill(env, cookie, { maxOps: 30 });
    assert.ok(steps.length > 2, "in several steps");
    assert.equal(legacySnapshot(env), before, "the copy wrote nothing to the legacy store");

    for (const code of [rotating.code, shuffled.code, aired.code, "OLDANON1", "GHOSTOWN"]) {
      const row = channelRow(db, code);
      assert.ok(row && row.legacy_hash && env.BLOBS._store.has(row.pool_r2_key), `${code} has its row and its pool`);
      const { legacy, v2 } = await legacyThenV2(env, () => call(env, `/api/channel/share?code=${code}`));
      assert.equal(v2.status, 200);
      assert.deepEqual(v2.body, legacy.body, code);
      for (const day of LINEUP_DAYS) {
        assert.deepEqual(await channelLineup(env, v2.body.channel, day), await channelLineup(env, legacy.body.channel, day), `${code} on ${day}`);
      }
    }
    const days = await Promise.all(LINEUP_DAYS.slice(0, 2).map((d) => channelLineup(env, CH_FIXTURES.rotating, d)));
    assert.notDeepEqual(days[0], days[1], "the rotating fixture really does rotate");

    assert.equal(channelRow(db, rotating.code).like_count, 2);
    assert.equal(channelRow(db, rotating.code).add_count, 1);
    assert.equal(channelRow(db, shuffled.code).like_count, 7, "a legacy total above its voters is kept (D-9)");
    const voters = (code, type = "channel") => db.prepare("SELECT voter FROM likes WHERE target_type = ? AND target_id = ? ORDER BY voter").all(type, code).map((r) => r.voter);
    assert.deepEqual(voters(rotating.code), [`acct:${benId}`, `acct:${catId}`].sort());
    assert.deepEqual(voters(shuffled.code), ["a:deadbeef"]);
    assert.deepEqual(voters(rotating.code, "channel_add"), [`acct:${benId}`]);
    assert.equal(channelRow(db, "GHOSTOWN").owner_account_id, null);
    assert.equal(channelRow(db, aired.code).visibility, "unlisted");
    assert.equal(channelRow(db, "BROKEN01"), undefined);

    const ch = (await call(env, "/admin/api/lists-backfill/status", { cookie })).body.channels;
    assert.deepEqual(ch.channels, { legacy: 6, copied: 5, unchanged: 0, unreadable: 1, listed: 2 });
    assert.deepEqual(ch.samples.unreadable, ["BROKEN01"]);
    assert.equal(ch.pools.written, 5);
    assert.equal(ch.likes.keptFromCount, 6);
    assert.equal(ch.adds.adders, 1);

    // Again: nothing changed, so no row or pool is written.
    const pools = new Map([...env.BLOBS._store.entries()]);
    await runBackfill(env, cookie, { restart: true });
    const again = (await call(env, "/admin/api/lists-backfill/status", { cookie })).body.channels;
    assert.equal(again.channels.unchanged, 5);
    assert.equal(again.pools.written, 0);
    assert.deepEqual(new Map([...env.BLOBS._store.entries()]), pools);
  });

  it("reads Explore Channels from the rows once the copy has finished, in every order", async () => {
    const { env, ann, ben, cat } = await channelsSetup();
    const owners = [ann, ben, cat];
    const names = ["Zeta TV", "alpha TV", "Mu TV", "beta TV", "Éclair TV", "gamma TV", "Delta TV", "eta TV", "Omega TV", "Quiet TV"];
    const codes = [];
    for (let i = 0; i < names.length; i++) {
      const out = await shareChannel(env, owners[i % 3], channelPayload(names[i], CH_SHOWS.slice(i % 3, (i % 3) + 2)), { publish: i < 8 });
      codes.push(out.code);
    }
    // Ties on likes and on adds, so the tie-break is tested too.
    const like = (u, code) => call(env, "/api/channel/like", { method: "POST", json: { ...creds(u), code } });
    const add = (u, code) => call(env, "/api/channel/added", { method: "POST", json: { ...creds(u), code } });
    for (const [u, i] of [[ann, 1], [ben, 1], [cat, 2], [ann, 3], [ben, 5], [cat, 5]]) assert.equal((await like(u, codes[i])).body.ok, true);
    for (const [u, i] of [[ann, 2], [ben, 2], [cat, 3], [ann, 6], [ben, 7]]) assert.equal((await add(u, codes[i])).body.counted, true);
    // Updated while listed: it goes back to the top of Newest, and wins its
    // tie on likes with a channel listed after it.
    await shareChannel(env, ben, channelPayload(names[1], CH_SHOWS.slice(0, 1)), { code: codes[1] });
    // One shared before the v2 tables existed: until the copy has run, the
    // directory is read from the legacy index, which has it.
    await shareChannel(env, cat, channelPayload("Early TV", CH_SHOWS.slice(3)), { publish: true });
    env.DB._db.prepare("DELETE FROM channels WHERE name = 'Early TV'").run();
    const early = await legacyThenV2(env, () => call(env, "/api/channel/directory"));
    assert.equal(early.v2.body.channels.length, 9);
    assert.deepEqual(early.v2.body, early.legacy.body);

    const paths = ["/api/channel/directory", "/api/channel/directory?sort=newest&limit=3"];
    for (const sort of ["liked", "added", "name", "bogus"]) paths.push(`/api/channel/directory?sort=${sort}`);
    const cookie = await adminCookie(env);
    const reads = async () => {
      const out = [];
      for (const p of paths) out.push((await call(env, p)).body);
      out.push((await call(env, "/api/channel/mine", { method: "POST", json: creds(ben) })).body);
      out.push((await call(env, "/admin/api/published-channels?scope=listed", { cookie })).body);
      out.push((await call(env, "/channels/annchan/zeta-tv.json")).body);
      out.push((await call(env, "/api/channel/share?code=channels:benchan:alpha-tv")).body);
      return out;
    };
    await runBackfill(env, cookie);
    const { legacy, v2 } = await legacyThenV2(env, reads);
    assert.equal(legacy[0].channels.length, 9, "the nine listed channels");
    assert.deepEqual(v2, legacy);
    assert.equal(v2[0].channels[1].name, "alpha TV", "moved to the top by its update (Early TV came after)");
    assert.deepEqual(v2[2].channels.slice(0, 2).map((c) => c.name), ["alpha TV", "gamma TV"], "a tie on likes goes to the newer listing");
    assert.deepEqual(v2[4].channels.map((c) => c.name), [...names.slice(0, 8), "Early TV"].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));

    // From the rows now: with the legacy index emptied, v2 still lists them.
    const kv = env.CONFIGS._store;
    const saved = kv.get("index:publicchannels");
    kv.set("index:publicchannels", JSON.stringify({ entries: [] }));
    const after = await legacyThenV2(env, () => call(env, "/api/channel/directory"));
    assert.equal(after.legacy.body.channels.length, 0);
    assert.equal(after.v2.body.channels.length, 9);
    const mine = await legacyThenV2(env, () => call(env, "/api/channel/mine", { method: "POST", json: creds(ben) }));
    assert.equal(mine.legacy.body.channels.length, 0);
    assert.deepEqual(mine.v2.body.channels.map((c) => c.name), ["alpha TV", "eta TV", "Éclair TV"]);
    kv.set("index:publicchannels", saved);

    // An unpublish leaves both directories the same way.
    await call(env, "/api/channel/unpublish", { method: "POST", json: { ...creds(ann), code: codes[0] } });
    const unpublished = await legacyThenV2(env, () => call(env, "/api/channel/directory"));
    assert.equal(unpublished.v2.body.channels.length, 8);
    assert.deepEqual(unpublished.v2.body, unpublished.legacy.body);
  });

  it("mirrors each share, edit, unpublish, like and add as it happens", async () => {
    const { env, db, ann, ben, annId, benId } = await channelsSetup();
    const first = await shareChannel(env, ann, CH_FIXTURES.rotating, { publish: true });
    const row1 = channelRow(db, first.code);
    assert.deepEqual(
      { vis: row1.visibility, owner: row1.owner_account_id, slug: row1.slug, items: row1.item_count, shows: row1.show_count, pool: row1.pool_version },
      { vis: "public", owner: annId, slug: "night-shift", items: 32, shows: 4, pool: 1 });
    assert.equal(JSON.parse(env.BLOBS._store.get(row1.pool_r2_key)).length, 32);

    // Edited and shared again under its code: a new pool, the old one gone.
    const edited = { ...CH_FIXTURES.rotating, items: CH_FIXTURES.rotating.items.slice(0, 10) };
    assert.equal((await shareChannel(env, ann, edited, { code: first.code })).code, first.code);
    const row2 = channelRow(db, first.code);
    assert.equal(row2.pool_version, 2);
    assert.ok(!env.BLOBS._store.has(row1.pool_r2_key), "the old pool is removed");
    assert.equal(JSON.parse(env.BLOBS._store.get(row2.pool_r2_key)).length, 10);
    assert.ok(row2.published_at >= row1.published_at);
    // Shared again with the same episodes: the pool stays as it is.
    await shareChannel(env, ann, edited, { code: first.code });
    assert.equal(channelRow(db, first.code).pool_version, 2);
    const read = await legacyThenV2(env, () => call(env, `/api/channel/share?code=${first.code}`));
    assert.deepEqual(read.v2.body, read.legacy.body);
    // A row already newer than the record being mirrored (a later save got
    // there first) is left alone, and the pool written for it is removed.
    db.prepare("UPDATE channels SET updated_at = ? WHERE public_code = ?").run(Date.now() + 3600000, first.code);
    const poolsBefore = [...env.BLOBS._store.keys()].sort();
    await shareChannel(env, ann, { ...edited, items: edited.items.slice(0, 4) }, { code: first.code });
    assert.equal(channelRow(db, first.code).pool_version, 2);
    assert.deepEqual([...env.BLOBS._store.keys()].sort(), poolsBefore, "no pool left behind");
    db.prepare("UPDATE channels SET updated_at = 0, legacy_hash = NULL WHERE public_code = ?").run(first.code);
    await shareChannel(env, ann, edited, { code: first.code });

    const like = (action) => call(env, "/api/channel/like", { method: "POST", json: { ...creds(ben), code: first.code, ...(action ? { action } : {}) } });
    assert.equal((await like()).body.likes, 1);
    assert.equal(channelRow(db, first.code).like_count, 1);
    assert.deepEqual(db.prepare("SELECT voter FROM likes WHERE target_type = 'channel'").all().map((r) => r.voter), [`acct:${benId}`]);
    assert.equal((await like("unlike")).body.likes, 0);
    assert.equal(channelRow(db, first.code).like_count, 0);
    const add = () => call(env, "/api/channel/added", { method: "POST", json: { ...creds(ben), code: first.code } });
    assert.equal((await add()).body.counted, true);
    assert.equal((await add()).body.counted, false);
    assert.equal(channelRow(db, first.code).add_count, 1, "once per account");

    await call(env, "/api/channel/unpublish", { method: "POST", json: { ...creds(ann), code: first.code } });
    assert.equal(channelRow(db, first.code).visibility, "unlisted");
    const unlisted = await legacyThenV2(env, () => call(env, `/api/channel/share?code=${first.code}`));
    assert.equal(unlisted.v2.body.published, false);
    assert.deepEqual(unlisted.v2.body, unlisted.legacy.body);
  });

  it("reads the legacy store for a channel whose row is behind it or whose episodes are not in R2", async () => {
    const { env, db, ann } = await channelsSetup();
    const shared = await shareChannel(env, ann, CH_FIXTURES.aired, { publish: true });
    env.BLOBS._hooks.beforePut = () => { throw new Error("R2 unavailable"); };
    const edited = { ...CH_FIXTURES.aired, name: "Oldies Edited", items: CH_FIXTURES.aired.items.slice(0, 5) };
    await shareChannel(env, ann, edited, { code: shared.code });
    env.BLOBS._hooks.beforePut = null;
    assert.equal(channelRow(db, shared.code).legacy_hash, null, "the row is marked behind");
    const got = await call(env, `/api/channel/share?code=${shared.code}`);
    assert.equal(got.body.channel.name, "Oldies Edited", "and the channel is read from the legacy store");
    assert.equal(got.body.channel.items.length, 5);
    await runBackfill(env, await adminCookie(env));
    assert.ok(channelRow(db, shared.code).legacy_hash, "the copy brings it up to date");
    assert.equal((await call(env, "/api/channel/directory")).body.channels[0].name, "Oldies Edited");

    // The pool object gone from R2: the legacy store answers.
    env.BLOBS._store.delete(channelRow(db, shared.code).pool_r2_key);
    const noPool = await legacyThenV2(env, () => call(env, `/api/channel/share?code=${shared.code}`));
    assert.deepEqual(noPool.v2.body, noPool.legacy.body);

    // No R2 bucket at all: rows are written, episodes are read from KV.
    const bare = await channelsSetup({ BLOBS: null });
    const code = (await shareChannel(bare.env, bare.ann, CH_FIXTURES.shuffled, { publish: true })).code;
    const row = channelRow(bare.db, code);
    assert.equal(row.pool_r2_key, null);
    assert.ok(row.legacy_hash);
    const read = await legacyThenV2(bare.env, () => call(bare.env, `/api/channel/share?code=${code}`));
    assert.deepEqual(read.v2.body, read.legacy.body);
    const bareCookie = await adminCookie(bare.env);
    await runBackfill(bare.env, bareCookie);
    assert.equal((await call(bare.env, "/admin/api/lists-backfill/status", { cookie: bareCookie })).body.channels.pools.skipped, 1);
    const dir = await legacyThenV2(bare.env, () => call(bare.env, "/api/channel/directory"));
    assert.deepEqual(dir.v2.body, dir.legacy.body);
  });

  it("an admin takedown reaches the rows, and says so when it cannot", async () => {
    const { env, db, ann, ben } = await channelsSetup();
    const cookie = await adminCookie(env);
    const a = await shareChannel(env, ann, CH_FIXTURES.aired, { publish: true });
    const b = await shareChannel(env, ann, CH_FIXTURES.rotating, { publish: true });
    await call(env, "/api/channel/like", { method: "POST", json: { ...creds(ben), code: b.code } });
    const moderate = (code, action) => call(env, "/admin/api/channel-moderate", { method: "POST", cookie, json: { code, action } });

    assert.equal((await moderate(a.code, "unlist")).body.ok, true);
    assert.equal(channelRow(db, a.code).visibility, "unlisted");

    const pool = channelRow(db, b.code).pool_r2_key;
    assert.equal((await moderate(b.code, "delete")).body.ok, true);
    const gone = channelRow(db, b.code);
    assert.ok(gone.deleted_at > 0);
    assert.equal(env.BLOBS._store.has(pool), false, "its pool is removed");
    assert.equal(db.prepare("SELECT count(*) AS n FROM likes WHERE target_id = ?").get(b.code).n, 0);
    assert.equal((await call(env, `/api/channel/share?code=${b.code}`)).status, 404);

    const c = await shareChannel(env, ann, CH_FIXTURES.shuffled, { publish: true });
    env.DB.failWhen((sql) => /UPDATE channels SET deleted_at/.test(sql));
    const failed = await moderate(c.code, "delete");
    env.DB.failWhen(null);
    assert.equal(failed.status, 500);
    assert.match(failed.body.error, /new tables/);
  });

  it("a signed-out install save stores a listed channel's lineup from v2", async () => {
    const { env, ann } = await channelsSetup();
    const shared = await shareChannel(env, ann, CH_FIXTURES.aired, { publish: true });
    // Behind every route's back, so the two stores differ: the legacy record
    // loses all but one episode, v2 keeps the lineup it was given.
    const key = `channelshare:${shared.code}`;
    const rec = JSON.parse(env.CONFIGS._store.get(key));
    env.CONFIGS._store.set(key, JSON.stringify({ ...rec, channel: { ...rec.channel, items: rec.channel.items.slice(0, 1) } }));
    const row = "channel:v1:" + JSON.stringify({ channelId: "ch-local-9", shareCode: shared.code, catalogOnly: true, name: "Oldies", items: [] });
    const saveOnce = async () => {
      const r = await call(env, "/api/save", { method: "POST", json: { entries: [{ id: "r0", name: "Oldies", type: "series", url: row }] } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return JSON.parse(JSON.parse(env.CONFIGS._store.get("cfg:" + r.body.id)).entries[0].url.slice("channel:v1:".length));
    };
    const { legacy, v2 } = await legacyThenV2(env, saveOnce);
    assert.equal(legacy.items.length, 1);
    assert.equal(v2.items.length, CH_FIXTURES.aired.items.length);
    assert.equal(v2.shareCode, shared.code);
  });

  it("shares, reads and likes carry on as before when migration 0016 is not applied", async () => {
    const { env, ann, ben } = await channelsSetup();
    env.DB._db.exec("DROP TABLE channels;");
    const shared = await shareChannel(env, ann, CH_FIXTURES.aired, { publish: true });
    assert.equal((await call(env, `/api/channel/share?code=${shared.code}`)).status, 200);
    assert.equal((await call(env, "/api/channel/like", { method: "POST", json: { ...creds(ben), code: shared.code } })).body.likes, 1);
    assert.equal((await call(env, "/api/channel/directory")).body.channels.length, 1);
  });

  it("lets the copy use R2 only for channel pools", () => {
    const sb = loadBackfillFns();
    const r2 = makeR2();
    const menv = sb.listsBackfillEnv({ DB: makeD1(), CONFIGS: makeKv(), BLOBS: r2 }, { ops: 0 });
    assert.throws(() => menv.BLOBS.put("img/bp/tt1.jpg", "x"), /refusing/);
    assert.throws(() => menv.BLOBS.delete("backups/d1.sql"), /refusing/);
    assert.equal(typeof menv.BLOBS.list, "undefined");
    assert.doesNotThrow(() => menv.BLOBS.put("channels/ABC/1.json", "[]"));
  });
});

// --- P3b-9: v2 as the only store (FF_V2_LISTS_ONLY) --------------------------

const LEGACY_LIST_PREFIXES = ["creatorlist:", "creatorlistorder:", "creatorliststamp:", "creatorlistdeleted:", "listlikevoters:",
  "extlikevoters:", "externallike:", "index:publicchannels", "channelshare:", "channellikevoters:", "creatorchannel:", "channeladdvoters:"];

// Everything written to the legacy store from here on: KV puts under the
// legacy list keys, and D1 inserts or updates on the legacy list tables.
// (Removing a deleted list's leftovers is allowed: that writes nothing.)
function watchLegacyWrites(env) {
  const writes = [];
  env.CONFIGS._hooks.beforePut = async (k) => {
    if (LEGACY_LIST_PREFIXES.some((p) => String(k).startsWith(p))) writes.push("kv " + k);
  };
  env.DB.failWhen((sql) => {
    if (/^\s*(INSERT|UPDATE|REPLACE)/i.test(sql) && /\b(creator_lists|list_likes|lists_fts|list_tombstones)\b/.test(sql)) writes.push("d1 " + sql.trim().slice(0, 70));
    return false;
  });
  return writes;
}

// A clock that moves only when told: both runs of the script below see the
// same times, so their answers can be compared exactly.
function frozenClock(start = 1780000000000) {
  const real = Date.now;
  let t = start;
  Date.now = () => t;
  return { tick: (ms = 1000) => { t += ms; }, restore: () => { Date.now = real; } };
}

async function onlyModeSetup(flags) {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1(), FF_V2_LISTS_READ: "1" });
  const users = {
    ann: await createUser(env, "annonly"),
    ben: await createUser(env, "benonly"),
    cat: await createUser(env, "catonly"),
  };
  // The copy has run, as it must before either switch.
  await runBackfill(env, await adminCookie(env));
  const custom = "customlist:v1:" + JSON.stringify({ creatorOwner: "annonly", creatorSlug: "alpha", items: [] });
  env.CONFIGS._store.set("cfg:onlycat0001", JSON.stringify({ entries: [{ id: "mine", name: "Mine", type: "movie", url: custom }] }));
  Object.assign(env, flags);
  return { env, db: env.DB._db, ...users };
}

const ONLY_ALPHA = [
  { id: "tt0137523", type: "movie", name: "Fight Club", year: "1999" },
  { id: "62085", type: "episode", showId: "1396", showTitle: "Breaking Bad", name: "Pilot", seasonNum: 1, episodeNum: 1 },
  { id: "tt0903747", type: "series", name: "Breaking Bad" },
];

// The same requests, in the same order, against one env; every answer.
async function onlyModeScript(env, { ann, ben, cat }, clock) {
  const out = [];
  const step = async (label, fn) => {
    clock.tick();
    const r = await fn();
    out.push([label, r.status, r.body]);
    return r;
  };
  const post = (p, json) => call(env, p, { method: "POST", json });
  const save = (u, body) => post("/api/creator/lists/save", { ...creds(u), ...body });
  const read = async (label) => {
    await step(`${label}: dashboard`, () => dashboard(env, ann));
    await step(`${label}: items`, () => post("/api/creator/lists/items", { ...creds(ann), slugs: ["alpha", "beta", "gamma", "watchlist"] }));
    await step(`${label}: page`, () => call(env, "/lists/annonly/alpha.json"));
    await step(`${label}: directory`, () => call(env, "/lists/public.json"));
    await step(`${label}: search`, () => call(env, "/api/search-published-lists?q=alpha"));
    await step(`${label}: catalog`, () => call(env, "/onlycat0001/catalog/movie/mine.json"));
    await step(`${label}: meta`, () => post("/api/creator/sync/meta", creds(ann)));
    await step(`${label}: sync load`, () => post("/api/creator/sync/load", creds(ann)));
  };

  const first = await step("save alpha", () => save(ann, { name: "Alpha", type: "mixed", visibility: "public", items: ONLY_ALPHA }));
  await step("save beta", () => save(ann, {
    name: "Beta", type: "series", visibility: "private", items: [{ id: "tt0903747", type: "series" }],
    sourceUrl: "https://mdblist.com/lists/someone/good-shows", synced: true, lastSyncedAt: 1700000000000, baseItemIds: ["tt0903747"],
  }));
  await step("save gamma", () => save(ann, { name: "Gamma", type: "movie", visibility: "public", items: [{ id: "tt0068646", type: "movie" }] }));
  await read("after saves");

  await step("edit alpha", () => save(ann, {
    slug: "alpha", name: "Alpha Prime", type: "mixed", visibility: "public", expectedUpdatedAt: first.body.updatedAt,
    items: [ONLY_ALPHA[2], ONLY_ALPHA[0], { id: "tt0111161", type: "movie", name: "Shawshank" }],
  }));
  await step("stale edit", () => save(ann, { slug: "alpha", name: "Old", type: "mixed", visibility: "public", expectedUpdatedAt: first.body.updatedAt, items: [] }));
  await step("reorder", () => post("/api/creator/lists/reorder", { ...creds(ann), order: ["gamma", "continue-watching", "alpha", "beta"] }));
  const like = (u, slug, action) => post("/api/lists/like", { ...creds(u), username: "annonly", slug, ...(action ? { action } : {}) });
  await step("like gamma (ben)", () => like(ben, "gamma"));
  await step("like gamma (cat)", () => like(cat, "gamma"));
  await step("like alpha (ben)", () => like(ben, "alpha"));
  await step("unlike alpha (ben)", () => like(ben, "alpha", "unlike"));
  await step("like beta, private (ben)", () => like(ben, "beta"));
  const ext = (u, action) => post("/api/lists/like-external", { ...creds(u), url: "https://mdblist.com/lists/someone/good-shows", ...(action ? { action } : {}) });
  await step("external like (ben)", () => ext(ben));
  await step("external like (cat)", () => ext(cat));
  await step("external unlike (ben)", () => ext(ben, "unlike"));
  await read("after edits");

  await step("delete gamma", () => post("/api/creator/lists/delete", { ...creds(ann), slug: "gamma" }));
  await step("gamma again", () => save(ann, { name: "Gamma", type: "movie", visibility: "public", items: [{ id: "tt0068646", type: "movie" }] }));
  const track = (watchlist) => post("/api/creator/sync/save-tracking", { ...creds(ann), watchlist });
  await step("watchlist", () => track([{ id: "tt0000071", type: "movie" }, { id: "tt0000072", type: "movie" }]));
  await step("watchlist again", () => track([{ id: "tt0000071", type: "movie" }, { id: "tt0000072", type: "movie" }, { id: "tt0000073", type: "movie" }]));
  const config = Buffer.from(JSON.stringify({ entries: [], track: true, trackCreatorName: ann.creatorName, trackCreatorKey: ann.creatorKey })).toString("base64url");
  await step("watched one on the Watchlist", () => call(env, `/${config}/subtitles/movie/tt0000072.json`));
  await read("after deletes and the Watchlist");

  const shared = await step("share a channel", () => post("/api/channel/share", { ...creds(ann), channel: CH_FIXTURES.rotating, publish: true }));
  const code = shared.body.code;
  await step("like the channel (ben)", () => post("/api/channel/like", { ...creds(ben), code }));
  await step("add the channel (ben)", () => post("/api/channel/added", { ...creds(ben), code }));
  await step("add the channel again (ben)", () => post("/api/channel/added", { ...creds(ben), code }));
  await step("open the channel", () => call(env, `/api/channel/share?code=${code}`));
  await step("open it by address", () => call(env, "/channels/annonly/night-shift.json"));
  await step("explore channels", () => call(env, "/api/channel/directory?sort=liked"));
  await step("my channels", () => post("/api/channel/mine", creds(ann)));
  await step("unpublish", () => post("/api/channel/unpublish", { ...creds(ann), code }));
  await step("explore channels after", () => call(env, "/api/channel/directory"));
  await read("at the end");
  // Codes are random: compare them by their place.
  return JSON.parse(JSON.stringify(out).split(code).join("CHANNEL-CODE"));
}

describe("P3b-9: v2 as the only store (FF_V2_LISTS_ONLY)", () => {
  it("answers every list, like and channel request as before, and writes nothing to the legacy store", async () => {
    let clock = frozenClock();
    let dual;
    let dualWrites;
    try {
      const base = await onlyModeSetup({});
      dualWrites = watchLegacyWrites(base.env);
      dual = await onlyModeScript(base.env, base, clock);
    } finally {
      clock.restore();
    }
    clock = frozenClock();
    let only;
    let onlyWrites;
    let onlyEnv;
    try {
      const o = await onlyModeSetup({ FF_V2_LISTS_ONLY: "1" });
      onlyEnv = o;
      onlyWrites = watchLegacyWrites(o.env);
      only = await onlyModeScript(o.env, o, clock);
    } finally {
      clock.restore();
    }
    assert.ok(dualWrites.length > 20, "the watcher sees the legacy writes the routes make without the flag");
    assert.deepEqual(onlyWrites, [], "with the flag, nothing is written to the legacy store");
    for (let i = 0; i < dual.length; i++) {
      assert.deepEqual(only[i], dual[i], `step "${dual[i][0]}"`);
    }
    assert.equal(only.length, dual.length);
    // And the answers are the real thing, not two empty ones.
    const byLabel = new Map(only.map(([label, status, body]) => [label, { status, body }]));
    assert.equal(byLabel.get("stale edit").status, 409);
    assert.equal(byLabel.get("like beta, private (ben)").status, 404);
    assert.equal(byLabel.get("like gamma (cat)").body.likes, 2);
    assert.equal(byLabel.get("external unlike (ben)").body.likes, 1);
    assert.equal(byLabel.get("add the channel again (ben)").body.counted, false);
    const end = byLabel.get("at the end: dashboard").body;
    assert.deepEqual(end.lists.map((l) => [l.slug, l.likes]), [["watchlist", 0], ["alpha", 0], ["beta", 0], ["gamma", 0]], "a new Watchlist goes first; gamma, made again, starts with no likes");
    assert.deepEqual(end.lists.find((l) => l.slug === "watchlist").items.map((i) => i.id), ["tt0000071", "tt0000073"]);
    assert.equal(end.lists.find((l) => l.slug === "beta").sourceUrl, "https://mdblist.com/lists/someone/good-shows");
    assert.equal(byLabel.get("at the end: catalog").body.metas.length, 2);
    assert.deepEqual(byLabel.get("at the end: sync load").body.data.watchlist.map((i) => i.id), ["tt0000071", "tt0000073"],
      "a browser loading the account sees the title the ping took off");
    assert.ok(onlyEnv.db.prepare("SELECT count(*) AS n FROM lists").get().n >= 4);
  });

  it("an account reset leaves the other browsers a tombstone, and deleting the account removes everything", async () => {
    const { env, db, ann } = await onlyModeSetup({});
    const annId = db.prepare("SELECT id FROM accounts WHERE username = 'annonly'").get().id;
    // One list from before the switch (so the legacy store has it too), one after.
    await saveList(env, ann, { name: "Alpha", type: "movie", visibility: "public", items: [{ id: "tt0068646", type: "movie" }] });
    await dashboard(env, ann);
    env.FF_V2_LISTS_ONLY = "1";
    await saveList(env, ann, { name: "Beta", type: "movie", visibility: "public", items: [{ id: "tt0068646", type: "movie" }] });
    const writes = watchLegacyWrites(env);
    const reset = await call(env, "/api/creator/account/reset", { method: "POST", json: { ...creds(ann), confirm: "RESET" } });
    assert.equal(reset.body.ok, true, JSON.stringify(reset.body));
    assert.deepEqual(writes, [], "nothing written to the legacy store");
    const after = await dashboard(env, ann);
    assert.deepEqual(after.body.lists, []);
    assert.deepEqual(after.body.deletedSlugs.slice().sort(), ["alpha", "beta"], "every browser learns to drop them");
    assert.equal(db.prepare("SELECT count(*) AS n FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.owner_account_id = ?").get(annId).n, 0, "and their items are gone");
    await saveList(env, ann, { name: "Alpha", type: "movie", visibility: "private", items: [] });
    assert.deepEqual((await dashboard(env, ann)).body.deletedSlugs, ["beta"], "a list made again is no longer deleted");

    const gone = await call(env, "/api/creator/delete-account", { method: "POST", json: { ...creds(ann), confirm: "DELETE" } });
    assert.equal(gone.body.ok, true, JSON.stringify(gone.body));
    assert.equal(db.prepare("SELECT count(*) AS n FROM lists WHERE owner_account_id = ?").get(annId).n, 0);
  });

  it("works for an account made after the switch, and on its own without FF_V2_LISTS_READ", async () => {
    const { env } = await onlyModeSetup({ FF_V2_LISTS_ONLY: "1" });
    delete env.FF_V2_LISTS_READ;
    const dan = await createUser(env, "danonly");
    const slug = await saveList(env, dan, { name: "Fresh", type: "movie", visibility: "public", items: [{ id: "tt0068646", type: "movie" }] });
    const writes = watchLegacyWrites(env);
    const dash = await dashboard(env, dan);
    assert.deepEqual(dash.body.lists.map((l) => l.slug), [slug], "read from v2, and not copied over from the empty legacy store");
    assert.equal((await call(env, `/lists/danonly/${slug}.json`)).status, 200);
    assert.equal((await call(env, "/lists/public.json")).body.lists.length, 1);
    assert.deepEqual(writes, []);
  });

  it("stops the copy, and points the admin tools at v2", async () => {
    const { env, db, ann, ben } = await onlyModeSetup({ FF_V2_LISTS_ONLY: "1" });
    const cookie = await adminCookie(env);
    await saveList(env, ann, { name: "Alpha", type: "movie", visibility: "public", items: [{ id: "tt0068646", type: "movie" }] });
    await saveList(env, ann, { name: "Beta", type: "movie", visibility: "private", items: [] });
    const code = (await shareChannel(env, ben, CH_FIXTURES.aired, { publish: true })).code;

    const step = await call(env, "/admin/api/lists-backfill/step", { method: "POST", cookie, json: {} });
    assert.equal(step.status, 409);
    assert.match(step.body.error, /FF_V2_LISTS_ONLY/);
    assert.equal((await call(env, "/admin/api/lists-backfill/status", { cookie })).body.listsOnly, true);
    assert.equal((await call(env, "/admin/api/migrate-d1", { method: "POST", cookie, json: {} })).status, 409);

    const browse = await call(env, "/admin/api/creator-lists?username=annonly", { cookie });
    assert.deepEqual(browse.body.lists.map((l) => [l.slug, l.visibility]), [["alpha", "public"], ["beta", "private"]]);
    const removed = await call(env, "/admin/api/delete-creator-list", { method: "POST", cookie, json: { username: "annonly", slugs: ["beta"] } });
    assert.deepEqual([removed.body.deleted, removed.body.remaining], [["beta"], 1]);

    db.prepare("DELETE FROM lists_fts2").run();
    const rebuilt = await call(env, "/admin/api/rebuild-search-index", { method: "POST", cookie });
    assert.equal(rebuilt.body.v2Count, 1);
    assert.equal((await call(env, "/api/search-published-lists?q=alpha")).body.lists.length, 1, "search works again");

    const all = await call(env, "/admin/api/published-channels?scope=all", { cookie });
    assert.deepEqual(all.body.channels.map((c) => [c.code, c.listed]), [[code, true]]);
    const other = (await shareChannel(env, ben, CH_FIXTURES.shuffled, { publish: true })).code;
    assert.equal((await call(env, "/admin/api/channel-moderate", { method: "POST", cookie, json: { code: other, action: "unlist" } })).body.ok, true);
    assert.equal(channelRow(db, other).visibility, "unlisted");
    assert.equal((await call(env, "/admin/api/channel-moderate", { method: "POST", cookie, json: { code, action: "delete" } })).body.ok, true);
    assert.ok(channelRow(db, code).deleted_at > 0);
  });

  it("answers an error when v2 cannot, and never falls back to the stale legacy store", async () => {
    const { env, ann } = await onlyModeSetup({ FF_V2_LISTS_ONLY: "1" });
    // What the legacy store still holds from before: it must not reappear.
    env.CONFIGS._store.set("creatorlist:annonly:ghost", JSON.stringify({ name: "Ghost", slug: "ghost", type: "movie", visibility: "public", items: [{ id: "tt1" }] }));
    assert.equal((await call(env, "/lists/annonly/ghost.json")).status, 404, "a list only the legacy store has is gone");
    const ghostRows = [
      { id: "g1", name: "Ghost", type: "movie", url: "customlist:v1:" + JSON.stringify({ creatorOwner: "annonly", creatorSlug: "ghost", items: [] }) },
      { id: "g2", name: "Ghost", type: "movie", url: "https://mylistsaddon.com/lists/annonly/ghost" },
    ];
    env.CONFIGS._store.set("cfg:onlyghost01", JSON.stringify({ entries: ghostRows }));
    for (const row of ["g1", "g2"]) {
      const cat = await call(env, `/onlyghost01/catalog/movie/${row}.json`);
      assert.deepEqual(cat.body.metas || [], [], `catalog row ${row} does not read the legacy record`);
    }
    env.DB.failWhen((sql) => /FROM lists l JOIN accounts/.test(sql));
    const dir = await call(env, "/lists/public.json");
    env.DB.failWhen(null);
    assert.equal(dir.status, 503, "the directory says it is down rather than serving the legacy one");
    assert.deepEqual((await dashboard(env, ann)).body.lists, []);

    env.DB.failWhen((sql) => /FROM lists WHERE owner_account_id/.test(sql));
    const down = await dashboard(env, ann);
    env.DB.failWhen(null);
    assert.equal(down.status, 503);

    env.DB.failWhen((sql) => /INSERT INTO lists \(/.test(sql));
    const failed = await call(env, "/api/creator/lists/save", { method: "POST", json: { ...creds(ann), name: "Nope", type: "movie", visibility: "private", items: [] } });
    env.DB.failWhen(null);
    assert.equal(failed.status, 503, "a save that did not land says so");
    assert.equal(env.CONFIGS._store.has("creatorlist:annonly:nope"), false);
    await saveList(env, ann, { name: "Nope", type: "movie", visibility: "private", items: [] });

    const bare = await onlyModeSetup({ FF_V2_LISTS_ONLY: "1", BLOBS: null });
    const share = await call(bare.env, "/api/channel/share", { method: "POST", json: { ...creds(bare.ann), channel: CH_FIXTURES.aired } });
    assert.equal(share.status, 503, "a channel's episodes need the R2 bucket");
  });

  it("counts puts to the legacy list keys, and there are none with the flag", async () => {
    const run = async (flags) => {
      const points = [];
      const { env, ann } = await onlyModeSetup({ ...flags, ANALYTICS: { writeDataPoint: (p) => points.push(p) } });
      await saveList(env, ann, { name: "Counted", type: "movie", visibility: "public", items: [{ id: "tt0068646", type: "movie" }] });
      return points[points.length - 1].doubles[7];
    };
    assert.ok((await run({})) > 0, "a save without the flag puts legacy keys, and they are counted");
    assert.equal(await run({ FF_V2_LISTS_ONLY: "1" }), 0);
  });

  it("saves a list of 10,000 titles in one request", async () => {
    const { env, db, ann } = await onlyModeSetup({ FF_V2_LISTS_ONLY: "1" });
    const writes = watchLegacyWrites(env);
    const items = Array.from({ length: 10000 }, (_, i) => ({ id: `tt${3000000 + i}`, type: "movie" }));
    let queries = 0;
    env.DB.failWhen((sql) => {
      queries++;
      if (/^\s*(INSERT|UPDATE|REPLACE)/i.test(sql) && /\b(creator_lists|list_likes|lists_fts|list_tombstones)\b/.test(sql)) writes.push("d1 " + sql);
      return false;
    });
    const slug = await saveList(env, ann, { name: "Everything", type: "movie", visibility: "private", items });
    env.DB.failWhen(null);
    assert.ok(queries < 200, `${queries} D1 queries`);
    assert.deepEqual(writes, []);
    assert.equal(db.prepare("SELECT item_count FROM lists WHERE slug = ?").get(slug).item_count, 10000);
  });
});

describe("P3b-9: fixes to the P3b-7 mirror found on the way", () => {
  it("a list made again at a deleted list's address starts with no likes", async () => {
    const { env, db, ann, ben } = await bridgeSetup();
    const slug = await saveList(env, ann, { name: "Again", type: "movie", visibility: "public", items: [{ id: "tt0068646", type: "movie" }] });
    await dashboard(env, ann);
    await call(env, "/api/lists/like", { method: "POST", json: { ...creds(ben), username: "annbridge", slug } });
    await call(env, "/api/creator/lists/delete", { method: "POST", json: { ...creds(ann), slug } });
    await saveList(env, ann, { name: "Again", type: "movie", visibility: "public", items: [] });
    const row = db.prepare("SELECT public_id, like_count FROM lists WHERE legacy_id = ?").get(`c:annbridge:${slug}`);
    assert.equal(row.like_count, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM likes WHERE target_id = ?").get(row.public_id).n, 0);
    const { legacy, v2 } = await legacyThenV2(env, () => dashboard(env, ann));
    assert.deepEqual(v2.body, legacy.body);
  });

  it("a playback ping that takes a title off the Watchlist reaches v2, and a new Watchlist goes first", async () => {
    const { env, db, ann } = await bridgeSetup();
    await saveList(env, ann, { name: "Other", type: "movie", visibility: "private", items: [] });
    await dashboard(env, ann); // the account is on v2 from here
    await call(env, "/api/creator/sync/save-tracking", { method: "POST", json: { ...creds(ann), watchlist: [{ id: "tt0000071", type: "movie" }, { id: "tt0000072", type: "movie" }] } });
    const config = Buffer.from(JSON.stringify({ entries: [], track: true, trackCreatorName: ann.creatorName, trackCreatorKey: ann.creatorKey })).toString("base64url");
    await call(env, `/${config}/subtitles/movie/tt0000071.json`);
    assert.equal(db.prepare("SELECT item_count FROM lists WHERE legacy_id = 'c:annbridge:watchlist'").get().item_count, 1);
    const { legacy, v2 } = await legacyThenV2(env, () => dashboard(env, ann));
    assert.deepEqual(v2.body.order, legacy.body.order);
    assert.equal(v2.body.order[0], "watchlist");
    assert.deepEqual(v2.body, legacy.body);
  });
});
