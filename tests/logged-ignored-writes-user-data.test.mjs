// CQ-07: failed saves of user data (account sessions, lists) must be logged,
// not lost in an empty catch. The request still succeeds in each case: these
// writes are best-effort, so both halves are checked.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, makeD1, makeKv, makeQueue, call, createUser } from "./harness.mjs";

async function captureWarnings(fn) {
  const logged = [];
  const realWarn = console.warn;
  console.warn = (...a) => logged.push(a.map(String).join(" "));
  try { await fn(); } finally { console.warn = realWarn; }
  return logged;
}

async function signedIn(name) {
  const db = makeD1();
  const env = makeEnv({ DB: db, DB_ACTIVITY: makeD1({ schema: "activity" }), CONFIGS: makeKv(), JOBS: makeQueue() });
  const user = await createUser(env, name);
  const login = await call(env, "/api/session", { method: "POST", json: { username: name, key: user.creatorKey } });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  return { env, db, cookie, user };
}

describe("failed user-data writes are logged and the request still succeeds", () => {
  it("logout: a failed session revoke is logged, and logout still answers ok", async () => {
    const { env, db, cookie } = await signedIn("logout1");
    db.failWhen((sql) => /UPDATE sessions SET revoked_at/i.test(sql));
    let res;
    const logged = await captureWarnings(async () => {
      res = await call(env, "/api/session", { method: "DELETE", cookie });
    });
    db.failWhen(null);
    assert.equal(res.status, 200, "logout must not fail because the revoke write failed");
    assert.ok(logged.some((l) => l.includes("revokeSession")), `expected a revokeSession warning, got: ${JSON.stringify(logged)}`);
  });

  it("list save: a failed sort_order update is logged and the save still succeeds", async () => {
    const { env, db, user } = await signedIn("order1");
    db.failWhen((sql) => /UPDATE creator_lists SET sort_order/i.test(sql));
    let res;
    const logged = await captureWarnings(async () => {
      res = await call(env, "/api/creator/lists/save", { method: "POST", json: { creatorName: "order1", creatorKey: user.creatorKey, slug: "fresh", name: "Fresh", type: "movie", items: [{ id: "tt0133093" }] } });
    });
    db.failWhen(null);
    assert.equal(res.body.ok, true, "the list must still save: " + JSON.stringify(res.body));
    assert.ok(logged.some((l) => l.includes("sort_order")), `expected a sort_order warning, got: ${JSON.stringify(logged)}`);
  });
  it("list delete: a failed likes-ledger delete is logged and the delete still answers ok", async () => {
    const { env, user } = await signedIn("del1");
    const saved = await call(env, "/api/creator/lists/save", { method: "POST", json: { creatorName: "del1", creatorKey: user.creatorKey, slug: "gone", name: "Gone", type: "movie", items: [{ id: "tt0133093" }] } });
    assert.equal(saved.body.ok, true, JSON.stringify(saved.body));
    env.CONFIGS._hooks.beforeDelete = (key) => { if (String(key).startsWith("listlikevoters:")) throw new Error("kv down"); };
    let res;
    const logged = await captureWarnings(async () => {
      res = await call(env, "/api/creator/lists/delete", { method: "POST", json: { creatorName: "del1", creatorKey: user.creatorKey, slug: "gone" } });
    });
    env.CONFIGS._hooks.beforeDelete = null;
    assert.equal(res.body.ok, true, "the delete must still succeed: " + JSON.stringify(res.body));
    assert.ok(logged.some((l) => l.includes("listlikevoters")), `expected a listlikevoters warning, got: ${JSON.stringify(logged)}`);
  });
});
