// audit/full-2026-10-02/probes/p02_auth_and_sessions.mjs
// Automated verification probe for Module 03: Authentication, Sessions & Account Identity
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { makeEnv, makeD1, makeKv, worker, nextIp } from "../../../tests/harness.mjs";

console.log("=== START MODULE 03 PROBE: AUTHENTICATION, SESSIONS & IDENTITY ===");

const d1 = makeD1();
const kv = makeKv();
const env = makeEnv({
  DB: d1,
  CONFIGS: kv,
  ADMIN_KEY: "super-secret-admin-key-2026",
  LOOKUP_PEPPER: "pepper-audit-test-key-32byteslong!",
  FF_SESSIONS: "1",
  FF_V2_LISTS_READ: "1",
  FF_V2_LISTS_API: "1",
});

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
};

const BASE_URL = "https://mylists.addon";

// Helper: send request to Worker
async function req(path, { method = "GET", headers = {}, body = null } = {}) {
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

  const request = new Request(`${BASE_URL}${path}`, {
    method,
    headers: h,
    body: body ? body : undefined,
  });

  return await worker.fetch(request, env, ctx);
}

// -----------------------------------------------------------------------------
// Test 1: Account Creation, Key Generation & PBKDF2 Hashing
// -----------------------------------------------------------------------------
console.log("[Test 1] Account Creation & Key PBKDF2 Hashing...");

const user1Name = "audit_user_one";
const user1DisplayName = "Audit User One";
const user1RecoveryAnswer = "Secret Answer 123";

const createRes1 = await req("/api/creator/create", {
  method: "POST",
  body: JSON.stringify({
    creatorName: user1Name,
    displayName: user1DisplayName,
    recoveryAnswer: user1RecoveryAnswer,
  }),
});

assert.equal(createRes1.status, 200, "Create user 1 must return 200");
const createData1 = await createRes1.json();
assert.equal(createData1.ok, true, "Create user 1 response must be ok: true");
assert.ok(createData1.creatorKey, "Response must include creatorKey");
const key1 = createData1.creatorKey;
assert.match(key1, /^MYL-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/, "Key must match MYL-XXXX-XXXX-XXXX format");

// Verify PBKDF2 iterations and hash format in D1
const creatorRow1 = await d1.prepare("SELECT * FROM creators WHERE username = ?").bind(user1Name).first();
assert.ok(creatorRow1, "Creator row must exist in D1 creators table");
assert.match(creatorRow1.key_hash, /^pbkdf2:100000:[0-9a-f]{32}:[0-9a-f]{64}$/, "Key hash must use 100,000 PBKDF2 iterations");

// Verify recovery answer hash is chained 6 rounds (P7-4 / D-32)
assert.match(creatorRow1.recovery_answer_hash, /^pbkdf2x:6:100000:[0-9a-f]{32}:[0-9a-f]{64}$/, "Recovery answer must use pbkdf2x with 6 rounds");

// Verify account mirror in accounts table
const accountRow1 = await d1.prepare("SELECT * FROM accounts WHERE username = ? COLLATE NOCASE").bind(user1Name).first();
assert.ok(accountRow1, "Account row must exist in accounts table");
assert.equal(accountRow1.status, "active", "Account status must be active");
assert.equal(accountRow1.key_hash, creatorRow1.key_hash, "accounts.key_hash must match creators.key_hash");

// Verify blind index lookup HMAC is populated when LOOKUP_PEPPER is present
assert.ok(accountRow1.key_lookup_hmac, "Account must have key_lookup_hmac populated");
console.log("  -> PASSED: Account created with 100k-iteration key and 6-round chained recovery hash.");

// -----------------------------------------------------------------------------
// Test 2: Session Sign-in (/api/session), Cookie Security & D1 Token Hashing
// -----------------------------------------------------------------------------
console.log("[Test 2] Session Sign-in (/api/session) & Cookie Security...");

const loginRes1 = await req("/api/session", {
  method: "POST",
  body: JSON.stringify({
    username: user1Name,
    key: key1,
  }),
});

assert.equal(loginRes1.status, 200, "Session login must return 200");
const loginData1 = await loginRes1.json();
assert.equal(loginData1.ok, true, "Session login ok must be true");
assert.equal(loginData1.account.username, user1Name, "Login must return account username");

