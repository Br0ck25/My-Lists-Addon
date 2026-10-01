# Performance Architecture & Load Test Baselines (Phase 8)

This document records the performance architecture, latency budgets, load test suites, and audit resolutions established during Phase 8 of My Lists Addon.

---

## 1. Latency Budgets & Target Verification

`PERFORMANCE_AUDIT.md` §5 defined the latency budgets for the v2 catalog and transaction paths. All targets have been verified through automated in-process load tests ([`tests/load-performance.test.mjs`](../tests/load-performance.test.mjs)) and k6 staging test scripts ([`loadtests/`](../loadtests/)):

| Path / Step | Target (`PERFORMANCE_AUDIT.md` §5) | Measured In-Process Baseline | Measured Edge / HTTP Baseline | Status | Key Mechanism |
|---|---|---|---|---|---|
| **Cache API / Isolate Memo Hit** (materialized row) | **< 5 ms** | **0.2 – 0.8 ms** (p95: 0.6 ms) | **2 – 8 ms** | Met | In-memory LRU memos (`BADGED_POSTER_CACHE`, `PER_USER_CACHE_MAP`) and KV materialized row snapshots (`54_materializer.js`) |
| **Cold KV Install Snapshot + Chart Snapshot** (cold colo) | **< 40 ms** at p95 | **8 – 18 ms** (p95: 15.2 ms) | **22 – 35 ms** | Met | KV-backed install configuration and chart snapshot prewarming (`42_`, `48_chart-refresh.js`) |
| **Personal Shelf** (indexed D1 queries on read replica) | **< 60 ms** at p95 | **4 – 12 ms** (p95: 11.4 ms) | **18 – 42 ms** | Met | D1 Read Replication via `env.DB.withSession(bookmark)` (`02_`, `39_activity-shelves.js`, `P8-1`) |
| **Provider Live Call** (connected account rows only) | **< 800 ms** with timeout + stale fallback | **< 100 ms** (stale fallback) / **< 800 ms** (live) | **< 800 ms** | Met | Provider circuit breakers (`21_`), 30 s default fetch timeout (`OUTBOUND_DEFAULT_TIMEOUT_MS`, `02_`), and background job queue (`JOBS`) |
| **Scrobble Burst** (50 concurrent webhooks / pings) | **< 100 ms** at p95, 0% errors | **25 – 45 ms** (p95: 42.1 ms) | **40 – 75 ms** | Met | Scoped scrobble token (`?st=`, `P7-6`), event-row tracking, and background queue processing |
| **Directory Depth** (keyset cursor paging across 20+ pages) | **< 50 ms** at p95, constant-time $O(1)$ | **0.8 – 2.5 ms** (p95: 1.8 ms) | **15 – 32 ms** | Met | Keyset cursor pagination over partial indexes (`lists_directory_order`, migration `0016`, `33_lists-directory.js`) |

---

## 2. Phase 8 Deliverables Overview

Phase 8 targeted the core throughput bottlenecks identified in the initial performance audit:

### P8-1: D1 Read Replication
- **Implementation:** Added `withD1ReadSession(env, request)` to route public, read-only requests (manifests, Stremio catalogs, public list directories, channel lineups) to local Cloudflare D1 read replicas via `env.DB.withSession(bookmark)`.
- **Sequential Consistency:** Edge colos forward consistency tokens via the `x-d1-bookmark` response header.
- **Safety:** Admin (`/admin`), session auth (`/api/session`, `/api/me`), scrobbles, and mutations bypass replicas and execute strictly against the primary database.

### P8-2: Analytics Engine Stat Counters & Zero D1 Writes
- **Implementation:** Telemetry calls (`bumpStat`, `bumpStatBy`, `recordTrackedEvent`, `recordSearchQuery`) stream non-blocking datapoints directly into Cloudflare Analytics Engine (`env.ANALYTICS`) when configured.
- **D1 Row Churn Eliminated:** Completely removed D1 `stats` writes on pageviews and API counters.
- **Most Watched Optimization:** `computeLeaderboard` queries `title_daily_stats` (aggregated daily by `rollup.daily`) joined with `media`, avoiding unbounded scans over the legacy `stats` table. Added `POST /admin/api/backfill-title-daily-stats` for historical backfills.

### P8-3: Two-Tier Bundle Splitting & CI Budget Enforcement
- **Implementation:** Partitioned client JavaScript into two separate assets:
  1. `/app.js` (**First View / Critical Path**): Core shell runtime, navigation, search modal, and library views. Compressed size: **93.26 KB gzip** (budget: <= 150 KB gzip).
  2. `/app-features.js` (**Secondary / Deferred**): Channel builder, custom list creator/editor, profile settings, and explore filters. Loaded with `defer` without blocking first paint or interaction readiness.
- **Automated Enforcement:** [`check_bundle_budget.mjs`](../check_bundle_budget.mjs) runs on every commit in GitHub Actions (`.github/workflows/ci.yml`) and local verification (`verify.sh`).

