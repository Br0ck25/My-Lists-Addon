# Audits: how to run them

Audit reports live in this folder, one file per audit:
`docs/audits/<date>-<type>.md`. Older reports from before this folder existed
are in `docs/` (`SECURITY_AUDIT_PLAN.md`, `BUG_AUDIT_PLAN.md`,
`BACKEND_AUDIT.md`, `CODE_QUALITY_AUDIT.md`, `PERFORMANCE.md`).

There are three commands. Type them into Claude Code, in a new session for
each step.

## 1. Run an audit (best on Opus)
Switch the model first with `/model opus`, then type:

```
/audit testing
```

Types: `security`, `bugs`, `backend`, `code-quality`, `performance`,
`testing`, `database`, `frontend`, `api`, `deployment`, `product`.
The list of what each one checks is in `.claude/skills/audit/checklists/`.

The audit only reads code and writes its report. It changes nothing else. It
saves and pushes its report every few areas. **If it stops** (usage limit, the
session ended), start a new session and type the same command again. It
continues where it left off.

When it finishes, read the "Summary for the owner" and "Questions for the
owner" at the top of the report. Answer the questions in chat, or write your
answer into the report.

## 2. Fix what it found (Sonnet is fine)
`/model sonnet`, then:

```
/fix-plan docs/audits/2026-11-03-testing.md
```

To fix only some items, add their IDs:
`/fix-plan docs/audits/2026-11-03-testing.md TEST-01 TEST-04`.
It writes a failing test first, fixes, runs the checks, and commits each item
on its own. Items waiting on your answer are skipped. Run it again to continue.

## 3. Have the fixes checked independently
In a new session:

```
/verify-fix docs/audits/2026-11-03-testing.md
```

This always runs as a separate Opus reviewer that did not see the fixing work.
It tries to prove each fix wrong and records a verdict: verified fixed,
partially fixed, not fixed, regression introduced, cannot verify, false
positive or accepted risk. Anything not verified goes back to `open`; run
`/fix-plan` again for those.

## Reading a report
- **Severity**: Critical, High, Medium, Low, Info: how much it matters to
  users or data in this project.
- **Confidence**: Confirmed (it was reproduced), High or Medium. Guesses go
  under "Unverified hunches", not in the findings.
- **Fix progress** table: where every finding stands.
- **Checked and fine** and **Not covered**: what was looked at, and what
  could not be (for example real Android TV devices or the live database).
  An audit with no findings in an area is not proof that the area is perfect.

## Usage tips for Claude Pro
- One audit type per session. Don't run several at once.
- Audits are the expensive part. Fixing on Sonnet saves usage.
- If you hit the limit, nothing is lost: the report is pushed to GitHub.
  Come back after the limit resets and type the same command.

## Using these commands in another repo
Copy the `.claude/skills/` folder into the other repo, then rewrite
`.claude/skills/audit/project.md` for that project (its commands, where the
code is, earlier audits). Nothing else is specific to this repo. In the
other repo you can ask Claude: "Rewrite `.claude/skills/audit/project.md` for
this repo."
