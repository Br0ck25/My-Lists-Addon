// Audit BUG-02: a list save that authenticated, then lost a race with
// "Delete account", still wrote its records and answered 200, leaving list
// data in KV for a deleted account. The save now re-checks the deletion
// tombstone after writing and removes its own records.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeEnv, makeD1, makeKv, call, createUser } from "./harness.mjs";

describe("BUG-02: list save racing a delete-account", () => {
  it("leaves no list keys behind and does not report success", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const user = await createUser(env, "racer");
    const kv = env.CONFIGS;
    const realPut = kv.put.bind(kv);
    let deleted = false;
    // The delete-account request finishes its whole purge just before the
    // save's list record lands: the interleaving the audit reproduced.
    kv.put = async (k, ...rest) => {
      if (!deleted && k.startsWith("creatorlist:racer:")) {
        deleted = true;
        const d = await call(env, "/api/creator/delete-account", { method: "POST", json: { creatorName: user.creatorName, creatorKey: user.creatorKey, confirm: "DELETE" } });
        assert.equal(d.body.ok, true, JSON.stringify(d.body));
      }
      return realPut(k, ...rest);
    };
    const r = await call(env, "/api/creator/lists/save", { method: "POST", json: { creatorName: user.creatorName, creatorKey: user.creatorKey, name: "Mine", type: "movie", items: [{ id: "tt0000001", name: "A", type: "movie" }], visibility: "public" } });
    assert.equal(deleted, true, "the race was actually staged");
    assert.notEqual(r.status, 200, "a save into a deleted account must not report success");
    const left = [...kv._store.keys()].filter((k) => /^creatorlist(order|stamp)?:racer/.test(k));
    assert.deepEqual(left, [], "no list data may survive the deletion");
  });
});
