# Migration Plan

**Date:** 2026-09-25 · **Status:** plan only.

**Goal.** Move the hosted mylistsaddon.com from the current architecture to the one in `NEXT_VERSION_ARCHITECTURE.md` **without breaking current users**, **without a big-bang rewrite**, and **keeping "paste `worker_entry_combined.js` into the Cloudflare dashboard" as the deploy step**.

---

## 1. Principles

### 1.1 Strangler, expand/contract

- Every schema change is **additive first** (expand): new tables and columns, and old code keeps working. Old structures are removed only after the new path has served all traffic for a full release and a reconciliation report is clean (contract).
- Every behavior change is behind a **Worker variable flag** (dashboard → Settings → Variables), so it can be turned off without redeploying. Examples: `FF_V2_LISTS_READ`, `FF_SESSIONS`, `FF_EVENT_TRACKING`, `FF_SHOW_SCHEDULE`, `FF_NEW_UI`.
- **Data is dual-read, not dual-written**, wherever possible: during a transition, v2 reads fall back to legacy storage and **migrate on read**. A background backfill job converges the rest. Dual writes are allowed only for a bounded window with a reconciliation job (they are the root cause of BE-C1).

### 1.2 Reversibility

- Before each phase: a **D1 export** (`wrangler d1 export` from CI, or the D1 dashboard) plus a **KV key-list snapshot** (count by prefix) stored in R2 (`backups/`).
- Keep the last three built `worker_entry_combined.js` files as CI artifacts. **Rollback = paste the previous file.** This works only because schema changes are backward compatible (expand/contract).

### 1.3 Release procedure (every release, paste-deploy compatible)

1. CI: `npm run build`, then lint, then tests (workerd), then check that the rebuild matches the committed file.
2. CI (manual approval): apply pending D1 migrations with `wrangler d1 migrations apply --remote` using a scoped API token. Each migration records itself in `schema_migrations`. *Owner alternative: paste each new `migrations/*.sql` into the D1 console in order, after checking `SELECT * FROM schema_migrations`.*
3. The owner copies `worker_entry_combined.js` into the dashboard editor and clicks Deploy.
4. Smoke tests (`scripts/smoke.mjs` against production): `/`, a legacy `cfg` manifest and catalog, a v2 install, the directory, login.
5. Watch dashboards for 30 minutes: errors, CPU, D1 overload errors, queue backlog.

The Worker refuses to serve `/api/*` writes if `schema_migrations` is behind the version compiled into it (503 plus an admin banner). This replaces today's silent degradation (FT-08).

---

## 2. Phases

### Phase 0 — Audit (this document set)

**Deliverables:** the eight documents. **Owner decisions needed before Phase 1:**

- Which anonymous features survive: anonymous likes? anonymous installs without an account? **Decided 2026-09-25:** likes need an account, and existing signed-out likes keep counting (D-6, D-9). Signed-out installs survive, limited to the site's public lists (D-8). See `docs/DECISIONS.md`.
- The JustWatch vs. RapidAPI default (BE-M12).
- Whether to add optional email recovery.
- Confirm the rotation of the credentials leaked in git history (SECURITY S-21).
- Confirm dashboard availability of Queue and Analytics Engine bindings (NEXT_VERSION_ARCHITECTURE §0.1).

---

### Phase 1 — Hotfixes, and removal of dead / free-tier / self-host code

**Complexity: Low–Medium · Risk: Low.** No data-model change.

