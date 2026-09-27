# Performance Audit — My Lists

**Date:** 2026-09-24 · **Method:** measurements taken on the real Worker through the repo's harness (real SQLite D1, in-memory KV, stubbed upstreams, operation counters wrapped around every KV/D1 call), network/DOM measurements of the rendered builder page in a browser, and code-path analysis for everything that depends on production traffic or provider latency. Production latency percentiles were not available to this audit; where a number is an estimate it says so.

---

## 1. Measurements

### 1.1 Frontend (first load, empty account)

| Asset | Size | Notes |
|---|---|---|
| HTML (`/`) | **285,502 B** (36.8 KB gzip) | Every tab's markup pre-rendered; chart tables inlined as JSON. |
| `app.js` | **2,015,282 B** (456.8 KB gzip) | ~820 global functions; parsed/compiled on every cold load (cached afterwards via immutable URL). |
| `app.css` | **106,928 B** | ~600 rules; single file for every screen. |
| Third-party | `fflate` (jsDelivr), Google Fonts | `fflate` is on the critical path for one feature. |
| DOM at first paint | **3,430 nodes, 624 buttons, 199 inputs/selects/textareas** | Six tabs + hidden detail views rendered up front. |
| `localStorage` | 61 keys after a short session (~80 possible) | Includes large JSON (lists, channels, tracking caches). |

On a mid-range phone, parsing and compiling ~2 MB of JavaScript typically costs 1–2 s of main-thread time on a cold load (estimate); the page cannot become interactive before that.

### 1.2 Backend operations per request (repo harness; D1 = real SQLite)

| Request | KV reads | **KV writes** | KV lists | D1 statements | Response |
|---|---|---|---|---|---|
| Dashboard `/api/creator/lists` (20 lists + watchlist) | 24 | **21** | 1 | 24 | metadata only |
| `/api/creator/sync/meta` (polled every 60 s while the dashboard is open) | 7 | **1** | 0 | 4 | tiny |
| Smallest authenticated call (`/api/creator/track-status`) | 2 | **1** | 0 | 2 | tiny |
| `/sync/save-tracking`, 2,000-item history | 4 | 2 | 0 | **2,007** | — |
| `/sync/save-tracking`, **add one item** to 2,000 | 5 | 2 | 0 | **2,012** | — |
| **One Plex scrobble**, 2,000-item history | 8 | 4 | 0 | **2,013** | — |
| `/sync/load` (per call) | 11 | 1 | 0 | 9 | **181 KB** (grows with history) |

### 1.3 Catalog fan-out (repo harness, stubbed provider)

| Scenario | Upstream fetches |
|---|---|
| Cold request for row 20 of a 20-row config | 1 |
| Same, with "Remove duplicate items across lists" | **20** (every earlier row refetched) |
| Home screen of 20 rows, cold isolates, dedupe on | ≈ 210 (1 + 2 + … + 20) (derived) |

### 1.4 Pagination correctness (repo harness)

| Row kind | skip=0 | skip=100 | skip=200 | skip=250 |
|---|---|---|---|---|
| Published list (250 items) | 250 | **250** | **250** | **250** |
| Watch History (250 items) | 100 | **100 (same)** | **100 (same)** | — |

Duplicate pages are also a performance problem: clients that page by `skip` keep downloading the same payload.

### 1.5 Background throughput (derived from code)

| Job | Rate | Full cycle at 10,000 accounts | at 100,000 accounts |
|---|---|---|---|
| Continue Watching sweep | 25 accounts listed per 6-min tick (≤150 show checks) | ≈ 1.7 days | ≈ 16.7 days |
| Airing Next sweep | 3 accounts per tick | ≈ 13.9 days | ≈ 139 days |
| Chart pre-warm | all ~40 charts per tick when the budget allows; sequential with 150–200 ms sleeps | — | — |

---

## 2. Findings

### Backend

