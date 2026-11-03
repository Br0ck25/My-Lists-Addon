// The "Your lists" shelves for a signed-in Trakt / Simkl / MDBList / TMDB account
// (audit TEST-02). Each route is asked with a stubbed provider and the cards it
// returns are checked: names, urls, counts and the items inside, not just status 200.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { call, makeEnv } from "./harness.mjs";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
function stub(reply) {
  const sent = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input && input.url ? input.url : input));
    sent.push(url);
    const out = reply(url, init);
    return out ? Response.json(out) : new Response("{}", { status: 404 });
  };
  return sent;
}
const post = (path, json) => call(makeEnv(), path, { method: "POST", json });

describe("MDBList account shelves (/api/mdblist-my-lists)", () => {
  const MY_LISTS = [
    { id: 11, name: "Sci-fi night", slug: "sci-fi-night", user_name: "bob", mediatype: "movie", items: 12, likes: 3, public: true },
    { id: 12, name: "Secret", slug: "secret", user_name: "bob", mediatype: "show", items: 4, public: false },
  ];
  const UPNEXT = [{ id: 2, title: "Breaking Bad", year: 2008, imdb_id: "tt0903747", poster: "/bb.jpg", next_episode: { season: 2, episode: 5, title: "Breakage", air_date: "2026-03-05" } }];
  const WATCHED_SHOWS = { shows: [{ id: 5, title: "Severance", release_year: 2022, imdb_id: "tt11280740", mediatype: "show" }] };
  const WATCHLIST = { movies: [{ id: 1, title: "The Matrix", release_year: 1999, imdb_id: "tt0133093", mediatype: "movie" }], shows: [] };

  const provider = (u) => {
    if (u.pathname === "/lists/user") return MY_LISTS;
    if (u.pathname === "/upnext") return UPNEXT;
    if (u.pathname === "/sync/watched") return u.searchParams.get("mediatype") === "show" ? WATCHED_SHOWS : { episodes: [] };
    if (u.pathname === "/watchlist") return WATCHLIST;
    return null;
  };

  it("returns the four built-in cards first, then the account's own lists with their address and privacy", async () => {
    stub(provider);
    const res = await post("/api/mdblist-my-lists", { apikey: "MK" });
    assert.equal(res.body.ok, true);
    assert.equal(res.body.username, "bob");
    assert.deepEqual(res.body.lists.map((l) => l.slug), ["upnext", "airing-next", "watchlist", "history", "sci-fi-night", "secret"]);
    const mine = res.body.lists.find((l) => l.slug === "sci-fi-night");
    assert.equal(mine.url, "https://mdblist.com/lists/bob/sci-fi-night");
    assert.equal(mine.contentType, "movie");
    assert.equal(mine.private, false);
    assert.equal(res.body.lists.find((l) => l.slug === "secret").private, true, "a non-public list is marked private");
    assert.match(res.headers.get("cache-control"), /no-store/, "a per-person answer is never cached");
  });

  it("the Up Next card lists the next episode per show; the Watch List card counts and samples the watchlist; Airing Next has the shows being watched", async () => {
    stub(provider);
    const { body } = await post("/api/mdblist-my-lists", { apikey: "MK" });
    const up = body.lists.find((l) => l.slug === "upnext");
    assert.equal(up.itemCount, 1);
    assert.equal(up.items[0].id, "tt0903747:2:5");
    assert.equal(up.items[0].title, "Breaking Bad S02E05");
    assert.equal(up.items[0].poster, "https://image.tmdb.org/t/p/w500/bb.jpg");
    const wl = body.lists.find((l) => l.slug === "watchlist");
    assert.equal(wl.items, 1);
    assert.deepEqual(wl.previewItems.map((m) => m.id), ["tt0133093"]);
    const airing = body.lists.find((l) => l.slug === "airing-next");
    assert.deepEqual(airing.items.map((i) => [i.id, i.name]), [["tt11280740", "Severance"]]);
  });

  it("without a key it refuses before asking MDBList; a rejected key says so; credentials in the address are refused", async () => {
    const sent = stub(() => ({}));
    const none = await post("/api/mdblist-my-lists", {});
    assert.equal(none.status, 400);
    assert.equal(sent.length, 0);
    stub((u) => null);
    const bad = await post("/api/mdblist-my-lists", { apikey: "MK" });
    assert.equal(bad.body.ok, false);
    assert.match(bad.body.error, /HTTP 404/);
    const inUrl = await call(makeEnv(), "/api/mdblist-my-lists?apikey=MK", { method: "POST", json: {} });
    assert.equal(inUrl.status, 400);
  });
});

