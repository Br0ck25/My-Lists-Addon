import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { call, makeEnv, makeD1, makeKv } from "./harness.mjs";

// P7-2: the admin dashboard's identity, its revocable sessions, and the audit
// log. Three claims are worth testing, and each has a way to be subtly wrong:
//
//   1. A Cloudflare Access token is VERIFIED, not read. The header is just a
//      header -- anyone who can reach the Worker can send one -- so what makes
//      an Access sign-in real is the RS256 signature checked against the
//      team's own certs, plus the audience, which is what stops a token minted
//      for some other Access application in the same account from opening this
//      dashboard.
//   2. A session can be revoked, and revoking it really ends it. The old
//      cookie was an HMAC over its own expiry: nothing could end it early, and
//      signing anyone out meant rotating ADMIN_KEY for everyone.
//   3. Every mutating admin request leaves a row naming who did it -- and that
//      row never contains a key, a token or a password, because the fields are
//      picked by name rather than copied from the body.

const ADMIN_KEY = "test-admin-secret";

// The whole `mla_admin=<id>.<secret>` pair, which is what the harness's
// `cookie` option wants (it becomes the Cookie header verbatim).
async function adminCookie(env, ip = "203.0.113.7") {
  const res = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY || ADMIN_KEY }, ip });
  assert.equal(res.status, 302, "the key sign-in should redirect to /admin");
  const setCookie = res.headers.get("set-cookie") || "";
  const m = setCookie.match(/^(mla_admin=[^;]+)/);
  assert.ok(m, "no admin cookie was set: " + setCookie);
  return m[1];
}

// The id half of the cookie, which is what names the session row.
const idOf = (cookie) => cookie.slice("mla_admin=".length).split(".")[0];
const secretOf = (cookie) => cookie.slice("mla_admin=".length).split(".")[1];
const rawValue = (res) => (res.headers.get("set-cookie") || "").match(/^mla_admin=([^;]+)/)[1];

// --- Cloudflare Access, for real -------------------------------------------
//
// A real RS256 keypair, a real JWKS served at the team's certs URL, and a real
// signature over the token. Anything less would test the header path, which is
// exactly the thing that must NOT be trusted.
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-kid-1";
const JWK = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };
const TEAM = "myteam.cloudflareaccess.com";
const AUD = "aud-tag-for-this-application";

function b64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function accessToken({ kid = KID, email = "owner@example.com", aud = AUD, iss = "https://" + TEAM, exp = Math.floor(Date.now() / 1000) + 600, key = privateKey } = {}) {
  const header = b64url(JSON.stringify({ alg: "RS256", kid: kid, typ: "JWT" }));
  const payload = b64url(JSON.stringify({ email: email, sub: "sub-1", aud: aud, iss: iss, iat: Math.floor(Date.now() / 1000) - 10, exp: exp }));
  const sig = crypto.sign("sha256", Buffer.from(header + "." + payload), key).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return header + "." + payload + "." + sig;
}

function stubAccessCerts(t, { keys = [JWK], status = 200 } = {}) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push(url);
    if (!url.includes("/cdn-cgi/access/certs")) return realFetch(input);
    return new Response(JSON.stringify({ keys: keys }), {
      status: status,
      headers: { "Content-Type": "application/json" },
    });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  return calls;
}

function accessEnv(extra = {}) {
  return makeEnv({ DB: makeD1(), CONFIGS: makeKv(), CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD, ...extra });
}

