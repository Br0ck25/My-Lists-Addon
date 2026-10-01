import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { call, makeEnv } from "./harness.mjs";

// The new UI shell (Phase 6, P6-1). It is opt-in per BROWSER through the
// FF_NEW_UI cookie, so the two things worth testing are the switch itself --
// nothing changes without the cookie -- and the invariant the whole single-file
// design rests on: the shell is a different PAGE, but the same bundle and the
// same stylesheet. If a shell-only line ever lands inside those two, every
// visitor's cached copy starts depending on a cookie.
const SHELL_COOKIE = "FF_NEW_UI=1";

// APP_SHELL_TABS (00_constants.js), as the routes rather than the ids: this is
// what the server must answer and what the nav must link to.
const VIEWS = [
  { path: "/catalogs", subs: ["all", "quickadd", "bulk"] },
  { path: "/lists", subs: ["my-lists", "liked", "create-list", "import"] },
  { path: "/channels", subs: ["my-channels", "storylines", "quickadd", "explore", "import", "build"] },
  { path: "/discover", subs: ["movie", "all", "series", "popular", "curated", "gems", "kids", "holidays", "genres"] },
  { path: "/search", subs: [] },
  { path: "/settings", subs: ["account", "external", "backup", "feedback"] },
];

// A served page names the shared bundle and stylesheet by content hash
// (?v=<first 20 hex of the SHA-256>), so equal hashes mean equal bytes.
function assetVersions(html) {
  const js = (html.match(/<script src="\/app\.js\?v=([0-9a-f]+)"/) || [])[1] || "";
  const css = (html.match(/<link rel="stylesheet" href="\/app\.css\?v=([0-9a-f]+)"/) || [])[1] || "";
  return { js, css };
}

