
// --- Lists v2 backfill: migrate.lists (Phase 3b, P3b-3) ----------------------
//
// Copies every existing list into the lists v2 tables (migration 0016):
//   1. each account's lists -- KV creatorlist:{u}:* and D1 creator_lists,
//      merged exactly as getCreatorList merges them -- in the order the
//      dashboard shows them, with their items resolved to media rows
//      (29_media.js) and their likes;
//   2. the legacy anonymous lists (publishedlist:user:*, published_lists),
//      ownerless and unlisted: D-6 keeps their links working and keeps them
//      out of the directory;
//   3. likes on outside lists (externallike:*, extlikevoters:*, list_likes);
//   4. shared and published channels (channelshare:*, the Explore Channels
//      index, their like and add ledgers), with their episodes in R2 when
//      BLOBS is bound (35_channels-v2.js, P3b-8).
//
// It COPIES. The legacy keys and tables are only read: the env it works
// through (listsBackfillEnv) cannot write KV at all, and refuses any D1 write
// outside the v2 tables. Until the read path moves to v2 (FF_V2_LISTS_READ,
// P3b-7) the legacy store is the truth, so this can be run again at any time:
// a re-run copies only the lists whose content changed (lists.legacy_hash),
// refreshes order and likes, and marks as deleted the copies of lists that
// have since been deleted. Once reads move to v2 it never refreshes an
// account whose copy has finished (P3b-7).
//
// It runs only when an operator asks, from /admin -> Maintenance, one bounded
// step per request; the page keeps asking until it is done. A step stays well
// inside the per-invocation limits (about 1,000 D1 queries and 1,000 KV
// operations), and stops between lists or between chunks of one list.
// Progress lives in `jobs`: one row drives the run, and one per account holds
// that account's cursor and, once finished, its reconciliation record --
// counts before and after, and examples of each kind of mismatch, so every
// difference can be explained.

const LISTS_BACKFILL_TYPE = "migrate.lists";
const LISTS_BACKFILL_RUN_KEY = "migrate.lists:run";
const LISTS_BACKFILL_STEP_OPS = 350;      // D1 statements and KV reads started per step (one unit may run past it)
const LISTS_BACKFILL_STEP_ITEMS = 500;    // list items copied per step
const LISTS_BACKFILL_STEP_LOOKUPS = 100;  // TMDB lookups per step
const LISTS_BACKFILL_ITEM_CHUNK = 200;    // items resolved and written together
const LISTS_BACKFILL_ITEM_ROWS = 12;      // rows per INSERT into list_items: 8 parameters each
const LISTS_BACKFILL_LIKE_ROWS = 24;      // rows per INSERT into likes: 4 parameters each
const LISTS_BACKFILL_SAMPLES = 5;         // examples kept of each kind of mismatch
const LISTS_BACKFILL_LEASE_MS = 90000;    // one step at a time
const LISTS_BACKFILL_V2_TABLES = new Set(["media", "lists", "list_items", "likes", "lists_fts2", "jobs", "account_list_prefs", "channels"]);
// Entries the dashboard's order can hold that are shelves, not list records.
// The Watchlist can be either, so it is read like any list.
const LISTS_BACKFILL_SHELF_SLUGS = new Set(["continue-watching", "watch-history", "airing-next"]);
// The item fields a list entry is rebuilt from when nothing says otherwise,
// in this order, each taken from the media row (or the entry's season and
// episode) where it has one. See legacyItemExtra.
const LEGACY_ITEM_DEFAULT_KEYS = ["id", "type", "name", "year", "poster", "seasonNum", "episodeNum"];
const LEGACY_ITEM_POSTER_BASE = "https://image.tmdb.org/t/p/w500";

// The env every backfill step works through: counts each D1 statement, KV
// read and R2 call against the step's budget, has no KV write methods at all,
// refuses any D1 write that is not to a v2 table, and lets R2 be used only
// under channels/ (the channel pools). This is what makes "it only copies" a
// property of the code rather than a promise about it.
function listsBackfillEnv(env, meter) {
  const db = env.DB;
  const kv = env.CONFIGS;
  const blobs = env.BLOBS && typeof env.BLOBS.put === "function" ? env.BLOBS : null;
  const blobGuard = (key) => {
    if (!String(key).startsWith("channels/")) throw new Error("lists backfill: refusing to touch R2 key " + key);
    meter.ops++;
  };
  const guard = (sql) => {
    const s = String(sql);
    if (/^\s*(?:DROP|ALTER|CREATE)\b/i.test(s)) throw new Error("lists backfill: refusing a schema change");
    const m = /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+([A-Za-z_]\w*)/i.exec(s);
    if (m && !LISTS_BACKFILL_V2_TABLES.has(m[1].toLowerCase())) throw new Error("lists backfill: refusing to write to " + m[1]);
  };
  const wrap = (st) => ({
    _inner: st,
    bind: (...args) => wrap(st.bind(...args)),
    run: () => { meter.ops++; return st.run(); },
    all: () => { meter.ops++; return st.all(); },
    first: (col) => { meter.ops++; return col === undefined ? st.first() : st.first(col); },
  });
  return {
    ...env,
    DB: {
      prepare: (sql) => { guard(sql); return wrap(db.prepare(sql)); },
      batch: (stmts) => { meter.ops += stmts.length; return db.batch(stmts.map((s) => (s && s._inner) || s)); },
    },
    CONFIGS: kv ? {
      get: (...args) => { meter.ops++; return kv.get(...args); },
      list: (...args) => { meter.ops++; return kv.list(...args); },
    } : undefined,
    BLOBS: blobs ? {
      get: (key, ...args) => { blobGuard(key); return blobs.get(key, ...args); },
      put: (key, ...args) => { blobGuard(key); return blobs.put(key, ...args); },
      delete: (key) => { blobGuard(key); return blobs.delete(key); },
    } : undefined,
  };
}

function listsBackfillOpsLeft(budget) {
  return budget.meter.ops < budget.maxOps;
}

function emptyListsRecon() {
  return {
    lists: { legacy: 0, copied: 0, unchanged: 0, missing: 0, removed: 0 },
    items: { legacy: 0, copied: 0, unusable: 0, duplicates: 0, carried: 0, stubs: 0, resolved: 0, found: 0 },
    likes: { legacy: 0, voters: 0, keptFromCount: 0 },
    samples: { unusable: [], duplicates: [], likeCount: [], missing: [] },
    mismatchRate: 0,
  };
}

function emptyLikesRecon() {
  return { targets: 0, legacy: 0, voters: 0, belowLegacy: 0, samples: [] };
}

function listsBackfillSample(arr, value) {
  if (Array.isArray(arr) && arr.length < LISTS_BACKFILL_SAMPLES) arr.push(value);
}

// Items the copy could not carry, over everything the legacy lists held.
function finishListsRecon(recon) {
  const lost = recon.items.legacy - recon.items.copied;
  recon.mismatchRate = recon.items.legacy > 0 ? Math.max(0, lost) / recon.items.legacy : 0;
  return recon;
}

async function loadListsBackfillJob(env, key) {
  const row = await env.DB.prepare(
    "SELECT id, status, attempts, run_after, progress_json, last_error FROM jobs WHERE dedupe_key = ?"
  ).bind(key).first();
  if (!row) return null;
  let progress = {};
  try {
    progress = row.progress_json ? JSON.parse(row.progress_json) : {};
  } catch {
    progress = {};
  }
  return { ...row, progress };
}

