# My Lists — Next Version Architecture

**Date:** 2026-09-24
**Basis:** a fresh read of the source at this commit (header.js + `00_`…`26_`, schema.sql, migrations 0001a–0013, tests, CI, build scripts), a live run of the real Worker through the repo's own harness (`audit/frontend-2026-09-13/server.mjs`: real SQLite-backed D1, in-memory KV, stubbed upstreams), a walkthrough of the rendered UI at desktop and mobile widths, and three instrumented measurements (scripts kept outside the repo). Nothing in the application was changed.

**Product premise for this document:** the official hosted deployment is the only supported deployment. Cloudflare's free tier, self-hosting, and "paste the Worker into the dashboard" deployment are no longer constraints.

Companion documents: `CLOUDFLARE_FREE_TIER_REMOVAL_PLAN.md`, `BACKEND_AUDIT.md`, `FRONTEND_UX_AUDIT.md`, `SECURITY_AUDIT.md`, `PERFORMANCE_AUDIT.md`, `MIGRATION_PLAN.md`, `NEXT_VERSION_TASKS.md`.

---

## 0. The short answer

**If we were starting My Lists today, with the current feature set and tens of thousands of users in view, we would build a server-authoritative application on Cloudflare Workers (edge API + Stremio protocol) backed by managed PostgreSQL (through Hyperdrive), with Cloudflare Queues for background work, R2 for generated assets, and KV/Cache API used strictly as caches.** We would not build what exists today, which is a browser-authoritative, local-first app that replicates JSON blobs into two eventually-consistent-and-partially-consistent stores (KV and D1) and then spends thousands of lines repairing the disagreements.

The twelve things we would do differently, each of which drives a section below:

| # | Today | What we would build |
|---|---|---|
| 1 | The **browser is the system of record**. ~80 `localStorage` keys hold lists, channels, presets, tracking, API keys, OAuth tokens and the account's master key; the server receives whole-array snapshots and runs merge heuristics ("rescue", "empty never overwrites", scrobble queue) to avoid losing data. | **The server is the system of record.** The browser is a client with a cache. Mutations are small operations (add item, remove item, record watch), not full-state uploads. |
| 2 | **Two stores, both authoritative some of the time.** 581 `env.CONFIGS` and 328 `env.DB` references; D1-first reads with KV fallback, dual writes without a transaction, write-back on read, "D1 is behind" markers, tombstones to beat KV propagation. | **One system of record: PostgreSQL.** KV/Cache API only for derived, disposable data. No fallback reads, no dual writes, no repair-on-read. |
| 3 | **Install links are immutable snapshots.** Every `/api/save` mints a new permanent id; every settings change says "Requires Save/Update to take effect on an existing install link" and means "reinstall in Stremio". | **Install links point at a live add-on profile.** Settings and row contents apply on the next catalog request. The URL never changes unless the user revokes it. |
| 4 | **Secrets travel.** The account key is sent in every request body, kept in `localStorage`, stored in plaintext inside install configs (`trackCreatorKey`) and backups; OAuth tokens are returned to the browser, stored in install configs, returned by `/api/resolve` and rendered into `/:config/configure` HTML. | **Sessions for the website, scoped revocable tokens for installs and webhooks, and a server-side encrypted token vault** for provider credentials with refresh handling. Nothing secret in a URL, a backup file, or `localStorage`. |
| 5 | **Watch tracking is a blob.** Every scrobble or autosave rewrites the whole history (measured: 2,012 D1 statements to add one item to a 2,000-item history). | **Append-only `watch_events`** plus derived progress. One scrobble = one insert. |
| 6 | **Per-user cron sweeps** walk `creator:` KV keys 25 accounts per 6-minute tick (Airing Next: 3 per tick) and call TMDB per user per show. | **Per-show schedules** refreshed once and shared by every user; Continue Watching / Airing Next become SQL over `watch_events` × `episodes`. |
| 7 | **~140 raw `fetch()` call sites** into providers, each with its own caching, error handling and (mostly absent) timeout; several overlapping TMDB detail caches. | **One provider layer** per provider (client + mapper + rate limiter + retry/timeout policy) feeding a **normalized `media` catalog** shared by every feature. |
| 8 | **Cron budget arithmetic** (`CRON_SUBREQUEST_BUDGET`, shares, cursors) exists to fit one 50-subrequest invocation. | **Cron enqueues; queues work.** Idempotent jobs, retries with backoff, dead-letter queue, a `jobs` table for anything user-visible (imports). |
| 9 | **A 2.0 MB inline-bundled client** built by concatenating 27 files into one scope inside a template literal; 285 KB HTML with every tab pre-rendered; 3,430 DOM nodes and 624 buttons at first paint. | **A normal modular SPA** (TypeScript, Vite, components, per-tab code splitting) served as static assets; small server-rendered pages only where SEO needs them. |
| 10 | **Channels and custom lists are embedded as JSON inside catalog-row URLs** (`channel:v1:<JSON>`, `customlist:v1:<JSON>`) and therefore inside install configs. | **First-class `channels` and `lists` records referenced by id.** |
| 11 | **Analytics in the primary database** (`stats` as an unbounded key/value counter table also used for events, search terms, API usage and auth failures). | **Workers Analytics Engine** for events and counters; small daily rollup tables only for product features (Most Watched). |
| 12 | **A single 14,500-line `handleFetch` function** spanning two files, ~150 routes in an if-chain, generated `worker_entry_combined.js` committed to git, and five bespoke scripts to keep the concatenation honest. | **TypeScript modules, a router (Hono), feature-oriented folders**, a bundler; the deploy artifact is built in CI and never committed. |

The rest of this document justifies each row, compares the realistic alternatives, and specifies the target.

---

## 1. Phase 1 — Repository inventory

### 1.1 Files

