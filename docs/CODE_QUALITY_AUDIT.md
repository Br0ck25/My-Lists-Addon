# Code-quality audit and fix plan (handoff to Sonnet)

Audited 2026-11-02 at commit `6e9bf37`. Read-only audit: nothing in the repo was changed.

Scope: code quality, architecture, technical debt, dead code, duplication, dependencies, and standards.
**Out of scope:** security and correctness. `docs/BACKEND_AUDIT.md` (BA-001 to BA-012) covered those today and the fixes have landed. Do not re-open those items. BA-008 (the 200+ bare `catch {}` blocks) has its own list in that file's appendix.

**Owner answers (2026-11-02), already folded into the plan below:**
- Catalog list wizard: **removed on purpose**. Delete it (CQ-08).
- Split `handleFetch`: **yes**, one group of routes at a time (CQ-01), plus a size rule enforced by a test (CQ-18).
- Compatibility date: **yes, update it**, with a staging check first (CQ-10).
- Feature flags (CQ-09): **not yet.** They wait on retiring the old Account Key sign-in, and that waits on the "Saves that sent the Account Key" count reaching near zero. CQ-17 makes that counter tell us where the key comes from, and fixes one cause found in the code.

## Progress (updated 2026-11-02)

| item | status | where |
|---|---|---|
| CQ-16 DST-safe day keys | **done** | `easternDateKeyDaysAgo` (03_admin.js), tests/dst-days-ago.test.mjs |
| CQ-17 steps 1–3 Account Key breakdown, install-link save signed by session | **done**; step 5 (read /admin for a week) is the owner's | 62_creator-auth.js, 03_admin.js, tests/authkey-breakdown.test.mjs |
| CQ-08 wizard (client + `/api/wizard-channel-shows`) | **done** | |
| CQ-06, CQ-07, CQ-11/12 | **done** | |
| CQ-03 parity test | **done**; owner decisions applied: poster badge "AIRED" for past dates, blank Nuvio collection name → "My Lists Collections". Remaining known differences are `todo` cases (getSafePosterUrl type/title, options.backdropImageUrl) | tests/server-client-parity.test.mjs |
| CQ-04 step 1 shared `traktIsHiddenShow` | **done** (step 2: see below) | 06_ |
| CQ-18 size ratchet | **done** (rule 12 in CLAUDE.md) | tests/size-budget.test.mjs |
| CQ-10 compatibility date | **repo done** (all wrangler files = 2026-07-27, OPERATIONS §32 flag table); owner sets the staging dashboard date and checks staging | |
| CQ-01 split `handleFetch` | **done**: 15,494 → 227 lines; routes in `src/api/62_`–`80_` and `src/admin/65_`–`66_`; verified by four replay scripts (~2,900 requests) identical before/after every commit | |
| Bug found during CQ-01: scrobble user filter answered 500 | **fixed** | 64_media-server-scrobble.js, tests/scrobble-user-filter.test.mjs |
| CQ-19 scope-check blind spot | **done**: window.* exports read from the AST; a typeof only excuses a read in the same or an enclosing function | tools/scope_check.mjs, tests/scope-check.test.mjs |
| CQ-13 pin CI actions to SHAs | **done** (checkout 4.4.0, setup-node 4.4.0, setup-python 5.6.0, upload-artifact 4.6.2; Dependabot keeps them current) | .github/workflows/*.yml, OPERATIONS |
| CQ-05 shared Trakt headers | **done**: `traktHeaders(accessToken, apiKey)` in `src/core/81_trakt-headers.js`; 30 of 36 copies replaced, 6 left on purpose (different User-Agent, no Content-Type, or User-Agent from a local variable). Header count 36 → 7 (6 left + the helper) | tests/trakt-headers.test.mjs |
| CQ-04 step 2 second continue-watching implementation | **done** (owner decisions 2026-11-02): website list files episodes under the show's id and matches paused shows like the shelf (lower-cased IMDB id + slug); both check 40 shows via `TRAKT_CONTINUE_NEXT_EPISODE_SHOWS`; Trakt-id-only shows stay website-list-only on purpose. Parity test has no `todo` left | tests/continue-watching-parity.test.mjs |
| CQ-20 long parameter lists | **done**: all 21 top-level functions in `src/api/` and `src/admin/` with more than 8 parameters now take the leading `request, env, ctx` they already started with plus one destructured object; none left. 8 commits, replay byte-identical each time | 62_–77_ in `src/api/` |
| CQ-09 flags | blocked on CQ-17 data | |

### New follow-ups found while doing the work
- **CQ-19 Scope-check blind spot.** `tools/scope_check.mjs` accepts a free name if the same name is assigned bare or `typeof`-guarded anywhere in the bundle, so a moved function that uses `m` without receiving it passed `verify.sh --fast` (the replay caught it). Make the check per-function for names that are not real globals, with a test that reproduces the miss first.
- **CQ-20 Long parameter lists from the mechanical split.** Some helpers take many positional parameters (e.g. `stremioCatalogRowFetch` in 70_ has 35). Behaviour is exact, but readability suffers. Optional tidy: pass one settings object, one function per commit, replay-verified. Needs an owner yes (rule 2).
  **Status (2026-11-02): done** (owner approved). See the Progress table.
- **Dispatcher styles.** Slices 1–4 use `async` dispatchers; slices 5–6 use plain functions returning a promise or `null` (keeps the catalog hot path free of extra awaits). Both are correct; leave as is.
- Line references to `25_`/`26_` in this document and `docs/BACKEND_AUDIT.md` are now historical (the code moved); use `docs/FUNCTION-MAP.md` to find a symbol.

---

## 0. Read this first (rules for the implementer)

1. Follow `CLAUDE.md` exactly. In particular:
   - Never edit `worker_entry_combined.js`. Edit `src/**/NN_*.js` and run `python build.py`.
   - **Rule 2 (no refactors).** The owner has now asked for CQ-01 (splitting `handleFetch`) and CQ-18 (the size rule), so those are approved. CQ-03b and CQ-09 still need a separate yes. Moves must be mechanical: no renames, no rewrites and no "while I'm here" changes inside moved code.
   - All numbered files share one scope. Never add a global `const`/`let`/`function` whose name already exists. `bash verify.sh -q --fast` runs the scope check, which catches this.
   - Client code (`src/page/*`, `src/client/*`) lives inside a template literal, so every backslash in it is doubled (`\\s`, not `\s`). Write `<\/script>`, never a raw `</script>`.
2. Do **one item per commit**. After each item, run `bash verify.sh -q --fast` and the one or two test files it touches. Run the full `bash verify.sh -q` before each push.
3. **Baseline at audit time** (`bash verify.sh -q`, build stamp `4a403ac54b`): every build, drift, syntax, scope and render step passed. Tests: **2,820 run, 2,816 pass, 3 fail, 1 todo.**
   - `tests/load-performance.test.mjs`, the cold catalog p90 timing budget, is known to fail on shared VMs and passes with `CI=1`. See BACKEND_AUDIT "Unverified hunches". Do not loosen the budget.
   - `tests/my-lists-addon-charts.test.mjs` has 2 failures ("Most Watched Today rolls over…"). This is **CQ-16**, a real DST bug, and it is the first item to fix. It fails only during the final hour of the 25-hour "clocks go back" day (the audit ran at 2026-11-02 04:11 UTC, which is 23:11 EST on 1 Nov), so on any other day it passes and looks fine.
   - Todo: `tests/worker.test.mjs` "keeps the creator's newer items # TODO audit #12" (known).
4. If functions are added, removed or moved, run `python tools/gen_map.py` and commit the regenerated `docs/FUNCTION-MAP.md` and `docs/FILE-INDEX.md`.
5. Add a `docs/RELEASES.md` entry at the end, under the build date and stamp that `python build.py` prints.
6. For a removal, prove there are no callers first: `grep -rnw <name> src tests tools`. Client actions are dispatched by name through `data-act="name"`, so a client function name that appears only once really is unused.

---

## 1. Findings summary

| id | category | finding | severity | effort | tier |
|---|---|---|---|---|---|
| CQ-01 | Architecture | `handleFetch` is one function of **15,629 lines** covering `25_` and all of `26_`, with about 165 inline `if (path === …)` route branches. Only 7 branches hand off to a named handler. | High (maintainability) | L | 3 |
| CQ-02 | Architecture | `renderBuilder` (58,235 lines, the whole client inside one template literal) and `renderAdminDashboard` (4,067 lines) are single functions | Info | — | won't fix |
| CQ-03 | Duplication | 9 functions exist as both a server copy and a client copy, with no test that keeps the two copies in step | Medium | S–M | 2 |
| CQ-04 | Duplication | The Trakt "continue watching" logic, including an identical nested `isHiddenShow`, is copied into `/api/trakt-my-private-lists` | Medium | M | 2 |
| CQ-05 | Duplication | The Trakt request header block is written out by hand 36 times | Low | S | 2 |
| CQ-06 | Duplication | `escapeHtmlSupport` is a one-line alias of `escapeHtmlServer` | Low | S | 1 |
| CQ-07 | Dead code | `loadPremadeCollectionsBtn`, `onCollectionsSearchKey` have no callers | Low | S | 1 |
| CQ-08 | Dead code | The catalog list wizard (`catalogWizardName`, `addCatalogWizardList`, `runCatalogListWizard`, 20_:11444-~11600) has no UI left. Only tests keep it alive. **Owner: removed on purpose.** | Low | S | 1 |
| CQ-09 | Tech debt | Post-cutover feature flags still keep both code paths (`FF_V2_LISTS_READ/API/ONLY`, `FF_SESSIONS`, `FF_INSTALLS`, `FF_CANONICAL_IDS`, …). They are on in staging and in the self-host template. | Medium | M–L | **blocked** on retiring the old sign-in (CQ-17) |
| CQ-10 | Tech debt | The wrangler files say `compatibility_date = "2024-01-01"`, but production (dashboard) is `2026-07-27`. Staging and self-host run an older runtime than production. **Owner: update, staging first.** | Medium | S | 1 |
| CQ-11 | Architecture | File names no longer match what the files contain (see §5) | Low | S | 1 (docs only) |
| CQ-12 | Standards | Agent instruction docs disagree with each other and with the repo (file ranges, build commands, "27 sources") | Low | S | 1 |
| CQ-13 | Dependency | CI actions are pinned to major tags rather than SHAs. The `acorn`/`eslint-scope` install has no lockfile or integrity check. | Low | S | 1 |
| CQ-14 | Standards | `var` is still used 158 times, concentrated in a few client files. Quote style differs between server and client. | Info | — | won't fix (rule 2) |
| **CQ-16** | **Bug (found by this audit)** | "N days ago" is computed as `now − i × 86,400,000 ms` and then turned into an Eastern date. On DST change days this repeats one date and skips another. Admin day-by-day stats and the Most Watched test are affected. | Medium | S | **1 (do first)** |
| **CQ-17** | Tech debt / measurement | The "Saves that sent the Account Key" counter cannot say where the key comes from. It also counts sign-ins and data loads, not only saves. And the install-link save always sends the key in a second field, `trackCreatorKey`, that the session helper does not remove. | Medium | S–M | **1 (do second)** |
| CQ-18 | Standards | No size limit on functions or files: 14 source files are over 4,000 lines, and 26 functions are over 150 lines | Medium | S | 2 (with CQ-01) |
| CQ-15 | Quality | Large server functions (26 over 150 lines; see §6) | Info | — | only when already touching them |

---

## 2. Tier 1: safe, no behaviour change (do these first)

### CQ-16 DST-safe "N days ago" Eastern date (bug, do first)
- **Cause.** Eastern days are not always 24 hours long. On the day clocks go back (25 hours), `easternDateKey(new Date(now - 86400000))` gives *today's* date during the last hour. On the day clocks go forward (23 hours), it skips a date during the first hour after midnight.
- **Where.** `src/admin/03_admin.js:716, 772, 1021, 2691, 2702` and `src/api/26_api-creator-and-admin-routes.js:7042` all use `easternDateKey(new Date(nowMs - i * 86400000))`. The result is a repeated or missing day in the /admin day-by-day series, and a 7-day total that counts one day twice. The test helper `tests/my-lists-addon-charts.test.mjs:107` (`easternDay(Date.now() - 864e5)`) does the same, which is why that test failed during the audit.
- **Fix (one shared helper, rule 7).** Next to `easternDateKey` in `03_admin.js`, add `easternDateKeyDaysAgo(nowMs, n)`. It takes today's Eastern key, parses it as a UTC-noon date, subtracts `n` days with `setUTCDate`, and formats it as `YYYY-MM-DD`. Check the name is free first. Replace the 6 call sites. Fix the test helper's "yesterday" the same way. The test cannot import worker internals, so do the calendar arithmetic there too.
- **Test first (rule 10).** Add a test that pins `Date.now()` to `2026-11-02T04:30:00Z` (23:30 EST on the 25-hour day) and to `2026-03-09T04:30:00Z` (00:30 EDT just after spring forward). For days 0..7 it asserts 8 distinct consecutive dates. It must fail before the fix. Use whatever clock-mocking the harness already has (grep `tests/harness.mjs` for `Date.now`). If there is none, save and restore `Date.now` inside the test.
- Check: `node --test tests/my-lists-addon-charts.test.mjs`, the admin stats tests (`grep -ln easternDateKey tests`), then `bash verify.sh -q`.
- Also check `src/catalog/07_source-fetchers-tmdb-simkl.js` around line 3240 (the Most Watched snapshot `day`) for any "yesterday" built the same way. None was found by the grep, but confirm by reading.

### CQ-17 Make the Account Key counter tell us where the key comes from (do second)

**What the counter is.** `/admin` → "Saves that sent the Account Key today / in the last 7 days" is `bumpStat(env, "authkey")` at `src/api/26_api-creator-and-admin-routes.js:117`. It is bumped on **every request that passes the key check** whose path is in `CREATOR_SESSION_PATH_PREFIXES` (`src/core/02_http-and-creator-utils.js:1319`). That list covers 12 paths, including `/api/creator/restore` (sign-in and the page-load check), `/api/creator/sync/load`, `/api/preview`, `/api/save`, likes and feedback. So it is **requests, not people, and not only saves**. A sign-in on a new browser counts, and so does every autosave from a browser that never got a session.

**What the audit found in the code:**
1. The page side looks right. All 50 key-carrying calls go through `creatorApiFetch` (`src/client/16_client-row-core.js:91`), which drops `creatorKey` once the server has said, through the `X-MLA-Session` header, that this browser holds a session. The server reads the session cookie on every route (`25_:439`). There are no `sendBeacon` or keepalive calls carrying the key.
2. **One real leak: the install-link save.** `installSaveBody` (`src/client/24_client-backup-restore-presets.js:1932`) puts the Account Key in `trackCreatorKey` when the link carries personal shelves (Watch History, Continue Watching, Watchlist). `creatorApiFetch` only removes `creatorKey`, so `trackCreatorKey` always goes. `/api/save` then authenticates with it (`25_:7833`, `authenticateCreator(claimed, body.trackCreatorKey || "")`), which bumps the counter even when a valid session was sent. `25_:7937` also copies it into the saved install config. This happens on each "Generate Install Link"/"Update Add-on" click, so it adds to the count but probably does not explain 437 a day on its own.
3. Things the code cannot rule out, which only production data can answer: browser tabs still running a bundle from before Release 19/20 (long-open tabs or TV browsers); browsers where `localStorage` is blocked (`creatorSessionHeldFor()` returns `''`, so the key is sent on every autosave); sessions expiring after 30 days (one key request per browser per month, by design); scripts or other apps calling `/api/creator/*` with the key.

**Steps:**
1. **Break the counter down (small, no behaviour change).** Next to the existing `bumpStat(env, "authkey")`, also bump `authkey:<prefix>` (the matched entry of `CREATOR_SESSION_PATH_PREFIXES`, slashes turned into `-`) and `authkey:why:<reason>`. Reason is one of:
   - `nocookie`: no session cookie at all
   - `othersession`: the cookie belongs to a different account
   - `withsession`: a valid session for the same account was sent *and* the key was sent too. This is the bug signal: it should be near 0 after step 2.
   - `trackkey`: the key came from `trackCreatorKey` on `/api/save`. Pass that in from the call site; don't infer it.

   Keep the existing `authkey` total unchanged so the history stays comparable. Before writing, check how `bumpStat` stores kinds (`03_admin.js:76`, D1 `stats` table) so the new kinds don't need a migration.
2. **Show it on /admin.** Under the existing two numbers, add a small "Where the key came from (7 days)" table: one row per path and one row per reason, reusing the existing stat-card or table classes (`docs/AI_UI_RULES.md`; no new styles). Fix the label to say what it counts: "Requests that sent the Account Key". Its 7-day total uses the CQ-16 helper.
3. **`trackCreatorKey` on the install-link save (researched 2026-11-02; the answer is below, so don't redo it).**
   - **What the stored key is used for today.** An install link made by `/api/save` stores the key encrypted (`27_installs.js:60-63`).
     - **Personal rows do not need it.** `resolveConfig` (`04_config-resolution.js:88-95`) also accepts the server's `trackOwner` stamp, which `/api/save` writes after verifying (`25_:7937-7941`).
     - **Lending provider connections** has an alternative: the `ownerId` stamp from a signed-in save (P3a-10).
     - **Playback tracking does need it.** The subtitles ping (`26_:252-279`) authenticates with `trackCreatorName` + `trackCreatorKey`, unless the link is a v2 `/i/<token>` install that carries `installTrackOwner` (`27_installs.js:436`). Drop the key and playback tracking stops on these links.
   - **So do this now (no behaviour change for links):**
     - Keep sending and storing `trackCreatorKey`.
     - On the server (`25_:7826-7842`), when `request.account` is the claimed account, authenticate with the session (`authenticateCreator(claimed, "")`) and verify `trackCreatorKey` separately with `verifyCreatorKeyMemoized` (it must still match before it is stored). That way the save no longer goes through the key path or bumps `authkey`.
     - Count these as `authkey:why:trackkey` so /admin shows them apart.
     - Test first: a session plus personal shelves save must not bump `authkey`, must still store the key, and a wrong `trackCreatorKey` must still be refused.
   - **Later (owner decision, part of retiring the old sign-in, not this pass):** let playback tracking accept the verified `trackOwner` stamp, as personal rows already do, or move these links to v2 `/i/` installs. Then links no longer need to store the key at all. The trade-off: today a key reset also stops tracking on old links. With the stamp, the owner would revoke a link instead.
4. Check: `node --test tests/client.test.mjs tests/worker.test.mjs tests/admin-*.test.mjs`, `bash verify.sh -q`, then `python tools/gen_map.py` if anything was added.
5. **Then report to the owner:** after the deploy, read the breakdown for a week. `withsession` should be ~0. A large `nocookie` count on `/api/creator/sync/*` means old tabs or blocked storage. A path no page uses means an outside caller. That decides the next step and when CQ-09 can start.

### CQ-06 Remove the `escapeHtmlSupport` alias
- `src/admin/59_support-emails.js:47` is `function escapeHtmlSupport(str) { return escapeHtmlServer(str); }`.
- Replace its 4 call sites in `59_` with `escapeHtmlServer`, then delete the alias.
- Check: `grep -rnw escapeHtmlSupport src tests` returns nothing. Run `node --test tests/support-emails*.test.mjs` (or whichever test file greps for it) and `bash verify.sh -q --fast`.
- Leave `escapeHtmlAdmin` (03_:4174) alone. It is client-side code inside the admin page and correctly separate.

### CQ-07 Delete two unused client wrappers
- `src/client/17_client-my-lists-and-trakt-oauth.js:3719` `loadPremadeCollectionsBtn()` only calls `addAllPremadeCollections()`.
- `src/client/17_client-my-lists-and-trakt-oauth.js:5466` `onCollectionsSearchKey()` only calls `searchCollections()`.
- Both names appear exactly once across `src`, `tests` and `tools`, and no `data-act` refers to them.
- Check: `bash verify.sh -q --fast`, `node --test tests/client.test.mjs`, then `python tools/gen_map.py`.

### CQ-08 Remove the catalog list wizard (owner: removed on purpose)
- Delete `catalogWizardName` (`src/client/20_client-channel-builder.js:11444`), `addCatalogWizardList` (:11476) and `runCatalogListWizard` (:11520, through the end of that function, about line 11600). Check with `grep -rnw` that each name is used only inside this group.
- Delete the tests that call them: `tests/client.test.mjs`, about lines 7440-7530 (the `catalogWizardName` and `runCatalogListWizard` cases). Removing a test for a deleted feature is not loosening a guard. Say so in the commit.
- Check that no CSS, copy or `data-act` mentions `catalogWizard`: `grep -rni catalogwizard src`.
- Check: `node --test tests/client.test.mjs`, `bash verify.sh -q --fast`, then `python tools/gen_map.py`.

### CQ-10 Make the repo's compatibility date match production (owner: yes, staging first)
- **Fact (owner checked the dashboard on 2026-11-02):** the production Worker `my-lists-addon` runs with compatibility date **`2026-07-27`** and **no compatibility flags**. The repo says `2024-01-01` in `wrangler.toml:20` (top level), `wrangler.toml:270` (`env.staging`) and `wrangler.selfhost.toml:12`.
- **So the problem is the reverse of what the audit first assumed.** Production is current. **Staging and self-hosted copies run on a 2½-year-older runtime than production**, so a staging test does not prove what production will do. Do **not** change anything in the dashboard.
- **Step 1 (research, no code).** On Cloudflare's "Compatibility dates" docs page, list the flags that turn on by default between `2024-01-01` and `2026-07-27`. Production already runs all of them, so this is only to know what staging will change in. Note any that touch APIs we use (`fetch`, streams, `URL`, `crypto`, Node built-ins, queue/cron handlers, `caches`). Read the page; don't rely on memory.
- **Step 2.** Set `compatibility_date = "2026-07-27"` in the `env.staging` section of `wrangler.toml`. The owner deploys staging (`docs/STAGING.md`) and runs `docs/DEPLOY_CHECKLIST.md`. Production is untouched, so the risk is only to staging.
- **Step 3.** Set the same date at the top level of `wrangler.toml` and in `wrangler.selfhost.toml`. Add a line to `docs/OPERATIONS.md`: "Production's compatibility date is set in the dashboard (Worker → Settings → Runtime). Keep `wrangler.toml` equal to it. When you change one, change the other." Mention it in `docs/SELF-HOSTING.md` too, since self-hosters' runtime changes with this.
- **Moving past 2026-07-27** is a separate future decision, done the same way: staging first, then the dashboard and the files together.
- Tests: `bash verify.sh -q`. The local harness does not emulate compatibility flags, so staging is the real check.

### CQ-11 / CQ-12 Documentation drift (docs only)
- `docs/AI_AGENT_WORKFLOW.md` says "every `NN_*.js`, currently `00_` through `58_`". The real range is `00_`–`61_`. It also gives `check_sync.py` as the verify command. `CLAUDE.md` says `bash verify.sh -q`.
- `docs/AI_UI_RULES.md`, "Build (every change)", gives a manual chain. Point it at `bash verify.sh -q` so there is one source of truth.
- `.github/workflows/ci.yml` and `verify.sh` comments say "27 sources … concatenated into ONE scope". There are now 62 files (header plus 61). Reword to "every numbered source".
- `src/core/01_icon-asset.js` header comment says "icon (placeholder, replace via /mnt/project source if needed)". That is a stale instruction from another environment.
- `AGENTS.md` names other agent products and model versions. Leave the product names, but check its build and verify commands match `CLAUDE.md`.
- Check: these are docs and comments only, so `bash verify.sh -q --fast` should still give the same build stamp for comment-only changes in `.github`/`docs`. Comments in `src/` do change the stamp, which is expected.

### CQ-13 Supply-chain hygiene for the build tooling
- `.github/workflows/*.yml` use `actions/checkout@v4`, `setup-node@v4`, `setup-python@v5` and `upload-artifact@v4`, pinned by tag. Dependabot is already set up for actions. **Recommendation:** pin each to a full commit SHA with a `# vX.Y.Z` comment, which Dependabot keeps updated. Ask the owner first, because it makes Dependabot PRs noisier.
- `verify.sh` and CI run `npm install --no-save acorn@8.14.0 eslint-scope@8.2.0`, with exact versions but no integrity hash. That is acceptable for a dev-only check. Optionally add a `tools/package.json` plus `package-lock.json` used only by `npm ci --prefix tools`. **Not required.** Only do it if the owner wants it.
- The vendored `fflate 0.8.2` (`src/core/01_icon-asset.js:1422-1443`) is the current upstream release, with an update procedure documented in place. No action.
- Runtime third-party fetch: `src/api/25_api-catalog-routes.js:120` loads a Roboto woff from `cdn.jsdelivr.net/fontsource/fonts/roboto@5.0.8`, version-pinned. No action. Note it in OPERATIONS as an external dependency if it is not already there.

---

## 3. Tier 2: deduplication with a guard (small, no behaviour change)

**Approach.** The client cannot `import` server code. Do not invent a sharing mechanism in this pass (that is rule 2). For each pair, first **add a parity test** that runs both copies on the same table of inputs and asserts the same output. The test harnesses already load each side: `tests/harness.mjs` for the worker and `tests/client-harness.mjs` for the client. If a pair already differs, the test shows it: report that as a bug and do not silently pick one copy.

### CQ-03 Server/client twin functions
| function | server copy | client copy | note |
|---|---|---|---|
| `isAdultOrNsfw` (and its certification list `['NC-17','X','XXX',…]`) | `src/catalog/05_catalog-core.js:798` | `src/client/19_client-search-and-likes.js:232` | adult filter. A drift here means the page and the addon disagree. |
| `getSafePosterUrl` | `05_:898` `(origin, {title,year,type,certification})` | `19_:253` `(item)` | different signatures. Test the URL each produces for the same item. |
| `isEpisodeAired` | `src/core/02_http-and-creator-utils.js:5990` (string) | `19_:2676` (string **or** episode object) | the client accepts more. Parity test on string input only. |
| `isGenericEpisodeTitle` | `02_:6005` | `19_:2694` | regexes are doubled-escaped on the client. Parity test is essential. |
| `formatAirDateBadge` | `02_:6104` | `19_:3048` | |
| `mergeNuvioCollections` | `src/api/61_media-app-sync.js:1369` | `src/client/17_…:4529` | already the same apart from style (`for…of` vs index loop). |
| `extractNuvioCollections`, `isMyListsNuvioCollectionId`, `addNewNuvioCollection` | `61_` | `17_` | same family as the line above. |
| `isPublicChannelRow` | `src/core/04_config-resolution.js:672` | `src/client/16_client-row-core.js:2636` | |
| `toggleTheme` | `src/page/09_page-shell.js` | `src/client/24_…` | check whether both run on the same page. If they do, the later one silently wins. |

Steps:
1. Create `tests/server-client-parity.test.mjs`. For each row, load the worker function and the client function and run 10–20 representative inputs, including edge cases: empty, `null`, odd date formats, `"TBA"`, `"Episode 5"`, adult certifications in lower case. Assert the outputs are equal. **The test must fail if either copy's business rule changes** (rule 10). Prove that by temporarily editing one copy, watching the test fail, and reverting.
2. At each copy, add a one-line comment: `// Twin of <file>:<fn>; tests/server-client-parity.test.mjs keeps them equal.`
3. Do **not** merge the copies in this pass. Merging needs a build-time injection mechanism, which is a Tier 3 proposal (§4, CQ-03b).

Check: `node --test tests/server-client-parity.test.mjs`, then `bash verify.sh -q`.

### CQ-04 Trakt "continue watching" logic copied into a route
**Step 2 status (2026-11-02): done.** The route is not a copy (it builds richer candidates), so it was kept and made to agree with the shelf where the owner wanted it: episodes filed under the show's id; paused shows matched by lower-cased IMDB id and slug; both look at 40 shows (`TRAKT_CONTINUE_NEXT_EPISODE_SHOWS`, own commit, lower it if Trakt returns 429/1015). Shows with only a Trakt id stay in the website list but not the shelf (owner chose to keep this). One commit per decision; details in tests/continue-watching-parity.test.mjs.

- `fetchTraktContinueWatching` (`src/catalog/06_source-fetchers-mdblist-trakt.js:1228`, 256 lines) and the `fetchFn` inside `/api/trakt-my-private-lists` (`src/api/25_api-catalog-routes.js:6301`, 423 lines) both build `hiddenShowKeys` and define a nested `isHiddenShow` that is identical line for line (06_:1312 and 25_:6474), plus similar playback and watched-progress handling.
- Step 1 (Tier 2, safe): lift `isHiddenShow(hiddenShowKeys, sObj, idObj)` to a single top-level helper next to `fetchTraktContinueWatching` in `06_`, and call it from both places. Check that the name is free first: `grep -rnw traktIsHiddenShow src`. Pick an unused name like that one.
- Step 2 (ask the owner): find out why the route rebuilds the candidates instead of calling `fetchTraktContinueWatching`, which may be for counts or a preview. If the outputs should match, the route should call the shared function. Write the parity test first.
- Tests: grep `tests/` for `trakt-my-private-lists` and `continue` and run those files.

### CQ-05 Trakt header boilerplate (36 copies)
**Status (2026-11-02): done.** See the Progress table. Helper takes an optional second argument (the person's own Trakt app id) and omits Authorization without a token, which let the 6 sites without a token and the 5 with their own key use it too.

- Every Trakt call writes out `Content-Type`, `trakt-api-version: "2"`, `trakt-api-key: TRAKT_CLIENT_ID`, `Authorization: Bearer …` and `User-Agent: my-list-addon/${ADDON_VERSION}`.
- Add `traktHeaders(accessToken)` next to `fetchTraktWithRetry` (check the name is free). Replace the copies **one file per commit**, and only where the object is byte-for-byte the same set of keys. Leave any call site that adds or omits a header.
- Check: `grep -c '"trakt-api-version": "2"' src -r` goes down. Run the Trakt-related tests and `bash verify.sh -q`.
- Optional. Skip it if time is short. It lowers the chance of drift but fixes no bug.

---

## 4. Tier 3: structural

CQ-01 and CQ-18 are **approved by the owner**. CQ-03b and CQ-09 are still proposals: do not start them.

### CQ-01 Split `handleFetch` into route handlers (approved)
- **Problem.** About 165 route branches in one 15.6k-line closure across `25_` and `26_` (`26_` has 0 top-level symbols because it is the second half of `handleFetch`). Its local variables leak into every later branch, which is the exact bug class `tools/scope_check.mjs` was written for (`isShow`, `clientId`, `listName`). Newer modules already use the better shape: `handleListsApiRoutes` (31_), `handleMediaAppRoute` (61_), `handleSupportEmailsApi` (59_), installs (27_) and connections (28_).
- **Proposal.** Move the code mechanically, in small slices, following that existing pattern. One route group per PR, for example `/admin/api/*` from `26_` into `handleAdminApiRoutes(request, env, ctx, url)`. `handleFetch` calls it at the original position and returns its result when it is not `null`. The order of checks must not change.
- **Biggest nested functions to move out first** (each is a self-contained closure already): `handleMediaServerScrobble` (26_:673, 651 lines), `handleSubtitlesTrack` (26_:245, 425 lines), `authenticateCreator` (26_:12, 167 lines). For each one, find every outer variable it captures (the scope check output, or read it) and pass those in as parameters.
- **Guard.** `tests/route-access.json` plus `tests/route-access.test.mjs` already pin the route list. Keep them green without editing the expected list. The whole suite must pass unchanged.
- **Where new code goes.** Put each extracted group in a **new numbered file** in the matching folder, using a free prefix (`62_` and up; `00_`–`61_` are taken). For example `src/api/62_admin-api-routes.js`. Every top-level name in it must be a `function` declaration, because those are hoisted, so the file's position in the build does not matter. Don't add top-level `const`/`let` there that other files read while the Worker is loading. Add a header comment line (`tools/gen_map.py` reads it into `FILE-INDEX.md`) and run `gen_map.py`.
- **Order of slices** (one PR each; each one smaller than about 1,500 moved lines):
  1. `authenticateCreator` (26_:12) → a top-level `authenticateCreator(request, env, ctx, path, creatorNameRaw, creatorKey)`. Every route calls it, so keep a one-line local wrapper inside `handleFetch` with the old signature. That way **no call site changes** in this slice.
  2. `handleSubtitlesTrack` (26_:245) and `handleMediaServerScrobble` (26_:673).
  3. `/admin/api/*` routes in `26_` → `handleAdminApiRoutes`.
  4. `/api/creator/*` routes → `handleCreatorApiRoutes`. Split it further if it is over 1,500 lines.
  5. Catalog, manifest and meta routes in `25_` → `handleCatalogRoutes`.
  6. Whatever remains, by path prefix.
- **Each slice:** run `bash verify.sh -q` (the scope check catches a variable the moved code still expected from `handleFetch`) and `node --test tests/route-access.test.mjs tests/worker.test.mjs`. Before the move, record the route answers for a fixed list of requests (status plus body hash, using the existing harness) and assert they are byte-identical after. Keep that script in the scratchpad, not in the repo.

### CQ-18 Size rule for functions and files, enforced by a ratchet test (approved)

**Recommended limits.** These are not industry law: they are what keeps a file readable by a person and by an AI that reads files in ranges.

| what | target | hard limit for **new** code | why |
|---|---|---|---|
| function | ≤ 80 lines | **150 lines** | about one screen. 26 server functions are already over this. |
| source file (`src/**/NN_*.js`) | ≤ 1,500 lines | **3,000 lines** | an agent can read a file in a few ranges. 14 files are over 4,000 today (15 over 3,000). |
| route handler group | ≤ 1,500 lines | 3,000 | the same as a file: one group per file |

Exempt: `renderBuilder` (09_) and `renderAdminDashboard` (03_). They are template containers whose length is the page itself. Also exempt the client code inside the page template, which the server parser cannot see. For the client, apply only the **file** limit, measured on the source file.

**The test: a ratchet, not a hard wall.** A hard wall would fail today and force a big-bang refactor, which rule 2 forbids.
- `tests/size-budget.json` is the committed baseline. It lists every function over 150 lines and every file over 3,000 lines, each with its current line count.
- `tests/size-budget.test.mjs`:
  1. Concatenate the server sources the way `build.py` does (header first, then `NN_` order). Parse with acorn (already installed by `verify.sh` for the scope check; copy the module loading from `tools/scope_check.mjs`) and measure every function. Map lines back to their source file. Measure each `src/**/NN_*.js` by line count.
  2. **Fail** if a function or file that is **not** in the baseline is over its limit. The message says: "new code over the limit: split it".
  3. **Fail** if a baseline entry is **larger** than its recorded size. The message says: "grew from X to Y: may only shrink".
  4. **Fail** if a baseline entry is now under the limit or no longer exists. The message says: "remove it from tests/size-budget.json". This keeps the list honest as CQ-01 shrinks things.
  5. Support `node tests/size-budget.test.mjs --update` to rewrite the baseline with the **current smaller** numbers only. It must never raise a number, which is the same idea as `ui-contract --update`.
- **Rule 10 proof.** Temporarily add a 160-line function to a source file and watch the test fail. Temporarily add a line to `handleFetch` and watch it fail. Revert both.
- Add one line to `CLAUDE.md` under Hard rules: "Functions ≤ 150 lines, source files ≤ 3,000 lines for new code; `tests/size-budget.test.mjs` enforces it and the baseline may only shrink." Add one line to `AGENTS.md` too, so all agents see it.
- Do CQ-18 **before** CQ-01. Then each CQ-01 slice shows up as baseline numbers going down.

### CQ-03b One source for the twin functions
- After the parity test exists, the owner may want a single copy. Option: in the client template, emit `${isGenericEpisodeTitle.toString()}` from the server function instead of a hand copy. Interpolated values are not escape-processed, so the regexes stay correct. Risks: the client bundle hash changes, and the scope check and CSP checks must still pass. Prototype on **one** function first.

### CQ-09 Retire post-cutover feature flags (blocked: do not start)

**Owner, 2026-11-02:** this waits on retiring the old Account Key sign-in, which waits on the "Saves that sent the Account Key" count reaching near zero for about a week (CQ-17). Leave every flag as it is. The notes below are for later.

- All the v2 cutover flags are on in staging and in `wrangler.selfhost.toml`, and `FF_V2_LISTS_ONLY`/`FF_EVENT_TRACKING` are one-way. The "off" branches are now dead in practice but still tested and maintained. Reads: `src/catalog/05_catalog-core.js:1905,1913,3106`, `src/api/33_lists-directory.js:6,38,41,171`, `src/api/25_api-catalog-routes.js:459,1045,8080`, plus `FF_SESSIONS`, `FF_INSTALLS`, `FF_CHART_SNAPSHOTS`, `FF_CANONICAL_IDS`, `FF_MATERIALIZER` and `FF_PROVIDER_BREAKER`.
- **Owner decision needed:** "Is every flag on in production, and may self-hosters run with any of them off?" If the owner says yes to removing them, retire **one flag per PR**: make the flag-on path unconditional, delete the off path and its tests, and add a `docs/DECISIONS.md` entry. Start with the smallest (`FF_CANONICAL_IDS`, 1 read).

---

## 5. Architecture notes (for context, no task)

- **File names vs contents.** `02_http-and-creator-utils.js` (7,144 lines, 274 symbols) is a grab bag: HTTP helpers, sessions, account purge, backfill, D1 tracking reads and writes, and episode helpers. `17_client-my-lists-and-trakt-oauth.js` also holds Nuvio collections. `24_client-backup-restore-presets.js` holds the app-shell behaviour bundle and `renderGuidePage`. `26_api-creator-and-admin-routes.js` is the second half of `handleFetch`. Do not rename files (rule 2). If it helps, improve the one-line "about" comment that `tools/gen_map.py` reads into `FILE-INDEX.md`.
- **Single shared scope** is the design, and the build and scope check guard it. Keep it.
- **`renderBuilder`** returns the whole page and client code as one template literal. That is the design. `tools/render_check.js` and `html_checks.py` validate it. Leave it.

## 6. Large functions (reference: only tidy when you are already in there)

Server top-level functions over 250 lines: `fetchAutoTrackedCatalog` (05_:2624, 467), `purgeCreatorData` (02_:4728, 454), `handleMediaAppRoute` (61_:1676, 410), `fetchTmdbItemDetailsUncached` (07_:3857, 392), `backfillAccounts` (02_:5574, 312), `checkForNewEpisodes` (07_:4863, 284), `writeCreatorTrackingD1` (02_:6424, 259), `fetchTraktContinueWatching` (06_:1228, 256). There are 26 functions over 150 lines in all. Measured with an acorn walk over the concatenated server sources.

## 7. Scan numbers (for comparing later)

| metric | count |
|---|---|
| source files (`src/**/NN_*.js` + header) | 62, ~5.97 MB |
| server functions (AST) / top-level | 2,684 / 1,294 |
| duplicate top-level function names server↔client | 9 pairs (CQ-03) |
| empty `catch {}` (all of src, including client) | 627 (server subset tracked as BA-008) |
| `TODO`/`FIXME`/`HACK` markers | 0 |
| `var` declarations | 158 |
| `innerHTML =` assignments (client) | 448 (escaping rules in AI_UI_RULES #6, already audited) |
| inline `style="…"` | ~708 matches (DESIGN_SYSTEM §9 #1 tracks ~556 as intentional) |
| `JSON.parse(JSON.stringify(…))` deep clones | 23 (`structuredClone` exists in Workers and modern browsers; not worth churning) |
| tests | 122 files; `worker.test.mjs` 17,172 lines, `client.test.mjs` 8,816 lines |

## 8. Questions for the owner
Answered on 2026-11-02: wizard (remove it), split `handleFetch` (yes), compatibility date (yes, staging first), flags (wait for the sign-in retirement).

Still open:
1. Later, with the sign-in retirement: should playback tracking on older install links use the server's owner stamp instead of a stored Account Key? (Researched: the key is only still needed for playback tracking on those links.)
2. CQ-03b: after the parity test, keep two copies, or generate the client copy from the server function?
3. CQ-13: pin GitHub Actions to commit SHAs?

## 9. Suggested order and checkpoints
0. CQ-16 (DST helper; failing test first) → commit.
1. CQ-17 steps 1–2 (counter breakdown and /admin table) → commit. Then step 3 (session auth for the install-link save, the key still stored; failing test first) → commit. **Ship these first**, because the owner needs a week of data.
2. CQ-08 (wizard) → CQ-06 → CQ-07 → CQ-12/11 (docs) → `bash verify.sh -q` → commit each.
3. CQ-03 parity test (prove it fails when one copy is changed) → CQ-04 step 1 → CQ-05 (optional).
4. CQ-18 size-budget ratchet test, plus the CLAUDE.md/AGENTS.md rule.
5. CQ-01 slices, one PR each, in the order given. The size baseline shrinks with each one.
6. CQ-10: step 1 (research), then step 2 (staging only; the owner deploys and checks), then step 3 (the other files and the docs). Production is not touched.
7. Not now: CQ-09 (blocked by CQ-17's data), CQ-03b (needs a yes).
8. At the end of each session: `python tools/gen_map.py`, a RELEASES.md entry, the full `bash verify.sh -q`, then push.
