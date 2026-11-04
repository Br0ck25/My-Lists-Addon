// UI-11: the heart buttons on list cards had no name a screen reader could say
// ("white heart suit, button"), and no sign of whether the list is liked; the
// media-server webhook address box was an unnamed text field.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import { loadClient } from "./client-harness.mjs";

function fakeButton(classes, attrs = {}) {
  const a = { ...attrs };
  return { classList: { contains: (c) => classes.includes(c) }, getAttribute: (k) => (k in a ? a[k] : null), setAttribute: (k, v) => { a[k] = String(v); }, attrs: a };
}

describe("like buttons", () => {
  it("get a name and a pressed state that follows the liked class", () => {
    const c = loadClient();
    const liked = fakeButton(["lc-btn", "searchLikeExternalBtn", "liked"]);
    const notLiked = fakeButton(["lc-btn", "searchLikeBtn"]);
    c.call("syncLikeButtonA11y", liked);
    c.call("syncLikeButtonA11y", notLiked);
    assert.equal(liked.attrs["aria-label"], "Like this list");
    assert.equal(liked.attrs["aria-pressed"], "true");
    assert.equal(notLiked.attrs["aria-pressed"], "false");
  });

  it("keep a name that is already there (the channel directory's own)", () => {
    const c = loadClient();
    const b = fakeButton(["searchLikeExternalBtn"], { "aria-label": "Like this channel" });
    c.call("syncLikeButtonA11y", b);
    assert.equal(b.attrs["aria-label"], "Like this channel");
  });

  it("the pressed state is re-read when the button's class changes", () => {
    const c = loadClient();
    const b = fakeButton(["searchLikeBtn"]);
    c.call("syncLikeButtonA11y", b);
    assert.equal(b.attrs["aria-pressed"], "false");
    b.classList.contains = (x) => x === "liked" || x === "searchLikeBtn";
    c.call("syncLikeButtonA11y", b);
    assert.equal(b.attrs["aria-pressed"], "true");
  });
});

describe("webhook address box", () => {
  it("has an accessible name", () => {
    const src = fs.readFileSync(new URL("../src/client/22_client-creator-profile.js", import.meta.url), "utf8");
    const tag = src.match(/<input[^>]*id="scrobbleWebhookInput"[^>]*>/)[0];
    assert.match(tag, /aria-label="Webhook address"/);
  });
});
