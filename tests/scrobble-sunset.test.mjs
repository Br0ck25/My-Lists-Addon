// Scrobble endpoint authentication (P7-6, S-08; old forms retired 2026-11-02,
// docs/DECISIONS.md D-36).
// The scoped ?st= token is the only webhook credential. The old ?creator=&key=
// and ?config= (alias ?token=) forms are refused with 410 Gone whatever the
// Worker's variables say: they put the Account Key, or an install link that
// can carry it, into a media server's settings and logs.

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

  it("refuses creator=&key= with 410, records nothing, and never verifies the key", async () => {
    const points = [];
    const env = makeEnv({ DB: makeD1(), ANALYTICS: { writeDataPoint(p) { points.push(p); } } });
    const user = await createUser(env, "scrobble_key_user");
    const auth = { creatorName: user.creatorName, creatorKey: user.creatorKey };

    const res = await scrobble(env, `creator=${encodeURIComponent(user.creatorName)}&key=${encodeURIComponent(user.creatorKey)}`);
    assert.equal(res.status, 410);
    assert.equal(res.body.sunset, true);

    // Nothing was written for the account: no ping, no play.
    const status = (await call(env, "/api/creator/track-status", { method: "POST", json: auth })).body;
    assert.equal(status.lastPingAt, null);
    assert.ok(!points.some((p) => p.blobs && p.blobs[0] === "scrobble_auth"), "a refused request is not counted as an auth");
  });

  it("refuses creator=&key= even with a wrong key (410, not 401: the form itself is gone)", async () => {
    const env = makeEnv({ DB: makeD1() });
    const user = await createUser(env, "scrobble_wrongkey_user");
    const res = await scrobble(env, `creator=${encodeURIComponent(user.creatorName)}&key=MYL-WRONG-WRONG-WRONG`);
    assert.equal(res.status, 410);
  });

  it("refuses config= and its token= alias with 410, even for a link that carries the Account Key", async () => {
    const env = makeEnv({ DB: makeD1() });
    const user = await createUser(env, "scrobble_cfg_user");
    const auth = { creatorName: user.creatorName, creatorKey: user.creatorKey };
    const configId = "legacyid0001";
    await env.CONFIGS.put(`cfg:${configId}`, JSON.stringify({
      entries: [],
      trackCreatorName: user.creatorName,
      trackCreatorKey: user.creatorKey,
    }));

    for (const qs of [`config=${configId}`, `token=${configId}`]) {
      const res = await scrobble(env, qs);
      assert.equal(res.status, 410, qs);
      assert.equal(res.body.sunset, true, qs);
    }
    const status = (await call(env, "/api/creator/track-status", { method: "POST", json: auth })).body;
    assert.equal(status.lastPingAt, null);
  });

  it("refuses the old forms whatever FF_SCROBBLE_ST_ONLY or SCROBBLE_SUNSET_DATE say", async () => {
    for (const vars of [{ FF_SCROBBLE_ST_ONLY: "0" }, { SCROBBLE_SUNSET_DATE: "2099-01-01T00:00:00Z" }, {}]) {
      const env = makeEnv({ DB: makeD1(), ...vars });
      const user = await createUser(env, "scrobble_vars_user");
      const res = await scrobble(env, `creator=${encodeURIComponent(user.creatorName)}&key=${encodeURIComponent(user.creatorKey)}`);
      assert.equal(res.status, 410, JSON.stringify(vars));
    }
  });

  it("st= keeps working, and wins when old parameters ride along on the same URL", async () => {
    const env = makeEnv({ DB: makeD1() });
    const user = await createUser(env, "scrobble_both_user");
    const auth = { creatorName: user.creatorName, creatorKey: user.creatorKey };
    const token = await mintToken(env, auth);

    const res = await scrobble(env, `st=${encodeURIComponent(token)}&creator=${encodeURIComponent(user.creatorName)}&key=nope`);
    assert.equal(res.status, 200);
    const status = (await call(env, "/api/creator/track-status", { method: "POST", json: auth })).body;
    assert.equal(status.lastAuthForm, "st");
    assert.equal(status.legacyAuthForm, null);
  });

  it("an st= ping clears the Settings banner left by an old-form ping from before", async () => {
    const env = makeEnv({ DB: makeD1() });
    const user = await createUser(env, "scrobble_upgrade_user");
    const auth = { creatorName: user.creatorName, creatorKey: user.creatorKey };
    const token = await mintToken(env, auth);
    // What an old-form ping recorded before the forms were retired.
    await env.CONFIGS.put(`creatortrack:${user.creatorName.toLowerCase()}`, JSON.stringify({
      lastPingAt: Date.now() - 60000, lastPingId: "x", lastServer: "Plex", lastUser: null,
      matched: "yes", lastAuthForm: "key", legacyAuthForm: "key",
    }));
    assert.equal((await call(env, "/api/creator/track-status", { method: "POST", json: auth })).body.legacyAuthForm, "key");

    await scrobble(env, `st=${encodeURIComponent(token)}`);
    const status = (await call(env, "/api/creator/track-status", { method: "POST", json: auth })).body;
    assert.equal(status.lastAuthForm, "st");
    assert.equal(status.legacyAuthForm, null);
  });
});
