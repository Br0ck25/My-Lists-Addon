# Non-Coder Guide: Managing Claude Code, Antigravity & Arena.ai

This guide explains how to smoothly rotate between **Claude Code**, **Antigravity (Gemini 3.8 Flash High)**, and **Arena.ai (Agent Mode)** without them fighting, undoing each other's work, or breaking your project.

---

## The 3 Copy-Paste Prompts

Keep these handy! Whenever you switch AI tools, copy and paste the corresponding prompt into the chat.

### Prompt 1: When Claude Code is Running Low on Credits
Copy and paste this into Claude Code before your credits completely run out:

> *"I am running out of credits on Claude Code. Please STOP making new changes immediately. Run `python build.py`, verify that `node --check worker_entry_combined.js` passes, commit your work to Git with a descriptive message, and update `HANDOFF.md` with complete details so the next AI agent can seamlessly continue."*

---

### Prompt 2: When Starting in Antigravity
When you open Antigravity (Gemini 3.8 Flash High) to continue the work, copy and paste this:

> *"Read `HANDOFF.md` and `AGENTS.md` before making any changes. This is a Cloudflare Worker project written in pure Vanilla JavaScript (do NOT use Svelte or frameworks). Follow the next steps in `HANDOFF.md` exactly. Do not refactor existing code. Remember to edit only split files (`00_` through `26_`) and run `python build.py` after editing."*

---

### Prompt 3: When Starting in Arena.ai (Agent Mode)
When you switch to Arena.ai Agent Mode, copy and paste this:

> *"You are working on the My Lists Addon project. Read `HANDOFF.md` and `AGENTS.md`. Follow the next steps in `HANDOFF.md` exactly. Do NOT refactor or change the existing architecture. Rebuild using `python build.py` and verify with `python check_sync.py` after making changes. When done, update `HANDOFF.md` and commit to Git."*

---

## When You Ask For a Visual or Wording Change

Add this line to any request that touches buttons, colours, spacing or text, so every AI follows the same rules:

> Follow `AI_UI_RULES.md` and `DESIGN_SYSTEM.md` for this change, reuse existing buttons and classes, and run the tests before you finish.

---

## The Emergency Undo Button (If an AI Breaks Something)

Because Git is now active on your computer, you have a 100% reliable safety net. If any AI ever breaks something and you don't know how to fix it, just ask the current AI:

> *"Undo all uncommitted changes and restore the project to the last working commit using Git."*

The AI will run:
```bash
git reset --hard HEAD
```
This instantly wipes out whatever broken edits were just made and restores your project to the exact state of the last commit.

---

## Why This Setup Prevents Conflicts

| Problem | How This Setup Fixes It |
|---|---|
| **AI edits the wrong file** | `CLAUDE.md` and `AGENTS.md` explicitly forbid editing `worker_entry_combined.js` directly, forcing all AIs to edit split files `00_` to `26_` and run `python build.py`. |
| **Incoming AI has amnesia** | `HANDOFF.md` tells the next AI exactly what was finished, what was tested, and what to do next. |
| **Style wars & unnecessary rewrites** | All AIs are strictly instructed not to refactor, rename variables, or convert code into frameworks (Svelte/React/TypeScript). |
| **Broken code on credit exhaustion** | The low-credits prompt forces the AI to stop cleanly, test, commit, and document before credits hit zero. |
