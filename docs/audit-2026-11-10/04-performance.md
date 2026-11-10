# 04 Performance and scalability
Health grade: (pending)
## Scope covered (files, routes, commands run)
(in progress)
## Proven findings
### PERF-01 Every play (scrobble) re-reads and re-diffs the account's whole watch history
- Severity: Medium (High for heavy accounts; see impact)
- Status: Proven
- File:line: src/data/40_event-tracking.js:139 (`assembleTrackingRecord`, reads the whole history), :258-310 (`saveTrackingRecord`, reads every `watch_events` id and re-checks them), :323 (`eventTrackingEnv`, the wrapper that makes every tracking read/write go through those two); history reader src/data/39_activity-shelves.js:477-490 (`watchHistoryAll`); progress rebuild src/data/37_activity-backfill.js:507 (`rebuildActivityProgress`).
- What is wrong (plain English): the website used to keep an account's whole "watch history" as one big record. When that moved to the activity database, a compatibility layer was added: any code that reads the old record gets the whole history rebuilt from the database, and any code that saves it triggers a full compare of the stored history against the sent one plus a rebuild of all show progress. The play-recording routes (Plex/Jellyfin/Emby webhook, subtitles ping) still read and write the old record, so ONE play of ONE movie causes work proportional to everything the account has ever watched, and all of it is done before the reply is sent.
- Impact: the cost of recording a single play grows linearly with the account's history. A person with 5,000 plays pays ~300 database round trips (~250 ms of pure Worker/SQLite time even with a zero-latency local database; on real D1 each round trip adds network time), and a person with about 18,000 plays goes past the 1,000-internal-calls-per-request ceiling Cloudflare documents for Workers (KV, D1 and other bindings count). The play code catches and logs errors, so past that point plays are likely to be silently dropped (I could not trigger the real Cloudflare ceiling here; the harness does not enforce it, so that last step is an inference, not proven). Typical users (under ~500 plays) are not affected: 30 to 40 statements.
- Proof: script `/tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s04/t8.mjs` (seeds N plays straight into the activity database for one copied account with the production flags FF_EVENT_TRACKING, FF_V2_LISTS_ONLY etc., then sends one Plex webhook play and counts every D1 statement). Run: `node .../s04/t8.mjs 1000 5000 10000 20000 30000`. Output:
```
history=1000  scrobble -> 200  60ms d1stmts=86   d1batches=3 kv=4/3 fetch=4 => approx subrequests=100
history=5000  scrobble -> 200 246ms d1stmts=303  d1batches=3 kv=3/3 fetch=4 => approx subrequests=316
history=10000 scrobble -> 200 391ms d1stmts=580  d1batches=3 kv=3/3 fetch=4 => approx subrequests=593
history=20000 scrobble -> 200 858ms d1stmts=1130 d1batches=3 kv=3/3 fetch=4 => approx subrequests=1143
history=30000 scrobble -> 200 1461ms d1stmts=1680 d1batches=3 kv=3/3 fetch=4 => approx subrequests=1693
```
  A new account with no history does the same play in ~30 statements (t6.mjs `play #1: d1=30+3b`). Where the statements go at 5,000 plays (statement histogram printed by t8.mjs): 168 x `SELECT m.id, m.kind, ... FROM media ...` (title lookups for every history row, three times over), 56 x `SELECT count(*) FROM media WHERE resolved_at IS NULL AND id IN (...)` (src/data/37_activity-backfill.js:644, a leftover of the one-off copy reconciliation, run on every play), 26 x `INSERT OR IGNORE INTO watch_events ... SELECT j.m ...` (src/data/37_activity-backfill.js:444, re-offering already-stored plays). `t8b.mjs` shows all of it finishes BEFORE the HTTP reply (`response after 255ms (d1 stmts at response=305)`), so the webhook caller waits for it; the 4 waitUntil promises are not where the cost is.
- Recommended fix and effort: M. Make the two play routes record the play directly with `recordActivityPlay` (src/data/38_activity-scrobble.js:73, already constant cost: 1 batch) and stop round-tripping through the whole-record shim for them; keep the shim for the website's full-record save only.

