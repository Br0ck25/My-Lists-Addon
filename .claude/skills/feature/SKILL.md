---
name: feature
description: Add or change a feature from a plain-English request. Asks the owner's product questions and agrees a short plan before building, then builds test-first and records how the owner can try it. Use only when the user types /feature.
argument-hint: <what you want, in your own words>
disable-model-invocation: true
---

# Feature request

The owner's request, in their words: `$ARGUMENTS`

The owner is not a coder. Your job is to build what they actually want, so
the questions that change what users see come first and the code comes after.
`CLAUDE.md` holds the coding rules and wins over anything below.

Every feature has a notes file: `docs/features/<YYYY-MM-DD>-<short-slug>.md`
(template at the end). It is the memory between sessions and what the
reviewer reads. Commit and push it at each stage.

## 0. Resume or start
- If no request was given, list the files in `docs/features/` whose Status
  is not `done`, and stop.
- If a notes file in `docs/features/` already covers this request and is not
  `done`, read it and continue from its Status. Do not redo finished steps.
  If the request is a notes file path with Status `changes needed`, fix
  exactly the reviewer's numbered list (step 3 rules apply), then hand over
  again (step 4).

## 1. Understand (read-only)
- Find where the feature lives in the code (use the project's index files;
  read only what you need). Work out how it behaves today and why.
- Check `docs/DECISIONS.md`: if the request goes against a recorded decision,
  say so in plain words in step 2.
- Note everything else that touches the same code or data (other apps,
  sync, saved settings, existing users), because that is where a change
  causes surprises.

## 2. Questions and plan (one message, then stop)
Send the owner one message with:
1. **What I understood**: the request restated in one or two plain sentences,
   including how it works today.
2. **Questions**: only choices that change what users see or what happens to
   existing users' data. Typical ones: where the control goes; the default;
   what happens for people who already use the feature; what other apps
   (Stremio, Nuvio, Wako, the web page) should do; edge cases like "all
   hidden". Give each question your recommended answer and a short reason.
   Never ask about technical choices: decide those yourself.
3. **Plan**: at most 8 short plain-English lines: what changes, what the
   owner will see, and what stays the same. Assume your recommended answers.
4. "Reply with your answers, or say **go** to use my recommendations."

Write the notes file (Status: `waiting for owner`), commit and push it,
then **stop and wait**. Do not build anything before the owner answers.

## 3. Build (after the owner answers)
- Record the answers and the final plan in the notes file
  (Status: `building`).
- If an answer changes the plan a lot, show the new plan and wait again.
- Follow `CLAUDE.md`: write the failing test first; each test must fail if
  the feature is removed. Small steps; quick check after each; one commit
  per step; push after each commit.
- Stay inside the approved plan. If you find you need something the plan
  did not cover (a database change, removing something, changing another
  feature), stop and ask.
- Before finishing: the full check, compared with how it was before you
  started (record that at the start of building). Only new failures are
  yours. Add the `docs/RELEASES.md` entry.

## 4. Hand over
Fill in the notes file: commits, files changed, tests added, check results,
and **How to try it**: numbered steps the owner can do on the website or in
the real app (for example the Nuvio app on their TV), with what they should
see at each step. Include one step that checks nothing else changed. Set
Status: `awaiting review`, commit and push.

Tell the owner in plain English: what was built, the try-it steps, and the
next command: `/review-feature docs/features/<file>` in a new session.

## Notes file template
```markdown
# <Feature name in plain words> (<date>)
Status: waiting for owner | building | awaiting review | changes needed | done
Model: <the model you are running on, as the session reports it>

## Request
<The owner's words, unedited.>

## How it works today
## Questions and answers
<Each question, the recommendation, and the owner's answer.>

## Approved plan
## Before building
<Full check result before any change.>

## What was built
<Commits, files changed and why, tests added and what each proves.>

## How to try it
1. <step> → you should see <result>

## Review
<Filled in by /review-feature only.>
```
