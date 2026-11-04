// Signing in, out or switching account in another tab reloads this one, so it
// does not keep showing (and acting as) the old account. The page only paints
// its header on load. A write of the same account name changes nothing here, so
// two tabs writing the key together cannot start a reload loop.
window.addEventListener('storage', function (e) {
  if (e.key !== 'myListAddon:creatorName' && e.key !== 'myListAddon:creatorKey') return;
  let stored = '';
  try { stored = localStorage.getItem('myListAddon:creatorName') || ''; } catch (err) { return; }
  const shown = (typeof activeCreator !== 'undefined' && activeCreator && activeCreator.creatorName) || '';
  if (stored !== shown) location.reload();
});
