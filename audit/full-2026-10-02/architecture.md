# System Architecture Map — My Lists Addon

This document establishes the verified architectural baseline and system map for the **My Lists Addon** platform (`mylistsaddon.com`), based on code inspection of repository commit `6f02c3b7104bc5b58993d15502a5a351697fa670`.

---

## 1. Worker Fragments & Concatenation Model

The application is architected as a single monolithic Cloudflare Worker composed of 58 numbered source files and a header file:

- **Source files:** `header.js`, `00_constants.js` through `57_title-details-fallback.js`.
- **Scope Model:** All fragments are concatenated sequentially into a single ECMAScript module. Top-level `const`, `let`, `var`, and `function` declarations share a single outer lexical scope.
- **Scope Safety Guard:** `scope_check.mjs` statically analyzes the concatenated file and the rendered HTML script blocks using `acorn` and `eslint-scope` to ensure zero unresolved identifier references or unintended scoping collisions (`verify.sh:37-39`).
- **Separation of Concerns:**
  - `00_` to `08_`: Server-side core constants, utilities, admin templates, config resolvers, catalog core, and upstream API fetchers.
  - `09_` to `15_`: Frontend HTML page shell and tab component templates (emitted as JavaScript template strings inside `renderBuilder()`).
  - `16_` to `24_`: Client-side browser bundle (embedded into the page shell or served via split bundle endpoints `/app.js` and `/app-features.js`).
  - `25_` to `26_`: Core HTTP route dispatchers, Stremio catalog endpoints, `/api/creator/*`, `/admin/*`, and the top-level `scheduled()` cron trigger handler.
  - `27_` to `57_`: Modular Phase 3–10 backend subsystems (installs, connections, media, v2 lists, channels, activity DB, scrobbles, circuit breakers, queues, cron jobs, materializers).

---

## 2. Generated Worker & Build Integrity (`worker_entry_combined.js`)

- **Generator:** `python build.py` (or `build.ps1`).
- **Mechanism:** Reads `header.js` as raw bytes, then sequentially reads and appends each file matching sorted glob `[0-9][0-9]_*.js`, ensuring each ends with a Unix newline (`\n`), writing to `worker_entry_combined.js`.
- **Commit Status:** `worker_entry_combined.js` (5,374,368 bytes) is **committed directly to git**.
- **Intentional Design Rationale (D-11 & CLAUDE.md):** The primary deployment path is manual paste into the Cloudflare dashboard. There is no automated build step during deployment, so the deployable artifact must exist in git and match sources byte-for-byte.
- **Drift Detection:**
  - `python check_sync.py`: Validates byte-exact match (normalizing CRLF to LF).
  - `verify.sh:11`: Runs `git diff --ignore-cr-at-eol --quiet -- worker_entry_combined.js`.
  - In this audit baseline, committed output matches source fragments with 0 diff.

---

## 3. Deployment Path & Infrastructure Topology

- **Production Deployment:**
  - Deployed by copying the complete content of `worker_entry_combined.js` and pasting it into the Cloudflare Workers dashboard editor (`docs/OPERATIONS.md:3`, `docs/ARCHITECTURE.md:13`).
  - No `wrangler deploy` is executed against production.
- **Staging Deployment (`[env.staging]`):**
  - Configured in `wrangler.toml:228-292` with route `staging.mylistsaddon.com/*`.
  - Deployed via `npx wrangler deploy --env staging`.
  - Runs with dedicated staging bindings: `my-lists-db-staging` (D1), `mylists-activity-staging` (D1), `CONFIGS` (staging KV), `mylists-blobs-staging` (R2), and `mylists-jobs-staging` (Queue).
- **Runtime Limits:** Hosted on Cloudflare Workers Paid plan (10,000 subrequests per invocation, 30s CPU time). Retired Free-plan budgets (`BULK_RESOLVE_SUBREQUEST_BUDGET`, etc.) are ignored.

---

## 4. Frontend Generation & Template Architecture

