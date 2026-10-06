# Audit prompt: My Lists Addon

Paste everything below the line into a fresh AI session opened on this repository.
It is read-only by design. Output is one report file, nothing else.

---

## ROLE AND MODE

You are an adversarial auditor of **My Lists Addon**, a production Cloudflare Worker that serves the web app, API, admin dashboard, Stremio/Nuvio/Wako add-on endpoints, scrobble webhooks, cron jobs and a queue consumer. Real users' accounts, tokens and watch history live in it.

**READ-ONLY.** You may read files, run `grep`/`rg`, `git log`/`git blame`/`git diff`, and run the existing in-memory harness (`tests/harness.mjs`, `node --test`, scripts under `audit/*/`). You may write probe scripts **only** inside your scratchpad directory, never in the repo.

You must NOT:
- edit, create, delete or reformat any file in the repo (including `worker_entry_combined.js`, tests, docs, `HANDOFF.md`);
- run `python build.py`, `gen_map.py`, `--update` flags, or anything that rewrites tracked files;
- commit, push, open PRs, or touch the network (no live providers, no production URL, no `wrangler`);
- "fix" anything. Proposed patches go in the report as text only.

After finishing, `git status` must show a clean tree. Run it and say so.

## RULES OF EVIDENCE (the whole point)

1. **Every finding needs a citation**: `file:line` in the numbered source files (`NN_*.js`, `header.js`, `schema*.sql`, `migrations/`). Never cite `worker_entry_combined.js`; it is generated.
2. **Every finding needs a trace**: the real entry point (route, cron, queue message, client event), the path through the code, and the exact line where it goes wrong. If you cannot name a realistic caller or input that reaches it, it is not a finding.
3. **Every finding is labelled** `CONFIRMED` (you reproduced it with a probe against the harness or a test; paste the command and its output), `TRACED` (read-only proof from code, no run), or `SUSPECTED` (plausible, could not complete the trace; say what is missing). Do not upgrade a label.
4. **Verify before you report.** Before writing a finding, look for the guard that would defeat it: a check earlier in the call chain, a wrapper, a test that pins the behaviour, a decision in `docs/DECISIONS.md` that makes it intentional. If one exists, drop the finding or record it under "Checked and clean".
5. **No generic advice.** Banned: "add more tests", "consider TypeScript", "add logging", "improve documentation", "use a framework", anything that restates `CLAUDE.md`'s rules back. Banned: findings about style, naming, file size, or the build approach (single pasted file, no npm, vanilla JS are owner decisions D-3/D-11).
6. **Do not re-report what is already known.** Read `audit/*/README.md`, `docs/DECISIONS.md`, `HANDOFF.md` and `docs/history/` first. A previously fixed bug that has **regressed** is a top-priority finding (cite the old probe and show it failing now). A known open item is only worth reporting if its impact is worse than recorded.
7. **Quantify.** Say who is affected (all users, one account, admin only, anonymous attacker), what the damage is (data loss, data leak, wrong results, silent no-op, cost), and how likely it is.
8. When a claim depends on Cloudflare platform behaviour (D1 batch atomicity, KV eventual consistency, Queue retry/at-least-once, subrequest and CPU limits, cron overlap), state the assumption explicitly so the owner can check it.

## SYSTEM MAP (verify, do not trust)

Confirm each of these against the code in your first pass; list anything that is wrong or stale.

- **Build**: ~59 numbered files (`00_constants.js` … `58_activity-copy-new.js`) + `header.js` are concatenated by `build.py` into one outer scope. `check_sync.py` guards drift. Consequence: cross-file global name collisions, load-order/TDZ problems, and a helper redefined later silently winning.
- **Runtime**: one Worker. Router starts `25_api-catalog-routes.js`; creator/admin routes `26_`; installs `27_`; connections `28_`; lists `30_–35_`; activity/scrobble `36_–39_, 56_, 58_`; jobs `41_–55_, 57_`; HTML/CSS/client JS are template literals in `09_–24_` and `00_`.
- **Storage**: D1 `DB` (accounts, sessions, installs, install_secrets, lists v2, likes, channels, media, FTS, rate_counters, admin_sessions), D1 `DB_ACTIVITY` (watch events/progress), KV `CONFIGS` (legacy `cfg:` configs, caches, cursors, tombstones), R2 `BLOBS` (channel pools, posters, KV archives), Analytics Engine, Queue `mylists-jobs` (+DLQ), cron `*/6 * * * *`.
- **Dual-write / migration state**: KV → D1 v2 lists, legacy configs → `/i/{token}` installs (`INSTALL_MIGRATION_PERCENT`), legacy scrobble forms with a Day-60 sunset, one-way flags `FF_V2_LISTS_ONLY`, `FF_EVENT_TRACKING`. Feature flags are plain env vars, so every flag combination is a distinct code path.
- **Auth surfaces**: session cookie `mla_session`; Account Key + recovery answer (PBKDF2); install tokens; scrobble `?st=`; admin `ADMIN_KEY` / `mla_admin` / Cloudflare Access JWT; per-route class table in `tests/route-access.json`.
- **External providers**: Trakt (OAuth + refresh), MDBList, TMDB, Simkl, Plex webhook, RPDB / Better Posters, JustWatch-derived ids, Stremio manifest/catalog contract.
- **Frontend**: server-rendered shell with very large client scripts (`20_` is ~13.7k lines, `22_`, `19_`, `24_`), service worker, localStorage backup/restore, drag-and-drop, modals, offline behaviour.

