// --- Anonymous like votes are removed (D-37) -----------------------------------
//
// Before D-6 a signed-out visitor could like a list, an outside list or a channel.
// The vote was stored under the voter id "a:<32 hex>", a hash of the visitor's IP
// address and the target that can be reversed to the address. The owner decided
// (2026-11-02) to keep none of them, and to lower every like total by the votes
// removed, so each total equals the signed-in likes behind it.
// /admin/api/anonymous-likes-purge counts them (the default) and removes them in
// batches, only when told to and only with the confirmation phrase.
//
// Where votes and totals are kept, per target:
//   Old store (one total, read when the new tables are not read):
//     votes   KV listlikevoters:* / extlikevoters:* / channellikevoters:*  AND
//             D1 list_likes (list_id c:<user>:<slug>, a:<slug>, ext:<hash>, ch:<code>)
//     totals  KV creatorlist:<user>:<slug> / publishedlist:user:<slug> /
//             externallike:<hash> / channelshare:<code> ("likes"), the channel
//             directory row in index:publicchannels, D1 creator_lists.likes /
//             published_lists.likes
//     applyLikeVote derives the total from the union of the KV ledger and
//     list_likes, so the same vote held in both is ONE vote: the old totals go
//     down by the number of distinct anonymous ids, not by the rows removed.
//   New tables (their own total, kept separately by the copy):
//     votes   D1 likes (target_type list / channel / external)
//     totals  D1 lists.like_count, channels.like_count (an outside list has none:
//             its count is its rows)
//     lowered by the number of anonymous rows removed from `likes`.
// Not touched: channel "added" records (likes rows of type channel_add, list_likes
// rows under channeladdvoters:*) and add_count; the lists and channels themselves.
// Signed-in voters ("u:<name>", "acct:<id>") are never touched.
//
// One call = one batch of one phase; `next` carries the phase and where it stopped.

const ANON_LIKES_PURGE_CONFIRM = "delete anonymous likes";
const ANON_LIKES_PURGE_BATCH = 10;
const ANON_LIKES_PURGE_BATCH_MAX = 50;
const ANON_LIKES_PURGE_KV_PHASES = { list: "listlikevoters:", ext: "extlikevoters:", chan: "channellikevoters:" };
const ANON_LIKES_PURGE_PHASES = ["list", "ext", "chan", "d1", "v2"];
const ANON_LIKES_PURGE_LEGACY_IDS = "(list_id LIKE 'c:%' OR list_id LIKE 'a:%' OR list_id LIKE 'ext:%' OR list_id LIKE 'ch:%')";

// The only anonymous form there ever was: "a:" plus a hash (likeVoterId, before D-37).
function isAnonymousLikeVoter(voter) {
  return typeof voter === "string" && voter.startsWith("a:");
}

function anonLikesLedgerKeyFor(listId) {
  if (listId.startsWith("c:")) return `listlikevoters:${listId.slice(2)}`;
  if (listId.startsWith("a:")) return `listlikevoters:user:${listId.slice(2)}`;
  if (listId.startsWith("ext:")) return `extlikevoters:${listId.slice(4)}`;
  if (listId.startsWith("ch:")) return `channellikevoters:${listId.slice(3)}`;
  return "";
}

async function anonLikesD1Voters(env, listId) {
  if (!env.DB) return [];
  try {
    const res = await env.DB.prepare("SELECT voter_id FROM list_likes WHERE list_id = ? AND substr(voter_id, 1, 2) = 'a:'").bind(listId).all();
    return ((res && res.results) || []).map((r) => r.voter_id);
  } catch {
    return []; // list_likes not migrated yet: nothing was ever stored there
  }
}

// --- Progress records (safe to re-run) ---------------------------------------
//
// Lowering a total is not repeatable, and a target is changed in several places
// (KV records, D1, the ledger) that cannot be written as one. So before the first
// write to a target a record is saved in KV (anonlikespurge:...) holding the number
// of votes to take off and what each total was BEFORE. A total is then set to
// max(0, before - n) only while it still equals `before`: run again after a failure
// and a total that was already lowered no longer matches, so it is left alone.
// The votes themselves are removed last, because they are how a target is found
// again; the record is deleted when the target is finished.

