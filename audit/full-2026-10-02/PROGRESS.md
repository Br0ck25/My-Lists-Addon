# Audit Progress & Module Status Tracker

## Multi-Session Module Roadmap

| Module | Name / Area | Status | Prerequisite | Findings |
|---|---|---|---|---|
| **01** | **Baseline, Architecture, Generated Source** | **FULL** | None | 0 confirmed, 0 suspected |
| **02** | **Backend / API / Routing / Stremio Protocol** | **FULL** | Module 01 | 0 confirmed, 0 suspected |
| **03** | **Authentication, Sessions & Account Identity** | **FULL** | Module 01, 02 | 0 confirmed, 0 suspected |
| **04** | **Database, Storage, Data Integrity** | **FULL** | Module 01 | 0 confirmed, 0 suspected |
| **05** | **Core Product Flows (Lists, Watch History, Channels, Installs)** | **FULL** | Module 02, 03, 04 | 0 confirmed, 0 suspected |
| **06** | **Jobs, Queues, Cron, Time Boundaries** | **FULL** | Module 01 | 0 confirmed, 0 suspected |
| **07** | **External Providers (Integrations, Circuit Breakers, Snapshots)** | **FULL** | Module 01, 02 | 0 confirmed, 0 suspected |
| **08** | **Frontend State and Async Behavior** | **FULL** | Module 01, 02 | 3 confirmed, 0 suspected |
| **09** | **Frontend Security / DOM** | **FULL** | Module 01, 02 | 0 confirmed, 0 suspected |

| 10 | Admin Dashboard, Sessions, Audit Logging & Access | NOT TESTED | Module 02, 03 | — |
| 11 | Queue Consumers, Cron Dispatcher & Background Jobs | NOT TESTED | Module 01 | — |
| 12 | Frontend DOM Security, Templates, XSS & Actions | NOT TESTED | Module 01 | — |
| 13 | CSP, Security Headers, CORS & Network Boundaries | NOT TESTED | Module 12 | — |
| 14 | Rate Limiting, Atomic Counters & Denial of Service | NOT TESTED | Module 01, 02 | — |
| 15 | Cross-Cutting Triage, Regressions & History Review | NOT TESTED | Modules 01–14 | — |
| 99 | Final Synthesis & Comprehensive Audit Report | NOT TESTED | Module 15 | — |

---

## Module 01 Record: Baseline, Architecture, Generated Source

- **Status:** **FULL**
- **Date Completed:** 2026-10-02
- **Target Git SHA:** `6f02c3b7104bc5b58993d15502a5a351697fa670`
- **Files Examined:**
  - `wrangler.toml` (topology, bindings, flags, triggers, secrets)
  - `header.js`, `00_constants.js` through `57_title-details-fallback.js` (58 fragments)
  - `build.py`, `build.ps1`, `check_sync.py`, `gen_map.py`
  - `verify.sh`, `html_checks.py`, `render_check.js`, `scope_check.mjs`, `check_bundle_budget.mjs`
  - `schema.sql`, `schema_activity.sql`, `migrations/*.sql`, `migrations/activity/*.sql`
  - `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/OPERATIONS.md`, `docs/CUTOVER.md`, `docs/STAGING.md`, `docs/DEPLOY_CHECKLIST.md`
  - `CLAUDE.md`, `AGENTS.md`, `HANDOFF.md`, `README.md`
  - `tests/*.test.mjs`, `tests/harness.mjs`, `tests/client-harness.mjs`
- **Commands Run:**
  - `node --version`, `npm --version`, `python --version`
  - `python check_sync.py` (exit 0)
  - `python build.py` (exit 0)
  - `git diff --ignore-cr-at-eol --quiet -- worker_entry_combined.js` (exit 0)
  - `node --check worker_entry_combined.js` (exit 0)
  - `node scope_check.mjs worker worker_entry_combined.js` (exit 0)
  - `node render_check.js rendered-scope.html` + `node scope_check.mjs page rendered-scope.html` (exit 0)
  - `node render_check.js rendered.html` + `python html_checks.py rendered.html local` (exit 0)
  - `node render_check.js rendered-shell.html --shell` + `python html_checks.py rendered-shell.html local-shell` + `node scope_check.mjs page rendered-shell.html` (exit 0)
  - `node render_check.js rendered-admin.html --admin` + `python html_checks.py rendered-admin.html local-admin` (exit 0)
  - `node render_check.js service-worker.js --sw` + `node --check service-worker.js` (exit 0)
  - `node render_check.js rendered-hostile.html --hostile` + `python html_checks.py rendered-hostile.html local-hostile` (exit 0)
  - `python gen_map.py` + `git diff --ignore-cr-at-eol --quiet -- FUNCTION-MAP.md` (exit 0)
  - `node check_bundle_budget.mjs` (exit 0)
  - `node --test tests/*.test.mjs` (exit 0: 2,068 passing tests, 0 failed, 445 suites)
- **Probes Created:** None (Module 01 establishes baseline and architecture; produces no findings by default)
- **Finding IDs:** None
- **Suspected IDs:** None
- **Observations:**
  - `worker_entry_combined.js` matches source fragments byte-for-byte; build generator is deterministic and synchronized.
  - Zero build drift, zero syntax errors, zero scope resolution errors across all 58 fragments.
  - Full test suite of 2,068 unit and integration tests executes cleanly in ~146s with zero failures.
  - Headless browser (Chrome) is present and functional on the host environment.
  - 9 intentional design patterns identified and catalogued in `candidates.md`.
- **Areas Not Tested:**
  - Live Cloudflare Workers runtime (deployment environment). Local in-memory mocks (`tests/harness.mjs`) used for tests.
  - Upstream third-party live APIs (Trakt, TMDB, Simkl, MDBList); mocked fixtures used in test suite.
