# 02 Bugs and reliability
Health grade: B+ — no crash or data-loss bug on the everyday paths. The proven problems are narrow: one bad entry in a synced list can silently kill an install link, an account deletion can leave list data behind, and a few routes return a 500 for odd input. Cron, KV/D1 outages, in-memory caches, and the usual race spots held up.

All scratch scripts live in `/tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s02/` (call it `$S` below). Each one imports the real Worker through `tests/harness.mjs` and needs nothing else. Nothing in the repo was changed except this report.

## Scope covered (files, routes, commands run)
- Fuzzed every literal route in `tests/route-access.json` (186 routes) against the real Worker in-process. Methods GET/POST/DELETE/PUT; broken JSON, `null`/array/number/string bodies, a 5000-deep array, wrong-typed fields, 300 KB strings, unicode/lone surrogates, odd query values. Script `$S/fuzz.mjs`, runs: normal upstream, upstream answering `null`, upstream answering a JSON array (`fuzz-full.log`, `fuzz-null.log`, `fuzz-array.log`).
- Fuzzed the parameterised public routes (`/:config/manifest.json`, `/:config/catalog/...`, `/meta`, `/subtitles`, `/lists/*`, `/channel/*`, `/bp/*`, `/rpdb/*`, `/api/likes/*`, `/i/*`, `/c/*`) with 25 odd path pieces each, plus 15 shapes of corrupt stored install config (`$S/fuzz2.mjs`, 924 calls).
- Concurrency with `Promise.all` of `worker.fetch`: 12 parallel list saves, 5 same-name saves, 15 parallel likes, 6 parallel account creates, delete-account racing list saves, 3 overlapping cron ticks.
- Cron / queue: `scheduled()` with a normal env, queue bound, no D1, no TMDB key, KV throwing, D1 throwing, outbound fetch throwing (`$S/cron1.mjs`).
- Read the code of: `src/api/67_creator-api-routes.js` (list save/create), `src/api/68_creator-api-account-and-save-routes.js`, `src/api/78_save-and-like-routes.js`, `src/api/32_likes-api.js`, `src/admin/04_stat-counters.js`, `src/core/04_config-resolution.js`, `src/core/03_json-object-body.js`, `src/catalog/41_provider-breaker.js`, plus every module-level `Map`/`Set` on the server (32 of them) for size limits, and the client `setInterval`/poll code.
- Large lists: saved 1,000 / 5,000 / 20,000 items (`$S/big1.mjs`).

## Fix progress

Updated 2026-11-10. Status values: `open`, `fixed (awaiting verification)`, `verified fixed`, `open (partially fixed, ...)`, `regression introduced (...)`. Rows marked in the Verified column were checked by an independent review on 2026-11-10; see each finding's **Verification.** note.

| Finding | Status | Commit | How to verify | Verified |
|---|---|---|---|---|
| BUG-01 | verified fixed | a0b0ea7 | node --test tests/sync-config-bad-entries.test.mjs | 2026-11-10, independent review |
| BUG-02 | verified fixed | c1c7abe, 2b9a2cd | node --test tests/save-after-delete-account.test.mjs tests/save-after-delete-account-v2.test.mjs | 2026-11-14, independent review |
| BUG-03 | verified fixed | 0bef949 | node --test tests/details-region-junk.test.mjs | 2026-11-14, independent review |
| BUG-04 | verified fixed | e57945c | node --test tests/tmdb-my-lists-bad-key.test.mjs | 2026-11-14, independent review |
| BUG-05 | verified fixed | 0cd9a5d | node --test tests/creator-create-username-race.test.mjs | 2026-11-14, independent review |

## Proven findings   (ordered by severity)

