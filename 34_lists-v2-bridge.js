
// --- Lists v2: the legacy routes over v2, and the read switch (Phase 3b, P3b-7) ---
//
// Writes, always once migration 0016 is applied: every legacy route that
// changes a list -- save, delete, reorder, like, account reset and deletion --
// still writes the legacy store first, exactly as before, and then mirrors
// the change into v2. A list's items are mirrored as a DIFF (adds, removes,
// moves, changed details), never as a wholesale replace. So the legacy store
// stays complete and current -- turning FF_V2_LISTS_READ off is a clean
// rollback -- and v2 keeps pace with it from the day the tables exist, not
// from the day reads switch. A mirror that cannot finish marks the account's
// v2 copy stale (its migrate.lists job goes back to 'queued'), and reads go
// back to the legacy store for that account until the copy is refreshed.
// P3b-9 removes the legacy half.
//
// Reads, with FF_V2_LISTS_READ: the dashboard (/api/creator/lists), list
// contents (/api/creator/lists/items), public list pages and Custom List
// catalog rows come from v2, for an account whose copy has finished. The
// dashboard and list contents copy an account that has not been copied yet
// on the spot, within a small budget ("migrate on read"); anything else reads
// the legacy store for it until then. Items come back exactly as they were
// saved (legacyItemFromEntryRow). The Watchlist stays on the legacy store:
// playback tracking rewrites it, and it moves with the activity data (3c).

const LISTS_V2_READY_TTL_MS = 60000;
const LISTS_V2_CATALOG_TTL_MS = 300000;
const LISTS_V2_MIRROR_ITEMS_MAX = PUBLISHED_LIST_ITEMS_MAX; // the most a list can hold: the bulk statements carry it
const LISTS_V2_MIRROR_STATEMENTS_MAX = 600;   // statements one save may write in its one batch
const LISTS_V2_MIRROR_LOOKUPS = 25;           // TMDB lookups a save may spend; the rest become stubs
const LISTS_V2_UPDATE_ROWS = 19;              // rows per CASE UPDATE: 5 parameters each
const LISTS_V2_LIST_COLUMNS = "id, public_id, slug, name, kind, media_type, visibility, item_count, like_count, source_ref, source_json, synced_at, position, version, created_at, updated_at, deleted_at";
const LISTS_V2_ENTRY_COLUMNS = "li.id AS entry_id, li.list_id, li.media_id, li.season, li.episode, li.position, li.extra_json, m.kind, m.imdb_id, m.tmdb_id, m.alt_id, m.title, m.year, m.poster_path";
// Per isolate. The readiness entries and the missing-table back-off belong
// to the database they were read from (a test runs many); catalog items are
// keyed by the list's public_id and version, which no other list reuses.
const listsV2ReadyCache = new Map();
const listsV2CatalogCache = new Map();
let listsV2TablesMissing = { db: null, until: 0 };

class ListsV2TooLarge extends Error {}

function listsV2Usable(env) {
  if (!env || !env.DB) return false;
  return !(listsV2TablesMissing.db === env.DB && Date.now() < listsV2TablesMissing.until);
}

// Before 0016 is applied every v2 query fails the same way; stop trying for a
// while rather than logging it on every save.
function noteListsV2Error(env, e, what) {
  const msg = String((e && e.message) || e || "");
  if (/no such table|no such column/i.test(msg)) {
    listsV2TablesMissing = { db: env && env.DB, until: Date.now() + 600000 };
    return;
  }
  console.error(`lists v2 ${what} failed:`, e);
}

async function listsV2Account(env, username) {
  return env.DB.prepare(
    "SELECT id, username, display_name FROM accounts WHERE username = ? COLLATE NOCASE AND deleted_at IS NULL"
  ).bind(String(username || "")).first();
}

function listsV2JobKey(accountId) {
  return `${LISTS_BACKFILL_TYPE}:acct:${accountId}`;
}

// { account, ready } for reads, or null when reads stay on the legacy store
// (flag off, no database, 0016 not applied). Cached a minute per isolate.
async function listsV2Ready(env, username) {
  if (!isV2ListsReadEnabled(env) || !listsV2Usable(env)) return null;
  const key = String(username || "").toLowerCase();
  const hit = listsV2ReadyCache.get(key);
  if (hit && hit.db === env.DB && Date.now() - hit.at < LISTS_V2_READY_TTL_MS) return hit;
  try {
    const account = await listsV2Account(env, username);
    let ready = false;
    if (account && isV2ListsOnly(env)) {
      // v2 is the only store: there is nothing else to read.
      ready = true;
    } else if (account) {
      const job = await env.DB.prepare("SELECT status FROM jobs WHERE dedupe_key = ?").bind(listsV2JobKey(account.id)).first();
      ready = Boolean(job && job.status === "done");
    }
    const out = { at: Date.now(), db: env.DB, account: account || null, ready };
    listsV2ReadyCache.set(key, out);
    if (listsV2ReadyCache.size > 5000) listsV2ReadyCache.delete(listsV2ReadyCache.keys().next().value);
    return out;
  } catch (e) {
    noteListsV2Error(env, e, "readiness check");
    return null;
  }
}

function forgetListsV2Ready(username) {
  listsV2ReadyCache.delete(String(username || "").toLowerCase());
}

// The account, once its copy has finished -- copying it now, within a small
// budget, if it has not been. null: read the legacy store this time.
async function listsV2MigrateOnRead(env, username) {
  const r = await listsV2Ready(env, username);
  if (!r || !r.account) return null;
  if (r.ready) return r.account;
  try {
    const meter = { ops: 0 };
    const budget = { meter, maxOps: 150, items: 300, lookups: 10, accountIds: new Map() };
    const out = await backfillAccountLists(listsBackfillEnv(env, meter), r.account, budget);
    forgetListsV2Ready(username);
    if (out.finished && !out.failed && !out.requeued && !out.busy) return r.account;
  } catch (e) {
    noteListsV2Error(env, e, "migrate on read");
  }
  return null;
}

// A save that could not take the account's lease -- a copy of the account is
// under way -- marks the job dirty, so that copy goes round again rather than
// finishing without this change, and a finished copy goes back to 'queued'.
async function markListsV2Dirty(env, account) {
  if (isV2ListsOnly(env)) return;
  forgetListsV2Ready(account.username);
  try {
    await env.DB.prepare(
      `UPDATE jobs SET payload_json = '{"dirty":true}', status = CASE WHEN status = 'done' THEN 'queued' ELSE status END, updated_at = ?
       WHERE dedupe_key = ?`
    ).bind(Date.now(), listsV2JobKey(account.id)).run();
  } catch (e) {
    noteListsV2Error(env, e, "marking a copy dirty");
  }
}