- **Rendering Engine:** Template literals inside `09_page-shell.js` (`renderBuilder()`), `03_admin.js` (`renderAdminDashboard()`), and tab modules `10_`–`15_`.
- **Split Asset Architecture (P8-3):**
  - First-view critical JS is served via `/app.js` (93.26 KB gzip, budget <= 150 KB gzip).
  - Secondary feature JS is deferred via `/app-features.js` (425.88 KB gzip).
  - Stylesheet is served via `/app.css` (22.10 KB gzip).
  - HTML shell references bundles with content hashes for immutable caching (`Cache-Control: public, max-age=31536000, immutable`).
- **Template Safety:**
  - Checked by `html_checks.py`: Validates HTML well-formedness, ARIA tab roles, CSS brace balance, and presence of CSP nonces.
  - Escape sanitization prevents `</script>` breakouts (tested via hostile input tests in `render_check.js --hostile`).

---

## 5. Request Routing & URL Dispatching

Entry point: `export default { fetch: handleFetch, scheduled, queue }` in `26_api-creator-and-admin-routes.js:99761`.

`handleFetch` routes inbound HTTP requests based on `url.pathname`:
1. **Public Web Assets & Client:**
   - `/`, `/index.html`, `/configure` -> `renderBuilder()`
   - `/app.js`, `/app-features.js`, `/app.css` -> Split static bundles
   - `/sw.js` -> Service worker template (`SERVICE_WORKER_JS`)
   - `/vendor/fflate-0.8.2.js` -> Vendored unzip library (`01_icon-asset.js`)
2. **Stremio Addon Protocol Routes (`25_api-catalog-routes.js`):**
   - `/{id}/manifest.json`, `/manifest.json` -> Stremio manifest declaration
   - `/{id}/catalog/{type}/{id}.json`, `/{id}/catalog/{type}/{id}/skip={skip}.json` -> Catalog rows
   - `/{id}/meta/{type}/{id}.json` -> Title metadata
   - `/i/{token}/manifest.json`, `/i/{token}/catalog/...` -> Phase 3a v2 install links
3. **Creator Account & User APIs (`26_api-creator-and-admin-routes.js`):**
   - `/api/session` -> Session login/logout
   - `/api/creator/profile` -> Profile registration
   - `/api/creator/sync/save`, `/api/creator/sync/load` -> Account data synchronization
   - `/api/creator/lists/*` -> List operations
   - `/api/creator/restore`, `/api/creator/forgot-username` -> Account recovery
4. **Subsystem APIs:**
   - `/api/installs/*` (`27_installs.js`)
   - `/api/connections/*` (`28_connections.js`)
   - `/api/lists/*` (`31_lists-api.js`)
   - `/api/likes/*` (`32_likes-api.js`)
   - `/api/channels/*` (`35_channels-v2.js`)
   - `/api/scrobble/*` (`38_activity-scrobble.js`)
   - `/admin/*`, `/admin/api/*` (`03_admin.js`, `26_api-creator-and-admin-routes.js`)

---

## 6. Frontend DOM Architecture & Delegated Action Contract

- **No Inline Handlers (D-14):** In compliance with strict Content Security Policy, zero inline `on*=` event handlers exist in HTML templates.
- **Delegated Dispatcher (`data-act`):**
  - Controls declare actions via attributes: `data-act="actionName"`, `data-act-args='{...}'`, and optional `data-act-on="change|input"`.
  - A single top-level event listener (`appActDispatch` in `16_client-row-core.js`) intercepts click and input events, deserializes arguments, and routes to registered actions.
  - `/admin` implements an identical decoupled dispatcher (`adminActDispatch` in `03_admin.js`, D-18).
  - `html_checks.py` statically parses all `data-act` attributes and verifies every action matches a declared client function.
- **UI Dialogs (D-15, D-19):** Native `alert()` calls are eliminated across client and admin pages, replaced by in-app toasts (`showToast`) or custom modals (`showAdminAlert`).

---

## 7. API Handlers Subsystem Map

