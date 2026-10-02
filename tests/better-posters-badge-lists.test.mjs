import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { makeEnv, makeKv, makeD1, accountProof, call } = await import("./harness.mjs");

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`missing function ${name}`);
  let i = src.indexOf("{", start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  return src.slice(start, i);
}

function loadCatalogHelpers() {
  const src00 = readFileSync(new URL("../00_constants.js", import.meta.url), "utf8");
  const src05 = readFileSync(new URL("../05_catalog-core.js", import.meta.url), "utf8");

  const consts = [
    "const BETTER_POSTERS_ORIGIN = 'https://btttr.cc';",
    "const BETTER_POSTERS_RATING_SOURCES = [{ value: 'avg', label: 'Average' }];",
    "const BETTER_POSTERS_LANGS = [{ value: 'en', label: 'English' }];",
    "const BETTER_POSTERS_IMDB_RE = /^(tt\\d{5,12})$/i;",
    "const BETTER_POSTERS_PLACEHOLDER_ID = 'tt0000000';",
    "const BETTER_POSTERS_TODAY_CACHE = { movie: { ranks: new Map(), ts: 0 }, series: { ranks: new Map(), ts: 0 } };",
  ];
  const names = [
    "betterPostersImdbId",
    "betterPostersBase",
    "buildBetterPosterUrl",
    "betterPostersOptionsFrom",
    "getPosterRankParam",
    "getTodayBadgeRank",
    "orderMetasByTodayBadges",
  ];
  const fns = names.map((n) => extractFunction(src05, n));
  return new Function(`${consts.join("\n")}\n${fns.join("\n")}\nreturn { ${names.join(", ")} };`)();
}

const HELPERS = loadCatalogHelpers();

describe("orderMetasByTodayBadges unit tests", () => {
  it("groups and orders badged items numerically starting at the first badge position", () => {
    // When badge #11 and #13 appear in a list with #13 first: #11 comes first and #13 comes right after #11.
    const metas = [
      { id: "tt0000001", name: "Alpha" },
      { id: "tt0000013", name: "Thirteen Today", badgeRank: 13 },
      { id: "tt0000002", name: "Beta" },
      { id: "tt0000011", name: "Eleven Today", badgeRank: 11 },
      { id: "tt0000002b", name: "Two Today", badgeRank: 2 },
      { id: "tt0000003", name: "Gamma" },
    ];
    metas.totalItems = 6;

    const ordered = HELPERS.orderMetasByTodayBadges(metas, "movie");
    assert.equal(ordered.totalItems, 6);
    assert.deepEqual(ordered.map((m) => m.name), [
      "Alpha",
      "Two Today",
      "Eleven Today",
      "Thirteen Today",
      "Beta",
      "Gamma",
    ]);
  });

  it("leaves a list with only 1 badged item untouched", () => {
    const metas = [
      { id: "tt0000001", name: "Item 1" },
      { id: "tt0000011", name: "Single Badge", badgeRank: 11 },
      { id: "tt0000002", name: "Item 2" },
    ];
    const ordered = HELPERS.orderMetasByTodayBadges(metas, "movie");
    assert.deepEqual(ordered.map((m) => m.name), ["Item 1", "Single Badge", "Item 2"]);
  });

  it("leaves a list with 0 badged items untouched", () => {
    const metas = [
      { id: "tt0000001", name: "Item 1" },
      { id: "tt0000002", name: "Item 2" },
    ];
    const ordered = HELPERS.orderMetasByTodayBadges(metas, "movie");
    assert.deepEqual(ordered.map((m) => m.name), ["Item 1", "Item 2"]);
  });

  it("detects rank from _rank, ?r= query parameter, and poster tag filename", () => {
    const metas = [
      { id: "tt0000001", name: "Item A" },
      { id: "tt0000015", name: "Rank 15 via query", poster: "https://btttr.cc/poster/tt0000015.jpg?r=15" },
      { id: "tt0000002", name: "Item B" },
      { id: "tt0000005", name: "Rank 5 via _rank", _rank: 5 },
      { id: "tt0000008", name: "Rank 8 via tag", poster: "https://btttr.cc/poster/movie/tt0000008/%238%20Today.png" },
      { id: "tt0000003", name: "Item C" },
    ];

    const ordered = HELPERS.orderMetasByTodayBadges(metas, "movie");
    assert.deepEqual(ordered.map((m) => m.name), [
      "Item A",
      "Rank 5 via _rank",
      "Rank 8 via tag",
      "Rank 15 via query",
      "Item B",
      "Item C",
    ]);
  });
});