| Group | Files | Size | What it really is |
|---|---|---|---|
| Worker preamble | `header.js` | 3 KB | Doc comment. States "stateless… No database, no server-side auth" — no longer true. |
| Server modules | `00_constants.js`, `01_icon-asset.js`, `02_http-and-creator-utils.js`, `03_admin.js`, `04_config-resolution.js`, `05_catalog-core.js`, `06_source-fetchers-mdblist-trakt.js`, `07_source-fetchers-tmdb-simkl.js`, `08_quickadd-chart-data.js` | ~1.2 MB | Constants/budgets, base64 PNG icon, HTTP/auth/storage helpers, admin dashboard (HTML + its own client app) and counters, config resolution, catalog pipeline + channels + SVG generators, provider fetchers, cron jobs, chart tables. |
| Page shell + tab markup | `09_page-shell.js` … `15_tab-settings-html.js` | ~260 KB | Fragments of one template literal returned by `renderBuilder()`: 107 KB of CSS, the shell, six tabs' HTML. |
| Client bundle | `16_client-row-core.js` … `24_client-backup-restore-presets.js` | ~2.0 MB | ~820 global functions in one scope, extracted at runtime into `/app.js`. `20_client-channel-builder.js` alone is 507 KB / 13,263 lines. |
| Router | `25_api-catalog-routes.js`, `26_api-creator-and-admin-routes.js` | ~750 KB | One function, `handleFetch` (25:165 → 26:7263), ~150 routes; `export default { fetch, scheduled }` at 26:7269. |
| Generated | `worker_entry_combined.js` | 4.25 MB / 88,368 lines | `header.js` + numbered files concatenated byte-for-byte. Committed; CI fails on drift. |
| Schema | `schema.sql`, `migrations/0001a…0013` (14 files) | — | 20 tables incl. one FTS5 virtual table. Applied by hand (dashboard console or `wrangler d1 execute`). |
| Build/verify | `build.py`, `build.ps1` (duplicates the header by hand), `check_sync.py`, `verify.sh`, `render_check.js`, `html_checks.py`, `scope_check.mjs`, `extract_html.py`, `gen_map.py` | — | Concatenation plus four validators that exist because the code is a template literal in a single scope. |
| Tests | 19 files under `tests/` + two harnesses | ~1.4 MB | **1,212 tests, 1,211 pass, 1 skipped, 0 fail, 146 s** (run during this audit). `worker.test.mjs` (13,240 lines) and `client.test.mjs` (7,977 lines) dominate. |
| Audit probes | `audit/**` (≈170 `.mjs`/`.sh`/`.py` files) | — | Executable reproductions from seven earlier audits. Not wired into CI. |
| CI | `.github/workflows/ci.yml` | — | Rebuild + drift check, `node --check`, scope check, render/hostile-render checks of builder/admin/SW, FUNCTION-MAP drift, full test suite. No deploy job. |
| Docs | `README.md` (self-hosting guide, "Which Cloudflare plan do I need?"), `CHANGELOG.md` (259 KB), `Changes.md` (168 KB), `COMPLETE_AUDIT_REPORT.md`, `UI_UX_AUDIT.md`, `STORAGE-PLAN-KV-D1.md`, `FUNCTION-MAP.md` (generated), `crossover_and_companion_guide.md`, `docs/history/*` (17 files) | ~1.8 MB | |
| Config | `wrangler.toml` (placeholder ids, budgets, one cron), `.gitignore`, `.gitattributes` | — | No `package.json` is committed (it is git-ignored); the only npm deps are `acorn` and `eslint-scope`, installed ad hoc in CI. |

### 1.2 Runtime inventory

| Category | Inventory |
|---|---|
| **Bindings** | `CONFIGS` (KV), `DB` (D1). No R2, Queues, DO, Analytics Engine, Hyperdrive, rate-limit bindings. |
| **Env vars (plain)** | `BULK_RESOLVE_SUBREQUEST_BUDGET`, `DETAILS_BATCH_SUBREQUEST_BUDGET`, `CRON_SUBREQUEST_BUDGET`, `NEW_ON_STREAMING_ENGINE`. |
| **Secrets** | `ADMIN_KEY`, `TMDB_API_KEY`, `TRAKT_CLIENT_ID`, `TRAKT_CLIENT_SECRET`, `MDBLIST_API_KEY`, `MDBLIST_POPULAR_KEY`, `MDBLIST_CLIENT_ID`, `MDBLIST_CLIENT_SECRET`, `SIMKL_CLIENT_ID`, `SIMKL_CLIENT_SECRET`, `RAPIDAPI_KEY` / `STREAMING_AVAILABILITY_API_KEY`. Mirrored into module-level `let` globals on every request by `applyEnvApiKeys` (00:650). |
| **Scheduled jobs** | One cron (`*/6 * * * *`) running eight tasks with budget arithmetic (26:7308–7430): `checkForNewEpisodes`, `sweepNewOnStreaming`, `refreshAiringNextSweep`, `prewarmBetterPosters`, `bumpNewOnStreamingEpisodes`, `prewarmSharedCatalogs`, `prewarmChannelPresets`, D1 schema check, `pruneTombstones`. |
| **Request-triggered background work** | `ctx.waitUntil` for: playback tracking (`handleSubtitlesTrack`), channel live-pool rebuilds, channel "new episodes" rebuilds, stale BetterPoster refresh, stats bumps, `lastgood:` writes, rate-limit counters. Per-isolate `Set`s are the only dedupe. |
| **D1 tables** | `creators`, `creator_lists`, `creator_key_lookups`, `source_groups`, `stats`, `creator_tombstones`, `published_lists`, `lists_fts` (FTS5), `list_tombstones`, `list_likes`, `feedback`, `scrobble_tokens`, `event_meta`, `watch_history`, `continue_watching`, `airing_next`, `creator_user_lists`, `creator_show_states`, `creator_tracking_meta`, `streaming_events`. |
| **KV namespaces (≈60 prefixes)** | Identity: `creator:`, `creatorlastseen:`, `creatordeleted:`, `creatorreset:`, `keylookup:`, `creatorlookuphash:`, `scrobbletoken:`, `creatorscrobbletoken:`. Lists: `creatorlist:`, `creatorlistorder:`, `creatorliststamp:`, `creatorlistdeleted:`, `publishedlist:user:`, `listlikevoters:`, `extlikevoters:`, `channellikevoters:`. Sync blobs: `creatorsync:`, `creatorsynctracking:`, `creatorsyncpresets:`, `creatorsyncchannels:`, `creatorscrobblequeue:`, `trackingd1behind:`, `airingnextchecked:`, `creatorshare:`, `creatortrack:`, `scrobbleseenusers:`. Channels: `channelshare:`, `creatorchannel:`, `index:publicchannels`, `channelpool:`, `channelnew:`, `channel:preset:v2:`. Install configs: `cfg:` and **bare 12-char ids**. Caches: `cache:*` (circuit breaker), `tmdbdetail_v2:`, `tmdb:itemdetails:v3:`, `tmdb:season:`, `unpacked_show:`, `tvmaze:airtime:v3:`, `mylists:mostwatched:v2:`, `lastgood:`, `bpimg:v1:` (binary poster copies), `bp:retry:v1`, `bp:variants:v1`, `bp:sharedids:v1`. Counters/telemetry (KV path): `stats:*`, `evtcount:`, `evtdayindex:`, `evtmeta:`, `searchquery:`, `searchquerydayindex:`, `authfail:`. Rate limits: `ratelimit:*`, `resetkeyrate:`, `feedbackrate:`. Cron state: `cron:*:cursor`, `cron:last_warmed:mdblist`, `cron:rapidapi:usage`, `cron:newonstreaming:*`, `migrated1:state`, `migratedaycounts:state`, `backfilltrending:cursor`. Legacy: `creatorprofile:`, `creatorpresets:`, `creatorchannels:`, `creatorlistlikes:`, `creatorlikes:`, `index:publiclists*`, `feedback:`. |
| **Caches** | Per-isolate: `PER_USER_CACHE_MAP` (1,000 entries), `IN_FLIGHT_FETCHES`, `CREATOR_AUTH_MEMO`, `BUILDER_PAGE_MEMO`, `BUILDER_ETAG_MEMO`, `SPLIT_PAGE_MEMO`, `APP_BUNDLE`, `APP_CSS`, `UNPACKED_SHOW_CACHE`, BetterPoster miss/in-flight maps. Edge: `caches.default` synthetic keys + `cf.cacheTtl` on ~150 fetches. KV: the cache prefixes above. |
| **Rate limiters** | `consumeRateLimit` (KV read-then-write, 02:1698): `creatorauth`, `bulkresolve`, `resolveproxy`, `bpwarm`, `feedbackthreads`. Inline copies of the same pattern: `ratelimit:preview` (240/min), `ratelimit:save` (20/min), `ratelimit:creatorcreate` (1/min), `ratelimit:creatorrestore` (20/min), `ratelimit:forgotusername`, `ratelimit:adminlogin`, `ratelimit:trackevent`, `ratelimit:tracksearch`, `resetkeyrate:` (10/day), `feedbackrate:`. D1 daily failure budgets via `stats` (`authfail:*`). All keyed on `CF-Connecting-IP` (IPv6 collapsed to /64). |
| **External APIs** | TMDB v3/v4 (details, find, search, discover, trending, seasons, episode groups, collections, recommendations, similar, people, providers, lists, TMDB account via v3 request-token sessions), Trakt (lists, users, watchlist, history, sync, charts, search, OAuth code + device flows, list write APIs), MDBList (public JSON feeds, `api.mdblist.com` top lists / watchlist (four endpoints guessed in turn) / sync/watched / list writes, OAuth + PKCE), Simkl (charts, user lists, OAuth), JustWatch GraphQL (unofficial, no key), RapidAPI Streaming Availability `/changes`, TVmaze (air times), Metahub/Cinemeta (posters, unpacked series), btttr.cc (BetterPosters), YouTube (trailer iframes), jsDelivr (`fflate`), Google Fonts, stremio-addons.net (signed manifest). Letterboxd is **file import only** (CSV/ZIP parsed client-side, titles resolved through `/api/bulk-resolve`). |
| **OAuth flows** | Trakt authorization-code (25:3290) and device-code (25:3448); MDBList authorization-code + PKCE (25:3568); Simkl authorization-code (25:3714); TMDB v3 request-token session (25:5136). **No refresh tokens are stored anywhere.** Tokens are handed to the browser in a URL fragment and kept in `localStorage`. |
| **Client persistence** | ~80 `myListAddon:*` localStorage keys (61 after a brief session in the live run) including `creatorKey`, every provider access token, custom lists, channels, merged channels, presets, watch history caches, airing schedule caches, sync baselines, deletion tombstones, UI state. Service worker caches (`mylists-assets-v2`, `mylists-shell-v2`). |
| **Generated/bundled artifacts** | `worker_entry_combined.js` (committed), `FUNCTION-MAP.md` (committed, drift-checked), `/app.js` and `/app.css` (extracted from the rendered HTML at runtime and memoized per isolate), `/sw.js` (template literal), `/icon.png` (base64 in source), all SVG posters (generated per request). |

