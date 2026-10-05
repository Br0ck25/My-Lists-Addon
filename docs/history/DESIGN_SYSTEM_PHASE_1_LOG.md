# Design system phase 1: work log (2026-10-03 to 2026-10-04)

*Written before Release 21. Its mentions of `FF_NEW_UI`, `newUi`, and the classic/legacy page or fallbacks for it are out of date: that page no longer exists.*

> **HANDOFF, 2026-10-04 (Antigravity): Quick Add Category Architecture & Dynamic 'Added' State Indicators.**
>
> **Where things stand**
> - Quick Add Categorization (`13_tab-channels.js`):
>   1. **Problem Solved**:
>      - Quick Add was previously a flat, undifferentiated alphabetical cloud of 28 plain text buttons, causing cognitive overload on desktop and a 14-row vertical button crawl on mobile.
>   2. **Implementation**:
>      - Preserved the clean, poster-free button format while organizing all 28 networks into 5 intuitive, curated sections:
>        - **Major Broadcast**: ABC · CBS · FOX · NBC · The CW · BBC One
>        - **Cable & Premium Drama**: AMC · Comedy Central · FX · HBO · Syfy · TBS · TNT · USA Network
>        - **Animation & Kids**: Adult Swim · Cartoon Network · Disney Channel · Nickelodeon
>        - **Documentary & Lifestyle**: Discovery · Food Network · HGTV · History · TLC
>        - **Classics & Variety**: A&E · Hallmark Channel · Ion Television · MeTV · MTV
>      - Every button retains exact `data-name` and `data-networkid` attributes, preserving 100% compatibility with `appShellChannelNetworks()` and test runners.
> - Quick Add Dynamic "Added" State Feedback (`09_page-shell.js`, `20_client-channel-builder.js`):
>   1. **Problem Solved**:
>      - Clicking a network button installed it, but the button quickly reverted to its un-added state, leaving users with zero memory of which networks were already installed.
>   2. **Implementation**:
>      - Added `updateQuickAddButtonsState()` in `20_client-channel-builder.js`: scans local saved channels and active catalog rows to find matching network IDs or channel names.
>      - Installed networks dynamically show active state: `.is-added` with `<span class="check-icon">&#x2713;</span>`, brand blue outline, and subtle glow tint (`[ ✓ HBO ]`).
>      - Tied to `switchChannelsSubmenu('quickadd')`, `renderMyCreatedChannelsList()`, and `quickAddChannel` completion.
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK (5,493,453 bytes).
>   - `node --check worker_entry_combined.js`: OK (0 syntax errors).
>   - `python gen_map.py`: 2,675 symbols, 211 routes.
>   - Test suites: 472/472 tests pass (0 failures).
> - Branch: `feat/design-system-phase-1`
>

> **HANDOFF, 2026-10-04 (Antigravity): Primary Creation Verb Alignment (+ Create Channel) & Mobile Card Header Viewport Ergonomics.**
>
> **Where things stand**
> - Primary Action Verb Alignment (`13_tab-channels.js`, `20_client-channel-builder.js`, `24_client-backup-restore-presets.js`):
>   1. **Problem Solved**:
>      - Custom Lists used `+ Create List`, while Channels used `+ New Channel`. This caused cognitive friction across adjacent builder features.
>   2. **Implementation**:
>      - Aligned `+ New Channel` &rarr; `+ Create Channel` across the Channels toolbar, empty state prompts, and help guide modals.
>      - Conforms strictly to Design System verb rules: `+ Add` is reserved for installing existing items into catalog rows; `+ Create` is reserved for building new assets from scratch (`+ Create List`, `+ Create Channel`, `Create Merged Catalog`).
> - Mobile Card Header & Shelf Layout Fix (`09_page-shell.js`, `13_tab-channels.js`):
>   1. **Problem Solved**:
>      - On mobile viewports (<640px), `.list-card-header { flex-wrap: nowrap; }` left only ~60px for `.list-card-body` when 4 action buttons were present. Titles truncated prematurely to 4 characters (`Star...`, `Mar...`) and metadata descriptions crushed into a 15-line vertical stack of single words.
>      - In `.shelf-header`, 4 fixed action buttons overflowed past the right viewport boundary, clipping the `[Refresh]` button.
>   2. **Implementation**:
>      - Updated `@media (max-width: 640px)` in `09_page-shell.js`:
>        - `.shelf-header`: stacked vertically (`flex-direction: column !important; align-items: stretch !important; gap: 8px !important;`) allowing subtitle full width and buttons to wrap neatly within the screen.
>        - `.list-card-header`: switched to `flex-direction: column; align-items: stretch; gap: 8px;`.
>        - `.list-card-body`: expanded to `width: 100%; min-width: 0;`, giving titles and metadata full horizontal width.
>        - `.list-card-actions`: set to `width: 100%; justify-content: flex-end; gap: 6px; flex-wrap: wrap;`, placing action buttons on their own line with generous touch targets.
>      - Removed `flex-shrink: 0;` on the Channels shelf toolbar button container in `13_tab-channels.js` to ensure clean wrapping on small screens.
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK (5,488,595 bytes).
>   - `node --check worker_entry_combined.js`: OK (0 syntax errors).
>   - `python gen_map.py`: 2,674 symbols, 211 routes.
>   - Test suites: 458/458 tests pass (0 failures).
> - Branch: `feat/design-system-phase-1`
>

> **HANDOFF, 2026-10-04 (Antigravity): Subnav Title Deduplication, Catalogs Refresh Alignment, and Channels Import Modal Architecture.**
>
> **Where things stand**
> - Subnav Header Deduplication (`10_tab-search-add.js`, `12_tab-custom-lists.js`, `13_tab-channels.js`):
>   1. **Problem Solved**:
>      - Having large `<h2>` page titles repeating the exact name of the active subnav pill (`Storylines, Sagas & Universes`, `My Channels`, `Live Preview & Editor`, `Your Custom Lists`, `Quick Add Popular Networks`, `Explore Channels`) caused visual stutter ("Double-Title Stutter") and wasted 50-80px of vertical viewport real estate.
>   2. **Implementation**:
>      - Followed the pattern established under Discover (commit `3a67bcb`): changed redundant headings to `<h2 class="shelf-title sr-only">`, preserving semantic document outline and WCAG accessibility while visually removing duplicate title banners.
>      - Converted shelf headers into compact flex rows with helpful explanatory subtitles on the left and toolbar actions on the right.
> - Catalogs "Refresh Preview" &rarr; "Refresh" Alignment (`10_tab-search-add.js`):
>   1. Standardized `Refresh Preview` button to `Refresh` (`title="Refresh catalogs preview"`), harmonizing with Custom Lists, Discover, and Channels.
> - Channels Import Modal & Refresh Architecture (`09_page-shell.js`, `13_tab-channels.js`, `16_client-row-core.js`, `20_client-channel-builder.js`):
>   1. **Moved Import to Modal**:
>      - Hid the `Import` subnav pill in `#channelsSubnavBar` (`style="display:none;"`), perfectly matching Custom Lists (`12_tab-custom-lists.js`).
>      - Added `[Import]` modal trigger button (`data-act="openImportChannelModal"`) beside `+ New Channel` in `#channelsSubMyChannels`.
>      - Added `[Refresh]` button (`data-act="refreshMyChannelsAction"`) beside `[Import]` with instant feedback confirmation (`Refreshed ✓`).
>   2. **#importChannelModal**:
>      - Added `#importChannelModal` dialog overlay in `09_page-shell.js` with segmented pills for "From List Link" and "From Share Code".
>      - Registered `#importChannelModal` in `STATIC_MODALS` (`16_client-row-core.js`) for full keyboard ESC, backdrop click, and focus trapping support.
>      - Updated `importChannelFromLink` and `importSharedChannel` in `20_client-channel-builder.js` to read from modal inputs while maintaining 100% backward compatibility with legacy page inputs and test harnesses.
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK (5,488,452 bytes).
>   - `node --check worker_entry_combined.js`: OK (0 syntax errors).
>   - `python gen_map.py`: 2,674 symbols, 211 routes.
>   - Test suites: 490/490 tests pass in targeted client suite, 100% pass across repository.
> - Branch: `feat/design-system-phase-1`
>

> **HANDOFF, 2026-10-04 (Antigravity): Globally Anchoring +Add Button to Far Right with Action Zone Separation.**
>
> **Where things stand**
> - Globally Anchored `+ Add` / `Remove` Action (`09_page-shell.js`, `17_client-my-lists-and-trakt-oauth.js`, `19_client-search-and-likes.js`, `20_client-channel-builder.js`, `22_client-creator-profile.js`):
>   1. **Problem Solved**:
>      - Because cards have variable counts of management buttons (Auto-tracked lists: only `+ Add`; Watchlist: `Edit` + `+ Add`; Custom lists & Channels: `Edit` + `Share` + `Delete` + `+ Add`), placing `+ Add` first caused it to jump horizontally across three different columns depending on row type.
>   2. **Implementation**:
>      - Globally moved `+ Add` / `Remove` to the **far right (last child)** of `.list-card-actions` across the entire application:
>        - **Custom Lists** (Server & Local): `[Edit]` &middot; `[Sync]` &middot; `[Share]` &middot; `[Delete]` &middot; `[+ Add]`
>        - **My Channels**: `[Edit]` &middot; `[Share]` &middot; `[Delete]` &middot; `[+ Add]`
>        - **Merged Channels**: `[Delete]` &middot; `[+ Add]`
>        - **Storylines**: `[Customize]` &middot; `[+ Add]`
>        - **Search & Discover Lists**: `[♥ Like]` &middot; `[Customize]` &middot; `[+ Add]`
>        - **Personal Provider Lists** (MDBList, Trakt, TMDB): `[Copy]` &middot; `[Delete]` &middot; `[+ Add]`
>      - Added global CSS zone separation rule in `09_page-shell.js`:
>        `.list-card-actions :is(.localListAddToConfigBtn, .creatorListAddToConfigBtn, .channelAddBtn, .curatedAddBtn, .searchAddBtn, .list-search-add-btn, .myListAddBtn):not(:first-child) { margin-left: 6px; }`
>      - Establishes two clear cognitive zones: **List Management** on the left, **Catalog Installation** on the far right.
>   3. **Result**:
>      - 100% vertical column alignment of `+ Add` / `Remove` across all cards site-wide.
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK (5,477,817 bytes).
>   - `node --check worker_entry_combined.js`: OK (0 syntax errors).
>   - `python gen_map.py`: 2,670 symbols, 211 routes.
>   - Targeted test suite (`tests/client.test.mjs`, `tests/imdb-ids.test.mjs`, `tests/better-posters.test.mjs`): 458/458 tests pass (0 failures).
> - Branch: `feat/design-system-phase-1`
>

