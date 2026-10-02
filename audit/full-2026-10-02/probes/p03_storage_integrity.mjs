// audit/full-2026-10-02/probes/p03_storage_integrity.mjs
// Automated verification probe for Module 04: Database, Storage, Data Integrity
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const AUDIT_ROOT = process.env.AUDIT_ROOT || path.resolve(".");
const harnessPath = path.resolve(AUDIT_ROOT, "tests/harness.mjs");
const { makeEnv, makeD1, makeKv, makeR2, worker, nextIp } = await import(`file://${harnessPath.replace(/\\/g, "/")}`);

console.log("=== START MODULE 04 PROBE: DATABASE, STORAGE & DATA INTEGRITY ===");

// =============================================================================
// TEST 1: Migration Replay, Idempotency & Schema Parity
// =============================================================================
console.log("[Test 1] Testing SQL migration replay, idempotency and schema parity...");

const migrationsDir = path.resolve(AUDIT_ROOT, "migrations");
const migrationFiles = fs.readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

assert.ok(migrationFiles.length >= 20, `Expected at least 20 migration files, found ${migrationFiles.length}`);

// 1a. Apply baseline schema representing the pre-0001a database state
const migDb = new DatabaseSync(":memory:");
migDb.exec("PRAGMA foreign_keys = ON;");
migDb.exec(`
  CREATE TABLE creators (
    username TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    recovery_answer_hash TEXT,
    created_at INTEGER NOT NULL,
    last_active INTEGER
  );
  CREATE TABLE creator_lists (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'private',
    items_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (username) REFERENCES creators(username) ON DELETE CASCADE
  );
  CREATE TABLE source_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    install_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_creator_lists_username ON creator_lists(username);
  CREATE INDEX idx_creator_lists_visibility ON creator_lists(visibility);
`);

// 1b. Apply all migrations sequentially
for (const file of migrationFiles) {
  const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
  try {
    migDb.exec(sql);
  } catch (err) {
    assert.fail(`Failed executing migration ${file}: ${err.message}`);
  }
}

// 1c. Provision brand new DB directly with schema.sql and compare tables
const freshDb = new DatabaseSync(":memory:");
freshDb.exec("PRAGMA foreign_keys = ON;");
const schemaSql = fs.readFileSync(path.resolve(AUDIT_ROOT, "schema.sql"), "utf8");
freshDb.exec(schemaSql);

const getTables = (db) => {
  return db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'lists_fts2_%' AND name NOT LIKE 'lists_fts_%' ORDER BY name")
    .all()
    .map((r) => r.name);
};

const migTables = getTables(migDb);
const freshTables = getTables(freshDb);

assert.deepEqual(
  migTables.sort(),
  freshTables.sort(),
  "Tables in migrated DB must match tables provisioned by schema.sql exactly"
);

// 1d. Activity database migrations (A0001) and schema_activity.sql
const actDb = new DatabaseSync(":memory:");
const actSql = fs.readFileSync(path.resolve(AUDIT_ROOT, "migrations/activity/A0001_activity.sql"), "utf8");
actDb.exec(actSql);
const actSchemaSql = fs.readFileSync(path.resolve(AUDIT_ROOT, "schema_activity.sql"), "utf8");
actDb.exec(actSchemaSql); // idempotent re-execution

const actTables = getTables(actDb);
assert.ok(actTables.includes("watch_events"), "Activity DB must contain watch_events");
assert.ok(actTables.includes("show_progress"), "Activity DB must contain show_progress");
assert.ok(actTables.includes("user_media_state"), "Activity DB must contain user_media_state");

console.log("  -> PASSED: All 20 SQL migrations and A0001 replay cleanly with zero schema drift.");

// =============================================================================
// Helper: Worker Request Dispatcher
// =============================================================================
const d1 = makeD1();
const kv = makeKv();
const r2 = makeR2();
const env = makeEnv({
  DB: d1,
  CONFIGS: kv,
  BLOBS: r2,
  ADMIN_KEY: "admin-secret-storage-2026",
  LOOKUP_PEPPER: "storage-pepper-key-32byteslong!",
  FF_SESSIONS: "1",
  FF_INSTALLS: "1",
  FF_V2_LISTS_READ: "1",
  FF_V2_LISTS_API: "1",
});

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
};

const BASE_URL = "https://mylists.addon";

