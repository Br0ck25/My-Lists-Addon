# Live AI Agent Handoff Status

> **Notice to Incoming AI**: Read this file first, then `AGENTS.md` and `docs/DECISIONS.md`. It records the current progress, what must not be undone, and what to do next. Do not start over or undo existing work.

---

## Current Status
- **Last Updated**: 2026-09-27
- **Last Active AI**: Claude Code (Opus 5.5)
- **Active Task**: Phase 3a in progress. P3a-1 through P3a-9 are complete, verified and tested, and P3a-4 to P3a-7 have been reviewed and fixed. Next: P3a-10 (catalogs read tokens from `provider_connections`).
- **Task State**: All tests passing (1,388 passed, 0 failed, 1 skipped: the opt-in network test). `verify.sh` checks pass.
- **Git State**: All of this work (review fixes, P3a-8, P3a-9) is on the branch `feat/p3a-review-and-installs`, pushed, with a pull request into `main`. `main` = `origin/main` = `460be7c` until that PR is merged.
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
| `02_`, `getOrBackfillAccount(env, username, profile)` | The `accounts` row is a **mirror** of the creator profile (`creator:{u}` / `creators`), which stays the source of truth until Phase 10. Never trust `accounts.key_hash` on its own: authenticate with `authenticateCreator`, then sync the row from the profile. `deleteAccountRow` removes a row and everything under its id (sessions, installs, secrets, snapshots). |
| `27_`, the install move | A moved `cfg:` record carries `_install` and no secrets; `resolveConfig` puts them back (`applyLegacyInstallRecord`). Reads never depend on the flags. **Never write code that reads a `cfg:` record's keys directly**: go through `resolveConfig`. A new secret install field must be added to `INSTALL_SECRET_COLUMNS` (a test checks). |
| `28_`, `storeProviderConnection` | A signed-in OAuth callback stores the token and redirects to `/?connected=<provider>` with **no token in the URL**. It returns false (and the callback falls back to the old fragment redirect) when there is no session, no key or no table, so connecting never breaks. Never add a token to a redirect URL for a signed-in browser. |
| `02_`, `encryptToken` / `decryptToken` / `hmacLookupKey` | AES-256-GCM token encryption with key rotation (`TOKEN_ENCRYPTION_KEY`) and an HMAC-SHA256 blind index (`LOOKUP_PEPPER`). Always pass the key ring or `env` explicitly: there is no module-level `env`. Always pass a `context` naming the row (for example `account:<id>:<provider>`), and decrypt with the same one. Use these names only; do not add generic `encrypt` / `decrypt` functions. |

---

## Traps in This Codebase
1. **Never edit `worker_entry_combined.js` by hand.** Edit the split files and run `python build.py`.
2. **Files `09_` to `24_` are inside a template literal** (the web page is rendered as one big string):
   - a backslash or `${` in client code must be escaped;
   - prefer `startsWith` / `split` over regular expressions;
   - `\n` in client code must be written `\\n`.
3. **All numbered files share one scope.**
   - Top-level names must be unique across files.
   - New server-only code goes in a new numbered file **after `26_`** (the next is `29_...`), never between `09_` and `24_`.
   - `25_` and `26_` are the **inside** of `handleFetch` (they share `request`, `env`, `path`, `authenticateCreator`). `27_installs.js` and `28_connections.js` come after the `export default` block, at module level, so they cannot see those; pass what they need. `tests/client-harness.mjs` renders the page from the code **before** `export default`, so page rendering must never depend on `27_`+.
   - Tests that load source files into a sandbox (`loadSourceFunctions`) and call `resolveConfig` must include `27_installs.js`.
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

Last run (2026-09-27): all of the above pass, 1,372 tests passed, 0 failed, 1 skipped.

