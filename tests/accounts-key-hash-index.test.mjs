// Audit DB-03 (2026-11-10): the manifest/channel lookup
//   SELECT username FROM accounts WHERE username = ? OR id = ? OR key_hash = ?
// had no index on key_hash, so SQLite read every accounts row on every manifest
// request (the install token matches none of the three columns). Migration 0026
// indexes key_hash.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// The statement as the Worker runs it (src/api/70_stremio-routes.js).
const SQL = (() => {
  const m = read("src/api/70_stremio-routes.js").match(/"(SELECT username FROM accounts WHERE username = \? OR id = \? OR key_hash = \? LIMIT 1)"/);
  assert.ok(m, "the accounts lookup is still in src/api/70_stremio-routes.js");
  return m[1];
})();

function populated(db) {
  db.exec("BEGIN");
  const acc = db.prepare("INSERT INTO accounts (id, username, display_name, key_hash, created_at) VALUES (?, ?, 'N', ?, 1)");
  for (let a = 1; a <= 500; a++) acc.run(a, "u" + a, "h" + a);
  db.exec("COMMIT; ANALYZE;");
  return db;
}
const planOf = (db) => db.prepare("EXPLAIN QUERY PLAN " + SQL).all("tok", "tok", "tok").map((r) => r.detail).join(" | ");

function fresh() {
  const db = new DatabaseSync(":memory:");
  db.exec(read("schema.sql"));
  return db;
}

describe("the accounts lookup on every manifest request", () => {
  it("uses indexes only, on a database made from schema.sql", () => {
    const plan = planOf(populated(fresh()));
    assert.match(plan, /idx_accounts_key_hash/);
    assert.doesNotMatch(plan, /SCAN accounts/);
  });

  it("uses indexes only once migration 0026 is applied to a live database", () => {
    const db = fresh();
    db.exec("DROP INDEX idx_accounts_key_hash");
    populated(db);
    assert.match(planOf(db), /SCAN accounts/, "without the index the lookup reads every account");
    const file = fs.readdirSync(path.join(ROOT, "migrations")).find((f) => f.startsWith("0026_"));
    assert.ok(file, "migrations/0026_*.sql exists");
    db.exec(read(`migrations/${file}`));
    db.exec(read(`migrations/${file}`)); // safe to run twice
    assert.match(planOf(db), /idx_accounts_key_hash/);
    assert.doesNotMatch(planOf(db), /SCAN accounts/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version = '0026'").get().n, 1);
  });
});
