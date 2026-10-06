# Live AI Agent Handoff Status

> **Notice to Incoming AI**: Read this file first, then `AGENTS.md` and `docs/DECISIONS.md`. It records the current progress, what must not be undone, and what to do next. Do not start over or undo existing work.

> **RELEASE 23 LIVE (2026-10-06), merged into `main`; the owner reports Trakt connects again.** Before it, live was `main` at `b6c72a5` (/admin: *Release 22, build e9e1445b49*). The owner reported Connect Trakt with PIN / Code failing with *Trakt is busy (rate limit)*: Trakt was limiting the Worker. Release 23 asks Trakt for the code from the browser (`requestTraktDeviceCode`, 17_; `TRAKT_PUBLIC_CLIENT_ID` in the 16_ preamble), keeps the Worker route as fallback, and makes refusals name Trakt's limit (`traktLimitNote`, 25_). Details and steps: `docs/RELEASES.md` → Release 23. Next: the 26 Continue Watching / 9 Airing Next shows "not known yet" by the schedule (Compare shelves 2026-10-06: 770 accounts, 0.00% different, 0 lost) before removing the legacy CW / AN writers. `INSTALL_MIGRATION_PERCENT`: 14 links moved at 10%, none removed; owner to raise it to 50.
>
> **UI CONSISTENCY PASS (2026-10-06), PR #19 on `claude/nice-hamilton-yq0lxb`.** One shared token set (`DESIGN_TOKENS_CSS`, `00_constants.js`), `u-*` helper classes (`UTILITY_CSS`), darker brand blue for contrast, toast types, one `list-add-btn` class, and guard tests (`tests/design-system.test.mjs`). The rules for AIs and humans are `AI_UI_RULES.md` and `DESIGN_SYSTEM.md`, and `CLAUDE.md` / `AGENTS.md` now point to them. Verified by comparing the computed style of every element before and after in a real browser (zero differences); things not checked: a modal over the phone bottom nav, drag-and-drop, storyline and deep creator-profile screens. Channel cards: a movie-only channel no longer reads "11 episodes" / "11 shows". **Owner next:** merge the PR, deploy `worker_entry_combined.js`, glance at those unchecked screens on a phone.
>
> **RELEASE 22 PREPARED (2026-10-05), not live.** The design system, phase 1, is on `feat/design-system-phase-1`: `main` (Release 21) merged in, plus four review fixes (service worker sign-in redirects, a regex escape, custom list search "Added", Quick Add "added"). Details and owner steps: `docs/RELEASES.md` → Release 22. **Owner next:** merge by PR (ask Claude to open it, "Release 22: design system phase 1"), deploy `worker_entry_combined.js`, check `/admin` says **Release 22**, then press **Connect** for Trakt in a browser that has visited before. The design history (written before Release 21, so its `FF_NEW_UI`/`newUi` mentions are out of date) is in `docs/history/DESIGN_SYSTEM_PHASE_1_LOG.md`. Optional, not done: remove the dead `catalogsDedupeCheckbox` lookups (`16_`, `22_`, `23_`, `24_`); keep the rest of the `myListAddon:dedupeAcrossLists` block in `16_`.
>
> **NEXT STEPS (2026-10-05, Release 20 live and merged into `main`).** The list given to the owner, with dates. Done since 2026-10-04: Cloudflare's GitHub access removed, `CF_ANALYTICS_TOKEN` deleted, `INSTALL_MIGRATION_PERCENT=10`, sign-in stage 2 and the backup restore check (Release 20), `FF_MATERIALIZER` and `FF_CANONICAL_IDS` on. PRs #10 and #11: owner says ignore.
>
> **Owner (dashboard only):**
> 1. `INSTALL_MIGRATION_PERCENT`: check `/admin` → Maintenance → Install links, then `50` about 2026-10-07, then `100` about 2026-10-10 if nothing failed.
> 2. Any time, optional: delete `CF_ANALYTICS_ACCOUNT_ID` (only the finished one-time stats recovery read it).
> 3. Tell Claude if a Stremio tile opens to "not found" or a home screen with "Remove duplicate items across lists" looks wrong (the two switches turned on 2026-10-05).
>
> **Claude (code), in order:**
> 4. ~~Release 21~~ **live 2026-10-05, merged into `main`; the owner deleted `FF_NEW_UI`**: classic page retired (`FF_NEW_UI` cookie and variable no longer read; `?ff_new_ui=` redirects and clears the cookie), and the unreachable screens deleted (Explore, Your lists cards, the signed-out Save-to-account queue in 22_, Settings' Account/Connections cards, the install bar's drawing). `/api/bulk-resolve` **stays**: Settings → External Accounts → Import List uses it.
> 5. **About 2026-10-07:** owner presses *Compare shelves now* and sends the result. If "not known yet" is rare, remove the legacy Continue Watching / Airing Next writers (P5-4 second half: `checkForNewEpisodes`, `refreshAiringNextSweep`, `cron.episodes` / `cron.airing-next`, the client shelf builders). Keep the stored lists while `shelfStoredForUnknown` reads them; a media row of kind `movie` never gets a schedule row.
> 6. **About 2026-10-07:** owner turns on D1 read replication for `my-lists-db` (P8-1), with steps from Claude.
> 7. **About 2026-10-12** (a week after Release 20): if `/admin` → Creators *Saves that sent the Account Key* stays near zero, rewrite the sunset notices (`getLegacySunsetNotices`, 02_, still says `/api/creator/sync/*` goes away, and the page uses those routes, now signed by the session). Then the owner sets `SUNSET_60DAY_START_DATE`.
> 8. **Day 60 after that (about mid-December):** remove key-in-body auth on the session routes, the legacy scrobble forms and the other sunset items.
> 9. **After 8 (about late December onward):** the old storage, one prefix or table at a time: copy to R2, remove its readers, delete (docs/CUTOVER.md P10-3).
> 10. **After 2026-11-29:** remove the Better Posters KV fallback (`bpimg:v1:` reads in 52_ and the KV-only path in 05_; the copies expire by then, 60-day TTL). Keep `prewarmBetterPosters` (it fills R2 ahead). Low priority: it saves one wasted KV read per poster not yet in R2, and code.
> 11. **Optional, owner's call:** Unlisted lists (`FF_V2_LISTS_API`). Release 21 deleted the share control that offered it (it lived on the Your lists cards, with `APP_SHELL_UNLISTED_READY`), so it needs a place on the page first, likely the list editor's privacy setting.
>
> After each release the owner confirms live: merge the branch into `main` by PR. The daily backup (04:17 UTC) now also restores each file and compares row counts; a failed check fails the run.
>
> ---
>