The harness (`tests/harness.mjs`) adds `Origin` and `Content-Type: application/json` to every POST, so a route test cannot notice a page that forgets them. A static test ("every mutating fetch the pages make sends a JSON content type") covers that instead.

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
  - **P3a-3:** Accounts backfill job implemented (`backfillAccounts`, `reconcileAccounts` in `02_http-and-creator-utils.js`, `/admin/api/migrate-accounts` route in `26_api-creator-and-admin-routes.js`, Admin maintenance panel in `03_admin.js`). Copies data from D1 `creators` and KV `creator:*` into `accounts` (newest `keyHash` wins; D1 wins ties), verifies `count(accounts) = |creators ∪ creator:*|`, leaves existing records intact.
  - **P3a-4:** Sessions API and authentication implemented (`createSession`, `resolveSession`, `revokeSession`, `revokeAccountSessions` in `02_http-and-creator-utils.js`, middleware in `25_api-catalog-routes.js`, routes in `26_api-creator-and-admin-routes.js`). Features 256-bit crypto tokens, SHA-256 in D1 `sessions`, `mla_session` cookie (`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=30d`), 60s isolate cache, PBKDF2 iterations rehash upgrade, lazy backfill on login, and device management (`/api/me/sessions`).
  - **P3a-5:** CSRF protection middleware implemented (`verifyCsrf` in `02_http-and-creator-utils.js`, wired into `handleFetch` in `25_api-catalog-routes.js`). Enforces same-origin validation (`Origin` or `Sec-Fetch-Site: same-origin`) and `Content-Type: application/json` on state-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`). Exempts webhooks (`/api/scrobble*`), OAuth callbacks, and admin login forms.
  - **P3a-6:** Creator routes dual authentication compatibility implemented behind `FF_SESSIONS` (`authenticateCreator` dual auth, `isSessionsEnabled`, `getOrBackfillAccount`, `withSecurityHeaders`). Every `/api/creator/*` route accepts either an active session or `creatorName`/`creatorKey` in the request body. Key-in-body auth automatically issues an `mla_session` cookie and creates a D1 session row (with lazy backfill of legacy accounts). Empty request bodies are tolerated when authenticated via session.
  - **P3a-7:** Blind index v2 implemented (`accounts.key_lookup_hmac`, `usernameForCreatorKeyLookup`, `recordLegacyLookupHit`). On successful login (`POST /api/session`, creator route auth) or key reset (`/api/creator/reset-key`, `/admin/api/reset-creator-key`), writes `accounts.key_lookup_hmac = HMAC(LOOKUP_PEPPER, normalizedKey)`. Key reset also updates `accounts.key_hash`. `forgot-username` checks the HMAC blind index first before falling back to legacy SHA-256 lookups. Legacy lookup hits emit metrics to Analytics Engine (`legacy_lookup_hit`) and KV `stats:legacy_lookup_hits`, and lazily upgrade accounts to Blind Index v2. Fails closed gracefully when `LOOKUP_PEPPER` is omitted.
  - **Review of P3a-4 to P3a-7 (Claude, commit `37fb3b2`):**
    - admin buttons that the CSRF check was refusing;
    - `POST /api/session` now authenticates through `authenticateCreator` (it trusted an unsynced `accounts.key_hash`: a deleted account's key still signed in, and could take over a re-registered username);
    - delete-account removes the `accounts` row, and create clears a leftover one;
    - key resets sign every device out;
    - no full backfill per sign-in;
    - sessions are issued only on `/api/creator/*`, and not again when one is open.
  - **P3a-8 (Claude):** installs, in `27_installs.js`.
    - Legacy install links move their keys, tokens and Creator Key into `install_secrets` (encrypted) on first use, behind `INSTALL_MIGRATION_PERCENT` (0-100, off by default). The KV record is rewritten without them, and `resolveConfig` puts them back, so everything serves identically.
    - v2 links `/i/{token}/...` and `GET/POST/PATCH/DELETE /api/installs`, behind `FF_INSTALLS`.
    - A KV snapshot `install:{tokenHash}` (1 day) plus a 30 s isolate cache.
    - The admin Maintenance tab has a progress panel and an emergency undo (`/admin/api/installs/restore`).
    - Deviations from the plan, with reasons, are listed under P3a-8 in `NEXT_VERSION_TASKS.md`.
  - **P3a-9 (Claude):** connections, in `28_connections.js`.
    - Signed in (with a session), the Trakt, MDBList, Simkl and TMDB callbacks store the token (plus refresh token and expiry) encrypted in `provider_connections`, and redirect to `/?connected=<provider>` with no token in the URL.
    - The page fetches it once over its session (`POST /api/connections/:provider/token`), as a bridge until Phase 6.
    - `POST /api/connections/import-local` (checked with each provider, once, rate-limited), `GET /api/connections`, and `DELETE /api/connections/:provider` (which revokes at Trakt and TMDB).
    - Page changes: the `apply*Connection` helpers, `pickUpServerConnection`, `forgetServerConnection` and `importLocalConnectionsOnce` in `17_`, with hooks in `22_` and `24_`.

---

## Owner Actions Still Open (not code)
1. **Deploy what is on `main`:**
   1. back up D1;
   2. run `migrations/0014_add_schema_migrations.sql`, then `migrations/0015_accounts_sessions_installs.sql`, in the D1 console. Both only add tables and are safe to run twice;
   3. add the `ANALYTICS` Analytics Engine binding (dataset `mylists_events`);
   4. paste `worker_entry_combined.js` and deploy;
   5. delete the retired variables `BULK_RESOLVE_SUBREQUEST_BUDGET`, `DETAILS_BATCH_SUBREQUEST_BUDGET` and `CRON_SUBREQUEST_BUDGET`.

   The owner has been told about both secrets, and the release notes (`CHANGELOG.md`) and `docs/OPERATIONS.md` §3 and §8 carry the steps:
   - `LOOKUP_PEPPER` is optional and used as soon as it is set;
   - `TOKEN_ENCRYPTION_KEY` is needed only before `INSTALL_MIGRATION_PERCENT` is raised above 0.

   Leave `FF_SESSIONS`, `FF_INSTALLS` and `INSTALL_MIGRATION_PERCENT` unset for now.

   Full steps are in `docs/OPERATIONS.md` §1, and `CHANGELOG.md` has them at the top of `[Unreleased]`.
2. **When ready, move install-link keys to encrypted storage:** follow `docs/OPERATIONS.md` §8 (apply 0015, back up D1, add `TOKEN_ENCRYPTION_KEY` and keep a copy of it, set `INSTALL_MIGRATION_PERCENT` to `10`, check progress, then raise it).
3. **Turn on backups:** add the GitHub repository secrets `CLOUDFLARE_API_TOKEN` (D1 Read), `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID` and `BACKUP_PASSPHRASE`. Keep a copy of the passphrase outside GitHub.

---

## Next Steps for Incoming AI
1. **Phase 3a continues** (`NEXT_VERSION_TASKS.md`; the reasoning is in `MIGRATION_PLAN.md` Phase 3a). P3a-1 through P3a-8 are done and verified. Next:
   - **P3a-10**: Provider calls for personal rows read tokens from `provider_connections`.
     - `loadProviderConnection(env, accountId, provider)` (`28_`) returns them decrypted.
     - Use the refresh token when `expires_at` has passed (Trakt, MDBList), and set `status`/`last_error` when a provider rejects one.
     - Decide which wins when an install has its own keys in `install_secrets` and its owner also has a connection. Today `install_secrets` is the only source.
     - v2 installs (`/i/{token}`) have no keys of their own, so their personal Trakt/MDBList/Simkl rows only work once this lands.
   - A v2 link's `/i/{token}/configure` page renders, but its **Update** still saves a new legacy link through `/api/save`. The UI for v2 links (Phase 6) should `PATCH /api/installs/:id` instead.

2. **Ask the owner first, every time, before anything that:**
   - **rewrites or deletes stored user data.** In particular, P3a-8 strips tokens out of existing install links (KV `cfg:` records). Get explicit approval, make sure a D1 backup and a KV export exist first, and do it gradually;
   - **needs a dashboard change.** Before shipping the first code that uses `TOKEN_ENCRYPTION_KEY` or `LOOKUP_PEPPER`, tell the owner, generate the values for them, and add the step to the release notes. The code must keep working if a secret is missing (fail closed for the new feature, never break existing sign-in);
   - **depends on migration 0015** being applied. If code needs its tables, raise `REQUIRED_SCHEMA_VERSION` to `0015` in the same change and say so in the release notes, or the site pauses saving until the migration runs.
3. **When finishing:** run the verification above, commit with a clear message, update this file, and push only if the owner asks.