### BUG-01 One empty entry in a synced list makes the whole install link "not found"
- Severity: Medium
- Status: Proven
- File:line: `src/api/68_creator-api-account-and-save-routes.js:373` (accepts any array), `src/core/04_config-resolution.js:80-81` (crashes on a `null` entry), swallowed at `src/core/04_config-resolution.js:94-96`
- What is wrong: `/api/creator/sync/save` stores `body.config` as is as long as it is an array; it never checks that each element is an object. When the install link is later opened, `resolveCreatorSyncConfig` does `list.map((e) => e.id || ...)`. A single `null` entry throws a TypeError, the surrounding `catch { return null; }` hides it, and the caller treats "no config" as "no such link". The same `.map` exists for the TV launcher record at lines 52-53.
- Impact: the person's whole Stremio/Nuvio/Wako install (their own username link) answers `404 "That install link was not found."` and every catalog row comes back empty. Nothing is logged, so it is very hard to diagnose, and it persists until a good save overwrites it. It needs a buggy or old client (or the owner's own key) to send the `null`, so it is rare, but the damage is total and the message is misleading.
- Proof: `node $S/bugB2.mjs`
```
config= [{"id":"trakt-1",...}] save 200 | manifest 200 {"id":"app.my-list",...  | catalog 200 {"metas":[{"id":"tt0000000",...
config= [{"id":"trakt-1",...},null] save 200 | manifest 404 {"ok":false,"error":"That install link was not found."} | catalog 200 {"metas":[]}
config= [null] save 200 | manifest 404 {"ok":false,"error":"That install link was not found."} | catalog 200 {"metas":[]}
config= [{...},5] save 200 | manifest 200 ...
```
  The save itself answers 200 for the bad config. (`/api/save`, the anonymous route, does refuse such entries: "Every list needs to be a list row." — checked with `$S/bugB.mjs`, so only the sync route lacks the check.)
- Recommended fix and effort: S. In the sync save, keep only entries that are plain objects (or answer 400); and in `resolveCreatorSyncConfig` use `(e && (e.id || ...))` so one bad row is skipped instead of failing the whole link.

**Verification.** 2026-11-10, independent review: **verified fixed**. Read a0b0ea7. Running the new test against the parent commit fails 2 of 2. Two mutations on HEAD each fail it: removing the save filter, and removing the read filter in `resolveCreatorSyncConfig`. All non-object entries (`null`, `5`, `"x"`, `[1]`) are dropped on save, and a `null` already stored no longer breaks the manifest. No other `config.map` reader exists outside the client. One gap remains: the same filter on the TV-launcher record (`tvParsed`) has no test. Removing it leaves both `sync-config-bad-entries` and `nuvio-tv-sync` green. The code there is correct.

### BUG-02 Deleting an account while a save is in flight leaves the list data behind
- Severity: Low
- Status: Proven
- File:line: `src/api/67_creator-api-routes.js:1176-1180` (writes the list after auth with no re-check), `src/api/68_creator-api-account-and-save-routes.js:218` (purge)
- What is wrong: a list save authenticates at the start, then does several awaits before writing `creatorlist:{user}:{slug}`. If "Delete account" finishes its purge in between, the save still writes its records and answers `200 ok`. Nothing sweeps them afterwards.
- Impact: the person asked to delete everything, was told it was done, but list names, items and the order key stay in KV for a deleted account (until someone registers the same username, which runs a pre-create purge). The leftover lists are not served publicly (public GETs and the directory answer 404 / empty) so this is retained data, not exposed data. It needs two tabs/devices acting at the same moment.
- Proof: `node $S/race5c.mjs 12` (5 saves and a delete fired together, 12 trials)
```
trial 1 LEFT: creatorlist:dr1zz:l3, creatorlistorder:dr1zz, creatorliststamp:dr1zz, creatorlist:dr1zz:l1, creatorlist:dr1zz:l4
  public GET l1 404 ... auth with old key: 401
trials 12 leaks 7
```
  (`$S/race5d.mjs` shows no D1 rows left, directory empty.)
- Recommended fix and effort: M. After writing, a save should re-check that the account still exists (and remove its own writes if not), or the purge should run a second sweep after a short delay.

