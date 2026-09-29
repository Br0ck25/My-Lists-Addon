import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadClient, requestsTo } from "./client-harness.mjs";

// The shell's Explore view (Phase 6, P6-5): somebody else's public lists in one
// place -- pick where to look, type, preview, and put one on your home screen.
// E2E scenario 8, plus the two things that could quietly go wrong: a source that
// cannot be searched the way the others are (MDBList), and a sort that only some
// sources can answer (Newest).
//
// These load the real shell page and drive the real functions.

const DIRECTORY = {
  ok: true,
  count: 2,
  total: 2,
  lists: [
    { name: "Best of 2026", slug: "best-2026", creator: "alice", type: "movie", itemCount: 300, likes: 4, updatedAt: 1000000000000, url: "https://example.com/lists/alice/best-2026", jsonUrl: "" },
    { name: "Quiet dramas", slug: "quiet", creator: "bob", type: "movie", itemCount: 40, likes: 90, updatedAt: 1700000000000, url: "https://example.com/lists/bob/quiet", jsonUrl: "" },
  ],
};

const SEARCHED = {
  ok: true,
  lists: [
    { name: "Horror vault", type: "movie", items: 120, likes: 7, creatorName: "carol", username: "carol", url: "https://example.com/lists/carol/horror", source: "My Lists Addon" },
  ],
};

const MDB_POPULAR = {
  ok: true,
  lists: [
    { name: "Netflix top 10", user: "mdblist", slug: "netflix", type: "movie", items: 10, likes: 500, url: "https://mdblist.com/lists/mdblist/netflix" },
    { name: "Horror classics", user: "curator", slug: "horror", type: "movie", items: 60, likes: 30, url: "https://mdblist.com/lists/curator/horror" },
  ],
};

const TRAKT_POPULAR = {
  ok: true,
  lists: [
    { name: "Trakt blockbusters", user: "dave", slug: "blockbusters", items: 80, likes: 200, contentType: "movie", url: "https://trakt.tv/users/dave/lists/blockbusters", source: "Trakt" },
  ],
};

const TRAKT_SEARCH = {
  ok: true,
  lists: [
    { name: "Horror on trakt", user: "erin", slug: "horror", items: 55, likes: 12, contentType: "series", url: "https://trakt.tv/users/erin/lists/horror", source: "Trakt" },
  ],
};

const TMDB_SEARCH = {
  ok: true,
  lists: [
    { name: "Horror collections", user: "TMDB Franchise", url: "https://www.themoviedb.org/collection/1", type: "movie", items: "Franchise", likes: 0, isCollection: true },
  ],
};

function exploreRoutes(overrides) {
  return Object.assign({
    "/lists/public.json": async () => ({ json: DIRECTORY }),
    "/api/search-published-lists": async () => ({ json: SEARCHED }),
    "/api/toplists": async () => ({ json: MDB_POPULAR }),
    "/api/trakt-popular-lists": async () => ({ json: TRAKT_POPULAR }),
    "/api/trakt-search": async () => ({ json: TRAKT_SEARCH }),
    "/api/tmdb-search-lists": async () => ({ json: TMDB_SEARCH }),
    "/api/preview": async () => ({
      json: { ok: true, count: 120, totalItems: 120, sample: [{ id: "tt1", name: "One", poster: "https://img/1.jpg", type: "movie" }] },
    }),
  }, overrides || {});
}

function loadExploreClient(overrides) {
  const client = loadClient({ newUi: true, routes: exploreRoutes(overrides) });
  const added = [];
  let onHome = false;
  client.set("isListAddedToConfig", () => onHome);
  client.set("addRow", (name, url, type, enabled, group) => {
    added.push({ name, url, type, enabled, group });
    onHome = true;
    return { name };
  });
  client.set("removeListFromConfig", () => { onHome = false; });
  client.set("renumber", () => {});
  client.added = added;
  client.homeOn = (value) => { onHome = value; };
  return client;
}

function explore(client) {
  return client.__byId.get("appShellExplore").innerHTML;
}

// Arrays built inside the bundle belong to another vm realm, so deepEqual
// against a host-side literal fails on identity -- compare plain JSON instead.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// Runs the view's own fetch and returns what it settled on.
async function load(client, source, query) {
  if (source) client.set("appShellExploreSource", source);
  client.set("appShellExploreQuery", query || "");
  return client.call("appShellExploreRun");
}

