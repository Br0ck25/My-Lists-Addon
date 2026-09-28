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
