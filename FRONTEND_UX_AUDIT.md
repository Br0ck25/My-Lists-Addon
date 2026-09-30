# Frontend and UX Audit

**Date:** 2026-09-25 · **Status:** findings only; nothing changed.

**Method:**

- Ran the real Worker locally (repo harness `audit/frontend-2026-09-13/server.mjs`; upstream providers stubbed, so charts render empty) and walked it in a browser at 1280×800 and 375×812: landing, Catalogs (My Catalogs, Quick Add, Bulk Add, "+ New Catalog", Generate Install Link), Lists (+ Import), Channels, Discover, Search, Settings (Account & Sync), and the Create Account modal.
- Read the client source (`09_`–`24_`).
- Checked counts in the source.

**Limits.** With stubbed upstreams I could not judge poster-heavy layouts with real data, OAuth round trips, or real-device performance. Findings that depend on these are marked "verify".

**Severity scale:**

| Severity | Meaning |
|---|---|
| Critical usability | Blocks or misleads a core job for most users |
| High | Frequent friction or confusion |
| Medium | Noticeable, narrower |
| Low | Minor |
| Polish | Consistency and finish |

Nothing here recommends redesigning for its own sake. Each item is a concrete problem with a proposed change.

---

## 1. Inventory of the current UI

- **Top navigation:** Catalogs · Lists · Channels · Discover · Search · Settings, plus Login and a theme toggle. On mobile these six become a bottom tab bar.
- **Second-level "pills" on every tab:**

  | Tab | Sub-tabs |
  |---|---|
  | Catalogs | My Catalogs / Quick Add / Bulk Add |
  | Lists | My Lists / Liked / Import |
  | Channels | My Channels / Storylines & Universes / Quick Add / Explore Channels / Import |
  | Discover | All / Movies / Shows / Popular Lists / Curated / Hidden Gems / Kids / Holidays / Genres |
  | Settings | Account & Sync / External Accounts & API Keys / Presets & Backup / Feedback and Support |

- **Overlays:** list details, item details, Add Catalog, Create Account, Login, Restore, delete confirmations, merge channels, the channel builder wizard.
- **Also in the running app:** an "Update Link" button in the header (even for a first-time visitor), "Live Preview & Editor" with drag reordering, and an install result card (Install in Stremio / Install in Nuvio / Stremio Web / manifest link / manual steps).
- **Scale:**
  - About 4,000 DOM elements are live at once: **754 buttons, 189 inputs**.
  - **124 native `alert()` calls** and 2 `confirm()`, against 6 toast references.
  - 76 `aria-label`s, 3 `:focus-visible` rules, 1 `prefers-reduced-motion` block.
- **Vocabulary counts in the UI source:**

  | Term | Occurrences |
  |---|---|
  | "Catalog" | 279 |
  | "shelf" | 452 |
  | "Row" | 180 |
  | "Custom List" | 110 |
  | "Channel" | 1,272 |
  | "Preset" | 228 |
  | "Import" | 154 |
  | "Sync" | 575 |
  | "Profile" | 77 |
  | "Creator Profile" | 17 |
  | "Account Key" | 9 |
  | "Creator Key" | 5 |

---

## 2. Critical usability

### UX-C1 — Every change requires a new install link and a reinstall

- **Evidence:**
  - The app's own guide: "Your install link encodes your configuration at the time it was generated. Go to Catalogs and click Update Link, then reinstall using the new link."
  - `/api/save` always mints a new id (`25_:7110-7118`). "Update Link" is permanently in the header.
  - Some edits propagate live and others don't. Account-backed custom lists read live items when the payload names a creator slug (`05_:1573-1582`); local lists, channel payloads, settings, badges, BetterPosters, dedupe and region are frozen into the link.
- **Impact.** This is the product's core loop (change something, see it in Stremio), and it silently fails. Users don't know which changes need a reinstall. Stremio, Nuvio and Wako users must remove and re-add the add-on each time.
- **Proposed.** One stable install per device or app (NEXT_VERSION_ARCHITECTURE §3.2, "installs"). All edits are live. The install panel says "Your changes appear in Stremio automatically." A reinstall is needed only when the *set* of rows changes and the client caches manifests; in that case show a single "Refresh add-on in Stremio" hint with the reason.

### UX-C2 — No first-run path; the primary job is buried

