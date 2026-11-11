# 06 Database and data
Health grade: B+ — schema, code and backups line up well (691 of 691 checkable SQL statements prepare cleanly; D1 dump restores row-for-row), with one real data-retention gap on account deletion, one partial-write bug, and a hot-path table scan.
## Scope covered (files, routes, commands run)
- Schema vs code: `s06/sqlcheck.mjs` pulled 718 SQL string literals out of every `src/**/*.js` file and prepared them against schema.sql and schema_activity.sql in node:sqlite: 691 prepare cleanly; the 27 that "fail" were all inspected and are extraction artefacts (dynamic `${...}` pieces, a statement split over concatenated strings, or the intentionally-guarded legacy `ALTER TABLE support_messages` at src/admin/59_support-emails.js:441). The dynamic table/column pairs (`likes.js`, `anonymous-likes-purge`, `d1ReplaceRowsById`, admin row counts, `mediaRefCounts`) were prepared by hand with the real names (`s06/dyn.mjs`): all valid. `s06/scan.mjs` ran EXPLAIN QUERY PLAN on 447 static statements to find full scans on large tables. `s06/fk.mjs` listed foreign keys, missing keys, AUTOINCREMENT and triggers.
- Migrations: `s06/mig.mjs` (from empty, twice), `s06/mig2.mjs` (from a seeded pre-0001 base, twice, diff of normalised sqlite_master and columns against schema.sql), `s06/interrupt.mjs`. Main chain 0001a..0025 and activity chain A0001..A0003. Read wrangler.toml for a migrations_dir (none) and searched src for any runtime runner (none; only a read-only ledger check).
- Integrity / dual writes: `purgeCreatorData` and `purgeAccountRowsById` read in full; fault injection with the harness (`failWhen`) on `/api/creator/sync/save`; concurrency race on the same route (`s06/race.mjs`); every `DELETE FROM` in `src/` listed and the prune/cron cutoffs checked (streaming_events, sessions, title_daily_stats, admin_audit_log, tombstones, rate_counters).
- Backup: `.github/workflows/d1-backup.yml`, `.github/scripts/d1-backup.mjs`, `kv-backup.mjs` read; the repo's own `dumpDatabase` was run against a database seeded through the real Worker and restored into an empty SQLite, comparing every table incl. rowids (`s06/d1rt.mjs`). Browser "config JSON" export (`src/client/24_client-backup-restore-presets.js`, `buildFullBackupPayload`) read for what it contains.
- Commands: all Node scripts live in `/tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s06/`. No repo file other than this report was touched; verify.sh and build.py were not run.
## Fix progress

Updated 2026-11-10. Status values: `open`, `fixed (awaiting verification)`, `verified fixed`, `open (partially fixed, ...)`, `regression introduced (...)`. Rows marked in the Verified column were checked by an independent review on 2026-11-10; see each finding's **Verification.** note.

| Finding | Status | Commit | How to verify | Verified |
|---|---|---|---|---|
| DB-01 | verified fixed | a1ecc1f | node --test tests/account-purge.test.mjs | 2026-11-10, independent review |
| DB-02 | verified fixed | e5110e0, 59b1a77, 008798e, 4cdb8d0 | node --test tests/creator-user-lists-save.test.mjs | 2026-11-11, independent review |
| DB-03 | verified fixed | 35f1c3f | node --test tests/accounts-key-hash-index.test.mjs. Live: apply migrations/0026_accounts_key_hash_index.sql. | 2026-11-10, independent review |
| DB-04 | open |  |  |  |
| DB-05 | open |  |  |  |
| DB-06 | open |  |  |  |

## Proven findings

