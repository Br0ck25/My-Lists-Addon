// Audit DB-02: liked/hidden lists were saved as "delete every row, then insert
// them in batches of 80". A failure in a later batch left only the first ~79
// ids in D1, the route still answered ok, and the short D1 copy then won on load.
// Now the inserts go first and only stale rows are deleted last, and a failed
// write is reported instead of answered with ok.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeEnv, makeD1, makeKv, call, createUser } from "./harness.mjs";

const ids = (n, p = "L") => Array.from({ length: n }, (_, i) => `${p}${i}`);

async function setup() {
  const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
  const user = await createUser(env, "likedlots");
  const save = (liked, hidden = []) => call(env, "/api/creator/sync/save", { method: "POST", json: { creatorName: user.creatorName, creatorKey: user.creatorKey, config: [], likedLists: liked, hiddenLists: hidden } });
  const load = () => call(env, "/api/creator/sync/load", { method: "POST", json: { creatorName: user.creatorName, creatorKey: user.creatorKey } });
  const rows = () => env.DB._db.prepare("SELECT count(*) AS n FROM creator_user_lists WHERE username = 'likedlots'").get().n;
  return { env, user, save, load, rows };
}

describe("DB-02: saving liked/hidden lists", () => {
  it("a failure in a later batch does not truncate the stored lists, and is reported separately", async () => {
    const { env, save, load, rows } = await setup();
    assert.equal((await save(ids(120))).body.ok, true);
    assert.equal(rows(), 120);

    let inserts = 0;
    env.DB.failWhen((sql) => /INSERT OR IGNORE INTO creator_user_lists/.test(sql) && ++inserts > 100);
    const bad = await save(ids(130));
    env.DB.failWhen(null);
    assert.equal(bad.body.ok, true, "the config still saved (KV), so the save is ok");
    assert.equal(bad.body.likedListsSynced, false, "but the liked-lists copy is reported as behind");
    assert.ok(rows() >= 120, "nothing already stored was lost: " + rows());
    const back = await load();
    assert.ok(back.body.data.likedLists.length >= 120, "load still returns every liked list");
  });

  it("ids that are no longer liked are removed", async () => {
    const { save, load, rows } = await setup();
    await save(ids(120), ["H1", "H2"]);
    assert.equal((await save(ids(90).slice(10), ["H1"])).body.ok, true);
    assert.equal(rows(), 80 + 1);
    const back = (await load()).body.data;
    assert.deepEqual([...back.likedLists].sort(), ids(90).slice(10).sort());
    assert.deepEqual(back.hiddenLists, ["H1"]);
  });

  it("a D1 fault on the liked-lists table does not stop the install-link rows from saving", async () => {
    const { env, user, save, load } = await setup();
    const saveCfg = (config) => call(env, "/api/creator/sync/save", { method: "POST", json: { creatorName: user.creatorName, creatorKey: user.creatorKey, config, likedLists: ["L1"] } });
    const row = (id) => ({ id, name: id, type: "movie", url: "tmdb:chart:popular" });
    assert.equal((await saveCfg([row("a")])).body.ok, true);
    env.DB.failWhen((sql) => /creator_user_lists/.test(sql));
    const r = await saveCfg([row("a"), row("b")]);
    env.DB.failWhen(null);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.likedListsSynced, false);
    const kv = JSON.parse(env.CONFIGS._store.get("creatorsync:likedlots"));
    assert.deepEqual(kv.config.map((x) => x.id), ["a", "b"], "the new row reached KV, so the install link has it");
    assert.ok((await load()).body.ok);
  });

  // Third review: with the liked-lists table failing, load used to answer from the stale D1
  // rows and drop a new like (or bring back an unlike); the next autosave then made it permanent.
  describe("while the liked-lists table cannot be written", () => {
    it("load returns what was saved last (KV), not the older D1 rows, and recovers once D1 is back", async () => {
      const { env, user, load } = await setup();
      const save = (likedLists) => call(env, "/api/creator/sync/save", { method: "POST", json: { creatorName: user.creatorName, creatorKey: user.creatorKey, config: [], likedLists } });
      assert.equal((await save(["L1", "L2"])).body.ok, true);

      env.DB.failWhen((sql) => /creator_user_lists/.test(sql) && !/^\s*SELECT/i.test(sql));
      const added = await save(["L1", "L2", "L3"]);
      assert.equal(added.body.likedListsSynced, false);
      assert.deepEqual([...(await load()).body.data.likedLists].sort(), ["L1", "L2", "L3"], "the new like is not lost");
      const removed = await save(["L2", "L3"]);
      assert.equal(removed.body.likedListsSynced, false);
      assert.deepEqual([...(await load()).body.data.likedLists].sort(), ["L2", "L3"], "an unlike does not come back");

      env.DB.failWhen(null);
      assert.equal((await save(["L2", "L3", "L4"])).body.likedListsSynced, undefined, "a good write reports nothing");
      assert.deepEqual([...(await load()).body.data.likedLists].sort(), ["L2", "L3", "L4"]);
      assert.equal(env.DB._db.prepare("SELECT count(*) AS n FROM creator_user_lists WHERE username = 'likedlots' AND list_type = 'liked'").get().n, 3, "D1 caught up");
    });
  });
});

