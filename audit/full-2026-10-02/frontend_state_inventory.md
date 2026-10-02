# Frontend State Inventory & Synchronization Architecture

This document identifies every state source in the My Lists Addon client application, determines the authoritative source of truth for each domain, analyzes multi-source conflicts, and details user-switching state lifecycle guarantees.

---

## 1. Taxonomy of State Sources

The frontend runtime manages application state across nine distinct layers:

```
┌────────────────────────────────────────────────────────┐
│                      Client Layers                     │
├────────────────────────────────────────────────────────┤
│ 1. Globals & Script Scope (in-memory variables)        │
│ 2. DOM Tree (catalog rows, form inputs, preview slots) │
│ 3. URL State (pathname routing, query params, hashes)  │
│ 4. LocalStorage (persistent offline settings & cache)  │
│ 5. SessionStorage (fast memory backup mirror)          │
│ 6. Cookies (HttpOnly session token, feature cookies)   │
│ 7. Cache Storage & Service Worker (immutable bundles)  │
│ 8. In-Memory LRU & Map Caches (titles, search, stamps) │
├────────────────────────────────────────────────────────┤
│                      Server Layers                     │
├────────────────────────────────────────────────────────┤
│ 9. Authoritative Cloud Stores (D1 Database, KV, R2)    │
└────────────────────────────────────────────────────────┘
```

---

## 2. Exhaustive Inventory of State by Layer

### Layer 1: Globals & Script Scope Variables
The client bundle is executed in a shared top-level script scope. Key global state bindings include:

| Identifier | Type | Scope | Lifecycle | Purpose |
|---|---|---|---|---|
| `activeCreator` | `object \| null` | Top-level `var` | Sign-in to Sign-out | `{ creatorName, displayName }`; controls auth state and creator features. |
| `_providerSecretsInMemory` | `object` | `let` (private) | In-memory session | In-memory storage for TMDB, Trakt, MDBList, and Simkl API keys/tokens. Cleared on sign-out. |
| `_creatorKeysAppliedFor` | `string \| null` | `let` | Login session | Tracks which username currently has in-memory provider secrets loaded. |
| `traktAccessToken`, `mdblistAccessToken`, `simklAccessToken` | `string` | Top-level `let` | Session lifetime | OAuth bearer tokens for external provider APIs. |
| `channelDraftItems` | `array` | Top-level `let` | Tab lifetime / editing | Array of episodes/movies currently staged in Channel Builder. |
| `customListDraftItems` | `array` | Top-level `let` | Tab lifetime / editing | Array of picks currently staged in Custom List Builder. |
| `editingChannelId`, `editingChannelUrlInput` | `string \| Node \| null` | `let` | Channel edit session | Identifies channel currently open for modification. |
| `editingCreatorListSlug`, `editingLocalCustomListSlug` | `string \| null` | `let` | List edit session | Identifies custom list currently open for editing. |
| `_memoryCustomListsObj`, `_memoryCustomListsString` | `object \| string \| null` | `let` | In-memory cache | Fast in-memory cache of local custom lists map. |
| `_memoryChannelsMap`, `_memoryChannelsString` | `object \| string \| null` | `let` | In-memory cache | Fast in-memory cache of local channels map. |
| `_submitsInFlight` | `Set<string>` | `let` | Async call lifetime | In-flight submission keys used by `beginSubmit()`. |
| `_creatorSyncLoadedFor` | `string \| null` | `let` | Login session | Username for which the initial cloud sync load has completed. |
| `_pendingSyncPushes` | `object \| null` | `let` | Pre-load buffer | Outbound pushes buffered while the initial sync load is in flight. |
| `_syncMetaStamps` | `object` | `window` | Session lifetime | `{ config, tracking, presets, channels }` timestamps level with server. |
| `window._watchedItemIds` | `Set<string>` | `window` | Profile session | Set of watched IMDb/TMDB IDs; drives green watch badges on posters. |
| `window._rawWatchHistoryItems` | `array` | `window` | Profile session | Chronological array of watch history scrobble events. |
| `window._dismissedContinueWatching` | `object` | `window` | Profile session | Map of show IDs dismissed from Continue Watching. |
| `window._removedAiringNext` | `object` | `window` | Profile session | Map of show IDs hidden from Airing Next shelf. |
| `currentTitleSearchSequence` | `number` | `let` | Incremented per query | Sequence counter to drop out-of-order title search responses. |
| `currentListSearchSequence` | `number` | `let` | Incremented per query | Sequence counter to drop out-of-order list search responses. |
| `appShellState` | `object` | `let` (New UI) | App shell session | Reactive state store `{ account, tab, submenu, unreadFeedback }`. |