async function markListsV2Stale(env, account) {
  if (isV2ListsOnly(env)) return;
  forgetListsV2Ready(account.username);
  try {
    await env.DB.prepare("UPDATE jobs SET status = 'queued', updated_at = ? WHERE dedupe_key = ? AND status = 'done'")
      .bind(Date.now(), listsV2JobKey(account.id)).run();
  } catch (e) {
    noteListsV2Error(env, e, "marking a copy stale");
  }
}

// --- Reading ------------------------------------------------------------------

async function listsV2EntryRows(env, listIds) {
  const out = new Map(listIds.map((id) => [id, []]));
  for (let i = 0; i < listIds.length; i += MEDIA_LOOKUP_CHUNK) {
    const part = listIds.slice(i, i + MEDIA_LOOKUP_CHUNK);
    const { results } = await env.DB.prepare(
      `SELECT ${LISTS_V2_ENTRY_COLUMNS} FROM list_items li JOIN media m ON m.id = li.media_id
       WHERE li.list_id IN (${part.map(() => "?").join(", ")}) ORDER BY li.list_id, li.position, li.id`
    ).bind(...part).all();
    for (const r of results || []) out.get(r.list_id).push(r);
  }
  return out;
}

// The legacy-only fields legacyListSourceJson kept for this list.
function listsV2Source(row) {
  try {
    const src = row.source_json ? JSON.parse(row.source_json) : null;
    return src && typeof src === "object" ? src : {};
  } catch {
    return {};
  }
}

function listsV2BaseItemIds(row) {
  const src = listsV2Source(row);
  return Array.isArray(src.baseItemIds) ? src.baseItemIds : undefined;
}

// The version the legacy record reports: none for one saved before lists
// had one.
function listsV2UpdatedAt(row) {
  return listsV2Source(row).noVersion || !Number.isFinite(row.updated_at) ? undefined : row.updated_at;
}

// A v2 list as the legacy record the page and catalogs expect.
function listsV2LegacyRecord(row, items) {
  return {
    name: row.name,
    type: row.media_type,
    visibility: row.visibility === "public" ? "public" : "private",
    items,
    likes: row.like_count || 0,
    createdAt: row.created_at,
    updatedAt: listsV2UpdatedAt(row),
    sourceUrl: row.source_ref || undefined,
    synced: row.kind === "synced" || undefined,
    lastSyncedAt: row.synced_at || undefined,
    baseItemIds: listsV2BaseItemIds(row),
  };
}

// The dashboard entry for one list, in the shape /api/creator/lists sends.
function listsV2DashboardEntry(slug, data, includeItems, origin, username) {
  const items = Array.isArray(data.items) ? data.items : [];
  return {
    slug,
    name: data.name,
    type: data.type,
    items: includeItems ? items : undefined,
    itemCount: items.length,
    likes: data.likes || 0,
    visibility: effectiveListVisibility(data.visibility),
    sourceUrl: data.sourceUrl || undefined,
    synced: !!data.synced || undefined,
    lastSyncedAt: Number.isFinite(data.lastSyncedAt) ? data.lastSyncedAt : undefined,
    baseItemIds: Array.isArray(data.baseItemIds) ? data.baseItemIds : undefined,
    updatedAt: Number.isFinite(data.updatedAt) ? data.updatedAt : undefined,
    url: `${origin}/lists/${username}/${slug}`,
  };
}

// The Watchlist, which stays on the legacy store (see the top of this file):
// its list record, or the tracking blob's copy when it was never saved as one.
async function listsV2LegacyWatchlist(env, username) {
  // With FF_V2_LISTS_ONLY the Watchlist is written to v2 like any list (see
  // listsV2WriteRecord), so it is read from there too.
  const record = isV2ListsOnly(env) ? await listsV2Record(env, username, "watchlist") : await readLegacyCreatorList(env, username, "watchlist");
  if (record) return { record, fromTracking: false };
  const trackingRaw = env.CONFIGS ? await env.CONFIGS.get(`creatorsynctracking:${username}`) : null;
  if (!trackingRaw) return null;
  try {
    const tb = JSON.parse(trackingRaw);
    if (Array.isArray(tb.watchlist) && tb.watchlist.length > 0) {
      return { record: { name: "Watchlist", type: "mixed", items: tb.watchlist, likes: 0, visibility: "private", updatedAt: Number.isFinite(tb.updatedAt) ? tb.updatedAt : undefined }, fromTracking: true };
    }
  } catch {}
  return null;
}

// The dashboard order: the lists by position, with the sections (shelves)
// placed among them.
function listsV2OrderOf(rows, sections) {
  const seq = [
    ...(rows || []).map((r) => ({ slug: r.slug, position: r.position, list: 0 })),
    ...(sections || []).map((s) => ({ slug: s.target, position: s.position, list: 1 })),
  ].sort((a, b) => a.position - b.position || a.list - b.list);
  const order = [];
  for (const e of seq) if (!order.includes(e.slug)) order.push(e.slug);
  return order;
}

