# Performance audit, with a fix plan (handoff to Sonnet 5.5)

Audited 2026-11-03, read-only. Nothing in `src/` was changed.
Baseline: `node --test tests/load-performance.test.mjs` fails one subtest ("cold catalog p90 must be under 40ms", measured 79.7 ms). PERF-00 explains why: the test times real internet calls, not the Worker. Every other number below was measured with `tests/harness.mjs` (in-memory KV/D1) or with `node --cpu-prof` on the same harness.

## Summary for the owner

The big architecture work from Phase 8 (`docs/PERFORMANCE.md`) holds up: catalog rows touch D1 zero times, the directory pages by cursor, posters and charts are cached. What this audit found is narrower, and mostly the kind of cost that grows with users or with how much someone has watched:

1. **A playback ping does its work three times over** for accounts on the new activity database. It reads the whole watch history twice and rebuilds all progress, then records the play the cheap way. The history comparison is quadratic: 0.2 s of CPU per save at 5,000 plays, 1 s at 10,000 (PERF-01, PERF-02).
2. **The "cheap" once-a-minute sync check is not cheap.** Every open website tab rebuilds the account's entire watch history once a minute just to read one timestamp (PERF-03).
3. **Every catalog row on the shared TMDB key writes to the database** (an "API usage" counter), even when nothing was fetched. Page views do the same. These are the hottest rows in D1 (PERF-04). **Needs one decision from you**, below.
4. **Every page view spends about 4–6 ms of CPU** re-hashing and re-encoding the same 1.6 MB page, even when the browser is told "nothing changed" (PERF-05).
5. Smaller catalog-path waste: an unneeded KV read per row, a linear scan of every chart table per row, and a cache that throws itself away on a big home screen (PERF-07, PERF-08, PERF-09).
6. **The website ships about 550 KB gzip of JavaScript (2.3 MB unzipped) to every visitor**, and `/app.js` has grown 40% since Phase 8, close to its budget. The second bundle has no budget at all (PERF-11).
7. Scalability notes: the old per-account cron sweeps get slower as accounts grow, and some caching is per data center only (PERF-13, PERF-14, PERF-15).

### Decision needed from the owner (PERF-04)
Counters (page views, installs, API usage) are written to the database once per event. Batching them in memory and writing once a minute cuts those writes by roughly 100×. The trade-off: if Cloudflare recycles a server between flushes, up to a minute of counts from that server is lost, so the admin numbers become slightly approximate. **Owner decided (2026-11-03): accept.** Build PERF-04 as written.

## How this audit was done

About 124k lines, so it was not read line by line. I:
1. Read the request entry (`export default` in `26_`), `handleFetch` (`25_`), `withSecurityHeaders`, `instrumentEnv`, `resolveSession`, `resolveConfig`, the whole Stremio catalog route (`70_`), `fetchCatalog`, `enrichCatalogPreviews`, the rate limiter, the stat counters, the provider breaker, the event-tracking shim (`40_`), the playback ping (`63_`), `sync/meta` (`69_`), the cron dispatcher (`45_`) and the legacy sweeps.
2. Measured with the test harness: KV/D1 operations and latency for 20 cold and 20 warm catalog rows; page and asset sizes (raw, gzip, brotli); 304 vs 200 page cost. I CPU-profiled the catalog path and the page path (`node --cpu-prof`).
3. Grepped the SQL for unindexable patterns and checked them against `schema.sql` and `schema_activity.sql`. **No missing index was found on a hot path**: `accounts.username` is `COLLATE NOCASE`, so the `= ? COLLATE NOCASE` lookups are indexed.
4. Grepped the client for polling, scroll/resize listeners and `innerHTML` volume.

Measured baseline (harness, this VM):

| What | Result |
|---|---|
| Catalog row, warm isolate | p50 1.2 ms, 2 KV reads, 0 D1 |
| Catalog row, cold isolate | p50 53 ms. ~50 ms of it is real outbound HTTP to Cinemeta/TMDB (preview enrichment) |
| `GET /` (page served from memory) | 10.6 ms server time; `304 Not Modified`: 4.8 ms |
| HTML page | 416 KB raw / 54 KB gzip, ~3,000 elements |
| `/app.js` | 585 KB raw / 133 KB gzip (`PERFORMANCE.md` says 93 KB; budget 150 KB) |
| `/app-features.js` | 1,749 KB raw / 415 KB gzip, `defer` on every page, no budget |
| `/app.css` | 189 KB raw / 33 KB gzip |
| `saveTrackingRecord` matching loop | 4 ms at 500 plays, 34 ms at 2,000, 227 ms at 5,000, 1,004 ms at 10,000 |

