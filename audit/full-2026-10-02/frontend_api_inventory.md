# Frontend API Inventory

This document catalogs every network API call made by the client-side JavaScript application (`09_page-shell.js` through `24_client-backup-restore-presets.js`, `03_admin.js`, and `service-worker.js`).

---

## 1. Authentication, Sessions & Account Identity

### `POST /api/creator/create`
- **Method:** `POST`
- **Caller:** `submitCreateProfile()` (`22_client-creator-profile.js:3936`)
- **Request Body:** `{ creatorName: string, displayName?: string, recoveryAnswer?: string }`
- **Response:** `{ ok: true, creatorName: string, displayName: string, creatorKey: string }` or `{ ok: false, error: string }`
- **Loading State:** Button `#createProfileSubmitBtn` disabled with label `'Creating…'` via `beginSubmit('createProfile')`.
- **Success State:** Closes modal, saves `myListAddon:creatorName`, `creatorKey`, and `creatorDisplayName` to `localStorage`, sets `activeCreator`.
- **Error State:** Injects error text into `#createProfileError`.
- **Retry:** None; user re-submits.
- **Optimistic Update:** None.
- **Rollback:** In-flight guard released on failure.
- **Cache:** None (`no-store`).

---

### `POST /api/creator/restore`
- **Method:** `POST`
- **Caller:** `submitRestoreProfile()` (`22_client-creator-profile.js:1818`), `tryAutoRestoreCreatorProfile()` (`22_client-creator-profile.js:2012`)
- **Request Body:** `{ creatorName: string, creatorKey: string }`
- **Response:** `{ ok: true, creatorName: string, displayName: string, session?: boolean, hasRecoveryAnswer?: boolean }` or `{ ok: false, error: string }`
- **Loading State:** Button `#restoreSubmitBtn` disabled with label `'Signing in…'` via `beginSubmit('restoreProfile')`.
- **Success State:** Calls `clearLocalAccountData()`, populates credentials in `localStorage` and `activeCreator`, establishes session, triggers gated `loadCreatorSync()`.
- **Error State:** Displays error message in `#restoreErrorBox`.
- **Retry:** None.
- **Optimistic Update:** None.
- **Rollback:** In-flight guard released.
- **Cache:** None.

---

### `POST /api/creator/reset-key`
- **Method:** `POST`
- **Caller:** `submitForgotKey()` (`22_client-creator-profile.js:1899`)
- **Request Body:** `{ creatorName: string, recoveryAnswer: string }`
- **Response:** `{ ok: true, creatorKey: string }` or `{ ok: false, error: string }`
- **Loading State:** Button `#forgotKeySubmitBtn` disabled with label `'Resetting…'`.
- **Success State:** Saves new key, updates `#accountKeyDisplay`, alerts user to copy new key.
- **Error State:** Renders error alert in modal.
- **Retry:** None.
- **Optimistic Update:** None.
- **Rollback:** Guard released.
- **Cache:** None.

---

### `POST /api/creator/forgot-username`
- **Method:** `POST`
- **Caller:** `submitForgotUsername()` (`22_client-creator-profile.js:1962`)
- **Request Body:** `{ recoveryAnswer: string }`
- **Response:** `{ ok: true, usernames: string[] }` or `{ ok: false, error: string }`
- **Loading State:** Button `#forgotUsernameSubmitBtn` disabled with label `'Searching…'`.
- **Success State:** Populates list of matched usernames in modal.
- **Error State:** Renders error notice.
- **Retry:** None.
- **Optimistic Update:** None.
- **Rollback:** Guard released.
- **Cache:** None.

---

### `DELETE /api/session`
- **Method:** `DELETE`
- **Caller:** `switchCreatorProfile()` (`22_client-creator-profile.js:1767`), `appShellSignOut()` (`24_client-backup-restore-presets.js:3582`)
- **Headers:** `{ 'Accept': 'application/json', 'Content-Type': 'application/json' }` (with SameSite cookies)
- **Response:** `{ ok: true }`
- **Loading State:** In `appShellSignOut`, asynchronous await.
- **Success State:** Clears `mla_session` cookie; calls `clearLocalAccountData()`, sets `appShellState.account = null`.
- **Error State:**
  - In `switchCreatorProfile`: Exception caught, `clearLocalAccountData()` executes unconditionally (offline safe).
  - In `appShellSignOut`: If `!res.ok`, aborts early with error toast without clearing local data (`AUDIT-FE-001`).
