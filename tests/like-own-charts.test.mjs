import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Liking this add-on's own charts used to answer "That URL can't be liked".

const { accountProof, makeKv, makeD1, makeEnv, call } = await import("./harness.mjs");

async function like(env, proof, url, action) {
  return call(env, "/api/lists/like-external", { method: "POST", json: { ...proof, url, action } });
}

describe("liking this add-on's own charts", () => {
  const COMBINED = "tmdb:chart:trending\ntrakt:chart:trending\nsimkl:chart:today\nsimkl:chart:week\nsimkl:chart:month";
  for (const url of [
    "mylists:most-watched:today",
    "mylists:most-watched:30",
    "tmdb:new-on-streaming",
    COMBINED,
  ]) {
    it(`likes and unlikes ${JSON.stringify(url).slice(0, 48)}`, async () => {
      const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
      const proof = await accountProof(env);
      const liked = await like(env, proof, url, "like");
      assert.equal(liked.body.ok, true, JSON.stringify(liked.body));
      assert.equal(liked.body.likes, 1);
      const unliked = await like(env, proof, url, "unlike");
      assert.equal(unliked.body.ok, true);
      assert.equal(unliked.body.likes, 0);
    });
  }

  it("still refuses a link that is not a list", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    const r = await like(env, await accountProof(env), "https://evil.example/x", "like");
    assert.equal(r.status, 400);
    assert.match(r.body.error, /own charts/);
  });
});
