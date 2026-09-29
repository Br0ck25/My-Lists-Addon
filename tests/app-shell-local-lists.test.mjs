// P6-9: lists kept in one browser, and the two ways out of that state.
//
// A list made while signed out lives in this browser alone (D-8). That is
// deliberate, but until this task it was invisible in the new UI -- UX-H10 --
// and there was nothing in the page that would move one to an account after
// sign-up. The Lists view now shows them beside the account's lists, says
// "Saved in this browser only" on each one, and offers **Save to an account**
// and **Export**.
//
// The fixture matters: these tests start from exactly what a legacy browser
// holds (`myListAddon:localCustomLists`, a map of hand-built lists), not from
// anything built in the test, because "existing local lists show up and can
// migrate" is what the task is measured by.
//
// The trap this task had to design around is stated in the tests below: signing
// in calls clearLocalAccountData(), which empties this browser's whole store --
// so the intent to save has to carry the list itself, not its name.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadClient, requestsTo } from "./client-harness.mjs";

const LISTS_KEY = "myListAddon:localCustomLists";

// What a browser that has been using the old page holds: two hand-built lists,
// plus the generated shelves that live in the same store.
function legacyStorage(extra) {
  return Object.assign({
    [LISTS_KEY]: JSON.stringify({
      "sci-fi": {
        slug: "sci-fi", name: "Sci-Fi Night", type: "movie",
        items: [{ imdbId: "tt0062622", title: "2001" }, { imdbId: "tt0076759", title: "Star Wars" }],
        updatedAt: 1700000000000,
      },
      "docs": {
        slug: "docs", name: "Documentaries", type: "movie", items: [{ imdbId: "tt1" }],
      },
      "watch-history": { slug: "watch-history", name: "Watch History", type: "mixed", items: [{ imdbId: "tt9" }] },
      "continue-watching": { slug: "continue-watching", name: "Continue Watching", type: "mixed", items: [] },
      "watchlist": { slug: "watchlist", name: "Watchlist", type: "mixed", items: [{ imdbId: "tt8" }] },
    }),
  }, extra || {});
}

function savedLists() {
  return [];
}

function saveRoutes(saves, overrides) {
  return Object.assign({
    "/api/creator/lists/save": async (req) => {
      saves.push(req.body);
      return { json: { ok: true, slug: req.body.slug, url: "https://example.com/lists/alice/" + req.body.slug } };
    },
  }, overrides || {});
}

function cards(client) {
  return client.__byId.get("appShellListsHome").innerHTML;
}

function storedLists(client) {
  try { return JSON.parse(client.localStorage.getItem(LISTS_KEY) || "{}"); } catch (e) { return {}; }
}

