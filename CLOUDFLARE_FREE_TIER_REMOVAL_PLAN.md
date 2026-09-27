# Cloudflare Free-Tier and Self-Hosting Removal Plan

**Date:** 2026-09-25 · **Status:** plan only; no code changed.

**Scope.** Every piece of code, configuration and documentation that exists mainly because of any of these:

- Cloudflare Workers **Free** limits: 50 subrequests, 10 ms CPU, 1,000 KV writes/day, the old 1,000 storage operations/invocation.
- D1 or KV being **optional**, which was a self-hosting concession.
- **Self-hosting / multi-deployment**: sibling deployments, "Worker owner" messaging, running off Cloudflare.

**Deployment constraint kept:** the Worker is still deployed by pasting `worker_entry_combined.js` into the dashboard (see NEXT_VERSION_ARCHITECTURE §0.1). Nothing below requires Wrangler to deploy the Worker.

**Classes:**

- **A — REMOVE:** delete the code.
- **B — REWRITE:** keep the feature, change the implementation.
- **C — KEEP:** still correct on the paid, hosted architecture.
- **D — INVESTIGATE:** the reason is unclear or needs data before deciding.

**Size of the problem (counted in `00_`–`26_`):**

| Pattern | Occurrences |
|---|---|
| `!env.CONFIGS` / "no KV" guards | 110 |
| `env.DB` optional branches | 97 |
| `"no-kv"` responses | 26 |
| "subrequest" mentions | 49 |
| Free-plan mentions | 28 |
| "self-host" mentions | 23 |
| "Worker owner" strings, many user-visible | 29 |
| KV-fallback comments | 15 |
| "sibling / another deployment" logic or comments | 41 |

README: 16 free-plan mentions and 11 subrequest mentions, including the sections "Which Cloudflare plan do I need?" and "Self-Hosting: Installation & Deployment".

> **Correction to the code's own premise.** Many comments justify caps with "1,000 KV/D1 storage operations per invocation, the same on Free and Paid". Cloudflare's current limits page (checked 2026-09-25) is different:
> - KV operations count toward the **subrequest** limit, which is **10,000 on Paid**.
> - D1 allows **1,000 queries per invocation on Paid**.
>
> Several "bound to 1,000" caps below therefore protect against a limit that no longer applies in that form.

---

## Summary table

| ID | Item | Class | Difficulty | Phase |
|---|---|---|---|---|
| FT-01 | `BULK_RESOLVE_SUBREQUEST_BUDGET` and the continuation protocol | A (knob) / B (import) | Med | 1 → 5 |
| FT-02 | `DETAILS_BATCH_SUBREQUEST_BUDGET`, the reservation meter, `remainingIds`, client round loops | A | Low → Med | 1 → 5 |
| FT-03 | `CRON_SUBREQUEST_BUDGET` and the share arithmetic in `scheduled()` | A | Low | 1 |
| FT-04 | wrangler `[vars]` budgets; README plan and self-host sections | A | Low | 1 |
| FT-05 | `MOST_WATCHED_MAX_LOOKUPS` (fits "free 50") | A | Low | 1 |
| FT-06 | `IMDB_ID_LOOKUP_MAX` (fits "free 50") | B | Low | 1 / 4 |
| FT-07 | KV-only fallback branches for every D1-backed feature | A | Med | 2 |
| FT-08 | D1-optional branches, `D1_SCHEMA_MANIFEST` fallbacks, `checkD1Schema` cron, column probe | A / B | Med | 1 / 2 |
| FT-09 | Base64 self-contained install config ("no-kv" fallback) | A (write) / C (legacy read) | Low | 1 |
| FT-10 | `/api/resolve` cross-deployment "sibling" proxy | A | Low | 1 |
| FT-11 | Self-host copy: "Worker owner" strings, `header.js`, "Self-Hosted" title | A | Low | 1 |
| FT-12 | Fail-open when `CF-Connecting-IP` is missing (for self-hosters off Cloudflare) | B | Low | 1 |
| FT-13 | KV rate limiter plus 8 inline copies | B | Med | 3 / 7 |
| FT-14 | `authfail` KV fallback | A | Low | 2 |
| FT-15 | KV counters, `stats:creator_count`, genre/decade blob, one-time KV migrations | A | Med | 2 |
| FT-16 | Admin KV→D1 migration tools | D (then A) | Low | 10 |
| FT-17 | Paging caps justified by "1,000 ops/invocation" | B | Med | 3 |
| FT-18 | Cron cursor slicing (Continue Watching, Airing Next, presets, posters, backfill) | B | High | 5 |
| FT-19 | Six-minute chart prewarm into KV plus per-colo edge cache | B | Med | 5 |
| FT-20 | RapidAPI monthly quota ledger | C (logic) / B (plumbing) | Low | 5 |
| FT-21 | MDBList hourly warm gate (1,000/day key quota) | C | — | — |
| FT-22 | PBKDF2 memo as a CPU saver (free 10 ms) | B | Med | 3 / 7 |
| FT-23 | Runtime HTML split / page memos (`splitAppBundle`, `SPLIT_PAGE_MEMO`) | B | Med | 6 |
| FT-24 | Three-tier circuit-breaker cache (isolate → KV → edge) | B | Med | 4 |
| FT-25 | `lastgood:` KV write on every catalog load | A | Low | 2 |
| FT-26 | Tombstones and reset / behind / queue markers (KV eventual consistency plus local-first) | A | High | 3 → 10 |
| FT-27 | `getCreator` / `getCreatorList` read-repair and KV write-through | A | Med | 2 |
| FT-28 | Likes KV ledger and `LIKE_VOTER_CAP = 5000` | B | Med | 3 |
| FT-29 | Channel directory single KV key; shared channels as 4 MB KV values | B | Med | 3 |
| FT-30 | BetterPosters image bytes in KV plus retry/variant keys | B | Med | 5 |
| FT-31 | `CF-Connecting-IP` as the client identity | C | — | — |
| FT-32 | `CREATOR_LIST_BYTES_MAX` (D1 2 MB row, `items_json` blob) | B | High | 3 |
| FT-33 | `SHARED_CHANNEL_BYTES_MAX` / `PUBLIC_CHANNEL_INDEX_MAX` | B | Med | 3 |
| FT-34 | Channel and custom-list payloads embedded in `entry.url`; `/api/preview` POST for URL length | B | High | 3 / 6 |
| FT-35 | In-request sleeps (`pauseMs`, Trakt 429 sleeps, OAuth retry delays) | B | Low | 4 / 5 |
| FT-36 | Browser-side computation that offloads server work (Airing Next, recs, channel traversal) | D → B | High | 5 / 6 |
| FT-37 | `LEGACY_UNVERIFIED_CONFIG_SHELVES = true` | D | Low | 7 |
| FT-38 | `wrangler.toml` as documentation of a paste-deployed Worker | B | Low | 1 |
| FT-39 | Service worker offline shell | C | — | — |
| FT-40 | `caches.default` usage | C (L1) / A (as prewarm target) | Low | 5 |
| FT-41 | `stremioAddonsConfig` signature hard-coded (self-host provenance note) | C | — | — |
| FT-42 | Admin "Last Active" KV backfill (`backfillCreatorLastActive`) | A | Low | 2 |
| FT-43 | `render_check` / `html_checks` / `scope_check` tooling | B (code organization, not free tier) | Med | 6 |

