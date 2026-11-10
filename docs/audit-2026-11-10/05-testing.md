# 05 Testing
Health grade: B- — a big, mostly honest suite (3,647 tests, 0 failing on an idle machine in UTC, 6 marked todo) that kills 34 of 37 hand-made bugs; the survivors are in the admin login cookie and account deletion, and the safety nets (git hook, verify.sh browser step, route scan) have gaps that let a mistake through quietly.

## Scope covered (files, routes, commands run)
- Read: `.github/workflows/ci.yml`, `.githooks/pre-commit`, `verify.sh`, `tests/route-access.test.mjs`, `tests/size-budget.test.mjs`, `tests/load-performance.test.mjs`, `tests/ui-contract.mjs`, `tests/e2e-workflows.mjs`, `tools/check_bundle_budget.mjs`, parts of `tests/client.test.mjs`, `tests/help-wording.test.mjs`, `tests/guide-origin.test.mjs`.
- Scratch copy of the repo (never the real tree): `/tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s05/repo` (+ `repo2`, `repo3`). Mutation harness: `.../s05/mut.py` (reads `.../s05/mutants.json`, applies one change, runs `python3 build.py`, runs tests, restores). `mut2.py` is the same but leaves out the two wall-clock performance files.
- 37 single-line "break the business logic" mutations (M01–M37) over: admin check, CSRF origin and content-type, constant-time compare, rate limiter, HTML escaping, session revoke/expiry, ownership of lists, account purge steps, scrobble, cron dispatcher, backups, password/recovery hashing, adult filter. Logs: `.../s05/mut-Mxx*.log`, summaries `.../s05/batch*.out`, `full-repo*.out`, `np-M*.out`.
- Baseline: full suite `node --test tests/*.test.mjs` = 3647 tests, 3641 pass, 0 fail, 6 todo, 192 s (`.../s05/run1.log`). Also run with TZ=Asia/Tokyo (`tz-tokyo.log`: 1 real failure) and TZ=America/Los_Angeles (`tz-la.log`: clean), and with the clock moved forward.
- Not run in the real tree: `verify.sh`, `build.py` (shared tree rule).

## Mutation score (killed = the suite went red, survived = the suite stayed green)
Killed (34): M01 admin identity gate, M02 cross-origin CSRF, M03 JSON content-type rule, M04 constant-time compare, M05 rate-limit off-by-one, M06 quote escaping, M07 revoked session, M08 session expiry, M09 deleted-account session, M10 creator key check, M11/M12/M14 purge of watch events, likes, progress, M15/M16 deletion tombstone, M17 bad-token limit, M18 cron tick, M19 session revoke SQL, M20 password hash verify, M21/M22/M23 list ownership, visibility and If-Match, M26 recovery answer, M27 backup SQL quoting, M28/M29 delete-account confirm and session revoke, M30 CSRF on DELETE, M31 admin key compare, M32 Plex scrobble vs play, M33 session purge cutoff, M34/M35 job dispatcher, M36 movie/series filter, M37 adult filter.
Survived (3): M13 (presets not purged), M24 (admin cookie expiry ignored), M25 (admin cookie signature not checked). See TEST-01 to TEST-03.
Note: in first full-suite attempts M09, M13, M24, M36 looked "killed", but only by the two wall-clock performance tests failing while three suites ran at once on this 4-core box. Rerunning without those two files (`np-M09.out`, `np-M13.out`, `np-M24.out`, `np-M36.out`) gave the true result above. That is itself TEST-06.

## Fix progress

Updated 2026-11-10. Status values: `open`, `fixed (awaiting verification)`, `verified`, `failed verification`. To verify a row, run its check and change the status.

| Finding | Status | Commit | How to verify |
|---|---|---|---|
| TEST-01 | fixed (awaiting verification) | bf54fbf | node --test tests/admin-security.test.mjs; mutation: make isValidAdminCookie return true and see it fail |
| TEST-02 | fixed (awaiting verification) | bf54fbf | node --test tests/admin-security.test.mjs; mutation: drop the expiry check and see it fail |
| TEST-03 | fixed (awaiting verification) | a1ecc1f | node --test tests/account-purge.test.mjs (presets are seeded and checked) |
| TEST-04 | fixed (awaiting verification) | 034fdb6 | node --test tests/route-access.test.mjs ("no /admin/api/ or /api/ path appears ... however it is matched") |
| TEST-05 | fixed (awaiting verification) | acba574 | TZ=Asia/Tokyo node --test --test-name-pattern="puts the hour under the date" tests/client.test.mjs |
| TEST-06 | fixed (awaiting verification) | acba574 | node --test tests/load-performance.test.mjs (timing budgets only with MLA_PERF=1) |
| TEST-07 | fixed (awaiting verification) | 8a27e51 | bash verify.sh -q: the last line says when the browser step was skipped; git config core.hooksPath prints .githooks |

