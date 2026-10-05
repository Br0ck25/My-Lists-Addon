# CLAUDE.md - Rules and Instructions for Claude Code

## Project Overview
This repository (`My Lists Addon Website`) is a high-performance, single-deploy **Cloudflare Worker** and web application for Stremio, Nuvio, and Wako add-ons. It serves both the backend API and the frontend client UI.

- **Stack**: Pure Vanilla JavaScript (ESM), Cloudflare Workers API (D1, KV, Cron triggers), and template-literal HTML/CSS.
- **Production Deployment**: Compiled into a single file `worker_entry_combined.js` which is pasted directly into the Cloudflare dashboard.
- **Non-Technical User**: The user is NOT a coder. You must handle all operations, commands, testing, and git commits cleanly and reliably.

---

## 🚨 CRITICAL ARCHITECTURAL CONSTRAINTS (DO NOT VIOLATE)

### 1. The Build System Rule (NEVER EDIT `worker_entry_combined.js` DIRECTLY)
- The codebase is split into numbered files: `header.js`, `00_constants.js` through `26_api-creator-and-admin-routes.js`.
- `worker_entry_combined.js` is **AUTO-GENERATED** by `python build.py`.
- **NEVER** edit `worker_entry_combined.js` directly! Any edits made there will be completely wiped out on the next build.
- **ALWAYS** edit the numbered source files (`00_` through `26_`) or `header.js`.
- After making ANY code changes, you **MUST** run:
  ```bash
  python build.py
  python check_sync.py
  ```

### 2. No Unsolicited Refactoring or "Modernization"
- **DO NOT** rewrite Vanilla JS into TypeScript, Svelte, React, Vue, or JSX.
- **DO NOT** rearrange files into `src/` or install external build tools (like Vite, Webpack, or Rollup).
- **DO NOT** modify working logic or rename variables unless specifically requested by the user.
- **Preserve Shared Scope**: All numbered files are concatenated into a single outer scope. Avoid declaring conflicting global `const`/`let` names across different files.

### 3. Safe Escaping in Template Literals
- The HTML UI and admin pages are rendered inside JavaScript template strings.
- Never use unescaped `</script>` inside inline scripts or strings (use `<\/script>` or external escaping) to prevent breaking script execution or introducing XSS.

---

## Senior Developer Efficiency Rules

Work like a highly experienced senior developer. The objective is not to produce more code; it is to make the smallest correct change that fully solves the actual problem.

### Before writing code
1. Understand the request completely.
2. Read the relevant existing code and trace the affected flow end-to-end.
3. Search for existing implementations, helpers, utilities, components, routes, and patterns.
4. Search all callers/usages of code that may be changed.
5. Identify the actual root cause or required behavior.
6. Determine whether new code is actually necessary.

Before adding anything, check in this order:
- Can existing code handle it?
- Can an existing helper be reused or extended?
- Can an existing component/pattern be reused?
- Can standard JavaScript/platform functionality handle it?
- Can an already-installed dependency handle it?
- Can the requirement be solved by deleting or simplifying existing code?
- Only then create new code.

### Minimal implementation
Prefer fewer lines, fewer files, existing helpers/patterns/dependencies, simple direct solutions, and deletion over addition.

Avoid unnecessary abstractions, duplicate helpers, wrappers, new dependencies for trivial functionality, boilerplate, unrelated cleanup, stylistic rewrites, and unrequested architecture changes. Do not optimize for the smallest diff before understanding the problem. A tiny change in the wrong location is worse than a slightly larger change that fixes the root cause.

### Bug fixes: fix the root cause
A bug report is usually a symptom. Find the responsible function or data flow, search every caller, determine whether multiple paths share the problem, and fix the shared root cause when appropriate. Do not patch only the exact path mentioned if the same underlying problem exists elsewhere.

### Do not over-engineer
If two approaches are correct, prefer the simpler one. Do not introduce abstractions or infrastructure unless the existing code genuinely cannot support the requirement. Before implementing a complicated approach, ask: “Do we actually need this, or does something we already have cover it?”

### Preserve existing behavior
Unless explicitly requested otherwise, do not rewrite working code merely because you would implement it differently. Do not refactor, rename, reorganize, or change unrelated APIs, database behavior, caching behavior, or UI behavior.

### Correctness beats cleverness
Efficiency never means cutting corners on security, authentication, authorization, validation, error handling, data integrity, accessibility, user-visible correctness, or architectural constraints.

### Verification and final review
For every non-trivial change, leave a meaningful verification using the smallest appropriate existing test, focused test, syntax check, targeted command, or reproducible verification step. Before reporting completion, review the actual diff for accidental changes, duplicated logic, unused code, and broken references; verify the requested behavior; run the required project checks; and confirm unrelated functionality was not unnecessarily changed.

### Core principle
> Understand more. Change less.

## Build, Test & Verification Commands

Whenever you make changes, run these commands in order:

1. **Rebuild the combined Worker**:
   ```bash
   python build.py
   ```
2. **Verify build synchronization (no drift)**:
   ```bash
   python check_sync.py
   ```
3. **Syntax-check the combined Worker**:
   ```bash
   node --check worker_entry_combined.js
   ```
4. **Update the function map (if functions were added/removed/moved)**:
   ```bash
   python gen_map.py
   ```
5. **Run the test suite**:
   ```bash
   node --test tests/*.test.mjs
   ```

---

## Multi-AI Collaboration & Handoff Protocol

The user works across **Claude Code**, **Antigravity (Gemini 3.8 Flash High)**, and **Arena.ai (Agent Mode)**.
When the user indicates that credits are low or asks to wrap up/hand off:

1. **Verify everything builds and passes syntax checks**:
   ```bash
   python build.py
   python check_sync.py
   node --check worker_entry_combined.js
   ```
2. **Stage and commit working code to Git**:
   ```bash
   git add -A
   git commit -m "feat/fix: <descriptive message of what was accomplished>"
   ```
3. **Update `HANDOFF.md`**:
   Fill in `HANDOFF.md` at the project root with:
   - What task was in progress
   - Exactly which files were modified and why
   - Test and build status
   - Clear, step-by-step next actions for the incoming agent.
