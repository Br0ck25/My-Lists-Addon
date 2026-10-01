# Backend Audit

**Date:** 2026-09-25 · **Scope:** `00_`–`08_`, `25_`, `26_` (server), `schema.sql`, `migrations/`, `tests/`, CI · **Status:** findings only; nothing changed.

**Method:**

- Direct source reading and targeted searches.
- The full test suite (1,212 tests: 1,211 pass, 1 skipped).
- The real Worker run locally through `audit/frontend-2026-09-13/server.mjs`.
- Platform limits checked against Cloudflare's documentation (2026-09-25).

Every finding cites `file:line`. Line numbers refer to the numbered sources, not the combined file.

**Severity scale:**

| Severity | Meaning |
|---|---|
| **Critical** | Architectural fault that causes or permits data loss or incorrect data at scale; blocks the next version. |
| **High** | A live defect or a scale wall. |
| **Medium** | Correctness or reliability risk with a narrower blast radius. |
| **Low** | Minor defect. |
| **Cleanup** | Dead code, duplication, hygiene. |

Security-specific findings are in `SECURITY_AUDIT.md`; this document cross-references them.

---

## Critical

### BE-C1 — Two stores both claim authority, and the code reconciles them on the read path

- **Current.** The code and its comments contradict each other about which store is the truth:
  - `wrangler.toml:18-21`: "D1 is the primary authoritative store."
  - `02_:3471-3494`, directly above `getCreator`: "D1 is an optional accelerator in front of KV… **KV IS READ FIRST**". Two paragraphs later: "D1 is the authoritative store for creator identities when bound." The code reads D1 first.
  - `02_:2329-2331` (`deleteCreatorLists`): "KV is the authoritative store and the one every public read path uses."
  - `26_:2339-2341` (`/api/creator/lists/save`): "the public read paths (/lists/:user/:slug, the directory, search) all read KV". But the directory (`getPublicListIndex`, `02_:2630`) and search (`26_:4297`) read D1.
  - `25_:7242-7244` (`/api/lists/like`): "KV above holds the authoritative count". Meanwhile `02_:1857-1859` says "list_likes is authoritative".

  To cope, reads merge the two stores:
  - `getCreatorList` (`02_:3813-3889`) reads both, takes whichever fields are "fresher" by `updatedAt`, sets `likes = max(D1, KV)`, repairs D1 fire-and-forget, and writes KV on every read.
  - `readCreatorTrackingD1` (`02_:4639-4825`) serves KV and triggers a full repair if KV's stamp is newer.
  - `readAccountWatchlist` (`02_:4575-4605`) picks the newest of three copies.
- **Problem:**
  - Which store answers depends on the route. `fetchPublishedListCatalog` (`05_:2383`) and `fetchCustomListCatalog` (`05_:1549`) read **only KV**. The directory reads **only D1**. The dashboard reads the merge.
  - A write that lands in one store but not the other produces different answers on different surfaces.
  - `max()` on likes means a stale high count can never come down.
  - The design has produced a series of audit fixes (tombstones, stamps, "behind" markers, rescue merges), each of which adds more reconciliation code.
- **Proposed.** D1 is the only authority. KV holds TTL'd derived caches keyed by version, and is never merged (NEXT_VERSION_ARCHITECTURE §4.2).
- **Benefit.** Removes a whole class of silent divergence, and roughly 3,000 lines of reconciliation, repair and fallback code.
- **Risk.** Backfill correctness: needs a one-time reconciliation with a newest-wins rule and a verification report (MIGRATION_PLAN §2.4).

### BE-C2 — Watch tracking is a whole-document read-modify-write from four writers

- **Current.** Four writers share one tracking document:
  - the browser's `/api/creator/sync/save-tracking` (`26_:3133`);
  - Stremio playback pings (`handleSubtitlesTrack`, `26_:155-540`);
  - media-server webhooks (`handleMediaServerScrobble`, `26_:548`);
  - the Continue Watching and Airing Next crons (`07_:4765`, `07_:4680`).

  Each one reads the whole `creatorsynctracking:{u}` document (up to 24 MB, per the prior audit) and edits it in memory. It then emulates compare-and-swap by re-reading and comparing strings, with up to 3 attempts (`26_:320-472`). Finally it writes the whole document to KV and calls `saveCreatorTrackingD1`. That function upserts **every** watch-history row, continue-watching row, airing-next row and show-state row in chunks of 80 statements. The chunks are not atomic (`02_:4524-4547`).

  A second KV key, `creatorscrobblequeue:{u}`, exists only because a scrobble written in one colo is not visible from another for up to 60 s (`26_:429-469`).
- **Problem:**
  - **Cost scales with history size.** Measured in the repo harness for an account with 3,000 watch-history items:
    - **one** Stremio playback ping (`/{cfg}/subtitles/...`) issued **3,025 D1 statements in 42 batches** and wrote **about 496 KB to KV**;
    - one browser `save-tracking` issued 3,008 statements in 38 batches.

    That is more statements than D1's 1,000-queries-per-invocation limit. The code's own comment anticipates hitting "the per-request operation cap on an account with a long Watch History" (`02_:4534-4536`).
  - **Lost updates.** KV has no compare-and-swap, so the emulation narrows the race window but does not close it.
  - **Partial writes.** A failed chunk leaves D1 partially updated, which is why `trackingd1behind:` exists (`02_:4196-4244`).
  - **Playback is recorded as "watched" at playback start.** The subtitles request fires when a video starts (`05_:20-33`, `26_:116-126`).
  - **Stored data is corrupted to fit the schema.** Companion metadata is packed as `COMPANION:<json>` into `continue_watching.show_title` (`02_:4428-4441`), and decoded in two places.
