// A catalog row whose provider failed must not be cached.
//
// A good shared row is cached for five minutes. The three answers a failure
// gives -- the last good copy, the "temporarily unavailable" tile, and an
// empty page -- were sent with the default one-hour cache, so a provider that
// was down for a minute stayed "down" in Stremio, Nuvio and Wako for an hour.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeEnv, makeD1, makeKv, call } from "./harness.mjs";

const realFetch = globalThis.fetch;
const realCaches = globalThis.caches;

async function installWithOneRow(env) {
  const saved = await call(env, "/api/save", {
    method: "POST",
    json: {
      entries: [{ id: "list1", url: "https://mdblist.com/lists/linaspurinis/top-watched-movies-of-the-week", name: "Top", type: "movie" }],
    },
  });
  assert.equal(saved.body.ok, true);
  return saved.body.id;
}

describe("a failed provider is never cached", () => {
  it("the 'temporarily unavailable' tile (nothing good to fall back on) is no-store", async () => {
    globalThis.fetch = async () => new Response("down", { status: 503 });
    try {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
      const id = await installWithOneRow(env);
      const r = await call(env, `/${id}/catalog/movie/list1.json`);
      assert.equal(r.status, 200);
      assert.equal(r.body.metas[0].id, "tt0000000", "the placeholder tile is what this case is about");
      assert.match(r.body.metas[0].name, /temporarily unavailable/);
      assert.equal(r.headers.get("cache-control"), "no-store");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("the last good copy served in its place is no-store too", async () => {
    globalThis.fetch = async () => new Response("down", { status: 503 });
    const good = [{ id: "tt0111161", type: "movie", name: "Kept" }];
    globalThis.caches = {
      default: { match: async () => new Response(JSON.stringify(good)), put: async () => {} },
      open: async () => ({ match: async () => null, put: async () => {} }),
    };
    try {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
      const id = await installWithOneRow(env);
      const r = await call(env, `/${id}/catalog/movie/list1.json`);
      assert.equal(r.body.stale, true, "this is the last-known-good branch");
      assert.equal(r.body.metas[0].id, "tt0111161");
      assert.equal(r.headers.get("cache-control"), "no-store");
    } finally {
      globalThis.fetch = realFetch;
      globalThis.caches = realCaches;
    }
  });

  it("a failed later page (skip > 0) is no-store too", async () => {
    globalThis.fetch = async () => new Response("down", { status: 503 });
    try {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
      const id = await installWithOneRow(env);
      const r = await call(env, `/${id}/catalog/movie/list1/skip=100.json`);
      assert.deepEqual(r.body.metas, []);
      assert.ok(r.body.error, "the reason stays visible for debugging");
      assert.equal(r.headers.get("cache-control"), "no-store");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
