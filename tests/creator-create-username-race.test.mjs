// Audit BUG-05: two people creating the same new username at once both passed
// the "is it taken" check; the loser hit the UNIQUE constraint and was told
// "Failed to create creator account" (500). A UNIQUE failure now reads as
// "That username is already taken."
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeEnv, makeD1, makeKv, call } from "./harness.mjs";

describe("BUG-05: username taken between the check and the insert", () => {
  it("a UNIQUE failure on insert answers 'already taken', not a 500", async () => {
    const db = makeD1();
    const realPrepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      if (/^INSERT INTO creators\b/i.test(sql)) {
        return { bind: () => ({ run: async () => { throw new Error("UNIQUE constraint failed: creators.username"); } }) };
      }
      return realPrepare(sql);
    };
    const env = makeEnv({ DB: db, CONFIGS: makeKv() });
    const r = await call(env, "/api/creator/create", { method: "POST", json: { creatorName: "samename" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, false);
    assert.match(r.body.error, /already taken/);
  });

  it("any other D1 failure still reports the generic failure", async () => {
    const db = makeD1();
    const realPrepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      if (/^INSERT INTO creators\b/i.test(sql)) {
        return { bind: () => ({ run: async () => { throw new Error("D1 is down"); } }) };
      }
      return realPrepare(sql);
    };
    const env = makeEnv({ DB: db, CONFIGS: makeKv() });
    const r = await call(env, "/api/creator/create", { method: "POST", json: { creatorName: "othername" } });
    assert.equal(r.status, 500);
  });
});
