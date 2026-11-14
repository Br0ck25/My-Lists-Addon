# 01 Code quality and architecture
Health grade: B- — The structure is disciplined (numbered sources, a build check, size ratchet, scope checker, no known-vulnerable packages). The weak spots are very large client files and functions that nothing measures, copy-pasted blocks, a few dead functions, and two instruction files that disagree.

## Scope covered (files, routes, commands run)
- All of `src/header.js` and `src/<group>/NN_*.js` (server scope), plus the builder and admin page scripts as emitted by the Worker (client scope, extracted from the rendered HTML).
- Own scripts in `/tmp/claude-0/-home-user-My-Lists-Addon/55241830-1216-5d7f-89cf-715a0b7ec78e/scratchpad/s01/`:
  - `analyze.mjs` (function/file sizes, duplicate top-level declarations per scope, server-vs-client same names)
  - `dead2.mjs` (dead server functions, comments stripped), `dead3.mjs` (dead client functions, including HTML attributes)
  - `dupblocks.mjs` (copy-pasted 12+ line blocks), `guards.mjs` (needless `typeof fn === "function"` guards)
- Mutation experiments done in a private copy (`s01/repo/`), never in the real tree. Only `build.py`, `.claude/settings.json`, `verify.sh`, `AGENTS.md`/`CLAUDE.md`, `tools/` and `tests/size-budget.*` were read in the real tree.
- `npm audit` / `npm outdated` run in a scratch package (`s01/npmcheck/`).
- Not read, per the brief: the earlier audit files in `docs/` (they exist; I did not use them).

Numbers measured:
- Top-level names: 2,308 on the server side, 1,409 on the builder page, 137 on the admin page.
- Duplicate top-level declarations: 0 in the server scope, 0 in the builder page, 0 in the admin page.
- Functions over 150 lines: 28 on the server side (26 listed in `tests/size-budget.json`, plus the two exempt page renderers). 42 in the builder page script (nothing measures these). 0 in the admin page.
- Source files over 3,000 lines: 13, all listed in the budget.

## Fix progress

Updated 2026-11-14. Status values: `open`, `fixed (awaiting verification)`, `verified`, `failed verification`. To verify a row, run its check and change the status.

| Finding | Status | Commit | Verified | How to verify |
|---|---|---|---|---|
| CQ-01 | verified fixed | b16b13a | 2026-11-14, independent review | Table said 3d50d40, which does not exist; the fix is b16b13a. Check: `node --test tests/size-budget.test.mjs`. |
| CQ-02 | verified fixed | 7824ed4 | 2026-11-14, independent review | `node --test tests/continue-watching-row-map.test.mjs` |
| CQ-03 | verified fixed | 2d17999, 370a8b1 | 2026-11-14, independent review | `node --test tests/list-panel-badges.client.test.mjs tests/airing-next-cache.client.test.mjs` |
| CQ-04 | open (partially fixed) | 2d4b89f | 2026-11-14, independent review | Only buildNuvioTvDefaultPreset removed (tests/dead-code.test.mjs). The test-only and shelf functions are left: owner decision needed. |
| CQ-05 | verified fixed | 4d2e858 | 2026-11-14, independent review | `node --test tests/channel-constants-parity.test.mjs` |
| CQ-06 | verified fixed | c9da1f9 | 2026-11-14, independent review | `node --test tests/agent-instructions.test.mjs` |
| CQ-07 | open |  | | Not started: needs a decision on which server write paths deserve logging. |
| CQ-08 | open |  | | Not started: the report says not worth a dedicated pass; remove guards when a file is touched anyway. |
| CQ-09 | fixed (awaiting verification) | f6ab6fa |  | `node --test tests/build-source-names.test.mjs` (6 pass): same base name in two folders now fails the build. |

## Proven findings

