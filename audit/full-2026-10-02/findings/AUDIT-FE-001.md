## [AUDIT-FE-001] [P2] appShellSignOut halts and preserves local account credentials and data on server or network error

- **Area:** Frontend State / User Switching / Security
- **Confidence:** HIGH (reproduced deterministically via automated probe)
- **Location:** `24_client-backup-restore-presets.js:3581-3594` (`appShellSignOut`)

### Actual Behavior
When `appShellSignOut()` calls `appShellApiFetch('/api/session', { method: 'DELETE' })`, if the network request fails (e.g. device is offline, server returns HTTP 500, or session was already expired/revoked returning non-200), `res.ok` evaluates to `false`. The function terminates immediately at line 3584:
```javascript
async function appShellSignOut() {
  const res = await appShellApiFetch('/api/session', { method: 'DELETE' });
  if (!res.ok) {
    showToast(res.error || 'Could not sign out just now.', 'error');
    return false;
  }
  if (typeof clearLocalAccountData === 'function') {
    try { clearLocalAccountData(); } catch (e) {}
  }
  appShellState.set({ account: null });
  showToast('Signed out.', 'success');
  await appShellRefreshSettingsHome();
  return true;
}
```
Because line 3585 returns early, `clearLocalAccountData()` is never called, and `appShellState.set({ account: null })` never executes. The user's account key, username, private lists, tracking data, and provider tokens remain active in `localStorage`, `sessionStorage`, and in-memory globals.

### Expected Behavior (cite source)
Per `docs/DECISIONS.md` D-8 and the explicit behavioral invariant documented in `22_client-creator-profile.js:1760-1764`:
> *"So the server's session is ended as well; a failure there (offline) still signs this browser out."*

A sign-out action must unconditionally clear the browser's local state, credentials, and memory, ensuring that user data does not remain accessible on shared or untrusted devices even if the network is disconnected or the backend fails.

### Why This Is Wrong
On shared, public, or mobile devices, if a user clicks "Sign out" during intermittent connectivity, offline usage, or backend degradation, the UI displays an error toast ("Could not sign out just now") and leaves the user's private lists, account key, and credentials fully loaded and actionable. A subsequent user of that device can view, modify, and delete the account holder's personal lists and access their account key.

### Evidence
Reproduced and proven via automated test suite in `probes/p07_frontend_state_async.mjs`:
```
✔ AUDIT-FE-001: appShellSignOut halts and preserves local credentials on network/server error
```
When `/api/session` returns status 500 or network error, `appShellSignOut()` returns `false`, `localStorage.getItem("myListAddon:creatorKey")` remains intact, and `activeCreator` remains populated in memory.

### Reproduction (probe path)
`audit/full-2026-10-02/probes/p07_frontend_state_async.mjs` test 1.

### Negative Control
In `22_client-creator-profile.js:1765-1783`, `switchCreatorProfile()` wraps the `/api/session` DELETE request in a `try/catch` and unconditionally invokes `clearLocalAccountData()`:
```javascript
async function switchCreatorProfile() {
  try {
    await fetch(ORIGIN + '/api/session', { ... });
  } catch (e) {}
  clearLocalAccountData();
  ...
}
```
Under identical network failure conditions, `switchCreatorProfile()` successfully and completely clears all local account data.

### Root Cause
`appShellSignOut()` placed `clearLocalAccountData()` and `appShellState.set({ account: null })` downstream of an early return guard on `!res.ok`, rather than running them unconditionally or in a `finally` block.

### Impact
Medium severity (P2). Defeats sign-out protection on shared devices when offline or during transient server issues, retaining sensitive credentials and private lists.

### Coverage Gap
Existing tests in `tests/client.test.mjs` only asserted `appShellSignOut` when `/api/session` responds with HTTP 200 OK.

### Fix Direction (nature only, do NOT implement)
Execute `clearLocalAccountData()` and `appShellState.set({ account: null })` unconditionally regardless of `res.ok`, or execute the session revocation in a non-blocking `try/catch` block matching `switchCreatorProfile()`.

### Regression Test
Included in `audit/full-2026-10-02/probes/p07_frontend_state_async.mjs`.
