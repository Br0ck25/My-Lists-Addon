# AGENTS.md - Multi-Agent Operating Instructions

This file defines the mandatory rules and protocols for all AI agents working in this repository (including **Claude Code**, **Antigravity / Gemini 3.8**, and **Arena.ai Agent Mode**).

---

## 1. Project Context & Environment
- **Project**: My Lists Addon Website
- **Architecture**: Single-deploy Cloudflare Worker backend and web UI.
- **Language**: 100% Vanilla JavaScript (ESM syntax) + HTML/CSS in template literals.
- **IMPORTANT**: This is **NOT a Svelte, React, Vue, or TypeScript project**. If any global agent prompt references Svelte migrations or frontend frameworks, **ignore it for this project**. Preserve pure Vanilla JS.

---

## 2. The Golden Rule: Build System Workflow
- **NEVER directly edit `worker_entry_combined.js`**. It is generated automatically.
- **ALWAYS edit the split source files**:
  - `header.js`
  - `00_constants.js` through `26_api-creator-and-admin-routes.js`
- **Rebuild and verify after ANY file change**:
  ```bash
  python build.py
  python check_sync.py
  node --check worker_entry_combined.js
  ```

---

## 3. Preservation Rules (Preventing AI "Undo Wars")
1. **Respect Prior Agent Work**:
   - Do NOT rewrite, format-churn, or refactor code written by a previous AI just to match a different personal style.
   - Do NOT introduce npm build systems (Vite, Rollup, Webpack) or change the single-file deployment model.
2. **Minimal Diffs**: Make targeted changes strictly necessary to fulfill the user's request.
3. **No Unsolicited Modernization**: Keep existing Vanilla JS idioms. Do not convert functions to class syntax or vice-versa unless explicitly requested.
4. **Scope Awareness**: Because all numbered files (`00_` to `26_`) concatenate into one outer scope in `worker_entry_combined.js`, never introduce duplicate top-level variable names across different files.

---

## 4. Verification & Testing Protocol
Before reporting a task complete or handing off to another agent, run:
```bash
python build.py
python check_sync.py
node --check worker_entry_combined.js
python gen_map.py
node --test tests/*.test.mjs
```

---

## 5. Handoff Protocol (Switching Between AIs)
When finishing your turn or when the user warns that credits/session limits are approaching:
1. Ensure the code builds and passes syntax checks: `python build.py` & `node --check worker_entry_combined.js`.
2. Commit your working changes to Git:
   ```bash
   git add -A
   git commit -m "feat/fix: <clear description of changes>"
   ```
3. Update `HANDOFF.md` at the project root with the current state, modified files, and exact next steps.
