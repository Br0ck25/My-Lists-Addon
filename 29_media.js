
// --- Media: one row per movie or show (Phase 3b, P3b-2) ----------------------
//
// Lists v2 stores each title once, in `media` (migration 0016), and a list
// entry points at it. This turns whatever a list item carries -- an IMDb id,
// "tmdb:123", a bare TMDB number, a show id on an episode entry, or some
// other scheme's id -- into that row's id:
//
//   1. the database first, by every id the item has (IMDb, then TMDB within
//      its kind, then any other id);
//   2. what is still unknown is asked of TMDB (/{kind}/{id} for a TMDB id,
//      /find for an IMDb id), a few at a time and never more than the
//      caller's budget;
//   3. then inserted. An item TMDB cannot place still gets a row -- a stub,
//      holding only the ids it came with (and the item's own title as a
//      hint), with resolved_at NULL -- so no list entry is ever dropped for
//      want of a title. retryUnresolvedMedia tries the stubs again later.
//
// TMDB decides a title's kind: an IMDb id a list filed as a movie but TMDB
// knows as a show becomes a show. A kind the item states is only used to
// break a tie, to pick the endpoint for a TMDB id, and for a stub.
//
// Nothing calls this yet. The list backfill (P3b-3) and the list API (P3b-4)
// will. Server-only, at module level after the Worker's exports (like 27_
// and 28_), so it takes `env` from its caller. (Never write the two words
// of that export next to each other in a comment in these files:
// render_check.js cuts the combined file at the last place they appear.)

const MEDIA_LOOKUP_CHUNK = 90;      // ids per IN (...): D1 allows 100 bound parameters, and one more is the kind
const MEDIA_WRITE_CHUNK = 50;       // statements per D1 batch
const MEDIA_INSERT_ROWS = 8;        // rows per INSERT: 12 parameters each, under D1's 100
const MEDIA_TMDB_CONCURRENCY = 6;   // a Worker keeps at most six outbound connections open at once
const MEDIA_TMDB_LOOKUP_MAX = 200;  // titles looked up at TMDB per call, unless the caller sets maxLookups
const MEDIA_BULK_MIN = 32;          // rows from which one statement takes them all as JSON (d1JsonChunks)
const MEDIA_JSON_CHUNK_CHARS = 600000; // JSON per statement: under D1's 2 MB per row even at 3 bytes a character
const MEDIA_ROW_COLUMNS = "id, kind, tmdb_id, imdb_id, tvdb_id, alt_id, title, year, resolved_at";

function mediaKindOf(raw) {
  const s = String(raw == null ? "" : raw).trim().toLowerCase();
  if (s === "series" || s === "tv" || s === "show" || s === "episode") return "series";
  if (s === "movie") return "movie";
  return null;
}

function mediaYearOf(raw) {
  const y = parseInt(String(raw == null ? "" : raw).slice(0, 4), 10);
  return y >= 1870 && y <= 2100 ? y : null;
}

// One id string, in any of the forms list items use:
//   "tt0903747" (an episode suffix such as ":1:2" is dropped),
//   "tmdb:1396", "tmdb:tv:1396", "tmdb:movie:550", or a bare "1396" (TMDB),
//   "kitsu:1" and the like (kept verbatim as an alternative id),
//   and anything else, kept verbatim as an alternative id too: the legacy
//   lists serve whatever id they were given, so a copy must not drop one.
function parseMediaIdString(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s || s.length > 200) return null;
  const imdb = /^(tt\d+)(?::|$)/i.exec(s);
  if (imdb) return { imdbId: imdb[1].toLowerCase() };
  const tmdb = /^tmdb:(?:(movie|tv|series|show):)?(\d+)$/i.exec(s);
  if (tmdb) return { tmdbId: Number(tmdb[2]), kind: tmdb[1] ? mediaKindOf(tmdb[1]) : null };
  if (/^\d+$/.test(s)) return { tmdbId: Number(s) };
  const alt = /^([a-z][a-z0-9_-]*):(\S+)$/i.exec(s);
  if (alt) return { altId: alt[1].toLowerCase() + ":" + alt[2] };
  return { altId: s };
}

// A legacy list item (or a plain { imdbId, tmdbId, kind, title, year }) as
// the title it names: { kind, imdbId, tmdbId, altId, title, year }, or null
// when it carries no id this can use.
//
// An episode entry names its SHOW: its own `id` is TMDB's episode id (see
// the storyline list builder, 21_client-custom-list-builder.js), which is
// not a movie or show id and must never be read as one.
function normalizeMediaRef(input, kindHint) {
  if (!input || typeof input !== "object") return null;
  const isEpisode = String(input.type || "").toLowerCase() === "episode"
    || input.seasonNum != null || input.episodeNum != null
    || input.season != null || input.episode != null;
  let kind = isEpisode ? "series" : (mediaKindOf(input.kind) || mediaKindOf(input.type) || mediaKindOf(input.mediatype) || mediaKindOf(kindHint));
  const ref = { kind: null, imdbId: null, tmdbId: null, altId: null, title: null, year: null };
  const sources = isEpisode
    ? [input.showId, input.imdbId]
    : [input.imdbId, input.tmdbId, input.canonicalTmdbId, input.id, input.showId];
  for (const src of sources) {
    const p = parseMediaIdString(typeof src === "number" ? String(src) : src);
    if (!p) continue;
    if (p.imdbId && !ref.imdbId) ref.imdbId = p.imdbId;
    if (p.tmdbId && !ref.tmdbId) {
      ref.tmdbId = p.tmdbId;
      if (p.kind && !kind) kind = p.kind;
    }
    if (p.altId && !ref.altId) ref.altId = p.altId;
  }
  if (!ref.imdbId && !ref.tmdbId && !ref.altId) return null;
  // The legacy list code files an item with no type as a movie too.
  ref.kind = kind || "movie";
  const title = isEpisode ? input.showTitle : (input.title || input.name);
  // "Untitled" is the placeholder the page stores for an item with no name.
  if (typeof title === "string" && title.trim() && title.trim() !== "Untitled") ref.title = title.trim().slice(0, 300);
  if (!isEpisode) ref.year = mediaYearOf(input.year);
  return ref;
}

// Every key a ref (or a media row) can be found by, most trusted first. An
// IMDb id names one title whatever its kind; a TMDB id or another scheme's
// id only within a kind (TMDB reuses numbers across movies and TV).
function mediaRefKeys(ref) {
  const keys = [];
  const imdb = ref.imdbId || ref.imdb_id;
  const tmdb = ref.tmdbId || ref.tmdb_id;
  const alt = ref.altId || ref.alt_id;
  if (imdb) keys.push("imdb:" + imdb);
  if (tmdb) keys.push("tmdb:" + ref.kind + ":" + tmdb);
  if (alt) keys.push("alt:" + ref.kind + ":" + alt);
  return keys;
}

