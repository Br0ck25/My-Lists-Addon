# Keep synced collection rows off the Nuvio home screen (2026-11-03)
Status: waiting for owner
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
2. Should Update Nuvio remember each collection's hide choice, so lists
   added later stay hidden too?
   *Recommended:* yes. It closes the gap above and needs no new control.
3. Should people be able to change the choice after syncing?
   *Recommended:* yes. Add the same toggle to the synced collection's edit
   window; it takes effect on the next Update Nuvio, and switching it off
   shows the rows again.
4. Default for new syncs: keep **off** (rows show, as today), or switch to
   **on**?
   *Recommended:* keep off and keep remembering the last choice. Changing the
   default would change the home screen for people who expect rows there.

## Approved plan
Not approved yet. Proposed (assuming the recommended answers):
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
## What was built
## How to try it
## Review