describe("P6-9: a list saved in this browser only", () => {
  it("shows the lists a legacy browser holds, and says where they live", () => {
    const client = loadClient({ newUi: true, routes: {}, storage: legacyStorage() });
    client.call("appShellRenderListsHome");
    const markup = cards(client);
    assert.ok(markup.includes("Sci-Fi Night"), "the legacy list is on screen");
    assert.ok(markup.includes("Documentaries"));
    assert.match(markup, /Saved in this browser only &middot; Movies &middot; 2 titles/);
    assert.match(markup, /clearing this browser/);
    assert.ok(markup.includes('data-app-shell-action="list-save-account"'), "Save to an account is offered");
    assert.ok(markup.includes('data-app-shell-action="list-export"'), "Export is offered");
    // Nothing to share yet: a list the account has never seen has no link.
    assert.equal(markup.includes('data-app-shell-action="list-share"'), false);
    assert.equal(/on[a-z]+=/.test(markup), false, "and still no inline handlers");
  });

  it("does not offer the generated shelves as something to save", () => {
    const client = loadClient({ newUi: true, routes: {}, storage: legacyStorage() });
    client.call("appShellRenderListsHome");
    const markup = cards(client);
    // Watch History, Continue Watching and the Watchlist travel in the
    // account's own tracking record; they are not hand-built lists and the
    // sign-up migration deliberately leaves them out.
    for (const name of ["Watch History", "Continue Watching", "Watchlist"]) {
      assert.equal(markup.includes("<strong>" + name + "</strong>"), false, name + " is not a card here");
    }
  });

  it("saves one to a signed-in account, privately, and lets the browser's copy go", async () => {
    const saves = savedLists();
    const client = loadClient({
      newUi: true, signedIn: true, storage: legacyStorage(), routes: saveRoutes(saves),
    });
    client.set("lastCreatorListsData", []);
    client.call("appShellRenderListsHome");

    assert.equal(await client.call("appShellSaveLocalListToAccount", "sci-fi"), true);
    assert.equal(saves.length, 1);
    assert.equal(saves[0].creatorName, "alice");
    assert.equal(saves[0].slug, "sci-fi");
    assert.equal(saves[0].name, "Sci-Fi Night");
    assert.equal(saves[0].type, "movie");
    assert.equal(saves[0].items.length, 2);
    assert.equal(saves[0].visibility, "private", "nobody asked for it to be published");
    assert.equal(storedLists(client)["sci-fi"], undefined, "the browser's copy is gone once the account has it");
    assert.ok(storedLists(client)["docs"], "and the other list is untouched");
  });

  it("shows a browser-only list beside the account's own, without duplicating the account's", () => {
    const client = loadClient({ newUi: true, signedIn: true, routes: {}, storage: legacyStorage() });
    client.set("lastCreatorListsData", [
      { slug: "horror", name: "Horror", type: "movie", visibility: "public", items: [{ imdbId: "tt2" }] },
    ]);
    // The account's list is also in this browser's store, as the cache it is --
    // with the creatorSlug that says the account owns it.
    client.set("loadLocalCustomLists", () => ({
      horror: { slug: "horror", creatorSlug: "horror", name: "Horror", type: "movie", items: [{ imdbId: "tt2" }] },
      "sci-fi": { slug: "sci-fi", name: "Sci-Fi Night", type: "movie", items: [{ imdbId: "tt0062622" }] },
    }));
    client.call("appShellRenderListsHome");
    const markup = cards(client);
    const rows = markup.split('<div class="app-shell-row">').slice(1);
    assert.equal(rows.length, 2, "one card per list -- no copy of the account's list from the browser cache");
    const horrorCard = rows.filter((r) => r.includes("<strong>Horror</strong>"))[0];
    const sciFiCard = rows.filter((r) => r.includes("<strong>Sci-Fi Night</strong>"))[0];
    assert.ok(horrorCard, "the account's list is on screen");
    assert.equal(horrorCard.includes("Saved in this browser only"), false, "and is not labelled browser-only");
    assert.ok(horrorCard.includes('data-app-shell-action="list-share"'), "it is shareable");
    assert.ok(sciFiCard.includes("Saved in this browser only"), "the browser-only one is labelled");
    assert.equal(sciFiCard.includes('data-app-shell-action="list-share"'), false);
  });

  it("remembers the list itself when it asks a signed-out person to sign in", async () => {
    const client = loadClient({ newUi: true, routes: {}, storage: legacyStorage() });
    let opened = 0;
    client.set("openRestoreModal", () => { opened += 1; });
    client.call("appShellRenderListsHome");

    assert.equal(await client.call("appShellSaveLocalListToAccount", "sci-fi"), true);
    assert.equal(opened, 1, "the sign-in modal is what it asks with");
    const pending = client.call("pendingListSaves");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].slug, "sci-fi");
    assert.equal(pending[0].items.length, 2, "the list travels in the queue, not just its name");
    assert.equal(requestFinishedNow(client), false, "nothing was sent while there is no account");

    function requestFinishedNow(c) { return requestsTo(c, "/api/creator/lists/save").length > 0; }
  });

  it("pushes the remembered list right after sign-in, when the store is already empty", async () => {
    const saves = savedLists();
    const client = loadClient({
      newUi: true, signedIn: true, routes: saveRoutes(saves), storage: legacyStorage(),
    });
    // The person pressed Save while signed out...
    client.set("activeCreator", null);
    client.set("openRestoreModal", () => {});
    client.call("appShellSaveLocalListToAccount", "sci-fi");
    // ...and signing in emptied this browser's store, exactly as
    // clearLocalAccountData does. The queue is the only copy left.
    client.localStorage.removeItem(LISTS_KEY);
    client.set("activeCreator", { creatorName: "alice", displayName: "Alice" });
    client.set("lastCreatorListsData", []);

    const saved = await client.call("flushPendingListSaves");
    assert.equal(saved, 1);
    assert.equal(saves.length, 1);
    assert.equal(saves[0].name, "Sci-Fi Night");
    assert.deepEqual(saves[0].items, [{ imdbId: "tt0062622", title: "2001" }, { imdbId: "tt0076759", title: "Star Wars" }]);
    assert.equal(client.call("pendingListSaves").length, 0, "and the queue is done");
    assert.equal(await client.call("flushPendingListSaves"), 0, "flushing twice does not save twice");
    assert.equal(saves.length, 1);
  });

  it("exports one list as a file the page's own restore can read back", async () => {
    const client = loadClient({ newUi: true, routes: {}, storage: legacyStorage() });
    client.call("appShellRenderListsHome");
    const files = [];
    client.set("downloadJsonFile", (filename, payload) => { files.push({ filename, payload }); });

    assert.equal(client.call("appShellExportList", "sci-fi"), true);
    assert.equal(files.length, 1);
    assert.equal(files[0].filename, "sci-fi-night-list.json");
    const payload = files[0].payload;
    assert.equal(payload.version, "3.0");
    assert.equal(payload.customLists["sci-fi"].name, "Sci-Fi Night");
    assert.equal(payload.customLists["sci-fi"].items.length, 2);

    // Round trip: the file goes into a different browser (a fresh client, empty
    // store) through the page's own backup importer, and comes back as the same
    // list.
    const other = loadClient({ newUi: true, routes: {} });
    other.call("applyImportedConfig", JSON.parse(JSON.stringify(payload)));
    const back = other.call("loadLocalCustomLists");
    assert.equal(back["sci-fi"].name, "Sci-Fi Night");
    assert.equal(back["sci-fi"].items.length, 2);
    assert.equal((back["sci-fi"].items[0] || {}).imdbId, "tt0062622");
  });

  it("says so when the account does not answer, and keeps the browser's copy", async () => {
    const client = loadClient({
      newUi: true, signedIn: true, storage: legacyStorage(),
      routes: { "/api/creator/lists/save": async () => ({ status: 500, json: { ok: false, error: "boom" } }) },
    });
    client.set("lastCreatorListsData", []);
    client.call("appShellRenderListsHome");
    assert.equal(await client.call("appShellSaveLocalListToAccount", "sci-fi"), false);
    assert.ok(storedLists(client)["sci-fi"], "a failed save must not lose the list");
  });

  it("opens and edits a browser-only list through the local path", () => {
    const client = loadClient({ newUi: true, routes: {}, storage: legacyStorage() });
    const opened = [];
    client.set("editLocalCustomList", (slug) => { opened.push(slug); });
    client.set("switchListsSubmenu", () => {});
    client.call("appShellRenderListsHome");
    assert.equal(client.call("appShellStartListEdit", "sci-fi"), true);
    assert.deepEqual(opened, ["sci-fi"]);
  });
});