| Path Prefix | Handling Fragment | Storage Target | Description |
|---|---|---|---|
| `/i/{token}/*` | `27_installs.js` | D1 `installs`, `install_secrets` | Phase 3a tokenized install links |
| `/{cfgId}/*` | `04_config-resolution.js`, `05_catalog-core.js` | KV `CONFIGS` (`cfg:*`) | Legacy base64 / KV install links |
| `/api/session` | `26_api-creator-and-admin-routes.js` | D1 `sessions` | Cookie-based session issuance and revocation |
| `/api/creator/*` | `26_api-creator-and-admin-routes.js` | D1 `creators`, KV `CONFIGS` | Account sync, profile management, key checks |
| `/api/lists/*` | `31_lists-api.js` | D1 `lists`, `list_items` | Phase 3b v2 List CRUD operations |
| `/api/likes/*` | `32_likes-api.js` | D1 `likes`, `lists` | Phase 3b v2 likes ledger |
| `/api/channels/*` | `35_channels-v2.js` | D1 `channels`, R2 `BLOBS` | Shared and custom channel lineups |
| `/api/scrobble` | `38_activity-scrobble.js` | D1 `DB_ACTIVITY` | Scrobble webhook receiver (Plex, Trakt, web) |
| `/api/connections/*` | `28_connections.js` | D1 `provider_connections` | Account-level provider OAuth credential storage |
| `/admin/*` | `03_admin.js`, `26_api-creator-and-admin-routes.js` | D1 `DB`, KV `CONFIGS` | Administrative dashboard & migration console |

---

## 8. Authentication, Sessions & Credentials Architecture

- **Session Authentication (`FF_SESSIONS`):**
  - Session endpoint: `POST /api/session`.
  - Issues `mla_session` cookie containing `<sessionId>.<secretToken>`.
  - Cryptographic verification: Only SHA-256 hash of `secretToken` is stored in D1 `sessions` table.
  - Supported on all `/api/creator/*` routes alongside legacy `creatorName` + `creatorKey` headers.
- **Account Recovery & Passwords (D-31, D-32):**
  - No email recovery is implemented or planned (D-12).
  - Accounts use random ~60-bit `Account Key` (`generateCreatorKey`), stored hashed via PBKDF2 (1 round of 100,000 iterations).
  - Recovery Answer: Chosen by user. Hashed with 6 chained rounds of 100,000 PBKDF2 iterations (`hashRecoveryAnswer`, `pbkdf2x:6:100000:...`) to respect `workerd`'s 100k per-call limit while providing 600,000 work factor (D-32).
  - Blind index lookup: `LOOKUP_PEPPER` HMAC blind index in `creator_key_lookups` allows recovery without full table scan.
- **Provider Credentials Storage (D-13):**
  - Client browsers retain zero provider tokens in `localStorage`.
  - Tokens (Trakt, MDBList, Simkl, TMDB) are kept in-memory for the session and encrypted server-side in `provider_connections` using AES-256-GCM via `TOKEN_ENCRYPTION_KEY`.
- **Admin Dashboard Auth (D-24, D-25, D-26, D-27):**
  - Front door: Cloudflare Access RS256 JWT validation (`Cf-Access-Jwt-Assertion`) against team domain certs (`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`).
  - Break-glass fallback: `ADMIN_KEY` secret.
  - Admin sessions stored in `admin_sessions` table with revocable session tokens (`mla_admin` cookie).
  - Audit logging: Handled at gate in `isAdminRequest` (`02_http-and-creator-utils.js:recordAdminAudit`), recording sanitized whitelist fields only (`ADMIN_AUDIT_BODY_FIELDS`).

---

## 9. Cloudflare Storage Bindings

- **D1 (`DB` - `my-lists-db`):**
  - Primary authoritative store for accounts (`creators`, `accounts`, `sessions`), lists v2 (`lists`, `list_items`), channels v2 (`channels`, `channel_items`), likes ledger (`likes`), installs (`installs`, `install_secrets`), rate counters (`rate_counters`), admin sessions, and audit log.
  - Additive migrations in `migrations/*.sql` tracked via `schema_migrations` table.
- **D1 Activity (`DB_ACTIVITY` - `mylists-activity`):**
  - Dedicated database for playback tracking: `watch_events`, `show_progress`, `user_media_state`.
  - Decoupled from `DB` to allow horizontal sharding and isolated backup schedules (`migrations/activity/A0001_activity.sql`).
- **KV (`CONFIGS`):**
  - Ephemeral cache store: chart snapshots (`snap:chart:*`), circuit breaker state (`pb:*`), last good provider responses (`lastgood:*`), and legacy install configs (`cfg:*`).
- **R2 (`BLOBS` - `mylists-blobs`):**
  - Stores large objects: shared channel episode pool JSONs (`channels/{code}/pool.json.gz`), Better Poster image blobs, and KV backups.
