# Releases: going live one phase at a time

Before Release 1, the live site, mylistsaddon.com, ran the public repository, [Br0ck25/My-Lists](https://github.com/Br0ck25/My-Lists), at `b9c0a95`.

**Status**
- **Release 1** went live on 2026-09-29. The owner reports everything working.
- **Release 2** went live on 2026-09-29. The owner reports no issues.
- **Release 3** went live on 2026-09-29. Migrate Accounts reported: *695 accounts in table (695 D1, 658 KV, union 695). Reconciled ✓*.
- **Release 4** is live, and the list copy finished with 698 accounts and none failed (results under Release 4).
- **`FF_V2_LISTS_READ`** is on (2026-09-30). The owner reports everything looks the same.
- **Release 5** is live, and the history copy finished: 698 accounts, 45,734 plays, none fewer than before (results under Release 5). `FF_EVENT_TRACKING` stays off (see there).
- **Release 6** is being prepared.

The owner decided to release the new version **one phase at a time, straight to the live site**, with no separate test site. Each release waits until the one before it has run cleanly for at least a day.

---

## How the release branch works

`claude/elegant-ride-o7m8fh` holds the release being prepared.

- **Release 1** is `main` as it was at the end of Phase 1 (`31e55d9`), plus the three public-site updates described below.
- **Every later release** merges the next phase's end point from `main` into this branch. Conflicts are resolved and the tests are run again, so the ported updates travel forward with it.
- **Once the last phase is out**, this branch holds everything on `main` plus the ports. It then goes back into `main` through a pull request.

| Release | Phase | Commit on `main` to merge | Database | Dashboard |
|---|---|---|---|---|
| 1 | Phase 1 (+ the Sept 26 ports) | `31e55d9` | `0014` | Analytics Engine binding (optional); delete 3 retired variables |
| 2 | Phase 2 | `3d0638a` | none | none |
| 3 | Phase 3a: accounts and sessions | `56d0154` | `0015` | `/admin` → Migrate Accounts; no secrets yet: `TOKEN_ENCRYPTION_KEY` and `LOOKUP_PEPPER` come with the switches that need them |
| 4 | Phase 3b: new list tables | `188db3e` | `0016` | R2 bucket `BLOBS`; the list copy; switches later |
| 5 | Phase 3c: activity database | `69fda2e` | `0017`, and `A0001` in the new database | a second D1 database `DB_ACTIVITY`; the history copy |
| 6 | Phase 4 | `46a33d6` | none | optional switches (breaker, snapshots, ids) |
| 7 | Phase 5: jobs | `be96c22` | none | two Queues, the consumer, the `JOBS` binding |
| 8 | Phase 6: new interface | `eee71a7` | none | none (the new interface is behind a cookie) |
| 9 | Phase 7 so far ([PR #9](https://github.com/Br0ck25/My-Lists-Addon/pull/9)) | after it merges | per PR | per PR |

Each release gets its own section below when it is prepared, with its steps in plain words.

---

## The public site's updates from 2026-09-26 (ported)

This repository was copied from the public one as it stood on 2026-09-24 (`7963ba0`, public PR #75). Three updates reached the live site after that and were missing here. Deploying without them would have undone them. They are now on this branch, as three commits:

- **`9e8be81`**: shared catalog rows are cached for 5 minutes, not a day (public `23ae4ab` + `8a117c2`, squashed, because the first of the two was a syntax error).
- **`dcdb81e`**: public #76. All catalog rows are live:
  - the Watchlist added from the Lists page is a live row;
  - private Creator lists are re-read live for their proven owner.
- **`b462577`**: public #77. Every list updates live:
  - a local list has a server-side copy under a token (`listlive:`, `POST /api/list-live/save`);
  - a rename reaches the apps;
  - MDBList, Trakt and TMDB lists refresh within 5 to 10 minutes;
  - a private MDBList list is cached under its own key.

Merged with Phase 1:
- `buildConfig()` stays removed. Phase 1 retired the base64 fallback link that #77 had edited.
- The last-good copy stays in the Cache API (Phase 1), with #77's "not for a live list" condition added.
- Two of #77's browser tests were adjusted:
  - adding a custom list is now tested signed in, because D-8 stops a signed-out visitor from adding one;
  - the `buildConfig()` tests went with the function.

**For later releases:** keep these working as the phases merge in. The tests that guard them are `tests/every-list-live.test.mjs`, `tests/every-list-live.client.test.mjs` and `tests/live-rows-stay-live.test.mjs`. Watch Phase 3b in particular: with `FF_V2_LISTS_ONLY`, the old `creatorlist:` KV records stop being written, so the live list read has to come from the new tables.

---

## Rules for every release

1. **Deploy at a quiet time of day** for the site.
2. **Keep the rollback file**: the `worker_entry_combined.js` that is live before the release. Rolling back means pasting it and pressing Deploy. Cloudflare's Deployments tab also lists earlier versions.
3. **Database steps come before the paste.** Migrations only ever add things, so the older code keeps working on the newer database, and rolling back never needs a database change.
4. **Smoke test right after** (the list is under each release).
5. **Watch for 30 minutes**: the Worker's Metrics (errors, CPU time) and Logs.
6. **Wait at least a day** before the next release.
7. **A one-way switch** (`FF_V2_LISTS_ONLY`, `FF_EVENT_TRACKING`) is turned on only when the owner has said so in writing, never as part of a release.

---

## Release 1: Phase 1, plus the Sept 26 ports

**Branch point:** `b462577` on `claude/elegant-ride-o7m8fh`. `bash verify.sh` passes: 1,308 tests passed, 0 failed, 1 skipped.

**Live since 2026-09-29.**

### What visitors will notice

- **Signed out, an install link can carry only the site's public lists:** charts, Discover and curated shelves, storylines, community lists, and public MDBList, Trakt, TMDB and Letterboxd links.
  - These need a free account: custom lists, imports, building channels, the watchlist, history, Continue Watching and Airing Next, and connecting Trakt, MDBList, Simkl or TMDB.
  - The site asks at the moment someone starts one of these.
  - **Every existing install link keeps working unchanged.** Only making a new link, or updating one that holds such rows, asks the person to sign in.
- **Likes and sharing a channel need an account.** Old likes still count (D-9).
- **Old anonymous lists** (from before accounts existed) still open at their links, but are no longer in the directory or search.
- **The configure page and "Import from link"** no longer hand out the provider keys stored in a link.
- **If making an install link fails**, the page says so and offers Try again. It no longer falls back to a long link with everything inside it.

### What does not change

Lists editing live in Stremio and Nuvio (the Sept 26 behavior), catalogs, channels, Continue Watching, and signing in.

### Steps, in order

1. **Check the database is where Release 1 expects it.** On the live site, go to `/admin`, then Maintenance, then **Check schema**. It should say *Up to date — every migration has been applied*. If it lists missing migrations, stop and ask.
2. **Note the time.** Cloudflare keeps 30 days of database history (Time Travel), so the database can be wound back to that minute if it ever had to be.
3. **Apply migration 0014:**
   - Cloudflare dashboard → Storage & Databases → D1 → `my-lists-db` → **Console**;
   - paste the whole of `migrations/0014_add_schema_migrations.sql` and run it;
   - then run `SELECT version FROM schema_migrations ORDER BY version;`, which should list `0001a` through `0014`.
4. **Optional: add the Analytics Engine binding.** Workers & Pages → the My Lists Worker → Settings → Bindings → Add → Analytics Engine, variable name `ANALYTICS`, dataset `mylists_events`. It records per-request counts for later phases, and nothing depends on it.
5. **Delete retired variables if they are there.** Settings → Variables and Secrets: `BULK_RESOLVE_SUBREQUEST_BUDGET`, `DETAILS_BATCH_SUBREQUEST_BUDGET`, `CRON_SUBREQUEST_BUDGET`.
6. **Deploy:** Workers & Pages → the My Lists Worker → **Edit code** → select all → paste Release 1's `worker_entry_combined.js` → **Deploy**.
7. **Smoke test:**
   - `https://mylistsaddon.com/` loads;
   - an existing install's `/{id}/manifest.json` returns JSON;
   - that install's rows load in Stremio or Nuvio, including a custom list;
   - `/lists/public.json` returns lists;
   - sign in on the website;
   - edit a custom list (add or remove an item), and the change shows in Stremio or Nuvio the next time the home screen loads;
   - signed out (a private window), adding a public chart and generating a link works, and adding a custom list asks you to sign in;
   - `/admin` → Maintenance → Check schema says the database is at `0014`.
8. **Watch for 30 minutes**: Metrics and Logs.

### Rollback

Paste the public repository's `worker_entry_combined.js` (the file live before this release) and Deploy. Leave migration 0014 in place: the old code ignores the new table.

---

## Release 2: Phase 2

**Branch point:** `9f7f708` on `claude/elegant-ride-o7m8fh`:
- `59bbb81` merges `main` at `3d0638a` (the end of Phase 2) into Release 1;
- `9f7f708` brings in `dae9ddc` from `main`.

`dae9ddc` is a test-only fix from Phase 3a. The Phase 2 timeout test cancelled the rest of `worker.test.mjs` on Node 22, and it did so on plain `3d0638a` as well.

`bash verify.sh` passes: 1,329 tests passed, 0 failed, 1 skipped. The source files merged without conflicts. The ported live-list code was checked against Phase 2's changes:
- the manifest route still gets the config's owner from `resolveConfig` without `withTracking`;
- every route the ports added sets its own `Cache-Control`, or is a POST.

### What visitors will notice

Almost nothing. This phase is under the hood:
- **Log lines never carry a key, token or Creator Key.** Everything written to the Worker's logs is masked first.
- **API answers are not cached unless they are public.** Personal answers used to be cacheable for an hour unless each route remembered to say otherwise. Public ones (searches, show seasons, the channel directory, Stremio catalogs) still are.
- **A provider that stops answering can no longer hold a request open.** Every outbound call ends after 30 seconds at most.
- **One list of install-link settings**, used by saving, reading and the configure page. The visible fix: opening Configure on an install that uses Better Posters used to show it switched off, and saving from there turned it off. It now shows what the link has.
- **Catalog rows are faster for people with a long watch history.** A row no longer reads the whole history record unless it is built from it.

### Steps, in order

No database update, no new bindings and no new settings this time.

1. **Keep Release 1's file** (`release-1-NEW-worker.js`) as the rollback file.
2. **Deploy:** Workers & Pages → the My Lists Worker → **Edit code** → select all → paste Release 2's `worker_entry_combined.js` → **Deploy**.
3. **Smoke test:**
   - the site loads;
   - an existing install's rows load in Stremio or Nuvio, including a custom list and Continue Watching;
   - sign in on the website;
   - editing a list still shows up in the apps;
   - open an install's **Configure** page from Stremio: its settings (region, Better Posters, badges) match what you had;
   - press **Update Link** there and check the rows still load.
4. **Watch for 30 minutes**: Metrics and Logs. The logs should show `[redacted]` wherever a key would have been.

**Live since 2026-09-29.**

### Rollback

Paste Release 1's file and Deploy. Nothing to undo in the database.

---

## Release 3: Phase 3a (accounts, sessions, install links, connections)

**Branch point:** `c3ef940` on `claude/elegant-ride-o7m8fh`, which merges `main` at `56d0154` (the end of Phase 3a, public PRs #1 and #2 on this repository) into Release 2.

`bash verify.sh` passes: 1,451 tests passed, 0 failed, 1 skipped.

Two conflicts with the ported live-list code, both resolved by keeping both sides:
- **the manifest route** keeps #77's live shelf names and no-store, and gains Phase 3a's after-the-response install move;
- **`tests/client.test.mjs`**: both sides had appended test suites at the end.

### What is switched on for everyone

- **Every write request must come from the site itself** (P3a-5): the same origin, with `Content-Type: application/json`. Every write request in the page and in `/admin` was checked, including #77's `/api/list-live/save`, and all already send this. The exceptions are the scrobble webhooks, the OAuth sign-in round trips, and `/admin` login and logout. A script or tool outside the site that posts to `/api/...` would now get a 403.
- **New accounts get a row in the new `accounts` table**, and so does the account behind a signed-in "Update Link". Nothing reads it yet except the parts that are switched off.
- **Resetting a key signs out every session of that account.** There are no sessions yet, so nothing changes today.

### What stays off

Nothing below runs until its switch or secret is set, and none is set in this release:
- **session sign-in** (`FF_SESSIONS`);
- **install-link management** (`FF_INSTALLS`);
- **moving install-link keys into encrypted storage** (`INSTALL_MIGRATION_PERCENT`, and it also needs `TOKEN_ENCRYPTION_KEY`);
- **provider connections kept on the server** (need a session, and `TOKEN_ENCRYPTION_KEY`);
- **the v2 forgot-username index** (`LOOKUP_PEPPER`).

The code checks for all of these, and without migration 0015 each one says "not available right now" instead of failing. `REQUIRED_SCHEMA_VERSION` stays `0014`, so writes are never paused by this release.

### Steps, in order

1. **Keep Release 2's file** (`release-2-NEW-worker.js`) as the rollback file.
2. **Note the time** (the database can be wound back to it).
3. **Apply migration 0015:**
   - Cloudflare dashboard → Storage & Databases → D1 → `my-lists-db` → **Console**;
   - paste the whole of `migrations/0015_accounts_sessions_installs.sql` and run it;
   - then run `SELECT version FROM schema_migrations ORDER BY version;`, whose last line should be `0015`.
4. **Deploy:** Workers & Pages → the My Lists Worker → **Edit code** → select all → paste Release 3's `worker_entry_combined.js` → **Deploy**.
5. **Smoke test:**
   - the site loads;
   - existing install rows load in Stremio or Nuvio;
   - sign in, edit a list, and the change reaches the apps;
   - generate or update an install link;
   - like a list, then unlike it;
   - `/admin` → Maintenance → **Check schema** says up to date, at `0015`.
6. **Copy the accounts:** `/admin` → Maintenance → **Unified accounts table** → **Migrate Accounts**.
   - It copies every account's name and key hash into the new table. Nothing a visitor sees changes, and it is safe to press again.
   - It reports, for example, *Done — 812 accounts in table (810 D1, 812 KV, union 812). Reconciled ✓*.
   - **Report the whole message.** *Mismatch!* or *Failed* is not an emergency (nothing uses the table yet), but it has to be sorted out before Release 4, whose list copy works account by account from this table. With a very large number of accounts, one press can run into Cloudflare's per-request limits, and the copy would then need to be split into steps.
7. **Watch for 30 minutes**: Metrics and Logs. A burst of 403 "Cross-origin request forbidden" in the logs would mean something outside the site posts to the API; say so.

**Live since 2026-09-29.** Migrate Accounts: 695 accounts, reconciled.

### Rollback

Paste Release 2's file and Deploy. Leave migration 0015 in place: the older code does not know the new tables are there.

---

## Release 4: Phase 3b (the new list tables)

**Branch point:** `f3524c3` on `claude/elegant-ride-o7m8fh`, which merges `main` at `188db3e` (the end of Phase 3b, PR #3) into Release 3.

`bash verify.sh` passes (1,552 tests passed, 0 failed, 1 skipped), and so does the suite with `MLA_TEST_V2_LISTS_READ=1`.

### The one real conflict, and why it mattered

Public #77 (ported in Release 1) had turned `fetchLiveCreatorListItems` into `readLiveCreatorList`:
- it returns the whole record, so the shelf title can follow a rename;
- following #76, it serves a private list to its proven owner.

Phase 3b had taught the old function to read the v2 tables, but for public lists only.

**Merged as:** `readLiveCreatorList` asks the v2 tables first, through a new `listsV2LiveListRecord` (`34_lists-v2-bridge.js`), with the legacy rule:
- a public list goes to anyone;
- a private list goes only to a reader that proved it owns the account.

With `FF_V2_LISTS_ONLY`, nothing live in v2 means nothing live, because the legacy keys are behind.

**Why it mattered:** without this, the day `FF_V2_LISTS_ONLY` went on, an owner's edits to a *private* list would have stopped reaching Stremio and Nuvio, because the legacy keys it would still have been read from stop being written.

**Tests:** `tests/every-list-live-v2.test.mjs` (5) covers private and public lists and a link that only names the account. It also covers an edit and a rename with `FF_V2_LISTS_ONLY`; that test fails without the owner rule in `listsV2LiveListRecord`.

### What changes for everyone once migration 0016 is applied

- **Every change is also written to the new tables:** a list save, delete or reorder, a like, a channel share.
  - Each one is a few extra D1 writes and at most 25 TMDB lookups per save; the rest are kept as "not placed yet" and tried again later.
  - A failure there is logged and never stops the save.
- **Nothing reads the new tables yet.** Visitors see exactly what they see today.

### What stays off

- `FF_V2_LISTS_READ` (read lists from the new tables). **A separate step after this release**, once the copy's results have been checked; it can be turned off again.
- `FF_V2_LISTS_API` (the new list and likes API). Leave it off.
- `FF_V2_LISTS_ONLY` (**one-way**). Weeks later, never as part of a release (`docs/OPERATIONS.md` §11).

### Steps, in order

1. **Keep Release 3's file** (`release-3-NEW-worker.js`) as the rollback file.
2. **Note the time.** This release copies every list into the database, so the rewind point matters more than before.
3. **Apply migration 0016:**
   - Cloudflare dashboard → Storage & Databases → D1 → `my-lists-db` → **Console**;
   - paste the whole of `migrations/0016_lists_v2.sql` and run it;
   - then run `SELECT version FROM schema_migrations ORDER BY version;`, whose last line should be `0016`.
4. **Create the storage bucket:** Cloudflare dashboard → **R2** → **Create bucket** → name `mylists-blobs` → Create. (If R2 asks to be enabled first, enable it: the free allowance is far more than this needs.)
5. **Bind it:** Workers & Pages → the My Lists Worker → Settings → Bindings → **Add** → **R2 bucket**, variable name `BLOBS`, bucket `mylists-blobs`. Do this before step 8: shared channels' episode lists go into it during the copy.
6. **Deploy:** **Edit code** → select all → paste Release 4's `worker_entry_combined.js` → **Deploy**.
7. **Smoke test:**
   - the site loads;
   - existing install rows load in Stremio or Nuvio;
   - sign in, edit a list (add and remove an item), and the change reaches the apps;
   - like and unlike a list;
   - share a channel;
   - `/admin` → Maintenance → **Check schema** says up to date, at `0016`.
8. **Copy the lists:** `/admin` → Maintenance → **Lists v2: copy existing lists** → **Copy lists**.
   - It works in small steps and shows *Copying (...): N of 695 accounts*.
   - **Keep the page open until it says *Done*.** Closing it only pauses; pressing Copy lists again carries on.
9. **Press Check results** and send the whole text it shows. It says:
   - how many lists and items were copied;
   - what could not be carried, with reasons and examples;
   - whether any account failed.
10. **Watch for 30 minutes**: Metrics and Logs. `lists v2 ... failed` lines are worth reporting; saves keep working either way.

**Do not add `FF_V2_LISTS_READ` yet.** The results from step 9 decide when.

### Rollback

Paste Release 3's file and Deploy. Leave migration 0016, the bucket and the copy in place:
- the older code does not know they are there;
- a later *Start over* brings the copy up to date.

### Live: the list copy's results

Reported by the owner:

> Phase: done.
> Accounts: 698 done, 0 in progress, 0 waiting to be copied again, 0 failed.
> Lists: 951 found, 931 copied, 20 unchanged since the last run, 0 copies of deleted lists retired, 1 order entries with no list behind them.
> Items: 42641 in the old lists, 42503 copied, 0.324% not carried: 0 with no usable id, 134 listed twice, 4 on lists copied in an earlier run. 13631 titles TMDB could not place yet (kept, tried again later).
> Likes: 0 shown before, 0 voters copied, 0 kept from the old totals with no voter on record.
> Anonymous lists: 0 found. Likes on outside lists: 92 lists, 54 voters copied.
> Shared channels: 97 found (56 listed in Explore Channels), 97 copied, 0 unreadable. Episode lists: 97 written to R2. Adds: 18 kept from the old totals.
> Most items not carried: #405 33.11%, #158 20.00%, #495 5.56%, #664 0.65%, #316 0.34%, #139 0.10%. Examples from the first: the same show listed twice in one list ("nostalgia": Atomic Betty, BrainRush, Mickey Mouse Clubhouse, ...).

What it means:
- **Nothing was lost.** The 138 items not carried are titles listed twice in the same list: 134 in this run, plus 4 counted on lists copied in an earlier run. v2 keeps each once, so once reads switch, those lists show each repeated title once. Account #405's "nostalgia" list is the one most affected.
- **The 13,631 titles TMDB could not place are only a lookup that has not happened.** Every item is rebuilt from the new tables exactly as it was saved: `legacyItemExtra` keeps whatever the title's row cannot give back, and checks that when it is written. So lists look the same whether a title is matched or not.
- **A stub is upgraded in place** when a later save meets the same title and TMDB answers (up to 25 lookups per save).
- **Known gap, for later:** nothing calls `retryUnresolvedMedia` (`29_media.js`), on this branch or on `main`, so the rest wait for a later save. Only later features need the TMDB match (Phase 5's show schedule, for one). Add a retry job with Release 7 (Phase 5, the jobs queue).

### The switch after Release 4: `FF_V2_LISTS_READ`

Not a code change; a setting. **It can be turned off again at any time without losing anything.** Every change is still written to the old storage as well as the new tables, until `FF_V2_LISTS_ONLY`, which is weeks away.

1. **Let Release 4 run for about a day first.**
2. **Bring the copy up to date:** `/admin` → Maintenance → **Lists v2** → **Start over**, and wait for *Done*.
   - It copies only what changed since the first run.
   - It has to happen before the switch: once reads are on the new tables, Start over leaves finished accounts alone.
   - Then **Check results**: still *0 failed*.
3. **Turn it on:** Workers & Pages → the My Lists Worker → Settings → **Variables and Secrets** → **Add**:
   - Type *Text*;
   - Name `FF_V2_LISTS_READ`;
   - Value `1`;
   - Save, then Deploy if the dashboard asks.
4. **Check** (everything should look exactly as before, except that a title listed twice in one list now shows once):
   - your own lists on the website: the same lists, items and order;
   - a public list page, `/lists/<name>/<list>`;
   - the public directory and search on the website;
   - Explore Channels, and a shared channel link;
   - in Stremio or Nuvio, a custom list row, including a **private** one of your own;
   - add and remove an item in a list, rename it, and check the change reaches the app;
   - like and unlike a list.
5. **If anything looks wrong:** delete the variable (and Deploy). The site reads the old storage again, which never stopped being written. Then report what looked wrong.
6. **Leave it on for at least a few days** before Release 5, and a week or two before `FF_V2_LISTS_ONLY` is even considered (`docs/OPERATIONS.md` §11).

**On since 2026-09-30.** The owner checked the site and reports everything looks good. `FF_V2_LISTS_ONLY` stays off, and is not considered before a week or two with this on.

---

## Release 5: Phase 3c (the activity database: watch history)

**Branch point:** `04003a5` on `claude/elegant-ride-o7m8fh`, which merges `main` at `69fda2e` (the end of Phase 3c, PR #4) into Release 4.
- No conflicts with the ported code.
- `bash verify.sh` passes (1,601 tests passed, 0 failed, 1 skipped), and so does the suite with `MLA_TEST_V2_LISTS_READ=1`.

### What changes for everyone

- **Once an account's history has been copied** (step 8), each new play is also recorded in the activity database (P3c-4), next to where it is recorded today.
  - It is wrapped so that a failure there is logged and never affects tracking.
  - Before the copy, or without the `DB_ACTIVITY` binding, it does nothing.
- **Nothing reads the activity database yet.** Watch History, Continue Watching and Airing Next are served exactly as today.

### What stays off

`FF_EVENT_TRACKING` (P3c-6) serves watch history from the activity database. It is **one-way per account**: once on, an account's old records stop being written (`docs/OPERATIONS.md` §13). Not part of this release, and not before the copy's results have been looked at.

### Steps, in order

1. **Keep Release 4's file** (`release-4-NEW-worker.js`) as the rollback file.
2. **Note the time.**
3. **Apply migration 0017 to the main database:**
   - D1 → `my-lists-db` → **Console**;
   - paste the whole of `migrations/0017_show_schedule.sql` and run it;
   - `SELECT version FROM schema_migrations ORDER BY version;` should end in `0017`.
4. **Create the activity database:** Cloudflare dashboard → Storage & Databases → D1 → **Create** → name `mylists-activity`.
5. **Set it up:**
   - open `mylists-activity` → **Console** (the NEW database's console, not `my-lists-db`'s);
   - paste the whole of `migrations/activity/A0001_activity.sql` and run it;
   - `SELECT version FROM schema_migrations;` there should say `A0001`.
6. **Bind it:** Workers & Pages → the My Lists Worker → Settings → Bindings → **Add** → **D1 database**, variable name `DB_ACTIVITY`, database `mylists-activity`.
7. **Deploy:** **Edit code** → select all → paste Release 5's `worker_entry_combined.js` → **Deploy**.
8. **Smoke test:**
   - the site loads;
   - existing install rows load in Stremio or Nuvio, **including Continue Watching, Watch History and Airing Next**;
   - watch a few minutes of something through an install with Auto-track on, and it appears in Watch History as before;
   - `/admin` → Maintenance → **Check schema** says up to date, at `0017`.
9. **Copy the watch history:** `/admin` → Maintenance → **Activity: copy watch history** → **Copy history**. **Keep the page open until *Done*.** Closing it pauses; Copy history carries on.
10. **Press Check results** and send the whole text.
11. **Watch for 30 minutes**: Metrics and Logs.

**Do not add `FF_EVENT_TRACKING`.**

### Rollback

Paste Release 4's file and Deploy. Leave migration 0017, the activity database, its binding and the copy in place: the older code does not know they are there.

### Live: what happened, and the history copy's results

**A slip, fixed:** `A0001_activity.sql` was first run in the **main** database's console by mistake, then correctly in `mylists-activity`. In the main database it created three empty tables (`watch_events`, `show_progress`, `user_media_state`) that nothing there reads, and it added `A0001` to its `schema_migrations` ledger.

The ledger row was the part that mattered. `readSchemaLedger` takes `MAX(version)`, and `'A0001'` sorts after every `'00NN'`. So the write gate would never again have noticed a main database that is behind.

The owner was given the cleanup, to run in `my-lists-db`'s Console:
- check the three tables are empty;
- `DELETE FROM schema_migrations WHERE version = 'A0001'`;
- drop the three tables;
- check the ledger ends at `0017`.

**Follow-up for a later release:** make `readSchemaLedger` ignore non-numeric versions (`WHERE version GLOB '[0-9]*'`), so the two ledgers can never be confused this way again.

**The copy's results**, as reported by the owner:

> Phase: done. Accounts: 698 done, 0 in progress, 0 waiting, 0 failed.
> History: 45734 entries in KV, 45734 in D1, 1061 in the scrobble queue, 45734 different entries in all. 45734 plays copied; 0 were the same play twice (within ten minutes), 0 had no usable id. 7373 titles TMDB could not place yet (kept, tried again later).
> Shows: 1566 with progress, 516 finished, 95 hidden from Continue Watching, 5 hidden from Airing Next, 24 storyline or movie suggestions kept, 0 in Continue Watching with no history. Movies watched: 12112.
> Plays now in the activity database: 45734. Accounts with fewer plays than their old history: 0.

What it means:
- **Everything was copied.** KV and D1 agreed exactly, and the scrobble queue held nothing they did not.
- **The 7,373 titles TMDB could not place** are the same known gap as the list copy's stubs: nothing calls `retryUnresolvedMedia` yet (see Release 4).

### Why `FF_EVENT_TRACKING` waits

It is one-way for every account it covers. `docs/OPERATIONS.md` §13 lists two differences visitors would see:
- **Watch History would show an episode as "Episode N" with the show's poster**, where today it has the episode's own title and still;
- **the website's list would be capped at the latest 5,000 plays.**

Continue Watching and Airing Next would stay as last worked out until `FF_SHOW_SCHEDULE`, which needs the Phase 5 jobs.

So it waits at least until Release 7 (Phase 5) is live and its shelf comparison (`shelf.shadow`) has run for a week. At that point, decide whether the "Episode N" difference should be fixed first.

Nothing is lost meanwhile: every copied account's new plays are recorded in the activity database as well (P3c-4).
