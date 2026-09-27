# Performance Audit

**Date:** 2026-09-25 · **Status:** findings only; nothing changed.

**Method.** Source reading, plus measurements taken by running the real `worker_entry_combined.js` in-process against the repo's own harness (`tests/harness.mjs`: SQLite-backed D1, in-memory KV, stubbed upstreams). The measurement scripts were kept outside the repository.

- Node timings are **indicative only**; Workers CPU differs.
- Byte counts and operation counts are exact for this build.

---

## 1. Measured baseline

| Measurement | Value |
|---|---|
| `GET /` page HTML | **285 KB** raw / 37 KB gzip / 27 KB brotli (`Cache-Control: no-cache`, ETag) |
| `GET /app.js?v=…` client bundle | **2.0 MB** raw / **459 KB gzip** / 327 KB brotli (immutable). The code's comments say "~1.3 MB"; it has grown. |
| `GET /app.css?v=…` | 107 KB raw / 20 KB gzip (immutable) |
| Pre-split HTML rendered in the isolate per variant | about 2.3 MB string (page plus bundle plus CSS), then split at runtime by marker search |
| `/` render in Node | cold 84 ms; warm 4 ms (memoized); 304 revalidation 3 ms |
| Live DOM after load (all tabs rendered at once) | about 4,000 elements, **754 `<button>`s**, **189 inputs** |
| Inline event handlers in markup | 733 |
| 20-row home screen with "remove duplicates" on, one warm isolate | 20 upstream calls, 40 KV reads, **40 KV writes** (20 provider-cache and 20 `lastgood:`) |
| Same, each row served by a different isolate | **230 KV reads** (quadratic: 20 + Σk) |
| One playback ping, account with 3,000 history items | **3,025 D1 statements in 42 batches**, about **496 KB written to KV** |
| One browser `save-tracking` with 3,000 items | 3,008 D1 statements in 38 batches, about 432 KB written to KV |
| Signed-in open tab | `/sync/meta` every 60 s, plus on every focus, visibility change and pageshow. Each poll is a full auth path: KV tombstone read, D1 tombstone read, D1 `creators` read, **KV `creator:` write**, and a possible KV rate-limit write. |

---

## 2. The 10 most important performance improvements (ranked)

| # | Improvement | Current cost | Expected result | Effort |
|---|---|---|---|---|
| 1 | **Event-row tracking** (BE-C2): scrobble = 1 insert + 1 upsert, through a Queue | 3,025 D1 statements plus 496 KB KV per play (3,000-item history); grows with history; can exceed per-invocation limits | About 2 D1 statements per play. Webhook and ping responses no longer wait on writes. | High |
| 2 | **Show-centric schedule** (BE-C3): per-show refresh jobs plus read-time Continue Watching and Airing Next | TMDB calls ∝ users × shows. Freshness degrades linearly (17 days / 139 days per account at 100k). Airing Next also rebuilt per browser (60 `/api/details` lookups per refresh per device). | TMDB calls ∝ distinct active shows (about 30k); freshness independent of user count; zero browser work | High |
| 3 | **Catalog hot path: install snapshot plus per-install materialization plus Cache API** (BE-H03, BE-H04, FT-25) | Per row: `resolveConfig` KV read, **plus the owner's multi-MB tracking blob read (2–3 times)**, plus an O(N) dedupe refetch, plus a `lastgood:` KV write | Common case: 1 Cache API hit, or 1 KV read. No blob reads, no writes. Dedupe computed once per `(install, version)`. | Medium |
| 4 | **Sessions** instead of the key on every request (S-01, FT-22) | Full auth path (4–5 storage operations including a KV write, and PBKDF2 when the memo misses) on every autosave, poll and ping | 1 indexed D1 read (plus a 60 s isolate cache); PBKDF2 only at login; no KV writes | Medium |
| 5 | **Remove KV write amplification** (BE-H05) | KV writes on every auth (`getCreator`), every D1-served list read (`getCreatorList`), every catalog page (`lastgood:`), every limited request; about 1 write/s/key contention | KV writes only when snapshots are rebuilt | Low–Medium |
| 6 | **Chart snapshots per region** (FT-19, BE-M11) | About 40 charts re-fetched every 6 min (US only, page 0); `caches.default` warmed in one colo only; other regions and pages cold; three cache tiers | Hourly jobs; every region and page served from a global KV snapshot | Medium |
| 7 | **Frontend: split the 2.0 MB bundle and render only the active view** | 459 KB gzipped JS parsed on every cold load, even for "install one list"; 4,000 DOM nodes and 754 buttons live at once; 733 inline handlers | Route-level chunks (Discover, Lists, Channels builder, Settings, Admin); target under 150 KB gzip for the first view; views render on navigation | High |
| 8 | **Relational lists** (`list_items`, stored `item_count`, keyset pagination, external-content FTS) | Whole list (up to 1.8 MB) resent and rewritten to both stores on every edit; `json_array_length` over every row on directory queries; OFFSET paging; FTS deletes scan | Item-level writes; constant-cost directory pages at any depth | High |
| 9 | **Analytics off the request path** (FT-15, BE-H11) | D1 batch write per page view and per shared-key catalog fetch (`trackSharedApiUse`, `05_:125-129`); leaderboard `LIKE` scans over `stats` every 15 min | Analytics Engine `writeDataPoint` (no D1); purpose-built indexed rollups | Medium |
| 10 | **Provider IO discipline** (BE-H10, §6 of the architecture) | Most of the 197 direct `fetch()` calls in server code have no timeout (only those inside the 21 circuit-breaker closures, plus the separate `fetchWithTimeout` and `fetchTraktWithRetry` helpers, are bounded); in-request retry sleeps (up to 3 s ×2, OAuth loops up to 6 s); sequential prewarm with `pauseMs` sleeps | Mandatory timeouts, bounded concurrency, retries moved to the queue, coalescing kept | Medium |