Items marked D need the data described in the item before they are decided.

---

## A. Budget knobs and continuation protocols

### FT-01 — `BULK_RESOLVE_SUBREQUEST_BUDGET` and the bulk-resolve continuation protocol

**Class:** A (budget) and B (the import feature).

- **Where:**
  - `00_constants.js:134-175`: `BULK_RESOLVE_ITEMS_MAX=200`, `BULK_RESOLVE_SUBREQUEST_BUDGET=48`, `BULK_RESOLVE_ITEMS_PER_MINUTE=4000`.
  - `26_api-creator-and-admin-routes.js:7129-7260`: `/api/bulk-resolve`, budget read at 7175-7177, `nextIndex`/`done` in the response.
  - `18_client-copy-and-trakt-export.js:956-1010`: client chunk-and-re-post loop, `CHUNK = ${BULK_RESOLVE_ITEMS_MAX}`.
  - `wrangler.toml [vars] BULK_RESOLVE_SUBREQUEST_BUDGET="400"`.
- **What it does:** resolves Letterboxd/CSV titles to IMDb ids with 2 TMDB calls per title (search, then `external_ids`), stopping after 48 fetches. The browser re-posts the remainder until it's done.
- **Why it exists:** a 200-title import measured about 400 fetches, against 50 on Free.
- **Limitation designed around:** 50 subrequests per invocation (Free).
- **Current problem:**
  - The browser must stay open for the whole import. A closed tab silently loses progress.
  - Paid deployments default to 48 unless the dashboard variable is set, and the paste deploy ignores `wrangler.toml`.
  - Matching is "first TMDB search hit plus year", with no user review.
  - The budget and rate-limit arithmetic is duplicated between client and server.
- **Replacement:**
  1. Upload the file (or send its parsed rows) to `POST /api/imports`.
  2. The server creates a `jobs` row and a `JOBS` queue message.
  3. The consumer resolves titles in batches (TMDB `/search` with year; the `media` table caches each result permanently) and records unmatched rows.
  4. The UI polls `GET /api/imports/:id` for progress and shows a review step for ambiguous matches.
  5. Delete `BULK_RESOLVE_SUBREQUEST_BUDGET`, `nextIndex`/`done` and the client loop.
- **Dependencies:** `18_` import UI, `/api/bulk-resolve`, README, `tests/*` bulk-resolve tests.
- **Difficulty:** Medium (new job and review UI).
- **Risk:** Low. Keep `/api/bulk-resolve` responding without the budget (full batch) for one release for cached clients.

### FT-02 — `DETAILS_BATCH_SUBREQUEST_BUDGET` and the reservation meter

**Class:** A.

- **Where:**
  - `00_constants.js:177-213`: `TMDB_ITEM_DETAILS_MAX_FETCHES=8`, `DETAILS_BATCH_SUBREQUEST_BUDGET=48`, `DETAILS_BATCH_IDS_PER_MINUTE(_OWN_KEY)`, `DETAILS_BATCH_MAX_ROUNDS=8`.
  - `25_api-catalog-routes.js:7328-7437`: worker pool, per-id `meter`, `pool.reserved`, `remainingIds`, `done`.
  - The `meter.spent` plumbing through `fetchTmdbItemDetailsUncached` (`07_`).
  - Client loops at `21_client-custom-list-builder.js:3455-3480` and `:3690-3725`.
  - `20_client-channel-builder.js:9631-9700`.
  - `wrangler.toml DETAILS_BATCH_SUBREQUEST_BUDGET="600"`.
- **What it does:** caps cold TMDB lookups per `/api/details/batch` call and hands back the ids it didn't reach. The browser re-posts up to 8 rounds.
- **Why it exists:** a 60-id cold batch measured 180 fetches.
- **Limitation designed around:** 50 subrequests (Free).
- **Current problem:**
  - The meter is threaded through the TMDB details code.
  - Airing Next is computed in each browser, 60 shows per refresh, per device.
  - The client must loop.
- **Replacement:**
  - Phase 1: delete the budget. The endpoint resolves all ≤ 60 ids with a concurrency of 6 and a 10 s timeout per call.
  - Phase 5: Airing Next and Continue Watching come from `show_schedule` (server, shared), so the main caller disappears.
  - Keep `/api/details/batch` as a plain batch lookup for UI detail panes, served from `media` / `show_schedule` first.
- **Dependencies:** `21_` `refreshAiringNext`, `20_` channel builder, `fetchTmdbItemDetails` signatures, `07_` `rebuildAiringNextForRecord` (uses `TMDB_ITEM_DETAILS_MAX_FETCHES` at 4604-4682).
- **Difficulty:** Low (Phase 1 deletion), Medium (Phase 5 replacement).
- **Risk:** Low. The client already treats a missing `done` as done.

### FT-03 — `CRON_SUBREQUEST_BUDGET` and the tick share arithmetic

**Class:** A.

- **Where:**
  - `00_constants.js:215-281`: `CRON_SUBREQUEST_BUDGET=10000`, `CRON_EPISODE_CHECK_FETCHES=2`, `CRON_CHART_WARM_FETCHES=105`, `CRON_EPISODE_CHECK_MAX=150`, `CRON_EPISODE_CHECK_SHARE=0.5`.
  - `CRON_NEW_ON_STREAMING_SHARE` (:444), `CRON_AIRING_NEXT_SHARE` (:1228), `CRON_BETTER_POSTER_SHARE` (:1265).
  - `26_api-creator-and-admin-routes.js:7308-7431`: `scheduled()` reserve arithmetic.
  - `07_:4779-4782` (`checkForNewEpisodes`), `07_:5226-5240` (`prewarmSharedCatalogs` "skipped" branch).
