// The per-user Trakt history and MDBList watchlist / history rows (audit TEST-10).
//
// These are the rows a signed-in user sees in Stremio and Nuvio ("Trakt
// History", "MDBList Watchlist"). Every other test replaced the fetchers with a
// recorder, so a fetcher that returned nothing kept the whole suite green. Here
// the real fetchers run against stubbed Trakt / MDBList answers (shapes and ids
// only, no personal data) and the rows they return are checked.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { makeEnv, makeD1 } from "./harness.mjs";

// Not exported from the Worker: load the bundle once more with them added to
// the end (the same trick continue-watching-parity.test.mjs uses).
const bundle = readFileSync(new URL("../worker_entry_combined.js", import.meta.url), "utf8");
const tmpFile = `${tmpdir()}/mla-personal-${process.pid}-${Date.now()}.mjs`;
writeFileSync(tmpFile, bundle + "\nexport const __p = { fetchTraktHistory, mapTraktHistoryItems, fetchMdblistWatchlist, fetchMdblistHistory, fetchMdblistUpNext, fetchMdblistAiringNext,\n  setTmdbDetails: (fn) => { fetchTmdbItemDetails = fn; } };\n");
const { __p } = await import(pathToFileURL(tmpFile).href).finally(() => unlinkSync(tmpFile));

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
let seq = 0;

function stub(reply) {
  const sent = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    sent.push({ url, headers: init.headers || {} });
    const out = reply(url) || [404, {}];
    return new Response(JSON.stringify(out[1]), { status: out[0], headers: out[2] || { "content-type": "application/json" } });
  };
  return sent;
}

const MOVIE_ROW = { watched_at: "2026-03-04T10:00:00.000Z", action: "watch", type: "movie", movie: { title: "The Matrix", year: 1999, ids: { trakt: 1, imdb: "tt0133093", tmdb: 603 } } };
const MOVIE_NO_IMDB = { watched_at: "2026-03-03T10:00:00.000Z", action: "watch", type: "movie", movie: { title: "Only TMDB", year: 2001, ids: { trakt: 2, tmdb: 777 } } };
const MOVIE_NO_IDS = { watched_at: "2026-03-02T10:00:00.000Z", type: "movie", movie: { title: "Nothing to key on", ids: {} } };
const EP_ROW = { watched_at: "2026-03-05T20:00:00.000Z", action: "watch", type: "episode", episode: { season: 2, number: 5, title: "Breakage", ids: { trakt: 9 } }, show: { title: "Breaking Bad", year: 2008, ids: { trakt: 3, imdb: "tt0903747", tmdb: 1396 } } };

describe("Trakt History row", () => {
  it("maps a movie history to metas: imdb id, title, poster and watched date; rows with no id are dropped", () => {
    const metas = JSON.parse(JSON.stringify(__p.mapTraktHistoryItems([MOVIE_ROW, MOVIE_NO_IMDB, MOVIE_NO_IDS, null], "movie")));
    assert.deepEqual(metas, [
      { id: "tt0133093", type: "movie", name: "The Matrix", poster: "https://images.metahub.space/poster/medium/tt0133093/img", releaseInfo: "2026-03-04" },
      { id: "tmdb:777", type: "movie", name: "Only TMDB", releaseInfo: "2026-03-03" },
    ]);
  });

  it("maps an episode history to a series meta named with season and episode; a mixed history keeps both kinds in order", () => {
    const series = JSON.parse(JSON.stringify(__p.mapTraktHistoryItems([EP_ROW], "series")));
    assert.equal(series[0].id, "tt0903747");
    assert.equal(series[0].type, "series");
    assert.equal(series[0].name, "Breaking Bad S2E5 — Breakage");
    const mixed = __p.mapTraktHistoryItems([EP_ROW, MOVIE_ROW], "mixed");
    assert.deepEqual(mixed.map((m) => [m.id, m.type]), [["tt0903747", "series"], ["tt0133093", "movie"]]);
  });

  it("fetches the signed-in user's history from Trakt with their token, pages by skip, and returns the metas", async () => {
    const sent = stub((url) => (url.pathname === "/users/me/history/movies" ? [200, [MOVIE_ROW, MOVIE_NO_IMDB]] : null));
    const env = makeEnv({ DB: makeD1() });
    const metas = await __p.fetchTraktHistory({ type: "movie" }, 0, "client-id", `tok-${++seq}`, env, { waitUntil() {} });
    assert.deepEqual(metas.map((m) => m.id), ["tt0133093", "tmdb:777"]);
    assert.equal(sent[0].url.searchParams.get("page"), "1");
    assert.match(String(sent[0].headers.Authorization), /^Bearer tok-/);
    assert.equal(sent[0].headers["trakt-api-key"], "client-id");

    const sent2 = stub(() => [200, []]);
    await __p.fetchTraktHistory({ type: "movie" }, 100, "client-id", `tok-${++seq}`, env, { waitUntil() {} });
    assert.equal(sent2[0].url.searchParams.get("page"), "2", "skip 100 is the second page of 100");
  });

  it("without a Trakt sign-in the row says to connect Trakt, and asks Trakt for nothing", async () => {
    const sent = stub(() => [200, []]);
    await assert.rejects(() => __p.fetchTraktHistory({ type: "movie" }, 0, "client-id", "", makeEnv({ DB: makeD1() }), { waitUntil() {} }), /Connect Trakt in Settings first/);
    assert.equal(sent.length, 0);
  });

  it("a Trakt refusal becomes a readable error naming the status", async () => {
    stub(() => [401, {}]);
    await assert.rejects(() => __p.fetchTraktHistory({ type: "movie" }, 0, "client-id", `tok-${++seq}`, makeEnv({ DB: makeD1() }), { waitUntil() {} }), /HTTP 401.*reconnecting/);
  });
});