### 1.3 API surface (≈150 routes, one if-chain)

Grouped here; `FUNCTION-MAP.md` has line numbers.

* **Stremio protocol (public, CORS \*)**: `/{config}/manifest.json`, `/manifest.json`, `/{config}/catalog/{type}/{id}[/{extra}].json` (incl. search catalogs), `/{config}/meta/{type}/{id}.json`, `/{config}/subtitles/{type}/{id}.json` (used only as a playback ping).
* **Pages**: `/`, `/configure`, `/{config}/configure`, `/lists/{slug}`, `/lists/curated/{slug}`, `/lists/{user}/{slug}[.json]`, `/lists/{mdblist|trakt|tmdb}/…`, `/channel/{code}`, `/channels/{user}/{slug}[.json]`, `/guide`, `/admin`, `/robots.txt`, `/sitemap.xml`, `/app.webmanifest`, `/sw.js`, `/app.js`, `/app.css`, `/icon.png`.
* **Images**: `/api/poster-badge`, `/api/channel-poster`, `/api/channel-logo`, `/api/safe-poster`, `/unavailable-poster.svg`, `/bp/{style}/{imdb}.jpg`, `/api/bp/warm`, `/api/poster-fallback`.
* **Provider proxies (unauthenticated)**: `/api/preview`, `/api/toplists`, `/api/season`, `/api/title-search`, `/api/show-seasons`, `/api/show-episodes`, `/api/details`, `/api/details/batch`, `/api/resolve-movie`, `/api/resolve-show`, `/api/imdb-ids`, `/api/recommendations`, `/api/person-*`, `/api/wizard-channel-shows`, `/api/quick-channel-shows`, `/api/channel-preset`, `/api/channel-lineup`, `/api/tmdb-search-lists`, `/api/trakt-search`, `/api/trakt-popular-lists`, `/api/bulk-resolve`.
* **Provider proxies with the user's tokens in the request body**: `/api/trakt-my-lists`, `/api/trakt-my-private-lists`, `/api/trakt-history-raw`, `/api/mdblist-my-lists`, `/api/mdblist-history-raw`, `/api/simkl/my-lists`, `/api/tmdb-my-lists`, `/api/external-list/{item-mutate,item-add,item-remove,create,delete}`, `/api/external-sync/history`.
* **OAuth**: `/api/{trakt,mdblist,simkl,tmdb}/oauth/{start,callback}`, `/api/trakt/device/{code,token}`.
* **Install configs**: `/api/save`, `/api/resolve`, `/api/track-install`.
* **Account ("creator")**: `/api/creator/{create,restore,reset-key,recovery-answer,forgot-username,scrobble-token,scrobble-seen-users,track-status,account/reset,delete-account}`, `/api/creator/lists{,/items,/save,/delete,/reorder}`, `/api/creator/sync/{save,save-tracking,save-presets,save-channels,meta,load,like,share-tracking}`.
* **Social/public**: `/lists/public.json`, `/api/public-lists.json`, `/api/search-published-lists`, `/api/lists/like`, `/api/lists/like-external`, `/api/channel/{share (GET/POST),directory,like,added,mine,unpublish}`.
* **Telemetry/feedback**: `/api/track-event`, `/api/track-search`, `/api/feedback`, `/api/feedback/threads`.
* **Webhooks**: `/api/scrobble[/plex|/jellyfin|/emby|/webhook]`.
* **Admin (cookie session)**: `/admin`, `/admin/login`, `/admin/logout`, and 30 `/admin/api/*` routes (analytics, leaderboard, backfill-trending, migrate-d1, migrate-day-counts, rebuild-search-index/public-index, creator-lists, delete-creator-list, published-lists, delete-published-list, published-channels, channel-moderate, reset-creator-key, schema-status, feedback CRUD, apiusage, netflix-preview, provider-lookup, new-on-streaming CRUD/sweep/preview, channel-presets CRUD).

### 1.4 Dependency map — Frontend → API → logic → storage → providers

```
                     ┌───────────────────────────────────────────────────────────────┐
 Browser SPA         │ ~80 localStorage keys = the real system of record for most    │
 (2.0 MB app.js,     │ users: lists, channels, presets, tracking, API keys, OAuth     │
  ~820 globals)      │ tokens, account key. Computes Airing Next, Continue Watching,  │
                     │ recommendations, dedupe; pushes "snapshots" to the server.     │
                     └──────┬───────────────┬────────────────┬───────────────┬────────┘
        full-state blobs    │   per-list    │  provider      │  install      │ OAuth
        /api/creator/sync/* │   /creator/   │  proxies w/    │  /api/save    │ token → URL
                            │   lists/*     │  user tokens   │  → cfg:{id}   │ fragment → LS
                            ▼               ▼                ▼               ▼
 ┌────────────────────────────────────────────────────────────────────────────────────┐
 │ handleFetch (14.5k lines, ~150 routes). Route blocks contain the business logic:     │
 │  • sync merge heuristics (save-tracking: rescue, empty-guard, scrobble queue)       │
 │  • list save, order merge, orphan sweep, tombstones, stamps                          │
 │  • likes ledger, channel share/directory, feedback threads                           │
 │  • provider calls inline (82 raw fetch() in 25_, 11 in 26_)                          │
 │ authenticateCreator → getCreator (D1 read + KV WRITE) → PBKDF2 (memoized per isolate)│
 └────┬──────────────────────────────┬───────────────────────────┬─────────────────────┘
      │                              │                           │
      ▼                              ▼                           ▼
 ┌───────────────┐  dual-write,  ┌────────────────┐      ┌────────────────────────────┐
 │ KV (CONFIGS)  │◄─ repair on ─►│ D1 (DB)        │      │ Providers: TMDB, Trakt,    │
 │ 581 refs      │   read, KV    │ 328 refs       │      │ MDBList, Simkl, JustWatch, │
 │ configs, blobs│   fallback    │ mirror of lists│      │ RapidAPI, TVmaze, Metahub, │
 │ caches, rate  │   when D1     │ tracking, likes│      │ btttr.cc                   │
 │ limits, cron  │   returns 0   │ counters, FTS  │      │ ~140 raw fetch sites,       │
 └───────────────┘   rows        └────────────────┘      │ ~20 via circuit breaker     │
      ▲                                ▲                  └────────────────────────────┘
      │                                │                               ▲
 ┌────┴────────────────────────────────┴───────────────────────────────┴───────────────┐
 │ Stremio/Nuvio/Wako → /{cfg}/catalog → resolveConfig (KV) → fetchCatalog dispatch     │
 │   → 30 source kinds → provider or KV/D1 → badges/BetterPosters/adult filter          │
 │   → dedupeAcrossLists refetches every earlier row (measured: row 20 = 20 fetches)     │
 │ scheduled() */6 → 8 tasks sharing a subrequest budget, KV cursors over creator: keys │
 └──────────────────────────────────────────────────────────────────────────────────────┘
```

