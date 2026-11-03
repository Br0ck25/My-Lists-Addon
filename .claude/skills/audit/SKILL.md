---
name: audit
description: Run one read-only audit of this repo (security, bugs, backend, code-quality, performance, testing, database, frontend, api, deployment or product) and write a findings report with a fix plan for a later session. Use only when the user types /audit.
argument-hint: <type>   e.g. security | testing | database | frontend | api | deployment | product
disable-model-invocation: true
---

# Read-only audit: $ARGUMENTS

You are auditing this repository. This is an audit, not a fix: you find,
prove and write down problems, and a later session fixes them with `/fix-plan`.

## 0. Pick the checklist
- Audit type requested: `$ARGUMENTS`.
- The checklists are in `.claude/skills/audit/checklists/`. Read the one that
  matches (for example `security.md`). If no type was given or none matches,
  list the file names and stop.
- Read `.claude/skills/audit/project.md` (this repo's commands, layout,
  earlier audits and ID prefixes).

## 1. Ground rules (they override your defaults)
1. Read the project's own instructions first (`CLAUDE.md`, and any docs
   `project.md` names). Something recorded as a deliberate decision is **not**
   a finding. If you think a decision is wrong, put it under "Questions for
   the owner".
2. **Read-only.** Do not edit source, tests, migrations, schema or config, and
   do not fix anything. The only file you write in the repo is the report.
   Throwaway scripts and experiments go in your scratchpad. If an experiment
   needs a changed copy of the code (for example breaking a function to see
   whether a test notices), do it in a scratch copy or `git worktree` in the
   scratchpad, never in the working tree. `git status` must show only the
   report when you finish.
3. **Evidence or it is not a finding.** Each finding needs `file:line`, a
   short quote, the search or command that proves it, and a concrete failure
   scenario (what input or state, and what goes wrong). Reproduce it when you
   can (run a test, a script, or Playwright for UI) and say whether you did.
   Anything you suspect but could not prove goes under "Unverified hunches".
4. **Search before you report.** Check whether the problem is already handled
   somewhere else (a caller, a wrapper, a guard, a test). Before calling code
   dead or unused, search every way it can be reached (see `project.md`).
5. **Do not re-open earlier audits.** Grep the earlier reports listed in
   `project.md` and `docs/audits/` for the same issue. If it is already there,
   leave it out (or mention it in one line if its status looks wrong).
6. **Never invent findings to look productive.** "Checked and fine" is a valid
   result for an area. Never claim an area was checked when it was not.
7. Never print or copy a secret value into the report. Say where it is, not
   what it is.
8. Read code cheaply: use the project's index files to find code, read only
   the part you need, and never read generated files. Do not launch helper
   agents to sweep the repo; they multiply usage. Work in this session.
9. Depth beats coverage. An area marked `partial` with what is left written
   down is better than a shallow `done`.

## 2. Start or resume
- Today's report path: `docs/audits/<YYYY-MM-DD>-$ARGUMENTS.md`.
- First look in `docs/audits/` for a report of this type whose header says
  `Status: in progress`. If one exists, **resume it**: read its "Audit
  progress" table and continue from the first area not marked done. Do not
  redo finished areas.
- Otherwise run the project's full check once (see `project.md`) and record
  the result as the baseline, so known failures are not reported as new.
  Then create the report from the template below **before** you start
  investigating, with every checklist area listed as `not started`.

## 3. Work area by area
- Go through the checklist areas in the order given (highest risk first).
- After each area: update its row in "Audit progress" (`done`, or `partial`
  with what is left), add its findings, and add what you checked and found
  fine. Save the report.
- Then commit the report alone (`git add <report>`; message
  `audit(<type>): <area> done`) and push to the current branch, after
  **every** area. A usage limit or a closed session can end the work
  mid-sentence with no warning; only what is pushed survives.
- If the context is getting long, stop at the end of an area, save, commit,
  push, and tell the owner to type `/audit $ARGUMENTS` again to resume. Do
  not mark unfinished areas as done.

## 4. Finding IDs and severity
- ID prefix comes from `project.md`. Number on from the highest ID with that
  prefix already in `docs/` (grep it), so IDs never clash with older reports.
- Severity: judge by what actually happens to users or data in this project,
  not by the textbook worst case.
  - **Critical**: someone can see or change another person's data, or data
    is lost, today.
  - **High**: a main feature breaks for many users, or an attack works with
    some effort.
  - **Medium**: breaks in less common situations, or harmful only if
    something else goes wrong first.
  - **Low**: minor or cosmetic.
  - **Info**: worth knowing; nothing to fix.
- Confidence: Confirmed (reproduced), High, Medium. Low confidence goes under
  "Unverified hunches", not "Findings".

## 5. Challenge your own findings
Before finishing, go back over every Critical and High finding and try to
prove it wrong: re-read the code, look for a guard, wrapper or caller check
elsewhere, and check whether the failing input can really reach that line.
If it does not survive, lower its severity or move it to "Unverified
hunches", and note why. Commit and push after this pass.

## 6. Finish
- Fill in the summary, fix order and "Not covered" sections. Set
  `Status: complete` (or `complete with gaps` and say which).
- Check that `git status` shows only the report, then commit and push it.
- Tell the owner in plain English, in a few lines: what you found, what to
  fix first, any questions for them, and the next command
  (`/fix-plan docs/audits/<file>`).

## Report template
```markdown
# <Type> audit (<date>, commit <short sha>)
Status: in progress
Model: <the model you are running on, as the session reports it>

## Summary for the owner
<Plain English, no jargon. What is fine, what is wrong, what a user would
notice, what to fix first. Written last.>

## Baseline
<Full check result at the start: passes, failures, known failures.>

## Audit progress
| Area | Status | Notes |
|---|---|---|
| <every checklist area> | not started / partial / done / skipped (why) | |

## Fix progress
| ID | Severity | Status | Commit | Verified |
|---|---|---|---|---|
<Status is one of: open, fixed (awaiting verification), verified fixed,
partially fixed, not fixed, regression introduced, false positive,
owner decision needed, accepted risk. Only /verify-fix fills "Verified".>

## Rules for the implementer
<Copy the project's fix rules from project.md, plus anything specific to
these findings.>

## Findings
### <ID> (<Severity>, <area>, <Confidence>): <one-line title>
**What a user would notice.** <one or two plain sentences>
**Evidence.** <file:line, short quote, the command or search, reproduced: yes/no>
**Root cause.** <one paragraph>
**Fix.** <smallest safe change, which existing helper to reuse, in steps>
**Test.** <the test that must fail before the fix and pass after>
**Risk.** <what else the fix could break>

## Fix order
<Numbered list: critical security and data loss first, then high-impact
bugs, reliability, performance, then tidy-ups. Group findings one commit can
fix together.>

## Questions for the owner
## Checked and fine
<Per area: what you inspected and found no problem with.>
## Unverified hunches
## Not covered
<What you could not check and why, e.g. no access to production, real
devices, secrets or paid services.>
```
