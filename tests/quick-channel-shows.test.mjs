// /api/quick-channel-shows (audit TEST-02): turns a TMDB network (CBS, HBO ...)
// or a pasted list address into the shows a channel is built from. The Channels
// panel's "Quick Add" and "Import from link" both start here, so if it returned
// nothing or the wrong ids, every new channel would come out empty.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { call, makeEnv } from "./harness.mjs";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
function stub(reply) {
  const sent = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input && input.url ? input.url : input));
    sent.push(url);
    const out = reply(url);
    return out ? Response.json(out) : new Response("{}", { status: 404 });
  };
  return sent;
}
const ask = (query, json) => call(makeEnv({ TMDB_API_KEY: "tmdbkey" }), `/api/quick-channel-shows${query}`, json ? { method: "POST", json } : {});

describe("quick add by TMDB network", () => {
  const SHOWS = [
    { id: 910001, name: "Show A", poster_path: "/a.jpg", backdrop_path: "/ab.jpg" },
    { id: 910002, name: "Show B", poster_path: null, backdrop_path: null },
    { id: 910003, name: "No IMDb id" },
  ];
  const IMDB = { 910001: "tt9100010", 910002: "tt9100020" };
  const provider = (u) => {
    if (u.pathname === "/3/discover/tv") return { results: u.searchParams.get("page") === "1" ? SHOWS : [], total_pages: 1 };
    if (u.pathname === "/3/network/56") return { logo_path: "/cbs.svg" };
    const m = /^\/3\/tv\/(\d+)$/.exec(u.pathname);
    if (m) return { external_ids: { imdb_id: IMDB[m[1]] || null }, name: "x" };
    return null;
  };

  it("returns the network's shows with their IMDb ids and poster addresses, and drops a show with no IMDb id", async () => {
    const sent = stub(provider);
    const { body } = await ask("?networkId=56");
    assert.equal(body.ok, true);
    assert.deepEqual(body.shows.map((s) => [s.imdbId, s.tmdbId, s.name]), [["tt9100010", 910001, "Show A"], ["tt9100020", 910002, "Show B"]]);
    assert.equal(body.shows[0].poster, "https://image.tmdb.org/t/p/w500/a.jpg");
    assert.equal(body.shows[0].backdrop, "https://image.tmdb.org/t/p/w780/ab.jpg");
    assert.equal(body.shows[1].poster, null);
    assert.equal(sent.find((u) => u.pathname === "/3/discover/tv").searchParams.get("with_networks"), "56", "asks TMDB for this network");
  });

  it("the network's logo goes through this site's logo proxy (a raw .svg cannot be a poster)", async () => {
    stub(provider);
    const { body } = await ask("?networkId=56");
    assert.equal(body.networkLogo, "https://example.test/api/channel-logo?path=%2Fcbs.svg");
  });

  it("a network with no shows says so", async () => {
    stub((u) => (u.pathname === "/3/discover/tv" ? { results: [], total_pages: 1 } : null));
    const { body } = await ask("?networkId=999");
    assert.equal(body.ok, false);
    assert.match(body.error, /No shows found for that network/);
  });
});

describe("import from a list address", () => {
  const list = (items) => "customlist:v1:" + JSON.stringify({ name: "L", type: "series", items });
  const SERIES = [
    { id: "tt9200010", type: "series", name: "Found Show", poster: "https://img.example/f.jpg" },
    { id: "tt9200020", type: "series", name: "Unknown To TMDB" },
    { id: "tt9200030", type: "movie", name: "A Movie" },
  ];
  const provider = (u) => {
    const m = /^\/3\/find\/(tt\d+)$/.exec(u.pathname);
    if (!m) return null;
    if (m[1] === "tt9200010") return { tv_results: [{ id: 5550, poster_path: "/p.jpg", backdrop_path: "/b.jpg" }] };
    return { tv_results: [] };
  };

  it("keeps the list's shows, finds each one on TMDB, and leaves out movies and shows TMDB does not know", async () => {
    const sent = stub(provider);
    const { body } = await ask("", { url: list(SERIES) });
    assert.equal(body.ok, true);
    assert.deepEqual(body.shows.map((s) => [s.imdbId, s.tmdbId, s.name]), [["tt9200010", 5550, "Found Show"]]);
    assert.equal(body.shows[0].poster, "https://img.example/f.jpg", "the list's own poster wins");
    assert.equal(body.shows[0].backdrop, "https://image.tmdb.org/t/p/w780/b.jpg");
    assert.ok(!sent.some((u) => u.pathname.includes("tt9200030")), "a movie is never looked up");
  });

  it("a list with only movies says channels are shows-only; nothing to import says what is missing", async () => {
    stub(provider);
    const movies = await ask("", { url: list([SERIES[2]]) });
    assert.equal(movies.body.ok, false);
    assert.match(movies.body.error, /no shows in it/);
    const none = await ask("", {});
    assert.equal(none.status, 400);
    assert.match(none.body.error, /Missing url or networkId/);
  });

  it("keys sent in the address are refused (they belong in the POST body)", async () => {
    stub(provider);
    const r = await call(makeEnv(), "/api/quick-channel-shows?mdblistKey=abc&url=x");
    assert.equal(r.status, 400);
  });
});
