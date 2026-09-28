import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeD1 } from "./harness.mjs";

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
