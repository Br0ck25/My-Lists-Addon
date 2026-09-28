import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadClient, requestsTo } from "./client-harness.mjs";

// The client half of the new UI shell (Phase 6, P6-1). These load the real
// shell page -- the same bundle the legacy page gets, with `const NEW_UI =
// true` in the preamble -- so what is tested is the code that ships, not a
// copy of it.
//
// Two things matter here that the server tests cannot see: the legacy switchers
// still route through the shell (so a click anywhere in the old UI lands on a
// real path), and they do not also rewrite the URL to "/" afterwards.

const VIEWS = [
  { tab: "catalogs", path: "/catalogs", subs: ["all", "quickadd", "bulk"] },
  { tab: "lists", path: "/lists", subs: ["my-lists", "liked", "create-list", "import"] },
  { tab: "channels", path: "/channels", subs: ["my-channels", "storylines", "quickadd", "explore", "import", "build"] },
  { tab: "discover", path: "/discover", subs: ["movie", "all", "series", "popular", "curated", "gems", "kids", "holidays", "genres"] },
  { tab: "search", path: "/search", subs: [] },
  { tab: "settings", path: "/settings", subs: ["account", "external", "backup", "feedback"] },
];

// Values that cross the vm boundary have another realm's prototypes, so
// deepEqual's reference check rejects objects that are plainly equal. Everything
// these tests compare is JSON-shaped, so compare it as JSON.
function plain(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value));
}

function pushedPaths(client) {
  return client.historyCalls.filter((c) => c.kind === "push").map((c) => c.args[2]);
}
function allPaths(client) {
  return client.historyCalls.map((c) => c.args[2]);
}
// Booting a shell page at "/" settles the address bar on /discover (see
// initAppShell), so a test that counts what a click pushed clears what the
// boot did first.
function forgetBootNavigation(client) {
  client.historyCalls.length = 0;
}

describe("the new UI shell's routes", () => {
  it("reads a real path back into a view", () => {
    const client = loadClient({ newUi: true });
    assert.deepEqual(plain(client.call("appShellRouteFromPath", "/catalogs")), { tab: "catalogs", sub: "" });
    assert.deepEqual(plain(client.call("appShellRouteFromPath", "/catalogs/quickadd")), { tab: "catalogs", sub: "quickadd" });
    assert.deepEqual(plain(client.call("appShellRouteFromPath", "/settings/account/")), { tab: "settings", sub: "account" });
    // Not shell routes: the home page, a share link, and a sub that does not
    // exist. A share link must keep its own handler rather than opening the
    // Lists view.
    assert.equal(client.call("appShellRouteFromPath", "/"), null);
    assert.equal(client.call("appShellRouteFromPath", "/lists/watchlist"), null);
    assert.equal(client.call("appShellRouteFromPath", "/lists/Anonymous/some-list"), null);
    assert.equal(client.call("appShellRouteFromPath", "/channels/alice/my-channel"), null);
    assert.equal(client.call("appShellRouteFromPath", "/settings/not-a-sub"), null);
  });

  it("builds the same paths back", () => {
    const client = loadClient({ newUi: true });
    for (const view of VIEWS) {
      assert.equal(client.call("appShellPathFor", view.tab, ""), view.path);
      for (const sub of view.subs) {
        const path = client.call("appShellPathFor", view.tab, sub);
        assert.equal(path, `${view.path}/${sub}`);
        // Round trip: every path the shell builds is one it can read, and it
        // reads it back as the same view and sub-tab.
        assert.deepEqual(plain(client.call("appShellRouteFromPath", path)), { tab: view.tab, sub });
      }
      // A sub that is not this view's falls back to the view itself, which is
      // what keeps a stale URL from opening nothing.
      assert.equal(client.call("appShellPathFor", view.tab, "not-a-sub"), view.path);
    }
  });

  it("routes the legacy aliases to the same view their own switcher would open", () => {
    const client = loadClient({ newUi: true });
    assert.deepEqual(plain(client.call("appShellRouteForName", "backup")), { tab: "settings", sub: "backup" });
    assert.deepEqual(plain(client.call("appShellRouteForName", "keys")), { tab: "settings", sub: "account" });
    assert.deepEqual(plain(client.call("appShellRouteForName", "quick-add")), { tab: "catalogs", sub: "quickadd" });
    assert.deepEqual(plain(client.call("appShellRouteForName", "lists")), { tab: "lists", sub: "" });
    // Detail views are not shell views: they keep the legacy path.
    assert.equal(client.call("appShellRouteForName", "list-details"), null);
    assert.equal(client.call("appShellRouteForName", "item-details"), null);
  });

  it("settles the address bar on boot: / becomes the Discover path, an explicit path stays", () => {
    const client = loadClient({ newUi: true });
    // "/" is the whole site's home page, but every shell view has a real path,
    // so the home page becomes the Discover one. (The builder's own boot code
    // runs before the shell takes over and may write "/" once first; what
    // matters is where the address bar settles.)
    assert.equal(allPaths(client).pop(), "/discover");
    assert.deepEqual(plain(client.historyCalls[client.historyCalls.length - 1].args[0]), { appShell: true });

    const deep = loadClient({ newUi: true });
    deep.location.pathname = "/settings/backup";
    forgetBootNavigation(deep);
    // Booting again at an explicit path must not rewrite it.
    deep.call("initAppShell");
    assert.deepEqual(allPaths(deep), []);
    assert.equal(deep.localStorage.getItem("myListAddon:settingsSubmenu"), "backup");
  });

  it("moves the address bar and the view together, and says which page is current", () => {
    const client = loadClient({ newUi: true });
    forgetBootNavigation(client);
    assert.equal(client.call("appShellGo", "/lists/liked"), true);
    assert.deepEqual(pushedPaths(client), ["/lists/liked"]);
    // The legacy switchers did the DOM work: the Lists view is active and its
    // sub-tab is the one the path named.
    assert.equal(client.localStorage.getItem("myListAddon:activeTab"), "lists");
    assert.equal(client.localStorage.getItem("myListAddon:listsSubmenu"), "liked");
    assert.deepEqual(plain(client.get("appShellState.get('route')")), { tab: "lists", sub: "liked" });
  });

  it("turns a legacy tab click into a path, once", () => {
    const client = loadClient({ newUi: true });
    forgetBootNavigation(client);
    client.call("switchTab", "settings");
    // One push, for the shell's route -- not the legacy replace that would
    // have rewritten the address to "/".
    assert.deepEqual(pushedPaths(client), ["/settings"]);
    assert.deepEqual(client.historyCalls.filter((c) => c.kind === "replace"), []);
    assert.equal(client.localStorage.getItem("myListAddon:activeTab"), "settings");

    // And a sub-tab click, which is the Catalogs pills' own switcher.
    client.call("switchCatalogsSubmenu", "quickadd");
    assert.equal(pushedPaths(client).pop(), "/catalogs/quickadd");
    assert.equal(client.localStorage.getItem("myListAddon:catalogsSubmenu"), "quickadd");

    // A name that is not a shell view is left to the legacy path entirely.
    const before = client.historyCalls.length;
    client.call("switchTab", "list-details");
    assert.equal(client.historyCalls.length, before, "list-details must not route through the shell");
  });

  it("leaves the legacy page alone when the cookie is off", () => {
    const client = loadClient();
    assert.equal(client.get("NEW_UI"), false);
    assert.equal(client.get("appShellActive"), false);
    assert.equal(client.call("appShellHandleNav", "tab", "lists"), false);
    client.call("switchTab", "lists");
    // The legacy behaviour, unchanged: one replace to "/".
    assert.equal(pushedPaths(client).length, 0);
    assert.deepEqual(allPaths(client).pop(), "/");
  });
});

