
// --- Shared channels on v2: channels rows plus R2 pools (Phase 3b, P3b-8) -----
//
// A shared channel (a share link, or a listing in Explore Channels) becomes a
// row in `channels` (migration 0016): its settings in definition_json, its
// counts in like_count / add_count, its likes in `likes` (target_type
// 'channel', and 'channel_add' for the once-per-account "added" signal), and
// its episodes -- up to 5,000 of them, megabytes of JSON -- as one object in
// the R2 bucket bound as BLOBS, at channels/{code}/{pool_version}.json.
//
// Writes, always once 0016 is applied (the same strangler as the lists,
// 34_lists-v2-bridge.js): /api/channel/share, /unpublish, /like, /added and
// the admin takedown still write the legacy KV store first, exactly as
// before, and then mirror the change here. A mirror that cannot finish
// clears the row's legacy_hash, and a row without one is never read.
// Without BLOBS the rows are still written (the directory, likes and adds
// need nothing else) and a channel's episodes are read from KV.
//
// Reads, with FF_V2_LISTS_READ: a channel opened by code or address, and the
// signed-out save that stores a listed channel's lineup, come from here when
// the row is current and its pool is in R2. Explore Channels, and a creator's
// own listings, come from here once the copy (30_lists-backfill.js, its
// "channels" phase) has finished, as the list directory does.
//
// The rotation code does not change: a channel read back from here is the
// same object the legacy store holds, so it plays the same lineup.
//
// Channels an account syncs between its own browsers (creatorsyncchannels:,
// the builder's private copies) stay in their sync blob; see P3b-8 in
// NEXT_VERSION_TASKS.md.

const CHANNELS_V2_SAMPLE = 9;                // episodes kept on the row for the directory card
const CHANNELS_V2_NAME_SORT_MAX = 5000;      // public channels the "name" order sorts in the Worker
const CHANNELS_V2_ROW_COLUMNS = "c.id, c.public_code, c.owner_account_id, c.slug, c.name, c.description, c.visibility, c.definition_json, c.pool_r2_key, c.pool_version, c.legacy_hash, c.item_count, c.show_count, c.like_count, c.add_count, c.published_at, c.created_at, c.updated_at, c.deleted_at, a.username AS owner_name";
const CHANNELS_V2_DIRECTORY_WHERE = "c.visibility = 'public' AND c.deleted_at IS NULL AND c.legacy_hash IS NOT NULL";
const CHANNELS_V2_DIRECTORY_ORDERS = {
  newest: "c.published_at DESC, c.id DESC",
  liked: "c.like_count DESC, c.add_count DESC, c.published_at DESC, c.id DESC",
  added: "c.add_count DESC, c.like_count DESC, c.published_at DESC, c.id DESC",
};

function channelsV2Blobs(env) {
  const b = env ? env.BLOBS : null;
  return b && typeof b.get === "function" && typeof b.put === "function" ? b : null;
}

function channelsV2PoolKey(code, version) {
  return `channels/${code}/${version}.json`;
}