---

### Layer 2: DOM Tree as State Store
The vanilla JS architecture utilizes the DOM directly as an authoritative scratchpad:
- **`#lists` Container:** Every `.entry` represents a catalog shelf. Inputs inside the entry (`.name`, `.url`, `.type`, `.category`) constitute the working list configuration. Drag-and-drop reorders DOM nodes directly; `collectEntries()` scrapes the DOM tree to construct sync and install payloads.
- **Form Controls:** Checkboxes and inputs (`#tmdbKeyInput`, `#customListNameInput`, `#channelNameInput`, `#customListPlayOrderSelect`) represent uncommitted user input.
- **Posters & Badges:** Rating badges (`.rating-badge-imdb`, `.rating-badge-tmdb`) and watch indicators (`.watched-badge`) are stamped directly into poster container classes.

---

### Layer 3: URL & Routing State
- **Pathname Routes:** In the new UI shell (`data-app-shell="1"`), navigation updates real paths via `history.pushState`: `/discover`, `/catalogs`, `/lists`, `/channels`, `/search`, `/settings`.
- **Deep Links:** `/lists/:user/:slug` and `/channels/:user/:slug` serve standalone list views.
- **Hash Routes:** Legacy hash routing: `#/list?url=...` and `#/item?id=...`.
- **Query Parameters:** `?config=...` imports an install configuration into the builder.

---

### Layer 4: LocalStorage
Persistent key-value storage surviving browser restarts:

| Key | Format | Authoritative For | Notes |
|---|---|---|---|
| `myListAddon:creatorName` | String | Active username | Read on startup by `tryAutoRestoreCreatorProfile()`. |
| `myListAddon:creatorKey` | String | Account master key | Read on startup; wiped by `clearLocalAccountData()`. |
| `myListAddon:creatorDisplayName` | String | User friendly name | Cached display name. |
| `myListAddon:state` | JSON string | Offline builder entries | Serialized entries and keys; fallback on offline load. |
| `myListAddon:syncBaselines` | JSON string | Conflict timestamps | Baselines (`updatedAt`, `trackingUpdatedAt`) for server sync. |
| `myListAddon:likedLists` | JSON array | Liked list IDs/URLs | Locally liked lists across Trakt, TMDB, and community. |
| `myListAddon:hiddenLists` | JSON array | Filtered shelves | Lists hidden from dashboard / discover. |
| `myListAddon:activeTab` | String | Last active tab | Restores last viewed tab on return. |
| `localCustomLists` | JSON object | Custom lists map | Offline/local custom lists (keyed by slug). |
| `localChannels` | JSON object | Channels map | Offline/local channels (keyed by channelId). |
| `presets` | JSON object | Builder presets | Saved shelf configurations. |
| `theme` | `'dark' \| 'light'` | Color scheme | Dark/light mode theme preference. |

---

### Layer 5: SessionStorage
Used strictly as a fast tab-scoped mirror and temporary scratchpad:
- Mirrors `localCustomLists`, `localChannels`, `localMergedChannels`, and `presets`.
- Read by `loadLocalCustomLists()` before falling back to `localStorage`.
- Swept during `clearLocalAccountData()` to prevent resurrection of logged-out account data.

---

### Layer 6: Cookies & HTTP Context
- **`mla_session`:** HttpOnly, SameSite=Lax, Secure session cookie containing a 256-bit token. Authoritative for session authentication across `/api/session`, `/api/me`, and `/api/installs`.
- **`FF_NEW_UI`:** Feature flag cookie (`1` or `0`) deciding whether the server renders the legacy builder or new UI shell.

