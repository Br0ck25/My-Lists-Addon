
// --- Lists v2 API (Phase 3b, P3b-4) ------------------------------------------
//
// Item-level list endpoints over the v2 tables (migration 0016), for the
// Phase 6 pages. A signed-in session owns what it writes:
//
//   GET    /api/lists                            the signed-in account's lists
//   POST   /api/lists                            create one (optionally with up to 500 items)
//   GET    /api/lists/:publicId                  one list and a page of its items (?limit, ?cursor)
//   PATCH  /api/lists/:publicId                  name, description, type, address, place among lists  (If-Match)
//   DELETE /api/lists/:publicId                  delete                                                (If-Match)
//   PUT    /api/lists/:publicId/visibility       private | unlisted | public
//   POST   /api/lists/:publicId/items            add up to 500 items
//   DELETE /api/lists/:publicId/items/:mediaId   remove one entry (?season=&episode= for an episode)
//   POST   /api/lists/:publicId/items/move       move one entry after another, or to the top
//
// Anyone may read a public or unlisted list; a private one answers 404 to
// everyone but its owner, so its existence is not given away.
//
// Every write is one D1 batch that also sets the list's item_count and bumps
// its version and the account's version (the change feed). PATCH and DELETE
// need If-Match with the version (428 without it, 412 once it has moved on):
// the batch's first statement is that check, and the statements after it
// read the state it left, so a write that loses a race changes nothing but a
// spare bump of the account's version.
//
// Behind FF_V2_LISTS_API, off by default. It must stay off in production
// until reads move to v2 (P3b-7): until then the legacy store is the truth,
// and the backfill (30_lists-backfill.js) would overwrite edits made here to
// a copied list the next time that list changes in the legacy store.

const LISTS_API_ITEMS_MAX = 500;          // items per add
const LISTS_API_PAGE_DEFAULT = 100;       // items per GET page
const LISTS_API_PAGE_MAX = 500;
const LISTS_API_LOOKUPS = 100;            // TMDB lookups per add; the rest become stubs, retried later
const LISTS_API_ITEM_ROWS = 12;           // rows per INSERT into list_items: 8 parameters each
const LISTS_API_ITEM_JSON_MAX = 16384;    // one item as sent, in bytes
const LISTS_API_DESCRIPTION_MAX = 1000;
const LISTS_API_NOTE_MAX = 500;
const LISTS_API_VISIBILITIES = new Set(["private", "unlisted", "public"]);
const LISTS_API_MEDIA_TYPES = new Set(["movie", "series", "mixed"]);
const LISTS_API_ROW_COLUMNS = "l.id, l.public_id, l.owner_account_id, l.slug, l.name, l.description, l.kind, l.media_type, l.visibility, l.source_provider, l.source_ref, l.synced_at, l.item_count, l.like_count, l.position, l.version, l.created_at, l.updated_at, l.deleted_at";

function isListsApiEnabled(env) {
  const v = env ? env.FF_V2_LISTS_API : undefined;
  return v === "1" || v === "true" || v === true;
}

function listSummary(row, owner) {
  return {
    publicId: row.public_id,
    slug: row.slug,
    name: row.name,
    description: row.description || null,
    kind: row.kind,
    mediaType: row.media_type,
    visibility: row.visibility,
    itemCount: row.item_count,
    likeCount: row.like_count,
    position: row.position,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    owner: owner || null,
    source: row.source_ref ? { provider: row.source_provider || null, ref: row.source_ref, syncedAt: row.synced_at || null } : null,
  };
}

function listEntryView(r) {
  let extra = null;
  try {
    extra = r.extra_json ? JSON.parse(r.extra_json) : null;
  } catch {
    extra = null;
  }
  const poster = r.poster_path ? (r.poster_path.startsWith("/") ? "https://image.tmdb.org/t/p/w500" + r.poster_path : r.poster_path) : null;
  return {
    mediaId: r.media_id,
    id: r.imdb_id || (r.tmdb_id ? "tmdb:" + r.tmdb_id : r.alt_id || null),
    kind: r.kind,
    imdbId: r.imdb_id || null,
    tmdbId: r.tmdb_id || null,
    title: r.title || null,
    year: r.year || null,
    poster,
    season: r.season,
    episode: r.episode,
    position: r.position,
    addedAt: r.added_at,
    note: r.note || null,
    extra,
  };
}