- **What it does:** splits one tick's fetch budget between the episode sweep, New on Streaming, Airing Next, BetterPosters and chart pre-warm, chained so the "user-visible" half lands first.
- **Why it exists:** a tick measured 186 fetches against 50. On Free the invocation was terminated.
- **Limitation designed around:** 50 subrequests and 10 ms CPU (Free).
- **Current problem:**
  - About 150 lines of arithmetic with fractions that "add to 0.75".
  - Four sweeps compete for one 30 s CPU window every 6 minutes.
  - The work belongs in queue jobs anyway.
- **Replacement:** `scheduled()` becomes a dispatcher that enqueues due jobs (NEXT_VERSION_ARCHITECTURE §5). Each job type has its own natural batch size. Delete every `CRON_*_SHARE` / `_FETCHES` / `_BUDGET` constant.
  - Interim (Phase 1): drop the env override and shares; call the tasks with no budget, since the paid limit is 10,000.
- **Dependencies:** every cron task signature (`fetchBudget` parameter), `tests/*` cron tests, `wrangler.toml`, README.
- **Difficulty:** Low for the interim step; the full move is covered by FT-18.
- **Risk:** Low.

### FT-04 — `wrangler.toml [vars]` budgets and README plan / self-host documentation

**Class:** A.

- **Where:**
  - `wrangler.toml:33-79`: plan tuning comments and three vars.
  - README: "Which Cloudflare plan do I need?" (125-202), "The three subrequest budgets" (167+), "Self-Hosting: Installation & Deployment" (203-395), New on Streaming free-plan note (356).
  - `header.js`, which says "stateless… no database, no server-side auth… Deploy with `wrangler deploy`".
- **What it does:** tells self-hosters how to fit the Free plan.
- **Why it exists:** supporting self-hosting and Free.
- **Limitation designed around:** Free plan.
- **Current problem:** it is wrong for the product direction, and several statements are now false (header.js; "D1 optional").
- **Replacement:**
  - README becomes a user-facing product page plus a short `docs/OPERATIONS.md` for the owner: dashboard bindings, secrets, cron schedules, migrations, backups, runbooks.
  - `header.js` becomes "GENERATED — do not edit; built from src/ by `npm run build`".
- **Dependencies:** `build.py` / `build.ps1` header, CI drift check.
- **Difficulty:** Low. **Risk:** None.

### FT-05 — `MOST_WATCHED_MAX_LOOKUPS = 20`

**Class:** A.

- **Where:** `00_constants.js:467-473`; `07_source-fetchers-tmdb-simkl.js:3222` (`buildMostWatchedMetas`).
- **What it does:** caps the TMDB lookups used to name and poster Most Watched titles, "so it fits a free-plan request's 50-fetch allowance".
- **Limitation designed around:** 50 subrequests.
- **Current problem:** titles beyond 20 lookups may show without poster or name. The chart is rebuilt on request.
- **Replacement:** titles come from the `media` table (persisted when the scrobble was recorded). The chart is built from the `title_daily_stats` rollup by the hourly job and stored as a snapshot.
- **Difficulty:** Low. **Risk:** None.

### FT-06 — `IMDB_ID_LOOKUP_MAX = 24`

**Class:** B.

- **Where:** `00_constants.js:1160-1164`; `25_api-catalog-routes.js:2783-2830` (`/api/imdb-ids`, :2790).
- **What it does:** caps TMDB→IMDb translations per call "to stay well inside the 50 a free Workers plan allows".
- **Limitation designed around:** 50 subrequests.
- **Current problem:** callers must chunk. The results aren't persisted.
- **Replacement:** `media-resolver` batch resolve (≤ 100 ids), persisted in `media`. Most ids resolve with no provider call after the first time.
- **Difficulty:** Low. **Risk:** Low.

---

## B. "D1 optional / KV optional / self-hosted" branches

### FT-07 — KV-only fallback branches for D1-backed features

**Class:** A.

- **Where (non-exhaustive; 110 `!env.CONFIGS` guards plus the KV-scan fallbacks):**
  - `getPublicListIndex` KV scan (`02_:2711-2776`).
  - `/lists/public.json` cold-index scan (`25_:571-636`).
  - `computeCatalogAndCommunityLeaderboards` KV branch (`03_:1136-1200`).
  - `readStatTotalsByPrefix` KV scan (`03_:1461-1473`).
  - `loadStatsByDay` KV scan (`03_:1520-1531`).
  - The `bumpStat` / `bumpStatBy` / `recordTrackedEvent` / `computeLeaderboard` / `computeSearchLeaderboard` KV paths (`03_`).
  - `evtdayindex:*` and `searchquerydayindex:*`.
  - `readLikeVotersFromKv` (`02_:1820`).
  - The feedback KV scans.
  - `usernameForScrobbleToken` KV path.
  - `readCreatorShareFlags` KV path.
  - `readCreatorListDeletions` KV path.
- **What it does:** keeps every feature working on a deployment with no D1.
- **Why it exists:** D1 used to be optional for self-hosters, and Free KV-only deployments were supported.
- **Limitation designed around:** self-hosting; D1 availability on Free.
- **Current problem:**
  - Doubles every read path.
  - The fallback also runs when D1 *succeeds but returns zero rows* ("not migrated yet"). That makes a genuinely empty D1 result indistinguishable from "look in KV". `readLikeVoters` falls back to KV whenever `list_likes` has no rows, so a list whose last like was removed can revive stale KV voters.
- **Replacement:** D1 is required and authoritative. Run a one-time backfill job (MIGRATION_PLAN §3), then delete these branches. KV is read only through `kv-cache.js`.
- **Dependencies:** admin panels, directory, likes, counters, tests that assert the KV-only behavior.
- **Difficulty:** Medium (volume of code).
- **Risk:** Medium. It needs the backfill to have converged. Verify with a reconciliation report before deleting (MIGRATION_PLAN step 2.4).

### FT-08 — D1-optional branches and schema-probing

**Class:** A / B.

- **Where:**
  - 97 `env.DB` conditionals.
  - `D1_SCHEMA_MANIFEST` (`00_:872-1054`) and its "falls back to KV" consequences.
  - `checkD1Schema` (`02_:4023`) run on **every cron tick** (`26_`).
  - `/admin/api/schema-status` (`26_:5836`).
  - `d1HasAiringRemovalColumns` (`02_:4123-4139`), which probes `sqlite_master` before each tracking write until the column exists.
