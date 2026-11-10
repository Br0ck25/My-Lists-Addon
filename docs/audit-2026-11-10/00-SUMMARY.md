# Audit summary, 2026-11-10

A fresh, independent audit of the My Lists Addon. Nothing in the source, tests or config was changed. Every finding counted below was reproduced by a script or request run during this audit against the real Worker on a local instance (SQLite-backed D1, in-memory KV, stubbed providers). No production system or real provider was contacted.

Earlier audit material exists in the repo (`docs/audits/`, `docs/BACKEND_AUDIT.md`, `docs/CODE_QUALITY_AUDIT.md`, `docs/*_AUDIT_PLAN.md`). It was not read or used.

**Baseline:** `bash verify.sh -q` on the untouched tree printed `ALL CHECKS PASSED`. That run silently skipped the browser step (UI contract and browser workflows), because the Playwright import it tests for fails on this machine. See OPS-02.

## The short version

- The addon works. Account creation, sign-in, adding rows, install links, manifests and catalogs, backup and restore, and account deletion all ran end to end.
- **Two High security holes share one cause: a username works like a password.** Usernames are public. Knowing one is enough to add or erase titles in that person's watch history and to read their private Watch History shelf. Fix this first.
- Nothing Critical was found. No SQL injection, no working XSS, no admin route open to strangers, no secrets in the repo.
- Account deletion leaves a few things behind (resume positions, search-index entries), and the tests that should notice do not.
- The safety nets have quiet gaps: the browser tests can be skipped while the script still says everything passed, the git hook is off by default, and no test checks that a forged admin cookie is refused.

## Proven findings by severity and section

| Section | Report | Critical | High | Medium | Low | Info | Total | Grade |
|---|---|---|---|---|---|---|---|---|
| 1 Code quality | [01-code-quality.md](01-code-quality.md) | 0 | 0 | 3 | 4 | 2 | 9 | B- |
| 2 Bugs and reliability | [02-bugs-reliability.md](02-bugs-reliability.md) | 0 | 0 | 1 | 2 | 2 | 5 | B+ |
| 3 Security | [03-security.md](03-security.md) | 0 | 2 | 0 | 4 | 0 | 6 | C |
| 4 Performance | [04-performance.md](04-performance.md) | 0 | 0 | 2 | 4 | 0 | 6 | B- |
| 5 Testing | [05-testing.md](05-testing.md) | 0 | 0 | 6 | 1 | 0 | 7 | B- |
| 6 Database and data | [06-database-data.md](06-database-data.md) | 0 | 0 | 3 | 3 | 0 | 6 | B+ |
| 7 Frontend and UI | [07-frontend-ui.md](07-frontend-ui.md) | 0 | 0 | 1 | 7 | 1 | 9 | B+ |
| 8 API and integrations | [08-api-integrations.md](08-api-integrations.md) | 0 | 0 | 3 | 4 | 0 | 7 | B |
| 9 Deployment and infrastructure | [09-deployment-infra.md](09-deployment-infra.md) | 0 | 0 | 4 | 4 | 0 | 8 | B- |
| 10 Product functionality | [10-product-functionality.md](10-product-functionality.md) | 0 | 0 | 0 | 2 | 2 | 4 | B+ |
| **Total** | | **0** | **2** | **23** | **35** | **7** | **67** | |

Unproven suspicions are listed in each section report under their own heading and are not counted here.

## Health grades, with reasons

