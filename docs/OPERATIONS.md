# Operations — mylistsaddon.com

How the hosted Worker is deployed, configured and recovered. The Worker is deployed by **pasting `worker_entry_combined.js` into the Cloudflare dashboard**. `wrangler.toml` is used only for local development and for CI jobs that talk to D1; the dashboard never reads it.

---

## 1. Release checklist

1. **Build and verify locally**, from the repo root:
   ```bash
   python build.py
   python check_sync.py
   node --check worker_entry_combined.js
   node --test tests/*.test.mjs
   ```
2. **Apply database migrations first** if the release adds any (see §4). The current release has four, `0014`, `0015`, `0016`, then `0017`. A Worker that needs a newer schema than the database has refuses writes with a maintenance message rather than failing silently. That guard only works once migration `0014` is applied.
3. **Back up D1** (see §5) if the release contains a migration.
4. **Deploy.** Cloudflare dashboard → Workers & Pages → the My Lists Worker → **Edit code** → select all → paste the new `worker_entry_combined.js` → **Deploy**.
5. **Smoke test:**
   - `/` loads;
   - an existing install's `/{id}/manifest.json` returns JSON;
   - one catalog row loads;
   - `/lists/public.json` returns lists;
   - log in on the website.
6. **Watch** the Worker's *Metrics* and *Logs* for 30 minutes: error rate, CPU time, D1 errors.

**Rollback:** paste the previous `worker_entry_combined.js` and Deploy. Keep the last three released files. Migrations are additive, so an older Worker keeps running against a newer schema.

---

## 2. Bindings

Set these in the dashboard: Worker → **Settings → Bindings → Add**.