function indexMediaRows(rows) {
  const index = new Map();
  for (const row of rows) {
    for (const key of mediaRefKeys(row)) if (!index.has(key)) index.set(key, row);
  }
  return index;
}

function matchMediaRow(index, ref) {
  for (const key of mediaRefKeys(ref)) {
    const row = index.get(key);
    if (row) return row;
  }
  return null;
}

// Every media row any of these refs could be, in chunks the 100-parameter
// limit allows. Each query walks one of 0016's unique indexes.
// Rows for one statement to read with json_each(?), as few JSON arrays as fit
// D1's size limits. This is how a 10,000-item list is written in a few dozen
// queries rather than thousands: D1 allows about 1,000 per invocation, and 100
// bound parameters per statement, but one parameter may carry a large array.
function d1JsonChunks(rows, maxChars = MEDIA_JSON_CHUNK_CHARS) {
  const out = [];
  let cur = [];
  let size = 2;
  for (const r of rows) {
    const text = JSON.stringify(r);
    if (cur.length && size + text.length + 1 > maxChars) {
      out.push("[" + cur.join(",") + "]");
      cur = [];
      size = 2;
    }
    cur.push(text);
    size += text.length + 1;
  }
  if (cur.length) out.push("[" + cur.join(",") + "]");
  return out;
}

async function lookupMediaRows(env, refs) {
  const imdb = new Set();
  const tmdbByKind = { movie: new Set(), series: new Set() };
  const altByKind = { movie: new Set(), series: new Set() };
  for (const ref of refs) {
    if (!ref) continue;
    if (ref.imdbId) imdb.add(ref.imdbId);
    if (ref.tmdbId && tmdbByKind[ref.kind]) tmdbByKind[ref.kind].add(ref.tmdbId);
    if (ref.altId && altByKind[ref.kind]) altByKind[ref.kind].add(ref.altId);
  }
  const queries = [];
  const marks = (n) => new Array(n).fill("?").join(", ");
  // A few ids go in IN (...); many go in as one JSON array each statement.
  const lookup = (values, where, lead) => {
    const all = [...values];
    if (all.length > MEDIA_LOOKUP_CHUNK) {
      for (const chunk of d1JsonChunks(all)) {
        queries.push(env.DB.prepare(`SELECT ${MEDIA_ROW_COLUMNS} FROM media WHERE ${where} IN (SELECT value FROM json_each(?))`).bind(...lead, chunk));
      }
      return;
    }
    for (let i = 0; i < all.length; i += MEDIA_LOOKUP_CHUNK) {
      const ids = all.slice(i, i + MEDIA_LOOKUP_CHUNK);
      queries.push(env.DB.prepare(`SELECT ${MEDIA_ROW_COLUMNS} FROM media WHERE ${where} IN (${marks(ids.length)})`).bind(...lead, ...ids));
    }
  };
  lookup(imdb, "imdb_id", []);
  for (const kind of ["movie", "series"]) {
    lookup(tmdbByKind[kind], "kind = ? AND tmdb_id", [kind]);
    lookup(altByKind[kind], "kind = ? AND alt_id", [kind]);
  }
  const byId = new Map();
  for (const q of queries) {
    const { results } = await q.all();
    for (const row of results || []) byId.set(row.id, row);
  }
  return [...byId.values()];
}

function mediaFactsFromTmdb(data, kind, externalIds) {
  const ext = externalIds || {};
  const imdb = parseMediaIdString(ext.imdb_id || data.imdb_id || "");
  const tvdb = Number(ext.tvdb_id);
  const title = data.title || data.name || data.original_title || data.original_name || null;
  return {
    kind,
    tmdbId: Number(data.id),
    imdbId: imdb && imdb.imdbId ? imdb.imdbId : null,
    tvdbId: Number.isInteger(tvdb) && tvdb > 0 ? tvdb : null,
    title: title ? String(title).slice(0, 300) : null,
    year: mediaYearOf(data.release_date || data.first_air_date),
    posterPath: data.poster_path || null,
    backdropPath: data.backdrop_path || null,
  };
}

// What TMDB knows about one ref, or null when it has no answer (not found,
// an error, a timeout: a stub is made either way, and retried later).
//
// Edge-cached for a week like every other TMDB id lookup here: a title's ids
// do not change, and the cache is shared by every user.
async function fetchTmdbMediaFacts(ref, apiKey) {
  const init = {
    headers: { "User-Agent": `my-list-addon/${ADDON_VERSION}` },
    cf: { cacheTtl: 604800, cacheEverything: true },
  };
  const key = encodeURIComponent(apiKey);
  try {
    if (ref.tmdbId) {
      const path = ref.kind === "series" ? "tv" : "movie";
      const res = await fetch(`https://api.themoviedb.org/3/${path}/${ref.tmdbId}?api_key=${key}&append_to_response=external_ids`, init);
      if (res.ok) {
        const data = await res.json();
        if (data && data.id) return mediaFactsFromTmdb(data, ref.kind, data.external_ids);
      }
      if (!ref.imdbId) return null;
    }
    if (ref.imdbId) {
      const res = await fetch(`https://api.themoviedb.org/3/find/${encodeURIComponent(ref.imdbId)}?api_key=${key}&external_source=imdb_id`, init);
      if (!res.ok) return null;
      const data = await res.json();
      const movie = data && Array.isArray(data.movie_results) ? data.movie_results[0] : null;
      const tv = data && Array.isArray(data.tv_results) ? data.tv_results[0] : null;
      const pick = ref.kind === "series" ? (tv || movie) : (movie || tv);
      if (!pick || !pick.id) return null;
      return mediaFactsFromTmdb(pick, pick === tv ? "series" : "movie", { imdb_id: ref.imdbId });
    }
  } catch {
    return null;
  }
  return null;
}

async function mapMediaWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(new Array(Math.min(limit, items.length)).fill(0).map(worker));
  return out;
}

