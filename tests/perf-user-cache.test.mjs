import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadWorkerWithHooks } from "./perf-hooks.mjs";

// PERF-09: the per-user provider cache evicted in insertion order (a FIFO with an
// "LRU" comment), and catalog previews (one entry per title) flooded it.

const load = () => loadWorkerWithHooks(`export const __c = { get: getPerUserCache, set: setPerUserCache };`);

describe("PERF-09: provider cache survives preview floods and is a real LRU", () => {
  it("2,000 catalog previews do not evict an earlier user_cache: entry", async () => {
    const { __c } = await load();
    __c.set("user_cache:trakt:abc:/x", { rows: [1] }, 60, 1800);
    for (let i = 0; i < 2000; i++) __c.set(`catalog-preview:v3:movie:tt${1000000 + i}`, { description: "d" }, 86400, 604800);
    const hit = __c.get("user_cache:trakt:abc:/x");
    assert.ok(hit, "provider response must still be cached");
    assert.deepEqual(hit.data, { rows: [1] });
    // And the previews themselves are still cached (their own, larger bound).
    assert.ok(__c.get("catalog-preview:v3:movie:tt1001999"), "latest preview cached");
    assert.ok(__c.get("catalog-preview:v3:movie:tt1000000"), "an early preview is not evicted at 2,000 (own bound is larger)");
  });

  it("a key that is read stays; the least recently used one goes first", async () => {
    const { __c } = await load();
    __c.set("user_cache:p:first", { n: 0 }, 60, 1800);
    for (let i = 1; i <= 1000; i++) {
      __c.set(`user_cache:p:k${i}`, { n: i }, 60, 1800);
      if (i === 500) assert.ok(__c.get("user_cache:p:first"), "read mid-way refreshes recency");
    }
    assert.ok(__c.get("user_cache:p:first"), "the recently read first entry survives 1,001 inserts");
    assert.equal(__c.get("user_cache:p:k1"), null, "the oldest unread entry was the one evicted");
  });

  it("TTL behaviour is unchanged: fresh, then stale, then gone", async () => {
    const { __c } = await load();
    const real = Date.now;
    let t = 1_000_000;
    Date.now = () => t;
    try {
      __c.set("user_cache:p:ttl", { v: 1 }, 10, 100);
      assert.equal(__c.get("user_cache:p:ttl").isFresh, true);
      t += 11_000;
      const stale = __c.get("user_cache:p:ttl");
      assert.equal(stale.isStale, true);
      t += 100_000;
      assert.equal(__c.get("user_cache:p:ttl"), null);
    } finally { Date.now = real; }
  });
});