- **Proposed.**
  - Event rows: a scrobble becomes `INSERT watch_events` plus `UPSERT show_progress` in one batch in `DB_ACTIVITY`.
  - Continue Watching and Airing Next are computed at read time from shared `show_schedule`.
  - Scrobbles go through a Queue, so the webhook responds in milliseconds.
  - Browser edits become item-level API calls.
- **Benefit.** O(1) writes, no lost updates, no mirror, no markers, and history is no longer bounded by blob size.
- **Risk.** A data-model migration; backfill from both the KV blob and the D1 rows using newest-wins (MIGRATION_PLAN Phase 3).

### BE-C3 — Per-user cron sweeps cannot keep up beyond a few thousand accounts

- **Current.**
  - `checkForNewEpisodes` (`07_:4765-5052`) lists 25 `creator:` KV keys per tick. It processes at most one page and up to 150 show checks per tick, every 6 minutes, and calls TMDB **per user per show** for the next episode.
  - `refreshAiringNextSweep` (`07_:4680-4763`) rebuilds 3 accounts per tick (`AIRING_NEXT_SWEEP_ACCOUNTS_PER_TICK`, `00_:1247`).
- **Problem.** Per-account cycle time grows linearly with accounts:

  | Accounts | Continue Watching cycle | Airing Next cycle |
  |---|---|---|
  | 1,000 | about 4 h | about 33 h |
  | 10,000 | about 1.7 days | about 14 days |
  | 100,000 | about 17 days | about 139 days |

  Most TMDB calls re-ask the same question ("what's the next episode of show X?") for every user watching X. The browser also rebuilds Airing Next per device (`21_` `refreshAiringNext`), so there are two implementations to keep in agreement.
- **Proposed.** A show-centric `show_schedule` refreshed once per show by queue jobs, with the check frequency set by show status. Per-user shelves are a read-time join (NEXT_VERSION_ARCHITECTURE §5).
- **Benefit.**
  - Freshness becomes independent of user count.
  - TMDB calls scale with distinct active shows (tens of thousands), not users × shows.
  - One implementation.
- **Risk.** Shelf ordering and edge cases (dismissals, companions, finale badges) must match; shadow-compare before switching (MIGRATION_PLAN 5.3).

### BE-C4 — Install configs are immutable, unowned, secret-bearing, and never deleted

- **Current.**
  - `/api/save` (`25_:6942-7119`) mints a **new** 12-character id on every "Generate/Update Link" and writes `cfg:{id}` to KV permanently (no TTL, no owner index, no delete path).
  - The record carries provider API keys, OAuth access tokens, and the Creator Key itself (`trackCreatorKey`, `25_:7048-7055`).
  - Channel and custom-list payloads are embedded in `entry.url` (up to `SAVED_CONFIG_BYTES_MAX = 10 MB`, `00_:61`).
  - The guide tells users to reinstall after every change (`24_` FAQ, visible in the running app).
- **Problem:**
  - Every settings change requires a reinstall in every app, which is the biggest UX tax.
  - Each regeneration leaves an orphaned copy of the user's credentials in KV forever.
  - Tokens copied into configs can't be refreshed or revoked centrally.
  - `resolveConfig` re-reads the owner's full tracking blob on every catalog request (`04_:79-98`) and is called 2–3 times per request (BE-H04).
- **Proposed.**
  - D1 `installs` with a stable bearer token, versioned `config_json` without secrets, an owner and revocation.
  - Provider credentials live in `provider_connections`.
  - Rows reference entities by id.
  - Legacy ids map to installs on first use (MIGRATION_PLAN §3.2).
- **Benefit.** Changes are live, no reinstalls, secrets live in one place, storage stays bounded.
- **Risk.** Must keep every existing URL working; handled by the legacy resolver.

---

## High

### BE-H01 — `attachEventMeta` exceeds D1's 100 bound-parameter limit; the error is swallowed

- **Where.** `03_admin.js:618-657`. `computeLeaderboard` (`03_:693-818`) passes up to `CANDIDATE_CAP = 400` ids (`03_:703`), which are bound as `event_type = ? AND item_id IN (?, …)`: 401 parameters.
- **Problem.**
  - D1 allows **100** bound parameters per query. The query throws, the `catch {}` at `03_:632` swallows it, and each id falls back to an individual KV `get` of `evtmeta:` (up to 400 KV reads).
  - This path serves the admin Trending tab **and the public "Most Watched" catalog rows** (`buildMostWatchedMetas`, `07_:3192`).
  - The test harness uses `node:sqlite` (limit 32,766), so CI cannot see it.
  - Other IN-clauses in the code already chunk at 90 (`07_:2105`).
- **Fix.** Chunk into groups of 90. Longer term, the `media` table replaces `event_meta`.
- **Also:** add a harness guard that throws on more than 100 bound parameters, matching D1 (TESTING T-02).

### BE-H02 — Possible cross-user leak through edge-caching authenticated Trakt calls

See `SECURITY_AUDIT.md` S-03.

- **Where.**
  - `fetchTraktWithRetry("https://api.trakt.tv/users/me/watched/shows?extended=noseasons", { headers: {Authorization: Bearer …}, cf: { cacheTtl: 60, cacheEverything: false } })` appears at `06_:910`, `06_:914`, `06_:1245`, `25_:5585`, `25_:5821` and `25_:5831`.
  - `users/me/watchlist/shows?limit=50` has the same shape.
- **Problem.** Cloudflare documents that `cacheTtl` "forces Cloudflare to cache the response for this request, regardless of what headers are seen on the response". The cache key defaults to the URL, and the Bearer token is not part of it. Two users in the same colo within 60 s may receive each other's watched shows and watchlist.
- **Fix.** Never set `cacheTtl` on a credentialed request (`cf: { cacheTtl: 0 }` or `cache: 'no-store'`). Audit all 140 `cacheTtl` sites; the MDBList ones include the key in the URL and are keyed per user.
- **Verification.** Two test accounts, same colo, alternating requests; compare the payloads.