// inputs: legacy list items, or { imdbId?, tmdbId?, kind, title?, year? }.
// Returns { ids, stats }: ids[i] is inputs[i]'s media id, or null when the
// input carries no usable id.
//
// opts:
//   kind        the kind to assume for inputs that do not say (a list's type)
//   maxLookups  titles to look up at TMDB in this call (default 200). The
//               rest become stubs now and are retried later, so a caller can
//               bound how long one call runs and how many subrequests it spends.
//   tmdbKey     the TMDB key (defaults to env.TMDB_API_KEY). Without one,
//               everything unknown becomes a stub.
//   retryStubs  look up again the stubs this finds, upgrading them in place
//               (used by retryUnresolvedMedia).
//
// stats, per input: total, unusable (no id), found (already known), resolved
// (TMDB answered), stubs (TMDB did not, or was not asked). lookups is the
// number of titles tried at TMDB.
async function resolveMediaBatch(env, inputs, opts = {}) {
  if (!env || !env.DB) throw new Error("resolveMediaBatch: no D1 database is bound");
  const list = Array.isArray(inputs) ? inputs : [];
  const refs = list.map((input) => normalizeMediaRef(input, opts.kind));
  const stats = { total: list.length, unusable: 0, found: 0, resolved: 0, stubs: 0, lookups: 0 };
  const idOf = new Map(); // ref -> media id

  // 1. The database. Inputs naming the same title the same way share one
  //    pending entry, so a title that appears in many lists costs one TMDB call.
  const known = indexMediaRows(await lookupMediaRows(env, refs));
  const pending = [];
  const leadOf = new Map(); // ref -> the pending ref that stands for it
  const leadByKey = new Map();
  for (const ref of refs) {
    if (!ref) continue;
    const row = matchMediaRow(known, ref);
    if (row && !(opts.retryStubs && row.resolved_at == null)) {
      idOf.set(ref, row.id);
      continue;
    }
    const key = mediaRefKeys(ref).join("|");
    let lead = leadByKey.get(key);
    if (!lead) {
      lead = ref;
      leadByKey.set(key, ref);
      pending.push(ref);
    }
    leadOf.set(ref, lead);
  }

  // 2. TMDB, for what the database did not have.
  const apiKey = opts.tmdbKey !== undefined ? opts.tmdbKey : (env.TMDB_API_KEY || "");
  const budget = Number.isFinite(opts.maxLookups) ? Math.max(0, opts.maxLookups) : MEDIA_TMDB_LOOKUP_MAX;
  let asked = 0;
  const facts = await mapMediaWithConcurrency(pending, MEDIA_TMDB_CONCURRENCY, (ref) => {
    if (!apiKey || !(ref.imdbId || ref.tmdbId) || asked >= budget) return null;
    asked++;
    return fetchTmdbMediaFacts(ref, apiKey);
  });
  stats.lookups = asked;

  // What each pending ref will be stored as. A resolved title keeps any id
  // TMDB did not return (an IMDb id TMDB lacks, another scheme's id).
  const now = Date.now();
  const candidates = pending.map((ref, i) => {
    const f = facts[i];
    if (f) {
      return {
        ref, resolved: true, kind: f.kind,
        tmdbId: f.tmdbId, imdbId: f.imdbId || ref.imdbId, tvdbId: f.tvdbId, altId: ref.altId,
        title: f.title || ref.title, year: f.year || ref.year, posterPath: f.posterPath, backdropPath: f.backdropPath,
      };
    }
    return {
      ref, resolved: false, kind: ref.kind,
      tmdbId: ref.tmdbId, imdbId: ref.imdbId, tvdbId: null, altId: ref.altId,
      title: ref.title, year: ref.year, posterPath: null, backdropPath: null,
    };
  });

  // 3. Rows the newly learned ids point at: a title first listed as
  //    "tmdb:1396" and now met as "tt0903747" is the same row. A stub found
  //    this way is upgraded in place; a resolved row only gains missing ids.
  const existing = indexMediaRows(await lookupMediaRows(env, candidates.filter((c) => c.resolved)));
  const writes = [];
  const inserted = [];
  for (const c of candidates) {
    const row = c.resolved ? matchMediaRow(existing, c) : null;
    if (!row) {
      inserted.push(c);
      continue;
    }
    idOf.set(c.ref, row.id);
    if (row.resolved_at == null) {
      // A TMDB id names a title only within its kind, so a stub whose kind
      // TMDB corrects takes TMDB's id, never the one it had: a movie's id
      // kept on a show points show.refresh at some other show.
      writes.push(env.DB.prepare(
        `UPDATE OR IGNORE media SET kind = ?, tmdb_id = CASE WHEN kind = ? THEN COALESCE(tmdb_id, ?) ELSE ? END, imdb_id = COALESCE(imdb_id, ?),
           tvdb_id = COALESCE(tvdb_id, ?), alt_id = COALESCE(alt_id, ?), title = COALESCE(?, title), year = COALESCE(?, year),
           poster_path = COALESCE(?, poster_path), backdrop_path = COALESCE(?, backdrop_path), resolved_at = ?, updated_at = ?
         WHERE id = ?`
      ).bind(c.kind, c.kind, c.tmdbId, c.tmdbId, c.imdbId, c.tvdbId, c.altId, c.title, c.year, c.posterPath, c.backdropPath, now, now, row.id));
      // When that is ignored -- TMDB's id already belongs to another row (two
      // rows for one title, which merging is left to a later task) -- the
      // stub still takes the kind and the facts, without that id. It used to
      // stay a stub, upgraded never: a show filed as a movie that way was a
      // movie for good (Compare shelves, 2026-10-06). Runs only when the
      // statement above changed nothing (resolved_at still NULL).
      writes.push(env.DB.prepare(
        `UPDATE OR IGNORE media SET kind = ?, tmdb_id = CASE WHEN kind = ? THEN tmdb_id ELSE NULL END,
           title = COALESCE(?, title), year = COALESCE(?, year), poster_path = COALESCE(?, poster_path),
           backdrop_path = COALESCE(?, backdrop_path), resolved_at = ?, updated_at = ?
         WHERE id = ? AND resolved_at IS NULL`
      ).bind(c.kind, c.kind, c.title, c.year, c.posterPath, c.backdropPath, now, now, row.id));
    } else if (row.kind === c.kind && ((!row.imdb_id && c.imdbId) || (!row.tmdb_id && c.tmdbId) || (!row.tvdb_id && c.tvdbId))) {
      writes.push(env.DB.prepare(
        `UPDATE OR IGNORE media SET tmdb_id = COALESCE(tmdb_id, ?), imdb_id = COALESCE(imdb_id, ?), tvdb_id = COALESCE(tvdb_id, ?), updated_at = ?
         WHERE id = ?`
      ).bind(c.tmdbId, c.imdbId, c.tvdbId, now, row.id));
    }
  }
  // Resolved titles first, so a stub for the same IMDb id in this batch
  // lands on the resolved row rather than the other way round. ON CONFLICT
  // DO NOTHING covers two inputs naming one title, and a concurrent call
  // inserting it first: either way the read below finds the row that won.
  // Several rows per statement: D1 allows about 1,000 queries per
  // invocation, and a large list brings hundreds of new titles at once.
  inserted.sort((a, b) => Number(b.resolved) - Number(a.resolved));
  const insertRow = (c) => [c.kind, c.tmdbId || null, c.imdbId || null, c.tvdbId || null, c.altId || null, c.title || null, c.year || null,
    c.posterPath || null, c.backdropPath || null, c.resolved ? now : null, now, now];
  if (inserted.length >= MEDIA_BULK_MIN) {
    // Many new titles (a big list's first save): as JSON, a few statements.
    for (const chunk of d1JsonChunks(inserted.map(insertRow))) {
      writes.push(env.DB.prepare(
        `INSERT INTO media (kind, tmdb_id, imdb_id, tvdb_id, alt_id, title, year, poster_path, backdrop_path, resolved_at, created_at, updated_at)
         SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'),
           json_extract(value, '$[4]'), json_extract(value, '$[5]'), json_extract(value, '$[6]'), json_extract(value, '$[7]'),
           json_extract(value, '$[8]'), json_extract(value, '$[9]'), json_extract(value, '$[10]'), json_extract(value, '$[11]')
         FROM json_each(?) WHERE true ON CONFLICT DO NOTHING`
      ).bind(chunk));
    }
  } else {
    for (let i = 0; i < inserted.length; i += MEDIA_INSERT_ROWS) {
      const rows = inserted.slice(i, i + MEDIA_INSERT_ROWS);
      const args = [];
      for (const c of rows) args.push(...insertRow(c));
      writes.push(env.DB.prepare(
        `INSERT INTO media (kind, tmdb_id, imdb_id, tvdb_id, alt_id, title, year, poster_path, backdrop_path, resolved_at, created_at, updated_at)
         VALUES ${rows.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")} ON CONFLICT DO NOTHING`
      ).bind(...args));
    }
  }
  for (let i = 0; i < writes.length; i += MEDIA_WRITE_CHUNK) {
    await env.DB.batch(writes.slice(i, i + MEDIA_WRITE_CHUNK));
  }
  if (inserted.length) {
    const stored = indexMediaRows(await lookupMediaRows(env, inserted));
    for (const c of inserted) {
      const row = matchMediaRow(stored, c);
      if (row) idOf.set(c.ref, row.id);
    }
  }

  // Counted per input, so the backfill can add them up list by list.
  const resolvedLeads = new Set(candidates.filter((c) => c.resolved).map((c) => c.ref));
  const ids = refs.map((ref) => {
    if (!ref) {
      stats.unusable++;
      return null;
    }
    const lead = leadOf.get(ref);
    if (!lead) stats.found++;
    else if (resolvedLeads.has(lead)) stats.resolved++;
    else stats.stubs++;
    const id = idOf.get(lead || ref);
    return id == null ? null : id;
  });
  return { ids, stats };
}

