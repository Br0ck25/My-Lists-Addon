// My Channels on a paired Nuvio TV, through the TV's own secret address.
//
// Pairing hands the TV an install token (audit SEC-01/02, 2026-11-10), and the
// TV asks for everything with it: /api/nuvio-tv/sync/<token>,
// /api/nuvio-tv/schedules/<token>?channels=... and /i/<token>/tv/catalog/....
// The sync answer listed the account's channels, but the schedule and the
// catalog looked the channel up with the token compared to installs.token_hash,
// which holds only the token's hash, so they found no account: every channel
// came back "missing" with an empty lineup and the TV had nothing to play
// (owner report, 2026-11-16: Avatar, Saturday Classics Cartoons, The Complete
// Arrowverse Timeline). By username the same requests worked.
//
// The channels are in My Channels only, not in the account's catalogs: the
// launcher reads them from the sync answer, not from the manifest.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeEnv, makeD1, makeKv, call, accountProof } from "./harness.mjs";

const item = (n) => ({ kind: "episode", imdbId: "tt0460681", season: 1, episode: n, showName: "Supernatural", epName: "E" + n, title: "", runtime: 42 });
const CHANNELS = {
  chavatar1: { channelId: "chavatar1", name: "Avatar", items: [item(1), item(2)], order: 0 },
  chsat2: { channelId: "chsat2", name: "Saturday Classics Cartoons", items: [item(3)], order: 1 },
  ch23est7srcpo7: { channelId: "ch23est7srcpo7", name: "The Complete Arrowverse Timeline", items: [item(4), item(5)], order: 2 },
};
const IDS = Object.keys(CHANNELS);

async function pairedTv(name) {
  const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), FF_INSTALLS: "1" });
  const proof = await accountProof(env, name);
  const saved = await call(env, "/api/creator/sync/save-channels", { method: "POST", json: { creatorName: name, creatorKey: proof.creatorKey, channels: CHANNELS, mergedChannels: {} } });
  assert.equal(saved.status, 200, saved.text);
  const code = await call(env, "/api/nuvio-tv/device/code", { method: "POST" });
  const claim = await call(env, "/api/nuvio-tv/device/claim", { method: "POST", json: { userCode: code.body.userCode, creatorName: name, creatorKey: proof.creatorKey } });
  assert.equal(claim.status, 200, claim.text);
  const token = new URL(claim.body.syncUrl).pathname.split("/").pop();
  const base = new URL(claim.body.manifestUrl).pathname.replace(/manifest\.json$/, "");
  return { env, token, base, proof };
}

