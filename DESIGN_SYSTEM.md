# DESIGN_SYSTEM.md — My Lists Addon UI standard

> **Audience: AI assistants (and humans) adding or changing UI.** Follow every rule here. Where this file says "legacy", do **not** copy it.
> Source of truth: the **tokens** are one constant, `DESIGN_TOKENS_CSS` in `00_constants.js`, shared by the app (`09_page-shell.js`), the admin pages (`03_admin.js`) and the backup guide (`24_…`). The component CSS is the app stylesheet in `09_page-shell.js` (between `/*MYLISTS_APP_CSS_START*/` and `/*MYLISTS_APP_CSS_END*/`). The 2026-10-06 audit's remediation has been applied (see §9 for what is left). Search for selectors; line numbers drift.
> Edit the numbered source files only, never `worker_entry_combined.js`. After any change run `python build.py`, `python check_sync.py`, `node --check worker_entry_combined.js`, `node --test tests/*.test.mjs` (see `CLAUDE.md`).

---

## 1. Overview

My Lists Addon is a mobile-first web app for building and managing Stremio / Nuvio / Wako catalogs, lists and channels. The look is **iOS / macOS native**: system font, Apple system colours (`#007AFF` blue), soft shadows, pill-shaped buttons and tabs, grouped light-grey canvas with white cards (light) or true black with `#1C1C1E` cards (dark). It is **compact and utility-first**: small type (about 13–15px), poster-heavy grids, minimal decoration, no third-party fonts or icon libraries.

Stack facts that constrain every change:
- Vanilla JS in template literals; no framework, no build tool beyond `build.py`.
- One shared stylesheet for the main app (`09_page-shell.js`) and **one shared token constant** (`DESIGN_TOKENS_CSS`, `00_constants.js`) used by the app, the admin pages (`03_admin.js` ×2) and the backup/restore guide (`24_client-backup-restore-presets.js`).
- Strict CSP: every inline `<style>`/`<script>` carries `nonce="${CSP_NONCE_PLACEHOLDER}"`. Never write `</script>` unescaped inside a script string.
- Dark mode = class `dark-theme` on `<html>` (`document.documentElement`), set from `localStorage.theme` or `prefers-color-scheme`. There is no `@media (prefers-color-scheme)` CSS.
- Icons are inline SVG. No icon font, no sprite file, no external fonts.

---

## 2. Tokens

All tokens live in `:root` (light) and `:root.dark-theme` (dark) in `09_page-shell.js` (~lines 294–472). **Use the semantic `--color-*` names in new code.** The short aliases (`--accent`, `--text`, `--muted`, `--surface`, `--border`…) resolve to the same values and are used heavily in existing CSS (e.g. `--accent` ×95); they are accepted when editing an existing rule that already uses them, but do not introduce new ones.

### 2.1 Colours

