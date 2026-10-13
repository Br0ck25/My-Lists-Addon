// The Stremio and Nuvio cards in Settings (17_client-my-lists-and-trakt-oauth.js).
// The page holds no token for either: it sends the sign-in once and then only
// reads and changes the server's settings row.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadClient, renderPage, requestsTo } from "./client-harness.mjs";

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

  it("shows the reason the server gives next to the message", async () => {
    const c = loadClient({
      signedIn: true,
      routes: { "/api/connections/nuvio/login": () => ({ status: 502, json: { ok: false, error: "That service didn't answer. Please try again in a minute.", detail: "Nuvio answered 403" } }) },
    });
    const toasts = [];
    c.set("showToast", (m, kind) => toasts.push([m, kind]));
    el(c, "nuvioEmailInput").value = "a@b.test";
    el(c, "nuvioPasswordInput").value = "pw";
    await c.call("submitNuvioLogin");
    assert.deepEqual(toasts, [["That service didn't answer. Please try again in a minute. (Nuvio answered 403)", "error"]]);
  });

  it("does not call the server for an empty Nuvio form", async () => {
    const c = loadClient({ signedIn: true, routes: {} });
    el(c, "nuvioEmailInput").value = "";
    el(c, "nuvioPasswordInput").value = "";
    await c.call("submitNuvioLogin");
    assert.equal(c.requests.length, 0);
  });

  const linkRoutes = (extra = {}) => ({
    "/api/v2/create": () => ({ json: { result: { success: true, code: "L5YR", link: "https://link.stremio.com/L5YR" } } }),
    ...extra,
  });

  it("starts the Stremio link from the browser, and only links to Stremio's own page", async () => {
    const c = loadClient({ signedIn: true, routes: linkRoutes({ "/api/v2/create": () => ({ json: { result: { code: "ABCD", link: "javascript:alert(1)" } } }) }) });
    await c.call("startStremioConnect");
    const html = el(c, "stremioLinkBox").innerHTML;
    assert.ok(!html.includes("javascript:"));
    assert.match(html, /href="https:\/\/link\.stremio\.com\/"/);
    assert.match(html, /ABCD/);
    assert.equal(requestsTo(c, "/api/connections/stremio/link/start").length, 0, "the Worker is not asked to start it");
    assert.match(requestsTo(c, "/api/v2/create")[0].url, /^https:\/\/link\.stremio\.com\/api\/v2\/create\?type=Create$/);
  });

  it("hands the authKey Stremio returns to the server once, and nothing else", async () => {
    const c = loadClient({
      signedIn: true,
      routes: linkRoutes({
        "/api/v2/read": () => ({ json: { result: { authKey: "KEY-FROM-STREMIO" } } }),
        "/api/connections/stremio/link/complete": () => ({ json: { ok: true, status: "connected", username: "a@b.test" } }),
        "/api/connections/stremio/settings": () => ({ json: { ok: true, connected: true, status: "ok", username: "a@b.test", sync: { pull: true } } }),
      }),
    });
    await c.call("startStremioConnect");
    await c.call("mediaAppUiStremioPoll", "L5YR");
    const sent = requestsTo(c, "/api/connections/stremio/link/complete");
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].body, { authKey: "KEY-FROM-STREMIO" });
    assert.ok(!JSON.stringify([...c.localStorage._store.entries()]).includes("KEY-FROM-STREMIO"), "not kept in the page");
    assert.match(requestsTo(c, "/api/v2/read")[0].url, /code=L5YR/);
  });

  it("keeps waiting while Stremio says the code is not approved yet", async () => {
    const c = loadClient({ signedIn: true, routes: linkRoutes({ "/api/v2/read": () => ({ json: { error: { code: 101, message: "Invalid or expired token" } } }) }) });
    const done = await c.call("mediaAppUiStremioPoll", "L5YR");
    assert.equal(done, false);
    assert.equal(requestsTo(c, "/api/connections/stremio/link/complete").length, 0);
  });

  it("asks the server to disconnect on the exact path, with no trailing slash", async () => {
    const c = loadClient({
      signedIn: true,
      routes: {
        "/api/connections/nuvio": () => ({ json: { ok: true, removed: true } }),
        "/api/connections/nuvio/settings": () => ({ json: { ok: true, connected: false } }),
      },
    });
    c.set("showAppConfirm", (title, msg, label, onConfirm) => onConfirm());
    await c.call("disconnectMediaApp", "nuvio");
    await new Promise((r) => setTimeout(r, 0));
    const del = c.requests.filter((r) => r.method === "DELETE");
    assert.deepEqual(del.map((r) => r.pathname), ["/api/connections/nuvio"]);
  });

  it("lists the Nuvio profiles the server named, and only those", () => {
    const c = loadClient({ signedIn: true });
    c.call("renderMediaAppStatus", "nuvio", { connected: true, status: "ok", username: "a@b.test", profiles: [{ index: 1, name: "Me" }, { index: 3, name: "Kids" }], sync: { profileIndex: 3, pull: true } });
    const html = el(c, "nuvioProfileSelect").innerHTML;
    assert.match(html, /<option value="1">Me<\/option>/);
    assert.match(html, /<option value="3" selected>Kids<\/option>/);
    assert.ok(!html.includes("Profile 2"), "no made-up profiles");
  });
});

