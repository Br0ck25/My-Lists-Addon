# 03 Security
Health grade: C - the plumbing is strong (hashed keys and sessions, nonce CSP, parameterised SQL, atomic D1 rate limits, admin routes all gated), but two High holes let a stranger read and rewrite any user's watch history knowing only their public username.

Root cause shared by SEC-01 and SEC-02: the username is used as a credential. The Nuvio TV pairing itself hands the TV nothing but the username (`installId: auth.username`, `src/api/69_creator-api-sync-routes.js:891-899`), and `resolveConfig` serves `creatorsync:<username>` as an owner-verified install. Usernames are public (creator pages, `/lists/public.json`).

## Scope covered (files, routes, commands run)
- Auth: `src/api/62_creator-auth.js`, sessions and key hashing in `src/core/02_http-and-creator-utils.js` (1355-1700), admin identity / Access JWT / admin sessions / audit in `src/admin/03_admin.js` (1625-2150), admin login/logout `src/api/80_*.js`, CSRF `verifyCsrf` (02_:459-522), CORS (02_:1-67), security headers + CSP (02_:162-387), rate limits `clientIpKey` (02_:3098) and D1 counters.
- Authorization walk: every one of the 184 routes in `tests/route-access.json`, GET and POST, anonymous and as a signed-in user (`walk.mjs`, 736 requests). All 48 admin routes refused anonymous and normal-user calls (401/404); all 31 account routes refused anonymous calls. Then targeted IDOR tests on installs and the session list, and code trace of `/api/lists/:id`, `/api/imports/`, `/api/me/sessions`, feedback threads.
- Public write routes reviewed for missing auth: nuvio-tv history/sync/config/device, feedback, track-*, external-list, resolve, save.
- Injection: grep of every `prepare(` with `${}` or `+` (all interpolations are constant table/column names or `?` placeholder lists); XSS payloads planted through the real API in display name, list name/description/items and feedback, then rendered in Chromium (list page, creator page, every admin tab); `__proto__` / `constructor.prototype` JSON bodies on 5 routes.
- SSRF/redirect: `/api/poster-badge` (`isAllowedPosterUrl` allowlist), `/api/channel-logo` (path regex, fixed host), `/api/bp/warm` (same-origin only), all `Response.redirect`/`Location` sites, OAuth state checks.
- Secrets: `git grep` of tracked files and `git log -p --all` for key/token patterns (history is a shallow clone of 301 commits); wrangler*.toml; three GitHub workflows (actions pinned by SHA, backups gpg-encrypted).
- Privacy: delete-account sweep of every KV key and every D1 column (main + activity) after `DELETE /api/me` + purge job + scheduled tick; session lifecycle (sign-out, key reset, cache TTL).
- Scripts (all in `/tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s03/`): walk.mjs, sec01_nuvio_history.mjs, sec02_username_install.mjs, xss_probe.mjs, xss_browser.cjs, xss_admin.cjs, delete_account.mjs, misc_checks.mjs, abuse_limits.mjs, feedback_race.mjs, session_checks.mjs. Each imports the real built Worker through `tests/harness.mjs`; nothing in the repo was changed.

## Fix progress

Updated 2026-11-10. Status values: `open`, `fixed (awaiting verification)`, `verified fixed`, `open (partially fixed, ...)`, `regression introduced (...)`. Rows marked in the Verified column were checked by an independent review on 2026-11-10; see each finding's **Verification.** note. SEC-03, SEC-05 and SEC-06 were reviewed on 2026-11-14 at 8450cc9 (commit hashes as listed, all found): `bash verify.sh -q` passes, but the browser tests were SKIPPED (Playwright cannot be imported here).

