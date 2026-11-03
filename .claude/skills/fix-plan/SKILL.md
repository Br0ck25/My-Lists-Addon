---
name: fix-plan
description: Work through the fix plan in an audit report from /audit, one finding at a time, test-first, updating the report's Fix progress table. Use only when the user types /fix-plan.
argument-hint: <report path> [finding IDs]   e.g. docs/audits/2026-11-03-testing.md TEST-01 TEST-02
disable-model-invocation: true
---

# Fix findings from an audit report

Arguments: `$ARGUMENTS` (a report path, optionally followed by finding IDs).
If no path was given, list the reports in `docs/audits/` whose Fix progress
table still has `open` items, and ask which one.

## Before you start
1. Read `CLAUDE.md` and the report's "Rules for the implementer". They win
   over anything below.
2. Run `git status`. If there are uncommitted changes you did not make, stop
   and ask the owner what to do with them. Never discard them.
3. Which findings: the IDs given, otherwise the report's "Fix order" from the
   top, skipping anything not `open` (for example verified fixed, accepted
   risk, or owner decision needed).
4. Skip any finding marked "owner decision needed" or listed under "Questions
   for the owner" until the report records the owner's answer. Tell the owner
   which ones you skipped and the question to answer.

## For each finding, in order
1. Re-read the finding and the code it points to. If the code has changed
   and the finding no longer applies, mark it `not fixed` with a note "no
   longer reproduces at <sha>", and move on. Do not invent a different fix.
2. Write the failing test first. Run it and confirm it fails for the reason
   the finding describes.
3. Make the smallest root-cause fix the finding describes, reusing existing
   helpers. If the fix turns out to need a bigger or riskier change than the
   report says (deleting data, changing what users see, changing a decision),
   stop and ask the owner.
4. Run the test (must pass) and the project's quick check. Before each push,
   run the full check and compare it with the report's Baseline: only new
   failures are yours to fix.
5. Commit that finding alone, with the ID in the message (`fix(TEST-03): ...`).
6. Update the report's Fix progress row: status `fixed (awaiting
   verification)` and the commit hash. Never fill in the "Verified" column:
   only `/verify-fix` does that, in a separate review.
7. Push after each finding, or every few small ones. A cloud session can end
   without warning.

## Rules
- Never skip, delete or loosen a test or guard to get green.
- Do not fix things outside the findings you are working on. If you notice a
  new problem, add it to the report under "Unverified hunches" with a note.
- Changing code is not proof it works. Report what you ran and what it said.
- If you are running low on usage, finish or undo the current finding,
  commit, push, and tell the owner to type the same `/fix-plan` again.

## Finish
Tell the owner in plain English what you fixed, what you skipped and why, and
the next step:
`/verify-fix <report path>` (best run in a fresh session on Opus).
