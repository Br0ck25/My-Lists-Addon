// CQ-07: when deleting an account, a failed removal of the like-voter record
// kept for one of its lists must be logged, not lost in an empty catch. The
// purge still finishes (the delete is best-effort), so both halves are checked.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, makeD1, makeKv, makeQueue, drainQueue, call, createUser } from "./harness.mjs";

describe("a failed best-effort delete during account purge is logged", () => {
  it("logs the listlikevoters delete that failed and still finishes the purge", async () => {
    const env = makeEnv({ DB: makeD1(), DB_ACTIVITY: makeD1({ schema: "activity" }), CONFIGS: makeKv(), JOBS: makeQueue(), FF_INSTALLS: "1" });
    const ann = await createUser(env, "logann");
    const login = await call(env, "/api/session", { method: "POST", json: { username: "logann", key: ann.creatorKey } });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    const saved = await call(env, "/api/creator/lists/save", { method: "POST", json: { creatorName: "logann", creatorKey: ann.creatorKey, slug: "mine", name: "Mine", type: "movie", items: [{ id: "tt0133093" }] } });
    assert.equal(saved.body.ok, true, JSON.stringify(saved.body));
    env.CONFIGS._hooks.beforeDelete = async (key) => { if (key.startsWith("listlikevoters:")) throw new Error("kv down"); };
    const logged = [];
    const realWarn = console.warn;
    console.warn = (...a) => logged.push(a.map(String).join(" "));
    try {
      await call(env, "/api/me", { method: "DELETE", cookie, json: { confirm: "DELETE" } });
      await drainQueue(env);
    } finally {
      console.warn = realWarn;
    }
    assert.equal(env.CONFIGS._store.has("creatorlist:logann:mine"), false, "the purge still removed the list");
    assert.ok(logged.some((l) => l.includes("kv down") && l.includes("listlikevoters:logann:mine")), `expected a logged failure, got: ${JSON.stringify(logged)}`);
  });
});
