// Nuvio mirroring (settings): the toggle that makes deletions in Nuvio happen here
// too, and the button that puts removed plays back. The server rules are in
// src/api/61_nuvio-positions.js. The checkbox state is drawn with the other sync
// options in renderMediaAppStatus (17_client-my-lists-and-trakt-oauth.js).

async function saveNuvioMirror(on, box) {
  const r = await mediaAppUiCall('nuvio', 'settings', 'POST', { mirror: on });
  if (!r.ok) {
    if (box) box.checked = !on;
    showToast(mediaAppUiMessage(r, 'Could not save that setting. Please try again.'), 'error');
  }
  mediaAppUiRefresh('nuvio');
}

function setNuvioMirror(on, box) {
  if (!on) {
    saveNuvioMirror(false, box);
    return;
  }
  showAppConfirm(
    'Mirror Nuvio deletions?',
    'From now on, a watched title you delete in Nuvio is deleted here too. A play that another app also reported is kept. Anything removed can be restored here for 30 days.',
    'Turn on',
    function () { saveNuvioMirror(true, box); },
    false
  );
  // Cancelling leaves the box as it was.
  if (box) box.checked = false;
}

async function restoreNuvioRemoved(btn) {
  if (btn) btn.disabled = true;
  const r = await mediaAppUiCall('nuvio', 'restore-removed', 'POST', {});
  if (btn) btn.disabled = false;
  if (!r.ok) showToast(mediaAppUiMessage(r, 'Could not restore your plays. Please try again.'), 'error');
  else showToast(r.data.restored ? 'Restored ' + r.data.restored + (r.data.restored === 1 ? ' play.' : ' plays.') : 'Nothing to restore.', r.data.restored ? 'success' : 'info');
}
