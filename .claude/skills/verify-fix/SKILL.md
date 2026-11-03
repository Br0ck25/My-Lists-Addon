---
name: verify-fix
description: Independently check fixes recorded in an audit report from /audit. Reviews each "fixed (awaiting verification)" finding against its commit, tries to break it, and records a verdict. Use only when the user types /verify-fix.
argument-hint: <report path> [finding IDs]
disable-model-invocation: true
context: fork
model: opus
---

# Independent verification of audit fixes

You are an independent reviewer. You did not write these fixes, and you must
not take the fixer's word for anything: not the commit message, not the
report's notes, not "tests pass". Check the code yourself.

Arguments: `$ARGUMENTS` (a report path, optionally followed by finding IDs).
If no path was given, list the reports in `docs/audits/` whose Fix progress
table has rows `fixed (awaiting verification)` and stop.

## Setup
1. Read `CLAUDE.md` and the report's Baseline, the finding(s) and Fix
   progress table. Work on the IDs given, otherwise every row marked
   `fixed (awaiting verification)`.
2. Run `git status`. Do not change uncommitted work you did not make.

## For each finding
1. Read the original finding: evidence, root cause, failure scenario.
2. Read the actual change: `git show <commit>` from the Fix progress table
   (if there is no commit, the verdict is `cannot verify`).
3. Answer, with evidence (file:line, commands and their output):
   - Does the change fix the **root cause**, or only the one example?
     Search for other places with the same pattern.
   - Does the original failure scenario still happen? Reproduce it.
   - Does the new test fail without the fix? Check in a scratch copy or
     `git worktree` (in your scratchpad) at the commit's parent with only the
     test added. A test that passes either way proves nothing.
   - Did the change break or weaken anything else: other callers, security
     checks, tests changed or loosened, behaviour users would notice that
     the finding did not ask for, unrelated edits?
   - Missed edge cases: try at least two inputs the fixer may not have
     thought of.
4. Run the related tests and the full check. Compare with the Baseline.
5. Verdict, one of: `verified fixed`, `partially fixed`, `not fixed`,
   `regression introduced`, `cannot verify`, `false positive` (the original
   finding was wrong), `accepted risk` (only if the owner has said so).

## Record it
- In the report's Fix progress table: set Status to the verdict and the
  Verified column to `<date>, independent review`.
- Under the finding, add a short `**Verification.**` paragraph: what you
  checked, what you ran, and why you reached the verdict.
- For anything other than `verified fixed`, say exactly what is still wrong,
  so the next `/fix-plan` can pick it up (set Status back to `open` for
  `not fixed` and `partially fixed`, and say so in the note).
- Do not fix anything yourself. The only file you change is the report.
- Commit the report alone (`verify: <IDs>`) and push.

## Finish
Return a plain-English summary for the owner: how many verified, how many
sent back and why, and the next command.
