# Architecture — My Lists Addon v2

This is the steady-state architecture of [mylistsaddon.com](https://mylistsaddon.com) after the
Phase 10 v2 cutover. For the migration history and planning documents that led here, see
[`docs/history/`](history/).

---

## Overview

My Lists Addon is a single **Cloudflare Worker** (`worker_entry_combined.js`) serving every HTTP
request — catalog rows, web UI, API, admin dashboard, scrobble webhooks, and background jobs. The
Worker is deployed by **pasting the built file into the Cloudflare dashboard**; there is no
`wrangler deploy` for production. The build is produced by `python build.py` concatenating 50+
numbered source files (`00_constants.js` through `57_title-details-fallback.js`).

---

## Storage

| Binding | Type | What it stores |
|---|---|---|
| `DB` | D1 (`my-lists-db`) | Accounts, sessions, installs, lists, likes, channels, media, FTS, rate counters, analytics rollups |
| `DB_ACTIVITY` | D1 (`mylists-activity`) | Watch events, show progress, user media state |
| `CONFIGS` | KV namespace | Install configs (`cfg:`), caches, job cursors, short-lived state |
| `BLOBS` | R2 (`mylists-blobs`) | Shared channel episode pools, Better Poster images, KV archives |
| `ANALYTICS` | Analytics Engine (`mylists_events`) | Per-request metrics, pageview stats, feature telemetry |
| `JOBS` | Queue (`mylists-jobs`) | Background job messages (chart refresh, imports, scrobble queue, media retry) |

### Data ownership

- **Accounts, lists, channels, likes:** `DB` (v2 tables after Phase 10).
- **Watch history and progress:** `DB_ACTIVITY` (after `FF_EVENT_TRACKING`).
- **Install configs:** D1 `installs` + `install_secrets`; KV `cfg:` kept (secret-stripped) for
  legacy install IDs until their 30-day window expires.
- **Channel episode pools:** R2 `BLOBS` under `channel/{code}/pool.json.gz`.
- **Short-lived caches:** KV (`snap:chart:*`, `pb:*`, `lastgood:*`) — all expire naturally.

---

## Auth

- **Session auth** (`FF_SESSIONS`): `POST /api/session` → `mla_session` cookie (SHA-256 of a
  random token, stored in `sessions` table). All `/api/creator/*` routes accept it.
- **Install links:** `/i/{token}` (new) and `/{legacyCfgId}` (legacy). Secrets stored encrypted
  in `install_secrets` (`TOKEN_ENCRYPTION_KEY` AES-GCM).
- **Admin:** `ADMIN_KEY` secret + `mla_admin` cookie, optionally behind Cloudflare Access
  (`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`).
- **Scrobble webhooks:** `?st=` token (new); legacy `?config=` and `?creator=&key=` forms sunset
  at Day 60 after Phase 1.

---

## Request Flow

```
Browser / Stremio / scrobble webhook
        │
        ▼
Cloudflare Worker (worker_entry_combined.js)
        │
        ├─ /i/{token}  ──── installs.js ──▶ DB (installs + install_secrets)
        ├─ /{id}/manifest.json, /{id}/catalog/… ──▶ catalog-core.js ──▶ DB + provider APIs
        ├─ /api/creator/* ──▶ 26_api-creator-and-admin-routes.js ──▶ DB + DB_ACTIVITY + CONFIGS
        ├─ /api/lists/* ──▶ 31_lists-api.js ──▶ DB
        ├─ /api/likes/* ──▶ 32_likes-api.js ──▶ DB
        ├─ /api/scrobble* ──▶ 38_activity-scrobble.js ──▶ DB_ACTIVITY
        ├─ /admin/* ──▶ 03_admin.js + 26_api-creator-and-admin-routes.js ──▶ DB + CONFIGS + BLOBS
        └─ (cron / queue message) ──▶ 44_jobs-queue.js → 45_jobs-dispatcher.js → job handlers
```

---

## Feature Flags

All flags are plain Worker environment variables (`1` = on, unset = off).

| Flag | What it enables | One-way? |
|---|---|---|
| `FF_SESSIONS` | Session-based auth | No |
| `FF_INSTALLS` | `/api/installs` install-link management | No |
| `FF_V2_LISTS_READ` | Read lists/channels from D1 v2 tables | No |
| `FF_V2_LISTS_API` | `/api/lists` and `/api/likes` over v2 tables | No |
| `FF_V2_LISTS_ONLY` | Stop writing old list/channel storage | **Yes** |
| `FF_EVENT_TRACKING` | Watch history from `DB_ACTIVITY` per account | **Yes per account** |
| `FF_PROVIDER_BREAKER` | Circuit breaker for external providers | No |
| `FF_MATERIALIZER` | Hour-cached home screen for dedup installs | No |
| `FF_CHART_SNAPSHOTS` | Shared chart snapshots in KV | No |
| `FF_CANONICAL_IDS` | IMDb-preferred IDs in catalog rows | No |

See [`docs/OPERATIONS.md`](OPERATIONS.md) §3 for the full list including `FF_NEW_UI` and
`FF_SHOW_SCHEDULE`. See [`docs/CUTOVER.md`](CUTOVER.md) for the Phase 10 flag-flip runbook.

---

## Background Jobs

The queue consumer (`mylists-jobs`) runs these recurring jobs:

| Job | Cadence | What it does |
|---|---|---|
| `cron.episodes` | Every 5 min | Checks for new episode airings |
| `cron.airing-next` | Every 5 min | Updates Airing Next shelves |
| `cron.charts` | Every 5 min | Refreshes chart snapshots |
| `cron.better-posters` | Every 5 min | Fetches Better Poster images |
| `cron.housekeeping` | Every 5 min | Cleans up rate counters, expired keys |
| `chart.refresh` | Hourly | Rebuilds recently-used chart pages |
| `show.refresh` | Every 5 min | Refreshes show schedule data |
| `shelf.shadow` | Every 5 min | Shadow-compares v1/v2 Continue Watching/Airing Next |
| `recs.build` | Hourly | Rebuilds per-account recommendations |
| `media.retry` | Hourly | Retries unresolved media ID lookups |
| `token.refresh` | Daily | Refreshes expiring OAuth tokens |
| `rollup.daily` | Daily | Writes daily Analytics Engine rollups |

---

## Build & Verify

```bash
python build.py               # concatenate source files → worker_entry_combined.js
python check_sync.py          # verify source files match combined output
node --check worker_entry_combined.js  # syntax check
node check_bundle_budget.mjs  # ≤150 KB first-view bundle budget
python gen_map.py             # regenerate FUNCTION-MAP.md
node --test tests/*.test.mjs  # full test suite
```

After any source change, all five commands must pass before deploying.

---

## Source File Map

Source files are concatenated in numeric order. Client-side JS (`09_` – `24_`) is embedded in
the page HTML by `renderBuilder()`. Server-only files (`00_` – `08_`, `25_` – `57_`) run only in
the Worker process.

See [`FUNCTION-MAP.md`](../FUNCTION-MAP.md) for the complete function/route symbol table
(regenerated by `python gen_map.py` after every change).

---

## Key Design Decisions

- **No framework, no build toolchain.** The Worker is plain JS, built by a Python concatenation
  script. CI uses bare `node --test`. Dependency count is zero at runtime.
- **D1 is the source of truth for all user data** (after v2 cutover). KV is for caches,
  short-lived state, and legacy install config records only.
- **One Worker, one codebase, one deploy artifact.** No separate edge workers, no micro-services.
- **Additive-only migrations.** Migrations only add tables, columns, and indexes. They never drop
  or alter existing columns. An older Worker keeps running against a newer schema.
- **Paste deploy.** The Worker is deployed by pasting `worker_entry_combined.js` into the
  Cloudflare dashboard. `wrangler.toml` is used only for local dev and CI.

For the rationale behind these decisions, see
[`docs/history/NEXT_VERSION_ARCHITECTURE.md`](history/NEXT_VERSION_ARCHITECTURE.md).