### DB-01 Deleting an account leaves its resume positions and Nuvio "removed plays" behind, and the next account with the same id inherits them
- Severity: Medium
- Status: Proven
- File:line: src/jobs/51_account-purge.js:40-62 (purgeAccountRowsById, the activity-DB batch at lines 58-63); tables defined in schema_activity.sql:113-135 (`watch_positions`, `watch_events_removed`)
- What is wrong: The account-deletion sweep clears `watch_event_sources`, `watch_events`, `show_progress` and `user_media_state` in the activity database, but not the two tables added later by migrations A0002/A0003: `watch_positions` (where each title was paused, per app) and `watch_events_removed` (plays the person deleted in Nuvio, kept 30 days). Neither table has a foreign key (separate database, so none is possible) and `accounts.id` is `INTEGER PRIMARY KEY` without AUTOINCREMENT, so SQLite hands the highest deleted id to the next sign-up. The code comment at the top of that file says exactly this reuse is why the purge must be complete.
- Impact: (1) A deleted person's viewing data is not actually deleted (privacy promise broken; `watch_events_removed` is only trimmed when that same account id later syncs). (2) The next person to register after the highest-id account was deleted gets that account id and with it the old person's resume positions and removed-play records. Those feed that stranger's "resume" points and can be pushed to their Nuvio.
- Proof: `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s06/purge_positions.mjs` (uses the repo's own harness, real Worker, DELETE /api/me then the queued account.purge job drained):
```
delete status 202 | old account id 1 | accounts row left: 0
AFTER DELETE watch_events: 0
AFTER DELETE watch_positions: 1
AFTER DELETE watch_events_removed: 1
new stranger account id 1 (same as deleted one: true )
stranger sees watch_positions rows: 1
```
  The existing test `tests/account-purge.test.mjs` only asserts `watch_events` and `show_progress`, so it cannot notice (its helper `assertNothingLeft` never looks at the two tables).
- Recommended fix and effort: add `DELETE FROM watch_positions WHERE account_id = ?` and `DELETE FROM watch_events_removed WHERE account_id = ?` to the batch in purgeAccountRowsById, and extend `assertNothingLeft`. S.

**Verification.** 2026-11-10, independent review: **verified fixed**. Read a1ecc1f. Mutations on HEAD: disabling the new `watch_positions` DELETE, or the `watch_events_removed` DELETE, each fail `tests/account-purge.test.mjs` (3 pass, 4 fail). The re-used-id test also checks both tables for the new account.

### DB-02 Saving liked/hidden lists rewrites the D1 copy in several separate batches; a failure part-way leaves a truncated list, the route says "ok", and that truncated copy then wins on load
- Severity: Medium
- Status: Proven (by fault injection; the failure itself is the injected part)
- File:line: src/core/02_http-and-creator-utils.js:6886-6932 (`saveCreatorUserListsD1`, chunk loop at 6923-6925); caller src/api/68_creator-api-account-and-save-routes.js (`creatorApiSyncSave`, the call at line 390 ignores the return value); reader src/api/69_creator-api-sync-routes.js:310 and 325-331
- What is wrong: The save is "DELETE every row of the account, then INSERT each liked/hidden/hidden-section id", cut into batches of 80 statements. Each batch is atomic but the batches are not atomic together, and the DELETE lives in batch 1. If batch 2 (or later) fails, batch 1 is already committed: the account is left with only the first ~79 ids. The function returns `false`, but the route ignores it, goes on to write the full list to KV and answers `ok:true`. On load, `/api/creator/sync/load` replaces the KV lists with the D1 rows whenever D1 returns any row, so the truncated copy wins.
- Impact: Anyone with more than ~79 liked + hidden entries (heavy users) can silently lose the rest of those entries after one transient D1 error. The next device that signs in is handed the short list and its next autosave uploads it, which makes the loss permanent (KV is overwritten too). Two devices saving at the same moment can also interleave batches and mix stale and new ids.
- Proof: `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s06/chunk.mjs` (real Worker, harness `failWhen` makes only the insert of the 101st id fail, i.e. the second batch):
```
save #1 200 true | D1 rows: 120
save #2 (2nd D1 batch fails) 200 ok = true
D1 rows now: 79 | KV copy has: 120
sync/load returns likedLists: 79
```
- Recommended fix and effort: do not delete first. Insert-or-ignore the incoming ids, then delete only the ids no longer present (the pattern `d1ReplaceRowsById` already uses for tracking rows, 02_http-and-creator-utils.js around line 6120), and check the return value (report an error or set a "D1 behind" marker). M.

**Verification.** 2026-11-10, independent review: **verified fixed**. Read e5110e0. The new test fails against the parent commit (1 pass, 1 fail). The save is now insert-or-ignore first and stale rows are deleted last, so a failed later batch leaves extra ids, never a short list. A failed write answers `ok:false`. Behaviour change worth knowing: when D1 cannot be written (or read: the new SELECT runs first), the whole sync save now answers 500 and the KV copy (config included) is not written. Before, the config still reached KV. The client is told and can retry; this is what the finding suggested (`report an error`).

**Verification (second independent review, 2026-11-10): regression introduced.** I agree that the truncation is fixed, but not that "the client is told and can retry". `pushCreatorSync` (src/client/22_client-creator-profile.js:2547-2593) only looks at a 409. On an `ok:false` 500 it does nothing: no message, no retry. The edit goes up again only with the person's next edit. Probe through the real Worker, failing only the `creator_user_lists` statements: a save that adds a row answers 500, and `creatorsync:<user>` in KV still holds the old rows. With the parent commit, the same save answered 200 and KV held the new row. So during a fault in that one side table, a row someone adds never reaches their Stremio/Nuvio/Wako install link, and the page does not say so. Needed: write the KV record even when the liked-lists D1 copy fails (that copy can no longer be shorter, only have extra ids) and report the D1 failure separately; or make the client show the failure and retry. Status changed to `regression introduced`.

**Verification (third independent review, 2026-11-10): partially fixed.** Read 59b1a77. The second review's regression is gone: with the `creator_user_lists` writes failing, the save answers 200 `ok:true, likedListsSynced:false` and the new config row reaches `creatorsync:<user>` in KV; the new test fails against the parent (1 pass, 2 fail). Truncation of a long list stays fixed. **What is still wrong:** the commit's premise, "the D1 copy can only fall behind (extra ids, never fewer)", holds only for removals. A failed insert leaves a new like out of D1, and `/api/creator/sync/load` (src/api/69_creator-api-sync-routes.js:325-331) still replaces the KV lists with the D1 rows whenever D1 has any row. Probe through the real Worker, failing only writes to `creator_user_lists`: liked `[L1,L2]`, then a save of `[L1,L2,L3]` answers ok with `likedListsSynced:false`; KV holds `[L1,L2,L3]` but load returns `[L1,L2]`. An unlike of L1 made during the fault comes back on load the same way. The client does not read `likedListsSynced` (no code in `src/` reads it), so the page says nothing, and its next save uploads the shorter list, making the loss permanent: the finding's "the stale copy then wins on load" in a smaller form. Fix: when the D1 write fails, mark the D1 copy as behind (for example a KV marker or the KV blob's `updatedAt` newer than D1) and have load prefer KV until a D1 write succeeds; or have the client retry on `likedListsSynced:false`. Status set back to `open`.