describe("MDBList rows", () => {
  const WATCHLIST = {
    movies: [{ id: 1, title: "The Matrix", release_year: 1999, imdb_id: "tt0133093", mediatype: "movie" }],
    shows: [{ id: 2, title: "Breaking Bad", release_year: 2008, imdb_id: "tt0903747", mediatype: "show" }],
  };

  it("watchlist: asks with the user's key and returns the saved movies and shows as metas", async () => {
    const sent = stub((url) => (url.pathname === "/watchlist" ? [200, WATCHLIST] : null));
    const movies = await __p.fetchMdblistWatchlist({ type: "movie" }, 0, "MK", "");
    assert.deepEqual(Array.from(movies, (m) => [m.id, m.type, m.name]), [["tt0133093", "movie", "The Matrix"]]);
    const shows = await __p.fetchMdblistWatchlist({ type: "series" }, 0, "MK", "");
    assert.deepEqual(Array.from(shows, (m) => [m.id, m.type]), [["tt0903747", "series"]]);
    assert.equal(sent[0].url.searchParams.get("apikey"), "MK");
  });

  it("watchlist: with a connected account it sends the bearer token, and tries the next address when the first has nothing", async () => {
    const sent = stub((url) => (url.pathname === "/watchlist/items" ? [200, WATCHLIST] : (url.pathname === "/watchlist" ? [404, {}] : null)));
    const metas = await __p.fetchMdblistWatchlist({ type: "movie" }, 0, "", "OAUTH");
    assert.equal(metas.length, 1);
    assert.deepEqual(sent.map((s) => s.url.pathname), ["/watchlist", "/watchlist/items"]);
    assert.equal(sent[0].headers.Authorization, "Bearer OAUTH");
  });

  it("watchlist: with neither key nor account it says what to connect", async () => {
    const sent = stub(() => [200, WATCHLIST]);
    await assert.rejects(() => __p.fetchMdblistWatchlist({ type: "movie" }, 0, "", ""), /needs your connected MDBList account or API key/);
    assert.equal(sent.length, 0);
  });

  it("history: returns the watched movies as metas and pages with offset", async () => {
    const sent = stub((url) => (url.pathname === "/sync/watched" ? [200, { movies: WATCHLIST.movies }] : null));
    const metas = await __p.fetchMdblistHistory({ type: "movie" }, 100, "MK", "");
    assert.deepEqual(Array.from(metas, (m) => m.id), ["tt0133093"]);
    assert.equal(sent[0].url.searchParams.get("mediatype"), "movie");
    assert.equal(sent[0].url.searchParams.get("offset"), "100");
  });

  it("history: a series row asks for shows and episodes; with no key or account it says what to connect", async () => {
    const sent = stub((url) => (url.pathname === "/sync/watched" ? [200, { shows: WATCHLIST.shows }] : null));
    const metas = await __p.fetchMdblistHistory({ type: "series" }, 0, "MK", "");
    assert.deepEqual(Array.from(metas, (m) => m.id), ["tt0903747"]);
    assert.equal(sent[0].url.searchParams.get("mediatype"), "show");
    await assert.rejects(() => __p.fetchMdblistHistory({ type: "movie" }, 0, "", ""), /needs your connected MDBList account or API key/);
  });
});

