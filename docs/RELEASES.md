# Releases: going live one phase at a time

Before Release 1, the live site, mylistsaddon.com, ran the public repository, [Br0ck25/My-Lists](https://github.com/Br0ck25/My-Lists), at `b9c0a95`.

**Status**
- **Release 1** went live on 2026-09-29. The owner reports everything working.
- **Release 2** went live on 2026-09-29. The owner reports no issues.
- **Release 3** went live on 2026-09-29. Migrate Accounts reported: *695 accounts in table (695 D1, 658 KV, union 695). Reconciled ✓*.
- **Release 4** is live, and the list copy finished with 698 accounts and none failed (results under Release 4).
- **`FF_V2_LISTS_READ`** is on (2026-09-30). The owner reports everything looks the same.
- **Release 5** is live, and the history copy finished: 698 accounts, 45,734 plays, none fewer than before (results under Release 5). `FF_EVENT_TRACKING` stays off (see there).
- **Release 6** went live on 2026-09-30. The owner reports it looks good, and asked to carry on without waiting days between releases.
- **Release 7** (as 7b) went live on 2026-09-30, with the queue set up: *Round trip works: picked up after 6.3 s*, and every periodic job running with none failing (under Release 7).
- **Release 8** went live on 2026-09-30. The owner reports everything working, and asked for changes to the new interface and for five older bugs to be fixed: that is Release 9.
- **Release 9** went live on 2026-09-30. The owner found two problems, fixed in Release 9b (prepared, not yet live): the red x on a list card's poster opened the list instead of removing the title, and ticking *Enable media server user filtering* did not stick.
- **Release 9b** went live on 2026-09-30, followed by the sign-in sessions step (steps under Release 9b). The owner reports everything looks good.
- **Release 10** (Phase 7 so far, PR #9) went live on 2026-09-30. The owner does not want Cloudflare Access on `/admin`.
- **Release 11** went live on 2026-10-01 with migration `0020`, after the list copy's and the history copy's *Start over* (results under each). **`FF_V2_LISTS_ONLY` and `FF_EVENT_TRACKING` are both on** (2026-10-01, one-way: never delete either). The owner reports everything correct, and found one problem, fixed in Release 11b: a Search tile could show its poster and a "No poster" box under it.
- **Release 12** (prepared, not yet live; it includes 11b) answers the owner's review of the new interface before it goes to everyone, and fixes New on Streaming titles too new for TMDB (details under Release 12).
- **Release 13** is live: the owner added `FF_PROVIDER_BREAKER`, `FF_CHART_SNAPSHOTS` and `FF_NEW_UI`. It added the `FF_NEW_UI` switch, stronger hashing for recovery answers, and a daily backup that works. The owner dropped one-time recovery codes (D-31).
- **`main` at `a6785d6`** is live (2026-10-02 onward): other assistants finished P7-6 and Phases 8–10 and merged everything into `main`, and the Worker was renamed from `wako` to **`my-lists-addon`**. The owner also added `FF_SCROBBLE_ST_ONLY`. The review of that work (2026-10-04) found the admin counters writing nowhere anyone reads, blank badged posters, and a cleanup guide that would have deleted live data: Release 14 fixes them.
- **`shelf.shadow`** (sent 2026-10-04): last full comparison of 709 accounts, 20.36% different (Continue Watching 836 the same, 206 only in the old, 25 only in the new, 17 shows not known yet; Airing Next 212 / 15 / 22 / 3). Far above the 1% gate: **`FF_SHOW_SCHEDULE` stays off.**
- **Release 14** (prepared 2026-10-04, not yet live) — details under Release 14.

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
| 9 | Five bug fixes and the owner's new-interface changes (this branch only) | none | none | none |
| 10 | Phase 7 so far ([PR #9](https://github.com/Br0ck25/My-Lists-Addon/pull/9), not yet merged into `main`) | `243340a` (the PR's head) | `0018`, `0019` (optional) | none required; Cloudflare Access for `/admin` optional |
| 11 | Watch History from the activity database: episode names, and no 5,000-play cap (this branch only) | none | `0020` | the history copy's *Start over*, then `FF_EVENT_TRACKING` |
| 12 | The owner's review of the new interface, and titles too new for TMDB (this branch only; includes 11b) | none | none | none |
| 13 | `FF_NEW_UI`, recovery answer hashing (P7-4), the backup rewritten (this branch only) | none | none | `FF_PROVIDER_BREAKER`, `FF_CHART_SNAPSHOTS`, `FF_SHOW_SCHEDULE`, `FF_NEW_UI`; GitHub secrets for the backup |

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

---

## Release 6: Phase 4 (providers: one registry, a breaker, chart snapshots, canonical ids)

**Branch point:** `f85eb64` on `claude/elegant-ride-o7m8fh`, which merges `main` at `46a33d6` (the end of Phase 4, PR #5) into Release 5. There were no conflicts.

`bash verify.sh` passes (1,647 tests passed, 0 failed, 1 skipped), and so does the suite with `MLA_TEST_V2_LISTS_READ=1`.

Checked against the ported public-site code:
- the new provider registry still names custom-list rows `custom-list`, which the catalog route's live-list no-store check reads (#77), and still sends them to `fetchCustomListCatalog`;
- #77's list freshness (MDBList 10 minutes, Trakt and TMDB lists 5) and its per-key cache for private MDBList lists are unchanged.

### What changes for everyone

- **Nothing visible.** Every catalog row now finds its fetcher through one registry (P4-1) instead of a chain of `if`s. That is the same behavior, and it is tested source by source.
- **The nightly provider check** (`.github/workflows/provider-live-check.yml`) runs from `main` on GitHub already. It does not depend on this deploy; `docs/OPERATIONS.md` §16 lists its optional repository secrets.

### The switches it brings (all off, each reversible)

| Switch | What it does | Suggested |
|---|---|---|
| `FF_PROVIDER_BREAKER` | After five failures in a row, a provider (TMDB, Trakt, MDBList, ...) is skipped for a minute and rows show their last good copy at once, instead of every row waiting for a timeout (§14) | Turn on a day after this release |
| `FF_CHART_SNAPSHOTS` | Charts come from one shared copy per page, rebuilt every two hours; an empty or failed answer never replaces a good copy (§15) | Turn on a day or two after the breaker |
| `FF_CANONICAL_IDS` | Every title in a Stremio catalog gets an id the apps can open (fixes tiles that open to "not found"). A title served as `tmdb:<n>` before is served under its IMDb id, so Stremio's own library and Continue Watching keep it under the old id (§17) | The owner decides; later, on its own |

### Steps, in order

1. **Keep Release 5's file** (`release-5-NEW-worker.js`) as the rollback file.
2. **Deploy:** Workers & Pages → the My Lists Worker → **Edit code** → select all → paste Release 6's `worker_entry_combined.js` → **Deploy**. There is no database step and no binding.
3. **Smoke test:**
   - the site loads;
   - in Stremio or Nuvio: a chart row, a public MDBList/Trakt/TMDB list row, a custom list row, Continue Watching and a channel all load;
   - on the website: Discover, Search and a list preview load;
   - edit a list, and the change reaches the apps.
4. **Watch for 30 minutes**: Metrics and Logs.

**Live since 2026-09-30.**

### Rollback

Paste Release 5's file and Deploy. Nothing to undo anywhere else.

---

## Release 7: Phase 5 (background jobs), plus two follow-ups

**Branch point:** `fd8f59c` on `claude/elegant-ride-o7m8fh`:
- `e1e9ff9` merges `main` at `be96c22` (the end of Phase 5, PR #6) into Release 6, with no source conflicts;
- `fd8f59c` adds the two follow-ups below.

`bash verify.sh` passes (1,722 tests passed, 0 failed, 1 skipped), and so does the suite with `MLA_TEST_V2_LISTS_READ=1`.

### The two follow-ups (new in this release, not on `main`)

- **`media.retry`** (`55_media-retry.js`), an hourly periodic job. It asks TMDB again about 200 titles the copies could not place (Releases 4 and 5 left 13,631 and 7,373).
  - A title TMDB still does not know waits a week before the next try (`retryUnresolvedMedia`'s new `retryAfterMs`).
  - Nothing called `retryUnresolvedMedia` before.
  - Covered by `tests/media-retry.test.mjs`.
- **The schema ledger ignores the activity database's versions:** `readSchemaLedger` reads `MAX(version)` over numbered versions only. That is the Release 5 slip: `A0001` in the main database would have hidden a main database that is behind. Covered by a test in `worker.test.mjs`.

Both tests fail with their fix taken out.

### What changes for everyone

- **Before the queue is set up** (step 4), a cron tick does the cron's work itself, exactly as before. It also runs the new periodic jobs that are due, a few a tick:
  - `show.watchers` and `show.refresh`, which keep the show schedule current;
  - `shelf.shadow`, which only compares;
  - `recs.build` and `rollup.daily`, which only write tables nothing reads yet;
  - `token.refresh`, which does nothing without stored connections;
  - `chart.refresh` and `channel.presets`;
  - `media.retry`.

  They spend some TMDB and TVmaze calls in the background. Nothing a visitor sees depends on them yet.
- **After the queue is set up**, the same work runs as jobs on the queue, and a tick only hands them out.
  - A job the queue does not pick up within 10 minutes is run by the tick itself, so a broken queue slows the work but never stops it.
  - **Better Posters** (the `BLOBS` bucket is bound since Release 4) move to R2: they are fetched by `poster.fetch` jobs, and no request waits on btttr.cc. Posters already in KV keep being served and move over as they are used.
- **Imports through `/api/imports`, `DELETE /api/me`, and connections** need a session, so they stay dormant while `FF_SESSIONS` is off.
- **A personal row whose provider connection needs signing in again** shows a "Reconnect" tile instead of an empty row. That can only happen once connections are kept on the server.

### What stays off

`FF_MATERIALIZER` (P5-11): one build of a home screen per hour for installs with "Remove duplicate items across lists". It is reversible; turn it on later, on its own. The `FF_SHOW_SCHEDULE` shelves need `shelf.shadow`'s week of comparisons first.

### Steps, in order

1. **Keep Release 6's file** (`release-6-NEW-worker.js`) as the rollback file.
2. **Deploy:** Workers & Pages → the My Lists Worker → **Edit code** → select all → paste Release 7's `worker_entry_combined.js` → **Deploy**. There is no database step.
3. **Smoke test:**
   - the site loads;
   - in Stremio or Nuvio: a chart row, a custom list, Continue Watching and Airing Next load;
   - Better Posters show where they are on;
   - edit a list, and the change reaches the apps.
4. **Set up the queue** (`docs/OPERATIONS.md` §18):
   1. Storage & Databases → **Queues** → **Create queue** → `mylists-jobs`.
   2. Create a second queue, `mylists-jobs-dlq`.
   3. Open `mylists-jobs` → **Settings** → **Consumers** → **Add consumer**:
      - consumer: the My Lists Worker;
      - batch size `25`;
      - max retries `5`;
      - max wait time `5` seconds;
      - dead letter queue `mylists-jobs-dlq`.

      Leave `mylists-jobs-dlq` without a consumer.
   4. The My Lists Worker → Settings → Bindings → **Add** → **Queue**, variable name `JOBS`, queue `mylists-jobs`.
5. **Check it:**
   - `/admin` → Maintenance → **Background jobs queue** should say *bound*;
   - press **Send a test job**, and within a few seconds it should say *Round trip works*. If it says the job was not picked up, step 4.3 is missing or names another Worker.
6. **After about 15 minutes:** press **Check jobs**. Every job should show a recent last run, and none should keep failing.
7. **Optional:** Settings → Triggers → Cron: `*/5 * * * *` (the current `*/6` works the same).
8. **Watch for 30 minutes**: Metrics and Logs, including **Queues → `mylists-jobs` → Metrics** (the backlog should not keep growing). `[Jobs] <type> failed` lines in the logs say which job.

### Rollback

1. Delete the `JOBS` binding **first**, so jobs do not pile up with no consumer.
2. Paste Release 6's file and Deploy.

The queues can stay; jobs already waiting expire after 4 days.

### Release 7b: the test-job button fixed

**What happened:** with Release 7 deployed to the Worker (named `wako`), the queues created, `wako` as the consumer and `JOBS` bound, **Send a test job** said *Sent, but not picked up within a minute*.

**The cause was the button, not the setup:**
- the consumer wrote its answer to KV in another data center;
- the admin page's first read of the not-yet-written key was cached there as missing for up to a minute, which is the page's whole wait.

**Commit `0d4e20f`:** the answer is now written to D1's `jobs` table as well (type `jobs.ping`), and read from there first. Tests in `tests/jobs.test.mjs`.

**Steps:**
1. Paste `release-7b-NEW-worker.js` and Deploy.
2. Press **Send a test job** again. It should say *Round trip works*.
3. Whatever the button says, two other checks show whether the queue works:
   - **Queues → `mylists-jobs` → Metrics** shows messages delivered and acknowledged, with no growing backlog;
   - about 15 minutes after the binding, `/admin` → **Check jobs** shows recent runs.
4. A Worker log line `[Jobs] <type> was sent to the queue and not picked up within 10 minutes; running it here` means the consumer is not receiving.

### Live: the queue's first report

Reported by the owner, 2026-09-30:

> Send a test job — Round trip works: picked up after 6.3 s.
> Check jobs — The queue does the work.
> cron.episodes 28.4 s, cron.airing-next 6.8 s, nos.sweep 0.2 s, cron.charts 45.7 s, cron.better-posters 1.7 s, cron.housekeeping 0.3 s (2 runs each);
> show.watchers, show.refresh, shelf.shadow 11.2 s, chart.refresh, token.refresh, channel.presets, recs.build, rollup.daily, media.retry 4.5 s (1 run each).
> Every job: last success at its last run.

---

## Release 8: Phase 6 (the new interface, and every page's buttons rewired)

**Branch point:** `f58bf6d` on `claude/elegant-ride-o7m8fh`, which merges `main` at `eee71a7` (the end of Phase 6, PRs #7 and #8) into Release 7b. There were no source conflicts. With this, **the branch holds everything on `main`**, plus the public-site ports and this branch's fixes.

`bash verify.sh` passes (1,884 tests passed, 0 failed, 1 skipped), and so does the suite with `MLA_TEST_V2_LISTS_READ=1`. The page checks find no inline handler and no `alert()` in any page, the ported live-list code included.

### What changes for everyone

- **Every button, box and menu on the website and in `/admin` is wired differently** (P6-8, P6-10): one listener per page instead of a line of code in each control. It should look and behave the same.
  - If a control ever does nothing, the browser console says `Action failed: <name>` (the site) or `Admin action not found: <name>` (`/admin`).
- **No more browser pop-ups.** Messages are the site's own toast (bottom centre) and its own yes/no dialog. `/admin` keeps ten yes/no `confirm()` prompts for now.
- **Provider keys and tokens are no longer re-saved in the browser.**
  - A signed-in person's keys come back from their account.
  - Someone signed out who pastes a key keeps it for that visit only. Since Release 1 a signed-out install cannot use one anyway.
- **Lists that live only in one browser say so** in the new interface, with *Save to an account* and *Export* (P6-9). The classic page is unchanged.

### What only you see (the new interface, per browser)

Open `https://mylistsaddon.com/?ff_new_ui=1` in a browser to turn it on there; `?ff_new_ui=0` turns it off (§20). It covers:
- Catalogs with the paste-first home-screen editor;
- Lists as cards;
- Explore;
- channel templates;
- Settings;
- imports.

Settings' account, devices, connections and install-link cards, and imports, work through a sign-in session, which is **`FF_SESSIONS`, still off**. Until then they say you are not signed in. That is expected, and it is the next step after this release.

### Steps, in order

1. **Keep Release 7b's file** (`release-7b-NEW-worker.js`) as the rollback file.
2. **Deploy:** **Edit code** → select all → paste Release 8's `worker_entry_combined.js` → **Deploy**. There is no database step and no binding.
3. **Smoke test the classic site**, clicking as much as you can:
   - **Catalogs:** add a chart, drag to reorder, remove a row and Undo, **Update Link**;
   - **Lists:** open a list, add and remove an item, rename it;
   - **Channels:** add a storyline;
   - **Discover** and **Search:** search, like and unlike;
   - **Settings:** the Connect buttons open their sign-in pages; Backups → Export;
   - a message should appear as the site's own toast or dialog, never a browser pop-up;
   - in Stremio or Nuvio, rows load, and a list edit reaches them.
4. **Smoke test `/admin`:** Maintenance → **Check schema**, **Check jobs**, **Send a test job**; the Creator Accounts filter box.
5. **Try the new interface:** `/?ff_new_ui=1`, then walk Catalogs, Lists, Channels → Explore and templates, Discover, Search. Settings' account cards will say you are not signed in, which is expected. Turn it off with `/?ff_new_ui=0` if you want the classic page back.
6. **Watch for 30 minutes**: Metrics and Logs.

### Rollback

Paste Release 7b's file and Deploy. Nothing to undo anywhere else. The new-interface cookie is harmless on the older code, which ignores it.

---

## Release 9: five bug fixes, and the new-interface changes the owner asked for

**Branch point:** this branch after Release 8 (`1cc82a5`). Nothing here comes from `main`; these commits are this branch's own and go back to `main` with the rest of it:
- `486d714`: removed recent plays stay removed; the filtering checkbox keeps its setting;
- `723ef95`: Better Posters on Search's movie and TV results;
- `b5aed82`: liking a My Lists Addon list from a Discover card or a list's page;
- `e4c5958`: Plex episode plays get the show's poster and next episode;
- the new-interface changes (the last commit of the release).

The five bugs were all on the live site before any phase went out.

`bash verify.sh` passes (1,900 tests: 1,899 passed, 0 failed, 1 skipped), and so does the suite with `MLA_TEST_V2_LISTS_READ=1`. Each fix has a test that fails on the code before it.

### What changes for everyone

- **Removing a recent play from Continue Watching or Watch History now sticks.**
  - The cause: the server keeps a small backup copy of the last 20 plays from Stremio, Nuvio and Plex, for the minute or so before the main record can be read everywhere. That copy was merged back in on every load and every save, whatever the main record said. So anything among the last 20 plays came back after you removed it.
  - Now the backup is used only when the main record is older than it, which is the case it exists for.
  - A play recorded after the page last loaded is still kept when you remove something else, because the page never showed it to you.
- **"Enable media server user filtering" stays unticked** when you untick it. The box was drawn ticked whenever any names were saved. The server already followed your choice, so filtering really was off; only the box was wrong.
- **Search → Movies and Shows show Better Posters** when Better Posters is on. Search results carry only TMDB ids, and the step that finds the IMDb id Better Posters needs was never run on them.
- **The heart on a My Lists Addon list works everywhere.** Discover's recommended-list cards and a list's own page sent this site's lists to the like for MDBList/Trakt/TMDB links, which refused them ("That URL can't be liked"). They now use this site's own like, as Search's heart already did.
- **Plex episodes get the show's poster, and the next episode in Continue Watching.**
  - For an episode, Plex sends the episode's own IMDb id and names the show only by a Plex id. The episode's id was used as if it were the show's, so TMDB found no show: no poster and no next episode.
  - The show is now found from the episode's id through TMDB.
  - Episodes already recorded this way keep their missing poster. Remove them from Watch History if they bother you; new plays are right.
- The list search now also says when each of this site's lists was made and how many people added it. The new sort buttons use this.

### What only you see (the new interface)

- **Catalogs:**
  - the **Add to your home screen** panel is gone (the paste box, Check links, and the starter-pack button);
  - **Hide titles already shown in rows above** now sits just above **Daily Randomizer**, below the rows it applies to;
  - a first-time visitor to the new interface gets the same eight starter rows the classic page gives, because the starter-pack button went with that panel.
- **The tab names** (Catalogs, Lists, Channels, Discover, Search, Settings) no longer have a line under them. They are links, and nothing had switched off a link's underline.
- **The install bar across the top is gone.** Your install link is made where it always was: **Generate Install Link** (or **Update Add-on**) at the bottom of Catalogs, or **Settings → Install links**.
- **Lists:** the **Your lists** section is gone.
- **Discover:** the **Explore** section is gone.
- **Search → Lists** has small buttons instead:
  - **All sources, My Lists community, MDBList, Trakt, TMDB**;
  - **Most liked, Newest, Most added**.
  - With no sort button pressed, results are in best-match order, as before. Pressing the pressed button again goes back to that.
  - With nothing typed, a source button shows that source's popular lists. TMDB has no list directory, so it can only be searched.
  - Newest and Most added know only this site's lists; lists from other sources are listed after them.
- **Lists → Import:** **Import a file** is now below **Import list from a link**.

The classic page is unchanged, apart from the five fixes.

### Steps, in order

1. **Keep Release 8's file** (`release-8-NEW-worker.js`) as the rollback file.
2. **Deploy:** **Edit code** → select all → paste Release 9's `worker_entry_combined.js` → **Deploy**. There is no database step and no binding.
3. **Check the fixes:**
   - play something in Stremio, Nuvio or Plex, then remove it from Watch History (and a show from Continue Watching). Reload the page: it stays gone. Reload again a minute later: still gone;
   - Settings → untick **Enable media server user filtering**, reload: still unticked;
   - with Better Posters on, Search → Movies and Shows: Better Posters;
   - like and unlike a My Lists Addon list from Discover's recommended cards and from a list's page;
   - play an episode in Plex: a poster in Watch History, and the next episode in Continue Watching.
4. **Walk the new interface** (`/?ff_new_ui=1`) through the changes listed above.
5. **Watch for 30 minutes**: Metrics and Logs.

### Rollback

Paste Release 8's file and Deploy. Nothing to undo anywhere else: the older code simply ignores the new stamp on the backup copy, and goes back to merging it in every time.

### Release 9b: two fixes the owner found on Release 9

- **The red x on a poster in Your Custom Lists** (Watch History, Continue Watching, Watchlist, Airing Next) opened the list's See all page instead of removing the title. A Release 8 regression:
  - Release 8 moved every button onto one listener for the whole page, which hears a click last.
  - The strip of posters opens the list with a listener of its own, which heard the click first.
  - The x used to say "don't pass this click on" from the button itself, in time. Buttons marked that way (`data-act-stop`) now act before anything around them (`appActCapture`, 16_), as they did before Release 8.
- **Ticking *Enable media server user filtering* did not stick**, and Plex plays kept being recorded.
  - The setting goes up with the Watch History save. When the account had been saved from another device or tab since this page last loaded, that save is refused as a conflict; the page reloads the account and tries again.
  - That reload wrote the account's old setting back over the one just ticked, so the retry sent "off".
  - A changed playback setting (this one, the allowed names, blocking unnamed plays, Track playback, removing watched titles from the Watchlist) is now kept until the account has it (`markTrackingSettingsEdited`, 22_).
  - Track playback also goes up straight away now; it used to wait for the next unrelated save.

`bash verify.sh` passes, and so does the suite with `MLA_TEST_V2_LISTS_READ=1`. Both fixes have a test that fails on Release 9.

**Steps:**
1. Keep Release 9's file (`release-9-NEW-worker.js`) as the rollback file.
2. Deploy Release 9b's file (`release-9b-NEW-worker.js`) the usual way. No database step, no binding.
3. Check:
   - Your Custom Lists: the red x on a poster removes it, and the page stays where it is.
   - Settings: tick *Enable media server user filtering*, pick your Plex user, refresh: still ticked. A Plex play by a user you did not pick is not recorded. (With the box ticked and nobody picked, no Plex play is recorded at all.)

### Then: sign-in sessions (`FF_SESSIONS`)

What it does:
- Signing in (or any save) also gives the browser a sign-in cookie. The classic page goes on sending the Creator Key as it does now.
- The new interface's Settings cards (account, devices, connections, install links) and **Lists → Import → Import a file** start working. Until now they said you were not signed in.
- With `TOKEN_ENCRYPTION_KEY` set, a signed-in person's connected accounts (Trakt, Simkl, MDBList, TMDB) are kept on the server, encrypted; without it they stay in the browser, as before.
- With `LOOKUP_PEPPER` set, *Forgot username* also uses the safer lookup (it falls back to the old one).

Both secrets are random values made once and **never changed or deleted** afterwards. Keep a copy of each outside Cloudflare (a password manager).

**Steps:**
1. **Make the two values** in your own browser (nothing is sent anywhere):
   - open any page, press F12 (or right-click → Inspect), and open the **Console**;
   - paste this line and press Enter:
     `'k1:' + btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))`
   - copy the answer (it starts with `k1:`, without the quote marks). That is `TOKEN_ENCRYPTION_KEY`; save it in your password manager;
   - press the up arrow, delete the `'k1:' + ` at the start, press Enter. That answer is `LOOKUP_PEPPER`; save it too.
2. **Add them:** Worker **wako** → **Settings** → **Variables and Secrets** → **+ Add**:
   - Type **Secret**, name `TOKEN_ENCRYPTION_KEY`, value the `k1:...` answer;
   - Type **Secret**, name `LOOKUP_PEPPER`, value the second answer;
   - Type **Text**, name `FF_SESSIONS`, value `1`;
   - **Deploy**.
3. **Check:**
   - classic page: sign in, change something, refresh: it is still there;
   - `/?ff_new_ui=1` → Settings: the account card shows your account, and Devices lists this browser;
   - Lists → Import → Import a file: try a small Letterboxd or IMDb export;
   - `/admin` → the install-link migration panel → **Check progress** no longer says `TOKEN_ENCRYPTION_KEY` is missing. It still moves nothing, because `INSTALL_MIGRATION_PERCENT` stays unset.
4. **Watch for 30 minutes**: Metrics and Logs.

**To undo:** delete `FF_SESSIONS` (or set it to `0`) and deploy. The two secrets stay: removing `TOKEN_ENCRYPTION_KEY` would lose any connection saved with it.

---

## Release 10: Phase 7 so far (PR #9: security)

**Branch point:** `60e48eb` on `claude/elegant-ride-o7m8fh`, which merges [PR #9](https://github.com/Br0ck25/My-Lists-Addon/pull/9)'s head, `243340a`, into Release 9b. PR #9 is built on `main` at `eee71a7`, which this branch already holds, so it came in with no source conflict (only the generated `FUNCTION-MAP.md`). PR #9 itself is still open; it goes into `main` with the rest of this branch.

One change on top of it (`docs/OPERATIONS.md` §24): the Trusted Types reports are **off unless `FF_CSP_TT_REPORT=1`**. In the PR they were on unless turned off. Each report is a browser POST, a page view can send dozens (one per `innerHTML` write, of which the site has about 300), and since P7-3 each one also spends a D1 rate-limit write. They are a to-do list for whoever works on those sinks, not something every visit should pay for.

`bash verify.sh` passes (1,952 tests, 0 failed), and so does the suite with `MLA_TEST_V2_LISTS_READ=1`.

### What changes for everyone

- **A strict Content-Security-Policy** (P7-1). The browser now runs only the scripts this Worker put in the page, each stamped with a one-time value, so an injected script is refused. Nothing should look or work differently, with one exception:
  - **the fonts are each device's own** (San Francisco on Apple, Segoe UI on Windows, Roboto on Android) instead of Google Fonts. The page makes no request to anyone else when it opens;
  - the zip reader used by *Import a file* is served by this Worker instead of a CDN.
- **Rate limits count exactly** (P7-3). Every limit the Worker applies (sign-in guesses, profile creation, saves, previews, searches and so on) is now a counter in D1 instead of KV. A burst of requests can no longer all slip under a limit at once. There is no setting to change; it replaces a KV write with a cheaper D1 write.

### What changes for `/admin` (P7-2)

- **Every admin sign-in is a session you can see and end:** Maintenance → **Signed-in admin browsers**, each with its IP and browser, and **Sign out** per row or for all. Needs migration `0018`.
- **An audit log** of every admin action that changes something (Maintenance → **Audit log**): who, what, when, from where. Keys and passwords are never recorded. Needs migration `0018`.
- Your current admin sign-in keeps working, and the admin key works as before.
- **Optional, later:** Cloudflare Access in front of `/admin`, so signing in needs your email (a one-time code) instead of only the key. It is dashboard work in Cloudflare Zero Trust (`docs/OPERATIONS.md` §25); nothing changes until it is set up.

### Steps, in order

1. **Keep Release 9b's file** (`release-9b-NEW-worker.js`) as the rollback file.
2. **Deploy** Release 10's file (`release-10-NEW-worker.js`) the usual way.
3. **D1 → `my-lists-db` (the main database, not `mylists-activity`) → Console:**
   - paste `release-10-migration-0018-MAIN-database.sql` → **Execute**;
   - paste `release-10-migration-0019-MAIN-database.sql` → **Execute**.
   Both only add tables and an index, and are safe to run twice.
4. **Check the site:**
   - it opens and works as before, in the system font; sign in, change something, refresh;
   - a trailer plays (Discover → a title → Trailer);
   - Lists → Import → Import a file with a small export (the zip reader is now this Worker's);
   - in Stremio or Nuvio, rows load.
5. **Check `/admin`:**
   - sign in (sign in again with the key if it asks);
   - Maintenance → **Check schema**: the ledger ends at `0019`;
   - Maintenance → **Signed-in admin browsers** lists this browser, and **Audit log** shows the sign-in.
6. **Watch for 30 minutes**: Metrics and Logs. `[ratelimit]` lines mean a limit refused something, which is normal in small numbers.

### Rollback

Paste Release 9b's file and Deploy. The two new tables stay and are ignored by the older code; the admin sign-in goes back to the key-only cookie.

---

## After Release 10: `FF_V2_LISTS_ONLY` (no deploy)

The owner asked for this now rather than after a week or two of `FF_V2_LISTS_READ`. It is **one-way** (`docs/OPERATIONS.md` §11): from then on lists, likes and shared channels are written only to the new tables, and the old storage falls behind for good.

Checked before recommending it:
- every place this branch saves an account's list writes the new tables (the ported *every list is live* code included, fixed for this in Release 4);
- the signed-out live lists (`listlive:` keys) are a separate store the switch does not touch;
- the suite's lists-only tests pass. (Forcing the switch on for *every* test fails only the ones that seed the old storage and copy it, which the switch forbids by design.)

**Steps:**
1. `/admin` → **Lists v2** → *Check results*: every account copied, none waiting to be copied again, none failed. If some are waiting, press **Start over** (not *Copy lists*, which only resumes the first copy) and let it finish, then *Check results* again.
2. Note the time. D1 keeps 30 days of Time Travel, so the database can be put back to this moment if it ever had to be.
3. Worker **wako** → **Settings** → **Variables and Secrets** → **+ Add** → Type **Text**, name `FF_V2_LISTS_ONLY`, value `1` → **Deploy**.
4. Check: make a list, add and remove titles, rename it, reorder your lists, delete it; like and unlike a list; add and remove a Watchlist title; save a shared channel. In Stremio or Nuvio, an edit reaches the row.

**Never** delete the variable, or turn `FF_V2_LISTS_READ` off, afterwards: both would show everyone lists as they were on the day it was turned on.

### Live: the check before the switch (2026-10-01)

Reported by the owner, with Release 11 deployed and migration `0020` applied:

> Accounts: 707 done, 0 in progress, 2 waiting to be copied again, 0 failed.
> Lists: 965 found, 1 copied, 964 unchanged since the last run, 7 copies of deleted lists retired, 1 order entries with no list behind them.
> Items: 42717 in the old lists, 42579 copied, 0.323% not carried: 0 with no usable id, 0 listed twice, 138 on lists copied in an earlier run. 0 titles TMDB could not place yet.
> Likes on outside lists: 92 lists, 54 voters copied. Shared channels: 97 found, 97 unchanged since the last run, 0 unreadable.
> Migrate Accounts: 709 accounts in table (709 D1, 672 KV, union 709). Reconciled ✓

What it means:
- **The 138 items are the same 138 as in the first copy** (Release 4): titles listed twice in one list, each kept once. On lists unchanged since then, the copy only reports them as "on lists copied in an earlier run".
- **"0 titles TMDB could not place"**: the `media.retry` job (Release 7) has matched every one of the 13,631 since Release 4.
- **The 2 waiting accounts must be copied before the switch.**
  - An account is "waiting" when one of its list saves could not be copied into the new tables. Until it is copied again it reads from the old storage.
  - With `FF_V2_LISTS_ONLY` on, it would read the new tables, which are missing that change.
  - *Copy lists* does not pick them up: it resumes the first copy, which finished in Release 4 (its *Done: 698 accounts*). *Start over* goes through every account again, skips the 707 already copied, and copies these two.

So step 1 above is, in practice: press **Start over**, keep the page open until it says *Done*, then *Check results* must show **0 waiting**. Then switch, straight away.

After *Start over* (2026-10-01): **Accounts: 709 done, 0 in progress, 0 waiting to be copied again, 0 failed.** Lists 966 found, 965 unchanged; items as before (the same 138 repeated titles); shared channels 100, all unchanged. Clear to switch.

---

## Release 11: episode names and every play, for Watch History from the activity database

**Branch point:** this branch after Release 10. Nothing here comes from `main`.

With `FF_EVENT_TRACKING` (one-way per account, still off), Watch History is served from the activity database. Two things kept it off (see "Why `FF_EVENT_TRACKING` waits" under Release 5), and the owner asked for both to be fixed first:

- **"Episode N" with the show's poster.** The activity database records a play as a title, a season and an episode; nothing held the episode's name or still.
  - They are now kept once per episode, in a new table `media_episodes` in the main database (migration `0020`).
  - Every play from Stremio, Nuvio, Plex, Jellyfin or Emby writes it; so does a website save that adds an episode; and so does the history copy, which reads the old Watch History entries that still have them.
  - Watch History shows the stored name and still. An episode nobody ever recorded a name for still says "Episode N".
- **The 5,000-play cap.** The record stopped at the newest 5,000 plays. It now holds every play, as the old record did, read 5,000 rows at a time.

Nothing changes while `FF_EVENT_TRACKING` is off, except that plays start filling in `media_episodes`.

`bash verify.sh` passes, and so does the suite with `MLA_TEST_V2_LISTS_READ=1`. Both fixes have tests that fail on Release 10 (the cap test gets 5,000 of 5,206 plays).

**Steps:**
1. Keep Release 10's file (`release-10-NEW-worker.js`) as the rollback file.
2. Deploy Release 11's file (`release-11-NEW-worker.js`).
3. **D1 → `my-lists-db`** (the main database) → Console → paste `release-11-migration-0020-MAIN-database.sql` → **Execute**. Safe to run twice.
4. `/admin` → Maintenance → **Activity: copy watch history** → **Start over**, and keep the page open until it says *Done*. It copies every account again from the old storage: the episode names come with it, and so does anything changed on the website since the first copy.
5. **Check results:** no failed accounts, and no account with fewer plays than before that the examples cannot explain. Send the results over before step 6.
6. **Then** Worker **wako** → **Settings** → **Variables and Secrets** → **+ Add** → Text `FF_EVENT_TRACKING` = `1` → **Deploy**. **One-way:** never delete it afterwards.
7. Check: Watch History shows episode names and stills and goes all the way back; play something and it appears at the top; Continue Watching moves on; remove an item and it stays removed.

**Rollback before step 6:** paste Release 10's file. The new table is harmless to it. **After step 6** there is no going back to the old storage, only forward fixes.

### Live: the history copy's *Start over* (2026-10-01)

Reported by the owner, with Release 11 and `0020` in place:

> Accounts: 709 done, 0 in progress, 0 waiting, 0 failed.
> History: 45842 entries in KV, 45842 in D1, 1077 in the scrobble queue, 45853 different entries in all. 45709 plays copied; 144 were the same play twice (within ten minutes), 0 had no usable id. 5123 titles TMDB could not place yet (kept, tried again later).
> Shows: 1586 with progress, 516 finished, 98 hidden from Continue Watching, 5 hidden from Airing Next, 24 storyline or movie suggestions kept, 6 in Continue Watching with no history. Movies watched: 12135.
> Plays now in the activity database: 45882 (the larger of the KV and D1 histories added up: 45842). Accounts with fewer plays than their old history: 0.

What it means:
- **Nothing is missing:** 45,882 plays against 45,842 in the old history. The 40 extra are plays the Stremio, Nuvio and Plex pings recorded straight into the activity database, which *Start over* keeps. The 144 repeats are one play recorded twice within ten minutes.
- **The 5,123 titles TMDB could not place are kept** with the id and name they came with. `media.retry` asks TMDB about 200 an hour, so they will be matched over the next day or so. Watch History shows them either way.
- The episode names came across with the copy, into `media_episodes`.

**Before step 6:** a website removal made after this *Start over* is not in the activity database, so switch soon. If you removed things from Watch History on the website in between, press *Start over* again first. Plays from Stremio, Nuvio and Plex are recorded either way.

Tested before switching: with both `FF_V2_LISTS_ONLY` and `FF_EVENT_TRACKING` on, history loads, a website play is added with its episode name, a Watchlist change is kept (in the new list tables only), and a removal holds (`tests/activity.test.mjs`).

### Live: both switches on (2026-10-01)

The owner deployed Release 11, applied `0020`, ran both *Start over*s (0 waiting, 0 fewer plays), then added `FF_V2_LISTS_ONLY = 1` and `FF_EVENT_TRACKING = 1`, and reports everything correct. Neither variable may be deleted from now on.

---

## Release 11b: Search tiles showing a poster and "No poster" together

**Branch point:** this branch after Release 11. Nothing here comes from `main`.

The owner searched Movies for "one last": One Last Deal, One Last Ride and One Last Dance each showed the poster **and** a grey "No poster" box below it, in the same tile.

- **The cause:** one Better Poster that failed to load was handled twice.
  - Since Release 8 a poster names its fallback in `data-act`, and the page's one listener runs it (`initDelegatedActions`, 16_).
  - A second listener, for Better Posters on tiles with no fallback of their own (23_), only skipped posters with an old-style `onerror`, so it ran the fallback for these too.
  - The first run went to look up the title's ordinary poster. The second, a moment later, took the same failure for "the ordinary poster failed as well" and put up "No poster". Then the lookup answered and showed the poster, leaving both.
  - It could happen on any poster tile wired this way with Better Posters on (list-card posters, the builders' picks). Search showed it most because Release 9 gave Search Better Posters.
- **The fix** (`handlePosterImgError` and the listener after it, 23_):
  - the second listener leaves alone any poster that names its own fallback;
  - a failure reported again while the lookup is still out is ignored;
  - a poster that does load takes down any "No poster" box put up for it (`hidePosterPlaceholderFor`).
  - A real second failure (the ordinary poster not loading either) still shows "No poster".

`bash verify.sh` passes (1,964 tests), and so does the suite with `MLA_TEST_V2_LISTS_READ=1`. The new test (`tests/poster-identity.test.mjs`, "a failed Better Poster on a Search tile") plays one error through every listener the page has, as a browser does; it fails on Release 11. To do that, `tests/client-harness.mjs` now keeps the listeners the page puts on `window` and `document` (`fireListeners`).

**Steps:**
1. Keep Release 11's file (`release-11-NEW-worker.js`) as the rollback file.
2. Deploy Release 11b's file (`release-11b-NEW-worker.js`) the usual way. No database step, no variable.
3. Check: with Better Posters on, Search → Movies "one last" (and Shows): each tile shows one poster, or one "No poster" box, never both. Look at a few list cards on Discover too.

**Rollback:** paste Release 11's file. Both switches stay on either way: this release does not touch them.

---

## Release 12: the owner's review of the new interface, and titles too new for TMDB

**Branch point:** this branch after Release 11b. Nothing here comes from `main`. It includes 11b, so if 11b is not deployed yet, deploy this instead.

The owner went through the new interface (`/?ff_new_ui=1`) before it goes to everyone, and found five things, plus one problem on the live site.

### What changes for everyone

- **New on Streaming titles too new for TMDB.**
  - The New on Streaming lists hold titles by IMDb id the day a service adds them, with JustWatch's poster. Some are too new for TMDB, Metahub and btttr.cc. Seen: The Devil's Mark (`tt39833082`) and Full Figured Flings (`tt35457754`), checked on the live site on 2026-10-01.
  - **With Better Posters on, their tiles said "No poster".** The JustWatch poster was replaced by a Better Poster btttr.cc could not draw. The lookup after that (TMDB, then Metahub) found nothing either.
    - Now a Better Poster that fails goes back to the poster the title came with (`rememberBetterPosterOriginal`, 19_; `handlePosterImgError`, 23_).
    - It switches to the Better Poster if btttr.cc draws it later.
    - It applies to every list, not just New on Streaming.
  - **Opening one said "✗ Not found or TMDB error"**, with Better Posters on or off: the details page asks TMDB, and TMDB has no entry yet.
    - Now `/api/details` falls back to what else is known (`titleDetailsWithoutTmdb`, new file `57_title-details-fallback.js`):
      - the name, poster, backdrop and year New on Streaming stored;
      - Cinemeta's description, genres, runtime, cast and trailer when it has them.
    - A title nobody knows still says "not found".
- **Signing out of the classic page ends the sign-in session too.**
  - Since `FF_SESSIONS`, signing in also gives the browser a sign-in cookie. *Sign Out / Switch* only cleared the page's own copy, so the cookie stayed signed in. The new interface's Settings, and anything else that reads the cookie, went on as that account, for the next person on a shared computer too.
  - It now also ends the server session (`switchCreatorProfile`, 22_).

### What only the new interface changes

- **Settings → Account & Sync: no more doubled buttons.**
  - The new interface had added its own Account card (sign in, sign out, delete account) and Connections card (Trakt, MDBList, Simkl, TMDB) above the classic panels, which have the same buttons.
  - Both cards are gone; *Your Account* and *External Accounts & API Keys* are the ones to use.
  - What is left of the new cards, **Devices** and **Install link**, now sits below *Your Account*.
- **Install link card:**
  - It shows this browser's install link with *Install in Stremio*, *Install in Nuvio*, *Copy link* and *Update link*. It is where the install bar's job went in Release 9.
  - "Saved install links" (named links kept on the account, each revocable, behind `FF_INSTALLS`) is a feature whose screens were never built: nothing on the site makes one. So the card no longer mentions it ("not switched on for this site yet"). It lists them only if an account ever has some.
  - **Leave `FF_INSTALLS` unset.**
- **Lists → Import:** the *Import list* button no longer squeezes to two lines beside the name box on a computer. The same goes for any box with a button beside it (09_ CSS).
- **Drag and drop:** the blue dashed outline Your Custom Lists shows on the item being moved is now on every drag-to-reorder: catalog rows, My Channels, and the picks in the channel and custom list builders.
  - `tests/drag-outline.test.mjs` checks that every reorderable list gets it, including one added later.

`bash verify.sh` passes (1,975 tests), and so does the suite with `MLA_TEST_V2_LISTS_READ=1`. The new tests:
- the poster stand-in (`tests/poster-identity.test.mjs`);
- the details fallback (`tests/title-details-fallback.test.mjs`);
- the sign-out (`tests/client.test.mjs`).

They fail on Release 11b. One older test (`tests/worker.test.mjs`, "truncated body") now fakes Cinemeta as well, so it stays off the real network.

**Steps:**
1. Keep the file now live (`release-11b-NEW-worker.js`, or `release-11-NEW-worker.js` if 11b was skipped) as the rollback file.
2. Deploy `release-12-NEW-worker.js` the usual way. No database step, no variable.
3. Check:
   - with Better Posters on, Discover → New on Streaming → See all: The Devil's Mark and Full Figured Flings show a poster, and open to a page with their name and poster;
   - classic page: Sign Out / Switch, then open `/?ff_new_ui=1` → Settings: Devices says to sign in;
   - new interface, Settings → Account & Sync: one set of account buttons; *Devices* and *Install link* below *Your Account*;
   - Lists → Import on a computer: *Import list* on one line;
   - drag a catalog row, a list and a pick in the custom list builder: each shows the dashed outline while it moves.

**Rollback:** paste the previous file. Nothing else to undo.

---

## Release 13: the switches, a backup that works, and recovery answer hashing

**Branch point:** this branch after Release 12. Nothing here comes from `main`. It includes 12 (and 11b): deploy this one if those are not live yet.

The owner asked for the recommended next steps, and for `FF_PROVIDER_BREAKER`, `FF_CHART_SNAPSHOTS` and `FF_SHOW_SCHEDULE` now. They do not want one-time recovery codes (P7-5 dropped, D-31).

### What it changes

- **`FF_NEW_UI`, the switch for everyone** (02_, 25_).
  - Set to `1`, every browser that has not chosen gets the new interface.
  - `?ff_new_ui=0` keeps the classic page for a browser. It now stores "classic" in the cookie rather than clearing it, so the choice holds under the new default.
  - Off (unset), nothing changes. Reversible; no data moves. Tests in `tests/app-shell.test.mjs`.
- **Recovery answers get six times the hashing work (P7-4, D-32).**
  - The plan asked for 600,000 PBKDF2 iterations, but Workers refuse more than 100,000 in one call (checked in Cloudflare's runtime source), so it is six chained rounds of 100,000.
  - Existing answers keep working and are upgraded the next time they are used to reset a key or find a username.
  - Account Keys stay as they are: they are about 60 random bits, beyond guessing at any hash cost, and every sign-in check pays it. Tests: `tests/recovery-answer-hash.test.mjs`.
- **The daily database backup is rewritten** (GitHub, not the Worker).
  - It could never have worked: `wrangler d1 export` refuses a database with virtual tables, and the main database has two (the list search tables). An export also blocks the database while it runs.
  - It now reads every table with ordinary queries (`.github/scripts/d1-backup.mjs`) and writes SQL that restores it, search tables included. It also copies `mylists-activity`, which since `FF_EVENT_TRACKING` is the only copy of Watch History.
  - Tests restore a dump into an empty database and compare every row, on the real schemas of both databases (`tests/d1-backup.test.mjs`).
  - **The daily run uses the copy of the workflow on `main`**, which is the old one until this branch is merged. Until then, run it by hand from this branch.

### Checked before recommending the switches

- **`FF_PROVIDER_BREAKER` and `FF_CHART_SNAPSHOTS`:** the whole suite was run with both forced on, alongside `FF_V2_LISTS_READ`. Seven tests failed, and all seven are expectations about the switches being off, not problems:
  - two test "nothing happens with it off";
  - two see the breaker correctly skipping TMDB for a minute after an earlier test broke TMDB on purpose;
  - two expect calls to TMDB that a snapshot now answers;
  - one sees one extra short-lived breaker note with the network turned off.
- **`FF_SHOW_SCHEDULE`** only changes how Continue Watching and Airing Next are read (with `FF_EVENT_TRACKING` on), so it can be turned off again. One gate matters: a show the schedule does not know yet is left off Continue Watching. So it goes on once `/admin` → Check jobs shows the last full `shelf.shadow` comparison under 1% different with no shows "not known yet". After it has served for a few days, the old Continue Watching and Airing Next code is deleted (P5-4).

`bash verify.sh` passes (1,997 tests), and so does the suite with `MLA_TEST_V2_LISTS_READ=1`.

**Steps:**
1. Keep the file now live as the rollback file.
2. Deploy `release-13-NEW-worker.js`. No database step.
3. Worker **wako** → Settings → Variables and Secrets → add Text `FF_PROVIDER_BREAKER` = `1` and Text `FF_CHART_SNAPSHOTS` = `1` → Deploy. Check that the home screen rows load in Stremio and on Discover. To undo either one, delete it and deploy.
4. `/admin` → **Check jobs**, and send the `shelf.shadow` line ("Last full comparison ..."). `FF_SHOW_SCHEDULE` goes on from what it says.
5. When ready for everyone: add Text `FF_NEW_UI` = `1` → Deploy. Anyone can keep the old page with `/?ff_new_ui=0`. To undo, delete it.
6. Backups: the five GitHub secrets (`docs/OPERATIONS.md` §5), then Actions → **D1 backup** → **Run workflow**, choosing this branch.

**Rollback:** paste the previous file and remove any switch that misbehaves. One thing does not roll back: a recovery answer set or used after Release 13 is stored in the new shape, which older code cannot read. On an older release that answer fails until Release 13 is back. Account Keys are unaffected.

---

## Release 14: the review of Phases 8–10 — counters, badged posters, and a cleanup that keeps data

**Branch point:** `main` at `a6785d6`, which is what is live. Everything below is on top of it.

The owner asked for every problem from the review to be fixed, and reported that the admin panel has missing and broken data.

### What it changes

- **The admin counters count again** (`03_`, D-33).
  - Since 2026-10-02 (P8-2), page views, install links, playback pings, Most Watched, Most Added and the search log were sent to Analytics Engine **instead of** the database, because the `ANALYTICS` binding is set. Nothing reads Analytics Engine, so the dashboard showed zeros and Most Watched stopped moving.
  - They are written to D1 again, and Most Watched reads them again (not `title_daily_stats`, which only has the plays of event-tracked accounts, up to yesterday).
  - **The missing days can be put back**: `/admin` → Maintenance → **Counts missing since 2 October** reads them from Analytics Engine, shows a preview, and adds each one once. Pressing it again adds nothing. It needs a read-only API token (steps below).
- **Badged posters show the poster again** (`25_`).
  - P8-4 made a badged poster ("Season Premiere", an air date) link to the poster instead of containing it. An SVG shown as an image may not load anything from outside itself, so those tiles showed the badge on a blank card. Checked with a real browser and a real local server: no request was made.
  - The poster is embedded again. When the poster cannot be fetched, or is not an image, the plain poster is sent instead of a blank badge. The memory cache that P8-4 added stays, now limited by size (24 MB, at most 1 MB per poster).
- **Read replicas, for when they are switched on** (`02_`). Two kinds of request now always use the main database:
  - `/subtitles/` — with playback tracking, this is the ping that reads Continue Watching and writes it back. From a replica that is behind, it would write old data over new, so a removed title would come back.
  - `/api/lists/:id` — the owner reads a list just after changing it, and needs the change.
- **Watch history of old accounts is protected again** (`05_`, `07_`, `26_`).
  - P10-4 emptied `ensureTrackingMigrated`. An account that had not been used since watch history moved to its own record lost that history on its first autosave.
  - Restored as it was, with all six of its calls.
- **Copying old data to R2, without losing any** (`26_`, `03_`, docs/CUTOVER.md P10-3).
  - The old tool wrote all the batches of an export to one file name, so each batch replaced the one before. It also turned images into text.
  - Each batch is now its own file, images are kept byte for byte, and `manifest.json` is written last, once everything is in. `/admin` → Maintenance → **Export old data to R2 (a copy)** runs it.
  - The cleanup guide (P10-3) is rewritten. Its delete list named data the site still uses: accounts, settings, history, likes, share codes, the counters, Better Posters. Its D1 list named 16 tables, all still in use. Deleting is now marked **do not run**, until a release removes what reads each one (D-34).
- **The sunset notices are shown** (`22_`), but only the one a visitor can act on: the media server webhook address. The others name routes this page itself still uses. **Do not set `SUNSET_60DAY_START_DATE` yet** (docs/CUTOVER.md P10-2).
- **`wrangler.toml` is safe to keep** (not used by a pasted deploy). It names the live Worker with its real ids, so a plain `wrangler deploy` would have:
  - replaced every dashboard variable, including the two that must never be removed;
  - dropped `DB_ACTIVITY`.

  It now has `keep_vars = true`, a warning at the top, and a `DB_ACTIVITY` binding whose placeholder id makes such a deploy fail.

### `FF_SCROBBLE_ST_ONLY` should come off

With it on, a media server (Plex, Jellyfin, Emby) that still uses a webhook address from before scrobble tokens (`config=` or `creator=&key=`) is refused, and its plays are not recorded. Nobody is told: the server gets an error, not the person. The plan was to turn it on only at the end of the 60-day sunset. Deleting it changes nothing else, and it can be added again later.

### Checked

- `bash verify.sh` passes, and so does the suite with `MLA_TEST_V2_LISTS_READ=1` (counts in the commit).
- New or rewritten tests:
  - `tests/analytics-engine-stats.test.mjs`: counters in D1 with Analytics Engine bound; recovery preview, apply, apply again, no token, admin only.
  - `tests/poster-optimization.test.mjs`: the poster's own bytes inside the SVG; plain poster when it cannot be had; the cache and its size limit.
  - `tests/d1-read-replication.test.mjs`: `/subtitles/` and `/api/lists/:id` on the main database.
  - `tests/phase10-cutover.test.mjs`: export parts, manifest last, metadata kept, images kept, a failed R2 write leaves no manifest, `*` refused.
  - `tests/review-fixes-2026-10-04.test.mjs`: an old account's history survives an autosave (this test fails with the P10-4 version); the notice shown once; `wrangler.toml` guards.

**Steps:**
1. Keep the file now live as the rollback file.
2. Deploy `release-14-NEW-worker.js`. No database step.
3. Worker **my-lists-addon** → Settings → Variables and Secrets → delete `FF_SCROBBLE_ST_ONLY` → Deploy.
4. Check: open the site, then `/admin`. Total page views should go up by one, and today's count should no longer be 0.
5. Put the missing days back (docs/OPERATIONS.md §30):
   1. Cloudflare → My Profile → API Tokens → **Create Token** → **Create Custom Token**. Give it the permission **Account → Account Analytics → Read**, for your account. Copy the token.
   2. Worker **my-lists-addon** → Settings → Variables and Secrets:
      - add a **Secret** `CF_ANALYTICS_TOKEN` = the token;
      - add a **Text** variable `CF_ANALYTICS_ACCOUNT_ID` = your account id (the 32 letters and numbers in the dashboard's address, right after `dash.cloudflare.com/`).

      Deploy.
   3. `/admin` → Maintenance → **Counts missing since 2 October** → **Preview**. Send the result.
   4. **Put them back**. Then delete `CF_ANALYTICS_TOKEN` and the token itself.
6. Backups: if not done yet, add the five GitHub secrets (docs/OPERATIONS.md §5), then Actions → **D1 backup** → **Run workflow**.

**Not yet:**
- Do not switch on D1 read replication.
- Do not set `SUNSET_60DAY_START_DATE`.
- Do not run any deletion from docs/CUTOVER.md.
- `FF_SHOW_SCHEDULE` stays off (20% different).

**Rollback:** paste the previous file. Two things to know:
- Counts recorded while Release 14 ran stay in D1.
- Any days already put back stay put back.

