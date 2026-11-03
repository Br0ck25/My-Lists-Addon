// SEC-07: the media-server webhook (/api/scrobble) is reachable without signing
// in, so it needs the limits every other unauthenticated, costly endpoint has:
// a per-IP budget for wrong tokens (which a correct token never spends) and a
// ceiling on the body it will buffer.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { call, createUser, makeD1, makeEnv, makeKv, nextIp } from "./harness.mjs";

const play = { event: "media.scrobble", Account: { title: "owner" }, Metadata: { type: "track", title: "x" } };
const hit = (env, token, opts = {}) => call(env, "/api/scrobble?st=" + encodeURIComponent(token), { method: "POST", json: play, ...opts });

async function setup() {
  const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
  const u = await createUser(env, "hookabuse");
  const t = await call(env, "/api/creator/scrobble-token", { method: "POST", ip: nextIp(), json: { creatorName: u.creatorName, creatorKey: u.creatorKey } });
  return { env, token: t.body.token };
}

describe("SEC-07: wrong webhook tokens are limited per IP", () => {
  it("the 31st wrong token from one IP is refused with 429, earlier ones with 401", async () => {
    const { env } = await setup();
    const ip = nextIp();
    for (let i = 1; i <= 30; i++) {
      const r = await hit(env, "wrong-token-" + i, { ip });
      assert.equal(r.status, 401, `attempt ${i}`);
    }
    assert.equal((await hit(env, "wrong-token-31", { ip })).status, 429);
  });

  it("a correct token from the same IP still works, and never spends the budget", async () => {
    const { env, token } = await setup();
    const ip = nextIp();
    for (let i = 1; i <= 31; i++) await hit(env, "wrong-token-" + i, { ip });
    assert.notEqual((await hit(env, token, { ip })).status, 429);
    assert.notEqual((await hit(env, token, { ip })).status, 401);
    const other = nextIp();
    for (let i = 1; i <= 100; i++) assert.notEqual((await hit(env, token, { ip: other })).status, 429, "a busy correct media server is never limited");
  });

  it("another IP has its own budget", async () => {
    const { env } = await setup();
    const ip = nextIp();
    for (let i = 1; i <= 31; i++) await hit(env, "wrong-token-" + i, { ip });
    assert.equal((await hit(env, "wrong-token-x", { ip: nextIp() })).status, 401);
  });
});

describe("SEC-07: the webhook refuses an oversized body", () => {
  it("answers 413 for a body over 8 MB, before looking at the token", async () => {
    const { env, token } = await setup();
    const big = JSON.stringify({ event: "media.scrobble", pad: "x".repeat(9 * 1024 * 1024) });
    const r = await call(env, "/api/scrobble?st=" + encodeURIComponent(token), {
      method: "POST", json: big, headers: { "Content-Length": String(Buffer.byteLength(big)) },
    });
    assert.equal(r.status, 413);
  });

  it("still accepts an ordinary body", async () => {
    const { env, token } = await setup();
    assert.notEqual((await hit(env, token)).status, 413);
  });
});
