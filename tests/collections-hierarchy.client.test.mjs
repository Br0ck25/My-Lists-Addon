import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadClient } from "./client-harness.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
const folder = (id, name, extra = {}) => ({ id, name, lists: [{ name: "Saved list", url: "tmdb:chart:disney", type: "movie" }], ...extra });

describe("collections contain folders", () => {
  it("removes only the redundant Nuvio Collections panel", () => {
    const markup = readFileSync(new URL("../12_tab-custom-lists.js", import.meta.url), "utf8");
    assert.ok(!markup.includes('id="collectionsMediaAppsPanel"'));
    for (const action of ["syncCollectionsToNuvio", "pullCollectionsFromNuvio", "exportNuvioCollectionsJson", "openImportNuvioModal"]) assert.ok(markup.includes(action));
  });

  it("puts Discovery+ between Apple TV+ and Disney+ inside Streaming Services", () => {
    const client = loadClient();
    const premade = plain(client.call("getPremadeCollections"));
    assert.deepEqual(premade.slice(0, 3).map((c) => c.name), ["Apple TV+", "Discovery+", "Disney+"]);
    const groups = plain(client.call("groupCollectionFolders", premade));
    assert.equal(groups.length, 1);
    assert.equal(groups[0].name, "Streaming Services");
    assert.equal(groups[0].folders.length, 11);
    client.call("renderCollectionsView");
    for (const id of ["myCustomCollectionsResult", "premadeCollectionsResult"]) {
      const html = client.__byId.get(id).innerHTML;
      assert.match(html, /data-collection-group=/);
      assert.ok(html.indexOf("Streaming Services") < html.indexOf("Apple TV+"));
      assert.ok(html.indexOf("Apple TV+") < html.indexOf("Discovery+"));
      assert.ok(html.indexOf("Discovery+") < html.indexOf("Disney+"));
    }
  });

  it("groups old saved premades without restoring deleted lists or altering storage order", () => {
    const client = loadClient();
    const saved = [folder("col_appletv", "My Apple folder"), folder("col_disney", "Disney+", { lists: [] }), folder("col_discovery", "Discovery+"), folder("custom", "Favorites")];
    client.call("saveCustomCollections", saved);
    const loaded = plain(client.call("loadCustomCollections"));
    const groups = plain(client.call("groupCollectionFolders", loaded));
    assert.deepEqual(groups[0].folders.map((c) => c.id), ["col_appletv", "col_discovery", "col_disney"]);
    assert.deepEqual(groups[0].folders[2].lists, []);
    assert.equal(groups[0].folders[0].name, "My Apple folder");
    assert.equal(groups[1].name, "My Lists Collections");
    assert.deepEqual(plain(client.call("loadCustomCollections")).map((c) => c.id), saved.map((c) => c.id));
    client.call("saveCustomCollections", []);
    assert.deepEqual(plain(client.call("loadCustomCollections")), []);
  });

  it("preserves multiple parent names and IDs through JSON import and export", () => {
    const client = loadClient();
    const input = [
      { id: "col_mylists_services", title: "Streaming Services", folders: [{ id: "apple", title: "Apple TV+", catalogSources: [{ addonId: "app.my-list.collections", catalogId: "tmdb-chart-apple", type: "movie" }] }] },
      { id: "col_mylists_family", title: "Family", folders: [{ id: "kids", title: "Kids", catalogSources: [] }] }
    ];
    const parsed = plain(client.call("parseNuvioCollectionsJson", input));
    const result = plain(client.call("buildNuvioCollectionsPayload", parsed));
    assert.deepEqual(result.map((c) => [c.id, c.title, c.folders.map((f) => f.id)]), [["col_mylists_services", "Streaming Services", ["apple"]], ["col_mylists_family", "Family", ["kids"]]]);
  });

  it("creates a folder in its selected parent and retains that parent on edit", () => {
    const client = loadClient();
    client.call("saveCustomCollections", []);
    client.call("saveCollectionGroups", [{ id: "col_mylists_family", name: "Family" }]);
    client.call("openCreateCollectionModal", null, "col_mylists_family");
    client.__byId.get("createCollectionModalName").value = "Favorites";
    client.call("submitCreateCollectionModal");
    const saved = plain(client.call("loadCustomCollections"))[0];
    assert.equal(saved.parentCollectionId, "col_mylists_family");
    assert.equal(saved.parentCollectionName, "Family");
    client.call("openCreateCollectionModal", saved.id);
    client.__byId.get("createCollectionModalName").value = "Edited favorites";
    client.call("submitCreateCollectionModal");
    const result = plain(client.call("buildNuvioCollectionsPayload", client.call("loadCustomCollections")));
    assert.equal(result[0].title, "Family");
    assert.equal(result[0].folders[0].title, "Edited favorites");
  });

  it("keeps linked remote parents distinct even when their names match", async () => {
    const client = loadClient();
    client.call("saveCustomCollections", []);
    client.set("mediaAppUiCall", async () => ({ ok: true, data: { profileId: 1, scope: "account", collections: [
      { id: "col_mylists_one", title: "Same name", folders: [{ id: "folder", title: "One", catalogSources: [] }] },
      { id: "col_mylists_two", title: "Same name", folders: [{ id: "folder", title: "Two", catalogSources: [] }] }
    ] } }));
    await client.call("pullCollectionsFromNuvio");
    const saved = client.call("loadCustomCollections");
    const groups = plain(client.call("groupCollectionFolders", saved));
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map((g) => g.name), ["Same name", "Same name"]);
    const result = plain(client.call("buildNuvioCollectionsPayload", saved));
    assert.deepEqual(result.map((c) => [c.id, c.folders[0].id]), [["col_mylists_one", "folder"], ["col_mylists_two", "folder"]]);
  });

  it("imports repeated folder IDs under separate parents without losing edit targets", () => {
    const client = loadClient();
    client.call("saveCustomCollections", []);
    const input = [
      { id: "col_mylists_a", title: "Services", folders: [{ id: "same", title: "Apple", catalogSources: [] }] },
      { id: "col_mylists_b", title: "Family", folders: [{ id: "same", title: "Kids", catalogSources: [] }] }
    ];
    for (let i = 0; i < 2; i++) {
      client.document.getElementById("importNuvioJsonTextarea").value = JSON.stringify(input);
      client.call("submitImportNuvioModal");
    }
    const saved = plain(client.call("loadCustomCollections"));
    assert.equal(saved.length, 2, "re-import updates each folder rather than duplicating it");
    assert.notEqual(saved[0].id, saved[1].id, "edit and delete targets are unique locally");
    client.call("openCreateCollectionModal", saved[1].id);
    client.document.getElementById("createCollectionModalName").value = "Edited kids";
    client.call("submitCreateCollectionModal");
    const exported = plain(client.call("buildNuvioCollectionsPayload", client.call("loadCustomCollections")));
    assert.deepEqual(exported.map((c) => [c.title, c.folders[0].id, c.folders[0].title]), [["Services", "same", "Apple"], ["Family", "same", "Edited kids"]]);
  });

  it("exports unique parent IDs when linked profiles reuse the same remote ID", () => {
    const client = loadClient();
    const saved = [1, 2].map((profileId) => folder("local-" + profileId, "Folder " + profileId, { nuvioLink: { scope: "account", profileId, collectionId: "my-lists-collections", collectionName: "Profile " + profileId, folder: { id: "same-folder" } } }));
    const result = plain(client.call("buildNuvioCollectionsPayload", saved));
    assert.equal(result.length, 2);
    assert.notEqual(result[0].id, result[1].id);
    assert.deepEqual(result.map((c) => c.title), ["Profile 1", "Profile 2"]);
    assert.ok(result.every((c) => client.call("isMyListsNuvioCollectionId", c.id)));
  });

  it("escapes parent names and keeps linked folder membership locked while editing", () => {
    const client = loadClient();
    const linked = folder("linked", "Saved", { nuvioLink: { scope: "account", profileId: 1, collectionId: "col_mylists_parent", collectionName: '<img src=x onerror="evil()">', folder: { id: "remote-folder" } } });
    client.call("saveCustomCollections", [linked]);
    client.call("renderCustomCollections");
    const html = client.document.getElementById("myCustomCollectionsResult").innerHTML;
    assert.ok(!html.includes('<img src=x onerror="evil()">'));
    assert.ok(html.includes("&lt;img"));
    client.call("openCreateCollectionModal", linked.id);
    assert.equal(client.document.getElementById("createCollectionParentName").disabled, true);
    client.document.getElementById("createCollectionModalName").value = "Edited";
    client.call("submitCreateCollectionModal");
    assert.deepEqual(plain(client.call("loadCustomCollections"))[0].nuvioLink, linked.nuvioLink, "editing retains the original optimistic snapshot and remote target");
  });

  it("does not apply a single sync name to every parent in a multiple-collection push", () => {
    const client = loadClient();
    const incoming = [{ id: "col_mylists_a", title: "Streaming Services", folders: [] }, { id: "col_mylists_b", title: "Family", folders: [] }];
    const result = plain(client.call("addNewNuvioCollection", [], incoming, { collectionName: "My Lists Collections" }));
    assert.deepEqual(result.map((c) => c.title), ["Streaming Services", "Family"]);
  });
});

