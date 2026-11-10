# 10 Product functionality
Health grade: B+ — the main journeys (create account, sign in elsewhere, add rows, install link, manifest and catalogs, reorder/delete lists, backup, restore, delete account) all work end to end; the problems found are small wording/validation slips, not broken features.

## Scope covered (files, routes, commands run)
- Ran the real Worker over HTTP with my own launcher `s10/fx-server.mjs` (ports 8900/8901): same idea as dev/server.mjs but the stubbed fetch returns realistic MDBList, Trakt, TMDB and Cinemeta fixtures, and Trakt/MDBList/Simkl client ids are set so those rows can load.
- Drove the UI with Playwright (Chromium, 1280x900): create account (`j2.cjs`), add catalogs via "+ New Catalog" (`j4.cjs`), generate install link (`j6.cjs`), backup download (`j8.cjs`), restore into a fresh browser (`j9.cjs`).
- HTTP journey (`journey.mjs`, `journey2.mjs`): sign in as a second client, load sync data, save/reorder/delete custom lists, public vs private list pages, delete account, then the old install URL.
- Manifest + catalog + meta + search requests as Stremio would send them (curl, `p1_series.mjs`).
- Handler check (`acts.cjs`, `acts2.cjs`): every one of the 357 `data-act="name"` handler names in `src/**` checked with `typeof window[name]` on the main page and on /admin after admin login. Result: 0 names missing on both; the 66 that are missing on the main page are all admin-page handlers and are defined on /admin.
- Every route in `tests/route-access.json` requested with GET (only to see which pages/static routes exist; POST-only routes correctly answer 404/405).
- Source greps for mock/fake/stub/placeholder/lorem/coming soon/console.log, and for user-visible "show"/"episode" counts.
- Compared README.md claims with code and config.
- A full click-every-button sweep (`sweep.cjs`) was started but timed out at 400 s per page, so it is NOT a result; the static handler check above replaces it. Individual button flows I did click: Create Free Account, + New Catalog, Add Catalog, Generate Install Link, Download Backup File, Upload & Restore File, subnav pills.

## Fix progress

Updated 2026-11-10. Status values: `open`, `fixed (awaiting verification)`, `verified fixed`, `open (partially fixed, ...)`, `regression introduced (...)`. Rows marked in the Verified column were checked by an independent review on 2026-11-10; see each finding's **Verification.** note.

| Finding | Status | Commit | How to verify | Verified |
|---|---|---|---|---|
| PROD-01 | verified fixed | ae33b9f | node --test tests/add-shelf-type-guess.client.test.mjs | 2026-11-10, independent review |
| PROD-02 | regression introduced (see Verification) | 0a7a916 | node --test tests/add-shelf-source-check.test.mjs | 2026-11-10, independent review |
| PROD-03 | verified fixed | ae33b9f | grep -n "raw items" src/client/18_client-copy-and-trakt-export.js prints nothing | 2026-11-10, independent review |
| PROD-04 | verified fixed | ae33b9f | grep -n "few minutes" README.md | 2026-11-10, independent review |

## Proven findings   (ordered by severity)

### PROD-01 Any trakt.tv link silently flips the new catalog's type to "Shows"
- Severity: Low (wrong default, easy to fix by hand, but it hits every Trakt user)
- Status: Proven
- File:line: `src/client/16_client-row-core.js:4038` (`onAddShelfModalLinkInput`)
- What is wrong: while you type a link in "+ New Catalog", the code switches the Content Type dropdown to Shows if the link contains the text `tv` anywhere. The domain `trakt.tv` itself contains `tv`, so every Trakt link (and any slug like `best-tv-moments`) turns the dropdown to Shows, even for a movie list.
- Impact: someone who pastes a Trakt movie list and does not notice the dropdown gets a row that is filed under Series in Stremio/Nuvio/Wako instead of Movies. The list is not empty (see below), it is just in the wrong section.
- Proof: `node /tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s10/j7.cjs` typed four links into the real modal and read the dropdown:
```
https://mdblist.com/lists/bob/best-action -> content type = movie
https://trakt.tv/users/bob/lists/best-action-films -> content type = series
https://letterboxd.com/bob/list/best-action-films/ -> content type = movie
https://www.themoviedb.org/list/8123 -> content type = movie
```
  And the saved row then really lands in Series: `node .../s10/p1_series.mjs` printed `catalogs [ 'series:Best Action Films', 'movie:Movies', 'series:Series' ]`.