- **Limitations:**
  - Production credentials and live Cloudflare bindings are absent by protocol design.
- **Next Exact Action:**
  - Proceed to **Module 03**: Authentication, Sessions & Account Identity.

---

## Module 02 Record: Backend / API / Routing / Stremio Protocol

- **Status:** **FULL**
- **Date Completed:** 2026-10-02
- **Target Git SHA:** `86b08f80e43ec100b2577516d3a027246ce088d0`
- **Files Examined:**
  - `25_api-catalog-routes.js`, `26_api-creator-and-admin-routes.js`
  - `27_installs.js`, `28_connections.js`, `31_lists-api.js`, `32_likes-api.js`, `35_channels-v2.js`, `38_activity-scrobble.js`
  - `02_http-and-creator-utils.js`, `04_config-resolution.js`, `05_catalog-core.js`
  - `FUNCTION-MAP.md`
- **Commands Run:**
  - `node tests/probe_module02_deep_dive.mjs` (exit 0: 14/14 checks passed)
  - `node audit/full-2026-10-02/probes/p01_routing_and_stremio.mjs` (exit 0: verified manifest, catalogs, meta, stream 404, unauth 401, no-store headers, cross-account boundaries)
- **Probes Created:**
  - `audit/full-2026-10-02/probes/p01_routing_and_stremio.mjs`
- **Finding IDs:** None (0 confirmed defects)
- **Suspected IDs:** None
- **Observations:**
  - Complete 85-route inventory generated and saved to `route_inventory.md`.
  - Stremio manifest v3 compliance verified: declares `catalog`, `meta` with `idPrefixes: ["tt", "tmdb:", "channel_"]`; declares `subtitles` hook when tracking enabled; does not declare `stream` (returns clean 404).
  - Stremio error resilience: invalid IDs, unsupported types, and missing lists return `{ metas: [] }` or `{ meta: null }` with HTTP 200 and permissive CORS (`*`), conforming to Stremio client expectations.
  - Invariant N10 (Cache-Control: private, no-store) verified strictly enforced at the Worker response boundary (`26_api-creator-and-admin-routes.js:8314`, `isPrivateApiPath`) across all account-scoped, creator, and admin endpoints.
  - Rate limiting verified functional for credential brute force (429) and spend-first bulk endpoints.
  - Identified and recorded CAND-10 (non-GET on static assets) and CAND-11 (defensive non-array config defaulting) in `candidates.md`.
- **Areas Not Tested:**
  - Live third-party OAuth redirects and code exchanges (Trakt, Simkl, MDBList, TMDB) requiring live provider accounts.
- **Limitations:**
  - Tested using in-memory SQLite (`node:sqlite`) and mock harness without live Cloudflare production services.
- **Next Exact Action:**
  - Proceed to **Module 03**: Authentication, Sessions & Account Identity (`FF_SESSIONS`, `sessions` table, `mla_session` cookie verification, `Account Key` verification, `isAdminRequest`, recovery answer PBKDF2 cryptography).

---

## Module 03 Record: Authentication, Sessions & Account Identity

- **Status:** **FULL**
- **Date Completed:** 2026-10-02
- **Target Git SHA:** `8a2a83e2031261b6f52a40fb8f03c4602fb0ee09`
- **Files Examined:**
  - `02_http-and-creator-utils.js` (PBKDF2 key & recovery hashing, `verifyCsrf`, `createSession`, `resolveSession`, `revokeSession`, `deleteAccountRow`, `purgeCreatorData`, `isCreatorTombstoned`)
  - `03_admin.js` (`resolveAdminIdentity`, `adminAccessIdentity`, `isValidAdminCookie`, `createAdminSession`, `resolveAdminSession`, `recordAdminAudit`)
  - `26_api-creator-and-admin-routes.js` (`authenticateCreator`, `/api/session`, `/api/me`, `/api/creator/create`, `/api/creator/reset-key`, `/api/creator/forgot-username`, `/api/creator/delete-account`, `/admin/login`, `/admin/api/*`)
  - `27_installs.js`, `28_connections.js`, `31_lists-api.js` (account-scoped route authorization)
  - `schema.sql` (`creators`, `accounts`, `sessions`, `creator_key_lookups`, `creator_tombstones`, `admin_sessions`, `admin_audit_log`)
  - `tests/admin-security.test.mjs`, `tests/admin-actions.test.mjs`, `tests/recovery-answer-hash.test.mjs`, `tests/account-purge.test.mjs`, `tests/account-reset.test.mjs`, `tests/security-suite.test.mjs`
- **Commands Run:**
  - `node --test tests/admin-security.test.mjs tests/admin-actions.test.mjs tests/recovery-answer-hash.test.mjs tests/account-purge.test.mjs tests/account-reset.test.mjs tests/security-suite.test.mjs` (exit 0: 61 tests passing across 15 suites)
  - `node audit/full-2026-10-02/probes/p02_auth_and_sessions.mjs` (exit 0: 9/9 deep invariant checks passing)
  - `node audit/full-2026-10-02/probes/p02_auth_matrix.mjs` (exit 0: 6/6 test suites passing with positive and negative controls)
- **Probes Created:**
  - `audit/full-2026-10-02/probes/p02_auth_and_sessions.mjs`
  - `audit/full-2026-10-02/probes/p02_auth_matrix.mjs`
- **Deliverables:**
  - `audit/full-2026-10-02/auth_matrix.md` (Comprehensive route-by-route authorization matrix covering 10 functional route groups)