**Verification.** 2026-11-14, independent review: **partially fixed**, Status set back to `open`. Read c1c7abe and its follow-ups 717d9ea and 2948496 (helper `creatorListSaveRetractIfDeleted` in `src/api/67_creator-api-routes.js`). The new test fails on the parent commit ("a save into a deleted account must not report success") and passes on HEAD. With the audit's race (5 saves plus a delete fired together, 40 trials, default test flags) the parent leaves list keys in KV and `lists_fts` rows in 19 of 40 trials; HEAD leaves nothing in 40 of 40. What is still wrong:
1. **Production does not run this path.** `docs/RELEASES.md` says `FF_V2_LISTS_ONLY` has been on since 2026-10-01. Under that flag the save takes the `listsOnly` branch (`listsV2WriteRecord`, then return), which has no re-check. The same 40-trial race with `MLA_TEST_FLAGS=FF_V2_LISTS_READ,FF_V2_LISTS_API,FF_V2_LISTS_ONLY,FF_SESSIONS,FF_INSTALLS` leaves an `accounts` row, `lists` rows and `lists_fts2` rows in 19 of 40 trials, with every save and the delete answering 200. A sequential save then delete under the same flags leaves nothing, so this is the race and not normal behaviour. The leftovers are not served (public list 404, profile 404). The new test does not cover this: under those flags it fails at "the race was actually staged", because no `creatorlist:` key is ever written.
2. Smaller, legacy path: the re-check runs before `creatorListSaveSearchIndex` and `listsV2MirrorLists`. A delete that starts after the re-check and finishes before the search-index write leaves a `lists_fts` row (list name and display name), and the save answers 200. Staged by running the delete inside the `lists_fts` batch. Search does not show it, because it joins on `creator_lists`.
Next fix: give the `listsOnly` branch the same post-write check, and have it remove the v2 rows and the account row it may have recreated. Add a test that runs under `FF_V2_LISTS_ONLY`. Optionally run the check after the search-index and mirror writes too.

**Verification (second round).** 2026-11-14, independent review: **verified fixed** for the production path. Read 2b9a2cd (hash found as given). The `listsOnly` branch of `creatorApiListsSave` now calls `creatorListSaveRetractIfDeleted(env, auth, slug, true)` after `listsV2WriteRecord` and the stamp bump. With a standing tombstone it runs `listsV2PurgeAccount`, then `deleteAccountRow`, then answers 401. The new test `save-after-delete-account-v2` fails on the parent commit ("a save into a deleted account must not report success") and passes on HEAD. Own race script (5 saves plus a delete fired together, production flags `FF_V2_LISTS_READ,FF_V2_LISTS_API,FF_V2_LISTS_ONLY,FF_SESSIONS,FF_INSTALLS`, a second account created after the racer so its id is not the highest, 40 trials): the parent left an `accounts` row, a `lists` row and a `lists_fts2` row in 8 of 40 trials. HEAD left nothing in 40 of 40, and the other account was untouched every time. Safety checks: the tombstone is written only by account deletion (`purgeCreatorData` with `deleteIdentity`, `writeDeletionTombstone`), never by account reset, and `/api/creator/create` refuses a tombstoned name. So the new `deleteAccountRow` call cannot remove a live or newly registered account. Foreign keys are on in the harness, as in D1, so a write that lands after the account row is gone fails with 503 and does not leave orphan rows. No test was changed or loosened. Full `bash verify.sh -q` on HEAD: PASSED, but the browser tests (UI contract, end-to-end) were SKIPPED because Playwright is not installed here.
Gaps, not blocking:
1. **The new test does not guard the cleanup it adds.** Mutation on HEAD: removing the `deleteAccountRow` line leaves the test green, but the race script then leaves an `accounts` row in 6 of 40 trials. Removing the `listsV2PurgeAccount` line leaves both the test and the race clean, because deleting the account row cascades. The test stages the delete at the `lists_stamp` update, after the v2 write, so the delete's own purge already removes everything and only the 401 is checked. A test that stages the interleaving where the account row comes back is the missing piece.
2. Legacy (flag off) point 2 above is still open, as the fixer noted: a delete landing between the re-check and `creatorListSaveSearchIndex` can leave one `lists_fts` row. Production does not run this path, and search does not show the row.

