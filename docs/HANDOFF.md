# Handoff

## Current work: Phase 1, 2 & 3 Nuvio TV Launcher backend integration (2026-11-04, branch `feat/nuvio-tv-phase1`)
- **Collections URL & Artwork Fallbacks**:
  - `collectionsUrl` (`${url.origin}/api/nuvio-tv/collections/${target}`): included in the JSON payload returned by `GET /api/nuvio-tv/sync/:target` and `GET /api/nuvio-tv/sync/default`.
  - Added public collections endpoint `GET /api/nuvio-tv/collections/:target` and `GET /nuvio-default/collections.json` (registered as `public` in `tests/route-access.json`).
  - Added created poster fallbacks for all Collection folders (Genres, Franchises, Studios, Streaming Services, and user Custom Collections): if `coverImageUrl` is missing, it falls back to `/api/channel-poster?name=...` (`POSTER` format for genres, `LANDSCAPE` format for others).
  - Added channel artwork fallbacks for 24/7 Channels: every channel in `channels` array contains `poster`, `posterUrl`, `backdrop`, and `backdropUrl` with fallback to generated artwork (`/api/channel-poster`) if unset.
  - Added artwork fallbacks to `/api/channel-lineup` items so lineup items always supply `poster` and `thumbnail`.
- **Dedicated Pairing Page (`/link` and `/tv`) & Direct QR Code Redirection**:
  - Added standalone server-rendered pairing page `GET /link` and `GET /tv` (with `?code=...` or `?tv_code=...`) registered as `public` in `tests/route-access.json`:
    - Shows pairing code, detects local sign-in (via `localStorage` and `/api/me`), provides 1-click "Link TV Now" button, instant account creation / sign-in forms without modal dependencies, and redirects back to `/`.
    - Fixed CSP blocking: added `nonce="${CSP_NONCE_PLACEHOLDER}"` to `<style>` and `<script>` tags, imported `${DESIGN_TOKENS_CSS}`, added theme detection in `<head>`, and set inline `style="display:none;"` on `#successBox` and `#errorMsg`.
  - Removed the green sticky banner from `src/client/22_client-nuvio-tv-pairing.js`.
  - Scanning or opening `/?source=nuvio_tv&tv_code=...` now immediately 302 redirects to `/link?code=...` (both on the server in `appHomePage` and in the client `initNuvioTvOnboarding`), taking users straight to the clean, dedicated linking interface.
- **Pairing modal trigger & URL query parameter preservation**:
  - Captured `source=nuvio_tv` and `tv_code` immediately and synchronously in the inline HTML preamble (`src/client/16_client-row-core.js`) into `sessionStorage` and `window._nuvio_*` globals before any deferred bundles or routers execute.
  - Updated `initAppShell` in `src/client/24_client-backup-restore-presets.js` to preserve `window.location.search` during initial `history.replaceState`.
  - Added multi-source fallback checking and deduplication in `initNuvioTvOnboarding` in `src/client/22_client-nuvio-tv-pairing.js` so `openNuvioTvPairingModal(tvCode)` opens reliably when signed in and `openNuvioTvAuthModal(tvCode)` opens when signed out.
- **Removed Trakt Box Office Series**:
  - Removed `chart:trakt:boxoffice_tv` from `buildNuvioTvDefaultConfig()`, leaving the 5 core default catalogs (`chart:combined:trending_movies`, `chart:combined:trending_tv`, `chart:combined:popular_movies`, `chart:combined:popular_tv`, `chart:trakt:boxoffice_movies`).
  - Updated unit tests in `tests/nuvio-tv-sync.test.mjs`.