async function resolveMedia(env, input, opts = {}) {
  const { ids } = await resolveMediaBatch(env, [input], opts);
  return ids[0];
}

// Tries the oldest stubs again. Those TMDB still cannot place move to the
// back of the queue (updated_at), so one title TMDB will never know cannot
// hold up the rest. A stub whose TMDB id turns out to belong to another row
// takes TMDB's kind and facts without that id (resolveMediaBatch): merging
// the two rows (and the list entries on them) is left to a later task.
//
// `retryAfterMs`: a stub already tried again (updated_at moved past
// created_at) waits this long before the next try, so titles TMDB will never
// know are not asked about on every run. One never tried again is due at
// once. 0 (the default) asks about any stub.
async function retryUnresolvedMedia(env, opts = {}) {
  if (!env || !env.DB) throw new Error("retryUnresolvedMedia: no D1 database is bound");
  const limit = Math.max(1, Math.min(Number(opts.limit) || MEDIA_LOOKUP_CHUNK, MEDIA_TMDB_LOOKUP_MAX));
  const retryAfterMs = Number(opts.retryAfterMs) > 0 ? Number(opts.retryAfterMs) : 0;
  const { results } = await env.DB.prepare(
    `SELECT ${MEDIA_ROW_COLUMNS} FROM media WHERE resolved_at IS NULL AND (updated_at = created_at OR updated_at <= ?) ORDER BY updated_at LIMIT ?`
  ).bind(Date.now() - retryAfterMs, limit).all();
  const rows = results || [];
  if (!rows.length) return { tried: 0, resolved: 0 };
  const refs = rows.map((r) => ({ kind: r.kind, imdbId: r.imdb_id, tmdbId: r.tmdb_id, id: r.alt_id, title: r.title, year: r.year }));
  await resolveMediaBatch(env, refs, { retryStubs: true, tmdbKey: opts.tmdbKey, maxLookups: limit });
  // Those still unknown go to the back of the queue. The count is taken from
  // the rows themselves: TMDB answering is not enough when the upgrade was
  // skipped because the TMDB id already belongs to another row.
  const now = Date.now();
  const ids = rows.map((r) => r.id);
  let resolved = 0;
  for (let i = 0; i < ids.length; i += MEDIA_LOOKUP_CHUNK) {
    const chunk = ids.slice(i, i + MEDIA_LOOKUP_CHUNK);
    const marks = new Array(chunk.length).fill("?").join(", ");
    await env.DB.prepare(`UPDATE media SET updated_at = ? WHERE resolved_at IS NULL AND id IN (${marks})`).bind(now, ...chunk).run();
    const row = await env.DB.prepare(`SELECT count(*) AS n FROM media WHERE resolved_at IS NOT NULL AND id IN (${marks})`).bind(...chunk).first();
    resolved += Number(row && row.n) || 0;
  }
  // A stub by TMDB id that TMDB answered for and still could not take its
  // IMDb id: another row holds it, the two are one title (the recommendations
  // job keeps making such stubs, 53_). Merged the way the admin's Merge
  // duplicate titles does. Never fails the retry.
  let merged = 0;
  const blocked = rows.filter((r) => r.tmdb_id != null && !r.imdb_id).map((r) => r.id);
  if (blocked.length && (opts.tmdbKey || env.TMDB_API_KEY)) {
    try {
      for (let i = 0; i < blocked.length; i += 100) {
        const m = await mergeDuplicateMedia(env, { ids: blocked.slice(i, i + 100), apply: true, tmdbKey: opts.tmdbKey });
        merged += Number(m && m.merged) || 0;
      }
    } catch (e) {
      console.warn("[media.retry] merging duplicate titles failed:", String((e && e.message) || e));
    }
  }
  const named = rows.filter((r) => r.imdb_id == null && r.tmdb_id == null && r.alt_id).map((r) => r.id);
  if (named.length) {
    try {
      for (let i = 0; i < named.length; i += MEDIA_NAME_MERGE_BATCH) {
        const m = await mergeNameOnlyMedia(env, { ids: named.slice(i, i + MEDIA_NAME_MERGE_BATCH), apply: true });
        merged += Number(m && m.merged) || 0;
      }
    } catch (e) {
      console.warn("[media.retry] merging titles stored under their name failed:", String((e && e.message) || e));
    }
  }
  return { tried: rows.length, resolved, merged };
}

