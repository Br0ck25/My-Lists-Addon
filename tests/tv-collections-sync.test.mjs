import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, makeD1, makeKv, call, createUser } from "./harness.mjs";

// The website keeps a signed-in account's collections in the browser. They are now also saved to the account, so the TV launcher
// (which reads /api/nuvio-tv/collections/<target>) shows what the account made, grouped the way the Collections page groups them.

const folder = (id, name, extra = {}) => ({
  id, name, tileShape: "LANDSCAPE", hideTitle: false, addonId: "app.my-list", coverImageUrl: "https://example.com/" + id + ".png",
  lists: [{ name: name + " Top 10", url: "tmdb:chart:" + id, type: "movie", addonId: "app.my-list", catalogId: "tmdb-chart-" + id }], ...extra,
});

async function setup() {
  const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
  const u = await createUser(env, "collector");
  return { env, cred: { creatorName: "collector", creatorKey: u.creatorKey } };
}

describe("TV collections: the account's own", () => {
  it("saves, and the launcher's list comes back grouped, marked own, with the website's cover pictures", async () => {
    const { env, cred } = await setup();
    const save = await call(env, "/api/creator/sync/save-collections", { method: "POST", json: {
      ...cred,
      customCollections: [folder("col_netflix", "Netflix"), folder("col_hulu", "Hulu"), folder("mine1", "My Picks", { parentCollectionId: "mine", parentCollectionName: "Mine" })],
      customCollectionGroups: [{ id: "col_mylists_streaming_services", name: "Streaming Services" }, { id: "mine", name: "Mine" }],
    }});
    assert.equal(save.status, 200, JSON.stringify(save.body));
    assert.equal(save.body.folders, 3);

    const r = await call(env, "/api/nuvio-tv/collections/collector");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const own = r.body.collections.filter((c) => c.own);
    assert.deepEqual(own.map((c) => c.title), ["Streaming Services", "Mine"]);
    assert.deepEqual(own[0].folders.map((f) => f.title), ["Netflix", "Hulu"]);
    assert.equal(own[0].folders[0].coverImageUrl, "https://example.com/col_netflix.png");
    assert.equal(own[0].folders[0].catalogSources[0].catalogId, "tmdb-chart-col_netflix");
    assert.deepEqual(own[1].folders.map((f) => f.title), ["My Picks"]);
    // The built-in set follows, never under an id the account's own collection already uses, and never marked own.
    const rest = r.body.collections.filter((c) => !c.own);
    assert.ok(rest.length > 0 && rest.every((c) => !own.some((o) => o.id === c.id)));
  });

  it("saving presets afterwards does not drop the collections", async () => {
    const { env, cred } = await setup();
    await call(env, "/api/creator/sync/save-collections", { method: "POST", json: { ...cred, customCollections: [folder("col_netflix", "Netflix")], customCollectionGroups: [] } });
    const p = await call(env, "/api/creator/sync/save-presets", { method: "POST", json: { ...cred, presets: { "Movie Night": { entries: [] } } } });
    assert.equal(p.status, 200);
    const load = await call(env, "/api/creator/sync/load", { method: "POST", json: cred });
    assert.equal(load.body.data.customCollections.length, 1);
    assert.ok(load.body.data.presets["Movie Night"], "the presets are still there");
  });

  it("saving collections leaves the presets alone", async () => {
    const { env, cred } = await setup();
    await call(env, "/api/creator/sync/save-presets", { method: "POST", json: { ...cred, presets: { Keep: { entries: [] } } } });
    await call(env, "/api/creator/sync/save-collections", { method: "POST", json: { ...cred, customCollections: [folder("a", "A")], customCollectionGroups: [] } });
    const load = await call(env, "/api/creator/sync/load", { method: "POST", json: cred });
    assert.ok(load.body.data.presets.Keep);
  });

  it("needs the account's key, and a list", async () => {
    const { env, cred } = await setup();
    const bad = await call(env, "/api/creator/sync/save-collections", { method: "POST", json: { creatorName: "collector", creatorKey: "nope", customCollections: [] } });
    assert.notEqual(bad.status, 200);
    const notList = await call(env, "/api/creator/sync/save-collections", { method: "POST", json: { ...cred, customCollections: "x" } });
    assert.equal(notList.status, 400);
  });

  it("an account with none of its own still gets only the built-in set, none marked own", async () => {
    const { env } = await setup();
    const r = await call(env, "/api/nuvio-tv/collections/collector");
    assert.ok(r.body.collections.length > 0);
    assert.ok(r.body.collections.every((c) => !c.own));
  });
});