Already covered and **not re-opened**: everything marked Resolved in `docs/PERFORMANCE.md` §3.

## Rules for the implementer

- Follow `CLAUDE.md`. Edit `src/**/NN_*.js`, never `worker_entry_combined.js`, then `python build.py`. No refactors or renames. One finding per commit.
- **Test first** (rule 10): each fix gets a test that fails before the fix and passes after. Wherever possible, assert on **counts** (KV gets, D1 statements, calls to a function), not wall-clock time. Timing is flaky on shared runners (see PERF-00).
- Behaviour must not change. Each finding names the existing tests that guard its behaviour; run them after the fix.
- After each item: `bash verify.sh -q --fast` plus the test files named. Before pushing: `bash verify.sh -q`. Run `python tools/gen_map.py` if functions were added or moved.
- No new bindings, secrets, flags or migrations are needed for anything in Phases 0 to 2.
- Finding IDs are `PERF-nn`. Work in the order in "Fix order". Add one `docs/RELEASES.md` entry at the end, and update `docs/PERFORMANCE.md` §3 (PF-B15 status, new rows for these IDs).

---

## Findings

### PERF-00 (test reliability, do first): the catalog latency test times the internet
**Evidence.** `tests/load-performance.test.mjs:39`. The rows it creates are custom lists of `tt` ids, so `enrichCatalogPreviews` (`src/catalog/05_catalog-core.js:2578`) calls `catalogPreviewMeta`, which `fetch`es `v3-cinemeta.strem.io` and `api.themoviedb.org` for every title. The harness does not stub `fetch`, so the cold pass measures this VM's internet connection. The CPU profile shows ~50 ms of the 53 ms cold p50 inside `httpNetworkFetch`/TLS. The handoff's "existing cold-catalog budget" failure is this.

**Fix.** In that test only, replace `globalThis.fetch` for the catalog subtest with a stub that answers Cinemeta/TMDB URLs instantly (404 is fine: the code handles a miss). Restore it in `finally`. Keep the 40 ms / 10 ms budgets and the op-count asserts exactly as they are. This removes a dependency the test never meant to have; it does not loosen it. Say so in the commit message (CLAUDE.md rule 6).

**Check.** `node --test tests/load-performance.test.mjs` passes 3/3, run three times.

---

### PERF-01 (High, runtime): `saveTrackingRecord` compares watch history in O(n²)
**Evidence.** `src/data/40_event-tracking.js:188`. For every incoming history item it runs `unmatchedStored.findIndex(...)` (lines 210 and 212) and `splice` over all stored rows. Measured: 227 ms of CPU at 5,000 plays, 1 s at 10,000. It runs on **every** write of `creatorsynctracking:<user>` for an account on the activity database: website saves, every playback ping (PERF-02), every webhook.

**Fix.** Build the stored rows once into `Map<legacy_id, row[]>`. For each incoming item, take the row whose `watched_at` equals the item's `watchedAt` if there is one, otherwise the first row for that id, and remove it from that id's array. This is the same first-match rule as today, in O(n). `known` and `fresh` stay as they are.

**Test.** Unit-level (see how `tests/activity.test.mjs` loads the activity functions): (a) the same plays are inserted and the same ids deleted on an intentional removal as before, including duplicate `legacy_id` rows with different `watched_at`. (b) A count-based guard: with 3,000 stored rows the matching calls the row comparator at most ~2×3,000 times (wrap the comparison, or assert completion under a generous CPU budget only if a count is impossible).
**Guards.** `tests/activity.test.mjs` (P3c-6 suite), `tests/continue-watching-parity.test.mjs`.
**Risk.** Low. Pure algorithm change.

---

