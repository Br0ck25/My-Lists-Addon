## [AUDIT-FE-002] [P2] saveChannel allows duplicate publishing and local creation on rapid double-click

- **Area:** Frontend Async / Concurrency
- **Confidence:** HIGH (reproduced deterministically via automated probe)
- **Location:** `20_client-channel-builder.js:9172` (`saveChannel`), `13_tab-channels.js:352`

### Actual Behavior
`saveChannel()` is an async function that performs `await postChannelShare(payload, { publish: true })` at line 9252 before clearing `nameInput.value` and `channelDraftItems` (which happens at lines 9298-9301):
```javascript
async function saveChannel() {
  ...
  const signedInForShare = (typeof activeCreator !== 'undefined' && !!activeCreator);
  if (isPublic && signedInForShare) {
    try {
      const data = await postChannelShare(payload, { publish: true });
      if (data && data.ok) {
        payload.shareCode = data.code;
        payload.sharePublished = !!data.published;
        if (data.owner) payload.owner = data.owner;
        rememberChannelShare(channelId, data.code, !!data.published);
      }
    } catch (e) {}
  }
  ...
  saveLocalChannel(payload);
  ...
  channelDraftItems = [];
  nameInput.value = '';
}
```
The submit button (`#channelSaveBtn`) is neither disabled during the request nor guarded by `beginSubmit()`. When a user double-clicks or rapidly taps "Save", the second invocation enters `saveChannel()` before the first `await postChannelShare` resolves. Because `nameInput.value` and `channelDraftItems` have not yet been cleared, the second invocation passes all validations, mints a second unique `channelId` via `generateChannelId()`, and dispatches a second concurrent `POST /api/channel/share` request.

Both requests succeed, creating two separate channel records in D1, writing two separate episode pool manifests into R2, generating two different public share codes, and saving two separate channel records into `localStorage['localChannels']`.

### Expected Behavior (cite source)
Mutating button handlers must be idempotent against rapid clicks. Elsewhere in the frontend codebase, mutating operations are protected by `beginSubmit()` (see `21_client-custom-list-builder.js:593` for `saveCreatorListEdit`, `22_client-creator-profile.js:3932` for `createProfile`, and `22_client-creator-profile.js:1814` for `restoreProfile`):
```javascript
const endSubmit = beginSubmit('saveCreatorList', '#customListSaveBtn', 'Saving\u2026');
if (!endSubmit) return;
```
`saveChannel()` should similarly acquire an in-flight submission lock or disable `#channelSaveBtn` while saving.

### Why This Is Wrong
Accidental double-clicks create duplicate channel entries in D1, create duplicate episode pool blobs in R2, generate duplicate share links, and populate the user's Channel lineup with two identical channels.

### Evidence
Demonstrated deterministically in probe `probes/p07_frontend_state_async.mjs`:
```
✔ AUDIT-FE-002: saveChannel allows duplicate publishing and local creation on rapid double-click
```
Two concurrent calls send 2 distinct `/api/channel/share` POST requests and store 2 distinct channel entries in `loadLocalChannels()`.

### Reproduction (probe path)
`audit/full-2026-10-02/probes/p07_frontend_state_async.mjs` test 2.

### Negative Control
1. Sequential invocations of `saveChannel()` (where the second click occurs after the first completes) correctly halt on `if (!name) return;` because `nameInput.value` was cleared.
2. `saveCreatorListEdit()` in `21_client-custom-list-builder.js:593` properly rejects concurrent clicks using `beginSubmit()`.

### Root Cause
`saveChannel()` is an asynchronous function that lacks an in-flight lock, button disabling, or synchronous pre-dispatch state clearing.

### Impact
Medium severity (P2). Unintended duplicate publishing of channels in D1 and R2, and duplicate channel cards in the user's dashboard.

### Coverage Gap
Existing channel tests in `tests/client.test.mjs` and `tests/channel-pairing.test.mjs` tested sequential channel saves, but did not test concurrent/rapid double-click submissions.

### Fix Direction (nature only, do NOT implement)
Enclose `saveChannel()` in `beginSubmit('saveChannel', '#channelSaveBtn', 'Saving\u2026')` or immediately disable `#channelSaveBtn` upon invocation, releasing it in a `finally` block.

### Regression Test
Included in `audit/full-2026-10-02/probes/p07_frontend_state_async.mjs`.