| Finding | Status | Commit | How to verify | Verified |
|---|---|---|---|---|
| SEC-01 | verified fixed | ccac5fc | node --test tests/nuvio-tv-device-token.test.mjs (SEC-01 block). Old TVs must pair again. | 2026-11-10, independent review |
| SEC-02 | verified fixed | ccac5fc | node --test tests/nuvio-tv-device-token.test.mjs (SEC-02 block). LEGACY_USERNAME_OWNER_LINKS=1 undoes it. | 2026-11-10, independent review |
| SEC-03 | open (partially fixed: with FF_SESSIONS off the TV Launcher can neither load nor save) | 8e88c86, 93ebf65 | node --test tests/nuvio-tv-config-query-key.test.mjs tests/nuvio-tv-launcher-load.test.mjs. The key is still refused in the address. The launcher reads its config with the sign-in cookie, signs in again with the stored key and retries once if the cookie has ended, and if it still cannot load it shows "Could not load your TV setup…" and refuses to save from the defaults. Needs FF_SESSIONS on (with it off, the launcher cannot load or save). | 2026-11-14, independent review |
| SEC-04 | verified fixed | a1ecc1f, 5997fe0, 1ffc61e | node --test tests/account-purge.test.mjs tests/support-history.test.mjs. Feedback threads are now deleted with the account (owner decision). | 2026-11-10, independent review |
| SEC-05 | verified fixed | cc18207 | node --test tests/anonymous-write-limits.test.mjs (parallel feedback block). Over-limit now answers 429. | 2026-11-14, independent review |
| SEC-06 | verified fixed | 6cc6efd | node --test tests/anonymous-write-limits.test.mjs (Nuvio TV block). 10 device codes/min and 120 history calls/min per address. | 2026-11-14, independent review |

## Proven findings   (ordered by severity)

### SEC-01 Anyone can add to and erase any account's watch history by knowing its username (Nuvio TV history routes)
- Severity: High
- Status: Proven
- File:line: `src/api/25_api-catalog-routes.js:1284-1317` (route, no auth), `src/api/25_api-catalog-routes.js:597-599` (target lookup), `src/core/02_http-and-creator-utils.js:474` (CSRF exemption for `/api/nuvio-tv/`)
- What is wrong: `POST /api/nuvio-tv/history` and `POST /api/nuvio-tv/history/remove` take a `targetId` from the request body and act on whichever account it names. `resolveNuvioTvTargetData` looks the target up with `WHERE username = ? COLLATE NOCASE OR id = ? OR key_hash = ?`, so a plain username (public: it is in every creator page URL, `/lists/<username>`) or the account's numeric id (sequential: 1, 2, 3...) is accepted. There is no key, cookie, pairing secret or device check on the path, and the whole `/api/nuvio-tv/` prefix is exempt from the CSRF/Origin check.
- Impact: a stranger can, for any user, insert fake movies/episodes into their watch history (which also drives Continue Watching, "watched" state and recommendations, and is pushed into the activity database) and delete real entries one by one. No login needed; scripting over ids 1..N hits every account. Integrity loss of personal data; no data read through this route.
- Proof: `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s03/sec01_nuvio_history.mjs` (real Worker, harness D1/KV; attacker requests carry no cookie, a different IP, `Origin: https://evil.example`, `Sec-Fetch-Site: cross-site`):
  ```
  victim install created: 201 token(redacted len)= 43
  ATTACKER add (no auth, cross-site Origin): 200 {"ok":true,"success":true}
  ATTACKER add #2: 200
  victim tracking blob now holds: [ 'tt0133093', 'tt0000666' ]
  ATTACKER remove: 200 {"ok":true,"success":true}
  victim tracking blob after remove: [ 'tt0000666' ]
  ATTACKER add by numeric account id 1 : 200
  ATTACKER GET /api/nuvio-tv/sync/victimnuvio: 200 manifestUrl: https://example.test/victimnuvio/tv/manifest.json
  ```
  Trace: `handleNuvioTvHistoryRoute` (25_:1284) -> reads `body.targetId` (1304) -> `resolveNuvioTvTargetData(targetId)` (1309; lookup at 597-599 matches by username or id) -> `handleNuvioTvHistoryRemove/Add(env, username, body)` (1315/1317) which write `creatorsynctracking:<username>` (1128/1268) and D1. No auth call anywhere on the path.
- Recommended fix: require a secret the TV actually holds (the device pairing token issued by `/api/nuvio-tv/device/claim`, or the 43-char install token) and stop matching `targetId` against `username` and `id` for anything that writes. Effort: M.