| Section | Grade | Why |
|---|---|---|
| Code quality | B- | No name collisions across 3,800+ top-level names and a deterministic build. Large client functions go unmeasured, and some blocks are copy-pasted. |
| Bugs and reliability | B+ | 186 routes fuzzed and concurrency tried; everyday paths held. One bad list entry can kill an install link. |
| Security | C | Strong plumbing (hashed keys, parameterised SQL, nonce CSP, all 48 admin routes gated), but two High holes expose any user's watch history through their username. |
| Performance | B- | Well indexed and flat as lists grow. Recording a play gets more expensive as history grows, and the home page makes 30 preview calls. |
| Testing | B- | 34 of 37 hand-made bugs were caught. The three misses are in the admin cookie and account deletion, and the safety nets can be absent silently. |
| Database and data | B+ | All 691 checkable SQL statements match the schema and the D1 backup restores row for row. Account deletion and one multi-batch save have gaps. |
| Frontend and UI | B+ | No sideways overflow at any of five screen sizes, good keyboard handling. Small tap-target, contrast and wording slips. |
| API and integrations | B | Stremio/Nuvio/Wako contract, CORS and old install links all work. One KV failure path, one wrong token-refresh rule, and Trakt paging are off. |
| Deployment and infrastructure | B- | Reproducible build and encrypted, verified backups. Safety scripts can pass without checking everything, and deploy docs have drifted. |
| Product functionality | B+ | Every main journey works. Problems are small validation slips. |

## Top 10 to fix first

Ranked by risk to users, then by effort (S = under a day, M = a few days, L = longer).

| # | IDs | What | Why it matters | Effort |
|---|---|---|---|---|
| 1 | SEC-01, SEC-02 | Stop treating a username (or numeric account id) as proof of identity on the Nuvio TV history routes and on `/<username>/...` install paths. | Any stranger can add or erase titles in someone's watch history and read their private Watch History shelf. | M |
| 2 | DB-01, SEC-04, TEST-03 | Make account deletion also remove resume positions, "removed plays", search-index rows and saved presets, and test each. | A deleted account's resume positions are inherited by the next account that gets the same id. | S |
| 3 | TEST-01, TEST-02 | Add tests that a forged and an expired admin cookie are refused. | The code is correct today, but replacing the signature check with "always true" leaves all 3,647 tests green. | S |
| 4 | BUG-01 | Reject or drop empty entries when a synced list is saved, and tolerate them when it is read. | One `null` entry makes the whole install link answer "not found" and every catalog empty. | S |
| 5 | DB-02 | Write liked/hidden lists atomically, and do not answer "ok" when the database write failed. | A failure part-way cut 120 liked lists to 79 while the save reported success. | S |
| 6 | API-01 | Catch KV read failures on manifest and catalog routes; answer with CORS headers and no internal error text. | During a KV blip, apps get a bare 500 they cannot read, plus the raw storage error. | S |
| 7 | API-02 | Treat a 403 on token refresh as "try again later", not "sign in again". | A Cloudflare rate-limit page flips a healthy Trakt/MDBList connection to "Reconnect". | S |
| 8 | OPS-02, TEST-07 | Make `verify.sh` say plainly when the browser step was skipped, and enable the git hook by default. | "ALL CHECKS PASSED" currently does not mean all checks ran. | S |
| 9 | OPS-04 | Correct the deploy checklist's backup and restore commands. | The documented `wrangler d1 export` path cannot work on the main database, so a restore during an incident would fail. | S |
| 10 | PERF-01 | Stop re-reading the whole watch history on every play. | 303 database statements per play at 5,000 plays and 1,680 at 30,000, which risks dropped plays for heavy users. | M |

Next in line: API-04 (Trakt rows can repeat the same 80 titles on the next page), PERF-03 (the ninth home-page visit in a minute from one address is fully rate-limited), OPS-01 (a misnamed source file is silently left out of the build).

## Lead spot-checks

The lead re-ran these proofs independently before including them. All reproduced as reported.

