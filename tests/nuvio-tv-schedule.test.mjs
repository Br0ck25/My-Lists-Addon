// One schedule per channel, kept by the Worker, so every device on an account
// shows the same guide. See src/api/29_nuvio-tv-schedule.js.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, makeD1, makeKv, call, accountProof, freshIsolate } from "./harness.mjs";

const MIN = 60000;
const ep = (n, runtime) => ({ kind: "episode", imdbId: "tt0108778", season: 1, episode: n, showName: "Friends", epName: `Ep ${n}`, title: `Friends S1E${n}`, runtime });
const movie = (id, name, runtime) => ({ kind: "movie", imdbId: id, title: name, runtime });

async function userWithChannel(env, name, items) {
  const proof = await accountProof(env, name);
  const saved = await call(env, "/api/save", { method: "POST", json: { ...proof, entries: [{ id: "custom_movie_list", name: "Movies", type: "movie" }] } });
  assert.equal(saved.status, 200);
  await putChannel(env, name, items);
}
async function putChannel(env, name, items) {
  await env.CONFIGS.put(`creatorsyncchannels:${name}`, JSON.stringify({
    channels: { ch_sched: { id: "ch_sched", channelId: "ch_sched", name: "Sched", items } },
    updatedAt: Date.now(),
  }));
}
const get = (env, path, opts) => call(env, path, opts);

