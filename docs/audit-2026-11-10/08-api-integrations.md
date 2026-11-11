# 08 API and integrations
Health grade: B -- the Stremio/Nuvio/Wako contract, CORS, legacy install links, provider-failure handling and the breaker are solid and were proven to work; the defects found are one unguarded KV failure path, one wrong 403 rule in token refresh, Trakt paging, and unvalidated skip (no Critical or High)

## Scope covered
- Stremio/Nuvio/Wako contract: `/:config/manifest.json`, `/catalog/:type/:id[/extra].json`, `/meta/...`, `/subtitles/...`, `/i/<token>/...`, `/c/...`, bare `/manifest.json`, OPTIONS/HEAD/POST on them. Files: `src/api/70_stremio-routes.js`, `src/api/25_api-catalog-routes.js`, `src/catalog/05_catalog-core.js` (`buildManifest`), `src/core/02_http-and-creator-utils.js` (`fetch` guard, caches, CORS).
- Provider fetchers MDBList/Trakt/TMDB/Simkl (`src/catalog/06_*`, `07_*`), failure matrix with stubs: HTTP 500, 429, HTML-with-200, empty-with-200, error-object-with-200, null items, network throw, hang (10 s abort).
- Provider breaker `src/catalog/41_provider-breaker.js`.
- Legacy install URL formats (`resolveConfig`, `decodeConfig`).
- OAuth Trakt/MDBList/Simkl callbacks and token refresh (`src/api/75_*`, `src/api/28_connections.js`, `src/jobs/50_token-refresh.js`), client side pick-up (`src/client/17_client-my-lists-and-trakt-oauth.js`).
- Harness: `/tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s08/` (`lib.mjs` stubs `globalThis.fetch` with the real fixtures from `tests/fixtures/providers`, then calls `worker.fetch` through `tests/harness.mjs`). Dev server on 8880/8881 for the browser checks (stopped at the end).

## Fix progress

Updated 2026-11-10. Status values: `open`, `fixed (awaiting verification)`, `verified fixed`, `open (partially fixed, ...)`, `regression introduced (...)`. Rows marked in the Verified column were checked by an independent review on 2026-11-10; see each finding's **Verification.** note.

| Finding | Status | Commit | How to verify | Verified |
|---|---|---|---|---|
| API-01 | verified fixed | 5b60aa2 | node --test tests/public-routes-kv-outage.test.mjs tests/security-suite.test.mjs | 2026-11-10, independent review |
| API-02 | verified fixed | 10c3c33 | node --test tests/token-refresh.test.mjs | 2026-11-10, independent review |
| API-03 | open |  |  |  |
| API-04 | fixed (awaiting verification) | c5dbd27, efd3309, e082ce3, ab07bce | node --test tests/trakt-paging.test.mjs tests/providers.test.mjs |  |
| API-05 | verified fixed | 37cdb1a, 75a8244, 7b927c6 | node --test tests/catalog-skip-clamp.test.mjs tests/catalog-skip-limit.test.mjs tests/preview-chart-limit.test.mjs | 2026-11-10, independent review |
| API-06 | open |  |  |  |
| API-07 | open |  |  |  |

## Proven findings

### API-01 A failing KV read turns manifest and catalog answers into a bare 500 with no CORS header and an internal error message
- Severity: Medium
- Status: Proven
- File:line: `src/api/26_api-creator-and-admin-routes.js:114-139` (the one top-level `catch`), reached from `src/core/04_config-resolution.js:114` (`env.CONFIGS.get` is not guarded) via `installManifest` / `stremioCatalogRow` (`src/api/70_stremio-routes.js:99, 190`)
- What is wrong: The catalog route has careful "provider is down" handling (placeholder tile, last good copy, no-store). But if the *install lookup itself* throws (Cloudflare KV answering 5xx or a rate-limit error), nothing on the path catches it. The outer catch builds `json({ok:false,error:<message>}, 500)` with plain `json()`, which carries no `Access-Control-Allow-Origin`. The raw error text of the platform ("KV GET failed: 503 Service Unavailable") is sent to the app. The meta route is the only one of the four that catches it and answers 200 `{meta:null}`.
- Impact: During a short KV hiccup every Stremio/Nuvio/Wako request for the manifest or a row gets HTTP 500 instead of an empty row. Apps treat a 500 manifest as "addon failing" (worse than an empty shelf). In the browser app (web.stremio.com) the 500 shows as an opaque CORS error. The same 500 is not cached (no-store), so it recovers on the next request, which is why this is Medium, not High.
- Proof: `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s08/t7_kvdown.mjs` (install created normally, then `env.CONFIGS.get` made to throw):
```
/ID/manifest.json 500 cors=null cc=no-store {"ok":false,"error":"KV GET failed: 503 Service Unavailable"}
/ID/catalog/movie/m1.json 500 cors=null cc=no-store {"ok":false,"error":"KV GET failed: 503 Service Unavailable"}
/ID/meta/movie/tt0111161.json 200 cors=* cc=no-store {"meta":null,"error":"KV GET failed: 503 Service Unavailable"}
/ID/catalog/movie/search_movies/search=x.json 500 cors=null cc=no-store {"ok":false,"error":"KV GET failed: 503 Service Unavailable"}
```
  Contrast: a provider failure on the same route returns 200 with CORS (see t3 output below).