- Recommended fix and effort: S. Look at the URL path only (not the host), and match whole words like `/shows`, `type=show`.

**Verification.** 2026-11-10, independent review: **verified fixed**. Read ae33b9f. The new test fails against the parent commit (9 pass, 3 fail). Extra inputs: `trakt.tv/users/bob/lists/x` with no scheme stays Movies, and `/tv/`, `best-tv-shows` and `title_type=tv_series` pick Shows. One edge now goes the other way: an IMDb link with `title_type=tvSeries` (one word) used to pick Shows and now stays Movies. Minor.

### PROD-02 A link the app itself calls "not a supported list source" is still saved as a catalog row and put in the install link
- Severity: Low
- Status: Proven
- File:line: `src/client/16_client-row-core.js:4045-4058` (`submitAddShelfModal` calls `addRow` with no URL check)
- What is wrong: adding `https://example.com/nothing` makes the Live Preview call fail (`POST /api/preview` returns 400 "That URL isn't a supported list source."), but the row is saved anyway, synced, and included in the manifest. There is no message at add time. When the catalog is requested, the Worker sends the whole URL to MDBList as if it were a list slug.
- Impact: a typo or wrong site gives a permanent dead row on the user's TV home screen that they must find and delete; no explanation is shown at the time they add it.
- Proof: `s10/j4.cjs` output: `RESP POST 400 /api/preview {"ok":false,"error":"That URL isn't a supported list source."}` then `ADD Bad URL ...`; `sync/load` then lists `Bad URL|movie|https://example.com/nothing`; the manifest from the install link contains `movie https-example-com-nothing | Bad URL`; the upstream log shows `GET https://mdblist.com/lists/https%3A/example.com/nothing/json/?append_to_response=poster` (`curl localhost:8901/upstream`). (My fixture returns data for any MDBList path, so the real result is an empty row; the fixture is only why the row showed films.)
- Recommended fix and effort: S. Reuse the same source check `/api/preview` uses and show its error in the modal before saving.

**Verification.** 2026-11-10, independent review: **regression introduced**. Read 0a7a916 (and the `creatorApiFetch` change in c5dbd27). The new test fails against the parent, and `validateOnly` uses the same `isAllowedCatalogSourceUrl` check as the preview, with no provider call or limiter charge. **What is now wrong:** Add Catalog now waits for the server check before saving, but the dialog stays open and the button stays enabled while it waits. Before, the dialog closed at once. Probe with the client harness: two clicks on Add Catalog before the check answers add the row twice (`addRow` called 2 times). On a slow connection a double tap makes a duplicate row. Fix: disable `addShelfModalBtn` (or ignore a second submit) until the check has answered, and add a test for it.

### PROD-03 Leftover debug log in the production page
- Severity: Info
- Status: Proven
- File:line: `src/client/18_client-copy-and-trakt-export.js:809`
- What is wrong: `console.log('[MDBList] raw items:', ...)` runs in every user's browser when MDBList history is exported. It is the only plain `console.log` in the client or page sources (grep: `^\s*console\.log\(` over src/client and src/page).
- Impact: harmless noise in the browser console; the owner may want it removed.
- Proof: line quoted above, from `sed -n 809p`.
- Recommended fix and effort: S.

**Verification.** 2026-11-10, independent review: **verified fixed**. Read ae33b9f. The `console.log` is gone, and `grep -rnE '^\s*console\.log\(' src/client src/page` finds nothing.

### PROD-04 README gives two different background-sync intervals
- Severity: Info
- Status: Proven
- File:line: `README.md:59` says the Cron Sync runs "every 6 minutes"; `wrangler.toml:234` says `*/6 * * * *`, but `wrangler.selfhost.toml:45` and the self-hosting steps in the README say `*/5 * * * *`.
- Impact: none functionally (the job code comments say it copes with 5 or 6); only a documentation mismatch.
- Proof: `grep -n crons wrangler*.toml`.
- Recommended fix and effort: S (say "every few minutes").