describe("nuvio tv schedule", () => {
  it("lays the lineup end to end from now, covering the next day", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    await userWithChannel(env, "sched1", [ep(1, 22), ep(2, 22), movie("tt0133093", "The Matrix", 136)]);
    const before = Date.now();
    const res = await get(env, "/api/nuvio-tv/schedule/sched1/ch_sched");
    assert.equal(res.status, 200);
    const { slots } = res.body;
    assert.ok(slots.length > 3);
    assert.ok(slots[0].startMs <= before && slots[0].endMs > before, "a programme is airing now");
    assert.equal(slots[0].startMs % (5 * MIN), 0, "starts on a five-minute mark");
    for (let i = 1; i < slots.length; i++) assert.equal(slots[i].startMs, slots[i - 1].endMs, "no gaps or overlaps");
    assert.ok(slots[slots.length - 1].endMs >= before + 24 * 60 * MIN, "covers at least a day ahead");
    assert.deepEqual(slots.slice(0, 3).map((s) => s.endMs - s.startMs), [22 * MIN, 22 * MIN, 136 * MIN]);
    assert.equal(slots[0].title, "Friends · S1E1 Ep 1");
    assert.equal(slots[2].type, "movie");
    assert.equal(slots[2].videoId, "tt0133093");
  });

  it("is the same schedule on every request and every isolate", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    await userWithChannel(env, "sched2", [ep(1, 22), ep(2, 22)]);
    const a = await get(env, "/api/nuvio-tv/schedule/sched2/ch_sched");
    const b = await get(env, "/api/nuvio-tv/schedule/sched2/ch_sched");
    const c = await get(env, "/api/nuvio-tv/schedule/sched2/ch_sched", { w: await freshIsolate() });
    assert.deepEqual(b.body.slots, a.body.slots);
    assert.deepEqual(c.body.slots, a.body.slots);
    assert.equal(c.body.versionHash, a.body.versionHash);
  });

  it("keeps the programme airing now when the channel is edited, and rebuilds what follows", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    await userWithChannel(env, "sched3", [ep(1, 22), ep(2, 22), ep(3, 22)]);
    const first = (await get(env, "/api/nuvio-tv/schedule/sched3/ch_sched")).body.slots;
    const now = Date.now();
    const airing = first.find((s) => s.startMs <= now && s.endMs > now);
    // A new pick goes to the front and the others are dropped.
    await putChannel(env, "sched3", [movie("tt0133093", "The Matrix", 136), ep(9, 30)]);
    const after = (await get(env, "/api/nuvio-tv/schedule/sched3/ch_sched", { w: await freshIsolate() })).body.slots;
    const airingAfter = after.find((s) => s.startMs <= now && s.endMs > now);
    assert.deepEqual(airingAfter, airing, "what is on air is untouched");
    const next = after[after.indexOf(airingAfter) + 1];
    assert.equal(next.startMs, airing.endMs, "the new lineup follows the programme on air");
    assert.equal(next.videoId, "tt0133093");
    assert.ok(after.every((s) => s.endMs <= airing.endMs || ["tt0133093", "tt0108778:1:9"].includes(s.videoId)), "nothing of the old lineup is left after it");
    // And what had already aired is as it was.
    for (const past of first.filter((s) => s.endMs <= now)) assert.ok(after.some((s) => s.startMs === past.startMs && s.videoId === past.videoId));
  });

  it("a pick with no runtime gets the default for its kind", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    await userWithChannel(env, "sched4", [ep(1), movie("tt0133093", "The Matrix")]);
    const { slots } = (await get(env, "/api/nuvio-tv/schedule/sched4/ch_sched")).body;
    assert.deepEqual(slots.slice(0, 2).map((s) => (s.endMs - s.startMs) / MIN), [45, 100]);
  });

  it("revalidates with the tag, and answers 404 for what it does not know", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    await userWithChannel(env, "sched5", [ep(1, 22)]);
    const first = await get(env, "/api/nuvio-tv/schedule/sched5/ch_sched");
    const etag = first.headers.get("ETag");
    assert.equal(etag, `"${first.body.versionHash}"`);
    assert.equal((await get(env, "/api/nuvio-tv/schedule/sched5/ch_sched", { headers: { "If-None-Match": etag } })).status, 304);
    assert.equal((await get(env, "/api/nuvio-tv/schedule/sched5/ch_nope")).status, 404);
    assert.equal((await get(env, "/api/nuvio-tv/schedule/nobody-here/ch_sched")).status, 404);
  });

  it("an account whose channel lineup is empty has no schedule to serve", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    await userWithChannel(env, "sched6", []);
    assert.equal((await get(env, "/api/nuvio-tv/schedule/sched6/ch_sched")).status, 404);
  });

  it("the batch route gives every channel's schedule in one request, same as asking one by one", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const proof = await accountProof(env, "sched7");
    assert.equal((await call(env, "/api/save", { method: "POST", json: { ...proof, entries: [{ id: "x", name: "X", type: "movie" }] } })).status, 200);
    await env.CONFIGS.put("creatorsyncchannels:sched7", JSON.stringify({
      channels: {
        ch_a: { id: "ch_a", channelId: "ch_a", name: "A", items: [ep(1, 22), ep(2, 22)] },
        ch_b: { id: "ch_b", channelId: "ch_b", name: "B", items: [movie("tt0133093", "The Matrix", 136)] },
      },
      updatedAt: Date.now(),
    }));
    const batch = await get(env, "/api/nuvio-tv/schedules/sched7?channels=ch_a,ch_b,ch_nope,channel_ch_a");
    assert.equal(batch.status, 200);
    assert.deepEqual(Object.keys(batch.body.schedules).sort(), ["ch_a", "ch_b"], "a repeated id is one entry; channel_ is stripped");
    assert.deepEqual(batch.body.missing, ["ch_nope"], "an unknown channel is listed, not an error");
    for (const id of ["ch_a", "ch_b"]) {
      const single = await get(env, `/api/nuvio-tv/schedule/sched7/${id}`);
      assert.deepEqual(batch.body.schedules[id], single.body.slots, `${id} is the same schedule either way`);
    }
    // One tag for the lot, and a bare 304 when nothing moved.
    const etag = batch.headers.get("ETag");
    assert.equal(etag, `"${batch.body.versionHash}"`);
    assert.equal((await get(env, "/api/nuvio-tv/schedules/sched7?channels=ch_a,ch_b,ch_nope,channel_ch_a", { headers: { "If-None-Match": etag } })).status, 304);
  });

  it("the batch route asks for at most a bounded number of channels and needs some", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    assert.equal((await get(env, "/api/nuvio-tv/schedules/nobody")).status, 404);
    const many = Array.from({ length: 80 }, (_, i) => `c${i}`).join(",");
    const res = await get(env, `/api/nuvio-tv/schedules/nobody?channels=${many}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.missing.length, 40, "capped, so one request cannot fan out without limit");
  });
});