### PERF-02 (High, runtime + database): a playback ping reads the whole history twice, then rebuilds it
**Evidence.** `writeSubtitlesPlayRecord`, `src/api/63_subtitles-track.js:313`. For an account on the activity database (`eventTrackingOwns` ≠ null), the `env.CONFIGS` it sees is the shim from `eventTrackingEnv` (`40_event-tracking.js:259`). So:
1. `readCreatorTrackingD1` (legacy D1 read).
2. `env.CONFIGS.get(syncKey)` → `assembleTrackingRecord` (`40_:125`): **all** watch events (paged `watchHistoryAll`), plus Continue Watching and Airing Next.
3. `env.CONFIGS.get(syncKey)` again for the race check: **the whole assembly again**.
4. `env.CONFIGS.put(syncKey, …)` → `saveTrackingRecord`: reads **all** events again, the O(n²) match (PERF-01), inserts, then `rebuildActivityProgress` for the whole account.
5. `saveCreatorTrackingD1`, then `recordActivityPlay` (`38_activity-scrobble.js`): the 1–4 targeted writes that are actually the point, then the scrobble queue.

The media-server webhook (`src/api/64_media-server-scrobble.js:411`, `:513`) has the same read-modify-write shape. The scrobble burst test passes only because its accounts have almost no history.

**Fix (two commits).**
1. First, a **measuring test**: an activity-database account with ~500 plays (reuse `eventTrackingSetup` in `tests/activity.test.mjs` and seed more), one `/subtitles/` ping. Count `DB_ACTIVITY` statements and `watch_events` full reads. Record the current numbers in the test as the "before" (skip-asserted) and the target as the assert.
2. For accounts where `eventTrackingOwns(env, username) != null`: skip the blob round trip (steps 1–4). Call `recordActivityPlay` directly, then apply the Watchlist removal the blob path did (`blob.watchlist` filter → the v2 watchlist list) and the scrobble queue step if it still applies. The legacy path for accounts not yet copied stays exactly as it is.

**Must stay true** (check each with a test): the play shows in Watch History, Continue Watching moves on, a watched title leaves the Watchlist, a duplicate ping within ten minutes is one play, and nothing is written to the legacy tracking stores (`legacyTrackingStores` helper in `activity.test.mjs`).
**Guards.** `tests/activity.test.mjs`, `tests/continue-watching-parity.test.mjs`, `tests/live-rows-stay-live.test.mjs`, the scrobble tests (`grep -l scrobble tests/*.mjs`).
**Risk.** Medium. This is the most behaviour-sensitive item. Do it after PERF-01 and keep the commit to the ping path; the webhook is a separate commit.

---

### PERF-03 (High, database + network): `sync/meta` rebuilds the whole tracking record once a minute per open tab
**Evidence.** `creatorApiSyncMeta`, `src/api/69_creator-api-sync-routes.js:145`. The client polls it every 60 s while a tab is visible, and on focus and pageshow (`src/client/22_client-creator-profile.js:7062`). The comment says it exists to be "a few dozen bytes" instead of `sync/load`. But line 204 reads `creatorsynctracking:<user>`, which for an activity-database account goes through the shim, so it runs the full `assembleTrackingRecord` (all plays plus both shelves) just so `readUpdatedAtFromRaw` can find one number.

**Fix.** For accounts on the activity database, take the record-level `updatedAt` from `readTrackingSettings(env, accountId).tracking` (this is the `rest` that `assembleTrackingRecord` spreads first), without assembling. Add one small helper in `40_event-tracking.js` (e.g. `trackingUpdatedAtFor(env, username)` that returns `null` when the account is not on the activity database), and fall back to today's read when it returns `null`.

**Watch out.** `readUpdatedAtFromRaw` takes the **last** `"updatedAt":` in the string. On an assembled record that can be a field of a Continue Watching item rather than the record's own stamp. Before changing anything, check what the client compares this value against (`handleForegroundResumeSync`, `22_client-creator-profile.js:6942`). Make sure the new value changes whenever the old one would have on a real save, i.e. the record's own `updatedAt` is bumped by every tracking write. If an item-level timestamp was what made some change visible, report it rather than guessing.
**Test.** On an activity-database account, `POST /api/creator/sync/meta` makes **zero** `watch_events` reads, and its tracking stamp changes after a `save-tracking` and after a ping.
**Guards.** `tests/activity.test.mjs`, the sync tests (`grep -l "sync/meta" tests/*.mjs`).
**Risk.** Low-medium.