async function saveListsBackfillJob(env, key, accountId, fields) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO jobs (type, dedupe_key, account_id, status, attempts, run_after, progress_json, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dedupe_key) DO UPDATE SET status = excluded.status, attempts = excluded.attempts, run_after = excluded.run_after,
       progress_json = excluded.progress_json, last_error = excluded.last_error, updated_at = excluded.updated_at`
  ).bind(LISTS_BACKFILL_TYPE, key, accountId, fields.status, fields.attempts || 0, fields.runAfter || 0,
    JSON.stringify(fields.progress || {}), fields.lastError || null, now, now).run();
}

// --- Reading the legacy store (read only) -------------------------------------

// One creator list, merged the way getCreatorList merges it -- without the
// repairs getCreatorList writes back, because this must not touch the legacy
// store. The import bookkeeping (sourceUrl, synced, lastSyncedAt,
// baseItemIds) lives only in the KV record, so it is taken from there.
async function readLegacyCreatorList(env, username, slug) {
  const row = await env.DB.prepare(
    "SELECT name, type, visibility, items_json, created_at, updated_at, likes FROM creator_lists WHERE id = ?"
  ).bind(`${username}:${slug}`).first();
  let kv = null;
  const raw = env.CONFIGS ? await env.CONFIGS.get(`creatorlist:${username}:${slug}`) : null;
  if (raw) {
    try {
      kv = JSON.parse(raw);
    } catch {
      kv = null;
    }
  }
  const source = {
    sourceUrl: kv && typeof kv.sourceUrl === "string" && kv.sourceUrl ? kv.sourceUrl : null,
    synced: !!(kv && kv.synced),
    lastSyncedAt: kv && Number.isFinite(kv.lastSyncedAt) ? kv.lastSyncedAt : null,
    baseItemIds: kv && Array.isArray(kv.baseItemIds) ? kv.baseItemIds : null,
  };
  const fromKv = () => ({
    name: kv.name, type: kv.type, visibility: kv.visibility,
    items: Array.isArray(kv.items) ? kv.items : [],
    createdAt: Number(kv.createdAt) || 0, updatedAt: Number.isFinite(kv.updatedAt) ? kv.updatedAt : null,
    likes: Number(kv.likes) || 0, ...source,
  });
  if (!row) return kv ? fromKv() : null;
  let rowItems;
  try {
    rowItems = JSON.parse(row.items_json || "[]");
  } catch {
    // getCreatorList falls back to the KV record when the row will not parse.
    return kv ? fromKv() : null;
  }
  const kvIsFresher = kv && typeof kv.updatedAt === "number" && kv.updatedAt > (row.updated_at || 0);
  let updatedAt;
  if (kv && !("updatedAt" in kv)) updatedAt = null;
  else if (kvIsFresher) updatedAt = kv.updatedAt;
  else updatedAt = row.updated_at > 0 ? row.updated_at : (kv && kv.updatedAt ? kv.updatedAt : null);
  return {
    name: kvIsFresher && kv.name ? kv.name : row.name,
    type: kvIsFresher && kv.type ? kv.type : row.type,
    visibility: kvIsFresher && kv.visibility ? kv.visibility : row.visibility,
    items: kvIsFresher && Array.isArray(kv.items) ? kv.items : (Array.isArray(rowItems) ? rowItems : []),
    createdAt: row.created_at || (kv && kv.createdAt ? kv.createdAt : 0),
    updatedAt,
    likes: Math.max(row.likes || 0, kv && typeof kv.likes === "number" ? kv.likes : 0),
    ...source,
  };
}

// An account's list slugs in the order its dashboard shows them: the same
// merge /api/creator/lists does (D1 sort_order, then the KV order key, then
// records the order key has lost). D1 rows neither of those knows about come
// last: the dashboard can miss them, but they are lists all the same.
async function legacyListSlugs(env, username) {
  const { results } = await env.DB.prepare(
    "SELECT id, sort_order FROM creator_lists WHERE username = ? ORDER BY CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END, sort_order ASC, created_at ASC"
  ).bind(username).all();
  const prefix = username + ":";
  const d1Slugs = [];
  let d1Ordered = false;
  for (const r of results || []) {
    const s = String(r.id || "").startsWith(prefix) ? String(r.id).slice(prefix.length) : String(r.id || "");
    if (s) d1Slugs.push(s);
    if (r.sort_order != null) d1Ordered = true;
  }
  let order = d1Ordered ? d1Slugs.slice() : [];
  let kvOrder = [];
  if (env.CONFIGS) {
    try {
      const raw = await env.CONFIGS.get(`creatorlistorder:${username}`);
      kvOrder = raw ? JSON.parse(raw).order || [] : [];
    } catch {
      kvOrder = [];
    }
  }
  if (Array.isArray(kvOrder) && kvOrder.length > 0) {
    if (d1Ordered && order.length > 0) {
      const inD1 = new Set(order);
      const merged = kvOrder.filter((s) => typeof s === "string" && (inD1.has(s) || s === "watchlist" || LISTS_BACKFILL_SHELF_SLUGS.has(s)));
      for (const s of order) if (!merged.includes(s)) merged.push(s);
      order = merged;
    } else if (!d1Ordered) {
      order = kvOrder.filter((s) => typeof s === "string" && s);
    }
  }
  const seen = new Set(order);
  const add = (s) => {
    if (s && !seen.has(s)) {
      seen.add(s);
      order.push(s);
    }
  };
  if (env.CONFIGS) {
    let cursor;
    do {
      const res = await env.CONFIGS.list({ prefix: `creatorlist:${username}:`, ...(cursor ? { cursor } : {}) });
      for (const k of res.keys || []) add(k.name.slice(`creatorlist:${username}:`.length));
      cursor = res.list_complete ? null : res.cursor;
    } while (cursor);
  }
  for (const s of d1Slugs) add(s);
  return [...new Set(order)];
}

// A legacy anonymous list. Its page serves the KV record, so that wins;
// published_lists is the mirror, used when the record is gone.
async function readLegacyAnonymousList(env, slug) {
  const row = await env.DB.prepare(
    "SELECT name, type, visibility, items_json, likes, created_at, updated_at FROM published_lists WHERE slug = ?"
  ).bind(slug).first();
  let kv = null;
  const raw = env.CONFIGS ? await env.CONFIGS.get(`publishedlist:user:${slug}`) : null;
  if (raw) {
    try {
      kv = JSON.parse(raw);
    } catch {
      kv = null;
    }
  }
  if (kv) {
    return {
      name: kv.name, type: kv.type, visibility: kv.visibility,
      items: Array.isArray(kv.items) ? kv.items : [],
      createdAt: Number(kv.createdAt || kv.publishedAt) || 0,
      updatedAt: Number(kv.updatedAt || kv.publishedAt) || null,
      likes: Math.max(Number(kv.likes) || 0, row ? Number(row.likes) || 0 : 0),
      sourceUrl: null, synced: false, lastSyncedAt: null, baseItemIds: null,
    };
  }
  if (!row) return null;
  let items = [];
  try {
    items = JSON.parse(row.items_json || "[]");
  } catch {
    items = [];
  }
  return {
    name: row.name, type: row.type, visibility: row.visibility,
    items: Array.isArray(items) ? items : [],
    createdAt: row.created_at || 0, updatedAt: row.updated_at || null, likes: Number(row.likes) || 0,
    sourceUrl: null, synced: false, lastSyncedAt: null, baseItemIds: null,
  };
}

async function legacyAnonymousSlugs(env) {
  const out = new Set();
  if (env.CONFIGS) {
    let cursor;
    do {
      const res = await env.CONFIGS.list({ prefix: "publishedlist:user:", ...(cursor ? { cursor } : {}) });
      for (const k of res.keys || []) {
        const s = k.name.slice("publishedlist:user:".length);
        if (s) out.add(s);
      }
      cursor = res.list_complete ? null : res.cursor;
    } while (cursor);
  }
  const { results } = await env.DB.prepare("SELECT slug FROM published_lists ORDER BY slug").all();
  for (const r of results || []) if (r && r.slug) out.add(r.slug);
  return [...out];
}

// Every external list with a like anywhere: its count record, its KV ledger,
// or its rows in list_likes. Keyed by the URL hash the like route uses.
async function legacyExternalLikeKeys(env) {
  const out = new Set();
  if (env.CONFIGS) {
    for (const prefix of ["externallike:", "extlikevoters:"]) {
      let cursor;
      do {
        const res = await env.CONFIGS.list({ prefix, ...(cursor ? { cursor } : {}) });
        for (const k of res.keys || []) {
          const h = k.name.slice(prefix.length);
          if (h) out.add(h);
        }
        cursor = res.list_complete ? null : res.cursor;
      } while (cursor);
    }
  }
  const { results } = await env.DB.prepare("SELECT DISTINCT list_id FROM list_likes WHERE list_id LIKE 'ext:%'").all();
  for (const r of results || []) {
    const h = String((r && r.list_id) || "").slice(4);
    if (h) out.add(h);
  }
  return [...out];
}

// Everyone who liked a legacy target: the union of list_likes and the KV
// ledger, since either may hold voters the other lost.
async function legacyLikeVoters(env, legacyListId, ledgerKey) {
  const set = new Set();
  const { results } = await env.DB.prepare("SELECT voter_id FROM list_likes WHERE list_id = ?").bind(legacyListId).all();
  for (const r of results || []) if (r && typeof r.voter_id === "string" && r.voter_id) set.add(r.voter_id);
  for (const v of await readLikeVotersFromKv(env, ledgerKey)) if (typeof v === "string" && v) set.add(v);
  return set;
}

// Legacy voter ids as v2 voters. "u:<username>" becomes "acct:<id>" when the
// account exists. One whose account is gone keeps its legacy id, and so do
// the signed-out "a:<hash>" votes: both still count, as they do today (D-9).
async function mapLegacyVoters(env, voters, budget) {
  const cache = budget.accountIds;
  const names = [...new Set([...voters].filter((v) => v.startsWith("u:")).map((v) => v.slice(2).toLowerCase()))]
    .filter((n) => n && !cache.has(n));
  for (let i = 0; i < names.length; i += MEDIA_LOOKUP_CHUNK) {
    const chunk = names.slice(i, i + MEDIA_LOOKUP_CHUNK);
    const { results } = await env.DB.prepare(
      `SELECT id, username FROM accounts WHERE deleted_at IS NULL AND username IN (${chunk.map(() => "?").join(", ")})`
    ).bind(...chunk).all();
    for (const n of chunk) cache.set(n, null);
    for (const r of results || []) cache.set(String(r.username).toLowerCase(), r.id);
  }
  const out = new Set();
  for (const v of voters) {
    if (v.startsWith("u:")) {
      const id = cache.get(v.slice(2).toLowerCase());
      out.add(id ? "acct:" + id : v);
    } else {
      out.add(v);
    }
  }
  return out;
}

// Replaces a target's likes with the legacy union, if they differ. Before the
// read flip nothing else writes v2 likes, so replacing is safe and makes a
// re-run pick up unlikes as well as likes.
async function syncLegacyLikes(env, targetType, targetId, legacyListId, ledgerKey, budget) {
  const voters = await mapLegacyVoters(env, await legacyLikeVoters(env, legacyListId, ledgerKey), budget);
  const { results } = await env.DB.prepare("SELECT voter FROM likes WHERE target_type = ? AND target_id = ?").bind(targetType, targetId).all();
  const current = new Set((results || []).map((r) => r.voter));
  const same = current.size === voters.size && [...voters].every((v) => current.has(v));
  if (!same) {
    const now = Date.now();
    const stmts = [env.DB.prepare("DELETE FROM likes WHERE target_type = ? AND target_id = ?").bind(targetType, targetId)];
    const all = [...voters];
    for (let i = 0; i < all.length; i += LISTS_BACKFILL_LIKE_ROWS) {
      const chunk = all.slice(i, i + LISTS_BACKFILL_LIKE_ROWS);
      const args = [];
      for (const v of chunk) args.push(targetType, targetId, v, now);
      stmts.push(env.DB.prepare(
        `INSERT OR IGNORE INTO likes (target_type, target_id, voter, created_at) VALUES ${chunk.map(() => "(?, ?, ?, ?)").join(", ")}`
      ).bind(...args));
    }
    for (let i = 0; i < stmts.length; i += MEDIA_WRITE_CHUNK) await env.DB.batch(stmts.slice(i, i + MEDIA_WRITE_CHUNK));
  }
  return voters.size;
}

// --- Writing one list ---------------------------------------------------------

async function legacyListHash(legacy) {
  const text = JSON.stringify([legacy.name, legacy.type, legacy.visibility, legacy.items, legacy.sourceUrl, legacy.synced,
    legacy.lastSyncedAt, legacy.baseItemIds, legacy.createdAt, legacy.updatedAt]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function legacyListKind(slug, legacy, anonymous) {
  if (anonymous) return "legacy_anonymous";
  if (slug === "watchlist") return "watchlist";
  if (legacy.sourceUrl) return legacy.synced ? "synced" : "imported";
  return "custom";
}

function legacySourceProvider(url) {
  const s = String(url || "").toLowerCase();
  const known = [["mdblist", "mdblist"], ["trakt", "trakt"], ["themoviedb", "tmdb"], ["tmdb", "tmdb"], ["letterboxd", "letterboxd"], ["simkl", "simkl"], ["imdb.com", "imdb"]];
  for (const [needle, name] of known) if (s.includes(needle)) return name;
  return null;
}

function legacyItemEpisode(item) {
  const isEpisode = String(item.type || "").toLowerCase() === "episode"
    || item.seasonNum != null || item.episodeNum != null || item.season != null || item.episode != null;
  if (!isEpisode) return { isEpisode: false, season: null, episode: null };
  const s = Number(item.seasonNum != null ? item.seasonNum : item.season);
  const e = Number(item.episodeNum != null ? item.episodeNum : item.episode);
  return {
    isEpisode: true,
    season: Number.isInteger(s) && s >= 0 ? s : null,
    episode: Number.isInteger(e) && e >= 0 ? e : null,
  };
}

// What a legacy item's fields would be if they were all taken from its media
// row and its entry's season and episode.
function legacyItemDerived(media, season, episode) {
  const d = {};
  if (media) {
    const id = media.imdb_id || (media.tmdb_id ? "tmdb:" + media.tmdb_id : media.alt_id);
    if (id) d.id = id;
    if (media.kind) d.type = media.kind;
    if (media.title) d.name = media.title;
    if (media.year) d.year = String(media.year);
    if (media.poster_path) d.poster = media.poster_path.startsWith("/") ? LEGACY_ITEM_POSTER_BASE + media.poster_path : media.poster_path;
    if (media.imdb_id) d.imdbId = media.imdb_id;
    if (media.tmdb_id) d.tmdbId = media.tmdb_id;
  }
  if (season != null) d.seasonNum = season;
  if (episode != null) d.episodeNum = episode;
  return d;
}

function legacyItemSame(a, b) {
  return a === b || (a !== null && b !== null && typeof a === "object" && typeof b === "object" && JSON.stringify(a) === JSON.stringify(b));
}

// A legacy item from its entry's extra_json and what the media row says.
// "~k" (when present) is the item's own list of fields; otherwise it is the
// default fields that have a value, then whatever else extra_json holds.
function rebuildLegacyItem(extra, derived) {
  const x = extra && typeof extra === "object" ? extra : {};
  const keys = Array.isArray(x["~k"])
    ? x["~k"]
    : [...LEGACY_ITEM_DEFAULT_KEYS.filter((k) => derived[k] !== undefined && !(k in x)), ...Object.keys(x).filter((k) => k !== "~k")];
  const out = {};
  for (const k of keys) {
    const v = Object.prototype.hasOwnProperty.call(x, k) ? x[k] : derived[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// What an entry keeps in extra_json: the item's fields the media row cannot
// give back exactly, so rebuildLegacyItem returns the item as it was saved --
// same fields, same values. A field equal to what the media row says is left
// out; when leaving fields out would change which fields come back, the
// item's own field list goes in as "~k". Most items need nothing at all.
function legacyItemExtra(item, media, season, episode) {
  const derived = legacyItemDerived(media, season, episode);
  const clean = {};
  for (const [k, v] of Object.entries(item || {})) if (v !== undefined && k !== "~k") clean[k] = v;
  const extra = {};
  for (const [k, v] of Object.entries(clean)) {
    if (!Object.prototype.hasOwnProperty.call(derived, k) || !legacyItemSame(v, derived[k])) extra[k] = v;
  }
  const rebuilt = rebuildLegacyItem(extra, derived);
  const keys = Object.keys(clean);
  const exact = Object.keys(rebuilt).length === keys.length && keys.every((k) => legacyItemSame(rebuilt[k], clean[k]));
  if (!exact) extra["~k"] = keys;
  return Object.keys(extra).length ? JSON.stringify(extra) : null;
}

// A list entry row (list_items joined with media) as the legacy item it was.
function legacyItemFromEntryRow(row) {
  let extra = null;
  try {
    extra = row.extra_json ? JSON.parse(row.extra_json) : null;
  } catch {
    extra = null;
  }
  return rebuildLegacyItem(extra, legacyItemDerived(row, row.season, row.episode));
}

function legacyItemLabel(item) {
  const it = item && typeof item === "object" ? item : {};
  return { id: it.id || it.imdbId || it.showId || null, name: it.name || it.title || it.showTitle || null };
}

// One chunk of a list's items: resolved to media rows and inserted in order.
// A title (or an episode) already in the list is not inserted twice: it is
// counted, with an example, as a duplicate.
async function copyLegacyItems(env, cursor, chunk, legacy, mediaKind, budget) {
  const { ids, stats } = await resolveMediaBatch(env, chunk, { kind: mediaKind, maxLookups: Math.max(0, budget.lookups) });
  budget.lookups -= stats.lookups;
  budget.items -= chunk.length;
  cursor.stubs += stats.stubs;
  cursor.resolved += stats.resolved;
  cursor.found += stats.found;

  const mediaIds = [...new Set(ids.filter((id) => id != null))];
  const media = new Map();
  for (let i = 0; i < mediaIds.length; i += MEDIA_LOOKUP_CHUNK) {
    const part = mediaIds.slice(i, i + MEDIA_LOOKUP_CHUNK);
    const { results } = await env.DB.prepare(
      `SELECT id, kind, imdb_id, tmdb_id, alt_id, title, year, poster_path FROM media WHERE id IN (${part.map(() => "?").join(", ")})`
    ).bind(...part).all();
    for (const r of results || []) media.set(r.id, r);
  }

  // Entries this list already has from earlier chunks, so a title listed
  // twice is recognised (and an example kept) wherever the second copy falls.
  const entryKey = (mediaId, season, episode) => mediaId + ":" + season + ":" + episode;
  const taken = new Set();
  for (let i = 0; i < mediaIds.length; i += MEDIA_LOOKUP_CHUNK) {
    const part = mediaIds.slice(i, i + MEDIA_LOOKUP_CHUNK);
    const { results } = await env.DB.prepare(
      `SELECT media_id, season, episode FROM list_items WHERE list_id = ? AND media_id IN (${part.map(() => "?").join(", ")})`
    ).bind(cursor.listId, ...part).all();
    for (const r of results || []) taken.add(entryKey(r.media_id, r.season, r.episode));
  }

  const fallbackAdded = legacy.createdAt || legacy.updatedAt || Date.now();
  const rows = [];
  chunk.forEach((item, i) => {
    const id = ids[i];
    if (id == null) {
      cursor.unusable++;
      listsBackfillSample(cursor.samples.unusable, legacyItemLabel(item));
      return;
    }
    const ep = legacyItemEpisode(item);
    const key = entryKey(id, ep.season, ep.episode);
    if (taken.has(key)) {
      cursor.duplicates++;
      listsBackfillSample(cursor.samples.duplicates, legacyItemLabel(item));
      return;
    }
    taken.add(key);
    const added = Number(item.addedAt);
    rows.push([cursor.listId, id, ep.season, ep.episode, cursor.offset + i,
      Number.isFinite(added) && added > 0 ? added : fallbackAdded, null, legacyItemExtra(item, media.get(id), ep.season, ep.episode)]);
  });
  const stmts = [];
  for (let i = 0; i < rows.length; i += LISTS_BACKFILL_ITEM_ROWS) {
    const part = rows.slice(i, i + LISTS_BACKFILL_ITEM_ROWS);
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO list_items (list_id, media_id, season, episode, position, added_at, note, extra_json)
       VALUES ${part.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}`
    ).bind(...part.flat()));
  }
  // OR IGNORE as a safety net: anything it still skips is a duplicate too.
  let inserted = 0;
  for (let i = 0; i < stmts.length; i += MEDIA_WRITE_CHUNK) {
    const out = await env.DB.batch(stmts.slice(i, i + MEDIA_WRITE_CHUNK));
    for (const r of out || []) inserted += Number(r && r.meta && r.meta.changes) || 0;
  }
  cursor.duplicates += Math.max(0, rows.length - inserted);
}