| Area | Change |
|---|---|
| **Security hotfixes** | S-03: set `cacheTtl: 0` on every credentialed provider call (`06_`, `25_`). S-07: TMDB callback requires `request_token === cookie`. S-15: reject credentials in query strings on `/api/preview`, `/api/feedback/threads`, `/api/simkl/my-lists`, `/api/tmdb-my-lists`, `/api/mdblist-my-lists` (accept in the body). S-19: use `safeErrorMessage` in the TMDB callback. S-18: remove the `?debug=1` pages. |
| **Correctness hotfixes** | BE-H01: chunk `attachEventMeta` at 90. BE-H09: stop `tt`-prefixing non-IMDb ids in `fetchPublishedListCatalog`. BE-M01: delete the dead `getCreator` fallback. BE-M04: add a day bucket to badge URLs. |
| **Free-tier removal** | FT-02 and FT-03 (delete the budget knobs; the endpoints process full batches); FT-04 (README, wrangler vars, `header.js`); FT-05; FT-09 (never *generate* base64 configs; show an error on save failure); FT-10 (delete the sibling proxy); FT-11 (copy); FT-12 (fail closed); FT-25 (delete the `lastgood:` writes and reads); the interactive part of FT-35 (no in-request sleeps); FT-38 (document the dashboard settings in `docs/OPERATIONS.md`) |
| **Schema tooling** | Add migration `0014_schema_migrations.sql` (ledger, backfilled with rows for 0001a–0013). Rename `schema.sql` to `schema.reset.sql` with a warning banner; add `schema.create.sql` (no DROPs) for the harness. |
| **Observability** | Add an Analytics Engine binding `ANALYTICS` and `writeDataPoint` for route, status, CPU and KV/D1 operation counts per request. Nothing is removed yet. |
| **Backups** | A nightly CI job: D1 export to R2 (or keep it as a CI artifact). |

- **Files:** `00_`, `02_`, `03_`, `04_`, `05_`, `06_`, `07_`, `24_`, `25_`, `26_`, `header.js`, `build.ps1`, `wrangler.toml`, `README.md`, `migrations/0014`, `docs/OPERATIONS.md`, `tests/*`.
- **API changes:**
  - `/api/bulk-resolve` and `/api/details/batch` always return `done: true`.
  - `/api/resolve` loses the remote fallback.
  - Query-string credentials return 400 with a clear message.
- **Frontend:** remove the base64 fallback branch and the "Worker owner" messages; send credentials in bodies (already mostly true).
- **Backward compatibility:** legacy base64 install URLs still **read** (`decodeConfig` stays). Old clients' `/api/details/batch` loops terminate immediately.
- **Tests:** a harness guard for more than 100 bound parameters (TESTING T-02); a regression test that a credentialed provider fetch never sets `cf.cacheTtl`; the TMDB CSRF test; the published-list id test.

---

### Phase 2 — Backend architecture (behavior-preserving restructure)

**Complexity: High · Risk: Medium.** Pure refactor; flags off.

1. **Tooling:** commit `package.json` (esbuild, vitest plus `@cloudflare/vitest-pool-workers`, eslint, typescript for JSDoc type checking). Remove `package.json` from `.gitignore`.
2. **Move server code into `src/` modules** (NEXT_VERSION_ARCHITECTURE §7.2):
   - mechanically first (one module per current concern, named exports, no logic change);
   - then extract `handleFetch` into a router table (`src/http/router.js`) with the same route order;
   - hoist the request-scoped closures (`authenticateCreator`, `handleSubtitlesTrack`, `handleMediaServerScrobble`) to modules that take `(env, ctx, request)`.
3. **Client code into `src/frontend/legacy/`**, still as one bundle, **no longer inside a template literal**. esbuild emits `app.[hash].js` and `.css`, embedded as strings. Remove `splitAppBundle` and the page memos (FT-23). Inline handlers keep working for now: they call globals exposed on `window`.
4. **`build/build.mjs`** outputs `worker_entry_combined.js` (same file name, still one file). The CI drift check stays. `build.py` / `build.ps1` / `check_sync.py` / `gen_map.py` / `extract_html.py` are retired; `scope_check.mjs` is replaced by ESLint `no-undef`.
5. **Cross-cutting modules:**
   - `providerFetch` (timeouts, redaction) used by every provider call (BE-H10);
   - `logger` with secret redaction (S-14);
   - a single **install-config schema** module used by the save, resolve, decode and client code (removes the 6 copies);
   - `json()` defaults to `no-store`, and public routes opt into caching (BE-M17).
6. **Tests:** port `tests/harness.mjs` usages to the workerd pool incrementally. Keep the old suite green throughout. Replace source-text assertions (T-05) with behavior tests.

