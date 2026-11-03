// Checks that a KV backup (kv-backup.mjs) can be restored: every line after
// the header must be a key and a text value `wrangler kv bulk put` accepts,
// and the keys per prefix must match what was read from KV.
//
//   node kv-backup-verify.mjs <dump.jsonl> <dump.jsonl.counts.json>
//
// The workflow runs it on the decrypted copy of the file it is about to keep,
// the same way d1-backup-verify.mjs checks the D1 copies.
import fs from "node:fs";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { longestPrefix } from "./kv-backup.mjs";

// lines: an iterable (sync or async) of the file's lines.
export async function verifyKvDump(lines, counts) {
  const problems = [];
  const prefixes = Object.keys(counts || {});
  const got = Object.fromEntries(prefixes.map((p) => [p, 0]));
  const seen = new Set();
  let header = null;
  let n = 0;
  for await (const line of lines) {
    if (!line) continue;
    n++;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      problems.push(`line ${n} is not JSON: ${line.slice(0, 80)}`);
      if (problems.length >= 5) break;
      continue;
    }
    if (n === 1) {
      header = rec;
      if (!rec || rec.backup !== "kv") problems.push("the file does not start with the KV backup header");
      continue;
    }
    if (!rec || typeof rec.key !== "string" || !rec.key || typeof rec.value !== "string") {
      problems.push(`line ${n} has no key and text value`);
    } else if (seen.has(rec.key)) {
      problems.push(`line ${n}: ${rec.key} is in the file twice`);
    } else {
      seen.add(rec.key);
      const p = longestPrefix(rec.key, prefixes);
      if (p) got[p]++;
      else problems.push(`line ${n}: ${rec.key} is under no backed-up prefix`);
    }
    if (problems.length >= 5) break;
  }
  if (!header) problems.push("the file is empty");
  if (!prefixes.length) problems.push("no prefix counts to check against");
  for (const p of prefixes) {
    if (got[p] !== Number(counts[p])) problems.push(`${p} ${got[p]} keys in the file, ${counts[p]} read from KV`);
  }
  return { ok: problems.length === 0, keys: seen.size, problems };
}

async function main() {
  const [file, countsFile] = process.argv.slice(2);
  if (!file || !countsFile) {
    console.error("Usage: node kv-backup-verify.mjs <dump.jsonl> <dump.jsonl.counts.json>");
    process.exit(2);
  }
  const counts = JSON.parse(fs.readFileSync(countsFile, "utf8"));
  const lines = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
  const r = await verifyKvDump(lines, counts);
  if (!r.ok) {
    console.error(`::error::The KV backup ${file} does not restore cleanly:`);
    for (const p of r.problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`Checked ${r.keys} KV keys: every prefix's count matches.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}
