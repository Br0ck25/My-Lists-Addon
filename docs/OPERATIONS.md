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
2. **Apply database migrations first** if the release adds any (see §4). A Worker that needs a newer schema than the database has refuses writes with a maintenance message rather than failing silently. That guard only works once migration `0014` is applied.
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
| `DB_ACTIVITY` | D1 database (`mylists-activity`) | Later (Phase 3c) | Watch events and progress | Not yet |
| `BLOBS` | R2 bucket (`mylists-blobs`) | Later (Phase 3b/5) | Posters, channel pools, exports, D1 backups | Not yet |
| `JOBS` | Queue producer (`mylists-jobs`) | Later (Phase 5) | Background jobs | Not yet. The queue **consumer** is configured on the queue: Queues → `mylists-jobs` → Settings → Add consumer → this Worker. |

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

**Plain variables:**

- `NEW_ON_STREAMING_ENGINE` (optional; default `justwatch`).
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
