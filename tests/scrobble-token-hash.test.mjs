// SEC-04: media-server webhook tokens are not stored in plaintext. A database or
// KV copy must not hand out a working ?st= token. The Settings page still shows
// the URL later, so the token is kept encrypted (TOKEN_ENCRYPTION_KEY) next to a
// SHA-256 used for the lookup. Old plaintext rows migrate the first time they
// authenticate. Without the key or migration 0024, nothing changes.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { call, createUser, makeD1, makeEnv, makeKv, nextIp } from "./harness.mjs";

const TEST_KEY = Buffer.alloc(32, 9).toString("base64");

function newEnv(extra = {}) {
  return makeEnv({ DB: makeD1(), CONFIGS: makeKv(), ...extra });
}
const tokenFor = async (env, u, rotate = false) => {
  const r = await call(env, "/api/creator/scrobble-token", {
    method: "POST", ip: nextIp(), json: { creatorName: u.creatorName, creatorKey: u.creatorKey, rotate },
  });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  return r.body.token;
};
const ping = (env, token) => call(env, "/api/scrobble?st=" + encodeURIComponent(token), {
  method: "POST", ip: nextIp(), json: { event: "media.scrobble", Account: { title: "owner" }, Metadata: { type: "track", title: "x" } },
});
async function everywhere(env) {
  const rows = (await env.DB.prepare("SELECT * FROM scrobble_tokens").all()).results;
  const kv = [...env.CONFIGS._store.entries()].filter(([k]) => /scrobble/.test(k));
  return JSON.stringify({ rows, kv });
}

describe("SEC-04: a new webhook token is never stored raw", () => {
  it("D1 and KV hold no raw token, the token still works, and Settings shows it again", async () => {
    const env = newEnv({ TOKEN_ENCRYPTION_KEY: TEST_KEY });
    const u = await createUser(env, "hooked");
    const token = await tokenFor(env, u);
    assert.ok(token.length >= 8);
    assert.ok(!(await everywhere(env)).includes(token), "the raw token is not in D1 or KV");
    assert.notEqual((await ping(env, token)).status, 401, "the token authenticates");
    assert.equal(await tokenFor(env, u), token, "Settings shows the same URL later");
    assert.ok(!(await everywhere(env)).includes(token));
  });

  it("rotating revokes the old token and leaves no raw copy of either", async () => {
    const env = newEnv({ TOKEN_ENCRYPTION_KEY: TEST_KEY });
    const u = await createUser(env, "rotator");
    const first = await tokenFor(env, u);
    const second = await tokenFor(env, u, true);
    assert.notEqual(first, second);
    assert.equal((await ping(env, first)).status, 401, "the old token is revoked");
    assert.notEqual((await ping(env, second)).status, 401);
    const stored = await everywhere(env);
    assert.ok(!stored.includes(first) && !stored.includes(second));
    assert.equal((await env.DB.prepare("SELECT COUNT(*) n FROM scrobble_tokens").first()).n, 1);
  });

  it("a wrong token is refused", async () => {
    const env = newEnv({ TOKEN_ENCRYPTION_KEY: TEST_KEY });
    const u = await createUser(env, "wrongtok");
    await tokenFor(env, u);
    assert.equal((await ping(env, "not-the-token-0000")).status, 401);
  });
});

describe("SEC-04: an old plaintext token migrates when it authenticates", () => {
  it("works once, is then hashed everywhere, and keeps working", async () => {
    const plain = newEnv();
    const u = await createUser(plain, "oldhook");
    const token = await tokenFor(plain, u);
    assert.ok((await everywhere(plain)).includes(token), "starts out raw (no encryption key yet)");

    const env = makeEnv({ DB: plain.DB, CONFIGS: plain.CONFIGS, TOKEN_ENCRYPTION_KEY: TEST_KEY });
    assert.notEqual((await ping(env, token)).status, 401, "the old token still authenticates");
    assert.ok(!(await everywhere(env)).includes(token), "and is no longer raw in D1 or KV");
    assert.notEqual((await ping(env, token)).status, 401, "it keeps working after the migration");
    assert.equal(await tokenFor(env, u), token, "Settings still shows the same URL");
  });

  it("Settings alone also migrates an old token", async () => {
    const plain = newEnv();
    const u = await createUser(plain, "oldshow");
    const token = await tokenFor(plain, u);
    const env = makeEnv({ DB: plain.DB, CONFIGS: plain.CONFIGS, TOKEN_ENCRYPTION_KEY: TEST_KEY });
    assert.equal(await tokenFor(env, u), token);
    assert.ok(!(await everywhere(env)).includes(token));
    assert.notEqual((await ping(env, token)).status, 401);
  });
});

describe("SEC-04: nothing changes without the key or the migration", () => {
  it("without TOKEN_ENCRYPTION_KEY the token is stored as before", async () => {
    const env = newEnv();
    const u = await createUser(env, "nokey");
    const token = await tokenFor(env, u);
    const row = await env.DB.prepare("SELECT token, token_hash FROM scrobble_tokens").first();
    assert.equal(row.token, token);
    assert.equal(row.token_hash, null);
    assert.notEqual((await ping(env, token)).status, 401);
  });

  it("with the key but without migration 0024 it falls back to today's path", async () => {
    const env = newEnv({ TOKEN_ENCRYPTION_KEY: TEST_KEY });
    env.DB._db.exec("DROP INDEX IF EXISTS idx_scrobble_tokens_hash; ALTER TABLE scrobble_tokens DROP COLUMN token_hash; ALTER TABLE scrobble_tokens DROP COLUMN token_enc;");
    const u = await createUser(env, "nomig");
    const token = await tokenFor(env, u);
    assert.equal((await env.DB.prepare("SELECT token FROM scrobble_tokens").first()).token, token);
    assert.notEqual((await ping(env, token)).status, 401);
    assert.equal(await tokenFor(env, u), token);
    const rotated = await tokenFor(env, u, true);
    assert.equal((await ping(env, token)).status, 401);
    assert.notEqual((await ping(env, rotated)).status, 401);
  });
});

describe("SEC-04: deleting an account removes its webhook token", () => {
  it("leaves no scrobble row or key behind", async () => {
    const env = newEnv({ TOKEN_ENCRYPTION_KEY: TEST_KEY });
    const u = await createUser(env, "goner");
    const token = await tokenFor(env, u);
    const del = await call(env, "/api/creator/delete-account", { method: "POST", json: { creatorName: u.creatorName, creatorKey: u.creatorKey, confirm: "DELETE" } });
    assert.equal(del.body.ok, true, JSON.stringify(del.body));
    assert.equal((await ping(env, token)).status, 401);
    assert.equal((await env.DB.prepare("SELECT COUNT(*) n FROM scrobble_tokens").first()).n, 0);
    assert.deepEqual([...env.CONFIGS._store.keys()].filter((k) => /scrobbletoken/.test(k)), []);
  });
});