### BUG-03 A region value with an emoji in the first two characters crashes `/api/details` with a 500
- Severity: Low
- Status: Proven
- File:line: `src/catalog/07_source-fetchers-tmdb-simkl.js:3806` (also `:783`, `:3856`, `:1338`), blown up at `src/core/02_http-and-creator-utils.js:2757`
- What is wrong: `(region || "US").toUpperCase().slice(0, 2)` cuts by UTF-16 units. A region like `a<emoji>` is cut in the middle of the emoji, leaving half a character in the cache key, and `encodeURIComponent(cacheKey)` throws `URIError: URI malformed`. `/api/details` (single) has no catch around it; the batch variant has a per-id catch so it is safe.
- Impact: only junk input triggers it (the app sends `US`, `GB`...), so a real user never sees it. An anonymous caller gets a 500 instead of a normal "not found", which also shows up as an error in the logs.
- Proof: `node $S/bugA.mjs`
```
region=US                        -> 404 {"ok":false,"error":"Not found or TMDB error"}
region=a + emoji                 -> 500 {"ok":false,"error":"URI malformed"}
region=lone surrogate via POST   -> 500 {"ok":false,"error":"URI malformed"}
```
  Stack (from `$S/bugA5.mjs`): `encodeURIComponent` ← `fetchWithPerUserCacheUncoalesced` ← `fetchTmdbItemDetails` ← `apiDetails`.
- Recommended fix and effort: S. Only accept `/^[A-Za-z]{2}$/` for region (else fall back to `US`).

**Verification.** 2026-11-14, independent review: **verified fixed**. Read 0bef949 and the final form in 2948496: `/^[a-z]{2}/i.test(String(region || "")) ? String(region).slice(0, 2).toUpperCase() : "US"` at `src/catalog/07_source-fetchers-tmdb-simkl.js:783`, `:3806` and `:3856`. On the parent commit the new test fails 2 of 3 ("URI malformed"). On HEAD it passes. These inputs to POST `/api/details` all gave 404 and no 500: `ab`+emoji, emoji first, object, `["gb"]`, number, `" GB"`, `null`, a 300 KB string, Kelvin sign. GET with `a%F0%9F%98%80` and with encoded lone surrogates gave the same, and `/api/details/batch` gave 200. The other `slice(0, 2)` sites are `newOnStreamingRegion`, `57_title-details-fallback.js:24`, the admin new-on-streaming route and `buildRegionOptionsHtml`. Each compares against a fixed list or is admin-only, so none of them reaches `encodeURIComponent`. Minor behaviour note: a padded `" GB"` now becomes `US`. Before, it became `" G"`, which was already wrong. Not tested (unproven): `fetchTmdbChart` (`:884`) puts `region || "US"` into a cache key without validating it, reached via the install region and `/api/preview`. The audit's fuzz did not show a 500 there.

### BUG-04 `/api/tmdb-my-lists` returns 500 when `tmdbKey` is not a string
- Severity: Info
- Status: Proven
- File:line: `src/api/76_external-list-routes.js:1301` and `:1310`
- What is wrong: `manualKey = body.tmdbKey` is taken without a type check, then `apiKey.startsWith("ey")` throws for an object, number or `true`.
- Impact: a hand-made request gets `500 apiKey.startsWith is not a function` instead of a 400. The real page always sends a string.
- Proof: `node $S/fuzz.mjs /api/tmdb-my-lists` prints `!! POST /api/tmdb-my-lists [all:obj] -> 500 {"ok":false,"error":"apiKey.startsWith is not a function"}` (also logged in `$S/fuzz-full.log`). The same route also 500s on a lone surrogate in `sessionId`/`accountId` ("Failed to load TMDB lists: URI malformed").
- Recommended fix and effort: S. `String(body.tmdbKey)` or reject non-strings.

