// Audit API-05 (limiter part): 200 requests from one address, each with a
// different `skip`, made 1,483 TMDB calls: every distinct page misses every
// cache. The first page of a row stays free; pages after it share a budget of
// 120 a minute per address. Normal scrolling never gets near it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeEnv, makeD1, makeKv, call, nextIp } from "./harness.mjs";

const realFetch = globalThis.fetch;

describe("API-05: catalog pages after the first share a per-address budget", () => {
  it("many different skips from one address are cut off; the first page and other addresses are not", async () => {
    globalThis.fetch = async () => { return new Response(JSON.stringify({ results: [], total_pages: 500 }), { status: 200, headers: { "content-type": "application/json" } }); };
    try {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), TMDB_API_KEY: "k" });
      const ip = nextIp();
      const page = (skip, who) => call(env, `/catalog/movie/tmdb-chart-popular/skip=${skip}.json`, { ip: who });
      const statuses = [];
      for (let i = 1; i <= 150; i++) statuses.push((await page(i * 7, ip)).status);
      assert.ok(statuses.slice(0, 120).every((s) => s === 200), "normal scrolling is untouched: " + statuses.slice(0, 120).join(","));
      assert.ok(statuses.slice(120).every((s) => s === 429), "past the budget every new page is refused");
      assert.equal((await page(0, ip)).status, 200, "the first page is never charged");
      assert.equal((await page(40, nextIp())).status, 200, "another address has its own budget");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("a refused page is answered so an app can read it: CORS, no-store, Retry-After", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ results: [], total_pages: 500 }), { status: 200, headers: { "content-type": "application/json" } });
    try {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), TMDB_API_KEY: "k" });
      const ip = nextIp();
      let last;
      for (let i = 1; i <= 140; i++) last = await call(env, `/catalog/movie/tmdb-chart-popular/skip=${i * 7}.json`, { ip });
      assert.equal(last.status, 429);
      assert.equal(last.headers.get("access-control-allow-origin"), "*");
      assert.match(last.headers.get("cache-control") || "", /no-store/);
      assert.ok(last.headers.get("retry-after"));
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