**Verification.** 2026-11-10, independent review: **verified fixed**. Read ccac5fc. The new `tests/nuvio-tv-device-token.test.mjs` fails 6 of 10 against the parent commit. On HEAD, `POST /api/nuvio-tv/history` and `/history/remove` answer 404 to `targetId` = username, upper-case username or numeric id, and write nothing. They work only with the token minted at pairing (`resolveNuvioTvDeviceToken` checks the `tv` scope, `revoked_at` and `deleted_at`). An ordinary install link and a revoked TV link are refused. Owner-visible effect (documented in OPERATIONS section 34): TVs paired before this release must pair again to report history.

### SEC-02 A username alone opens that account's synced install: anyone can read its private Watch History shelf and mark titles watched
- Severity: High
- Status: Proven
- File:line: `src/core/04_config-resolution.js:104-110` (resolveConfig tries the parameter as a USERNAME first), `src/core/04_config-resolution.js:68-92` (returns `trackOwner`/`installTrackOwner` = that username), `src/api/70_stremio-routes.js:358` (catalog passes `verifiedOwner: trackOwner`), `src/core/02_http-and-creator-utils.js:5350-5353` (`mayReadTrackedShelf` lets `verifiedOwner === username` through), `src/api/63_subtitles-track.js:39-40,59-60` (playback ping trusts `installTrackOwner` with no key)
- What is wrong: every signed-in account's builder autosaves its rows to `creatorsync:<username>`. Any Stremio route with `/<config>/...` resolves `<config>` as a username before anything else, and the resolved config says "this install is owned and verified by <username>". No secret is involved, and usernames are public (`/lists/<username>`). The private-shelf gate (`mayReadTrackedShelf`) and the auto-track ping both treat that as proof of ownership.
- Impact: for any user who has a Watch History / Continue Watching / Watchlist shelf in their rows, a stranger can (a) read the shelf - the titles they watched - as a catalog, even though the user never shared it (the share flag is null and the public list page correctly says 404); (b) mark any movie or episode as watched in their account, polluting history, Continue Watching and recommendations. Personal viewing history is privacy-sensitive data.
- Proof: `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s03/sec02_username_install.mjs` (victim uses only the normal `/api/creator/sync/save` and `/save-tracking`; attacker requests carry no cookie or key):
  ```
  victim sync/save: 200 true
  victim sync/save-tracking: 200 true
  victim share flags (null = never shared): null
  ATTACKER GET /victimsync/catalog/movie/watch-history.json -> 200 [["tt0111161","Private Movie Title"]]
  control GET /lists/victimsync/watch-history.json -> 404
  ATTACKER GET /victimsync/subtitles/movie/tt0068646.json -> 200
  victim history after ping (load): ["tt0068646","tt0111161"]  kv: ["tt0068646","tt0111161"]
  diagnostic: {...,"lastPingId":"movie:tt0068646",...,"matched":"yes (tt0068646)"}
  ATTACKER GET /api/resolve?config=victimsync -> 200 {"ok":true,"entries":[{"id":"watch-history",...,"url":"autotrack:watch-history:movie:victimsync"}],...
  ```
  The last line shows the same thing on `/api/resolve`: the bare username returns the account's saved rows (list URLs included). Note the media-server webhook already retired its `?config=` form for this kind of reason (`src/api/64_media-server-scrobble.js:169-181`); the subtitles ping and the catalog routes still accept it.
- Recommended fix: do not treat a username-keyed config as owner-verified. Either stop serving `creatorsync:<username>` as an install (use the hashed v2 install token, which already carries a "track" scope), or resolve it with `trackOwner`/`installTrackOwner` empty so private shelves and the playback ping require the real install token. Check the Nuvio TV launcher, which builds `/<username>/tv/manifest.json` URLs (`src/api/25_api-catalog-routes.js:1385-1386`), before changing. Effort: M.

**Verification.** 2026-11-10, independent review: **verified fixed**. Read ccac5fc. `resolveConfig` now checks `/i/<token>` first and strips owner proof (`withoutOwnerProof`) from a bare username config, unless `LEGACY_USERNAME_OWNER_LINKS=1`. I probed every route an attacker could try, on HEAD, with a victim who has Watch History and Continue Watching rows. None of `/vic/catalog/movie/watch-history.json`, `/VIC/...`, `/vic/tv/catalog/...`, `/vic/catalog/series/cw.json`, `/api/nuvio-tv/collections/vic`, `/api/nuvio-tv/sync/vic`, `/api/resolve?config=vic`, or `POST /api/preview` with `autotrack:watch-history:movie:vic` (with and without `creatorName`) returns a private title. The owner's own preview with the key still does (control). A subtitles ping on `/vic/` and on `/vic/tv/` records nothing. Owner-visible effect (owner decision, documented): username-link installs lose their private shelves until the person installs an install link.