---

### Layer 7: Cache Storage & Service Worker
The service worker (`SERVICE_WORKER_JS`) operates with strict boundaries:
- **`mylists-assets-v2`:** Caches immutable, content-addressed assets only (`/app.js?v=...`, `/app-features.js?v=...`, `/app.css?v=...`, `/vendor/*`).
- **`mylists-shell-v2`:** Caches bare HTML navigation shell for offline fallback (`/`).
- **Explicit Invariant:** Service Worker **NEVER** caches API routes (`/api/*`), list endpoints (`/lists/*`), or dynamic user data. Dynamic data is always fetched directly over the network to prevent stale state.

---

### Layer 8: In-Memory Map Caches
- **`_unifiedSearchCache`:** In-memory `Map` caching search query results with a 1-hour TTL.
- **`_catalogSearchViewCache`:** In-memory cache preserving rendered search tab markup per filter chip.
- **`_episodeDataCache` / `_seasonEpisodesMap`:** In-memory caches for TMDB/Cinemeta episode lists.

---

### Layer 9: Server State (Cloud Stores)
- **Cloudflare D1 (`my-lists-db`):** Authoritative persistent storage for Creator profiles, password/key hashes, recovery hashes, active sessions, published custom lists, list items, continuous channels, and likes ledgers.
- **Cloudflare KV (`CONFIGS`):** Caches user cloud sync blobs (`creatorsync:<username>`), tracking blobs (`tracking:<username>`), and generated Stremio install tokens (`install:<token>`).
- **Cloudflare R2 (`my-lists-blobs`):** Storage for channel episode pool manifests.

---

## 3. Authoritative Source of Truth Matrix

| Domain | Primary Authoritative Source | Secondary / Local Cache | Conflict Resolution Policy |
|---|---|---|---|
| **Account Identity** | Server D1 `creators` + `sessions` | `localStorage['myListAddon:creatorName']` | Server is authoritative. If server session is invalid, re-authenticated via `tryAutoRestoreCreatorProfile()`. |
| **Catalog Shelf Lineup** | Local DOM `#lists` while editing | Server KV `creatorsync:<user>` config blob | **Optimistic Concurrency:** Server checks `expectedUpdatedAt`. On 409 Conflict, client pulls server state and reconciles uncommitted local entries (`newLocalEntries`). |
| **Custom Lists** | Server D1 `creator_lists` table | In-memory `lastCreatorListsData` & `localCustomLists` | Whole-list edits require matching `expectedUpdatedAt`. On 409 Conflict, client refuses overwrite to protect concurrent edits. |
| **Continuous Channels** | Server D1 `published_channels` & R2 | `localStorage['localChannels']` | Channels save locally first; public channels sync to R2/D1 via `POST /api/channel/share`. |
| **Watch History & Progress** | Server KV `tracking:<user>` | `window._watchedItemIds` & `_rawWatchHistoryItems` | Timestamp-based merge. Tracking pushes require `expectedUpdatedAt`; local deletions older than remote timestamp are dropped. |
| **Likes Ledger** | Server D1 `list_likes` table | `localStorage['myListAddon:likedLists']` | Atomic D1 updates (`changes()`). Client updates local storage only after server responds `200 OK`. |
| **Static Code Bundles** | Cloudflare Edge / Server bundle | Browser Cache API `mylists-assets-v2` | Content-hashed query params (`?v=<hash>`); cache hit returned immediately; new hash fetches fresh bundle. |

---

## 4. Multi-Source Conflicts & Synchronization Rules

### Rule 1: Gated Creator Sync on Sign-in (`_creatorSyncLoadedFor`)
When a user signs in, `activeCreator` is populated immediately, but `loadCreatorSync()` takes a network round trip. Background routines (such as `refreshAiringNext` at 600ms and `scheduleTrackingSync` at 300ms) fire on startup.
- **Invariant:** The client initializes `_creatorSyncLoadedFor = null`. All outbound pushes (`pushCreatorSync`, `pushTrackingSync`, `pushChannelsSync`) check `isCreatorSyncLoaded()`.
- **Behavior:** Outgoing pushes are intercepted and stored in `_pendingSyncPushes`. They are flushed only **AFTER** `loadCreatorSync()` resolves and establishes remote baseline timestamps.
- **Safety Failsafe:** If the load request fails or times out (e.g. offline), `armCreatorSyncGateFailsafe()` opens the gate after 8 seconds to prevent permanently stalling local edits.

