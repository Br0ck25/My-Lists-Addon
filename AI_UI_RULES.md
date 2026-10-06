# AI_UI_RULES.md — paste into CLAUDE.md / system prompt

Full detail: `DESIGN_SYSTEM.md` (read it before adding or changing any UI). Main CSS lives in `09_page-shell.js`.

**Look:** iOS-style, compact, utility-first. System fonts, blue `#007AFF` accent, pill buttons, white cards on grey (light) / black (dark). Dark mode = class `dark-theme` on `<html>`.

**Always**
1. Reuse existing components first: `.btn-primary/.btn-secondary/.btn-ghost/.btn-danger` (`.btn-sm/-lg`), `.lc-btn` (compact, in cards only), `.panel`, `.list-card`, `.subnav-pill`, `.tab-btn`, `.testresult`, `.ui-toggle`.
2. Tokens only: `var(--color-*)`, `--radius-*`, `--shadow-*`, `--space-*`, `--font-size-*`. Never hard-code hex/rgba, never add new radii, font sizes or odd spacing (5/7/9/11/13px).
3. Buttons/tabs/pills are pill-shaped (`--radius-pill`); inputs are `--radius-sm`, 16px font, 44px high; panels/cards are `--radius` 14px.
4. Modals: `showModal()`. Confirmations: `appShellDialog()`. Feedback: `showToast(msg,'success'|'error'|'info')`; reversible deletes: `showUndoToast`. Never `alert/confirm/prompt`, never hand-built overlays or toasts.
5. Every new UI needs default, hover, `:focus-visible`, disabled, loading, empty and error states, in light and dark mode.
6. Use `<button type="button">`, `aria-label` on icon-only buttons, `data-act="…"` handlers (no inline `onclick`), `escapeHtml/escapeAttr` on all user data.
7. Layout: content in `.panel` inside `.tab-panel` inside `.page` (max 1200px). One breakpoint pair: mobile `≤640px`, desktop `≥641px`. Keep bottom padding clear of the mobile bottom nav.
8. Copy: sentence case, verb-first buttons ("Save", "Remove all"), errors start "Could not …", success toasts end with a period and quote names `"Name" added.` No emoji; use `…` not `...`.
9. Contrast ≥ 4.5:1. Don't put white text on green/orange fills.
10. Icons: inline SVG, 24×24 viewBox, `stroke="currentColor"`, `stroke-width="2"`, `aria-hidden="true"` if decorative.

**Never**
- `!important` (336 already exist; don't add), `transition: all`, `outline: none` without a focus ring, new `z-index` numbers (modal 1000, toast 99999), new `style="…"` for anything repeated.
- Copy legacy spots: admin / backup pages' own token sets, `.action-toast`, `.undo-toast`, `html.dark-theme` / `body.dark-theme` selectors, `.lc-btn` `!important` padding.
- External fonts, icon libraries, CSS frameworks, or a framework rewrite.

**Build (every change):** edit numbered files only (never `worker_entry_combined.js`), then `python build.py && python check_sync.py && node --check worker_entry_combined.js && node --test tests/*.test.mjs`.

**If unsure:** pick the most-used existing pattern, say so, and ask. Update `DESIGN_SYSTEM.md` if you add a variant or token.