**Note (second independent review, 2026-11-10).** This agrees with the verdict, with one thing to follow up. `GET /api/nuvio-tv/config` (key-authenticated, `src/api/69_creator-api-sync-routes.js:952-953`) still returns the old `/<username>/tv/manifest.json` and `/api/nuvio-tv/sync/<username>` addresses. Those now serve no private shelves, so a TV set up from that answer shows empty Watch History, Continue Watching and Watchlist rows. Own probe: username links for the catalog, the TV catalog, sync, collections, `/api/resolve` and the playback ping no longer leak the private title or record a play. The TV's `/i/<token>/tv/` link still serves the shelf.

### SEC-03 The Account Key is still accepted in a URL query string on /api/nuvio-tv/config
- Severity: Low
- Status: Proven
- File:line: `src/api/69_creator-api-sync-routes.js:925-926`
- What is wrong: `handleNuvioTvConfig` falls back to `url.searchParams.get("creatorName")` / `get("creatorKey")`. Everywhere else the code refuses keys in URLs (`refuseQueryCredentials`, `src/core/02_http-and-creator-utils.js:780`; the scrobble webhook retired `?key=` with a 410). A key in a URL ends up in browser history, proxy and Cloudflare logs, and `Referer` headers.
- Impact: if any client (or a user copying a link) ever sends the key this way, the full-account credential is written to logs. The response also carries `Access-Control-Allow-Origin: *` (the `/api/nuvio-tv/` prefix is public-CORS). No direct remote exploit.
- Proof: `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s03/misc_checks.mjs`
  ```
  GET /api/nuvio-tv/config?creatorName=..&creatorKey=<KEY> -> 200 ACAO: * {"ok":true,"username":"alicemisc","mirror":true,...
  ```
- Recommended fix: call `refuseQueryCredentials(url, ["creatorKey"])` at the top of the handler, like `/api/feedback/threads` does. Effort: S.

**Verification.** 2026-11-14, independent review: **regression introduced**. Read 8e88c86. The security part is right: `GET /api/nuvio-tv/config?creatorName=..&creatorKey=<right key>` now answers 400 and authenticates nothing; `?creatorKey=%20` and `?key=` do not authenticate either. The new `tests/nuvio-tv-config-query-key.test.mjs` fails on the parent (1 of 2) and passes on HEAD. The old `nuvio-tv-sync` GET test was changed to sign in with a session (and to turn `FF_SESSIONS` on); that matches the new rule and is not a loosening. **What is now broken:** the launcher page's `loadTvLauncherConfig` (`src/page/26_page-nuvio-tv-launcher.js:228-250`) sends a GET with only `creatorName` and no key, so it works only when the browser holds a live session cookie. `creatorApiFetch`'s "401, send again with the key" fallback does not apply (it only re-adds a key from a JSON body; a GET has none), and the page calls this at `DOMContentLoaded` (line 681), before anything else renews the session. Own probe on the real Worker (`scratchpad/sec03_probe.mjs`): with `FF_SESSIONS=1` but no cookie (session ended after 30 days away, key still in localStorage because `FF_FORGET_KEY` is off by default) the page's request answers 401 on HEAD, where the parent's key-in-query request answered 200. With `FF_SESSIONS` unset it answers 401 for everyone (wrangler.toml `[vars]` leaves the flag commented out and OPERATIONS.md still says "Leave unset", though Release 19 in RELEASES.md reads as if it is on in production; I could not confirm the live setting). The page then silently keeps its defaults (`tvLauncherIsMirror = true`, `tvLauncherTvLists = []`, line 165): a person with their own TV lineup sees "mirror" and none of their TV shelves, and the next change made on the launcher page is saved from those defaults (`saveTvLauncherConfig` POSTs with the key in the body, so it authenticates), which can replace their saved TV lineup. Fix needed: give the page a key-carrying read that does not use the address (for example a POST read action, or a header the server accepts, or `/api/session` renewal before the GET), and a test that loads the config with the key and no session. Status set to `regression introduced`; the key-in-URL refusal itself should stay.

