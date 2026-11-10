// Audit PERF-03 (server part): opening the home page fires ~30 /api/preview
// calls for public charts, each charged to a 240-a-minute budget per address
// with a D1 write; the ninth visit a minute from one address got 429s. Public
// chart previews (first page) are shared data and are not charged. Everything
// else, including a deep page of a chart, still is.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeEnv, makeD1, makeKv, call, nextIp } from "./harness.mjs";

const realFetch = globalThis.fetch;
const stubTmdb = () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ results: [], total_pages: 1 }), { status: 200, headers: { "content-type": "application/json" } });
};
const counters = (env) => env.DB._db.prepare("SELECT count(*) AS n FROM rate_counters").get().n;
const preview = (env, ip, body) => call(env, "/api/preview", { method: "POST", ip, json: { type: "movie", sample: 12, ...body } });

describe("PERF-03: public chart previews do not spend the preview budget", () => {
  it("300 chart previews from one address all succeed and write no counter", async () => {
    stubTmdb();
    try {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), TMDB_API_KEY: "k" });
      const ip = nextIp();
      for (let i = 0; i < 300; i++) {
        const r = await preview(env, ip, { url: i % 2 ? "tmdb:chart:popular" : "tmdb:chart:trending" });
        assert.notEqual(r.status, 429, `request ${i} was refused`);
      }
      assert.equal(counters(env), 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("other previews are still limited per address", async () => {
    stubTmdb();
    try {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), TMDB_API_KEY: "k" });
      const ip = nextIp();
      let refused = 0;
      for (let i = 0; i < 260; i++) {
        const r = await preview(env, ip, { url: "https://mdblist.com/lists/bob/list" + i });
        if (r.status === 429) refused++;
      }
      assert.ok(refused > 0, "the 240-a-minute budget still applies");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("walking a chart's deep pages is still limited", async () => {
    stubTmdb();
    try {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), TMDB_API_KEY: "k" });
      const ip = nextIp();
      let refused = 0;
      for (let i = 0; i < 260; i++) {
        const r = await preview(env, ip, { url: "tmdb:chart:popular", skip: (i + 1) * 20 });
        if (r.status === 429) refused++;
      }
      assert.ok(refused > 0, "only the first page is free");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("a skip beyond the provider's pages is clamped, not forwarded", async () => {
    const asked = [];
    globalThis.fetch = async (u) => { asked.push(String(typeof u === "string" ? u : u.url)); return new Response(JSON.stringify({ results: [], total_pages: 500 }), { status: 200, headers: { "content-type": "application/json" } }); };
    try {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), TMDB_API_KEY: "k" });
      await preview(env, nextIp(), { url: "tmdb:chart:popular", skip: 1e20 });
      for (const u of asked) {
        const m = u.match(/[?&]page=(\d+)/);
        if (m) assert.ok(Number(m[1]) <= 500, "asked for page " + m[1]);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // Audit PERF-03 verification: the chart's cache is per region (and per key), so a caller that
  // changes the region on every request makes every call a cache miss on the shared TMDB key.
  const refusedCount = async (bodyFor, n = 260) => {
    stubTmdb();
    try {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), TMDB_API_KEY: "k" });
      const ip = nextIp();
      let refused = 0;
      for (let i = 0; i < n; i++) if ((await preview(env, ip, bodyFor(i))).status === 429) refused++;
      return refused;
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  it("a made-up region on every request is still limited", async () => {
    assert.ok(await refusedCount((i) => ({ url: "tmdb:chart:popular", region: "ZZ-" + i })) > 0);
  });

  it("a real country code is free, in either case", async () => {
    assert.equal(await refusedCount((i) => ({ url: "tmdb:chart:popular", region: i % 2 ? "GB" : "us" })), 0);
  });

  it("several charts stacked in one url are limited", async () => {
    assert.ok(await refusedCount(() => ({ url: "tmdb:chart:popular\ntmdb:chart:trending\ntmdb:chart:top_rated" })) > 0);
  });

  it("a request carrying its own keys is limited like any other", async () => {
    assert.ok(await refusedCount((i) => ({ url: "tmdb:chart:popular", tmdbKey: "mine" + i })) > 0);
  });

  // Second review: two letters is not a country. AA, BA, CA ... are 676 cache misses (and case
  // forms multiply them) on the shared key, so only a real country code, upper-cased, is free.
  it("two-letter codes that are not countries are limited", async () => {
    // XA-XZ, QB-QZ, YA-YZ and ZA-ZZ hold no country except XK, QA, YE, YT, ZA, ZM, ZW.
    const real = new Set(["XK", "QA", "YE", "YT", "ZA", "ZM", "ZW"]);
    const madeUp = [];
    for (const a of "XQYZ") for (const b of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") if (!real.has(a + b)) madeUp.push(a + b);
    assert.ok(madeUp.length > 90);
    assert.ok(await refusedCount((i) => ({ url: "tmdb:chart:popular", region: madeUp[i % madeUp.length] }), 300) > 0);
  });

  it("a real country is free in any case, and reaches the provider upper-cased", async () => {
    const asked = [];
    globalThis.fetch = async (u) => { asked.push(String(typeof u === "string" ? u : u.url)); return new Response(JSON.stringify({ results: [], total_pages: 1 }), { status: 200, headers: { "content-type": "application/json" } }); };
    try {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), TMDB_API_KEY: "k" });
      const ip = nextIp();
      for (let i = 0; i < 260; i++) {
        const r = await preview(env, ip, { url: "tmdb:chart:popular", region: ["us", "Us", "uS", "US"][i % 4] });
        assert.notEqual(r.status, 429, `request ${i} was refused`);
      }
      assert.ok(!asked.some((u) => /region=us\b/.test(u)), "no lower-case region reached the provider");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