- Recommended fix: In the top-level catch (line 139) use `jsonPublic`-style CORS headers when `isPublicCorsPath(path)` is true, and for `/catalog/` and `/meta/` paths answer 200 `{metas:[]}` / `{meta:null}` with `no-store`; never echo the platform message. Effort S.

**Verification.** 2026-11-10, independent review: **verified fixed**. Read 5b60aa2. The new test fails against the parent commit (1 pass, 4 fail). Extra probes on HEAD with every KV read throwing: `/i/<token>/manifest.json` and `/i/<token>/catalog/...` answer 200 with CORS, `/<user>/catalog/movie/m1/skip=100.json` and a URL with a query string answer `{metas:[]}` with CORS, and subtitles answers `{subtitles:[]}`. No storage error text appears. The one test changed (`security-suite`, 500 to 503 on the manifest) is stricter, not looser, and is explained in the commit.

### API-02 A broken Trakt token refresh is treated as "the person must sign in again" when Trakt (or Cloudflare in front of it) answers 403
- Severity: Medium
- Status: Proven
- File:line: `src/api/28_connections.js:517` (Trakt) and `:566` (MDBList): `if (res.status === 400 || res.status === 401 || res.status === 403) rejected = true`; consumed by `src/jobs/50_token-refresh.js:58-70` (`markConnectionStatus(..., "reauth_required")`)
- What is wrong: The function's own comment says "a transient failure must not mark a connection broken". But 403 is treated as a definite refusal. Trakt sits behind Cloudflare, and the same codebase already knows that Trakt answers bursts with 429/**403** and a Cloudflare 1015 page (`src/api/75_provider-list-and-oauth-routes.js:635` retries on 403; `src/client/17_...:860` talks about "rate-limited by Cloudflare (1015)"). The daily `token.refresh` job refreshes up to 500 connections in one run, which is exactly the burst that triggers such a block.
- Impact: A person whose Trakt/MDBList token was perfectly healthy is flipped to `reauth_required`. Their personal rows (Watchlist, Continue Watching, Up Next) in Stremio/Nuvio are replaced by a single "Reconnect Trakt at mylistsaddon.com" tile until they open the website and sign in again. The refresh token was never consumed, so nothing had actually gone wrong.
- Proof: `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s08/t9_refresh.mjs 403cf` (real Worker + queue + D1; Trakt stub answers the refresh call with a Cloudflare 1015 HTML 403):
```
[Jobs] token.refresh: 0 renewed, 1 need signing in again, 0 left for tomorrow.
mode=403cf refreshCalls=2 {"status":"reauth_required","last_error":"The provider refused to renew this sign-in. Connect it again."}
```
  Control run `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s08/t9_refresh.mjs 503` leaves the connection `ok`, so the guard is only wrong for 403.
- Recommended fix: Treat only 400 (invalid_grant) and 401 as a refusal; treat 403 and 429 as "could not be asked" (return null, retry tomorrow). Optionally require a JSON body with `error=invalid_grant` before marking. Effort S.

**Verification.** 2026-11-10, independent review: **verified fixed**. Read 10c3c33. The new 403 and 429 cases fail against the parent commit. Other places that mark `reauth_required` are for Stremio/Nuvio (`kind === "invalid"`), not this Cloudflare 403 case. Gap: the same change for MDBList refresh has no test; the Trakt test covers only Trakt.

