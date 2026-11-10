# 07 Frontend, UI/UX and platform
Health grade: B+ — The UI is consistent, responsive at all five sizes with no horizontal overflow, keyboard-safe and handles most failures well. The problems found are small: wrong wording on server errors, some tap targets and contrast values just under the target, and a design-rule test that checks less than it claims.

## Scope covered (files, routes, commands run)
- Read in full: `docs/AI_UI_RULES.md`, `tests/design-system.test.mjs`. `docs/DESIGN_SYSTEM.md` by section (touch targets, tokens, known deviations).
- Ran the real Worker with `dev/server.mjs` on ports 8870/8871. Drove it with Playwright (Node scripts, all in `/tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s07/`).
- Pages crawled at 360x740, 390x844, 768x1024, 1280x800 and 1920x1080 (`crawl.cjs`, results in `crawl-results.json`, screenshots in `shots/`): `/discover`, `/catalogs`, `/lists`, `/channels`, `/search`, `/settings`, `/guide`, `/tv`, `/nuvio-tv-launcher`, `/link`, an unknown URL (404), `/admin` (login page), `/lists/auditui`. `/admin` after login was also checked at 360, 768 and 1280 (`admin.cjs`).
- Overflow check (scrollWidth vs innerWidth), tap targets (real hit-testing with `elementFromPoint`, `hit.cjs`), unnamed buttons and unlabelled inputs, console errors, failed requests and CSP messages on every page.
- Keyboard and focus: Tab loop through every main tab (`focus.cjs`), modal focus trap, Escape and focus return (`modal.cjs`, `modal2.cjs`).
- Contrast of rendered text in light and dark mode on 8 pages (`contrast.cjs`).
- Error, slow and empty states by failing the API with Playwright route interception (`errs.cjs`, `errs2.cjs`, `errs3.cjs`).
- State handling: delete then Undo a list, sign out in a second tab (`state.cjs`).
- Pairing page `/tv`: keyboard keys and a click with no code (`tv.cjs`, `tv2.cjs`).
- Mutation test of `tests/design-system.test.mjs` in a private copy (`repo/`, not the real tree).

## Fix progress

Updated 2026-11-10. Status values: `open`, `fixed (awaiting verification)`, `verified`, `failed verification`. To verify a row, run its check and change the status.

| Finding | Status | Commit | How to verify |
|---|---|---|---|
| UI-01 | fixed (awaiting verification) | ae33b9f | node --test tests/search-failure-message.client.test.mjs |
| UI-02 | open |  | needs a browser to regenerate tests/ui-contract.json |
| UI-03 | open |  | needs a browser to regenerate tests/ui-contract.json |
| UI-04 | open |  | needs a browser and an owner choice of text colour |
| UI-05 | open |  |  |
| UI-06 | open |  |  |
| UI-07 | open |  |  |
| UI-08 | open |  |  |
| UI-09 | open |  |  |

## Proven findings   (ordered by severity)

### UI-01 A failing search shows "No titles found." instead of an error
- Severity: Medium
- Status: Proven
- File:line: `src/client/19_client-search-and-likes.js:5547-5549` (titles) and `:5515` with `:5527-5530` (public lists)
- What is wrong: If the title-search request answers with an error (HTTP 500, or `ok:false`), the code treats it the same as an empty result and prints "No titles found." Only a network failure (an exception) prints "Could not load top titles." The same pattern is in the Lists search: a failed lookup is turned into `{ok:false, lists:[]}` and shown as "No published My Lists Addon lists available yet."
- Impact: When the server has a problem, the person sees a calm "nothing exists" message with no retry hint, and may think the catalogue is empty or that their filters are wrong. A real outage looks like an empty product.
- Proof: `/tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s07/errs3.cjs` (title-search route forced to 500):
  ```
  SEARCH 500 -> der All Ratings 8.0+ ⭐ 7.0+ ⭐ 6.0+ ⭐ 5.0+ ⭐ No titles found.
  ```
  Compare with the earlier run in `errs.cjs` where the request is aborted (network failure) and the page shows `✗ Could not load top titles.`