- **Evidence (walkthrough):**
  - A new visitor lands on whatever tab was last active; with nothing stored, that was Discover. There is no explanation of what the product does or of the three-step job (pick lists, install, done).
  - The Catalogs tab arrives **pre-filled with 8 catalogs** the user didn't choose.
  - **"Generate Install Link" is at the very bottom** of the Catalogs list, after every row, next to **"Remove All"**.
  - The header shows "Update Link" to someone who has never generated one.
- **Impact.** People reach the install step late, or not at all, and may install a catalog full of defaults they didn't pick.
- **Proposed:**
  - A first-run home: "Build your Stremio home screen", with three cards (Add a list link, Pick from popular charts, Sign in to restore).
  - A persistent install bar (bottom on mobile, header on desktop) showing the install state ("Not installed" / "Installed in Stremio · changes are live").
  - Defaults offered as a one-click "Starter pack", not preloaded.
  - "Remove All" moved into an overflow menu, with a confirmation.

### UX-C3 — Accounts are hard to understand and easy to lose

- **Evidence:**
  - "No email. No password. Just a username and key." The key is shown once.
  - The recovery answer is optional ("If you ever lose your key, this is the only way back in besides contacting us").
  - Terminology varies: "Create Free Account", "Creator Profile", "Profile", "Account Key", "Creator Key", "Login", "Restore".
  - Data lives in the browser and syncs in the background. Other devices can resurrect deleted data (the tombstone machinery in `02_:2087-2242` and the reset marker in `02_:3371-3435` exist because of this).
- **Impact:**
  - Users who clear browser data or lose the key lose access.
  - Multi-device users see conflicts and "undo" effects.
  - Support load grows with the user base.
- **Proposed:**
  - One term: **Account**.
  - Sign-in with username plus a recovery **key** that the browser offers to save in its password manager (a real `<form>` with `autocomplete`).
  - After sign-in, a session; devices listed in Settings.
  - Optional email for recovery (a future step).
  - One-time recovery codes instead of a free-text answer (SECURITY S-11).
  - Server-authoritative data: no "sync" concept exposed to users.

---

## 3. High

| ID | Problem | Evidence | Proposed |
|---|---|---|---|
| UX-H1 | **Too many overlapping nouns.** Catalog vs List vs Custom List vs Channel vs Shelf vs Row vs Preset vs Collection. "+ Add" means "add to catalogs" on list cards and "add item" elsewhere. | Vocabulary counts above. The Lists tab's Watchlist card shows "Edit" and "+ Add". | Three nouns. A **List** is a collection of titles, yours or from a provider. A **Channel** is a playable schedule of episodes. **Your home screen** is the ordered rows shown in Stremio. Buttons say what they do: "Add to home screen", "Add title". |
| UX-H2 | **Seven "Import" surfaces with different meanings:** Catalogs › Bulk Add; Lists › Import › "Import list from a link"; Channels › Import › "Import channel from a link"; Settings › Presets & Backup › "Import JSON"; "Import from Install / Configure Link"; per-provider "Connect … to import your personal lists"; Lists › Import › file "Import List (CSV/JSON)". | `find "Import"` on the running page returned 20 matches across these surfaces. | One **"Add" entry point** (paste links: one or many, list or channel, detected automatically), one **"Import file"** (CSV/JSON/Letterboxd zip, as a background job with progress), and one **"Restore"** (sign in, or a backup file). Connect-provider stays in Settings › Connections. |
| UX-H3 | **Adding one list is inconsistent.** "+ New Catalog" demands a *name* first, then a URL, then a manual Movies/Series choice. Bulk Add auto-detects all three from the URL. | Add Catalog modal vs the Bulk Add panel (walkthrough) | Paste-first: the URL field is the only required input; name, type and item count come from a server preview; the user may rename. |
| UX-H4 | **Settings › "Account & Sync" is a 3,000 px page of unrelated controls:** watchlist behavior, hidden lists, region, trending, duplicates, adult filter, BetterPosters, badges, watch history, auto-track and scrobbling (10 sections, 28 inputs; 4,300 px on mobile). | Walkthrough; `15_tab-settings-html.js` | Split by what users are configuring. **Home screen** (region, duplicates, adult filter, shuffle, posters and badges). **Tracking** (auto-track, scrobble, watchlist removal, clear history). **Account** (profile, devices, export, delete). **Connections** (Trakt, Simkl, MDBList, TMDB, API keys). Each setting says whether it affects the website, Stremio, or both. |
| UX-H5 | **Blocking native dialogs as the main feedback channel** (124 `alert()`) | Code count | A toast and inline-message system for success and non-critical errors. An accessible modal only for decisions. |
| UX-H6 | **Preview doesn't load by itself.** Rows show "Click 'Refresh Preview' above to load posters" and "Loading…" | Walkthrough (Catalogs) | Lazy-load visible rows automatically; show skeletons; errors inline per row with "Retry". |
| UX-H7 | **Destructive action next to the primary action:** "Remove All" beside "Generate Install Link" | Walkthrough | Move destructive bulk actions into an overflow menu; confirm with the count ("Remove 8 catalogs?") and offer undo. |
| UX-H8 | **Provider connections are scattered and permanent.** The Lists tab always shows four "Your MDBList/Trakt/TMDB/Simkl Lists" panels with Connect buttons. Settings has a separate External Accounts page. Tokens expire without warning (no refresh; BACKEND_AUDIT BE-H08). | Walkthrough; the `17_` OAuth code | One Connections page. Lists shows connected providers' lists only. A banner when a connection needs re-authorization. |
| UX-H9 | **API keys asked of end users.** "External Accounts & API Keys" invites users to paste TMDB, MDBList and Trakt keys and Client IDs, which is technical and mostly unnecessary on a hosted service. | Settings sub-tab label; `collectKeys` (`23_:453`) | Hide behind "Advanced: use my own API key" with an explanation of why someone would want to. |
| UX-H10 | **Local-versus-synced state is invisible.** Lists and channels may exist only in this browser (`myListAddon:localCustomLists`, `localChannels`) or on the account; conflicts surface as 409 errors or silent merges. | `22_`, `24_` | Server-authoritative data; a signed-out mode states plainly "Saved in this browser only — sign in to keep it". |

