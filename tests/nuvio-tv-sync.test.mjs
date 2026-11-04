// Tests for Nuvio TV Launcher Default Preset, Guest Manifest & Unified Sync Route
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, makeD1, makeKv, call, accountProof } from "./harness.mjs";

describe("Nuvio TV Launcher - Default Preset & Guest Manifest", () => {
  it("GET /nuvio-default/manifest.json serves the default NuvioTV manifest", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const res = await call(env, "/nuvio-default/manifest.json");
    assert.equal(res.status, 200);
    const data = res.body;
    assert.ok(data);
    assert.ok(Array.isArray(data.catalogs), "manifest has catalogs array");
    const contentCatalogs = data.catalogs.filter((c) => !c.id.startsWith("search_"));
    assert.equal(contentCatalogs.length, 6, "has exactly 6 default catalogs");

    // Order: Trending Movies, Trending TV, Popular Movies, Popular TV, Trakt Box Office Movies, Trakt Box Office TV
    assert.equal(contentCatalogs[0].id, "chart:combined:trending_movies");
    assert.equal(contentCatalogs[0].type, "movie");
    assert.equal(contentCatalogs[1].id, "chart:combined:trending_tv");
    assert.equal(contentCatalogs[1].type, "series");

    assert.equal(contentCatalogs[2].id, "chart:combined:popular_movies");
    assert.equal(contentCatalogs[2].type, "movie");
    assert.equal(contentCatalogs[3].id, "chart:combined:popular_tv");
    assert.equal(contentCatalogs[3].type, "series");

    assert.equal(contentCatalogs[4].id, "chart:trakt:boxoffice_movies");
    assert.equal(contentCatalogs[4].type, "movie");
    assert.equal(contentCatalogs[5].id, "chart:trakt:boxoffice_tv");
    assert.equal(contentCatalogs[5].type, "series");
  });

  it("GET /c/nuvio-default/manifest.json supports /c/ prefix", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const res = await call(env, "/c/nuvio-default/manifest.json");
    assert.equal(res.status, 200);
    const data = res.body;
    assert.ok(data);
    const contentCatalogs = data.catalogs.filter((c) => !c.id.startsWith("search_"));
    assert.equal(contentCatalogs.length, 6);
    assert.equal(contentCatalogs[0].id, "chart:combined:trending_movies");
  });
});

