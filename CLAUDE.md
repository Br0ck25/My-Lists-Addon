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