## 4. Medium

| ID | Problem | Evidence | Proposed |
|---|---|---|---|
| UX-M1 | **Active tab indicator got out of sync once.** After clicking Catalogs from Discover, the Discover pill stayed highlighted while Catalogs content showed (desktop). **Verify.** | Walkthrough screenshot | One router owns the active state. |
| UX-M2 | Landing tab is whatever was last used (`myListAddon:activeTab`), so `/` isn't a stable home. | `09_`, `22_` | `/` is the home view; deep links use real paths (`/lists`, `/channels`, `/settings/...`). |
| UX-M3 | **Mobile: two navigation layers** (bottom tab bar plus horizontally overflowing pills). Pill labels are cut off ("External Accounts & API K…") with no scroll affordance. | 375 px walkthrough | Fewer sub-sections (UX-H4); on mobile, sub-navigation as a segmented control or list, with no overflow. |
| UX-M4 | **Empty states show full tooling.** Channels with zero channels still shows the whole "Merge Saved Channels into One Catalog" form. | Walkthrough | An empty state with one primary action ("Create your first channel" / "Pick a TV network") and advanced tools hidden until relevant. |
| UX-M5 | **Positioning is out of date:** page title "Self-Hosted Stremio Catalogs…", guide text about self-hosting, "Worker owner" error strings (29). | Walkthrough; source | Product copy for the hosted service (FT-11). |
| UX-M6 | **Operator language in user errors:** "the Worker owner needs to set TMDB_API_KEY", "binding a KV namespace named CONFIGS", "manifest link", "Client ID". | `04_:421`, `04_:471`, `24_:2233`, `25_:3292` | Plain messages ("Trakt search is temporarily unavailable"); technical detail in the admin view. |
| UX-M7 | **Channel builder complexity:** 5 sub-tabs (My Channels, Storylines & Universes, Quick Add, Explore, Import), about 13,000 lines of client code, many modes (rotation, story lock, part grouping, next-up). | `13_`, `20_` | Progressive disclosure: templates first (TV network, franchise, person, "from a list"); "Advanced schedule" collapsed. |
| UX-M8 | **"Duplicate items across lists" is hidden and imprecise.** It lives in Settings, its effect depends on row order, and it only dedupes within the same page window. | `15_`; `05_:270-329` | Put the toggle in the home-screen editor next to row ordering, with an inline explanation ("Titles already shown in a row above are hidden"). v2 makes it exact per page (materialization). |
| UX-M9 | **Save state for list edits.** Edits are saved optimistically to `localStorage` and synced later; a failed sync is silent (prior FE-001 pattern). | `22_` | Explicit states: Saving… / Saved / Couldn't save (Retry). |
| UX-M10 | **Playback auto-track marks items watched at playback start.** Users see episodes marked watched after sampling them. | BACKEND_AUDIT BE-M06 | Explain the rule in the setting; adopt a better signal. |
| UX-M11 | **Letterboxd and CSV import require keeping the tab open** (client re-post loop), with no review of mismatches. | `18_:956-1010` | Background import job with a progress page and a review step (FT-01). |
| UX-M12 | **Keyboard and focus.** Only 3 `:focus-visible` rules; custom controls rely on inline `onclick` on non-button elements in places; modals' focus handling is custom per modal. | `09_` CSS, handler scan | One accessible modal and dialog component (focus trap, Escape, return focus); visible focus everywhere; an axe check in CI. |

