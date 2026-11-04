// The channel builder's draft survives a reload (UI-04). The builder keeps its
// work in memory only, but its sub-tab is remembered, so a reload used to open
// an empty "Create a Custom Channel". This stores the draft in localStorage under
// the signed-in account's name, so one person's draft is never shown to another,
// and puts it back through the same setters the Edit button uses.
//
// Nothing in 20_client-channel-builder.js calls these: it only listens to the
// builder panel, and wraps saveChannel / cancelEditChannel / deleteLocalChannel
// so that finishing, cancelling or deleting drops the draft.

function channelDraftStorageKey() {
  return (typeof activeCreator !== 'undefined' && activeCreator && activeCreator.creatorName)
    ? 'myListAddon:channelDraft:' + activeCreator.creatorName : '';
}

function clearChannelDraft() {
  const key = channelDraftStorageKey();
  if (key) { try { localStorage.removeItem(key); } catch (e) {} }
}

// Stores what is on screen, or clears the draft when the builder is empty.
function saveChannelDraft() {
  const key = channelDraftStorageKey();
  if (!key) return;
  const nameInput = document.getElementById('channelNameInput');
  const name = nameInput ? nameInput.value : '';
  const settings = readChannelBroadcastSettings();
  if (!name.trim() && !channelDraftItems.length && !(settings.description || '').trim()) {
    clearChannelDraft();
    return;
  }
  const publicToggle = document.getElementById('channelPublicToggle');
  try {
    localStorage.setItem(key, JSON.stringify({
      v: 1,
      editingChannelId: editingChannelId || null,
      name: name,
      playOrder: getChannelPlayOrder(),
      poster: channelDraftPoster,
      backdrop: channelDraftBackdrop,
      isPublic: publicToggle ? !!publicToggle.checked : true,
      items: channelDraftItems,
      settings: settings,
    }));
  } catch (e) {}
}

// Reopens the builder from the stored draft. Only when the builder was the open
// sub-tab, and only for the signed-in account.
function restoreChannelDraft() {
  const key = channelDraftStorageKey();
  if (!key) return false;
  let draft = null;
  try {
    if (localStorage.getItem('myListAddon:channelsSubmenu') !== 'build') return false;
    draft = JSON.parse(localStorage.getItem(key) || 'null');
  } catch (e) { return false; }
  if (!draft || !Array.isArray(draft.items)) return false;
  const known = draft.editingChannelId && loadLocalChannels()[draft.editingChannelId];
  editingChannelId = known ? draft.editingChannelId : null;
  editingChannelUrlInput = null;
  resetChannelDraftWorkspace();
  channelDraftItems = draft.items.slice();
  channelDraftPoster = draft.poster || null;
  channelDraftBackdrop = draft.backdrop || null;
  const nameInput = document.getElementById('channelNameInput');
  if (nameInput) nameInput.value = draft.name || '';
  setChannelPlayOrder(draft.playOrder || 'as-listed');
  const channel = Object.assign({}, draft.settings || {}, {
    visibility: draft.isPublic === false ? 'private' : 'public',
    sharePublished: draft.isPublic !== false,
  });
  applyChannelBroadcastSettings(channel);
  renderChannelDraftList();
  updateChannelSaveButtonLabel();
  setChannelSearchType('tv', document.getElementById('channelSearchTypeShowsBtn'));
  switchChannelsSubmenu('build', null);
  return true;
}

(function wireChannelDraft() {
  // After the handler that changed something has run.
  function later() { setTimeout(saveChannelDraft, 400); }
  const panel = document.getElementById('channelsSubBuild');
  if (panel) {
    ['input', 'change', 'click', 'keyup', 'drop', 'pointerup'].forEach(function (type) {
      panel.addEventListener(type, later);
    });
  }
  // Finishing, cancelling or deleting ends the draft.
  const finishers = { saveChannel: true, cancelEditChannel: true };
  Object.keys(finishers).forEach(function (name) {
    const original = window[name];
    if (typeof original !== 'function') return;
    window[name] = async function () {
      try { return await original.apply(this, arguments); } finally { saveChannelDraft(); }
    };
  });
  const deleteOriginal = window.deleteLocalChannel;
  if (typeof deleteOriginal === 'function') {
    window.deleteLocalChannel = function (channelId) {
      if (channelId && channelId === editingChannelId) clearChannelDraft();
      return deleteOriginal.apply(this, arguments);
    };
  }
  // Once every script has loaded and the page knows who is signed in.
  setTimeout(restoreChannelDraft, 0);
})();