// /api/creator/lists from v2: the same payload, paging, version and
// "unchanged" reply the legacy route builds. null: use the legacy route.
async function listsV2DashboardResponse(env, url, auth, body) {
  const account = await listsV2MigrateOnRead(env, auth.username);
  if (!account) return null;
  try {
    const rawLimit = parseInt(body.limit, 10);
    const listLimit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, CREATOR_LISTS_PAGE_MAX) : CREATOR_LISTS_PAGE_DEFAULT;
    const rawOffset = parseInt(body.offset, 10);
    const listOffset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
    const includeItems = body.includeItems === true;

    const { results: rows } = await env.DB.prepare(
      `SELECT ${LISTS_V2_LIST_COLUMNS} FROM lists WHERE owner_account_id = ? AND deleted_at IS NULL ORDER BY position, id`
    ).bind(account.id).all();
    const { results: sections } = await env.DB.prepare(
      "SELECT target, position FROM account_list_prefs WHERE account_id = ? AND pref = 'section'"
    ).bind(account.id).all();
    const byslug = new Map((rows || []).map((r) => [r.slug, r]));
    const order = listsV2OrderOf(rows, sections);

    // The Watchlist from the legacy store. Saved as a list, it is a list; one
    // the copy has not seen yet goes at the end, where the legacy route's
    // sweep puts it; one only in the tracking blob is shown first.
    let watchlist = null;
    let watchlistFallback = null;
    const wl = await listsV2LegacyWatchlist(env, auth.username);
    if (wl && !wl.fromTracking) {
      watchlist = wl.record;
      if (!order.includes("watchlist")) order.push("watchlist");
    } else if (wl && wl.fromTracking && !order.includes("watchlist")) {
      watchlistFallback = {
        slug: "watchlist", name: "Watchlist", type: "mixed", items: wl.record.items, itemCount: wl.record.items.length,
        likes: 0, visibility: "private", url: `${url.origin}/lists/${auth.username}/watchlist`,
      };
    }

    const allSlugs = watchlistFallback ? ["\u0000watchlist"].concat(order) : order.slice();
    const total = allSlugs.length;
    const pageSlugs = allSlugs.slice(listOffset, listOffset + listLimit);
    const hasMore = listOffset + pageSlugs.length < total;
    const pageRows = pageSlugs.map((s) => byslug.get(s)).filter((r) => r && r.slug !== "watchlist");
    const entries = includeItems ? await listsV2EntryRows(env, pageRows.map((r) => r.id)) : null;
    const lists = pageSlugs.map((slug) => {
      if (slug === "\u0000watchlist") return includeItems ? watchlistFallback : { ...watchlistFallback, items: undefined };
      if (slug === "watchlist") return watchlist ? listsV2DashboardEntry(slug, watchlist, includeItems, url.origin, auth.username) : null;
      const row = byslug.get(slug);
      if (!row) return null;
      const data = listsV2LegacyRecord(row, entries ? (entries.get(row.id) || []).map(legacyItemFromEntryRow) : []);
      const entry = listsV2DashboardEntry(slug, data, includeItems, url.origin, auth.username);
      entry.itemCount = row.item_count;
      return entry;
    }).filter(Boolean);

    // Deleted slugs a browser should drop: the legacy tombstones (still
    // written) and the v2 lists deleted within the same window.
    const { results: gone } = await env.DB.prepare(
      "SELECT slug FROM lists WHERE owner_account_id = ? AND deleted_at IS NOT NULL AND deleted_at > ?"
    ).bind(account.id, Date.now() - CREATOR_LIST_TOMBSTONE_TTL_MS).all();
    const alive = new Set(order);
    const deletedSlugs = [...new Set([...Object.keys(await readCreatorListDeletions(env, auth.username)), ...(gone || []).map((g) => g.slug)])]
      .filter((s) => !alive.has(s) && !(watchlistFallback && s === "watchlist"));

    const payload = { ok: true, displayName: auth.displayName, lists, order, deletedSlugs, total, offset: listOffset, limit: listLimit, hasMore };
    let version = "";
    try {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload)));
      version = [...new Uint8Array(digest)].slice(0, 10).map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {}
    if (version && body.knownVersion && body.knownVersion === version) {
      return jsonPrivate({ ok: true, unchanged: true, version, total, offset: listOffset, limit: listLimit, hasMore });
    }
    return jsonPrivate({ ...payload, version });
  } catch (e) {
    noteListsV2Error(env, e, "dashboard");
    return null;
  }
}

// /api/creator/lists/items from v2, for slugs the route has already checked.
async function listsV2ItemsResponse(env, auth, slugs) {
  const account = await listsV2MigrateOnRead(env, auth.username);
  if (!account) return null;
  try {
    const want = slugs.filter((s) => s !== "watchlist");
    const rows = [];
    for (let i = 0; i < want.length; i += MEDIA_LOOKUP_CHUNK) {
      const part = want.slice(i, i + MEDIA_LOOKUP_CHUNK);
      const { results } = await env.DB.prepare(
        `SELECT ${LISTS_V2_LIST_COLUMNS} FROM lists WHERE owner_account_id = ? AND deleted_at IS NULL AND slug IN (${part.map(() => "?").join(", ")})`
      ).bind(account.id, ...part).all();
      rows.push(...(results || []));
    }
    const byslug = new Map(rows.map((r) => [r.slug, r]));
    const entries = await listsV2EntryRows(env, rows.map((r) => r.id));
    const out = [];
    for (const slug of slugs) {
      if (slug === "watchlist") {
        const wl = await listsV2LegacyWatchlist(env, auth.username);
        if (!wl) continue;
        const items = Array.isArray(wl.record.items) ? wl.record.items : [];
        out.push({
          slug, items, itemCount: items.length,
          baseItemIds: wl.fromTracking ? undefined : (Array.isArray(wl.record.baseItemIds) ? wl.record.baseItemIds : undefined),
          updatedAt: Number.isFinite(wl.record.updatedAt) ? wl.record.updatedAt : undefined,
        });
        continue;
      }
      const row = byslug.get(slug);
      if (!row) continue;
      const items = (entries.get(row.id) || []).map(legacyItemFromEntryRow);
      out.push({ slug, items, itemCount: items.length, baseItemIds: listsV2BaseItemIds(row), updatedAt: listsV2UpdatedAt(row) });
    }
    return jsonPrivate({ ok: true, lists: out });
  } catch (e) {
    noteListsV2Error(env, e, "list contents");
    return null;
  }
}

async function listsV2PublicRow(env, username, slug) {
  if (String(slug || "").toLowerCase() === "watchlist" && !isV2ListsOnly(env)) return null;
  const r = await listsV2Ready(env, username);
  if (!r || !r.ready || !r.account) return null;
  const row = await env.DB.prepare(
    `SELECT ${LISTS_V2_LIST_COLUMNS} FROM lists WHERE owner_account_id = ? AND slug = ? AND deleted_at IS NULL`
  ).bind(r.account.id, String(slug || "").toLowerCase()).first();
  return row && row.visibility === "public" ? row : null;
}

// A public list for its /lists/{user}/{slug} page, as the legacy record, or
// null to read the legacy store.
async function listsV2PublicListRecord(env, username, slug) {
  try {
    const row = await listsV2PublicRow(env, username, slug);
    if (!row) return null;
    const entries = await listsV2EntryRows(env, [row.id]);
    return listsV2LegacyRecord(row, (entries.get(row.id) || []).map(legacyItemFromEntryRow));
  } catch (e) {
    noteListsV2Error(env, e, "public list");
    return null;
  }
}

