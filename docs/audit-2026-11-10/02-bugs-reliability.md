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

Updated 2026-11-10. Status values: `open`, `fixed (awaiting verification)`, `verified`, `failed verification`. To verify a row, run its check and change the status.

| Finding | Status | Commit | How to verify |
|---|---|---|---|
| BUG-01 | fixed (awaiting verification) | a0b0ea7 | node --test tests/sync-config-bad-entries.test.mjs |
| BUG-02 | open |  |  |
| BUG-03 | open |  |  |
| BUG-04 | open |  |  |
| BUG-05 | open |  |  |

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

### BUG-04 `/api/tmdb-my-lists` returns 500 when `tmdbKey` is not a string
- Severity: Info
- Status: Proven
- File:line: `src/api/76_external-list-routes.js:1301` and `:1310`
- What is wrong: `manualKey = body.tmdbKey` is taken without a type check, then `apiKey.startsWith("ey")` throws for an object, number or `true`.
- Impact: a hand-made request gets `500 apiKey.startsWith is not a function` instead of a 400. The real page always sends a string.
- Proof: `node $S/fuzz.mjs /api/tmdb-my-lists` prints `!! POST /api/tmdb-my-lists [all:obj] -> 500 {"ok":false,"error":"apiKey.startsWith is not a function"}` (also logged in `$S/fuzz-full.log`). The same route also 500s on a lone surrogate in `sessionId`/`accountId` ("Failed to load TMDB lists: URI malformed").
- Recommended fix and effort: S. `String(body.tmdbKey)` or reject non-strings.

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
