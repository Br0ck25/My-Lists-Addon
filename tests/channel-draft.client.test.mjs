// UI-04: a half-built channel survives a reload, per account, and a signed-out
// visitor is never dropped into an empty builder.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadClient } from "./client-harness.mjs";

const KEY = "myListAddon:channelDraft:alice";
const item = { id: "tt1", showName: "Show", title: "Show", season: 1, episode: 1, epName: "Pilot" };

function builder(opts = {}) {
  const c = loadClient({ signedIn: true, ...opts });
  c.get("document").getElementById("channelNameInput").value = "";
  return c;
}

describe("channel builder draft", () => {
  it("saves the name, description and picks under the account's own key", () => {
    const c = builder();
    const doc = c.get("document");
    doc.getElementById("channelNameInput").value = "Friday Night";
    doc.getElementById("channelDescriptionInput").value = "Old sitcoms";
    c.set("channelDraftItems", [item]);
    c.call("saveChannelDraft");
    const saved = JSON.parse(c.localStorage.getItem(KEY));
    assert.equal(saved.name, "Friday Night");
    assert.equal(saved.items.length, 1);
    assert.equal(saved.settings.description, "Old sitcoms");
  });

  it("an empty builder stores nothing, and clears an older draft", () => {
    const c = builder({ storage: { [KEY]: JSON.stringify({ name: "x", items: [item] }) } });
    c.call("saveChannelDraft");
    assert.equal(c.localStorage.getItem(KEY), null);
  });

  it("after a reload with the builder open, the name and picks are back", () => {
    const first = builder();
    first.get("document").getElementById("channelNameInput").value = "Friday Night";
    first.set("channelDraftItems", [item]);
    first.call("saveChannelDraft");
    const draft = first.localStorage.getItem(KEY);

    const second = builder({ storage: { [KEY]: draft, "myListAddon:creatorName": "alice", "myListAddon:channelsSubmenu": "build" } });
    assert.equal(second.call("restoreChannelDraft"), true);
    assert.equal(second.get("document").getElementById("channelNameInput").value, "Friday Night");
    assert.equal(second.get("channelDraftItems").length, 1);
  });

  it("another account's draft is not shown", () => {
    const draft = JSON.stringify({ name: "Alice only", items: [item] });
    const c = loadClient({ signedIn: "bob", storage: { "myListAddon:channelDraft:alice": draft, "myListAddon:channelsSubmenu": "build" } });
    assert.equal(c.call("restoreChannelDraft"), false);
    assert.equal(c.get("channelDraftItems").length, 0);
  });

  it("does not restore when the builder was not the open sub-tab", () => {
    const draft = JSON.stringify({ name: "Kept", items: [item] });
    const c = builder({ storage: { [KEY]: draft, "myListAddon:channelsSubmenu": "my-channels" } });
    assert.equal(c.call("restoreChannelDraft"), false);
  });

  it("cancelling the build clears the draft", async () => {
    const c = builder({ storage: { [KEY]: JSON.stringify({ name: "x", items: [item] }) } });
    await c.call("cancelEditChannel");
    assert.equal(c.localStorage.getItem(KEY), null);
  });

  it("signed out, a remembered 'build' sub-tab falls back to My Channels", () => {
    const c = loadClient({ storage: { "myListAddon:channelsSubmenu": "build" } });
    assert.equal(c.localStorage.getItem("myListAddon:channelsSubmenu"), "my-channels");
  });

  it("signed in, 'build' stays", () => {
    const c = loadClient({ signedIn: true, storage: { "myListAddon:creatorName": "alice", "myListAddon:channelsSubmenu": "build" } });
    assert.equal(c.localStorage.getItem("myListAddon:channelsSubmenu"), "build");
  });
});