| ID | Finding | Evidence | Impact |
|---|---|---|---|
| P-1 | **O(history) writes** for every scrobble and every tracking save. | §1.2 | Latency and D1 row-write billing scale with plays × history length; long histories exceed per-invocation limits and leave D1 "behind". |
| P-2 | **KV writes on reads** (`getCreator`, `getCreatorList`, visibility stamping). | §1.2 | ≥1 KV write per authenticated request; 21 per dashboard load; KV writes are the costliest KV op and rate-limited per key. |
| P-3 | **`lastgood:` KV write per successful first-page catalog request**, per install config and row. | 25:1022–1027 | A KV write per row per home-screen load across all users. |
| P-4 | **`trackSharedApiUse` D1 counter write on every catalog fetch** that uses a shared key. | 05:125–129 | A D1 write per row per request. |
| P-5 | **Full-state sync**: `/sync/load` returns the whole account; `/sync/meta` polled every 60 s; `/sync/save*` accept whole arrays. | §1.2 | Transfer and parse cost grow with account size; 1,440 polls/day per open dashboard, each with a KV write. |
| P-6 | **Catalog pipeline recomputes per request**: `resolveConfig` (KV read) on every manifest/catalog/meta/subtitles request and again inside curated/auto-tracked fetchers; cross-row dedupe refetches earlier rows (§1.3); stale recommendations rebuilt inline with ~70–80 raw TMDB calls and no timeout. | 25:953–1075, 05:294–329, 05:1821–1902 | Tail latency on TV clients; provider quota burn. |
| P-7 | **Directory and search** sort all public lists and parse every list's JSON per page; FTS joins on an expression. | BACKEND_AUDIT B-C4 | Linear (or worse) in the number of public lists. |
| P-8 | **Per-account cron sweeps** and per-user TMDB lookups for shared shows. | §1.5 | Freshness degrades with user count; redundant provider calls. |
| P-9 | **No timeout on ~140 provider calls**; only calls inside the circuit breaker get 10 s. | BACKEND_AUDIT B-H9 | One slow provider holds requests open. |
| P-10 | **Overlapping caches** for the same TMDB data (`tmdbdetail_v2:`, `tmdb:itemdetails:v3:`, `tmdb:season:`, `unpacked_show:`, per-list circuit-breaker keys) and no normalized media store. | 07:389–485, 07:3763 | Repeated provider calls and KV growth; cache invalidation by guesswork. |
| P-11 | **Badged posters** fetch the full source image server-side and embed it base64 in SVG per distinct URL. | 25:310–461 | ~33% larger than the image; one origin fetch per poster/date combination. |
| P-12 | **Public list pages** render the full 2 MB app and embed every item in the HTML; `.json` has no pagination. | 26:4775–4857 | Slow shared links; large responses for 10k-item lists. |
| P-13 | **Like** reads the full voter set (≤5,000) and rewrites a KV JSON array plus the whole list record. | 02:1863–1960, 25:7211–7231 | O(voters) per like; contention on popular lists. |
| P-14 | **Admin dashboard** lists every `creator:` KV key on every load. | 03:1740–1744 | O(accounts) KV list calls per page view. |
| P-15 | **Per-isolate memory**: the builder page is rendered (~2 MB string) in every isolate to find its own bundle; memo maps hold large strings; `PER_USER_CACHE_MAP` holds up to 1,000 provider payloads. | 02:985–1269 | Memory pressure and cold-start CPU. |
| P-16 | **Webhook and playback pings do all work inline**: TMDB lookups, full tracking read/write, diagnostics write, watchlist scan. | 26:155–544, 26:548–1133 | Slow webhook responses; retries from media servers amplify load. |

### Frontend

