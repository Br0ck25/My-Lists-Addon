# Next Version — Implementation Checklist

Executable task list for a developer or AI agent. Each task has an ID, the files it touches, acceptance criteria (AC) and dependencies. Reference documents: `NEXT_VERSION_ARCHITECTURE.md` (target), `MIGRATION_PLAN.md` (phases and guarantees), `BACKEND_AUDIT.md`, `SECURITY_AUDIT.md`, `PERFORMANCE_AUDIT.md`, `FRONTEND_UX_AUDIT.md`, `CLOUDFLARE_FREE_TIER_REMOVAL_PLAN.md` (FT-ids).

**Rules for every task**

* One PR per task unless noted. Tests first: add a failing test that captures the bug or the behaviour to preserve.
* Phases 1: edit the numbered source files, then `python3 build.py` and `bash verify.sh` (the committed Worker must match). From Phase 2 on, the numbered files are gone.
* Never delete or reset user data. Anything kept for compatibility gets a usage counter before removal.
* Line numbers refer to the audited commit; re-locate by function name if they have drifted.

---

## Phase 1 — Hotfixes and free-tier removal (current codebase)

### Correctness

- [ ] **T1.1 Fix the webhook user-filter crash and precedence** (B-H1, S-10)
  * Files: `26_api-creator-and-admin-routes.js` (`handleMediaServerScrobble`, 26:774–905).
  * Move the `pingId` computation above the filter block (it only needs `mediaType`, ids, `season`, `episode`, `title`, which are known after payload parsing). Make URL parameters (`filterUsers`, `allowedUsers`, `blockAnon`) override account settings when present, as the comment states.
  * AC: new tests — (a) account filter on, disallowed user → `200 {ok:true, ignored}` and diagnostics written; (b) account filter on, anonymous payload with `blockAnon` → `200 ignored`; (c) URL `filterUsers=1&allowedUsers=alice` with account default off → `mallory` ignored; (d) allowed user recorded.
- [ ] **T1.2 Honour `skip` for published-list rows** (B-H7)
  * Files: `05_catalog-core.js` (`fetchPublishedListCatalog`).
  * Slice `mapped.slice(skip, skip + PAGE_SIZE)`, set `totalItems`, return `[]` when `skip >= length` (same shape as `fetchCustomListCatalog`, 05:1639–1642).
  * AC: 250-item list → 100/100/50/0 items for skip 0/100/200/250.
- [ ] **T1.3 Honour `skip` for auto-tracked rows** (B-H7)
  * Files: `05_catalog-core.js` (`fetchAutoTrackedCatalog`): D1 queries use `LIMIT ? OFFSET ?`; KV path slices; set `totalItems`.
  * AC: 250-item Watch History → distinct pages for skip 0/100/200; Continue Watching and Airing Next unchanged for skip 0.
- [ ] **T1.4 Contract test: every source kind pages correctly**
  * Files: `tests/` new `catalog-paging.test.mjs`.
  * AC: for each `detectSource` kind reachable offline (published list, custom list, autotrack ×4, curated snapshot, channel, merged), pages never repeat and `skip >= total` returns `[]`.

### Security

- [ ] **T1.5 Stop exposing secrets from install configs** (S-1)
  * Files: `25_api-catalog-routes.js` (`/api/resolve` 25:6918–6930 → return `entries` and non-secret settings only; `/{config}/configure` 25:468–480 → do not pass tokens/keys into `renderBuilder`), `24_client-backup-restore-presets.js` (import-by-link no longer expects tokens; prompt to connect instead).
  * AC: `/api/resolve` response contains no `*Key`/`*Token` fields; configure page HTML contains no token (hostile-render style test with sentinel tokens); import-by-link still restores rows.
- [ ] **T1.6 Stop storing the account key in new install configs** (S-1)
  * Files: `25_api-catalog-routes.js` (`/api/save`, 25:7048–7055), `04_config-resolution.js` (`resolveConfig`: rely on `trackOwner`).
  * AC: new configs contain `trackOwner` and no `trackCreatorKey`; playback tracking via the subtitles ping still works for new configs (tracking authenticates by `trackOwner` + a scrobble-scoped check — add `authenticateInstallOwner` that trusts the server-stamped owner); old configs unaffected.
  * Depends on: design note in the PR explaining why a server-stamped owner is sufficient (it was verified at save time).