- Recommended fix and effort: When `!res.ok` or `data.ok === false`, show the same "Could not load top titles." message (with a Retry). Do the same for the public lists lookup. S.

### UI-02 Search page type pills have only a 31px tap area on phones
- Severity: Low
- Status: Proven
- File:line: `src/page/13_tab-channels.js:432` (the pill bar is given `u-p-0`); extension rule `src/page/09_page-shell.js:5198-5200`
- What is wrong: The design promises that pills keep a small look but get a 44px invisible hit area on phones. The pills bar on Search is a scrolling strip (`overflow-x:auto` makes `overflow-y` clip) with its padding forced to 0, so the invisible extension is cut off. The Movies / Shows / Lists pills are 74x31 and respond only inside that.
- Impact: On a phone these are the main controls of the Search page and are easy to miss with a thumb. Other pill bars (Lists, Catalogs, Discover) are not affected in the same measurement.
- Proof: `.../s07/hit2.cjs` at 360px:
  ```
  {"rect":[74,31,184],... "after":{"top":"-7px","bottom":"-7px","height":"43px"}, "above3":"DIV.panel", "below5":"DIV.search-filters-toolbar", "inside":"BUTTON.subnav-pill", "parent":"subnav-pills-bar u-m-0 u-p-0 u-fsh-0","ov":"hidden/auto"}
  ```
  A point 3px above the pill hits the panel, not the pill. `hit.cjs` also lists the three filter `<select>` elements on Search at 31px high (the rule says inputs are 44px high): `select#catalogSearchGenreSelect.search-filter-select ... 180x31`.
- Recommended fix and effort: Give that bar the same vertical padding the other pill bars have (so the extension has room), and give `.search-filter-select` the 44px minimum on phones. The test `UI-17` only checks that the CSS rule exists, so add a real hit-test or measurement. S.

### UI-03 The theme (light/dark) button is 35px on phones, with no extension
- Severity: Low
- Status: Proven
- File:line: `src/page/09_page-shell.js:5204` (extension list names `.header-icon-btn`, `.header-avatar-btn`, `button.modal-close-x`, `.search-clear-btn` but not `.theme-toggle-btn`); size at `:496`
- What is wrong: The theme toggle sits between the search button and the avatar. Those two get an invisible 4px extension (41px target); the theme toggle does not (35x35).
- Impact: Smaller than the 44px target the design sets, and smaller than its two neighbours. Easy to hit the wrong button.
- Proof: `.../s07/hit.cjs` output on every app page: `button.theme-toggle-btn.dark-mode-toggle "Toggle Light or Dark" hit 35x35` versus `header-search-btn hit 41x41`. Also the guide page: `button.theme-toggle-btn "Toggle Dark/Light Mo" hit 32x37`, and its contents pills (`a.toc-pill`) are 38px high.
- Recommended fix and effort: Add `.theme-toggle-btn` to the extension rule (it already uses `position:relative`). S.

### UI-04 Text on the active pill is below the 4.5:1 contrast the rules require
- Severity: Low
- Status: Proven
- File:line: `src/page/09_page-shell.js:1083-1089` (`.subnav-pill.active`, text `--accent` on `--color-brand-subtle`)
- What is wrong: The active pill is blue text on a pale blue wash. Against the light grey page it measures 4.11:1 (13.6px bold text, so the 4.5:1 rule applies). In dark mode the same pill and the "Simkl" source badge measure 3.76:1. The TMDB source badge in light mode is 4.35:1; the guide's "No Key Required" tag is 3.68:1 (light) and 4.01:1 (dark).
- Impact: The currently selected tab/filter on almost every page is a little hard to read for people with low vision, and the app's own rule 9 ("Contrast >= 4.5:1") is broken on its most repeated component. The existing contrast tests only cover solid brand fills and danger buttons, so this passed.
- Proof: `.../s07/contrast.cjs` (computes text colour against the real blended background in a browser), trimmed:
  ```
  ## light /lists: 1
     4.11 button.subnav-pill.active "✓ My Lists" rgb(0, 102, 214) on rgb(213,225,243) 13.6px
  ## dark /discover: 1
     3.76 span.list-source-badge.badge-simkl "Simkl" rgb(10, 132, 255) on rgb(25,47,71) 10.88px
  ## dark /search: 3.76 button.subnav-pill.active ...
  ```
  Computed style of the pill: `color rgb(0,102,214)`, `background rgba(0,102,214,0.12)`. Over `#F2F2F7` that is the 4.11 above (over a white panel it is 4.56, which is why it looks fine in cards).
