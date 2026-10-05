// The daily D1 backup (.github/scripts/d1-backup.mjs, task P1-B1).
//
// `wrangler d1 export` refuses a database with virtual tables, and the main
// database has two (lists_fts, lists_fts2), so the backup reads every table
// with ordinary queries and writes SQL that recreates it. These dump a
// database, restore the dump into an empty one the way D1 would run it (each
// statement under D1's 100,000-byte limit), and compare every row.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  dumpDatabase, rowStatements, chunkForLiterals, sqlLiteral, d1ApiQuery, readSchema, MAX_STATEMENT_BYTES,
} from "../.github/scripts/d1-backup.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const D1_MAX_STATEMENT_BYTES = 100000;

const queryOf = (db) => async (sql, params = []) => db.prepare(sql).all(...params).map((r) => ({ ...r }));

async function dump(db) {
  const lines = [];
  const counts = await dumpDatabase(queryOf(db), (l) => lines.push(l), { now: new Date(0) });
  return { lines, counts };
}

// Runs a dump the way D1 does: statement by statement, each under its limit.
function restore(lines) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const l of lines) {
    if (l.startsWith("--")) continue;
    assert.ok(Buffer.byteLength(l) <= D1_MAX_STATEMENT_BYTES, `a statement D1 would refuse (${Buffer.byteLength(l)} bytes): ${l.slice(0, 60)}`);
    db.exec(l);
  }
  return db;
}

async function tablesOf(db) {
  const { tables } = await readSchema(queryOf(db));
  return tables;
}

async function contents(db) {
  const out = {};
  for (const t of await tablesOf(db)) {
    const order = t.withoutRowid ? t.pk.map((c) => `"${c}"`).join(", ") : "rowid";
    const sel = t.withoutRowid ? "*" : "rowid AS __rowid, *";
    out[t.name] = db.prepare(`SELECT ${sel} FROM "${t.name}" ORDER BY ${order}`).all().map((r) => ({ ...r }));
  }
  return out;
}