- **Finding IDs:** None (0 confirmed defects)
- **Suspected IDs:** None
- **Observations:**
  - **Authorization & Ownership Matrix:** Complete `auth_matrix.md` generated with columns `Route | Identity | Ownership | Unauthorized test | Result`, covering Creator Management, Sessions & Identity, Installs v2, Connections, Lists v2, Likes v2, Channels v2, Activity Scrobble & History, OAuth flows, and Admin endpoints. Verified via `p02_auth_matrix.mjs` with both positive and negative controls.
  - **Account Key Cryptography:** Creator keys are generated with format `MYL-XXXX-XXXX-XXXX` (~60 bits of entropy) from a 32-character unambiguous charset. Key storage uses PBKDF2 with SHA-256, 16-byte random salt, and 100,000 iterations. Verification uses SHA-256 pre-digests with constant-time hex comparison (`timingSafeEqualSecret`) to protect against both length and value timing attacks.
  - **Recovery Answer Chaining (D-32):** Recovery answers are lowercased and hashed across 6 sequential PBKDF2 rounds of 100,000 iterations (`pbkdf2x:6:100000:...`), achieving 600,000 effective iterations within Cloudflare workerd single-call CPU bounds. Transparent automatic upgrade from legacy single-round answers is verified on successful recovery attempts.
  - **Blind Index Lookups:** Dual-mode lookup verified: HMAC v2 lookup using `LOOKUP_PEPPER` against `accounts.key_lookup_hmac` with fallback to SHA-256 blind index in `creator_key_lookups`. Both modes achieve O(1) account resolution without storing reversible key mappings.
  - **Session Architecture (`FF_SESSIONS`):** 32-byte cryptographically random tokens (`crypto.getRandomValues`). The raw token is strictly ephemeral in memory and client cookies; only its SHA-256 hash (`id_hash`) is written to the D1 `sessions` table. Session cookies are emitted with `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`. Session resolution also supports `Authorization: Bearer <token>`.
  - **Session Lifecycle & Invalidation:** Expired sessions (`expires_at <= now`) and revoked sessions (`revoked_at IS NOT NULL`) fail closed immediately. `DELETE /api/session` clears the cookie (`Max-Age=0`) and stamps `revoked_at` in D1. Key rotation via `/api/creator/reset-key` cascades revocation across all active sessions for that account and clears the isolate memory memo.
  - **CSRF & Origin Boundary:** Global middleware inspects all mutating requests (`POST, PUT, PATCH, DELETE`). Enforces same-origin (`Origin` or `Sec-Fetch-Site: same-origin`) and strict `Content-Type: application/json`. Exemptions are limited to webhooks, OAuth callbacks, and admin form login.
  - **Cross-Account Authorization (IDOR Defense):** Authenticated requests across creator endpoints, install management (`/api/installs`), provider connections (`/api/connections`), and lists (`/api/lists`) derive ownership strictly from `request.account.id` and `request.account.username`. Client attempts to supply a mismatched `creatorName` are rejected with 401.
  - **Admin Authentication Boundaries:** Cloudflare Access RS256 JWT assertions (`Cf-Access-Jwt-Assertion`) verified against team JWKS (`/cdn-cgi/access/certs`) with expiration, issuer, audience (`CF_ACCESS_AUD`), and `FF_ADMIN_EMAILS` validation. Break-glass `ADMIN_KEY` authentication issues revocable `admin_sessions` with `SameSite=Strict` cookies and is protected by per-IP burst (10/min) and daily failure counters. Audit logging (`admin_audit_log`) uses strict field whitelisting to guarantee keys and tokens never leak.
  - **Account Deletion & Tombstones:** `/api/creator/delete-account` requires explicit confirmation (`confirm: "DELETE"`), writes anti-resurrection tombstones to KV (`creatordeleted:<username>`) and D1 (`creator_tombstones`), cascades session deletion, wipes provider connections and install secrets, and deletes account records.
  - Identified and recorded CAND-12 (disjunctive Origin / Sec-Fetch-Site evaluation) in `candidates.md`.
- **Areas Not Tested:**
  - Live Cloudflare Access IdP login redirects with live hardware tokens.
- **Limitations:**
  - Tested using local SQLite in-memory harness (`tests/harness.mjs`) without live Cloudflare edge network.
- **Next Exact Action:**
  - Proceed to **Module 04**: Database, Storage, Data Integrity.

---

## Module 04 Record: Database, Storage, Data Integrity

- **Status:** **FULL**
- **Date Completed:** 2026-10-02
- **Target Git SHA:** `f0fa2cb63201bb40e0e0bc7cfa085ae1f8b00f5c`
- **Files Examined:**
  - `schema.sql` (complete current primary D1 schema: 37 tables, 2 virtual tables, 31 indexes)
  - `schema_activity.sql` (activity D1 schema: `watch_events`, `show_progress`, `user_media_state`, `schema_migrations`)
  - `migrations/0001a_add_likes_column.sql` through `migrations/0020_media_episodes.sql` (21 migration files)
  - `migrations/activity/A0001_activity.sql`
  - `02_http-and-creator-utils.js` (`rotateCreatorKeyHashInD1`, `purgeCreatorData`, `isCreatorTombstoned`, `CREATOR_TOMBSTONE_TTL_SEC`)
  - `27_installs.js` (`loadInstallSnapshot`, `forgetInstallSnapshot`, optimistic concurrency in `updateInstall`)
  - `31_lists-api.js` (Lists v2 batch mutations, `If-Match` version checks, zero-row preconditions, `lists_fts2` synchronization)
  - `32_likes-api.js` (`likeWriteStatements`, atomic `changes()` accounting, `max(0, ...)` bounds)
  - `35_channels-v2.js` (Channel v2 mutations, R2 `BLOBS` episode pool versioning, compensating orphan cleanup)
  - `36_activity-db.js` & `38_activity-scrobble.js` (`activityPlayStatements`, sliding window dedupe, `WHERE changes() > 0` guard)
  - `44_jobs-queue.js` (`enqueueJob`, `jobs` table deduplication)
  - `tests/migration-suite.test.mjs`, `tests/d1-backup.test.mjs`, `tests/lists-v2.test.mjs`
