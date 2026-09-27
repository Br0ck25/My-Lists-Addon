# Migration Plan — My Lists Next Version

**Date:** 2026-09-24 · **Target:** the architecture in `NEXT_VERSION_ARCHITECTURE.md`. **Constraint:** the hosted application has users and data today; nothing is reset, and nothing is rewritten all at once.

**Principles**

1. **Strangler, not big bang.** New modules replace old ones route by route. Legacy URLs are served by an isolated legacy layer, forever where users depend on them.
2. **One data cutover, not live dual-writes.** The current codebase shows what dual-writing costs. Data moves to PostgreSQL once, after repeated rehearsals on production copies, during a short read-only window for the website (Stremio reads keep working throughout).
3. **Every phase ships to production** and is independently useful. No phase depends on a later one to be safe.
4. **Measure before removing.** Anything kept for backward compatibility gets a usage counter (Analytics Engine) before it is sunset.
5. **Tests move first.** Each phase adds the tests that pin down current behaviour before changing it.

**Complexity scale:** S (≤1 week) · M (1–3 weeks) · L (3–6 weeks) · XL (6+ weeks), for one developer working with AI assistance.

**Execution order.** The phases below follow the requested numbering; the recommended *order of execution* differs in one place: **Phase 7 (security hardening) starts inside Phase 1 and Phase 3**, because its most urgent items are cheap fixes (Phase 1) and its structural pieces (sessions, token vault, add-on tokens) are part of the new data model (Phase 3). CSP tightening waits for the Phase 6 client.

```
Phase 0  Audit (this document set)                               done
Phase 1  Hotfixes + free-tier/self-hosting removal in the current codebase     M
Phase 2  Backend architecture: TypeScript, modules, router, build, CI/CD       L
Phase 3  Storage: PostgreSQL, API v2, sessions/tokens/vault schema, data cutover   XL
Phase 4  Provider layer + normalized media catalog                         L
Phase 5  Background jobs, queues, caching                                   L
Phase 6  Frontend and UX                                                   XL
Phase 7  Security hardening (completion)                                    M
Phase 8  Performance                                                       M
Phase 9  Testing (completion: e2e, contract, load)                          M
Phase 10 Production migration completion and decommission                  M
```

---

## Phase 0 — Audit only

* **Output:** `NEXT_VERSION_ARCHITECTURE.md`, `CLOUDFLARE_FREE_TIER_REMOVAL_PLAN.md`, `BACKEND_AUDIT.md`, `FRONTEND_UX_AUDIT.md`, `SECURITY_AUDIT.md`, `PERFORMANCE_AUDIT.md`, this plan, `NEXT_VERSION_TASKS.md`.
* **No code, schema or data changes.**
* **Decision gates before Phase 2:** confirm PostgreSQL host (Neon vs Supabase vs Crunchy Bridge), confirm JustWatch usage (S-19), confirm S-5 credential rotation, decide the fate of `LEGACY_UNVERIFIED_CONFIG_SHELVES` using data from Phase 1's counters.

---

## Phase 1 — Hotfixes and dead / free-tier code removal (current codebase)

Small, low-risk changes in the existing numbered files. Each ships as its own PR with tests; `worker_entry_combined.js` is rebuilt as today.

