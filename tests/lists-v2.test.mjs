import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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