| Finding | Observed on re-run |
|---|---|
| SEC-01 | Anonymous cross-site POST to `/api/nuvio-tv/history` with only a username returned 200 and changed the victim's history; remove also worked; numeric id worked. |
| SEC-02 | Anonymous `GET /<username>/catalog/movie/watch-history.json` returned the private title, while the public list page correctly returned 404. |
| DB-01 | After delete: `watch_positions` 1 row left; a new account got the same id and saw that row. |
| DB-02 | Second batch failed, route answered 200 ok, database held 79 of 120, load returned 79. |
| BUG-01 | Saving a config containing `null` returned 200; manifest then 404, catalog empty. |
| API-01 | Manifest and catalog returned 500 with no CORS header and `KV GET failed: 503...` in the body. |
| API-02 | A 403 on refresh set the connection to `reauth_required`. |
| API-04 | `skip=80` returned the same 80 items as `skip=0`. |
| PERF-01, PERF-03 | Statement counts and the 30 x 429 on visit nine matched. |
| TEST-05 | `TZ=Asia/Tokyo` run of the named test: 0 pass, 1 fail. |
| OPS-02 | The Playwright ESM import fails here, so the browser step is skipped. |
| PROD-01 | `src/client/16_client-row-core.js:4038` contains `link.includes('tv')`, which matches `trakt.tv`. |

Findings not listed above were proven by the section auditor only. Their re-run commands are in each report.

## Checked and rejected

Suspected problems that turned out to be handled. Details are in the section reports.

- **Admin routes open to strangers:** all 48 refused anonymous and ordinary users (736 requests across 184 routes).
- **User B reading or changing user A's install links and lists:** refused.
- **SQL injection:** every query is parameterised.
- **Stored XSS:** payloads rendered as plain text in Chromium on the list page, creator page and every admin tab.
- **Prototype pollution through JSON bodies:** no effect.
- **Rate-limit bypass by forged `X-Forwarded-For`:** only `CF-Connecting-IP` is read.
- **SSRF through the poster proxy:** allow-listed hosts only.
- **Secrets in the repo:** none found; workflow actions are pinned.
- **Sessions surviving sign-out or key reset:** they end immediately.
- **Per-user data cached publicly:** account routes are `no-store`; the 14 publicly cached routes serve identical shared data.
- **Missing indexes on list and directory queries:** 31 hot queries, 0 table scans (the exceptions are DB-03 and DB-04).
- **N+1 queries as lists per account grow:** query counts stayed flat from 10 to 1,000 lists.
- **Worker too large to deploy:** 1.62 MB gzipped, within both limits.
- **Non-reproducible build:** identical hash on repeat builds and against the committed bundle.
- **Stale or hand-edited bundle going unnoticed:** `check_sync` and the test harness both catch it.
- **Cron crashing or double-running:** never threw under D1/KV outages; overlapping ticks sent no duplicate messages; stuck jobs recover.
- **Schema drift:** the migration chain matches `schema.sql` once the three base tables exist.
- **Backups unusable:** the D1 dump restored with 0 mismatching tables.
- **Provider outages breaking apps:** 500, 429, HTML, network error and hangs all returned a valid 200 answer with CORS.
- **Old install links broken:** all five historical formats still resolve.
- **Global name collisions across the numbered files:** zero.
- **Horizontal overflow on phones, tablets, desktop:** none across 70 page and size combinations.
- **Hex colours in component CSS:** zero.
- **Stale screen after delete and undo, and sign-out in another tab:** correct.
- **Buttons wired to missing handlers:** all 357 handler names exist.
- **A movie labelled "show" or "episode":** none found in rendered text (PROD-01 is a wrong default, not a label).
- **OPS-06 (withdrawn):** an empty public list directory during a D1 outage only happens without the production flag.

## Done well, do not change

- Account Keys and sessions are stored hashed; admin access verifies the Cloudflare Access token properly.
- Rate limits use atomic D1 counters and the real client address.
- The CSP uses nonces, and the log wrapper redacts secrets on every console call.
- The test harness runs real SQLite with foreign keys on, blocks real network calls, and refuses to run against a stale bundle.
- `build.py` is deterministic and the three-way CI run (default, v2 lists, materializer) works.
- Backups are encrypted and verified by restoring them.
- Provider failures fall back to the last good copy or a clear "temporarily unavailable" tile.
- The job queue recovers stuck work and retires poison one-off jobs.
- The two-device sync conflict guard returns 409 to the loser.
- The size-budget ratchet does fail when server code grows.