async function channelsV2Hash(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// What a legacy record's row is copied from. Its like count is left out: the
// record carries a copy of it that every like rewrites, and likes are
// mirrored on their own.
function channelsV2LegacyHash(record, channel) {
  return channelsV2Hash([channel, record.description || "", record.owner || "", !!record.published, record.publishedAt || 0, record.updatedAt || 0]);
}

function channelsV2Definition(row) {
  try {
    const def = row && row.definition_json ? JSON.parse(row.definition_json) : {};
    return def && typeof def === "object" ? def : {};
  } catch {
    return {};
  }
}

// The channel settings as the legacy record holds them: the definition
// without the keys this file keeps beside them ("~sample", "~owner", "~pool").
function channelsV2Settings(def) {
  const out = {};
  for (const k of Object.keys(def)) if (!k.startsWith("~")) out[k] = def[k];
  return out;
}

async function channelsV2Row(env, code) {
  return env.DB.prepare(
    `SELECT ${CHANNELS_V2_ROW_COLUMNS} FROM channels c LEFT JOIN accounts a ON a.id = c.owner_account_id WHERE c.public_code = ?`
  ).bind(code).first();
}

// --- Reading ------------------------------------------------------------------

// A shared channel as the legacy record (`channelshare:{code}`): { code,
// channel, description, owner, published, publishedAt, updatedAt, likes,
// adds }. null: read the legacy store (flag off, no row, a row behind the
// legacy store, or -- with opts.items -- no pool in R2).
async function channelsV2Record(env, code, opts = {}) {
  if (!isV2ListsReadEnabled(env) || !listsV2Usable(env)) return null;
  try {
    const row = await channelsV2Row(env, code);
    if (!row || row.deleted_at != null || !row.legacy_hash) return null;
    const def = channelsV2Definition(row);
    let items = Array.isArray(def["~sample"]) ? def["~sample"] : [];
    if (opts.items) {
      const blobs = channelsV2Blobs(env);
      if (!blobs || !row.pool_r2_key) return null;
      const obj = await blobs.get(row.pool_r2_key);
      if (!obj) return null;
      items = JSON.parse(await obj.text());
      if (!Array.isArray(items)) return null;
    }
    const channel = opts.items ? sanitizeSharedChannel({ ...channelsV2Settings(def), items }) : { ...channelsV2Settings(def), items };
    if (!channel) return null;
    return {
      code: row.public_code,
      channel,
      description: row.description || "",
      owner: row.owner_name || def["~owner"] || "",
      published: row.visibility === "public",
      publishedAt: row.created_at,
      updatedAt: row.updated_at,
      likes: row.like_count || 0,
      adds: row.add_count || 0,
    };
  } catch (e) {
    noteListsV2Error(env, e, "channel read");
    return null;
  }
}

// The code a creator's /channels/{user}/{slug} address names: the channel of
// theirs with that slug that was listed most recently. null: ask the legacy
// store (which also still knows the slugs a renamed channel had before).
async function channelsV2CodeBySlug(env, username, slug) {
  if (!isV2ListsReadEnabled(env) || !listsV2Usable(env)) return null;
  try {
    const row = await env.DB.prepare(
      `SELECT c.public_code FROM channels c JOIN accounts a ON a.id = c.owner_account_id
       WHERE a.username = ? COLLATE NOCASE AND c.slug = ? AND c.published_at IS NOT NULL AND c.deleted_at IS NULL AND c.legacy_hash IS NOT NULL
       ORDER BY c.published_at DESC, c.id DESC LIMIT 1`
    ).bind(String(username || ""), String(slug || "").toLowerCase()).first();
    return row ? row.public_code : null;
  } catch (e) {
    noteListsV2Error(env, e, "channel address");
    return null;
  }
}

// One Explore Channels card, exactly as sharedChannelSummary builds it from a
// legacy record and its directory row.
function channelsV2Summary(row) {
  const def = channelsV2Definition(row);
  const summary = sharedChannelSummary(row.public_code, {
    channel: { ...channelsV2Settings(def), items: Array.isArray(def["~sample"]) ? def["~sample"] : [] },
    description: row.description || "",
    likes: row.like_count || 0,
    adds: row.add_count || 0,
    owner: row.owner_name || def["~owner"] || "",
    publishedAt: row.created_at || 0,
  });
  summary.itemCount = row.item_count || 0;
  summary.showCount = row.show_count || 0;
  return summary;
}

// The public listings in one of the directory's orders. "name" sorts in the
// Worker, with the legacy comparator, over the Newest order -- the same
// stable sort the legacy index gets.
async function channelsV2DirectoryRows(env, sort, limit, extraWhere = "", args = []) {
  const order = CHANNELS_V2_DIRECTORY_ORDERS[sort] || CHANNELS_V2_DIRECTORY_ORDERS.newest;
  const byName = sort === "name";
  const { results } = await env.DB.prepare(
    `SELECT ${CHANNELS_V2_ROW_COLUMNS} FROM channels c LEFT JOIN accounts a ON a.id = c.owner_account_id
     WHERE ${CHANNELS_V2_DIRECTORY_WHERE}${extraWhere} ORDER BY ${byName ? CHANNELS_V2_DIRECTORY_ORDERS.newest : order} LIMIT ?`
  ).bind(...args, byName ? CHANNELS_V2_NAME_SORT_MAX : limit).all();
  const rows = results || [];
  if (byName) rows.sort((a, b) => String(a.name || "").toLowerCase().localeCompare(String(b.name || "").toLowerCase()));
  return rows.slice(0, limit);
}

// Explore Channels are read from v2 once the copy has finished.
async function channelsV2DirectoryActive(env) {
  if (!isV2ListsReadEnabled(env) || !listsV2Usable(env)) return false;
  try {
    return await v2ListsCopyFinished(env);
  } catch (e) {
    noteListsV2Error(env, e, "channel directory check");
    return false;
  }
}

// /api/channel/directory from v2, or null for the legacy index.
async function channelsV2DirectoryResponse(env, url) {
  if (!(await channelsV2DirectoryActive(env))) return null;
  try {
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "60", 10) || 60, 1), PUBLIC_CHANNEL_INDEX_MAX);
    const sort = String(url.searchParams.get("sort") || "newest");
    const rows = await channelsV2DirectoryRows(env, sort, limit);
    const counted = await env.DB.prepare(`SELECT count(*) AS n FROM channels c WHERE ${CHANNELS_V2_DIRECTORY_WHERE}`).first();
    return json({
      ok: true,
      total: Number(counted && counted.n) || 0,
      sort,
      channels: rows.map(channelsV2Summary),
    }, 200, { "Cache-Control": "public, max-age=120" });
  } catch (e) {
    noteListsV2Error(env, e, "channel directory");
    return null;
  }
}