async function syncLegacyListSearch(env, listId, visibility, name, ownerName) {
  const stmts = [env.DB.prepare("DELETE FROM lists_fts2 WHERE rowid = ?").bind(listId)];
  if (visibility === "public") {
    stmts.push(env.DB.prepare("INSERT INTO lists_fts2 (rowid, name, description, owner_name) VALUES (?, ?, NULL, ?)").bind(listId, name, ownerName || null));
  }
  await env.DB.batch(stmts);
}

// Copies (or refreshes) one legacy list, a chunk at a time. Returns
// { done, cursor, alive }: not done means the step's budget ran out and
// `cursor` resumes it; alive means the list exists in the legacy store.
//
// target: { legacyId, slug, position, ownerId, ownerName, anonymous,
//           likeListId, likeLedgerKey, read(env) }
async function backfillLegacyList(env, target, cursor, budget, recon) {
  const legacy = await target.read(env);
  if (!legacy) {
    // The Watchlist is in the order whether or not it was ever saved as a
    // list (it can live only in the tracking blob), so its absence is normal.
    if (!cursor && target.slug !== "watchlist") {
      recon.lists.missing++;
      listsBackfillSample(recon.samples.missing, target.slug);
    }
    return { done: true, alive: false };
  }
  const hash = await legacyListHash(legacy);
  // Edited in the legacy store while this list was half copied: start it again.
  if (cursor && cursor.hash !== hash) cursor = null;
  const publicVisibility = effectiveListVisibility(legacy.visibility) === "public";
  const visibility = target.anonymous ? (publicVisibility ? "unlisted" : "private") : (publicVisibility ? "public" : "private");
  const name = String(legacy.name || "").trim() || target.slug;
  const mediaType = legacy.type === "movie" || legacy.type === "series" || legacy.type === "mixed" ? legacy.type : "mixed";

  if (!cursor) {
    const existing = await env.DB.prepare(
      "SELECT id, public_id, legacy_hash, position, item_count, deleted_at FROM lists WHERE legacy_id = ?"
    ).bind(target.legacyId).first();
    if (existing && existing.legacy_hash === hash && existing.deleted_at == null) {
      if (existing.position !== target.position) {
        await env.DB.prepare("UPDATE lists SET position = ? WHERE id = ?").bind(target.position, existing.id).run();
      }
      await finishLegacyListLikes(env, target, legacy, existing.id, existing.public_id, budget, recon);
      if (!target.anonymous) await syncLegacyListSearch(env, existing.id, visibility, name, target.ownerName);
      recon.lists.legacy++;
      recon.lists.unchanged++;
      recon.items.legacy += legacy.items.length;
      recon.items.copied += existing.item_count;
      recon.items.carried += Math.max(0, legacy.items.length - existing.item_count);
      return { done: true, alive: true };
    }
    if (legacy.items.length > 0 && budget.items <= 0) return { done: false, cursor: null };
    await upsertLegacyListRow(env, target, legacy, { name, mediaType, visibility, position: target.position });
    const row = await env.DB.prepare("SELECT id, public_id FROM lists WHERE legacy_id = ?").bind(target.legacyId).first();
    await env.DB.prepare("DELETE FROM list_items WHERE list_id = ?").bind(row.id).run();
    cursor = {
      listId: row.id, publicId: row.public_id, hash, offset: 0,
      unusable: 0, duplicates: 0, stubs: 0, resolved: 0, found: 0,
      samples: { unusable: [], duplicates: [] },
    };
  }

  const mediaKind = mediaType === "series" ? "series" : (mediaType === "movie" ? "movie" : null);
  while (cursor.offset < legacy.items.length) {
    if (!listsBackfillOpsLeft(budget) || budget.items <= 0) return { done: false, cursor };
    const n = Math.max(1, Math.min(LISTS_BACKFILL_ITEM_CHUNK, budget.items));
    const chunk = legacy.items.slice(cursor.offset, cursor.offset + n);
    await copyLegacyItems(env, cursor, chunk, legacy, mediaKind, budget);
    cursor.offset += chunk.length;
  }

  const counted = await env.DB.prepare("SELECT count(*) AS n FROM list_items WHERE list_id = ?").bind(cursor.listId).first();
  const itemCount = Number(counted && counted.n) || 0;
  await env.DB.prepare("UPDATE lists SET item_count = ?, legacy_hash = ? WHERE id = ?").bind(itemCount, hash, cursor.listId).run();
  await finishLegacyListLikes(env, target, legacy, cursor.listId, cursor.publicId, budget, recon);
  if (!target.anonymous) await syncLegacyListSearch(env, cursor.listId, visibility, name, target.ownerName);

  recon.lists.legacy++;
  recon.lists.copied++;
  recon.items.legacy += legacy.items.length;
  recon.items.copied += itemCount;
  recon.items.unusable += cursor.unusable;
  recon.items.duplicates += cursor.duplicates;
  recon.items.stubs += cursor.stubs;
  recon.items.resolved += cursor.resolved;
  recon.items.found += cursor.found;
  for (const s of cursor.samples.unusable) listsBackfillSample(recon.samples.unusable, { list: target.slug, ...s });
  for (const s of cursor.samples.duplicates) listsBackfillSample(recon.samples.duplicates, { list: target.slug, ...s });
  return { done: true, alive: true };
}