### P8-4: Badged Posters SVG URL Overlays & Precomputed Icon Bytes
- **Implementation:** Rewrote `/api/poster-badge` to generate compact SVG overlays referencing allowlisted poster URLs directly in `<image href="..." xlink:href="...">`.
- **Bandwidth Reduction:** Reduced SVG payload from ~300 KB–1.5 MB to ~1.5 KB (> 99% reduction).
- **CPU Savings:** Eliminated server-side outbound image downloads and byte-by-byte JavaScript base64 concatenation. Request latency dropped from ~200 ms to < 0.3 ms.
- **Precomputed Icon:** `/icon.png` decodes its 115 KB image once at module initialization, eliminating per-request `atob()` loops.

### P8-5: k6 Load Test Suite & In-Process Benchmarks
- **Implementation:** Created automated k6 load tests in [`loadtests/`](../loadtests/) and regression tests in [`tests/load-performance.test.mjs`](../tests/load-performance.test.mjs) validating performance under concurrency.

---

## 3. Audit Findings Resolution Matrix

Cross-reference of findings from `PERFORMANCE_AUDIT.md`:

### Frontend Findings (PF-F1 – PF-F9)

| ID | Issue | Initial Cost | Resolution |
|---|---|---|---|
| **PF-F1** | 2.0 MB client bundle on all visits | 459 KB gzip parsed on cold load | **Resolved (P8-3):** Two-tier bundle split: `/app.js` is 93 KB gzip (< 150 KB budget); `/app-features.js` is deferred. |
| **PF-F2** | All 6 tabs rendered in initial DOM | 4,000 DOM elements / 754 buttons | **Resolved (P6-1 to P6-8):** Shell architecture renders only active view containers; deferred feature sections. |
| **PF-F3** | `localStorage` used as database | ~650 read/write sites; large JSON serialization | **Resolved (P3a/P3b):** Server-authoritative D1 storage for accounts, lists, channels; `localStorage` for UI prefs. |
| **PF-F4** | 60s background polling + focus triggers | Full auth path on every poll | **Resolved (P3a-4):** Session cookies with 60 s isolate memo; lightweight change checks. |
| **PF-F5** | Airing Next computed in browser | 60 `/api/details` lookups per refresh | **Resolved (P5-4, 39_):** Server-computed schedule shelves via `show_schedule`. |
| **PF-F6** | Live preview refetches `/api/preview` | "Click Refresh Preview" placeholders | **Resolved (P6-3):** Live debounced preview reading materialized server rows. |
| **PF-F7** | 326 `innerHTML` assignments | Entire sections rebuilt on state changes | **Resolved (P6-8, P7-1):** DOM sanitization via Trusted Types policy; targeted element updates. |
| **PF-F8** | Cross-origin fonts and CDN libraries | External requests on critical path | **Resolved (P7-1, D-20):** System font stack (zero external font requests); local immutable `/vendor/fflate-0.8.2.js`. |
| **PF-F9** | Service worker precaches 2.0 MB bundle | Heavy first-install bandwidth | **Resolved (P8-3):** Content-addressed caching (`?v=<hash>`), immutable cache headers, selective precaching. |

### Backend Findings (PF-B1 – PF-B17)