- **What it does:** tolerates an operator who deployed the Worker without running migrations.
- **Why it exists:** self-hosters paste code and may skip the SQL.
- **Limitation designed around:** self-hosting (no controlled deploy pipeline).
- **Current problem:** every write path carries two statement shapes. Schema drift is detected at runtime instead of prevented.
- **Replacement:**
  - A `schema_migrations` table.
  - Migrations applied by CI (`wrangler d1 migrations apply --remote`) or by the owner in the console **before** pasting a Worker version.
  - The Worker checks one row (`SELECT max(version)`) at cold start and returns 503 on `/api/*` if it is behind (fail loudly), rather than silently degrading.
  - Keep a slim `/admin/api/health` that shows schema version, binding presence and queue depth.
- **Dependencies:** admin schema tab, cron, tests (`D1_SCHEMA_MANIFEST` drift test).
- **Difficulty:** Medium. **Risk:** Low.

### FT-09 — Base64 self-contained install config

**Class:** A (write path) / C (legacy read).

- **Where:**
  - `decodeConfig` (`02_:347-435`).
  - Client `buildConfig` (`23_client-list-management.js:296-330`).
  - `generate()` fallback when `/api/save` fails or returns `no-kv` (`24_client-backup-restore-presets.js:2224-2240`, including the message "If you're the Worker owner, binding a KV namespace named CONFIGS fixes this").
  - `resolveConfig` final fallback (`04_:155`).
- **What it does:** encodes the entire config (rows, provider keys, **OAuth access tokens and the Creator Key**) into the install URL when KV isn't available.
- **Why it exists:** KV was optional.
- **Limitation designed around:** self-hosting without KV.
- **Current problem:**
  - Secrets end up in URLs, which get pasted into apps, logged and shared.
  - It also triggers on any transient `/api/save` failure, silently producing a secret-bearing link.
- **Replacement:**
  - Never *generate* base64 configs.
  - Keep `decodeConfig` read-only for URLs already installed. It maps into a transient, anonymous, read-only install (no personal shelves, no tokens honored after the cutoff date; see MIGRATION_PLAN §3.3).
  - If saving fails, show an error and retry.
- **Dependencies:** `generate()`, "Import link" in Presets & Backup, tests.
- **Difficulty:** Low. **Risk:** Low for writes. For reads, existing base64 installs keep working for public sources.

### FT-10 — `/api/resolve` cross-deployment "sibling" proxy

**Class:** A.

- **Where:**
  - `25_api-catalog-routes.js:6870-6908`.
  - `isRemoteResolveOrigin` and `PRIVATE_HOST_SUFFIXES` (`02_:2536-2589`).
  - `RESOLVE_PROXY_PER_MINUTE` (`00_:785-802`).
  - Client `resolveInstallLinkData` explicit-origin path (`24_`).
- **What it does:** when a pasted install link's id isn't found locally, it fetches `/api/resolve` from *another deployment's origin* and returns that deployment's tokens.
- **Why it exists:** multi-deployment self-hosting ("one deployment can read an install link minted by a sibling").
- **Limitation designed around:** self-hosting.
- **Current problem:** an outbound-request reflector with SSRF guards to maintain. It also imports OAuth tokens from a third-party origin into this app.
- **Replacement:** delete it. Only mylistsaddon.com links are importable.
- **Difficulty:** Low. **Risk:** None for hosted users.

### FT-11 — Self-host copy and branding

**Class:** A.

- **Where:**
  - 29 "Worker owner" strings. Examples: the `fetchTopLists` error "the Worker owner needs to set MDBLIST_POPULAR_KEY" (`04_:421`), the `searchTraktLists` error (`04_:471`), the Trakt OAuth "isn't configured on this Worker (missing TRAKT_CLIENT_ID)" (`25_:3292`), `24_:2233`, the guide FAQ ("If you self-host…").
  - The page `<title>`: "My Lists — Self-Hosted Stremio Catalogs from MDBList, Trakt, TMDB & Simkl" (seen in the running app).
  - `header.js`.
  - `?debug=1` OAuth diagnostics pages (`25_:3306`, `:3582`).
- **Current problem:** users see operator messages and misleading positioning.
- **Replacement:** user-facing copy ("Trakt is temporarily unavailable"). Operator detail goes to logs and `/admin/api/health`. Remove the `?debug=1` pages, or gate them behind the admin session.
- **Difficulty:** Low. **Risk:** None.

### FT-12 — Fail-open when `CF-Connecting-IP` is missing

**Class:** B.

- **Where:**
  - `authenticateCreator` (`26_:62-71`): "`ip` absent (running outside Cloudflare) means… the request is let through… failing closed here would break every self-hoster".
  - `/api/resolve` proxy comment (`25_:6887-6892`).
  - `clientIpKey` (`02_:1662`).
- **Why it exists:** self-hosters running the code off Cloudflare.
- **Current problem:** a bypass path that can't occur in hosted production, but still has to be reasoned about.
- **Replacement:** fail closed everywhere. In the new design, per-account and credential throttles don't depend on IP at all (D1 counters keyed by account or credential).
- **Difficulty:** Low. **Risk:** None on Cloudflare, where the header is always set.

### FT-13 — KV rate limiter plus 8 inline copies

**Class:** B.

- **Where:**
  - `consumeRateLimit` (`02_:1677-1708`).
  - Inline copies: `/api/save` (`25_:6961-6968`), `/api/creator/create` (`26_:1210-1229`), preview (`25_:~1184`), `track-search` (`25_:6358`), `track-event` (`25_:6389`), `creatorrestore`, `adminlogin`, `forgotusername`, `resetkeyrate`, `feedbackrate`.
- **What it does:** per-IP 60 s buckets in KV (read, then `put` via `waitUntil`).
- **Why it exists:** D1 was optional, and KV was the only guaranteed store.
- **Limitation designed around:** self-hosting / Free.
- **Current problem:**
  - Not atomic.
  - KV reads are edge-cached for up to 60 s, so bursts pass. The code comments admit this.
  - KV allows about 1 write/second per key.
  - Every limited request costs a KV write, billed on Paid.
- **Replacement:**
  - **Per-IP abuse limits:** Cloudflare WAF rate-limiting rules, configured in the dashboard, on the write and credential endpoints.
  - **Per-account and per-credential limits:** a D1 `rate_counters(scope, window_start, n)` table with an atomic upsert (the pattern `noteAuthFailure` already uses).
  - Delete the inline copies.