| Area | Change | Files |
|---|---|---|
| Correctness | Webhook filter: compute `pingId` before the filter block; URL params override account defaults (B-H1, S-10). | 26 |
| Correctness | Honour `skip` in `fetchPublishedListCatalog` and `fetchAutoTrackedCatalog` (B-H7). | 05 |
| Security | `/api/resolve` returns entries only (no keys/tokens); `/{config}/configure` stops rendering tokens; `/api/save` stops storing `trackCreatorKey` (keep verified `trackOwner`) (S-1). | 25, 04, 23, 24 |
| Security | Anonymous channel shares immutable; claiming requires an edit secret; rate limit anonymous shares (S-3, S-14). | 26, 20 |
| Security | Account deletion removes owned channels, `creatorchannel:` pointers and directory entries; 30-day username hold (S-4 interim). | 02, 26 |
| Security | Delete the `forgot-username` 50-row PBKDF2 fallback (S-8); use `safeErrorMessage` in `/api/preview` (S-16); server client id only on Trakt device endpoints + rate limit (S-17); delete `getCreator`'s hyphen-insensitive fallback (S-18). | 26, 25, 02 |
| Performance | Remove KV write-back from `getCreator`/`getCreatorList` and GET-path visibility stamping (FT-09); stop `lastgood:` writes when content is unchanged; move `trackSharedApiUse` to a sampled or Analytics-Engine counter (P-3, P-4). | 02, 05, 25 |
| Free tier | Paid defaults for `BULK_RESOLVE_SUBREQUEST_BUDGET`, `DETAILS_BATCH_SUBREQUEST_BUDGET`, `CRON_SUBREQUEST_BUDGET`, `MOST_WATCHED_MAX_LOOKUPS`, `IMDB_ID_LOOKUP_MAX`; remove `/api/resolve` cross-deployment fetch (FT-25); remove `enrichTrailers` (FT-33). | 00, 25, 07, 06 |
| Copy | Remove self-hosting/free-plan copy from README, `wrangler.toml`, `header.js`, page title/meta, FAQ, UI messages (FT-38); fix every `alert()` success message to use a success toast (F-M1); remove the dead install banner or wire it (F-C1 interim: show "your installed add-on is out of date — generate a new link" when the config hash differs). | README, wrangler.toml, header.js, 09, 16, 24 |
| Telemetry | Add counters for: legacy unverified shelf resolutions, legacy base64 config requests, bare-key config requests, legacy webhook `creator=&key=` usage, `/api/resolve` calls, catalog source kinds used. | 04, 25, 26 |