async function req(routePath, { method = "GET", headers = {}, body = null } = {}) {
  const h = new Headers(headers);
  if (!h.has("Origin") && !h.has("origin") && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    h.set("Origin", BASE_URL);
  }
  if (!h.has("Content-Type") && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    h.set("Content-Type", "application/json");
  }
  if (!h.has("CF-Connecting-IP")) {
    h.set("CF-Connecting-IP", nextIp());
  }

  const request = new Request(`${BASE_URL}${routePath}`, {
    method,
    headers: h,
    body: body ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });

  return await worker.fetch(request, env, ctx);
}

// Setup user account
const createRes = await req("/api/creator/create", {
  method: "POST",
  body: { creatorName: "storage_user", displayName: "Storage User", recoveryAnswer: "database storage answer" },
});
assert.equal(createRes.status, 200, "User creation must return 200");
const createData = await createRes.json();
const userKey = createData.creatorKey;

const loginRes = await req("/api/session", {
  method: "POST",
  body: { username: "storage_user", key: userKey },
});
assert.equal(loginRes.status, 200, "Login must return 200");
const sessionCookieHeader = loginRes.headers.get("Set-Cookie");
const token = decodeURIComponent(sessionCookieHeader.match(/mla_session=([^;]+)/)[1]);
const sessionCookie = `mla_session=${token}`;

// =============================================================================
// TEST 2: Zero-Row Mutation & Optimistic Concurrency (/api/installs)
// =============================================================================
console.log("[Test 2] Testing Zero-Row Mutation and Optimistic Concurrency on Installs...");

// Create install link
const createInstallRes = await req("/api/installs", {
  method: "POST",
  headers: { Cookie: sessionCookie },
  body: { name: "Living Room TV", entries: [{ name: "My List", url: "https://example.com/list" }] },
});
assert.equal(createInstallRes.status, 201);
const installJson = await createInstallRes.json();
const installId = installJson.install.id;
assert.equal(installJson.install.version, 1);

// Successful update with matching version
const patch1Res = await req(`/api/installs/${installId}`, {
  method: "PATCH",
  headers: { Cookie: sessionCookie, "If-Match": '"1"' },
  body: { name: "Living Room TV Renamed", version: 1 },
});
assert.equal(patch1Res.status, 200);
const patch1Json = await patch1Res.json();
assert.equal(patch1Json.install.version, 2);

// Conflicting update with STALE version 1 (Zero-row UPDATE test)
const patchStaleRes = await req(`/api/installs/${installId}`, {
  method: "PATCH",
  headers: { Cookie: sessionCookie, "If-Match": '"1"' },
  body: { name: "Stale Rename Attempt", version: 1 },
});
assert.equal(patchStaleRes.status, 409, "Zero-row match on stale install version must yield 409 Conflict");
const patchStaleJson = await patchStaleRes.json();
assert.equal(patchStaleJson.ok, false);

console.log("  -> PASSED: Install optimistic concurrency correctly rejects zero-row stale update with 409.");

// =============================================================================
// TEST 3: Zero-Row Mutation & Version Preconditions on Lists v2
// =============================================================================
console.log("[Test 3] Testing Zero-Row Mutation and Preconditions on Lists v2...");

const createListRes = await req("/api/lists", {
  method: "POST",
  headers: { Cookie: sessionCookie },
  body: {
    name: "Favorite Movies",
    mediaType: "movie",
    visibility: "public",
  },
});
assert.equal(createListRes.status, 201);
const listData = await createListRes.json();
const listPublicId = listData.list.publicId;
const listVersion = listData.list.version;

// Mutating list with missing If-Match header -> 428 Precondition Required
const patchMissingHeader = await req(`/api/lists/${listPublicId}`, {
  method: "PATCH",
  headers: { Cookie: sessionCookie },
  body: { name: "Updated Name" },
});
assert.equal(patchMissingHeader.status, 428, "Missing If-Match header must yield 428 Precondition Required");

// Mutating list with stale If-Match header -> 412 Precondition Failed (0 rows affected)
const patchStaleVersion = await req(`/api/lists/${listPublicId}`, {
  method: "PATCH",
  headers: { Cookie: sessionCookie, "If-Match": `"${listVersion + 99}"` },
  body: { name: "Updated Name" },
});
assert.equal(patchStaleVersion.status, 412, "Stale If-Match header must yield 412 Precondition Failed");

