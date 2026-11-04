// UI-02: a remembered sub-tab name the page no longer knows must not leave
// Discover, Catalogs or Channels blank. The first script of the page checks each
// remembered name against the pills that exist and forgets one that is not there.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadClient } from "./client-harness.mjs";

const stored = (key, value) => loadClient({ storage: { [key]: value } }).localStorage.getItem(key);

describe("remembered sub-tabs", () => {
  for (const [key, bad, fallback] of [
    ["myListAddon:discoverSubmenu", "trending", "movie"],
    ["myListAddon:catalogsSubmenu", "123", "all"],
    ["myListAddon:catalogsSubmenu", "shelves", "all"],
    ["myListAddon:channelsSubmenu", "gone", "my-channels"],
  ]) {
    it(`${key} = "${bad}" falls back to "${fallback}"`, () => {
      assert.equal(stored(key, bad), fallback);
    });
  }

  it("names that have a pill are kept", () => {
    assert.equal(stored("myListAddon:discoverSubmenu", "genres"), "genres");
    assert.equal(stored("myListAddon:catalogsSubmenu", "bulk"), "bulk");
    assert.equal(stored("myListAddon:channelsSubmenu", "explore"), "explore");
  });

  it("the channel builder stays a valid name when signed in", () => {
    const c = loadClient({ storage: { "myListAddon:creatorName": "alice", "myListAddon:channelsSubmenu": "build" } });
    assert.equal(c.localStorage.getItem("myListAddon:channelsSubmenu"), "build");
  });
});
