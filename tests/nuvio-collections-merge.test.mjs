// The page sends its folders and the server merges them into the person's Nuvio
// collections (src/api/61_media-app-sync.js mergeNuvioCollections). These cases
// used to run against a page copy that nothing called (CQ-04); they now run
// against the one copy the product uses.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import "./harness.mjs"; // refuses to run against a stale build

const bundle = readFileSync(new URL("../worker_entry_combined.js", import.meta.url), "utf8");
const tmpFile = `${tmpdir()}/mla-nuviomerge-${process.pid}-${Date.now()}.mjs`;
writeFileSync(tmpFile, bundle + "\nexport const __m = { mergeNuvioCollections };\n");
const { __m } = await import(pathToFileURL(tmpFile).href).finally(() => unlinkSync(tmpFile));
const merge = __m.mergeNuvioCollections;

describe("mergeNuvioCollections (server)", () => {
  it("mergeNuvioCollections preserves existing Nuvio collections when pushing new folders", () => {
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

    const merged = merge(existingNuvio, incomingPush);
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

    const afterApple = merge([], applePush);
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

    const afterDisney = merge(nuvioRpcExisting, disneyPush);
    assert.ok(Array.isArray(afterDisney));
    assert.strictEqual(afterDisney.length, 1, "Should remain 1 collection");
    assert.strictEqual(afterDisney[0].folders.length, 2, "Should contain both Apple TV+ and Disney+ folders");
    const folderTitles = afterDisney[0].folders.map((f) => f.title);
    assert.ok(folderTitles.includes("Apple TV+"), "Apple TV+ must be preserved");
    assert.ok(folderTitles.includes("Disney+"), "Disney+ must be present");

    // 4. Empty collections are retained: they may be intentional.
    const withCorruptedEmpty = [
      { id: "corrupted_empty", folders: [] },
      ...afterDisney
    ];
    const cleaned = merge(withCorruptedEmpty, []);
    assert.strictEqual(cleaned.length, 2);
    assert.ok(cleaned.some((c) => c.id === "corrupted_empty"));
    assert.ok(cleaned.some((c) => c.id === "my-lists-collections" || c.id === "my-lists-streaming"));

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
    const mergedWithCommunity = merge(communityStreaming, myListsIncoming);
    assert.strictEqual(mergedWithCommunity.length, 2, "Must contain exactly 2 separate collections");
    const preservedStreaming = mergedWithCommunity.find((c) => c.id === "collection-a33b28eb-community");
    assert.ok(preservedStreaming, "Community Streaming collection must be preserved");
    assert.strictEqual(preservedStreaming.folders.length, 3, "Community Streaming folders must NOT be altered");
    const preservedMyLists = mergedWithCommunity.find((c) => c.id === "my-lists-collections");
    assert.ok(preservedMyLists, "My Lists Collections must be present");
    assert.strictEqual(preservedMyLists.folders.length, 1, "My Lists Collections must contain only its own folder");
    assert.strictEqual(preservedMyLists.folders[0].title, "Apple TV+");
  });
});
