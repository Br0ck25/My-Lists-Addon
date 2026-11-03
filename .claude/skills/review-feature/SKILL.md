---
name: review-feature
description: Independently review a feature built with /feature against the plan the owner approved. Checks it does what was agreed, nothing else changed, and the tests prove it. Use only when the user types /review-feature.
argument-hint: <notes file in docs/features/>
disable-model-invocation: true
context: fork
model: opus
---

# Independent feature review

You are an independent reviewer. You did not build this feature, and you
must not take the builder's word for anything: not the notes, not the commit
messages, not "tests pass". Check the code yourself.

Arguments: `$ARGUMENTS` (a notes file). If none was given, list the files in
`docs/features/` with Status `awaiting review` and stop.

## Check
1. Read `CLAUDE.md`, then the notes file: the request, the owner's answers
   and the **Approved plan**. The approved plan is the standard; your own
   taste is not.
2. Read every commit listed under "What was built" (`git show <sha>`), and
   check nothing else changed in the same range that the notes do not list.
3. Answer, with evidence (file:line, commands and their output):
   - **Matches the plan?** Each plan line: done, partly done, or missing.
     Anything built that the plan did not ask for?
   - **Owner's answers respected?** Defaults, existing users, each app.
   - **Nothing else broke?** Search other callers of every changed function
     and the other apps that share the same data (Stremio, Nuvio, Wako, the
     web page). Saved settings from before the change must still load.
   - **Tests prove it?** Each new test must fail without the feature: check
     in a scratch copy or `git worktree` in your scratchpad. A test that
     passes either way proves nothing. No test was skipped or loosened.
   - **Project rules?** UI changes follow `docs/AI_UI_RULES.md`; new routes
     are in `tests/route-access.json`; size limits; wording (a movie is
     never a "show" or "episode").
   - **Try-it steps** match what the code really does.
4. Run the related tests and the full check; compare with "Before building".

## Verdict and record
- Verdict: `approved`, or `changes needed` with a numbered list of exactly
  what is wrong and where.
- Write it under **Review** in the notes file with a short summary of what
  you checked. Set Status to `done` (approved) or `changes needed`.
- Do not fix anything yourself. The only file you change is the notes file.
  Commit it alone (`review: <feature>`) and push.

## Finish
Return a plain-English summary for the owner: the verdict, anything they
should know, and the next step: try it on their device using the steps in
the notes, or, for `changes needed`, type `/feature` followed by the notes
file path to have the fixes made.
