import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadClient, requestsTo } from "./client-harness.mjs";

// The shell's Add titles search (Phase 6, P6-4): creating a list with titles
// added right there on the page (E2E 4). The rest of the Lists view (the "Your
// lists" cards) was taken off the page at the owner's request and deleted in
// Release 21.
//
// These load the real page and drive the real functions. What they check is
// the contract with the server and with the rest of the page: which request
// goes out, with which body, and what the page is told to do.

const TITLES = {
  ok: true,
  results: [
    { tmdbId: 550, title: "Fight Club", year: "1999", poster: "/p/550.jpg", type: "movie" },
    { tmdbId: 680, title: "Pulp Fiction", year: "1994", poster: "/p/680.jpg", type: "movie" },
  ],
};

function listsRoutes(overrides) {
  return Object.assign({
    "/api/title-search": async () => ({ json: TITLES }),
    "/api/resolve-movie": async () => ({ json: { ok: true, imdbId: "tt0137523" } }),
  }, overrides || {});
}

function loadListsClient(overrides) {
  return loadClient({ signedIn: true, routes: listsRoutes(overrides) });
}

describe("the shell's Add titles search", () => {
  it("searches titles and adds one straight to the draft list", async () => {
    const client = loadListsClient();
    client.call("appShellRenderAddTitles", "");
    const results = await client.call("appShellSearchTitles", "fight club");
    assert.equal(results.length, 2);
    const asked = requestsTo(client, "/api/title-search");
    assert.equal(asked.length, 1);
    assert.match(asked[0].url, /q=fight%20club/);
    assert.match(asked[0].url, /type=movie/);
    assert.ok(client.__byId.get("appShellAddTitles").innerHTML.includes("Fight Club"));

    await client.call("appShellAddTitle", 0);
    // addToCustomListDraft resolves the id, then the item is in the draft -- the
    // same draft the panel's own Save writes.
    const resolved = requestsTo(client, "/api/resolve-movie");
    assert.equal(resolved.length, 1);
    assert.match(resolved[0].url, /tmdbId=550/);
    const draft = client.get("customListDraftItems");
    assert.equal(draft.length, 1);
    assert.equal(draft[0].imdbId, "tt0137523");
    assert.equal(draft[0].title, "Fight Club");
  });

  it("searches the other kind of title once the list is a show list", async () => {
    const client = loadListsClient();
    client.set("customListDraftType", "series");
    await client.call("appShellSearchTitles", "the bear");
    assert.match(requestsTo(client, "/api/title-search")[0].url, /type=tv/);
  });

  it("says so when a search finds nothing", async () => {
    const client = loadListsClient({
      "/api/title-search": async () => ({ json: { ok: true, results: [] } }),
    });
    const results = await client.call("appShellSearchTitles", "zzzz");
    assert.deepEqual(results, []);
    assert.match(client.__byId.get("appShellAddTitles").innerHTML, /Nothing found for that/);
  });
});
