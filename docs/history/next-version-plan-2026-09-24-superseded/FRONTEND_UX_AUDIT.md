# Frontend & UX Audit — My Lists

**Date:** 2026-09-24 · **Method:** the real builder page rendered by the real Worker (repo harness, stubbed upstreams, so provider-backed shelves are empty), walked at desktop (800 px pane) and mobile (375 × 812) widths; account creation, install-link generation, list, channel and settings screens exercised; DOM and network measured in the browser; client source (`09`–`24`) read for every flow described. Provider-backed content (posters, lists) could not be seen with real data — those observations come from code.

**Categories:** Critical usability · High · Medium · Low · Polish. Every item names the concrete problem, not a taste preference. Redesign is proposed only where a problem requires it.

---

## 0. What the product is doing today (as a first-time user sees it)

* **Six top-level tabs** — Catalogs, Lists, Channels, **Discover** (default), Search, Settings — plus hidden views (account, list details, item details). Each tab has its own row of sub-pills: Catalogs (My Catalogs, Quick Add, Bulk Add), Lists (My Lists, Liked, Import), Channels (My Channels, Storylines & Universes, Quick Add, Explore Channels, Import), Discover (All, Movies, Shows, Popular Lists, Curated, Hidden Gems, Kids, Holidays, Genres), Settings (Account & Sync, External Accounts & API Keys, Presets & Backup, Feedback and Support).
* **First paint:** 285 KB HTML, 2.0 MB JavaScript (457 KB gzip), 107 KB CSS, one third-party script (`fflate` from jsDelivr), Google Fonts. **3,430 DOM nodes, 624 buttons, 199 form controls** exist before the user does anything, because every tab is rendered up front.
* **The core job** — "get my lists onto my Stremio/Nuvio/Wako home screen" — ends at a **Generate Install Link** button at the very bottom of the Catalogs tab, below every configured row.
* **Browser tab title:** "My Lists — Self-Hosted Stremio Catalogs from MDBList, Trakt, TMDB & Simkl" (and a meta description promising "your own free Cloudflare account") — wrong for a hosted product.

---

## 1. Critical usability

### F-C1 · Every change requires a new install link and a reinstall
* **Observed:** Settings repeats "Requires Save/Update to take effect on an existing install link" under Hide non-digital releases, Remove duplicates, Better Posters and others. "Generate Install Link" produces a **new URL every time** (`/api/save` mints a new permanent id, 25:6942–7119). Adding a row, reordering, changing region, turning on Better Posters, or editing a channel all require: generate a new link → open Stremio → reinstall (and remove the old add-on, or end up with two).
* **The warning banner is dead:** "Unsaved changes to install link — Update Link" is in the DOM on every page, but `checkUnsavedInstallLink()` and `updateInstallLinkFromBanner()` are **empty functions** (24:2083–2085). Users are never told their installed add-on is out of date, and the button does nothing.
* **Why it matters:** this is the single largest source of "my changes didn't show up" confusion, and it is architectural (immutable snapshot configs), not cosmetic.
* **Fix:** live add-on profiles behind a stable install URL (NEXT_VERSION_ARCHITECTURE §3.2/§3.5). Content and settings apply on the next catalog request. Only changes to the **set of rows** need a manifest refresh; the UI shows "Reinstall once to see new rows" only in that case, with the **same** URL.

### F-C2 · The account model is a password the user can't choose, shown once, stored in the browser
* **Observed (account creation):** "No email. No password. Just a username and key." After creation, a modal shows `MYL-XXXX-XXXX-XXXX` once with "Save this key somewhere safe… You can view it again later from Settings." Settings shows the key masked with **Show Key / Copy Key**; recovery is an optional free-text "Recovery Answer".
* **Problems:** people will not store a random key; the only recovery path is a security-question-style answer (optional, weak by nature) or an admin; the key is the same credential used for everything (signing in on another device, install links, webhook URLs until recently), so copying it around is normal behaviour that the product then has to warn against; "Show Key" from `localStorage` means anyone at the device (or any XSS) can read it.
* **Fix:** keep key-based login for existing users, add **passkeys** and optional **email magic-link** recovery; sessions per device with a "signed-in devices" list and "sign out everywhere"; never display the key again after creation unless re-authenticated.