- **Retry:** None.
- **Optimistic Update:** None.
- **Rollback:** N/A.
- **Cache:** None (`no-store`).

---

### `GET /api/me`
- **Method:** `GET`
- **Caller:** `appShellRefreshSettingsHome()` (`24_client-backup-restore-presets.js:3243`)
- **Response:** `{ ok: true, account: { name: string, displayName: string, createdAt: number, hasRecoveryAnswer: boolean } }`
- **Loading State:** Async background refresh.
- **Success State:** Updates `appShellState.account` and re-renders Settings tab.
- **Error State:** If `res.status === 401`, resets `appShellState.account = null`.
- **Retry:** Polled on tab switch / visibility resume.
- **Optimistic Update:** None.
- **Rollback:** N/A.
- **Cache:** `no-store`.

---

### `GET /api/me/sessions` & `DELETE /api/me/sessions`
- **Method:** `GET`, `DELETE`
- **Caller:** `appShellLoadSessions()`, `appShellRevokeSession()`, `appShellRevokeOtherSessions()` (`24_client-backup-restore-presets.js:3523, 3637, 3648`)
- **Request Body (DELETE):** `{ id: string }` or `{ allExceptCurrent: true }`
- **Response:** `{ ok: true, sessions?: Session[] }`
- **Loading State:** Modal spinner / button busy text.
- **Success State:** Refreshes device session list; displays success toast.
- **Error State:** Displays error toast.
- **Retry:** None.
- **Optimistic Update:** None.
- **Rollback:** N/A.
- **Cache:** `no-store`.

---

### `POST /api/creator/delete-account` / `DELETE /api/me`
- **Method:** `POST` / `DELETE`
- **Caller:** `deleteCreatorAccount()` (`22_client-creator-profile.js:904`), `appShellDeleteAccount()` (`24_client-backup-restore-presets.js:3604`)
- **Request Body:** `{ creatorName: string, creatorKey: string }` or `{ confirm: 'DELETE' }`
- **Response:** `{ ok: true }`
- **Loading State:** Modal confirmation dialog.
- **Success State:** Calls `clearLocalAccountData()`, redirects / resets UI to unauthenticated state.
- **Error State:** Displays error alert.
- **Retry:** None.
- **Optimistic Update:** None.
- **Rollback:** N/A.
- **Cache:** `no-store`.

---

## 2. Cloud Sync & Multi-Device Coordination

### `POST /api/creator/sync/load`
- **Method:** `POST`
- **Caller:** `loadCreatorSync(opts)` (`22_client-creator-profile.js:3021`)
- **Request Body:** `{ creatorName: string, creatorKey: string }`
- **Response:** `{ ok: true, data: { config, tracking, presets, channels, updatedAt, trackingUpdatedAt, presetsUpdatedAt, channelsUpdatedAt } }`
- **Loading State:** Non-blocking background sync; gates pending outgoing pushes (`_creatorSyncLoadedFor`).
- **Success State:** Adopts remote stamps (`_syncMetaStamps`), reconciles new local rows with remote rows, restores channels/presets/tracking, opens sync gate.
- **Error State:** Invocates `armCreatorSyncGateFailsafe()` (opens gate after timeout so pushes are not blocked forever).
- **Concurrency & Stale Check:** Validates `isStale = () => !activeCreator || activeCreator.creatorName !== loadingFor` before and after JSON parsing.
- **Retry:** Polled on tab switch and resume.
- **Optimistic Update:** Local changes kept in `newLocalEntries`.
- **Rollback:** If `shouldApplyAccountReset(data.resetAt)` is true, wipes stale local state.
- **Cache:** Memory snapshot in `_syncMetaStamps`.

---