// "3", '"3"' and W/"3" all mean version 3. Anything else is no version.
function parseIfMatch(request) {
  const raw = request.headers.get("If-Match");
  if (raw == null) return null;
  const m = /^\s*(?:W\/)?"?(\d+)"?\s*$/.exec(raw);
  return m ? Number(m[1]) : NaN;
}

function listsApiOwnerName(account) {
  return listOwnerSearchName(account.username, account.displayName);
}

// Keeps lists_fts2 in step with a list, from whatever state the batch has
// left it in: only public, live lists are searchable.
function listSearchStatements(env, listId, ownerName) {
  return [
    env.DB.prepare("DELETE FROM lists_fts2 WHERE rowid = ?").bind(listId),
    env.DB.prepare(
      "INSERT INTO lists_fts2 (rowid, name, description, owner_name) SELECT id, name, description, ? FROM lists WHERE id = ? AND visibility = 'public' AND deleted_at IS NULL"
    ).bind(ownerName, listId),
  ];
}

function accountVersionStatement(env, accountId) {
  return env.DB.prepare("UPDATE accounts SET version = version + 1 WHERE id = ?").bind(accountId);
}

// item_count from the rows themselves, and a version bump only when the
// count actually moved: an add made only of titles already in the list
// changes nothing, so it bumps nothing.
function listCountStatement(env, listId, now) {
  return env.DB.prepare(
    `UPDATE lists SET item_count = (SELECT count(*) FROM list_items WHERE list_id = ?), version = version + 1, updated_at = ?
     WHERE id = ? AND item_count != (SELECT count(*) FROM list_items WHERE list_id = ?)`
  ).bind(listId, now, listId, listId);
}

async function loadApiList(env, publicId) {
  return env.DB.prepare(
    `SELECT ${LISTS_API_ROW_COLUMNS}, a.username AS owner_username, a.display_name AS owner_display_name
     FROM lists l LEFT JOIN accounts a ON a.id = l.owner_account_id WHERE l.public_id = ?`
  ).bind(publicId).first();
}

function ownerOf(row) {
  return row.owner_account_id ? { username: row.owner_username, displayName: row.owner_display_name || row.owner_username } : null;
}

async function isListSlugTaken(env, account, slug, exceptListId) {
  const live = await env.DB.prepare(
    "SELECT id FROM lists WHERE owner_account_id = ? AND slug = ? AND deleted_at IS NULL"
  ).bind(account.id, slug).first();
  if (live && live.id !== exceptListId) return true;
  const history = await env.DB.prepare(
    "SELECT list_id FROM list_slug_history WHERE owner_account_id = ? AND old_slug = ?"
  ).bind(account.id, slug).first();
  if (history && history.list_id !== exceptListId) return true;
  // A legacy list at that address the backfill has not copied yet: taking it
  // would collide when it does.
  const legacyRow = await env.DB.prepare("SELECT id FROM creator_lists WHERE id = ?").bind(`${account.username}:${slug}`).first();
  if (legacyRow) return true;
  if (env.CONFIGS && (await env.CONFIGS.get(`creatorlist:${account.username}:${slug}`))) return true;
  return false;
}

