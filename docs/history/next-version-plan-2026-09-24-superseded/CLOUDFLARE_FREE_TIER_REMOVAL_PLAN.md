# Cloudflare Free Tier & Self-Hosting Removal Plan

**Date:** 2026-09-24 · **Scope:** every piece of code, configuration and documentation that exists primarily because of the Cloudflare Workers Free plan, because D1/KV were optional for self-hosters, or because the Worker was deployed by pasting one file into the Cloudflare dashboard.

**Classification key**

* **A · REMOVE** — delete outright once its replacement (if any) is live.
* **B · REWRITE** — the feature stays; the implementation is redesigned.
* **C · KEEP** — Cloudflare-specific and still correct for a paid, hosted deployment (possibly moved or renamed).
* **D · INVESTIGATE** — the reason it exists is unclear or not purely free-tier; trace before touching.

**Difficulty / risk scale:** Low · Medium · High.

**How to read the entries.** Line numbers refer to the numbered source files at this commit. "Replacement" names the target component from `NEXT_VERSION_ARCHITECTURE.md`. "Phase" refers to `MIGRATION_PLAN.md`.

**Important framing.** Most of what follows is not "Cloudflare code". It is code shaped by three constraints that no longer apply: (1) 50 outbound fetches and 10 ms CPU per invocation on Free, (2) roughly 1,000 KV writes per day on Free, and (3) the promise that KV alone (no D1) and a dashboard paste (no wrangler, no CI) had to keep working for self-hosters. Removing the constraint does not by itself remove the code: several items need a replacement design first, which is why most are REWRITE rather than REMOVE. Where a change is safe to make in the current codebase before any re-architecture, it is marked **(Phase 1)**.

---

## Summary

| ID | Item | Class | Difficulty | Risk | Phase |
|---|---|---|---|---|---|
| FT-01 | `BULK_RESOLVE_SUBREQUEST_BUDGET` + `nextIndex` continuation + client resume loop | B | Medium | Low | 1 (budget) / 5 (job) |
| FT-02 | `DETAILS_BATCH_SUBREQUEST_BUDGET`, `TMDB_ITEM_DETAILS_MAX_FETCHES`, fetch "meter", client resume rounds | B | Medium | Low | 1 / 5 |
| FT-03 | `CRON_SUBREQUEST_BUDGET` and the share arithmetic inside `scheduled()` | B | Medium | Medium | 1 / 5 |
| FT-04 | Per-account cron sweeps with KV cursors (Continue Watching, Airing Next) | B | High | Medium | 5 |
| FT-05 | Rotating chart pre-warm cursor, sleeps and all-or-nothing MDBList block | B | Medium | Low | 5 |
| FT-06 | BetterPosters pre-warm cursor, single-key retry list, variants key, binary images in KV | B | Medium | Low | 5 |
| FT-07 | One-network-per-tick channel preset pre-warm | B | Low | Low | 5 |
| FT-08 | "D1 is optional" branching (328 `env.DB` checks) and every KV fallback read | A (after B) | High | High | 3 |
| FT-09 | Write-back-on-read into KV (`getCreator`, `getCreatorList`) | A | Low | Low | **1** |
| FT-10 | `trackingd1behind:` marker, stamp comparisons, `saveAiringNextD1` previousStamp gate | A | Medium | Medium | 3 |
| FT-11 | `creatorscrobblequeue:` (KV propagation workaround) | A | Low | Medium | 3 |
| FT-12 | Creator/list tombstones, reset marker, second purge sweep, pre-create purge (KV propagation) | B | Medium | Medium | 3 |
| FT-13 | `creatorlistorder:` single key + orphan sweep + `creatorliststamp:` | B | Medium | Medium | 3 |
| FT-14 | Dashboard paging/delta protocol (`CREATOR_LISTS_PAGE_*`, `/lists/items`, `knownVersion`) | B | Medium | Low | 3 |
| FT-15 | KV-scan caps in admin and directory (`ADMIN_*_MAX`, `STAT_*_CAP`, `PUBLIC_INDEX_MAX*`, `CREATOR_RENDER_CAP`) | A | Low | Low | 3 |
| FT-16 | KV counter/telemetry branches, day indexes, JSON counter blobs, `stats` as event store | B | Medium | Low | 3 |
| FT-17 | Per-request PBKDF2 + isolate memo + verification throttle | B | High | Medium | 7 |
| FT-18 | `presetsB64` client-side gzip via `fflate` from a CDN | A | Low | Low | 3 / 6 |
| FT-19 | `readUpdatedAtFromRaw` string scanning in `/sync/meta` | A | Low | Low | 3 |
| FT-20 | `LIKE_VOTER_CAP` and JSON voter ledgers | A | Medium | Low | 3 |
| FT-21 | `index:publicchannels` single-key directory (`PUBLIC_CHANNEL_INDEX_MAX`) | B | Medium | Low | 3 |
| FT-22 | Byte ceilings derived from D1's 2 MB row limit (`CREATOR_LIST_BYTES_MAX`, `SHARED_CHANNEL_BYTES_MAX`) | B | Medium | Low | 3 |
| FT-23 | Channels/custom lists embedded as JSON in row URLs; `presetNetworkId` pointer + sample | B | High | High | 3 |
| FT-24 | Base64 install configs and "no-kv" fallbacks | B (decode) / A (generate) | Low | Medium | 1 / 3 |
| FT-25 | `/api/resolve` cross-deployment fetch (`isRemoteResolveOrigin`) | A | Low | Low | **1** |
| FT-26 | D1 schema manifest, cron schema check, `/admin/api/schema-status`, runtime column probes | A | Low | Low | 2 |
| FT-27 | Hand-applied migrations, DROP-TABLE `schema.sql`, console instructions | B | Low | Medium | 2 |
| FT-28 | KV→D1 migration tools (`/admin/api/migrate-d1`, `migrate-day-counts`, `rebuild-search-index`, lazy backfills) | A | Low | Medium | 10 |
| FT-29 | Legacy data-shape migrations run on hot paths (`ensureTrackingMigrated`, preset/genre migrations) | A | Low | Medium | 10 |
| FT-30 | KV-based rate limiters (`consumeRateLimit` and inline copies) | B | Medium | Low | 7 |
| FT-31 | `touchCreatorLastSeen` 30-minute memo throttle | B | Low | Low | 3 |
| FT-32 | `MOST_WATCHED_MAX_LOOKUPS`, `IMDB_ID_LOOKUP_MAX` (sized to 50 fetches) | B | Low | Low | 1 / 4 |
| FT-33 | `enrichTrailers` no-op kept to save subrequests | A | Low | Low | **1** |
| FT-34 | Runtime bundle extraction and page memos (`APP_BUNDLE`, `SPLIT_PAGE_MEMO`, `BUILDER_PAGE_MEMO`) | A | Medium | Medium | 6 |
| FT-35 | Base64 icon in source (`01_icon-asset.js`) | A | Low | Low | 2 |
| FT-36 | Single-file concatenation build and its validators | B | Medium | Medium | 2 |
| FT-37 | "Paste into the dashboard" deployment assumptions | A | Low | Low | 2 |
| FT-38 | Self-hosting and free-plan documentation, SEO copy, UI copy | A | Low | Low | **1** |
| FT-39 | `LEGACY_UNVERIFIED_CONFIG_SHELVES` | D | Medium | High | 7 |
| FT-40 | `CF-Connecting-IP` client identity (`clientIpKey`) | C | — | — | — |
| FT-41 | Edge cache use (`caches.default`, `cf.cacheTtl`) and the circuit-breaker SWR idea | C (concept) / B (impl) | Medium | Low | 4 |
| FT-42 | `stremioAddonsConfig.signature` and hosted-domain constants | C | Low | Low | 2 |
| FT-43 | `withSecurityHeaders` global wrapper, `isPrivateApiPath` | C | Low | Low | 2 |
| FT-44 | RapidAPI monthly quota tracking in KV; JustWatch GraphQL engine | D | Medium | Medium | 5 |
| FT-45 | `lastgood:` per-config catalog fallback copies | D → B | Low | Low | 1 / 5 |
| FT-46 | `OUTBOUND_TIMEOUT_MS` / `withTimeout` and "cost bound" constants (`PERSON_SHOW_MAX_*`, `CHANNEL_LIVE_POOL_*`) | C | — | — | 4 |