**Verification.** 2026-11-10, independent review: **verified fixed**. Read ae33b9f. README now says `every few minutes`. The self-hosting step's `*/5 * * * *` matches `wrangler.selfhost.toml`.

## Feature table (README claims vs what ran)
| Feature | Result | Evidence |
|---|---|---|
| Create Creator Key account (MYL-XXXX-XXXX-XXXX) | Working | j2.cjs: key shown, `/api/creator/create` 200 |
| Sign in on a second client with the key | Working | journey.mjs `restore` 200, sync/load returns the config |
| Add MDBList URL row, install link, manifest, catalog | Working | rows in manifest, catalog returns 5 films typed `movie` |
| Add Trakt list URL row | Working (needs TRAKT_CLIENT_ID; without it row says "temporarily unavailable", which is the correct message) | catalog returns 8 items |
| TMDB charts / genre rows, search catalog, meta | Working | `search=matrix` returns The Matrix; meta returns title |
| Generate Install Link | Working | `/api/save` 200 returns id, manifest 200 |
| Custom lists: save, reorder, delete, public vs private | Working | journey2: order changes, deleted slug gone, private list 404 to anonymous |
| Backup download / restore into a fresh browser | Working | backup.json has 11 rows; restore took 8 -> 11 rows |
| Delete account | Working | after delete: sign-in 401, lists 401, public list 404, 24 keys cleared |
| Old install URL after account delete | Partial (by design?) | manifest and catalogs still 200 with the saved config; anonymous installs are separate from the account |
| Trakt/MDBList/Simkl/TMDB sign-in (OAuth) | Not testable offline | `/oauth/start` answers a clean 503 "temporarily unavailable" when keys are unset |
| Channels, Spotlight, Next Up, scrobbler, BetterPosters | Not exercised end to end (see Not audited) | handlers exist |

## Unproven suspicions   (not counted)
- A mixed Trakt list saved under a "movie" row returns shows too (curl on `.../catalog/movie/<id>.json` gave 5 films typed `movie` plus 3 typed `series`). Probably intended (type picks the shelf only), but Stremio may show shows inside a Movies row.
- The auto-created empty list `airing-next` came back with `visibility: public` while `watchlist` is private (journey2 output `airing-next:0:public`). I did not check whether its contents (upcoming episodes of tracked shows) are served on the public list page once filled.
- Signed in with only a Creator Key (no session cookie), the page calls `/api/connections/*/settings` and `/api/me` and gets 401 on every load; looks like harmless console noise, not checked further.

## Checked and rejected  (suspected, turned out handled)
- Missing `data-act` handler names: all 357 exist (see Scope).
- `/api/tmdb/oauth/start` returned 500 while the others return 503: caused by my fixture not returning a request token, not by the app.
- Cross-origin 403 on API calls from scripts: intended guard; I sent an `Origin` header like a browser.
- Account delete without confirmation or with a wrong key: refused (400 "Missing confirmation.", 401).

## Done well (do not change)
- Delete-account purges lists, sync data, public pages and the key lookup (24 KV keys) and refuses without the "DELETE" confirmation.
- Private lists are 404 to anonymous users; public ones are served.
- Backup/restore round trip works including into a brand-new browser.
- Clear, honest messages when a provider is not configured ("temporarily unavailable") instead of a crash.
- Almost no leftover debug code or fake data in `src/**`: the only hits for stub/dummy words are about real "stub" database rows.

## Not audited and why
- Real provider data (live Trakt/MDBList/Simkl/TMDB/OAuth), Plex/Jellyfin scrobbling, BetterPosters: no network and no credentials by rule.
- Channel builder (channels, Spotlight, Next Up, Story Lock), Nuvio TV launcher pairing and Nuvio/Wako-specific sync: only loaded and handler-checked; not driven through full flows.
- Full per-button click sweep of every tab and /admin: attempted but timed out, so no per-button claim is made.
- Wording sweep for "show/episode" on movies: only the count-message greps and the Content Type dropdown were checked; no user-visible case of a movie called a show or episode was found beyond PROD-01's dropdown default.