- **Channel Schema & Sync API (`/api/nuvio-tv/sync/:id`) & Collections Artwork**:
  - In `formatNuvioUserChannels` (`src/api/25_api-catalog-routes.js`) and `buildNuvioDefaultChannels` (`src/catalog/08_quickadd-chart-data.js`):
    - Added `posterUrl`: defaults to `https://mylistsaddon.com/api/channel-poster?name=${encodeURIComponent(channel.name)}&v=6`.
    - Added `logoUrl`: outputs network logo or `/api/channel-logo?path=...` / `/api/channel-logo?netId=...`.
    - Set default `category: "My Lists Addon Channels"`.
  - In `buildStreamingServiceFolders` (`src/catalog/08_quickadd-chart-data.js`):
    - Ensured every folder in `col_mylists_streaming_services` outputs non-empty `coverImageUrl` (e.g. landscape artwork URL).
- **Custom Channel Builder & CORS / Lineup**:
  - Added custom `channelLogoUrlInput` in `src/page/13_tab-channels.js`.
  - Added `applyChannelLogoUrl`, `syncChannelLogoUrlInput`, and `setChannelDraftLogo` in `src/client/22_client-nuvio-tv-pairing.js`.
  - Persisted `posterUrl` and `logoUrl` in custom channel payloads during `saveChannel` in `src/client/20_client-channel-builder.js`.
  - Added fallback in web preview rendering to `ORIGIN + '/api/channel-poster?name=' + encodeURIComponent(name) + '&v=6'` when `posterUrl` is empty.
  - Added `OPTIONS` preflight support and `Access-Control-Allow-Origin: *` to `/api/channel-lineup`, ensuring lineup items include `poster`, `thumbnail`, `title`, and media ID (`tmdb:...` or `tt...`).
- **Phase 1 (Default preset, guest manifest, unified sync)**:
  - Built default preset & guest manifest endpoints `/nuvio-default/manifest.json`, `/c/nuvio-default/manifest.json`, and `/nuvio-default/catalog/:type/:id.json` backed by `buildNuvioTvDefaultPreset()` and `buildNuvioTvDefaultConfig()`.
  - Built unified sync route `GET /api/nuvio-tv/sync/:target` (registered as public in `tests/route-access.json`), supporting `"default"` target, user accounts, and install tokens. Computes deterministic SHA-256 `versionHash` and formats collections and channels in Nuvio schema.
- **Phase 2 (New user account seeding for Nuvio TV Launcher & existing user sign-in)**:
  - Implemented `seedNuvioTvNewUser` in `src/catalog/08_quickadd-chart-data.js`.
  - Updated `POST /api/creator/account/register`, `POST /api/creator/register`, and `POST /api/creator/create` to check `body.source === "nuvio_tv"` (or `?source=nuvio_tv`). When set on new account creation, seeds 6 default catalogs in exact order with `randomizeItemsDaily: true`, all quick add channels in `channels_v2`/`creatorsyncchannels`, and all premade collections in `collections`/`creatorsyncpresets`.
  - Normal registrations without `source=nuvio_tv` remain completely unseeded.
  - Existing user sign-in (`POST /api/creator/account/login`, `POST /api/creator/restore`) preserves existing user lists/channels/collections without overwriting.
  - Added routes in `tests/route-access.json`: `/api/creator/account/register` (public), `/api/creator/register` (public), `/api/creator/account/login` (account).