// A creator's own listings (/api/channel/mine, and the admin view of the
// directory), newest first. null: the legacy index.
async function channelsV2Listings(env, username) {
  if (!(await channelsV2DirectoryActive(env))) return null;
  try {
    const rows = username
      ? await channelsV2DirectoryRows(env, "newest", PUBLIC_CHANNEL_INDEX_MAX, " AND a.username = ? COLLATE NOCASE", [String(username)])
      : await channelsV2DirectoryRows(env, "newest", PUBLIC_CHANNEL_INDEX_MAX);
    return rows.map(channelsV2Summary);
  } catch (e) {
    noteListsV2Error(env, e, "channel listings");
    return null;
  }
}

// --- Writing ------------------------------------------------------------------

async function channelsV2MarkStale(env, code) {
  try {
    await env.DB.prepare("UPDATE channels SET legacy_hash = NULL WHERE public_code = ?").bind(code).run();
  } catch (e) {
    noteListsV2Error(env, e, "marking a channel stale");
  }
}

function channelsV2LikeBudget() {
  return { meter: { ops: 0 }, maxOps: Infinity, items: 0, lookups: 0, accountIds: new Map() };
}

// Carries a channel's legacy likes and adds across: the ledgers' voters as
// rows, and counts that never go below the legacy totals (D-9).
async function channelsV2CopyCounts(env, code, legacyLikes, legacyAdds, budget, recon) {
  const voters = await syncLegacyLikes(env, "channel", code, `ch:${code}`, `channellikevoters:${code}`, budget);
  const adders = await syncLegacyLikes(env, "channel_add", code, `channeladdvoters:${code}`, `channeladdvoters:${code}`, budget);
  await env.DB.prepare("UPDATE channels SET like_count = max(?, ?), add_count = max(?, ?) WHERE public_code = ?")
    .bind(legacyLikes, voters, legacyAdds, adders, code).run();
  if (recon) {
    recon.likes.legacy += legacyLikes;
    recon.likes.voters += voters;
    if (legacyLikes > voters) recon.likes.keptFromCount += legacyLikes - voters;
    recon.adds.legacy += legacyAdds;
    recon.adds.adders += adders;
    if (legacyAdds > adders) recon.adds.keptFromCount += legacyAdds - adders;
  }
}

