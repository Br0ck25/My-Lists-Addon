# My Lists — Next Version Architecture

**Date:** 2026-09-25
**Status:** Plan only. Nothing in the application was changed to produce this document.
**Supersedes:** the 2026-09-24 plan (moved to `docs/history/next-version-plan-2026-09-24-superseded/`). That plan recommended PostgreSQL over Hyperdrive and dropped the "paste the Worker into the dashboard" deployment. Both conflict with the constraints below, so this plan starts again from the source.

Companion documents: `CLOUDFLARE_FREE_TIER_REMOVAL_PLAN.md`, `BACKEND_AUDIT.md`, `FRONTEND_UX_AUDIT.md`, `SECURITY_AUDIT.md`, `PERFORMANCE_AUDIT.md`, `MIGRATION_PLAN.md`, `NEXT_VERSION_TASKS.md`.

---

## 0. Constraints and how this was verified

### 0.1 Product constraints (from the owner)

1. The hosted application at mylistsaddon.com is the only supported deployment. There is no self-hosting and no support for individual copies.
2. Cloudflare Workers **Free** is not a design constraint. The account pays for Cloudflare.
3. **Everything stays on Cloudflare.** No external databases, queues or servers.
4. **Deployment stays "copy `worker_entry_combined.js` into the Cloudflare dashboard".** The deployable must remain one self-contained ES-module file, and every binding it needs must be configurable in the dashboard.

Constraint 4 decides a lot. It rules out:

- Workers Static Assets.
- Workflows.
- Any feature that needs `wrangler.toml` to take effect.
- Introducing a new Durable Object class. A new class needs a migration tag applied through Wrangler or the API.

It allows D1, KV, R2, Queues (producer binding plus a consumer configured on the queue), Cron Triggers, Analytics Engine, secrets and variables. All of these can be set in the dashboard, and the single file can export `fetch`, `scheduled` and `queue` handlers.

> Verify before Phase 5: that your dashboard offers **Queue** and **Analytics Engine** bindings on the Worker's *Settings → Bindings* page. Both are standard dashboard bindings today. If either is missing on your account, the fallbacks are listed in §6.4 and §4.6.

### 0.2 Platform limits used in this plan

Read from developers.cloudflare.com on 2026-09-25, not from the code's comments. Several of the code's comments are out of date.

| Limit | Value | Where the code disagrees |
|---|---|---|
| Subrequests per invocation (Paid) | 10,000 default, configurable to 10M | Comments throughout claim "1,000 KV/D1 storage operations per invocation, Free and Paid alike". KV operations now count toward the 10,000 subrequest limit. `COMPLETE_AUDIT_REPORT.md` §9 says "1,000 paid", which is also wrong. |
| CPU (Paid) | 30 s default, up to 5 min | — |
| Cron CPU | 30 s for intervals under 1 h; 15 min for intervals of 1 h or more | The 6-minute cron gets only 30 s CPU. |
| Queue consumer | 15 min wall time per invocation | — |
| Isolate memory | 128 MB | — |
| Script size | 64 MiB uncompressed | The current file is 4.2 MB. |
| Simultaneous outbound connections | 6 | — |
| Cache API | 1,000 calls per request (Paid) | — |
| D1 database size | 10 GB (Paid) | **The binding constraint for scale; see §3.4.** |
| D1 queries per invocation | 1,000 (Paid) | — |
| D1 bound parameters per query | **100** | `attachEventMeta` (03_admin.js:618) binds up to 401 and always fails on D1. See BACKEND_AUDIT BE-H01. |
| D1 row / string size | 2 MB | This is why `CREATOR_LIST_BYTES_MAX` is 1.8 MB. |
| D1 concurrency | Single-threaded per database. A 1 ms query allows about 1,000 queries/s. Read replication is available. | — |

### 0.3 How the code was verified

- **Source read.** I read `header.js` and every numbered source (`00_`–`26_`, 88,368 lines) directly or through targeted searches, plus `schema.sql`, all 14 migrations, the build scripts, CI, the tests and the prior audit documents.
- **Build check.** `python check_sync.py` reports that `worker_entry_combined.js` matches its sources (4,246,225 bytes).
- **Tests.** `node --test tests/*.test.mjs` ran 1,212 tests: 1,211 pass, 1 skipped, about 125 s.
- **UI walkthrough.** I ran the real Worker locally through the repo's own harness (`audit/frontend-2026-09-13/server.mjs`: SQLite-backed D1, in-memory KV, stubbed upstreams) and walked it in a browser at desktop and 375 px widths.
- **Limits.** Platform limits came from Cloudflare's documentation, as above.

---

## 1. The most important question

> *If we were starting My Lists today, with the current feature set and the expectation of thousands or tens of thousands of users, what would we build differently?*

We would build a **server-authoritative application on one Cloudflare Worker**. D1 would be the single source of truth. The data model would be relational, with one row per thing and one write per user action. Personal shelves would be computed from shared, show-level data, not rebuilt per user. Background work would run on Queues. KV would be used only as a disposable cache. R2 would hold large blobs.

What exists today is a **browser-authoritative, local-first app**. Each browser holds the account in `localStorage` (about 650 `localStorage` references in the client) and pushes whole JSON documents to two stores, KV and D1, that both claim to be authoritative. A large share of the backend repairs the disagreements:

- tombstones;
- reset markers;
- "D1 is behind" markers;
- a scrobble-queue key that works around KV propagation;
- compare-and-swap emulation;
- read-repair that writes on every read;
- cursors that slice work to fit the free plan.

These are the twelve things we would do differently. Each one drives a section below.

| # | What exists | What we would build | Why it matters at 10k–100k users |
|---|---|---|---|
| 1 | Two authorities (KV and D1), reconciled on read (`getCreator`, `getCreatorList`, `readCreatorTrackingD1`, `readAccountWatchlist`). Comments contradict each other in at least four places about which store is authoritative. | **D1 is the only authority. KV is a TTL cache that can be flushed at any time without losing data.** | Removes a class of silent data loss and about a third of the storage code. |
| 2 | The whole tracking document (Watch History, Continue Watching, Airing Next and more; up to 24 MB) is rewritten by browsers, scrobbles and the cron, then mirrored into D1 as one upsert per history item. | **One row per event.** A scrobble is one `INSERT` plus one progress `UPSERT`. | Makes write cost O(1) instead of O(history). Ends lost updates. |
| 3 | Continue Watching and Airing Next are rebuilt per user, by the browser *and* by cron cursors (3 accounts per tick for Airing Next). | **Show-centric schedule.** One job refreshes each *show* once, and every user's shelf is a SQL join at read time. | Cost scales with distinct shows (about 30k), not users × shows. At 100k users the current sweep takes about 17 days (Continue Watching) and about 139 days (Airing Next) per account. |
| 4 | Creator Key sent on every request, stored in `localStorage`, copied in plaintext into install configs and base64 URLs, and accepted in query strings. | **Sessions** (HttpOnly cookie, revocable). The key is used only to log in. **Install tokens** are scoped to read catalogs and optionally scrobble. | The master credential stops being spread across URLs, KV and logs. |
| 5 | Provider OAuth tokens live in `localStorage`, in every install config and in sync blobs. No refresh tokens are kept (0 uses of `refresh_token`). | **Server-side `provider_connections`**, encrypted at rest, with a refresh job. | Connected shelves stop silently dying. Tokens leave URLs. |
| 6 | Every config change mints a new install id, and users must reinstall the add-on. Old configs, with the tokens copied into them, are never deleted. | **One stable install URL per install.** Config is edited in place and versioned, and catalog changes are live. | Removes the top UX pain point and unbounded KV growth. |
| 7 | A list is one JSON blob (up to 10,000 items, 1.8 MB) stored in KV and D1, and the whole list is resent on every edit. | **`lists` + `list_items` + `media`**, with item-level mutations. | Adding one item is a small write. Search, counts and directory become plain SQL. |
| 8 | Channels, the channel directory, likes counters and install configs live only in KV, some as single read-modify-write keys. | **D1 rows** for metadata and counts; **R2** for large payloads (episode pools). | Ends lost updates on shared keys. |
| 9 | Charts are "pre-warmed" every 6 minutes into KV and a *per-colo* edge cache, through a three-tier circuit breaker. | **Chart snapshots.** A job writes the finished page to KV, keyed by region, and the catalog path reads it. | Faster and cheaper. Correct for every region. |
| 10 | Budgets, cursors and continuation protocols (`*_SUBREQUEST_BUDGET`, `remainingIds`, `nextIndex`, client re-post loops). | **Queues with durable job records.** Imports and refreshes run in the background with visible progress. | About 1,500 lines of free-tier machinery disappear. |
| 11 | 27 concatenated files. The client code is a string inside a template literal (backslash-escaping bugs, 733 inline handlers). One 15,000-line `handleFetch` spans two files. | **Kept as it is (D-11):** the numbered files, `python build.py` and the one pasted file. The costs are managed: `scope_check.mjs` and the render/HTML checks in CI, shared helpers for the repeated pieces (`providerFetch`, one install-config schema, log redaction), and event delegation replacing inline handlers over time. | The paste workflow, the build and every assistant's instructions stay exactly as they are. |
| 12 | Counters and telemetry as D1 hot rows (a pageview write per page load) plus KV fallbacks. | **Workers Analytics Engine** for events, with small D1 rollups for product features (Most Watched). | Takes write load off the single-threaded database. |

**What we would keep:**

- Cloudflare Workers.
- D1, including FTS5.
- The Stremio protocol surface and URL shapes (legacy links must keep working).
- The provider set.
- Most of the product features.
- The careful input validation already in place: `jsonForScript`, host allowlists, byte-accurate size checks, the SSRF guards.
- The test culture, reorganized.

