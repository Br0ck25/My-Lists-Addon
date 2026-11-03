# Features: how to ask for one

Each feature built with `/feature` gets a notes file here:
`docs/features/<date>-<name>.md`. It records your request, the questions and
your answers, the plan you approved, what was built, how to try it, and the
review.

## 1. Ask (any model; Sonnet saves usage)
Type `/feature` and then describe what you want in your own words, the
way you normally would:

```
/feature when a user syncs collections to nuvio every list shows on the nuvio home screen. give them a toggle to hide these from the home screen
```

Claude looks at how it works today, then replies with what it understood,
a few questions (each with its recommended answer), and a short plan.
**Nothing is built yet.** Answer the questions, or reply **go** to accept
the recommendations.

## 2. It builds
After your answer it builds the feature with tests, runs every check,
commits and pushes. It ends with **How to try it**: steps for you on the
website or in the real app, with what you should see.

If the session stops part-way, type the same `/feature` request again. It
picks up from the notes file.

## 3. Independent review (new session)

```
/review-feature docs/features/2026-11-03-nuvio-home-toggle.md
```

This always runs as a separate Opus reviewer. It checks that the feature
matches the plan you approved and that nothing else broke. If it says
**changes needed**, type `/feature docs/features/<the same file>` to have them
fixed, then review again.

## 4. Try it yourself
Follow the "How to try it" steps in the notes file on your own device.
Claude cannot open the Nuvio, Stremio or Wako apps, so this step is yours.