const ANON_LIKES_PURGE_MARKER = "anonlikespurge:";

async function anonLikesReadMarker(env, key) {
  const raw = await env.CONFIGS.get(key);
  if (!raw) return null;
  try {
    const m = JSON.parse(raw);
    return m && Number.isFinite(m.n) ? m : null;
  } catch {
    return null;
  }
}

function anonLikesRecordKey(listId) {
  const rest = listId.slice(listId.indexOf(":") + 1);
  if (listId.startsWith("c:")) return `creatorlist:${rest}`;
  if (listId.startsWith("a:")) return `publishedlist:user:${rest}`;
  if (listId.startsWith("ext:")) return `externallike:${rest}`;
  if (listId.startsWith("ch:")) return `channelshare:${rest}`;
  return "";
}

async function anonLikesKvLikes(env, key) {
  const raw = key ? await env.CONFIGS.get(key) : null;
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw);
    return rec && typeof rec === "object" ? Number(rec.likes) || 0 : null;
  } catch {
    return null;
  }
}

// What each old-store total of one target is right now (null: there is none).
async function anonLikesTotalsBefore(env, listId) {
  const rest = listId.slice(listId.indexOf(":") + 1);
  const before = { rec: await anonLikesKvLikes(env, anonLikesRecordKey(listId)), idx: null, d1: null };
  if (listId.startsWith("ch:")) {
    const entry = (await readPublicChannelIndex(env)).find((e) => e && e.code === rest);
    if (entry) before.idx = Number(entry.likes) || 0;
  }
  const table = listId.startsWith("c:") ? ["creator_lists", "likes", "id"] : listId.startsWith("a:") ? ["published_lists", "likes", "slug"] : null;
  if (table && env.DB) {
    const row = await env.DB.prepare(`SELECT ${table[1]} AS n FROM ${table[0]} WHERE ${table[2]} = ?`).bind(rest).first();
    if (row) before.d1 = Number(row.n) || 0;
  }
  return before;
}

// Sets every old-store total of one target to max(0, before - n), each only while
// it still holds `before`.
async function anonLikesLowerTotals(env, listId, before, n) {
  const rest = listId.slice(listId.indexOf(":") + 1);
  const key = anonLikesRecordKey(listId);
  if (before.rec !== null && (await anonLikesKvLikes(env, key)) === before.rec && before.rec !== Math.max(0, before.rec - n)) {
    const rec = JSON.parse(await env.CONFIGS.get(key));
    rec.likes = Math.max(0, before.rec - n);
    await env.CONFIGS.put(key, JSON.stringify(rec));
  }
  if (before.idx !== null) {
    const entry = (await readPublicChannelIndex(env)).find((e) => e && e.code === rest);
    const target = Math.max(0, before.idx - n);
    if (entry && (Number(entry.likes) || 0) === before.idx && target !== before.idx) await updatePublicChannelIndexEntry(env, rest, { likes: target });
  }
  if (before.d1 !== null && env.DB) {
    const table = listId.startsWith("c:") ? ["creator_lists", "likes", "id"] : ["published_lists", "likes", "slug"];
    await env.DB.prepare(`UPDATE ${table[0]} SET ${table[1]} = ? WHERE ${table[2]} = ? AND ${table[1]} = ?`)
      .bind(Math.max(0, before.d1 - n), rest, before.d1).run();
  }
}