// Every case the live databases have: an integer key, a text key, no key, a
// WITHOUT ROWID table with a composite key, a full-text table whose rowid is
// data, a foreign key, an index, and rows with quotes, newlines, emoji, NULLs,
// floats and negative numbers -- and one row far over a statement's limit.
function sampleDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE lists (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, name TEXT NOT NULL, items_json TEXT, score REAL);
    CREATE INDEX idx_lists_owner ON lists(owner_id);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE stats (kind TEXT NOT NULL, n INTEGER NOT NULL);
    CREATE TABLE media_episodes (media_id INTEGER NOT NULL, season INTEGER NOT NULL, episode INTEGER NOT NULL, title TEXT, PRIMARY KEY (media_id, season, episode)) WITHOUT ROWID;
    CREATE VIRTUAL TABLE lists_fts2 USING fts5(name, owner_name, tokenize = 'unicode61 remove_diacritics 2');
  `);
  db.prepare("INSERT INTO accounts (id, username, created_at) VALUES (?, ?, ?)").run(7, "o'brien", 1700000000000);
  db.prepare("INSERT INTO accounts (id, username, created_at) VALUES (?, ?, ?)").run(9, "zoë 🎬", -5);
  const big = JSON.stringify(Array.from({ length: 6000 }, (_, i) => ({ id: "tt" + (1000000 + i), name: "It's a \"title\" 🎞️ #" + i })));
  assert.ok(Buffer.byteLength(big) > 3 * D1_MAX_STATEMENT_BYTES, "the big row has to be far over a statement");
  db.prepare("INSERT INTO lists (id, owner_id, name, items_json, score) VALUES (?, ?, ?, ?, ?)").run(1, 7, "Big list", big, 7.25);
  db.prepare("INSERT INTO lists (id, owner_id, name, items_json, score) VALUES (?, ?, ?, ?, ?)").run(2, 9, "Line one\nline two; DROP TABLE x;--", null, null);
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("motd", "a'b''c");
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("huge", "x".repeat(250000));
  for (let i = 0; i < 1200; i++) db.prepare("INSERT INTO stats (kind, n) VALUES (?, ?)").run("k" + (i % 7), i);
  db.prepare("INSERT INTO stats (kind, n) VALUES (?, ?)").run("long", 1);
  db.prepare("UPDATE stats SET kind = ? WHERE kind = 'long'").run("L".repeat(120000));
  for (let s = 1; s <= 3; s++) for (let e = 1; e <= 400; e++) db.prepare("INSERT INTO media_episodes VALUES (?, ?, ?, ?)").run(55, s, e, `S${s}E${e} "Pilot's"`);
  db.prepare("INSERT INTO lists_fts2 (rowid, name, owner_name) VALUES (?, ?, ?)").run(1, "Big list", "o'brien");
  db.prepare("INSERT INTO lists_fts2 (rowid, name, owner_name) VALUES (?, ?, ?)").run(2, "Café favourites", null);
  return db;
}

describe("the daily D1 backup", () => {
  it("restores every row of every table, exactly", async () => {
    const src = sampleDb();
    const { lines, counts } = await dump(src);
    assert.equal(counts.stats, 1201);
    assert.equal(counts.media_episodes, 1200);
    assert.equal(counts.lists_fts2, 2);
    const back = restore(lines);
    assert.deepEqual(await contents(back), await contents(src));
  });

  it("keeps a full-text table searchable, with its rowids, and leaves out its storage tables", async () => {
    const src = sampleDb();
    const { lines } = await dump(src);
    assert.ok(!lines.some((l) => /lists_fts2_(data|idx|content|docsize|config)/.test(l)), "FTS storage tables are rebuilt, not copied");
    const back = restore(lines);
    const hit = back.prepare("SELECT rowid FROM lists_fts2 WHERE lists_fts2 MATCH ?").all("cafe").map((r) => r.rowid);
    assert.deepEqual(hit, [2], "found without its accent, under the list's id");
  });

  it("writes a row too long for one statement as an INSERT and appending UPDATEs", async () => {
    const src = sampleDb();
    const { lines } = await dump(src);
    assert.ok(lines.every((l) => Buffer.byteLength(l) <= MAX_STATEMENT_BYTES));
    assert.ok(lines.filter((l) => l.startsWith('UPDATE "lists" SET "items_json"')).length >= 4);
    assert.ok(lines.some((l) => l.startsWith('UPDATE "stats" SET "kind"')), "a table with no key is found by its rowid");
  });

  it("recreates the indexes, after the rows", async () => {
    const { lines } = await dump(sampleDb());
    const idx = lines.findIndex((l) => l.startsWith("CREATE INDEX idx_lists_owner"));
    const lastInsert = lines.map((l) => l.startsWith("INSERT")).lastIndexOf(true);
    assert.ok(idx > lastInsert);
  });

  it("restores the main database's real schema, search tables included", async () => {
    const schema = fs.readFileSync(path.join(ROOT, "schema.sql"), "utf8");
    const src = new DatabaseSync(":memory:");
    src.exec("PRAGMA foreign_keys = ON;");
    src.exec(schema);
    src.prepare("INSERT INTO lists_fts (list_id, name, creator_name, username) VALUES (?, ?, ?, ?)").run("l1", "Horror", "Ann", "ann");
    const { lines } = await dump(src);
    const back = restore(lines);
    const names = (db) => db.prepare("SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all().map((r) => r.type + ":" + r.name);
    assert.deepEqual(names(back), names(src));
    assert.deepEqual(await contents(back), await contents(src));
    assert.equal(back.prepare("SELECT list_id FROM lists_fts WHERE lists_fts MATCH 'horror'").all()[0].list_id, "l1");
  });

  it("restores the activity database's real schema", async () => {
    const schema = fs.readFileSync(path.join(ROOT, "schema_activity.sql"), "utf8");
    const src = new DatabaseSync(":memory:");
    src.exec(schema);
    const { lines } = await dump(src);
    const back = restore(lines);
    const names = (db) => db.prepare("SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all().map((r) => r.type + ":" + r.name);
    assert.deepEqual(names(back), names(src));
  });
});

describe("the pieces", () => {
  it("writes values as SQL literals", () => {
    assert.equal(sqlLiteral(null), "NULL");
    assert.equal(sqlLiteral(3.5), "3.5");
    assert.equal(sqlLiteral(-2), "-2");
    assert.equal(sqlLiteral("it's"), "'it''s'");
    assert.equal(sqlLiteral([1, 255]), "X'01ff'");
    assert.equal(sqlLiteral(true), "1");
  });

  it("splits long text without cutting an emoji in half, each piece under the limit", () => {
    const text = ("🎬'é".repeat(30000));
    const pieces = chunkForLiterals(text, 1000);
    assert.equal(pieces.join(""), text);
    for (const p of pieces) {
      assert.ok(Buffer.byteLength(sqlLiteral(p)) <= 1000);
      assert.ok(!/[\uD800-\uDBFF]$/.test(p), "no piece ends half way through a character");
    }
  });

  it("refuses a row it could not restore, rather than writing a broken backup", () => {
    const table = { name: "t", columns: Array.from({ length: 200 }, (_, i) => "c" + i), keepRowid: true, address: ["rowid"] };
    const row = { __rowid: 1 };
    for (const c of table.columns) row[c] = "y".repeat(900);
    assert.throws(() => rowStatements(table, row), /too long to restore/);
  });
});

describe("the D1 query API", () => {
  const ok = (rows) => ({ ok: true, status: 200, json: async () => ({ success: true, result: [{ results: rows, success: true }] }) });

  it("posts the query with the token and returns its rows", async () => {
    const sent = [];
    const q = d1ApiQuery({
      accountId: "acc", databaseId: "db1", token: "TOKEN", minIntervalMs: 0, sleep: async () => {},
      fetchImpl: async (url, init) => { sent.push({ url, init }); return ok([{ a: 1 }]); },
    });
    assert.deepEqual(await q("SELECT ? AS a", [1]), [{ a: 1 }]);
    assert.equal(sent[0].url, "https://api.cloudflare.com/client/v4/accounts/acc/d1/database/db1/query");
    assert.equal(sent[0].init.headers.Authorization, "Bearer TOKEN");
    assert.deepEqual(JSON.parse(sent[0].init.body), { sql: "SELECT ? AS a", params: [1] });
  });

  it("tries again after a rate limit or a server error, and gives up on anything else", async () => {
    let calls = 0;
    const slept = [];
    const q = d1ApiQuery({
      accountId: "a", databaseId: "d", token: "t", minIntervalMs: 0, sleep: async (ms) => { slept.push(ms); },
      fetchImpl: async () => (++calls < 3 ? { ok: false, status: calls === 1 ? 429 : 503, json: async () => ({ success: false, errors: [] }) } : ok([])),
    });
    assert.deepEqual(await q("SELECT 1"), []);
    assert.equal(calls, 3);
    assert.deepEqual(slept, [1000, 2000]);

    const bad = d1ApiQuery({
      accountId: "a", databaseId: "d", token: "t", minIntervalMs: 0, sleep: async () => {},
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }) }),
    });
    await assert.rejects(bad("SELECT 1"), /Authentication error/);
  });

  it("spaces its requests out to stay under Cloudflare's API limit", async () => {
    const waits = [];
    const q = d1ApiQuery({
      accountId: "a", databaseId: "d", token: "t", minIntervalMs: 260, sleep: async (ms) => { waits.push(ms); },
      fetchImpl: async () => ok([]),
    });
    await q("SELECT 1");
    await q("SELECT 1");
    assert.equal(waits.length, 1);
    assert.ok(waits[0] > 200 && waits[0] <= 260);
  });
});

// The workflow's check that the file it keeps restores (d1-backup-verify.mjs).
describe("d1-backup-verify: a kept backup must restore", () => {
  it("passes a whole dump, every table's rows counted", async () => {
    const { verifyDump } = await import("../.github/scripts/d1-backup-verify.mjs");
    const { lines, counts } = await dump(sampleDb());
    const r = await verifyDump(lines, counts);
    assert.equal(r.ok, true, r.problems.join("; "));
    assert.equal(r.tables, Object.keys(counts).length);
  });

  it("fails a dump cut short, and counts that do not match", async () => {
    const { verifyDump } = await import("../.github/scripts/d1-backup-verify.mjs");
    const { lines, counts } = await dump(sampleDb());
    const cut = lines.slice(0, Math.floor(lines.length / 2));
    const short = await verifyDump(cut, counts);
    assert.equal(short.ok, false);
    const wrong = await verifyDump(lines, { ...counts, accounts: counts.accounts + 1 });
    assert.equal(wrong.ok, false);
    assert.match(wrong.problems.join(" "), /accounts: 2 rows restored, 3 read from D1/);
    const garbage = await verifyDump(["not sql at all"], counts);
    assert.equal(garbage.ok, false);
  });

  it("restores the live schema, whose CREATE statements span lines, read from a file line by line", async () => {
    const { verifyDump } = await import("../.github/scripts/d1-backup-verify.mjs");
    for (const schemaFile of ["schema.sql", "schema_activity.sql"]) {
      const db = new DatabaseSync(":memory:");
      db.exec(fs.readFileSync(path.join(ROOT, schemaFile), "utf8"));
      const { lines, counts } = await dump(db);
      // As the workflow reads it: the file split at its line breaks.
      const fileLines = lines.join("\n").split("\n");
      assert.ok(fileLines.length > lines.length, "some statement spans lines");
      const r = await verifyDump(fileLines, counts);
      assert.equal(r.ok, true, `${schemaFile}: ${r.problems.join("; ")}`);
    }
  });
});