**Where responsibilities are mixed** (each is a finding in `BACKEND_AUDIT.md`):

1. **Business rules live in the client and are re-implemented on the server.** Airing Next (client `refreshAiringNext` vs server `rebuildAiringNextForRecord`), recommendations (client Discover vs `buildTmdbRecommendations`), Continue Watching dedupe (client `dedupeContinueWatchingItems` vs server `trackingShowKey`), cross-list dedupe (client `renderLivePreview` vs `dedupeAcrossListEntries`).
2. **Route blocks are the domain layer.** `/api/creator/sync/save-tracking` is 460 lines of merge policy inside the router (26:3133–3592). `/api/creator/lists/save` does validation, slug allocation, conflict detection, dual-store writes, order merging, tombstone clearing, stamp bumping and FTS maintenance inline (26:2126–2455).
3. **Catalog fetchers mix five concerns**: provider access, normalization, caching, presentation (badges, BetterPosters, adult filter) and authorization (`mayReadTrackedShelf` inside `fetchAutoTrackedCatalog`).
4. **Storage access is scattered.** There is no repository layer; every route talks to KV and D1 directly.
5. **The admin dashboard is a second client app** (4,400 lines, HTML + JS in a template literal) inside a server module.

### 1.5 Duplicated implementations

| Concern | Copies |
|---|---|
| Record a watch | `handleSubtitlesTrack` (26:155), `handleMediaServerScrobble` (26:548), client mark-watched, cron `checkForNewEpisodes` CW recompute (07:4765). |
| D1 row → tracking object | `readCreatorTrackingD1` (02:4639) and three variants inside `fetchAutoTrackedCatalog` (05:1996–2209), including three copies of the fully-watched filter. |
| TMDB "details" | `fetchTmdbDetails` (07:389, cache `tmdbdetail_v2:`), `fetchTmdbItemDetails` (07:3763, cache `tmdb:itemdetails:v3:`), `fetchStandardItemMeta`, `fetchTmdbSeasonDetails`, `mapStoredRecommendationToMeta`, inline sequences in `buildChannelPoolFromListUrl`, `fetchShowEpisodesAfter`, `/api/bulk-resolve`, the Plex/Jellyfin handler. |
| Public directory | `getPublicListIndex` (D1 + KV fallback), `/lists/public.json` legacy KV scan, `/api/search-published-lists` FTS + index + KV scan, admin community-lists panel. |
| Rate limiting | `consumeRateLimit` plus ≥8 inline copies. |
| Watchlist | Three copies (tracking blob, `creatorlist:{u}:watchlist` in KV, D1 row) reconciled by `readAccountWatchlist`. |
| Likes | List ledger, external-URL ledger, channel ledger, plus `creator_user_lists` "liked". |
| SVG posters | `generateChannelPosterSvg`, `generateChannelBackdropSvg`, inline SVG in `/api/channel-logo`, `generateBadgedPosterSvg`, `generateSafePosterSvg`. |
| Build | `build.py` vs `build.ps1` (header text duplicated by hand). |

---

## 2. Architecture options (Phase 3)

The goal is the best combination of simplicity, reliability, performance, scalability, maintainability and cost for **this** workload:

* **Edge-shaped traffic**: Stremio-protocol clients (TV apps, phones) request manifests and catalog pages from everywhere; most rows are shared charts that cache perfectly; personal rows are small queries.
* **Relational core**: accounts, lists and items, likes, follows, channels, add-on rows, watch events, show progress, directory and search.
* **Background work**: per-show episode schedules, provider chart refreshes, New on Streaming sweeps, poster mirroring, imports, provider history sync, token refresh.
* **Third-party rate limits**: TMDB, Trakt, MDBList (1,000 req/day tiers), Simkl, RapidAPI (1,000/month), btttr.cc.
* **Team**: effectively one maintainer plus AI assistants. Operational simplicity is a first-class requirement.

### 2.1 Options considered

| | A. Cloudflare-native, paid (Workers + D1 + KV + Queues + DO + R2) | **B. Workers + managed PostgreSQL via Hyperdrive + Queues + R2** | C. Node.js service (Hono/Fastify on Fly/Render/ECS) + PostgreSQL + Redis + BullMQ, Cloudflare CDN in front |
|---|---|---|---|
| **System of record** | D1 (SQLite). | PostgreSQL (Neon, Supabase or Crunchy Bridge). | PostgreSQL. |
| **Fits the scale target?** (100k users, 1M public lists, tens of millions of list items, large histories) | **No, not in one database.** A single D1 database is size-capped (10 GB at the time of writing — verify), single-writer, with a 2 MB row limit that already shaped the product (`CREATOR_LIST_BYTES_MAX = 1.8 MB`). 50M list items (~5 GB with indexes) plus 200M watch events (~30–40 GB) exceed it. Sharding by user makes every cross-user feature (directory, likes, search, Most Watched) a fan-out. | **Yes.** Hundreds of GB is routine; partitioning for `watch_events`; real FTS (`tsvector`/`pg_trgm`); transactions, row locks, `ON CONFLICT`, materialized views. | Yes. |
| **Edge latency for Stremio clients** | Excellent (D1 read replicas in beta). | Excellent for cached rows (Cache API at every colo); personal rows add one Hyperdrive round trip to the DB region (pooled; read caching available). Smart Placement for DB-heavy routes. | Regional. Fine behind a CDN for shared rows; personal rows pay a full round trip to the region. |
| **Background work** | Queues, Cron, Workflows. | Same. | BullMQ/Redis workers; unlimited duration; one more thing to operate. |
| **Operations** | Lowest. | Very low (managed DB with PITR/branching; everything else serverless). | Highest: containers, autoscaling, Redis, deploys, patching. |
| **Migration effort from today** | Lowest data move, but the schema must still be redesigned; the D1 size ceiling returns as the next rewrite. | Moderate: data moves once; HTTP layer and Stremio routes stay on Workers. | Highest: runtime change plus data move. |
| **Portability / exit** | Locked to D1. | High: Hono + Postgres + a queue interface run on Node unchanged if ever needed. | High. |
| **Cost (order of magnitude)** | Lowest. | Low: Workers Paid base + a managed Postgres tier (tens of dollars/month at launch scale) + Queues/R2 usage. | Highest baseline (always-on instances + Redis). |