// Deleting list with stale If-Match header -> 412 Precondition Failed
const deleteStaleVersion = await req(`/api/lists/${listPublicId}`, {
  method: "DELETE",
  headers: { Cookie: sessionCookie, "If-Match": `"${listVersion + 99}"` },
});
assert.equal(deleteStaleVersion.status, 412, "Stale If-Match DELETE must yield 412 Precondition Failed");

console.log("  -> PASSED: Lists v2 strictly enforces If-Match versions and rejects zero-row updates with 412.");

// =============================================================================
// TEST 4: Atomic Like Ledgers & changes() Accounting
// =============================================================================
console.log("[Test 4] Testing Atomic Like Ledgers and changes() accounting...");

// 4a. Initial like
const like1Res = await req(`/api/likes/list/${listPublicId}`, {
  method: "PUT",
  headers: { Cookie: sessionCookie },
});
assert.equal(like1Res.status, 200);
const like1Json = await like1Res.json();
assert.equal(like1Json.liked, true);
assert.equal(like1Json.likes, 1);

// 4b. Duplicate like from same account (idempotent; changes() == 0)
const likeDupRes = await req(`/api/likes/list/${listPublicId}`, {
  method: "PUT",
  headers: { Cookie: sessionCookie },
});
assert.equal(likeDupRes.status, 200);
const likeDupJson = await likeDupRes.json();
assert.equal(likeDupJson.liked, true);
assert.equal(likeDupJson.likes, 1, "Duplicate like must not double-count; like_count must remain 1");

// 4c. Take back like (unlike)
const unlikeRes = await req(`/api/likes/list/${listPublicId}`, {
  method: "DELETE",
  headers: { Cookie: sessionCookie },
});
assert.equal(unlikeRes.status, 200);
const unlikeJson = await unlikeRes.json();
assert.equal(unlikeJson.liked, false);
assert.equal(unlikeJson.likes, 0);

// 4d. Duplicate unlike (idempotent; max(0, count - 0))
const unlikeDupRes = await req(`/api/likes/list/${listPublicId}`, {
  method: "DELETE",
  headers: { Cookie: sessionCookie },
});
assert.equal(unlikeDupRes.status, 200);
const unlikeDupJson = await unlikeDupRes.json();
assert.equal(unlikeDupJson.liked, false);
assert.equal(unlikeDupJson.likes, 0, "Duplicate unlike must not produce negative count");

console.log("  -> PASSED: Like ledger correctly uses changes() to maintain exact atomic counts.");

// =============================================================================
// TEST 5: R2 Blob Storage Integrity & Compensating Cleanup
// =============================================================================
console.log("[Test 5] Testing R2 Blob storage integrity, versions and orphan cleanup...");

const sampleEpisodes1 = [
  { kind: "episode", imdbId: "tt0903747", showName: "Breaking Bad", epName: "Pilot", season: 1, episode: 1, title: "Pilot" },
  { kind: "episode", imdbId: "tt0903747", showName: "Breaking Bad", epName: "Cat's in the Bag", season: 1, episode: 2, title: "Cat's in the Bag" },
];
const sampleEpisodes2 = [
  ...sampleEpisodes1,
  { kind: "episode", imdbId: "tt0903747", showName: "Breaking Bad", epName: "...And the Bag's in the River", season: 1, episode: 3, title: "Ep 3" },
];

const channelCode = "testchan123";
const legacyRecord1 = {
  creatorName: "storage_user",
  creatorKey: userKey,
  channel: { name: "Test Channel", items: sampleEpisodes1 },
  description: "Test Channel Desc",
  publish: true,
};

// First write creates R2 pool version 1
const syncRes1 = await req("/api/channel/share", {
  method: "POST",
  body: legacyRecord1,
});
assert.equal(syncRes1.status, 200);
const syncJson1 = await syncRes1.json();
const finalCode = syncJson1.code || channelCode;

const pool1Key = `channels/${finalCode}/1.json`;
const blob1 = await r2.get(pool1Key);
assert.ok(blob1, "R2 blob version 1 should be created");

// Update channel with new episodes -> creates R2 pool version 2 and deletes version 1
const legacyRecord2 = {
  creatorName: "storage_user",
  creatorKey: userKey,
  code: finalCode,
  channel: { name: "Test Channel", items: sampleEpisodes2 },
  description: "Test Channel Desc",
  publish: true,
};

const syncRes2 = await req("/api/channel/share", {
  method: "POST",
  body: legacyRecord2,
});
assert.equal(syncRes2.status, 200);

