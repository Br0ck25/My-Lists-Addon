// Addresses that name nothing. The page opens the list view for any /lists/<x>
// or /channels/<x> address, so a deleted share or a mistyped slug used to show
// a made-up channel or "Loading…" for ever. These send the person back to
// Discover with a message instead. Called from handleInitialDeepLink
// (24_client-backup-restore-presets.js); the flag is also what tests read.
function showDeepLinkNotFound(what) {
  // A channel share address is known to be dead. A /lists/ address the page does
  // not recognise may be a list the person still has, so it is not called removed.
  const message = what === 'channel'
    ? 'Could not find this channel. It may have been removed.'
    : 'Could not open this list from its address. Open it from Catalogs or Lists instead.';
  window._deepLinkNotFound = message;
  try { history.replaceState(null, '', '/'); } catch (e) {}
  try { switchTab('discover'); } catch (e) {}
  showAppNoticeModal(what === 'channel' ? 'Could Not Find This Channel' : 'Could Not Open This List', message, true);
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
// Airing Next is a list the app writes into the address bar (getListCleanPath).
function unknownListLink(path, hash) {
  if (!path.startsWith('/lists/') || path.length < 8 || hash.startsWith('#/list?')) return false;
  if (typeof APP_SHELL_HEAD_ROUTES !== 'undefined' && APP_SHELL_HEAD_ROUTES[path]) return false;
  if (path.split('/').length === 3 && path.split('/')[2] === 'airing-next') {
    openListDetailsPage('Airing Next', 'series', 'autotrack:airing-next', null, { skipPushState: true });
    return true;
  }
  showDeepLinkNotFound('list');
  return true;
}
