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
    assert.equal(contentCatalogs.length, 5, "has exactly 5 default catalogs");

    // Order: Trending Movies, Trending TV, Popular Movies, Popular TV, Trakt Box Office Movies
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
  });

  it("GET /c/nuvio-default/manifest.json supports /c/ prefix", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const res = await call(env, "/c/nuvio-default/manifest.json");
    assert.equal(res.status, 200);
    const data = res.body;
    assert.ok(data);
    const contentCatalogs = data.catalogs.filter((c) => !c.id.startsWith("search_"));
    assert.equal(contentCatalogs.length, 5);
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
    assert.ok(data.collectionsUrl.includes("/api/nuvio-tv/collections/default"), "collectionsUrl points to default collections");
    assert.equal(data.randomizeItemsDaily, true, "randomizeItemsDaily is true");

    // Catalog order check
    const expectedCatalogIds = [
      "chart:combined:trending_movies",
      "chart:combined:trending_tv",
      "chart:combined:popular_movies",
      "chart:combined:popular_tv",
      "chart:trakt:boxoffice_movies",
    ];
    assert.deepEqual(data.catalogIds, expectedCatalogIds);
    assert.deepEqual(data.catalogOrder, expectedCatalogIds);

    // Collections check (Nuvio collections.json schema)
    assert.ok(Array.isArray(data.collections), "collections is an array");
    assert.ok(data.collections.length >= 4, "contains Streaming Services, Genres, Franchises, Studios");

    const streamingCol = data.collections.find((c) => c.id === "col_mylists_streaming_services");
    assert.ok(streamingCol, "has col_mylists_streaming_services");
    for (const f of streamingCol.folders) {
      assert.ok(f.coverImageUrl && f.coverImageUrl.length > 0, `folder ${f.name} has non-empty coverImageUrl`);
    }

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
        assert.ok(folder.coverImageUrl && folder.coverImageUrl.length > 0, `folder ${folder.name} has non-empty coverImageUrl`);
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
      assert.ok(ch.poster, "channel has poster");
      assert.ok(ch.posterUrl, "channel has posterUrl");
      assert.ok(ch.backdrop, "channel has backdrop");
      assert.ok(ch.backdropUrl, "channel has backdropUrl");
      assert.equal(ch.category, "My Lists Addon Channels");
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
    assert.equal(data.catalogIds.length, 5);
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

  it("GET /api/nuvio-tv/sync/:target correctly unwraps dictionary channels and reflects live creator sync catalogs and versionHash updates", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });

    // Seed account using standard API helper
    const proof = await accountProof(env, "testtvuser");
    const saveRes = await call(env, "/api/save", {
      method: "POST",
      json: {
        ...proof,
        entries: [{ id: "list_initial", name: "Initial List", type: "movie" }],
      },
    });
    assert.equal(saveRes.status, 200);
    const installToken = saveRes.body.id;

    // Put initial creator sync state (as the builder does)
    await env.CONFIGS.put(
      "creatorsync:testtvuser",
      JSON.stringify({
        config: [{ id: "list_initial", name: "Initial List", type: "movie" }],
        updatedAt: 1000,
      })
    );

    // 1. Initial sync before custom channels/catalogs
    const resInitial = await call(env, "/api/nuvio-tv/sync/testtvuser");
    assert.equal(resInitial.status, 200);
    const initialHash = resInitial.body.versionHash;
    assert.ok(initialHash, "has initial versionHash");

    // 2. User adds custom channels in standard KV object format: { channels: { ... }, updatedAt: ... }
    await env.CONFIGS.put(
      "creatorsyncchannels:testtvuser",
      JSON.stringify({
        channels: {
          ch_custom_action: {
            id: "ch_custom_action",
            name: "Non-Stop Action",
            category: "Action Movies",
            posterUrl: "https://example.com/action.jpg",
          },
        },
        updatedAt: 2000,
      })
    );

    // 3. User updates catalogs via creatorsync:testtvuser with live .config array
    await env.CONFIGS.put(
      "creatorsync:testtvuser",
      JSON.stringify({
        config: [
          { id: "chart:combined:trending_movies", name: "Trending Movies", type: "movie" },
          { id: "custom:action_favorites", name: "My Action Favs", type: "movie" },
        ],
        updatedAt: 2500,
      })
    );

    // 4. Test sync endpoint via username
    const resUpdatedUser = await call(env, "/api/nuvio-tv/sync/testtvuser");
    assert.equal(resUpdatedUser.status, 200);
    const updatedUserData = resUpdatedUser.body;

    assert.notEqual(updatedUserData.versionHash, initialHash, "versionHash changed after adding channel and catalog");
    assert.ok(updatedUserData.catalogIds.includes("custom:action_favorites"), "catalogIds includes new custom list");
    assert.ok(updatedUserData.catalogOrder.includes("custom:action_favorites"), "catalogOrder includes new custom list");

    const customCh = updatedUserData.channels.find((c) => c.id === "ch_custom_action");
    assert.ok(customCh, "channels array includes un-nested custom channel");
    assert.equal(customCh.name, "Non-Stop Action");
    assert.equal(customCh.catalogId, "channel_ch_custom_action");
    assert.equal(customCh.category, "Action Movies");
    assert.equal(customCh.posterUrl, "https://example.com/action.jpg");
    assert.ok(customCh.backdropUrl.includes("format=landscape"), "auto-generates landscape backdropUrl");

    assert.ok(resUpdatedUser.headers.get("cache-control").includes("no-store"), "sync endpoint sets no-store cache control");

    // 5. Test sync endpoint via install token resolving to the same account
    const resUpdatedToken = await call(env, `/api/nuvio-tv/sync/${installToken}`);
    assert.equal(resUpdatedToken.status, 200);
    assert.equal(resUpdatedToken.body.versionHash, updatedUserData.versionHash, "token target has same versionHash");
    assert.ok(resUpdatedToken.body.channels.some((c) => c.id === "ch_custom_action"), "token target resolves custom channel");

    // 6. Test manifest endpoint /:username/manifest.json serves live catalogs
    const resManifest = await call(env, "/testtvuser/manifest.json");
    assert.equal(resManifest.status, 200);
    assert.ok(resManifest.headers.get("cache-control").includes("no-store"), "user manifest sets no-store cache control");
    assert.ok(resManifest.body.catalogs, "manifest has catalogs array");
    assert.ok(
      resManifest.body.catalogs.some((cat) => cat.id === "custom:action_favorites"),
      "manifest.json serves newly added catalog from creatorsync"
    );
  });

  it("GET /api/nuvio-tv/collections/:target and /nuvio-default/collections.json return collections array", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const res1 = await call(env, "/api/nuvio-tv/collections/default");
    assert.equal(res1.status, 200);
    assert.equal(res1.body.ok, true);
    assert.ok(Array.isArray(res1.body.collections), "returns collections array");
    assert.ok(res1.body.collections.length >= 4);

    const res2 = await call(env, "/nuvio-default/collections.json");
    assert.equal(res2.status, 200);
    assert.equal(res2.body.ok, true);
    assert.ok(Array.isArray(res2.body.collections));

    // Every folder must have non-empty coverImageUrl
    for (const col of res1.body.collections) {
      for (const f of col.folders) {
        assert.ok(f.coverImageUrl && f.coverImageUrl.length > 0, `folder ${f.name} has non-empty coverImageUrl`);
      }
    }
  });

  it("GET /link and /tv render standalone pairing landing page", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const res = await call(env, "/link?code=MTC-WGT");
    assert.equal(res.status, 200);
    assert.ok(res.text.includes("MTC-WGT"), "contains pairing code");
    assert.ok(res.text.includes("Link Nuvio TV Launcher"), "contains title");
    assert.ok(res.text.includes("Link TV Now"), "contains link button");
    assert.ok(res.text.includes('<style nonce="'), "style has CSP nonce placeholder or nonce");
    assert.ok(res.text.includes('<script nonce="'), "script has CSP nonce placeholder or nonce");
    assert.ok(res.text.includes('id="successBox" style="display:none;"'), "successBox has inline display:none");
    assert.ok(res.text.includes('id="errorMsg" style="display:none;"'), "errorMsg has inline display:none");
    assert.ok(res.text.includes("dark-theme"), "supports theme detection");
  });

  it("GET /?source=nuvio_tv&tv_code=MTC-WGT redirects to /link?code=MTC-WGT", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const res = await call(env, "/?source=nuvio_tv&tv_code=MTC-WGT");
    assert.equal(res.status, 302);
    assert.ok(res.headers.get("location").includes("/link?code=MTC-WGT"));
  });
});

