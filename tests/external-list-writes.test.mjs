// Changing a user's lists on Trakt, TMDB, Simkl and MDBList (audit TEST-01).
//
// Until now nothing ran the write direction: add/remove an item, create or
// delete a list, copy watch history. A break there leaves every check green
// and the first person to notice is a user whose provider list did not change.
// Each test below stubs the outside world with a recorder and asserts the exact
// request the provider would receive (URL, method, auth, body), and that a
// provider error comes back to the browser as ok:false.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { call, makeEnv } from "./harness.mjs";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Records every outside request. `reply(url, init)` returns [status, body].
function stubFetch(reply = () => [200, { ok: true }]) {
  const sent = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input && input.url ? input.url : input);
    const req = { url, method: (init.method || "GET").toUpperCase(), headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null };
    sent.push(req);
    const [status, body] = reply(url, req);
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return sent;
}

const post = (path, json) => call(makeEnv(), path, { method: "POST", json });
const MATRIX = { imdbId: "tt0133093", tmdbId: "603", title: "The Matrix", year: "1999", mediaType: "movie" };
const BB_EP = { imdbId: "tt0903747", tmdbId: "1396", title: "Breaking Bad", mediaType: "series", season: 2, episode: 5 };

describe("add and remove an item on a provider list", () => {
  it("Trakt watchlist: add and remove hit different URLs with the same ids", async () => {
    const sent = stubFetch();
    const add = await post("/api/external-list/item-mutate", { provider: "trakt", traktAccessToken: "TT", traktKey: "CID", ...MATRIX });
    const rem = await post("/api/external-list/item-mutate", { provider: "trakt", traktAccessToken: "TT", traktKey: "CID", action: "remove", ...MATRIX });
    assert.equal(add.body.ok, true);
    assert.equal(rem.body.ok, true);
    assert.deepEqual(sent.map((r) => [r.method, r.url]), [
      ["POST", "https://api.trakt.tv/sync/watchlist"],
      ["POST", "https://api.trakt.tv/sync/watchlist/remove"],
    ]);
    assert.deepEqual(sent[0].body, { movies: [{ ids: { imdb: "tt0133093", tmdb: 603 }, title: "The Matrix", year: 1999 }] });
    assert.match(String(sent[0].headers.Authorization || sent[0].headers.authorization), /Bearer TT/);
    assert.equal(sent[0].headers["trakt-api-key"], "CID");
  });

  it("Trakt: item-remove path means remove; history of an episode names season and episode; custom list uses the username", async () => {
    const sent = stubFetch();
    await post("/api/external-list/item-remove", { provider: "trakt", traktAccessToken: "TT", target: "history", ...BB_EP });
    await post("/api/external-list/item-mutate", { provider: "trakt", traktAccessToken: "TT", target: "history", ...BB_EP });
    await post("/api/external-list/item-mutate", { provider: "trakt", traktAccessToken: "TT", target: "custom", listId: "my list", traktUsername: "bob", ...MATRIX });
    await post("/api/external-list/item-mutate", { provider: "trakt", traktAccessToken: "TT", target: "collection", ...MATRIX });
    assert.deepEqual(sent.map((r) => r.url), [
      "https://api.trakt.tv/sync/history/remove",
      "https://api.trakt.tv/sync/history",
      "https://api.trakt.tv/users/bob/lists/my%20list/items",
      "https://api.trakt.tv/sync/collection",
    ]);
    assert.deepEqual(sent[1].body, { shows: [{ ids: { imdb: "tt0903747", tmdb: 1396 }, title: "Breaking Bad", seasons: [{ number: 2, episodes: [{ number: 5 }] }] }] });
  });

  it("Trakt: no token is refused before any request; a provider error becomes ok:false with its status", async () => {
    const sent = stubFetch(() => [420, { error: "account limit exceeded" }]);
    const none = await post("/api/external-list/item-mutate", { provider: "trakt", ...MATRIX });
    assert.equal(none.status, 400);
    assert.equal(sent.length, 0);
    const bad = await post("/api/external-list/item-mutate", { provider: "trakt", traktAccessToken: "TT", ...MATRIX });
    assert.equal(bad.status, 420);
    assert.equal(bad.body.ok, false);
    assert.equal(bad.body.error, "account limit exceeded");
  });

  it("Simkl: add sends the status, remove uses remove-from-list, history of an episode names it", async () => {
    const sent = stubFetch();
    await post("/api/external-list/item-mutate", { provider: "simkl", simklAccessToken: "ST", simklKey: "SK", target: "plantowatch", ...MATRIX });
    await post("/api/external-list/item-mutate", { provider: "simkl", simklAccessToken: "ST", simklKey: "SK", action: "remove", ...MATRIX });
    await post("/api/external-list/item-mutate", { provider: "simkl", simklAccessToken: "ST", simklKey: "SK", target: "history", ...BB_EP });
    assert.deepEqual(sent.map((r) => r.url), [
      "https://api.simkl.com/sync/add-to-list",
      "https://api.simkl.com/sync/remove-from-list",
      "https://api.simkl.com/sync/history",
    ]);
    assert.deepEqual(sent[0].body, { movies: [{ ids: { imdb: "tt0133093", tmdb: 603 }, to: "plantowatch" }] });
    assert.deepEqual(sent[1].body, { movies: [{ ids: { imdb: "tt0133093", tmdb: 603 }, title: "The Matrix" }] });
    assert.deepEqual(sent[2].body.shows[0].seasons, [{ number: 2, episodes: [{ number: 5 }] }]);
    assert.equal(sent[0].headers["simkl-api-key"], "SK");
    assert.match(String(sent[0].headers.Authorization), /Bearer ST/);
  });

  it("Simkl: a provider error is reported, a missing token is refused", async () => {
    const sent = stubFetch(() => [401, { error: "bad token" }]);
    assert.equal((await post("/api/external-list/item-mutate", { provider: "simkl", ...MATRIX })).status, 400);
    assert.equal(sent.length, 0);
    const r = await post("/api/external-list/item-mutate", { provider: "simkl", simklAccessToken: "ST", ...MATRIX });
    assert.deepEqual([r.status, r.body.ok, r.body.error], [401, false, "bad token"]);
  });

  it("TMDB: watchlist and favorite flip the flag on add and remove, custom list picks add_item or remove_item", async () => {
    const sent = stubFetch();
    const base = { provider: "tmdb", tmdbKey: "K", tmdbSessionId: "SESS", tmdbAccountId: "77", ...MATRIX };
    const env = makeEnv({ TMDB_API_KEY: "K" });
    for (const j of [
      { ...base, target: "watchlist" },
      { ...base, target: "watchlist", action: "remove" },
      { ...base, target: "favorite" },
      { ...base, target: "custom", listId: "L9" },
      { ...base, target: "custom", listId: "L9", action: "remove" },
    ]) await call(env, "/api/external-list/item-mutate", { method: "POST", json: j });
    assert.deepEqual(sent.map((r) => r.url), [
      "https://api.themoviedb.org/3/account/77/watchlist?api_key=K&session_id=SESS",
      "https://api.themoviedb.org/3/account/77/watchlist?api_key=K&session_id=SESS",
      "https://api.themoviedb.org/3/account/77/favorite?api_key=K&session_id=SESS",
      "https://api.themoviedb.org/3/list/L9/add_item?api_key=K&session_id=SESS",
      "https://api.themoviedb.org/3/list/L9/remove_item?api_key=K&session_id=SESS",
    ]);
    assert.deepEqual(sent[0].body, { media_type: "movie", media_id: 603, watchlist: true });
    assert.deepEqual(sent[1].body, { media_type: "movie", media_id: 603, watchlist: false });
    assert.deepEqual(sent[2].body, { media_type: "movie", media_id: 603, favorite: true });
    assert.deepEqual(sent[3].body, { media_id: 603 });
  });

  it("TMDB: a series is sent as tv; success:false from TMDB is an error; no session is refused", async () => {
    const sent = stubFetch(() => [200, { success: false, status_message: "Invalid session" }]);
    const env = makeEnv({ TMDB_API_KEY: "K" });
    const noSession = await call(env, "/api/external-list/item-mutate", { method: "POST", json: { provider: "tmdb", ...MATRIX } });
    assert.equal(noSession.status, 400);
    assert.equal(sent.length, 0);
    const r = await call(env, "/api/external-list/item-mutate", { method: "POST", json: { provider: "tmdb", tmdbSessionId: "S", target: "watchlist", ...BB_EP } });
    assert.equal(sent[0].body.media_type, "tv");
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error, "Invalid session");
  });

  it("MDBList watchlist: add and remove use their own endpoint; the second endpoint is tried when the first is missing", async () => {
    const sent = stubFetch((url) => (url.includes("/watchlist/items/") ? [404, { error: "nope" }] : [200, { added: 1 }]));
    const add = await post("/api/external-list/item-mutate", { provider: "mdblist", mdblistKey: "MK", target: "watchlist", ...MATRIX });
    assert.equal(add.body.ok, true);
    assert.deepEqual(sent.map((r) => r.url), [
      "https://api.mdblist.com/watchlist/items/add?apikey=MK",
      "https://api.mdblist.com/watchlist/add?apikey=MK",
    ]);
    assert.deepEqual(sent[1].body.movies, [{ imdb: "tt0133093", tmdb: 603, id: "tt0133093" }]);
    assert.deepEqual(sent[1].body.shows, []);
    const sent2 = stubFetch();
    await post("/api/external-list/item-mutate", { provider: "mdblist", mdblistAccessToken: "OA", action: "remove", target: "watchlist", ...BB_EP });
    assert.equal(sent2[0].url, "https://api.mdblist.com/watchlist/items/remove");
    assert.match(String(sent2[0].headers.Authorization), /Bearer OA/);
    assert.equal(sent2[0].body.shows.length, 1);
  });

  it("MDBList history: removing sends watched_at null on the item and the episode; custom list uses its id", async () => {
    const sent = stubFetch();
    await post("/api/external-list/item-mutate", { provider: "mdblist", mdblistKey: "MK", target: "history", action: "remove", ...BB_EP });
    assert.equal(sent[0].url, "https://api.mdblist.com/sync/watched/remove?apikey=MK");
    const show = sent[0].body.shows[0];
    assert.equal(show.watched_at, null);
    assert.deepEqual(show.seasons, [{ number: 2, episodes: [{ number: 5, watched_at: null }] }]);
    const sent2 = stubFetch();
    await post("/api/external-list/item-mutate", { provider: "mdblist", mdblistKey: "MK", target: "custom", listId: "123", ...MATRIX });
    assert.equal(sent2[0].url, "https://api.mdblist.com/lists/123/items/add?apikey=MK");
  });

  it("MDBList: every endpoint failing is reported as ok:false with the provider's message", async () => {
    stubFetch(() => [500, { error: "mdblist is down" }]);
    const r = await post("/api/external-list/item-mutate", { provider: "mdblist", mdblistKey: "MK", target: "watchlist", ...MATRIX });
    assert.deepEqual([r.status, r.body.ok, r.body.error], [400, false, "mdblist is down"]);
  });
});