### API-03 Anyone can put their own wording into the app's Trakt/MDBList Trakt error dialog through a link; and a real exchange failure is always described as "rate-limited by Cloudflare"
- Severity: Low
- Status: Proven
- File:line: `src/client/17_client-my-lists-and-trakt-oauth.js:851-866` (`pickUpTraktTokenFromUrl`); the server side hands any text through: `src/api/75_provider-list-and-oauth-routes.js:593` (`failWith(url.searchParams.get("error"))`)
- What is wrong: The page reads `?trakt_error=<anything>&trakt_error_detail=<anything>` from the address bar and puts both into a modal titled "Trakt Connection" ("Could not connect to Trakt (<error>: <detail>)"). The text is HTML-escaped (no script injection), but the wording is fully attacker-chosen. Separately, `err === 'exchange_failed'` is hard-wired to the message "rate-limited by Cloudflare (1015)" and to opening the device-code login, even when the true cause is e.g. `invalid_grant` or a wrong client secret; the real detail is thrown away.
- Impact: A link such as `https://<site>/?trakt_error=Security%20alert&trakt_error_detail=Call%20support%20on%200800...` shows that sentence inside the site's own trusted dialog (phishing/social-engineering text, no links or markup possible). For genuine failures the owner/user is misled about the cause.
- Proof: `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s08/t8_pw.cjs` against the dev server (Chromium, 390 px wide). Screenshot `/tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s08/trakt_err_3.png` shows the dialog "Trakt Connection - Could not connect to Trakt (Security alert: Call support on 0800 123 456 to restore your account)." Screenshot `/tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s08/trakt_err_2.png` shows that `trakt_error=exchange_failed&trakt_error_detail=invalid_grant...` produces the unrelated "Sign in to connect your Trakt account" dialog (device-code fallback), with the detail discarded.
- Recommended fix: Show only messages from a fixed list; map unknown codes to "Could not connect to Trakt"; log `detail` instead of displaying it; limit the 1015 wording to detail that actually contains 429/1015. Effort S.

### API-04 Trakt rows page by "skip divided by 100", but an app sends the number of items it already holds, so a page that shrank is served again
- Severity: Medium
- Status: Proven (server behaviour); what Stremio/Nuvio/Wako send as the next skip is the assumption (the source comment itself assumes multiples of 100)
- File:line: `src/catalog/06_source-fetchers-mdblist-trakt.js:535` (Trakt lists), `:614` (watchlist), `:757` (history), `src/catalog/07_source-fetchers-tmdb-simkl.js:260` (Trakt charts): `const page = Math.floor(skip / PAGE_SIZE) + 1;`. The items are then de-duplicated and filtered in `mapTraktItems` (`:476-501`: no ids, or the same imdb/tmdb id twice, is dropped), so a page of 100 Trakt rows can become fewer than 100 metas.
- What is wrong: MDBList (local slice) and TMDB (offset arithmetic) honour any `skip`. Trakt does not: any skip below 100 returns Trakt page 1 again. A series row uses `shows,seasons,episodes`, watch history uses episodes, so several Trakt rows often belong to one show and collapse to one meta.
- Impact: A Trakt list, watchlist or history row whose first page collapses to e.g. 80 titles is followed by a request with skip=80 (the number of items the app now holds), which returns the same 80 titles again; the app shows duplicates / never reaches the titles on Trakt page 2. Shows with several episodes in one list are the common trigger.
- Proof: `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s08/t17_trakt_skip.mjs` (Trakt stub returns 100 episode rows per page, 80 distinct shows):
```
skip=0 returned 80 items
skip=80 returned 80 items; 80 of them already delivered by skip=0; trakt pages requested: [1]
```
- Recommended fix: Fetch by `Math.floor(skip / PAGE_SIZE)` but then drop the first `skip % PAGE_SIZE` items of what the mapping produced and, if the result is short, top up from the next Trakt page (as `fetchTmdbPagedResults` does), or record the raw offset in the `skip` the manifest hands out (only possible via `cacheMaxAge`-style ids, so the top-up is simpler). Effort M.