**Verification.** 2026-11-14, independent review: **verified fixed**. Read e57945c, a one-line type check at `src/api/76_external-list-routes.js:1301`. On the parent commit the new test fails 3 of 3 ("apiKey.startsWith is not a function"). On HEAD it passes. More inputs: `["eyJabc"]`, `""`, `0` and `false` give a 400 "TMDB API key is missing." (no server key in the harness; with one configured, a non-string key falls back to it, the same as an empty one). Real string keys behave as before. `apiKey.startsWith` is the only such call in `src`. The lone-surrogate `sessionId` case, which the fixer left as a separate cause, answered 200 in this stubbed run.

### BUG-05 Two people registering the same new username at the same moment: the loser gets a 500 instead of "already taken"
- Severity: Info
- Status: Proven
- File:line: `src/api/67_creator-api-routes.js:157` (check), `:192-194` (insert, answers 500)
- What is wrong: the "is it taken" check and the insert are not atomic. The route relies on its per-address limiter to prevent a double submit, which only works for one address; two different addresses racing for one name both pass the check, and the second hits `UNIQUE constraint failed: creators.username`, which is reported as `500 Failed to create creator account. Please try again.`
- Impact: exactly one account is created and works (the winner authenticated fine afterwards). The loser sees a misleading server error instead of "That username is already taken." Trying again gives the right message. Very rare.
- Proof: `node $S/race4b.mjs`
```
sequential 1st: 200 2nd: 200 That username is already taken.
concurrent x2: 200 ok | 500 Failed to create creator account. Please try again.
D1 write error (creator create): Error: UNIQUE constraint failed: creators.username
```
- Recommended fix and effort: S. Treat a UNIQUE failure in `persistNewCreatorProfile` as "already taken".

**Verification.** 2026-11-14, independent review: **verified fixed**. Read 0cd9a5d. On the parent commit the new test fails its UNIQUE case. On HEAD it passes, and its second case confirms other D1 failures still answer 500. Real race, not stubbed: two concurrent `/api/creator/create` calls from different addresses, 30 trials. The parent gave `200 ok | 500 Failed to create` 30 of 30 times. HEAD gave `200 ok | 200 That username is already taken.` 30 of 30 times, the same answer as the sequential path. In every trial the winner could save a list afterwards, with default flags and with production flags (`accounts` row present). `username` is the only unique column on `creators` (primary key), so the regex cannot misread another constraint.

## Fixer notes (2026-11-14)
- BUG-02: the save re-checks the deletion tombstone after its writes and removes its list, order and stamp keys, answering 401. It does not clean the D1 list row written earlier in the same save, nor the v2 (listsOnly) path.
- BUG-04: only the non-string `tmdbKey` is fixed. The lone-surrogate `sessionId`/`accountId` 500 on the same route ("URI malformed") is a separate cause and was left as is.
- Unverified hunch: `newOnStreamingRegion` and `src/catalog/57_title-details-fallback.js:24` still slice by UTF-16 units, but only compare against a fixed list, so no throw was seen.

Follow-up commits after the size-budget check: the BUG-02 and BUG-03 code moved in the commits after their first ones (helper extraction, inline region check). Search by ID with `git log --grep='BUG-0'` for all commits; the table hashes are the first commits.

- BUG-02 (second round, 2b9a2cd): the `listsOnly` (FF_V2_LISTS_ONLY) branch now runs `creatorListSaveRetractIfDeleted` after its v2 write; with a standing tombstone it purges the v2 rows (`listsV2PurgeAccount`), removes the account row (`deleteAccountRow`) and answers 401. New test `tests/save-after-delete-account-v2.test.mjs` fails on the parent. The audit's race (5 saves plus a delete, 40 trials, production flags) left leaks in 13 of 40 before and 0 of 40 after. Not done: the optional point 2 (legacy path, delete landing between the re-check and the search-index write).

