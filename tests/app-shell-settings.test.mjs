import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadClient, requestsTo } from "./client-harness.mjs";

// The shell's Settings view (Phase 6, P6-2): the account, its devices, its
// connected accounts and its install links -- the three E2E scenarios the task
// is measured by (10: the install link and managing installs, 11: restoring an
// account, 12: connecting Trakt and the rest).
//
// These load the real shell page and drive the real functions. What they check
// is the contract with the server: which request goes out, with which body and
// cookie, and what the screen says when it comes back.

const ACCOUNT = { ok: true, account: { id: 7, username: "alice", displayName: "Alice" } };
const SIGNED_OUT = { status: 401, json: { ok: false, error: "Authentication required.", signInRequired: true } };

function panel(client, role) {
  return client.__byId.get("appShellSettingsBody-" + role).innerHTML;
}
function home(client) {
  return client.__byId.get("appShellSettingsHome").innerHTML;
}

// Renders the view, waits for every panel's request to come back, and hands the
// loaded (not loading) panel markup to the assertions.
async function openSettings(client) {
  client.call("appShellRenderSettingsHome");
  await client.call("appShellRefreshSettingsHome");
}

function routesFor(overrides) {
  return {
    "/api/me": async () => ({ json: ACCOUNT }),
    "/api/me/sessions": async () => ({
      json: {
        ok: true,
        sessions: [
          { id: "aaaa1111", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0", lastSeenAt: 1750000000000, current: true },
          { id: "bbbb2222", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1", lastSeenAt: 1740000000000, current: false },
        ],
      },
    }),
    "/api/connections": async () => ({
      json: {
        ok: true,
        connections: [
          { provider: "trakt", username: "alice", status: "ok" },
          { provider: "simkl", username: "alicetv", status: "reauth_required" },
        ],
      },
    }),
    "/api/installs": async () => ({
      json: { ok: true, installs: [{ id: 3, name: "Living room", rows: 12, lastUsedAt: 1750000000000, revokedAt: null }] },
    }),
    ...(overrides || {}),
  };
}

describe("the shell's Settings view", () => {
  it("renders four panels with no inline handlers in any of them", async () => {
    const client = loadClient({ newUi: true, signedIn: true, routes: routesFor() });
    await openSettings(client);
    const markup = home(client);
    for (const role of ["account", "devices", "connections", "installs"]) {
      assert.ok(markup.includes('id="appShellSettingsBody-' + role + '"'), role + " panel is missing");
    }
    assert.equal(/on[a-z]+=/.test(markup), false, "the new panels must not add inline handlers");
    assert.ok(panel(client, "account").includes('data-app-shell-action="account-signout"'));
    assert.ok(panel(client, "connections").includes('data-app-shell-action="connection-connect"'));
  });

  it("reads the account, its devices, its connections and its install links over the session cookie", async () => {
    const client = loadClient({ newUi: true, signedIn: true, routes: routesFor() });
    await openSettings(client);

    assert.match(panel(client, "account"), /Alice/);
    assert.match(panel(client, "account"), /@alice/);
    assert.match(panel(client, "devices"), /Chrome on Windows/);
    assert.match(panel(client, "devices"), /This device/);
    assert.match(panel(client, "devices"), /Safari on iOS/);
    assert.match(panel(client, "connections"), /Connected as @alice/);
    assert.match(panel(client, "connections"), /Reconnect as @alicetv/);
    assert.match(panel(client, "connections"), /Not connected/); // MDBList and TMDB
    assert.match(panel(client, "installs"), /Living room/);
    assert.match(panel(client, "installs"), /Revoke/);

    for (const path of ["/api/me", "/api/me/sessions", "/api/connections", "/api/installs"]) {
      const sent = requestsTo(client, path);
      assert.ok(sent.length >= 1, "no request to " + path);
      assert.equal(sent[0].credentials, "same-origin");
      assert.equal(sent[0].cache, "no-store");
    }
  });

  it("says what is unavailable instead of showing an empty card", async () => {
    const client = loadClient({
      newUi: true,
      signedIn: true,
      routes: routesFor({
        "/api/installs": async () => ({ status: 404, json: { ok: false, error: "Not found." } }),
        "/api/me/sessions": async () => ({ status: 503, json: { ok: false, error: "Sessions aren't available right now." } }),
      }),
    });
    await openSettings(client);
    assert.match(panel(client, "installs"), /not switched on for this site yet/);
    // escapeHtml turns the apostrophe into &#39; on the way in, which is right.
    assert.match(panel(client, "devices"), /Sessions aren/);
  });

  it("signed out, asks nobody and points at signing in", async () => {
    const client = loadClient({ newUi: true, routes: { "/api/me": async () => SIGNED_OUT } });
    await openSettings(client);
    assert.match(panel(client, "account"), /You are not signed in/);
    assert.match(panel(client, "account"), /Sign in or restore/);
    assert.match(panel(client, "account"), /Import a backup file/);
    assert.match(panel(client, "devices"), /Sign in to see the devices/);
    assert.match(panel(client, "connections"), /Sign in to connect Trakt/);
    assert.match(panel(client, "installs"), /Sign in to keep named install links/);
    assert.equal(requestsTo(client, "/api/me/sessions").length, 0);
    assert.equal(requestsTo(client, "/api/connections").length, 0);
    assert.equal(requestsTo(client, "/api/installs").length, 0);
  });

  it("signs out through the session cookie and forgets the account", async () => {
    let signedIn = true;
    const client = loadClient({
      newUi: true,
      signedIn: true,
      routes: {
        "/api/me": async () => (signedIn ? { json: ACCOUNT } : SIGNED_OUT),
        "/api/session": async (req) => { signedIn = false; return { json: { ok: true }, saw: req.method }; },
      },
    });
    assert.equal(await client.call("appShellSignOut"), true);
    const sent = requestsTo(client, "/api/session");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].method, "DELETE");
    assert.equal(sent[0].headers["Content-Type"], "application/json");
    assert.equal(client.get("appShellState.get('account')"), null);
    assert.match(panel(client, "account"), /You are not signed in/);
  });
});