// Creates or updates the v2 row for a legacy list, from the legacy record.
// Its legacy_hash is cleared: whoever writes the items sets it once they
// are all in, so an interrupted copy is never taken for a finished one.
// Shared by the backfill and the write mirror (34_lists-v2-bridge.js).
// What the legacy record holds that the list's columns cannot: an import's
// baseItemIds, and noVersion for a record saved before lists had an
// updatedAt. updated_at needs a value, but such a list must still report no
// version, or the next save would be refused as built on a stale one.
function legacyListSourceJson(legacy) {
  const src = {};
  if (legacy.baseItemIds) src.baseItemIds = legacy.baseItemIds;
  if (legacy.updatedAt == null) src.noVersion = true;
  return Object.keys(src).length ? JSON.stringify(src) : null;
}

async function upsertLegacyListRow(env, target, legacy, fields) {
  const createdAt = legacy.createdAt || legacy.updatedAt || Date.now();
  await env.DB.prepare(
    `INSERT INTO lists (public_id, owner_account_id, slug, name, description, kind, media_type, visibility, legacy_id, legacy_hash,
       source_provider, source_ref, source_json, synced_at, item_count, like_count, position, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, 0, ?, 1, ?, ?)
     ON CONFLICT(legacy_id) DO UPDATE SET owner_account_id = excluded.owner_account_id, slug = excluded.slug, name = excluded.name,
       kind = excluded.kind, media_type = excluded.media_type, visibility = excluded.visibility, legacy_hash = NULL,
       source_provider = excluded.source_provider, source_ref = excluded.source_ref, source_json = excluded.source_json,
       synced_at = excluded.synced_at, position = excluded.position, created_at = excluded.created_at,
       updated_at = excluded.updated_at, deleted_at = NULL, version = lists.version + 1`
  ).bind(generateShortId(), target.ownerId, target.slug, fields.name, legacyListKind(target.slug, legacy, target.anonymous), fields.mediaType,
    fields.visibility, target.legacyId, legacySourceProvider(legacy.sourceUrl), legacy.sourceUrl,
    legacyListSourceJson(legacy), legacy.lastSyncedAt,
    fields.position, createdAt, legacy.updatedAt || createdAt).run();
}