**Verification.** 2026-11-10, independent review: **regression introduced**. Read c5dbd27. The short case the finding describes is fixed: the new test fails against the parent, and with a 3-page list `skip=<titles held>` brings new titles. **What is now wrong:** `traktWindowedPage` reads at most 5 Trakt pages from page 1, and returns `[]` when those pages cannot reach `skip`, so the app thinks the row has ended. Probe: a Trakt list of 10 pages where each page of 100 rows maps to 80 titles (800 titles), scrolled the way the finding says apps do (skip = titles held). On HEAD: skip 0, 100, 200, 300 bring 100 each, skip 400 brings 0, so 400 of 800 titles are reachable. The same walk on the parent commit reached all 800 distinct titles, with 240 repeats. Watch history (many episodes of one show) is the case most likely to shrink and be long. A page whose titles were all seen already also stops the walk (`titles.length === before`), which a binge in history can cause. Also unrelated to API-04 in this commit: `20_client-shelf-source-check.js` switched `fetch` to `creatorApiFetch` (PROD-02 code). Fix: when the window cannot reach `skip` within the page cap, continue from the page arithmetic instead of returning empty, or raise the cap with a total-items stop, and add a test with more than 5 shrinking pages.

**Verification (second independent review, 2026-11-10): partially fixed.** Read efd3309. The first review's regression is fixed: the walk reads up to 30 pages, a page with nothing new no longer stops it, and a skip it cannot reach falls back to page arithmetic instead of an empty page. The two new tests fail against the parent (2 of 4). Probes on HEAD (Trakt list stub, app scrolling with skip = titles held): 10 pages x 80 titles: all 800, none twice, at most 2 Trakt calls per request; 40 x 80: all 3,200 reached (4,000 delivered, so 800 repeats); 3 x 100: 300, none twice. **What is still wrong:** past the 30-page window the original bug comes back, and it is severe when pages shrink a lot. 35 pages x 20 titles (watch history with about five episodes per show, 3,500 plays): after the 600 titles the window holds, each request falls back to `floor(skip/100)`, which serves pages the app already has while `skip` grows by only 20 a request. After 120 requests the app had been sent 2,880 titles, 600 distinct, and had not reached titles 601-700. The new 40-page test does not catch this because it counts delivered titles including repeats (`all.length >= 3000`). Fix: when the window is exhausted, continue from the last page read (for example remember the raw page and offset reached for a given title count), or keep the arithmetic fallback but make sure each fallback page moves forward; and assert distinct titles in the long test. Status set back to `open`.

**Verification (third independent review, 2026-11-11): partially fixed.** Read e082ce3. The second review's case is fixed and the new tests now count distinct titles; both fail against the parent (2 of 6). Probe on HEAD and on the parent with the same Trakt list stub, app scrolling with skip = titles held (distinct reached / delivered): 35 x 20: HEAD 700/700, parent 700/3,500; 120 x 30: HEAD 3,560/3,600 (40 missed at the seam), parent 3,000/9,930; 150 x 20: HEAD 3,000/3,000, parent 2,000/9,920; 60 pages x 90 then 90 x 10: HEAD 6,300/8,700, parent 5,800/9,910. So for any list up to 100 Trakt pages (10,000 rows) the walk is exact, and it is better than the parent in every shape tried. **What is still wrong:** (1) Past 100 pages the next page is estimated from the titles per page seen so far, and when later pages shrink less than the first 100 the estimate jumps ahead and the row ends early, the "never an empty page" the comment promises. 110 pages x 10 titles then 40 x 100 (a binge-heavy recent history, then varied older plays; 5,100 titles): after 18 requests the app got an empty page with 1,580 distinct titles, 3,520 never reached (the parent reached 1,000 but never ended the row). (2) Cost: one request now reads up to 100 Trakt pages from page 1 when they are not in the isolate's memory. A cold `skip=9000` on a 120-page list made 91 Trakt calls (parent: 1; at `skip=2900` both made 30). Watchlist and history are fetched with `cacheTtl: 0` (src/catalog/06_source-fetchers-mdblist-trakt.js:635, :778), so on a new isolate a deep scroll spends that many calls of the person's own Trakt budget, and the 120-a-minute catalog-skip limit (API-05) allows up to 100 times that per address. Both cases need more than 10,000 rows or a deep cold request, so this is narrower than before; the owner may choose `accepted risk`. Fix if kept open: remember, per list, the raw Trakt page and offset reached for a given title count (memory or KV) so a request continues from there and reads one or two pages; that removes both the estimate and the walk from page 1. Status set back to `open`.