- **Dependencies:** every limited route, tests.
- **Difficulty:** Medium. **Risk:** Low. WAF rules can ship first as belt and braces.

### FT-14 — `authfail` KV fallback

**Class:** A.

- **Where:** `readAuthFailureCount` / `noteAuthFailure` (`02_:1710-1776`).
- **Why it exists:** D1 optional.
- **Current problem:** two stores for one counter.
- **Replacement:** D1 only (`rate_counters`).
- **Difficulty:** Low. **Risk:** None.

### FT-15 — KV counters and one-time KV data migrations

**Class:** A.

- **Where:**
  - `bumpStat` KV path (`03_:83-99`), `bumpStatBy` KV path (`03_:132-136`).
  - `bumpJsonCounterBlob` (`03_:161-198`), a single-key read-modify-write, "trades a wider collision surface for a large write-count cut" (free 1,000 writes/day).
  - `migrateGenreDecadeStatsIfNeeded` (`03_:215-278`), still called on every Audience-tab load.
  - `stats:creator_count` read-modify-write in `/api/creator/create` (`26_:1323-1327`).
  - `recordTrackedEvent` KV path, whose comments explain it was "the biggest consumer of the free plan's 1,000-writes-a-day budget" (`03_:509-596`).
- **Limitation designed around:** 1,000 KV writes/day (Free); D1 optional.
- **Current problem:** lost updates, dead migration code on a hot admin path, and `stats:creator_count` drifting from `SELECT COUNT(*) FROM accounts`.
- **Replacement:** Analytics Engine events plus D1 rollups (NEXT_VERSION_ARCHITECTURE §4.6). Creator count = `SELECT COUNT(*)`.
- **Difficulty:** Medium. **Risk:** Low. Historical counts are backfilled once from D1 `stats`.

### FT-16 — Admin KV→D1 migration tools

**Class:** D, then A.

- **Where:**
  - `/admin/api/migrate-d1` (`26_:5026-5482`) with `MIGRATE_D1_*` (`00_:543-588`) and the `migrated1:state` cursor.
  - `/admin/api/migrate-day-counts` (`26_:6253`, `migratedaycounts:state`).
  - `/admin/api/backfill-trending` (`26_:4922`, `backfilltrending:cursor`).
  - `/admin/api/rebuild-search-index` and `rebuild-public-index` (`26_:5483`).
- **What it does:** chunked, resumable backfills from KV into D1, each chunk bounded to about 700 operations "since a chunk that throws saves no progress".
- **Why it exists:** D1 was introduced after data lived in KV. Chunking was sized to the old 1,000-operation belief.
- **Investigate:** whether production has fully converged (every `creator:` / `creatorlist:` KV key has a D1 row with the same `updatedAt`). If so, remove after the v2 backfill; the v2 migration jobs replace them. If not, run them once more, then remove.
- **Difficulty:** Low. **Risk:** Low if the reconciliation report is clean.

### FT-17 — Paging caps justified by "1,000 storage ops per invocation"

**Class:** B.

- **Where:**
  - `CREATOR_LISTS_PAGE_DEFAULT/MAX`, `CREATOR_LISTS_MAX_PAGES`, `CREATOR_LIST_ITEMS_BATCH_MAX` (`00_:90-132`; server `26_:1753-2067`; client paging loop `22_:3916-4004`).
  - `ADMIN_LIST_DELETE_MAX` (`00_:679-686`; `26_:5779`, `:6231`; admin client loops at `03_:3027`, `:3279`).
  - `ADMIN_CREATOR_LIST_KV_SCAN_MAX` (`00_:742-756`; `26_:5674`).
  - `STAT_KEY_SCAN_CAP` / `STAT_TOTALS_READ_CAP` (`03_:1076-1077`).
  - `PUBLIC_INDEX_MAX_ROWS` (`00_:758-768`).
  - `LAST_ACTIVE_BACKFILL_BATCH` (`03_:338-384`).
  - The purge page cap (`02_:3086`, 50 pages).
  - `AIRING_NEXT_SWEEP_ACCOUNTS_PER_TICK = 3` (`00_:1240-1247`: "this, not the fetch budget, is what keeps one tick under the invocation's 1,000-operation cap").
- **Why it exists:** one KV `get` per list or key, against a believed 1,000-operation cap.
- **Current problem:** the reasoning is outdated (KV operations count toward 10,000 subrequests on Paid). The deeper issue is the one-`get`-per-record access pattern, which disappears with D1 `SELECT … LIMIT`.
- **Replacement:** keyset pagination (`WHERE id > ? ORDER BY id LIMIT 200`) chosen for **response size and UX**, not invocation limits. Admin bulk deletes become a job. Remove the KV scans entirely.
- **Difficulty:** Medium. **Risk:** Low.

### FT-18 — Cron cursor slicing

**Class:** B (rewrite as jobs and shared computation).

- **Where:**
  - `checkForNewEpisodes` (`07_:4765-5052`; `cron:continuewatching:cursor`; page 25; `SHOW_CHECK_BUDGET`).
  - `refreshAiringNextSweep` (`07_:4680-4763`; `cron:airingnext:cursor`).
  - `prewarmSharedCatalogs` (`07_:5218-5417`; `cron:prewarm:cursor`).
  - `prewarmChannelPresets` (`07_:2825`; `cron:channelpresets:cursor`).
  - `prewarmBetterPosters` (`07_:5149`; `cron:bpwarm:cursor`; `BETTER_POSTER_PREWARM_*`).
  - `bumpNewOnStreamingEpisodes` (`cron:newonstreaming:bumpcursor:`).
  - `backfilltrending:cursor`.
- **What it does:** processes a slice of accounts or items per 6-minute tick, resuming from a KV cursor (with a page-offset fix for starved accounts).
- **Why it exists:** Free subrequest and CPU limits, and the 1,000-operation belief.
- **Current problem:** **it doesn't scale.** At 100k accounts, the Continue Watching sweep (25 accounts per tick) needs about 4,000 ticks, roughly **17 days per account cycle**. Airing Next (3 per tick) needs about **139 days**. Both do per-user TMDB lookups for per-show facts, and both rewrite whole tracking blobs.
- **Replacement:**
  - A show-centric `show_schedule` refreshed per show by queue jobs.
  - Continue Watching and Airing Next computed at read time (NEXT_VERSION_ARCHITECTURE §5).
  - Presets and posters become queue jobs.
  - Delete every cursor key.
