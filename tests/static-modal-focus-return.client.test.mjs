// Audit UI-06: the fixed-markup dialogs (Create list, Select list, Add shelf,
// Import list/channel, Trakt device) trapped Tab and closed on Escape but left
// keyboard focus on the page body afterwards. Focus now goes back to the control
// that was focused before the dialog opened, whichever way it was closed.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadClient, fireListeners } from "./client-harness.mjs";

function opener() {
  return { focused: 0, focus() { this.focused++; } };
}

describe("UI-06: static dialogs give focus back", () => {
  it("restores focus to the opener when the dialog is hidden", () => {
    const client = loadClient();
    const btn = opener();
    fireListeners(client, { type: "focusin", target: btn });
    const modal = client.document.getElementById("createListModal");
    modal.style.display = "flex";
    client.call("syncStaticModalFocus");
    assert.equal(btn.focused, 0, "nothing is focused while the dialog is open");
    modal.style.display = "none";
    client.call("syncStaticModalFocus");
    assert.equal(btn.focused, 1);
  });

  it("uses the control focused before opening, not focus moved afterwards", () => {
    const client = loadClient();
    const btn = opener();
    const other = opener();
    fireListeners(client, { type: "focusin", target: btn });
    const modal = client.document.getElementById("selectListModal");
    modal.style.display = "flex";
    // The dialog's own code moves focus inside; a later focusin must not
    // replace the remembered opener once the dialog is visible.
    client.call("syncStaticModalFocus");
    fireListeners(client, { type: "focusin", target: other });
    modal.style.display = "none";
    client.call("syncStaticModalFocus");
    assert.equal(btn.focused, 1);
    assert.equal(other.focused, 0);
  });

  it("does nothing when no dialog was ever opened", () => {
    const client = loadClient();
    const btn = opener();
    fireListeners(client, { type: "focusin", target: btn });
    client.call("syncStaticModalFocus");
    assert.equal(btn.focused, 0);
  });
});
