# Staging Environment Guide (P9-5) — mylistsaddon.com

This document describes the dedicated staging environment for **My Lists Addon**, including its isolated topology, resource provisioning instructions, fixture seeding, and validation workflows.

---

## 1. Architectural Isolation Guarantee

The staging environment operates with **100% resource isolation** from production:

- **Isolated Authoritative Stores:** Staging runs against dedicated D1 databases (`my-lists-db-staging` and `mylists-activity-staging`) and a dedicated KV namespace. No staging read or write ever touches production data.
- **Isolated Blob Storage & Queues:** Shared channel pools, backups, and media artifacts live in `mylists-blobs-staging`. Background queue processing runs on `mylists-jobs-staging` with its own dead-letter queue (`mylists-jobs-staging-dlq`).
- **Independent Cryptographic Secrets:** Staging uses its own `TOKEN_ENCRYPTION_KEY`, `LOOKUP_PEPPER`, and `ADMIN_KEY`. Staging tokens cannot decrypt production records, and production tokens cannot decrypt staging records.
- **Preview Feature Flags:** Advanced flags (`FF_SESSIONS`, `FF_V2_LISTS_READ`, `FF_EVENT_TRACKING`, `FF_SHOW_SCHEDULE`) are activated on staging ahead of production to rehearse transitions and verify zero-regression contracts.

---

## 2. Resource Topology: Production vs Staging

| Component | Production | Staging | Purpose |
|---|---|---|---|
| **Worker Service** | `my-lists-addon` | `my-lists-addon-staging` | Edge runtime and API proxy |
| **Public Route** | `mylistsaddon.com` | `staging.mylistsaddon.com` (or `*.workers.dev`) | Ingress URL |
| **D1 Main DB (`DB`)** | `my-lists-db` | `my-lists-db-staging` | Accounts, lists, likes, channels, search |
| **D1 Activity DB (`DB_ACTIVITY`)** | `mylists-activity` | `mylists-activity-staging` | Watch history events, show progress |
| **KV Namespace (`CONFIGS`)** | `my-lists-configs` | `my-lists-configs-staging` | Legacy install configs, caches |
| **R2 Bucket (`BLOBS`)** | `mylists-blobs` | `mylists-blobs-staging` | Channel episode pools, backups |
| **Queue (`JOBS`)** | `mylists-jobs` | `mylists-jobs-staging` | Asynchronous background processing |
| **Dead-Letter Queue** | `mylists-jobs-dlq` | `mylists-jobs-staging-dlq` | Poison pill and failed job storage |
| **Analytics Engine (`ANALYTICS`)** | `mylists_events` | `mylists_events_staging` | Edge telemetry and performance metrics |

---

## 3. Provisioning the Staging Environment

### Option A: Via Cloudflare Dashboard (Recommended)

1. **Create the Staging Worker:**
   - Workers & Pages $\to$ **Create Application** $\to$ Name: `my-lists-addon-staging`.
2. **Create D1 Databases:**
   - Storage & Databases $\to$ **D1** $\to$ **Create Database** $\to$ `my-lists-db-staging`.
   - In its Console, execute the complete [`schema.sql`](../schema.sql).
   - Create the activity database: `mylists-activity-staging`.
   - In its Console, execute [`schema_activity.sql`](../schema_activity.sql).
3. **Create KV Namespace:**
   - Storage & Databases $\to$ **KV** $\to$ **Create Namespace** $\to$ `my-lists-configs-staging`.
4. **Create R2 Bucket:**
   - Storage & Databases $\to$ **R2** $\to$ **Create Bucket** $\to$ `mylists-blobs-staging`.
5. **Create Queues:**
   - Compute $\to$ **Queues** $\to$ **Create Queue** $\to$ `mylists-jobs-staging-dlq`.
   - Create Queue $\to$ `mylists-jobs-staging`.
   - In `mylists-jobs-staging` $\to$ **Settings** $\to$ **Add Consumer**:
     - Worker: `my-lists-addon-staging`
     - Batch size: `25`
     - Batch timeout: `5` seconds
     - Max retries: `5`
     - Dead-letter queue: `mylists-jobs-staging-dlq`
6. **Configure Bindings in `my-lists-addon-staging`:**
   - Settings $\to$ **Bindings** $\to$ Add:
     - D1: `DB` $\to$ `my-lists-db-staging`
     - D1: `DB_ACTIVITY` $\to$ `mylists-activity-staging`
     - KV: `CONFIGS` $\to$ `my-lists-configs-staging`
     - R2: `BLOBS` $\to$ `mylists-blobs-staging`
     - Queue: `JOBS` $\to$ `mylists-jobs-staging`
     - Analytics Engine: `ANALYTICS` $\to$ dataset `mylists_events_staging`
