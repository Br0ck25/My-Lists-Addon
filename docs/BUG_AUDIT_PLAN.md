# Bug, logic, error-handling, race, leak, crash, regression and edge-case audit, with a fix plan (handoff to Sonnet 5.5)

Audited 2026-11-02 in two passes, read-only. Nothing in `src/` was changed. The second pass closed the gaps the first one listed (see "Second pass" near the end) and found BUG-09.
Baseline: `bash verify.sh -q` passes every build, syntax and scope step. Tests: 3,119 run, 3,113 pass, 1 fail, 5 todo. The one failure is the known cold-catalog p95 timing budget (`tests/load-performance.test.mjs`) on a shared VM. Do not loosen it.

**How this audit was done (so you know what it does and does not cover).** The code is 123k lines, so it was not read line by line. I used:
1. A fuzz script that sent edge-case bodies (`null`, `[]`, `"x"`, `5`, `{}`, wrong-typed fields, invalid JSON) to every non-admin route in `tests/route-access.json`, signed in and signed out, and to every admin route with a real admin session. Network was stubbed off. It listed every 5xx.
2. Targeted greps for each audit area (module-level caches, timers, listeners, floating promises, unguarded parsing, fetches without timeouts, read-modify-write on KV).
3. Reading the code behind each hit.

Areas that passed this pass are listed at the end. Absence of a finding there is not proof of absence.

Already covered by earlier audits and **not re-opened here**: `docs/BACKEND_AUDIT.md` (BA-001 to BA-012, including the Ko-fi total race and the bare `catch {}` list) and `docs/CODE_QUALITY_AUDIT.md`.

## Rules for the implementer

- Follow `CLAUDE.md`. Edit `src/**/NN_*.js`, never `worker_entry_combined.js`, then `python build.py`. No refactors, no renames, one root cause per commit.
- For every bug: write the failing test first (rule 10), then fix. A test must fail if the fix is reverted.
- After each item: `bash verify.sh -q --fast` plus the one test file. Before pushing: `bash verify.sh -q`. Run `python tools/gen_map.py` if functions were added or moved.
- Add a `docs/RELEASES.md` entry at the end.
- Finding IDs are `BUG-nn`. Fix in the order given in "Fix order".

---

## Findings

### BUG-01 (High, crash / error handling): a JSON `null` body makes about 60 routes answer 500
**Evidence (reproduced).** `POST` with body `null` and `Content-Type: application/json` returns 500 with text such as `Cannot read properties of null (reading 'code')`. `null` is valid JSON, so `await request.json()` succeeds and returns `null`, and the next line reads `body.something`. The existing `try/catch` around `request.json()` only catches invalid JSON.

Public/account routes that 500: `/api/channel-lineup`, `/api/channel/added`, `/api/channel/like`, `/api/channel/mine`, `/api/channel/share`, `/api/channel/unpublish`, `/api/creator/create`, `/api/creator/account/reset`, `/api/creator/delete-account`, `/api/creator/forgot-username`, `/api/creator/lists`, `/api/creator/lists/delete`, `/api/creator/lists/items`, `/api/creator/lists/reorder`, `/api/creator/lists/save`, `/api/creator/recovery-answer`, `/api/creator/reset-key`, `/api/creator/restore`, `/api/creator/scrobble-seen-users`, `/api/creator/scrobble-token`, `/api/creator/sync/{like,load,meta,save,save-channels,save-presets,save-tracking,share-tracking}`, `/api/creator/track-status`, `/api/details`, `/api/details/batch`, `/api/external-list/{create,delete,item-add,item-mutate,item-remove}`, `/api/external-sync/history`, `/api/feedback`, `/api/imdb-ids`, `/api/list-live/save`, `/api/lists/like`, `/api/lists/like-external`, `/api/mdblist-history-raw`, `/api/preview`, `/api/recommendations`, `/api/save`, `/api/session`, `/api/track-event`, `/api/trakt-history-raw`, `/api/trakt-my-private-lists`, `/api/trakt/device/code`, `/api/trakt/device/token`.

Admin routes that 500: `/admin/api/channel-moderate`, `/admin/api/delete-creator-list`, `/admin/api/export-kv-to-r2`, `/admin/api/feedback/{delete,edit,reply,status}`, `/admin/api/reset-creator-key`, `/admin/api/support-emails/{compose,reply}` (the last two fail with `Cannot destructure property`).

**Impact.** A client error is reported as a server error, which pollutes error logs and alerting, and it means a hostile or broken client can generate 500s on demand. No data is corrupted.