Removing this list, together with the storage move, deletes an estimated **12,000–15,000 lines** of server code and comments and roughly **40 KV namespaces**, and it removes the reason for five CI validators.

---

## Group 1 — Subrequest budgets and continuation protocols

### FT-01 · Bulk-resolve budget and resume loop — **B · REWRITE**
* **Files / functions:** `00_constants.js:155–175` (`BULK_RESOLVE_ITEMS_MAX`, `BULK_RESOLVE_SUBREQUEST_BUDGET = 48`, `BULK_RESOLVE_ITEMS_PER_MINUTE`); `/api/bulk-resolve` (26:7129–7260, budget at 7176–7182, `nextIndex`/`done` at 7252–7253); client `resolveViaBulkResolve` (18:961–1000); `wrangler.toml` `[vars] BULK_RESOLVE_SUBREQUEST_BUDGET = "400"`.
* **What it does:** processes at most `budget/2` titles per invocation (two TMDB calls each), returns how far it got, and the browser re-posts the remainder.
* **Why it exists / limitation:** 50 outbound fetches per invocation on Free.
* **Current problem:** a paid deployment still ships the free-safe default in code (48) and depends on a wrangler var the dashboard-paste deploy never reads; the import is a browser-driven loop that dies if the tab is closed; every title costs two uncached-by-default TMDB calls with no shared title cache; the shared TMDB key is spent by anonymous callers.
* **Replacement:** an **import job** (`imports` queue): the client uploads the CSV/ZIP (or the server fetches a supported URL), the job resolves titles **cache-first through the `media` table** (one search per unseen title, reused by everyone), writes a list, and reports progress in `jobs`. `/api/bulk-resolve` disappears.
* **Phase 1 interim:** set the in-code default to the paid value and delete the wrangler comment block.
* **Dependencies:** `18_client-copy-and-trakt-export.js` import UI, `21_` mark-as-watched importers, tests in `worker.test.mjs` for continuation.
* **Difficulty:** Medium. **Risk:** Low (import is additive; old continuation contract can remain until the job ships).

### FT-02 · Details-batch budget and meter — **B · REWRITE**
* **Files / functions:** `00_constants.js:198–213` (`TMDB_ITEM_DETAILS_MAX_FETCHES`, `DETAILS_BATCH_SUBREQUEST_BUDGET`, `DETAILS_BATCH_IDS_PER_MINUTE*`, `DETAILS_BATCH_MAX_ROUNDS`); `/api/details/batch` (25:7328–7440, budget at 7380–7384); the `meter`/`spend()` plumbing in `fetchTmdbItemDetails`/`fetchTmdbItemDetailsUncached` (07:3763–4170); client resume loops (21:3466, 21:3697).
* **What it does:** reserves up to eight fetches per cold id, refunds unused ones, stops when the budget is spent and lets the browser retry.
* **Why / limitation:** Airing Next refresh measured at 180 fetches for 60 ids vs 50 allowed.
* **Current problem:** complexity in the hottest TMDB path; the browser computes Airing Next at all only because the server could not.
* **Replacement:** Airing Next is derived server-side from `episodes` (see architecture §3.4). `/api/details/batch` becomes a plain read of `media`/`episodes` with no provider calls on the request path; cold ids are enqueued to `show-schedule`.
* **Phase 1 interim:** raise the default to the paid value; drop the client round cap.
* **Dependencies:** `21_client-custom-list-builder.js` (`refreshAiringNext`), `rebuildAiringNextForRecord` (07:4611), `tests/airing-and-recs-live.test.mjs`, `tests/watchlist-airing.test.mjs`.
* **Difficulty:** Medium. **Risk:** Low.