const setCookie1 = loginRes1.headers.get("Set-Cookie") || "";
assert.ok(setCookie1.includes("mla_session="), "Set-Cookie must contain mla_session");
assert.ok(setCookie1.includes("HttpOnly"), "Session cookie must have HttpOnly");
assert.ok(setCookie1.includes("Secure"), "Session cookie must have Secure");
assert.ok(setCookie1.includes("SameSite=Lax"), "Session cookie must have SameSite=Lax");
assert.ok(setCookie1.includes("Path=/"), "Session cookie must have Path=/");

// Extract token
const tokenMatch = setCookie1.match(/mla_session=([^;]+)/);
assert.ok(tokenMatch, "Cookie token must be extractable");
const sessionToken1 = decodeURIComponent(tokenMatch[1]);

// Compute SHA-256 of session token and verify it matches D1 id_hash
const expectedIdHash1 = crypto.createHash("sha256").update(sessionToken1).digest("hex");
const sessionRow1 = await d1.prepare("SELECT * FROM sessions WHERE id_hash = ?").bind(expectedIdHash1).first();
assert.ok(sessionRow1, "Session row must exist in D1 sessions matching SHA-256 of token");
assert.equal(sessionRow1.account_id, accountRow1.id, "Session account_id must match account id");
assert.equal(sessionRow1.revoked_at, null, "Session must not be revoked");
assert.ok(sessionRow1.expires_at > Date.now(), "Session expires_at must be in the future");

// Verify that the plaintext sessionToken1 is NOT stored anywhere in the database
const rawLeakCheck = await d1.prepare("SELECT COUNT(*) AS count FROM sessions WHERE id_hash LIKE ?").bind(`%${sessionToken1}%`).first();
assert.equal(rawLeakCheck.count, 0, "Plaintext session token must never be stored in database");

console.log("  -> PASSED: Session issued with strict cookie attributes; SHA-256 token hashing verified in D1.");

// -----------------------------------------------------------------------------
// Test 3: Session Resolution & Access Control (/api/me)
// -----------------------------------------------------------------------------
console.log("[Test 3] Session Resolution (/api/me) & Auth Verification...");

// 3a. Calling /api/me without cookie -> 401
const meUnauth = await req("/api/me", { method: "GET" });
assert.equal(meUnauth.status, 401, "/api/me without session must return 401");

// 3b. Calling /api/me with session cookie -> 200 with profile
const meAuth = await req("/api/me", {
  method: "GET",
  headers: { "Cookie": `mla_session=${sessionToken1}` },
});
assert.equal(meAuth.status, 200, "/api/me with session must return 200");
const meData = await meAuth.json();
assert.equal(meData.ok, true, "/api/me must return ok: true");
assert.equal(meData.account.username, user1Name, "/api/me must return correct username");
assert.equal(meAuth.headers.get("Cache-Control"), "no-store", "/api/me must return Cache-Control: no-store");

// 3c. Calling /api/me with Authorization: Bearer <token> -> 200
const meBearer = await req("/api/me", {
  method: "GET",
  headers: { "Authorization": `Bearer ${sessionToken1}` },
});
assert.equal(meBearer.status, 200, "/api/me with Bearer token must return 200");
const meBearerData = await meBearer.json();
assert.equal(meBearerData.account.username, user1Name, "Bearer auth must resolve correct account");

console.log("  -> PASSED: Session resolution works via Cookie and Bearer headers.");

// -----------------------------------------------------------------------------
// Test 4: Session Invalidation (Expiry, Revocation, Logout)
// -----------------------------------------------------------------------------
console.log("[Test 4] Session Invalidation (Expiry, Revocation, Logout)...");

// 4a. Expired session test
const expiredToken = "expired_raw_token_test_32charslength!";
const expiredIdHash = crypto.createHash("sha256").update(expiredToken).digest("hex");
await d1.prepare(
  "INSERT INTO sessions (id_hash, account_id, created_at, last_seen_at, expires_at, user_agent, revoked_at) " +
  "VALUES (?, ?, ?, ?, ?, ?, NULL)"
).bind(expiredIdHash, accountRow1.id, Date.now() - 100000, Date.now() - 100000, Date.now() - 1000, "TestAgent").run();

const meExpired = await req("/api/me", {
  method: "GET",
  headers: { "Cookie": `mla_session=${expiredToken}` },
});
assert.equal(meExpired.status, 401, "Expired session must return 401");

// 4b. Revoked session test
const revokedToken = "revoked_raw_token_test_32charslength!";
const revokedIdHash = crypto.createHash("sha256").update(revokedToken).digest("hex");
await d1.prepare(
  "INSERT INTO sessions (id_hash, account_id, created_at, last_seen_at, expires_at, user_agent, revoked_at) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?)"
).bind(revokedIdHash, accountRow1.id, Date.now() - 1000, Date.now() - 1000, Date.now() + 1000000, "TestAgent", Date.now() - 500).run();

