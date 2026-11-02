import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { call, makeEnv, accountProof } from "./harness.mjs";

// A synced channel map holds only object entries. One null entry saved here
// is loaded by every signed-in device, so it is dropped before it is stored.

describe("sync/save-channels keeps only object entries", () => {
  it("drops null and non-object entries from channels and mergedChannels", async () => {
    const env = makeEnv();
    const K = await accountProof(env, "shapeuser");
    const saved = await call(env, "/api/creator/sync/save-channels", {
      method: "POST",
      json: { ...K, channels: { a: null, b: { name: "B" }, c: 5, d: [1] }, mergedChannels: { m: null, n: { name: "N" } } },
    });
    assert.equal(saved.body.ok, true);
    const loaded = await call(env, "/api/creator/sync/load", { method: "POST", json: { ...K } });
    assert.deepEqual(Object.keys(loaded.body.data.channels), ["b"]);
    assert.deepEqual(Object.keys(loaded.body.data.mergedChannels), ["n"]);
  });

  it("treats an array as an empty map", async () => {
    const env = makeEnv();
    const K = await accountProof(env, "shapeuser2");
    await call(env, "/api/creator/sync/save-channels", {
      method: "POST", json: { ...K, channels: [null, { name: "X" }], mergedChannels: [null] },
    });
    const raw = JSON.parse(env.CONFIGS._store.get("creatorsyncchannels:shapeuser2"));
    assert.deepEqual(raw.channels, {});
    assert.deepEqual(raw.mergedChannels, {});
  });
});
