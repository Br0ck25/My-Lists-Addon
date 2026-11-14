// SEC-03: the Account Key must never be read from a URL on /api/nuvio-tv/config.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, makeD1, makeKv, call, createUser } from "./harness.mjs";

describe("SEC-03 /api/nuvio-tv/config refuses a key in the address", () => {
  it("answers 400 and does not authenticate, even with the right key", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const u = await createUser(env, "seckeyq");
    const res = await call(env, "/api/nuvio-tv/config?creatorName=seckeyq&creatorKey=" + encodeURIComponent(u.creatorKey));
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /private key or token in the address/i);
    assert.equal(res.body.username, undefined);
  });

  it("still serves the signed-in owner through the session cookie", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), FF_SESSIONS: "1" });
    const u = await createUser(env, "seckeyc");
    const s = await call(env, "/api/session", { method: "POST", json: { username: "seckeyc", key: u.creatorKey } });
    const cookie = (s.headers.get("set-cookie") || "").split(";")[0];
    const res = await call(env, "/api/nuvio-tv/config?creatorName=seckeyc", { cookie });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.username, "seckeyc");
  });
});
