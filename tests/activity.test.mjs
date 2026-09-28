import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { makeD1 } from "./harness.mjs";

// Phase 3c: watch history and progress in their own database, DB_ACTIVITY
// (migrations/activity/, schema_activity.sql, 36_activity-db.js).

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
const MIGRATION_DIR = "migrations/activity";
const MIGRATIONS = fs.readdirSync(path.join(REPO_ROOT, MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();

function loadActivity() {
  const errors = [];
  const sandbox = { console: { ...console, error: (...a) => errors.push(a.join(" ")) } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read("36_activity-db.js"), sandbox, { filename: "36_activity-db.js" });
  sandbox.errors = errors;
  return sandbox;
}

function shape(db) {
  const objects = db.prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  return objects.map((o) => {
    const cols = o.type === "table"
      ? db.prepare(`PRAGMA table_info(${o.name})`).all().map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value}:${c.pk}`)
      : db.prepare(`PRAGMA index_info(${o.name})`).all().map((c) => c.name);
    return `${o.type} ${o.name} on ${o.tbl_name} (${cols.join(", ")})`;
  });
}

describe("P3c-1: the activity database schema", () => {
  it("schema_activity.sql is the same as running every activity migration in order", () => {
    const fresh = new DatabaseSync(":memory:");
    fresh.exec(read("schema_activity.sql"));
    const migrated = new DatabaseSync(":memory:");
    for (const f of MIGRATIONS) migrated.exec(read(`${MIGRATION_DIR}/${f}`));
    assert.deepEqual(shape(fresh), shape(migrated));
  });

  it("records itself in its own ledger and applies twice without error", () => {
    const db = makeD1({ schema: "activity" })._db;
    db.exec("DELETE FROM schema_migrations");
    db.exec(read(`${MIGRATION_DIR}/A0001_activity.sql`));
    db.exec(read(`${MIGRATION_DIR}/A0001_activity.sql`));
    const row = db.prepare("SELECT applied_at FROM schema_migrations WHERE version = 'A0001'").get();
    assert.ok(row && row.applied_at > 0);
  });

  it("can be pasted into the D1 Console as it is: no semicolon or apostrophe in a comment", () => {
    for (const f of MIGRATIONS) {
      const bad = read(`${MIGRATION_DIR}/${f}`).split("\n").filter((l) => l.trim().startsWith("--") && /[;']/.test(l));
      assert.deepEqual(bad, [], f);
    }
  });

  it("keeps its migrations apart from the main database", () => {
    // The main drift test runs every migrations/*.sql against schema.sql; an
    // activity migration there would put these tables in the wrong database.
    const main = fs.readdirSync(path.join(REPO_ROOT, "migrations")).filter((f) => f.endsWith(".sql"));
    assert.ok(main.every((f) => /^\d{4}/.test(f)), "only numbered migrations in migrations/");
    assert.ok(MIGRATIONS.every((f) => /^A\d{4}_/.test(f)), "activity migrations start with A");
    assert.doesNotMatch(read("schema.sql"), /watch_events|show_progress|user_media_state/);
  });

  it("stores one play once: the same dedupe key is refused", () => {
    const db = makeD1({ schema: "activity" })._db;
    const ins = db.prepare("INSERT OR IGNORE INTO watch_events (account_id, media_id, season, episode, watched_at, source, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)");
    ins.run(1, 10, 1, 2, 1000, "ping", "1:10:1:2:0");
    ins.run(1, 10, 1, 2, 1500, "webhook", "1:10:1:2:0");
    ins.run(1, 20, null, null, 1500, "web", "1:20:::0");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM watch_events").get().n, 2);
  });

  it("show_progress takes one row per account and show, and only known statuses", () => {
    const db = makeD1({ schema: "activity" })._db;
    const up = db.prepare(`INSERT INTO show_progress (account_id, media_id, last_season, last_episode, last_watched_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (account_id, media_id) DO UPDATE SET last_season = excluded.last_season,
      last_episode = excluded.last_episode, last_watched_at = excluded.last_watched_at, updated_at = excluded.updated_at`);
    up.run(1, 10, 1, 1, 100, 100);
    up.run(1, 10, 1, 2, 200, 200);
    const row = db.prepare("SELECT * FROM show_progress").get();
    assert.equal(row.last_episode, 2);
    assert.equal(row.status, "watching");
    assert.throws(() => db.exec("UPDATE show_progress SET status = 'paused'"));
  });

  it("the history and progress reads use their indexes", () => {
    const db = makeD1({ schema: "activity" })._db;
    const plan = (sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(" | ");
    assert.match(plan("SELECT * FROM watch_events WHERE account_id = 1 ORDER BY watched_at DESC LIMIT 50"), /idx_we_account_time/);
    assert.match(plan("SELECT * FROM watch_events WHERE account_id = 1 AND media_id = 5 AND season = 1 AND episode = 2"), /idx_we_account_media/);
    assert.match(plan("SELECT * FROM show_progress WHERE account_id = 1 ORDER BY last_watched_at DESC LIMIT 200"), /idx_sp_account_recent/);
  });
});

describe("P3c-1: activityDb and shardFor", () => {
  it("returns null without the binding, so callers keep the legacy store", () => {
    const sb = loadActivity();
    assert.equal(sb.activityDb({}, 1), null);
    assert.equal(sb.activityDbs({}).length, 0);
  });

  it("uses DB_ACTIVITY for everyone while there is one database", () => {
    const sb = loadActivity();
    const env = { DB_ACTIVITY: { name: "a0" } };
    for (const id of [1, 2, 3, 999999]) assert.equal(sb.activityDb(env, id), env.DB_ACTIVITY);
    assert.equal(sb.shardFor(env, 7), 0);
  });

  it("routes by account id modulo the shard count once every shard is bound", () => {
    const sb = loadActivity();
    const env = { DB_ACTIVITY: { n: 0 }, DB_ACTIVITY_1: { n: 1 }, DB_ACTIVITY_2: { n: 2 }, ACTIVITY_SHARD_COUNT: "3" };
    assert.equal(sb.activityDb(env, 3).n, 0);
    assert.equal(sb.activityDb(env, 4).n, 1);
    assert.equal(sb.activityDb(env, 5).n, 2);
    assert.equal(sb.activityDb(env, 4), sb.activityDb(env, 4), "the same account always lands in the same place");
    assert.equal(sb.activityDbs(env).length, 3);
    assert.throws(() => sb.shardFor(env, "not-an-id"));
  });

  it("ignores a shard count whose databases are not bound, and says so", () => {
    const sb = loadActivity();
    const env = { DB_ACTIVITY: { n: 0 }, DB_ACTIVITY_1: { n: 1 }, ACTIVITY_SHARD_COUNT: "3" };
    assert.equal(sb.activityDb(env, 5).n, 0);
    assert.equal(sb.activityDbs(env).length, 1);
    assert.ok(sb.errors.some((e) => e.includes("DB_ACTIVITY_2")));
  });

  it("activitySchemaReady is true only once A0001 is applied", async () => {
    const sb = loadActivity();
    const ready = makeD1({ schema: "activity" });
    assert.equal(await sb.activitySchemaReady(ready), true);
    const empty = makeD1({ schema: "activity" });
    empty._db.exec("DELETE FROM schema_migrations");
    assert.equal(await sb.activitySchemaReady(empty), false);
    assert.equal(await sb.activitySchemaReady(null), false);
  });
});

// --- P3c-2: migrations/0017_show_schedule.sql, in the main database ----------

const MIGRATION_0017 = read("migrations/0017_show_schedule.sql");

function mainDb() {
  const db = makeD1()._db;
  db.exec("INSERT INTO accounts (id, username, display_name, key_hash, created_at) VALUES (1, 'ann', 'Ann', 'h', 0)");
  db.exec("INSERT INTO media (id, kind, tmdb_id, created_at, updated_at) VALUES (10, 'series', 1399, 0, 0), (20, 'movie', 603, 0, 0)");
  return db;
}

describe("P3c-2: the show schedule, recommendations and daily title counts", () => {
  it("records itself in the ledger and applies twice without error", () => {
    const db = makeD1()._db;
    db.exec("DELETE FROM schema_migrations WHERE version = '0017'");
    db.exec(MIGRATION_0017);
    db.exec(MIGRATION_0017);
    const row = db.prepare("SELECT applied_at FROM schema_migrations WHERE version = '0017'").get();
    assert.ok(row && row.applied_at > 0);
  });

  it("can be pasted into the D1 Console as it is: no semicolon or apostrophe in a comment", () => {
    const bad = MIGRATION_0017.split("\n").filter((l) => l.trim().startsWith("--") && /[;']/.test(l));
    assert.deepEqual(bad, []);
  });

  it("the schema check knows every table and index it adds", () => {
    const names = [...MIGRATION_0017.matchAll(/CREATE (?:TABLE|INDEX) IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    const sb = { console };
    vm.createContext(sb);
    vm.runInContext(`${read("00_constants.js")}\nglobalThis.__m = D1_SCHEMA_MANIFEST;`, sb);
    const listed = sb.__m.filter((e) => e.migration === "0017").map((e) => e.name);
    assert.deepEqual([...listed].sort(), [...names].sort());
  });

  it("finds the shows due for a refresh through its index, skipping shows nobody watches", () => {
    const db = mainDb();
    db.exec("INSERT INTO media (id, kind, created_at, updated_at) VALUES (11, 'series', 0, 0)");
    db.exec("INSERT INTO show_schedule (media_id, watcher_count, next_check_at) VALUES (10, 3, 100), (11, 0, 50)");
    const sql = "SELECT media_id FROM show_schedule WHERE next_check_at <= ? AND watcher_count > 0 ORDER BY next_check_at LIMIT 500";
    assert.deepEqual(db.prepare(sql).all(1000).map((r) => r.media_id), [10]);
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1000).map((r) => r.detail).join(" | ");
    assert.match(plan, /idx_show_schedule_due/);
  });

  it("keeps one recommendation per rank, only for movies and series, and drops them with the account", () => {
    const db = mainDb();
    const ins = db.prepare("INSERT INTO account_recommendations (account_id, kind, rank, media_id, built_at) VALUES (?, ?, ?, ?, 0)");
    ins.run(1, "movie", 0, 20);
    ins.run(1, "series", 0, 10);
    assert.throws(() => ins.run(1, "movie", 0, 10), /UNIQUE|PRIMARY/);
    assert.throws(() => ins.run(1, "tv", 1, 10), /CHECK/);
    db.exec("DELETE FROM accounts WHERE id = 1");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM account_recommendations").get().n, 0);
  });

  it("counts a title once per day and event, and reads a day's top titles through its index", () => {
    const db = mainDb();
    const bump = db.prepare(`INSERT INTO title_daily_stats (day, event_type, media_id, n) VALUES (?, ?, ?, 1)
      ON CONFLICT (day, event_type, media_id) DO UPDATE SET n = n + 1`);
    bump.run("2026-09-28", "watched", 10);
    bump.run("2026-09-28", "watched", 10);
    bump.run("2026-09-28", "watched", 20);
    const top = "SELECT media_id, n FROM title_daily_stats WHERE event_type = ? AND day = ? ORDER BY n DESC LIMIT 20";
    assert.deepEqual(db.prepare(top).all("watched", "2026-09-28").map((r) => [r.media_id, r.n]), [[10, 2], [20, 1]]);
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${top}`).all("watched", "2026-09-28").map((r) => r.detail).join(" | ");
    assert.match(plan, /idx_title_daily_stats_top/);
    assert.doesNotMatch(plan, /TEMP B-TREE/, "no sort step: the index gives the order");
  });

  it("a title removed from media takes its schedule, recommendations and counts with it", () => {
    const db = mainDb();
    db.exec("INSERT INTO show_schedule (media_id, watcher_count, next_check_at) VALUES (10, 1, 0)");
    db.exec("INSERT INTO account_recommendations (account_id, kind, rank, media_id, built_at) VALUES (1, 'series', 0, 10, 0)");
    db.exec("INSERT INTO title_daily_stats (day, event_type, media_id, n) VALUES ('2026-09-28', 'watched', 10, 4)");
    db.exec("DELETE FROM media WHERE id = 10");
    for (const t of ["show_schedule", "account_recommendations", "title_daily_stats"]) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, t);
    }
  });
});