describe("the new UI shell is opt-in through a cookie", () => {
  it("serves the legacy page, byte for byte, to a browser without the cookie", async () => {
    const env = makeEnv();
    const legacy = await call(env, "/");
    assert.equal(legacy.status, 200);
    assert.equal(legacy.text.includes('<html lang="en" data-app-shell="1">'), false, "no shell marker without the cookie");
    assert.equal(legacy.text.includes('id="appShellInstallBar"'), false, "no install bar without the cookie");
    assert.equal(legacy.text.includes("const NEW_UI = true;"), false, "the preamble should say NEW_UI is off");
    assert.ok(legacy.text.includes("const NEW_UI = false;"), "the preamble should say NEW_UI is off");
    // No shell Settings cards, and the install-link import the new UI drops is
    // still where it always was on the legacy page.
    assert.equal(legacy.text.includes('id="appShellSettingsHome"'), false);
    assert.ok(legacy.text.includes('id="importLinkInput"'), "the legacy page keeps its install-link import for now");
    // The legacy nav is still buttons, wired through the delegated actions
    // (P6-8) rather than a link.
    assert.ok(legacy.text.includes(`data-act="switchTab" data-act-args="[&quot;catalogs&quot;]"`),
      "the legacy tabs should be delegated actions");
  });

  it("serves the shell -- real nav links, NEW_UI on -- to a browser with it", async () => {
    const env = makeEnv();
    const shell = await call(env, "/", { cookie: SHELL_COOKIE });
    assert.equal(shell.status, 200);
    assert.ok(shell.text.includes('<html lang="en" data-app-shell="1">'), "the shell marker");
    // The install bar across the top was taken out at the owner's request;
    // Catalogs' Generate Install Link and Settings' Install links card remain.
    assert.equal(shell.text.includes('id="appShellInstallBar"'), false, "the install bar is back");
    assert.ok(shell.text.includes('data-act="generate"'), "Catalogs keeps its install link button");
    assert.ok(shell.text.includes("const NEW_UI = true;"), "the preamble turns the shell on");
    // Every view is a real link, in both navs (desktop bar and mobile bar).
    for (const view of VIEWS) {
      const links = shell.text.split(`<a class="tab-btn`).length - 1;
      assert.ok(links >= 1, "the desktop nav should be links");
      assert.ok(shell.text.includes(`href="${view.path}"`), `${view.path} should be linked`);
    }
    assert.equal((shell.text.match(/<a class="tab-btn[^>]*href="\/catalogs"/g) || []).length, 1);
    assert.equal((shell.text.match(/<a class="bottom-nav-item[^>]*href="\/catalogs"/g) || []).length, 1);
    // The shell's Settings view (P6-2) has its own container, and importing
    // from an install link -- an install id is a bearer credential that hands
    // back connected accounts (SECURITY_AUDIT.md S-02) -- is not offered there.
    assert.ok(shell.text.includes('id="appShellSettingsHome"'), "the shell's Settings cards have a home");
    assert.equal(shell.text.includes('id="importLinkInput"'), false, "no install-link import in the new UI");

    // A shell nav does not need the delegated actions at all.
    assert.equal(shell.text.includes(`data-act="switchTab" data-act-args="[&quot;catalogs&quot;]"`), false,
      "the shell nav is links, not delegated tab buttons");
    // The head script (which runs before the body exists) gets the same routes.
    assert.ok(shell.text.includes("var APP_SHELL_HEAD_ROUTES ="), "the head script needs the route table");
    for (const view of VIEWS) {
      assert.ok(shell.text.includes(`"${view.path}":{"tab"`), `${view.path} should be in the head route table`);
      for (const sub of view.subs) {
        assert.ok(shell.text.includes(`"${view.path}/${sub}":{"tab"`), `${view.path}/${sub} should be in the head route table`);
      }
    }
  });

  it("answers the shell's paths only for a browser with the cookie", async () => {
    const env = makeEnv();
    for (const view of VIEWS) {
      const without = await call(env, view.path);
      assert.equal(without.status, 404, `${view.path} must stay 404 without the cookie`);
      const with_ = await call(env, view.path, { cookie: SHELL_COOKIE });
      assert.equal(with_.status, 200, `${view.path} should be served with the cookie`);
      assert.ok(with_.text.includes('<html lang="en" data-app-shell="1">'), `${view.path} should be the shell`);
      for (const sub of view.subs) {
        const subPage = await call(env, `${view.path}/${sub}`, { cookie: SHELL_COOKIE });
        assert.equal(subPage.status, 200, `${view.path}/${sub} should be served`);
      }
      // A sub-tab that does not exist must not open some other panel. For
      // /lists and /channels the check cannot be a 404: those subtrees are
      // already catch-alls for share links (/lists/<slug> resolves a chart,
      // /channels/<user>/<slug> a channel), so the page is served either way --
      // and the shell's router then falls back to the view itself rather than
      // routing an unknown sub. The other four have no such subtree.
      const bogus = await call(env, `${view.path}/not-a-sub`, { cookie: SHELL_COOKIE });
      if (view.path === "/lists" || view.path === "/channels") {
        assert.equal(bogus.status, 200, `${view.path}/not-a-sub keeps its own catch-all route`);
      } else {
        assert.equal(bogus.status, 404, `${view.path}/not-a-sub must not invent a view`);
      }
    }
  });

  it("keeps the share links on their own routes, shell or not", async () => {
    const env = makeEnv();
    // /lists/<slug> is a deep link that opens the list, not the Lists view.
    for (const cookie of [undefined, SHELL_COOKIE]) {
      const res = await call(env, "/lists/watchlist", cookie ? { cookie } : {});
      assert.equal(res.status, 200, "/lists/watchlist should keep resolving");
      assert.ok(res.text.includes("SERVER_DEEP_LINK_LIST") || res.text.includes("const SERVER_DEEP_LINK_LIST"), "the page should still carry its deep-link payload");
    }
  });

  it("switches the cookie with ?ff_new_ui=1 / ?ff_new_ui=0, and drops the parameter", async () => {
    const env = makeEnv();
    const on = await call(env, "/?ff_new_ui=1");
    assert.equal(on.status, 302);
    assert.equal(on.headers.get("location"), "/");
    assert.match(on.headers.get("set-cookie") || "", /^FF_NEW_UI=1;/);
    assert.match(on.headers.get("set-cookie") || "", /Max-Age=\d+/);

    const off = await call(env, "/settings?ff_new_ui=0");
    assert.equal(off.status, 302);
    assert.equal(off.headers.get("location"), "/settings");
    // Remembered as 0, not cleared: with FF_NEW_UI on for the site, a browser
    // with no cookie gets the new interface.
    assert.match(off.headers.get("set-cookie") || "", /^FF_NEW_UI=0;/);
    assert.match(off.headers.get("set-cookie") || "", /Max-Age=31536000/);

    // Any value other than 0/off/false is "on", so a link can carry it plainly.
    const onAlias = await call(env, "/?ff_new_ui=on");
    assert.match(onAlias.headers.get("set-cookie") || "", /^FF_NEW_UI=1;/);
  });

  it("never redirects off the site, whatever the path looks like", async () => {
    // //evil.com/ is a protocol-relative address: sent back as a Location, a
    // browser follows it to evil.com. /\evil.com parses to the same path.
    const env = makeEnv();
    for (const path of ["//evil.com/?ff_new_ui=1", "///evil.com/x?ff_new_ui=0", "/\\evil.com?ff_new_ui=1"]) {
      const res = await call(env, path);
      assert.equal(res.status, 302, path);
      const location = res.headers.get("location") || "";
      assert.ok(location.startsWith("/") && !location.startsWith("//"), `${path} -> ${location}`);
      assert.ok(location.includes("evil.com"), "the path itself is kept, as a path on this site");
    }
  });

  it("puts the duplicate toggle below the rows and pre-fills a first visit (P6-3)", async () => {
    const env = makeEnv();
    const legacy = await call(env, "/");
    const shell = await call(env, "/", { cookie: SHELL_COOKIE });
    // The editor's container exists only on a shell page, and the Settings copy
    // of the duplicate toggle (which the editor now owns) is hidden there
    // rather than removed, so the legacy page keeps working.
    assert.equal(legacy.text.includes('id="appShellHomeEditor"'), false);
    assert.ok(shell.text.includes('id="appShellHomeEditor"'));
    assert.ok(legacy.text.includes('id="legacyDedupePanel"'));
    assert.ok(shell.text.includes('id="legacyDedupePanel"'));
    // Below the rows it applies to, right above the Daily Randomizer.
    const rowsAt = shell.text.indexOf('<div id="lists"></div>');
    const editorAt = shell.text.indexOf('id="appShellHomeEditor"');
    const randomizerAt = shell.text.indexOf("<span>Daily Randomizer</span>");
    assert.ok(rowsAt > 0 && rowsAt < editorAt && editorAt < randomizerAt, "the toggle should sit between the rows and the Daily Randomizer");
    // The CSS that hides it is in the shared stylesheet (/app.css is lifted
    // out of the page -- 25_api-catalog-routes.js), not inline in the HTML.
    const css = await call(env, "/app.css");
    assert.ok(css.text.includes('#legacyDedupePanel { display: none; }'));
    // A first-time visitor is given the demo rows on either page: the shell's
    // starter-pack button went with the paste box it sat in.
    const demo = JSON.parse((legacy.text.match(/const serverEntries = \(?(\[[\s\S]*?\])\)?;/) || [])[1]);
    assert.equal(demo.length, 8, "the old page still pre-fills its demo rows");
    const shellEntries = JSON.parse((shell.text.match(/const serverEntries = \(?(\[[\s\S]*?\])\)?;/) || [])[1]);
    assert.equal(JSON.stringify(shellEntries), JSON.stringify(demo), "the shell pre-fills the same eight rows");
    assert.equal(shell.text.includes("APP_SHELL_STARTER_PACK"), false);
  });

  it("no longer has a Your lists section; the add-titles search keeps its home (P6-4)", async () => {
    const env = makeEnv();
    const legacy = await call(env, "/");
    assert.equal(legacy.text.includes('id="appShellListsHome"'), false);
    assert.equal(legacy.text.includes('id="appShellAddTitles"'), false);
    // The shell's own Lists view is a cookie-only path (as every shell path is).
    assert.equal((await call(env, "/lists")).status, 404);
    const shell = await call(env, "/lists", { cookie: SHELL_COOKIE });
    assert.equal(shell.status, 200);
    assert.equal(shell.text.includes('id="appShellListsHome"'), false, "Your lists was taken out at the owner's request");
    assert.ok(shell.text.includes('id="appShellAddTitles"'), "the inline search needs a home");
  });

  it("moves Explore's source and sort chips from Discover to Search -> Lists (P6-5)", async () => {
    const env = makeEnv();
    const legacy = await call(env, "/");
    assert.equal(legacy.text.includes('id="appShellExplore"'), false);
    assert.equal(legacy.text.includes('id="catalogListSearchChips"'), false, "the old page's Search is unchanged");
    const shell = await call(env, "/discover", { cookie: SHELL_COOKIE });
    assert.equal(shell.status, 200);
    assert.equal(shell.text.includes('id="appShellExplore"'), false, "Explore was taken off Discover");
    assert.ok(shell.text.includes('id="catalogListSearchChips"'), "Search -> Lists carries the chips");
    for (const label of ["All sources", "My Lists community", "MDBList", "Trakt", "TMDB", "Most liked", "Newest", "Most added"]) {
      assert.ok(new RegExp(`class="catalog-list-chip[^"]*"[^>]*>${label}</button>`).test(shell.text), `${label} chip`);
    }
    const css = await call(env, "/app.css");
    assert.ok(css.text.includes(".catalog-list-chip {"), "the smaller chips are styled");
  });

  it("takes the underline off the shell's tab links", async () => {
    const env = makeEnv();
    const css = await call(env, "/app.css");
    assert.match(css.text, /html\[data-app-shell="1"\] a\.tab-btn,\s*html\[data-app-shell="1"\] a\.bottom-nav-item \{ text-decoration: none; \}/);
  });

  it("emits the Imports screen only for the shell (P6-6)", async () => {
    const env = makeEnv();
    const legacy = await call(env, "/");
    assert.equal(legacy.text.includes('id="appShellImports"'), false);
    const shell = await call(env, "/lists/import", { cookie: SHELL_COOKIE });
    assert.equal(shell.status, 200);
    assert.ok(shell.text.includes('id="appShellImports"'), "the Imports screen needs a home");
    // ...inside the panel the old import from a link lives in, which stays.
    assert.ok(shell.text.includes('id="unifiedImportFileInput"'), "the old import panel should still be there");
    // Import a file comes after Import list from a link (the owner's order).
    assert.ok(shell.text.indexOf("Import list from a link") < shell.text.indexOf('id="appShellImports"'),
      "Import a file should be below Import list from a link");
  });

  it("emits the Channels templates only for the shell (P6-7)", async () => {
    const env = makeEnv();
    const legacy = await call(env, "/");
    assert.equal(legacy.text.includes('id="appShellChannels"'), false);
    const shell = await call(env, "/channels", { cookie: SHELL_COOKIE });
    assert.equal(shell.status, 200);
    assert.ok(shell.text.includes('id="appShellChannels"'), "the channel templates need a home");
    // ...above the My Channels panel, which stays exactly as it is, and before
    // the merge tools under it.
    assert.ok(shell.text.includes('id="myCreatedChannelsList"'), "the old My Channels panel should still be there");
    assert.ok(shell.text.indexOf('id="appShellChannels"') < shell.text.indexOf('id="myCreatedChannelsList"'),
      "the templates come first");
  });

  it("ships one bundle and one stylesheet for both variants", async () => {
    // A shell-only line inside either of them would make one cached,
    // publicly-hashed file depend on a cookie. Each isolate's hash describes
    // the first page it rendered, so rendering one variant per fresh isolate is
    // what makes the comparison meaningful.
    const envLegacy = makeEnv();
    const legacy = await call(envLegacy, "/");
    const envShell = makeEnv();
    const shell = await call(envShell, "/", { cookie: SHELL_COOKIE });

    const legacyAssets = assetVersions(legacy.text);
    const shellAssets = assetVersions(shell.text);
    assert.equal(legacyAssets.js.length, 20, "the legacy page should name its bundle by hash");
    assert.equal(legacyAssets.css.length, 20, "the legacy page should name its stylesheet by hash");
    assert.equal(shellAssets.js, legacyAssets.js, "the client bundle must not depend on the cookie");
    assert.equal(shellAssets.css, legacyAssets.css, "the stylesheet must not depend on the cookie");

    // The shell page is the split page too: the bundle is not inlined into it.
    assert.equal(shell.text.includes("function initAppShell("), false, "the shell page must not inline the bundle");
    const appJsLegacy = await call(envLegacy, "/app.js");
    const appJsShell = await call(envShell, "/app.js");
    assert.equal(appJsLegacy.status, 200);
    assert.equal(appJsShell.text, appJsLegacy.text, "/app.js must be one file for everybody");
  });

  it("keeps the shell inert in the browser: NEW_UI false leaves the legacy switchers alone", async () => {
    // A static check on the shipped bundle: the legacy switchers still write
    // the URL themselves, and only on a shell page is that skipped -- see the
    // appShellActive guards in 16_ and 20_.
    const env = makeEnv();
    const bundle = await call(env, "/app.js");
    assert.equal(bundle.status, 200);
    assert.match(bundle.text, /if \(!appShellActive\)/, "the legacy history writes must be conditional on the shell");
    assert.match(bundle.text, /function appShellHandleNav\(/, "the shell's routing hook");
    assert.match(bundle.text, /function initAppShell\(/, "the shell's boot function");
    assert.match(bundle.text, /if \(!NEW_UI\) return;/, "the shell must do nothing at all when NEW_UI is false");
    assert.match(bundle.text, /credentials: 'same-origin'/, "the API client sends the session cookie");
  });
});

// FF_NEW_UI, the Worker variable: what a browser that has not chosen gets.
describe("the new interface for everyone (FF_NEW_UI)", () => {
  const isShell = (res) => res.text.includes('<html lang="en" data-app-shell="1">');

  it("serves the new interface to a browser that has not chosen", async () => {
    const env = makeEnv({ FF_NEW_UI: "1" });
    const home = await call(env, "/");
    assert.equal(home.status, 200);
    assert.ok(isShell(home), "the home page is the new interface");
    assert.ok(home.text.includes("const NEW_UI = true;"));
    for (const view of VIEWS) {
      const res = await call(env, view.path);
      assert.equal(res.status, 200, `${view.path} is served`);
      assert.ok(isShell(res), `${view.path} is the new interface`);
    }
  });

  it("keeps the classic page for a browser that chose it", async () => {
    const env = makeEnv({ FF_NEW_UI: "1" });
    const off = await call(env, "/?ff_new_ui=0");
    const cookie = (off.headers.get("set-cookie") || "").split(";")[0];
    assert.equal(cookie, "FF_NEW_UI=0");
    const home = await call(env, "/", { cookie });
    assert.equal(isShell(home), false, "the classic page, by the browser's choice");
    assert.ok(home.text.includes("const NEW_UI = false;"));
    assert.equal((await call(env, "/settings", { cookie })).status, 404, "the new interface's addresses stay its own");
  });

  it("changes nothing while the variable is off, or set to anything but 1", async () => {
    for (const value of [undefined, "", "0", "no"]) {
      const env = makeEnv(value === undefined ? {} : { FF_NEW_UI: value });
      assert.equal(isShell(await call(env, "/")), false, `FF_NEW_UI=${value}`);
      assert.equal((await call(env, "/settings")).status, 404);
      assert.ok(isShell(await call(env, "/", { cookie: SHELL_COOKIE })), "the cookie still opts in");
    }
  });

  it("serves the two pages from two separate memos, never one for the other", async () => {
    const env = makeEnv({ FF_NEW_UI: "1" });
    const shell = await call(env, "/");
    const classic = await call(env, "/", { cookie: "FF_NEW_UI=0" });
    const shellAgain = await call(env, "/");
    assert.ok(isShell(shell) && isShell(shellAgain));
    assert.equal(isShell(classic), false);
    assert.notEqual(shell.headers.get("etag"), classic.headers.get("etag"));
  });
});
