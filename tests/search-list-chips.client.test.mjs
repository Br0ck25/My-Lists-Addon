// Search -> Lists on the new UI: the source and sort chips that used to be
// Discover's Explore section (setCatalogListSearchChip, 19_). They filter and
// re-order Search's own list results; the old page has no chips and its
// results are exactly what they were.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadClient } from "./client-harness.mjs";

const MDB = [{ name: "Mdb Horror", url: "https://mdblist.com/lists/a/horror", likes: 5, items: 10 }];
const TRAKT = [{ name: "Trakt Picks", url: "https://trakt.tv/users/b/lists/picks", likes: 50, items: 10 }];
const MINE = [
  { name: "Fresh List", url: "https://example.com/lists/c/fresh", likes: 1, items: 3, createdAt: 2000, adds: 9, source: "My Lists Addon" },
  { name: "Loved List", url: "https://example.com/lists/d/loved", likes: 20, items: 3, createdAt: 1000, adds: 1, source: "My Lists Addon" },
];

function namesIn(html) {
  return [...html.matchAll(/data-name="([^"]+)" data-url/g)].map((m) => m[1]).filter((n, i, a) => a.indexOf(n) === i);
}

function searchClient(newUi) {
  const client = loadClient({ newUi, routes: { "/api/preview": async () => ({ json: { ok: true, sample: [] } }) } });
  const box = client.document.getElementById("catalogSearchResult");
  box.id = "catalogSearchResult";
  client.document.getElementById("catalogSearchInput").value = "list";
  client.set("currentCatalogSearchType", "lists");
  client.call("renderListSearchResults", MDB, TRAKT, null, MINE, [], box, "");
  return { client, box };
}

describe("Search -> Lists source and sort chips (new UI)", () => {
  it("shows every source, best first, until a chip is pressed", () => {
    const { box } = searchClient(true);
    assert.deepEqual(namesIn(box.innerHTML), ["Trakt Picks", "Loved List", "Mdb Horror", "Fresh List"]);
  });

  it("keeps one source", () => {
    const { client, box } = searchClient(true);
    client.call("setCatalogListSearchChip", "source", "mylists");
    assert.deepEqual(namesIn(box.innerHTML).sort(), ["Fresh List", "Loved List"]);
    client.call("setCatalogListSearchChip", "source", "mdblist");
    assert.deepEqual(namesIn(box.innerHTML), ["Mdb Horror"]);
    client.call("setCatalogListSearchChip", "source", "all");
    assert.equal(namesIn(box.innerHTML).length, 4);
  });

  it("sorts by likes, newest and most added -- lists without the figure after", () => {
    const { client, box } = searchClient(true);
    client.call("setCatalogListSearchChip", "sort", "new");
    assert.deepEqual(namesIn(box.innerHTML).slice(0, 2), ["Fresh List", "Loved List"], "dated lists first, newest first");
    client.call("setCatalogListSearchChip", "sort", "added");
    assert.deepEqual(namesIn(box.innerHTML).slice(0, 2), ["Fresh List", "Loved List"], "most added first");
    client.call("setCatalogListSearchChip", "sort", "popular");
    assert.deepEqual(namesIn(box.innerHTML), ["Trakt Picks", "Loved List", "Mdb Horror", "Fresh List"]);
    // Pressing the pressed one again goes back to best match.
    client.call("setCatalogListSearchChip", "sort", "popular");
    assert.equal(client.get("catalogListSearchSort"), "");
  });

  it("leaves the old page's results alone", () => {
    const { client, box } = searchClient(false);
    client.set("catalogListSearchSource", "mdblist");
    client.call("renderListSearchResults", MDB, TRAKT, null, MINE, [], box, "");
    assert.equal(namesIn(box.innerHTML).length, 4, "no chips on the old page, so nothing is filtered");
  });
});
