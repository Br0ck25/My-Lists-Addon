// P6-8: no data or credential in localStorage, no blocking dialog.
//
// Two of P6-8's three parts. The third -- the inline handlers -- is in
// client-actions.test.mjs.
//
// FE-3 counted "about 80 keys including credentials" in this browser's
// storage, and SECURITY_AUDIT S-05 is the one that matters: a Trakt, MDBList,
// Simkl or TMDB key/token is a bearer credential for somebody's watch
// history, and localStorage is readable by any script on the page (which, on
// a page with ~470 inline handlers behind 'unsafe-inline', was the same
// problem twice). Those eight keys now live in memory for the tab; the
// account already holds them (every config push sends them up, every load
// hands them back), and the old copy is dropped once the account has
// confirmed it has the same value.
//
// alert()/confirm()/prompt() are the other half: a blocking OS dialog on top
// of a styled app, unreadable by everything else running on the page. The
// client has showToast and showAppConfirm/appShellDialog for those.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadClient } from "./client-harness.mjs";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 03_admin.js is the /admin page, P6-10's job. Every other split file is
// either the client bundle (09_..24_) or the Worker.
function clientSources() {
  return fs.readdirSync(REPO_ROOT)
    .filter((f) => /^(0[9]|1[0-9]|2[0-4])_/.test(f))
    .map((f) => ({ file: f, text: fs.readFileSync(path.join(REPO_ROOT, f), "utf8") }));
}

function codeLines(text) {
  return text.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
}

// The eight keys that belong to the account, not this browser.
const SECRET_KEYS = [
  "myListAddon:tmdbKey", "myListAddon:tmdbSessionId",
  "myListAddon:mdblistKey", "myListAddon:mdblistAccessToken",
  "myListAddon:traktKey", "myListAddon:traktAccessToken",
  "myListAddon:simklKey", "myListAddon:simklAccessToken",
];

describe("P6-8: the browser stops keeping provider credentials", () => {
  // Every localStorage write in the client sources, with a constant name
  // resolved to its value (`localStorage.setItem(PRESETS_KEY, ...)`).
  function storageWrites() {
    const writes = [];
    for (const { file, text } of clientSources()) {
      const constants = new Map();
      for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*'([^']*myListAddon:[^']+)'/g)) {
        constants.set(m[1], m[2]);
      }
      for (const m of text.matchAll(/localStorage\.(setItem|removeItem)\(\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))/g)) {
        const key = m[2] || m[3] || constants.get(m[4]) || "";
        if (key.startsWith("myListAddon:")) writes.push({ file, key, call: m[1] });
      }
    }
    return writes;
  }

  it("no client source writes a provider credential to storage", () => {
    const writes = storageWrites();
    assert.ok(writes.length > 40, `expected the client's own storage writes, found ${writes.length}`);
    const leaked = writes.filter((w) => SECRET_KEYS.includes(w.key));
    assert.deepEqual(leaked, [], "a credential was written to localStorage again");
  });

  it("knows exactly which keys are credentials", () => {
    const client = loadClient();
    const listed = [...client.get("PROVIDER_SECRET_KEYS")].sort();
    assert.deepEqual(listed, [...SECRET_KEYS].sort(),
      "16_'s list is what rememberProviderSecret/forgetProviderSecret/readProviderSecret gate on");
    // The keys it must not swallow: this browser's own sign-in, and the
    // per-provider flags and usernames a signed-out browser still needs.
    for (const key of ["myListAddon:creatorKey", "myListAddon:traktUsername", "myListAddon:traktDisconnected"]) {
      assert.equal(listed.includes(key), false, `${key} is not a credential`);
    }
  });

  it("keeps a credential for the tab and never for the next visit", () => {
    const client = loadClient();
    client.call("rememberProviderSecret", "myListAddon:mdblistKey", "MDB-1");
    assert.equal(client.localStorage.getItem("myListAddon:mdblistKey"), null, "not written");
    assert.equal(client.call("readProviderSecret", "myListAddon:mdblistKey"), "MDB-1", "but this tab knows it");
    // A function that is not about a credential is left alone, so the helper
    // cannot accidentally become a general-purpose key writer.
    assert.equal(client.call("rememberProviderSecret", "myListAddon:region", "US"), false);
    assert.equal(client.localStorage.getItem("myListAddon:region"), null);
  });

  it("still reads the copy a browser wrote before P6-8", () => {
    const client = loadClient({ storage: { "myListAddon:traktAccessToken": "OLD-TOKEN" } });
    assert.equal(client.call("readProviderSecret", "myListAddon:traktAccessToken"), "OLD-TOKEN",
      "a signed-in-since-before browser keeps working");
    assert.equal(client.call("readProviderSecret", "myListAddon:mdblistKey"), "", "and answers empty, not null");
  });

  it("drops the stale copy once, when the account hands the same value back", async () => {
    const client = loadClient({
      signedIn: true,
      storage: { "myListAddon:traktKey": "TRK", "myListAddon:tmdbKey": "TMDB" },
      routes: {
        // Shape is { ok, data: { keys, ... } } -- see loadCreatorSync (22_).
        "/api/creator/sync/load": () => ({
          json: {
            ok: true,
            data: {
              updatedAt: 1,
              keys: { traktKey: "TRK", tmdbKey: "TMDB" },
              config: [], hiddenLists: [], hiddenMyListsSections: [], likedLists: [],
            },
          },
        }),
      },
    });
    await client.call("loadCreatorSync");
    assert.equal(client.localStorage.getItem("myListAddon:traktKey"), null, "the browser's copy is redundant");
    assert.equal(client.localStorage.getItem("myListAddon:tmdbKey"), null);
    assert.equal(client.call("readProviderSecret", "myListAddon:traktKey"), "TRK", "this tab kept the value");
    assert.equal(client.call("readProviderSecret", "myListAddon:tmdbKey"), "TMDB");
  });

  it("forgets both copies when the account says it is disconnected", () => {
    const client = loadClient({ storage: { "myListAddon:simklAccessToken": "OLD" } });
    client.call("rememberProviderSecret", "myListAddon:simklAccessToken", "NEW");
    client.call("forgetProviderSecret", "myListAddon:simklAccessToken");
    assert.equal(client.localStorage.getItem("myListAddon:simklAccessToken"), null);
    assert.equal(client.call("readProviderSecret", "myListAddon:simklAccessToken"), "", "memory is cleared too");
  });
});

describe("P6-8: no blocking dialogs in the client", () => {
  it("has no alert(), confirm() or prompt() call left", () => {
    for (const { file, text } of clientSources()) {
      for (const line of codeLines(text)) {
        // A comment quoting a payload (`javascript:alert(1)`) is not a call.
        const code = line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
        assert.equal(/(^|[^.\w$])(alert|confirm|prompt)\s*\(/.test(code), false,
          `${file} still calls a blocking dialog: ${line.trim().slice(0, 90)}`);
      }
    }
  });

  it("keeps the window.alert shim as a net for anything this page cannot see", () => {
    const client = loadClient();
    assert.equal(typeof client.alert, "function", "still defined");
    // It must not be the browser's dialog: it is the toast.
    client.call("alert", "Careful");
    assert.ok(client.get("window.alert").toString().includes("showToast") ||
      String(client.get("window.alert")).includes("showToast"));
  });
});