function emptyCollections(client) {
  client.localStorage.setItem('myListAddon:customCollections', '[]');
  client.localStorage.setItem('myListAddon:collectionGroups', '[]');
}
function createParent(client, name) {
  client.call('openCreateCollectionGroupModal');
  client.document.getElementById('collectionGroupName').value = name;
  client.call('submitCollectionGroupModal');
  return plain(client.call('loadCollectionGroups')).find(g => g.name === name);
}

describe('collection-first creation and whole premade collections', () => {
  it('creates and persists an empty collection before any folder exists', () => {
    const client = loadClient();
    emptyCollections(client);
    const parent = createParent(client, 'Family');
    assert.ok(parent.id);
    assert.deepEqual(plain(client.call('loadCustomCollections')), []);
    client.call('renderCustomCollections');
    const html = client.document.getElementById('myCustomCollectionsResult').innerHTML;
    assert.ok(html.includes('Family'));
    assert.ok(html.includes('0 folders'));
    assert.ok(html.includes('No folders yet'));
    assert.deepEqual(plain(client.call('buildNuvioCollectionsPayload')).map(c => [c.title, c.folders]), [['Family', []]]);
  });

  it('requires an existing collection for a folder and keeps it after the last folder is deleted', () => {
    const client = loadClient();
    emptyCollections(client);
    const parent = createParent(client, 'Family');
    client.call('openCreateCollectionModal', null, parent.id);
    assert.equal(client.document.getElementById('createCollectionParentName').value, parent.id);
    client.document.getElementById('createCollectionModalName').value = 'Kids';
    client.call('submitCreateCollectionModal');
    assert.equal(plain(client.call('loadCustomCollections'))[0].parentCollectionId, parent.id);
    client.call('saveCustomCollections', []);
    assert.equal(plain(client.call('loadCollectionGroups'))[0].id, parent.id);
    client.call('openCreateCollectionModal', null, parent.id);
    client.document.getElementById('createCollectionParentName').value = 'not-a-collection';
    client.document.getElementById('createCollectionModalName').value = 'Orphan';
    client.call('submitCreateCollectionModal');
    assert.deepEqual(plain(client.call('loadCustomCollections')), [], 'cannot silently create a parent by saving a folder');
  });

  it('adds Streaming Services and all eleven service folders with their lists in one action', () => {
    const client = loadClient();
    emptyCollections(client);
    client.call('renderPremadeCollections');
    const html = client.document.getElementById('premadeCollectionsResult').innerHTML;
    assert.ok(html.includes('data-act="addPremadeCollectionGroup"'));
    assert.ok(html.includes('Add collection to My Collections'));
    assert.ok(!html.includes('Your Folders'));
    client.call('addPremadeCollectionGroup', 'col_mylists_streaming_services');
    const groups = plain(client.call('loadCollectionGroups'));
    assert.equal(groups.length, 1);
    assert.equal(groups[0].name, 'Streaming Services');
    const folders = plain(client.call('loadCustomCollections'));
    assert.equal(folders.length, 11);
    assert.ok(folders.every(f => f.lists.length && f.parentCollectionId === groups[0].id));
    const result = plain(client.call('buildNuvioCollectionsPayload'));
    assert.deepEqual(result[0].folders.slice(0, 3).map(f => f.title), ['Apple TV+', 'Discovery+', 'Disney+']);
    folders[0].name = 'My edited Apple folder';
    folders[0].lists = [];
    client.call('saveCustomCollections', folders);
    client.call('addPremadeCollectionGroup', groups[0].id);
    assert.equal(plain(client.call('loadCustomCollections')).length, 11);
    assert.deepEqual(plain(client.call('loadCustomCollections'))[0].lists, [], 'adding again never restores deleted lists');
  });

  it('backs up and restores empty parent collections and imports empty Nuvio parents', () => {
    const client = loadClient();
    emptyCollections(client);
    createParent(client, 'Empty parent');
    const backup = plain(client.call('buildFullBackupPayload'));
    assert.equal(backup.customCollectionGroups[0].name, 'Empty parent');
    emptyCollections(client);
    client.call('applyImportedConfig', backup);
    assert.equal(plain(client.call('loadCollectionGroups'))[0].name, 'Empty parent');
    client.document.getElementById('importNuvioJsonTextarea').value = JSON.stringify([{ id: 'col_mylists_empty', title: 'Imported empty', folders: [] }]);
    client.call('submitImportNuvioModal');
    assert.ok(plain(client.call('buildNuvioCollectionsPayload')).some(c => c.id === 'col_mylists_empty' && c.title === 'Imported empty' && c.folders.length === 0));
  });

  it('uses collection creation at page level and folder creation only inside each collection', () => {
    const markup = readFileSync(new URL('../12_tab-custom-lists.js', import.meta.url), 'utf8');
    assert.ok(markup.includes('>My Collections</h2>'));
    assert.ok(markup.includes('data-act="openCreateCollectionGroupModal">+ Create collection'));
    assert.ok(!markup.includes('data-act="openCreateCollectionModal">+ Create folder'));
    assert.ok(!markup.includes('Your Folders'));
  });
});