### FT-03 · Cron budget arithmetic — **B · REWRITE**
* **Files / functions:** `00_constants.js:215–281` (`CRON_SUBREQUEST_BUDGET`, `CRON_EPISODE_CHECK_FETCHES/_MAX/_SHARE`, `CRON_CHART_WARM_FETCHES`), `:444` (`CRON_NEW_ON_STREAMING_SHARE`), `:1228` (`CRON_AIRING_NEXT_SHARE`), `:1265` (`CRON_BETTER_POSTER_SHARE`); `scheduled()` (26:7308–7430); `wrangler.toml` cron comments.
* **What it does:** splits one 6-minute tick's outbound-fetch budget between eight tasks, chains them so the "user-visible" one lands first, and gives three tasks a share of the episode sweep's "unreachable reserve".
* **Why / limitation:** 50 fetches per invocation on Free, and one cron trigger.
* **Current problem:** eight unrelated jobs share one failure domain and one clock; the budget math is the only thing keeping cheap and expensive work apart; default 10,000 depends on an env var and on reading 60 lines of comments to set correctly.
* **Replacement:** several cron triggers that **only enqueue** (`schedules.ts`), one queue per job family, per-consumer concurrency and retry policy. No shares, no chaining.
* **Dependencies:** everything in FT-04–FT-07, FT-44.
* **Difficulty:** Medium. **Risk:** Medium (scheduling behaviour changes; covered by job-level tests).

### FT-04 · Per-account sweeps with KV cursors — **B · REWRITE**
* **Files / functions:** `checkForNewEpisodes` (07:4765–5052, cursor `cron:continuewatching:cursor`, `ACCOUNT_BATCH_SIZE = 25`); `refreshAiringNextSweep` (07:4680–4763, cursor `cron:airingnext:cursor`, `AIRING_NEXT_SWEEP_ACCOUNTS_PER_TICK = 3` at 00:1247, `airingnextchecked:{u}` TTL keys); `rebuildAiringNextForRecord` (07:4611).
* **What it does:** walks `creator:` KV keys a page at a time, reads each account's whole tracking record, calls TMDB for that account's shows, writes the record back to KV and D1.
* **Why / limitation:** fetch budget per invocation; KV `list()` is the only way to enumerate accounts when D1 is optional.
* **Current problem:** throughput is bounded by accounts per tick, not by work: at 100,000 accounts the Continue Watching cycle is ~4,000 ticks (≈16 days) and Airing Next ≈139 days. The same show is looked up once per user who watches it. Each visit rewrites the whole tracking record (see `PERFORMANCE_AUDIT.md` P-1).
* **Replacement:** per-**show** schedule refresh (`series_schedule`, `episodes`) and derived progress (`show_progress`). A new episode becomes visible to every watcher of that show through one TMDB call and zero per-user writes.
* **Dependencies:** tracking data model (Phase 3), client Airing Next/Continue Watching views, `tests/tracked-shelves-stay-live.test.mjs`.
* **Difficulty:** High. **Risk:** Medium (behavioural parity of Continue Watching must be tested carefully: dismissals, companions, fully-watched).

### FT-05 · Chart pre-warm rotation — **B · REWRITE**
* **Files / functions:** `prewarmSharedCatalogs` (07:5218–5417): `maxWarms`, `cron:prewarm:cursor`, per-chart `pauseMs` sleeps, MDBList "all-or-nothing" hourly block with `cron:last_warmed:mdblist`, the `console.warn` telling operators to set `CRON_SUBREQUEST_BUDGET`.
* **What it does:** refreshes ~40 shared charts into the circuit-breaker caches a slice at a time.
* **Why / limitation:** one chart ≈ 105 fetches, more than a free invocation.
* **Current problem:** sequential with sleeps inside one invocation; the MDBList block can starve behind the rotation; results live in three cache tiers with different keys.
* **Replacement:** `provider-refresh` jobs per chart with a TTL per chart class; KV snapshot + SWR on read.
* **Difficulty:** Medium. **Risk:** Low.

### FT-06 · BetterPosters pre-fetch machinery — **B · REWRITE**
* **Files / functions:** `prewarmBetterPosters`, `retryMissedBetterPosters`, `rememberSharedPosterIds` (07:5087–5216); `bp:retry:v1`, `bp:variants:v1`, `bp:sharedids:v1` single-key JSON lists; `bpimg:v1:*` binary values in KV (05:1033, 1070); `BETTER_POSTER_PREWARM_*` and `CRON_BETTER_POSTER_SHARE` (00:1261–1265).
* **What it does:** mirrors btttr.cc posters (which can take 40–50 s to draw) so tiles are instant.
* **Why / limitation:** fetch budget per tick; no object storage bound.
* **Current problem:** read-modify-write of single KV keys from many isolates (lost updates); images stored in KV; per-isolate flush throttles.
* **Replacement:** `posters` queue → R2 (`posters/bp/{variant}/{imdb}.jpg`), variant usage and misses tracked in Postgres, retry with exponential backoff via queue delays.
* **Difficulty:** Medium. **Risk:** Low.

### FT-07 · Channel preset pre-warm — **B · REWRITE**
* **Files / functions:** `prewarmChannelPresets` (07:2825), `cron:channelpresets:cursor`, `CHANNEL_PRESET_PREWARM_ORIGIN = "https://prewarm.internal"` (00:519), `buildNetworkChannelPreset` (07:2655), KV `channel:preset:v2:{networkId}`.
* **What it does:** rebuilds one Quick Add network's episode pool per tick.
* **Why / limitation:** fetch budget.
* **Replacement:** daily job per network writing `channels` + `channel_items` for system-owned preset channels; the placeholder origin disappears because artwork URLs are built at render time from config.
* **Difficulty:** Low. **Risk:** Low.

---

## Group 2 — "D1 is optional" and KV consistency workarounds