- [ ] **T1.7 Make anonymous channel shares immutable; rate-limit anonymous shares** (S-3, S-14)
  * Files: `26_api-creator-and-admin-routes.js` (`/api/channel/share` POST), `20_client-channel-builder.js` (store and send an `editSecret` returned at creation).
  * Rules: a record without `owner` can be replaced only with its `editSecret` (hash stored); claiming requires the same; anonymous shares limited per IP (e.g. 10/hour) and to 1 MB.
  * AC: reproduction from `SECURITY_AUDIT.md` S-3 now returns 403; the creator can still update their own anonymous share.
- [ ] **T1.8 Account deletion removes channels and holds the username** (S-4 interim, B-H3)
  * Files: `02_http-and-creator-utils.js` (`purgeCreatorData`), `26_` (`/api/creator/create` checks a hold).
  * Delete `channelshare:{code}` for every channel owned by the account (reuse the lookup behind `/api/channel/mine`), `creatorchannel:{u}:*`, remove directory entries; write `usernamehold:{u}` (30 days) and refuse creation while held.
  * AC: extend "audit fix 12: deleting an account leaves nothing behind" to cover channels and directory; re-registration within 30 days is refused.
- [ ] **T1.9 Remove the `forgot-username` PBKDF2 scan** (S-8, B-H12)
  * Files: `26_` 26:1599–1617. AC: request with an unknown key performs zero `verifyCreatorKey` calls.
- [ ] **T1.10 `/api/preview` uses `safeErrorMessage`** (S-16) — 25:1270–1273.
- [ ] **T1.11 Trakt device endpoints use the server client id only; add per-IP rate limit** (S-17) — 25:3448–3565.
- [ ] **T1.12 Delete `getCreator`'s hyphen-insensitive lookup** (S-18, B-M2) — 02:3499–3503.

### Performance and free-tier removal

- [ ] **T1.13 Remove KV write-back on reads** (FT-09, B-H2, P-2)
  * Files: `02_` (`getCreator` 02:3516–3522, `getCreatorList` 02:3868–3873), GET-path callers of `stampListVisibilityIfNeeded` (keep the in-memory stamp, drop the `put`).
  * AC: an op-counting KV wrapper in tests asserts **zero KV writes** for `/api/creator/lists`, `/api/creator/sync/meta`, `/api/creator/track-status`, `/lists/{u}/{s}.json`, catalog requests for published lists.
- [ ] **T1.14 Stop per-request `lastgood:` and `apiuse` writes** (FT-45, P-3, P-4)
  * Files: `25_` 25:1022–1027 (write only when the content hash changed, stored in the value), `05_` `trackSharedApiUse` (sample 1-in-N or remove until Analytics Engine exists).
  * AC: repeated identical catalog requests perform no KV writes.
- [ ] **T1.15 Paid defaults** (FT-01, FT-02, FT-03, FT-32)
  * Files: `00_constants.js`: `BULK_RESOLVE_SUBREQUEST_BUDGET = 400`, `DETAILS_BATCH_SUBREQUEST_BUDGET = 600`, `MOST_WATCHED_MAX_LOOKUPS = 100`, `IMDB_ID_LOOKUP_MAX = 100`; delete the free-plan comment blocks; `wrangler.toml` `[vars]` budget block removed.
  * AC: tests for continuation still pass (the protocol remains until Phase 5).
- [ ] **T1.16 Remove cross-deployment `/api/resolve` fetch** (FT-25)
  * Files: `02_` (`isRemoteResolveOrigin`, `PRIVATE_HOST_SUFFIXES`), `25_` remote branch, `00_` `RESOLVE_PROXY_PER_MINUTE`, client origin handling in `24_`.
  * AC: `/api/resolve?config=…&url=https://other.example/…` makes no outbound request.
- [ ] **T1.17 Remove `enrichTrailers`** (FT-33) — `07_:375–377` and every call site in `06_`/`07_`.
- [ ] **T1.18 Remove the admin `creator:` KV sweep when D1 is bound** (B-M5, P-14) — `03_:1740–1744`.