- **DB / API changes:** none.
- **Frontend:** build pipeline only.
- **Backward compatibility:** byte-different, behavior-identical Worker. Verify with the existing 1,212 tests plus a 24-hour shadow period: deploy with the flags off and compare the error rate and the route mix in Analytics Engine.
- **Risk:** accidental behavior changes during extraction. Mitigate with small PRs, one module family each, and the full suite on each.

---

### Phase 3 — Storage and identity (the core migration)

**Complexity: High · Risk: High.** Split into three sub-phases, each shippable on its own.

#### 3a — Identity, sessions, installs, connections

- **DB (additive):**
  - `accounts` (populated from `creators`; `id INTEGER` assigned; keeps `key_hash` and `recovery_answer_hash`);
  - `sessions`;
  - `installs` (with `legacy_cfg_id`);
  - `provider_connections` (encrypted);
  - `rate_counters`;
  - `account_settings`;
  - `schema_migrations` rows.
- **Secrets:** `TOKEN_ENCRYPTION_KEY` (AES-GCM, 256-bit, with a key id), `LOOKUP_PEPPER`.
- **API:**
  - `POST /api/session` (login; accepts username and key; sets the cookie) and `DELETE /api/session`.
  - `GET /api/me`.
  - `GET/POST/PATCH/DELETE /api/installs`.
  - `/api/connections/*` (OAuth callbacks now store server-side and redirect **without** a token).
  - **CSRF middleware** (Origin or `Sec-Fetch-Site` plus JSON content type) on every state-changing route (S-09).
- **Compatibility:**
  - Every existing `/api/creator/*` route still accepts `creatorName`/`creatorKey` in the body. On success it **also sets a session cookie**, so updated clients upgrade silently. Routes accept *either* a session or key-in-body during the window.
  - Legacy install resolver: a request for `/{cfgId}/…` loads `cfg:{id}` (or the bare id), then creates or loads the `installs` row with `legacy_cfg_id = id`. If the config names a verified owner (a valid `trackCreatorKey` or a stamped `trackOwner`), it binds `account_id`, moves embedded tokens into `provider_connections` (if the account has none, or if these are newer), and **rewrites the KV record without secrets**. Details in §3.2.
  - OAuth tokens held in browsers: on first sign-in with a session, the client posts its local tokens once to `/api/connections/import-local`. The server validates each (a cheap provider call) and stores it. The client then deletes them from `localStorage`.
- **Blind index (S-06):** `accounts.key_lookup_hmac` is filled on the next successful login (the key is present then). The old SHA-256 lookups remain readable until the sunset (Phase 10).

#### 3b — Lists, likes, channels, directory

- **DB:** `media` (seeded lazily and by backfill), `lists`, `list_items`, `list_slug_history`, `likes`, `channels`, an FTS external-content table, `account_list_prefs`, `presets`.
- **Backfill job** (`migrate.lists`, a resumable job per account):
  1. Read every `creatorlist:{u}:*` KV record **and** the `creator_lists` D1 row.
  2. Choose the newest by `updatedAt` (the same rule `getCreatorList` uses today).
  3. Resolve item ids to `media` rows (TMDB `/find` batched and cached; unresolvable items kept as `media` rows with only the external id).
  4. Insert into `lists` and `list_items` with `position` from `creatorlistorder:` (KV) or `sort_order` (D1), whichever is newer.
  5. Likes: union of `list_likes`, `listlikevoters:{…}` and `externallike`/`extlikevoters`, deduplicated by voter id. `like_count` comes from the union count.
  6. Channels: `creatorsyncchannels:{u}` (per account) and `channelshare:{code}` (shared); pools to R2; the directory entries' likes and adds come from `index:publicchannels`.
  7. Legacy anonymous lists: `publishedlist:user:*` and `published_lists` become `lists(kind='legacy_anonymous', owner NULL)`.
  8. Write a per-account reconciliation record (counts before and after, mismatches).
