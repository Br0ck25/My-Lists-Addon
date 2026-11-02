// The Stremio and Nuvio cards in Settings (src/client/17_client-my-lists-and-trakt-oauth.js).
// The page holds no token for either: it sends the sign-in once and then only
// reads and changes the server's settings row.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadClient, renderPage, requestsTo } from "./client-harness.mjs";

const el = (c, id) => c.document.getElementById(id);

describe("connection buttons under My Lists", () => {
  it("renders both buttons and updates their labels for connected and expired accounts", () => {
    const html = renderPage();
    assert.match(html, /id="listsNuvioConnectBtn"[^>]*data-act="toggleListsMediaAppConnection"/);
    assert.match(html, /id="listsStremioConnectBtn"[^>]*data-act="toggleListsMediaAppConnection"/);
    const c = loadClient({ signedIn: "alice" });
    c.call("renderMediaAppStatus", "nuvio", { connected: true, status: "ok", sync: { lastPullAt: Date.now() } });
    assert.equal(el(c, "listsNuvioConnectBtn").textContent, "Disconnect");
    c.call("renderMediaAppStatus", "stremio", { connected: true, status: "expired", sync: {} });
    assert.equal(el(c, "listsStremioConnectBtn").textContent, "Reconnect Stremio");
    c.call("renderMediaAppStatus", "nuvio", null);
    assert.equal(el(c, "listsNuvioConnectBtn").textContent, "Connect Nuvio");
  });
  it("opens the existing Nuvio sign-in, starts Stremio linking, and confirms disconnect", () => {
    const c = loadClient({ signedIn: "alice" });
    const calls = [];
    c.set("goToExternalSettings", () => calls.push("settings"));
    c.set("startStremioConnect", () => calls.push("stremio"));
    c.set("disconnectMediaApp", (p) => calls.push("disconnect:" + p));
    c.call("toggleListsMediaAppConnection", "nuvio");
    c.call("toggleListsMediaAppConnection", "stremio");
    c.call("renderMediaAppStatus", "nuvio", { connected: true, status: "ok", sync: { lastPullAt: Date.now() } });
    c.call("toggleListsMediaAppConnection", "nuvio");
    assert.deepEqual(calls, ["settings", "settings", "stremio", "disconnect:nuvio"]);
  });
});

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

  it("says how many titles the last check found", () => {
    const c = loadClient({ signedIn: true });
    const base = { connected: true, status: "ok", username: "a@b.test" };
    c.call("renderMediaAppStatus", "nuvio", { ...base, sync: { pull: true, lastPullAt: 5, lastResult: { found: 12, plays: 30, progress: 2, resumes: 1, unresolved: 0 } } });
    assert.match(el(c, "nuvioSyncStatus").textContent, /Found 12 titles\./);
    c.call("renderMediaAppStatus", "nuvio", { ...base, sync: { pull: true, lastPullAt: 5, lastResult: { found: 0, plays: 0, progress: 0, resumes: 0, unresolved: 0 } } });
    assert.match(el(c, "nuvioSyncStatus").textContent, /Found 0 titles\./);
    c.call("renderMediaAppStatus", "nuvio", { ...base, sync: { pull: true, lastPullAt: 5, lastResult: { found: 1, plays: 1, progress: 0, resumes: 0, unresolved: 0 } } });
    assert.match(el(c, "nuvioSyncStatus").textContent, /Found 1 title\./);
    c.call("renderMediaAppStatus", "nuvio", { ...base, sync: { pull: true, lastPullAt: 5, lastResult: { found: 4, plays: 1, progress: 0, resumes: 0, unresolved: 3 } } });
    assert.match(el(c, "nuvioSyncStatus").textContent, /3 could not be matched/);
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

  // link/complete runs the first history pull before it answers, which easily
  // outlasts the 3-second tick. A second tick then saw the same authKey and
  // connected again: two pulls at once, each counting the account as a new
  // watcher of the same shows (show_schedule.watcher_count +2 instead of +1).
  it("does not hand the authKey over twice while the first hand-over is still running", async () => {
    let release;
    const c = loadClient({
      signedIn: true,
      routes: linkRoutes({
        "/api/v2/read": () => ({ json: { result: { authKey: "KEY-FROM-STREMIO" } } }),
        "/api/connections/stremio/link/complete": async () => {
          await new Promise((r) => { release = r; });
          return { json: { ok: true, status: "connected", username: "a@b.test" } };
        },
        "/api/connections/stremio/settings": () => ({ json: { ok: true, connected: true, status: "ok", username: "a@b.test", sync: { pull: true } } }),
      }),
    });
    const ticks = [];
    c.set("setInterval", (fn) => { ticks.push(fn); return ticks.length; });
    await c.call("startStremioConnect");
    const first = ticks[0]();            // approved: the hand-over is still running
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    const second = ticks[0]();           // the next tick arrives meanwhile
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.equal(requestsTo(c, "/api/connections/stremio/link/complete").length, 1, "connected once, not twice");
    release(); await first; await second;
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
  // Checked a moment ago, so drawing the lists does not start an update.
  const live = { connected: true, status: "ok", username: "a@b.test", sync: { pull: true, profileIndex: 1, lastPullAt: Date.now() } };

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

  it("asks for the list's items as the signed-in account, not as the label on the page", async () => {
    const c = loadClient({
      signedIn: "alice",
      routes: { "/api/preview": () => ({ json: { ok: true, count: 0, sample: [], maybeMore: false } }) },
    });
    c.call("openListDetailsPage", "Nuvio Watch History", "mixed", "autotrack:nuvio-watch-history:mixed:alice");
    await new Promise((r) => setTimeout(r, 20));
    const asked = requestsTo(c, "/api/preview");
    assert.ok(asked.length > 0, "the details page asked for its items");
    assert.ok(asked.every((r) => r.body.creatorName === "alice"), "creatorName is the account: " + JSON.stringify(asked.map((r) => r.body.creatorName)));
  });

  it("keeps a Continue Watching list's movies, not only its shows", async () => {
    const c = loadClient({ signedIn: "alice", routes: { "/api/preview": () => ({ json: { ok: true, count: 0, sample: [], maybeMore: false } }) } });
    c.call("openListDetailsPage", "Nuvio Continue Watching", "mixed", "autotrack:nuvio-continue-watching:mixed:alice");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(requestsTo(c, "/api/preview")[0].body.type, "mixed");
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

describe("refreshing when Lists is opened", () => {
  const settingsRoute = (lastPullAt, calls) => () => { calls.push("settings"); return { json: { ok: true, connected: true, status: "ok", username: "a@b.test", sync: { pull: true, profileIndex: 1, lastPullAt } } }; };

  async function open(lastPullAt) {
    const calls = [];
    const c = loadClient({
      signedIn: "alice",
      routes: {
        "/api/connections/nuvio/settings": settingsRoute(lastPullAt, calls),
        "/api/connections/stremio/settings": () => ({ json: { ok: true, connected: false } }),
        "/api/connections/nuvio/sync": () => { calls.push("sync"); return { json: { ok: true, done: true } }; },
      },
    });
    await c.call("mediaAppUiRefresh", "nuvio");
    await new Promise((r) => setTimeout(r, 20));
    return { c, calls };
  }

  it("updates a copy older than two minutes before showing the lists, and says so", async () => {
    const { c, calls } = await open(Date.now() - 10 * 60 * 1000);
    const sync = requestsTo(c, "/api/connections/nuvio/sync");
    assert.equal(sync.length, 1);
    assert.deepEqual(sync[0].body, { wait: true });
    assert.deepEqual(calls.slice(0, 2), ["settings", "sync"]);
    assert.equal(calls.filter((x) => x === "settings").length, 2, "then reads the settings again for the new time");
  });

  it("leaves a fresh copy alone", async () => {
    const { c } = await open(Date.now() - 30 * 1000);
    assert.equal(requestsTo(c, "/api/connections/nuvio/sync").length, 0);
  });

  it("shows Updating while it waits", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const c = loadClient({
      signedIn: "alice",
      routes: {
        "/api/connections/nuvio/settings": () => ({ json: { ok: true, connected: true, status: "ok", username: "a@b.test", sync: { pull: true, profileIndex: 1, lastPullAt: 1 } } }),
        "/api/connections/nuvio/sync": async () => { await gate; return { json: { ok: true, done: true } }; },
      },
    });
    c.call("mediaAppUiRefresh", "nuvio");
    await new Promise((r) => setTimeout(r, 20));
    assert.match(c.document.getElementById("myNuvioListsResult").innerHTML, /Updating/);
    release();
    await new Promise((r) => setTimeout(r, 20));
  });

  it("does not ask again and again when the update could not be done", async () => {
    const calls = [];
    const c = loadClient({
      signedIn: "alice",
      routes: {
        "/api/connections/nuvio/settings": () => { calls.push("settings"); return { json: { ok: true, connected: true, status: "ok", username: "a@b.test", sync: { pull: true, profileIndex: 1, lastPullAt: 1 } } }; },
        "/api/connections/nuvio/sync": () => { calls.push("sync"); return { status: 502, json: { ok: false } }; },
      },
    });
    await c.call("mediaAppUiRefresh", "nuvio");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls.filter((x) => x === "sync").length, 1);
  });

  it("Sync now waits for the pull and forces it", async () => {
    const c = loadClient({
      signedIn: "alice",
      routes: {
        "/api/connections/nuvio/sync": () => ({ json: { ok: true, done: true, sync: { lastResult: { found: 7, unresolved: 0 } } } }),
        "/api/connections/nuvio/settings": () => ({ json: { ok: true, connected: true, status: "ok", username: "a@b.test", sync: { pull: true, profileIndex: 1, lastPullAt: Date.now(), lastResult: { found: 7, unresolved: 0 } } } }),
      },
    });
    const toasts = [];
    c.set("showToast", (m, k) => toasts.push([m, k]));
    await c.call("syncMediaAppNow", "nuvio", null);
    assert.deepEqual(requestsTo(c, "/api/connections/nuvio/sync")[0].body, { wait: true, force: true });
    assert.deepEqual(toasts, [["Nuvio is up to date. Found 7 titles.", "success"]]);
  });
});

describe("progress and time left on Continue Watching items", () => {
  it("says how long is left in hours and minutes", () => {
    const c = loadClient({ signedIn: true });
    const label = (m) => c.call("resumeProgressParts", { progress: 40, timeLeftMin: m }).label;
    assert.equal(label(24), "24m left");
    assert.equal(label(75), "1h 15m left");
    assert.equal(label(60), "1h left");
    assert.equal(label(135), "2h 15m left");
    assert.equal(label(1), "1m left");
  });

  it("draws a bar as wide as the part watched, and nothing for an item with no progress", () => {
    const c = loadClient({ signedIn: true });
    const parts = c.call("resumeProgressParts", { progress: 37, timeLeftMin: 20 });
    assert.match(parts.barHtml, /class="resume-progress"/);
    assert.match(parts.barHtml, /width:37%/);
    const none = (it) => { const p = c.call("resumeProgressParts", it); return [p.barHtml, p.label]; };
    assert.deepEqual(none({}), ["", ""]);
    assert.deepEqual(none({ progress: 0, timeLeftMin: 5 }), ["", ""], "no bar before anything is watched");
    assert.equal(c.call("resumeProgressParts", { progress: 250, timeLeftMin: 5 }).barHtml.includes("width:100%"), true, "never wider than the poster");
  });

  it("shows the bar and the time left on a card's poster strip", async () => {
    const sample = { id: "tt3333333", type: "movie", name: "Movie Half", poster: "https://img.test/p.jpg", progress: 25, timeLeftMin: 75 };
    const c = loadClient({
      signedIn: "alice",
      routes: { "/api/preview": () => ({ json: { ok: true, count: 1, sample: [sample], maybeMore: false } }) },
    });
    const slot = { dataset: { url: "autotrack:nuvio-continue-watching:mixed:alice", type: "mixed", name: "Nuvio Continue Watching" }, closest: () => null, className: "", innerHTML: "" };
    await c.call("loadPosterSlot", slot);
    assert.match(slot.innerHTML, /class="resume-progress"/);
    assert.match(slot.innerHTML, /width:25%/);
    assert.match(slot.innerHTML, /1h 15m left/);
  });

  it("shows them on a See all tile as well", () => {
    const c = loadClient({ signedIn: "alice" });
    const html = c.call("livePreviewPosterHtml", { id: "tt3333333", type: "movie", name: "Movie Half", poster: "https://img.test/p.jpg", progress: 25, timeLeftMin: 24 });
    assert.match(html, /class="resume-progress"/);
    assert.match(html, /24m left/);
    const plain = c.call("livePreviewPosterHtml", { id: "tt1", type: "movie", name: "Plain", poster: "https://img.test/p.jpg" });
    assert.ok(!/resume-progress|left</.test(plain));
  });
});

describe("removing an item from Nuvio or Stremio", () => {
  const button = (over = {}) => {
    const card = { parentNode: null, removed: false };
    const grid = { removeChild(n) { n.removed = true; }, querySelectorAll: () => [] };
    card.parentNode = grid;
    return { card, dataset: { removeType: "external", provider: "nuvio", target: "history", removeId: "tt2222222", mediaType: "series", name: "Show S", ...over }, closest: () => card };
  };

  it("puts a remove button on each tile of the app lists, and none on other lists", async () => {
    const sample = { id: "tt3333333", type: "movie", name: "Movie Half", poster: "https://img.test/p.jpg" };
    const c = loadClient({ signedIn: "alice", routes: { "/api/preview": () => ({ json: { ok: true, count: 1, sample: [sample], maybeMore: false } }) } });
    const slotFor = (url) => ({ dataset: { url, type: "mixed", name: "x" }, closest: () => null, className: "", innerHTML: "" });
    const mine = slotFor("autotrack:nuvio-continue-watching:mixed:alice");
    await c.call("loadPosterSlot", mine);
    assert.match(mine.innerHTML, /data-remove-type="external" data-provider="nuvio" data-target="continue-watching" data-remove-id="tt3333333" data-media-type="movie" data-name="Movie Half"/);
    assert.match(mine.innerHTML, /aria-label="Remove from Nuvio"/);
    const other = slotFor("autotrack:watch-history:mixed:alice");
    await c.call("loadPosterSlot", other);
    assert.ok(!/cw-remove-btn/.test(other.innerHTML), "the account's own Watch History row is not changed by this");
  });

  it("asks first, says what will go, and does not call the server until confirmed", () => {
    const c = loadClient({ signedIn: "alice", routes: {} });
    const asked = [];
    c.set("showAppConfirm", (title, msg, label, onConfirm) => asked.push({ title, msg, label }));
    c.call("removeListItemFromDetails", button());
    assert.equal(asked.length, 1);
    assert.equal(asked[0].title, "Remove from Nuvio?");
    assert.match(asked[0].msg, /"Show S" and all its watched episodes will be removed from your Watch History in Nuvio, and from Nuvio itself\./);
    assert.equal(c.requests.length, 0);
    c.call("removeListItemFromDetails", button({ target: "continue-watching", mediaType: "movie", name: "Movie Half" }));
    assert.match(asked[1].msg, /"Movie Half" will be removed from Continue Watching in Nuvio\. Your Watch History is not changed\./);
    assert.ok(!/episodes/.test(asked[1].msg), "a movie is not an episode or a show");
  });

  it("removes in the app through the server, then takes the tile away", async () => {
    const c = loadClient({ signedIn: "alice", routes: { "/api/connections/nuvio/remove": () => ({ json: { ok: true } }) } });
    const toasts = [];
    c.set("showToast", (m, k) => toasts.push([m, k]));
    c.set("showAppConfirm", (t, m, l, onConfirm) => onConfirm());
    const b = button();
    await c.call("removeListItemFromDetails", b);
    await new Promise((r) => setTimeout(r, 10));
    const sent = requestsTo(c, "/api/connections/nuvio/remove");
    assert.deepEqual(sent[0].body, { target: "history", id: "tt2222222", mediaType: "series" });
    assert.equal(b.card.removed, true);
    assert.deepEqual(toasts, [['Removed "Show S" from Nuvio.', "success"]]);
    assert.equal(requestsTo(c, "/api/external-list/item-mutate").length, 0, "not sent as a Trakt-style removal with tokens");
  });

  it("keeps the tile and says why when the app refuses", async () => {
    const c = loadClient({ signedIn: "alice", routes: { "/api/connections/stremio/remove": () => ({ status: 502, json: { ok: false, error: "That service didn't answer. Please try again in a minute.", detail: "Stremio answered 500" } }) } });
    const toasts = [];
    c.set("showToast", (m, k) => toasts.push([m, k]));
    c.set("showAppConfirm", (t, m, l, onConfirm) => onConfirm());
    const b = button({ provider: "stremio" });
    await c.call("removeListItemFromDetails", b);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(b.card.removed, false);
    assert.deepEqual(toasts, [["That service didn't answer. Please try again in a minute. (Stremio answered 500)", "error"]]);
  });

  it("forgets the cached previews of that app's lists, so the next look is fresh", async () => {
    const c = loadClient({ signedIn: "alice", routes: { "/api/connections/nuvio/remove": () => ({ json: { ok: true } }) } });
    c.set("showToast", () => {});
    c.set("showAppConfirm", (t, m, l, onConfirm) => onConfirm());
    c.window._listPreviewCache = new Map([["autotrack:nuvio-watch-history:mixed:alice|movie|12", {}], ["autotrack:stremio-watch-history:mixed:alice|movie|12", {}], ["tmdb:chart:popular|movie|12", {}]]);
    await c.call("removeListItemFromDetails", button());
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual([...c.window._listPreviewCache.keys()].sort(), ["autotrack:stremio-watch-history:mixed:alice|movie|12", "tmdb:chart:popular|movie|12"]);
  });

  it("marks the tiles of a See all page of these lists as removable from the app", async () => {
    const c = loadClient({
      signedIn: "alice",
      routes: { "/api/preview": () => ({ json: { ok: true, count: 1, sample: [{ id: "tt3333333", type: "movie", name: "Movie Half", poster: "https://img.test/p.jpg" }], maybeMore: false } }) },
    });
    const tiles = [];
    const grid = c.document.getElementById("detailGrid");
    grid.isConnected = true;
    grid.insertAdjacentHTML = (where, html) => tiles.push(html);
    c.window.requestAnimationFrame = (fn) => fn();
    c.call("openListDetailsPage", "Nuvio Continue Watching", "mixed", "autotrack:nuvio-continue-watching:mixed:alice");
    await new Promise((r) => setTimeout(r, 30));
    assert.match(tiles.join(""), /data-provider="nuvio" data-target="continue-watching"/);
    assert.match(tiles.join(""), /data-remove-id="tt3333333"/);
  });

  it("loads the complete history instead of a cached poster sample and uses the history removal target", async () => {
    const c = loadClient({ signedIn: "alice", routes: { "/api/preview": () => ({ json: { ok: true, totalItems: 2, sample: [
      { id: "tt3333333", type: "movie", name: "Movie" },
      { id: "tt4444444", type: "series", name: "Show" },
    ], maybeMore: false } }) } });
    const tiles = [];
    const grid = c.document.getElementById("detailGrid");
    grid.isConnected = true;
    grid.insertAdjacentHTML = (where, html) => tiles.push(html);
    c.window.requestAnimationFrame = (fn) => fn();
    await c.call("openListDetailsPage", "Nuvio Watch History", "mixed", "autotrack:nuvio-watch-history:mixed:alice", { sample: [{ id: "tt1111111" }], maybeMore: false });
    assert.equal(requestsTo(c, "/api/preview").length, 1);
    assert.match(tiles.join(""), /data-provider="nuvio" data-target="history"/);
    assert.equal(c.window._currentListDetailsAllItems.length, 2);
    c.window.switchListDetailsType('movie');
    assert.match(c.document.getElementById('detailSubtitle').textContent, /Movies • 1 item/);
    c.window.switchListDetailsType('series');
    assert.match(c.document.getElementById('detailSubtitle').textContent, /Shows • 1 item/);
  });

  it("keeps explicitly typed movies off the Shows tab even when metadata contains a showId", async () => {
    const c = loadClient({ signedIn: "alice", routes: { "/api/preview": () => ({ json: { ok: true, sample: [
      { id: "tt3333333", type: "movie", showId: "tt3333333", name: "Movie" },
      { id: "tt4444444", type: "series", showId: "tt4444444", name: "Show" },
    ], maybeMore: false } }) } });
    const rendered = [];
    c.set("renderPosterGridChunked", (_, items) => rendered.push(Array.from(items, (item) => item.id)));
    await c.call("openListDetailsPage", "Nuvio Watch History", "mixed", "autotrack:nuvio-watch-history:mixed:alice");
    c.window.switchListDetailsType("movie");
    c.window.switchListDetailsType("series");
    assert.deepEqual(rendered, [["tt3333333"], ["tt4444444"]]);
  });

  it("puts the same button on a See all tile", () => {
    const c = loadClient({ signedIn: "alice" });
    const html = c.call("livePreviewPosterHtml", { id: "tt2222222", type: "series", name: "Show S", poster: "https://img.test/p.jpg", removeExternalProvider: "stremio", removeExternalTarget: "continue-watching", removeExternalListId: "continue-watching" });
    assert.match(html, /data-provider="stremio" data-target="continue-watching"[^>]*data-remove-id="tt2222222"/);
    assert.match(html, /data-name="Show S"/);
  });
});

describe("app libraries", () => {
  it("offers Library alongside the app's other lists", () => {
    const c = loadClient({ signedIn: "alice" });
    c.call("renderMediaAppStatus", "nuvio", { connected: true, status: "ok", sync: { lastPullAt: Date.now() } });
    assert.match(el(c, "myNuvioListsResult").innerHTML, /Nuvio Library/);
    assert.match(el(c, "myNuvioListsResult").innerHTML, /autotrack:nuvio-library:mixed:alice/);
  });
  it("searches titles and renders numeric results as add buttons", async () => {
    const c = loadClient({ signedIn: "alice", routes: { "/api/title-search": () => ({ json: { ok: true, results: [{ tmdbId: 550, title: "Fight Club", year: "1999" }] } }) } });
    el(c, "mediaHistoryQuery").value = "Fight Club";
    el(c, "mediaHistoryKind").value = "movie";
    await c.call("searchMediaHistoryAdd");
    assert.match(el(c, "mediaHistoryResults").innerHTML, /Fight Club/);
    assert.match(el(c, "mediaHistoryResults").innerHTML, /data-act="addMediaHistoryResult"/);
  });
  it("sends a library add directly to the app", async () => {
    const c = loadClient({ signedIn: "alice", routes: { "/api/connections/nuvio/library-item": () => ({ json: { ok: true } }) } });
    c.window._mediaHistoryAddProvider = "nuvio";
    c.window._mediaAppAddTarget = "library";
    c.set("showToast", () => {});
    c.set("closeModal", () => {});
    await c.call("addMediaHistoryResult", "1396", "series", "Breaking Bad", null);
    const sent = requestsTo(c, "/api/connections/nuvio/library-item");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.action, "add");
    assert.equal(sent[0].body.id, "tmdb:1396");
  });
  it("routes a library removal to the incremental library endpoint", async () => {
    const c = loadClient({ signedIn: "alice", routes: { "/api/connections/nuvio/library-item": () => ({ json: { ok: true } }) } });
    c.set("showAppConfirm", (title, msg, text, cb) => cb());
    c.set("showToast", () => {});
    const btn = { dataset: { provider: "nuvio", target: "library", removeId: "tmdb:550", mediaType: "movie", name: "Movie" }, closest: () => null };
    c.call("removeMediaAppItem", btn);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(requestsTo(c, "/api/connections/nuvio/library-item")[0].body.action, "remove");
  });
});

describe("adding directly to app history", () => {
  it("adds the selected Nuvio movie and reports success", async () => {
    const c = loadClient({ signedIn: "alice", routes: { "/api/connections/nuvio/add-history": () => ({ json: { ok: true, mirrored: true } }) } });
    c.window._mediaHistoryAddProvider = "nuvio";
    const toasts = [];
    c.set("showToast", (message, kind) => toasts.push([message, kind]));
    c.set("closeModal", () => {});
    await c.call("addMediaHistoryResult", "550", "movie", "Fight Club", null);
    assert.deepEqual(requestsTo(c, "/api/connections/nuvio/add-history")[0].body, { id: "tmdb:550", mediaType: "movie", season: null, episode: null, title: "Fight Club" });
    assert.match(toasts[0][0], /Added.*Nuvio Watch History/);
  });
  it("requires an episode before writing a show", async () => {
    const c = loadClient({ signedIn: "alice" });
    c.window._mediaHistoryAddProvider = "nuvio";
    const toasts = [];
    c.set("showToast", (message, kind) => toasts.push([message, kind]));
    await c.call("addMediaHistoryResult", "1396", "series", "Breaking Bad", null);
    assert.equal(requestsTo(c, "/api/connections/nuvio/add-history").length, 0);
    assert.match(toasts[0][0], /season and episode/);
  });
});

describe("website Continue Watching removal", () => {
  it("only sends removals to connected apps with two-way sync enabled", async () => {
    const c = loadClient({ signedIn: "alice", routes: {
      "/api/connections/nuvio/settings": () => ({ json: { ok: true, connected: true, sync: { push: true } } }),
      "/api/connections/stremio/settings": () => ({ json: { ok: true, connected: true, sync: { push: false } } }),
      "/api/connections/nuvio/remove": () => ({ json: { ok: true } }),
    } });
    await c.call("syncWebsiteContinueWatchingRemoval", "tt3333333");
    assert.deepEqual(requestsTo(c, "/api/connections/nuvio/remove")[0].body, { target: "continue-watching", id: "tt3333333" });
    assert.equal(requestsTo(c, "/api/connections/stremio/remove").length, 0);
  });
  it("reports an app write failure", async () => {
    const c = loadClient({ signedIn: "alice", routes: {
      "/api/connections/nuvio/settings": () => ({ json: { ok: true, connected: true, sync: { push: true } } }),
      "/api/connections/nuvio/remove": () => ({ status: 502, json: { ok: false, error: "Nuvio unavailable" } }),
    } });
    const toasts = [];
    c.set("showToast", (message, kind) => toasts.push([message, kind]));
    await c.call("syncWebsiteContinueWatchingRemoval", "tt3333333");
    assert.deepEqual(toasts, [["Nuvio unavailable", "error"]]);
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
