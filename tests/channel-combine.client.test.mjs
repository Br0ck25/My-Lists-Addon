import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadClient } from "./client-harness.mjs";

// "Combine into one channel": a NEW channel holding every pick of the checked
// channels, a pick two of them share counted once.

const ep = (imdbId, episode, showName) => ({
  kind: "episode", imdbId, season: 1, episode, showName, epName: "E" + episode, title: showName + " E" + episode, released: "2024-01-01",
});
const plain = (v) => JSON.parse(JSON.stringify(v));

function setup(channels, routes) {
  const client = loadClient({ signedIn: true, routes: routes || {} });
  const addedRows = [];
  client.set("addRow", (name, url, type, on, group, id) => { addedRows.push({ name, url, type, group, id }); });
  for (const ch of channels) client.call("saveLocalChannel", ch);
  const doc = client.get("document");
  const checks = channels.map((c) => ({ dataset: { channelid: c.channelId } }));
  doc.querySelectorAll = (sel) => (sel === "#channelMergeList .channelMergeCheck:checked" ? checks : []);
  doc.getElementById("channelMergeNameInput").value = "Combined";
  return { client, addedRows };
}

describe("client: combine channels into one channel", () => {
  it("keeps every pick once, in channel order, and adds one catalog row", async () => {
    const { client, addedRows } = setup([
      { channelId: "a", name: "A", items: [ep("tt1", 1, "One"), ep("tt1", 2, "One"), ep("tt2", 1, "Two")] },
      { channelId: "b", name: "B", items: [ep("tt2", 1, "Two"), ep("tt3", 1, "Three"), ep("tt1", 2, "One")] },
    ]);
    await client.call("combineChannelsIntoChannel");

    assert.equal(addedRows.length, 1);
    assert.equal(addedRows[0].name, "Combined");
    const payload = JSON.parse(addedRows[0].url.slice("channel:v1:".length));
    assert.deepEqual(plain(payload.items.map((i) => i.imdbId + ":" + i.episode)), ["tt1:1", "tt1:2", "tt2:1", "tt3:1"]);

    const saved = plain(client.call("loadLocalChannels"))[payload.channelId];
    assert.equal(saved.name, "Combined");
    assert.equal(saved.items.length, 4);
    // The originals are untouched.
    const all = plain(client.call("loadLocalChannels"));
    assert.equal(all.a.items.length, 3);
    assert.equal(all.b.items.length, 3);
  });

  it("counts a movie in two channels once, and does not mistake it for an episode", async () => {
    const movie = { kind: "movie", imdbId: "tt9", season: 1, episode: 1, showName: "M", epName: "", title: "M" };
    const { client, addedRows } = setup([
      { channelId: "a", name: "A", items: [movie, ep("tt9", 1, "Show with same id")] },
      { channelId: "b", name: "B", items: [movie] },
    ]);
    await client.call("combineChannelsIntoChannel");
    const payload = JSON.parse(addedRows[0].url.slice("channel:v1:".length));
    assert.equal(payload.items.length, 2, "the movie once, and the episode of the same id as its own pick");
  });

  it("keeps an option any of the channels has on, and drops per-channel locks and pointers", async () => {
    const { client, addedRows } = setup([
      { channelId: "a", name: "A", items: [ep("tt1", 1, "One")], shuffle: false, dailyRotate: false, presetNetworkId: "41", storyLocked: ["tt1"] },
      { channelId: "b", name: "B", items: [ep("tt2", 1, "Two")], shuffle: true, dailyRotate: true, hideWatched: true },
    ]);
    await client.call("combineChannelsIntoChannel");
    const payload = JSON.parse(addedRows[0].url.slice("channel:v1:".length));
    assert.equal(payload.shuffle, true);
    assert.equal(payload.dailyRotate, true);
    assert.equal(payload.hideWatched, true);
    assert.deepEqual(plain(payload.storyLocked), []);
    assert.ok(!payload.presetNetworkId, "the new channel is not a network preset");
  });

  it("fetches a Quick Add network's full lineup instead of using its small saved sample", async () => {
    const full = Array.from({ length: 300 }, (_, i) => ep("ttN" + i, 1, "Net " + i));
    const { client, addedRows } = setup([
      { channelId: "net", name: "Net", presetNetworkId: "41", items: full.slice(0, 5) },
      { channelId: "b", name: "B", items: [ep("ttN0", 1, "Net 0"), ep("ttB", 1, "B")] },
    ], { "/api/channel-preset": () => ({ json: { ok: true, channel: { items: full } } }) });
    await client.call("combineChannelsIntoChannel");
    const payload = JSON.parse(addedRows[0].url.slice("channel:v1:".length));
    assert.equal(payload.items.length, 301, "300 from the network plus B's one new pick");
  });

  it("uses what is held locally when the lineup cannot be fetched", async () => {
    const { client, addedRows } = setup([
      { channelId: "net", name: "Net", presetNetworkId: "41", items: [ep("ttN1", 1, "Net")] },
      { channelId: "b", name: "B", items: [ep("ttB", 1, "B")] },
    ], { "/api/channel-preset": () => ({ status: 500, json: { ok: false } }) });
    await client.call("combineChannelsIntoChannel");
    const payload = JSON.parse(addedRows[0].url.slice("channel:v1:".length));
    assert.equal(payload.items.length, 2);
  });

  it("needs two channels and a name, and does not count Next Up", async () => {
    const { client, addedRows } = setup([
      { channelId: "a", name: "A", items: [ep("tt1", 1, "One")] },
      { channelId: "n", name: "Next Up", dynamic: "next-up", items: [ep("tt2", 1, "Two")] },
    ]);
    await client.call("combineChannelsIntoChannel");
    assert.equal(addedRows.length, 0, "Next Up has no picks of its own, leaving one channel");

    const named = setup([{ channelId: "a", name: "A", items: [ep("tt1", 1, "One")] }, { channelId: "b", name: "B", items: [ep("tt2", 1, "Two")] }]);
    named.client.get("document").getElementById("channelMergeNameInput").value = "  ";
    await named.client.call("combineChannelsIntoChannel");
    assert.equal(named.addedRows.length, 0);
  });
});