**Verification (second review, 93ebf65).** 2026-11-14, independent review: **partially fixed**, Status set back to `open (partially fixed, ...)`. Branch `claude/youthful-galileo-e6ci4l`, report taken from the same branch (cad40ee); hashes 8e88c86 and 93ebf65 used as listed. What holds: (1) the address refusal is untouched: `GET /api/nuvio-tv/config?creatorName=..&creatorKey=<right key>` answers 400 and authenticates nothing (own probe, `scratchpad/sec03_edge.mjs`, case F). (2) `loadTvLauncherConfig` (`src/page/26_page-nuvio-tv-launcher.js:236-265`) now loads the saved lineup with a live cookie, and with no cookie or a garbage cookie it posts the stored key to `POST /api/session` (body, never the address), gets a cookie and retries once, then loads; a later normal save then goes through (probe case C). (3) Whenever the load fails it shows an error toast and `saveTvLauncherConfig` (line 268) refuses to write while `tvLauncherConfig` is null, so the saved lineup in KV is left alone; I checked a wrong stored key (A), no stored key (B), a 500 from the config route (D) and a network failure (E): every case toasts an error, sends no save, and KV still holds the saved lineup. All seven save callers go through that guard. (4) `tests/nuvio-tv-launcher-load.test.mjs` runs the page's real script against the real Worker; at the parent of 93ebf65 with only the test added it fails 2 of 3 (the cookie-ended reload and the no-overwrite case; the live-cookie case passed before too, as expected), and passes 3 of 3 at HEAD with `tests/nuvio-tv-config-query-key.test.mjs` (5/5). No test was changed or loosened. `bash verify.sh -q` passes, same as the Baseline, but the browser tests were SKIPPED (Playwright cannot be imported here). **What is still wrong:** the repair works only with `FF_SESSIONS=1`. With the flag off, `/api/session` does not sign in, so the launcher always shows "Could not load your TV setup" and cannot save, where before 8e88c86 it worked through the key in the address. It now fails safely (no data loss), but the page is unusable. The production setting is still not confirmed: `wrangler.toml [vars]` leaves the flag commented out (only staging sets it), OPERATIONS.md:82 still says "Leave unset", RELEASES.md:908 says "still off", and its rollback for sessions ("delete `FF_SESSIONS` ... and deploy") would now take the TV Launcher down with it. Next step, either: give the launcher a key-carrying read that works without sessions and without the address (for example a POST read action on `/api/nuvio-tv/config` with the key in the body, the way its save already authenticates), with a test that loads the config with `FF_SESSIONS` off; or, as an owner decision, ship this only once `FF_SESSIONS=1` is live and add that dependency to OPERATIONS.md and to the sessions rollback note in RELEASES.md. One small wording point for the same pass: a 500 or other non-401 failure shows "Sign in again, then reload", which is the wrong advice for a server error.

### SEC-04 Deleting an account leaves its username and list names in the search index
- Severity: Low
- Status: Proven
- File:line: purge job `src/jobs/51_account-purge.js:129-140` (`runAccountPurge` -> `purgeCreatorData` -> `purgeAccountRowsById`); the only account-wide index delete is in `src/data/34_lists-v2-bridge.js:851-859` (`listsV2PurgeAccount`, which looks the account up by username first and returns if it finds none). Exact reason it is skipped on this path not pinned down (time); the leftover itself is proven.
- What is wrong: after `DELETE /api/me` and the `account.purge` job, the `lists` rows are gone but the `lists_fts2` full-text index still holds a row with the deleted user's username and their list's name. Search does not return it (the join to `lists` finds nothing), so it is not visible, but the personal data was not deleted. Also left: the user's support/feedback thread (`feedback` table and `feedback:<id>` KV, with username and message) and a `jobs` row whose payload names the user. Those two may be deliberate retention; they are not mentioned to the user.
- Impact: incomplete erasure ("delete my account" does not delete everything). Matters for privacy requests (GDPR-style). No exposure path found.
- Proof: `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s03/delete_account.mjs` (real routes, then queue drained and a scheduled tick run; every KV key and every D1 column searched for the username / account id):
  ```
  DELETE /api/me               202 {"ok":true,"deleting":true,"id":2}
  [AccountPurge] account 1 removed (1 lists, 24 keys).
  KV keys still named after the user: [ 'creatordeleted:zedpurgeme' ]        <- tombstone, intended
  KV values still mentioning the user: [ 'feedback:1794311444050:jFQ5EcaIogH3' ]
  D1 main.feedback: body_json~username:1
  D1 main.lists_fts2: owner_name~username:1
  D1 main.jobs: account_id=1:1, payload_json~username:1
  lists_fts2_content rows: [{"id":1,"c0":"Mine","c1":null,"c2":"zedpurgeme"}]
  lists rows left: 0
  ```