### API-05 `skip` is not validated, there is no rate limit on catalog rows, and every different `skip` is its own cache entry
- Severity: Low (cost / abuse amplifier on the owner's shared TMDB and Trakt keys and on KV writes; nobody's data is exposed)
- Status: Proven
- File:line: `src/api/70_stremio-routes.js:200` (`const skip = parseInt(extra.skip, 10) || 0;`, accepts negatives and `1e20`-sized numbers), cache keys built from it in each fetcher (e.g. `src/catalog/07_source-fetchers-tmdb-simkl.js:885-886`). The search catalog has `searchRateLimitResponse`; the row catalog does not.
- What is wrong: Anyone (an install id is not even needed: `/catalog/movie/tmdb-chart-popular/skip=N.json` works with no config) can request an unlimited number of different `skip` values. Each one misses every cache tier (isolate memory, KV, edge), calls the provider and writes a KV entry that lives 24 hours. Negative or absurd values are forwarded to the provider as `page=-4` or `page=5000000000000000000`.
- Impact: 200 requests from one IP produced 1,483 upstream TMDB calls and 203 KV writes with fixture-sized pages (a real 100-title page also needs up to 100 detail lookups). The owner's shared TMDB/Trakt key can be exhausted, which makes every chart show "temporarily unavailable" for everyone, and KV write/storage cost grows. (Cloudflare-side rate-limit rules, if any, are outside the code and were not visible to me.)
- Proof: `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s08/t14_amp.mjs`:
```
200 unique-skip requests from ONE ip: statuses={"200":200} upstream TMDB calls=1483 (~7.4 per request) KV puts=203, sample key=cache:tmdb:chart:popular:movie:100000:US:0
no-config path {"200":50} tmdb calls 376
```
  and `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s08/t13_extras.mjs` shows the forwarded values: `themoviedb.org/3/movie/popular?api_key=X&page=-4`, `trakt.tv/users/a/lists/b/items/movies?limit=100&page=1000000000000000000`.
