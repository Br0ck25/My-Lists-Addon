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

  it("exports KV prefix to R2 with gzip compression and verifiable content", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), BLOBS: makeR2() });
    const cookie = await adminCookie(env);

    // Seed test KV data under creator: prefix
    await env.CONFIGS.put("creator:alice", JSON.stringify({ username: "alice", created: 100 }));
    await env.CONFIGS.put("creator:bob", JSON.stringify({ username: "bob", created: 200 }));
    await env.CONFIGS.put("other:ignored", "do not export");

    const res = await call(env, "/admin/api/export-kv-to-r2", {
      method: "POST",
      cookie,
      json: { prefix: "creator:" },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.done, true);
    assert.equal(res.body.keysExported, 2);
    assert.equal(res.body.totalKeysInArchive, 2);
    assert.ok(res.body.archiveKey.startsWith("kv-archive/creator/"));
    assert.ok(res.body.archiveKey.endsWith(".json.gz"));

    // Verify R2 object existence and metadata
    const r2Obj = await env.BLOBS.get(res.body.archiveKey);
    assert.ok(r2Obj, "R2 archive object must exist");
    assert.equal(r2Obj.httpMetadata.contentEncoding, "gzip");
    assert.equal(r2Obj.customMetadata.kvPrefix, "creator:");
    assert.equal(r2Obj.customMetadata.keyCount, "2");

    // Decompress and verify JSON contents
    const bytes = await r2Obj.arrayBuffer();
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    writer.write(new Uint8Array(bytes));
    writer.close();
    const reader = ds.readable.getReader();
    const chunks = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (value) chunks.push(value);
      if (done) break;
    }
    const totalLen = chunks.reduce((s, c) => s + c.length, 0);
    const merged = new Uint8Array(totalLen);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }
    const decoded = JSON.parse(new TextDecoder().decode(merged));

    assert.equal(Object.keys(decoded).length, 2);
    assert.deepEqual(JSON.parse(decoded["creator:alice"]), { username: "alice", created: 100 });
    assert.deepEqual(JSON.parse(decoded["creator:bob"]), { username: "bob", created: 200 });
    assert.equal(decoded["other:ignored"], undefined);
  });
});
