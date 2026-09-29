// The provider credentials after P6-8, end to end: what the page keeps, what it
// pushes, and what the account keeps when a push cannot speak for them.
//
// P6-8 moved the eight Trakt/MDBList/Simkl/TMDB keys and tokens out of
// localStorage and into memory, which changed three things nobody had checked:
//
//   - clearLocalAccountData's storage sweep no longer reached them, so the next
//     account signed in on the same tab inherited the last one's;
//   - a tab whose first load failed opened the sync gate on its timer and
//     pushed them blank, and sync/save stored the blanks -- one failed load and
//     an autosave cost the account every connection;
//   - saveState still wrote the whole collectKeys() object, credentials
//     included, into myListAddon:state on every change.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { call, createUser, makeEnv } from "./harness.mjs";
import { loadClient, requestsTo } from "./client-harness.mjs";

const SECRET_FIELDS = [
  "tmdbKey", "tmdbSessionId", "mdblistKey", "mdblistAccessToken",
  "traktKey", "traktAccessToken", "simklKey", "simklAccessToken",
];

function syncLoadOk(keys) {
  return () => ({
    json: {
      ok: true,
      data: { updatedAt: 1, keys, config: [], hiddenLists: [], hiddenMyListsSections: [], likedLists: [] },
    },
  });
}

describe("sync/save keeps a credential the push leaves out", () => {
  it("keeps omitted credentials, stores the rest, and still clears an explicit blank", async () => {
    const env = makeEnv();
    const u = await createUser(env, "keysync");
    const save = (keys) => call(env, "/api/creator/sync/save", {
      method: "POST",
      json: { creatorName: u.creatorName, creatorKey: u.creatorKey, config: [], keys },
    });
    const load = async () => (await call(env, "/api/creator/sync/load", {
      method: "POST",
      json: { creatorName: u.creatorName, creatorKey: u.creatorKey },
    })).body.data.keys;

    assert.equal((await save({ traktAccessToken: "TRK", mdblistKey: "MDB", region: "US" })).body.ok, true);

    // A tab that never saw the account's credentials: no secret fields at all,
    // but a real settings change.
    assert.equal((await save({ region: "GB" })).body.ok, true);
    let keys = await load();
    assert.equal(keys.traktAccessToken, "TRK", "an omitted token is kept");
    assert.equal(keys.mdblistKey, "MDB", "an omitted key is kept");
    assert.equal(keys.region, "GB", "everything the push did send is stored");

    // A disconnect sends the blank on purpose, and it must still clear.
    assert.equal((await save({ traktAccessToken: "", region: "GB" })).body.ok, true);
    keys = await load();
    assert.equal(keys.traktAccessToken, "", "an explicit blank clears the token");
    assert.equal(keys.mdblistKey, "MDB");
  });
});

describe("the page's own copy of the credentials", () => {
  it("forgets them on sign-out, so the next account on this tab cannot inherit them", () => {
    const client = loadClient({ signedIn: true });
    client.call("rememberProviderSecret", "myListAddon:traktAccessToken", "ALICE-TOKEN");
    client.call("rememberProviderSecret", "myListAddon:mdblistKey", "ALICE-MDB");
    client.call("clearLocalAccountData");
    assert.equal(client.call("readProviderSecret", "myListAddon:traktAccessToken"), "");
    assert.equal(client.call("readProviderSecret", "myListAddon:mdblistKey"), "");
    const keys = client.call("collectKeys");
    assert.equal(keys.traktAccessToken, "", "nothing of alice's left for the next push");
    assert.equal(keys.mdblistKey, "");
  });

  it("leaves unknown credentials out of a push after a failed load, instead of blanking them", async () => {
    const client = loadClient({
      signedIn: true,
      storage: { "myListAddon:mdblistDisconnected": "true" },
      routes: {
        "/api/creator/sync/load": () => ({ status: 500, json: { ok: false, error: "boom" } }),
        "/api/creator/sync/save": () => ({ json: { ok: true, updatedAt: 5 } }),
      },
    });
    await client.call("loadCreatorSync");
    // What the gate's failsafe does when the load never lands.
    client.call("markCreatorSyncLoaded");
    client.call("rememberProviderSecret", "myListAddon:simklKey", "SIM-TYPED-NOW");
    await client.call("pushCreatorSync");

    const pushes = requestsTo(client, "/api/creator/sync/save");
    assert.equal(pushes.length, 1);
    const keys = pushes[0].body.keys;
    for (const field of ["traktKey", "traktAccessToken", "tmdbKey", "tmdbSessionId", "simklAccessToken"]) {
      assert.equal(Object.prototype.hasOwnProperty.call(keys, field), false, `${field} must be left out, not sent blank`);
    }
    assert.equal(keys.simklKey, "SIM-TYPED-NOW", "a credential this tab does have still goes up");
    assert.equal(keys.mdblistKey, "", "a disconnected provider's blank is the disconnect, and is sent");
    assert.equal(keys.mdblistAccessToken, "");
    assert.ok("region" in keys, "the rest of the settings still travel");
  });

  it("sends every field, blanks included, once the account's own credentials are in", async () => {
    const client = loadClient({
      signedIn: true,
      routes: {
        "/api/creator/sync/load": syncLoadOk({ traktAccessToken: "TRK" }),
        "/api/creator/sync/save": () => ({ json: { ok: true, updatedAt: 5 } }),
      },
    });
    await client.call("loadCreatorSync");
    await client.call("pushCreatorSync");
    const keys = requestsTo(client, "/api/creator/sync/save").at(-1).body.keys;
    for (const field of SECRET_FIELDS) {
      assert.ok(Object.prototype.hasOwnProperty.call(keys, field), `${field} is part of a normal push`);
    }
    assert.equal(keys.traktAccessToken, "TRK");
  });
});

describe("myListAddon:state no longer carries the credentials", () => {
  function storedKeys(client) {
    return JSON.parse(client.localStorage.getItem("myListAddon:state")).keys;
  }

  it("does not write a credential this tab holds into the saved state", () => {
    const client = loadClient();
    client.call("rememberProviderSecret", "myListAddon:traktAccessToken", "TRK");
    client.set("traktAccessToken", "TRK");
    client.call("saveState");
    const keys = storedKeys(client);
    for (const field of SECRET_FIELDS) {
      assert.equal(field in keys, false, `${field} must not be in myListAddon:state`);
    }
    assert.ok("region" in keys, "the settings are still saved");
  });

  it("carries an older copy forward until the account hands the credentials back", async () => {
    const client = loadClient({
      signedIn: true,
      storage: {
        "myListAddon:mdblistDisconnected": "true",
        "myListAddon:state": JSON.stringify({
          entries: [],
          keys: { traktAccessToken: "OLD-TRK", mdblistAccessToken: "OLD-MDB", region: "US" },
        }),
      },
      routes: { "/api/creator/sync/load": syncLoadOk({ traktAccessToken: "OLD-TRK" }) },
    });
    client.call("saveState");
    let keys = storedKeys(client);
    assert.equal(keys.traktAccessToken, "OLD-TRK", "kept while the account has not answered");
    assert.equal("mdblistAccessToken" in keys, false, "never kept for a provider disconnected since");

    await client.call("loadCreatorSync");
    client.call("saveState");
    keys = storedKeys(client);
    assert.equal("traktAccessToken" in keys, false, "dropped once the account's own copy is in");
    assert.equal(client.call("readProviderSecret", "myListAddon:traktAccessToken"), "OLD-TRK", "and this tab still has it");
  });
});
