# Frontend and UI/UX audit checklist
Use Playwright against the locally built app (see project.md). A movie is
never a "show" or "episode". Judge against `docs/AI_UI_RULES.md` and
`docs/DESIGN_SYSTEM.md`, not personal taste.

**Not in this audit:** whether whole features work end to end (product audit); page speed (performance).
**Cannot be checked from a cloud session** (list under "Not covered"): real phones, TVs and the Stremio, Nuvio and Wako apps. Emulate sizes and remote-control keys in Playwright instead.

| Area | What it examines | How to check |
|---|---|---|
| Error States | How the application handles failures | Make the API fail (network off, 500, slow) and see what each page shows; bad saved browser data must not break the page |
| State Management | Incorrect or inconsistent UI state | Do lists, counts and buttons update after every action? Two tabs open; back button; reload mid-edit |
| Navigation | Broken navigation and confusing workflows | Click every tab, link and menu; deep links; dead ends |
| Loading States | Missing loading indicators and feedback | Slow the network; every button that waits must show it is working and block double clicks |
| Accessibility | Screen readers, navigation, contrast, accessibility | Keyboard only; focus visible; labels on inputs and icon buttons; contrast of tokens; run axe-core in Playwright if available |
| Responsive Design | Different screen sizes and orientations | Screenshots at 360, 768, 1280 and 1920 wide, portrait and landscape; no sideways scroll |
| UI Consistency | Inconsistent styling and components | One-off button styles, hex colours, odd sizes vs the design system |
| User Experience | Unnecessary steps and confusing interactions | Count steps for the main tasks; unclear wording; jargon |
| Platform Compatibility | Android, Android TV, mobile, desktop, etc. | Emulate mobile and TV-size screens and remote/arrow-key navigation in Playwright. Real devices and the Stremio/Nuvio/Wako apps can't be tested here: list them under "Not covered" |
