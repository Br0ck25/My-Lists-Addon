// Read-only provider routes that no other test ran (audit TEST-02): the sign-in
// redirects, the popular-lists route, show-id resolving and the static files.
// Each test stubs the provider with a fixture from tests/fixtures/providers/ and
// asserts the answer's content (ids, addresses, redirect targets), not just 200.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { call, makeEnv, makeKv } from "./harness.mjs";

const fixture = (f) => JSON.parse(readFileSync(new URL(`./fixtures/providers/${f}`, import.meta.url), "utf8")).response;
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
function stub(reply) {
  const sent = [];
  globalThis.fetch = async (input) => {
    const url = String(input && input.url ? input.url : input);
    sent.push(url);
    const out = reply(new URL(url));
    return out ? Response.json(out) : new Response("{}", { status: 404 });
  };
  return sent;
}

describe("sign-in redirects send people to the right provider page", () => {
  const origin = "https://example.test";
  for (const [name, path, host, authPath, clientVar, pkce] of [
    ["Trakt", "/api/trakt/oauth/start", "trakt.tv", "/oauth/authorize", "TRAKT_CLIENT_ID", false],
    ["Simkl", "/api/simkl/oauth/start", "simkl.com", "/oauth/authorize", "SIMKL_CLIENT_ID", false],
    ["MDBList", "/api/mdblist/oauth/start", "mdblist.com", "/oauth/authorize/", "MDBLIST_CLIENT_ID", true],
  ]) {
    it(`${name}: redirects with this site's client id, a callback on this origin and a fresh state${pkce ? " and a PKCE challenge" : ""}`, async () => {
      const env = makeEnv({ [clientVar]: "client-123" });
      const a = await call(env, path);
      const b = await call(env, path);
      assert.equal(a.status, 302);
      const to = new URL(a.headers.get("location"));
      assert.equal(to.hostname, host);
      assert.equal(to.pathname, authPath);
      assert.equal(to.searchParams.get("client_id"), "client-123");
      assert.equal(to.searchParams.get("redirect_uri"), `${origin}${path.replace("/start", "/callback")}`);
      assert.equal(to.searchParams.get("response_type"), "code");
      assert.ok(to.searchParams.get("state").length >= 8, "a state value to check on the way back");
      assert.notEqual(to.searchParams.get("state"), new URL(b.headers.get("location")).searchParams.get("state"), "state is fresh each time");
      if (pkce) {
        assert.equal(to.searchParams.get("code_challenge_method"), "S256");
        assert.ok(to.searchParams.get("code_challenge"));
      }
    });
  }

  it("TMDB: asks TMDB for a request token, sends the person to TMDB with it and remembers it in a cookie", async () => {
    const sent = stub((u) => (u.pathname === "/3/authentication/token/new" ? { success: true, request_token: "RT-abc" } : null));
    const res = await call(makeEnv({ TMDB_API_KEY: "k" }), "/api/tmdb/oauth/start");
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), `https://www.themoviedb.org/authenticate/RT-abc?redirect_to=${encodeURIComponent(origin + "/api/tmdb/oauth/callback")}`);
    assert.match(res.headers.get("set-cookie"), /mla_tmdb_token=RT-abc;.*HttpOnly/);
    assert.match(sent[0], /api_key=k/);
  });

  it("TMDB: with no key it says sign-in is unavailable and asks TMDB nothing", async () => {
    const sent = stub(() => ({}));
    const res = await call(makeEnv(), "/api/tmdb/oauth/start");
    assert.equal(res.status, 503);
    assert.equal(sent.length, 0);
  });
});

describe("popular lists", () => {
  it("/api/toplists maps MDBList's top lists to name, user, slug, type, items and likes", async () => {
    const top = fixture("mdblist/top-lists.json");
    const sent = stub((u) => (u.pathname === "/lists/top" ? top : null));
    const res = await call(makeEnv({ CONFIGS: makeKv(), MDBLIST_POPULAR_KEY: "pk" }), "/api/toplists");
    assert.equal(res.body.ok, true);
    assert.equal(res.body.lists.length, top.length);
    const first = res.body.lists[0];
    assert.deepEqual([first.name, first.user, first.slug, first.items, first.likes], [top[0].name, top[0].user_name, top[0].slug, top[0].items, top[0].likes]);
    assert.ok(top.some((l) => l.mediatype === "show") && top.some((l) => l.mediatype !== "show"), "the fixture has both kinds");
    assert.deepEqual(res.body.lists.map((l) => l.type), top.map((l) => (l.mediatype === "show" ? "series" : "movie")), "shows are series, the rest movies");
    assert.match(sent[0], /apikey=pk/);
  });

  it("/api/toplists without the site's MDBList key says so instead of showing an empty page", async () => {
    stub(() => ({}));
    const res = await call(makeEnv({ CONFIGS: makeKv() }), "/api/toplists");
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /temporarily unavailable/);
  });
});

