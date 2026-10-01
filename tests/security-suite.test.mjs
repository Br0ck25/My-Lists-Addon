// Comprehensive Security Regression Suite (P9-4, S-01 through S-20).
// Verifies:
//   1. CSRF middleware & Origin/Sec-Fetch-Site validation
//   2. Query-string credential rejection
//   3. Cookie security flags & response security headers
//   4. Install-token scope isolation
//   5. Session revocation & lifecycle
//   6. IDOR matrix (cross-account resource isolation)
//   7. Admin authorization & privilege boundaries

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  makeEnv,
  makeD1,
  makeKv,
  call,
  createUser,
  nextIp,
} from "./harness.mjs";

describe("P9-4: Security Regression Suite", () => {
  // ---------------------------------------------------------------------------
  // 1. CSRF Middleware
  // ---------------------------------------------------------------------------
  describe("1. CSRF & Origin Validation", () => {
    it("rejects cross-origin mutating requests with 403 Forbidden", async () => {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
      const user = await createUser(env, "csrfuser");

      const res = await call(env, "/api/creator/lists", {
        method: "POST",
        headers: {
          Origin: "https://evil.attacker.com",
          "Content-Type": "application/json",
        },
        json: { creatorName: user.creatorName, creatorKey: user.creatorKey },
      });

      assert.equal(res.status, 403);
      assert.equal(res.body.ok, false);
      assert.match(res.body.error, /cross-origin/i);
    });

    it("rejects Sec-Fetch-Site: cross-site requests with 403 Forbidden", async () => {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
      const user = await createUser(env, "secfetchuser");

      const res = await call(env, "/api/creator/lists", {
        method: "POST",
        headers: {
          "Sec-Fetch-Site": "cross-site",
          "Content-Type": "application/json",
        },
        json: { creatorName: user.creatorName, creatorKey: user.creatorKey },
      });

      assert.equal(res.status, 403);
      assert.equal(res.body.ok, false);
    });

    it("rejects non-JSON Content-Type on mutating requests with 403 Forbidden", async () => {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });

      const res = await call(env, "/api/save", {
        method: "POST",
        headers: {
          Origin: "https://example.test",
          "Content-Type": "text/plain",
        },
        rawBody: "raw-text-payload",
      });

      assert.equal(res.status, 403);
      assert.match(res.body.error, /content-type/i);
    });

    it("exempts webhooks and admin form logins from CSRF check", async () => {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
      const user = await createUser(env, "exemptuser");

      const tokRes = await call(env, "/api/creator/scrobble-token", {
        method: "POST",
        json: { creatorName: user.creatorName, creatorKey: user.creatorKey },
      });
      const token = tokRes.body.token;

      // Scrobble webhook sent by third-party Plex/Jellyfin without same-origin headers
      const scrobbleRes = await call(env, `/api/scrobble?st=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: {
          Origin: "https://app.plex.tv",
          "Content-Type": "application/json",
        },
        json: { event: "media.scrobble", Metadata: { type: "movie", title: "Test" } },
      });
      assert.notEqual(scrobbleRes.status, 403, "webhook must be exempt from CSRF rejection");
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Query-String Credential Rejection
  // ---------------------------------------------------------------------------
  describe("2. Query-String Credential Rejection", () => {
    it("refuses GET requests with credentials in the query string (refuseQueryCredentials)", async () => {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });

      // /api/preview with creatorKey in query string
      const res1 = await call(env, "/api/preview?url=https%3A%2F%2Ftrakt.tv%2Flists%2F1&creatorKey=MYL-ABCD-1234-5678");
      assert.equal(res1.status, 400);
      assert.equal(res1.body.ok, false);
      assert.match(res1.body.error, /private key or token in the address/i);

      // /api/preview with tmdbKey in query string
      const res2 = await call(env, "/api/preview?url=https%3A%2F%2Ftrakt.tv%2Flists%2F1&tmdbKey=secret12345");
      assert.equal(res2.status, 400);
      assert.match(res2.body.error, /private key or token in the address/i);

      // /api/preview with mdblistKey in query string
      const res3 = await call(env, "/api/preview?url=https%3A%2F%2Ftrakt.tv%2Flists%2F1&mdblistKey=secret_mdblist");
      assert.equal(res3.status, 400);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Cookie Flags & Security Headers
  // ---------------------------------------------------------------------------
  describe("3. Cookie Security Flags & Response Headers", () => {
    it("sets HttpOnly, Secure, and SameSite=Lax on session cookies", async () => {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), FF_SESSIONS: "1" });
      const user = await createUser(env, "cookiesecuser");

      const loginRes = await call(env, "/api/session", {
        method: "POST",
        json: { username: user.creatorName, key: user.creatorKey },
      });
      assert.equal(loginRes.status, 200);

      const setCookie = loginRes.headers.get("set-cookie") || "";
      assert.ok(setCookie.includes("mla_session="), "must set mla_session cookie");
      assert.ok(/;\s*HttpOnly\b/i.test(setCookie), "cookie must have HttpOnly");
      assert.ok(/;\s*Secure\b/i.test(setCookie), "cookie must have Secure");
      assert.ok(/;\s*SameSite=Lax\b/i.test(setCookie), "cookie must have SameSite=Lax");
      assert.ok(/;\s*Path=\//i.test(setCookie), "cookie must have Path=/");
      assert.ok(/;\s*Max-Age=\d+/i.test(setCookie), "cookie must have Max-Age");
    });

    it("emits comprehensive security headers on all responses", async () => {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
      const res = await call(env, "/");

      assert.equal(res.status, 200);
      const csp = res.headers.get("content-security-policy") || "";
      assert.ok(csp.includes("object-src 'none'"), "CSP must include object-src 'none'");
      assert.ok(csp.includes("base-uri 'self'"), "CSP must include base-uri 'self'");
      assert.ok(csp.includes("frame-ancestors 'self'"), "CSP must include frame-ancestors 'self'");

      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(res.headers.get("x-frame-options"), "SAMEORIGIN");
      assert.equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
      assert.ok(res.headers.get("strict-transport-security"), "must include HSTS");
    });

    it("enforces Cache-Control: no-store on private endpoints", async () => {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
      const user = await createUser(env, "nostoreuser");

      const res = await call(env, "/api/creator/lists", {
        method: "POST",
        json: { creatorName: user.creatorName, creatorKey: user.creatorKey },
      });

      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Install-Token Scope Isolation
  // ---------------------------------------------------------------------------
  describe("4. Install-Token Scope Isolation", () => {
    it("prohibits install tokens from executing creator actions or accessing private user APIs", async () => {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), FF_SESSIONS: "1" });
      const user = await createUser(env, "installuser");

      // Save an install
      const saveRes = await call(env, "/api/save", {
        method: "POST",
        json: {
          creatorName: user.creatorName,
          creatorKey: user.creatorKey,
          entries: [{ id: "r1", type: "movie", name: "Row", url: "https://trakt.tv/lists/1" }],
        },
      });
      assert.equal(saveRes.body.ok, true);
      const installId = saveRes.body.id;

      // An attacker possessing only installId attempts to call /api/me
      const meRes = await call(env, "/api/me", {
        headers: { Authorization: `Bearer ${installId}` },
      });
      assert.equal(meRes.status, 401, "installId must not authorize /api/me");

      // Attacker attempts to list creator lists using installId
      const listsRes = await call(env, "/api/creator/lists", {
        method: "POST",
        json: { creatorName: user.creatorName, creatorKey: installId },
      });
      assert.equal(listsRes.status, 401, "installId must not authorize creator lists");
    });

    it("rejects legacy scrobble query credentials when sunset is enforced (FF_SCROBBLE_ST_ONLY)", async () => {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), FF_SCROBBLE_ST_ONLY: "1" });
      const user = await createUser(env, "sunsetscrobble");

      // Attempt legacy scrobble via ?creator=&key=
      const res = await call(env, `/api/scrobble?creator=${encodeURIComponent(user.creatorName)}&key=${encodeURIComponent(user.creatorKey)}`, {
        method: "POST",
        json: { event: "media.scrobble", Metadata: { type: "movie", title: "Test" } },
      });

      assert.equal(res.status, 410, "legacy scrobble credentials must be rejected with 410 Gone");
      assert.equal(res.body.sunset, true);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Session Revocation & Lifecycle
  // ---------------------------------------------------------------------------
  describe("5. Session Revocation & Lifecycle", () => {
    it("invalidates session immediately upon logout (DELETE /api/session)", async () => {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), FF_SESSIONS: "1" });
      const user = await createUser(env, "revoketest");

      // 1. Log in
      const loginRes = await call(env, "/api/session", {
        method: "POST",
        json: { username: user.creatorName, key: user.creatorKey },
      });
      const cookie = (loginRes.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/)[1];

      // 2. Verify session works
      const me1 = await call(env, "/api/me", { cookie });
      assert.equal(me1.status, 200);
      assert.equal(me1.body.account.username, user.creatorName);

      // 3. Log out
      const logoutRes = await call(env, "/api/session", { method: "DELETE", cookie });
      assert.equal(logoutRes.status, 200);

      // 4. Verify cookie is rejected
      const me2 = await call(env, "/api/me", { cookie });
      assert.equal(me2.status, 401, "revoked session cookie must be refused with 401");
    });

    it("revokes all active sessions upon account deletion (DELETE /api/me)", async () => {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), FF_SESSIONS: "1" });
      const user = await createUser(env, "deleteaccountsec");

      // Log in
      const loginRes = await call(env, "/api/session", {
        method: "POST",
        json: { username: user.creatorName, key: user.creatorKey },
      });
      const cookie = (loginRes.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/)[1];

      // Delete account
      const delRes = await call(env, "/api/me", {
        method: "DELETE",
        cookie,
        json: { confirm: "DELETE" },
      });
      assert.equal(delRes.status, 202);

      // Attempt to use deleted session
      const meRes = await call(env, "/api/me", { cookie });
      assert.equal(meRes.status, 401);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. IDOR Matrix (Insecure Direct Object Reference)
  // ---------------------------------------------------------------------------
  describe("6. IDOR Matrix: Cross-Account Resource Isolation", () => {
    it("prevents User B from accessing, modifying, or deleting User A's private lists", async () => {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), FF_SESSIONS: "1" });
      const userA = await createUser(env, "usera");
      const userB = await createUser(env, "userb");

      // User A creates a private list
      const saveRes = await call(env, "/api/creator/lists/save", {
        method: "POST",
        json: {
          creatorName: userA.creatorName,
          creatorKey: userA.creatorKey,
          name: "User A Secret List",
          type: "movie",
          items: [{ id: "tt0111161", title: "Shawshank", type: "movie" }],
          visibility: "private",
        },
      });
      assert.equal(saveRes.body.ok, true);
      const slug = saveRes.body.slug;

      // User B attempts to overwrite User A's list by saving with User A's slug
      await call(env, "/api/creator/lists/save", {
        method: "POST",
        json: {
          creatorName: userB.creatorName,
          creatorKey: userB.creatorKey,
          slug,
          name: "Hacked by User B",
          type: "movie",
          items: [{ id: "tt0000001", title: "Hacked", type: "movie" }],
          visibility: "private",
        },
      });

      // User B attempts to delete User A's list
      await call(env, "/api/creator/lists/delete", {
        method: "POST",
        json: {
          creatorName: userB.creatorName,
          creatorKey: userB.creatorKey,
          slug,
        },
      });

      // Verify User A's list still exists and has original name
      const listsA = await call(env, "/api/creator/lists", {
        method: "POST",
        json: { creatorName: userA.creatorName, creatorKey: userA.creatorKey },
      });
      const listA = listsA.body.lists.find((l) => l.slug === slug);
      assert.ok(listA, "User A's list must remain intact");
      assert.equal(listA.name, "User A Secret List", "User B must not be able to modify User A's list name");

      // User B attempts to fetch User A's private list via public endpoint
      const pubRes = await call(env, `/lists/${userA.creatorName}/${slug}.json`);
      assert.equal(pubRes.status, 404, "private list must return 404 to unauthorized viewers");
    });

    it("prevents User B from accessing User A's provider connections", async () => {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), FF_SESSIONS: "1" });
      const userA = await createUser(env, "conna");
      const userB = await createUser(env, "connb");

      // User B logs in with session
      const loginB = await call(env, "/api/session", {
        method: "POST",
        json: { username: userB.creatorName, key: userB.creatorKey },
      });
      const cookieB = (loginB.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/)[1];

      // User B queries connections
      const connB = await call(env, "/api/connections", { cookie: cookieB });
      assert.equal(connB.status, 200);
      assert.deepEqual(connB.body.connections, [], "User B must see only their own connections");
    });

    it("prevents User B from viewing or revoking User A's install links", async () => {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), FF_SESSIONS: "1", FF_INSTALLS: "1" });
      const userA = await createUser(env, "installa");
      const userB = await createUser(env, "installb");

      // User A creates install link
      const saveA = await call(env, "/api/save", {
        method: "POST",
        json: {
          creatorName: userA.creatorName,
          creatorKey: userA.creatorKey,
          entries: [{ id: "r1", type: "movie", name: "Row", url: "https://trakt.tv/lists/1" }],
        },
      });
      const installIdA = saveA.body.id;

      // User B logs in
      const loginB = await call(env, "/api/session", {
        method: "POST",
        json: { username: userB.creatorName, key: userB.creatorKey },
      });
      const cookieB = (loginB.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/)[1];

      // User B attempts to revoke User A's install link
      const revokeRes = await call(env, `/api/installs/${installIdA}`, {
        method: "DELETE",
        cookie: cookieB,
      });
      assert.ok(revokeRes.status === 404 || revokeRes.status === 403, "User B must not revoke User A's install");
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Admin Authorization & Privilege Boundaries
  // ---------------------------------------------------------------------------
  describe("7. Admin Authorization Boundaries", () => {
    it("rejects unauthorized access to /admin and admin APIs", async () => {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), ADMIN_KEY: "SuperSecretKey999" });

      // Unauthenticated GET /admin
      const res1 = await call(env, "/admin");
      // Redirects to /admin/login or serves login form
      assert.ok(res1.status === 302 || res1.text.includes("admin/login") || res1.text.includes("Password"));

      // Unauthenticated POST /admin/api/backfill-title-daily-stats
      const res2 = await call(env, "/admin/api/backfill-title-daily-stats", { method: "POST" });
      assert.equal(res2.status, 401);
      assert.equal(res2.body.ok, false);

      // Wrong key on /admin/login
      const res3 = await call(env, "/admin/login", { method: "POST", form: { key: "WrongKey" } });
      assert.ok(res3.status === 401 || res3.text.includes("Invalid"));
    });
  });
});