describe("Trakt account shelves (/api/trakt-my-lists)", () => {
  const LISTS = [
    { name: "Best Movies", item_count: 20, likes: 5, ids: { slug: "best-movies" } },
    { name: "Anime shows", item_count: 7, ids: { slug: "anime-shows" } },
    { name: "No slug, dropped", ids: {} },
  ];
  const WATCHED = [
    { last_watched_at: "2026-03-01T00:00:00Z", show: { title: "Severance", year: 2022, ids: { trakt: 1, imdb: "tt11280740", tmdb: 95396 } } },
    { show: { title: "Only TMDB", year: 2020, ids: { tmdb: 555 } } },
  ];
  const WL_SHOWS = [{ show: { title: "Severance", year: 2022, ids: { imdb: "tt11280740" } } }, { show: { title: "Andor", year: 2022, ids: { imdb: "tt9253284" } } }];
  const provider = (u) => {
    if (u.pathname === "/users/bob/lists") return LISTS;
    if (u.pathname === "/users/bob/watched/shows") return WATCHED;
    if (u.pathname === "/users/bob/watchlist/shows") return WL_SHOWS;
    if (u.pathname === "/users/bob/watchlist") return [];
    return null;
  };
  const get = (q) => call(makeEnv({ TRAKT_CLIENT_ID: "cid" }), `/api/trakt-my-lists?${q}`);

  it("returns Airing Next, Watch List and Watch History cards, then the user's public lists with a guessed content type", async () => {
    const sent = stub(provider);
    const { body } = await get("username=bob");
    assert.equal(body.ok, true);
    assert.deepEqual(body.lists.map((l) => l.slug), ["airing-next", "watchlist", "history", "best-movies", "anime-shows"], "a list without a slug is dropped");
    const movies = body.lists.find((l) => l.slug === "best-movies");
    assert.deepEqual([movies.contentType, movies.items, movies.likes, movies.url], ["movie", 20, 5, "https://trakt.tv/users/bob/lists/best-movies"]);
    assert.equal(body.lists.find((l) => l.slug === "anime-shows").contentType, "series");
    assert.equal(body.lists.find((l) => l.slug === "watchlist").url, "https://trakt.tv/users/bob/watchlist");
    assert.ok(sent.length >= 4);
  });

  it("Airing Next lists each show once (a show on both the watched list and the watchlist is not doubled), keyed by imdb id or tmdb: id", async () => {
    stub(provider);
    const { body } = await get("username=bob");
    const airing = body.lists.find((l) => l.slug === "airing-next");
    assert.deepEqual(airing.items.map((i) => i.id), ["tt11280740", "tmdb:555", "tt9253284"]);
    assert.equal(airing.itemCount, 3);
    assert.equal(airing.items[0].poster, "https://images.metahub.space/poster/medium/tt11280740/img");
  });

  it("explains a missing user, a refused key and a missing username; and never caches the answer", async () => {
    stub((u) => null);
    const gone = await get("username=nobody");
    assert.equal(gone.body.ok, false);
    assert.match(gone.body.error, /No Trakt user found with the username "nobody"/);
    const none = await get("");
    assert.equal(none.status, 400);
    stub(provider);
    const ok = await get("username=bob");
    assert.match(ok.headers.get("cache-control"), /no-store/);
  });
});

