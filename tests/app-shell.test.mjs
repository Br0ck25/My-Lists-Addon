import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { call, makeEnv } from "./harness.mjs";

// The new UI shell (Phase 6, P6-1). Until Release 21 it was opt-in per browser
// through the FF_NEW_UI cookie (and the FF_NEW_UI variable for a browser that
// had not chosen). The classic page is retired now: every visitor gets the
// shell, whatever the cookie or the variable says, and a link that still
// carries ?ff_new_ui= is sent on without it.

// APP_SHELL_TABS (00_constants.js), as the routes rather than the ids: this is
// what the server must answer and what the nav must link to.
const VIEWS = [
  { path: "/catalogs", subs: ["all", "quickadd", "bulk"] },
  { path: "/lists", subs: ["my-lists", "liked", "create-list", "import"] },
  { path: "/channels", subs: ["my-channels", "storylines", "quickadd", "explore", "import", "build"] },
  { path: "/discover", subs: ["movie", "all", "series", "popular", "curated", "gems", "kids", "holidays", "genres"] },
  { path: "/search", subs: [] },
  { path: "/settings", subs: ["account", "display", "scrobble", "external", "backup", "feedback"] },
];

// A served page names the shared bundle and stylesheet by content hash
// (?v=<first 20 hex of the SHA-256>), so equal hashes mean equal bytes.
function assetVersions(html) {
  const js = (html.match(/<script src="\/app\.js\?v=([0-9a-f]+)"/) || [])[1] || "";
  const css = (html.match(/<link rel="stylesheet" href="\/app\.css\?v=([0-9a-f]+)"/) || [])[1] || "";
  return { js, css };
}

const isShell = (res) => res.text.includes('<html lang="en" data-app-shell="1">');