> **HANDOFF, 2026-10-04 (Antigravity): Safe Card Action Button Re-Ordering & Channels Ergonomics Polish.**
>
> **Where things stand**
> - Safe Card Action Button Re-ordering (`20_client-channel-builder.js`, `22_client-creator-profile.js`):
>   1. **Eliminated Dangerous Sandwiched Delete Buttons**:
>      - Previously, `Delete` was dangerously sandwiched between `Edit` and `Share` (in Channels: `[Edit]` `[Delete]` `[Share]` `[+ Add]`), or between `Sync` and `Share` (in Custom Lists: `[Edit]` `[Sync]` `[Delete]` `[Share]` `[+ Add]`).
>      - Re-ordered to the unified, safe design standard:
>        `[+ Add]` &middot; `[Edit]` &middot; `[Sync]` &middot; `[Share]` &middot; `[Delete]`
>      - Applied across **My Channels** (`renderMyCreatedChannelsList`), **Merged Channels** (`renderChannelMergeList`), **Server Custom Lists** (`buildServerListCardHtml`), and **Local Custom Lists** (`buildLocalListCardHtml`).
>      - Pushes the destructive `Delete` action safely to the far right edge of the card, preventing mis-clicks.
> - Movie Poster "S1E1" Glitch Suppressed (`20_client-channel-builder.js`):
>   1. Channels and storylines assign dummy `it.season = 1; it.episode = 1;` so streams sequence properly in player feeds.
>   2. Previously, this caused movies (like Iron Man) on the channel card to display as `Iron Man S1E1` with subtitle `Movie`.
>   3. Added `isMovie = (it.kind === 'movie' || it.type === 'movie')` checks: `seasonEp` is only attached for true TV episodes, while movies cleanly display `Title` on line 1 and `[Year • ]Movie` on line 2.
> - Channels Search Toolbar Polish (`13_tab-channels.js`):
>   1. Upgraded `#myChannelsSearchInput` into a `.search-input-box` container with the standard embedded SVG magnifying glass icon (`padding-left: 38px`).
>   2. Aligned `border-radius: var(--radius-pill)` between the search box and the adjacent `#myChannelsSortSelect`.
> - Merge Channels Section Ergonomics (`13_tab-channels.js`, `20_client-channel-builder.js`):
>   1. Removed redundant debug `[Refresh list]` button.
>   2. Constrained `#channelMergeNameInput` to `max-width: 380px` with pill border-radius.
>   3. When `< 2` channels exist, `#channelMergeSelectAllWrap` and `#channelMergeControls` are automatically hidden, showing friendly contextual guidance prompting the user to build or quick-add channels first.
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK (5,477,501 bytes).
>   - `node --check worker_entry_combined.js`: OK (0 syntax errors).
>   - `python gen_map.py`: 2,670 symbols, 211 routes.
>   - Targeted test suite (`tests/client.test.mjs`, `tests/imdb-ids.test.mjs`, `tests/better-posters.test.mjs`): 458/458 tests pass (0 failures).
>   - Full test suite (`tests/*.test.mjs`): 2,072/2,072 tests pass (0 failures).
> - Branch: `feat/design-system-phase-1`
>

> **HANDOFF, 2026-10-04 (Antigravity): Custom List Design System Consistency — Soft Brand-Tinted + Add Buttons and Subnav-Pill Content Type Toggles.**
>
> **Where things stand**
> - Design System Alignment (`09_page-shell.js`, `12_tab-custom-lists.js`, `21_client-custom-list-builder.js`):
>   1. **`+ Add` Buttons on Search Candidate Cards**:
>      - Replaced solid blue primary fill (`.lc-btn.primary`) with the global design system standard: **Soft Brand-Tinted Action Buttons**.
>      - Added `.customListAddBtn` to the shared `:is(...)` selector in `09_page-shell.js` alongside `.myListAddBtn`, `.channelAddBtn`, `.curatedAddBtn`, etc.
>      - Styled with soft brand wash (`rgba(0, 122, 255, 0.08)` light / `rgba(10, 132, 255, 0.14)` dark), subtle border (`rgba(0, 122, 255, 0.35)`), and accent text (`var(--accent)`).
>      - Eliminated primary CTA competition with the form's "Create List" / "Save Changes" action.
>      - When added, cleanly transitions to neutral disabled secondary `Added ✓` state (`.lc-btn.secondary:disabled`).
>   2. **Content Type Toggles (`Movies` / `Shows` / `Mixed`)**:
>      - Replaced solid opaque blue pill fill (`background: var(--accent); color: #fff`) with the site-wide `.subnav-pill` active pattern.
>      - Styled `.custom-list-type-pill.active` and `:has(input:checked)` with soft blue wash (`rgba(0, 122, 255, 0.12)` light / `rgba(10, 132, 255, 0.22)` dark), accent border (`rgba(0, 122, 255, 0.40)`), accent text, and zero box-shadow.
>      - Added `<span class="check-icon">&#x2713;</span>` checkmark support to each pill, displaying automatically when checked/active and matching `#catalogSearchTypeChips` on the Search page.
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK (5,475,937 bytes).
>   - `node --check worker_entry_combined.js`: OK (0 syntax errors).
>   - `python gen_map.py`: 2,670 symbols, 211 routes.
>   - All 458 targeted tests passing with 0 failures (`tests/imdb-ids.test.mjs`, `tests/client.test.mjs`, `tests/better-posters.test.mjs`).
> - Branch: `feat/design-system-phase-1`
>

> **HANDOFF, 2026-10-04 (Antigravity): Custom List Search Results Better Posters Resolution.**
>
> **Where things stand**
> - Better Posters Resolution in Custom List Search (`21_client-custom-list-builder.js`, `tests/imdb-ids.test.mjs`):
>   1. **Problem Solved**:
>      - Custom list title search queries `/api/title-search`, which returns TMDB IDs rather than IMDb IDs.
>      - When Better Posters was enabled in settings, search results in `#customListSearchResult` previously fell back to raw TMDB posters, while items added to the draft list below showed the rich Better Posters artwork (ratings, badges, styles).
>   2. **Implementation**:
>      - Updated `renderCustomListSearchResults(results)` in `21_client-custom-list-builder.js`:
>        - Added `data-id="tmdb:${tmdbIdNum}"` and `data-type="${itemKind}"` (`movie` or `series`) to each `.custom-list-search-card`.
>        - Added `data-act="handlePosterImgError"` and `data-act-args="[&quot;@self&quot;]"` to `<img>` tags for graceful fallback if a Better Poster fails.
>        - Added `.live-preview-poster-placeholder` with `data-needs-fallback="1"` on empty poster slots.
>        - Called `resolveMissingPostersInDom(box)` and `applyBetterPostersToTmdbTiles(box)` immediately after inserting search results into the DOM.
>        - `applyBetterPostersToTmdbTiles` batches the TMDB IDs, queries `/api/imdb-ids`, generates the Better Poster URL (`betterPostersWebUrl(imdbId)`), swaps `img.src`, and updates `dataset.poster`.
>        - MutationObserver `warmBetterPostersOnPage` automatically warms the cache with `/api/bp/warm`.
>   3. **Tests & Verification**:
>      - Added test in `tests/imdb-ids.test.mjs` verifying that `renderCustomListSearchResults` outputs `data-id`, `data-type`, and wires `handlePosterImgError`.
>      - Rebuilt and validated: `python build.py` & `python check_sync.py` OK (5,475,017 bytes).
>      - Checked JS syntax: `node --check worker_entry_combined.js` OK (0 syntax errors).
>      - Ran `python gen_map.py` (2,670 symbols, 211 routes).
>      - Ran targeted tests (`tests/imdb-ids.test.mjs`, `tests/client.test.mjs`, `tests/better-posters.test.mjs`): all 457 tests pass with 0 failures.
>      - Full test suite: 2071 tests pass with 0 failures.
> - Branch: `feat/design-system-phase-1`
>

> **HANDOFF, 2026-10-04 (Antigravity): Custom List Editor Modernization & Inline Title Search Polish.**
>
> **Where things stand**
> - Custom List Editor Layout Redesign & Inline Search (`09_page-shell.js`, `12_tab-custom-lists.js`, `16_client-row-core.js`, `21_client-custom-list-builder.js`):
>   1. **Inline Title Search & Quick Add**:
>      - Added a dedicated search section (`#customListSearchInput`, `#customListSearchClearBtn`, `#customListSearchResult`) directly in the editor panel (`#listsSubCreateList`).
>      - Implemented debounced (300ms) live search via `runCustomListTitleSearch()` querying `/api/title-search?q=...&type=movie|tv` (and parallel multi-search when `mixed`).
>      - Upgraded search results to clean media tiles (`.custom-list-search-card`, `.custom-list-search-poster`, `.custom-list-search-title`, `.custom-list-search-meta`).
>      - Aligned search results to the exact same **9-column grid (`.poster-grid-3`)** as the draft picks below, ensuring 100% identical poster dimensions, aspect ratio, and column cadence across the entire page.
>      - Eliminated inner scroll trapping (`max-height: 420px; overflow-y: auto`) so search results flow naturally without nested browser scrollbars.
>      - Enabled 2-line title clamping (`-webkit-line-clamp: 2`) preventing premature title cutoffs.
>      - Whole card clickability: clicking anywhere on a search card or its `+ Add` button resolves TMDB to IMDb, adds directly to `customListDraftItems`, updates button to disabled `Added ✓`, updates draft count, and refreshes the draft list.
>      - Wire-up initialized on page load and dynamically on switching to the `create-list` subpanel via `initCustomListSearch()`.
>   2. **Inverted Form Hierarchy & Design System Elements**:
>      - Placed List Name (`#customListNameInput`) with constrained `max-width: 480px` and Content Type standalone pills (`#customListTypeToggles`) at the top of the editor.
>      - Removed murky gray capsule trough (`background: var(--surface-2)`) from Content Type: options are now crisp standalone white pill buttons (`.custom-list-type-pill`) matching the List Name input and global `.subnav-pill` patterns.
>      - Modernized Public List toggle row with descriptive subtitle explaining community discoverability.
>      - Upgraded "Hide watched" in Advanced Settings to the unified `.ui-toggle` pattern.
>      - Constrained "Play order" select (`#customListPlayOrderSelect`) to `max-width: 320px` with pill border radius.
>      - Action button semantics: button dynamically displays "Create List" when creating a new list, or "Save Changes" when editing an existing list.
>   3. **Cognitive Clutter Elimination & Empty State**:
>      - Dynamic count badge (`#customListDraftCount`) displaying `(N items)`.
>      - Action buttons (`#customListDraftActions` — Shuffle Picks Now, Remove All) automatically hidden when draft items < 2.
>      - Clean, branded empty state with film icon and helpful instructions guiding users to search or add from Discover/Charts/Search.
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK (5,474,184 bytes).
>   - `node --check worker_entry_combined.js`: OK (0 syntax errors).
>   - `python gen_map.py`: 2,670 symbols, 211 routes.
>   - All 521 client and app-shell tests passing with 0 failures (`tests/client.test.mjs`, `tests/app-shell*.test.mjs`).
> - Branch: `feat/design-system-phase-1`
>

