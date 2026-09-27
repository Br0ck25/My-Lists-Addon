# Live AI Agent Handoff Status

> **Notice to Incoming AI**: Read this file first, then `AGENTS.md` and `docs/DECISIONS.md`. It records the current progress, what must not be undone, and what to do next. Do not start over or undo existing work.

---

## Current Status
- **Last Updated**: 2026-09-27
- **Last Active AI**: Antigravity (Gemini 3.8 Flash)
- **Active Task**: Phase 3a in progress. P3a-1 (Migration 0015) and P3a-2 (Token encryption & HMAC blind index) completed and verified. Next task: P3a-3 (Account migration backfill) / P3a-4 (Sessions).
- **Task State**: All tests passing: 1,288 passed, 0 failed, 1 skipped. Build and sync checks verified.
- **Git State**: Ready to commit. Commit and push only when the owner asks.
- **The owner is not a programmer.** Explain in plain words, do the git work for them, and ask before anything that changes stored user data or needs a dashboard change.

---

## Read Before Changing Anything
- `AGENTS.md`: the rules for every assistant (split files only, no npm or frameworks, verify after every change).
- `docs/DECISIONS.md`: the owner's decisions D-1 to D-12. The ones that shape everyday work:
  - **D-3 / D-11:**
    - the code stays in the numbered split files;
    - `python build.py` produces `worker_entry_combined.js`, which the owner pastes into the Cloudflare dashboard;
    - no npm build, no `src/` folder, no frameworks.
  - **D-6:** liking, sharing and publishing need an account.
  - **D-8:**
    - signed out, a visitor can add only the site's public lists (plus storylines and Explore Channels listings) and generate an install link;
    - custom lists, channels, personal shelves and connected accounts need an account.
  - **D-9:** likes cast signed-out in the past keep counting.
  - **D-10:** install links never expire.
  - **D-12:** no email recovery.
- `NEXT_VERSION_TASKS.md`: the task checklist, with a status on every item.
- `docs/OPERATIONS.md`: deploy checklist, bindings, secrets, migrations, backups.
- `CHANGELOG.md`: the `[Unreleased]` section describes everything done since the last deploy.

---

## Safeguards Already in the Code (do not remove or bypass)
These are deliberate. Several are "one place" mechanisms that cover the whole Worker, so they are easy to break by accident.

| Where | What it does |
|---|---|
| Top of `00_constants.js` | A module-level `console` that passes every log line through `redactForLog` (masks keys, tokens, Creator Keys). **Never declare another top-level `console`.** |
| `02_http-and-creator-utils.js`, `function fetch` | A module-level `fetch` guard. It strips edge caching from any request carrying `Authorization` (a real cross-user leak before), and gives every call without its own timeout a 30 s ceiling. **Never declare another top-level `fetch`.** |
| `02_`, `json()` / `jsonCacheable()` / `jsonPublic()` | JSON responses default to `no-store`. Public data opts in to caching with `jsonCacheable`; the Stremio routes do through `jsonPublic`. A new route that returns something personal must use plain `json()`. |
| `00_`, `INSTALL_CONFIG_FIELDS` | One definition of every install-link setting, used by `/api/save`, `resolveConfig`, `decodeConfig`, the configure page and the builder's save body. **Add a new setting here**, never by hand in one of those places. |
| `04_`, `entryAccountRequirement`; `16_`, `rowNeedsAccount` | The D-8 rule, on the server and in the page. A test (`the builder page and the server draw the line in the same place`) keeps them in agreement, so change both. |
| `00_`, `REQUIRED_SCHEMA_VERSION`; `02_`, `schemaWriteGate` | API writes are refused (503 "being updated") while the database is behind the code. A new migration must: <br>1. end with an `INSERT` into `schema_migrations`; <br>2. be added to `schema.sql` and `D1_SCHEMA_MANIFEST`; <br>3. bump `REQUIRED_SCHEMA_VERSION` if the code depends on it. <br>See `docs/OPERATIONS.md` §4. |
| `04_`, `resolveConfig(config, env, { withTracking })` | Reads a person's tracking record only when asked (the channel meta route and `/api/resolve`). Catalog rows must not ask. |
| `/<id>/configure` and `/api/resolve` | Never return provider keys or tokens. The `P1-T2` test probes every route for this. |
| `02_`, `encryptToken` / `decryptToken` / `hmacLookupKey` | AES-GCM-256 token encryption with key rotation (`TOKEN_ENCRYPTION_KEY`) and HMAC-SHA256 blind indexing (`LOOKUP_PEPPER`). |

---