**Root cause.** There are about 80 copies of `body = await request.json()` (grep `await request\.json\(\)`). Only 3 routes use the existing helper `readJsonBody` (`02_http-and-creator-utils.js:831`, which returns `null` for invalid JSON, so it has the same hole).

**Fix.**
1. Add one helper next to `readJsonBody`, for example `readJsonObject(request)`, that returns the parsed body only when it is a plain object (`typeof === "object"`, not `null`, not an array) and otherwise returns `null`. Check the global-name rule with `grep -rnw readJsonObject src`.
2. Replace each `request.json()` site so a non-object body takes the route's existing "Invalid JSON body." 400 path (`jsonInvalidBody()` exists). Do it one file at a time, in this order: `67_`, `68_`, `69_`, `75_`, `76_`, `77_`, `78_`, `79_`, `74_`, `73_`, `65_`, `66_`, `59_`, `49_`, `51_`, `44_`. One commit per file.
3. Do not change routes where an empty or array body is deliberately allowed. Where a site is `(await request.json()) || {}` (for example `65_` line 901, `44_` lines 413 and 426) the `null` case is already handled; leave it.
4. Write one new test `tests/null-body.test.mjs` that loops over every POST route in `tests/route-access.json` (skip `:param` routes and routes that need unconfigured secrets, which correctly answer 503), sends `null`, `[]`, `"x"` and `5`, and asserts the status is below 500. The fuzz script in the scratchpad is the model. This test must fail on today's code.

**Regression risk.** Medium, because it touches many routes. Tests that post `{}` or an array on purpose must keep passing. Run the whole suite after each file, not only at the end.

---

### BUG-09 (High, crash): one `null` channel entry breaks the whole web page, and sync spreads it to every device
**Evidence (reproduced in a real browser).** Playwright loaded `/` with a single saved key changed at a time (all 90 `myListAddon:*` keys, five bad shapes each). Two keys crash the page at startup:
- `myListAddon:localMergedChannels` = `{"a":null}` (or `[null]`) → `Cannot read properties of null (reading 'updatedAt')`, then `(reading 'mergedId')`
- `myListAddon:localChannels` = `{"a":null}` (or `[null]`) → `Cannot read properties of null (reading 'name')`

Both throw inside `renderChannelMergeList` (`src/client/20_client-channel-builder.js:13253`), which runs from a top-level call while the page script loads. An exception there stops the **rest of the page script from running**, so every tab is broken, not just Channels. Every other key and shape (invalid JSON, `"str"`, `0`, `[]`, `{}`, objects missing fields) loaded with no page error.

**Why it is High, not an edge case.** `/api/creator/sync/save-channels` (`src/api/69_creator-api-sync-routes.js:117-121`) stores `body.channels` and `body.mergedChannels` as given. It only checks that each is an object, and an array passes that check too. So a single bad entry written by any device (an old version, a crash mid-edit, a bug elsewhere) is saved to the account and loaded by every signed-in device, which then cannot use the site at all. Clearing site data does not fix it, because the next sync brings the entry back.

**Root cause.** `loadLocalChannels` (line 500) and `loadLocalMergedChannels` (line 12876) check that the whole map is an object, but never check its values. Callers then read `entry.name`, `entry.updatedAt` and `entry.mergedId` directly.

**Fix (two parts, two commits, test first for each).**
1. Client: in `loadLocalChannels` and `loadLocalMergedChannels`, return only the entries whose value is a non-null, non-array object. Do it once in these two loaders, not at each of the ~20 `renderChannelMergeList` callers. If an array is stored, treat it as `{}`. Test: the client harness (`tests/client-harness.mjs`; see `tests/channel-combine.client.test.mjs` for a model) sets each key to `{"a":null,"b":{...valid...}}`, calls `renderChannelMergeList()`, and asserts no throw and that the valid entry still renders.
2. Server: in `creatorApiSyncSaveChannels`, drop entries that are not plain objects, and treat an array as `{}`, before writing the blob. Test: save `{channels:{a:null,b:{name:"B"}}}` with `sync/save-channels`, load it with `sync/load`, and assert only `b` comes back.
3. Do not try to repair blobs that are already stored. Part 1 makes them harmless when they are read.

**Regression risk.** Low. Valid entries are unchanged. Check that `ensureAllChannelsSyncedFromRows` still adds channels that rows refer to, by running `tests/channel-*.test.mjs` and `tests/client*.test.mjs`.