- **Read path:** with `FF_V2_LISTS_READ`, the list, directory, search, catalog and public page routes read v2. **Migrate on read:** if an account isn't migrated yet, run its backfill inline (bounded) before answering.
- **Write path:** new item-level endpoints (`POST /api/lists/:id/items`, `DELETE /api/lists/:id/items/:mediaId`, `PATCH /api/lists/:id`, `POST /api/lists/:id/move`). **Compatibility:** `/api/creator/lists/save` (whole list) becomes a shim that diffs the posted items against v2 and applies adds, removes and moves. It never replaces wholesale, and it enforces the version check.
- **KV:** after the read flip, stop writing `creatorlist:` / `creatorlistorder:` / `creatorliststamp:` / ledgers (the legacy keys remain until Phase 10).

#### 3c — Activity (watch history and progress)

- **DB:** a new D1 database **`DB_ACTIVITY`** (bound in the dashboard) with `watch_events`, `show_progress` and `user_media_state`. `show_schedule` lives in `DB`.
- **Backfill job** (`migrate.activity`, per account):
  1. Take the union of the KV `creatorsynctracking:{u}` blob, the D1 tracking tables and the scrobble queue key, newest-wins per item.
  2. Emit `watch_events`: one per history item, using `watchedAt`, with source `migrated`.
  3. Derive `show_progress` from the latest watched episode per show, plus dismissals and airing removals from `creator_show_states` or the blob, plus companions from the `COMPANION:` field.
  4. The Watchlist becomes a `lists(kind='watchlist')` row: the newest of the three copies.
- **Write path:**
  - With `FF_EVENT_TRACKING`: scrobbles (subtitles ping, webhook) enqueue events; the consumer writes rows.
  - `/api/creator/sync/save-tracking` becomes a shim that diffs the pushed blob against v2 and inserts only new events. Removals are honored only when the request is marked as an intentional removal (the existing `isIntentionalRemoval` semantics).
  - The KV blob is **no longer written**.
- **Read path:** personal shelves and `/sync/load` are served from v2 (`/sync/load` assembles the legacy shape for old clients).
- **Risk:** highest in the plan.
- **Mitigation:** run the backfill for all accounts in shadow first, with `FF_EVENT_TRACKING` off. Compare v2-derived shelves with the current shelves for 100% of active accounts, and investigate differences above a threshold before flipping.

**Tests for Phase 3:**

- Migration tests from anonymized production fixtures (T-07): per-account invariants (list count, item count, like count, history count, latest episode per show).
- Shim tests: old client payload in, correct row operations out, no data loss on a stale push.
- Session and CSRF suite; install legacy-resolver suite (cfg, bare id, base64, with and without `trackCreatorKey`).

---

### Phase 4 — Provider architecture

**Complexity: Medium · Risk: Medium.**

- `src/providers/*` adapters with `parseRef`, `fetchPage`, `shared`, `auth` (NEXT_VERSION_ARCHITECTURE §6.2). The registry replaces `detectSource`'s if/else, and `fetchCatalog` becomes `registry.resolve(row).fetchPage()`.
- `media-resolver`: every item emitted to Stremio carries a canonical id from `media` (fixes the id inconsistencies behind BE-H09 and the `split(':')` bugs).
- Chart **snapshots** (`snap:chart:*`) written by the refresh logic, run synchronously on a miss until Phase 5 moves it to the queue.
- Per-provider breaker state in KV (`pb:*`), and Analytics Engine metrics per provider.
- **Compatibility:** all existing source strings (`tmdb:chart:…`, `trakt:watchlist`, `mdblist:…`, URLs, `channel:v1:`, `customlist:v1:`) are parsed by adapters. Legacy payload rows are converted to entity references when an install is migrated.
- **Tests:** provider contract fixtures per endpoint (T-06); adapter unit tests; a snapshot "empty never replaces non-empty" test.

---

### Phase 5 — Background jobs and caching

**Complexity: High · Risk: Medium.**

