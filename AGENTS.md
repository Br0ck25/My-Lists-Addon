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