## 5. Low and polish

- Button styles vary: pill primary, outlined, text links, and blue text "Add" in the Add Catalog modal. Define primary, secondary, tertiary and destructive variants.
- Card patterns differ between Discover cards (heart, "+ Add", "Customize"), list cards (Edit, + Add) and channel cards.
- Theme toggle and Login share the header with "Update Link", which disappears in the new model.
- Iconography: the mix of emoji (⚠, ✓) and SVG icons should be unified.
- "Refresh" buttons on sections (Your Custom Lists › Refresh, Merge › Refresh list, Refresh Preview) should be unnecessary with a live data layer.

---

## 6. Frontend engineering findings (they drive the UX problems)

| ID | Finding | Consequence | Proposed |
|---|---|---|---|
| FE-1 | The client (about 44k lines in `16_`–`24_`, plus about 5.5k lines of page shell and tab HTML) is a string inside a server template literal. Backslashes and `${` must be escaped (for example `'\\\'s'`, `/^https?:\\/\\//i` in `24_:2233-2242`). | Syntax-class bugs reach production (the admin page outage is recorded in CI comments). No lint or type tooling on client code. | Keep the template literal (D-11). Rely on `render_check.js`, `html_checks.py` and `scope_check.mjs` in CI, and write client code that needs no backslashes where possible (NEXT_VERSION_ARCHITECTURE §7.1). |
| FE-2 | About 820 global functions and about 134 top-level `let`/`var` globals across 9 files; 733 inline `on*=` handlers called globals by name. **Fixed (the handlers): 0 left on either page** -- P6-8 converted the builder's ~470 and P6-10 /admin's 76 to `data-act` + one delegated listener, and `html_checks.py` now fails the build on an inline handler whatever the event is called. | Hidden coupling was the handlers' failure mode -- a renamed action is now checked instead of silently dead. `'unsafe-inline'` is still needed for the inline `<script>` blocks (P7-1). | The globals are still globals (D-11 keeps the classic-script bundle); a strict CSP waits on P7-1 |
| FE-3 | `localStorage` is the data store (about 650 references, about 80 keys) including credentials. | Security (S-05), resurrection bugs, slow UI on large accounts | Server-authoritative API plus an in-memory cache; preferences only in `localStorage` |
| FE-4 | All views are rendered into the DOM at load (754 buttons). | Memory, first paint, and hidden views running logic | A router with per-view render and unmount |
| FE-5 | 326 `innerHTML` writes with per-site escaping | XSS risk; lost focus and scroll on re-render | Escape by default: every dynamic string through `escapeHtml` / `escapeAttr`, and `textContent` for plain text |
| FE-6 | One 2.0 MB bundle for all users | Slow first load on mobile (PERFORMANCE PF-F1) | Keep one bundle (no build step, D-11). `/app.js` is cached long-term, so the cost is paid once per release. Trim unused code as views are reworked. |

**Recommended frontend approach (D-11: vanilla JavaScript, no framework, no build step).** The client stays in `09_`–`24_` inside the one pasted Worker file:

- Small shared pieces in vanilla JavaScript: a history-API router for the tabs, one toast system, one accessible modal, and a fetch-based API client with a small cache.
- Escaping by default, through the existing `escapeHtml` / `escapeAttr` helpers, with `textContent` for plain text.
- Event delegation replacing inline `on*=` handlers as each view is reworked.

Migrate view by view. Start with the install bar and Settings, which are the smallest, then Lists, then Catalogs/home screen, then Channels (largest, last). The existing modules keep running beside the new ones until each view is replaced.

---

## 7. Phase 10 — UX flow audit (new user)

"Now" was counted in the running app and source. "Proposed" assumes the v2 model (stable install, server data, paste-first add).

### Scenario 1 — "I want to add one MDBList"

