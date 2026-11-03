// The shareable pages /lists/mdblist|trakt|tmdb|simkl/... (audit TEST-02).
// Someone following a link must land in the app with that list open. Today the
// server answers every one of these addresses with the plain app page
// (providerListPage) and the page's own script reads the address and opens the
// list (handleInitialDeepLink). So the two things to protect are: the server
// serves the app for every such address, and the page it serves carries the
// script that turns the address back into a list. The four per-provider page
// functions in 73_public-list-routes.js are shadowed by providerListPage and
// never run (recorded in the audit report, not tested here).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { call, makeEnv, makeKv } from "./harness.mjs";

const BROWSER = {
  Accept: "text/html",
  "User-Agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "document",
};
const open = (path) => call(makeEnv({ CONFIGS: makeKv() }), path, { headers: BROWSER });

describe("provider list addresses open the app", () => {
  for (const path of [
    "/lists/mdblist/bob/sci-fi-night",
    "/lists/mdblist/watchlist",
    "/lists/trakt/bob/best-movies",
    "/lists/trakt/history",
    "/lists/tmdb/8-disney-classics",
    "/lists/tmdb/collection/10-star-wars-collection",
    "/lists/simkl/shows/watching",
  ]) {
    it(`${path} is served as the app page, not an error or a redirect`, async () => {
      const r = await open(path);
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-type"), /text\/html/);
      assert.ok(r.text.includes('id="lists"'), "the full app, with its catalog list, is in the page");
    });
  }

  it("the page's own script (/app.js, /app-features.js) opens an MDBList or Trakt list from the address", async () => {
    const env = makeEnv({ CONFIGS: makeKv() });
    const page = await call(env, "/lists/mdblist/bob/sci-fi-night", { headers: BROWSER });
    const srcs = [...page.text.matchAll(/<script[^>]*src="(\/app[^"]*\.js)[^"]*"/g)].map((m) => m[1]);
    assert.ok(srcs.length >= 1, "the page loads the app script");
    let code = "";
    for (const src of srcs) code += (await call(env, src)).text;
    assert.ok(code.includes("^/lists/mdblist/([^/]+)/([^/]+)"), "MDBList address -> list");
    assert.ok(code.includes("https://mdblist.com/lists/' + mdbMatch[1] + '/' + mdbMatch[2]"), "...pointing at the MDBList list");
    assert.ok(code.includes("^/lists/trakt/([^/]+)/([^/]+)"), "Trakt address -> list");
    assert.ok(code.includes("https://trakt.tv/users/' + traktMatch[1] + '/lists/' + traktMatch[2]"), "...pointing at the Trakt list");
  });

  it("an address under /lists/ that no provider owns is not treated as a provider list", async () => {
    const r = await open("/lists/nobody-knows/what/this/is");
    assert.notEqual(r.status, 500);
    assert.ok(!r.text.includes("SERVER_DEEP_LINK_LIST = {"), "no list is invented for it");
  });
});