## Proven findings   (ordered by severity)

### TEST-01 Nothing tests that a forged admin cookie is refused
- Severity: Medium (test gap in the most sensitive check; no live bug shown)
- Status: Proven
- File:line: `src/admin/03_admin.js:1654-1655` (`isValidAdminCookie`, called from `resolveAdminIdentity` at `src/admin/03_admin.js:2125`)
- What is wrong: the "break-glass" admin cookie is `<expiry>.<signature>`. The one line that compares the signature (`return timingSafeEqualHex(sig, expectedSig);`) can be replaced with `return true;` and every one of the 3,647 tests still passes. So no test ever sends a cookie with a wrong signature.
- Impact: if a later edit breaks or drops that comparison, anyone could type `9999999999999.anything` as a cookie and become admin (all accounts, export, delete), and the suite, CI and verify.sh would all stay green.
- Proof: mutation M25 in `.../s05/mutants.json`:
```
-  return timingSafeEqualHex(sig, expectedSig);
+  return true;
```
  Full suite result (`.../s05/full-repo3.out`, `mut-M25-full.log`): `M25 SURVIVED {'tests': '3647', 'pass': '3641', 'fail': '0'}` (only the 6 known todo tests are listed as "not ok # TODO"). Re-run: `cd .../s05 && REPO_NAME=repo python3 mut.py M25 full`.
- Recommended fix and effort (S): add a test that sends `Cookie: mla_admin=<future expiry>.<wrong sig>` and a validly signed cookie with the expiry edited, and expects 401/redirect.

### TEST-02 Nothing tests that an expired admin cookie is refused
- Severity: Medium (test gap)
- Status: Proven
- File:line: `src/admin/03_admin.js:1653`
- What is wrong: the 7-day expiry check can be removed (`if (!expiresAt || Date.now() > expiresAt)` becomes `if (!expiresAt)`) and no test notices.
- Impact: a stolen or old admin cookie would never expire if this line were lost; no alarm.
- Proof: M24 `np-M24.out`: `M24 SURVIVED {'tests': '3642', 'pass': '3637', 'fail': '0'}` (full suite minus the two timing files; the run with them, `full-repo2.out`, failed only in the unrelated timing test).
- Recommended fix and effort (S): one test with a correctly signed cookie whose expiry is in the past.

### TEST-03 Account deletion: saved presets are not checked
- Severity: Medium (test gap; privacy promise)
- Status: Proven
- File:line: `src/jobs/51_account-purge.js:83` (`DELETE FROM presets WHERE account_id = ?`)
- What is wrong: making the delete a no-op (`... WHERE account_id = ? AND 0`) leaves the suite green. The other purge steps I broke (watch events M11, likes M12, show progress M14, tombstone M15, sessions M29, confirmation M28) were all caught, so the presets line is the one the purge test forgot.
- Impact: "delete my account" could silently keep a person's saved presets forever and nobody would know.
- Proof: M13 `np-M13.out`: `M13 SURVIVED {'tests': '3642', 'pass': '3637', 'fail': '0'}`; targeted run `batch-repo2.out`: `M13 SURVIVED {'tests': '7', 'pass': '7', 'fail': '0'}` (tests/account-purge.test.mjs has no mention of presets: `grep -n presets tests/account-purge.test.mjs` prints nothing).
- Recommended fix and effort (S): seed a preset for the account in `tests/account-purge.test.mjs` and assert the row is gone. A broader fix: make the test list every table with an `account_id` column from the schema and require each be empty after a purge, so a new table cannot be forgotten.

