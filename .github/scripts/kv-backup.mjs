// The user data that lives only in KV, as JSON lines (audit DB-01).
//
// The daily D1 backup (d1-backup.mjs) covers both D1 databases, but some user
// data was never moved to D1 and lives only in the CONFIGS KV namespace:
// every install link's config, every account's synced settings, presets and
// My Channels, shared channels and list order. This reads those prefixes
// through the Cloudflare KV API (a token with "Workers KV Storage: Read") and
// writes one line per key:
//
//   {"key": "...", "value": "...", "metadata": {...}}
//
// which is the format `wrangler kv bulk put` takes, once the first line (a
// header, with no "key") is dropped: docs/OPERATIONS.md §5. A key's TTL is
// not kept; none of these prefixes is written with one.
//
// Keys are listed a page at a time (1,000 a page) and their values read 100
// at a time (the bulk read), spaced out like d1ApiQuery to stay under
// Cloudflare's API limit. A failed page fails the run: a backup that is
// missing keys is worse than a red run.
//
// Usage (the workflow, .github/workflows/d1-backup.yml):
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
//     node .github/scripts/kv-backup.mjs <namespace id> <output .jsonl>
// It also writes <output>.counts.json, which kv-backup-verify.mjs checks.

import fs from "node:fs";
import { pathToFileURL } from "node:url";

// Every KV prefix that holds user data no D1 table has. `creatorlist:` is in
// D1 too once FF_V2_LISTS_ONLY is on, but it is copied anyway: a flag can be
// turned off. Caches, cron cursors and counters are left out on purpose.
export const KV_BACKUP_PREFIXES = [
  "cfg:",
  "creatorsync:",
  "creatorsyncpresets:",
  "creatorsyncchannels:",
  "creatorchannel:",
  "channelshare:",
  "creatorlistorder:",
  "creatorlist:",
];

const LIST_PAGE = 1000;
const BULK_GET = 100;

// The KV API as { list(prefix, cursor), getMany(keys) }. Retried on the errors
// that are worth retrying; a 401/403 names the permission the token needs.
export function kvApi({ accountId, namespaceId, token, fetchImpl = fetch, minIntervalMs = 260, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}`;
  let lastAt = 0;
  let bulk = true;

  async function call(url, init, what, asText = false) {
    for (let attempt = 0; ; attempt++) {
      const wait = lastAt + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastAt = Date.now();
      let res;
      let body = null;
      try {
        res = await fetchImpl(url, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
        if (asText && res.ok) return { status: res.status, text: await res.text() };
        body = await res.json().catch(() => null);
      } catch (err) {
        res = { ok: false, status: 0, statusText: String(err && err.message ? err.message : err) };
      }
      if (res.ok && body && body.success) return { status: res.status, body };
      if (res.status === 404 && init.method === "POST") return { status: 404 };
      const retryable = res.status === 0 || res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= 5) {
        const why = body && Array.isArray(body.errors) && body.errors.length ? body.errors.map((e) => e.message || e.code).join("; ") : `${res.status} ${res.statusText || ""}`;
        const hint = res.status === 401 || res.status === 403 ? " -- the API token needs Account -> Workers KV Storage -> Read (docs/OPERATIONS.md §5)" : "";
        throw new Error(`KV ${what} failed (${why})${hint}`);
      }
      await sleep(Math.min(30000, 1000 * 2 ** attempt));
    }
  }

  return {
    async list(prefix, cursor) {
      const q = new URLSearchParams({ prefix, limit: String(LIST_PAGE) });
      if (cursor) q.set("cursor", cursor);
      const { body } = await call(`${base}/keys?${q}`, { method: "GET" }, `list of ${prefix}`);
      const keys = (body.result || []).map((k) => ({ name: k.name, metadata: k.metadata }));
      const next = body.result_info && body.result_info.cursor ? body.result_info.cursor : "";
      return { keys, cursor: next };
    },
    // { key: value } for the keys that still exist.
    async getMany(names) {
      if (bulk) {
        const r = await call(`${base}/bulk/get`, { method: "POST", body: JSON.stringify({ keys: names, type: "text" }) }, `read of ${names.length} keys`);
        if (r.status !== 404) return (r.body.result && r.body.result.values) || {};
        bulk = false; // an API without the bulk read: one key at a time
      }
      const out = {};
      for (const name of names) {
        try {
          const r = await call(`${base}/values/${encodeURIComponent(name)}`, { method: "GET" }, `read of ${name}`, true);
          out[name] = r.text;
        } catch (err) {
          if (/\(404\b|key not found/i.test(String(err.message))) continue; // deleted since it was listed
          throw err;
        }
      }
      return out;
    },
  };
}

// Every key under every prefix, as lines written to `write`. Returns how many
// keys each prefix had.
export async function dumpKv(kv, write, { prefixes = KV_BACKUP_PREFIXES, now = new Date() } = {}) {
  write(JSON.stringify({ backup: "kv", prefixes, at: now.toISOString() }));
  const counts = {};
  for (const prefix of prefixes) {
    let n = 0;
    let cursor = "";
    do {
      const page = await kv.list(prefix, cursor);
      // `creatorsync:` also matches `creatorsyncpresets:...`; each key is
      // copied under the longest prefix it has, once.
      const mine = page.keys.filter((k) => longestPrefix(k.name, prefixes) === prefix);
      for (let i = 0; i < mine.length; i += BULK_GET) {
        const batch = mine.slice(i, i + BULK_GET);
        const values = await kv.getMany(batch.map((k) => k.name));
        for (const k of batch) {
          const value = values[k.name];
          if (value === undefined || value === null) continue; // deleted since it was listed
          const line = { key: k.name, value: typeof value === "string" ? value : JSON.stringify(value) };
          if (k.metadata !== undefined && k.metadata !== null) line.metadata = k.metadata;
          write(JSON.stringify(line));
          n++;
        }
      }
      cursor = page.cursor;
    } while (cursor);
    counts[prefix] = n;
  }
  return counts;
}

export function longestPrefix(name, prefixes = KV_BACKUP_PREFIXES) {
  let best = null;
  for (const p of prefixes) if (name.startsWith(p) && (!best || p.length > best.length)) best = p;
  return best;
}

async function main() {
  const [namespaceId, output] = process.argv.slice(2);
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!namespaceId || !output || !accountId || !token) {
    console.error("Usage: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node kv-backup.mjs <namespace id> <output .jsonl>");
    process.exit(2);
  }
  const kv = kvApi({ accountId, namespaceId, token });
  const fd = fs.openSync(output, "w");
  try {
    const counts = await dumpKv(kv, (line) => fs.writeSync(fd, line + "\n"));
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(`Read ${total} KV keys.`);
    for (const [p, n] of Object.entries(counts)) console.log(`  ${p} ${n}`);
    fs.writeFileSync(`${output}.counts.json`, JSON.stringify(counts));
  } finally {
    fs.closeSync(fd);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`::error::${err && err.message ? err.message : err}`);
    process.exit(1);
  });
}