- Recommended fix: delete `lists_fts2` rows by `rowid IN (SELECT id FROM lists WHERE owner_account_id = ?)` inside `purgeAccountRowsById` (by id, before the lists go), and decide/document whether feedback threads are kept or deleted on account deletion. Effort: S.

**Verification.** 2026-11-10, independent review: **partially fixed**. Read a1ecc1f and 5997fe0. The code is right. With a `lists_fts2` row seeded by hand, the purge removes it, and with the new DELETE disabled the row stays. Support threads are deleted with the account, another account's thread is kept, and putting the old detach call back fails both `account-purge` and `support-history`. **What is still wrong:** the new assertion `search index keeps no username` proves nothing. `populated()` in `tests/account-purge.test.mjs` never creates a `lists_fts2` row (`lists_fts2_content` is empty before the purge), so the test passes with the fts DELETE disabled (mutation run: 7 of 7 pass). Fix: seed an fts row for the account's list (or create the list through a route that indexes it), and assert it exists before the purge. Not addressed and not mentioned to users: the `jobs` row whose payload names the user (the finding left open whether that is deliberate retention). Status set back to `open`.

**Verification (second independent review, 2026-11-10): verified fixed.** Read 1ffc61e (test only; the purge code was already right). `populated()` now creates a list of the account's own with its `lists_fts2` row and asserts the row exists before the purge. Mutation run in a scratch worktree: with the purge's `DELETE FROM lists_fts2 ...` replaced by a no-op and the Worker rebuilt, `tests/account-purge.test.mjs` goes 4 pass / 3 fail (the two purge paths and the retry test); restored, `account-purge` + `support-history` pass 23 of 23. Support threads are deleted with the account and another person's thread stays (asserted). Left as it was, and outside the recommended fix: the `jobs` row whose payload names the user is still kept; if that is not deliberate retention, it is a separate small item.

