# Project notes for the audit skills (My Lists Addon)

This is the only file that is specific to this repo. To reuse the skills in
another repo, copy `.claude/skills/` and rewrite this file for that project.

## What the project is
One Cloudflare Worker serving the API and web UI for Stremio, Nuvio and Wako:
D1 (`DB`, `DB_ACTIVITY`), KV `CONFIGS`, R2 `BLOBS`, Queue `JOBS`, Analytics
Engine, `IMAGES`, `send_email`, and a cron. Vanilla JS (ESM); HTML/CSS live in
template literals. The owner is not a coder: write for them in plain English.

## Read first
`CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` (decisions are not
bugs). For UI audits also `docs/AI_UI_RULES.md`. For deployment audits also
`docs/OPERATIONS.md`, `docs/DEPLOY_CHECKLIST.md`, `docs/STAGING.md`.

## Commands
- Full check (baseline and finish): `bash verify.sh -q`
- Quick check: `bash verify.sh -q --fast`
- One test file: `node --test tests/<file>.test.mjs`
- Build: `python build.py`
- Known failure on shared VMs: the cold-catalog p95 timing budget in
  `tests/load-performance.test.mjs`. Record it; do not report it as new.
- Playwright and Chromium are pre-installed in the cloud session (for UI and
  end-to-end checks). Do not install them again.

## Finding code
- Never open `worker_entry_combined.js` (5 MB, generated from `src/`).
- `docs/FILE-INDEX.md` says which `src/<group>/NN_*.js` file holds what.
- `grep` `docs/FUNCTION-MAP.md` for a symbol or route (never read it whole),
  then read only that part of the source file with offset/limit.
- All numbered sources share one scope after the build: a function in `05_`
  can be called from `26_` with no import. Before calling something unused,
  search all of `src/` (client and page code is inside template literals),
  route strings in the router and `tests/route-access.json`, job-type strings
  in `src/jobs/44_*` and `45_*`, `data-action`/`window.*` handlers, dynamic
  `obj[name]` lookups, and tests. Used only by a test means "test-only".
- Routes and who may call them: `tests/route-access.json`.
- Database: `schema.sql`, `schema_activity.sql`, `migrations/`.
- Config: `wrangler.toml`, `wrangler.selfhost.toml`. CI: `.github/workflows/`.

## Earlier audits (do not re-open what they cover)
`docs/SECURITY_AUDIT_PLAN.md` (SEC-), `docs/BUG_AUDIT_PLAN.md` (BUG-),
`docs/BACKEND_AUDIT.md` (BA-), `docs/CODE_QUALITY_AUDIT.md` (CQ-),
`docs/PERFORMANCE.md` (PF-), and every report in `docs/audits/`.

## ID prefix per audit type
| Type | Prefix | | Type | Prefix |
|---|---|---|---|---|
| security | SEC | | database | DB |
| bugs | BUG | | frontend | UI |
| backend | BA | | api | API |
| code-quality | CQ | | deployment | OPS |
| performance | PF | | product | PROD |
| testing | TEST | | | |

## Rules for the implementer (copy into each report)
- Follow `CLAUDE.md`. Edit `src/**/NN_*.js`, never `worker_entry_combined.js`,
  then `python build.py`. No refactors or renames; one root cause per commit.
- For every bug: write the failing test first, then fix. The test must fail
  if the fix is reverted.
- After each item: `bash verify.sh -q --fast` plus the one test file. Before
  pushing: `bash verify.sh -q`. Run `python tools/gen_map.py` if functions
  were added, removed or moved.
- New route: add it to `tests/route-access.json`; admin routes check
  `isAdminRequest`.
- UI changes follow `docs/AI_UI_RULES.md`; run
  `node tests/ui-contract.mjs --update` only when the look changed on purpose.
- Never skip or loosen a test or guard to get green.
- Add a `docs/RELEASES.md` entry at the end.
