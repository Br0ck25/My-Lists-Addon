# Live AI Agent Handoff Status

> **Notice to Incoming AI**: Read this file first! It records the current progress, modified files, and what needs to be done next. Do not start over or undo existing work.

---

## Current Status
- **Last Updated**: 2026-09-27
- **Last Active AI**: Claude Code (Claude Opus 5.5)
- **Active Task**: The next-version plan. Phase 1 code and Phase 2 (all of P2-1 to P2-10) are finished. The next phase in `NEXT_VERSION_TASKS.md` is Phase 3a.
- **Task State**: All work committed. All tests passing (1,277 passed, 0 failed, 1 skipped: the opt-in network test).
- **Git State**: Clean working tree on `main`. Commits up to `31e55d9` are on GitHub; the Phase 2 commits after it are local only (`git status -sb` shows how many). Push only when the owner says so.

---

## Read Before Changing Anything
- `docs/DECISIONS.md`: the owner's decisions D-1 to D-12. Key ones:
  - D-6: likes and shares need an account.
  - D-8: signed out, an install link carries the site's public lists only.
  - D-10: install links never expire.
  - D-11: no npm build, no `src/`, no frameworks.
  - D-12: no email recovery.
- `NEXT_VERSION_TASKS.md`: the task checklist with a status on each item. Phase 2 was rewritten on 2026-09-27 around the numbered files.
- `docs/OPERATIONS.md`: deploy checklist, bindings, migrations, backups.

---

## Recent File Changes (this session, all committed)
- **`25_api-catalog-routes.js`**:
  - `/<id>/configure` and `/api/resolve` no longer return an install link's provider keys or tokens;
  - `/api/imdb-ids` does up to 100 lookups, 8 at a time;
  - the Trakt device-code route hands a 429 back instead of sleeping.
- **`07_source-fetchers-tmdb-simkl.js`**: the leftover `meter` / Airing Next budget-pool code is removed.
- **`03_admin.js`**: `stats` prefix reads use a key range (`statKindRange`) instead of `LIKE`.
- **`04_config-resolution.js`, `16_client-row-core.js`**: the D-8 sign-in rule. Storyline and Explore Channels rows are public. The page and the server share `PERSONAL_SHELF_URL_PREFIXES`.
- **`17_`, `19_`, `20_`, `24_` client files**:
  - sign-in gates;
  - the Trakt PIN retry;
  - storyline and Explore adds become catalog rows (no My Channels copy);
  - "Import from link" no longer copies tokens.
- **`00_constants.js`**: `IMDB_ID_LOOKUP_MAX` is 100 and `IMDB_ID_LOOKUP_CONCURRENCY` is 8; `TMDB_ITEM_DETAILS_MAX_FETCHES` is removed.
- **`.github/workflows/d1-backup.yml`** (new): a daily encrypted D1 export. It stays off until its 4 repository secrets are set.
- **`tests/`**: a route-by-route secret-leak test (P1-T2), plus tests for everything above.
- **Plan docs**: `NEXT_VERSION_*.md`, `MIGRATION_PLAN.md`, the audits and `docs/` now follow D-11.

---

## Verification Summary
- `python build.py`: PASS
- `python check_sync.py`: PASS
- `node --check worker_entry_combined.js`: PASS
- `node scope_check.mjs worker|page`: PASS (every identifier resolves)
- `render_check.js` + `html_checks.py` (builder, admin, hostile, service worker): PASS
- `python gen_map.py`: map current
- `node --test tests/*.test.mjs`: 1,256 passed, 0 failed, 1 skipped

---

## Owner Actions Still Open (not code)
1. Deploy:
   - back up D1;
   - run `migrations/0014_add_schema_migrations.sql` in the D1 console;
   - add the `ANALYTICS` Analytics Engine binding (dataset `mylists_events`);
   - paste `worker_entry_combined.js` and deploy;
   - delete the retired `*_SUBREQUEST_BUDGET` variables.
2. To turn on backups, add these GitHub secrets: `CLOUDFLARE_API_TOKEN` (D1 Read), `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID` and `BACKUP_PASSPHRASE`.
3. Decide whether the README's source links should point to `github.com/Br0ck25/My-Lists` (as now) or `github.com/Br0ck25/My-Lists-Addon`.

---

## Next Steps for Incoming AI
1. Phase 2 is done. Its shared pieces live in the split files:
   - log redaction and the install-config schema (`INSTALL_CONFIG_FIELDS`) in `00_`;
   - the `fetch` guard with its default timeout, and `json` / `jsonCacheable` / `jsonPublic`, in `02_`;
   - `resolveConfig(..., { withTracking })` in `04_`.
2. The next phase in `NEXT_VERSION_TASKS.md` is **Phase 3a** (identity, sessions, installs, connections). Read `MIGRATION_PLAN.md` Phase 3a first: it adds D1 tables and needs migrations applied by the owner before any code that depends on them is deployed. Confirm the plan with the owner before starting it.
3. Follow D-11 strictly:
   - edit only the split files;
   - put new server-only code in new numbered files after `26_` (never between `09_` and `24_`, which are inside the page's template literal);
   - keep top-level names unique across files;
   - write client code that needs no backslashes where possible.
4. After every change, run `python build.py`, `python check_sync.py`, `node --check worker_entry_combined.js`, `python gen_map.py` and `node --test tests/*.test.mjs`. For the scope check: `npm install --no-save acorn@8.14.0 eslint-scope@8.2.0`, then `node scope_check.mjs worker worker_entry_combined.js`, then delete `node_modules`.
5. Shell heredocs in this environment can mangle `\\` sequences. Write patch scripts to a file rather than piping them through a heredoc.
