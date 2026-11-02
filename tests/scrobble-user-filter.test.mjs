// The scrobble webhook's user filter: a ping from a user who is not on the
// allowed list is turned away with a normal "ignored" reply (HTTP 200) and the
// attempt is noted in the account's diagnostics. It used to answer HTTP 500
// ("Cannot access 'pingId' before initialization").
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { call, createUser, makeD1, makeEnv, nextIp } from "./harness.mjs";

async function setup() {
  const env = makeEnv({ DB: makeD1() });
  const u = await createUser(env, "filteruser");
  const cred = { creatorName: u.creatorName, creatorKey: u.creatorKey };
  const tok = await call(env, "/api/creator/scrobble-token", { method: "POST", ip: nextIp(), json: cred });
  assert.equal(tok.body.ok, true, tok.body.error);
  return { env, name: u.creatorName, token: tok.body.token };
}

const plex = (user, extra = {}) => ({
  event: "media.scrobble",
  ...(user ? { Account: { title: user } } : {}),
  Metadata: { type: "movie", title: "Some Film", Guid: [{ id: "imdb://tt0137523" }] },
  ...extra,
});

describe("scrobble user filter", () => {
  it("turns away a user who is not on the allowed list with an ignored reply, not a 500", async () => {
    const { env, name, token } = await setup();
    const r = await call(env, "/api/scrobble?st=" + encodeURIComponent(token) + "&filterUsers=1&allowedUsers=owner", {
      method: "POST", ip: nextIp(), json: plex("stranger"),
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.ignored, "User 'stranger' is not in the allowed list.");
    const diag = JSON.parse(await env.CONFIGS.get("creatortrack:" + name));
    assert.equal(diag.lastUser, "stranger");
    assert.equal(diag.matched, "ignored (User 'stranger' is not in the allowed list.)");
    assert.equal(diag.lastPingId, "tt0137523");
  });

  it("turns away a ping with no username when the filter is on and anonymous is blocked", async () => {
    const { env, name, token } = await setup();
    const r = await call(env, "/api/scrobble?st=" + encodeURIComponent(token) + "&filterUsers=1&blockAnon=1", {
      method: "POST", ip: nextIp(), json: plex(null),
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.ignored, "No username in payload and user filtering is active.");
    const diag = JSON.parse(await env.CONFIGS.get("creatortrack:" + name));
    assert.equal(diag.lastUser, null);
    assert.equal(diag.lastPingId, "tt0137523");
  });
});