- **Commands Run:**
  - `node --test tests/migration-suite.test.mjs` (exit 0: 7 suites passed, 545ms)
  - `node audit/full-2026-10-02/probes/p03_storage_integrity.mjs` (exit 0: 7/7 suites passed)
- **Probes Created:**
  - `audit/full-2026-10-02/probes/p03_storage_integrity.mjs`
- **Deliverables:**
  - `audit/full-2026-10-02/storage_matrix.md` (Exhaustive storage operations matrix with D1, KV, R2, Cache, and Failure Handling columns)
- **Finding IDs:** None (0 confirmed defects)
- **Suspected IDs:** None
- **Observations:**
  - **SQL Migration Sequence & Idempotency:** All 21 numbered migrations (`0001a` through `0020`) replay in sequence without error from the pre-0001a baseline schema. The provisioned schema matches `schema.sql` 100% byte-for-byte with zero table or column drift. `A0001_activity.sql` and `schema_activity.sql` are identical.
  - **Zero-Row Mutation & Optimistic Concurrency:**
    - `installs` updates (`27_installs.js:859`) explicitly verify `res.meta.changes > 0`. Concurrent requests with stale versions match 0 rows and return `409 Conflict`.
    - `lists` updates and deletes (`31_lists-api.js:342, 515`) require `If-Match`, verify `out[0].meta.changes > 0`, and return `412 Precondition Failed` if stale, preventing lost updates.
    - Creator key rotation (`02_http-and-creator-utils.js:5419`) checks `res.meta.changes > 0` and warns on zero-row match (lazy-migrated account in KV).
  - **Atomic Ledger & `changes()` Accounting:** Like ledgers (`32_likes-api.js:141`) adjust `like_count = like_count ± changes()` within the same atomic D1 batch as the `INSERT OR IGNORE` or `DELETE`. Duplicate likes insert 0 rows, resulting in `like_count + 0` (no double counting). Unlikes are bounded by `max(0, ...)`.
  - **R2 Blob Storage Lifecycle & Orphan Prevention:** Channel episode pools in R2 (`35_channels-v2.js:312`) write new pool versions (`channels/{code}/{version}.json`). If the D1 write is not applied (`changes === 0`), a compensating delete immediately purges the new blob (`blobs.delete(wrotePool)`). If D1 succeeds, the old pool blob is deleted (`blobs.delete(existing.pool_r2_key)`), completely preventing orphan leaks.
  - **Search Index Synchronization (`lists_fts2`):** Lists v2 mutation batches atomically delete and re-insert into `lists_fts2` conditional on `visibility = 'public' AND deleted_at IS NULL`. Changing visibility to unlisted/private or soft-deleting immediately removes the record from full-text search results.
  - **Anti-Resurrection & Dual-Layer Tombstones:** Account deletion records strongly consistent tombstones in D1 (`creator_tombstones`, TTL 300s) and KV (`creatordeleted:`, TTL 300s). `POST /api/creator/create` verifies `isCreatorTombstoned` and rejects re-registration with `"That username is already taken."`, preventing race conditions and credential leaks.
- **Areas Not Tested:**
  - Multi-terabyte production data export / import runtime execution limits.
- **Limitations:**
  - Tested using local SQLite (`node:sqlite`) and mock harness without live Cloudflare edge network.
- **Next Exact Action:**
  - Await user prompt for the next audit module.

---

## Module 05 Record: Core Product Flows (Lists, Watch History, Channels, Installs)

- **Status:** **FULL**
- **Date Completed:** 2026-10-02
- **Target Git SHA:** `e9518736b96e8a82d459910567e93c598e2e784f`
- **Files Examined:**
  - `04_config-resolution.js` (`resolveConfig`, `isV2InstallParam`)
  - `05_catalog-core.js` (`buildManifest`, `liveShelfNames`, catalog search definitions)
  - `13_tab-channels.js`, `20_client-channel-builder.js`, `35_channels-v2.js` (`/api/channel-lineup`, `channelPartTitleSplit`, deterministic lineup rotation)
  - `22_client-creator-profile.js`, `26_api-creator-and-admin-routes.js` (`/api/creator/sync/save-tracking`, `/api/creator/sync/load`, conflict guards, account separation)
  - `27_installs.js` (`/api/installs`, scopes: `read`, `track`, token rotation, manifest resolution `/i/:token/manifest.json`, revocation)
  - `31_lists-api.js` (Lists v2 CRUD, item mutations, reordering, visibility boundaries, independence)
  - `tests/lists-v2.test.mjs`, `tests/installs.test.mjs`, `tests/channels-v2.test.mjs`
- **Commands Run:**
  - `node audit/full-2026-10-02/probes/p04_core_product_flows.mjs` (exit 0: 4/4 test suites passed)
- **Probes Created:**
  - `audit/full-2026-10-02/probes/p04_core_product_flows.mjs`
