import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, makeD1, makeKv } from "./harness.mjs";
import { loadWorkerWithHooks } from "./perf-hooks.mjs";

// PERF-05: the page is hashed (FNV over ~1.6 MB) to find its memo, on every
// request to "/", 304s included. The same string object must hit without hashing.

describe("PERF-05: page memo does not re-hash an identical page", () => {
  it("two GET / hash the page once, and the body and ETag do not change", async () => {
    const mod = await loadWorkerWithHooks(`
      export const __count = { hash: 0 };
      { const orig = splitPageMemoKey; splitPageMemoKey = (h) => (__count.hash++, orig(h)); }
    `);
    const w = mod.default;
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const get = (headers = {}) => w.fetch(new Request("https://example.com/", { headers }), env, { waitUntil() {}, passThroughOnException() {} });
    const a = await get();
    assert.equal(a.status, 200);
    const bodyA = await a.text();
    const etagA = a.headers.get("etag");
    assert.ok(etagA);
    const hashesAfterFirst = mod.__count.hash;
    const b = await get();
    const bodyB = await b.text();
    assert.equal(mod.__count.hash, hashesAfterFirst, "second identical page must not be hashed again");
    // The CSP nonce is fresh per response, so compare with it masked.
    const mask = (s) => s.replace(/nonce="[^"]*"/g, 'nonce=""');
    assert.equal(mask(bodyB), mask(bodyA));
    assert.equal(b.headers.get("etag"), etagA);
    const c = await get({ "If-None-Match": etagA });
    assert.equal(c.status, 304);
    assert.equal(mod.__count.hash, hashesAfterFirst, "a 304 must not hash the page either");
  });
});