---

### BUG-02 (Medium, error handling / logic): `/api/bulk-resolve` loses the whole batch if one title is bad or one TMDB call fails
**Evidence (reproduced).** With a stubbed TMDB: `items: [{title: 5}, {title: "Ok"}]` returns 500 "Could not resolve those titles."; so does `[{title:"Boom"}, {title:"Ok"}]` where the first fetch throws, and `[null, {title:"Ok"}]`. File: `src/api/80_shell-admin-entry-and-bulk-resolve-routes.js` around lines 296 to 340.

**Root cause.** Each batch of 10 runs under `Promise.all`, and the per-item function has no try/catch. `(item.title || "").trim()` throws on a number, `item.title` on `null` throws, and a rejected `fetch` rejects the whole `Promise.all`. Up to 200 imported titles are lost, and the user sees only a generic error. Separately, `tmdbCallCount` is incremented before the fetch, so a failed call is still billed against the per-minute budget (acceptable; keep it).

**Fix.**
1. Wrap the body of the per-item `async` function in `try { ... } catch { return null; }`.
2. Coerce the title with `String(item && item.title || "").trim()` and skip a non-object item.
3. Test (fails first): the three inputs above return 200, and `resolved` contains the good item.
4. **Series lookup (owner said yes, 2026-11-02).** Today a show with no IMDb id in an imported file (Trakt, Simkl, IMDb CSV and similar; `src/client/18_client-copy-and-trakt-export.js` around lines 1525 and 1603) is searched as a *movie*. Usually it is not found, but when a movie shares the title and year, the show is given that movie's IMDb id and the wrong poster. Fix, as its own commit after steps 1 to 3:
   - Client (`bulkResolveInChunks` callers): send each item's `type` with its title and year, and match results back by `title|year|type`, not `title|year`.
   - Server: when `item.type === "series"`, use TMDB `/search/tv` with `first_air_date_year`, then `/tv/{id}/external_ids`, and return `name`/`first_air_date` as the title and year. Return the `type` so the client can match it. Movies stay exactly as they are, and an item with no type is still treated as a movie, so older clients keep working.
   - TMDB call counting and the per-minute item budget are unchanged: a series costs the same two calls as a movie.
   - Tests (fail first): a series item resolves through the TV endpoints; a series with the same title and year as a movie gets the show's id, not the movie's; a movie item still uses `/search/movie`.

---

### BUG-03 (Low, edge case): `?limit=abc` on the admin support-thread list gives 500 "datatype mismatch"
**Evidence (reproduced).** `GET /admin/api/support-emails/threads?limit=abc` → 500. File: `src/admin/59_support-emails.js` lines 761 and 762. `parseInt("abc")` is `NaN`, `Math.min(100, Math.max(1, NaN))` is `NaN`, and D1 rejects a `NaN` bind. `?offset=abc` fails the same way. The same hazard exists wherever a `parseInt` result is passed to `Math.min/max` with no `|| default`. The grep found no other unguarded site (`31_lists-api.js:296` already has `|| LISTS_API_PAGE_DEFAULT`).

**Fix.** Append `|| 50` to the limit and `|| 0` to the offset, matching the pattern at `31_lists-api.js:296`. Test with `limit=abc&offset=abc` expecting 200.

---

### BUG-04 (Medium, race / lost update): shared KV singleton lists are read, changed and written back with no guard
**Evidence.** Several keys hold one JSON blob that many requests update by read-modify-write on `env.CONFIGS`:
- `bp:sharedids:v1` (`rememberSharedPosterIds`, `07_` about line 5170)
- `BETTER_POSTER_VARIANTS_KEY` (`noteBetterPosterVariant`, `05_` about line 1360)
- `BETTER_POSTER_RETRY_KEY` (`05_` about line 1227 adds, `07_` about line 5220 removes; the removal already re-reads before writing, which narrows but does not close the window)
- the per-account tracking record in the Airing Next sweep (`07_` about line 4830; the comment says it re-reads first, and it does, but there is still a read-to-put gap of one KV round trip).

KV has no compare-and-set, so two isolates can each read the same list and the second write silently drops the first one's additions. In `noteBetterPosterVariant` the in-memory throttle (`_betterPosterVariantNoted.set`) is also set *before* the KV write, so if the write fails the variant is not retried for 6 hours.

**Impact.** Low to medium and self-healing: these are caches and hints (poster ids to retry, variants seen), and the next request re-adds the entry. A lost tracking-record field is the worst case and is why that sweep re-reads. No financial or account data is involved (that is BA-001).

