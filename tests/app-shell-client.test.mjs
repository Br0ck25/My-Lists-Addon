import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadClient, requestsTo } from "./client-harness.mjs";

// The client half of the new UI shell (Phase 6, P6-1). These load the real
// page -- the only one since the classic page was retired (Release 21) -- so
// what is tested is the code that ships, not a copy of it.
//
// Two things matter here that the server tests cannot see: the older switchers
// still route through the shell (so a click anywhere in the old UI lands on a
// real path), and they never rewrite the URL to "/" themselves.

const VIEWS = [
  { tab: "catalogs", path: "/catalogs", subs: ["all", "quickadd", "bulk"] },
  { tab: "lists", path: "/lists", subs: ["my-lists", "liked", "create-list", "import"] },
  { tab: "channels", path: "/channels", subs: ["my-channels", "storylines", "quickadd", "explore", "import", "build"] },
  { tab: "discover", path: "/discover", subs: ["movie", "all", "series", "popular", "curated", "gems", "kids", "holidays", "genres"] },
  { tab: "search", path: "/search", subs: [] },
  { tab: "settings", path: "/settings", subs: ["account", "display", "scrobble", "external", "backup", "feedback"] },
];

// Values that cross the vm boundary have another realm's prototypes, so
// deepEqual's reference check rejects objects that are plainly equal. Everything
// these tests compare is JSON-shaped, so compare it as JSON.
function plain(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value));
}

function pushedPaths(client) {
  return client.historyCalls.filter((c) => c.kind === "push").map((c) => c.args[2]);
}
function allPaths(client) {
  return client.historyCalls.map((c) => c.args[2]);
}
// Booting a shell page at "/" settles the address bar on /discover (see
// initAppShell), so a test that counts what a click pushed clears what the
// boot did first.
function forgetBootNavigation(client) {
  client.historyCalls.length = 0;
}