> **Older handoff blocks, the 2026-10 "Current Status" and the full "What Was Done" log were moved, unchanged, to `docs/history/HANDOFF-ARCHIVE-2026-10-06.md` to keep this file short enough to read at the start of a session. Read that file only when you need the history of a past phase.**

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
   - `\n` in client code must be written `\\n`;
   - a regex literal's escapes are written doubled (`/\\s+/`), and a regex built from a **string** needs four (`new RegExp('\\\\b')`), because the browser's string literal cooks them once more. `tests/client-escapes.test.mjs` fails on a lone backslash in page code;
   - a `data-act-args` value is JSON, never code: pass the array itself and a real `"\n"`, not `jsStringArrayLiteral(...)` or `"\\n"` (08_ had both).
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

Last run (2026-09-28, P4-2): all of the above pass, plus every CI step (scope, render and HTML checks). 1,590 tests passed, 0 failed, 1 skipped, both ways.

The harness (`tests/harness.mjs`) adds `Origin` and `Content-Type: application/json` to every POST, so a route test cannot notice a page that forgets them. A static test ("every mutating fetch the pages make sends a JSON content type") covers that instead.

---

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

   **Then, when the P7-2 deploy goes out (recommended):** run `migrations/0018_admin_sessions_audit.sql` in the D1 console, and optionally put `/admin` behind Cloudflare Access — `docs/OPERATIONS.md` §25 is the click-by-click list (create the Access application for `/admin`, copy its AUD tag, set `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD`, and `FF_ADMIN_EMAILS` if you want the second lock). Without any of it the dashboard keeps working exactly as it does now; without the migration it keeps working and says so in the Maintenance tab.

   Full steps are in `docs/OPERATIONS.md` §1, and `CHANGELOG.md` has them at the top of `[Unreleased]`.