// A list's like_count keeps the legacy total when that is higher than the
// voters on record: some likes were counted before the ledgers existed, and
// the totals people see do not drop (D-9). P3b-5 adjusts it by each change.
async function finishLegacyListLikes(env, target, legacy, listId, publicId, budget, recon) {
  const voters = await syncLegacyLikes(env, "list", publicId, target.likeListId, target.likeLedgerKey, budget);
  const legacyCount = Number(legacy.likes) || 0;
  const likeCount = Math.max(legacyCount, voters);
  await env.DB.prepare("UPDATE lists SET like_count = ? WHERE id = ? AND like_count != ?").bind(likeCount, listId, likeCount).run();
  recon.likes.legacy += legacyCount;
  recon.likes.voters += voters;
  if (legacyCount > voters) {
    recon.likes.keptFromCount += legacyCount - voters;
    listsBackfillSample(recon.samples.likeCount, { list: target.slug, legacy: legacyCount, voters });
  }
}

// --- One account --------------------------------------------------------------

// What search matches an owner by: the display name, and the username too
// when it differs, so people can be found by either. Shared with the list
// API (31_lists-api.js), which keeps lists_fts2 in step on every write.
function listOwnerSearchName(username, displayName) {
  const u = String(username || "");
  const d = String(displayName || "").trim();
  return d && d.toLowerCase() !== u.toLowerCase() ? `${d} ${u}` : u;
}