- **Dependencies:** tracking model (Phase 3/4), scrobble path, client Airing Next.
- **Difficulty:** High. **Risk:** Medium. Run the new computation in shadow and compare shelves for a sample of accounts before switching (MIGRATION_PLAN 5.3).

### FT-19 — Six-minute chart prewarm

**Class:** B.

- **Where:** `prewarmSharedCatalogs` (`07_:5218-5417`), `fetchWithPerUserCacheAndCircuitBreaker` edge tier (`02_:1400-1417`, `:1475-1488`).
- **What it does:** every 6 minutes it re-fetches about 40 charts (US region, first page only, `pauseMs` sleeps) into KV `cache:*` and `caches.default`.
- **Why it exists:** to keep charts hot so user requests stay inside provider and subrequest limits.
- **Current problem:**
  - `caches.default` is **per data center**, so the edge copy warmed by the cron is useless in every other colo.
  - Non-US regions and deeper pages are always cold.
  - 40 charts × 6-minute cadence is much more frequent than charts change.
- **Replacement:** an hourly `chart.refresh` job per (chart, region in use) writes `snap:chart:*` pages to KV. Catalog reads use stale-while-revalidate against the snapshot.
- **Difficulty:** Medium. **Risk:** Low.

### FT-20 — RapidAPI monthly quota ledger

**Class:** C (logic) / B (plumbing).

- **Where:** `RAPIDAPI_MONTHLY_*` (`00_:376-395`), `newOnStreamingTickBudget` (`07_:1623`), `getRapidApiMonthlyUsage` / `recordRapidApiUsage` (`07_:1317-1378`, KV `cron:rapidapi:usage`).
- **Why it exists:** a **provider** quota (1,000/month on RapidAPI Basic), not Cloudflare.
- **Keep** the budgeting logic. Move the ledger into D1 (atomic) and the sweep into a job.
- **Difficulty:** Low.

### FT-21 — MDBList hourly warm gate

**Class:** C.

- **Where:** `07_:5357-5416`, `cron:last_warmed:mdblist`.
- **Why it exists:** MDBList's 1,000 requests/day on the shared key. That is a provider limit, not a Cloudflare one.
- **Keep.** Move it into the chart job's per-provider schedule.

### FT-22 — PBKDF2 verification memo as a CPU saver

**Class:** B.

- **Where:**
  - `CREATOR_AUTH_MEMO` (`02_:539-621`).
  - `isCreatorAuthMemoized` plus the "charge the bucket only when not memoized" logic (`26_:40-71`).
  - `CREATOR_AUTH_VERIFY_PER_MINUTE` (`00_:691-707`).
- **What it does:** caches successful PBKDF2 verifications per isolate for 5 minutes, because every authenticated request re-sends the Creator Key.
- **Why it exists:** PBKDF2 costs about 15 ms of CPU; Free allows 10 ms per request. Requests carry the key because there are no sessions.
- **Current problem:**
  - A band-aid for a missing session layer.
  - Per-isolate only, so cold isolates still pay.
  - `invalidateCreatorAuthMemo()` clears the whole map on any purge.
- **Replacement:** sessions (SECURITY S-01). PBKDF2 runs once at login, with iterations raised to OWASP-recommended levels. Session lookups are one indexed D1 read, cached in memory for 60 s.
- **Difficulty:** Medium. **Risk:** Medium (auth change). See MIGRATION_PLAN Phase 7 for coexistence.

### FT-23 — Runtime HTML splitting and page memos

**Class:** B.

- **Where:** `BUILDER_PAGE_MEMO`, `BUILDER_ETAG_MEMO`, `APP_BUNDLE`, `APP_CSS`, `SPLIT_PAGE_MEMO`, `splitAppBundle`, `splitAppCss`, `pageWithExternalBundle`, `htmlPageResponse` (`02_:955-1199`).
- **What it does:** renders a roughly 2 MB HTML string in the isolate, then slices marker-delimited script and CSS out at runtime to serve them as `/app.js?v=` and `/app.css?v=`.
- **Why it exists:** the client lives inside a template literal, and there is no build step. The CPU and memory cost was tuned under Free constraints.
- **Replacement:** esbuild emits hashed JS and CSS at build time, embedded as constants in the single Worker file (NEXT_VERSION_ARCHITECTURE §7.3). The page shell is small, static and cacheable.
- **Difficulty:** Medium. **Risk:** Low.

### FT-24 — Three-tier circuit-breaker cache

**Class:** B.

- **Where:** `fetchWithPerUserCacheAndCircuitBreaker` / `fetchWithPerUserCacheUncoalesced` (`02_:1271-1519`), `PER_USER_CACHE_MAP` (1,000 entries), `IN_FLIGHT_FETCHES`, `safeUserHash`, 21 call sites.
- **What it does:** isolate Map, then KV `cache:`, then `caches.default`, then the provider. Serves stale on error, refuses empty overwrites and coalesces in-flight requests.
- **Why it exists:** to avoid provider calls and subrequests on Free, and to survive provider incidents.
- **Current problem:**
  - Three tiers with different staleness semantics.
  - Per-user data (keyed with a non-cryptographic hash of the token) is cached in KV, meaning personal provider data sits in a global store.
  - The edge tier is per-colo.
- **Replacement:** the provider layer (NEXT_VERSION_ARCHITECTURE §6.2):
  - shared data comes from snapshots;
  - per-user provider data uses an in-isolate cache with a short TTL only (or none);
  - in-flight coalescing is kept.
- **Difficulty:** Medium. **Risk:** Low.

### FT-25 — `lastgood:` KV write on every catalog load

**Class:** A.

- **Where:** `25_api-catalog-routes.js:1000-1027` (write), `:1039-1067` (read on error).
- **What it does:** stores the last successful first page of every non-personal row per config, with a 30-day TTL, **on every successful load**.
- **Why it exists:** graceful degradation without paid resources.
- **Current problem:** one KV write per catalog request. At about 10k installs × 20 rows × several app launches per day, that is millions of KV writes per day, and it adds write load to Stremio's hottest path.
- **Replacement:** snapshots are last-good by design. The materializer keeps the previous version until the new one succeeds.
- **Difficulty:** Low. **Risk:** None.

### FT-26 — Tombstones and eventual-consistency markers

**Class:** A (after server-authoritative sync).