> **HANDOFF, 2026-10-04 (Antigravity): Settings Design System Polish — Checkbox 2-Column Cap, Connected Services Cards, Presets & Backup Ergonomics, and Feedback & Support Renaming.**
>
> **Where things stand**
> - Settings Design System Polish (`09_page-shell.js`, `14_tab-presets-backup.js`, `15_tab-settings-html.js`, `24_client-backup-restore-presets.js`):
>   1. **Subnav Pill Consistency (`Feedback & Support`)**:
>      - Renamed `Feedback and Support` pill to `Feedback & Support` in `14_tab-presets-backup.js`, achieving uniform ampersand rhythm with `Account & Security`, `Catalog & Display`, `Tracking & Scrobble`, and `Presets & Backup`.
>      - Updated user guide overview in `24_client-backup-restore-presets.js` to describe all 6 settings subpanels and match the `Feedback & Support` heading.
>   2. **Checkbox Grid Sprawl Fixed (Strict 2-Column Cap)**:
>      - Capped `.settings-check-group.two-col-grid` at strictly `repeat(2, minmax(0, 1fr))` on desktop/tablet, collapsing cleanly to 1 column on mobile (`max-width: 720px`).
>      - Prevents the awkward 4-column blowout on wide displays while eliminating visual competition with single-column sections below.
>   3. **Connected Services Elevated Cards & Button De-escalation**:
>      - Replaced sunken gray boxes (`background: var(--color-bg-sunken)`) on `.provider-card` with clean, elevated surface cards (`background: var(--surface); box-shadow: var(--shadow-sm); border: 1px solid var(--border)`).
>      - Upgraded `.provider-status-badge` to high-contrast border and surface background.
>      - Converted `tmdbConnectBtn`, `traktConnectBtn`, `mdblistConnectBtn`, and `simklConnectBtn` from screaming primary blue buttons to clean, polished secondary buttons (`class="secondary lc-btn"`).
>      - Aligned provider input fields with `background: var(--surface); border: 1.5px solid var(--border-strong)`.
>   4. **Presets & Backup Ergonomics**:
>      - Uncoupled `Upload preset file` from the preset name input flex row, moving it to the shelf header as a clean utility action.
>      - Grouped preset name input and `[Save preset]` with a max-width container and unified input token styling.
>      - Replaced gray boxes in `Backup & Restore` and `Export Lists & History` with clean white surface cards (`background: var(--surface); box-shadow: var(--shadow-sm); border-radius: 12px`).
>   5. **Feedback & Support Form Polish**:
>      - Constrained `#feedbackCategorySelect` dropdown to `max-width: 320px` with pill border radius.
>      - Styled `#feedbackMessageInput` and `#feedbackContactInput` with clean surface tokens and responsive max-widths.
>      - Elevated `.resource-card` items from flat gray rectangles into interactive cards with subtle hover lift (`translateY(-2px)` and `box-shadow: var(--shadow-md)`).
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK (5,457,145 bytes).
>   - `node --check worker_entry_combined.js`: OK (0 syntax errors).
>   - `python gen_map.py`: 2,666 symbols, 211 routes.
>   - All 534 client, app-shell, and badge tests passing.
> - Branch: `feat/design-system-phase-1`
>
> **HANDOFF, 2026-10-04 (Antigravity): Settings Subnav Restructure (Option A) & Design System Polish.**
>
> **Where things stand**
> - Settings Subnav Restructure into 6 Focused Tabs (`00_constants.js`, `09_page-shell.js`, `14_tab-presets-backup.js`, `15_tab-settings-html.js`, `16_client-row-core.js`, `tests/app-shell*.test.mjs`):
>   1. **Focused Subnav Tabs (Option A)**:
>      - `[Account & Security]` (`account`): Creator Key, Creator Profile, Admin link, Danger Zone (delete account).
>      - `[Catalog & Display]` (`display`): Content filter rules (Region, Deduplication, Digital Release, Adult Filter), Better Posters configuration, Poster Badges & Labels, and Hidden Lists.
>      - `[Tracking & Scrobble]` (`scrobble`): Watchlist Preferences, Watch History & Continue Watching, Auto-Track & Media Server Scrobbling (Plex, Emby, Jellyfin, Jellyseerr).
>      - `[Connected Services]` (`external`): MDBList, Trakt, Simkl, TMDB, and Stremio/Nuvio connections and API keys.
>      - `[Presets & Backup]` (`backup`): Preset lists, backup and restore.
>      - `[Feedback and Support]` (`feedback`): Bug report and support links.
>   2. **Pre-Hydration SSR & Client Route Sync**:
>      - Added `display` and `scrobble` to `APP_SHELL_TABS.settings.subs` in `00_constants.js`.
>      - Added pre-hydration SSR selectors and head script route validation in `09_page-shell.js`.
>      - Updated early script DOM sync and dynamic tab switching dictionary in `16_client-row-core.js`.
>      - Preserved instant zero-flicker subpanel rendering and full backward compatibility.
> - Design System & Ergonomic Polish across Settings Screens (`09_page-shell.js`, `15_tab-settings-html.js`, `22_client-creator-profile.js`):
>   1. **Catalog & Content Rules Consolidation (P1)**:
>      - Merged 4 isolated single-row cards into a unified, elegant *"Catalog & Content Rules"* card with subtle hairline dividers (`border-bottom: 1px solid var(--border)`).
>   2. **Constrained Dropdown Widths (P2)**:
>      - Constrained edge-to-edge stretched dropdowns (`Region`, `Rating Source`, `Poster Language`) from 1,000px wide down to a neat `max-width: 320px` with standard pill radii.
>   3. **Responsive 2-Column Checkbox Grids (P3)**:
>      - Replaced tall, single-column checkbox lists (Better Posters, Poster Badges Website & Dashboard, Stremio & Nuvio Artwork Overlays, and Badge Types) with `.settings-check-group.two-col-grid` (`display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 4px 12px;`).
>      - Cut vertical scrolling distance by over 50% while preserving every DOM ID, `data-act`, and `data-act-args`.
>   4. **Flattened Nested Scrobbler Rows (P4)**:
>      - In `22_client-creator-profile.js`, flattened nested sunken grey boxes in Media Server Scrobbling into clean divider rows (`border-top: 1px solid var(--border)`), matching the modern card design system.
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK (5,455,500 bytes).
>   - `node --check worker_entry_combined.js`: OK (0 syntax errors).
>   - `python gen_map.py`: 2,666 symbols, 211 routes.
>   - All 2,071 repository tests passing (`tests/*.test.mjs`: 2,071 passed, 0 failed).
> - Branch: `feat/design-system-phase-1`
>
> **HANDOFF, 2026-10-04 (Antigravity): Search Input Ergonomics — Clear Button (✕) Vector Upgrade & Search Button Removal.**
>
> **Where things stand**
> - Search Input Ergonomics & Cognitive Friction Reduction (`13_tab-channels.js`, `09_page-shell.js`):
>   1. **Removed Redundant [Search] Button**:
>      - Removed `<button id="catalogSearchBtn">` from the search bar markup in `13_tab-channels.js`.
>      - Since search triggers live with 350ms debounce as the user types and triggers immediately on `Enter`, the prominent blue button was causing user confusion ("Did the search already run, or do I need to click the button?").
>      - The search input now cleanly spans full width (`width: 100%`) within its container.
>   2. **Native Vector Search Clear (✕) Button**:
>      - Replaced raw text glyph `&#x2715;` and bordered grey circle with a crisp vector SVG knockout disc (`fill="currentColor"`, Heroicons/iOS standard).
>      - Added `.search-clear-btn` to the `:where(button:not(...))` exclusion selectors in `09_page-shell.js` so default brand button styles (40px min-height, brand blue background on hover) never bleed in.
>      - Refined `.search-clear-btn` CSS: borderless, transparent background, subtle `opacity: 0.55`, scaling subtly to `opacity: 1.0` on hover.
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK (5,452,451 bytes).
>   - `node --check worker_entry_combined.js`: OK (0 syntax errors).
>   - `python gen_map.py`: 2,666 symbols, 211 routes.
>   - Node test suite passed (525/525 client and search tests).
> - Branch: `feat/design-system-phase-1`

> **HANDOFF, 2026-10-03 (Antigravity): Search Page UX/UI Polish, Unified Filter Toolbar, & Global 2-Line Poster Title Clamping.**
>
> **Where things stand**
> - Global 2-Line Poster Title Clamping (`09_page-shell.js`):
>   1. **Resolved Aggressive Title Ellipsis**:
>      - Replaced single-line `white-space: nowrap` on `.live-preview-poster-name` with a standard 2-line clamp (`display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; min-height: 2.5em;`).
>      - Titles like *Spider-Man: Brand New Day*, *The Love Hypothesis*, and *The End of Oak Street* now wrap cleanly onto two lines without premature truncation.
>      - Consistent `min-height: 2.5em` maintains uniform baseline alignment across all poster cards.
>      - Better Poster overlays (format badges, ratings, (+) button) remained untouched as requested.
> - Search Page Hierarchy & Filter Toolbar Unification (`09_page-shell.js`, `13_tab-channels.js`):
>   1. **Header Streamlining**:
>      - Removed redundant subtitle `Search to find movies, shows and lists to add to your lists.` under the Search panel heading.
>   2. **Single-Row Filter Toolbar**:
>      - Merged content type pills (`#catalogSearchTypeChips`: `Movies | Shows | Lists`) and quick filter dropdowns (`#catalogSearchFiltersRow`: `All Genres`, `All Years`, `All Ratings`) into a single responsive `.search-filters-toolbar`.
>      - Replaced edge-to-edge stretched dropdowns (`flex: 1`) with compact `.search-filter-select` pills (`min-width: 105px; max-width: 150px; min-height: 31px; border-radius: var(--radius-pill); border: 1.5px solid var(--border-strong);`).
>      - Saves ~50px of vertical headroom, keeping results visible above the fold.
> - Search Input Ergonomics & Context Labeling (`13_tab-channels.js`, `19_client-search-and-likes.js`):
>   1. **Input Icon & Quick-Clear (✕) Button**:
>      - Embedded subtle SVG magnifying glass inside the left edge of `#catalogSearchInput`.
>      - Added inline `#catalogSearchClearBtn` on the right edge, which appears dynamically when text is typed.
>      - Clicking clear resets the search input, hides the button, and re-renders default trending titles.
>   2. **Dynamic Context-Aware Placeholders**:
>      - Updated `setCatalogSearchFilter` to adaptively update `#catalogSearchInput.placeholder`:
>        - Movies: `Search movies by title...`
>        - Shows: `Search TV shows by title...`
>        - Lists: `Search community & provider lists...`
>   3. **Results Context Labeling**:
>      - In `renderTitlePosterCards`, added clean context labeling:
>        - Default state: `Top Trending Movies Right Now` / `Top Trending TV Shows Right Now`
>        - Search query state: `Showing X of Y results for "query"`
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK (5,451,759 bytes).
>   - `node --check worker_entry_combined.js`: OK (0 syntax errors).
>   - `python gen_map.py`: 2,666 symbols, 211 routes.
>   - Node test suite passed (406/406 client tests, 119/119 app-shell tests).
> - Branch: `feat/design-system-phase-1`

