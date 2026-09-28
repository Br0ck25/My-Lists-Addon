import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadClient, requestsTo } from "./client-harness.mjs";

// The shell's Lists view (Phase 6, P6-4): your lists as cards you can act on.
// The three E2E scenarios this task is measured by are creating a list with
// titles added right there on the page (4), one share control (7) and editing a
// list you made earlier without losing it (9).
//
// These load the real shell page and drive the real functions. What they check
// is the contract with the server and with the rest of the page: which request
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
    "/api/creator/lists/save": async () => ({ json: { ok: true, slug: "horror", url: "https://example.com/lists/alice/horror" } }),
    "/api/resolve-movie": async () => ({ json: { ok: true, imdbId: "tt0137523" } }),
  }, overrides || {});
}

// Two lists the account already has, one private and one public.
function ownedLists() {
  return [
    { slug: "horror", name: "Horror", type: "movie", visibility: "private", items: [{ imdbId: "tt1" }, { imdbId: "tt2" }] },
    { slug: "comfort", name: "Comfort watching", type: "series", visibility: "public", items: [{ imdbId: "tt3" }] },
  ];
}

function loadListsClient(overrides) {
  const client = loadClient({ newUi: true, signedIn: true, routes: listsRoutes(overrides) });
  client.set("lastCreatorListsData", ownedLists());
  return client;
}

function cards(client) {
  return client.__byId.get("appShellListsHome").innerHTML;
}

describe("the shell's Lists view", () => {
  it("renders a card per list, with no inline handlers", () => {
    const client = loadListsClient();
    client.call("appShellRenderListsHome");
    const markup = cards(client);
    assert.ok(markup.includes("Horror"));
    assert.ok(markup.includes("Comfort watching"));
    assert.match(markup, /Private &middot; Movies &middot; 2 titles/);
    assert.match(markup, /Public &middot; Shows &middot; 1 title/);
    assert.equal(/on[a-z]+=/.test(markup), false, "the cards must not add inline handlers");
    for (const action of ["list-open", "list-edit", "list-home", "list-share"]) {
      assert.ok(markup.includes('data-app-shell-action="' + action + '"'), action + " is missing");
    }
  });

  it("does nothing at all on the old page", () => {
    const client = loadClient({ newUi: false, routes: listsRoutes({}) });
    assert.equal(client.call("appShellRenderListsHome"), false);
    assert.equal(cards(client), "");
    assert.equal(client.call("appShellRenderAddTitles", ""), false);
  });

  it("asks the page for the account's lists once, then shows the empty state", async () => {
    const client = loadListsClient();
    client.set("lastCreatorListsData", []);
    let loads = 0;
    client.set("loadCreatorSync", async () => { loads += 1; });
    client.call("appShellRenderListsHome");
    assert.match(cards(client), /Loading your lists/);
    assert.equal(loads, 1);
    // Still nothing to show -- the empty state, and no second request.
    await client.call("appShellListsRefresh");
    client.call("appShellRenderListsHome");
    assert.equal(loads, 2, "the refresh asked once more; nothing asks on its own");
    assert.match(cards(client), /No lists yet/);
    assert.match(cards(client), /data-app-shell-action="list-new"/);
  });

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

  it("puts a list on the home screen as an ordinary row, and takes it off again", () => {
    const client = loadListsClient();
    const added = [];
    let onHome = false;
    // The page's own helpers: this is the real contract the card has with the
    // rest of the page -- addRow builds the row, isListAddedToConfig answers
    // whether one is already there.
    client.set("isListAddedToConfig", () => onHome);
    client.set("addRow", (name, url, type, enabled, group) => {
      added.push({ name, url, type, enabled, group });
      onHome = true;
      return { name };
    });
    client.set("removeListFromConfig", () => { onHome = false; });
    client.set("renumber", () => {});

    client.call("appShellRenderListsHome");
    assert.equal(client.call("appShellListToggleHomeScreen", "horror"), true);
    assert.equal(added.length, 1);
    assert.equal(added[0].name, "Horror");
    assert.equal(added[0].type, "movie");
    assert.equal(added[0].group, "My Lists");
    assert.match(added[0].url, /^customlist:v1:/);
    assert.match(added[0].url, /"localSlug":"horror"/);
    assert.match(cards(client), /On your home screen/);

    assert.equal(client.call("appShellListToggleHomeScreen", "horror"), true);
    assert.equal(added.length, 1, "removing a row adds nothing");
    assert.equal(client.call("appShellListOnHomeScreen", "horror"), false);
    assert.match(cards(client), /Show on home screen/);
  });

  it("shares a list: three choices, one of which is not switched on yet", async () => {
    const client = loadListsClient();
    await client.call("appShellListsAction", "list-share", "horror");
    const markup = cards(client);
    for (const choice of ["Private", "Unlisted", "Public"]) {
      assert.ok(markup.includes(">" + choice + "</button>"), choice + " is missing");
    }
    // Unlisted cannot be saved today, so it is offered and disabled rather than
    // quietly turning the list private (normalizeListVisibility, 02_).
    assert.match(markup, /data-app-shell-id="horror\|unlisted" disabled/);
    assert.match(markup, /not switched on yet/);
    assert.ok(markup.includes("https://example.com/lists/alice/horror"), "the link is shown");
  });

  it("saves a visibility change the way the rest of the page does", async () => {
    const client = loadListsClient();
    await client.call("appShellSetListVisibility", "horror", "public");
    const saved = requestsTo(client, "/api/creator/lists/save");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].body.visibility, "public");
    assert.equal(saved[0].body.name, "Horror");
    assert.equal(saved[0].body.items.length, 2);
    assert.match(cards(client), /Public &middot; Movies/);
    // ...and an Unlisted choice is refused with a reason, not silently saved as
    // something else.
    assert.equal(await client.call("appShellSetListVisibility", "horror", "unlisted"), false);
    assert.equal(requestsTo(client, "/api/creator/lists/save").length, 1);
  });

  it("opens a list for editing through the dashboard's own entry point", () => {
    const client = loadListsClient();
    const edits = [];
    client.set("editCreatorList", (slug) => { edits.push(slug); });
    client.set("switchListsSubmenu", (sub) => { edits.push("sub:" + sub); });
    assert.equal(client.call("appShellStartListEdit", "comfort"), true);
    assert.deepEqual(edits, ["comfort", "sub:create-list"]);
    // A list kept in this browser only goes through the local editor.
    const local = loadClient({ newUi: true, routes: listsRoutes({}) });
    const localEdits = [];
    local.set("editLocalCustomList", (slug) => { localEdits.push(slug); });
    local.set("switchListsSubmenu", (sub) => { localEdits.push("sub:" + sub); });
    assert.equal(local.call("appShellStartListEdit", "horror"), false, "no such list in this browser");
  });

  it("opens a list page and finds nothing quietly when the list is gone", async () => {
    const client = loadListsClient();
    const opened = [];
    client.set("openListDetailsPage", (name, type, url) => { opened.push([name, type, url]); });
    assert.equal(await client.call("appShellListsAction", "list-open", "comfort"), true);
    assert.deepEqual(opened, [["Comfort watching", "series", "custom:comfort"]]);
    assert.equal(await client.call("appShellListsAction", "list-open", "nope"), false);
    assert.equal(await client.call("appShellListsAction", "unknown-action", "horror"), false);
  });
});
