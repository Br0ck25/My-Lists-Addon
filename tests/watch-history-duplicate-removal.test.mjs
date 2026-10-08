import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { loadClient } = await import("./client-harness.mjs");

function withWatchHistory(items) {
  return {
    "myListAddon:localCustomLists": JSON.stringify({
      "watch-history": {
        slug: "watch-history",
        name: "Watch History",
        type: "mixed",
        items,
        updatedAt: 1,
      },
    }),
  };
}

describe("Watch History duplicate removal", () => {
  it("removes only the targeted instance when an episode was watched twice with distinct timestamps", () => {
    const play1 = {
      id: "tt0903747:1:1",
      showId: "tt0903747",
      showTitle: "Breaking Bad",
      type: "episode",
      seasonNum: 1,
      episodeNum: 1,
      watchedAt: 1000,
    };
    const play2 = {
      id: "tt0903747:1:1",
      showId: "tt0903747",
      showTitle: "Breaking Bad",
      type: "episode",
      seasonNum: 1,
      episodeNum: 1,
      watchedAt: 2000,
    };
    const c = loadClient({ storage: withWatchHistory([play2, play1]) });

    // Initialize raw items and watched index
    c.set("window._rawWatchHistoryItems", [play2, play1]);
    c.call("rebuildWatchedIndex", [play2, play1]);
    assert.ok(c.get("window._watchedItemIds.has('tt0903747:1:1')"));

    // Remove only the second watch (watchedAt: 2000)
    c.call("removeWatchHistoryItemDirect", "tt0903747:1:1", null, 2000);

    const remaining = c.call("loadLocalCustomLists")["watch-history"].items;
    assert.equal(remaining.length, 1, "exactly one instance must remain in storage");
    assert.equal(remaining[0].watchedAt, 1000, "the earlier watch instance must be preserved");

    const rawRemaining = c.get("window._rawWatchHistoryItems");
    assert.equal(rawRemaining.length, 1, "exactly one instance must remain in window._rawWatchHistoryItems");
    assert.equal(rawRemaining[0].watchedAt, 1000);

    // Episode should still be considered watched because play1 is still in history
    assert.ok(c.get("window._watchedItemIds.has('tt0903747:1:1')"), "item must remain in _watchedItemIds while another play exists");
  });

  it("removes only one instance when watchedAt is omitted on duplicate plays", () => {
    const play1 = {
      id: "tt0903747:1:1",
      showId: "tt0903747",
      type: "episode",
      seasonNum: 1,
      episodeNum: 1,
      watchedAt: 1000,
    };
    const play2 = {
      id: "tt0903747:1:1",
      showId: "tt0903747",
      type: "episode",
      seasonNum: 1,
      episodeNum: 1,
      watchedAt: 2000,
    };
    const c = loadClient({ storage: withWatchHistory([play2, play1]) });
    c.set("window._rawWatchHistoryItems", [play2, play1]);

    // Call without watchedAt
    c.call("removeWatchHistoryItemDirect", "tt0903747:1:1", null);

    const remaining = c.call("loadLocalCustomLists")["watch-history"].items;
    assert.equal(remaining.length, 1, "must remove only one instance even when watchedAt is not supplied");
  });

  it("clears _watchedItemIds when the last remaining instance of an episode is removed", () => {
    const play1 = {
      id: "tt0903747:1:1",
      showId: "tt0903747",
      type: "episode",
      seasonNum: 1,
      episodeNum: 1,
      watchedAt: 1000,
    };
    const c = loadClient({ storage: withWatchHistory([play1]) });
    c.set("window._rawWatchHistoryItems", [play1]);
    c.call("rebuildWatchedIndex", [play1]);

    c.call("removeWatchHistoryItemDirect", "tt0903747:1:1", null, 1000);

    const remaining = c.call("loadLocalCustomLists")["watch-history"].items;
    assert.equal(remaining.length, 0);
    assert.ok(!c.get("window._watchedItemIds.has('tt0903747:1:1')"), "must be removed from _watchedItemIds once no plays remain");
  });

  it("removes all episodes for a show when isGrouped is true", () => {
    const ep1 = { id: "tt0903747:1:1", showId: "tt0903747", type: "episode", seasonNum: 1, episodeNum: 1, watchedAt: 1000 };
    const ep2 = { id: "tt0903747:1:2", showId: "tt0903747", type: "episode", seasonNum: 1, episodeNum: 2, watchedAt: 2000 };
    const other = { id: "tt1234567", type: "movie", watchedAt: 3000 };
    const c = loadClient({ storage: withWatchHistory([ep1, ep2, other]) });
    c.set("window._rawWatchHistoryItems", [ep1, ep2, other]);

    c.call("removeWatchHistoryItemDirect", "tt0903747", null, null, true);

    const remaining = c.call("loadLocalCustomLists")["watch-history"].items;
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, "tt1234567");
  });

  it("removes only the targeted instance through removeListItemFromDetails", () => {
    const play1 = { id: "tt0903747:1:1", showId: "tt0903747", type: "episode", seasonNum: 1, episodeNum: 1, watchedAt: 1000 };
    const play2 = { id: "tt0903747:1:1", showId: "tt0903747", type: "episode", seasonNum: 1, episodeNum: 1, watchedAt: 2000 };
    const c = loadClient({ storage: withWatchHistory([play2, play1]) });
    c.set("window._rawWatchHistoryItems", [play2, play1]);
    c.set("window._listPreloadedCache", {
      "watch-history": { sample: [play2, play1] }
    });

    const mockBtn = {
      dataset: {
        removeType: "history",
        removeId: "tt0903747:1:1",
        watchedAt: "2000",
      },
      closest: () => null,
    };

    c.call("removeListItemFromDetails", mockBtn);

    const remaining = c.call("loadLocalCustomLists")["watch-history"].items;
    assert.equal(remaining.length, 1, "custom list storage must keep the other play");
    assert.equal(remaining[0].watchedAt, 1000);

    const cacheSample = c.get("window._listPreloadedCache['watch-history'].sample");
    assert.equal(cacheSample.length, 1, "preloaded cache must keep the other play");
    assert.equal(cacheSample[0].watchedAt, 1000);
  });
});