describe("Better Posters source detection and public access (Decision D-8)", () => {
  it("detects betterposters source for charts and badges", async () => {
    const env = makeEnv();
    const urls = [
      "betterposters:chart:today",
      "betterposters:chart:in-cinema",
      "betterposters:chart:binge-ready",
      "betterposters:chart:returning",
      "betterposters:chart:cannes-winner",
      "betterposters:chart:emmy-winner",
      "betterposters:chart:oscar-winner",
      "betterposters:badge:today",
    ];

    for (const u of urls) {
      const res = await call(env, "/api/preview", {
        method: "POST",
        json: { url: u, type: "movie", sample: 10 },
      });
      // Should not be rejected with "That URL isn't a supported list source."
      assert.notEqual(res.body.error, "That URL isn't a supported list source.");
    }
  });

  it("does not require an account to add Better Posters charts (Decision D-8)", async () => {
    const env = makeEnv({ CONFIGS: makeKv() });
    const payload = {
      entries: [
        {
          name: "Better Posters Top Today",
          url: "betterposters:chart:today",
          type: "movie",
          enabled: true,
        },
      ],
      betterPosters: true,
      betterPostersOrderTodayBadges: true,
    };
    const res = await call(env, "/api/save", { method: "POST", json: payload });
    assert.equal(res.body.ok, true, res.body.error);
    assert.ok(res.body.id, "should return saved config id");
  });
});

describe("Better Posters UI and Discover shelves", () => {
  it("serves Better Posters Lists in Quick Add and Discover on page load", async () => {
    const env = makeEnv();
    const res = await call(env, "/");
    assert.equal(res.status, 200);
    const html = res.text;
    assert.ok(html.includes("Better Posters Lists"), "markup should include Better Posters Lists shelf");
    assert.ok(html.includes("betterPostersOrderTodayBadgesCheckbox"), "settings should include Order # Today badges toggle");
    assert.ok(html.includes("data-add-all-action=\"betterposters-charts\""), "Quick Add should include + Add all button for Better Posters");
  });

  it("serves addAllBetterPostersCharts in app.js script", async () => {
    const env = makeEnv();
    const html = (await call(env, "/")).text;
    const src = (html.match(/<script src="(\/app\.js[^"]*)"/) || [])[1];
    assert.ok(src, "app.js script tag missing");
    const js = (await call(env, src)).text;
    assert.ok(js.includes("addAllBetterPostersCharts"), "app.js must declare addAllBetterPostersCharts");
    assert.ok(js.includes("betterposters-charts"), "app.js click listener must handle betterposters-charts");
  });
});

describe("End-to-end Better Posters Today badge ordering in Stremio catalogs", () => {
  it("orders #xx Today badges when betterPostersOrderTodayBadges is enabled, and leaves alone when disabled", async () => {
    const kv = makeKv();
    const db = makeD1();
    const env = makeEnv({ CONFIGS: kv, DB: db });

    const proof = await accountProof(env);
    const CUSTOM_URL = "customlist:v1:" + JSON.stringify({
      listSlug: "ordering-test",
      items: [
        { id: "tt0000001", title: "Item A", type: "movie" },
        { id: "tt0000013", title: "Item Thirteen", type: "movie", poster: "https://btttr.cc/poster/tt0000013.jpg?r=13" },
        { id: "tt0000002", title: "Item B", type: "movie" },
        { id: "tt0000011", title: "Item Eleven", type: "movie", poster: "https://btttr.cc/poster/tt0000011.jpg?r=11" },
        { id: "tt0000003", title: "Item C", type: "movie" },
      ],
    });

    // 1. With ordering enabled: Item Eleven should immediately precede Item Thirteen at index 1
    const saveOn = await call(env, "/api/save", {
      method: "POST",
      json: {
        ...proof,
        entries: [{ id: "order-shelf-on", type: "movie", name: "Ordered Shelf", url: CUSTOM_URL }],
        betterPosters: true,
        betterPostersOrderTodayBadges: true,
        showBadgesStremio: false,
      },
    });
    assert.equal(saveOn.body.ok, true);

    const catOn = await call(env, `/${saveOn.body.id}/catalog/movie/order-shelf-on.json`);
    assert.equal(catOn.status, 200);
    assert.equal(catOn.body.metas.length, 5);
    assert.deepEqual(catOn.body.metas.map((m) => m.name), [
      "Item A",
      "Item Eleven",
      "Item Thirteen",
      "Item B",
      "Item C",
    ]);

    // 2. With ordering disabled: Original order is preserved
    const saveOff = await call(env, "/api/save", {
      method: "POST",
      json: {
        ...proof,
        entries: [{ id: "order-shelf-off", type: "movie", name: "Unordered Shelf", url: CUSTOM_URL }],
        betterPosters: true,
        betterPostersOrderTodayBadges: false,
        showBadgesStremio: false,
      },
    });
    assert.equal(saveOff.body.ok, true);

    const catOff = await call(env, `/${saveOff.body.id}/catalog/movie/order-shelf-off.json`);
    assert.equal(catOff.status, 200);
    assert.equal(catOff.body.metas.length, 5);
    assert.deepEqual(catOff.body.metas.map((m) => m.name), [
      "Item A",
      "Item Thirteen",
      "Item B",
      "Item Eleven",
      "Item C",
    ]);
  });
});
