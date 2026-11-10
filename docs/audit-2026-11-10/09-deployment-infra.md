# 09 Deployment and infrastructure
Health grade: B- — the build, backup and job-queue machinery is carefully engineered and tested, but the safety scripts can pass without checking everything, and deploy/staging docs and config have drifted from reality. (OPS-06 was withdrawn after re-testing with production flags; IDs are not renumbered.)
## Scope covered (files, routes, commands run)
Files read: build.py, build.ps1, tools/check_sync.py, verify.sh, .githooks/pre-commit, .gitattributes, .gitignore, .github/workflows/{ci,d1-backup,provider-live-check}.yml, .github/scripts/{backup-seal.sh,d1-backup.mjs,kv-backup.mjs} (headers/prefix list), wrangler.toml, wrangler.selfhost.toml, docs/{SELF-HOSTING,DEPLOY_CHECKLIST,STAGING}.md, OPERATIONS.md sections 1/3/4/5, migrations/ (grep for destructive SQL), src/api/26 (fetch/scheduled/queue), src/jobs/45, src/core/00 (redacting console), src/core/02 (safeErrorMessage, schemaWriteGate, writeRequestMetrics).
Commands run (all in the private copy `/tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s09/repo` or against read-only scripts): build twice + hash compare + build with no prior bundle (`p01_repro.sh`); mutation of sources / bundle / CRLF (`p03_dropped_source.sh`, `p08_crlf.sh`, `p09_drift.sh`); `verify.sh` gap checks (`p04_verify_gaps.sh`); fault-injected D1 on fetch() and scheduled() (`p02_faults.mjs`, `p06_misconfig.mjs`, `p07_outage_masking.mjs`); cron overlap / poison / stuck-row tests with the real dispatcher (`p05_cron.mjs`); full test suite (3641 pass) with a silently dropped source file; d1/kv backup tests (26 pass).
Not run on the real tree: build.py, verify.sh (they write files).
## Fix progress

Updated 2026-11-10. Status values: `open`, `fixed (awaiting verification)`, `verified`, `failed verification`. To verify a row, run its check and change the status.

| Finding | Status | Commit | How to verify |
|---|---|---|---|
| OPS-01 | fixed (awaiting verification) | 034fdb6 | node --test tests/build-source-names.test.mjs |
| OPS-02 | fixed (awaiting verification) | 8a27e51 | bash verify.sh -q (last line); no Playwright here, so it must say the browser tests were skipped |
| OPS-03 | fixed (awaiting verification) | 8a27e51 | git check-ignore rendered-admin.html rendered-scope.html rendered-hostile.html service-worker.js |
| OPS-04 | fixed (awaiting verification) | 26148a7 | Read docs/DEPLOY_CHECKLIST.md Phase B and Phase F: no "wrangler d1 export" on my-lists-db (docs only) |
| OPS-05 | fixed (awaiting verification) | 26148a7, 9496b00 | grep FF_V2_LISTS_ONLY wrangler.toml (staging block); read docs/STAGING.md (config only, not deployed) |
| OPS-07 | open |  |  |
| OPS-08 | fixed (awaiting verification) | 26148a7, 9496b00 | Links in docs/SELF-HOSTING.md resolve (../worker_entry_combined.js, ../migrations/, OPERATIONS.md); line 3 has no shutdown date (docs only) |
| OPS-09 | open |  |  |

## Proven findings