**Fix (smallest safe).** Do not add locking. For the two caches: in `noteBetterPosterVariant`, move the `_betterPosterVariantNoted.set(key, now)` to after a successful `put`, so a failed write retries sooner. For the rest, add a one-line comment at each site stating the lost update is accepted and why. **Owner decision (2026-11-02): stay on KV, do not move these to D1.** A lost entry only means a poster is fetched again later; moving them would add D1 writes on a busy path and a migration, for no visible gain to users.

---

### BUG-05 (Low, race / error handling): fire-and-forget D1 writes are not handed to `waitUntil`
**Evidence.** `src/core/02_http-and-creator-utils.js:1610` (`UPDATE sessions SET last_seen_at`) and `src/admin/03_admin.js:1933` (`UPDATE admin_sessions SET last_seen_at`) start a D1 write with `.run().catch(() => {})` and no `ctx.waitUntil`. When the response is returned first, the runtime can cancel the write. The same kind of gap was already found and fixed for TMDB caching in BA-006.

**Impact.** Very low: `last_seen_at` is a convenience (the code comments say so) and the next request retries. But when the write is dropped, the throttle test (`now - last_seen_at > 5 minutes`) stays true, so every request in that session retries the write, which costs D1 writes.

**Fix.** Pass `ctx` into the two lookup functions if it is not already available, wrap the write in `ctx.waitUntil(...)`, and keep the `.catch`. If `ctx` is not reachable without changing many signatures, leave it and record that decision in the commit message (do not widen signatures for this).

---

### BUG-06 (Low, race / leak): the Trakt device-code poll can overlap itself
**Evidence.** `src/client/17_client-my-lists-and-trakt-oauth.js` about lines 972 to 1030. The `setInterval` callback is `async` and awaits a `fetch`. If one poll takes longer than the interval (minimum 4 s) the next tick starts another request for the same device code. The timer is cleared on success, on expiry and in `closeTraktDeviceModal`, so there is no leak; the overlap just doubles the requests and can make Trakt answer "slow down".

**Fix.** Add a local `let pollBusy = false;` guard at the top of the callback (`if (pollBusy) return; pollBusy = true; try { ... } finally { pollBusy = false; }`). The client test harness in `tests/client-harness.mjs` can drive it; add a test with a poll that outlasts the interval and assert only one request is in flight. Do not touch the Stremio poll (`mediaAppUiPoll`, about line 2341): it has the same shape but a 3 s interval with a 200-tick cap and an `await` per tick. Apply the same guard there only if you can make the same test fail first.

---

### BUG-07 (Low, memory): three per-isolate maps have no size cap
**Evidence.** Checked every module-level `Map`/`Set` in the Worker. Almost all evict (`.delete`, `.clear`, or a size cap). These do not:
- `RPDB_BACKOFF` and `RPDB_USAGE` (`05_catalog-core.js` lines 1446 and 1447), keyed by a hash of each user's RPDB key. They grow by one entry per distinct key for the life of the isolate.
- `_betterPosterVariantNoted` (line 1354), keyed by poster variant, a small finite set.
- Browser: `_betterPosterReadyUrls` (`src/client/19_client-search-and-likes.js:494`) gains one URL string per poster shown and is never cleared during the page's lifetime. It stays small (strings only); leave it unless a long-session memory complaint appears.

**Impact.** Very low: a Worker isolate is recycled often and the key sets are small. This is a hygiene item, not a leak that will ever matter at the current scale.

**Fix.** Copy the existing pattern `if (map.size >= MAX) map.clear()` used in `42_chart-snapshots.js:184` (cap about 1,000). Only do this if it is a three-line change; otherwise skip it and note it.

---

### BUG-08 (Info, resilience): most outbound `fetch` calls have no timeout
**Evidence.** About 232 `fetch(` calls in the Worker; 15 use `AbortSignal.timeout` or `AbortController`. A helper already exists: `fetchWithTimeout(url, options, ms)` at `02_http-and-creator-utils.js:3066`. Calls without a timeout can hang until the platform wall-clock limit when a provider stalls, which holds a catalog request open.

**Fix.** Do not mass-convert 200 call sites (rule 2, and the replay-risk is large). Instead: (a) list the call sites on the **catalog hot path** (`stremioCatalogRowFetch` and the source fetchers in `06_`/`07_`) that are not already behind the provider breaker (`41_provider-breaker.js`) or `fetchWithTimeout`; (b) switch only those to `fetchWithTimeout` with the helper's default; (c) confirm with `tests/provider-contracts.test.mjs` and `tests/providers.test.mjs`. If every hot-path call is already covered by the breaker, close this item with a note saying so.