7. **Configure Staging Secrets:**
   - Settings $\to$ **Variables and Secrets** $\to$ Add (type *Secret*):
     - `ADMIN_KEY`: Staging dashboard access key
     - `TOKEN_ENCRYPTION_KEY`: `k1:` followed by 32-byte base64 random (`openssl rand -base64 32`)
     - `LOOKUP_PEPPER`: 32-byte base64 random (`openssl rand -base64 32`)
     - `TMDB_API_KEY`, `TRAKT_CLIENT_ID`, `TRAKT_CLIENT_SECRET`, `MDBLIST_API_KEY`, `SIMKL_CLIENT_ID`

---

### Option B: Via Wrangler CLI

Run these commands using your Cloudflare account credentials:

```bash
# 1. Create Staging KV
npx wrangler kv namespace create CONFIGS --env staging

# 2. Create Staging D1 Databases & Apply Schemas
npx wrangler d1 create my-lists-db-staging
npx wrangler d1 execute my-lists-db-staging --file=./schema.sql --remote

npx wrangler d1 create mylists-activity-staging
npx wrangler d1 execute mylists-activity-staging --file=./schema_activity.sql --remote

# 3. Create Staging R2 Bucket
npx wrangler r2 bucket create mylists-blobs-staging

# 4. Create Staging Queues
npx wrangler queues create mylists-jobs-staging-dlq
npx wrangler queues create mylists-jobs-staging

# 5. Set Staging Secrets
npx wrangler secret put ADMIN_KEY --env staging
npx wrangler secret put TOKEN_ENCRYPTION_KEY --env staging
npx wrangler secret put LOOKUP_PEPPER --env staging
npx wrangler secret put TMDB_API_KEY --env staging

# 6. Deploy Code to Staging
npx wrangler deploy --env staging
```

---

## 4. Seeding Staging with Production-Shaped Fixtures

To validate migration backfills and rehearse cutover under real load without exposing user PII, seed staging using the anonymized fixtures from [`tests/fixtures/migration-fixtures.mjs`](../tests/fixtures/migration-fixtures.mjs):

1. **Accounts:** Seeds 5 diverse creator profiles with PBKDF2 credential hashes and recovery secrets (`cinemabuff99`, `bingewatcher42`, `retrocurator`, `animeotaku`, `communitystar`) plus 1 tombstone (`deleteduser88`).
2. **Lists:** Seeds custom lists with movie/series media, companion titles, notes, a 42-item vault, and anonymous public lists.
3. **Channels:** Seeds scheduled rotating channels, shuffled multi-part arcs, and chronological timelines.
4. **Activity:** Seeds multi-source watch histories, scrobble queues, and show progress dismissals.
5. **Install Links:** Seeds legacy install configurations with encrypted tokens.

---

## 5. Staging Validation & Smoke Testing

Before promoting any release to production, execute the following validation steps against staging:

### A. Health & Route Smoke Tests

```bash
STAGING_URL="https://staging.mylistsaddon.com"

# 1. Verify Home Page HTML & CSP
curl -I "$STAGING_URL/"

# 2. Verify First-View Asset Preload
curl -I "$STAGING_URL/app.js"
curl -I "$STAGING_URL/app-features.js"

# 3. Verify Public Directory Keyset Paging
curl -s "$STAGING_URL/lists/public.json" | grep -q '"ok":true'

# 4. Verify Install Link & Stremio Manifest
curl -s "$STAGING_URL/test_install_id/manifest.json" | grep -q '"id":"com.mylistsaddon"'

# 5. Verify Queue Job Roundtrip
# Log into $STAGING_URL/admin -> Maintenance -> Send a test job
# Ensure no messages appear in mylists-jobs-staging-dlq
```

### B. Automated Load Testing with k6

Run the automated k6 performance suites against staging to verify latency budgets (`PERFORMANCE_AUDIT.md` §5):

```bash
# 1. Catalog Hot Path (Warm p95 < 15ms, Cold p95 < 40ms)
k6 run loadtests/catalog-hot-path.js \
  -e BASE_URL=https://staging.mylistsaddon.com \
  -e INSTALL_ID=test_install_id

# 2. Scrobble Burst (100 req/s, 0% error rate, p95 < 100ms)
k6 run loadtests/scrobble-burst.js \
  -e BASE_URL=https://staging.mylistsaddon.com \
  -e SCROBBLE_TOKEN=test_scrobble_token

# 3. Directory Keyset Paging (20+ pages, p95 < 50ms)
k6 run loadtests/directory-depth.js \
  -e BASE_URL=https://staging.mylistsaddon.com

# 4. Multi-Scenario Suite
k6 run loadtests/run-all.js \
  -e BASE_URL=https://staging.mylistsaddon.com \
  -e INSTALL_ID=test_install_id \
  -e SCROBBLE_TOKEN=test_scrobble_token
```