### OPS-01 A source file with a slightly wrong name is silently left out of the live Worker
- Severity: Medium
- Status: Proven
- File:line: `build.py:45` (`glob.glob('src/*/[0-9][0-9]_*.js')`); `tools/gen_map.py` uses the same rule
- What is wrong: The build only picks up files named exactly `src/<folder>/NN_something.js` (two digits). A file called `100_x.js`, `x.js`, or one placed one level deeper (`src/core/nested/20_x.js`) is not included, and nothing says so. Every safety check (build, drift check, syntax check, scope check, FUNCTION-MAP drift check, full 3,641-test suite) stays green, because they all use the same file list. The build stamp does not even change.
- Impact: A developer (or AI) adds a file, everything is green, the owner pastes the Worker, and the new feature or fix is simply missing in production. CLAUDE.md itself tells people to add "numbered" files; 99 is the limit of the two-digit scheme and the repo already uses 81.
- Proof: `bash /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s09/p03_dropped_source.sh`
```
build stamp: 6d2a02eae5 built 2026-11-10        <- identical to the stamp without the new files
__opsProbe100 occurrences in bundle: 0
__opsProbeNoNum occurrences in bundle: 0
__opsProbeNested occurrences in bundle: 0
  ok: worker_entry_combined.js matches its sources (...)   check_sync exit=0
gen_map changed docs?: 0 files
```
  Full suite with `src/core/100_probe.js` present: `# pass 3641  # fail 0`.
- Recommended fix: have `build.py` list every `*.js` under `src/` and fail if any is not matched by the numbered pattern (or is a duplicate basename). Effort S.

### OPS-02 `verify.sh -q` prints "ALL CHECKS PASSED" even when the browser tests were skipped (and they ARE skipped on this machine)
- Severity: Medium
- Status: Proven
- File:line: `verify.sh:148-153` (skip), `verify.sh:156` (constant success line), `verify.sh:10-17` (quiet mode shows only the last line)
- What is wrong: Step 6d (UI contract + end-to-end browser workflows) runs only if `import('playwright')` works from the repo folder, otherwise it prints "skipped" and carries on. In quiet mode (`-q`, the mode CLAUDE.md tells everyone to run before committing) only the last line is shown, and that line is the fixed text `ALL CHECKS PASSED`. So the owner/AI sees an identical all-clear whether or not the browser tests ran.
- Impact: On this very sandbox Playwright is installed for CommonJS but not importable from the repo, so every "green" `verify.sh -q` here has silently skipped the visual-contract and sign-up/sign-in/delete-account browser checks. They only run in CI, after the commit is already pushed.
- Proof: `bash /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s09/p04_verify_gaps.sh`
```
node --input-type=module -e "await import('playwright')"  -> exit=1   (step 6d takes the "skipped" branch)
node -e "require('playwright')"                            -> require ok
verify.sh:152:  echo "  skipped: Playwright is not installed here (CI still runs it)"
verify.sh:156:echo "ALL CHECKS PASSED"
```
- Recommended fix: make the final line say "ALL CHECKS PASSED (browser tests skipped)" when skipped, or fail unless `--allow-no-browser` is given. Effort S.

### OPS-03 A failed `verify.sh` step leaves generated files in the repo that git does not ignore
- Severity: Low
- Status: Proven
- File:line: `verify.sh:53-55, 83-85, 94-96, 106-108` (cleanup `rm` runs only after the step succeeds, because of `set -e`); `.gitignore:12-14`
- What is wrong: `rendered-scope.html`, `rendered-admin.html`, `rendered-hostile.html` and `service-worker.js` are written into the repo root and deleted only on success. `.gitignore` covers only `rendered.html`, `test.html` and `inner_*.js`.
- Impact: After any failure, `git status` shows 4 new untracked files; a careless `git add -A` commits generated pages (the owner is not a coder and AI tools often run `git add -A`).
- Proof: same script as OPS-02 (last block) in a scratch copy, after running the four `render_check.js` commands from verify.sh:
```
?? rendered-admin.html   ?? rendered-hostile.html   ?? rendered-scope.html   ?? service-worker.js
NOT ignored rendered-admin.html / rendered-hostile.html / rendered-scope.html / service-worker.js
```
- Recommended fix: add the four names to `.gitignore` (or write them under a temp dir with `trap`). Effort S.