const meRevoked = await req("/api/me", {
  method: "GET",
  headers: { "Cookie": `mla_session=${revokedToken}` },
});
assert.equal(meRevoked.status, 401, "Revoked session must return 401");

// 4c. Logout test via DELETE /api/session
const logoutRes = await req("/api/session", {
  method: "DELETE",
  headers: { "Cookie": `mla_session=${sessionToken1}` },
});
assert.equal(logoutRes.status, 200, "Logout must return 200");
const clearCookie = logoutRes.headers.get("Set-Cookie") || "";
assert.ok(clearCookie.includes("Max-Age=0"), "Logout must clear cookie with Max-Age=0");

// Verify in DB that row has revoked_at set
const loggedOutRow = await d1.prepare("SELECT revoked_at FROM sessions WHERE id_hash = ?").bind(expectedIdHash1).first();
assert.ok(loggedOutRow && loggedOutRow.revoked_at != null, "Session row in D1 must have revoked_at timestamp");

// Verify that reusing sessionToken1 now returns 401
const meAfterLogout = await req("/api/me", {
  method: "GET",
  headers: { "Cookie": `mla_session=${sessionToken1}` },
});
assert.equal(meAfterLogout.status, 401, "Reusing logged out session must return 401");

console.log("  -> PASSED: Expired, revoked, and logged-out sessions are strictly refused.");

// -----------------------------------------------------------------------------
// Test 5: CSRF Validation & Boundary Enforcement
// -----------------------------------------------------------------------------
console.log("[Test 5] CSRF & Same-Origin Boundary Validation...");

// Log in again to get fresh session
const loginRes2 = await req("/api/session", {
  method: "POST",
  body: JSON.stringify({ username: user1Name, key: key1 }),
});
const sessionToken2 = decodeURIComponent((loginRes2.headers.get("Set-Cookie") || "").match(/mla_session=([^;]+)/)[1]);

// 5a. Foreign Origin on mutating request -> 403
const csrfForeignOrigin = await worker.fetch(new Request(`${BASE_URL}/api/session`, {
  method: "POST",
  headers: {
    "Origin": "https://malicious-site.com",
    "Content-Type": "application/json",
    "CF-Connecting-IP": nextIp(),
  },
  body: JSON.stringify({ username: user1Name, key: key1 }),
}), env, ctx);
assert.equal(csrfForeignOrigin.status, 403, "Cross-origin POST must return 403");
const csrfOriginData = await csrfForeignOrigin.json();
assert.equal(csrfOriginData.error, "Cross-origin request forbidden.");

// 5b. Sec-Fetch-Site: cross-site on mutating request -> 403
const csrfCrossSite = await worker.fetch(new Request(`${BASE_URL}/api/session`, {
  method: "POST",
  headers: {
    "Sec-Fetch-Site": "cross-site",
    "Content-Type": "application/json",
    "CF-Connecting-IP": nextIp(),
  },
  body: JSON.stringify({ username: user1Name, key: key1 }),
}), env, ctx);
assert.equal(csrfCrossSite.status, 403, "Sec-Fetch-Site: cross-site must return 403");

// 5c. Non-JSON Content-Type (e.g. form-urlencoded) on mutating request -> 403
const csrfBadContentType = await worker.fetch(new Request(`${BASE_URL}/api/session`, {
  method: "POST",
  headers: {
    "Origin": BASE_URL,
    "Content-Type": "application/x-www-form-urlencoded",
    "CF-Connecting-IP": nextIp(),
  },
  body: "username=test",
}), env, ctx);
assert.equal(csrfBadContentType.status, 403, "Non-JSON Content-Type must return 403");

console.log("  -> PASSED: Strict CSRF protection verified against origin spoofing and non-JSON content-types.");

// -----------------------------------------------------------------------------
// Test 6: Cross-Account Resource Isolation & Parameter Tampering (IDOR)
// -----------------------------------------------------------------------------
console.log("[Test 6] Cross-Account Resource Isolation (IDOR Defense)...");

// Create User 2
const user2Name = "audit_user_two";
const createRes2 = await req("/api/creator/create", {
  method: "POST",
  body: JSON.stringify({
    creatorName: user2Name,
    displayName: "Audit User Two",
  }),
});
assert.equal(createRes2.status, 200);
const key2 = (await createRes2.json()).creatorKey;