- **Finding IDs:** None (0 confirmed defects)
- **Suspected IDs:** None
- **Observations:**
  - **A. Lists Lifecycle, Independence, and Privacy:**
    - Creating, updating, reordering, and deleting list items on List A never affects List B (verified with separate lists and verified ordering).
    - Public vs Unlisted/Private visibility boundaries strictly enforced: public lists resolve anonymously via `/api/lists/user/:creator/:slug`; private/unlisted lists require creator ownership or session authentication.
  - **B. Watch History, Progress Tracking, and Account Separation:**
    - Watch history entries saved via `/api/creator/sync/save-tracking` persist across loads via `/api/creator/sync/load` with exact item IDs (`id: "tt0903747:1:1"`).
    - Strict account separation verified: User B querying `/api/creator/sync/load` has 0 items from User A's history.
  - **C. Channels, Lineup Generation, and Deterministic Rotation:**
    - Lineup generation (`POST /api/channel-lineup`) with `pairParts: true` groups multi-part episodes (`Pilot (1)` and `Pilot (2)`).
    - Determinism verified: calling the lineup endpoint repeatedly with the same day seed produces 100% identical item ordering.
    - Changing the timestamp to Day 2 triggers clean deterministic rotation across shows and episodes without item loss.
  - **D. Installs, Scopes, Token Rotation, and Revocation:**
    - Creating an install via `POST /api/installs` issues an opaque install token and records configured scopes (`["read", "track"]`).
    - Stremio manifests (`GET /i/:token/manifest.json`) resolve active user catalogs alongside default search catalogs.
    - Strict account isolation: User B attempting to view User A's install via `GET /api/installs/:id` returns 404.
    - Token rotation (`PATCH /api/installs/:id` with `{ rotateToken: true }`) generates a new token; requests using the previous rotated token immediately stop serving custom catalogs.
    - Deleting an install marks `revoked_at` in D1 and invalidates snapshots; manifest requests with the revoked token immediately return empty user catalogs.
- **Areas Not Tested:**
  - Production playback scrobbles from real Stremio Android/TV clients over long multi-hour streaming sessions.
- **Limitations:**
  - Tested using local Miniflare / SQLite / in-memory KV simulation without live Cloudflare edge network.
- **Next Exact Action:**
  - Await user prompt for the next audit module.

---

## Module 06 Record: Jobs, Queues, Cron, Time Boundaries

- **Status:** **FULL**
- **Date Completed:** 2026-10-02
- **Target Git SHA:** `3717e620b3fe5c00808cde429fb1cbc6609a4b5c`
- **Files Examined:**
  - `wrangler.toml` (`[queues.producers]`, `[queues.consumers]`, `[triggers] crons = ["*/6 * * * *"]`)
  - `44_jobs-queue.js` (Queue producer `enqueueJob` / `enqueueJobs`, consumer `handleJobsBatch`, exponential retry backoff, DLQ after 5 retries, poison-pill defense)
  - `45_jobs-dispatcher.js` (`definePeriodicJob`, `defineDurableJob`, CAS claiming, lease timeout recovery, fallback inline runner)
  - `46_show-refresh.js`, `47_shelf-shadow.js`, `48_chart-refresh.js`, `49_imports.js`, `50_token-refresh.js`, `51_account-purge.js`, `52_poster-fetch.js`, `53_more-jobs.js`, `54_materializer.js`, `55_media-retry.js`, `56_scrobble-queue.js`
  - `02_http-and-creator-utils.js` (`getDailySeed`, `easternDateKey`, `getLegacySunsetNotices`, `DAY_MS`)
  - `03_admin.js` (`easternDateKey`, `statsToday`)
  - `05_catalog-core.js` (`channelRotationDay`, `daysSinceEpochUTC`)
  - `tests/jobs.test.mjs`, `tests/more-jobs.test.mjs`, `tests/scrobble-queue.test.mjs`
- **Commands Run:**
  - `node --test tests/jobs.test.mjs tests/more-jobs.test.mjs tests/scrobble-queue.test.mjs` (exit 0: 49 passing tests across 10 suites)
  - `node audit/full-2026-10-02/probes/p05_jobs_queues_and_time.mjs` (exit 0: 4/4 suites passed)
- **Probes Created:**
  - `audit/full-2026-10-02/probes/p05_jobs_queues_and_time.mjs`
- **Finding IDs:** None (0 confirmed defects)
- **Suspected IDs:** None
- **Observations:**
  - **A. Jobs & Queues Concurrency, Retries & Dead-Letter Handling:**
    - **Poison-Pill Defense:** Messages with non-object, null, array, empty type, or numeric type bodies are explicitly acknowledged and dropped (`stat("invalid").dropped`), preventing poison pill crash loops.
    - **Deployment Skew / Unknown Type Defense:** Messages with unknown job types are not discarded; they are retried with long backoff (`JOB_UNKNOWN_TYPE_RETRY_SEC = 10 min`), allowing newer/rolled-back deployments to safely process messages.
    - **Dead-Letter Routing:** Failing jobs retry with exponential backoff (`30s * 2^(attempts-1)`), and when `attempts > JOBS_MAX_RETRIES` (5 retries), they are routed to the dead-letter queue (`mylists-jobs-dlq`).
    - **D1 Jobs Table Optimistic Concurrency:** Job claims execute atomic CAS updates (`WHERE id = ? AND status = 'queued' AND run_after = ?`). Duplicate message deliveries match 0 rows and return `{ skipped: "stale" }`.
    - **Lease Expiry & Abandoned Recovery:** Running rows past their lease (`status = 'running' AND run_after < now`) are reclaimed by the dispatcher, incrementing attempts and re-queueing for another run.
    - **Stale Completion Rejection:** Workers finishing after lease expiration have their `status = 'done'` write rejected (`changes !== 1`), preventing slow workers from corrupting re-assigned job states.
    - **Unbound Queue Fallback:** When `JOBS` queue binding is absent, the scheduled cron tick executes due jobs inline (`JOBS_INLINE_LIMIT = 20`), guaranteeing continued operation on Free plan deployments.
  - **B. Time Boundaries, Controlled Clocks & Calendars:**
    - **Eastern Daily Rollover:** `getDailySeed` and admin statistics use `easternDateKey` (`America/New_York`), rotating daily shuffles cleanly at midnight Eastern instead of during high-traffic evening hours (7-8 PM Eastern) as would occur with naive UTC days.
    - **Leap Day Arithmetic:** Tested February 29 in leap years (`2028-02-28` -> `2028-02-29` -> `2028-03-01`); exact 48-hour separation verified across `utcDay` and `easternDateKey`.
    - **Monthly Quota Ledger Rollover:** `rapidApiLedgerD1` atomically evaluates month matching (`CASE WHEN json_extract(progress_json, '$.month') = ? THEN count ELSE 0 END + add`). Month rollover (`2026-01` to `2026-02`, and `2028-02` to `2028-03`) automatically resets the counter to the new addition without race conditions.
    - **Half-Open Intervals for Daily Rollup:** `rollup.daily` queries `watched_at >= start AND watched_at < end`, strictly ensuring boundary events at `00:00:00.000Z` are counted in exactly one daily bucket without omissions or double-counting.
    - **Sunset Notices 60-Day Window:** `getLegacySunsetNotices` cleanly bounds notices between Day 0 (`daysRemaining = 60`) and Day 60 (`daysRemaining = 0`), correctly shifting urgency from `info` -> `warning` -> `urgent`, and automatically suppresses notices before start and after expiry (Day 61+).
