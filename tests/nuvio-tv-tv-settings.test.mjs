// A TV-only lineup (mirror off) keeps just its lists. The account's settings --
// Better Posters above all -- must still apply to what the launcher is served.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, makeD1, makeKv, call, accountProof } from "./harness.mjs";

async function account(env, name, main) {
  const proof = await accountProof(env, name);
  const entries = [{ id: "main_list", name: "Main", type: "movie" }];
  assert.equal((await call(env, "/api/save", { method: "POST", json: { ...proof, entries } })).status, 200);
  await env.CONFIGS.put(`creatorsync:${name}`, JSON.stringify({ config: entries, updatedAt: 1000, ...main }));
}
const tvOnly = (env, name) => env.CONFIGS.put(`creatorsync:${name}:tv`, JSON.stringify({
  mirror: false,
  entries: [{ id: "tv_list", name: "TV only", type: "movie" }],
  lists: [{ id: "tv_list", name: "TV only", type: "movie" }],
  catalogOrder: ["tv_list"],
  updatedAt: 2000,
}));

describe("TV-only lineup keeps the account's settings", () => {
  it("Better Posters still applies when the launcher has its own lists", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    await account(env, "tvset1", { betterPosters: true, betterPostersQuality: true });
    await tvOnly(env, "tvset1");
    const res = await call(env, "/api/nuvio-tv/sync/tvset1");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.catalogIds, ["tv_list"], "the TV lineup, not the main one");
    assert.equal(res.body.betterPosters, true);
    assert.equal(res.body.customPosterPattern, "https://example.test/bp/poster-q/{imdb_id}.jpg");
  });

  it("an account with Better Posters off stays off", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    await account(env, "tvset2", {});
    await tvOnly(env, "tvset2");
    const res = await call(env, "/api/nuvio-tv/sync/tvset2");
    assert.equal(res.body.betterPosters, false);
  });

  it("mirroring the main lineup is unchanged", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    await account(env, "tvset3", { betterPosters: true });
    const res = await call(env, "/api/nuvio-tv/sync/tvset3");
    assert.equal(res.body.betterPosters, true);
    assert.deepEqual(res.body.catalogIds, ["main_list"]);
  });
});