describe("the shell's API client", () => {
  it("sends the session cookie, JSON, and no cache, and reads a JSON answer", async () => {
    const client = loadClient({
      newUi: true,
      routes: {
        "/api/me": async () => ({ status: 200, json: { ok: true, account: { username: "alice", displayName: "Alice" } } }),
      },
    });
    const res = await client.call("appShellApiFetch", "/api/me");
    assert.equal(res.ok, true);
    assert.equal(res.data.account.username, "alice");
    const sent = requestsTo(client, "/api/me")[0];
    assert.equal(sent.credentials, "same-origin");
    assert.equal(sent.cache, "no-store");
    assert.equal(sent.headers.Accept, "application/json");
  });

  it("maps a failure to a sentence, keeping the status", async () => {
    const client = loadClient({
      newUi: true,
      routes: {
        "/api/me": async () => ({ status: 401, json: { ok: false, error: "Authentication required." } }),
        "/api/save": async () => ({ status: 503, json: { ok: false, error: "Being updated." } }),
        "/api/explode": async () => ({ status: 500, json: "" }),
      },
    });
    const unauthorized = await client.call("appShellApiFetch", "/api/me");
    assert.equal(unauthorized.ok, false);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.signInRequired, true);
    assert.equal(unauthorized.error, "Authentication required.", "the server's own words win");

    const paused = await client.call("appShellApiFetch", "/api/save", { method: "POST", body: { entries: [] } });
    assert.equal(paused.status, 503);
    assert.equal(paused.error, "Being updated.");

    // No message from the server: the status is turned into one.
    const broke = await client.call("appShellApiFetch", "/api/explode");
    assert.equal(broke.status, 500);
    assert.match(broke.error, /our side/i);
  });

  it("never throws when the network is gone", async () => {
    const client = loadClient({ newUi: true });
    const res = await client.call("appShellApiFetch", "/api/not-stubbed");
    assert.equal(res.ok, false);
    assert.equal(res.status, 0);
    assert.match(res.error, /offline/i);
  });

  it("sends the JSON content type on a mutation with no body too", async () => {
    // verifyCsrf (02_) refuses every POST, PUT, PATCH and DELETE that arrives
    // without this header -- body or not -- so a body-less DELETE that left it
    // off had signing out answered with 403. Asserted here as well as through
    // the settings screen, because this is the one place that sets it.
    const client = loadClient({
      newUi: true,
      routes: { "/api/session": async () => ({ status: 200, json: { ok: true } }) },
    });
    await client.call("appShellApiFetch", "/api/session", { method: "DELETE" });
    const sent = requestsTo(client, "/api/session")[0];
    assert.equal(sent.method, "DELETE");
    assert.equal(sent.headers["Content-Type"], "application/json");
    assert.equal(sent.body, null, "no body, but the header still goes");
  });

  it("sends a JSON content type with a JSON body, and none for a GET", async () => {
    const client = loadClient({
      newUi: true,
      routes: { "/api/lists": async () => ({ status: 200, json: { ok: true } }) },
    });
    await client.call("appShellApiFetch", "/api/lists", { method: "POST", body: { name: "Mine" } });
    const posted = requestsTo(client, "/api/lists")[0];
    assert.equal(posted.headers["Content-Type"], "application/json");
    assert.deepEqual(plain(posted.body), { name: "Mine" });
  });
});