### CQ-01 The size-budget test cannot see client code: 42 oversized functions are unmeasured
- Severity: Medium
- Status: Proven
- File:line: `tests/size-budget.test.mjs:11-12` (the limitation is stated in the file); biggest offenders `src/client/23_client-list-management.js:2757` (`openListDetailsPage`, 1,177 lines), `src/client/22_client-creator-profile.js:2946` (`loadCreatorSync`, 823 lines)
- What is wrong: The rule "functions <= 150 lines" is only enforced on server code. Client code lives inside a template literal, so the test parses it as a string and checks only the 3,000-line file limit. Most of the app's logic is client code. A new 400-line client function sails through.
- Impact: The most complex code in the product (the builder page) is where the limit does least. Giant functions are the ones most likely to hide bugs and to be hard for the next AI session to edit safely.
- Proof: In the scratch copy I added a 400-line named client function and a 400-line anonymous function to `src/client/20_client-dead-links.js`, and a 400-line named server function to `src/jobs/46_show-refresh.js`.
  - With only the client additions (server addition reverted): `node --test tests/size-budget.test.mjs` printed `# pass 1  # fail 0`.
  - With the server addition (client additions reverted): `# pass 0  # fail 1`, with `src/jobs/46_show-refresh.js::hugeServerFn: new code over the limit (403 lines, limit 150): split it`.
  - Measurement of the real page: `node s01/analyze.mjs` reports builder `functions >150: 42`; the top ones are `openListDetailsPage` 1,177, `loadCreatorSync` 823, `openSelectListModal` 451.
- Recommended fix and effort: M. Extract the client code from the rendered page (or from the numbered client files wrapped as a script) and measure it with the same acorn routine, with a baseline file, as the server code. At minimum add the 42 current sizes as a ratchet so they cannot grow.

**Verification.** The table listed commit 3d50d40, which is not in the repository; the fix is b16b13a. It measures every inline script of the rendered builder page with the same acorn routine and keeps 38 named client functions as a shrink-only ratchet (`clientFunctions` in `tests/size-budget.json`). In a scratch worktree, appending to `src/client/20_client-dead-links.js`: a 400-line named function fails (`page::probeBig: new code over the limit`), and a 400-line object method fails (`page::big`). Two gaps, neither blocking: (1) a 400-line anonymous callback passes, but the server side treats anonymous functions the same way (checked: a 400-line anonymous callback in `src/jobs/46_show-refresh.js` also passes), so client and server now follow one rule; this is why the audit counted 42 and the baseline holds 38. (2) The admin page script is not measured; a 300-line function added to it was caught only because `src/admin/03_admin.js` is on the shrink-only file list, not by name. It has 0 functions over the limit today. The two new tests would fail at the parent (`functionSizes` did not exist). Verdict: verified fixed for the finding as written (the builder page, 42 unmeasured functions).

### CQ-02 Same database-row-to-item mapping written out three times (continue-watching)
- Severity: Medium
- Status: Proven
- File:line: `src/catalog/05_catalog-core.js:2748-2780`, `src/core/02_http-and-creator-utils.js:6768-6800` (identical, 27+ lines), and a third variant at `src/data/37_activity-backfill.js:194`
- What is wrong: The code that turns a stored "continue watching" row into an item (including parsing the `COMPANION:` marker in `show_title`, working out movie vs episode, and copying 17 fields) is pasted in two places verbatim and rewritten a third time.
- Impact: A fix to one copy (for example how a movie is told apart from an episode, which the project treats as a hard rule) will silently not apply to the others, so the catalog and the creator-tracking read path can disagree about the same row.
- Proof: `node s01/dupblocks.mjs /home/user/My-Lists-Addon 12` lists `27 lines: src/catalog/05_catalog-core.js:2748 <-> src/core/02_http-and-creator-utils.js:6768` and `22 lines: ...:2768 <-> ...:6788`. I read both: same `let isCompanion/companionType/...` declarations, same `type = (r.season_num == null && r.episode_num == null && !r.show_title) ? "movie" : "episode"`, same return object. `grep -rn 'startsWith("COMPANION:")' src` shows three sites (05_catalog-core.js:2756, 02_http-and-creator-utils.js:6776, 37_activity-backfill.js:194).
- Recommended fix and effort: S. Add one `mapContinueWatchingRow(r)` helper next to the companion code and call it from both places; decide separately whether the third (backfill) variant should use it.