// Items as the caller sent them -> rows to insert, in order. Titles are
// resolved through 29_media.js; an item with no usable id, or one already in
// the list (or earlier in this request), is reported and left out.
async function prepareListEntries(env, listId, items, mediaKind) {
  const cleaned = items.map((item) => {
    if (!item || typeof item !== "object") return null;
    const { note, addedAt, ...rest } = item;
    return { item: rest, note: typeof note === "string" && note.trim() ? note.trim().slice(0, LISTS_API_NOTE_MAX) : null };
  });
  const { ids } = await resolveMediaBatch(env, cleaned.map((c) => (c ? c.item : null)), { kind: mediaKind, maxLookups: LISTS_API_LOOKUPS });
  const mediaIds = [...new Set(ids.filter((id) => id != null))];
  const media = new Map();
  const taken = new Set();
  const entryKey = (mediaId, season, episode) => mediaId + ":" + season + ":" + episode;
  for (let i = 0; i < mediaIds.length; i += MEDIA_LOOKUP_CHUNK) {
    const part = mediaIds.slice(i, i + MEDIA_LOOKUP_CHUNK);
    const marks = part.map(() => "?").join(", ");
    const { results } = await env.DB.prepare(`SELECT id, title, year, poster_path FROM media WHERE id IN (${marks})`).bind(...part).all();
    for (const r of results || []) media.set(r.id, r);
    if (listId != null) {
      const existing = await env.DB.prepare(
        `SELECT media_id, season, episode FROM list_items WHERE list_id = ? AND media_id IN (${marks})`
      ).bind(listId, ...part).all();
      for (const r of existing.results || []) taken.add(entryKey(r.media_id, r.season, r.episode));
    }
  }
  const results = [];
  const rows = [];
  cleaned.forEach((c, i) => {
    const id = ids[i];
    if (!c || id == null) {
      results.push({ mediaId: null, status: "unusable" });
      return;
    }
    const ep = legacyItemEpisode(c.item);
    const key = entryKey(id, ep.season, ep.episode);
    if (taken.has(key)) {
      results.push({ mediaId: id, season: ep.season, episode: ep.episode, status: "duplicate" });
      return;
    }
    taken.add(key);
    rows.push({ mediaId: id, season: ep.season, episode: ep.episode, note: c.note, extra: legacyItemExtra(c.item, media.get(id), ep.isEpisode) });
    results.push({ mediaId: id, season: ep.season, episode: ep.episode, status: "added" });
  });
  return { rows, results };
}

