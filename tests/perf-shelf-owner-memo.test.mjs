import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeKv, makeD1, makeEnv, call, createUser } from "./harness.mjs";

// PERF-16: a config that carries trackCreatorKey re-verified its owner on every
// catalog row: a tombstone read (KV, then D1) plus SELECT * FROM creators. The
// answer is now remembered for 10 s, the same window as SESSION_CACHE (SESS-001).

async function setup(name) {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
  const user = await createUser(env, name);
  const config = "cfg" + name.slice(0, 6);
  await env.CONFIGS.put(`cfg:${config}`, JSON.stringify({
    track: true,
    trackCreatorName: user.creatorName,
    trackCreatorKey: user.creatorKey,
    showBadgesStremio: false,
    entries: [{ id: "wl", type: "movie", name: "Watchlist", url: `autotrack:watchlist:movie:${user.creatorName}` }],
  }));
  const saved = await call(env, "/api/creator/sync/save-tracking", {
    method: "POST",
    json: { creatorName: user.creatorName, creatorKey: user.creatorKey, watchlist: [{ id: "tt0000500", type: "movie", name: "Five Hundred" }], watchlistUpdatedAt: Date.now() },
  });
  assert.equal(saved.body.ok, true);
  const sql = [];
  const prep = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (q, ...a) => (sql.push(String(q)), prep(q, ...a));
  const gets = [];
  const kvGet = env.CONFIGS.get.bind(env.CONFIGS);
  env.CONFIGS.get = (k, ...a) => (gets.push(String(k)), kvGet(k, ...a));
  const owner = () => ({
    creators: sql.filter((q) => /FROM creators\b/i.test(q)).length,
    tombstoneD1: sql.filter((q) => /creator_tombstones/i.test(q)).length,
    tombstoneKv: gets.filter((k) => k.startsWith("creatordeleted:")).length,
  });
  const reset = () => { sql.length = 0; gets.length = 0; };
  const row = async () => ((await call(env, `/${config}/catalog/movie/wl.json`)).body.metas || []).map((m) => m.id);
  return { env, user, owner, reset, row };
}

describe("PERF-16: verifyShelfOwner is remembered for 10 s", () => {
  it("20 row requests for one track-on link verify the owner once", async () => {
    const t = await setup("memoown");
    const first = await t.row();
    assert.deepEqual(first, ["tt0000500"], "the owner's shelf is served");
    t.reset();
    for (let i = 0; i < 20; i++) assert.deepEqual(await t.row(), ["tt0000500"]);
    const c = t.owner();
    assert.equal(c.creators, 0, "no further creators lookups inside the window");
    assert.equal(c.tombstoneD1, 0);
    assert.equal(c.tombstoneKv, 0);
  });

  it("verifies again after 10 s, and a tombstoned account stops verifying then", async () => {
    const t = await setup("memoown2");
    assert.deepEqual(await t.row(), ["tt0000500"]);
    const realNow = Date.now;
    let offset = 0;
    Date.now = () => realNow() + offset;
    try {
      // The account is deleted (tombstone written) while the memo is warm.
      await t.env.CONFIGS.put(`creatordeleted:${t.user.creatorName}`, "1");
      assert.deepEqual(await t.row(), ["tt0000500"], "inside the window the remembered answer is used");
      offset = 11_000;
      t.reset();
      assert.deepEqual(await t.row(), [], "after 11 s the tombstone is seen and the shelf is not served");
      assert.ok(t.owner().tombstoneKv >= 1, "the owner was verified again");
    } finally { Date.now = realNow; }
  });
});