- **Where:**
  - `creatordeleted:` plus `creator_tombstones` (`02_:2935-3006`).
  - `creatorlistdeleted:` plus `list_tombstones` (`02_:2087-2242`).
  - `creatorreset:` (90-day marker, `02_:3448-3469`, `CREATOR_RESET_TTL_SEC`).
  - `trackingd1behind:` (`02_:4196-4244`).
  - `creatorscrobblequeue:` (`26_:429-469`).
  - `airingnextchecked:`.
  - `pruneTombstones` cron.
  - The second purge pass (`02_:3290-3351`).
  - The pre-create purge (`26_:1275-1298`).
- **What it does:** prevents deleted accounts from authenticating from a stale KV colo, and stops other browsers from re-uploading deleted lists or reset accounts from their `localStorage`. Also marks D1 as behind KV, and works around KV propagation for scrobbles.
- **Why it exists:** KV eventual consistency, plus the local-first design in which the browser is authoritative. This is partly Free-driven (KV as the primary store) and partly a design choice.
- **Current problem:** a large amount of subtle code, with every new data type needing its own tombstone.
- **Replacement:**
  - D1-only authority.
  - Soft delete (`deleted_at`) with immediate session revocation.
  - A server-authoritative client that never re-uploads its cache.
  - Keep `list_tombstones` read-only during the legacy-client window (MIGRATION_PLAN §3.5), then delete.
- **Difficulty:** High (it depends on the client rewrite). **Risk:** Medium during coexistence.

### FT-27 — `getCreator` / `getCreatorList` read-repair and KV write-through

**Class:** A.

- **Where:**
  - `getCreator` (`02_:3471-3543`): writes KV `creator:` on **every** D1 hit. It is called on every authenticated request via `authenticateCreator`.
  - `getCreatorList` (`02_:3807-3889`): reads D1 **and** KV, merges fields by "fresher", takes `likes = max(D1, KV)`, repairs D1 fire-and-forget, and writes KV on every read.
  - `backfillCreatorRowInD1` (`02_:3723-3753`).
  - `rotateCreatorKeyHashInD1`'s "delete the D1 row so KV answers" compensation (`02_:3755-3805`).
- **Why it exists:** KV was the original store and D1 a later mirror. The Free plan made KV the only guaranteed store.
- **Current problem:**
  - A KV write per authenticated request and per list read.
  - Split-brain merging on the read path.
  - The dead hyphen-insensitive fallback query (BACKEND_AUDIT M-01).
- **Replacement:** D1 reads only. Optional short-TTL KV cache for **public** list pages, keyed by `(list, version)` and never merged.
- **Difficulty:** Medium. **Risk:** Medium. Depends on the FT-07 backfill convergence.

### FT-28 — Likes KV ledger and the 5,000-voter cap

**Class:** B.

- **Where:**
  - `LIKE_VOTER_CAP = 5000` (`02_:1625`).
  - `readLikeVoters` / `applyLikeVote` (`02_:1834-1960`).
  - `/api/lists/like` (`25_:7139-7250`), which re-reads and rewrites the **whole list record** in KV to update `likes`.
  - `/api/lists/like-external`, channel likes.
- **What it does:** reads the entire voter array (D1, else KV), writes it back to KV, seeds D1, inserts or deletes, counts, updates the likes columns, and verifies against KV for racing writers. Up to 3 attempts.
- **Why it exists:** KV-first storage; the cap bounds the KV value size.
- **Current problem:**
  - O(voters) work per like.
  - A hard ceiling of 5,000 likes per list.
  - KV's 1 write/second per key.
  - Contention with the owner's saves.
- **Replacement:** `INSERT OR IGNORE INTO likes` / `DELETE` plus `UPDATE lists SET like_count = like_count ± changes()` in one `batch`. No cap.
- **Difficulty:** Medium. **Risk:** Low. Backfill from `list_likes` and the KV ledgers (union, deduplicated).

### FT-29 — Channel directory and shared channels in KV

**Class:** B.

- **Where:**
  - `PUBLIC_CHANNEL_INDEX_KEY = "index:publicchannels"` with read-modify-write helpers (`02_:4897-4995`).
  - `channelshare:{code}` up to `SHARED_CHANNEL_BYTES_MAX = 4MB` (`00_:37-51`).
  - `/api/channel/*` (`26_:2457-2790`).
- **What it does:** keeps the whole directory (500 entries, with like and add counters) in one KV key, rewritten on every publish, like and add.
- **Why it exists:** D1 was optional, and a KV scan is expensive.
- **Current problem:**
  - Lost updates, which the code comments acknowledge.
  - The directory tops out at 500.
  - Counters live inside the index.
- **Replacement:** D1 `channels` plus `likes`; R2 for pools.
- **Difficulty:** Medium. **Risk:** Low.

### FT-30 — BetterPosters bytes in KV

**Class:** B.

- **Where:** `05_catalog-core.js:985-1410` (`bpimg:v1:`, `bp:retry:v1`, `bp:variants:v1`, `BETTER_POSTER_*`), `/bp/*` and `/api/bp/warm` (`25_:247-308`), `prewarmBetterPosters` (`07_:5149`), `bp:sharedids:v1`.
- **What it does:** caches third-party poster images as KV values, with single-key retry and variant lists, a request that waits up to 55 s for the upstream, and a cron that pre-fetches.
- **Why it exists:** R2 wasn't assumed, and the Free subrequest budget.
- **Current problem:** KV isn't a blob store (per-write cost, 25 MB values). The retry and variant keys are read-modify-write. A single request can stay open for up to 55 s.
- **Replacement:** R2 objects plus Cache API. On a miss, serve the plain poster and enqueue a `poster.fetch` job (non-blocking).
- **Difficulty:** Medium. **Risk:** Low.

### FT-31 — `CF-Connecting-IP` as client identity

**Class:** C.

- **Where:** `clientIpKey` (`02_:1627-1675`).
- **Keep.** On Cloudflare this is the correct header. Collapsing IPv6 to /64 is right.
- **Change:** anonymous like identities become `HMAC(secret, ip + target)` rather than an unkeyed SHA-256.

### FT-32 — `CREATOR_LIST_BYTES_MAX = 1.8 MB`

**Class:** B.

- **Where:** `00_:63-88`; `/api/creator/lists/save` (`26_:2226-2237`).
- **Why it exists:** a **D1** limit (2 MB row), because the list is mirrored as one `items_json` string. This is not a Free limit.
- **Replacement:** `list_items` rows. Keep an item cap (10,000) as a product limit.
- **Difficulty:** High (data model). **Risk:** Medium (backfill).