### `POST /api/creator/sync/save`
- **Method:** `POST`
- **Caller:** `pushCreatorSync()` (`22_client-creator-profile.js:2603`)
- **Request Body:** `{ creatorName: string, creatorKey: string, config: Entry[], expectedUpdatedAt?: number }`
- **Response:** `{ ok: true, updatedAt: number }` or `{ ok: false, conflict: true, updatedAt: number }` (409)
- **Loading State:** Debounced 3000ms via `scheduleCreatorSyncSave()`.
- **Success State:** Updates `window._serverSyncUpdatedAt` and `_syncMetaStamps.config`.
- **Error State (409 Conflict):** Server rejects stale write. Triggers `loadCreatorSync()` to pull newer remote changes.
- **Retry:** 1 scheduled retry after conflict resolution.
- **Optimistic Update:** Config is already saved in `#lists` DOM and `localStorage['myListAddon:state']`.
- **Rollback:** On 409 conflict, adopts remote config while preserving uncommitted local entries.
- **Cache:** `localStorage['myListAddon:syncBaselines']`.

---

### `POST /api/creator/sync/save-tracking`
- **Method:** `POST`
- **Caller:** `pushTrackingSync()` (`22_client-creator-profile.js:2851`)
- **Request Body:** `{ creatorName: string, creatorKey: string, watchHistory, continueWatching, dismissedContinueWatching, removedAiringNext, expectedUpdatedAt?: number }`
- **Response:** `{ ok: true, trackingUpdatedAt: number }`
- **Loading State:** Debounced 300ms.
- **Success State:** Updates `window._serverTrackingUpdatedAt`.
- **Error State (409 Conflict):** Reloads tracking data from server.
- **Retry:** None.
- **Optimistic Update:** Yes; watch history updated locally in memory and storage before sync.
- **Rollback:** Server version adopted on 409 conflict.
- **Cache:** `localStorage['myListAddon:syncBaselines']`.

---

### `POST /api/creator/sync/save-channels`
- **Method:** `POST`
- **Caller:** `pushChannelsSync()` (`22_client-creator-profile.js:2530`)
- **Request Body:** `{ creatorName: string, creatorKey: string, channels: object, mergedChannels: object, expectedUpdatedAt?: number }`
- **Response:** `{ ok: true, channelsUpdatedAt: number }`
- **Loading State:** Debounced 1000ms.
- **Success State:** Updates `window._serverChannelsUpdatedAt`.
- **Error State:** Checked against 24MB payload cap.
- **Retry:** None.
- **Optimistic Update:** Saved locally in `loadLocalChannels()` before push.
- **Rollback:** Adopts server on conflict.
- **Cache:** `localStorage['localChannels']`.

---

### `POST /api/creator/sync/save-presets`
- **Method:** `POST`
- **Caller:** `pushPresetsDirectly()` (`24_client-backup-restore-presets.js:1211`)
- **Request Body:** `{ creatorName: string, creatorKey: string, presetsB64: string, expectedUpdatedAt?: number }`
- **Response:** `{ ok: true, presetsUpdatedAt: number }`
- **Loading State:** Async background push.
- **Success State:** Updates `window._serverPresetsUpdatedAt`.
- **Error State:** Logged to console.
- **Retry:** None.
- **Optimistic Update:** Local preset saved first.
- **Rollback:** Adopts server version on conflict.
- **Cache:** `localStorage['presets']`.

---

### `GET /api/creator/sync/meta`
- **Method:** `GET`
- **Caller:** `handleForegroundResumeSync()` (`22_client-creator-profile.js:6874`)
- **Response:** `{ ok: true, config: number, tracking: number, presets: number, channels: number, lists: number }`
- **Loading State:** Background poll on tab focus.
- **Success State:** Compares remote timestamps against `_syncMetaStamps`. Only dispatches full `loadCreatorSync()` if any timestamp has changed.
- **Error State:** Silent failure.
- **Retry:** On next visibility change.
- **Optimistic Update:** N/A.
- **Rollback:** N/A.
- **Cache:** Memory stamps.

---

## 3. Custom Lists & Like System

### `GET /api/creator/lists`
- **Method:** `GET`
- **Caller:** `fetchCreatorListsOnce()` (`22_client-creator-profile.js:4323`)
- **Headers / Query:** Authenticated via session cookie or `creatorName` & `creatorKey` in body.
- **Response:** `{ ok: true, lists: CreatorList[] }`
- **Loading State:** Renders placeholder skeleton in `#creatorDashboard`.
- **Success State:** Stores in `lastCreatorListsData`, renders list cards with edit/delete/copy buttons.
- **Error State:** Displays error message in dashboard container.
- **Retry:** None.
- **Optimistic Update:** None.
- **Rollback:** N/A.
- **Cache:** In-memory `lastCreatorListsData` (invalidated via `resetCreatorListsCache()`).

