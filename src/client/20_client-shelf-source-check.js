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

async function submitAddShelfChecked(name, links, type) {
  const problem = await addShelfLinksUnsupported(links);
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