**Verification.** `git show 7824ed4`: both verbatim copies (catalog read in `fetchAutoTrackedCatalog`, creator-tracking read in `readCreatorTrackingD1`) are replaced by `.map(mapContinueWatchingRow)`, and the helper body is the old code moved unchanged (`src/core/02_http-and-creator-utils.js:6683`); it only reads its first argument, so `.map` passing index/array is harmless. `grep -rn 'startsWith("COMPANION:")' src` now shows the helper and the backfill variant only. The backfill variant (`legacyContinueWatchingFromRow`, `src/data/37_activity-backfill.js:182`) builds a different shape (keeps `showId` for movies, no `kind` fallback for companion movies); the finding left that as a separate decision, so it is not counted against the fix. `tests/continue-watching-row-map.test.mjs` (5 pass) covers movie, episode, companion movie and broken companion JSON, and its "exists once" check would find 2 copies at the parent commit. Verdict: verified fixed.

### CQ-03 Three near-identical 190-270 line renderers for the provider list panels
- Severity: Medium
- Status: Proven
- File:line: `src/client/17_client-my-lists-and-trakt-oauth.js:213` (`renderMyMdblistLists`), `:1212` (`renderMyPrivateTraktLists`), `:2716` (`renderMySimklLists`)
- What is wrong: The Airing Next cache-merge logic (read cached episode info from localStorage, match to local list, fill `airDate`, `seasonNum`, `isSeasonPremiere`, `isSeasonFinale`, ...) is copied into each of the three functions, differing only by provider name, element id and cache key.
- Impact: Any fix to how Airing Next dates or finales are applied has to be made three times. They are all over the 150-line limit and are among the unmeasured client functions (CQ-01).
- Proof: `s01/a.txt`, `s01/b.txt`, `s01/c.txt` hold the three function heads; they match line for line apart from `myMdblistLists`/`myPrivateTraktLists`/`mySimklLists`, `mdblistAiringNextCache`/`traktAiringNextCache`/`simklAiringNextCache` and the `cacheMap`/`localMatch` blocks. The detector reports repeated regions between them: `30 lines: 17_client-my-lists-and-trakt-oauth.js:230 <-> :1229 <-> :2734 (copies:3)`, `33 lines: :335 <-> :1335`, `22 lines: :404 <-> :1409`. Sizes (analyze.mjs): 268, 273, 188 lines.
- Recommended fix and effort: M. Move the shared "apply cached Airing Next data" step into one helper that takes the provider's cache key, and keep each renderer to its own markup.

**Verification.** `git show 2d17999`: the 30-line cache merge (the `copies:3` region) is now one `applyAiringNextCache(list, cacheKey)` called from all three renderers with the right key each; the three `localStorage.setItem` writers (`:108`, `:1122`, `:2636`) use the same keys, and the removed `localAiringList` is not used later in any renderer. `tests/airing-next-cache.client.test.mjs` passes (6) and would fail at the parent (no such function). But the finding's proof also named two more copied regions, and both are still there: a 15-line duplicate scan of `src/client/17_client-my-lists-and-trakt-oauth.js` shows `:342` <-> `:1305` (33 identical lines: air date from `findAiringMatchFor`, `isSeasonPremiere`, `isSeasonFinale`, `seasonFinaleAirDate`, and the premiere/finale badge HTML) and `:405` <-> `:1373` (34 identical lines: badge settings and card markup) between `renderMyMdblistLists` and `renderMyPrivateTraktLists`. The finding's impact ("a fix to how Airing Next dates or finales are applied has to be made more than once") still holds for that display logic. Verdict: partially fixed, set back to `open`. Next step: one helper for the per-item air-date/premiere/finale badge computation (the `:343`-`:375` block), used by both renderers. Not in scope but seen: `openMdblistAiringNextDetailsPage`/`openTraktAiringNextDetailsPage`/`openSimklAiringNextDetailsPage` repeat the same `localMatch` premiere/finale lines.