| Token | Light | Dark | Use |
|---|---|---|---|
| `--color-bg-canvas` | `#F2F2F7` | `#000000` | Page background (`body`, `html`) |
| `--color-bg-surface` | `#FFFFFF` | `#1C1C1E` | Cards, panels, inputs, secondary buttons |
| `--color-bg-elevated` | `#FFFFFF` | `#2C2C2E` | Modals |
| `--color-bg-sunken` | `#E5E5EA` | `#161618` | Hover fill on secondary controls, disabled inputs, close buttons |
| `--color-bg-overlay` | `rgba(0,0,0,.45)` | `rgba(0,0,0,.65)` | Modal backdrop |
| `--color-border-subtle` | `rgba(0,0,0,.08)` | `rgba(255,255,255,.14)` | Panel/card outlines, dividers |
| `--color-border-strong` | `rgba(0,0,0,.14)` | `rgba(255,255,255,.24)` | Control outlines (buttons, inputs, pills) |
| `--color-border-focus` | `#0066D6` | `#0A84FF` | Focus border (defined, currently unused) |
| `--color-text-primary` | `#1C1C1E` | `#FFFFFF` | Headings, body |
| `--color-text-secondary` | `#3A3A3C` | `#EBEBF5` | Button labels, secondary body |
| `--color-text-muted` | `#636366` | `#AEAEB2` | Meta text, hints, placeholders |
| `--color-text-inverse` | `#FFFFFF` | `#000000` | Text on brand/danger fills |
| `--color-brand` | `#0066D6` | `#0A84FF` | Brand **text**, borders, links, focus ring |
| `--color-brand-hover` / `-active` | `#0055B8` / `#00459A` | `#0071E3` / `#0056B3` | Text/border hover states |
| `--color-brand-fill` / `-fill-hover` / `-fill-active` | `#0066D6` / `#0055B8` / `#00459A` | `#0A64D8` / `#0B5FCC` / `#0A54B3` | **Backgrounds that carry white text** (primary button, active tab, badges). ≥ 5:1 with white |
| `--color-on-brand` | `#FFFFFF` | `#FFFFFF` | Text/icons on any filled colour (never write `#fff`) |
| `--color-brand-wash` / `-subtle` / `-tint` / `-line` | alpha `.08 / .12 / .16 / .35` | `.14 / .18 / .24 / .40` | Resting tint / soft fill / hover fill / tinted border. The same four exist for `--color-danger-*` |
| `--color-brand-2` | `#34AADC` | `#5AC8FA` | Second gradient stop only (Wako button) |
| `--color-danger` / `-hover` / `-subtle` | `#FF3B30` / `#D70015` / `rgba(255,59,48,.12)` | `#FF453A` / `#FF6961` / `rgba(255,69,58,.18)` | Destructive actions, errors |
| `--color-success` / `-hover` / `-subtle` | `#34C759` / `#248A3D` / `rgba(52,199,89,.12)` | `#30D158` / `#34C759` / `rgba(48,209,88,.18)` | Success text/chips |
| `--color-warn` / `-hover` / `-subtle` | `#FF9500` / `#C97000` / `rgba(255,149,0,.12)` | `#FF9F0A` / `#FFB340` / `rgba(255,159,10,.18)` | Warnings |
| `--color-success-text` / `-warn-text` / `-danger-text` | `#1F7A35` / `#B25000` / `#D70015` | `#30D158` / `#FF9F0A` / `#FF453A` | Coloured **text** on white/tinted surfaces (≥ 4.5:1) |
| `--color-badge-tmdb/-mylists/-imdb` | `#00769E` / `#7B2FA8` / `#7A5C00` | `#5AC8FA` / `#BF5AF2` / `#F5C518` | Source badge text |
| `--color-rating-high/mid/low` | `#1F7A35` / `#B25000` / `#C41E14` | same | Rating badge fills (white text, ≥ 5:1) |

**Contrast rules.** Text on a filled colour: use `--color-brand-fill` (or a `--color-rating-*`) with `--color-on-brand`; never `--color-brand`, `--color-success`, `--color-warn` or `--color-danger` as a background behind white text (they measure 2.2–4.0:1). Coloured text on white: use the `*-text` tokens. Muted text is `--color-text-muted` (5.4:1 light).

### 2.2 Typography

Font stacks (device fonts only; D-20 in `docs/DECISIONS.md` removed Google Fonts on purpose):

```css
--font-body:  -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, system-ui, sans-serif;
--font-mono:  ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
```

Base: `body { font-size: 15px; -webkit-font-smoothing: antialiased; }`.

| Role | Token / value | Weight | Where |
|---|---|---|---|
| Micro badge | `--font-size-2xs` `0.68rem` | 700–800 | Rating/source badges, tiny labels |
| Caption / compact control | `--font-size-xs` `0.75rem` | 600 | `.lc-btn`, bottom-nav labels |
| Secondary text / pills | `--font-size-sm` `0.85rem` | 600 | Pills, hints, toasts, meta |
| Body / control | `--font-size-base` `0.925rem` | 400–600 | Buttons, general body |
| Large body | `--font-size-md` `1rem` | 600 | Dialog headings, app-shell h3 |
| Panel title | `1.1rem` (≈ `--font-size-lg` `1.15rem`) | 700, `letter-spacing:-0.01em` | `.panel-title` |
| App title | `--font-size-xl` `1.35rem` | 700 | `.app-header-title` |
| Form input | `16px` | 400 | `input, select, textarea` (must stay ≥16px to stop iOS zoom) |

Weights in use: 600 (×44), 700 (×28), 800 (×8), 500 (×8), 900 (×2), 400 (×1). Standard: **400 body, 600 controls/labels, 700 headings, 800 only for tiny badges.** Do not use 900.

### 2.3 Spacing

Scale (`--space-*`): `0-5:2px 1:4px 1-5:6px 2:8px 2-5:10px 3:12px 3-5:14px 4:16px 5:20px 6:24px 8:32px`. All `padding`/`margin`/`gap` in the app stylesheet now use these tokens (off-scale values were snapped). **New code uses `--space-*`; never invent values off this scale** (no 5px, 7px, 9px, 11px, 13px). Negative margins and `calc()` with safe-area insets are the only raw-px exceptions.

