// The site notice (initSiteNotice / openSiteNotice, 16_client-row-core.js).
//
// The public site may close on 2026-11-08 unless donations cover its costs, and
// every visitor -- signed in or not -- has to be told, with a way to donate and
// a way to take their data with them. The owner edits the words, the buttons
// and the on/off switch in the admin (tests/site-notice.test.mjs); these tests
// pin what the page does with them: it asks the server, shows what comes back
// once per browser session, escapes what the admin typed, and never shows on a
// self-hosted copy.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadClient } from "./client-harness.mjs";

const NOTICE = {
  ok: true, enabled: true, title: "Hello <b>there</b>",
  body: "First paragraph.\n\n**Bold part** and <script>x</script>\nsecond line",
  showDonate: true, showBackup: true, showGuide: true, donateUrl: "https://ko-fi.com/mylistsaddon",
};

function setup({ host = "mylistsaddon.com", notice = NOTICE, signedIn = false } = {}) {
  const asked = [];
  const c = loadClient({
    signedIn,
    routes: { "/api/site-notice": () => { asked.push(1); return { json: notice }; } },
  });
  c.get("location").hostname = host;
  const shown = [];
  c.set("showModal", (html) => { shown.push(html); });
  c.get("sessionStorage").removeItem("myListAddon:shutdownNoticeSeen");
  return { c, shown, asked };
}

describe("site notice", () => {
  it("shows what the server sent, with the donate and backup buttons", async () => {
    const { c, shown } = setup();
    await c.call("initSiteNotice");
    assert.equal(shown.length, 1);
    assert.match(shown[0], /<a href="https:\/\/ko-fi\.com\/mylistsaddon"[^>]*>Donate on Ko-fi<\/a>/);
    assert.match(shown[0], /<button type="button" class="btn-secondary" data-act="downloadConfigJson">Back up my data<\/button>/);
    // The button's action must be a real function, or the click does nothing.
    assert.equal(typeof c.get("downloadConfigJson"), "function");
  });

  it("escapes what the admin typed and turns blank lines, newlines and **bold** into markup", async () => {
    const { c, shown } = setup();
    await c.call("initSiteNotice");
    assert.doesNotMatch(shown[0], /<script>/, "the admin's text is data, never markup");
    assert.match(shown[0], /Hello &lt;b&gt;there&lt;\/b&gt;/);
    assert.match(shown[0], /<p class="u-m-0">First paragraph\.<\/p>/);
    assert.match(shown[0], /<b>Bold part<\/b> and &lt;script&gt;x&lt;\/script&gt;<br>second line/);
  });

  it("leaves out the buttons and the guide link the admin turned off", async () => {
    const { c, shown } = setup({ notice: { ...NOTICE, showDonate: false, showBackup: false, showGuide: false } });
    await c.call("initSiteNotice");
    assert.equal(shown.length, 1);
    assert.doesNotMatch(shown[0], /Donate on Ko-fi|Back up my data|self-hosting guide/);
  });

  it("shows nothing when the admin has turned the notice off", async () => {
    const { c, shown } = setup({ notice: { ...NOTICE, enabled: false } });
    await c.call("initSiteNotice");
    assert.equal(shown.length, 0);
  });

  it("asks and shows once per session, signed out or in, and again in a fresh session", async () => {
    const out = setup();
    await out.c.call("initSiteNotice");
    await out.c.call("initSiteNotice");
    assert.equal(out.shown.length, 1);
    assert.equal(out.asked.length, 1, "the second visit in a session must not even ask the server");

    const inn = setup({ signedIn: true });
    await inn.c.call("initSiteNotice");
    assert.equal(inn.shown.length, 1);
    inn.c.get("sessionStorage").removeItem("myListAddon:shutdownNoticeSeen");
    await inn.c.call("initSiteNotice");
    assert.equal(inn.shown.length, 2);
  });

  it("never asks or shows on a self-hosted copy, whose owner did not write it", async () => {
    const { c, shown, asked } = setup({ host: "lists.example.workers.dev" });
    await c.call("initSiteNotice");
    assert.equal(shown.length, 0);
    assert.equal(asked.length, 0);
  });
});
