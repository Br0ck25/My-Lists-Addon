import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadClient } from "./client-harness.mjs";

// One null (or non-object) entry in the saved channel maps used to throw inside
// renderChannelMergeList and stop the whole page script, on every device the
// bad entry synced to. The two loaders now keep only object entries.

const plain = (v) => JSON.parse(JSON.stringify(v));
const good = { channelId: "b", name: "Good", items: [], updatedAt: 5 };
const goodMerged = { mergedId: "m1", name: "GoodMerged", channelIds: [], updatedAt: 5 };

describe("client: bad entries in the saved channel maps", () => {
  for (const shape of ["map", "array"]) {
    it("loadLocalChannels drops a null entry (" + shape + ")", () => {
      const raw = shape === "map" ? { a: null, b: good } : [null, good];
      const client = loadClient({ signedIn: true, storage: { "myListAddon:localChannels": JSON.stringify(raw) } });
      const map = plain(client.call("loadLocalChannels"));
      assert.equal(map.a, undefined);
      if (shape === "map") assert.equal(map.b.name, "Good");
      assert.equal(Array.isArray(map), false);
      assert.doesNotThrow(() => client.call("renderChannelMergeList"));
    });
    it("loadLocalMergedChannels drops a null entry (" + shape + ")", () => {
      const raw = shape === "map" ? { a: null, m1: goodMerged } : [null, goodMerged];
      const client = loadClient({ signedIn: true, storage: { "myListAddon:localMergedChannels": JSON.stringify(raw) } });
      const map = plain(client.call("loadLocalMergedChannels"));
      assert.equal(map.a, undefined);
      if (shape === "map") assert.equal(map.m1.name, "GoodMerged");
      assert.equal(Array.isArray(map), false);
      assert.doesNotThrow(() => client.call("renderChannelMergeList"));
    });
  }
});