describe("P7-2: Cloudflare Access is verified, never trusted from a header", () => {
  it("is off unless BOTH the team domain and the audience are set", async (t) => {
    const calls = stubAccessCerts(t);
    // Only half configured: no verification is possible, so the header must
    // mean nothing rather than everything.
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), CF_ACCESS_TEAM_DOMAIN: TEAM });
    const token = accessToken();
    const res = await call(env, "/admin/api/analytics", { headers: { "Cf-Access-Jwt-Assertion": token } });
    assert.equal(res.status, 401, "a token must not authenticate a Worker that cannot verify it");
    assert.equal(calls.length, 0, "no certs should be fetched when the audience is unset");
  });

  it("signs in with a token Cloudflare actually signed -- with no ADMIN_KEY at all", async (t) => {
    stubAccessCerts(t);
    const env = accessEnv({ ADMIN_KEY: undefined });
    const token = accessToken();
    const login = await call(env, "/admin/login", { method: "POST", headers: { "Cf-Access-Jwt-Assertion": token } });
    assert.equal(login.status, 302, "a verified Access identity is the sign-in");
    assert.equal(login.headers.get("location"), "/admin");

    // And the cookie it hands back is a live admin session.
    const cookie = "mla_admin=" + rawValue(login);
    const page = await call(env, "/admin", { cookie });
    assert.equal(page.status, 200, "the dashboard should render");
    assert.equal(/Admin sign in/.test(page.text), false, "the login page means the session was not accepted");
  });

  it("names the identity, so the log says who rather than 'admin'", async (t) => {
    stubAccessCerts(t);
    const env = accessEnv();
    const login = await call(env, "/admin/login", { method: "POST", headers: { "Cf-Access-Jwt-Assertion": accessToken({ email: "Actor@Example.com" }) } });
    assert.equal(login.status, 302);
    const row = env.DB.q("SELECT actor, action FROM admin_audit_log ORDER BY id DESC LIMIT 1")[0];
    assert.equal(row.action, "admin.login");
    assert.equal(row.actor, "access:actor@example.com", "the email is the actor, lowercased");
  });

  it("refuses a token signed by someone else", async (t) => {
    stubAccessCerts(t);
    const env = accessEnv();
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const forged = accessToken({ key: other });
    const res = await call(env, "/admin/api/analytics", { headers: { "Cf-Access-Jwt-Assertion": forged } });
    assert.equal(res.status, 401, "a valid-looking token with a foreign signature is not an identity");
  });

  it("refuses a token for a different Access application, an expired one, and a foreign issuer", async (t) => {
    stubAccessCerts(t);
    const env = accessEnv();
    const cases = {
      "another app's audience": accessToken({ aud: "some-other-app" }),
      "expired": accessToken({ exp: Math.floor(Date.now() / 1000) - 60 }),
      "another team's issuer": accessToken({ iss: "https://other.cloudflareaccess.com" }),
      "an unknown kid": accessToken({ kid: "not-in-the-jwks" }),
    };
    for (const [what, token] of Object.entries(cases)) {
      const res = await call(env, "/admin/api/analytics", { headers: { "Cf-Access-Jwt-Assertion": token } });
      assert.equal(res.status, 401, `${what} was accepted`);
    }
  });

  it("honours FF_ADMIN_EMAILS as a second lock", async (t) => {
    stubAccessCerts(t);
    const env = accessEnv({ FF_ADMIN_EMAILS: "owner@example.com, second@example.com" });
    const allowed = await call(env, "/admin/api/analytics", { headers: { "Cf-Access-Jwt-Assertion": accessToken({ email: "second@example.com" }) } });
    assert.equal(allowed.status, 200, "an address on the list should be an admin");
    const refused = await call(env, "/admin/api/analytics", { headers: { "Cf-Access-Jwt-Assertion": accessToken({ email: "stranger@example.com" }) } });
    assert.equal(refused.status, 401, "an Access identity that is not on the list must not be an admin");
  });

  it("fetches the team's certs once and remembers them", async (t) => {
    const calls = stubAccessCerts(t);
    // Its own team: the certs are cached per isolate by URL, so a shared team
    // name would already be warm from the tests above and this would count
    // zero fetches while proving nothing.
    const team = "certs-cache-check.cloudflareaccess.com";
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), CF_ACCESS_TEAM_DOMAIN: team, CF_ACCESS_AUD: AUD });
    for (let i = 0; i < 3; i++) {
      const token = accessToken({ iss: "https://" + team });
      const res = await call(env, "/admin/api/analytics", { headers: { "Cf-Access-Jwt-Assertion": token } });
      assert.equal(res.status, 200);
    }
    assert.equal(calls.length, 1, `expected the certs to be fetched once, got ${calls.length}`);
  });

  it("still lets the key in, and says so on the login page when Access is on", async (t) => {
    stubAccessCerts(t);
    const env = accessEnv();
    const page = await call(env, "/admin");
    assert.equal(page.status, 200);
    assert.match(page.text, /Cloudflare Access is <strong>on<\/strong>/, "an admin locked out by Access should be told Access is on");
    const off = await call(makeEnv({ DB: makeD1(), CONFIGS: makeKv() }), "/admin");
    assert.equal(/Cloudflare Access is <strong>on<\/strong>/.test(off.text), false);
    // Break-glass keeps working regardless.
    const cookie = await adminCookie(env);
    const authed = await call(env, "/admin/api/analytics", { cookie });
    assert.equal(authed.status, 200);
  });
});