A fourth option, a backend-as-a-service (Firebase, Supabase Edge Functions + Auth), was rejected: it would replace the auth model, add platform lock-in, and does not simplify the Stremio protocol surface, which is the part that must be fast and global. Supabase remains a reasonable **host** for the Postgres in option B.

### 2.2 Recommendation: Option B

**Cloudflare Workers stays as the runtime; the database changes.** Reasons, in order of weight:

1. **The pain in this codebase is almost entirely storage-model pain, not runtime pain.** Once free-tier limits are gone, Workers' remaining constraints are generous (CPU is configurable to minutes on Paid; Queues and Workflows cover long work). What cannot be fixed by paying is that KV is eventually consistent and D1 is one size-capped SQLite file.
2. **The Stremio protocol is an edge workload.** Most catalog rows are shared and cacheable per colo. A Worker with the Cache API serves those in single-digit milliseconds worldwide without any servers.
3. **PostgreSQL removes whole categories of code**: tombstones for propagation windows, "D1 is behind" markers, write-back-on-read, dual writes, KV fallbacks, hand-built indexes, `LIKE`-based prefix scans on a key/value counter table, byte caps derived from row limits.
4. **It is the cheapest path to a correct system** that the team can still operate alone, and it keeps an exit: the same code runs on Node if Workers ever stops fitting.

**What stays on Cloudflare and why:**

| Service | Role in the new architecture | Why |
|---|---|---|
| Workers (Paid) | API, Stremio protocol, public pages, cron entry points, queue consumers. | Global, no servers, existing expertise and tests. |
| Workers Static Assets | The SPA (`/assets/*` hashed), `icon.png`, fonts. | Removes runtime bundle extraction, page memos and the 1.6 MB template literal. |
| Hyperdrive | Pooled, cached connection from Workers to PostgreSQL. | Makes a regional Postgres usable from the edge. |
| Queues (+ DLQ) | All background work. | Retries, batching, backoff, no cron slicing. |
| Cron Triggers | Enqueue-only schedulers. | Several schedules instead of one budgeted tick. |
| R2 | BetterPoster mirror, generated badge/channel artwork, user backups/exports, import uploads. | Binary blobs do not belong in KV (`bpimg:v1:` stores images today) or Postgres. |
| Cache API | Per-colo HTTP cache for shared catalog pages, manifests of public rows, images. | Cheapest, fastest tier. |
| KV | **Only** read-mostly derived data that can be rebuilt: chart snapshots, normalized provider pages, feature flags. | Global replication for rarely-written data is what KV is good at. |
| Workers Analytics Engine | Page views, installs, API usage, catalog-add and watch telemetry, search terms. | Replaces the unbounded `stats` table and every KV counter. |
| Rate Limiting (WAF rules + Workers rate-limit binding) | Per-IP and per-account throttles. | Atomic and cheap; replaces KV read-then-write counters. |
| Durable Objects | **Not needed initially.** Candidate later for live sync push (one DO per account) if polling becomes a cost. | Postgres provides the serialization the DO would otherwise give. |

---

## 3. Target architecture

```
                         Stremio / Nuvio / Wako apps              Browsers (SPA + public pages)
                                   │                                         │
                                   ▼                                         ▼
                ┌──────────────────────────────────────────────────────────────────────────┐
                │                  Cloudflare edge (WAF, rate limits, TLS)                  │
                └─────────────────────────────────┬────────────────────────────────────────┘
                                                  │
        ┌─────────────────────────────────────────▼──────────────────────────────────────────┐
        │  Worker: "api"  (TypeScript, Hono router, feature modules)                          │
        │                                                                                     │
        │  /stremio/*   manifest · catalog · meta · subtitles-ping   ──► Cache API (shared)  │
        │  /api/v2/*    accounts · sessions · lists · channels · addon profiles · tracking   │
        │               · providers (OAuth, connections) · search · directory · imports      │
        │  /p/*         server-rendered public list/channel pages (small HTML, OG tags)      │
        │  /admin/api/* admin (separate auth, audit log)                                     │
        │  legacy/*     /{cfgId}/…, /{base64}/…, /lists/:u/:s, /channel/:code (forever)      │
        │                                                                                     │
        │  domain services ─► repositories ─► Postgres (Hyperdrive)                           │
        │                  └► provider layer ─► normalized media catalog                      │
        │                  └► queue producer                                                  │
        └───────┬──────────────────────┬──────────────────────┬───────────────────┬──────────┘
                │                      │                      │                   │
                ▼                      ▼                      ▼                   ▼
      ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐  ┌────────────────┐
      │ PostgreSQL       │   │ Cloudflare Queues│   │ R2               │  │ KV / Cache API │
      │ (Neon/Supabase)  │   │ provider-refresh │   │ posters/, art/,  │  │ chart snapshots│
      │ system of record │   │ show-schedule    │   │ exports/,        │  │ provider pages │
      │ + FTS, PITR      │   │ imports, posters │   │ imports/         │  │ flags          │
      │                  │   │ provider-sync    │   └──────────────────┘  └────────────────┘
      │                  │   │ webhooks, tokens │
      └────────▲─────────┘   │ + DLQ            │          ┌──────────────────────────────┐
               │             └────────┬─────────┘          │ Workers Analytics Engine     │
               │                      ▼                    │ events, counters, API usage  │
               │        ┌──────────────────────────┐       └──────────────────────────────┘
               └────────│ Worker: "jobs"           │
                        │ queue consumers + cron    │──────► Providers (TMDB, Trakt, MDBList,
                        │ (enqueue-only schedules)  │        Simkl, JustWatch*, RapidAPI,
                        └──────────────────────────┘        TVmaze, btttr.cc) via provider layer
```

\* JustWatch's GraphQL API is unofficial and unkeyed (see `SECURITY_AUDIT.md` S-19); keep it behind a feature flag until its terms are settled.

### 3.1 Components

| Component | Responsibility | Notes |
|---|---|---|
| **api Worker** | All HTTP. Stateless. Stremio routes are thin: resolve install token → load add-on profile (cached per colo for 30–60 s) → for each row, read a cached catalog page or run the row's source through the catalog service. | Keeps the existing `withSecurityHeaders` idea as middleware; explicit cache policy per route instead of a JSON default. |
| **jobs Worker** | Queue consumers and cron handlers. No HTTP except a health check. | Separate so a runaway job can never slow the API; separate CPU limits and observability. |
| **PostgreSQL** | Everything authoritative. | Region near most users (US East, given the US default region and Eastern-time rollups). PITR enabled; a staging branch for migrations. |
| **Hyperdrive** | Connection pooling and optional query caching. | Cache only safe, public reads (directory pages), never account data. |
| **Queues** | `provider-refresh`, `show-schedule`, `user-progress` (optional), `imports`, `posters`, `provider-sync`, `token-refresh`, `webhooks`; one dead-letter queue. | Messages are idempotent (`dedupe_key`); consumers use advisory locks or `INSERT … ON CONFLICT DO NOTHING` job claims. |
| **R2** | `posters/bp/{variant}/{imdb}.jpg`, `art/badge/{hash}.webp`, `exports/{account}/{id}.json`, `imports/{job}/{file}`. | Public bucket behind a custom domain for images; private for exports/imports (signed URLs). |
| **KV** | `chart:{provider}:{key}:{region}:{page}` snapshots (SWR metadata in the value), `flags`. | Written by jobs only. Nothing a user writes goes to KV. |
| **Analytics Engine** | Datasets: `web_events`, `addon_events`, `provider_calls`, `watch_signals`. | Admin dashboards query via the SQL API; Most Watched rollups are computed daily into Postgres. |
| **Observability** | Workers Logs/Logpush (structured JSON), Sentry (or Workers-native error tracking), queue depth/age alerts, provider error-rate alerts. | Today the only operational signal is `console.error`. |