describe("My Channels on a paired Nuvio TV, by the TV's secret address", () => {
  it("the sync answer lists each channel with id, name and catalogId, ok, features and an ETag", async () => {
    const { env, token } = await pairedTv("chsync");
    const r = await call(env, `/api/nuvio-tv/sync/${token}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.ok, true);
    assert.deepEqual(r.body.features, ["etag", "schedule", "schedules"]);
    assert.ok(r.headers.get("etag"), "ETag header");
    assert.deepEqual(r.body.channels.map((c) => [c.id, c.name, c.catalogId]), [
      ["chavatar1", "Avatar", "channel_chavatar1"],
      ["chsat2", "Saturday Classics Cartoons", "channel_chsat2"],
      ["ch23est7srcpo7", "The Complete Arrowverse Timeline", "channel_ch23est7srcpo7"],
    ]);
    assert.ok(r.body.channels.every((c) => !c.id.startsWith("ch_preset_")), "the account's own channels, not the presets");
  });

  it("the schedules route answers every channel with timed programmes of the exact episodes", async () => {
    const { env, token } = await pairedTv("chsched");
    const r = await call(env, `/api/nuvio-tv/schedules/${token}?channels=${IDS.join(",")}`, { ip: "198.51.100.21" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.ok, true);
    assert.deepEqual(r.body.missing, [], "no channel missing");
    assert.deepEqual(Object.keys(r.body.schedules).sort(), [...IDS].sort());
    const first = r.body.schedules.chavatar1[0];
    assert.match(first.videoId, /^tt0460681:1:[12]$/, "exact-episode id");
    assert.ok(first.endMs > first.startMs, "ends after it starts");
    assert.equal(first.endMs - first.startMs, 42 * 60000, "the episode's own runtime");
  });

  it("the one-channel schedule route works too", async () => {
    const { env, token } = await pairedTv("chone");
    const r = await call(env, `/api/nuvio-tv/schedule/${token}/ch23est7srcpo7`, { ip: "198.51.100.22" });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.body.slots.length > 0);
    assert.match(r.body.slots[0].videoId, /^tt0460681:1:[45]$/);
  });

  it("the catalog fallback returns the channel's episodes, not nothing", async () => {
    const { env, base } = await pairedTv("chcat");
    for (const type of ["series", "tv"]) {
      const r = await call(env, `${base}catalog/${type}/channel_chsat2.json`, { ip: "198.51.100.23" });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.body.metas.map((m) => m.id), ["tt0460681:1:3"], type);
    }
  });

  it("an addon link saved while signed in counts as the account on sync, schedules and catalog (no pairing)", async () => {
    // The launcher can also be given a plain addon link (/<id>/manifest.json). A link
    // saved while signed in carries the account's id and creation time (ownerId,
    // ownerSince); the sync answer found the account by it, but the schedule and the
    // catalog did not, so the channels were listed with nothing to play.
    const { env, proof } = await pairedTv("chlink");
    const saved = await call(env, "/api/save", { method: "POST", json: { entries: [{ id: "trend", url: "tmdb:chart:trending", name: "Trending", type: "movie" }], creatorName: "chlink", creatorKey: proof.creatorKey } });
    assert.equal(saved.status, 200, saved.text);
    const id = saved.body.id;
    const sync = await call(env, `/api/nuvio-tv/sync/${id}`);
    assert.deepEqual(sync.body.channels.map((c) => c.id), IDS);
    const sched = await call(env, `/api/nuvio-tv/schedules/${id}?channels=${IDS.join(",")}`, { ip: "198.51.100.25" });
    assert.deepEqual(sched.body.missing, []);
    assert.deepEqual(Object.keys(sched.body.schedules).sort(), [...IDS].sort());
    const cat = await call(env, `/${id}/tv/catalog/series/channel_chsat2.json`, { ip: "198.51.100.26" });
    assert.deepEqual(cat.body.metas.map((m) => m.id), ["tt0460681:1:3"]);
  });

  it("an addon link that proves no account (saved signed out) does not read anyone's channels", async () => {
    const { env } = await pairedTv("chanon");
    const saved = await call(env, "/api/save", { method: "POST", json: { entries: [{ id: "trend", url: "tmdb:chart:trending", name: "Trending", type: "movie" }] } });
    const id = saved.body.id;
    const sync = await call(env, `/api/nuvio-tv/sync/${id}`);
    assert.ok(sync.body.channels.every((c) => c.id.startsWith("ch_preset_")), "only the presets");
    const sched = await call(env, `/api/nuvio-tv/schedules/${id}?channels=chavatar1`, { ip: "198.51.100.27" });
    assert.deepEqual(sched.body.schedules, {});
  });

  it("an owner stamp for an account id that was reused does not count", async () => {
    const { env, proof } = await pairedTv("chreuse");
    const saved = await call(env, "/api/save", { method: "POST", json: { entries: [{ id: "trend", url: "tmdb:chart:trending", name: "Trending", type: "movie" }], creatorName: "chreuse", creatorKey: proof.creatorKey } });
    // The account is now a different one under the same id (created at another time).
    env.DB._db.prepare("UPDATE accounts SET created_at = created_at + 1 WHERE username = 'chreuse'").run();
    const sync = await call(env, `/api/nuvio-tv/sync/${saved.body.id}`);
    assert.ok(sync.body.channels.every((c) => c.id.startsWith("ch_preset_")), "the stamp no longer matches the account");
    const sched = await call(env, `/api/nuvio-tv/schedules/${saved.body.id}?channels=chavatar1`, { ip: "198.51.100.28" });
    assert.deepEqual(sched.body.schedules, {});
  });

  it("a revoked TV address no longer reads the channels", async () => {
    const { env, token } = await pairedTv("chrevoked");
    env.DB._db.prepare("UPDATE installs SET revoked_at = 1 WHERE scopes LIKE '%tv%'").run();
    const r = await call(env, `/api/nuvio-tv/schedules/${token}?channels=chavatar1`, { ip: "198.51.100.24" });
    assert.deepEqual(r.body.schedules || {}, {});
  });
});
