// My Lists TV encrypted setup backup (src/api/81_tv-backup-routes.js).
// The Worker stores an opaque blob under a hashed id and never interprets it, so these tests
// check the contract the TV app depends on: store, fetch, replace, refuse, and no browser origin needed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { freshIsolate, makeEnv, makeKv, nextIp } from "./harness.mjs";

const ID = "0123456789abcdef0123456789abcdef";
const call = async (env, method, query, body) => {
  const w = await freshIsolate();
  // No Origin and no JSON content type on purpose: the TV app is not a browser page.
  const req = new Request(`https://example.test/api/tv-backup${query}`, { method, body, headers: { "CF-Connecting-IP": nextIp() } });
  return w.fetch(req, env, { waitUntil() {} });
};

describe("My Lists TV backup", () => {
  it("stores a blob and returns exactly the same text, without a browser origin", async () => {
    const env = makeEnv({ CONFIGS: makeKv() });
    const put = await call(env, "PUT", `?id=${ID}`, "BLOB-ciphertext-AAAA==");
    assert.equal(put.status, 200);
    const got = await call(env, "GET", `?id=${ID}`);
    assert.equal(got.status, 200);
    assert.equal(await got.text(), "BLOB-ciphertext-AAAA==");
    assert.equal(got.headers.get("cache-control"), "no-store");
  });

  it("a new backup replaces the last one", async () => {
    const env = makeEnv({ CONFIGS: makeKv() });
    await call(env, "PUT", `?id=${ID}`, "first");
    await call(env, "PUT", `?id=${ID}`, "second");
    assert.equal(await (await call(env, "GET", `?id=${ID}`)).text(), "second");
  });

  it("answers 404 for a code that never backed up, and does not mix up ids", async () => {
    const env = makeEnv({ CONFIGS: makeKv() });
    await call(env, "PUT", `?id=${ID}`, "mine");
    const other = await call(env, "GET", "?id=ffffffffffffffffffffffffffffffff");
    assert.equal(other.status, 404);
  });

  it("refuses an id that is not 32 hex characters", async () => {
    const env = makeEnv({ CONFIGS: makeKv() });
    for (const bad of ["", "?id=abc", `?id=${ID}zz`, "?id=../../etc", `?id=${ID.toUpperCase()}`]) {
      assert.equal((await call(env, "PUT", bad, "x")).status, 400, `PUT ${bad}`);
      assert.equal((await call(env, "GET", bad)).status, 400, `GET ${bad}`);
    }
  });

  it("refuses an empty body and a body over the size cap", async () => {
    const env = makeEnv({ CONFIGS: makeKv() });
    assert.equal((await call(env, "PUT", `?id=${ID}`, "")).status, 400);
    assert.equal((await call(env, "PUT", `?id=${ID}`, "a".repeat(256 * 1024 + 1))).status, 413);
    assert.equal((await call(env, "GET", `?id=${ID}`)).status, 404, "nothing was stored by the refused writes");
  });

  it("is rate limited per caller", async () => {
    const env = makeEnv({ CONFIGS: makeKv() });
    const w = await freshIsolate();
    const ip = nextIp();
    let last = 0;
    for (let i = 0; i < 35; i++) {
      const res = await w.fetch(new Request(`https://example.test/api/tv-backup?id=${ID}`, { headers: { "CF-Connecting-IP": ip } }), env, { waitUntil() {} });
      last = res.status;
    }
    assert.equal(last, 429);
  });

  it("only GET and PUT are allowed", async () => {
    const env = makeEnv({ CONFIGS: makeKv() });
    assert.equal((await call(env, "DELETE", `?id=${ID}`)).status, 405);
  });
});