### OPS-04 The deploy checklist's backup and restore commands cannot work on the main database (the repo's own backup docs say so)
- Severity: Medium
- Status: Proven (the contradiction and the schema fact); the Cloudflare behaviour itself is quoted from the repo, I could not run wrangler here
- File:line: `docs/DEPLOY_CHECKLIST.md:84` and `:88` (Phase B export), the "restore from the pre-deploy SQL export" step in Phase F; `docs/OPERATIONS.md` section 5 (first bullet); `schema.sql:109` and `:457` (two `CREATE VIRTUAL TABLE`)
- What is wrong: Phase B ("Database Backup Gate", required before every production deploy) tells the owner to run `npx wrangler d1 export my-lists-db --remote`, and Phase F tells them to restore from that file in an emergency. `docs/OPERATIONS.md` section 5 and the header of `.github/scripts/d1-backup.mjs` both state that D1 refuses to export a database with virtual tables, and `my-lists-db` has two (`lists_fts`, `lists_fts2`, confirmed in `schema.sql`). The same checklist's step 3 (Time Travel bookmark) is fine.
- Impact: During a bad deploy, the step the owner has been told to rely on either fails (so they are tempted to skip the gate) or leaves them with no usable pre-deploy file. The real safety nets (Time Travel bookmark, daily encrypted GitHub backup) exist but are not what the checklist points to.
- Proof:
```
docs/DEPLOY_CHECKLIST.md:84:  npx wrangler d1 export my-lists-db --remote --output=backups/my-lists-db-pre-deploy-...
docs/OPERATIONS.md §5: "wrangler d1 export does not work on my-lists-db: D1 refuses to export a database with virtual tables"
schema.sql:109:CREATE VIRTUAL TABLE IF NOT EXISTS lists_fts USING fts5(
schema.sql:457:CREATE VIRTUAL TABLE IF NOT EXISTS lists_fts2 USING fts5(
```
- Recommended fix: make Phase B use the Time Travel bookmark and "run the D1 backup workflow now (workflow_dispatch)", and make Phase F restore point to OPERATIONS section 5. Effort S.

### OPS-05 Staging does not run the production settings, and STAGING.md says it does
- Severity: Medium
- Status: Proven
- File:line: `wrangler.toml:314-326` (`[env.staging.vars]`), `docs/STAGING.md:14`, `docs/SELF-HOSTING.md` Step 10 table ("These match what the public site runs")
- What is wrong: Production runs `FF_V2_LISTS_ONLY=1` (the one-way switch that makes the new list tables the only store). Staging's variable list stops at `FF_MATERIALIZER`/`INSTALL_MIGRATION_PERCENT` and has no `FF_V2_LISTS_ONLY`. `docs/STAGING.md:14` also says `FF_SHOW_SCHEDULE` is "activated on staging ahead of production"; it appears in `wrangler.toml` only as a commented-out line (`wrangler.toml:162`). Staging also lacks the production-only "stop writing old list storage" behaviour, which changes how a list-directory outage is reported (it is answered as an empty 200 instead of a 503 when `FF_V2_LISTS_ONLY` is unset). Staging also has no `keep_vars`, `[[send_email]]` or `[images]`, so `wrangler deploy --env staging` would wipe any variable someone set by hand in the staging dashboard.
- Impact: The checklist's "deploy to staging first" rehearsal exercises a different list-storage path than production. A bug that only appears with `FF_V2_LISTS_ONLY=1` passes staging and is found live.
- Proof: `grep -n 'FF_V2_LISTS_ONLY\|FF_SHOW_SCHEDULE' /home/user/My-Lists-Addon/wrangler.toml` gives only commented lines (154, 162) and the warning text (10); the staging block lines 314-326 (read above) contains neither. `grep -n FF_SHOW_SCHEDULE docs/STAGING.md` -> line 14.
- Recommended fix: copy the production flag set into the staging block (or generate it), and correct STAGING.md. Effort S.

