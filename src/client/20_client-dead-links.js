// Addresses that name nothing. The page opens the list view for any /lists/<x>
// or /channels/<x> address, so a deleted share or a mistyped slug used to show
// a made-up channel or "Loading…" for ever. These send the person back to
// Discover with a message instead. Called from handleInitialDeepLink
// (24_client-backup-restore-presets.js); the flag is also what tests read.
function showDeepLinkNotFound(what) {
  const message = 'Could not find this ' + what + '. It may have been removed.';
  window._deepLinkNotFound = message;
  try { history.replaceState(null, '', '/'); } catch (e) {}
  try { switchTab('discover'); } catch (e) {}
  showAppNoticeModal('Could Not Find This ' + (what === 'channel' ? 'Channel' : 'List'), message, true);
}

// /channels/<user>/<slug> is a share address: the Worker redirects a live one,
// so a page that still sees one with no saved channel behind it is dead.
function deadChannelLink(path, foundChannel) {
  if (foundChannel || !new RegExp('^/channels/[^/]+/[^/]+').test(path)) return false;
  showDeepLinkNotFound('channel');
  return true;
}

// Called after every known /lists/ address has been tried. The app shell owns
// its own /lists/<sub-tab> routes, and #/list? links carry their own list.
function deadListLink(path, hash) {
  if (!path.startsWith('/lists/') || path.length < 8 || hash.startsWith('#/list?')) return false;
  if (typeof APP_SHELL_HEAD_ROUTES !== 'undefined' && APP_SHELL_HEAD_ROUTES[path]) return false;
  showDeepLinkNotFound('list');
  return true;
}