// INSERTs for prepared rows. The list is named by its public id, so a new
// list and its first items can go in one batch before its row id is known.
function listEntryInsertStatements(env, publicId, rows, firstPosition, now) {
  const stmts = [];
  for (let i = 0; i < rows.length; i += LISTS_API_ITEM_ROWS) {
    const part = rows.slice(i, i + LISTS_API_ITEM_ROWS);
    const args = [];
    part.forEach((r, j) => {
      args.push(publicId, r.mediaId, r.season, r.episode, firstPosition + i + j, now, r.note, r.extra);
    });
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO list_items (list_id, media_id, season, episode, position, added_at, note, extra_json)
       SELECT l.id, v.column2, v.column3, v.column4, v.column5, v.column6, v.column7, v.column8
       FROM (VALUES ${part.map(() => "(?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}) AS v
       JOIN lists l ON l.public_id = v.column1`
    ).bind(...args));
  }
  return stmts;
}

function validateListItems(items) {
  if (!Array.isArray(items)) return "items must be a list.";
  if (items.length > LISTS_API_ITEMS_MAX) return `At most ${LISTS_API_ITEMS_MAX} items at a time.`;
  for (const item of items) {
    if (utf8ByteLength(JSON.stringify(item === undefined ? null : item)) > LISTS_API_ITEM_JSON_MAX) return "One of those items is too large.";
  }
  return null;
}

function mediaKindForList(mediaType) {
  return mediaType === "series" ? "series" : (mediaType === "movie" ? "movie" : null);
}

async function readApiJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return null;
  }
}

async function handleListsApi(request, env, url, path) {
  if (path !== "/api/lists" && !path.startsWith("/api/lists/")) return null;
  // The legacy list routes under /api/lists/ keep answering as they do.
  if (path === "/api/lists/like" || path === "/api/lists/like-external") return null;
  if (!isListsApiEnabled(env)) return null;
  if (!env || !env.DB) return json({ ok: false, error: "Lists aren't available right now." }, 503);
  try {
    return await handleListsApiRoutes(request, env, url, path);
  } catch (e) {
    console.error("Lists API failed:", e);
    const msg = safeErrorMessage(e);
    if (/UNIQUE constraint failed: .*slug/i.test(msg)) return json({ ok: false, error: "That address is already taken." }, 409);
    return json({ ok: false, error: "Lists aren't available right now." }, 503);
  }
}

async function handleListsApiRoutes(request, env, url, path) {
  const parts = path.split("/").filter(Boolean); // ["api", "lists", publicId?, sub?, sub2?]
  const account = request.account || null;
  const now = Date.now();

  if (parts.length === 2) {
    if (!account) return json({ ok: false, error: "Sign in to manage your lists.", signInRequired: true }, 401);
    if (request.method === "GET") {
      const { results } = await env.DB.prepare(
        `SELECT ${LISTS_API_ROW_COLUMNS} FROM lists l WHERE l.owner_account_id = ? AND l.deleted_at IS NULL ORDER BY l.position, l.id LIMIT ?`
      ).bind(account.id, CREATOR_LIST_ORDER_MAX).all();
      const acct = await env.DB.prepare("SELECT version FROM accounts WHERE id = ?").bind(account.id).first();
      const owner = { username: account.username, displayName: account.displayName || account.username };
      return json({ ok: true, accountVersion: acct ? acct.version : 0, lists: (results || []).map((r) => listSummary(r, owner)) });
    }
    if (request.method === "POST") return createApiList(request, env, account, now);
    return json({ ok: false, error: "Not found." }, 404);
  }

  const publicId = parts[2];
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(publicId)) return json({ ok: false, error: "Not found." }, 404);
  const row = await loadApiList(env, publicId);
  const isOwner = Boolean(account && row && row.owner_account_id === account.id);
  const visible = row && row.deleted_at == null && (isOwner || row.visibility === "public" || row.visibility === "unlisted");
  if (!visible) return json({ ok: false, error: "Not found." }, 404);

  if (parts.length === 3 && request.method === "GET") {
    const limit = Math.max(1, Math.min(LISTS_API_PAGE_MAX, parseInt(url.searchParams.get("limit") || "", 10) || LISTS_API_PAGE_DEFAULT));
    let afterPosition = -Infinity;
    let afterEntry = 0;
    const cursor = url.searchParams.get("cursor");
    if (cursor) {
      const [p, e] = cursor.split(":");
      if (!Number.isFinite(Number(p)) || !Number.isInteger(Number(e))) return json({ ok: false, error: "Bad cursor." }, 400);
      afterPosition = Number(p);
      afterEntry = Number(e);
    }
    const { results } = await env.DB.prepare(
      `SELECT li.id AS entry_id, li.media_id, li.season, li.episode, li.position, li.added_at, li.note, li.extra_json,
              m.kind, m.imdb_id, m.tmdb_id, m.alt_id, m.title, m.year, m.poster_path
       FROM list_items li JOIN media m ON m.id = li.media_id
       WHERE li.list_id = ? AND (li.position > ? OR (li.position = ? AND li.id > ?))
       ORDER BY li.position, li.id LIMIT ?`
    ).bind(row.id, afterPosition === -Infinity ? -1e308 : afterPosition, afterPosition === -Infinity ? -1e308 : afterPosition, afterEntry, limit + 1).all();
    const page = (results || []).slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = (results || []).length > limit && last ? `${last.position}:${last.entry_id}` : null;
    return json(
      { ok: true, list: listSummary(row, ownerOf(row)), items: page.map(listEntryView), nextCursor },
      200,
      { ETag: `"${row.version}"` }
    );
  }

  // Everything below changes the list: its owner only. A legacy anonymous
  // list has no owner, so nobody can change it.
  if (!account) return json({ ok: false, error: "Sign in to change this list.", signInRequired: true }, 401);
  if (!isOwner) return json({ ok: false, error: "That list belongs to someone else." }, 403);
  const ownerName = listsApiOwnerName(account);

  if (parts.length === 3 && (request.method === "PATCH" || request.method === "DELETE")) {
    const expected = parseIfMatch(request);
    if (expected === null) return json({ ok: false, error: "Send If-Match with the list's version." }, 428);
    if (!Number.isFinite(expected) || expected !== row.version) {
      return json({ ok: false, error: "This list has changed since you loaded it.", conflict: true, version: row.version }, 412);
    }
    if (request.method === "DELETE") {
      const out = await env.DB.batch([
        env.DB.prepare("UPDATE lists SET deleted_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND deleted_at IS NULL")
          .bind(now, now, row.id, expected),
        ...listSearchStatements(env, row.id, ownerName),
        accountVersionStatement(env, account.id),
      ]);
      if (!(Number(out[0] && out[0].meta && out[0].meta.changes) > 0)) {
        return json({ ok: false, error: "This list has changed since you loaded it.", conflict: true }, 412);
      }
      return json({ ok: true });
    }
    return patchApiList(request, env, account, row, expected, ownerName, now);
  }

  if (parts.length === 4 && parts[3] === "visibility" && request.method === "PUT") {
    const body = await readApiJson(request);
    if (!body) return json({ ok: false, error: "Invalid JSON body." }, 400);
    if (!LISTS_API_VISIBILITIES.has(body.visibility)) return json({ ok: false, error: "visibility must be private, unlisted or public." }, 400);
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE lists SET visibility = ?, item_count = (SELECT count(*) FROM list_items WHERE list_id = ?), version = version + 1, updated_at = ?
         WHERE id = ? AND visibility != ?`
      ).bind(body.visibility, row.id, now, row.id, body.visibility),
      ...listSearchStatements(env, row.id, ownerName),
      accountVersionStatement(env, account.id),
    ]);
    return json({ ok: true, list: listSummary(await loadApiList(env, publicId), ownerOf(row)) });
  }

  if (parts.length === 4 && parts[3] === "items" && request.method === "POST") {
    const body = await readApiJson(request);
    if (!body) return json({ ok: false, error: "Invalid JSON body." }, 400);
    const problem = validateListItems(body.items);
    if (problem) return json({ ok: false, error: problem }, 400);
    const { rows, results } = await prepareListEntries(env, row.id, body.items, mediaKindForList(row.media_type));
    if (row.item_count + rows.length > PUBLISHED_LIST_ITEMS_MAX) {
      return json({ ok: false, error: `A list can hold at most ${PUBLISHED_LIST_ITEMS_MAX} items.` }, 413);
    }
    let first;
    if (body.at === "start") {
      const min = await env.DB.prepare("SELECT min(position) AS p FROM list_items WHERE list_id = ?").bind(row.id).first();
      first = (min && min.p != null ? min.p : 0) - rows.length;
    } else {
      const max = await env.DB.prepare("SELECT max(position) AS p FROM list_items WHERE list_id = ?").bind(row.id).first();
      first = (max && max.p != null ? max.p : -1) + 1;
    }
    if (rows.length) {
      await env.DB.batch([
        ...listEntryInsertStatements(env, row.public_id, rows, first, now),
        listCountStatement(env, row.id, now),
        accountVersionStatement(env, account.id),
      ]);
    }
    return json({
      ok: true,
      added: results.filter((r) => r.status === "added").length,
      duplicates: results.filter((r) => r.status === "duplicate").length,
      unusable: results.filter((r) => r.status === "unusable").length,
      results,
      list: listSummary(await loadApiList(env, publicId), ownerOf(row)),
    });
  }

  if (parts.length === 5 && parts[3] === "items" && parts[4] === "move" && request.method === "POST") {
    return moveApiListEntry(request, env, account, row, now);
  }

  if (parts.length === 5 && parts[3] === "items" && request.method === "DELETE") {
    const mediaId = Number(parts[4]);
    if (!Number.isInteger(mediaId) || mediaId <= 0) return json({ ok: false, error: "Not found." }, 404);
    const season = url.searchParams.has("season") ? Number(url.searchParams.get("season")) : null;
    const episode = url.searchParams.has("episode") ? Number(url.searchParams.get("episode")) : null;
    if ((season !== null && !Number.isInteger(season)) || (episode !== null && !Number.isInteger(episode))) {
      return json({ ok: false, error: "season and episode must be whole numbers." }, 400);
    }
    const entry = await env.DB.prepare(
      "SELECT id FROM list_items WHERE list_id = ? AND media_id = ? AND season IS ? AND episode IS ?"
    ).bind(row.id, mediaId, season, episode).first();
    if (!entry) return json({ ok: false, error: "That isn't in this list." }, 404);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM list_items WHERE id = ?").bind(entry.id),
      listCountStatement(env, row.id, now),
      accountVersionStatement(env, account.id),
    ]);
    return json({ ok: true, list: listSummary(await loadApiList(env, publicId), ownerOf(row)) });
  }

  return json({ ok: false, error: "Not found." }, 404);
}