Layout rhythm in use: `.page` gap `12px`; `.tab-panel` gap `14px`; `.panel` padding `16px`; `.row`/`.actions` gap `8–10px`; poster grid gap `10px 8px` (mobile) / `12px 8px` (desktop).

### 2.4 Radii

| Token | Value | Use |
|---|---|---|
| `--radius-xs` | 4px | Tiny chips, thumbnails |
| `--radius-sm` | 8px | Inputs, menu items |
| `--radius-md` | 12px | Avatars, small cards |
| `--radius` (alias) | 14px | `.panel`, `.list-card`, most cards |
| `--radius-lg` | 16px | (defined, unused) |
| `--radius-xl` | 20px | Modals |
| `--radius-pill` | 999px | **All buttons, tabs, subnav pills, toasts, badges** |
| `50%` | circle | Icon buttons, close buttons, spinner |

### 2.5 Shadows, controls, z-index, motion, breakpoints

```css
--shadow-sm: 0 1px 3px rgba(0,0,0,.06);   /* cards, secondary buttons */
--shadow:    0 2px 10px rgba(0,0,0,.08);  /* card hover */
--shadow-md: 0 4px 20px rgba(0,0,0,.10);  /* popovers, floating */
--shadow-lg: 0 8px 30px rgba(0,0,0,.16);  /* modals */
--shadow-focus: 0 0 0 3px rgba(0,122,255,.35);
--control-height-sm: 32px; --control-height-md: 40px; --control-height-lg: 48px; --control-touch-min: 44px;
```
(Dark mode redefines all shadows, darker.)

**z-index layers** (tokens `--z-*`): local stacking inside a card 1–8 (raw numbers allowed); `--z-sticky` 10 (dropdowns, menus, dragged items); `--z-nav` 900 (mobile bottom nav); `--z-modal` 1000 (modal overlay, **above** the bottom nav); `--z-toast` 99999. Never add other numbers.

**Motion.** Tokens: `--duration-fast` 0.12s (press, nav items), `--duration-base` 0.15s (hover/focus: background, border, colour, shadow), `--duration-slow` 0.25s (toast, toggle, slide); `--ease: ease`. Never `transition: all`; always list properties. Easing `ease`; toasts/toggles use `cubic-bezier(0.16,1,0.3,1)` / `cubic-bezier(0.4,0,0.2,1)`. Press feedback: `transform: scale(0.98)`. `prefers-reduced-motion` is already handled globally (~line 502) — never override it.

```css
/* copy-paste motion shorthands */
transition: background-color var(--duration-base) var(--ease), color var(--duration-base) var(--ease), border-color var(--duration-base) var(--ease), box-shadow var(--duration-base) var(--ease), transform var(--duration-fast) var(--ease);
```

**Breakpoints.** The app has one real split: **mobile `max-width: 640px`** (bottom nav shown, tab bar hidden) vs **desktop `min-width: 641px`**. Use only these two (the old 480/520/600/720 breakpoints were folded into 640). 360px is the one exception, for the 6-item bottom nav.

### 2.6 Adding a token

Edit `DESIGN_TOKENS_CSS` in `00_constants.js` (both `:root` and `:root.dark-theme`), then document it here. Do not define `:root` variables in any page's own `<style>`.

---

## 3. Component specs

General rule: **reuse a class below; never write a new button/card/badge style.** All of these are in `09_page-shell.js`.

### 3.1 Buttons

A bare `<button>` is **primary** by default (global rule `:where(button:not(.secondary, .btn-secondary, …))` ~line 3867). Always set `type="button"` unless submitting a form. Always give icon-only buttons `aria-label`.

| Variant | Classes | Look | Min height / padding |
|---|---|---|---|
| Primary | `<button class="btn-primary">` (or plain `<button>`/`.primary`) | `--color-brand-fill`, white text, hover `-fill-hover`, active `-fill-active` | 40px, `10px 18px` |
| Secondary | `.btn-secondary` (also `.secondary`) | surface fill, 1.5px `--color-border-strong`, hover `--color-bg-sunken` | 40px, `9px 16px` |
| Ghost / tertiary | `.btn-ghost` / `.btn-tertiary` | transparent, hover `--color-brand-subtle` + brand text | 40px, `8px 14px` |
| Danger | `.btn-danger` (also `.danger`, `.btn-destructive`) | `--color-danger-subtle` fill, red text; hover solid red + white | 40px, `9px 16px` |
| Sizes | `.btn-sm` / `.btn-md` / `.btn-lg` | | 32 / 40 / 48px |
| **Compact (cards/rows)** | `.lc-btn` + optional `.primary` / `.secondary` / `.liked` / `.view-btn` | pill, `--space-1-5 --space-3`, `--font-size-xs` | ~30px visually; on phones it gets a 44px hit area (invisible `::after`) |
| Icon (header) | `.header-icon-btn` | 36px circle, surface fill | 36×36 |
| Modal close | `button.modal-close-x` | 32px circle | 32×32 |
| Platform install | `.btn-stremio` / `.btn-nuvio` / `.btn-wako` | brand gradients, white text | — |
| Disabled | `disabled` attribute | `opacity .5`, `cursor:not-allowed`, `pointer-events:none`, no shadow | global rule |
| Loading | none standardized | use `disabled` + changed label (e.g. "Saving…") or `.app-spinner` | — |

