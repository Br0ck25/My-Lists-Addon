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

## Sync first (the two commands run in different sessions)
Every cloud session gets its own branch and a shallow clone, so the other
command's commits and the report's commit hashes are often missing here.
Before anything else:
1. `git fetch --unshallow origin 2>/dev/null || git fetch origin` then
   `git fetch origin '+refs/heads/*:refs/remotes/origin/*'`.
2. Find the newest version of the report on any remote branch:
   `git for-each-ref --sort=-committerdate --format='%(refname:short)' refs/remotes/origin | while read b; do git log -1 --format="$b %h %cd" --date=iso "$b" -- <report path>; done | sort -k3,4 -r | head -3`
   If the newest is not on your branch and your branch has nothing of its own
   to keep, `git merge --no-edit <that branch>`; otherwise merge it in and
   resolve conflicts by keeping the Fix progress rows with the later state
   (verdict beats `fixed (awaiting verification)`, which beats `open`).
3. A commit hash in the report that still cannot be found
   (`git cat-file -t <hash>`) after this: search by ID,
   `git log --all --oneline --grep='<ID>'`, and use that commit instead.
   Say in the report which hash you actually used.
4. Tell the owner which branch you are on and which branch the report came from.

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
- Commit the report alone (`verify: <IDs>`) and push to your current branch, then run `git log origin/<branch> -1` to confirm the push landed, and tell the owner the branch name so `/fix-plan` can pick it up.

## Finish
Return a plain-English summary for the owner: how many verified, how many
sent back and why, and the next command.
