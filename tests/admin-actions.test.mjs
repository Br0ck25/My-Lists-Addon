// P6-10: the /admin dashboard's controls name their action instead of
// carrying one.
//
// The builder page lost its inline handlers in P6-8. The dashboard kept them
// -- 77 of them -- because /admin is its own document: it does not load the
// builder's bundle, so it could not use appActDispatch. It now carries its own
// copy of the same contract (adminActDispatch / adminActAttr, in its own
// script), and these tests hold both halves of it:
//
//   * nothing on either admin page (the dashboard and the sign-in page)
//     carries an on*= attribute, in the markup or in the strings the page's
//     own script builds, and
//   * every data-act name resolves to a function the page defines -- a renamed
//     action used to be a button that silently did nothing, exactly the
//     failure the inline handlers had, and
//   * the dispatcher behaves like the handlers it replaced: tag says which
//     event, data-act-on overrides it, data-act-keys gates a key, "@self" and
//     friends resolve, the innermost control runs first, and an action that
//     does not exist warns instead of throwing.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { call, createUser, makeEnv } from "./harness.mjs";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ADMIN_SRC = fs.readFileSync(path.join(REPO_ROOT, "03_admin.js"), "utf8");

// The dashboard, through the real request path: sign in, then ask for /admin.
// (Same helper tests/worker.test.mjs uses for every admin route.)
let _pages = null;
async function adminPages() {
  if (_pages) return _pages;
  const env = makeEnv({});
  const login = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
  const cookie = (login.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/);
  const dashboard = await call(env, "/admin", { cookie: cookie ? cookie[1] : "" });
  const dashboardHtml = dashboard.text;
  const signedOut = await call(env, "/admin");
  const signedOutHtml = signedOut.text;
  _pages = { dashboardHtml, signedOutHtml };
  return _pages;
}

