// P6-8: the page's controls no longer carry inline on*= handlers.
//
// Until P6-8 every button, select, checkbox and input in the builder UI called
// its function from an `onclick="fn(this)"` attribute -- about 470 of them,
// across 09_..24_. That is why script-src needs 'unsafe-inline', why arguments
// had to be escaped into a JavaScript string inside an HTML attribute (the
// shape getEntityEscapedAttributes exist to stop -- see escapeJsAttr in 19_),
// and why FE-2 filed the whole client as "hidden coupling": nothing tied a
// button to the function it calls.
//
// A control now names its action in data-act, passes its arguments as one JSON
// attribute (appActArgs, 16_), and a single delegated listener per event type
// runs it (appActDispatch, 16_). These tests guard both halves: that no inline
// handler came back, and that the dispatcher does what the inline handlers did
// -- innermost first, stopPropagation honoured, keydown gated to a key, "@self"
// and friends resolved, and a quote in a title still just a quote in a string.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadClient, renderPage } from "./client-harness.mjs";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 03_admin.js is the /admin page. It is not in this bundle (the builder page's
// markup comes from 09_..24_ only) and it does not load the bundle either --
// P6-10 gave it its own copy of this contract, covered by
// tests/admin-actions.test.mjs.
function clientSources() {
  return fs.readdirSync(REPO_ROOT)
    .filter((f) => /^[0-9][0-9]_/.test(f) && f !== "03_admin.js")
    .map((f) => ({ file: f, text: fs.readFileSync(path.join(REPO_ROOT, f), "utf8") }));
}

// Every inline handler left anywhere in the page's markup, scripts excluded --
// the markup is what the browser parses into attributes.
function markupHandlers(html) {
  const markup = html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, "");
  return (markup.match(/\son(?:click|change|input|keydown|keyup|keypress|submit|mouseover|mouseout|dblclick|error|load)=/gi) || []);
}

function dataActNames(html) {
  const markup = html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, "");
  const names = new Set();
  for (const m of markup.matchAll(/data-act(?:-then)?="([^"]+)"/g)) names.add(m[1]);
  return [...names].sort();
}

// A stub element carrying the attributes a delegated control would.
function control(attrs) {
  const el = { _attributes: {}, value: "", checked: false,
    setAttribute(k, v) { this._attributes[k] = String(v); },
    getAttribute(k) { const v = this._attributes[k]; return v === undefined ? null : v; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attributes, k); } };
  for (const [k, v] of Object.entries(attrs || {})) el._attributes[k] = String(v);
  return el;
}

function clickEvent(target, extra) {
  return Object.assign({ type: "click", target, defaultPrevented: false, stopped: false },
    { stopPropagation() { this.stopped = true; }, preventDefault() { this.defaultPrevented = true; } }, extra || {});
}

