// Audit DB-05 (2026-11-10): migrations 0022 and 0023 never wrote their
// schema_migrations row, so a database built from the migration files had a
// ledger with holes and the ledger could not tell whether they ran. Migration
// 0028 backfills the two rows, but only where the change is really present.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const MIG = fs.readdirSync(path.join(ROOT, "migrations")).filter((f) => /^\d{4}[a-z]?_.*\.sql$/.test(f)).sort();

function fresh() {
  const db = new DatabaseSync(":memory:");
  db.exec(read("schema.sql"));
  return db;
}
const versions = (db) => db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => r.version);

describe("the migration ledger", () => {
  it("every migration from 0014 on records its own ledger row", () => {
    const missing = MIG.filter((f) => f >= "0014")
      .filter((f) => !new RegExp(`INSERT[^;]*schema_migrations[^;]*'${f.slice(0, 4)}'`, "i").test(read("migrations/" + f)))
      .filter((f) => !/^0028_/.test(f)); // the backfill records 0022/0023 and itself, checked below
    assert.deepEqual(missing, []);
  });

  it("the backfill adds 0022 and 0023 where they ran, and is safe to run twice", () => {
    const db = fresh();
    db.exec("DELETE FROM schema_migrations WHERE version IN ('0022', '0023')");
    const file = MIG.find((f) => f.startsWith("0028_"));
    assert.ok(file, "migrations/0028_*.sql exists");
    db.exec(read("migrations/" + file));
    db.exec(read("migrations/" + file));
    const v = versions(db);
    assert.ok(v.includes("0022") && v.includes("0023") && v.includes("0028"), v.join(","));
    assert.equal(v.length, new Set(v).size);
  });

  it("the backfill does not claim a migration whose change is missing", () => {
    const db = fresh();
    db.exec("DELETE FROM schema_migrations WHERE version IN ('0022', '0023')");
    db.exec("DROP INDEX idx_feedback_creator_updated; ALTER TABLE feedback DROP COLUMN creator_name; DROP TABLE media_app_sync;");
    db.exec(read("migrations/" + MIG.find((f) => f.startsWith("0028_"))));
    const v = versions(db);
    assert.ok(!v.includes("0022") && !v.includes("0023"), v.join(","));
  });
});
