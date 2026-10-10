# Handoff

Read this, then `AGENTS.md` and `docs/DECISIONS.md`. Do not start over or undo existing work. Keep this file short: replace stale items, don't append history (old versions: `docs/history/`).

## Where things stand (2026-10-09)
- **Continue Watching update on Watch History item removal (2026-10-09, fix_continue_watching_update):** Removing an episode/item from Watch History via the "x" button (`removeWatchHistoryItemDirect`) now extracts the affected show ID and triggers `updateContinueWatching(showId)`, updating Continue Watching to the previous unwatched episode (or removing the show from Continue Watching if all its watched episodes were cleared).
- **Release 25 is live and worked:** Compare shelves 2026-10-07, 0.00% different, 0 lost, 0 shows not known yet. **Release 26 is live** (owner: fine, 2026-10-07) and merged into `main`: PR #29's audit fixes plus `pullInShortenedPeriods` (45_). **Release 27 is live** (owner: looks good, 2026-10-07, build a7953c77f6) and merged into `main`.
- **Catalog Shelves, Episode Titles & Full Scroll Restoration (2026-10-07):** Continue Watching and Airing Next shelf cards in My Catalogs show the item's name (`showTitle`) instead of "Episode x" or "Season Premiere". On My Lists, episode titles are resolved from Cinemeta / TMDB (e.g., Lioness displays "Sugar Land" instead of "Episode 6"), falling back to "Episode x" / "Season Premiere" only when the episode title is not yet released. Furthermore, scroll positions are preserved and restored bidirectionally across the application: navigating back to a list details view (`list-details`) from item details, as well as navigating back from a "See All" list view to Discover, Catalogs (All), Search, and Lists pages via either the UI back button or browser history back.
- **Customer Support Email Interface & Cloudflare Email Service (2026-10-09):** Implemented an end-to-end customer support email interface in the Admin Dashboard (`/admin` → Management & Tools → **Support Emails**) backed by Cloudflare Email Routing and Cloudflare Email Sending (`env.EMAIL.send()`):
  - **Inbound Handler:** Cloudflare Email Worker handler `email(message, env, ctx)` parses RFC 2822 / MIME emails, handles multipart alternative and related plain text and HTML payloads, quoted-printable & base64 decoding, automatically threads conversations via `In-Reply-To` / `References` headers and normalized subject lines, parses image attachments, inlines CID images in HTML email view, and saves messages and attachments to D1 `support_threads` and `support_messages` (migration `0021_support_emails.sql`).
  - **Outbound Dispatcher:** `sendSupportEmailReply` and `composeNewSupportEmail` dispatch emails using `env.EMAIL.send()` with full threading headers (`In-Reply-To`, `References`, original message ID) and optional image attachments (`attachments: [{ filename, type, contentType, content, disposition }]`), automatically ensuring extension-safe filenames (e.g., UUID-based filenames receive `.png`/`.jpg` so Gmail previews them) and clean Base64 data, logs outbound messages to D1, and updates thread status.
  - **Admin UI:** Two-pane responsive email client in `/admin` with search, filter tabs (All, Open, Replied, Closed), conversation timeline with attachment thumbnail gallery, an inline full-screen Lightbox image modal for previewing attachments larger without downloading, separate one-click download buttons, direct reply composer with file picker and clipboard image pasting (`Ctrl+V`), and new email composer modal with attachment support and lightbox previews.
  - **Config & Bindings:** Added `[[send_email]] name = "EMAIL"` to `wrangler.toml` and documented in `docs/OPERATIONS.md` §2 and §31.

