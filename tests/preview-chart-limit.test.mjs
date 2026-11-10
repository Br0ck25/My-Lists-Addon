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
});