### Copy and UX quick wins

- [ ] **T1.19 Remove self-hosting / free-plan copy** (FT-38)
  * Files: `README.md` (replace "Which Cloudflare plan…", "Self-Hosting…" with a hosted-product README + a short developer setup), `wrangler.toml` comments, `header.js`, `09_page-shell.js` title/meta/OG/JSON-LD, `24_` FAQ (24:3816) and the "Worker owner… KV namespace" message (24:2231–2240), `07_:3238` log line.
  * AC: `grep -i -E "self-host|free (plan|tier|worker|cloudflare)"` over sources returns only historical docs.
- [ ] **T1.20 Success messages are not error toasts** (F-M1)
  * Files: `16_` remove the `window.alert` override (16:1705–1713); convert the 124 `alert()` call sites to `showToast(msg, 'success'|'info'|'error')` by meaning.
  * AC: "Key copied", "restored successfully", "Webhook URL copied" show success styling (client test asserts toast type).
- [ ] **T1.21 Make the "out of date install link" banner real** (F-C1 interim)
  * Files: `24_` implement `checkUnsavedInstallLink()` (compare `computeConfigStateHash()` with `lastGeneratedConfigHash` persisted per install) and `updateInstallLinkFromBanner()` (calls `generate()` and scrolls to the result).
  * AC: changing a setting after generating shows the banner; clicking it regenerates.
- [ ] **T1.22 Letterboxd URLs route to the importer** (F-C3, B-M22)
  * Files: `04_` `detectSource` (return `letterboxd`), `25_` `/api/preview` (400 with a helpful message), `16_` Add Catalog placeholder and handler (open Import with instructions).
- [ ] **T1.23 Default new lists and channels to Private** (F-H5)
  * Files: `09_` (`createListModalPublic` unchecked), `20_` channel builder default.

### Telemetry for later decisions

- [ ] **T1.24 Usage counters** (MIGRATION_PLAN Phase 1)
  * Count: legacy unverified shelf resolutions (04:75–77), base64 config requests, bare-key config requests, legacy webhook `creator=&key=` usage, `/api/resolve` calls, catalog requests per source kind, `/{config}/configure` visits.
  * AC: visible on the admin dashboard with daily totals.

---

## Phase 2 — Backend architecture (behaviour-preserving port)

- [ ] **T2.1 Golden-master harness** — record status/headers/body for every route and the rendered pages against a fixed dataset (reuse `tests/harness.mjs`); store under `tests/golden/`. AC: re-running on the current Worker reproduces all masters.
- [ ] **T2.2 Repository scaffolding** — `package.json` (workspaces), TypeScript, ESLint (`no-use-before-define`, `no-restricted-globals: fetch` outside providers), Vitest, Prettier; `apps/api`, `apps/jobs`, `apps/web`, `packages/{domain,providers,storage,images,shared}`.
- [ ] **T2.3 Hono app skeleton** — middleware: request id, error boundary (port of 26:7269–7302), security headers (port of `withSecurityHeaders`, `isPrivateApiPath`, `isPublicCorsPath`), cache policy. AC: golden masters for `/`, `/manifest.json`, `/robots.txt` match.
- [ ] **T2.4 Port Stremio routes** (manifest, catalog, meta, subtitles, images) into `routes/stremio.ts` + `routes/images.ts`, calling the existing logic moved into modules. AC: golden masters match.
- [ ] **T2.5 Port public pages and directory routes.** AC: masters match.
- [ ] **T2.6 Port account/creator routes** (one PR per route group: identity, lists, sync, channels, likes, feedback, OAuth, provider proxies). AC: masters + existing tests pass.
- [ ] **T2.7 Port admin routes and the admin page** into `routes/admin/*` (admin HTML stays a template for now, moved to its own module).
- [ ] **T2.8 Extract the client from the template literal** — mechanical conversion of `09`–`24` to modules under `apps/web/src/legacy/`; `window.__APP_CONFIG__` replaces server interpolations; Vite build; Workers Static Assets; the shell HTML stays server-rendered only for per-request preamble data. AC: the existing client tests pass against the bundled output; page renders identically (screenshot diff at desktop and 375 px); hostile-render test passes.
- [ ] **T2.9 Delete the concatenation toolchain** — `worker_entry_combined.js`, `header.js`, `build.py`, `build.ps1`, `check_sync.py`, `extract_html.py`, `gen_map.py`, `FUNCTION-MAP.md`, `scope_check.mjs`, `render_check.js`, `html_checks.py` (after their checks exist as Vitest tests). AC: CI green without them.
- [ ] **T2.10 CI/CD** — lint, typecheck, tests, build, deploy to staging on merge, production on tag; environment-specific secrets; D1 migrations via `wrangler d1 migrations apply`. AC: a deploy cannot happen with failing tests or unapplied migrations.
- [ ] **T2.11 Remove runtime schema detection** (FT-26) once T2.10 guarantees migrations.
- [ ] **T2.12 Static assets** — `icon.png` (+192/512/maskable), fonts self-hosted or preconnected; remove `01_icon-asset.js` (FT-35) and runtime bundle extraction/memos (FT-34).