- **Queues (`JOBS` - `mylists-jobs`):**
  - Asynchronous background execution: Queue producer binding `JOBS` in Worker; consumer entry point `queue(batch, env, ctx)` in `45_jobs-dispatcher.js`.
  - Consumer parameters: `max_batch_size = 25`, `max_batch_timeout = 5s`, `max_retries = 5`, DLQ: `mylists-jobs-dlq`.
- **Analytics Engine (`ANALYTICS` - `mylists_events`):**
  - Ingestion of per-request operational telemetry: route, status, duration, subrequests, D1/KV operation counts.

---

## 10. Upstream Provider Integrations & Resilience

- **Providers Supported:** TMDB, Trakt, Simkl, MDBList, TVMaze, Cinemeta, JustWatch, RapidAPI.
- **Circuit Breaker (`41_provider-breaker.js`, `FF_PROVIDER_BREAKER`):**
  - Tracks consecutive network/upstream failures per provider in KV (`pb:<provider>`).
  - Tripping condition: 5 consecutive failures triggers an open circuit for 60 seconds.
  - Fallback: Immediately serves cached `lastgood:*` responses without blocking on network timeouts.
- **Chart Snapshots (`42_chart-snapshots.js`, `FF_CHART_SNAPSHOTS`):**
  - Popular charts pre-warmed into shared KV snapshots every 2 hours via cron.
  - Empty upstream responses are rejected to prevent cache poisoning of valid chart data.

---

## 11. Stremio Addon Protocol Endpoints

- **Manifest (`/{id}/manifest.json`, `/manifest.json`, `/i/{token}/manifest.json`):**
  - Emits Stremio v3 addon manifest declaring capabilities, resources (`catalog`, `meta`), types (`movie`, `series`), and dynamic catalog rows configured for that install.
- **Catalogs (`/{id}/catalog/{type}/{id}[/skip={skip}].json`):**
  - Formats items into standard Stremio `metas` array: `id`, `name`, `type`, `poster`, `description`, `releaseInfo`.
  - Canonical IDs (`43_catalog-ids.js`, `FF_CANONICAL_IDS`): Normalizes items to IMDb ID (`tt...`) or `tmdb:...` format to maximize stream provider compatibility.
- **Meta (`/{id}/meta/{type}/{id}.json`):**
  - Serves title details, episode lists, and season metadata fallback via TMDB / TVMaze / Cinemeta (`57_title-details-fallback.js`).

---

## 12. Lists, Channels & Watch History Storage Model

- **Dual-Storage Transition (Phase 3b / Phase 10):**
  - Legacy model: Lists stored as serialized JSON in KV `creatorlist:<user>:<slug>` and D1 `creator_lists.items_json`.
  - V2 model: Normalized relational schema in D1 `lists` and `list_items` (`31_lists-api.js`).
  - Bridge: `34_lists-v2-bridge.js` dual-writes or bridges reads depending on `FF_V2_LISTS_READ` and `FF_V2_LISTS_ONLY`.
- **Channels v2 (`35_channels-v2.js`):**
  - Channel metadata in D1 `channels`; large episode lineups offloaded to R2 `BLOBS` (`channels/{code}/pool.json.gz`).
- **Activity & Watch Progress (`36_activity-db.js`, `39_activity-shelves.js`):**
  - Scrobble ingestion records play events into `watch_events` with deduplication key (`dedupe_key = account:media:season:episode:time_bucket`).
  - `show_progress` records progress state, episode dismissal, and Airing Next visibility.
  - Continue Watching and Airing Next shelves are computed dynamically from `show_progress` + `show_schedule` rather than statically stored.

---

## 13. Frontend Client-Side State Management

- **Storage Separation:**
  - `localStorage`: Non-sensitive browser UI preferences (`theme`, active tab, non-account cached view state). Prefixed with `myListAddon:`.
  - `sessionStorage`: Temporary working draft state. Cleared on sign-in/sign-out (`clearLocalAccountData()`).
  - Memory: Provider API keys and OAuth tokens held only in JavaScript runtime memory (`16_client-row-core.js:PROVIDER_SECRET_KEYS`, D-13).
