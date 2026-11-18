// Audit API-01: when the install lookup's KV read threw, manifest and catalog
// answered a bare 500 with no CORS header and the platform's error text. The
// Stremio-protocol routes now answer with CORS, no-store and a generic message
// (and an empty row for catalog/meta/subtitles), never the storage error.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeEnv, makeD1, makeKv, call, createUser } from "./harness.mjs";

async function setup() {
  const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), FF_INSTALLS: "1" });
  const user = await createUser(env, "kvdown");
  const saved = await call(env, "/api/creator/sync/save", { method: "POST", json: { creatorName: user.creatorName, creatorKey: user.creatorKey, config: [{ id: "m1", name: "Popular", type: "movie", url: "tmdb:chart:popular" }] } });
  assert.equal(saved.body.ok, true);
  env.CONFIGS._hooks.beforeGet = () => { throw new Error("KV GET failed: 503 Service Unavailable"); };
  return env;
}

describe("API-01: KV read failure on Stremio-protocol routes", () => {
  for (const [label, path, key] of [
    ["catalog", "/kvdown/catalog/movie/m1.json", "metas"],
    ["search catalog", "/kvdown/catalog/movie/search_movies/search=x.json", "metas"],
    ["meta", "/kvdown/meta/movie/tt0111161.json", "meta"],
  ]) {
    it(`${label}: 200, CORS, empty answer, no internal text`, async () => {
      const env = await setup();
      const r = await call(env, path);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.headers.get("access-control-allow-origin"), "*");
      assert.match(r.headers.get("cache-control") || "", /no-store/);
      assert.ok(key in r.body, r.text);
      assert.doesNotMatch(r.text, /KV GET|503 Service/);
    });
  }

  it("manifest: 503 with CORS and a generic message", async () => {
    const env = await setup();
    const r = await call(env, "/kvdown/manifest.json");
    assert.equal(r.status, 503, r.text);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    assert.match(r.headers.get("cache-control") || "", /no-store/);
    assert.doesNotMatch(r.text, /KV GET|503 Service/);
  });

  it("a private route still answers 500 without CORS", async () => {
    const env = await setup();
    const r = await call(env, "/api/creator/sync/load", { method: "POST", json: { creatorName: "kvdown", creatorKey: "x" } });
    assert.equal(r.headers.get("access-control-allow-origin"), null);
  });
});