function creatorListTarget(account, slug, position) {
  const username = account.username;
  const ownerName = listOwnerSearchName(username, account.display_name);
  return {
    legacyId: `c:${username}:${slug}`, slug, position, ownerId: account.id, ownerName, anonymous: false,
    likeListId: `c:${username}:${slug}`, likeLedgerKey: `listlikevoters:${username}:${slug}`,
    read: (env) => readLegacyCreatorList(env, username, slug),
  };
}

// The per-account lease both the backfill and the write mirror take, so they
// never write one account's lists at the same time. It lives in the account
// job's run_after (the row is made if need be); saving the job releases it.
async function claimListsAccountLease(env, accountId, ms) {
  const key = `${LISTS_BACKFILL_TYPE}:acct:${accountId}`;
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO jobs (type, dedupe_key, account_id, status, run_after, progress_json, created_at, updated_at) VALUES (?, ?, ?, 'queued', 0, '{}', ?, ?) ON CONFLICT(dedupe_key) DO NOTHING"
  ).bind(LISTS_BACKFILL_TYPE, key, accountId, now, now).run();
  const claim = await env.DB.prepare("UPDATE jobs SET run_after = ? WHERE dedupe_key = ? AND run_after <= ?").bind(now + ms, key, now).run();
  return Number(claim && claim.meta && claim.meta.changes) === 1;
}

async function releaseListsAccountLease(env, accountId) {
  await env.DB.prepare("UPDATE jobs SET run_after = 0 WHERE dedupe_key = ?").bind(`${LISTS_BACKFILL_TYPE}:acct:${accountId}`).run();
}

// The account's non-list order entries (see account_list_prefs in 0016),
// replaced as one set.
async function replaceListSections(env, accountId, sections) {
  const now = Date.now();
  const stmts = [env.DB.prepare("DELETE FROM account_list_prefs WHERE account_id = ? AND pref = 'section'").bind(accountId)];
  for (let i = 0; i < sections.length; i += 20) {
    const part = sections.slice(i, i + 20);
    const args = [];
    for (const [slug, position] of part) args.push(accountId, "section", slug, now, position);
    stmts.push(env.DB.prepare(
      `INSERT OR REPLACE INTO account_list_prefs (account_id, pref, target, created_at, position) VALUES ${part.map(() => "(?, ?, ?, ?, ?)").join(", ")}`
    ).bind(...args));
  }
  for (let i = 0; i < stmts.length; i += MEDIA_WRITE_CHUNK) await env.DB.batch(stmts.slice(i, i + MEDIA_WRITE_CHUNK));
}

// Copies of lists that are no longer in the legacy store are marked deleted.
// ownerId null: the legacy anonymous lists.
async function retireDeletedListCopies(env, ownerId, aliveIds, recon) {
  const { results } = await env.DB.prepare(
    "SELECT id, legacy_id FROM lists WHERE owner_account_id IS ? AND legacy_id IS NOT NULL AND deleted_at IS NULL"
  ).bind(ownerId).all();
  const now = Date.now();
  for (const r of results || []) {
    if (aliveIds.has(r.legacy_id)) continue;
    await env.DB.batch([
      env.DB.prepare("UPDATE lists SET deleted_at = ?, legacy_hash = NULL WHERE id = ?").bind(now, r.id),
      env.DB.prepare("DELETE FROM lists_fts2 WHERE rowid = ?").bind(r.id),
    ]);
    recon.lists.removed++;
  }
}

// Returns { finished, failed }. Not finished: the budget ran out and the
// account's job row holds where to resume. A failure is recorded on the
// account's row and the run moves on, so one bad record cannot stop the rest.
async function backfillAccountLists(env, account, budget) {
  const key = `${LISTS_BACKFILL_TYPE}:acct:${account.id}`;
  // Once reads are on v2 an account whose copy has finished is never copied
  // again: v2 is what people see, and writes keep it in step (34_). One whose
  // v2 copy was marked stale is back to 'queued' and is copied again.
  const before = await loadListsBackfillJob(env, key);
  if (isV2ListsReadEnabled(env) && before && before.status === "done") return { finished: true, failed: false, skipped: true };
  // One copy of an account at a time, and never while a save is mirroring
  // into it (the write mirror takes the same lease).
  if (!(await claimListsAccountLease(env, account.id, 60000))) return { finished: false, busy: true };
  const job = await loadListsBackfillJob(env, key);
  let p = job && job.status === "running" && Array.isArray(job.progress.slugs) ? job.progress : null;
  try {
    if (!p) {
      p = { slugs: await legacyListSlugs(env, account.username), next: 0, alive: [], sections: [], list: null, recon: emptyListsRecon(), startedAt: Date.now() };
    }
    while (p.next < p.slugs.length) {
      if (!listsBackfillOpsLeft(budget)) {
        await saveListsBackfillJob(env, key, account.id, { status: "running", attempts: job ? job.attempts : 0, progress: p });
        return { finished: false };
      }
      const slug = p.slugs[p.next];
      if (LISTS_BACKFILL_SHELF_SLUGS.has(slug)) {
        (p.sections = p.sections || []).push([slug, p.next]);
        p.next++;
        continue;
      }
      const target = creatorListTarget(account, slug, p.next);
      const r = await backfillLegacyList(env, target, p.list, budget, p.recon);
      if (!r.done) {
        p.list = r.cursor;
        await saveListsBackfillJob(env, key, account.id, { status: "running", attempts: job ? job.attempts : 0, progress: p });
        return { finished: false };
      }
      if (r.alive) p.alive.push(target.legacyId);
      // An order entry with no list behind it (a shelf, or the Watchlist
      // before it was ever saved as a list) keeps its place as a section.
      else (p.sections = p.sections || []).push([slug, p.next]);
      p.next++;
      p.list = null;
    }
    await retireDeletedListCopies(env, account.id, new Set(p.alive), p.recon);
    await replaceListSections(env, account.id, p.sections || []);
    // Done -- unless a save changed a list while this copy was under way and
    // could not mirror it (it marks the job dirty). Then the account is
    // queued to be copied again, which is quick: unchanged lists are skipped.
    const progress = { recon: finishListsRecon(p.recon), slugs: p.slugs.length, startedAt: p.startedAt, finishedAt: Date.now() };
    const done = await env.DB.prepare(
      `UPDATE jobs SET status = 'done', attempts = ?, run_after = 0, progress_json = ?, last_error = NULL, updated_at = ?
       WHERE dedupe_key = ? AND (payload_json IS NULL OR payload_json NOT LIKE '%"dirty":true%')`
    ).bind(job ? job.attempts : 0, JSON.stringify(progress), Date.now(), key).run();
    if (!(Number(done && done.meta && done.meta.changes) > 0)) {
      await env.DB.prepare("UPDATE jobs SET status = 'queued', payload_json = NULL, run_after = 0, progress_json = '{}', updated_at = ? WHERE dedupe_key = ?")
        .bind(Date.now(), key).run();
      return { finished: true, failed: false, requeued: true };
    }
    return { finished: true, failed: false };
  } catch (e) {
    console.error("lists backfill: account " + account.id + " failed", e);
    await saveListsBackfillJob(env, key, account.id, {
      status: "failed", attempts: (job ? job.attempts : 0) + 1,
      progress: { recon: p ? finishListsRecon(p.recon) : emptyListsRecon(), atSlug: p && p.slugs ? p.slugs[p.next] || null : null, failedAt: Date.now() },
      lastError: safeErrorMessage(e),
    });
    return { finished: true, failed: true };
  }
}

