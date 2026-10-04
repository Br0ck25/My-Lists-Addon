// --- The new UI shell's chrome (Phase 6, P6-1) ------------------------------
//
// Everything here is emitted only for a browser carrying the FF_NEW_UI cookie
// (isNewUiRequest, 02_http-and-creator-utils.js), so the page every other
// visitor gets is byte-for-byte the page they got before. The client bundle is
// shared by both variants -- it is one content-hashed file (splitAppBundle,
// 02_) -- so the shell's behaviour is not emitted from here: it lives in
// 24_client-backup-restore-presets.js and keys off the NEW_UI flag in the
// per-request preamble.
//
// The tabs are real links. Middle-click, copy-link, open-in-a-new-tab and the
// back button all work with no JavaScript at all; the client intercepts a
// plain left click and routes in-page. The class names are the legacy ones on
// purpose: every existing rule -- the desktop pills, the mobile bottom bar,
// the dark theme, the safe-area padding -- then applies to them unchanged.
const APP_SHELL_TAB_ICONS = {
  catalogs: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>',
  lists: '<line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line>',
  channels: '<rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect><polyline points="17 2 12 7 7 2"></polyline>',
  discover: '<rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect>',
  search: '<circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>',
  settings: '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>',
};

// Which view the page opens on when it is served at a shell path. The shell's
// own routing (24_) reads the same table, written into the bundle.
function appShellTabForPath(pathname) {
  const p = String(pathname || "");
  for (const t of APP_SHELL_TABS) {
    if (p === t.path) return t;
    if (p.startsWith(t.path + "/")) {
      const rest = p.slice(t.path.length + 1).replace(/\/+$/, "");
      if (rest && t.subs.indexOf(rest) !== -1) return t;
    }
  }
  return null;
}

function buildAppShellNavHtml(style) {
  const isDesktop = style === "desktop";
  const tabs = isDesktop ? APP_SHELL_TABS : APP_SHELL_TABS.filter((t) => t.id !== "search");
  const items = tabs.map((t) => {
    const active = t.id === "discover";
    const cls = (isDesktop ? "tab-btn" : "bottom-nav-item") + (active ? " active" : "");
    // The id and aria-controls keep the panels' own aria-labelledby="tab-..."
    // pointing at a real element: the legacy buttons carry these ids and the
    // panels were never changed, so a nav without them leaves six references
    // dangling (html_checks.py fails the build for exactly that).
    const attrs = `class="${cls}" id="tab-${isDesktop ? "desktop" : "mobile"}-${t.id}" aria-controls="content-${t.id}"` +
      ` data-tab="${t.id}" data-app-route href="${t.path}" title="${t.label}"` +
      (active ? ' aria-current="page"' : "");
    if (isDesktop) return `<a ${attrs}>${t.label}</a>`;
    return `<a ${attrs}>\n      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">\n        ${APP_SHELL_TAB_ICONS[t.id] || ""}\n      </svg>\n      ${t.label}\n    </a>`;
  }).join("\n    ");
  if (isDesktop) {
    return `<div class="tab-bar" id="appShellDesktopNav">\n    <nav aria-label="Main navigation" style="display:flex; gap:8px; overflow-x:auto; width:100%;">\n    ${items}\n    </nav>\n  </div>`;
  }
  return `<nav class="bottom-nav" id="appShellMobileNav" aria-label="Main navigation">\n    ${items}\n  </nav>`;
}

// Path -> { tab, sub } for the head script, which runs before the body exists
// and so cannot use the client bundle's router. The bundle builds the same
// routes from APP_SHELL_TAB_LIST (16_client-row-core.js); a test keeps the two
// agreeing with this one table.
function buildAppShellHeadRoutes() {
  const out = {};
  for (const t of APP_SHELL_TABS) {
    out[t.path] = { tab: t.id, sub: "" };
    for (const sub of t.subs) out[t.path + "/" + sub] = { tab: t.id, sub: sub };
  }
  return out;
}

// The Worker-side twin of appActArgs (16_client-row-core.js). 08_quickadd-chart-data.js
// builds some of the page's markup here in the Worker rather than in the
// browser (see buildCombinedChartsHtml), so its data-act arguments need the
// same JSON-then-HTML escaping at render time. Kept next to renderBuilder so
// it is obviously server-side code: the client's own copy is inside the
// template literal below and is not in scope here.
function appActArgsServer(values) {
  return escapeHtmlServer(JSON.stringify(values || []));
}

