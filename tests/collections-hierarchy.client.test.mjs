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
    client.call("openCreateCollectionModal", null, "col_mylists_family", "Family");
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
