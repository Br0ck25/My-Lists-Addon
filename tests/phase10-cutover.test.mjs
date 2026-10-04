// Phase 10 Cutover & Sunset tests (P10-1, P10-2, P10-3).
// Verifies:
//  - P10-2 in-app sunset notices helper and /api/creator/sync/load response field.
//  - P10-3 /admin/api/export-kv-to-r2 endpoint (auth, R2 export, gzip compression, multi-batch append).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { call, createUser, makeD1, makeEnv, makeKv, makeR2 } from "./harness.mjs";

async function adminCookie(env) {
  const r = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
  return (r.headers.get("set-cookie") || "").split(";")[0];
}

describe("P10-2: In-app sunset announcements", () => {
  it("returns no sunset notices when SUNSET_60DAY_START_DATE is unset", async () => {
    const env = makeEnv({ DB: makeD1() });
    const user = await createUser(env, "sunset_user_1");
    const res = await call(env, "/api/creator/sync/load", {
      method: "POST",
      json: { creatorName: user.creatorName, creatorKey: user.creatorKey },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.sunset_notices));
    assert.equal(res.body.sunset_notices.length, 0);
  });

  it("returns no sunset notices when SUNSET_60DAY_START_DATE is in the future", async () => {
    const env = makeEnv({
      DB: makeD1(),
      SUNSET_60DAY_START_DATE: "2099-01-01",
    });
    const user = await createUser(env, "sunset_user_2");
    const res = await call(env, "/api/creator/sync/load", {
      method: "POST",
      json: { creatorName: user.creatorName, creatorKey: user.creatorKey },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.sunset_notices));
    assert.equal(res.body.sunset_notices.length, 0);
  });

  it("returns 7 sunset notices with urgency and days remaining when active", async () => {
    // 10 days ago -> ~50 days remaining
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const env = makeEnv({
      DB: makeD1(),
      SUNSET_60DAY_START_DATE: tenDaysAgo,
    });
    const user = await createUser(env, "sunset_user_3");
    const res = await call(env, "/api/creator/sync/load", {
      method: "POST",
      json: { creatorName: user.creatorName, creatorKey: user.creatorKey },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.sunset_notices));
    assert.equal(res.body.sunset_notices.length, 7);

    const features = res.body.sunset_notices.map((n) => n.feature);
    assert.ok(features.includes("key-in-body-auth"));
    assert.ok(features.includes("sync-shims"));
    assert.ok(features.includes("api-resolve"));
    assert.ok(features.includes("legacy-unverified-config-shelves"));
    assert.ok(features.includes("scrobble-legacy-auth"));
    assert.ok(features.includes("sha256-key-lookups"));
    assert.ok(features.includes("list-tombstones"));

    for (const notice of res.body.sunset_notices) {
      assert.ok(notice.daysRemaining >= 48 && notice.daysRemaining <= 51);
      assert.equal(notice.urgency, "info");
      assert.ok(notice.message.includes(String(notice.daysRemaining)));
    }
  });

  it("reports 'urgent' when sunset is within 7 days", async () => {
    // 55 days ago -> ~5 days remaining
    const fiftyFiveDaysAgo = new Date(Date.now() - 55 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const env = makeEnv({
      DB: makeD1(),
      SUNSET_60DAY_START_DATE: fiftyFiveDaysAgo,
    });
    const user = await createUser(env, "sunset_user_4");
    const res = await call(env, "/api/creator/sync/load", {
      method: "POST",
      json: { creatorName: user.creatorName, creatorKey: user.creatorKey },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.sunset_notices));
    assert.equal(res.body.sunset_notices.length, 7);
    for (const notice of res.body.sunset_notices) {
      assert.equal(notice.urgency, "urgent");
    }
  });
});

describe("P10-3: KV Export to R2 Admin Tool", () => {
  it("rejects unauthorized requests", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), BLOBS: makeR2() });
    const res = await call(env, "/admin/api/export-kv-to-r2", {
      method: "POST",
      json: { prefix: "test:" },
    });
    assert.equal(res.status, 401);
  });

  it("rejects missing prefix parameter", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), BLOBS: makeR2() });
    const cookie = await adminCookie(env);
    const res = await call(env, "/admin/api/export-kv-to-r2", {
      method: "POST",
      cookie,
      json: {},
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /prefix is required/);
  });

  it("fails cleanly when BLOBS binding is missing", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), BLOBS: null });
    const cookie = await adminCookie(env);
    const res = await call(env, "/admin/api/export-kv-to-r2", {
      method: "POST",
      cookie,
      json: { prefix: "test:" },
    });
    assert.equal(res.status, 500);
    assert.match(res.body.error, /No R2 BLOBS binding/);
  });

  // Reads one archived object back: gunzip, then JSON.
  async function readArchive(env, key) {
    const obj = await env.BLOBS.get(key);
    assert.ok(obj, "missing " + key);
    const text = await new Response(new Blob([await obj.arrayBuffer()]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    return { obj, body: JSON.parse(text) };
  }

  // What the admin page does: call until done, carrying the run along.
  async function exportAll(env, cookie, prefix) {
    let state = { prefix };
    const calls = [];
    for (let i = 0; i < 50; i++) {
      const res = await call(env, "/admin/api/export-kv-to-r2", { method: "POST", cookie, json: state });
      calls.push(res);
      if (!res.body.ok || res.body.done) break;
      state = { prefix, runId: res.body.runId, part: res.body.part + 1, keysSoFar: res.body.keysSoFar, cursor: res.body.cursor };
    }
    return calls;
  }

  it("copies a prefix into R2, gzipped, and writes the manifest last", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), BLOBS: makeR2() });
    const cookie = await adminCookie(env);
    await env.CONFIGS.put("creator:alice", JSON.stringify({ username: "alice", created: 100 }));
    await env.CONFIGS.put("creator:bob", JSON.stringify({ username: "bob", created: 200 }), { metadata: { v: 2 } });
    await env.CONFIGS.put("other:ignored", "do not export");

    const [res] = await exportAll(env, cookie, "creator:");
    assert.equal(res.status, 200);
    assert.equal(res.body.done, true);
    assert.equal(res.body.keysExported, 2);
    assert.match(res.body.partKey, /^kv-archive\/creator\/[0-9TZ-]+\/part-00001\.json\.gz$/);

    const { obj, body } = await readArchive(env, res.body.partKey);
    assert.equal(obj.httpMetadata.contentEncoding, "gzip");
    assert.equal(obj.customMetadata.kvPrefix, "creator:");
    assert.deepEqual(body.entries.map((e) => e.key), ["creator:alice", "creator:bob"]);
    assert.deepEqual(JSON.parse(body.entries[0].text), { username: "alice", created: 100 });
    assert.deepEqual(body.entries[1].metadata, { v: 2 }, "a key's metadata comes with it");

    const manifest = JSON.parse(await (await env.BLOBS.get(res.body.manifestKey)).text());
    assert.equal(manifest.keys, 2);
    assert.equal(manifest.parts, 1);
  });

  it("keeps a binary value (a Better Poster image) byte for byte", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), BLOBS: makeR2() });
    const cookie = await adminCookie(env);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x80, 0x81, 0xfe, 0xff]);
    await env.CONFIGS.put("bpimg:v1:poster:tt1", jpeg.buffer);
    const [res] = await exportAll(env, cookie, "bpimg:");
    const { body } = await readArchive(env, res.body.partKey);
    assert.equal(body.entries[0].text, undefined);
    assert.deepEqual([...Buffer.from(body.entries[0].base64, "base64")], [...jpeg]);
  });

  it("writes each batch as its own object, in one run, and counts every key", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), BLOBS: makeR2() });
    const cookie = await adminCookie(env);
    for (let i = 0; i < 120; i++) await env.CONFIGS.put("stats:k" + String(i).padStart(3, "0") + ":total", String(i));
    const calls = await exportAll(env, cookie, "stats:");
    assert.equal(calls.length, 3, "50 keys a batch");
    const runIds = new Set(calls.map((c) => c.body.runId));
    assert.equal(runIds.size, 1, "one run from the first call to the last");
    const last = calls[calls.length - 1].body;
    assert.equal(last.keysSoFar, 120);
    let seen = 0;
    for (const c of calls) seen += (await readArchive(env, c.body.partKey)).body.entries.length;
    assert.equal(seen, 120);
    assert.equal(JSON.parse(await (await env.BLOBS.get(last.manifestKey)).text()).keys, 120);
  });

  it("a storage failure fails that call, and writes no manifest", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), BLOBS: makeR2() });
    const cookie = await adminCookie(env);
    for (let i = 0; i < 60; i++) await env.CONFIGS.put("feedback:" + String(i).padStart(2, "0"), "x");
    const first = await call(env, "/admin/api/export-kv-to-r2", { method: "POST", cookie, json: { prefix: "feedback:" } });
    assert.equal(first.body.done, false);
    env.BLOBS._hooks.beforePut = async () => { throw new Error("R2 down"); };
    const second = await call(env, "/admin/api/export-kv-to-r2", { method: "POST", cookie, json: { prefix: "feedback:", runId: first.body.runId, part: 2, keysSoFar: 50, cursor: first.body.cursor } });
    env.BLOBS._hooks.beforePut = null;
    assert.notEqual(second.status, 200);
    assert.equal([...env.BLOBS._store.keys()].filter((k) => k.endsWith("manifest.json")).length, 0);
    assert.ok(env.BLOBS._store.has(first.body.partKey), "the first batch is untouched");
  });

  it("refuses a wildcard, which KV would match literally and find nothing", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), BLOBS: makeR2() });
    const cookie = await adminCookie(env);
    const res = await call(env, "/admin/api/export-kv-to-r2", { method: "POST", cookie, json: { prefix: "stats:*" } });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /leave out the \*/);
  });
});
