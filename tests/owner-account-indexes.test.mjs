// Audit DB-04 (2026-11-10): queries that filter lists/channels by owner only
// (account deletion and its foreign-key cascade) could not use the partial
// owner indexes and read every list and channel. Migration 0027 adds plain
// owner indexes.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const QUERIES = [
  "SELECT id FROM lists WHERE owner_account_id = ?",
  "SELECT id, public_code FROM channels WHERE owner_account_id = ? AND visibility = 'private'",
  "UPDATE channels SET owner_account_id = NULL WHERE owner_account_id = ?",
  "DELETE FROM accounts WHERE id = ?",
];

function fresh() {
  const db = new DatabaseSync(":memory:");
  db.exec(read("schema.sql"));
  return db;
}
function populated(db) {
  db.exec("BEGIN");
  const acc = db.prepare("INSERT INTO accounts (id, username, display_name, key_hash, created_at) VALUES (?, ?, 'N', ?, 1)");
  for (let a = 1; a <= 50; a++) acc.run(a, "u" + a, "h" + a);
  db.exec("COMMIT");
  const lists = db.prepare("INSERT INTO lists (id, public_id, owner_account_id, slug, name, media_type, created_at, updated_at) VALUES (?, ?, ?, ?, 'L', 'movie', 1, 1)");
  const chans = db.prepare("INSERT INTO channels (id, public_code, owner_account_id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, 'C', 1, 1)");
  db.exec("BEGIN");
  for (let i = 1; i <= 600; i++) {
    lists.run(i, "l" + i, (i % 50) + 1, "s" + i);
    chans.run(i, "c" + i, (i % 50) + 1, "s" + i);
  }
  db.exec("COMMIT; ANALYZE;");
  return db;
}
const plan = (db, sql) => db.prepare("EXPLAIN QUERY PLAN " + sql).all(1).map((r) => r.detail).join(" | ");
const scans = (db) => QUERIES.map((q) => plan(db, q)).join(" | ").match(/SCAN (lists|channels)\b/g) || [];

describe("owner-only lookups on lists and channels", () => {
  it("never scan the whole table, on a database made from schema.sql", () => {
    assert.deepEqual(scans(populated(fresh())), []);
  });

  it("never scan once migration 0027 is applied to a live database", () => {
    const db = fresh();
    db.exec("DROP INDEX idx_lists_owner_account; DROP INDEX idx_channels_owner_account;");
    populated(db);
    assert.ok(scans(db).length > 0, "without the indexes the owner lookups read whole tables");
    const file = fs.readdirSync(path.join(ROOT, "migrations")).find((f) => f.startsWith("0027_"));
    assert.ok(file, "migrations/0027_*.sql exists");
    db.exec(read(`migrations/${file}`));
    db.exec(read(`migrations/${file}`)); // safe to run twice
    assert.deepEqual(scans(db), []);
    assert.equal(db.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version = '0027'").get().n, 1);
  });
});