---

### `POST /api/creator/lists/save`
- **Method:** `POST`
- **Caller:**
  - `saveCustomList()` (`21_client-custom-list-builder.js:478`) [New list]
  - `saveCreatorListEdit()` (`21_client-custom-list-builder.js:593`) [Edit existing]
  - `saveCreatorListWithBaseline()` (`22_client-creator-profile.js:6499`) [Item mutation]
- **Request Body:** `{ creatorName: string, creatorKey: string, slug?: string, name: string, type: string, items: Item[], visibility: string, expectedUpdatedAt?: number }`
- **Response:** `{ ok: true, slug: string, url: string, updatedAt: number }`
- **Loading State:**
  - When editing: `#customListSaveBtn` locked with `'Saving…'` via `beginSubmit('saveCreatorList')`.
  - When new: No in-flight lock; button remains active until synchronous state clear.
- **Success State:** Adds row to `#lists`, refreshes Live Preview, displays modal with share link.
- **Error State:**
  - 409 Conflict: `saveCreatorListWithBaseline` invalidates cache and refuses overwrite.
  - Non-200: Displays error toast.
- **Retry:** None.
- **Optimistic Update:**
  - For single-item mutations: List item optimistically added/removed in DOM.
  - For full list save: Local storage updated.
- **Rollback:** If save fails on item mutation, re-fetches latest list items.
- **Cache:** In-memory `lastCreatorListsData`.

---

### `POST /api/creator/lists/delete`
- **Method:** `POST`
- **Caller:** `deleteCreatorList()` (`22_client-creator-profile.js:5557`)
- **Request Body:** `{ creatorName: string, creatorKey: string, slug: string }`
- **Response:** `{ ok: true }`
- **Loading State:** Modal confirm dialog.
- **Success State:** Removes card from `#creatorDashboard`, deletes from local map, removes matching catalog row from `#lists`.
- **Error State:** Displays error toast.
- **Retry:** None.
- **Optimistic Update:** Optimistic card removal from DOM.
- **Rollback:** Re-renders dashboard if server rejects deletion.
- **Cache:** Cache invalidated.

---

### `POST /api/creator/lists/reorder`
- **Method:** `POST`
- **Caller:** `saveCreatorListOrder()` (`22_client-creator-profile.js:5997`)
- **Request Body:** `{ creatorName: string, creatorKey: string, slugs: string[] }`
- **Response:** `{ ok: true }`
- **Loading State:** Drag-and-drop UI handle.
- **Success State:** Background save; silent success.
- **Error State:** Error logged to console.
- **Retry:** None.
- **Optimistic Update:** DOM order changed immediately upon drag drop.
- **Rollback:** None.
- **Cache:** In-memory order updated.

---

### `POST /api/lists/like` & `POST /api/lists/like-external`
- **Method:** `POST`
- **Caller:** `handleLikeClick()` (`19_client-search-and-likes.js:1599, 1675`)
- **Request Body:**
  - `/api/lists/like`: `{ username: string, slug: string, action: 'like' | 'unlike', creatorName?: string, creatorKey?: string }`
  - `/api/lists/like-external`: `{ url: string, action: 'like' | 'unlike', creatorName?: string, creatorKey?: string }`
- **Response:** `{ ok: true, likes: number }`
- **Loading State:** Button disabled immediately (`likeBtn.disabled = true`).
- **Success State:** Updates `rememberLikedList()` / `forgetLikedList()`, updates heart icon (`♥` / `♡`), updates `.like-num` counter. Background sync to profile via `/api/creator/sync/like`.
- **Error State:** Re-enables button; shows alert/toast with error message.
- **Retry:** None.
- **Optimistic Update:** Wait for response (`data.ok === true`) before committing DOM/storage changes.
- **Rollback:** Button state restored in `finally { likeBtn.disabled = false }`.
- **Cache:** `localStorage['myListAddon:likedLists']`.