async function createApiList(request, env, account, now) {
  const body = await readApiJson(request);
  if (!body) return json({ ok: false, error: "Invalid JSON body." }, 400);
  const name = String(body.name || "").trim();
  if (!name) return json({ ok: false, error: "Missing a list name." }, 400);
  if (name.length > PUBLISHED_LIST_NAME_MAX) return json({ ok: false, error: "That list name is too long." }, 400);
  if (!LISTS_API_MEDIA_TYPES.has(body.mediaType)) return json({ ok: false, error: "mediaType must be movie, series or mixed." }, 400);
  const visibility = body.visibility === undefined ? "private" : body.visibility;
  if (!LISTS_API_VISIBILITIES.has(visibility)) return json({ ok: false, error: "visibility must be private, unlisted or public." }, 400);
  const description = body.description == null ? null : String(body.description).trim().slice(0, LISTS_API_DESCRIPTION_MAX) || null;
  const items = body.items === undefined ? [] : body.items;
  const problem = validateListItems(items);
  if (problem) return json({ ok: false, error: problem }, 400);

  const counted = await env.DB.prepare("SELECT count(*) AS n, max(position) AS p FROM lists WHERE owner_account_id = ? AND deleted_at IS NULL").bind(account.id).first();
  if (Number(counted && counted.n) >= CREATOR_LIST_ORDER_MAX) return json({ ok: false, error: "You have too many lists to add another." }, 409);
  const base = slugifyServer(body.slug || name) || "list";
  const slug = await pickFreeSlug(base, (candidate) => isListSlugTaken(env, account, candidate, null));
  if (!slug) return json({ ok: false, error: "Couldn't find a free address for that list name. Try a slightly different name." }, 409);

  const publicId = generateShortId();
  const { rows, results } = await prepareListEntries(env, null, items, mediaKindForList(body.mediaType));
  const position = counted && counted.p != null ? counted.p + 1 : 0;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO lists (public_id, owner_account_id, slug, name, description, kind, media_type, visibility, item_count, like_count, position, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'custom', ?, ?, 0, 0, ?, 1, ?, ?)`
    ).bind(publicId, account.id, slug, name, description, body.mediaType, visibility, position, now, now),
    ...listEntryInsertStatements(env, publicId, rows, 0, now),
    env.DB.prepare("UPDATE lists SET item_count = (SELECT count(*) FROM list_items WHERE list_id = lists.id) WHERE public_id = ?").bind(publicId),
    env.DB.prepare(
      "INSERT INTO lists_fts2 (rowid, name, description, owner_name) SELECT id, name, description, ? FROM lists WHERE public_id = ? AND visibility = 'public'"
    ).bind(listsApiOwnerName(account), publicId),
    accountVersionStatement(env, account.id),
  ]);
  const created = await loadApiList(env, publicId);
  return json({ ok: true, list: listSummary(created, ownerOf(created)), results }, 201);
}

async function patchApiList(request, env, account, row, expected, ownerName, now) {
  const body = await readApiJson(request);
  if (!body) return json({ ok: false, error: "Invalid JSON body." }, 400);
  const next = { name: row.name, description: row.description, mediaType: row.media_type, slug: row.slug, position: row.position };
  if (body.name !== undefined) {
    const name = String(body.name || "").trim();
    if (!name) return json({ ok: false, error: "Missing a list name." }, 400);
    if (name.length > PUBLISHED_LIST_NAME_MAX) return json({ ok: false, error: "That list name is too long." }, 400);
    next.name = name;
  }
  if (body.description !== undefined) {
    next.description = body.description == null ? null : String(body.description).trim().slice(0, LISTS_API_DESCRIPTION_MAX) || null;
  }
  if (body.mediaType !== undefined) {
    if (!LISTS_API_MEDIA_TYPES.has(body.mediaType)) return json({ ok: false, error: "mediaType must be movie, series or mixed." }, 400);
    next.mediaType = body.mediaType;
  }
  if (body.position !== undefined) {
    if (!Number.isFinite(Number(body.position))) return json({ ok: false, error: "position must be a number." }, 400);
    next.position = Number(body.position);
  }
  if (body.slug !== undefined) {
    const slug = slugifyServer(body.slug);
    if (!slug) return json({ ok: false, error: "That address can't be used." }, 400);
    if (slug !== row.slug && (await isListSlugTaken(env, account, slug, row.id))) {
      return json({ ok: false, error: "That address is already taken." }, 409);
    }
    next.slug = slug;
  }
  const renamed = next.slug !== row.slug;
  const stmts = [
    env.DB.prepare(
      `UPDATE lists SET name = ?, description = ?, media_type = ?, slug = ?, position = ?,
         item_count = (SELECT count(*) FROM list_items WHERE list_id = ?), version = version + 1, updated_at = ?
       WHERE id = ? AND version = ? AND deleted_at IS NULL`
    ).bind(next.name, next.description, next.mediaType, next.slug, next.position, row.id, now, row.id, expected),
  ];
  if (renamed) {
    // Only if the rename went through: the old address keeps pointing here,
    // and the new one is no longer anyone's old address.
    stmts.push(env.DB.prepare(
      `INSERT OR REPLACE INTO list_slug_history (owner_account_id, old_slug, list_id, created_at)
       SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM lists WHERE id = ? AND slug = ?)`
    ).bind(account.id, row.slug, row.id, now, row.id, next.slug));
    stmts.push(env.DB.prepare(
      "DELETE FROM list_slug_history WHERE owner_account_id = ? AND old_slug = ? AND EXISTS (SELECT 1 FROM lists WHERE id = ? AND slug = ?)"
    ).bind(account.id, next.slug, row.id, next.slug));
  }
  stmts.push(...listSearchStatements(env, row.id, ownerName), accountVersionStatement(env, account.id));
  const out = await env.DB.batch(stmts);
  if (!(Number(out[0] && out[0].meta && out[0].meta.changes) > 0)) {
    return json({ ok: false, error: "This list has changed since you loaded it.", conflict: true }, 412);
  }
  const updated = await loadApiList(env, row.public_id);
  return json({ ok: true, list: listSummary(updated, ownerOf(updated)) });
}

// body: { mediaId, season?, episode?, after: null | { mediaId, season?, episode? } }
// Positions are REAL, so a move writes one row: halfway between its new
// neighbours. When repeated moves have left no room between two, the list
// is renumbered first.
async function moveApiListEntry(request, env, account, row, now) {
  const body = await readApiJson(request);
  if (!body) return json({ ok: false, error: "Invalid JSON body." }, 400);
  const findEntry = async (ref) => {
    if (!ref || !Number.isInteger(Number(ref.mediaId))) return null;
    const season = ref.season == null ? null : Number(ref.season);
    const episode = ref.episode == null ? null : Number(ref.episode);
    return env.DB.prepare(
      "SELECT id, position FROM list_items WHERE list_id = ? AND media_id = ? AND season IS ? AND episode IS ?"
    ).bind(row.id, Number(ref.mediaId), season, episode).first();
  };
  const neighbours = async (entry, after) => {
    if (!after) {
      const first = await env.DB.prepare(
        "SELECT position FROM list_items WHERE list_id = ? AND id != ? ORDER BY position, id LIMIT 1"
      ).bind(row.id, entry.id).first();
      return first ? { low: first.position - 1, high: first.position } : { low: 0, high: 1 };
    }
    const next = await env.DB.prepare(
      "SELECT position FROM list_items WHERE list_id = ? AND id != ? AND (position > ? OR (position = ? AND id > ?)) ORDER BY position, id LIMIT 1"
    ).bind(row.id, entry.id, after.position, after.position, after.id).first();
    return { low: after.position, high: next ? next.position : after.position + 1 };
  };
  let entry = await findEntry(body);
  if (!entry) return json({ ok: false, error: "That isn't in this list." }, 404);
  let after = null;
  if (body.after) {
    after = await findEntry(body.after);
    if (!after) return json({ ok: false, error: "The entry to move it after isn't in this list." }, 404);
    if (after.id === entry.id) return json({ ok: false, error: "An entry can't move after itself." }, 400);
  }
  let gap = await neighbours(entry, after);
  if (!(gap.high - gap.low > 1e-9)) {
    await env.DB.prepare(
      `UPDATE list_items SET position = (
         SELECT r.n FROM (SELECT id, row_number() OVER (ORDER BY position, id) - 1 AS n FROM list_items WHERE list_id = ?) AS r
         WHERE r.id = list_items.id)
       WHERE list_id = ?`
    ).bind(row.id, row.id).run();
    entry = await findEntry(body);
    after = body.after ? await findEntry(body.after) : null;
    gap = await neighbours(entry, after);
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE list_items SET position = ? WHERE id = ?").bind((gap.low + gap.high) / 2, entry.id),
    env.DB.prepare(
      "UPDATE lists SET item_count = (SELECT count(*) FROM list_items WHERE list_id = ?), version = version + 1, updated_at = ? WHERE id = ?"
    ).bind(row.id, now, row.id),
    accountVersionStatement(env, account.id),
  ]);
  return json({ ok: true, list: listSummary(await loadApiList(env, row.public_id), ownerOf(row)) });
}
