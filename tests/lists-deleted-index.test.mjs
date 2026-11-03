// Audit DB-03: every signed-in Lists load asks for the account's recently
// deleted lists. Every index on lists.owner_account_id is partial
// (WHERE deleted_at IS NULL), so none could serve that lookup and it read the
// whole lists table. Migration 0025 adds an index of deleted lists only.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// The exact statement listsV2DashboardResponse runs.
const DELETED_SQL = (() => {
  const m = read("src/data/34_lists-v2-bridge.js").match(/"(SELECT slug FROM lists WHERE owner_account_id = \? AND deleted_at IS NOT NULL[^"]*)"/);
  assert.ok(m, "the deleted-lists lookup is still in src/data/34_lists-v2-bridge.js");
  return m[1];
})();

// Many accounts and lists, some deleted, with statistics, so the plan is the
// one a grown database gets.
function populated(db) {
  db.exec("BEGIN");
  const acc = db.prepare("INSERT INTO accounts (id, username, display_name, key_hash, created_at) VALUES (?, ?, 'N', 'h', 1)");
  const list = db.prepare("INSERT INTO lists (id, public_id, owner_account_id, slug, name, media_type, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'L', 'movie', ?, 1, 1)");
  let id = 0;
  for (let a = 1; a <= 300; a++) {
    acc.run(a, "u" + a);
    for (let i = 0; i < 10; i++) { id++; list.run(id, "p" + id, a, "s" + i, i === 0 ? 1000 + a : null); }
  }
  db.exec("COMMIT; ANALYZE;");
  return db;
}

function planOf(db) {
  return db.prepare("EXPLAIN QUERY PLAN " + DELETED_SQL).all(1, 0).map((r) => r.detail).join(" | ");
}

describe("the deleted-lists lookup on the Lists page (DB-03)", () => {
  it("uses an index on a database made from schema.sql", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(read("schema.sql"));
    const plan = planOf(populated(db));
    assert.match(plan, /idx_lists_owner_deleted/);
    assert.doesNotMatch(plan, /SCAN lists/);
  });

  it("uses an index once migration 0025 is applied to a live database", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(read("schema.sql"));
    db.exec("DROP INDEX idx_lists_owner_deleted");
    populated(db);
    assert.match(planOf(db), /SCAN lists/, "without the index the lookup reads the whole table");
    const file = fs.readdirSync(path.join(ROOT, "migrations")).find((f) => f.startsWith("0025_"));
    assert.ok(file, "migrations/0025_*.sql exists");
    db.exec(read(`migrations/${file}`));
    db.exec(read(`migrations/${file}`)); // safe to run twice
    assert.match(planOf(db), /idx_lists_owner_deleted/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version = '0025'").get().n, 1);
  });
});