---

## 4. Channels & Continuous Streaming

### `POST /api/channel/share` & `GET /api/channel/share?code=...`
- **Method:** `POST` (Publish) / `GET` (Resolve)
- **Caller:** `postChannelShare()` (`20_client-channel-builder.js:12183`), `resolveChannelShare()` (`20_client-channel-builder.js:12327`)
- **Request Body (POST):** `{ channel: ChannelPayload, code?: string, publish: boolean, creatorName?: string, creatorKey?: string }`
- **Response:** `{ ok: true, code: string, published: boolean, owner?: string }`
- **Loading State:** No button disabling in `saveChannel` (`AUDIT-FE-002`).
- **Success State:** Updates channel record with `shareCode` and `sharePublished`, saves to `localChannels`, displays share modal.
- **Error State:** Catches error silently.
- **Retry:** None.
- **Optimistic Update:** Channel saved in `localStorage['localChannels']`.
- **Rollback:** None.
- **Cache:** `localStorage['localChannels']`.

---

### `GET /api/channel-lineup` / `POST /api/channel-lineup`
- **Method:** `GET` / `POST`
- **Caller:** `previewChannelLineup()` (`23_client-list-management.js:2424`), `appShellChannelLineup()` (`24_client-backup-restore-presets.js:6011`)
- **Request Body / Query:** `{ url: string }`
- **Response:** `{ ok: true, lineup: EpisodeItem[] }`
- **Loading State:** Loading spinner in channel preview modal.
- **Success State:** Renders calculated lineup schedule with Air Time and show rotation badges.
- **Error State:** Displays error message in preview container.
- **Retry:** None.
- **Optimistic Update:** None.
- **Rollback:** N/A.
- **Cache:** `no-store`.

---

### `GET /api/channel/directory`
- **Method:** `GET`
- **Caller:** `loadChannelDirectory()` (`20_client-channel-builder.js:12420`)
- **Query Parameters:** `?limit=60&sort=popular|newest`
- **Response:** `{ ok: true, channels: PublicChannel[] }`
- **Loading State:** Spinner in Channel Directory panel.
- **Success State:** Renders channel cards with preview posters, Like button, and "+ Add" button.
- **Error State:** Renders error notice.
- **Retry:** None.
- **Optimistic Update:** None.
- **Rollback:** N/A.
- **Cache:** `no-store`.

---

### `POST /api/channel/like` & `POST /api/channel/added`
- **Method:** `POST`
- **Caller:** `toggleChannelLike()` (`20_client-channel-builder.js:12580`), `recordChannelAdded()` (`20_client-channel-builder.js:12633`)
- **Request Body:** `{ code: string, action: 'like' | 'unlike' }` / `{ code: string }`
- **Response:** `{ ok: true, likes?: number }`
- **Loading State:** Button disabled during like request.
- **Success State:** Toggles heart class, updates like count.
- **Error State:** Displays toast error.
- **Retry:** None.
- **Optimistic Update:** None; waits for `data.ok`.
- **Rollback:** Re-enables button in `finally`.
- **Cache:** `no-store`.

---

### `POST /api/channel/unpublish`
- **Method:** `POST`
- **Caller:** `unpublishChannelByCode()` (`20_client-channel-builder.js:12988`)
- **Request Body:** `{ code: string, creatorName?: string, creatorKey?: string }`
- **Response:** `{ ok: true }`
- **Loading State:** In-flight await.
- **Success State:** Updates channel record to `sharePublished = false`.
- **Error State:** Logs error.
- **Retry:** None.
- **Optimistic Update:** Optimistically marks private.
- **Rollback:** None.
- **Cache:** `localChannels`.

---

## 5. Catalog Search, Title Metadata & Details