describe("MDBList Up Next and Airing Next rows", () => {
  const UPNEXT = [
    { id: 2, title: "Breaking Bad", year: 2008, imdb_id: "tt0903747", poster: "/bb.jpg", next_episode: { season: 2, episode: 5, title: "Breakage", air_date: "2026-03-05" } },
    { id: 3, title: "Only TMDB Show", year: 2020, tmdb_id: 555, next_episode: { season: 1, episode: 1 } },
  ];

  it("up next: asks MDBList with the user's key and returns one series meta per show, named with the next episode", async () => {
    const sent = stub((url) => (url.pathname === "/upnext" ? [200, UPNEXT] : null));
    const metas = await __p.fetchMdblistUpNext({ type: "series" }, 0, `MK${++seq}`, "", "", makeEnv({ DB: makeD1() }), { waitUntil() {} });
    assert.equal(sent[0].url.searchParams.get("apikey"), `MK${seq}`);
    assert.deepEqual(Array.from(metas, (m) => [m.id, m.type, m.name]), [
      ["tt0903747", "series", "Breaking Bad S2E5 \u2014 Breakage"],
      ["tmdb:555", "series", "Only TMDB Show S1E1"],
    ]);
    assert.equal(metas[0].poster, "https://image.tmdb.org/t/p/w500/bb.jpg", "a relative poster path becomes a full TMDB image address");
    assert.equal(metas[0].description, "Next Episode: S2E5 \u2014 Breakage \u00b7 Airs 2026-03-05");
  });

  it("up next: with neither key nor account it says what to connect and asks MDBList for nothing; a refusal names the status", async () => {
    const sent = stub(() => [200, UPNEXT]);
    await assert.rejects(() => __p.fetchMdblistUpNext({ type: "series" }, 0, "", ""), /needs your connected MDBList account or API key/);
    assert.equal(sent.length, 0);
    stub(() => [401, {}]);
    await assert.rejects(() => __p.fetchMdblistUpNext({ type: "series" }, 0, `MK${++seq}`, "", "", makeEnv({ DB: makeD1() }), { waitUntil() {} }), /HTTP 401.*API key/);
  });

  it("airing next: keeps only shows with a scheduled next episode, soonest first, with the episode in the description", async () => {
    const watched = { shows: [
      { id: 1, title: "Later Show", release_year: 2020, imdb_id: "tt1111111", mediatype: "show" },
      { id: 2, title: "Sooner Show", release_year: 2021, imdb_id: "tt2222222", mediatype: "show" },
      { id: 3, title: "Ended Show", release_year: 2010, imdb_id: "tt3333333", mediatype: "show" },
    ] };
    stub((url) => (url.pathname === "/sync/watched" ? [200, url.searchParams.get("mediatype") === "show" ? watched : {}] : (url.pathname === "/watchlist" ? [200, {}] : null)));
    const details = {
      tt1111111: { nextEpisodeAirDate: "2099-06-01", nextEpisodeSeasonNumber: 3, nextEpisodeNumber: 4 },
      tt2222222: { nextEpisodeAirDate: "2099-01-01", nextEpisodeSeasonNumber: 1, nextEpisodeNumber: 1 },
      tt3333333: { title: "Ended Show" },
    };
    __p.setTmdbDetails(async (id) => details[id] || null);
    const metas = await __p.fetchMdblistAiringNext({ type: "series" }, 0, `MK${++seq}`, "", "tmdb-key", makeEnv({ DB: makeD1() }), { waitUntil() {} });
    assert.deepEqual(Array.from(metas, (m) => [m.id, m.name, m.airDate]), [
      ["tt2222222", "Sooner Show", "2099-01-01"],
      ["tt1111111", "Later Show", "2099-06-01"],
    ]);
    assert.equal(metas[0].isSeasonPremiere, true);
    assert.equal(metas[1].isSeasonPremiere, false);
    assert.equal(metas[1].description, "Next Episode: S03E04 \u00b7 Airs 2099-06-01");
  });

  it("airing next: with neither key nor account it says what to connect", async () => {
    const sent = stub(() => [200, {}]);
    await assert.rejects(() => __p.fetchMdblistAiringNext({ type: "series" }, 0, "", ""), /needs your connected MDBList account or API key/);
    assert.equal(sent.length, 0);
  });
});