### SEC-05 The anonymous feedback limit (20 per IP per day) is a racy KV counter: parallel requests bypass it
- Severity: Low
- Status: Proven
- File:line: `src/api/77_my-lists-history-and-feedback-routes.js:524-528` (read), `:673` and `:612` (write, after the message is stored)
- What is wrong: the limit reads `feedbackrate:<ip>:<day>` from KV, compares, stores the message, then writes count+1. Requests sent at the same time all read the same old count. In production it is weaker still, because KV reads are cached at the edge for up to a minute (the code's own P7-3 comment in `02_http-and-creator-utils.js:3115-3121` explains why every other limit moved to the D1 `rate_counters` primitive; this one was not moved). Also: when the limit IS hit, the answer is HTTP 200 with `ok:false` (line 528), not 429.
- Impact: one person can flood the developer's support inbox (and D1/KV storage) with unlimited anonymous messages. Nuisance / cost, no data exposure.
- Proof: `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s03/feedback_race.mjs`
  ```
  sequential: 100 anonymous messages from one IP -> accepted 20, feedback rows stored 20
  parallel: 100 anonymous messages from one IP -> accepted 100, feedback rows stored 100
  ```
- Recommended fix: use the existing `consumeRateLimit(env, ctx, "feedback", ip, 20, 86400)` (D1, atomic) before storing, and answer 429. Effort: S.

**Verification.** 2026-11-14, independent review: **verified fixed**. Read cc18207. The KV `feedbackrate:` read and both KV writes are gone (no other use left in `src/` or `tests/`); `apiFeedback` now spends the atomic D1 `consumeRateLimit(env, ctx, "feedback", ip, 20, 86400)` before anything is stored and answers 429 with the same "tomorrow" message. The bucket name does not collide (`feedbackthreads`, `feedbackdelete` are separate). The new parallel test fails on the parent ("accepted 60 of 60") and passes on HEAD; the existing sequential 20-a-day test was not changed. Own probes: 25 empty messages (400, refused before the limit) do not use up the budget; two addresses sending 15 each in parallel all get through; no client IP answers 400. The client (`16_client-row-core.js:3161,3207`) shows `data.error` whatever the status, so the 429 still shows the message. Behaviour change worth knowing: a request that passes validation but then fails (e.g. a reply to a thread that does not exist) now counts toward the 20; the old code also counted those, so this is not new.

### SEC-06 Unauthenticated endpoints that write storage on every call have no rate limit (/api/nuvio-tv/device/code, /api/nuvio-tv/history)
- Severity: Low
- Status: Proven
- File:line: `src/api/69_creator-api-sync-routes.js:778-806` (three KV writes per call, no limit), `src/api/25_api-catalog-routes.js:1284-1317` (history write: KV put + D1 + activity DB, no limit)
- What is wrong: both routes are public, CSRF-exempt and CORS-open, and neither calls `consumeRateLimit`. `device/code` writes 3 KV keys (10-minute TTL) per request; the history route writes the full tracking record to KV and D1 per request.
- Impact: a script can burn the Worker's KV write quota (KV writes are the scarcest billed resource; once exhausted, every save on the site fails for the rest of the day) and, combined with SEC-01, rewrite a user's history at full speed.
- Proof: `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s03/abuse_limits.mjs` (same IP each time; for comparison account creation is limited):
  ```
  create account x40 (one IP)                  {"200":1,"429":39}
  nuvio-tv/device/code x40 (one IP)            {"200":40}
  nuvio-tv/history x40 (one IP)                {"200":40}
  ```
- Recommended fix: add `consumeRateLimit` per IP to both (e.g. 10/min for device codes). Effort: S.

**Verification.** 2026-11-14, independent review: **verified fixed**. Read 6cc6efd. `handleNuvioTvDeviceCode` (69_:784) spends `tvdevicecode` 10/min and `handleNuvioTvHistoryRoute` (25_:1301) spends `tvhistory` 120/min, both before any KV/D1 write and before body parsing, with a CORS 429. The history handler serves both `/history` and `/history/remove`, so both are covered. The other public Nuvio TV device route, `device/poll`, only reads; `device/claim` needs the Account Key. The two new tests fail on the parent (2 of 2) and pass on HEAD. Own probes: 40 parallel device-code requests from one address give 10 x 200 and 30 x 429 (atomic, not just sequential); another address is unaffected; 130 parallel `/history/remove` calls give 120 then 10 x 429; the 429 carries `Access-Control-Allow-Origin: *`; a preflight `OPTIONS` is not limited. A request without `CF-Connecting-IP` is refused, as every other limiter here does.

## Unproven suspicions   (not counted)
- `/api/nuvio-tv/collections/<username>` and the schedule routes (`/api/nuvio-tv/schedule/`, `/schedules/`) are public and take a username via the same `resolveNuvioTvTargetData`; they probably expose the account's custom collections / channels the way `/api/nuvio-tv/sync/<username>` does (SEC-01 proof shows the sync one answers 200). Not walked one by one.
- `/api/nuvio-tv/config` POST changes the TV lineup, is exempt from the CSRF check (whole `/api/nuvio-tv/` prefix, `02_:474`) and accepts the session cookie. The session cookie is `SameSite=Lax`, which stops cross-site POSTs in current browsers, so I could not turn it into an attack; it rests on the cookie attribute alone.
- The old stateless admin cookie (HMAC of its own expiry, `src/admin/03_admin.js:1640-1656`) is still accepted alongside session rows, so "revoke all admin sessions" does not end a cookie issued that way (only when D1 lacked migration 0018 at sign-in). Expires within 7 days.
- Feedback body size: a 30 MB JSON body was read and parsed before the 4,000-character check (`misc_checks.mjs`), i.e. no early body cap on that route. Workers cap requests at 100 MB, so impact is CPU/memory only.
- Accounts deleted are still in the encrypted daily D1/KV backups for 30 days (`.github/workflows/d1-backup.yml`, retention-days: 30). Normal practice; worth stating in the privacy notice.

## Checked and rejected  (suspected, turned out handled)
- Admin routes without `isAdminRequest`: none. Walk shows all 48 refuse anonymous and signed-in-user calls; `/admin/api/installs/*` checks at `src/api/27_installs.js:749`.
- Forged Cloudflare Access header: `adminAccessIdentity` verifies the RS256 signature against the team's certs, `exp`, `nbf`, `iss`, `aud`, and an optional email allowlist (`src/admin/03_admin.js:1763-1815`).
- IP spoofing for rate limits: only `CF-Connecting-IP` is read (`02_:3098-3111`); no `X-Forwarded-For` anywhere in `src/`. A forged XFF did not change the bucket (`abuse_limits.mjs`: 10/10 refused 429).
- SQL injection: every interpolated fragment is a constant or a generated `?` list (e.g. `07_:3064` LIKE uses bound `%q%`).
- Stored XSS: payloads in display name, list name, description, item titles and feedback rendered as text on the list page, creator page and all admin tabs; no injected nodes, no dialog, no CSP violation (screenshots `xss_listpage.png`, `xss_admin_*.png` in scratch). CSP is nonce-only for scripts, so even a missed escape would not execute.
- Prototype pollution: raw `"__proto__"` / `constructor.prototype` bodies on sync/save, save-presets, save-channels, /api/save, /api/feedback left `Object.prototype` clean.
- SSRF/open redirect via `poster=`: blocked by `isAllowedPosterUrl` (https + host allowlist, `25_:67-77`); `/api/channel-logo` pins the host and validates the path.
- IDOR on installs and v2 lists: every read/write filters on `account_id` / `isOwner` (`27_installs.js` queries; `31_lists-api.js:291-326`). User B got 404 on A's install for GET, PATCH, DELETE.
- Feedback threads by name: requires the account key (`77_:741-747`); thread ids are 72-bit CSPRNG capabilities, rate limited.
- Scrobble webhook: only the revocable hashed `?st=` token is accepted; key/config forms answer 410 (`64_:157-181`).
- OAuth callbacks: state cookie compared in constant time (`75_:596`); tokens go in the URL fragment, or server-side when signed in.
- Session lifecycle: sign-out ends the session at once; key reset ends all sessions and the old key (`session_checks.mjs`). Cookies are `HttpOnly; Secure; SameSite=Lax` (user) and `SameSite=Strict` (admin).
- Hardcoded secrets: none in tracked files or reachable history; the one `sk_live_` hit is a deliberately fake string in a redaction test (`tests/worker.test.mjs`, commit f910ed0).
- Public cron/debug/migration endpoints: none outside `/admin/api/*`.

## Done well (do not change)
- Account Keys stored as salted PBKDF2 hashes; session and admin tokens stored only as SHA-256; constant-time compares, including the admin key length (`timingSafeEqualSecret`).
- One CSRF gate and one security-header/CSP boundary for every response; nonce-only `script-src`, `frame-ancestors 'self'`, `form-action 'self'`, HSTS, `no-store` forced on private paths.
- Atomic D1 rate counters; PBKDF2 work bounded per IP before verification; requests with no `CF-Connecting-IP` refused.
- Admin: Access JWT properly verified, revocable session rows, audit log of every mutating admin request at the single gate.
- Webhook credential moved off the Account Key to a revocable, hashed scrobble token; keys refused in URLs on most routes.
- CI actions pinned by commit SHA; backups encrypted before upload.

## Not audited and why
- Real Cloudflare behaviour (WAF rules, Access config, KV edge caching, real D1): local harness only.
- Client-side DOM XSS across all ~300 `innerHTML` sinks: sampled through the browser only for the list page, creator page and admin tabs; the Channel builder and Custom List builder were not driven with payloads.
- Dependency vulnerabilities: there is no `package.json`; the Worker has no npm runtime dependencies. CI installs pinned `acorn`, `eslint-scope`, `playwright` for tests only; `npm audit` not run (no manifest, no network).
- Full git history: the clone is shallow (301 commits), so secrets removed before that point could not be checked.
- Provider-token handling inside `sealSyncKeys`/`openSyncKeys` and connection encryption (28_connections.js): read only in passing.
