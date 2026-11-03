// --- "Hide collection catalogs on Nuvio home", remembered per synced collection ---
//
// The choice used to apply to the first sync only: Update Nuvio sent nothing,
// so a list added to the collection later showed on the Nuvio home screen.
// Each collection group now keeps nuvioHomeHidden, and both Update Nuvio paths
// (17_client-my-lists-and-trakt-oauth.js) send it as hideHomeCatalogs.
//   * absent: no choice yet; updates leave Nuvio's home rows alone (as before);
//   * true:   every update hides this collection's rows, including new lists;
//   * false:  set only by turning the toggle off after it was on; updates show
//             the rows again.
// It lives on the group, not in nuvioLink, because every pull rebuilds nuvioLink.
// See docs/features/2026-11-03-nuvio-home-hide.md.

// The one stored shape of a collection group (load and save both use it).
function collectionGroupRecord(g) {
  return Object.assign({ id: g.id, name: g.name, remoteId: g.remoteId || g.id }, g.nuvioLink ? { nuvioLink: g.nuvioLink } : {},
    typeof g.nuvioHomeHidden === 'boolean' ? { nuvioHomeHidden: g.nuvioHomeHidden } : {});
}

// First sync: on is remembered; off clears any earlier choice, so later
// updates keep today's behaviour.
function rememberNuvioHomeChoice(group, hidden) {
  if (hidden === true) group.nuvioHomeHidden = true;
  else if (hidden === false) delete group.nuvioHomeHidden;
}

// Same wording and controls as the toggle in the Sync to Nuvio window.
function nuvioHomeToggleHtml(group) {
  if (!group || !group.nuvioLink) return '';
  return '<div class="settings-toggle-row u-mt-12px"><div class="u-flex-1 u-minw-0 u-pr-12px">' +
    '<label for="collectionGroupHideHome" class="u-fw-600 u-fs-v_font_size_base">Hide collection catalogs on Nuvio home</label>' +
    '<p id="collectionGroupHideHomeHint" class="u-m-4px_0_0 u-c-v_muted u-fs-v_font_size_sm">Applies the next time you press Update Nuvio, including lists you add later. Catalogs stay available in Catalogs &amp; Collections.</p></div>' +
    '<label class="ui-toggle" aria-label="Hide collection catalogs on Nuvio home"><input type="checkbox" id="collectionGroupHideHome" aria-describedby="collectionGroupHideHomeHint"' + (group.nuvioHomeHidden === true ? ' checked' : '') + '>' +
    '<span class="ui-toggle-slider"></span></label></div>';
}

// Edit collection: off is saved only after it was on, so collections nobody
// touched keep today's behaviour.
function applyNuvioHomeToggle(group) {
  const toggle = group && group.nuvioLink ? document.getElementById('collectionGroupHideHome') : null;
  if (toggle && (toggle.checked || group.nuvioHomeHidden === true)) group.nuvioHomeHidden = !!toggle.checked;
}

// Update and sync results: say so when Nuvio did not confirm the home rows.
function showNuvioPushToast(msg, res) {
  if (res && res.data && res.data.homeVisibilityUpdated === false) {
    showToast(msg + ' Home visibility could not be confirmed. Check Nuvio’s Catalogs & Collections settings.', 'info');
  } else {
    showToast(msg, 'success');
  }
}
