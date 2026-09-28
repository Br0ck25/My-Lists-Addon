
// --- The public list directory and search on v2 (Phase 3b, P3b-6) -------------
//
// /lists/public.json and /api/search-published-lists, read from the v2 tables
// (migration 0016) instead of creator_lists and lists_fts, when
// FF_V2_LISTS_READ is on. Both keep the response shapes the page already
// reads; if a v2 query fails the routes fall back to the legacy paths, so
// turning the flag on can never empty the directory.
//
// Directory: ?sort=popular (the default, and today's order: likes, then most
// recently updated) | new (newest first) | added (most added, then likes).
// Each order walks its own partial index from 0016. Paging is by ?cursor=,
// which every page returns for the next one; ?offset= still works for callers
// that page that way today.
//
// Search: FTS over lists_fts2 (name, description, owner display name and
// username), with the same query handling and order as the legacy search
// (likes, then item count), and only lists that have items.
//
// Both need the copy (30_lists-backfill.js) to have run to the end as well as
// the flag: the directory spans every account, and until each one is copied
// it would be missing lists. Until then, and while a "Start over" re-run is
// under way, they read the legacy tables, which every save still writes.
// After that, saves keep v2 current (34_lists-v2-bridge.js).

const LISTS_DIRECTORY_ORDERS = {
  popular: { code: "p", cols: ["like_count", "updated_at", "id"] },
  new: { code: "n", cols: ["created_at", "id"] },
  added: { code: "a", cols: ["add_count", "like_count", "id"] },
};
const LISTS_DIRECTORY_WHERE = "l.visibility = 'public' AND l.deleted_at IS NULL AND l.owner_account_id IS NOT NULL";
const LISTS_DIRECTORY_COLUMNS = "l.id, l.slug, l.name, l.media_type, l.item_count, l.like_count, l.add_count, l.created_at, l.updated_at, a.username, a.display_name";
const LISTS_SEARCH_LIMIT = 50;

let listsDirectoryCopyCache = { db: null, at: 0, finished: false };

function isV2ListsReadEnabled(env) {
  const v = env ? env.FF_V2_LISTS_READ : undefined;
  return v === "1" || v === "true" || v === true;
}

// Has the copy of every account's lists finished? A yes is kept a minute per
// isolate; a no is asked again, so the switch happens as the copy finishes.
async function v2ListsCopyFinished(env) {
  const c = listsDirectoryCopyCache;
  if (c.finished && c.db === env.DB && Date.now() - c.at < 60000) return true;
  const row = await env.DB.prepare("SELECT status FROM jobs WHERE dedupe_key = ?").bind(LISTS_BACKFILL_RUN_KEY).first();
  const finished = Boolean(row && row.status === "done");
  listsDirectoryCopyCache = { db: env.DB, at: Date.now(), finished };
  return finished;
}

function listsDirectoryOrder(sort) {
  return LISTS_DIRECTORY_ORDERS[sort] || LISTS_DIRECTORY_ORDERS.popular;
}

// "p.12.1790000000000.345": the order it belongs to, then the row's values in
// that order's columns. Opaque to callers; all integers, so it survives a URL.
function encodeListsCursor(order, row) {
  return [order.code, ...order.cols.map((c) => row[c])].join(".");
}

function decodeListsCursor(order, raw) {
  const parts = String(raw || "").split(".");
  if (parts[0] !== order.code || parts.length !== order.cols.length + 1) return null;
  const values = parts.slice(1).map(Number);
  return values.every(Number.isSafeInteger) ? values : null;
}

// One page of the public directory. Returns { rows, total, nextCursor }, or
// { error } for a cursor from another order or a mangled one.
async function v2PublicListPage(env, { sort, limit, offset, cursor }) {
  const order = listsDirectoryOrder(sort);
  const cols = order.cols.map((c) => "l." + c);
  let where = LISTS_DIRECTORY_WHERE;
  const args = [];
  if (cursor) {
    const values = decodeListsCursor(order, cursor);
    if (!values) return { error: "Bad cursor." };
    where += ` AND (${cols.join(", ")}) < (${values.map(() => "?").join(", ")})`;
    args.push(...values);
  }
  const { results } = await env.DB.prepare(
    `SELECT ${LISTS_DIRECTORY_COLUMNS} FROM lists l JOIN accounts a ON a.id = l.owner_account_id
     WHERE ${where} ORDER BY ${cols.map((c) => c + " DESC").join(", ")} LIMIT ? OFFSET ?`
  ).bind(...args, limit + 1, cursor ? 0 : offset).all();
  const counted = await env.DB.prepare(`SELECT count(*) AS n FROM lists l WHERE ${LISTS_DIRECTORY_WHERE}`).first();
  const all = results || [];
  const rows = all.slice(0, limit);
  const last = rows[rows.length - 1];
  return { rows, total: Number(counted && counted.n) || 0, nextCursor: all.length > limit && last ? encodeListsCursor(order, last) : null };
}