- **Now** (about 9 steps, 3 decisions):
  1. Open the site (lands on Discover).
  2. Go to Catalogs.
  3. See 8 catalogs you didn't add.
  4. "+ New Catalog".
  5. Type a name.
  6. Paste the URL.
  7. Choose Movies or Series.
  8. Add, then scroll past every row.
  9. "Generate Install Link", then "Install in Stremio".
  - Optional: "Remove All" to drop the defaults.
  - **Stuck points:** what name? which type (mixed lists?)? why 8 other rows?
- **Proposed** (3 steps):
  1. Paste the link into the home "Add a list" box. The server previews it: "Top Horror 2026 · MDBList · 120 movies".
  2. Click "Add to home screen".
  3. The first time only, "Install in Stremio" from the install bar.
- **Removed:** name, type, defaults and bottom-of-page install.

### Scenario 2 — "I want to add 20 lists"

- **Now:** Catalogs › Bulk Add › paste 20 URLs › "Add All Lines as Catalogs" › scroll › Generate Install Link. It works, but there's no per-line result, failed lines are unclear, and it's another reinstall if you already had the add-on.
- **Proposed:** the same paste box accepts many lines and shows a review table (detected name, type, count, ✓ or error per line, drag to order). "Add 18 lists" (2 failed, with reasons). Live in Stremio.

### Scenario 3 — "I want to prevent duplicates between my lists"

- **Now:** find Settings › Account & Sync › "Duplicate Items Across Lists", toggle it, understand that row order decides, then Update Link and reinstall. The effect is approximate beyond page 1.
- **Proposed:** in the home-screen editor, a toggle "Hide titles already shown in rows above" directly above the reorderable rows. Changes apply live. The v2 materializer makes it exact for the first page of every row.

### Scenario 4 — "I want to create a custom list"

- **Now:**
  1. Lists › "+ New List", then name it.
  2. Go to Search (another tab), search a title, "Add to list", choose the list, and repeat for each title.
  3. Back on Lists, "+ Add" (to catalogs).
  4. Update Link and reinstall.
  - Signed-out lists live only in this browser.
- **Proposed:** "New list", then the list editor with an inline search box ("Add titles…") and instant add. A toggle "Show on my home screen". Visibility: Private / Unlisted / Public. Saved to the account.

### Scenario 5 — "I want to import a Letterboxd list"