### TEST-04 The "every route is listed and protected" test is a text scan and misses other ways of writing a route
- Severity: Medium
- Status: Proven
- File:line: `tests/route-access.test.mjs:117-122` (the scans `scanExactRoutes`, `scanPrefixRoutes`, `scanRegexRoutes`)
- What is wrong: the test finds routes by searching the source text for the patterns `path === "/x"`, `path.startsWith("/x")` and `path.match(/^.../)`. A route written another way (`["/admin/api/x"].includes(path)`, `switch`, a lookup table, `endsWith`) is invisible, so it never has to be added to `tests/route-access.json` and is never called anonymously.
- Impact: the guard the owner relies on for "a new admin route forgot the login check" (CLAUDE.md rule 5) can be sidestepped by accident.
- Proof: in the scratch copy `repo3` I added to `src/admin/65_admin-api-routes.js` the line `if (["/admin/api/zz-new-leak"].includes(path)) return json({ ok: true, leaked: "all accounts" });` (no `isAdminRequest`), rebuilt, then:
```
$ node tests/route-access.test.mjs ...   # tests/route-access, security-suite, admin-security
# tests 212  # pass 212  # fail 0
$ node .../s05/probe-route.mjs
anonymous GET /admin/api/zz-new-leak -> 200 {"ok":true,"leaked":"all accounts"}
```
  (The copy was restored afterwards.) Re-run needs the same edit; the probe script is `.../s05/probe-route.mjs`.
- Recommended fix and effort (M): derive the check from behaviour instead of text: have the test request a list of random `/admin/api/<random>` and `/api/<random>` paths anonymously and require 401/403/404 only, or have the router register routes in a table the test can read.