// One old-store target: counts its anonymous votes (the union of the KV ledger
// and list_likes) and, with `apply`, lowers its totals by that number and then
// removes the votes. A progress record from an interrupted run is picked up: its
// `n` is the number to take off, not what is left.
async function anonLikesPurgeLegacyTarget(env, listId, ledgerKey, apply, out) {
  const markerKey = `${ANON_LIKES_PURGE_MARKER}legacy:${listId}`;
  const marker = await anonLikesReadMarker(env, markerKey);
  const kvAnon = new Set((await readLikeVotersFromKv(env, ledgerKey)).filter(isAnonymousLikeVoter));
  const d1Anon = new Set(await anonLikesD1Voters(env, listId));
  const anon = new Set([...kvAnon, ...d1Anon]);
  out.scanned++;
  if (!anon.size) {
    if (marker && apply) await env.CONFIGS.delete(markerKey); // finished, only the record was left
    return;
  }
  const n = marker ? marker.n : anon.size;
  out.legacyTargets++;
  out.kvVotes += kvAnon.size;
  out.d1Votes += d1Anon.size;
  out.legacyVotes += n;
  if (!apply) return;
  try {
    const saved = marker || { n, before: await anonLikesTotalsBefore(env, listId) };
    if (!marker) await env.CONFIGS.put(markerKey, JSON.stringify(saved));
    await anonLikesLowerTotals(env, listId, saved.before, saved.n);
    if (d1Anon.size && env.DB) {
      await env.DB.prepare("DELETE FROM list_likes WHERE list_id = ? AND substr(voter_id, 1, 2) = 'a:'").bind(listId).run();
    }
    if (kvAnon.size) {
      const kept = (await readLikeVotersFromKv(env, ledgerKey)).filter((v) => !isAnonymousLikeVoter(v));
      if (kept.length) await env.CONFIGS.put(ledgerKey, JSON.stringify([...new Set(kept)]));
      else await env.CONFIGS.delete(ledgerKey);
    }
    await env.CONFIGS.delete(markerKey);
  } catch (e) {
    out.failed.push(ledgerKey);
    console.error("anonymous-likes-purge failed for", ledgerKey, e);
  }
}

// A KV phase: the ledgers under one prefix. Returns where to go on, or null.
async function anonLikesPurgeKvPhase(env, phase, inner, n, apply, out) {
  const prefix = ANON_LIKES_PURGE_KV_PHASES[phase];
  const listed = await env.CONFIGS.list({ prefix, limit: n, ...(inner ? { cursor: inner } : {}) });
  for (const k of listed.keys || []) {
    const ledgerKey = k.name;
    await anonLikesPurgeLegacyTarget(env, ledgerKeyToListId(ledgerKey), ledgerKey, apply, out);
  }
  return listed.list_complete ? null : listed.cursor || null;
}

// The D1 phase: targets whose anonymous votes are in list_likes. A target that
// has a KV ledger was handled in the phases before this one (a dry run, which
// removed nothing, must not count it twice).
async function anonLikesPurgeD1Phase(env, inner, n, apply, out) {
  if (!env.DB) return null;
  let rows = [];
  try {
    const res = await env.DB.prepare(
      `SELECT DISTINCT list_id FROM list_likes WHERE substr(voter_id, 1, 2) = 'a:' AND ${ANON_LIKES_PURGE_LEGACY_IDS} AND list_id > ? ORDER BY list_id LIMIT ?`
    ).bind(inner || "", n).all();
    rows = (res && res.results) || [];
  } catch {
    return null;
  }
  for (const r of rows) {
    const ledgerKey = anonLikesLedgerKeyFor(r.list_id);
    if (!apply && (await env.CONFIGS.get(ledgerKey))) continue;
    await anonLikesPurgeLegacyTarget(env, r.list_id, ledgerKey, apply, out);
  }
  return rows.length === n ? rows[rows.length - 1].list_id : null;
}

