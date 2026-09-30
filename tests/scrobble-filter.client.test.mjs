// "Enable media server user filtering" (renderTrackPlaybackSection,
// 22_client-creator-profile.js): unticking it with names still in the list
// has to stay unticked. Having names saved used to switch the box on at every
// redraw -- and every sync load redraws the section -- while the server, which
// reads the saved choice, had filtering off.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadClient } from "./client-harness.mjs";

function renderedFilterBox(storage) {
  const client = loadClient({ signedIn: true, storage });
  client.call("renderTrackPlaybackSection");
  const html = client.document.getElementById("trackPlaybackSection").innerHTML;
  const input = html.match(/<input type="checkbox" id="scrobbleFilterUsersCb"[^>]*>/);
  assert.ok(input, "the filtering checkbox was not rendered");
  return / checked /.test(input[0]) || /\schecked\b/.test(input[0]);
}

describe("media server user filtering checkbox", () => {
  it("stays off when switched off with names saved", () => {
    assert.equal(renderedFilterBox({
      "myListAddon:scrobbleFilterUsers": "0",
      "myListAddon:scrobbleAllowedUsers": "alice, bob",
    }), false);
  });

  it("is on when switched on", () => {
    assert.equal(renderedFilterBox({
      "myListAddon:scrobbleFilterUsers": "1",
      "myListAddon:scrobbleAllowedUsers": "alice",
    }), true);
  });

  it("follows the names for a browser that never saved a choice", () => {
    assert.equal(renderedFilterBox({ "myListAddon:scrobbleAllowedUsers": "alice" }), true);
    assert.equal(renderedFilterBox({}), false);
  });
});

// Ticking it has to reach the account even when that push is refused because
// another device or tab saved first (409). The refusal reloads the account and
// retries -- and that reload used to write the account's old setting back over
// the one just ticked, so the retry sent "off" and a refresh showed it off.
describe("a playback setting changed here survives the account's reload", () => {
  function settingsClient({ conflictFirst }) {
    const saves = [];
    let loads = 0;
    const accountState = { scrobbleFilterUsers: false, scrobbleAllowedUsers: "", scrobbleBlockAnonymous: false, trackPlayback: true };
    const routes = new Proxy({
      "/api/creator/sync/save-tracking": async (req) => {
        saves.push(req.body);
        if (conflictFirst && saves.length === 1) return { status: 409, json: { ok: false, conflict: true, clientVersion: 7 } };
        accountState.scrobbleFilterUsers = req.body.scrobbleFilterUsers;
        return { json: { ok: true, clientVersion: 8 + saves.length } };
      },
      "/api/creator/sync/load": async () => {
        loads += 1;
        return { json: { ok: true, data: { config: [], trackingUpdatedAt: 100 + loads, trackingClientVersion: 7, ...accountState } } };
      },
    }, { get(t, k) { return t[k] || (async () => ({ json: { ok: true } })); } });
    const client = loadClient({ signedIn: "alice", routes, storage: { "myListAddon:scrobbleFilterUsers": "0" } });
    client.set("_creatorSyncLoadedFor", "alice");
    client.set("window._serverTrackingClientVersion", 5);
    return { client, saves, loads: () => loads };
  }

  it("sends the new setting again after a conflict, and keeps it ticked", async () => {
    const { client, saves, loads } = settingsClient({ conflictFirst: true });
    await client.call("onScrobbleFilterUsersToggle", { checked: true });
    for (let i = 0; i < 50 && saves.length < 2; i++) await new Promise((r) => setTimeout(r, 0));
    assert.equal(loads(), 1, "the refusal reloads the account once");
    assert.equal(saves.length, 2, "and retries once");
    assert.equal(saves[1].scrobbleFilterUsers, true, "the retry must carry the setting just ticked");
    assert.equal(client.localStorage.getItem("myListAddon:scrobbleFilterUsers"), "1");
    assert.equal(client.call("trackingSettingsEditedAt"), 0, "the account has it now, so the mark is cleared");
  });

  it("lets the account's value in again once nothing is pending", async () => {
    const { client } = settingsClient({ conflictFirst: false });
    await client.call("loadCreatorSync", { background: true });
    assert.equal(client.localStorage.getItem("myListAddon:scrobbleFilterUsers"), "0", "a plain load still follows the account");
  });

  it("keeps a mark for the account it was made on only", () => {
    const { client } = settingsClient({ conflictFirst: false });
    client.call("markTrackingSettingsEdited");
    assert.ok(client.call("trackingSettingsEditedAt") > 0);
    client.set("activeCreator", { creatorName: "bob" });
    assert.equal(client.call("trackingSettingsEditedAt"), 0, "another account's load is not held back by alice's change");
  });
});