### 3.2 Identity, sessions and tokens

| Credential | Today | Next version |
|---|---|---|
| Account login | Username + `MYL-XXXX-XXXX-XXXX` key, sent in **every** request body; key kept in `localStorage`; PBKDF2 on every uncached request. | Keep the key as a **login credential** (existing users keep working; hashes migrate as-is) and add passkeys and optional email later. Login exchanges it for a **session**: `__Host-` HttpOnly, Secure, SameSite=Lax cookie; server-side `sessions` table; list and revoke devices. PBKDF2 runs once per login. |
| Stremio install | 12-char `cfg:` id (unauthenticated snapshot incl. tokens and account key) or base64 config. | **Add-on token**: 128-bit random, stored hashed, scoped to one add-on profile, read-only, revocable, `last_used_at` tracked. URL: `/{token}/manifest.json` with a distinguishable prefix (e.g. `a1_…`). |
| Media-server webhooks | Scrobble token (good) or legacy `creator=&key=` in the query string. | Scrobble token only (hashed at rest); legacy creator+key form accepted for a sunset period, then removed. |
| Provider OAuth | Access token returned to the browser; no refresh token; stored in `localStorage`, install configs, `creatorsync.keys`, backups. | **Server-side vault**: `provider_connections` with AES-GCM-encrypted access and refresh tokens (key in Workers Secrets, key id per row for rotation); the browser only sees "connected as X". A `token-refresh` job renews before expiry. Disconnect revokes upstream where supported. |
| Admin | One shared `ADMIN_KEY`, stateless HMAC cookie valid 7 days, no revocation. | Admin accounts (flag on `accounts`) + session + TOTP/passkey (or Cloudflare Access in front of `/admin`), `admin_audit_log`. |

### 3.3 Storage model (Phase 4 conclusion)

**Authoritative:** PostgreSQL, for everything a user or the product creates.
**Derived and disposable:** KV (chart snapshots), Cache API (HTTP), R2 (mirrored images), in-isolate LRU.
**Never authoritative again:** the browser.

The per-data-type audit behind this (authoritative source, duplication, staleness, failure behavior, consistency needs) is in `BACKEND_AUDIT.md` §6. The target schema:

```sql
-- identity
accounts(id uuid pk, username citext unique, display_name, key_hash, key_lookup_hash unique,
         recovery_answer_hash, is_admin bool, created_at, last_active_at, reset_at, deleted_at)
sessions(id uuid pk, account_id fk, token_hash unique, created_at, last_used_at, expires_at,
         revoked_at, user_agent, ip_prefix_hash)
username_holds(username citext pk, released_at)            -- cooldown after deletion
provider_connections(account_id fk, provider, external_user_id, external_username,
         access_token_enc, refresh_token_enc, key_id, expires_at, scopes, status, last_error,
         updated_at, pk(account_id, provider))
scrobble_tokens(token_hash pk, account_id fk, created_at, last_used_at, revoked_at)

-- media catalog (shared by everyone; filled by the provider layer and jobs)
media(id bigserial pk, kind enum('movie','series'), imdb_id unique, tmdb_id, tmdb_kind,
      title, year, poster_path, backdrop_path, genres text[], certification, adult bool,
      runtime, vote_average, status, updated_at, refreshed_at)
episodes(series_id fk media, season int, episode int, tmdb_episode_id, title, air_date date,
         air_time, still_path, is_finale bool, pk(series_id, season, episode))
series_schedule(series_id pk, next_refresh_at, last_refreshed_at, tracked_by_count int)

-- lists
lists(id uuid pk, owner_id fk accounts null, slug, name, description, kind
      enum('custom','watchlist','imported'), content_type enum('movie','series','mixed'),
      visibility enum('private','unlisted','public'), source_url, sync_mode, item_count int,
      likes_count int, version bigint, search tsvector generated, created_at, updated_at,
      deleted_at, unique(owner_id, slug))
list_items(list_id fk, media_id fk, position numeric, added_at, note, pk(list_id, media_id))
list_likes(list_id fk, voter_key, created_at, pk(list_id, voter_key))  -- voter_key = acct:<uuid> | ip:<hmac>
external_list_likes(url_hash, url, voter_key, created_at, pk(url_hash, voter_key))
list_follows(account_id, list_id, created_at)              -- replaces creator_user_lists 'liked'
hidden_items(account_id, kind, ref, created_at)            -- replaces 'hidden'/'hidden_section'

-- channels
channels(id uuid pk, owner_id null, share_code unique, name, description, poster, backdrop,
         settings jsonb, visibility enum('private','unlisted','public'), likes_count,
         adds_count, published_at, created_at, updated_at, deleted_at)
channel_items(channel_id fk, position, media_id fk, season, episode, pk(channel_id, position))
channel_likes(channel_id, voter_key, created_at)

-- add-on (what Stremio installs)
addon_profiles(id uuid pk, account_id fk null, name, settings jsonb, version bigint,
               created_at, updated_at)
addon_rows(profile_id fk, position, row_key, name, content_type, enabled,
           source jsonb,            -- {kind:'list', list_id} | {kind:'chart', ...} | {kind:'channel', channel_id} | {kind:'merged', sources:[...]}
           pk(profile_id, row_key))
addon_tokens(token_hash pk, profile_id fk, created_at, last_used_at, revoked_at)
legacy_installs(legacy_id pk,       -- the 12-char cfg id or a hash of a base64 config
                profile_id fk null, snapshot jsonb, owner_account_id null,
                migrated_at, last_used_at)

-- watch activity
watch_events(id bigserial, account_id, media_id, season, episode, watched_at, source,
             client_event_id, pk(account_id, id)) partition by hash(account_id)
             -- unique(account_id, client_event_id) for idempotent client/webhook retries
show_progress(account_id, series_id, last_season, last_episode, last_watched_at,
              dismissed_at_season, dismissed_at_episode, airing_hidden_at_season,
              airing_hidden_at_episode, state, pk(account_id, series_id))
              -- Continue Watching and Airing Next are views over this × episodes

-- product data
streaming_events(...)               -- unchanged shape, moved
recommendation_snapshots(account_id, kind, items jsonb, computed_at)
daily_title_counts(day, event_type, media_id, count, pk(day, event_type, media_id))
feedback_threads(id, account_id null, category, status, created_at, updated_at)
feedback_messages(id, thread_id fk, author enum('user','admin'), body, created_at)
jobs(id uuid pk, kind, account_id null, status, progress jsonb, dedupe_key unique,
     attempts, last_error, created_at, updated_at)
admin_audit_log(id, admin_id, action, target, details jsonb, created_at)
```

What this retires: `creator_tombstones`, `list_tombstones`, `creator_key_lookups` (becomes a column), `published_lists` (becomes lists owned by a system "anonymous" account, `owner_id` null), `lists_fts` (a generated `tsvector` column with a GIN index), `event_meta` (becomes `media`), `stats` / `source_groups` (Analytics Engine), `creator_user_lists` (`list_follows` + `hidden_items`), `continue_watching` and `airing_next` (views), `creator_tracking_meta` (account settings + `addon_profiles.settings`), the COMPANION-in-`show_title` encoding (a proper column or a `companion` table), and every KV namespace in §1.2 except caches.

