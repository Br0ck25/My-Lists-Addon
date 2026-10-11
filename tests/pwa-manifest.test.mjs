import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, call } from "./harness.mjs";

// The installed app must open at the site root and stay inside it, with a name
// and description the OS install prompt can show, and an icon the browser
// accepts for installability (at least 192px). iOS ignores the manifest icon,
// so the page itself must point at an apple-touch-icon.
describe("PWA manifest", () => {
  it("declares identity, scope and a usable icon", async () => {
    const res = await call(makeEnv(), "/app.webmanifest");
    assert.equal(res.status, 200);
    const m = JSON.parse(res.text);
    assert.equal(m.id, "/");
    assert.equal(m.scope, "/");
    assert.equal(m.start_url, "/");
    assert.equal(m.display, "standalone");
    assert.ok(m.description && m.description.length > 20, "description for the install prompt");
    assert.ok(m.icons.some((i) => parseInt(i.sizes, 10) >= 192 && i.type === "image/png"));
  });

  it("the page links an apple-touch-icon for iOS home screens", async () => {
    const res = await call(makeEnv(), "/");
    assert.match(res.text, /<link rel="apple-touch-icon" href="[^"]*\/icon\.png">/);
  });
});