```html
<div class="actions">
  <button type="button" class="btn-primary" data-act="save">Save</button>
  <button type="button" class="btn-secondary" data-act="cancel">Cancel</button>
  <button type="button" class="btn-danger" data-act="removeAllLists">Remove all lists</button>
</div>
<!-- compact action inside a list card -->
<button type="button" class="lc-btn secondary" data-act="viewList">View</button>
<!-- icon only -->
<button type="button" class="header-icon-btn" aria-label="Search"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">…</svg></button>
```

Events use `data-act="…"` handlers (not inline `onclick`). Follow that.

### 3.2 Tabs and navigation

- **Desktop top tabs** `.tab-bar` > `.tab-btn` (pill, 1.5px border; `.active` = solid `--color-brand` fill, white text). Hidden at ≤640px.
- **Mobile bottom nav** `.bottom-nav` > `.bottom-nav-item` (+ `.active`): 62px tall, icon 28.5px (25px at ≤360), label 0.78rem/600, active colour `--color-brand`, translucent blurred bar, safe-area padding.
- **Sub-navigation** `.subnav-pills-bar` > `.subnav-pill` (+ `.active`: brand-tinted fill, brand text, 700). Horizontally scrollable, no scrollbar. Selected pill may include `<span class="check-icon">✓</span>`.
- Active state is always set both by JS (`.active`) and, to avoid flash, by `html[data-initial-*]` attribute rules. When adding a tab/sub-tab you must extend those attribute rules too (they are repeated per sub-menu, lines ~795–1030).

```html
<div class="subnav-pills-bar" id="exampleSubnavBar" role="tablist">
  <button type="button" class="subnav-pill active" data-sub="one" aria-pressed="true"><span class="check-icon">&#x2713;</span>One</button>
  <button type="button" class="subnav-pill" data-sub="two">Two</button>
</div>
```

### 3.3 Inputs

Global `input, select, textarea` (~line 3440): full width, `padding 11px 14px`, `min-height 44px`, `1.5px solid --border-strong`, `--radius-sm`, surface fill, **16px** font, `--shadow-sm`. Focus = brand border + 3px `--color-brand-subtle` ring (`:focus-visible` version is authoritative). Disabled/readonly = sunken fill, muted text. Placeholder = muted at 0.65 opacity.

- Checkbox/radio: 20×20, `accent-color: var(--accent)`; inside `.settings-check-item` 17×17.
- Toggle switch: `.ui-toggle` > `input` + `.ui-toggle-slider` (44×24, brand when checked).
- Search: `.search-input-wrapper` > `.search-input-box` > `input` + `.search-input-icon`; clear = `.search-clear-btn`.
- Select filters: `.search-filter-select`, `.detail-sort-select`, `.merge-add-channel-select`.
- File: `input[type=file]` is restyled with `::file-selector-button`.
- Validation: there is **no inline field-error style**. Show result text with `.testresult` + `.ok` / `.err` / `.pending`, or a toast.

```html
<div class="settings-toggle-row">
  <span>Show ratings on posters</span>
  <label class="ui-toggle"><input type="checkbox" id="showRatings"><span class="ui-toggle-slider"></span></label>
</div>
<div class="row">
  <input type="text" id="listName" placeholder="List name" aria-label="List name">
  <button type="button" class="btn-primary" data-act="createList">Create list</button>
</div>
<p class="testresult err" role="alert">Name this list first.</p>
```

### 3.4 Cards, panels, lists

