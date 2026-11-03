// A full backup must bring everything back (audit TEST-12). The site notice
// tells every visitor to "Back up my data"; if the file silently dropped a
// part, people would only find out when restoring. This fills every part a
// backup holds, writes the file as JSON (as the download does), loads it into
// a brand-new browser and checks each part came back equal.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadClient } from "./client-harness.mjs";

const plain = (v) => JSON.parse(JSON.stringify(v));
const MOVIE = { id: "tt0133093", type: "movie", name: "The Matrix", poster: "https://img.example/m.jpg", year: "1999" };
const SHOW = { id: "tt0903747", type: "series", name: "Breaking Bad", poster: "https://img.example/bb.jpg", year: "2008" };

function fillEverything(c) {
  c.call("saveLocalCustomListsMap", {
    "my-favs": { slug: "my-favs", name: "My favs", type: "movie", items: [MOVIE] },
  });
  c.call("saveLocalChannelsMap", {
    ch_1: { channelId: "ch_1", name: "Crime night", type: "series", items: [SHOW] },
  });
  c.call("saveLocalMergedChannelsMap", {
    "merged-1": { mergedId: "merged-1", name: "Everything", channelIds: ["ch_1"] },
  });
  c.call("savePresetsMap", {
    "Friday preset": { name: "Friday preset", entries: [{ name: "My favs", url: "customlist:my-favs", type: "movie" }] },
  });
  c.call("saveCustomCollections", [
    { id: "col_a", name: "Folder A", lists: [{ name: "My favs", url: "tmdb:chart:disney", type: "movie" }] },
  ]);
  c.localStorage.setItem("myListAddon:region", "GB");
  c.localStorage.setItem("myListAddon:dedupeAcrossLists", "1");
  c.localStorage.setItem("myListAddon:hiddenLists", JSON.stringify(["x"]));
}

function snapshot(c) {
  return plain({
    lists: c.call("loadLocalCustomLists"),
    channels: c.call("loadLocalChannels"),
    merged: c.call("loadLocalMergedChannels"),
    collections: c.call("loadCustomCollections"),
    region: c.localStorage.getItem("myListAddon:region"),
    dedupe: c.localStorage.getItem("myListAddon:dedupeAcrossLists"),
    hidden: c.localStorage.getItem("myListAddon:hiddenLists"),
    presetNames: Object.keys(c.call("loadPresetsMap")),
  });
}

describe("full backup round trip", () => {
  it("restores custom lists, channels, merged channels, presets, collections and settings into a fresh browser", () => {
    const a = loadClient({ signedIn: true });
    fillEverything(a);
    const before = snapshot(a);
    const file = JSON.stringify(a.call("buildFullBackupPayload"));

    const b = loadClient({ signedIn: true });
    assert.equal(snapshot(b).lists["my-favs"], undefined, "fresh browser starts without the list");
    b.call("runImport", JSON.parse(file));
    const after = snapshot(b);

    assert.deepEqual(after.lists["my-favs"], before.lists["my-favs"]);
    assert.equal(after.lists["my-favs"].items[0].id, MOVIE.id);
    assert.deepEqual(after.channels.ch_1.items.map((i) => i.id), [SHOW.id]);
    assert.deepEqual(after.merged, before.merged);
    assert.deepEqual(after.presetNames, ["Friday preset"]);
    assert.deepEqual(after.collections, before.collections);
    assert.equal(after.region, "GB");
    assert.equal(after.dedupe, "1");
    assert.equal(after.hidden, before.hidden);
  });

  it("the file itself names every part (a dropped field is caught here, not at restore time)", () => {
    const a = loadClient({ signedIn: true });
    fillEverything(a);
    const file = plain(a.call("buildFullBackupPayload"));
    assert.deepEqual(Object.keys(file.customLists), ["my-favs"]);
    assert.deepEqual(Object.keys(file.channels), ["ch_1"]);
    assert.deepEqual(Object.keys(file.mergedChannels), ["merged-1"]);
    assert.deepEqual(Object.keys(file.presets), ["Friday preset"]);
    assert.equal(file.customCollections.length, 1);
  });

  it("still restores a file written by the previous release (2.0: rows embed their items)", () => {
    const old = {
      version: "2.0",
      exportedAt: "2026-10-01T00:00:00.000Z",
      entries: [],
      keys: {},
      customLists: { "old-list": { slug: "old-list", name: "Old list", type: "movie", items: [MOVIE] } },
      channels: { ch_old: { channelId: "ch_old", name: "Old channel", type: "series", items: [SHOW] } },
      mergedChannels: {},
      presets: {},
      customCollections: [],
      customCollectionGroups: [],
      settings: { region: "FR" },
    };
    const c = loadClient({ signedIn: true });
    c.call("runImport", old);
    const lists = plain(c.call("loadLocalCustomLists"));
    assert.equal(lists["old-list"].items[0].id, MOVIE.id);
    assert.equal(plain(c.call("loadLocalChannels")).ch_old.items[0].id, SHOW.id);
  });
});