// A public list's items for its Custom List catalog row, or null to read the
// legacy store. Kept per isolate for five minutes by list version, so a busy
// row reads its items once, and any change is seen on the next request.
async function listsV2LiveListItems(env, owner, slug) {
  try {
    const row = await listsV2PublicRow(env, owner, slug);
    if (!row) return null;
    const cacheKey = row.public_id + ":" + row.version;
    const hit = listsV2CatalogCache.get(cacheKey);
    if (hit && Date.now() - hit.at < LISTS_V2_CATALOG_TTL_MS) return hit.items;
    const entries = await listsV2EntryRows(env, [row.id]);
    const items = (entries.get(row.id) || []).map(legacyItemFromEntryRow);
    listsV2CatalogCache.set(cacheKey, { at: Date.now(), items });
    if (listsV2CatalogCache.size > 500) listsV2CatalogCache.delete(listsV2CatalogCache.keys().next().value);
    return items;
  } catch (e) {
    noteListsV2Error(env, e, "catalog list");
    return null;
  }
}

// --- Writing ------------------------------------------------------------------

// Positions for the desired entries that keep as many current positions as
// possible (the longest run already in order stays put), placing the rest
// between their neighbours. Returns indices into `values` of that run.
function listsV2LongestIncreasing(values) {
  const tails = [];
  const tailIdx = [];
  const prev = new Array(values.length).fill(-1);
  for (let i = 0; i < values.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < values[i]) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = values[i];
    tailIdx[lo] = i;
    prev[i] = lo > 0 ? tailIdx[lo - 1] : -1;
  }
  const out = [];
  let k = tails.length ? tailIdx[tails.length - 1] : -1;
  while (k >= 0) {
    out.push(k);
    k = prev[k];
  }
  return out.reverse();
}

// The smallest set of row changes that turns `current` entries into
// `desired`: { deletes: [id], inserts: [entry], updates: [{ id, position,
// extra }], renumber }. renumber: repeated moves have left no room, so the
// list's positions need spacing out first.
function planListEntryDiff(current, desired) {
  const curByKey = new Map(current.map((c) => [c.key, c]));
  const wanted = new Set(desired.map((d) => d.key));
  const deletes = current.filter((c) => !wanted.has(c.key)).map((c) => c.id);
  const present = [];
  desired.forEach((d, i) => {
    if (curByKey.has(d.key)) present.push(i);
  });
  const keptRun = listsV2LongestIncreasing(present.map((i) => curByKey.get(desired[i].key).position));
  const kept = new Set(keptRun.map((j) => present[j]));
  const pos = new Array(desired.length);
  for (const i of kept) pos[i] = curByKey.get(desired[i].key).position;
  let renumber = false;
  for (let i = 0; i < desired.length;) {
    if (kept.has(i)) {
      i++;
      continue;
    }
    let j = i;
    while (j < desired.length && !kept.has(j)) j++;
    const lo = i > 0 ? pos[i - 1] : null;
    const hi = j < desired.length ? pos[j] : null;
    const k = j - i;
    for (let t = 0; t < k; t++) {
      if (lo == null && hi == null) pos[i + t] = t;
      else if (lo == null) pos[i + t] = hi - (k - t);
      else if (hi == null) pos[i + t] = lo + 1 + t;
      else pos[i + t] = lo + ((hi - lo) * (t + 1)) / (k + 1);
    }
    if (lo != null && hi != null && (hi - lo) / (k + 1) < 1e-7) renumber = true;
    i = j;
  }
  const inserts = [];
  const updates = [];
  desired.forEach((d, i) => {
    const c = curByKey.get(d.key);
    if (!c) inserts.push({ ...d, position: pos[i] });
    else if (!kept.has(i) || c.extra !== d.extra) updates.push({ id: c.id, position: pos[i], extra: d.extra });
  });
  return { deletes, inserts, updates, renumber };
}

function listsV2RenumberStatement(env, listId) {
  return env.DB.prepare(
    `UPDATE list_items SET position = (
       SELECT r.n FROM (SELECT id, row_number() OVER (ORDER BY position, id) - 1 AS n FROM list_items WHERE list_id = ?) AS r
       WHERE r.id = list_items.id)
     WHERE list_id = ?`
  ).bind(listId, listId);
}

// The statements for a plan. A few rows go as bound values; many go as JSON
// in a few statements each (d1JsonChunks), so replacing most of a 10,000-item
// list is a few dozen statements, not thousands.
function listsV2DiffStatements(env, listId, plan) {
  const stmts = [];
  if (plan.deletes.length > MEDIA_LOOKUP_CHUNK) {
    for (const chunk of d1JsonChunks(plan.deletes)) {
      stmts.push(env.DB.prepare("DELETE FROM list_items WHERE id IN (SELECT value FROM json_each(?))").bind(chunk));
    }
  } else if (plan.deletes.length) {
    stmts.push(env.DB.prepare(`DELETE FROM list_items WHERE id IN (${plan.deletes.map(() => "?").join(", ")})`).bind(...plan.deletes));
  }

  if (plan.inserts.length >= MEDIA_BULK_MIN) {
    for (const chunk of d1JsonChunks(plan.inserts.map((r) => [r.mediaId, r.season, r.episode, r.position, r.addedAt, r.extra]))) {
      stmts.push(env.DB.prepare(
        `INSERT OR IGNORE INTO list_items (list_id, media_id, season, episode, position, added_at, note, extra_json)
         SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'),
           json_extract(value, '$[4]'), NULL, json_extract(value, '$[5]')
         FROM json_each(?)`
      ).bind(listId, chunk));
    }
  } else {
    for (let i = 0; i < plan.inserts.length; i += LISTS_BACKFILL_ITEM_ROWS) {
      const part = plan.inserts.slice(i, i + LISTS_BACKFILL_ITEM_ROWS);
      const args = [];
      for (const r of part) args.push(listId, r.mediaId, r.season, r.episode, r.position, r.addedAt, null, r.extra);
      stmts.push(env.DB.prepare(
        `INSERT OR IGNORE INTO list_items (list_id, media_id, season, episode, position, added_at, note, extra_json)
         VALUES ${part.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}`
      ).bind(...args));
    }
  }

  if (plan.updates.length >= MEDIA_BULK_MIN) {
    for (const chunk of d1JsonChunks(plan.updates.map((u) => [u.id, u.position, u.extra]))) {
      stmts.push(env.DB.prepare(
        `UPDATE list_items SET position = j.position, extra_json = j.extra
         FROM (SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS position, json_extract(value, '$[2]') AS extra FROM json_each(?)) AS j
         WHERE list_items.id = j.id`
      ).bind(chunk));
    }
  } else {
    for (let i = 0; i < plan.updates.length; i += LISTS_V2_UPDATE_ROWS) {
      const part = plan.updates.slice(i, i + LISTS_V2_UPDATE_ROWS);
      const args = [];
      for (const u of part) args.push(u.id, u.position);
      for (const u of part) args.push(u.id, u.extra);
      for (const u of part) args.push(u.id);
      stmts.push(env.DB.prepare(
        `UPDATE list_items SET position = CASE id ${part.map(() => "WHEN ? THEN ?").join(" ")} END,
           extra_json = CASE id ${part.map(() => "WHEN ? THEN ?").join(" ")} END
         WHERE id IN (${part.map(() => "?").join(", ")})`
      ).bind(...args));
    }
  }
  return stmts;
}