### `GET /api/title-search`
- **Method:** `GET`
- **Caller:** `runCatalogSearch()` (`19_client-search-and-likes.js:5053`), `searchChannelTitles()` (`20_client-channel-builder.js:88`)
- **Query Parameters:** `?type=movie|tv&q=...&adultContentFilter=1`
- **Response:** `{ ok: true, results: TitleResult[] }`
- **Loading State:** `<p><small>Searching...</small></p>` in `#catalogSearchResult`.
- **Success State:** Caches in `window._rawCatalogTitleItems`, renders poster grid.
- **Error State:** Injects error markup into results container.
- **Concurrency & Cancellation:** Guarded by `if (thisSeq !== currentTitleSearchSequence) return;` (out-of-order queries discarded).
- **Retry:** None.
- **Optimistic Update:** None.
- **Rollback:** N/A.
- **Cache:** Stashed in `window._catalogSearchViewCache`.

---

### Unified List Search (`/api/trakt-search`, `/api/tmdb-search-lists`, `/api/search-published-lists`)
- **Method:** `GET` (parallel `Promise.all`)
- **Caller:** `executeUnifiedListSearch()` (`19_client-search-and-likes.js:801-818`)
- **Query Parameters:** `?q=...&tmdbKey=...&traktKey=...&adultContentFilter=1`
- **Response:** `{ ok: true, lists: ListResult[] }`
- **Loading State:** `<p><small>Searching lists…</small></p>`.
- **Success State:** Merges Trakt, TMDB, MDBList, and community lists; renders list cards with poster previews.
- **Error State:** Displays error state per source if unavailable.
- **Concurrency & Cancellation:**
  - Primary search guarded by `if (thisSeq !== currentListSearchSequence) return;`.
  - Fallback search (`altRes`) lacks sequence counter check (`AUDIT-FE-003`).
- **Retry:** None.
- **Optimistic Update:** None.
- **Rollback:** N/A.
- **Cache:** 1-hour in-memory cache in `window._unifiedSearchCache`.

---

### `POST /api/preview` & `GET /api/preview`
- **Method:** `POST` / `GET`
- **Caller:** `loadListPreviewPosters()` (`19_client-search-and-likes.js:1133`), `renderLivePreview()` (`16_client-row-core.js`), `openSeeAllDetail()` (`23_client-list-management.js:267`)
- **Request Body / Query:** `{ url: string, name?: string, type?: string, creatorKey?: string }`
- **Response:** `{ ok: true, name: string, type: string, items: PreviewItem[] }`
- **Loading State:** Placeholder skeleton posters.
- **Success State:** Populates poster images, title subtitles, item counts, and rating badges.
- **Error State:** Replaces slot with fallback placeholder or cached snapshot.
- **Retry:** 1 fallback attempt with stale cache.
- **Optimistic Update:** None.
- **Rollback:** N/A.
- **Cache:** In-memory poster cache; snapshot fallbacks for Continue Watching/Airing Next.

---

### `GET /api/details` & `POST /api/details/batch`
- **Method:** `GET` / `POST`
- **Caller:** `fetchTitleDetails()` (`19_client-search-and-likes.js:3402`), `batchFetchDetails()` (`20_client-channel-builder.js:9679`)
- **Request Body / Query:** `?imdbId=...&type=movie|series` or `{ ids: string[] }`
- **Response:** `{ ok: true, details: { title, year, overview, poster, backdrop, genres, cast, rating } }`
- **Loading State:** Async poster badge or detail modal loading.
- **Success State:** Renders title details modal with synopsis and watch button.
- **Error State:** Fallback to basic title and default poster.
- **Retry:** None.
- **Optimistic Update:** None.
- **Rollback:** N/A.
- **Cache:** Memoized in `window._episodeDataCache`.

---

### `GET /api/season`, `GET /api/show-seasons`, `GET /api/show-episodes`
- **Method:** `GET`
- **Caller:** Channel Builder show episode picker (`20_client-channel-builder.js:229, 338`) and Custom List episode picker (`21_client-custom-list-builder.js:2030, 2772`)
- **Query Parameters:** `?tmdbId=...` or `?imdbId=...&season=...`
- **Response:** `{ ok: true, seasons: SeasonInfo[], episodes: EpisodeInfo[] }`
- **Loading State:** Picker dropdown loading indicator.
- **Success State:** Renders episode checkboxes with titles and thumbnails.
- **Error State:** Renders notice "Episodes unavailable".
- **Retry:** None.
- **Optimistic Update:** None.
- **Rollback:** N/A.
- **Cache:** Cached in `window._seasonEpisodesMap`.

---

## 6. External Providers & OAuth Connections

