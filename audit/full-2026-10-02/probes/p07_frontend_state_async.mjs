// Automated probe for Module 08: Frontend State and Async Behavior
// Tests:
// 1. Double-submit concurrency on channel saving (AUDIT-FE-002)
// 2. Offline / error sign-out failure in appShellSignOut (AUDIT-FE-001)
// 3. User switching state cleanup on switchCreatorProfile (Verified Working)
// 4. Fallback search race condition in executeUnifiedListSearch (AUDIT-FE-003)
// 5. Sequence counter discarding in runCatalogSearch (Verified Working)
// 6. Gated creator sync preventing stale overwrites on sign-in (Verified Working)

import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const ROOT = process.env.AUDIT_ROOT || process.cwd();
const { loadClient } = await import(pathToFileURL(path.join(ROOT, "tests", "client-harness.mjs")).href);

describe("Module 08: Frontend State and Async Behavior", () => {
  it("AUDIT-FE-001: appShellSignOut halts and preserves local credentials on network/server error", async () => {
    const client = loadClient({
      newUi: true,
      storage: {
        "myListAddon:creatorKey": "KEY-SECRET-1",
        "myListAddon:creatorName": "alice",
        "myListAddon:creatorDisplayName": "Alice",
      },
      routes: {
        "/api/session": async () => {
          // Simulate offline / 500 error
          return { status: 500, json: { ok: false, error: "Database unavailable" } };
        },
      },
    });

    client.set("activeCreator", { creatorName: "alice", displayName: "Alice" });
    assert.equal(client.localStorage.getItem("myListAddon:creatorKey"), "KEY-SECRET-1");

    const result = await client.window.appShellSignOut();
    // Failed signout returns false
    assert.equal(result, false, "appShellSignOut should return false on server error");

    // Defect reproduction: local storage and in-memory account are NOT cleared
    const keyAfter = client.localStorage.getItem("myListAddon:creatorKey");
    const activeAfter = client.get("activeCreator");

    assert.equal(keyAfter, "KEY-SECRET-1", "creatorKey remains in localStorage after failed sign-out");
    assert.ok(activeAfter && activeAfter.creatorName === "alice", "activeCreator remains populated in memory");

    // Negative control: switchCreatorProfile clears local credentials unconditionally even on network failure
    const client2 = loadClient({
      storage: {
        "myListAddon:creatorKey": "KEY-SECRET-2",
        "myListAddon:creatorName": "bob",
      },
      routes: {
        "/api/session": async () => ({ status: 500, json: { ok: false, error: "Database error" } }),
      },
    });
    client2.set("activeCreator", { creatorName: "bob", displayName: "Bob" });

    await client2.window.switchCreatorProfile();
    assert.equal(client2.localStorage.getItem("myListAddon:creatorKey"), null, "switchCreatorProfile cleared localStorage");
    assert.equal(client2.get("activeCreator"), null, "switchCreatorProfile cleared activeCreator");
  });

  it("AUDIT-FE-002: saveChannel allows duplicate publishing and local creation on rapid double-click", async () => {
    let shareRequests = [];
    let resolveFirstShare;
    const firstSharePromise = new Promise((r) => { resolveFirstShare = r; });

    const client = loadClient({
      storage: { "myListAddon:creatorKey": "KEY-CHANNEL-1" },
      routes: {
        "/api/channel/share": async (req) => {
          shareRequests.push(req.body);
          if (shareRequests.length === 1) {
            await firstSharePromise;
            return { json: { ok: true, code: "CODE-1", published: true } };
          }
          return { json: { ok: true, code: "CODE-2", published: true } };
        },
        "/api/channel/directory": () => ({ json: { ok: true, channels: [] } }),
      },
    });

    client.set("activeCreator", { creatorName: "alice", displayName: "Alice" });
    client.document.getElementById("channelNameInput").value = "Sci-Fi Channel";
    client.document.getElementById("channelPublicToggle").checked = true;
    client.set("channelDraftItems", [{ title: "Dune", tmdbId: 438631, season: 1, episode: 1 }]);

    // Fire two saveChannel calls concurrently before first completes (rapid double click)
    const p1 = client.window.saveChannel();
    const p2 = client.window.saveChannel();

    resolveFirstShare();
    await Promise.all([p1, p2]);

    // Defect reproduction: two distinct share requests were sent
    assert.equal(shareRequests.length, 2, "Expected 2 concurrent share requests on double click");

    // Two distinct channels were stored locally
    const localChannels = client.window.loadLocalChannels();
    const channelIds = Object.keys(localChannels);
    assert.equal(channelIds.length, 2, "Expected 2 separate channels stored in localChannels map");

    // Negative control: sequential saves reject empty inputs after first save
    const p3 = client.window.saveChannel();
    await p3;
    assert.equal(shareRequests.length, 2, "Sequential third save should not send request because name was cleared");
  });

  it("AUDIT-FE-003: executeUnifiedListSearch overwrites newer query with out-of-order fallback results", async () => {
    let resolveFallback;
    const fallbackWait = new Promise((r) => { resolveFallback = r; });
    let triggerFallbackStarted;
    const fallbackStartedPromise = new Promise((r) => { triggerFallbackStarted = r; });

    const client = loadClient({
      routes: {
        "/api/toplists": () => ({ json: { ok: true, lists: [] } }),
        "/api/trakt-search": () => ({ json: { ok: true, lists: [] } }),
        "/api/search-published-lists": () => ({ json: { ok: true, lists: [] } }),
        "/api/tmdb-search-lists": (req) => {
          const url = new URL(req.url, "https://example.com");
          const q = url.searchParams.get("q");
          if (q === "pickup2") {
            return { json: { ok: true, lists: [] } };
          }
          if (q === "pickup 2") {
            triggerFallbackStarted();
            return fallbackWait.then(() => ({
              json: { ok: true, lists: [{ name: "Stale Fallback List", url: "https://example.com/lists/pickup2", type: "movie" }] },
            }));
          }
          return {
            json: { ok: true, lists: [{ name: "Fast Batman List", url: "https://example.com/lists/batman", type: "movie" }] },
          };
        },
        "/api/track-search": () => ({ json: { ok: true } }),
      },
    });

    const targetBox = client.document.createElement("div");
    targetBox.id = "listSearchResult";
    client.document.body.appendChild(targetBox);

    // Query 1 triggers fallback
    const q1 = client.window.executeUnifiedListSearch("pickup2", targetBox);

    // Wait until Query 1 enters fallback fetch
    await fallbackStartedPromise;

    // User types Query 2 ('batman') while Query 1 fallback is still pending
    const q2 = client.window.executeUnifiedListSearch("batman", targetBox);
    await q2;

    assert.ok(targetBox.innerHTML.includes("Fast Batman List"), "Query 2 rendered correctly");

    // Query 1 fallback resolves late
    resolveFallback();
    await q1;

    // Defect reproduction: targetBox was overwritten by stale Query 1 fallback list
    assert.equal(targetBox.innerHTML.includes("Stale Fallback List"), true, "Target box was overwritten with stale fallback list");
    assert.equal(targetBox.innerHTML.includes("Fast Batman List"), false, "Newer search results were erased by stale fallback");
  });

  it("CONFIRMED WORKING: clearLocalAccountData completely sweeps memory, storage, and form inputs", async () => {
    const client = loadClient({
      storage: {
        "myListAddon:creatorKey": "SECRET_KEY",
        "myListAddon:creatorName": "alice",
        "myListAddon:creatorDisplayName": "Alice",
        "myListAddon:activeTab": "settings",
        "localCustomLists": JSON.stringify({ test: { name: "Test" } }),
        "localChannels": JSON.stringify({ ch1: { name: "Channel 1" } }),
      },
    });

    client.set("activeCreator", { creatorName: "alice" });
    client.set("traktAccessToken", "TOKEN_TRAKT");
    client.set("mdblistAccessToken", "TOKEN_MDB");
    client.set("simklAccessToken", "TOKEN_SIMKL");
    client.set("_providerSecretsInMemory", { "myListAddon:tmdbKey": "KEY_TMDB" });

    client.window.clearLocalAccountData();

    // In-memory tokens cleared
    assert.equal(client.get("activeCreator"), null);
    assert.equal(client.get("traktAccessToken"), "");
    assert.equal(client.get("mdblistAccessToken"), "");
    assert.equal(client.get("simklAccessToken"), "");
    assert.equal(Object.keys(client.get("_providerSecretsInMemory")).length, 0);

    // Storage cleared except UI tabs
    assert.equal(client.localStorage.getItem("myListAddon:creatorKey"), null);
    assert.equal(client.localStorage.getItem("localCustomLists"), null);
    assert.equal(client.localStorage.getItem("localChannels"), null);
    assert.equal(client.localStorage.getItem("myListAddon:activeTab"), "settings", "UI tab preserved");
  });

  it("CONFIRMED WORKING: runCatalogSearch discards out-of-order responses using sequence counter", async () => {
    let resolveQ1;
    const q1Promise = new Promise((r) => { resolveQ1 = r; });

    const client = loadClient({
      routes: {
        "/api/title-search": async (req) => {
          const url = new URL(req.url, "https://example.com");
          const q = url.searchParams.get("q");
          if (q === "slow") {
            await q1Promise;
            return { json: { ok: true, results: [{ title: "Slow Title", tmdbId: 1, type: "movie" }] } };
          }
          return { json: { ok: true, results: [{ title: "Fast Title", tmdbId: 2, type: "movie" }] } };
        },
        "/api/track-search": () => ({ json: { ok: true } }),
      },
    });

    const searchInput = client.document.getElementById("catalogSearchInput");
    const resultBox = client.document.getElementById("catalogSearchResult");

    // Query 1 starts
    searchInput.value = "slow";
    const p1 = client.window.runCatalogSearch();

    // Query 2 starts while Query 1 is in-flight
    searchInput.value = "fast";
    const p2 = client.window.runCatalogSearch();

    await p2;
    assert.ok(resultBox.innerHTML.includes("Fast Title"), "Result box has Fast Title");

    // Query 1 resolves later
    resolveQ1();
    await p1;

    // Sequence counter correctly prevented Query 1 from overwriting Query 2
    assert.ok(resultBox.innerHTML.includes("Fast Title"), "Result box retained Fast Title");
    assert.equal(resultBox.innerHTML.includes("Slow Title"), false, "Slow Title was discarded by sequence counter");
  });
});