### F-C3 · Letterboxd import is invited in the wrong place and fails there
* **Observed:** the Add Catalog modal's URL field placeholder is **"URL (e.g. Trakt, Letterboxd)"** (16:2904). The backend has no Letterboxd list source: `detectSource` falls through to MDBList (04:306), so a Letterboxd URL produces an MDBList error (or an empty row). The working importer is elsewhere: **Settings → External Accounts & API Keys → Import List**, which requires exporting a CSV/ZIP from Letterboxd first.
* **Fix:** detect `letterboxd.com` everywhere a URL is accepted and show "Letterboxd lists are imported from a file — here's how (2 steps)" with a direct link to the importer; change the placeholder.

### F-C4 · Primary action is buried and sits next to a destructive one
* **Observed:** on Catalogs, "Generate Install Link" is the last element after all rows and the "Daily Randomizer" box, rendered beside **"Remove All"** at similar visual weight (primary blue vs outlined red). With 20 rows on mobile it is ~15 screens down. No sticky CTA exists (checked: no sticky element in the DOM).
* **Fix:** a persistent "Your add-on" status bar (installed / up to date / install) at the top of the Add-on screen; move "Remove All" into an overflow menu with confirmation.

---

## 2. High

| ID | Problem | Where / evidence | Fix |
|---|---|---|---|
| F-H1 | **Terminology collides.** "Catalogs" (rows in the add-on), "Lists" (collections), "Channels", "shelves", "rows", "Quick Add" (in two tabs with different meanings), "Presets", "Creator Profile"/"Profile"/"Account", "Creator Key"/"Account Key"/"Key", "Creator Name"/"Username". "+ Add" on a list means "add as a catalog row", on a title means "add to a list". | UI copy across tabs; server errors still say "Creator" | One glossary: **List** (a collection you own/follow), **Row** (something your add-on shows), **Channel**, **Add-on**, **Account**, **Sign-in key**. "+ Add to add-on" vs "+ Save to list". |
| F-H2 | **Six import entry points** with different meanings: Lists → Import (provider URL), Settings → Import List (CSV/JSON file incl. Letterboxd), Presets & Backup → Import JSON / Upload file / Import link / Restore Lists, Channels → Import, Catalogs → Bulk Add. | tab templates 10, 12, 13, 14, 15 | One **Import** hub with source cards (URL, file, backup, install link); each card explains what it creates. |
| F-H3 | **Settings → Account & Sync is a dumping ground**: account, watchlist behaviour, hidden lists, region, digital-release filter, cross-list dedupe, adult filter, Better Posters (+7 style options), ~15 badge toggles split into "Website" and "Stremio & Nuvio", companion recommendations, clear history, auto-track and scrobbling. | live page text | Move add-on behaviour (region, dedupe, filters, artwork, badges) to the **Add-on** screen; keep Account for identity/devices/connected services; keep Library preferences with the Library. |
| F-H4 | **Two parallel "what to add" browsers**: Discover (charts, curated, popular lists) and Catalogs → Quick Add (the same charts as "+ Add all" groups). | 10_, 11_ | One browse experience (Discover) with "Add to add-on" on every card. |
| F-H5 | **New lists and channels default to Public.** Create List modal: "Public" toggle checked by default (09: `createListModalPublic checked`); Channel builder: "Public" on. Public lists appear in the directory under the username. | modal + builder | Default **Private**; one clear control with three options (Private · Unlisted link · Public in directory). |
| F-H6 | **Signed-out work is silently device-local.** Custom lists and channels created without an account live only in `localStorage`; clearing site data or switching browsers loses them. The UI says "Custom lists you've created locally or on your profile" but does not warn at creation time. | Lists tab copy | Either require an account to create persistent content, or show a persistent "Saved on this device only — create an account to keep it" banner. |
| F-H7 | **Channels are not added to the add-on when saved.** `saveChannel()` stores the channel locally and only updates a row that already references it (20:9263–9282); a new channel needs a separate "+ Add" and then a new install link and reinstall (F-C1). | code + channels UI | "Save & add to my add-on" as the default action. |
| F-H8 | **Errors look like empty lists.** With a provider failing, Discover shelves say "No items found in this list." — the same text as a genuinely empty list (observed with stubbed upstreams). In Stremio a failing row shows a "temporarily unavailable" placeholder only on the first page. | Discover, Catalogs preview | Distinct states: loading, empty, error (with retry), needs-connection. |
| F-H9 | **Six-item mobile bottom navigation** plus horizontally scrolling sub-pills (on 375 px, "External Accounts & API Keys" is cut off). Hidden views (account, details) are reached through the header chip. | mobile screenshots | Four destinations (§7); sub-sections as a segmented control that fits, or a list. |
| F-H10 | **Destructive account actions sit in the main account card**: "Reset Account Data" (orange) and "Delete Account & All Data" directly below the key controls; Delete's copy promises removal of "all published lists, and all synced data", which the server does not fully do (published channels, install configs remain — BACKEND_AUDIT B-H3). | Settings | "Danger zone" section at the bottom; typed confirmation (already exists for delete); make the copy true. |