async function listsV2FrontPosition(env, accountId) {
  const row = await env.DB.prepare(
    `SELECT min(p) AS p FROM (
       SELECT min(position) AS p FROM lists WHERE owner_account_id = ? AND deleted_at IS NULL
       UNION ALL SELECT min(position) FROM account_list_prefs WHERE account_id = ? AND pref = 'section')`
  ).bind(accountId, accountId).first();
  return row && row.p != null ? Math.floor(row.p) - 1 : 0;
}

async function listsV2NextPosition(env, accountId) {
  const row = await env.DB.prepare(
    `SELECT max(p) AS p FROM (
       SELECT max(position) AS p FROM lists WHERE owner_account_id = ? AND deleted_at IS NULL
       UNION ALL SELECT max(position) FROM account_list_prefs WHERE account_id = ? AND pref = 'section')`
  ).bind(accountId, accountId).first();
  return row && row.p != null ? Math.floor(row.p) + 1 : 0;
}

// Brings one list's v2 copy in line with its legacy record, which the route
// has just written.
async function syncLegacyListIntoV2(env, account, slug) {
  return applyLegacyRecordToV2(env, account, slug, await readLegacyCreatorList(env, account.username, slug));
}

// A deleted list's row: out of search, and its likes gone with it, as the
// legacy delete drops the list's like ledger -- a list made again at the same
// address later must not inherit them.
function listsV2RetireStatements(env, account, row) {
  return [
    env.DB.prepare("UPDATE lists SET deleted_at = ?, legacy_hash = NULL, like_count = 0, version = version + 1 WHERE id = ?").bind(Date.now(), row.id),
    env.DB.prepare("DELETE FROM lists_fts2 WHERE rowid = ?").bind(row.id),
    env.DB.prepare("DELETE FROM likes WHERE target_type = 'list' AND target_id = ?").bind(row.public_id),
    accountVersionStatement(env, account.id),
  ];
}

// Brings one list's v2 copy in line with a legacy-shaped record: its details,
// and its items by diff. No record: the list is marked deleted. The list's
// items and its legacy_hash change in one batch, so v2 never shows half a
// save. With FF_V2_LISTS_ONLY the record is the one the route has just built
// (34_: listsV2WriteRecord), and nothing else holds it.
async function applyLegacyRecordToV2(env, account, slug, legacy) {
  const target = creatorListTarget(account, slug, 0);
  const existing = await env.DB.prepare(
    "SELECT id, public_id, legacy_hash, position, deleted_at FROM lists WHERE legacy_id = ?"
  ).bind(target.legacyId).first();
  const live = existing && existing.deleted_at == null;
  if (!legacy) {
    if (live) await env.DB.batch(listsV2RetireStatements(env, account, existing));
    return { deleted: !!live };
  }
  const hash = await legacyListHash(legacy);
  if (live && existing.legacy_hash === hash) return { unchanged: true };
  if (legacy.items.length > LISTS_V2_MIRROR_ITEMS_MAX) throw new ListsV2TooLarge(`${slug}: ${legacy.items.length} items`);

  const name = String(legacy.name || "").trim() || slug;
  const mediaType = legacy.type === "movie" || legacy.type === "series" || legacy.type === "mixed" ? legacy.type : "mixed";
  const visibility = effectiveListVisibility(legacy.visibility) === "public" ? "public" : "private";
  let listId;
  if (live) {
    listId = existing.id;
  } else {
    // A new Watchlist goes first (save-tracking puts it at the front of the
    // legacy order), any other new list last (as the legacy save appends it).
    target.position = slug === "watchlist" ? await listsV2FrontPosition(env, account.id) : await listsV2NextPosition(env, account.id);
    await upsertLegacyListRow(env, target, legacy, { name, mediaType, visibility, position: target.position });
    listId = (await env.DB.prepare("SELECT id FROM lists WHERE legacy_id = ?").bind(target.legacyId).first()).id;
  }

  const { ids } = await resolveMediaBatch(env, legacy.items, { kind: mediaKindForList(mediaType), maxLookups: LISTS_V2_MIRROR_LOOKUPS });
  const mediaIds = [...new Set(ids.filter((id) => id != null))];
  const media = new Map();
  for (const chunk of d1JsonChunks(mediaIds)) {
    const { results } = await env.DB.prepare(
      "SELECT id, kind, imdb_id, tmdb_id, alt_id, title, year, poster_path FROM media WHERE id IN (SELECT value FROM json_each(?))"
    ).bind(chunk).all();
    for (const r of results || []) media.set(r.id, r);
  }
  const fallbackAdded = legacy.createdAt || legacy.updatedAt || Date.now();
  const desired = [];
  const seen = new Set();
  legacy.items.forEach((item, i) => {
    const id = ids[i];
    if (id == null) return;
    const ep = legacyItemEpisode(item);
    const key = id + ":" + ep.season + ":" + ep.episode;
    if (seen.has(key)) return;
    seen.add(key);
    const added = Number(item.addedAt);
    desired.push({ key, mediaId: id, season: ep.season, episode: ep.episode, addedAt: Number.isFinite(added) && added > 0 ? added : fallbackAdded, extra: legacyItemExtra(item, media.get(id), ep.season, ep.episode) });
  });
  const readCurrent = async () => {
    const { results } = await env.DB.prepare(
      "SELECT id, media_id, season, episode, position, extra_json FROM list_items WHERE list_id = ?"
    ).bind(listId).all();
    return (results || []).map((r) => ({ id: r.id, key: r.media_id + ":" + r.season + ":" + r.episode, position: r.position, extra: r.extra_json }));
  };
  let plan = planListEntryDiff(await readCurrent(), desired);
  if (plan.renumber) {
    await listsV2RenumberStatement(env, listId).run();
    plan = planListEntryDiff(await readCurrent(), desired);
  }

  const stmts = [];
  if (live) {
    stmts.push(env.DB.prepare(
      `UPDATE lists SET slug = ?, name = ?, kind = ?, media_type = ?, visibility = ?, source_provider = ?, source_ref = ?, source_json = ?,
         synced_at = ?, created_at = ?, updated_at = ? WHERE id = ?`
    ).bind(slug, name, legacyListKind(slug, legacy, false), mediaType, visibility, legacySourceProvider(legacy.sourceUrl), legacy.sourceUrl,
      legacyListSourceJson(legacy), legacy.lastSyncedAt,
      legacy.createdAt || legacy.updatedAt || Date.now(), legacy.updatedAt || legacy.createdAt || Date.now(), listId));
  }
  stmts.push(...listsV2DiffStatements(env, listId, plan));
  if (stmts.length > LISTS_V2_MIRROR_STATEMENTS_MAX) throw new ListsV2TooLarge(`${slug}: ${stmts.length} statements`);
  stmts.push(
    env.DB.prepare(
      "UPDATE lists SET item_count = (SELECT count(*) FROM list_items WHERE list_id = ?), legacy_hash = ?, version = version + 1 WHERE id = ?"
    ).bind(listId, hash, listId),
    ...listSearchStatements(env, listId, listOwnerSearchName(account.username, account.display_name)),
    accountVersionStatement(env, account.id),
  );
  await env.DB.batch(stmts);
  return { written: true };
}

