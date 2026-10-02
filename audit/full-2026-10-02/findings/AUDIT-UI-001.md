## [AUDIT-UI-001] [P3] Like buttons in search results and list cards have non-meaningful accessible names

**Area:** Frontend / Accessibility  
**Confidence:** HIGH — deterministically proven from source and confirmed via browser  
**Location:** [`19_client-search-and-likes.js:1007-1016`](../../../19_client-search-and-likes.js#L1007-L1016), [`19_client-search-and-likes.js:2104`](../../../19_client-search-and-likes.js#L2104), [`19_client-search-and-likes.js:2155`](../../../19_client-search-and-likes.js#L2155), [`19_client-search-and-likes.js:2315-2319`](../../../19_client-search-and-likes.js#L2315-L2319)

### Actual Behavior

Four rendering sites produce `<button class="lc-btn searchLikeBtn …">&#9829;</button>` or `<button class="lc-btn searchLikeExternalBtn …">&#9825;</button>` with no `aria-label`, `title`, or `aria-labelledby`. The computed accessible name is the Unicode text content — U+2665 BLACK HEART SUIT (♥) or U+2661 WHITE HEART SUIT (♡). Screen readers announce this literally as "black heart suit" or "white heart suit" with no indication that the button likes or unlikes a list.

When the button state changes the code does `likeBtn.textContent = '\u2661'` or `likeBtn.textContent = '\u2665'` (lines 1625, 1629) — the accessible name updates to the opposite heart character, which also gives no functional context.

### Expected Behavior

WCAG 2.4.6 (Labels or Instructions) and WCAG 4.1.2 (Name, Role, Value) require that interactive controls have a label that describes their purpose. A button whose accessible name is "white heart suit" fails this. The accessible name should describe the action and its context, e.g. `aria-label="Like list" / "Unlike list"` (or with the list name if determinable).

### Why This Is Wrong

A screen reader user landing on a search result sees "black heart suit" button with no indication of what it toggles, what it relates to, or what the current state is. WCAG 2.4.6 requires descriptive labels; WCAG 4.1.2 requires that the Name, Role, and Value are programmatically determinable.

Note: the detail-panel like button at `23_client-list-management.js:3313` IS correctly labelled (`aria-label="Like this channel"` / `"Like this list"` set dynamically). The issue is confined to the search results and list browsing cards.

### Evidence

- Browser inspection via Playwright (Chrome headless): all `searchLikeBtn` and `searchLikeExternalBtn` buttons have `ariaLabel: null`, `title: null`, `text: "♡"` or `"♥"`.
- Source: four rendering sites in `19_client-search-and-likes.js` — none include `aria-label` or `title` in the HTML string.
- State update code at lines 1625 and 1629 uses `likeBtn.textContent` only, not `setAttribute('aria-label', ...)`.
- Negative control: detail-panel `#detailLikeBtn` at `23_client-list-management.js:3313` correctly receives `aria-label="Like this channel"` / `"Like this list"` — showing the codebase knows how to label it.

### Reproduction

```bash
# Using the probe (run from scratch directory):
node audit/full-2026-10-02/probes/p09_ui_accessibility.mjs
# See S4-03: 41 buttons identified (probe logic matched ♡ correctly)
```

Or manual: load the app, open search results, inspect any `searchLikeExternalBtn` button with DevTools Accessibility panel.

### Negative Control

Detail panel `#detailLikeBtn` has `aria-label="Like this list"` when populated (`23_client-list-management.js:3326`) — correct pattern demonstrating developer knows how to do it.

### Root Cause

The four `searchLikeBtn`/`searchLikeExternalBtn` rendering sites in `19_client-search-and-likes.js` never received `aria-label` when the like button pattern was introduced. The detail panel version was updated but search result rendering was not.

### Impact

Screen reader users browsing search results or the liked-lists tab cannot determine the purpose of the heart icon buttons without exploring the surrounding context. They cannot tell whether a ♡ means "like this" or "already liked" or "unlike". WCAG 2.4.6 AA failure.

### Coverage Gap

No accessibility test checks for `aria-label` presence on dynamically-rendered like buttons. The existing `client-escapes.test.mjs` covers XSS, not accessibility.

### Fix Direction

At each of the four rendering sites in `19_client-search-and-likes.js`, add an `aria-label` attribute:
- `aria-label="Like"` or `aria-label="Like this list"` when `alreadyLiked`/`alreadyLikedExt` is false
- `aria-label="Unlike"` or `aria-label="Unlike this list"` when true

Also update the state-change code at lines 1625–1629 to set `aria-label` alongside `textContent`.

### Regression Test

Assert that all rendered `searchLikeBtn` and `searchLikeExternalBtn` buttons have a non-empty `aria-label` attribute.
