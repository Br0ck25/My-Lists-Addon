// Audit DB-06 (2026-11-10): migrations with several ALTER TABLE ADD COLUMN
// statements cannot be re-run after an interruption (SQLite cannot add a column
// twice) and said nothing about how to continue; and databases built from the
// migration chain lacked two base indexes that schema.sql has.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const MIG = fs.readdirSync(path.join(ROOT, "migrations")).filter((f) => /^\d{4}[a-z]?_.*\.sql$/.test(f)).sort();

describe("migrations that add more than one column", () => {
  it("tell the owner how to continue if the run stops part-way", () => {
    const bad = MIG.filter((f) => {
      const sql = read("migrations/" + f);
      const alters = (sql.match(/^\s*ALTER TABLE\s+\w+\s+ADD COLUMN/gim) || []).length;
      if (alters < 2) return false;
      const header = sql.split("\n").filter((l) => l.startsWith("--")).join("\n");
      return !/stops? part-?way/i.test(header) || !/ADD COLUMN/i.test(header.split(/part-?way/i)[1] || "");
    });
    assert.deepEqual(bad, []);
  });
});

describe("base indexes the migration chain never created", () => {
  it("a later migration adds them, safe to run twice", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(read("schema.sql"));
    db.exec("DROP INDEX idx_creator_lists_username; DROP INDEX idx_creator_lists_visibility;");
    const file = MIG.find((f) => f.startsWith("0029_"));
    assert.ok(file, "migrations/0029_*.sql exists");
    db.exec(read("migrations/" + file));
    db.exec(read("migrations/" + file));
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='creator_lists'").all().map((r) => r.name);
    assert.ok(idx.includes("idx_creator_lists_username") && idx.includes("idx_creator_lists_visibility"), idx.join(","));
    assert.equal(db.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version = '0029'").get().n, 1);
  });
});
