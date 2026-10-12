// Three places drew status colours that fail the 4.5:1 contrast rule
// (AI_UI_RULES 9: never white text on --color-success / --color-danger; use the
// *-text tokens for coloured text).
//
//   * The channel logo URL errors were coloured with var(--err, #ff453a). --err
//     is defined nowhere, so the hex fallback (about 3.4:1 on white, with no
//     dark variant) was always what showed.
//   * The danger button of every confirmation dialog was white on --danger.
//   * The "Copied!" state of the install-link button was white on --success.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { loadClient } from "./client-harness.mjs";

const ROOT = new URL("../", import.meta.url);
const sources = () => readdirSync(ROOT).filter((f) => /^(header|\d\d_.*)\.js$/.test(f));

describe("error text on the channel logo URL", () => {
  function run(value) {
    const c = loadClient();
    const doc = c.get("document");
    doc.getElementById("channelPosterUrlInput").value = value;
    const status = doc.getElementById("channelPosterUrlStatus");
    c.call("applyChannelPosterUrl");
    return status;
  }
  for (const [label, value] of [["a malformed URL", "not a url"], ["a non-http URL", "ftp://example.com/logo.png"]]) {
    it("colours " + label + " with the danger text token", () => {
      const status = run(value);
      assert.ok(status.textContent.length > 0, "an error is shown");
      assert.equal(status.style.color, "var(--color-danger-text)");
    });
  }

  it("no source refers to the undefined --err variable", () => {
    const offenders = sources().filter((f) => /var\(--err\b/.test(readFileSync(new URL(f, ROOT), "utf8")));
    assert.deepEqual(offenders, []);
  });
});

describe("the danger button in a confirmation", () => {
  function confirmHtml(isDanger) {
    const c = loadClient();
    let html = "";
    c.set("showModal", (h) => { html = h; });
    c.call("showAppConfirm", "Delete it", "Sure?", "Delete", () => {}, isDanger);
    return html;
  }
  const confirmButton = (html) => html.match(/<button[^>]*id="appConfirmBtn"[^>]*>/)[0];

  it("pairs --color-danger-text with --color-text-inverse, not white on --danger", () => {
    const btn = confirmButton(confirmHtml(true));
    assert.match(btn, /background:\s*var\(--color-danger-text\)/);
    assert.match(btn, /color:\s*var\(--color-text-inverse\)/);
    assert.doesNotMatch(btn, /#fff|#ffffff|var\(--danger/i);
  });

  it("a non-destructive confirmation keeps the plain primary button", () => {
    const btn = confirmButton(confirmHtml(false));
    assert.match(btn, /class="primary"/);
    assert.doesNotMatch(btn, /danger/);
  });
});