---

### PERF-04 (High, database; **owner accepted batching, 2026-11-03**): stat counters are two D1 writes per event, on the same two rows
**Evidence.** `bumpStat`/`bumpStatBy` (`src/admin/03_admin.js:85`, `:127`): one batch of two upserts (`total` and today's row). This is PF-B15 in `docs/PERFORMANCE.md`, still open. Hottest callers:
- `trackSharedApiUse` (`src/catalog/05_catalog-core.js:148`, called at `:169`) runs on **every catalog row** whose source uses the site's shared key. It runs *before* the snapshot and caches are checked, so it counts row requests, not API calls, and writes D1 even when nothing was fetched.
- `pageviews` on every page route (`80_`, `70_`, `73_`).
All of these upsert `stats(kind,'total')`, a single hot row that every request contends on at the single D1 primary.

**Fix (owner accepted the trade-off on 2026-11-03).** In `03_admin.js`, add an in-isolate accumulator, `Map<kind, {total, byDay}>`. `bumpStat`/`bumpStatBy` add to it and schedule a flush through the request's `ctx.waitUntil` when the oldest unflushed bump is older than ~60 s or the map passes ~50 kinds. The flush is one `env.DB.batch` of the same upsert, with `n = n + excluded.n`. The KV-only (no D1) path and the `sourcegroup:` branch keep their current behaviour. `bumpStat` gets no `ctx` today: thread the flush through the existing `ctx.waitUntil(bumpStat(...))` call sites by having `bumpStat` return the flush promise when one is due (no call-site changes), or add a module-level `pendingStatFlush` that `export default.fetch` hands to `ctx.waitUntil`. Pick the smaller diff and say which you chose.
**Do not** change what `apiuse:*` means in this commit. Counting real outbound calls instead is a product change. Note it for the owner.
**Test.** 100 bumps within one minute → 1 batch; the totals read back by the admin stats are exactly 100 after a flush; a day boundary (Eastern) splits into two day rows (use the `Date.now` seam the DST tests use, `tests/dst-days-ago.test.mjs`).
**Guards.** `tests/analytics-engine-stats.test.mjs`, the admin stats tests (`grep -l "statsToday\|bumpStat\|pageviews" tests/*.mjs`).
**Risk.** Medium (counter accuracy, as described).

---

### PERF-05 (High, runtime/startup): every page view re-hashes the 1.6 MB page, 304s included
**Evidence.** `htmlPageResponse` (`src/core/02_http-and-creator-utils.js:2578`) → `pageWithExternalBundle` → `splitPageMemoKey` (`:2549`). That runs an FNV loop over every character of the full, unsplit HTML (~1.6 MB) on every request to `/`, the shell paths and the sub-tabs, before it can look up the memo. Profile: `splitPageMemoKey` was the #1 self-time function, 2.6 s over 600 page requests (≈4.4 ms each). It is most of the 4.8 ms a `304` costs.

**Fix.** `renderBuilderCached` (`:2363`) already returns the *same string object* for the default page. Remember the last few `{ html, page }` pairs and compare `html === entry.html` before hashing (identical object: O(1)). Fall back to the hash only on a miss. Keep `htmlEtagFor`'s memo as it is.
**Test.** Two `GET /` in a row call `splitPageMemoKey` once (expose a call counter the way other unit tests reach internals, e.g. `tests/helpers-unit.test.mjs`); the body and ETag are byte-identical to today's.
**Guards.** `tests/app-shell*.test.mjs`, `tests/csp.test.mjs`, `tests/bundle-budget.test.mjs`.
**Risk.** Low.

### PERF-06 (Medium, runtime): the page is decoded and re-encoded on every 200 just to insert the nonce
**Evidence.** `withSecurityHeaders` (`02_:344`) does `await response.text()` on every HTML response, then `split(CSP_NONCE_PLACEHOLDER).join(nonce)`. In the profile this was `decode`/`encode`/`withSecurityHeaders`, ≈1.5 ms per 200 for the 416 KB page.
**Fix (optional, after PERF-05).** In `htmlPageResponse`, keep the memoized page pre-split on `CSP_NONCE_PLACEHOLDER` and mark the response (e.g. a private symbol or header that `withSecurityHeaders` strips) so the wrapper joins the parts with the nonce without reading the stream. The nonce must still be fresh per response.
**Test.** Two responses carry different nonces in both the CSP header and every inline `<script>`/`<style>`; `tests/csp.test.mjs` passes.
**Risk.** Low-medium. Skip it if the diff is not small.

---

### PERF-07 (Medium, runtime): every catalog row scans every chart table, 4–5 regexes per item
**Evidence.** `stremioCatalogRow` (`src/api/70_stremio-routes.js:217`) calls `findChartOrCollectionEntry` (`src/catalog/08_quickadd-chart-data.js:1019`) on **every** row request, before the install config is read. When the id is not a chart (every custom list, every Creator list), it walks all eleven tables and `CHART_SLUG_ENTRIES`, calling the regex-based `slugifyServer` 4–5 times per item. `70_:249` repeats the `CHART_SLUG_ENTRIES` scan. `slugifyServer` was a top-5 self-time function in the catalog profile.
**Fix (two commits).**
1. In `70_`, call `findChartOrCollectionEntry` only when it can matter: when there is no `config`, or when the row is not in `entries` (`entryIndex < 0`). The code at `:241` already does that second call, so the one at `:217` is needed only for the `!config` case.
2. Inside `findChartOrCollectionEntry`: build, once per isolate and lazily, a `Map` from `type + ":" + slug` to the result, iterating the tables **in the same order** and keeping the first match. That keeps today's precedence. Keep the earlier steps of the function (before "2. Search against all known tables") untouched.
**Test.** A golden test: for every item in every table and both types, the indexed lookup returns exactly what the old linear scan returned (keep a copy of the old scan inside the test as the oracle). Plus: a configured custom-list row does not call `slugifyServer` at all.
**Guards.** `tests/load-performance.test.mjs`, the chart/catalog tests (`grep -l findChartOrCollectionEntry tests/*.mjs`).
**Risk.** Low.

### PERF-08 (Medium, network): an unneeded KV read on every configured catalog row
**Evidence.** `70_stremio-routes.js:219-222`: when `findChartOrCollectionEntry` misses, it reads `col_cat:<id>:<type>` from KV **before** `resolveConfig`. This happens even when the config contains the row (the harness logged `col_cat:rowN:movie` before `cfg:…` for every row). `:243-246` already reads the same key later when the row is not in the config. So for a configured install the first read is pure waste: one serial KV round trip per row, and a cold KV read is the dominant latency in the budget table.
**Fix.** Do the first `col_cat:` read only when `!config` (folds into PERF-07 step 1: move both lookups behind the same condition).
**Test.** A configured custom-list row: no KV `get` whose key starts with `col_cat:`. An unconfigured collection URL (`/catalog/<type>/<id>.json` with a `col_cat:` key present) still serves its row.
**Risk.** Low.

### PERF-09 (Medium, caching): the per-user provider cache is FIFO, and catalog previews flood it
**Evidence.** `PER_USER_CACHE_MAP` (`02_:2617`) holds at most 1,000 entries and evicts in **insertion** order (`getPerUserCache` does not refresh recency, so the "LRU" comment is wrong). `catalogPreviewMeta` (`05_:2500`) stores one entry per title there (`catalog-preview:v3:…`). One cold 20-row home screen inserts ≥1,000 previews, which evicts every user's cached provider responses (`user_cache:*`, stale-if-error copies) and the previews themselves. Hit rates collapse exactly when traffic is high.
**Fix.** Give previews their own bounded `Map` (they are small; ~5,000 entries is fine) using the same get/set shape. Make both caches true LRU: on a fresh hit, `delete` and re-`set` the key. Do not change TTLs.
**Test.** After 2,000 preview inserts, a `user_cache:` entry set before them is still returned; after 1,001 provider-cache inserts with the first one read in between, that first one survives.
**Risk.** Low.

---

### PERF-10 (Medium, network/scalability; measure first): cold preview enrichment is 1–3 outbound calls per title
**Evidence.** `enrichCatalogPreviews` (`05_:2578`) fetches Cinemeta per title (concurrency 8, 4 s deadline). On a miss it fetches TMDB `/find` and then TMDB details. The cache is per isolate only (`getPerUserCache`), so every new isolate in every data center starts cold. Each title is a Workers subrequest, and a row page can hold up to 100 titles, against Cloudflare's per-invocation subrequest limit. `cf.cacheEverything` makes the outbound calls cheap, but not free and not uncounted.
**Recommendation.** Do not change it blind. First add a counter (to the existing per-request metrics in `writeRequestMetrics`, `02_:606`) for preview fetches per request. After a week, if p95 is high, persist previews where the next isolate can reuse them (Cache API keyed by title, or a column on the `media` table), and bring the result back to the owner.

### PERF-11 (Medium, network/rendering): 550 KB gzip of JavaScript on every visit; the second bundle has no budget
**Evidence.** `/app-features.js` (1,749 KB raw / 415 KB gzip) is a `<script defer>` on every page (`02_:2485`). Deferred scripts still download, parse and run before `DOMContentLoaded`. `/app.js` is 133 KB gzip, up from the 93 KB recorded in `docs/PERFORMANCE.md`, against a 150 KB budget. `tools/check_bundle_budget.mjs` and `tests/bundle-budget.test.mjs` check `/app.js` only. The fflate vendor file (32 KB) also loads on every page; check whether only backup/restore uses it.
**Fix, step 1 (do now).** Add a ratchet like `tests/size-budget.json`: record today's gzip sizes of `/app.js`, `/app-features.js`, `/app.css` and the HTML. Fail if one grows more than ~2% over its baseline, with an `--update` that may only lower the numbers. Same rules as rule 12.
**Step 2 (plan first, separate PR).** Load `/app-features.js` on demand: on first use of a feature in it, or after `load` via `requestIdleCallback`. The risk is inline handlers or early calls that reach a function defined only in the features bundle. Before changing anything, list every global the features bundle defines and every place `app.js` or the HTML calls one. Bring that list back; do not ship step 2 without it.
**Guards.** `tests/bundle-budget.test.mjs`, `tests/app-shell*.test.mjs`, `node tests/ui-contract.mjs` (needs Playwright, preinstalled in this environment).

### PERF-12 (Low, runtime): `easternDateKey` builds a new `Intl.DateTimeFormat` every call
**Evidence.** `src/admin/03_admin.js:17`. Called by every `bumpStat` (`statsToday`), `getDailySeed` (the daily shuffle), and the Most Watched snapshot. A top self-time function in both profiles.
**Fix.** Create the formatter once, lazily, at module scope, and reuse it. Same options.
**Test.** `tests/dst-days-ago.test.mjs` passes unchanged; a unit test checks the key around both 2026 DST changes.
**Risk.** None.

### PERF-13 (Medium, scalability; ops check, then decide): the legacy cron sweeps walk every account
**Evidence.** `checkForNewEpisodes` and `refreshAiringNextSweep` (`src/catalog/07_source-fetchers-tmdb-simkl.js:4858`, `:4774`) page through **all** `creator:` KV keys, 25 per tick (every 4 min, `LEGACY_CRON_EVERY_MS`). For each account they read KV/D1 just to learn they should skip it (`legacyShelfSweepSkips` → `eventTrackingOwns`). Airing Next rebuilds at most 3 accounts per tick (`AIRING_NEXT_SWEEP_ACCOUNTS_PER_TICK`). At 10,000 accounts, one full pass is ~400 ticks (~27 hours), mostly spent skipping accounts the newer `show.refresh` job already serves.
**Recommendation.** Ops check first: is `FF_SHOW_SCHEDULE` on in production, and does `/admin` → activity backfill show every account copied? If both are yes, the owner can retire these two periodic jobs (`cron.episodes`, `cron.airing-next` in `45_jobs-dispatcher.js:574`). That is a product step: ask, don't do it. If not, the cheap fix is to sweep from a D1 query of accounts **not** on the activity database instead of listing KV.

### PERF-14 (Low, scalability; watch only): rate limiting is a D1 write on the primary per limited request
**Evidence.** `consumeRateLimit` → `d1RateLimitCount` (`02_:3238`): one write batch per call, always to the single D1 primary, on ~30 routes including the Stremio search catalogs and the lookup APIs. Correct (atomic) and fine at today's traffic.
**Recommendation.** No change now. If the request metrics show D1 write latency on those routes, Cloudflare's Rate Limiting binding is the drop-in alternative (eventually consistent per data center, which the code comment says the WAF rules already cover).

### PERF-15 (Medium, caching; measure first): shared catalog rows are not cached at the edge
**Evidence.** Shared rows answer `Cache-Control: public, max-age=1800, s-maxage=1800` (`70_:385`). A Worker runs **in front of** Cloudflare's cache, so its own responses are not cached by the CDN, and `s-maxage` has no effect there. Each repeat request re-runs `resolveConfig`, `fetchCatalog` and `enrichCatalogPreviews`. Stremio honours `cacheMaxAge` itself; whether Nuvio and wako do is unknown.
**Recommendation.** Use the existing Analytics Engine metrics (`routeFamily` = `stremio:catalog`) to see how often the same install asks for the same row within 30 minutes. If it is common, wrap the shared-row branch (not `isUserPersonal`, not `isLiveCustomList`, `skip`/search included in the key) in `caches.default.match/put` keyed by the full request URL. The config segment is in the URL, so entries are per install and safe. Not before measuring.

### PERF-16 (Low-medium, database): a track-on legacy link re-verifies its owner on every row
**Evidence.** `resolveConfig` (`src/core/04_config-resolution.js:30`) → `verifyShelfOwner` (`02_:5428`) on every catalog row for configs carrying `trackCreatorKey`:
- a KV tombstone read, plus a D1 tombstone query whenever KV has none (the normal case, `isCreatorTombstoned`, `02_:4682`);
- `getCreator`'s `SELECT * FROM creators` (including `share_json`).

Only the PBKDF2 step is memoized. `getCreator` also mirrors to KV whenever `last_active` changed, so an active account rewrites `creator:<u>` about once per activity bump (`mirrorCreatorToKv`, `02_:5234`).
**Fix.** Memoize `verifyShelfOwner`'s result per `(creatorName, creatorKey)` for **10 s**, the same window as `SESSION_CACHE` (audit SESS-001 chose that for revocation), bounded like `SESSION_CACHE`. Leave the `getCreator` mirroring alone in this change.
**Test.** 20 rows of one track-on legacy link → `creators`/`creator_tombstones` queried once; after `Date.now` moves 11 s, queried again; a tombstoned account stops verifying within 10 s.
**Guards.** `tests/security-suite.test.mjs`, `tests/session-*.test.mjs`.

---

## Coverage by audit type

| Audit | Findings |
|---|---|
| Runtime performance | PERF-01, 02, 05, 06, 07, 12 |
| Database performance | PERF-02, 03, 04, 16; no missing hot-path index found |
| Memory performance | PERF-09; the other isolate caches are bounded (`BADGED_POSTER_CACHE` by bytes, `SESSION_CACHE`, `RATE_LIMIT_MEMO`, `CREATOR_KV_MIRROR`) |
| Network performance | PERF-03, 08, 10, 11 |
| Startup performance | PERF-05 (first byte of every page); PERF-11 (client start) |
| Rendering performance | PERF-11; client polling is already throttled (60 s, visibility-gated, debounced); the list-details scroll handler reads `scrollHeight` each event (`23_:3912`): low, use an `IntersectionObserver` sentinel if touched for other reasons |
| Caching | PERF-09, 10, 15, 16 |
| Scalability | PERF-01, 02, 04, 13, 14 |

## Fix order

**Phase 0:** PERF-00 (a green baseline).
**Phase 1, low risk, one commit each:** PERF-12 → PERF-05 → PERF-08 + PERF-07 step 1 → PERF-07 step 2 → PERF-09 → PERF-01 → PERF-11 step 1.
**Phase 2:** PERF-03 → PERF-16 → PERF-06 (optional) → PERF-04.
**Phase 3, behaviour-sensitive, separate PR:** PERF-02 (ping, then webhook).
**Report back, do not build:** PERF-10, PERF-11 step 2, PERF-13, PERF-14, PERF-15. Each needs a measurement or an owner decision first; write what you found in `docs/HANDOFF.md`.

After each phase: `bash verify.sh -q`, then re-run the measurements in "Measured baseline" and put the new numbers in the PR description.