---

## 3. Medium

| ID | Problem | Evidence | Fix |
|---|---|---|---|
| F-M1 | **Every `alert()` is shown as an error toast.** `window.alert` is overridden to `showToast(message, 'error')` (16:1705–1713), and 124 call sites use it — including success messages ("Key copied to your clipboard.", "…restored successfully.", "Scrobble Webhook URL copied…"). | 16:1705 | Replace call sites with `toast.success/info/error`; remove the override. |
| F-M2 | **Technical language in user copy**: "install link", "manifest", "Save/Update", "Worker owner", "binding a KV namespace named CONFIGS", "subrequest", "PIN / Code", "Region… content ratings… Stream Releases". | settings/help copy; 24:2231–2240 | Plain language; hide operator messages entirely (hosted product). |
| F-M3 | **Hidden Lists shows "My Lists" twice** (the "Dashboard" entry is relabelled), plus "Airing Next"/"Watchlist" in the same checklist. | live Settings after sign-in | Deduplicate labels; show real list names. |
| F-M4 | **Combined rows are created by adding "another link" inside the Add Catalog modal** ("+ Add another link (Combined List)") — a power feature on the basic path, with no preview of what combining does. | Add Catalog modal | Move "Combine sources" into row editing with a preview. |
| F-M5 | **Channel builder front-loads broadcast engineering**: Advanced Settings holds 7 play orders, daily schedule, hide-watched (requires auto-track), multi-part pairing, auto-add episodes; Channels' main screen also shows "Merge Saved Channels into One Catalog". Reasonable behind Advanced, but "Merge" belongs in row editing. | Channels tab | Keep Advanced collapsed; move Merge to the Add-on screen. |
| F-M6 | **Two provider-connection surfaces**: Lists shows four "Connect X" cards; Settings → External Accounts repeats connect/disconnect plus per-provider "Sync Current Watch History Now" and "Advanced" API-key fields. | Lists, Settings | One **Connected services** page; Lists shows a single "Connect a service" card when none are connected. |
| F-M7 | **Watch-history sync is manual per provider** ("Sync Current Watch History Now") with no status of when it last ran. | Settings | Background sync job with "last synced" and errors per connection. |
| F-M8 | **Sign-in state is ambiguous across devices**: the header chip shows the username, but nothing indicates sync status, conflicts, or that another device changed data (the server returns 409 conflicts; the client retries silently). | code (sync conflict handling in 22_) | Sync indicator (synced · syncing · offline · conflict resolved). |
| F-M9 | **Page is one document with every tab rendered**; the browser's back button and deep links depend on custom history handling; tab state is remembered in `localStorage` (`myListAddon:activeTab`), so reopening the site lands on the last tab rather than a predictable home. | DOM, localStorage keys | Real routes per section (`/discover`, `/library`, `/addon`, `/settings`). |
| F-M10 | **Public list page ships the whole app** (2 MB) and embeds every item in the HTML (26:4839–4852). Shared links are slow on mobile and give crawlers little. | server | Lightweight server-rendered public pages with a "Open in My Lists" button. |
| F-M11 | **Account key displayed in plain text with "Copy Key"** encourages pasting it into chats/support threads. Feedback form asks for "Email, Discord username, etc." but not whether to include diagnostics. | Settings, Feedback | See F-C2; add "Copy diagnostics" that never includes secrets. |