- Recommended fix and effort: Use a darker `*-text` token for the text on `--color-brand-subtle` (as the rules already do for warn/danger), and add the pill and badge pairs to the contrast test. S.

### UI-05 Many buttons have identical names, so a screen reader cannot tell them apart
- Severity: Low
- Status: Proven
- File:line: card buttons are built in `src/client/19_client-search-and-likes.js` and `src/client/22_client-creator-profile.js`; the Quick Add "+ Shows" / "+ Movies" buttons are in the page markup (`data-act="addRow"`, served in `/`)
- What is wrong: The Like and Customize buttons carry an `aria-label` naming the list, but "+ Add", "Remove", "See All ›" and "Retry" do not. A person using a screen reader hears "+ Add, button" 17 times on Discover with no list name.
- Impact: Screen-reader and voice-control users cannot tell which list a button belongs to ("click Remove" matches 23 buttons). The home page also contains 139 "+ Shows" buttons that differ only by the catalogue they sit next to.
- Proof: `.../s07/names.cjs` and `names2.cjs`:
  ```
  /discover Like this list x40 (with aria-label/desc: 40) | Customize in List Builder x40 (40) | + Add x17 (0) | Retry x9 (0) | Remove x23 (0)
  /catalogs See All › x9 (with aria-label/desc: 0)
  <button type="button" class="lc-btn list-add-btn primary searchAddBtn" data-name="New on Streaming" data-url="tmdb:new-on-streaming" data-type="movie">+ Add</button>   (no aria-label, no title)
  ```
  `curl http://127.0.0.1:8870/ | grep -c '+ Shows'` gives 139.
- Recommended fix and effort: Add `aria-label="Add <name> to my lists"` / `Remove <name>` etc. where these buttons are built (the data-name is already there). S-M.

### UI-06 Six dialogs do not return keyboard focus to the button that opened them
- Severity: Low
- Status: Proven
- File:line: `src/client/16_client-row-core.js:2236-2290` (static modal handler, Escape and Tab only) and `src/client/22_client-creator-profile.js:6113-6118` (`closeCreateListModal`). `showModal()` does it right (`_modalReturnFocus`, `16_client-row-core.js:2298-2331`).
- What is wrong: Create list, Select list, Add shelf, Import list, Import channel and the Trakt device dialog are fixed markup. They trap Tab and close on Escape correctly, but when they close, focus drops to the page body instead of going back to the button used to open them.
- Impact: Keyboard and screen-reader users lose their place on the page after every one of these dialogs and must Tab from the top.
- Proof: `.../s07/modal.cjs` (focus the "+ Create List" button, press Enter, Tab around, press Escape):
  ```
  tab3 {"active":"BUTTON#.lc-btn secondary Cancel", ...}   (focus cycles inside: trap works)
  after-esc {"active":"BODY#.hide-badge-imdb-rating Lists ..."}   (focus is on BODY)
  ```
- Recommended fix and effort: Remember `document.activeElement` when a static modal is opened and focus it again in `closeStaticModal` and the specific close functions. S.

### UI-07 `/tv` shows an enabled "Link TV Now" button even when there is no pairing code
- Severity: Low
- Status: Proven
- File:line: `src/api/25_api-catalog-routes.js:972` (click handler), `:1030` (button markup)
- What is wrong: Opening `/tv` or `/link` without `?code=` shows "PAIRING CODE —" and an enabled blue "Link TV Now" button. Pressing it says only "Missing pairing code." There is no hint where the code comes from (the TV).
- Impact: A person who opens the page from a bookmark or a typed address gets a dead end.
- Proof: `.../s07/tv2.cjs`:
  ```
  disabled? false
  ... PAIRING CODE — Signed in as auditui Link TV Now Cancel Missing pairing code.
  ```
