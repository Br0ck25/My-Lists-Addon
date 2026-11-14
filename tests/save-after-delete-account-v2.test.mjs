// Audit BUG-02 (production path): with FF_V2_LISTS_ONLY a list save that
// authenticated, then lost a race with "Delete account", wrote its list rows
// into v2 and answered 200, leaving list data for a deleted account. The save
// must re-check the deletion tombstone after its write and take its rows back.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeEnv, makeD1, makeKv, call, createUser } from "./harness.mjs";

const FLAGS = { FF_V2_LISTS_READ: "1", FF_V2_LISTS_API: "1", FF_V2_LISTS_ONLY: "1", FF_SESSIONS: "1", FF_INSTALLS: "1" };

describe("BUG-02: list save racing a delete-account under FF_V2_LISTS_ONLY", () => {
  it("leaves no list or account rows behind and does not report success", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), ...FLAGS });
    const user = await createUser(env, "racerv2");
    const db = env.DB;
    let deleted = false;
    // The delete finishes its whole purge just before the save's list row
    // lands: the interleaving the audit reproduced.
    const stage = async () => {
      if (deleted) return;
      deleted = true;
      const d = await call(env, "/api/creator/delete-account", { method: "POST", json: { creatorName: user.creatorName, creatorKey: user.creatorKey, confirm: "DELETE" } });
      assert.equal(d.body.ok, true, JSON.stringify(d.body));
    };
    // After the list rows are written (the D1 stamp bump follows the write).
    const realPrepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      const st = realPrepare(sql);
      if (!/UPDATE creators SET lists_stamp/i.test(String(sql))) return st;
      const realBind = st.bind.bind(st);
      st.bind = (...a) => {
        const b = realBind(...a);
        const realRun = b.run.bind(b);
        b.run = async () => { await stage(); return realRun(); };
        return b;
      };
      return st;
    };
    const r = await call(env, "/api/creator/lists/save", { method: "POST", json: { creatorName: user.creatorName, creatorKey: user.creatorKey, name: "Mine", type: "movie", items: [{ id: "tt0000001", name: "A", type: "movie" }], visibility: "public" } });
    db.prepare = realPrepare;
    assert.equal(deleted, true, "the race was actually staged");
    assert.notEqual(r.status, 200, "a save into a deleted account must not report success");
    const lists = await db.prepare("SELECT COUNT(*) AS n FROM lists").first();
    const accts = await db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE username = ? COLLATE NOCASE").bind("racerv2").first();
    assert.equal(lists.n, 0, "no list rows may survive the deletion");
    assert.equal(accts.n, 0, "the deleted account row must not come back");
  });
});