// Does this list's v2 copy already match its legacy record (a save that
// changed nothing, a Watchlist sync that left it alone)? Read without the
// lease: a copy that matches needs nothing from anyone.
async function listsV2CopyMatches(env, account, slug) {
  const legacy = await readLegacyCreatorList(env, account.username, slug);
  const row = await env.DB.prepare("SELECT legacy_hash, deleted_at FROM lists WHERE legacy_id = ?")
    .bind(creatorListTarget(account, slug, 0).legacyId).first();
  if (!legacy) return !row || row.deleted_at != null;
  return Boolean(row && row.deleted_at == null && row.legacy_hash === (await legacyListHash(legacy)));
}

// After a legacy route has written these lists: mirror each into v2, under
// the account's lease (see claimListsAccountLease).
async function listsV2MirrorLists(env, username, slugs) {
  if (!listsV2Usable(env) || isV2ListsOnly(env) || !Array.isArray(slugs) || !slugs.length) return;
  let account = null;
  let leased = false;
  try {
    account = await listsV2Account(env, username);
    if (!account) return;
    const changed = [];
    for (const slug of slugs) if (!(await listsV2CopyMatches(env, account, slug))) changed.push(slug);
    if (!changed.length) return;
    leased = await claimListsAccountLease(env, account.id, 30000);
    if (!leased) {
      await markListsV2Dirty(env, account);
      return;
    }
    for (const slug of changed) await syncLegacyListIntoV2(env, account, slug);
  } catch (e) {
    if (!(e instanceof ListsV2TooLarge)) noteListsV2Error(env, e, "list mirror");
    if (account) await markListsV2Stale(env, account);
  } finally {
    if (leased) await releaseListsAccountLease(env, account.id).catch(() => {});
  }
}

// The lists take their places in a new dashboard order, and every other
// entry (the shelves) is kept as a section. Lists the order leaves out go
// after it, in the order they had. The caller holds the account's lease.
async function listsV2ApplyOrder(env, account, order) {
  const { results } = await env.DB.prepare(
    "SELECT id, slug FROM lists WHERE owner_account_id = ? AND deleted_at IS NULL ORDER BY position, id"
  ).bind(account.id).all();
  const bySlug = new Map((results || []).map((r) => [r.slug, r.id]));
  const places = [];
  const sections = [];
  const placed = new Set();
  order.forEach((slug, i) => {
    const id = bySlug.get(slug);
    if (id != null && !placed.has(id)) {
      places.push([id, i]);
      placed.add(id);
    } else if (id == null) {
      sections.push([slug, i]);
    }
  });
  let next = order.length;
  for (const r of results || []) if (!placed.has(r.id)) places.push([r.id, next++]);
  const stmts = [];
  for (let i = 0; i < places.length; i += 30) {
    const part = places.slice(i, i + 30);
    const args = [];
    for (const [id, p] of part) args.push(id, p);
    for (const [id] of part) args.push(id);
    stmts.push(env.DB.prepare(
      `UPDATE lists SET position = CASE id ${part.map(() => "WHEN ? THEN ?").join(" ")} END WHERE id IN (${part.map(() => "?").join(", ")})`
    ).bind(...args));
  }
  stmts.push(accountVersionStatement(env, account.id));
  for (let i = 0; i < stmts.length; i += MEDIA_WRITE_CHUNK) await env.DB.batch(stmts.slice(i, i + MEDIA_WRITE_CHUNK));
  await replaceListSections(env, account.id, sections);
}

// After /api/creator/lists/reorder wrote the legacy order: the same in v2.
async function listsV2MirrorOrder(env, username, order) {
  if (!listsV2Usable(env) || isV2ListsOnly(env) || !Array.isArray(order)) return;
  let account = null;
  let leased = false;
  try {
    account = await listsV2Account(env, username);
    if (!account) return;
    leased = await claimListsAccountLease(env, account.id, 30000);
    if (!leased) {
      await markListsV2Dirty(env, account);
      return;
    }
    await listsV2ApplyOrder(env, account, order);
  } catch (e) {
    noteListsV2Error(env, e, "order mirror");
    if (account) await markListsV2Stale(env, account);
  } finally {
    if (leased) await releaseListsAccountLease(env, account.id).catch(() => {});
  }
}

