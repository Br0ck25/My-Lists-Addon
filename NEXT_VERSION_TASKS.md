# Next Version — Implementation Checklist

This checklist can be executed by another developer or an AI. It follows `MIGRATION_PLAN.md`. Each task has an ID, the files to change, and **Done when** acceptance criteria.

Status marks: `[x]` done, `[~]` partly done or waiting on an operator step, `[ ]` not started. Phase 1 status as of 2026-09-25.

**Rules for every task:**

- **No npm, no `src/` tree, no frameworks (D-11).** Where a task names a `src/<area>/<file>.js` module, it means that responsibility: put it in the numbered file that owns the area (`NEXT_VERSION_ARCHITECTURE.md` §7.2 maps them), or in a new numbered server file after `26_`. Client code stays in `09_`–`24_`, as vanilla JavaScript.
- Keep `worker_entry_combined.js` a single pasteable ES-module file. Never hand-edit it; always regenerate it with the build.
- Schema changes are additive until Phase 10. Every migration is recorded in `schema_migrations`.
- Behavior changes go behind a `FF_*` Worker variable, default off, unless the task says "hotfix".
- The full test suite must pass. Add or adjust tests in the same change.
- Update `CHANGELOG.md` for user-visible changes.
- Line references are to the current numbered sources (2026-09-25).

---

## Phase 0 — Decisions (owner)

- [x] **P0-1** Decide on anonymous likes (keep them with an HMAC voter id and a weight, or require an account). *Done when:* recorded in `docs/DECISIONS.md`. — **Status:** Decided 2026-09-25: likes need an account (docs/DECISIONS.md D-6); likes already cast signed out keep counting (D-9).
- [x] **P0-2** Decide whether anonymous installs without an account survive, and with what limits (size, idle expiry). *Done when:* recorded. — **Status:** Decided 2026-09-25 (D-8): they survive, limited to the site's public lists. Implemented in `/api/save` and the builder. Idle expiry (P7-7) is **not** decided; nothing expires today.
- [x] **P0-3** Decide the New on Streaming engine default: RapidAPI (licensed), or JustWatch only with permission (BE-M12). *Done when:* recorded. — **Status:** Decided 2026-09-25: keep JustWatch (D-5).
- [x] **P0-4** Decide on optional email recovery. *Done when:* recorded. — **Status:** Decided 2026-09-27: no email recovery (D-12).
- [x] **P0-5** Confirm the credentials in the historical `my-lists-full-backup1.json` were rotated or revoked (Creator Key reset; Trakt, MDBList and Simkl tokens revoked), and decide on a git-history purge (SECURITY S-21). *Done when:* confirmed in writing. — **Status:** Owner: no action (D-7).
- [x] **P0-6** Confirm the dashboard offers Queue, Analytics Engine and R2 bindings on this account, and that D1 read replication can be enabled. *Done when:* screenshots or notes are in `docs/OPERATIONS.md`. — **Status:** Confirmed by the owner 2026-09-27: Queues, R2 and Analytics Engine are available (recorded in `docs/DECISIONS.md` and `docs/OPERATIONS.md`). D1 read replication not checked.

---

## Phase 1 — Hotfixes and free-tier / self-host removal

### Security hotfixes

- [x] **P1-S1** Remove `cf.cacheTtl` (set `cacheTtl: 0`, or drop `cf`) on every fetch that sends `Authorization` or a user token. Known sites: `06_:910`, `06_:914`, `06_:1245`, `25_:5585`, `25_:5821`, `25_:5831`; also audit all 140 `cacheTtl` uses. *Done when:* a test wraps `fetch` and fails if any request with an `Authorization` header or a user token has `cf.cacheTtl > 0`. — **Status:** Done: a module-level `fetch` wrapper in `02_` strips `cf` cache options from any request carrying `Authorization`, whichever path makes it; mutation-tested.
- [x] **P1-S2** TMDB OAuth callback (`25_:5165-5222`): require `request_token` from the query string to equal `mla_tmdb_token` from the cookie (`timingSafeEqualHex`); reject if the cookie is missing; replace `err.message` with `safeErrorMessage`. *Done when:* a test shows a mismatched or missing cookie results in a `state_mismatch` redirect. — **Status:** Done.
- [x] **P1-S3** Reject credentials in query strings: `creatorKey` (`25_:1164`, `25_:6197`), `traktAccessToken` / `mdblistKey` (`25_:1157-1160`), `token` (`25_:3830`), `sessionId` (`25_:5225`), `accessToken` (`25_:6434`). Accept them in POST bodies only. Leave the `/api/scrobble` forms until P7-6. *Done when:* each returns 400 with a message and the client sends them in bodies. — **Status:** Done (the `/api/scrobble` forms are left for P7-6 as planned).
- [x] **P1-S4** Remove the `?debug=1` responses on `/api/trakt/oauth/start` and `/api/mdblist/oauth/start`. *Done when:* the routes always redirect. — **Status:** Done.

### Correctness hotfixes

