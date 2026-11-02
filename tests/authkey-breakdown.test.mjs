// CQ-17: the "Account Key" counter says where the key came from. The total
// (authkey) stays as it was; each counted request also bumps authkey:<path>
// and authkey:why:<reason>, so /admin can tell a browser with no session from
// a bug that sends the key next to a valid session.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { call, createUser, makeD1, makeEnv, makeKv } from "./harness.mjs";

async function setup() {
  const db = makeD1();
  const env = makeEnv({ DB: db, CONFIGS: makeKv(), FF_SESSIONS: "1" });
  const user = await createUser(env, "keysource");
  const first = await call(env, "/api/creator/sync/save", {
    method: "POST", json: { creatorName: user.creatorName, creatorKey: user.creatorKey, config: [] },
  });
  assert.equal(first.body.ok, true, JSON.stringify(first.body));
  const cookie = ((first.headers.get("set-cookie") || "").match(/(mla_session=[^;]+)/) || [])[1];
  assert.ok(cookie);
  return { env, db, user, cookie };
}

describe("authkey counter breakdown", () => {
  it("a key with no session is counted by path and as nocookie", async () => {
    const { db } = await setup();
    assert.equal(db._stat("authkey", "total"), 1);
    assert.equal(db._stat("authkey:api-creator-sync", "total"), 1);
    assert.equal(db._stat("authkey:why:nocookie", "total"), 1);
    assert.equal(db._stat("authkey:why:withsession", "total"), undefined);
  });

  it("a key sent next to a valid session of the same account is withsession (the bug signal)", async () => {
    const { env, db, user, cookie } = await setup();
    const r = await call(env, "/api/creator/restore", {
      method: "POST", cookie, json: { creatorName: user.creatorName, creatorKey: user.creatorKey },
    });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.equal(db._stat("authkey", "total"), 2, "total still counts every key request");
    assert.equal(db._stat("authkey:why:withsession", "total"), 1);
    assert.equal(db._stat("authkey:api-creator-restore", "total"), 1);
    assert.equal(db._stat("authkey:why:nocookie", "total"), 1, "the first, cookie-less request is unchanged");
  });

  it("a key sent next to the session of another account is othersession", async () => {
    const { env, db, cookie } = await setup();
    const other = await createUser(env, "otherperson");
    const r = await call(env, "/api/creator/sync/load", {
      method: "POST", cookie, json: { creatorName: other.creatorName, creatorKey: other.creatorKey },
    });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.equal(db._stat("authkey:why:othersession", "total"), 1);
    assert.equal(db._stat("authkey:api-creator-sync", "total"), 2);
  });

  it("a session-signed request bumps nothing", async () => {
    const { env, db, user, cookie } = await setup();
    await call(env, "/api/creator/sync/load", { method: "POST", cookie, json: { creatorName: user.creatorName } });
    assert.equal(db._stat("authkey", "total"), 1);
    assert.equal(db._stat("authkey:why:withsession", "total"), undefined);
  });
});