// User 1 attempts to invoke /api/creator/sync/load for User 2 using User 1's session
const tamperRes = await req("/api/creator/sync/load", {
  method: "POST",
  headers: { "Cookie": `mla_session=${sessionToken2}` },
  body: JSON.stringify({ creatorName: user2Name }), // User 1 session, but requesting User 2
});
assert.equal(tamperRes.status, 401, "User 1 session attempting to access User 2 resources must be rejected with 401");

// User 1 attempts to save lists on User 2 using User 1's session
const tamperSaveRes = await req("/api/creator/sync/save", {
  method: "POST",
  headers: { "Cookie": `mla_session=${sessionToken2}` },
  body: JSON.stringify({ creatorName: user2Name, config: [] }),
});
assert.equal(tamperSaveRes.status, 401, "User 1 session saving to User 2 must return 401");

console.log("  -> PASSED: Session identity strictly enforced; parameter tampering rejected.");

// -----------------------------------------------------------------------------
// Test 7: Account Key Reset & Session Invalidation Cascade
// -----------------------------------------------------------------------------
console.log("[Test 7] Key Reset (/api/creator/reset-key) & Session Invalidation...");

const resetKeyRes = await req("/api/creator/reset-key", {
  method: "POST",
  body: JSON.stringify({
    username: user1Name,
    recoveryAnswer: user1RecoveryAnswer,
  }),
});
assert.equal(resetKeyRes.status, 200, "Reset key with valid recovery answer must return 200");
const resetKeyData = await resetKeyRes.json();
assert.ok(resetKeyData.creatorKey, "Reset key must return new key");
const newKey1 = resetKeyData.creatorKey;
assert.notEqual(newKey1, key1, "New key must be distinct from old key");

// Verify that sessionToken2 (issued under the OLD key) is now REVOKED in D1
const session2Check = await req("/api/me", {
  method: "GET",
  headers: { "Cookie": `mla_session=${sessionToken2}` },
});
assert.equal(session2Check.status, 401, "Sessions opened before key reset must be revoked immediately");

// Verify that the old key cannot log in
const loginOldKeyRes = await req("/api/session", {
  method: "POST",
  body: JSON.stringify({ username: user1Name, key: key1 }),
});
assert.equal(loginOldKeyRes.status, 401, "Old key must not be able to log in");

// Verify that the new key CAN log in
const loginNewKeyRes = await req("/api/session", {
  method: "POST",
  body: JSON.stringify({ username: user1Name, key: newKey1 }),
});
assert.equal(loginNewKeyRes.status, 200, "New key must successfully log in");

console.log("  -> PASSED: Key reset successfully invalidates all pre-existing sessions and old key.");

// -----------------------------------------------------------------------------
// Test 8: Admin Authentication Boundaries & Audit Logging
// -----------------------------------------------------------------------------
console.log("[Test 8] Admin Authentication Boundaries & Audit Logging...");

// 8a. Access /admin without auth
const adminUnauth = await req("/admin", { method: "GET" });
assert.equal(adminUnauth.status, 200, "GET /admin without auth renders login page");
const loginPageHtml = await adminUnauth.text();
assert.ok(loginPageHtml.includes("Admin — My Lists"), "Admin login page rendered");

// 8b. Access /admin/api/admin-sessions without auth -> 401
const adminApiUnauth = await req("/admin/api/admin-sessions", { method: "GET" });
assert.equal(adminApiUnauth.status, 401, "Admin API without auth must return 401");

// 8c. Admin login with invalid key -> 401
const adminWrongKey = await worker.fetch(new Request(`${BASE_URL}/admin/login`, {
  method: "POST",
  headers: {
    "Origin": BASE_URL,
    "Content-Type": "application/x-www-form-urlencoded",
    "CF-Connecting-IP": nextIp(),
  },
  body: "key=definitely-wrong-admin-key",
}), env, ctx);
assert.equal(adminWrongKey.status, 401, "Admin login with wrong key must return 401");

// 8d. Admin login with correct key -> 302 redirect to /admin + session cookie
const adminCorrectLogin = await worker.fetch(new Request(`${BASE_URL}/admin/login`, {
  method: "POST",
  headers: {
    "Origin": BASE_URL,
    "Content-Type": "application/x-www-form-urlencoded",
    "CF-Connecting-IP": nextIp(),
  },
  body: "key=super-secret-admin-key-2026",
}), env, ctx);
assert.equal(adminCorrectLogin.status, 302, "Admin login with correct key must redirect (302)");
const adminCookie = adminCorrectLogin.headers.get("Set-Cookie") || "";
assert.ok(adminCookie.includes("mla_admin="), "Admin login must set mla_admin cookie");
assert.ok(adminCookie.includes("SameSite=Strict"), "Admin cookie must be SameSite=Strict");
const adminToken = adminCookie.match(/mla_admin=([^;]+)/)[1];