### FT-08 · Optional-D1 branching and KV fallback reads — **A · REMOVE (after the Postgres move)**
* **Files / functions (representative, not exhaustive):** `getCreator` (02:3495–3543: D1 first, KV fallback, lazy `backfillCreatorRowInD1`), `getCreatorList` (02:3813–3889: `kvIsFresher` repair), `readLikeVoters` (02:1836: **zero D1 rows ⇒ read KV**), `applyLikeVote` (02:1863: KV write, D1 seed-from-KV, verify-and-retry), `readCreatorListDeletions` (02:2123: zero rows ⇒ KV), `readCreatorUserListsD1` (02:4875: zero rows ⇒ `null` ⇒ caller uses KV), `readStatCount` / `readStatTotalsByPrefix` / `loadStatsByDay` (03:1394–1532: zero rows ⇒ KV), `readAuthFailureCount`/`noteAuthFailure` (02:1736–1776), `getPublicListIndex` KV scan branch (02:2711–2776), `/lists/public.json` legacy scan (25:571–635), `/api/search-published-lists` KV scan (26:4411–4499), `isCreatorTombstoned` KV copy (02:2981), `getOrCreateScrobbleToken` / `usernameForScrobbleToken` KV mirror + lazy backfill (02:1982–2085), `storeCreatorKeyLookup` KV mirror (02:667). In total **328 `env.DB` checks and 581 `env.CONFIGS` references**.
* **What it does:** lets every feature run on KV alone, and tolerates D1 rows that are missing because a migration or lazy backfill has not happened.
* **Why / limitation:** self-hosters without D1; the Free plan's KV-only history; D1 introduced as an "accelerator".
* **Current problem:** "no rows in D1" is treated as "not migrated yet", which is indistinguishable from "the user removed everything". Concrete consequences found in this audit: a last-voter unlike can be resurrected from an edge-cached KV ledger (`BACKEND_AUDIT.md` B-H5); unfollowing every list falls back to a stale KV blob; `STORAGE-PLAN-KV-D1.md` is marked "Completed" but the fallback model it set out to delete is still the design.
* **Replacement:** PostgreSQL as the only system of record; repositories that never consult a second store.
* **Dependencies:** effectively every route; this is Phase 3.
* **Difficulty:** High. **Risk:** High (data migration) — mitigated by the migration plan's verification gates.

### FT-09 · Write-back on read — **A · REMOVE (Phase 1)**
* **Files / functions:** `getCreator` (02:3517–3519: `CONFIGS.put("creator:…")` on **every** D1 hit, twice when an alias matched), `getCreatorList` (02:3868–3871: `CONFIGS.put("creatorlist:…")` on every read where KV was not fresher), `stampListVisibilityIfNeeded` on public GET paths (02:847; called from 05:1563, 05:2403, 25:589, 26:4423/4448/4653, 25:7159).
* **What it does:** refreshes the KV "read-through cache" from D1.
* **Why / limitation:** KV was the store public paths read; D1 had to be copied back into it.
* **Current problem:** measured with the repo harness: **a dashboard load of 20 lists issues 21 KV writes; every authenticated call issues at least one KV write** (even `/api/creator/track-status`), and the 60-second `/sync/meta` poll writes once per minute per open dashboard. KV writes are the most expensive KV operation and are limited to ~1/s per key.
* **Replacement (Phase 1):** delete the puts; KV copies are only written by the save paths that already write them. Phase 3 removes the KV copies entirely.
* **Dependencies:** none functionally (the save paths already write KV). Tests asserting the repair behaviour need adjusting.
* **Difficulty:** Low. **Risk:** Low.

### FT-10 · "D1 is behind" markers — **A · REMOVE**
* **Files / functions:** `trackingD1BehindKey`, `isTrackingD1Behind`, `recordTrackingD1Result` (02:4207–4244), the KV-vs-D1 stamp comparison and repair in `readCreatorTrackingD1` (02:4647–4675), `saveAiringNextD1`'s `previousStamp` gate (02:4265–4293), `d1Current` in `fetchAutoTrackedCatalog` (05:1996).
* **Why / limitation:** KV written first, D1 second, no transaction across them.
* **Replacement:** single store.
* **Difficulty:** Medium. **Risk:** Medium (removes a safety net that only makes sense with two stores).

### FT-11 · Scrobble queue key — **A · REMOVE**
* **Files / functions:** writes in `handleSubtitlesTrack` (26:437–469) and `handleMediaServerScrobble` (26:1082–1111); merges in `/sync/save-tracking` (26:3366–3429) and `/sync/load` (26:4068–4115).
* **What it does:** keeps the last 20 scrobbles in a tiny second key "because the large blob can take up to 60 seconds to propagate across edges".
* **Why / limitation:** KV eventual consistency.
* **Replacement:** `watch_events` insert; strongly consistent read.
* **Difficulty:** Low. **Risk:** Medium (only safe after the tracking model moves).

### FT-12 · Tombstones, reset marker, double purge — **B · REWRITE**
* **Files / functions:** `creatordeleted:{u}` + `creator_tombstones` (02:2959–3006, 3060–3079), second post-deletion sweep (02:3305–3351), pre-create purge in `/api/creator/create` (26:1292–1298), `creatorlistdeleted:{u}` + `list_tombstones` + `recordCreatorListDeletions`/`clearCreatorListDeletion` (02:2113–2242), `creatorreset:{u}` + `CREATOR_RESET_TTL_SEC = 90 days` (00:783, 02:3448–3469), client `applyServerListDeletions` / reset handling (22_).
* **What it does:** stops a deleted account from authenticating from a stale KV colo, stops in-flight writes resurrecting data, stops other browsers re-uploading deleted lists or an entire reset account.
* **Why / limitation:** KV propagation windows and browser-authoritative sync.
* **Current problem:** the machinery is subtle and still leaks: account deletion does not remove published channels (`SECURITY_AUDIT.md` S-4).
* **Replacement:** transactional deletes with `ON DELETE CASCADE`, session revocation, and a server-authoritative client that never "re-uploads what the server is missing". Keep a **username hold** (product rule: a deleted username cannot be re-registered for N days) as a plain table.
* **Difficulty:** Medium. **Risk:** Medium.

### FT-13 · List order key, orphan sweep, lists stamp — **B · REWRITE**
* **Files / functions:** `creatorlistorder:{u}` read-modify-write in `/lists/save` (26:2154–2160, 2360–2407), `/lists/reorder`, `deleteCreatorLists` (02:2343–2358); orphan sweep with `list()` on every dashboard page (26:1843–1868); `creatorliststamp:` + `creators.lists_stamp` + `bumpCreatorListsStamp` (02:2889–2933) and the test that fails the build if a sixth writer forgets to bump.
* **Why / limitation:** KV has no ordering or change feed; concurrent saves on one key lose entries (the "129 records for 22 lists" incident).
* **Replacement:** `lists.position` (or `list_order` rows) updated in a transaction; `lists.updated_at`/`accounts.lists_version` for change detection.
* **Difficulty:** Medium. **Risk:** Medium.

