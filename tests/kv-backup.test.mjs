// The daily KV backup (.github/scripts/kv-backup.mjs, audit DB-01).
//
// Install links, synced settings, presets and My Channels live only in KV, so
// the daily backup copies those prefixes too. These run the script against a
// fake Cloudflare KV API (paged lists, the bulk read) and check every user
// key comes out, caches stay out, and a failed read fails the run.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { KV_BACKUP_PREFIXES, kvApi, dumpKv } from "../.github/scripts/kv-backup.mjs";
import { verifyKvDump } from "../.github/scripts/kv-backup-verify.mjs";

// The prefixes the audit found holding data no D1 table has. Spelled out here
// so dropping one from the script fails this file.
const MUST_COVER = [
  "cfg:", "creatorsync:", "creatorsyncpresets:", "creatorsyncchannels:",
  "creatorchannel:", "channelshare:", "creatorlistorder:", "creatorlist:",
];

function sampleStore() {
  const store = new Map();
  for (const p of MUST_COVER) {
    for (let i = 0; i < 3; i++) store.set(`${p}k${i}`, { value: JSON.stringify({ p, i, note: "it's \"quoted\" 🎬\nline" }) });
  }
  store.get("cfg:k0").metadata = { v: 2 };
  store.set("cache:tmdb:1", { value: "{}" });
  store.set("cron:last", { value: "1" });
  store.set("creatorsynctrackingX", { value: "no" });
  return store;
}

// The Cloudflare KV API, two keys a page so paging is exercised.
function fakeKv(store, { failList = null, noBulk = false, status = null } = {}) {
  const calls = [];
  const json = (body, st = 200) => ({ ok: st < 300, status: st, json: async () => body, text: async () => JSON.stringify(body) });
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, init });
    if (status) return json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, status);
    if (u.pathname.endsWith("/keys")) {
      const prefix = u.searchParams.get("prefix");
      if (failList && prefix === failList) return json({ success: false, errors: [{ message: "boom" }] }, 400);
      const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = Number(u.searchParams.get("cursor") || 0);
      const page = all.slice(start, start + 2);
      const next = start + 2 < all.length ? String(start + 2) : "";
      return json({ success: true, result: page.map((name) => ({ name, metadata: store.get(name).metadata })), result_info: { cursor: next, count: page.length } });
    }
    if (u.pathname.endsWith("/bulk/get")) {
      if (noBulk) return json({ success: false, errors: [] }, 404);
      const { keys } = JSON.parse(init.body);
      assert.ok(keys.length <= 100);
      return json({ success: true, result: { values: Object.fromEntries(keys.map((k) => [k, store.has(k) ? store.get(k).value : null])) } });
    }
    const m = u.pathname.match(/\/values\/(.+)$/);
    if (m) {
      const k = decodeURIComponent(m[1]);
      if (!store.has(k)) return json({ success: false, errors: [{ message: "key not found" }] }, 404);
      return { ok: true, status: 200, text: async () => store.get(k).value, json: async () => null };
    }
    throw new Error("unexpected " + url);
  };
  return { fetchImpl, calls };
}

async function run(store, opts) {
  const { fetchImpl, calls } = fakeKv(store, opts);
  const kv = kvApi({ accountId: "acc", namespaceId: "ns1", token: "TOKEN", fetchImpl, minIntervalMs: 0, sleep: async () => {} });
  const lines = [];
  const counts = await dumpKv(kv, (l) => lines.push(l), { now: new Date(0) });
  return { lines, counts, calls };
}

describe("the daily KV backup", () => {
  it("covers every prefix that holds user data only KV has", () => {
    for (const p of MUST_COVER) assert.ok(KV_BACKUP_PREFIXES.includes(p), `${p} is not backed up`);
  });

  it("copies every key and value under those prefixes, once each, and nothing else", async () => {
    const store = sampleStore();
    const { lines, counts } = await run(store);
    const recs = lines.slice(1).map((l) => JSON.parse(l));
    const keys = recs.map((r) => r.key).sort();
    const want = [...store.keys()].filter((k) => MUST_COVER.some((p) => k.startsWith(p))).sort();
    assert.deepEqual(keys, want);
    for (const r of recs) assert.equal(r.value, store.get(r.key).value);
    assert.deepEqual(recs.find((r) => r.key === "cfg:k0").metadata, { v: 2 });
    assert.ok(!keys.some((k) => k.startsWith("cache:") || k.startsWith("cron:")));
    for (const p of MUST_COVER) assert.equal(counts[p], 3, `${p} counted under its own prefix`);
    const r = await verifyKvDump(lines, counts);
    assert.equal(r.ok, true, r.problems.join("; "));
    assert.equal(r.keys, MUST_COVER.length * 3);
  });

  it("reads one key at a time when the bulk read is not there", async () => {
    const { lines, calls } = await run(sampleStore(), { noBulk: true });
    assert.equal(lines.length - 1, MUST_COVER.length * 3);
    assert.ok(calls.some((c) => /\/values\//.test(c.path)));
  });

  it("fails the run when a page of keys cannot be read", async () => {
    await assert.rejects(run(sampleStore(), { failList: "channelshare:" }), /KV list of channelshare: failed \(boom\)/);
  });

  it("names the permission when the token cannot read KV", async () => {
    await assert.rejects(run(sampleStore(), { status: 403 }), /Workers KV Storage -> Read/);
  });

  it("sends the token to the namespace's API", async () => {
    const { calls } = await run(sampleStore());
    assert.equal(calls[0].path, "/client/v4/accounts/acc/storage/kv/namespaces/ns1/keys");
  });
});

describe("kv-backup-verify: a kept KV backup must restore", () => {
  it("fails a file cut short, a broken line, and counts that do not match", async () => {
    const { lines, counts } = await run(sampleStore());
    assert.equal((await verifyKvDump(lines.slice(0, 5), counts)).ok, false);
    const wrong = await verifyKvDump(lines, { ...counts, "cfg:": 4 });
    assert.equal(wrong.ok, false);
    assert.match(wrong.problems.join(" "), /cfg: 3 keys in the file, 4 read from KV/);
    assert.equal((await verifyKvDump([lines[0], "{not json"], counts)).ok, false);
    assert.equal((await verifyKvDump([], counts)).ok, false);
  });
});