describe("create and delete a list on a provider", () => {
  it("Trakt create posts the name and privacy and returns the list address; delete uses DELETE", async () => {
    const sent = stubFetch((url, req) => (req.method === "POST" ? [201, { ids: { trakt: 55, slug: "date-night" }, name: "Date night", privacy: "public", user: { ids: { slug: "bob" } } }] : [204, null]));
    const c = await post("/api/external-list/create", { provider: "trakt", traktAccessToken: "TT", name: "Date night", privacy: "public", type: "movie" });
    assert.equal(sent[0].url, "https://api.trakt.tv/users/me/lists");
    assert.equal(sent[0].body.name, "Date night");
    assert.equal(sent[0].body.privacy, "public");
    assert.deepEqual(c.body.list, { id: 55, slug: "date-night", name: "Date night", description: "", privacy: "public", url: "https://trakt.tv/users/bob/lists/date-night", type: "movie" });
    const d = await post("/api/external-list/delete", { provider: "trakt", traktAccessToken: "TT", listId: "date-night" });
    assert.deepEqual([sent[1].method, sent[1].url], ["DELETE", "https://api.trakt.tv/users/me/lists/date-night"]);
    assert.equal(d.body.ok, true);
  });

  it("TMDB create returns the new list id and address; delete names the list and the session", async () => {
    const sent = stubFetch((url, req) => (req.method === "POST" ? [201, { success: true, list_id: 4242 }] : [200, { success: true }]));
    const env = makeEnv({ TMDB_API_KEY: "K" });
    const c = await call(env, "/api/external-list/create", { method: "POST", json: { provider: "tmdb", tmdbSessionId: "S", name: "Picks" } });
    assert.equal(sent[0].url, "https://api.themoviedb.org/3/list?api_key=K&session_id=S");
    assert.equal(sent[0].body.name, "Picks");
    assert.equal(c.body.list.id, "4242");
    assert.equal(c.body.list.url, "https://www.themoviedb.org/list/4242");
    await call(env, "/api/external-list/delete", { method: "POST", json: { provider: "tmdb", tmdbSessionId: "S", listId: "4242" } });
    assert.deepEqual([sent[1].method, sent[1].url], ["DELETE", "https://api.themoviedb.org/3/list/4242?api_key=K&session_id=S"]);
  });

  it("MDBList create sends the privacy flag; delete retries with the numeric id when given a slug", async () => {
    const sent = stubFetch((url, req) => {
      if (url.endsWith("/lists/create")) return [200, { id: 8, slug: "picks", name: "Picks" }];
      if (req.method === "DELETE" && url.includes("/lists/picks")) return [404, { error: "not found" }];
      if (url.includes("/lists/user")) return [200, [{ id: 8, slug: "picks" }]];
      return [200, {}];
    });
    const c = await post("/api/external-list/create", { provider: "mdblist", mdblistKey: "MK", mdblistUsername: "bob", name: "Picks", privacy: "public" });
    assert.equal(sent[0].body.private, false);
    assert.equal(c.body.list.url, "https://mdblist.com/lists/bob/picks");
    const d = await post("/api/external-list/delete", { provider: "mdblist", mdblistKey: "MK", listId: "picks" });
    assert.equal(d.body.ok, true);
    const deletes = sent.filter((r) => r.method === "DELETE").map((r) => r.url);
    assert.deepEqual(deletes, ["https://api.mdblist.com/lists/picks?apikey=MK", "https://api.mdblist.com/lists/8?apikey=MK"]);
  });

  it("a provider that refuses create or delete is reported, a name or list id is required", async () => {
    stubFetch(() => [500, { error: "boom", status_message: "boom" }]);
    assert.equal((await post("/api/external-list/create", { provider: "trakt", traktAccessToken: "T", name: "x" })).body.ok, false);
    assert.equal((await post("/api/external-list/create", { provider: "trakt", traktAccessToken: "T", name: "" })).status, 400);
    assert.equal((await post("/api/external-list/delete", { provider: "trakt", traktAccessToken: "T", listId: "" })).status, 400);
    assert.equal((await post("/api/external-list/delete", { provider: "trakt", traktAccessToken: "T", listId: "x" })).body.ok, false);
  });
});

