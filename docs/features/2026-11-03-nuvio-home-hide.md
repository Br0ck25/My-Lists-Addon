# Keep synced collection rows off the Nuvio home screen (2026-11-03)
Status: done
Model: claude-opus-5-5 (as configured for the session)

## Request
"when a user syncs collections to nuvio everything is installed correctly but
every catalog/list that is in the collection shows on the home screen of
nuvio. can we give the user a toggle to hide these on the home screen? the
lists/catalogs would still display in the catalogs & collections setting but
toggle would turn them to hidden"

## How it works today
- A toggle already exists: **Hide collection catalogs on Nuvio home**, in the
  **Sync to Nuvio** window (`src/page/09_page-shell.js:5579-5589`). It is
  **off by default**. The browser remembers the last choice
  (`myListAddon:nuvioHideCollectionCatalogs`,
  `src/client/17_client-my-lists-and-trakt-oauth.js:4744`).
- When it is on, the server marks each collection row as hidden in Nuvio's
  home settings, then reads them back to confirm
  (`nuvioCollectionHomeSettings`, `src/api/61_media-app-sync.js:1539`;
  used at lines 2030-2066). The rows stay in Catalogs & Collections.
- **Gap:** only the first push (add new, merge, replace) sends the choice.
  **Update Nuvio** on a collection (`update-collection`, client line ~3626)
  and on a folder (`update-folder`, `pushLinkedNuvioFolder`) do not send it.
  So a list added to a collection later, then pushed with Update Nuvio, gets
  Nuvio's default and shows on the home screen even if the person chose
  "hide".
- There is no way to change the choice after syncing except pushing the
  collection again as new.

## Questions and answers
1. Which matches what you saw? (a) the toggle was off or not noticed,
   (b) rows showed even with the toggle on at the first sync, (c) rows
   showed after adding lists and pressing Update Nuvio.
   *Recommended:* none, this is a fact question. (b) would be a separate bug
   to investigate before building.
   **Owner:** this was an old prompt used as an example; the toggle was known.
2. Should Update Nuvio remember each collection's hide choice, so lists
   added later stay hidden too?
   *Recommended:* yes. It closes the gap above and needs no new control.
   **Owner:** yes.
3. Should people be able to change the choice after syncing?
   *Recommended:* yes. Add the same toggle to the synced collection's edit
   window; it takes effect on the next Update Nuvio, and switching it off
   shows the rows again.
   **Owner:** yes.
4. Default for new syncs: keep **off** (rows show, as today), or switch to
   **on**?
   *Recommended:* keep off and keep remembering the last choice. Changing the
   default would change the home screen for people who expect rows there.
   **Owner:** keep off.

## Approved plan
Approved by the owner on 2026-11-03 (all recommendations accepted).
1. Save the hide choice with each synced collection when it is first pushed.
2. Update Nuvio (whole collection or one folder) sends the saved choice, so
   new lists follow it.
3. The synced collection's edit window gets the same toggle and wording.
4. Turning it off shows the rows again on the next Update Nuvio.
5. Collections synced before this change behave as today until the person
   sets the toggle once.
6. Nothing changes for Stremio, Wako or the regular My Lists home rows.
7. Tests: an update push with "hide" on marks a newly added list hidden; one
   with it off marks it shown.

## Before building
`bash verify.sh -q` at `446f349` (no source changes since): 3,250 tests, all
pass except the known cold-catalog p95 timing budget in
`tests/load-performance.test.mjs`.

## What was built
Commits:
- `663524c` server: `update-collection` applies the saved choice.
- `62ae38a` browser: each collection remembers the choice and both Update
  Nuvio paths send it; the toggle in Edit collection.

Files:
- `src/api/61_media-app-sync.js`: a whole-collection update now reads Nuvio
  home settings first when the request carries `hideHomeCatalogs` (nothing is
  written if that read fails), then sets only that collection's rows and
  confirms them. The save-and-confirm step became `nuvioSaveHomeVisibility`,
  shared with the first push. The boolean check now runs for every mode.
  `update-folder` already handled the choice; only the browser was not
  sending it.
- `src/client/17_client-nuvio-home-choice.js` (new, small, because the main
  client file is over the size limit): `collectionGroupRecord` (stored shape,
  now keeps `nuvioHomeHidden`), `rememberNuvioHomeChoice`,
  `nuvioHomeToggleHtml`, `applyNuvioHomeToggle`, `showNuvioPushToast`.
- `src/client/17_client-my-lists-and-trakt-oauth.js`: calls the above from
  load/save, the first sync, Edit collection, and both Update Nuvio paths.
  The file is 3 lines shorter; `tests/size-budget.json` lowered.
- Technical choice: the setting is stored on the collection group, not inside
  `nuvioLink`, because the automatic 2-minute pull rebuilds `nuvioLink`.