- **Panel** `.panel` (+ `.panel-title`): surface, 1px `--border`, `--radius` 14px, `--shadow-sm`, padding 16px. The default container for a settings/section block.
- **List card** `.list-card` (`.list-card-header`, `-body`, `-title`, `-meta`, `-actions`, `-posters`): same chrome, padding ≈13px, hover → `--shadow`.
- Other card families built on the same chrome: `.provider-card`, `.resource-card`, `.preset-card`, `.discover-chart-card`, `.qa-shelf-card`, `.install-result-card`, `.item-storyline-card`, `.season-card`, `.entry` (+ `.entry-card-top`). Reuse the chrome (`surface / 1px --border / --radius / --shadow-sm`); do not make a new one.
- **Poster tile** `.poster-card` (105px mobile / 125px desktop) and grid `.poster-grid-3` (3 columns mobile → 9 desktop).
- **Rows** `.row` (column flex, gap 10px) and `.field-row`.
- **Tables:** none exist. Use list/cards.
- **Drag handles:** `.shelf-drag-handle`, `.entry .drag-handle`, state `.dragging`.

### 3.5 Badges, chips, tags

| Component | Class | Notes |
|---|---|---|
| Source badge | `.list-source-badge` + `.badge-mdblist/-trakt/-tmdb/-simkl/-mylists/-streaming/-imdb/-autotrack` | 12% tinted fill, coloured text + border. Colours are hard-coded hex; contrast of tinted text is 2.2–3.6:1 (known issue) |
| Rating badge | `.rating-badge` + `.rating-high/-mid/-low` | white on `--color-rating-*`; `0.68rem/800` |
| Date badges | `.cw-date-badge` (+ `-premiere`, `-finale`, `-timed`) | Continue-watching shelf |
| Provider chip | `.provider-chip` + `.provider-chip-icon.<brand>` | brand colours are intentional hard-codes |
| Genre chip | `.item-genre-chip` | |
| Status chip | `.provider-status-badge`, `.app-shell-chip(-ok/-warn)` | |
| Merge chip | `.merge-chip-remove-btn` | |

### 3.6 Modals and dialogs

Always create modals with `showModal(innerHtml, extraClass)` (`16_client-row-core.js` ~2243): it builds `.modal-overlay > .modal-card`, sets `role="dialog"`, `aria-modal`, `aria-labelledby` (first `h2/h3`), traps Tab, closes on Escape/backdrop, restores focus, locks scroll. **Do not hand-build overlays.** For yes/no confirmation use `await appShellDialog({ title, message, confirmLabel, cancelLabel })` (`24_client-backup-restore-presets.js` ~2785); it resolves `true`/`false`.

- `.modal-card`: `--color-bg-elevated`, 1px `--border-strong`, `--radius-xl`, padding 22px, `max-width 440px`, `max-height 90vh`, `--shadow-lg`. Wide variant `.modal-card-wide` (1100px / 95vw).
- Close affordance: `button.modal-close-x` (top-right) and/or a Cancel button.
- Four static modals exist in markup (`createListModal`, `selectListModal`, `addShelfModal`, `traktDeviceModal`); prefer `showModal` for new ones.
- Native `confirm()/alert()/prompt()` are not used for UX; keep it that way.

```js
const ok = await appShellDialog({
  title: 'Remove all lists?',
  message: 'This removes every list from this catalog. You can add them back later.',
  confirmLabel: 'Remove all',
  cancelLabel: 'Cancel',
});
if (!ok) return;
```
Pass `destructive: true` for removals/resets: the confirm button becomes `.btn-danger`. For reversible list/catalog deletions prefer the undo toast (§5) over a dialog.

### 3.7 Toasts, alerts, banners

- **Toast:** `showToast(message, type = 'info', { duration = 3000, actionText, onAction })` (`16_client-row-core.js`). Types: `'info' | 'success' | 'error' | 'undo'`. Styled: `.app-toast--success` (green border + ✓), `--error` (red border + !), `--info` (blue "i"), `--undo` (plain, with an Undo button). Background is `--color-bg-elevated`, so it needs no dark override. One toast at a time. `role="alert"` for errors, `status` otherwise.
- **Undo:** `showUndoToast(message)` (8s, "Undo" action) — the safety net for destructive list actions instead of a confirm dialog.
- **Inline result text:** `.testresult.ok | .err | .pending`.
- **Banners/notices:** `.channel-crossover-banner`, `.app-shell-muted` (muted hint paragraph, also the loading-text style), `.live-preview-shelf-status`. There is no generic alert/banner component.
- Removed: `.action-toast`, `.undo-toast` and the `#undoToast` / `#actionToast` markup. Do not recreate them.

### 3.8 Loading, skeleton, empty states

- Spinner: `.app-spinner` (20px ring, brand top). Reduced-motion stops it, so always pair with words.
- Skeleton: `.live-preview-skeleton-card` / `-poster` / `-line` with `livePreviewShimmer` keyframes (poster shelves only).
- Loading text: `<p class="app-shell-muted">Loading popular public lists…</p>`.
- Empty: `.poster-preview-empty-msg` / `.list-card-posters.poster-preview-empty`; elsewhere ad-hoc muted `<p>`. Standard for new empty states: muted sentence stating what's missing + the action to fix it, e.g. "No lists yet. Use Import to add one."
- Error: `.testresult.err` text or `showToast(msg, 'error')`.

