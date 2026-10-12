// DELETE /api/me/sessions: which sessions an `id` revokes.
//
// `id` was used as a SQL LIKE prefix (`id || "%"`), so `{id:"%"}` matched every
// session of the account, the caller's own included, and `{id:""}` was treated
// as "no target" and revoked them all too. The list endpoint hands out ids of
// exactly 16 hex characters, so that is all that is accepted: anything else is
// a 400 and nothing is revoked. Sending no `id` at all still means "all
// sessions", which is the documented behaviour.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { call, createUser, makeD1, makeEnv, makeKv } from "./harness.mjs";

async function signedInThrice() {
  const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
  const u = await createUser(env, "revokeme");
  const cookies = [];
  for (let i = 0; i < 3; i++) {
    const r = await call(env, "/api/session", {
      method: "POST",
      json: { username: u.creatorName, key: u.creatorKey },
      headers: { "User-Agent": "Device " + i },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    cookies.push((r.headers.get("set-cookie") || "").split(";")[0]);
  }
  return { env, cookies };
}

const stillValid = async (env, cookie) => (await call(env, "/api/me", { method: "GET", cookie })).status === 200;
const revoke = (env, cookie, json) => call(env, "/api/me/sessions", { method: "DELETE", cookie, json });

describe("DELETE /api/me/sessions with an id", () => {
  for (const id of ["%", "", "_", "ab%", "0123456789abcde", "0123456789abcdef0", "ZZZZZZZZZZZZZZZZ", 12, null]) {
    it("refuses id " + JSON.stringify(id) + " and revokes nothing", async () => {
      const { env, cookies } = await signedInThrice();
      const r = await revoke(env, cookies[0], { id });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.ok(!r.headers.get("set-cookie"), "the caller is not logged out");
      for (const c of cookies) assert.equal(await stillValid(env, c), true);
    });
  }

  it("refuses an empty id in the query string too", async () => {
    const { env, cookies } = await signedInThrice();
    const r = await call(env, "/api/me/sessions?id=", { method: "DELETE", cookie: cookies[0] });
    assert.equal(r.status, 400);
    for (const c of cookies) assert.equal(await stillValid(env, c), true);
  });

  it("revokes exactly the session whose 16 character id it is", async () => {
    const { env, cookies } = await signedInThrice();
    const list = await call(env, "/api/me/sessions", { method: "GET", cookie: cookies[0] });
    const target = list.body.sessions.find((s) => s.userAgent === "Device 2");
    assert.match(target.id, /^[0-9a-f]{16}$/);
    const r = await revoke(env, cookies[0], { id: target.id });
    assert.equal(r.status, 200);
    assert.equal(r.body.revoked, 1);
    assert.equal(await stillValid(env, cookies[2]), false);
    assert.equal(await stillValid(env, cookies[0]), true);
    assert.equal(await stillValid(env, cookies[1]), true);
  });

  it("an id that matches nothing revokes nothing", async () => {
    const { env, cookies } = await signedInThrice();
    const r = await revoke(env, cookies[0], { id: "0000000000000000" });
    assert.equal(r.status, 200);
    assert.equal(r.body.revoked, 0);
    for (const c of cookies) assert.equal(await stillValid(env, c), true);
  });

  it("with no id at all it still means every session, the caller's included", async () => {
    const { env, cookies } = await signedInThrice();
    const r = await revoke(env, cookies[0], undefined);
    assert.equal(r.status, 200);
    assert.equal(r.body.revokedAll, true);
    for (const c of cookies) assert.equal(await stillValid(env, c), false);
  });
});
