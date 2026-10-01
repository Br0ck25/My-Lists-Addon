// Scrobble endpoint authentication and sunset (P7-6, S-08).
// The scoped ?st= token is the preferred, secure webhook credential.
// The legacy ?creator=&key= and ?config= forms log usage warnings and
// record diagnostics so Settings can show an in-app banner with the new URL.
// When FF_SCROBBLE_ST_ONLY=1 or past SCROBBLE_SUNSET_DATE, the legacy
// forms are retired (410 Gone) while ?st= continues to function.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { call, createUser, makeD1, makeEnv, nextIp } from "./harness.mjs";

describe("P7-6: scrobble authentication and sunset", () => {
  const scrobblePayload = {
    event: "media.scrobble",
    Metadata: { type: "movie", title: "Test Title", year: 2024 },
  };

  const scrobble = (env, qs) =>
    call(env, "/api/scrobble?" + qs, {
      method: "POST",
      ip: nextIp(),
      json: scrobblePayload,
    });

  const mintToken = async (env, auth) => {
    const res = await call(env, "/api/creator/scrobble-token", {
      method: "POST",
      ip: nextIp(),
      json: { ...auth, rotate: false },
    });
    return res.body.token;
  };

  it("authenticates via st= token, recording authForm as 'st' and no legacyAuthForm", async () => {
    const env = makeEnv({ DB: makeD1() });
    const user = await createUser(env, "scrobble_st_user");
    const auth = { creatorName: user.creatorName, creatorKey: user.creatorKey };
    const token = await mintToken(env, auth);

    const res = await scrobble(env, "st=" + encodeURIComponent(token));
    assert.equal(res.status, 200);

    const statusRes = await call(env, "/api/creator/track-status", {
      method: "POST",
      json: auth,
    });
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.body.lastAuthForm, "st");
    assert.equal(statusRes.body.legacyAuthForm, null);
  });

  it("authenticates via legacy creator=&key= before sunset, logging usage and setting legacyAuthForm", async () => {
    const points = [];
    const env = makeEnv({
      DB: makeD1(),
      ANALYTICS: {
        writeDataPoint(p) { points.push(p); },
      },
    });
    const user = await createUser(env, "scrobble_key_user");
    const auth = { creatorName: user.creatorName, creatorKey: user.creatorKey };

    const legacyQs = `creator=${encodeURIComponent(user.creatorName)}&key=${encodeURIComponent(user.creatorKey)}`;
    const res = await scrobble(env, legacyQs);
    assert.equal(res.status, 200);

    // Diagnostics in track-status flags the legacy auth form
    const statusRes = await call(env, "/api/creator/track-status", {
      method: "POST",
      json: auth,
    });
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.body.lastAuthForm, "key");
    assert.equal(statusRes.body.legacyAuthForm, "key");

    // Analytics Engine logged scrobble_auth metric
    const authPoint = points.find((p) => p.blobs && p.blobs[0] === "scrobble_auth");
    assert.ok(authPoint, "Analytics Engine data point recorded for scrobble_auth");
    assert.equal(authPoint.blobs[1], "key");
  });

  it("authenticates via legacy config= before sunset, setting legacyAuthForm to 'config'", async () => {
    const points = [];
    const env = makeEnv({
      DB: makeD1(),
      ANALYTICS: {
        writeDataPoint(p) { points.push(p); },
      },
    });
    const user = await createUser(env, "scrobble_cfg_user");
    const auth = { creatorName: user.creatorName, creatorKey: user.creatorKey };

    // Seed a legacy config in KV (SHORT_ID_LENGTH is 12)
    const configId = "legacyid0001";
    await env.CONFIGS.put(`cfg:${configId}`, JSON.stringify({
      entries: [],
      trackCreatorName: user.creatorName,
      trackCreatorKey: user.creatorKey,
    }));

    const res = await scrobble(env, `config=${configId}`);
    assert.equal(res.status, 200);

    const statusRes = await call(env, "/api/creator/track-status", {
      method: "POST",
      json: auth,
    });
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.body.lastAuthForm, "config");
    assert.equal(statusRes.body.legacyAuthForm, "config");

    const authPoint = points.find((p) => p.blobs && p.blobs[0] === "scrobble_auth");
    assert.ok(authPoint);
    assert.equal(authPoint.blobs[1], "config");
  });

  it("clears legacyAuthForm once a user upgrades to the st= token", async () => {
    const env = makeEnv({ DB: makeD1() });
    const user = await createUser(env, "scrobble_upgrade_user");
    const auth = { creatorName: user.creatorName, creatorKey: user.creatorKey };
    const token = await mintToken(env, auth);

    // First ping: old creator+key form
    await scrobble(env, `creator=${encodeURIComponent(user.creatorName)}&key=${encodeURIComponent(user.creatorKey)}`);
    const status1 = (await call(env, "/api/creator/track-status", { method: "POST", json: auth })).body;
    assert.equal(status1.legacyAuthForm, "key");

    // Second ping: updated st= token form
    await scrobble(env, `st=${encodeURIComponent(token)}`);
    const status2 = (await call(env, "/api/creator/track-status", { method: "POST", json: auth })).body;
    assert.equal(status2.lastAuthForm, "st");
    assert.equal(status2.legacyAuthForm, null);
  });

  it("retires legacy forms when FF_SCROBBLE_ST_ONLY=1, while st= continues to work", async () => {
    const env = makeEnv({ DB: makeD1(), FF_SCROBBLE_ST_ONLY: "1" });
    const user = await createUser(env, "scrobble_sunset_user");
    const auth = { creatorName: user.creatorName, creatorKey: user.creatorKey };
    const token = await mintToken(env, auth);

    // st= token continues to work normally
    const tokenRes = await scrobble(env, `st=${encodeURIComponent(token)}`);
    assert.equal(tokenRes.status, 200);

    // creator=&key= is retired with 410
    const keyRes = await scrobble(env, `creator=${encodeURIComponent(user.creatorName)}&key=${encodeURIComponent(user.creatorKey)}`);
    assert.equal(keyRes.status, 410);
    assert.equal(keyRes.body.sunset, true);

    // config= is retired with 410
    const cfgRes = await scrobble(env, "config=cfg_fake");
    assert.equal(cfgRes.status, 410);
    assert.equal(cfgRes.body.sunset, true);
  });

  it("retires legacy forms when SCROBBLE_SUNSET_DATE is in the past", async () => {
    const env = makeEnv({ DB: makeD1(), SCROBBLE_SUNSET_DATE: "2025-01-01T00:00:00Z" });
    const user = await createUser(env, "scrobble_date_user");
    const auth = { creatorName: user.creatorName, creatorKey: user.creatorKey };

    const keyRes = await scrobble(env, `creator=${encodeURIComponent(user.creatorName)}&key=${encodeURIComponent(user.creatorKey)}`);
    assert.equal(keyRes.status, 410);
    assert.equal(keyRes.body.sunset, true);
  });

  it("keeps legacy forms working when SCROBBLE_SUNSET_DATE is in the future", async () => {
    const env = makeEnv({ DB: makeD1(), SCROBBLE_SUNSET_DATE: "2099-01-01T00:00:00Z" });
    const user = await createUser(env, "scrobble_future_user");

    const keyRes = await scrobble(env, `creator=${encodeURIComponent(user.creatorName)}&key=${encodeURIComponent(user.creatorKey)}`);
    assert.equal(keyRes.status, 200);
  });
});