> **HANDOFF, 2026-10-03 (Antigravity): New Catalog Modal Input Token Alignment & Global Modal Form Rules.**
>
> **Where things stand**
> - Modal Input Background & Border Unification (`09_page-shell.js`, `16_client-row-core.js`):
>   1. **Catalog URL Input Alignment**:
>      - In `16_client-row-core.js`, updated `openAddShelfModal` and `addShelfModalAddLink` dynamic link inputs from legacy `background: var(--bg)` and `border: 1px solid var(--border)` to `background: var(--surface)` and `border: 1.5px solid var(--border-strong)` matching `Catalog Name` and all other form inputs across the app.
>   2. **Global Modal Input CSS Protection**:
>      - In `09_page-shell.js`, added `.modal-card input:not([type="checkbox"]):not([type="radio"]), .modal-card select, .modal-card textarea { background: var(--surface); border: 1.5px solid var(--border-strong); color: var(--text); }` to guarantee that all modal inputs always inherit the clean surface background and strong border.
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK (5,448,488 bytes).
>   - `node --check worker_entry_combined.js`: OK (0 syntax errors).
>   - `python gen_map.py`: 2,665 symbols, 211 routes.
>   - Node test suite passed (402/402 client tests passed).
> - Branch: `feat/design-system-phase-1`

> **HANDOFF, 2026-10-03 (Antigravity): 3-Tier Navigation Stacking Resolution, Subnav Pill Differentiation (Pill Fatigue Fix), & Header Compaction.**
>
> **Where things stand**
> - Subnav Pill Differentiation & Pill Fatigue Elimination (`09_page-shell.js`):
>   1. **Visual Hierarchy Tiering**:
>      - Primary navigation (`.tab-btn`): High-contrast solid brand blue (`#007aff` / `var(--brand)`) with white text and elevation.
>      - Secondary subnav pills (`.subnav-pill`): Compact scale (`min-height: 31px; padding: 5px 14px; font-size: 0.82rem; font-weight: 600;`).
>      - Active subnav state (`.subnav-pill.active`): Refined soft brand-tinted pill (`background: rgba(0, 122, 255, 0.12); color: var(--accent); border-color: rgba(0, 122, 255, 0.40); box-shadow: none; font-weight: 700;` / dark theme: `background: rgba(10, 132, 255, 0.22); border-color: rgba(10, 132, 255, 0.50);`).
>      - Updated all pre-hydration active CSS selectors (`html[data-initial-...-sub]`) across Catalogs, Lists, Channels, Settings, and Discover to match the soft brand tint.
>      - Eliminates visual competition between primary and secondary navigation tiers.
> - Discover Section Header Compaction & Redundancy Removal (`09_page-shell.js`, `11_tab-quick-add.js`):
>   1. **Accessible Redundant Header Hiding**:
>      - Applied `.sr-only` to `h2.shelf-title` (`#discoverListsFeedTitle`, `#discoverSubPopular .shelf-title`, `#discoverSubCurated .shelf-title`).
>      - Removes the redundant ~70px header that repeated the clicked pill label ("All", "Movies", "Shows", etc.) while preserving screen reader semantics and test DOM invariants.
>   2. **Sleek Single-Line Filter Description & Action Bar**:
>      - Styled `#discoverListsFeedHeader`, `#discoverSubPopular .shelf-header`, and `#discoverSubCurated .shelf-header` as a compact single-line flex toolbar (`min-height: 32px; gap: 12px; align-items: center; justify-content: space-between;`).
>      - Integrated the lonely `[Refresh]` button into the right side of the toolbar as a dedicated `.discover-refresh-btn` with SVG refresh icon.
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK (5,448,243 bytes).
>   - `node --check worker_entry_combined.js`: OK (0 syntax errors).
>   - `python gen_map.py`: 2,665 symbols, 211 routes.
>   - Node test suite: passed.
> - Branch: `feat/design-system-phase-1`

> **HANDOFF, 2026-10-03 (Antigravity): Discover Subnav Header Hierarchy, Movie/Show Title Disambiguation, & Attribution Badge Alignment.**
>
> **Where things stand**
> - Discover Feed Subnav Hierarchy & Headers (`11_tab-quick-add.js`):
>   1. **Header + Description Grouping**:
>      - Compacted section headers across all subnav tabs (`All`, `Movies`, `Shows`, `Popular Lists`, `Curated`, `Hidden Gems`, `Kids`, `Holidays`, `Genres`).
>      - Nested `h2.shelf-title` and `<p>` description into a unified left flex-column group with the `[Refresh]` button aligned cleanly on the right inside `.shelf-header`.
>      - Preserves DOM hierarchy (`#discoverListsFeedHeader`, `#discoverListsFeedTitle`, `#discoverListsFeedDesc`) for test invariants while eliminating 3-tier navigation visual fragmentation.
> - Movie/Show Title Disambiguation & Catalog Stripping (`16_client-row-core.js`, `19_client-search-and-likes.js`):
>   1. **Disambiguation in All Feed Only**:
>      - In `16_client-row-core.js`, for paired movie and show charts (*New on Streaming*, *New Releases*, and genre/holiday pairs), `: Movies` and `: Shows` suffixes are appended only when viewing the `All` subnav feed.
>      - When viewing dedicated `Movies` or `Shows` subnavs, titles remain clean without suffixes (e.g. `New on Streaming`).
>   2. **Catalog Clean Name Preservation**:
>      - In `19_client-search-and-likes.js`, when a list is added to catalogs (`+ Add`), customized (`Customize`), or opened in details (`View`), the disambiguation suffix (`:\s*(Movies|Shows)$`) is stripped so user catalogs and list drafts receive clean names without suffixes.
> - Contradictory Attribution & Source Badge Alignment (`19_client-search-and-likes.js`):
>   1. **Author-to-Badge Consistency**:
>      - Updated source badge assignment in `render5PosterListsFeed` to match the list's author attribution (`by [author]`).
>      - Lists authored by or credited to `My Lists Addon` (such as *New on Streaming* and *Most Watched Today* which use `tmdb:` under the hood) now receive the purple `[My Lists Addon]` badge (`badge-mylists`) rather than `[TMDB]`.
>   2. **Social Proof 0-Likes Cleanup**:
>      - Suppressed `· ♥ 0` like counts across search cards, curated lists, and 5-poster Discover feeds when `likes` is 0.
>      - Like counts only display when `likes > 0`. Liking/unliking dynamically shows/hides the like counter element.
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK (5,446,039 bytes).
>   - `node --check worker_entry_combined.js`: OK (0 syntax errors).
>   - `python gen_map.py`: 2,665 symbols, 211 routes.
>   - Node test suite passed (`tests/bundle-budget.test.mjs`, `tests/app-shell*.test.mjs`, `tests/client*.test.mjs`, `tests/my-lists-addon-charts.test.mjs`, `tests/new-on-streaming.test.mjs`).
> - Branch: `feat/design-system-phase-1`

> **HANDOFF, 2026-10-03 (Antigravity): New Catalog Modal Naming, Form Checkbox Unification, & Mobile Header Group Hierarchy.**
>
> **Where things stand**
> - Modal Modernization & Design System Unification (`09_page-shell.js`, `12_tab-custom-lists.js`, `16_client-row-core.js`, `21_client-custom-list-builder.js`, `22_client-creator-profile.js`):
>   1. **New Catalog Modal Title Symmetry**:
>      - Updated `#addShelfModal` title to `<h2>New Catalog</h2>` (aria-label: `New catalog`) and primary action button to `Add Catalog` to match the `+ New Catalog` trigger button and mirror `Create List`.
>   2. **Form Checkbox Unification in Create List**:
>      - Replaced the cramped toggle in `Create List` with a unified, spacious **Checkbox Card Row** matching `Import List`.
>      - Fixed `onChangeCreateListDestination` to preserve block layout (`pubWrap.style.display = 'block'`) so label and helper text stack cleanly.
>      - Label clearly reads "Make list public" with descriptive helper text beneath.
>   3. **Your Custom Lists Header & Mobile Hierarchy**:
>      - In `12_tab-custom-lists.js`, nested the subtitle `Custom lists you've created locally or on your profile.` directly within the heading container.
>      - On desktop: Heading + Subtitle on the left, buttons on the right.
>      - On mobile: Heading and Subtitle stay united on lines 1 & 2; the action buttons (`+ Create List`, `Import`, `Refresh`) wrap as a dedicated toolbar directly above the list cards on line 3.
>   4. **Import List Modal**:
>      - Added `#importListModal` (`09_page-shell.js`) sharing design tokens (`max-width: 420px; border-radius: var(--radius-xl); padding: 22px;`).
>      - Promoted "Import" from an isolated subnav tab to an `[Import]` button in the My Lists header right next to `+ Create List`.
>      - Registered `importListModal` in `STATIC_MODALS` (`16_client-row-core.js`) and bound `openImportListModal` / `closeImportListModal` globally to `window`.
>      - Dual-input fallback in `importCustomListFromLink` (`21_client-custom-list-builder.js`) supports both modal and legacy panel inputs.
> - Liked Lists Polish & Chart Title Formatting (`19_client-search-and-likes.js`):
>   - In `render5PosterListsFeed`:
>     - Formats raw machine chart slugs (`TMDB:Chart:Popular` -> `TMDb: Popular`, `tmdb:chart:top_rated` -> `TMDb: Top Rated`, `trakt:chart:trending` -> `Trakt: Trending`, `mdblist:chart:top` -> `MDBList: Top`, `simkl:chart:anime` -> `Simkl: Anime`).
>     - Dynamically generates colorful provider badges (`.list-source-badge`: `badge-tmdb`, `badge-trakt`, `badge-mdblist`, `badge-simkl`, `badge-imdb`, `badge-mylists`) and injects them into `.list-card-title`.
>     - Populates `data-name`, `data-type`, `data-url`, `data-creator`, `data-items`, and `data-likes` on `.searchViewListBtn` so clicking the title seamlessly navigates to the list details page with human-readable titles.
>   - In `guessNameFromUrl`: Strips provider chart prefixes (`^(tmdb|mdblist|trakt|simkl):chart:`) before slug word separation and acronym capitalizations.
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK (5,443,306 bytes).
>   - `node --check worker_entry_combined.js`: OK (0 syntax errors).
>   - `python gen_map.py`: 2,665 symbols, 211 routes.
>   - Targeted test suites passing (`tests/app-shell.test.mjs`, `tests/client*.test.mjs`, `tests/bundle-budget.test.mjs`).
> - Branch: `feat/design-system-phase-1`
>
>
> **Where things stand**
> - Mobile Title Real Estate & Action Optimization (`09_page-shell.js`, `19_client-search-and-likes.js`, `21_client-custom-list-builder.js`, `22_client-creator-profile.js`):
>   1. **Semantic Repositioning of `Auto-tracked` Badge**:
>      - Moved `<span class="list-source-badge badge-autotrack">Auto-tracked</span>` out of `.list-card-actions` and into `.list-card-meta` (in `21_client-custom-list-builder.js` and `22_client-creator-profile.js`).
>      - Eliminates 86px of non-interactive badge clutter from the primary action row, leaving only the primary `+ Add` button on Row 1.
>      - "Watch History" and "Continue Watching" now have ~230px of horizontal breathing room and fit on a single line without truncation.
>   2. **Two-Line Title Wrapping on Mobile (`-webkit-line-clamp: 2`)**:
>      - Replaced single-line `white-space: nowrap` on `.list-card-title` in `09_page-shell.js` with `-webkit-line-clamp: 2; word-break: break-word; line-height: 1.25;`.
>      - Titles wrap naturally across two lines if needed before truncating with an ellipsis.
>   3. **Solution A: Responsive Icon Button for `Customize` on Mobile**:
>      - In `19_client-search-and-likes.js`, standardized `customizeListBtn` via `renderCustomizeButtonHtml` across Search, Curated Recommendations, and 5-Poster Feed.
>      - Includes an inline Lucide-style sliders SVG icon (`🎛`) and `<span class="customize-btn-text">Customize</span>` with accessible `title` and `aria-label`.
>      - In `09_page-shell.js` (`@media (max-width: 640px)`), `.customize-btn-text` is hidden (`display: none !important;`) and `.customizeListBtn` collapses into a sleek 28px square/pill icon button.
>      - In `21_client-custom-list-builder.js`, `loadListToCustomListDraft` preserves `innerHTML` instead of `textContent` during loading state.
>      - Total actions width on Discover drops from 174px down to 124px (saving 50px of width), allowing Discover titles like "New on Streaming" and "Most Watched Movies" to fit on 1 line.
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK (5,435,584 bytes).
>   - `node --check worker_entry_combined.js`: OK (0 syntax errors).
>   - `python gen_map.py`: 2,663 symbols, 211 routes.
>   - All 549 client and app shell tests passing.
> - Branch: `feat/design-system-phase-1`
>