| ID | Finding | Evidence | Impact |
|---|---|---|---|
| P-17 | **2.0 MB monolithic bundle** shipped to every page (including public list pages). | §1.1 | Slow cold start, especially on phones and TV browsers. |
| P-18 | **Everything rendered up front** (3,430 nodes). | §1.1 | Slower first paint and layout; more memory. |
| P-19 | **Dashboard re-render after every save/delete/tab switch/background sync** calls `/api/creator/lists` (see the route's own comments) and rebuilds cards with `innerHTML`. | 26:1969–1991; 22_ | Repeated network + DOM churn; mitigated partly by the `knownVersion` protocol, which still costs the server full reads. |
| P-20 | **Large JSON in `localStorage`** read and parsed synchronously on load (lists, channels, presets, tracking caches, airing schedules). | key inventory | Main-thread stalls on load; quota errors for heavy users. |
| P-21 | **Client computes Airing Next** with batched `/api/details/batch` resume rounds and caches schedules in `localStorage`. | 21:3466, 21:3697 | Many requests per refresh; duplicated with the server cron. |
| P-22 | **Poster warm-up requests** (`/api/bp/warm`) for every BetterPosters image on a page, including below the fold. | 25:253–308 | Up to hundreds of server-side fetches triggered by one page view (rate-limited at 800/min/IP). |
| P-23 | **Third-party font and script** requests on the critical path. | 09 | Extra connections before render. |

---

## 3. The 10 most important performance improvements (prioritized)

Priority = impact on users/cost ÷ effort, with correctness fixes first.

| # | Improvement | Fixes | Effort | Expected effect |
|---|---|---|---|---|
| **1** | **Delete KV write-back on reads** (`getCreator`, `getCreatorList`, GET-path visibility stamping) and the `lastgood:`/`trackSharedApiUse` per-request writes (skip when unchanged, or remove). | P-2, P-3, P-4 | **Low (Phase 1)** | Removes ≥1 KV write per authenticated request, 21 per dashboard load, and a KV + D1 write per catalog row request. |
| **2** | **Fix `skip` pagination** for published-list and auto-tracked rows (and `/api/preview`). | §1.4 | **Low (Phase 1)** | Ends duplicate page downloads; makes history beyond 100 items reachable. |
| **3** | **Event-based watch tracking** (`watch_events` + `show_progress`; webhooks enqueue). | P-1, P-16 | High (Phase 3) | One insert per play instead of ~2,000 statements at a 2,000-item history; webhook response in milliseconds. |
| **4** | **Per-show schedules instead of per-account sweeps.** | P-8, P-21 | High (Phase 5) | Freshness independent of user count; TMDB calls ÷ (watchers per show). |
| **5** | **Split the SPA and serve it as static assets** (per-destination chunks, ≤ 200 KB gzip initial, lightweight public pages). | P-15, P-17, P-18, P-12 | Medium–High (Phase 6) | ~10× less JavaScript on first load; faster shared links. |
| **6** | **Cache the add-on profile per colo and compute cross-row dedupe once per profile version**; precompute recommendations in a job. | P-6 | Medium (Phase 3/5) | Removes O(N²) refetch; bounds catalog latency to one source fetch or cache hit per row. |
| **7** | **Provider layer with timeouts, SWR and a normalized `media` table** replacing overlapping caches. | P-9, P-10 | Medium (Phase 4) | Bounded tail latency; fewer provider calls; one invalidation story. |
| **8** | **Directory and search on indexed columns** (`item_count`, `likes_count`, `tsvector`, keyset pagination) with 60 s edge caching of first pages. | P-7, P-13 | Medium (Phase 3) | O(page) queries at any directory size. |
| **9** | **Resource APIs instead of full-state sync**, with `ETag`s and a cheap change feed. | P-5, P-19, P-20 | Medium (Phase 3/6) | Payloads proportional to what changed; no minute-by-minute polling writes. |
| **10** | **Generated artwork to R2** (badges, channel logos, BetterPosters mirror) keyed by content hash, served from a public bucket domain. | P-11, P-22 | Low–Medium (Phase 5) | Image requests never touch the Worker after first generation; no base64 bloat. |

Also worth doing early (small): remove the admin `creator:` key sweep (P-14); bundle or drop `fflate` (P-23); add timeouts to the raw fetches on hot paths (P-9 partial).

---

## 4. Performance budgets for the next version

| Surface | Budget |
|---|---|
| Stremio catalog, shared row, warm | p95 < 50 ms at the edge |
| Stremio catalog, personal row | p95 < 250 ms (one Hyperdrive round trip) |
| Stremio catalog, any row, provider cold | p95 < 1.5 s with SWR; never > provider timeout (8 s) |
| Manifest | p95 < 50 ms (cached by profile version) |
| Webhook / playback ping | < 50 ms response (work is queued) |
| Website initial load | ≤ 200 KB gzip JS, ≤ 40 KB CSS, LCP < 2.5 s on a mid-range phone |
| Website API reads | p95 < 200 ms |
| Directory/search | p95 < 150 ms at 1M public lists |
| Background freshness | new episode visible to every watcher within 24 h of TMDB listing it; charts within their TTL (15 min–6 h by class) |

Measure with Workers Analytics Engine (server timings per route and per provider) and a RUM beacon for web vitals; alert on provider error rates and queue age.