describe("P7-2: admin sessions that can be revoked", () => {
  it("stores a hash, not the cookie, and never the secret in the clear", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const cookie = await adminCookie(env);
    const id = idOf(cookie);
    const secret = secretOf(cookie);
    assert.match(id, /^[0-9a-f]{32}$/, "the id half names the row");
    assert.ok(secret && secret.length >= 32, "the secret half is long");
    const row = env.DB.q("SELECT * FROM admin_sessions WHERE id = ?", id)[0];
    assert.ok(row, "a session row should exist");
    assert.equal(row.actor, "key");
    const expected = crypto.createHash("sha256").update(secret).digest("hex");
    assert.equal(row.token_hash, expected, "the row must store the secret's hash");
    assert.equal(JSON.stringify(row).includes(secret), false, "the secret itself must not be in the database");
    assert.equal(JSON.stringify(row).includes(cookie), false, "the whole cookie must not be in the database");
  });

  it("lists the signed-in browsers, and signing one out ends it immediately", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const mine = await adminCookie(env, "198.51.100.9");
    const other = await adminCookie(env, "198.51.100.10");
    assert.notEqual(mine, other);

    const listed = await call(env, "/admin/api/admin-sessions", { cookie: mine });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.sessions.length, 2);
    assert.equal(listed.body.current, idOf(mine), "the list says which one is this browser");
    const otherRow = listed.body.sessions.find((s) => s.id === idOf(other));
    assert.equal(otherRow.ip, "198.51.100.10");
    assert.ok(otherRow.userAgent !== undefined);

    const revoked = await call(env, "/admin/api/revoke-admin-session", { method: "POST", cookie: mine, json: { id: idOf(other) } });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.revoked, true);
    assert.equal(revoked.body.self, false);

    const after = await call(env, "/admin/api/analytics", { cookie: other });
    assert.equal(after.status, 401, "a revoked session must stop working on the next request, not in seven days");
    const still = await call(env, "/admin/api/analytics", { cookie: mine });
    assert.equal(still.status, 200, "signing out someone else must not sign this browser out");
  });

  it("signs every browser out at once when asked", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const mine = await adminCookie(env);
    await adminCookie(env, "198.51.100.11");
    const all = await call(env, "/admin/api/revoke-admin-session", { method: "POST", cookie: mine, json: { all: true } });
    assert.equal(all.status, 200);
    assert.equal(all.body.revoked, 2);
    for (const cookie of [mine]) {
      const res = await call(env, "/admin/api/analytics", { cookie });
      assert.equal(res.status, 401);
    }
    assert.equal(env.DB.q("SELECT COUNT(*) AS n FROM admin_sessions WHERE revoked_at IS NULL")[0].n, 0);
  });

  it("refuses a right id with a wrong secret, and an expired row", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const cookie = await adminCookie(env);
    const id = idOf(cookie);
    const secret = secretOf(cookie);

    const tampered = "mla_admin=" + id + "." + "0".repeat(secret.length);
    assert.equal((await call(env, "/admin/api/analytics", { cookie: tampered })).status, 401, "the secret is what proves the cookie");

    env.DB._db.exec(`UPDATE admin_sessions SET expires_at = ${Date.now() - 1000} WHERE id = '${id}'`);
    assert.equal((await call(env, "/admin/api/analytics", { cookie })).status, 401, "an expired session is not an identity");
  });

  it("revokes on logout, not just the cookie", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const cookie = await adminCookie(env);
    const id = idOf(cookie);
    const out = await call(env, "/admin/logout", { method: "POST", cookie });
    assert.equal(out.status, 302);
    const row = env.DB.q("SELECT revoked_at FROM admin_sessions WHERE id = ?", id)[0];
    assert.ok(row.revoked_at, "logout must revoke the row, or the cookie could simply be set back");
  });

  it("falls back to the old signed cookie when migration 0018 has not been applied", async () => {
    // No D1 at all: the documented behaviour before P7-2, and it must still
    // work -- a migration that has not been applied must never lock the owner
    // out of their own dashboard.
    const env = makeEnv({ CONFIGS: makeKv() });
    assert.equal(env.DB, undefined);
    const cookie = await adminCookie(env);
    assert.match(cookie, /^mla_admin=\d+\./, "the fallback cookie is expiry.signature");
    assert.equal((await call(env, "/admin/api/analytics", { cookie })).status, 200);
    // And a session-less deployment reports the gap instead of an empty list.
    const listed = await call(env, "/admin/api/admin-sessions", { cookie });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.unavailable, "no-d1");
  });

  it("keeps working when D1 is bound but the migration has not run", async () => {
    const db = makeD1();
    db._db.exec("DROP TABLE admin_sessions");
    const env = makeEnv({ DB: db, CONFIGS: makeKv() });
    const cookie = await adminCookie(env);
    assert.match(cookie, /^mla_admin=\d+\./, "the signed cookie is the fallback, not a broken login");
    assert.equal((await call(env, "/admin/api/analytics", { cookie })).status, 200);
    const listed = await call(env, "/admin/api/admin-sessions", { cookie });
    assert.equal(listed.body.unavailable, "migration-0018");
  });
});

