// Deleting one of your own lists (22_client-creator-profile.js).
//
//   * The delete is confirmed, then it can be undone for a few seconds, the way
//     removing a row already can (AI_UI_RULES: reversible deletes use an undo
//     toast). Undo saves the list back under the same address.
//   * The "this list was deleted" record that keeps a background sync from
//     bringing the list back used to be written before the server answered and
//     never taken back, so a delete the server refused left a 24 hour record
//     for a list that still exists, which blocked restoring or re-uploading it.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadClient, requestsTo } from "./client-harness.mjs";

const DELETED_KEY = "myListAddon:deletedCreatorLists";
const LIST = {
  slug: "abc", name: "My picks", type: "movie", visibility: "public", updatedAt: 111,
  items: [{ id: "tt0111161", title: "The Shawshank Redemption", type: "movie" }, { id: "tt0068646", title: "The Godfather", type: "movie" }],
};

function setup({ del = { ok: true }, save = { ok: true }, lists = [LIST] } = {}) {
  const c = loadClient({
    signedIn: "alice",
    routes: {
      "/api/creator/lists/delete": () => ({ json: del }),
      "/api/creator/lists/save": () => ({ json: save }),
    },
  });
  const toasts = [];
  c.set("showToast", (message, type, options) => { toasts.push({ message, type, options: options || {} }); return { dismiss() {} }; });
  c.set("showAppAlert", (title, message) => { toasts.push({ message: title + ": " + message, type: "alert", options: {} }); });
  c.set("renderCreatorDashboard", () => {});
  c.set("lastCreatorListsData", JSON.parse(JSON.stringify(lists)));
  const recorded = () => Object.keys(JSON.parse(c.localStorage.getItem(DELETED_KEY) || "{}"));
  return { c, toasts, recorded };
}

describe("deleting a list: the deletion record", () => {
  it("is kept when the server deleted the list", async () => {
    const { c, recorded } = setup();
    await c.call("deleteCreatorListConfirmed", "abc");
    assert.deepEqual(recorded(), ["abc"]);
  });

  it("is taken back when the server refused: the list still exists", async () => {
    const { c, recorded, toasts } = setup({ del: { ok: false, error: "Couldn't finish deleting that list." } });
    await c.call("deleteCreatorListConfirmed", "abc");
    assert.deepEqual(recorded(), []);
    assert.ok(toasts.some((t) => /Could not delete/.test(t.message)), "the person is told: " + JSON.stringify(toasts));
  });

  it("is taken back when the request never arrived", async () => {
    const c = loadClient({ signedIn: "alice", routes: { "/api/creator/lists/delete": () => { throw new Error("offline"); } } });
    c.set("showToast", () => ({ dismiss() {} }));
    c.set("showAppAlert", () => {});
    c.set("lastCreatorListsData", [LIST]);
    await c.call("deleteCreatorListConfirmed", "abc");
    assert.deepEqual(Object.keys(JSON.parse(c.localStorage.getItem(DELETED_KEY) || "{}")), []);
  });
});

describe("deleting a list: Undo", () => {
  it("offers Undo, naming the list", async () => {
    const { c, toasts } = setup();
    await c.call("deleteCreatorListConfirmed", "abc");
    const t = toasts.find((x) => x.options.actionText === "Undo");
    assert.ok(t, "an Undo toast: " + JSON.stringify(toasts));
    assert.match(t.message, /My picks/);
    assert.equal(typeof t.options.onAction, "function");
  });

  it("Undo saves the list back as it was, at the same address, and forgets the deletion", async () => {
    const { c, toasts, recorded } = setup();
    await c.call("deleteCreatorListConfirmed", "abc");
    assert.deepEqual(recorded(), ["abc"]);
    await toasts.find((x) => x.options.actionText === "Undo").options.onAction();
    const saves = requestsTo(c, "/api/creator/lists/save");
    assert.equal(saves.length, 1);
    const body = saves[0].body;
    assert.equal(body.slug, "abc", "the same address");
    assert.equal(body.name, "My picks");
    assert.equal(body.type, "movie");
    assert.equal(body.visibility, "public");
    assert.deepEqual(body.items, LIST.items);
    assert.equal(body.expectedUpdatedAt, undefined, "the list is gone; there is no version to cite");
    assert.deepEqual(recorded(), []);
    assert.ok(toasts.some((x) => x.type === "success" && /restored/.test(x.message)), JSON.stringify(toasts));
  });

  it("Undo the server refuses says so, and the list stays deleted", async () => {
    const { c, toasts, recorded } = setup({ save: { ok: false, error: "nope" } });
    await c.call("deleteCreatorListConfirmed", "abc");
    await toasts.find((x) => x.options.actionText === "Undo").options.onAction();
    assert.deepEqual(recorded(), ["abc"], "still recorded as deleted");
    assert.ok(toasts.some((x) => x.type === "error" && /Could not restore/.test(x.message)), JSON.stringify(toasts));
  });

  it("offers no Undo when the list's contents are not known (it could not be put back)", async () => {
    const { c, toasts } = setup({ lists: [] });
    await c.call("deleteCreatorListConfirmed", "abc");
    assert.ok(toasts.length > 0, "the person still hears it was deleted");
    assert.ok(!toasts.some((x) => x.options.actionText), JSON.stringify(toasts));
  });
});