### TEST-05 A test fails depending on the time zone and the hour
- Severity: Medium (breaks a developer's run, not users)
- Status: Proven
- File:line: `tests/client.test.mjs:5107` (`dayOffset` uses the UTC date) and `tests/client.test.mjs:5149-5151` (expects an episode "airing today" to show "9 PM ET")
- What is wrong: "today" is built from the UTC date but the page decides "today" in the viewer's local time, so the test only passes when the two dates agree.
- Impact: the owner or an AI working in Tokyo, Sydney, or Europe late in the evening sees a red suite for a bug that does not exist, and may be tempted to loosen a test. CI (UTC) never sees it.
- Proof (`.../s05/tz-tokyo.log`, full suite): `# fail 1` — `not ok 1 - puts the hour under the date, for tonight's episode and every later one ... expected '9 PM ET', actual []`. Isolated, same test, same instant:
```
TZ=UTC: pass 1 fail 0 | TZ=Asia/Tokyo: pass 0 fail 1 | TZ=Pacific/Kiritimati: fail 1 | TZ=America/Los_Angeles: pass
TZ=Europe/Berlin with the clock at 17:01 UTC: pass; at 23:01 UTC (00:01 local): fail 1
```
  Re-run: `cd .../s05/repo && TZ=Asia/Tokyo node --test --test-name-pattern='puts the hour under the date' tests/client.test.mjs`.
- Recommended fix and effort (S): build `dayOffset` the same way the client does (local date, or freeze the clock in the test).

### TEST-06 The two wall-clock speed tests fail when the machine is busy
- Severity: Low
- Status: Proven
- File:line: `tests/load-performance.test.mjs:137-148`, `:218-224`, `:282` (budgets skipped only when `process.env.CI` is set)
- What is wrong: outside CI the tests assert `p95 < 10 ms`, `p90 < 40 ms`, `p95 < 100 ms`. On a loaded machine they fail with no code change.
- Impact: false red results locally; each one trains the owner to re-run until green. They also hide real mutation results (see above). CI skips them, so speed is only guarded in CI by counting storage calls, which is good.
- Proof: with three suites running at once on this 4-core machine, three full-suite mutation runs failed only these tests (`full-repo.out` M09, `full-repo2.out` M13 and M24: "satisfies the < 5 ms warm cache and < 40 ms cold latency budgets across 20 rows", "handles a high-concurrency burst of 50 scrobbles"), for mutations that cannot affect the catalog path (presets delete, admin cookie expiry). The same mutants run with those files excluded gave the true answer: M13 and M24 survive, M09 is killed by 'a session of a deleted account is not renewed' (`np-M*.out`).
- Recommended fix and effort (S): skip the wall-clock part when not running alone (e.g. only under an explicit `MLA_PERF=1`), keep the call-count assertions.

### TEST-07 The safety nets can be absent without any warning
- Severity: Medium
- Status: Proven
- File:line: `verify.sh:145-153`, `.githooks/pre-commit`, `CLAUDE.md` ("Once per clone: git config core.hooksPath .githooks")
- What is wrong, three parts:
  1. The pre-commit hook is off by default. In this clone `git config --get core.hooksPath` prints nothing and exits 1, so nothing runs on commit. It only works after a manual command per clone, and a fresh cloud session starts without it.
  2. Even when on, the hook runs only the Worker-sync check, `node --check`, and three test files (route-access, design-system, build-stamp). It does not run the unit/security suites, scope check, size budget or the UI contract. (This is by design, but it means a commit with a failing test goes in.)
  3. `bash verify.sh` skips the browser step (UI contract and end-to-end workflows) when `import('playwright')` fails, prints a "skipped" line, and still ends with `ALL CHECKS PASSED`. `verify.sh -q` prints only that last line, so the skip is invisible.
- Impact: the "ALL CHECKS PASSED" the owner sees can mean "the browser tests never ran". The lead's recorded baseline for this audit (`ALL CHECKS PASSED`) is such a case on this machine.
- Proof: in the scratch copy: `node --input-type=module -e "await import('playwright')"; echo rc=$?` prints `rc=1` here (Playwright is installed, but only reachable through `NODE_PATH=/usr/local/lib/node_modules_global`, which ESM `import` ignores), so `verify.sh` takes the `else` branch at `verify.sh:152` (`echo "  skipped: Playwright is not installed here (CI still runs it)"`) and falls through to `echo "ALL CHECKS PASSED"`. `git config --get core.hooksPath` in `/home/user/My-Lists-Addon` → empty, exit code 1.
- Recommended fix and effort (S): make verify.sh print `PASSED (browser tests SKIPPED)` as its final line when it skips; set the hooks path automatically (a `prepare`-style step in the session-start script, or have verify.sh run `git config core.hooksPath .githooks` once).

## Unproven suspicions   (not counted)
- Moving the clock forward 400 days (`SHIFT_DAYS=400 node --import .../s05/shift.mjs --test tests/worker.test.mjs`) makes 9 worker tests fail (dated badge url, session-auth tests, channel lineup). Only `Date` is moved, not SQLite or Web Crypto clocks, so some of this is probably an artefact of my shim, not a real time bomb. `.../s05/shift400-worker.log`. Not verified, not counted.
- Several tests read the source files as text and eval a slice (for example `tests/dst-days-ago.test.mjs`, `tests/media-app-tile-text.test.mjs`, `tests/help-wording.test.mjs` regex the client source for forbidden wording). They exercise the source, not the built Worker, and pass or fail on formatting. I did not mutate them.

## Checked and rejected
- "Skipped tests hiding failures": no `.skip`, `assert.ok(true)` or `assert.equal(true, true)` anywhere in `tests/`. Only 6 `todo` tests exist (`tests/server-client-parity.test.mjs:122-124,242`, `tests/worker.test.mjs:3874`, `tests/perf-ping-cost.test.mjs:67`); node reports them as `# todo 6`, not failures, and they describe known gaps rather than hide them. Note they print as `not ok ... # TODO` in the log.
- "Size and bundle budgets absorb regressions": `tests/size-budget.test.mjs` fails on any new oversize function or file, and on a listed one that grew; and fails when a listed entry is now fine (forcing the number down). Guard works as described.
- "CI runs less than verify.sh": CI (`.github/workflows/ci.yml`) runs build-drift, `node --check`, scope check, hostile render, admin render, service-worker check, function-map drift, bundle budget, the suite three ways (default, v2 lists, materializer), plus separate `ui-contract` and `e2e` browser jobs. That is a superset of verify.sh, and in CI the browser jobs install Playwright 1.56.1 so they cannot silently skip.
- "CSRF, rate limit, escaping, session, ownership, purge, cron, backup tests are hollow": all but M13/M24/M25 were killed by the suite, with specific named tests failing (see list above).

## Done well (do not change)
- 3,647 tests run in about three minutes on one machine, from `node --test` alone, with no install step.
- The rate-limit, session, CSRF, list-ownership and cron tests catch single-character changes (off-by-one in `>=` vs `>`, removed `revoked_at` check, removed confirm check).
- Deterministic call-count assertions guard speed on CI instead of flaky milliseconds.
- CI runs the whole suite three ways and the real browser jobs; actions are pinned to commit hashes.
- Size budget is a true ratchet.

## Not audited and why
- Per-function "never called by any test" list: I ran the suite with `NODE_V8_COVERAGE` (`.../s05/cov`, `.../s05/covfuncs.mjs`) but the result was not trustworthy (it reported functions such as `apiSessionSignIn` as never called although sign-in is tested; the harness loads the Worker through several copies). Dropped rather than guessed; no coverage claim is made. Coverage of important behaviours is instead judged by the 37 mutations above.
- Dependence on test order: I ran every suite file together three times (default, Tokyo, Los Angeles); single-file isolation of all 188 files was not done.
- `.github/workflows/d1-backup.yml`, `provider-live-check.yml` only skimmed (belongs to deployment audit).