describe("the new UI shell's routes", () => {
  it("reads a real path back into a view", () => {
    const client = loadClient();
    assert.deepEqual(plain(client.call("appShellRouteFromPath", "/catalogs")), { tab: "catalogs", sub: "" });
    assert.deepEqual(plain(client.call("appShellRouteFromPath", "/catalogs/quickadd")), { tab: "catalogs", sub: "quickadd" });
    assert.deepEqual(plain(client.call("appShellRouteFromPath", "/settings/account/")), { tab: "settings", sub: "account" });
    // Not shell routes: the home page, a share link, and a sub that does not
    // exist. A share link must keep its own handler rather than opening the
    // Lists view.
    assert.equal(client.call("appShellRouteFromPath", "/"), null);
    assert.equal(client.call("appShellRouteFromPath", "/lists/watchlist"), null);
    assert.equal(client.call("appShellRouteFromPath", "/lists/Anonymous/some-list"), null);
    assert.equal(client.call("appShellRouteFromPath", "/channels/alice/my-channel"), null);
    assert.equal(client.call("appShellRouteFromPath", "/settings/not-a-sub"), null);
  });

  it("builds the same paths back", () => {
    const client = loadClient();
    for (const view of VIEWS) {
      assert.equal(client.call("appShellPathFor", view.tab, ""), view.path);
      for (const sub of view.subs) {
        const path = client.call("appShellPathFor", view.tab, sub);
        assert.equal(path, `${view.path}/${sub}`);
        // Round trip: every path the shell builds is one it can read, and it
        // reads it back as the same view and sub-tab.
        assert.deepEqual(plain(client.call("appShellRouteFromPath", path)), { tab: view.tab, sub });
      }
      // A sub that is not this view's falls back to the view itself, which is
      // what keeps a stale URL from opening nothing.
      assert.equal(client.call("appShellPathFor", view.tab, "not-a-sub"), view.path);
    }
  });

  it("routes the legacy aliases to the same view their own switcher would open", () => {
    const client = loadClient();
    assert.deepEqual(plain(client.call("appShellRouteForName", "backup")), { tab: "settings", sub: "backup" });
    assert.deepEqual(plain(client.call("appShellRouteForName", "keys")), { tab: "settings", sub: "account" });
    assert.deepEqual(plain(client.call("appShellRouteForName", "quick-add")), { tab: "catalogs", sub: "quickadd" });
    assert.deepEqual(plain(client.call("appShellRouteForName", "lists")), { tab: "lists", sub: "" });
    // Detail views are not shell views: they keep the legacy path.
    assert.equal(client.call("appShellRouteForName", "list-details"), null);
    assert.equal(client.call("appShellRouteForName", "item-details"), null);
  });

  it("settles the address bar on boot: / becomes the Discover path, an explicit path stays", () => {
    const client = loadClient();
    // "/" is the whole site's home page, but every shell view has a real path,
    // so the home page becomes the Discover one. (The builder's own boot code
    // runs before the shell takes over and may write "/" once first; what
    // matters is where the address bar settles.)
    assert.equal(allPaths(client).pop(), "/discover");
    assert.deepEqual(plain(client.historyCalls[client.historyCalls.length - 1].args[0]), { appShell: true });

    const deep = loadClient();
    deep.location.pathname = "/settings/backup";
    forgetBootNavigation(deep);
    // Booting again at an explicit path must not rewrite it.
    deep.call("initAppShell");
    assert.deepEqual(allPaths(deep), []);
    assert.equal(deep.localStorage.getItem("myListAddon:settingsSubmenu"), "backup");
  });

  it("never rewrites the address before the shell has taken over (Release 21)", () => {
    // At startup the page draws the view the address names before
    // initAppShell runs. The classic page's switchers rewrote the address to
    // "/" right then, so a page opened at /settings (a bookmark, a reload)
    // came up on Discover once the router read "/".
    const client = loadClient();
    client.set("appShellActive", false);
    forgetBootNavigation(client);
    client.call("switchTab", "settings");
    client.call("switchCatalogsSubmenu", "quickadd");
    assert.deepEqual(allPaths(client), [], "nothing may touch the address before the router reads it");
    assert.equal(client.localStorage.getItem("myListAddon:activeTab"), "settings", "the switcher still did its own work");
  });

  it("settles / on the view this browser used last, and draws that view (Release 21)", () => {
    const client = loadClient();
    client.set("window._originTab", "settings");
    forgetBootNavigation(client);
    client.call("initAppShell");
    assert.deepEqual(allPaths(client), ["/settings"], "the address names the view that is open, not always Discover");
    assert.deepEqual(plain(client.get("appShellState.get('route')")), { tab: "settings", sub: "" });

    // A share link at "/" with a hash keeps its address.
    const share = loadClient();
    share.location.hash = "#/item?id=tt0137523&type=movie";
    forgetBootNavigation(share);
    share.call("initAppShell");
    assert.deepEqual(allPaths(share), []);
  });

  it("moves the address bar and the view together, and says which page is current", () => {
    const client = loadClient();
    forgetBootNavigation(client);
    assert.equal(client.call("appShellGo", "/lists/liked"), true);
    assert.deepEqual(pushedPaths(client), ["/lists/liked"]);
    // The legacy switchers did the DOM work: the Lists view is active and its
    // sub-tab is the one the path named.
    assert.equal(client.localStorage.getItem("myListAddon:activeTab"), "lists");
    assert.equal(client.localStorage.getItem("myListAddon:listsSubmenu"), "liked");
    assert.deepEqual(plain(client.get("appShellState.get('route')")), { tab: "lists", sub: "liked" });

    // Collections subnav under Lists (/lists/collections)
    assert.equal(client.call("appShellGo", "/lists/collections"), true);
    assert.deepEqual(pushedPaths(client), ["/lists/liked", "/lists/collections"]);
    assert.equal(client.localStorage.getItem("myListAddon:listsSubmenu"), "collections");
    assert.deepEqual(plain(client.get("appShellState.get('route')")), { tab: "lists", sub: "collections" });
  });

  it("turns a legacy tab click into a path, once", () => {
    const client = loadClient();
    forgetBootNavigation(client);
    client.call("switchTab", "settings");
    // One push, for the shell's route -- not the legacy replace that would
    // have rewritten the address to "/".
    assert.deepEqual(pushedPaths(client), ["/settings"]);
    assert.deepEqual(client.historyCalls.filter((c) => c.kind === "replace"), []);
    assert.equal(client.localStorage.getItem("myListAddon:activeTab"), "settings");

    // And a sub-tab click, which is the Catalogs pills' own switcher.
    client.call("switchCatalogsSubmenu", "quickadd");
    assert.equal(pushedPaths(client).pop(), "/catalogs/quickadd");
    assert.equal(client.localStorage.getItem("myListAddon:catalogsSubmenu"), "quickadd");

    // A name that is not a shell view is left to the legacy path entirely.
    const before = client.historyCalls.length;
    client.call("switchTab", "list-details");
    assert.equal(client.historyCalls.length, before, "list-details must not route through the shell");
  });
});

