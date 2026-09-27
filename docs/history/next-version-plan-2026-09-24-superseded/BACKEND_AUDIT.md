# Backend Audit — My Lists

**Date:** 2026-09-24 · **Method:** full read of the server modules (`00`–`08`, `25`, `26`) and the storage-relevant client paths; live run of the real Worker through the repo's harness (real SQLite D1, in-memory KV, stubbed upstreams); instrumented probes kept outside the repo (`opcount.mjs`, `fanout.mjs`, `skipcheck.mjs`); test suite run (1,212 tests: 1,211 pass, 1 skipped, 0 fail). **Nothing in the application was modified.**

Every finding is tagged **CONFIRMED** (reproduced by execution during this audit), **VERIFIED** (read in code, deterministic), or **LIKELY** (depends on scale or timing).

Major recommendations use the required shape: **Current → Problem → Proposed → Benefit → Risk.**

Contents: §1 Critical · §2 High · §3 Medium · §4 Low · §5 Cleanup · §6 Storage audit by data type (Phase 4) · §7 Database audit (Phase 8) · §8 Provider audit (Phase 6) · §9 Status of the existing audit documents (Phase 15).

---

## 1. Critical

### B-C1 · Watch tracking rewrites the whole history on every change — CONFIRMED
* **Where:** `writeCreatorTrackingD1` (02:4295–4553), called by `saveCreatorTrackingD1` from `/api/creator/sync/save-tracking` (26:3519), `handleSubtitlesTrack` (26:426), `handleMediaServerScrobble` (26:1079), `checkForNewEpisodes` (07:5025); `readCreatorTrackingD1` (02:4639) reads every row back for each of them.
* **Evidence (repo harness, D1 = real SQLite):**

  | Operation (account with 2,000 watched items) | D1 statements | KV writes |
  |---|---|---|
  | `/sync/save-tracking`, full push | 2,007 | 2 |
  | `/sync/save-tracking`, **adding one item** | **2,012** | 2 |
  | **One Plex scrobble** | **2,013** | 4 |
  | `/sync/load` | 9 per call, 181 KB response | 1 |