### OPS-07 Cron failures are swallowed and never alerted; a permanently failing periodic job is retried forever
- Severity: Low
- Status: Proven
- File:line: `src/api/26_api-creator-and-admin-routes.js:197-215` (`scheduled()` catches everything), `src/jobs/45_jobs-dispatcher.js:91` (`maxAttempts: Infinity` for periodic jobs), `:135-138` (retry delay capped at the job's period)
- What is wrong: `scheduled()` logs and returns normally whatever happens, so Cloudflare's cron metrics show success even when the whole tick failed. Periodic jobs (the Continue Watching / charts / posters work) never move to a "failed" state; a job that always throws is re-run roughly every 4 minutes for ever. Nothing in the code sends an alert (searched jobs/core/api for mail/webhook/notify hooks: none); the only places a failure shows are console lines and the /admin queue panel (`failuresInARow`).
- Impact: If a release breaks the Continue Watching sweep or chart refresh, the site quietly stops updating until the owner happens to open /admin or Live Logs, and the broken job keeps spending provider calls and D1 writes every few minutes.
- Proof: `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s09/p02_faults.mjs` (E2: D1 broken, `scheduled()` resolves normally, 13-14 error log lines) and `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s09/p05_cron.mjs`:
```
E2 queue=true scheduled() threw: no (resolved normally) | log lines: 14
C poison periodic job after 15 more ticks: queued/13, queued/14, queued/15, queued/16 (never becomes failed)
  next retry in ms: 60000        (its period; the cron.* jobs use 4 minutes)
```
- Recommended fix: surface "N jobs failing" on the /admin front page and in a daily email/health endpoint; after a large number of consecutive failures, back off to hourly. Effort M.

### OPS-08 Operator docs have broken links and steps that do not match the repo
- Severity: Low
- Status: Proven
- File:line: `docs/SELF-HOSTING.md:36, 86` (link `worker_entry_combined.js`), `:216` (`migrations/`), `:218, :234` (`docs/OPERATIONS.md`); `docs/SELF-HOSTING.md:3`; `docs/DEPLOY_CHECKLIST.md:73`; `docs/STAGING.md:75-100`
- What is wrong: The links in SELF-HOSTING.md are relative to `docs/`, so they point at `docs/worker_entry_combined.js`, `docs/migrations/`, `docs/docs/OPERATIONS.md`, none of which exist (checked with `test -e`). Line 3 still says the public site shuts down on November 8, 2026 (today is 2026-11-10). DEPLOY_CHECKLIST line 73 checks `FUNCTION-MAP.md` at the repo root, but the file is `docs/FUNCTION-MAP.md`, so that check can never report anything. STAGING.md Option B never tells the reader to paste the new ids over the `YOUR_STAGING_*` placeholders in `wrangler.toml:280,285,290`, so `wrangler deploy --env staging` fails, and it never mentions creating the `staging.mylistsaddon.com` route that `wrangler.toml` declares.
- Impact: A self-hoster following Method A cannot click through to the file they must copy; staging setup stalls at the deploy step.
- Proof: `test -e docs/worker_entry_combined.js; test -e docs/docs/OPERATIONS.md; test -d docs/migrations` -> all three "MISSING".
- Recommended fix: use `../` links; update the dated notice; fix the paths. Effort S.

### OPS-09 Production deploy is a hand copy-paste with no technical link to a green CI run
- Severity: Low
- Status: Proven (by reading the process; no code defect)
- File:line: `docs/DEPLOY_CHECKLIST.md` Phase D (step 2), `.github/workflows/ci.yml` (no deploy job), `wrangler.toml:2-17`
- What is wrong: CI only tests; production is updated by pasting a 6.29 MB file (1.62 MB gzipped; the self-hosting doc still says "about 5.5 MB") into the dashboard editor from the owner's local checkout. Whether CI was green for that exact commit is a manual look ("Do not paste a red commit"). The only technical cross-check is the build stamp shown on /admin after the paste (a good one). A rollback copy exists only if the owner remembers to save `previous-worker.js` by hand. The pre-commit hook only runs if each clone ran `git config core.hooksPath .githooks`. There is no check of the whole Worker against Cloudflare's upload limit (only `/app.js` has a budget); at 1.62 MB gzip there is ample room today.
- Impact: A human slip (pasting an uncommitted local file or a stale one) is not caught before users see it; /admin build stamp shows it afterwards.
- Proof: `gzip -9 -c worker_entry_combined.js | wc -c` -> 1622068; ci.yml contains no wrangler/deploy step; DEPLOY_CHECKLIST lines in Phase D.
- Recommended fix: a manual "deploy" workflow that publishes only the CI-built, hash-matching file (or at least prints the stamp to paste). Effort M.

## Unproven suspicions   (not counted)
- U1. SELF-HOSTING Method B runs `npx wrangler d1 execute my-lists-db --remote --file=./schema.sql` (lines 179-180) WITHOUT `-c wrangler.selfhost.toml`, while the secret and deploy commands do pass it. If wrangler resolves the database name from the default `wrangler.toml` in the current folder, it would target the public site's database id (`wrangler.toml:11`) and, for `mylists-activity`, the `FILL-IN-...` placeholder (`wrangler.toml:65`) instead of the self-hoster's new databases, and the step would fail. I could not run wrangler (no network, not installed), so this is unconfirmed. The site-shutdown date has passed, so self-hosting is the main path now; worth a dry run by the owner.
- U2. Scheduled GitHub workflows (backup, nightly provider check) are switched off by GitHub after 60 days without repository activity on public repos; there is no heartbeat that tells the owner if the daily backup silently stops. Unconfirmed: depends on repo visibility and GitHub settings.
- U3. The backup workflow's secrets are repository-level and `workflow_dispatch` can run the workflow from any branch (OPERATIONS section 5 says so), so anyone with write access could edit the workflow on a branch and read the Cloudflare token and backup passphrase. Normal for a small repo; an Environment with required reviewers would close it. Not tested (no GitHub access).
- U4. Action SHAs in the workflows are pinned with version comments; I could not verify the SHAs exist or match the comments (no GitHub access from this session).
- U5. In the no-queue fallback (`runLegacyCronTasks`, `src/jobs/45_jobs-dispatcher.js:489`) two overlapping ticks run the same sweeps at once; the sweeps use a KV cursor read-modify-write (`cron:continuewatching:cursor`). Production has the queue bound, so this is only a fallback path; not reproduced.
- U6. The KV backup prefix list leaves out `creator:`, `feedback:`, `creatorlastseen:`, `listlikevoters:`, `channellikevoters:`. The code says D1 (`creators`, `feedback`, `list_likes`) holds the authoritative copy, which the D1 backup covers; I did not check each for completeness.
- U7. No `[observability]` block in either wrangler file, so persistent Workers Logs depend on a dashboard setting I cannot see; with deploy-by-paste the repo cannot enforce it.
- U8. Real log content: `src/admin/59_support-emails.js:408` logs the sender's email address of each inbound support email (personal data in logs). Low; not weighed against the owner's retention settings.

## Checked and rejected
- Build not reproducible / machine- or time-dependent stamp: rejected. Two builds and the committed file have the same sha256 prefix (c77bc214b21cec9f); the stamp is a hash of the sources with CRLF normalised; the date is kept when the stamp is unchanged (`build.py:26-34`). Building with the bundle deleted still gives the same bytes today.
- check_sync fooled by a stale bundle or a hand-edited bundle: rejected. Both are caught (`p09_drift.sh`, MISMATCH with byte offset, exit 1); the test harness also refuses to run on a stale bundle (`tests/harness.mjs` top block). A hand edit of the bundle is simply overwritten by verify.sh/CI (they rebuild first), not failed.
- CRLF in a source: rejected as a hazard. Same stamp, check_sync and the drift diff pass, `node --check` passes (`p08_crlf.sh`); `.gitattributes` pins LF.
- Duplicate NN_ prefixes: three `05_` files exist; order is by file name so it is deterministic, and no two files share a base name (checked with `uniq -d`). A file in an unknown folder (`src/extra/10_extra.js`) IS included in the bundle (it only fails the FUNCTION-MAP drift gate).
- Uncaught exception in fetch(): rejected. `26_api-creator-and-admin-routes.js:111-141` wraps routing in try/catch (JSON 500, D1 text hidden), and post-processing (metrics, breaker flush, headers) is individually guarded; with D1 failing, with DB or KV unbound, and with FF_EVENT_TRACKING on but DB_ACTIVITY unbound, `fetch()` never threw (`p02_faults.mjs`, `p06_misconfig.mjs`).
- Uncaught exception in scheduled(): does not escape (try/catch, even with `ctx` undefined). See OPS-07 for the downside.
- Directory outage answered as an empty 200 (my first draft, withdrawn as OPS-06): with the production setting FF_V2_LISTS_ONLY=1, `v2PublicListsResponse` returns 503 `no-store` when D1 fails (`src/api/33_lists-directory.js:165-169`; re-run `PROD_FLAGS=1 node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s09/p07_outage_masking.mjs`). Only deployments without that flag (the staging block, see OPS-05) get the masked empty 200.
- Secrets in logs: rejected. Every console call goes through a redacting wrapper (`src/core/00_constants.js:34-60`) that masks key/token query parameters, Bearer values, Creator Keys, and secret-named fields; `safeErrorMessage` strips URLs and long opaque strings from client-visible errors. No console call logs request URLs, paths, IPs or install-config strings (grep).
- Overlapping cron ticks run a job twice: rejected. Two concurrent ticks sent 18 messages with 0 duplicates (`p05_cron.mjs` A); every state change is a compare-and-set on (status, run_after).
- Stuck "running" job: rejected. An expired lease is recovered by the next tick (D in `p05_cron.mjs`: back to queued, run again).
- Poison one-off job retried forever: rejected. queued/1 -> ... -> failed/6, then stops, with last_error kept (B in `p05_cron.mjs`). Only periodic jobs retry forever (OPS-07).
- Migration/code ordering and rollback: the schema gate (`schemaWriteGate`, `02_http-and-creator-utils.js:437-449`) answers 503 to API writes when a required migration is missing, so "code before migration" fails safe; migrations contain no DROP/RENAME of live columns (only comments matched in 0007 and 0016), so an older Worker keeps running on a newer schema.
- Backup works and restores: rejected as a concern. Dumps are verified by restoring into an empty database before upload; 26 backup tests pass; artifacts are GPG-encrypted; both D1 databases and the KV user-data prefixes are covered; missing secrets fail the run loudly.
- CI exposing secrets to pull requests: rejected. ci.yml uses no secrets, has `permissions: contents: read`, and the secret-using workflows only run on schedule or manual dispatch.
- Placeholder id in production `wrangler.toml`: intentional and explained (stops a stray `wrangler deploy` from overwriting the live Worker).

## Done well (do not change)
- Byte-exact, deterministic build with a source-hash stamp shown on /admin, plus an unusually thorough pre-merge pipeline (syntax, identifier-scope, rendered pages, hostile-input render, service worker, map drift, 3 test passes).
- Job queue design: leases, compare-and-set claims, dead-letter queue, inline fallback when the queue does not deliver; verified under overlap and poison inputs.
- Daily encrypted backup with restore verification and a loud failure when secrets are missing; GitHub Actions pinned to commit SHAs with least-privilege `permissions`.
- Log redaction wrapper and a top-level error boundary that keeps JSON, CORS and security headers on failures.
- The production `wrangler.toml` warning and `keep_vars` protect the one-way flags from an accidental deploy.

## Not audited and why
- Real wrangler behaviour, Cloudflare dashboard settings (observability, cron value actually set, Version History), GitHub repo settings (branch protection, Actions permissions, secret scoping): no network / no access; only the repo files were read.
- `.github/workflows/provider-live-check.yml` and `tools/provider_live_check.mjs` beyond reading the workflow (needs real provider keys).
- `loadtests/` (k6) and `tools/render_check.js` internals; not deployment-critical.
- verify.sh itself was not run end to end (it writes into the repo and takes several minutes); its steps were checked individually.
