import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { call, makeD1, makeEnv, makeKv } from "./harness.mjs";

// /api/bulk-resolve: one bad title or one failed TMDB call must not lose the
// rest of the batch.

let realFetch;
let fetched;
function stubTmdb(handler) {
  fetched = [];
  globalThis.fetch = async (u) => {
    const url = String(u);
    fetched.push(url);
    return handler(url);
  };
}
const ok = (obj) => new Response(JSON.stringify(obj), { status: 200 });

describe("/api/bulk-resolve keeps the good titles when one item is bad", () => {
  beforeEach(() => { realFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  const env = () => makeEnv({ DB: makeD1(), CONFIGS: makeKv(), TMDB_API_KEY: "k" });
  const movieStub = () => stubTmdb((url) => {
    if (url.includes("Boom")) throw new Error("network down");
    if (url.includes("/search/")) return ok({ results: [{ id: 1, title: "Ok Movie", release_date: "2000-01-01" }] });
    return ok({ imdb_id: "tt0000001" });
  });

  for (const [label, items] of [
    ["a numeric title", [{ title: 5 }, { title: "Ok" }]],
    ["a failing TMDB call", [{ title: "Boom" }, { title: "Ok" }]],
    ["a null item", [null, { title: "Ok" }]],
  ]) {
    it(`answers 200 and still resolves the good title with ${label}`, async () => {
      movieStub();
      const r = await call(env(), "/api/bulk-resolve", { method: "POST", json: { items } });
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      // (A numeric title is searched as the text "5", so it may resolve too.)
      assert.ok(r.body.resolved.some((x) => x.imdbId === "tt0000001"), "the good title must survive");
    });
  }
});