## WHERE REAL BUGS ARE LIKELY — investigate each area; skip none

For each area, do the specific hunts listed, then add your own.

### A. Authentication, authorization, and cross-account leaks (highest severity)
- Enumerate **every** route from the router and compare with `tests/route-access.json`. Find routes missing from the table, routes classed `public`/`static` that read account data, and admin routes whose `isAdminRequest` check comes *after* a side effect or a read.
- IDOR: for each `/api/creator/*`, `/api/lists/*`, `/api/likes/*`, `/api/installs/*`, `/api/channels*` handler, trace which identifier selects the row (path, body, cookie) and whether ownership is checked against the **session's** account, not a client-supplied `creatorKey`/`username`/`id`. Check the legacy key-in-body fallbacks still allowed during the sunset window.
- Unlisted/private list visibility across **every** reader: directory, FTS search, `lists/public.json`, share links, Stremio catalog rows, preview, exports, likes counters, activity shelves, channel pools in R2.
- Prior audit SEC-001 (`/api/resolve`, `/api/preview`, base64 configs leaking another user's shelves): re-test it and its variants on the current code.
- Token handling: `TOKEN_ENCRYPTION_KEY` AES-GCM (nonce reuse? missing key behaviour: plaintext fallback? silent skip?), secrets echoed in responses, logs, errors, Analytics Engine, KV copies, admin audit log, backups (`d1-backup.yml` artifacts), or `?config=` URLs that end up in referrers/access logs.
- Session lifecycle: rotation, logout, account delete/reset, recovery-answer brute force (is the rate limit per client only, spendable by rotating IPs, bypassable when `DB` is absent, fail-open when D1 errors?), timing-safe comparison of keys and hashes, cookie flags, CSRF on cookie-authenticated POSTs (is Origin/CORS checked? `ACAO: *` on authenticated routes?).
- Scrobble/Plex webhook: token binding to the right account, replay, token rotation when the D1 write fails (BE-003 class), body-size limits.
- Admin: Cloudflare Access JWT verification (aud, iss, exp, key rotation, algorithm), cookie fallback paths, `audit` log completeness.

### B. Data integrity, atomicity, and dual-store drift
- Every place that writes both KV and D1 (or D1 and `DB_ACTIVITY`, or D1 and R2): what happens if the second write fails or the isolate is evicted between them? Does the route still answer `{ok:true}` (false-success)? Which store do readers prefer, and can they serve a stale copy forever?
- D1 `batch()` use: which batches contain statements that can violate a UNIQUE/PK/FK on realistic input (duplicate ids in one payload, `tmdb:`-prefixed vs `tt` ids, case differences, empty strings), rolling back the whole batch? Compare against `schema.sql`, `schema_activity.sql`, and `migrations/` (do fresh-install schema and migrated schema agree? is every migration idempotent and in the migration runner's list?).
- Lost updates: read-modify-write of whole JSON blobs (lists, backups, tracking, channel pools) with no version/ETag check; two tabs or two devices saving.
- Deletion and resurrection: account delete/reset (`51_account-purge.js`), list delete, tombstones (`creator_tombstones`, `list_tombstones`) vs backfills (`30_`, `37_`), restore-from-backup, queue retries and cron rebuilds that can re-create deleted data (see `audit/reset-resurrection`). Check every writer that could run *after* a purge.
- Pagination, FTS, and counters: off-by-one, cursor stability with ties, LIKE wildcard injection (`%`, `_`), counters that can go negative or double-count on retry, likes ledger idempotency.
- Backup/restore and import paths (`24_`, `49_imports.js`): hostile or truncated input, partial restore leaving mixed state, size caps, prototype-pollution-style keys (`__proto__`, `constructor`).

### C. Background jobs, queue, and cron
- Queue delivery is at-least-once: for every job handler (`44_`–`55_`, `53_more-jobs.js`, `56_`), is it idempotent? What happens on the 5th retry and in the DLQ? Is any message dropped silently on a thrown error or acked before the work is durable?
- Cron cadence: `wrangler.toml` says `*/6` while `docs/ARCHITECTURE.md` says every 5 minutes. Find every place that assumes a tick interval, lock TTL, cursor window or "due" test, and whether the real cadence breaks it. Check overlapping ticks (a slow tick still running when the next fires), duplicate enqueues, and lock/lease expiry shorter than the job.
- Per-invocation limits: count outbound `fetch` / KV / D1 / R2 operations per tick and per request against Cloudflare's subrequest and CPU limits; find loops whose bound depends on user data size (a user with thousands of lists/shows, a 300-episode series, a very large channel pool).
- OAuth token refresh (`50_token-refresh.js`): concurrent refresh with a single-use refresh token, failure leaving the user with a revoked token, retry storms, expired-token handling in the fetchers.
- Circuit breaker (`41_`), chart snapshots (`42_`), materializer (`54_`), media retry (`55_`): stuck-open breaker, cache stampede, snapshot written empty on provider failure and then served for an hour (last-good vs empty cache poisoning), negative-cache TTLs.

### D. Provider and Stremio contract correctness
- Catalog/meta/manifest responses vs the Stremio add-on spec: `idPrefixes` vs the ids actually emitted (`tmdb:`, `tt`, `kitsu:`, custom), `extra` handling (`skip`, `search`, `genre`), content types, cache headers, CORS, behaviour on empty/failed upstream (empty rows are cached and shown as "broken list").
- Each fetcher (`06_`, `07_`, `52_`, `57_`): non-200, 429 with `Retry-After`, malformed/partial JSON, missing fields, pagination end, rate-limit headers, timeouts (is every `fetch` bounded by an abort signal?), and user-supplied URLs or IDs that become request targets (SSRF, path injection into provider URLs, open redirects, poster/logo proxies).
- Movie vs show/episode logic, season-0/specials, timezone and date handling for airing/next-episode (UTC vs local, DST, `null` air dates), duplicate removal across lists, sorting stability.
- API usage/cost: any path where an anonymous or low-privilege caller can make the Worker spend the **owner's** TMDB/MDBList/Trakt quota or R2/D1 writes (cache-key explosion from query strings, uncached unauthenticated endpoints, unbounded `bulk-resolve`).

### E. Injection and output encoding
- All HTML is built from template literals. For each template that interpolates data, trace the value to its origin and confirm the right encoder for its context (HTML text, attribute, JS string, URL, CSS, JSON inside `<script>`). Hunt especially in: list/channel names and descriptions, creator profiles and usernames, feedback messages in `/admin`, error messages reflected from query strings, SVG endpoints (`channel-poster`, `channel-logo`), `data-act` JSON arguments, `innerHTML`/`insertAdjacentHTML` sinks in the `16_`–`24_` client code, imported backup content, and provider-supplied titles/overviews.
- CSP: nonce substitution (D-21) applied to **every** response path including errors, redirects, service-worker responses, and cached HTML. Inline handlers or `javascript:` URLs that the CSP would block (broken feature) or that bypass it. Confirm `tests/csp.test.mjs` actually asserts what it claims.
- Template-literal escaping bugs: a stray backtick, `${`, `\n`, or `</script>` inside the embedded client code that changes the emitted JavaScript. Extract the emitted client scripts (the harness has helpers; `extract_html.py` shows how) and syntax-check them as served, per page and per flag combination.
- JSON/response header issues: missing `Content-Type`/`nosniff`, user-controlled `Content-Disposition`, open CORS on credentialed routes.

### F. Frontend runtime behaviour
- Race conditions: out-of-order search responses, double submits, saving while a previous save is in flight, account switch with stale state in localStorage, tab resume/visibility handlers, service-worker serving a stale shell against a newer API (`tests/service-worker.test.mjs`, `audit/frontend-*`).
- Modal/scroll-lock lifecycle (open, error, close paths leaving `body` locked), toast/undo toast leaving a delete uncommitted, drag-and-drop reorder persisting the wrong order, optimistic UI that never rolls back on failure, "Saved." shown on a failed request.
- localStorage/IndexedDB: quota errors, corrupt JSON, private-mode throws, key collisions between accounts, backup restore overwriting newer server state.
- Accessibility defects that block use (focus trap leaks, unlabeled controls, keyboard-unreachable actions); report only concrete, reproducible ones.

### G. Feature flags and migration states
- Build a table of every `FF_*` / env var read in the code (`grep -n "env\.\(FF_\|[A-Z_]*\)"`). For each, state default behaviour when **unset**, and test the risky combinations: `FF_V2_LISTS_READ` on with `FF_V2_LISTS_API` off; `FF_V2_LISTS_ONLY` on with a request still hitting a legacy writer; `FF_EVENT_TRACKING` per-account switch mid-session; `INSTALL_MIGRATION_PERCENT` at 0/10/50/100 and the hashing that picks an account (stable? changes between requests?); missing `DB_ACTIVITY`, missing `BLOBS`, missing `JOBS`, missing `TOKEN_ENCRYPTION_KEY`.
- Every "no binding → silently degrade" branch: does a mis-bound production Worker produce a quiet no-op that loses data instead of a loud failure?
- Deploy hazards: `wrangler.toml` placeholder ids, `keep_vars`, and the paste-in-dashboard flow. A deploy that removes a one-way flag or a binding. `WORKER_BUILD`/`WORKER_RELEASE` stamping vs the pasted file.

### H. Guardrails that may be hollow
- For each guard (`tests/route-access.test.mjs`, `design-system.test.mjs`, `ui-contract`, `csp.test.mjs`, `security-suite.test.mjs`, `check_sync.py`, `check_bundle_budget.mjs`, `scope_check.mjs`, `verify.sh`, CI `ci.yml`): find a **realistic** regression it would fail to catch (a route not in the table but reachable, a test whose assertion is vacuous or always true, a mocked dependency that hides the real failure, a skipped/`todo` test, CI jobs that are `continue-on-error`, a path filter that skips CI for relevant files). Prove it by reading the assertion, or by a scratchpad probe against a copy.
- Run `node --test tests/*.test.mjs` once. Report failures, flaky tests (run any failing test 3 times), and tests that pass only because of wall-clock time, ordering or shared state.
- Global-scope hazards from concatenation: duplicate top-level `const`/`function` names across files (a later definition silently overrides an earlier one for function declarations), and use-before-definition of `const`/`let` across files in load order.

## METHOD

1. **Orient (≤ 15% of effort):** read `CLAUDE.md`, `AGENTS.md`, `HANDOFF.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/OPERATIONS.md`, `schema*.sql`, the router in `25_`, and every `audit/*/README.md`. Note what is intentional.
2. **Enumerate surfaces mechanically**, not from memory: all routes, all `env.*` reads, all `DB.prepare/batch`, `CONFIGS.put/get/delete`, `BLOBS.put/get`, `JOBS.send`, `fetch(` calls, `innerHTML`/`insertAdjacentHTML`, `JSON.parse` of external data, `catch {}` blocks that swallow errors. Use the counts to decide where to dig.
3. **Prioritise by blast radius**: cross-account leaks and data loss first, then silent failure, then wrong results, then cost, then UX.
4. **Prove, then report.** For anything runnable, build a probe on the in-memory harness (see `audit/full-2026-09-13/p05_resolve_leak.mjs` for the pattern) in your scratchpad, run it, and keep the output.
5. **Hunt for the sibling.** When you find a bug, grep for every other place with the same shape and either report them under the same finding or say why they differ.
6. **Spend negative results.** For each area A–H, record what you checked and found clean, with the guard that protects it. A short, true "clean" list is as valuable as the findings.

## REPORT FORMAT

Write the report to your scratchpad as `AUDIT_REPORT.md` (do not put it in the repo; the owner will decide). Structure:

1. **Verdict** (5 lines max): overall health, number of findings by severity and label, the single most urgent item.
2. **Findings**, sorted by severity then label (`CONFIRMED` first). One block each:
   - `ID` (e.g. `AUTH-001`), **Severity** (Critical = cross-account data exposure/takeover/mass data loss; High = single-account data loss or privilege issue, silent corruption; Medium = wrong results, quota abuse, recoverable failure; Low = edge case), **Label**
   - **Where**: `file:line` (all relevant locations)
   - **Trigger**: the exact request/event/state that causes it (an actor and a concrete input)
   - **Trace**: the path from entry point to failure, in 3–8 steps with `file:line`
   - **Evidence**: probe command + output, or the guard-less code excerpt; plus "guards looked for and not found: …"
   - **Impact**: who, what, how many
   - **Minimal fix** (text only, smallest change that fixes the root cause, plus the existing test file where a regression test belongs)
   - **Related**: sibling locations found
3. **Regressions of previously fixed issues** (with the old probe's result today).
4. **Checked and clean**: per area A–H, bullet list of what you verified and the line that protects it.
5. **Could not verify**: items needing production access, Cloudflare behaviour, or real provider responses, with the exact check the owner should run.
6. **Coverage statement**: files and routes read, probes run, tests run, and anything you did not reach. Do not claim completeness you did not earn.
7. Last line: output of `git status --short` (must be empty) to prove nothing was modified.

Quality bar: ten verified, reproducible findings beat fifty plausible ones. If you find fewer than five real issues, say so and show your coverage instead of padding the list.