- Technical choice: "off" is stored only after the toggle was on. Collections
  nobody touched send nothing, so rows someone hid by hand inside Nuvio are
  not switched back on.

Tests added (each fails without the change; checked by reverting):
- `tests/media-app-sync.test.mjs`: whole-collection update hides/shows only
  that collection's rows; a non-boolean choice is refused before any write;
  nothing changes if home settings cannot be read; a single-folder update
  applies the choice to that folder's rows.
- `tests/collections-hierarchy.client.test.mjs`: untouched collections send
  no choice; the edit-window choice is saved, survives the automatic pull, is
  sent by both Update Nuvio paths, and can be turned off; the Sync to Nuvio
  choice is remembered; the toggle appears only on synced collections.

Checks: `bash verify.sh -q` after both commits: 3,258 tests, all pass except
the same known timing budget.

## How to try it
(After the new build is deployed. Use a test collection.)
1. Lists → Collections → create a collection with one folder and one list →
   **Push collection to Nuvio** → turn **Hide collection catalogs on Nuvio
   home** on → Add collection. → In Nuvio, the list is not on the home screen
   but is in Settings → Catalogs & Collections.
2. Add a second list to the folder → **Update Nuvio**. → The new list is also
   not on the Nuvio home screen. (Before this change it appeared.)
3. **Edit collection** on that collection. → The same toggle is there and is
   on. Turn it off → **Save** → **Update Nuvio**. → Both lists now show on
   the Nuvio home screen.
4. Turn it back on → **Save** → **Update Nuvio**. → Both are hidden again.
5. Check nothing else changed: a collection you synced before this update →
   **Update Nuvio** → its home rows look exactly as before. Your regular My
   Lists rows in Nuvio and Stremio are unchanged.

## Review
Reviewed 2026-11-03 by an independent session. **Verdict: approved.**

Checked: commits `663524c`, `62ae38a`, `43e9585` (sources, tests, docs; the
generated `worker_entry_combined.js` diff only by build). `43e9585` (Edit
collection button renamed "Save name" to "Save") is not listed under "What
was built"; it is a small, sensible follow-on to plan line 3 and the try-it
steps already use the new label.

Plan, line by line:
1. Done. `executeNuvioCollectionsPush` passes `homeHidden` to
   `linkSavedNuvioCollection` -> `rememberNuvioHomeChoice`
   (`src/client/17_client-my-lists-and-trakt-oauth.js:3545,5019`).
2. Done. `writeLinkedNuvioCollection` (line 3626) and `pushLinkedNuvioFolder`
   (line 4902) send `hideHomeCatalogs`. The server's `update-collection` now
   applies it to that collection's rows only (`src/api/61_media-app-sync.js`
   around line 1996); `update-folder` already did.
3. Done. `nuvioHomeToggleHtml` copies the Sync to Nuvio toggle's label and
   `.ui-toggle` markup. It appears only on synced collections.
4. Done. Off after on is stored as `false`, sent, and the server sets
   `enabled: true`.
5. Done. Groups with no stored choice send no `hideHomeCatalogs` (the key is
   left out), so the server leaves home settings alone. Saving the edit window
   with the toggle off on such a group stores nothing (`applyNuvioHomeToggle`).
6. Done. Server changes are inside the Nuvio collections route and touch only
   `app.my-list.collections` rows. The client changes are only in Nuvio paths.
   Stremio, Wako and the regular My Lists rows have no code changes. The
   existing test "leaves regular My Lists home preferences alone" still passes.
7. Done. `media-app-sync.test.mjs` "applies the collection's saved home-row
   choice..." covers hide and show, and checks another collection's row is
   untouched.

Older data: `groupCollectionFolders` copies every stored field, and every
`saveCollectionGroups` caller goes through `collectionGroupRecord`, so the
choice survives load, save and the 2-minute pull, which updates the group in
place. Backups include it (`24_client-backup-restore-presets.js:154`). Older
backups and stored groups without it load as "no choice".

Tests without the feature (HEAD tests run on `a47e845` in a scratch
worktree): 5 of 8 new tests fail. The other 3 pass, because each guards a
rule that held before the feature: untouched collections send no choice; the
toggle is hidden on unsynced collections; the server's single-folder update
(already worked). Each would still fail if that rule broke, so they are kept
as regression guards. The notes' claim that each test "fails without the
change" is therefore not exact. No test was skipped or loosened.

Checks: the two related test files, 160/160 pass. `bash verify.sh -q`:
3,258 tests, 3,252 pass, 5 todo. 1 fails: the known cold-catalog p95 timing
budget in `tests/load-performance.test.mjs`, as in "Before building".
No new routes. The size budget passes and its baselines were only lowered.

Worth knowing (not a defect, outside the plan): the choice is kept in this
browser's storage, like the collections themselves. Update Nuvio from a
different browser or device leaves home rows as Nuvio has them until the
toggle is set there too.