* **Current:** one JSON blob per account in KV (`creatorsynctracking:{u}`) mirrored into five D1 tables by upserting every row on every write, in chunks of 80 statements that are not one transaction (02:4542–4547).
* **Problem:** cost and time grow linearly with history size on every play and every autosave; at large histories the write dies partway (the code's own comment names "the per-request operation cap on an account with a long Watch History", 02:4534–4536), leaving D1 behind and triggering the `trackingd1behind:` fallback machinery; row-write billing scales with plays × history length.
* **Proposed:** append-only `watch_events` + derived `show_progress` (NEXT_VERSION_ARCHITECTURE §3.4). Clients send deltas; webhooks enqueue one event.
* **Benefit:** O(1) writes per play; no merge heuristics; history size no longer affects latency.
* **Risk:** Medium — needs a faithful data migration and parity tests for Continue Watching semantics (dismissals, companions, fully-watched).

### B-C2 · There is no single source of truth — VERIFIED
* **Where:** every accessor pair in `02_http-and-creator-utils.js` (`getCreator`, `getCreatorList`, `readLikeVoters`, `readCreatorListDeletions`, `readCreatorUserListsD1`, `readCreatorTrackingD1`, scrobble token and key-lookup readers), `03_admin.js` counter readers, and every write route (dual writes).
* **Current:** D1 is "authoritative when bound", KV is "read-through cache and fallback"; but public read paths (`/lists/:u/:s`, `fetchPublishedListCatalog`, `/api/lists/like`, channel routes) read **KV only**; list saves write D1 then KV, tracking writes KV then D1; several readers treat "zero D1 rows" as "not migrated" and read KV instead; `getCreatorList` returns a record assembled from both stores (name/type/visibility/items from KV if KV's `updatedAt` is newer, `likes = max(KV, D1)`) and then writes it back to KV.
* **Problem:** correctness depends on which store answered. Concrete defects this audit found in that seam: B-H5 (like resurrection), B-H6 (liked/hidden lists partial loss and stale fallback), B-H2 (write-back on every read), plus the channel and install-config data that exist only in KV and are therefore invisible to D1-based cleanup (B-H3). `STORAGE-PLAN-KV-D1.md` is marked "Completed", but the plan's end state ("D1 is authoritative… KV is a cache") was never reached; the code implements a third model (D1-first, KV-fallback, dual-write, repair-on-read).
* **Proposed:** PostgreSQL as the only system of record; repositories that never consult a second store; KV only for rebuildable caches written by jobs.
* **Benefit:** deletes the tombstone/marker/repair code (see `CLOUDFLARE_FREE_TIER_REMOVAL_PLAN.md` FT-08–FT-13) and the class of bugs it keeps producing.
* **Risk:** High (data migration) — mitigated by the verification gates in `MIGRATION_PLAN.md` Phase 3.

### B-C3 · Background freshness is per-account and does not scale — VERIFIED
* **Where:** `checkForNewEpisodes` (07:4765; 25 accounts listed per tick, show-check budget 150), `refreshAiringNextSweep` (07:4680; `AIRING_NEXT_SWEEP_ACCOUNTS_PER_TICK = 3`), cron `*/6 * * * *`.
* **Current:** the cron walks `creator:` KV keys with a cursor, reads each account's whole tracking record, calls TMDB for that account's shows, and rewrites the record.
* **Problem:** at 100,000 accounts one Continue Watching cycle is ≈4,000 ticks (≈16.7 days) and one Airing Next cycle ≈33,000 ticks (≈139 days); the same show is looked up once per watcher; every visit triggers B-C1's full rewrite. Freshness degrades linearly with growth, silently.
* **Proposed:** per-show schedule refresh (`series_schedule`, `episodes`) + derived progress; the job's cost scales with **distinct tracked shows**, not users.
* **Benefit:** new episodes appear for every watcher within one refresh interval; TMDB calls drop by the average watchers-per-show factor.
* **Risk:** Medium (behavioural parity).

### B-C4 · Directory and search queries degrade to full scans at scale — VERIFIED
* **Where:** `getPublicListIndex` (02:2630–2709), `/api/search-published-lists` FTS query (26:4326–4347), `/lists/public.json` (25:532–636).
* **Current / Problem:**
  1. The directory is `SELECT … FROM creator_lists … UNION ALL SELECT … FROM published_lists … ORDER BY likes DESC, updatedAt DESC LIMIT ? OFFSET ?`. A compound `ORDER BY` over a `UNION ALL` cannot walk the per-table `(visibility, likes, updated_at)` indexes in merged order, so SQLite materializes and sorts every public row; `json_array_length(items_json)` is evaluated per row to compute `itemCount`, which means parsing every public list's JSON on every page request; `OFFSET` makes deep pages linear.
  2. The FTS query joins `LEFT JOIN creator_lists cl ON ('c:' || cl.id) = f.list_id` — an expression on the indexed column, so the primary-key index on `creator_lists.id` cannot be used; each FTS match can scan `creator_lists`. Same for `published_lists`. `ORDER BY likes DESC, items DESC` over the matches follows.
  3. `lists_fts.list_id` is `UNINDEXED`; `DELETE FROM lists_fts WHERE list_id = ?` on every save scans the FTS table.
  4. A separate `COUNT(*)` of both tables runs on every directory request.
* **Scale test (conceptual, 1M public lists, 50 items each):** each directory page parses ~1M JSON arrays (tens of MB) and sorts 1M rows; a search for a common word joins every match against a 1M-row scan. Both exceed D1 query time limits long before 1M lists; the response-size ceiling the code already fears (02:2631–2636) is the milder failure.
* **Proposed:** one `lists` table (anonymous lists owned by `NULL`), `item_count`/`likes_count` columns maintained on write, a generated `tsvector` column with GIN index, keyset pagination on `(likes_count DESC, updated_at DESC, id)`, cached first pages (60 s) at the edge.
* **Benefit:** O(page) per request; search is an index lookup.
* **Risk:** Low.

---

## 2. High

### B-H1 · Media-server webhook crashes when user filtering rejects a play — CONFIRMED
* **Where:** `handleMediaServerScrobble` (26:548–1133). `pingId` is referenced at 26:835 and 26:847 inside the filter branch, but declared with `const` at 26:905 — a temporal-dead-zone `ReferenceError`.
* **Reproduction (local, in-memory):** account-level filter on with allowed user `alice`; Plex payload from `mallory` → **HTTP 500 `Cannot access 'pingId' before initialization`**; same for an anonymous payload with `blockAnon`.
* **Second defect in the same block:** the account setting overrides the URL parameters despite the comment ("URL param first, fallback to user's saved account settings", 26:774). With `?filterUsers=1&allowedUsers=alice` in the webhook URL and the account setting at its default `false`, `mallory`'s play **was recorded** (reproduced).
* **Impact:** "Only scrobble these users" has never worked as designed: rejected events 500 (media servers may retry and log errors; the diagnostics panel never updates), and URL-configured filters silently do nothing. Household members' viewing lands in the owner's history.
* **Fix (Phase 1):** compute `pingId` before the filter block; define precedence explicitly (URL overrides account); add tests for both paths. Why CI missed it: `scope_check.mjs` checks that identifiers resolve, not TDZ ordering; no test exercises the filter.

### B-H2 · Reads write to KV — CONFIRMED
* **Where:** `getCreator` (02:3517–3519), `getCreatorList` (02:3868–3871), `stampListVisibilityIfNeeded` on GET paths.
* **Evidence:** dashboard load (`/api/creator/lists`, 20 lists) = **24 KV reads, 21 KV writes, 24 D1 queries**; the smallest authenticated call (`/api/creator/track-status`) = 2 reads, **1 write**; the 60-second `/sync/meta` poll = 7 reads, **1 write**.
* **Problem:** KV writes are the most expensive KV operation, limited to about one per second per key, and here they happen on pure reads, once per authenticated request. Two open tabs and a phone polling one account write `creator:{u}` several times a minute for nothing.
* **Fix (Phase 1):** delete the write-backs. The save paths already write both stores.

### B-H3 · Account deletion is incomplete, and usernames are reusable identities — VERIFIED
* **Where:** `purgeCreatorData` (02:3022–3446) key list (02:3198–3232) and D1 statements (02:3143–3158).
* **Not deleted:** `channelshare:{code}` records owned by the account, `creatorchannel:{u}:{slug}` pointers, the account's entries in `index:publicchannels`, `channellikevoters:*` votes cast as `u:{username}`, install configs `cfg:{id}` (which contain the account's **plaintext key** and OAuth tokens, 25:7048–7054), `feedback:*` threads, anonymous-voter ledgers keyed by the account.
* **Problem:** "Delete Account & All Data — Permanently delete your account, all published lists, and all synced data" (UI copy) is not true: published channels stay public under the deleted name. Because ownership is a **username string**, whoever registers the name later passes `existing.owner === owner` (26:2520) and can edit or re-publish those channels; `/channels/{u}/{slug}` keeps resolving.
* **Proposed:** immutable account ids (`uuid`) as owners; `ON DELETE CASCADE`/explicit deletes for channels, likes, sessions, tokens, install profiles; username holds as a separate table.
* **Phase 1 interim:** extend `purgeCreatorData` to find and delete channels (`/api/channel/mine` already knows how to list them) and to block re-registration of a deleted name for 30 days.

### B-H4 · Anyone can overwrite an anonymous channel share — CONFIRMED
* **Where:** `/api/channel/share` POST (26:2473–2569). When a `code` is supplied and the stored record has no owner, the ownership check (`existing && existing.owner && existing.owner !== owner`, 26:2520) is skipped, and the record is replaced.
* **Reproduction:** created an anonymous share, then POSTed a different channel with the same `code` from a second client: `GET /api/channel/share?code=…` returned the attacker's channel. A signed-in user can also **claim** someone's anonymous share (`owner: owner || existing.owner`) and publish it under their name.
* **Also:** anonymous shares have **no rate limit** and accept up to 4 MB each, stored permanently (26:2539–2546).
* **Fix:** an anonymous share is immutable (edits mint a new code, or require a per-share edit secret returned only to its creator); rate-limit anonymous shares; cap anonymous size lower.

### B-H5 · Unliking the last voter can be undone by a stale KV read — LIKELY
* **Where:** `readLikeVoters` (02:1836–1851) falls back to KV **whenever D1 returns zero rows**; `applyLikeVote` (02:1893–1901) then "seeds" D1 from those voters if D1's count is zero.
* **Scenario:** the only voter unlikes → D1 has zero rows, KV holds `[]` in the writing colo but the previous `[voter]` in other colos for up to ~60 s → a like from anyone in such a colo reads the stale KV set, sees D1 empty, and re-inserts the removed voter.
* **Fix:** single store; until then, never treat zero D1 rows as "not migrated".

### B-H6 · Liked/hidden list preferences use a blanket delete in chunks — VERIFIED
* **Where:** `saveCreatorUserListsD1` (02:4827–4873): `DELETE FROM creator_user_lists WHERE username = ?` in the first batch, inserts in later batches of 80; `readCreatorUserListsD1` returns `null` when there are zero rows (02:4881), and `/sync/load` then serves the KV blob instead.
* **Problem:** the pattern the codebase itself retired for tracking tables (`d1ReplaceRowsById`, 02:4064–4106) is still used here — a failure in batch 2+ loses entries; removing every like makes D1 empty and the next load resurrects them from KV.
* **Fix:** upsert-then-prune (or, in Postgres, a transaction).

### B-H7 · Stremio pagination is ignored by several row kinds — CONFIRMED
* **Where:** `fetchPublishedListCatalog` (05:2383–2438) ignores `skip`; `fetchAutoTrackedCatalog` (05:1942–2374) ignores `skip` (D1 path `LIMIT 100`, KV path returns the whole array).
* **Reproduction:** a 250-item published list returns **250 metas for skip=0, 100, 200 and 250**; a 250-item Watch History row returns **the same first 100 for skip=0, 100 and 200**.
* **Impact:** clients that page by `skip` receive duplicates indefinitely for published lists (the page never ends) and can never reach Watch History beyond the 100 most recent items. The Live Preview uses `/api/preview`, which has the same behaviour.
* **Fix (Phase 1):** slice by `skip`/`PAGE_SIZE` and set `totalItems`, as `fetchCustomListCatalog` already does (05:1639–1642); add contract tests for every source kind.

### B-H8 · Catalog requests do avoidable work per request — CONFIRMED / VERIFIED
* **Where:** catalog route (25:953–1075) and `fetchCatalog` (05:131–234).
* **Findings:**
  1. `resolveConfig` (KV read, and for track-enabled configs a key verification) runs on **every** catalog, meta, manifest and subtitles request; `fetchCuratedCatalog` (05:1830) and `fetchAutoTrackedCatalog` (05:1962) call it **again** inside the same request.
  2. "Remove duplicate items across lists" refetches every earlier row on each row request (`dedupeAcrossListEntries`, 05:294–329). **Measured:** a cold request for row 20 of 20 issued **20 upstream fetches** (1 without the setting). Across cold isolates a home screen is O(N²).
  3. When the Discover snapshot is older than 3 days, the Recommended row rebuilds recommendations inline: up to 12 seeds × (find + recommendations + similar) plus up to 40 `external_ids` calls — **~70–80 raw TMDB calls with no timeout on one catalog request** (05:1663–1753, 1794–1819, 1859–1872).
  4. Every successful non-personal first page writes a `lastgood:{config}:{type}:{id}` copy to KV (25:1022–1027) — a KV write per row per home-screen load.
  5. Badged posters are fetched server-side and base64-embedded into SVG per URL (25:310–461); cached by URL, but each distinct poster/date combination is a full image fetch and ~33% size inflation.
* **Proposed:** add-on profile cached per colo; cross-row dedupe computed once per profile version; recommendations computed by a job and read from `recommendation_snapshots`; drop `lastgood:`; badge artwork rendered once into R2 keyed by content hash.

### B-H9 · Most provider calls have no timeout or retry policy — VERIFIED
* **Where:** ~140 raw `fetch()` calls across `05`, `06`, `07`, `25`, `26` (82 in `25_` alone); only calls wrapped by `fetchWithPerUserCacheAndCircuitBreaker` (~20) or `fetchWithTimeout`/`fetchTraktWithRetry` get the 10 s timeout.
* **Problem:** a provider that accepts the connection and stalls holds the request (and, for `waitUntil` work, the isolate) until the platform kills it; retries are ad hoc (Trakt 429 only; OAuth token exchange loops with 0/1/2/3 s sleeps, 25:3375–3389).
* **Proposed:** the provider layer (§8) owns timeouts, retry with jitter, `Retry-After`, circuit breaking and metrics for every call.

### B-H10 · Sync is full-state, polled, and unbounded in size — VERIFIED
* **Where:** `/sync/load` (26:3833–4127) returns config, all presets, all channels, the **entire** watch history, continue watching, airing next, watchlist, recommendations and settings in one response (181 KB at 2,000 history items); `/sync/meta` is polled every 60 s while the dashboard is open (7 KV reads, 1 KV write, 4 D1 queries per poll); `/sync/save`, `/sync/save-tracking`, `/sync/save-presets`, `/sync/save-channels` each accept the full current state from the browser.
* **Problem:** transfer and parse cost grow with account size; conflict handling relies on four version stamps and merge heuristics (`rescue`, empty-guards, scrobble queue) that can still resurrect deletions or lose concurrent edits.
* **Proposed:** resource APIs with small mutations, `ETag`/`If-Match` per resource, and a cheap `GET /api/v2/changes?since=` (or later a Durable Object push channel) for multi-device freshness.

### B-H11 · Install configs are immutable, permanent snapshots that carry secrets and whole channels — VERIFIED
* **Where:** `/api/save` (25:6942–7119), `resolveConfig` (04:23–156), `/api/resolve` (25:6863–6934), `/:config/configure` (25:465–489).
* **Current:** every "Generate Install Link" writes a new permanent `cfg:{id}` with provider keys, OAuth access tokens, the account's plaintext key (when a personal shelf is present), and every row's full payload (channels are embedded JSON, up to 10 MB per config). Nothing ever deletes them; `/api/resolve` returns the tokens to anyone holding the id.
* **Problem:** unbounded storage growth; a settings change requires a new install (and the old one keeps serving the old config forever); credentials are copied into records the user cannot see or revoke. Security impact detailed in `SECURITY_AUDIT.md` S-1.
* **Proposed:** live add-on profiles behind revocable tokens; legacy configs migrated into `legacy_installs` with secrets moved to the vault.

### B-H12 · `forgot-username` fallback runs 50 PBKDF2 verifications per request — VERIFIED
* **Where:** 26:1597–1617: when the lookup index misses, it scans `SELECT … FROM creators LIMIT 50` and runs `verifyCreatorKey` on each row.
* **Problem:** ≈750 ms of CPU per unauthenticated request (15 ms × 50) behind a per-IP limit of 5 per 15 minutes (bypassed by rotating IPs); and functionally it only ever checks an arbitrary first 50 accounts.
* **Fix (Phase 1):** delete the fallback; lookup hashes are written at every login/restore already.

---

## 3. Medium

| ID | Finding | Where | Status | Fix |
|---|---|---|---|---|
| B-M1 | `/api/preview` returns raw `err.message` instead of `safeErrorMessage(err)` | 25:1270–1273 | VERIFIED | Use the helper (it strips URLs and tokens). |
| B-M2 | `getCreator` contains a hyphen-insensitive fallback lookup (`LOWER(REPLACE(username,'-',''))`) that is dead only because it checks `res2.length` on a D1 result object; if "fixed" it would authenticate `abc` against `a-bc`'s record and cache it under `creator:abc` | 02:3499–3503 | VERIFIED (latent) | Delete it. |
| B-M3 | Legacy bare-key install ids: any ≤12-character string is read as a KV key (`CONFIGS.get(configParam)`); today only projected fields are returned, but it is an arbitrary-key read by design | 04:24–26 | VERIFIED | Restrict to `^[A-Za-z0-9_-]{12}$` and migrate bare keys to `legacy_installs`. |
| B-M4 | `stats` is an unbounded key/value counter table used for page views, events per title, search terms, API usage, auth failures, genres; leaderboards use `kind LIKE 'evt:…%'`, which cannot use the `(kind, day)` PK under default case-insensitive LIKE | 03:65–74, 03:667–686 | VERIFIED | Analytics Engine + `daily_title_counts`. |
| B-M5 | Admin dashboard does a full `list()` sweep of every `creator:` KV key on every load, in parallel with the D1 queries it no longer needs it for | 03:1740–1744 | VERIFIED | Remove. |
| B-M6 | Channel "live pool" and "new episodes" rebuilds run from request `waitUntil` with per-isolate dedupe only; cache keyed by client-generated `channelId` (collisions thrash) | 05:3353–3703 | VERIFIED | Jobs with dedupe keys; server-generated ids. |
| B-M7 | `/lists/:user/:slug` HTML embeds **every** item into the page preamble (up to 10,000) on top of the 2 MB app | 26:4830–4857 | VERIFIED | Server-render a small page; paginate items. |
| B-M8 | `/lists/:user/:slug.json` returns the full list with no pagination (external consumers: Kometa, Cinephage, Jellyfin plugins) | 26:4775–4821 | VERIFIED | Keep the array shape for compatibility; add `?offset&limit` and document a cap. |
| B-M9 | Like count on the list record is rewritten in KV by re-reading and re-putting the **whole** list record (items included) on every like | 25:7211–7231 | VERIFIED | Counter column. |
| B-M10 | Account creation reserves the rate-limit slot before validating, then the uniqueness check and insert are not atomic across KV; two simultaneous creates of one name from two IPs can both pass `getCreator` when D1 is slow | 26:1225–1320 | LIKELY | Unique constraint + `INSERT … ON CONFLICT` as the only check. |
| B-M11 | Webhook handler marks a movie watched on `media.play`/`media.resume`/`media.stop` (Plex) and `playback.start` (Emby) — starting a film counts as watching it | 26:670, 26:734 | VERIFIED | Count only scrobble/stop-with-≥90%-progress events where the payload carries position. |
| B-M12 | `handleSubtitlesTrack` marks an episode watched when playback **starts** (by design, documented) and writes diagnostics to KV on every ping | 26:155–544 | VERIFIED | Keep the signal, but record it as a `started` event and derive "watched" from a later event or a threshold where possible; diagnostics to Analytics Engine. |
| B-M13 | `alreadyWatched` is declared and read but never set | 26:321, 26:476–480 | VERIFIED | Remove or implement. |
| B-M14 | Trakt device-code endpoints accept a caller-supplied `client_id` and pair it with the server's `TRAKT_CLIENT_SECRET`; unauthenticated and not rate-limited | 25:3448–3565 | VERIFIED | Server client id only; rate limit. |
| B-M15 | OAuth tokens are never refreshed (no refresh token stored); Trakt connections die at ~90 days and personal rows go empty in Stremio with no explanation | all OAuth callbacks | VERIFIED | Vault + refresh job (Phase 7). |
| B-M16 | Two TMDB detail caches with different keys and shapes (`tmdbdetail_v2:` vs `tmdb:itemdetails:v3:`) plus season, unpacked-show and per-route caches; the same title is fetched and stored several ways | 07:389–485, 07:3763–4170 | VERIFIED | `media`/`episodes` tables. |
| B-M17 | `fetchMdblistWatchlist` tries four different MDBList endpoints in sequence, including `lists/user` + a second request, on every catalog request (short `cacheTtl`, `cacheEverything: false`) | 06:298–364 | VERIFIED | Confirm the one supported endpoint with MDBList; cache per connection. |
| B-M18 | Trakt private-list 401/403 silently retries as a public request and serves whatever a public request returns | 06:550–560 | VERIFIED | Surface "reconnect Trakt" instead of silently degrading. |
| B-M19 | `consumeRateLimit` and eight inline copies are read-then-write on edge-cached KV; concurrent requests pass together | 02:1698 and inline copies | VERIFIED | Rate-limit binding / WAF rules. |
| B-M20 | `/api/creator/lists` runs a KV `list()` orphan sweep (up to 5 pages) on every page of every dashboard load and hashes the whole payload to compute `knownVersion`, so an "unchanged" reply costs the same reads (and writes, B-H2) as a full one | 26:1843–2031 | VERIFIED | Version column + `ETag`. |
| B-M21 | Per-isolate memos hold large strings (`BUILDER_PAGE_MEMO`, `APP_BUNDLE` ~2 MB, `SPLIT_PAGE_MEMO` ×16, `PER_USER_CACHE_MAP` ×1,000 provider payloads) within a 128 MB isolate | 02:985–1269 | LIKELY | Static assets; bounded LRU by bytes. |
| B-M22 | Letterboxd list URLs are accepted by `/api/preview`'s allowlist and invited by the "Add Catalog" modal, but `detectSource` has no Letterboxd branch and falls through to MDBList, producing a misleading MDBList 404 | 04:259–307, 04:354, 16:2904 | VERIFIED | Detect Letterboxd explicitly and route to the import flow (FRONTEND_UX_AUDIT F-C3). |

---

## 4. Low

| ID | Finding | Where |
|---|---|---|
| B-L1 | `applyEnvApiKeys` mutates module-level `let` globals on every request (safe only because all requests in an isolate share one env) | 00:650–659, 00:823–830 |
| B-L2 | `safeUserHash` is a non-cryptographic 64-bit hash used to separate users' cached provider data in KV keys; low collision risk but not a keyed MAC | 02:1216 |
| B-L3 | `/admin/logout` fixed (405 on GET); admin cookie is a stateless HMAC over expiry with no revocation | 03:1549–1565, 26:7109 |
| B-L4 | `isEpisodeAired` / `formatAirDateBadge` use the Worker's local timezone (UTC) for "today" while stats use Eastern days | 02:3891–4007 |
| B-L5 | `fetchTmdbItemDetailsUncached` title-search fallback treats an arbitrary string id as a title and picks the first TMDB result (wrong-title risk for webhooks without ids) | 07:3860–3890, 26:873–903 |
| B-L6 | `hashStringForKey` truncates SHA-256 to 128 bits for external-like ledgers (fine) but anonymous voter ids are `SHA-256(ip|list)` without a secret, so they are brute-forceable back to IPv4 addresses | 02:949, 02:1778 |
| B-L7 | `trackSharedApiUse` bumps a D1 counter on every catalog fetch using a shared key (a write per row per request) | 05:125–129 |
| B-L8 | Hard-coded `User-Agent: my-list-addon/1.14` / `1.4` strings disagree with `ADDON_VERSION` | 07:3839, 25:3364 |

---

## 5. Cleanup

| ID | Item | Where |
|---|---|---|
| B-X1 | `enrichTrailers` is a no-op called from every MDBList/Trakt fetcher | 07:375–377 |
| B-X2 | Empty stubs `checkUnsavedInstallLink()` / `updateInstallLinkFromBanner()` behind a visible banner | 24:2083–2085 |
| B-X3 | `NEW_ON_STREAMING_PAGES_PER_TICK`, `NEW_ON_STREAMING_SWEEP_FETCHES` kept "for the admin route's default" | 00:423–427 |
| B-X4 | Legacy key names swept on delete (`creatorprofile:`, `creatorpresets:`, `creatorchannels:`, `creatorlistlikes:`, `creatorlikes:`) | 02:3214–3231 |
| B-X5 | `published_lists` / `publishedlist:user:*` read paths remain after anonymous publishing was removed in 1.5.3 | 26:7121–7137 |
| B-X6 | Duplicate SVG generators (channel poster/backdrop/logo/badge/safe) with repeated gradient `<defs>` | 05:414–852, 25:1398–1499 |
| B-X7 | `build.ps1` carries its own copy of the header text | build.ps1 |
| B-X8 | Dead zip-import code paths noted by the previous audit: one reference to `traktExportFileInput` remains | 18_ |
| B-X9 | Comments: ~60 free-plan references, many multi-paragraph histories of past bugs inside hot functions (valuable history that belongs in commit messages/ADRs, not in code) | throughout |
| B-X10 | `COMPANION:` JSON encoded into `continue_watching.show_title` | 02:4428–4441, 02:4717–4728, 05:2053–2064 |

---

## 6. Storage audit by data type (Phase 4)

Columns: **Auth** = authoritative source today · **Dup** = duplicated · **Cache** = cached copies · **Stale?** · **If KV vanished** · **If D1 unavailable** · **EC ok?** = eventual consistency acceptable · **Tx?** = needs transactions · **FTS?** · **Expiry?** · **Jobs?** = background processing · **Target**.

| Data | Auth today | Dup | Cache | Stale? | If KV vanished | If D1 unavailable | EC ok? | Tx? | FTS? | Expiry? | Jobs? | **Target** |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Creators (identity) | D1 when bound; KV `creator:` always written | Yes | KV written on every read | Yes (KV edge cache) | Logins still work via D1 | Logins fall back to KV; rotation refuses | **No** (auth) | Yes (rotate, delete) | No | No | No | Postgres `accounts` |
| Key lookup (forgot username) | D1 + KV `keylookup:` | Yes | — | Yes | Falls back to D1 | Falls back to KV, then a 50-row PBKDF2 scan | No | No | No | No | No | Column on `accounts` |
| Creator lists | D1 `creator_lists` + KV `creatorlist:` | Yes | KV written on read | Yes | **Public pages 404** (they read KV) | Dashboard falls back to KV | No | Yes (order, likes) | Yes | No | No | `lists` + `list_items` |
| List order | KV `creatorlistorder:` + D1 `sort_order` | Yes | — | Yes | Order lost; orphan sweep re-appends | KV only | No | Yes | No | No | No | `lists.position` |
| Source groups / counters | D1 `source_groups`, `stats`; KV `stats:*` fallback | Partly | — | — | Minor | Falls back to KV totals | Yes | No | No | No | Rollups | Analytics Engine |
| Channels (share/publish) | **KV only** `channelshare:`, `creatorchannel:`, `index:publicchannels` | Browser copy + `creatorsyncchannels:` | — | Yes | **All shared/published channels lost** | Unaffected | No | Yes (ownership) | Yes | No | Pools/new episodes | `channels` + `channel_items` |
| Channels (personal) | Browser `localStorage` + KV `creatorsyncchannels:` blob | Yes | — | Yes | Browser copy survives | Unaffected | No | No | No | No | Yes | Same |
| Custom lists (not signed in) | Browser only | — | — | — | — | — | — | — | — | — | — | Require an account to persist server-side, or mark clearly "this device only" |
| Install configs | **KV only** `cfg:` / bare ids | Browser has the entries | — | Never updated | **Every install breaks** | Unaffected | Yes (immutable) | No | No | No (never deleted) | No | `addon_profiles`, `addon_rows`, `addon_tokens`, `legacy_installs` |
| Watch history | KV blob + D1 `watch_history` (+ browser) | Yes (3) | — | Yes | Falls back to D1 (if current) | Serves KV | No | Yes | No | No | Sync jobs | `watch_events` |
| Continue Watching / Airing Next | KV blob + D1 tables (+ browser computes) | Yes (3) | Scrobble queue key | Yes | D1 | KV | Yes (derived) | No | No | No | Yes | Derived from events × `episodes` |
| Watchlist | Tracking blob + `creatorlist:{u}:watchlist` KV + D1 row | **Yes (3)** | — | Yes | D1 | KV | No | No | No | No | No | A system list (`lists.kind='watchlist'`) |
| Likes (lists) | D1 `list_likes` when non-empty, else KV ledger | Yes | Count on list record in both stores | Yes | Counts stay in D1 | KV ledger | No | Yes (count) | No | No | No | `list_likes` + `likes_count` |
| Likes (external URLs, channels) | KV ledgers | — | Count in channel index row | Yes | **Lost** | Unaffected | No | Yes | No | No | No | Tables |
| Liked/hidden lists (per user) | D1 `creator_user_lists` (non-empty) else KV blob | Yes | — | Yes | D1 | KV | No | Yes | No | No | No | `list_follows`, `hidden_items` |
| Feedback | D1 `feedback` + KV `feedback:` (180-day TTL) | Yes | — | Yes | D1 | KV | Yes | No | No | KV only | No | `feedback_threads`, `feedback_messages` |
| Telemetry/analytics | D1 `stats` (+ KV fallbacks) | Partly | Most-watched snapshot KV | — | Minor | KV path | Yes | No | No | KV TTLs | Rollups | Analytics Engine + `daily_title_counts` |
| OAuth state | HttpOnly cookie (Path-scoped, 10 min) | — | — | — | — | — | — | — | — | Yes | No | **Keep** (cookie) |
| OAuth tokens | Browser `localStorage`, install configs, `creatorsync.keys`, backups | **Yes (4+)** | — | — | — | — | — | — | — | Provider expiry | Refresh (missing) | `provider_connections` (encrypted) |
| Sessions | **None** (key per request, isolate memo) | — | Auth memo | — | — | — | — | — | — | — | — | `sessions` |
| Temporary data (rate limits, cursors, migration state) | KV with TTLs | — | — | — | Limits reset | Unaffected | Yes | No | No | Yes | Cron | Rate-limit binding; `jobs`; Postgres |
| Provider caches | KV `cache:*`, `tmdbdetail_v2:`, `tmdb:itemdetails:v3:`, `tmdb:season:`, `tvmaze:airtime:v3:`, `unpacked_show:`; edge cache; isolate LRU | Yes | 3 tiers | Yes (SWR) | Cold start, provider load spike | Unaffected | Yes | No | No | Yes | Pre-warm | `media`/`episodes` (+ KV snapshots, Cache API) |
| Catalog caches | `lastgood:` per config, circuit-breaker KV/edge | Yes | — | Yes | Placeholder tiles on failure | Unaffected | Yes | No | No | 30 d | No | KV chart snapshots only |
| Public directory/search | D1 UNION + FTS5; KV scan fallbacks | — | 60–120 s HTTP | Yes | D1 path unaffected | KV scan of 80–250 keys | Yes | No | **Yes** | No | No | `lists` + `tsvector` |
| Metadata (`event_meta`, titles) | D1 `event_meta` + KV `evtmeta:` | Yes | — | Yes | D1 | KV | Yes | No | No | KV TTL | Backfill | `media` |
| Generated assets (SVG posters, badges, BetterPosters) | Generated per request; BetterPosters bytes in KV `bpimg:v1:` | — | Edge cache | — | BetterPosters refetched (slow) | Unaffected | Yes | No | No | 60 d | Pre-warm | R2 |
| New on Streaming events | D1 `streaming_events` (only here; no KV fallback) | — | — | — | Unaffected | **Feature off** | Yes | No | No | No | Sweep | Postgres (same shape) |

**Recommendation on authority.** Every row above that says "No" under *EC ok?* must be in PostgreSQL and nowhere else. Everything with *Jobs* becomes a queue job. KV keeps only chart snapshots and flags; R2 keeps binary assets; nothing user-authored is ever read from KV again.

---

## 7. Database audit (Phase 8)

### 7.1 Schema findings

| # | Finding | Tables | Impact at scale | Target |
|---|---|---|---|---|
| D-1 | **Natural keys as identity.** `creators.username` is the PK and every other table refers to users by username string; list ids are `"{username}:{slug}"`; likes use `"c:{user}:{slug}"`, `"u:{username}"`. | all | Renames impossible; deletion leaves string references that the next owner of the name inherits (B-H3). | `uuid` ids; usernames are a unique attribute. |
| D-2 | **Polymorphic string keys with no FK.** `list_likes.list_id` (`c:`/`a:`/`ext:`/`ch:`), `creator_user_lists.list_id`/`list_type`. | list_likes, creator_user_lists | Orphans; purge needs `LIKE` with escaping (02:3146–3147). | Separate tables per target, real FKs. |
| D-3 | **Foreign keys on only two tables** (`creator_lists`, `creator_key_lookups`). Tracking tables, likes, tokens, show states have none. | most | Partial purges leave orphans; nothing enforces cleanup. | FKs with `ON DELETE CASCADE`. |
| D-4 | **Items as JSON** (`creator_lists.items_json`, `published_lists.items_json`), with `json_array_length` computed at query time and a 2 MB row cap shaping product limits. | creator_lists, published_lists | Directory parses JSON per row (B-C4); per-item edits rewrite the whole list; no "which lists contain X". | `list_items` rows; `item_count` maintained. |
| D-5 | **Two list tables** with identical shape (`creator_lists`, `published_lists`) unioned for every directory query. | both | UNION prevents index-ordered pagination. | One `lists` table. |
| D-6 | **Contentless FTS keyed by an UNINDEXED text id**, maintained by application code, joined by expression. | lists_fts | Full scans on delete and on join (B-C4); drift if a write path forgets it (the admin "rebuild index" tool exists for this). | Generated `tsvector` + GIN, or `pg_trgm` for fuzzy names. |
| D-7 | **Encoding data in the wrong column**: `COMPANION:{json}` inside `continue_watching.show_title`; `scrobble_allowed_users` as a comma string; `curated_recommendations` JSON in the tracking meta row. | continue_watching, creator_tracking_meta | Unqueryable, fragile parsing. | Proper columns / tables. |
| D-8 | **Per-user copies of shared facts**: `airing_next` stores each show's next episode, air date, premiere/finale flags once per watcher. | airing_next | N copies of the same schedule; stale per user. | `episodes` once per show. |
| D-9 | **Identity of a watch is inconsistent**: `watch_history.item_id` is a TMDB episode id, an IMDb id, `"{show}:{s}:{e}"` or a title string depending on the writer; PK `(username, item_id)` means a rewatch overwrites the previous watch. | watch_history | Duplicates across writers; rewatches lost. | `watch_events(media_id, season, episode, watched_at)`; views pick latest. |
| D-10 | **`stats` as a generic EAV counter store** with an unbounded `kind` (per title, per search term, per list slug, per auth scope). | stats | Grows with titles × days; LIKE prefix scans; mixing security and product data. | Analytics Engine; typed rollup tables. |
| D-11 | **Tombstone tables** (`creator_tombstones`, `list_tombstones`) exist to survive KV propagation and browser re-uploads. | tombstones | Must be pruned; semantics subtle. | Retire with the sync model; keep `username_holds`. |
| D-12 | **Timestamps**: INTEGER ms everywhere (consistent), but `updated_at` is sometimes client-supplied (`item.updatedAt`, `watchlistUpdatedAt`), air dates are `TEXT`, stats days are Eastern-local strings. | several | Clock skew from clients decides conflict outcomes. | `timestamptz` server-assigned; `date` for air dates; one documented reporting timezone. |
| D-13 | **Migrations** are hand-applied, partly non-idempotent (`ALTER TABLE ADD COLUMN`), with a runtime manifest to detect missing ones. | migrations/ | Drift between environments. | Migration tool + CI. |
| D-14 | **Missing indexes for real queries**: `creator_lists (username, sort_order, created_at)` for the dashboard order query (26:1784–1786); `feedback` by account; `list_likes (voter_id)` exists but deletes by `list_id LIKE`. | several | Sorts per request. | Covered by the new schema. |
| D-15 | **Unnecessary/unused indexes**: `idx_creator_lists_visibility` (two-value column; superseded by the composite), `idx_creator_lists_likes` (per migration 0001b's own note, rarely chosen). | creator_lists | Write amplification. | Drop in the new schema. |

### 7.2 Queries against the stated scale (100k users, 1M public lists, tens of millions of items, millions of likes)

| Query | Today | At scale | Target |
|---|---|---|---|
| Directory page | UNION + global sort + JSON parse per row + OFFSET | Seconds to timeouts | Keyset over one indexed table: < 5 ms |
| Search | FTS match + expression join + sort | Full scans per match | GIN `tsvector` + rank: < 20 ms |
| Like | Read up to 5,000 voter ids, rewrite KV JSON, `COUNT(*)`, update two stores | Hot-list contention; hard cap at 5,000 | `INSERT … ON CONFLICT DO NOTHING` + counter |
| Dashboard | N `getCreatorList` (each D1 read + KV read + KV write) | Linear in lists, with writes | One query for list metadata |
| Save tracking / scrobble | O(history) upserts | Minutes and partial writes for heavy users | O(1) insert |
| Personal catalog row | Full watch history read or KV blob parse | MBs per request | Indexed `LIMIT/OFFSET` on `(account_id, watched_at DESC)` |
| Most Watched rebuild | `SUM` over `stats` rows matched by `LIKE` | Scans a table that grows per title-day | Rollup table |
| New on Streaming feed | Indexed `(region, kind, last_event_at DESC)` | Fine | Keep |

---

## 8. Provider audit (Phase 6)

| Provider | Endpoints used | Auth | Rate limits (provider) | Caching today | Retries / timeouts | Pagination | Normalization | Hacks / duplication | Called from | Persisted | Cascading failure risk |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **TMDB** | v3 `find`, `movie|tv/{id}` (+`append_to_response`), `tv/{id}/season/{n}`, `episode_groups`, `search/{movie,tv,multi,person}`, `discover`, `trending`, `collection`, `recommendations`, `similar`, `external_ids`, `person/*`, `watch/providers`, v3 authentication + account lists; v4 `list/{id}` | Shared `TMDB_API_KEY` (query string); optional per-user key; v3 session id for account features | ~50 req/s per IP (soft) | Edge `cf.cacheTtl` up to 7 d; KV `tmdbdetail_v2:`, `tmdb:itemdetails:v3:`, `tmdb:season:`, `unpacked_show:`; isolate LRU | 10 s only inside circuit breaker; most calls none | Page math per fetcher (`fetchTmdbPagedResults`) | Several mappers (`mapTmdbItem`, item details, standard meta, recommendations) | ≥8 detail code paths; key in URL can leak into logs | Server (routes, catalog, cron, webhooks) | KV caches; `streaming_events` rows | High: recommendations and channel pools fan out inline |
| **Trakt** | `users/{u}/lists/{l}/items`, `users/me`, `sync/watchlist`, `sync/history`, charts (`movies|shows/{trending,popular,…}`), `search/list`, `users/{u}/lists`, list create/delete/items add/remove, `oauth/token`, `oauth/device/*` | `trakt-api-key` (shared or user client id) + bearer token from the browser | 1,000 GET / 5 min per user; 429 with `Retry-After` | Circuit breaker (memory/KV/edge) per list/page; edge for public | `fetchTraktWithRetry` (429 only, 2 retries); OAuth exchange loop | `page` from `skip/PAGE_SIZE` | `mapTraktItems`, `mapTraktHistoryItems` | Wrapper-less `/popular` handled inline; private → public silent fallback (B-M18) | Server, with user token from request/config | No (tokens not stored server-side) | Medium |
| **MDBList** | `mdblist.com/lists/{u}/{l}/json/` public feed, `api.mdblist.com/lists/top`, watchlist (4 endpoints tried), `sync/watched`, `lists/user`, list items/writes, OAuth + PKCE | Shared key, user key or OAuth bearer | 1,000 req/day on free API tiers (per the code's hourly throttle comment) | Circuit breaker 1 h fresh / 24 h KV for public feeds; hourly pre-warm | 10 s inside breaker only | Server slices the whole feed in memory | `extractMdblistItem`, `mapMdblistItems` | Endpoint guessing (B-M17) | Server | No | Medium (daily quota shared by all users of the shared key) |
| **Simkl** | Chart JSON files (`SIMKL_CHART_FILES`), user lists (`sync/all-items`), OAuth | Client id + bearer | Undocumented | Circuit breaker | Breaker only | In memory | `mapSimklItems` | Airing-next computed client-side with a localStorage cache | Server + client caches | No | Low |
| **JustWatch** | GraphQL `apis.justwatch.com/graphql` (new titles per day/package) | None | Unknown, **unofficial** | D1 `streaming_events`, KV day cursors | Sweep-level | Cursor `after` | `processJustWatchNewTitles` | Legal/terms question in-code | Cron only | Yes (events) | Low (cron only) |
| **RapidAPI Streaming Availability** | `/changes` | `x-rapidapi-key` | 1,000 req/month (Basic) | Monthly usage in KV | Sweep-level | Provider cursor per stream | `processRapidApiStreamingChanges` | Budget spread math per tick | Cron + admin | Yes (events) | Low |
| **TVmaze** | show lookup by IMDb, air times | None | 20 calls / 10 s | KV `tvmaze:airtime:v3:` | `meter` | — | `formatAirTimeLabel` | — | Server | KV | Low |
| **Metahub / Cinemeta** | `images.metahub.space/poster/...`, Cinemeta series meta for unpacked anime seasons | None | Unknown | Edge | None | — | Poster URL construction everywhere | Poster fallback used as the default for Trakt items | Client + server | No | Low |
| **btttr.cc (BetterPosters)** | `/{style}/imdb/poster-default/{imdb}.jpg` | None | Slow origin (40–50 s cold draws) | KV binary copies, edge, miss cache, retry list | 55 s / 25 s / 6 s tiers | — | URL builder | Complex SWR on KV | Server + client warm endpoint | KV | Medium (slow upstream held open) |
| **Letterboxd** | None (CSV/ZIP export parsed in the browser) | — | — | — | — | — | Titles resolved by TMDB search | URL paste falls through to MDBList (B-M22) | Client | Via list save | Low |

**Unified abstraction — yes.** The target is `Provider → normalized MediaRef → application logic`:

```
providers/<name>/client.ts   request(op) with auth, timeout, retry(jitter, Retry-After), breaker, budget, metrics
providers/<name>/ops.ts      typed operations (chart, list, watchlist, history, search, write ops)
providers/<name>/map.ts      payload → NormalizedItem { imdbId?, tmdbId?, kind, title, year, art, extra }
catalog/resolve.ts           NormalizedItem → media row (upsert, id reconciliation) → MediaRef
```

Rules: no feature module may call `fetch()` directly; provider credentials come from the vault by connection id; every result is keyed to `media.id` before it reaches catalogs, channels, lists or tracking; shared results are cached once (KV snapshot or `media`), per-user results per connection with a short TTL.

---

## 9. Status of the existing audit documents (Phase 15)

| Document | Claims | Verified status today |
|---|---|---|
| **COMPLETE_AUDIT_REPORT.md** (2026-09-13; remediation section 2026-09-14) | 25 findings, all fixed. | **Fixed and verified in code:** SEC-001 gate (`mayReadTrackedShelf` on catalog/preview/resolve paths), DB-001 (`ON CONFLICT` + dedupe), DB-002/BE-002 (`trackingShowKey`), BE-001 (save-tracking returns 500 on D1 failure), BE-003 (rotation fails closed), PROTO-001 (`tmdb:` in `idPrefixes`), DB-003 (LIMIT/OFFSET in SQL), CF-001 (scan cap), DB-004 (FTS in one batch), CF-002 (memo keyed by hash), INFO-03 (`/admin/logout` 405 on GET), FE-001, A11Y-004 (every `role="dialog"` element now carries a label). **Partially fixed / still valid:** SEC-001 residual via `LEGACY_UNVERIFIED_CONFIG_SHELVES = true`; DB-003 (per-row `json_array_length` and UNION sort remain — see B-C4); DB-004 (DELETE on an UNINDEXED FTS column still scans); A11Y-001 (3 `:focus-visible` rules now; coverage not re-verified per control); API-001 (refresh tokens) — "documented rather than implemented", **still open**; INFO-01 (admin session revocation) still open; INFO-02 (`stats.kind` unbounded) still open and larger; INFO-05 — the committed backup with live credentials was removed, but **credential rotation cannot be verified from the repo** and must be confirmed. **Missed by that audit:** B-C1 (O(history) writes), B-C3 (sweep scalability), B-C4 (directory/search at scale), B-H1 (webhook TDZ crash), B-H2 (write-on-read), B-H3 (deletion leaves channels/configs), B-H4 (channel share overwrite), B-H7 (pagination ignored), B-H11/S-1 (tokens in install configs and `/api/resolve`). |
| **UI_UX_AUDIT.md** | 6 tabs too many, choice overload, 124 `alert()`, 18 `confirm()`, 6 `prompt()`, duplicate drag engines, >420 controls. | `alert()` count still 124 (now routed to toasts — **every one styled as an error**, including success messages; see FRONTEND F-M1); `confirm()` down to 2 (a custom `showAppConfirm` exists); `prompt()` 0; drag engines unified into pointer-event `createSortableList` (CHANGELOG, verified: native `dragstart` handlers down to 2); control count in the live DOM: **624 buttons, 199 inputs, 3,430 nodes** at first paint — higher than the audit's 420. Navigation recommendations (6 → 3 tabs) **not implemented**. Its biggest miss: it never identifies the immutable install-link model as the root of the "Save/Update" friction. |
| **STORAGE-PLAN-KV-D1.md** | "Status: Completed. All phases (0 through 4) implemented." | **Implemented incorrectly.** Phase 1 (kill the 32-shard index) is done. Phases 2–4 added D1 tables but kept KV as a co-authority: public list reads, likes, channels and install configs remain KV-first or KV-only; readers fall back to KV on zero rows; dual writes are not transactional; tracking is still a KV blob mirrored into D1. Phase 0 ("Make D1 required") is not reflected in code — every path still branches on `env.DB`. The plan's premise ("the free plan is no longer a constraint") is right; its target (keep D1) is superseded by this audit's Postgres recommendation for scale reasons (NEXT_VERSION_ARCHITECTURE §2). |
| **FUNCTION-MAP.md** | Generated symbol/route map. | Accurate (CI drift-checked). Retire with the concatenated build. |
| **Changes.md / CHANGELOG.md** | Narrative change logs. | Useful history; not audits. Much of their content duplicates in-code comments. Keep CHANGELOG (user-facing); fold `Changes.md` into commit/PR history. |
| **docs/history/*** | Seven prior audits and fix statuses. | Historical; superseded by this audit set. |
