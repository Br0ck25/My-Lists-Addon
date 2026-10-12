# Audit report

Scope: find and report only. No source file, test or guard was changed. Findings were traced to a real caller or input, or reproduced; anything uncertain is marked **SUSPECTED**.

- Date: 2026-10-11, branch `claude/sharp-gauss-5v60qa`, `main` at `cbe0b44`.
- Baseline: `bash verify.sh -q` printed `ALL CHECKS PASSED` on a clean checkout (no finding #1 from a failing guard).
- Full suite, both modes (`node --test tests/*.test.mjs` and with `MLA_TEST_V2_LISTS_READ=1`): **2349 tests, 0 failed, 0 skipped** each time.
- Scratch reproductions, the mutation copy and screenshots are outside the repo (the session scratchpad). Nothing in the repo was edited except this file.

Severity scale used: Critical = security or data loss with real impact on user data; High = wrong behavior or a real security hole with limited impact; Medium; Low = polish. Where a finding is a security issue but exposes no user data I say so, and rate it High, not Critical.

## Update 2026-10-12: what has been fixed

Commits on `claude/sharp-gauss-5v60qa`, each with a test that failed first and a passing `bash verify.sh -q`. Release notes: `docs/RELEASES.md`, entry 2026-10-12.

| Finding | Status |
|---|---|
| #1 poster-badge host bypass | **Fixed** (`5c97f98`) |
| #2 failure answers cached an hour | **Fixed** (`6f46246`) |
| #3 `/api/track-install` unlimited, free-form groups | **Fixed** (`9aea722`): 30/minute, known groups plus "Other", `LIMIT` on the admin read. Stored rows from before the limit are not touched (that is stored data: ask) |
| #4 168 preview calls on first load | **Fixed** (`223e7c3`): 34 at load in a real browser |
| #5 unknown install id cached as a generic manifest | **Fixed** (`6df9393`): 404 for the manifest, uncached empty answers for catalog and meta |
| #6 support history vanishes after 300 newer threads | **Fixed**: `feedback.creator_name` (migration 0022) and a lookup by account; falls back to the old window until 0022 is run |
| #7 `/api/save` accepts broken rows | **Fixed** (`23def51`) |
| #9 ownerless channel codes can be overwritten | **Guard fixed** (`cfe7e1e`). The old links themselves are **not deleted yet**: the new Maintenance panel counts and deletes them when you choose, after a KV export |
| #8 `DELETE /api/me/sessions` `id:"%"` revokes everything | **Fixed**: reproduced (`revoked:3`), then only a 16 hex character id is accepted (400 otherwise) and it is matched exactly, not with `LIKE` |
| #15 `copyLink` throws without a clipboard API | **Fixed**: reproduced first ("Cannot read properties of undefined (reading 'writeText')"); uses `copyTextToClipboard`. `sharePreset` had the same call and is fixed too; the Nuvio buttons no longer claim a copy that failed |
| #16 delete list: no Undo, early deletion record | **Fixed** (`0ee1361`) |
| Test gaps: `/api/save` and feedback limits (mutations M08, M16) | **Closed**: 14 mutations of the new code, all caught |

Still open, as reported: #10, #11, #12, #13, #14, #17 to #23. One more thing seen while verifying: `tests/rpdb.test.mjs` "asks RPDB at most 20 new posters a minute" can fail when a run crosses a minute boundary (it does not use `awaitFreshRateWindow`); it passes on a rerun.

## Findings

| # | Severity | Area | File:line | Confirmed? | What is wrong | How to reproduce | Proposed small fix |
|---|---|---|---|---|---|---|---|
| 1 | High | Security | `25_api-catalog-routes.js:38` (`isAllowedPosterUrl`), used at `:705`, `:720`, `:754` | CONFIRMED | `if (u.pathname.startsWith("/api/safe-poster")) return true;` has no host check, so **any** https host whose path starts with `/api/safe-poster` passes the poster allowlist. `/api/poster-badge` then (a) 302-redirects the visitor to that host (open redirect from your trusted domain) and (b) with any badge param, fetches that URL from the Worker, buffers it unbounded (`arrayBuffer()`), and embeds it as a data URI (open image proxy, bandwidth and memory). The comment at `:705-715` says this was meant to be closed. No user data is exposed, so not Critical. | `GET /api/poster-badge?poster=https%3A%2F%2Fevil.example%2Fapi%2Fsafe-poster` answers `302 Location: https://evil.example/api/safe-poster`. With `&premiere=1` the Worker fetches `https://evil.example/api/safe-poster?x=1`. A control with `/x.png` on the same host answers 404. | Accept the `/api/safe-poster` path only when `u.origin` equals the request origin (pass `url.origin` into `isAllowedPosterUrl`). Also cap the fetched body size. Add a test that a foreign host with that path is refused. |
| 2 | High | Stremio/Nuvio/Wako | `25_api-catalog-routes.js:1623`, `:1633`, `:1649` (success TTL at `:1606`) | CONFIRMED | When a provider fails, the catalog route answers 200 with the "temporarily unavailable" tile, the stale copy, or empty `metas`, all through `jsonPublic` with its default `Cache-Control: max-age=3600`. A successful shared row is cached 300 s (`:1606`). So a one-minute provider outage is cached for **an hour** by Stremio/Nuvio/Wako and any CDN, longer than a good answer. | Save a config with one MDBList row, stub the upstream to return 503, `GET /<id>/catalog/movie/<rowId>.json`: `200`, `Cache-Control: max-age=3600`, body `{"metas":[{"name":"Top — temporarily unavailable"...}],"error":...}`. | Pass `{ "Cache-Control": "no-store" }` (or `max-age=30`) on those three returns. Add a test on the header. |
| 3 | Medium | Backend, abuse | `25_api-catalog-routes.js:1677` (`/api/track-install`), `03_admin.js:129`, `:2388` | CONFIRMED | Unauthenticated, **no rate limit** (its siblings `/api/track-event` and `/api/track-search` have one). Each request writes up to 30 `source_groups` rows with a count of up to 1000 each. 100 requests from one IP created 3,000 rows and 3,000,000 "installs". It corrupts the admin "sources people use" table and grows D1 without bound. `SELECT * FROM source_groups` at `03_admin.js:2388` is unbounded, so `/admin` renders every row. | 100 POSTs of `{groups:{"Fake i-j (x)":1000,...30 names}}` from one IP: all 200; `source_groups` has 3000 rows, `sum(install_count)=3,000,000`. | Add `consumeRateLimit(env, ctx, "trackinstall", ip, 30)` like `/api/track-event`; only count groups from a known set (or cap names and the count per request to, say, 20); add `LIMIT` to the admin read. |
| 4 | Medium | UI, performance | `19_client-search-and-likes.js:1139-1200` (per-card preview), limit at `25_api-catalog-routes.js:1780` | CONFIRMED | A first load of `/` or `/discover` fires **168** `/api/preview` calls in about 6 s; the per-IP limit is 240/min. The in-memory cache (`_listPreviewCache`) does not survive a reload. A second load inside a minute, or two people on one IP (family, CGNAT), gets 429s and every row shows "Couldn't load previews" (each Retry spends more calls). `/discover/gems` makes 94, `/discover/curated` 38. | Load `/discover` three times within a minute from one IP: statuses `{200:168}`, then `{200:72, 429:100}`, then `{429:138}`. | Fetch only rows near the viewport (IntersectionObserver) and/or add a batch preview endpoint; key the limit per session as well as per IP. Product call, see question 1. |
| 5 | Medium | Stremio/Nuvio/Wako | `25_api-catalog-routes.js:1165-1201`, `04_config-resolution.js:30-35` | Behavior CONFIRMED; the KV-lag trigger is **SUSPECTED** | An unknown or unreadable install id answers 200 with the generic 2-catalog manifest (and `{"metas":[]}` from catalog), cached `max-age=3600`. If a new id is not yet visible in the colo that serves the first Stremio request (KV is eventually consistent, and misses are cached), the user installs an empty add-on that is then cached for an hour. | `GET /nonexistent123/manifest.json` answers 200, `max-age=3600`, default manifest. The KV-lag timing cannot be reproduced locally. | For a config that does not resolve, answer 404 or `no-store`, so a retry works. |
| 6 | Medium | Backend, data | `25_api-catalog-routes.js:6935-6937`, `:6965-6976` (`/api/feedback/threads`) | CONFIRMED | The "my support history" lookup reads only the newest 300 feedback rows (`ORDER BY updated_at DESC LIMIT 300`) and filters by name in JS (the KV fallback has the same cap). Once 300 newer threads exist, an account's older conversation silently disappears from its own list. | File feedback signed in as `fbuser`, then 305 anonymous feedbacks from other IPs: threads visible to `fbuser` go from 1 to 0. | Query by owner: store `creator_name` in a column (or an indexed table) and `WHERE creator_name = ? LIMIT ?`. |
| 7 | Low | Backend | `25_api-catalog-routes.js:7571-7789` (`/api/save`), `05_catalog-core.js:57` | CONFIRMED | Saved entries are not validated. An entry with no `id` produces a manifest catalog without `id` (Stremio rejects the whole add-on); ids containing `/` or `.` break catalog routing; `type` is unchecked. It only harms the saver's own link. | Save `{entries:[{url,name,type:"movie"}]}` (no `id`) and read the manifest: the catalog has no `id`. | Reject with 400 (this file already prefers "rejected, not truncated"): id matches `^[A-Za-z0-9_.:-]{1,80}$`, unique, `type` in `movie|series`. |
| 8 | Low | Auth | `26_api-creator-and-admin-routes.js:1553-1563` (`DELETE /api/me/sessions`) | CONFIRMED | `id` is used as a SQL `LIKE` prefix (`targetId + "%"`), so `id:"%"` revokes every session of the account, including the current one. `id:""` is falsy and also revokes all (current included). Own account only. | Four sessions, `DELETE /api/me/sessions {id:"%"}` answers `revoked:4`; `{id:""}` answers `revokedAll:true` and the caller is logged out. | Require `/^[0-9a-f]{16}$/` for `id`; use `substr(id_hash,1,16) = ?` instead of `LIKE`. |
| 9 | Low | Auth | `26_api-creator-and-admin-routes.js:3088` (`/api/channel/share`) | CONFIRMED (by reading) | A share record with no `owner` (old anonymous shares) can be overwritten, and claimed, by **any** signed-in person who knows its code, replacing the channel for everyone holding the link. The code comment says the code is its own proof, so this may be intended. | Create an ownerless `channelshare:<code>`, then `POST /api/channel/share {code,...}` as any account. | Product call, see question 2. |
| 10 | Low | Auth | `02_http-and-creator-utils.js:469` (`verifyCsrf`) | CONFIRMED (by reading) | The CSRF exemption is `path.includes("/oauth/")`, not `startsWith` on the real OAuth prefixes. Today no mutating route contains `/oauth/` other than the real ones, but a future route that does would silently skip the check. | Read the code. | `/^\/api\/(trakt\|mdblist\|simkl\|tmdb)\/oauth\//.test(path)`. |
| 11 | Low | Backend, KV | Ko-fi route `25_api-catalog-routes.js:596-600`; feedback cap `:6680-6682`, `:6763` | CONFIRMED (by reading) | Read-then-write counters on KV (not atomic, eventually consistent): two near-simultaneous Ko-fi retries of one `message_id` can both pass the `seenKey` check and be counted twice; the feedback per-IP cap can be exceeded by parallel requests. | Fire two concurrent webhook deliveries with the same `message_id`. | Put the Ko-fi dedupe in D1 (`INSERT OR IGNORE` on message id) and count only when the row was inserted. |
| 12 | Low | Backend, KV | `25_api-catalog-routes.js:7958-7977` (`/api/lists/like`) | SUSPECTED | After the vote it re-reads the whole list record and writes it back with `likes` set. An edit saved by the owner between that read and write is reverted (documented in the comment as narrowed, not removed). KV has no compare-and-swap. | Race an owner save against a like. | Keep the count only in the ledger/D1 and stop writing it onto the list record. |
| 13 | Low | Cron | `45_jobs-dispatcher.js:480-484` | SUSPECTED | Without the queue binding the legacy cron path has no lease, so ticks that overlap can run the same sweeps twice. With the queue (CAS lease at `:160-163`) this does not happen. Only the fallback is affected. | Not reproducible without a slow sweep. | Fine to leave if the queue is always bound in production. |
| 14 | Low | UI, accessibility | `20_client-channel-builder.js:1368-1440`, `16_client-row-core.js:2501`, `24_client-backup-restore-presets.js:1849` | CONFIRMED | `var(--err, #ff453a)`: `--err` is not defined anywhere, so the hex fallback is always used (about 3.4:1 on white, under the 4.5:1 rule, and no dark variant). `color:#fff` on `var(--danger)` and `var(--success)` breaks rule 9. | Grep `--err` across the sources: only these uses. | Use `var(--color-danger-text)` (the defined `*-text` token) and `--color-on-brand`. |
| 15 | Low | UI | `24_client-backup-restore-presets.js:1842-1870` (`copyLink`) | CONFIRMED (by reading) | Calls `navigator.clipboard.writeText` with no guard. Where `navigator.clipboard` is undefined (http, some in-app webviews) it throws synchronously, before the `.catch` fallback. This is the install-link copy, the core action. The canonical `copyTextToClipboard` (`16_`) has the fallback. | Call `copyLink(url)` with `navigator.clipboard` undefined. | Route it through `copyTextToClipboard`. |
| 16 | Low | UI | `22_client-creator-profile.js:5510-5560` | CONFIRMED (no toast); effect of the early tombstone SUSPECTED | Deleting a custom list gives no success toast and no undo (rules: reversible deletes use `showUndoToast`). `recordCreatorListDeletion(slug)` runs **before** the server confirms; if the delete fails, a 24 h local tombstone remains for a list that still exists, which blocks backfill and re-upload of that slug (`:4451`, `:4886`). | Delete a list on the phone layout: list disappears, no toast. | Record the tombstone after `data.ok`; add `showUndoToast` or a success toast. |
| 17 | Low | UI | `24_client-backup-restore-presets.js:4118`, `:4211` | CONFIRMED | `transition: all` (an AI_UI_RULES "Never") in the guide page CSS. | Grep. | Name the properties. |
| 18 | Low | UI, accessibility | `21_client-custom-list-builder.js` (`.customListPosInput`) | CONFIRMED | The pick position number input has no label or `aria-label`. | Open a list's Edit; inspect the inputs. | Add `aria-label="Position in list"`. |
| 19 | Low | UI | Settings account label (`👤`), `u-bg-rgba_0_0_0_0_75`, `u-bd-1px_solid_rgba_255_255_255_0_3` | CONFIRMED | Rule 8 says no emoji; rule 2 says no hard-coded rgba. | Settings > Account, inspect pick position inputs. | Use an inline SVG icon and tokens. |
| 20 | Info | Docs | `25_api-catalog-routes.js:452`, `24_client-backup-restore-presets.js:2691` | CONFIRMED | Comments cite `/settings/connections` as a shell path; it is not one (settings subs are account, display, scrobble, external, backup, feedback) and answers 404. | `GET /settings/connections` is 404. | Fix the comments. |
| 21 | Info | Duplicate code | `25_api-catalog-routes.js:2024-2030` vs `bytesToBase64` (`:66`) | CONFIRMED | `/api/channel-logo` base64-encodes with a per-byte string loop although `bytesToBase64` (chunked) exists in the same file. Mentioned, not deleted (rule 9). | Read. | Call `bytesToBase64`. |
| 22 | Info | Backend | `26_api-creator-and-admin-routes.js:3496-3507` (`/api/creator/lists/reorder`) | SUSPECTED | One D1 batch with up to `CREATOR_LIST_ORDER_MAX` = 5000 `UPDATE`s, errors swallowed, then KV is written. Real accounts are far below this (worst seen 129) so it does not matter today. | Not reproducible with real data. | Chunk the batch if the cap stays at 5000. |
| 23 | Info | Test guard | `tests/route-access.test.mjs:94-100` | CONFIRMED | The route scanner only matches double-quoted `path === "/..."`; `59_support-emails.js` compares with single quotes. All six routes are still listed in the manifest and gated by their callers in `26_`, so nothing is missing today, but a route added only in single-quote form would not be seen. | Read. | Make the regex accept both quote styles. |

## Phase results

### Phase 0: baseline
`git config core.hooksPath .githooks` done; `bash verify.sh -q` passed. HANDOFF known items: the only "unchecked" ones are a modal over the phone bottom nav, drag-and-drop, storyline and deep creator-profile screens. I checked the first two (see Phase 3); storyline and deep creator-profile screens were not exercised.

### Phase 1: routes and auth
- Every route in 25_/26_/27_/44_/59_ (both quote styles, any variable name) is in `tests/route-access.json`; nothing is missing. (`/api/installs` is matched with `!==` in `27_installs.js`, which is why a naive scan calls it stale.)
- All `/admin` routes are gated. Every `/admin/api/*` handler reaches `isAdminRequest` or `resolveAdminIdentity` before doing work (a strict script, not just a grep window): the prefix guards in `27_:737`, `44_:380` and the six `26_:6949-6978` support-email entries, plus inline checks for `admin-sessions` and `revoke-admin-session`.
- Ownership: every account route uses `auth.username` (not the claimed name) as the key prefix, and the SQL for installs, connections and likes binds `account_id` or `voter`. The v2 Lists API returns 404 for another person's private list and 403 for writes. `/api/save` whitelists fields (`trackOwner` cannot be injected). The feedback thread routes enforce ownership (`:6715-6729`). No cross-user read or write was found; the one gap in this area is #9 (ownerless legacy share codes).
- CSRF (same-origin plus JSON content type on every mutating route) and the throttled `authenticateCreator` held up under reading.

### Phase 2: backend
- SQL: every `prepare()` that interpolates something interpolates a constant or a placeholder list. No injection. `LIMIT`s are present on request paths (the exceptions are #3 and a backfill-only full scan).
- D1 failures degrade without leaking: with D1 failing every statement, public routes answered clean errors or empty 200s and no table or column names reached the client. (An empty 200 for the public directory during an outage is worth a second look.)
- Logs: `redactForLog` masks `api_key=`, `token=`, Bearer and `MYL-` keys; the install id in a request path is not masked (it is a bearer credential), but no log line prints request URLs.
- Provider failures: 429/5xx degrade to stale or placeholder rows and feed a circuit breaker; `Retry-After` is not read. The global `fetch` guard adds a 30 s ceiling.
- Cron: the queue path uses compare-and-set leases (good); the fallback is #13.
- Unhandled errors: a top-level boundary in `export default.fetch` returns clean JSON and hides D1 text.

### Phase 3: frontend and UI
- XSS: client code builds HTML by string concatenation. A scan of every `+ userText +` in an HTML line found 11 candidates; all were escaped or numeric. In the browser a list named `<img src=x onerror="window.__xss=1">Hostile "list"` and titles containing `<b>x</b>` render as text; the flag never set.
- No raw `</script>` outside the page's own closers (the verify guard agrees).
- Driven in Chromium against the real Worker over HTTP (a scratch copy of `dev/server.mjs` with `FF_SESSIONS` and `FF_V2_LISTS_READ` on, stubbed upstreams): sign up, create a list, add, remove, reorder by position box, reorder lists by mouse drag and by touch drag, delete with confirm, empty state, 500 and offline error states, dark mode, all shell pages at 375 and 1280 px. No horizontal overflow at 375 on any shell page; no uncaught page errors. The delete confirm and the overlay sit above the bottom nav (a click through to the nav is blocked).
- Rules scan: 0 `alert/confirm/prompt`, 0 inline `onclick`, `!important` count 241 (unchanged). New items are #14, #17-#19.
- Movie vs show/episode wording: the toast and confirm strings that say "show" or "episode" are all in channel or series contexts.

### Phase 4: test quality
- **Every test file run** (`node --test tests/*.test.mjs`, each file in its own process), both modes: 2349 pass / 0 fail / 0 skipped, 487 suites, about 3 minutes each. CI's `MLA_TEST_V2_LISTS_READ=1` mode also green.
- **Static scan** of 2177 `it()/test()` blocks: only one has no assertion call (`tests/lists-v2.test.mjs:1370`, "builds the fixture", a setup step). Two tests assert only "not a 5xx" (`route-access.test.mjs:171`, `security-suite.test.mjs:185`); those are deliberate crash sweeps, not correctness tests. No `assert.ok(true)` or truthy-object-only checks.
- **Mutation test (does a test fail if the business logic changes?)** Done on throw-away copies in the scratchpad, one mutation at a time, against 30 test files (an unmutated control of the same set: 1306 tests, exit 0, so a "caught" is a real failure):

| Mutation | Result |
|---|---|
| M01 poster-badge host allowlist ignored | caught |
| M02 CSRF same-origin check off | caught |
| M03 `/api/channel/share` lets anyone overwrite another owner's code | caught |
| M04 `/api/lists/like` accepts private lists | caught |
| M05 v2 Lists API lets a non-owner write | caught |
| M06 session username mismatch accepted | caught |
| M07 feedback-thread owner check off | caught |
| **M08 `/api/save` rate limit 20 to 2,000,000** | **SURVIVED** (no test anywhere references it) |
| M09 `/admin/api/audit` gate off | caught |
| M10 v2 list `If-Match` ignored | caught |
| M11 Ko-fi webhook token not checked | caught |
| M12 `/api/preview` source allowlist off | caught |
| M13 installs: owner bind dropped | caught |
| M14 catalog success TTL 300 s to 1 year | caught |
| M15 list-delete failure treated as success | caught |
| **M16 feedback 20/day cap removed** | **SURVIVED** (no test anywhere references it) |
| M17 account purge no longer revokes installs | caught |

  15 of 17 caught. The security and ownership checks are well pinned. The two survivors are both **rate limits on anonymous write routes**, which is also the kind of gap behind finding #3 (a route with no limit at all and no test noticing).
- **Tests that pass while a real bug is live:** finding #1 (`/api/poster-badge` host bypass). M01 shows a test refuses a foreign host, but none uses a foreign host with the path `/api/safe-poster`. Findings #2, #5 and #7 are likewise untested: tests check the 300 s success header (M14) but not the header on the failure branches, the unknown-install-id answer, or entry shape in `/api/save`.
- **Routes never named by any test** (apart from the anonymous-access sweep): `/api/track-install`, `/api/external-list/item-add`, `/api/external-list/item-remove`, `/api/external-sync/history`, `/api/mdblist-history-raw`, `/api/trakt-my-private-lists`, `/api/quick-channel-shows`, `/api/resolve-show`, `/api/toplists`, the four `/api/*/oauth/start` routes, `/robots.txt`, `/sitemap.xml`, `/unavailable-poster.svg` (16 of 163).
- **Branches and error paths with no test that I found:** the two rate limits above; the `/api/me/sessions` `id` edge cases (#8); the 300-row cap in feedback threads (#6); the `copyLink` no-clipboard fallback (#15); the delete-list failure path in the page (#16); the 429 row state on a page load (#4).
- Line coverage: I tried `node --test --experimental-test-coverage`, but this bundle's page code lives inside template literals and the aggregate was not credible (11.7 percent), so I am not reporting a number.

## (a) Top 5 to fix first
1. **#1 `/api/poster-badge` open redirect and image proxy.** It is a live security hole on your trusted domain, a one-condition fix, and the suite passes with it present.
2. **#2 Provider failures cached for an hour.** Every user is affected whenever MDBList, Trakt or TMDB blips; the failure outlives the outage by up to an hour in Stremio, Nuvio and Wako. Three return statements.
3. **#3 `/api/track-install` has no rate limit.** Anyone can flood D1 and wreck the stats in minutes; add the limit and tests for it, and for the two other untested limits (`/api/save`, `/api/feedback`, mutations M08 and M16).
4. **#4 First page load fires 168 `/api/preview` calls against a 240/min cap.** The second visit, or a second person on the same network, sees broken rows. It also costs you provider quota.
5. **#5 with #7: an unknown install id gets a cached generic manifest, and `/api/save` accepts entries with no `id`.** Both end with a user holding an install that silently shows nothing; both are small (404 or `no-store`, and 400 on bad entries). #6 (support history vanishing after 300 newer threads) is next in line.

## (b) What I could not check
- **Anything on real Cloudflare:** KV eventual-consistency timing and negative caching (finding #5's trigger), the Cloudflare Images JPEG path for Stremio badges (HANDOFF already says untested live), D1 per-invocation query limits (#22), real cron and queue timing, Email Routing inbound and `env.EMAIL.send()`.
- **Real providers:** MDBList, Trakt, TMDB and Simkl were stubbed, so real response shapes, OAuth sign-in and token refresh were not exercised, nor was the Ko-fi webhook with a real payload.
- **Real clients:** I read the manifest, catalog and meta responses (shape, CORS, cache headers), but did not run Stremio, Nuvio or Wako, so how each treats an id-less catalog or a cached error tile is inferred, not observed.
- **UI I did not drive:** the `/admin` dashboard pages (only their route gating), the channel builder (13.5k lines), storylines, deep creator-profile screens, import flows, Trakt/Letterboxd export, the Share modal. Real-device Safari and Android touch behavior, and screen readers.
- **Phone screenshots** came from headless Chromium, which reserves a 15 px scrollbar, so layout width was 360 not 375 px in full-page shots; I rechecked horizontal overflow with DOM measurements instead.
- **Line coverage** (see Phase 4).

## (c) Questions that are product decisions for you
1. **First-visit load (#4):** should Discover and the home page load every shelf at once (current, fast to look at but 168 provider calls), or only the shelves on screen (cheaper, a short wait when scrolling)?
2. **Old anonymous channel share links (#9):** should anyone who holds such a link be able to replace its contents and take it over (current), or should old ownerless links become read-only?
3. **Install link that does not resolve (#5):** should the app answer 404 (Stremio says it could not load the add-on) or keep showing the generic empty add-on (current)? The first is clearer but visible to users with a broken link.
4. **Deleting a list (#16):** keep the confirm dialog only, or add an Undo toast like removing a row (the UI rules say reversible deletes use Undo)?
5. **Install statistics (#3):** do you want the "sources people use" table to count only a fixed set of known source groups (safe, hides new ones until added), or keep free-form names with a per-request cap?
