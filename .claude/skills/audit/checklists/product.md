# Product functionality audit checklist
This is one of the most overlooked areas. Compare what users are promised
(README, the web page text, addon manifests, docs) with what really works.
Use Playwright for the web UI; drive addon routes with requests.

**Not in this audit:** code-level bugs (bugs audit); look, layout and accessibility (frontend).
**Cannot be checked from a cloud session** (list under "Not covered"): real devices and the Stremio, Nuvio and Wako apps. Write try-it steps for the owner instead.

| Area | What it examines | How to check |
|---|---|---|
| Broken Features | Buttons, screens, and controls that don't work | Click every control on every page with Playwright; note errors and controls that do nothing |
| User Workflow | Whether users can complete intended tasks | Walk the main journeys start to finish: make an account, build a list, install the addon, sync, recover an account, delete an account |
| Feature Completeness | Whether advertised features are actually implemented | List every feature the README and the page text promise; check each one exists and works |
| Placeholder Audit | Fake, unfinished, or simulated functionality | Grep for TODO, "coming soon", mock or hard-coded sample data, disabled flags, buttons wired to nothing |
| Feature Consistency | Whether features behave consistently throughout the app | Same action in different places (web vs Stremio vs Nuvio) gives the same result and wording |
| Settings across devices | Whether a person's choices follow them | Every setting the page offers: saved to the account (follows them) or only in this browser? Flag the ones a person would expect to follow them |
| Requirements Compliance | Whether the implementation matches project requirements | `docs/DECISIONS.md` and `CLAUDE.md` rules vs actual behaviour |
| Permissions | Whether permissions are requested and used correctly | What each third-party sign-in (Trakt, etc.) asks for vs what is used; admin-only features hidden from users |
| Platform Behavior | Whether features work on their intended devices | Addon responses per platform's expected format; TV-size layout. Real devices can't be tested here: list them under "Not covered" |