---

## Checked and fine (no action)
- **Memory leaks, Worker:** every module-level cache other than BUG-07 evicts. `SESSION_CACHE` has a 10-second TTL and a 1,000-entry cap; `CONNECTION_*_CACHE` has a TTL and a cap of 500.
- **Memory leaks, browser:** global listeners are bound once (`_listDetailsScrollBound` guard and similar). The drag handlers remove their own listeners on pointer end. Only four `setInterval`s exist: Trakt poll (cleared), Stremio poll (cleared, capped), 2-minute Nuvio refresh and 60-second sync check (both page-lifetime by design, and guarded by visibility checks).
- **Floating promises:** no `forEach(async …)`; every `.map(async …)` sits inside a `Promise.all`; the only un-awaited D1 writes are the two in BUG-05.
- **Request-body parsing:** apart from the `null` case in BUG-01, invalid JSON, arrays, strings and numbers all get 4xx or a normal response. No route threw an uncaught exception.
- **Query-string edge cases:** `GET` with `limit=abc`, `days=-5`, `cursor=zz`, `q=%00`, `page=-1`, `username='` against every non-parameterised admin route produced no 5xx other than BUG-03.
- **Unconfigured features** (OAuth sign-in, Ko-fi webhook, jobs queue) answer 503 with a clear message, which is correct.
- **Rate-limit and session paths** read as sound (atomic spend-then-release in `reserveRateLimit`; 10-second revocation window documented as SESS-001).

### Second pass (same day): the gaps from the first pass, now checked
- **Path-parameter routes:** 35 route shapes (manifest, catalog with `skip`/`genre` extras, meta, stream, subtitles, `/i/<token>/…`, every `/lists/<source>/…`, `/channel(s)/…`, `/rpdb/…`, `/bp/…`, `/api/{installs,connections,imports,likes,lists,creator}/…`, `/u/…`, `/configure`, `/poster/…`), each with 15 bad segments (empty, `%00`, broken UTF-8, `..`, `%2F%2F`, a 3,000-character value, emoji, quotes, `null`, `-1`) and 5 methods, signed in and out. That was 5,250 requests: 200/302/401/404 only, **no 5xx**.
- **Query strings on every public/account route:** non-numeric, negative and huge `limit`/`page`/`skip`, `%00`, path traversal, repeated keys, a metadata-IP URL. 840 requests, **no 5xx**.
- **Queue consumer:** every one of the registered job types with 8 payload shapes (`null`, array, string, number, wrong-typed fields, unknown account, a real account), plus 5 malformed message bodies. All 125 were handled; none threw and none looped on retry.
- **Cron:** four cron schedules, run with every KV key overwritten by invalid JSON or `null`. No throw; the only log lines were the expected "network blocked" provider failures.
- **Email handler:** empty message, null fields, garbage MIME. No throw.
- **Browser:** each saved key alone, five bad shapes each (450 page loads), plus each app tab with all keys corrupted together. This found BUG-09 and nothing else.
- **Regression (CQ-20 refactor):** an AST scan of all 63 functions that take a destructured settings object, checked against every call site. No call passes a misspelled key, and every key a caller leaves out has a default or a `||` fallback in the function. The five `todo` tests are the known server/client parity differences and audit #12, not new failures.

## Not verified (be honest with the owner)
- Behaviour against the real Cloudflare runtime, real D1 limits and real provider outages; the harness uses stubs and real SQLite.
- Browser flows that need a click sequence (drag-and-drop, editing a list, OAuth pop-ups). The browser pass covered page load and tab switching only.
- Live Nuvio/Stremio device behaviour (already listed as outstanding in `docs/HANDOFF.md`).

## Fix order
1. BUG-09 (one bad synced entry breaks the site on every device; small fix).
2. BUG-01 (largest, user-visible in logs; ship file by file).
3. BUG-02 and BUG-03 (small, independent, each with a test).
4. BUG-06 (small client fix).
5. BUG-05 and BUG-04 (low value; do only if the change stays a few lines).
6. BUG-08 as an investigation first, BUG-07 only if trivial.

Owner decisions (2026-11-02): **yes**, the bulk import resolves series too (BUG-02 step 4). **No**, the shared poster lists stay on KV (BUG-04).