### Rule 2: Local Custom Lists Tri-Layer Read Precedence
When loading custom lists (`loadLocalCustomLists()`):
1. **Memory First:** Checks `_memoryCustomListsObj`. If populated, returns immediately.
2. **SessionStorage Second:** If memory is empty, reads `sessionStorage['localCustomLists']`.
3. **LocalStorage Third:** If session storage is empty, reads `localStorage['localCustomLists']`.
- **Cleanup Requirement:** To avoid ghost list resurrection during sign-out or account reset, `clearLocalAccountData()` sweeps all three layers simultaneously.

### Rule 3: Background Resume Meta Polling (`/api/creator/sync/meta`)
When the user switches back to the application tab or returns to the foreground:
- `handleForegroundResumeSync()` queries lightweight endpoint `GET /api/creator/sync/meta`.
- It compares the 4 blob timestamps (`config`, `tracking`, `presets`, `channels`) against `_syncMetaStamps`.
- If no timestamp has advanced on the server, the heavy full reload is skipped, avoiding unnecessary network transfer and UI re-renders.

---

## 5. User Switching & State Isolation Lifecycle

When an account is signed out or switched via `switchCreatorProfile()` or `clearLocalAccountData()`:

```
                  ┌───────────────────────────────┐
                  │ User Clicks "Sign Out/Switch" │
                  └──────────────┬────────────────┘
                                 │
                                 ▼
                  ┌───────────────────────────────┐
                  │   DELETE /api/session (D1)    │
                  └──────────────┬────────────────┘
                                 │
                                 ▼
                  ┌───────────────────────────────┐
                  │    clearLocalAccountData()    │
                  └──────────────┬────────────────┘
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                        ▼
┌────────────────┐      ┌─────────────────┐      ┌────────────────┐
│ Memory Cleared │      │ Storage Cleared │      │  DOM Restored  │
├────────────────┤      ├─────────────────┤      ├────────────────┤
│ activeCreator  │      │ localStorage    │      │ #lists wiped   │
│ OAuth tokens   │      │ (all myList:*)  │      │ Inputs cleared │
│ Secrets map    │      │ sessionStorage  │      │ Checkboxes off │
│ Tracking sets  │      │ (all mirrors)   │      │ Badges hidden  │
│ Draft items    │      │ Tabs preserved  │      │ Modals reset   │
└────────────────┘      └─────────────────┘      └────────────────┘
```

### State Isolation Checklist Verified:
1. **In-Memory Secrets:** `_providerSecretsInMemory = {}` and `_creatorKeysAppliedFor = null` prevent subsequent sign-ins on the same tab from inheriting prior API keys.
2. **Watch Badges & Sets:** `_watchedItemIds = new Set()` and `_rawWatchHistoryItems = []` are cleared so previous watch ticks do not appear on posters.
3. **Draft Buffers:** `channelDraftItems = []` and `customListDraftItems = []` are cleared so unfinished picks do not leak into another user's list.
4. **Offline Custom Lists & Channels:** `localCustomLists` and `localChannels` are removed from both `localStorage` and `sessionStorage`.
5. **Preserved UI Preferences:** Only harmless navigation state (`myListAddon:activeTab`, `myListAddon:settingsSubmenu`, `theme`) is retained across logouts.

### Defect Identified:
- **`AUDIT-FE-001` (P2):** While `switchCreatorProfile()` correctly invokes `clearLocalAccountData()` inside a non-blocking `try/catch`, `appShellSignOut()` in `24_client-backup-restore-presets.js:3583` halts on `if (!res.ok) return false;` if the server is offline or fails, leaving the previous user's credentials and data fully accessible in the browser.