describe("the shell's API client", () => {
  it("sends the session cookie, JSON, and no cache, and reads a JSON answer", async () => {
    const client = loadClient({
      routes: {
        "/api/me": async () => ({ status: 200, json: { ok: true, account: { username: "alice", displayName: "Alice" } } }),
      },
    });
    const res = await client.call("appShellApiFetch", "/api/me");
    assert.equal(res.ok, true);
    assert.equal(res.data.account.username, "alice");
    const sent = requestsTo(client, "/api/me")[0];
    assert.equal(sent.credentials, "same-origin");
    assert.equal(sent.cache, "no-store");
    assert.equal(sent.headers.Accept, "application/json");
  });

  it("maps a failure to a sentence, keeping the status", async () => {
    const client = loadClient({
      routes: {
        "/api/me": async () => ({ status: 401, json: { ok: false, error: "Authentication required." } }),
        "/api/save": async () => ({ status: 503, json: { ok: false, error: "Being updated." } }),
        "/api/explode": async () => ({ status: 500, json: "" }),
      },
    });
    const unauthorized = await client.call("appShellApiFetch", "/api/me");
    assert.equal(unauthorized.ok, false);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.signInRequired, true);
    assert.equal(unauthorized.error, "Authentication required.", "the server's own words win");

    const paused = await client.call("appShellApiFetch", "/api/save", { method: "POST", body: { entries: [] } });
    assert.equal(paused.status, 503);
    assert.equal(paused.error, "Being updated.");

    // No message from the server: the status is turned into one.
    const broke = await client.call("appShellApiFetch", "/api/explode");
    assert.equal(broke.status, 500);
    assert.match(broke.error, /our side/i);
  });

  it("never throws when the network is gone", async () => {
    const client = loadClient();
    const res = await client.call("appShellApiFetch", "/api/not-stubbed");
    assert.equal(res.ok, false);
    assert.equal(res.status, 0);
    assert.match(res.error, /offline/i);
  });

  it("sends the JSON content type on a mutation with no body too", async () => {
    // verifyCsrf (02_) refuses every POST, PUT, PATCH and DELETE that arrives
    // without this header -- body or not -- so a body-less DELETE that left it
    // off had signing out answered with 403. Asserted here as well as through
    // the settings screen, because this is the one place that sets it.
    const client = loadClient({
      routes: { "/api/session": async () => ({ status: 200, json: { ok: true } }) },
    });
    await client.call("appShellApiFetch", "/api/session", { method: "DELETE" });
    const sent = requestsTo(client, "/api/session")[0];
    assert.equal(sent.method, "DELETE");
    assert.equal(sent.headers["Content-Type"], "application/json");
    assert.equal(sent.body, null, "no body, but the header still goes");
  });

  it("sends a JSON content type with a JSON body, and none for a GET", async () => {
    const client = loadClient({
      routes: { "/api/lists": async () => ({ status: 200, json: { ok: true } }) },
    });
    await client.call("appShellApiFetch", "/api/lists", { method: "POST", body: { name: "Mine" } });
    const posted = requestsTo(client, "/api/lists")[0];
    assert.equal(posted.headers["Content-Type"], "application/json");
    assert.deepEqual(plain(posted.body), { name: "Mine" });
  });
});

describe("the shell's shared state", () => {
  it("notifies on a real change only", () => {
    const client = loadClient();
    const seen = [];
    const unsubscribe = client.call("appShellState.subscribe", (s) => seen.push(s.route));
    client.call("appShellState.set", { route: { tab: "lists", sub: "" } });
    client.call("appShellState.set", { route: { tab: "lists", sub: "" } });
    client.call("appShellState.set", { route: { tab: "lists", sub: "liked" } });
    assert.deepEqual(plain(seen), [{ tab: "lists", sub: "" }, { tab: "lists", sub: "liked" }]);
    unsubscribe();
    client.call("appShellState.set", { route: { tab: "search", sub: "" } });
    assert.equal(seen.length, 2, "unsubscribing must stop the notifications");
  });
});

describe("the shell's dialog", () => {
  it("resolves true on confirm and false when it is dismissed", async () => {
    const client = loadClient();
    const confirmed = client.call("appShellDialog", { title: "Delete this list?", message: "It cannot be undone.", confirmLabel: "Delete", cancelLabel: "Keep" });
    client.__byId.get("appShellDialogConfirm").__fire("click");
    assert.equal(await confirmed, true);

    const dismissed = client.call("appShellDialog", { title: "Delete this list?", confirmLabel: "Delete", cancelLabel: "Keep" });
    // Escape or a backdrop click closes it through closeModal; the promise must
    // not hang.
    client.call("closeModal");
    assert.equal(await dismissed, false);
  });
});