**Answer to Phase 3's question, "is Cloudflare Paid still the best option?"** Within the owner's constraints it is the *only* option. It is also a good one for this workload:

- Stremio catalog traffic is read-heavy.
- It is cacheable per install.
- It is globally distributed, which suits edge compute plus a read-replicated SQLite.
- The write workload (scrobbles, list edits) is small per operation and partitions naturally by user.

The things that would push a team toward PostgreSQL are the 10 GB D1 limit and the single writer per database. §3.4 handles both by splitting user-activity data into its own database or databases from day one.

---

## 2. Phase 1: repository inventory

### 2.1 Source files and what they actually own

| File | Lines | Actual responsibility (verified) | Mixed concerns |
|---|---|---|---|
| `header.js` | 50 | Banner comment for the combined file | **Stale.** Says "stateless… no database, no server-side auth". |
| `00_constants.js` | 1,265 | Limits, free-tier budgets, provider IDs, env-key globals (`let TMDB_API_KEY…`), `D1_SCHEMA_MANIFEST`, BetterPosters options, personal-shelf prefixes | Config, budgets, schema metadata and UI option HTML builders in one file |
| `01_icon-asset.js` | 1,393 | 115 KB base64 PNG | Should be a build asset |
| `02_http-and-creator-utils.js` | 4,995 | CORS/CSP/JSON helpers; base64 config decode; PBKDF2/auth memo; key blind index; page memo and bundle split; 3-tier provider cache and circuit breaker; timeouts; IP keys; KV rate limiter; auth-failure budget; likes ledger; scrobble tokens; list tombstones; purge; slugs; SSRF guard; public directory query; sync versioning; creator tombstones; `getCreator`; `getCreatorList`; share gate; air-time formatting; schema check; the tracking D1 read/write engine; the channel directory index | At least 12 subsystems |
| `03_admin.js` | 4,430 | Counters, telemetry, leaderboards, audience analytics, admin HMAC cookie, admin login page, **admin dashboard as a 150 KB template literal** | Analytics engine and admin UI |
| `04_config-resolution.js` | 537 | `resolveConfig` (install config plus tracking-blob merge plus ownership proof), `detectSource` (30-way prefix/regex dispatch), URL parsers, MDBList toplists, Trakt list search | Config storage, authorization and provider parsing |
| `05_catalog-core.js` | 3,980 | Manifest, `fetchCatalog` dispatcher, merged/deduped rows, channel SVG posters, adult filter, BetterPosters proxy (KV-stored image bytes), custom/curated/auto-tracked/published list catalogs, TMDB recommendations, **the channel engine** (rotation, story-lock, part-gluing, live pools) | Catalog, image service and channel domain |
| `06_source-fetchers-mdblist-trakt.js` | 1,462 | MDBList and Trakt fetchers and mappers, including Airing Next and Continue Watching derived from provider data | — |
| `07_source-fetchers-tmdb-simkl.js` | 5,417 | Simkl, Trakt charts, TMDB (lists, charts, details, seasons, search, anime unpacking), New on Streaming (RapidAPI and unofficial JustWatch GraphQL), channel presets, Most Watched, TVmaze air times, **every cron job** | Providers and background jobs |
| `08_quickadd-chart-data.js` | 596 | Chart registries plus HTML builders | Data and markup |
| `09_page-shell.js` | 3,974 | `renderBuilder`: page HTML, 97 KB of CSS, preamble; opens the template literal that contains 10–24 | — |
| `10_`–`15_` | 1,480 | Tab HTML (Catalogs, Quick Add, Custom Lists, Channels, Presets/Backup, Settings) | — |
| `16_`–`24_` | 43,889 | Client application (about 820 functions, about 134 top-level `let`/`var` globals) **inside a server-side template literal**; `24_` also closes the literal and defines `renderGuidePage` | Client code escaped as server string content |
| `25_api-catalog-routes.js` | 7,469 | First half of `handleFetch`: pages, assets, Stremio protocol, images, provider proxies, OAuth, external writes, config save/resolve, likes, details | — |
| `26_api-creator-and-admin-routes.js` | 7,431 | Second half of `handleFetch` (the same function body continues): auth closure, scrobble handlers, creator/sync/list/channel routes, public list pages, 33 admin routes, bulk resolve; then `export default { fetch, scheduled }` | — |
| `worker_entry_combined.js` | 88,368 | Generated concatenation. Deployed by pasting. | — |

### 2.2 API surface

There are 138 exact-path routes plus 14 regex or prefix routes, about 152 handlers in total, all inside one function (`handleFetch`, 25_:163 → 26_:7266).

| Family | Routes (representative) | Count |
|---|---|---|
| Pages | `/`, `/configure`, `/:config/configure`, `/guide`, `/lists/:slug`, `/lists/curated/:slug`, `/lists/:user/:slug`, `/lists/{mdblist,trakt,tmdb,simkl,custom}/*`, `/channels/:user/:slug`, `/channel/:code`, `/admin` | 12 |
| Static | `/app.js`, `/app.css`, `/sw.js`, `/icon.png`, `/app.webmanifest`, `/robots.txt`, `/sitemap.xml`, `/unavailable-poster.svg` | 8 |
| Stremio protocol | `/:config/manifest.json`, `/manifest.json`, `/:config/catalog/:type/:id(/extra).json`, `/:config/meta/...`, `/:config/subtitles/...` (used as a playback ping) | 5 |
| Images | `/api/poster-badge`, `/api/safe-poster`, `/bp/*`, `/api/bp/warm`, `/api/channel-poster`, `/api/channel-logo`, `/api/poster-fallback` | 7 |
| Provider proxies | `/api/toplists`, `/api/season`, `/api/title-search`, `/api/show-seasons`, `/api/show-episodes`, `/api/person-*` (3), `/api/wizard-channel-shows`, `/api/quick-channel-shows`, `/api/resolve-movie`, `/api/resolve-show`, `/api/imdb-ids`, `/api/recommendations`, `/api/tmdb-search-lists`, `/api/trakt-search`, `/api/trakt-popular-lists`, `/api/trakt-my-lists`, `/api/trakt-my-private-lists`, `/api/trakt-history-raw`, `/api/simkl/my-lists`, `/api/tmdb-my-lists`, `/api/mdblist-my-lists`, `/api/mdblist-history-raw`, `/api/details`, `/api/details/batch`, `/api/bulk-resolve`, `/api/channel-preset`, `/api/channel-lineup`, `/api/preview` | about 30 |
| OAuth | Trakt (start, callback, device/code, device/token), MDBList (start, callback), Simkl (start, callback), TMDB v3 (start, callback) | 10 |
| Writes to providers | `/api/external-list/item-{mutate,add,remove}`, `/create`, `/delete`, `/api/external-sync/history` | 6 |
| Install config | `/api/save`, `/api/resolve`, `/api/track-install` | 3 |
| Community | `/lists/public.json`, `/api/public-lists.json`, `/api/search-published-lists`, `/api/lists/like`, `/api/lists/like-external`, `/api/channel/{share (GET/POST), directory, like, added, mine, unpublish}` | 12 |
| Creator account/sync | 23 routes under `/api/creator/*`, including `create`, `restore`, `reset-key`, `recovery-answer`, `forgot-username`, `lists`, `lists/items`, `lists/save`, `lists/delete`, `lists/reorder`, `account/reset`, `delete-account`, `sync/{save, save-tracking, save-presets, save-channels, meta, load, like, share-tracking}`, `scrobble-token`, `track-status`, `scrobble-seen-users` | 23 |
| Scrobble webhook | `/api/scrobble*` (Plex, Jellyfin, Emby) | 1 |
| Feedback / telemetry | `/api/feedback`, `/api/feedback/threads`, `/api/track-search`, `/api/track-event` | 4 |
| Admin | 33 routes under `/admin*`, including KV→D1 migration tools, moderation, feedback, analytics, API usage, New on Streaming controls, schema status | 33 |

### 2.3 Storage inventory

**Bindings:**

- `CONFIGS` (KV): 581 references.
- `DB` (D1): 328 references.
- No R2, Queues, Durable Objects, Analytics Engine, or service bindings.
- `caches.default` is used as a third cache tier.

**D1 tables (20):**

| Group | Tables |
|---|---|
| Identity | `creators`, `creator_key_lookups`, `creator_tombstones` |
| Lists | `creator_lists`, `published_lists`, `lists_fts` (FTS5), `list_tombstones`, `list_likes` |
| Tracking | `creator_tracking_meta`, `watch_history`, `continue_watching`, `airing_next`, `creator_show_states`, `creator_user_lists` |
| Counters / telemetry | `stats`, `source_groups`, `event_meta` |
| Other | `feedback`, `scrobble_tokens`, `streaming_events` |

**KV key families (about 90, verified by searching every templated key):**