describe("the new interface is the only page (the classic page retired)", () => {
  it("serves the new interface to everyone, whatever the cookie or the variable says", async () => {
    for (const vars of [{}, { FF_NEW_UI: "0" }, { FF_NEW_UI: "1" }]) {
      const env = makeEnv(vars);
      for (const cookie of [undefined, "FF_NEW_UI=0", "FF_NEW_UI=1"]) {
        const home = await call(env, "/", cookie ? { cookie } : {});
        const what = `FF_NEW_UI=${vars.FF_NEW_UI}, cookie ${cookie}`;
        assert.equal(home.status, 200, what);
        assert.ok(isShell(home), `the new interface (${what})`);
        assert.equal(home.text.includes("const NEW_UI"), false, "the preamble flag is gone");
        assert.equal((await call(env, "/settings", cookie ? { cookie } : {})).status, 200, `/settings is served (${what})`);
      }
    }
  });

  it("has none of the classic page's own parts left", async () => {
    const env = makeEnv();
    const home = await call(env, "/");
    // The classic tab buttons, the install-link import, the floating
    // unsaved-changes banner.
    assert.equal(home.text.includes(`data-act="switchTab" data-act-args="[&quot;catalogs&quot;]"`), false);
    assert.equal(home.text.includes('id="importLinkInput"'), false);
    assert.equal(home.text.includes('id="unsavedInstallBanner"'), false);
    const css = await call(env, "/app.css");
    assert.equal(css.text.includes(".unsaved-install-banner"), false);
  });

  it("serves the shell with real nav links", async () => {
    const env = makeEnv();
    const shell = await call(env, "/");
    assert.equal(shell.status, 200);
    assert.ok(isShell(shell), "the shell marker");
    // The install bar across the top was taken out at the owner's request;
    // Catalogs' Generate Install Link remains.
    assert.equal(shell.text.includes('id="appShellInstallBar"'), false, "the install bar is back");
    assert.ok(shell.text.includes('data-act="generate"'), "Catalogs keeps its install link button");
    // Every view is a real link, in both navs (desktop bar and mobile bar).
    for (const view of VIEWS) {
      const links = shell.text.split(`<a class="tab-btn`).length - 1;
      assert.ok(links >= 1, "the desktop nav should be links");
      assert.ok(shell.text.includes(`href="${view.path}"`), `${view.path} should be linked`);
    }
    assert.equal((shell.text.match(/<a class="tab-btn[^>]*href="\/catalogs"/g) || []).length, 1);
    assert.equal((shell.text.match(/<a class="bottom-nav-item[^>]*href="\/catalogs"/g) || []).length, 1);
    // Settings' Devices and Install link cards are removed.
    assert.equal(shell.text.includes('id="appShellSettingsHome"'), false, "the Devices / Install link cards are gone");
    // The head script (which runs before the body exists) gets the same routes.
    assert.ok(shell.text.includes("var APP_SHELL_HEAD_ROUTES ="), "the head script needs the route table");
    for (const view of VIEWS) {
      assert.ok(shell.text.includes(`"${view.path}":{"tab"`), `${view.path} should be in the head route table`);
      for (const sub of view.subs) {
        assert.ok(shell.text.includes(`"${view.path}/${sub}":{"tab"`), `${view.path}/${sub} should be in the head route table`);
      }
    }
  });

  it("answers the shell's paths", async () => {
    const env = makeEnv();
    for (const view of VIEWS) {
      const page = await call(env, view.path);
      assert.equal(page.status, 200, `${view.path} should be served`);
      assert.ok(isShell(page), `${view.path} should be the shell`);
      for (const sub of view.subs) {
        const subPage = await call(env, `${view.path}/${sub}`);
        assert.equal(subPage.status, 200, `${view.path}/${sub} should be served`);
      }
      // A sub-tab that does not exist must not open some other panel. For
      // /lists and /channels the check cannot be a 404: those subtrees are
      // already catch-alls for share links (/lists/<slug> resolves a chart,
      // /channels/<user>/<slug> a channel), so the page is served either way --
      // and the shell's router then falls back to the view itself rather than
      // routing an unknown sub. The other four have no such subtree.
      const bogus = await call(env, `${view.path}/not-a-sub`);
      if (view.path === "/lists" || view.path === "/channels") {
        assert.equal(bogus.status, 200, `${view.path}/not-a-sub keeps its own catch-all route`);
      } else {
        assert.equal(bogus.status, 404, `${view.path}/not-a-sub must not invent a view`);
      }
    }
  });

  it("keeps the share links on their own routes", async () => {
    const env = makeEnv();
    // /lists/<slug> is a deep link that opens the list, not the Lists view.
    const res = await call(env, "/lists/watchlist");
    assert.equal(res.status, 200, "/lists/watchlist should keep resolving");
    assert.ok(res.text.includes("SERVER_DEEP_LINK_LIST") || res.text.includes("const SERVER_DEEP_LINK_LIST"), "the page should still carry its deep-link payload");
  });

  it("sends an old ?ff_new_ui= link on without it, and clears the old cookie", async () => {
    const env = makeEnv();
    for (const [path, to] of [["/?ff_new_ui=1", "/"], ["/settings?ff_new_ui=0", "/settings"], ["/discover?ff_new_ui=0&x=1", "/discover?x=1"], ["/?ff_new_ui=", "/"]]) {
      const res = await call(env, path);
      assert.equal(res.status, 302, path);
      assert.equal(res.headers.get("location"), to, path);
      const cookie = res.headers.get("set-cookie") || "";
      assert.match(cookie, /^FF_NEW_UI=;/, "the cookie is cleared, not set");
      assert.match(cookie, /Max-Age=0/);
    }
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
    const shell = await call(env, "/");
    // The Settings copy of the duplicate toggle (which the editor now owns) is
    // hidden rather than removed: the setting is still read from its checkbox.
    assert.ok(shell.text.includes('id="appShellHomeEditor"'));
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
    // A first-time visitor is given the eight demo rows.
    const demo = JSON.parse((shell.text.match(/const serverEntries = \(?(\[[\s\S]*?\])\)?;/) || [])[1]);
    assert.equal(demo.length, 8, "the page pre-fills its demo rows");
    assert.equal(shell.text.includes("APP_SHELL_STARTER_PACK"), false);
  });

  it("no longer has a Your lists section or the separate add-titles search", async () => {
    const env = makeEnv();
    const shell = await call(env, "/lists");
    assert.equal(shell.status, 200);
    assert.equal(shell.text.includes('id="appShellListsHome"'), false, "Your lists was taken out at the owner's request");
    assert.equal(shell.text.includes('id="appShellAddTitles"'), false, "the editor has its own search");
  });

  it("moves Explore's source and sort chips from Discover to Search -> Lists (P6-5)", async () => {
    const env = makeEnv();
    const shell = await call(env, "/discover");
    assert.equal(shell.status, 200);
    assert.equal(shell.text.includes('id="appShellExplore"'), false, "Explore was taken off Discover");
    assert.ok(shell.text.includes('id="catalogListSearchChips"'), "Search -> Lists carries the chips");
    for (const label of ["All sources", "My Lists Addon", "MDBList", "Trakt", "Most liked", "Newest", "Most added"]) {
      assert.ok(new RegExp(`class="catalog-list-chip[^"]*"[^>]*>${label}</button>`).test(shell.text), `${label} chip`);
    }
    assert.equal(/data-chip-value="tmdb"/.test(shell.text), false, "TMDB has no list directory to browse, so no chip");
    const css = await call(env, "/app.css");
    assert.ok(css.text.includes(".catalog-list-chip {"), "the smaller chips are styled");
  });

  it("takes the underline off the shell's tab links", async () => {
    const env = makeEnv();
    const css = await call(env, "/app.css");
    assert.match(css.text, /html\[data-app-shell="1"\] a\.tab-btn,\s*html\[data-app-shell="1"\] a\.bottom-nav-item \{ text-decoration: none; \}/);
  });

  it("has the Imports screen (P6-6)", async () => {
    const env = makeEnv();
    const shell = await call(env, "/lists/import");
    assert.equal(shell.status, 200);
    assert.ok(shell.text.includes('id="appShellImports"'), "the Imports screen needs a home");
    // ...inside the panel the old import from a link lives in, which stays.
    assert.ok(shell.text.includes('id="unifiedImportFileInput"'), "the old import panel should still be there");
    // Import a file comes after Import list from a link (the owner's order).
    assert.ok(shell.text.indexOf("Import list from a link") < shell.text.indexOf('id="appShellImports"'),
      "Import a file should be below Import list from a link");
  });

  it("no longer has the New channel templates panel", async () => {
    const env = makeEnv();
    const shell = await call(env, "/channels");
    assert.equal(shell.status, 200);
    assert.ok(!shell.text.includes('id="appShellChannels"'), "the New channel panel is removed");
    assert.ok(shell.text.includes('id="myCreatedChannelsList"'), "the My Channels panel should still be there");
  });

  it("names its bundle and stylesheet by hash and does not inline the bundle", async () => {
    const env = makeEnv();
    const shell = await call(env, "/");
    const assets = assetVersions(shell.text);
    assert.equal(assets.js.length, 20, "the page should name its bundle by hash");
    assert.equal(assets.css.length, 20, "the page should name its stylesheet by hash");
    assert.equal(shell.text.includes("function initAppShell("), false, "the page must not inline the bundle");
    const appJs = await call(env, "/app.js");
    assert.equal(appJs.status, 200);
  });

  it("renders the home page once and answers a repeat from the same memo", async () => {
    const env = makeEnv();
    const first = await call(env, "/");
    const again = await call(env, "/", { cookie: "FF_NEW_UI=0" });
    assert.ok(isShell(first) && isShell(again));
    assert.equal(first.headers.get("etag"), again.headers.get("etag"), "the old cookie makes no second page");
  });

  it("boots the shell in the browser with no on/off flag", async () => {
    // A static check on the shipped bundle: the legacy switchers still write
    // the URL themselves only when the shell is not running -- see the
    // appShellActive guards in 16_ and 20_ -- and nothing reads NEW_UI.
    const env = makeEnv();
    const bundle = await call(env, "/app.js");
    const features = await call(env, "/app-features.js");
    const allCode = bundle.text + features.text;
    assert.equal(bundle.status, 200);
    assert.equal(features.status, 200);
    assert.match(allCode, /if \(!appShellActive\)/, "the legacy history writes must be conditional on the shell");
    assert.match(allCode, /function appShellHandleNav\(/, "the shell's routing hook");
    assert.match(allCode, /function initAppShell\(/, "the shell's boot function");
    assert.equal(/\bNEW_UI\b/.test(allCode), false, "the retired flag must not be read anywhere");
    assert.match(allCode, /credentials: 'same-origin'/, "the API client sends the session cookie");
  });
});