### `POST /api/trakt/device/code` & `POST /api/trakt/device/token`
- **Method:** `POST`
- **Caller:** `startTraktDeviceAuth()` (`17_client-my-lists-and-trakt-oauth.js:907, 953`)
- **Request Body:** None / `{ device_code: string }`
- **Response:** `{ user_code: string, verification_url: string, device_code: string, expires_in: number, interval: number }` -> `{ ok: true, access_token: string }`
- **Loading State:** Modal showing `user_code` and countdown timer; button shows `'Waiting for approval…'`.
- **Success State:** Polls at `interval` seconds until user authorizes; saves token, closes modal, refreshes Trakt lists.
- **Error State:** If expired or rejected, displays error notice and stops poll.
- **Retry:** Automatic polling loop respecting `interval`.
- **Optimistic Update:** None.
- **Rollback:** Polling interval cleared on modal close.
- **Cache:** In-memory `traktAccessToken`.

---

### `GET /api/connections` & `DELETE /api/connections/:provider`
- **Method:** `GET`, `DELETE`
- **Caller:** `loadServerConnections()` (`17_client-my-lists-and-trakt-oauth.js:1903, 1921`)
- **Response:** `{ ok: true, connections: { trakt: boolean, tmdb: boolean, mdblist: boolean, simkl: boolean } }`
- **Loading State:** Connected badge state in Settings.
- **Success State:** Updates connection badges; on disconnect, clears local token and server record.
- **Error State:** Keeps local disconnected flag in `localStorage['myListAddon:<prov>Disconnected']`.
- **Retry:** None.
- **Optimistic Update:** Optimistically marks disconnected in UI.
- **Rollback:** None.
- **Cache:** `localStorage`.

---

### `POST /api/connections/import-local`
- **Method:** `POST`
- **Caller:** `importLocalConnectionsOnce()` (`17_client-my-lists-and-trakt-oauth.js:1952`)
- **Request Body:** `{ traktAccessToken?, tmdbSessionId?, mdblistKey?, simklAccessToken? }`
- **Response:** `{ ok: true, imported: string[] }`
- **Loading State:** Silent post-login synchronization.
- **Success State:** Server stores encrypted tokens in D1 `provider_secrets`.
- **Error State:** Silent failure; re-attempted on next login.
- **Retry:** Once per account login.
- **Optimistic Update:** Local tokens already active.
- **Rollback:** None.
- **Cache:** None.

---

## 7. Telemetry & Background Tracking

### `POST /api/track-search`, `POST /api/track-event`, `POST /api/track-install`
- **Method:** `POST`
- **Caller:** `trackSearch()` (`19_client-search-and-likes.js:787`), `trackEvent()` (`16_client-row-core.js:2931`), `trackInstall()` (`24_client-backup-restore-presets.js:2276`)
- **Request Body:** `{ query: string }`, `{ event: string, ... }`, `{ installToken: string }`
- **Headers:** `{ 'Content-Type': 'application/json' }`, `keepalive: true`
- **Response:** `{ ok: true }`
- **Loading State:** Fire-and-forget; non-blocking.
- **Success State:** Telemetry recorded in Cloudflare Analytics Engine.
- **Error State:** Silently swallowed (`.catch(() => {})`).
- **Retry:** None.
- **Optimistic Update:** None.
- **Rollback:** N/A.
- **Cache:** None.

---

## 8. Summary of API Defect Findings

1. **`appShellSignOut()` early return on failure (`AUDIT-FE-001`)**:
   `DELETE /api/session` failure (e.g. offline) aborts before executing `clearLocalAccountData()`, preserving all sensitive credentials and user lists in the browser.
2. **`saveChannel()` unlatched double-submit (`AUDIT-FE-002`)**:
   `POST /api/channel/share` is awaited without disabling `#channelSaveBtn` or locking `beginSubmit()`, allowing concurrent double-clicks to mint duplicate channels in D1, R2, and `localChannels`.
3. **`executeUnifiedListSearch` unsequenced fallback search (`AUDIT-FE-003`)**:
   Fallback `GET /api/tmdb-search-lists?q=...` lacks sequence freshness verification, permitting delayed fallback responses to clobber newer search results.