* **DB changes:** none. **API changes:** `/api/resolve` response loses token fields (the client's "import from install link" path must be updated to not expect them — `24_client-backup-restore-presets.js`). **Frontend:** toasts, banner, import-link path.
* **Migration requirements:** none.
* **Backward compatibility:** install links keep working (tokens are still read from stored configs server-side; only their *exposure* stops). Old clients calling `/api/resolve` lose tokens in the response — acceptable; they re-prompt to connect.
* **Risks:** Low. The `/api/resolve` change can surprise users who restore by pasting an install link; message it.
* **Tests required:** regression tests for each fix (webhook filter paths, pagination per source kind, `/api/resolve` shape, channel share immutability, account deletion removes channels, no KV writes on read paths — assert via the op-counting KV wrapper).
* **Complexity:** M.

---

## Phase 2 — Backend architecture improvements (behaviour-preserving)

Goal: the same behaviour, in a codebase that can be changed safely.

* **Files changed:** everything moves: `00`–`26` → `apps/api/src/**`, `apps/jobs/src/**`, `packages/**` (layout in `NEXT_VERSION_ARCHITECTURE.md` §4.2). The client (`09`–`24`) is extracted from the template literal into real modules under `apps/web/src/legacy/**` with **no logic changes**: server interpolations inside the client (`${BULK_RESOLVE_ITEMS_MAX}`, `${DETAILS_BATCH_MAX_ROUNDS}`, chart tables) become a `window.__APP_CONFIG__` object emitted by the shell; escaped backticks and doubled backslashes are unescaped mechanically; the result is bundled by Vite and served via Workers Static Assets.
* **Router:** Hono with route modules; the ~150 routes ported 1:1 with the same paths, methods, status codes and bodies; `withSecurityHeaders`/`isPrivateApiPath` become middleware; a top-level error boundary preserved.
* **Build/CI:** `package.json`, TypeScript (strict gradually), ESLint, Vitest; `wrangler deploy` builds the artifact; `worker_entry_combined.js`, `build.py`, `build.ps1`, `check_sync.py`, `extract_html.py`, `gen_map.py`, `FUNCTION-MAP.md` removed; `scope_check.mjs` removed (TypeScript + ESLint `no-use-before-define` replace it and catch the TDZ class of bug); the hostile-render and service-worker syntax checks become Vitest tests; CD pipeline with staging and production environments, secrets per environment, deploy only from `main` after tests.
* **DB changes:** none (still D1 + KV). Migrations move to a runner with a ledger table for D1 (`d1_migrations` via wrangler) so Phase 3's discipline starts now; runtime schema detection (`D1_SCHEMA_MANIFEST`, `checkD1Schema`, `d1HasAiringRemovalColumns`) removed once migrations are guaranteed applied (FT-26, FT-27).
* **API changes:** none. **Frontend changes:** none visible (same UI, now bundled).
* **Migration requirements:** a golden-master test suite recorded **before** the port: for a fixed dataset, record responses of every route (status, headers that matter, body) and every client-visible page; the port must reproduce them.
* **Backward compatibility:** total — same URLs, same responses, same storage.
* **Risks:** Medium — a large mechanical change. Mitigations: port in slices (Stremio routes first, then public pages, then account routes, then admin), each behind a path-prefix switch in the entry Worker so old and new code can coexist during the port; golden-master diff in CI.
* **Tests required:** the existing 1,212 tests must pass against the new build (adapt the harness imports); golden-master diffs; typecheck; lint.
* **Complexity:** L.

---

## Phase 3 — Storage improvements (PostgreSQL, API v2, data cutover)

The core of the program. Delivered in five increments.

### 3a · Schema and repositories
* **DB changes:** create the PostgreSQL schema from `NEXT_VERSION_ARCHITECTURE.md` §3.3 (accounts, sessions, username_holds, provider_connections, scrobble_tokens, media, episodes, series_schedule, lists, list_items, list_likes, external_list_likes, list_follows, hidden_items, channels, channel_items, channel_likes, addon_profiles, addon_rows, addon_tokens, legacy_installs, watch_events (hash-partitioned), show_progress, streaming_events, recommendation_snapshots, daily_title_counts, feedback_threads, feedback_messages, jobs, admin_audit_log). Migrations in `migrations/pg/`.
* **Files:** `packages/storage/**` (Kysely + Hyperdrive binding), repositories per aggregate, `packages/domain/**` rules (visibility, slugging, progress derivation, lineup) extracted from the current code with unit tests.
* **Hyperdrive + Postgres** provisioned for staging and production; PITR on; a nightly logical backup to R2.

### 3b · Migration tooling and rehearsals
* **A one-off migration program** (Node, run from CI against a snapshot) reading:
  * **D1** (export each table as JSON; `lists_fts` excluded — D1 export refuses virtual tables): all 20 tables.
  * **KV** (bulk list + get via the Cloudflare API): every prefix in `NEXT_VERSION_ARCHITECTURE.md` §1.2 except caches, rate limits and cron cursors.
* **Mapping and conflict rules:**

  | Source | Target | Rule |
  |---|---|---|
  | `creators` + `creator:` | `accounts` | Union by username; if both exist, D1 wins for `key_hash` unless KV's record is newer (compare rotation evidence); keep PBKDF2 strings verbatim; `key_lookup_hash` from `creator_key_lookups`/`keylookup:`. |
  | `creator_lists` + `creatorlist:` | `lists` + `list_items` | Per list, newest `updatedAt` wins (the `getCreatorList` rule); items → `media` via embedded ids/metadata (no provider calls during migration; enrichment jobs queued afterwards); order from `sort_order` then `creatorlistorder:`. |
  | `published_lists` + `publishedlist:user:` | `lists` (`owner_id` null) | Keep slugs; URLs `/lists/user/{slug}` preserved. |
  | `list_likes` + `listlikevoters:` + `extlikevoters:` | `list_likes`, `external_list_likes` | **Union** of voter sets; `u:{username}` → `acct:{uuid}`; `a:{hash}` kept as opaque anonymous keys. |
  | `channelshare:`, `creatorchannel:`, `index:publicchannels`, `channellikevoters:`, `creatorsyncchannels:` | `channels`, `channel_items`, `channel_likes` | Share codes preserved; likes/adds counts from the index row when the ledger is missing; owner username → account id. |
  | `creatorsynctracking:` + `watch_history`/`continue_watching`/`airing_next`/`creator_show_states`/`creator_tracking_meta` + `creatorscrobblequeue:` | `watch_events`, `show_progress`, account settings | Union of history by (media, season, episode) — one event per item at its latest `watchedAt` (earlier plays cannot be reconstructed; say so); `show_progress` from the latest watched episode per show; dismissals and Airing Next removals carried over; fully-watched becomes derived; COMPANION payloads → companion columns. |
  | Watchlist (three copies) | a system list (`kind = 'watchlist'`) | Newest of the three copies (`readAccountWatchlist` rule). |
  | `creatorsync:` | `addon_profiles` (default profile), `addon_rows`, `hidden_items`, `list_follows`, account settings; `keys` → `provider_connections` (encrypted) | The synced `config` becomes the account's **default add-on profile**. |
  | `creatorsyncpresets:` (incl. `presetsB64` gzip) | additional `addon_profiles` | One profile per preset name. |
  | `cfg:{id}` and bare 12-char ids | `legacy_installs` | Snapshot JSON **without** secrets; owner resolved from a still-verifying stored key, else from `trackOwner`, else null; provider tokens → owner's vault, or `legacy_installs.secrets_enc` (encrypted, server-use only) when there is no owner; plaintext keys dropped. |
  | `scrobble_tokens` + `scrobbletoken:` | `scrobble_tokens` (hashed) | The active token per account. |
  | `feedback` + `feedback:` | `feedback_threads`/`feedback_messages` | Newest `updatedAt`. |
  | `streaming_events` | `streaming_events` | Straight copy. |
  | `stats`, `source_groups`, `event_meta` | `daily_title_counts` (watch events per title/day), Analytics Engine back-fill of totals (optional), `media` (titles) | Historical page-view/install totals exported to a CSV for the admin archive. |
  | `bpimg:v1:*` | R2 `posters/bp/**` (optional) | Or drop and let the job refetch. |
  | Caches, `ratelimit:*`, `cron:*`, `migrated*`, `lastgood:` | — | Not migrated. |

* **Rehearsals:** run against a fresh production snapshot at least three times; each run produces a **verification report**: row counts per entity vs source, per-account checksums (lists, items, likes, history length), a random sample of 200 accounts diffed field by field through both old and new APIs, and a list of every conflict resolved and every record rejected.

### 3c · API v2 on PostgreSQL (dark launch)
* **API changes:** new `/api/v2/*` resources (accounts, sessions, lists, list items, channels, add-on profiles/rows/tokens, watch events, progress, follows, search, directory, provider connections, imports, feedback). OpenAPI spec committed; typed client generated for the SPA.
* **Sessions ship here** (Phase 7 structural piece): `POST /api/v2/sessions` accepts username + key and sets the session cookie; the legacy body-credential routes keep working unchanged.
* **Stremio routes** gain the add-on-token path (`/a1_{token}/…`) served from Postgres; legacy `/{cfg}/…` still served by the old storage until 3d.
* **Shadow reads:** for sampled Stremio catalog requests on legacy configs, the new stack computes the response from Postgres (fed by a nightly re-migration of changed records) and logs diffs; target < 0.5% differences, each explained.

### 3d · Production write cutover (one window)
1. Announce a 30–60 minute window. Stremio/Nuvio/Wako catalog reads continue from the old stores throughout.
2. Old Worker: website write routes return a friendly 503 "Upgrading — back in a few minutes" (feature flag); cron paused.
3. Final delta migration (records changed since the last rehearsal); verification report must pass the gate (100% account count parity, 0 rejected lists/items without an explanation, sampled diffs clean).
4. Switch routes: the new Worker serves everything on the production domain; legacy URL shapes handled by `routes/legacy.ts`.
5. Old stores stay **read-only** for 30 days. Rollback within the window = route back + re-enable old writes; writes made after cutover are exported from Postgres and replayed by a prepared reverse script (tested in rehearsal).

### 3e · Client transition to server authority
* On first load after cutover, a signed-in browser that holds **local-only** data (lists/channels never synced, device-only custom lists, OAuth tokens in `localStorage`) is shown a one-time **"Move this device's data to your account"** screen with a preview (what will be added, what already exists) — never a silent upload. Tokens found locally are sent once to `POST /api/v2/connections/import` and stored in the vault; then `localStorage` is cleared of secrets.
* Signed-out users with device-only data get a banner offering to create an account and move it.

* **Backward compatibility:** all legacy URLs (§3 below); old SPA builds cached by the service worker receive `409 upgrade-required` from removed endpoints and the SW updates.
* **Risks:** High (data). Mitigations: rehearsals with reports, shadow reads, a short window, a tested rollback, read-only retention of old stores.
* **Tests required:** migration unit tests per mapping rule (fixtures from real anonymized records), idempotency (running twice changes nothing), verification report tests, API v2 contract tests, legacy URL contract tests, rollback rehearsal.
* **Complexity:** XL.

---

## Phase 4 — Provider architecture

* **Files:** `packages/providers/{tmdb,trakt,mdblist,simkl,justwatch,rapidapi,tvmaze,metahub,betterposters}/{client,ops,map}.ts`; `packages/catalog/**` (source registry: `detectSource` successor with explicit Letterboxd detection, fetch → normalize → `media` resolve); removal of every raw `fetch()` from feature code (lint rule).
* **DB changes:** `media`, `episodes` populated through the provider layer; provider response snapshots in KV keyed by `(provider, op, params, credential scope)`.
* **API changes:** none externally; internal only.
* **Behaviour changes:** every call has a timeout (default 8 s), retries with jitter on 429/5xx honouring `Retry-After`, a circuit breaker per provider, per-provider concurrency and budget, metrics to Analytics Engine; MDBList watchlist uses the one confirmed endpoint; Trakt private-list auth failures surface "reconnect" instead of silently falling back.
* **Backward compatibility:** catalog responses identical (golden masters from Phase 2 extended with provider fixtures).
* **Risks:** Medium (provider quirks). **Tests:** recorded-fixture tests per provider op (success, 401, 404, 429, 5xx, timeout, malformed body), normalization tests, circuit-breaker tests.
* **Complexity:** L.

---

## Phase 5 — Background jobs and caching

* **Files:** `apps/jobs/src/schedules.ts` (cron → enqueue), `apps/jobs/src/consumers/*` (provider-refresh, show-schedule, imports, posters, provider-sync, token-refresh, webhooks, rollups, channel-pools), queue bindings in `wrangler.toml` for both Workers, DLQ.
* **Removes:** `scheduled()` budget arithmetic, `checkForNewEpisodes`, `refreshAiringNextSweep`, `prewarmSharedCatalogs` rotation, BetterPosters pre-warm KV lists, channel preset cursor, `/api/bulk-resolve` continuation, `/api/details/batch` budgets, request-time `waitUntil` rebuilds (FT-01…FT-07).
* **DB changes:** `jobs` table in use; `series_schedule` maintained by triggers or by the progress writer.
* **API changes:** `POST /api/v2/imports` (upload URL + job id), `GET /api/v2/jobs/{id}`; webhooks and playback pings answer immediately and enqueue.
* **Caching:** chart snapshots in KV with SWR metadata; Cache API for shared catalog pages keyed by `(row source, page, profile-independent params)`; per-colo add-on profile cache keyed by profile version; R2 for artwork.
* **Backward compatibility:** the Stremio subtitles ping and media-server webhook contracts unchanged (still 200 with the same body shape; processing becomes async).
* **Risks:** Medium (timing semantics — e.g. Continue Watching appears seconds after a ping instead of synchronously). **Tests:** consumer tests with fake queues, idempotency (duplicate messages), DLQ behaviour, schedule-due calculations, end-to-end "episode airs → appears in Continue Watching" test.
* **Complexity:** L.

---

## Phase 6 — Frontend and UX

* **Files:** `apps/web/src/**` new destinations (Discover, Library, Add-on, Settings), components, typed API client, query cache; `apps/api/src/routes/pages.ts` for lightweight public pages.
* **Order:** (1) **Add-on** destination first (live profile, install/devices, settings drawer — resolves F-C1, F-C4, F-H3, scenario 1/2/3/10); (2) **Library** (lists, channels, watching; F-H5/F-H6/F-H7); (3) **Settings** (account/devices, connected services, import & export hub — F-H2, F-C2, F-C3); (4) **Discover** (merge Quick Add; F-H4). Each destination ships behind a flag with the legacy tab available until parity is signed off.
* **API changes:** consumes `/api/v2/*` only; legacy creator routes unused by the new SPA.
* **Backward compatibility:** deep links (`/lists/{slug}`, `/lists/{u}/{s}`, `/channel/{code}`, `/configure#channel=…`, `/{config}/configure`) keep working — the last opens the Add-on screen with a "This is an old install link — manage it here" panel.
* **Risks:** Medium (user retraining). Mitigate with the flag rollout and in-app "What moved" notes.
* **Tests required:** component tests; Playwright journeys for the 12 scenarios in `FRONTEND_UX_AUDIT.md` §8 at desktop and 375 px; accessibility checks (axe) per destination; visual regression on key screens.
* **Complexity:** XL.

---

## Phase 7 — Security hardening (completion)

* Sessions everywhere in the SPA; body-credential routes deprecated then removed after usage drops (counter from Phase 1); **device list and "sign out everywhere"**; passkeys (WebAuthn) as an optional second factor/login; account key shown only at creation or after re-authentication.
* Provider vault complete: refresh job, upstream revocation on disconnect, key rotation for the encryption key (`key_id` per row).
* Add-on tokens: revoke per device; legacy install ids made read-only snapshots with secrets removed (done in Phase 3); `LEGACY_UNVERIFIED_CONFIG_SHELVES` decision executed.
* Admin behind Cloudflare Access (or admin accounts + passkeys), server-side admin sessions, `admin_audit_log` on every destructive action.
* Rate limiting via WAF rules and the Workers rate-limit binding on every credential and anonymous-write endpoint.
* CSP: nonce-based `script-src`, no `'unsafe-inline'`, narrowed `connect-src`/`img-src`, Trusted Types (requires Phase 6).
* Sunset legacy webhook `creator=&key=` (S-11) after an in-app notice period; rotate keys for accounts that used it.
* Logging policy: structured logs, no tokens/keys, URLs scrubbed of `api_key`.
* **Tests:** authz matrix per route (anonymous / other account / owner / admin), session fixation and revocation, CSRF on cookie-auth routes, token vault encryption round-trip, rate-limit behaviour, CSP report-only then enforce.
* **Complexity:** M.

---

## Phase 8 — Performance

* Budgets from `PERFORMANCE_AUDIT.md` §4 enforced in CI (bundle size check) and monitored (Analytics Engine timings, RUM web vitals).
* Add-on profile edge cache; dedupe-once; recommendation snapshots; directory first-page edge cache; R2 artwork; Hyperdrive query caching for public reads only.
* Load tests (k6) against staging: Stremio catalog mix (80% shared rows, 20% personal), webhook bursts, directory/search at 1M synthetic lists, 100k synthetic accounts with 2k-event histories.
* **Complexity:** M.

---

## Phase 9 — Testing (completion)

### 9.1 Testing audit (current state)

| Aspect | Finding |
|---|---|
| Volume | 1,212 tests in 19 files; 1,211 pass, 1 skipped (network-dependent); 146 s locally. |
| Style | Mostly **regression tests named after past audit fixes** ("audit fix 12: deleting an account leaves nothing behind", "A5: a key rotation must never report success without rotating"), run against the real Worker with a SQLite-backed D1 and an in-memory KV. This is a genuine strength: failure injection (`failWhen`, KV hooks) and a second-isolate helper exist. |
| Client | `client.test.mjs` evaluates the bundle in a `vm` with a permissive DOM stub; it tests request payloads and state transitions, **not rendering, layout, focus or real browser behaviour**. No browser tests in CI (the `audit/frontend-*` Playwright-style probes are not wired in). |
| Source-text assertions | `worker.test.mjs` reads source files 40 times; some tests assert on source text or constants (e.g. "every env var the code requires is documented", "the CDN script is integrity-pinned", "a sixth writer of creatorlist: must bump the stamp"). These pin implementation, not behaviour, and will all break on the Phase 2 port. |
| Gaps found by this audit | No test for the webhook user filter (B-H1 crashes); no test that published-list or Watch History rows honour `skip` (B-H7 fails); the account-deletion test does not check channels or install configs (B-H3); no test for anonymous share overwrite (S-3); no test that reads never write (B-H2); no test of operation counts or payload sizes; no scale tests; no Stremio protocol contract suite across all 30 source kinds; no migration tests beyond schema drift; no real-provider contract fixtures; no accessibility or visual tests in CI; no load tests. |
| Meaningless or low-value tests | Tests that assert a comment or constant exists; tests whose fixtures stub the exact function under test; duplicated coverage between `worker.test.mjs` and feature files. Keep them until Phase 2, then replace with behavioural tests. |

### 9.2 Test strategy for the next version

| Layer | Tooling | Scope | Priority areas |
|---|---|---|---|
| Unit | Vitest | `packages/domain`, mappers, SVG generators, slugging, progress derivation, lineup rotation, dedupe, visibility rules | Dedupe, progress, lineup, visibility |
| Repository / DB | Vitest + real PostgreSQL (Testcontainers or a Neon branch per CI run) | Every repository; migrations up from empty; constraint behaviour; cascade deletes | Migrations, deletion, likes counters, list CRUD |
| API contract | Vitest + OpenAPI schema validation | Every `/api/v2` route: happy path, validation errors, authz matrix | Authentication, creator ownership, public/private |
| Stremio contract | Vitest against a fixture profile | manifest, catalog (every source kind, paging, `skip`, search), meta, subtitles ping; response shapes clients depend on | Catalog generation, install links (new and legacy), provider failures |
| Legacy compatibility | Golden masters recorded from production-shaped fixtures | `/{cfg}/…`, `/{base64}/…`, `/lists/{u}/{s}.json`, `/channel/{code}`, backup import formats 1.x/2.0/3.0 | Install links, backup/restore |
| Provider | Recorded fixtures per op + fault injection | success, 401, 404, 429 with `Retry-After`, 5xx, timeout, malformed JSON | Provider failures |
| Jobs | Fake queue harness | idempotency, retries, DLQ, schedules, "new episode reaches every watcher" | Channels, watch history |
| Migration | Fixture snapshots of anonymized real records | each mapping rule, conflict rules, idempotency, verification report | Migrations |
| E2E | Playwright (desktop + 375 px) | the 12 scenarios; OAuth with mocked providers; sessions; device revoke | OAuth, install links, backup/restore, search |
| Security | Automated authz matrix, CSRF checks, rate-limit tests, CSP enforcement test, hostile-input render test (kept from today) | all routes | Authentication, ownership |
| Performance | k6 in staging; op-count assertions in integration tests (no KV/DB writes on GET routes; bounded statements per request) | catalog, webhooks, directory, sync | Performance regressions |
| Accessibility | axe-core in Playwright | each destination | — |

* **Complexity:** M (most tests are written alongside Phases 2–6; this phase completes e2e, load and contract suites).

---

## Phase 10 — Production migration completion and decommission

* After the 30-day read-only window: export and archive the D1 database and KV namespace to R2 (encrypted); delete the D1 database and the KV namespace's non-cache prefixes; delete migration tools (`/admin/api/migrate-d1`, `migrate-day-counts`, `rebuild-search-index`, `backfill-trending`) and hot-path shape migrations (FT-28, FT-29).
* Legacy surfaces reviewed with Phase 1 counters: keep `/{cfg}/…`, base64 decode, `/lists/{u}/{s}[.json]`, `/channel/{code}` **indefinitely**; sunset `creator=&key=` webhooks, body-credential account routes, and the old SPA's endpoints on published dates with in-app notices.
* Documentation: architecture, runbooks (deploy, rollback, restore from PITR, rotate encryption key, provider outage), on-call alerts.
* **Risks:** Low–Medium (deleting the old stores is irreversible — only after verification and archive).
* **Complexity:** M.

---

## 3. Do not break current users (Phase 18)

| Asset | What exists today | Needs migration? | Plan | Compatibility guarantee |
|---|---|---|---|---|
| **Creator profiles** | `creators` rows + `creator:` KV (PBKDF2 `key_hash`, optional recovery hash) | Yes | → `accounts`; hashes copied verbatim; usernames preserved; lookup hashes recomputed at next login | Every existing key signs in after cutover; recovery answers still work; nobody is asked to reset. |
| **Lists** | D1 `creator_lists` (items JSON) + KV `creatorlist:`; order in KV + D1 | Yes | → `lists`/`list_items`; newest copy wins; order preserved | Slugs and `/lists/{u}/{slug}` URLs unchanged; item order unchanged; visibility unchanged. |
| **Anonymous published lists** | D1 `published_lists` + KV `publishedlist:user:` | Yes | → `lists` with no owner | `/lists/user/{slug}` and `.json` unchanged; admin can still remove them. |
| **Channels** | Browser `localStorage`; KV `creatorsyncchannels:` (synced), `channelshare:` (shared/published), `creatorchannel:`, `index:publicchannels` | Yes (server copies); browser copies at next visit | → `channels`/`channel_items`; share codes and public slugs preserved; browser-only channels via the Phase 3e "move this device's data" screen | `/channel/{code}`, `/channels/{u}/{slug}`, `#channel=` deep links keep working; channel payloads embedded in old install configs keep playing. |
| **Install links** | `cfg:{12}` (prefixed), bare 12-char ids, base64 configs | Yes (`legacy_installs`) | Snapshot rows without secrets; owner resolved where provable; tokens moved to the vault or kept encrypted server-side for that install only | Every existing `/…/manifest.json`, catalog, meta and subtitles URL keeps returning the same rows. Personal shelves on unverified legacy configs follow the S-12 decision with owner notification. |
| **Configuration URLs** (`/{config}/configure`) | Renders the builder with the config's entries (and, today, tokens) | No data move | Opens the new Add-on screen showing the legacy install, with "upgrade to a live link" | Link keeps working; tokens are no longer rendered. |
| **OAuth connections** | Tokens in browsers, configs, `creatorsync.keys`, backups; no refresh tokens | Yes | Server-side copies vaulted at migration; browser copies vaulted on next visit; users prompted once to reconnect to obtain refresh tokens (non-blocking banner; existing tokens keep working until expiry) | No connection stops working at cutover; each user reconnects once at their convenience. |
| **Watch history** | KV blob + D1 `watch_history` (+ browser caches) | Yes | → `watch_events` (one event per item at latest `watchedAt`) | Every watched item present; order by date preserved; rewatch counts before cutover are not reconstructable (documented). |
| **Continue Watching / Airing Next / dismissals / removals / fully-watched** | KV blob + D1 tables | Yes | → `show_progress` + derived views | Same shows appear; dismissals and Airing Next removals honoured; companions preserved. |
| **Watchlist** | Three copies | Yes | Newest copy → system list | Same items; Stremio Watchlist row unchanged. |
| **Public lists** | Directory from D1 UNION | Yes (with lists) | — | Same lists visible, same like counts. |
| **Likes** | D1 `list_likes`, KV ledgers (lists, external URLs, channels), counts on records | Yes | Union of voter sets; counters recomputed | No like lost; no double counting (sets, not sums). |
| **Liked / hidden lists** | D1 `creator_user_lists` + `creatorsync:` | Yes | → `list_follows`, `hidden_items` | Same lists followed/hidden. |
| **Presets** | KV `creatorsyncpresets:` (optionally gzip-base64) | Yes | → additional `addon_profiles` | Each preset available as a named profile. |
| **Backups** | Files on users' disks (formats 1.x, 2.0, 3.0; contain keys and tokens) | No | Import accepts all formats forever; secrets in imported backups are vaulted, never echoed | Old backups restore; new exports contain no secrets. |
| **Scrobble webhooks** | Token URLs; legacy `creator=&key=` URLs | Tokens yes (hashed) | Tokens preserved; legacy form accepted until the published sunset with notices | Plex/Jellyfin/Emby keep scrobbling without reconfiguration. |
| **Feedback threads** | D1 + KV | Yes | → threads/messages | Users see their history. |
| **New on Streaming history** | D1 `streaming_events` | Yes (copy) | Straight copy | Shelf unchanged. |
| **Most Watched** | KV snapshots + `stats` | Partly | `daily_title_counts` from `stats evt:watched:*` day rows | Charts continue without a reset. |
| **Admin data** (counters, leaderboards) | D1 `stats`, `source_groups` + KV | Archived | CSV archive + Analytics Engine from cutover | Historical totals available in the archive; new dashboards start from cutover. |
