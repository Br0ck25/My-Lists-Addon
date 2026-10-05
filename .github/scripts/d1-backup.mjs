// A D1 database as one SQL file, read table by table (task P1-B1).
//
// The daily backup used `wrangler d1 export`, which cannot work here: D1
// refuses to export a database that has virtual tables, and the main database
// has two (the full-text search tables lists_fts and lists_fts2, migrations
// 0007 and 0016). An export also blocks every other request to the database
// while it runs. So this reads each table with ordinary queries -- the D1
// query API, which a token with only "D1: Read" may call -- page by page in
// key order, and writes what it read as SQL that recreates it:
//
//   PRAGMA defer_foreign_keys, then every table (virtual tables included),
//   then the rows, then the indexes, triggers and views.
//
// A row too long for one D1 statement (100,000 bytes) is written as an INSERT
// with its long text columns empty, then UPDATEs that append them a piece at
// a time. A virtual table's own storage tables (lists_fts_data and the like)
// are left out: the table rebuilds them from its rows, written with their
// rowid. D1's internal tables (_cf_*, sqlite_*) are left out too.
//
// Restoring: docs/OPERATIONS.md §5. Numbers come back as JavaScript numbers,
// so an integer above 2^53 would lose precision; nothing in either database
// stores one.
//
// Usage (the workflow, .github/workflows/d1-backup.yml):
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
//     node .github/scripts/d1-backup.mjs <database id> <output .sql>

import fs from "node:fs";
import { pathToFileURL } from "node:url";

// D1 refuses a statement over 100,000 bytes. Kept well under it.
export const MAX_STATEMENT_BYTES = 90000;
const CHUNK_BYTES = 60000;
// Rows asked for per page, adjusted to aim at about this much JSON a page.
const PAGE_ROWS_MIN = 25;
const PAGE_ROWS_MAX = 2000;
const PAGE_TARGET_BYTES = 4 * 1024 * 1024;

const FTS_SHADOW_SUFFIXES = ["data", "idx", "content", "docsize", "config"];

export function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

export function sqlLiteral(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "NULL";
    return String(v);
  }
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v) || v instanceof Uint8Array) {
    return "X'" + Buffer.from(v).toString("hex") + "'";
  }
  if (typeof v === "object") v = JSON.stringify(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}

// Pieces of a string, each at most `maxBytes` once written as a literal.
// Split on code points, so no surrogate pair is cut in half.
export function chunkForLiterals(text, maxBytes = CHUNK_BYTES) {
  const out = [];
  let cur = "";
  let curBytes = 2;
  for (const ch of String(text)) {
    const b = ch === "'" ? 2 : Buffer.byteLength(ch);
    if (curBytes + b > maxBytes && cur) {
      out.push(cur);
      cur = "";
      curBytes = 2;
    }
    cur += ch;
    curBytes += b;
  }
  if (cur || !out.length) out.push(cur);
  return out;
}

function isInternalTable(name) {
  return /^(sqlite_|_cf_)/i.test(name);
}

// What to read, and how: every table in creation order, with its columns,
// how its rows are keyed and what a restore must write for it.
export async function readSchema(query) {
  const objects = await query(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid"
  );
  const virtual = objects.filter((o) => o.type === "table" && /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(o.sql)).map((o) => o.name);
  const isShadow = (name) => virtual.some((v) => FTS_SHADOW_SUFFIXES.some((s) => name === `${v}_${s}`));
  const tables = [];
  const later = [];
  for (const o of objects) {
    if (isInternalTable(o.name) || isInternalTable(o.tbl_name)) continue;
    if (o.type === "table") {
      if (isShadow(o.name)) continue;
      const cols = await query(`PRAGMA table_info(${quoteIdent(o.name)})`);
      const isVirtual = virtual.includes(o.name);
      const withoutRowid = !isVirtual && /\bWITHOUT\s+ROWID\b/i.test(o.sql);
      const pk = cols.filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((c) => c.name);
      tables.push({
        name: o.name,
        sql: o.sql,
        columns: cols.map((c) => c.name),
        virtual: isVirtual,
        withoutRowid,
        pk,
        // Every table that has a rowid keeps it: a virtual table's is part of
        // its data (lists_fts2's is the list id), and it is how a long row is
        // found again for its UPDATEs. A WITHOUT ROWID table is found by its
        // primary key, which it always has.
        keepRowid: !withoutRowid,
        address: withoutRowid ? pk : ["rowid"],
      });
    } else if (o.type === "index" || o.type === "trigger" || o.type === "view") {
      if (isShadow(o.tbl_name)) continue;
      later.push(o);
    }
  }
  return { tables, later };
}