### 3.9 Menus, accordions, popovers

- Overflow menu: `<details class="preset-overflow-menu">` + `.preset-overflow-btn` + `.preset-overflow-dropdown` + `.preset-menu-item` / `.preset-menu-divider`.
- Accordion: `<details class="channel-accordion"><summary>…` + `.channel-accordion-body` (chevron via `::after`).
- No tooltip component. Use `title=""` plus `aria-label`.

### 3.10 Icons

Inline SVG only: `viewBox="0 0 24 24"`, `fill="none"`, `stroke="currentColor"`, `stroke-width="2"` (bottom-nav active 2.2), round caps/joins, `aria-hidden="true"` when decorative. Sizes in use: 20px (buttons), 25–28.5px (bottom nav). Colour via `currentColor`. Text glyphs `✓ ✕` (`&#x2713; &#x2715;`) are used for check/close; keep that for those two only. Brand-provider icons use hard-coded brand colours (intentional).

---

## 4. Layout rules

- **Page container:** `.page { max-width: 1200px; margin: 0 auto; display: grid; gap: 12px; }`. Never set another max-width on a top-level block.
- **Body padding:** `calc(16px + safe-area-top) max(12px, safe-area-right) calc(80px + safe-area-bottom) max(12px, safe-area-left)`; ≤640px bottom pad 96px so content clears the bottom nav. Never remove the bottom padding.
- **Tabs:** every top-level tab is a `.tab-panel` (grid, gap 14px, `min-width:0`); one visible at a time. Flex/grid children inside `.tab-panel` need `min-width: 0` (see comments at `.poster-grid-3`).
- **Sections:** stack `.panel`s; inside a panel use `.row` (column) / `.actions` (column, gap 8px). Side-by-side action rows use `.catalog-actions-bar` (flex row, space-between, gap 12px).
- **Posters:** 3-up grid mobile, 9-up desktop (≥641px).
- **Mobile vs desktop:** ≤640px — top tab bar hidden, bottom nav shown, compact padding. ≥641px — tab bar, wider grids, hover-only affordances (`@media (hover:hover)`).
- **Safe areas:** use `env(safe-area-inset-*)` for anything fixed to a screen edge.
- **Scrollbar:** `html { scrollbar-gutter: stable }` prevents layout shift; do not change.
- **Overflow:** prefer `min-width:0` + `text-overflow: ellipsis` to fix overflow; `html/body/.page` already clip `overflow-x`.

---

## 5. Interaction rules

- **Hover:** background/border shift only (surface → `--color-bg-sunken`, or border → `--color-brand` with brand text). Wrap hover-only reveals in `@media (hover:hover) and (pointer:fine)`.
- **Active/pressed:** `transform: scale(0.98)` (nav items: `opacity .6`).
- **Focus:** a global `:focus-visible` ring exists (`outline: 2px solid var(--accent)`, offset 2px; inputs get border + 3px glow). **Never write `outline: none` on a focusable element without keeping that ring.** Never remove the global rule.
- **Disabled:** use the `disabled` attribute (not just a class). Visual is global.
- **Loading:** disable the trigger, change its label to progressive text ("Saving…", "Loading…"), show `.app-spinner` for >1s operations, and announce completion with a toast.
- **Which feedback to use**
  - *Toast* — result of a completed action (success/failure), not tied to one field. 3s default, 8s with Undo, 12s for urgent notices.
  - *Undo toast* — reversible destructive action on list/catalog data (delete list, remove item). Preferred over a confirm dialog.
  - *Modal dialog (`appShellDialog`)* — irreversible or account-level actions (reset account data, delete account, restore from backup) and anything needing a choice.
  - *Inline `.testresult`* — connection tests, validation of the field/section next to it.
- **Destructive actions:** use `.btn-danger` styling, plain verb + object label, and either undo toast or `appShellDialog` with a named consequence. No native `confirm()`.
- **Animation:** only for state change (≤0.25s); no decorative animation. Respect `prefers-reduced-motion`.
- **Drag & drop:** `.dragging` class on the dragged element; handles are `.shelf-drag-handle` / `.drag-handle`.

---

## 6. Content rules