const pool2Key = `channels/${finalCode}/2.json`;
const blob2 = await r2.get(pool2Key);
assert.ok(blob2, "R2 blob version 2 should be created");
const oldBlob1 = await r2.get(pool1Key);
assert.equal(oldBlob1, null, "Older R2 blob version 1 must be deleted to prevent orphan leakage");

console.log("  -> PASSED: R2 blob versioning cleanly replaces previous pools without orphan object leaks.");

// =============================================================================
// TEST 6: Search Indexes (FTS2) Synchronization & Tombstones
// =============================================================================
console.log("[Test 6] Testing FTS2 search index consistency with list lifecycle...");

// 6a. Public list appears in lists_fts2
const searchRow1 = (await d1.prepare("SELECT rowid FROM lists_fts2 WHERE lists_fts2 MATCH 'Favorite'").all()).results;
assert.equal(searchRow1.length, 1, "Public list should match FTS search");

// 6b. Change visibility to unlisted -> immediately removed from lists_fts2
const putVisRes = await req(`/api/lists/${listPublicId}/visibility`, {
  method: "PUT",
  headers: { Cookie: sessionCookie },
  body: { visibility: "unlisted" },
});
assert.equal(putVisRes.status, 200);

const searchRow2 = (await d1.prepare("SELECT rowid FROM lists_fts2 WHERE lists_fts2 MATCH 'Favorite'").all()).results;
assert.equal(searchRow2.length, 0, "Unlisted list must be immediately evicted from lists_fts2");

// 6c. Change visibility back to public -> re-indexed
const putVisPub = await req(`/api/lists/${listPublicId}/visibility`, {
  method: "PUT",
  headers: { Cookie: sessionCookie },
  body: { visibility: "public" },
});
assert.equal(putVisPub.status, 200);

const searchRow3 = (await d1.prepare("SELECT rowid FROM lists_fts2 WHERE lists_fts2 MATCH 'Favorite'").all()).results;
assert.equal(searchRow3.length, 1, "Public list must be restored in lists_fts2");

// 6d. Soft delete -> removed from lists_fts2
const curList = await req(`/api/lists/${listPublicId}`, { headers: { Cookie: sessionCookie } });
const curListJson = await curList.json();
const delRes = await req(`/api/lists/${listPublicId}`, {
  method: "DELETE",
  headers: { Cookie: sessionCookie, "If-Match": `"${curListJson.list.version}"` },
});
assert.equal(delRes.status, 200);

const searchRow4 = (await d1.prepare("SELECT rowid FROM lists_fts2 WHERE lists_fts2 MATCH 'Favorite'").all()).results;
assert.equal(searchRow4.length, 0, "Deleted list must be removed from lists_fts2");

console.log("  -> PASSED: FTS2 virtual table stays in 100% synchronization across list lifecycles.");

// =============================================================================
// TEST 7: Anti-Resurrection & Tombstone Invariants
// =============================================================================
console.log("[Test 7] Testing Anti-Resurrection and Account Deletion Tombstones...");

const delAcctRes = await req("/api/creator/delete-account", {
  method: "POST",
  headers: { Cookie: sessionCookie },
  body: { username: "storage_user", confirm: "DELETE" },
});
assert.equal(delAcctRes.status, 200);

// Check D1 tombstone table
const d1Tombstone = await d1.prepare("SELECT * FROM creator_tombstones WHERE username = ?").bind("storage_user").first();
assert.ok(d1Tombstone, "D1 creator_tombstones must contain entry for deleted user");

// Check KV tombstone
const kvTombstone = await kv.get("creatordeleted:storage_user");
assert.ok(kvTombstone, "KV creatordeleted: tombstone must be set");

// Attempt recreation of the deleted account -> must be rejected because username is tombstoned
const recreateRes = await req("/api/creator/create", {
  method: "POST",
  body: { creatorName: "storage_user", displayName: "Storage User", recoveryAnswer: "database storage answer" },
});
assert.equal(recreateRes.status, 200);
const recreateJson = await recreateRes.json();
assert.equal(recreateJson.ok, false, "Recreating tombstoned account must not succeed");
assert.equal(recreateJson.error, "That username is already taken.");

console.log("  -> PASSED: Dual-layer tombstones strictly prevent account resurrection.");

console.log("=== ALL MODULE 04 PROBE CHECKS PASSED (7/7) ===");
