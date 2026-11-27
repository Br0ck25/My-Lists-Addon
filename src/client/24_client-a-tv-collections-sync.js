// My Lists TV: keep this account's collections on the server too, so the TV launcher can show them (see 86_tv-collections-routes.js).
// The collections live in this browser; this copies them to the account whenever they change, and once shortly after the page opens.

let tvCollectionsTimer = null;
let tvCollectionsSent = '';

async function pushTvCollections() {
  if (window._suppressCreatorSync) return;
  if (typeof activeCreator === 'undefined' || !activeCreator) return;
  const creatorKey = localStorage.getItem('myListAddon:creatorKey') || '';
  if (!creatorKey && !creatorKeyForgotten()) return;
  // Not before this browser has seen what the account holds, as for every other push.
  if (typeof creatorSyncGateOpen === 'function' && !creatorSyncGateOpen()) return;
  let folders = [];
  let groups = [];
  try { folders = JSON.parse(localStorage.getItem('myListAddon:customCollections') || '[]'); } catch (e) {}
  try { groups = JSON.parse(localStorage.getItem('myListAddon:collectionGroups') || '[]'); } catch (e) {}
  if (!Array.isArray(folders) || !folders.length) return;
  const body = JSON.stringify({ creatorName: activeCreator.creatorName, creatorKey: creatorKey, customCollections: folders, customCollectionGroups: Array.isArray(groups) ? groups : [] });
  if (body === tvCollectionsSent) return;
  try {
    const res = await creatorApiFetch(ORIGIN + '/api/creator/sync/save-collections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body });
    if (res && res.ok) tvCollectionsSent = body;
  } catch (e) {}
}
window.pushTvCollections = pushTvCollections;

function scheduleTvCollectionsPush(delayMs) {
  if (tvCollectionsTimer) clearTimeout(tvCollectionsTimer);
  tvCollectionsTimer = setTimeout(pushTvCollections, delayMs || 2500);
}

// Every save of the collections (an edit, a new folder, a cover picture) also schedules the copy.
if (typeof saveCustomCollections === 'function') {
  const saveCustomCollectionsOriginal = saveCustomCollections;
  saveCustomCollections = function () {
    const result = saveCustomCollectionsOriginal.apply(this, arguments);
    scheduleTvCollectionsPush();
    return result;
  };
}
scheduleTvCollectionsPush(8000);
