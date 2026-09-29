# Releases: going live one phase at a time

Before Release 1, the live site, mylistsaddon.com, ran the public repository, [Br0ck25/My-Lists](https://github.com/Br0ck25/My-Lists), at `b9c0a95`.

**Status**
- **Release 1** went live on 2026-09-29. The owner reports everything working.
- **Release 2** is prepared and not yet live.

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
| 3 | Phase 3a: accounts and sessions | `56d0154` | `0015` | `/admin` → Migrate Accounts; secrets `TOKEN_ENCRYPTION_KEY`, `LOOKUP_PEPPER` (needed once their switches go on); switches stay off |
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

### Rollback

Paste Release 1's file and Deploy. Nothing to undo in the database.