---

## Phase 3 — PostgreSQL, API v2, data cutover

### 3a Schema and repositories
- [ ] **T3.1 Provision** Postgres (staging + production), PITR, Hyperdrive bindings for both Workers, nightly logical backup to R2.
- [ ] **T3.2 Migrations tool** (node-pg-migrate or Drizzle Kit) with a ledger; `migrations/pg/0001_init.sql` implementing `NEXT_VERSION_ARCHITECTURE.md` §3.3 (accounts … admin_audit_log), including: FKs with `ON DELETE CASCADE`, unique `(owner_id, slug)` on lists, `list_items` PK `(list_id, media_id)`, `watch_events` hash-partitioned by `account_id` with unique `(account_id, client_event_id)`, generated `tsvector` + GIN on lists and channels, keyset indexes `(visibility, likes_count DESC, updated_at DESC, id)`.
- [ ] **T3.3 `packages/storage`** — Kysely over Hyperdrive; repositories: Accounts, Sessions, ProviderConnections (encrypt/decrypt with AES-GCM, `key_id`), Media, Episodes, Lists, ListItems, Likes, Follows, Hidden, Channels, AddonProfiles/Rows/Tokens, LegacyInstalls, WatchEvents, ShowProgress, StreamingEvents, Feedback, Jobs, AdminAudit. AC: repository tests against real Postgres in CI.
- [ ] **T3.4 `packages/domain`** — port and unit-test: visibility rules, slug allocation, username validation, dedupe (single implementation used by server and web), progress derivation (next episode, dismissals, airing removals, companions), channel lineup (rotation, story lock, multi-part glue) from `05_` 2475–3895.

### 3b Migration tooling
- [ ] **T3.5 Exporters** — D1 table export (skip `lists_fts`), KV bulk export via the Cloudflare API with prefix allowlist (see MIGRATION_PLAN §3b table).
- [ ] **T3.6 Transformer + loader** implementing every mapping/conflict rule in MIGRATION_PLAN §3b; idempotent upserts; media resolved from embedded ids/metadata only (no provider calls); secrets vaulted or dropped.
- [ ] **T3.7 Verification report** — counts per entity, per-account checksums, 200-account sampled field-level diff through old and new read APIs, conflicts and rejections listed. AC: report generated in CI from a fixture snapshot.
- [ ] **T3.8 Rehearsal ×3** on production snapshots; fix every unexplained difference.