### BE-H03 — "Remove duplicates across lists" makes every catalog request refetch every earlier row (O(N²))

- **Where.** `dedupeAcrossListEntries` (`05_:294-329`), called from the catalog route (`25_:1015-1017`).
- **Problem.**
  - When serving row k, the code calls `fetchCatalog` for every earlier enabled row of the same type. A 20-row home screen triggers 190 extra `fetchCatalog` calls.
  - Measured in the repo harness (20 distinct MDBList rows, dedupe on):
    - **One warm isolate** absorbs the fan-out through its in-memory cache: 20 upstream calls, 40 KV reads.
    - **Rows served by different isolates**, which is normal when Stremio requests rows in parallel across the edge: **230 KV reads** (20 + Σk), quadratic in the number of rows.
  - Each extra read also parses the cached row, and once the 60 s fresh TTL has passed it can go to the provider.
  - The same run showed **20 `lastgood:` KV writes per home-screen load** (FT-25).
- **Fix.** A per-install materialization of page 0, computed once per `(install, version)` and cached (NEXT_VERSION_ARCHITECTURE §3.2 step 4). Interim fix: cache each earlier row's id-set for the same `(config, skip)` in the isolate for 60 s.

### BE-H04 — `resolveConfig` reads the whole tracking blob per catalog request, 2–3 times

- **Where.**
  - `resolveConfig` (`04_:23-156`) reads `creatorsynctracking:{owner}` whenever the config names a verified owner. It does this even for rows that are not personal shelves.
  - It is called by the catalog route (`25_:981`).
  - It is called **again** inside `fetchAutoTrackedCatalog` (`05_:1960-1968`) and `fetchCuratedCatalog` (`05_:1828-1833`). `fetchCuratedCatalog` also reads the blob itself (`05_:1837`).
- **Problem.** Megabytes of KV read and JSON parsing per Stremio row request, multiplied by the number of rows.
- **Fix.**
  - Pass the resolved config down instead of resolving again.
  - Remove the tracking merge from `resolveConfig`.
  - In v2, install snapshots contain no user data.

### BE-H05 — KV write amplification on hot read paths

- **Where:**
  - `getCreator` writes `creator:{u}` on every D1 hit (`02_:3516-3522`). It runs on **every authenticated request**, including the 60 s `/sync/meta` poll from every open tab (`22_:6583-6591`).
  - `getCreatorList` writes KV on every read where D1 wins (`02_:3868-3873`).
  - The catalog route writes `lastgood:` on every successful first page (`25_:1022-1027`).
  - `stampListVisibilityIfNeeded` writes on legacy records during public reads (`02_:847-859`).
  - Rate limiting writes on every limited request.
- **Problem.**
  - Cost: KV writes are billed per write on Paid.
  - KV allows about 1 write per second per key. Concurrent polls from several tabs of one account collide, and the failures are swallowed.
  - Hot-path latency.
- **Fix.** Delete the write-throughs (FT-25, FT-27). Sessions remove the per-request identity read.

### BE-H06 — Likes: O(voters) work per like, a 5,000 cap, and whole-record rewrites

- **Where.** `applyLikeVote` (`02_:1863-1960`), `/api/lists/like` (`25_:7139-7250`).
- **Problem:**
  - Every like reads the full voter set.
  - It writes the whole array back to KV (up to 5,000 ids).
  - It seeds D1 from KV when D1 has zero rows, which can resurrect voters from a stale KV edge read after the last unlike.
  - It counts, then re-reads and rewrites the **entire list record** (items included) in KV to update one field.
  - `LIKE_VOTER_CAP = 5000` (`02_:1625`) is a hard ceiling on a public list's popularity.
- **Fix.** A `likes` table with `INSERT OR IGNORE` / `DELETE`, plus `like_count` maintained in the same batch.

### BE-H07 — List order and the channel directory lose updates

- **Where:**
  - `creatorlistorder:{u}` read-modify-write (`26_:2154-2160`, `2360-2407`). The code comment says: "Not a full fix: two writers can still interleave".
  - `index:publicchannels` read-modify-write, including like and add counters (`02_:4905-4975`).
- **Problem.** Silent loss of ordering and directory entries. This is the documented root cause of the "129 records for 22 lists" incident (`26_:2169-2180`).
- **Fix.** `lists.position` and `channels` rows in D1; counters in the `likes` table.

### BE-H08 — Provider tokens are never refreshed

- **Where.** OAuth callbacks (`25_:3336-3445` Trakt, `3601-3711` MDBList, `3734-3826` Simkl) keep only `access_token`. `refresh_token` appears nowhere in the code. The prior audit's API-001 is still open.
- **Problem.** When a token expires, connected shelves go empty inside Stremio with no explanation, because a catalog row cannot show a message. The fix is blocked while tokens are copied into many install configs.
- **Fix.** `provider_connections` with encrypted refresh tokens, plus a daily refresh job (NEXT_VERSION_ARCHITECTURE §5).

### BE-H09 — Published-list catalog makes invalid IMDb ids

- **Where.** `fetchPublishedListCatalog` (`05_:2418-2427`):

  ```js
  const itId = it.imdbId || (String(it.id).startsWith('tt') ? it.id : (it.id ? `tt${it.id}` : ''));
  ```

- **Problem.** Any item whose id is a TMDB id (`"550"`) or a namespaced id (`"tmdb:550"`) becomes `"tt550"` or `"tttmdb:550"`. Stremio then shows a broken tile, or the wrong title, since `tt550` is a real, unrelated IMDb id.
- **Fix.** Keep `tmdb:` ids as-is (the manifest declares the `tmdb:` prefix). In v2 every item references `media` and emits a canonical id.