- **Bindings:** Queue `JOBS` (producer) plus the consumer configured on the queue (this Worker), and a DLQ. **Cron triggers:** `*/5` dispatcher, hourly, daily (NEXT_VERSION_ARCHITECTURE §5).
- **Jobs:**
  - `scrobble`
  - `show.refresh`
  - `chart.refresh`
  - `import.resolve` (replaces `/api/bulk-resolve`)
  - `provider.sync`
  - `token.refresh`
  - `account.purge`
  - `poster.fetch` (R2)
  - `channel.pool.build` (R2)
  - `recs.build`
  - `nos.sweep`
  - `rollup.daily`
- **Show-centric shelves:** `show_schedule` is populated from all `show_progress` shows (`watcher_count > 0`). Continue Watching and Airing Next become read-time joins. **Shadow-compare** against the current cron-built shelves for a week (log differences to Analytics Engine) before flipping `FF_SHOW_SCHEDULE`.
- **Remove after the flip:** `checkForNewEpisodes`, `refreshAiringNextSweep`, `prewarmSharedCatalogs`, `prewarmBetterPosters`, `prewarmChannelPresets` cursors, the client `refreshAiringNext` and `/api/details/batch` loops, and every `cron:*` KV key (FT-18, FT-19, FT-30).
- **Materializer:** per-install page-0 materialization with dedupe (BE-H03), in the Cache API plus `snap:mat:*`.
- **Compatibility:** old clients that still call `/api/details/batch` get a normal answer. Old clients that push Airing Next snapshots are ignored (the server is the source).
- **Tests:** job idempotency (duplicate delivery), DLQ handling, dispatcher lease expiry, shelf-equivalence tests on fixtures.

---

### Phase 6 — Frontend and UX

**Complexity: High · Risk: Medium.**

- A new app shell (router, install bar, toasts, modal component, API client) behind `FF_NEW_UI` (a cookie opt-in, then a percentage rollout).
- **View-by-view replacement**, in this order: Settings (Connections, Account, Devices, Installs) → Home / home-screen editor (paste-first add, review table, dedupe toggle, live preview) → Lists (list page, inline add titles, share with Private/Unlisted/Public) → Explore (merge of Discover, Search and the directory) → Imports (job progress plus review) → Channels (templates first; the legacy builder wrapped until rewritten) → Admin (a separate bundle behind Cloudflare Access).
- **Remove:** `localStorage` data keys (keep preferences only), native `alert()` calls, inline handlers (enables the strict CSP in Phase 7), and the all-tabs-at-once DOM.
- **Compatibility:**
  - Old URLs map to new routes: `/configure`, `/:config/configure` (becomes "Sign in to edit this install"; see §3.2), `/lists/:slug`, `/lists/curated/:slug`, `/lists/:user/:slug`, `/channel/:code`, `/channels/:user/:slug`.
  - The PWA service worker is updated to new asset names, with an `activate` handler that clears old caches (the existing SW already prunes unknown caches).
- **Tests:** Playwright E2E for the 12 scenarios (FRONTEND_UX_AUDIT §7) at 375 and 1280 px; axe; visual smoke.

---

### Phase 7 — Security hardening

**Complexity: Medium · Risk: Low–Medium.**

- **CSP:** `script-src 'self' 'nonce-…'` (no `unsafe-inline`); self-host `fflate` and fonts; Trusted Types report-only, then enforced (S-05).
- **Admin:** Cloudflare Access in front of `/admin*` (dashboard, SSO plus MFA); D1 admin sessions; `admin_audit_log` (S-10).
- **WAF rate-limiting rules** for per-IP abuse (S-13); D1 counters for per-account limits.
- **PBKDF2:** raise iterations; rehash on login (S-16).
- **Recovery:** one-time recovery codes (plus optional email) (S-11).
- **Scrobble:** `st` token only. Sunset the `config=` and `creator=&key=` webhook forms with an in-app banner showing the new URL (S-08).
- **Anonymous likes:** decided: they need an account (D-6), and those already cast keep counting (D-9) (S-09, S-20).
- **`/api/save` successor:** signed-out installs carry public lists only (D-8, already enforced). They never expire (D-10); the existing size caps stay (S-12).
- **Tests:** the security suite (TESTING §14.3 item 7).

---

### Phase 8 — Performance

**Complexity: Medium · Risk: Low.**