---

## 4. Low

| ID | Problem | Fix |
|---|---|---|
| F-L1 | "Daily Randomizer" (shuffle rows/items) sits inside the Catalogs list above the install button. | Move to Add-on settings. |
| F-L2 | "Stremio Web" button styled differently from the other two install buttons; Wako has manual instructions only. | Consistent install buttons; add Wako deep link if one exists. |
| F-L3 | Search field inside Catalogs ("Filter catalogs by name…") and the global Search tab look identical but search different things. | Label as "Filter rows". |
| F-L4 | FAQ says "Your configuration is encoded directly into your install link" (24:3816) — no longer true. | Update copy. |
| F-L5 | Header "Login" button vs Settings "Create Free Account / Login" vs "Sign Out / Switch" — three wordings for one concept. | "Sign in" / "Create account" / "Sign out". |
| F-L6 | PWA manifest has a single 256 px icon; no maskable icon (the previous audit's PWA-001 was addressed by declaring the true size, not by adding assets). | Ship 192/512 + maskable. |

---

## 5. Polish

* ~700 inline `style=` attributes in client JS and ~400 distinct class names; buttons use at least five visual treatments (`lc-btn primary`, `primary`, `subnav-pill`, text-only buttons in modals such as Add Catalog's "Cancel/Add", pill badges). Consolidate into a component library (Button: primary/secondary/tertiary/danger; IconButton; Pill; Toggle).
* Close buttons render as `✕` in a circle in some modals, as text "Cancel" in others, and some modals (Add Catalog) have no close icon at all.
* Modal widths vary (340 / 380 / 420 / 480 px) for similar forms.
* Emoji used as icons in the header chip (`👤`) next to SVG icons elsewhere.
* Focus styles: only three `:focus-visible` rules in 107 KB of CSS; verify every interactive control (previous A11Y-001).
* Spinner and toast styles are inline HTML strings repeated in several files.

---

## 6. Page-by-page notes (Phase 9)

| Area | Observed | Keep | Change |
|---|---|---|---|
| **Landing / Discover** | Default tab; filter pills (All, Movies, Shows, Popular Lists, Curated, Hidden Gems, Kids, Holidays, Genres); each shelf card has ♡, "+ Add", "Customize". | Browse-first landing is right for this product. | Explain what "+ Add" does the first time; show a one-line "How it works: pick lists → install once → they appear in Stremio". |
| **Catalogs (My Catalogs)** | "Live Preview & Editor" with + New Catalog / Edit / Refresh Preview; rows with drag handles and "See All"; Daily Randomizer; Remove All; Generate Install Link at the bottom. | Live preview of rows is the product's best idea. | Becomes **Add-on**: status bar at top (install/update), rows with inline actions, settings drawer; remove the bottom CTA. |
| **Quick Add / Bulk Add** | Chart groups with "+ Add all"; bulk "Add All Lines as Catalogs". | Bulk paste is valuable. | Merge Quick Add into Discover; Bulk Add becomes an Import card. |
| **Lists** | Your Custom Lists (Watchlist first), four provider cards, Liked, Import. | — | **Library → Lists**: owned, followed (liked), connected-provider lists in one list with a source filter. |
| **List details / See All** | Grid with filters (All/Movies/Shows), sort, "Clear History" for watch history, like and + Add buttons. | Filters and sort. | Paginate with real server paging; distinct error state. |
| **Channels** | My Channels (search, sort), + Next Up Channel, + New Channel, Merge section; Storylines & Universes; Quick Add networks; Explore Channels; Import. | Builder, presets, directory. | Library → Channels; Merge moves to Add-on; "Save & add to add-on". |
| **Search** | Global search for titles and lists. | — | Put in the header on every screen. |
| **Settings** | Account & Sync (dumping ground, F-H3), External Accounts & API Keys, Presets & Backup, Feedback and Support (in-app threads). | In-app support threads are good. | Split per F-H3; "Presets" becomes named add-on profiles (NEXT_VERSION_ARCHITECTURE §3.3). |
| **Backup / Restore** | Export current, Import JSON, Download/Upload file, Import link, Restore Lists, CSV exports (Trakt/Simkl, Letterboxd, Universal), Full Library JSON. | Exports in standard formats. | Backups become **server-side exports** (R2, downloadable) without secrets; restore is an import job with a preview. |
| **Install flow** | "Add-on Ready to Install" card with Install in Stremio / Install in Nuvio / Stremio Web, manifest link with Copy, manual instructions for Stremio, Nuvio, Wako. | Clear per-app buttons and manual steps. | Stable URL per add-on profile; "Installed on: Stremio (last seen …)" from token `last_used_at`; "Revoke" per install. |
| **OAuth** | Trakt via redirect or PIN/device code; MDBList, Simkl, TMDB via redirect; tokens returned in the URL fragment and kept in the browser. | Device flow for TVs. | Server-side vault; the UI shows "Connected as X · Reconnect · Disconnect"; errors explain expiry. |
| **Admin** | Separate page; out of scope for end-user UX. | — | Separate app/route with its own auth (SECURITY_AUDIT S-9). |
| **Empty states** | Present but generic ("No items found in this list", "No channels created yet…"). | Friendly copy exists in places. | Distinguish empty vs error vs not-connected; give the next action. |
| **Loading states** | Spinners in some places, "Loading…" text in others. | — | Skeleton rows for shelves; consistent spinner component. |
| **Confirmations** | `showAppConfirm` for destructive actions; typed "DELETE" for account deletion. | Good. | Add undo (toast with Undo) for item/list removals instead of confirm dialogs where safe. |
| **Keyboard** | Tabs have `role="tab"`/`aria-selected`; every dialog element is labelled. | ARIA groundwork exists. | Focus trap and Escape in every modal; visible focus everywhere. |

---

## 7. Proposed information architecture

```
Header:  [My Lists]            [ Search titles, lists, channels…  ]         [Sync ●] [Account]

Nav (desktop top / mobile bottom, 4 items):
  Discover   — charts, curated, public lists & channels, "for you"
  Library    — Lists (owned · followed · connected) · Channels · Watching (Continue · Up next · History · Watchlist)
  Add-on     — Rows (live preview, reorder, edit, combine) · Install & devices · Add-on settings (region, dedupe, filters, artwork, badges)
  Settings   — Account & devices · Connected services · Import & export · Help & feedback
```

Why four, not three (as `UI_UX_AUDIT.md` proposed): the add-on (what Stremio shows) and the library (what the user owns) are different mental objects — a list can exist without being in the add-on, and a row can be a chart the user does not own. Merging them is what produced today's "Catalogs vs Lists" confusion.

---

## 8. UX flow audit (Phase 10)

For each scenario: **today** (steps observed or traced in code), problems, and the **proposed** flow. "Step" = a user decision or action.

### Scenario 1 — "I want to add one MDBList."
* **Today (8–10 steps):** Catalogs → My Catalogs → **+ New Catalog** → type a name → paste URL → choose Movies/Shows (must match the list) → Add → scroll to the bottom → **Generate Install Link** → Install in Stremio → (if already installed) remove the old add-on in Stremio.
* **Problems:** name and type are asked although the server can infer both from the URL (`/api/preview` already fetches the list); the reinstall step (F-C1); the new row shows "No items found" if the type is wrong, with no hint.
* **Proposed (3 steps):** paste the URL into the header "Add" box (or Discover search) → preview card shows name, count, type → **Add to add-on**. The installed add-on shows it on next refresh; no new link.

### Scenario 2 — "I want to add 20 lists."
* **Today:** Catalogs → Bulk Add → paste lines → "Add All Lines as Catalogs" → generate link → reinstall. Types and names are guessed per line; failures surface as empty rows.
* **Problems:** no per-line validation before adding; no duplicate-URL detection; no progress.
* **Proposed:** Import → "Paste URLs" → a validation table (name, type, item count, status per line, duplicates flagged) → **Add 20 rows** → done (live).

### Scenario 3 — "I want to prevent duplicates between my lists."
* **Today (7 steps + reinstall):** Settings → Account & Sync → scroll to "Duplicate Items Across Lists" → tick "Remove duplicate items across lists" → (read that order matters and "Requires Save/Update") → back to Catalogs → reorder rows → Generate Install Link → reinstall.
* **Problems:** the setting lives far from the rows it affects; its effect depends on row order, which is on another tab; every cold row request refetches all earlier rows (BACKEND_AUDIT B-H8).
* **Proposed:** Add-on → settings drawer → "Hide titles already shown in an earlier row" with an inline explanation "Rows higher up keep the title"; immediate effect; computed once per add-on version server-side.

### Scenario 4 — "I want to create a custom list."
* **Today:** Lists → **+ New List** → modal: Destination (Custom / Trakt / TMDB / MDBList / Simkl), Name, Description, Content type, **Public (on)** → Create → go to Search or Discover → open a title → "+" → select list(s) in "Add / Remove from Lists" → Done. Signed out, the list is device-only.
* **Problems:** the "Destination" select mixes a local concept with remote provider writes in one form; public by default (F-H5); device-only lists without warning (F-H6); adding items requires leaving the list.
* **Proposed:** Library → Lists → **New list** (name, type, visibility default Private) → the empty list page has an inline "Search to add titles" box; "Create on Trakt/MDBList/TMDB/Simkl instead" is a secondary option shown only when connected.

### Scenario 5 — "I want to import a Letterboxd list."
* **Today:** the natural path (paste the Letterboxd URL into Add Catalog, which suggests Letterboxd) fails (F-C3). The working path: export from Letterboxd (on their site) → Settings → External Accounts & API Keys → Import List → name it → choose format → Select files → Import → the browser sends chunks to `/api/bulk-resolve` in a resume loop (free-tier continuation protocol) → a local list appears → add it to Catalogs → generate link → reinstall. Closing the tab mid-import loses progress.
* **Proposed:** paste a Letterboxd URL anywhere → "Letterboxd lists import from a file" helper with the two export steps → upload → **server-side import job** with a progress bar that survives closing the tab → result summary ("243 matched, 7 not found — review") → "Add to add-on".

### Scenario 6 — "I want to create a channel."
* **Today:** Channels → + New Channel → choose Shows/Movies/Actors → search → pick shows/episodes → (optional Advanced) → type a name → Save → "saved" modal → find it under My Channels → **+ Add** to catalogs → generate link → reinstall. Public by default.
* **Problems:** the save does not add the channel to the add-on (F-H7); defaults to public; Advanced options are dense (acceptable).
* **Proposed:** New channel → pick shows → name → **Save & add to add-on** (default) → live. Visibility defaults to Private with a Share button afterwards.

### Scenario 7 — "I want to share a list."
* **Today:** a list must be Public to have a shareable page; the URL is `/lists/{username}/{slug}`; sharing makes it appear in the directory too. There is no unlisted option for lists (channels have unlisted share codes).
* **Problems:** share = publish; the shared page loads the whole app (slow on phones).
* **Proposed:** Share button → choose **Unlisted link** or **Public in directory** → copy; lightweight public page with "Add to my add-on".

### Scenario 8 — "I want to find someone else's public list."
* **Today:** Discover → Popular Lists (community + MDBList top lists + curated), or Search (searches titles and lists; "my lists" queries hit a special-case branch, 26:4302–4312). Liking uses ♡; followed lists appear under Lists → Liked.
* **Problems:** "Like" doubles as "follow/save"; search special-cases the phrase "my lists"; no creator profile page to browse one person's lists.
* **Proposed:** Discover → Lists (sort: popular/new) and Search in the header; list cards show creator → creator page; **Follow** (saves to Library) separate from ♡ (appreciation).

### Scenario 9 — "I want to edit a list I previously created."
* **Today:** Lists → find the list → Edit → change items/name → Save (server conflict guard may return 409 if another device edited it; the client retries silently) → if the list is a catalog row, the installed add-on shows the change only if the row is a live reference; rows built from an embedded snapshot (`customlist:v1:`) need a new install link.
* **Problems:** whether an edit reaches Stremio depends on how the row was added (live creator list vs embedded snapshot) — invisible to users.
* **Proposed:** every row references the list by id; edits are live; conflicts are resolved per item (add/remove operations merge naturally).

### Scenario 10 — "I want to install my configuration into Stremio/Nuvio/Wako."
* **Today:** Catalogs → scroll to bottom → Generate Install Link → Install in Stremio / Install in Nuvio / Stremio Web, or copy the manifest link for Wako → every later change: repeat and reinstall.
* **Proposed:** Add-on → **Install** (one time per device) → the device appears under "Installed on" (from the add-on token's `last_used_at`) → later changes are live; "Revoke" per device.

### Scenario 11 — "I want to restore my configuration."
* **Today:** Settings → Presets & Backup → paste JSON / upload file / "Import link" (paste an install link: the server returns that config's entries and the embedded OAuth tokens) → Restore → "restored successfully" (shown as an error-styled toast, F-M1). Backups contain the account key and provider tokens in plain text.
* **Problems:** too many restore entry points (F-H2); restoring by install link exposes tokens; backups are secrets.
* **Proposed:** signed-in users rarely need restore (server is the source of truth); Settings → Import & export → **Restore from backup file** (preview what will be added/replaced) and **Import an old install link** (rows only; tokens never included).

### Scenario 12 — "I want to connect Trakt/Simkl."
* **Today:** Settings → External Accounts & API Keys → Connect Trakt Account (redirect) or "Connect with PIN / Code" (device flow modal) → token lands in the browser → optional "Sync Current Watch History Now"; the connection silently expires after ~90 days (no refresh), and personal rows in Stremio go empty.
* **Proposed:** Settings → Connected services → Connect → provider consent → "Connected as @user"; background sync enabled by default with last-sync status; automatic token refresh; clear "Reconnect needed" state if refresh fails, surfaced both in the app and as a placeholder tile in the affected Stremio row.

---

## 9. Frontend architecture findings

| Finding | Evidence | Recommendation |
|---|---|---|
| Client code is a string inside a server template literal | 09–24 are fragments of `renderBuilder()`'s return value; extracted at runtime into `/app.js` | Real ES modules built with Vite; TypeScript. |
| ~820 global functions in one scope | function counts per file (16: 95, 17: 52, 19: 108, 20: 189, 21: 85, 22: 141, 23: 72, 24: 57) | Feature modules with explicit imports; shared domain logic from `packages/domain`. |
| 327 `innerHTML` sinks, ~700 inline styles | per-file counts | Components (Preact/JSX) with escaping by default; design tokens. |
| All tabs rendered at load (3,430 nodes, 624 buttons) | DOM measurement | Route-level code splitting; render on navigation. |
| `localStorage` as a database (~80 keys, including secrets) | key inventory | Server as source of truth; `localStorage` for UI prefs only. |
| Monolithic 2.0 MB bundle for every page, including public list pages | network measurement | ≤ 200 KB gzip initial; public pages without the app bundle. |
| Business logic duplicated with the server (Airing Next, recommendations, dedupe, CW) | `NEXT_VERSION_ARCHITECTURE.md` §1.5 | Server computes; client renders. |
| Third-party CDN script on the critical path (`fflate`) | 09:3629 | Bundle locally or drop (FT-18). |
| Service worker caches only the shell and bundle | 25:67–163 | Keep; add offline read-only cache of the Library via the query cache. |

**Migration approach:** do not rewrite everything at once. Phase 6 in `MIGRATION_PLAN.md`: (1) extract the existing client into bundled modules with no behaviour change; (2) introduce the new API client and query cache behind the existing UI; (3) rebuild one destination at a time (Add-on first — it carries F-C1/F-C4 — then Library, Settings, Discover), each shipped behind a flag with the old tab still available until parity.
