// "Removed from Airing Next" panel on Settings -- the way back from the "x"
// on an Airing Next poster (removeAiringNextShow, 21_client-custom-list-
// builder.js).
//
// A removal undoes itself the moment another episode of the show is watched,
// so this panel is not the only route back. It is the route for the person
// who removed the wrong show, or changed their mind about one they are not
// currently watching -- without it, a show removed by mistake could only be
// recovered by watching an episode of it.
//
// Deliberately hidden entirely when nothing is removed: an empty panel
// explaining a feature nobody has used is noise on a Settings tab that
// already has a lot to read. One row per show (getRemovedAiringNextShows
// groups a show's two ids), and Restore clears every id of that row.
function renderRemovedAiringNextSettingsSection() {
  const box = document.getElementById('removedAiringNextSettingsSection');
  if (!box) return;
  const panel = box.closest('.panel');
  const rows = typeof getRemovedAiringNextShows === 'function' ? getRemovedAiringNextShows() : [];
  if (!rows.length) {
    box.innerHTML = '';
    if (panel) panel.style.display = 'none';
    return;
  }
  box.innerHTML = rows.map((r) =>
    '<div class="settings-toggle-row">' +
      '<span class="u-flex-1 u-minw-0 u-fw-600 u-fs-v_font_size_sm u-c-v_text u-overflowwrap-anywhere">' + escapeHtml(r.title) + '</span>' +
      '<button type="button" class="btn-secondary btn-sm" aria-label="' + escapeAttr('Restore ' + r.title + ' to Airing Next') + '"' +
        ' data-act="onRestoreAiringNextShow" data-act-args="' + appActArgs([r.showIds.join(','), r.title]) + '">Restore</button>' +
    '</div>'
  ).join('');
  if (panel) panel.style.display = '';
}

function onRestoreAiringNextShow(showIds, title) {
  restoreAiringNextShow(showIds);
  if (typeof showToast === 'function') showToast('"' + (title || 'The show') + '" is back on Airing Next.', 'success');
}