// 8e. Access /admin/api/admin-sessions WITH admin cookie -> 200
const adminApiAuthed = await req("/admin/api/admin-sessions", {
  method: "GET",
  headers: { "Cookie": `mla_admin=${adminToken}` },
});
assert.equal(adminApiAuthed.status, 200, "Admin API with admin cookie must return 200");
const adminSessionsData = await adminApiAuthed.json();
assert.equal(adminSessionsData.ok, true, "Admin sessions list must return ok: true");
assert.ok(adminSessionsData.sessions.length > 0, "Admin sessions must contain at least 1 session");

// 8f. Check admin audit log table in D1
const auditLogs = await d1.prepare("SELECT * FROM admin_audit_log ORDER BY at DESC").all();
assert.ok(auditLogs.results.length > 0, "Admin audit log must have recorded entries");
const latestLogin = auditLogs.results.find((r) => r.action === "admin.login");
assert.ok(latestLogin, "Audit log must contain admin.login action");
assert.equal(latestLogin.actor, "key", "Actor must be recorded as 'key'");

// Check that secrets are NEVER recorded in the audit log
for (const entry of auditLogs.results) {
  const detailStr = String(entry.detail || "");
  assert.ok(!detailStr.includes("super-secret-admin-key-2026"), "Audit detail must never contain raw admin key");
  assert.ok(!detailStr.includes("MYL-"), "Audit detail must never contain creator keys");
}

console.log("  -> PASSED: Admin authentication, revocable sessions, SameSite=Strict cookies, and secret-free audit logging verified.");

// -----------------------------------------------------------------------------
// Test 9: Account Deletion, Cascading Tombstones & Session Annihilation
// -----------------------------------------------------------------------------
console.log("[Test 9] Account Deletion & Tombstone Lifecycle...");

// Sign in as user 2 to get session
const loginResUser2 = await req("/api/session", {
  method: "POST",
  body: JSON.stringify({ username: user2Name, key: key2 }),
});
const sessionTokenUser2 = decodeURIComponent((loginResUser2.headers.get("Set-Cookie") || "").match(/mla_session=([^;]+)/)[1]);

// Delete User 2's account
const deleteUser2Res = await req("/api/creator/delete-account", {
  method: "POST",
  headers: { "Cookie": `mla_session=${sessionTokenUser2}` },
  body: JSON.stringify({
    creatorName: user2Name,
    creatorKey: key2,
    confirm: "DELETE",
  }),
});
assert.equal(deleteUser2Res.status, 200, "Account deletion must return 200");

// Verify tombstone is written in KV and D1
const tombstoneVal = await kv.get(`creatordeleted:${user2Name}`);
assert.ok(tombstoneVal != null, "Tombstone must be written to KV on deletion (creatordeleted:username)");

const d1Tombstone = await d1.prepare("SELECT * FROM creator_tombstones WHERE username = ?").bind(user2Name).first();
assert.ok(d1Tombstone != null, "Tombstone must be written to D1 creator_tombstones");
assert.ok(Number(d1Tombstone.until) > Date.now(), "D1 tombstone until timestamp must be in future");

// Verify accounts and creators rows are deleted
const creator2Row = await d1.prepare("SELECT * FROM creators WHERE username = ?").bind(user2Name).first();
assert.equal(creator2Row, null, "creators row must be deleted");

const account2Row = await d1.prepare("SELECT * FROM accounts WHERE username = ? COLLATE NOCASE").bind(user2Name).first();
assert.equal(account2Row, null, "accounts row must be deleted");

// Verify all sessions for User 2 are destroyed
const user2Sessions = await d1.prepare(
  "SELECT COUNT(*) as count FROM sessions WHERE id_hash = ?"
).bind(crypto.createHash("sha256").update(sessionTokenUser2).digest("hex")).first();
assert.equal(user2Sessions.count, 0, "All sessions for deleted account must be purged from database");

// Attempting to authenticate as User 2 immediately fails with 401
const loginDeleted = await req("/api/session", {
  method: "POST",
  body: JSON.stringify({ username: user2Name, key: key2 }),
});
assert.equal(loginDeleted.status, 401, "Deleted account must return 401");

console.log("  -> PASSED: Deletion thoroughly wipes identity, cascades sessions, and sets anti-resurrection tombstone.");

console.log("=== ALL MODULE 03 PROBE CHECKS PASSED (9/9) ===");