### BE-H10 — Most provider calls have no timeout

- **Where.**
  - 197 raw `fetch(` calls in server code.
  - Only 10 go through `fetchWithTimeout` and 39 through `fetchTraktWithRetry`. The 21 circuit-breaker call sites wrap their `fetchFn` in `withTimeout`.
  - Examples with no timeout: `buildTmdbRecommendations` (`05_:1673-1741`), `mapStoredRecommendationToMeta` (`05_:1803`), the bulk-resolve fetches (`26_:7210-7229`), and the OAuth token exchanges.
- **Problem.** A hanging provider holds the request, or the cron slice, until the platform kills it. The cron has 30 s of CPU but unbounded wall-clock waits.
- **Fix.** Put all provider IO behind `providerFetch` with mandatory timeouts (NEXT_VERSION_ARCHITECTURE §6.2).

### BE-H11 — Statistics queries cannot use their index

- **Where:**
  - `d1CountsByKindPrefix` (`03_:667-686`), `readStatTotalsByPrefix` (`03_:1445`), `computeAudienceAnalytics` (`03_:1245-1256`).
  - All use `kind LIKE 'prefix%'` (some with `ESCAPE`) on `stats(kind TEXT, day TEXT, PRIMARY KEY(kind, day))`.
- **Problem.**
  - SQLite's LIKE optimization needs a case-insensitive collation on the column, or `case_sensitive_like`. `kind` uses BINARY collation and D1 uses default LIKE semantics, so these queries scan the table. Confirm with `EXPLAIN QUERY PLAN` on D1.
  - `stats` grows with every distinct title watched (`evt:watched:{id}`) × day, plus `list_copy:{slug}` and `authfail:*`. The Most Watched rows run this scan every 15 minutes (`MOST_WATCHED_TODAY_REFRESH_SECONDS`).
- **Fix.** A dedicated `title_daily_stats(day, event_type, media_id, n)` table with `INDEX(event_type, day)`. Interim fix: rewrite as range predicates (`kind >= 'evt:watched:' AND kind < 'evt:watched;'`), which use the primary key.

### BE-H12 — Schema management is manual, not idempotent, and dangerous

- **Where:**
  - `schema.sql` begins with `DROP TABLE IF EXISTS` for every table, and the README tells operators to paste it into the D1 console.
  - Migrations `0001a`, `0008` and `0012` are non-idempotent `ALTER TABLE ADD COLUMN`s.
  - There is no ledger table.
  - The Worker infers schema state from `sqlite_master` on every cron tick (`checkD1Schema`, `02_:4023`) and before tracking writes (`d1HasAiringRemovalColumns`, `02_:4124`).
- **Problem.** One wrong paste wipes production. Drift is detected after deploy, not prevented.
- **Fix.**
  - A `schema_migrations` ledger.
  - `wrangler d1 migrations apply` from CI, or a documented console procedure that checks the ledger first.
  - `schema.sql` regenerated as "CREATE only" for local tests, with the destructive version renamed to `schema.reset.sql`.
  - A Worker startup assertion that the schema version is at least the required version.

### BE-H13 — One 15,000-line request handler with request-scoped closures

- **Where.**
  - `handleFetch` opens at `25_:163` and closes at `26_:7266`.
  - `authenticateCreator`, `authFailureResponse`, `detectClientApp`, `handleSubtitlesTrack` and `handleMediaServerScrobble` are declared **inside** the handler (`26_:12`, `103`, `127`, `155`, `548`). They are re-created per request and unreachable from module scope.
  - `verifyShelfOwner` (`02_:3680`) duplicates `authenticateCreator` because of this.
- **Problem.**
  - Route order is load-bearing: first match wins across about 150 `if` blocks.
  - Shared logic gets duplicated.
  - The scope bugs recorded in CI comments (`isShow`, `clientId`, `listName`) come from this structure.
- **Fix.** A router table plus modules (NEXT_VERSION_ARCHITECTURE §7.2).

### BE-H14 — Recommendations and Airing Next each have two implementations

- **Where:**
  - Recommendations: built in the browser (`19_` Discover, then `persistCuratedRecommendations` in `22_`) and rebuilt server-side by `fetchCuratedCatalog` (`05_:1821-1902`) when the snapshot is more than 3 days old (`CURATED_SNAPSHOT_MAX_AGE_MS`, `00_:1236`).
  - The server rebuild runs **per catalog request**: up to 12 seeds × (`find` + `recommendations` + `similar`), plus `trending`, plus 40 `external_ids` calls. It is edge-cached but never persisted.
  - Airing Next: client `refreshAiringNext` (`21_`) and server `rebuildAiringNextForRecord` (`07_:4611`).
- **Problem.** The two implementations drift. Server cost is paid per request instead of per account per day.
- **Fix.** One server job per account with a debounce, writing `account_recommendations`. Airing Next moves to `show_schedule`.

---

## Medium

