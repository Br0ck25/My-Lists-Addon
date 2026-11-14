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

  // Audit BUG-02 follow-up: a delete landing after the deletion re-check but
  // before the search-index write used to leave a lists_fts row (list name
  // and display name) for the deleted account.
  it("leaves no search-index row when the delete lands after the first re-check", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const user = await createUser(env, "racerfts");
    const db = env.DB;
    const realBatch = db.batch.bind(db);
    let deleted = false;
    db.batch = async (stmts, ...rest) => {
      if (!deleted && stmts.some((s) => /INSERT INTO lists_fts/i.test(String(s && s._spec ? s._spec.sql : "")))) {
        deleted = true;
        const d = await call(env, "/api/creator/delete-account", { method: "POST", json: { creatorName: user.creatorName, creatorKey: user.creatorKey, confirm: "DELETE" } });
        assert.equal(d.body.ok, true, JSON.stringify(d.body));
      }
      return realBatch(stmts, ...rest);
    };
    const r = await call(env, "/api/creator/lists/save", { method: "POST", json: { creatorName: user.creatorName, creatorKey: user.creatorKey, name: "Mine", type: "movie", items: [{ id: "tt0000001", name: "A", type: "movie" }], visibility: "public" } });
    db.batch = realBatch;
    assert.equal(deleted, true, "the race was actually staged");
    assert.notEqual(r.status, 200, "a save into a deleted account must not report success");
    const fts = await db.prepare("SELECT COUNT(*) AS n FROM lists_fts WHERE username = ?").bind("racerfts").first();
    assert.equal(fts.n, 0, "no search-index row may survive the deletion");
  });

  // With sessions on, the save's own auth step can bring the account row back
  // after the delete removed it; the retract must remove it again.
  it("removes an account row the save itself brought back (sessions on)", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), FF_SESSIONS: "1", FF_INSTALLS: "1" });
    const user = await createUser(env, "racerleg");
    const db = env.DB;
    let deleted = false;
    const realPrepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      const st = realPrepare(sql);
      if (deleted || !/^\s*SELECT id, username, display_name, key_hash/i.test(String(sql))) return st;
      const realBind = st.bind.bind(st);
      st.bind = (...a) => {
        const b = realBind(...a);
        for (const m of ["first", "all", "run"]) {
          const real = b[m].bind(b);
          b[m] = async (...x) => {
            if (!deleted) {
              deleted = true;
              const d = await call(env, "/api/creator/delete-account", { method: "POST", json: { creatorName: user.creatorName, creatorKey: user.creatorKey, confirm: "DELETE" } });
              assert.equal(d.body.ok, true, JSON.stringify(d.body));
            }
            return real(...x);
          };
        }
        return b;
      };
      return st;
    };
    const r = await call(env, "/api/creator/lists/save", { method: "POST", json: { creatorName: user.creatorName, creatorKey: user.creatorKey, name: "Mine", type: "movie", items: [{ id: "tt0000001", name: "A", type: "movie" }], visibility: "public" } });
    db.prepare = realPrepare;
    assert.equal(deleted, true, "the race was actually staged");
    assert.notEqual(r.status, 200);
    const accts = await db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE username = ? COLLATE NOCASE").bind("racerleg").first();
    assert.equal(accts.n, 0, "the deleted account row must not come back");
  });
});
