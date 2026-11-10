// How many plays a Plex, Jellyfin or Emby viewing leaves in the activity database (API-01).
//
// One viewing sends several events over its length (play, pause, resume, scrobble, stop).
// Owner decision (2026-11-10): a title counts as watched only when it is finished (Plex
// "media.scrobble" at about 90%, Jellyfin and Emby "played to completion"); stopping early
// only saves the place. The field names are the ones each service documents, not captured
// from a live server (see tests/playback-positions.test.mjs).
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { call, createUser, makeD1, makeEnv, makeKv, nextIp } from "./harness.mjs";

const realNow = Date.now;
let clock = 0;
afterEach(() => { Date.now = realNow; });

async function setup(name) {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1(), DB_ACTIVITY: makeD1({ schema: "activity" }) });
  const u = await createUser(env, name);
  const accountId = env.DB._db.prepare("SELECT id FROM accounts WHERE username = ? COLLATE NOCASE").get(name).id;
  env.DB._db.prepare("INSERT INTO jobs (type, dedupe_key, account_id, status, run_after, created_at, updated_at) VALUES ('migrate.activity', ?, ?, 'done', 0, 0, 0)").run(`migrate.activity:acct:${accountId}`, accountId);
  const tok = await call(env, "/api/creator/scrobble-token", { method: "POST", ip: nextIp(), json: { creatorName: u.creatorName, creatorKey: u.creatorKey } });
  clock = realNow.call(Date);
  Date.now = () => clock;
  return { env, token: tok.body.token };
}

const MIN = 60 * 1000;
// Sends each event, moving the clock on by `afterMin` minutes first.
async function viewing(ctx, steps) {
  for (const [afterMin, payload] of steps) {
    clock += afterMin * MIN;
    const r = await call(ctx.env, "/api/scrobble?st=" + encodeURIComponent(ctx.token), { method: "POST", ip: nextIp(), json: payload });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
}
const plays = (ctx) => ctx.env.DB_ACTIVITY._db.prepare("SELECT COUNT(*) AS c FROM watch_events").get().c;
const watchedCount = (ctx) => (ctx.env.DB_ACTIVITY._db.prepare("SELECT watched_count FROM user_media_state").get() || {}).watched_count || 0;
const positions = (ctx) => ctx.env.DB_ACTIVITY._db.prepare("SELECT position_ms, duration_ms FROM watch_positions").all().map((r) => [r.position_ms, r.duration_ms]);

const TWO_HOURS = 7200000;
const plex = (event, viewOffset) => ({ event, Account: { title: "owner" }, Metadata: { type: "movie", title: "Movie P", guid: "imdb://tt1010101", Guid: [{ id: "imdb://tt1010101" }], viewOffset, duration: TWO_HOURS } });
const TICKS = 10000;
const jelly = (type, extra = {}) => ({ NotificationType: type, ItemType: "Movie", Name: "Movie J", NotificationUsername: "owner", Provider_imdb: "tt3030303", RunTimeTicks: TWO_HOURS * TICKS, ...extra });
const emby = (event, info) => ({ Event: event, User: { Name: "owner" }, Item: { Type: "Movie", Name: "Movie E", ProviderIds: { Imdb: "tt4040404" }, RunTimeTicks: TWO_HOURS * TICKS }, PlaybackInfo: info });

describe("API-01: a media server viewing is one play, counted when it is finished", () => {
  it("Plex: play, pause, resume, scrobble and stop over two hours leave one play", async () => {
    const ctx = await setup("playsplex");
    await viewing(ctx, [
      [0, plex("media.play", 0)], [40, plex("media.pause", 2400000)], [20, plex("media.resume", 2400000)],
      [60, plex("media.scrobble", 6600000)], [10, plex("media.stop", 7000000)],
    ]);
    assert.equal(plays(ctx), 1, "one row in Watch History");
    assert.equal(watchedCount(ctx), 1, "play count 1");
  });

  it("Plex: stopping at 10 minutes of 120 is not a play, but saves the place", async () => {
    const ctx = await setup("playsplexearly");
    await viewing(ctx, [[0, plex("media.play", 0)], [10, plex("media.stop", 600000)]]);
    assert.equal(plays(ctx), 0);
    assert.deepEqual(positions(ctx), [[600000, TWO_HOURS]]);
  });

  it("Jellyfin: only PlaybackStop with PlayedToCompletion counts; an early stop saves the place", async () => {
    const ctx = await setup("playsjelly");
    await viewing(ctx, [
      [0, jelly("PlaybackStart", { PlaybackPositionTicks: 0 })], [30, jelly("PlaybackProgress", { PlaybackPositionTicks: 1800000 * TICKS })],
      [20, jelly("PlaybackStop", { PlaybackPositionTicks: 3000000 * TICKS, PlayedToCompletion: false })],
    ]);
    assert.equal(plays(ctx), 0, "stopping part way is not a play");
    assert.deepEqual(positions(ctx), [[3000000, TWO_HOURS]]);
    await viewing(ctx, [[60, jelly("PlaybackStop", { PlaybackPositionTicks: 6900000 * TICKS, PlayedToCompletion: true })]]);
    assert.equal(plays(ctx), 1);
    assert.equal(watchedCount(ctx), 1);
  });

  it("Emby: only playback.stop with PlayedToCompletion counts; an early stop saves the place", async () => {
    const ctx = await setup("playsemby");
    await viewing(ctx, [
      [0, emby("playback.start", { PositionTicks: 0 })],
      [20, emby("playback.stop", { PositionTicks: 3000000 * TICKS, PlayedToCompletion: false })],
    ]);
    assert.equal(plays(ctx), 0);
    assert.deepEqual(positions(ctx), [[3000000, TWO_HOURS]]);
    await viewing(ctx, [[60, emby("playback.stop", { PositionTicks: 6900000 * TICKS, PlayedToCompletion: true })]]);
    assert.equal(plays(ctx), 1);
    assert.equal(watchedCount(ctx), 1);
  });
});