// The new tables: anonymous rows in `likes`, and the total they were counted in.
async function anonLikesPurgeV2Phase(env, inner, n, apply, out) {
  if (!env.DB) return null;
  const [afterType, afterId] = inner ? inner.split("|") : ["", ""];
  let rows = [];
  try {
    const res = await env.DB.prepare(
      "SELECT target_type, target_id, COUNT(*) AS n FROM likes WHERE substr(voter, 1, 2) = 'a:' AND target_type IN ('list', 'channel', 'external') " +
      "AND (target_type > ? OR (target_type = ? AND target_id > ?)) GROUP BY target_type, target_id ORDER BY target_type, target_id LIMIT ?"
    ).bind(afterType, afterType, afterId || "", n).all();
    rows = (res && res.results) || [];
  } catch {
    return null; // the new tables are not there yet
  }
  for (const r of rows) {
    out.scanned++;
    out.v2Targets++;
    const markerKey = `${ANON_LIKES_PURGE_MARKER}v2:${r.target_type}:${r.target_id}`;
    const marker = await anonLikesReadMarker(env, markerKey);
    const count = marker ? marker.n : Number(r.n) || 0;
    out.v2Votes += count;
    if (!apply) continue;
    try {
      const table = r.target_type === "list" ? ["lists", "like_count", "public_id"] : r.target_type === "channel" ? ["channels", "like_count", "public_code"] : null;
      let saved = marker;
      if (!saved) {
        let before = null;
        if (table) {
          const row = await env.DB.prepare(`SELECT ${table[1]} AS n FROM ${table[0]} WHERE ${table[2]} = ?`).bind(r.target_id).first();
          if (row) before = Number(row.n) || 0;
        }
        saved = { n: count, before };
        await env.CONFIGS.put(markerKey, JSON.stringify(saved));
      }
      if (table && saved.before !== null) {
        await env.DB.prepare(`UPDATE ${table[0]} SET ${table[1]} = ? WHERE ${table[2]} = ? AND ${table[1]} = ?`)
          .bind(Math.max(0, saved.before - saved.n), r.target_id, saved.before).run();
      }
      await env.DB.prepare("DELETE FROM likes WHERE target_type = ? AND target_id = ? AND substr(voter, 1, 2) = 'a:'").bind(r.target_type, r.target_id).run();
      await env.CONFIGS.delete(markerKey);
    } catch (e) {
      out.failed.push(`${r.target_type}:${r.target_id}`);
      console.error("anonymous-likes-purge failed for", r.target_type, r.target_id, e);
    }
  }
  if (rows.length !== n) return null;
  const last = rows[rows.length - 1];
  return `${last.target_type}|${last.target_id}`;
}

// One batch. `cursor` is the previous call's `next` ("<phase>:<where it stopped>").
async function purgeAnonymousLikes(env, { cursor, limit, apply } = {}) {
  if (!env || !env.CONFIGS) return { ok: false, error: "no-storage" };
  const n = Math.max(1, Math.min(ANON_LIKES_PURGE_BATCH_MAX, Number(limit) || ANON_LIKES_PURGE_BATCH));
  const text = cursor ? String(cursor) : "list:";
  const cut = text.indexOf(":");
  const phase = cut < 0 ? "" : text.slice(0, cut);
  const inner = cut < 0 ? "" : text.slice(cut + 1);
  if (!ANON_LIKES_PURGE_PHASES.includes(phase)) return { ok: false, error: "That cursor is not one this job gave out." };
  const out = { ok: true, apply: !!apply, phase, scanned: 0, legacyTargets: 0, kvVotes: 0, d1Votes: 0, legacyVotes: 0, v2Targets: 0, v2Votes: 0, failed: [], next: null, done: true };
  let more;
  if (ANON_LIKES_PURGE_KV_PHASES[phase]) more = await anonLikesPurgeKvPhase(env, phase, inner, n, !!apply, out);
  else if (phase === "d1") more = await anonLikesPurgeD1Phase(env, inner, n, !!apply, out);
  else more = await anonLikesPurgeV2Phase(env, inner, n, !!apply, out);
  const following = ANON_LIKES_PURGE_PHASES[ANON_LIKES_PURGE_PHASES.indexOf(phase) + 1];
  if (more) out.next = `${phase}:${more}`;
  else if (following) out.next = `${following}:`;
  out.done = out.next === null;
  if (out.failed.length) out.ok = false;
  return out;
}