| Binding name | Type | Required | What it is for | Status |
|---|---|---|---|---|
| `CONFIGS` | KV namespace | **Yes** | Install configs, list and sync records (being moved to D1), caches, rate limits | In use |
| `DB` | D1 database (`my-lists-db`) | **Yes** | Accounts, lists, likes, tracking, directory, search, counters | In use |
| `ANALYTICS` | Analytics Engine dataset (`mylists_events`) | Recommended | Per-request route, status and storage-operation counts, used to measure the next phases | **Add now.** The code writes to it when present and skips it otherwise. |
| `DB_ACTIVITY` | D1 database (`mylists-activity`) | Later (Phase 3c) | Watch events and progress | Can be added now; nothing uses it yet. Create the database (D1 → Create → `mylists-activity`), run `migrations/activity/A0001_activity.sql` in **its** Console (not the main database's), then bind it. See §4. |
| `BLOBS` | R2 bucket (`mylists-blobs`) | Recommended (Phase 3b) | Shared channels' episode lists (P3b-8); later posters, exports and D1 backups | **Add with Phase 3b.** Create the bucket (R2 → Create bucket → `mylists-blobs`), then bind it. Without it, shared channels still get their rows and their episodes are read from KV. |
| `JOBS` | Queue producer (`mylists-jobs`) | Recommended (Phase 5) | Background jobs: work that nobody is waiting on runs from a queue instead of inside a request or a cron tick | **Add with Phase 5**, with the queue's consumer and dead-letter queue: the steps are in §18. Without it nothing is sent to a queue, and the cron keeps doing its work itself, as before. |

The owner confirmed on 2026-09-27 that this account's dashboard offers Queues, R2 and Analytics Engine bindings.

Adding a binding before the code that uses it is harmless. Removing a binding the code needs breaks the features that depend on it.

## 3. Variables, secrets and triggers

**Secrets** (Worker → Settings → Variables and Secrets → **Encrypt**):

| Secret | Purpose |
|---|---|
| `ADMIN_KEY` | `/admin` login |
| `TMDB_API_KEY` | TMDB |
| `TRAKT_CLIENT_ID`, `TRAKT_CLIENT_SECRET` | Trakt |
| `SIMKL_CLIENT_ID`, `SIMKL_CLIENT_SECRET` | Simkl |
| `MDBLIST_API_KEY`, `MDBLIST_POPULAR_KEY`, `MDBLIST_CLIENT_ID`, `MDBLIST_CLIENT_SECRET` | MDBList |
| `RAPIDAPI_KEY` | New on Streaming fallback engine |
| `TOKEN_ENCRYPTION_KEY` | 32-byte AES-GCM key (`k1:<base64>`) for server-side encrypted tokens. Needed before `INSTALL_MIGRATION_PERCENT` is raised above 0 (§8), and for signed-in connected accounts to be kept on the server once `FF_SESSIONS` is on (without it they are kept in the browser, as before). Generate with `openssl rand -base64 32` and store it as `k1:` followed by that value. **Once anything is encrypted with it, never delete or change it:** every moved install link would lose its keys. Rotate only by putting a new key first (`k2:<new>,k1:<old>`). Keep a copy outside Cloudflare. |
| `LOOKUP_PEPPER` | HMAC pepper for the forgot-username lookup (P3a-7). **Optional:** without it, forgot-username uses the old lookup only. Any long random value (`openssl rand -base64 32`). Never change or delete it once set. |

**Plain variables:**

- `NEW_ON_STREAMING_ENGINE` (optional; default `justwatch`).
- `FF_SESSIONS` (optional): `1` turns on session sign-in for the `/api/creator/*` routes (P3a-6). **Leave unset** until the new sign-in screens ship.
- `FF_INSTALLS` (optional): `1` turns on `/api/installs`, where a signed-in account creates, renames, rotates and removes `/i/{token}` install links (P3a-8). **Leave unset** until the screens for it ship. Links that already exist are served either way.
- `FF_V2_LISTS_READ` (optional): `1` makes the site read lists and shared channels from the new tables: the dashboard, list pages, catalogs, the directory and search, shared channels and Explore Channels (P3b-6 to P3b-8). **Leave unset** until the copy (§9) has finished; §10 has the steps. Turning it off again is always safe, because every change is still written to the old storage.
- `FF_V2_LISTS_API` (optional): `1` turns on `/api/lists`, the item-level list API, and `/api/likes`, the likes API, over the new list tables (P3b-4, P3b-5). **Leave unset.** What these APIs write goes to the new tables only. Until a later release stops writing the old storage (P3b-9), turning `FF_V2_LISTS_READ` off, or running the copy again, would lose it.
- `FF_V2_LISTS_ONLY` (optional, P3b-9): `1` stops writing the old list and channel storage; the new tables become the only store, and everything reads from them. **One-way.** Leave unset until §11 says it is time, and once set, leave it set.
- `FF_PROVIDER_BREAKER` (optional, P4-4): `1` turns on the provider breaker (§14). When a provider (TMDB, Trakt, MDBList, Simkl, ...) fails five times in a row, the site stops calling it for a minute and serves its last good copies straight away, instead of every row waiting for a timeout. Safe to turn on and off at any time.
- `FF_MATERIALIZER` (optional, P5-11): `1` makes installs that use **Remove duplicate items across lists** build their home screen once per hour instead of each row rebuilding the rows above it (§19). Safe to turn on and off at any time.
- `INSTALL_MIGRATION_PERCENT` (optional, `0` to `100`): the share of existing install links whose keys and tokens move into encrypted D1 storage the first time they are used. See §8 before setting it.
- **Delete** these retired variables if they are still set: `BULK_RESOLVE_SUBREQUEST_BUDGET`, `DETAILS_BATCH_SUBREQUEST_BUDGET`, `CRON_SUBREQUEST_BUDGET`. The code ignores them.

**Cron trigger** (Worker → Settings → Triggers): `*/5 * * * *` (the older `*/6 * * * *` works the same). One trigger is enough: with the queue bound (§18) each tick only hands out due jobs, each with its own schedule.

**Compatibility date:** check the value under Worker → Settings → Runtime and record it here. When raising it, run the full test suite and a staging deploy first.

**Plan:** Workers **Paid**. The code assumes Paid limits: 10,000 subrequests per invocation and 30 s CPU by default.

## 4. Database migrations

- Migrations live in `migrations/`, applied in file-name order.
- From `0014` on, each migration records itself in the `schema_migrations` table.
- **Never run `schema.sql` against production.** It creates a blank database for local tests and development; its statements are `CREATE … IF NOT EXISTS` and it drops nothing.

**Applying a migration from the dashboard:**

1. Storage & Databases → D1 → `my-lists-db` → **Console**.
2. Run `SELECT version FROM schema_migrations ORDER BY version;` (on a database that predates `0014`, the table doesn't exist yet).
3. Paste the next unapplied migration file and run it.

**From CI or a terminal:** use `npx wrangler d1 execute my-lists-db --remote --file=migrations/<file>.sql` with an API token that has D1 edit permission.

**Checking where a database is:** `/admin` → Maintenance → **Check schema** shows the ledger version, the version this Worker needs, and whether API writes are paused.

**Writing a new migration:**

1. Add `migrations/NNNN_description.sql`. Make it additive (new tables, columns and indexes only) and safe to run twice (`IF NOT EXISTS`).
2. End it with `INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES ('NNNN', CAST(strftime('%s','now') AS INTEGER) * 1000);`.
3. Add the same objects to `schema.sql`, plus `('NNNN', 0)` to its ledger seed. The drift test fails if the two disagree.
4. Add the migration's tables, indexes and columns to `D1_SCHEMA_MANIFEST` in `00_constants.js`.
5. If the code **needs** the migration, raise `REQUIRED_SCHEMA_VERSION` in `00_constants.js` in the same change. Until the migration is applied, the deployed Worker then refuses API writes with a 503 "My Lists is being updated" instead of failing quietly. **Always apply the migration before deploying.**

### The activity database (Phase 3c)

`DB_ACTIVITY` is a second D1 database with its own migrations, in `migrations/activity/` (`A0001`, `A0002`, ...). Run those in the **activity database's** Console, never in the main one, and the main ones never there. A fresh activity database can take `schema_activity.sql` instead. It has its own `schema_migrations` ledger.

When it nears D1's size limit it can be split: create and bind `DB_ACTIVITY_1`, `DB_ACTIVITY_2`, ... (each with the same migrations) and set the variable `ACTIVITY_SHARD_COUNT` to how many there are in all. Accounts are then spread by id. This moves accounts between databases, so it needs a copy job first; do not set it on its own.

## 5. Backups

- **Before any migration:** D1 → `my-lists-db` → *Backups / Time Travel* (D1 keeps point-in-time recovery for 30 days on Paid), or export with `npx wrangler d1 export my-lists-db --remote --output=backup.sql`.
- **Daily off-Cloudflare copy:** `.github/workflows/d1-backup.yml` exports the database every day at 04:17 UTC. It encrypts the export and keeps it as an Actions artifact for 30 days.
  - It needs four repository secrets (Settings → Secrets and variables → Actions):
    - `CLOUDFLARE_API_TOKEN`: an API token with *D1: Read*;
    - `CLOUDFLARE_ACCOUNT_ID`;
    - `D1_DATABASE_ID`: shown on the database's overview page;
    - `BACKUP_PASSPHRASE`: a long random string.
  - Until all four are set, the job skips itself with a warning.
  - Keep a copy of the passphrase outside GitHub. Without it no backup can be read.
  - The export is encrypted because this repository's Actions artifacts can be downloaded by other people, and the export holds every account's data.
- **Restoring a daily copy:**
  1. Download the artifact from the workflow run.
  2. Decrypt it: `gpg --decrypt my-lists-db-<stamp>.sql.gz.gpg > backup.sql.gz` (it asks for the passphrase), then `gunzip backup.sql.gz`.
  3. Load it into a **new, empty** database first and check it: `npx wrangler d1 create my-lists-restore`, then `npx wrangler d1 execute my-lists-restore --remote --file=backup.sql`.
  4. Point the Worker's `DB` binding at the restored database only once it checks out.
  5. Never load a backup into the live database on top of existing data.
- The KV namespace has no built-in backup. The data that matters in KV is being moved to D1 (see `MIGRATION_PLAN.md`).

## 6. Recommended WAF rate-limiting rules

Configure these under Security → WAF → Rate limiting rules on the zone. They stop abuse before it reaches the Worker. Starting points (per IP, 1 minute):

| Path | Limit |
|---|---|
| `/api/creator/create` | 5 |
| `/api/creator/restore`, `/api/creator/reset-key`, `/api/creator/forgot-username` | 20 |
| `/admin/login` | 10 |
| `/api/save` | 30 |
| `/api/lists/like*`, `/api/channel/like`, `/api/channel/share` | 60 |
| `/api/feedback*` | 20 |

## 7. Health

`/admin` → Maintenance shows:

- **Schema status:** migrations applied versus what the code expects.
- **API usage:** which provider keys are configured.

## 8. Moving install-link keys into encrypted storage (P3a-8)

Every install link saved by a signed-in person keeps its provider keys and tokens (TMDB, MDBList, Trakt, Simkl) in its KV `cfg:` record, and a link with a personal shelf also keeps the person's Creator Key there. Phase 3a moves them into D1 (`install_secrets`), encrypted with `TOKEN_ENCRYPTION_KEY`. The KV record keeps everything else and a pointer (`_install`).

- **Nothing changes for anyone who uses the link.** Its URL stays the same. When it is read, the Worker decrypts the keys and puts them back, so its rows, its playback tracking, and a Creator Key reset stopping that tracking all work exactly as before.
- **Only links that hold a key or token move.** A link made signed out has none and is never touched.
- **A link moves the first time it is used** (its manifest or a catalog row is requested), after the response has gone out.

**Turning it on:**

1. Apply migration `0015` (§4).
2. Back up D1 (§5).
3. Add the secret `TOKEN_ENCRYPTION_KEY` (§3). Keep a copy of it outside Cloudflare.
4. Set the variable `INSTALL_MIGRATION_PERCENT` to `10` and deploy.
5. Next day, check `/admin` → Maintenance → **Install links** → *Check progress*, and the Worker logs for "was not moved" or "could not decrypt". Then raise it to `50`, then `100`.

**If something goes wrong:**

1. Set `INSTALL_MIGRATION_PERCENT` to `0`. No more links move.
2. `/admin` → Maintenance → **Install links** → *Undo the move*. It puts every moved link's keys back into its KV record, exactly as they were saved, and empties the table. Links an account removed stay removed.

Undo needs the same `TOKEN_ENCRYPTION_KEY`. Without that key the moved keys cannot be read by anyone, which is why step 3 keeps a copy.

## 9. Copying lists into the new list tables (P3b-3)

Phase 3b moves lists, likes and channels into proper D1 tables. The first part copies every existing list into them. **It only copies.** The lists people use today are not changed, and nothing on the site reads the copies until `FF_V2_LISTS_READ` is turned on (§10). So running it changes nothing a visitor sees.

From the moment migration `0016` is applied, every change to a list or a shared channel (a save, a delete, a new order, a like, a share) is also written to the new tables as it happens, a few extra D1 writes each (and one R2 write when a shared channel's episodes change). So once the copy has finished, the new tables stay current by themselves.

What it copies: every account's lists (with their order, items and likes), the old anonymous lists (kept unlisted, as D-6 decided), likes on outside lists (MDBList, Trakt and the like), and shared and published channels with their likes and adds (P3b-8). A channel's episode list goes to the `BLOBS` R2 bucket (§2); bind it before running the copy, or the episode lists stay in KV and a later *Start over* moves them.

**Running it:**

1. Apply migration `0016` (§4).
2. Back up D1 (§5).
3. `/admin` → Maintenance → **Unified accounts table** → *Migrate Accounts*, if it has not been run since the last deploy. Lists are copied account by account from that table.
4. `/admin` → Maintenance → **Lists v2** → *Copy lists*. It works in small steps and keeps going by itself while the page is open. Closing the page pauses it; *Copy lists* carries on where it stopped.
5. When it says *Done*, press *Check results*.

**Reading the results:**

- *Items … % not carried* is the share of list entries the copy could not carry. Each has a reason, with examples:
  - *no usable id*: an entry with no id at all. No catalog can show it today either.
  - *listed twice*: the same title (or the same episode) twice in one list. The copy keeps it once.
- *Titles TMDB could not place yet* are **kept**, with the id and name they had, and tried again later. They are not lost.
- *Kept from the old totals*: likes counted before voters were recorded. The copy keeps the higher total, so no count people see goes down (D-9).
- *Failed accounts* names each account the copy could not finish and why. The rest carry on.

**Running it again:** *Start over* goes through every account again. It copies only the lists that changed since the last run, refreshes order and likes, and marks as deleted the copies of lists deleted since. Do this shortly before the release that switches reads to the new tables.

## 10. Reading lists from the new tables (P3b-7)

`FF_V2_LISTS_READ` switches reading to the new tables: the dashboard, list pages, Custom List catalog rows, the public directory and search, shared channels and Explore Channels. Every answer is meant to be the same as before; the tests compare the two. The Watchlist, and the channels an account syncs between its own browsers, are still read from the old storage.

**Before turning it on:**

1. Migration `0016` is applied (§4), the `BLOBS` bucket is bound (§2), and the copy (§9) says *Done*.
2. *Check results* looks right: few items not carried, and no failed accounts you have not looked at. Entries with no id at all and titles listed twice in one list are **not** in the new tables, so they stop showing when reads switch.

**Turning it on:** Worker → Settings → Variables and Secrets → Add → type *Text*, name `FF_V2_LISTS_READ`, value `1`. Deploy.

**What happens then:**

- An account is read from the new tables once its copy has finished; the directory, search and Explore Channels, once the whole copy has. Opening the dashboard finishes an account's copy on the spot if it has not finished.
- A shared channel is read from the new tables while its copy there is current and its episode list is in R2; otherwise from the old storage.
- Every change is still written to the old storage first, then to the new tables. If writing the new tables fails for an account, that account is read from the old storage again until its copy is refreshed (the next time its owner opens the dashboard, or the next *Copy lists*).
- *Start over* on the copy leaves finished accounts alone while this flag is on: the new tables are what people see, and saves keep them current.

**Turning it off:** delete the variable and deploy. The site reads the old storage again, which never stopped being written, so nothing is lost. (Not once `FF_V2_LISTS_ONLY` is on: see §11.)

## 11. Stopping the old list storage (P3b-9)

`FF_V2_LISTS_ONLY` makes the new tables the only list and channel store. The old keys (`creatorlist:`, the order, stamp and deletion keys, the like ledgers, `externallike:`, `channelshare:`, `index:publicchannels`) and the old D1 list tables stop being written, and nothing reads them any more. Every answer stays the same; the tests run the same requests both ways and compare them.

**This is one-way.** From the moment it is on, changes go only to the new tables, so the old storage falls behind. Turning it off again, or turning `FF_V2_LISTS_READ` off while it is on, would show everyone out-of-date lists. Once set, leave it set.

**Before turning it on:**

1. `FF_V2_LISTS_READ` has been on for a while (a week or two) with nothing wrong reported.
2. The `BLOBS` bucket is bound (§2): shared channels' episode lists have nowhere else to go.
3. `/admin` → **Lists v2** → *Check results* says every account is copied: none in progress, none waiting to be copied again, none failed. If some are waiting, press *Copy lists* first.
4. Back up D1 (§5).

**Turning it on:** Worker → Settings → Variables and Secrets → Add → type *Text*, name `FF_V2_LISTS_ONLY`, value `1`. Deploy.

**What happens then:**

- Saving, deleting and reordering lists, the Watchlist, likes and shared channels all go straight to the new tables. A save that cannot be stored says so (the website keeps its copy and tries again) rather than landing in the old storage.
- The list copy in `/admin` stops: there is nothing current to copy from. So does *Migrate D1*.
- Deleting a list or an account still removes what the old storage held of it.
- **How to check it worked:** in the Analytics Engine dataset `mylists_events`, the eighth number of each data point (`double8`) counts writes to the old list keys. It should stay at 0.
- The old keys and tables stay where they are, unused, until a later cleanup removes them. The old anonymous lists (from before accounts) are still served from the old storage.

## 12. Copying watch history into the activity database (P3c-3)

Phase 3c moves watch history and show progress into their own database, `mylists-activity` (binding `DB_ACTIVITY`, §2 and §4). The first part copies what every account has. **It only copies.** The history people see today is not changed, and nothing on the site reads the copy yet, so running it changes nothing a visitor sees.

What it copies, for each account:

- **Watch History**, from all three places it is kept today: the account's tracking record in KV, the D1 `watch_history` table, and the small scrobble queue. Where one entry is in more than one, the newest copy counts. This is also what the website shows today.
- **Where each show is up to**: the furthest episode watched, and when. On top of that: finished shows, shows hidden from Continue Watching or Airing Next (and at which episode), and storyline suggestions (the next movie or spin-off). A show that is in Continue Watching with no history behind it keeps its place.
- **Movies watched**: how many times each, and when last.

It does not copy Airing Next or the recommendations. Both are worked out rather than kept, and later jobs rebuild them (Phase 5). The Watchlist is a list: the list copy (§9) takes it.

**Running it:**

1. Create the activity database and bind it (§2), and run `migrations/activity/A0001_activity.sql` in **its** Console (§4).
2. Migration `0016` is applied in the main database (the copy records each title in its `media` table), and **Migrate Accounts** has been run (§9, step 3).
3. Back up D1 (§5).
4. `/admin` → Maintenance → **Activity: copy watch history** → *Copy history*. It works in small steps and keeps going by itself while the page is open. Closing the page pauses it; *Copy history* carries on where it stopped.
5. When it says *Done*, press *Check results*.

**Reading the results:**

- *Plays copied* against the old history. The same play recorded twice within ten minutes (the same episode under two ids, or a retried scrobble) is kept once; an entry with no id at all cannot be copied (nothing can show it today either). Both are counted, with examples.
- *Accounts with fewer plays than their old history* should be 0, or explained by those two reasons. The examples say which.
- *Titles TMDB could not place yet* are **kept**, with the id they had, and tried again later.
- *Failed accounts* names each account the copy could not finish and why. The rest carry on.

**Running it again:** *Copy history* does nothing once the copy is done. *Start over* copies every account again from the start: what an earlier copy made is replaced, so the copy matches the old storage as it is now. Plays recorded some other way (once scrobbles go to the new database, P3c-4) are kept.

## 13. Serving watch history from the activity database (P3c-6)

`FF_EVENT_TRACKING` switches watch history over to the activity database. For each account whose history copy (§12) has finished, Watch History, show progress, and what people hid or finished are then read from the activity database and written there. The old storage stops being written: the tracking record in KV, the scrobble queue, and the D1 tracking tables. The website, Stremio and Nuvio see the same things as before; the tests compare them.

**This is one-way for each account it covers.** Once an account is served from the activity database, its old records stop moving, so turning the flag off would show them as they were on the day it was turned on. Once set, leave it set.

**Before turning it on:**

1. The activity database is bound and migrated (§2, §4), and migration `0017` is applied.
2. The copy (§12) says *Done*, and *Check results* shows no failed accounts you have not looked at, and no account with fewer plays than its old history that you cannot explain.
3. Back up D1 (§5), and export the tracking keys from KV (`creatorsynctracking:`) if you want a copy of the old records.

**Turning it on:** Worker → Settings → Variables and Secrets → Add → type *Text*, name `FF_EVENT_TRACKING`, value `1`. Deploy.

**What happens then:**

- Accounts whose copy has finished are served from the activity database straight away. Any other account stays on the old storage until *Copy history* has copied it. *Start over* is refused while the flag is on.
- Continue Watching and Airing Next are shown as they were last worked out, as today. Working them out from the show schedule comes with `FF_SHOW_SCHEDULE`, after the schedule job exists (Phase 5).
- Known differences:
  - Watch History shows an episode as "Episode N" with the show's poster, where the old record kept the episode's own title and still.
  - The website's list is capped at the latest 5,000 plays; the database keeps them all.

## 14. The provider breaker (P4-4)

`FF_PROVIDER_BREAKER` protects the site when a provider (TMDB, Trakt, MDBList, Simkl, JustWatch, RapidAPI, TVmaze, Cinemeta) is down. Without it, every request that needs that provider waits for the call to time out (10 to 30 seconds) before the last good copy is shown. That wait is repeated for every row on every Stremio home screen, for as long as the outage lasts.

**What it does:** after five failures in a row (no answer, a server error, or "too many requests"), calls to that provider are refused for one minute. Rows that have a saved copy show it at once; rows that don't show their usual "couldn't load" state. After the minute, one call is let through: if it works, everything goes back to normal; if not, the provider is skipped for another minute. A wrong key or a title that doesn't exist does not count as a failure.

Each Worker copy keeps its own count. The first one to find a provider down writes `pb:<provider>` to KV (it expires by itself after a minute), and other copies read it before calling that provider for a catalog row, so the whole site skips a dead provider within about a minute.

**Turning it on:** Worker → Settings → Variables and Secrets → Add → type *Text*, name `FF_PROVIDER_BREAKER`, value `1`. Deploy. **Turning it off:** delete the variable and deploy. Both are safe at any time; nothing is stored except the short-lived `pb:` keys.

**Watching it:** with the `ANALYTICS` binding, each Worker copy writes one point per provider at most once a minute, with index `provider`: blobs `["provider", <id>, "open" | "closed"]` and doubles `[calls, failures, calls refused, total wait in ms, times opened]`. The Worker's logs also say `[ProviderBreaker] <provider>: 5 failures in a row` each time one opens.

## 15. Chart snapshots (P4-3)

`FF_CHART_SNAPSHOTS` makes every TMDB, Trakt and Simkl chart row (Popular, Trending, Top 10, genres, kids, holidays, Hidden Gems) come from one shared copy per page, kept in KV under `snap:chart:...`. Everyone with the same chart, region and settings reads the same copy.

**How it behaves:** a copy is fresh for two hours. After that it is still served straight away, and a new one is built in the background. If the provider answers with an empty chart, or fails, the old copy stays (a chart is never really empty), and that copy is not rebuilt again for five minutes. Copies are kept for a week, so an outage makes charts older, not empty. Your own charts (Most Watched, New on Streaming) are copies already and are not affected.

**Turning it on:** Worker → Settings → Variables and Secrets → Add → type *Text*, name `FF_CHART_SNAPSHOTS`, value `1`. Deploy. **Turning it off:** delete the variable and deploy. Both are safe at any time. The `snap:chart:` keys expire by themselves after a week; they can also be deleted by hand, and are rebuilt when next asked for.

**Refreshed in the background (P5-5):** with the queue (§18) running, the hourly `chart.refresh` job rebuilds every chart page used in the last three days, for each region asked for, so visitors are never the ones waiting for a rebuild. It notes what is in use in small `snap:chartuse:` keys (they expire after three days). While the switch is on, the old chart warm-up leaves these charts to it.

**Cost:** one KV read per chart row per Worker copy per minute at most (each copy remembers what it read for a minute), and one KV write per chart page every two hours while someone is asking for it.

## 16. The nightly provider check (P4-5)

`.github/workflows/provider-live-check.yml` runs every night (and from Actions → *Provider live check* → *Run workflow*). It asks each provider the site reads one real question and checks that the answer still has every field the site depends on. When a provider changes something, the run fails and its summary names the provider and the field, so it can be fixed before catalogs go empty. It never writes anything.

The keyless providers (MDBList public lists, Simkl's charts, TVmaze, Cinemeta, JustWatch) are checked with no setup. To check the others, add these repository secrets (Settings → Secrets and variables → Actions), with the same values the Worker uses. Each is optional; a provider without its key shows as *skipped*.

| Secret | Checks |
|---|---|
| `TMDB_API_KEY` | TMDB charts, details, lookups, collections and lists |
| `TRAKT_CLIENT_ID` | Trakt charts and list items |
| `MDBLIST_API_KEY` | MDBList Popular Lists |
| `RAPIDAPI_KEY` | RapidAPI's changes feed. Only if the RapidAPI engine is in use: each run spends one request of its monthly quota. |

`SIMKL_CLIENT_ID` can be added too, but nothing needs it today: Simkl's chart files are public.

**When it fails:** open the run and read its summary. *HTTP 401/403* means a key is wrong or expired. *HTTP 404* on a sample means the sample itself went away, and the fixture's `live` request needs a new one. A named field (for example `results[].title is missing`) means the provider changed its answer: the fetcher that reads it (the fixture's `usedBy`) needs updating, along with the fixture.

## 17. Canonical ids in Stremio catalogs (P4-2)

`FF_CANONICAL_IDS` makes every title a Stremio (or Nuvio, wako) catalog serves carry an id the apps and other add-ons can open:

- an IMDb id (`tt...`) wherever one is known: on the row itself, or in the site's `media` table (migration 0016);
- otherwise `tmdb:<number>`;
- a channel keeps its own id.

Before, some rows passed on whatever id they had, and the app showed a tile that opened to "not found". The main case is an episode in a storyline list, which was sent under TMDB's number for the episode; it now opens its show. Anime ids from Kitsu, MyAnimeList, AniList and AniDB are kept when the site doesn't know the title's IMDb or TMDB id, because anime add-ons read them. A row with an id nothing can open is left out, and a title that appears twice in one row is shown once.

The website's previews are not affected. They still show a storyline list's episodes one by one.

**One thing to know before turning it on:** where the site knows a title's IMDb id, a title that was served as `tmdb:<number>` is now served under its IMDb id. Stremio treats that as a different title, so anything someone saved in Stremio itself under the old id (its own library or Continue Watching) stays under the old id. The site's own shelves are not affected.

**Turning it on:** Worker → Settings → Variables and Secrets → Add → type *Text*, name `FF_CANONICAL_IDS`, value `1`. Deploy. **Turning it off:** delete the variable and deploy; rows go back to the ids they had. Neither stores anything.

## 18. The background jobs queue (P5-1)

From Phase 5, background work (refreshing charts and show schedules, imports, clean-ups) runs as **jobs** on a Cloudflare Queue, `mylists-jobs`, instead of inside a web request or a cron tick. This Worker both puts jobs on the queue and takes them off. A job that fails is tried again a little later (after 30 seconds, then 1, 2, 4 and 8 minutes); after five retries it is moved to a second queue, `mylists-jobs-dlq` (the "dead-letter queue"), where it waits to be looked at instead of being lost.

**Setting it up** (once, in the Cloudflare dashboard):

1. **Storage & Databases → Queues → Create queue**, name `mylists-jobs`.
2. Create a second queue the same way, name `mylists-jobs-dlq`.
3. Open `mylists-jobs` → **Settings** → **Consumers** → **Add consumer**:
   - consumer: this Worker (the My Lists Worker);
   - batch size `25`;
   - max retries `5`;
   - max wait time (batch timeout) `5` seconds;
   - dead letter queue: `mylists-jobs-dlq`.
   Leave `mylists-jobs-dlq` without a consumer.
4. **Workers & Pages** → the My Lists Worker → **Settings → Bindings → Add → Queue**, variable name `JOBS`, queue `mylists-jobs`. Deploy.
5. **Check it:** `/admin` → Maintenance → **Background jobs queue** should say *bound*. Press **Send a test job**. Within a few seconds it should say *Round trip works*. If it says the job was not picked up, step 3 is missing or names another Worker.

**Order does not matter**, and nothing breaks before it is done: without `JOBS` nothing is sent to a queue, and every piece of work that has not moved to jobs yet runs exactly as before.

**Watching it:**

- **Queues → `mylists-jobs` → Metrics** shows how many jobs are waiting and how old the oldest is. A backlog that keeps growing means jobs arrive faster than they finish; the Worker's *Logs* say which job type is failing (`[Jobs] <type> failed`).
- **Queues → `mylists-jobs-dlq` → Messages** lists the jobs that failed six times (Cloudflare keeps them for 4 days). Each shows its `type` and its `payload` (what it was for). Scheduled work is simply made again by its next run once the cause is fixed; the handover notes of each job type say what to do about one that is not.
- With the `ANALYTICS` binding, each batch writes one point per job type, index `job`: blobs `["job", <type>, <queue>]` and doubles `[jobs, done, tried again, dropped, milliseconds spent]`.

**Turning it off:** delete the `JOBS` binding and deploy. Jobs already waiting stay on the queue and run when it is bound again (or expire after 4 days). Removing the consumer (step 3) while `JOBS` is still bound makes jobs pile up unrun, so remove the binding first.

**What runs on it (P5-2):** once `JOBS` is bound, the cron's work runs as seven jobs (`cron.episodes`, `cron.airing-next`, `cron.new-on-streaming`, `cron.charts`, `cron.better-posters`, `cron.channel-presets`, `cron.housekeeping`). `/admin` → Maintenance → **Check jobs** shows each one's last run. A job the queue does not pick up within 10 minutes is run by the cron itself, so a broken queue slows the work but never stops it. Needs migration 0016; without it the cron does the work itself, as before.

**Show schedules (P5-3):** `show.watchers` (daily) counts who watches each show, and `show.refresh` (hourly) checks those shows with TMDB and TVmaze. They need migration 0017, the activity database (`DB_ACTIVITY`, with the history copied, §12) and `TMDB_API_KEY`. Without them they do nothing. **Check jobs** shows both.

**Comparing the shelves (P5-4):** `shelf.shadow` (hourly) compares each copied account's stored Continue Watching and Airing Next with the ones worked out from the show schedules. It only reads. After the queue, the activity database and the history copy are running, leave it for a week, then look at **Check jobs**: the line under `shelf.shadow` gives the difference. Under 1% means the new shelves can be switched on (`FF_SHOW_SCHEDULE`, in a later release).

**Better Posters (P5-9):** with both `BLOBS` (§2) and the queue bound, Better Posters are stored in R2 (`img/bp/...`) and fetched from btttr.cc by `poster.fetch` jobs, so no page or Stremio row waits on btttr.cc. Posters already stored in KV keep being served and move to R2 as they are used.

## 19. Building a home screen once (P5-11)

`FF_MATERIALIZER` only matters for installs with **Remove duplicate items across lists** turned on. For those, each Stremio row used to rebuild every row above it to know what to hide, so a 20-row home screen did about 210 row builds. With the switch on, the first page of every row is built once, duplicates are removed in one pass, and the result is kept for an hour (in KV as `snap:mat:...`, one key per install). A home screen then costs at most one build per row per hour. Personal rows (Watchlist, Continue Watching and the like) are never de-duplicated and are unaffected, as are pages after the first.

**Turning it on:** Worker → Settings → Variables and Secrets → Add → type *Text*, name `FF_MATERIALIZER`, value `1`. Deploy. **Turning it off:** delete the variable and deploy. Both are safe at any time; the `snap:mat:` keys expire by themselves within an hour. A change to an install (rows added, removed or reordered) is picked up at once, as a new build.

## 20. The new UI shell (P6-1)

The frontend rebuild (Phase 6) is being built behind a **cookie**, not a Worker variable, so the owner can walk the new interface on their own device while everyone else keeps the page they know, and a rollback is one cookie rather than a deploy.

**What it changes:** with the cookie set, the six views have real addresses — `/catalogs`, `/catalogs/quickadd`, `/lists/liked`, `/channels/explore`, `/discover/movies`, `/search`, `/settings/account` and so on — the tabs are ordinary links (middle-click and open-in-a-new-tab work), every view keeps the same panels it has today, and an install bar above the tabs says whether this browser's install link is up to date. Settings → Account & Sync also gains four cards at the top -- account, devices, connections and install links -- which read and change things on the server (sign out, delete the account, sign devices out, connect a provider, revoke an install link).

**What it needs on the server:** the screens that read or change *your account* -- Settings' four cards, and Imports below -- go through the session cookie (`/api/me`, `/api/imports`, ...), which is what `FF_SESSIONS=1` turns on. With it unset those screens say you are not signed in, and the import API answers 401; nothing else on the page is affected. Set it in the dashboard (Worker → Settings → Variables) before trying them, and remember that turning it off again signs every browser out.

**Turning it on for yourself:** open

```
https://mylistsaddon.com/?ff_new_ui=1
```

You are bounced back to the page you asked for, without the parameter, and the cookie is set for a year. Do the same on your phone (or any browser) to try it there; the cookie is per browser.

**Turning it off:** `https://mylistsaddon.com/?ff_new_ui=0` — same bounce, cookie cleared. Nothing is stored server-side either way, so no data is affected and nothing has to be undone.

**For everyone at once** (later, when Phase 6 is finished): the plan is a Worker variable, `FF_NEW_UI=1`, defaulting off, once the whole frontend is behind it. Until then the cookie is the only switch, and nobody without it sees any change at all — the shell's paths still 404 for them, exactly as before.

## 21. What P6-8 changed for everyone

**Nothing to configure.** Unlike P6-1 to P6-7, this one is not behind the new-UI cookie: it is the page's own markup and this browser's own storage, so it reaches every visitor once the new `worker_entry_combined.js` is deployed. Nothing in the dashboard, no migration and no variable.

- **Every control names its action.** The buttons, boxes and lists in the builder no longer carry a line of JavaScript in the markup; a single listener runs them (`appActDispatch`, `16_client-row-core.js`). If a control ever "does nothing" in the new build, the browser console says `Action failed: <name>` (once per name) instead of failing silently, and `verify.sh`/`html_checks.py` fail the build if a name does not exist in the bundle.
- **No more browser pop-ups.** A message that used to be an `alert()` is now the app's own toast, bottom centre; anything that needed a yes/no is the app's own dialog.
- **Provider keys are no longer re-saved in the browser.** A Trakt, MDBList, Simkl or TMDB key or token lives in memory while the page is open, is read from the old stored copy if one is there, and the stored copy is cleaned up once the account (signed in) hands the same value back. Consequence to know: if a visitor is **not signed in** and pastes a key, it works for that visit but is not kept for the next one — signing in is what saves it. The Creator Key itself is untouched (it is what signs this browser in; it moves in P6-9).
- **Nothing to undo** if the deploy has to be rolled back: the previous file re-stores what the old page stored.

## 22. Lists that live in one browser (P6-9)

**Nothing to configure.** Like P6-1 to P6-7 this screen is only reachable with the new-UI cookie (§20); no migration, no variable and no dashboard change. The old page is untouched, and the API call it makes (`POST /api/creator/lists/save`) is the one the sign-up migration has always used.

**What changed:** Lists now shows the account's lists **and** the lists this browser keeps on its own (a list built while signed out lives in `myListAddon:localCustomLists` and stays there through a sign-in, because nothing migrates it at that moment). A list the account does not have is labelled **"Saved in this browser only"** and carries **Save to an account** and **Export** instead of Share.

- **How a list is known to be browser-only.** Every list the account owns is mirrored into the local map with a `creatorSlug`; an entry without one has never been sent to an account. That is a lookup, not a guess — which is why the view waits ("Loading your lists…") while signed in until the account's own list has arrived: the local map is a *cache* of the account's lists in that state, and rendering early would label an account's list as browser-only.
- **Save to an account, signed in.** The list is posted as **private**, the row that pointed at the local copy is re-pointed at the account's, and the browser's copy is deleted *after* the account confirms it has the list. A failure leaves the browser's copy alone and says so.
- **Save to an account, signed out.** Signing in runs `clearLocalAccountData()`, which empties this browser's list store, so the list is copied into a pending queue *before* the sign-in dialog opens and pushed the moment the sign-in completes (a new account pushes the queue after its one-time migration of everything else, so nothing is sent twice). Both outcomes are announced in a toast.
- **Export** downloads that one list as the small JSON file Settings › Backups › Restore already reads (`version: "3.0"`, one entry in `customLists`), so it can be restored in any browser.
- **Nothing merges by itself.** Signing in to an account that already has lists does not sweep the browser's lists into it; each one waits for its own button. That is deliberate: an automatic merge cannot tell a list the account already has from one it does not, and would duplicate it.
- **Not offered for the generated shelves** (Watchlist, Watch History, Continue Watching, Airing Next): their content travels with the account's tracking record, and "saving" one would either duplicate it or invent a list.
- **Nothing to undo** if the deploy is rolled back: the browser's store is the same store the old page uses, and a list moves only when someone presses the button.

**If something looks wrong:** the console names the action that failed (`Action failed: <name>`), and a list that did not move is still in this browser — reload Lists and it is there.