### 3c API v2 (dark launch)
- [ ] **T3.9 OpenAPI spec** for `/api/v2/*` and a generated TypeScript client.
- [ ] **T3.10 Sessions** — `POST /api/v2/sessions` (username + key → session cookie `__Host-ml_session`, HttpOnly, Secure, SameSite=Lax), `GET/DELETE /api/v2/sessions` (device list, revoke, revoke all), CSRF protection for cookie-auth mutations (`Sec-Fetch-Site` + token).
- [ ] **T3.11 Resources** — accounts (profile, settings, delete, reset), lists (+items ops: add, remove, move, bulk replace for imports; `If-Match` versions), follows, hidden, channels (+items, share codes, publish), add-on profiles/rows/tokens, watch events (batch create, delete, clear), progress views (continue watching, airing next, history pages), directory, search, provider connections (connect/callback/disconnect/import-from-device), feedback.
- [ ] **T3.12 Stremio add-on-token routes** `/a1_{token}/manifest.json|catalog|meta|subtitles` served from Postgres with per-colo profile cache keyed by `profile.version`.
- [ ] **T3.13 Legacy resolver** `routes/legacy.ts` — `/{cfg12}/…`, bare ids, `/{base64}/…` from `legacy_installs`/decode; embedded `channel:v1:`/`customlist:v1:` parsed read-only; secrets from `legacy_installs.secrets_enc` used server-side only.
- [ ] **T3.14 Shadow reads** — sampled legacy catalog requests computed on both stacks; diffs logged; dashboard of diff rate. AC: < 0.5% with every diff class explained before cutover.

### 3d Cutover
- [ ] **T3.15 Maintenance flag** in the old Worker: website writes → friendly 503; cron paused; Stremio reads unaffected.
- [ ] **T3.16 Runbook** for the window (announce, freeze, delta migrate, verify gate, route switch, smoke tests, unfreeze) and **rollback** (route back; replay post-cutover writes via the reverse script). Rehearse rollback in staging.
- [ ] **T3.17 Execute cutover**; old stores read-only for 30 days.

### 3e Client transition
- [ ] **T3.18 "Move this device's data" screen** — detects local-only lists/channels/tokens, previews, uploads via v2, vaults tokens, clears secrets from `localStorage`. Never silent.
- [ ] **T3.19 Old SPA compatibility** — removed legacy endpoints return `409 {upgrade:true}`; the service worker forces an update.

---

## Phase 4 — Provider layer

- [ ] **T4.1 Provider client base** — `request(op)` with timeout (8 s default), retries with jitter on 429/5xx honouring `Retry-After`, circuit breaker, per-provider concurrency/budget, Analytics Engine metrics, log scrubbing (`api_key`, tokens).
- [ ] **T4.2 TMDB** — ops: find, details (movie/tv with appends), season, episode groups, search, discover, trending, collections, recommendations/similar, people, providers, lists (v4), account lists; use the v4 read token in a header; mappers to `NormalizedItem`.
- [ ] **T4.3 Trakt** — lists, watchlist, history (incremental), charts, search, list write ops; OAuth code + device with server client id; token from the vault; 401 → `needs_reconnect` (no silent public fallback).
- [ ] **T4.4 MDBList** — public list feed, top lists, watchlist (single confirmed endpoint), watched sync, list writes, OAuth PKCE.
- [ ] **T4.5 Simkl, TVmaze, Metahub, BetterPosters, JustWatch (flagged), RapidAPI** — same shape.
- [ ] **T4.6 Media resolver** — `NormalizedItem` → `media` upsert with id reconciliation (IMDb ↔ TMDB), `episodes` upsert; replaces `fetchTmdbDetails`, `fetchTmdbItemDetails`, `fetchStandardItemMeta`, season caches.
- [ ] **T4.7 Catalog source registry** — successor to `detectSource`/`fetchCatalog` with explicit kinds (incl. `letterboxd` → import hint); presentation passes (BetterPosters, badges, adult filter) as pure functions.
- [ ] **T4.8 Lint rule** forbidding `fetch()` outside `packages/providers` and `packages/storage` (R2/queues).
- [ ] **T4.9 Recorded-fixture tests** per op (success, 401, 404, 429, 5xx, timeout, malformed).

---

## Phase 5 — Jobs and caching

