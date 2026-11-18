// Audit BUG-03: a region such as "a<emoji>" was cut by UTF-16 units, left half
// a character in the cache key, and /api/details answered 500 "URI malformed".
// Only a two-letter code is a region; anything else means the default.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { makeEnv, makeD1, makeKv, call } from "./harness.mjs";

const post = (env, region) => call(env, "/api/details", { method: "POST", json: { imdbId: "tt0000001", type: "movie", tmdbKey: "k".repeat(32), region } });

describe("BUG-03: junk region on /api/details", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = async () => new Response("{}", { status: 404 }); });
  afterEach(() => { globalThis.fetch = realFetch; });
  for (const [label, region] of [["emoji after a letter", "a\u{1F600}"], ["lone surrogate", "\uD83D"], ["digits", "12"]]) {
    it(`${label} is not a 500`, async () => {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
      const r = await post(env, region);
      assert.notEqual(r.status, 500, JSON.stringify(r.body));
    });
  }
});