**Verification (fourth independent review, 2026-11-11): partially fixed.** Read 008798e. For `/api/creator/sync/save` the third review's case is fixed: with writes to `creator_user_lists` failing, a save of `[L1,L2,L3]` sets `likedListsD1Behind` in KV and load returns `[L1,L2,L3]`; an unlike during the fault stays removed; once D1 is back the next save clears the marker and D1 catches up. The new test fails against the parent (3 pass, 1 fail). Truncation of a long list stays fixed. Other inputs: a later successful `/sync/like` keeps the marker (it rewrites the blob it read), so load still prefers KV, which is right. **What is still wrong:** the same root cause has a second writer that was not changed. `creatorApiSyncLike` (src/api/69_creator-api-sync-routes.js:661-676, the heart on a list page, called from src/client/19_client-search-and-likes.js:1814 and :1904) writes D1 first, swallows a D1 error with `console.error`, then writes KV without setting `likedListsD1Behind`. Probe through the real Worker, failing only writes to `creator_user_lists`: liked `[L1,L2]`, then a like of L3 on a list page answers 200 `ok:true`, KV holds `[L1,L2,L3]`, load returns `[L1,L2]`; an unlike of L1 the same way comes back on load. The builder's next autosave then uploads the stale list. Fix: in `creatorApiSyncLike`, set `blob.likedListsD1Behind = true` when the D1 write fails (the same marker), and add a test for the like route under the same fault. Minor: load now returns `likedListsD1Behind` to the browser; harmless, since save rebuilds the blob from named fields. Status set back to `open`.