## Traps in This Codebase
1. **Never edit `worker_entry_combined.js` by hand.** Edit the split files and run `python build.py`.
2. **Files `09_` to `24_` are inside a template literal** (the web page is rendered as one big string):
   - a backslash or `${` in client code must be escaped;
   - prefer `startsWith` / `split` over regular expressions;
   - `\n` in client code must be written `\\n`.
3. **All numbered files share one scope.**
   - Top-level names must be unique across files.
   - New server-only code goes in a new numbered file **after `26_`** (for example `27_...`), never between `09_` and `24_`.
4. **Shell heredocs in this environment mangle `\\` sequences.** Write patch scripts to a file and run them, or use the file-editing tool.
5. **The test D1** (`tests/harness.mjs`, real SQLite) enforces D1's limits: 100 bound parameters, 2 MB per row, 100,000-byte statements. A query that trips these would fail in production too.
6. The preview harness (`.claude/launch.json` → `mylists-harness`, port 8787) loads the built Worker once at startup. **Restart it after every rebuild.**

---

## Verification (run after every change, and before handing off)
```bash
python build.py
python check_sync.py
node --check worker_entry_combined.js
python gen_map.py
node --test tests/*.test.mjs
```
For the scope check (catches names that resolve to nothing):
```bash
npm install --no-save acorn@8.14.0 eslint-scope@8.2.0
node scope_check.mjs worker worker_entry_combined.js
```
Then delete `node_modules`.

Last run (2026-09-27): all of the above pass, 1,288 tests passed, 0 failed, 1 skipped.

---

## What Was Done
- **Phase 1:**
  - hotfixes;
  - Free-plan code removed;
  - the D-8 sign-in rules;
  - the migration ledger and write gate;
  - Analytics Engine metrics;
  - no secrets from install links;
  - the daily encrypted D1 backup workflow (`.github/workflows/d1-backup.yml`).
- **Phase 2:**
  - log redaction;
  - `no-store` by default;
  - a timeout on every outbound call;
  - one install-config schema, which fixed Configure → Update switching Better Posters off;
  - catalog rows no longer read watch history they don't use;
  - `stats` key-range queries.
- **Phase 3a (in progress):**
  - **P3a-1:** Migration `0015_accounts_sessions_installs.sql` written for `accounts`, `sessions`, `installs`, `provider_connections`, `install_secrets`, `rate_counters`, `account_settings`; added to `schema.sql`, `D1_SCHEMA_MANIFEST`.
  - **P3a-2:** AES-GCM-256 token encryption/decryption with key rotation (`TOKEN_ENCRYPTION_KEY`) and blind index HMAC (`LOOKUP_PEPPER`) implemented in `02_http-and-creator-utils.js` and verified with comprehensive unit tests. Documentation updated in `README.md`, `wrangler.toml`, and `docs/OPERATIONS.md`.

---

## Owner Actions Still Open (not code)
1. **Deploy what is on `main`:**
   1. back up D1;
   2. run `migrations/0014_add_schema_migrations.sql` in the D1 console (and `0015_accounts_sessions_installs.sql` when releasing Phase 3a);
   3. add the `ANALYTICS` Analytics Engine binding (dataset `mylists_events`);
   4. add secrets `TOKEN_ENCRYPTION_KEY` and `LOOKUP_PEPPER` when releasing Phase 3a;
   5. paste `worker_entry_combined.js` and deploy;
   6. delete the retired variables `BULK_RESOLVE_SUBREQUEST_BUDGET`, `DETAILS_BATCH_SUBREQUEST_BUDGET` and `CRON_SUBREQUEST_BUDGET`.

   Full steps are in `docs/OPERATIONS.md` §1, and `CHANGELOG.md` has them at the top of `[Unreleased]`.
2. **Turn on backups:** add the GitHub repository secrets `CLOUDFLARE_API_TOKEN` (D1 Read), `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID` and `BACKUP_PASSPHRASE`. Keep a copy of the passphrase outside GitHub.

---

## Next Steps for Incoming AI
1. **Next Task: P3a-3 (Backfill job `migrate.accounts`)**
   - For every `creators` row and every KV `creator:*` key, upsert into `accounts` table.
   - Newest `keyHash` wins; D1 wins ties.
   - Reconciliation report: `count(accounts) = |creators ∪ creator:*|`.
2. **Then P3a-4 (Sessions API):**
   - `POST /api/session`, `DELETE /api/session`, `GET /api/me`, `GET/DELETE /api/me/sessions`.
   - `mla_session` cookie (`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=30d`).
   - Session resolution middleware setting `request.account`.
3. **Always run verification before finishing:**
   `python build.py && python check_sync.py && node --check worker_entry_combined.js && python gen_map.py && node --test tests/*.test.mjs`