Observed conventions (enforce for new copy):
- **Sentence case** for buttons, labels, headings and toasts: "Create list", "Remove all lists". Proper nouns keep caps (Trakt, MDBList, Stremio, Nuvio, Wako, TMDB, Simkl). Tab names are single Title-case words: Discover, Catalogs, Lists, Channels, Search, Settings.
- **Buttons:** verb first, 1–3 words: "Save", "Add", "Copy link", "Undo". Confirm buttons repeat the action ("Remove all"), never "OK"/"Yes" (the `appShellDialog` default `OK` is legacy).
- **Success toasts:** past tense, include the name in straight double quotes: `"Name" added to your home screen.` `Connected to Trakt.` End with a period.
- **Error toasts:** plain, no blame, name what failed and the next step: `Could not delete: <reason>.` `Network error adding "Title".` `Name this list first.` `Could not find that list -- try refreshing.` Prefer "Could not" over "Failed to"/"Unable to". Server errors map through the shared helper near `24_…:2775` ("Something went wrong on our side. Please try again.").
- **Loading text:** `Loading …` with an ellipsis character `…` (the legacy `...` exists once).
- **Empty state:** say what's missing and the action.
- **Numbers / dates:** plain integers, no thousands formatting enforced; dates via the existing date-badge formatters — reuse them, don't hand-format.
- **No emoji** in UI copy; icons are SVG (check/close glyphs excepted).

---

## 7. DO / DON'T

1. **DO** use `var(--color-…)` tokens. **DON'T** hard-code hex (there are 63 distinct hex literals already; don't add more). White-on-fill text uses `var(--color-text-inverse)`.
2. **DO** reuse `.btn-primary / .btn-secondary / .btn-ghost / .btn-danger` (+ `.btn-sm/-lg`). **DON'T** create a new button class or restyle one inline.
3. **DO** use `.lc-btn` only for compact buttons inside cards/rows. **DON'T** use `.lc-btn` for page-level actions.
4. **DO** use `.panel` for sections and `.list-card` for list rows. **DON'T** invent a card with a new border/radius/shadow combination.
5. **DO** use `--radius-pill` for buttons/tabs/pills and `--radius-sm` for inputs. **DON'T** use 5px, 6px, 7px, 9px, 10px radii.
6. **DO** use `--space-*` and the 4/8/12/16 rhythm. **DON'T** use odd values like 5px/7px/9px/11px/13px.
7. **DO** use the type tokens (`--font-size-xs/sm/base/md/lg/xl`). **DON'T** add new `rem` values (there are already 42 distinct font sizes).
8. **DO** keep inputs at `font-size: 16px` and `min-height: 44px`. **DON'T** shrink them (iOS zoom, touch target).
9. **DO** keep interactive targets ≥ 44px on mobile where layout allows (`--control-touch-min`). **DON'T** add new controls below 32px.
10. **DO** put every dark-mode difference in `:root.dark-theme` token overrides. **DON'T** add `.dark-theme .foo` rules for colour — make the colour a token so one definition serves both. If unavoidable, use `:root.dark-theme` (not `html.dark-theme` / `body.dark-theme`).
11. **DO** show toasts via `showToast(msg, type)`; undo via `showUndoToast`. **DON'T** use `alert()`, `confirm()`, `prompt()`, or build your own toast element.
12. **DO** build modals with `showModal()` and confirmations with `appShellDialog()`. **DON'T** create a `.modal-overlay` by hand.
13. **DO** use `data-act="…"` + the existing delegated handler for clicks. **DON'T** add inline `onclick` or `<script>` handlers in markup.
14. **DO** use `<button type="button">` and add `aria-label` to every icon-only control. **DON'T** use `<div onclick>` for controls.
15. **DO** keep `:focus-visible` rings. **DON'T** write `outline: none` without a replacement.
16. **DO** put new CSS in the shared stylesheet in `09_page-shell.js`, near the component it extends. **DON'T** add `style="…"` attributes for anything that repeats (1,825 inline styles exist; that's debt, not a pattern).
17. **DO** avoid `!important`. **DON'T** add more (336 exist, mostly fighting specificity). Fix specificity instead; the only accepted uses are the focus ring and `[hidden]`/initial-tab FOUC rules.
18. **DO** write both a mobile (≤640px) and desktop (≥641px) check for any new layout. **DON'T** introduce new breakpoints.
19. **DO** write sentence-case copy, verb-first buttons, "Could not …" errors. **DON'T** use "OK"/"Yes"/"Submit", "Failed to", emoji, or ALL CAPS.
20. **DO** include empty, loading, error and disabled states for any new list/section. **DON'T** ship a happy path only.
21. **DO** check light **and** dark mode and text contrast ≥ 4.5:1 (3:1 for ≥18px/bold-large). **DON'T** put white text on `#34C759` or `#FF9500` fills.
22. **DO** escape all user data with `escapeHtml`/`escapeAttr` when building HTML strings. **DON'T** interpolate raw strings or write `</script>` unescaped.
23. **DO** use `z-index` from the layers table. **DON'T** add new magic numbers.
24. **DO** use `transition` with the 0.12 / 0.15 / 0.25s set and list the specific properties. **DON'T** use `transition: all` or a malformed shorthand.