describe("Phase 2: Nuvio TV Launcher - New User Account Seeding & Existing User Sign-In", () => {
  it("POST /api/creator/register with source='nuvio_tv' seeds default catalogs, channels, and collections", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });

    // 1. Register new user with source === "nuvio_tv"
    const regRes = await call(env, "/api/creator/register", {
      method: "POST",
      json: {
        creatorName: "nuviotvuser1",
        displayName: "Nuvio User 1",
        source: "nuvio_tv",
      },
    });
    assert.equal(regRes.status, 200);
    assert.equal(regRes.body.ok, true);
    assert.equal(regRes.body.creatorName, "nuviotvuser1");
    assert.ok(regRes.body.creatorKey, "returns creatorKey");
    const creatorKey = regRes.body.creatorKey;

    // 2. Load sync state via POST /api/creator/sync/load
    const syncLoadRes = await call(env, "/api/creator/sync/load", {
      method: "POST",
      json: {
        creatorName: "nuviotvuser1",
        creatorKey,
      },
    });
    assert.equal(syncLoadRes.status, 200);
    const syncData = syncLoadRes.body.data;
    assert.ok(syncData, "sync data exists for seeded user");

    // 2a. Catalogs check: Combined Trending, Combined Popular, Trakt Box Office in exact order
    assert.ok(Array.isArray(syncData.config), "config is an array");
    assert.equal(syncData.config.length, 5, "has 5 default catalog rows");
    assert.equal(syncData.config[0].id, "chart:combined:trending_movies");
    assert.equal(syncData.config[1].id, "chart:combined:trending_tv");
    assert.equal(syncData.config[2].id, "chart:combined:popular_movies");
    assert.equal(syncData.config[3].id, "chart:combined:popular_tv");
    assert.equal(syncData.config[4].id, "chart:trakt:boxoffice_movies");
    assert.equal(syncData.randomizeItemsDaily, true, "randomizeItemsDaily is true");

    // 2b. Channels check: My Channels is populated with all Quick Add channels
    assert.ok(syncData.channels && typeof syncData.channels === "object", "channels map is populated");
    const channelKeys = Object.keys(syncData.channels);
    assert.ok(channelKeys.length >= 25, "has all Quick Add channel presets");
    const channelNames = Object.values(syncData.channels).map((ch) => ch.name);
    assert.ok(channelNames.includes("CBS"), "has CBS");
    assert.ok(channelNames.includes("HBO"), "has HBO");
    assert.ok(channelNames.includes("Cartoon Network"), "has Cartoon Network");

    // 2c. Collections check: populated with all Premade Collections
    assert.ok(Array.isArray(syncData.customCollections), "customCollections is populated");
    assert.ok(syncData.customCollections.length >= 4, "has all 4 collection groups");
    const colTitles = syncData.customCollections.map((c) => c.title || c.name);
    assert.ok(colTitles.includes("Streaming Services"));
    assert.ok(colTitles.includes("Genres"));
    assert.ok(colTitles.includes("Franchises"));
    assert.ok(colTitles.includes("Studios"));

    // 3. Verify public sync route returns the seeded data
    const nuvioSyncRes = await call(env, "/api/nuvio-tv/sync/nuviotvuser1");
    assert.equal(nuvioSyncRes.status, 200);
    assert.equal(nuvioSyncRes.body.ok, true);
    assert.equal(nuvioSyncRes.body.randomizeItemsDaily, true);
    assert.equal(nuvioSyncRes.body.catalogIds.length, 5);
  });

  it("POST /api/creator/account/register with ?source=nuvio_tv query param seeds correctly", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const regRes = await call(env, "/api/creator/account/register?source=nuvio_tv", {
      method: "POST",
      json: {
        username: "nuviotvquery",
      },
    });
    assert.equal(regRes.status, 200);
    assert.equal(regRes.body.ok, true);

    const nuvioSyncRes = await call(env, "/api/nuvio-tv/sync/nuviotvquery");
    assert.equal(nuvioSyncRes.status, 200);
    assert.equal(nuvioSyncRes.body.ok, true);
    assert.equal(nuvioSyncRes.body.randomizeItemsDaily, true);
    assert.equal(nuvioSyncRes.body.catalogIds.length, 5);
  });

  it("Normal registration without source creates empty account with NO seeded preset", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const regRes = await call(env, "/api/creator/create", {
      method: "POST",
      json: {
        creatorName: "normalwebuser",
      },
    });
    assert.equal(regRes.status, 200);
    assert.equal(regRes.body.ok, true);
    const creatorKey = regRes.body.creatorKey;

    // Load sync state
    const syncLoadRes = await call(env, "/api/creator/sync/load", {
      method: "POST",
      json: {
        creatorName: "normalwebuser",
        creatorKey,
      },
    });
    assert.equal(syncLoadRes.status, 200);
    const syncData = syncLoadRes.body.data;
    // Without source: "nuvio_tv", account has null or empty initial config
    if (syncData) {
      assert.deepEqual(syncData.config, [], "config is empty");
      assert.equal(Object.keys(syncData.channels || {}).length, 0, "no channels seeded");
      assert.equal((syncData.customCollections || []).length, 0, "no collections seeded");
    }
  });

  it("Existing user login via POST /api/creator/account/login preserves existing data without overwriting", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });

    // 1. Create a normal user
    const proof = await accountProof(env, "veteranuser");
    // Veteran user has their own custom config
    await env.CONFIGS.put(
      "creatorsync:veteranuser",
      JSON.stringify({
        config: [{ id: "veteran_movie_list", name: "Classic Noir", type: "movie" }],
        entries: [{ id: "veteran_movie_list", name: "Classic Noir", type: "movie" }],
        randomizeItemsDaily: false,
        shuffleItems: false,
        catalogOrder: ["veteran_movie_list"],
        updatedAt: 123456789,
      })
    );
    // Veteran user has their own channels
    await env.CONFIGS.put(
      "creatorsyncchannels:veteranuser",
      JSON.stringify({
        channels: {
          my_noir_ch: { channelId: "my_noir_ch", name: "Noir Channel" },
        },
        mergedChannels: {},
        updatedAt: 123456789,
      })
    );

    // 2. Existing user logs in with source: "nuvio_tv"
    const loginRes = await call(env, "/api/creator/account/login", {
      method: "POST",
      json: {
        username: "veteranuser",
        key: proof.creatorKey,
        source: "nuvio_tv",
      },
    });
    assert.equal(loginRes.status, 200);
    assert.equal(loginRes.body.ok, true);

    // 3. Verify their existing data was NOT overwritten
    const syncLoadRes = await call(env, "/api/creator/sync/load", {
      method: "POST",
      json: {
        creatorName: "veteranuser",
        creatorKey: proof.creatorKey,
      },
    });
    assert.equal(syncLoadRes.status, 200);
    const syncData = syncLoadRes.body.data;
    assert.equal(syncData.config.length, 1);
    assert.equal(syncData.config[0].id, "veteran_movie_list");
    assert.equal(syncData.config[0].name, "Classic Noir");
    assert.equal(syncData.randomizeItemsDaily, false);

    assert.equal(Object.keys(syncData.channels).length, 1);
    assert.equal(syncData.channels.my_noir_ch.name, "Noir Channel");
  });
});