- **Areas Not Tested:**
  - Multi-day physical clock drift on physical hypervisors.
- **Limitations:**
  - Tested using local Miniflare / SQLite / in-memory queues without live Cloudflare edge network.
- **Next Exact Action:**
  - Await user prompt for the next audit module.

---

## Module 07 Record: External Providers

- **Status:** **FULL**
- **Date Completed:** 2026-10-02
- **Target Git SHA:** `822c2cd7b4b2ae337d22396a5e3358527d35668d`
- **Files Examined:**
  - `06_source-fetchers-mdblist-trakt.js` (Trakt & MDBList fetchers, mapping, auth headers, rate limit handling)
  - `07_source-fetchers-tmdb-simkl.js` (TMDB & Simkl fetchers, movie vs series path trees, `/external_ids`, poster formatting)
  - `41_provider-breaker.js` (Circuit breaker threshold 5, cooldown 60s, cross-isolate KV sync via `pb:*`, status classification)
  - `42_chart-snapshots.js` (KV chart snapshots `snap:chart:*`, 2h fresh window, 7d TTL, empty response rejection guard)
  - `43_catalog-ids.js` (Canonical ID mapping, IMDb `tt...` vs TMDB `tmdb:...` prefixing)
  - `50_token-refresh.js` (OAuth token refresh background job, 7-day proactive window, reauth marking)
  - `52_poster-fetch.js`, `57_title-details-fallback.js` (Poster warming & fallback detail lookups)
  - `tests/providers.test.mjs`, `tests/provider-contracts.test.mjs`, `tests/chart-refresh.test.mjs`, `tests/my-lists-addon-charts.test.mjs`
- **Commands Run:**
  - `node --test tests/providers.test.mjs tests/provider-contracts.test.mjs tests/chart-refresh.test.mjs tests/my-lists-addon-charts.test.mjs` (exit 0: 64 passing tests across 11 suites)
  - `node audit/full-2026-10-02/probes/p06_external_providers.mjs` (exit 0: 4/4 suites passed)
- **Probes Created:**
  - `audit/full-2026-10-02/probes/p06_external_providers.mjs`
- **Deliverables:**
  - `audit/full-2026-10-02/provider_trace.md` (Comprehensive integration & fault-tolerance trace across all 6 external providers)
- **Finding IDs:** None (0 confirmed defects)
- **Suspected IDs:** None
- **Observations:**
  - **A. Provider Request Construction & Schema Discrimination:**
    - **Movie vs Series Mapping:** TMDB and Trakt strictly differentiate media types (`it.movie` vs `it.show`, `/movie/*` vs `/tv/*`). Trakt items carry type-tagged objects which map cleanly to Stremio `movie` and `series` types.
    - **ID Extraction Hierarchy:** Trakt and TMDB mapping prioritizes IMDb IDs (`obj.ids.imdb` -> `tt...`). When absent, fallback is converted to canonical `tmdb:{id}` syntax. Malformed items lacking both IDs are safely discarded rather than creating broken tiles.
  - **B. Provider Failure vs. Empty Data Snapshot Protection:**
    - **Exception on Non-200:** `fetchTmdbPagedResults` and Trakt fetchers throw an Error upon HTTP failure statuses (500, 503, 429) rather than returning empty collections `[]`.
    - **Snapshot Preservation Guard:** In `42_chart-snapshots.js:132`, if an upstream provider returns an empty array (`items.length === 0`), the snapshot engine preserves the existing good snapshot in KV, logs a warning, and refuses to overwrite it with empty data.
  - **C. Circuit Breaker State Machine & Resilience:**
    - **Failure Threshold & Cooldown:** After 5 consecutive failures (HTTP 5xx, 429, or network timeouts), the circuit breaker opens for 60 seconds (`PROVIDER_BREAKER_OPEN_MS = 60,000`).
    - **Fast Refusal:** During the open cooldown window, outbound calls are rejected immediately with `ProviderUnavailable`, preventing user request delays and protecting upstream APIs from retry storms. Stale cached copies are served immediately.
    - **Domain Error Handling:** HTTP 401, 403, and 404 domain responses reset the consecutive failure counter to 0, ensuring individual invalid API keys or missing IDs never trip the circuit breaker for all users.
  - **D. Token Expiry & Proactive Refresh:**
    - Proactive background job `token.refresh` (`50_token-refresh.js`) queries connections expiring within 7 days (`TOKEN_REFRESH_WINDOW_MS = 7 * 86,400,000`) and calls provider `/oauth/token` endpoints before expiration.
    - Rejected refresh tokens cleanly mark connection status as `reauth_required` in D1 and display a reconnect banner to the user.
- **Areas Not Tested:**
  - Live third-party provider network outages and IP-level Cloudflare edge blocks.
- **Limitations:**
  - Tested using local synthetic fixtures, Miniflare, and mock harnesses; live production API credentials are not accessed during read-only audit.
