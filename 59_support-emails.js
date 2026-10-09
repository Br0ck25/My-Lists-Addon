// 59_support-emails.js
//
// Customer Support Email System (Cloudflare Email Routing & Sending)
//
// Inbound: Cloudflare Email Routing delivers emails to support@mylistsaddon.com
// directly to this Worker's email() export. The handler parses the MIME body,
// matches the conversation thread, and stores it in D1 (support_threads & support_messages).
//
// Outbound: The Admin Dashboard (/admin -> Management & Tools -> Support Emails)
// allows viewing threads and replying directly from support@mylistsaddon.com
// using Cloudflare Email Sending (env.EMAIL.send()).

function decodeQuotedPrintableText(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => {
      try {
        return String.fromCharCode(parseInt(hex, 16));
      } catch {
        return _;
      }
    });
}

function decodeBase64ToText(str) {
  if (!str || typeof str !== 'string') return '';
  try {
    const clean = str.replace(/\s+/g, '');
    const binary = atob(clean);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return str;
  }
}

function escapeHtmlSupport(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseEmailSender(fromHeader) {
  if (!fromHeader) return { email: '', name: '' };
  const raw = String(fromHeader).trim();
  const angleMatch = raw.match(/^(?:["']?([^"'<]+)["']?\s*)?<([^>]+)>$/);
  if (angleMatch) {
    return {
      name: (angleMatch[1] || '').trim(),
      email: (angleMatch[2] || '').trim().toLowerCase(),
    };
  }
  const bareEmailMatch = raw.match(/([^\s@<]+@[^\s@>]+)/);
  if (bareEmailMatch) {
    return {
      name: '',
      email: bareEmailMatch[1].trim().toLowerCase(),
    };
  }
  return { name: '', email: raw.toLowerCase() };
}

function parseMimeEmail(rawText, headers) {
  const result = {
    subject: '',
    fromEmail: '',
    fromName: '',
    toEmail: '',
    messageId: '',
    inReplyTo: '',
    references: '',
    text: '',
    html: '',
  };

  if (headers && typeof headers.get === 'function') {
    result.subject = headers.get('subject') || '';
    result.messageId = headers.get('message-id') || '';
    result.inReplyTo = headers.get('in-reply-to') || '';
    result.references = headers.get('references') || '';
    const fromSender = parseEmailSender(headers.get('from'));
    result.fromEmail = fromSender.email;
    result.fromName = fromSender.name;
    const toSender = parseEmailSender(headers.get('to'));
    result.toEmail = toSender.email;
  }

  if (!rawText || typeof rawText !== 'string') return result;

  // Split headers and body of the raw message if top-level headers were missing
  const splitIdx = rawText.search(/\r?\n\r?\n/);
  let rawBody = rawText;
  if (splitIdx !== -1) {
    const headerBlock = rawText.slice(0, splitIdx);
    rawBody = rawText.slice(splitIdx).replace(/^\r?\n\r?\n/, '');

    if (!result.subject) {
      const m = headerBlock.match(/^subject:\s*(.*)$/im);
      if (m) result.subject = m[1].trim();
    }
    if (!result.fromEmail) {
      const m = headerBlock.match(/^from:\s*(.*)$/im);
      if (m) {
        const s = parseEmailSender(m[1]);
        result.fromEmail = s.email;
        result.fromName = s.name;
      }
    }
    if (!result.toEmail) {
      const m = headerBlock.match(/^to:\s*(.*)$/im);
      if (m) result.toEmail = parseEmailSender(m[1]).email;
    }
    if (!result.messageId) {
      const m = headerBlock.match(/^message-id:\s*(.*)$/im);
      if (m) result.messageId = m[1].trim();
    }
    if (!result.inReplyTo) {
      const m = headerBlock.match(/^in-reply-to:\s*(.*)$/im);
      if (m) result.inReplyTo = m[1].trim();
    }
  }

  // Parse Content-Type and boundary
  let boundary = null;
  const contentTypeMatch = rawText.match(/content-type:\s*([^;\r\n]+)(?:;\s*boundary=(?:"([^"]+)"|([^\s;\r\n]+)))?/i);
  if (contentTypeMatch && (contentTypeMatch[2] || contentTypeMatch[3])) {
    boundary = contentTypeMatch[2] || contentTypeMatch[3];
  }

  if (boundary) {
    // Multipart message
    const parts = rawBody.split(new RegExp('--' + boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    for (const part of parts) {
      if (!part || part.trim() === '--' || part.trim() === '') continue;
      const partSplit = part.search(/\r?\n\r?\n/);
      if (partSplit === -1) continue;
      const partHeader = part.slice(0, partSplit);
      let partBody = part.slice(partSplit).replace(/^\r?\n\r?\n/, '').replace(/\r?\n$/, '');

      const isHtml = /content-type:\s*text\/html/i.test(partHeader);
      const isPlain = /content-type:\s*text\/plain/i.test(partHeader);
      const isBase64 = /content-transfer-encoding:\s*base64/i.test(partHeader);
      const isQp = /content-transfer-encoding:\s*quoted-printable/i.test(partHeader);

      let decoded = partBody;
      if (isBase64) decoded = decodeBase64ToText(partBody);
      else if (isQp) decoded = decodeQuotedPrintableText(partBody);

      if (isPlain && !result.text) result.text = decoded.trim();
      else if (isHtml && !result.html) result.html = decoded.trim();
    }
  } else {
    // Single-part message
    const isBase64 = /content-transfer-encoding:\s*base64/i.test(rawText.slice(0, 1000));
    const isQp = /content-transfer-encoding:\s*quoted-printable/i.test(rawText.slice(0, 1000));
    const isHtml = /content-type:\s*text\/html/i.test(rawText.slice(0, 1000));

    let decoded = rawBody;
    if (isBase64) decoded = decodeBase64ToText(rawBody);
    else if (isQp) decoded = decodeQuotedPrintableText(rawBody);

    if (isHtml) result.html = decoded.trim();
    else result.text = decoded.trim();
  }

  // If text is still empty but HTML exists, extract plain text representation
  if (!result.text && result.html) {
    result.text = result.html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
  }

  return result;
}

// Handler for Cloudflare Email Routing (incoming email)
async function handleIncomingEmail(message, env, ctx) {
  if (!env || !env.DB) {
    console.error('[Support Email] DB binding missing, cannot store incoming email.');
    return;
  }

  try {
    let rawText = '';
    if (message.raw) {
      rawText = await new Response(message.raw).text();
    }

    const parsed = parseMimeEmail(rawText, message.headers);
    const rawFrom = (message.headers && message.headers.get('from')) || message.from || parsed.fromEmail || '';
    const fromSender = parseEmailSender(rawFrom);
    const fromEmail = fromSender.email || parsed.fromEmail || '';
    const customerName = fromSender.name || parsed.fromName || '';
    const toEmail = message.to || parsed.toEmail || 'support@mylistsaddon.com';
    const subject = (message.headers && message.headers.get('subject')) || parsed.subject || '(No subject)';
    const messageId = (message.headers && message.headers.get('message-id')) || parsed.messageId || ('<in-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '@mylistsaddon.com>');
    const inReplyTo = (message.headers && message.headers.get('in-reply-to')) || parsed.inReplyTo || null;
    const bodyText = (parsed.text || rawText || '').slice(0, 200000); // 200KB safety limit
    const bodyHtml = (parsed.html || '').slice(0, 500000); // 500KB safety limit
    const now = Date.now();

    let threadId = null;

    // 1. Try matching thread by In-Reply-To header
    if (inReplyTo) {
      try {
        const match = await env.DB.prepare(
          'SELECT thread_id FROM support_messages WHERE message_id = ? OR id = ? LIMIT 1'
        ).bind(inReplyTo, inReplyTo).first();
        if (match && match.thread_id) threadId = match.thread_id;
      } catch (e) {
        console.warn('[Support Email] In-reply-to lookup error:', e);
      }
    }

    // 2. If not matched, try matching by same customer email and normalized subject in the last 30 days
    if (!threadId && fromEmail) {
      const normSubject = subject.replace(/^(?:re|fwd|fw):\s*/i, '').trim().toLowerCase();
      try {
        const recentThread = await env.DB.prepare(
          "SELECT id, subject FROM support_threads WHERE customer_email = ? AND status != 'spam' AND last_message_at > ? ORDER BY last_message_at DESC LIMIT 5"
        ).bind(fromEmail, now - 30 * 86400000).all();
        if (recentThread && Array.isArray(recentThread.results)) {
          const found = recentThread.results.find((t) => {
            const tNorm = String(t.subject || '').replace(/^(?:re|fwd|fw):\s*/i, '').trim().toLowerCase();
            return tNorm === normSubject;
          });
          if (found) threadId = found.id;
        }
      } catch (e) {
        console.warn('[Support Email] Subject thread lookup error:', e);
      }
    }

    // 3. Create new thread if no match found
    if (!threadId) {
      threadId = 'th_' + now + '_' + Math.random().toString(36).slice(2, 8);
      await env.DB.prepare(
        'INSERT INTO support_threads (id, customer_email, customer_name, subject, status, unread, created_at, updated_at, last_message_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)'
      ).bind(threadId, fromEmail, customerName, subject, 'open', now, now, now).run();
    } else {
      await env.DB.prepare(
        "UPDATE support_threads SET status = 'open', unread = unread + 1, updated_at = ?, last_message_at = ?, customer_name = CASE WHEN customer_name IS NULL OR customer_name = '' THEN ? ELSE customer_name END WHERE id = ?"
      ).bind(now, now, customerName, threadId).run();
    }

    // 4. Insert message
    const msgId = 'msg_' + now + '_' + Math.random().toString(36).slice(2, 8);
    await env.DB.prepare(
      'INSERT INTO support_messages (id, thread_id, direction, from_email, to_email, subject, body_text, body_html, message_id, in_reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      msgId,
      threadId,
      'inbound',
      fromEmail,
      toEmail,
      subject,
      bodyText,
      bodyHtml,
      messageId,
      inReplyTo,
      now
    ).run();

    console.log(`[Support Email] Inbound email from ${fromEmail} recorded in thread ${threadId}`);
  } catch (err) {
    console.error('[Support Email] Failed to process incoming email:', err);
  }
}

// Dispatches an outbound email reply via env.EMAIL.send() and records it
async function sendSupportEmailReply(env, { threadId, text, html, closeOnSend, actor }) {
  if (!env || !env.DB) return { ok: false, error: 'Database is not bound.' };
  if (!threadId) return { ok: false, error: 'threadId is required.' };
  if (!text || !String(text).trim()) return { ok: false, error: 'Reply text cannot be empty.' };

  const thread = await env.DB.prepare('SELECT * FROM support_threads WHERE id = ?').bind(threadId).first();
  if (!thread) return { ok: false, error: 'Conversation thread not found.' };

  const now = Date.now();
  const replySubject = thread.subject.startsWith('Re:') ? thread.subject : 'Re: ' + thread.subject;

  // Get last inbound message's RFC Message-ID for In-Reply-To header
  const lastInbound = await env.DB.prepare(
    "SELECT message_id FROM support_messages WHERE thread_id = ? AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1"
  ).bind(threadId).first();
  const inReplyTo = (lastInbound && lastInbound.message_id) ? lastInbound.message_id : null;

  const outboundRfcId = '<reply-' + now + '-' + Math.random().toString(36).slice(2, 8) + '@mylistsaddon.com>';
  const cleanText = String(text).trim();
  const cleanHtml = html ? String(html).trim() : '<p style="font-family:sans-serif;font-size:15px;line-height:1.5;color:#222;white-space:pre-wrap;">' + escapeHtmlSupport(cleanText) + '</p>';

  // Send via Cloudflare Email Sending Worker binding if available
  if (env.EMAIL && typeof env.EMAIL.send === 'function') {
    const payload = {
      to: thread.customer_email,
      from: 'support@mylistsaddon.com',
      subject: replySubject,
      text: cleanText,
      html: cleanHtml,
    };
    if (inReplyTo) {
      payload.headers = {
        'In-Reply-To': inReplyTo,
        'References': inReplyTo,
      };
    }
    await env.EMAIL.send(payload);
  } else {
    // If EMAIL binding is not present, still record message in DB for tracking/mocking
    console.warn('[Support Email] env.EMAIL binding missing. Recorded outbound reply in DB without sending network email.');
  }

  // Insert outbound message into DB
  const msgId = 'msg_' + now + '_' + Math.random().toString(36).slice(2, 8);
  await env.DB.prepare(
    'INSERT INTO support_messages (id, thread_id, direction, from_email, to_email, subject, body_text, body_html, message_id, in_reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    msgId,
    threadId,
    'outbound',
    'support@mylistsaddon.com',
    thread.customer_email,
    replySubject,
    cleanText,
    cleanHtml,
    outboundRfcId,
    inReplyTo,
    now
  ).run();

  const newStatus = closeOnSend ? 'closed' : 'replied';
  await env.DB.prepare(
    'UPDATE support_threads SET status = ?, unread = 0, updated_at = ?, last_message_at = ? WHERE id = ?'
  ).bind(newStatus, now, now, threadId).run();

  // Audit log if available
  try {
    if (typeof recordAdminAudit === 'function' && actor) {
      await recordAdminAudit(env, actor, 'support_email_reply', thread.customer_email, threadId);
    }
  } catch {}

  const updatedThread = Object.assign({}, thread, {
    status: newStatus,
    unread: 0,
    updated_at: now,
    last_message_at: now,
  });

  const createdMessage = {
    id: msgId,
    thread_id: threadId,
    direction: 'outbound',
    from_email: 'support@mylistsaddon.com',
    to_email: thread.customer_email,
    subject: replySubject,
    body_text: cleanText,
    body_html: cleanHtml,
    created_at: now,
  };

  return { ok: true, message: createdMessage, thread: updatedThread };
}

// Composes a brand-new outbound email thread to a recipient
async function composeNewSupportEmail(env, { toEmail, customerName, subject, text, html, actor }) {
  if (!env || !env.DB) return { ok: false, error: 'Database is not bound.' };
  if (!toEmail || !String(toEmail).includes('@')) return { ok: false, error: 'Valid recipient email is required.' };
  if (!subject || !String(subject).trim()) return { ok: false, error: 'Subject is required.' };
  if (!text || !String(text).trim()) return { ok: false, error: 'Email text is required.' };

  const now = Date.now();
  const threadId = 'th_' + now + '_' + Math.random().toString(36).slice(2, 8);
  const cleanTo = String(toEmail).trim().toLowerCase();
  const cleanSubject = String(subject).trim();
  const cleanText = String(text).trim();
  const cleanName = customerName ? String(customerName).trim() : '';
  const cleanHtml = html ? String(html).trim() : '<p style="font-family:sans-serif;font-size:15px;line-height:1.5;color:#222;white-space:pre-wrap;">' + escapeHtmlSupport(cleanText) + '</p>';
  const outboundRfcId = '<out-' + now + '-' + Math.random().toString(36).slice(2, 8) + '@mylistsaddon.com>';

  if (env.EMAIL && typeof env.EMAIL.send === 'function') {
    await env.EMAIL.send({
      to: cleanTo,
      from: 'support@mylistsaddon.com',
      subject: cleanSubject,
      text: cleanText,
      html: cleanHtml,
    });
  }

  await env.DB.prepare(
    'INSERT INTO support_threads (id, customer_email, customer_name, subject, status, unread, created_at, updated_at, last_message_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)'
  ).bind(threadId, cleanTo, cleanName, cleanSubject, 'replied', now, now, now).run();

  const msgId = 'msg_' + now + '_' + Math.random().toString(36).slice(2, 8);
  await env.DB.prepare(
    'INSERT INTO support_messages (id, thread_id, direction, from_email, to_email, subject, body_text, body_html, message_id, in_reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    msgId,
    threadId,
    'outbound',
    'support@mylistsaddon.com',
    cleanTo,
    cleanSubject,
    cleanText,
    cleanHtml,
    outboundRfcId,
    null,
    now
  ).run();

  return {
    ok: true,
    thread: {
      id: threadId,
      customer_email: cleanTo,
      customer_name: cleanName,
      subject: cleanSubject,
      status: 'replied',
      unread: 0,
      created_at: now,
      updated_at: now,
      last_message_at: now,
    },
    message: {
      id: msgId,
      thread_id: threadId,
      direction: 'outbound',
      from_email: 'support@mylistsaddon.com',
      to_email: cleanTo,
      subject: cleanSubject,
      body_text: cleanText,
      body_html: cleanHtml,
      created_at: now,
    },
  };
}

// Router for admin support email endpoints
async function handleSupportEmailsApi(path, request, env) {
  if (!env || !env.DB) {
    return json({ ok: false, error: 'D1 database is required for support emails.' }, 503);
  }

  const url = new URL(request.url);

  // GET /admin/api/support-emails/threads
  if (path === '/admin/api/support-emails/threads' && request.method === 'GET') {
    const status = url.searchParams.get('status') || 'all';
    const query = (url.searchParams.get('q') || '').trim();
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10)));
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10));

    try {
      let sql = 'SELECT * FROM support_threads';
      const where = [];
      const params = [];

      if (status !== 'all') {
        where.push('status = ?');
        params.push(status);
      }
      if (query) {
        where.push('(customer_email LIKE ? OR customer_name LIKE ? OR subject LIKE ?)');
        const qPattern = '%' + query + '%';
        params.push(qPattern, qPattern, qPattern);
      }

      if (where.length) sql += ' WHERE ' + where.join(' AND ');
      sql += ' ORDER BY last_message_at DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const rows = await env.DB.prepare(sql).bind(...params).all();
      const threads = (rows && Array.isArray(rows.results)) ? rows.results : [];

      // Also get counts by status for admin tabs
      const countOpen = await env.DB.prepare("SELECT count(*) as c FROM support_threads WHERE status = 'open'").first();
      const countTotal = await env.DB.prepare('SELECT count(*) as c FROM support_threads').first();

      return json({
        ok: true,
        threads,
        counts: {
          open: (countOpen && countOpen.c) || 0,
          total: (countTotal && countTotal.c) || 0,
        },
      }, 200, { 'Cache-Control': 'no-store' });
    } catch (e) {
      const msg = safeErrorMessage(e);
      if (msg.includes('no such table')) {
        return json({ ok: false, notConfigured: true, error: 'Support email tables do not exist yet. Run migration 0021.' }, 200);
      }
      return json({ ok: false, error: msg }, 500);
    }
  }

  // GET /admin/api/support-emails/thread?id=...
  if (path === '/admin/api/support-emails/thread' && request.method === 'GET') {
    const threadId = url.searchParams.get('id');
    if (!threadId) return json({ ok: false, error: 'Thread ID required.' }, 400);

    try {
      const thread = await env.DB.prepare('SELECT * FROM support_threads WHERE id = ?').bind(threadId).first();
      if (!thread) return json({ ok: false, error: 'Thread not found.' }, 404);

      // Mark unread as 0 on view
      if (thread.unread > 0) {
        await env.DB.prepare('UPDATE support_threads SET unread = 0 WHERE id = ?').bind(threadId).run();
        thread.unread = 0;
      }

      const msgRows = await env.DB.prepare(
        'SELECT * FROM support_messages WHERE thread_id = ? ORDER BY created_at ASC'
      ).bind(threadId).all();
      const messages = (msgRows && Array.isArray(msgRows.results)) ? msgRows.results : [];

      return json({ ok: true, thread, messages }, 200, { 'Cache-Control': 'no-store' });
    } catch (e) {
      return json({ ok: false, error: safeErrorMessage(e) }, 500);
    }
  }

  // POST /admin/api/support-emails/reply
  if (path === '/admin/api/support-emails/reply' && request.method === 'POST') {
    try {
      const body = await request.json();
      const result = await sendSupportEmailReply(env, body);
      return json(result, result.ok ? 200 : 400, { 'Cache-Control': 'no-store' });
    } catch (e) {
      return json({ ok: false, error: safeErrorMessage(e) }, 500);
    }
  }

  // POST /admin/api/support-emails/compose
  if (path === '/admin/api/support-emails/compose' && request.method === 'POST') {
    try {
      const body = await request.json();
      const result = await composeNewSupportEmail(env, body);
      return json(result, result.ok ? 200 : 400, { 'Cache-Control': 'no-store' });
    } catch (e) {
      return json({ ok: false, error: safeErrorMessage(e) }, 500);
    }
  }

  // POST /admin/api/support-emails/status
  if (path === '/admin/api/support-emails/status' && request.method === 'POST') {
    try {
      const body = await request.json();
      const { threadId, status } = body || {};
      if (!threadId || !['open', 'replied', 'closed', 'spam'].includes(status)) {
        return json({ ok: false, error: 'Invalid threadId or status.' }, 400);
      }
      await env.DB.prepare('UPDATE support_threads SET status = ?, updated_at = ? WHERE id = ?')
        .bind(status, Date.now(), threadId)
        .run();
      return json({ ok: true }, 200, { 'Cache-Control': 'no-store' });
    } catch (e) {
      return json({ ok: false, error: safeErrorMessage(e) }, 500);
    }
  }

  // POST /admin/api/support-emails/delete
  if (path === '/admin/api/support-emails/delete' && request.method === 'POST') {
    try {
      const body = await request.json();
      const threadId = body && body.threadId;
      if (!threadId) return json({ ok: false, error: 'Thread ID required.' }, 400);

      await env.DB.prepare('DELETE FROM support_messages WHERE thread_id = ?').bind(threadId).run();
      await env.DB.prepare('DELETE FROM support_threads WHERE id = ?').bind(threadId).run();
      return json({ ok: true }, 200, { 'Cache-Control': 'no-store' });
    } catch (e) {
      return json({ ok: false, error: safeErrorMessage(e) }, 500);
    }
  }

  return json({ ok: false, error: 'Endpoint not found.' }, 404);
}
