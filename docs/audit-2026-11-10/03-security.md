# 03 Security
Health grade: (pending, see end)

## Scope covered (files, routes, commands run)
(filled in at the end)

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
  ```
- Recommended fix: do not treat a username-keyed config as owner-verified. Either stop serving `creatorsync:<username>` as an install (use the hashed v2 install token, which already carries a "track" scope), or resolve it with `trackOwner`/`installTrackOwner` empty so private shelves and the playback ping require the real install token. Check the Nuvio TV launcher, which builds `/<username>/tv/manifest.json` URLs (`src/api/25_api-catalog-routes.js:1385-1386`), before changing. Effort: M.

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