### FT-14 · Dashboard paging and delta protocol — **B · REWRITE**
* **Files / functions:** `CREATOR_LISTS_PAGE_DEFAULT/MAX`, `CREATOR_LISTS_MAX_PAGES`, `CREATOR_LIST_ITEMS_BATCH_MAX` (00:107–132); `/api/creator/lists` paging + SHA-256 `knownVersion` (26:1740–2032); `/api/creator/lists/items` (26:2047–2120); client loops (22:3916, 22:3991).
* **Why / limitation:** 1,000 storage operations per invocation (one KV get per list) and response size.
* **Replacement:** `GET /api/v2/lists?cursor=` (metadata from one query) and `GET /api/v2/lists/{id}/items?cursor=`; HTTP `ETag` on both.
* **Difficulty:** Medium. **Risk:** Low.

### FT-15 · Scan caps written for the per-invocation op limit — **A · REMOVE**
* **Files / functions:** `ADMIN_CREATOR_LIST_KV_SCAN_MAX` (00:756), `ADMIN_LIST_DELETE_MAX` (00:686), `PUBLIC_INDEX_MAX_ROWS` (00:768), `PUBLIC_INDEX_MAX` (00:870), `STAT_KEY_SCAN_CAP`/`STAT_TOTALS_READ_CAP` (03:1076–1077), `LAST_ACTIVE_BACKFILL_BATCH` (03:342), `CREATOR_RENDER_CAP` (03, `renderAdminDashboard`), the full `listAllKeys(env.CONFIGS, "creator:")` on every admin dashboard load (03:1740–1744).
* **Replacement:** SQL with `LIMIT`/keyset pagination.
* **Difficulty:** Low. **Risk:** Low.

### FT-16 · Counters and telemetry — **B · REWRITE**
* **Files / functions:** `bumpStat` KV branch (03:76–105), `bumpStatBy` (03:114), `bumpJsonCounterBlob` + `migrateGenreDecadeStatsIfNeeded` (03:161–278), `recordTrackedEvent` KV branch with `evtcount:`, `evtdayindex:`, `EVT_DAY_INDEX_CAP` (03:509–596), `recordSearchQuery` KV branch with `searchquerydayindex:`, `SEARCH_DAY_INDEX_CAP` (03:847–925), `stats:creator_count` (26:1323–1327), and the D1 `stats` table used as an event store (`evt:{type}:{id}`, `searchq:{q}`, `authfail:{scope}`, `apiuse:{provider}`).
* **Why / limitation:** 1,000 KV writes/day on Free ("four KV writes per tracked title… a ten-title batch spent 41 of them", 03:514–521); D1 optional.
* **Current problem:** `stats.kind` is unbounded; leaderboard queries use `kind LIKE 'evt:watched:%'`, which cannot use the `(kind, day)` primary key under SQLite's default case-insensitive `LIKE`, so they scan; security counters share a table with product telemetry.
* **Replacement:** Workers Analytics Engine datasets for telemetry and API usage; `daily_title_counts` rollup for Most Watched; rate limiting (FT-30) for auth failures.
* **Difficulty:** Medium. **Risk:** Low (admin dashboards only; keep historical totals by importing them once).

---

## Group 3 — CPU-limit workarounds

### FT-17 · Per-request key verification — **B · REWRITE**
* **Files / functions:** `authenticateCreator` (26:12–88) called by every account route; `verifyCreatorKeyMemoized` / `CREATOR_AUTH_MEMO` / `isCreatorAuthMemoized` / `invalidateCreatorAuthMemo` (02:561–621); `CREATOR_AUTH_VERIFY_PER_MINUTE` (00:707); `PBKDF2_ITERATIONS = 100000` (02:511).
* **What it does:** re-verifies the account key (≈15 ms of PBKDF2) on every request, caches successes per isolate, and throttles uncached verifications per IP.
* **Why / limitation:** no sessions; Free plan's 10 ms CPU (a single verification exceeded it); the memo was the CPU fix.
* **Current problem:** the master credential is sent on every request and must live in `localStorage`; revocation is only possible by rotating the key; a memo `clear()` on any rotation invalidates everyone in the isolate.
* **Replacement:** sessions (architecture §3.2). PBKDF2 (or Argon2id via WASM) runs only at login.
* **Difficulty:** High (touches every client call). **Risk:** Medium.

### FT-18 · Client-side gzip of presets — **A · REMOVE**
* **Files / functions:** `compressJsonToBase64` / `decompressBase64ToJson` (24:1244 and 22:2860), `presetsB64` handling in `/sync/save-presets` (26:3613) and `/sync/load` (26:3892–3944), `<script src="https://cdn.jsdelivr.net/npm/fflate@0.8.2/…">` (09:3629).
* **Why / limitation:** the save-presets comment names it: "could tip a request over Cloudflare's free-plan 10 ms CPU budget".
* **Current problem:** a third-party script on the critical path for one feature; opaque blobs the server cannot validate.
* **Replacement:** presets become rows (or JSONB on `addon_profiles`); HTTP compression handles transfer. Keep `fflate` only if client-side ZIP import still needs it, bundled locally.
* **Difficulty:** Low. **Risk:** Low.

### FT-19 · String-scanning `updatedAt` — **A · REMOVE**
* **File / function:** `readUpdatedAtFromRaw` inside `/api/creator/sync/meta` (26:3753–3760).
* **Why:** avoid JSON-parsing megabyte blobs under the CPU limit.
* **Replacement:** version columns.
* **Difficulty:** Low. **Risk:** Low.

---

## Group 4 — KV value-size and single-key designs

### FT-20 · Like voter ledgers — **A · REMOVE**
* **Files / functions:** `LIKE_VOTER_CAP = 5000` (02:1625), `readLikeVotersFromKv`, `applyLikeVote` (02:1820–1960), ledger key mapping `ledgerKeyToListId`/`listIdToLedgerKey` (02:1786–1818); `listlikevoters:`, `extlikevoters:`, `channellikevoters:`.
* **Why / limitation:** one KV value per list; no counters.
* **Current problem:** every like reads the full voter set (up to 5,000 ids) and writes it back; likes silently stop counting at 5,000; resurrection race (B-H5).
* **Replacement:** `list_likes`/`channel_likes`/`external_list_likes` rows with `INSERT … ON CONFLICT DO NOTHING` and a maintained `likes_count`.
* **Difficulty:** Medium. **Risk:** Low.