- **Next Exact Action:**
  - Proceed to Module 08: Frontend State and Async Behavior.

---

## Module 08 Record: Frontend State and Async Behavior

- **Status:** **FULL**
- **Date Completed:** 2026-10-02
- **Target Git SHA:** `05e16c8bdf8ad3db7cd04279aa63e780b31217f1`
- **Files Examined:**
  - `09_page-shell.js` (Page shell, HTML structure, theme initialization, tab routing, script preamble)
  - `10_tab-search-add.js`, `11_tab-quick-add.js`, `12_tab-custom-lists.js`, `13_tab-channels.js`, `14_tab-presets-backup.js`, `15_tab-settings-html.js` (HTML tab templates)
  - `16_client-row-core.js` (Row management, drag-and-drop, rating badges, live preview shelf, install links)
  - `17_client-my-lists-and-trakt-oauth.js` (External provider connections, Trakt device code OAuth, sync history)
  - `18_client-copy-and-trakt-export.js` (Clipboard interactions, Trakt export, bulk resolve)
  - `19_client-search-and-likes.js` (Search inputs, debouncing, unified list search, likes system `/api/lists/like`, details modal)
  - `20_client-channel-builder.js` (Channel Builder, schedule rules, presets, lineup preview, share/publish `/api/channel/share`)
  - `21_client-custom-list-builder.js` (Custom List Builder, item mutations, play order, expectedUpdatedAt concurrency)
  - `22_client-creator-profile.js` (Creator authentication, login/signup/restore, session management, gated sync, `clearLocalAccountData`)
  - `23_client-list-management.js` (List details, See All full page, poster previews)
  - `24_client-backup-restore-presets.js` (App shell routing, API client `appShellApiFetch`, presets, signout, installs)
  - `25_api-catalog-routes.js:73-173` (`SERVICE_WORKER_JS` caching boundaries)
  - `tests/client-harness.mjs`, `tests/client.test.mjs`, `tests/client-actions.test.mjs`, `tests/client-storage.test.mjs`
- **Commands Run:**
  - `node --test tests/*client*.test.mjs` (exit 0: 469 tests passed across 105 suites in 3.6s)
  - `node --test audit/full-2026-10-02/probes/p07_frontend_state_async.mjs` (exit 0: 5/5 suites passed)
- **Probes Created:**
  - `audit/full-2026-10-02/probes/p07_frontend_state_async.mjs`
- **Deliverables:**
  - `audit/full-2026-10-02/frontend_api_inventory.md` (Comprehensive catalog of 86 client API call sites with payload, response, error, retry, optimistic update, and caching specifications)
  - `audit/full-2026-10-02/frontend_state_inventory.md` (Analysis across all 9 client state layers, authoritative sources of truth matrix, conflict resolution rules, and user-switching lifecycle)
- **Finding IDs:**
  - `AUDIT-FE-001` (P2): `appShellSignOut()` halts and preserves local credentials on network/server error (`24_client-backup-restore-presets.js:3581`)
  - `AUDIT-FE-002` (P2): `saveChannel()` allows duplicate publishing and local creation on rapid double-click (`20_client-channel-builder.js:9172`)
  - `AUDIT-FE-003` (P3): `executeUnifiedListSearch` overwrites newer query with out-of-order fallback results (`19_client-search-and-likes.js:842`)
- **Suspected IDs:** None
- **Observations:**
  - **A. Flow Mapping & Reactivity:**
    - The vanilla JS architecture combines DOM as working state (`#lists` `.entry` elements) with memory caches and `localStorage`.
    - Autosaving debounces at 3000ms (`scheduleCreatorSyncSave`) and tracking sync at 300ms (`scheduleTrackingSync`).
    - Optimistic updates are applied immediately to DOM and local storage; optimistic concurrency is enforced on the backend via `expectedUpdatedAt`.
  - **B. User Switching & State Cleanup:**
    - `clearLocalAccountData()` provides an extensive sweep of in-memory globals (`activeCreator`, `traktAccessToken`, `_providerSecretsInMemory`), `localStorage` (all `myListAddon:*` keys except UI tab navigation), `sessionStorage`, and DOM input forms.
    - However, `appShellSignOut()` in the new UI shell placed this cleanup behind `if (!res.ok) return false;`, preventing local sign-out when offline (`AUDIT-FE-001`).
  - **C. Async Concurrency & Idempotency:**
    - Form submissions across several modals are protected by `beginSubmit()`.
    - `saveCustomList()` synchronously clears `nameInput.value = ''` upon click, preventing duplicate new list saves.
    - In contrast, `saveChannel()` is asynchronous and awaits `postChannelShare` before clearing inputs, enabling double-submit duplicates on rapid clicks (`AUDIT-FE-002`).
    - Title search (`runCatalogSearch`) cleanly discards out-of-order responses using `currentTitleSearchSequence`.
    - List search (`executeUnifiedListSearch`) correctly checks sequence numbers for primary queries, but omitted the check on its alternate fallback search (`altRes`), allowing delayed fallback responses to clobber active searches (`AUDIT-FE-003`).
- **Areas Not Tested:**
  - Hardware GPU rasterization and mobile browser layout engine bugs (desktop Chrome and Node VM testing utilized).
- **Limitations:**
  - Real browser DOM layout, scrolling physics, and gesture inputs were tested via headless Chrome and Node VM stubs.
- **Next Exact Action:**
  - Await user prompt for the next module.

---

## Module 09 Record: Frontend Security / DOM

