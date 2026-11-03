// SEC-02: the provider keys and tokens in the cloud-sync blob (creatorsync:<name>
// in KV) are encrypted at rest when TOKEN_ENCRYPTION_KEY is set, the way the
// newer connection and install-secret stores already are. The page receives
// exactly the same `keys` object as before.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { call, createUser, makeD1, makeEnv, makeKv } from "./harness.mjs";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const KEYS = { traktAccessToken: "TRK-SECRET-1", mdblistKey: "MDB-SECRET-2", simklAccessToken: "SIM-SECRET-3", region: "US" };

const save = (env, u, keys) => call(env, "/api/creator/sync/save", {
  method: "POST", json: { creatorName: u.creatorName, creatorKey: u.creatorKey, config: [], keys },
});
const load = async (env, u) => (await call(env, "/api/creator/sync/load", {
  method: "POST", json: { creatorName: u.creatorName, creatorKey: u.creatorKey },
})).body.data.keys;
const raw = (env, u) => env.CONFIGS._store.get(`creatorsync:${u.creatorName}`);

describe("SEC-02: sync keys are sealed in KV", () => {
  it("with an encryption key, no token appears in the stored blob and load returns the same keys", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), TOKEN_ENCRYPTION_KEY: TEST_KEY });
    const u = await createUser(env, "sealed");
    assert.equal((await save(env, u, KEYS)).body.ok, true);
    const stored = raw(env, u);
    for (const secret of ["TRK-SECRET-1", "MDB-SECRET-2", "SIM-SECRET-3"]) assert.ok(!stored.includes(secret), `${secret} is not in KV`);
    assert.deepEqual(await load(env, u), KEYS);
  });

  it("a later save that omits a credential still keeps it (the merge reads the sealed keys)", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), TOKEN_ENCRYPTION_KEY: TEST_KEY });
    const u = await createUser(env, "sealedmerge");
    await save(env, u, KEYS);
    await save(env, u, { region: "GB" });
    assert.ok(!raw(env, u).includes("TRK-SECRET-1"));
    assert.deepEqual(await load(env, u), { ...KEYS, region: "GB" });
  });

  it("a legacy plaintext blob still loads, and is sealed by the next save", async () => {
    const plain = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const u = await createUser(plain, "legacyblob");
    await save(plain, u, KEYS);
    assert.ok(raw(plain, u).includes("TRK-SECRET-1"), "no key configured: stored as before");
    const env = makeEnv({ DB: plain.DB, CONFIGS: plain.CONFIGS, TOKEN_ENCRYPTION_KEY: TEST_KEY });
    assert.deepEqual(await load(env, u), KEYS);
    await save(env, u, { region: "FR" });
    assert.ok(!raw(env, u).includes("TRK-SECRET-1"));
    assert.deepEqual(await load(env, u), { ...KEYS, region: "FR" });
  });

  it("another account's sealed blob cannot be opened under a different name", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), TOKEN_ENCRYPTION_KEY: TEST_KEY });
    const a = await createUser(env, "owner1");
    const b = await createUser(env, "owner2");
    await save(env, a, KEYS);
    env.CONFIGS._store.set(`creatorsync:${b.creatorName}`, raw(env, a));
    const keys = await load(env, b);
    assert.ok(!JSON.stringify(keys || {}).includes("TRK-SECRET-1"));
  });

  it("without an encryption key the stored blob is exactly as before", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const u = await createUser(env, "plainblob");
    await save(env, u, KEYS);
    assert.deepEqual(JSON.parse(raw(env, u)).keys, KEYS);
    assert.deepEqual(await load(env, u), KEYS);
  });
});