**Verification (fifth independent review, 2026-11-11): verified fixed.** Read 4cdb8d0. `creatorApiSyncLike` (src/api/69_creator-api-sync-routes.js:674) now sets `likedListsD1Behind` when its D1 write fails, the same marker the full save sets. A search for writers of `creator_user_lists` and of the `creatorsync:<user>` blob found no third writer that could drop the marker (the others are the full save, the account purge and the new-account seed). Probe through the real Worker, writes to `creator_user_lists` failing: liked `[L1,L2]`, a list-page like of L3 answers 200 and load returns `L1,L2,L3` (D1 still `L1,L2`); an unlike of L1 then loads as `L2,L3`. Other inputs: a healthy like after the fault keeps the marker and load stays right (`L2,L3,L4`); the next full save clears it, D1 catches up (`L2,L3,L4`) and a later like goes to D1 normally; only the DELETE failing (unlike L2) loads `L1`; hidden lists and hidden sections survive a like under the fault. The new test fails against the parent with only the test added (5 pass, 1 fail). Truncation of a long list (the original finding) stays fixed.

### DB-03 Every Stremio/Nuvio manifest request scans the whole `accounts` table
- Severity: Medium (cost and latency that grow with the number of accounts; nothing breaks at today's size)
- Status: Proven
- File:line: src/api/70_stremio-routes.js:139 (call) and :554-562 (`loadUserChannelsForManifest`); the same statement is repeated at src/api/70_stremio-routes.js:604 (`findChannelEntryById`, used by channel catalog/stream requests) and src/api/25_api-catalog-routes.js:598
- What is wrong: The lookup is `SELECT username FROM accounts WHERE username = ? COLLATE NOCASE OR id = ? OR key_hash = ? LIMIT 1`. `accounts` has no index on `key_hash` (only the automatic ones on `username` and `key_lookup_hmac`), so SQLite cannot use its "OR via several indexes" shortcut and reads every row. The value passed in is the install token, which matches none of the three columns, so the scan always runs to the end (LIMIT 1 never helps) and only then does the code try the `installs` table, which IS indexed.
- Impact: Each manifest fetch (an app does this on install and on every refresh), and every channel catalog request, reads the whole accounts table. D1 bills rows read and slows with table size: at 100,000 accounts that is 100,000 rows read per manifest request.
- Proof: `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s06/manifestscan.mjs` and `node .../s06/plans.mjs`
```
manifest status 200 | accounts rows in table: 50001
times the OR-scan statement ran for ONE manifest request: 1
that statement alone, no match, ms: 3.82        (username-only lookup: 0.05 ms)
EXPLAIN QUERY PLAN  SELECT username FROM accounts WHERE username = ? COLLATE NOCASE OR id = ? OR key_hash = ? LIMIT 1
   -> SCAN accounts
EXPLAIN QUERY PLAN  SELECT account_id FROM installs WHERE legacy_cfg_id = ? OR token_hash = ? OR id = ?   -> MULTI-INDEX OR (indexed)
```
- Recommended fix and effort: try the install token first (indexed), and only fall back to accounts with three separate indexed lookups (or add an index on `accounts(key_hash)` through a new migration plus schema.sql). S.

**Verification.** 2026-11-10, independent review: **verified fixed**. Read 35f1c3f. All three copies of the lookup (`70_stremio-routes.js` x2, `25_api-catalog-routes.js`) dropped the redundant `COLLATE NOCASE` (the column is NOCASE, so a case-insensitive match still works). schema.sql and migration 0026 add `idx_accounts_key_hash`, and `D1_SCHEMA_MANIFEST` lists it. The new test fails against the parent commit and checks the query plan both from schema.sql and after applying the migration twice to an older database.

### DB-04 Deleting an account makes SQLite scan the whole `lists` and `channels` tables
- Severity: Low (rare operation; grows with data)
- Status: Proven (query plans)
- File:line: src/data/34_lists-v2-bridge.js:856, 858, 870 (`WHERE owner_account_id = ?` on `lists`); src/jobs/51_account-purge.js:88 and :102 (`channels`); schema.sql:425-428 (lists indexes), :495-496 (channels indexes); migrations/0025_lists_owner_deleted_index.sql
- What is wrong: Every index that starts with `owner_account_id` on `lists` is partial (`WHERE deleted_at IS NULL` or `IS NOT NULL`), and on `channels` the owner indexes are partial or need a second column. A query that filters only on the owner cannot use a partial index, and neither can the foreign-key cascade SQLite runs for `DELETE FROM accounts`. Migration 0025 added the "deleted" half but a query without a `deleted_at` condition still cannot use either half.
- Impact: Deleting one account reads every list and every channel in the database (several times: cascade + purge steps). Fine today, slow and expensive at hundreds of thousands of lists, and the purge job is retried on failure.
- Proof: `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s06/plans.mjs`
```
SELECT id FROM lists WHERE owner_account_id = ?   -> SCAN lists
DELETE FROM accounts WHERE id = ?   -> ... SCAN channels ... SCAN lists ...
```
- Recommended fix and effort: one plain (non-partial) index each on `lists(owner_account_id)` and `channels(owner_account_id)` in a new migration and in schema.sql. S.

### DB-05 The "database is behind, refuse writes" safety gate stops at migration 0014, and the migration ledger skips 0022 and 0023
- Severity: Low
- Status: Proven
- File:line: src/core/00_constants.js:869 (`REQUIRED_SCHEMA_VERSION = "0014"`), src/core/02_http-and-creator-utils.js:409-435 (gate); migrations/0022_feedback_creator_name.sql and migrations/0023_media_app_sync.sql (no `INSERT ... schema_migrations`), compare schema.sql, which does record both
- What is wrong: The Worker only refuses writes when the database ledger is older than 0014, yet the code now depends on migrations up to 0025 (accounts, sessions, lists v2, activity, media sync...). A database that stopped at 0014..0024 gets no 503 "being updated" and the Worker runs against missing tables, relying on per-feature fallbacks. Separately, 0022 and 0023 never write their ledger row, so a database built from the migration files has a ledger of `... 0021 0024 0025` while a database built from schema.sql lists all of them; the ledger cannot be used to tell whether 0022/0023 ran.
- Impact: Forgetting to run a recent migration after a deploy is not caught by the gate (the admin "schema" panel, which inspects tables directly, does notice). Support-history lookups (0022) and Stremio/Nuvio sync (0023) quietly degrade until someone looks.
- Proof: `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s06/gate.mjs` (ledger rewound, then POST /api/creator/create) and `node .../s06/mig2.mjs`
```
ledger top 0013 -> status 503 {"ok":false,"maintenance":true,...}
ledger top 0014 -> status 200 {"ok":true,"creatorName":"gatetest0014",...}
ledger top 0016 -> status 200 ...
ledger mig: 0001a ... 0021 0024 0025            (0022 and 0023 missing)
ledger sch: 0001a ... 0021 0022 0023 0024 0025
```
- Recommended fix and effort: raise `REQUIRED_SCHEMA_VERSION` only to a migration the code truly cannot run without (the current code needs 0015/0016 at least), and add the ledger INSERT to 0022 and 0023 (a new 0026 can backfill the two rows). S.

### DB-06 Several migrations cannot be safely re-run after an interruption, and the migration files cannot build a database from empty
- Severity: Low (operational trap; the owner applies migrations by hand in the D1 console)
- Status: Proven
- File:line: migrations/0008_add_list_tombstones_and_creator_columns.sql (3 ALTERs then a table), 0012_add_airing_next_removals.sql (2 ALTERs), 0024_scrobble_token_hash.sql (2 ALTERs, index, ledger row); no migration creates `creators`, `creator_lists` or `source_groups` (they exist only in schema.sql:13-50)
- What is wrong: `ALTER TABLE ... ADD COLUMN` fails if the column exists. 0001a was split into two files for exactly this reason, but 0008, 0012 and 0024 still put several ALTERs in one file. If the console or `wrangler d1 execute` stops after the first one, re-running the file stops at the first ALTER, so the second column, the index and the ledger row are never created and the file tells the owner nothing about how to continue. There is also no migration runner anywhere (no `migrations_dir` in wrangler.toml, nothing in `src/`): every migration is applied by hand. And the chain cannot be replayed from an empty database (`0001a`, `0003`, `0008` fail with "no such table: creators/creator_lists"); only schema.sql can create a fresh database.
- Impact: A half-applied 0024 leaves `scrobble_tokens.token_enc` missing; the Worker silently keeps the old behaviour (plain-text webhook tokens in the database, which is what 0024 was written to stop). Disaster recovery from "migrations only" is impossible; it must be schema.sql plus a D1 backup.
- Proof: `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s06/interrupt.mjs` and `node .../s06/mig.mjs`
```
RE-RUN OF WHOLE FILE FAILS: duplicate column name: token_hash
token_enc column present: false
unique index present: false
ledger has 0024: false
...
PASS 1 FAIL 0001a_add_likes_column.sql: no such table: creator_lists
PASS 1 FAIL 0003_add_missing_indexes.sql: no such table: main.creators
```
  With a seeded pre-0001 base, the full chain reproduces schema.sql exactly except two base indexes (`idx_creator_lists_username`, `idx_creator_lists_visibility`) that no migration creates (`.../s06/mig2.mjs`: `ONLY schema.sql index:idx_creator_lists_username`). Databases created by migrations rather than schema.sql lack those two indexes.
- Recommended fix and effort: one ALTER per file (as 0001a/0001b do) or a note in each header saying which statement to resume from; add the two missing base indexes in a new migration. S.

## Unproven suspicions (not counted)
- U1 KV staleness defeats the sync conflict guard. `creatorApiSyncSave` (src/api/68_creator-api-account-and-save-routes.js) reads `creatorsync:{user}` from KV, compares `updatedAt` with `expectedUpdatedAt`, then writes. KV reads can be up to about a minute out of date in another location, so two devices in different regions could both pass the check and the later write silently wins. In-process the guard works (`s06/race.mjs`: one of two simultaneous saves got 409), and a stale read cannot be reproduced locally. Older clients that send no `expectedUpdatedAt` are last-write-wins by design.
- U2 The D1 dump reads one table after another, not one snapshot (acknowledged in the script; only the "child row without parent" race is retried). Counter-type tables (stats, likes counts) can be a few seconds inconsistent with the rows they summarise. Not shown to cause data loss.
- U3 Data held only in KV that the KV backup does not copy: the `creatorsynctracking:` blobs (accounts whose tracking has not yet moved to D1/activity; the D1 side carries a "behind" flag, `trackingD1BehindKey`, when it lags KV), and legacy anonymous `publishedlist:user:*` records (only in the lists v2 table once the backfill has run). I did not find an account in either state to prove loss.
- U4 The browser "Export config JSON" file is built from this browser's localStorage, not from the account on the server. For an account whose lists/channels live server-side (v2 lists), the export is only as complete as what the page has loaded. I did not run it in a browser, so I cannot say what is missing from it.

## Checked and rejected
- "Queries reference columns that do not exist": rejected, see scope (no prepare error among 691 checked statements).
- "schema.sql and migrations drift": rejected for tables, columns and indexes (only the two base indexes in DB-06). The chain reproduces schema.sql exactly once the three base tables exist.
- "Account deletion leaves orphaned KV/D1 rows because most tracking tables have no foreign key": rejected for the legacy tables; `purgeCreatorData` deletes `watch_history`, `continue_watching`, `airing_next`, `creator_user_lists`, `creator_show_states`, `creator_tracking_meta`, `scrobble_tokens`, list rows and ~20 KV key families, and reports failure instead of freeing the username. The one gap found is DB-01 (activity tables).
- "LIKE-wildcard username purge" (underscore in a username matching other accounts): rejected, the purge uses `WHERE username = ?` and escapes the one remaining LIKE (02_http-and-creator-utils.js:4789-4790).
- "Prune jobs delete user data on a wrong cutoff": rejected. `streaming_events` pruning uses seconds on both sides (windowStart is `nowSec - days*86400`, last_event_at is stored in seconds) and only touches catalogue rows; sessions/rate_counters/tombstones prune only expired rows; `admin_audit_log` keeps the newest 5000 rows by design (03_admin.js:2074).
- "Two simultaneous sync saves both succeed": rejected in-process (one received 409). See U1 for the cross-region case.
- "D1 backup is not restorable (virtual tables, long rows, blobs)": rejected. Round trip of a real seeded main database (47 tables incl. FTS) and the activity database restored with 0 mismatching tables, rowids preserved; FTS content rebuilt from rows.
- "Backup unencrypted / skipped silently": rejected. The workflow fails on any missing secret, encrypts before upload, and verifies the dump restores before keeping it.
- Idempotency of schema.sql / schema_activity.sql: rejected as a problem, both re-run cleanly. Idempotency of migrations: only the ALTER-based files are not repeatable (DB-06), and they say so in their headers.

## Done well (do not change)
- schema.sql is complete, non-destructive and re-runnable, and matches the migration chain table for table.
- Account deletion is a tombstone-first, retried job with explicit failure reporting, and the code explains why the id-reuse risk exists (it is the reason DB-01 matters, and the rest of the sweep is thorough).
- The tracking-row sync (`d1ReplaceRowsById`) upserts first and deletes stale rows last, so a partial failure leaves extras rather than holes; DB-02 is the one place that did not follow this pattern.
- The D1 backup tool (page by page reads, long-row splitting, FTS handling, restore verification, encryption, loud failures) and the separate KV backup with an explicit prefix list.
- The test harness mimics D1's real limits (100 KB statement, 100 bound parameters, 2 MB row) and offers fault injection on both D1 and KV, which made the proofs here possible.

## Not audited and why
- R2 (channel pool blobs) versus D1 consistency on channel create/publish/delete: read only the delete side (51_account-purge.js); the write side was not fault-injected for lack of time.
- Lists v2 backfill re-run behaviour and `retireDeletedListCopies` when the legacy KV listing is partial: read, not fault-injected.
- Activity DB sharding (`ACTIVITY_SHARD_COUNT` > 1): only the single-database path was exercised.
- Production data volumes, real D1 limits and billing: everything here ran against SQLite in the harness; "rows read" costs are from query plans and timings, not from Cloudflare.
- The browser backup/restore round trip (Playwright) was not run; see U4. Restore of the encrypted artefacts from GitHub Actions needs the production passphrase and was not attempted.