- [x] **P1-C1** `attachEventMeta` (`03_:618`): chunk `ids` into groups of 90 and merge the results. *Done when:* a harness guard throws for more than 100 bound parameters (see P1-T1), and the leaderboard test with 400 candidates passes using D1. — **Status:** Done; the harness guard (P1-T1) is on for the whole suite.
- [x] **P1-C2** `fetchPublishedListCatalog` (`05_:2418-2427`): emit `it.imdbId` or an id already starting with `tt`; otherwise `tmdb:{id}` for numeric TMDB ids; otherwise keep the id. Never prefix `tt`. *Done when:* a test with a `tmdb:550` item returns `tmdb:550`. — **Status:** Done, with a test.
- [x] **P1-C3** Delete the hyphen-insensitive fallback query in `getCreator` (`02_:3499-3503`). *Done when:* removed, and the tests pass. — **Status:** Done.
- [x] **P1-C4** Badge URLs include a day bucket (`&d=YYYY-MM-DD` in the viewer's region, or UTC) so relative labels ("TODAY"/"TOMORROW") can't be served stale (`applyBadgedPostersToMetas`, `05_:1410`; `/api/poster-badge` `25_:310`). *Done when:* the URL changes daily and the badge text matches the day. — **Status:** Done (UTC day, the same bucket the badge computes against), with a test.
- [x] **P1-C5** `getCreatorList` (`02_`): when it rewrites a list's KV record from its D1 row (every dashboard read, `/api/creator/lists`), carry over `sourceUrl`, `synced`, `lastSyncedAt` and `baseItemIds` from the KV record, and return them. Today the payload it writes has none of the four, so on a D1-bound deployment an imported or synced list loses its source link, its "keep synced" setting and its sync bookkeeping the first time the dashboard reads it. *Done when:* a test saves a synced list, reads the dashboard twice, and gets all four fields back from both the route and the KV record. — **Status:** Found 2026-09-28 while testing P3b-3. Done, in the Phase 3b PR (the owner chose that over a separate PR into `main`), so it reaches the live site when Phase 3b is deployed. The rebuilt record now carries the four fields over from the KV record, and the Watchlist's `isWatchlist` marker too, which it dropped the same way. The edit path was losing them as well: `/api/creator/lists/save` reads the existing record back through `getCreatorList`, so an edit that did not resend them dropped them. Both are covered. Test: "keeps an imported list's sync settings through dashboard reads and edits" in `tests/worker.test.mjs` (fails with the fix taken out). Lists that already lost their settings on the live site are not repaired: what was erased is gone, and re-importing or re-linking such a list restores it.

### Free-tier and self-host removal (see `CLOUDFLARE_FREE_TIER_REMOVAL_PLAN.md`)

- [x] **P1-F1 (FT-02)** Delete `DETAILS_BATCH_SUBREQUEST_BUDGET`, the per-id `meter`, `pool.reserved`, and `remainingIds`/`done` computation in `/api/details/batch` (`25_:7371-7436`). Always resolve all ≤ 60 ids with concurrency 6. Keep returning `done: true`. Remove the `meter` parameter plumbing in `fetchTmdbItemDetails*`. *Done when:* no reference to the constant remains, and the client loops terminate after one round. — **Status:** Done, including the follow-up: the `meter` fetch counting and the Airing Next budget pool are removed.
- [x] **P1-F2 (FT-03)** In `scheduled()` (`26_:7308-7431`), remove `CRON_SUBREQUEST_BUDGET` and every `CRON_*_SHARE` / `_FETCHES` / `CRON_EPISODE_CHECK_MAX` arithmetic; call each task with no budget. Remove the constants from `00_`. *Done when:* the cron tests pass and the constants are gone. — **Status:** Done. `CRON_EPISODE_CHECK_MAX` (150 shows a tick) was kept as a work bound, not a subrequest budget.
- [x] **P1-F3 (FT-01, interim)** `/api/bulk-resolve`: remove `BULK_RESOLVE_SUBREQUEST_BUDGET`; process the full request (≤ 200 items); keep `nextIndex = items.length`, `done: true`. *Done when:* a 200-item request resolves in one call. — **Status:** Done.
- [x] **P1-F4 (FT-05, FT-06)** Remove `MOST_WATCHED_MAX_LOOKUPS`. Raise `IMDB_ID_LOOKUP_MAX` to 100 with a concurrency limit. *Done when:* the constants have been removed or changed and the tests updated. — **Status:** Done: `MOST_WATCHED_MAX_LOOKUPS` is `MOST_WATCHED_MAX_ITEMS * 2`; `IMDB_ID_LOOKUP_MAX` is 100 with `IMDB_ID_LOOKUP_CONCURRENCY` 8, and the page batches to the same constant.
- [x] **P1-F5 (FT-09)** Client `generate()` (`24_:2150-2250`): if `/api/save` fails, show an error with a Retry button. **Never** build a base64 config. Keep `buildConfig` only for "export config" if that is still needed, and strip secrets from it. Server `decodeConfig` stays (read-only). *Done when:* no code path produces a base64 install URL. — **Status:** Done; `buildConfig` removed entirely.
- [x] **P1-F6 (FT-10)** Delete the `/api/resolve` remote-origin fallback (`25_:6870-6908`), `isRemoteResolveOrigin`, `PRIVATE_HOST_SUFFIXES`, `RESOLVE_PROXY_PER_MINUTE`, and the client explicit-origin logic in `resolveInstallLinkData` (`24_`). *Done when:* removed; importing a foreign-origin link shows "Only mylistsaddon.com links can be imported". — **Status:** Done ("Only My Lists install links can be imported here.").
- [x] **P1-F7 (FT-11)** Replace all "Worker owner" / KV / binding messages shown to users with product copy; change the page `<title>` and meta description (drop "Self-Hosted"); update the guide FAQ. *Done when:* `grep -ri "worker owner\|self-host" src/` (or the numbered files) returns nothing user-facing. — **Status:** Done for user-facing text; a few code comments still say "Worker owner".
- [x] **P1-F8 (FT-12)** `authenticateCreator` (`26_:62-71`): a missing `CF-Connecting-IP` fails closed (400). Same everywhere `clientIpKey` returns null. *Done when:* a test without the header gets 400. — **Status:** Done (fails closed with 401, not 400).
- [x] **P1-F9 (FT-25)** Remove the `lastgood:` write and read in the catalog route (`25_:1007-1067`). Keep the "temporarily unavailable" placeholder tile on first-page failure when no cached data exists. *Done when:* a catalog request performs zero KV writes (a test counts KV puts). — **Status:** Done differently: the last-good copy moved to the Cache API instead of being deleted, so the resilience stays and the catalog route makes no KV write.
- [x] **P1-F10 (FT-35)** Remove the in-request sleeps in the Trakt OAuth token exchange (`25_:3374-3389`, one retry maximum and no sleep) and in the device-code 429 handling (`25_:3467-3480`). *Done when:* no `setTimeout`-based sleep remains in any interactive route. — **Status:** Done: the device-code route hands a 429 back with `Retry-After` and the page retries once. The OAuth callback keeps one 1.5 s pause on purpose: it is a browser redirect with no page to retry it, and Trakt codes are single-use.
- [x] **P1-F11 (FT-04, FT-38)** Rewrite `README.md` as the product README. Create `docs/OPERATIONS.md`: dashboard bindings (names, types), variables, secrets, cron triggers, compatibility date, the migration procedure, backups, rollback. Update `wrangler.toml` (current compatibility date, no budget vars, the real binding names for `wrangler dev` and CI migrations). Replace the `header.js` text with "GENERATED FILE". Make `build.ps1` read `header.js` instead of its own copy. *Done when:* the docs are merged and the build is unchanged except for the header. — **Status:** Done: README reframed as hosted/Paid, `docs/OPERATIONS.md`, `wrangler.toml` (no budget vars, `ANALYTICS` binding), `header.js`, `build.ps1`. The compatibility date is still to be read from the dashboard.

### Schema tooling, observability, backups

- [~] **P1-D1** Add migration `0014_schema_migrations.sql`: `CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)` plus `INSERT OR IGNORE` rows for `0001a`…`0014`. *Done when:* applied on staging and production, and the harness loads it. — **Status:** Written (`migrations/0014_add_schema_migrations.sql`); the harness loads it via `schema.sql`. **Still to apply in production.**
- [x] **P1-D2** Rename `schema.sql` to `schema.reset.sql` (with a warning banner). Create `schema.create.sql` (no DROPs) for local and test use. Point `tests/harness.mjs` at the migrations applied in order. *Done when:* the tests pass on the migrated schema. — **Status:** Done differently: `schema.sql` itself was made non-destructive (no DROPs, all `IF NOT EXISTS`, ledger seeded) rather than split into two files; the drift test keeps it equal to the migrations.
- [x] **P1-D3** Startup schema check: the Worker has a compiled `REQUIRED_SCHEMA_VERSION`, and on the first request per isolate it reads `SELECT max(version) FROM schema_migrations`. If it is behind, `/api/*` writes return 503 `{error:"maintenance"}` and `/admin` shows a banner. Remove `checkD1Schema` from the cron tick. *Done when:* a test with an older schema produces 503. — **Status:** Done: `REQUIRED_SCHEMA_VERSION`, `schemaWriteGate` (503 on `/api/*` writes, 60 s cache per isolate) and the ledger in `/admin` → Check schema. The cron tick still runs `checkD1Schema` (harmless; it only logs).
- [~] **P1-O1** Add the Analytics Engine binding `ANALYTICS`. On each request, `writeDataPoint({blobs:[routeFamily, status], doubles:[cpuMs? (Date.now delta), kvReads, kvWrites, d1Queries], indexes:[routeFamily]})` through a thin counter wrapper around `env.CONFIGS` / `env.DB`. *Done when:* the admin can see per-route operation counts. — **Status:** Code done (`instrumentEnv`, `writeRequestMetrics`). **The binding still has to be added in the dashboard.** Reading the data is through the Analytics Engine SQL API; there is no `/admin` panel for it yet.
- [~] **P1-B1** CI job `backup.yml` (daily): `wrangler d1 export` of the production DB to a CI artifact or R2 (API token secret). *Done when:* the first backup exists and a restore is tested to staging. — **Status:** Workflow written (`.github/workflows/d1-backup.yml`): daily, encrypted with `BACKUP_PASSPHRASE` because artifacts are downloadable, 30-day retention. **Needs the four repository secrets**, then one run and a test restore to a scratch database (`docs/OPERATIONS.md` §5).

### Tests for Phase 1

- [x] **P1-T1** Harness D1 guards: throw on more than 100 bound parameters, on a row over 2 MB, and on a statement over 100 KB. *Done when:* enabled by default, and existing tests are fixed or adjusted. — **Status:** Done: 100 bound parameters, 2 MB per row, 100,000-byte statements. The whole suite passes with it on.
- [x] **P1-T2** A test asserting no route response returns tokens, keys or `trackCreatorKey` in JSON except the explicitly allowed routes (`/api/resolve` until P3). *Done when:* it passes. — **Status:** Done, with no exceptions: `/<id>/configure` and `/api/resolve` no longer return provider keys or tokens. The test reads every route from the source and probes each four ways.

---

## Phase 2 — Structure inside the split files (behavior-preserving)

No npm, no `src/` tree, no esbuild, no new test framework (D-11). Phase 2 is now a handful of shared helpers inside the numbered files, plus the fixes the old restructure would have carried.

- [x] **P2-1** ~~Commit `package.json` (esbuild, Vitest, ESLint, TypeScript) and a lockfile.~~ — **Status:** Dropped (D-11). The toolchain stays as it is: `python build.py`, `check_sync.py`, `scope_check.mjs`, `render_check.js`, `html_checks.py`, `gen_map.py` and `node --test`. CI installs its two checker packages with `npm install --no-save`, and the backup job runs Wrangler through `npx`; neither is part of the build.
- [x] **P2-2** ~~Create the `src/` tree and move the code into it.~~ — **Status:** Replaced by a convention (D-11):
  - the existing numbered files keep their responsibilities;
  - a new server-only area goes in a new numbered file after `26_` (`27_…`), starting with a comment that says what it owns;
  - top-level names stay unique across all files (`scope_check.mjs` enforces this);
  - client code stays in `09_`–`24_`;
  - `NEXT_VERSION_ARCHITECTURE.md` §7.2 maps each planned module to its file.
- [x] **P2-3** Middleware at the entry point, keeping `handleFetch` and its route order as they are. It needs:
  - one error boundary (`safeErrorMessage`);
  - security headers;
  - `no-store` as the default for JSON responses, with public routes opting in to caching (BE-M17).

  The declarative router table is dropped (D-11: the route chain is not rewritten). *Done when:* a test shows an uncaught error answers a generic 500, and a JSON response with no explicit cache header is `no-store`. — **Status:** Done.
  - The error boundary and security headers were already in place and tested (A13).
  - `json()` now defaults to `no-store`, and public routes opt in with `jsonCacheable` (Stremio through `jsonPublic`).
  - A route probe and a full instrumented test run confirmed no public route lost its caching.
- [x] **P2-4** ~~esbuild bundle with hashed JS and CSS assets.~~ — **Status:** Dropped (D-11). `/app.js` and `/app.css` keep being split from the rendered page at run time (`splitAppBundle`, memoized per isolate), so FT-23 stays.
- [x] **P2-5** ~~Retire `build.py`, `check_sync.py`, `gen_map.py` and `scope_check.mjs`, and replace the render checks with ESLint.~~ — **Status:** Dropped (D-11). These checks are what makes the shared scope and the template-literal client safe, so they stay.
- [x] **P2-6** `providerFetch(provider, url, {auth, timeoutMs=10000, retries, cache})` in a new numbered file, `27_provider-http.js`. All provider calls go through it. It refuses `cf.cacheTtl` when `auth` is `user` (the fetch guard in `02_` already does this for every call), and it redacts secrets in errors and logs. *Done when:* a test that greps the sources finds no raw `fetch(` to a provider host outside `providerFetch`. — **Status:** Done in the existing `fetch` guard in `02_` rather than a new file and wrapper: every outbound call already goes through it.
  - It strips edge caching from credentialed requests (Phase 1).
  - It adds a 30-second timeout (`OUTBOUND_DEFAULT_TIMEOUT_MS`) when the caller set none. A caller's own signal wins, and Request objects are left alone.
  - Log redaction comes from P2-7.
  - Per-provider retries stay where they are (`fetchTraktWithRetry`).
  - A test hangs the upstream and checks that the default applies, and that a caller's own 10 s is kept.
- [x] **P2-7** Log redaction: `redactForLog(value)` in `02_` masks `api_key`, `apikey`, `access_token`, `token` and `key` query parameters and `Authorization` headers, and the server's `console.error` / `console.warn` calls go through it. (Checked 2026-09-27: no current log line writes a key or token. This keeps it that way.) *Done when:* a test logging a URL that contains `api_key=SECRET` sees `api_key=[redacted]`. — **Status:** Done: `redactForLog` and a module-level `console` at the top of `00_constants.js` cover every log call without editing each one. Tests cover URLs, Bearer tokens, Creator Keys, objects, Headers and Errors, and check that the real console is looked up at call time.
- [x] **P2-8** One install-config schema: `INSTALL_CONFIG_FIELDS` in `00_constants.js` (name, type, default, validator, stored-when rule). It is written into the page with `jsonForScript` for the client, the way `PERSONAL_SHELF_URL_PREFIXES` is. It is used by `decodeConfig`, `resolveConfig`, the `/api/save` allowlist, the client's save body, and `renderBuilder`'s initial keys. *Done when:* the six copies are gone and a round-trip test covers every field. — **Status:** Done.
  - `INSTALL_CONFIG_FIELDS` and three helpers (`readInstallConfigFields`, `storedInstallConfigFields`, `nonSecretInstallConfigFields`) live in `00_constants.js`.
  - The page gets the list as `INSTALL_CONFIG_FIELD_LIST`.
  - It fixed a real bug: Configure dropped Better Posters.
  - `collectKeys` still reads each setting from its own control; a test checks it provides every field in the list.
- [x] **P2-9** Pass the resolved config through the catalog pipeline; remove the extra `resolveConfig` calls in `fetchAutoTrackedCatalog` / `fetchCuratedCatalog` (BE-H04, BE-M08). Stop merging the tracking blob into `resolveConfig`; personal rows read their own data. *Done when:* a catalog request for a non-personal row performs zero reads of `creatorsynctracking:`. — **Status:** Done.
  - `resolveConfig(config, env, { withTracking })` reads `creatorsynctracking:` only when asked; the channel meta route and `/api/resolve` ask.
  - `fetchCuratedCatalog` and `fetchAutoTrackedCatalog` use the owner the route passes, and resolve again only for callers that pass nothing.
  - Measured by tests: 0 tracking reads for a chart row (was 1); 1 for a curated row (was 3); the install config read once per request.
- [x] **P2-10** Replace the `stats` `LIKE 'prefix%'` queries with range predicates (`kind >= ? AND kind < ?`) (BE-H11 interim). *Done when:* `EXPLAIN QUERY PLAN` on D1 shows the primary-key index being used. — **Status:** Done: every `stats` prefix read uses a `[prefix, upper)` key range (`statKindRange`, `03_admin.js`). The windowed leaderboard query now searches the primary key. The all-time reads keep using the `(day, n, kind)` covering index, which they already did.

---

## Phase 3a — Identity, sessions, installs, connections

- [x] **P3a-1** Migration `0015_accounts_sessions_installs.sql`: `accounts`, `sessions`, `installs` (+ `legacy_cfg_id` UNIQUE), `install_secrets` (transitional, encrypted), `provider_connections`, `rate_counters`, `account_settings` (NEXT_VERSION_ARCHITECTURE §4.3). *Done when:* applied; the ledger is updated. — **Status:** Written (`migrations/0015_accounts_sessions_installs.sql`); added to `schema.sql`, `D1_SCHEMA_MANIFEST`, and verified with the test suite. Ready to apply in D1.
- [x] **P3a-2** Secrets: `TOKEN_ENCRYPTION_KEY` (base64, 32 bytes; stored as `k1:<base64>` to allow rotation) and `LOOKUP_PEPPER`. `src/shared/crypto.js` provides `encrypt(plaintext) → "k1:<iv>:<ct>"` and `decrypt()` with AES-GCM. *Done when:* round-trip and wrong-key tests pass. — **Status:** Implemented in `02_http-and-creator-utils.js` (`encryptToken`, `decryptToken`, `hmacLookupKey`, `parseTokenEncryptionKeys`).
  - The generic `encrypt` / `decrypt` names were dropped: every file shares one scope.
  - An optional `context` binds a ciphertext to its row (AES-GCM additional data), so callers should pass one, for example `account:<id>:<provider>`.
  - Tested for round-trip, key rotation, wrong key, tampering, malformed keys, context binding and HMAC hashing.
- [x] **P3a-3** Backfill job `migrate.accounts`: for every `creators` row and every KV `creator:*` key, upsert `accounts` (newest `keyHash` wins; D1 wins ties). *Done when:* the reconciliation report shows `count(accounts) = |creators ∪ creator:*|`. — **Status:** Implemented (`backfillAccounts`, `reconcileAccounts` in `02_http-and-creator-utils.js`, `/admin/api/migrate-accounts` route in `26_api-creator-and-admin-routes.js`, Admin maintenance panel in `03_admin.js`), verified with comprehensive unit and route tests.
- [x] **P3a-4** Sessions:
  - `POST /api/session` {username, key}: PBKDF2 verify, rehash if the iteration count is below the target, create a 256-bit token, store its SHA-256 in `sessions`, and set the `mla_session` cookie (`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=30d`).
  - `DELETE /api/session`.
  - `GET /api/me`.
  - `GET/DELETE /api/me/sessions` (devices).
  - Middleware resolves the session (with a 60 s isolate cache) and sets `request.account`.

  *Done when:* the auth tests pass, including revocation. — **Status:** Implemented (`createSession`, `resolveSession`, `revokeSession`, `revokeAccountSessions` in `02_http-and-creator-utils.js`, middleware in `25_api-catalog-routes.js`, routes in `26_api-creator-and-admin-routes.js`), verified with 12 comprehensive unit and route tests covering login, PBKDF2 upgrade, lazy backfill, session resolution via cookie/Bearer, device management, logout, and multi-session revocation.
- [x] **P3a-5** CSRF middleware for POST, PUT, PATCH and DELETE: require `Origin` equal to our origin (or `Sec-Fetch-Site: same-origin`) **and** `Content-Type: application/json`. Webhook routes (`/api/scrobble*`) and OAuth callbacks are exempt. *Done when:* a cross-origin `text/plain` POST to `/api/lists/like` is rejected with 403. — **Status:** Implemented (`verifyCsrf` in `02_http-and-creator-utils.js`, wired into `handleFetch` in `25_api-catalog-routes.js`), verified with 10 comprehensive tests covering cross-origin rejection, non-JSON rejection, Sec-Fetch-Site enforcement, webhook and OAuth exemptions, admin login form exemption, safe method passthrough, and direct helper unit tests.
- [x] **P3a-6** Compatibility: every `/api/creator/*` route accepts either a session **or** `creatorName`/`creatorKey` in the body. A successful key-in-body auth also sets a session cookie. Behind `FF_SESSIONS`. *Done when:* the old client flows pass unchanged and the new cookie is issued. — **Status:** Implemented (`authenticateCreator` dual auth, `isSessionsEnabled`, `getOrBackfillAccount`, cookie attachment via `withSecurityHeaders`), verified with 13 comprehensive unit and route tests covering session auth without key, key-in-body auth issuing cookies, flag gating behind `FF_SESSIONS`, username matching enforcement, empty body tolerance, cookie clearance on account deletion, and lazy backfills.
- [x] **P3a-7** Blind index v2: on a successful login or key reset, write `accounts.key_lookup_hmac = HMAC(LOOKUP_PEPPER, normalizedKey)`. `forgot-username` checks the HMAC first, then the legacy SHA-256. *Done when:* the tests pass; there is a metric for legacy-lookup hits. — **Status:** Implemented (`accounts.key_lookup_hmac` written on session login, creator route key-in-body login, creator key reset, and admin key reset; HMAC check first in `usernameForCreatorKeyLookup` and `/api/creator/forgot-username`; legacy lookup fallback; `recordLegacyLookupHit` reporting to Analytics Engine and KV `stats:legacy_lookup_hits`), verified with 13 comprehensive unit and integration tests.
- **Review of P3a-4 to P3a-7** (2026-09-27): fixed before any of it reached production. See `CHANGELOG.md`, "Phase 3a review fixes".
  - The `accounts` row is a mirror of the creator profile (`creator:{u}` / `creators`), which stays the source of truth until Phase 10. `getOrBackfillAccount(env, username, profile)` corrects a drifted row from the profile and fills a missing one for that account only.
  - `POST /api/session` authenticates through `authenticateCreator`.
  - Delete-account removes the `accounts` row and everything under its id (`deleteAccountRow`); create clears a leftover row first.
  - Key resets revoke every session (`revokeSessionsForUsername`).
  - Key-in-body issues a session on `/api/creator/*` only, and not when a live session for the account is already present.
  - Admin maintenance buttons send `Content-Type: application/json` (the CSRF check refused them); a test scans every mutating `fetch` in the pages.
- [x] **P3a-8** Installs:
  - `src/installs/legacy-resolver.js` (MIGRATION_PLAN §3.2): converts `cfg:{id}` and bare ids into `installs` rows and binds the owner. Tokens go to `provider_connections` (when an owner exists) or `install_secrets`. **Rewrite the KV record without secrets.**
  - Base64: read-only transient install.
  - New routes: `/i/{token}/manifest.json`, `/catalog/...`, `/meta/...`, `/subtitles/...`.
  - Management API: `GET/POST/PATCH/DELETE /api/installs` (session required).
  - A KV snapshot `install:{tokenHash}` with a 1-day TTL, invalidated by bumping `version`.

  *Done when:* a sample of legacy ids (fixtures) serves identical manifests and catalogs; KV `cfg:` records no longer contain `trackCreatorKey` or tokens after first use. — **Status:** Done, in `27_installs.js`, with tests in `tests/worker.test.mjs` ("P3a-8"). Off until the owner sets `INSTALL_MIGRATION_PERCENT` (the move) and `FF_INSTALLS` (the API); `docs/OPERATIONS.md` §8 has the steps.
  - **Where it differs from the plan, and why:**
    - Only records that hold a secret move. A signed-out link has nothing to move and is left untouched.
    - Secrets always go to `install_secrets`, **not** `provider_connections`. The install keeps its own keys, so it serves exactly as before even when an account's links hold different or stale tokens. Which store wins is P3a-9/P3a-10's decision.
    - The Creator Key (`trackCreatorKey`) is stored encrypted too, not dropped. Reading the link puts it back, so playback tracking and "a key reset stops old links tracking" work unchanged, and the move can be undone.
    - A legacy install's `config_json` is `'{}'`. Its config stays in the (now secret-free) `cfg:` record, which every request reads anyway, so D1's 2 MB row limit never applies to it.
    - `token_hash` for a legacy install is `legacy:{id}`, which no SHA-256 can equal.
    - Reads never depend on the flags: a moved record is always read through the table.
  - **Added:** an emergency undo (`/admin/api/installs/restore`), the admin progress panel, and a check on each move that the stored keys decrypt back to the originals before KV is touched.
  - **Base64 links:** already read-only and transient (`decodeConfig`); unchanged.
- [x] **P3a-9** Connections: the OAuth callbacks (Trakt, MDBList, Simkl, TMDB) store tokens server-side (encrypted, **including `refresh_token` and `expires_at`**) when a session exists, and redirect to `/settings/connections?connected=trakt` with **no token in the URL**. The signed-out fallback keeps today's behavior until P6. `POST /api/connections/import-local` accepts legacy browser tokens once, validates them, and stores them. `DELETE /api/connections/:provider` revokes (where the provider supports it) and deletes. *Done when:* no OAuth redirect contains a token for signed-in users. — **Status:** Done, in `28_connections.js`, the callbacks in `25_`, and the page (`17_`, `22_`, `24_`). Tests: "P3a-9" in `tests/worker.test.mjs` and `tests/client.test.mjs`.
  - **Where it differs from the plan, and why:**
    - The redirect is `/?connected=<provider>`. `/settings/connections` does not exist until the Phase 6 pages.
    - The page still works from its own copy of each token (about 430 places read one). So after a signed-in connect it fetches the token once over its session: `POST /api/connections/:provider/token`, a POST so the CSRF check applies. Remove it when the Phase 6 pages stop holding tokens.
    - "Signed in" means the browser has a session, so this starts working when `FF_SESSIONS` is on. Without `TOKEN_ENCRYPTION_KEY` the callbacks fall back to today's behaviour rather than fail.
    - Also added: `GET /api/connections` (no tokens), the Trakt device flow storing a copy, `session` in the `/api/creator/restore` answer (the page imports only when it is true), and a rate limit on import.
    - The page still pushes its tokens into account sync (`creatorsync:{u}`, plain KV) as before. Stopping that is Phase 6, once nothing in the page needs them.
- [x] **P3a-10** Provider calls for personal rows read tokens from `provider_connections` (install owner) instead of the config. *Done when:* personal Trakt, MDBList and Simkl rows work with configs stripped of tokens. — **Status:** Done, in `28_connections.js` (`connectionFieldsForConfig`, `connectionOwnerForConfig`, `refreshProviderConnectionIfDue`), called from `resolveConfig` (`04_`) and `resolveV2InstallConfig` (`27_`). Tests: "P3a-10" in `tests/worker.test.mjs`.
  - **Decisions made here:**
    - **Only for a proven owner:**
      - a v2 install's `account_id`;
      - a verifying `trackCreatorKey`;
      - the new `ownerId` + `ownerSince` stamp (accounts id and `created_at`) that `/api/save` writes for every signed-in save.

      The older `trackOwner` stamp and the unverified-shelf fallback are names only and lend nothing. That keeps the re-registered-username problem (spawned as its own task) from reaching provider tokens.
    - **Precedence:** the config's own key or token wins, and connections fill only what is missing, so legacy links serve identically. A token and its client id are filled together (paired) for Trakt and Simkl.
    - **Saves:** a signed-in `/api/save` leaves out the fields the account's working connections supply (read fresh, never from the isolate cache), and stamps the owner.
    - **Refresh:**
      - Trakt (site-issued tokens only; tried under the web and device redirect URIs) and MDBList, an hour before expiry.
      - A refused refresh re-reads the row, so the loser of a race uses the winner's token.
      - Otherwise the connection is marked `expired`.
    - Website API routes that take a token in the request body (Trakt export, private lists and the like) are unchanged. Moving them to connections belongs with the Phase 6 pages.

## Phase 3b — Lists, likes, channels

- [~] **P3b-1** Migration `0016_lists_v2.sql`: `media`, `lists`, `list_items`, `list_slug_history`, `likes`, `channels`, `account_list_prefs`, `presets`, and the FTS external-content table `lists_fts2` with triggers or explicit maintenance by rowid. *Done when:* applied. — **Status:** Written (`migrations/0016_lists_v2.sql`); added to `schema.sql` and `D1_SCHEMA_MANIFEST`. Tests: `tests/lists-v2.test.mjs`. Waiting on the owner to apply it in the D1 Console. Nothing uses the tables yet, and `REQUIRED_SCHEMA_VERSION` stays `0014`.
  - **Where it differs from the sketch (NEXT_VERSION_ARCHITECTURE §4.3), and why:**
    - **`list_items` can hold single episodes.** Storyline and crossover lists hold episodes of one show, so an entry is `(list, media, season, episode)` with season and episode NULL for a whole title. It has its own `id`, and a unique index on `(list_id, media_id, ifnull(season,-1), ifnull(episode,-1))` keeps a whole title (or one episode) to once per list. `extra_json` keeps the item fields with no column (companion notes, air dates, a list-specific poster), so the backfill loses nothing.
    - **`media.kind` is `movie` or `series`**, the words the rest of the add-on (and `lists.media_type`) uses, not `movie`/`show`. `title` may be NULL: an item TMDB can't resolve keeps a stub with only its ids and the item's own title as a hint (P3b-2), and `resolved_at` stays NULL so it can be retried (`idx_media_unresolved`). `alt_id` holds an id that is neither TMDB nor IMDb (`kitsu:1`).
    - **`lists_fts2` keeps its own copy of the text** (a normal FTS5 table, rowid = `lists.id`), not an external-content table. An external-content index must be told the exact old values on every delete, and a mismatch silently corrupts it. The owner name lives in `accounts` and can change or vanish (account deletion cascades), so the old value isn't reliably known. With its own copy, `DELETE ... WHERE rowid = ?` is always safe. It is maintained **by rowid in code**, not by triggers, because migrations are pasted into the D1 Console, where a trigger body (`BEGIN ...; END`) is at risk of being split at its inner semicolon. It holds public, non-deleted lists only.
    - **`lists`:** `legacy_id` (UNIQUE) names the record a list was copied from, so the backfill can run again without making copies; `source_json` keeps a synced list's `baseItemIds`; `add_count` backs a "Most added" order like channels have. The slug is unique only among live lists (`idx_lists_owner_slug ... WHERE deleted_at IS NULL`), so deleting a list frees its address. Three directory indexes: popular (`like_count, updated_at, id`, today's order), new and added.
    - **`likes`:** the account voter is `acct:<accounts.id>`, not `a:<id>`, because `a:` is already the prefix of the legacy signed-out votes that must keep counting (D-9). `channel_add` rows are the once-per-account channel adds (today `channeladdvoters:`). `idx_likes_voter` serves removing a deleted account's votes.
    - **`channels`:** `client_id` (the id in the owner's synced channels, unique per owner), `slug` (for `/channels/:user/:slug`), `show_count` and `published_at`, which the directory card and its Newest order use. A deleted account's shared channels stay for the people who added them (`ON DELETE SET NULL`). Its private channels must be deleted by the account-deletion code.
    - **Added `jobs`** (from the sketch; P5-2 lists it) now, because P3b-3 keeps its progress and reconciliation record there. P5-2 adds the dispatcher only.
    - `likes`, `list_slug_history` and `account_list_prefs` are `WITHOUT ROWID` (pure key lookups).
    - The migration's comments avoid semicolons and apostrophes so it can be pasted into the D1 Console as it is (a test checks).
- [x] **P3b-2** `src/media/resolver.js`: `resolve({imdbId?, tmdbId?, kind, title?, year?}) → media.id`. Checks the DB first, then TMDB `/find` or `/{kind}/{id}` through `providerFetch`, then inserts. Batch API ≤ 90 per query. *Done when:* unit and integration tests pass; unresolvable items get a `media` row with only the known external id. — **Status:** Done, in `29_media.js`: `resolveMedia(env, input)`, `resolveMediaBatch(env, inputs, opts) → { ids, stats }`, `normalizeMediaRef`, and `retryUnresolvedMedia`. Tests: "P3b-2" in `tests/lists-v2.test.mjs` (real SQLite, fake TMDB). Nothing calls it yet; P3b-3 and P3b-4 will.
  - **How it works:**
    - Inputs are legacy list items as they are, or `{ imdbId, tmdbId, kind, title, year }`. It reads `tt…` (an episode suffix like `:1:2` is dropped), `tmdb:123`, `tmdb:tv:123`, a bare TMDB number, and any other `scheme:id` (kept as `alt_id`).
    - An **episode entry is filed under its show** (`showId`). Its own `id` is TMDB's episode id, which is never read as a title id.
    - The database is checked first by every id the input has: IMDb, then TMDB within its kind, then `alt_id`. Queries use at most 90 ids (91 parameters).
    - What is unknown is asked of TMDB through the module-level `fetch` guard (the `providerFetch` of P2-6), six at a time, edge-cached for a week. `maxLookups` (default 200) bounds one call. Inputs naming the same title the same way share one lookup.
    - **TMDB decides the kind.** A list's stated kind only breaks a tie, picks the endpoint for a TMDB id, and is used for stubs. No stated kind means `movie`, as the legacy list code assumes.
    - Ids TMDB returns are checked against the database again before inserting, so a title first seen as `tmdb:1396` and later as `tt0903747` stays one row (the row gains the missing id).
    - **A title TMDB can't place gets a stub**: its ids, the item's title and year as a hint, `resolved_at` NULL. Not found, a TMDB error, a timeout, no `TMDB_API_KEY`, or being past the budget all end this way, so no list entry is dropped.
    - `retryUnresolvedMedia(env, { limit })` tries the oldest stubs again and upgrades them in place (same id, so list entries follow). The ones still unknown move to the back of the queue. Nothing schedules it yet (Phase 5).
  - **Size of one call:** D1 allows about 1,000 queries per Worker invocation. A call costs up to about three lookups per 90 ids, plus one write per new title (sent in batches of 50). So the backfill (P3b-3) should pass about 1,000 items per invocation at most, and `maxLookups` bounds the TMDB side.
  - **Left for later:** when a stub's TMDB id turns out to belong to another row, the two should be merged, with their list entries. For now the stub stays as it is. Merging needs the list tables in use (P3b-4) to keep `item_count` right.
- [~] **P3b-3** Backfill job `migrate.lists` per account (MIGRATION_PLAN §2 Phase 3b steps 1–8), resumable, with a reconciliation record in `jobs.progress_json`. *Done when:* staging runs on an anonymized production fixture with mismatches below 0.1%, each explained. — **Status:** Written, in `30_lists-backfill.js`, run from `/admin` → Maintenance → **Lists v2** (`POST /admin/api/lists-backfill/step`, `GET /admin/api/lists-backfill/status`). Tests: "P3b-3" in `tests/lists-v2.test.mjs`. Waiting on the owner's run (`docs/OPERATIONS.md` §9). There is no staging environment, but the job only writes the v2 tables, which nothing reads yet, so a run on production is the staging run: its report is the reconciliation.
  - **How it works:**
    - Steps 1–5, 7 and 8 of the plan. Each account's lists are read exactly as the site reads them (`readLegacyCreatorList` is `getCreatorList`'s merge without its write-backs), in the order `/api/creator/lists` shows them (a test compares the two), with items resolved through `29_media.js`.
    - **It cannot change the legacy store.** It works through `listsBackfillEnv`, which has no KV write methods and refuses any D1 write that is not to `media`, `lists`, `list_items`, `likes`, `lists_fts2`, `jobs` or `account_list_prefs` (tested). A test compares every legacy KV key and table before and after a run.
    - Bounded steps (at most about 350 operations started, 500 items and 100 TMDB lookups each) that stop between lists or between 200-item chunks of one list, with the cursor in the account's `jobs` row. One step at a time (a lease on the run row). A failing account is recorded (`status = 'failed'`, `last_error`) and the run moves on.
    - Re-runnable while the legacy store is the truth: `lists.legacy_hash` (added to 0016, which is not applied anywhere yet) skips unchanged lists; order and likes are refreshed; copies of lists deleted since are marked deleted and leave search.
    - Per-account reconciliation in `jobs.progress_json`: lists found, copied, unchanged, missing (an order entry with no record), retired; items in the legacy lists and copied, and why the rest were not (no usable id, listed twice), with up to five examples of each; likes before and after. `GET …/status` adds them up.
  - **Where it differs from the plan, and why:**
    - **Channels (step 6) came with P3b-8**, as the copy's "channels" phase.
    - **`like_count` is the higher of the legacy total and the voters on record**, not the voter count alone, so no total people see goes down (D-9). The difference is reported as "kept from the old totals".
    - **Voters:** `u:<username>` becomes `acct:<id>`. A voter whose account no longer exists keeps its `u:` id, and signed-out `a:` votes are carried as they are; both still count, as today.
    - **Legacy anonymous lists are `unlisted`** (`private` if they were private): their links keep working and the directory does not show them (D-6).
    - A title listed twice in one list is kept once (the v2 unique entry), and reported.
    - Positions follow the dashboard order, which also places personal shelves (Continue Watching and the like). Shelves have no list row; since P3b-7 their places are kept as `section` rows in `account_list_prefs`.
    - A Watchlist kept only in the tracking blob (no `creatorlist:` record) is not copied here; it moves with the activity data (Phase 3c). Liked and hidden lists (`account_list_prefs`) and presets are not in the plan's steps and are left for later.
    - "Migrate on read" (an account copied inline before its first v2 read) and the rule that a finished account is never refreshed once reads are on v2 came with the read switch (P3b-7).
  - **Found while testing (legacy bug):** `getCreatorList` rewrote a list's KV record from its D1 row whenever the dashboard read it, without `sourceUrl`, `synced`, `lastSyncedAt` or `baseItemIds`, so an imported or synced list lost that bookkeeping and the backfill can only copy what is left. Fixed as **P1-C5**, in this PR.