### FT-21 · Single-key channel directory — **B · REWRITE**
* **Files / functions:** `PUBLIC_CHANNEL_INDEX_KEY = "index:publicchannels"`, `readPublicChannelIndex`, `writePublicChannelIndex`, `upsertPublicChannelIndex`, `updatePublicChannelIndexEntry`, `removePublicChannelIndex`, `sortPublicChannelIndex` (02:4911–4995); `PUBLIC_CHANNEL_INDEX_MAX = 500` (00:51); like/add counters stored inside the index row.
* **Current problem:** concurrent publishes/likes lose updates; the directory silently drops the 501st channel; likes live in an index, not on the channel.
* **Replacement:** `channels` table with `visibility`, counters and indexes; directory is a query.
* **Difficulty:** Medium. **Risk:** Low.

### FT-22 · Byte ceilings from D1's row limit — **B · REWRITE**
* **Files / functions:** `CREATOR_LIST_BYTES_MAX = 1,800,000` (00:88) and its checks (26:2231–2237, 26:3552), `SHARED_CHANNEL_BYTES_MAX = 4,000,000` (00:47), `utf8ByteLength` guards (02:937).
* **Why / limitation:** D1 maximum row/string size (2 MB) and KV value weight.
* **Replacement:** items as rows; limits become explicit **product** limits on item count (e.g. 10,000 items per list), not byte counts users cannot reason about.
* **Difficulty:** Medium. **Risk:** Low.

### FT-23 · JSON payloads inside row URLs — **B · REWRITE**
* **Files / functions:** `channel:v1:<JSON>` and `customlist:v1:<JSON>` (`parseChannelPayload` 05:366, `parseCustomListPayload` 05:1531, client `collectEntries`), the `presetNetworkId` pointer + `CHANNEL_POINTER_SAMPLE_ITEMS` sample design (05:352–380), `/api/preview` POST variant created because GET URLs overflowed (25:1120–1126), `SAVED_CONFIG_BYTES_MAX = 10 MB` (00:61).
* **Why / limitation:** the original "stateless, no database" design (header.js) and URL-length limits; channels had nowhere else to live.
* **Current problem:** every catalog request carries and parses whole channels; a channel edit only reaches Stremio after a new install link; configs grow to megabytes and are stored forever.
* **Replacement:** rows reference `channel_id`/`list_id`; the legacy resolver still parses embedded payloads from old configs forever (read-only).
* **Difficulty:** High. **Risk:** High (touches install compatibility; see `MIGRATION_PLAN.md` §3.3).

---

## Group 5 — Self-hosting and deployment assumptions