describe("P6-8: controls name their action instead of carrying one", () => {
  it("leaves no inline handler in any client source or in the rendered page", () => {
    for (const { file, text } of clientSources()) {
      // Whole-line comments are dropped: several of them quote the shape this
      // phase removed (19_'s escapeJsAttr note, 02_'s CSP note).
      const code = text.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      const found = code.match(/\son(?:click|change|input|keydown|keyup|keypress|submit|error|load|dblclick|mouseover|mouseout|mouseenter|mouseleave|mouseup|mousedown|focus|blur|scroll|paste|drop|dragover|dragstart|contextmenu|touchstart|touchend)\s*=/g) || [];
      assert.deepEqual(found, [], `${file} still carries ${found.length} inline handler(s)`);
    }
    assert.deepEqual(markupHandlers(renderPage()), [], "the legacy page has no inline handlers left");
    assert.deepEqual(markupHandlers(renderPage({ newUi: true })), [], "nor does the new UI shell page");
  });

  it("every data-act on the page names a function the client actually defines", () => {
    const client = loadClient();
    const names = dataActNames(renderPage());
    assert.ok(names.length > 100, `expected the page's controls to be named actions, found ${names.length}`);
    // window[name] is how appActDispatch resolves it: the bundle is a classic
    // script, so every action has to be a real global, not a block-scoped
    // helper that happens to be visible to the source scanner.
    const missing = names.filter((name) => typeof client[name] !== "function");
    assert.deepEqual(missing, [], "a renamed function would have been a dead button");
  });

  it("every literal data-act in the sources names a function too", () => {
    // The page only renders the static half; the other ~330 call sites build
    // their markup in JS strings, where a typo in a name is invisible until
    // somebody clicks it. appActDispatch warns once per unknown name, and this
    // is the audit that means it should never have to.
    const client = loadClient();
    const unknown = [];
    let seen = 0;
    for (const { file, text } of clientSources()) {
      for (const m of text.matchAll(/data-act(?:-then)?="([A-Za-z_$][\w$]*)"/g)) {
        seen++;
        if (typeof client[m[1]] !== "function") unknown.push(`${file}: ${m[1]}`);
      }
    }
    assert.ok(seen > 400, `expected the converted call sites here, found ${seen}`);
    assert.deepEqual(unknown, []);
  });

  it("escapes the arguments once, for both JSON and HTML, so a quote stays a quote", () => {
    const client = loadClient();
    const raw = client.call("appActArgs", ['Smith "Bob" & Co <tag>', 3, true, null, undefined, "it's"]);
    assert.equal(typeof raw, "string");
    // The attribute value a browser hands back is the unescaped text.
    const unescaped = raw.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    assert.deepEqual(JSON.parse(unescaped), ['Smith "Bob" & Co <tag>', 3, true, "", "", "it's"]);
    // Nothing in the attribute can end the attribute.
    assert.equal(/["'<>]/.test(raw), false, "an argument must never break out of the attribute");
  });

  it("reads the @-placeholders a call site writes", () => {
    const client = loadClient();
    const fnCalls = [];
    client.set("__p68Spy", function () { fnCalls.push([...arguments]); });
    const el = control({ "data-act": "__p68Spy", "data-act-args": '["@self","@checked","@value","@event","plain"]' });
    el.checked = true;
    el.value = "typed";
    const ev = clickEvent(el);
    assert.equal(client.call("appActDispatch", ev), true, "the control ran");
    assert.equal(fnCalls.length, 1);
    const [self, checked, value, event, plain] = fnCalls[0];
    assert.equal(self, el);
    assert.equal(checked, true);
    assert.equal(value, "typed");
    assert.equal(event, ev);
    assert.equal(plain, "plain");
  });

  it("runs the innermost control and stops there when it says so", () => {
    const client = loadClient();
    const calls = [];
    client.set("__p68Card", function () { calls.push("card"); });
    client.set("__p68Button", function () { calls.push("button"); });
    const card = control({ "data-act": "__p68Card" });
    const button = control({ "data-act": "__p68Button", "data-act-stop": "" });
    // The stub elements have no parentNode by default, so the walk is given one.
    button.parentNode = card;
    const ev = clickEvent(button);
    client.call("appActDispatch", ev);
    assert.deepEqual(calls, ["button"], "a stop inside a card is the whole point of data-act-stop");
    assert.equal(ev.stopped, true);

    calls.length = 0;
    const loose = control({ "data-act": "__p68Button" });
    loose.parentNode = card;
    client.call("appActDispatch", clickEvent(loose));
    assert.deepEqual(calls, ["button", "card"],
      "without a stop the card's own action runs too, the order two nested inline handlers ran in");
  });

  it("gates a keydown to the key the call site asked for, and honours data-act-then", () => {
    const client = loadClient();
    const calls = [];
    client.set("__p68OnEnter", function () { calls.push("enter"); });
    client.set("__p68After", function () { calls.push("then"); });
    const el = control({ "data-act": "__p68OnEnter", "data-act-keys": "Enter", "data-act-prevent": "", "data-act-then": "__p68After" });
    const other = clickEvent(el, { type: "keydown", key: "a" });
    assert.equal(client.call("appActDispatch", other), false);
    assert.deepEqual(calls, [], "any other key is not an Enter");
    const enter = clickEvent(el, { type: "keydown", key: "Enter" });
    assert.equal(client.call("appActDispatch", enter), true);
    assert.deepEqual(calls, ["enter", "then"], "data-act-then follows the call, with no arguments");
    assert.equal(enter.defaultPrevented, true);
    // And a plain click on the same control does nothing.
    calls.length = 0;
    assert.equal(client.call("appActDispatch", clickEvent(el)), false);
    assert.deepEqual(calls, []);
  });

  it("ignores a control whose function is gone instead of throwing", () => {
    const client = loadClient();
    const el = control({ "data-act": "__p68NotAFunction" });
    assert.equal(client.call("appActDispatch", clickEvent(el)), false);
    const argless = control({ "data-act-args": "[1]" });
    assert.equal(client.call("appActDispatch", clickEvent(argless)), false, "no data-act, nothing to run");
  });

  it("wires the listener once, for every event type a control uses", () => {
    const client = loadClient();
    assert.equal(client.get("APP_ACT_EVENT_TYPES").join(","), "click,change,input,keydown");
    assert.equal(client.call("initDelegatedActions"), false, "already bound at load");
    assert.equal(client.get("window._appActBound"), true);
  });
});