| ID | Finding | Where | Why it matters | Fix |
|---|---|---|---|---|
| BE-M01 | Dead hyphen-insensitive fallback in `getCreator`. It checks `res2.length` on a D1 result object, so it never matches. If anyone "fixes" it, `abc` would authenticate against `a-bc`'s key hash **and** write `creator:abc` to KV, creating an alias account. It is also a full-table scan on an expression. | `02_:3499-3503` | Latent account confusion | Delete it |
| BE-M02 | `/sync/meta` parses `updatedAt` from raw JSON with `lastIndexOf('"updatedAt":')`. This is correct only while `updatedAt` is the last-written top-level key; a nested item's `updatedAt` serialized after it breaks change detection. | `26_:3747-3760` | Silent missed syncs | Superseded by `accounts.version`. Interim: store the stamp in a separate key or column. |
| BE-M03 | `purgeCreatorData` is about 430 lines, two passes, with 20+ KV keys and 12 D1 tables across separate statements. It also runs as a **pre-create purge** on every account creation. | `02_:3022-3446`, `26_:1292` | Partial deletes; create-latency; fragile | Soft delete plus a purge job with `ON DELETE CASCADE` |
| BE-M04 | Relative-date badges ("TODAY"/"TOMORROW") are computed with the Worker's UTC clock, then cached for 1 day in the browser and 7 days at the edge. The cache key has the air date but not today's date, so stale "TOMORROW" badges persist. | `formatAirDateBadge` `02_:3981`; `/api/poster-badge` `25_:310-461` (`s-maxage=604800`) | Wrong labels in Stremio | Add a day bucket to the badge URL, or render absolute dates ("WED SEP 30") |
| BE-M05 | 224 empty `catch {}` blocks and 60 `.catch(() => {})` in the codebase. Many are on D1 writes described as "best-effort", for example `02_:4000-4004`, `02_:1953`, and the FTS update. | Throughout | Silent failure is the root cause of most historical data-loss findings | Typed errors; `logger.warn` with context; only metrics writes may be best-effort |
| BE-M06 | Playback is marked watched **at start** (the subtitles ping). A 10-second sample counts as watched, advances Continue Watching and removes the title from the Watchlist. | `26_:109-126`, `155-540` | Wrong history | Record "started" events. Mark watched on a second ping later in the episode, or on media-server "stop at more than 80%". Make the behavior an explicit user setting. |
| BE-M07 | Scrobble webhooks accept **three** credentials: `st` token, install config id (`config=`/`token=`) and legacy `creator`+`key` in the query string. The install id is a *read* credential that gets shared, and here it grants *write* access. | `26_:553-590` | Privilege confusion | Scrobble tokens only; migrate existing webhook URLs (SECURITY S-08) |
| BE-M08 | `fetchCuratedCatalog` / `fetchAutoTrackedCatalog` call `resolveConfig` again with `keys.configParam`. | `05_:1828`, `05_:1960` | See BE-H04 | Pass the resolved config |
| BE-M09 | `isEpisodeAired` and `isEpisodeAiredServer` compare dates in the Worker's local time (UTC). US evening viewers see episodes as "aired" or "unaired" up to a day off. | `02_:3891-3904`, `07_:4447` | Wrong Continue Watching and Airing Next boundaries | Compare using the air date plus air time plus network timezone (TVmaze data is already fetched) |
| BE-M10 | `/api/poster-badge` builds base64 with a per-byte string concatenation loop and inlines the whole poster in an SVG. The icon is decoded from 115 KB base64 on every `/icon.png` request. | `25_:373-381`, `25_:194-205` | CPU per request | Chunked `btoa`, or return an SVG with an `<image href>` to R2; precompute the icon bytes once |
| BE-M11 | Charts are pre-warmed for `region="US"` and page 0 only. Every other region's charts are cold on every request. | `07_:5313` | Latency and provider cost for non-US users | Chart snapshots per region in use |
| BE-M12 | New on Streaming defaults to JustWatch's **unofficial** GraphQL API, which has no key and no terms for third-party use (`00_:325-336` acknowledges this). | `07_:1993-2414` | Legal/ToS exposure and fragility | Make RapidAPI (licensed) the default, or get JustWatch's permission; keep the engine switch |
| BE-M13 | `touchCreatorLastSeen` throttles per isolate. Across many isolates this writes `UPDATE creators SET last_active` often. On D1 failure it falls back to a KV write. | `03_:300-336` | Hot-row writes | Store last-seen on the session row, or in Analytics Engine |
| BE-M14 | `/api/save` does its own inline KV rate limit, awaited, before parsing the body. It is a copy of `consumeRateLimit`. | `25_:6961-6968` | Duplication (FT-13) | Unified limiter |
| BE-M15 | `/api/search-published-lists` special-cases the phrases "my lists"/"mylist" and strips them from queries. | `26_:4297-4320` | Surprising search behavior | Remove, or make it an explicit filter |
| BE-M16 | FTS maintenance deletes by an `UNINDEXED` column (`DELETE FROM lists_fts WHERE list_id = ?`), which is a full FTS scan per save or delete. | `26_:2431-2444`, `02_:2311`, `02_:3144` | Scales with directory size | External-content FTS keyed by rowid |
| BE-M17 | `json()` defaults successful responses to `Cache-Control: max-age=3600` (opt-out). Personal GETs must remember to override it; `/api/resolve` once didn't. | `02_:158-194` | A new personal GET route leaks into caches by default | Default to `no-store`; public routes opt in |
| BE-M18 | The list save writes D1 first and **swallows** D1 failure, then writes KV and returns `ok`. A foreign-key failure triggers a backfill-then-retry dance. | `26_:2312-2332` | Divergence (BE-C1) | Single D1 transaction; fail the request on failure |
| BE-M19 | `ensureTrackingMigrated` (a one-time legacy blob split) still runs on every sync save, load, scrobble and cron account. | `05_:1914`, `26_:237`, `26_:3002`, `26_:3842`, `07_:4869` | An extra KV read per call, forever | Migrate once, then delete |
| BE-M20 | `stremioAddonsConfig.signature` is a hard-coded JWE. | `05_:85-88` | Fine for the hosted app; should be configuration | Move to a variable |

## Low

