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

// Series lookup: a show with no IMDb id must be searched as a show. Searched as
// a movie, a movie sharing its title and year hands over the wrong IMDb id.
describe("/api/bulk-resolve resolves series through the TV endpoints", () => {
  beforeEach(() => { realFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  const env = () => makeEnv({ DB: makeD1(), CONFIGS: makeKv(), TMDB_API_KEY: "k" });
  // Movie 111 and show 222 share the title "Same" and the year 2000.
  const bothStub = () => stubTmdb((url) => {
    if (url.includes("/search/movie")) return ok({ results: [{ id: 111, title: "Same", release_date: "2000-05-05" }] });
    if (url.includes("/search/tv")) return ok({ results: [{ id: 222, name: "Same", first_air_date: "2000-09-09" }] });
    if (url.includes("/movie/111/external_ids")) return ok({ imdb_id: "tt1111111" });
    if (url.includes("/tv/222/external_ids")) return ok({ imdb_id: "tt2222222" });
    return new Response("{}", { status: 404 });
  });

  it("a series item uses /search/tv with first_air_date_year, then /tv/{id}/external_ids", async () => {
    bothStub();
    const r = await call(env(), "/api/bulk-resolve", { method: "POST", json: { items: [{ title: "Same", year: "2000", type: "series" }] } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.resolved.map((x) => [x.imdbId, x.type, x.title, x.year]), [["tt2222222", "series", "Same", "2000"]]);
    assert.ok(fetched.some((u) => u.includes("/search/tv") && u.includes("first_air_date_year=2000")));
    assert.ok(fetched.some((u) => u.includes("/tv/222/external_ids")));
    assert.ok(!fetched.some((u) => u.includes("/search/movie")), "a show must never be searched as a movie");
    assert.equal(fetched.length, 2, "a series costs the same two TMDB calls as a movie");
  });

  it("a series and a movie with the same title and year each get their own id", async () => {
    bothStub();
    const r = await call(env(), "/api/bulk-resolve", {
      method: "POST",
      json: { items: [{ title: "Same", year: "2000", type: "series" }, { title: "Same", year: "2000", type: "movie" }] },
    });
    const byType = Object.fromEntries(r.body.resolved.map((x) => [x.type, x.imdbId]));
    assert.deepEqual(byType, { series: "tt2222222", movie: "tt1111111" });
  });

  it("a movie item, and an item with no type (older client), still use /search/movie", async () => {
    bothStub();
    const r = await call(env(), "/api/bulk-resolve", {
      method: "POST", json: { items: [{ title: "Same", year: "2000", type: "movie" }, { title: "Same", year: "2000" }] },
    });
    assert.deepEqual(r.body.resolved.map((x) => [x.imdbId, x.type]), [["tt1111111", "movie"], ["tt1111111", "movie"]]);
    assert.ok(!fetched.some((u) => u.includes("/tv")));
  });
});
