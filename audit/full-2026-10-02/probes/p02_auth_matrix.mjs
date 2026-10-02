// audit/full-2026-10-02/probes/p02_auth_matrix.mjs
// Automated verification probe with positive and negative controls for Module 03: Authentication, Authorization & Session Security Matrix
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";

const AUDIT_ROOT = process.env.AUDIT_ROOT || path.resolve(".");
const harnessPath = path.resolve(AUDIT_ROOT, "tests/harness.mjs");
const { makeEnv, makeD1, makeKv, worker, nextIp } = await import(`file://${harnessPath.replace(/\\/g, "/")}`);

console.log("=== START MODULE 03 PROBE: AUTH & AUTHORIZATION MATRIX (NEGATIVE CONTROLS) ===");

const d1 = makeD1();
const kv = makeKv();
const env = makeEnv({
  DB: d1,
  CONFIGS: kv,
  ADMIN_KEY: "admin-secret-matrix-2026",
  LOOKUP_PEPPER: "matrix-pepper-key-32byteslong!",
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

// -----------------------------------------------------------------------------
// Setup: Create User A and User B
// -----------------------------------------------------------------------------
console.log("[Setup] Creating test accounts User A and User B...");

const userARes = await req("/api/creator/create", {
  method: "POST",
  body: { creatorName: "matrix_user_a", displayName: "User Alpha", recoveryAnswer: "AlphaRecovery1" },
});
assert.equal(userARes.status, 200, "User A creation must return 200");
const keyA = (await userARes.json()).creatorKey;

const userBRes = await req("/api/creator/create", {
  method: "POST",
  body: { creatorName: "matrix_user_b", displayName: "User Beta", recoveryAnswer: "BetaRecovery2" },
});
assert.equal(userBRes.status, 200, "User B creation must return 200");
const keyB = (await userBRes.json()).creatorKey;

// Log in User A
const loginARes = await req("/api/session", {
  method: "POST",
  body: { username: "matrix_user_a", key: keyA },
});
assert.equal(loginARes.status, 200, "User A login must return 200");
const sessionCookieA = loginARes.headers.get("Set-Cookie");
const tokenA = decodeURIComponent(sessionCookieA.match(/mla_session=([^;]+)/)[1]);

// Log in User B
const loginBRes = await req("/api/session", {
  method: "POST",
  body: { username: "matrix_user_b", key: keyB },
});
assert.equal(loginBRes.status, 200, "User B login must return 200");
const sessionCookieB = loginBRes.headers.get("Set-Cookie");
const tokenB = decodeURIComponent(sessionCookieB.match(/mla_session=([^;]+)/)[1]);

console.log("  -> User A and User B created and authenticated.");

// -----------------------------------------------------------------------------
// Test 1: Cross-Account Resource Isolation (User A -> User B's resources)
// -----------------------------------------------------------------------------
console.log("[Test 1] Testing User A -> User B cross-account access with negative controls...");

// 1a. /api/creator/sync/load
const aLoadingB = await req("/api/creator/sync/load", {
  method: "POST",
  headers: { "Cookie": `mla_session=${tokenA}` },
  body: { creatorName: "matrix_user_b" },
});
assert.equal(aLoadingB.status, 401, "User A loading User B sync data must return 401");

const bLoadingB = await req("/api/creator/sync/load", {
  method: "POST",
  headers: { "Cookie": `mla_session=${tokenB}` },
  body: { creatorName: "matrix_user_b" },
});
assert.equal(bLoadingB.status, 200, "Negative Control: User B loading User B sync data must succeed (200)");

// 1b. /api/creator/sync/save
const aSavingB = await req("/api/creator/sync/save", {
  method: "POST",
  headers: { "Cookie": `mla_session=${tokenA}` },
  body: { creatorName: "matrix_user_b", config: [] },
});
assert.equal(aSavingB.status, 401, "User A saving to User B must return 401");

const bSavingB = await req("/api/creator/sync/save", {
  method: "POST",
  headers: { "Cookie": `mla_session=${tokenB}` },
  body: { creatorName: "matrix_user_b", config: [] },
});
assert.equal(bSavingB.status, 200, "Negative Control: User B saving to User B must succeed (200)");

// 1c. /api/creator/lists
const aListingB = await req("/api/creator/lists", {
  method: "POST",
  headers: { "Cookie": `mla_session=${tokenA}` },
  body: { creatorName: "matrix_user_b" },
});
assert.equal(aListingB.status, 401, "User A listing User B lists must return 401");

const bListingB = await req("/api/creator/lists", {
  method: "POST",
  headers: { "Cookie": `mla_session=${tokenB}` },
  body: { creatorName: "matrix_user_b" },
});
assert.equal(bListingB.status, 200, "Negative Control: User B listing User B lists must succeed (200)");

console.log("  -> PASSED: Cross-creator isolation verified with positive/negative controls.");

// -----------------------------------------------------------------------------
// Test 2: Installs API Ownership & Isolation
// -----------------------------------------------------------------------------
console.log("[Test 2] Testing /api/installs ownership enforcement...");

// Create install for User B
const createInstallB = await req("/api/installs", {
  method: "POST",
  headers: { "Cookie": `mla_session=${tokenB}` },
  body: {
    name: "User B Device",
    entries: [{ name: "My List", url: "https://example.com/list" }],
  },
});
assert.equal(createInstallB.status, 201, "Create install must return 201");
const installBData = await createInstallB.json();
const installIdB = installBData.install.id;
assert.ok(installIdB);

// User A attempts to view User B's install -> 404
const aViewingInstallB = await req(`/api/installs/${installIdB}`, {
  method: "GET",
  headers: { "Cookie": `mla_session=${tokenA}` },
});
assert.equal(aViewingInstallB.status, 404, "User A viewing User B's install must return 404");

// Negative Control: User B views their own install -> 200
const bViewingInstallB = await req(`/api/installs/${installIdB}`, {
  method: "GET",
  headers: { "Cookie": `mla_session=${tokenB}` },
});
assert.equal(bViewingInstallB.status, 200, "Negative Control: User B viewing their own install must succeed (200)");

// User A attempts to delete User B's install -> 404
const aDeletingInstallB = await req(`/api/installs/${installIdB}`, {
  method: "DELETE",
  headers: { "Cookie": `mla_session=${tokenA}` },
});
assert.equal(aDeletingInstallB.status, 404, "User A deleting User B's install must return 404");

// Anonymous attempts to view installs -> 401
const anonViewingInstalls = await req("/api/installs", { method: "GET" });
assert.equal(anonViewingInstalls.status, 401, "Anonymous viewing installs must return 401");

console.log("  -> PASSED: /api/installs IDOR boundaries verified with positive/negative controls.");

// -----------------------------------------------------------------------------
// Test 3: Lists v2 Ownership & Access Control
// -----------------------------------------------------------------------------
console.log("[Test 3] Testing /api/lists v2 ownership enforcement...");

// Create private list for User B
const createListB = await req("/api/lists", {
  method: "POST",
  headers: { "Cookie": `mla_session=${tokenB}` },
  body: { name: "Beta Private List", mediaType: "mixed", visibility: "private", items: [] },
});
assert.equal(createListB.status, 201, "List creation must return 201");
const listBData = await createListB.json();
const publicIdB = listBData.list.publicId;
assert.ok(publicIdB);

// User A attempts to read User B's private list -> 404
const aReadingListB = await req(`/api/lists/${publicIdB}`, {
  method: "GET",
  headers: { "Cookie": `mla_session=${tokenA}` },
});
assert.equal(aReadingListB.status, 404, "User A reading User B's private list must return 404");

// Anonymous attempts to read User B's private list -> 404
const anonReadingListB = await req(`/api/lists/${publicIdB}`, { method: "GET" });
assert.equal(anonReadingListB.status, 404, "Anonymous reading private list must return 404");

// Negative Control: User B reads their own private list -> 200
const bReadingListB = await req(`/api/lists/${publicIdB}`, {
  method: "GET",
  headers: { "Cookie": `mla_session=${tokenB}` },
});
assert.equal(bReadingListB.status, 200, "Negative Control: User B reading their own private list must succeed (200)");

// User A attempts to delete User B's list -> 404
const aDeletingListB = await req(`/api/lists/${publicIdB}`, {
  method: "DELETE",
  headers: { "Cookie": `mla_session=${tokenA}`, "If-Match": `"${listBData.list.version}"` },
});
assert.equal(aDeletingListB.status, 404, "User A deleting User B's private list must return 404");

console.log("  -> PASSED: /api/lists v2 ownership strictly enforced; private lists invisible to other users.");

// -----------------------------------------------------------------------------
// Test 4: Stale Tokens, Key Rotation & Cascading Session Revocation
// -----------------------------------------------------------------------------
console.log("[Test 4] Testing Key Rotation & Session Invalidation...");

// Rotate User A's key via recovery answer
const rotateRes = await req("/api/creator/reset-key", {
  method: "POST",
  body: { username: "matrix_user_a", recoveryAnswer: "AlphaRecovery1" },
});
assert.equal(rotateRes.status, 200, "Reset key must return 200");
const newKeyA = (await rotateRes.json()).creatorKey;
assert.notEqual(newKeyA, keyA, "New key must be distinct from old key");

// Stale session A (minted before key reset) must now be rejected
const staleSessionCheck = await req("/api/me", {
  method: "GET",
  headers: { "Cookie": `mla_session=${tokenA}` },
});
assert.equal(staleSessionCheck.status, 401, "Stale session after key reset must return 401");

// Negative Control: Old key cannot sign in, new key CAN sign in
const oldKeyLogin = await req("/api/session", {
  method: "POST",
  body: { username: "matrix_user_a", key: keyA },
});
assert.equal(oldKeyLogin.status, 401, "Old key after reset must return 401");

const newKeyLogin = await req("/api/session", {
  method: "POST",
  body: { username: "matrix_user_a", key: newKeyA },
});
assert.equal(newKeyLogin.status, 200, "Negative Control: New key after reset must sign in (200)");

console.log("  -> PASSED: Key reset cascades immediate revocation to all active sessions.");

// -----------------------------------------------------------------------------
// Test 5: Expired & Revoked Sessions, Malformed Tokens
// -----------------------------------------------------------------------------
console.log("[Test 5] Testing Expired, Revoked, and Malformed Session Tokens...");

// 5a. Malformed token string
const malformedRes = await req("/api/me", {
  method: "GET",
  headers: { "Cookie": "mla_session=invalid-format-random-junk" },
});
assert.equal(malformedRes.status, 401, "Malformed token must return 401");

// 5b. Expired token in D1
const expToken = "expired_test_token_32chars_long!";
const expHash = crypto.createHash("sha256").update(expToken).digest("hex");
const accRow = await d1.prepare("SELECT id FROM accounts WHERE username = 'matrix_user_b'").first();
await d1.prepare(
  "INSERT INTO sessions (id_hash, account_id, created_at, last_seen_at, expires_at, revoked_at) " +
  "VALUES (?, ?, ?, ?, ?, NULL)"
).bind(expHash, accRow.id, Date.now() - 100000, Date.now() - 100000, Date.now() - 1000).run();

const expiredRes = await req("/api/me", {
  method: "GET",
  headers: { "Cookie": `mla_session=${expToken}` },
});
assert.equal(expiredRes.status, 401, "Expired session in D1 must return 401");

// 5c. Revoked token in D1
const revToken = "revoked_test_token_32chars_long!";
const revHash = crypto.createHash("sha256").update(revToken).digest("hex");
await d1.prepare(
  "INSERT INTO sessions (id_hash, account_id, created_at, last_seen_at, expires_at, revoked_at) " +
  "VALUES (?, ?, ?, ?, ?, ?)"
).bind(revHash, accRow.id, Date.now() - 1000, Date.now() - 1000, Date.now() + 1000000, Date.now() - 500).run();

const revokedRes = await req("/api/me", {
  method: "GET",
  headers: { "Cookie": `mla_session=${revToken}` },
});
assert.equal(revokedRes.status, 401, "Revoked session in D1 must return 401");

console.log("  -> PASSED: Expired, revoked, and malformed tokens strictly rejected.");

// -----------------------------------------------------------------------------
// Test 6: Admin Authorization Boundaries & Privilege Escalation Defense
// -----------------------------------------------------------------------------
console.log("[Test 6] Testing Admin Authorization Boundaries...");

// Regular user session attempting admin actions
const userAOnAdminApi = await req("/admin/api/admin-sessions", {
  method: "GET",
  headers: { "Cookie": `mla_session=${tokenB}` },
});
assert.equal(userAOnAdminApi.status, 401, "Regular user session accessing /admin/api must return 401");

// Creator Key passed to admin endpoint
const keyOnAdminApi = await req("/admin/api/admin-sessions", {
  method: "GET",
  headers: { "x-creator-key": keyB },
});
assert.equal(keyOnAdminApi.status, 401, "Creator key on admin API must return 401");

// Valid Admin Key login
const adminLogin = await worker.fetch(new Request(`${BASE_URL}/admin/login`, {
  method: "POST",
  headers: {
    "Origin": BASE_URL,
    "Content-Type": "application/x-www-form-urlencoded",
    "CF-Connecting-IP": nextIp(),
  },
  body: "key=admin-secret-matrix-2026",
}), env, ctx);
assert.equal(adminLogin.status, 302, "Admin login with correct key must redirect (302)");
const adminToken = adminLogin.headers.get("Set-Cookie").match(/mla_admin=([^;]+)/)[1];

// Negative Control: Authenticated Admin accessing admin API
const adminApiSuccess = await req("/admin/api/admin-sessions", {
  method: "GET",
  headers: { "Cookie": `mla_admin=${adminToken}` },
});
assert.equal(adminApiSuccess.status, 200, "Negative Control: Authenticated Admin on /admin/api succeeds (200)");

console.log("  -> PASSED: Admin authorization boundaries strictly defended against user privilege escalation.");

console.log("=== ALL MODULE 03 PROBE CHECKS PASSED (6/6) ===");
