import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { call, createUser, makeEnv } from "./harness.mjs";

// PERF-04 (audit 2026-11-10): every media-server webhook, even an ignored pause, rewrote
// scrobbleseenusers:<account> with lastSeen = now. A user already listed and seen within
// the last hour must not cause another KV write; a new user or a stale entry still must.

async function setup() {
  const env = makeEnv();
  const user = await createUser(env, "seenuser");
  const tok = await call(env, "/api/creator/scrobble-token", { method: "POST", json: { creatorName: user.creatorName, creatorKey: user.creatorKey } });
  assert.equal(tok.body.ok, true);
  const puts = [];
  const put = env.CONFIGS.put.bind(env.CONFIGS);
  env.CONFIGS.put = async (k, ...r) => { if (String(k).startsWith("scrobbleseenusers:")) puts.push(k); return put(k, ...r); };
  const ping = async (plexUser, event = "media.pause") => {
    const r = await call(env, `/api/scrobble?st=${encodeURIComponent(tok.body.token)}`, {
      method: "POST",
      json: { event, Account: { title: plexUser }, Metadata: { type: "movie", title: "X", Guid: [{ id: "imdb://tt0111161" }] } },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await new Promise((res) => setTimeout(res, 50));
  };
  return { env, user, puts, ping };
}

describe("PERF-04: seen media-server users are not rewritten on every webhook", () => {
  it("a pause/resume burst from one listed user writes the key once", async () => {
    const { puts, ping } = await setup();
    await ping("alice"); await ping("alice", "media.resume"); await ping("alice", "media.pause");
    assert.equal(puts.length, 1, `wrote the seen-users key ${puts.length} times`);
  });

  it("a second, new user is still recorded", async () => {
    const { env, user, puts, ping } = await setup();
    await ping("alice"); await ping("bob");
    assert.equal(puts.length, 2);
    const seen = JSON.parse(await env.CONFIGS.get(`scrobbleseenusers:${user.creatorName}`));
    assert.deepEqual(Object.keys(seen).sort(), ["alice", "bob"]);
  });

  it("an entry last seen over an hour ago is refreshed", async () => {
    const { env, user, puts, ping } = await setup();
    await ping("alice");
    const key = `scrobbleseenusers:${user.creatorName}`;
    const seen = JSON.parse(await env.CONFIGS.get(key));
    seen.alice.lastSeen = Date.now() - 2 * 3600 * 1000;
    await env.CONFIGS.put(key, JSON.stringify(seen));
    puts.length = 0;
    await ping("alice");
    assert.equal(puts.length, 1);
    assert.ok(JSON.parse(await env.CONFIGS.get(key)).alice.lastSeen > Date.now() - 60000);
  });
});