- **Offline / Browser-Only Lists (D-16, D-17):**
  - Unauthenticated list edits remain in browser storage.
  - "Save to an account" queues data in memory (`_pendingListSaves`) across login and pushes on authentication.
  - Sign-in to an existing account presents browser lists as "Saved in this browser only" without auto-merging or overwriting.

---

## 14. Service Worker & Offline Caching Architecture

- **Worker Source:** `render_check.js --sw` parses and emits `service-worker.js` from `09_page-shell.js`.
- **Scope & Caching Strategy:**
  - Cache Name: Stamped with bundle release version.
  - Pre-cached Core Assets: `/app.css`, `/app.js`, `/app-features.js`, `/vendor/fflate-0.8.2.js`.
  - Network-first with cache fallback for HTML navigation (`/`, `/configure`).
  - Cache-first with immutable headers for content-hashed static assets.
  - Pass-through for all `/api/*` and catalog subrequests (never cached offline).

---

## 15. HTTP, CDN & Worker Application Caching

- **Private vs Public Caching Boundaries (N10 Invariant):**
  - Boundary rule enforced in `26_api-creator-and-admin-routes.js`: Every account-scoped, creator, and admin endpoint unconditionally emits `Cache-Control: private, no-store, no-cache, must-revalidate`.
  - Public directory (`/lists/public.json`) and shared searches: Cached with short edge TTLs (`max-age=120`, `stale-while-revalidate=60`).
  - Static bundles (`/app.js?v=...`, `/app.css?v=...`): `public, max-age=31536000, immutable`.
- **ETag & 304 Handling:**
  - Page shell computes ETag over template with `CSP_NONCE_PLACEHOLDER` before runtime nonce injection.
  - Allows browsers to receive `304 Not Modified` on repeat navigation while maintaining per-request dynamic CSP nonces.

---

## 16. CORS & Security Boundary Policies

- **CORS Policies (`02_http-and-creator-utils.js:corsHeaders`):**
  - Stremio catalog and manifest endpoints: Permissive `Access-Control-Allow-Origin: *` to enable media center add-on communication from any origin or native player.
  - Creator and Admin API endpoints: Restricted or origin-validated; credentialed requests require valid Origin/Referer matching the hosted domain.
- **Content Security Policy (D-20, D-21, D-23):**
  - `script-src`: Strictly nonce-only (`'nonce-<random>'`). No `'unsafe-inline'` allowed for scripts.
  - `style-src-elem`: Strictly nonce-only.
  - `style-src`: Nonce-only with `'unsafe-inline'` strictly for dynamic `style="..."` element attributes (D-21).
  - `font-src`: System fonts only (`-apple-system, BlinkMacSystemFont, 'Segoe UI', ...`). External font origins (Google Fonts) completely removed (D-20).
  - Trusted Types (`FF_CSP_TT_REPORT`): Report-only header reporting violations to `/api/csp-report`.

---

## 17. Rate Limiting, Materializers, Bridges, Backfills & Migrations

- **Rate Limiting Architecture (D-28, D-29, D-30):**
  - Authoritative store: D1 `rate_counters` table (`window_start`, `client`, `bucket`, `count`).
  - Spend Models:
    - *Spend-first* (`consumeRateLimit`): For resource-intensive APIs (`/api/details/batch`, `/api/bulk-resolve`). Request spends quota immediately.
    - *Read-first / Spend-on-failure* (`readRateLimitCount` + `noteRateLimit`): For credential endpoints (`/admin/login`, `/api/creator/restore`). Valid credentials do not exhaust budget.
  - Degraded Fallback (D-30): In-memory `Map` inside the isolate if D1 binding is absent or table unmigrated; eliminates fail-open vulnerability.
- **Catalog Materializer (`54_materializer.js`, `FF_MATERIALIZER`):**
  - Pre-computes and caches composite home-screen catalogs once per hour for installs with cross-list deduplication enabled, preventing $O(N^2)$ upstream re-resolutions.
- **Migration & Backfill Pipelines:**
  - `30_lists-backfill.js`: KV-to-D1 list migration processor with pagination cursors.
  - `37_activity-backfill.js`: Watch history migration to `DB_ACTIVITY`.
  - `schema_migrations`: Additive ledger ensuring idempotent application of D1 migrations `0001` through `0020`.