- [ ] **T5.1 Queues and DLQ** bindings (`provider-refresh`, `show-schedule`, `imports`, `posters`, `provider-sync`, `token-refresh`, `webhooks`, `rollups`, `channel-pools`).
- [ ] **T5.2 Schedules** (`apps/jobs/src/schedules.ts`): every 5 min enqueue due charts; every 15 min enqueue due series; hourly New on Streaming; daily rollups, token refresh, prune; all enqueue-only.
- [ ] **T5.3 Chart refresh consumer** → KV snapshot with SWR metadata; request path serves stale and enqueues.
- [ ] **T5.4 Show schedule consumer** → `episodes`, `series_schedule.next_refresh_at` (returning daily, ended monthly); maintain `tracked_by_count`.
- [ ] **T5.5 Progress** — on `watch_events` insert, upsert `show_progress`; Continue Watching/Airing Next views; parity tests against the legacy behaviour (dismissals, removals, companions, fully-watched).
- [ ] **T5.6 Webhooks and playback pings** enqueue (`webhooks`), respond immediately; consumer resolves ids via the media resolver and inserts events idempotently (`client_event_id` from payload hash).
- [ ] **T5.7 Imports** — `POST /api/v2/imports` (R2 upload URL) → job resolves titles cache-first through `media` → creates list → progress in `jobs`; UI polls `GET /api/v2/jobs/{id}`. Removes `/api/bulk-resolve` continuation (FT-01).
- [ ] **T5.8 Posters** — BetterPosters mirror to R2 with retries via delayed messages; badge artwork rendered once to R2 by content hash (replaces base64 SVG embedding).
- [ ] **T5.9 Channel pools / new episodes** — jobs keyed by channel id; lineup reads stored pools.
- [ ] **T5.10 Provider sync** — incremental Trakt/Simkl/MDBList history import per connection with `last_synced_at`.
- [ ] **T5.11 Token refresh** — refresh connections expiring within 7 days; mark `needs_reconnect` on failure; placeholder tile in affected Stremio rows.
- [ ] **T5.12 New on Streaming** — port sweeps to jobs with state in Postgres; RapidAPI monthly quota table; JustWatch behind a flag (S-19).
- [ ] **T5.13 Rollups** — `daily_title_counts` from watch events; Most Watched charts read rollups.
- [ ] **T5.14 Delete** `scheduled()` budget code, sweep cursors, pre-warm rotations and every `CRON_*`/`*_SUBREQUEST_BUDGET` constant (FT-03…FT-07).

---

## Phase 6 — Frontend and UX