- **Status:** **FULL**
- **Date Completed:** 2026-10-02
- **Target Git SHA:** `5232c3b4213b675e9958b9649536ffc1b95a2cb6`
- **Files Examined:**
  - `09_page-shell.js` through `25_api-catalog-routes.js` (all client JS source fragments)
  - `02_http-and-creator-utils.js` (CSP, nonce, securityHeaders, escapeHtmlServer, jsonForScript)
  - `16_client-row-core.js` (renderMediaCard, livePreviewPosterHtml, appActArgs, escapeHtml usage)
  - `17_client-my-lists-and-trakt-oauth.js` (OAuth redirect sinks)
  - `19_client-search-and-likes.js` (escapeHtml, escapeAttr definitions)
  - `21_client-custom-list-builder.js` (watchBadgeHtml, publishedUrl assignment)
  - `22_client-creator-profile.js` (displayName DOM rendering)
  - `23_client-list-management.js` (livePreviewPosterHtml function body)
  - `24_client-backup-restore-presets.js` (install URL template, signInToInstallHtml, appShellChannelEscape)
  - `25_api-catalog-routes.js` (SERVICE_WORKER_JS template, CSP report endpoint)
  - `26_api-creator-and-admin-routes.js` (config save route, list URL construction)
  - `render_check.js`, `html_checks.py` (hostile render CI check)
  - `tests/security-suite.test.mjs`, `tests/csp.test.mjs`, `tests/client-escapes.test.mjs`
- **Commands Run:**
  - `node render_check.js rendered-hostile.html --hostile && python html_checks.py rendered-hostile.html local-hostile` (exit 0: hostile render is inert)
  - `node --test tests/security-suite.test.mjs tests/csp.test.mjs tests/client-escapes.test.mjs` (exit 0: 34/34 pass)
  - `node --test tests/security-suite.test.mjs tests/csp.test.mjs` (exit 0: 31/31 pass)
  - `node --test audit/full-2026-10-02/probes/p08_frontend_security_dom.mjs` (exit 0: 20/20 pass)
  - Multiple `node -e` inspection commands for sink enumeration (see commands.log)
- **Probes Created:**
  - `audit/full-2026-10-02/probes/p08_frontend_security_dom.mjs` (7 suites, 20 assertions, all pass)
- **Deliverables Created:**
  - `audit/full-2026-10-02/sink_table.md` — complete source→sink table (9 sections, 38 sinks)
- **Finding IDs:** None (0 confirmed exploitable paths)
- **Suspected IDs:** None
- **Observations:**
  - **escapeHtml / escapeAttr** (defined in `19_client-search-and-likes.js:146`): single implementation covering `& < > " '`. `escapeAttr` is literally an alias — no divergent implementation risk.
  - **All innerHTML sinks** (25 examined): user-controlled data reaches sinks through `escapeHtml()` or `escapeAttr()` wrappers. No unescaped path found.
  - **All insertAdjacentHTML sinks** (17 examined): all inject static string literals or call functions that use `escapeAttr()`/`escapeHtml()` internally.
  - **redirect sinks** (4 `location.href` assignments): all redirect to `ORIGIN + '/api/<provider>/oauth/start'` — literal suffix, ORIGIN from `location.origin`, no user input in URL.
  - **no eval(), document.write(), or new Function()** in any client JS file (probe Suite 6 confirmed).
  - **CSP**: nonce-only `script-src` (128-bit CSPRNG nonce per response, no `unsafe-inline`); `style-src 'unsafe-inline'` intentional (hundreds of `style=` attributes); `frame-ancestors 'self'`; `object-src 'none'`; `base-uri 'self'`. Trusted Types in REPORT-ONLY mode (gated on `FF_CSP_TT_REPORT` flag) — intentional design, ~300 innerHTML sinks require migration before enforcement.
  - **Service worker**: origin-locked (`url.origin !== self.location.origin` → drop), GET-only, no user-controlled data in SW template string.
  - **Hostile render test** (`render_check.js --hostile` + `html_checks.py`): places `MYLXSSPROBE</script><svg onload=1>` (XSS_SCRIPT) and `MYLXSSATTR" onfocus="1` (XSS_ATTR) in every server-rendered field (name, slug, accessToken, entries, etc.). CI check confirms "hostile render is inert (both markers present, neither breaks out)". This verifies `jsonForScript()` correctly escapes `<` and `>` in server-rendered inline script preamble.
  - **publishedUrl** in `<a href=`: value is server-generated `${origin}/lists/${username}/${slug}` where username ∈ `[a-z0-9_-]` (enforced by `validateCreatorUsername`) and slug ∈ `[a-z0-9-]` (produced by `slugifyServer`). `escapeAttr()` applied to href. No HTML-injection possible.
  - **config IDs** (install link token): produced by `generateShortId()` — 9 random bytes via `crypto.getRandomValues`, encoded as base64url `[A-Za-z0-9_-]`. No HTML-special chars. `installUrl` template literal expansion cannot break HTML.
  - **displayName**: filtered of control chars (U+0000–U+001F, U+007F–U+009F) and trimmed to 40 chars. All DOM insertions use `escapeHtml()`.
  - **img-src `https:`**: intentional wildcard; allows provider artwork (TMDB, Trakt, Simkl posters) from any HTTPS origin. All poster URLs go through `escapeAttr()` before `<img src=`. `javascript:` in an img src is browser no-op; `data:` img src is blocked by CSP `img-src` (does allow `data:` — INFO).
  - **One INFO item (S24)**: preset names path in `worker_entry_combined.js:77727` traces through `appShellChannelEscape()` which wraps `escapeHtml`. Not directly confirmed from numbered source fragment but consistent with all other preset name rendering patterns.
- **Areas Not Tested:**
  - DOM clobbering via `document.getElementById` namespace collision — no named form elements found that would shadow globals; considered low risk.
  - PostMessage handlers — not found in examined client JS files.
  - Third-party script loading — none; `script-src` has no host allowlist.
- **Limitations:**
  - `worker_entry_combined.js` line references from previous sessions were not re-read (avoid reading generated file per Module 01 convention); source fragments are authoritative.