// --- Episode names and stills (migration 0020) ---------------------------------
//
// The activity database records a play as a title, a season and an episode --
// nothing names the episode itself. The legacy Watch History kept the name and
// the still on every entry, so Watch History served from the activity database
// (FF_EVENT_TRACKING) showed every episode as "Episode 3" with the show poster.
// An episode is called the same thing for everyone, so its name and still are
// kept once, in media_episodes beside media: written by the plays (38_), a save
// from the website (40_) and the history copy (37_, which reads the legacy
// entries that still have them), and read by Watch History (39_).
//
// Nothing here may break what calls it: a database without 0020 reads as no
// names, and a write that fails is logged and dropped.

const EPISODE_TITLE_MAX_CHARS = 300;
const EPISODE_IMAGE_MAX_CHARS = 1000;
let _episodeTitlesWarned = false;

function episodeTitlesWarn(e) {
  if (/no such table/i.test(String((e && e.message) || e)) || _episodeTitlesWarned) return;
  _episodeTitlesWarned = true;
  console.error("media_episodes:", e);
}

// { title, image } a legacy Watch History entry gives its episode, or null.
// Only an entry that knows its show: the web page saves an episode it had no
// show loaded for under the show's name (see legacyHistoryPlay), which is not
// the episode's. "Episode 3" is the placeholder, not a name, and a poster that
// is the show's (or a generated one) is not the episode's still.
function episodeTitleFromLegacy(item) {
  if (!item || typeof item !== "object") return null;
  if (!item.showId && !item.showTitle) return null;
  const raw = typeof item.name === "string" && item.name.trim() ? item.name : item.title;
  let title = typeof raw === "string" ? raw.trim().slice(0, EPISODE_TITLE_MAX_CHARS) : "";
  const showTitle = typeof item.showTitle === "string" ? item.showTitle.trim() : "";
  if (/^episode\s+\d+$/i.test(title) || (showTitle && title === showTitle)) title = "";
  const poster = typeof item.poster === "string" ? item.poster.trim() : "";
  const showPoster = typeof item.showPoster === "string" ? item.showPoster.trim() : "";
  const image = /^https:\/\//i.test(poster) && poster.length <= EPISODE_IMAGE_MAX_CHARS && poster !== showPoster &&
    !/metahub\.space\/poster|\/bp\/|\/api\/(?:safe-poster|poster-badge)/i.test(poster) ? poster : "";
  return title || image ? { title, image } : null;
}

// Stores names for episodes ({ mediaId, season, episode, title, image }). A
// name already stored is replaced only by a different one, and a blank never
// replaces one, so re-sending what is there writes nothing. Returns rows written.
async function saveEpisodeTitles(env, rows) {
  if (!env || !env.DB || !Array.isArray(rows) || !rows.length) return 0;
  const byKey = new Map();
  for (const r of rows) {
    if (!r || r.mediaId == null || r.season == null || r.episode == null) continue;
    const title = r.title ? String(r.title).slice(0, EPISODE_TITLE_MAX_CHARS) : null;
    const image = r.image ? String(r.image).slice(0, EPISODE_IMAGE_MAX_CHARS) : null;
    if (!title && !image) continue;
    const key = `${r.mediaId}:${r.season}:${r.episode}`;
    const prev = byKey.get(key);
    byKey.set(key, [Number(r.mediaId), Number(r.season), Number(r.episode), title || (prev && prev[3]) || null, image || (prev && prev[4]) || null]);
  }
  if (!byKey.size) return 0;
  let written = 0;
  try {
    for (const part of d1JsonChunks([...byKey.values()])) {
      const out = await env.DB.prepare(
        `INSERT INTO media_episodes (media_id, season, episode, title, image, updated_at)
         SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'),
                json_extract(value, '$[3]'), json_extract(value, '$[4]'), ?
         FROM json_each(?) WHERE true
         ON CONFLICT (media_id, season, episode) DO UPDATE SET
           title = COALESCE(excluded.title, media_episodes.title),
           image = COALESCE(excluded.image, media_episodes.image),
           updated_at = excluded.updated_at
         WHERE (excluded.title IS NOT NULL AND excluded.title IS NOT media_episodes.title)
            OR (excluded.image IS NOT NULL AND excluded.image IS NOT media_episodes.image)`
      ).bind(Date.now(), part).run();
      written += Number(out && out.meta && out.meta.changes) || 0;
    }
  } catch (e) {
    episodeTitlesWarn(e);
  }
  return written;
}

// Map "mediaId:season:episode" -> { title, image } for the episodes asked for
// ({ mediaId, season, episode }); an episode with no stored name is absent.
async function episodeTitlesFor(env, keys) {
  const out = new Map();
  if (!env || !env.DB || !Array.isArray(keys) || !keys.length) return out;
  const want = new Map();
  for (const k of keys) {
    if (!k || k.mediaId == null || k.season == null || k.episode == null) continue;
    want.set(`${k.mediaId}:${k.season}:${k.episode}`, [Number(k.mediaId), Number(k.season), Number(k.episode)]);
  }
  if (!want.size) return out;
  try {
    for (const part of d1JsonChunks([...want.values()])) {
      const { results } = await env.DB.prepare(
        `SELECT e.media_id, e.season, e.episode, e.title, e.image FROM json_each(?) j
         JOIN media_episodes e ON e.media_id = json_extract(j.value, '$[0]')
          AND e.season = json_extract(j.value, '$[1]') AND e.episode = json_extract(j.value, '$[2]')`
      ).bind(part).all();
      for (const r of results || []) out.set(`${r.media_id}:${r.season}:${r.episode}`, { title: r.title || "", image: r.image || "" });
    }
  } catch (e) {
    episodeTitlesWarn(e);
  }
  return out;
}

