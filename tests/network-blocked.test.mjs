// The suite must not talk to real services (audit TEST-11).
//
// Before this, ~1,200 requests per run went to TMDB, Cinemeta, JustWatch and
// MDBList, because files that import the harness without installing their own
// fetch stub fell through to the real one: unwanted traffic from every CI run,
// and tests that passed by silently taking the "provider failed" path. The
// harness now replaces fetch with one that refuses any host outside
// example.test; a test that needs an answer installs its own stub, as many do.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { call, makeEnv, realFetch } from "./harness.mjs";

describe("outside network is blocked in tests", () => {
  it("a request to a real provider fails loudly, naming the URL", async () => {
    await assert.rejects(() => fetch("https://api.themoviedb.org/3/movie/603?api_key=x"), /network blocked in tests: https:\/\/api\.themoviedb\.org\/3\/movie\/603/);
    await assert.rejects(() => fetch(new Request("https://v3-cinemeta.strem.io/meta/movie/tt0133093.json")), /network blocked in tests/);
  });

  it("the harness keeps the real fetch for the rare place that needs it", () => {
    assert.equal(typeof realFetch, "function");
    assert.notEqual(realFetch, globalThis.fetch);
  });

  it("a Worker route that reaches a provider with no stub in place gets the blocked error, not a real answer", async () => {
    const blocked = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      try { return await original(input, init); } catch (e) { blocked.push(String(e.message)); throw e; }
    };
    try {
      await call(makeEnv({ TMDB_API_KEY: "k" }), "/api/resolve-show?tmdbId=1396");
    } finally { globalThis.fetch = original; }
    assert.ok(blocked.some((m) => /network blocked in tests: https:\/\/api\.themoviedb\.org/.test(m)), `expected a blocked TMDB call, got ${JSON.stringify(blocked)}`);
  });
});