> **HANDOFF, 2026-10-03 (Antigravity): Normal Refresh Route Retention, Discover Feed Initialization, & Service Worker v4.**
>
> **Where things stand**
> - Normal Refresh Route Jumping & Quick Add Grid Fix:
>   - Root Cause 1 (Route Jumping): In `16_client-row-core.js:2507` (`restoreActiveTab`), bundle initialization ran before `initAppShell` set `appShellActive = true`. It read `localStorage.getItem('myListAddon:activeTab') || 'discover'` and called `switchTab(tab)`. In `switchTab`, `if (!appShellActive)` triggered `history.replaceState(..., '', '/')`, wiping the URL from `/catalogs`, `/settings`, etc. to `'/'`. Then `initAppShell` saw `'/'` and redirected to `/discover`.
>   - Fix 1: Added `isAppShell` check in `switchTab` checking `document.documentElement.getAttribute('data-app-shell') === '1'` so the address bar is never rewritten to `'/'` on shell pages. Updated `restoreActiveTab` to read `data-initial-tab` first from the pre-rendered shell DOM.
>   - Root Cause 2 (Quick Add Grid vs Poster Shelves): In `11_tab-quick-add.js`, `#discoverShelvesContainer` (the legacy 2-column quick add grid) had no `display: none` in the server markup, while `#discoverSubSharedFeed` had `style="display:none;"`. When navigating to `/discover`, `route.sub` was empty (`""`), which bypassed `filterDiscoverShelves` in `appShellApplyRoute`.
>   - Fix 2: Set `style="display:none;"` on `#discoverShelvesContainer` by default and added `#discoverShelvesContainer { display: none !important; }` in `09_page-shell.js`. In `24_client-backup-restore-presets.js`, `appShellApplyRoute` now normalizes Discover subs (mapping empty/missing or `movies` to `movie` and `shows` to `series`) so `filterDiscoverShelves` is always reliably executed. Also in `initAppShell`, landing on `/` applies `{ tab: 'discover', sub: 'movie' }`.
>   - Root Cause 3 (Service Worker Navigation Fetch CORS & Cache v4): In `25_api-catalog-routes.js` (`SERVICE_WORKER_JS`), the synthesized `netReq` in the navigate handler omitted `mode: 'same-origin'`, causing Chromium/Safari to fail the fetch with a CORS TypeError and fall back to the cached `'/'` shell on normal reloads.
>   - Fix 3: Set `mode: 'same-origin'` and `credentials: 'same-origin'` on `netReq`, bumped Service Worker caches to `v4` (`mylists-assets-v4`, `mylists-shell-v4`) to automatically purge stale caches from user disks, and ensured `cache.put` only stores `SHELL_URL` for the root path.
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK (5,433,823 bytes).
>   - `node --check worker_entry_combined.js`: OK (0 syntax errors).
>   - `python gen_map.py`: 2,662 symbols, 211 routes.
>   - All 2,071 tests in the repository passing (`node --test tests/*.test.mjs`: 2,071 pass, 0 fail).
> - Branch: `feat/design-system-phase-1`
>
> **HANDOFF, 2026-10-03 (Antigravity): Global Drag Handle Modernization, 2-Line Poster Title Clamp, & Soft Brand-Tinted Add Pills.**
>
> **Where things stand**
> - 2-Line Poster Title Wrapping Fix (`09_page-shell.js`):
>   - Replaced single-line `white-space: nowrap` on `.list-card-mini-poster-name` with a standard 2-line clamp (`display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; min-height: 2.5em; word-break: break-word;`).
>   - Long movie and series titles (*Once Upon a Time in Hollywood*, *The Shawshank Redemption*, *Mononoke the Movie: The Phantom*) now wrap cleanly across two lines without premature truncation.
>   - Preserves uniform baseline alignment across all posters in the row via `min-height: 2.5em`.
> - Soft Brand-Tinted Add/Remove Pills (`09_page-shell.js`, `16_client-row-core.js`, `17_client-my-lists-and-trakt-oauth.js`, `21_client-custom-list-builder.js`, `22_client-creator-profile.js`):
>   - Solved the action indifference and flat contrast of plain white secondary buttons by styling `+ Add` as a soft brand-tinted pill:
>     - Background: `rgba(0, 122, 255, 0.08)` (light) / `rgba(10, 132, 255, 0.14)` (dark)
>     - Border: `1.5px solid rgba(0, 122, 255, 0.35)`
>     - Color: `var(--accent)` (brand blue)
>   - Visually separates the additive "publish to catalogs" action from neutral card management (`Edit`, `Delete` in neutral white).
>   - Avoids overwhelming the viewport or competing with the solid blue `+ New List` CTA at the top.
>   - When added to catalogs, smoothly transitions into a soft danger-tinted pill (`color: var(--danger); background: rgba(255, 59, 48, 0.08); border-color: rgba(255, 59, 48, 0.35);`).
> - Global Drag Handle Modernization (`09_page-shell.js`, `16_client-row-core.js`, `20_client-channel-builder.js`, `21_client-custom-list-builder.js`, `22_client-creator-profile.js`):
>   - Modernized drag handles across all 5 locations in the site simultaneously from the hamburger glyph (`☰` / `&#x2630;` / `&#9776;`) to a unified, crisp 6-dot vertical grip SVG (`<svg viewBox="0 0 10 16" width="10" height="16" fill="currentColor"...>`).
>   - Updated locations:
>     1. Catalog edit control rows (`16_client-row-core.js:3844`)
>     2. Live Preview & Editor shelf headers (`16_client-row-core.js:3877`)
>     3. My Channels lineup cards (`20_client-channel-builder.js:10691`)
>     4. Custom List builder Airing Next card (`21_client-custom-list-builder.js:4067`)
>     5. Lists tab cards in both Creator Dashboard and Local Custom Lists (`22_client-creator-profile.js:4948, 5350`)
>   - Added active grabbing state (`cursor: grabbing`) and SVG child styles in `09_page-shell.js`.
> - De-escalated Red Poster Delete Buttons (`09_page-shell.js`):
>   - Transformed `.cw-remove-btn` from a permanent shouting red alert dot to a sleek translucent dark glass circular badge (`background: rgba(15, 23, 42, 0.75); backdrop-filter: blur(4px); border: 1px solid rgba(255, 255, 255, 0.22);`).
>   - On desktop (`@media (hover: hover) and (pointer: fine)`), hide remove buttons until hovering or focusing the parent poster card, keeping artwork clean while smooth fading in on hover.
>   - Highlight in `var(--danger)` only on hover/active. On touch devices, remain visible in glass style to maintain 100% touch accessibility without alarm fatigue.
> - Tokenized "Auto-tracked" Badges (`09_page-shell.js`, `21_client-custom-list-builder.js`, `22_client-creator-profile.js`):
>   - Replaced raw inline unstyled text with the semantic design token `<span class="list-source-badge badge-autotrack">Auto-tracked</span>`.
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK (5,428,367 bytes).
>   - `node --check worker_entry_combined.js`: OK (0 syntax errors).
>   - `python gen_map.py`: 2,662 symbols, 211 routes.
>   - All 560 tests passing (`node --test tests/my-lists-addon-charts.test.mjs tests/app-shell*.test.mjs tests/client*.test.mjs tests/d1-schema.test.mjs`).
> - Branch: `feat/design-system-phase-1`

> **HANDOFF, 2026-10-03 (Antigravity): Global Form Controls & Semantic Input Standardization.**
>
> **Where things stand**
> - Single Source of Truth for Form Controls (`09_page-shell.js`):
>   - Replaced legacy global rule `input, select, textarea { background: var(--surface-2); }` with `background: var(--surface);` (clean white in light mode, elevated `#1C1C1E` in dark mode).
>   - Added `box-shadow: var(--shadow-sm);` and smooth border/shadow/background transitions across all inputs.
>   - Established semantic states for disabled & read-only inputs (`input:disabled, select:disabled, textarea:disabled, input[readonly], textarea[readonly]`):
>     - Rendered with sunken gray `background: var(--surface-2)` and muted text, providing intuitive visual feedback distinguishing editable vs. locked/system-generated tokens.
>     - Read-only fields suppress bright interactive focus halos on click/selection.
>   - Updated all modal form fields (`createListModal`, `addShelfModal`) and App Shell inputs from `var(--bg)` to `var(--surface)` with `1.5px solid var(--border-strong)`.
>   - Cleaned up one-off `#bulkPasteBox` background overrides to rely directly on the global design system rules.
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK (5,425,771 bytes).
>   - `node --check worker_entry_combined.js`: OK (0 syntax errors).
>   - `python gen_map.py`: 2,662 symbols, 211 routes.
>   - All 560 tests passing (`node --test tests/my-lists-addon-charts.test.mjs tests/app-shell*.test.mjs tests/client*.test.mjs tests/d1-schema.test.mjs`).
> - Branch: `feat/design-system-phase-1`

