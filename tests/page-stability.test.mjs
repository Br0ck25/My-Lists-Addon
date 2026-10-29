import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { call, makeEnv, makeD1, makeKv } from "./harness.mjs";

// Cloudflare's Web Vitals (2026-10-29): CLS "poor" on /catalogs and /lists.
// The HTML painted, then the app scripts drew the catalog rows and provider
// cards into it and everything below jumped (0.33 on /catalogs, 0.25 on
// /lists, measured in Chromium). The head script now keeps the view invisible
// (data-app-pending) until the frame after DOMContentLoaded, which waits for
// the app scripts, and shows it after 5 s whatever happens.

async function page(path) {
  const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
  return (await call(env, path)).text;
}

// The head script from the page, run with a fake document and clock.
function runHeadScript(html) {
  const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const head = scripts.find((s) => s.includes("data-app-pending"));
  assert.ok(head, "the head script sets data-app-pending");
  const attrs = new Map();
  const listeners = {};
  const timers = [];
  const frames = [];
  const el = { setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k), getAttribute: (k) => attrs.get(k), classList: { add() {}, toggle() {} } };
  const sandbox = {
    location: { pathname: "/catalogs", hash: "", search: "" },
    localStorage: { getItem: () => null, setItem() {} },
    matchMedia: () => ({ matches: false }),
    document: { documentElement: el, querySelector: () => null, addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); } },
    setTimeout: (f, ms) => timers.push({ f, ms }),
    requestAnimationFrame: (f) => frames.push(f),
  };
  sandbox.window = sandbox;
  vm.runInNewContext(head, sandbox);
  return { attrs, listeners, timers, frames };
}

describe("the view does not jump while the app scripts draw it", () => {
  it("hides the view, without taking it out of the layout, until the app has drawn it", async () => {
    const html = await page("/catalogs");
    const css = await page("/app.css");
    assert.match(css, /html\[data-app-pending\] \.tab-panel \{ visibility: hidden; \}/, "visibility, so the space is kept and nothing moves when it shows");
    const { attrs, listeners, frames } = runHeadScript(html);
    assert.equal(attrs.get("data-app-pending"), "1");
    for (const f of listeners.DOMContentLoaded || []) f();
    assert.equal(attrs.get("data-app-pending"), "1", "still hidden during DOMContentLoaded: the app's own handlers draw the view then");
    frames.forEach((f) => f());
    assert.equal(attrs.has("data-app-pending"), false, "shown in the next frame");
  });

  it("shows the view after 5 seconds even if the app scripts never load", async () => {
    const { attrs, timers } = runHeadScript(await page("/lists"));
    const failsafe = timers.find((t) => t.ms === 5000);
    assert.ok(failsafe, "a 5 s failsafe");
    failsafe.f();
    assert.equal(attrs.has("data-app-pending"), false);
  });

});