// After /api/lists/like changed the legacy ledger: the same like in v2.
// Returns the list's v2 like count, or null when v2 has no such list.
async function listsV2MirrorLike(env, ownerUsername, slug, voterUsername, liking) {
  if (!listsV2Usable(env) || isV2ListsOnly(env)) return null;
  try {
    const list = await env.DB.prepare("SELECT public_id FROM lists WHERE legacy_id = ? AND deleted_at IS NULL")
      .bind(`c:${ownerUsername}:${slug}`).first();
    if (!list) return null;
    const target = await resolveLikeTarget(env, "list", list.public_id);
    if (target.error) return null;
    const voterAccount = await listsV2Account(env, voterUsername);
    if (!voterAccount) return null;
    const voter = `acct:${voterAccount.id}`;
    if ((await hasLiked(env, target, voter)) !== liking) await env.DB.batch(likeWriteStatements(env, target, voter, liking, voterAccount.id));
    return await likeTargetCount(env, target);
  } catch (e) {
    noteListsV2Error(env, e, "like mirror");
    return null;
  }
}

// After /api/lists/like-external: the same like in v2, under the same hash.
async function listsV2MirrorExternalLike(env, hash, voterUsername, liking) {
  if (!listsV2Usable(env) || isV2ListsOnly(env)) return;
  try {
    const voterAccount = await listsV2Account(env, voterUsername);
    if (!voterAccount) return;
    const target = { type: "external", targetId: hash, table: null, key: null };
    const voter = `acct:${voterAccount.id}`;
    if ((await hasLiked(env, target, voter)) !== liking) await env.DB.batch(likeWriteStatements(env, target, voter, liking, voterAccount.id));
  } catch (e) {
    noteListsV2Error(env, e, "external like mirror");
  }
}

// After purgeCreatorData (account reset, deletion, the pre-create sweep):
// the account's v2 lists go too, with their likes, search rows and sections.
// Its copy starts again from nothing the next time it is read.
//
// opts.keepTombstones (an account reset with FF_V2_LISTS_ONLY): the lists'
// rows stay, marked deleted and emptied, because with no legacy tombstones
// written they are how the account's other browsers learn to drop their
// copies (the dashboard's deletedSlugs).
async function listsV2PurgeAccount(env, username, opts = {}) {
  if (!listsV2Usable(env)) return;
  try {
    const account = await listsV2Account(env, username);
    if (!account) return;
    const owned = "SELECT id FROM lists WHERE owner_account_id = ?";
    const stmts = [
      env.DB.prepare("DELETE FROM likes WHERE target_type = 'list' AND target_id IN (SELECT public_id FROM lists WHERE owner_account_id = ?)").bind(account.id),
      env.DB.prepare(`DELETE FROM lists_fts2 WHERE rowid IN (${owned})`).bind(account.id),
    ];
    if (opts.keepTombstones) {
      stmts.push(
        env.DB.prepare(`DELETE FROM list_items WHERE list_id IN (${owned})`).bind(account.id),
        env.DB.prepare(
          "UPDATE lists SET deleted_at = ?, legacy_hash = NULL, like_count = 0, item_count = 0, version = version + 1 WHERE owner_account_id = ? AND deleted_at IS NULL"
        ).bind(Date.now(), account.id),
        accountVersionStatement(env, account.id),
      );
    } else {
      stmts.push(env.DB.prepare("DELETE FROM lists WHERE owner_account_id = ?").bind(account.id));
    }
    stmts.push(
      env.DB.prepare("DELETE FROM account_list_prefs WHERE account_id = ? AND pref = 'section'").bind(account.id),
      env.DB.prepare("DELETE FROM jobs WHERE dedupe_key = ?").bind(listsV2JobKey(account.id)),
    );
    await env.DB.batch(stmts);
    forgetListsV2Ready(username);
  } catch (e) {
    noteListsV2Error(env, e, "account purge");
  }
}

// --- FF_V2_LISTS_ONLY (P3b-9): v2 as the only list store ------------------------
//
// With the flag on, the legacy list routes keep their request and response
// shapes but read and write only v2: /api/creator/lists/save builds its record
// as before and hands it to listsV2WriteRecord instead of writing KV and
// creator_lists; a delete, a reorder, a Watchlist change on a tracking save or
// a playback ping, likewise. A write that cannot finish fails the request, so
// the browser keeps its copy and tries again: there is no copy job to catch up
// any more.

// One of an account's lists as the legacy record (readLegacyCreatorList's
// shape), from v2. null: no such live list.
async function listsV2RecordFor(env, account, slug) {
  const row = await env.DB.prepare(
    `SELECT ${LISTS_V2_LIST_COLUMNS} FROM lists WHERE owner_account_id = ? AND slug = ? AND deleted_at IS NULL`
  ).bind(account.id, String(slug || "").toLowerCase()).first();
  if (!row) return null;
  const entries = await listsV2EntryRows(env, [row.id]);
  return listsV2LegacyRecord(row, (entries.get(row.id) || []).map(legacyItemFromEntryRow));
}

async function listsV2Record(env, username, slug) {
  const account = await listsV2Account(env, username);
  return account ? listsV2RecordFor(env, account, slug) : null;
}

// What getCreatorList returns (the record as JSON, with its slug), from v2.
async function listsV2GetRecordRaw(env, account, slug) {
  const rec = await listsV2RecordFor(env, account, slug);
  return rec ? JSON.stringify({ slug, ...rec }) : null;
}

// The dashboard order, for the save route's slug checks.
async function listsV2OrderSlugs(env, account) {
  const { results: rows } = await env.DB.prepare(
    "SELECT slug, position FROM lists WHERE owner_account_id = ? AND deleted_at IS NULL ORDER BY position, id"
  ).bind(account.id).all();
  const { results: sections } = await env.DB.prepare(
    "SELECT target, position FROM account_list_prefs WHERE account_id = ? AND pref = 'section'"
  ).bind(account.id).all();
  return listsV2OrderOf(rows, sections);
}

async function listsV2SlugTaken(env, account, slug) {
  const row = await env.DB.prepare("SELECT 1 AS yes FROM lists WHERE owner_account_id = ? AND slug = ? AND deleted_at IS NULL")
    .bind(account.id, String(slug || "").toLowerCase()).first();
  return Boolean(row);
}