- Recommended fix and effort: When there is no code, disable the button and say "Open this page from the code shown on your TV." S.

### UI-08 The design-system test lets several rule breaks through
- Severity: Low (process risk, not a user bug)
- Status: Proven
- File:line: `tests/design-system.test.mjs:16-21` (drops every `.u-*` line), `:72-79` (hex only), `:351-373` (script checks cover `src/client/` only)
- What is wrong: `AI_UI_RULES.md` forbids hard-coded rgba, odd pixel values (5/7/9/11/13px) and new radii, and says buttons are pills. The test checks only hex colours, rem font sizes, breakpoints, `transition: all` and a few contrast pairs. There is no allowlist hiding hex colours in the component CSS (it really is 0), but rgba, odd pixels, radii and `!important` count are not checked at all.
- Impact: The rule document says one thing and the test enforces less, so a future change can add rule-breaking CSS and still show "ALL CHECKS PASSED". It already exists in the product:
  - 56 hard-coded `rgba(...)` values sit in component CSS outside the token block (for example `.bottom-nav`, `.cw-remove-btn`, `.channel-crossover-chip`, `.list-source-badge.badge-tmdb`).
  - Two Settings danger-zone buttons (Reset Account Data, Delete Account) are hand-styled with `u-bg-v_color_warn_fill u-br-v_radius_sm` instead of `.btn-danger`, so they are rounded rectangles, not pills (`src/client/22_client-creator-profile.js:631` and `:636`).
  - Component CSS has 242 `!important` (the rules say "about 241 remain; don't add").
- Proof (mutation, in a private copy, real tree untouched): in `repo/src/page/09_page-shell.js` I changed `.subnav-pill.active` to `background: rgba(12, 34, 56, 0.5); padding: 7px 13px; margin: 5px; border-radius: 9px;` (a hard-coded colour, three odd pixel values and a new radius), ran `python3 build.py`, then:
  ```
  node --test tests/design-system.test.mjs
  # tests 28
  # pass 28
  # fail 0
  ```
  Count commands: `python3` over `curl localhost:8870/app.css` gives `rgba outside root: 56`, `!important comp: 242`.
