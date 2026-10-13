// The Stremio and Nuvio cards in Settings (17_client-my-lists-and-trakt-oauth.js).
// The page holds no token for either: it sends the sign-in once and then only
// reads and changes the server's settings row.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadClient, requestsTo } from "./client-harness.mjs";

const el = (c, id) => c.document.getElementById(id);

describe("Stremio and Nuvio cards", () => {
  it("shows a live connection with its settings, and hides the sign-in", () => {
    const c = loadClient({ signedIn: true });
    c.call("renderMediaAppStatus", "nuvio", {
      connected: true, status: "ok", username: "viewer@example.test", pushAvailable: true,
      sync: { profileIndex: 2, pull: true, push: false, lastPullAt: Date.UTC(2026, 9, 12, 10, 0, 0), error: null },
    });
    assert.match(el(c, "nuvioConnectStatus").innerHTML, /Connected as viewer@example\.test/);
    assert.equal(el(c, "nuvioSyncWrap").style.display, "");
    assert.equal(el(c, "nuvioLoginForm").style.display, "none");
    assert.equal(el(c, "nuvioDisconnectBtn").style.display, "");
    assert.equal(el(c, "nuvioPullCheckbox").checked, true);
    assert.equal(el(c, "nuvioPushCheckbox").checked, false);
    assert.equal(el(c, "nuvioPushRow").style.display, "", "the two-way toggle shows when the server allows it");
    assert.match(el(c, "nuvioProfileSelect").innerHTML, /<option value="2" selected>/);
    assert.match(el(c, "nuvioSyncStatus").textContent, /^Last checked /);
  });

  it("keeps the two-way toggle away unless the server turned it on", () => {
    const c = loadClient({ signedIn: true });
    c.call("renderMediaAppStatus", "stremio", { connected: true, status: "ok", username: "a@b.test", pushAvailable: false, sync: { pull: true, push: false } });
    assert.equal(el(c, "stremioPushRow").style.display, "none");
  });

  it("shows the error the last sync ended with in place of the time", () => {
    const c = loadClient({ signedIn: true });
    c.call("renderMediaAppStatus", "stremio", { connected: true, status: "ok", username: "a@b.test", sync: { pull: true, push: false, lastPullAt: 5, error: "Sign in again to keep syncing." } });
    assert.equal(el(c, "stremioSyncStatus").textContent, "Sign in again to keep syncing.");
  });

  it("asks to reconnect when the server says the sign-in lapsed, and hides the settings", () => {
    const c = loadClient({ signedIn: true });
    c.call("renderMediaAppStatus", "nuvio", { connected: true, status: "expired", username: "a@b.test", sync: { pull: true } });
    assert.match(el(c, "nuvioConnectStatus").innerHTML, /Sign in again/);
    assert.equal(el(c, "nuvioConnectBtn").textContent, "Reconnect Nuvio");
    assert.equal(el(c, "nuvioConnectBtn").style.display, "");
    assert.equal(el(c, "nuvioSyncWrap").style.display, "none");
  });

  it("escapes the account name it shows", () => {
    const c = loadClient({ signedIn: true });
    c.call("renderMediaAppStatus", "stremio", { connected: true, status: "ok", username: "<img src=x onerror=alert(1)>", sync: {} });
    assert.ok(!el(c, "stremioConnectStatus").innerHTML.includes("<img"));
  });

  it("sends each setting to the server by name, and the profile as a number", async () => {
    const calls = [];
    const c = loadClient({
      signedIn: true,
      routes: {
        "/api/connections/nuvio/settings": (r) => { calls.push(r); return { json: { ok: true, connected: true, status: "ok", sync: {} } }; },
      },
    });
    await c.call("setMediaAppSyncOption", "nuvio", "push", true);
    await c.call("setMediaAppSyncOption", "nuvio", "pull", false);
    await c.call("setMediaAppSyncOption", "nuvio", "profileIndex", "3");
    await c.call("setMediaAppSyncOption", "nuvio", "profileIndex", "");
    const posts = calls.filter((r) => r.method === "POST").map((r) => r.body);
    assert.deepEqual(posts, [{ push: true }, { pull: false }, { profileIndex: 3 }], "choosing no profile sends nothing");
  });

  it("sends the Nuvio password once, clears the box, and keeps it nowhere", async () => {
    const c = loadClient({
      signedIn: true,
      routes: {
        "/api/connections/nuvio/login": () => ({ json: { ok: true, status: "connected", profiles: [{ index: 1, name: "Main" }], profileIndex: 1 } }),
        "/api/connections/nuvio/settings": () => ({ json: { ok: true, connected: true, status: "ok", sync: { profileIndex: 1, pull: true } } }),
      },
    });
    el(c, "nuvioEmailInput").value = "viewer@example.test";
    el(c, "nuvioPasswordInput").value = "hunter2-secret";
    await c.call("submitNuvioLogin");
    const sent = requestsTo(c, "/api/connections/nuvio/login");
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].body, { email: "viewer@example.test", password: "hunter2-secret" });
    assert.equal(el(c, "nuvioPasswordInput").value, "");
    assert.ok(c.localStorage._store instanceof Map, "the storage stub changed shape");
    assert.ok(!JSON.stringify([...c.localStorage._store.entries()]).includes("hunter2-secret"), "not written to storage");
  });

  it("does not call the server for an empty Nuvio form", async () => {
    const c = loadClient({ signedIn: true, routes: {} });
    el(c, "nuvioEmailInput").value = "";
    el(c, "nuvioPasswordInput").value = "";
    await c.call("submitNuvioLogin");
    assert.equal(c.requests.length, 0);
  });

  it("only links to Stremio's own link page", async () => {
    const c = loadClient({
      signedIn: true,
      routes: { "/api/connections/stremio/link/start": () => ({ json: { ok: true, code: "ABCD1234", link: "javascript:alert(1)" } }) },
    });
    await c.call("startStremioConnect");
    const html = el(c, "stremioLinkBox").innerHTML;
    assert.ok(!html.includes("javascript:"));
    assert.match(html, /href="https:\/\/link\.stremio\.com\/"/);
    assert.match(html, /ABCD1234/);
  });
});
