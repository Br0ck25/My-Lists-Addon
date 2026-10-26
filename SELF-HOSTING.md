# Run your own My Lists Addon on Cloudflare

The public site, mylistsaddon.com, is shutting down on **November 8, 2026** unless donations cover its running costs. You can keep everything you have built by running your own copy. This guide walks you through it. You do not need to be a programmer: every step is a click or a copy and paste.

**What you get:** the same website and add-on, on your own Cloudflare account, with your own address (for example `https://my-lists-addon.yourname.workers.dev`). Only you (and whoever you share the address with) use it.

**What it costs:** the code needs Cloudflare's **Workers Paid** plan, which is **$5 a month** at the time of writing. One person's use normally stays inside what that includes. The Free plan is **not** supported: it allows far too few outbound requests per visit. Check [Cloudflare's pricing page](https://developers.cloudflare.com/workers/platform/pricing/) for the current price.

**How long it takes:** about 30 minutes the first time.

> Prefer a terminal? Skip to [Method B: one command per step](#method-b-from-a-terminal).

---

## Before you start: back up your data on the public site

Do this while mylistsaddon.com is still up.

1. Open [mylistsaddon.com](https://mylistsaddon.com), sign in if you have an account.
2. Click **Back up my data** in the notice at the top, or go to **Settings → Presets & Backup → Download Backup File**.
3. Keep the file `my-lists-full-backup.json` somewhere safe. It holds your catalogs, custom lists, watchlist, watch history, channels, presets and settings.
4. Optional: under **Export Lists & History** on the same page you can also download your history and lists as CSV files for Trakt, Letterboxd or Simkl.

> **Keep the backup file private.** It can contain the keys of the services you connected (Trakt, MDBList, TMDB and so on). Do not post it anywhere.

---

## What you need

- A free [Cloudflare account](https://dash.cloudflare.com/sign-up) with a payment card, so you can switch on **Workers Paid** (Workers & Pages → Plans).
- A free **TMDB API key**: create an account at [themoviedb.org](https://www.themoviedb.org/), then Settings → API. This powers search and posters.
- Optional keys for the services you use: Trakt, MDBList, Simkl. You can add them later.
- The files from this repository (you will copy and paste from them):
  - [`schema.sql`](schema.sql): the whole main database, ready to paste.
  - [`schema_activity.sql`](schema_activity.sql): the watch history database, ready to paste.
  - [`worker_entry_combined.js`](worker_entry_combined.js): the whole program, in one file.

**How to copy a file from GitHub:** open it, click **Raw** (top right of the file), press `Ctrl+A` (Mac: `Cmd+A`) to select everything, then `Ctrl+C` (Mac: `Cmd+C`) to copy.

---

## Method A: in the Cloudflare dashboard (no terminal)

Open [dash.cloudflare.com](https://dash.cloudflare.com) and follow the steps in order. Names matter: use the ones shown, in the same spelling.

### Step 1. Switch on Workers Paid

**Workers & Pages → Plans → Workers Paid → Subscribe.**

### Step 2. Create the main database

1. **Storage & Databases → D1 SQL database → Create database.**
2. Name: `my-lists-db`. Create it.
3. Open it, then the **Console** tab.
4. Open [`schema.sql`](schema.sql) on GitHub, copy the **entire file** (see "How to copy a file" above), paste it into the Console and press **Execute**.
5. It is safe to run twice: nothing is deleted. When it finishes, run `SELECT name FROM sqlite_master WHERE type='table';` and check that you see a long list of tables (`creators`, `lists`, `media`, and more).

### Step 3. Create the watch history database

1. **Storage & Databases → D1 SQL database → Create database.**
2. Name: `mylists-activity`. Create it.
3. Open it, then **Console**. Paste the **entire** [`schema_activity.sql`](schema_activity.sql) and press **Execute**.

> The two databases are separate. Paste `schema.sql` only into `my-lists-db` and `schema_activity.sql` only into `mylists-activity`.

### Step 4. Create the key-value store

**Storage & Databases → KV → Create a namespace.** Name: `my-lists-configs`.

### Step 5. Create the file bucket

**Storage & Databases → R2 object storage → Create bucket.** Name: `mylists-blobs`. (R2 asks for a card; normal use stays inside its free allowance.)

### Step 6. Create the job queues

**Compute → Queues → Create queue**, twice:

1. `mylists-jobs-dlq`
2. `mylists-jobs`

### Step 7. Create the Worker and paste the code

1. **Workers & Pages → Create → Create Worker.**
2. Name: `my-lists-addon`. Click **Deploy** (it deploys a small "Hello World" first).
3. Click **Edit code**. Select everything in the editor and delete it.
4. Copy the **entire** [`worker_entry_combined.js`](worker_entry_combined.js) (about 5.5 MB, so give the copy a moment) and paste it in.
5. Click **Deploy**.

If the editor is too slow with a file this size, use [Method B](#method-b-from-a-terminal) for this step; everything else stays the same.

### Step 8. Connect everything to the Worker

Open the Worker, then **Settings → Bindings → Add**. Add these five, with exactly these names:

| Type | Variable name | Choose |
|---|---|---|
| D1 database | `DB` | `my-lists-db` |
| D1 database | `DB_ACTIVITY` | `mylists-activity` |
| KV namespace | `CONFIGS` | `my-lists-configs` |
| R2 bucket | `BLOBS` | `mylists-blobs` |
| Queue | `JOBS` | `mylists-jobs` |

Then connect the queue back to the Worker: **Compute → Queues → `mylists-jobs` → Settings → Consumers → Add consumer**: Worker `my-lists-addon`, batch size `25`, batch timeout `5`, max retries `5`, dead letter queue `mylists-jobs-dlq`.

### Step 9. Add the secrets

**Worker → Settings → Variables and Secrets → Add**, type **Secret** for each:

| Name | Value |
|---|---|
| `ADMIN_KEY` | A long password you make up. It opens `/admin`. |
| `TMDB_API_KEY` | Your TMDB key. |
| `TOKEN_ENCRYPTION_KEY` | See below. **Never change or delete it later.** |
| `LOOKUP_PEPPER` | See below. **Never change or delete it later.** |

Optional, add only for what you use: `TRAKT_CLIENT_ID`, `TRAKT_CLIENT_SECRET`, `MDBLIST_API_KEY`, `SIMKL_CLIENT_ID`, `SIMKL_CLIENT_SECRET`.

**Making the two random values:** press `F12` in your browser, open the **Console** tab, paste this line and press Enter. It prints both, ready to copy:

```js
const r=()=>btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))); console.log('TOKEN_ENCRYPTION_KEY = k1:'+r()); console.log('LOOKUP_PEPPER = '+r());
```

Copy the part after the `=` into each secret (for the first one that includes the `k1:`). **Save both in a password manager.** Without the encryption key, your stored tokens cannot be read again.

### Step 10. Add the settings (variables)

Same page, **Add**, type **Text**, one per line:

| Name | Value |
|---|---|
| `FF_SESSIONS` | `1` |
| `FF_INSTALLS` | `1` |
| `FF_V2_LISTS_READ` | `1` |
| `FF_V2_LISTS_API` | `1` |
| `FF_V2_LISTS_ONLY` | `1` |
| `FF_EVENT_TRACKING` | `1` |
| `FF_PROVIDER_BREAKER` | `1` |
| `FF_CHART_SNAPSHOTS` | `1` |
| `FF_CANONICAL_IDS` | `1` |
| `FF_MATERIALIZER` | `1` |
| `FF_SCROBBLE_ST_ONLY` | `1` |
| `INSTALL_MIGRATION_PERCENT` | `100` |

These match what the public site runs. Set them now, on an empty database, and leave them set.

### Step 11. Add the schedule

**Worker → Settings → Triggers → Add → Cron Trigger**, value `*/5 * * * *` (every 5 minutes). Without it new episodes never reach Continue Watching and charts go stale.

### Step 12. Open it

**Worker → Settings → Domains & Routes** shows your address, `https://my-lists-addon.<your-name>.workers.dev`. Open it. You should see the My Lists Addon page.

Check the setup: open `https://<your-address>/admin`, sign in with your `ADMIN_KEY`, go to **Maintenance → Check schema**. It should report the database as current.

---

## Method B: from a terminal

Needs [Node.js 20 or newer](https://nodejs.org/). Copy and paste these lines one block at a time.

```bash
git clone https://github.com/Br0ck25/My-Lists-Addon.git
cd My-Lists-Addon
npx wrangler login
```

Create everything and load the databases:

```bash
npx wrangler d1 create my-lists-db
npx wrangler d1 create mylists-activity
npx wrangler kv namespace create CONFIGS
npx wrangler r2 bucket create mylists-blobs
npx wrangler queues create mylists-jobs-dlq
npx wrangler queues create mylists-jobs
npx wrangler d1 execute my-lists-db --remote --file=./schema.sql
npx wrangler d1 execute mylists-activity --remote --file=./schema_activity.sql
```

Each create command prints an id (`database_id`, or the KV `id`). Open [`wrangler.selfhost.toml`](wrangler.selfhost.toml) and replace the three `PASTE-...-ID-HERE` values with them. Nothing else in it needs changing.

Add the secrets. Each command asks you to paste the value (see Step 9 above for what each one is and how to make the two random ones):

```bash
npx wrangler secret put ADMIN_KEY -c wrangler.selfhost.toml
npx wrangler secret put TMDB_API_KEY -c wrangler.selfhost.toml
npx wrangler secret put TOKEN_ENCRYPTION_KEY -c wrangler.selfhost.toml
npx wrangler secret put LOOKUP_PEPPER -c wrangler.selfhost.toml
```

Deploy:

```bash
npx wrangler deploy -c wrangler.selfhost.toml
```

It prints your address. The settings of Step 10 and the schedule of Step 11 are already in `wrangler.selfhost.toml`.

---

## Moving your lists in

1. Open your new address.
2. Create your account (**Creator Profile**): a username and a Creator Key. **Save the key.** Accounts are not copied from the public site, only your data is.
3. Go to **Settings → Presets & Backup → Upload & Restore File** and choose `my-lists-full-backup.json`.
4. Add your service connections again under **Settings → Connected Services** if you use Trakt, MDBList or Simkl.
5. **Install the add-on again.** Your install link contains your site's address, so it is new: click **Install Addon** on your own site and add it to Stremio, Nuvio or Wako. Remove the old mylistsaddon.com add-on there.

---

## Keeping it running

**Updating to a newer version:** copy the new `worker_entry_combined.js` over the Worker's code (Step 7) and deploy, or run `git pull` and `npx wrangler deploy -c wrangler.selfhost.toml`. When a release adds a file to [`migrations/`](migrations/), paste that file into the `my-lists-db` Console **before** deploying. `SELECT version FROM schema_migrations ORDER BY version;` shows what is already applied; run only the files after it, in order.

**Backing up your own copy:** use **Download Backup File** in Settings now and then. D1 also keeps 30 days of point-in-time recovery (database → **Time Travel**).

**Sharing it:** anyone with your address can create an account on it. Share it only with people you want to pay for.

**Troubleshooting**

| You see | Do this |
|---|---|
| A blank page or "Worker threw exception" | Worker → **Logs**. Most often a binding name is misspelled (Step 8). Names are case-sensitive. |
| "My Lists is being updated" | A database step is missing. Re-run Step 2 and Step 3. |
| Search finds nothing | `TMDB_API_KEY` is missing or wrong (Step 9). |
| Watch history stays empty | `DB_ACTIVITY` is not bound, or `schema_activity.sql` was not run (Steps 3 and 8). |
| `/admin` rejects your key | Re-enter `ADMIN_KEY` in Step 9, then deploy again. |

More detail for operators: [`docs/OPERATIONS.md`](docs/OPERATIONS.md) (bindings, secrets, migrations, backups).

This project is licensed for noncommercial use ([PolyForm Noncommercial 1.0.0](LICENSE)). Running it for yourself and friends is fine; it comes with no support.
