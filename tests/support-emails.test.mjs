import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, makeD1, makeKv, call, worker } from "./harness.mjs";

async function adminCookie(env) {
  const login = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
  return (login.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/)[1];
}

function createMockEmailMessage({ from, to, subject, messageId, inReplyTo, text, html }) {
  const headers = new Map();
  if (from) headers.set("from", from);
  if (to) headers.set("to", to);
  if (subject) headers.set("subject", subject);
  if (messageId) headers.set("message-id", messageId);
  if (inReplyTo) headers.set("in-reply-to", inReplyTo);

  const boundary = "==mock_boundary_12345==";
  let rawBody = "";
  if (text && html) {
    rawBody = [
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "",
      text,
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "",
      html,
      `--${boundary}--`,
    ].join("\r\n");
  } else if (html) {
    rawBody = `Content-Type: text/html; charset=UTF-8\r\n\r\n${html}`;
  } else {
    rawBody = `Content-Type: text/plain; charset=UTF-8\r\n\r\n${text || ""}`;
  }

  const rawBytes = new TextEncoder().encode(rawBody);
  const rawStream = new ReadableStream({
    start(controller) {
      controller.enqueue(rawBytes);
      controller.close();
    },
  });

  return {
    from: from || "",
    to: to || "support@mylistsaddon.com",
    headers: {
      get(k) {
        return headers.get(String(k).toLowerCase()) || null;
      },
    },
    raw: rawStream,
  };
}

describe("support emails: Cloudflare email routing (inbound)", () => {
  it("processes incoming support email and creates a new conversation thread", async () => {
    const db = makeD1();
    const env = makeEnv({ CONFIGS: makeKv(), DB: db });

    const emailMsg = createMockEmailMessage({
      from: "Jane Doe <jane@example.com>",
      to: "support@mylistsaddon.com",
      subject: "Help with Trakt list import",
      messageId: "<msg-001@example.com>",
      text: "Hello, my Trakt watchlist is not syncing properly.",
    });

    await worker.email(emailMsg, env, {});

    const threads = (await db.prepare("SELECT * FROM support_threads").all()).results;
    assert.equal(threads.length, 1);
    assert.equal(threads[0].customer_email, "jane@example.com");
    assert.equal(threads[0].customer_name, "Jane Doe");
    assert.equal(threads[0].subject, "Help with Trakt list import");
    assert.equal(threads[0].status, "open");
    assert.equal(threads[0].unread, 1);

    const messages = (await db.prepare("SELECT * FROM support_messages WHERE thread_id = ?").bind(threads[0].id).all()).results;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].direction, "inbound");
    assert.equal(messages[0].from_email, "jane@example.com");
    assert.equal(messages[0].message_id, "<msg-001@example.com>");
    assert.equal(messages[0].body_text, "Hello, my Trakt watchlist is not syncing properly.");
  });

  it("links a customer reply with In-Reply-To to the existing thread", async () => {
    const db = makeD1();
    const env = makeEnv({ CONFIGS: makeKv(), DB: db });

    // Initial email
    await worker.email(createMockEmailMessage({
      from: "bob@example.com",
      subject: "Question about channels",
      messageId: "<initial-123@example.com>",
      text: "How do I create a custom channel?",
    }), env, {});

    const initialThreads = (await db.prepare("SELECT * FROM support_threads").all()).results;
    assert.equal(initialThreads.length, 1);
    const threadId = initialThreads[0].id;

    // Follow-up email with In-Reply-To
    await worker.email(createMockEmailMessage({
      from: "bob@example.com",
      subject: "Re: Question about channels",
      messageId: "<reply-456@example.com>",
      inReplyTo: "<initial-123@example.com>",
      text: "Never mind, I found the setting in My Channels!",
    }), env, {});

    // Should still be 1 thread, with 2 messages
    const threadsAfter = (await db.prepare("SELECT * FROM support_threads").all()).results;
    assert.equal(threadsAfter.length, 1);
    assert.equal(threadsAfter[0].id, threadId);
    assert.equal(threadsAfter[0].unread, 2);

    const messages = (await db.prepare("SELECT * FROM support_messages WHERE thread_id = ? ORDER BY created_at ASC").bind(threadId).all()).results;
    assert.equal(messages.length, 2);
    assert.equal(messages[0].message_id, "<initial-123@example.com>");
    assert.equal(messages[1].message_id, "<reply-456@example.com>");
    assert.equal(messages[1].in_reply_to, "<initial-123@example.com>");
  });

  it("links a customer reply with matching normalized subject within 30 days", async () => {
    const db = makeD1();
    const env = makeEnv({ CONFIGS: makeKv(), DB: db });

    await worker.email(createMockEmailMessage({
      from: "sarah@example.com",
      subject: "Cannot find movie title",
      messageId: "<m1@example.com>",
      text: "Search isn't showing Dune Part Two.",
    }), env, {});

    const threads = (await db.prepare("SELECT * FROM support_threads").all()).results;
    assert.equal(threads.length, 1);

    // Reply without In-Reply-To header, but same customer and Re: subject
    await worker.email(createMockEmailMessage({
      from: "sarah@example.com",
      subject: "Re: Cannot find movie title",
      messageId: "<m2@example.com>",
      text: "It showed up now after clearing cache.",
    }), env, {});

    const threadsAfter = (await db.prepare("SELECT * FROM support_threads").all()).results;
    assert.equal(threadsAfter.length, 1);

    const messages = (await db.prepare("SELECT * FROM support_messages WHERE thread_id = ?").bind(threads[0].id).all()).results;
    assert.equal(messages.length, 2);
  });
});