// Brings a channel's row in line with its legacy record: its settings, its
// pool in R2 (a new object only when the episodes changed), its listing. A
// row that is already newer than this record is left alone, so two saves of
// one channel racing each other cannot leave the older one behind. Returns
// "unchanged", "written", "newer" or "unreadable"; `created` when the row is
// new. `index` is the record's directory row, for the counts of a new row.
async function writeChannelFromLegacy(env, code, record, index, budget, recon) {
  const channel = record && record.channel ? sanitizeSharedChannel(record.channel) : null;
  if (!channel) return { status: "unreadable" };
  const blobs = channelsV2Blobs(env);
  const hash = await channelsV2LegacyHash(record, channel);
  const existing = await env.DB.prepare(
    "SELECT id, definition_json, pool_r2_key, pool_version, legacy_hash, published_at, updated_at, deleted_at FROM channels WHERE public_code = ?"
  ).bind(code).first();
  const live = existing && existing.deleted_at == null;
  if (live && existing.legacy_hash === hash && (existing.pool_r2_key || !blobs)) return { status: "unchanged" };

  const items = channel.items;
  const def = { ...channel };
  delete def.items;
  def["~sample"] = items.slice(0, CHANNELS_V2_SAMPLE);
  def["~pool"] = await channelsV2Hash(items);
  const owner = record.owner ? await listsV2Account(env, record.owner) : null;
  if (record.owner && !owner) def["~owner"] = record.owner;

  let poolKey = live ? existing.pool_r2_key : null;
  let poolVersion = existing ? existing.pool_version : 0;
  let wrotePool = null;
  if (blobs && (!poolKey || channelsV2Definition(existing)["~pool"] !== def["~pool"])) {
    poolVersion += 1;
    wrotePool = channelsV2PoolKey(code, poolVersion);
    await blobs.put(wrotePool, JSON.stringify(items), { httpMetadata: { contentType: "application/json" } });
    poolKey = wrotePool;
  }

  const now = Date.now();
  const updatedAt = Number(record.updatedAt) || now;
  const createdAt = Number(record.publishedAt) || updatedAt;
  // A listing goes to the top of Newest whenever it is (re)published: the
  // legacy index moves it to the front on every share of a listed channel.
  const publishedAt = record.published ? updatedAt : (existing ? existing.published_at : null);
  const showCount = new Set(items.map(channelItemShowKey)).size;
  const legacyLikes = Math.max(Number(record.likes) || 0, Number(index && index.likes) || 0);
  const legacyAdds = Number(index && index.adds) || 0;
  const res = await env.DB.prepare(
    `INSERT INTO channels (public_code, owner_account_id, client_id, slug, name, description, visibility, definition_json, pool_r2_key,
       pool_version, legacy_hash, item_count, show_count, like_count, add_count, published_at, created_at, updated_at, deleted_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(public_code) DO UPDATE SET owner_account_id = excluded.owner_account_id, slug = excluded.slug, name = excluded.name,
       description = excluded.description, visibility = excluded.visibility, definition_json = excluded.definition_json,
       pool_r2_key = excluded.pool_r2_key, pool_version = excluded.pool_version, legacy_hash = excluded.legacy_hash,
       item_count = excluded.item_count, show_count = excluded.show_count, published_at = excluded.published_at,
       created_at = excluded.created_at, updated_at = excluded.updated_at, deleted_at = NULL
     WHERE channels.updated_at <= excluded.updated_at OR channels.deleted_at IS NOT NULL OR channels.legacy_hash IS NULL`
  ).bind(code, owner ? owner.id : null, slugifyServer(channel.name || "channel"), channel.name, record.description || "",
    record.published ? "public" : "unlisted", JSON.stringify(def), poolKey, poolVersion, hash, items.length, showCount,
    legacyLikes, legacyAdds, publishedAt, createdAt, updatedAt).run();
  const applied = Number(res && res.meta && res.meta.changes) > 0;
  if (!applied) {
    if (wrotePool) await blobs.delete(wrotePool).catch(() => {});
    return { status: "newer" };
  }
  if (wrotePool && live && existing.pool_r2_key && existing.pool_r2_key !== wrotePool) {
    await blobs.delete(existing.pool_r2_key).catch(() => {});
  }
  // A row that is new, or back from deleted, takes the legacy likes and adds
  // with it, so its counts and voters are right from the start.
  const created = !live;
  if (created) await channelsV2CopyCounts(env, code, legacyLikes, legacyAdds, budget || channelsV2LikeBudget(), recon);
  return { status: "written", created, poolWritten: !!wrotePool };
}