## Gaps: what was not audited, and why

- **Real Cloudflare:** CPU time, memory, the subrequest limit, KV eventual consistency, WAF and Access were not exercised. The local harness is strongly consistent and has no limits.
- **Real providers and real apps:** Trakt, MDBList, TMDB, Simkl, and the Stremio/Nuvio/Wako clients were not contacted, by rule. Provider behaviour came from committed fixtures and stubs. API-04 assumes apps send the held-item count as the next `skip`.
- **OAuth sign-in with real accounts:** not possible without credentials.
- **Git history:** this clone is shallow (301 commits), so older history was not scanned for secrets.
- **Dependencies:** there is no `package.json` or lockfile. `npm audit` on the two tooling packages `verify.sh` installs found 0 vulnerabilities.
- **Channel builder and custom list builder:** loaded and handler-checked, not driven step by step or tested with XSS payloads.
- **Click-every-button sweep:** timed out; replaced by a static check that every handler exists.
- **Admin actions:** every admin tab was loaded and access-checked; not every action was clicked.
- **Nuvio TV pairing, media-server webhooks, media-app sync:** call sites reviewed, not behaviour-tested end to end. `/api/nuvio-tv/collections` and the schedule routes likely share the SEC-01 exposure but this is unproven.
- **R2 and D1 write consistency, lists-v2 backfill re-runs, activity sharding:** read, not fault-injected.
- **Full `verify.sh` browser step:** cannot run on this machine.
- **Per-function test coverage:** the coverage run was unreliable and was dropped; no coverage percentage is claimed.
- **Models used:** to stay within usage limits, nine sections were audited by a lighter model and security by a stronger one. The lead re-ran the highest-severity proofs listed above.

## Suggested fix plan

Small, ordered steps that follow the repo rules: a failing test first, a root-cause fix, nothing unrelated, `bash verify.sh -q` before each commit.

1. **SEC-01 and SEC-02.** Product decision needed first: how should a paired Nuvio TV prove who it is (a per-device token issued at pairing is the usual answer)? Then write failing tests that an anonymous request with only a username is refused on the history routes and on `/<username>/catalog|subtitles|resolve`. Fix the shared cause in `resolveConfig` and the Nuvio TV routes. *Check:* the two proof scripts in the security report now show refusals; old paired TVs still work or are asked to pair again.
2. **DB-01, SEC-04, TEST-03.** Extend the account-purge test to assert that `watch_positions`, `watch_events_removed`, the search index and presets are empty. Watch it fail, then add the deletes. *Check:* the purge proof shows 0 rows left.
3. **TEST-01, TEST-02.** Add tests for a forged and an expired admin cookie. *Check:* re-apply the two mutations in a scratch copy and see the tests fail.
4. **BUG-01.** Failing test: save a config with a `null` entry, expect a working manifest. Filter on save and on read. *Check:* proof script shows manifest 200.
5. **DB-02.** Failing test with the fault injector on the second batch; expect either full data or an error answer. *Check:* proof shows no truncation.
6. **API-01.** Failing test: KV read throws on manifest and catalog; expect CORS headers and a generic message.
7. **API-02.** Failing test: 403 on refresh leaves the connection `ok` for retry.
8. **OPS-02, TEST-07, OPS-03.** Make `verify.sh` print a visible "browser step SKIPPED" in its final line, add the generated files to `.gitignore`, and document or automate `git config core.hooksPath .githooks`.
9. **OPS-04, OPS-05, OPS-08.** Correct the deploy checklist, staging settings and broken self-hosting links. Do a dry run of self-hosting Method B.
10. **TEST-04, OPS-01.** Make the route guard and the build fail on a route or file they cannot classify.
11. **PERF-01, then PERF-03 and DB-03.** Record a play without re-reading the whole history; de-duplicate the home page preview calls; add the `key_hash` index with a migration.
12. **API-04, API-05, TEST-05, TEST-06.** Fix Trakt paging, validate `skip`, and make the two time-dependent tests independent of clock and time zone.
13. **Remaining Low and Info items** (UI tap targets and contrast, PROD-01, PROD-02, code-quality duplicates) in small batches, each with `node tests/ui-contract.mjs --update` where the look changes on purpose.