- [ ] **T6.1 Design system** — tokens (from today's CSS variables), components: Button (primary/secondary/tertiary/danger), IconButton, Pill, Toggle, Select, Modal (focus trap, Escape, labelled), Toast (success/info/error + undo), Card, PosterGrid, Sortable (pointer events), EmptyState/ErrorState/Skeleton, Tabs. Storybook or equivalent.
- [ ] **T6.2 App shell** — routes `/discover`, `/library/*`, `/addon/*`, `/settings/*`; header search; sync indicator; four-item nav (bottom on mobile).
- [ ] **T6.3 Add-on destination** (first) — live rows with preview, reorder, edit, combine sources, add-on settings drawer (region, dedupe, filters, artwork, badges), install & devices (tokens with last used, revoke), legacy install panel for `/{config}/configure`.
- [ ] **T6.4 Library** — lists (owned/followed/connected with source filter), list page with inline add, share (private/unlisted/public), channels (builder with "Save & add to add-on"), watching (continue, up next, history with server paging, watchlist).
- [ ] **T6.5 Settings** — account & devices (sessions, passkeys, key re-display behind re-auth), connected services (status, last sync, reconnect), import & export hub (URL, file, backup, legacy link), help & feedback.
- [ ] **T6.6 Discover** — charts, curated, public lists and channels, creator pages, follow vs like; Quick Add merged in.
- [ ] **T6.7 Public pages** — server-rendered `/lists/{u}/{s}` and `/channels/{u}/{s}` (OG tags, paginated items, "Open in My Lists"), no app bundle.
- [ ] **T6.8 Remove legacy UI** per destination after parity sign-off; delete the corresponding legacy client modules.
- [ ] **T6.9 Playwright journeys** for the 12 scenarios (desktop + 375 px) and axe checks per destination.
- [ ] **T6.10 Bundle budget** — CI fails if initial JS > 200 KB gzip.

---

## Phase 7 — Security hardening

- [ ] **T7.1 Sessions everywhere** in the new SPA; body-credential routes deprecated (counter), removed after the published date.
- [ ] **T7.2 Passkeys** (WebAuthn) as login/second factor; key display requires re-auth.
- [ ] **T7.3 Vault complete** — refresh, upstream revoke on disconnect, encryption key rotation procedure (`key_id`), audit of all token reads.
- [ ] **T7.4 Admin** behind Cloudflare Access (or admin accounts + passkeys), server-side admin sessions, `admin_audit_log` for key resets, deletions, moderation, migrations.
- [ ] **T7.5 Rate limiting** via WAF rules and the rate-limit binding on: sessions/login, recovery, forgot-username, anonymous writes (shares, feedback, installs), provider-proxy endpoints; delete `consumeRateLimit` and inline copies (FT-30).
- [ ] **T7.6 CSP** — nonce-based `script-src`, no inline handlers, narrowed `connect-src`/`img-src`, Trusted Types; report-only for two weeks, then enforce.
- [ ] **T7.7 Legacy sunsets** — webhook `creator=&key=` (S-11) with notices then removal; `LEGACY_UNVERIFIED_CONFIG_SHELVES` decision executed (S-12).
- [ ] **T7.8 Logging policy** — structured logs; scrubbing of `api_key`, `access_token`, `Authorization`, account keys; hashed IPs.
- [ ] **T7.9 Like voter ids** — HMAC with a server pepper for anonymous voters (S-15).
- [ ] **T7.10 Security tests** — authz matrix per route; CSRF; session revocation; vault round-trip; rate limits; hostile-input render.

---

## Phase 8 — Performance

- [ ] **T8.1 Budgets** from `PERFORMANCE_AUDIT.md` §4 wired to Analytics Engine timings and alerts.
- [ ] **T8.2 Edge caching** — add-on profile per colo by version; directory first pages 60 s; shared catalog pages; manifests by profile version.
- [ ] **T8.3 Dedupe once per profile version** (cached), recommendations from snapshots.
- [ ] **T8.4 Op-count assertions** in integration tests: GET routes perform zero writes; catalog requests perform ≤ 1 DB query per personal row.
- [ ] **T8.5 k6 load tests** in staging (catalog mix, webhook bursts, directory/search at 1M synthetic lists, 100k accounts × 2k events).
- [ ] **T8.6 RUM** web-vitals beacon to Analytics Engine.

---

## Phase 9 — Testing completion

- [ ] **T9.1 Replace source-text assertions** in `worker.test.mjs` (40 `readFileSync` uses) with behavioural tests.
- [ ] **T9.2 Stremio contract suite** for every source kind (manifest, catalog paging/search, meta, subtitles ping).
- [ ] **T9.3 Legacy compatibility suite** (golden masters for `/{cfg}/…`, base64, `/lists/{u}/{s}.json`, `/channel/{code}`, backup formats 1.x/2.0/3.0).
- [ ] **T9.4 Migration tests** per mapping rule with anonymized fixtures; idempotency; verification report.
- [ ] **T9.5 Provider fixture suites** (Phase 4) and job suites (Phase 5) in CI.
- [ ] **T9.6 E2E** — the 12 scenarios; OAuth with mocked providers; device revoke; import job progress.
- [ ] **T9.7 Wire the useful `audit/**` probes** into the suites or delete them.

---

## Phase 10 — Decommission

- [ ] **T10.1 Archive** D1 and KV (encrypted, R2) after the 30-day read-only window and a final verification.
- [ ] **T10.2 Delete** D1 database, KV non-cache prefixes, migration endpoints and hot-path shape migrations (FT-28, FT-29), `STORAGE-PLAN-KV-D1.md` marked superseded.
- [ ] **T10.3 Legacy review** with counters: keep install-link, base64, public-list and channel-code compatibility indefinitely; remove sunset surfaces on their published dates.
- [ ] **T10.4 Runbooks** — deploy, rollback, PITR restore, encryption key rotation, provider outage, queue backlog; on-call alerts documented.

---

## Definition of done for the program

* No user-authored data is read from KV; the browser holds no secrets; every install link from before the migration still works.
* Adding a row, changing a setting or editing a list/channel reaches Stremio without a new install link.
* One scrobble = one insert; new episodes reach every watcher within 24 h without per-account sweeps.
* Directory and search p95 < 150 ms at 1M public lists; initial web JS ≤ 200 KB gzip.
* Every route has an authz test; every provider op has fixture tests; migrations are applied only by CI.