### FT-33 — `SHARED_CHANNEL_BYTES_MAX` / `PUBLIC_CHANNEL_INDEX_MAX`

**Class:** B.

Channels move to D1 plus R2 (FT-29). Keep a product cap on channel size (5,000 items); drop the 500-entry directory cap.

### FT-34 — Payloads embedded in `entry.url`

**Class:** B.

- **Where:**
  - `channel:v1:<JSON>` and `customlist:v1:<JSON>` (`parseChannelPayload` `05_:366`, `parseCustomListPayload` `05_:1531`).
  - Newline-merged URLs (`fetchCatalog` `05_:131-139`, `previewSourceUrls` `04_:365`).
  - `/api/preview` accepts POST "because a Channel's own url can be enormous" (`25_:1120-1126`).
  - `SAVED_CONFIG_BYTES_MAX = 10 MB` (`00_:61`).
- **Why it exists:** a stateless config with no server-side entities; KV was optional.
- **Current problem:** install configs carry entire episode lists (up to 10 MB). Previews need POST. Every config copy duplicates the data.
- **Replacement:** rows reference entities by id (`list:{publicId}`, `channel:{publicCode}`, `merged:[source refs]`). Legacy payloads are migrated into `channels` / `lists` on first read.
- **Difficulty:** High. **Risk:** Medium (legacy configs must keep resolving; see MIGRATION_PLAN §3.2).

### FT-35 — In-request sleeps

**Class:** B.

- **Where:**
  - `fetchTraktWithRetry` (`02_:1586-1596`, up to 3 s × 2).
  - Trakt OAuth token exchange with a `[0, 1000, 2000, 3000]` ms delay loop (`25_:3374-3389`).
  - Trakt device-code 429 sleep (`25_:3467-3480`).
  - Chart prewarm `pauseMs` (`07_:5250-5345`).
- **Why it exists:** pacing within tight budgets; provider 429s.
- **Replacement:** interactive requests get one bounded retry. Background work retries through the queue (with its retry delay) instead of sleeping.
- **Difficulty:** Low.

### FT-36 — Browser-side computation that offloads the server

**Class:** D, then B.

- **Where:**
  - Airing Next built in each browser (`refreshAiringNext`, `21_`) and pushed as a snapshot.
  - Recommendations built by the Discover tab and pushed (`persistCuratedRecommendations`, `22_`).
  - The channel builder walks TMDB seasons and episodes client-side through many proxy calls (`20_`, 37 `fetch` sites).
  - Continue Watching next-episode logic (`updateContinueWatching`, `21_`).
- **Investigate:** the comments give product reasons ("only the browser sees the whole picture") alongside cost reasons (subrequest budgets). Either way, per-device duplicated computation conflicts with server authority.
- **Replacement:** shelves and recommendations are computed server-side from shared data (Phase 5). The channel builder calls a server `channels/preview` job for large pools.
- **Difficulty:** High. **Risk:** Medium.

### FT-37 — `LEGACY_UNVERIFIED_CONFIG_SHELVES = true`

**Class:** D.

- **Where:** `00_:709-740`, `04_:64-77`.
- **What it does:** honors personal shelves in pre-SEC-001 configs that carry no ownership proof.
- **Not Free-tier.** It is a legacy-compatibility decision.
- **Investigate:** count how many active installs still depend on it (log in the legacy resolver), then flip it on a published date. In v2, legacy configs are migrated into owned installs only if the account proves ownership (MIGRATION_PLAN §3.2).

### FT-38 — `wrangler.toml` as documentation

**Class:** B.

- **Where:** `wrangler.toml`. It has a `compatibility_date` of **2024-01-01** and placeholder ids. The paste deploy never reads it (per the code's own comment at `00_:257-260`).
- **Replacement:**
  - Keep `wrangler.toml` accurate for local dev (`wrangler dev`) and for CI migrations.
  - Record the dashboard settings (bindings, compatibility date and flags, cron schedules, queue consumer) in `docs/OPERATIONS.md` with a checklist.
  - Raise the compatibility date deliberately, in the dashboard, with a test pass.

### FT-39 — Service worker offline shell

**Class:** C. Not a Free-tier artifact. Keep, and rebuild for the new asset names.

### FT-40 — `caches.default`

**Class:** C as a per-colo L1 for catalog pages and images. A as a prewarm target (FT-19).

### FT-41 — `stremioAddonsConfig` signature

**Class:** C. Hard-coded for mylistsaddon.com (`05_:85-88`). With hosting only, that is correct. Move it to a variable.

### FT-42 — Admin "Last Active" KV backfill

**Class:** A.

`backfillCreatorLastActive` / `creatorlastseen:` (`03_:338-384`). It exists because the D1 column was added late and to keep dashboard loads under the 1,000-op belief. Run once in migration, then delete.

### FT-43 — Render and scope-check tooling

**Class:** B. This one isn't Free-driven.

`render_check.js`, `html_checks.py`, `scope_check.mjs` and `extract_html.py` exist because the client lives inside a template literal and 27 files share one scope. Replace them with esbuild, ESLint and typecheck under the `src/` layout. Keep a small "render the shell with hostile input" test (the XSS preamble check is valuable).

---

## What remains Cloudflare-specific and correct

| Kept | Why |
|---|---|
| Workers (`fetch` / `scheduled` / `queue`), single pasted file | Deployment model chosen by the owner |
| D1 (with read replicas, FTS5) | Single authority |
| KV (cache only) | Global low-latency reads for snapshots |
| R2, Queues, Analytics Engine, Cache API | Right tool per concern |
| WAF rate-limiting rules | Cheapest abuse control |
| `CF-Connecting-IP` | Correct client IP on Cloudflare |
| `ctx.waitUntil` | For non-critical best-effort work only (metrics). Never for data writes. |

## Order of removal

1. **Phase 1 (safe deletions, no data model change):** FT-02 (budget part), FT-03 (interim), FT-04, FT-05, FT-09 (write path), FT-10, FT-11, FT-12, FT-25, FT-35 (interactive part), FT-38.
2. **Phase 2 / 3 (after the D1 backfill converges):** FT-07, FT-08, FT-13, FT-14, FT-15, FT-17, FT-22, FT-27, FT-28, FT-29, FT-32, FT-33, FT-34, FT-42.
3. **Phase 4 / 5:** FT-01 (import job), FT-06, FT-18, FT-19, FT-20, FT-24, FT-30, FT-36.
4. **Phase 10 (after legacy clients age out):** FT-16, FT-26, FT-37.