function renderBuilder(
  origin,
  { initialEntries = [], initialKeys = {}, isConfigureMode = false, deepLinkList = null, newUi = false } = {}
) {
  const initialTmdbKey = initialKeys.tmdbKey || "";
  const initialMdblistKey = initialKeys.mdblistKey || "";
  const initialMdblistAccessToken = initialKeys.mdblistAccessToken || "";
  const initialTraktKey = initialKeys.traktKey || "";
  const initialTraktUsername = initialKeys.traktUsername || "";
  const initialTraktAccessToken = initialKeys.traktAccessToken || "";
  const initialSimklKey = initialKeys.simklKey || "";
  const initialSimklAccessToken = initialKeys.simklAccessToken || "";
  const initialSimklUsername = initialKeys.simklUsername || "";
  const initialShuffleShelves = !!initialKeys.shuffleShelves;
  const initialShuffleItems = !!initialKeys.shuffleItems;
  const initialRegion = initialKeys.region || "US";
  const initialHideNonDigitalReleases = !!initialKeys.hideNonDigitalReleases;
  const initialAdultContentFilter = !!initialKeys.adultContentFilter;
  const initialDedupeAcrossLists = !!initialKeys.dedupeAcrossLists;
  // BetterPosters (btttr.cc). Opt-in, so the master switch defaults off while
  // each style control defaults to btttr.cc's own default for that option --
  // see decodeConfig (02_http-and-creator-utils.js).
  const initialBetterPosters = !!initialKeys.betterPosters;
  const initialBetterPostersGenre = initialKeys.betterPostersGenre !== false;
  const initialBetterPostersRating = initialKeys.betterPostersRating !== false;
  const initialBetterPostersQuality = !!initialKeys.betterPostersQuality;
  const initialBetterPostersAge = !!initialKeys.betterPostersAge;
  const initialBetterPostersTrendTags = initialKeys.betterPostersTrendTags !== false;
  const betterPostersLangOptionsHtml = buildBetterPostersLangOptionsHtml(initialKeys.betterPostersLang || "en");
  const betterPostersRatingSourceOptionsHtml = buildBetterPostersRatingSourceOptionsHtml(initialKeys.betterPostersRatingSource || "avg");
  const streamingTop10Html = buildStreamingTop10Html();
  const streamingHtml = buildStreamingHtml();
  const mdblistChartsHtml = buildMdblistChartsHtml();
  const tmdbChartsHtml = buildTmdbChartsHtml();
  const traktChartsHtml = buildTraktChartsHtml();
  const simklChartsHtml = buildSimklChartsHtml();
  const combinedChartsHtml = buildCombinedChartsHtml();
  const hiddenGemsHtml = buildHiddenGemsHtml();
  const kidsHtml = buildKidsHtml();
  const holidaysHtml = buildHolidaysHtml();
  const genresHtml = buildGenresHtml();
  // New on Streaming + My Lists Addon Most Watched -- see MY_LISTS_ADDON_CHARTS (08).
  const myListsAddonChartsHtml = buildMyListsAddonChartsHtml();
  // Precomputed here (same pattern as the *Html fragments above) rather
  // than built inline inside the giant HTML template literal below --
  // this file's template literal has bitten past changes before with
  // subtle escaping issues (see e.g. the doubled-backslash regex gotcha
  // elsewhere in renderBuilder), so anything with its own quotes/braces/
  // JSON gets built as a plain variable first and just substituted in as
  // one clean ${seoHeadHtml}.
  //
  // The two modes render different things: the plain / install page
  // (isConfigureMode false) is the only URL meant to be publicly
  // discoverable, so it gets the real title/description/OG/JSON-LD.
  // /:config/configure pages carry a personal base64 config (and any
  // personal API keys the user pasted in) baked straight into the URL
  // path -- there's no reason for a search engine to crawl, index, or
  // cache one of those, so those get a plain noindex instead of any of
  // the SEO metadata below.
  const seoHeadHtml = isConfigureMode
    ? `<title>${ADDON_NAME} — Configure</title>
<meta name="robots" content="noindex, nofollow">
<link rel="canonical" href="${origin}/">`
    : `<title>${ADDON_NAME} — Stremio Catalogs from MDBList, Trakt, TMDB &amp; Simkl</title>
<meta name="description" content="Turn any MDBList, Trakt, TMDB, or Simkl list into a Stremio/wako catalog row. Free, with no ads. Includes Watch History, Continue Watching, and a full Custom List builder.">
<link rel="canonical" href="${origin}/">
<meta name="robots" content="index, follow">
<meta property="og:type" content="website">
<meta property="og:title" content="${ADDON_NAME} — Stremio Catalogs from Your Lists">
<meta property="og:description" content="Turn any MDBList, Trakt, TMDB, or Simkl list into a Stremio/wako catalog row. Free, with no ads.">
<meta property="og:url" content="${origin}/">
<meta property="og:image" content="${origin}/icon.png">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${ADDON_NAME} — Stremio Catalogs from Your Lists">
<meta name="twitter:description" content="Turn any MDBList, Trakt, TMDB, or Simkl list into a Stremio/wako catalog row. Free, with no ads.">
<script type="application/ld+json" nonce="${CSP_NONCE_PLACEHOLDER}">${jsonForScript({
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        name: ADDON_NAME,
        applicationCategory: "MultimediaApplication",
        operatingSystem: "Any",
        description:
          "Stremio/wako add-on that turns MDBList, Trakt, TMDB, and Simkl lists into home-screen catalog rows, with Watch History, Continue Watching, and a Custom List builder.",
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        url: origin + "/",
      })}</script>`;
  const hasInitial = initialEntries.length > 0;
  // Whether initialEntriesJson below ends up holding the caller's real,
  // resolved entries or just this fallback first-time-visitor demo set --
  // threaded to the client as usingDefaultEntries so it can tell the two
  // apart (see the "pre-fill" block's own comment on why that distinction
  // matters for when to trust localStorage over what the server sent).
  const usingDefaultEntries = !hasInitial;
  // A first-time visitor gets the demo rows, on either page. The shell used to
  // offer them as a button in its home-screen editor instead (P6-3); that
  // editor was taken out at the owner's request, and without the button a new
  // visitor would have had no way to them.
  const initialEntriesJson = jsonForScript(
    hasInitial ? initialEntries : STARTER_PACK_ENTRIES
  );

  // The shell variant of the chrome. Both navs keep the legacy wrappers
  // (`.tab-bar`, `.bottom-nav`) so the existing CSS -- including the mobile
  // bottom bar -- applies to them unchanged; only the items differ, from
  // buttons to links.
  const appShellDesktopNavHtml = newUi ? buildAppShellNavHtml("desktop") : "";
  const appShellMobileNavHtml = newUi ? buildAppShellNavHtml("mobile") : "";

  return `<!DOCTYPE html>
<html lang="en"${newUi ? ' data-app-shell="1"' : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#F2F2F7">
<link rel="manifest" href="${origin}/app.webmanifest">
${seoHeadHtml}
<link rel="icon" type="image/png" href="${origin}/icon.png">
<!-- Fonts: the device's own (P7-1). This page used to load Inter, Space
     Grotesk and JetBrains Mono from fonts.googleapis.com + fonts.gstatic.com,
     which cost a third-party connection on first paint, told Google which
     pages a visitor opened, and pinned style-src/font-src to those origins.
     The stacks below are what is left of that: the same shapes and weights,
     rendered by the OS (San Francisco on Apple, Segoe UI on Windows, Roboto
     on Android), so the page has no third-party origin at all and paints
     without waiting on one. See docs/DECISIONS.md D-20. -->
<script nonce="${CSP_NONCE_PLACEHOLDER}">
  ${newUi ? `var APP_SHELL_HEAD_ROUTES = ${jsonForScript(buildAppShellHeadRoutes())};` : ""}
  if (localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark-theme');
    try {
      var metaTheme = document.querySelector('meta[name="theme-color"]');
      if (metaTheme) metaTheme.setAttribute('content', '#000000');
    } catch (e) {}
  }
  function toggleTheme() {
    var isDark = document.documentElement.classList.toggle('dark-theme');
    try {
      localStorage.setItem('theme', isDark ? 'dark' : 'light');
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', isDark ? '#000000' : '#F2F2F7');
    } catch (e) {}
  }
  (function() {
    var p = location.pathname || '';
    var h = location.hash || '';
    var isDeep = (p.startsWith('/lists/') && p !== '/lists') || p.startsWith('/channels/') || h.startsWith('#/list?') || h.startsWith('#/item?');
    var tab = 'discover';
    // The new UI shell routes on real paths (/catalogs, /settings, ...), so
    // there the path -- not the last tab this browser used -- decides which
    // view opens. Same table the Worker rendered the nav from.
    // APP_SHELL_HEAD_ROUTES is declared just above only on a shell page; this
    // script is shared by both variants, so it must not name it unconditionally
    // -- scope_check.mjs catches exactly that, and a legacy page would throw.
    var shellRoute = null;
    if (document.documentElement.getAttribute('data-app-shell') === '1' && typeof APP_SHELL_HEAD_ROUTES !== 'undefined') {
      shellRoute = APP_SHELL_HEAD_ROUTES[p] || null;
    }
    if (isDeep) {
      tab = h.startsWith('#/item?') ? 'item-details' : 'list-details';
    } else if (shellRoute) {
      tab = shellRoute.tab;
    } else {
      try {
        var s = localStorage.getItem('myListAddon:activeTab');
        if (s && s !== 'list-details' && s !== 'item-details') tab = s;
      } catch (e) {}
    }
    document.documentElement.setAttribute('data-initial-tab', tab);
    var shellSub = (shellRoute && shellRoute.sub) || '';

    try {
      var catSub = shellSub || localStorage.getItem('myListAddon:catalogsSubmenu') || 'all';
      document.documentElement.setAttribute('data-initial-catalogs-sub', catSub);
      var listSub = (shellRoute && shellRoute.tab === 'lists' && shellSub) || localStorage.getItem('myListAddon:listsSubmenu') || 'my-lists';
      // Must agree with normalizeListsSubmenu (16_client-row-core.js): the rule
      // above hides every Lists panel and then un-hides the one this attribute
      // names, so a stale value naming a panel that no longer exists leaves the
      // tab blank from first paint.
      if (['my-lists', 'liked', 'import', 'create-list'].indexOf(listSub) === -1) listSub = 'my-lists';
      document.documentElement.setAttribute('data-initial-lists-sub', listSub);
      var chSub = (shellRoute && shellRoute.tab === 'channels' && shellSub) || localStorage.getItem('myListAddon:channelsSubmenu') || 'my-channels';
      document.documentElement.setAttribute('data-initial-channels-sub', chSub);
      var setSub = (shellRoute && shellRoute.tab === 'settings' && shellSub) || localStorage.getItem('myListAddon:settingsSubmenu') || 'account';
      if (['account', 'display', 'scrobble', 'external', 'backup', 'feedback'].indexOf(setSub) === -1) setSub = 'account';
      document.documentElement.setAttribute('data-initial-settings-sub', setSub);
      var discSub = (shellRoute && shellRoute.tab === 'discover' && shellSub) || localStorage.getItem('myListAddon:discoverSubmenu') || 'movie';
      if (discSub === 'all') discSub = 'movie';
      document.documentElement.setAttribute('data-initial-discover-sub', discSub);
    } catch (e) {}
  })();
</script>
<!--
  Marked for extraction the same way the client bundle is (see
  splitAppBundle, 02_http-and-creator-utils.js). This stylesheet is ~85KB,
  identical for every visitor and every route, and was inlined into every
  page alongside the script. Verified deploy-constant by the same test that
  covers the bundle: rendered across origins, configure mode and deep links,
  it comes back byte-identical every time and carries no injected value.
-->
<style nonce="${CSP_NONCE_PLACEHOLDER}">/*MYLISTS_APP_CSS_START*/
  :root {
    /* Modern iOS/macOS human-interface design system tokens */
    color-scheme: light;

    /* Semantic Surfaces & Backgrounds */
    --color-bg-canvas:      #F2F2F7;
    --color-bg-surface:     #FFFFFF;
    --color-bg-elevated:    #FFFFFF;
    --color-bg-sunken:      #E5E5EA;
    --color-bg-overlay:     rgba(0, 0, 0, 0.45);

    /* Semantic Borders */
    --color-border-subtle:  rgba(0, 0, 0, 0.08);
    --color-border-strong:  rgba(0, 0, 0, 0.14);
    --color-border-focus:   #007AFF;

    /* Semantic Typography / Foreground */
    --color-text-primary:   #1C1C1E;
    --color-text-secondary: #3A3A3C;
    --color-text-muted:     #636366;
    --color-text-inverse:   #FFFFFF;

    /* Brand & Accent */
    --color-brand:          #007AFF;
    --color-brand-hover:    #0062CC;
    --color-brand-active:   #004FB3;
    --color-brand-subtle:   rgba(0, 122, 255, 0.12);
    --color-brand-2:        #34AADC;

    /* Status & Feedback */
    --color-danger:         #FF3B30;
    --color-danger-hover:   #D70015;
    --color-danger-subtle:  rgba(255, 59, 48, 0.12);
    --color-success:        #34C759;
    --color-success-hover:  #248A3D;
    --color-success-subtle: rgba(52, 199, 89, 0.12);
    --color-warn:           #FF9500;
    --color-warn-hover:     #C97000;
    --color-warn-subtle:    rgba(255, 149, 0, 0.12);

    /* Rating Colors */
    --color-rating-high:    #34C759;
    --color-rating-mid:     #FF9500;
    --color-rating-low:     #FF3B30;

    /* Elevation & Shadows */
    --shadow-sm:            0 1px 3px rgba(0, 0, 0, 0.06);
    --shadow:               0 2px 10px rgba(0, 0, 0, 0.08);
    --shadow-md:            0 4px 20px rgba(0, 0, 0, 0.10);
    --shadow-lg:            0 8px 30px rgba(0, 0, 0, 0.16);
    --shadow-focus:         0 0 0 3px rgba(0, 122, 255, 0.35);

    /* Spacing Scale (8pt grid system with half-steps) */
    --space-0-5:            2px;
    --space-1:              4px;
    --space-1-5:            6px;
    --space-2:              8px;
    --space-2-5:            10px;
    --space-3:              12px;
    --space-3-5:            14px;
    --space-4:              16px;
    --space-5:              20px;
    --space-6:              24px;
    --space-8:              32px;

    /* Border Radius Scale */
    --radius-xs:            4px;
    --radius-sm:            8px;
    --radius-md:            12px;
    --radius-lg:            16px;
    --radius-xl:            20px;
    --radius-pill:          999px;

    /* Interactive Component Controls & Touch Targets */
    --control-height-sm:    32px;
    --control-height-md:    40px;
    --control-height-lg:    48px;
    --control-touch-min:    44px;

    /* Typography Scale */
    --font-display:         -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, system-ui, sans-serif;
    --font-body:            -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, system-ui, sans-serif;
    --font-mono:            ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
    --font-size-xs:         0.75rem;
    --font-size-sm:         0.85rem;
    --font-size-base:       0.925rem;
    --font-size-md:         1rem;
    --font-size-lg:         1.15rem;
    --font-size-xl:         1.35rem;
    --font-size-2xl:        1.6rem;

    /* Scrollbars */
    --sb-track:             transparent;
    --sb-thumb:             rgba(0, 0, 0, 0.15);
    --sb-thumb-hover:       rgba(0, 0, 0, 0.25);

    /* Complete Backward-Compatibility Aliases */
    --bg:                   var(--color-bg-canvas);
    --surface:              var(--color-bg-surface);
    --surface-2:            var(--color-bg-sunken);
    --surface-3:            var(--color-border-strong);
    --panel:                var(--color-bg-surface);
    --panel-strong:         var(--color-bg-sunken);
    --border:               var(--color-border-subtle);
    --border-strong:        var(--color-border-strong);
    --text:                 var(--color-text-primary);
    --text-2:               var(--color-text-secondary);
    --muted:                var(--color-text-muted);
    --accent:               var(--color-brand);
    --brand:                var(--color-brand);
    --accent-hover:         var(--color-brand-hover);
    --accent-2:             var(--color-brand-2);
    --danger:               var(--color-danger);
    --success:              var(--color-success);
    --warn:                 var(--color-warn);
    --rating-high:          var(--color-rating-high);
    --rating-mid:           var(--color-rating-mid);
    --rating-low:           var(--color-rating-low);
    --radius:               14px;
  }
  :root.dark-theme {
    color-scheme: dark;

    /* Semantic Surfaces & Backgrounds (Dark Mode) */
    --color-bg-canvas:      #000000;
    --color-bg-surface:     #1C1C1E;
    --color-bg-elevated:    #2C2C2E;
    --color-bg-sunken:      #161618;
    --color-bg-overlay:     rgba(0, 0, 0, 0.65);

    /* Semantic Borders (Dark Mode) */
    --color-border-subtle:  rgba(255, 255, 255, 0.14);
    --color-border-strong:  rgba(255, 255, 255, 0.24);
    --color-border-focus:   #0A84FF;

    /* Semantic Typography / Foreground (Dark Mode) */
    --color-text-primary:   #FFFFFF;
    --color-text-secondary: #EBEBF5;
    --color-text-muted:     #AEAEB2;
    --color-text-inverse:   #000000;

    /* Brand & Accent (Dark Mode) */
    --color-brand:          #0A84FF;
    --color-brand-hover:    #0071E3;
    --color-brand-active:   #0056B3;
    --color-brand-subtle:   rgba(10, 132, 255, 0.18);
    --color-brand-2:        #5AC8FA;

    /* Status & Feedback (Dark Mode) */
    --color-danger:         #FF453A;
    --color-danger-hover:   #FF6961;
    --color-danger-subtle:  rgba(255, 69, 58, 0.18);
    --color-success:        #30D158;
    --color-success-hover:  #34C759;
    --color-success-subtle: rgba(48, 209, 88, 0.18);
    --color-warn:           #FF9F0A;
    --color-warn-hover:     #FFB340;
    --color-warn-subtle:    rgba(255, 159, 10, 0.18);

    /* Rating Colors (Dark Mode) */
    --color-rating-high:    #30D158;
    --color-rating-mid:     #FF9F0A;
    --color-rating-low:     #FF453A;

    /* Shadows & Elevation (Dark Mode) */
    --shadow-sm:            0 1px 3px rgba(0, 0, 0, 0.35);
    --shadow:               0 2px 10px rgba(0, 0, 0, 0.45);
    --shadow-md:            0 4px 20px rgba(0, 0, 0, 0.55);
    --shadow-lg:            0 8px 30px rgba(0, 0, 0, 0.70);
    --shadow-focus:         0 0 0 3px rgba(10, 132, 255, 0.45);

    /* Scrollbars (Dark Mode) */
    --sb-thumb:             rgba(255, 255, 255, 0.15);
    --sb-thumb-hover:       rgba(255, 255, 255, 0.25);

    /* Backward-Compatibility Aliases (Dark Mode) */
    --surface-2:            var(--color-bg-sunken);
    --surface-3:            var(--color-border-strong);
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }

  /* A visible keyboard focus indicator, restored.
     Seven rules in this stylesheet set 'outline: none' -- .header-icon-btn,
     .theme-toggle-btn, .dark-mode-toggle, .channel-accordion summary,
     .cw-remove-btn, .merge-add-channel-select, .detail-sort-select -- and
     nothing put anything back. Against 97KB of CSS there were two :focus rules
     in total and no :focus-visible at all, so tabbing to the theme toggle, any
     header button, an accordion or a Continue Watching remove button gave no
     indication of where you were (WCAG 2.4.7).
     :focus-visible rather than :focus, so a mouse click does not draw a ring
     the way the removed outlines used to; and last in the cascade with
     !important because the rules that cleared it are more specific. */
  :where(a[href], button, summary, select, [tabindex]):focus-visible,
  :where(input[type="checkbox"], input[type="radio"]):focus-visible {
    outline: 2px solid var(--accent) !important;
    outline-offset: 2px;
    border-radius: 4px;
  }
  :where(input:not([type="checkbox"]):not([type="radio"]), textarea):focus-visible {
    outline: none !important;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--color-brand-subtle, rgba(0, 122, 255, 0.25)) !important;
  }

  /* The page has four @keyframes animations and 33 transitions and said
     nothing about people who have asked their system not to animate.
     The busy spinner (.app-spinner) is covered by this too -- it stops
     turning, and the wording beside it is what says the work is running. */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
      scroll-behavior: auto !important;
    }
  }
  /* scrollbar-gutter, because the page is a max-width block centred with
     'margin: 0 auto' and every tab is one panel swapped in for another. A
     panel whose content is shorter than the viewport takes the classic
     scrollbar away, the content box gets ~15px wider, and the centred page
     slides right by half of that -- which is exactly what selecting
     Discover > Hidden Gems, Catalogs > Bulk Add, Lists > Liked or Import,
     or Channels > Quick Add or Import did on desktop. Reserving the gutter
     for the whole document means the layout no longer depends on whether
     the tab currently showing happens to overflow.

     'stable' (rather than 'overflow-y: scroll') so short pages do not grow
     a dead scrollbar track; browsers without it use overlay scrollbars, so
     there is no shift for them to fix. lockBackgroundScroll
     (16_client-row-core.js) measures the gutter it actually removes rather
     than assuming, so a modal still compensates correctly either way. */
  html { touch-action: manipulation; width: 100%; max-width: 100%; overflow-x: hidden; scrollbar-gutter: stable; background: var(--bg); }
  body {
    font-family: var(--font-body);
    margin: 0;
    min-height: 100vh;
    width: 100%;
    max-width: 100%;
    overflow-x: hidden;
    /* viewport-fit=cover (see the <meta> above) extends the document into
       the status-bar and home-indicator strips so the page's own dark
       background fills them instead of the UA's white. The insets have to
       be paid back here, or the header sits under the clock. */
    padding: calc(16px + env(safe-area-inset-top, 0px)) max(12px, env(safe-area-inset-right, 0px)) calc(80px + env(safe-area-inset-bottom, 0px)) max(12px, env(safe-area-inset-left, 0px));
    background: var(--bg);
    color: var(--text);
    font-size: 15px;
    -webkit-font-smoothing: antialiased;
  }
  .page {
    max-width: 1200px;
    width: 100%;
    margin: 0 auto;
    display: grid;
    gap: 12px;
    overflow-x: hidden;
  }

  /* --- Top App Header ---------------------------------------------------- */
  .app-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: nowrap;
    gap: 10px;
    padding: 6px 4px 8px;
    min-width: 0;
  }
  .app-header-left {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
  }
  .app-header-avatar {
    width: 40px;
    height: 40px;
    border-radius: 12px;
    box-shadow: var(--shadow-sm);
    object-fit: cover;
  }
  .app-header-title-group {
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
  }
  .app-header-title {
    font-size: 1.35rem;
    font-weight: 800;
    letter-spacing: -0.025em;
    color: var(--text);
    margin: 0;
    line-height: 1.15;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .app-header-sub {
    font-size: 0.8rem;
    color: var(--muted);
    font-weight: 500;
    margin-top: 1px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .app-header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
    margin-left: auto;
  }
  .header-icon-btn, .header-avatar-btn {
    width: 36px;
    height: 36px;
    min-width: 36px;
    min-height: 36px;
    max-height: 36px;
    box-sizing: border-box;
    border-radius: 50%;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    outline: none;
    -webkit-appearance: none;
    -moz-appearance: none;
    appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--text-2);
    cursor: pointer;
    box-shadow: var(--shadow-sm);
    padding: 0;
    font-family: inherit;
    transition: background 0.2s ease, border-color 0.2s ease, transform 0.15s ease, box-shadow 0.2s ease, color 0.2s ease;
    user-select: none;
    -webkit-tap-highlight-color: transparent;
  }
  .header-icon-btn:hover, .header-avatar-btn:hover {
    background: var(--panel-strong);
    border-color: var(--accent);
    color: var(--text);
    transform: scale(1.06);
    box-shadow: var(--shadow);
  }
  .header-icon-btn:active, .header-avatar-btn:active {
    transform: scale(0.92);
  }
  .header-icon-btn:focus-visible, .header-avatar-btn:focus-visible, .theme-toggle-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .header-icon-btn.active, html[data-initial-tab="search"] #headerSearchBtn {
    background: var(--panel-strong);
    border-color: var(--accent);
    color: var(--accent);
  }
  .header-avatar-btn.signed-in {
    background: var(--accent);
    border-color: var(--accent);
    color: #ffffff;
  }
  .header-avatar-btn.signed-in:hover {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
    color: #ffffff;
  }
  .header-avatar-initial {
    font-size: 0.95rem;
    font-weight: 700;
    line-height: 1;
    text-transform: uppercase;
  }
  button.header-icon-btn, button.header-avatar-btn, button.theme-toggle-btn {
    padding: 0;
    min-height: unset;
  }
  .theme-toggle-btn, .dark-mode-toggle {
    width: 36px;
    height: 36px;
    min-width: 36px;
    min-height: 36px;
    box-sizing: border-box;
    border-radius: 50%;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    outline: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--text-2);
    cursor: pointer;
    box-shadow: var(--shadow-sm);
    padding: 0;
    position: relative;
    overflow: hidden;
    transition: background 0.2s ease, border-color 0.2s ease, transform 0.15s ease, box-shadow 0.2s ease, color 0.2s ease;
    user-select: none;
    -webkit-tap-highlight-color: transparent;
  }
  .theme-toggle-btn:hover, .dark-mode-toggle:hover {
    background: var(--panel-strong);
    border-color: var(--accent);
    color: var(--text);
    transform: scale(1.06);
    box-shadow: var(--shadow);
  }
  .theme-toggle-btn:active, .dark-mode-toggle:active {
    transform: scale(0.92);
  }
  .theme-toggle-btn .theme-icon-sun,
  .theme-toggle-btn .theme-icon-moon {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%) scale(1) rotate(0deg);
    transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.25s ease;
    pointer-events: none;
  }
  /* Light Mode default state: show moon, hide sun */
  .theme-toggle-btn .theme-icon-sun {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.4) rotate(90deg);
  }
  .theme-toggle-btn .theme-icon-moon {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1) rotate(0deg);
    color: var(--text-2);
  }
  /* Dark Mode state: show sun, hide moon */
  /* No color override here -- matches the Guide page's theme toggle
     (renderGuidePage, 24_client-backup-restore-presets.js), which never
     colors its sun icon and just inherits the button's own text color. */
  :root.dark-theme .theme-toggle-btn .theme-icon-sun,
  html.dark-theme .theme-toggle-btn .theme-icon-sun,
  body.dark-theme .theme-toggle-btn .theme-icon-sun {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1) rotate(0deg);
  }
  :root.dark-theme .theme-toggle-btn .theme-icon-moon,
  html.dark-theme .theme-toggle-btn .theme-icon-moon,
  body.dark-theme .theme-toggle-btn .theme-icon-moon {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.4) rotate(-90deg);
  }

  /* --- Top Tab Bar (Desktop View) ---------------------------------------------- */
  .tab-bar {
    display: flex; gap: 8px; overflow-x: auto; padding: 2px 0 6px;
    margin-bottom: 4px; -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .tab-bar::-webkit-scrollbar { display: none; }
  .tab-btn {
    flex: none;
    background: var(--surface);
    color: var(--text-2);
    border: 1.5px solid var(--border-strong);
    border-radius: var(--radius-pill);
    padding: 8px 16px;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    min-height: unset;
    transition: background 0.15s, color 0.15s, border-color 0.15s, box-shadow 0.15s;
    box-shadow: var(--shadow-sm);
  }
  .tab-btn.active {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
    box-shadow: 0 2px 10px rgba(0,122,255,0.30);
  }
  .tab-btn:hover:not(.active) { border-color: var(--accent); color: var(--accent); }
  .tab-panel { display: grid; gap: 14px; width: 100%; max-width: 100%; min-width: 0; }
  .tab-panel[hidden] { display: none; }
  /* Prevent FOUC: Show initial active tab and hide inactive ones before script execution */
  html[data-initial-tab] .tab-panel {
    display: none !important;
  }
  html[data-initial-tab="discover"] .tab-panel[data-tab-panel="discover"],
  html[data-initial-tab="catalogs"] .tab-panel[data-tab-panel="catalogs"],
  html[data-initial-tab="lists"] .tab-panel[data-tab-panel="lists"],
  html[data-initial-tab="channels"] .tab-panel[data-tab-panel="channels"],
  html[data-initial-tab="search"] .tab-panel[data-tab-panel="search"],
  html[data-initial-tab="settings"] .tab-panel[data-tab-panel="settings"],
  html[data-initial-tab="list-details"] .tab-panel[data-tab-panel="list-details"],
  html[data-initial-tab="item-details"] .tab-panel[data-tab-panel="item-details"] {
    display: grid !important;
  }
  html[data-initial-tab]:not([data-initial-tab="discover"]) .tab-btn[data-tab="discover"] {
    background: var(--surface) !important;
    color: var(--text-2) !important;
    border-color: var(--border-strong) !important;
    box-shadow: var(--shadow-sm) !important;
  }
  html[data-initial-tab]:not([data-initial-tab="discover"]) .bottom-nav-item[data-tab="discover"] {
    color: var(--muted) !important;
  }
  html[data-initial-tab="catalogs"] .tab-btn[data-tab="catalogs"],
  html[data-initial-tab="lists"] .tab-btn[data-tab="lists"],
  html[data-initial-tab="channels"] .tab-btn[data-tab="channels"],
  html[data-initial-tab="search"] .tab-btn[data-tab="search"],
  html[data-initial-tab="settings"] .tab-btn[data-tab="settings"] {
    background: var(--accent) !important;
    color: #fff !important;
    border-color: var(--accent) !important;
    box-shadow: 0 2px 10px rgba(0,122,255,0.30) !important;
  }
  html[data-initial-tab="catalogs"] .bottom-nav-item[data-tab="catalogs"],
  html[data-initial-tab="lists"] .bottom-nav-item[data-tab="lists"],
  html[data-initial-tab="channels"] .bottom-nav-item[data-tab="channels"],
  html[data-initial-tab="search"] .bottom-nav-item[data-tab="search"],
  html[data-initial-tab="settings"] .bottom-nav-item[data-tab="settings"] {
    color: var(--accent) !important;
  }

  /* --- Initial Subpanel & Subnav Styles (Zero FOUC on Refresh) --- */
  /* Catalogs */
  html[data-initial-catalogs-sub] #catalogsSubShelves,
  html[data-initial-catalogs-sub] #catalogsSubQuickAdd,
  html[data-initial-catalogs-sub] #catalogsSubBulk {
    display: none !important;
  }
  html[data-initial-catalogs-sub="all"] #catalogsSubShelves,
  html[data-initial-catalogs-sub="shelves"] #catalogsSubShelves {
    display: block !important;
  }
  html[data-initial-catalogs-sub="quickadd"] #catalogsSubQuickAdd {
    display: block !important;
  }
  html[data-initial-catalogs-sub="bulk"] #catalogsSubBulk {
    display: block !important;
  }
  html[data-initial-catalogs-sub] #catalogsFilterBar .subnav-pill {
    background: var(--surface) !important;
    color: var(--text-2) !important;
    border-color: var(--border-strong) !important;
    box-shadow: none !important;
  }
  html[data-initial-catalogs-sub] #catalogsFilterBar .subnav-pill .check-icon {
    display: none !important;
  }
  html[data-initial-catalogs-sub="all"] #catalogsFilterBar .subnav-pill[data-sub="all"],
  html[data-initial-catalogs-sub="shelves"] #catalogsFilterBar .subnav-pill[data-sub="all"],
  html[data-initial-catalogs-sub="quickadd"] #catalogsFilterBar .subnav-pill[data-sub="quickadd"],
  html[data-initial-catalogs-sub="bulk"] #catalogsFilterBar .subnav-pill[data-sub="bulk"] {
    background: rgba(0, 122, 255, 0.12) !important;
    color: var(--accent) !important;
    border-color: rgba(0, 122, 255, 0.40) !important;
    box-shadow: none !important;
  }

  /* Lists */
  html[data-initial-lists-sub] #listsSubMyLists,
  html[data-initial-lists-sub] #listsSubLiked,
  html[data-initial-lists-sub] #listsSubImport,
  html[data-initial-lists-sub] #listsSubCreateList {
    display: none !important;
  }
  html[data-initial-lists-sub="my-lists"] #listsSubMyLists {
    display: block !important;
  }
  html[data-initial-lists-sub="liked"] #listsSubLiked {
    display: block !important;
  }
  html[data-initial-lists-sub="import"] #listsSubImport {
    display: block !important;
  }
  html[data-initial-lists-sub="create-list"] #listsSubCreateList {
    display: block !important;
  }
  html[data-initial-lists-sub] #listsSubnavBar .subnav-pill {
    background: var(--surface) !important;
    color: var(--text-2) !important;
    border-color: var(--border-strong) !important;
    box-shadow: none !important;
  }
  html[data-initial-lists-sub] #listsSubnavBar .subnav-pill .check-icon {
    display: none !important;
  }
  html[data-initial-lists-sub="my-lists"] #listsSubnavBar .subnav-pill[data-sub="my-lists"],
  html[data-initial-lists-sub="liked"] #listsSubnavBar .subnav-pill[data-sub="liked"],
  html[data-initial-lists-sub="import"] #listsSubnavBar .subnav-pill[data-sub="import"],
  html[data-initial-lists-sub="bulk"] #listsSubnavBar .subnav-pill[data-sub="bulk"],
  html[data-initial-lists-sub="create-list"] #listsSubnavBar .subnav-pill[data-sub="create-list"] {
    background: rgba(0, 122, 255, 0.12) !important;
    color: var(--accent) !important;
    border-color: rgba(0, 122, 255, 0.40) !important;
    box-shadow: none !important;
  }

  /* Channels */
  html[data-initial-channels-sub] #channelsSubMyChannels,
  html[data-initial-channels-sub] #channelsSubStorylines,
  html[data-initial-channels-sub] #channelsSubQuickAdd,
  html[data-initial-channels-sub] #channelsSubImport,
  html[data-initial-channels-sub] #channelsSubBuild {
    display: none !important;
  }
  html[data-initial-channels-sub="my-channels"] #channelsSubMyChannels {
    display: block !important;
  }
  html[data-initial-channels-sub="storylines"] #channelsSubStorylines {
    display: block !important;
  }
  html[data-initial-channels-sub="quickadd"] #channelsSubQuickAdd {
    display: block !important;
  }
  html[data-initial-channels-sub="import"] #channelsSubImport {
    display: block !important;
  }
  html[data-initial-channels-sub] #channelsSubnavBar .subnav-pill {
    background: var(--surface) !important;
    color: var(--text-2) !important;
    border-color: var(--border-strong) !important;
    box-shadow: none !important;
  }
  html[data-initial-channels-sub] #channelsSubnavBar .subnav-pill .check-icon {
    display: none !important;
  }
  html[data-initial-channels-sub="my-channels"] #channelsSubnavBar .subnav-pill[data-sub="my-channels"],
  html[data-initial-channels-sub="storylines"] #channelsSubnavBar .subnav-pill[data-sub="storylines"],
  html[data-initial-channels-sub="quickadd"] #channelsSubnavBar .subnav-pill[data-sub="quickadd"],
  html[data-initial-channels-sub="import"] #channelsSubnavBar .subnav-pill[data-sub="import"] {
    background: rgba(0, 122, 255, 0.12) !important;
    color: var(--accent) !important;
    border-color: rgba(0, 122, 255, 0.40) !important;
    box-shadow: none !important;
  }

  /* Settings */
  html[data-initial-settings-sub] #settingsSubAccount,
  html[data-initial-settings-sub] #settingsSubDisplay,
  html[data-initial-settings-sub] #settingsSubScrobble,
  html[data-initial-settings-sub] #settingsSubExternal,
  html[data-initial-settings-sub] #settingsSubBackup,
  html[data-initial-settings-sub] #settingsSubFeedback {
    display: none !important;
  }
  html[data-initial-settings-sub="account"] #settingsSubAccount,
  html[data-initial-settings-sub="keys"] #settingsSubAccount {
    display: block !important;
  }
  html[data-initial-settings-sub="display"] #settingsSubDisplay {
    display: block !important;
  }
  html[data-initial-settings-sub="scrobble"] #settingsSubScrobble {
    display: block !important;
  }
  html[data-initial-settings-sub="external"] #settingsSubExternal {
    display: block !important;
  }
  html[data-initial-settings-sub="backup"] #settingsSubBackup {
    display: block !important;
  }
  html[data-initial-settings-sub="feedback"] #settingsSubFeedback {
    display: block !important;
  }
  html[data-initial-settings-sub] #settingsSubnavBar .subnav-pill {
    background: var(--surface) !important;
    color: var(--text-2) !important;
    border-color: var(--border-strong) !important;
    box-shadow: none !important;
  }
  html[data-initial-settings-sub] #settingsSubnavBar .subnav-pill .check-icon {
    display: none !important;
  }
  html[data-initial-settings-sub="account"] #settingsSubnavBar .subnav-pill[data-sub="account"],
  html[data-initial-settings-sub="keys"] #settingsSubnavBar .subnav-pill[data-sub="account"],
  html[data-initial-settings-sub="display"] #settingsSubnavBar .subnav-pill[data-sub="display"],
  html[data-initial-settings-sub="scrobble"] #settingsSubnavBar .subnav-pill[data-sub="scrobble"],
  html[data-initial-settings-sub="external"] #settingsSubnavBar .subnav-pill[data-sub="external"],
  html[data-initial-settings-sub="backup"] #settingsSubnavBar .subnav-pill[data-sub="backup"],
  html[data-initial-settings-sub="feedback"] #settingsSubnavBar .subnav-pill[data-sub="feedback"] {
    background: rgba(0, 122, 255, 0.12) !important;
    color: var(--accent) !important;
    border-color: rgba(0, 122, 255, 0.40) !important;
    box-shadow: none !important;
  }

  /* Discover */
  #discoverShelvesContainer {
    display: none !important;
  }
  html[data-initial-discover-sub="popular"] #discoverShelvesContainer,
  html[data-initial-discover-sub="popular"] #discoverListsFeedHeader,
  html[data-initial-discover-sub="popular"] #discoverListsFeed,
  html[data-initial-discover-sub="popular"] #discoverSubSharedFeed,
  html[data-initial-discover-sub="curated"] #discoverShelvesContainer,
  html[data-initial-discover-sub="curated"] #discoverListsFeedHeader,
  html[data-initial-discover-sub="curated"] #discoverListsFeed,
  html[data-initial-discover-sub="curated"] #discoverSubSharedFeed {
    display: none !important;
  }
  html[data-initial-discover-sub="popular"] #discoverSubPopular {
    display: block !important;
  }
  html[data-initial-discover-sub="curated"] #discoverSubCurated {
    display: block !important;
  }
  html[data-initial-discover-sub="all"] #discoverSubSharedFeed,
  html[data-initial-discover-sub="movie"] #discoverSubSharedFeed,
  html[data-initial-discover-sub="series"] #discoverSubSharedFeed,
  html[data-initial-discover-sub="gems"] #discoverSubSharedFeed,
  html[data-initial-discover-sub="kids"] #discoverSubSharedFeed,
  html[data-initial-discover-sub="holidays"] #discoverSubSharedFeed,
  html[data-initial-discover-sub="genres"] #discoverSubSharedFeed {
    display: block !important;
  }
  html[data-initial-discover-sub] #discoverSubnavBar .subnav-pill {
    background: var(--surface) !important;
    color: var(--text-2) !important;
    border-color: var(--border-strong) !important;
    box-shadow: none !important;
  }
  html[data-initial-discover-sub] #discoverSubnavBar .subnav-pill .check-icon {
    display: none !important;
  }
  html[data-initial-discover-sub="all"] #discoverSubnavBar .subnav-pill[data-sub="all"],
  html[data-initial-discover-sub="movie"] #discoverSubnavBar .subnav-pill[data-sub="movie"],
  html[data-initial-discover-sub="series"] #discoverSubnavBar .subnav-pill[data-sub="series"],
  html[data-initial-discover-sub="popular"] #discoverSubnavBar .subnav-pill[data-sub="popular"],
  html[data-initial-discover-sub="curated"] #discoverSubnavBar .subnav-pill[data-sub="curated"],
  html[data-initial-discover-sub="gems"] #discoverSubnavBar .subnav-pill[data-sub="gems"],
  html[data-initial-discover-sub="kids"] #discoverSubnavBar .subnav-pill[data-sub="kids"],
  html[data-initial-discover-sub="holidays"] #discoverSubnavBar .subnav-pill[data-sub="holidays"],
  html[data-initial-discover-sub="genres"] #discoverSubnavBar .subnav-pill[data-sub="genres"] {
    background: rgba(0, 122, 255, 0.12) !important;
    color: var(--accent) !important;
    border-color: rgba(0, 122, 255, 0.40) !important;
    box-shadow: none !important;
  }
  /* Each direct child of .tab-panel (the subnav pill bar, each
     .lists-subpanel) is a grid item and inherits the same default
     min-width:auto issue .tab-panel itself was already guarded against
     above -- setting min-width:0 on the parent only protects the parent,
     not these children individually. */
  .lists-subpanel { min-width: 0; }
  /* Same fix, same reason, for the Channels tab's subpanels (My Channels,
     Storylines & Universes, Quick Add, Import) -- without this, wide
     unwrapped content in any of them (e.g. the Storylines poster grid or
     a crossover-detection banner) could force the whole tab wider than
     the viewport on mobile instead of wrapping/scrolling within itself. */
  .channels-subpanel { width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box; }
  /* Same fix, same reason, for the item-details page's direct content
     wrapper -- it's a direct grid-item child of .tab-panel too, and
     without its own min-width:0 override, wide unwrapped content inside
     it (cast rows, provider/genre chip rows, etc.) could force the whole
     page past the viewport width on mobile, same as the two subpanels
     above. */
  #itemDetailsBody { width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box; }

  /* --- Item details: compact hero, metadata pills, genre chips, synopsis --- */
  #content-item-details { position: relative; }
  .item-back-btn {
    position: absolute; top: 12px; left: 12px; z-index: 3;
    padding: 6px 14px; min-height: unset;
    font-size: 0.9rem; font-weight: 600; font-family: inherit;
    color: #fff; background: rgba(0,0,0,0.45);
    border: 1px solid rgba(255,255,255,0.25);
    border-radius: var(--radius-pill);
    -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
    cursor: pointer; box-shadow: none;
  }
  .item-back-btn:hover { background: rgba(0,0,0,0.6); }
  .item-back-btn:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  .item-hero {
    position: relative; overflow: hidden; width: 100%;
    height: clamp(220px, 62vw, 360px);
    border-radius: var(--radius) var(--radius) 0 0;
    background: var(--panel-strong);
  }
  .item-hero-bg {
    position: absolute; inset: 0;
    width: 100%; height: 100%;
    object-fit: cover; object-position: center 20%;
  }
  .item-hero-shade {
    position: absolute; inset: 0;
    background: linear-gradient(to bottom, transparent 35%, var(--bg) 100%);
  }
  .item-head {
    display: flex; gap: 16px; align-items: flex-end;
    margin-top: calc(-1 * clamp(80px, 22vw, 130px));
    padding: 0 16px; position: relative; z-index: 1; min-width: 0;
  }
  .item-head-poster {
    flex: 0 0 auto; width: clamp(88px, 24vw, 140px);
    border-radius: var(--radius-sm); box-shadow: var(--shadow-md);
    border: 2px solid var(--bg); display: block;
  }
  .item-head-main { flex: 1 1 0; min-width: 0; padding-bottom: 4px; }
  .item-title {
    margin: 0 0 10px; font-size: clamp(1.4rem, 5vw, 2.2rem);
    font-family: serif; line-height: 1.15; overflow-wrap: anywhere;
  }
  .item-pills { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .item-pill {
    display: inline-flex; align-items: center; padding: 3px 10px;
    font-size: 0.82rem; font-weight: 600; white-space: nowrap;
    color: var(--text-2); background: var(--panel-strong);
    border: 1px solid var(--border-strong); border-radius: var(--radius-pill);
  }
  .item-pill-sep { color: var(--muted); font-size: 0.8rem; }
  .item-actions { display: flex; flex-wrap: wrap; gap: 10px; }
  .item-actions .lc-btn {
    flex: 1 1 160px; justify-content: center;
    padding: 10px 16px; font-size: 0.95rem;
  }
  .item-genres { display: flex; flex-wrap: wrap; gap: 8px; }
  .item-genre-chip {
    padding: 5px 14px; min-height: unset; font-size: 0.85rem; font-weight: 600; font-family: inherit;
    color: var(--text-2); background: var(--surface);
    border: 1.5px solid var(--border-strong); border-radius: var(--radius-pill);
    cursor: pointer; transition: background 0.12s, color 0.12s, border-color 0.12s;
  }
  .item-genre-chip:hover { color: var(--accent); border-color: var(--accent); }
  .item-genre-chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .item-synopsis {
    margin: 0; font-size: 1.05rem; line-height: 1.6; color: var(--text);
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3;
    line-clamp: 3; overflow: hidden;
  }
  .item-synopsis.is-expanded { display: block; -webkit-line-clamp: unset; line-clamp: unset; overflow: visible; }
  .item-synopsis-toggle {
    margin-top: 6px; padding: 0; min-height: unset; background: none; border: 0;
    color: var(--accent); font-size: 0.95rem; font-weight: 600;
    font-family: inherit; cursor: pointer;
  }
  .item-synopsis-toggle:hover { text-decoration: underline; }
  .item-synopsis-toggle[hidden] { display: none; }
  .item-synopsis-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  /* --- Bottom Nav (Mobile Only - Persistent Glassmorphism) ---------------- */
  .bottom-nav { display: none; }
  @media (max-width: 640px) {
    .tab-bar { display: none; }
    body { padding: calc(12px + env(safe-area-inset-top, 0px)) max(12px, env(safe-area-inset-right, 0px)) calc(96px + env(safe-area-inset-bottom, 0px)) max(12px, env(safe-area-inset-left, 0px)); }
    .bottom-nav {
      display: flex;
      position: fixed !important;
      bottom: 0 !important;
      left: 0 !important;
      right: 0 !important;
      z-index: 9999 !important;
      background: rgba(255,255,255,0.94);
      -webkit-backdrop-filter: saturate(180%) blur(20px);
      backdrop-filter: saturate(180%) blur(20px);
      border-top: 1px solid var(--border);
      padding: 6px 0 calc(6px + env(safe-area-inset-bottom));
      box-shadow: 0 -1px 0 rgba(0,0,0,0.08), 0 -4px 16px rgba(0,0,0,0.05);
    }
    :root.dark-theme .bottom-nav, html.dark-theme .bottom-nav, body.dark-theme .bottom-nav {
      background: rgba(0,0,0,0.94) !important;
      border-top: 1px solid var(--border) !important;
      box-shadow: 0 -1px 0 rgba(255,255,255,0.08), 0 -4px 16px rgba(0,0,0,0.6) !important;
    }
    .bottom-nav-item {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 3px;
      padding: 4px 1px;
      min-height: 62px;
      background: transparent !important;
      border: none !important;
      border-radius: 0 !important;
      box-shadow: none !important;
      color: var(--muted);
      font-size: 0.78rem;
      font-weight: 600;
      letter-spacing: 0.01em;
      cursor: pointer;
      transition: color 0.12s ease;
      white-space: nowrap;
      /* flex items default to min-width:auto, so with nowrap these six
         cannot shrink below their own text and the last one overflows the
         viewport -- measured at 320px, 'Settings' ran to x=344 and rendered
         as 'Settin'. This lets them shrink; the narrow-width rule below
         keeps the labels readable rather than merely clipped. */
      min-width: 0;
      line-height: 1.1;
    }
    .bottom-nav-item svg {
      width: 28.5px; height: 28.5px; flex: none;
      transition: transform 0.12s ease;
      stroke-width: 1.8;
    }
    .bottom-nav-item.active { color: var(--accent); }
    .bottom-nav-item.active svg { transform: translateY(-1px); stroke-width: 2.2; }
    .bottom-nav-item:active { opacity: 0.6; }
  }

  /* Six labels across a 320px screen (iPhone SE 1st gen, Galaxy Fold cover).
     At 0.78rem the widest of them does not fit in its 53px share, so the type
     comes down a step and the letter-spacing goes to zero rather than the word
     being cut in half. */
  @media (max-width: 360px) {
    .bottom-nav-item {
      font-size: 0.68rem;
      letter-spacing: 0;
      padding: 4px 0;
    }
    .bottom-nav-item svg { width: 25px; height: 25px; }
  }

  .live-preview-poster-card.dragging {
    opacity: 0.55 !important;
    transform: scale(1.05) !important;
    box-shadow: 0 10px 25px rgba(0,0,0,0.4) !important;
    z-index: 100 !important;
    pointer-events: none !important;
  }

  /* --- Segmented Top Submenus (Matching Screenshot 3) --------------------- */
  .subnav-pills-bar {
    display: flex;
    gap: 8px;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
    touch-action: pan-x;
    padding: 4px 16px 8px 4px;
    align-items: center;
    box-sizing: border-box;
  }
  .subnav-pills-bar::-webkit-scrollbar { display: none; }
  .subnav-pill {
    flex: none;
    flex-shrink: 0;
    padding: 5px 14px;
    min-height: 31px;
    border-radius: var(--radius-pill);
    border: 1.5px solid var(--color-border-strong);
    background: var(--color-bg-surface);
    color: var(--color-text-secondary);
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
    box-shadow: none;
    font-family: inherit;
  }
  .subnav-pill.active {
    background: rgba(0, 122, 255, 0.12);
    color: var(--accent);
    border-color: rgba(0, 122, 255, 0.40);
    box-shadow: none;
    font-weight: 700;
  }
  :root.dark-theme .subnav-pill.active {
    background: rgba(10, 132, 255, 0.22);
    color: var(--accent);
    border-color: rgba(10, 132, 255, 0.50);
  }
  .subnav-pill:hover:not(.active) {
    border-color: rgba(0, 122, 255, 0.40);
    color: var(--accent);
  }
  .subnav-pill .check-icon {
    font-weight: 800;
    font-size: 0.82rem;
    color: var(--accent);
  }

  /* --- Search Tab Toolbar & Filter Selects ------------------------------- */
  .search-filters-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-top: 10px;
  }
  .search-filter-select {
    flex: none;
    width: auto;
    min-width: 105px;
    font-size: 0.82rem;
    padding: 5px 24px 5px 10px;
    background: var(--surface);
    color: var(--text);
    border: 1.5px solid var(--border-strong);
    border-radius: var(--radius-pill);
    min-height: 31px;
    height: 31px;
    cursor: pointer;
    box-shadow: none;
  }
  .search-input-wrapper {
    position: relative;
    display: flex;
    align-items: center;
    width: 100%;
  }
  .search-input-box {
    position: relative;
    width: 100%;
    flex: 1;
    display: flex;
    align-items: center;
  }
  .search-input-box input {
    width: 100%;
    box-sizing: border-box;
  }
  .search-input-icon {
    position: absolute;
    left: 14px;
    color: var(--muted);
    pointer-events: none;
    z-index: 2;
  }
  .search-clear-btn {
    display: none;
    position: absolute;
    right: 12px;
    width: 22px;
    height: 22px;
    min-height: 22px !important;
    max-height: 22px !important;
    padding: 0 !important;
    margin: 0 !important;
    border: none !important;
    border-radius: 50% !important;
    background: transparent !important;
    box-shadow: none !important;
    color: var(--muted);
    opacity: 0.55;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    z-index: 2;
    transition: opacity 0.15s ease, color 0.15s ease, transform 0.12s ease;
  }
  .search-clear-btn:hover {
    opacity: 1;
    color: var(--text);
    background: transparent !important;
    border: none !important;
    transform: scale(1.12);
  }
  .search-clear-btn:active {
    transform: scale(0.92);
    opacity: 0.75;
  }
  .search-clear-btn:focus-visible {
    outline: 2px solid var(--color-brand);
    outline-offset: 2px;
  }

  /* --- Streaming Providers Chips Bar (Discover Tab) ----------------------- */
  .provider-bar {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
    padding: 4px 0 8px;
  }
  .provider-bar::-webkit-scrollbar { display: none; }
  .provider-chip {
    flex: none;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 13px;
    border-radius: var(--radius-pill);
    background: var(--surface);
    border: 1.5px solid var(--border);
    color: var(--text);
    font-size: 0.82rem;
    font-weight: 700;
    cursor: pointer;
    box-shadow: var(--shadow-sm);
    white-space: nowrap;
    transition: transform 0.12s, border-color 0.12s, box-shadow 0.12s;
  }
  .provider-chip:hover {
    transform: translateY(-1px);
    box-shadow: var(--shadow);
    border-color: var(--accent);
  }
  .provider-chip-icon {
    width: 20px;
    height: 20px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 900;
    font-size: 0.72rem;
    color: #fff;
    flex: none;
  }
  .provider-chip-icon.netflix { background: #E50914; }
  .provider-chip-icon.prime   { background: #00A8E1; }
  .provider-chip-icon.apple   { background: #000000; color: #FFFFFF; }
  .provider-chip-icon.disney  { background: #113CCF; }
  .provider-chip-icon.max     { background: #5B00C5; }
  .provider-chip-icon.hulu    { background: #1CE783; color: #000; }
  .provider-chip-icon.paramount { background: #0064FF; }
  .provider-chip-icon.peacock { background: #000000; color: #FFFFFF; }
  .provider-chip-icon.discovery { background: #002244; }
  .provider-chip-icon.kids { background: #FF9900; }
  /* --- Discover Chart Cards & Quick Grids -------------------------------- */
  .quick-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 10px;
    width: 100%;
  }
  @media (min-width: 641px) {
    .quick-grid {
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    }
  }
  .discover-chart-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 12px;
    box-shadow: var(--shadow-sm);
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 10px;
    transition: transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
  }
  .discover-chart-card:hover {
    box-shadow: var(--shadow);
    border-color: var(--border-strong);
    transform: translateY(-2px);
  }
  .discover-chart-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    min-height: 38px;
  }
  .discover-chart-info {
    flex: 1;
    min-width: 0;
  }
  .discover-chart-title {
    font-weight: 700;
    font-size: 0.90rem;
    color: var(--text);
    line-height: 1.25;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    white-space: normal;
    word-break: break-word;
  }
  .discover-chart-seeall {
    flex-shrink: 0;
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--accent);
    text-decoration: none;
    white-space: nowrap;
    padding: 2px 0;
    margin-top: 1px;
    align-self: flex-start;
  }
  .discover-chart-seeall:hover {
    text-decoration: underline;
  }
  .discover-chart-btns {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .discover-chart-btns .lc-btn {
    flex: 1;
    justify-content: center;
    font-size: 0.78rem;
    font-weight: 600;
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    transition: all 0.15s ease;
  }
  .discover-chart-btns .lc-btn:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--panel-strong);
  }

  /* --- Shelves & Horizontal Poster Strips (Discover Tab) ------------------- */
  .shelf-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 8px;
  }

  /* Catalogs -> Quick Add sits each section in its own card, the way
     Channels -> Quick Add already did. Composed onto .panel rather than
     restating the surface/border/radius/shadow, so the two cannot drift:
     .panel supplies the card, this supplies only what a shelf inside one
     needs. The larger gap is because these are now separate cards rather
     than headings on one continuous background -- at 8px they read as one
     block with lines through it. */
  .qa-shelf-card {
    margin-bottom: 16px;
    gap: 0;
  }
  .qa-shelf-card .shelf-header {
    align-items: center;
  }
  .qa-add-all-btn {
    font-size: 0.80rem !important;
    font-weight: 600 !important;
    padding: 4px 12px !important;
    border-radius: var(--radius-pill) !important;
    color: var(--accent) !important;
    border: 1.5px solid var(--border-strong) !important;
    background: var(--surface) !important;
    box-shadow: var(--shadow-sm) !important;
    transition: all 0.15s ease;
  }
  .qa-add-all-btn:hover:not(:disabled) {
    background: var(--color-brand-subtle) !important;
    border-color: var(--accent) !important;
    color: var(--accent-hover) !important;
  }
  /* The line under a Quick Add card's title. Shared with Channels -> Quick
     Add, which is where the pattern comes from -- one class so a change to
     one is a change to both. */
  .qa-shelf-sub {
    margin: 0 0 12px;
    padding: 0 2px;
    color: var(--muted);
    font-size: 0.85rem;
    line-height: 1.45;
  }
  /* Catalogs -> Bulk Import Subpanel */
  #catalogsSubBulk .bulk-panel {
    max-width: 860px;
    margin-top: 0;
  }
  .bulk-provider-badges {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    margin: 0 0 14px;
    padding: 0 2px;
  }
  .bulk-provider-label {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--muted);
    margin-right: 2px;
  }
  #bulkPasteBox {
    min-height: 140px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 0.88rem;
    line-height: 1.6;
    resize: vertical;
    box-sizing: border-box;
  }
  .bulk-actions-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
    margin-top: 14px;
  }
  .bulk-actions-left {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  #bulkDetectedCount {
    font-size: 0.82rem;
    color: var(--muted);
    font-weight: 500;
  }
  .shelf-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    /* Some shelf headers (e.g. Live Preview & Editor's title + 4 action
       buttons) have more content than fits on one line on a phone --
       without wrapping, that row forces the whole card (and everything
       else sharing its grid track) wider than the viewport. */
    flex-wrap: wrap;
    row-gap: 8px;
    padding: 0 2px;
  }
  .shelf-title {
    min-width: 0;
    font-size: 1.08rem;
    font-weight: 700;
    color: var(--text);
    margin: 0;
    letter-spacing: -0.015em;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border-width: 0;
  }
  #discoverListsFeedHeader,
  #discoverSubPopular .shelf-header,
  #discoverSubCurated .shelf-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
    padding: 0 2px;
    min-height: 32px;
  }
  #discoverListsFeedDesc,
  #discoverSubPopular .shelf-header p,
  #discoverSubCurated .shelf-header p {
    margin: 0;
    color: var(--muted);
    font-size: 0.84rem;
    line-height: 1.4;
    flex: 1;
    min-width: 0;
  }
  .discover-refresh-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 11px;
    font-size: 0.8rem;
    font-weight: 600;
    min-height: 28px;
    border-radius: var(--radius-pill);
    flex-shrink: 0;
    cursor: pointer;
  }
  .see-all-link {
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--accent);
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px 0;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  .see-all-link:hover { opacity: 0.75; }
  .shelf-scroll-wrap {
    display: flex;
    gap: 10px;
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
    padding: 4px 2px 8px;
    width: 100%;
    max-width: 100%;
  }
  .shelf-scroll-wrap::-webkit-scrollbar { display: none; }

  /* --- Poster Cards (Wako Design) ----------------------------------------- */
  .poster-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 105px;
    flex: none;
    cursor: pointer;
    position: relative;
  }
  @media (min-width: 641px) {
    .poster-card {
      width: 125px;
    }
  }
  .poster-card.grid-item {
    width: 100%;
  }
  .poster-image-wrap {
    width: 100%;
    aspect-ratio: 2 / 3;
    position: relative;
    border-radius: 9px;
    overflow: hidden;
    background: var(--panel-strong);
    box-shadow: var(--shadow-sm);
    border: 1px solid var(--border);
  }
  .poster-image {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .rating-badge {
    position: absolute;
    top: 6px;
    left: 6px;
    padding: 2px 5px;
    border-radius: 5px;
    font-size: 0.68rem;
    font-weight: 800;
    color: #fff;
    line-height: 1.15;
    box-shadow: 0 1px 4px rgba(0,0,0,0.4);
    letter-spacing: -0.01em;
    background: #48484A;
  }
  .rating-badge.rating-high { background: var(--rating-high); }
  .rating-badge.rating-mid  { background: var(--rating-mid); }
  .rating-badge.rating-low  { background: var(--rating-low); }

  .poster-provider-badge {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 16px;
    height: 16px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.6rem;
    font-weight: 900;
    color: #fff;
  }
  .poster-title {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--text);
    line-height: 1.25;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    margin: 0;
  }
  .poster-meta {
    font-size: 0.7rem;
    color: var(--muted);
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 4px;
    line-height: 1;
  }

  /* --- 3-Column / 9-Column Poster Grid (Global Standard) ------------------ */
  .poster-grid-3, .live-preview-modal-grid, #detailGrid, #listPreviewGrid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px 8px;
    width: 100%;
    /* #detailGrid (the "See All" list-details view -- see the /#/list?
       route) is a direct grid-item child of .tab-panel, same as
       .lists-subpanel, .channels-subpanel and #itemDetailsBody, all of
       which needed this same explicit min-width: 0 override before
       (.tab-panel's own min-width: 0 only protects .tab-panel itself from
       its parent -- it doesn't cascade to what each child contributes
       back to .tab-panel's own grid track sizing). Missing it here let a
       newly added, not-yet-through-the-usual-flow catalog's poster grid
       force .tab-panel's track wider than the viewport on mobile instead
       of every poster staying capped at its own column. */
    min-width: 0;
  }
  @media (min-width: 641px) {
    .poster-grid-3, .live-preview-modal-grid, #detailGrid, #listPreviewGrid {
      grid-template-columns: repeat(9, 1fr);
      gap: 12px 8px;
    }
  }

  /* --- Channel Accordions & Grid ------------------------------------------- */
  .channel-card-section {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
    margin-bottom: 14px;
    box-shadow: var(--shadow-sm);
  }
  .channel-accordion {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 14px;
    box-shadow: var(--shadow-sm);
    overflow: hidden;
  }
  .channel-accordion summary {
    padding: 12px 16px;
    font-weight: 700;
    font-size: 0.92rem;
    cursor: pointer;
    user-select: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--surface);
    color: var(--text);
    outline: none;
  }
  .channel-accordion summary::-webkit-details-marker {
    display: none;
  }
  .channel-accordion summary::after {
    content: '\u25be';
    font-size: 1rem;
    color: var(--muted);
    transition: transform 0.2s ease;
  }
  .channel-accordion[open] summary::after {
    transform: rotate(180deg);
  }
  .channel-accordion[open] summary {
    border-bottom: 1px solid var(--border);
  }
  .channel-accordion-body {
    padding: 14px 16px;
  }
  .channel-quick-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    gap: 8px;
  }
  .channel-season-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
    margin-top: 8px;
  }
  /* --- Channel broadcast schedule, Story Lock & the Quick Channel wizard -- */
  .channel-rule-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 0.85rem;
    cursor: pointer;
    user-select: none;
    line-height: 1.35;
  }
  .channel-rule-row input[type="checkbox"] {
    margin: 2px 0 0;
    flex: 0 0 auto;
  }
  .channel-dial {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.8rem;
    color: var(--muted);
    white-space: nowrap;
  }
  .channel-dial input,
  .channel-dial select {
    width: auto;
    min-width: 76px;
    font-size: 0.82rem;
    padding: 5px 8px;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  /* Rearranging My Channels. The handle itself is .drag-handle-list, the
     same one a list card uses; this is only what marks the card in flight. */
  .list-card.dragging {
    opacity: 0.55;
    outline: 2px dashed var(--accent);
    outline-offset: 2px;
  }
  .channel-pick-selected {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 8px;
  }
  .channel-pick-selected img {
    opacity: 0.72;
  }
  .channel-storylock-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    gap: 6px 12px;
    margin-top: 6px;
  }
  .channel-wizard-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    gap: 10px;
    margin-bottom: 10px;
  }
  .channel-wizard-grid label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.8rem;
    font-weight: 600;
  }
  .channel-wizard-grid select {
    font-size: 0.85rem;
    padding: 6px 10px;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  @media (min-width: 641px) {
    .channel-season-grid {
      grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    }
  }

  /* --- Wako List Cards Feed (Lists Tab - Matching Screenshot 3) ------------ */
  .list-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-sm);
    padding: 13px 13px 11px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    transition: box-shadow: 0.15s;
    margin-bottom: 10px;
    width: 100%;
    max-width: 100%;
    overflow: hidden;
    box-sizing: border-box;
    min-width: 0;
  }
  .list-card:hover { box-shadow: var(--shadow); }
  .list-card-header {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    min-width: 0;
  }
  .list-card-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .list-card-title {
    font-weight: 700; font-size: 0.96rem; color: var(--text);
    margin: 0 0 2px; line-height: 1.3;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    cursor: pointer;
  }
  .list-card-title:hover {
    color: var(--accent);
  }
  .list-card-meta {
    font-size: 0.76rem; color: var(--muted);
    display: flex; flex-wrap: wrap; gap: 0 5px; align-items: center;
    line-height: 1.4;
  }
  .list-card-meta-sep { color: var(--border-strong); }
  .list-source-badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 6px;
    font-size: 0.68rem;
    font-weight: 700;
    border-radius: 4px;
    letter-spacing: 0.3px;
    line-height: 1.2;
    margin-right: 4px;
    vertical-align: middle;
    background: var(--surface-2, rgba(255,255,255,0.06));
    border: 1px solid var(--border);
    color: var(--text-2);
  }
  .list-source-badge.badge-mdblist { background: rgba(52,199,89,0.12); color: #34c759; border-color: rgba(52,199,89,0.3); }
  .list-source-badge.badge-trakt { background: rgba(255,59,48,0.12); color: #ff3b30; border-color: rgba(255,59,48,0.3); }
  .list-source-badge.badge-tmdb { background: rgba(90,200,250,0.12); color: #5ac8fa; border-color: rgba(90,200,250,0.3); }
  .list-source-badge.badge-simkl { background: rgba(0,122,255,0.12); color: #007aff; border-color: rgba(0,122,255,0.3); }
  .list-source-badge.badge-mylists, .list-source-badge.badge-profile { background: rgba(175,82,222,0.12); color: #af52de; border-color: rgba(175,82,222,0.3); }
  .list-source-badge.badge-streaming { background: rgba(255,149,0,0.12); color: #ff9500; border-color: rgba(255,149,0,0.3); }
  .list-source-badge.badge-imdb { background: rgba(245,197,24,0.12); color: #b8860b; border-color: rgba(245,197,24,0.3); }
  :root.dark-theme .list-source-badge.badge-imdb { color: #f5c518; }
  .list-source-badge.badge-autotrack {
    background: var(--surface-2, rgba(255,255,255,0.06));
    color: var(--muted);
    border-color: var(--border);
  }
  .list-card-actions {
    display: flex; gap: 5px; align-items: center; flex-shrink: 0; flex-wrap: wrap;
  }
  .list-card-actions :is(.localListAddToConfigBtn, .creatorListAddToConfigBtn, .channelAddBtn, .curatedAddBtn, .searchAddBtn, .list-search-add-btn, .myListAddBtn):not(:first-child) {
    margin-left: 6px;
  }
  .lc-btn,
  button.lc-btn,
  .actions button.lc-btn {
    padding: 6px 12px !important;
    min-height: unset !important;
    height: auto !important;
    font-size: var(--font-size-xs, 0.8rem) !important;
    font-weight: 600;
    border-radius: var(--radius-pill);
    border: 1.5px solid var(--color-border-strong);
    background: var(--color-bg-surface);
    color: var(--color-text-secondary);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-family: inherit;
    white-space: nowrap;
    transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
  }
  .lc-btn:active:not(:disabled) { transform: scale(0.98); }
  .lc-btn.primary,
  button.lc-btn.primary,
  .actions button.lc-btn.primary {
    background: var(--color-brand);
    color: var(--color-text-inverse, #fff);
    border-color: var(--color-brand);
    box-shadow: 0 2px 6px var(--color-brand-subtle);
    padding: 6px 12px !important;
    min-height: unset !important;
    height: auto !important;
  }
  .lc-btn.primary:hover:not(:disabled) {
    background: var(--color-brand-hover);
    border-color: var(--color-brand-hover);
  }
  .lc-btn:disabled { opacity: 0.5; cursor: not-allowed; pointer-events: none; }
  .lc-btn.secondary {
    background: var(--color-bg-surface);
    color: var(--color-text-secondary);
    border: 1.5px solid var(--color-border-strong);
    box-shadow: var(--shadow-sm);
    padding: 6px 12px;
    min-height: unset;
  }
  .lc-btn.secondary:hover:not(:disabled) {
    background: var(--color-bg-sunken);
    color: var(--color-text-primary);
  }
  .lc-btn.liked {
    color: var(--color-danger);
    border-color: rgba(255,59,48,0.4);
    background: var(--color-danger-subtle);
  }
  /* --- Soft Brand-Tinted Add/Remove Action Buttons (one shared selector list) --- */
  :is(.localListAddToConfigBtn, .creatorListAddToConfigBtn, .myListAddBtn, .searchAddBtn, .curatedAddBtn, .curated-add-btn, .list-search-add-btn, .channelAddBtn, .customListAddBtn, #detailAddBtn):not(.is-added):not(:disabled) {
    background: rgba(0, 122, 255, 0.08) !important;
    border-color: rgba(0, 122, 255, 0.35) !important;
    color: var(--accent) !important;
    box-shadow: 0 1px 3px rgba(0, 122, 255, 0.08);
  }
  :root.dark-theme :is(.localListAddToConfigBtn, .creatorListAddToConfigBtn, .myListAddBtn, .searchAddBtn, .curatedAddBtn, .curated-add-btn, .list-search-add-btn, .channelAddBtn, .customListAddBtn, #detailAddBtn):not(.is-added):not(:disabled) {
    background: rgba(10, 132, 255, 0.14) !important;
    border-color: rgba(10, 132, 255, 0.4) !important;
    color: var(--accent) !important;
  }
  :is(.localListAddToConfigBtn, .creatorListAddToConfigBtn, .myListAddBtn, .searchAddBtn, .curatedAddBtn, .curated-add-btn, .list-search-add-btn, .channelAddBtn, .customListAddBtn, #detailAddBtn):not(.is-added):hover:not(:disabled) {
    background: rgba(0, 122, 255, 0.16) !important;
    border-color: var(--accent) !important;
    color: var(--accent) !important;
  }
  :root.dark-theme :is(.localListAddToConfigBtn, .creatorListAddToConfigBtn, .myListAddBtn, .searchAddBtn, .curatedAddBtn, .curated-add-btn, .list-search-add-btn, .channelAddBtn, .customListAddBtn, #detailAddBtn):not(.is-added):hover:not(:disabled) {
    background: rgba(10, 132, 255, 0.24) !important;
    border-color: var(--accent) !important;
    color: var(--accent) !important;
  }
  :is(.localListAddToConfigBtn, .creatorListAddToConfigBtn, .myListAddBtn, .searchAddBtn, .curatedAddBtn, .curated-add-btn, .list-search-add-btn, .channelAddBtn, .customListAddBtn, #detailAddBtn):not(.is-added):active:not(:disabled) {
    transform: scale(0.97);
    background: rgba(0, 122, 255, 0.22) !important;
  }
  :is(.localListAddToConfigBtn, .creatorListAddToConfigBtn, .myListAddBtn, .searchAddBtn, .curatedAddBtn, .curated-add-btn, .list-search-add-btn, .channelAddBtn, #detailAddBtn).is-added {
    color: var(--color-danger, #d70015) !important;
    background: rgba(255, 59, 48, 0.08) !important;
    border-color: rgba(255, 59, 48, 0.35) !important;
    box-shadow: 0 1px 3px rgba(255, 59, 48, 0.08);
  }
  :root.dark-theme :is(.localListAddToConfigBtn, .creatorListAddToConfigBtn, .myListAddBtn, .searchAddBtn, .curatedAddBtn, .curated-add-btn, .list-search-add-btn, .channelAddBtn, #detailAddBtn).is-added {
    color: var(--color-danger, #ff453a) !important;
    background: rgba(255, 69, 58, 0.15) !important;
    border-color: rgba(255, 69, 58, 0.4) !important;
  }
  :is(.localListAddToConfigBtn, .creatorListAddToConfigBtn, .myListAddBtn, .searchAddBtn, .curatedAddBtn, .curated-add-btn, .list-search-add-btn, .channelAddBtn, #detailAddBtn).is-added:hover:not(:disabled) {
    background: rgba(255, 59, 48, 0.16) !important;
    border-color: var(--danger) !important;
    color: var(--danger) !important;
  }
  :root.dark-theme :is(.localListAddToConfigBtn, .creatorListAddToConfigBtn, .myListAddBtn, .searchAddBtn, .curatedAddBtn, .curated-add-btn, .list-search-add-btn, .channelAddBtn, #detailAddBtn).is-added:hover:not(:disabled) {
    background: rgba(255, 69, 58, 0.24) !important;
    border-color: var(--danger) !important;
    color: var(--danger) !important;
  }
  :is(.localListAddToConfigBtn, .creatorListAddToConfigBtn, .myListAddBtn, .searchAddBtn, .curatedAddBtn, .curated-add-btn, .list-search-add-btn, .channelAddBtn, #detailAddBtn).is-added:active:not(:disabled) {
    transform: scale(0.97);
    background: rgba(255, 59, 48, 0.22) !important;
  }
  .lc-btn.view-btn {
    color: var(--color-brand);
    border-color: transparent;
    background: transparent;
    padding: 0;
    font-size: 0.82rem;
    min-height: unset;
  }
  .lc-btn.searchLikeExternalBtn,
  .lc-btn.searchLikeBtn,
  #detailLikeBtn {
    padding: 6px 10px;
    min-width: 32px;
    min-height: unset;
    justify-content: center;
    background: var(--color-bg-surface);
    color: var(--color-text-secondary);
    border: 1.5px solid var(--color-border-strong);
    box-shadow: none;
    font-size: 0.95rem;
    line-height: 1;
  }
  .lc-btn.searchLikeExternalBtn:hover:not(:disabled),
  .lc-btn.searchLikeBtn:hover:not(:disabled),
  #detailLikeBtn:hover:not(:disabled) {
    background: var(--color-bg-sunken);
    color: var(--color-text-primary);
  }
  .lc-btn.searchLikeExternalBtn.liked,
  .lc-btn.searchLikeBtn.liked,
  #detailLikeBtn.liked {
    color: var(--color-danger);
    border-color: rgba(255,59,48,0.4);
    background: var(--color-danger-subtle);
  }

  /* --- Presets & Backup Layout & Unified Sizing ---------------- */
  .preset-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 12px 14px;
    margin-bottom: 8px;
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    box-shadow: var(--shadow-sm);
    position: relative;
  }
  .preset-card:has(.preset-overflow-menu[open]) {
    z-index: 50;
  }
  .preset-card-header {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1 1 auto;
  }
  .preset-card-title {
    font-weight: 700;
    font-size: 0.92rem;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .preset-actions-cluster {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    position: relative;
  }
  .preset-overflow-menu {
    position: relative;
    display: inline-block;
  }
  .preset-overflow-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border-radius: var(--radius-pill);
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    cursor: pointer;
    user-select: none;
    list-style: none;
    font-size: 1.15rem;
    line-height: 1;
    transition: background-color 0.12s ease, border-color 0.12s ease;
  }
  .preset-overflow-btn::-webkit-details-marker {
    display: none;
  }
  .preset-overflow-btn:hover {
    background: var(--color-bg-sunken, rgba(255, 255, 255, 0.06));
    border-color: var(--color-border-strong, var(--border));
  }
  .preset-overflow-menu[open] .preset-overflow-btn {
    background: var(--color-bg-sunken, rgba(255, 255, 255, 0.08));
    border-color: var(--color-brand, var(--accent));
  }
  .preset-overflow-dropdown {
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    z-index: 100;
    min-width: 175px;
    background: var(--color-bg-elevated, var(--surface-1, #1e1e24));
    border: 1px solid var(--color-border-strong, var(--border));
    border-radius: var(--radius-sm, 8px);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .preset-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--text);
    background: none;
    border: none;
    border-radius: var(--radius-xs, 4px);
    text-align: left;
    cursor: pointer;
    box-sizing: border-box;
    transition: background-color 0.12s ease;
    white-space: nowrap;
  }
  .preset-menu-item:hover {
    background: var(--color-bg-sunken, rgba(255, 255, 255, 0.06));
  }
  .preset-menu-divider {
    height: 1px;
    background: var(--border);
    margin: 3px 0;
  }
  .preset-actions-grid, .backup-actions-grid, .export-actions-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 6px;
    width: 100%;
  }
  .backup-quick-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 12px;
    margin-bottom: 12px;
  }
  .backup-advanced-disclosure {
    border: 1px solid var(--border);
    border-radius: var(--radius-md, 10px);
    background: var(--surface-1, rgba(255, 255, 255, 0.02));
    overflow: hidden;
    transition: border-color 0.15s ease;
  }
  .backup-advanced-disclosure[open] {
    border-color: var(--color-border-strong, var(--border));
  }
  .backup-advanced-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    cursor: pointer;
    user-select: none;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--muted);
    list-style: none;
  }
  .backup-advanced-summary::-webkit-details-marker {
    display: none;
  }
  .backup-advanced-summary:hover {
    color: var(--text);
    background: rgba(255, 255, 255, 0.03);
  }
  .backup-advanced-disclosure[open] .backup-advanced-arrow {
    transform: rotate(180deg);
  }
  .backup-advanced-arrow {
    transition: transform 0.15s ease;
    font-size: 0.8rem;
    display: inline-block;
  }
  @media (min-width: 641px) {
    .preset-actions-grid {
      display: flex;
      gap: 6px;
      width: auto;
    }
    .backup-actions-grid, .export-actions-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      width: auto;
    }
  }
  @media (max-width: 480px) {
    .preset-card {
      flex-direction: column;
      align-items: stretch;
      gap: 8px;
    }
    .preset-actions-cluster {
      justify-content: flex-end;
    }
  }
  #settingsSubBackup .lc-btn,
  #settingsSubBackup .preset-actions-grid button,
  #settingsSubBackup .backup-actions-grid button,
  #settingsSubBackup .export-actions-grid button,
  #settingsSubBackup .row button {
    padding: 6px 14px;
    font-size: 0.82rem;
    font-weight: 600;
    min-height: 34px;
    border-radius: var(--radius-pill);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    box-sizing: border-box;
    white-space: nowrap;
  }

  /* --- Settings Subpanels & Key Display Mobile Responsiveness ------------- */
  .settings-subpanel {
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
    overflow-x: hidden;
  }
  .creator-key-display {
    font-family: var(--font-mono, monospace);
    font-size: 0.88rem;
    font-weight: 600;
    color: var(--text);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    word-break: break-all;
    overflow-wrap: anywhere;
    white-space: normal;
    user-select: all;
    -webkit-user-select: all;
    max-width: 100%;
    box-sizing: border-box;
    letter-spacing: 0.5px;
    margin: 4px 0 10px;
  }
  .account-key-group {
    display: flex;
    align-items: stretch;
    gap: 8px;
    margin: 4px 0 6px;
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
  }
  .account-key-group .creator-key-display {
    flex: 1 1 auto;
    margin: 0;
    display: flex;
    align-items: center;
    min-height: 40px;
    padding: 8px 12px;
  }
  .account-key-actions {
    display: flex;
    gap: 6px;
    align-items: stretch;
    flex-shrink: 0;
  }
  .account-key-actions .lc-btn {
    padding: 0 14px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 0.84rem;
    font-weight: 600;
    white-space: nowrap;
    min-height: 40px;
  }
  @media (max-width: 520px) {
    .account-key-group {
      flex-direction: column;
    }
    .account-key-actions {
      width: 100%;
    }
    .account-key-actions .lc-btn {
      flex: 1;
    }
  }

  .danger-zone-disclosure {
    margin-top: 16px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md, 10px);
    background: var(--surface-1, rgba(255, 255, 255, 0.02));
    overflow: hidden;
    transition: border-color 0.15s ease;
  }
  .danger-zone-disclosure[open] {
    border-color: rgba(255, 59, 48, 0.3);
  }
  .danger-zone-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    cursor: pointer;
    user-select: none;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--muted);
    list-style: none;
  }
  .danger-zone-summary::-webkit-details-marker {
    display: none;
  }
  .danger-zone-summary:hover {
    color: var(--text);
    background: rgba(255, 255, 255, 0.03);
  }
  .danger-zone-disclosure[open] .danger-zone-arrow {
    transform: rotate(180deg);
  }
  .danger-zone-arrow {
    transition: transform 0.15s ease;
    font-size: 0.8rem;
    display: inline-block;
  }
  .danger-zone-content {
    padding: 0 14px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .webhook-input-group {
    display: flex;
    gap: 8px;
    align-items: stretch;
    margin-bottom: 10px;
    flex-wrap: wrap;
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
  }
  .webhook-input-group input {
    flex: 1 1 200px;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
  }
  .webhook-input-group button {
    flex: none;
    white-space: nowrap;
  }
  @media (max-width: 640px) {
    .webhook-input-group {
      flex-direction: column;
    }
    .webhook-input-group input,
    .webhook-input-group button {
      width: 100% !important;
      flex: 1 1 100% !important;
    }
  }

  /* 9-Poster Preview Strip in List Cards (Desktop) / 3-Poster (Mobile) */
  .list-card-posters, .list-card-5posters {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    margin-top: 4px;
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
  }
  @media (max-width: 640px) {
    .list-card-posters .list-card-mini-poster:nth-child(n+4),
    .list-card-5posters .list-card-mini-poster:nth-child(n+4),
    .list-card-posters .list-card-mini-poster-tile:nth-child(n+4),
    .list-card-5posters .list-card-mini-poster-tile:nth-child(n+4) {
      display: none;
    }
    .shelf-header {
      flex-direction: column !important;
      align-items: stretch !important;
      gap: 8px !important;
    }
    .shelf-header > div {
      width: 100%;
      min-width: 0;
    }
    .list-card-header {
      display: flex !important;
      flex-direction: column !important;
      align-items: stretch !important;
      gap: 8px !important;
    }
    .list-card-body {
      width: 100%;
      min-width: 0;
    }
    .list-card-actions {
      width: 100%;
      margin-top: 0;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
      flex-wrap: wrap;
    }
    .list-card-actions .lc-btn {
      padding: 5px 9px !important;
      font-size: 0.78rem !important;
      line-height: 1.2;
      min-height: 28px !important;
      box-sizing: border-box;
      white-space: nowrap;
    }
    .list-card-title {
      white-space: normal;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      word-break: break-word;
      line-height: 1.25;
    }
    .customizeListBtn {
      padding: 5px 8px !important;
      min-width: 28px !important;
      justify-content: center;
    }
    .customizeListBtn .customize-btn-text {
      display: none !important;
    }
    .drag-handle-list {
      margin-right: 8px;
      padding: 2px 4px;
    }
  }
  @media (min-width: 641px) {
    .list-card-posters, .list-card-5posters {
      grid-template-columns: repeat(9, 1fr);
      gap: 6px;
    }
  }
  /* loadPosterSlot's failure state (19_client-search-and-likes.js) -- a
     one-line message and a Retry button in place of the poster grid, so a
     card that could not be fetched (even after its own automatic retry)
     says so instead of just sitting there blank. */
  .list-card-posters.poster-preview-error,
  .list-card-posters.poster-preview-empty {
    display: flex;
    grid-template-columns: none;
  }
  .poster-preview-error-msg,
  .poster-preview-empty-msg {
    margin: 0;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    color: var(--muted);
    font-size: 0.85rem;
  }
  .list-card-mini-poster {
    aspect-ratio: 2 / 3;
    border-radius: 6px;
    overflow: hidden;
    background: var(--panel-strong);
    border: 1px solid var(--border);
    position: relative;
    width: 100%;
  }
  .list-card-mini-poster img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    transition: transform 0.2s;
  }
  /* Same 9/3-across grid cell as .list-card-mini-poster above, but with a
     name (and optional second-line subtitle, e.g. an episode's "S07E10")
     visible underneath instead of only on hover -- used on the "Your
     Custom Lists" dashboard, where a bare grid of unlabeled thumbnails
     doesn't say which item is which. Kept as a separate class rather than
     changing .list-card-mini-poster itself, since that class is also used
     for the Find Lists search-preview thumbnails, which don't have room
     for a label and rely on the "+" / count overlays sitting flush over
     the full aspect-ratio box. */
  .list-card-mini-poster-tile {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 100%;
    min-width: 0;
  }
  .list-card-mini-poster-img-wrap {
    aspect-ratio: 2 / 3;
    border-radius: 6px;
    overflow: hidden;
    background: var(--panel-strong);
    border: 1px solid var(--border);
    position: relative;
    width: 100%;
  }
  .storyline-posters-scroll {
    display: flex !important;
    flex-direction: row !important;
    gap: 12px !important;
    overflow-x: auto !important;
    overflow-y: hidden !important;
    -webkit-overflow-scrolling: touch !important;
    touch-action: pan-x !important;
    width: 100% !important;
    max-width: 100% !important;
    min-width: 0 !important;
    box-sizing: border-box !important;
    padding: 8px 2px 10px !important;
    scrollbar-width: thin !important;
  }
  .storyline-poster-item {
    display: flex !important;
    flex-direction: column !important;
    flex: 0 0 105px !important;
    width: 105px !important;
    max-width: 105px !important;
    min-width: 105px !important;
    box-sizing: border-box !important;
    text-align: center !important;
  }
  .item-storylines-section {
    border-top: 1px solid var(--border);
    padding-top: 24px;
    margin-top: 32px;
  }
  .item-storyline-block {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
    margin-bottom: 16px;
  }
  .item-storyline-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }
  .item-storyline-header-info {
    flex: 1;
    min-width: 240px;
  }
  .item-storyline-saga-title {
    font-size: 1.15rem;
    font-weight: 700;
    color: var(--text);
    margin-bottom: 4px;
  }
  .item-storyline-saga-meta {
    font-size: 0.82rem;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    margin-bottom: 6px;
  }
  .item-storyline-saga-desc {
    font-size: 0.85rem;
    color: var(--text-2);
    line-height: 1.45;
    margin: 4px 0 0;
  }
  .item-storyline-header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }
  .item-storyline-scroll {
    display: flex !important;
    flex-direction: row !important;
    gap: 14px !important;
    overflow-x: auto !important;
    overflow-y: hidden !important;
    -webkit-overflow-scrolling: touch !important;
    touch-action: pan-x !important;
    padding: 10px 4px 14px !important;
    margin-top: 8px;
  }
  .item-storyline-card {
    display: flex;
    flex-direction: column;
    flex: 0 0 120px;
    width: 120px;
    max-width: 120px;
    min-width: 120px;
    cursor: pointer;
    text-align: left;
    transition: transform 0.15s ease;
  }
  .item-storyline-card:hover {
    transform: translateY(-2px);
  }
  .item-storyline-card.is-current {
    cursor: default;
    transform: none !important;
  }
  .item-storyline-poster-wrap {
    position: relative;
    aspect-ratio: 2 / 3;
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--panel-strong);
    border: 1px solid var(--border);
    margin-bottom: 8px;
    transition: border-color 0.2s, box-shadow 0.2s;
  }
  .item-storyline-card:hover .item-storyline-poster-wrap {
    border-color: var(--border-strong);
  }
  .item-storyline-card.is-current .item-storyline-poster-wrap {
    border: 2px solid var(--accent);
    box-shadow: 0 0 10px rgba(0, 122, 255, 0.4);
  }
  .item-storyline-poster-wrap img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .item-storyline-part-badge {
    position: absolute;
    top: 6px;
    left: 6px;
    background: rgba(0, 0, 0, 0.75);
    color: #FFFFFF;
    font-size: 0.68rem;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: var(--radius-pill);
    letter-spacing: 0.02em;
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    z-index: 2;
  }
  .item-storyline-current-pill {
    position: absolute;
    bottom: 6px;
    left: 6px;
    right: 6px;
    background: var(--accent);
    color: #FFFFFF;
    font-size: 0.7rem;
    font-weight: 700;
    text-align: center;
    padding: 3px 0;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    z-index: 2;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
  }
  .item-storyline-watched-badge {
    position: absolute;
    top: 6px;
    right: 6px;
    background: var(--accent);
    color: #FFFFFF;
    font-size: 0.75rem;
    font-weight: 800;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
    z-index: 2;
  }
  .item-storyline-title {
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--text);
    line-height: 1.25;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    margin-bottom: 2px;
  }
  .item-storyline-card.is-current .item-storyline-title {
    color: var(--accent);
  }
  .item-storyline-meta {
    font-size: 0.72rem;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cw-remove-btn {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 24px;
    height: 24px;
    min-width: 24px;
    min-height: 24px;
    box-sizing: border-box;
    border-radius: 50%;
    background: rgba(15, 23, 42, 0.75);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    border: 1px solid rgba(255, 255, 255, 0.22);
    color: #fff;
    outline: none;
    -webkit-appearance: none;
    -moz-appearance: none;
    appearance: none;
    font-size: 14px;
    font-weight: bold;
    box-shadow: 0 2px 4px rgba(0,0,0,0.35);
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    cursor: pointer;
    z-index: 10;
    transition: opacity 0.15s ease, background-color 0.15s ease, border-color 0.15s ease, transform 0.15s ease;
  }
  .cw-remove-btn:hover,
  .cw-remove-btn:active {
    background: var(--danger);
    border-color: var(--danger);
    color: #fff;
  }
  .cw-remove-btn::after {
    content: '';
    position: absolute;
    top: -10px;
    bottom: -10px;
    left: -10px;
    right: -10px;
  }
  @media (hover: hover) and (pointer: fine) {
    .list-card-mini-poster-tile .cw-remove-btn,
    .channel-pick-item .cw-remove-btn,
    .custom-list-pick-item .cw-remove-btn,
    .item-card .cw-remove-btn {
      opacity: 0;
      transform: scale(0.88);
    }
    .list-card-mini-poster-tile:hover .cw-remove-btn,
    .list-card-mini-poster-tile:focus-within .cw-remove-btn,
    .channel-pick-item:hover .cw-remove-btn,
    .channel-pick-item:focus-within .cw-remove-btn,
    .custom-list-pick-item:hover .cw-remove-btn,
    .custom-list-pick-item:focus-within .cw-remove-btn,
    .item-card:hover .cw-remove-btn,
    .item-card:focus-within .cw-remove-btn {
      opacity: 1;
      transform: scale(1);
    }
  }
  #lists .cw-remove-btn,
  .live-preview-shelf-row .cw-remove-btn,
  .live-preview-posters .cw-remove-btn {
    display: none !important;
  }
  .cw-date-badge {
    position: absolute;
    top: 4px;
    left: 4px;
    background: var(--accent);
    color: #ffffff;
    font-size: 0.62rem;
    font-weight: 800;
    padding: 2px 5px;
    border-radius: var(--radius-sm);
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.45);
    line-height: 1.15;
    letter-spacing: -0.01em;
    z-index: 8;
    pointer-events: none;
    white-space: nowrap;
    text-transform: uppercase;
  }
  /* The hour under the day, inside the same pill -- a second line rather than
     a longer one, because these sit on a poster barely 100px wide. */
  .cw-date-badge-timed {
    text-align: center;
    max-width: calc(100% - 8px);
  }
  .cw-date-badge-time {
    display: block;
    font-weight: 700;
    font-size: 0.95em;
    opacity: 0.92;
  }
  .cw-date-badge-premiere {
    background: #2fa84f;
    top: auto;
    bottom: 4px;
    left: 50%;
    transform: translateX(-50%);
    max-width: calc(100% - 8px);
    text-overflow: ellipsis;
    overflow: hidden;
  }
  .cw-date-badge-finale {
    background: var(--warn, #FF9500);
    top: auto;
    bottom: 4px;
    left: 50%;
    transform: translateX(-50%);
    max-width: calc(100% - 8px);
    text-overflow: ellipsis;
    overflow: hidden;
  }
  .cw-date-badge-finale-date {
    background: rgba(20, 20, 24, 0.92);
    color: #ffd166;
    border: 1px solid rgba(255, 149, 0, 0.35);
    top: auto;
    bottom: 4px;
    left: 50%;
    transform: translateX(-50%);
    max-width: calc(100% - 8px);
    text-overflow: ellipsis;
    overflow: hidden;
    font-size: 0.58rem;
    font-weight: 700;
  }
  .cw-date-badge-companion {
    background: var(--accent, #6366f1);
    color: #ffffff;
    top: auto;
    bottom: 4px;
    left: 50%;
    transform: translateX(-50%);
    max-width: calc(100% - 8px);
    text-overflow: ellipsis;
    overflow: hidden;
  }
  .episode-num-badge {
    position: absolute;
    bottom: 4px;
    left: 4px;
    background: var(--accent);
    color: #ffffff;
    padding: 2px 6px;
    border-radius: 4px;
    font-weight: bold;
    font-size: 0.8rem;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
    z-index: 2;
  }
  body.hide-badge-air-date .cw-date-badge:not(.cw-date-badge-premiere):not(.cw-date-badge-finale):not(.cw-date-badge-finale-date):not(.cw-date-badge-companion) { display: none !important; }
  body.hide-badge-season-premiere .cw-date-badge-premiere { display: none !important; }
  body.hide-badge-season-finale .cw-date-badge-finale { display: none !important; }
  body.hide-badge-season-finale-date .cw-date-badge-finale-date { display: none !important; }
  body.hide-badge-rating .rating-badge, body.hide-badge-rating .poster-rating { display: none !important; }
  body.hide-badge-imdb-rating .rating-badge[data-rating-type="imdb"], body.hide-badge-imdb-rating .poster-rating[data-rating-type="imdb"] { display: none !important; }
  body.hide-badge-tmdb-rating .rating-badge[data-rating-type="tmdb"], body.hide-badge-tmdb-rating .poster-rating[data-rating-type="tmdb"] { display: none !important; }
  .live-preview-posters .rating-badge, .live-preview-shelf-row .rating-badge,
  .live-preview-posters .poster-rating, .live-preview-shelf-row .poster-rating { display: none !important; }
  body.hide-badge-watched .watched-badge, body.hide-badge-watched .cw-watched-indicator { display: none !important; }
  body.hide-catalogs-badges .live-preview-posters:not(.is-continue-watching-shelf):not(.is-airing-next-shelf):not(.is-watchlist-shelf) .cw-date-badge,
  body.hide-catalogs-badges .live-preview-shelf-row:not([data-list-slug="continue-watching"]):not([data-list-slug="airing-next"]):not([data-list-slug="watchlist"]) .cw-date-badge,
  body.hide-catalogs-badges #catalogsTab .live-preview-shelf-row:not([data-list-slug="continue-watching"]):not([data-list-slug="airing-next"]):not([data-list-slug="watchlist"]) .cw-date-badge,
  body.hide-catalogs-badges .live-preview-posters:not(.is-continue-watching-shelf):not(.is-airing-next-shelf):not(.is-watchlist-shelf) .rating-badge,
  body.hide-catalogs-badges .live-preview-posters:not(.is-continue-watching-shelf):not(.is-airing-next-shelf):not(.is-watchlist-shelf) .watched-badge { display: none !important; }
  body.hide-airing-next-badges #myPrivateTraktListsResult .cw-date-badge,
  body.hide-airing-next-badges #mySimklListsResult .cw-date-badge,
  body.hide-airing-next-badges #myMdblistListsResult .cw-date-badge,
  body.hide-airing-next-badges [data-list-key="airing-next"] .cw-date-badge,
  body.hide-airing-next-badges .airing-next-card .cw-date-badge,
  body.hide-airing-next-badges .live-preview-shelf-row[data-list-slug="airing-next"] .cw-date-badge,
  body.hide-airing-next-badges .live-preview-posters.is-airing-next-shelf .cw-date-badge { display: none !important; }
  body.hide-watchlist-badges [data-list-key="watchlist"] .cw-date-badge,
  body.hide-watchlist-badges .watchlist-card .cw-date-badge,
  body.hide-watchlist-badges .live-preview-shelf-row[data-list-slug="watchlist"] .cw-date-badge,
  body.hide-watchlist-badges .live-preview-posters.is-watchlist-shelf .cw-date-badge { display: none !important; }
  body.hide-continue-watching-badges [data-list-key="continue-watching"] .cw-date-badge,
  body.hide-continue-watching-badges .continue-watching-card .cw-date-badge,
  body.hide-continue-watching-badges .live-preview-shelf-row[data-list-slug="continue-watching"] .cw-date-badge,
  body.hide-continue-watching-badges .live-preview-posters.is-continue-watching-shelf .cw-date-badge,
  body.hide-trakt-continue-watching-badges #myPrivateTraktListsResult .trakt-continue-watching-tile .cw-date-badge,
  body.hide-trakt-continue-watching-badges .detail-page-trakt-continue-watching .cw-date-badge,
  body.hide-mdblist-up-next-badges #myMdblistListsResult .mdblist-up-next-tile .cw-date-badge,
  body.hide-mdblist-up-next-badges .detail-page-mdblist-up-next .cw-date-badge { display: none !important; }
  .airing-next-filter-pills {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .airingNextFilterPill {
    background: var(--panel-strong);
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 0.7rem;
    font-weight: 600;
    padding: 3px 9px;
    cursor: pointer;
    white-space: nowrap;
  }
  .airingNextFilterPill.active {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }
  .list-card-mini-poster-img-wrap img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    transition: transform 0.2s;
  }
  .list-card-mini-poster-img-wrap img.clickable-poster:hover {
    transform: scale(1.05);
  }
  .list-card-mini-poster-name {
    font-size: 0.68rem;
    color: var(--text);
    font-weight: 600;
    line-height: 1.25;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
    min-height: 2.5em;
  }
  .list-card-mini-poster-subtitle {
    font-size: 0.64rem;
    color: var(--muted);
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .list-card-mini-poster-year {
    font-size: 0.64rem;
    color: var(--muted);
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .clickable-poster {
    cursor: pointer;
  }
  .clickable-poster:hover img {
    transform: scale(1.05);
  }
  .poster-add-overlay {
    position: absolute;
    bottom: 4px;
    right: 4px;
    background: rgba(0, 0, 0, 0.7);
    color: #fff;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    font-weight: bold;
    opacity: 0.85;
    transition: opacity 0.2s, background 0.2s;
    z-index: 5;
    cursor: pointer;
  }
  .clickable-poster:hover .poster-add-overlay,
  .live-preview-poster-card:hover .poster-add-overlay {
    opacity: 1;
  }
  .poster-add-overlay:hover {
    background: var(--brand);
    color: #fff;
  }
  #lists .poster-add-overlay,
  #listsLivePreview .poster-add-overlay,
  .entry .poster-add-overlay {
    display: none !important;
  }
  .drag-handle-list {
    cursor: grab;
    user-select: none;
    touch-action: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 1.1rem;
    color: var(--muted);
    margin-right: 12px;
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    transition: color 0.15s, background-color 0.15s;
    vertical-align: middle;
  }
  .drag-handle-list svg,
  .shelf-drag-handle svg,
  .drag-handle svg {
    display: block;
    pointer-events: none;
    flex-shrink: 0;
  }
  .drag-handle-list:hover {
    color: var(--text);
    background: var(--panel-strong);
  }
  .drag-handle-list:active {
    cursor: grabbing;
  }
  .list-card-count-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0,0,0,0.65);
    color: #fff;
    font-weight: 700;
    font-size: 0.8rem;
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(1px);
  }
  .list-card-count-overlay.mobile-only {
    display: flex;
  }
  .list-card-count-overlay.desktop-only {
    display: none;
  }
  @media (min-width: 641px) {
    .list-card-count-overlay.mobile-only {
      display: none;
    }
    .list-card-count-overlay.desktop-only {
      display: flex;
    }
  }

  /* --- Merged Channels Chips & Inline Add Selector ------------------------ */
  .merge-chip-remove-btn {
    background: transparent !important;
    border: none !important;
    color: var(--muted) !important;
    font-size: 0.95rem !important;
    font-weight: 700 !important;
    line-height: 1 !important;
    cursor: pointer !important;
    padding: 0 0 0 4px !important;
    margin: 0 !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    transition: color 0.15s !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    width: auto !important;
    height: auto !important;
  }
  .merge-chip-remove-btn:hover {
    color: var(--danger) !important;
  }
  .merge-add-channel-select {
    padding: 3px 8px;
    font-size: 0.78rem;
    font-weight: 600;
    border-radius: var(--radius-sm);
    border: 1px dashed var(--border);
    background: var(--surface);
    color: var(--accent);
    cursor: pointer;
    max-width: 220px;
    outline: none;
    transition: border-color 0.15s, color 0.15s;
    margin: 2px 0 2px 4px;
  }
  .merge-add-channel-select:hover {
    border-color: var(--accent);
  }
  .detail-filter-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
    padding: 0 0 16px 0;
    margin-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }
  .detail-sort-select {
    padding: 6px 28px 6px 12px;
    font-size: 0.82rem;
    font-weight: 600;
    border-radius: var(--radius-pill);
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    cursor: pointer;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
    appearance: none;
    -webkit-appearance: none;
    -moz-appearance: none;
    background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%238e8e93' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e");
    background-repeat: no-repeat;
    background-position: right 8px center;
    background-size: 14px;
  }
  .detail-sort-select:hover, .detail-sort-select:focus {
    border-color: var(--accent);
  }

  /* --- Cards & Panels ---------------------------------------------------- */
  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-sm);
    padding: 16px;
    width: 100%;
    max-width: 100%;
    overflow: visible;
  }
  .panel-title {
    font-size: 1.1rem;
    font-weight: 700;
    margin: 0 0 10px;
    letter-spacing: -0.01em;
    color: var(--text);
  }

  /* --- Search Bar Wrap (Screenshot 4) ------------------------------------- */
  .search-bar-wrap {
    position: relative; display: flex; align-items: center; width: 100%;
  }
  .search-bar-wrap .sb-icon {
    position: absolute; left: 14px;
    width: 18px; height: 18px; color: var(--muted);
    pointer-events: none; flex: none;
  }
  .search-bar-wrap input {
    padding-left: 42px; padding-right: 40px;
    border-radius: var(--radius-pill);
    background: var(--surface);
    border: 1.5px solid var(--border-strong);
    font-size: 0.95rem;
    box-shadow: var(--shadow-sm);
  }
  .search-bar-clear {
    position: absolute; right: 10px;
    width: 22px; height: 22px; min-height: unset;
    border-radius: 50%; background: rgba(0,0,0,0.12);
    color: var(--text-2); border: none; padding: 0;
    font-size: 0.75rem; line-height: 1;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
  }

  /* --- Form controls & Helpers -------------------------------------------- */
  input, select, textarea {
    width: 100%;
    padding: 11px 14px;
    border-radius: var(--radius-sm);
    border: 1.5px solid var(--border-strong);
    background: var(--surface);
    color: var(--text);
    outline: none;
    font-size: 16px;
    font-family: inherit;
    min-height: 44px;
    box-shadow: var(--shadow-sm);
    transition: border-color 0.15s ease, box-shadow 0.15s ease, background-color 0.15s ease;
  }
  input:disabled, select:disabled, textarea:disabled,
  input[readonly], textarea[readonly] {
    background: var(--surface-2);
    border-color: var(--border);
    color: var(--muted);
    box-shadow: none;
    cursor: default;
  }
  input:disabled, select:disabled, textarea:disabled {
    cursor: not-allowed;
    opacity: 0.7;
  }
  input::placeholder, textarea::placeholder {
    color: var(--muted);
    opacity: 0.65;
  }
  input[type="file"] {
    padding: 0;
    min-height: unset;
    border: none;
    background: transparent;
    color: var(--text-2);
  }
  input[type="file"]::file-selector-button {
    background: var(--surface-2);
    color: var(--text);
    border: 1.5px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 8px 14px;
    margin-right: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  input[type="file"]::file-selector-button:hover {
    background: var(--surface-3);
    border-color: var(--text-2);
  }
  input[type="checkbox"], input[type="radio"] {
    width: 20px; height: 20px; min-height: unset;
    padding: 0; flex: none; accent-color: var(--accent);
  }
  
  /* Toggle Switch */
  .ui-toggle {
    position: relative; display: inline-block; width: 44px; height: 24px; flex: none; vertical-align: middle;
  }
  .ui-toggle input { opacity: 0; width: 0; height: 0; position: absolute; pointer-events: none; }
  .ui-toggle-slider {
    position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0;
    background-color: var(--color-border-strong, var(--border)); transition: background-color .25s ease; border-radius: 24px;
  }
  .ui-toggle-slider:before {
    position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px;
    background-color: white; transition: transform .25s cubic-bezier(0.4, 0, 0.2, 1); border-radius: 50%; box-shadow: var(--shadow-sm);
  }
  .ui-toggle input:checked + .ui-toggle-slider { background-color: var(--color-brand, var(--accent)); }
  .ui-toggle input:checked + .ui-toggle-slider:before { transform: translateX(20px); }
  .ui-toggle input:focus-visible + .ui-toggle-slider { outline: 2px solid var(--color-brand, var(--accent)); outline-offset: 2px; }

  /* Settings Components: Toggles & Checklists */
  .settings-toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    padding: 10px 0;
    border-bottom: 1px solid var(--color-border-subtle, rgba(255,255,255,0.06));
  }
  .settings-toggle-row:last-child {
    border-bottom: none;
  }
  .settings-check-group {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .settings-check-group.two-col-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px 16px;
  }
  @media (max-width: 720px) {
    .settings-check-group.two-col-grid {
      grid-template-columns: 1fr;
    }
  }
  .settings-check-item {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 8px 10px;
    border-radius: var(--radius-sm, 8px);
    cursor: pointer;
    user-select: none;
    transition: background-color 0.12s ease;
    margin: 0;
  }
  .settings-check-item:hover {
    background: var(--color-bg-sunken, rgba(255,255,255,0.03));
  }
  .settings-check-item input[type="checkbox"] {
    width: 17px;
    height: 17px;
    margin-top: 2px;
    cursor: pointer;
    flex: none;
    accent-color: var(--color-brand, var(--accent));
  }
  input:focus, select:focus, textarea:focus {
    border-color: var(--color-brand, var(--accent));
    box-shadow: 0 0 0 3px var(--color-brand-subtle, rgba(0, 122, 255, 0.18));
  }
  input[readonly]:focus, textarea[readonly]:focus {
    border-color: var(--border-strong);
    box-shadow: none;
  }
  .custom-list-pick-poster {
    width: 36px; height: 54px; object-fit: cover; border-radius: 4px; flex: none; cursor: pointer;
  }
  .custom-list-pick-poster.empty-poster { background: transparent; }
  .channel-poster-choice {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    border-radius: 8px;
    padding: 6px;
    cursor: pointer;
    background: var(--surface);
    border: 2px solid transparent;
    transition: border-color 0.15s ease, transform 0.15s ease;
    user-select: none;
  }
  .channel-poster-choice:hover {
    border-color: rgba(0, 122, 255, 0.4);
  }
  .channel-poster-choice.selected {
    border-color: var(--accent);
    background: rgba(0, 122, 255, 0.08);
  }
  .channel-poster-choice .channel-poster-thumb-wrap {
    position: relative;
    width: 100%;
    aspect-ratio: 2 / 3;
    border-radius: 6px;
    overflow: hidden;
    background: rgba(0, 0, 0, 0.3);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .channel-poster-choice .channel-poster-thumb-wrap img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .channel-poster-choice .channel-poster-check {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--accent);
    color: #fff;
    font-size: 0.75rem;
    font-weight: 700;
    display: none;
    align-items: center;
    justify-content: center;
    box-shadow: 0 1px 4px rgba(0,0,0,0.5);
    z-index: 2;
  }
  .channel-poster-choice.selected .channel-poster-check {
    display: flex;
  }
  .channel-poster-choice .channel-poster-title {
    width: 100%;
    font-size: 0.75rem;
    font-weight: 600;
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-top: 5px;
  }
  .channel-poster-choice .channel-poster-meta {
    font-size: 0.7rem;
    color: var(--muted);
    text-align: center;
  }
  .channel-crossover-banner {
    position: relative;
    background: linear-gradient(135deg, rgba(0, 122, 255, 0.12) 0%, rgba(88, 86, 214, 0.12) 100%);
    border: 1px solid rgba(0, 122, 255, 0.35);
    border-radius: var(--radius-md);
    padding: 12px 14px;
    margin-bottom: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .channel-crossover-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }
  .channel-crossover-title {
    font-size: 0.88rem;
    font-weight: 700;
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .channel-crossover-badge {
    background: var(--accent);
    color: #fff;
    font-size: 0.68rem;
    font-weight: 700;
    padding: 2px 7px;
    border-radius: var(--radius-pill);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .channel-crossover-desc {
    font-size: 0.8rem;
    color: var(--muted);
    line-height: 1.35;
    margin: 0;
  }
  .channel-crossover-parts {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 4px 0 2px;
  }
  .channel-crossover-chip {
    font-size: 0.72rem;
    padding: 3px 8px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .channel-crossover-chip.present {
    background: rgba(52, 199, 89, 0.15);
    border-color: rgba(52, 199, 89, 0.4);
    color: #34C759;
  }
  .channel-crossover-chip.missing {
    background: rgba(255, 149, 0, 0.15);
    border-color: rgba(255, 149, 0, 0.4);
    color: #FF9500;
  }
  .channel-crossover-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 2px;
    flex-wrap: wrap;
  }
  /* .lc-btn's base white-space:nowrap (further up this stylesheet) is
     correct for the short, fixed labels it's normally used with ("Copy
     Key", "Reset Key", etc.), but the button here can carry a long,
     dynamic label ("+ Add 15 Missing Crossover Episodes in Story Order")
     -- nowrap forced it to render as one unbroken line wider than the
     viewport on mobile instead of wrapping. Scoped to just this button so
     every other .lc-btn usage keeps its normal nowrap behavior. */
  .channel-crossover-actions .lc-btn {
    white-space: normal;
    text-align: center;
    max-width: 100%;
  }
  /* Support & Feedback Chat */
  .support-chat-container {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 10px;
  }
  .support-threads-bar {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding-bottom: 4px;
  }
  .support-thread-pill {
    padding: 6px 12px;
    border-radius: var(--radius-pill);
    background: var(--surface);
    border: 1px solid var(--border);
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text);
  }
  .support-thread-pill.active {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }
  .support-messages-stream {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-height: 380px;
    min-height: 180px;
    overflow-y: auto;
    padding: 12px;
    background: rgba(0, 0, 0, 0.2);
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
  }
  .support-bubble {
    max-width: 85%;
    padding: 10px 14px;
    border-radius: 14px;
    font-size: 0.88rem;
    line-height: 1.4;
    word-break: break-word;
    white-space: pre-wrap;
  }
  .support-bubble.user {
    align-self: flex-end;
    background: var(--accent);
    color: #fff;
    border-bottom-right-radius: 4px;
  }
  .support-bubble.admin {
    align-self: flex-start;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border-strong);
    border-bottom-left-radius: 4px;
  }
  .support-bubble-sender {
    font-size: 0.72rem;
    font-weight: 700;
    margin-bottom: 4px;
    display: flex;
    align-items: center;
    gap: 6px;
    opacity: 0.85;
  }
  .support-bubble-time {
    font-size: 0.68rem;
    opacity: 0.65;
    margin-top: 4px;
    text-align: right;
  }
  .support-reply-composer {
    display: flex;
    gap: 8px;
    align-items: flex-end;
  }
  .support-reply-composer textarea {
    flex: 1;
    min-height: 44px;
    max-height: 120px;
    padding: 10px 12px;
    border-radius: 12px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    font-family: inherit;
    font-size: 0.88rem;
    resize: vertical;
  }
  .row { display: flex; flex-direction: column; align-items: stretch; gap: 10px; margin-bottom: 10px; width: 100%; }
  .field-row { display: grid; grid-template-columns: 1fr; gap: 10px; width: 100%; }
  /* ==========================================================================
     Design System: Standard Button Architecture (Phase 2)
     ========================================================================== */

  /* Base button reset & common layout */
  .btn,
  button,
  .actions a {
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-1-5, 6px);
    font-family: inherit;
    font-size: var(--font-size-base, 0.925rem);
    font-weight: 600;
    line-height: 1.2;
    text-align: center;
    text-decoration: none;
    white-space: nowrap;
    border-radius: var(--radius-pill);
    border: 1.5px solid transparent;
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
    vertical-align: middle;
    transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease,
                box-shadow 0.15s ease, transform 0.1s ease, opacity 0.15s ease;
  }

  /* Default button behavior (Primary brand style) */
  :where(button:not(.secondary, .btn-secondary, .btn-ghost, .btn-danger, .btn-tertiary, .bottom-nav-item, .lc-btn, .tab-btn, .subnav-pill, .header-icon-btn, .header-avatar-btn, .theme-toggle-btn, .modal-close-x, .cw-remove-btn, .ec-btn, .item-back-btn, .view-btn, .text-action-btn, .search-clear-btn)),
  .btn-primary,
  .primary:not(.lc-btn) {
    background: var(--color-brand);
    color: var(--color-text-inverse, #fff);
    border-color: var(--color-brand);
    box-shadow: 0 2px 8px var(--color-brand-subtle);
    min-height: var(--control-height-md, 40px);
    padding: 10px 18px;
  }

  :where(button:not(.secondary, .btn-secondary, .btn-ghost, .btn-danger, .btn-tertiary, .bottom-nav-item, .lc-btn, .tab-btn, .subnav-pill, .header-icon-btn, .header-avatar-btn, .theme-toggle-btn, .modal-close-x, .cw-remove-btn, .ec-btn, .item-back-btn, .view-btn, .text-action-btn, .search-clear-btn)):hover:not(:disabled),
  .btn-primary:hover:not(:disabled),
  .primary:not(.lc-btn):hover:not(:disabled) {
    background: var(--color-brand-hover);
    border-color: var(--color-brand-hover);
    color: var(--color-text-inverse, #fff);
  }

  :where(button:not(.secondary, .btn-secondary, .btn-ghost, .btn-danger, .btn-tertiary, .bottom-nav-item, .lc-btn, .tab-btn, .subnav-pill, .header-icon-btn, .header-avatar-btn, .theme-toggle-btn, .modal-close-x, .cw-remove-btn, .ec-btn, .item-back-btn, .view-btn, .text-action-btn, .search-clear-btn)):active:not(:disabled),
  .btn-primary:active:not(:disabled),
  .primary:not(.lc-btn):active:not(:disabled) {
    background: var(--color-brand-active);
    border-color: var(--color-brand-active);
    transform: scale(0.98);
  }

  /* Search Button (matches size and styling of subnav-pills: Movies, Shows, Lists) */
  #catalogSearchBtn,
  button[data-act="runCatalogSearch"] {
    flex: none;
    flex-shrink: 0;
    padding: 7px 16px !important;
    min-height: 36px !important;
    height: 36px !important;
    box-sizing: border-box !important;
    border-radius: var(--radius-pill) !important;
    font-size: 0.86rem !important;
    font-weight: 600 !important;
    align-self: center;
  }

  /* Secondary button style */
  .btn-secondary,
  button.secondary:not(.lc-btn, .ec-btn),
  .secondary:not(.lc-btn, .ec-btn),
  .btn-copy,
  .btn-watchlist,
  .btn-test {
    background: var(--color-bg-surface);
    color: var(--color-text-secondary);
    border: 1.5px solid var(--color-border-strong);
    box-shadow: var(--shadow-sm);
    min-height: var(--control-height-md, 40px);
    padding: 9px 16px;
  }

  .btn-secondary:hover:not(:disabled),
  button.secondary:not(.lc-btn):hover:not(:disabled),
  .secondary:not(.lc-btn):hover:not(:disabled),
  .btn-copy:hover:not(:disabled),
  .btn-watchlist:hover:not(:disabled),
  .btn-test:hover:not(:disabled) {
    background: var(--color-bg-sunken);
    color: var(--color-text-primary);
    border-color: var(--color-border-strong);
  }

  .btn-secondary:active:not(:disabled),
  button.secondary:not(.lc-btn):active:not(:disabled),
  .secondary:not(.lc-btn):active:not(:disabled) {
    transform: scale(0.98);
  }

  /* Ghost / Tertiary button style */
  .btn-ghost,
  .btn-tertiary {
    background: transparent;
    color: var(--color-text-secondary);
    border: 1.5px solid transparent;
    box-shadow: none;
    min-height: var(--control-height-md, 40px);
    padding: 8px 14px;
  }

  .btn-ghost:hover:not(:disabled),
  .btn-tertiary:hover:not(:disabled) {
    background: var(--color-brand-subtle);
    color: var(--color-brand);
  }

  .btn-ghost:active:not(:disabled),
  .btn-tertiary:active:not(:disabled) {
    transform: scale(0.98);
  }

  /* Destructive / Danger button style */
  .btn-danger,
  .btn-destructive,
  button.danger:not(.ec-btn),
  .actions button[data-act="removeAllLists"],
  .catalog-actions-bar button[data-act="removeAllLists"] {
    background: var(--color-danger-subtle);
    color: var(--color-danger);
    border: 1.5px solid rgba(255, 59, 48, 0.3);
    box-shadow: var(--shadow-sm);
    min-height: var(--control-height-md, 40px);
    padding: 9px 16px;
  }

  .btn-danger:hover:not(:disabled),
  .btn-destructive:hover:not(:disabled),
  button.danger:not(.ec-btn):hover:not(:disabled),
  .actions button[data-act="removeAllLists"]:hover:not(:disabled),
  .catalog-actions-bar button[data-act="removeAllLists"]:hover:not(:disabled) {
    background: var(--color-danger);
    color: #fff;
    border-color: var(--color-danger);
  }

  .btn-danger:active:not(:disabled),
  .btn-destructive:active:not(:disabled),
  button.danger:not(.ec-btn):active:not(:disabled),
  .actions button[data-act="removeAllLists"]:active:not(:disabled),
  .catalog-actions-bar button[data-act="removeAllLists"]:active:not(:disabled) {
    background: var(--color-danger-hover);
    transform: scale(0.98);
  }

  /* Size Variants */
  .btn-sm {
    min-height: var(--control-height-sm, 32px);
    padding: 5px 12px;
    font-size: var(--font-size-xs, 0.8rem);
    border-radius: var(--radius-pill);
  }

  .btn-md {
    min-height: var(--control-height-md, 40px);
    padding: 9px 16px;
    font-size: var(--font-size-sm, 0.88rem);
  }

  .btn-lg {
    min-height: var(--control-height-lg, 48px);
    padding: 12px 22px;
    font-size: var(--font-size-base, 0.95rem);
  }

  /* Disabled state across all buttons */
  .btn:disabled,
  button:disabled,
  .actions a:disabled,
  .btn[aria-disabled="true"],
  button[aria-disabled="true"] {
    opacity: 0.5;
    cursor: not-allowed !important;
    pointer-events: none;
    box-shadow: none !important;
    transform: none !important;
  }

  button.modal-close-x {
    width: 32px; height: 32px; min-height: unset;
    padding: 0; border-radius: 50%;
    background: var(--color-bg-sunken); color: var(--color-text-muted);
    border: 1px solid var(--color-border-strong);
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 1rem; line-height: 1; flex: none;
  }
  button.modal-close-x:hover {
    color: var(--color-text-primary);
    background: var(--color-border-strong);
  }

  .btn-stremio { background: linear-gradient(135deg, #9B8FFF, #6D48FF); color: #fff; border: none; }
  .btn-nuvio   { background: linear-gradient(135deg, #FF5E3A, #FF2A68); color: #fff; border: none; }
  .btn-wako    { background: linear-gradient(135deg, #007AFF, #34AADC); color: #fff; border: none; }
  .actions { display: flex; flex-direction: column; align-items: stretch; gap: 8px; }

  /* Catalog actions bar: side-by-side on mobile, spread on desktop */
  .catalog-actions-bar {
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    margin-top: 16px;
  }
  .catalog-actions-bar button[data-act="removeAllLists"] {
    flex: 0 0 auto;
    white-space: nowrap;
  }
  .catalog-actions-bar button[data-act="generate"] {
    flex: 0 0 auto;
    margin-left: auto;
    white-space: nowrap;
  }
  @media (max-width: 640px) {
    .catalog-actions-bar {
      gap: 8px;
    }
    .catalog-actions-bar button[data-act="removeAllLists"] {
      flex: 0 0 auto;
      padding: 9px 12px;
      font-size: 0.85rem;
    }
    .catalog-actions-bar button[data-act="generate"] {
      flex: 1 1 auto;
      margin-left: 0;
      text-align: center;
      padding: 9px 14px;
      font-size: 0.88rem;
    }
  }

  /* --- Install Result Card & Manifest Link Display ------------------------ */
  #result {
    margin-top: 16px;
  }
  .install-result-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 18px 20px;
    box-shadow: var(--shadow);
    display: flex;
    flex-direction: column;
    gap: 14px;
    animation: resultSlideIn 0.22s cubic-bezier(0.16, 1, 0.3, 1);
  }
  @keyframes resultSlideIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .install-result-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }
  .install-result-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: var(--radius-pill);
    background: rgba(52, 199, 89, 0.12);
    color: #34C759;
    font-weight: 700;
    font-size: 0.82rem;
    letter-spacing: 0.01em;
  }
  .install-result-badge svg {
    stroke: currentColor;
  }
  .install-result-sub {
    font-size: 0.8rem;
    color: var(--muted);
    font-weight: 500;
  }
  .install-url-container {
    display: flex;
    flex-direction: column;
    background: var(--bg);
    border: 1.5px solid var(--border-strong);
    border-radius: 12px;
    padding: 12px 14px;
    gap: 10px;
    transition: border-color 0.15s, box-shadow 0.15s;
    min-width: 0;
  }
  .install-url-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .install-url-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: 700;
    font-size: 0.82rem;
    color: var(--text-2);
  }
  .install-url-label svg {
    color: var(--accent);
  }
  .install-url-copy-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    border-radius: var(--radius-pill);
    background: var(--surface);
    border: 1.5px solid var(--border-strong);
    color: var(--text);
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
    box-shadow: var(--shadow-sm);
    min-height: unset;
    font-family: inherit;
  }
  .install-url-copy-btn:hover {
    background: var(--panel-strong);
    border-color: var(--accent);
    color: var(--accent);
  }
  .install-url-copy-btn.primary {
    background: var(--color-brand) !important;
    color: var(--color-text-inverse, #fff) !important;
    border-color: var(--color-brand) !important;
    box-shadow: 0 2px 6px var(--color-brand-subtle) !important;
  }
  .install-url-copy-btn.primary:hover {
    background: var(--color-brand-hover) !important;
    border-color: var(--color-brand-hover) !important;
    color: var(--color-text-inverse, #fff) !important;
  }
  .install-url-copy-btn.primary svg {
    stroke: #ffffff;
  }
  .install-url-box {
    font-family: var(--font-mono, monospace);
    font-size: 0.84rem;
    font-weight: 500;
    color: var(--text);
    word-break: break-all;
    overflow-wrap: anywhere;
    white-space: normal;
    user-select: all;
    -webkit-user-select: all;
    line-height: 1.5;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    cursor: pointer;
  }
  .install-hint-box {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px 14px;
    border-radius: 10px;
    background: rgba(0, 122, 255, 0.05);
    border: 1px solid rgba(0, 122, 255, 0.13);
    color: var(--muted);
    font-size: 0.82rem;
    line-height: 1.45;
  }
  .install-hint-steps {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 6px;
    color: var(--text);
    font-size: 0.82rem;
  }

  .trakt-connect-actions {
    display: flex;
    flex-direction: row;
    width: auto;
    gap: 8px;
    margin-bottom: 10px;
    flex-wrap: wrap;
  }
  @media (max-width: 640px) {
    .trakt-connect-actions {
      display: flex !important;
      flex-direction: row !important;
      width: 100% !important;
      gap: 8px !important;
      flex-wrap: wrap !important;
    }
    .trakt-connect-actions #traktConnectBtn,
    .trakt-connect-actions #traktDeviceBtn {
      flex: 1 1 calc(50% - 4px) !important;
      min-width: 0 !important;
      padding: 8px 4px !important;
      font-size: 0.8rem !important;
      white-space: nowrap !important;
      text-overflow: ellipsis !important;
      overflow: hidden !important;
    }
    .trakt-connect-actions #traktDisconnectBtn {
      flex: 1 1 100% !important;
      width: 100% !important;
      padding: 8px 4px !important;
      font-size: 0.8rem !important;
    }
  }
  @media (min-width: 641px) {
    .trakt-connect-actions {
      display: flex !important;
      flex-direction: row !important;
      width: auto !important;
      gap: 8px !important;
      flex-wrap: wrap !important;
    }
    .trakt-connect-actions button {
      flex: none !important;
      width: auto !important;
    }
  }

  /* --- Provider Integration Cards (External Accounts & API Keys) --- */
  .provider-card {
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    box-shadow: var(--shadow-sm);
    padding: 18px 20px;
    margin-bottom: 16px;
    transition: border-color 0.2s ease, box-shadow 0.2s ease;
  }
  .provider-card:hover {
    border-color: var(--color-border-strong, var(--border));
    box-shadow: var(--shadow-md);
  }
  .provider-card-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }
  .provider-card-brand {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    flex: 1;
    min-width: 200px;
  }
  .provider-card-icon {
    width: 38px;
    height: 38px;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.25rem;
    background: var(--surface-2, rgba(255, 255, 255, 0.06));
    border: 1px solid var(--border);
    flex-shrink: 0;
  }
  .provider-card-title {
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--text);
  }
  .provider-card-desc {
    margin: 3px 0 0;
    color: var(--muted);
    font-size: 0.82rem;
    line-height: 1.35;
  }
  .provider-status-badge {
    display: inline-flex;
    align-items: center;
    padding: 3px 10px;
    border-radius: 9999px;
    background: var(--surface);
    border: 1.5px solid var(--color-border-strong, var(--border));
    font-size: 0.78rem;
    font-weight: 600;
    line-height: 1.2;
    flex-shrink: 0;
  }
  .provider-status-badge > span {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .provider-card-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }
  .provider-advanced-disclosure {
    border-top: 1px solid var(--border);
    padding-top: 10px;
    margin-top: 12px;
  }
  .provider-advanced-summary {
    cursor: pointer;
    font-size: 0.82rem;
    color: var(--muted);
    display: flex;
    align-items: center;
    justify-content: space-between;
    user-select: none;
    padding: 2px 0;
  }
  .provider-advanced-summary:hover {
    color: var(--text);
  }
  .provider-advanced-arrow {
    font-size: 0.75rem;
    transition: transform 0.2s ease;
  }
  .provider-advanced-disclosure[open] .provider-advanced-arrow {
    transform: rotate(180deg);
  }

  /* --- Import List Dropzone --- */
  .import-dropzone {
    border: 2px dashed var(--color-border-strong, var(--border));
    border-radius: 12px;
    padding: 28px 16px;
    background: var(--surface);
    text-align: center;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    transition: border-color 0.2s ease, background-color 0.2s ease, box-shadow 0.2s ease;
  }
  .import-dropzone:hover,
  .import-dropzone.dragover {
    border-color: var(--color-brand, #007aff);
    background: var(--color-brand-subtle, rgba(0, 122, 255, 0.04));
    box-shadow: 0 0 0 3px rgba(0, 122, 255, 0.1);
  }
  .import-dropzone-icon {
    font-size: 2rem;
    line-height: 1;
  }

  /* --- Feedback & External Resources Polish --- */
  .feedback-container {
    max-width: 680px;
    width: 100%;
  }
  .resource-cards-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 14px;
    margin-top: 10px;
  }
  .resource-card {
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 18px 20px;
    background: var(--surface);
    box-shadow: var(--shadow-sm);
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 14px;
    text-decoration: none;
    transition: border-color 0.2s ease, transform 0.15s ease, box-shadow 0.2s ease;
  }
  .resource-card:hover {
    border-color: var(--color-border-strong, var(--border));
    transform: translateY(-2px);
    box-shadow: var(--shadow-md);
  }
  .resource-card-top {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }
  .resource-card-icon {
    width: 36px;
    height: 36px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.2rem;
    background: var(--surface-2, rgba(255, 255, 255, 0.06));
    border: 1px solid var(--border);
    flex-shrink: 0;
  }
  .resource-card-title {
    font-weight: 700;
    font-size: 0.92rem;
    color: var(--text);
  }
  .resource-card-desc {
    margin: 3px 0 0;
    color: var(--muted);
    font-size: 0.8rem;
    line-height: 1.35;
  }

  #lists { display: grid; gap: 12px; grid-template-columns: 1fr; width: 100%; max-width: 100%; margin-bottom: 20px; }
  .entry {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    margin-bottom: 12px;
    padding: 14px;
    position: relative;
    box-shadow: var(--shadow-sm);
    /* A grid item's default min-width is auto (shrink no further than its
       widest content), not 0 -- without this, a wide Live Preview poster
       grid inside can force this whole row (and #lists's single column
       track) past the viewport edge on a phone instead of the poster grid
       itself shrinking to fit. */
    min-width: 0;
  }
  .entry.dragging {
    opacity: 0.4;
    box-shadow: 0 8px 16px rgba(0,0,0,0.15);
    border-color: var(--accent);
  }
  .entry-card-top {
    display: flex; align-items: flex-start; gap: 10px; margin-bottom: 10px; width: 100%;
  }
  .entry-avatar {
    width: 42px; height: 42px; border-radius: 11px; flex: none;
    display: flex; align-items: center; justify-content: center;
    font-weight: 800; font-size: 1.05rem; color: #fff;
    text-transform: uppercase;
  }
  .entry-card-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
  .entry-name-row { display: flex; align-items: center; gap: 6px; width: 100%; }
  .entry-name-row .name {
    flex: 1; min-width: 0; padding: 6px 10px;
    min-height: unset; font-size: 0.92rem; font-weight: 600;
    border-radius: 8px;
  }
  .entry-type-row { display: flex; align-items: center; gap: 6px; }
  .entry-type-row .type {
    padding: 5px 10px; min-height: unset; font-size: 0.82rem;
    border-radius: 8px; width: auto;
  }
  .entry-pos-wrap .pos {
    width: 48px;
    height: 30px;
    min-height: 30px !important;
    max-height: 30px;
    box-sizing: border-box;
    padding: 0 6px;
    font-size: 0.82rem;
    border-radius: 7px;
    text-align: center;
    background: var(--bg);
    border: 1.5px solid var(--border-strong);
    line-height: 27px;
  }
  .entry-ctrl-row {
    display: flex; gap: 4px; align-items: center; flex-shrink: 0;
  }
  .ec-btn {
    width: 30px;
    height: 30px;
    min-height: 30px !important;
    max-height: 30px;
    box-sizing: border-box;
    padding: 0;
    border-radius: 7px;
    background: var(--bg);
    border: 1.5px solid var(--border-strong);
    color: var(--muted);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    font-size: 0.82rem;
    line-height: 1;
  }
  .ec-btn:not(.movebtn):not(.drag-handle):not(.removebtn) {
    width: auto;
    padding: 0 10px;
  }
  .ec-btn:hover:not(:disabled) { color: var(--text); background: var(--panel-strong); }
  .ec-btn.danger {
    color: var(--color-danger, #d70015);
    border-color: rgba(255, 59, 48, 0.35);
    background: rgba(255, 59, 48, 0.08);
  }
  :root.dark-theme .ec-btn.danger {
    color: var(--color-danger, #ff453a);
    border-color: rgba(255, 69, 58, 0.45);
    background: rgba(255, 69, 58, 0.15);
  }
  .ec-btn.danger:hover:not(:disabled) {
    color: #ffffff;
    background: var(--color-danger, #ff3b30);
    border-color: var(--color-danger, #ff3b30);
  }
  .ec-btn.danger svg {
    display: block;
    stroke: currentColor;
    flex-shrink: 0;
  }
  .sources { display: flex; flex-direction: column; gap: 10px; width: 100%; }
  .source-row { width: 100%; }
  .source-row + .source-row { padding-top: 10px; border-top: 1px dashed var(--border-strong); }
  .testrow { display: flex; align-items: center; gap: 10px; margin-top: 4px; flex-wrap: wrap; width: 100%; }
  .testresult { width: 100%; }
  .testresult.ok { color: var(--success); }
  .testresult.err { color: var(--danger); }
  .testresult.pending { color: var(--muted); }

  /* Compact view for #lists */
  #lists.compact .sources,
  #lists.compact .add-source-btn,
  #lists.compact .watchlist-note {
    display: none !important;
  }
  .premade-shelf .sources,
  .premade-shelf .add-source-btn {
    display: none !important;
  }
  #lists.compact .entry {
    padding: 8px 12px;
  }
  #lists.compact .entry-card-top {
    margin-bottom: 0;
  }

  /* Configured Shelves Test results: 1-row 5-posters strip on desktop, 1-row 3-posters on mobile */
  .preview-thumbs {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    margin-top: 6px;
    max-width: 240px;
    width: 100%;
  }
  @media (max-width: 640px) {
    .preview-thumbs .preview-thumb:nth-child(n+4) {
      display: none;
    }
  }
  @media (min-width: 641px) {
    .preview-thumbs {
      grid-template-columns: repeat(5, 1fr);
      max-width: 440px;
      gap: 8px;
    }
  }
  .preview-thumb {
    width: 100%;
    aspect-ratio: 2 / 3;
    object-fit: cover;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--panel-strong);
    display: block;
  }

  /* --- Live Preview Shelves (Home Screen) --------------------------------- */
  .live-preview-shelf {
    background: transparent;
    border: none;
    border-radius: var(--radius);
    padding: 0 0 14px 0;
    box-shadow: none;
    margin-bottom: 12px;
    width: 100%;
  }
  .live-preview-shelf-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    font-weight: 700;
    font-size: 0.95rem;
    color: var(--text);
  }
  .live-preview-shelf-title .shelf-title-text {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .live-preview-shelf-title .text-action-btn {
    margin-left: auto;
    color: var(--accent) !important;
    background: transparent !important;
    border: none !important;
    box-shadow: none !important;
    border-radius: 0 !important;
    min-height: unset !important;
    height: auto !important;
    padding: 2px 4px !important;
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
    flex: none;
    text-decoration: none;
    white-space: nowrap;
    outline: none;
    line-height: inherit;
  }
  .live-preview-shelf-title .text-action-btn:hover:not(:disabled) {
    background: transparent !important;
    color: var(--accent) !important;
    text-decoration: underline;
    box-shadow: none !important;
    transform: none !important;
  }
  .live-preview-shelf-title .text-action-btn:active:not(:disabled) {
    background: transparent !important;
    color: var(--accent) !important;
    transform: none !important;
  }
  .live-preview-shelf-title .text-action-btn:disabled {
    opacity: 0.35;
    cursor: default;
    background: transparent !important;
    text-decoration: none;
  }
  .live-preview-posters {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
    width: 100%;
    padding-bottom: 6px;
  }
  @media (max-width: 640px) {
    .live-preview-posters .live-preview-poster-card:nth-child(n+4) {
      display: none;
    }
  }
  @media (min-width: 641px) {
    .live-preview-posters {
      grid-template-columns: repeat(9, 1fr);
      gap: 8px;
    }
  }
  .live-preview-poster-card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    width: 100%;
  }
  .live-preview-poster {
    width: 100%;
    aspect-ratio: 2 / 3;
    object-fit: cover;
    border-radius: 6px;
    background: var(--panel-strong);
    border: 1px solid var(--border);
    display: block;
  }
  .live-preview-poster.landscape {
    aspect-ratio: 16 / 9;
  }
  .live-preview-poster-placeholder {
    width: 100%;
    aspect-ratio: 2 / 3;
    border-radius: 6px;
    background: var(--panel-strong);
    border: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
  }
  .live-preview-poster-name {
    font-size: 0.70rem;
    color: var(--text);
    font-weight: 600;
    line-height: 1.25;
    padding: 2px 4px 4px 4px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
    min-height: 2.5em;
  }
  /* Second line under a poster for episode entries -- e.g. the episode's
     own title under a "Show Name S03E07" first line (see
     formatWatchItemLabel / livePreviewPosterHtml). Omitted entirely for
     anything without one (movies, shows, every other shelf on the site),
     so this never adds empty space to a normal poster card. */
  .live-preview-poster-subtitle {
    font-size: 0.66rem;
    color: var(--muted);
    line-height: 1.25;
    padding: 0 4px 2px 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .live-preview-poster-year {
    font-size: 0.65rem;
    color: var(--muted);
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* --- List Details page ("See All" full list view) ----------------------- */
  .list-details-page { padding-bottom: calc(24px + env(safe-area-inset-bottom)); }
  .detail-header-info h1 {
    font-size: 1.3rem; font-weight: 800; margin: 0;
  }
  .detail-header-info p {
    margin: 0; font-size: 0.85rem; color: var(--muted);
  }

  /* --- Season Cards & Headers --------------------------------------------- */
  .season-card {
    background: var(--surface-light);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .season-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    padding: 16px;
    cursor: pointer;
  }
  .season-header-main {
    display: flex;
    gap: 16px;
    align-items: center;
    min-width: 0;
    flex: 1;
  }
  .season-header-poster {
    width: 80px;
    border-radius: 4px;
    flex-shrink: 0;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  }
  .season-header-poster-placeholder {
    width: 80px;
    height: 120px;
    background: #333;
    border-radius: 4px;
    flex-shrink: 0;
  }
  .season-header-info {
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-width: 0;
  }
  .season-header-title {
    margin: 0 0 4px;
    font-size: 1.2rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .season-header-episodes {
    color: var(--muted);
    font-size: 0.9rem;
  }
  .season-header-episodes.is-complete {
    color: var(--brand);
  }
  .season-header-actions {
    flex-shrink: 0;
    margin-left: 12px;
  }
  .season-header-actions .btn-mark-season-watched {
    padding: 6px 14px;
    font-size: 0.82rem;
    white-space: nowrap;
  }

  @media (max-width: 600px) {
    .season-header {
      flex-direction: column;
      align-items: stretch;
      gap: 12px;
      padding: 12px;
    }
    .season-header-poster {
      width: 60px;
    }
    .season-header-poster-placeholder {
      width: 60px;
      height: 90px;
    }
    .season-header-actions {
      width: 100%;
      margin-left: 0;
    }
    .season-header-actions .btn-mark-season-watched {
      width: 100%;
      text-align: center;
      justify-content: center;
      padding: 8px 12px;
      font-size: 0.85rem;
    }
  }

  /* --- Modals & Toasts ---------------------------------------------------- */
  .modal-overlay {
    position: fixed; inset: 0; background: var(--color-bg-overlay);
    display: flex; align-items: center; justify-content: center;
    padding: 16px; z-index: 1000;
  }
  .modal-card {
    background: var(--color-bg-elevated); border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-xl); padding: 22px; max-width: 440px; width: 100%;
    max-height: 90vh; overflow-y: auto; box-shadow: var(--shadow-lg);
  }
  .modal-card.modal-card-wide {
    max-width: 1100px;
    width: 95vw;
  }
  .modal-card input:not([type="checkbox"]):not([type="radio"]),
  .modal-card select,
  .modal-card textarea {
    background: var(--surface);
    border: 1.5px solid var(--border-strong);
    color: var(--text);
  }
  /* The one animation in here that is not decoration: it is the only signal
     a modal gives that a slow action (Reset Account Data, generating an
     install link) is still running rather than stuck. The spin animation was
     referenced by name in two places and declared in none, so both spinners
     sat perfectly still. */
  @keyframes spin { to { transform: rotate(360deg); } }
  .app-spinner {
    display: inline-block; width: 20px; height: 20px; flex: none;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  .modal-close-x {
    float: right; background: var(--bg); border: 1px solid var(--border-strong);
    color: var(--muted); font-size: 1rem; cursor: pointer;
    width: 32px; height: 32px; padding: 0; border-radius: 50%;
    display: inline-flex; align-items: center; justify-content: center; line-height: 1;
  }
  .undo-toast {
    position: fixed; left: 50%;
    bottom: calc(66px + env(safe-area-inset-bottom));
    transform: translateX(-50%);
    background: rgba(255, 255, 255, 0.96);
    color: var(--text);
    border: 1px solid var(--border-strong);
    border-radius: 14px; padding: 12px 18px;
    display: flex; align-items: center; gap: 14px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.12); z-index: 1000;
  }
  :root.dark-theme .undo-toast,
  html.dark-theme .undo-toast {
    background: #000000;
    color: #ffffff;
    border: 1px solid rgba(255, 255, 255, 0.18);
    box-shadow: 0 4px 20px rgba(0,0,0,0.6);
  }
  .action-toast {
    position: fixed;
    left: 50%;
    bottom: calc(72px + env(safe-area-inset-bottom));
    transform: translateX(-50%) translateY(20px);
    background: rgba(255, 255, 255, 0.96);
    color: var(--text);
    border: 1px solid var(--border-strong);
    padding: 10px 18px;
    border-radius: var(--radius-pill);
    font-size: 0.86rem;
    font-weight: 600;
    box-shadow: 0 4px 16px rgba(0,0,0,0.12);
    z-index: 99999;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease, transform 0.2s ease;
    white-space: nowrap;
    max-width: 90vw;
    overflow: hidden;
    text-overflow: ellipsis;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
  }
  .action-toast.show {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
  :root.dark-theme .action-toast,
  html.dark-theme .action-toast {
    background: #000000;
    color: #ffffff;
    border: 1px solid rgba(255, 255, 255, 0.18);
    box-shadow: 0 4px 16px rgba(0,0,0,0.6);
  }
  .app-toast-container {
    position: fixed;
    left: 50%;
    bottom: calc(72px + env(safe-area-inset-bottom, 0px));
    transform: translateX(-50%);
    z-index: 99999;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    pointer-events: none;
    max-width: 90vw;
    width: max-content;
  }
  .app-toast {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
    border-radius: var(--radius-pill);
    background: rgba(255, 255, 255, 0.96);
    color: var(--text);
    font-size: 0.88rem;
    font-weight: 500;
    box-shadow: 0 4px 20px rgba(0,0,0,0.12);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    opacity: 0;
    transform: translateY(12px);
    transition: opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1), transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    pointer-events: auto;
    border: 1px solid var(--border-strong);
  }
  .app-toast.show {
    opacity: 1;
    transform: translateY(0);
  }
  :root.dark-theme .app-toast,
  html.dark-theme .app-toast {
    background: #000000;
    color: #ffffff;
    border: 1px solid rgba(255, 255, 255, 0.18);
    box-shadow: 0 4px 20px rgba(0,0,0,0.6);
  }
  .app-toast-msg {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 60vw;
  }
  .app-toast-action {
    background: var(--accent);
    color: #ffffff;
    border: none;
    border-radius: var(--radius-pill);
    padding: 4px 12px;
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
    line-height: 1.2;
    transition: background 0.15s ease, transform 0.1s ease;
  }
  .app-toast-action:hover {
    background: var(--accent-hover);
  }
  .app-toast-action:active {
    transform: scale(0.96);
  }
  .app-toast-close {
    background: transparent;
    border: none;
    color: var(--muted);
    font-size: 1.1rem;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .app-toast-close:hover {
    color: var(--text);
  }
  :root.dark-theme .app-toast-close,
  html.dark-theme .app-toast-close {
    color: rgba(255, 255, 255, 0.6);
  }
  :root.dark-theme .app-toast-close:hover,
  html.dark-theme .app-toast-close:hover {
    color: #ffffff;
  }
  .sortable-item {
    user-select: none;
    -webkit-user-select: none;
  }
  .sortable-item.dragging,
  .entry.dragging,
  .list-card.dragging,
  .custom-list-pick.dragging,
  .creator-list-row.dragging {
    opacity: 0.45 !important;
    transform: scale(0.98);
    transition: transform 0.15s ease, opacity 0.15s ease;
  }
  /* What marks the item being moved, on every drag-to-reorder
     (createSortableList, 16_): catalog rows, Your Custom Lists, My Channels,
     and the picks in the channel and custom list builders. Only the list
     cards had it; the owner asked for it everywhere. */
  .sortable-item.dragging,
  .entry.dragging,
  .list-card.dragging,
  .custom-list-pick.dragging,
  .channel-pick.dragging,
  .creator-list-row.dragging,
  .live-preview-poster-card.dragging {
    outline: 2px dashed var(--accent) !important;
    outline-offset: 2px;
  }

  /* Custom List Content Type Standalone Pills (matches .subnav-pill) */
  .custom-list-type-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 5px 14px;
    min-height: 31px;
    font-size: 0.82rem;
    font-weight: 600;
    border-radius: var(--radius-pill);
    border: 1.5px solid var(--color-border-strong);
    background: var(--color-bg-surface);
    color: var(--color-text-secondary);
    cursor: pointer;
    user-select: none;
    transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
    box-shadow: none;
    font-family: inherit;
  }
  .custom-list-type-pill:hover:not(.active):not(:has(input:checked)) {
    border-color: rgba(0, 122, 255, 0.40);
    color: var(--accent);
  }
  .custom-list-type-pill:has(input:checked),
  .custom-list-type-pill.active {
    background: rgba(0, 122, 255, 0.12) !important;
    border-color: rgba(0, 122, 255, 0.40) !important;
    color: var(--accent) !important;
    font-weight: 700 !important;
    box-shadow: none !important;
  }
  :root.dark-theme .custom-list-type-pill:has(input:checked),
  :root.dark-theme .custom-list-type-pill.active {
    background: rgba(10, 132, 255, 0.22) !important;
    border-color: rgba(10, 132, 255, 0.50) !important;
    color: var(--accent) !important;
  }
  .custom-list-type-pill .check-icon {
    display: none;
    font-weight: 800;
    font-size: 0.82rem;
    color: var(--accent);
  }
  .custom-list-type-pill:has(input:checked) .check-icon,
  .custom-list-type-pill.active .check-icon {
    display: inline;
  }
  .custom-list-type-pill input[type="radio"] {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
    pointer-events: none;
    margin: 0;
  }

  /* Custom List Search Cards (Media Tile Layout, matches 9-column grid) */
  .custom-list-search-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
    min-width: 0;
    cursor: pointer;
    user-select: none;
    transition: transform 0.15s ease;
  }
  .custom-list-search-card:hover:not(:has(.customListAddBtn:disabled)) {
    transform: translateY(-2px);
  }
  .custom-list-search-card:hover .custom-list-search-poster {
    box-shadow: var(--shadow-md);
  }
  .custom-list-search-poster {
    width: 100%;
    aspect-ratio: 2/3;
    object-fit: cover;
    border-radius: 8px;
    box-shadow: var(--shadow-sm);
    transition: box-shadow 0.15s ease;
    background: var(--surface-2, rgba(255,255,255,0.06));
  }
  .custom-list-search-title {
    width: 100%;
    font-size: 0.74rem;
    font-weight: 600;
    text-align: center;
    color: var(--text);
    margin: 4px 0 2px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    line-height: 1.25;
    min-height: 2.5em;
  }
  .custom-list-search-meta {
    font-size: 0.68rem;
    color: var(--muted);
    text-align: center;
    margin-bottom: 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    width: 100%;
  }

  @media (max-width: 640px) {
    .customListMoveBtn { display: none !important; }
    .customListPosInput { display: none !important; }
  }

  @media (min-width: 641px) {
    body { padding: 24px 20px 52px; }
    .page { gap: 16px; }
    .actions { flex-direction: row; flex-wrap: wrap; }
    .actions button, .actions a { width: auto; }
    .custom-list-pick-poster { width: 72px; height: 108px; }
    .row { flex-direction: row; }
    /* A box with its button beside it (Lists -> Import's name and Import list,
       among others): every input is width:100%, so side by side it squeezed
       the button until its words stacked. The button keeps its own width and
       the box takes what is left. */
    .row > input + button, .row > select + button { flex: 0 0 auto; white-space: nowrap; }
    .row > input, .row > select { min-width: 0; }
    .field-row { grid-template-columns: minmax(0, 1fr) auto; }
    #lists { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }

    /* Live Preview & Editor CSS */
    
    /* Default (Preview Mode) */
    #lists:not(.live-preview-edit-mode) .entry-ctrl-row,
    #lists:not(.live-preview-edit-mode) .entry-name-row,
    #lists:not(.live-preview-edit-mode) .entry-type-row,
    #lists:not(.live-preview-edit-mode) .sources,
    #lists:not(.live-preview-edit-mode) .add-source-btn,
    #lists:not(.live-preview-edit-mode) .watchlist-note {
      display: none !important;
    }
    
    #lists:not(.live-preview-edit-mode) .entry {
      border: none !important;
      background: transparent !important;
      box-shadow: none !important;
      padding: 0 !important;
    }

    #lists:not(.live-preview-edit-mode) {
      grid-template-columns: 1fr !important;
    }

    /* In Edit Mode, hide the posters because they get in the way of drag-and-drop */
    #lists.live-preview-edit-mode .live-preview-posters {
      display: none !important;
    }
    
    #lists.live-preview-edit-mode .entry {
      border: 1px solid var(--border) !important;
      background: var(--bg) !important;
      padding: 12px !important;
    }

  
  .watch-indicator-overlay {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: #007aff;
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: bold;
    box-shadow: 0 2px 4px rgba(0,0,0,0.5);
    z-index: 5;
    pointer-events: none;
  }

  .is-watch-history-shelf .watch-indicator-overlay {
    display: none !important;
  }

  /* --- Live Preview Skeleton Shimmer Loader ----------------------------- */
  @keyframes livePreviewShimmer {
    0% { background-position: -200% 0; }
    100% { background-position: 200% 0; }
  }
  .live-preview-skeleton-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    min-width: 0;
  }
  .live-preview-skeleton-poster {
    width: 100%;
    aspect-ratio: 2 / 3;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: linear-gradient(90deg, var(--panel-strong) 25%, var(--border-strong) 50%, var(--panel-strong) 75%);
    background-size: 200% 100%;
    animation: livePreviewShimmer 1.5s infinite ease-in-out;
  }
  .live-preview-skeleton-line {
    height: 10px;
    border-radius: 4px;
    width: 80%;
    background: linear-gradient(90deg, var(--panel-strong) 25%, var(--border-strong) 50%, var(--panel-strong) 75%);
    background-size: 200% 100%;
    animation: livePreviewShimmer 1.5s infinite ease-in-out;
  }
  .live-preview-skeleton-line-sub {
    height: 8px;
    border-radius: 4px;
    width: 50%;
    background: linear-gradient(90deg, var(--panel-strong) 25%, var(--border-strong) 50%, var(--panel-strong) 75%);
    background-size: 200% 100%;
    animation: livePreviewShimmer 1.5s infinite ease-in-out;
  }

  /* --- Shelf Drag Handle in Preview Mode ---------------------------------- */
  .shelf-drag-handle {
    cursor: grab;
    user-select: none;
    touch-action: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 1.1rem;
    color: var(--muted);
    margin-right: 8px;
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    transition: color 0.15s ease, background-color 0.15s ease;
    vertical-align: middle;
    flex: none;
    line-height: 1;
  }
  .shelf-drag-handle:hover {
    color: var(--text);
    background: var(--panel-strong);
  }
  .shelf-drag-handle:active,
  .entry .drag-handle:active {
    cursor: grabbing;
  }
  /* The Edit-mode handle is dragged by pointer events too (createSortableList),
     so on a touch screen it must not hand the gesture to page scrolling. */
  .entry .drag-handle {
    touch-action: none;
    user-select: none;
  }
  .entry.dragging {
    opacity: 0.45;
    transform: scale(0.99);
  }

  /* --- Shelf Header Loading Status Badge ---------------------------------- */
  .live-preview-shelf-status {
    display: inline-flex;
    align-items: center;
    flex: none;
    gap: 4px;
    font-size: 0.74rem;
    font-weight: 500;
    color: var(--muted);
    margin-left: 6px;
    letter-spacing: 0.01em;
  }
  .live-preview-shelf-status .status-spin {
    display: inline-block;
    animation: spin 0.9s linear infinite;
  }

  /* --- The new UI shell (Phase 6) -------------------------------------------- */
  /* Emitted for every visitor and inert without <html data-app-shell="1">.
     That is deliberate: /app.css is one shared, content-hashed file
     (splitAppCss, 02_http-and-creator-utils.js), so a variant-dependent
     stylesheet would cost every visitor the shared cache. */
  /* The shell's tabs are links (a real path per view), and a link is
     underlined unless told otherwise -- the line under every tab name. */
  html[data-app-shell="1"] a.tab-btn,
  html[data-app-shell="1"] a.bottom-nav-item { text-decoration: none; }
  /* Search -> Lists: the source and sort chips, smaller than the Movies /
     Shows / Lists pills above them (setCatalogListSearchChip, 19_). */
  html[data-app-shell="1"] .catalog-list-chips { display: grid; gap: 6px; margin-top: 8px; }
  html[data-app-shell="1"] .catalog-list-chip-row { display: flex; flex-wrap: wrap; gap: 6px; }
  html[data-app-shell="1"] .catalog-list-chip {
    flex: none; min-height: unset; cursor: pointer;
    padding: 3px 10px; font-size: 0.75rem; font-weight: 600; line-height: 1.5;
    border-radius: var(--radius-pill); border: 1px solid var(--border-strong);
    background: var(--surface); color: var(--text-2);
  }
  html[data-app-shell="1"] .catalog-list-chip:hover { border-color: var(--accent); color: var(--accent); }
  html[data-app-shell="1"] .catalog-list-chip.active { background: var(--accent); border-color: var(--accent); color: #fff; }
  /* The floating "Unsaved changes to install link" banner is never shown on
     a shell page: Catalogs' Generate Install Link button and Settings' Install
     links card are where the link is made. */
  html[data-app-shell="1"] #unsavedInstallBanner { display: none !important; }

  /* The shell's Settings cards (P6-2). The card itself is the ordinary
     .panel; these are the rows, the small action row and the status chip
     inside it, so the new panels look like the rest of the page without a
     second stylesheet. */
  html[data-app-shell="1"] .app-shell-muted { color: var(--muted); font-size: 0.85rem; margin: 0 0 10px; }
  html[data-app-shell="1"] .app-shell-kv { margin: 0 0 8px; font-size: 0.92rem; }
  html[data-app-shell="1"] .app-shell-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
  html[data-app-shell="1"] .app-shell-row {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 12px; flex-wrap: wrap; padding: 12px 0;
    border-top: 1px solid var(--border);
  }
  html[data-app-shell="1"] .app-shell-row-main { flex: 1 1 240px; min-width: 0; font-size: 0.9rem; }
  html[data-app-shell="1"] .app-shell-row-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  html[data-app-shell="1"] .app-shell-chip {
    display: inline-block; padding: 2px 10px; border-radius: var(--radius-pill);
    font-size: 0.75rem; font-weight: 600;
    border: 1px solid var(--border); color: var(--muted);
  }
  html[data-app-shell="1"] .app-shell-chip-ok { color: var(--success); border-color: rgba(52, 199, 89, 0.45); }
  html[data-app-shell="1"] .app-shell-chip-warn { color: var(--warn); border-color: rgba(255, 149, 0, 0.45); }
  html[data-app-shell="1"] .app-shell-danger { color: var(--danger); border-color: rgba(255, 59, 48, 0.35); }
  html[data-app-shell="1"] .app-shell-details { margin-top: 10px; font-size: 0.88rem; }
  html[data-app-shell="1"] .app-shell-details summary { cursor: pointer; color: var(--text); }

  /* The duplicate toggle (P6-3), right below the rows it applies to and above
     the Daily Randomizer. It used to live in Settings; on a shell page that
     copy is hidden, so the same setting is described in one place (see
     #legacyDedupePanel). The review styles below are shared with the Lists,
     Imports and Channels views. */
  html[data-app-shell="1"] #legacyDedupePanel { display: none; }
  html[data-app-shell="1"] .app-shell-review { margin-top: 12px; }
  html[data-app-shell="1"] .app-shell-review-row {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 10px; padding: 8px 0; border-top: 1px solid var(--border); font-size: 0.88rem;
  }
  html[data-app-shell="1"] .app-shell-review-url {
    color: var(--muted); font-size: 0.78rem;
    word-break: break-all; overflow-wrap: anywhere;
  }
  html[data-app-shell="1"] .app-shell-review-bad { color: var(--danger); }
  html[data-app-shell="1"] .app-shell-dedupe {
    display: flex; align-items: flex-start; gap: 10px; cursor: pointer;
    font-size: 0.92rem; user-select: none; margin: 16px 0 0;
    padding: 14px 16px; border: 1px solid var(--border); border-radius: 12px;
    background: var(--surface);
  }
  /* Sits right above the Daily Randomizer box and matches it. */
  html[data-app-shell="1"] .app-shell-dedupe .app-shell-muted { margin: 4px 0 0; }
  html[data-app-shell="1"] .app-shell-dedupe input { margin-top: 2px; cursor: pointer; width: 16px; height: 16px; }

  /* A visibility choice (P6-4) is a chip you can press: Private, Unlisted,
     Public. The chosen one is highlighted; the one that needs the new list
     service is disabled and says why. */
  html[data-app-shell="1"] button.app-shell-chip {
    background: none; font: inherit; cursor: pointer;
  }
  html[data-app-shell="1"] button.app-shell-chip.is-on {
    color: var(--accent); border-color: var(--accent);
  }
  html[data-app-shell="1"] button.app-shell-chip[disabled] { cursor: not-allowed; opacity: 0.55; }

  /* What is actually in a list, previewed before it is added (P6-5). */
  html[data-app-shell="1"] .app-shell-explore-preview { padding: 2px 0 10px; }
  html[data-app-shell="1"] .app-shell-explore-posters {
    display: flex; gap: 6px; flex-wrap: wrap; margin: 4px 0 8px;
  }
  html[data-app-shell="1"] .app-shell-explore-poster {
    width: 58px; height: 87px; object-fit: cover; border-radius: 6px;
    background: var(--panel-strong); border: 1px solid var(--border);
  }
  html[data-app-shell="1"] .app-shell-explore-poster-none { display: block; }

  /* Import progress (P6-6): how far the server has got, and a heading for the
     blocks under it. */
  html[data-app-shell="1"] .app-shell-h3 { margin: 14px 0 6px; font-size: 1rem; }
  html[data-app-shell="1"] .app-shell-bar {
    height: 8px; border-radius: 999px; overflow: hidden;
    background: var(--panel-strong); border: 1px solid var(--border); margin: 2px 0 8px;
  }
  html[data-app-shell="1"] .app-shell-bar > span {
    display: block; height: 100%; background: var(--accent); transition: width 0.3s ease;
  }
  html[data-app-shell="1"] #appShellImportName, html[data-app-shell="1"] #appShellAddTitlesInput {
    width: 100%; padding: 10px 12px; border-radius: 10px;
    border: 1.5px solid var(--border-strong); background: var(--surface); color: var(--text); font-size: 0.95rem;
  }

  /* Channels (P6-7): the template cards, the schedule panel, and the lineup
     the server answers with. The lineup tiles are the same shape as the
     list preview's posters (P6-5), deliberately. */
  html[data-app-shell="1"] .app-shell-template-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 10px; margin: 12px 0;
  }
  html[data-app-shell="1"] button.app-shell-template-card {
    display: flex; flex-direction: column; gap: 4px; align-items: flex-start;
    text-align: left; padding: 12px 14px; cursor: pointer; font: inherit;
    border: 1px solid var(--border); border-radius: 10px;
    background: var(--surface); color: var(--text);
  }
  html[data-app-shell="1"] button.app-shell-template-card:hover { border-color: var(--accent); }
  html[data-app-shell="1"] .app-shell-template-card .app-shell-muted { font-size: 0.8rem; }
  html[data-app-shell="1"] .app-shell-template-note { font-size: 0.74rem; }
  html[data-app-shell="1"] .app-shell-schedule {
    margin: 12px 0; padding: 10px 12px; border: 1px solid var(--border);
    border-radius: 10px; background: var(--surface);
  }
  html[data-app-shell="1"] .app-shell-schedule summary { cursor: pointer; font-weight: 600; }
  html[data-app-shell="1"] .app-shell-schedule input[type="number"] { width: 84px; }
  html[data-app-shell="1"] .app-shell-schedule .app-shell-muted { font-size: 0.8rem; }
  html[data-app-shell="1"] .app-shell-person-grid { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
  html[data-app-shell="1"] .app-shell-lineup {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
    gap: 8px; margin: 8px 0 10px;
  }
  html[data-app-shell="1"] .app-shell-lineup-tile { display: flex; flex-direction: column; gap: 4px; }
  html[data-app-shell="1"] .app-shell-lineup-tile img,
  html[data-app-shell="1"] .app-shell-lineup-blank {
    width: 100%; aspect-ratio: 2 / 3; object-fit: cover; border-radius: 6px;
    background: var(--panel-strong); border: 1px solid var(--border);
  }
  html[data-app-shell="1"] .app-shell-lineup-tile span {
    font-size: 0.72rem; color: var(--muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  html[data-app-shell="1"] #appShellChannels input[type="text"] {
    width: 100%; padding: 10px 12px; border-radius: 10px;
    border: 1.5px solid var(--border-strong); background: var(--surface); color: var(--text); font-size: 0.95rem;
  }

  /* --- Floating Unsaved Changes to Install Link Banner -------------------- */
  .unsaved-install-banner {
    position: fixed;
    bottom: calc(72px + env(safe-area-inset-bottom));
    left: 50%;
    transform: translateX(-50%) translateY(30px);
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-pill);
    padding: 8px 14px 8px 16px;
    display: flex;
    align-items: center;
    gap: 12px;
    box-shadow: var(--shadow-md);
    z-index: 999;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1), transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    white-space: nowrap;
    max-width: calc(100vw - 24px);
    font-size: 0.86rem;
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
  }
  .unsaved-install-banner.show {
    opacity: 1;
    pointer-events: auto;
    transform: translateX(-50%) translateY(0);
  }
  .unsaved-install-banner-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--warn);
    box-shadow: 0 0 0 3px rgba(255, 149, 0, 0.2);
    flex-shrink: 0;
    animation: pulseDot 2s infinite ease-in-out;
  }
  .unsaved-install-banner-dot.up-to-date {
    background: var(--success);
    box-shadow: 0 0 0 3px rgba(52, 199, 89, 0.2);
    animation: none;
  }
  @keyframes pulseDot {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.55; transform: scale(0.85); }
  }
  .unsaved-install-banner-btn {
    background: var(--accent);
    color: #ffffff;
    border: none;
    border-radius: var(--radius-pill);
    padding: 5px 12px;
    font-size: 0.80rem;
    font-weight: 700;
    cursor: pointer;
    transition: background 0.15s ease, transform 0.1s ease;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }
  /* The label is what gives way when the banner runs out of room, not the
     button. The banner is a nowrap flex row capped at calc(100vw - 24px),
     and a flex item's default min-width:auto will not shrink below its
     content -- which under white-space:nowrap is the full sentence. So the
     line overflowed the banner's own box and pushed the button (flex-shrink:0)
     past it: at 320px only 37px of the 111px "Update Link" button was on
     screen, with .page's overflow-x:hidden leaving no way to reach the rest.
     min-width:0 lets the text shrink; the ellipsis keeps it readable. */
  #unsavedInstallText {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .unsaved-install-banner-btn:hover {
    background: var(--accent-hover);
  }
  .unsaved-install-banner-btn:active {
    transform: scale(0.96);
  }
/*MYLISTS_APP_CSS_END*/</style>
<!-- fflate, for reading Trakt/Letterboxd export .zips entirely client-side.
     It used to be a cdn.jsdelivr.net script with an SRI hash: a third-party
     origin in script-src, allowed to run with full page privileges (this page
     holds myListAddon:creatorKey and the provider keys in localStorage), and
     a hash that had to be regenerated by hand on every bump. P7-1 made it
     this Worker's own file -- FFLATE_UMD_JS (01_icon-asset.js), served from
     FFLATE_VENDOR_PATH (25_api-catalog-routes.js) -- so there is no
     third-party origin left in the page, and the served bytes are the
     vendored bytes rather than a URL's word for it.
     The path carries the version, so the response is immutable and is cached
     by the service worker along with /app.js and /app.css.
     The callers still handle it being absent: every use site checks for
     fflate being undefined and shows a real message (see
     18_client-copy-and-trakt-export.js).
     NB: no backticks in this comment -- this whole file is string content
     inside renderBuilder's template literal, so one would close it early. -->
<script src="${FFLATE_VENDOR_PATH}"></script>
</head>
<body>
<div class="page">
  <!-- Top App Bar -->
  <header class="app-header">
    <div class="app-header-left">
      <div class="app-header-title-group">
        <h1 class="app-header-title" id="pageMainTitle">Discover</h1>
        <span class="app-header-sub" id="pageSubtitle">Explore Popular &amp; Streaming</span>
      </div>
    </div>
    <div class="app-header-actions">
      <button type="button" class="header-icon-btn header-search-btn" id="headerSearchBtn" data-act="switchTab" data-act-args="[&quot;search&quot;]" aria-label="Search" title="Search">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
      </button>
      <button type="button" class="theme-toggle-btn dark-mode-toggle" id="themeToggleBtn" data-act="toggleTheme" aria-label="Toggle Light or Dark Mode" title="Toggle Light / Dark Mode">
        <svg class="theme-icon-sun" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" fill="currentColor"></circle>
          <line x1="12" y1="2" x2="12" y2="4.5"></line>
          <line x1="12" y1="19.5" x2="12" y2="22"></line>
          <line x1="2" y1="12" x2="4.5" y2="12"></line>
          <line x1="19.5" y1="12" x2="22" y2="12"></line>
          <line x1="4.93" y1="4.93" x2="6.7" y2="6.7"></line>
          <line x1="17.3" y1="17.3" x2="19.07" y2="19.07"></line>
          <line x1="4.93" y1="19.07" x2="6.7" y2="17.3"></line>
          <line x1="17.3" y1="6.7" x2="19.07" y2="4.93"></line>
        </svg>
        <svg class="theme-icon-moon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
        </svg>
      </button>
      <div id="creatorProfileBar"><button type="button" class="header-avatar-btn signed-out" id="headerProfileBtn" data-act="openRestoreModal" aria-label="Sign in or create account" title="Sign in or create account"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg></button></div>
    </div>
  </header>

  <!-- Top Tab Bar (Desktop View) -->
${newUi ? appShellDesktopNavHtml : `  <div class="tab-bar" role="tablist" aria-label="Main navigation">
    <button type="button" class="tab-btn" role="tab" id="tab-desktop-catalogs" aria-controls="content-catalogs" aria-selected="false" tabindex="-1" data-tab="catalogs" data-act="switchTab" data-act-args="[&quot;catalogs&quot;]">Catalogs</button>
    <button type="button" class="tab-btn" role="tab" id="tab-desktop-lists" aria-controls="content-lists" aria-selected="false" tabindex="-1" data-tab="lists" data-act="switchTab" data-act-args="[&quot;lists&quot;]">Lists</button>
    <button type="button" class="tab-btn" role="tab" id="tab-desktop-channels" aria-controls="content-channels" aria-selected="false" tabindex="-1" data-tab="channels" data-act="switchTab" data-act-args="[&quot;channels&quot;]">Channels</button>
    <button type="button" class="tab-btn active" role="tab" id="tab-desktop-discover" aria-controls="content-discover" aria-selected="true" tabindex="0" data-tab="discover" data-act="switchTab" data-act-args="[&quot;discover&quot;]">Discover</button>
    <button type="button" class="tab-btn" role="tab" id="tab-desktop-search" aria-controls="content-search" aria-selected="false" tabindex="-1" data-tab="search" data-act="switchTab" data-act-args="[&quot;search&quot;]">Search</button>
    <button type="button" class="tab-btn" role="tab" id="tab-desktop-settings" aria-controls="content-settings" aria-selected="false" tabindex="-1" data-tab="settings" data-act="switchTab" data-act-args="[&quot;settings&quot;]">Settings</button>
  </div>`}

  <!-- Unsaved Changes Floating Banner -->
  <div id="unsavedInstallBanner" class="unsaved-install-banner">
    <span id="unsavedInstallText" style="font-weight:600;">Unsaved changes to install link</span>
    <button type="button" class="unsaved-install-banner-btn" id="unsavedInstallBtn" data-act="updateInstallLinkFromBanner">Update Link</button>
  </div>

  <!-- Bottom Nav Bar (Mobile View - Persistent Glassmorphism) -->
${newUi ? appShellMobileNavHtml : `  <nav class="bottom-nav" role="tablist" aria-label="Main navigation">
    <button type="button" class="bottom-nav-item" role="tab" id="tab-mobile-catalogs" aria-controls="content-catalogs" aria-selected="false" tabindex="-1" data-tab="catalogs" data-act="switchTab" data-act-args="[&quot;catalogs&quot;]" title="Catalogs">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
      </svg>
      Catalogs
    </button>
    <button type="button" class="bottom-nav-item" role="tab" id="tab-mobile-lists" aria-controls="content-lists" aria-selected="false" tabindex="-1" data-tab="lists" data-act="switchTab" data-act-args="[&quot;lists&quot;]" title="Lists">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line>
        <line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line>
        <line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line>
      </svg>
      Lists
    </button>
    <button type="button" class="bottom-nav-item" role="tab" id="tab-mobile-channels" aria-controls="content-channels" aria-selected="false" tabindex="-1" data-tab="channels" data-act="switchTab" data-act-args="[&quot;channels&quot;]" title="Channels">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="2" y="7" width="20" height="15" rx="2" ry="2"></rect>
        <polyline points="17 2 12 7 7 2"></polyline>
      </svg>
      Channels
    </button>
    <button type="button" class="bottom-nav-item active" role="tab" id="tab-mobile-discover" aria-controls="content-discover" aria-selected="true" tabindex="0" data-tab="discover" data-act="switchTab" data-act-args="[&quot;discover&quot;]" title="Discover">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect>
        <rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect>
      </svg>
      Discover
    </button>
    <button type="button" class="bottom-nav-item" role="tab" id="tab-mobile-settings" aria-controls="content-settings" aria-selected="false" tabindex="-1" data-tab="settings" data-act="switchTab" data-act-args="[&quot;settings&quot;]" title="Settings">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3"></circle>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
      </svg>
      Settings
    </button>
  </nav>`}

  <script nonce="${CSP_NONCE_PLACEHOLDER}">
    (function() {
      var initTab = document.documentElement.getAttribute('data-initial-tab');
      if (initTab === 'search') {
        var sBtn = document.getElementById('headerSearchBtn');
        if (sBtn) sBtn.classList.add('active');
      }
      if (initTab) {
        var titles = {
          discover: { title: 'Discover', sub: 'Explore Popular & Streaming' },
          catalogs: { title: 'Catalogs', sub: 'Manage Configured Catalogs' },
          lists: { title: 'Lists', sub: 'Custom, Connected & Liked Lists' },
          channels: { title: 'Channels', sub: '24/7 Continuous TV Streaming' },
          search: { title: 'Search', sub: 'Find Movies, Shows & Lists' },
          settings: { title: 'Settings', sub: 'Accounts, API Keys & Tools' }
        };
        var t = titles[initTab];
        if (t) {
          var titleEl = document.getElementById('pageMainTitle');
          var subEl = document.getElementById('pageSubtitle');
          if (titleEl) titleEl.textContent = t.title;
          if (subEl) subEl.textContent = t.sub;
        }
      }
      try {
        var cName = localStorage.getItem('myListAddon:creatorName');
        var cKey = localStorage.getItem('myListAddon:creatorKey');
        var cDisp = localStorage.getItem('myListAddon:creatorDisplayName') || cName;
        var cBar = document.getElementById('creatorProfileBar');
        if (cBar) {
          if (cName && cKey) {
            var disp = cDisp || cName || 'Account';
            var init = (disp.charAt(0) || 'U').toUpperCase();
            cBar.innerHTML = '<button type="button" class="header-avatar-btn signed-in" id="headerProfileBtn" data-act="switchTab" data-act-args="[&quot;account&quot;]" aria-label="Account: ' + String(disp).replace(/[&<>"']/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}) + '" title="Signed in as ' + String(disp).replace(/[&<>"']/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}) + '"><span class="header-avatar-initial">' + String(init).replace(/[&<>"']/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}) + '</span></button>';
          } else {
            cBar.innerHTML = '<button type="button" class="header-avatar-btn signed-out" id="headerProfileBtn" data-act="openRestoreModal" aria-label="Sign in or create account" title="Sign in or create account"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg></button>';
          }
        }
      } catch (e) {}
    })();
  </script>

  <!-- Action Notification Toast -->
  <div id="actionToast" class="action-toast" role="status" aria-live="polite"></div>

  <!-- List Details page ("See All" full list view) -->
  <div class="tab-panel list-details-page" data-tab-panel="list-details" id="content-list-details" hidden>
    <div style="margin-bottom: 20px;">
      <button type="button" class="lc-btn secondary" data-act="navigateBackFromDetail" style="padding: 6px 12px; font-size: 0.9rem;">&larr; Back</button>
    </div>
    <div class="detail-header-info" style="margin-bottom:14px;">
      <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
        <!-- A list opened before its own "nice" name is available (e.g. a
             row whose configured name is itself a pasted URL) shows that
             raw URL here. As a flex item, an <h1> defaults to
             min-width: auto, meaning it won't shrink below its own
             min-content width -- and a long, unbroken URL's min-content
             can exceed the viewport on mobile, forcing this whole row
             (and the like/+Add buttons with it, via their margin-left:
             auto) past the screen edge instead of wrapping in place. -->
        <h1 id="detailTitle" style="min-width:0; overflow-wrap:anywhere;">List Title</h1>
        <div style="display:flex; gap:10px; align-items:center; margin-left:auto;">
          <button type="button" class="lc-btn searchLikeExternalBtn" id="detailLikeBtn" aria-label="Like this list">&#9825;</button>
          <button type="button" class="lc-btn primary" id="detailAddBtn">+ Add</button>
        </div>
      </div>
      <p id="detailSubtitle" style="margin-top:4px;">Loading&hellip;</p>
    </div>
    <div id="detailFilterBar" class="detail-filter-bar" style="display:none;">
      <div id="whFilterControls" style="display:flex; gap:6px; flex-wrap:wrap; align-items:center; width:100%;">
        <button type="button" class="subnav-pill active wh-filter-pill" data-wh-filter="all" data-act="setWatchHistoryFilter" data-act-args="[&quot;all&quot;,&quot;@self&quot;]">All</button>
        <button type="button" class="subnav-pill wh-filter-pill" data-wh-filter="movie" data-act="setWatchHistoryFilter" data-act-args="[&quot;movie&quot;,&quot;@self&quot;]">Movies</button>
        <button type="button" class="subnav-pill wh-filter-pill" data-wh-filter="series" data-act="setWatchHistoryFilter" data-act-args="[&quot;series&quot;,&quot;@self&quot;]">Shows</button>
        <label class="wh-group-shows-toggle" style="display:inline-flex; align-items:center; gap:6px; margin-left:8px; cursor:pointer; font-size:0.84rem; color:var(--text); user-select:none;">
          <input type="checkbox" id="whGroupShowsCheckbox" data-act="toggleWatchHistoryGroupShows" data-act-args="[&quot;@checked&quot;]" style="accent-color:var(--accent); cursor:pointer;">
          <span>Shows instead of episodes</span>
        </label>
        <button type="button" class="btn-danger btn-sm" id="whClearHistoryBtn" data-act="clearWatchHistoryAll" style="margin-left:auto;">Clear History</button>
      </div>
      <div id="genericTypeFilterControls" style="display:none; gap:6px; flex-wrap:wrap; align-items:center; width:100%;">
        <button type="button" class="subnav-pill active generic-type-pill" id="detailTypeAllBtn" data-act="switchListDetailsType" data-act-args="[&quot;all&quot;]">All</button>
        <button type="button" class="subnav-pill generic-type-pill" id="detailTypeMovieBtn" data-act="switchListDetailsType" data-act-args="[&quot;movie&quot;]">Movies</button>
        <button type="button" class="subnav-pill generic-type-pill" id="detailTypeSeriesBtn" data-act="switchListDetailsType" data-act-args="[&quot;series&quot;]">Shows</button>
        <button type="button" class="btn-danger btn-sm" id="cwClearHistoryBtn" data-act="clearContinueWatchingAll" style="display:none; margin-left:auto;">Clear All</button>
      </div>
      <div id="whSortControls" style="display:flex; align-items:center; gap:8px;">
        <label for="whSortSelect" style="font-size:0.75rem; color:var(--muted); font-weight:700; text-transform:uppercase; letter-spacing:0.02em;">Sort</label>
        <select id="whSortSelect" class="detail-sort-select" data-act="setWatchHistorySort" data-act-args="[&quot;@value&quot;]">
          <option value="recent">Recently Watched</option>
          <option value="oldest">Oldest Watched</option>
          <option value="title-asc">Title (A-Z)</option>
          <option value="title-desc">Title (Z-A)</option>
        </select>
      </div>
    </div>
    <div class="poster-grid-3" id="detailGrid"></div>
    <p id="detailStatus" style="text-align:center; color:var(--muted); margin-top:14px;"><small>Loading&hellip;</small></p>
  </div>

  <div class="tab-panel" data-tab-panel="item-details" id="content-item-details" hidden>
    <button type="button" class="item-back-btn" data-act="navigateBackFromDetail" aria-label="Back">&larr; Back</button>
    <div id="itemDetailsBody" style="display: flex; flex-direction: column; gap: 24px;">
      <!-- Filled dynamically -->
    </div>
  </div>

  <div id="createListModal" class="modal-overlay" role="dialog" aria-modal="true" aria-label="Create a list" style="display:none; z-index: 10001; background: var(--color-bg-overlay); justify-content: center; align-items: center; position: fixed; inset: 0; padding: 16px;">
    <div class="modal-card" style="width: 100%; max-width: 420px; padding: 22px; background: var(--color-bg-elevated); border: 1px solid var(--color-border-strong); border-radius: var(--radius-xl); box-shadow: var(--shadow-lg); display: flex; flex-direction: column;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
        <h2 style="margin:0; font-size:1.25rem; font-weight:700; color:var(--text);" id="createListModalTitle">Create List</h2>
        <button type="button" class="modal-close-x" aria-label="Close" data-act="closeCreateListModal">&#x2715;</button>
      </div>

      <div style="margin-bottom: 12px;">
        <label style="display:block; font-size:0.8rem; font-weight:600; color:var(--muted); margin-bottom:4px; text-transform:uppercase;">Save To</label>
        <select id="createListModalDestination" aria-label="Destination" style="width: 100%; padding: 10px 12px; border-radius: 8px; border: 1.5px solid var(--border-strong); background: var(--surface); color: var(--text); font-size:0.95rem;" data-act="onChangeCreateListDestination">
          <option value="custom">My Lists (Local / Profile)</option>
          <option value="trakt">Trakt List</option>
          <option value="tmdb">TMDB List</option>
          <option value="mdblist">MDBList List</option>
          <option value="simkl">Simkl List</option>
        </select>
      </div>
      
      <div style="margin-bottom: 12px;">
        <label style="display:block; font-size:0.8rem; font-weight:600; color:var(--muted); margin-bottom:4px; text-transform:uppercase;">List Name *</label>
        <input type="text" id="createListModalName" placeholder="e.g. My Favorite Sci-Fi" style="width: 100%; padding: 10px 12px; border-radius: 8px; border: 1.5px solid var(--border-strong); background: var(--surface); color: var(--text); font-size:0.95rem;" data-act-on="input" data-act="appActValidateCreateListName" data-act-args="[&quot;@value&quot;]">
      </div>

      <div style="margin-bottom: 12px;">
        <label style="display:block; font-size:0.8rem; font-weight:600; color:var(--muted); margin-bottom:4px; text-transform:uppercase;">Description (Optional)</label>
        <textarea id="createListModalDesc" placeholder="Brief summary of what is in this list..." rows="2" style="width: 100%; padding: 8px 12px; border-radius: 8px; border: 1.5px solid var(--border-strong); background: var(--surface); color: var(--text); font-size:0.9rem; resize:vertical; font-family:inherit;"></textarea>
      </div>
      
      <div style="margin-bottom: 14px;">
        <label style="display:block; font-size:0.8rem; font-weight:600; color:var(--muted); margin-bottom:4px; text-transform:uppercase;">Content Type</label>
        <select id="createListModalType" aria-label="Content type" style="width: 100%; padding: 10px 12px; border-radius: 8px; border: 1.5px solid var(--border-strong); background: var(--surface); color: var(--text); font-size:0.95rem;">
          <option value="movie">Movies</option>
          <option value="series">Shows</option>
          <option value="mixed">Mixed (Movies &amp; Shows)</option>
        </select>
      </div>
      
      <div id="createListModalPublicWrap" style="margin-bottom: 18px;">
        <label style="display:flex; align-items:flex-start; gap:10px; cursor:pointer;">
          <input type="checkbox" id="createListModalPublic" style="margin-top:3px; flex-shrink:0;">
          <div>
            <span style="font-size:0.92rem; font-weight:600; color:var(--text); display:block;">Make list public</span>
            <span style="font-size:0.78rem; color:var(--muted); display:block; margin-top:2px; line-height:1.35;">When enabled, this list is visible on your public creator profile and community directory.</span>
          </div>
        </label>
      </div>
      
      <div style="display: flex; justify-content: flex-end; gap: 10px; border-top: 1px solid var(--border); padding-top: 14px;">
        <button type="button" class="lc-btn secondary" data-act="closeCreateListModal">Cancel</button>
        <button type="button" class="lc-btn primary" id="createListModalBtn" style="opacity: 0.5; min-width: 80px;" disabled data-act="submitCreateListModal">Create</button>
      </div>
    </div>
  </div>

  <!-- Add Catalog Modal -->
  <div id="addShelfModal" class="modal-overlay" role="dialog" aria-modal="true" aria-label="New catalog" style="display:none; z-index: 10001; background: var(--color-bg-overlay); justify-content: center; align-items: center; position: fixed; inset: 0; padding: 16px;">
    <div class="modal-card" style="width: 100%; max-width: 420px; padding: 22px; background: var(--color-bg-elevated); border: 1px solid var(--color-border-strong); border-radius: var(--radius-xl); box-shadow: var(--shadow-lg); display: flex; flex-direction: column;">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px;">
        <h2 style="margin:0; font-size:1.25rem; font-weight:700; color:var(--text);">New Catalog</h2>
        <button type="button" class="modal-close-x" aria-label="Close" data-act="appActHideAddShelfModal">&#x2715;</button>
      </div>
      
      <div style="margin-bottom: 12px;">
        <label for="addShelfModalName" style="display:block; font-size:0.8rem; font-weight:600; color:var(--muted); margin-bottom:4px; text-transform:uppercase;">Catalog Name</label>
        <input type="text" id="addShelfModalName" placeholder="e.g. Trending Movies" style="width: 100%; padding: 10px 12px; border-radius: 8px; border: 1.5px solid var(--border-strong); background: var(--surface); color: var(--text); font-size:0.95rem;" data-act-on="input" data-act="validateAddShelfModal">
      </div>
      
      <div style="margin-bottom: 12px;">
        <label style="display:block; font-size:0.8rem; font-weight:600; color:var(--muted); margin-bottom:4px; text-transform:uppercase;">Catalog URL</label>
        <div id="addShelfModalLinksContainer">
          <div class="add-shelf-link-row" style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
            <input type="url" class="addShelfModalLinkInput" placeholder="URL (e.g. Trakt, Letterboxd, MDBList)" style="flex:1; padding: 10px 12px; border-radius: 8px; border: 1.5px solid var(--border-strong); background: var(--surface); color: var(--text); font-size:0.95rem;" data-act-on="input" data-act="onAddShelfModalLinkInput" data-act-then="validateAddShelfModal" data-act-args="[&quot;@self&quot;]">
          </div>
        </div>
        <button type="button" class="lc-btn secondary" style="width: 100%; font-size: 0.84rem; padding: 6px 12px; margin-top: 4px;" data-act="addShelfModalAddLink">+ Add another link (Combined List)</button>
        <small style="display:block; color:var(--muted); font-size:0.78rem; margin-top:4px;">Combine multiple list URLs into a single catalog row on your home screen.</small>
      </div>
      
      <div style="margin-bottom: 16px;">
        <label for="addShelfModalType" style="display:block; font-size:0.8rem; font-weight:600; color:var(--muted); margin-bottom:4px; text-transform:uppercase;">Content Type</label>
        <select id="addShelfModalType" aria-label="Catalog type" style="width: 100%; padding: 10px 12px; border-radius: 8px; border: 1.5px solid var(--border-strong); background: var(--surface); color: var(--text); font-size:0.95rem;" data-act="validateAddShelfModal">
          <option value="movie">Movies</option>
          <option value="series">Shows</option>
        </select>
      </div>
      
      <div style="display: flex; justify-content: flex-end; gap: 10px; border-top: 1px solid var(--border); padding-top: 14px;">
        <button type="button" class="lc-btn secondary" data-act="appActHideAddShelfModal">Cancel</button>
        <button type="button" class="lc-btn primary" id="addShelfModalBtn" style="opacity: 0.5; min-width: 80px;" disabled data-act="submitAddShelfModal">Add Catalog</button>
      </div>
    </div>
  </div>

  <!-- Import List Modal -->
  <div id="importListModal" class="modal-overlay" role="dialog" aria-modal="true" aria-label="Import list from a link" style="display:none; z-index: 10001; background: var(--color-bg-overlay); justify-content: center; align-items: center; position: fixed; inset: 0; padding: 16px;">
    <div class="modal-card" style="width: 100%; max-width: 420px; padding: 22px; background: var(--color-bg-elevated); border: 1px solid var(--color-border-strong); border-radius: var(--radius-xl); box-shadow: var(--shadow-lg); display: flex; flex-direction: column;">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px;">
        <h2 style="margin:0; font-size:1.25rem; font-weight:700; color:var(--text);">Import List from Link</h2>
        <button type="button" class="modal-close-x" aria-label="Close" data-act="closeImportListModal">&#x2715;</button>
      </div>
      <p style="margin:0 0 14px; color:var(--muted); font-size:0.85rem; line-height:1.4;">Paste any MDBList, Trakt, or TMDB list URL to import directly as a Custom List.</p>
      <div style="margin-bottom: 12px;">
        <label for="modalCustomListImportUrlInput" style="display:block; font-size:0.8rem; font-weight:600; color:var(--muted); margin-bottom:4px; text-transform:uppercase;">List URL</label>
        <input type="text" id="modalCustomListImportUrlInput" placeholder="mdblist.com, trakt.tv, or themoviedb.org URL" style="width: 100%; padding: 10px 12px; border-radius: 8px; border: 1.5px solid var(--border-strong); background: var(--surface); color: var(--text); font-size:0.95rem; box-sizing:border-box;">
      </div>
      <div style="margin-bottom: 14px;">
        <label for="modalCustomListImportNameInput" style="display:block; font-size:0.8rem; font-weight:600; color:var(--muted); margin-bottom:4px; text-transform:uppercase;">List Name (Optional)</label>
        <input type="text" id="modalCustomListImportNameInput" placeholder="e.g. My Favorites (leave blank to auto-detect)" style="width: 100%; padding: 10px 12px; border-radius: 8px; border: 1.5px solid var(--border-strong); background: var(--surface); color: var(--text); font-size:0.95rem; box-sizing:border-box;">
      </div>
      <label style="display:flex; align-items:center; gap:8px; cursor:pointer; margin-bottom:18px;">
        <input type="checkbox" id="modalCustomListImportSyncCheck" checked>
        <span style="font-size:0.85rem; color:var(--text);">Keep custom list synced with external link</span>
      </label>
      <div style="display: flex; justify-content: flex-end; gap: 10px; border-top: 1px solid var(--border); padding-top: 14px;">
        <button type="button" class="lc-btn secondary" data-act="closeImportListModal">Cancel</button>
        <button type="button" class="lc-btn primary" id="modalCustomListImportBtn" data-act="importCustomListFromLink" data-act-args="[&quot;@self&quot;]" style="min-width: 90px;">Import List</button>
      </div>
    </div>
  </div>

  <!-- Import Channel Modal -->
  <div id="importChannelModal" class="modal-overlay" role="dialog" aria-modal="true" aria-label="Import Channel" style="display:none; z-index: 10001; background: var(--color-bg-overlay); justify-content: center; align-items: center; position: fixed; inset: 0; padding: 16px;">
    <div class="modal-card" style="width: 100%; max-width: 440px; padding: 22px; background: var(--color-bg-elevated); border: 1px solid var(--color-border-strong); border-radius: var(--radius-xl); box-shadow: var(--shadow-lg); display: flex; flex-direction: column;">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
        <h2 style="margin:0; font-size:1.25rem; font-weight:700; color:var(--text);">Import Channel</h2>
        <button type="button" class="modal-close-x" aria-label="Close" data-act="closeImportChannelModal">&#x2715;</button>
      </div>

      <!-- Segmented Mode Selector: From Link vs From Share Code -->
      <div class="subnav-pills-bar" id="importChannelModePills" style="margin-bottom: 14px; gap: 6px; padding: 0;">
        <button type="button" class="subnav-pill active" id="importChannelModeLinkBtn" data-act="switchImportChannelMode" data-act-args="[&quot;link&quot;,&quot;@self&quot;]"><span class="check-icon">&#x2713;</span> From List Link</button>
        <button type="button" class="subnav-pill" id="importChannelModeCodeBtn" data-act="switchImportChannelMode" data-act-args="[&quot;code&quot;,&quot;@self&quot;]">From Share Code</button>
      </div>

      <!-- Mode 1: From List Link -->
      <div id="importChannelPanelLink">
        <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem; line-height:1.4;">Paste any MDBList, Trakt, or TMDB show list URL to import directly as a 24/7 TV channel.</p>
        <div style="margin-bottom: 12px;">
          <label for="modalChannelImportUrlInput" style="display:block; font-size:0.8rem; font-weight:600; color:var(--muted); margin-bottom:4px; text-transform:uppercase;">Show List URL</label>
          <input type="text" id="modalChannelImportUrlInput" placeholder="mdblist.com, trakt.tv, or themoviedb.org show list URL" style="width: 100%; padding: 10px 12px; border-radius: 8px; border: 1.5px solid var(--border-strong); background: var(--surface); color: var(--text); font-size:0.95rem; box-sizing:border-box;">
        </div>
        <div style="margin-bottom: 12px;">
          <label for="modalChannelImportNameInput" style="display:block; font-size:0.8rem; font-weight:600; color:var(--muted); margin-bottom:4px; text-transform:uppercase;">Channel Name</label>
          <input type="text" id="modalChannelImportNameInput" placeholder="e.g. Sitcom Central" style="width: 100%; padding: 10px 12px; border-radius: 8px; border: 1.5px solid var(--border-strong); background: var(--surface); color: var(--text); font-size:0.95rem; box-sizing:border-box;">
        </div>
        <label style="display:flex; align-items:flex-start; gap:8px; cursor:pointer; margin-bottom:18px;">
          <input type="checkbox" id="modalChannelImportLiveSyncCheck" checked style="margin-top:2px;">
          <span style="font-size:0.82rem; color:var(--text); line-height:1.35;">Live Cloud Sync &mdash; keep this channel following the list in the background</span>
        </label>
        <div style="display: flex; justify-content: flex-end; gap: 10px; border-top: 1px solid var(--border); padding-top: 14px;">
          <button type="button" class="lc-btn secondary" data-act="closeImportChannelModal">Cancel</button>
          <button type="button" class="lc-btn primary" id="modalChannelImportBtn" data-act="importChannelFromLink" data-act-args="[&quot;@self&quot;]" style="min-width: 90px;">Import Channel</button>
        </div>
      </div>

      <!-- Mode 2: From Share Code -->
      <div id="importChannelPanelCode" style="display:none;">
        <p style="margin:0 0 12px; color:var(--muted); font-size:0.85rem; line-height:1.4;">Paste a channel share link or code to rebuild that exact community channel lineup here.</p>
        <div style="margin-bottom: 14px;">
          <label for="modalChannelShareCodeInput" style="display:block; font-size:0.8rem; font-weight:600; color:var(--muted); margin-bottom:4px; text-transform:uppercase;">Channel Share Link or Code</label>
          <input type="text" id="modalChannelShareCodeInput" placeholder="https://... /channel/AbC123 or code" data-act-on="keydown" data-act="importSharedChannel" data-act-keys="Enter" data-act-prevent data-act-args="[&quot;@self&quot;]" style="width: 100%; padding: 10px 12px; border-radius: 8px; border: 1.5px solid var(--border-strong); background: var(--surface); color: var(--text); font-size:0.95rem; box-sizing:border-box;">
        </div>
        <div id="modalChannelShareImportStatus" style="margin-bottom:14px; font-size:0.85rem;"></div>
        <div style="display: flex; justify-content: flex-end; gap: 10px; border-top: 1px solid var(--border); padding-top: 14px;">
          <button type="button" class="lc-btn secondary" data-act="closeImportChannelModal">Cancel</button>
          <button type="button" class="lc-btn primary" id="modalChannelShareAddBtn" data-act="importSharedChannel" data-act-args="[&quot;@self&quot;]" style="min-width: 90px;">Add Channel</button>
        </div>
      </div>
    </div>
  </div>

  <div id="selectListModal" class="modal-overlay" role="dialog" aria-modal="true" aria-label="Choose a list" style="display:none; z-index: 10001; justify-content: center; align-items: center; position: fixed; inset: 0; padding: 16px; background: var(--color-bg-overlay);">
    <div class="modal-card" style="width: 100%; max-width: 480px; padding: 22px; background: var(--color-bg-elevated); border: 1px solid var(--color-border-strong); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); display: flex; flex-direction: column; max-height: 85vh;">
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
        <div>
          <h2 style="margin:0; font-size:1.25rem; font-weight:700; color:var(--text);">Add / Remove from Lists</h2>
          <p style="margin:4px 0 0; font-size:0.85rem; color:var(--muted);">Check to add, uncheck to remove.</p>
        </div>
        <button type="button" class="modal-close-x" aria-label="Close" id="selectListModalCloseBtn">&#x2715;</button>
      </div>
      <div id="selectListModalBody" style="display: flex; flex-direction: column; gap: 0; max-height: 55vh; overflow-y: auto; margin-bottom: 18px; padding-right: 4px;">
        <!-- Filled dynamically -->
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 10px; border-top: 1px solid var(--border); padding-top: 14px;">
        <button type="button" class="lc-btn secondary" id="selectListModalCancelBtn" data-act="closeSelectListModal">Cancel</button>
        <button type="button" class="lc-btn primary" id="addSelectedListsBtn" style="min-width: 90px;">Done</button>
      </div>
    </div>
  </div>

  <!-- Trakt Device Activation Modal -->
  <div id="traktDeviceModal" class="modal-overlay" role="dialog" aria-modal="true" aria-label="Connect Trakt" style="display:none; z-index: 10002; justify-content: center; align-items: center; position: fixed; inset: 0; padding: 16px; background: var(--color-bg-overlay);">
    <div class="modal-card" style="width: 100%; max-width: 420px; padding: 24px; background: var(--color-bg-elevated); border: 1px solid var(--color-border-strong); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); display: flex; flex-direction: column; text-align: center;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
        <h2 style="margin:0; font-size:1.25rem; font-weight:700; color:var(--text);">Connect Trakt</h2>
        <button type="button" class="modal-close-x" aria-label="Close" data-act="closeTraktDeviceModal">&#x2715;</button>
      </div>
      <p style="margin: 0 0 16px; color: var(--muted); font-size: 0.9rem;">To authorize your Trakt account without redirects or rate limits, enter the code below on Trakt:</p>
      
      <div id="traktDeviceCodeBox" style="background: var(--panel-strong); border: 2px dashed var(--accent); border-radius: 12px; padding: 16px; margin-bottom: 16px;">
        <div id="traktDeviceUserCode" style="font-size: 2rem; font-weight: 800; letter-spacing: 4px; color: var(--accent); font-family: monospace;">LOADING...</div>
      </div>

      <div style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px;">
        <a id="traktDeviceActivateLink" href="https://trakt.tv/activate" target="_blank" rel="noopener noreferrer" class="lc-btn primary" style="padding: 12px; font-weight: 700; text-decoration: none; display: flex; align-items: center; justify-content: center; gap: 8px;">
          Open trakt.tv/activate &#x2197;
        </a>
      </div>

      <div id="traktDevicePollingStatus" style="font-size: 0.85rem; color: var(--muted); display: flex; align-items: center; justify-content: center; gap: 8px;">
        Waiting for authorization on Trakt...
      </div>

      <div style="margin-top: 18px; border-top: 1px solid var(--border); padding-top: 14px;">
        <button type="button" class="lc-btn secondary" style="width: 100%;" data-act="closeTraktDeviceModal">Cancel</button>
      </div>
    </div>
  </div>

<script nonce="${CSP_NONCE_PLACEHOLDER}">
/* Chart data tables -- injected at render time for renderDiscoverChartsList */
window._CHARTS_TMDB = ${jsonForScript(TMDB_CHART_LISTS)};
window._CHARTS_TRAKT = ${jsonForScript(TRAKT_CHART_LISTS)};
window._CHARTS_TRAKT_BO = ${jsonForScript(TRAKT_BOXOFFICE_LIST)};
window._CHARTS_MDBLIST = ${jsonForScript(MDBLIST_OFFICIAL_CHARTS)};
window._CHARTS_SIMKL = ${jsonForScript(SIMKL_CHART_LISTS)};
window._CHARTS_SIMKL_ANIME = ${jsonForScript(SIMKL_ANIME_LIST)};
window._CHARTS_STREAMING_TOP10 = ${jsonForScript(STREAMING_TOP10)};
window._CHARTS_STREAMING_ALL = ${jsonForScript(STREAMING_ALL)};
window._CHARTS_KIDS = ${jsonForScript(KIDS_LISTS)};
window._CHARTS_HOLIDAYS = ${jsonForScript(HOLIDAY_LISTS)};
window._CHARTS_GENRES = ${jsonForScript(GENRE_LISTS)};
window._CHARTS_MY_LISTS_ADDON = ${jsonForScript(MY_LISTS_ADDON_CHARTS)};
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(function(reg) {
    if (reg) reg.update().catch(function() {});
  }).catch(function(e) { console.error(e); });
}
</script>