### 3.4 Watch tracking, Continue Watching and Airing Next

Today every writer (browser autosave, Stremio playback ping, Plex/Jellyfin/Emby webhook, the Continue Watching cron, the Airing Next cron) reads the account's **whole** tracking state, edits it, and writes all of it back to KV and to five D1 tables. The next version inverts this:

1. **Writes are events.** `POST /api/v2/watch-events` (batch of `{media, season, episode, watched_at, client_event_id}`), `DELETE /api/v2/watch-events/{id}`, `POST /api/v2/watch-history:clear`. Stremio pings and media-server webhooks are **enqueued** (`webhooks` queue) and processed idempotently; the HTTP response is immediate.
2. **Progress is derived.** On each event the consumer upserts one `show_progress` row (last watched episode). Continue Watching = `show_progress` rows whose next episode (from `episodes`) has aired and is not dismissed; Airing Next = rows whose next episode is in the future. Both are one indexed query per request.
3. **Schedules are shared.** `series_schedule.tracked_by_count` is maintained on progress insert/delete; the `show-schedule` cron enqueues due series (returning shows daily, ended shows monthly), and one TMDB refresh updates every user watching that show at once. There is no account sweep and no cursor.
4. **No merge heuristics.** Idempotent event ids and server authority remove the "rescue", "empty never overwrites", scrobble queue, `trackingd1behind:` marker, `clientVersion` guard and reset markers.

Measured effect of today's design (`PERFORMANCE_AUDIT.md` P-1): one Plex scrobble against a 2,000-item history issues **2,013** D1 statements and 4 KV writes. The event model issues **one** insert and one upsert.

### 3.5 Catalog pipeline (Stremio)

```
GET /{token}/catalog/{type}/{rowKey}[/skip=N].json
  → addon profile (cache 60 s per colo, keyed by profile id + version)
  → row.source.kind
       chart     → KV snapshot `chart:…` (SWR; stale → enqueue provider-refresh)      ── shared
       list      → SELECT … FROM list_items JOIN media … LIMIT/OFFSET                ── per list, cacheable if public
       channel   → channel lineup service (pure function of channel + day + progress)
       personal  → show_progress / watch_events / watchlist queries                   ── never cached
       external  → provider layer (user's vault token) with per-account SWR cache
       merged    → union of the above with a stable dedupe order
  → presentation passes: BetterPosters URL rewrite, badges (R2-cached artwork), adult filter
  → cross-row dedupe: computed once per profile version and cached (not refetched per row)
  → Cache-Control by row class (public rows: s-maxage; personal: private, no-store)
```

The profile version in the cache key means a settings change is visible on the next request; no reinstall.

### 3.6 Provider layer (Phase 6 conclusion)

One module per provider under `src/providers/{name}/` with the same shape:

```ts
interface ProviderClient {
  request<T>(op: ProviderOp, ctx: RequestCtx): Promise<T>;   // one place for auth, timeout,
                                                              // retry w/ jitter, 429 Retry-After,
                                                              // circuit breaker, rate budget,
                                                              // Analytics Engine metrics
}
// mappers: provider payload → MediaRef / NormalizedItem (imdb_id, tmdb_id, kind, title, year, art)
// sources: chart(key, region, page) · list(ref, page) · watchlist(conn) · history(conn) · search(q)
```

Rules: every outbound call has a timeout and a budget; every result is normalized to `media` ids before any feature sees it; provider-specific quirks (MDBList's four watchlist endpoints, Trakt's wrapperless `/popular`, TMDB v4 list paging, Simkl static chart files) live only in that provider's module; shared data is cached once (KV snapshot or `media` row), user data is cached per connection with a short TTL. Details per provider are in `BACKEND_AUDIT.md` §8.

### 3.7 Background jobs and caching (Phase 5 conclusion)

| Work today | Keep? | Next version |
|---|---|---|
| Chart pre-warm (rotating cursor, 150–200 ms sleeps, ~105 fetches/chart) | Yes — shared, precomputable. | Cron every 5 min enqueues charts whose snapshot is older than their TTL; consumer fetches, normalizes, writes KV snapshot. Requests serve stale-while-revalidate. |
| Continue Watching sweep (per-account cursor, 25 accounts/tick) | **No.** | Replaced by per-show schedule refresh + derived progress (§3.4). |
| Airing Next sweep (3 accounts/tick) | **No.** | Same. |
| New on Streaming sweep (RapidAPI budget math, JustWatch paging, KV cursors) | Yes. | Hourly job per region/service with state in Postgres; RapidAPI monthly quota tracked in a table. |
| BetterPosters pre-fetch + retry list in one KV key | Yes (the upstream is slow). | `posters` queue writes to R2; misses retried with backoff; variants in use tracked in Postgres. |
| Channel live pools / "new episodes" rebuilt via `waitUntil` per request | Yes. | Job keyed by channel id with a dedupe key; lineup reads stored results. Built from `episodes`, so mostly SQL. |
| Quick Add network presets (one per tick) | Yes. | Daily job per network. |
| Letterboxd/Trakt import via chunked `/api/bulk-resolve` resume loop | Yes. | `imports` job: upload file to R2 → job resolves titles through `media` (cache-first) → creates list → progress in `jobs`. |
| Stats bumps in `waitUntil` | Yes. | Analytics Engine `writeDataPoint` (fire-and-forget, no storage op). |
| `lastgood:` copy per config per row per request | **No.** | Source-level SWR snapshots already provide last-known-good. |
| Token refresh | Missing today. | Daily `token-refresh` job for connections expiring within 7 days. |
| Provider history sync (Trakt/Simkl/MDBList "sync my history") | Client-driven today. | `provider-sync` job per connection, incremental by `last_synced_at`. |

---

## 4. Code organization (Phase 13)

### 4.1 Is the `00_`–`26_` layout still appropriate?

No. It exists because the Worker used to be deployed by pasting one file into the Cloudflare dashboard (00:257–260 says so), and it has costs that no longer buy anything:

* **One shared scope.** Top-level names from 27 files collide or leak; CI needs `scope_check.mjs` because "a const declared inside one route's block is invisible to the next route's block while looking, in the source, like it is right there" (ci.yml). The temporal-dead-zone crash found in this audit (`BACKEND_AUDIT.md` B-H1) is exactly this class: it resolves, so the scope checker passes, and it throws at runtime.
* **Client code is string content.** Files 09–24 are fragments of a template literal, so they cannot be linted, type-checked, unit-tested normally, or bundled; escaping rules differ from normal JS (`\\n` in a `confirm()` string once took the admin page down for two days, per ci.yml).
* **Numbering encodes load order, not meaning.** `02_http-and-creator-utils.js` holds CORS, crypto, caching, likes, tombstones, purge, directory, tracking persistence and the channel index.
* **The deploy artifact is committed** (4.25 MB) and every change is doubled in review.

### 4.2 Proposed layout

Feature-oriented modules with a thin shared layer. Not a blind copy of the suggested tree: the grouping follows the domains that actually exist here.