describe("Nuvio and Stremio under Lists, My Lists", () => {
  const live = { connected: true, status: "ok", username: "a@b.test", sync: { pull: true, profileIndex: 1 } };

  it("offers Watch History and Continue Watching once the app is connected", () => {
    const c = loadClient({ signedIn: true });
    c.call("renderMediaAppStatus", "nuvio", live);
    const html = el(c, "myNuvioListsResult").innerHTML;
    assert.match(html, /Nuvio Watch History/);
    assert.match(html, /Nuvio Continue Watching/);
    assert.match(html, /\+ Add/);
    assert.ok(!/Stremio/.test(html), "each app has its own panel");
  });

  it("says where to connect when the app is not connected, or its sign-in lapsed", () => {
    const c = loadClient({ signedIn: true });
    c.call("renderMediaAppStatus", "stremio", { connected: false });
    assert.match(el(c, "myStremioListsResult").innerHTML, /Connect Stremio in Settings/);
    c.call("renderMediaAppStatus", "stremio", { ...live, status: "expired" });
    assert.match(el(c, "myStremioListsResult").innerHTML, /Connect Stremio in Settings/);
    assert.ok(!/Watch History/.test(el(c, "myStremioListsResult").innerHTML));
  });

  it("gives each card a poster preview and a way to open the list, like the other services", () => {
    const c = loadClient({ signedIn: "alice" });
    let populated = 0;
    c.set("populateSearchResultPosters", () => { populated++; });
    c.call("renderMediaAppStatus", "nuvio", live);
    const html = el(c, "myNuvioListsResult").innerHTML;
    assert.match(html, /class="list-card-posters poster-preview-slot"[^>]*data-url="autotrack:nuvio-watch-history:mixed:alice"[^>]*data-type="mixed"/);
    assert.match(html, /data-url="autotrack:nuvio-continue-watching:mixed:alice"/);
    assert.match(html, /data-act="openMediaAppListDetails"/);
    assert.equal(populated, 1, "the slots are filled once the cards are in the page");
  });

  it("opens a list's details page for the mixed list", () => {
    const c = loadClient({ signedIn: "alice" });
    const opened = [];
    c.set("openListDetailsPage", (...args) => opened.push(args.slice(0, 3)));
    c.call("openMediaAppListDetails", "stremio", "watch-history");
    assert.deepEqual(opened, [["Stremio Watch History", "mixed", "autotrack:stremio-watch-history:mixed:alice"]]);
  });

  it("adds a movie row and a show row, each reading the account's own list", () => {
    const c = loadClient({ signedIn: "alice" });
    const rows = [];
    c.set("addRow", (...args) => rows.push(args));
    c.call("toggleMediaAppListAdd", "nuvio", "continue-watching", false);
    assert.deepEqual(rows.map((r) => [r[0], r[1], r[2]]), [
      ["Nuvio Continue Watching (Movies)", "autotrack:nuvio-continue-watching:movie:alice", "movie"],
      ["Nuvio Continue Watching (Shows)", "autotrack:nuvio-continue-watching:series:alice", "series"],
    ]);
  });

  it("removes both rows when the list was already added", () => {
    const c = loadClient({ signedIn: "alice" });
    const gone = [];
    c.set("removeListFromConfig", (...args) => gone.push(args));
    c.call("toggleMediaAppListAdd", "stremio", "watch-history", true);
    assert.deepEqual(gone, [
      ["autotrack:stremio-watch-history:movie:alice", "movie"],
      ["autotrack:stremio-watch-history:series:alice", "series"],
    ]);
  });

  it("shows Remove for a list whose rows are in the catalogs", () => {
    const c = loadClient({ signedIn: "alice" });
    c.set("isListAddedToConfig", () => true);
    c.call("renderMediaAppStatus", "nuvio", live);
    assert.match(el(c, "myNuvioListsResult").innerHTML, /Remove/);
  });

  it("has a panel for each app on the Lists page, beside the other providers", () => {
    const html = renderPage();
    for (const id of ["myListsSectionPanel-nuvio", "myListsSectionPanel-stremio", "myNuvioListsResult", "myStremioListsResult"]) assert.ok(html.includes(`id="${id}"`), id);
    const depth = (id) => {
      let d = 0;
      for (const m of html.slice(0, html.indexOf(`id="${id}"`)).matchAll(/<(\/?)div\b[^>]*>/g)) d += m[1] ? -1 : 1;
      return d;
    };
    assert.equal(depth("myListsSectionPanel-nuvio"), depth("myListsSectionPanel-simkl"));
    assert.equal(depth("myListsSectionPanel-stremio"), depth("myListsSectionPanel-simkl"));
  });
});

describe("Stremio and Nuvio cards in the page", () => {
  // They once sat inside the Simkl card (a missing </div>), narrower than the rest with a card inside the card.
  it("sit beside the other provider cards, not inside one", () => {
    const html = renderPage();
    const depthAt = (needle) => {
      const at = html.indexOf(needle);
      assert.ok(at > 0, needle + " is not in the page");
      let depth = 0;
      for (const m of html.slice(0, at).matchAll(/<(\/?)div\b[^>]*>/g)) depth += m[1] ? -1 : 1;
      return depth;
    };
    const ids = ["tmdbSection", "traktSection", "mdblistSection", "simklSection", "stremioSection", "nuvioSection"];
    const depths = ids.map((id) => depthAt(`<div class="provider-card" id="${id}"`));
    assert.deepEqual(new Set(depths).size, 1, "provider cards at different depths: " + ids.map((id, i) => `${id}=${depths[i]}`).join(", "));
  });
});