describe("P7-2: the audit log", () => {
  it("records a login and a logout, and who did them", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const cookie = await adminCookie(env, "198.51.100.20");
    await call(env, "/admin/logout", { method: "POST", cookie });
    const rows = env.DB.q("SELECT action, actor, ip, status FROM admin_audit_log ORDER BY id ASC");
    assert.deepEqual(rows.map((r) => r.action), ["admin.login", "admin.logout"]);
    assert.equal(rows[0].actor, "key");
    assert.equal(rows[0].ip, "198.51.100.20");
    assert.equal(rows[0].status, 302);
  });

  it("records one row per mutating request and none for a read", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const cookie = await adminCookie(env);
    env.DB._db.exec("DELETE FROM admin_audit_log");

    await call(env, "/admin/api/analytics", { cookie });
    await call(env, "/admin/api/audit", { cookie });
    await call(env, "/admin/api/leaderboard?type=watched&window=7", { cookie });
    assert.equal(env.DB.q("SELECT COUNT(*) AS n FROM admin_audit_log")[0].n, 0, "reading the dashboard is not an action");

    await call(env, "/admin/api/migrate-day-counts", { method: "POST", cookie, json: { networkId: "one-row-per-request" } });
    const rows = env.DB.q("SELECT action, target, detail, status FROM admin_audit_log");
    assert.equal(rows.length, 1, `expected one row for one request, got ${rows.length}`);
    assert.equal(rows[0].action, "admin.migrate.day-counts");
    assert.equal(rows[0].target, "one-row-per-request");
  });

  it("never records a key, a token or a password", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const cookie = await adminCookie(env);
    await call(env, "/admin/api/channel-presets/clear", {
      method: "POST",
      cookie,
      // A body shaped like something that WOULD carry credentials, so the test
      // fails if the log ever starts copying whole bodies.
      json: { networkId: "aetv", creatorKey: "MYL-SECRET-KEY", adminKey: ADMIN_KEY, token: "tok_live_123", password: "hunter2", username: "someone" },
    });
    const row = env.DB.q("SELECT target, detail FROM admin_audit_log ORDER BY id DESC LIMIT 1")[0];
    const all = JSON.stringify(row);
    assert.equal(all.includes("MYL-SECRET-KEY"), false, "a Creator Key reached the log");
    assert.equal(all.includes(ADMIN_KEY), false, "the admin key reached the log");
    assert.equal(all.includes("tok_live_123"), false, "a token reached the log");
    assert.equal(all.includes("hunter2"), false, "a password reached the log");
    // It still records what it was asked to do, and to what.
    assert.equal(row.target, "aetv");
    assert.match(row.detail, /networkId/);
    assert.match(row.detail, /someone/);
  });

  it("records nothing for a request that was not authorized", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const res = await call(env, "/admin/api/migrate-day-counts", { method: "POST", json: { username: "someone" } });
    assert.equal(res.status, 401);
    assert.equal(env.DB.q("SELECT COUNT(*) AS n FROM admin_audit_log")[0].n, 0, "an unauthenticated request is not an admin action");
  });

  it("reads back newest first, with the detail it recorded", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const cookie = await adminCookie(env);
    await call(env, "/admin/api/channel-presets/clear", { method: "POST", cookie, json: { networkId: "history" } });
    const read = await call(env, "/admin/api/audit?limit=10", { cookie });
    assert.equal(read.status, 200);
    assert.ok(read.body.entries.length >= 2);
    assert.equal(read.body.entries[0].action, "admin.channel-presets.clear", "the newest row comes first");
    assert.equal(read.body.entries[0].target, "history");
    assert.equal(read.body.entries.some((e) => e.action === "admin.audit.read"), false, "reading the log is not itself an action");
  });
});