// The /lists/public.json entry, exactly as the legacy path builds it.
function v2DirectoryEntry(row, origin) {
  return {
    name: row.name,
    slug: row.slug,
    creator: row.username,
    type: row.media_type || "mixed",
    itemCount: row.item_count || 0,
    likes: row.like_count || 0,
    updatedAt: row.updated_at || null,
    url: `${origin}/lists/${row.username}/${row.slug}`,
    jsonUrl: `${origin}/lists/${row.username}/${row.slug}.json`,
  };
}

// Public lists with items matching `target`, best liked first. An empty
// target lists them all (the legacy "my lists" search), up to `cap`.
async function v2SearchPublicLists(env, target, cap) {
  const tokens = String(target || "").split(/\s+/).filter(Boolean);
  const ftsQuery = tokens
    .map((t) => `"${t.replace(/[^\p{L}\p{N}_]+/gu, "")}"*`)
    .filter((t) => t !== '""*')
    .join(" ");
  const orderBy = "ORDER BY l.like_count DESC, l.item_count DESC, l.updated_at DESC, l.id DESC";
  if (ftsQuery) {
    const { results } = await env.DB.prepare(
      `SELECT ${LISTS_DIRECTORY_COLUMNS} FROM lists_fts2 f JOIN lists l ON l.id = f.rowid JOIN accounts a ON a.id = l.owner_account_id
       WHERE lists_fts2 MATCH ? AND ${LISTS_DIRECTORY_WHERE} AND l.item_count > 0 ${orderBy} LIMIT ?`
    ).bind(ftsQuery, cap).all();
    return results || [];
  }
  const { results } = await env.DB.prepare(
    `SELECT ${LISTS_DIRECTORY_COLUMNS} FROM lists l JOIN accounts a ON a.id = l.owner_account_id
     WHERE ${LISTS_DIRECTORY_WHERE} AND l.item_count > 0 ${orderBy} LIMIT ?`
  ).bind(cap).all();
  return results || [];
}

// The /api/search-published-lists entry, exactly as the legacy path builds it.
function v2SearchEntry(row, origin) {
  return {
    name: row.name,
    type: row.media_type,
    items: row.item_count || 0,
    likes: row.like_count || 0,
    creatorName: row.display_name || row.username,
    username: row.username,
    url: `${origin}/lists/${row.username}/${row.slug}`,
    source: "My Lists Addon",
  };
}

// The whole /lists/public.json answer from v2, or null to use the legacy
// path (flag off, no database, or a v2 failure).
async function v2PublicListsResponse(env, url) {
  if (!isV2ListsReadEnabled(env) || !env || !env.DB) return null;
  const limitParam = parseInt(url.searchParams.get("limit") || "", 10);
  const limit = Math.min(Math.max(limitParam || 100, 1), 500);
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
  const sort = url.searchParams.get("sort") || "popular";
  const cursor = url.searchParams.get("cursor") || "";
  let page;
  try {
    if (!(await v2ListsCopyFinished(env))) return null;
    page = await v2PublicListPage(env, { sort, limit, offset, cursor });
  } catch (e) {
    console.error("v2 directory failed, using the legacy directory:", e);
    return null;
  }
  if (page.error) return json({ ok: false, error: page.error }, 400);
  const lists = page.rows.map((r) => v2DirectoryEntry(r, url.origin));
  return json(
    { ok: true, count: lists.length, total: page.total, offset: cursor ? undefined : offset, sort: LISTS_DIRECTORY_ORDERS[sort] ? sort : "popular", cursor: page.nextCursor, lists },
    200,
    { "Cache-Control": "public, max-age=120", ...corsHeaders() }
  );
}

// The /api/search-published-lists answer from v2, or null to use the legacy
// path. `target` and `uncapped` come from the route's own query handling.
async function v2SearchListsResponse(env, url, target, uncapped) {
  if (!isV2ListsReadEnabled(env) || !env || !env.DB) return null;
  try {
    if (!(await v2ListsCopyFinished(env))) return null;
    const rows = await v2SearchPublicLists(env, target, uncapped ? PUBLIC_INDEX_MAX_ROWS : LISTS_SEARCH_LIMIT);
    return json({ ok: true, lists: rows.map((r) => v2SearchEntry(r, url.origin)) }, 200, { "Cache-Control": "public, max-age=60" });
  } catch (e) {
    console.error("v2 list search failed, using the legacy search:", e);
    return null;
  }
}