describe("Simkl account shelves (/api/simkl/my-lists)", () => {
  const ALL = {
    movies: [{ status: "plantowatch", movie: { title: "The Matrix", year: 1999, ids: { imdb: "tt0133093", tmdb: 603, poster: "ab/cd" } } }],
    shows: [
      { status: "watching", last_watched_at: "2026-02-01T00:00:00Z", watched_episodes_count: 3, total_episodes_count: 10, show: { title: "Severance", year: 2022, ids: { imdb: "tt11280740" } } },
      { status: "completed", last_watched_at: "2026-03-01T00:00:00Z", show: { title: "Breaking Bad", year: 2008, ids: { simkl: 99 } } },
      { status: "dropped", show: { title: "Dropped Show", ids: { imdb: "tt0000001" } } },
    ],
    anime: [],
  };
  const provider = (u) => (u.pathname === "/sync/all-items/" ? ALL : (u.pathname === "/users/settings" ? { user: { username: "sam" } } : null));
  const get = (json, extra = {}) => call(makeEnv({ SIMKL_CLIENT_ID: "sk" }), "/api/simkl/my-lists", { method: "POST", json, ...extra });

  it("groups the library into one card per category and status, with the right ids and poster addresses", async () => {
    const sent = stub(provider);
    const { body } = await get({ token: "ST" });
    assert.equal(body.ok, true);
    assert.equal(body.username, "sam");
    const urls = body.lists.map((l) => l.url);
    assert.deepEqual(urls, ["simkl:user:shows:airing-next", "simkl:user:movies:plantowatch", "simkl:user:shows:watching", "simkl:user:shows:completed", "simkl:user:shows:dropped"]);
    const movies = body.lists.find((l) => l.url === "simkl:user:movies:plantowatch");
    assert.equal(movies.items[0].id, "tt0133093");
    assert.equal(movies.items[0].poster, "https://simkl.in/posters/ab/cd_m.jpg");
    assert.equal(body.lists.find((l) => l.url === "simkl:user:shows:completed").items[0].id, "simkl:99", "a show with only a Simkl id still gets an id");
    assert.equal(sent[0].searchParams.get("extended"), "full");
  });

  it("Airing Next holds only shows being watched or finished, 'watching' first, each once", async () => {
    stub(provider);
    const { body } = await get({ token: "ST" });
    const airing = body.lists[0];
    assert.deepEqual(airing.items.map((i) => [i.id, i.status]), [["tt11280740", "watching"], ["simkl:99", "completed"]]);
    assert.equal(airing.items[0].watchedCount, 3);
  });

  it("without a token it asks the person to connect; a Simkl refusal passes its status through; credentials in the address are refused", async () => {
    const sent = stub(provider);
    const none = await get({});
    assert.equal(none.status, 400);
    assert.equal(sent.length, 0);
    stub(() => null);
    const bad = await get({ token: "ST" });
    assert.equal(bad.status, 404);
    assert.equal(bad.body.ok, false);
    const inUrl = await call(makeEnv(), "/api/simkl/my-lists?token=ST", { method: "POST", json: {} });
    assert.equal(inUrl.status, 400);
  });
});

describe("TMDB account shelves (/api/tmdb-my-lists)", () => {
  const page = (results, total) => ({ results, total_results: total });
  const MOV = [{ id: 603, title: "The Matrix", release_date: "1999-03-30", poster_path: "/m.jpg" }];
  const TV = [{ id: 1396, name: "Breaking Bad", first_air_date: "2008-01-20", poster_path: "/b.jpg" }];
  const provider = (u) => {
    const p = u.pathname;
    if (p === "/3/account") return { id: 77, username: "tmdbuser" };
    if (p === "/3/account/77/lists") return { results: [{ id: 8, name: "Disney", item_count: 2, public: false, favorite_count: 1 }] };
    if (p === "/3/list/8") return { item_count: 2, items: [{ id: 1, title: "Aladdin", release_date: "1992-11-25", poster_path: "/a.jpg", media_type: "movie" }] };
    if (p === "/3/account/77/watchlist/movies") return page(MOV, 14);
    if (p === "/3/account/77/watchlist/tv") return page([], 0);
    if (p === "/3/account/77/favorite/movies") return page([], 0);
    if (p === "/3/account/77/favorite/tv") return page(TV, 3);
    return null;
  };
  const get = (json) => call(makeEnv(), "/api/tmdb-my-lists", { method: "POST", json });

  it("lists the account's own lists with a preview, then the non-empty watchlist and favorites shelves", async () => {
    stub(provider);
    const { body } = await get({ sessionId: "SESS", tmdbKey: "K" });
    assert.equal(body.ok, true);
    assert.equal(body.username, "tmdbuser");
    assert.equal(body.accountId, "77");
    assert.deepEqual(body.lists.map((l) => l.id), ["8", "watchlist_movies", "favorites_tv"], "empty shelves are left out");
    const mine = body.lists[0];
    assert.deepEqual([mine.name, mine.url, mine.private, mine.items], ["Disney", "https://www.themoviedb.org/list/8", true, 2]);
    assert.deepEqual(mine.previewItems, [{ id: 1, title: "Aladdin", year: "1992", poster: "https://image.tmdb.org/t/p/w300/a.jpg", type: "movie" }]);
    const wl = body.lists[1];
    assert.deepEqual([wl.url, wl.items, wl.contentType, wl.previewItems[0].title], ["tmdb:account:watchlist:movies", 14, "movie", "The Matrix"]);
    const fav = body.lists[2];
    assert.deepEqual([fav.url, fav.items, fav.contentType, fav.previewItems[0].type], ["tmdb:account:favorites:tv", 3, "series", "series"]);
  });

  it("with no key or no account it says what is missing, and asks TMDB nothing", async () => {
    const sent = stub(provider);
    const noKey = await call(makeEnv(), "/api/tmdb-my-lists", { method: "POST", json: { sessionId: "S" } });
    const noAcct = await get({ tmdbKey: "K" });
    assert.equal(noKey.status, 400);
    assert.match(noKey.body.error, /key is missing/);
    assert.equal(noAcct.status, 400);
    assert.match(noAcct.body.error, /connect your TMDB account/);
    assert.equal(sent.length, 0);
  });
});