- **Watch History Duplicate Episode Removal (PR #33, 2026-10-07):** Fixed an issue where removing an episode watched more than once caused all entries of that episode to be removed simultaneously. Removing an item now targets only that specific play instance (by target ID and `watchedAt` timestamp), preserving any remaining duplicate watches on the dashboard shelf, list details view, preloaded cache, and activity event tracking database (`watch_events`). Grouped show removal continues to remove all plays for that show as intended. Test suite added in `tests/watch-history-duplicate-removal.test.mjs`.
- **Ko-fi Support Goal Billing Cycle (2026-10-07):** Updated support goal billing cycle calculation and copy to start on the 9th of each month instead of the 1st (`supportGoalMonth`, 03_admin.js; admin tab panel text, 03_admin.js; and support modal text, 16_client-row-core.js).
- **Catalog Poster Badges Aligned for Stremio & Nuvio (PR #33, 2026-10-07 / 2026-10-08):** Updated poster badge SVG generation (`generateBadgedPosterSvg`, 05_catalog-core.js) and `/api/poster-badge` route (25_api-catalog-routes.js) so that Stremio and Nuvio poster badges are bold, highly visible, match the website, and strictly comply with SVG 1.1 / SVG 1.2 Tiny specifications across all client parsers (QtSvg, SDWebImage, Glide, Safari, Blink):
  - **Date & Time badge (top-left):** Displays a stacked two-line blue pill (`#007aff` with `fill-opacity="0.96"`, `stroke="#ffffff"` with `stroke-opacity="0.25"`, font-weight bold, height 96px) with Day/Date on line 1 (font-size 32px) and Air Time on line 2 (font-size 28px) with generous padding (e.g., width 260px for `TOMORROW` so text never clips or overflows), clearly legible on TV and mobile screens. Single-line dates use font-size 34px and height 72px.
  - **Bottom Badges (Season Premiere, Season Finale, Finale Date):** Prominent height (84px, font-size 38px bold) matching the `Finale:` badge:
    - `SEASON PREMIERE`: uppercase text in vibrant green (`#28a745`, `stroke="#28a745" stroke-opacity="0.6"`).
    - `SEASON FINALE`: uppercase text in vibrant amber (`#ff9500`, `stroke="#ff9500" stroke-opacity="0.7"`).
    - `FINALE: <DATE>`: dark pill (`#121218`, `fill-opacity="0.94"`) with amber border (`#ff9f0a`, `stroke-opacity="0.75"`) and gold text (`#ffd166`).
  - **Universal SVG 1.1 Compatibility (Fix for Stremio image drop):** Eliminated non-standard CSS `filter="drop-shadow(...)"` and `rgba(...)` within presentation attributes which caused strict SVG decoders (QtSvg, iOS native image loaders) in Stremio to drop badged posters. Replaced with pure SVG 1.1 hex colors, standard `stroke-opacity`/`fill-opacity` attributes, and dedicated offset SVG shadow `<rect>` elements (`fill="#000000"` with opacity 0.35–0.40) ensuring zero-failure rendering across Stremio and Nuvio on all devices.
- **1-Click Nuvio Install & Nuvio Web Flow (2026-10-09, fix_nuvio_install_button):** Nuvio natively parses addon deep links using the scheme `nuvio://<host>/<path>` (matching Stremio's `stremio://<host>/<path>` pattern), converting `nuvio://` to `https://`, navigating to Addons Settings, and auto-installing the addon (same mechanism used by TopX). "Install in Nuvio" (`24_client-backup-restore-presets.js`) renders as a direct `<a href="${nuvioInstallUrl}">` anchor (`nuvio://<host>/<config>/manifest.json`) for seamless single-click installation, and also attaches `data-act="copyNuvioInstallLink"` to copy the HTTPS Manifest Link to the clipboard with toast feedback on click just in case manual paste is needed. "Nuvio Web" (`openNuvioWeb`) remains available to open `https://nuvio.tv/account?tab=addons`. Covered by tests in `tests/client.test.mjs`.
- **Code Reuse and Duplication Refactoring (Phase 1 & 2, 2026-10-09):**
  - Consolidated duplicate base64 decoding and HTML escaping utilities across server modules (`59_support-emails.js` delegates to `base64ToUint8` and `escapeHtmlServer` in `02_http-and-creator-utils.js`).
  - Added canonical `copyTextToClipboard` helper (`16_client-row-core.js`) with modern clipboard API + fallback `<textarea>` + `execCommand('copy')` and button/toast feedback, consolidating ad-hoc copy blocks in `22_client-creator-profile.js` (`copyShareListUrl`, `copyShareUrlById`).
  - Added `jsonUnauthorized(extraHeaders)` and `jsonInvalidBody(extraHeaders)` response helpers and `readJsonBody(request)` safe body parser (`02_http-and-creator-utils.js`), standardizing repeated 401 and 400 responses across admin and API catalog routes (`26_`, `25_`).
  - Pruned confirmed dead/unreferenced functions: `confirmDialog`, `promptDialog` (`16_client-row-core.js`), and `listIdToLedgerKey` (`02_http-and-creator-utils.js`).
- **Badged posters for Stremio (2026-10-08):** `/api/poster-badge` returns a JPEG via the `IMAGES` binding (`renderBadgedPosterJpeg`, `25_`); SVG fallback is what Nuvio shows. Untested on a live Worker: check Stremio after deploy.
- **Unchecked after the UI consistency pass (PR #19):** a modal over the phone bottom nav, drag-and-drop, storyline and deep creator-profile screens. Rules: `AI_UI_RULES.md`, `DESIGN_SYSTEM.md`.

## Next steps
Dates are from the previous handoff; check them against `docs/RELEASES.md` before acting.
1. **Release 27 (live):** the legacy Continue Watching / Airing Next cron sweeps (`checkForNewEpisodes`, `refreshAiringNextSweep`) pass over accounts served from the schedule (`legacyShelfSweepSkips`, 40_). They still sweep accounts on the old storage, and all accounts if `FF_SHOW_SCHEDULE` is off. The client shelf builders (21_) and the stored lists stay: `shelfStoredForUnknown` reads them. Next code task: merge duplicate media rows for one title (rewrites stored data: ask the owner first).
2. **Owner (dashboard):** `INSTALL_MIGRATION_PERCENT` to `50` about 2026-10-07, then `100` about 2026-10-10 if `/admin` → Maintenance → Install links shows nothing failed. Turn on D1 read replication for `my-lists-db` (P8-1); Claude gives the steps.
3. **About 2026-10-12:** if `/admin` → Creators *Saves that sent the Account Key* stays near zero, rewrite the sunset notices (`getLegacySunsetNotices`, 02_), then the owner sets `SUNSET_60DAY_START_DATE`.
4. **Day 60 after that:** remove key-in-body auth on the session routes, the legacy scrobble forms and the other sunset items. After that, the old storage one prefix or table at a time: copy to R2, remove its readers, delete (`docs/CUTOVER.md` P10-3).
5. **After 2026-11-29:** remove the Better Posters KV fallback (`bpimg:v1:` reads in 52_, the KV-only path in 05_). Keep `prewarmBetterPosters`.
6. **Optional, owner's call:** Unlisted lists (`FF_V2_LISTS_API`) need a place on the page first, likely the list editor's privacy setting.

## Ask the owner first, every time, before anything that
- **rewrites or deletes stored user data.** Get explicit approval, make sure a D1 backup and a KV export exist, and do it gradually;
- **needs a dashboard change** (a variable, secret, binding or migration). Tell the owner, generate values for them, add the step to the release notes. New code must keep working if a secret is missing;
- **depends on a new migration.** Raise `REQUIRED_SCHEMA_VERSION` in the same change and say so in the release notes, or the site pauses saving until the migration runs.

## Decisions that shape everyday work (`docs/DECISIONS.md`)
- **D-3 / D-11:** code stays in the numbered split files; the owner pastes `worker_entry_combined.js` into Cloudflare; no npm build, `src/` or frameworks.
- **D-6 / D-8:** liking, sharing and publishing need an account. Signed out, a visitor can only add the site's public lists (plus storylines and Explore Channels listings) and generate an install link.
- **D-9:** likes cast signed-out in the past keep counting. **D-10:** install links never expire. **D-12:** no email recovery.

## Safeguards Already in the Code (do not remove or bypass)
These are deliberate. Several are "one place" mechanisms that cover the whole Worker, so they are easy to break by accident.

| Where | What it does |
|---|---|
| Top of `00_constants.js` | A module-level `console` that passes every log line through `redactForLog` (masks keys, tokens, Creator Keys). **Never declare another top-level `console`.** |
| `02_http-and-creator-utils.js`, `function fetch` | A module-level `fetch` guard. It strips edge caching from any request carrying `Authorization` (a real cross-user leak before), and gives every call without its own timeout a 30 s ceiling. **Never declare another top-level `fetch`.** |
| `02_`, `json()` / `jsonCacheable()` / `jsonPublic()` | JSON responses default to `no-store`. Public data opts in to caching with `jsonCacheable`; the Stremio routes do through `jsonPublic`. A new route that returns something personal must use plain `json()`. |
| `00_`, `INSTALL_CONFIG_FIELDS` | One definition of every install-link setting, used by `/api/save`, `resolveConfig`, `decodeConfig`, the configure page and the builder's save body. **Add a new setting here**, never by hand in one of those places. |
| `04_`, `entryAccountRequirement`; `16_`, `rowNeedsAccount` | The D-8 rule, on the server and in the page. A test (`the builder page and the server draw the line in the same place`) keeps them in agreement, so change both. |
| `00_`, `REQUIRED_SCHEMA_VERSION`; `02_`, `schemaWriteGate` | API writes are refused (503 "being updated") while the database is behind the code. A new migration must: <br>1. end with an `INSERT` into `schema_migrations`; <br>2. be added to `schema.sql` and `D1_SCHEMA_MANIFEST`; <br>3. bump `REQUIRED_SCHEMA_VERSION` if the code depends on it. <br>See `docs/OPERATIONS.md` §4. |
| `04_`, `resolveConfig(config, env, { withTracking })` | Reads a person's tracking record only when asked (the channel meta route and `/api/resolve`). Catalog rows must not ask. |
| `/<id>/configure` and `/api/resolve` | Never return provider keys or tokens. The `P1-T2` test probes every route for this. |
| `02_`, `getOrBackfillAccount(env, username, profile)` | The `accounts` row is a **mirror** of the creator profile (`creator:{u}` / `creators`), which stays the source of truth until Phase 10. Never trust `accounts.key_hash` on its own: authenticate with `authenticateCreator`, then sync the row from the profile. `deleteAccountRow` removes a row and everything under its id (sessions, installs, secrets, snapshots). |
| `27_`, the install move | A moved `cfg:` record carries `_install` and no secrets; `resolveConfig` puts them back (`applyLegacyInstallRecord`). Reads never depend on the flags. **Never write code that reads a `cfg:` record's keys directly**: go through `resolveConfig`. A new secret install field must be added to `INSTALL_SECRET_COLUMNS` (a test checks). |
| `28_`, `storeProviderConnection` | A signed-in OAuth callback stores the token and redirects to `/?connected=<provider>` with **no token in the URL**. It returns false (and the callback falls back to the old fragment redirect) when there is no session, no key or no table, so connecting never breaks. Never add a token to a redirect URL for a signed-in browser. |
| `02_`, `encryptToken` / `decryptToken` / `hmacLookupKey` | AES-256-GCM token encryption with key rotation (`TOKEN_ENCRYPTION_KEY`) and an HMAC-SHA256 blind index (`LOOKUP_PEPPER`). Always pass the key ring or `env` explicitly: there is no module-level `env`. Always pass a `context` naming the row (for example `account:<id>:<provider>`), and decrypt with the same one. Use these names only; do not add generic `encrypt` / `decrypt` functions. |

---

## Traps in This Codebase
1. **Files `09_` to `24_` are inside a template literal** (the web page is rendered as one big string):
   - a backslash or `${` in client code must be escaped;
   - prefer `startsWith` / `split` over regular expressions;
   - `\n` in client code must be written `\\n`;
   - a regex literal's escapes are written doubled (`/\\s+/`), and a regex built from a **string** needs four (`new RegExp('\\\\b')`), because the browser's string literal cooks them once more. `tests/client-escapes.test.mjs` fails on a lone backslash in page code;
   - a `data-act-args` value is JSON, never code: pass the array itself and a real `"\n"`, not `jsStringArrayLiteral(...)` or `"\\n"` (08_ had both).
2. **All numbered files share one scope.**
   - Top-level names must be unique across files.
   - New server-only code goes in a new numbered file **after `26_`** (the next free number, see `FILE-INDEX.md`), never between `09_` and `24_`.
   - `25_` and `26_` are the **inside** of `handleFetch` (they share `request`, `env`, `path`, `authenticateCreator`). `27_installs.js` and `28_connections.js` come after the `export default` block, at module level, so they cannot see those; pass what they need. `tests/client-harness.mjs` renders the page from the code **before** `export default`, so page rendering must never depend on `27_`+.
   - Tests that load source files into a sandbox (`loadSourceFunctions`) and call `resolveConfig` must include `27_installs.js`.
3. **In `27_` onward, never write the words `export default` together, even in a comment.** Those files come after the Worker's real export, and `render_check.js` (a CI step) cuts the combined file at the *last* place the words appear, so the page checks break.
4. **Shell heredocs in this environment mangle `\\` sequences.** Write patch scripts to a file and run them, or use the file-editing tool.
5. **The test D1** (`tests/harness.mjs`, real SQLite) enforces D1's limits: 100 bound parameters, 2 MB per row, 100,000-byte statements. A query that trips these would fail in production too.
6. The preview harness (`.claude/launch.json` → `mylists-harness`, port 8787) loads the built Worker once at startup. **Restart it after every rebuild.**
7. **Run the suite both ways:** `node --test tests/*.test.mjs`, then `MLA_TEST_V2_LISTS_READ=1 node --test tests/*.test.mjs` (CI does both). With the variable set, `makeEnv` turns `FF_V2_LISTS_READ` on for every test; a test that sets the flag itself still decides. A test that edits the legacy store directly (KV or `creator_lists`) goes around the v2 mirror. If it is testing the legacy store's own internals, pin it with `delete env.FF_V2_LISTS_READ` and a comment saying why; otherwise make v2 behave the same.
8. **Per-instance caches in `33_`/`34_` remember which database they came from** (`db === env.DB`), because each test has its own. Keep that for any new cache of database state.

---

## Verification
`bash verify.sh -q` (while iterating: `-q --fast`). CI also runs the suite with `MLA_TEST_V2_LISTS_READ=1 node --test tests/*.test.mjs`; run it when touching lists code. Deploy, bindings, secrets, migrations and backups: `docs/OPERATIONS.md`. Release notes: `docs/RELEASES.md`, `CHANGELOG.md`.

## When finishing
Run verification, commit with a clear message, update this file, and push only if the owner asks.