- **Identity and auth:** `creator:`, `creatorlastseen:`, `keylookup:`, `creatorlookuphash:`, `creatordeleted:`, `creatorreset:`, `scrobbletoken:`, `creatorscrobbletoken:`, `authfail:`, `adminlogin:`, `restore:`, `reset:`, `resetkeyrate:`.
- **Lists:** `creatorlist:{u}:{slug}`, `creatorlistorder:`, `creatorliststamp:`, `creatorlistdeleted:`, `publishedlist:user:`, `index:publiclists` (legacy), `listlikevoters:` (including `:user:`), `externallike:`, `extlikevoters:`, `creatorlistlikes:` / `creatorlikes:` (legacy).
- **Sync blobs:** `creatorsync:`, `creatorsynctracking:`, `creatorsyncpresets:`, `creatorsyncchannels:`, `creatorshare:`, `creatorscrobblequeue:`, `trackingd1behind:`, `airingnextchecked:`, `creatortrack:`, `scrobbleseenusers:`, legacy `creatorprofile:` / `creatorpresets:` / `creatorchannels:`.
- **Install configs:** `cfg:{id}` and bare legacy `{id}`, plus `lastgood:{config}:{type}:{id}`.
- **Channels:** `channelshare:{code}`, `creatorchannel:{u}:{slug}`, `index:publicchannels`, `channellikevoters:`, `channel:preset:v2:{network}`, `channelpool:`, `channelnew:`.
- **Caches:** `cache:{kvKey}` (provider responses), `cache:poster_fallback:`, `tmdbdetail_v2:`, `tvmaze:airtime:v3:`, `unpacked_show:`, `mylists:mostwatched:v2:`, `bpimg:v1:` (BetterPosters image **bytes**), `bp:retry:v1`, `bp:variants:v1`, `bp:sharedids:v1`.
- **Counters (KV fallbacks):** `stats:*`, `evtcount:*`, `evtdayindex:*`, `evtmeta:*`, `searchquery:*`, `searchquerydayindex:*`, `feedback:*`, `feedbackrate:`.
- **Rate limits:** `ratelimit:{bucket}:{ip}` (about 12 buckets).
- **Cron and migration state:** `cron:continuewatching:cursor`, `cron:airingnext:cursor`, `cron:prewarm:cursor`, `cron:channelpresets:cursor`, `cron:bpwarm:cursor`, `cron:last_warmed:mdblist`, `cron:newonstreaming:{lastsweep, streams:, jwdays:, bumpcursor:}`, `cron:rapidapi:usage`, `backfilltrending:cursor`, `migrated1:state`, `migratedaycounts:state`, `stats:genredecade:migrated`.

**Per-isolate memory caches:**

- `CREATOR_AUTH_MEMO` (verified PBKDF2 results).
- `PER_USER_CACHE_MAP` (1,000 entries).
- `IN_FLIGHT_FETCHES`.
- `BUILDER_PAGE_MEMO`, `BUILDER_ETAG_MEMO`, `SPLIT_PAGE_MEMO`, `APP_BUNDLE`, `APP_CSS`.
- `UNPACKED_SHOW_CACHE`.
- `BETTER_POSTER_IN_FLIGHT`, `BETTER_POSTER_MISSES`.
- `CHANNEL_LIVE_POOL_IN_FLIGHT`, `CHANNEL_NEW_EPISODE_IN_FLIGHT`.
- `_lastSeenMemo`, `_d1AiringRemovalColumns`.

**Client persistence:**

- `localStorage`, about 80 keys, all prefixed `myListAddon:`. These include `creatorKey`, `traktAccessToken`, `simklAccessToken`, `mdblistAccessToken`, `tmdbSessionId`, provider API keys, `watchHistory`, `localCustomLists`, `localChannels`, `presets`, `syncBaselines`, `trackingLocalBaseline`, `deletedCreatorLists`, `state`, `backup`, the `*AiringNextCache` keys and `airTimes`.
- `sessionStorage` and IndexedDB, in `20_` and `22_`.
- A service worker with an asset cache and a shell cache.

### 2.4 Scheduled work, secrets and external services

**The one cron trigger** (`*/6 * * * *`, handler at 26_:7308) runs, in order:

1. `checkForNewEpisodes`.
2. Then, in parallel: `sweepNewOnStreaming`, `refreshAiringNextSweep`, `prewarmBetterPosters`.
3. Then: `bumpNewOnStreamingEpisodes` and `prewarmSharedCatalogs`.

Independently of that chain it runs `prewarmChannelPresets`, `checkD1Schema` and `pruneTombstones`. Budgets are split by the `CRON_*_SHARE` fractions.

**Background work inside requests:** 100 `ctx.waitUntil` sites, covering stat bumps, KV cache writes, playback tracking (`handleSubtitlesTrack`) and search telemetry. There is no queue.

**Environment variables:**

- Bindings and secrets: `CONFIGS`, `DB`, `ADMIN_KEY`, `TMDB_API_KEY`, `TRAKT_CLIENT_ID`, `TRAKT_CLIENT_SECRET`, `SIMKL_CLIENT_ID`, `SIMKL_CLIENT_SECRET`, `MDBLIST_API_KEY`, `MDBLIST_POPULAR_KEY`, `MDBLIST_CLIENT_ID`, `MDBLIST_CLIENT_SECRET`, `RAPIDAPI_KEY` / `STREAMING_AVAILABILITY_API_KEY`.
- Plain variables: `NEW_ON_STREAMING_ENGINE`, `BULK_RESOLVE_SUBREQUEST_BUDGET`, `DETAILS_BATCH_SUBREQUEST_BUDGET`, `CRON_SUBREQUEST_BUDGET`.

**External services:**

| Service | Access |
|---|---|
| TMDB API v3 | API key in query string; also v3 user sessions |
| Trakt API | Client-ID header plus Bearer; OAuth code flow and device flow |
| MDBList | Public JSON feed `mdblist.com/lists/.../json/` and `api.mdblist.com`; key in query string; OAuth with PKCE |
| Simkl | API key header plus Bearer; OAuth; chart files on `data.simkl.in` |
| Letterboxd | Export zip/CSV parsed in the browser with `fflate` from jsDelivr, then title matching through `/api/bulk-resolve` |
| JustWatch | **Unofficial** GraphQL, no key, no published terms |
| RapidAPI Streaming Availability | Monthly quota tracked in KV |
| TVmaze | Air times |
| Cinemeta (`v3-cinemeta.strem.io`) | Metadata fallback |
| metahub | Poster images |
| btttr.cc | BetterPosters |
| YouTube | Trailer embeds |
| Google Fonts | Fonts |

**Rate limiters:**

- `consumeRateLimit`: KV, per IP, 60 s window.
- Eight inline copies of the same pattern: `save`, `creatorcreate`, `creatorrestore`, `adminlogin`, `preview`, `tracksearch`, `trackevent`, `forgotusername`.
- `noteAuthFailure`: D1 daily per scope, with KV fallback.
- `RESET_KEY_ACCOUNT_MAX_FAILURES`: per account.

**Build and CI:**

- Build: `build.py` and `build.ps1`, **each with its own copy of the header text**.
- Checks: `check_sync.py`, `verify.sh`, `scope_check.mjs` (acorn plus eslint-scope), `render_check.js`, `html_checks.py`, `gen_map.py`, `extract_html.py` (legacy; writes `test.html` / `test_inner.js`).
- CI: `.github/workflows/ci.yml` checks rebuild drift, `node --check`, identifier scope, page, admin and hostile-input render validation, service-worker syntax, `FUNCTION-MAP` drift, and the test suite.
- **No `package.json`.** It is gitignored. Dependencies are installed ad hoc (`acorn@8.14.0`, `eslint-scope@8.2.0`, and optionally `playwright-core` for the audit probes).

**Tests:**

- 20 test files, 1,212 tests.
- `tests/harness.mjs` runs the real Worker against a SQLite-backed D1 with fault injection.
- `tests/client-harness.mjs` evaluates the client bundle in a `vm` against a DOM stub.
- About 170 audit probe scripts under `audit/`.

### 2.5 Duplicated implementations (verified)

| Concern | Copies |
|---|---|
| Install config schema (about 40 fields) | `decodeConfig` (02_:361), `resolveConfig` (04_:23), `/api/save` allowlist (25_:7032), client `buildConfig` (23_:296), client `generate()` body (24_:2167), `renderBuilder` initial keys (09_:1) — **6 copies** |
| Airing Next computation | Client `refreshAiringNext` (21_) and server `refreshAiringNextSweep` / `rebuildAiringNextForRecord` (07_:4611) |
| Continue Watching next-episode logic | Client `updateContinueWatching` (21_), cron `checkForNewEpisodes` (07_:4765), scrobble path (26_:374), media-server scrobble |
| Recommendations | Client (Discover builds them and pushes a snapshot) and server `buildTmdbRecommendations` when the snapshot is more than 3 days old |
| Rate limiter | `consumeRateLimit` plus 8 inline KV read/put copies |
| Watchlist | Three copies: tracking blob, `creatorlist:{u}:watchlist` in KV, `creator_lists` row in D1. `readAccountWatchlist` picks the newest. |
| List order | `creatorlistorder:` in KV and `creator_lists.sort_order` in D1 |
| "Lists changed" stamp | `creatorliststamp:` in KV and `creators.lists_stamp` in D1 |
| Share flags | `creatorshare:` in KV and `creators.share_json` in D1 |
| Tombstones | KV and D1 versions of both creator and list tombstones |
| Header text | `header.js` and an inline copy in `build.ps1` |
| Tracking-row normalization | The COMPANION decode is written out twice (02_:4708 and 05_:2040) |

### 2.6 Dependency map (current)

```text
Browser (1.3 MB app.js; localStorage = the database; ~650 localStorage references)
  │  pushes whole documents; polls /sync/meta every 60 s
  ▼
handleFetch (one 15,000-line function; auth is a closure inside it)
  │
  ├─ Stremio: /:config/catalog → resolveConfig ──► KV cfg:{id}
  │                                  └──► KV creatorsynctracking:{u} (MB blob, read on EVERY row request)
  │        └─ fetchCatalog (30-way if/else on detectSource)
  │              ├─ provider fetchers ──► circuit breaker: isolate Map → KV cache: → caches.default (per colo) → provider
  │              ├─ autotrack ──► D1 (if not "behind") else KV blob
  │              ├─ custom/published list ──► KV creatorlist:* (D1 bypassed)
  │              └─ dedupe ──► re-fetches every earlier row (O(N²))
  │        └─ KV lastgood: PUT on every successful load
  │
  ├─ Creator API: authenticateCreator ──► KV tombstone + D1 tombstone + D1 creators ──► KV creator: PUT (every call)
  │        └─ sync/save* ──► KV blob PUT ──► D1 full row-by-row mirror (chunks of 80, not atomic)
  │
  ├─ Scrobble (subtitles ping / webhook) ──► read-modify-write of the whole KV blob (3 tries) ──► full D1 rewrite ──► KV scrobble-queue key
  │
  └─ cron (every 6 min) ──► KV list creator: (25/page) ──► per-user TMDB lookups ──► blob rewrite
                        └─► chart prewarm ──► KV + per-colo edge cache
```