| ID | Finding | Where |
|---|---|---|
| BE-L01 | `applyEnvApiKeys` writes module-level `let` globals on every request. It is safe because `env` is identical within an isolate, but it hides a dependency from every helper. | `00_:634-659` |
| BE-L02 | User-Agent strings are inconsistent: `my-list-addon/1.4`, `/1.14`, and `/${ADDON_VERSION}` (18 hard-coded). | `25_:364`, `25_:3364`, and others |
| BE-L03 | The TMDB OAuth callback returns raw `err.message` in the redirect (`failWith("network", err.message)`), bypassing `safeErrorMessage`. | `25_:5217-5219` |
| BE-L04 | Redundant indexes: `idx_creator_lists_likes` and `idx_creator_lists_visibility` are covered by `idx_creator_lists_vis_likes`. | `schema.sql` |
| BE-L05 | `compatibility_date = "2024-01-01"` in `wrangler.toml`. The dashboard value is unknown; document it and raise it deliberately. | `wrangler.toml:3` |
| BE-L06 | `renderAdminDashboard` is a 150 KB template literal inside the analytics module. | `03_:1715-4430` |
| BE-L07 | `CHANNEL_STORY_LOCK_LEGACY_START = Date.UTC(2026, 8, 24)` is a hard-coded date in business logic. | `05_:2520` |
| BE-L08 | The admin session is a stateless HMAC of the expiry; there is no per-session revocation and no audit trail (INFO-01, still open). | `03_:1546-1589` |

## Cleanup

- `extract_html.py`: legacy, unused by CI or `verify.sh`. It writes `test.html` and `test_inner.js`.
- `build.ps1` embeds its own copy of the header instead of reading `header.js`; drift risk.
- `header.js` content is false: "stateless… No database, no server-side auth".
- The six copies of the install-config schema (NEXT_VERSION_ARCHITECTURE §2.5).
- The duplicate COMPANION decoders (`02_:4708`, `05_:2040`).
- Legacy KV key names swept by the purge (`creatorprofile:`, `creatorpresets:`, `creatorchannels:`, `creatorlistlikes:`, `creatorlikes:`).
- `index:publiclists` is read in the admin schema-status route (`26_:5872`) though the index was removed.
- The migration endpoints once v2 lands (FT-16).
- `publishedlist:user:*`: the creation route was removed in 1.5.3, but the read, like and delete paths remain. Fold them into `lists` as `legacy_anonymous`.
- `FE-002`, dead import handlers (prior audit): **fixed**; only a comment remains at `18_:1011`.

---

## Phase 8 — Database audit

### 8.1 Schema problems

| Issue | Detail | Fix in v2 |
|---|---|---|
| **String composite primary keys** | `creator_lists.id = "username:slug"` duplicates `username`. Renames are impossible; every join is on long strings. | `INTEGER` ids plus `public_id` |
| **JSON that should be relational** | `creator_lists.items_json` / `published_lists.items_json` (up to 1.8 MB), `creators.share_json`, `feedback.body_json` (a whole thread), `creator_tracking_meta.curated_recommendations`, the `COMPANION:` JSON inside `continue_watching.show_title` | `list_items`; `account_settings`; `feedback_messages`; `account_recommendations`; `show_progress.companion_json` |
| **Relational data that is actually derived** | `continue_watching` and `airing_next` store computed shelves | Compute at read time |
| **Polymorphic keys without integrity** | `list_likes.list_id` is `c:{user}:{slug}`, `a:{slug}`, `ext:{hash}` or `ch:{code}`. There is no foreign key, and cleanup depends on application code in three places. | `likes(target_type, target_id)` with deletes in the same transaction as the target; periodic orphan sweep |
| **Missing owner** | `published_lists` has no owner, and anonymous content can only be moderated by an admin | `lists.owner_account_id NULL`, `kind = 'legacy_anonymous'` |
| **Inconsistent ids** | `watch_history.item_id` can be a TMDB episode id, `tt…:S:E`, `tmdb:…` or a movie `tt…`. There are three bug fixes for `split(':')[0]` normalization (`trackingShowKey`, `02_:3606`). | `media_id INTEGER` plus season and episode columns |
| **No rewatch support** | `watch_history PRIMARY KEY(username, item_id)` holds one row per item, so rewatches overwrite. | `watch_events` with a surrogate id |
| **Denormalized titles and posters on every activity row** | `watch_history.title/poster/show_title/show_poster` | Join to `media` |
| **Unbounded `stats.kind`** | Counters, per-title events, per-slug copies and auth failures share one table | Analytics Engine plus purpose-built rollups |
| **FTS without a content table** | Standalone FTS5 maintained by hand; deletes by an `UNINDEXED` column | External-content FTS on `lists` |
| **Foreign key plus lazy migration** | `creator_lists → creators` rejects writes for accounts not yet in D1; worked around with `backfillCreatorRowInD1` | Removed with the single authority |
| **Timestamps** | Consistent epoch milliseconds (good). `stats.day` is an Eastern-time date string; `airing_next.air_date` is a TEXT date; `updated_at` is sometimes a version counter (`nextSyncVersion`), not a time. | Keep epoch ms. A separate `version INTEGER` column for concurrency. |
| **No soft delete** | Deletes are immediate and multi-store | `deleted_at` plus a purge job |
| **Destructive setup script** | `schema.sql` begins with `DROP TABLE` (BE-H12) | Migrations only |

### 8.2 Index review

| Index | Verdict |
|---|---|
| `idx_creator_lists_username` | Needed (owner lookups). In v2, `idx_lists_owner(owner, position) WHERE deleted_at IS NULL`. |
| `idx_creator_lists_visibility`, `idx_creator_lists_likes` | **Redundant** with `idx_creator_lists_vis_likes` |
| `idx_creator_lists_vis_likes (visibility, likes DESC, updated_at DESC)` | Good for the directory. In v2, a partial index `WHERE visibility='public'` on `(like_count DESC, id DESC)` for keyset pagination. |
| `idx_stats_day_totals (day, n DESC, kind)` | Helps `day='total'` top-N only; prefix LIKE queries still scan (BE-H11) |
| `idx_watch_history_user_watched` | Good |
| `idx_list_likes_voter` | Needed for account deletion. In v2, `likes` needs `(voter)` too. |
| `idx_streaming_events_feed`, `_tmdb` | Good |
| **Missing** | `feedback` by account, and `creator_user_lists` by `list_id` (unlike cleanup). In v2: `list_items(list_id, position)` and `watch_events(account_id, media_id, season, episode)`. |

