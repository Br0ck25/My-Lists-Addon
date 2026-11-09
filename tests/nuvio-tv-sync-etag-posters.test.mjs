// The Nuvio TV Launcher polls /api/nuvio-tv/sync/:target every few minutes.
// Two things it used to do the hard way:
//  - ask "did anything change?" by downloading the whole payload (now a 304
//    when it sends the ETag back), and
//  - find out whether Better Posters is on by downloading a catalog and
//    searching it for "/bp/" (now answered in the payload itself).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, makeD1, makeKv, call, accountProof } from "./harness.mjs";

// An account as the launcher sees it: saved, with the builder's live copy of
// its config in KV (creatorsync:<name>), which is where the poster settings are
// read from for a TV Launcher sync.
async function savedUser(env, name, extra = {}) {
  const proof = await accountProof(env, name);
  const entries = [{ id: "custom_movie_list", name: "Movies", type: "movie" }];
  const res = await call(env, "/api/save", { method: "POST", json: { ...proof, entries, ...extra } });
  assert.equal(res.status, 200);
  await env.CONFIGS.put(`creatorsync:${name}`, JSON.stringify({ config: entries, updatedAt: 1000, ...extra }));
}

describe("sync route: ETag and conditional requests", () => {
  it("a user target answers with an ETag that is its versionHash", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    await savedUser(env, "etaguser");
    const res = await call(env, "/api/nuvio-tv/sync/etaguser");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("ETag"), `"${res.body.versionHash}"`);
    // Still never stored by a shared cache: the launcher keeps the tag itself.
    assert.match(res.headers.get("Cache-Control"), /no-store/);
  });

  it("answers 304 with no body when If-None-Match is the current tag", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    await savedUser(env, "etaguser2");
    const first = await call(env, "/api/nuvio-tv/sync/etaguser2");
    const etag = first.headers.get("ETag");
    const again = await call(env, "/api/nuvio-tv/sync/etaguser2", { headers: { "If-None-Match": etag } });
    assert.equal(again.status, 304);
    assert.equal(again.text, "");
    assert.equal(again.headers.get("ETag"), etag);
  });

  it("accepts a weakened tag, a list of tags and *", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    await savedUser(env, "etaguser3");
    const etag = (await call(env, "/api/nuvio-tv/sync/etaguser3")).headers.get("ETag");
    for (const inm of [`W/${etag}`, `"other", ${etag}`, "*"]) {
      const res = await call(env, "/api/nuvio-tv/sync/etaguser3", { headers: { "If-None-Match": inm } });
      assert.equal(res.status, 304, inm);
    }
  });

  it("sends the full payload again once something changed", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    await savedUser(env, "etaguser4");
    const etag = (await call(env, "/api/nuvio-tv/sync/etaguser4")).headers.get("ETag");
    await env.CONFIGS.put("creatorsyncchannels:etaguser4", JSON.stringify([{ id: "ch_new", name: "New", category: "Personal" }]));
    const res = await call(env, "/api/nuvio-tv/sync/etaguser4", { headers: { "If-None-Match": etag } });
    assert.equal(res.status, 200);
    assert.notEqual(res.headers.get("ETag"), etag);
    assert.ok(res.body.channels.some((c) => c.id === "ch_new"));
  });

  it("the default target supports the same revalidation", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const first = await call(env, "/api/nuvio-tv/sync/default");
    const etag = first.headers.get("ETag");
    assert.equal(etag, `"${first.body.versionHash}"`);
    const again = await call(env, "/api/nuvio-tv/sync/default", { headers: { "If-None-Match": etag } });
    assert.equal(again.status, 304);
  });
});

describe("sync route: Better Posters", () => {
  it("says false (and sends no pattern) when the account has it off", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    await savedUser(env, "bpoff");
    const res = await call(env, "/api/nuvio-tv/sync/bpoff");
    assert.equal(res.body.betterPosters, false);
    assert.equal(res.body.customPosterPattern, undefined);
  });

  it("says true with this Worker's own poster URL pattern when it is on", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    await savedUser(env, "bpon", { betterPosters: true });
    const res = await call(env, "/api/nuvio-tv/sync/bpon");
    assert.equal(res.body.betterPosters, true);
    assert.equal(res.body.customPosterPattern, "https://example.test/bp/poster/{imdb_id}.jpg");
  });

  it("follows the style the account chose", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    await savedUser(env, "bpstyle", { betterPosters: true, betterPostersRating: false, betterPostersQuality: true });
    const res = await call(env, "/api/nuvio-tv/sync/bpstyle");
    assert.equal(res.body.customPosterPattern, "https://example.test/bp/poster-gq/{imdb_id}.jpg");
  });

  it("a change of poster style changes the versionHash, so the launcher re-syncs", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    await savedUser(env, "bphash", { betterPosters: true });
    const before = (await call(env, "/api/nuvio-tv/sync/bphash")).body.versionHash;
    await env.CONFIGS.put("creatorsync:bphash", JSON.stringify({
      config: [{ id: "custom_movie_list", name: "Movies", type: "movie" }],
      updatedAt: 1000,
      betterPosters: true,
      betterPostersQuality: true,
    }));
    const after = (await call(env, "/api/nuvio-tv/sync/bphash")).body.versionHash;
    assert.notEqual(before, after);
  });
});