**Where responsibilities are mixed:**

- **The install config is several things at once:**
  - a routing key (the URL);
  - a settings document;
  - a credential store (provider tokens, `trackCreatorKey`);
  - an authorization proof (`trackOwner`);
  - a scrobble credential.
- **`entry.url` is overloaded.** It holds a URL, or several newline-separated URLs (merged row), or `channel:v1:<JSON>` / `customlist:v1:<JSON>` payloads with thousands of episodes. It is effectively a data container.
- **Server-rendered HTML contains the client application as string content.** `jsonForScript`, `render_check`, `html_checks` and `scope_check` all exist to guard this seam.
- **Background jobs live in the provider file** (`07_`).
- **The admin UI is embedded in the analytics module** (`03_`).

---

## 3. Phase 3: backend architecture

### 3.1 Options evaluated (Cloudflare only)

| Component | Verdict | Reason |
|---|---|---|
| **Workers Paid** (one script: `fetch` + `scheduled` + `queue`) | **Use.** | Stremio clients are global. Catalog responses are small and cacheable. A 30 s to 5 min CPU budget and 10,000 subrequests remove every budget knob. |
| **D1** | **Use as the only authority**, in 2 databases. | Relational, transactional (`batch`), FTS5 and read replication. The 10 GB and single-writer limits are handled by splitting (§3.4). |
| **KV** | **Use only as a cache** (TTL on every key). | Globally cached reads at the edge are ideal for install snapshots and chart snapshots. Eventual consistency is fine for caches and wrong for authority. |
| **R2** | **Use** for blobs. | BetterPosters and badged images (currently stored as KV bytes), large channel pools (currently 4 MB KV values), exports and backups, and nightly D1 dumps. |
| **Queues** | **Use.** | Replaces cursor slicing, client re-post loops and `waitUntil` fire-and-forget for important writes. Supports retries, a dead-letter queue and batching. |
| **Cron Triggers** | **Use** as a dispatcher only. | Enqueue due work, don't do it. Hourly and daily triggers get 15 min CPU. |
| **Analytics Engine** | **Use** for telemetry. | High-cardinality event counting without D1 hot rows. |
| **Cache API** (`caches.default`) | **Keep** as a per-colo L1 for catalog responses and images. | Free and fast. Not a source of truth. |
| **Durable Objects** | **Not in the core design.** | Adding a class needs a Wrangler/API migration, which conflicts with paste deploy. Not needed once D1 is the authority. Revisit only for real-time multi-device push or exact per-key rate limiting. |
| **Workflows** | **Don't use.** | Needs Wrangler. Queues plus a `jobs` table cover the need. |
| **Hyperdrive + PostgreSQL** | **Out of scope** (not Cloudflare-only). | Would ease D1's size and single-writer limits. The sharding plan in §3.4 gets the same headroom without leaving Cloudflare. |
| **Static Assets / Pages** | **Don't use.** | Needs a separate deploy. The frontend bundle is embedded in the Worker file at build time instead (§7). |
| **WAF rate-limiting rules** (zone, dashboard) | **Use** for coarse per-IP abuse limits. | Enforced before the Worker runs. Configurable in the dashboard. |

### 3.2 Target request paths

**Stremio catalog (the hottest path; must stay fast and cheap).** `GET /i/{installToken}/catalog/{type}/{rowId}/{extra}.json`, with the legacy `/{cfgId}/catalog/...` still served.

1. **L1 cache.** Look up `caches.default` keyed by `(installId, installVersion, rowId, skip)`. On a hit, respond.
2. **Install snapshot.** Read KV `install:{tokenHash}`: a compact JSON of `{installId, accountId, version, rows[], prefs}` with a 1-day TTL. On a miss, read D1 (read replica, `withSession`) and write the KV entry back. There are no secrets in the snapshot.
3. **Row source.** Resolve the row through the provider registry (§6):
   - shared sources (charts, public lists) read a snapshot;
   - personal sources (Continue Watching, Airing Next, History, Watchlist) run one indexed D1 query against the activity database with a `LIMIT`;
   - connected-provider sources use the server-held token.
4. **Post-process.** Apply BetterPosters, badges and the adult filter, which are pure functions. For "remove duplicates across lists", use the **per-install materialization** for this version: page 0 of every row is computed once per `(install, version)` with dedupe applied in order, then cached. Each row request is a lookup, not a refetch of N prior rows.
5. **Respond.**
   - Shared rows: `Cache-Control: public, max-age=300`, and a `caches.default` put.
   - Personal rows: `max-age=30`.
   - **No KV write on this path.** The `lastgood:` writes go away because snapshots are last-good by construction.

**Web app API.** Session cookie, then a D1 query or mutation, then a JSON response. Mutations are item-level: add, remove, move, rename, set visibility. Writes use `If-Match: <version>` for optimistic concurrency where two devices might collide (list edits, install config).

**Scrobble.** Webhook (`st=` token) or install-token playback ping:

1. Validate.
2. `env.JOBS.send({type:'scrobble', ...})`.
3. Respond 202.

The consumer resolves the media id (media table first, then TMDB) and runs one `DB_ACTIVITY.batch([INSERT watch_event, UPSERT show_progress])`. Idempotency key: `(account, media, season, episode, floor(ts/10min))`.

### 3.3 Why this shape fits the workload

- **Reads dominate.** Every Stremio launch requests the manifest plus N catalog rows for each install. With per-install materialization and KV snapshots, the common case is 1 KV read and 0 D1 queries.
- **Writes are small and user-partitioned.** Once list edits and scrobbles are row operations, they cost about 1 ms of D1 time each. A single activity database handles about 1,000 such writes per second, orders of magnitude above realistic load. At 100k users with 20 plays each per week, that is about 3.3 writes per second on average.
- **Shared work is shared.** Charts, show schedules, media metadata and channel presets are computed once and read by everyone.

### 3.4 D1 sizing and the split

These are estimates. Row sizes include SQLite overhead and index entries.

| Data | Rows at 100k users | Bytes/row (with indexes) | Size |
|---|---|---|---|
| `watch_events` (500/user avg) | 50M | about 90 (integer ids, no titles) | **about 4.5 GB** |
| `show_progress` (80/user) | 8M | about 70 | about 0.6 GB |
| `list_items` (1M lists × 50) | 50M | about 45 | **about 2.3 GB** |
| `lists` | 1M | about 250 | 0.25 GB |
| `media` | 500k | about 300 | 0.15 GB |
| `likes` | 5M | about 60 | 0.3 GB |
| Accounts, sessions, installs, connections | about 1M | about 300 | 0.3 GB |

Today's design stores titles, posters and show titles on *every* history row, so the same 50M events would be 15–20 GB.

**Decision:**

- **`DB` (core):** accounts, sessions, installs, provider connections, lists, `list_items`, `media`, channels, likes, directory, FTS, feedback, jobs, rollups. Projected at about 4 GB at 100k users.
- **`DB_ACTIVITY`:** `watch_events`, `show_progress`, `user_media_state`, `show_schedule`. Every query here is per account except the show-schedule join.
- **Shard trigger.** When `DB_ACTIVITY` passes 6 GB, add `DB_ACTIVITY_1…N` bindings in the dashboard and route by `hash(account_id) % N`. The code takes a `shardFor(accountId)` function from day one, so this is a configuration change plus a backfill job, not a rewrite. `show_schedule` stays in `DB` because it is shared.
- **Read replication.** Turn on D1 read replication for `DB`, and use the Sessions API (`withSession`) on catalog and directory reads.

---

## 4. Phase 4: storage audit and target model

### 4.1 Data type by data type

For each type the table records the authority today, duplication, caching, the stale-data risk, what happens if KV or D1 disappears, and the target home. The last two columns cover the audit questions: TX = needs transactional guarantees, FTS = needs full-text search, TTL = needs expiration, BG = needs background processing.

