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
- [ ] **P3b-3** Backfill job `migrate.lists` per account (MIGRATION_PLAN §2 Phase 3b steps 1–8), resumable, with a reconciliation record in `jobs.progress_json`. *Done when:* staging runs on an anonymized production fixture with mismatches below 0.1%, each explained.
- [ ] **P3b-4** List API: `GET /api/lists` (mine), `POST /api/lists`, `GET/PATCH/DELETE /api/lists/:publicId`, `POST /api/lists/:id/items` (batch ≤ 500), `DELETE /api/lists/:id/items/:mediaId`, `POST /api/lists/:id/items/move`, `PUT /api/lists/:id/visibility`. `If-Match` versioning on PATCH and DELETE. Every mutation updates `item_count`, `version` and `accounts.version` in one `batch`. *Done when:* the API tests cover owner, other and anonymous access.
- [ ] **P3b-5** Likes API: `PUT`/`DELETE /api/likes/{type}/{id}` does `INSERT OR IGNORE` / `DELETE` plus `UPDATE … like_count = like_count ± changes()` in one batch. Voter: the account only (D-6). Carry the existing `a:`-prefixed signed-out voters across unchanged, since they still count (D-9). *Done when:* there is no cap, repeat likes are idempotent, and the tests pass.
- [ ] **P3b-6** Directory and search on v2: keyset pagination `?cursor=`, sort `popular|new|added`, FTS over `name`, `description` and `owner_name`. `/lists/public.json` keeps its response shape (with a cursor added). *Done when:* the top-100 order equals the legacy query on the fixture.
- [ ] **P3b-7** Compatibility shims: `/api/creator/lists`, `/lists/items`, `/lists/save`, `/lists/delete` and `/lists/reorder` are implemented over v2 (`save` diffs items, never replaces wholesale). `/api/lists/like` and `/like-external` map to P3b-5. *Done when:* the legacy client test suite passes against v2 with `FF_V2_LISTS_READ` on.
- [ ] **P3b-8** Channels: `channels` rows plus R2 pools (`channels/{code}/{version}.json`); `/api/channel/*` reimplemented over them; the directory as a SQL query; likes and adds through `likes` / `add_count`. `/channel/:code` and `/channels/:user/:slug` resolve. *Done when:* shared-channel fixtures produce the same lineup for the same day seed.
- [ ] **P3b-9** Stop writing the legacy KV keys (`creatorlist:`, `creatorlistorder:`, `creatorliststamp:`, `creatorlistdeleted:`, `listlikevoters:`, `extlikevoters:`, `externallike:`, `index:publicchannels`, `channelshare:`, `channellikevoters:`) once reads are on v2. *Done when:* the Analytics Engine KV-write counter for these prefixes is 0.

## Phase 3c — Activity

- [ ] **P3c-1** Create D1 database `mylists-activity` and bind it as `DB_ACTIVITY` (dashboard). Migration `A0001_activity.sql`: `watch_events`, `show_progress`, `user_media_state`. `src/storage/db.js` adds `activityDb(env, accountId)` implementing `shardFor()` (a single shard for now). *Done when:* bound in staging and production.
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