2. **When ready, move install-link keys to encrypted storage:** follow `docs/OPERATIONS.md` §8 (apply 0015, back up D1, add `TOKEN_ENCRYPTION_KEY` and keep a copy of it, set `INSTALL_MIGRATION_PERCENT` to `10`, check progress, then raise it).
3. **Turn on backups:** add the GitHub repository secrets `CLOUDFLARE_API_TOKEN` (D1 Read), `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID` and `BACKUP_PASSPHRASE`. Keep a copy of the passphrase outside GitHub.
   - **Check the first run.** `migrations/0007` notes that `wrangler d1 export` refuses a database that has virtual (full-text search) tables. `lists_fts` (0007) is one, and `lists_fts2` (0016) is another. If the daily export fails for that reason, the workflow needs to export around them (for example table by table), and the search tables are rebuilt afterwards. Not changed yet.
4. **Recommended (Phase 5, merged): set up the job queue** (`docs/OPERATIONS.md` §18): queues `mylists-jobs` and `mylists-jobs-dlq`, this Worker as consumer (batch 25, retries 5, DLQ), bind `JOBS`, press Send a test job. Cron trigger `*/5 * * * *`.
5. **Optional: turn on the rest of the nightly provider check** by adding the GitHub secrets `TMDB_API_KEY`, `TRAKT_CLIENT_ID`, `MDBLIST_API_KEY` (and `RAPIDAPI_KEY` only if the RapidAPI engine is used) with the Worker's values (`docs/OPERATIONS.md` §16). Without them the keyless providers are still checked every night.

---

## Next Steps for Incoming AI
1. **Phase 6 is merged into `main`** (PR #7, `9543c2b`, including the review fixes) — **P6-1 to P6-10 are done**, and none of them needs a dashboard change; the new UI is tried with `/?ff_new_ui=1` and undone with `/?ff_new_ui=0` (OPERATIONS §20). What is left before Phase 6 ships to everyone is the owner's walkthrough and then the `FF_NEW_UI` variable (OPERATIONS §20), plus Phase 7 (P7-1 the strict CSP, P7-2 the admin dashboard's identity and P7-3 the rate limits are done on the Phase 7 branch; P7-4 to P7-6 follow). **Phase 5 is merged** into `main` (PR #6). What is left of Phase 5 is the owner's: set up the job queue (OPERATIONS §18: queues `mylists-jobs` and `mylists-jobs-dlq`, this Worker as consumer, bind `JOBS`, cron `*/5 * * * *`, then *Send a test job*), and later the switches `FF_CHART_SNAPSHOTS`, `FF_MATERIALIZER` (§19) and the `BLOBS` bucket for posters. After about a week of `shelf.shadow` results (Check jobs), P5-4's second half: `FF_SHOW_SCHEDULE`, then delete the legacy sweeps. Next in the plan is **Phase 7**: P7-1, P7-2 and P7-3 are done on the Phase 7 branch (PR #9), so it starts with P7-4 (raise PBKDF2 to >= 600k and rehash on login), then P7-5 (recovery codes) and P7-6 (scrobble `st`-only). Start any new work on a fresh branch from `main`. The next server file is `55_...`. Phase 4's switches (`FF_PROVIDER_BREAKER`, `FF_CHART_SNAPSHOTS`, `FF_CANONICAL_IDS`, OPERATIONS §14, §15, §17), Phase 3c's rollout (activity database, copy, `FF_EVENT_TRACKING`) and Phase 3b's (copy, `FF_V2_LISTS_READ`, later `FF_V2_LISTS_ONLY`, §9 to §11) are still the owner's.
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