### PERF-02 Without the activity database, every play rewrites the account's whole history row by row
- Severity: Low (affects self-hosted installs and accounts not yet copied to the activity database; Medium for them)
- Status: Proven
- File:line: src/core/02_http-and-creator-utils.js:6279 (`saveCreatorTrackingD1`), :6533 (one upsert per history entry), :6581-6585 (writes them in chunks of 80)
- What is wrong (plain English): on the older storage path, saving the tracking record upserts EVERY entry of Watch History (and Continue Watching / Airing Next) instead of only the entry that changed. A scrobble saves the record, so one play writes one database row per play the account ever had, and also rewrites the whole record into KV.
- Impact: D1 "rows written" per play = size of the history (1,000 plays = about 1,000 row writes per play), plus a KV value that grows with it (62,919 bytes at 400 plays, about 157 bytes per play). Hosted accounts that have been copied are on the other path (PERF-01); this path is what self-hosters (wrangler.selfhost.toml) and accounts waiting for the hourly copy use.
- Proof: `NOBACKFILL=1 node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s04/t6.mjs prod 1001` (production flags on, but the account never copied). Output (`+Nb` = number of 80-statement batches):
```
play #1:    d1=26+1b   kvPut=5
play #200:  d1=25+3b   kvPut=5
play #500:  d1=25+7b   kvPut=5      (20.8 ms)
play #1000: d1=25+13b  kvPut=5      (28.0 ms; total run time grows quadratically: 1,500 plays took 41 s)
```
  Capture at play 400 shows `BATCH x80 first=INSERT INTO watch_history (...)` five times plus `PUT creatorsynctracking:alice (62919b)`.
- Recommended fix and effort: M. Only upsert entries whose `watched_at` is newer than the stored stamp, or have scrobbles insert the single new row.

### PERF-03 The home page makes 30 /api/preview calls per visit (7 of them exact duplicates), each costing a D1 write, and a shared IP is locked out after 8 visits a minute
- Severity: Medium
- Status: Proven (counts, duplicates and the 429 lockout); the effect on D1 at very high traffic is an extrapolation
- File:line: src/client/19_client-search-and-likes.js:1171-1219 (`fetchListPreviewOnce`: the cache only stores a finished answer, never the request in flight, and it is keyed per card), :1225 (`fetchListPreviewWithRetry`: retries any failure once); src/api/74_lookup-and-preview-routes.js:155 (`consumeRateLimit(env, ctx, "preview", ip, 240)`); src/core/02_http-and-creator-utils.js:3180-3198 (`d1RateLimitCount`: one D1 write batch per limited request).
- What is wrong (plain English): opening the home page ("/") as an anonymous visitor fires 30 POST /api/preview requests, one per chart card. 7 of them are identical to another call made at the same moment (the same chart is shown in two rows), because the browser-side cache is only filled after an answer arrives. Each call is rate-limited by writing a counter row to D1 before it is answered. All 30 share one budget of 240 per minute per IP.
- Impact: (1) Every home page view costs 30 D1 write batches (2 statements each) even when everything else is cached; 100x traffic means 100x of those on a single D1 database. (2) Because the budget is per IP and one visit spends 30, the 9th visit inside a minute from the same IP gets 30 refusals (HTTP 429, no Retry-After header): offices, schools, mobile carrier NAT and anyone refreshing the page get empty charts. The client then retries each failed card once after 1 s, which spends budget again. (3) On a new Worker instance with cold caches, one visit also caused up to 208 outbound calls (180 to TMDB) in my simulation, because every chart card resolves its own provider calls; the second instance with warm KV made 12.
- Proof: Playwright load of the dev server, `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s04/pw1.js` (38 requests desktop, 32 phone; 30 are /api/preview) and `pw3.js` (bodies saved to preview-bodies.json: 30 requests, 23 distinct url+type pairs; `tmdb:chart:trending`, `popular`, `top_rated`, `new_movies`, `now_playing`, `upcoming` and `trakt:chart:trending` are each requested twice). Cost per call, `node .../s04/t11.mjs`: `preview #2 ... "d1Batch":1,"d1BatchStmts":2` and the SQL `INSERT INTO rate_counters ... ON CONFLICT ... DO UPDATE` for every call, even with zero KV and zero outbound fetches. Lockout, `node .../s04/t12.mjs`:
```
home page view #1 from one IP: 30 previews served, 0 refused with 429
...
home page view #8 from one IP: 30 previews served, 0 refused with 429
home page view #9 from one IP: 0 previews served, 30 refused with 429 (retry-after=null)
home page view #10 from one IP: 0 previews served, 30 refused with 429 (retry-after=null)
```
  Cold-instance fan-out, `node .../s04/t10.mjs`: `cold isolate (empty KV): 30 previews ... kvGet=102 kvPut=62 fetch=208 hosts=[["api.themoviedb.org",180],...]`, `same isolate again: ... fetch=0`, `NEW isolate, KV already warm: ... kvGet=74 fetch=12` (provider answers were stubbed with 20 items each).
- Recommended fix and effort: S for the duplicates (store the in-flight promise in `_listPreviewCache` instead of the finished answer), M for the rest: serve the home charts from one cached GET (the chart snapshots already exist server side, FF_CHART_SNAPSHOTS) instead of 30 POSTs, and do not charge the limiter for charts that are public and cached.

