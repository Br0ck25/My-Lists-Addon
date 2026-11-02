// SEC-01: the Account Key "blind index" must not keep an unsalted SHA-256 copy
// of the key once the peppered HMAC exists. The SHA-256 copy lets someone with
// a database or KV listing test guesses against every account at once.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { call, createUser, makeD1, makeEnv, makeKv } from "./harness.mjs";

const PEPPER = "test_lookup_pepper_secret_value_32_bytes";

function legacyKvKeys(kv) {
  return [...kv._store.keys()].filter((k) => k.startsWith("keylookup:") || k.startsWith("creatorlookuphash:"));
}
async function legacyRows(db) {
  const r = await db.prepare("SELECT * FROM creator_key_lookups").all();
  return r.results;
}
async function hmacOf(db, name) {
  const r = await db.prepare("SELECT key_lookup_hmac FROM accounts WHERE lower(username) = lower(?)").bind(name).first();
  return r && r.key_lookup_hmac;
}

describe("SEC-01 step 1: no unsalted copy of the key when the pepper is set", () => {
  it("creating an account with LOOKUP_PEPPER writes only the HMAC", async () => {
    const db = makeD1();
    const kv = makeKv();
    const env = makeEnv({ DB: db, CONFIGS: kv, LOOKUP_PEPPER: PEPPER });
    const user = await createUser(env, "peppered");
    assert.ok(await hmacOf(db, "peppered"), "the HMAC is stored");
    assert.deepEqual(await legacyRows(db), [], "no SHA-256 row in creator_key_lookups");
    assert.deepEqual(legacyKvKeys(kv), [], "no keylookup: / creatorlookuphash: KV key");

    const r = await call(env, "/api/creator/forgot-username", { method: "POST", json: { creatorKey: user.creatorKey } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.username, "peppered");
  });

  it("without LOOKUP_PEPPER behaviour is unchanged (SHA-256 row and KV keys are written)", async () => {
    const db = makeD1();
    const kv = makeKv();
    const env = makeEnv({ DB: db, CONFIGS: kv });
    await createUser(env, "nopepper");
    assert.equal((await legacyRows(db)).length, 1);
    assert.ok(legacyKvKeys(kv).length >= 2);
  });

  it("resetting the key with the pepper set leaves no legacy copy of the old or the new key", async () => {
    const db = makeD1();
    const kv = makeKv();
    const plain = makeEnv({ DB: db, CONFIGS: kv });
    await createUser(plain, "resetme", { recoveryAnswer: "blue sky" });
    assert.equal((await legacyRows(db)).length, 1, "starts with a legacy copy");
    const env = makeEnv({ DB: db, CONFIGS: kv, LOOKUP_PEPPER: PEPPER });
    const r = await call(env, "/api/creator/reset-key", { method: "POST", json: { username: "resetme", recoveryAnswer: "blue sky" } });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.ok(await hmacOf(db, "resetme"));
    assert.deepEqual(await legacyRows(db), []);
    assert.deepEqual(legacyKvKeys(kv), []);
    const f = await call(env, "/api/creator/forgot-username", { method: "POST", json: { creatorKey: r.body.creatorKey, recoveryAnswer: "blue sky" } });
    assert.equal(f.body.username, "resetme", JSON.stringify(f.body));
  });
});

describe("SEC-01 step 2: a legacy-only account is cleaned up on its next sign-in", () => {
  async function legacyOnlyAccount(name) {
    const db = makeD1();
    const kv = makeKv();
    const plain = makeEnv({ DB: db, CONFIGS: kv });
    const user = await createUser(plain, name);
    assert.equal((await legacyRows(db)).length, 1);
    assert.equal(await hmacOf(db, name), null, "no HMAC before the pepper exists");
    // FF_SESSIONS: the key-in-body sign-in only reaches the HMAC backfill when sessions are on.
    const env = makeEnv({ DB: db, CONFIGS: kv, LOOKUP_PEPPER: PEPPER, FF_SESSIONS: "1" });
    return { db, kv, env, user };
  }

  it("a creator API request that presents the key backfills the HMAC and drops the legacy copy", async () => {
    const { db, kv, env, user } = await legacyOnlyAccount("legacyapi");
    const r = await call(env, "/api/creator/sync/load", { method: "POST", json: { creatorName: user.creatorName, creatorKey: user.creatorKey } });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.ok(await hmacOf(db, "legacyapi"));
    assert.deepEqual(await legacyRows(db), []);
    assert.deepEqual(legacyKvKeys(kv), []);
  });

  it("POST /api/session does the same", async () => {
    const { db, kv, env, user } = await legacyOnlyAccount("legacysess");
    const r = await call(env, "/api/session", { method: "POST", json: { username: "legacysess", key: user.creatorKey } });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.ok(await hmacOf(db, "legacysess"));
    assert.deepEqual(await legacyRows(db), []);
    assert.deepEqual(legacyKvKeys(kv), []);
  });

  it("forgot-username still finds the account afterwards, through the HMAC", async () => {
    const { env, user } = await legacyOnlyAccount("legacyforgot");
    await call(env, "/api/session", { method: "POST", json: { username: "legacyforgot", key: user.creatorKey } });
    const f = await call(env, "/api/creator/forgot-username", { method: "POST", json: { creatorKey: user.creatorKey } });
    assert.equal(f.body.username, "legacyforgot", JSON.stringify(f.body));
  });
});