// One row as SQL: an INSERT, plus UPDATEs for whatever did not fit in it.
export function rowStatements(table, row) {
  const cols = table.keepRowid ? ["rowid", ...table.columns] : table.columns;
  const value = (c) => (c === "rowid" ? row.__rowid : row[c]);
  const literals = cols.map((c) => sqlLiteral(value(c)));
  const head = `INSERT INTO ${quoteIdent(table.name)} (${cols.map(quoteIdent).join(", ")}) VALUES (`;
  const whole = head + literals.join(", ") + ");";
  if (Buffer.byteLength(whole) <= MAX_STATEMENT_BYTES) return [whole];

  // Too long: the long text columns go in afterwards, a piece at a time.
  const longCols = cols.filter((c, i) => c !== "rowid" && typeof value(c) === "string" && Buffer.byteLength(literals[i]) > 1000);
  const shortLits = cols.map((c, i) => (longCols.includes(c) ? "''" : literals[i]));
  const out = [head + shortLits.join(", ") + ");"];
  if (Buffer.byteLength(out[0]) > MAX_STATEMENT_BYTES) {
    throw new Error(`${table.name}: a row is too long to restore even without its long text columns`);
  }
  const where = table.address.map((c) => `${c === "rowid" ? "rowid" : quoteIdent(c)} = ${sqlLiteral(value(c))}`).join(" AND ");
  for (const c of longCols) {
    for (const piece of chunkForLiterals(value(c))) {
      out.push(`UPDATE ${quoteIdent(table.name)} SET ${quoteIdent(c)} = ${quoteIdent(c)} || ${sqlLiteral(piece)} WHERE ${where};`);
    }
  }
  return out;
}

// Every row of one table, in key order, a page at a time.
export async function* tableRows(query, table) {
  const byRowid = !table.withoutRowid;
  const keyCols = byRowid ? ["rowid"] : table.pk.length ? table.pk : table.columns;
  const order = keyCols.map((c) => (c === "rowid" ? "rowid" : quoteIdent(c))).join(", ");
  const select = byRowid ? `SELECT rowid AS "__rowid", * FROM ${quoteIdent(table.name)}` : `SELECT * FROM ${quoteIdent(table.name)}`;
  let last = null;
  let limit = 500;
  for (;;) {
    let sql = select;
    let params = [];
    if (last) {
      sql += ` WHERE (${order}) > (${keyCols.map(() => "?").join(", ")})`;
      params = last;
    }
    sql += ` ORDER BY ${order} LIMIT ${limit}`;
    const rows = await query(sql, params);
    for (const r of rows) yield r;
    if (rows.length < limit) return;
    const lastRow = rows[rows.length - 1];
    last = keyCols.map((c) => (c === "rowid" ? lastRow.__rowid : lastRow[c]));
    const bytes = Buffer.byteLength(JSON.stringify(rows));
    const perRow = Math.max(1, bytes / rows.length);
    limit = Math.max(PAGE_ROWS_MIN, Math.min(PAGE_ROWS_MAX, Math.floor(PAGE_TARGET_BYTES / perRow)));
  }
}

// The whole database, as lines written to `write` (one statement per call).
// Returns how many rows each table had.
export async function dumpDatabase(query, write, { label = "D1 database", now = new Date() } = {}) {
  const { tables, later } = await readSchema(query);
  write(`-- ${label}, read table by table on ${now.toISOString()} (.github/scripts/d1-backup.mjs).`);
  write("-- Restore into a new, empty database: docs/OPERATIONS.md §5.");
  write("PRAGMA defer_foreign_keys = on;");
  for (const t of tables) write(t.sql.trim().replace(/;?$/, ";"));
  const counts = {};
  for (const t of tables) {
    let n = 0;
    for await (const row of tableRows(query, t)) {
      for (const s of rowStatements(t, row)) write(s);
      n++;
    }
    counts[t.name] = n;
  }
  for (const o of later) write(o.sql.trim().replace(/;?$/, ";"));
  return counts;
}

// The D1 query API, as a function of (sql, params) -> rows. Spaced out to
// stay under Cloudflare's API limit (1,200 requests in five minutes), and
// retried on the errors that are worth retrying.
export function d1ApiQuery({ accountId, databaseId, token, fetchImpl = fetch, minIntervalMs = 260, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  let lastAt = 0;
  return async (sql, params = []) => {
    for (let attempt = 0; ; attempt++) {
      const wait = lastAt + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastAt = Date.now();
      let res;
      let body = null;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ sql, params }),
        });
        body = await res.json().catch(() => null);
      } catch (err) {
        res = { ok: false, status: 0, statusText: String(err && err.message ? err.message : err) };
      }
      if (res.ok && body && body.success) {
        const first = Array.isArray(body.result) ? body.result[0] : null;
        return (first && first.results) || [];
      }
      const retryable = res.status === 0 || res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= 5) {
        const why = body && Array.isArray(body.errors) && body.errors.length ? body.errors.map((e) => e.message || e.code).join("; ") : `${res.status} ${res.statusText || ""}`;
        throw new Error(`D1 query failed (${why}): ${sql.slice(0, 120)}`);
      }
      await sleep(Math.min(30000, 1000 * 2 ** attempt));
    }
  };
}

async function main() {
  const [databaseId, output] = process.argv.slice(2);
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!databaseId || !output || !accountId || !token) {
    console.error("Usage: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node d1-backup.mjs <database id> <output .sql>");
    process.exit(2);
  }
  const query = d1ApiQuery({ accountId, databaseId, token });
  const fd = fs.openSync(output, "w");
  try {
    const counts = await dumpDatabase(query, (line) => fs.writeSync(fd, line + "\n"), { label: `D1 database ${databaseId.slice(0, 8)}...` });
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(`Read ${Object.keys(counts).length} tables, ${total} rows.`);
    for (const [name, n] of Object.entries(counts)) console.log(`  ${name}: ${n}`);
    // What d1-backup-verify.mjs checks the restored copy against.
    fs.writeFileSync(`${output}.counts.json`, JSON.stringify(counts));
  } finally {
    fs.closeSync(fd);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}
