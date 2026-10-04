# Cutover Runbook — My Lists Addon v2

This document is the step-by-step procedure for the Phase 10 production cutover: flipping the six
feature flags that move the live service from the legacy storage and auth to the v2 stack. Each flip
is gated behind at least **seven days of clean operation** and a set of reconciliation checks. Read
this document in full before starting any flip. The accompanying runbook for ordinary releases is
[`docs/OPERATIONS.md`](OPERATIONS.md); the deploy checklist is [`docs/DEPLOY_CHECKLIST.md`](DEPLOY_CHECKLIST.md).

---

## Prerequisites

Before touching any flag, confirm:

- All Phase 9 staging and production deploys have been verified (see `docs/STAGING.md`).
- Every pending database migration has been applied to production (`OPERATIONS.md` §4).
- A D1 Time Travel bookmark has been taken for both `my-lists-db` and `mylists-activity`
  (see `OPERATIONS.md` §5).
- The Analytics Engine dataset `mylists_events` is bound and receiving data.
- The background jobs queue (`mylists-jobs`) is bound, has a consumer, and a test job round-trips
  in `/admin` → Maintenance → Background jobs queue.

---

## Flag Flip Order

The flags MUST be flipped in the order listed. Each one depends on the previous having been stable
for at least seven days. All date windows below are **calendar days from the deploy moment**.

| # | Flag | Day window | One-way? |
|---|---|---|---|
| 1 | `FF_SESSIONS` | Day 0 (first flip) | No |
| 2 | `FF_INSTALLS` | Day 7 | No |
| 3 | `FF_V2_LISTS_READ` | Day 14 | No |
| 4 | `FF_V2_LISTS_API` | Day 21 | No |
| 5 | `FF_V2_LISTS_ONLY` | Day 28 | **YES — one-way** |
| 6 | `FF_EVENT_TRACKING` | Day 35 | **YES per account** |

> **One-way flags:** Once `FF_V2_LISTS_ONLY` is on, the old list storage stops being written.
> Turning it off again would show stale lists. Once `FF_EVENT_TRACKING` is on for an account,
> its old tracking records stop moving. Both must stay on once set.

---

## Reconciliation Gates

Before advancing to the next flag, ALL gates for the current phase must pass.

### Gate A — Reconciliation data (all phases)

```sql
-- All pending migrate.* jobs are gone from the queue
SELECT * FROM jobs WHERE type LIKE 'migrate.%' AND status NOT IN ('done','failed');
-- Expected: 0 rows
```

- Analytics Engine: confirm `double8` (old list write counter) = 0 after Phase 5 flip.
- `/admin` → Maintenance → **Lists v2** → *Check results*: no accounts in progress, none failed.
- Shadow comparison report (Phase 5 — `shelf.shadow` cron job): mismatches below 0.1%.
- All items in mismatch reports are reviewed (not just counted).

### Gate B — Error rate (all phases)

After each flip, watch the Worker Metrics and Live Logs for 30 minutes:

- P99 CPU time < 50 ms.
- Error rate (5xx) < 0.1%.
- Queue `mylists-jobs` message count draining (not growing).
- D1 read/write count flat or lower than before the flip.

### Gate C — Phase-specific checks

| Phase | Check |
|---|---|
| `FF_SESSIONS` (1) | Session cookie set on login (`/api/session` 200, `mla_session` cookie present). Admin `POST /admin/login` still works. |
| `FF_INSTALLS` (2) | `/api/installs` returns 200 for a signed-in account. Existing `cfg:` install links still resolve. |
| `FF_V2_LISTS_READ` (3) | Run the read-consistency test: a sample of 10 accounts' lists match between old and new reads. `/admin` → Lists v2 → *Check results* shows no failed accounts. |
| `FF_V2_LISTS_API` (4) | `POST /api/lists/:id/items` (add an item) appears on the list page immediately. A legacy `POST /api/creator/lists/save` shim write also shows up. |
| `FF_V2_LISTS_ONLY` (5) | No `creatorlist:` KV keys written after this point. Confirm with Analytics Engine `double8 = 0` in each subsequent data point. |
| `FF_EVENT_TRACKING` (6) | At least one account's Watch History is served from `DB_ACTIVITY`. `creatorsynctracking:` KV key for that account stops updating. |

---

## Step-by-Step Procedure

### Phase 1 — `FF_SESSIONS` (Day 0)

**Purpose:** session-based auth for `/api/creator/*` routes; old key-in-body auth still accepted
during the overlap.

1. Confirm Gate A and Gate B prerequisites (see Prerequisites above).
2. Worker → Settings → Variables and Secrets → Add → type **Text**, name `FF_SESSIONS`, value `1`.
3. Deploy `worker_entry_combined.js` (paste in dashboard).
4. Smoke test:
   - `POST /api/session` with valid credentials → 200, `mla_session` cookie present.
   - `POST /api/creator/sync/load` with the old key-in-body credentials → still 200.
   - `/admin` login still works.