| Data | Authoritative today | Duplicated / cached | Can go stale? | If KV lost | If D1 lost | Needs | **Target** |
|---|---|---|---|---|---|---|---|
| Creator identity | **Ambiguous.** Code reads D1 first; comments say both. | D1 `creators` plus KV `creator:` (written on every read) | Yes (KV up to 60 s; KV-only accounts) | Accounts not yet in D1 are lost | Falls back to KV. Stale key hashes could authenticate. | TX (rotation) | **D1 `accounts`**. KV nothing, or a 60 s cache of public profile fields only. |
| Creator key lookup | D1 plus KV | Both | Yes | Forgot-username breaks for KV-only rows | Falls back to KV | — | **D1**, HMAC with a pepper (SECURITY S-06) |
| Creator lists | **Ambiguous.** Save writes D1 then KV; comment says "public read paths all read KV"; `getCreatorList` merges. | D1 `creator_lists.items_json` plus KV `creatorlist:` | Yes (merge prefers whichever is "fresher"; likes use `max()`) | Public list pages and custom-list catalogs go empty (they read KV only) | Merge falls back to KV | TX (items, order, count) | **D1 `lists` + `list_items`** |
| List order | KV (read first in save) plus D1 `sort_order` | Both | Yes (acknowledged lost updates) | Order lost | — | TX | **D1 `lists.position`** |
| Lists-changed stamp | D1 plus KV | Both | Yes | Devices miss changes | Falls back to KV | — | **Drop.** Replaced by `accounts.version` / change feed. |
| Anonymous published lists (legacy) | KV plus D1 `published_lists` | Both | Yes | Lost | Lost from directory | — | **D1 `lists` with `owner_account_id = NULL`, `legacy_anonymous = 1`**, read-only |
| Source groups | D1 `source_groups` / KV fallback | — | — | — | — | — | **Analytics Engine** plus a D1 daily rollup |
| Channels (user-built) | Browser `localStorage` plus KV `creatorsyncchannels:` blob | Blob | Yes (multi-device) | Synced channels lost | — | — | **D1 `channels`** (definition) plus **R2** (materialized pool) |
| Shared / published channels | KV `channelshare:{code}` (up to 4 MB) | — | — | **All shared channels lost** | — | — | **D1 `channels` (visibility) + R2 pool** |
| Channel directory | One KV key `index:publicchannels` (500 max, read-modify-write) | Denormalized likes/adds | Yes (lost updates) | Directory empty | — | TX (counters) | **SQL query over `channels`** |
| Channel presets | KV `channel:preset:v2:{network}` (cron) | — | Yes (refresh) | Rebuilt by cron | — | BG | **R2 JSON snapshot** plus a KV pointer; weekly job |
| Install configs | KV `cfg:{id}` (never deleted; a new id per change) | — | No (immutable) | **Every KV-backed install breaks** | — | — | **D1 `installs`** (authoritative) plus a KV snapshot cache |
| Watch history | **Ambiguous.** KV blob written first; D1 rows mirrored; D1 "authoritative" on some reads | KV blob, D1 rows, browser `localStorage`, scrobble-queue key | Yes (`trackingd1behind`, rescue merges) | History since the last D1 mirror lost | Reads fall back to the KV blob | TX (event plus progress) | **`DB_ACTIVITY.watch_events`** |
| Continue Watching / Airing Next | Derived, but *stored* (KV blob, D1 rows, browser, cron) | Four places | Yes (hours to days) | — | — | BG (shared) | **Computed on read** from `show_progress` + `show_schedule` |
| Show states (fully watched, dismissed, removed) | KV blob plus D1 `creator_show_states` | Both | Yes | — | — | — | **`show_progress.status` and dismissal columns** |
| Watchlist | Three copies | Three | Yes | — | — | — | **D1 `lists` (kind = watchlist)** |
| Likes (lists) | **Ambiguous.** KV ledger read-modify-write; D1 `list_likes`; `likes` columns in both stores | Four places | Yes (5,000 cap) | Ledger lost; D1 may be partial | Counts from KV | TX (row + count) | **D1 `likes`** plus `lists.like_count` in the same batch |
| Likes (external URLs, channels) | KV `externallike:` and `extlikevoters:`; the channel directory index | — | Yes | Lost | — | — | **D1 `likes` (target_type)** |
| Liked / hidden lists and sections | KV `creatorsync:` blob plus D1 `creator_user_lists` (delete-all and reinsert per save) | Both | Yes | — | — | — | **D1 `account_list_prefs`** |
| Presets | KV `creatorsyncpresets:` blob | Browser | Yes | Lost | — | — | **D1 `presets`** (small JSON per preset row) |
| Account settings and provider keys | KV `creatorsync:` blob (includes provider API keys) | Browser | Yes | Lost | — | — | **D1 `account_settings`**; secrets encrypted |
| Provider OAuth tokens | Browser, `cfg:` records, sync blob, base64 URLs | Many | Yes (expiry never refreshed) | Installs lose shelves | — | TX (refresh) | **D1 `provider_connections`** (AES-GCM) |
| Feedback | D1 `feedback` plus KV `feedback:` (180-day TTL) | Both | Yes | — | KV copy | — | **D1 only** |
| Telemetry / analytics | D1 `stats` (unbounded `kind`) plus KV fallbacks | Both | — | — | — | — | **Analytics Engine**; D1 `title_daily_stats` rollup for Most Watched |
| OAuth state | Cookies (10 min, HttpOnly, Lax) | — | — | — | — | TTL | **Keep cookies**; bind the TMDB request token to the cookie |
| Sessions | None (key on every request); admin uses an HMAC cookie | — | — | — | — | TTL | **D1 `sessions`** (hashed token), cached in isolate memory for 60 s |
| Temporary markers (tombstones, reset markers, `trackingd1behind`, scrobble queue, `airingnextchecked`) | KV and D1 | Both | — | — | — | TTL | **Delete.** They exist only to reconcile the dual store and local-first sync. |
| Provider caches | Isolate Map → KV `cache:` → edge | Three tiers | Yes by design | Refetch | — | TTL | **KV `pc:` (TTL)** plus in-flight coalescing |
| Chart / catalog caches | KV `cache:`, `lastgood:`, prewarm | — | Yes | Refetch | — | BG | **KV `snap:chart:{id}:{region}:{page}`** written by a job |
| Rate limits | KV (non-atomic) plus D1 `authfail` | — | — | Limits reset | — | TTL | **WAF rules** (per IP) plus **D1 `rate_counters`** (per account/credential) |
| Public directory / search | D1 `UNION` query plus FTS5 (standalone); KV scan fallback | — | — | — | — | FTS | **D1 `lists` index plus FTS5 external-content table**; KV cache of page 1 for 60 s |
| Title metadata (event_meta, titles on rows) | D1 plus KV | Both | Yes | — | — | — | **D1 `media`** (canonical, persisted) |
| Generated images | KV `bpimg:` (bytes); badged SVGs regenerated per request | — | — | Refetch | — | — | **R2 plus Cache API** |
| New on Streaming | D1 `streaming_events` plus KV cursors | — | — | Cursor reset | Feature lost | BG | **Keep the D1 table**; job state moves into the `jobs` table |
| Cron cursors / migration state | KV | — | — | Restart | — | — | **D1 `jobs` / `job_state`** |

### 4.2 The rule going forward

1. **D1 owns every fact.** If losing it would lose user data, it lives in D1, written once, in one transaction (`batch`).
2. **KV holds only derivations.** Every key has a TTL, a documented rebuild path and a version in the key or the value. Flushing the whole namespace must be safe, and should be tested in CI.
3. **R2 holds bytes and large documents**, addressed by content or version.
4. **The browser holds a cache and preferences**, never the authoritative copy of anything.

### 4.3 Target schema (sketch)

The real DDL lives in the migrations. This is the shape to agree on.

```sql
-- DB (core) ---------------------------------------------------------------
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  key_hash TEXT NOT NULL,                 -- PBKDF2; used only at login
  recovery_answer_hash TEXT,
  key_lookup_hmac TEXT UNIQUE,            -- HMAC(pepper, key); replaces unsalted SHA-256
  created_at INTEGER NOT NULL, last_active_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0,     -- bumped on any account-visible change (change feed)
  deleted_at INTEGER, status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  user_agent TEXT, revoked_at INTEGER
);
CREATE INDEX idx_sessions_account ON sessions(account_id);

CREATE TABLE installs (
  id INTEGER PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,   -- bearer token in the Stremio URL
  legacy_cfg_id TEXT UNIQUE,                                 -- old /{cfgId}/ links map here
  account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT, config_json TEXT NOT NULL,                      -- rows + prefs; NO secrets
  version INTEGER NOT NULL DEFAULT 1, scopes TEXT NOT NULL DEFAULT 'read',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER
);
CREATE TABLE provider_connections (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, external_user TEXT,
  access_token_enc TEXT, refresh_token_enc TEXT, expires_at INTEGER,
  api_key_enc TEXT,                                          -- user-supplied provider keys
  status TEXT NOT NULL DEFAULT 'ok', last_error TEXT, updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, provider)
);

CREATE TABLE media (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('movie','show')),
  tmdb_id INTEGER, imdb_id TEXT, tvdb_id INTEGER, title TEXT NOT NULL, year INTEGER,
  poster_path TEXT, backdrop_path TEXT, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_media_tmdb ON media(kind, tmdb_id) WHERE tmdb_id IS NOT NULL;
CREATE UNIQUE INDEX idx_media_imdb ON media(imdb_id) WHERE imdb_id IS NOT NULL;

CREATE TABLE lists (
  id INTEGER PRIMARY KEY, public_id TEXT NOT NULL UNIQUE,
  owner_account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  slug TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
  kind TEXT NOT NULL DEFAULT 'custom',        -- custom|watchlist|imported|synced|legacy_anonymous
  media_type TEXT NOT NULL,                   -- movie|series|mixed
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','unlisted','public')),
  source_provider TEXT, source_ref TEXT, synced_at INTEGER,
  item_count INTEGER NOT NULL DEFAULT 0, like_count INTEGER NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
  UNIQUE (owner_account_id, slug)
);
CREATE INDEX idx_lists_owner ON lists(owner_account_id, position) WHERE deleted_at IS NULL;
CREATE INDEX idx_lists_directory ON lists(like_count DESC, id DESC) WHERE visibility='public' AND deleted_at IS NULL;
CREATE TABLE list_items (
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  media_id INTEGER NOT NULL REFERENCES media(id),
  position REAL NOT NULL, added_at INTEGER NOT NULL, note TEXT,
  PRIMARY KEY (list_id, media_id)
);
CREATE INDEX idx_list_items_order ON list_items(list_id, position);
CREATE TABLE list_slug_history (owner_account_id INTEGER, old_slug TEXT, list_id INTEGER,
  PRIMARY KEY (owner_account_id, old_slug));
CREATE VIRTUAL TABLE lists_fts USING fts5(name, description, owner_name,
  content='lists_fts_source', content_rowid='id', tokenize='unicode61 remove_diacritics 2');

CREATE TABLE likes (
  target_type TEXT NOT NULL,       -- list|channel|external
  target_id TEXT NOT NULL,         -- lists.public_id | channels.public_code | sha256(url)
  voter TEXT NOT NULL,             -- 'a:<accountId>' | 'ip:<hmac(ip,target)>'
  created_at INTEGER NOT NULL,
  PRIMARY KEY (target_type, target_id, voter)
);
CREATE TABLE channels (
  id INTEGER PRIMARY KEY, public_code TEXT NOT NULL UNIQUE,
  owner_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  name TEXT NOT NULL, description TEXT, visibility TEXT NOT NULL DEFAULT 'private',
  definition_json TEXT NOT NULL,   -- rules, sources, locks (small)
  pool_r2_key TEXT, pool_version INTEGER NOT NULL DEFAULT 0, item_count INTEGER NOT NULL DEFAULT 0,
  like_count INTEGER NOT NULL DEFAULT 0, add_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
);
CREATE TABLE show_schedule (
  media_id INTEGER PRIMARY KEY REFERENCES media(id),
  status TEXT, last_aired_season INTEGER, last_aired_episode INTEGER, last_aired_date TEXT,
  next_season INTEGER, next_episode INTEGER, next_air_date TEXT, next_air_time TEXT, air_tz TEXT,
  season_finale_date TEXT, season_finale_episode INTEGER,
  watcher_count INTEGER NOT NULL DEFAULT 0, checked_at INTEGER, next_check_at INTEGER NOT NULL
);
CREATE INDEX idx_show_schedule_due ON show_schedule(next_check_at) WHERE watcher_count > 0;
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY, type TEXT NOT NULL, dedupe_key TEXT UNIQUE,
  account_id INTEGER, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  run_after INTEGER NOT NULL, payload_json TEXT, progress_json TEXT, last_error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);

-- DB_ACTIVITY ---------------------------------------------------------------
CREATE TABLE watch_events (
  id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, media_id INTEGER NOT NULL,
  season INTEGER, episode INTEGER, watched_at INTEGER NOT NULL,
  source TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_we_account_time ON watch_events(account_id, watched_at DESC);
CREATE INDEX idx_we_account_media ON watch_events(account_id, media_id, season, episode);
CREATE TABLE show_progress (
  account_id INTEGER NOT NULL, media_id INTEGER NOT NULL,
  last_season INTEGER, last_episode INTEGER, last_watched_at INTEGER,
  status TEXT NOT NULL DEFAULT 'watching',       -- watching|completed|dropped
  dismissed_at_season INTEGER, dismissed_at_episode INTEGER,
  airing_hidden_at_season INTEGER, airing_hidden_at_episode INTEGER,
  companion_json TEXT,                           -- replaces the "COMPANION:" hack in show_title
  updated_at INTEGER NOT NULL, PRIMARY KEY (account_id, media_id)
);
CREATE INDEX idx_sp_account_recent ON show_progress(account_id, last_watched_at DESC);
CREATE TABLE user_media_state (   -- movies watched / rated, one row per (account, media)
  account_id INTEGER NOT NULL, media_id INTEGER NOT NULL, watched_count INTEGER NOT NULL DEFAULT 0,
  last_watched_at INTEGER, PRIMARY KEY (account_id, media_id)
);
```