## Fix progress

Per-finding rows are in each section report (`## Fix progress`). Branch `claude/youthful-galileo-e6ci4l`, commits after `beea09c`. Nothing here is deployed.

| Finding | Status | Commit | Verified |
|---|---|---|---|
| BUG-01 | verified fixed | a0b0ea7 | 2026-11-10, independent review |
| SEC-01 | verified fixed | ccac5fc | 2026-11-10, independent review |
| SEC-02 | verified fixed | ccac5fc | 2026-11-10, independent review |
| SEC-04 | fixed (awaiting verification) | a1ecc1f, 5997fe0, 1ffc61e |  |
| PERF-03 | fixed (awaiting verification) | 35f1c3f, 7b927c6, 605a44b |  |
| TEST-01 | verified fixed | bf54fbf | 2026-11-10, independent review |
| TEST-02 | verified fixed | bf54fbf | 2026-11-10, independent review |
| TEST-03 | verified fixed | a1ecc1f | 2026-11-10, independent review |
| TEST-04 | open (partially fixed, see Verification) | 034fdb6 | 2026-11-10, independent review |
| TEST-05 | verified fixed | acba574 | 2026-11-10, independent review |
| TEST-06 | verified fixed | acba574 | 2026-11-10, independent review |
| TEST-07 | verified fixed | 8a27e51 | 2026-11-10, independent review |
| DB-01 | verified fixed | a1ecc1f | 2026-11-10, independent review |
| DB-02 | fixed (awaiting verification) | e5110e0, 59b1a77 |  |
| DB-03 | verified fixed | 35f1c3f | 2026-11-10, independent review |
| UI-01 | verified fixed | ae33b9f | 2026-11-10, independent review |
| API-01 | verified fixed | 5b60aa2 | 2026-11-10, independent review |
| API-02 | verified fixed | 10c3c33 | 2026-11-10, independent review |
| API-04 | fixed (awaiting verification) | c5dbd27, efd3309 |  |
| API-05 | verified fixed | 37cdb1a, 75a8244, 7b927c6 | 2026-11-10, independent review |
| OPS-01 | verified fixed | 034fdb6 | 2026-11-10, independent review |
| OPS-02 | verified fixed | 8a27e51 | 2026-11-10, independent review |
| OPS-03 | verified fixed | 8a27e51 | 2026-11-10, independent review |
| OPS-04 | fixed (awaiting verification) | 26148a7, bbae733 |  |
| OPS-05 | verified fixed | 26148a7, 9496b00 | 2026-11-10, independent review |
| OPS-08 | verified fixed | 26148a7, 9496b00 | 2026-11-10, independent review |
| PROD-01 | verified fixed | ae33b9f | 2026-11-10, independent review |
| PROD-02 | fixed (awaiting verification) | 0a7a916, dd12e81 |  |
| PROD-03 | verified fixed | ae33b9f | 2026-11-10, independent review |
| PROD-04 | verified fixed | ae33b9f | 2026-11-10, independent review |

Independent review, 2026-11-10: of the 30 rows above, 23 are verified fixed. 3 are partially fixed and back to open (SEC-04, TEST-04, OPS-04), and 4 fixes introduced a regression (PERF-03, API-04, PROD-02, and DB-02 after a second review). Each report's **Verification.** note under the finding says what is still wrong. The other 37 findings were not touched and are still open (SEC-03, SEC-05 and SEC-06 among them).