describe('first-class collection safety', () => {
  it('copies whole premades without stealing or overwriting an identically named folder in another collection', () => {
    const client = loadClient();
    emptyCollections(client);
    const family = createParent(client, 'Family');
    const original = folder('col_appletv', 'Apple TV+', { parentCollectionId: family.id, parentCollectionName: family.name, lists: [] });
    client.call('saveCustomCollections', [original]);
    client.call('addPremadeCollectionGroup', 'col_mylists_streaming_services');
    const saved = plain(client.call('loadCustomCollections'));
    assert.equal(saved.length, 12);
    assert.deepEqual(saved[0].lists, []);
    assert.equal(saved[0].parentCollectionId, family.id);
    assert.equal(new Set(saved.map(f => f.id)).size, 12);
    const payload = plain(client.call('buildNuvioCollectionsPayload'));
    assert.equal(payload.find(c => c.title === 'Family').folders.length, 1);
    assert.equal(payload.find(c => c.title === 'Streaming Services').folders.length, 11);
    assert.equal(payload.find(c => c.title === 'Streaming Services').folders[0].title, 'Apple TV+');
  });

  it('renames and removes a collection as one local unit without deleting underlying lists', async () => {
    const client = loadClient();
    emptyCollections(client);
    const group = createParent(client, 'Family');
    const source = folder('favorites', 'Favorites', { parentCollectionId: group.id, parentCollectionName: group.name });
    client.call('saveCustomCollections', [source]);
    client.call('openCreateCollectionGroupModal', group.id);
    client.document.getElementById('collectionGroupName').value = 'Weekend';
    client.call('submitCollectionGroupModal');
    const payload = plain(client.call('buildNuvioCollectionsPayload'));
    assert.equal(payload[0].title, 'Weekend');
    assert.equal(payload[0].folders[0].title, 'Favorites');
    assert.deepEqual(plain(client.call('loadCustomCollections'))[0].lists, source.lists);
    const calls = [];
    client.set('appShellDialog', async () => true);
    client.set('mediaAppUiCall', async (...args) => { calls.push(args); return { ok: true }; });
    await client.call('deleteCollectionGroup', group.id);
    assert.deepEqual(plain(client.call('loadCollectionGroups')), []);
    assert.deepEqual(plain(client.call('loadCustomCollections')), []);
    assert.deepEqual(calls, [], 'removing the local collection never sends a Nuvio delete');
  });

  it('syncs an empty selected collection without sending other collections and forwards the explicit collection target', async () => {
    const client = loadClient();
    emptyCollections(client);
    const first = createParent(client, 'First');
    const second = createParent(client, 'Second');
    const posts = [];
    client.set('mediaAppUiCall', async (provider, sub, method, body) => {
      if (method === 'POST') posts.push(plain(body));
      return { ok: true, data: { collections: [], profiles: [] } };
    });
    await client.call('openSyncNuvioModal', null, second.id);
    assert.equal(client.document.getElementById('syncNuvioCollectionName').value, 'Second');
    await client.call('confirmSyncToNuvio');
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].collections.map(c => [c.id, c.title, c.folders]), [[second.id, 'Second', []]]);
    assert.deepEqual(posts[0].collectionLists, []);
    assert.ok(!JSON.stringify(posts[0].collections).includes(first.id));
  });

  it('restores older folder-only backups without retaining unrelated current empty parents', () => {
    const client = loadClient();
    emptyCollections(client);
    createParent(client, 'Old empty parent');
    client.call('applyImportedConfig', { entries: [], customCollections: [folder('legacy', 'Legacy favorites')] });
    const groups = plain(client.call('loadCollectionGroups'));
    assert.equal(groups.length, 1);
    assert.equal(groups[0].name, 'My Lists Collections');
    assert.equal(plain(client.call('loadCustomCollections'))[0].name, 'Legacy favorites');
  });
});