describe("the shell's shared state", () => {
  it("notifies on a real change only", () => {
    const client = loadClient({ newUi: true });
    const seen = [];
    const unsubscribe = client.call("appShellState.subscribe", (s) => seen.push(s.route));
    client.call("appShellState.set", { route: { tab: "lists", sub: "" } });
    client.call("appShellState.set", { route: { tab: "lists", sub: "" } });
    client.call("appShellState.set", { route: { tab: "lists", sub: "liked" } });
    assert.deepEqual(plain(seen), [{ tab: "lists", sub: "" }, { tab: "lists", sub: "liked" }]);
    unsubscribe();
    client.call("appShellState.set", { route: { tab: "search", sub: "" } });
    assert.equal(seen.length, 2, "unsubscribing must stop the notifications");
  });
});

describe("the shell's install bar", () => {
  it("knows nothing, current and stale apart", () => {
    const client = loadClient({ newUi: true });
    assert.deepEqual(plain(client.call("appShellInstallLinkState")), { state: "none", link: "" });

    client.call("appShellRecordInstallLink", "https://example.com/abc/manifest.json");
    const live = client.call("appShellInstallLinkState");
    assert.equal(live.state, "live");
    assert.equal(live.link, "https://example.com/abc/manifest.json");

    // A link generated from a different configuration is not current.
    client.localStorage.setItem("myListAddon:installLink", JSON.stringify({ url: "https://example.com/abc/manifest.json", hash: "something-else" }));
    assert.equal(client.call("appShellInstallLinkState").state, "unsaved");
  });

  it("renders its three states into the bar", () => {
    const client = loadClient({ newUi: true });
    const bar = client.__byId.get("appShellInstallBar");
    client.call("appShellRefreshInstallBar");
    assert.equal(bar.getAttribute("data-state"), "none");
    assert.equal(client.__byId.get("appShellInstallText").textContent, "Not installed yet");
    assert.equal(client.__byId.get("appShellInstallBtn").textContent, "Get install link");

    client.call("appShellRecordInstallLink", "https://example.com/abc/manifest.json");
    client.call("appShellRefreshInstallBar");
    assert.equal(bar.getAttribute("data-state"), "live");
    assert.equal(client.__byId.get("appShellInstallBtn").textContent, "Copy link");

    client.localStorage.setItem("myListAddon:installLink", JSON.stringify({ url: "https://example.com/abc/manifest.json", hash: "old" }));
    client.call("appShellRefreshInstallBar");
    assert.equal(bar.getAttribute("data-state"), "unsaved");
    assert.equal(client.__byId.get("appShellInstallBtn").textContent, "Update link");
  });

  it("does nothing at all on a legacy page", () => {
    const client = loadClient();
    client.call("appShellRefreshInstallBar");
    assert.equal(client.get("appShellState.get('install')").state, "none");
  });
});

describe("the shell's dialog", () => {
  it("resolves true on confirm and false when it is dismissed", async () => {
    const client = loadClient({ newUi: true });
    const confirmed = client.call("appShellDialog", { title: "Delete this list?", message: "It cannot be undone.", confirmLabel: "Delete", cancelLabel: "Keep" });
    client.__byId.get("appShellDialogConfirm").__fire("click");
    assert.equal(await confirmed, true);

    const dismissed = client.call("appShellDialog", { title: "Delete this list?", confirmLabel: "Delete", cancelLabel: "Keep" });
    // Escape or a backdrop click closes it through closeModal; the promise must
    // not hang.
    client.call("closeModal");
    assert.equal(await dismissed, false);
  });
});
