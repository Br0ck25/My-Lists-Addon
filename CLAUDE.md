# CLAUDE.md

**My Lists Addon**: one Cloudflare Worker (D1, KV, Cron) serving the API and web UI for Stremio/Nuvio/Wako. Pure Vanilla JS (ESM) plus HTML/CSS in template literals. The owner is not a coder: run every command, test and commit yourself.

## Hard rules
1. **Never edit `worker_entry_combined.js`** (5MB, auto-generated, reads are denied in `.claude/settings.json`). Edit `header.js` and the numbered `NN_*.js` sources, then run `python build.py`. Never write `WORKER_BUILD` by hand.
2. **No refactors or "modernising".** No TypeScript/React/Svelte, no `src/`, no bundlers. Don't rename or rewrite working code unless asked. All numbered files share one scope, so don't reuse a global `const`/`let` name.
3. **Inside template literals** write `<\/script>`, never a raw `</script>`.
4. **UI changes** follow `AI_UI_RULES.md` (one page, read first) and `DESIGN_SYSTEM.md` (full spec, read only the section you need). Reuse existing classes and tokens; no new button styles, hex literals or odd pixel values. A movie is never a "show" or "episode".
5. **New route:** add it to `tests/route-access.json`; admin routes must check `isAdminRequest`.
6. **Never skip or loosen a test or guard to get green.** If a guard is wrong, fix the guard and say why in the commit.
7. **Small, root-cause fixes.** Search callers first, reuse existing helpers, fix the shared cause, and change nothing unrelated.

## Finding code cheaply
- `grep` `FUNCTION-MAP.md` for the symbol (~170KB: never read it whole), then read only that file with `offset`/`limit`.
- "Which file?" table: `docs/ARCHITECTURE.md` → Source File Map.
- Read `HANDOFF.md`, `docs/RELEASES.md` and `docs/history/` only when the task needs them.

## Verify before committing
- While iterating: `python build.py` plus one test file, e.g. `node --test tests/design-system.test.mjs`.
- Before commit: `bash verify.sh` (build, drift, syntax, scope, render, map, budget, full tests). Run `python gen_map.py` if functions were added, removed or moved.
- UI look changed on purpose: `node tests/ui-contract.mjs --update` and keep the `tests/ui-contract.json` diff.
- Once per clone: `git config core.hooksPath .githooks`.
- Release: bump `WORKER_RELEASE` and add an entry to `docs/RELEASES.md`.

## Handoff (only when the user says credits are low or to wrap up)
Run verify, commit, then fill in `HANDOFF.md`: task in progress, files changed and why, build/test status, next steps.
