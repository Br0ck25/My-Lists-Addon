// --- Shared channels no account owns ------------------------------------------
//
// Shares used to need no account, so some channel links were minted with no
// owner. They still open (a link already handed out) but nobody can withdraw
// one. /admin/api/channel-ownerless (26_) counts them and removes them in
// batches. A count is the default; nothing is deleted unless the request says so
// and carries OWNERLESS_CHANNELS_CONFIRM, so the operator can look first and take
// a backup first (docs/OPERATIONS.md, the KV export).
//
// An install link that carries one of these channels holds the channel's lineup
// inside its own row, so removing the shared record only ends the share link
// (/channel/<code>) and "import by code".

const OWNERLESS_CHANNELS_CONFIRM = "delete ownerless channels";
const OWNERLESS_CHANNELS_BATCH = 50;
const OWNERLESS_CHANNELS_BATCH_MAX = 200;

// One shared channel, gone from every place that holds it: the record and its
// like ledger, the Explore Channels listing, and the copy in the new tables. The
// same steps as the admin takedown ("delete" in /admin/api/channel-moderate).
async function deleteSharedChannelEverywhere(env, code) {
  await removePublicChannelIndex(env, code);
  await env.CONFIGS.delete(`channelshare:${code}`);
  await env.CONFIGS.delete(`channellikevoters:${code}`);
  if (!(await channelsV2Delete(env, code))) throw new Error("the copy in the new tables could not be removed");
}

function ownerlessChannelSummary(code, record) {
  return {
    code,
    name: record && record.channel && record.channel.name ? String(record.channel.name).slice(0, 80) : "",
    published: !!(record && record.published),
    updatedAt: record && Number.isFinite(record.updatedAt) ? record.updatedAt : null,
  };
}

// One batch. `cursor` is what the previous call returned as `next`; `done` is
// true when the whole set has been looked at.
async function removeOwnerlessChannels(env, { cursor, limit, apply } = {}) {
  if (!env || !env.CONFIGS) return { ok: false, error: "no-storage" };
  const n = Math.max(1, Math.min(OWNERLESS_CHANNELS_BATCH_MAX, Number(limit) || OWNERLESS_CHANNELS_BATCH));
  const out = { ok: true, apply: !!apply, scanned: 0, ownerless: [], deleted: 0, failed: [], unreadable: [], next: null, done: true };

  if (isV2ListsOnly(env)) {
    // Shared channels live in the new tables only: an owner that is NULL there.
    if (!listsV2Usable(env)) return { ok: false, error: "The new tables are not available." };
    const after = Math.max(0, Number(cursor) || 0);
    const { results } = await env.DB.prepare(
      "SELECT id, public_code, name, visibility, updated_at FROM channels WHERE owner_account_id IS NULL AND deleted_at IS NULL AND id > ? ORDER BY id LIMIT ?"
    ).bind(after, n).all();
    const rows = results || [];
    out.scanned = rows.length;
    for (const r of rows) {
      out.ownerless.push({ code: r.public_code, name: String(r.name || "").slice(0, 80), published: r.visibility === "public", updatedAt: r.updated_at || null });
      if (!apply) continue;
      try {
        if (await channelsV2Delete(env, r.public_code)) out.deleted++;
        else out.failed.push(r.public_code);
      } catch {
        out.failed.push(r.public_code);
      }
    }
    if (rows.length === n) {
      out.done = false;
      out.next = String(rows[rows.length - 1].id);
    }
    return out;
  }

  const listed = await env.CONFIGS.list({ prefix: "channelshare:", limit: n, ...(cursor ? { cursor: String(cursor) } : {}) });
  for (const k of listed.keys || []) {
    const code = k.name.slice("channelshare:".length);
    out.scanned++;
    let record = null;
    try {
      const raw = await env.CONFIGS.get(k.name);
      record = raw ? JSON.parse(raw) : null;
    } catch {
      record = null;
    }
    // A record that cannot be read is reported and left alone: whether it has an
    // owner is not known.
    if (!record || typeof record !== "object") {
      out.unreadable.push(code);
      continue;
    }
    if (record.owner) continue;
    out.ownerless.push(ownerlessChannelSummary(code, record));
    if (!apply) continue;
    try {
      await deleteSharedChannelEverywhere(env, code);
      out.deleted++;
    } catch (e) {
      console.error("ownerless channel: could not remove", code, e);
      out.failed.push(code);
    }
  }
  if (!listed.list_complete && listed.cursor) {
    out.done = false;
    out.next = listed.cursor;
  }
  return out;
}