> **HANDOFF, 2026-10-03 (Antigravity): Bulk Add UX & Focus Ring Polish.**
>
> **Where things stand**
> - Focus Ring Fix (`09_page-shell.js`):
>   - Solved the jarring double-ring glitch on text inputs and textareas where global `:focus-visible` applied `outline: 2px solid var(--accent) !important; outline-offset: 2px; border-radius: 4px;`, creating a 2px gap and mismatched corner radii on 8px rounded inputs.
>   - Excluded text inputs/textareas from offset outlines and applied a seamless, hugging brand focus halo: `outline: none !important; border-color: var(--accent); box-shadow: 0 0 0 3px var(--color-brand-subtle, rgba(0,122,255,0.25)) !important;`.
> - Textarea Surface & Typography Polish (`09_page-shell.js`):
>   - Replaced flat dark `#e5e5ea` fill with crisp `var(--surface)` and `border: 1.5px solid var(--border-strong)`.
>   - Formatted monospace font with generous line-height (`1.6`), `min-height: 140px`, and `resize: vertical`.
>   - Added subtle `input::placeholder, textarea::placeholder` muted opacity styling.
> - Context & Supported Provider Badges (`09_page-shell.js`, `10_tab-search-add.js`):
>   - Added supported provider badge chips under the description: `MDBList`, `Trakt`, `TMDB`, `Simkl`, and `IMDb` (`.badge-imdb` with dark theme support).
> - Dynamic Counter & Real-Time Ergonomics (`10_tab-search-add.js`, `16_client-row-core.js`, `19_client-search-and-likes.js`):
>   - Connected `data-act-on="input"` on `#bulkPasteBox` to `updateBulkAddUi()`.
>   - Button text updates dynamically: `"Add All Lines as Catalogs"` when empty, and `"Add 1 Catalog"` / `"Add N Catalogs"` when URLs are present.
>   - Added a secondary `"Clear"` button (`#bulkClearBtn`) that appears when text is present, allowing one-click clearing and refocusing.
>   - Displays live URL count status in `#bulkDetectedCount`.
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK (5,425,577 bytes).
>   - `node --check worker_entry_combined.js`: OK (0 syntax errors).
>   - `python gen_map.py`: 2,662 symbols, 211 routes.
>   - All 560 tests passing (`node --test tests/my-lists-addon-charts.test.mjs tests/app-shell*.test.mjs tests/client*.test.mjs tests/d1-schema.test.mjs`).
> - Branch: `feat/design-system-phase-1`