- **Phase 3 (TV device pairing & post-registration redirect to Nuvio account sign-in)**:
  - Implemented pairing endpoints in `src/api/69_creator-api-sync-routes.js`:
    - `POST /api/nuvio-tv/device/code` (public): generates random `deviceCode` (UUID) and 6-char `userCode` (e.g. `K4P-89M`), stored with 10-minute TTL in KV, returns `{ ok: true, deviceCode, userCode, verificationUrl }`.
    - `GET /api/nuvio-tv/device/poll?deviceCode=...` (public): returns `{ ok: true, status: "pending" }` or `{ ok: true, status: "authenticated", installId, manifestUrl, syncUrl }`.
    - `POST /api/nuvio-tv/device/claim` (account): verifies creator authentication, validates `userCode` (with or without hyphen), binds account's active `installId`, `manifestUrl`, and `syncUrl` to KV record.
  - Added frontend pairing and onboarding flow:
    - `src/page/15_tab-settings-html.js`: added `#nuvioTvOnboardingBanner` in `#nuvioSection` ("Step 2: Sign in with your Nuvio account below to view your Continue Watching, Watch History, and Library on the website.").
    - `src/client/22_client-nuvio-tv-pairing.js`: checks URL params `source=nuvio_tv` and `tv_code`; presents `openNuvioTvPairingModal(tvCode)` with an explicit "Link TV" button when already signed in, and `openNuvioTvAuthModal(tvCode)` when signed out; verifies claim using `creatorApiFetch` (supporting session cookies and keys) and presents `showNuvioTvPairingSuccessModal(tvCode)` upon success.
    - `src/client/23_client-list-management.js`: declared `shufflePickerSignature` with `var` to avoid temporal dead zone (TDZ) reference errors during early bundle evaluation.
    - `src/client/22_client-creator-profile.js`: updated `submitCreateProfile` and `submitRestoreProfile` to pass `source: "nuvio_tv"` and trigger `handleNuvioTvPostAuth()`; updated `loadCreatorSync` to restore `customCollections` and `randomizeItemsDaily`.
  - All unit tests in `tests/nuvio-tv-sync.test.mjs` (18 tests) and verification checks pass.

### Must not be undone
- `/nuvio-default/manifest.json`, `/nuvio-default/collections.json`, `/api/nuvio-tv/sync/:target`, `/api/nuvio-tv/collections/:target`, `/api/nuvio-tv/device/code`, `/api/nuvio-tv/device/poll`, `/link`, and `/tv` are public endpoints for Nuvio TV Launcher out-of-the-box experience, device sync, and pairing.
- `/api/nuvio-tv/device/claim` is an `account` route requiring creator authentication.
- `handleNuvioTvSyncRoute` is split into sub-helpers (`buildNuvioTvSyncDefaultResponse`, `handleNuvioTvCollectionsRoute`, `handleNuvioTvLinkPage`, `buildNuvioTvLinkPageCss`, `buildNuvioTvLinkPageJs`, `buildNuvioTvLinkPageAuthJs`, `formatNuvioUserCollections`, `formatNuvioUserChannels`, `resolveNuvioTvTargetData`) to stay well within the 150-line size budget limit.
- `creatorApiCreate` delegates profile persistence to `persistNewCreatorProfile` to stay well within the 150-line limit.
- Seeding only runs when `source === "nuvio_tv"` on a brand new registration. Normal web/Nuvio registrations and existing user logins must never be overwritten.
- `tests/route-access.json` lists all public and account routes with their expected authorization class.

## Earlier work: performance audit fixes (2026-11-03, branch `claude/kind-bell-5wa9ht`, not deployed)
Plan: `docs/PERF_AUDIT_PLAN.md`. Done: PERF-00, 12, 05, 08+07 (both steps), 09, 01, 11 step 1, 03, 16, 06, 04. **Not built: PERF-02** (below). Not built by instruction: PERF-10, 11 step 2, 13, 14, 15. Results are in `docs/PERFORMANCE.md` section 3 and `docs/RELEASES.md` (2026-11-03). No migration, binding or flag; deploy the rebuilt Worker only.

### Must not be undone
- Counters (`bumpStat`/`bumpStatBy`, `src/admin/04_stat-counters.js`) are batched in the isolate: up to a minute of counts can be lost if an isolate is recycled (owner accepted). Every admin stats read, cron tick and queue delivery flushes first. Security counters (`authfail:*`, rate limits) are direct upserts and must stay unbatched. A test that reads the `stats` table straight after a request calls `flushStats(env)` (tests/harness.mjs).
- Size ratchet: `src/core/02_http-and-creator-utils.js` and `src/admin/03_admin.js` are over 3,000 lines and may only shrink; new code goes in new files (`src/core/05_page-response.js`, `05_shelf-owner.js`, `src/admin/04_stat-counters.js`). Tests that load source files into a sandbox by list need those files too.
- `/app.js`, `/app-features.js`, `/app.css` and the page are held by `tests/asset-size-budget.json` (2% allowance, `--update` only lowers).
- `sync/meta` returns the record's own `updatedAt` for activity-database accounts (same number `sync/load` returns). Anything that changes an account's tracking must bump `settings.tracking.updatedAt`, or other open tabs will not notice (a ping does today because it goes through the blob path).
- `verifyShelfOwner` is remembered 10 s per (name, key); purge and key rotation clear it on the same isolate, other isolates lag up to 10 s.