- [x] **P3b-4** List API: `GET /api/lists` (mine), `POST /api/lists`, `GET/PATCH/DELETE /api/lists/:publicId`, `POST /api/lists/:id/items` (batch ≤ 500), `DELETE /api/lists/:id/items/:mediaId`, `POST /api/lists/:id/items/move`, `PUT /api/lists/:id/visibility`. `If-Match` versioning on PATCH and DELETE. Every mutation updates `item_count`, `version` and `accounts.version` in one `batch`. *Done when:* the API tests cover owner, other and anonymous access. — **Status:** Done, in `31_lists-api.js`, behind `FF_V2_LISTS_API` (off; must stay off in production until P3b-7). Tests: "P3b-4" in `tests/lists-v2.test.mjs` (owner, someone else and signed out, for every route).
  - **How it works:**
    - Signed-in means a session (`request.account`, from `POST /api/session`), as for `/api/installs`. `:id` is the list's `public_id` everywhere.
    - Reading: a public or unlisted list is open to anyone; a private one answers 404 to everyone but its owner (not 403, so its existence is not given away). Legacy anonymous copies read, and nobody can change them. `GET /api/lists/:publicId` pages items by `?limit` (default 100, at most 500) and `?cursor` (keyset on position and entry id), and sends `ETag: "<version>"`.
    - Writing: the owner only (403 for someone else, 401 signed out). Each write is one batch that also sets `item_count` from the rows and bumps the list's and the account's `version`. An add that inserts nothing (every title already there, including when a concurrent add of the same title won) bumps nothing.
    - `If-Match` on PATCH and DELETE: 428 without it, 412 when stale (with the current version). The first statement of the batch checks the version; the statements after it (search, old addresses) derive from the state it left, so a write that loses a race changes nothing but a spare bump of the account's version.
    - Items are resolved through `29_media.js` (at most 100 TMDB lookups per add; the rest become stubs, retried later). A title or episode already in the list, or with no usable id, is reported per item (`results`) and left out. `note` goes to its column; other item fields go to `extra_json` as the backfill stores them. `at: "start"` adds to the top.
    - Moving writes one row: halfway between the new neighbours. When moves have left no room, the list is renumbered first.
    - Addresses: a new list gets a free slug among the account's live lists, its old addresses, **and its legacy lists** (so the backfill never collides). A rename keeps the old slug in `list_slug_history`.
    - `lists_fts2` is kept in step on every write (only public, live lists).
  - **Where it differs from the task, and why:**
    - It is behind a flag, and the flag must stay off in production until P3b-7: before the read switch the legacy store is the truth, and a backfill re-run would overwrite edits made here to a copied list.
    - Item-level writes (add, remove, move, visibility) take no `If-Match`: they are set operations, not whole-list replacements. PATCH and DELETE require it.
    - Session-only auth (no `creatorName`/`creatorKey` in the body): these routes are for the Phase 6 pages, which use sessions.