### 8.3 Query behavior at the target scale

Scale: 100k users, 1M public lists, 50M list items, 5M likes, large histories.

| Query today | At scale | v2 |
|---|---|---|
| Directory: `UNION ALL` of both list tables with `json_array_length(items_json)` **per row**, `ORDER BY likes DESC, updatedAt DESC LIMIT ? OFFSET ?`, plus two `COUNT(*)` subqueries (`02_:2645-2691`) | OFFSET paging degrades linearly (page 1,000 walks 100k rows). `json_array_length` parses up to 1.8 MB per row on sorted rows. `COUNT(*)` over a million rows on every call. | Keyset pagination on `(like_count, id)`, a stored `item_count`, and a cached approximate total |
| Search: FTS5 `MATCH` joined back to both list tables (`26_:4330-4350`) | Fine, if FTS maintenance stops scanning | External content |
| Leaderboard: `stats WHERE kind LIKE 'evt:watched:%' AND day BETWEEN … GROUP BY kind` | Full scan of `stats` (tens of millions of rows) every 15 minutes | `title_daily_stats` indexed by `(event_type, day)` with top-N per day |
| Tracking read: `SELECT * FROM watch_history WHERE username = ?` with **no LIMIT** (`02_:4677-4690`), used by sync load, cron and scrobbles | Reads thousands of rows per call, on every scrobble | Paginated history API; per-show progress rows for everything else |
| `d1ReplaceRowsById`: `SELECT` all keys for the user, then one `DELETE` per stale key (`02_:4087-4106`) | O(history) per save | Row-level deletes by id from the API |
| `getCreator` fallback `WHERE LOWER(REPLACE(username,'-','')) = ?` | Full scan (dead today; BE-M01) | Delete |
| Feedback admin list, stats per day | Small | — |
| `SELECT COUNT(*) FROM list_likes WHERE list_id = ?` after every like | O(likes on that list) | `like_count ± changes()` |

**D1 throughput.** At 100k users the realistic write load is about 5–20 writes per second at peak, all small row operations in v2, which is well within a single database. The risks are **size** (10 GB) and **long queries blocking the single writer**. v2 removes the multi-second queries (leaderboard scans, bulk upserts) and splits activity data out (NEXT_VERSION_ARCHITECTURE §3.4).

### 8.4 Migration hygiene

- Today there is no ledger. Add `schema_migrations`.
- Every migration must be idempotent, or guarded by the ledger.
- Every migration gets a paired verification query (for example, row counts before and after a backfill).
- Backfills run as jobs, not in migration SQL.
- Keep `migrations/` as the single source; generate the test schema from it (the harness currently loads `schema.sql`).

---

## Phase 14 — Testing audit

### 14.1 What exists

| Area | Tests | Notes |
|---|---|---|
| `tests/worker.test.mjs` (13,240 lines) | About 728 tests | Real Worker, SQLite-backed D1 with fault injection (`failWhen`), in-memory KV, a `freshIsolate()` helper. Strong on authorization matrices, IDOR, likes, slug allocation, sync conflicts, deletion races and pagination. |
| `tests/client.test.mjs` (7,977 lines) | About 448 tests | Client bundle evaluated in a `vm` with a permissive DOM stub (`tests/client-harness.mjs`). Tests logic, payload shapes and the request/response contract. |
| Feature suites (18 files) | About 36 | BetterPosters, New on Streaming, channels, watchlist and airing, charts, posters |
| `audit/**` (about 170 probes) | Not in CI | Playwright and harness probes documenting past findings |
| CI | Build drift, `node --check`, scope check, 3 render and HTML validations, service-worker syntax, FUNCTION-MAP drift, test suite | — |

### 14.2 Gaps and weak spots

| ID | Gap | Why it matters |
|---|---|---|
| T-01 | **Many tests assert the current dual-store design**: KV and D1 agreement, tombstone behavior, `trackingd1behind`, rescue merges | They will be deleted or rewritten with the storage model. Budget for that. They are not a safety net for v2. |
| T-02 | **The harness diverges from D1**: no 100-parameter limit, no 2 MB row limit, no 100 KB statement limit, no single-writer queueing, no "overloaded" errors | BE-H01 is invisible to CI |
| T-03 | **KV mock is strongly consistent** (except where faults are injected) | The eventual-consistency class of bugs is tested only by bespoke probes |
| T-04 | **No real-browser tests in CI** | Playwright probes exist under `audit/` but aren't wired in. Layout, focus, mobile and modal issues regress unnoticed. |
| T-05 | **Source-text assertions**: about 100 `readFileSync` or `.includes()` checks on tab HTML and source (for example `client.test.mjs:7301-7571`), plus "a sixth writer of `creatorlist:` fails the build" (`02_:2875`) | Brittle; they test spelling, not behavior |
| T-06 | **No provider contract tests.** Upstreams are stubbed with generic `{results:[]}` (`server.mjs:18-26`). | Provider response changes (Trakt, MDBList, JustWatch) are found in production |
| T-07 | **No migration tests**: no test applies `migrations/*` in order to an old schema snapshot | BE-H12 |
| T-08 | **No load or scale tests.** BE-C3, BE-H03 and BE-H11 are found by reasoning, not tests. | — |
| T-09 | **No security regression suite** for the new auth model (sessions, CSRF, token scopes). The current authorization matrix is key-per-request. | — |
| T-10 | **The skipped test** is network-dependent (per the prior audit) | — |

### 14.3 Recommended strategy (v2)