---

## 8. New feature checklist (do in order, before writing UI)

1. **Search first.** `grep` this file's class names and `09_page-shell.js` for an existing component that fits (button, `.panel`, `.list-card`, `.subnav-pill`, `.testresult`, `showModal`, `showToast`). Reuse it exactly.
2. **Tokens only.** Every colour, radius, shadow, space and font size comes from §2. If a token is missing, add it to both `:root` and `:root.dark-theme` and to this file.
3. **Pick the right container** (§4): `.panel` inside a `.tab-panel`; poster grids use the existing grid classes.
4. **Pick the right feedback** (§5): toast vs undo vs `appShellDialog` vs `.testresult`.
5. **Build every state:** default, hover, focus-visible, active, disabled, loading, empty, error. For lists also a skeleton or "Loading…" line.
6. **Accessibility:** native elements, `type="button"`, `aria-label` on icon buttons, `aria-pressed`/`aria-current`/`aria-selected` on toggles/tabs, dialog via `showModal`, error text with `role="alert"`, decorative SVG `aria-hidden="true"`.
7. **Copy:** sentence case, verb-first buttons, "Could not …" errors, quoted names in success toasts (§6).
8. **Responsive:** test ≤640px (incl. 320–360px width) and ≥641px; check nothing overflows horizontally and content clears the bottom nav and toast area.
9. **Dark mode:** toggle the theme and verify contrast; no hard-coded colours.
10. **Escape and CSP:** `escapeHtml/escapeAttr`; nonce on any new `<style>`/`<script>`; no unescaped `</script>`; no external fonts, CSS or icon libraries.
11. **Preserve the build rules:** edit numbered files only; run `python build.py`, `python check_sync.py`, `node --check worker_entry_combined.js`, `python gen_map.py` (if functions changed), `node --test tests/*.test.mjs`.
12. **Update this file** if you added a variant or token.

---

## 9. Known deviations (do NOT copy these)

Fixed in the consistency pass (2026-10-06): shared tokens for the admin and backup pages; darker brand fills and status-text tokens (contrast); toast type styling; dead `.action-toast`/`.undo-toast` removed; duplicate `.modal-close-x` merged; invalid `.list-card` transition and undefined variables fixed; `html.dark-theme`/`body.dark-theme` selectors removed; font sizes, radii and spacing snapped to tokens; z-index layers (modals now above the bottom nav); `transition: all` removed; breakpoints folded into 640/641; `!important` removed from `.lc-btn` and the Search button; 44px touch hit areas on phones; the backup page follows the system theme like the app.

Still open. Do not copy these; fix them opportunistically:

| # | Deviation | Where | Do instead |
|---|---|---|---|
| 1 | About 1,800 inline `style="…"` attributes (admin ≈385, settings HTML ≈275, creator profile ≈180, …) | `03_`, `1x_`, `2x_` files | CSS classes in `09_page-shell.js` |
| 2 | About 300 `!important` remain (add/remove buttons, shelf/poster overrides, initial-tab FOUC rules) | `09_page-shell.js` | Fix specificity |
| 3 | A few hard-coded colours remain: provider brand colours (intentional), `.btn-stremio/-nuvio/-wako` gradients, date-badge hexes (`#2fa84f`, `#ffd166`), `.support-strip` colours, overlay `rgba(0,0,0,…)` | `09_page-shell.js` | tokens |
| 4 | Add/remove list buttons share a 9–10 class `:is()` list with `!important` | `09_page-shell.js` (search "Soft Brand-Tinted") | `.btn-ghost` / `.btn-danger` |
| 5 | Controls under 44px keep their look and rely on the invisible hit-area extension (≤640px) | `.lc-btn`, `.subnav-pill`, header icon buttons | — |
| 6 | Unused tokens: `--color-border-focus`, `--shadow-focus`, `--control-touch-min`, `--font-display`, some `--space-*` | tokens | start using them |
| 7 | No tooltip, generic alert/banner, empty-state or button-loading component | — | build once, add here |
| 8 | The light primary blue is `#0066D6`, deliberately darker than Apple's `#007AFF`; any leftover `#007AFF` is legacy | — | tokens |
