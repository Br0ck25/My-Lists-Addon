// A title TMDB has no entry for yet still opens (titleDetailsWithoutTmdb,
// 57_title-details-fallback.js). New on Streaming lists titles by IMDb id the
// day a service adds them, and some are too new for TMDB: The Devil's Mark
// (tt39833082) and Full Figured Flings (tt35457754) on the site, 2026-10-01.
// Opening one said "Not found or TMDB error".
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { call, makeD1, makeEnv } from "./harness.mjs";

const JUSTWATCH = "https://images.justwatch.com/poster/342779810/s592/the-devils-mark-2026.jpg";

// TMDB knows one film and none of the new ones; Cinemeta knows what `cinemeta`
// holds.
let restoreFetch = null;
function fakeSources(cinemeta = {}) {
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    asked.push(url.hostname + url.pathname);
    if (url.hostname === "api.themoviedb.org") {
      if (url.pathname === "/3/find/tt2543164") return Response.json({ movie_results: [{ id: 329865 }], tv_results: [] });
      if (url.pathname === "/3/movie/329865") {
        return Response.json({ id: 329865, title: "Arrival", overview: "Linguist.", release_date: "2016-11-10", poster_path: "/arrival.jpg", genres: [{ name: "Drama" }], external_ids: { imdb_id: "tt2543164" } });
      }
      if (url.pathname.startsWith("/3/find/")) return Response.json({ movie_results: [], tv_results: [], tv_episode_results: [] });
      return new Response("{}", { status: 404 });
    }
    if (url.hostname === "v3-cinemeta.strem.io") {
      const m = url.pathname.match(/^\/meta\/(movie|series)\/(tt\d+)\.json$/);
      const meta = m && cinemeta[m[2]];
      if (meta && (!meta.type || meta.type === m[1])) return Response.json({ meta });
      return new Response("Not Found", { status: 404 });
    }
    return new Response("{}", { status: 404 });
  };
  restoreFetch = () => { globalThis.fetch = realFetch; };
  return asked;
}
afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

function seedNewOnStreaming(db, imdbId, name, poster, year) {
  const now = Math.floor(Date.now() / 1000);
  db._db.prepare(
    `INSERT INTO streaming_events (region, service, imdb_id, kind, added_at, last_event_at, event_kind, name, poster, background, year)
     VALUES ('US', 'hulu', ?, 'movie', ?, ?, 'added', ?, ?, NULL, ?)`
  ).run(imdbId, now, now, name, poster, year);
}

const details = (env, id) => call(env, `/api/details?imdbId=${id}&type=movie&region=US`);

describe("a title TMDB does not have yet", () => {
  it("opens from what New on Streaming stored about it", async () => {
    fakeSources();
    const db = makeD1();
    seedNewOnStreaming(db, "tt39833082", "The Devil's Mark", JUSTWATCH, "2026");
    const env = makeEnv({ DB: db, TMDB_API_KEY: "test-tmdb-key" });

    const r = await details(env, "tt39833082");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    const d = r.body.details;
    assert.equal(d.id, "tt39833082");
    assert.equal(d.title, "The Devil's Mark");
    assert.equal(d.poster, JUSTWATCH, "the poster the list shows");
    assert.equal(d.releaseYear, "2026");
    assert.equal(d.tmdbId, null);
    assert.equal(d.rating, null, "no TMDB rating to show");
    assert.equal(d.seasonsData, null);
  });

  it("adds Cinemeta's description, genres and trailer when it has them", async () => {
    fakeSources({
      tt35457754: {
        type: "movie", name: "Full Figured Flings", description: "A comedy.",
        genres: ["Comedy", "Romance"], runtime: "1h 32min", released: "2026-03-01T00:00:00.000Z",
        trailers: [{ source: "abc123XYZ", type: "Trailer" }], cast: ["A", "B"],
      },
    });
    const db = makeD1();
    seedNewOnStreaming(db, "tt35457754", "Full Figured Flings", "https://images.justwatch.com/poster/348012939/s592/full-figured-flings.jpg", "2026");
    const env = makeEnv({ DB: db, TMDB_API_KEY: "test-tmdb-key" });

    const d = (await details(env, "tt35457754")).body.details;
    assert.equal(d.overview, "A comedy.");
    assert.equal(d.genres, "Comedy, Romance");
    assert.equal(d.runtime, 92);
    assert.equal(d.releaseDate, "2026-03-01");
    assert.equal(d.trailerKey, "abc123XYZ");
    assert.deepEqual(d.cast, ["A", "B"]);
    assert.equal(d.poster, "https://images.justwatch.com/poster/348012939/s592/full-figured-flings.jpg");
  });

  it("opens from Cinemeta alone for a title no list stored", async () => {
    fakeSources({ tt9999901: { type: "movie", name: "Only On Cinemeta", poster: "https://example.test/c.jpg", year: 2026 } });
    const env = makeEnv({ DB: makeD1(), TMDB_API_KEY: "test-tmdb-key" });

    const d = (await details(env, "tt9999901")).body.details;
    assert.equal(d.title, "Only On Cinemeta");
    assert.equal(d.poster, "https://example.test/c.jpg");
    assert.equal(d.releaseYear, "2026");
  });

  it("is still not found when nothing knows the title", async () => {
    fakeSources();
    const env = makeEnv({ DB: makeD1(), TMDB_API_KEY: "test-tmdb-key" });

    const r = await details(env, "tt9999902");
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "Not found or TMDB error");
  });

  it("leaves a title TMDB knows to TMDB", async () => {
    const asked = fakeSources();
    const db = makeD1();
    seedNewOnStreaming(db, "tt2543164", "Arrival", "https://images.justwatch.com/poster/302218887/s592/arrival-2016.jpg", "2016");
    const env = makeEnv({ DB: db, TMDB_API_KEY: "test-tmdb-key" });

    const d = (await details(env, "tt2543164")).body.details;
    assert.equal(d.title, "Arrival");
    assert.equal(d.tmdbId, 329865);
    assert.equal(d.notOnTmdb, undefined);
    assert.ok(!asked.some((h) => h.startsWith("v3-cinemeta.strem.io/meta/")), "Cinemeta is not asked for a title TMDB answered");
  });
});
