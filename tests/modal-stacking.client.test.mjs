// UI-01 follow-up: the pop-up forms have no z-index of their own, so the one that
// is later in the page wins. A form opened while a dialog is open (the Trakt PIN
// form opens 500 ms after its "Trakt Connection" alert) must come up on top, so
// opening moves the form to the end of <body>.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadClient } from "./client-harness.mjs";

function fakeBody() {
  const moved = [];
  const body = { appendChild(el) { moved.push(el); }, moved };
  return body;
}

describe("static pop-up forms open above dialogs that are already open", () => {
  it("a form that is followed by another element is moved to the end", () => {
    const c = loadClient();
    const doc = c.get("document");
    doc.body = fakeBody();
    const form = { parentNode: doc.body, nextElementSibling: { id: "activeModalOverlay" }, contains: () => false };
    c.call("raiseStaticModal", form);
    assert.deepEqual(doc.body.moved, [form]);
  });

  it("a form still inside the page container is moved to the end of body even with nothing after it", () => {
    const c = loadClient();
    const doc = c.get("document");
    doc.body = fakeBody();
    const form = { parentNode: { id: "page" }, nextElementSibling: null, contains: () => false };
    c.call("raiseStaticModal", form);
    assert.deepEqual(doc.body.moved, [form]);
  });

  it("a form that is already last is left alone", () => {
    const c = loadClient();
    const doc = c.get("document");
    doc.body = fakeBody();
    const form = { parentNode: doc.body, nextElementSibling: null, contains: () => false };
    c.call("raiseStaticModal", form);
    assert.deepEqual(doc.body.moved, []);
  });

  it("the nine forms are the ones watched", () => {
    const ids = loadClient().get("STATIC_MODAL_IDS");
    assert.deepEqual([...ids].sort(), ["addShelfModal", "createCollectionModal", "createListModal", "importChannelModal", "importListModal", "importNuvioCollectionsModal", "selectListModal", "syncNuvioModal", "traktDeviceModal"]);
  });
});