describe("copy watch history to a provider", () => {
  const ITEMS = [
    { type: "movie", imdbId: "tt0133093", title: "The Matrix", watchedAt: "2026-01-02T03:04:05Z" },
    { type: "movie", imdbId: "tt0109830", title: "Forrest Gump" },
    { type: "series", id: "tt0903747:2:5", showTitle: "Breaking Bad" },
  ];

  it("Trakt: movies are listed, episodes are grouped under their show and season", async () => {
    const sent = stubFetch();
    const r = await post("/api/external-sync/history", { provider: "trakt", traktAccessToken: "TT", items: ITEMS });
    assert.equal(r.body.ok, true);
    assert.equal(r.body.syncedCount, 3);
    assert.equal(sent[0].url, "https://api.trakt.tv/sync/history");
    assert.deepEqual(sent[0].body.movies, [
      { ids: { imdb: "tt0133093" }, title: "The Matrix", watched_at: "2026-01-02T03:04:05.000Z" },
      { ids: { imdb: "tt0109830" }, title: "Forrest Gump" },
    ]);
    assert.deepEqual(sent[0].body.shows, [{ ids: { imdb: "tt0903747" }, title: "Breaking Bad", seasons: [{ number: 2, episodes: [{ number: 5 }] }] }]);
  });

  it("Simkl: the same grouping goes to Simkl's history endpoint", async () => {
    const sent = stubFetch();
    const r = await post("/api/external-sync/history", { provider: "simkl", simklAccessToken: "ST", simklKey: "SK", items: ITEMS });
    assert.equal(r.body.syncedCount, 3);
    assert.equal(sent[0].url, "https://api.simkl.com/sync/history");
    assert.equal(sent[0].body.movies.length, 2);
    assert.deepEqual(sent[0].body.shows[0].seasons, [{ number: 2, episodes: [{ number: 5 }] }]);
  });

  it("MDBList: movies and numbered episodes go to sync/watched; if that fails each item is added one by one", async () => {
    const sent = stubFetch();
    const r = await post("/api/external-sync/history", { provider: "mdblist", mdblistKey: "MK", items: ITEMS });
    assert.equal(r.body.syncedCount, 3);
    assert.equal(sent[0].url, "https://api.mdblist.com/sync/watched?apikey=MK");
    assert.deepEqual(sent[0].body.movies, [{ imdb: "tt0133093" }, { imdb: "tt0109830" }]);
    assert.deepEqual(sent[0].body.episodes, [{ imdb: "tt0903747", season: 2, episode: 5 }]);

    const sent2 = stubFetch((url) => (url.includes("/sync/watched") ? [500, { error: "bulk failed" }] : [200, {}]));
    const r2 = await post("/api/external-sync/history", { provider: "mdblist", mdblistKey: "MK", items: ITEMS });
    assert.equal(r2.body.ok, true);
    assert.equal(r2.body.syncedCount, 3);
    assert.equal(sent2.filter((q) => q.url.startsWith("https://api.mdblist.com/history/add")).length, 3);
  });

  it("an empty list syncs nothing, no token is refused, a provider error is reported", async () => {
    const sent = stubFetch(() => [500, { error: "trakt down" }]);
    const none = await post("/api/external-sync/history", { provider: "trakt", traktAccessToken: "TT", items: [] });
    assert.deepEqual([none.body.ok, none.body.syncedCount], [true, 0]);
    assert.equal(sent.length, 0);
    assert.equal((await post("/api/external-sync/history", { provider: "trakt", items: ITEMS })).status, 400);
    const bad = await post("/api/external-sync/history", { provider: "trakt", traktAccessToken: "TT", items: ITEMS });
    assert.deepEqual([bad.status, bad.body.ok, bad.body.error], [500, false, "trakt down"]);
  });
});