### PERF-02 (playback ping), blocked, owner/next-AI decision
`tests/perf-ping-cost.test.mjs` pins today's cost (500 plays: 2 full `watch_events` reads, 14 activity statements per ping). The plan's fix (call `recordActivityPlay` directly for activity accounts) would lose, with no test able to hide it:
1. The next-episode and "fully watched" decision. `applyEpisodePlayToBlob` asks TMDB for the next aired episode, un-completes a finished show when a new episode is played, and marks it completed when nothing is ahead. `recordActivityPlay` only moves `show_progress` forward and never touches `status = 'completed'`.
2. A first-ever play of a show gets its Continue Watching entry from that blob step; the schedule job (`show.refresh`) only fills it in later (`shelfStoredForUnknown`).
3. The record's `updatedAt` bump (see PERF-03 above) would need an explicit write.
It also only holds with `FF_SHOW_SCHEDULE` on. Smaller option not built (not in the plan): for activity accounts drop the second `env.CONFIGS.get(syncKey)` race check in `writeSubtitlesPlayRecord` (one full assembly less per ping); concurrent pings then can overwrite each other's stored Continue Watching entry. The webhook (`64_media-server-scrobble.js recordScrobblePlay`) has the same shape and the same blockers.

### Findings for the owner / next AI
- **PERF-04 note:** `apiuse:*` still counts catalog-row requests on the shared TMDB key, not real outbound calls (product change, not made). `evt:*`, `searchq:*`, genre/decade counters call `d1BumpStat` directly and are still one write per event.
- **PERF-03 note:** the old `sync/meta` value was the last `"updatedAt":` in the assembled JSON, usually a Continue Watching item's stamp, which could sit above what the browser had and force a reload every minute. A play added by an app (not via website save or ping) bumps neither the old value reliably nor the new one; it shows after the next save or full load.
- **PERF-10:** add a preview-fetch counter to `writeRequestMetrics` and look at p95 after a week before persisting previews. Not started.
- **PERF-11 step 2 (do not ship without review).** Survey of `/app-features.js` (1,790 KB raw, `defer`, 933 top-level names, 186 `window.x =` assignments): app.js text mentions 97 of those names (some are false hits such as `generate`, `renumber`, `slugify`, `saveState`; confirm each). Real cross-bundle calls include: `escapeHtml`, `escapeAttr`, `isEpisodeAired`, `getBadgeSetting`, `loadLocalCustomLists`, `pushCreatorSync`, `loadCreatorSync`, `renderCreatorDashboard`, `openListDetailsPage`, `populateSearchResultPosters`, `handlePosterImgError`, `formatWatchItemLabel`, `initAppShell` and the appShell* helpers, `switchChannelsSubmenu`, `editChannel`, `saveChannel`, `editCustomList`, `addItemsToWatchHistory`, `toggleWatchStatus`, `markSeasonWatched`, `renderPresetsList`, `downloadConfigJson`, `applyImportedConfig`. 27 `window.*` values set in features are read as `window.*` from app.js: `_listPreviewCache`, `_listScrollY`, `_previousTab`, `_previousScrollY`, `_originTab`, `_tabScrollY`, `_currentListDetailsParams`, `_updateListDetailsItemCount`, `_discoverFeedsCache`, `_myTraktLists`, `_myPrivateTraktLists`, `_myTmdbLists`, `_myMdblistLists`, `_mySimklLists`, `_simklListsMap`, `_previous{Catalogs,Lists,Channels}Submenu`, `_previousDiscoverFilter`, `tmdbSessionId`, `tmdbAccountId`, `tmdbUsername`, `mdblistAccessToken`, `traktAccessToken`, `simklAccessToken`, `simklUsername`, `myListAddonManifestUrl`. The page has 0 inline `on*=` handlers and app.js has no `DOMContentLoaded` listener, so load order (defer) is the risk, not inline calls. `fflate` (32 KB) is only used by the Trakt/Letterboxd zip import (`18_`) and backup restore (`24_`), so it can load on demand first.
- **PERF-13 (done):** owner confirmed `FF_SHOW_SCHEDULE` is on and every account is copied. The two old sweeps now return at once when `legacyShelfSweepNeeded` (40_) finds no uncopied account; they were not deleted, so an uncopied account (new, or a failed copy) is still swept until `activity.copy-new` copies it. Once that has been true for a while, the job definitions in 45_ could be removed outright (ask the owner).
- **PERF-14:** no change; watch D1 write latency on rate-limited routes in the request metrics.
- **PERF-15:** measure with Analytics Engine (`routeFamily` = `stremio:catalog`) how often one install asks for one row within 30 minutes before adding a `caches.default` layer.