describe('collection expansion and Nuvio lifecycle', () => {
  const remoteParent = () => ({ id: 'community-parent', title: 'Remote collection', custom: { keep: true }, folders: [
    { id: 'one', title: 'One', customFolder: 'keep', hidden: true, catalogSources: [{ addonId: 'other', catalogId: 'one', type: 'movie', extra: 'keep' }] },
    { id: 'two', title: 'Two', catalogSources: [] }
  ] });
  async function pullParent(client, parent = remoteParent()) {
    emptyCollections(client);
    client.set('mediaAppUiCall', async () => ({ ok: true, data: { scope: 'account-scope', profileId: 1, collections: [parent] } }));
    await client.call('pullCollectionsFromNuvio');
    return plain(client.call('loadCollectionGroups'))[0];
  }

  it('persists collapse and expansion separately for My Collections and premade collections', () => {
    const client = loadClient();
    const group = plain(client.call('loadCollectionGroups'))[0];
    const element = { open: false, getAttribute: name => name === 'data-collection-group' ? group.id : 'custom' };
    client.call('rememberCollectionExpansion', element);
    client.call('renderCollectionsView');
    const custom = client.document.getElementById('myCustomCollectionsResult').innerHTML;
    const premade = client.document.getElementById('premadeCollectionsResult').innerHTML;
    assert.ok(!custom.match(/<details[^>]*\bopen(?:\s|>)/));
    assert.ok(premade.match(/<details[^>]*\bopen(?:\s|>)/));
    element.open = true;
    client.call('rememberCollectionExpansion', element);
    client.call('renderCustomCollections');
    assert.ok(client.document.getElementById('myCustomCollectionsResult').innerHTML.match(/<details[^>]*\bopen(?:\s|>)/));
  });

  it('pulls an entire Nuvio collection with a scoped parent snapshot, including third-party collections', async () => {
    const client = loadClient();
    const parent = remoteParent();
    const group = await pullParent(client, parent);
    assert.ok(group);
    assert.equal(group.nuvioLink.scope, 'account-scope');
    assert.equal(group.nuvioLink.profileId, 1);
    assert.deepEqual(group.nuvioLink.collection, parent);
    assert.equal(plain(client.call('loadCustomCollections')).length, 2);
    client.call('renderCustomCollections');
    const html = client.document.getElementById('myCustomCollectionsResult').innerHTML;
    assert.ok(html.includes('Update Nuvio'));
    assert.ok(html.includes('Delete from Nuvio'));
    assert.ok(html.includes('Remove local copy'));
    assert.deepEqual(plain(client.call('buildFullBackupPayload')).customCollectionGroups[0].nuvioLink.collection, parent);
  });

  it('updates one linked collection including renamed, removed, and added folders without losing foreign metadata', async () => {
    const client = loadClient();
    const parent = remoteParent();
    const group = await pullParent(client, parent);
    client.set('appShellDialog', async () => true);
    client.call('openCreateCollectionGroupModal', group.id);
    client.document.getElementById('collectionGroupName').value = 'Renamed here';
    client.call('submitCollectionGroupModal');
    const saved = plain(client.call('loadCustomCollections'));
    saved[0].name = 'Edited folder';
    const added = folder('local-new', 'New folder', { parentCollectionId: group.id, parentCollectionName: 'Renamed here', lists: [] });
    client.call('saveCustomCollections', [saved[0], added]);
    let sent;
    client.set('mediaAppUiCall', async (provider, sub, method, body) => {
      sent = plain(body);
      return { ok: true, data: { collections: [body.updatedCollection], profileId: 1, scope: 'account-scope' } };
    });
    await client.call('pushLinkedNuvioCollection', group.id);
    assert.equal(sent.installMode, 'update-collection');
    assert.equal(sent.targetCollectionId, parent.id);
    assert.equal(sent.scope, 'account-scope');
    assert.deepEqual(sent.expectedCollection, parent);
    assert.equal(sent.updatedCollection.title, 'Renamed here');
    assert.deepEqual(sent.updatedCollection.custom, { keep: true });
    assert.deepEqual(sent.updatedCollection.folders.map(f => f.id), ['one', 'local-new']);
    assert.equal(sent.updatedCollection.folders[0].customFolder, 'keep');
    assert.equal(sent.updatedCollection.folders[0].hidden, true);
    assert.equal(sent.updatedCollection.folders[0].catalogSources[0].extra, 'keep');
    assert.equal(plain(client.call('loadCollectionGroups'))[0].nuvioLink.collection.title, 'Renamed here');
  });

  it('deletes only from Nuvio after confirmation and keeps a detached local copy', async () => {
    const client = loadClient();
    const parent = remoteParent();
    const group = await pullParent(client, parent);
    let posts = 0;
    client.set('mediaAppUiCall', async (p, s, method, body) => { posts++; assert.equal(body.installMode, 'delete-collection'); assert.deepEqual(plain(body.expectedCollection), parent); return { ok: true, data: { collections: [] } }; });
    client.set('appShellDialog', async () => false);
    await client.call('deleteNuvioCollection', group.id);
    assert.equal(posts, 0);
    client.set('appShellDialog', async () => true);
    await client.call('deleteNuvioCollection', group.id);
    assert.equal(posts, 1);
    const local = plain(client.call('loadCollectionGroups'))[0];
    assert.equal(local.name, parent.title);
    assert.ok(!local.nuvioLink);
    const folders = plain(client.call('loadCustomCollections'));
    assert.equal(folders.length, 2);
    assert.ok(folders.every(f => !f.nuvioLink && f.parentCollectionId === local.id));
  });

  it('keeps all local edits and links when Nuvio rejects an update or deletion', async () => {
    const client = loadClient();
    const group = await pullParent(client);
    const before = plain(client.call('buildFullBackupPayload'));
    client.set('appShellDialog', async () => true);
    client.set('mediaAppUiCall', async () => ({ ok: false, status: 409, error: 'Changed remotely' }));
    await client.call('pushLinkedNuvioCollection', group.id);
    await client.call('deleteNuvioCollection', group.id);
    assert.deepEqual(plain(client.call('loadCollectionGroups')), before.customCollectionGroups);
    assert.deepEqual(plain(client.call('loadCustomCollections')), before.customCollections);
  });

  it('links a newly pushed entire collection to the actual server-assigned ID for later edits', async () => {
    const client = loadClient();
    emptyCollections(client);
    const group = createParent(client, 'New collection');
    const child = folder('child', 'Child', { parentCollectionId: group.id, parentCollectionName: group.name, lists: [] });
    client.call('saveCustomCollections', [child]);
    client.set('mediaAppUiCall', async (p, s, method, body) => method === 'GET' ? { ok: true, data: { collections: [] } } : ({ ok: true, data: { profileId: 1, scope: 'scope', writtenCollectionIds: ['col_mylists_actual'], collections: [{ ...plain(body.collections[0]), id: 'col_mylists_actual' }] } }));
    await client.call('executeNuvioCollectionsPush', { targetGroupId: group.id, installMode: 'new' });
    const linked = plain(client.call('loadCollectionGroups'))[0];
    assert.equal(linked.id, group.id);
    assert.equal(linked.nuvioLink.collectionId, 'col_mylists_actual');
    assert.equal(plain(client.call('loadCustomCollections'))[0].id, child.id);
    assert.equal(client.call('collectionHasLocalEdits', linked, client.call('loadCustomCollections')), false);
  });
  it('protects parent renames and deleted or new folders from automatic and manual pulls', async () => {
    for (const edit of ['name', 'delete', 'add']) {
      const client = loadClient();
      const parent = remoteParent();
      const group = await pullParent(client, parent);
      const folders = plain(client.call('loadCustomCollections'));
      if (edit === 'name') client.call('saveCollectionGroups', [{ ...group, name: 'My unsaved name' }]);
      if (edit === 'delete') client.call('saveCustomCollections', folders.slice(1));
      if (edit === 'add') client.call('saveCustomCollections', folders.concat(folder('new', 'New', { parentCollectionId: group.id, lists: [] })));
      const before = plain(client.call('buildFullBackupPayload'));
      assert.equal(client.call('collectionHasLocalEdits', client.call('loadCollectionGroups')[0], client.call('loadCustomCollections')), true);
      for (const automatic of [true, false]) {
        await client.call('pullCollectionsFromNuvio', automatic);
        assert.deepEqual(plain(client.call('loadCollectionGroups')), before.customCollectionGroups);
        assert.deepEqual(plain(client.call('loadCustomCollections')), before.customCollections);
      }
    }
  });

  it('keeps in-flight local edits while advancing the confirmed remote snapshot', async () => {
    const client = loadClient();
    const group = await pullParent(client);
    client.set('appShellDialog', async () => true);
    let resolve, started;
    const posted = new Promise(r => { started = r; });
    client.set('mediaAppUiCall', async (p, s, method, body) => {
      started(plain(body));
      return new Promise(r => { resolve = () => r({ ok: true, data: { collections: [plain(body.updatedCollection)] } }); });
    });
    const pending = client.call('pushLinkedNuvioCollection', group.id);
    const sent = await posted;
    client.call('saveCollectionGroups', [{ ...group, name: 'Edited during save' }]);
    const folders = plain(client.call('loadCustomCollections'));
    folders[0].name = 'Edited during save';
    client.call('saveCustomCollections', folders.slice(0, 1));
    resolve();
    await pending;
    const current = plain(client.call('loadCollectionGroups'))[0];
    assert.equal(current.name, 'Edited during save');
    assert.deepEqual(current.nuvioLink.collection, sent.updatedCollection);
    assert.equal(plain(client.call('loadCustomCollections'))[0].name, 'Edited during save');
    assert.equal(plain(client.call('loadCustomCollections')).length, 1);
    assert.equal(client.call('collectionHasLocalEdits', current, client.call('loadCustomCollections')), true);
  });

  it('uses the saved push name and matches the linked local parent on subsequent pulls', async () => {
    const client = loadClient();
    emptyCollections(client);
    const group = createParent(client, 'Local name');
    let saved;
    client.set('mediaAppUiCall', async (p, s, method, body) => {
      if (method === 'GET') return { ok: true, data: { profileId: 1, scope: 'scope', collections: saved ? [saved] : [] } };
      saved = { ...plain(body.collections[0]), id: 'col_mylists_actual', title: 'Chosen push name', name: 'Chosen push name' };
      return { ok: true, data: { profileId: 1, scope: 'scope', collections: [saved], writtenCollectionIds: [saved.id] } };
    });
    await client.call('executeNuvioCollectionsPush', { targetGroupId: group.id, installMode: 'new', collectionName: 'Chosen push name' });
    let current = plain(client.call('loadCollectionGroups'))[0];
    assert.equal(current.name, 'Chosen push name');
    assert.equal(client.call('collectionHasLocalEdits', current, client.call('loadCustomCollections')), false);
    await client.call('pullCollectionsFromNuvio');
    const parents = plain(client.call('loadCollectionGroups'));
    assert.equal(parents.length, 1);
    assert.equal(parents[0].id, group.id);
    assert.equal(parents[0].nuvioLink.collectionId, saved.id);
  });

  it('does not link a partial merge to a remote parent with unseen folders', async () => {
    const client = loadClient();
    emptyCollections(client);
    const group = createParent(client, 'Local');
    client.set('mediaAppUiCall', async () => ({ ok: true, data: { profileId: 1, scope: 'scope', writtenCollectionIds: ['remote'], collections: [{ id: 'remote', folders: [{ id: 'unseen', catalogSources: [] }] }] } }));
    await client.call('executeNuvioCollectionsPush', { targetGroupId: group.id, installMode: 'merge', targetRemoteCollectionId: 'remote' });
    assert.ok(!plain(client.call('loadCollectionGroups'))[0].nuvioLink);
  });

});
