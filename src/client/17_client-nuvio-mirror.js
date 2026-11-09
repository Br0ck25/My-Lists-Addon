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

// Nuvio's own counts for the chosen profile, from its sync overview: ' Nuvio holds 42 library items, 150 in progress.'
function mediaAppOverviewText(o) {
  if (!o) return '';
  const parts = [];
  if (o.library != null) parts.push(o.library + (o.library === 1 ? ' library item' : ' library items'));
  if (o.progress != null) parts.push(o.progress + ' in progress');
  if (o.watched != null) parts.push(o.watched + ' watched');
  if (o.addons != null) parts.push(o.addons + (o.addons === 1 ? ' addon' : ' addons'));
  return parts.length ? ' Nuvio holds ' + parts.join(', ') + '.' : '';
}

// "Check home settings": what Nuvio holds under each home catalog platform, as one line each.
function mediaAppHomeCheckText(data) {
  const lines = [];
  const list = (data && data.platforms) || [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const name = p.platform + (p.platform === data.usedByThisSite ? ' (used by this site)' : '');
    if (p.error) { lines.push(p.platform + ': could not be read (' + p.error + ')'); continue; }
    const keys = Object.keys(p.keys || {});
    lines.push(keys.length ? name + ': ' + keys.map(function (k) { return k + ' ' + p.keys[k]; }).join(', ') : p.platform + ': nothing saved');
  }
  return lines.join(' · ');
}

async function checkNuvioHomeSettings(btn) {
  if (btn) btn.disabled = true;
  const r = await mediaAppUiCall('nuvio', 'home-settings-check', 'GET');
  if (btn) btn.disabled = false;
  const out = document.getElementById('nuvioHomeCheckResult');
  if (!r.ok) showToast(mediaAppUiMessage(r, 'Could not read your Nuvio home settings. Please try again.'), 'error');
  else if (out) out.textContent = mediaAppHomeCheckText(r.data);
}