## Earlier work: independent My Lists Collections addon (2026-11-01)
- Fixed branch `arena/e8d2fa71-my-lists-addon`; main merged through `39996de`. Collections now install as **My Lists Collections**, ID `app.my-list.collections`, separate from regular **My Lists**, ID `app.my-list`. Sync never replaces/renames/reorders/enables/disables the regular addon. Its generated link can be edited/revoked/reinstalled independently.
- Uses existing v2 installs: account/profile-scoped config with `nuvioCollectionsProfile` marker, independent random bearer token (hash only in DB). Finds/reuses the installed token from Nuvio, checking owner/profile, including base URLs without manifest.json. Saves only collection source catalogs, with durable custom URLs in the install config instead of global expiring col_cat mappings. Copies non-secret appearance prefs from the home link once, then stays independent. No extra playback tracking resource. Owned config edits/revocations keep the distinct addon identity; account purge uses existing install cleanup.
- Sources using legacy `app.my-list` migrate to the collections ID during sync; external sources stay unchanged. Home hiding applies only to the new addon ID, leaving regular home keys alone. Standalone manifest is no-store and does not advertise all premades/search rows; its catalog route refuses undeclared IDs. Client import/export recognizes the new ID and linked-folder writes retain the server-returned migrated snapshot for the next optimistic update.
- Nuvio addon reads now fail closed using its documented per-profile table query, with no empty/other-profile fallback. APIs still write full blobs/lists separately; not atomic across services, avoid simultaneous edits in other clients. Existing config/install limits apply. Old ?collections=1 links keep their old behavior and are deliberately not rewritten.
- Deploy rebuilt Worker **842c0f41a0**, no migration/new secret/flag. Sync all local folders once; choose Merge into existing for an already-installed collection to avoid duplicates. Local custom URLs are needed if old custom refs cannot otherwise be resolved. If the regular addon still uses old ?collections=1, reinstall it from the normal generated home link after migration to remove legacy extra catalogs. Separation protects reinstalling the My Lists addon, not deleting/resetting an entire Nuvio account/profile.
- Checks: **405 focused pass**; full suite passes (cold-catalog test fixed by PERF-00). Build/sync/syntax, HTML/actions, worker/client scope pass. Browser UI-contract blocked by absent Playwright/Chromium. Live Nuvio device verification remains outstanding; user previously reported hiding failing in Desktop 0.1.33/mobile, don't claim a proven live fix. Shared home settings still use home_catalog_shared/items/enabled with explicit-key matching and read-back confirmation.
- Preserve title-logo enrichment and previous Nuvio history work (activity migration A0002 before the history feature's deployment; docs/NUVIO_HISTORY_DEPLOYMENT.md). No feature-flag changes.
