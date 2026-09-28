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
| `JOBS` | Queue producer (`mylists-jobs`) | Later (Phase 5) | Background jobs | Not yet. The queue **consumer** is configured on the queue: Queues → `mylists-jobs` → Settings → Add consumer → this Worker. |

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
- `INSTALL_MIGRATION_PERCENT` (optional, `0` to `100`): the share of existing install links whose keys and tokens move into encrypted D1 storage the first time they are used. See §8 before setting it.
- **Delete** these retired variables if they are still set: `BULK_RESOLVE_SUBREQUEST_BUDGET`, `DETAILS_BATCH_SUBREQUEST_BUDGET`, `CRON_SUBREQUEST_BUDGET`. The code ignores them.

**Cron trigger** (Worker → Settings → Triggers): `*/6 * * * *`. Later phases replace this with a 5-minute dispatcher plus hourly and daily triggers.

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
