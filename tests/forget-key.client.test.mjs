// SEC-03 (owner decision 2026-11-02): once a browser holds a working session,
// it forgets the Account Key, so a script or extension on the page, or the next
// person on a shared computer, cannot take it. The session renews while it is
// used (tests/session-sliding.test.mjs), so someone who visits regularly never
// types the key again; when the session does end, the sign-in prompt appears
// instead of the key being resent. Behind FF_FORGET_KEY (off by default): the
// page only acts when the server says X-MLA-Forget-Key: 1.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadClient, requestsTo } from "./client-harness.mjs";

const KEY = "MYL-AAAA-BBBB-CCCC";
const SIGNED_IN = {
  "myListAddon:creatorName": "alice",
  "myListAddon:creatorDisplayName": "Alice",
  "myListAddon:creatorKey": KEY,
  "myListAddon:sessionFor": "alice",
  "myListAddon:hasRecoveryAnswer": "1",
};
const SESSION_HEADERS = { "X-MLA-Session": "alice", "X-MLA-Forget-Key": "1" };
const saveOk = (headers) => () => ({ json: { ok: true, updatedAt: 2 }, headers });

function setup({ storage = SIGNED_IN, routes = {}, dialog = true } = {}) {
  const client = loadClient({ storage, routes });
  const dialogs = [];
  client.set("appShellDialog", async (o) => { dialogs.push(o); return dialog; });
  const store = client.localStorage;
  return { client, dialogs, store };
}
// What the page does on every sync call: send it, and note the headers.
const touchServer = (client) => client.call("creatorApiFetch", "https://example.com/api/creator/sync/save", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ creatorName: "alice", creatorKey: KEY, config: [] }),
});
const flush = () => new Promise((r) => setImmediate(r));

describe("SEC-03: the page forgets the Account Key once the session holds the sign-in", () => {
  it("removes the key, keeps the name and marks the browser as signed in by session", async () => {
    const { client, store } = setup({ routes: { "/api/creator/sync/save": saveOk(SESSION_HEADERS) } });
    await touchServer(client);
    client.call("markCreatorSyncLoaded");
    await flush();
    assert.equal(store.getItem("myListAddon:creatorKey"), null, "the key is gone from storage");
    assert.equal(store.getItem("myListAddon:creatorName"), "alice");
    assert.equal(store.getItem("myListAddon:keyForgotten"), "alice");
    assert.ok(client.get("activeCreator"), "still signed in on this page");
  });

  it("tells the person once, with the key on screen to copy, before it forgets it", async () => {
    const { client, dialogs } = setup({ routes: { "/api/creator/sync/save": saveOk(SESSION_HEADERS) } });
    await touchServer(client);
    client.call("markCreatorSyncLoaded");
    await flush();
    assert.equal(dialogs.length, 1);
    assert.match(dialogs[0].message, new RegExp(KEY), "the key is shown so it can be saved");
    assert.match(dialogs[0].message, /safe/i);
    client.call("markCreatorSyncLoaded");
    await flush();
    assert.equal(dialogs.length, 1, "not asked again");
  });

  it("keeps the key when the person does not confirm, and asks again on the next visit, not on every load", async () => {
    const routes = { "/api/creator/sync/save": saveOk(SESSION_HEADERS) };
    const { client, store, dialogs } = setup({ dialog: false, routes });
    await touchServer(client);
    client.call("markCreatorSyncLoaded");
    await flush();
    assert.equal(store.getItem("myListAddon:creatorKey"), KEY);
    assert.equal(store.getItem("myListAddon:keyForgotten"), null);
    client.call("markCreatorSyncLoaded");
    await flush();
    assert.equal(dialogs.length, 1, "not again on this page");
    const next = setup({ dialog: false, routes });
    await touchServer(next.client);
    next.client.call("markCreatorSyncLoaded");
    await flush();
    assert.equal(next.dialogs.length, 1, "asked again on the next page load");
  });

  it("offers a recovery answer to someone who has none", async () => {
    const storage = { ...SIGNED_IN, "myListAddon:hasRecoveryAnswer": "0" };
    const { client, dialogs } = setup({ storage, routes: { "/api/creator/sync/save": saveOk(SESSION_HEADERS) } });
    await touchServer(client);
    client.call("markCreatorSyncLoaded");
    await flush();
    assert.match(dialogs[0].message, /recovery answer/i);
    const withAnswer = setup({ routes: { "/api/creator/sync/save": saveOk(SESSION_HEADERS) } });
    await touchServer(withAnswer.client);
    withAnswer.client.call("markCreatorSyncLoaded");
    await flush();
    assert.doesNotMatch(withAnswer.dialogs[0].message, /recovery answer/i);
  });

  it("does nothing when the server has not turned the feature on", async () => {
    const { client, store, dialogs } = setup({ routes: { "/api/creator/sync/save": saveOk({ "X-MLA-Session": "alice" }) } });
    await touchServer(client);
    client.call("markCreatorSyncLoaded");
    await flush();
    assert.equal(store.getItem("myListAddon:creatorKey"), KEY);
    assert.equal(dialogs.length, 0);
  });

  it("does nothing where storage cannot hold the session marker (blocked storage or cookies): today's behaviour", async () => {
    const storage = { ...SIGNED_IN };
    delete storage["myListAddon:sessionFor"];
    const { client, store, dialogs } = setup({ storage, routes: { "/api/creator/sync/save": saveOk(SESSION_HEADERS) } });
    const realSet = store.setItem;
    store.setItem = (k, v) => { if (k === "myListAddon:sessionFor") throw new Error("blocked"); return realSet(k, v); };
    await touchServer(client);
    client.call("markCreatorSyncLoaded");
    await flush();
    assert.equal(client.call("creatorSessionHeldFor"), "");
    assert.equal(store.getItem("myListAddon:creatorKey"), KEY);
    assert.equal(dialogs.length, 0);
  });
});