### PERF-04 Every media-server webhook, even events that are ignored, reads and rewrites the same KV key
- Severity: Low
- Status: Proven
- File:line: src/api/64_media-server-scrobble.js:41-44 (called for every payload that names a media-server user), :374-390 (`recordScrobbleSeenUser`: read, set `lastSeen: Date.now()`, write back, no "only if changed" check)
- What is wrong (plain English): Plex, Jellyfin and Emby send a webhook for every start, pause, resume and stop, not just for "finished watching". The code first writes "this media-server user was seen just now" into one KV key per account and only afterwards decides the event is not a play and ignores it. Because the stored time is always "now", the value is always different, so the write always happens.
- Impact: one KV read plus one KV write per webhook event on the same key, plus ~10 D1 reads (token, tombstone, account, filter settings) for an event that is thrown away. Cloudflare KV allows one write per second to the same key, so quick pause/resume bursts from one person can fail some writes (the failure is caught and dropped, so the cost is lost "seen users" entries, not an error). Two media-server users sharing one account can also overwrite each other's entry because the update is read-then-write. At 100x users this is the largest source of avoidable KV writes found.
- Proof: `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s04/t14.mjs`:
```
media.play   200 {"ok":true,"ignored":"Event 'media.play' is not a scrobble/play event."} d1=10+0b kvPut=1 PUT scrobbleseenusers:alice (52b)
media.pause  200 {"ok":true,"ignored":...} d1=10+0b kvPut=1 PUT scrobbleseenusers:alice (52b)
media.resume 200 {"ok":true,"ignored":...} d1=10+0b kvPut=1 PUT scrobbleseenusers:alice (52b)
media.stop   200 {"ok":true,"ignored":...} d1=10+0b kvPut=1 PUT scrobbleseenusers:alice (52b)
```
  and the same play sent four times wrote `scrobbleseenusers:alice` and `creatortrack:alice` four times.
- Recommended fix and effort: S. Skip the write when the user is already in the list and was seen within, say, the last hour; move the call after the "is this a play event" check.

### PERF-05 Public list pages and JSON are not paginated: a 10,000-item list is a 2.7 MB page
- Severity: Low
- Status: Proven
- File:line: src/api/73_public-list-routes.js (public list HTML/JSON route, regex at :12 and :244); limit set by `PUBLISHED_LIST_ITEMS_MAX = 10000` at src/core/00_constants.js:153
- What is wrong (plain English): a published list can hold 10,000 items and its public page and JSON send every item in one response.
- Impact: bandwidth and parse time for anyone who opens or embeds a very large list, and for Cloudflare's 5-minute cache entry (`public, max-age=300`). The database side is fine (4 statements). Typical lists are small.
- Proof: `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s04/t15.mjs`: `N=100 public html: 27KB`, `N=1000: 276KB`, `N=5000: 1389KB`, `N=10000: 2781KB 116ms d1=4`. Saving the same 10,000-item list is cheap and flat (`save 200 411ms d1=21+2b(7st)`), so the item data is stored efficiently; only the read response is unbounded.
- Recommended fix and effort: S. Cap the public page to the first few hundred items with a "next page" link or offset, as the Stremio catalog already does (100 per page).

### PERF-06 Each Stremio/Nuvio request reads the whole install configuration, including every list item, from KV
- Severity: Low (becomes Medium for installs near the 10 MB limit)
- Status: Proven
- File:line: src/api/78_save-and-like-routes.js:285 (saves up to `SAVED_CONFIG_BYTES_MAX` = 10 MB, src/core/00_constants.js:180); the key is built at src/core/04_config-resolution.js:17-20 (`cfg:{id}`) and is read on every manifest, catalog and meta request (KV trace: `GET creatorsync:{id}`, `GET cfg:{id}`)
- What is wrong (plain English): custom lists chosen in the web page are saved inside the install link's configuration as `customlist:v1:` rows with all their items. Opening the manifest, any catalog row, or a meta page re-reads and parses that whole saved configuration, even though a catalog page needs only 100 items of one row.
- Impact: a Stremio home screen asks once per row, so a 20-row install with 4 MB of configuration reads about 78 MB from KV per home-screen load. Measured CPU for the manifest alone is 143 ms at 7.7 MB. Small installs are not affected (785 bytes for a 10-item list).
- Proof: `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s04/t3.mjs 20 3000` and `... 40 3000` (cold Worker instance each time):
```
R=20 N=3000  /<id>/manifest.json 200 70ms  kvGetKB=3917 kvGet=3
             /<id>/catalog/movie/row0.json 200 24ms kvGetKB=3917 kvGet=2 fetch=100
R=40 N=3000  /<id>/manifest.json 200 143ms kvGetKB=7864 kvGet=3
             /<id>/catalog/movie/row0.json 200 47ms kvGetKB=7864 kvGet=2 fetch=100
```
  A catalog row also makes one outbound Cinemeta call per item shown (`fetch=100` for a 100-item page; src/catalog/05_catalog-core.js:2510-2517). That is within the 1,000-call paid limit but would exceed the 50-call free limit.
- Recommended fix and effort: M. Keep list items out of the install configuration (reference the stored list by id, as the account lists already do) or store each row separately so a catalog request reads only its own row.

## Unproven suspicions
## Checked and rejected
## Done well (do not change)
## Not audited and why
