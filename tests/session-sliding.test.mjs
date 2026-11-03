// SEC-03 step 0: a session renews while it is used. Today expires_at is fixed
// at sign-in, so someone who visits every day is still signed out after 30
// days. Now a session in use gets 30 more days (at most every 5 minutes, with
// the last_seen_at refresh), and the cookie is re-issued so the browser's own
// copy of the 30 days moves too. A session that was revoked, expired or whose
// account was deleted is never brought back by a request.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { call, createUser, freshIsolate, makeD1, makeEnv, makeKv } from "./harness.mjs";

const DAY = 86400000;
const THIRTY = 30 * DAY;

async function setup() {
  const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), FF_SESSIONS: "1" });
  const user = await createUser(env, "slider");
  const login = await call(env, "/api/session", { method: "POST", json: { username: user.creatorName, key: user.creatorKey } });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  assert.match(cookie, /^mla_session=/);
  const row = () => env.DB._db.prepare("SELECT * FROM sessions").get();
  // As if the session had been issued `ageDays` ago and last used `idleDays` ago.
  const age = (ageDays, idleDays) => {
    const now = Date.now();
    env.DB._db.prepare("UPDATE sessions SET created_at = ?, last_seen_at = ?, expires_at = ?")
      .run(now - ageDays * DAY, now - idleDays * DAY, now - ageDays * DAY + THIRTY);
  };
  const restore = async () => call(env, "/api/creator/restore", { method: "POST", cookie, w: await freshIsolate(), json: { creatorName: user.creatorName } });
  return { env, user, cookie, row, age, restore };
}

describe("SEC-03 step 0: sliding sessions", () => {
  it("a session used on day 29 is renewed for 30 more days, so it is still valid on day 50", async () => {
    const { row, age, restore } = await setup();
    age(29, 0.5); // issued 29 days ago, last seen 12 hours ago: one day of life left
    const r = await restore();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const expiresAt = row().expires_at;
    assert.ok(expiresAt > Date.now() + THIRTY - 60000, "expires_at moved to about now + 30 days");
    // Day 50 is 21 days after that request: still valid under the renewed expiry.
    assert.ok(expiresAt > Date.now() + 21 * DAY);
  });

  it("re-issues the cookie with a fresh 30 days when it renews", async () => {
    const { age, restore, cookie } = await setup();
    age(29, 0.5);
    const r = await restore();
    const setCookie = r.headers.get("set-cookie") || "";
    assert.ok(setCookie.startsWith(cookie + ";"), "the same token is sent again: " + setCookie);
    assert.match(setCookie, /Max-Age=2592000/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
  });

  it("does not touch the database or the cookie again within 5 minutes", async () => {
    const { row, restore } = await setup();
    const before = row().expires_at;
    const r = await restore(); // just signed in: last_seen_at is fresh
    assert.equal(r.status, 200);
    assert.equal(row().expires_at, before);
    assert.equal(r.headers.get("set-cookie"), null);
  });

  it("a session not used for 31 days is refused and stays expired", async () => {
    const { row, age, restore } = await setup();
    age(31, 31);
    const before = row().expires_at;
    const r = await restore();
    assert.equal(r.status, 401);
    assert.equal(row().expires_at, before, "a request does not revive it");
    assert.equal(r.headers.get("set-cookie"), null);
  });

  it("a revoked session is not revived by a request", async () => {
    const { env, row, age, restore } = await setup();
    age(10, 10);
    env.DB._db.prepare("UPDATE sessions SET revoked_at = ?").run(Date.now() - DAY);
    const before = row();
    const r = await restore();
    assert.equal(r.status, 401);
    const after = row();
    assert.equal(after.expires_at, before.expires_at);
    assert.equal(after.revoked_at, before.revoked_at);
  });

  it("a session of a deleted account is not renewed", async () => {
    const { env, row, age, restore } = await setup();
    age(10, 10);
    env.DB._db.prepare("UPDATE accounts SET status = 'deleted', deleted_at = ?").run(Date.now());
    const before = row().expires_at;
    const r = await restore();
    assert.equal(r.status, 401);
    assert.equal(row().expires_at, before);
  });
});