describe("Nuvio TV Launcher - Unified Sync Route (/api/nuvio-tv/sync/:target)", () => {
  it("GET /api/nuvio-tv/sync/default returns complete Nuvio TV default state", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const res = await call(env, "/api/nuvio-tv/sync/default");
    assert.equal(res.status, 200);
    const data = res.body;

    assert.equal(data.ok, true);
    assert.ok(typeof data.versionHash === "string" && data.versionHash.length === 64, "valid SHA-256 versionHash");
    assert.ok(data.manifestUrl.includes("/nuvio-default/manifest.json"), "manifestUrl points to nuvio-default manifest");
    assert.equal(data.randomizeItemsDaily, true, "randomizeItemsDaily is true");

    // Catalog order check
    const expectedCatalogIds = [
      "chart:combined:trending_movies",
      "chart:combined:trending_tv",
      "chart:combined:popular_movies",
      "chart:combined:popular_tv",
      "chart:trakt:boxoffice_movies",
      "chart:trakt:boxoffice_tv",
    ];
    assert.deepEqual(data.catalogIds, expectedCatalogIds);
    assert.deepEqual(data.catalogOrder, expectedCatalogIds);

    // Collections check (Nuvio collections.json schema)
    assert.ok(Array.isArray(data.collections), "collections is an array");
    assert.ok(data.collections.length >= 4, "contains Streaming Services, Genres, Franchises, Studios");

    const collectionNames = data.collections.map((c) => c.title || c.name);
    assert.ok(collectionNames.includes("Streaming Services"), "has Streaming Services collection");
    assert.ok(collectionNames.includes("Genres"), "has Genres collection");
    assert.ok(collectionNames.includes("Franchises"), "has Franchises collection");
    assert.ok(collectionNames.includes("Studios"), "has Studios collection");

    // Verify folder and catalogSources structure
    for (const col of data.collections) {
      assert.ok(col.id, "collection has id");
      assert.ok(col.title, "collection has title");
      assert.ok(Array.isArray(col.folders), "collection has folders");
      assert.ok(col.folders.length > 0, "collection has at least one folder");
      for (const folder of col.folders) {
        assert.ok(folder.id, "folder has id");
        assert.ok(folder.title, "folder has title");
        assert.ok(Array.isArray(folder.catalogSources), "folder has catalogSources");
        assert.ok(folder.catalogSources.length > 0, "folder has at least one catalogSource");
        for (const src of folder.catalogSources) {
          assert.ok(src.addonId, "source has addonId");
          assert.ok(src.catalogId, "source has catalogId");
          assert.ok(src.type === "movie" || src.type === "series", "source has valid type");
        }
      }
    }

    // Channels check (QUICK_CHANNEL_PRESETS)
    assert.ok(Array.isArray(data.channels), "channels is an array");
    assert.ok(data.channels.length >= 25, "has all quick add network channel presets");
    const channelNames = data.channels.map((ch) => ch.name);
    assert.ok(channelNames.includes("CBS"), "has CBS");
    assert.ok(channelNames.includes("ABC"), "has ABC");
    assert.ok(channelNames.includes("NBC"), "has NBC");
    assert.ok(channelNames.includes("FOX"), "has FOX");
    assert.ok(channelNames.includes("HBO"), "has HBO");
    assert.ok(channelNames.includes("AMC"), "has AMC");
    assert.ok(channelNames.includes("FX"), "has FX");
    assert.ok(channelNames.includes("Comedy Central"), "has Comedy Central");
    assert.ok(channelNames.includes("Cartoon Network"), "has Cartoon Network");
    assert.ok(channelNames.includes("Adult Swim"), "has Adult Swim");
    assert.ok(channelNames.includes("Disney Channel"), "has Disney Channel");
    assert.ok(channelNames.includes("Nickelodeon"), "has Nickelodeon");

    for (const ch of data.channels) {
      assert.ok(ch.id, "channel has id");
      assert.ok(ch.name, "channel has name");
      assert.ok(ch.logoUrl, "channel has logoUrl");
      assert.ok(ch.category, "channel has category");
      assert.ok(ch.catalogId, "channel has catalogId");
      assert.ok(typeof ch.playOrder === "number", "channel has playOrder");
    }
  });

  it("GET /api/nuvio-tv/sync/:target handles target parameter fallback", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const res = await call(env, "/api/nuvio-tv/sync/:target");
    assert.equal(res.status, 200);
    const data = res.body;
    assert.equal(data.ok, true);
    assert.equal(data.catalogIds.length, 6);
  });

  it("GET /nuvio-default/catalog/movie/chart:combined:trending_movies.json handles catalog requests", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const res = await call(env, "/nuvio-default/catalog/movie/chart:combined:trending_movies.json");
    // Even if external upstream APIs are not called or return empty in tests, status should be 200
    assert.equal(res.status, 200);
    assert.ok(res.body);
    assert.ok(Array.isArray(res.body.metas), "returns metas array");
  });

  it("GET /api/nuvio-tv/sync/:target returns 404 for unknown target", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const res = await call(env, "/api/nuvio-tv/sync/unknown-nonexistent-user-12345");
    assert.equal(res.status, 404);
    assert.equal(res.body.ok, false);
  });

  it("GET /api/nuvio-tv/sync/:target resolves saved user account and custom lists/channels", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const proof = await accountProof(env, "nuviouser");
    const saveRes = await call(env, "/api/save", {
      method: "POST",
      json: {
        ...proof,
        entries: [
          { id: "custom_movie_list", name: "User Action Movies", type: "movie" },
          { id: "custom_show_list", name: "User Sci-Fi Shows", type: "series" },
        ],
        shuffleItems: true,
      },
    });
    assert.equal(saveRes.status, 200);

    // Save synced builder state in KV
    await env.CONFIGS.put(
      "creatorsync:nuviouser",
      JSON.stringify({
        entries: [
          { id: "custom_movie_list", name: "User Action Movies", type: "movie" },
          { id: "custom_show_list", name: "User Sci-Fi Shows", type: "series" },
        ],
        shuffleItems: true,
        updatedAt: 1700000000,
      })
    );

    // Save custom collection preset in KV
    await env.CONFIGS.put(
      "creatorsyncpresets:nuviouser",
      JSON.stringify({
        customCollections: [
          {
            id: "my_action_col",
            name: "Best Action",
            lists: [
              { catalogId: "custom_movie_list", name: "User Action Movies", type: "movie" },
            ],
          },
        ],
      })
    );

    // Save custom channel in KV
    await env.CONFIGS.put(
      "creatorsyncchannels:nuviouser",
      JSON.stringify([
        {
          id: "ch_nuvio_1",
          name: "My Custom Channel",
          category: "Personal",
        },
      ])
    );

    // Query sync route by username
    const syncRes = await call(env, "/api/nuvio-tv/sync/nuviouser");
    assert.equal(syncRes.status, 200);
    const data = syncRes.body;
    assert.equal(data.ok, true);
    assert.equal(data.randomizeItemsDaily, true);
    assert.ok(data.catalogIds.includes("custom_movie_list"));
    assert.ok(data.catalogIds.includes("custom_show_list"));

    // Verify user collection
    const userCol = data.collections.find((c) => c.id === "my-lists-collections");
    assert.ok(userCol, "has user collections group");
    assert.equal(userCol.folders[0].title, "Best Action");

    // Verify user channel
    const userChannel = data.channels.find((ch) => ch.id === "ch_nuvio_1");
    assert.ok(userChannel, "has user custom channel");
    assert.equal(userChannel.name, "My Custom Channel");
  });
});