describe("collections subnav and website lists picker", () => {
  it("getAllWebsiteListsGrouped aggregates lists across the website into categories", () => {
    const client = loadClient();
    const grouped = client.call("getAllWebsiteListsGrouped");
    assert.ok(grouped && typeof grouped === "object");
    assert.ok(grouped["Curated Recommendations"]);
    assert.ok(grouped["Curated Recommendations"].some((item) => item.name.includes("Recommended Movies")));
    assert.ok(grouped["TMDB Official Charts"]);
    assert.ok(grouped["TMDB Official Charts"].some((item) => item.name.includes("Trending")));
    assert.ok(grouped["Trakt Official Charts"]);
    assert.ok(grouped["Streaming Top 10"]);
    assert.ok(grouped["Genre Catalogs"]);
  });

  it("populateCollectionListPicker populates every website list into optgroups", () => {
    const client = loadClient();
    client.call("populateCollectionListPicker");
    const sel = client.__byId.get("createCollectionListPicker");
    assert.ok(sel);
    assert.ok(sel.innerHTML.includes("Curated Recommendations"));
    assert.ok(sel.innerHTML.includes("TMDB Official Charts"));
    assert.ok(sel.innerHTML.includes("Streaming Top 10"));
    assert.ok(sel.innerHTML.includes("Genre Catalogs"));
  });

  it("loads, saves, and renders custom collection folders with lists", () => {
    const client = loadClient();
    const testCollections = [
      {
        id: "col_test_1",
        name: "Sci-Fi Favorites",
        description: "My personal sci-fi lists folder",
        lists: [
          { name: "Cyberpunk Gems", url: "https://trakt.tv/users/test/lists/cyberpunk", type: "movie" },
          { name: "Space Operas", url: "https://trakt.tv/users/test/lists/space", type: "movie" }
        ]
      }
    ];

    client.call("saveCustomCollections", testCollections);
    const loaded = client.call("loadCustomCollections");
    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0].name, "Sci-Fi Favorites");
    assert.strictEqual(loaded[0].lists.length, 2);

    client.call("renderCustomCollections");
    const box = client.__byId.get("myCustomCollectionsResult");
    assert.ok(box);
    assert.ok(box.innerHTML.includes("Sci-Fi Favorites"));
    assert.ok(box.innerHTML.includes("2 lists"));
    assert.ok(box.innerHTML.includes("+ Add to Catalogs"));
    assert.ok(box.innerHTML.includes("Cyberpunk Gems"));
  });

  it("builds official Nuvio collections payload matching docs schema", () => {
    const client = loadClient();
    const testCollections = [
      {
        id: "folder-sci-fi",
        name: "Sci-Fi & Cyberpunk",
        description: "Best of sci-fi",
        tileShape: "LANDSCAPE",
        hideTitle: true,
        coverImageUrl: "https://example.com/cover.jpg",
        lists: [
          { name: "Cyberpunk", url: "https://trakt.tv/users/test/lists/cyberpunk", type: "movie" },
          { name: "Sci-Fi Shows", url: "https://trakt.tv/users/test/lists/shows", type: "series" }
        ]
      }
    ];

    const payload = client.call("buildNuvioCollectionsPayload", testCollections);
    assert.ok(Array.isArray(payload));
    assert.strictEqual(payload.length, 1);
    const col = payload[0];
    assert.strictEqual(col.id, "my-lists-collections");
    assert.strictEqual(col.title, "My Lists Collections");
    assert.strictEqual(col.viewMode, "FOLLOW_LAYOUT");
    assert.ok(Array.isArray(col.folders));
    assert.strictEqual(col.folders.length, 1);
    const f = col.folders[0];
    assert.strictEqual(f.id, "folder-sci-fi");
    assert.strictEqual(f.title, "Sci-Fi & Cyberpunk");
    assert.strictEqual(f.tileShape, "LANDSCAPE");
    assert.strictEqual(f.hideTitle, true);
    assert.strictEqual(f.coverImageUrl, "https://example.com/cover.jpg");
    assert.strictEqual(f.catalogSources.length, 2);
    assert.strictEqual(f.catalogSources[0].addonId, "app.my-list");
    assert.strictEqual(f.catalogSources[0].type, "movie");
    assert.strictEqual(f.catalogSources[1].type, "series");
  });

  it("parses Nuvio collections.json files into custom collection folders", () => {
    const client = loadClient();
    const nuvioJson = JSON.stringify([
      {
        id: "col-nuvio",
        title: "Community Layout",
        folders: [
          {
            id: "folder-marvel",
            title: "Marvel Cinematic Universe",
            tileShape: "LANDSCAPE",
            hideTitle: false,
            coverImageUrl: "https://image.tmdb.org/t/p/w500/mcu.jpg",
            catalogSources: [
              { addonId: "app.my-list", catalogId: "MCU Movies", type: "movie" }
            ]
          }
        ]
      }
    ]);

    const parsed = client.call("parseNuvioCollectionsJson", nuvioJson);
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].id, "folder-marvel");
    assert.strictEqual(parsed[0].name, "Marvel Cinematic Universe");
    assert.strictEqual(parsed[0].tileShape, "LANDSCAPE");
    assert.strictEqual(parsed[0].coverImageUrl, "https://image.tmdb.org/t/p/w500/mcu.jpg");
    assert.strictEqual(parsed[0].lists.length, 1);
    assert.strictEqual(parsed[0].lists[0].name, "MCU Movies");
  });

  it("provides 10 premade collections with corresponding Streaming Top 10, Catalogs, and Kids", () => {
    const client = loadClient();
    const premade = client.call("getPremadeCollections");
    assert.ok(Array.isArray(premade));
    assert.strictEqual(premade.length, 10);

    const names = premade.map((c) => c.name);
    assert.deepEqual(plain(names), [
      "Apple TV+",
      "Disney+",
      "HBO Max",
      "Hulu",
      "Netflix",
      "Netflix Kids",
      "Paramount+",
      "Prime Video",
      "Peacock",
      "Kids"
    ]);

    // Check Apple TV+ has Top 10 and Catalogs
    const apple = premade.find((c) => c.name === "Apple TV+");
    assert.ok(apple.lists.some((l) => l.name.includes("Top 10")));
    assert.ok(apple.lists.some((l) => l.url.includes("tmdb:chart:appletv")));

    // Check Netflix has Top 10 and Catalogs
    const netflix = premade.find((c) => c.name === "Netflix");
    assert.ok(netflix.lists.some((l) => l.name.includes("Top 10")));
    assert.ok(netflix.lists.some((l) => l.url.includes("tmdb:chart:netflix")));

    // Check Kids collection has Rated G, PG, PG-13, and Netflix Kids
    const kids = premade.find((c) => c.name === "Kids");
    assert.ok(kids.lists.some((l) => l.url === "tmdb:kids:g"));
    assert.ok(kids.lists.some((l) => l.url === "tmdb:kids:pg"));
    assert.ok(kids.lists.some((l) => l.url === "tmdb:kids:pg13"));
    assert.ok(kids.lists.some((l) => l.url === "tmdb:chart:netflixkids"));

    // Verify user-specified cover images
    assert.strictEqual(netflix.coverImageUrl, "https://m.media-amazon.com/images/I/616QXs8yg0L.png");
    assert.strictEqual(apple.coverImageUrl, "https://i.ytimg.com/vi/6sX_BfDnyrg/maxresdefault.jpg");
    assert.strictEqual(premade.find((c) => c.name === "Disney+").coverImageUrl, "https://static-www.adweek.com/wp-content/uploads/2024/03/disney-logo.jpeg?w=1200");
    assert.strictEqual(premade.find((c) => c.name === "HBO Max").coverImageUrl, "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTRInZVxLCd8CpYk_A80vU10wjypKNN_b1JUmTdhDj19ZlVJ2Ecz3nauXpN&s=10");
    assert.strictEqual(premade.find((c) => c.name === "Hulu").coverImageUrl, "https://www.thisishulu.com/app/uploads/2023/10/logo-gradient-3up.svg");
    assert.strictEqual(premade.find((c) => c.name === "Netflix Kids").coverImageUrl, "https://static1.squarespace.com/static/545ad6c5e4b09bbf6a29c5ee/t/5e69c67b1ce5f056432139df/1583990409924/Netflix.jpg?format=1500w");
    assert.strictEqual(premade.find((c) => c.name === "Paramount+").coverImageUrl, "https://cdn.mos.cms.futurecdn.net/UFo74BuGo7FYxhAE3DrWUP.jpg");
    assert.strictEqual(premade.find((c) => c.name === "Prime Video").coverImageUrl, "https://oyster.ignimgs.com/mediawiki/apis.ign.com/prime-video/3/3b/Primevideo-seo-logo_s586.png");
    assert.strictEqual(premade.find((c) => c.name === "Peacock").coverImageUrl, "https://www.newscaststudio.com/wp-content/uploads/2026/05/original-peacock-logo.jpg");
    assert.strictEqual(kids.coverImageUrl, "https://t3.ftcdn.net/jpg/01/83/26/74/360_F_183267411_05WWsOOcByAaAjnfzklSLS530axmLTJB.jpg");

    // Default loadCustomCollections initializes with premade collections
    client.localStorage.removeItem("myListAddon:customCollections");
    const loaded = client.call("loadCustomCollections");
    assert.strictEqual(loaded.length, 10);
  });

  it("renders collection folders with poster preview slots inside expanded lists", () => {
    const client = loadClient();
    const box = client.document.getElementById("myCustomCollectionsResult");
    const premadeBox = client.document.getElementById("premadeCollectionsResult");
    assert.ok(box, "myCustomCollectionsResult exists in DOM");
    assert.ok(premadeBox, "premadeCollectionsResult exists in DOM");

    // Render collections view
    client.call("renderCollectionsView");

    // Expand first collection
    const loaded = client.call("loadCustomCollections");
    assert.ok(loaded.length > 0);
    client.call("toggleCustomCollectionFolder", loaded[0].id);

    // Verify poster preview slot rendered in expanded folder
    assert.ok(box.innerHTML.includes("Lists inside this folder:"), "expanded custom folder shows lists section");
    assert.ok(box.innerHTML.includes("poster-preview-slot"), "lists inside expanded custom folder render poster-preview-slot");

    // Expand premade folder and check poster slots
    client.call("togglePremadeFolder", "col_netflix");
    assert.ok(premadeBox.innerHTML.includes("Lists inside this folder:"), "expanded premade folder shows lists section");
    assert.ok(premadeBox.innerHTML.includes("poster-preview-slot"), "premade expanded folder renders poster-preview-slot");
  });

  it("addPremadeToCustomCollections and addAllPremadeCollections add premade collections to custom folders", () => {
    const client = loadClient();
    // Start with empty custom collections
    client.localStorage.setItem("myListAddon:customCollections", "[]");
    assert.strictEqual(client.call("loadCustomCollections").length, 0);

    // Add single premade collection
    client.call("addPremadeToCustomCollections", "col_netflix");
    let current = client.call("loadCustomCollections");
    assert.strictEqual(current.length, 1);
    assert.strictEqual(current[0].name, "Netflix");

    // Add all premade collections
    client.call("addAllPremadeCollections");
    current = client.call("loadCustomCollections");
    assert.strictEqual(current.length, 10);
  });

  it("mergeNuvioCollections preserves existing Nuvio collections when pushing new folders", () => {
    const client = loadClient();
    const existingNuvio = [
      {
        id: "existing-nuvio-col",
        title: "My Nuvio Home",
        folders: [
          { id: "folder-anime", title: "Anime Hits", tileShape: "POSTER", catalogSources: [] },
          { id: "folder-horror", title: "Spooky Nights", tileShape: "LANDSCAPE", catalogSources: [] }
        ]
      }
    ];

    const incomingPush = [
      {
        id: "my-lists-collections",
        title: "My Lists Collections",
        folders: [
          { id: "folder-netflix", title: "Netflix", tileShape: "LANDSCAPE", catalogSources: [{ addonId: "app.my-list", catalogId: "tmdb-chart-netflix" }] }
        ]
      }
    ];

    const merged = client.call("mergeNuvioCollections", existingNuvio, incomingPush);
    assert.ok(Array.isArray(merged));
    assert.strictEqual(merged.length, 2, "Creates a dedicated collection for My Lists Addon instead of merging into user's existing collection");
    const existingCol = merged.find((c) => c.id === "existing-nuvio-col");
    assert.ok(existingCol, "Existing Nuvio collection is preserved untouched");
    assert.strictEqual(existingCol.folders.length, 2);
    const myListsCol = merged.find((c) => c.id === "my-lists-collections");
    assert.ok(myListsCol, "My Lists Collections is created as its own collection");
    assert.strictEqual(myListsCol.folders.length, 1);
    assert.strictEqual(myListsCol.folders[0].title, "Netflix");
  });

  it("mergeNuvioCollections unwraps RPC responses and preserves sequential pushes", () => {
    const client = loadClient();

    // 1. First push: Apple TV+ is pushed to an empty profile
    const applePush = [
      {
        id: "my-lists-collections",
        title: "My Lists Collections",
        viewMode: "TABBED_GRID",
        folders: [
          { id: "col_appletv", title: "Apple TV+", tileShape: "LANDSCAPE", catalogSources: [{ addonId: "app.my-list", catalogId: "tmdb-chart-appletv" }] }
        ]
      }
    ];

    const afterApple = client.call("mergeNuvioCollections", [], applePush);
    assert.strictEqual(afterApple.length, 1);
    assert.strictEqual(afterApple[0].folders.length, 1);
    assert.strictEqual(afterApple[0].folders[0].title, "Apple TV+");

    // 2. Nuvio returns { p_profile_id: 1, p_collections_json: [ ... ] } on sync_pull_collections
    const nuvioRpcExisting = {
      p_profile_id: 1,
      p_collections_json: afterApple
    };

    // 3. Second push: Disney+ is pushed
    const disneyPush = [
      {
        id: "my-lists-collections",
        title: "My Lists Collections",
        viewMode: "TABBED_GRID",
        folders: [
          { id: "col_disney", title: "Disney+", tileShape: "LANDSCAPE", catalogSources: [{ addonId: "app.my-list", catalogId: "tmdb-chart-disney" }] }
        ]
      }
    ];

    const afterDisney = client.call("mergeNuvioCollections", nuvioRpcExisting, disneyPush);
    assert.ok(Array.isArray(afterDisney));
    assert.strictEqual(afterDisney.length, 1, "Should remain 1 collection");
    assert.strictEqual(afterDisney[0].folders.length, 2, "Should contain both Apple TV+ and Disney+ folders");
    const folderTitles = afterDisney[0].folders.map((f) => f.title);
    assert.ok(folderTitles.includes("Apple TV+"), "Apple TV+ must be preserved");
    assert.ok(folderTitles.includes("Disney+"), "Disney+ must be present");

    // 4. Corrupted empty collection from prior bug is filtered out
    const withCorruptedEmpty = [
      { id: "corrupted_empty", folders: [] },
      ...afterDisney
    ];
    const cleaned = client.call("mergeNuvioCollections", withCorruptedEmpty, []);
    assert.strictEqual(cleaned.length, 1);
    assert.ok(cleaned[0].id === "my-lists-collections" || cleaned[0].id === "my-lists-streaming");

    // 5. Community "Streaming" collection with 12 folders is preserved 100% untouched
    const communityStreaming = [
      {
        id: "collection-a33b28eb-community",
        title: "Streaming",
        viewMode: "FOLLOW_LAYOUT",
        folders: [
          { id: "f_netflix", title: "Netflix", catalogSources: [{ addonId: "stremio-stream", catalogId: "netflix" }] },
          { id: "f_disney", title: "Disney+", catalogSources: [{ addonId: "stremio-stream", catalogId: "disney" }] },
          { id: "f_prime", title: "Prime Video", catalogSources: [{ addonId: "stremio-stream", catalogId: "prime" }] }
        ]
      }
    ];
    const myListsIncoming = [
      {
        id: "my-lists-collections",
        title: "My Lists Collections",
        folders: [
          { id: "f_appletv", title: "Apple TV+", catalogSources: [{ addonId: "app.my-list", catalogId: "tmdb-chart-appletv" }] }
        ]
      }
    ];
    const mergedWithCommunity = client.call("mergeNuvioCollections", communityStreaming, myListsIncoming);
    assert.strictEqual(mergedWithCommunity.length, 2, "Must contain exactly 2 separate collections");
    const preservedStreaming = mergedWithCommunity.find((c) => c.id === "collection-a33b28eb-community");
    assert.ok(preservedStreaming, "Community Streaming collection must be preserved");
    assert.strictEqual(preservedStreaming.folders.length, 3, "Community Streaming folders must NOT be altered");
    const preservedMyLists = mergedWithCommunity.find((c) => c.id === "my-lists-collections");
    assert.ok(preservedMyLists, "My Lists Collections must be present");
    assert.strictEqual(preservedMyLists.folders.length, 1, "My Lists Collections must contain only its own folder");
    assert.strictEqual(preservedMyLists.folders[0].title, "Apple TV+");
  });

  it("addAllCollectionsToStremio adds collection folders into the catalogs configuration for Stremio", () => {
    const client = loadClient();
    let rowAdded = null;
    client.set("addRow", (name, url, type, enabled, group) => {
      rowAdded = { name, url, type, enabled, group };
    });
    client.call("saveCustomCollections", [
      {
        id: "col_stream_stremio",
        name: "Popular Movies",
        lists: [
          { name: "Popular", url: "tmdb:chart:popular", type: "movie" }
        ]
      }
    ]);
    client.call("addAllCollectionsToStremio");
    assert.ok(rowAdded);
    assert.strictEqual(rowAdded.name, "Popular Movies");
    assert.strictEqual(rowAdded.url, "tmdb:chart:popular");
    assert.strictEqual(rowAdded.type, "movie");
  });

  it("determines the manifest URL to auto-install My Lists Addon in Nuvio", () => {
    const client = loadClient();
    const defaultUrl = client.call("getNuvioManifestUrl");
    assert.ok(defaultUrl.endsWith("/manifest.json"));

    // Check localStorage saved install link takes priority
    client.localStorage.setItem("myListAddon:lastInstallUrl", "https://mylistsaddon.com/saved-cfg-123/manifest.json");
    const savedUrl = client.call("getNuvioManifestUrl");
    assert.strictEqual(savedUrl, "https://mylistsaddon.com/saved-cfg-123/manifest.json");
  });

  it("buildManifest includes premade collection catalogs so Nuvio discovers them", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const vm = await import("node:vm");
    const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const sandbox = { console, URL, URLSearchParams, atob, btoa, Uint8Array, TextDecoder, TextEncoder, Response, Headers, Request, crypto: globalThis.crypto };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    for (const f of ["00_constants.js", "02_http-and-creator-utils.js", "05_catalog-core.js", "07_source-fetchers-tmdb-simkl.js", "08_quickadd-chart-data.js"]) {
      const src = fs.readFileSync(path.join(repoRoot, f), "utf8");
      vm.runInContext(src, sandbox, { filename: f });
    }
    const manifest = sandbox.buildManifest([{ id: "custom1", type: "movie", enabled: true }], "https://mylistsaddon.com");
    assert.ok(manifest && Array.isArray(manifest.catalogs), "manifest.catalogs must be an array");
    const catalogIds = manifest.catalogs.map((c) => c.id);
    // Verifies key collection catalogs exist in manifest so Nuvio does not display 'Addon not found: app.my-list'
    assert.ok(catalogIds.includes("tmdb-chart-hbomax"), "HBO Max catalog must be in manifest");
    assert.ok(catalogIds.includes("tmdb-chart-netflix"), "Netflix catalog must be in manifest");
    assert.ok(catalogIds.includes("tmdb-chart-disney"), "Disney+ catalog must be in manifest");
    assert.ok(catalogIds.includes("tmdb-chart-appletv"), "Apple TV+ catalog must be in manifest");
    assert.ok(catalogIds.includes("https-mdblist-com-lists-harmes7-hbo-max-top-10-movies-m77r6mc20q"), "HBO Max Top 10 must be in manifest");
  });

  it("addNewNuvioCollection creates a separate collection leaving existing collections untouched", () => {
    const client = loadClient();
    const existing = [
      {
        id: "collection-a33b28eb-community",
        title: "Streaming",
        folders: [
          { id: "f_netflix", title: "Netflix", catalogSources: [{ name: "Netflix", type: "movie", catalogId: "streaming_netflix" }] }
        ]
      },
      {
        id: "8467ec44-2731-4b0f-a8b5-48e42d215150",
        title: "8467ec44-2731-4b0f-a8b5-48e42d215150",
        folders: [],
        catalogSources: []
      }
    ];

    const incoming = [
      {
        id: "col_appletv",
        name: "Apple TV+",
        folders: [
          {
            id: "f_appletv",
            title: "Apple TV+",
            catalogSources: [
              { name: "Apple TV+ Top 10 (Movies)", catalogId: "https-mdblist-apple", type: "movie" }
            ]
          }
        ]
      }
    ];

    const result = client.call("addNewNuvioCollection", existing, incoming, { collectionName: "Apple TV+" });
    assert.ok(Array.isArray(result));
    // Must contain 2 collections: Streaming (untouched) and Apple TV+ (new), discarding the empty stub 8467ec44
    assert.strictEqual(result.length, 2);

    const streaming = result.find((c) => c.id === "collection-a33b28eb-community");
    assert.ok(streaming, "Streaming collection must be kept intact");
    assert.strictEqual(streaming.title, "Streaming");
    assert.strictEqual(streaming.folders.length, 1);
    assert.strictEqual(streaming.folders[0].id, "f_netflix");

    const apple = result.find((c) => c.title === "Apple TV+");
    assert.ok(apple, "Apple TV+ must be added as a separate collection");
    assert.strictEqual(apple.folders.length, 1);
    // Verifies trailing (Movies) is stripped
    assert.strictEqual(apple.folders[0].catalogSources[0].name, "Apple TV+ Top 10");

    // Empty stub must be discarded
    const stub = result.find((c) => c.id === "8467ec44-2731-4b0f-a8b5-48e42d215150");
    assert.strictEqual(stub, undefined, "Empty stub 8467ec44 must be removed");
  });
});
