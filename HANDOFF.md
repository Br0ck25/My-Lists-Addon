# Live AI Agent Handoff Status

> **Notice to Incoming AI**: Read this file first, then `AGENTS.md` and `docs/DECISIONS.md`. It records the current progress, what must not be undone, and what to do next. Do not start over or undo existing work.

---

## Current Status
- **Last Updated**: 2026-09-28
- **Last Active AI**: Claude Code (Opus 5.5)
- **Active Task**: Phase 4 (providers). Phase 3c is merged into `main` (PR #4); its rollout (create and bind `DB_ACTIVITY`, run the history copy, `FF_EVENT_TRACKING`) is the owner's (OPERATIONS §2, §4, §12, §13). **P4-1** (the provider registry, `CATALOG_SOURCES` and `PROVIDER_ADAPTERS` in `04_config-resolution.js`) is done: `detectSource` and `fetchCatalog` dispatch through it, with no change anyone can see. **P4-4** (the provider breaker, `41_provider-breaker.js`, behind `FF_PROVIDER_BREAKER`, off) is done.
- **Task State**: 1,560 tests pass, 0 fail, 1 skipped, both as they are and with `MLA_TEST_V2_LISTS_READ=1`. Build, sync, syntax, scope, render and HTML checks pass.
- **Git State**:
  - Phases 3a, 3b and 3c are merged into `main` (PRs #1 to #4).
  - **Phase 4 goes on the branch `claude/hopeful-davinci-dx55ds`**, in one draft PR into `main`, one commit per P4 task.
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
   - New server-only code goes in a new numbered file **after `26_`** (the next is `41_...`), never between `09_` and `24_`.
   - `25_` and `26_` are the **inside** of `handleFetch` (they share `request`, `env`, `path`, `authenticateCreator`). `27_installs.js` and `28_connections.js` come after the `export default` block, at module level, so they cannot see those; pass what they need. `tests/client-harness.mjs` renders the page from the code **before** `export default`, so page rendering must never depend on `27_`+.
   - Tests that load source files into a sandbox (`loadSourceFunctions`) and call `resolveConfig` must include `27_installs.js`.
4. **In `27_` onward, never write the words `export default` together, even in a comment.** Those files come after the Worker's real export, and `render_check.js` (a CI step) cuts the combined file at the *last* place the words appear, so the page checks break.
5. **Shell heredocs in this environment mangle `\\` sequences.** Write patch scripts to a file and run them, or use the file-editing tool.
6. **The test D1** (`tests/harness.mjs`, real SQLite) enforces D1's limits: 100 bound parameters, 2 MB per row, 100,000-byte statements. A query that trips these would fail in production too.
7. The preview harness (`.claude/launch.json` → `mylists-harness`, port 8787) loads the built Worker once at startup. **Restart it after every rebuild.**
8. **Run the suite both ways:** `node --test tests/*.test.mjs`, then `MLA_TEST_V2_LISTS_READ=1 node --test tests/*.test.mjs` (CI does both). With the variable set, `makeEnv` turns `FF_V2_LISTS_READ` on for every test; a test that sets the flag itself still decides. A test that edits the legacy store directly (KV or `creator_lists`) goes around the v2 mirror. If it is testing the legacy store's own internals, pin it with `delete env.FF_V2_LISTS_READ` and a comment saying why; otherwise make v2 behave the same.
9. **Per-instance caches in `33_`/`34_` remember which database they came from** (`db === env.DB`), because each test has its own. Keep that for any new cache of database state.

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

Last run (2026-09-28, P4-4): all of the above pass, plus every CI step (scope, render and HTML checks). 1,560 tests passed, 0 failed, 1 skipped, both ways.

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
- **Phase 3a (done):**
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
  - **P3a-10 (Claude):** catalogs use the install owner's connections, only for a proven owner (v2 `account_id`, a verifying Creator Key, or the new `ownerId` + `ownerSince` stamp). The config's own tokens win. Signed-in saves leave out what connections supply. Trakt and MDBList tokens are renewed before expiry. Details under P3a-10 in `NEXT_VERSION_TASKS.md`.
  - **P3a-9 (Claude):** connections, in `28_connections.js`.
    - Signed in (with a session), the Trakt, MDBList, Simkl and TMDB callbacks store the token (plus refresh token and expiry) encrypted in `provider_connections`, and redirect to `/?connected=<provider>` with no token in the URL.
    - The page fetches it once over its session (`POST /api/connections/:provider/token`), as a bridge until Phase 6.
    - `POST /api/connections/import-local` (checked with each provider, once, rate-limited), `GET /api/connections`, and `DELETE /api/connections/:provider` (which revokes at Trakt and TMDB).
    - Page changes: the `apply*Connection` helpers, `pickUpServerConnection`, `forgetServerConnection` and `importLocalConnectionsOnce` in `17_`, with hooks in `22_` and `24_`.

- **Phase 3b (merged, PR #3):**
  - **P3b-1 (Claude):** migration `migrations/0016_lists_v2.sql` adds `media`, `lists`, `list_items`, `list_slug_history`, `likes`, `channels`, `account_list_prefs`, `presets`, `lists_fts2` and `jobs`. Also in `schema.sql` and `D1_SCHEMA_MANIFEST`. Tests in `tests/lists-v2.test.mjs`; the manifest drift test in `tests/worker.test.mjs` now also catches `UNIQUE` indexes. Nothing reads or writes the tables yet, and `REQUIRED_SCHEMA_VERSION` stays `0014`.
    - Where it differs from the architecture sketch, and why, is listed under P3b-1 in `NEXT_VERSION_TASKS.md`. The ones the next tasks must know:
      - a list entry is `(list, media, season, episode)`: storyline lists hold single episodes. `extra_json` keeps item fields with no column;
      - `media.kind` is `movie`/`series`; a title TMDB can't resolve is a stub with `title` NULL and `resolved_at` NULL;
      - `lists_fts2` keeps its own copy of the text and is maintained **by rowid in code** (no triggers). Only public, non-deleted lists go in it;
      - an account's vote is `acct:<accounts.id>` (legacy signed-out votes keep `a:<hash>`, D-9); `channel_add` rows are channel adds;
      - `lists.legacy_id` is the backfill's idempotency key;
      - a deleted account's shared channels stay (owner NULL); its private channels must be deleted by code.
  - **P3b-2 (Claude):** the media resolver, in `29_media.js` (module level, after `export default`, so pass `env`). `resolveMediaBatch(env, items, { kind, maxLookups, tmdbKey, retryStubs }) → { ids, stats }` takes legacy list items as they are; `resolveMedia` does one; `retryUnresolvedMedia` retries stubs. Tests: "P3b-2" in `tests/lists-v2.test.mjs`, loaded into a vm sandbox with a fake TMDB. Details and what is left (merging a stub into a row that already has its TMDB id) under P3b-2 in `NEXT_VERSION_TASKS.md`.
    - `stats` is counted per input (`found`, `resolved`, `stubs`, `unusable`), ready for P3b-3's reconciliation record.
    - D1 allows about 1,000 queries per invocation and each new title is one write, so P3b-3 must feed it about 1,000 items per invocation at most.
    - A test sandbox that loads `02_` must not call `fetch`: `02_`'s module-level `fetch` guard becomes the sandbox's global and calls itself. Load `00_` and `29_` only, and set `sandbox.fetch`.
  - **P3b-3 (Claude):** the backfill `migrate.lists`, in `30_lists-backfill.js`, run from `/admin` → Maintenance → **Lists v2** (routes `/admin/api/lists-backfill/step` and `/status`, dispatched from `25_` next to installs and connections). The owner approved writing it; running it on production is theirs to do (`docs/OPERATIONS.md` §9). Details and deviations under P3b-3 in `NEXT_VERSION_TASKS.md`.
    - **It must never write the legacy store.** Everything goes through `listsBackfillEnv`, which has no KV writes and refuses D1 writes outside the v2 tables. Keep it that way; a test enforces it.
    - `lists.legacy_hash` was added to 0016. Channels are copied since P3b-8 (the "channels" phase).
  - **P3b-4 (Claude):** the list API, `/api/lists`, in `31_lists-api.js` (dispatched from `25_` after the backfill routes; the legacy `/api/lists/like` and `/like-external` are passed through). Behind `FF_V2_LISTS_API`, which must stay off in production until P3b-7. Session auth only. Details under P3b-4 in `NEXT_VERSION_TASKS.md`.
    - Every write is one batch: the change, `item_count` from the rows, the list's version, the account's version, and `lists_fts2`. Keep that shape in P3b-5 onwards.
    - `listOwnerSearchName` (`30_`) is what `lists_fts2.owner_name` holds, for both the backfill and the API.
    - The list item insert names the list by `public_id` through a `VALUES` join, so a new list and its first items go in one batch.
  - **P3b-5 (Claude):** the likes API, `/api/likes/{list|channel|external}/{id}`, in `32_likes-api.js` (dispatched from `25_` after the list API), behind the same flag. Details under P3b-5 in `NEXT_VERSION_TASKS.md`.
    - `likeWriteStatements` must keep the `like_count ± changes()` statement straight after the like itself: `changes()` is the previous statement's row count.
    - Channel likes work since P3b-8 filled `channels`.
  - **P3b-6 (Claude):** `/lists/public.json` and `/api/search-published-lists` read from v2 when `FF_V2_LISTS_READ` is on (`33_lists-directory.js`, called at the top of each route in `25_` and `26_`; either falls back to its legacy path when v2 fails). Details under P3b-6 in `NEXT_VERSION_TASKS.md`.
    - `FF_V2_LISTS_READ` is **the** read switch; P3b-7 extended it to the list pages, catalogs and the legacy list routes. Since P3b-7 the directory and search also wait for the whole copy to have finished.
    - Test fixtures for search need lists that have items: an empty list is left out of search, and an early fixture passed vacuously because every "Drama" list was empty. The test now asserts each query finds something.
    - **Legacy bug found:** `getCreatorList` (`02_`) rewrote a list's KV record from its D1 row on every dashboard read, without `sourceUrl`, `synced`, `lastSyncedAt` or `baseItemIds`. **P1-C5**, fixed on this branch (the owner chose this PR over a separate one): the rebuilt record carries them (and `isWatchlist`) over from KV. It reaches the live site with Phase 3b; lists that already lost their settings are not repaired.
  - **P3b-7 (Claude):** the legacy list routes over v2, in `34_lists-v2-bridge.js` (module level; hooks in `02_` `deleteCreatorLists`/`purgeCreatorData` and `05_` `fetchLiveCreatorListItems`, both `typeof`-guarded because those files are also loaded alone, and in the `25_`/`26_` routes). Details, deviations and known limits under P3b-7 in `NEXT_VERSION_TASKS.md`.
    - **Writes go to both stores.** The legacy routes write the legacy store first, as before, then mirror into v2 (`listsV2MirrorLists`, `listsV2MirrorOrder`, `listsV2MirrorLike`, `listsV2MirrorExternalLike`, `listsV2PurgeAccount`). This happens whenever the 0016 tables exist, **whatever the flag says**. A list's items are mirrored as a diff (`planListEntryDiff`), never replaced.
    - Mirror and copy share a per-account lease (`claimListsAccountLease`, `run_after` on the account's `migrate.lists` job). A mirror that cannot take it marks the job dirty; one that fails marks the copy stale (`queued`).
    - **Reads, with the flag,** come from v2 only for an account whose job is `done` (`listsV2Ready`); the dashboard and list contents copy an unfinished account first (`listsV2MigrateOnRead`). The Watchlist is always read from the legacy store; its v2 copy is kept current for the directory.
    - With the flag on, `backfillAccountLists` skips accounts that are `done`. That is on purpose: v2 is then what people see.
    - Items come back exact through `legacyItemFromEntryRow`; the list-level legacy fields that have no column (`baseItemIds`, `noVersion`) live in `lists.source_json` (`legacyListSourceJson`).
    - Before P3b-9 stops the legacy writes, it has to deal with the known limits listed under P3b-7: lists over 1,500 items are not mirrored on save, and legacy anonymous lists are not mirrored.
  - **P3b-8 (Claude):** shared channels (`channelshare:`, `index:publicchannels`, the channel like and add ledgers) as `channels` rows plus R2 pools, in `35_channels-v2.js` (module level). Hooks in the `/api/channel/*` routes and the admin channel routes (`26_`), and in `/channels/{user}/{slug}` and the signed-out `/api/save` (`25_`); the copy has a new "channels" phase (`30_`). Details, deviations and known limits under P3b-8 in `NEXT_VERSION_TASKS.md`.
    - **Same strangler as P3b-7:** legacy KV first, then `channelsV2SyncShare` / `channelsV2MirrorLike` / `channelsV2MirrorAdd` / `channelsV2Delete`. A row with `legacy_hash` NULL is behind and never read.
    - Episodes live in R2 at `channels/{code}/{version}.json` under the new binding **`BLOBS`** (bucket `mylists-blobs`; OPERATIONS §2). The code works without it (episodes then come from KV). `tests/harness.mjs` binds an in-memory one by default (`makeR2`); pass `BLOBS: null` for a deployment without it.
    - Adds are rows in `likes` with `target_type` `channel_add`.
    - Channels an account syncs between its own browsers (`creatorsyncchannels:`) are **not** moved: they stay a sync blob until the Phase 6 channel builder.
  - **P3b-9 (Claude):** `FF_V2_LISTS_ONLY` (off; one-way; implies `FF_V2_LISTS_READ`), `isV2ListsOnly(env)` in `02_`. With it on, every legacy list, like and channel route reads and writes v2 only. Details, fixes found on the way and what is left under P3b-9 in `NEXT_VERSION_TASKS.md`.
    - **The shape of it:** each route keeps its request and answer. In `26_`/`25_` it branches to the v2 functions at the end of `34_` (`listsV2WriteRecord`, `listsV2DeleteRecords`, `listsV2WriteOrder`, `listsV2GetRecordRaw`, `listsV2LikeList`, `listsV2LikeExternal`) and `35_` (`channelsV2Share`, `channelsV2Like`, `channelsV2Added`, `channelsV2Unlist`). `applyLegacyRecordToV2` is the one writer both the P3b-7 mirror and the flagged routes use.
    - **Never let a legacy read reach v2 with the flag on:** the mirrors (`listsV2MirrorLists` and friends), the copy (`runListsBackfillStep`, `backfillAccountLists`) and migrate-on-read all return early, because the legacy store is behind and copying from it would undo changes.
    - Big writes go through `d1JsonChunks` (`29_`): one JSON value per statement, read with `json_each`. Keep that for anything that writes thousands of rows.
    - The test to extend when a list route changes: "answers every list, like and channel request as before, and writes nothing to the legacy store" runs one script against a dual-written env and a flagged one and compares every answer.

---

- **Phase 3c (in progress, branch `claude/wizardly-faraday-3ptdw1`):**
  - **P3c-1 (Claude):** the activity database. Its migrations live in `migrations/activity/` with an `A` prefix and its own ledger (never put one in `migrations/`: the main drift test would apply it to `DB`). `schema_activity.sql` must stay identical to running them (a test checks). Always reach the database through `activityDb(env, accountId)` (`36_`), which returns null without the binding. Details under P3c-1 in `NEXT_VERSION_TASKS.md`.
  - **P3c-2 (Claude):** `migrations/0017_show_schedule.sql` in `DB`. Nothing uses it yet, so `REQUIRED_SCHEMA_VERSION` stays `0014`; raise it to `0017` in the change that first depends on it. The schema-status drift test in `worker.test.mjs` drops every table by name, so add new tables to its list (children before parents: foreign keys are on).
  - **P3c-6 (Claude):** `40_event-tracking.js`. With `FF_EVENT_TRACKING`, `eventTrackingEnv` (wrapped around `env` in the fetch and scheduled handlers) serves a copied account's tracking keys from v2 and drops the scrobble queue and behind-marker keys. The D1 tracking helpers in `02_` return early for such an account. **Any new code that reads or writes `creatorsynctracking:` must go through `env.CONFIGS` (never a raw binding) so the switch applies.**
  - **P3c-3 (Claude):** the history copy `migrate.activity`, in `37_activity-backfill.js` (module level). Same shape as P3b-3. Details and deviations under P3c-3 in `NEXT_VERSION_TASKS.md`.
    - **It must never write the legacy store.** Everything goes through `activityBackfillEnv`; a test enforces it.
    - `show_progress` `(S, 0)` means "nothing of season S yet" (a Continue Watching show with no history). P3c-5's shelves must read it so.
    - A fresh account copy deletes that account's `source = 'migrated'` events and rebuilds `show_progress` and `user_media_state` from all its events. When P3c-4 starts writing live plays, they must use `activityDedupeKey` and the ten-minute window (`36_`), so a play in both stores is one row.

- **Phase 4 (in progress, branch `claude/hopeful-davinci-dx55ds`):**
  - **P4-1 (Claude):** the provider registry, in `04_config-resolution.js` (it owns source detection, and the tests load it on its own). Details and deviations under P4-1 in `NEXT_VERSION_TASKS.md`.
    - **`CATALOG_SOURCES` is the one ordered list of catalog sources.** A new kind of row is one new entry there: its `name`, `provider`, `kind`, `match`, optional `arg`, `apiUse` and `fetchPage`. **Order matters** (first match wins) and the MDBList entry must stay last (it takes anything). Never rename a source: `STREMIO_LIVE_ROW_SOURCES` and the catalog route key off the names.
    - A `personal` source must also go in `STREMIO_LIVE_ROW_SOURCES` (`00_`), or its row is cached for a day; a test fails until both agree.
    - `tests/providers.test.mjs` keeps a frozen copy of the old `detectSource` and `fetchCatalog` chains as the oracle. When a source is **added on purpose**, add it to the frozen copies too (they describe the intended behavior), and add its strings to `SOURCE_CORPUS`.
  - **P4-4 (Claude):** the provider breaker, `41_provider-breaker.js`, behind `FF_PROVIDER_BREAKER` (off; OPERATIONS §14). Details under P4-4 in `NEXT_VERSION_TASKS.md`.
    - It works **inside the fetch guard** (`02_`): a call to an adapter's host is refused at once while that provider is open. A new provider host must be added to its adapter's `hosts` (`04_`) to be covered.
    - Its state is **module-level memory** (like `PER_USER_CACHE_MAP`), switched per request by `configureProviderBreaker(env)` in the fetch and scheduled handlers. Tests that need a clean breaker use `freshIsolate()`.
    - `providerBreakerRefresh` (a `pb:` KV read) runs in `fetchCatalog`; `providerBreakerFlush` (the `pb:` write and the metrics) at the end of every request and cron tick.

## Owner Actions Still Open (not code)
1. **Deploy what is on `main`:**
   1. back up D1;
   2. run `migrations/0014_add_schema_migrations.sql`, then `migrations/0015_accounts_sessions_installs.sql`, in the D1 console. Both only add tables and are safe to run twice. When Phase 3b is deployed, `migrations/0016_lists_v2.sql` follows them, and `0017_show_schedule.sql` after it (same: only add tables, safe to run twice);
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
   - **Check the first run.** `migrations/0007` notes that `wrangler d1 export` refuses a database that has virtual (full-text search) tables. `lists_fts` (0007) is one, and `lists_fts2` (0016) is another. If the daily export fails for that reason, the workflow needs to export around them (for example table by table), and the search tables are rebuilt afterwards. Not changed yet.

---

## Next Steps for Incoming AI
1. **Phase 4 is under way** on `claude/hopeful-davinci-dx55ds` (draft PR into `main`). P4-1 and P4-4 are done; next are P4-2 (every catalog id canonical), P4-3 (chart snapshots) and P4-5 (provider contract fixtures and a nightly live check), in `NEXT_VERSION_TASKS.md`. The next server file is `41_...`. Phase 3c is merged (PR #4); its rollout (create and bind the activity database, run the copy, then `FF_EVENT_TRACKING`, one-way) is the owner's, and `FF_SHOW_SCHEDULE` needs the schedule job (P5-3). Phase 3b's rollout (deploy, copy, `FF_V2_LISTS_READ`, later `FF_V2_LISTS_ONLY`, OPERATIONS §9 to §11) is still the owner's.
     - `FF_V2_LISTS_API` (the v2 list and likes APIs) must stay off until P3b-9: what they write is not in the legacy store, so a flag-off rollback or a copy re-run would lose it.
     - Phase 3b rewrites how lists are stored, so it needs the owner's approval before any backfill (P3b-3) touches stored data.
     - Decide which wins when an install has its own keys in `install_secrets` and its owner also has a connection. Today `install_secrets` is the only source.
     - v2 installs (`/i/{token}`) have no keys of their own, so their personal Trakt/MDBList/Simkl rows only work once this lands.
   - A v2 link's `/i/{token}/configure` page renders, but its **Update** still saves a new legacy link through `/api/save`. The UI for v2 links (Phase 6) should `PATCH /api/installs/:id` instead.

2. **Ask the owner first, every time, before anything that:**
   - **rewrites or deletes stored user data.** In particular, P3a-8 strips tokens out of existing install links (KV `cfg:` records). Get explicit approval, make sure a D1 backup and a KV export exist first, and do it gradually;
   - **needs a dashboard change.** Before shipping the first code that uses `TOKEN_ENCRYPTION_KEY` or `LOOKUP_PEPPER`, tell the owner, generate the values for them, and add the step to the release notes. The code must keep working if a secret is missing (fail closed for the new feature, never break existing sign-in);
   - **depends on migration 0015** being applied. If code needs its tables, raise `REQUIRED_SCHEMA_VERSION` to `0015` in the same change and say so in the release notes, or the site pauses saving until the migration runs.
3. **When finishing:** run the verification above, commit with a clear message, update this file, and push only if the owner asks.