1. **Unit** (`node:test`, loading functions from the numbered files the way the suite already does): providers' `parseRef` and mappers, the channel engine, the materializer, the dedupe rule, date and air-time logic, id normalization, config validation.
2. **Repository and database** (`tests/harness.mjs`: real SQLite through `node:sqlite`, which since 2026-09-25 enforces D1's limits of 100 bound parameters, 2 MB per row and 100,000-byte statements): every query with realistic fixtures. Run `EXPLAIN QUERY PLAN` assertions for the directory, search, shelves and leaderboard queries ("uses index X").
3. **API integration** (the harness's `call()` against the built Worker): every route, covering authentication (session, install token, scrobble token, admin), authorization (owner vs. other vs. anonymous vs. admin), validation and error shapes.
4. **Migration tests:** start from a production-shaped fixture (anonymized export) at schema N, apply migrations and backfill jobs, then assert invariants: every list, like, event and install is preserved, counts match, and legacy URLs resolve.
5. **Provider contract tests:** recorded fixtures per provider endpoint, plus a nightly job (not per-PR) that calls real APIs with test accounts and diffs response shapes.
6. **End-to-end** (Playwright in CI, headless Chromium): the 12 UX scenarios in `FRONTEND_UX_AUDIT.md` §10 at 375 px and 1280 px, plus an axe accessibility scan.
7. **Security suite:** CSRF on every state-changing route, credentials rejected in query strings, cookie flags, CSP (no inline script), install-token scope (read-only cannot scrobble), session revocation, IDOR matrix.
8. **Load test** (k6 against staging): catalog hot path (N installs × 20 rows), scrobble burst, directory paging depth.

**Priority order:** authentication and ownership → list CRUD and public/private → catalog generation and legacy install links → watch history and scrobbles → provider failures (timeouts, 429, empty) → duplicates and dedupe → channels → OAuth and refresh → backup/restore → search → migrations.

---

## Phase 15 — Existing audit and planning documents

| Document | Claims | Verified status |
|---|---|---|
| `STORAGE-PLAN-KV-D1.md` | "Status: Completed. All phases (0 through 4) implemented." | **Partially implemented, and in places incorrectly.** Phase 0 (D1 required): documentation yes, code no (97 D1-optional branches remain). Phase 1 (kill the index): done; the directory and search are D1. Phase 2 (identity and lists D1-authoritative): reads invert, but **step 6 ("KV writes become cache invalidate + repopulate") was never done**; KV is still written unconditionally and read as authority by catalogs and likes (BE-C1). Order, stamp and share keys are dual-written, and order is still read from KV first. Phase 3 (likes, feedback, telemetry): D1 tables added, but `applyLikeVote` still does a KV read-modify-write of the full ledger, `stats:creator_count` is still a KV counter, and KV feedback copies are still written. Phase 4 (sync blob split): **implemented as a dual-write mirror, not a split.** The KV blob remains and is read first by `resolveConfig`, the crons, the scrobbles and curated recommendations. The client protocol (whole-blob push) was not redesigned, although the plan said it "needs its own design pass". |
| `COMPLETE_AUDIT_REPORT.md` (2026-09-13) | 27 findings, all "subsequently fixed" | Fixed and verified in source: SEC-001 gate (`mayReadTrackedShelf`), DB-001 (`ON CONFLICT`), DB-002/BE-002 (`trackingShowKey`), BE-001 (D1 failure surfaced on save-tracking), BE-003 (rotation fail-closed), PROTO-001 (`tmdb:` in `idPrefixes`), DB-003 (`LIMIT` pushed into SQL), CF-002 (memo keyed by hash), FE-002 (dead code removed). **Still open:** API-001 (no refresh tokens; deferred as "a storage-model change"), INFO-01 (admin session revocation), INFO-04 (hard-coded signature), INFO-02 (unbounded `stats.kind`). **Needs owner confirmation:** INFO-05 (live credentials in a committed backup in a public repo); **the credentials must be rotated, and the file purged from git history**. **Incorrect:** §9 states Paid subrequests are 1,000; they are 10,000. DB-003's fix left `json_array_length` per row. **Missed:** BE-H01, BE-H02, BE-H03, BE-H04, BE-C3 scale math, BE-H09. |
| `UI_UX_AUDIT.md` | Navigation 6→3, progressive disclosure, replace 148 native popups, a unified install action | **Not implemented.** Six tabs remain, and about 126 `alert`/`confirm` calls remain in `16_`–`24_`. An "Update Link" header button exists, but the reinstall requirement remains. Its terminology findings (Catalog vs. List vs. Channel) are still valid. |
| `FUNCTION-MAP.md` | Generated symbol and route map | Accurate for the current sources (regenerating produces identical content). It stays: the numbered files are kept (D-11), and CI checks the map is current. |
| `CHANGELOG.md` | User-facing change history | Current (Unreleased section describes recent Most Watched and drag fixes). Keep, and start a v2 section. |
| `Changes.md` | Detailed engineering log | Useful history. Freeze it and move it to `docs/history/`; v2 uses PR descriptions and the changelog. |
| `docs/history/*` | Previous audits and fix statuses | Historical; no action. |
| `docs/history/next-version-plan-2026-09-24-superseded/*` | The previous run of this plan | **Superseded.** It assumed PostgreSQL and dropped paste-deploy. |

**Important issues missed by all previous documents:**

- The O(N²) dedupe fan-out (BE-H03).
- The 100-parameter D1 limit breach (BE-H01).
- The authenticated edge-caching leak risk (BE-H02 / S-03).
- Per-user cron sweeps as a scale wall (BE-C3).
- Every config change requiring a reinstall, plus unbounded orphaned secret-bearing configs (BE-C4).
- The unsalted blind index of the Creator Key (SECURITY S-06).
- The TMDB OAuth login CSRF (SECURITY S-07).
- Install ids granting scrobble write access (BE-M07).