describe("support emails: Admin API & Cloudflare Email Sending", () => {
  it("enforces admin authorization on all /admin/api/support-emails/* routes", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });

    const getThreads = await call(env, "/admin/api/support-emails/threads");
    assert.equal(getThreads.status, 401);

    const getThread = await call(env, "/admin/api/support-emails/thread?id=th_123");
    assert.equal(getThread.status, 401);

    const reply = await call(env, "/admin/api/support-emails/reply", { method: "POST", json: {} });
    assert.equal(reply.status, 401);

    const compose = await call(env, "/admin/api/support-emails/compose", { method: "POST", json: {} });
    assert.equal(compose.status, 401);

    const status = await call(env, "/admin/api/support-emails/status", { method: "POST", json: {} });
    assert.equal(status.status, 401);

    const del = await call(env, "/admin/api/support-emails/delete", { method: "POST", json: {} });
    assert.equal(del.status, 401);
  });

  it("lists, reads, and replies to customer emails via env.EMAIL.send", async () => {
    const db = makeD1();
    const sentEmails = [];
    const mockEmailBinding = {
      async send(payload) {
        sentEmails.push(payload);
        return { messageId: "mock-outbound-id" };
      },
    };

    const env = makeEnv({ CONFIGS: makeKv(), DB: db, EMAIL: mockEmailBinding });
    const cookie = await adminCookie(env);

    // Receive initial customer inquiry
    await worker.email(createMockEmailMessage({
      from: "alice@example.com",
      subject: "Feature request: sorting custom lists",
      messageId: "<req-100@example.com>",
      text: "Could you add drag and drop reordering for custom list items?",
    }), env, {});

    // Admin lists threads
    const listRes = await call(env, "/admin/api/support-emails/threads", { cookie });
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.ok, true);
    assert.equal(listRes.body.threads.length, 1);
    assert.equal(listRes.body.counts.open, 1);
    const threadId = listRes.body.threads[0].id;

    // Admin views thread (marks unread as 0)
    const threadRes = await call(env, `/admin/api/support-emails/thread?id=${threadId}`, { cookie });
    assert.equal(threadRes.status, 200);
    assert.equal(threadRes.body.ok, true);
    assert.equal(threadRes.body.thread.unread, 0);
    assert.equal(threadRes.body.messages.length, 1);

    // Admin replies
    const replyRes = await call(env, "/admin/api/support-emails/reply", {
      method: "POST",
      cookie,
      json: {
        threadId,
        text: "Hi Alice, list reordering is already available on desktop and mobile in Settings -> Custom Lists -> Edit!",
        closeOnSend: true,
      },
    });

    assert.equal(replyRes.status, 200);
    assert.equal(replyRes.body.ok, true);
    assert.equal(replyRes.body.thread.status, "closed");

    // Verify outbound email dispatch
    assert.equal(sentEmails.length, 1);
    assert.equal(sentEmails[0].to, "alice@example.com");
    assert.equal(sentEmails[0].from, "support@mylistsaddon.com");
    assert.equal(sentEmails[0].subject, "Re: Feature request: sorting custom lists");
    assert.match(sentEmails[0].text, /Hi Alice/);
    assert.equal(sentEmails[0].headers["In-Reply-To"], "<req-100@example.com>");

    // Verify messages stored in D1
    const msgsAfter = (await db.prepare("SELECT * FROM support_messages WHERE thread_id = ? ORDER BY created_at ASC").bind(threadId).all()).results;
    assert.equal(msgsAfter.length, 2);
    assert.equal(msgsAfter[0].direction, "inbound");
    assert.equal(msgsAfter[1].direction, "outbound");
    assert.equal(msgsAfter[1].to_email, "alice@example.com");
  });

  it("composes a new outbound email and manages thread status & deletion", async () => {
    const db = makeD1();
    const sentEmails = [];
    const mockEmailBinding = {
      async send(payload) {
        sentEmails.push(payload);
        return { messageId: "out-msg-1" };
      },
    };

    const env = makeEnv({ CONFIGS: makeKv(), DB: db, EMAIL: mockEmailBinding });
    const cookie = await adminCookie(env);

    // Compose new email
    const compRes = await call(env, "/admin/api/support-emails/compose", {
      method: "POST",
      cookie,
      json: {
        toEmail: "partner@example.com",
        customerName: "Partner Team",
        subject: "Catalog partnership update",
        text: "Here is your API access details.",
      },
    });

    assert.equal(compRes.status, 200);
    assert.equal(compRes.body.ok, true);
    const threadId = compRes.body.thread.id;
    assert.equal(sentEmails.length, 1);
    assert.equal(sentEmails[0].to, "partner@example.com");

    // Change status
    const statRes = await call(env, "/admin/api/support-emails/status", {
      method: "POST",
      cookie,
      json: { threadId, status: "open" },
    });
    assert.equal(statRes.status, 200);
    assert.equal(statRes.body.ok, true);

    const tRow = await db.prepare("SELECT status FROM support_threads WHERE id = ?").bind(threadId).first();
    assert.equal(tRow.status, "open");

    // Delete thread
    const delRes = await call(env, "/admin/api/support-emails/delete", {
      method: "POST",
      cookie,
      json: { threadId },
    });
    assert.equal(delRes.status, 200);
    assert.equal(delRes.body.ok, true);

    const deletedThread = await db.prepare("SELECT * FROM support_threads WHERE id = ?").bind(threadId).first();
    assert.equal(deletedThread, null);
    const deletedMsgs = (await db.prepare("SELECT * FROM support_messages WHERE thread_id = ?").bind(threadId).all()).results;
    assert.equal(deletedMsgs.length, 0);
  });

  it("correctly parses real Gmail and Hotmail multipart MIME bodies without exposing boundaries", async () => {
    const db = makeD1();
    const env = makeEnv({ CONFIGS: makeKv(), DB: db });

    // Gmail email with body-only boundary markers
    const gmailRaw = `--000000000000847865065d6dbcd2
Content-Type: text/plain; charset="UTF-8"

is this working?

--000000000000847865065d6dbcd2
Content-Type: text/html; charset="UTF-8"

<div dir="ltr">is this working?</div>

--000000000000847865065d6dbcd2--`;

    const rawBytes = new TextEncoder().encode(gmailRaw);
    const headersMap = new Map([
      ["from", "jamesbrock2011@gmail.com"],
      ["to", "support@mylistsaddon.com"],
      ["subject", "support"],
      ["content-type", 'multipart/alternative; boundary="000000000000847865065d6dbcd2"'],
    ]);
    const emailMsg = {
      from: "jamesbrock2011@gmail.com",
      to: "support@mylistsaddon.com",
      headers: {
        get(k) {
          return headersMap.get(String(k).toLowerCase()) || null;
        },
      },
      raw: new ReadableStream({
        start(controller) {
          controller.enqueue(rawBytes);
          controller.close();
        },
      }),
    };

    await worker.email(emailMsg, env, {});

    const msgs = (await db.prepare("SELECT * FROM support_messages WHERE from_email = ?").bind("jamesbrock2011@gmail.com").all()).results;
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].body_text, "is this working?");
    assert.doesNotMatch(msgs[0].body_text, /--000000000000847865065d6dbcd2/);
    assert.doesNotMatch(msgs[0].body_text, /Content-Type:/i);
  });

  it("auto-cleans previously stored unparsed MIME messages when viewing thread", async () => {
    const db = makeD1();
    const env = makeEnv({ CONFIGS: makeKv(), DB: db });
    const cookie = await adminCookie(env);

    const threadId = "th_legacy_test";
    const msgId = "msg_legacy_test";
    const rawUnparsed = `--_000_SN6PR06MB4848950C8B0B98ADF8917273CF922SN6PR06MB4848namp_
Content-Type: text/plain; charset="us-ascii"
Content-Transfer-Encoding: quoted-printable

Yes it worked
________________________________
From: support@mylistsaddon.com

--_000_SN6PR06MB4848950C8B0B98ADF8917273CF922SN6PR06MB4848namp_
Content-Type: text/html; charset="us-ascii"

<html>Yes it worked</html>
--_000_SN6PR06MB4848950C8B0B98ADF8917273CF922SN6PR06MB4848namp_--`;

    await db.prepare("INSERT INTO support_threads (id, customer_email, subject, status, unread, created_at, updated_at, last_message_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(threadId, "jamesbrock25@hotmail.com", "Testing", "open", 1, Date.now(), Date.now(), Date.now()).run();

    await db.prepare("INSERT INTO support_messages (id, thread_id, direction, from_email, to_email, subject, body_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(msgId, threadId, "inbound", "jamesbrock25@hotmail.com", "support@mylistsaddon.com", "Testing", rawUnparsed, Date.now()).run();

    // Fetch thread via admin API
    const res = await call(env, `/admin/api/support-emails/thread?id=${threadId}`, { cookie });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.messages.length, 1);
    assert.equal(res.body.messages[0].body_text, "Yes it worked");
    assert.doesNotMatch(res.body.messages[0].body_text, /_000_SN6PR06MB/);

    // Verify D1 was auto-healed in place
    const healed = await db.prepare("SELECT body_text FROM support_messages WHERE id = ?").bind(msgId).first();
    assert.equal(healed.body_text, "Yes it worked");
  });

  it("extracts inbound image attachments and replaces inline cid references in HTML", async () => {
    const db = makeD1();
    const env = makeEnv({ CONFIGS: makeKv(), DB: db });
    const cookie = await adminCookie(env);

    const boundary = "==image_boundary_999==";
    const samplePngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    const mimeWithImage = [
      `Content-Type: multipart/related; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "",
      '<div>Here is the screenshot: <img src="cid:screenshot01@local"></div>',
      `--${boundary}`,
      'Content-Type: image/png; name="screenshot.png"',
      "Content-Transfer-Encoding: base64",
      "Content-ID: <screenshot01@local>",
      'Content-Disposition: inline; filename="screenshot.png"',
      "",
      samplePngBase64,
      `--${boundary}--`,
    ].join("\r\n");

    const emailMsg = {
      from: "alice@example.com",
      to: "support@mylistsaddon.com",
      headers: new Map([
        ["from", "alice@example.com"],
        ["to", "support@mylistsaddon.com"],
        ["subject", "Found a bug with screenshot"],
        ["content-type", `multipart/related; boundary="${boundary}"`],
      ]),
      raw: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(mimeWithImage));
          controller.close();
        },
      }),
    };

    await worker.email(emailMsg, env, {});

    const threads = (await db.prepare("SELECT * FROM support_threads WHERE customer_email = ?").bind("alice@example.com").all()).results;
    assert.equal(threads.length, 1);

    const res = await call(env, `/admin/api/support-emails/thread?id=${threads[0].id}`, { cookie });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.messages.length, 1);

    const msg = res.body.messages[0];
    assert.equal(Array.isArray(msg.attachments), true);
    assert.equal(msg.attachments.length, 1);
    assert.equal(msg.attachments[0].filename, "screenshot.png");
    assert.equal(msg.attachments[0].mimeType, "image/png");
    assert.equal(msg.attachments[0].dataUrl.startsWith("data:image/png;base64,"), true);

    // Verify inline cid: was replaced in body_html
    assert.match(msg.body_html, /data:image\/png;base64,/);
    assert.doesNotMatch(msg.body_html, /cid:screenshot01@local/);
  });

  it("sends outgoing replies with image attachments via env.EMAIL.send", async () => {
    const db = makeD1();
    let sentEmailPayload = null;
    const mockEmail = {
      async send(payload) {
        sentEmailPayload = payload;
        return { messageId: "out-msg-123" };
      },
    };
    const env = makeEnv({ CONFIGS: makeKv(), DB: db, EMAIL: mockEmail });
    const cookie = await adminCookie(env);

    // Create an incoming thread first
    const emailMsg = createMockEmailMessage({
      from: "charlie@example.com",
      subject: "Question about poster art",
      text: "How do I see high-res posters?",
    });
    await worker.email(emailMsg, env, {});

    const thread = (await db.prepare("SELECT * FROM support_threads WHERE customer_email = ?").bind("charlie@example.com").all()).results[0];

    const samplePngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const replyRes = await call(env, "/admin/api/support-emails/reply", {
      method: "POST",
      cookie,
      json: {
        threadId: thread.id,
        text: "Here is a guide showing the button:",
        attachments: [
          {
            filename: "guide.png",
            type: "image/png",
            dataUrl: "data:image/png;base64," + samplePngBase64,
          },
        ],
        closeOnSend: true,
      },
    });

    assert.equal(replyRes.status, 200);
    assert.equal(replyRes.body.ok, true);
    assert.equal(replyRes.body.message.attachments.length, 1);
    assert.equal(replyRes.body.message.attachments[0].filename, "guide.png");

    // Verify env.EMAIL.send was called with attachments
    assert.notEqual(sentEmailPayload, null);
    assert.equal(sentEmailPayload.to, "charlie@example.com");
    assert.equal(Array.isArray(sentEmailPayload.attachments), true);
    assert.equal(sentEmailPayload.attachments.length, 1);
    assert.equal(sentEmailPayload.attachments[0].filename, "guide.png");
    assert.equal(sentEmailPayload.attachments[0].type, "image/png");
    assert.equal(Buffer.from(sentEmailPayload.attachments[0].content).toString("base64"), samplePngBase64);

    // Verify thread conversation includes the outbound attachment
    const threadView = await call(env, `/admin/api/support-emails/thread?id=${thread.id}`, { cookie });
    assert.equal(threadView.body.messages.length, 2);
    const outboundMsg = threadView.body.messages.find((m) => m.direction === "outbound");
    assert.notEqual(outboundMsg, undefined);
    assert.equal(outboundMsg.attachments.length, 1);
    assert.equal(outboundMsg.attachments[0].filename, "guide.png");
  });

  it("composes new outbound emails with image attachments", async () => {
    const db = makeD1();
    let sentEmailPayload = null;
    const mockEmail = {
      async send(payload) {
        sentEmailPayload = payload;
        return { messageId: "compose-msg-456" };
      },
    };
    const env = makeEnv({ CONFIGS: makeKv(), DB: db, EMAIL: mockEmail });
    const cookie = await adminCookie(env);

    const samplePngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const composeRes = await call(env, "/admin/api/support-emails/compose", {
      method: "POST",
      cookie,
      json: {
        toEmail: "david@example.com",
        customerName: "David",
        subject: "Information requested",
        text: "Please find the requested chart below:",
        attachments: [
          {
            filename: "chart.png",
            type: "image/png",
            dataUrl: "data:image/png;base64," + samplePngBase64,
          },
        ],
      },
    });

    assert.equal(composeRes.status, 200);
    assert.equal(composeRes.body.ok, true);
    assert.notEqual(sentEmailPayload, null);
    assert.equal(sentEmailPayload.to, "david@example.com");
    assert.equal(sentEmailPayload.attachments.length, 1);
    assert.equal(sentEmailPayload.attachments[0].filename, "chart.png");

    const threadId = composeRes.body.thread.id;
    const threadView = await call(env, `/admin/api/support-emails/thread?id=${threadId}`, { cookie });
    assert.equal(threadView.body.messages[0].attachments.length, 1);
    assert.equal(threadView.body.messages[0].attachments[0].filename, "chart.png");
  });

  it("normalizes attachment filenames without extensions (e.g. UUIDs) so external email clients can preview them", async () => {
    const db = makeD1();
    let sentEmailPayload = null;
    const mockEmail = {
      async send(payload) {
        sentEmailPayload = payload;
        return { messageId: "uuid-ext-msg-123" };
      },
    };
    const env = makeEnv({ CONFIGS: makeKv(), DB: db, EMAIL: mockEmail });
    const cookie = await adminCookie(env);

    const samplePngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const composeRes = await call(env, "/admin/api/support-emails/compose", {
      method: "POST",
      cookie,
      json: {
        toEmail: "eve@example.com",
        customerName: "Eve",
        subject: "Screenshot attachment",
        text: "Here is your screenshot:",
        attachments: [
          {
            filename: "a120c1be-f07e-436f-98c4-0b1a09d6dbcd",
            type: "image/png",
            content: "  " + samplePngBase64 + "\n",
          },
        ],
      },
    });

    assert.equal(composeRes.status, 200);
    assert.equal(composeRes.body.ok, true);
    assert.notEqual(sentEmailPayload, null);
    assert.equal(sentEmailPayload.attachments.length, 1);
    assert.equal(sentEmailPayload.attachments[0].filename, "a120c1be-f07e-436f-98c4-0b1a09d6dbcd.png");
    assert.equal(Buffer.from(sentEmailPayload.attachments[0].content).toString("base64"), samplePngBase64);

    const threadId = composeRes.body.thread.id;
    const threadView = await call(env, `/admin/api/support-emails/thread?id=${threadId}`, { cookie });
    assert.equal(threadView.body.messages[0].attachments[0].filename, "a120c1be-f07e-436f-98c4-0b1a09d6dbcd.png");
  });
});