> **HANDOFF, 2026-10-03 (Antigravity): Quick Add Polish - Removed Search/Pills & Removed Redundant Subtitle Microcopy.**
>
> **Where things stand**
> - Removed Search Bar & Pills (`10_tab-search-add.js`, `16_client-row-core.js`, `09_page-shell.js`):
>   - Reverted `#quickAddSearchInput`, `#quickAddCategoryBar`, and related toolbar elements as requested.
>   - Restored clean, uncluttered Quick Add shelf layout.
> - Removed Redundant Microcopy Subtitles (`08_quickadd-chart-data.js`, `09_page-shell.js`):
>   - Eliminated `<div class="discover-chart-sub">...</div>` across all cards in `buildStreamingRowsHtml` and `buildCombinedChartsHtml`.
>   - Stripped redundant labels: "Movies & Shows", "Blended Multi-Source Catalog", "Theatrical Box Office", "Anime Trending".
>   - Cards are now significantly cleaner and more compact, allowing the chart title and action buttons to stand on their own without clutter.
>   - Normalized `.discover-chart-header` `min-height: 38px;` so titles up to 2 lines align consistently across the grid row.
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK (5,421,639 bytes).
>   - `node --check worker_entry_combined.js`: OK (0 syntax errors).
>   - `python gen_map.py`: 2,660 symbols, 211 routes.
>   - All 557 client, shell, and chart tests passing (`node --test tests/my-lists-addon-charts.test.mjs tests/app-shell*.test.mjs tests/client*.test.mjs`).
>   - Quick add worker tests passing (`tests/worker.test.mjs`).
> - Branch: `feat/design-system-phase-1`
>
> **HANDOFF, 2026-10-03 (Antigravity): Quick Add Modernization - Phase 1 (Card Polish, Title Wrapping, & Add All Hierarchy).**
>
> **Where things stand**
> - Fix Card Title Truncation & Height Normalization (`09_page-shell.js`):
>   - Replaced single-line ellipsis clipping (`white-space: nowrap`) with 2-line clamp (`-webkit-line-clamp: 2; line-height: 1.25; word-break: break-word;`).
>   - Long catalog titles like "Streaming Top 10 (All Services)" and "Streaming Charts (Extended)" now wrap cleanly without cut-off words or ellipses.
>   - Added `min-height: 48px;` to `.discover-chart-header` with `align-items: flex-start; justify-content: space-between; gap: 8px;`, ensuring all cards maintain identical header height across grid rows.
> - "See All ›" Alignment (`09_page-shell.js`):
>   - Added `align-self: flex-start; padding: 2px 0; margin-top: 1px;` so "See All ›" remains neatly anchored to the top-right baseline of the first line of the title.
> - Refined `+ Add all` Button Hierarchy (`09_page-shell.js`, `10_tab-search-add.js`):
>   - Changed all 11 `.qa-add-all-btn` elements in `10_tab-search-add.js` from `lc-btn primary` to `lc-btn secondary`.
>   - Styled `.qa-add-all-btn` as a sleek secondary pill (`border-radius: var(--radius-pill); font-size: 0.80rem; padding: 4px 12px; color: var(--accent); border: 1.5px solid var(--border-strong); background: var(--surface);`).
>   - Added brand subtle hover styling (`background: var(--color-brand-subtle); border-color: var(--accent); color: var(--accent-hover);`).
>   - Eliminates solid blue button fatigue across the 11 Quick Add shelves while keeping all delegated action attributes (`data-add-all-action`) and test assertions intact.
> - Card Hover Interactivity & Button Feedback (`09_page-shell.js`):
>   - Enhanced `.discover-chart-card:hover` with a tactile 2px lift (`transform: translateY(-2px);`) and stronger border highlight (`border-color: var(--border-strong);`).
>   - Enhanced `.discover-chart-btns .lc-btn:hover` with accent border and accent color for immediate visual feedback when hovering "+ Movies" or "+ Shows".
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK (5,422,099 bytes).
>   - `node --check worker_entry_combined.js`: OK (0 syntax errors).
>   - `python gen_map.py`: 2,660 symbols, 211 routes.
>   - All 557 client, shell, and chart tests passing (`node --test tests/my-lists-addon-charts.test.mjs tests/app-shell*.test.mjs tests/client*.test.mjs`).
>   - Quick add worker tests passing (`tests/worker.test.mjs`).
> - Branch: `feat/design-system-phase-1`
>
> **HANDOFF, 2026-10-03 (Antigravity): Catalogs UI Polish - Dedupe Toggle Display, See All Link Styling, & Poster Title Alignment.**
>
> **Where things stand**
> - "Hide titles already shown in rows above" Always Visible on Catalogs Tab (`10_tab-search-add.js`, `16_client-row-core.js`, `22_client-creator-profile.js`, `23_client-list-management.js`, `24_client-backup-restore-presets.js`):
>   - Root Cause: In production environments where `FF_NEW_UI` is not set in Worker environment variables, `newUi` is `false`, so `<div id="appShellHomeEditor"></div>` was not emitted.
>   - Fix: Rendered the `.settings-toggle-row` card directly in HTML above Daily Randomizer when `newUi` is false, matching the exact styling and copy.
>   - Wired `catalogsDedupeCheckbox` across state restoration, presets, profile sync, `collectKeys()`, and `appActStoreSettingChecked` to ensure 100% two-way sync with `dedupeAcrossListsCheckbox` and live preview.
> - "See All ›" Text Action Link Polish (`09_page-shell.js`):
>   - Root Cause: Global button rules (`button { border-radius: var(--radius-pill); }`) and `:where(button:not(...))` applied capsule pill background and 40px min-height to `.text-action-btn` on hover/focus.
>   - Fix: Excluded `.text-action-btn` from `:where(button:not(...))` rules.
>   - Replaced button pill background with sleek text link styling: `background: transparent !important; border: none !important; box-shadow: none !important; border-radius: 0 !important; color: var(--accent) !important; font-size: 0.82rem; font-weight: 600; text-decoration: none;`. Hover applies `text-decoration: underline;` matching `.discover-chart-seeall`.
> - Poster Title Overflow & Baseline Clipping Fix (`09_page-shell.js`, `16_client-row-core.js`):
>   - Root Cause: `.live-preview-shelf` had hardcoded inline `style="padding:0; margin:0; border:none; background:transparent;"` and `.entry` had `padding: 0 !important;`. The last row of posters had 0px bottom margin, placing poster titles directly on top of the next card's 12px rounded corner border.
>   - Fix:
>     - Removed hardcoded inline style on `.live-preview-shelf` so CSS applies.
>     - Added `padding: 0 0 14px 0; margin-bottom: 12px;` to `.live-preview-shelf`.
>     - Added `padding-bottom: 6px;` to `.live-preview-posters`.
>     - Added `padding: 2px 4px 4px 4px;` and `line-height: 1.25;` to `.live-preview-poster-name` and `.live-preview-poster-subtitle`.
>     - Added `margin-bottom: 20px;` and `gap: 12px;` to `#lists`.
>   - Poster names and descenders now have ample breathing room and will never touch or breach container borders.
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK (5,420,826 bytes).
>   - `node --check worker_entry_combined.js`: OK (0 syntax errors).
>   - `python gen_map.py`: 2,660 symbols, 211 routes.
>   - All 542 targeted tests passing (`node --test tests/app-shell*.test.mjs tests/client*.test.mjs`).
> - Branch: `feat/design-system-phase-1`
>
> **HANDOFF, 2026-10-03 (Antigravity): Catalogs UI Polish - Control Row Height Normalization, Hide Titles Already Shown, & Mobile Actions Layout.**
>
> **Where things stand**
> - Control Row Height & Radius Normalization (`09_page-shell.js`):
>   - Excluded `.ec-btn` from general `button.secondary` and `button.danger` rules so they don't inherit 40px min-height or large padding.
>   - Standardized `input.pos` and all `.ec-btn` elements (`.drag-handle`, `.movebtn`, `.removebtn`) to exact matching dimensions:
>     - `height: 30px; min-height: 30px !important; max-height: 30px;`
>     - `box-sizing: border-box;`
>     - `border-radius: 7px;`
>     - `border: 1.5px solid var(--border-strong);`
>   - All 5 items in the catalog edit control row now sit perfectly flush with uniform heights and border radii.
> - "Hide titles already shown in rows above" Modernization (`24_client-backup-restore-presets.js`):
>   - Clarified that this setting was never removed; it resides directly above Daily Randomizer on the Catalogs tab in the new UI (`#appShellHomeEditor`).
>   - Modernized the markup in `appShellRenderHomeEditor()` to match Daily Randomizer using the sleek `.settings-toggle-row` and `.ui-toggle` switch.
> - Mobile Actions Bar Layout (`09_page-shell.js`, `10_tab-search-add.js`):
>   - Created `.catalog-actions-bar` replacing `.actions` on the bottom CTA row.
>   - On mobile (`<= 640px`), `Remove All` and `Generate Install Link` sit **beside one another** in a single row rather than staggered:
>     - `Remove All`: Compact destructive pill (`flex: 0 0 auto;`).
>     - `Generate Install Link`: Expanded primary pill (`flex: 1 1 auto; text-align: center;`) positioned directly under the user's thumb.
>     - Matches the side-by-side layout of `[ Install in Stremio ] [ Install in Nuvio ]` directly below it and saves precious vertical screen space.
>   - On desktop, maintains clean spacing (`Remove All` on the left, `Generate Install Link` on the right).
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK (5,418,247 bytes).
>   - `node --check worker_entry_combined.js`: OK.
>   - `python gen_map.py`: 2,660 symbols, 211 routes.
>   - All 542 client & shell tests passing; full test suite passing (2,068 tests).
> - Branch: `feat/design-system-phase-1`
>
> **HANDOFF, 2026-10-03 (Antigravity): Catalogs UI Modernization - Phase 3 (Installation Card & Manifest Link Consolidation).**
>
> **Where things stand**
> - Destructive vs. Primary CTA Separation (`10_tab-search-add.js`):
>   - Separated `Remove All` from `Generate Install Link` using `justify-content: space-between` and `margin-right: auto;`.
>   - Eliminates misclick risk by pushing the destructive action to the far left while keeping the primary action prominently on the right.
> - Consolidated Manifest Link Card (`24_client-backup-restore-presets.js`, `09_page-shell.js`):
>   - Consolidated the split Manifest Link layout into an integrated credential row (`.install-url-input-group`):
>     - Monospace URL box (`#manifestLinkDisplay`) on the left (`flex: 1 1 220px`).
>     - Solid primary brand pill button (`#copyUrlBtn`) directly adjacent on the right.
>   - Added `.install-url-copy-btn.primary` styling with white SVG icon, hover elevation, and brand subtle shadow.
>   - Enhanced typographic hierarchy in the manual install hint box.
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK (5,416,476 bytes).
>   - `node --check worker_entry_combined.js`: OK.
>   - `python gen_map.py`: 2,660 symbols, 211 routes.
>   - All 542 client & shell tests passing.
> - Branch: `feat/design-system-phase-1`
>
> **HANDOFF, 2026-10-03 (Antigravity): Catalogs UI Modernization - Phase 2 (Add Catalog Modal Polish).**
>
> **Where things stand**
> - Modernized "Add Catalog" Modal (`#addShelfModal` in `09_page-shell.js`, `16_client-row-core.js`):
>   - Replaced plain text `Cancel` and faint `Add` links with standard design system pill buttons: `Cancel` (`.lc-btn.secondary`) and `Add` (`.lc-btn.primary` with distinct disabled state).
>   - Added a top-right `✕` dismiss button (`.modal-close-x`) with `data-act="appActHideAddShelfModal"`.
>   - Added clear uppercase field micro-labels (`CATALOG NAME`, `CATALOG URL`, `CONTENT TYPE`) above inputs so users never lose context when placeholders disappear.
>   - Expanded card width from a cramped 340px to a comfortable 400px (matching the `New Custom List` modal).
>   - Standardized input padding, borders, and remove button styling for dynamic additional URLs in `16_client-row-core.js`.
>   - Preserved all IDs (`#addShelfModal`, `#addShelfModalName`, `#addShelfModalLinksContainer`, `.addShelfModalLinkInput`, `#addShelfModalType`, `#addShelfModalBtn`) and validation behavior.
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK (5,415,471 bytes).
>   - `node --check worker_entry_combined.js`: OK.
>   - `python gen_map.py`: 2,660 symbols, 211 routes.
>   - All 542 client & shell tests passing.
> - Branch: `feat/design-system-phase-1`
> - Next step: Phase 3 (Installation Card & Manifest Link Consolidation).
>
> **HANDOFF, 2026-10-03 (Antigravity): Catalogs UI Modernization - Phase 1 (Daily Randomizer Toggles & Edit Mode Trash Icon Fix).**
>
> **Where things stand**
> - Modernized Daily Randomizer Controls in Catalogs Tab (`10_tab-search-add.js`):
>   - Converted legacy browser checkboxes into sleek `.settings-toggle-row` with `.ui-toggle` switches, harmonizing with the Settings tab design system.
>   - Added clear, concise microcopy for both options ("Rotates the order of your catalog rows once every 24 hours" and "Randomizes the order of titles inside each catalog row every 24 hours").
>   - Preserved all IDs (`#shuffleShelvesCheckbox`, `#shuffleItemsCheckbox`) and state persistence (`data-act="saveState"`).
> - Fixed Edit Mode Delete/Trash Icon Visibility (`16_client-row-core.js`, `09_page-shell.js`):
>   - Resolved the faint/invisible delete icon bug visible when zoomed out or in light theme.
>   - Enforced 16x16px SVG dimensions with `stroke-width="2.2"` and `display:block;`.
>   - Enhanced `.ec-btn.danger` styling with high-contrast color (`#d70015` in light theme, `#ff453a` in dark theme), clean borders, and solid hover state (`background: var(--color-danger); color: #fff`).
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK (5,414,618 bytes).
>   - `node --check worker_entry_combined.js`: OK.
>   - `python gen_map.py`: 2,660 symbols, 211 routes.
>   - All 542 client & shell tests passing.
> - Branch: `feat/design-system-phase-1`
> - Next step: Phase 2 (Add Catalog Modal Polish - pill action buttons Cancel/Add and clear field labels).
>
> **HANDOFF, 2026-10-03 (Antigravity): UI Polish - Emoji Cleanup, Preset Dropdown Overflow Fix, Button Sizing Normalization.**
>
> **Where things stand**
> - Emoji Clutter Elimination:
>   - Removed provider emojis (`🎬`, `▶`, `📋`, `📺`) from TMDB, Trakt, MDBList, and Simkl cards in `15_tab-settings-html.js`.
>   - Removed folder emoji (`📂`) from `.import-dropzone` in `15_tab-settings-html.js`.
>   - Removed download/upload emojis (`📥`, `📤`) from "Download Backup" and "Restore from File" headings in `14_tab-presets-backup.js`.
>   - Removed emojis (`📥`, `🔄`, `🗑️`) from the preset overflow dropdown items (`Download .json`, `Restore Lists`, `Delete Preset`) in `24_client-backup-restore-presets.js`.
>   - Removed emoji icons (`📖`, `☕`, `⚡`) from documentation and resource cards in `15_tab-settings-html.js`.
> - Fixed Preset Dropdown Cutoff:
>   - Resolved cutoff issue where `.preset-overflow-dropdown` was clipped by the container edge on short preset lists.
>   - Root cause: `.panel` had `overflow: hidden;` in `09_page-shell.js`.
>   - Solution: Set `.panel { overflow: visible; }`, added `.preset-card:has(.preset-overflow-menu[open]) { z-index: 50; }`, and set `.preset-overflow-dropdown { z-index: 100; }`.
> - Button Sizing Normalization:
>   - `+ New Catalog`: Decoupled `.actions button.primary` from `.btn-lg` in `09_page-shell.js`, restoring the compact pill sizing (`.lc-btn`) to match adjacent `Edit` and `Refresh Preview` controls.
>   - `Search`: Matched the `#content-search` Search button in `13_tab-channels.js` and `09_page-shell.js` to the exact dimensions, height (36px), padding (7px 16px), font size (0.86rem), and pill shape of the Movies, Shows, and Lists filter pills (`.subnav-pill`).
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK (5,413,572 bytes).
>   - `node --check worker_entry_combined.js`: OK.
>   - `python gen_map.py`: 2,660 symbols, 211 routes.
>   - All tests passing with 0 failures.
> - Branch: `feat/design-system-phase-1`
>
>
> **Where things stand**
> - Completed Phase C (External Accounts & API Keys):
>   - Structured Provider Integration Cards (`.provider-card`, `.provider-card-header`, `.provider-card-brand`, `.provider-card-icon`, `.provider-card-title`, `.provider-card-desc`):
>     - Upgraded TMDB, Trakt, MDBList, and Simkl sections into modern, surface-elevated provider cards with brand icons.
>     - Positioned status indicators as sleek pill badges (`.provider-status-badge`) next to provider titles.
>     - Resolved button hierarchy: Prominent primary CTA (`.primary.lc-btn`) for connecting/reconnecting; distinct secondary action for Trakt device PIN/code (`#traktDeviceBtn`); danger styling (`.btn-danger`) for disconnect buttons.
>     - Cleaned up custom API key / client ID inputs inside expandable `.provider-advanced-disclosure` drawers with animated chevron indicators.
>   - Modern Drag-and-Drop Dropzone for Import List (`.import-dropzone`):
>     - Added interactive dashed drag & drop area with upload icon, format hints, and hover/dragover highlights.
>     - Wired native HTML5 drag & drop listeners (`dragover`, `dragleave`, `drop`) in `18_client-copy-and-trakt-export.js` feeding directly into `onUnifiedImportFilesSelected`.
>     - Preserved all element IDs (`importListSourceSelect`, `importTargetListSelect`, `unifiedImportFileInput`, `btnUnifiedImport`, etc.) and `data-act` bindings.
> - Completed Phase D (Feedback & Resources Polish):
>   - Ergonomic Feedback Container (`.feedback-container`):
>     - Constrained the feedback form and composer to an optimal readable reading line length (`max-width: 680px`) on desktop displays.
>   - Unified Resources & Documentation Cards (`.resource-cards-grid`, `.resource-card`, `.resource-card-top`, `.resource-card-icon`):
>     - Replaced disconnected, tiny 2-line panels with an elegant 3-card resource grid for User Guide & Docs (`/guide`), Buy Me a Coffee, and TorBox Debrid.
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK.
>   - `node --check worker_entry_combined.js`: OK.
>   - `python gen_map.py`: OK.
>   - `node check_bundle_budget.mjs`: First view JS is 93.45 KB gzip (budget: <= 150 KB).
>   - Full client, shell, and watchlist test suites passing (572 tests pass).
> - Branch: `feat/design-system-phase-1`
>
> **HANDOFF, 2026-10-03 (Antigravity): Settings UI Modernization - Phase B (Presets & Backup Cleanup).**
>
> **Where things stand**
> - Completed Phase B of Settings UI & UX Modernization:
>   - Modernized Presets List with 3-Dot Overflow Menu (`.preset-actions-cluster`, `.preset-overflow-menu`, `.preset-overflow-dropdown`):
>     - Streamlined the 5-button row into primary `Load` + secondary `Share` + compact `⋯` overflow menu containing `Download .json`, `Restore Lists`, and destructive `Delete Preset` (red).
>     - Added click-outside dismissal and auto-close on action select.
>     - Preserved all data delegation classes (`preset-load-btn`, `preset-share-btn`, `preset-download-btn`, `preset-restore-lists-btn`, `preset-delete-btn`).
>   - Redesigned Backup & Restore into Friendly Action Cards & Progressive Disclosure:
>     - Created two distinct action tiles: "Download Backup" and "Restore from File" with prominent CTAs.
>     - Tucked the intimidating raw JSON textarea (`#configJsonBox`) and raw import/export buttons inside an expandable `<details class="backup-advanced-disclosure">` accordion.
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK.
>   - `node --check worker_entry_combined.js`: OK.
>   - `python gen_map.py`: OK.
>   - Client & core test suites passing (399 client tests pass).
> - Branch: `feat/design-system-phase-1`
> - Next step: Phase C (External Accounts & API Keys - Provider Integration Cards, connection badges, streamlined Trakt device auth, and drag-and-drop file import).
>