// After a legacy route has written a channel's record (share, unpublish, an
// admin unlist): the same change into v2. `record` is what the route just
// wrote, or null to read it back (and a record that is gone retires the
// row). Returns false when the mirror could not finish; the row is then
// marked stale.
async function channelsV2SyncShare(env, code, record) {
  if (!listsV2Usable(env)) return true;
  try {
    let rec = record || null;
    if (!rec) {
      const raw = env.CONFIGS ? await env.CONFIGS.get(`channelshare:${code}`) : null;
      rec = raw ? JSON.parse(raw) : null;
    }
    if (!rec) return await channelsV2Delete(env, code);
    const existing = await env.DB.prepare("SELECT id FROM channels WHERE public_code = ? AND deleted_at IS NULL").bind(code).first();
    const index = existing ? null : (await readPublicChannelIndex(env)).find((e) => e && e.code === code) || null;
    const out = await writeChannelFromLegacy(env, code, rec, index, null, null);
    if (out.status === "unreadable") {
      await channelsV2MarkStale(env, code);
      return false;
    }
    return true;
  } catch (e) {
    noteListsV2Error(env, e, "channel mirror");
    if (!listsV2Usable(env)) return true;
    await channelsV2MarkStale(env, code);
    return false;
  }
}

// After /api/channel/like changed the legacy ledger: the same like in v2.
// Returns the channel's v2 like count, or null when v2 has no such channel.
async function channelsV2MirrorLike(env, code, voterUsername, liking) {
  if (!listsV2Usable(env)) return null;
  try {
    const row = await env.DB.prepare("SELECT id FROM channels WHERE public_code = ? AND deleted_at IS NULL").bind(code).first();
    if (!row) return null;
    const voterAccount = await listsV2Account(env, voterUsername);
    if (!voterAccount) return null;
    const target = { type: "channel", targetId: code, table: "channels", key: "public_code" };
    const voter = `acct:${voterAccount.id}`;
    if ((await hasLiked(env, target, voter)) !== liking) await env.DB.batch(likeWriteStatements(env, target, voter, liking, voterAccount.id));
    return await likeTargetCount(env, target);
  } catch (e) {
    noteListsV2Error(env, e, "channel like mirror");
    return null;
  }
}

// After /api/channel/added counted an account for the first time.
async function channelsV2MirrorAdd(env, code, adderUsername) {
  if (!listsV2Usable(env)) return;
  try {
    const adder = await listsV2Account(env, adderUsername);
    if (!adder) return;
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO likes (target_type, target_id, voter, created_at) VALUES ('channel_add', ?, ?, ?)")
        .bind(code, `acct:${adder.id}`, Date.now()),
      env.DB.prepare("UPDATE channels SET add_count = add_count + changes() WHERE public_code = ?").bind(code),
    ]);
  } catch (e) {
    noteListsV2Error(env, e, "channel add mirror");
  }
}