- Recommended fix: Clamp `skip` to an integer between 0 and a cap (e.g. 10,000 = TMDB's 500-page limit), round it down to a multiple of the page size for cache-key purposes, and apply the same per-IP limiter the search catalog uses to unconfigured and non-cached row requests. Effort S.

**Verification.** 2026-11-10, independent review: **verified fixed**. Read 37cdb1a, 75a8244 and the skip part of 7b927c6. The clamp test fails against its parent (3 pass, 3 fail), and so does the skip-limit test (0 pass, 2 fail). `skip` is now 0 to 9,900 in catalog rows and in `/api/preview`. Pages after the first share 120 a minute per address and are answered 429 with CORS, no-store and Retry-After. The only early return before the limiter that skips it is the channel row, which makes no provider call. Not done: rounding `skip` to the page size for the cache key (the per-address limit now bounds that). The new uncapped preview path from 7b927c6 is recorded under PERF-03.

### API-06 Simkl charts drop titles that Trakt and MDBList would keep, never send a year, and force every anime title to the row's type
- Severity: Low
- Status: Proven
- File:line: `src/catalog/07_source-fetchers-tmdb-simkl.js:19-33` (`mapSimklItems`)
- What is wrong: (1) `filter(it => it.ids && it.ids.imdb)` removes any title that has only a TMDB id; Trakt and MDBList mapping keep the same title as `tmdb:<id>`, and the manifest already declares the `tmdb:` prefix. (2) `release_date` is ignored, so the tile has no year (`releaseInfo`) while the other three providers do. (3) `type` is copied from the row, so on the "anime" chart (which Simkl mixes movies, series and OVAs in) an anime film is announced as `series` in a series row.
- Impact: Simkl rows (especially anime) are shorter than Simkl's own list, show no year, and some tiles open a detail page of the wrong type (a movie asked for as a series).
- Proof: `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s08/t12_simkl_map.mjs` (same "TMDB only film" served by Simkl, Trakt and MDBList stubs):
```
sk  [{"id":"tt1111111",...,"name":"Has IMDb"},{"id":"tt3333333",...,"name":"Anime movie"}]        <- "TMDB only film" missing, no year
ska [{"id":"tt1111111","type":"series",...},{"id":"tt3333333","type":"series","name":"Anime movie"}]  <- anime movie typed series
tk  [{"id":"tmdb:22222","type":"movie","name":"TMDB only film","year":"2025"}]
md  [{"id":"tmdb:22222","type":"movie","name":"TMDB only film","year":"2025"}]
```
  (the anime item type is Simkl's documented `anime_type` field; my stub only shows that the row type overrides it.)
- Recommended fix: Keep `tmdb:<id>` when there is no imdb id, add `releaseInfo` from `release_date` (the stub dates are `MM/DD/YYYY` or ISO), and for the anime chart derive the type from `anime_type`. Effort S.

### API-07 When Trakt rate-limits a row, the app waits about 7 seconds and the addon sends three calls for it
- Severity: Low
- Status: Proven
- File:line: `src/core/02_http-and-creator-utils.js:3022-3032` (`fetchTraktWithRetry`)
- What is wrong: On a 429 the request sleeps 1-3.5 s and retries twice inside the live request. The `Retry-After: 30` Trakt sent is capped to 3 s, so the retries hit the limit again. A `Retry-After` given as a date (allowed by HTTP) parses to `NaN`, the delay becomes 0 and all three calls go out within milliseconds. The breaker deliberately ignores Trakt 429s (`PROVIDER_PER_KEY_LIMIT`), so nothing slows the next request.
- Impact: While Trakt is limiting, every Trakt row request holds the app for ~7 s and triples the load on the limited key, then ends in the "temporarily unavailable" tile.
- Proof: `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s08/t11_trakt429.mjs`:
```
Retry-After="30" -> trakt attempts=3 elapsed=6778ms status=200 cc=no-store
Retry-After="Wed, 21 Oct 2026 07:28:00 GMT" -> trakt attempts=3 elapsed=5ms status=200 cc=no-store
```
- Recommended fix: Do not sleep inside a catalog request: on 429 serve the stale copy or the placeholder immediately and record a short "cool-down until" in memory/KV keyed on the Trakt key; parse date-form `Retry-After`. Effort S-M.

## Unproven suspicions (not counted)
- **Huge provider payloads.** No response-size cap exists on provider JSON (`res.json()` on whole MDBList/Simkl files, e.g. `src/catalog/07_source-fetchers-tmdb-simkl.js:79`). `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s08/t15_huge.mjs 50000` (a 28 MB list) answered correctly in 0.3 s and cached only the 100-item page (KV puts ~0 MB), but Node's memory limit is not the Worker's 128 MB, so I could not show an out-of-memory failure. A real MDBList list is far smaller than my 50,000-item test, so likely fine.
- **Stored or old base64 installs with a catalog type other than movie/series.** `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s08/t5_legacy.mjs` shows a base64 link or a stored record with `type:"show"` or `"tv"` produces a manifest catalog of type `show`/`tv` (not in the manifest's `types`). `/api/save` now refuses such rows (`src/api/25_api-catalog-routes.js:47`), and I did not find evidence that links with these types ever existed, so this only matters for hand-made links.
- **Stremio's next `skip` value (API-04).** Proven on the server side; I could not run a real Stremio/Nuvio/Wako client to confirm that it sends the held-item count rather than a multiple of 100.
- **Placeholder tile id `tt0000000`** (`src/api/70_stremio-routes.js:438`): opening it sends a meta request for a non-existent title; the meta route answers with a "not found" shaped answer from TMDB/Cinemeta calls. Not shown to be harmful.
- **MDBList and Simkl OAuth callbacks** use the same "reflect `error` text" pattern as Trakt (`src/api/75_provider-list-and-oauth-routes.js:874, 1022`); I only ran the browser proof for Trakt.

## Checked and rejected
- **CORS on addon routes.** `Access-Control-Allow-Origin: *` is present on manifest, catalog, meta, subtitles and the v2 `/i/<token>/...` routes for 200, 404 (unknown install), empty and placeholder answers; OPTIONS on all of them returns 200 with `GET, OPTIONS` (`node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s08/t2_catalog.mjs`, `t6_v2.mjs`). Only the uncaught-exception path misses it (API-01), plus plain "Not found" 404 for malformed paths (`.JSON` upper case, trailing slash), which no app requests.
- **Manifest fields.** `id, version, name, description, logo, resources (catalog + meta with idPrefixes tt/tmdb:/channel_), types, idPrefixes, catalogs[{type,id,name,extra[skip]}], behaviorHints` are all present and well-formed (`node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s08/t1_contract.mjs`). Search rows declare `extra: search required`.
- **Catalog shape.** Metas carry `id, type, name, poster` (extra internal fields like `imdbId, tmdbId, vote_average` are harmless). skip in path form works (`skip=2` returned 3 of 5 items); the query form `?skip=2` is ignored, but Stremio/Nuvio/Wako only use the path form. `genre` is not advertised, so ignoring it is correct.
- **Provider down / hang / HTML / 500 / 429 / network error.** Every one returns HTTP 200 with CORS and `Cache-Control: no-store` and either the last good copy or the "temporarily unavailable" tile (`node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s08/t3_failures.mjs <mode>`, run each mode in its own process). A hang is cut at 10 s. The guards are `fetch()` shadowing in `src/core/02_http-and-creator-utils.js:2946` (default 30 s timeout on every call) and `withTimeout` in `fetchWithPerUserCacheUncoalesced` (10 s).
- **Empty or error JSON with HTTP 200 from a chart provider.** Suspected to be cached as an empty row for 30 min. Rejected for charts that have a previous copy: `refuseEmptyOverwrite` keeps the last non-empty copy. A first-ever empty answer, and ordinary user lists (which may legitimately be empty), are cached 1800 s; that is a design choice, not a bug.
- **Provider breaker.** Behind `FF_PROVIDER_BREAKER`, which is commented out in `wrangler.toml:166` (so it is **off** unless the owner sets it). Switched on, it really works: after 5 failures calls are refused instantly (0 fetches for rows 5-7), after 61 s one call goes through and closes it, and it publishes `pb:mdblist` in KV (`node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s08/t10_breaker.mjs`).
- **OAuth state/CSRF.** Trakt and MDBList callbacks compare the state cookie with `timingSafeEqualHex`; MDBList also uses PKCE; the cookies are `HttpOnly; Secure; SameSite=Lax; Path=<oauth path>`; tokens are put in the URL fragment or stored server-side encrypted. Simkl compares with `!==` (not constant time) which is immaterial for a random 72-bit state.
- **Legacy install URLs.** Bare-array base64, object base64, standard base64 with padding, the `/c/<config>/...` prefix, a raw KV key without the saved-config prefix, and the `enabled:false` flag all still resolve to correct manifests and catalogs (`node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s08/t5_legacy.mjs`). An unknown v2 token gives a clean 404 JSON with CORS.
- **Meta route.** Channel, tt and tmdb: ids all answer with CORS; unknown ids answer `{meta:null}` (cached 1 h only for the non-tt/non-channel fallthrough).

## Done well (do not change)
- One `fetch()` guard (`src/core/02_http-and-creator-utils.js:2946`) gives every outbound call a timeout, strips edge-cache options from calls that carry an Authorization header, and hosts the breaker.
- Three-tier last-known-good cache (isolate, KV, edge) with in-flight de-duplication and the empty-overwrite refusal.
- Failure answers are consistently non-cacheable (`CATALOG_NO_CACHE`) so a short outage does not last an hour in the apps.
- `/api/save` refuses unusable row ids and types (`saveEntriesProblem`).
- Token refresh is single-use aware (re-reads the row before declaring a refusal) and uses an encrypted token store.

## Not audited and why
- Real Stremio/Nuvio/Wako clients and their exact paging behaviour (no apps available; only the server side was exercised).
- Live provider responses (no network by rule); only the committed fixtures plus my own failure stubs were used. Real TMDB page limits (500) were not exercised.
- Nuvio TV launcher routes (`/nuvio-tv-launcher`, `/api/nuvio-tv/*`), Plex/Jellyfin/Emby scrobble webhooks, Ko-fi webhook, and the media-app sync calls to Stremio/Nuvio servers (`src/api/61_*`, `64_*`): only counted as outbound call sites (all pass through the timeout guard or set their own `AbortSignal.timeout`), not behaviour-tested.
- Admin API integrations and the client-side `fetch` calls inside page scripts.
- v2 installs end to end (`/api/installs` creation) beyond the unknown-token case.