// --- The ownerless parts ------------------------------------------------------

async function backfillAnonymousLists(env, run, budget) {
  const st = run.anon || (run.anon = { slugs: null, next: 0, list: null, alive: [], recon: emptyListsRecon() });
  if (!st.slugs) st.slugs = await legacyAnonymousSlugs(env);
  while (st.next < st.slugs.length) {
    if (!listsBackfillOpsLeft(budget)) return false;
    const slug = st.slugs[st.next];
    const target = {
      legacyId: `a:${slug}`, slug, position: 0, ownerId: null, ownerName: null, anonymous: true,
      likeListId: `a:${slug}`, likeLedgerKey: `listlikevoters:user:${slug}`,
      read: (e) => readLegacyAnonymousList(e, slug),
    };
    const r = await backfillLegacyList(env, target, st.list, budget, st.recon);
    if (!r.done) {
      st.list = r.cursor;
      return false;
    }
    if (r.alive) st.alive.push(target.legacyId);
    st.next++;
    st.list = null;
  }
  await retireDeletedListCopies(env, null, new Set(st.alive), st.recon);
  st.alive = [];
  finishListsRecon(st.recon);
  return true;
}

async function backfillExternalLikes(env, run, budget) {
  const st = run.ext || (run.ext = { keys: null, next: 0, recon: emptyLikesRecon() });
  if (!st.keys) st.keys = await legacyExternalLikeKeys(env);
  while (st.next < st.keys.length) {
    if (!listsBackfillOpsLeft(budget)) return false;
    const hash = st.keys[st.next];
    const voters = await syncLegacyLikes(env, "external", hash, `ext:${hash}`, `extlikevoters:${hash}`, budget);
    let legacyCount = 0;
    try {
      const raw = await env.CONFIGS.get(`externallike:${hash}`);
      legacyCount = raw ? Number(JSON.parse(raw).likes) || 0 : 0;
    } catch {
      legacyCount = 0;
    }
    st.recon.targets++;
    st.recon.legacy += legacyCount;
    st.recon.voters += voters;
    // An outside list has no row to keep a higher count on, so a legacy total
    // above its voters is reported rather than kept. The like route has always
    // written the count from the ledger, so this should stay at zero.
    if (legacyCount > voters) {
      st.recon.belowLegacy += legacyCount - voters;
      listsBackfillSample(st.recon.samples, { key: hash, legacy: legacyCount, voters });
    }
    st.next++;
  }
  return true;
}

// --- The driver ---------------------------------------------------------------

function freshListsBackfillRun() {
  return { phase: "accounts", afterAccountId: 0, accountsTotal: 0, accountsDone: 0, accountsFailed: 0, startedAt: Date.now() };
}

function listsBackfillLimit(value, min, max) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : max;
}

// One bounded step. opts (admin only): restart -- start from the first
// account again; maxOps / maxItems / maxLookups -- a smaller step (tests use
// these to force a copy across many steps).
async function runListsBackfillStep(env, opts = {}) {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO jobs (type, dedupe_key, status, run_after, progress_json, created_at, updated_at) VALUES (?, ?, 'queued', 0, '{}', ?, ?) ON CONFLICT(dedupe_key) DO NOTHING"
  ).bind(LISTS_BACKFILL_TYPE, LISTS_BACKFILL_RUN_KEY, now, now).run();
  const claim = await env.DB.prepare(
    "UPDATE jobs SET run_after = ?, updated_at = ? WHERE dedupe_key = ? AND run_after <= ?"
  ).bind(now + LISTS_BACKFILL_LEASE_MS, now, LISTS_BACKFILL_RUN_KEY, now).run();
  if (!claim || !claim.meta || Number(claim.meta.changes) !== 1) {
    return { ok: false, busy: true, error: "Another copy step is running. Try again in a minute." };
  }
  const meter = { ops: 0 };
  const menv = listsBackfillEnv(env, meter);
  const budget = {
    meter,
    maxOps: listsBackfillLimit(opts.maxOps, 20, LISTS_BACKFILL_STEP_OPS),
    items: listsBackfillLimit(opts.maxItems, 1, LISTS_BACKFILL_STEP_ITEMS),
    lookups: listsBackfillLimit(opts.maxLookups, 0, LISTS_BACKFILL_STEP_LOOKUPS),
    accountIds: new Map(),
  };
  let run;
  try {
    const job = await loadListsBackfillJob(menv, LISTS_BACKFILL_RUN_KEY);
    run = !opts.restart && job && job.progress && job.progress.phase ? job.progress : freshListsBackfillRun();
    if (opts.restart) {
      // An account left half copied starts again from its first list.
      await menv.DB.prepare("UPDATE jobs SET status = 'queued' WHERE type = ? AND account_id IS NOT NULL AND status = 'running'")
        .bind(LISTS_BACKFILL_TYPE).run();
    }
    if (run.phase === "accounts" && run.afterAccountId === 0 && run.accountsDone === 0) {
      const counted = await menv.DB.prepare("SELECT count(*) AS n FROM accounts WHERE deleted_at IS NULL").first();
      run.accountsTotal = Number(counted && counted.n) || 0;
      if (!run.accountsTotal) {
        await saveListsBackfillJob(menv, LISTS_BACKFILL_RUN_KEY, null, { status: "queued", progress: {}, runAfter: 0 });
        return { ok: false, error: "The accounts table is empty. Run Migrate Accounts first." };
      }
    }
    while (run.phase !== "done" && listsBackfillOpsLeft(budget)) {
      if (run.phase === "accounts") {
        const account = await menv.DB.prepare(
          "SELECT id, username, display_name FROM accounts WHERE id > ? AND deleted_at IS NULL ORDER BY id LIMIT 1"
        ).bind(run.afterAccountId).first();
        if (!account) {
          run.phase = "anonymous";
          continue;
        }
        const r = await backfillAccountLists(menv, account, budget);
        if (!r.finished) break;
        // A save it could not wait for changed a list: copy the account again
        // now (unchanged lists are skipped), rather than leave it for a read.
        if (r.requeued) continue;
        run.afterAccountId = account.id;
        run.accountsDone++;
        if (r.failed) run.accountsFailed++;
      } else if (run.phase === "anonymous") {
        if (!(await backfillAnonymousLists(menv, run, budget))) break;
        run.phase = "external";
      } else if (run.phase === "external") {
        if (!(await backfillExternalLikes(menv, run, budget))) break;
        run.phase = "channels";
      } else if (run.phase === "channels") {
        // Shared and published channels (35_channels-v2.js), P3b-8.
        if (!(await backfillSharedChannels(menv, run, budget))) break;
        run.phase = "done";
        run.finishedAt = Date.now();
      }
    }
    run.updatedAt = Date.now();
    await saveListsBackfillJob(menv, LISTS_BACKFILL_RUN_KEY, null, { status: run.phase === "done" ? "done" : "running", progress: run, runAfter: 0 });
  } catch (e) {
    // Let go of the lease so the next step can try again.
    await env.DB.prepare("UPDATE jobs SET run_after = 0, last_error = ?, updated_at = ? WHERE dedupe_key = ?")
      .bind(safeErrorMessage(e), Date.now(), LISTS_BACKFILL_RUN_KEY).run();
    throw e;
  }
  return {
    ok: true, done: run.phase === "done", phase: run.phase,
    accountsTotal: run.accountsTotal, accountsDone: run.accountsDone, accountsFailed: run.accountsFailed,
    ops: meter.ops,
  };
}

