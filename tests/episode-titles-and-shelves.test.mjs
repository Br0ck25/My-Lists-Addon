import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadClient, fireListeners } from "./client-harness.mjs";

describe("Episode titles and shelf display names", () => {
  it("isGenericEpisodeTitle identifies generic placeholders correctly", () => {
    const client = loadClient();
    const isGeneric = client.get("isGenericEpisodeTitle");
    assert.equal(typeof isGeneric, "function", "isGenericEpisodeTitle is defined on client");

    // Generic titles
    assert.equal(isGeneric("Episode 6", 6), true);
    assert.equal(isGeneric("Episode 11", 11), true);
    assert.equal(isGeneric("Season Premiere", 1), true);
    assert.equal(isGeneric("Season Finale", 10), true);
    assert.equal(isGeneric("Season 4", 1), true);
    assert.equal(isGeneric("Season 3, Episode 6", 6), true);
    assert.equal(isGeneric("S03E06", 6), true);
    assert.equal(isGeneric("TBA", 1), true);
    assert.equal(isGeneric("TBD", 1), true);
    assert.equal(isGeneric("Untitled", 1), true);
    assert.equal(isGeneric("Unknown", 1), true);
    assert.equal(isGeneric("N/A", 1), true);
    assert.equal(isGeneric("n/a", 1), true);
    assert.equal(isGeneric("", 1), true);
    assert.equal(isGeneric(null, 1), true);

    // Real episode titles
    assert.equal(isGeneric("Sugar Land", 6), false);
    assert.equal(isGeneric("A Pretty Nasty One", 11), false);
    assert.equal(isGeneric("The Pyramid", 7), false);
    assert.equal(isGeneric("W.W.D.D.", 1), false);
    assert.equal(isGeneric("Omission", 2), false);
    assert.equal(isGeneric("Beware the Old Soldier", 1), false);
  });

  it("formatWatchItemLabel uses real episode title as subtitle when available", () => {
    const client = loadClient();
    const formatLabel = client.get("formatWatchItemLabel");

    // When item has real episodeTitle
    const realItem = {
      showTitle: "Lioness",
      seasonNum: 3,
      episodeNum: 6,
      name: "Sugar Land",
      episodeTitle: "Sugar Land",
    };
    const label1 = formatLabel(realItem);
    assert.equal(label1.title, "Lioness S03E06");
    assert.equal(label1.subtitle, "Sugar Land");

    // When item has generic "Episode 6" and no real title, falls back to Episode 6
    const genericItem = {
      showTitle: "Lioness",
      seasonNum: 3,
      episodeNum: 6,
      name: "Episode 6",
      episodeTitle: "Episode 6",
    };
    const label2 = formatLabel(genericItem);
    assert.equal(label2.title, "Lioness S03E06");
    assert.equal(label2.subtitle, "Episode 6");

    // When item is Season Premiere with no real title yet
    const premiereItem = {
      showTitle: "Silo",
      seasonNum: 4,
      episodeNum: 1,
      name: "Season Premiere",
      isSeasonPremiere: true,
    };
    const label3 = formatLabel(premiereItem);
    assert.equal(label3.title, "Silo S04E01");
    assert.equal(label3.subtitle, "Season Premiere");
  });

  it("_liveFallbackMeta assigns showTitle as name for series items", () => {
    const client = loadClient();
    const _liveFallbackMeta = client.get("_liveFallbackMeta");

    const cwItem = {
      id: "tt13111078:3:6",
      showId: "tt13111078",
      type: "episode",
      showTitle: "Lioness",
      name: "Episode 6",
      episodeTitle: "Sugar Land",
      seasonNum: 3,
      episodeNum: 6,
      poster: "https://example.com/poster.jpg",
    };

    const meta = _liveFallbackMeta(cwItem, "series");
    assert.equal(meta.name, "Lioness", "name should be showTitle, not episode name");
    assert.equal(meta.showTitle, "Lioness");
  });

  it("livePreviewPosterHtml renders item showTitle on catalog shelf cards and suppresses subtitle", () => {
    const client = loadClient();
    const livePreviewPosterHtml = client.get("livePreviewPosterHtml");

    // Item rendered on a catalog live preview shelf
    const shelfItem = {
      id: "tt13111078",
      showId: "tt13111078",
      showTitle: "Lioness",
      name: "Episode 6",
      listUrl: "autotrack:continue-watching:series:testuser",
      listName: "Continue Watching (Shows) - Series",
      isLivePreviewShelf: true,
      seasonNum: 3,
      episodeNum: 6,
    };

    const html = livePreviewPosterHtml(shelfItem);
    assert.ok(html.includes('<div class="live-preview-poster-name">Lioness</div>'), "renders Lioness as title");
    assert.ok(!html.includes('<div class="live-preview-poster-name">Episode 6</div>'), "does not render Episode 6 as title");
    assert.ok(!html.includes('live-preview-poster-subtitle'), "suppresses subtitle on catalog shelf");

    // Item rendered on See All details page (isLivePreviewShelf is false)
    const detailsItem = {
      id: "tt13111078",
      showId: "tt13111078",
      showTitle: "Lioness",
      name: "Lioness S03E06",
      subtitle: "Sugar Land",
      listUrl: "autotrack:continue-watching:series:testuser",
      listName: "Continue Watching",
      isLivePreviewShelf: false,
      seasonNum: 3,
      episodeNum: 6,
    };

    const detailsHtml = livePreviewPosterHtml(detailsItem);
    assert.ok(detailsHtml.includes('<div class="live-preview-poster-name">Lioness S03E06</div>'), "renders episode title on details page");
    assert.ok(detailsHtml.includes('<span>Sugar Land</span>') || detailsHtml.includes('Sugar Land'), "renders Sugar Land subtitle on details page");
  });

  it("restoreListScroll calls scrollTo with target scroll position", () => {
    const client = loadClient();
    const restoreListScroll = client.get("restoreListScroll");
    assert.equal(typeof restoreListScroll, "function", "restoreListScroll is defined");

    let scrolledTo = null;
    client.window.scrollTo = (opts) => {
      scrolledTo = opts;
    };

    restoreListScroll(1250);
    assert.equal(scrolledTo.top, 1250);
    assert.equal(scrolledTo.behavior, "instant");
  });

  it("openItemDetailsModal preserves _listScrollY when opened from list-details", async () => {
    const client = loadClient();
    const switchTab = client.get("switchTab");
    const openItemDetailsModal = client.get("openItemDetailsModal");

    switchTab("list-details");
    client.window.scrollY = 850;

    // Mock fetch for item details so it doesn't fail
    client.window.fetch = async () => ({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({ ok: true, details: { id: "tt12345", title: "Test Title" } }),
    });

    await openItemDetailsModal("tt12345", "movie");

    assert.equal(client.window._listScrollY, 850, "records list scroll position");
    assert.equal(client.window._previousTab, "list-details", "records previous tab as list-details");
  });

  it("popstate and navigateBackFromDetail restore list scroll position on returning from item-details", async () => {
    const client = loadClient();
    const switchTab = client.get("switchTab");
    const openItemDetailsModal = client.get("openItemDetailsModal");
    const navigateBackFromDetail = client.get("navigateBackFromDetail");

    switchTab("list-details");
    client.window.scrollY = 1420;

    client.window.fetch = async () => ({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({ ok: true, details: { id: "tt99999", title: "Detail Title" } }),
    });

    await openItemDetailsModal("tt99999", "movie");

    let restoredScroll = null;
    client.window.scrollTo = (opts) => {
      restoredScroll = opts;
    };

    navigateBackFromDetail();

    assert.equal(client.window._currentTab, "list-details", "switched back to list-details tab");
    assert.equal(restoredScroll.top, 1420, "restored exact scroll top position");
    assert.equal(restoredScroll.behavior, "instant");
  });

  it("popstate restores list scroll position and switches to list-details when detailGrid has items", () => {
    const client = loadClient();
    const switchTab = client.get("switchTab");

    // Put a card into detailGrid to simulate loaded list
    const gridEl = client.document.getElementById("detailGrid");
    gridEl.children = [{ className: "live-preview-poster-card" }];
    client.window._currentListDetailsKey = "Popular::movie::trakt:chart:popular";

    // Switch away to item-details
    switchTab("item-details");
    assert.equal(client.window._currentTab, "item-details");

    let restoredScroll = null;
    client.window.scrollTo = (opts) => {
      restoredScroll = opts;
    };

    // Dispatch popstate back to list
    fireListeners(client, {
      type: "popstate",
      bubbles: true,
      state: {
        view: "list",
        name: "Popular",
        type: "movie",
        listUrl: "trakt:chart:popular",
        listScrollY: 1750,
      },
    });

    assert.equal(client.window._currentTab, "list-details", "restored list-details tab");
    assert.equal(restoredScroll.top, 1750, "restored scroll to 1750");
    assert.equal(restoredScroll.behavior, "instant");
    assert.equal(gridEl.children.length, 1, "did not wipe detailGrid");
  });

  it("preserves scroll and restores position when navigating back from See All to discover, catalogs, search, and lists", async () => {
    const pagesToTest = [
      { tab: "discover", scrollY: 1850, submenuProp: "_previousDiscoverFilter", submenuVal: "movie" },
      { tab: "catalogs", scrollY: 2200, submenuProp: "_previousCatalogsSubmenu", submenuVal: "all" },
      { tab: "search", scrollY: 1400 },
      { tab: "lists", scrollY: 950, submenuProp: "_previousListsSubmenu", submenuVal: "my-lists" },
    ];

    for (const testCase of pagesToTest) {
      const client = loadClient();
      const switchTab = client.get("switchTab");
      const openListDetailsPage = client.get("openListDetailsPage");
      const navigateBackFromDetail = client.get("navigateBackFromDetail");

      // Switch to the target page
      switchTab(testCase.tab);
      assert.equal(client.window._currentTab, testCase.tab);

      // Simulate user scrolling down the page
      client.window.scrollY = testCase.scrollY;

      // Click "See All" on a list
      await openListDetailsPage("Trending Movies", "movie", "tmdb:chart:trending");
      assert.equal(client.window._currentTab, "list-details", "opened list-details page");
      assert.equal(client.window._previousScrollY, testCase.scrollY, "recorded previousScrollY");
      assert.equal(client.window._tabScrollY[testCase.tab], testCase.scrollY, "recorded tabScrollY");

      let restoredScroll = null;
      client.window.scrollTo = (opts) => {
        restoredScroll = opts;
      };

      // Navigate back via UI Back button
      navigateBackFromDetail();

      assert.equal(client.window._currentTab, testCase.tab, `navigated back to ${testCase.tab}`);
      assert.ok(restoredScroll, `called scrollTo on returning to ${testCase.tab}`);
      assert.equal(restoredScroll.top, testCase.scrollY, `restored exact scroll position ${testCase.scrollY} on ${testCase.tab}`);
      assert.equal(restoredScroll.behavior, "instant");
    }
  });

  it("popstate restores previous page scroll position on browser back from See All", async () => {
    const client = loadClient();
    const switchTab = client.get("switchTab");
    const openListDetailsPage = client.get("openListDetailsPage");

    // Start on Discover at scroll 1600
    switchTab("discover");
    client.window.scrollY = 1600;

    await openListDetailsPage("Popular Shows", "series", "trakt:chart:popular");
    assert.equal(client.window._currentTab, "list-details");

    let restoredScroll = null;
    client.window.scrollTo = (opts) => {
      restoredScroll = opts;
    };

    // Simulate browser back popping to discover with saved scroll state
    client.window.location.hash = "";
    client.window.location.pathname = "/discover";
    fireListeners(client, {
      type: "popstate",
      bubbles: true,
      state: {
        scrollY: 1600,
        tab: "discover",
      },
    });

    assert.equal(client.window._currentTab, "discover", "switched back to discover on popstate");
    assert.ok(restoredScroll, "called scrollTo on popstate");
    assert.equal(restoredScroll.top, 1600, "restored scroll to 1600");
  });
});

