// Settings > Support: "Delete chat history" (16_client-row-core.js).
//
// It is confirmed first (it cannot be undone: the threads are removed on the
// server too), sends this device's thread ids plus the account name AND key
// when signed in, and only forgets the threads on the page once the server said
// they are gone. A refused or failed delete leaves the chat exactly as it was.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadClient, requestsTo } from "./client-harness.mjs";

const IDS_KEY = "myListAddon:feedbackThreadIds";
const THREAD = { id: "t1", category: "bug", message: "hi", messages: [{ id: "m1", sender: "user", text: "hi", timestamp: 1 }] };

function setup({ reply = { ok: true, deleted: 1 }, signedIn = "alice" } = {}) {
  const c = loadClient({
    signedIn,
    storage: { [IDS_KEY]: JSON.stringify(["t1", "t2"]) },
    routes: { "/api/feedback/delete": () => ({ json: reply }) },
  });
  const messages = [];
  c.set("showToast", (message) => { messages.push(message); return { dismiss() {} }; });
  c.set("showAppAlert", (title, message) => { messages.push(title + ": " + message); });
  let confirmed = null;
  // The confirmation is shown, not answered: the test presses the button itself.
  c.set("showAppConfirm", (title, message, button, onConfirm) => { confirmed = { title, message, button, onConfirm }; });
  c.set("userFeedbackThreads", [THREAD]);
  c.set("activeFeedbackThreadId", "t1");
  const ids = () => JSON.parse(c.localStorage.getItem(IDS_KEY) || "[]");
  return { c, messages, ids, confirmed: () => confirmed };
}

describe("Delete chat history", () => {
  it("asks first and sends nothing until it is confirmed", () => {
    const { c, confirmed } = setup();
    c.call("deleteUserFeedbackHistory");
    assert.ok(confirmed(), "a confirmation is shown");
    assert.match(confirmed().message, /cannot be undone/i);
    assert.equal(requestsTo(c, "/api/feedback/delete").length, 0);
  });

  it("sends this device's thread ids with the account name and key, then clears the chat", async () => {
    const { c, ids, confirmed } = setup();
    c.call("deleteUserFeedbackHistory");
    await confirmed().onConfirm();
    const [req] = requestsTo(c, "/api/feedback/delete");
    assert.deepEqual(req.body, { threadIds: ["t1", "t2"], creatorName: "alice", creatorKey: "KEY-1" });
    assert.deepEqual(ids(), []);
    assert.equal(c.get("userFeedbackThreads").length, 0);
    assert.equal(c.get("activeFeedbackThreadId"), null);
  });

  it("signed out, it sends the ids alone", async () => {
    const { c, confirmed } = setup({ signedIn: "" });
    c.call("deleteUserFeedbackHistory");
    await confirmed().onConfirm();
    const [req] = requestsTo(c, "/api/feedback/delete");
    assert.deepEqual(req.body, { threadIds: ["t1", "t2"], creatorName: null, creatorKey: null });
  });

  it("keeps the chat when the server refuses, and says so", async () => {
    const { c, ids, messages, confirmed } = setup({ reply: { ok: false, error: "Username or Key is incorrect." } });
    c.call("deleteUserFeedbackHistory");
    await confirmed().onConfirm();
    assert.deepEqual(ids(), ["t1", "t2"]);
    assert.equal(c.get("userFeedbackThreads").length, 1);
    assert.ok(messages.some((m) => /could not delete/i.test(m)), JSON.stringify(messages));
  });

  it("keeps the chat when the request never arrived", async () => {
    const c = loadClient({
      signedIn: "alice",
      storage: { [IDS_KEY]: JSON.stringify(["t1"]) },
      routes: { "/api/feedback/delete": () => { throw new Error("offline"); } },
    });
    const messages = [];
    c.set("showToast", (m) => { messages.push(m); return { dismiss() {} }; });
    c.set("showAppAlert", (t, m) => { messages.push(t + ": " + m); });
    let onConfirm;
    c.set("showAppConfirm", (a, b, d, fn) => { onConfirm = fn; });
    c.set("userFeedbackThreads", [THREAD]);
    c.call("deleteUserFeedbackHistory");
    await onConfirm();
    assert.deepEqual(JSON.parse(c.localStorage.getItem(IDS_KEY)), ["t1"]);
    assert.equal(c.get("userFeedbackThreads").length, 1);
    assert.ok(messages.some((m) => /could not delete/i.test(m)));
  });
});