```
apps/
  api/                         # Worker: HTTP
    src/
      index.ts                 # export default { fetch } → Hono app
      app.ts                   # route composition, middleware order
      middleware/              # security-headers, cors, cache-policy, errors, auth(session),
                               #   addon-token, admin-auth, rate-limit, request-id, logging
      routes/
        stremio.ts             # manifest, catalog, meta, subtitles-ping (thin)
        legacy.ts              # /{cfgId}/…, /{base64}/…, old paths → new services
        pages.ts               # /, /p/lists/:u/:s, /p/channels/…, robots, sitemap
        v2/                    # accounts.ts, sessions.ts, lists.ts, channels.ts, addons.ts,
                               #   tracking.ts, providers.ts, search.ts, directory.ts,
                               #   imports.ts, feedback.ts, images.ts
        admin/                 # one file per admin area
  jobs/                        # Worker: queues + cron
    src/
      index.ts                 # export default { queue, scheduled }
      schedules.ts             # cron → enqueue only
      consumers/               # provider-refresh.ts, show-schedule.ts, imports.ts, posters.ts,
                               #   provider-sync.ts, token-refresh.ts, webhooks.ts, rollups.ts
  web/                         # SPA (Vite + TypeScript + Preact)
    src/
      app/ (shell, router, auth)   features/ (discover, library, addon, channels, settings)
      components/ (Button, Modal, Toast, Card, PosterGrid, Toggle, Sortable, EmptyState…)
      api/ (typed client generated from the OpenAPI spec)   styles/ (tokens.css)
packages/
  domain/                      # pure business logic, no I/O: lineup rotation, dedupe, progress
                               #   derivation, visibility rules, slugging, validation schemas
  providers/                   # tmdb/, trakt/, mdblist/, simkl/, justwatch/, rapidapi/,
                               #   tvmaze/, metahub/, betterposters/, letterboxd-import/
  storage/                     # db.ts (Kysely + Hyperdrive), repositories/*, migrations runner,
                               #   cache.ts (L1/Cache API/KV SWR), blob.ts (R2), queue.ts
  images/                      # SVG generators (channel poster, badge, safe poster)
  shared/                      # ids, time (Eastern-day helper), errors, logging, env schema
migrations/                    # versioned SQL, applied by CI (node-pg-migrate / Drizzle Kit)
tests/                         # unit/, integration/ (real Postgres), contract/ (Stremio),
                               #   e2e/ (Playwright), load/ (k6), fixtures/
```

Why this shape: `packages/domain` holds the rules that are duplicated between client and server today (dedupe, lineup rotation, progress) so the SPA and the Workers can share one implementation; `packages/providers` is the one place a provider quirk is allowed to exist; `apps/api/routes/legacy.ts` isolates everything kept only for backward compatibility so it can be measured and eventually retired.

### 4.3 `worker_entry_combined.js`

It becomes a **build output only**: produced by `wrangler deploy` (esbuild) in CI, never committed, never read by developers. `build.py`, `build.ps1`, `check_sync.py`, `extract_html.py`, `gen_map.py`/`FUNCTION-MAP.md` and the concatenation-specific parts of `scope_check.mjs`/`render_check.js` are retired. Two ideas from them are worth keeping as ordinary tests: the **hostile-render** check (every server-rendered page rendered with payloads in every caller-supplied field) and the **schema drift** check (migrations applied to an empty database must equal the expected schema).

---

## 5. Frontend architecture (summary of `FRONTEND_UX_AUDIT.md`)

* **Delivery:** static SPA via Workers Static Assets; per-tab code splitting; initial JS budget ≤ 200 KB gzip (today: 2.0 MB raw / 457 KB gzip JS + 285 KB HTML + 107 KB CSS before any data).
* **State:** server is the source of truth; a query cache (TanStack Query for Preact or equivalent) with optimistic updates; `localStorage` only for UI preferences and an optional read-only offline cache. No secrets.
* **Rendering:** components with escaping by default (JSX) instead of 327 `innerHTML` string sites and ~700 inline `style=` attributes; design tokens already exist in CSS and should become the only source of styling.
* **Information architecture:** four destinations instead of six tabs plus hidden `account`/detail views — **Discover**, **Library** (lists, channels, watch activity, liked), **Add-on** (rows, live preview, install/devices, add-on settings), **Settings** (account, connected services, import/export, support); global search in the header.
* **Public pages** (`/lists/:u/:s`, `/channels/:u/:s`) are small server-rendered HTML with OG tags and paginated items, not the full app with every item embedded (today a 10,000-item public list is embedded whole into the page, 26:4839–4852).

---

## 6. What must not break (Phase 18 summary; details in `MIGRATION_PLAN.md` §3)

| Existing asset | Guarantee |
|---|---|
| Creator profiles (username + key) | Every existing key keeps signing in. PBKDF2 hashes migrate verbatim; lookup hashes are recomputed lazily at next login. Recovery answers keep working. |
| Install links: `/{12-char id}/…`, bare-key legacy ids, `/{base64}/…` | Resolve forever through `legacy_installs`. Secrets inside them are moved to the vault or discarded, never returned by an API again. Owners get a one-click "upgrade to a live link" but are never forced. |
| Embedded `channel:v1:` / `customlist:v1:` payloads in old configs | Parsed forever by the legacy resolver (read-only). |
| Public URLs `/lists/{user}/{slug}[.json]`, `/lists/user/{slug}`, `/channel/{code}`, `/channels/{user}/{slug}` | Preserved byte-compatible for JSON consumers (Kometa, Cinephage, Jellyfin plugins use the `.json` array shape). |
| Lists and likes | `creator_lists.items_json` → `list_items`; slugs, visibility, like counts and voter ledgers preserved; KV-only voters merged. |
| Channels | Server copies (`creatorsyncchannels:`, `channelshare:`) migrated; share codes preserved; browser-only channels uploaded on next sign-in by a one-time, explicit migration step (no silent reconciliation). |
| Watch history, Continue Watching, Airing Next, dismissals, fully-watched | D1 tables + KV blobs → `watch_events` + `show_progress`; nothing is discarded; conflicts resolved by "union, latest `watched_at` wins". |
| OAuth connections | Tokens found server-side are vaulted; accounts whose tokens exist only in a browser are migrated at next sign-in; everyone is asked to reconnect once (to obtain refresh tokens) with a banner, not a failure. |
| Backups | Import accepts backup formats 1.x, 2.0 and 3.0 forever; new exports contain no secrets. |
| Scrobble webhook URLs | Token URLs keep working; `creator=&key=` URLs keep working for a published sunset window with an in-app warning. |

---

## 7. Decision log

| Decision | Choice | Rejected alternative and why |
|---|---|---|
| Runtime | Cloudflare Workers (Paid) | Node containers: more ops for no gain on an edge-shaped workload; kept as an exit via Hono. |
| System of record | Managed PostgreSQL via Hyperdrive | D1: size ceiling and single writer vs the stated scale; sharding would reintroduce fan-out. |
| Background work | Queues + cron-enqueue + (optional) Workflows | Cron slicing with budgets: the source of most free-tier complexity. |
| Caching | Cache API + KV snapshots (derived only) + L1 | KV as a store of record: eventual consistency caused the tombstone/queue/marker machinery. |
| Analytics | Workers Analytics Engine + daily rollups | `stats` table: unbounded, LIKE scans, mixes security counters with product telemetry. |
| Auth | Sessions + scoped add-on/webhook tokens + encrypted vault | Master key per request: un-revocable, leaks into URLs, configs and backups. |
| Frontend | Modular SPA (Vite, TS, Preact) with incremental migration | Full rewrite in a heavy framework: unnecessary; big-bang risk. Keeping template literals: untestable. |
| Install links | Live add-on profiles behind stable tokens | Immutable snapshots: forces reinstall on every change, stores secrets forever. |
| Migration style | Phased strangler with one data cutover under a short read-only window | Live dual-write: exactly the complexity being removed. |