describe("SEC-03: a browser that has forgotten the key still works", () => {
  const FORGOTTEN = { ...SIGNED_IN, "myListAddon:keyForgotten": "alice" };
  delete FORGOTTEN["myListAddon:creatorKey"];

  it("starts signed in from the name and the session marker alone", () => {
    const { client } = setup({ storage: FORGOTTEN });
    assert.equal(client.get("activeCreator").creatorName, "alice");
    assert.equal(client.call("isSignedIn"), true);
  });

  it("is not signed in if the session marker is gone (it is not enough to have a name)", () => {
    const storage = { ...FORGOTTEN };
    delete storage["myListAddon:sessionFor"];
    const { client } = setup({ storage });
    assert.equal(client.get("activeCreator"), null);
  });

  it("a save still goes out, signed by the session: the name and no key", async () => {
    const { client } = setup({ storage: FORGOTTEN, routes: { "/api/creator/sync/save": saveOk(SESSION_HEADERS) } });
    client.call("markCreatorSyncLoaded");
    await client.call("pushCreatorSync");
    const saves = requestsTo(client, "/api/creator/sync/save");
    assert.ok(saves.length >= 1, "the save was sent");
    assert.equal(saves[0].body.creatorName, "alice");
    assert.ok(!saves[0].body.creatorKey, "no key in the request");
  });

  it("the sign-in check on page load works without the key", async () => {
    const { client } = setup({
      storage: FORGOTTEN,
      routes: {
        "/api/creator/restore": () => ({ json: { ok: true, creatorName: "alice", displayName: "Alice" }, headers: SESSION_HEADERS }),
        "/api/creator/sync/load": () => ({ json: { ok: true, data: null, resetAt: 0 }, headers: SESSION_HEADERS }),
        "/api/creator/sync/save": saveOk(SESSION_HEADERS),
      },
    });
    await client.call("tryAutoRestoreCreatorProfile");
    const restores = requestsTo(client, "/api/creator/restore");
    assert.ok(restores.length >= 1, "the page checks the sign-in on load");
    for (const r of restores) {
      assert.equal(r.body.creatorName, "alice");
      assert.ok(!r.body.creatorKey, "no key in the check");
    }
    // Nothing the page sends to an account route carries a key.
    const sent = client.requests.filter((r) => r.pathname.startsWith("/api/creator/") && r.body);
    assert.ok(sent.length > 3, "the signed-in page talks to the account routes");
    for (const r of sent) assert.ok(!r.body.creatorKey, r.pathname + " sent a key");
    assert.ok(client.get("activeCreator"));
  });

  it("a 401 from a session-only request shows the sign-in prompt and does not resend a key", async () => {
    const { client, store } = setup({ storage: FORGOTTEN, routes: { "/api/creator/sync/save": () => ({ status: 401, json: { ok: false, error: "Username or Key is incorrect." } }) } });
    let prompted = 0;
    client.set("openRestoreModal", () => { prompted++; });
    await client.call("creatorApiFetch", "https://example.com/api/creator/sync/save", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ creatorName: "alice", config: [] }),
    });
    await flush();
    assert.equal(requestsTo(client, "/api/creator/sync/save").length, 1, "one request, not a retry");
    assert.ok(!requestsTo(client, "/api/creator/sync/save")[0].body.creatorKey);
    assert.equal(prompted, 1, "the existing sign-in prompt is shown");
    assert.equal(client.get("activeCreator"), null);
    assert.equal(store.getItem("myListAddon:keyForgotten"), null);
    assert.equal(store.getItem("myListAddon:sessionFor"), null);
  });

  it("a 401 for a browser that still holds its key is retried with the key, as before", async () => {
    let n = 0;
    const { client } = setup({ routes: { "/api/creator/sync/save": () => (++n === 1 ? { status: 401, json: { ok: false } } : { json: { ok: true, updatedAt: 3 } }) } });
    const res = await client.call("creatorApiFetch", "https://example.com/api/creator/sync/save", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ creatorName: "alice", creatorKey: KEY, config: [] }),
    });
    assert.equal(res.status, 200);
    assert.equal(requestsTo(client, "/api/creator/sync/save").length, 2);
    assert.equal(requestsTo(client, "/api/creator/sync/save")[1].body.creatorKey, KEY);
  });

  it("signing out clears the marker too", () => {
    const { client, store } = setup({ storage: FORGOTTEN });
    client.call("clearLocalAccountData");
    assert.equal(store.getItem("myListAddon:keyForgotten"), null);
    assert.equal(store.getItem("myListAddon:creatorName"), null);
  });
});