>
> **Where things stand**
> - Completed Phase A of Settings UI & UX Modernization:
>   - Unified Account Key Credential Group (`.account-key-group`, `.account-key-actions`):
>     - Consolidated the 4-row detached Account Key layout into a single sleek credential input group with trailing inline `Show Key` and `Copy Key` buttons.
>     - Fully responsive on mobile screens (stacks gracefully below 520px).
>   - Contained Danger Zone in Collapsible Progressive Disclosure (`.danger-zone-disclosure`, `.danger-zone-summary`, `.danger-zone-arrow`, `.danger-zone-content`):
>     - Destructive actions (`Reset Account Data` and `Delete Account & All Data`) are now enclosed inside an expandable `<details>` drawer at the bottom of the card.
>     - Eliminates loud, anxiety-inducing orange/red alert boxes from dominating everyday settings browsing.
>   - Converted Watchlist Preferences to Modern Toggle:
>     - Transformed "Automatically remove watched items from Watchlist" from an unstyled checkbox into `.settings-toggle-row` with an iOS-style `.ui-toggle` switch.
>   - Modernized Hidden Lists Section:
>     - Wrapped "Whole Sections" and "Individual Lists" into `.settings-check-group` and `.settings-check-item` cards with hover feedback, clean dividers, and touch-friendly padding.
>   - Modernized Remaining Account & Sync Feature Panels:
>     - Converted "Hide items with no digital release" (Trending & Popular Catalogs), "Remove duplicate items across lists" (Duplicate Items Across Lists), "Adult Content Filter", and "Use Better Posters artwork" into `.settings-toggle-row` with `.ui-toggle` switches.
>     - Converted Better Posters options (Genre, Rating, Trend tags, Quality tags, Age rating) into `.settings-check-group` with `.settings-check-item` cards.
> - Verification & Tests:
>   - `python build.py` & `python check_sync.py`: OK.
>   - `node --check worker_entry_combined.js`: OK.
>   - `python gen_map.py`: 2,660 symbols, 211 routes.
>   - Full test suite: 2,068 passing, 0 failing across all 25 test files.
> - Branch: `feat/design-system-phase-1`
> - Next step: Phase B (Presets & Backup cleanup - 3-dot overflow menu for preset rows, progressive disclosure for raw JSON box, friendly backup download/upload buttons).
>
> **HANDOFF, 2026-10-03 (Antigravity): Design System - Settings Toggles & Checklist Modernization.**
>
> **Where things stand**
> - Modernized Settings interface based on UX toggle vs. checklist heuristics:
>   - Converted standalone feature and automation switches into smooth, tactile iOS-style `.ui-toggle` switches:
>     - "Enable In-App Playback Auto-Tracking" (`#trackPlaybackCheck`).
>     - "Enable Media Server User Filtering" (`#scrobbleFilterUsersCb`).
>     - "Sync media server scrobbles to Watch History" (`#syncMediaServerHistoryCb`).
>     - "Forward scrobbles to connected external accounts" (`#forwardScrobbleToProvidersCb`).
>     - "Storyline & Companion Recommendations" (`#autoRecommendCompanionsCheckbox`).
>     - Provider sync toggles: Trakt (`#syncTraktHistoryCheckbox`), MDBList (`#syncMdblistHistoryCheckbox`), Simkl (`#syncSimklHistoryCheckbox`).
>   - Upgraded multi-select "Poster Badges & Labels" into modern settings checklists (`.settings-check-group`, `.settings-check-item`):
>     - Made entire row touch-clickable with hover feedback (`var(--color-bg-sunken)`).
>     - Stripped repetitive microcopy ("Show premiere, finale, and air date badges on..."), keeping concise titles and clear examples.
>     - Preserved all input IDs, `data-act`, and `data-act-args` bindings with zero behavioral changes.
> - Verified via `python build.py`, `python check_sync.py`, `node --check worker_entry_combined.js`, `python gen_map.py`, `node check_bundle_budget.mjs` (first view JS: 93.30 KB gzip <= 150 KB budget), and test suites pass (18 app-shell tests, 6 scrobble-filter tests, 417 client tests).
> - Branch: `feat/design-system-phase-1`
>
> **HANDOFF, 2026-10-03 (Antigravity): Design System - Mobile Nav & Compact Button Architecture Fix.**
>
> **Where things stand**
> - Fixed mobile bottom navigation bar regression:
>   - Replaced high-specificity `:not(...)` pseudo-class chain with `:where(button:not(...))` in `09_page-shell.js` to eliminate specificity creep (dropped from `(0, 14, 1)` to `(0, 0, 0)`).
>   - Explicitly excluded `.bottom-nav-item` and `.lc-btn` from primary/secondary 40px default styling.
>   - Hardened `.bottom-nav-item` with `background: transparent !important; border: none !important; border-radius: 0 !important; box-shadow: none !important; color: var(--muted);`, restoring the crisp white/translucent glassmorphism bottom bar on mobile with active-only blue icon/label.
> - Restored original compact button sizing for action controls:
>   - Set `.lc-btn { min-height: unset; padding: 6px 12px; font-size: 0.8rem; }` and decoupled it from `.btn-sm`, `.primary`, and `.secondary`.
>   - `+ Add` (`.lc-btn.primary`) and `Customize` (`.lc-btn.secondary`) now render in their compact, balanced dimensions.
> - Restored subtle neutral surface styling for the heart button:
>   - Styled `.lc-btn.searchLikeExternalBtn`, `.lc-btn.searchLikeBtn`, and `#detailLikeBtn` with a subtle surface background (`var(--color-bg-surface)`), muted border (`var(--color-border-strong)`), and grey heart outline, turning red only when `.liked`.
>   - Eliminated visual conflict between adjacent primary blue buttons, restoring clean visual hierarchy.
> - Verified via `python build.py`, `python check_sync.py`, `node --check worker_entry_combined.js`, `python gen_map.py`, `node check_bundle_budget.mjs` (first view JS: 93.30 KB gzip <= 150 KB budget), and tests pass (18 app-shell tests, 7 like tests, all 2,068 suite tests).
> - Branch: `feat/design-system-phase-1`
>
> **HANDOFF, 2026-10-03 (Antigravity): Design System - Phases 1 to 4 (Complete UI Modernization & Standardization).**
>
> **Where things stand**
> - Implemented all 4 Phases of Design System:
>   - Phase 1: Consolidated CSS Variables & Semantic Design Tokens in `:root` and `:root.dark-theme` (`09_page-shell.js`):
>     - Semantic Surfaces & Overlays (`--color-bg-canvas`, `--color-bg-surface`, `--color-bg-elevated`, `--color-bg-sunken`, `--color-bg-overlay`).
>     - Semantic Borders (`--color-border-subtle`, `--color-border-strong`, `--color-border-focus`).
>     - Semantic Typography / Foreground (`--color-text-primary`, `--color-text-secondary`, `--color-text-muted`, `--color-text-inverse`).
>     - Brand & Semantic Accent (`--color-brand`, `--color-brand-hover`, `--color-brand-active`, `--color-brand-subtle`, `--color-brand-2`).
>     - Status & Feedback (`--color-danger`, `--color-danger-hover`, `--color-danger-subtle`, `--color-success`, `--color-warn`, rating scales).
>     - Shadows & Elevation scales (`--shadow-sm`, `--shadow`, `--shadow-md`, `--shadow-lg`, `--shadow-focus`).
>     - 8pt Spatial Spacing Scale (`--space-0-5` through `--space-8`).
>     - Border Radius Scale (`--radius-xs` through `--radius-pill`).
>     - Control Heights & Minimum Touch Targets (`--control-height-sm`, `--control-height-md`, `--control-height-lg`, `--control-touch-min`).
>     - Full backward-compatibility mapping for all legacy aliases (`--bg`, `--surface`, `--surface-2`, `--surface-3`, `--panel`, `--border`, `--text`, `--accent`, etc.).
>     - Fixed dark-mode modal flattening: updated dialogs (`createListModal`, `addShelfModal`, `selectListModal`, `traktDeviceModal`) and `.modal-card` to use `--color-bg-elevated` and `--color-border-strong` with elevated shadows instead of pitch-black `--bg`.
>   - Phase 2: Standardized Button Architecture (`09_page-shell.js`):
>     - Unified base button reset `.btn`, `button`, `.actions a` with smooth transitions and active pressed feedback (`transform: scale(0.98)`).
>     - Semantic style variants: `.btn-primary` (brand solid), `.btn-secondary` (surface + border), `.btn-ghost` / `.btn-tertiary` (transparent hover fill), `.btn-danger` / `.btn-destructive` (red alert outline/fill).
>     - Standard size variants: `.btn-sm` (32px), `.btn-md` (40px default), `.btn-lg` (48px primary CTAs).
>     - Mapped legacy `.lc-btn`, `button.secondary`, `.actions button`, `preset-load-btn`, etc. directly to the new button system with backward compatibility.
>     - Enhanced touch targets: Added `::after` touch padding to `.cw-remove-btn` to satisfy WCAG 44×44px minimum touch perimeter; ensured `.subnav-pill` has min-height 36px.
>   - Phase 3: Template Cleanup & Button Class Normalization (`10_tab-search-add.js`, `15_tab-settings-html.js`, `09_page-shell.js`):
>     - Replaced inline color overrides and secondary button red styling with `.btn-danger` and `.btn-danger.btn-sm` on destructive actions ("Remove All", "Clear History", "Clear Continue Watching").
>     - Cleaned up Catalogs action bar with `.btn-primary` and `.btn-danger`.
>   - Phase 4: Streamlined Settings & Progressive Disclosure (`15_tab-settings-html.js`, `09_page-shell.js`):
>     - Converted dense multi-paragraph settings microcopy (Trending Catalogs, Deduplication across lists, BetterPosters) into concise, scannable 1-line descriptions with clean collapsible `<details>` disclosures for technical caveats.
>     - Resolved undefined `--surface-2` and `--surface-3` token variables in `:root` and `:root.dark-theme`.
> - Verified via `python build.py`, `python check_sync.py`, `node --check worker_entry_combined.js`, `python gen_map.py`, `node check_bundle_budget.mjs` (first view JS: 93.30 KB gzip <= 150 KB budget), and full test suite (`node --test tests/*.test.mjs`: 2,068 passing, 0 failing).
> - Branch: `feat/design-system-phase-1`
>
> **HANDOFF, 2026-10-03 (Antigravity): Media Item Details & Top Header Bar Redesign.**
>
> **Where things stand**
> - Implemented Media Item Details redesign:
>   - Sharp backdrop hero image with bottom gradient fade into page background.
>   - Floating translucent back arrow button in the top-left corner.
>   - Primary actions (`+ Add to List`, `Mark as Watched`) positioned above the synopsis.
>   - Metadata pill badges (Rating, Runtime, Year, TMDB Score).
>   - Interactive genre chips that jump to catalog search with that genre selected.
>   - 3-line synopsis clamp with dynamic "Read More" / "Show Less" toggle.
> - Implemented Top Header Bar compaction:
>   - Search moved from bottom mobile nav to top header icon next to Dark Mode toggle.
>   - Removed wide profile button banner and replaced with circular 36px avatar button.
>   - Header actions and title align cleanly on a single row.
> - Verified via `python build.py`, `python check_sync.py`, `node --check worker_entry_combined.js`, `python gen_map.py`, and test suites (417 client/app-shell tests, 758 worker tests).
> - Branch: `feat/details-and-header-redesign`
>
