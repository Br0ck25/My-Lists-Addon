// Audit BUG-04: /api/tmdb-my-lists answered 500 "apiKey.startsWith is not a
// function" when tmdbKey was not a string. Non-string credentials are ignored.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { makeEnv, makeD1, makeKv, call } from "./harness.mjs";

describe("BUG-04: non-string tmdbKey on /api/tmdb-my-lists", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = async () => new Response("{}", { status: 401 }); });
  afterEach(() => { globalThis.fetch = realFetch; });
  for (const [label, tmdbKey] of [["object", { a: 1 }], ["number", 5], ["true", true]]) {
    it(`${label} is not a 500`, async () => {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
      const r = await call(env, "/api/tmdb-my-lists", { method: "POST", json: { tmdbKey, sessionId: "s", accountId: "1" } });
      assert.notEqual(r.status, 500, JSON.stringify(r.body));
    });
  }
});