// --- Two rows for one title: the read-only count ---------------------------------
//
// A title should have one media row, but two can appear when it arrives by two
// routes before anything links them: a list import by its IMDb id makes one,
// a search by its TMDB id another, and the lookup that would have filled the
// missing id failed or is still to come. The unique indexes then keep the two
// apart for good (resolveMediaBatch above, refileSeriesFiledAsMovies, 46_).
// Plays, list entries and progress can be split between them.
//
// This only reads. It groups rows of one kind by name and year, and calls a
// group likely duplicates when two of its rows have no id that disagrees (not
// both an IMDb id, not both a TMDB id): two different films that share a name
// and a year each carry their own ids, so they are left out. For each likely
// group it counts what points at each row, which is what a merge would move.
// Rows without a year are not compared.
const MEDIA_DUP_GROUP_LIMIT = 5000;
const MEDIA_DUP_EXAMPLES = 15;

function mediaRowsCanBeOne(a, b) {
  if (a.imdb_id && b.imdb_id) return false;
  if (a.tmdb_id != null && b.tmdb_id != null) return false;
  if (a.alt_id && b.alt_id) return false;
  return true;
}

async function mediaRefCounts(db, table, ids) {
  const out = new Map();
  if (!db || !ids.length) return out;
  for (const part of d1JsonChunks(ids)) {
    const { results } = await db.prepare(
      `SELECT media_id, count(*) AS n FROM ${table} WHERE media_id IN (SELECT value FROM json_each(?)) GROUP BY media_id`
    ).bind(part).all();
    for (const r of results || []) out.set(Number(r.media_id), (out.get(Number(r.media_id)) || 0) + (Number(r.n) || 0));
  }
  return out;
}

async function findDuplicateMedia(env) {
  if (!env || !env.DB) throw new Error("findDuplicateMedia: no D1 database is bound");
  const totals = await env.DB.prepare(
    `SELECT count(*) AS rows,
            sum(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END) AS stubs,
            sum(CASE WHEN resolved_at IS NOT NULL AND imdb_id IS NOT NULL AND tmdb_id IS NULL THEN 1 ELSE 0 END) AS imdbOnly,
            sum(CASE WHEN resolved_at IS NOT NULL AND imdb_id IS NULL AND tmdb_id IS NOT NULL THEN 1 ELSE 0 END) AS tmdbOnly
     FROM media`
  ).first();
  const { results: groupRows } = await env.DB.prepare(
    `SELECT group_concat(id) AS ids FROM media
     WHERE title IS NOT NULL AND trim(title) != '' AND year IS NOT NULL
     GROUP BY kind, lower(trim(title)), year HAVING count(*) > 1
     ORDER BY count(*) DESC LIMIT ?`
  ).bind(MEDIA_DUP_GROUP_LIMIT).all();
  const groupIds = (groupRows || []).map((g) => String(g.ids || "").split(",").map(Number).filter(Number.isFinite));
  const allIds = groupIds.flat();
  const rowById = new Map();
  for (const part of d1JsonChunks(allIds)) {
    const { results } = await env.DB.prepare(
      `SELECT ${MEDIA_ROW_COLUMNS} FROM media WHERE id IN (SELECT value FROM json_each(?))`
    ).bind(part).all();
    for (const r of results || []) rowById.set(Number(r.id), r);
  }

  const likely = [];
  let sameNameDifferent = 0;
  for (const ids of groupIds) {
    const rows = ids.map((id) => rowById.get(id)).filter(Boolean);
    let pair = false;
    for (let i = 0; i < rows.length && !pair; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        if (mediaRowsCanBeOne(rows[i], rows[j])) { pair = true; break; }
      }
    }
    if (pair) likely.push(rows);
    else sameNameDifferent++;
  }

  const likelyIds = likely.flat().map((r) => Number(r.id));
  const listItems = await mediaRefCounts(env.DB, "list_items", likelyIds);
  const plays = new Map();
  const progress = new Map();
  for (const db of activityDbs(env)) {
    for (const [table, into] of [["watch_events", plays], ["show_progress", progress]]) {
      const got = await mediaRefCounts(db, table, likelyIds);
      for (const [id, n] of got) into.set(id, (into.get(id) || 0) + n);
    }
  }

  const describe = (r) => ({
    id: Number(r.id), imdbId: r.imdb_id || null, tmdbId: r.tmdb_id != null ? Number(r.tmdb_id) : null,
    altId: r.alt_id || null, tvdbId: r.tvdb_id != null ? Number(r.tvdb_id) : null,
    resolved: r.resolved_at != null, listItems: listItems.get(Number(r.id)) || 0,
    plays: plays.get(Number(r.id)) || 0, progress: progress.get(Number(r.id)) || 0,
  });
  let rowsInvolved = 0;
  let withData = 0;
  for (const rows of likely) {
    rowsInvolved += rows.length;
    const used = rows.filter((r) => { const d = describe(r); return d.listItems || d.plays || d.progress; }).length;
    if (used >= 2) withData++;
  }
  const examples = likely.slice(0, MEDIA_DUP_EXAMPLES).map((rows) => ({
    kind: rows[0].kind, title: rows[0].title, year: rows[0].year, rows: rows.map(describe),
  }));
  return {
    ok: true,
    mediaRows: Number(totals && totals.rows) || 0,
    stubs: Number(totals && totals.stubs) || 0,
    imdbOnly: Number(totals && totals.imdbOnly) || 0,
    tmdbOnly: Number(totals && totals.tmdbOnly) || 0,
    likelyGroups: likely.length,
    likelyRows: rowsInvolved,
    splitGroups: withData,
    sameNameDifferent,
    capped: (groupRows || []).length >= MEDIA_DUP_GROUP_LIMIT,
    examples,
  };
}

// --- Two rows for one title: the merge -------------------------------------------
//
// The count above showed the shape (2026-10-11): nearly every pair is a row a
// list or a play made by IMDb id (it holds the list entries and plays) and an
// empty stub made by TMDB id alone. The stubs come from the recommendations
// job (recordRecommendedMedia, 53_): TMDB's recommendations carry no IMDb id,
// so it cannot see the title is already stored. The stub then holds the TMDB
// id the IMDb row needs, the IMDb row holds the IMDb id the stub needs, and
// neither can ever be completed. Same name and year is not enough to merge on
// (two films called Alone came out in 2020), so this asks TMDB.
//
// One batch per call, oldest first: for each row with a TMDB id and no IMDb id
// (a stub, or one the retry marked looked up when its IMDb id was taken), TMDB
// says its IMDb id; when another row of the same kind holds that
// IMDb id and no TMDB id, the two are one title. With `apply`, everything that
// points at the stub moves to that row, the stub is deleted, and the row takes
// the TMDB id and anything else it lacked. Without it, nothing is written.
// Plays move before the stub is deleted, so a batch that fails half way leaves
// every play on a row that exists.
const MEDIA_MERGE_BATCH = 24;
const MEDIA_MERGE_EXAMPLES = 15;