## Unproven suspicions   (not counted)
- Overlapping cron ticks run the same job more than once. With three simultaneous ticks "New on Streaming JustWatch" ran three times (`$S/cron1.mjs` prints the line 3 times). I did not show that it creates duplicates or double cost; it may be idempotent. In production ticks overlap only if one runs longer than its interval.
- `buildNetworkChannelPreset` (`src/catalog/07_source-fetchers-tmdb-simkl.js:2746`) throws if TMDB answers JSON `null` (`discoverData.results`) and `/api/channel-preset` then returns a 500 (seen in `$S/fuzz-null.log`). TMDB does not send `null` for this endpoint, so this is hypothetical.
- With the stub answering JSON `null` for every outbound call, three more provider routes returned 500 (`$S/fuzz-null.log`): `/api/simkl/my-lists` ("reading 'movies'"), `/api/trakt/device/token` ("reading 'access_token'"), `/api/tmdb-my-lists`. A real provider does not answer `null`, so these are robustness gaps, not live bugs, and I did not trace each to its source line. `/api/tmdb/oauth/start` answers 500 when TMDB is unreachable (it could be a 502); not traced either.
- `slugifyServer` (`src/core/02_http-and-creator-utils.js:2073`) trims the dashes before it cuts to 60 characters, so a long name can give a slug ending in `-`, and the duplicate suffix then reads `name--2`. Cosmetic, not run.

## Checked and rejected  (suspected, turned out handled)
- Lost updates on the list order key under 12 parallel saves: all 12 slugs unique, 12 order entries (`$S/race1.mjs`). `creatorListSaveAddToOrder` re-reads and merges, and the same-name case is also safe (`$S/race2.mjs`: `same-name`, `-2`..`-5`).
- Lost likes with 15 voters at once on the legacy like route: ledger has 15 voters and counts 1..15 (`$S/race3.mjs`). The v2 route uses `INSERT OR IGNORE` plus `changes()`.
- Non-object JSON bodies (`null`, `[]`, `123`, `"str"`, broken, 5000-deep array): every route answered 4xx, none 500, via `readJsonObject` (`src/core/03_json-object-body.js`).
- Unbounded in-isolate `Map`/`Set` caches: all 32 checked have a size cap or TTL pruning. `NUVIO_TV_SCHEDULE_CHECKED` (`src/api/29_nuvio-tv-schedule.js:36`) has no cap but is only written for channels that exist, so it is bounded by the number of real channels.
- Client timers: Trakt device poll and Stremio link poll clear any earlier interval and stop on expiry or success; the 60 s sync interval and `NUVIO_FOLDERS_REFRESH_MS` interval are page-lifetime singletons.
- Cron and queue under failure (KV down, D1 down, no D1, no TMDB key, outbound fetch throwing): `scheduled()` never threw and no unhandled rejection appeared.
- Stat counters: bumps are batched and a failed flush is put back; the KV fallback loses counts by design and is documented.
- Stored configs with wrong shapes (`null`, `[]`, `123`, strings, `entries: "x"`, broken JSON): manifest/catalog/meta/subtitles all answered without 5xx, except the `entries:[null,...]` shape. That shape cannot be reached through `/api/save` (it is refused with 400); the reachable route to it is BUG-01.
- Very large lists: 1,000 and 5,000 items save and read back in under 130 ms; 20,000 is refused with a clean 413.

## Done well (do not change)
- Every body-reading route funnels through `readJsonObject`, so malformed or wrong-shaped JSON is a 400 everywhere I fired it.
- The top-level `fetch` and `scheduled` handlers catch everything; failures return JSON errors instead of crashing the isolate.
- Server caches are bounded and pruned; poster/RPDB/chart caches have explicit caps.
- Like counting is done in SQL, so concurrent likes do not lose votes.
- List-order merging and explicit-slug saves stop the old "duplicate lists" loop.

## Not audited and why
- Real-KV eventual consistency and real D1 latency: the harness KV is strongly consistent, so cross-region staleness races could not be reproduced.
- Real provider payload quirks (TMDB, Trakt, MDBList, Simkl): outbound fetches are stubbed; only synthetic `null`, array, HTML, 500 and throw answers were tried (the `null` and `array` runs were stopped before they finished all routes; the `html`, `500` and `throw` modes were not run).
- Browser-side listeners and DOM leaks beyond the timers listed above; the 13k-line channel builder was not read for leaks (section 07 covers the UI).
- Admin routes beyond the generic fuzz; the Nuvio/Stremio/Wako app behaviour itself.
