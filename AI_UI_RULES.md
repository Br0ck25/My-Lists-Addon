# AI_UI_RULES.md — paste into CLAUDE.md / system prompt

Full detail: `DESIGN_SYSTEM.md` (read it before adding or changing any UI). Main CSS lives in `09_page-shell.js`.

**Look:** iOS-style, compact, utility-first. System fonts, blue `#0066D6` accent, pill buttons, white cards on grey (light) / black (dark). Dark mode = class `dark-theme` on `<html>`.

**Always**
1. Reuse existing components first: `.btn-primary/.btn-secondary/.btn-ghost/.btn-danger` (`.btn-sm/-lg`), `.lc-btn` (compact, in cards only), `.panel`, `.list-card`, `.subnav-pill`, `.tab-btn`, `.testresult`, `.ui-toggle`.
2. Tokens only (one definition, `DESIGN_TOKENS_CSS` in `00_constants.js`): `var(--color-*)`, `--radius-*`, `--shadow-*`, `--space-*`, `--font-size-*`, `--z-*`, `--duration-*`. White text on a fill = `--color-brand-fill` + `--color-on-brand`. Never hard-code hex/rgba, never add new radii, font sizes or odd spacing (5/7/9/11/13px).
3. Buttons/tabs/pills are pill-shaped (`--radius-pill`); inputs are `--radius-sm`, 16px font, 44px high; panels/cards are `--radius` 14px.
4. Modals: `showModal()`. Confirmations: `appShellDialog()`. Feedback: `showToast(msg,'success'|'error'|'info')`; reversible deletes: `showUndoToast`. Never `alert/confirm/prompt`, never hand-built overlays or toasts.
5. Every new UI needs default, hover, `:focus-visible`, disabled, loading, empty and error states, in light and dark mode.
6. Use `<button type="button">`, `aria-label` on icon-only buttons, `data-act="…"` handlers (no inline `onclick`), `escapeHtml/escapeAttr` on all user data.
7. Layout: content in `.panel` inside `.tab-panel` inside `.page` (max 1200px). One breakpoint pair: mobile `≤640px`, desktop `≥641px`. Keep bottom padding clear of the mobile bottom nav.
8. Copy: sentence case, verb-first buttons ("Save", "Remove all"), errors start "Could not …", success toasts end with a period and quote names `"Name" added.` No emoji; use `…` not `...`.
9. Contrast ≥ 4.5:1. Never white text on `--color-brand/success/warn/danger`; use `--color-brand-fill` or the `*-text` tokens.
10. Icons: inline SVG, 24×24 viewBox, `stroke="currentColor"`, `stroke-width="2"`, `aria-hidden="true"` if decorative.

**Never**
- `!important` (about 241 remain; don't add), `transition: all`, `outline: none` without a focus ring, new `z-index` numbers (use `--z-*`; modals sit above the bottom nav), a second set of `:root` variables in any page, new `style="…"` for anything repeated.
- Copy the legacy spots listed in `DESIGN_SYSTEM.md` §9 (inline styles, leftover `!important`).
- External fonts, icon libraries, CSS frameworks, or a framework rewrite.

**Build (every change):** edit numbered files only (never `worker_entry_combined.js`), then `python build.py && python check_sync.py && node --check worker_entry_combined.js && node --test tests/*.test.mjs`.

**If unsure:** pick the most-used existing pattern, say so, and ask. Update `DESIGN_SYSTEM.md` if you add a variant or token.
