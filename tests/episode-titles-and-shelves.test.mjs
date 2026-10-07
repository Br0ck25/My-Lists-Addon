import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadClient } from "./client-harness.mjs";

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
});