- D1 read replication plus `withSession` on catalog and directory reads.
- Analytics Engine replaces all `stats` writes; `title_daily_stats` for Most Watched (BE-H11).
- Bundle budgets in CI (first view under 150 KB gzip); route-level code splitting.
- Poster pipeline: R2 plus Cache API, and a non-blocking BetterPosters fetch.
- **Tests:** k6 load tests (catalog hot path, scrobble burst, directory paging). Assert p95 targets (PERFORMANCE_AUDIT §5).

---

### Phase 9 — Testing (runs alongside every phase; listed for its dedicated deliverables)

- The workerd test pool as the default; the node harness retired.
- Migration test suite on anonymized fixtures.
- Provider contract fixtures plus a nightly live check.
- Playwright E2E and axe in CI.
- Security regression suite.
- Load tests in a staging Worker (a separate Worker plus separate D1 databases, bound in the dashboard).

---

### Phase 10 — Production migration and cleanup

**Complexity: Medium · Risk: Medium.**

1. **Flip order** (each flip after the previous one has run cleanly for at least 7 days):
   1. `FF_SESSIONS`
   2. `FF_V2_LISTS_READ`
   3. v2 list writes
   4. `FF_EVENT_TRACKING`
   5. `FF_SHOW_SCHEDULE`
   6. `FF_NEW_UI` at 10% → 50% → 100%
2. **Reconciliation gates:**
   - 100% of accounts migrated (`jobs` shows no pending `migrate.*`);
   - reconciliation mismatches below 0.1%, and each one reviewed;
   - legacy-route usage tracked in Analytics Engine.
3. **Sunset legacy** (announced in-app at least 60 days ahead):
   - Key-in-body auth on `/api/creator/*`.
   - The `/api/creator/sync/*` shims.
   - The `/api/resolve` route.
   - `LEGACY_UNVERIFIED_CONFIG_SHELVES` → false (FT-37).
   - Scrobble `config=` / `key=` forms.
   - The SHA-256 key lookup.
   - List tombstones for old clients (FT-26).
4. **Delete legacy storage**, after a final D1 export and a KV export of the affected prefixes to R2:
   - KV: `creator:`, `creatorlist:`, `creatorlistorder:`, `creatorliststamp:`, `creatorlistdeleted:`, `creatorsync*:`, `creatorshare:`, `listlikevoters:`, `extlikevoters:`, `externallike:`, `channellikevoters:`, `index:publicchannels`, `channelshare:` (after the R2 copy), `evt*:`, `stats:*`, `searchquery*:`, `feedback:`, `ratelimit:*`, `authfail:*`, `cron:*`, `migrated*:`, `creatortrack:`, `creatorscrobblequeue:`, `trackingd1behind:`, `airingnextchecked:`, `bpimg:*` (after the R2 copy), and `cache:*` / `lastgood:*` (expire naturally).
   - Legacy D1 tables: `creators` (after verification against `accounts`), `creator_lists`, `published_lists`, `list_likes`, `list_tombstones`, `creator_tombstones`, `watch_history`, `continue_watching`, `airing_next`, `creator_show_states`, `creator_tracking_meta`, `creator_user_lists`, `event_meta`, `source_groups`, `stats` (after the Analytics Engine backfill of history), `scrobble_tokens` (after moving into `installs`/tokens), `creator_key_lookups`.
   - **`cfg:{id}` records are kept** (secrets stripped) as long as any legacy install id is still used. `installs.legacy_cfg_id` makes them redundant; delete a record once its install has been served from D1 for 30 days.
5. **Docs:** README (product), `docs/OPERATIONS.md`, `docs/ARCHITECTURE.md` (a trimmed version of this plan). Archive `STORAGE-PLAN-KV-D1.md`, `COMPLETE_AUDIT_REPORT.md`, `UI_UX_AUDIT.md`, `Changes.md` and `FUNCTION-MAP.md` under `docs/history/`.

---

## 3. Phase 18 — Do not break current users