// Where the run is, and the reconciliation added up over every account.
async function listsBackfillStatus(env) {
  const run = await loadListsBackfillJob(env, LISTS_BACKFILL_RUN_KEY);
  const sum = (path) => `COALESCE(sum(json_extract(progress_json, '$.recon.${path}')), 0)`;
  const { results } = await env.DB.prepare(
    `SELECT status, count(*) AS n,
       ${sum("lists.legacy")} AS lists_legacy, ${sum("lists.copied")} AS lists_copied, ${sum("lists.unchanged")} AS lists_unchanged,
       ${sum("lists.missing")} AS lists_missing, ${sum("lists.removed")} AS lists_removed,
       ${sum("items.legacy")} AS items_legacy, ${sum("items.copied")} AS items_copied, ${sum("items.unusable")} AS items_unusable,
       ${sum("items.duplicates")} AS items_duplicates, ${sum("items.carried")} AS items_carried, ${sum("items.stubs")} AS items_stubs,
       ${sum("likes.legacy")} AS likes_legacy, ${sum("likes.voters")} AS likes_voters, ${sum("likes.keptFromCount")} AS likes_kept
     FROM jobs WHERE type = ? AND account_id IS NOT NULL GROUP BY status`
  ).bind(LISTS_BACKFILL_TYPE).all();
  const accounts = { done: 0, running: 0, failed: 0 };
  const totals = {
    lists: { legacy: 0, copied: 0, unchanged: 0, missing: 0, removed: 0 },
    items: { legacy: 0, copied: 0, unusable: 0, duplicates: 0, carried: 0, stubs: 0 },
    likes: { legacy: 0, voters: 0, keptFromCount: 0 },
  };
  for (const r of results || []) {
    accounts[r.status] = (accounts[r.status] || 0) + r.n;
    totals.lists.legacy += r.lists_legacy; totals.lists.copied += r.lists_copied; totals.lists.unchanged += r.lists_unchanged;
    totals.lists.missing += r.lists_missing; totals.lists.removed += r.lists_removed;
    totals.items.legacy += r.items_legacy; totals.items.copied += r.items_copied; totals.items.unusable += r.items_unusable;
    totals.items.duplicates += r.items_duplicates; totals.items.carried += r.items_carried; totals.items.stubs += r.items_stubs;
    totals.likes.legacy += r.likes_legacy; totals.likes.voters += r.likes_voters; totals.likes.keptFromCount += r.likes_kept;
  }
  const lost = Math.max(0, totals.items.legacy - totals.items.copied);
  const { results: failed } = await env.DB.prepare(
    "SELECT account_id, last_error, progress_json FROM jobs WHERE type = ? AND status = 'failed' ORDER BY updated_at DESC LIMIT 20"
  ).bind(LISTS_BACKFILL_TYPE).all();
  const { results: worst } = await env.DB.prepare(
    `SELECT account_id, json_extract(progress_json, '$.recon.mismatchRate') AS rate, json_extract(progress_json, '$.recon.samples') AS samples
     FROM jobs WHERE type = ? AND status = 'done' AND account_id IS NOT NULL
       AND json_extract(progress_json, '$.recon.mismatchRate') > 0
     ORDER BY rate DESC LIMIT 10`
  ).bind(LISTS_BACKFILL_TYPE).all();
  const progress = run ? run.progress || {} : {};
  return {
    ok: true,
    run: run ? {
      phase: progress.phase || "not started", accountsTotal: progress.accountsTotal || 0, accountsDone: progress.accountsDone || 0,
      startedAt: progress.startedAt || null, updatedAt: progress.updatedAt || null, finishedAt: progress.finishedAt || null,
      lastError: run.last_error || null,
    } : { phase: "not started" },
    accounts,
    totals,
    mismatchRate: totals.items.legacy > 0 ? lost / totals.items.legacy : 0,
    anonymous: progress.anon ? finishListsRecon(progress.anon.recon) : null,
    external: progress.ext ? progress.ext.recon : null,
    channels: progress.chan ? progress.chan.recon : null,
    failed: (failed || []).map((r) => ({ accountId: r.account_id, error: r.last_error })),
    worst: (worst || []).map((r) => {
      let samples = null;
      try {
        samples = typeof r.samples === "string" ? JSON.parse(r.samples) : r.samples;
      } catch {
        samples = null;
      }
      return { accountId: r.account_id, mismatchRate: r.rate, samples };
    }),
  };
}

async function handleListsBackfillApi(request, env, url, path) {
  if (!path.startsWith("/admin/api/lists-backfill/")) return null;
  if (!(await isAdminRequest(request, env))) return json({ ok: false, error: "Not authorized." }, 401);
  if (!env || !env.DB) return json({ ok: false, error: "No D1 database binding 'DB'." }, 503);
  try {
    if (path === "/admin/api/lists-backfill/step" && request.method === "POST") {
      let body = {};
      try {
        body = await request.json();
      } catch {
        body = {};
      }
      const out = await runListsBackfillStep(env, body || {});
      return json(out, out.ok || out.busy ? 200 : 409);
    }
    if (path === "/admin/api/lists-backfill/status" && request.method === "GET") {
      return json(await listsBackfillStatus(env));
    }
    return json({ ok: false, error: "Not found." }, 404);
  } catch (e) {
    console.error("Lists backfill failed:", e);
    const msg = safeErrorMessage(e);
    if (/no such table|no such column/i.test(msg)) return json({ ok: false, error: "Apply migration 0016 first." }, 503);
    return json({ ok: false, error: msg }, 500);
  }
}