5. Watch Gate B metrics for 30 minutes.
6. Note the flip date. Gate C: confirm session cookie on next business day.
7. **60-day sunset clock starts:** key-in-body auth, `/api/creator/sync/*` shims, `/api/resolve`,
   SHA-256 key lookups, legacy scrobble `config=`/`key=` forms, `LEGACY_UNVERIFIED_CONFIG_SHELVES`,
   and list tombstones for old clients are all announced as deprecated as of this date (see
   [P10-2: In-App Sunset Announcements](#p10-2-in-app-sunset-announcements)).

---

### Phase 2 — `FF_INSTALLS` (Day 7)

**Purpose:** enables `/api/installs` (create, rename, rotate, remove `/i/{token}` install links)
for signed-in accounts.

1. Confirm Gate A, Gate B (seven clean days since Day 0).
2. Worker → Settings → add `FF_INSTALLS` = `1`. Deploy.
3. Smoke test: signed-in account can create and rename an install link at `/api/installs`.
4. Gate B: 30 minutes metrics watch.

---

### Phase 3 — `FF_V2_LISTS_READ` (Day 14)

**Purpose:** dashboard, list pages, catalogs, directory, search, shared channels, and Explore
Channels all read from D1 v2 tables. Every change is still written to the old storage first.
Turning this off is safe if needed; turning off `FF_V2_LISTS_ONLY` is not.

**Before flipping:**

1. Run *Start over* in `/admin` → Lists v2. Let it finish (status: *Done*).
2. *Check results*: no accounts in progress, no failed accounts you have not examined, few
   items not carried (< 1%, or each explained).
3. Confirm `BLOBS` R2 bucket is bound.
4. Gate A: no pending `migrate.lists` jobs.

**Flip:**

5. Worker → Settings → add `FF_V2_LISTS_READ` = `1`. Deploy.
6. Open your own dashboard and a public list page. Confirm the data matches expectations.
7. Gate B: 30 minutes metrics watch.
8. Gate C: run the read-consistency spot check (10 accounts).

---

### Phase 4 — `FF_V2_LISTS_API` (Day 21)

**Purpose:** enables `/api/lists` item-level API and `/api/likes` over the new tables.

1. Seven clean days since Day 14.
2. Worker → Settings → add `FF_V2_LISTS_API` = `1`. Deploy.
3. Smoke test: add an item via `POST /api/lists/:id/items`; confirm it appears.
4. Gate B: 30 minutes.

---

### Phase 5 — `FF_V2_LISTS_ONLY` (Day 28) ⚠️ ONE-WAY

**Purpose:** stops writing to old list/channel storage. The v2 tables are the only store.

**This is irreversible. Do not proceed until you are certain.**

**Before flipping:**

1. `FF_V2_LISTS_READ` has been on for at least a week with no reports of wrong data.
2. Run *Start over* in `/admin` → Lists v2. Let it finish.
3. *Check results*: every account copied, none in progress, none failed.
4. Take a D1 Time Travel backup.
5. Gate A: no pending migrate jobs.

**Flip:**

6. Worker → Settings → add `FF_V2_LISTS_ONLY` = `1`. Deploy.
7. Make a test save to a list. Confirm the `creatorlist:` KV key is **not** updated (check
   with `wrangler kv key get --binding=CONFIGS "creatorlist:{yourUsername}:{yourListSlug}"`).
8. Analytics Engine: confirm `double8` = 0 in each data point from this moment on.
9. Gate B: 30 minutes. Gate C: old KV key check.

---

### Phase 6 — `FF_EVENT_TRACKING` (Day 35) ⚠️ ONE-WAY PER ACCOUNT

**Purpose:** watch history, show progress, and hidden/finished states are read from and written
to `DB_ACTIVITY` for each account whose history copy has finished.

**Before flipping:**

1. `DB_ACTIVITY` (`mylists-activity`) is bound and all activity migrations applied (A0001).
2. Migration `0017` and `0020` applied to main `my-lists-db`.
3. Run *Start over* in `/admin` → Activity → Copy watch history (after migration `0020` is applied).
   Let it finish.
4. *Check results*: no failed accounts, no account with fewer plays than its old history
   that you cannot explain.
5. Take a D1 Time Travel backup of both databases.
6. Export `creatorsynctracking:` KV keys to R2 for archival (see [P10-3](#p10-3-legacy-kv-export--retirement)).

**Flip:**

7. Worker → Settings → add `FF_EVENT_TRACKING` = `1`. Deploy.
8. Open a tracked account's Watch History. Confirm it shows the correct history from `DB_ACTIVITY`.
9. Scrobble a play. Confirm the `creatorsynctracking:` KV key does **not** change.
10. Gate B: 30 minutes. Gate C: spot check one account's history.

---

## Rollback Procedures

### Reversible flags (1–4)

To roll back `FF_SESSIONS`, `FF_INSTALLS`, `FF_V2_LISTS_READ`, or `FF_V2_LISTS_API`:

1. Worker → Settings → Variables and Secrets → delete the flag. Deploy.
2. The old code paths resume immediately. No data is lost (both stores were written throughout).
3. Gate B: confirm metrics return to baseline.

### `FF_V2_LISTS_ONLY` — cannot be rolled back

If a critical bug is found:
1. Do NOT delete `FF_V2_LISTS_ONLY`.
2. Revert the Worker code to the previous `worker_entry_combined.js` (the one that still wrote
   the old storage). Deploy.
3. The old code will not turn off the flag — it will just start writing both stores again.
4. File a bug. Do not turn off the flag; fix the bug and redeploy.

### `FF_EVENT_TRACKING` — cannot be fully rolled back per account

If a critical bug is found:
1. Delete `FF_EVENT_TRACKING`. Deploy. Accounts whose old records are still current will read
   them. Accounts that accrued new plays in `DB_ACTIVITY` only will show stale data until you
   restore from the Time Travel backup taken before Phase 6.
2. Contact Cloudflare Support if Time Travel restoration is needed.

---

## P10-2: In-App Sunset Announcements

When Phase 1 (`FF_SESSIONS`) flips, the **60-day sunset clock** starts for the following legacy
behaviours. Set `SUNSET_60DAY_START_DATE` in the Worker environment to the Day 0 date
(`YYYY-MM-DD`). The Worker uses this to calculate whether the 60-day window has elapsed and to
show the appropriate in-app banner. See `docs/OPERATIONS.md` §3 for the variable.

| Legacy feature | Announced at | Removed at |
|---|---|---|
| Key-in-body auth (`/api/creator/*` with `creatorKey` in body) | Day 0 | Day 60 |
| `/api/creator/sync/*` shims | Day 0 | Day 60 |
| `/api/resolve` route | Day 0 | Day 60 |
| `LEGACY_UNVERIFIED_CONFIG_SHELVES` | Day 0 | Day 60 |
| Scrobble `config=` / `key=` forms | Day 0 | Day 60 |
| SHA-256 key lookups (`creator_key_lookups` table) | Day 0 | Day 60 |
| List tombstones for old clients | Day 0 | Day 60 |

> **Do not set `SUNSET_60DAY_START_DATE` yet (2026-10-04).** The site's own page still signs its
> sync requests with the key in the body and calls `/api/creator/sync/*`, so the notices would
> tell every visitor that the page they are using is going away, and removing those routes on
> Day 60 would break it. The page must first move to the session routes. When the date is set,
> the page shows visitors only the one notice they can act on (the media server webhook address);
> the others are for people with their own scripts.

---

## P10-3: Legacy KV Export & Retirement

> **Rewritten 2026-10-04.** The first version of this section would have lost data. Its delete
> list named KV prefixes and D1 tables that the code running on the live site still reads and
> writes (checked by search, 2026-10-04: every one of them), several of its prefixes used `*`,
> which KV treats as a literal character, so those exports would have copied nothing, and the
> admin button it named did not exist. Only Steps 1 and 2 below are safe to do today.

### Step 1 — Copy KV prefixes to R2 (safe at any time; deletes nothing)

`/admin` → Maintenance → **Export old data to R2 (a copy)**. Type one prefix exactly as below —
no `*` — and press the button once; the page keeps going until the whole prefix is copied, then
shows how many keys it copied. Each run writes, in the `BLOBS` bucket:

- `kv-archive/{prefix}/{runId}/part-00001.json.gz`, `part-00002…` — 50 keys each, gzipped JSON
  `{prefix, runId, part, entries: [{key, text | base64, expiration?, metadata?}]}`. A value that
  is not text (a Better Poster image under `bpimg:`) is kept byte for byte as `base64`.
- `kv-archive/{prefix}/{runId}/manifest.json` — written **last**, only when every part is in:
  `{prefix, runId, parts, keys, completedAt}`. A run without a manifest did not finish; run the
  prefix again (it starts a new `runId` and leaves the old parts alone).

Prefixes worth a copy (one run each):

```
creator:              creatorsync:          creatorsynctracking:
creatorsyncpresets:   creatorlist:          creatorlistorder:
creatorliststamp:     creatorlistdeleted:   creatorshare:
listlikevoters:       extlikevoters:        externallike:
channellikevoters:    channelshare:         creatortrack:
creatorscrobblequeue: feedback:             stats:
```

Short-lived keys (`ratelimit:`, `authfail:`, `cron:`, `trackingd1behind:`, `airingnextchecked:`)
expire by themselves and need no copy. `bpimg:` is a cache of Better Poster images; copy it only
if you want the images.

### Step 2 — Check the D1 backup

`Actions → D1 backup → Run workflow` and confirm it went green (docs/OPERATIONS.md §20). This is
the copy of every table; nothing in D1 is dropped by this phase.

### Step 3 — Delete KV keys — ⛔ DO NOT RUN YET

Every prefix in Step 1 is still read or written by the live code (2026-10-04). Deleting one
removes data the site shows or depends on: accounts (`creator:`), settings and history
(`creatorsync:`, `creatorsynctracking:`), share codes (`creatorshare:`, `channelshare:`), likes,
feedback, the admin counters (`stats:`), and Better Posters (`bpimg:`). A prefix may be deleted
only after a release has removed **every** reader of it, that release has run for 30 days, and
its Step 1 copy has a manifest. Each such deletion gets its own entry in docs/RELEASES.md, with
the literal prefix and the command; there is no bulk delete.

**Keep `cfg:` records** — until every install whose `legacy_cfg_id` is set has been served from D1
for 30 days. Delete them one-by-one as `installs.legacy_cfg_id` rows age out, not in bulk.

### Step 4 — Drop legacy D1 tables — ⛔ DO NOT RUN YET

These tables are all still queried by the live code (2026-10-04), so dropping any of them breaks
the site, and D1 Time Travel is the only way back:

```
creators            creator_key_lookups   creator_tombstones    list_tombstones
creator_lists       published_lists       list_likes            creator_user_lists
creator_show_states creator_tracking_meta continue_watching     airing_next
watch_history       scrobble_tokens       source_groups         event_meta
```

A table may be dropped only after a release has removed every query of it and run for 30 days,
with a backup from Step 2 taken after that. Each drop is its own numbered migration recorded in
docs/RELEASES.md. The `stats` table is **kept**: it is where the admin dashboard's counters live
(docs/DECISIONS.md D-33).

---

## P10-4: Remove Admin Migration Tools

After Phase 10 is complete and no remaining migration job can be triggered:

Remove from `26_api-creator-and-admin-routes.js`:
- `/admin/api/migrate-d1` route and its handler (FT-16)
- `/admin/api/migrate-day-counts` route and its handler
- `/admin/api/backfill-trending` route and its handler (FT-42)
- `/admin/api/rebuild-search-index` and `/admin/api/rebuild-public-index` routes and handlers

**Keep `ensureTrackingMigrated`** (`05_catalog-core.js`) and its call sites. P10-4 emptied it once
(2026-10-01); that let `/api/creator/sync/save` erase the watch history of any account whose
tracking still sat inside its `creatorsync:` record. It was restored on 2026-10-04 and goes only
together with the `creatorsync:` tracking fields themselves (see P10-3, Step 3).

Remove from `03_admin.js`:
- `migrateGenreDecadeStatsIfNeeded` function definition and its call site
- `backfillCreatorLastActive` function definition and its call site (BE-M19)

After removal: `python build.py && python check_sync.py && node --check worker_entry_combined.js && python gen_map.py && node --test tests/*.test.mjs`.

---

## Post-Cutover Checklist

- [ ] All six flags are on and have been stable for 7+ days each.
- [ ] Sunset 60-day clock has elapsed; legacy auth removed.
- [ ] KV prefixes copied to R2, each with a `manifest.json`.
- [ ] Legacy KV keys deleted — prefix by prefix, each only after a release removed its readers.
- [ ] Legacy D1 tables dropped — table by table, likewise.
- [ ] `cfg:` records cleaned up (30-day per-install window).
- [ ] Admin migration tools removed from source.
- [ ] `FUNCTION-MAP.md` regenerated (`python gen_map.py`).
- [ ] `CHANGELOG.md` updated with Phase 10 completion entry.
- [ ] `docs/OPERATIONS.md`, `docs/ARCHITECTURE.md`, `README.md` updated for v2 steady state.
- [ ] Planning documents archived to `docs/history/` (P10-5).

---

## Reference

- [`docs/OPERATIONS.md`](OPERATIONS.md) — day-to-day ops, flag descriptions, individual feature sections.
- [`docs/DEPLOY_CHECKLIST.md`](DEPLOY_CHECKLIST.md) — per-release deploy gate procedure.
- [`docs/STAGING.md`](STAGING.md) — staging environment isolation and provisioning.
- [`MIGRATION_PLAN.md`](../MIGRATION_PLAN.md) — full v2 migration plan (to be archived after Phase 10).
- [`CHANGELOG.md`](../CHANGELOG.md) — release history.