describe("deleting an account (P6-2, E2E 11)", () => {
  it("asks first, and sends the confirmation the server requires", async () => {
    // Deleting the account ends the session, so the re-read that follows the
    // delete answers as a signed-out browser would.
    let deleted = false;
    const client = loadClient({
      newUi: true,
      signedIn: true,
      routes: routesFor({
        "/api/me": async (req) => {
          if (req.method === "DELETE") { deleted = true; return { json: { ok: true } }; }
          return deleted ? SIGNED_OUT : { json: ACCOUNT };
        },
      }),
    });
    const pending = client.call("appShellDeleteAccount");
    // The dialog is the shell's own, so it is wired from JS: this is the click.
    client.__byId.get("appShellDialogConfirm").__fire("click");
    assert.equal(await pending, true);

    const deletes = requestsTo(client, "/api/me").filter((r) => r.method === "DELETE");
    assert.equal(deletes.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(deletes[0].body)), { confirm: "DELETE" });
    assert.equal(client.get("appShellState.get('account')"), null);
  });

  it("sends nothing at all when the dialog is dismissed", async () => {
    const client = loadClient({ newUi: true, signedIn: true, routes: routesFor() });
    const pending = client.call("appShellDeleteAccount");
    client.__byId.get("appShellDialogCancel").__fire("click");
    assert.equal(await pending, false);
    assert.equal(requestsTo(client, "/api/me").filter((r) => r.method === "DELETE").length, 0);
  });
});

describe("connected accounts (P6-2, E2E 12)", () => {
  it("starts the provider's own sign-in, so one flow connects it everywhere", async () => {
    const client = loadClient({ newUi: true, signedIn: true, routes: routesFor() });
    await openSettings(client);
    assert.equal(client.call("appShellConnectProvider", "trakt"), true);
    assert.equal(client.location.href, "https://example.com/api/trakt/oauth/start");
    assert.equal(client.call("appShellConnectProvider", "nope"), false);
  });

  it("disconnecting drops it on the server and on this browser, then refreshes", async () => {
    const client = loadClient({
      newUi: true,
      signedIn: true,
      routes: routesFor({
        "/api/connections/trakt": async (req) => ({ json: { ok: true, saw: req.method } }),
      }),
    });
    await openSettings(client);
    assert.equal(await client.call("appShellDisconnectProvider", "trakt"), true);
    // The legacy disconnect is what removes the server's copy (fire and forget)
    // and clears this browser's; the panel is then re-read.
    const calls = requestsTo(client, "/api/connections/trakt");
    assert.equal(calls[0].method, "DELETE");
    assert.equal(client.localStorage.getItem("myListAddon:traktAccessToken"), null);
  });
});

describe("devices and install links", () => {
  it("signs one device out, or every other device", async () => {
    const client = loadClient({
      newUi: true,
      signedIn: true,
      routes: routesFor({ "/api/me/sessions": async (req) => (req.method === "DELETE" ? { json: { ok: true } } : { json: { ok: true, sessions: [] } }) }),
    });
    assert.equal(await client.call("appShellRevokeSession", "bbbb2222"), true);
    const deletes = requestsTo(client, "/api/me/sessions").filter((r) => r.method === "DELETE");
    assert.deepEqual(JSON.parse(JSON.stringify(deletes[0].body)), { id: "bbbb2222" });

    assert.equal(await client.call("appShellRevokeOtherSessions"), true);
    const all = requestsTo(client, "/api/me/sessions").filter((r) => r.method === "DELETE");
    assert.deepEqual(JSON.parse(JSON.stringify(all[all.length - 1].body)), { allExceptCurrent: true });
  });

  it("revokes an install link only after the dialog is answered", async () => {
    const client = loadClient({
      newUi: true,
      signedIn: true,
      routes: routesFor({ "/api/installs/3": async (req) => ({ json: { ok: true, saw: req.method } }) }),
    });
    const pending = client.call("appShellRevokeInstall", "3");
    client.__byId.get("appShellDialogConfirm").__fire("click");
    assert.equal(await pending, true);
    const sent = requestsTo(client, "/api/installs/3");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].method, "DELETE");
  });

  it("offers the link in Stremio, in Nuvio and for other apps once one exists", async () => {
    const client = loadClient({
      newUi: true,
      signedIn: true,
      routes: routesFor(),
      storage: { "myListAddon:installLink": JSON.stringify({ url: "https://example.com/abc/manifest.json", hash: "x" }) },
    });
    await openSettings(client);
    const markup = panel(client, "installs");
    assert.ok(markup.includes('href="stremio://example.com/abc/manifest.json"'));
    assert.ok(markup.includes('href="nuvio://example.com/abc/manifest.json"'));
    assert.match(markup, /Other apps/);
    assert.ok(markup.includes("https://example.com/abc/manifest.json"));
  });

  it("offers to make one when this browser has none", async () => {
    const client = loadClient({ newUi: true, signedIn: true, routes: routesFor() });
    await openSettings(client);
    assert.match(panel(client, "installs"), /Nothing is installed from this browser yet/);
    assert.ok(panel(client, "installs").includes('data-app-shell-action="install-get"'));
  });
});