// Every inline handler shape, whatever the event is called -- the builder page
// and the dashboard should have none of them, in the markup or in the strings
// the page's own script builds for itself.
function inlineHandlers(text) {
  return text.match(/\son[a-z]+\s*=\s*"/g) || [];
}

function scriptBlocks(html) {
  return [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

function pageScript(html) {
  const blocks = scriptBlocks(html).sort((a, b) => a.length - b.length);
  return blocks[blocks.length - 1] || "";
}

function actNames(text) {
  return [...new Set([...text.matchAll(/data-act(?:-then)?="([A-Za-z_$][\w$]*)"/g)].map((m) => m[1]))].sort();
}

function declaredFunctions(scriptText) {
  const names = new Set();
  for (const m of scriptText.matchAll(/(?:^|\s)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[1]);
  for (const m of scriptText.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/g)) names.add(m[1]);
  return names;
}

// --- the page's own script, run the way a browser would --------------------
//
// The biggest <script> block is the dashboard's whole client side. It is run
// here in a vm with a stub document: nothing in it fetches anything at load
// (restoreAdminActiveTab only reads localStorage and the querySelectorAll
// results), so the only stubs that matter are getElementById returning
// something harmless and addEventListener recording the listener.
function blackHole() {
  let proxy = null;
  const fn = function () { return proxy; };
  proxy = new Proxy(fn, {
    get(target, prop) {
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === "toString" || prop === "valueOf") return () => "";
      if (prop === "then") return undefined;
      if (prop === "length") return 0;
      return proxy;
    },
    set() { return true; },
    has() { return true; },
    apply() { return proxy; },
    construct() { return proxy; },
  });
  return proxy;
}

function loadAdminScript(scriptText) {
  const calls = [];
  const warnings = [];
  const listeners = {};
  const windowListeners = {};
  // The page binds on document (the delegated actions) and on window (its own
  // hashchange), so the two get their own recorders -- otherwise the listener
  // count below would be measuring both.
  const record = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
  const recordWindow = (type, fn) => { (windowListeners[type] = windowListeners[type] || []).push(fn); };
  const hole = blackHole();
  const sandbox = {
    console: { log: () => {}, warn: (m) => warnings.push(String(m)), error: () => {} },
    JSON, Math, Date, Object, Array, String, Number, Boolean, Promise, Error, Map, Set, RegExp,
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: () => new Promise(() => {}),
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { hash: "", href: "https://example.com/admin", pathname: "/admin" },
    alert: () => {}, confirm: () => true,
    addEventListener: recordWindow,
  };
  sandbox.document = {
    getElementById: () => hole,
    querySelector: () => hole,
    querySelectorAll: () => [],
    createElement: () => hole,
    body: hole,
    documentElement: hole,
    cookie: "",
    addEventListener: record,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(scriptText, sandbox, { filename: "admin-inline.js" });
  return {
    sandbox, calls, warnings, listeners, windowListeners,
    // Exactly what the page wires: dispatch through the listener it bound.
    fire(type, ev) {
      for (const fn of listeners[type] || []) fn(ev);
    },
  };
}

function control(attrs, tag) {
  const el = {
    tagName: tag || "BUTTON",
    _attributes: {},
    setAttribute(k, v) { this._attributes[k] = String(v); },
    getAttribute(k) {
      const v = this._attributes[k];
      return v === undefined ? null : v;
    },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attributes, k); },
  };
  for (const [k, v] of Object.entries(attrs || {})) el._attributes[k] = String(v);
  return el;
}

function event(type, target, extra) {
  return Object.assign({
    type, target, defaultPrevented: false, stopped: false,
    stopPropagation() { this.stopped = true; },
    preventDefault() { this.defaultPrevented = true; },
  }, extra || {});
}

describe("P6-10: the /admin dashboard names its actions", () => {
  it("carries no inline handler, in the markup or in the page's own strings", async () => {
    const { dashboardHtml, signedOutHtml } = await adminPages();
    assert.ok(dashboardHtml.length > 50000, "the dashboard rendered");
    assert.deepEqual(inlineHandlers(dashboardHtml), []);
    assert.deepEqual(inlineHandlers(signedOutHtml), []);
    // The source too: the markup the dashboard builds for itself lives in
    // strings inside 03_admin.js, where a reintroduced attribute would be
    // invisible to a check that only reads the rendered page.
    assert.deepEqual(inlineHandlers(ADMIN_SRC), []);
  });

  it("has no alert() left, and every message is the page's own dialog", () => {
    assert.deepEqual(ADMIN_SRC.match(/\balert\s*\(/g) || [], [],
      "P6-10 replaced the admin's alert() calls with showAdminAlert");
    assert.ok(ADMIN_SRC.includes("function showAdminAlert("), "and the dialog still exists");
  });

  it("gives every control an action the page itself defines", async () => {
    const { dashboardHtml } = await adminPages();
    const defined = declaredFunctions(scriptBlocks(dashboardHtml).join("\n"));
    const names = new Set([...actNames(dashboardHtml), ...actNames(ADMIN_SRC)]);
    assert.ok(names.size > 40, `expected the converted controls, found ${names.size}`);
    const missing = [...names].filter((name) => !defined.has(name));
    assert.deepEqual(missing, [], "a renamed function would have been a dead button");
    // The two the page builds at runtime from server data are in there too.
    for (const expected of ["switchAdminSubTab", "resetCreatorKey", "pickProviderId", "closeAdminModal"]) {
      assert.ok(names.has(expected), `${expected} is still a control's action`);
    }
  });

  it("writes a control's arguments as data, escaped once, on the server side", () => {
    // adminActArgs is the Worker-side half (used by renderAdminDashboard's own
    // markup); the page-side twin is adminActAttr, covered below.
    const sandbox = { console, URL, URLSearchParams, atob, btoa, Uint8Array, TextDecoder, TextEncoder, Response, Headers, Request, crypto: globalThis.crypto };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    for (const file of ["00_constants.js", "02_http-and-creator-utils.js", "03_admin.js"]) {
      vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, file), "utf8"), sandbox, { filename: file });
    }
    assert.equal(typeof sandbox.adminActArgs, "function");
    const raw = sandbox.adminActArgs(["O'Brien & Sons \"Best\" <b>", 3, true, null, undefined]);
    // Nothing in the attribute value can end the attribute.
    assert.equal(/["'<>]/.test(raw), false, "an argument must never break out of the attribute");
    // The browser hands the attribute back decoded; the array has to survive
    // that as data -- the FE-02 shape, one page over.
    const decoded = raw.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    assert.deepEqual(JSON.parse(decoded), ["O'Brien & Sons \"Best\" <b>", 3, true, "", ""]);
  });

  it("escapes the arguments of the markup it builds itself, the same way", async () => {
    const { dashboardHtml } = await adminPages();
    const page = loadAdminScript(pageScript(dashboardHtml));
    assert.equal(typeof page.sandbox.adminActAttr, "function");
    const raw = page.sandbox.adminActAttr(["a \"quote\" & <b>", 1]);
    assert.equal(/["'<>]/.test(raw), false);
    const decoded = raw.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    assert.deepEqual(JSON.parse(decoded), ["a \"quote\" & <b>", 1]);
  });

  it("runs the action a control names, with every argument resolved", async () => {
    const { dashboardHtml } = await adminPages();
    const page = loadAdminScript(pageScript(dashboardHtml));
    const seen = [];
    page.sandbox.__p610Spy = function () { seen.push([...arguments]); };

    const el = control({ "data-act": "__p610Spy", "data-act-args": '["@self","@checked","@value","@event","plain"]' }, "SELECT");
    el.checked = true;
    el.value = "typed";
    const ev = event("change", el);
    assert.equal(page.sandbox.adminActDispatch(ev), true, "the control ran");
    assert.equal(seen.length, 1);
    const [self, checked, value, gotEvent, plain] = seen[0];
    assert.equal(self, el);
    assert.equal(checked, true);
    assert.equal(value, "typed");
    assert.equal(gotEvent, ev);
    assert.equal(plain, "plain");
  });

  it("answers the event its tag says, and data-act-on overrides it", async () => {
    const { dashboardHtml } = await adminPages();
    const page = loadAdminScript(pageScript(dashboardHtml));
    const seen = [];
    page.sandbox.__p610Tag = function () { seen.push("tag"); };
    page.sandbox.__p610Typed = function () { seen.push("typed"); };

    // A select answers change, not click -- the 10 selects in this dashboard.
    const select = control({ "data-act": "__p610Tag" }, "SELECT");
    assert.equal(page.sandbox.adminActDispatch(event("click", select)), false);
    assert.deepEqual(seen, []);
    assert.equal(page.sandbox.adminActDispatch(event("change", select)), true);
    assert.deepEqual(seen, ["tag"]);

    // A button answers click, not change.
    seen.length = 0;
    const button = control({ "data-act": "__p610Tag" }, "BUTTON");
    assert.equal(page.sandbox.adminActDispatch(event("change", button)), false);
    assert.equal(page.sandbox.adminActDispatch(event("click", button)), true);
    assert.deepEqual(seen, ["tag"]);

    // An input that searches as you type says so -- otherwise it answers
    // change and never fires while someone types.
    const typing = control({ "data-act": "__p610Typed", "data-act-on": "input" }, "INPUT");
    assert.equal(page.sandbox.adminActDispatch(event("change", typing)), false,
      "an input answering both would run its handler twice");
    assert.equal(page.sandbox.adminActDispatch(event("input", typing)), true);
    assert.deepEqual(seen, ["tag", "typed"]);
  });

  it("gates a keydown to the key the control asked for, and prevents the default", async () => {
    const { dashboardHtml } = await adminPages();
    const page = loadAdminScript(pageScript(dashboardHtml));
    const seen = [];
    page.sandbox.__p610Enter = function () { seen.push("enter"); };

    // The provider-lookup box: Enter searches, typing does not.
    const input = control({ "data-act": "__p610Enter", "data-act-keys": "Enter", "data-act-prevent": "" }, "INPUT");
    const other = event("keydown", input, { key: "a" });
    assert.equal(page.sandbox.adminActDispatch(other), false);
    assert.deepEqual(seen, []);
    assert.equal(other.defaultPrevented, false);

    const enter = event("keydown", input, { key: "Enter" });
    assert.equal(page.sandbox.adminActDispatch(enter), true);
    assert.deepEqual(seen, ["enter"]);
    assert.equal(enter.defaultPrevented, true, "the inline handler called preventDefault");

    // And a plain click on that input does nothing.
    seen.length = 0;
    assert.equal(page.sandbox.adminActDispatch(event("click", input)), false);
    assert.deepEqual(seen, []);
  });

  it("runs the innermost control and stops there when it says so", async () => {
    const { dashboardHtml } = await adminPages();
    const page = loadAdminScript(pageScript(dashboardHtml));
    const seen = [];
    page.sandbox.__p610Card = function () { seen.push("card"); };
    page.sandbox.__p610Button = function () { seen.push("button"); };

    const card = control({ "data-act": "__p610Card" });
    const button = control({ "data-act": "__p610Button", "data-act-stop": "" });
    button.parentNode = card;
    const ev = event("click", button);
    page.sandbox.adminActDispatch(ev);
    assert.deepEqual(seen, ["button"], "a stop inside a card is the whole point of data-act-stop");
    assert.equal(ev.stopped, true);

    seen.length = 0;
    const loose = control({ "data-act": "__p610Button" });
    loose.parentNode = card;
    page.sandbox.adminActDispatch(event("click", loose));
    assert.deepEqual(seen, ["button", "card"],
      "without a stop the card's own action runs too, the order nested inline handlers ran in");
  });

  it("ignores a control whose action is gone instead of throwing", async () => {
    const { dashboardHtml } = await adminPages();
    const page = loadAdminScript(pageScript(dashboardHtml));
    const el = control({ "data-act": "__p610NotAFunction" });
    assert.equal(page.sandbox.adminActDispatch(event("click", el)), false);
    assert.equal(page.sandbox.adminActDispatch(event("click", el)), false);
    assert.deepEqual(page.warnings, ["Admin action not found: __p610NotAFunction"],
      "the console says which action failed, once per name");
    const argless = control({ "data-act-args": "[1]" });
    assert.equal(page.sandbox.adminActDispatch(event("click", argless)), false, "no data-act, nothing to run");
  });

  it("keeps a creator's own display name out of the markup, as data", async () => {
    // The one admin control whose arguments include text somebody else chose:
    // Reset Key, in Creator Accounts. Before P6-10 the row spliced displayName
    // into an onclick string; it is data now, escaped once, and the handler
    // reads it back off the element at click time.
    const env = makeEnv({});
    await createUser(env, "p610creator", { displayName: "O'Brien \"Best\" <script>alert(1)</script>" });
    const login = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
    const cookie = (login.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/);
    const html = (await call(env, "/admin", { cookie: cookie ? cookie[1] : "" })).text;

    assert.ok(html.includes('data-act="resetCreatorKey"'), "the button names its action");
    assert.ok(html.includes('data-act-args="[&quot;@self&quot;]'), "and takes the element it was clicked on");
    assert.equal(html.includes("onclick="), false, "with no handler string anywhere near the name");
    const row = html.slice(html.indexOf('data-act="resetCreatorKey"') - 200);
    assert.ok(row.includes("data-displayname=\"O&#39;Brien &quot;Best&quot; &lt;script&gt;"), "the name is escaped data");
    assert.equal(/<script>alert\(1\)<\/script>/.test(html), false, "and cannot become markup");
  });

  it("wires one listener per event type, once, and runs the action through it", async () => {
    const { dashboardHtml } = await adminPages();
    // A fresh script load records the listeners it binds; a second call to the
    // init has to be a no-op, or every control would run twice.
    const held = scriptBlocks(dashboardHtml);
    const index = held.indexOf(pageScript(dashboardHtml));
    const fresh = loadAdminScript(held[index]);
    assert.deepEqual(Object.keys(fresh.listeners).sort(), ["change", "click", "input", "keydown"]);
    for (const type of Object.keys(fresh.listeners)) {
      assert.equal(fresh.listeners[type].length, 1, `one ${type} listener`);
    }
    assert.equal(fresh.sandbox.window._adminActBound, true);
    assert.equal(fresh.sandbox.initAdminDelegatedActions(), false, "already bound at load");

    // And the wiring works: the click the document receives is what runs the
    // control, not a direct call to the dispatcher.
    const seen = [];
    fresh.sandbox.__p610Wired = function () { seen.push("wired"); };
    fresh.fire("click", event("click", control({ "data-act": "__p610Wired" })));
    assert.deepEqual(seen, ["wired"]);
  });
});