describe("Nuvio TV Launcher - TV Device Pairing (/api/nuvio-tv/device/*)", () => {
  it("POST /api/nuvio-tv/device/code generates deviceCode, userCode, and verificationUrl", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const res = await call(env, "/api/nuvio-tv/device/code", { method: "POST" });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.deviceCode, "has deviceCode");
    assert.ok(res.body.userCode, "has userCode");
    assert.match(res.body.userCode, /^[A-Z0-9]{3}-[A-Z0-9]{3}$/, "userCode is XXX-XXX format");
    assert.ok(res.body.verificationUrl.includes("source=nuvio_tv"), "verificationUrl includes source=nuvio_tv");
    assert.ok(res.body.verificationUrl.includes(res.body.userCode), "verificationUrl includes userCode");
  });

  it("GET /api/nuvio-tv/device/poll reports pending status for active code", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const codeRes = await call(env, "/api/nuvio-tv/device/code", { method: "POST" });
    const { deviceCode } = codeRes.body;

    // Missing deviceCode
    const missingRes = await call(env, "/api/nuvio-tv/device/poll");
    assert.equal(missingRes.status, 400);

    // Nonexistent deviceCode
    const notFoundRes = await call(env, "/api/nuvio-tv/device/poll?deviceCode=nonexistent-uuid");
    assert.equal(notFoundRes.status, 404);

    // Valid pending deviceCode
    const pollRes = await call(env, `/api/nuvio-tv/device/poll?deviceCode=${deviceCode}`);
    assert.equal(pollRes.status, 200);
    assert.equal(pollRes.body.ok, true);
    assert.equal(pollRes.body.status, "pending");
  });

  it("POST /api/nuvio-tv/device/claim requires authentication and links device to account", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });

    // 1. Generate pairing code on TV
    const codeRes = await call(env, "/api/nuvio-tv/device/code", { method: "POST" });
    const { deviceCode, userCode } = codeRes.body;

    // 2. Unauthenticated claim attempt -> 401
    const anonClaimRes = await call(env, "/api/nuvio-tv/device/claim", {
      method: "POST",
      json: { userCode },
    });
    assert.equal(anonClaimRes.status, 401);

    // 3. Create a creator account on website
    const proof = await accountProof(env, "claimuser");

    // 4. Authenticated claim with invalid userCode -> 404
    const badCodeRes = await call(env, "/api/nuvio-tv/device/claim", {
      method: "POST",
      json: {
        userCode: "INVALID",
        creatorName: "claimuser",
        creatorKey: proof.creatorKey,
      },
    });
    assert.equal(badCodeRes.status, 404);

    // 5. Authenticated claim with valid userCode
    const claimRes = await call(env, "/api/nuvio-tv/device/claim", {
      method: "POST",
      json: {
        userCode,
        creatorName: "claimuser",
        creatorKey: proof.creatorKey,
      },
    });
    assert.equal(claimRes.status, 200);
    assert.equal(claimRes.body.ok, true);
    assert.ok(claimRes.body.manifestUrl.includes("/manifest.json"));
    assert.ok(claimRes.body.syncUrl.includes("/api/nuvio-tv/sync/"));

    // 6. TV polls again -> receives status authenticated and URLs
    const pollAfterRes = await call(env, `/api/nuvio-tv/device/poll?deviceCode=${deviceCode}`);
    assert.equal(pollAfterRes.status, 200);
    assert.equal(pollAfterRes.body.ok, true);
    assert.equal(pollAfterRes.body.status, "authenticated");
    assert.equal(pollAfterRes.body.installId, claimRes.body.installId);
    assert.equal(pollAfterRes.body.manifestUrl, claimRes.body.manifestUrl);
    assert.equal(pollAfterRes.body.syncUrl, claimRes.body.syncUrl);
  });

  it("POST /api/nuvio-tv/device/claim accepts userCode without hyphen", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const codeRes = await call(env, "/api/nuvio-tv/device/code", { method: "POST" });
    const { deviceCode, userCode } = codeRes.body;
    const rawCodeWithoutHyphen = userCode.replace(/-/g, "");

    const proof = await accountProof(env, "claimuser2");

    const claimRes = await call(env, "/api/nuvio-tv/device/claim", {
      method: "POST",
      json: {
        userCode: rawCodeWithoutHyphen,
        creatorName: "claimuser2",
        creatorKey: proof.creatorKey,
      },
    });
    assert.equal(claimRes.status, 200);
    assert.equal(claimRes.body.ok, true);

    const pollRes = await call(env, `/api/nuvio-tv/device/poll?deviceCode=${deviceCode}`);
    assert.equal(pollRes.status, 200);
    assert.equal(pollRes.body.status, "authenticated");
  });

  it("Builder HTML and client bundle include Nuvio TV onboarding banner and pairing logic", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const pageRes = await call(env, "/");
    assert.equal(pageRes.status, 200);
    assert.ok(pageRes.text.includes('id="nuvioTvOnboardingBanner"'), "HTML has nuvioTvOnboardingBanner");
    assert.ok(pageRes.text.includes('id="nuvioSection"'), "HTML has nuvioSection");
    assert.ok(pageRes.text.includes("Step 2:"), "HTML contains Step 2 prefix");
    assert.ok(
      pageRes.text.includes("Sign in with your Nuvio account below to view your Continue Watching, Watch History, and Library on the website."),
      "HTML contains step 2 onboarding prompt"
    );

    // Verify /app-features.js contains the pairing functions
    const m = pageRes.text.match(/<script src="(\/app-features\.js\?v=[0-9a-f]+)"/);
    assert.ok(m, "page loads app-features.js");
    const featuresRes = await call(env, m[1]);
    assert.equal(featuresRes.status, 200);
    assert.ok(featuresRes.text.includes("claimNuvioTvDeviceCode"), "bundle includes claimNuvioTvDeviceCode");
    assert.ok(featuresRes.text.includes("handleNuvioTvPostAuth"), "bundle includes handleNuvioTvPostAuth");
    assert.ok(featuresRes.text.includes("initNuvioTvOnboarding"), "bundle includes initNuvioTvOnboarding");
    assert.ok(featuresRes.text.includes("openNuvioTvPairingModal"), "bundle includes openNuvioTvPairingModal");
    assert.ok(featuresRes.text.includes("openNuvioTvAuthModal"), "bundle includes openNuvioTvAuthModal");
    assert.ok(featuresRes.text.includes("submitNuvioTvLink"), "bundle includes submitNuvioTvLink");
    assert.ok(featuresRes.text.includes("showNuvioTvPairingSuccessModal"), "bundle includes showNuvioTvPairingSuccessModal");
  });

  it("Custom channels and preset channels serve media items via catalog, meta, and lineup routes", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const proof = await accountProof(env, "nuviochanuser");

    // Save initial catalog sync state
    await env.CONFIGS.put(
      "creatorsync:nuviochanuser",
      JSON.stringify({
        config: [{ id: "chart:combined:trending_movies", name: "Trending Movies", type: "movie" }],
        updatedAt: 1000,
      })
    );

    // Save custom channel in KV under creatorsyncchannels:nuviochanuser
    await env.CONFIGS.put(
      "creatorsyncchannels:nuviochanuser",
      JSON.stringify({
        channels: {
          ch_custom_arrow: {
            id: "ch_custom_arrow",
            channelId: "ch_custom_arrow",
            name: "Arrow 24/7",
            items: [
              {
                imdbId: "tt2193021",
                season: 8,
                episode: 7,
                title: "Purgatory",
                kind: "episode",
                poster: "https://example.com/arrow_s8.jpg",
                thumbnail: "https://example.com/arrow_s8_thumb.jpg",
              },
              {
                imdbId: "tt2193021",
                season: 8,
                episode: 8,
                title: "Crisis on Infinite Earths",
                kind: "episode",
                poster: "https://example.com/arrow_s8.jpg",
                thumbnail: "https://example.com/arrow_s8_thumb.jpg",
              },
            ],
          },
        },
        updatedAt: 2000,
      })
    );

    // 1. Verify manifest does NOT dump uncataloged 24/7 channels onto home catalogs
    const manifestRes = await call(env, "/nuviochanuser/manifest.json", { headers: { accept: "application/json" } });
    assert.equal(manifestRes.status, 200);
    assert.ok(
      !manifestRes.body.catalogs.some((c) => c.id === "channel_ch_custom_arrow"),
      "manifest does not declare uncataloged channel as home catalog"
    );

    // 2. Verify catalog route serves channel media items with streamable IDs
    const catRes = await call(env, "/nuviochanuser/catalog/series/channel_ch_custom_arrow.json");
    assert.equal(catRes.status, 200);
    assert.ok(Array.isArray(catRes.body.metas), "returns metas array");
    assert.equal(catRes.body.metas.length, 2, "returns 2 episode items");
    assert.equal(catRes.body.metas[0].id, "tt2193021:8:7", "first item has valid stream ID");
    assert.equal(catRes.body.metas[0].name, "Purgatory");

    // 3. Verify meta route serves channel details and video episodes
    const metaRes = await call(env, "/nuviochanuser/meta/series/channel_ch_custom_arrow.json");
    assert.equal(metaRes.status, 200);
    assert.ok(metaRes.body.meta, "meta object is returned");
    assert.equal(metaRes.body.meta.name, "Arrow 24/7");
    assert.ok(Array.isArray(metaRes.body.meta.videos), "meta has videos array");
    assert.equal(metaRes.body.meta.videos[0].id, "tt2193021:8:7");

    // 4. Verify /api/channel-lineup works with channelId and username
    const lineupRes = await call(env, "/api/channel-lineup", {
      method: "POST",
      json: { channelId: "ch_custom_arrow", username: "nuviochanuser" },
    });
    assert.equal(lineupRes.status, 200);
    assert.equal(lineupRes.body.ok, true);
    assert.equal(lineupRes.body.items.length, 2);
    assert.ok(lineupRes.body.items[0].id.startsWith("tt2193021"));

    // 5. Verify preset channel (e.g. channel_preset_net_hbo) resolves
    const presetCatRes = await call(env, "/nuviochanuser/catalog/series/channel_preset_net_hbo.json");
    assert.equal(presetCatRes.status, 200);
    assert.ok(Array.isArray(presetCatRes.body.metas));
  });

  it("short install link target (cfg:<id>) resolves live creator sync entries after account edits", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const shortId = "s3v0mW0jBp0g";
    const username = "james";

    // 1. Store initial static snapshot in cfg:<shortId> with trackOwner
    await env.CONFIGS.put(
      `cfg:${shortId}`,
      JSON.stringify({
        entries: [
          { id: "old_list_1", name: "Old List 1", type: "movie" },
        ],
        trackOwner: username,
      })
    );

    // 2. User updates catalogs in creatorsync:<username>
    await env.CONFIGS.put(
      `creatorsync:${username}`,
      JSON.stringify({
        config: [
          { id: "new_live_list_1", name: "Live List 1", type: "movie" },
          { id: "new_live_list_2", name: "Live List 2", type: "series" },
        ],
        updatedAt: 1700000000,
      })
    );

    // 3. GET /api/nuvio-tv/sync/<shortId> must reflect the live catalogs from creatorsync
    const syncRes = await call(env, `/api/nuvio-tv/sync/${shortId}`);
    assert.equal(syncRes.status, 200);
    assert.equal(syncRes.body.ok, true);
    assert.ok(syncRes.body.catalogIds.includes("new_live_list_1"), "contains updated live list 1");
    assert.ok(syncRes.body.catalogIds.includes("new_live_list_2"), "contains updated live list 2");
    assert.ok(!syncRes.body.catalogIds.includes("old_list_1"), "old stale snapshot list removed");

    // 4. GET /<shortId>/manifest.json must also reflect the live catalogs
    const manifestRes = await call(env, `/${shortId}/manifest.json`, { headers: { accept: "application/json" } });
    assert.equal(manifestRes.status, 200);
    assert.ok(manifestRes.body.catalogs.some((c) => c.id === "new_live_list_1"), "manifest has live list 1");
    assert.ok(manifestRes.body.catalogs.some((c) => c.id === "new_live_list_2"), "manifest has live list 2");
    assert.ok(!manifestRes.body.catalogs.some((c) => c.id === "old_list_1"), "manifest dropped old list 1");
  });

  it("POST /api/nuvio-tv/history records true watch progress for movies and episodes, and /remove deletes them", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const targetUser = "nuviowatcher";
    await accountProof(env, targetUser);

    // 1. Record Movie watched via POST /api/nuvio-tv/history
    const movieRes = await call(env, "/api/nuvio-tv/history", {
      method: "POST",
      headers: {
        "x-nuvio-client": "NuvioTVLauncher",
        "origin": "https://mylistsaddon.com",
      },
      json: {
        targetId: targetUser,
        type: "movie",
        contentId: "tt0137523",
        imdbId: "tt0137523",
        progress: 94.2,
        completed: true,
        watchedAt: 1730825000000,
      },
    });
    assert.equal(movieRes.status, 200);
    assert.equal(movieRes.body.success, true);

    // Verify stored in creatorsynctracking:<user>
    let trackingRaw = await env.CONFIGS.get(`creatorsynctracking:${targetUser}`);
    let tracking = JSON.parse(trackingRaw);
    assert.equal(tracking.watchHistory.length, 1);
    assert.equal(tracking.watchHistory[0].id, "tt0137523");
    assert.equal(tracking.watchHistory[0].type, "movie");

    // 2. Record Series Episode watched via POST /api/nuvio-tv/history
    const epRes = await call(env, "/api/nuvio-tv/history", {
      method: "POST",
      headers: {
        "x-nuvio-client": "NuvioTVLauncher",
        "origin": "https://mylistsaddon.com",
      },
      json: {
        targetId: targetUser,
        type: "series",
        contentId: "tt0903747:1:1",
        imdbId: "tt0903747",
        season: 1,
        episode: 1,
        progress: 91.5,
        completed: true,
        watchedAt: 1730826000000,
      },
    });
    assert.equal(epRes.status, 200);
    assert.equal(epRes.body.success, true);

    trackingRaw = await env.CONFIGS.get(`creatorsynctracking:${targetUser}`);
    tracking = JSON.parse(trackingRaw);
    assert.equal(tracking.watchHistory.length, 2);
    assert.equal(tracking.watchHistory[0].seasonNum, 1);
    assert.equal(tracking.watchHistory[0].episodeNum, 1);
    assert.equal(tracking.watchHistory[0].showId, "tt0903747");

    // 3. Remove episode via POST /api/nuvio-tv/history/remove
    const removeEpRes = await call(env, "/api/nuvio-tv/history/remove", {
      method: "POST",
      headers: {
        "x-nuvio-client": "NuvioTVLauncher",
      },
      json: {
        targetId: targetUser,
        type: "series",
        contentId: "tt0903747:1:1",
        imdbId: "tt0903747",
        season: 1,
        episode: 1,
      },
    });
    assert.equal(removeEpRes.status, 200);
    assert.equal(removeEpRes.body.success, true);

    trackingRaw = await env.CONFIGS.get(`creatorsynctracking:${targetUser}`);
    tracking = JSON.parse(trackingRaw);
    assert.equal(tracking.watchHistory.length, 1);
    assert.equal(tracking.watchHistory[0].id, "tt0137523");

    // 4. Remove movie via POST /api/nuvio-tv/history/remove
    const removeMovieRes = await call(env, "/api/nuvio-tv/history/remove", {
      method: "POST",
      headers: {
        "x-nuvio-client": "NuvioTVLauncher",
      },
      json: {
        targetId: targetUser,
        type: "movie",
        contentId: "tt0137523",
        imdbId: "tt0137523",
      },
    });
    assert.equal(removeMovieRes.status, 200);
    assert.equal(removeMovieRes.body.success, true);

    trackingRaw = await env.CONFIGS.get(`creatorsynctracking:${targetUser}`);
    tracking = JSON.parse(trackingRaw);
    assert.equal(tracking.watchHistory.length, 0);
  });

  it("subtitles route skips premature watch history marking for Nuvio requests", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const targetUser = "nuviosubuser";
    await accountProof(env, targetUser);

    // Save install with track: true
    await env.CONFIGS.put(
      `creatorsync:${targetUser}`,
      JSON.stringify({
        config: [],
        trackOwner: targetUser,
        trackCreatorName: targetUser,
        track: true,
      })
    );

    // Subtitle ping with X-Nuvio-Client header
    const subRes = await call(env, `/${targetUser}/subtitles/movie/tt0468569.json`, {
      headers: {
        "x-nuvio-client": "NuvioTVLauncher",
        "user-agent": "NuvioTVLauncher/1.1.10",
      },
    });
    assert.equal(subRes.status, 200);

    // Tracking history should NOT have been recorded
    const trackingRaw = await env.CONFIGS.get(`creatorsynctracking:${targetUser}`);
    assert.equal(trackingRaw, null);

    // Diagnostic should log that Nuvio client subtitle ping was skipped
    const diagRaw = await env.CONFIGS.get(`creatortrack:${targetUser}`);
    assert.ok(diagRaw, "diagnostics key written");
    const diag = JSON.parse(diagRaw);
    assert.ok(diag.matched.includes("skipped (Nuvio client reports true completion via /api/nuvio-tv/history)"));
  });
});
