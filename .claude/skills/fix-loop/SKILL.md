---
name: fix-loop
description: Fix and independently verify an audit report in a loop, using a Sonnet fixer and an Opus verifier as clean-start subagents. Use only when the user types /fix-loop.
argument-hint: <report path> [finding IDs]
disable-model-invocation: true
model: haiku
---

# Fix/verify loop

Arguments: `$ARGUMENTS` (a report path, optionally finding IDs). If no path was
given, list reports in `docs/audits/` with `open` rows and ask which one.

You only coordinate. Do not fix, verify or edit anything yourself.

## Each round (max 5)
1. Launch the `fix-worker` agent. Prompt: "Run /fix-plan on: $ARGUMENTS".
   Wait for it to finish.
   - If its reply ends with `NEEDS OWNER:`, stop the loop and show the owner
     the question.
2. Launch the `verify-worker` agent. Prompt: "Run /verify-fix on: $ARGUMENTS".
   Wait for it to finish.
3. Read the report's Fix progress table (not the agents' summaries). Stop when
   no row is `open` or `fixed (awaiting verification)`, ignoring rows marked
   owner decision needed. Otherwise start the next round.

Never run the two agents at the same time. Pass nothing between them except the
report path; they share state only through the report and git.

## Finish
Tell the owner in plain English: rounds run, how many findings are verified
fixed, what is still open and why (including skipped owner decisions and any
question), and whether the 5-round cap was hit.
