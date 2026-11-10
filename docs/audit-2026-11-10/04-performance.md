# 04 Performance and scalability
Health grade: (pending)
## Scope covered (files, routes, commands run)
(in progress)
## Proven findings
### PERF-01 Every play (scrobble) re-reads and re-diffs the account's whole watch history
- Severity: Medium (High for heavy accounts; see impact)
- Status: Proven
- File:line: src/data/40_event-tracking.js:139 (`assembleTrackingRecord`, reads the whole history), :255-300 (`saveTrackingRecord`, reads every `watch_events` id and re-checks them), :323 (`eventTrackingEnv`, the wrapper that makes every tracking read/write go through those two); history reader src/data/39_activity-shelves.js:481-490 (`watchHistoryAll`); progress rebuild src/data/37_activity-backfill.js:507 (`rebuildActivityProgress`).
- What is wrong (plain English): the website used to keep an account's whole "watch history" as one big record. When that moved to the activity database, a compatibility layer was added: any code that reads the old record gets the whole history rebuilt from the database, and any code that saves it triggers a full compare of the stored history against the sent one plus a rebuild of all show progress. The play-recording routes (Plex/Jellyfin/Emby webhook, subtitles ping) still read and write the old record, so ONE play of ONE movie causes work proportional to everything the account has ever watched, and all of it is done before the reply is sent.
- Impact: the cost of recording a single play grows linearly with the account's history. A person with 5,000 plays pays ~300 database round trips (~250 ms of pure Worker/SQLite time even with a zero-latency local database; on real D1 each round trip adds network time), and a person with about 18,000 plays goes past the 1,000-internal-calls-per-request ceiling Cloudflare documents for Workers (KV, D1 and other bindings count). The play code catches and logs errors, so past that point plays are likely to be silently dropped (I could not trigger the real Cloudflare ceiling here; the harness does not enforce it, so that last step is an inference, not proven). Typical users (under ~500 plays) are not affected: 30 to 40 statements.
- Proof: script `/tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s04/t8.mjs` (seeds N plays straight into the activity database for one copied account with the production flags FF_EVENT_TRACKING, FF_V2_LISTS_ONLY etc., then sends one Plex webhook play and counts every D1 statement). Run: `node .../s04/t8.mjs 1000 5000 10000 20000 30000`. Output:
```
history=1000  scrobble -> 200  60ms d1stmts=86   d1batches=3 kv=4/3 fetch=4 => approx subrequests=100
history=5000  scrobble -> 200 246ms d1stmts=303  d1batches=3 kv=3/3 fetch=4 => approx subrequests=316
history=10000 scrobble -> 200 391ms d1stmts=580  d1batches=3 kv=3/3 fetch=4 => approx subrequests=593
history=20000 scrobble -> 200 858ms d1stmts=1130 d1batches=3 kv=3/3 fetch=4 => approx subrequests=1143
history=30000 scrobble -> 200 1461ms d1stmts=1680 d1batches=3 kv=3/3 fetch=4 => approx subrequests=1693
```
  A new account with no history does the same play in ~30 statements (t6.mjs `play #1: d1=30+3b`). Where the statements go at 5,000 plays (statement histogram printed by t8.mjs): 168 x `SELECT m.id, m.kind, ... FROM media ...` (title lookups for every history row, three times over), 56 x `SELECT count(*) FROM media WHERE resolved_at IS NULL AND id IN (...)` (src/data/37_activity-backfill.js:644, a leftover of the one-off copy reconciliation, run on every play), 26 x `INSERT OR IGNORE INTO watch_events ... SELECT j.m ...` (src/data/37_activity-backfill.js:444, re-offering already-stored plays). `t8b.mjs` shows all of it finishes BEFORE the HTTP reply (`response after 255ms (d1 stmts at response=305)`), so the webhook caller waits for it; the 4 waitUntil promises are not where the cost is.
- Recommended fix and effort: M. Make the two play routes record the play directly with `recordActivityPlay` (src/data/38_activity-scrobble.js:73, already constant cost: 1 batch) and stop round-tripping through the whole-record shim for them; keep the shim for the website's full-record save only.

### PERF-02 Without the activity database, every play rewrites the account's whole history row by row
- Severity: Low (affects self-hosted installs and accounts not yet copied to the activity database; Medium for them)
- Status: Proven
- File:line: src/core/02_http-and-creator-utils.js:6525-6575 (`saveCreatorTrackingD1`: one upsert per history entry), :6577-6590 (writes them in chunks of 80)
- What is wrong (plain English): on the older storage path, saving the tracking record upserts EVERY entry of Watch History (and Continue Watching / Airing Next) instead of only the entry that changed. A scrobble saves the record, so one play writes one database row per play the account ever had, and also rewrites the whole record into KV.
- Impact: D1 "rows written" per play = size of the history (1,000 plays = about 1,000 row writes per play), plus a KV value that grows with it (62,919 bytes at 400 plays, about 157 bytes per play). Hosted accounts that have been copied are on the other path (PERF-01); this path is what self-hosters (wrangler.selfhost.toml) and accounts waiting for the hourly copy use.
- Proof: `NOBACKFILL=1 node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s04/t6.mjs prod 1001` (production flags on, but the account never copied). Output (`+Nb` = number of 80-statement batches):
```
play #1:    d1=26+1b   kvPut=5
play #200:  d1=25+3b   kvPut=5
play #500:  d1=25+7b   kvPut=5      (20.8 ms)
play #1000: d1=25+13b  kvPut=5      (28.0 ms; total run time grows quadratically: 1,500 plays took 41 s)
```
  Capture at play 400 shows `BATCH x80 first=INSERT INTO watch_history (...)` five times plus `PUT creatorsynctracking:alice (62919b)`.
- Recommended fix and effort: M. Only upsert entries whose `watched_at` is newer than the stored stamp, or have scrobbles insert the single new row.

## Unproven suspicions
## Checked and rejected
## Done well (do not change)
## Not audited and why