describe("the shell's Explore view", () => {
  it("renders the source chips, the sort chips and a search box, with no inline handlers", () => {
    const client = loadExploreClient();
    client.call("appShellRenderExplore", false);
    const markup = explore(client);
    for (const source of ["All sources", "My Lists community", "MDBList", "Trakt", "TMDB"]) {
      assert.ok(markup.includes(">" + source + "</button>"), source + " chip is missing");
    }
    for (const sort of ["Most liked", "Newest", "Most added"]) {
      assert.ok(markup.includes(">" + sort + "</button>"), sort + " chip is missing");
    }
    // Most added counts how many people put a list on a home screen, which the
    // next list service keeps -- so it is offered, explained, and disabled.
    assert.match(markup, /Most added<\/button>/);
    assert.match(markup, /data-app-shell-id="added" disabled/);
    assert.match(markup, /not switched on yet/);
    assert.ok(markup.includes('id="appShellExploreSearch"'));
    assert.equal(/on[a-z]+=/.test(markup), false, "the view must not add inline handlers");
  });

  it("does nothing at all on the old page", () => {
    const client = loadClient({ newUi: false, routes: exploreRoutes() });
    assert.equal(client.call("appShellRenderExplore", false), false);
    assert.equal(explore(client), "");
    // No container, no listener, and nothing fetched for it at boot either.
    assert.equal(client.call("appShellOpenExplore"), false);
    // Nothing was fetched for a view that is not there: the boot hook is
    // guarded on NEW_UI, not merely on the container.
    assert.equal(requestsTo(client, "/lists/public.json").length, 0);
    assert.equal(requestsTo(client, "/api/toplists").length, 0);
  });

  it("browses every source at once, best liked first", async () => {
    const client = loadExploreClient();
    const rows = await load(client, "all");
    // This site's directory, MDBList's and Trakt's popular lists, best liked
    // first: 500, 200, 90, 30, 4.
    assert.deepEqual(plain(rows).map((r) => r.likes), [500, 200, 90, 30, 4]);
    assert.deepEqual(plain(rows).map((r) => r.source), ["mdblist", "trakt", "mylists", "mdblist", "mylists"]);
    assert.match(explore(client), /5 lists/);
    // The date a source reports is carried through for the Newest order.
    assert.equal(rows[2].when, 1700000000000);
    assert.equal(rows[2].by, "bob");
  });

  it("sorts by newest for the lists that report when they changed", async () => {
    const client = loadExploreClient();
    await load(client, "all");
    await client.call("appShellExploreAction", "explore-sort", "new");
    const markup = explore(client);
    const order = [...markup.matchAll(/<strong>([^<]+)<\/strong>/g)].map((m) => m[1]);
    // The two My Lists community rows carry a date, so they come first, newest
    // first (2023 then 2001); the providers do not report one and keep their
    // place after them rather than being guessed at.
    assert.deepEqual(plain(order.slice(0, 2)), ["Quiet dramas", "Best of 2026"]);
    assert.equal(order.length, 5);
  });

  it("refuses a sort that is not switched on yet", async () => {
    const client = loadExploreClient();
    await load(client, "all");
    assert.equal(await client.call("appShellExploreAction", "explore-sort", "added"), false);
    assert.equal(client.get("appShellExploreSort"), "popular");
    // ...and the disabled chip cannot be pressed at all in a browser.
    assert.match(explore(client), /data-app-shell-id="added" disabled/);
  });

  it("narrows to one source, asking only that one", async () => {
    const client = loadExploreClient();
    client.requests.length = 0;
    const rows = await load(client, "mylists");
    assert.equal(rows.length, 2);
    assert.deepEqual(plain(rows).map((r) => r.source), ["mylists", "mylists"]);
    assert.equal(requestsTo(client, "/lists/public.json").length, 1);
    assert.equal(requestsTo(client, "/api/toplists").length, 0);
    assert.equal(requestsTo(client, "/api/trakt-popular-lists").length, 0);

    // A source with no directory to browse says so rather than showing nothing.
    const tmdb = await load(client, "tmdb");
    assert.deepEqual(plain(tmdb), []);
    assert.match(explore(client), /TMDB publishes no list directory to browse/);
  });

  it("searches the sources that have a search, and says how MDBList was matched", async () => {
    const client = loadExploreClient();
    const rows = await load(client, "all", "horror");
    const urls = plain(rows).map((r) => r.url).sort();
    assert.deepEqual(urls, [
      "https://example.com/lists/carol/horror",
      "https://mdblist.com/lists/curator/horror",
      "https://trakt.tv/users/erin/lists/horror",
      "https://www.themoviedb.org/collection/1",
    ]);
    // MDBList has no list search of its own: its results are the popular ones
    // matching the words, and the page says so instead of implying otherwise.
    assert.match(explore(client), /MDBList has no list search of its own/);
    const search = requestsTo(client, "/api/search-published-lists");
    assert.equal(search.length, 1);
    assert.match(search[0].url, /q=horror/);
    assert.equal(requestsTo(client, "/api/trakt-search").length, 1);
    assert.equal(requestsTo(client, "/api/tmdb-search-lists").length, 1);
    assert.match(explore(client), /matching &quot;horror&quot;|matching "horror"/);
  });

  it("passes the adult filter on to the TMDB search when it is on", async () => {
    const client = loadExploreClient();
    client.set("isAdultContentFilterEnabled", () => true);
    await load(client, "tmdb", "horror");
    assert.match(requestsTo(client, "/api/tmdb-search-lists")[0].url, /adultContentFilter=1/);
  });

  it("drops a slow answer that a newer search has already overtaken", async () => {
    let release = null;
    const client = loadExploreClient({
      "/api/search-published-lists": async () => {
        await new Promise((r) => { release = r; });
        return { json: SEARCHED };
      },
    });
    client.set("appShellExploreSource", "mylists");
    client.set("appShellExploreQuery", "horror");
    const slow = client.call("appShellExploreRun");
    // A second search goes out and lands first.
    client.set("appShellExploreQuery", "");
    client.set("appShellExploreSource", "mdblist");
    const quick = await client.call("appShellExploreRun");
    assert.deepEqual(plain(quick).map((r) => r.likes), [500, 30]);
    release();
    await slow;
    const markup = explore(client);
    assert.match(markup, /Netflix top 10/);
    assert.equal(markup.includes("Horror vault"), false, "the stale answer is dropped");
  });

  it("previews what is actually in a list, with the button to add it", async () => {
    const client = loadExploreClient();
    await load(client, "mylists");
    const data = await client.call("appShellExplorePreviewRow", 0);
    assert.equal(data.count, 120);
    assert.equal(client.get("appShellExplorePreview"), 0);
    const asked = requestsTo(client, "/api/preview");
    assert.equal(asked.length, 1);
    assert.equal(asked[0].method, "POST");
    assert.equal(asked[0].body.sample, 6);
    assert.equal(asked[0].body.url, "https://example.com/lists/bob/quiet");
    // The preview shows the posters, the count, and its own add button.
    const area = client.__byId.get("appShellExplorePreviewArea-0").innerHTML;
    assert.ok(area.includes("https://img/1.jpg"));
    assert.match(area, /First 1 of 120 titles/);
    assert.match(area, /data-app-shell-action="explore-add"/);

    // Pressing Preview again closes it.
    assert.equal(await client.call("appShellExplorePreviewRow", 0), null);
    assert.equal(client.get("appShellExplorePreview"), -1);
  });

  it("reports a list that cannot be read instead of an empty preview", async () => {
    const client = loadExploreClient({
      "/api/preview": async () => ({ status: 400, json: { ok: false, error: "That URL isn't a supported list source." } }),
    });
    await load(client, "mylists");
    const data = await client.call("appShellExplorePreviewRow", 0);
    assert.match(data.error, /supported list source/);
    assert.match(client.__byId.get("appShellExplorePreviewArea-0").innerHTML, /supported list source/);
  });

  it("adds a found list to the home screen, and takes it off again", async () => {
    const client = loadExploreClient();
    await load(client, "mylists");
    // "Quiet dramas" is the best-liked row of the directory, so it is first.
    assert.equal(await client.call("appShellExploreAction", "explore-add", "0"), true);
    assert.deepEqual(plain(client.added), [{
      name: "Quiet dramas",
      url: "https://example.com/lists/bob/quiet",
      type: "movie",
      enabled: true,
      group: "Custom",
    }]);
    assert.match(explore(client), /On your home screen/);

    assert.equal(await client.call("appShellExploreAction", "explore-add", "0"), true);
    assert.equal(client.added.length, 1, "removing adds nothing");
    assert.match(explore(client), /Add to home screen/);
  });

  it("gives a mixed list the two rows the legacy add gives it", async () => {
    const client = loadExploreClient({
      "/api/trakt-popular-lists": async () => ({ json: { ok: true, lists: [{ name: "Everything", user: "dave", slug: "all", items: 30, likes: 5, contentType: "unknown", url: "https://trakt.tv/users/dave/lists/all" }] } }),
    });
    await load(client, "trakt");
    await client.call("appShellExploreAction", "explore-add", "0");
    assert.deepEqual(plain(client.added).map((r) => r.name), ["Everything (Movies)", "Everything (Shows)"]);
    assert.deepEqual(plain(client.added).map((r) => r.type), ["movie", "series"]);
  });
});
