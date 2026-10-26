// The shutdown notice (openShutdownNotice / initShutdownNotice, 16_client-row-core.js).
//
// The public site closes on 2026-11-08 unless donations cover its costs, and
// every visitor -- signed in or not -- has to be told, with a way to donate and
// a way to take their data with them. These tests pin the parts that matter if
// the wording is ever touched: the closing date is in the text, the donate
// button points at Ko-fi, the backup button runs the same full backup the
// Settings tab does, and the notice shows once per browser session instead of
// on every page change.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadClient } from "./client-harness.mjs";

function setup(opts) {
  const c = loadClient(opts);
  c.get("location").hostname = (opts && opts.host) || "mylistsaddon.com";
  const shown = [];
  c.set("showModal", (html) => { shown.push(html); });
  c.get("sessionStorage").removeItem("myListAddon:shutdownNoticeSeen");
  return { c, shown };
}

describe("shutdown notice", () => {
  it("says when the site closes and what happens to people's lists", () => {
    const { c, shown } = setup();
    c.call("openShutdownNotice");
    assert.equal(shown.length, 1);
    assert.match(shown[0], /A Message About the Future of My Lists Addon/);
    assert.match(shown[0], /November 8, 2026/);
    assert.match(shown[0], /self-host/);
  });

  it("donate is a link to Ko-fi and backup runs the full backup download", () => {
    const { c, shown } = setup();
    c.call("openShutdownNotice");
    assert.match(shown[0], /<a href="https:\/\/ko-fi\.com\/mylistsaddon"[^>]*>Donate on Ko-fi<\/a>/);
    assert.match(shown[0], /<button type="button" class="btn-secondary" data-act="downloadConfigJson">Back up my data<\/button>/);
    // The button's action must be a real function, or the click does nothing.
    assert.equal(typeof c.get("downloadConfigJson"), "function");
  });

  it("shows once per session for a signed-out visitor", () => {
    const { c, shown } = setup();
    c.call("initShutdownNotice");
    c.call("initShutdownNotice");
    assert.equal(shown.length, 1);
  });

  it("never shows on a self-hosted copy, whose owner did not write it", () => {
    const { c, shown } = setup({ host: "lists.example.workers.dev" });
    c.call("initShutdownNotice");
    assert.equal(shown.length, 0);
  });

  it("shows for a signed-in visitor too, and again in a fresh session", () => {
    const { c, shown } = setup({ signedIn: true });
    c.call("initShutdownNotice");
    assert.equal(shown.length, 1);
    c.get("sessionStorage").removeItem("myListAddon:shutdownNoticeSeen");
    c.call("initShutdownNotice");
    assert.equal(shown.length, 2);
  });
});