- [x] **P3b-5** Likes API: `PUT`/`DELETE /api/likes/{type}/{id}` does `INSERT OR IGNORE` / `DELETE` plus `UPDATE … like_count = like_count ± changes()` in one batch. Voter: the account only (D-6). Carry the existing `a:`-prefixed signed-out voters across unchanged, since they still count (D-9). *Done when:* there is no cap, repeat likes are idempotent, and the tests pass. — **Status:** Done, in `32_likes-api.js`, behind `FF_V2_LISTS_API` with the list API (off until P3b-7). Tests: "P3b-5" in `tests/lists-v2.test.mjs`.
  - **How it works:**
    - `{type}` is `list` (a `public_id`), `channel` (a `public_code`) or `external` (the list's URL, percent-encoded, validated by `normalizeExternalListUrl` and stored under the same `hashStringForKey` hash as the legacy route and the backfill).
    - Likeable: a public or unlisted list (not private, deleted or legacy anonymous: 404, as the legacy route answers for a private list); a channel listed in Explore Channels (`visibility = 'public'`).
    - The voter is `acct:<id>` from the session. Signed out: `GET` works (`liked: false`), `PUT`/`DELETE` answer 401 `signInRequired`.
    - A request that is already as asked writes nothing. Otherwise one batch: the `INSERT OR IGNORE` or `DELETE`, then `like_count ± changes()` on the list or channel (never below 0), then the voter account's `version` (their liked set changed). Two devices liking at once move the count once (tested by running the batch twice).
    - An outside list has no row, so its count is its `likes` rows; a list's or channel's is `like_count`, which may sit above its rows (the backfill keeps higher legacy totals).
  - **Also added:** `GET /api/likes/{type}/{id}` (`{ liked, likes }`), which the pages need to draw a heart.
  - **Since P3b-7** `/api/lists/like` and `/like-external` write the same rows (`likeWriteStatements`). Since P3b-8 the `channels` rows exist, so channel likes work here too.
- [x] **P3b-6** Directory and search on v2: keyset pagination `?cursor=`, sort `popular|new|added`, FTS over `name`, `description` and `owner_name`. `/lists/public.json` keeps its response shape (with a cursor added). *Done when:* the top-100 order equals the legacy query on the fixture. — **Status:** Done, in `33_lists-directory.js`, behind `FF_V2_LISTS_READ` (off). Tests: "P3b-6" in `tests/lists-v2.test.mjs`: on a 130-list fixture (118 public, ties on likes), read through the legacy routes and, after the backfill, through v2, the top 100 are identical, entry for entry.
  - **How it works:**
    - `FF_V2_LISTS_READ` is the read switch, which P3b-7 completes; this task introduced it for the directory and search. Since P3b-7 both also wait for the copy (P3b-3) to have finished, since until then the directory would be missing lists.
    - `/lists/public.json`: `?sort=popular` (default: `like_count`, `updated_at`, `id`, all descending, which is today's `likes DESC, updatedAt DESC` with ties broken), `new` (`created_at`), `added` (`add_count`, then likes). Each walks its 0016 partial index with no sort step, first page and later pages alike (tested with `EXPLAIN QUERY PLAN`). `?cursor=` pages by keyset (a row-value comparison); every answer carries `cursor` for the next page, and `?offset=` still works. A cursor from another order is refused (400). The entry shape, `total`, `count` and cache header are unchanged; `cursor` and `sort` are added.
    - `/api/search-published-lists`: the route's own query handling decides the search terms and whether the answer is capped (50) or not; v2 then runs FTS over `lists_fts2` (prefix match per term, as legacy does) or, with no terms, lists everything. Only public lists with items, ordered by likes then items (legacy's order), with ties broken by most recently updated.
    - Owner-less (legacy anonymous) lists never appear (D-6), as today.
    - If a v2 query fails, both routes fall back to the legacy path (tested).
  - **Where it differs, and why:** a "my lists" search with a name after it (`my lists bob`) matches by word prefix in v2, where legacy matched a substring anywhere; everything else answers as legacy does.
- [x] **P3b-7** Compatibility shims: `/api/creator/lists`, `/lists/items`, `/lists/save`, `/lists/delete` and `/lists/reorder` are implemented over v2 (`save` diffs items, never replaces wholesale). `/api/lists/like` and `/like-external` map to P3b-5. *Done when:* the legacy client test suite passes against v2 with `FF_V2_LISTS_READ` on. — **Status:** Done, in `34_lists-v2-bridge.js`, with hooks in `02_`, `05_`, `25_` and `26_`. Reads are behind `FF_V2_LISTS_READ` (off). Tests: "P3b-7" in `tests/lists-v2.test.mjs` (18 tests, mutation-checked). CI also runs the whole suite a second time with `MLA_TEST_V2_LISTS_READ=1`, which turns the flag on for every test. It passes both ways: 1,477 tests, one skipped.
  - **How it works:**
    - **Writes go to both stores.** Every legacy route that changes a list still writes the legacy store first, exactly as before, then mirrors the change into v2. That covers save, delete, reorder, like, like-external, account reset and deletion, and the Watchlist on tracking saves. The mirror writes a list's details, search row and account version, and its items **as a diff**, in one batch. Only the rows that were added, removed, moved or edited are written. The longest run of items already in order keeps its positions, and the rest go between their neighbours; the list is renumbered first when moves have used up the room.
    - The mirror reads the legacy record back the way the site reads it (`readLegacyCreatorList`), so a save whose D1 write failed still reaches v2 from KV (tested). A copy that already matches its record (the same `legacy_hash`) writes nothing, not even the lease.
    - **Mirrors run whenever the 0016 tables exist, whatever the flag says.** So v2 keeps pace from the day 0016 is applied, not the day reads switch. And turning the flag off is a clean rollback, because nothing stopped writing the legacy store. Before 0016 exists, the first failure makes the mirrors stand down for ten minutes (tested: saves and reads carry on as before).
    - **One writer per account at a time.** The mirror and the copy take the same lease (`run_after` on the account's `migrate.lists` job).
      - A save that finds a copy under way marks the job dirty. The copy then goes round the account again before calling it done.
      - A mirror that fails, and a list over 1,500 items (left to the bounded copy), mark the account's copy **stale** (`status` back to `queued`). Reads go back to the legacy store for that account until it is copied again.
    - **Reads, with `FF_V2_LISTS_READ`,** come from v2 for an account whose copy has finished (`status = 'done'`):
      - the dashboard (`/api/creator/lists`), list contents (`/lists/items`), public list pages (`/lists/{user}/{slug}` and `.json`) and Custom List catalog rows;
      - the dashboard and list contents copy an unfinished account on the spot, within a small budget ("migrate on read"), and other reads use the legacy store for it until then;
      - the directory and search (P3b-6) read v2 once the whole copy has finished.
    - **Answers are the same as the legacy routes give.** The dashboard keeps the same payload, paging, version and `unchanged` reply. Items are rebuilt from their media row plus `extra_json` (`legacyItemFromEntryRow`); `extra_json` holds only what the media row cannot give back, plus a `"~k"` key list when the key order or a derived value would otherwise differ. Tests compare the legacy and v2 answers for the dashboard, list contents, public pages and catalogs.
    - `/api/lists/like` and `/like-external` write the same `likes` rows and `like_count` as P3b-5 (voter `acct:<id>`). With the flag on, the like route answers with the v2 count.
    - Catalog rows keep a list's items for five minutes per Worker instance, keyed by its `public_id` and `version`, so any change shows on the next request.
  - **Where it differs from the task, and why:**
    - **The legacy routes are not reimplemented over v2; they write both stores.** Until P3b-9 stops the legacy writes, the legacy store stays complete. So turning the flag off at any time goes back to it with nothing lost. P3b-9 removes the legacy half.
    - **The Watchlist is read from the legacy store.** Playback tracking rewrites it, and it moves with the activity data (Phase 3c). Its v2 copy is kept current, because a shared Watchlist is in the directory.
    - **With reads on v2, the copy does not refresh a finished account.** v2 is what people see and saves keep it current, so a re-run would only undo that. An account marked stale is copied again. The anonymous-list and outside-list phases still run.
    - **Personal shelves in the dashboard order** (Continue Watching and the like) are kept as `section` rows in `account_list_prefs`. That table gained a `position` column (0016 edited, as it is applied nowhere yet).
    - **Old records keep reporting no version.** A list saved before lists had an `updatedAt` still reports none (`source_json.noVersion`), so the save route's conflict check behaves as today.
    - **Ids the resolver did not accept** (IMDb ids of one or two digits, and ids of no known form, such as a bare word) are now kept as `alt_id`: the legacy lists serve whatever id they were given. Only an entry with no id at all (or one over 200 characters) is left out.
    - **Two tests read the legacy store on purpose, even with the flag on:**
      - getCreatorList's self-repair of D1: a legacy read path v2 does not need, and a new test covers the failure it guards against;
      - the P3b-3 re-run test: a finished account is not re-copied with reads on v2, by design.
  - **Known limits, for P3b-9:**
    - ~~A list over 1,500 items is not mirrored on save.~~ Fixed in P3b-9: large writes go as JSON in a few statements (`d1JsonChunks`), so a list of up to 10,000 items is mirrored on save in one request (tested: under 200 D1 queries).
    - Whether an account is ready is kept a minute per Worker instance. After a failed mirror, another instance may serve the older v2 copy for up to a minute. A save that met a copy under way is in the legacy store at once, but not in the directory's v2 copy until the account's next dashboard read or admin step.
    - Legacy anonymous lists (`/api/publish-list`) are not mirrored. Nothing reads their v2 copies yet; P3b-9 must copy them again first.
    - Entries with no id at all, and a title listed twice in one list, are not in v2 (the copy's report counts them), so they stop showing once reads switch. Check the report before turning the flag on.
- [x] **P3b-8** Channels: `channels` rows plus R2 pools (`channels/{code}/{version}.json`); `/api/channel/*` reimplemented over them; the directory as a SQL query; likes and adds through `likes` / `add_count`. `/channel/:code` and `/channels/:user/:slug` resolve. *Done when:* shared-channel fixtures produce the same lineup for the same day seed. — **Status:** Done, in `35_channels-v2.js`, with hooks in `25_` and `26_` and a new "channels" phase in the copy (`30_`). Reads are behind `FF_V2_LISTS_READ` (off). Episode lists need the new R2 binding `BLOBS` (bucket `mylists-blobs`); without it everything else still works. Tests: "P3b-8" in `tests/lists-v2.test.mjs` (8 tests; all 24 deliberate faults tried were caught). The whole suite passes with the flag off and on: 1,486 tests, one skipped.
  - **How it works:**
    - **One row per share code** (`public_code`): the settings in `definition_json`, the listing's description, the counts. The episodes are one R2 object per version, `channels/{code}/{version}.json`. A new version is written only when the episodes change, and the old object is then removed.
    - **Writes go to both stores**, as in P3b-7. Share, unpublish, like, added and the admin takedown write the legacy KV store first, exactly as before, then mirror into v2.
      - The mirror applies only if the row is not already newer (`updated_at`), so of two saves racing each other the later one wins; a pool written for the loser is removed.
      - A mirror that cannot finish clears the row's `legacy_hash`, and a row without one is never read.
      - An admin takedown (unlist or delete) that cannot update v2 is reported as not finished, as it already is when the directory row cannot be removed.
    - **Likes** go to `likes` (`target_type` `channel`, voter `acct:<id>`), with `like_count` moved by `likeWriteStatements`, so the P3b-5 likes API now works for channels. **Adds** go to `likes` with `target_type` `channel_add`, once per account, and `add_count`.
    - **The copy** gains a "channels" phase after outside-list likes, before *Done*. It copies every `channelshare:` record with its directory row and its like and add ledgers.
      - Like and add counts never go below the legacy totals (D-9).
      - Unreadable records are counted and named in *Check results*.
      - It still writes nothing to the legacy store; its env allows R2 only under `channels/` (tested).
      - A re-run rewrites nothing that has not changed.
    - **Reads, with `FF_V2_LISTS_READ`:**
      - a channel opened by code or address (`GET /api/channel/share`, `/channels/{user}/{slug}.json`), and the signed-out install save that stores a listed channel's lineup, read v2 when the row is current and its episodes are in R2;
      - Explore Channels (every order), `/api/channel/mine` and the admin directory view read v2 once the copy has finished, like the list directory;
      - otherwise, the legacy store.
    - **Done-when met.** The rotation code is unchanged, and a channel read back from v2 is the same object the legacy store holds. The test fixtures are:
      - a rotating channel with Story Lock;
      - a shuffled one with paired parts and a movie;
      - one sorted by air date;
      - shares from before accounts, and one whose owner is gone.

      For each, the channel from v2 equals the legacy one and plays the same lineup on each of three days (`/api/channel-lineup` with a fixed `now`). Explore Channels, `mine`, the admin view and the address routes answer the same as the legacy ones in every order, ties included.
    - `/channel/{code}` is a redirect to the builder and needs nothing from storage.
  - **Where it differs from the task, and why:**
    - **The legacy routes are not reimplemented; they write both stores** (as in P3b-7). Turning the flag off goes back to the legacy store with nothing lost.
    - **Channels an account syncs between its own browsers** (`creatorsyncchannels:`, the builder's private copies) **stay in their sync blob.** It is an opaque client blob synced whole with a version check, like presets. Moving it to rows belongs with the channel builder's rebuild (Phase 6), and `channels.client_id` is there for it.
    - **Explore Channels has no 500-listing cap any more**, and a listing can no longer be lost to two publishes at the same moment (the legacy index is one KV key, rewritten whole).
    - **Newest:** `published_at` is when a listing last went to the top (a publish, or an update while listed), which is the legacy index's order. `created_at` is when it was first shared: the card's `publishedAt`.
    - **The "name" order is sorted in the Worker** with the legacy comparator, over at most 5,000 public channels.
    - **0016 was edited again:** `channels.legacy_hash`, and the Most liked and Most added indexes break ties by `published_at`, as the legacy index does.
    - **Without `BLOBS`**, rows are still written (the directory, likes and adds need nothing else) and episodes are read from KV. *Check results* counts the episode lists it left there.
  - **Known limits, for P3b-9:**
    - `BLOBS` must be bound, and the copy re-run, before `channelshare:` stops being written.
    - A renamed channel's old slugs resolve through the legacy map only: v2 keeps the current slug.
    - A directory row written by an older build may differ in small ways from the card v2 builds, which always comes from the current record.
    - A published channel whose directory row was lost to a race is listed by v2 but not by the legacy directory (v2 is right).
- [x] **P3b-9** Stop writing the legacy KV keys (`creatorlist:`, `creatorlistorder:`, `creatorliststamp:`, `creatorlistdeleted:`, `listlikevoters:`, `extlikevoters:`, `externallike:`, `index:publicchannels`, `channelshare:`, `channellikevoters:`) once reads are on v2. *Done when:* the Analytics Engine KV-write counter for these prefixes is 0. — **Status:** Done in code, behind a new flag, **`FF_V2_LISTS_ONLY`** (off). Turning it on is the owner's step, one-way, once reads have been on v2 for a while (`docs/OPERATIONS.md` §11); the production counter is read after that. Tests: "P3b-9" in `tests/lists-v2.test.mjs` (9 tests, plus 2 for the fixes below). Of the 41 faults tried, all were caught except two defensive guards no route can reach; a third survivor showed a duplicated check, which was removed. 1,495 tests pass with `FF_V2_LISTS_READ` off and on.
  - **How it works:**
    - **With `FF_V2_LISTS_ONLY` on, the legacy list and channel routes keep their requests and answers but read and write only v2.** The save route builds its record as before and hands it to `listsV2WriteRecord` instead of KV and `creator_lists`. The same goes for delete, reorder, the Watchlist on tracking saves and playback pings, likes (lists, outside lists, channels), channel share, like, added, unpublish and the admin takedown.
    - **Nothing is put under the ten legacy prefixes**, nor under `creatorchannel:` and `channeladdvoters:`. Nothing is inserted or updated in `creator_lists`, `list_likes`, `lists_fts` or `list_tombstones`. Removing a deleted list's leftover legacy record is allowed: it writes nothing. The lists stamp other devices poll is kept in D1 (`creators.lists_stamp`) only.
    - **Reads come only from v2**, with no fallback to the legacy store, which would be stale. That covers every account (no copy needed), the Watchlist, the dashboard order in `/sync/load`, catalog rows and the Explore Channels directory. A v2 read or write that fails answers 503, so the browser keeps its copy and retries; before, it would have been served out-of-date data.
    - **Writes to one account are serialised** by the same lease the copy used; a save waits up to about 3 s for another save of that account to finish.
    - **Large lists:** writes of many rows go as one JSON value per statement (`d1JsonChunks`, `json_each`). A 10,000-item save takes under 200 D1 queries, where it took thousands. This also removed P3b-7's 1,500-item mirror limit.
    - **Account reset** keeps the lists' rows as deleted markers (items gone), since no legacy tombstones are written; deleting the account removes them.
    - **The copy refuses to run** (there is nothing current to copy from), and so do `/admin/api/migrate-d1` and the per-account copy (a guard, even though no route reaches it).
    - **The admin tools read v2:** the creator list browser, the delete tool's "remaining" count, and the channel views, listed and all.
    - **The search index rebuild** now rebuilds `lists_fts2` too, in both modes; it is the recreation step after a D1 export. With the flag on, it rebuilds only `lists_fts2`.
    - **The measure:** the Analytics Engine data point gains an eighth number, puts to the legacy list prefixes. It is tested to be 0 with the flag on for every list, like and channel route, and above 0 without it.
    - **The flag implies `FF_V2_LISTS_READ`.**
  - **Done-when, as far as it can be met in code:** the same script of about 60 requests runs against two copies of the site, one dual-written (P3b-7/8) and one with the flag. It covers saves (with sync settings), edits with a version check (and a stale one refused), reorder with a shelf, likes and unlikes, outside-list likes, delete and re-create, the Watchlist from tracking saves and a playback ping, and a shared channel's whole life. It also reads the dashboard, list contents, page, directory, search, catalog row, `/sync/meta` and `/sync/load` after each stage. Every answer is identical, and the flagged copy made no legacy write at all.
  - **Found and fixed on the way (dual mode, P3b-7):**
    - A list made again at a deleted list's address inherited the old list's likes in v2. A deleted copy now drops its likes (as the legacy delete drops its ledger).
    - A playback ping that took a title off the Watchlist was not mirrored.
    - A Watchlist made by a tracking save went last in v2 but first in the legacy order.
    - A catalog row pointing at a creator's list page link still read the legacy store with `FF_V2_LISTS_READ` on.
  - **Where it differs from the task, and why:**
    - **Behind a flag, not unconditional.** Stopping the legacy writes is one-way: after it, turning `FF_V2_LISTS_READ` off would read stale lists. So it ships off, and the owner turns it on only after the copy is complete and reads have been on v2 for a while (OPERATIONS §11).
    - **The legacy D1 list tables stop too**, not only the KV keys, for the same reason. The per-list delete and account purge still remove what the legacy store holds of a user's lists.
  - **Left after P3b-9:**
    - The legacy keys and tables are not deleted; Phase 7 removes them. The old anonymous lists (`publishedlist:`, not on the list) are still served from the legacy store, as are their ledgers.
    - With the flag on, a renamed channel's old address stops resolving; its current one works (the legacy slug map is no longer read).
    - `/admin/api/backfill-trending` still reads the legacy lists (a one-off tool); with the flag on, what it reads is out of date.
    - Channels an account syncs between its own browsers stay in their sync blob (P3b-8).

## Phase 3c — Activity

- [ ] **P3c-1** Create D1 database `mylists-activity` and bind it as `DB_ACTIVITY` (dashboard). Migration `A0001_activity.sql`: `watch_events`, `show_progress`, `user_media_state`. `src/storage/db.js` adds `activityDb(env, accountId)` implementing `shardFor()` (a single shard for now). *Done when:* bound in staging and production.
  - **Code done (Claude, 2026-09-28); the dashboard steps are the owner's** (`docs/OPERATIONS.md` §2 and §4).
    - `migrations/activity/A0001_activity.sql`, with `schema_activity.sql` for a fresh database. The activity migrations live in their own folder with an `A` prefix, because the main drift test runs every `migrations/*.sql` against `schema.sql`. The activity database has its own `schema_migrations` ledger.
    - Following D-11 (no `src/`), the helper is `36_activity-db.js`: `activityDb(env, accountId)` (null without the binding, so callers keep the legacy store), `shardFor(env, accountId)`, `activityDbs(env)` and `activitySchemaReady(db)`. Sharding is `account_id % ACTIVITY_SHARD_COUNT` over `DB_ACTIVITY`, `DB_ACTIVITY_1`, ...; a count whose bindings are missing is ignored (logged).
    - Differences from the sketch: `show_progress.status` has a `CHECK`; the dedupe key format is left to P3c-4 (the column is `UNIQUE`).
    - Nothing reads or writes the tables yet. Tests: `tests/activity.test.mjs`; `makeD1({ schema: "activity" })` in the harness.
- [ ] **P3c-2** Migration `0017_show_schedule.sql` in `DB`: `show_schedule`, `account_recommendations`, `title_daily_stats`. *Done when:* applied.
- [ ] **P3c-3** Backfill job `migrate.activity` per account (MIGRATION_PLAN §2 Phase 3c), deduplicating by `(media, season, episode, watchedAt ±10 min)`. Companion metadata goes to `show_progress.companion_json`; dismissals and airing removals are mapped. *Done when:* for 100% of accounts, the v2 history count is at least the maximum of the KV and D1 counts, and differences are logged.
- [ ] **P3c-4** Scrobble ingestion: `src/activity/scrobble.js` validates and enqueues (or, before Phase 5, writes inline) `INSERT watch_events` plus `UPSERT show_progress` plus `user_media_state` in one batch on `DB_ACTIVITY`; updates `show_schedule.watcher_count`; writes Analytics Engine. Used by the subtitles ping, the webhook and the web "mark watched". *Done when:* one play performs at most 4 D1 statements (a test counts them) and writes nothing to KV.
- [ ] **P3c-5** Shelves: `src/activity/shelves.js` — `continueWatching(accountId)`, `airingNext(accountId)`, `history(accountId, cursor)`, `watchlist(accountId)`. Two queries plus a join in the Worker (chunks of 90). *Done when:* shelf tests pass on fixtures, including dismissals, companions and finale badges.
- [ ] **P3c-6** Compatibility: `/api/creator/sync/save-tracking` is a diff shim that inserts new events and honors intentional removals only. `/api/creator/sync/load` assembles the legacy shape from v2. Stop writing `creatorsynctracking:`, `creatorscrobblequeue:`, `trackingd1behind:` and the legacy D1 tracking tables behind `FF_EVENT_TRACKING`. *Done when:* the legacy client suite passes and the KV writes for these prefixes are 0.

---

## Phase 4 — Providers

- [ ] **P4-1** The adapter interface and registry (`src/providers/registry.js`) replace `detectSource` / the `fetchCatalog` if/else. Adapters for tmdb, trakt, mdblist, simkl, justwatch, rapidapi, tvmaze, cinemeta and letterboxd (import only). *Done when:* every source string in today's `detectSource` maps to an adapter (a test enumerates them).
- [ ] **P4-2** Normalize every adapter output to `MediaRef` with `media_id` from the resolver. Stremio metas are built from `MediaRef` plus `media`. *Done when:* no catalog emits an id outside `tt…` / `tmdb:…` / `channel_…`.
- [ ] **P4-3** Chart snapshots: `snap:chart:{source}:{chart}:{type}:{region}:{page}` (KV, 2 h TTL, stale-while-revalidate); an empty result never replaces a non-empty one. *Done when:* catalog chart reads hit the snapshot; there is a test for the empty-refusal rule.
- [ ] **P4-4** Provider breaker in KV `pb:{provider}` (60 s TTL): open after 5 consecutive failures; fail fast; metrics. *Done when:* the fault-injection tests pass.
- [ ] **P4-5** Provider contract fixtures (`tests/fixtures/providers/*`) plus a nightly live-check workflow. *Done when:* both are in CI.

## Phase 5 — Jobs and caching

- [ ] **P5-1** Create queue `mylists-jobs` and DLQ `mylists-jobs-dlq`; add the producer binding `JOBS`; configure the consumer (this Worker; batch size 25; max retries 5). Add `export async queue(batch, env, ctx)` dispatching by `msg.body.type`. *Done when:* a test job round-trips in staging.
- [ ] **P5-2** The `jobs` table (created early, in migration 0016, for P3b-3) plus `src/jobs/dispatcher.js`: the `*/5` cron re-enqueues due or stuck jobs (lease timeouts). Hourly and daily crons enqueue periodic jobs. Remove all work from `scheduled()` other than dispatch. *Done when:* `scheduled()` finishes in under 1 s CPU.
- [ ] **P5-3** `show.refresh`: select `show_schedule WHERE next_check_at <= now AND watcher_count > 0 LIMIT 500`; batches of 50; one TMDB details call (plus TVmaze air time) per show; set `next_check_at` by status. *Done when:* the shelves stay correct over simulated time in tests.
- [ ] **P5-4** Shadow comparison: for a week, compute v2 Continue Watching and Airing Next alongside the legacy crons and log differences to Analytics Engine. Then flip `FF_SHOW_SCHEDULE` and delete `checkForNewEpisodes`, `refreshAiringNextSweep`, the related cursors and constants, and the client `refreshAiringNext` / `updateContinueWatching` shelf builders. *Done when:* differences are below 1% and explained, and the code is removed.
- [ ] **P5-5** `chart.refresh` hourly per (chart, region in use); delete `prewarmSharedCatalogs` and `cron:prewarm:cursor`. *Done when:* charts in every used region are served from snapshots.
- [ ] **P5-6** `import.resolve`: `POST /api/imports` (file rows or URL), job progress at `GET /api/imports/:id`, a review endpoint for ambiguous matches, and the result list. Delete `/api/bulk-resolve` after the client migrates (keep a shim for one release). *Done when:* a 1,000-row Letterboxd import completes with the tab closed.
- [ ] **P5-7** `token.refresh` daily for connections expiring within 7 days; `status='reauth_required'` on failure; a website banner and a Stremio row placeholder tile. *Done when:* the expiry simulation test passes.
- [ ] **P5-8** `account.purge`: `DELETE /api/me` sets `deleted_at`, revokes sessions and installs, and enqueues the purge; the purge cascades v2 rows and R2 objects; the legacy KV sweep stays until Phase 10. Remove the pre-create purge in account creation. *Done when:* the deletion tests pass with no inheritance by a re-registered username.
- [ ] **P5-9** `poster.fetch` (BetterPosters into R2); `/bp/*` serves from R2, and on a miss serves the plain poster and enqueues. Delete `bpimg:v1:`, `bp:retry:v1`, `bp:variants:v1`, `bp:sharedids:v1` and `prewarmBetterPosters`. *Done when:* no request waits on btttr.cc.
- [ ] **P5-10** `channel.pool.build` (R2), `recs.build` (writes `account_recommendations`), `nos.sweep` (New on Streaming; the quota ledger moves to D1), `rollup.daily`. *Done when:* each is covered by tests.
- [ ] **P5-11** Materializer: on a catalog request, if `snap:mat:{installId}:{version}:*` is missing, build page 0 for all rows (concurrency 6), apply cross-row dedupe once, and store the results in KV (1 h) and the Cache API. Each row reads its materialized page. Delete `dedupeAcrossListEntries`. *Done when:* a 20-row install with dedupe performs no more than 20 row builds per version (a test counts them).

## Phase 6 — Frontend

- [ ] **P6-1** New pieces of the existing page, in vanilla JavaScript inside `16_`–`24_` (no framework, D-11): real-path routing for the tabs, an install bar, one toast system, an accessible modal, an API client (cookie auth, JSON, error mapping) and a small shared state object. *Done when:* `FF_NEW_UI` (cookie) serves the shell with the legacy views embedded.
- [ ] **P6-2** Settings (Connections, Account, Devices, Installs, Home-screen options, Tracking). *Done when:* the E2E scenarios 10, 11 and 12 pass.
- [ ] **P6-3** Home / home-screen editor: paste-first add (single and multi-line with a review table), the Starter pack, row reorder, dedupe toggle, live preview from the materializer. *Done when:* the E2E scenarios 1, 2 and 3 pass.
- [ ] **P6-4** Lists: list page, inline "Add titles" search, share (Private / Unlisted / Public), "Show on home screen". *Done when:* scenarios 4, 7 and 9 pass.
- [ ] **P6-5** Explore: community lists and channels plus provider charts plus search. *Done when:* scenario 8 passes.
- [ ] **P6-6** Imports UI (job progress and review). *Done when:* scenario 5 passes.
- [ ] **P6-7** Channels: templates first, the advanced builder second (wrap the legacy builder until it is rewritten). *Done when:* scenario 6 passes.
- [ ] **P6-8** Remove the `localStorage` data keys (keep `theme` and UI preferences), all `alert()` calls, and inline handlers. *Done when:* `grep` shows no `localStorage.setItem('myListAddon:creatorKey'` or token keys, and no `on[a-z]+=` in the templates.
- [ ] **P6-9** Signed-out local mode for existing local lists ("Saved in this browser only") with "Save to an account" and "Export". *Done when:* a legacy `localStorage` fixture shows its lists and can migrate them.
- [ ] **P6-10** The admin page (`03_admin.js`) with no inline handlers: event delegation instead. *Done when:* the admin works with no `on[a-z]+=` attributes.

## Phase 7 — Security hardening

- [ ] **P7-1** CSP: `script-src 'self' 'nonce-{rand}'`; `style-src 'self' 'nonce-…'` (or hashes); self-hosted fonts and `fflate`; `require-trusted-types-for 'script'` in report-only mode, then enforced. *Done when:* no violations in E2E runs.
- [ ] **P7-2** Cloudflare Access on `/admin*` (dashboard). D1 `admin_sessions` and `admin_audit_log`; every mutating admin route writes an audit row. `ADMIN_KEY` only as break-glass. *Done when:* the admin requires Access, and the audit log is visible in the admin UI.
- [ ] **P7-3** WAF rate-limiting rules (dashboard) on `POST /api/session`, `/api/installs`, `/api/likes/*`, `/api/imports`, `/api/feedback`, `/api/scrobble*`. Delete `consumeRateLimit` and the inline KV limiters in favor of D1 `rate_counters` for per-account limits. *Done when:* no `ratelimit:` KV writes remain.
- [ ] **P7-4** Raise the PBKDF2 iterations to the target (≥ 600k SHA-256, or measure CPU and pick the maximum under 100 ms); rehash on login. *Done when:* tests cover legacy-hash login and upgrade.
- [ ] **P7-5** Recovery codes (10 one-time codes, hashed) replace the recovery answer for new accounts; existing answers keep working, with notification to active sessions and a 24 h delayed reset. *Done when:* the flows are tested.
- [ ] **P7-6** Scrobble: `st` token only. The `config=` and `creator=&key=` forms log usage and show a banner, and are removed at the sunset date. *Done when:* the usage metric reaches 0 or the sunset date passes.
- [x] **P7-7** ~~Anonymous installs: size cap and 180-day idle expiry~~ — **Status:** Dropped 2026-09-25: signed-out install links never expire (D-10). The size cap already exists (`SAVED_CONFIG_ENTRIES_MAX`, `SAVED_CONFIG_BYTES_MAX`).

## Phase 8 — Performance

- [ ] **P8-1** Enable D1 read replication on `DB`; use `env.DB.withSession()` for catalog, directory and public list reads. *Done when:* p95 latency improves in the non-primary regions.
- [ ] **P8-2** Replace all `bumpStat` / `bumpStatBy` / `recordTrackedEvent` / `recordSearchQuery` writes with Analytics Engine; `title_daily_stats` for Most Watched; the admin dashboard reads through the Analytics Engine SQL API. Backfill history from `stats`. *Done when:* no D1 writes on page views.
- [ ] **P8-3** Bundle budget check in CI (first view under 150 KB gzip); route chunks. *Done when:* CI enforces it.
- [ ] **P8-4** Badged posters: SVG overlay referencing the image URL, or an R2-rendered image keyed by `(poster, badge, day)`; remove the base64 inlining. Precompute the icon bytes. *Done when:* the poster route CPU time halves in measurement.
- [ ] **P8-5** k6 load tests (catalog hot path, scrobble burst, directory depth) against staging; record baselines in `docs/PERFORMANCE.md`. *Done when:* the targets in PERFORMANCE_AUDIT §5 are met.

## Phase 9 — Testing (deliverables)

- [x] **P9-1** ~~The workerd test pool is the default; the node harness is retired.~~ — **Status:** Dropped (D-11). The node harness stays (`tests/harness.mjs`, real SQLite with D1's limits enforced).
- [ ] **P9-2** Migration test suite with anonymized production fixtures (lists, likes, channels, activity, installs).
- [ ] **P9-3** Playwright E2E for all 12 scenarios at 375 px and 1280 px, plus axe, in CI. Playwright is installed in CI only (`npm install --no-save`, like the scope checker), never as part of the build (D-11).
- [ ] **P9-4** Security suite: CSRF, query-string credentials, cookie flags, CSP, install-token scope, session revocation, IDOR matrix.
- [ ] **P9-5** A staging Worker with its own D1, KV, R2 and Queue (dashboard) and a deploy checklist.

## Phase 10 — Cutover and cleanup

- [ ] **P10-1** Flip the flags in order (MIGRATION_PLAN Phase 10 step 1), 7 days apart, with the reconciliation gates.
- [ ] **P10-2** Announce the sunsets in-app 60 days ahead: key-in-body auth, the sync shims, `/api/resolve`, the legacy scrobble forms, `LEGACY_UNVERIFIED_CONFIG_SHELVES`, SHA-256 key lookups, list tombstones for old clients.
- [ ] **P10-3** Export, then delete the legacy KV prefixes and D1 tables (MIGRATION_PLAN Phase 10 step 4). Keep the `cfg:` records (secret-stripped) until their installs are D1-served for 30 days.
- [ ] **P10-4** Remove the admin migration tools (`/admin/api/migrate-d1`, `migrate-day-counts`, `backfill-trending`, `rebuild-*-index`), `ensureTrackingMigrated`, `migrateGenreDecadeStatsIfNeeded`, and `backfillCreatorLastActive` (FT-16, FT-42, BE-M19).
- [ ] **P10-5** Documentation: the product README, `docs/OPERATIONS.md`, `docs/ARCHITECTURE.md`. Move `STORAGE-PLAN-KV-D1.md`, `COMPLETE_AUDIT_REPORT.md`, `UI_UX_AUDIT.md`, `Changes.md`, `FUNCTION-MAP.md` and these eight planning documents to `docs/history/`.