describe("resolving a show's IMDb id", () => {
  it("/api/resolve-show returns the IMDb id TMDB lists for the show", async () => {
    const tv = fixture("tmdb/tv-details.json");
    const imdb = tv.external_ids && tv.external_ids.imdb_id;
    assert.ok(imdb, "the fixture carries an imdb id");
    stub((u) => (u.pathname.startsWith("/3/tv/") ? tv : null));
    const res = await call(makeEnv({ TMDB_API_KEY: "k" }), "/api/resolve-show?tmdbId=1396");
    assert.deepEqual([res.body.ok, res.body.imdbId], [true, imdb]);
  });

  it("/api/resolve-show needs a tmdbId", async () => {
    const res = await call(makeEnv({ TMDB_API_KEY: "k" }), "/api/resolve-show");
    assert.equal(res.status, 400);
  });
});

describe("static files", () => {
  it("robots.txt lets search engines in at the front page and keeps them out of /admin and /api/", async () => {
    const res = await call(makeEnv(), "/robots.txt");
    assert.equal(res.status, 200);
    const text = typeof res.body === "string" ? res.body : String(res.text || res.body);
    assert.match(text, /Allow: \/\$/);
    assert.match(text, /Disallow: \/admin/);
    assert.match(text, /Disallow: \/api\//);
  });

  it("sitemap.xml is a urlset naming the home page on this origin", async () => {
    const res = await call(makeEnv(), "/sitemap.xml");
    assert.match(res.headers.get("content-type"), /xml/);
    const text = typeof res.body === "string" ? res.body : String(res.text || res.body);
    assert.match(text, /<urlset[^>]*sitemaps\.org/);
    assert.match(text, /<loc>https:\/\/example\.test\/<\/loc>/);
  });

  it("unavailable-poster.svg is a 300x450 poster-shaped SVG", async () => {
    const res = await call(makeEnv(), "/unavailable-poster.svg");
    assert.match(res.headers.get("content-type"), /image\/svg\+xml/);
    const text = typeof res.body === "string" ? res.body : String(res.text || res.body);
    assert.match(text, /<svg[^>]*width="300"[^>]*height="450"/);
  });
});

describe("MDBList watch history (raw) and the item-add path", () => {
  const post = (path, json) => call(makeEnv(), path, { method: "POST", json });

  it("history-raw: gathers movies, shows and episodes from MDBList with the user's key, and hides the key in its debug log", async () => {
    const sent = stub((u) => {
      if (u.pathname !== "/sync/watched") return u.pathname === "/lists/user" ? [{ user_name: "bob" }] : null;
      const mt = u.searchParams.get("mediatype");
      if (mt === "movie") return { movies: [{ id: 1, title: "The Matrix", imdb_id: "tt0133093" }] };
      if (mt === "show") return { shows: [{ id: 2, title: "Breaking Bad", imdb_id: "tt0903747" }] };
      return { episodes: [] };
    });
    const res = await post("/api/mdblist-history-raw", { apikey: "SECRETKEY" });
    assert.equal(res.body.ok, true);
    assert.deepEqual(res.body.items.map((i) => i.imdb_id), ["tt0133093", "tt0903747"]);
    const watched = sent.filter((u) => u.includes("/sync/watched"));
    assert.deepEqual(watched.map((u) => new URL(u).searchParams.get("mediatype")), ["movie", "show", "episode"]);
    assert.ok(watched.every((u) => new URL(u).searchParams.get("apikey") === "SECRETKEY"));
    assert.ok(!JSON.stringify(res.body.debug).includes("SECRETKEY"), "the key is not echoed back");
  });

  it("history-raw: with no key, account or username it says it is not connected and asks MDBList nothing", async () => {
    const sent = stub(() => ({}));
    const res = await post("/api/mdblist-history-raw", {});
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "Not connected to MDBList.");
    assert.equal(sent.length, 0);
  });

  it("item-add adds (it is the add spelling of item-mutate): a Trakt watchlist add reaches Trakt, not the remove address", async () => {
    const sent = stub(() => ({ added: { movies: 1 } }));
    const res = await post("/api/external-list/item-add", { provider: "trakt", traktAccessToken: "TT", traktKey: "CID", imdbId: "tt0133093", tmdbId: "603", title: "The Matrix", year: "1999", mediaType: "movie" });
    assert.equal(res.body.ok, true);
    assert.deepEqual(sent, ["https://api.trakt.tv/sync/watchlist"]);
  });
});