| Asset | Where it lives today | Migration | Compatibility guarantee | Verification |
|---|---|---|---|---|
| **Creator profiles** | D1 `creators` plus KV `creator:` (some KV-only) | `accounts` from the union, newest-wins on `keyHash` (the D1 row wins when both exist; KV-only accounts are imported) | The same username and the same Creator Key log in. Existing PBKDF2 hashes are verified as-is, then rehashed at higher cost. | Count of `creators ∪ creator:` = `accounts`; a login test sample |
| **Custom lists** | KV `creatorlist:` plus D1 `creator_lists` | §2 Phase 3b | Same slugs, same public URLs (`/lists/:user/:slug`, `.json`); private stays private; like counts preserved (union of ledgers) | Per-account list, item and like counts |
| **Local-only lists** (signed-out browsers) | `localStorage` only | Not on the server. The new UI offers "Save to an account" or "Export". Signed-out users keep a local mode for their existing lists until they choose. | Nothing is deleted from browsers | — |
| **Channels** | `localStorage`, `creatorsyncchannels:` blob, `channelshare:{code}`, `index:publicchannels` | `channels` plus R2 pools; directory entries become `visibility='public'`; like and add counts carried over | `/channel/{code}` and `/channels/{user}/{slug}` resolve; channel rows in existing installs (payload in `entry.url`) are converted to `channel:{publicCode}` references when the install is migrated, and **also still parse** as payloads until then | Count of codes; sample lineup equality (the same day seed yields the same lineup; the rotation code is moved unchanged) |
| **Install links** | `cfg:{id}` / bare `{id}` (KV), base64 in the URL | §3.2 | Every existing URL keeps serving catalogs | Legacy-resolver hit metrics; zero 404s for known ids |
| **OAuth connections** | `localStorage`, `cfg:` records, `creatorsync:{u}.keys`, base64 URLs | `provider_connections` from (a) the account's `creatorsync.keys`, (b) the newest token found in the account's bound configs, (c) a one-time client upload (Phase 3a). Tokens validated before storing. | Personal provider rows keep working in installed apps. Expired tokens show a reconnect banner (they were already broken, silently). | Count of connections by status |
| **Watch history** | KV blob, D1 tracking tables, scrobble queue, browser | §2 Phase 3c union, newest-wins | No history lost; duplicate items deduplicated by (media, season, episode, watchedAt ±10 min) | Per-account history counts: v2 ≥ max(KV, D1); spot checks |
| **Continue Watching / Airing Next** | Stored shelves (KV, D1, browser) | Derived from `show_progress` plus `show_schedule`; dismissals and removals migrated | The same shows appear, and dismissed shows stay dismissed | Shadow comparison (Phase 5) |
| **Watchlist** | Three copies | Newest-wins, becoming `lists(kind='watchlist')` | The same items | Count |
| **Public lists and directory** | D1 query plus KV | `lists.visibility='public'`; legacy anonymous preserved | Directory order by likes preserved | Top-100 order diff before and after |
| **Likes** | `list_likes` plus KV ledgers plus record `likes` fields | Union of voter sets, deduplicated | Counts are **not lower** than today's displayed count, except where duplicates were removed (logged) | Per-list diff report |
| **Liked / hidden lists and sections** | `creatorsync` blob plus `creator_user_lists` | `account_list_prefs` | Preserved | Count |
| **Presets** | `creatorsyncpresets:` plus browser | `presets` table | Preserved | Count |
| **Backups (user files)** | JSON exports (formats vary; may contain the key and tokens) | The importer accepts **all** historical formats (`24_` parsers are moved as a module). Secrets in old backups are accepted once, validated, stored server-side, and never echoed back. | Old backups restore | Fixture tests per known format |
| **Configuration URLs** | `/configure`, `/:config/configure`, `/lists/:slug`, `/lists/curated/:slug`, `/channel/:code`, `/channels/:user/:slug`, `/guide` | Routed in the new router | All resolve. `/:config/configure` asks to sign in if the install is account-bound; otherwise it opens an editor for an anonymous install. | Route tests |
| **Scrobble webhooks** | `?st=`, `?config=`, `?creator=&key=` | `st` tokens move into the installs/tokens model | All three forms keep working until the sunset date (Phase 10), with an in-app banner showing the new URL | Webhook usage by form |
| **Feedback threads** | D1 `feedback` plus KV | `feedback` (thread) plus `feedback_messages` | Thread ids keep working | Count |
| **New on Streaming history** | D1 `streaming_events` | Kept as-is (observed dates can't be re-fetched) | Unchanged | — |
| **Statistics history** | D1 `stats` plus KV | Backfilled into Analytics Engine where possible; `title_daily_stats` from `stats evt:*` | Admin charts keep their history | Totals match |

### 3.2 Legacy install resolution (detail)

1. The request arrives at `/{id}/manifest.json` or `/{id}/catalog/...`:
   - if `id` is 12 characters or fewer, it is a KV id;
   - otherwise it is base64.
2. **KV id:** look up `installs WHERE legacy_cfg_id = id`.
   - **Found:** serve it as a v2 install. Snapshot via KV `install:*`.
   - **Not found:** read `cfg:{id}` (or the bare `{id}`) and create the `installs` row:
     - `config_json` = rows converted to v2 references (payload channels become `channels` rows with owner = the bound account or NULL; `customlist:v1:` payloads become `lists` rows);
     - owner = the verified owner (a valid `trackCreatorKey`, or a stamped `trackOwner`; if `LEGACY_UNVERIFIED_CONFIG_SHELVES` is on, the named creator, flagged `verified=0`);
     - tokens and keys go to `provider_connections` if an owner exists; otherwise they are held encrypted on the install row (`install_secrets`) for read-only use until the sunset;
     - then **rewrite `cfg:{id}` without any secrets or `trackCreatorKey`**.
3. **base64:** decode (FT-09 read-only). Serve public sources only. Personal shelves and tokens in base64 configs are honored until the sunset date, then ignored, with the in-app notice "Reinstall from mylistsaddon.com to keep personal rows".
4. The stable install URL for the future is `/i/{token}/manifest.json`. **Legacy URLs are not redirected** (Stremio installs pin the URL); they are served indefinitely.

### 3.3 Communication

- An in-app "What's changing" page before Phase 10 sunsets.
- A banner for any account still using a legacy scrobble URL, a base64 install, or an expired provider connection.
- The CHANGELOG v2 section.

---

## 4. Risk register

| Risk | Phase | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| Backfill loses or duplicates list items or history | 3 | Medium | High | Newest-wins rules taken from existing code; per-account reconciliation; shadow period; D1 exports; the legacy stores are not deleted until Phase 10 |
| Auth regression (users locked out) | 3a, 7 | Low | High | Dual acceptance (key-in-body plus session); flags; login-success-rate alert |
| Legacy install URLs break | 3a, 5 | Low | Very high | The legacy resolver is never removed; route tests over a sample of real ids (hashed) |
| D1 overload or size | 3c, 5 | Low | High | Separate `DB_ACTIVITY`; `shardFor()` from day one; size alerting at 6 GB |
| Queue backlog or poison messages | 5 | Medium | Medium | A DLQ, idempotent handlers, backlog alerts, the dispatcher re-enqueue |
| Provider behavior differences after the adapter rewrite | 4 | Medium | Medium | Contract fixtures; shadow comparisons of rows |
| UI rewrite confuses existing users | 6 | Medium | Medium | Opt-in, then percentage rollout; "What's new" tour; old-URL mapping |
| Paste-deploy of a Worker ahead of its schema | Every release | Medium | Medium | The startup schema check returns 503 with a clear admin message instead of silent degradation |

## 5. Complexity summary

| Phase | Complexity | Main dependency |
|---|---|---|
| 1 | Low–Medium | — |
| 2 | High | 1 |
| 3a | High | 2 |
| 3b | High | 3a (account ids) |
| 3c | Very high | 3a, 3b (`media` table) |
| 4 | Medium | 2 (can start in parallel with 3a) |
| 5 | High | 3c, 4 |
| 6 | High | 3a, 3b (API) |
| 7 | Medium | 3a, 6 |
| 8 | Medium | 3–5 |
| 9 | Continuous | — |
| 10 | Medium | All |