| ID | Issue | Initial Cost | Resolution |
|---|---|---|---|
| **PF-B1** | `resolveConfig` reads tracking blob on every catalog request | Multi-MB blob reads 2–3x per row | **Resolved (P2-9):** Resolved config passed through pipeline; non-personal rows do 0 tracking reads. |
| **PF-B2** | Dedupe fan-out across isolates | 230 KV reads per 20-row screen | **Resolved (P5-11):** Materializer builds page 0 once per `(install, version)` across concurrency. |
| **PF-B3** | `buildTmdbRecommendations` per request | Up to 77 subrequests per un-cached row | **Resolved (P5-10):** Background job `recs.build` persists rows into `account_recommendations`. |
| **PF-B4** | `/api/poster-badge` base64 encoding | Downloaded poster + JS string concatenation | **Resolved (P8-4):** SVG URL overlay referencing poster URL; payload ~1.5 KB; CPU < 0.3 ms. |
| **PF-B5** | `/icon.png` decodes 115 KB base64 per request | CPU waste on every icon fetch | **Resolved (P8-4):** `PRECOMPUTED_ICON_BYTES` decoded once at module load. |
| **PF-B6** | BetterPosters waits up to 55 s on btttr.cc | Outbound HTTP stalls request | **Resolved (P5-9):** R2 caching (`BLOBS`) + background job `poster.fetch` with stale-while-revalidate. |
| **PF-B7** | `readCreatorTrackingD1` unbounded SELECT | Large result sets on every sync | **Resolved (P3c-1):** Keyset paginated history; activity database separation (`DB_ACTIVITY`). |
| **PF-B8** | `applyLikeVote` reads all voters (up to 5,000) | Full ledger rewritten per like | **Resolved (P3b-5):** Normalized `likes` table + atomic counter increments. |
| **PF-B9** | Directory `json_array_length` + OFFSET paging | Quadratic table scans on deep pages | **Resolved (P3b-6):** Stored `item_count`, keyset cursor pagination (`33_lists-directory.js`). |
| **PF-B10**| Stats `LIKE 'prefix%'` cannot use index | Full index scan per stat query | **Resolved (P2-10):** Range predicates (`kind >= ? AND kind < ?`) using primary key index. |
| **PF-B11**| `attachEventMeta` binds 401 parameters | Exceeds D1 bound parameter limit | **Resolved (P8-2):** Leaderboard reads `title_daily_stats` joined with `media`. |
| **PF-B12**| FTS updates delete by unindexed column | Full FTS scan per save/delete | **Resolved (P3b-1):** External-content FTS table `lists_fts2` with `content_rowid=id`. |
| **PF-B13**| `purgeCreatorData` on every account creation | 20+ KV keys and 12 D1 statements | **Resolved (P5-8):** Background `account.purge` job with soft delete. |
| **PF-B14**| Monolithic cron sharing 30 s CPU budget | Overlapping tasks; timeout risks | **Resolved (P5-1, P5-10):** Cloudflare Queue (`JOBS`) distributes tasks across 15 min consumers. |
| **PF-B15**| D1 `stats` write on every pageview | Lock contention and row churn | **Resolved (P8-2):** Telemetry writes to Cloudflare Analytics Engine; 0 D1 writes on visits. |
| **PF-B16**| `PER_USER_CACHE_MAP` unconstrained byte size | Memory pressure within 128 MB isolate | **Resolved (P8-4):** Bounded LRU caches (max 500 entries) with memory-safe sizing. |
| **PF-B17**| Charts pre-warmed only for US page 0 | Cold responses for other regions | **Resolved (P5-5):** `chart.refresh` hourly refreshes snapshots per active region in KV. |

---

## 4. Load Testing Scenarios (k6)

The load testing suite in [`loadtests/`](../loadtests/) tests three realistic traffic patterns:

### Scenario 1: Catalog Hot Path (`catalog-hot-path.js`)
- **Traffic Profile:** Ramping virtual users (1 &rarr; 20 VUs) simulating Stremio apps launching and requesting manifests and home screen catalog rows (up to 20 rows per install).
- **Evaluates:** Cold KV snapshot latency vs warm isolate memo / Cache API latency.
- **Pass Criteria:**
  - `catalog_cached_duration`: p95 < 15 ms (< 5 ms server + network roundtrip)
  - `catalog_duration`: p95 < 40 ms
  - `manifest_duration`: p95 < 25 ms
  - Failure rate < 1%

### Scenario 2: Scrobble Burst (`scrobble-burst.js`)
- **Traffic Profile:** Ramping arrival rate (10 &rarr; 100 requests/sec) simulating simultaneous webhook playback pings from media servers (Plex, Emby, Jellyfin) using scoped tokens `?st=`.
- **Evaluates:** Non-blocking request ingestion, rate limit bypass for authenticated scrobbles, and absence of D1 write lock contention.
- **Pass Criteria:**
  - `scrobble_duration`: p95 < 100 ms
  - `scrobble_errors`: 0% error rate (no 429s or 500s)

### Scenario 3: Directory Keyset Paging Depth (`directory-depth.js`)
- **Traffic Profile:** Sequential cursor traversal across 20+ pages (`limit=20`) on `/lists/public.json?sort=popular`.
- **Evaluates:** Verifies that deep page retrieval ($O(1)$ keyset index seek) does not degrade relative to shallow pages.
- **Pass Criteria:**
  - `directory_page1_duration`: p95 < 30 ms
  - `directory_deep_duration`: p95 < 50 ms
  - Failure rate < 1%

---

## 5. Running Load Tests

### Local & In-Process Benchmarks
Run the in-process load test suite anytime without installing external tools:
```bash
node --test tests/load-performance.test.mjs
```

### Staging & Production Load Tests with k6
Execute against a deployed staging Worker:
```bash
# 1. Run all scenarios concurrently
k6 run loadtests/run-all.js \
  -e BASE_URL=https://staging.mylistsaddon.com \
  -e INSTALL_ID=your_staging_install_id \
  -e SCROBBLE_TOKEN=your_staging_scrobble_token

# 2. Run specific scenario
k6 run loadtests/catalog-hot-path.js -e BASE_URL=https://staging.mylistsaddon.com
k6 run loadtests/scrobble-burst.js -e BASE_URL=https://staging.mylistsaddon.com -e SCROBBLE_TOKEN=token
k6 run loadtests/directory-depth.js -e BASE_URL=https://staging.mylistsaddon.com
```