// Runs fn holding the account's lease (claimListsAccountLease), waiting a
// little for another save of the same account to finish.
async function listsV2WithLease(env, account, fn) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await claimListsAccountLease(env, account.id, 30000)) {
      try {
        return await fn();
      } finally {
        await releaseListsAccountLease(env, account.id).catch(() => {});
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("lists v2: another save of these lists is still running");
}

// A record as readLegacyCreatorList returns one: nulls, not missing keys, so
// every field binds and the hash matches the one a mirror would compute.
function listsV2NormalRecord(rec) {
  return {
    name: rec.name,
    type: rec.type,
    visibility: rec.visibility,
    items: Array.isArray(rec.items) ? rec.items : [],
    createdAt: Number(rec.createdAt) || 0,
    updatedAt: Number.isFinite(rec.updatedAt) ? rec.updatedAt : null,
    likes: Number(rec.likes) || 0,
    sourceUrl: typeof rec.sourceUrl === "string" && rec.sourceUrl ? rec.sourceUrl : null,
    synced: !!rec.synced,
    lastSyncedAt: Number.isFinite(rec.lastSyncedAt) ? rec.lastSyncedAt : null,
    baseItemIds: Array.isArray(rec.baseItemIds) ? rec.baseItemIds : null,
  };
}

// Saves one list, as the route built it. Throws when it could not.
async function listsV2WriteRecord(env, account, slug, record) {
  return listsV2WithLease(env, account, () => applyLegacyRecordToV2(env, account, slug, listsV2NormalRecord(record)));
}

// deleteCreatorLists with FF_V2_LISTS_ONLY: { deleted, missing, ok }, as the
// legacy one answers.
async function listsV2DeleteRecords(env, username, slugs) {
  const out = { deleted: [], missing: [], ok: true };
  try {
    const account = await listsV2Account(env, username);
    if (!account) {
      out.missing.push(...slugs);
      return out;
    }
    await listsV2WithLease(env, account, async () => {
      for (const slug of slugs) {
        const r = await applyLegacyRecordToV2(env, account, slug, null);
        (r.deleted ? out.deleted : out.missing).push(slug);
      }
    });
  } catch (e) {
    console.error("lists v2: delete failed", e);
    out.ok = false;
  }
  return out;
}

// /api/creator/lists/reorder with FF_V2_LISTS_ONLY. Throws when it could not.
async function listsV2WriteOrder(env, username, order) {
  const account = await listsV2Account(env, username);
  if (!account) throw new Error("lists v2: no account for " + username);
  await listsV2WithLease(env, account, () => listsV2ApplyOrder(env, account, order));
}

// /api/lists/like with FF_V2_LISTS_ONLY: { likes } or { error, status }. A
// private list answers exactly as a missing one does, as the legacy route
// does (it must not tell anyone which private slugs exist).
async function listsV2LikeList(env, ownerUsername, slug, voterUsername, liking) {
  const owner = await listsV2Account(env, ownerUsername);
  const row = owner ? await env.DB.prepare(
    "SELECT public_id, visibility FROM lists WHERE owner_account_id = ? AND slug = ? AND deleted_at IS NULL"
  ).bind(owner.id, String(slug || "").toLowerCase()).first() : null;
  if (!row || row.visibility !== "public") return { error: "List not found.", status: 404 };
  const voterAccount = await listsV2Account(env, voterUsername);
  if (!voterAccount) return { error: "Could not process this request.", status: 400 };
  const target = { type: "list", targetId: row.public_id, table: "lists", key: "public_id" };
  const voter = `acct:${voterAccount.id}`;
  if ((await hasLiked(env, target, voter)) !== liking) await env.DB.batch(likeWriteStatements(env, target, voter, liking, voterAccount.id));
  return { likes: await likeTargetCount(env, target) };
}

// /api/lists/like-external with FF_V2_LISTS_ONLY: the count, under the hash
// the legacy route used.
async function listsV2LikeExternal(env, hash, voterUsername, liking) {
  const voterAccount = await listsV2Account(env, voterUsername);
  if (!voterAccount) throw new Error("lists v2: no account for " + voterUsername);
  const target = { type: "external", targetId: hash, table: null, key: null };
  const voter = `acct:${voterAccount.id}`;
  if ((await hasLiked(env, target, voter)) !== liking) await env.DB.batch(likeWriteStatements(env, target, voter, liking, voterAccount.id));
  return likeTargetCount(env, target);
}

// /admin/api/creator-lists with FF_V2_LISTS_ONLY: an account's lists as the
// panel lists them, from v2, in dashboard order.
async function listsV2AdminLists(env, username, origin) {
  const account = await listsV2Account(env, username);
  if (!account) return [];
  const { results } = await env.DB.prepare(
    `SELECT slug, name, media_type, item_count, like_count, visibility, updated_at, source_json FROM lists
     WHERE owner_account_id = ? AND deleted_at IS NULL ORDER BY position, id`
  ).bind(account.id).all();
  return (results || []).map((r) => ({
    slug: r.slug,
    name: r.name || "(untitled)",
    type: r.media_type || "mixed",
    itemCount: r.item_count || 0,
    likes: r.like_count || 0,
    visibility: effectiveListVisibility(r.visibility),
    updatedAt: listsV2UpdatedAt(r) || null,
    inOrder: true,
    url: `${origin}/lists/${username}/${r.slug}`,
  }));
}

async function listsV2CountLists(env, username) {
  const row = await env.DB.prepare(
    "SELECT count(*) AS n FROM lists l JOIN accounts a ON a.id = l.owner_account_id WHERE a.username = ? COLLATE NOCASE AND l.deleted_at IS NULL"
  ).bind(String(username || "")).first();
  return Number(row && row.n) || 0;
}

// /admin/api/rebuild-search-index: lists_fts2 rebuilt from the lists, owner
// names as listOwnerSearchName writes them. It is the recreation step after a
// D1 export too (the export leaves full-text tables out). Returns the rows
// indexed, or null before migration 0016.
async function rebuildListsFts2(env) {
  try {
    await env.DB.prepare(
      "CREATE VIRTUAL TABLE IF NOT EXISTS lists_fts2 USING fts5(name, description, owner_name, tokenize = 'unicode61 remove_diacritics 2')"
    ).run();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM lists_fts2"),
      env.DB.prepare(
        `INSERT INTO lists_fts2 (rowid, name, description, owner_name)
         SELECT l.id, l.name, l.description,
           CASE WHEN trim(coalesce(a.display_name, '')) != '' AND lower(trim(a.display_name)) != lower(a.username)
             THEN trim(a.display_name) || ' ' || a.username ELSE a.username END
         FROM lists l JOIN accounts a ON a.id = l.owner_account_id
         WHERE l.visibility = 'public' AND l.deleted_at IS NULL`
      ),
    ]);
    const row = await env.DB.prepare("SELECT count(*) AS n FROM lists_fts2").first();
    return Number(row && row.n) || 0;
  } catch (e) {
    noteListsV2Error(env, e, "search rebuild");
    return null;
  }
}