- **Now:** Lists › Import › choose the target list › upload the CSV or zip. It is parsed in the browser (`fflate` from jsDelivr), then titles are resolved 200 at a time with server budgets and a re-post loop; the tab must stay open. There is no review of wrong matches. Then add the list to catalogs, Update Link, reinstall. (A Letterboxd *URL* can't be imported directly; there is no API.)
- **Proposed:** "Import file" (Letterboxd zip or CSV, IMDb CSV, Trakt export). The server job shows progress ("Matched 412 of 430"), and a review screen resolves ambiguous or missing titles. The user can leave and get a notification. The result is a list; one toggle adds it to the home screen.

### Scenario 6 — "I want to create a channel"

- **Now:**
  1. Channels › "+ New Channel" (a builder with many options), **or** Quick Add networks, **or** Storylines & Universes, **or** Import from a link.
  2. Build the episode pool (client-side TMDB traversal) and save.
  3. Merged channels need the separate Merge panel.
  4. Update Link and reinstall.
- **Proposed:** "New channel" › choose a template (TV network · Franchise or universe · Actor or creator · From a list · Custom) › a preview of today's lineup › "Add to home screen". Advanced scheduling (rotation, story lock, episodes per show) sits under "Schedule options". The pool builds as a server job; the preview updates when it's ready.

### Scenario 7 — "I want to share a list"

- **Now:** requires an account. Set the list to Public in its editor, then copy `/lists/{user}/{slug}`. Channels use a different mechanism: share code `/channel/{code}` (unlisted) versus "publish" to Explore (needs an account). Two sharing models.
- **Proposed:** one "Share" button on lists and channels. Visibility: Private / Unlisted (anyone with the link) / Public (listed in Explore). Copy the link, or open the preview page. The same model for both.

### Scenario 8 — "I want to find someone else's public list"

- **Now:** Search › Lists (searches providers plus the directory, with special-case handling of "my lists" queries) **or** Discover › Popular Lists (MDBList, Trakt) **or** Explore Channels (channels only). The directory sorts by likes; likes can be inflated (SECURITY S-09).
- **Proposed:** one Explore page with source filter chips (My Lists community · MDBList · Trakt · TMDB) and sort options (Popular · New · Most added). Search-as-you-type through FTS. The list preview has an "Add to home screen" button.

### Scenario 9 — "I want to edit a list I previously created"

- **Now:** Lists › My Lists › Edit (a modal). Changes save locally, then sync. On a second device, conflicts produce 409 errors or merges. Whether Stremio shows the change depends on whether the install link references the account list (live) or embedded a snapshot (needs Update Link).
- **Proposed:** open the list page, edit inline, and see "Saved". It is always live in Stremio. Concurrent edits are handled per item (add and remove never conflict; renaming uses a version check with a friendly "This list changed on another device — reload?").

### Scenario 10 — "I want to install my configuration into Stremio/Nuvio/Wako"

- **Now:** Generate Install Link (bottom of Catalogs) › Install in Stremio (`stremio://`) / Install in Nuvio (`nuvio://`) / Stremio Web / copy the manifest URL plus Wako manual steps. The result card is clear. **The problem is that it repeats after every change (UX-C1).**
- **Proposed:** an install bar with "Install in Stremio", "Install in Nuvio", "Other apps" (copy the link, Wako steps) and "Manage installs" (name, last used, revoke). Done once per app.

### Scenario 11 — "I want to restore my configuration"

- **Now:** three different mechanisms:
  - Login with username and key ("Restore");
  - Settings › Presets & Backup › Import JSON;
  - "Import from Install / Configure Link", which also fetches OAuth tokens from the link.

  After a key loss, the only way back is the recovery answer.
- **Proposed:** "Sign in" restores everything (server-side). "Import backup file" for people without an account (it becomes an account on import). Lost key: recovery code or email (UX-C3). Install-link import is removed (SECURITY S-02).

### Scenario 12 — "I want to connect Trakt/Simkl"

- **Now:**
  1. Lists › "Connect Trakt" **or** Settings › External Accounts & API Keys (the device-code flow is an alternative).
  2. OAuth redirects back with the token in the URL fragment, and the token is stored in the browser.
  3. For Stremio rows to use it: Update Link and reinstall (the token is copied into the config).
  4. When the token expires, the rows go empty with no message.
- **Proposed:** Settings › Connections › "Connect Trakt" › OAuth › "Connected as @user". The server stores and refreshes the token. Personal Trakt rows work immediately in Stremio. If re-authorization is needed, a banner appears on the website and the row shows a single "Reconnect Trakt on mylistsaddon.com" tile.

### Summary of flow changes

| Scenario | Steps now | Steps proposed | Main removal |
|---|---|---|---|
| 1 Add one list | about 9 | 3 | Name/type prompts, reinstall |
| 2 Add 20 lists | about 6 plus reinstall | 3 | Reinstall; unclear failures |
| 3 No duplicates | 5 plus reinstall | 1 | Hidden setting, reinstall |
| 4 Custom list | about 8 plus reinstall | 4 | Tab hopping, reinstall |
| 5 Letterboxd | about 7, tab must stay open | 4, background | Client loop |
| 6 Channel | about 6 plus reinstall | 4 | Mode overload |
| 7 Share | 3 (two models) | 2 (one model) | Two sharing models |
| 8 Find public list | 2–3 places | 1 place | Fragmented discovery |
| 9 Edit list | 3 plus maybe reinstall | 2 | Conflicts, reinstall |
| 10 Install | 3, repeated after every change | 2, once | Repetition |
| 11 Restore | 3 different mechanisms | 1 (+1) | Token-bearing link import |
| 12 Connect provider | 4 plus reinstall, silent expiry | 3 | Reinstall, silent expiry |

---

## 8. Proposed information architecture

```text
Home            first-run: add list · starter pack · sign in;   returning: my home screen (ordered rows, live preview, dedupe toggle)
Lists           my lists · liked · connected providers' lists  → list page (edit, share, add to home screen)
Channels        my channels · templates · explore channels     → channel page
Explore         community lists and channels + provider catalogs, one search
Settings        Home screen · Tracking · Connections · Account (devices, export, delete) · Help & feedback
[Install bar]   persistent: install status, Install in Stremio / Nuvio / other, manage installs
```

The old "Discover" charts move into Explore (and the Home starter pack). "Search" merges into Explore plus inline "Add titles" search in list editors. The top-level destinations drop from 6 to 5, and sub-tabs drop from 24 to about 12. Every destination has a real URL.