---

## 3. Frontend findings

| ID | Finding | Evidence | Fix |
|---|---|---|---|
| PF-F1 | One 2.0 MB bundle for every page and every visitor | measured above | Code-split by route; lazy-load the channel builder (`20_`, 506 KB source) and custom-list builder (`21_`, 200 KB) |
| PF-F2 | All six tabs and their sub-panels are in the DOM from the first paint | 4,000 elements / 754 buttons / 189 inputs measured in the running app | Render a view when it is navigated to; keep hidden views unmounted |
| PF-F3 | `localStorage` as the database: about 650 read and write sites, JSON parse/stringify of whole lists, channels and watch history on UI events | `22_` (220 sites), `17_` (113), `24_` (84), `19_` (66), `23_` (65) | A server-authoritative data layer with an in-memory query cache; `localStorage` for preferences only |
| PF-F4 | 60 s background poll plus focus, visibility and pageshow triggers per open tab, each a full-auth request | `22_:6470-6600` | Sessions make it cheap; better, a single `GET /api/me/changes?since=` with `ETag`/`304`, polled only while the app is visible |
| PF-F5 | Airing Next computed in the browser: up to 60 shows through `/api/details/batch` with round loops (`DETAILS_BATCH_MAX_ROUNDS`) | `21_:3455-3480`, `3690-3725` | Server-computed shelves (improvement #2) |
| PF-F6 | Live Preview re-fetches each row's shelf through `/api/preview`; placeholders "Click Refresh Preview above to load posters" appear on load | Seen in the running app | Preview reads the same materialized rows as Stremio; lazy per visible row |
| PF-F7 | 326 `innerHTML` assignments that rebuild whole sections on state changes | code count | Keyed rendering (lit-html or Preact) |
| PF-F8 | Google Fonts (three families) and jsDelivr (`fflate`) on the critical path, loaded cross-origin | `09_:3629`, `03_:1600-1602` | Self-host fonts and `fflate`, subset and preload; `fflate` only in the import view |
| PF-F9 | Service worker precaches `/` and the bundle; with a 2.0 MB bundle, the first install downloads everything | `25_:66-161` | Keep the SW; precache only the shell plus the current route's chunk |

## 4. Backend findings

| ID | Finding | Evidence | Fix |
|---|---|---|---|
| PF-B1 | `resolveConfig` reads the tracking blob on every catalog request, and is called again in `fetchAutoTrackedCatalog` and `fetchCuratedCatalog` | `04_:79-98`, `05_:1828`, `05_:1960` | BE-H04 |
| PF-B2 | Dedupe fan-out | Measured: 230 KV reads per 20-row screen across isolates | BE-H03 |
| PF-B3 | `buildTmdbRecommendations` per catalog request when the website's snapshot is more than 3 days old: up to 12 × (`find` + `recommendations` + `similar`), plus `trending`, plus 40 `external_ids`, about 77 subrequests, edge-cached per URL but never persisted | `05_:1663-1902` | Account-level recommendation job, stored |
| PF-B4 | `/api/poster-badge` downloads the poster and base64-encodes it with a per-byte string concatenation, then returns a data-URI SVG (about 1.35× the poster size) | `25_:350-381` | Serve badges as a small SVG overlay referencing an R2 or TMDB image, or render once to R2 keyed by `(poster, badge, day)` |
| PF-B5 | `/icon.png` decodes 115 KB of base64 on every request | `25_:194-205` | Decode once at module load, or serve from an embedded `Uint8Array` |
| PF-B6 | BetterPosters: requests can wait up to 55 s on btttr.cc; bytes stored in KV | `05_:1000-1260` | R2 plus a non-blocking fetch job |
| PF-B7 | `readCreatorTrackingD1` selects the entire watch history with no LIMIT, used by sync load, the cron and every scrobble | `02_:4677-4690` | Paginated history API; progress rows for everything else |
| PF-B8 | `applyLikeVote` reads all voters (up to 5,000) and rewrites a KV array per like; `/api/lists/like` rewrites the whole list record | `02_:1863-1960`, `25_:7211-7231` | `likes` table plus counter |
| PF-B9 | Directory: `UNION ALL` with `json_array_length(items_json)` per row, OFFSET paging and two `COUNT(*)`s per call | `02_:2645-2691` | Stored `item_count`, keyset pagination, cached total |
| PF-B10 | Stats `LIKE 'prefix%'` queries cannot use the `(kind, day)` index | `03_:667-686`, `1245-1256`, `1445` | BE-H11 |
| PF-B11 | `attachEventMeta` binds 401 parameters, fails on D1, and falls back to up to 400 individual KV reads, on the path that builds the public Most Watched rows | `03_:618-657` | BE-H01 |
| PF-B12 | FTS updates delete by an `UNINDEXED` column (full FTS scan per save or delete) | `26_:2431-2444` | External-content FTS |
| PF-B13 | `purgeCreatorData` (sequential awaits over 20+ KV keys and 12 D1 statements) runs as a pre-create sweep on **every** account creation | `26_:1292`, `02_:3022-3446` | Remove the pre-create purge (not needed with a single authority and soft delete) |
| PF-B14 | Cron: 30 s CPU every 6 minutes shared by 8 tasks, sequential chart warming with sleeps | `26_:7308-7431`, `07_:5218-5417` | Dispatcher plus queue consumers (15 min wall each) |
| PF-B15 | `pageviews` D1 write on every page route (`bumpStat` at `25_:183`, `467`, `502`, `515`, `640`, `656`, `677`, `722`, `733`) | code | Analytics Engine |
| PF-B16 | Per-isolate memos sized by entry count, not bytes (`PER_USER_CACHE_MAP` 1,000 entries of arbitrary provider payloads) within 128 MB | `02_:1204-1269` | Byte-bounded LRU, or rely on snapshots |
| PF-B17 | Charts pre-warmed only for US, page 0; `caches.default` is per colo | `07_:5313`, `02_:1401-1488` | Snapshots per region |

## 5. Latency budget for the v2 catalog path (target)

| Step | Target |
|---|---|
| Cache API hit (materialized row) | under 5 ms |
| KV install snapshot plus KV chart snapshot (cold colo) | under 40 ms at p95 |
| Personal shelf (2 indexed D1 queries on a read replica) | under 60 ms at p95 |
| Provider live call (connected account rows only) | under 800 ms with timeout plus stale fallback |

## 6. What to measure in production before and after

- Workers Analytics or Tail: p50 and p95 per route family; CPU ms per route; subrequests per invocation; KV reads and writes per route (via Analytics Engine counters added in Phase 1).
- D1: query duration histogram (the D1 dashboard), rows read per query, database size, "overloaded" errors.
- Provider: calls per provider per hour, error and 429 rates, latency.
- Frontend: LCP and INP (web-vitals beacon to Analytics Engine), JS transferred per session.
