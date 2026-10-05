// Checks that a backup can be restored: loads the dump into an empty SQLite
// database the way D1 would (statement by statement) and compares every
// table's row count with what d1-backup.mjs read from D1.
//
//   node d1-backup-verify.mjs <dump.sql> <dump.sql.counts.json>
//
// The workflow runs it on the decrypted copy of the file it is about to keep,
// so a passphrase that cannot open it, a truncated file, or a statement SQLite
// refuses fails the run the day it happens, not the day a restore is needed.
import fs from "node:fs";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

// lines: an iterable (sync or async) of the dump's lines. Returns
// { ok, tables, rows, problems }.
export async function verifyDump(lines, counts) {
  const db = new DatabaseSync(":memory:");
  const problems = [];
  let statements = 0;
  // A table's CREATE statement keeps the line breaks it was written with, so
  // a statement can span lines: they are put back together until SQLite
  // accepts the whole (an "incomplete input" means it is not finished yet).
  let buffer = "";
  for await (const line of lines) {
    if (!buffer && (!line || line.startsWith("--"))) continue;
    buffer = buffer ? buffer + "\n" + line : line;
    if (!buffer.trimEnd().endsWith(";")) continue;
    try {
      db.exec(buffer);
      statements++;
      buffer = "";
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      if (/incomplete input/i.test(msg)) continue;
      problems.push(`statement ${statements + 1} refused: ${msg.slice(0, 200)}`);
      buffer = "";
      if (problems.length >= 5) break;
    }
  }
  if (buffer.trim()) problems.push(`the file ends inside a statement: ${buffer.slice(0, 80)}`);
  let rows = 0;
  for (const [table, expected] of Object.entries(counts || {})) {
    let got;
    try {
      got = Number(db.prepare(`SELECT count(*) AS n FROM "${table.replace(/"/g, '""')}"`).get().n);
    } catch (err) {
      problems.push(`${table}: missing after restore (${String(err && err.message ? err.message : err).slice(0, 120)})`);
      continue;
    }
    rows += got;
    if (got !== Number(expected)) problems.push(`${table}: ${got} rows restored, ${expected} read from D1`);
  }
  if (!Object.keys(counts || {}).length) problems.push("no table counts to check against");
  db.close();
  return { ok: problems.length === 0, tables: Object.keys(counts || {}).length, rows, problems };
}

async function main() {
  const [sqlFile, countsFile] = process.argv.slice(2);
  if (!sqlFile || !countsFile) {
    console.error("Usage: node d1-backup-verify.mjs <dump.sql> <dump.sql.counts.json>");
    process.exit(2);
  }
  const counts = JSON.parse(fs.readFileSync(countsFile, "utf8"));
  const lines = readline.createInterface({ input: fs.createReadStream(sqlFile, "utf8"), crlfDelay: Infinity });
  const r = await verifyDump(lines, counts);
  if (!r.ok) {
    console.error(`::error::The backup ${sqlFile} does not restore cleanly:`);
    for (const p of r.problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`Restored ${r.tables} tables, ${r.rows} rows: every count matches.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}