// An admin "delete": the row, its likes and adds, and its pool go. Returns
// false when v2 could not be updated, so the takedown is reported as not
// finished rather than leaving the channel reachable here.
async function channelsV2Delete(env, code) {
  if (!listsV2Usable(env)) return true;
  try {
    const row = await env.DB.prepare("SELECT id, pool_r2_key FROM channels WHERE public_code = ?").bind(code).first();
    if (!row) return true;
    await env.DB.batch([
      env.DB.prepare("UPDATE channels SET deleted_at = ?, legacy_hash = NULL, pool_r2_key = NULL WHERE id = ?").bind(Date.now(), row.id),
      env.DB.prepare("DELETE FROM likes WHERE target_type IN ('channel', 'channel_add') AND target_id = ?").bind(code),
    ]);
    const blobs = channelsV2Blobs(env);
    if (blobs && row.pool_r2_key) await blobs.delete(row.pool_r2_key).catch(() => {});
    return true;
  } catch (e) {
    noteListsV2Error(env, e, "channel delete");
    return !listsV2Usable(env);
  }
}

// --- The copy (30_lists-backfill.js, its "channels" phase) --------------------

function emptyChannelsRecon() {
  return {
    channels: { legacy: 0, copied: 0, unchanged: 0, unreadable: 0, listed: 0 },
    pools: { written: 0, skipped: 0, items: 0 },
    likes: { legacy: 0, voters: 0, keptFromCount: 0 },
    adds: { legacy: 0, adders: 0, keptFromCount: 0 },
    samples: { unreadable: [] },
  };
}

async function legacySharedChannelCodes(env) {
  const out = [];
  if (!env.CONFIGS) return out;
  let cursor;
  do {
    const res = await env.CONFIGS.list({ prefix: "channelshare:", ...(cursor ? { cursor } : {}) });
    for (const k of res.keys || []) {
      const code = k.name.slice("channelshare:".length);
      if (code) out.push(code);
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  return out;
}

async function backfillSharedChannel(env, code, index, budget, recon) {
  recon.channels.legacy++;
  let record = null;
  try {
    const raw = await env.CONFIGS.get(`channelshare:${code}`);
    record = raw ? JSON.parse(raw) : null;
  } catch {
    record = null;
  }
  const out = record ? await writeChannelFromLegacy(env, code, record, index, budget, recon) : { status: "unreadable" };
  if (out.status === "unreadable") {
    recon.channels.unreadable++;
    listsBackfillSample(recon.samples.unreadable, code);
    return;
  }
  if (record.published) recon.channels.listed++;
  if (out.status === "unchanged" || out.status === "newer") recon.channels.unchanged++;
  else recon.channels.copied++;
  if (out.poolWritten) recon.pools.written++;
  else if (!channelsV2Blobs(env)) recon.pools.skipped++;
  recon.pools.items += Array.isArray(record.channel && record.channel.items) ? record.channel.items.length : 0;
  // A row this copy did not just create still takes the ledgers across: a
  // re-run picks up likes and adds since.
  if (!out.created) {
    const legacyLikes = Math.max(Number(record.likes) || 0, Number(index && index.likes) || 0);
    await channelsV2CopyCounts(env, code, legacyLikes, Number(index && index.adds) || 0, budget, recon);
  }
}

// Every channelshare: record, a bounded number per step. Returns true once
// they are all copied.
async function backfillSharedChannels(env, run, budget) {
  const st = run.chan || (run.chan = { codes: null, next: 0, recon: emptyChannelsRecon() });
  if (!st.codes) st.codes = await legacySharedChannelCodes(env);
  if (st.next >= st.codes.length) return true;
  const index = new Map((await readPublicChannelIndex(env)).filter((e) => e && e.code).map((e) => [e.code, e]));
  while (st.next < st.codes.length) {
    if (!listsBackfillOpsLeft(budget)) return false;
    await backfillSharedChannel(env, st.codes[st.next], index.get(st.codes[st.next]) || null, budget, st.recon);
    st.next++;
  }
  return true;
}
