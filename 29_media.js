
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
  const chunked = (values, fn) => {
    const all = [...values];
    for (let i = 0; i < all.length; i += MEDIA_LOOKUP_CHUNK) fn(all.slice(i, i + MEDIA_LOOKUP_CHUNK));
  };
  const marks = (n) => new Array(n).fill("?").join(", ");
  chunked(imdb, (ids) => queries.push(env.DB.prepare(
    `SELECT ${MEDIA_ROW_COLUMNS} FROM media WHERE imdb_id IN (${marks(ids.length)})`).bind(...ids)));
  for (const kind of ["movie", "series"]) {
    chunked(tmdbByKind[kind], (ids) => queries.push(env.DB.prepare(
      `SELECT ${MEDIA_ROW_COLUMNS} FROM media WHERE kind = ? AND tmdb_id IN (${marks(ids.length)})`).bind(kind, ...ids)));
    chunked(altByKind[kind], (ids) => queries.push(env.DB.prepare(
      `SELECT ${MEDIA_ROW_COLUMNS} FROM media WHERE kind = ? AND alt_id IN (${marks(ids.length)})`).bind(kind, ...ids)));
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
      writes.push(env.DB.prepare(
        `UPDATE OR IGNORE media SET kind = ?, tmdb_id = COALESCE(tmdb_id, ?), imdb_id = COALESCE(imdb_id, ?),
           tvdb_id = COALESCE(tvdb_id, ?), alt_id = COALESCE(alt_id, ?), title = COALESCE(?, title), year = COALESCE(?, year),
           poster_path = COALESCE(?, poster_path), backdrop_path = COALESCE(?, backdrop_path), resolved_at = ?, updated_at = ?
         WHERE id = ?`
      ).bind(c.kind, c.tmdbId, c.imdbId, c.tvdbId, c.altId, c.title, c.year, c.posterPath, c.backdropPath, now, now, row.id));
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
  for (let i = 0; i < inserted.length; i += MEDIA_INSERT_ROWS) {
    const rows = inserted.slice(i, i + MEDIA_INSERT_ROWS);
    const args = [];
    for (const c of rows) {
      args.push(c.kind, c.tmdbId || null, c.imdbId || null, c.tvdbId || null, c.altId || null, c.title || null, c.year || null,
        c.posterPath, c.backdropPath, c.resolved ? now : null, now, now);
    }
    writes.push(env.DB.prepare(
      `INSERT INTO media (kind, tmdb_id, imdb_id, tvdb_id, alt_id, title, year, poster_path, backdrop_path, resolved_at, created_at, updated_at)
       VALUES ${rows.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")} ON CONFLICT DO NOTHING`
    ).bind(...args));
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
// stays a stub: merging two rows (and the list entries on them) is left to a
// later task.
async function retryUnresolvedMedia(env, opts = {}) {
  if (!env || !env.DB) throw new Error("retryUnresolvedMedia: no D1 database is bound");
  const limit = Math.max(1, Math.min(Number(opts.limit) || MEDIA_LOOKUP_CHUNK, MEDIA_TMDB_LOOKUP_MAX));
  const { results } = await env.DB.prepare(
    `SELECT ${MEDIA_ROW_COLUMNS} FROM media WHERE resolved_at IS NULL ORDER BY updated_at LIMIT ?`
  ).bind(limit).all();
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
  return { tried: rows.length, resolved };
}