Because `show_schedule` lives in `DB` and `show_progress` lives in `DB_ACTIVITY`, Continue Watching and Airing Next cannot be one cross-database SQL join. They are two queries:

1. Up to 200 `show_progress` rows for the account.
2. One `show_schedule` lookup for those media ids, in chunks of 90 ids to stay under the 100-parameter cap.

The join happens in the Worker. That is two indexed round trips, with no cron and no stored derivation.

### 4.4 KV key plan after migration

| Prefix | Content | TTL | Rebuilt from |
|---|---|---|---|
| `install:{tokenHash}` | Install snapshot (no secrets) | 1 day | D1 `installs` |
| `snap:chart:{source}:{chart}:{type}:{region}:{page}` | Finished chart page (normalized metas) | 2 h | Chart job |
| `snap:list:{publicId}:{version}:{page}` | Public list page | 1 day | D1 |
| `snap:mat:{installId}:{version}:{rowId}` | Deduped page 0 per row | 1 h | Materializer |
| `pc:{provider}:{hash}` | Provider response cache | Per provider | Provider |
| `dir:page1:{sort}` | Directory first page | 60 s | D1 |

Nothing else. No counters, cursors, tombstones, ledgers or configs.

### 4.5 R2 plan

| Path | Content |
|---|---|
| `img/bp/{style}/{imdb}.jpg` | BetterPosters copies (replacing `bpimg:v1:` KV bytes) |
| `img/badge/{hash}.svg` | Rendered badged posters (optional) |
| `channels/{publicCode}/{poolVersion}.json` | Materialized episode pools |
| `presets/channels/{networkId}.json` | Channel presets |
| `exports/{accountId}/{ts}.json` | User exports (short-lived signed download) |
| `backups/d1/{db}/{date}.sql.gz` | Nightly D1 export (via the D1 export API from a job, or `wrangler d1 export` in CI) |

### 4.6 Analytics plan

- Pageviews, installs, API usage, catalog latency, provider errors and search queries go to **Analytics Engine** with `writeDataPoint`. There is no D1 write on the request path.
- The admin dashboard reads Analytics Engine through its SQL API. This needs an account API token stored as a secret.
- **Most Watched** needs a queryable per-title count, so the scrobble consumer upserts `title_daily_stats(day, event_type, media_id, n)` in `DB`, keeping only the top 2,000 per day (`PRIMARY KEY(day, event_type, media_id)`, `INDEX(event_type, day, n DESC)`).
- **Fallback if Analytics Engine can't be bound from the dashboard:** a D1 `metrics_daily(day, metric, dim, n)` table written by a queue consumer that aggregates batches. That is still one write per batch, not one per request.

---

## 5. Phase 5: background jobs and caching

| Current system | Keep? | Sync / job / queue / cron? | Shared across users? | New design |
|---|---|---|---|---|
| Chart pre-warm (`prewarmSharedCatalogs`, every 6 min, about 40 charts, US only, page 0 only, sleeps between charts) | Rewrite | **Hourly cron → enqueue `chart.refresh` per (chart, region)** | Yes | Consumer fetches N pages, normalizes to media ids, writes `snap:chart:*` to KV. Regions = those actually used by installs (`SELECT DISTINCT region FROM installs`). Stale-while-revalidate: serve the snapshot even if old, and enqueue a refresh when past the soft TTL. |
| Continue Watching sweep (`checkForNewEpisodes`, cursor, 25 accounts/page, max 150 shows) | **Delete** | Computed on read | Yes (schedule) | `show_schedule` plus `show_progress` read-time join. |
| Airing Next sweep (3 accounts/tick) plus browser `refreshAiringNext` plus `/api/details/batch` loops | **Delete** | Computed on read | Yes | Same. The browser stops computing shelves. |
| Show refresh (implicit, per user) | New | **Hourly cron → select due shows (`next_check_at <= now AND watcher_count > 0`) → queue in batches of 50** | Yes | One TMDB call per show plus TVmaze for the air time. `next_check_at` adapts: returning shows get 6 h, or 1 h on air day; ended shows get 14 days. |
| Recommendations (browser builds and pushes a snapshot; server rebuilds when more than 3 days old) | Rewrite | **Job per account, triggered by activity** (debounced 1 h) | Partly (TMDB recs per title shared via `pc:`) | Stored in `account_recommendations(account_id, type, media_id, rank)`; the catalog row reads it. |
| BetterPosters prewarm (`bp:sharedids`, retries key, variants key) | Rewrite | **Job `poster.fetch` enqueued on miss**; chart job enqueues chart titles | Yes | R2 objects; miss → serve the plain poster → enqueue. |
| New on Streaming sweeps (JustWatch/RapidAPI, stream cursors in KV) | Keep the feature, rewrite the plumbing | **Cron every 2 h → `nos.sweep` job**; stream state in the `jobs` table | Yes | See BACKEND_AUDIT BE-M12 on the JustWatch terms risk. |
| Channel presets (28 networks, cursor) | Rewrite | **Weekly cron → one job per network** | Yes | R2 JSON plus `channels.pool_version`. |
| Letterboxd / CSV import (client chunks of 200, server budget 48, re-post loop) | Rewrite | **Upload → `import.resolve` job** with progress in `jobs.progress_json`; UI polls the job | Title→media resolution cached in `media` | Resumable, visible and retryable. The user can close the tab. |
| Trakt / MDBList / Simkl history import (`/api/*-history-raw`, client orchestrated) | Rewrite | **`provider.sync` job** per connection (initial full import, then incremental hourly for opted-in users) | No | Writes `watch_events` with source = provider. |
| Token refresh | New | **Daily cron → refresh connections expiring within 7 days** | No | Marks `status='reauth_required'` on failure; the UI shows a banner. |
| Account deletion purge (two-pass sweep of about 20 KV keys and 12 tables) | Rewrite | **Synchronous soft delete (`deleted_at`, sessions revoked) → `account.purge` job** | — | Cascading deletes, with no race to reason about. |
| Tombstone prune | **Delete** | — | — | Tombstones disappear with local-first sync. |
| D1 schema check every tick | **Delete** | — | — | Migrations are applied by CI before deploy (see MIGRATION_PLAN §1.3). |
| Stats bumps via `waitUntil` | Rewrite | Analytics Engine `writeDataPoint` (non-blocking) | — | — |
| Playback tracking via `waitUntil` | Rewrite | **Queue** (durable, retried) | — | — |

**Job system:**

- One `JOBS` queue (with a dead-letter queue).
- A `jobs` table for anything the user can see or that must not be lost (imports, purges, provider syncs).
- Plain queue messages for idempotent, fire-and-forget work (show refresh, poster fetch, chart refresh).
- **Cron triggers:**
  - `*/5 * * * *` — dispatcher: re-enqueue due or stuck jobs. Cheap.
  - `7 * * * *` — hourly: charts, show refresh, recommendations debounce flush.
  - `17 3 * * *` — daily: token refresh, rollups, cleanup, D1 export.
  - Hourly and daily triggers get 15 min CPU. The dispatcher only enqueues.