function mediaMergeMainStatements(env, keep, spare, f, now) {
  const db = env.DB;
  const out = [
    // A list that has both copies keeps one entry.
    db.prepare(
      `UPDATE lists SET item_count = max(0, item_count - (SELECT count(*) FROM list_items a JOIN list_items b
         ON b.list_id = a.list_id AND ifnull(b.season, -1) = ifnull(a.season, -1) AND ifnull(b.episode, -1) = ifnull(a.episode, -1)
         WHERE a.list_id = lists.id AND a.media_id = ? AND b.media_id = ?)), updated_at = ?
       WHERE id IN (SELECT list_id FROM list_items WHERE media_id = ?)`
    ).bind(spare, keep, now, spare),
    db.prepare("UPDATE OR IGNORE list_items SET media_id = ? WHERE media_id = ?").bind(keep, spare),
    db.prepare("DELETE FROM list_items WHERE media_id = ?").bind(spare),
    db.prepare("UPDATE account_recommendations SET media_id = ? WHERE media_id = ?").bind(keep, spare),
    db.prepare(
      `INSERT INTO title_daily_stats (day, event_type, media_id, n)
       SELECT day, event_type, ?, n FROM title_daily_stats WHERE media_id = ? AND true
       ON CONFLICT (day, event_type, media_id) DO UPDATE SET n = title_daily_stats.n + excluded.n`
    ).bind(keep, spare),
    db.prepare("DELETE FROM title_daily_stats WHERE media_id = ?").bind(spare),
    db.prepare("UPDATE OR IGNORE show_schedule SET media_id = ? WHERE media_id = ?").bind(keep, spare),
    db.prepare("DELETE FROM show_schedule WHERE media_id = ?").bind(spare),
    db.prepare("UPDATE OR IGNORE media_episodes SET media_id = ? WHERE media_id = ?").bind(keep, spare),
    db.prepare("DELETE FROM media_episodes WHERE media_id = ?").bind(spare),
    db.prepare("DELETE FROM media WHERE id = ? AND imdb_id IS NULL").bind(spare),
  ];
  // What TMDB said, for the kept row; none when the pair was found another way
  // (mergeNameOnlyMedia). D1 refuses an undefined bind, so this statement is
  // only made with facts.
  if (!f) return out;
  out.push(db.prepare(
      `UPDATE media SET tmdb_id = ?, tvdb_id = COALESCE(tvdb_id, ?), title = COALESCE(title, ?), year = COALESCE(year, ?),
         poster_path = COALESCE(poster_path, ?), backdrop_path = COALESCE(backdrop_path, ?),
         resolved_at = COALESCE(resolved_at, ?), updated_at = ?
       WHERE id = ? AND tmdb_id IS NULL`
    ).bind(f.tmdbId, f.tvdbId ?? null, f.title ?? null, f.year ?? null, f.posterPath ?? null, f.backdropPath ?? null, now, now, keep));
  return out;
}

function mediaMergeActivityStatements(db, keep, spare) {
  return [
    db.prepare("UPDATE watch_events SET media_id = ? WHERE media_id = ?").bind(keep, spare),
    db.prepare(
      `INSERT INTO user_media_state (account_id, media_id, watched_count, last_watched_at)
       SELECT account_id, ?, watched_count, last_watched_at FROM user_media_state WHERE media_id = ? AND true
       ON CONFLICT (account_id, media_id) DO UPDATE SET watched_count = user_media_state.watched_count + excluded.watched_count,
         last_watched_at = max(COALESCE(user_media_state.last_watched_at, 0), COALESCE(excluded.last_watched_at, 0))`
    ).bind(keep, spare),
    db.prepare("DELETE FROM user_media_state WHERE media_id = ?").bind(spare),
    // An account with progress on both keeps the more recent.
    db.prepare(
      `DELETE FROM show_progress WHERE media_id = ? AND EXISTS (
         SELECT 1 FROM show_progress s WHERE s.account_id = show_progress.account_id AND s.media_id = ?
           AND COALESCE(s.last_watched_at, 0) > COALESCE(show_progress.last_watched_at, 0))`
    ).bind(keep, spare),
    db.prepare("UPDATE OR IGNORE show_progress SET media_id = ? WHERE media_id = ?").bind(keep, spare),
    db.prepare("DELETE FROM show_progress WHERE media_id = ?").bind(spare),
  ];
}