**Verification (second pass, 370a8b1).** The two blocks sent back are now `upNextTileBadgesHtml(it, sectionSettingKey)` (MDBList Up Next, Trakt Continue Watching, each passing its own toggle key) and `airingNextTileBadgesHtml(it)` (MDBList, Trakt, Simkl Airing Next), at `src/client/17_client-my-lists-and-trakt-oauth.js:259` and `:302`. I compared each removed copy with the helper: the bodies are the same; Simkl's old `!!it.isSeasonFinale` and `it.seasonFinaleAirDate || null` have the same truthiness as the helper's `it.isSeasonFinale` / `it.seasonFinaleAirDate`, so no badge changes for users. None of the removed local names (`dateBadge`, `airingMatch`, `effectiveAirDate`, ...) is still used in the three renderers. A 15-line duplicate scan of the file finds only the 15-line card-footer markup shared by the MDBList and Trakt renderers (the finding says to keep each renderer's own markup) plus the enrichment and details-page functions noted above, which are outside this finding. `tests/list-panel-badges.client.test.mjs` (16 tests): at the parent with only the test added, the "written once" check fails (15 pass, 1 fail; the behaviour tests pass there, which is right for a refactor). With the finale rule switched off in both helpers, 5 fail. The size baseline only went down (`renderMySimklLists` left it; the other two dropped to 166/171). `bash verify.sh -q`: passed, browser tests skipped (Playwright not installed). Verdict: verified fixed.

### CQ-04 Dead functions: code nothing in the product calls
- Severity: Low
- Status: Proven
- File:line:
  - Server, no caller anywhere (src, tests, tools, dev): `src/catalog/08_quickadd-chart-data.js:1587` `buildNuvioTvDefaultPreset` (a 1-line wrapper of `buildNuvioTvDefaultConfig`).
  - Server, called only by tests, never by the product: `src/core/02_http-and-creator-utils.js:1691` `clearSessionCache`; `:5794` `reconcileAccounts`; `src/data/29_media.js:444` `resolveMedia`; `src/data/39_activity-shelves.js:432` `watchHistoryPage` and `:493` `watchlistShelf`.
  - Server, only reachable through the test harness (`tests/harness.mjs:86` appends an extra `export const __engines`): `src/data/30_lists-backfill.js:949` `runListsBackfillStep`, `:1037` `listsBackfillStatus`; `src/data/37_activity-backfill.js:830` `activityBackfillStatus`.
  - Client, only called by tests: `src/client/21_client-custom-list-builder.js:3554` `getRemovedAiringNextShows`; `src/client/17_client-my-lists-and-trakt-oauth.js:4524` `mergeNuvioCollections` (107 lines; the live copy is the server twin at `src/api/61_media-app-sync.js:1447`, kept in step by `tests/server-client-parity.test.mjs:231`).
- What is wrong: These are declared but never used by any route, cron job, page script, `onclick` string or table. Because tests exercise them, the suite looks like it covers working features while the product never runs them (for example `watchlistShelf` and `watchHistoryPage` are tested in `tests/activity.test.mjs:798-818` but no route calls them).
- Impact: Maintenance cost and false confidence. Not a user-facing fault. The two shelf functions may be an unfinished feature rather than leftovers; that is a product decision, so I only flag them.
- Proof: `node s01/dead2.mjs /home/user/My-Lists-Addon ...` (comments stripped; word-count of every top-level name across all src) prints `top-level: 2308 zero/one-ref: 9` and the nine names above, each with `srcRefs: 1` (its own declaration). `grep -rnw <name> src` returns only the declaration for each. Client check: `node s01/dead3.mjs` (reads the rendered builder and admin pages, counts references in script text and in HTML attributes) prints `[{"label":"builder","name":"mergeNuvioCollections","line":9308,"size":107,"selfRefs":0},{"label":"builder","name":"getRemovedAiringNextShows","line":35039,"size":26,"selfRefs":0}]`. Dynamic use: none of the names appears in any string, `window[...]` lookup or route table in `src`.
- Recommended fix and effort: S. Delete `buildNuvioTvDefaultPreset`; decide per item whether the test-only ones are kept as test helpers (move them out of production) or removed. Do not delete the shelf functions before the owner confirms the feature is dropped.

**Verification.** `git show 2d4b89f`: `buildNuvioTvDefaultPreset` is deleted; `grep -rnw` finds no caller in `src`, `tests`, `tools`, nor on `origin/main` or `origin/feat/nuvio-tv-phase1` (declaration only), so the removal is safe and no merge will bring back a caller. `docs/HANDOFF.md` was updated to match. The other eight names in the finding still have only their declaration in `src` (each `grep -rnw <name> src` finds only the declaration, plus comment mentions for `getRemovedAiringNextShows` and `mergeNuvioCollections`). Those wait on an owner decision (keep as test helpers, move out of production, or drop the shelf feature), which the report itself asked for. Verdict: partially fixed, set back to `open` for the owner decision only; nothing further is needed from a coder until the owner decides.

### CQ-05 A limit is defined twice, server and client, with nothing linking the two
- Severity: Low
- Status: Proven
- File:line: `src/core/00_constants.js:560` and `src/client/20_client-channel-builder.js:10855` (`CHANNEL_POOL_MAX_ITEMS = 5000`); `src/catalog/05_catalog-core.js:3238-3239` and the client copy near `src/client/20_client-channel-builder.js:10920` (`CHANNEL_ROTATION_SHOWS_PER_DAY = 24`, `CHANNEL_ROTATION_EPISODES_PER_SHOW = 3`)
- What is wrong: The server and page scopes are separate, so the same number is typed in both. The comment at `00_constants.js:548-550` says "the two have to agree", but no test makes them agree.
- Impact: Someone changes one side and the builder page shows a different cap than the server enforces (for example "A channel holds at most 5,000" while the server stops at 4,000).
- Proof: In the scratch copy I changed `src/core/00_constants.js:560` to `4000`, ran `python3 build.py`, then `node --test tests/channel-preset.test.mjs tests/server-client-parity.test.mjs tests/design-system.test.mjs`: `# tests 301  # pass 297  # fail 0`. Nothing noticed.
- Recommended fix and effort: S. Either inject the server value into the page template, or add one parity assertion for these three constants to `tests/server-client-parity.test.mjs`.

**Verification.** `tests/channel-constants-parity.test.mjs` reads the server sources (core, catalog, api) and the client sources and requires each of the three constants to be declared exactly once on each side with the same number. In a scratch worktree: server `CHANNEL_POOL_MAX_ITEMS` 5000 -> 4000 gives `# fail 1`; client `CHANNEL_ROTATION_EPISODES_PER_SHOW` 3 -> 4 gives `# fail 1`; rewriting the server value as `5_000` (a form the regex does not read) also fails loudly ("declared exactly once, found 0") rather than passing silently. Nothing else changed in the commit. Verdict: verified fixed.

### CQ-06 AGENTS.md and CLAUDE.md disagree; AGENTS.md sends an AI to a variable that does not exist
- Severity: Low
- Status: Proven
- File:line: `AGENTS.md:56`
- What is wrong: AGENTS.md says "Release: bump `WORKER_RELEASE`". That constant does not exist: `src/core/00_constants.js:7,14` hold only `WORKER_BUILD_DATE` and `WORKER_BUILD`, both filled by `build.py`. CLAUDE.md correctly says there is no release number to bump. AGENTS.md also lacks CLAUDE.md's rules 6 to 12 (never loosen a test, ask only about product decisions, failing test first for bugs, mention unrelated dead code, state a short plan, the `<\/script>` rule).
- Impact: An agent that reads AGENTS.md (the file for Antigravity and Arena agents, per its own header) will hunt for or invent `WORKER_RELEASE` and skip the test and scope discipline the owner relies on.
- Proof: `grep -rn WORKER_RELEASE src tests tools` returns nothing; `grep -n "WORKER_BUILD" src/core/00_constants.js` returns lines 7 and 14 only. `grep -ci` of the phrases "failing test first", "Unrelated dead code", "short plan", "Never skip or loosen", "product decision" returns 1 in CLAUDE.md and 0 in AGENTS.md each.
- Recommended fix and effort: S. Fix line 56, and either point AGENTS.md at CLAUDE.md for rules or copy rules 6-12 across.

**Verification.** `git show c9da1f9`: `AGENTS.md:58` now says there is no release number to bump, matching `CLAUDE.md`, and a new line near the top sends every agent to `CLAUDE.md`'s hard rules and names rules 6-12. `grep -rn WORKER_RELEASE` outside the audit files finds only the test comment and a historical note in `docs/RELEASES.md`. `tests/agent-instructions.test.mjs` checks every `WORKER_*` name in both files exists in `src/core/00_constants.js`; at the parent commit `AGENTS.md` named `WORKER_RELEASE`, so it would fail there. Verdict: verified fixed.

### CQ-07 Hundreds of silent "catch and ignore" blocks
- Severity: Low
- Status: Proven (count); impact of any single one not proven
- File:line: spread across `src/` (examples `src/core/02_http-and-creator-utils.js:4988`); heaviest `src/client/22_client-creator-profile.js` (73), `src/client/17_client-my-lists-and-trakt-oauth.js` (63), `src/client/24_client-backup-restore-presets.js` (62), `src/catalog/07_source-fetchers-tmdb-simkl.js` (52)
- What is wrong: 669 empty `catch {}` / `catch (e) {}` blocks (server side: api 152, catalog 86, core 45, admin 28, page 6, data 4, jobs 3; the rest are client). A failed write to KV or D1, or a failed JSON parse, vanishes with no log.
- Impact: When something stops working (a list not saving, a cache not clearing) there is no trace to follow. Many are probably fine (best-effort cleanup); the problem is that a reader cannot tell which.
- Proof: `grep -rEo "catch *(\([a-z_]*\))? *\{ *\}" src/<dir> | wc -l` per folder; for example `src/core/02_http-and-creator-utils.js:4988` is `try { await env.CONFIGS.delete(...) } catch (e) {}`.
- Recommended fix and effort: M. Do not mass-edit. Add a one-line logging helper and use it only on server paths that write data.

### CQ-08 Over a hundred needless "is this function defined?" guards
- Severity: Info
- Status: Proven (noise only; I showed the tests would catch a rename)
- File:line: e.g. `src/core/04_config-resolution.js:107`, `src/core/02_http-and-creator-utils.js:1509`, `:2947`, `:3961`
- What is wrong: 103 places check `typeof someServerFunction === "function"` for functions that are always defined in the same shared scope. It looks like leftover from when files were separate.
- Impact: Misleading, and if a function were renamed the guard would silently skip the work instead of failing loudly.
- Proof: `node s01/guards.mjs /home/user/My-Lists-Addon` prints `guards on always-defined server top-level functions: 103`. Mutation: in the scratch copy I renamed `buildNuvioTvDefaultConfig` (`src/catalog/08_quickadd-chart-data.js:1518`), rebuilt, and ran the Nuvio tests: `# fail 7`. So today the tests would catch it; the guard still hides the failure at runtime.
- Recommended fix and effort: S/M. Remove gradually when a file is touched anyway; not worth a dedicated pass.

### CQ-09 Build order depends on file names, with no check for same-number collisions
- Severity: Info
- Status: Proven (design note)
- File:line: `build.py:46` (`sorted(glob.glob('src/*/[0-9][0-9]_*.js'), key=os.path.basename)`)
- What is wrong: Order is the file name sorted as text. Several files share a prefix (for example `17_client-my-lists-and-trakt-oauth.js` and `17_client-nuvio-mirror.js`), so which comes first is decided by the letters after the number. Any file in `src/` without the `NN_` pattern is silently ignored by the build.
- Impact: Low today. `find src -type f ! -name '[0-9][0-9]_*.js'` returns only `src/header.js`, and no two files share a base name. Renaming a file could change order without any warning, but the scope checker and tests would likely surface it.
- Recommended fix and effort: S. Optional: make `build.py` fail on a stray non-matching `.js` file in `src/*/`.

**Verification.** The table listed 49e1558, which only edits this report (it marks CQ-06). The stray-file half was already fixed by the OPS-01 work in e8eb925: `check_no_unlisted_sources()` (`build.py:42`) stops the build for any `.js` under `src/` that is not `src/header.js` or `src/<folder>/NN_name.js`. In a scratch copy, adding `src/core/extra.js` makes `python3 build.py` exit 1 and name the file, and `tests/build-source-names.test.mjs` passes (5) and covers the three-digit, unnumbered and nested cases. The other half of the finding (its title: no check for collisions) is still open. In the same scratch copy, adding `src/api/02_http-and-creator-utils.js` (the same file name as one in `src/core/`) builds with exit 0 and no warning; with `sorted(..., key=os.path.basename)` the order of the two depends on the order `glob` returns, which is file-system order, not anything in the repo. Shared number prefixes are normal (13 files start with `20_`) and are ordered by the rest of the name, which is fine. I also checked that `tests/sources.mjs` (`localeCompare`) and `build.py` (Python sort) give the same order for today's 50-odd files: they do. Edge case: a stray `src/core/10_x.mjs` is still ignored silently (only `.js` is checked); low risk. `bash verify.sh -q`: passed, browser tests skipped (Playwright not installed). Verdict: partially fixed, set back to `open`. Still wrong: `build.py` should refuse two source files with the same base name in different folders (a few lines in `check_no_unlisted_sources`, plus one case in `tests/build-source-names.test.mjs`). Severity stays Info.

## Unproven suspicions (not counted)
- Seen while fixing CQ-03 (370a8b1), not checked further: similar air-date and premiere/finale badge code also lives in `src/client/21_client-custom-list-builder.js` (~4389), `src/client/22_client-creator-profile.js` (~5353) and `src/client/23_client-list-management.js` (~2079), and the three `open*AiringNextDetailsPage` functions repeat the same `localMatch` lines (the CQ-03 reviewer noted these too). Not in CQ-03's scope; I did not compare them line by line.
- The 28 server functions over 150 lines (largest `fetchAutoTrackedCatalog` 466, `purgeCreatorData` 454, `fetchTmdbItemDetailsUncached` 392) are all in the baseline, so they are known debt, not new; I did not check whether any of them is hard to change in practice.
- `src/admin/59_support-emails.js:510` vs `:643` and `src/api/76_external-list-routes.js:373` vs `:496` repeat 23-28 line blocks. I saw the detector hits but did not read both copies to confirm they are logically identical.

## Unverified hunches (added by /fix-plan)
- `tests/preview-chart-limit.test.mjs` ("PERF-03: public chart previews do not spend the preview budget") failed once in a full `verify.sh -q` run and passed alone and on the next full run: possibly a timing flake under load. Not investigated.

## Checked and rejected
- Global-scope collisions across numbered files: none. Top-level declarations are unique in the server scope (2,308 names), in the builder page script (1,409) and in the admin page script (137). 17 names (for example `isAdultOrNsfw`, `getSafePosterUrl`, `CHART_SLUG_ENTRIES`) are declared in both the server scope and the page scope, which is legal because they are separate scopes (the page is a template string). Only the constants in CQ-05 are a drift risk.
- Dependencies: there is no `package.json`/`package-lock.json` in the repo (both are in `.gitignore`); `verify.sh:48-50` installs `acorn@8.14.0` and `eslint-scope@8.2.0` with `--no-save`, used only by test and check tooling, not by the Worker. `npm audit` on that pair: `found 0 vulnerabilities`. `npm outdated`: acorn 8.14.0 vs 8.19.0 latest, eslint-scope 8.2.0 vs 9.1.2 latest. Not a risk; the Worker itself has no runtime dependencies.
- `.claude/settings.json`: only denies reading `worker_entry_combined.js` and `node_modules/**`. Consistent with CLAUDE.md. Nothing unsafe.
- `buildNuvioTvDefaultConfig` guards (CQ-08) do not hide a real bug today.
- Size-budget test can fail: yes for server functions and for files (shown in CQ-01 with the server mutation). Only the client-function blind spot is a defect.

## Done well (do not change)
- Single shared scope with a scope checker (`tools/scope_check.mjs`) and zero duplicate declarations across 2,308 names.
- `build.py` is deterministic: it hashes the sources for the stamp, keeps the build date stable when the stamp has not changed, and refuses to build if the placeholders are not found exactly once.
- Size ratchet records existing debt by `file::name` rather than line number, so unrelated edits do not break it, and it fails on stale entries.
- Test-only access to internal functions is done through the harness rather than by exporting from production code.
- The `docs/FILE-INDEX.md` and `docs/FUNCTION-MAP.md` maps make the very large source files navigable.
- CI actions are pinned to full commit hashes.

## Not audited and why
- `docs/` audit files and anything claiming "fixed/verified": excluded by the brief.
- `worker_entry_combined.js`: generated and denied; I executed it only indirectly through tests and the rendered pages.
- Dev-server runtime behaviour was not needed for this section (the analysis works on source and on the rendered page script), so ports 8810/8811 were not used.
- Naming/formatting consistency was sampled, not exhaustively measured; I found no mixed-style evidence worth a finding.