---

## 6. Phase 6: provider architecture

### 6.1 Provider audit (current)

| Provider | Endpoints used | Auth | Rate limit (documented or observed) | Caching today | Retries / timeout | Pagination | Called from | Persisted? | Cascade risk |
|---|---|---|---|---|---|---|---|---|---|
| TMDB v3 | `/find`, `/search/{movie,tv,person,collection,multi}`, `/{movie,tv}/{id}` (+ `append_to_response`), `/tv/{id}/season/{n}`, `/episode_groups`, `/discover/{movie,tv}`, `/trending`, `/list/{id}`, `/collection/{id}`, `/network/{id}`, `/person/*`, `/watch/providers`, `/account/*` (v3 session), `/authentication/*` | `api_key` in the query string (user or shared) | About 40 req/s per IP (per admin note) | `cf.cacheTtl` edge (140 sites), circuit-breaker tiers, `tmdbdetail_v2:` KV | 10 s only where wrapped; most `fetch` calls have **no timeout** | `page` param, 20/page; code fetches 5 pages for a 100-item row | Server; browser once (22_:5792) | KV cache only | High. The details path fans out to up to 8 fetches per id. |
| Trakt | `/users/{u}/lists/{l}/items`, `/users/me/{watchlist, history, watched/shows, lists}`, `/sync/{history, watchlist, collection, playback}`, `/calendars/my/shows`, `/users/hidden/*`, charts, `/search/list`, `/lists/popular`, `/oauth/*` | `trakt-api-key` header plus Bearer | 1,000 GET / 5 min per app (admin note) | `cf.cacheTtl` **including on Bearer `users/me/*` calls** (SECURITY S-03), circuit breaker | `fetchTraktWithRetry`: 2 retries on 429 with in-request sleeps up to 3 s; 10 s timeout | `x-pagination-*` headers | Server | No | Medium; shared client id |
| MDBList | Public JSON feed `mdblist.com/lists/{path}/json/`, `api.mdblist.com/{lists/*, watchlist, sync/watched, sync/watchlist, user, oauth/token}` | `apikey` in the query string; OAuth with PKCE | 1,000/day free tier (shared key) | Hourly gate for charts; `cf.cacheTtl` | None specific | `offset/limit`, cursor for sync | Server | No | High for the shared key's daily quota |
| Simkl | `data.simkl.in` chart files, `/sync/all-items`, `/sync/history`, `/users/settings`, OAuth | `simkl-api-key` plus Bearer | About 10 req/s | Circuit breaker | None | — | Server | No | Low |
| Letterboxd | No API. Export zip/CSV in the browser; list likes by URL | — | — | — | — | — | Browser, then `/api/bulk-resolve` | No | Title matching is fuzzy (TMDB search top hit + year) |
| JustWatch | GraphQL `apis.justwatch.com/graphql` (**unofficial**) | None | Unknown | D1 `streaming_events` | Budgeted | Cursor | Cron | Yes | Can disappear or block without notice |
| RapidAPI Streaming Availability | `/changes` | Header key | 1,000/month (Basic) | D1 | Monthly ledger in KV | Cursor | Cron | Yes | Low |
| TVmaze | `/lookup/shows?imdb=`, `/shows/{id}` | None | 20 calls / 10 s per IP | `tvmaze:airtime:v3:` KV | Meter | — | Server | KV | Low |
| Cinemeta / metahub | Meta and search fallback; poster images | None | — | Edge | — | — | Server and client images | No | Low |
| btttr.cc | Poster images (draw can take 40–55 s) | None | Unknown | KV bytes plus retry queue | 55 s timeout | — | Server | KV | Medium (slow origin) |

**Problems:**

- **No shared model.** There are 12 per-provider mappers (`mapTmdbItem`, `mapTraktItems`, `mapTraktHistoryItems`, `mapMdblistItems`, `extractMdblistItem`, `mapSimklItems`, RapidAPI and JustWatch extractors…). Each returns a slightly different "meta" shape, with ad hoc fields (`isCompanion`, `airDate`, `seasonFinaleAirDate`, `totalItems` hung on arrays).
- **IDs are inconsistent.** `tt…`, `tmdb:123`, `tmdb:123:1:2`, TMDB episode ids, `kitsu:`. There are three separate fixes for `split(':')[0]` bugs.
- **Mixed provider logic.** Airing Next and Continue Watching are implemented once per provider (Trakt, MDBList, Simkl, local).
- **Errors are strings** thrown and matched by text in places.

### 6.2 Target provider layer

```text
provider layer (06_, 07_ and 27_provider-http.js -- D-11)
  http             providerFetch(provider, request, {auth, cache: 'none'|{ttl}, timeoutMs, retries, idempotent})
                   - per-provider concurrency limit, timeout on EVERY call, jittered retry for 429/5xx on idempotent GETs
                   - NEVER edge-caches a request carrying user credentials
                   - emits metrics (latency, status) to Analytics Engine
                   - typed errors: ProviderAuthError | ProviderRateLimited | ProviderUnavailable | ProviderNotFound
  registry.js      source type -> adapter (replaces detectSource's 30-way if/else)
  tmdb.js trakt.js mdblist.js simkl.js justwatch.js rapidapi.js tvmaze.js cinemeta.js letterboxd.js
  media-resolver.js  any external id -> media.id (DB lookup, then TMDB /find, persisted)
  normalize.js     MediaRef {mediaId, kind, tmdbId, imdbId, title, year, poster, season?, episode?}
```

**Adapter contract:**

```js
export const trakt = {
  id: 'trakt',
  sources: ['trakt.list', 'trakt.watchlist', 'trakt.history', 'trakt.chart'],
  parseRef(url) -> SourceRef | null,                 // replaces the regexes in detectSource/traktListPath
  async fetchPage(ref, {cursor, pageSize, ctx}) -> { items: ExternalItem[], nextCursor, total },
  shared: (ref) => ref.kind === 'chart' || ref.kind === 'public-list',  // decides snapshot vs live
  auth: (ref, account) -> 'app' | 'user',            // user => provider_connections
};
```

Catalog code sees only `MediaRef[]`. Badges, BetterPosters and the adult filter operate on `MediaRef` plus a `media` row. Personal shelves are **our** shelves, computed from `watch_events`. Provider-specific Continue Watching (Trakt progress, MDBList Up Next) becomes an import into our model, where the user opts in, rather than a parallel implementation per provider.

**Cascading-failure protection:**

- Every provider call has a timeout.
- Shared data is served from snapshots, so a provider outage degrades freshness, not availability.
- A per-provider breaker stores state in KV `pb:{provider}` with a 60 s TTL: open after N consecutive failures, fail fast while open.
- The existing `refuseEmptyOverwrite` idea is kept inside the chart job: an empty chart never replaces a non-empty snapshot.

### 6.3 Keys and quotas

- Shared app keys stay in secrets.
- User-supplied keys (TMDB, MDBList, Trakt client id) move to `provider_connections.api_key_enc`. They are used for that user's calls only and never embedded in URLs or configs.
- Quota accounting is per `(provider, key-kind)` in Analytics Engine, which replaces the `apiuse:*` D1 counters.

### 6.4 If Queues are unavailable on the account

Use `jobs` rows plus the 5-minute dispatcher cron. It claims up to N due jobs with `UPDATE … SET status='running', run_after=now+lease WHERE id IN (SELECT … LIMIT N)` and processes them within the cron's CPU budget. This is slower but correct, and it keeps the same job contracts, so moving to Queues later is a drop-in change.

---

## 7. Phase 13: code organization and the single-file deployable

**Decided 2026-09-27 (D-11): the numbered split files, `python build.py` and the one pasted `worker_entry_combined.js` stay.** There is no npm build, no `src/` tree and no front-end framework. This section used to propose an esbuild layout; it now records how the code is organized within the files it already has.

### 7.1 The costs, and how they are managed

The numbering encodes **concatenation order**, not ownership, and three costs follow from that. Each is managed rather than removed:

- **All the files share one global scope.** `scope_check.mjs` runs in CI and fails the build on any identifier that resolves to nothing, including a name declared inside a different route's block. That was the class behind the `isShow` / `clientId` / `listName` bugs.
- **The client application lives inside a server template literal**, so backslashes and `${` must be escaped by hand. This caused the admin page `SyntaxError`. `render_check.js` and `html_checks.py` render the builder page, the admin page, a hostile-input page and the service worker in CI and syntax-check what comes out. Client code is written so it needs no backslashes where possible (`startsWith` / `split` rather than regular expressions), and assistants follow the escaping rules in `CLAUDE.md`.
- **Lint and type tooling can't see the client code as code.** This is accepted. The tests load client functions directly (`loadOneClientFunction`) and run the whole page script in a sandbox (`tests/client-harness.mjs`).

### 7.2 Where code goes

The existing files keep their responsibilities:

| File | Owns |
|---|---|
| `00_constants.js` | Constants, limits, shared tables (shelf prefixes, schema manifest) |
| `01_icon-asset.js` | The app icon |
| `02_http-and-creator-utils.js` | HTTP helpers and the fetch guard, auth and account helpers, storage helpers (KV/D1), likes, the directory, the schema gate and request metrics |
| `03_admin.js` | The admin page and its data queries |
| `04_config-resolution.js` | Install configs, source detection and the provider registry (`CATALOG_SOURCES`, `PROVIDER_ADAPTERS`, P4-1), the D-8 account rule |
| `05_catalog-core.js` | Stremio catalog/meta building, the channel engine, posters and badges |
| `06_`, `07_` | Provider fetchers (MDBList, Trakt, TMDB, Simkl, JustWatch, TVmaze) and the cron sweeps |
| `08_quickadd-chart-data.js` | Quick Add chart tables |
| `09_`–`24_` | The page shell and the client application (inside `renderBuilder`'s template literal) |
| `25_`, `26_` | Routes (`handleFetch`), the `fetch` / `scheduled` exports |
| `27_installs.js` | Install links: the encrypted-secrets move and `/api/installs` (P3a-8) |
| `28_connections.js` | Provider connections, and catalogs reading them (P3a-9, P3a-10) |
| `29_media.js` | The media resolver: any list item's id to one `media` row (P3b-2) |
| `30_lists-backfill.js` | Copying the legacy lists, likes and anonymous lists into the v2 tables (P3b-3) |
| `31_lists-api.js` | The item-level list API, `/api/lists` (P3b-4) |
| `32_likes-api.js` | The likes API, `/api/likes` (P3b-5) |
| `33_lists-directory.js` | The public list directory and search read from v2 (P3b-6) |
| `34_lists-v2-bridge.js` | The legacy list routes over v2: mirroring every legacy list write into v2, and the rest of the read switch (P3b-7) |
| `35_channels-v2.js` | Shared channels as `channels` rows plus R2 pools: the mirror of every legacy channel write, the reads, Explore Channels as a query, and the copy's channels phase (P3b-8) |
| `41_provider-breaker.js` | The per-provider breaker behind the fetch guard, its `pb:` KV sharing and provider metrics (P4-4) |
| `42_chart-snapshots.js` | Chart snapshots: one shared copy per chart page in KV, served stale-while-revalidate (P4-3) |
| `43_catalog-ids.js` | Canonical ids for every Stremio catalog row, from the row's own ids and the `media` table (P4-2) |

**New server-only areas go in new numbered files after `26_`**, each starting with a comment saying what it owns. They can't go between `09_` and `24_`, which are inside the page's template literal. Top-level names must be unique across every file.

Where the rest of this plan names a module path, it maps to:

| Plan name | Lives in |
|---|---|
| `http/`, `auth/`, `storage/`, `analytics/` | `02_` (with the entry-point middleware in `26_`) |
| `accounts/`, `lists/`, `installs/` routes | `25_`, `26_` |
| `installs/` config and the legacy resolver | `04_` |
| `stremio/`, `channels/engine`, `images/` | `05_` |
| `providers/` | `06_`, `07_`, plus `27_provider-http.js` for `providerFetch` |
| `jobs/` | `07_` and the `scheduled` export in `26_`, plus a new numbered file for the queue consumer when Queues arrive |
| `media/` | `29_media.js` |
| `activity/` | a new numbered file after `26_` when it is built |
| `admin/` | `03_`, and the admin routes in `26_` |
| `frontend/` | `09_`–`24_` |
| `shared/constants` | `00_` |

### 7.3 Keeping "copy one file into the dashboard"

- `python build.py` concatenates `header.js` and every `NN_*.js` file, in order, into `worker_entry_combined.js`. That file is pasted into the dashboard, exactly as today.
- CI runs the build and the drift check, `node --check`, `scope_check.mjs`, the render and HTML checks, the `FUNCTION-MAP.md` check, and `node --test`.
- `/app.js` and `/app.css` keep being split from the rendered page at run time (`splitAppBundle`), memoized per isolate and served with long cache lifetimes.
- D1 migrations are applied from the D1 console, or from CI with Wrangler run through `npx`. The Worker itself is only ever deployed by pasting.

### 7.4 What stays where it is

Nothing moves. The channel engine, air-time formatting, the SVG generators, `jsonForScript`, `escapeHtmlServer` and the provider mappers stay in their current files. New shared helpers (`providerFetch`, the install-config schema, log redaction) are added beside them, not around them.

---

## 8. Phase 16: target architecture

```text
                         Browsers (web app)                     Stremio / Nuvio / Wako / Plex webhooks
                                │  session cookie                        │  /i/{installToken}/...  (+ legacy /{cfgId}/...)
                                ▼                                        ▼
        ┌──────────────────────────────────────────────────────────────────────────────────┐
        │  Cloudflare edge: WAF rate-limit rules · TLS · custom domain mylistsaddon.com     │
        └──────────────────────────────────────────────────────────────────────────────────┘
                                                │
                                                ▼
        ┌──────────────────────────────────────────────────────────────────────────────────┐
        │  ONE Worker  (worker_entry_combined.js — built by build.py, pasted in dashboard)  │
        │   fetch():  router → middleware (security headers, session, CSRF, errors)          │
        │             ├─ /app, /assets/*        embedded, content-hashed frontend            │
        │             ├─ /api/*                 accounts · lists · channels · installs · likes│
        │             ├─ /i/*  /{cfg}/*         Stremio: manifest · catalog · meta · ping     │
        │             └─ /admin/*               admin API + separate admin bundle             │
        │   queue():   job handlers (scrobble, show/chart refresh, imports, purge, posters)  │
        │   scheduled(): dispatcher only (enqueue due work)                                  │
        │   Cache API: per-colo L1 for catalog pages and images                              │
        └──────────────────────────────────────────────────────────────────────────────────┘
             │                │                 │                  │                 │
             ▼                ▼                 ▼                  ▼                 ▼
     ┌─────────────┐  ┌──────────────┐  ┌──────────────┐   ┌─────────────┐   ┌──────────────┐
     │ D1  DB      │  │ D1           │  │ KV  (cache)  │   │ R2          │   │ Queues JOBS  │
     │ (core,      │  │ DB_ACTIVITY  │  │ install      │   │ posters     │   │ + DLQ        │
     │  read       │  │ (+_1.._N     │  │ snapshots,   │   │ channel     │   └──────┬───────┘
     │  replicas)  │  │  shards)     │  │ chart snaps, │   │ pools,      │          │
     │ accounts,   │  │ watch_events │  │ provider     │   │ exports,    │          │
     │ sessions,   │  │ show_progress│  │ cache, mat.  │   │ D1 backups  │          │
     │ installs,   │  │ user_media_  │  │ rows (TTL)   │   └─────────────┘          │
     │ lists,items,│  │ state        │  └──────────────┘                            │
     │ media,      │  └──────────────┘                                              │
     │ channels,   │           ┌──────────────────────┐                             │
     │ likes, FTS, │           │ Analytics Engine     │◄──── writeDataPoint ────────┘
     │ jobs,       │           │ (telemetry, usage)   │
     │ schedule    │           └──────────────────────┘
     └─────────────┘
             ▲
             │ normalized MediaRef / media rows
     ┌───────┴──────────────────────────────────────────────────────────────────────┐
     │ Provider layer: TMDB · Trakt · MDBList · Simkl · TVmaze · Cinemeta ·           │
     │ JustWatch · RapidAPI · btttr.cc   (timeouts, retries, breakers, no credential  │
     │ edge-caching, per-provider quotas)                                            │
     └──────────────────────────────────────────────────────────────────────────────┘
```

**Components:**

| Component | Role | Why it is here |
|---|---|---|
| WAF rate-limit rules | Coarse per-IP limits on `/api/*` writes, login, `/api/save` successors | Stops abuse before it costs Worker CPU. Replaces most KV limiters. |
| Worker `fetch` | HTTP entry. A thin router, with domain modules underneath. | Same deploy model as today |
| Worker `queue` | All non-interactive work | Durable, retried, observable |
| Worker `scheduled` | Enqueues work on a timer | Keeps cron within 30 s CPU (dispatcher) or uses 15 min (hourly/daily) |
| D1 `DB` | All shared and account facts | Single authority, transactions, FTS, replicas |
| D1 `DB_ACTIVITY` (shardable) | High-volume per-user event data | Keeps `DB` small and fast; gives shard headroom |
| KV | Snapshots and caches only | Global edge reads for the catalog hot path |
| R2 | Images, large documents, backups | Cheaper and correct for bytes; no 25 MB KV values |
| Queues | Background execution | Replaces cursors, budgets and `waitUntil` for durable work |
| Analytics Engine | Telemetry | Takes counter writes off D1 |
| Cache API | Per-colo L1 | Cheapest possible repeat reads |
| Provider layer | External IO boundary | One place for timeouts, auth, normalization and quotas |

---

## 9. Phase 18 summary: current users

Detailed in `MIGRATION_PLAN.md` §3. The non-negotiables:

- **Every existing install URL keeps working**, whether it is a `cfg:{id}` KV record, a bare-id KV record or a base64 config.
  - A legacy resolver maps each to an `installs` row with `legacy_cfg_id` on first use.
  - The embedded tokens and keys are migrated into `provider_connections`. They are then stripped from the KV record. The KV record is deleted only after the account's first successful v2 catalog load.
- **Every Creator Key keeps working** as the login credential. Existing hashes are kept.
- **Lists, likes, channels, watch history and presets are backfilled.** The mapping is:
  - `creatorlist:*` and `creator_lists` → `lists` / `list_items`.
  - `list_likes` and `listlikevoters:*` → `likes`.
  - `channelshare:*` and `creatorsyncchannels:*` → `channels` + R2.
  - KV blob and D1 tracking tables → `watch_events` / `show_progress`, using a newest-wins rule per record (the logic `getCreatorList` and `readCreatorTrackingD1` already use) as a one-time reconciliation.
- **Old clients:**
  - The `/api/creator/sync/*` endpoints remain for one release as translation shims.
  - Pushed blobs are diffed against v2 rows and applied as row operations; they never replace data wholesale.
  - `/sync/load` is served from v2 rows.
- **Public URLs keep resolving:** `/lists/:user/:slug`, `/lists/user/:slug` (legacy anonymous), `/channel/:code` and `/channels/:user/:slug` all redirect or resolve through `list_slug_history`.
- **Backups:** the importer accepts every existing backup format. New exports never contain secrets.
