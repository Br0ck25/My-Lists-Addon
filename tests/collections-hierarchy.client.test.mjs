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
