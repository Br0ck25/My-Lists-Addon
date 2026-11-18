// "+ New Catalog" Add: ask the server whether the link(s) are a supported list
// source before saving the row, so a typo does not become a dead row on the TV
// home screen (audit PROD-02). Only a clear "not supported" answer blocks; a
// failed check (server down, offline) lets the row through as it always did.
async function addShelfLinksUnsupported(links) {
  try {
    const res = await creatorApiFetch(ORIGIN + '/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: links.join(String.fromCharCode(10)), validateOnly: true }),
      cache: 'no-store',
    });
    if (res.status !== 400) return '';
    const data = await res.json().catch(() => ({}));
    return String((data && data.error) || 'That URL is not a supported list source.');
  } catch (e) {
    return '';
  }
}

// True while the server is being asked, so a second tap on Add Catalog (the dialog
// stays open for the answer) does not add the row twice.
let addShelfCheckInFlight = false;

async function submitAddShelfChecked(name, links, type) {
  if (addShelfCheckInFlight) return;
  addShelfCheckInFlight = true;
  const btn = document.getElementById('addShelfModalBtn');
  const wasDisabled = btn ? btn.disabled : false;
  if (btn) btn.disabled = true;
  let problem;
  try {
    problem = await addShelfLinksUnsupported(links);
  } finally {
    addShelfCheckInFlight = false;
    if (btn) btn.disabled = wasDisabled;
  }
  if (problem) {
    showToast('Could not add the catalog. ' + problem, 'error');
    return;
  }
  if (links.length === 1) {
    addRow(name, links[0], type, true, 'Custom');
  } else {
    addCombinedRow(name, links, type, 'Custom');
  }
  document.getElementById('addShelfModal').style.display = 'none';
  saveState();
}