async function mergeDuplicateMedia(env, opts = {}) {
  if (!env || !env.DB) throw new Error("mergeDuplicateMedia: no D1 database is bound");
  const apply = opts.apply === true;
  const apiKey = opts.tmdbKey !== undefined ? opts.tmdbKey : (env.TMDB_API_KEY || "");
  if (!apiKey) return { ok: false, error: "No TMDB key is set (TMDB_API_KEY)." };
  const afterId = Math.max(0, Number(opts.afterId) || 0);
  const limit = Math.max(1, Math.min(Number(opts.limit) || MEDIA_MERGE_BATCH, 100));
  // `ids`: only these stubs (the hourly retry's own, below), not a scan.
  const only = Array.isArray(opts.ids) ? opts.ids.map(Number).filter(Number.isFinite) : null;
  const { results } = only
    ? await env.DB.prepare(
      `SELECT ${MEDIA_ROW_COLUMNS} FROM media WHERE id IN (SELECT value FROM json_each(?)) AND imdb_id IS NULL AND tmdb_id IS NOT NULL ORDER BY id`
    ).bind(JSON.stringify(only.slice(0, 100))).all()
    : await env.DB.prepare(
      `SELECT ${MEDIA_ROW_COLUMNS} FROM media WHERE id > ? AND imdb_id IS NULL AND tmdb_id IS NOT NULL
       ORDER BY id LIMIT ?`
    ).bind(afterId, limit).all();
  const stubs = results || [];
  const total = afterId || only ? null : Number((await env.DB.prepare(
    "SELECT count(*) AS n FROM media WHERE imdb_id IS NULL AND tmdb_id IS NOT NULL"
  ).first() || {}).n) || 0;
  const facts = await mapMediaWithConcurrency(stubs, MEDIA_TMDB_CONCURRENCY,
    (s) => fetchTmdbMediaFacts({ kind: s.kind, tmdbId: s.tmdb_id, imdbId: null }, apiKey));
  const imdbs = [...new Set(facts.map((f) => (f && f.imdbId) || null).filter(Boolean))];
  const holders = new Map();
  for (const part of d1JsonChunks(imdbs)) {
    const { results: rows } = await env.DB.prepare(
      `SELECT ${MEDIA_ROW_COLUMNS} FROM media WHERE imdb_id IN (SELECT value FROM json_each(?))`
    ).bind(part).all();
    for (const r of rows || []) holders.set(r.imdb_id, r);
  }
  const out = { ok: true, apply, scanned: stubs.length, total, pairs: 0, merged: 0, noAnswer: 0, noImdb: 0, notStored: 0, otherKind: 0, otherTmdb: 0, examples: [] };
  const now = Date.now();
  for (let i = 0; i < stubs.length; i++) {
    const s = stubs[i];
    const f = facts[i];
    if (!f) { out.noAnswer++; continue; }
    if (!f.imdbId) { out.noImdb++; continue; }
    const keep = holders.get(f.imdbId);
    if (!keep || Number(keep.id) === Number(s.id)) { out.notStored++; continue; }
    if (keep.kind !== s.kind) { out.otherKind++; continue; }
    if (keep.tmdb_id != null) { out.otherTmdb++; continue; }
    out.pairs++;
    if (out.examples.length < MEDIA_MERGE_EXAMPLES) {
      out.examples.push({ title: keep.title || f.title, year: keep.year || f.year, kind: s.kind, keep: Number(keep.id), spare: Number(s.id), imdbId: f.imdbId, tmdbId: Number(s.tmdb_id) });
    }
    if (!apply) continue;
    for (const db of activityDbs(env)) await db.batch(mediaMergeActivityStatements(db, Number(keep.id), Number(s.id)));
    await env.DB.batch(mediaMergeMainStatements(env, Number(keep.id), Number(s.id), { ...f, tmdbId: Number(s.tmdb_id) }, now));
    keep.tmdb_id = Number(s.tmdb_id);
    out.merged++;
  }
  out.afterId = stubs.length ? Number(stubs[stubs.length - 1].id) : afterId;
  out.done = stubs.length < limit;
  return out;
}

// --- A title stored under its own name -------------------------------------------
//
// An entry that reaches normalizeMediaRef with no real id (a list item or a
// play that only says "Dexter") is kept with its name as its id: alt_id
// "Dexter", no IMDb or TMDB id, never looked up, and apart from the real
// Dexter. The count of 2026-10-11 found 50 such, most with list entries or
// plays. TMDB cannot confirm these (there is no id to ask about), so a pair
// is a row of the same kind with that name and year that has an IMDb id, and
// only when exactly one row is such: two films called Alone (2020) leave the
// copy alone. The kept row takes the name as its alt_id, so the next entry
// that only says "Dexter" finds it instead of making another copy.
// Another scheme's id (kitsu:1234) is left alone: it is not the row's name.
const MEDIA_NAME_MERGE_BATCH = 100;

async function mergeNameOnlyMedia(env, opts = {}) {
  if (!env || !env.DB) throw new Error("mergeNameOnlyMedia: no D1 database is bound");
  const apply = opts.apply === true;
  const afterId = Math.max(0, Number(opts.afterId) || 0);
  const only = Array.isArray(opts.ids) ? opts.ids.map(Number).filter(Number.isFinite).slice(0, MEDIA_NAME_MERGE_BATCH) : null;
  // Its other id is its own name: that alone tells it from another scheme's id
  // (kitsu:1234 is never a title), so a name with a colon in it counts too
  // ("Devil in the Family: The Fall of Ruby Franke" was left out when this
  // also asked for no colon).
  const where = `m.imdb_id IS NULL AND m.tmdb_id IS NULL AND m.alt_id IS NOT NULL
    AND m.title IS NOT NULL AND m.year IS NOT NULL AND lower(trim(m.alt_id)) = lower(trim(m.title))`;
  const { results } = only
    ? await env.DB.prepare(`SELECT m.id, m.kind, m.title, m.year, m.alt_id FROM media m WHERE m.id IN (SELECT value FROM json_each(?)) AND ${where} ORDER BY m.id`)
      .bind(JSON.stringify(only)).all()
    : await env.DB.prepare(`SELECT m.id, m.kind, m.title, m.year, m.alt_id FROM media m WHERE m.id > ? AND ${where} ORDER BY m.id LIMIT ?`)
      .bind(afterId, MEDIA_NAME_MERGE_BATCH).all();
  const rows = results || [];
  const out = { ok: true, apply, scanned: rows.length, pairs: 0, merged: 0, noMatch: 0, ambiguous: 0, examples: [] };
  const now = Date.now();
  for (const s of rows) {
    const { results: cands } = await env.DB.prepare(
      `SELECT id, imdb_id, alt_id FROM media WHERE kind = ? AND year = ? AND lower(trim(title)) = lower(trim(?)) AND imdb_id IS NOT NULL AND id != ? LIMIT 2`
    ).bind(s.kind, s.year, s.title, s.id).all();
    const list = cands || [];
    if (!list.length) { out.noMatch++; continue; }
    if (list.length > 1) { out.ambiguous++; continue; }
    const keep = list[0];
    out.pairs++;
    if (out.examples.length < MEDIA_MERGE_EXAMPLES) {
      out.examples.push({ title: s.title, year: s.year, kind: s.kind, keep: Number(keep.id), spare: Number(s.id), imdbId: keep.imdb_id });
    }
    if (!apply) continue;
    for (const db of activityDbs(env)) await db.batch(mediaMergeActivityStatements(db, Number(keep.id), Number(s.id)));
    const main = mediaMergeMainStatements(env, Number(keep.id), Number(s.id), null, now);
    main.push(env.DB.prepare("UPDATE media SET alt_id = COALESCE(alt_id, ?), updated_at = ? WHERE id = ?").bind(s.alt_id, now, Number(keep.id)));
    await env.DB.batch(main);
    out.merged++;
  }
  out.afterId = rows.length ? Number(rows[rows.length - 1].id) : afterId;
  out.done = only ? true : rows.length < MEDIA_NAME_MERGE_BATCH;
  return out;
}
