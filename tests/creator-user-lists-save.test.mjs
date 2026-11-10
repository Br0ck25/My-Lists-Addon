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
  return { env, save, load, rows };
}

describe("DB-02: saving liked/hidden lists", () => {
  it("a failure in a later batch does not truncate the stored lists, and is reported", async () => {
    const { env, save, load, rows } = await setup();
    assert.equal((await save(ids(120))).body.ok, true);
    assert.equal(rows(), 120);

    let inserts = 0;
    env.DB.failWhen((sql) => /INSERT OR IGNORE INTO creator_user_lists/.test(sql) && ++inserts > 100);
    const bad = await save(ids(130));
    env.DB.failWhen(null);
    assert.equal(bad.body.ok, false, "a failed D1 write is not answered with ok");
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
});
