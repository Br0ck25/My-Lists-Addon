// --- Forgetting the Account Key once the session holds the sign-in (SEC-03) ---------
//
// The Account Key used to stay in localStorage for good: a permanent password for
// any script or extension running on the page, or the next person on a shared
// computer. Behind FF_FORGET_KEY (off unless the server sends X-MLA-Forget-Key: 1
// next to X-MLA-Session), a browser that holds a working session stops keeping it:
//
//   * myListAddon:creatorKey is removed; the name stays, and myListAddon:keyForgotten
//     records the account, so the page starts signed in from the name plus the
//     session marker (myListAddon:sessionFor, 16_client-row-core.js).
//   * requests then carry the name and no key, and the HttpOnly session cookie
//     signs them (every account route accepts that: tests/session-only-routes.test.mjs).
//     Sessions renew while used, so a regular visitor never types the key again.
//   * when the session ends (30 days away, signed out, revoked) a request answers
//     401 and the existing sign-in prompt opens; the key is never resent.
//   * before the key is forgotten for the first time the person is told to keep it
//     somewhere safe (with the key on screen), and offered a recovery answer if
//     they have none. If they do not confirm, the key stays and they are asked
//     again on the next visit.
//   * where storage or cookies are blocked, creatorSessionHeldFor() is '' and
//     nothing changes.
//
// Plain strings are used inside the functions, not constants: activeCreator
// (16_client-row-core.js) calls creatorKeyForgottenFor while the page is still
// loading, before any constant declared in a later file exists.

var forgetKeyServerAllows = false;
var forgetKeyRunning = false;
var forgetKeyDeclined = false;
var creatorSessionEndedShown = false;

// The X-MLA-Session value of an answer (null when absent); also notes whether the
// server wants keys forgotten.
function readSessionHeaders(res) {
  const h = res && res.headers && typeof res.headers.get === 'function' ? res.headers : null;
  if (!h) return null;
  if (h.get('X-MLA-Forget-Key') === '1') forgetKeyServerAllows = true;
  return h.get('X-MLA-Session');
}

// True when this browser forgot the key for this account and still holds its session.
function creatorKeyForgottenFor(name) {
  try {
    const n = String(name || '').toLowerCase();
    return !!n && localStorage.getItem('myListAddon:keyForgotten') === n && localStorage.getItem('myListAddon:sessionFor') === n;
  } catch (e) {
    return false;
  }
}

// The same, for the account this browser is signed in as.
function creatorKeyForgotten() {
  try {
    return creatorKeyForgottenFor(localStorage.getItem('myListAddon:creatorName'));
  } catch (e) {
    return false;
  }
}

function forgetKeyNoticeMessage(key, hasRecoveryAnswer) {
  return 'Your Account Key is ' + key + '\\n\\nKeep it somewhere safe, like a password manager. This browser is about to stop storing it, ' +
    'so you stay signed in for as long as you keep using the site, and you will need the key to sign in again after that or on another device.' +
    (hasRecoveryAnswer ? '' : '\\n\\nYou have no recovery answer yet. Set one in Settings so you can get back in if you lose the key.');
}

// Called when the account has loaded (markCreatorSyncLoaded) and after every answer
// that carries the headers. Does nothing unless the server asked for it, a session is
// confirmed for this account, and the person has been told.
async function maybeForgetCreatorKey() {
  if (!forgetKeyServerAllows || forgetKeyRunning || forgetKeyDeclined) return;
  let name = '';
  let key = '';
  try {
    name = (localStorage.getItem('myListAddon:creatorName') || '').toLowerCase();
    key = localStorage.getItem('myListAddon:creatorKey') || '';
  } catch (e) {
    return;
  }
  if (!name || !key || creatorSessionHeldFor() !== name) return;
  forgetKeyRunning = true;
  try {
    const hasAnswer = localStorage.getItem('myListAddon:hasRecoveryAnswer') === '1';
    const confirmed = await appShellDialog({
      title: 'Keep your Account Key safe',
      message: forgetKeyNoticeMessage(key, hasAnswer),
      confirmLabel: 'I have saved it',
      cancelLabel: 'Not now',
    });
    if (!confirmed) {
      forgetKeyDeclined = true;
      return;
    }
    // The person may have signed out or switched account while the dialog was open.
    if ((localStorage.getItem('myListAddon:creatorName') || '').toLowerCase() !== name || creatorSessionHeldFor() !== name) return;
    localStorage.setItem('myListAddon:keyForgotten', name);
    localStorage.removeItem('myListAddon:creatorKey');
  } catch (e) {
    // Storage failed part-way: the key is removed only after the marker is written.
  } finally {
    forgetKeyRunning = false;
  }
}

// A request that carried no key (the key was forgotten) was refused: the session is
// gone. Show the existing sign-in prompt, with the username filled in.
function creatorSessionEnded() {
  if (creatorSessionEndedShown || !creatorKeyForgotten()) return;
  creatorSessionEndedShown = true;
  let name = '';
  try {
    name = localStorage.getItem('myListAddon:creatorName') || '';
    localStorage.removeItem('myListAddon:keyForgotten');
    localStorage.removeItem('myListAddon:sessionFor');
  } catch (e) {}
  activeCreator = null;
  if (typeof appShellState !== 'undefined' && appShellState && typeof appShellState.set === 'function') appShellState.set({ account: null });
  if (typeof renderCreatorProfileBar === 'function') renderCreatorProfileBar();
  if (typeof renderCreatorDashboard === 'function') renderCreatorDashboard();
  openRestoreModal();
  const nameInput = document.getElementById('restoreNameInput');
  if (nameInput) nameInput.value = name;
  showToast('You were signed out. Sign in with your Account Key.', 'info');
  setTimeout(function () { creatorSessionEndedShown = false; }, 5000);
}

// The two markers a forgotten-key browser signs in from, written again after
// clearLocalAccountData has wiped them (account reset on this or another device).
function rememberForgottenKey(name) {
  try {
    const n = String(name || '').toLowerCase();
    localStorage.setItem('myListAddon:keyForgotten', n);
    localStorage.setItem('myListAddon:sessionFor', n);
  } catch (e) {}
}