### FT-24 · Base64 configs and "no-kv" fallbacks — **B · REWRITE (decode) / A · REMOVE (generate)**
* **Files / functions:** `decodeConfig` (02:361–435), `resolveConfig` fallthrough (04:155), client `buildConfig` (23:296) and the "fallback link encodes everything directly into the URL… If you're the Worker owner, binding a KV namespace named CONFIGS fixes this" message (24:2231–2240); every `if (!env || !env.CONFIGS) return … "no-kv"` branch (dozens, e.g. 25:6943, 26:1207, 26:1352).
* **Why / limitation:** deployments without KV.
* **Replacement:** keep decoding base64 install URLs forever (they are in people's apps); stop generating them; delete "no-kv" branches (the hosted deployment always has storage).
* **Difficulty:** Low. **Risk:** Medium (must not break decode).

### FT-25 · Cross-deployment `/api/resolve` — **A · REMOVE (Phase 1)**
* **Files / functions:** `isRemoteResolveOrigin`, `PRIVATE_HOST_SUFFIXES` (02:2566–2589), remote branch in `/api/resolve` (25:6870–6909), `RESOLVE_PROXY_PER_MINUTE` (00:802), client `resolveInstallLinkData` origin handling (24_).
* **What it does:** fetches `/api/resolve` from the origin a pasted install link came from so "one deployment can read an install link minted by a sibling".
* **Why:** multiple self-hosted deployments.
* **Current problem:** an unauthenticated outbound-fetch primitive that needed its own SSRF defence and rate limit, for a scenario that no longer exists.
* **Replacement:** none.
* **Difficulty:** Low. **Risk:** Low.

### FT-26 · Runtime schema detection — **A · REMOVE**
* **Files / functions:** `D1_SCHEMA_MANIFEST` (00:872–1054), `checkD1Schema` (02:4023–4060), cron `d1SchemaCheck` (26:7413–7421), `/admin/api/schema-status` (26:5836), `d1HasAiringRemovalColumns` + `_d1AiringRemovalColumns` and the dual SQL shapes (02:4123–4139, 4357–4409), the test keeping the manifest in step with migrations.
* **Why:** self-hosters pasted new code without running migrations.
* **Replacement:** migrations are applied by CI before deploy; the app assumes the schema.
* **Difficulty:** Low. **Risk:** Low.

### FT-27 · Hand-applied migrations — **B · REWRITE**
* **Files:** `schema.sql` ("DROPs every table… Do NOT run it against a database that is already live"), every `migrations/*.sql` header with dashboard-console instructions, `0001a`/`0001b` split because re-running a non-idempotent file in a console could not be recovered.
* **Replacement:** a migration tool with a ledger table (node-pg-migrate, Drizzle Kit, or sqitch), run in CI against staging then production; `schema.sql` generated from migrations for reference only.
* **Difficulty:** Low. **Risk:** Medium (process change).

### FT-28 · KV→D1 migration tools and lazy backfills — **A · REMOVE (after the data move)**
* **Files / functions:** `/admin/api/migrate-d1` (26:5026–5480) with `MIGRATE_D1_*` (00:566–588) and `migrated1:state`; `/admin/api/migrate-day-counts` (26:6253) with `migratedaycounts:state`; `/admin/api/rebuild-search-index` / `rebuild-public-index` (26:5483); `/admin/api/backfill-trending` (26:4922) with `backfilltrending:cursor`; `backfillCreatorRowInD1` (02:3733), `backfillCreatorLastActive` (03:353), lazy D1 backfills in scrobble-token and key-lookup readers.
* **Why:** incremental adoption of D1 by existing KV deployments, chunked to fit the op limit.
* **Replacement:** a one-off, idempotent migration script (Node, run from CI or a maintenance job) into Postgres, with verification reports (`MIGRATION_PLAN.md` Phase 3).
* **Difficulty:** Low. **Risk:** Medium (do not delete until the Postgres cutover is verified and the rollback window has passed).

### FT-29 · Legacy shape migrations on hot paths — **A · REMOVE (after the data move)**
* **Files / functions:** `ensureTrackingMigrated` (05:1914) called from scrobbles, cron, sync save/load and catalog reads; presets migration inside `/sync/save` (26:3015–3032) and `/sync/load` (26:3917–3937); `migrateGenreDecadeStatsIfNeeded` (03:215); legacy key names swept by `purgeCreatorData` (`creatorpresets:`, `creatorchannels:`, `creatorprofile:`, 02:3228–3231); `creatorsync:` fallbacks in `fetchAutoTrackedCatalog` (05:2174–2208) and the webhook filter (26:801–804).
* **Why:** per-account lazy migration because there was no batch migration capability.
* **Replacement:** fold into the one-off migration; delete the code.
* **Difficulty:** Low. **Risk:** Medium.

### FT-30 · KV rate limiters — **B · REWRITE**
* **Files / functions:** `consumeRateLimit` (02:1698–1708) and inline copies in `/api/preview` (25:1178–1185), `/api/save` (25:6963–6968), `/api/creator/create` (26:1210–1229), `/api/creator/restore` (26:1692–1700), `/api/creator/reset-key` (26:1361–1370), `/api/creator/forgot-username` (26:1582–1587), `/admin/login`, `/api/feedback`, `/api/track-event`, `/api/track-search`.
* **Why / limitation:** no atomic counters in KV; the Workers rate-limiting binding and WAF rules were not assumed available to self-hosters.
* **Current problem:** read-then-write with edge-cached reads is bypassable by concurrency; eight copies of the same logic with different conventions.
* **Replacement:** WAF rate-limiting rules for coarse per-IP limits; the Workers rate-limit binding (or a Durable Object counter) for per-account and per-token limits; one middleware.
* **Difficulty:** Medium. **Risk:** Low.

### FT-31 · Last-seen throttle — **B · REWRITE**
* **File / function:** `touchCreatorLastSeen` with `_lastSeenMemo` and 30-minute throttle (03:300–336), `creatorlastseen:` KV fallback.
* **Why:** KV write budget.
* **Replacement:** `sessions.last_used_at` updated at most every few minutes; `accounts.last_active_at` derived.
* **Difficulty:** Low. **Risk:** Low.

### FT-32 · Lookups sized to 50 fetches — **B · REWRITE**
* **Files / functions:** `MOST_WATCHED_MAX_LOOKUPS = 20` ("so it fits a free-plan request's 50-fetch allowance", 00:470–473; used 07:3222); `IMDB_ID_LOOKUP_MAX = 24` (00:1160–1164; `/api/imdb-ids` 25:2790).
* **Replacement:** both read the `media` table; misses are enqueued. Phase 1: raise the limits.
* **Difficulty:** Low. **Risk:** Low.

### FT-33 · `enrichTrailers` no-op — **A · REMOVE (Phase 1)**
* **File / function:** `enrichTrailers` (07:375–377) returns its input; called from every MDBList/Trakt fetcher.
* **Why:** "eliminates ~100,000+ redundant TMDB subrequests per day".
* **Replacement:** delete the function and its call sites (trailers are already resolved by Cinemeta on detail pages).
* **Difficulty:** Low. **Risk:** Low.

### FT-34 · Runtime bundle extraction and page memos — **A · REMOVE**
* **Files / functions:** `renderBuilderCached`, `BUILDER_PAGE_MEMO`, `htmlEtagFor`, `BUILDER_ETAG_MEMO`, `APP_BUNDLE_START/END`, `getAppBundle`, `splitAppBundle`, `APP_CSS_*`, `splitAppCss`, `SPLIT_PAGE_MEMO`, `pageWithExternalBundle`, `htmlPageResponse` (02:955–1199); `/app.js` and `/app.css` routes (25:891–941).
* **Why:** a single-file Worker with no static asset hosting; the SPA lives inside a template literal.
* **Current problem:** every isolate re-renders a ~2 MB string to discover its own bundle; memory pressure; complexity around ETags for pages that differ per request.
* **Replacement:** Workers Static Assets with hashed filenames; small HTML shell.
* **Difficulty:** Medium. **Risk:** Medium (the SPA migration in Phase 6 must keep deep links working).

### FT-35 · Base64 icon — **A · REMOVE**
* **File:** `01_icon-asset.js` (115 KB of base64, 1,393 lines) and the decode loop in `/icon.png` (25:194–205).
* **Replacement:** static asset (and real 192/512 PWA icons).
* **Difficulty:** Low. **Risk:** Low.

### FT-36 · Concatenation build and validators — **B · REWRITE**
* **Files:** `header.js`, `build.py`, `build.ps1` (duplicated header), `check_sync.py`, `verify.sh`, `extract_html.py`, `scope_check.mjs`, `render_check.js`, `html_checks.py`, `gen_map.py`, `FUNCTION-MAP.md`, the committed `worker_entry_combined.js`, `.gitattributes` LF pinning rationale, the CI steps that rebuild and diff.
* **Why:** the dashboard-paste deployment of one file.
* **Replacement:** TypeScript + esbuild via wrangler; lint/typecheck; keep the **hostile-render test** and **schema-drift test** as ordinary tests.
* **Difficulty:** Medium. **Risk:** Medium (a big mechanical change; do it behaviour-preserving, Phase 2).

### FT-37 · Dashboard-paste deployment — **A · REMOVE**
* **Evidence:** "the deployment README documents — and the one this add-on is published from — is a paste into the Cloudflare dashboard, which never reads that file" (00:257–260); `wrangler.toml` with placeholder ids.
* **Replacement:** CI/CD with `wrangler deploy`, staging and production environments, secrets managed per environment, migrations as a pipeline step, deploy only from `main` after tests.
* **Difficulty:** Low. **Risk:** Low.

### FT-38 · Free-plan and self-hosting copy — **A · REMOVE (Phase 1)**
* **Locations:** `README.md` "Which Cloudflare plan do I need?", "The three subrequest budgets", "Self-Hosting: Installation & Deployment" (Steps 1–7); `wrangler.toml` comment blocks; `header.js` ("No database, no server-side auth, nothing to run besides this Worker"); page title and meta description "Self-Hosted Stremio Catalogs… Self-hosted on your own free Cloudflare account" (09:62–79, visible in the browser tab during this audit); the in-app FAQ "Your configuration is encoded directly into your install link" (24:3816); prewarm log line "Set CRON_SUBREQUEST_BUDGET in wrangler.toml" (07:3238); ~60 source comments mentioning the free plan.
* **Replacement:** product copy for the hosted service; a CONTRIBUTING/dev-setup doc instead of a self-hosting guide.
* **Difficulty:** Low. **Risk:** Low (SEO copy change; keep canonical URLs).

---

## Group 6 — Keep, and investigate

### FT-39 · `LEGACY_UNVERIFIED_CONFIG_SHELVES = true` — **D · INVESTIGATE**
* **File:** `00_constants.js:709–740`; used in `resolveConfig` (04:75–77).
* **What it does:** keeps honouring personal shelves in install configs saved before ownership was verified.
* **Why it is unclear:** it is a security residual (an attacker who forged a config before the fix keeps reading that account's shelves) traded against silently emptying shelves for honest users; the constant says "flip this once users have regenerated links", but there is no telemetry showing how many legacy configs are still used.
* **Next step:** add a counter of legacy unverified resolutions (Analytics Engine) now; in the new install-token model, legacy configs that name an account are **re-bound to the account at migration time only if the account key stored in the config still verifies**, and otherwise lose personal shelves with an in-app notice to the owner.
* **Risk:** High either way; decide with data.

### FT-40 · `CF-Connecting-IP` — **C · KEEP**
* **File / function:** `clientIpKey` (02:1662–1675) with IPv6 /64 collapsing and fail-closed behaviour.
* **Why keep:** still on Cloudflare; correct and careful. Move into the rate-limit middleware; do not use raw IPs as like-voter identities (see `SECURITY_AUDIT.md` S-15).

### FT-41 · Edge caching and the SWR idea — **C (concept) / B (implementation)**
* **Files / functions:** `fetchWithPerUserCacheAndCircuitBreaker` (02:1292–1519) with memory → KV → edge tiers, empty-overwrite refusal, in-flight coalescing; `cf: { cacheTtl, cacheEverything }` on ~150 fetches.
* **Why keep the concept:** provider rate limits are real on any plan; stale-while-revalidate and "never overwrite a good copy with an empty one" are correct.
* **Rewrite:** one cache module in the provider layer; `cf.cacheTtl` only on idempotent public GETs; keys include the provider credential scope; no three-tier fan-out per call.

### FT-42 · Hosted-domain constants — **C · KEEP (move to config)**
* **Items:** `stremioAddonsConfig` issuer/signature (05:85–88), the hard-coded `mylistsaddon.com` redirect URI in MDBList OAuth (25:3575–3577), `ADDON_ID`/`ADDON_NAME`.
* **Action:** keep; move origin-dependent values to an `APP_ORIGIN` setting so staging works.

### FT-43 · Security header wrapper — **C · KEEP (as middleware)**
* **Items:** `withSecurityHeaders`, `isPrivateApiPath`, `isPublicCorsPath` (02:1–134), the top-level try/catch in `export default` (26:7269–7302).
* **Action:** keep the single-choke-point principle; tighten CSP when inline handlers go away (`SECURITY_AUDIT.md` S-11).

### FT-44 · New on Streaming engines and quota tracking — **D · INVESTIGATE**
* **Items:** RapidAPI monthly usage in KV `cron:rapidapi:usage` with `RAPIDAPI_MONTHLY_SAFETY_CAP` and per-tick page budgeting (07:1317–1378, 1623–1676); JustWatch GraphQL (00:325–349, 07:1978–2413) described in-code as having "no key and no published terms for third-party use… Using it here is the operator's call".
* **Why investigate:** the budgeting is a vendor quota (keep, move to Postgres), but the JustWatch engine is a legal/terms question, not a technical one.
* **Next step:** get written clarity from JustWatch or run on RapidAPI only; keep both behind a flag.

### FT-45 · `lastgood:` catalog copies — **D → B**
* **Location:** catalog route (25:1007, 1022–1027, 1039–1048).
* **What it does:** after every successful first-page catalog response for a non-personal row, writes a copy to `lastgood:{config}:{type}:{id}` (30-day TTL) to serve if the source later fails.
* **Why investigate:** it is resilience, not a free-tier artefact, but it duplicates the source-level circuit-breaker cache **per install config**, and it performs a KV write on every successful first-page request.
* **Replacement:** rely on the source-level SWR snapshot (shared by every config showing that chart); Phase 1 can at least skip the write when the content hash is unchanged.

### FT-46 · Timeouts and cost bounds — **C · KEEP**
* **Items:** `OUTBOUND_TIMEOUT_MS`, `fetchWithTimeout`, `withTimeout` (02:1544–1584); `PERSON_SHOW_MAX_SEASONS/EPISODES`, `CHANNEL_LIVE_POOL_*`, `CHANNEL_NEW_EPISODE_*`, `CHANNEL_POOL_MAX_ITEMS`, `SAVED_CONFIG_ENTRIES_MAX`.
* **Action:** these bound cost and abuse on any plan. Keep, move into provider and domain configuration, and apply the timeout to the ~140 raw `fetch()` sites that currently have none.

---

## Order of execution

1. **Phase 1 (now, in the current codebase):** FT-09, FT-25, FT-33, FT-38, the Phase 1 interims of FT-01/02/03/32/45, and the paid defaults for every `*_BUDGET`.
2. **Phase 2 (modular build):** FT-26, FT-27, FT-35, FT-36, FT-37, FT-42, FT-43.
3. **Phase 3 (Postgres):** FT-08, FT-10–FT-16, FT-18–FT-24, FT-31.
4. **Phase 5 (jobs):** FT-01, FT-02, FT-03–FT-07, FT-44, FT-45.
5. **Phase 7 (security):** FT-17, FT-30, FT-39.
6. **Phase 10 (decommission):** FT-28, FT-29, then delete the KV namespace's remaining non-cache prefixes.