- Recommended fix and effort: Add a ratcheting count test for rgba literals, odd pixel values and non-token radii in the component CSS (baseline = today's numbers, may only shrink), as is already done for source size. M.

### UI-09 Server error text is shown to people as-is, without the "Could not ..." wording
- Severity: Info
- Status: Proven
- File:line: `src/client/22_client-creator-profile.js:4831` (prints `data.error` from the server; only falls back to "Could not load your lists." when the server sends no text); shown by `.../s07/errs.cjs`
- What is wrong: When the lists request fails with HTTP 500, the page prints the server's own message after a cross: `✗ boom` / `✗ db down`. Rule 8 says errors start with "Could not ...". Network failure prints a proper "Network error loading your lists."
- Impact: Cosmetic. Today the server's message is short; if it ever sends technical text, the person sees it.
- Proof: `errs.cjs` (all API calls fail with 500): `... Refresh ✗ boom Your MDBList Lists ...`; `errs3.cjs`: `... Refresh ✗ db down ...`.
- Recommended fix and effort: Prefix with "Could not load your lists." and show server text only as a detail. S.

## Unproven suspicions   (not counted)
- The auto-tracked "Continue Watching" card shows the type label "Shows" (screenshot `shots/_lists-360.png`, label code `src/client/22_client-creator-profile.js:5375`), while the app's own blurb for that list says it holds "movies part way through and the next episode of your shows" (`src/client/17_client-my-lists-and-trakt-oauth.js:2094`). I could not produce a movie in that list in the stubbed environment (outbound providers return nothing), so the wrong label is not shown on screen. If movies can appear there, the label is wrong for them.
- Every page load of a person who has the Account Key but no session logs three 401 console errors (`/api/connections`, `/api/connections/stremio/settings`, `/api/connections/nuvio/settings`, plus `/api/me`). They are probably the designed "not connected" answer (no user-visible effect), but I did not trace whether the session cookie is simply not being issued in this local setup.
- TV-remote arrow-key navigation: the `/tv` and `/nuvio-tv-launcher` pages are phone/desktop web pages, not a lean-back TV UI. Arrow keys do nothing there and Tab works; I did not treat that as a bug.

## Checked and rejected  (suspected, turned out handled; say what guard handles it)
- Horizontal overflow: none on any page at any of the five sizes (`documentElement.scrollWidth - innerWidth` is 0 or negative on all 70 page/size combinations in `crawl-results.json`).
- Hard-coded hex colours in component CSS: really zero (the test is not hiding anything; only rgba is missed, see UI-08).
- "Second set of :root variables" on `/tv`, `/guide`, `/admin`: each page inlines the single `DESIGN_TOKENS_CSS` block (198 variables, same names), not its own palette.
- Missing focus rings: Tab through Lists, Settings, Discover, Catalogs, Channels and Search found 0 focus stops without an outline or ring (`focus.cjs`).
- Modal focus trap and Escape: work for both `showModal()` dialogs and the static dialogs (Tab cycles inside; Escape closes). Only focus return is missing (UI-06).
- Danger/Reset buttons "with no name" and "2.66:1 red text" on Settings: those were inside a closed `<details>`; the buttons have text ("Reset Account Data", "Delete Account & All Data") and the red text is not visible until opened.
- Stale UI after delete + Undo: deleting a list removes the card, Undo brings it back and the server list matches (`state.cjs`: server `['Watchlist']` after delete, `['Watchlist','Audit Movies']` after Undo).
- Sign out in another tab: the first tab reloads and shows the signed-out state (`src/client/20_client-cross-tab.js`; `state.cjs` shows `name null`).
- Empty and failure states on Discover, Catalogs: per-shelf "Couldn't load previews for this list. Retry" / "✗ Could not load this catalog. Retry", and "Loading…" while slow. Channels page lists are fed from account sync data, so a failed sync shows the normal empty state with no error (same family as UI-01 but I could not show data loss; no overwrite happened: after the failed load only `POST /api/creator/restore` (59 bytes) was sent, no save of an empty state).
- CSP violations: none on the real origin. (On `localhost` the dev server writes `127.0.0.1` URLs into the page and the browser blocks the icon; that is the dev server only.)
- Wording: no movie is labelled "show" or "episode" in the shell HTML or the rendered tabs. "Episodes" appears only in the Watch History / Continue Watching filters and channel settings where episodes exist.
- Console errors and failed requests on all pages: apart from the 401 noise above and the expected 404 on the 404 page, none.

## Done well (do not change)
- No page overflows sideways from 360px to 1920px; 404, Admin and pairing pages look tidy at 360px (screenshots in `shots/`).
- Modal handling: focus moves to the dialog heading, Tab is trapped, Escape closes, the dialog is named (`aria-labelledby`), scroll is locked and restored.
- Delete list is confirmed, then offers Undo, and the server state matches the screen after each step.
- Failure handling on Discover, Catalogs, Lists and Search (network failure) is clear and has Retry buttons; slow loads show "Loading…".
- All icon-only buttons found have accessible names; no form input without a label on the app pages.
- One shared token block is reused by every page, and no component CSS contains a hex literal.
- The cross-tab sign-out reload prevents the old account being used in a stale tab.

## Not audited and why
- Real Stremio/Nuvio/Wako behaviour, provider connect screens (Trakt, MDBList, TMDB, Simkl) and anything needing real third-party responses: the local server stubs all outbound calls, so lists show empty content. Because of this, item cards with posters, list detail pages and the Watch History views were seen only in empty form.
- Channel builder wizard (13,000-line file) beyond load, empty state and failure: not driven step by step.
- `tests/ui-contract.mjs` in the private copy: it failed to start (`ERR_MODULE_NOT_FOUND`, probably because `node_modules` was not copied), so I did not use it as evidence.
- Admin sub-tabs after login were loaded and checked for overflow, labels and errors at three sizes, but not every admin action was clicked.
- Pixel-level visual regression and print styles.
