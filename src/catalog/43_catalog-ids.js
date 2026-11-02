
// --- Canonical catalog ids (Phase 4, P4-2) --------------------------------------
//
// A Stremio, Nuvio or wako app asks its add-ons for a title's details and
// streams by the id a catalog row gives it, so an id nobody understands is a
// tile that opens to "not found" and plays nothing. The rows used to pass on
// whatever id their source had: a list item's own id (for an episode in a
// storyline list, that is TMDB's id for the EPISODE, not a title at all), an
// episode suffix ("tt0944947:1:2"), "tmdb:tv:1399", a bare TMDB number, another
// scheme's id.
//
// With FF_CANONICAL_IDS on, every row a Stremio catalog serves goes through
// canonicalizeCatalogMetas, at the end of fetchCatalog (the catalog route asks
// for it with keys.canonicalIds) and in the search catalog:
//
//   tt...      the IMDb id, with any episode suffix dropped.
//   tmdb:N     a TMDB id ("tmdb:tv:N", "tmdb:N:S:E", and a bare number on an
//              item that is not an episode all become this), upgraded to the
//              IMDb id when the item carries one or the media table knows it.
//   channel_   this site's channels, as they are.
//   episodes   an item with a season or episode number whose own id is not a
//              title's becomes its SHOW (showId).
//   others     another scheme's id ("kitsu:1") is looked up in the media table
//              (alt_id). Found, it becomes that title's id. Not found, it is kept
//              for the schemes other Stremio add-ons serve
//              (CATALOG_ALT_ID_SCHEMES, the anime ones), and otherwise the item
//              is left out: a tile that cannot open is worse than no tile.
//
// Then the page is de-duplicated by id (the first stays), and its total
// adjusted by what was removed, as dedupeAcrossListEntries does.
//
// The media table (29_media.js) is only READ here: at most one query per 90
// ids, and only for rows whose own ids have no IMDb id. Nothing is asked of
// TMDB and nothing is written on the catalog path; titles reach `media` through
// the list writes and the backfills. Without the table (migration 0016 not
// applied) the rules still apply, without the upgrades.
//
// Not changed: the website's previews (/api/preview), which show a storyline
// list's episodes one by one under their own ids.
//
// Behind FF_CANONICAL_IDS (off). Module level, after the Worker's exports.

const CATALOG_ALT_ID_SCHEMES = ["kitsu", "mal", "anilist", "anidb"];
// A missing media table is remembered for this long per database, so a
// deployment without migration 0016 does not fail a query on every request.
const CATALOG_IDS_TABLE_RETRY_MS = 10 * 60 * 1000;
let catalogIdsNoTable = null; // { db, until }

function isCanonicalIdsEnabled(env) {
  const v = env && env.FF_CANONICAL_IDS;
  return v === "1" || v === "true" || v === true;
}

// What one id string names: { imdb }, { tmdb, kind }, { number }, { alt,
// scheme }, or null.
function parseCatalogId(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s || s.length > 200) return null;
  let m = /^(tt\d+)(?::|$)/i.exec(s);
  if (m) return { imdb: m[1].toLowerCase() };
  m = /^tmdb:(?:(movie|tv|series|show):)?(\d+)(?::\d+:\d+)?$/i.exec(s);
  if (m) return { tmdb: Number(m[2]), kind: m[1] ? (m[1].toLowerCase() === "movie" ? "movie" : "series") : null };
  if (/^\d+$/.test(s)) return { number: Number(s) };
  m = /^([a-z][a-z0-9_-]*):(\S+)$/i.exec(s);
  if (m) return { alt: m[1].toLowerCase() + ":" + m[2], scheme: m[1].toLowerCase() };
  return null;
}

function catalogMetaKind(meta, kindHint) {
  const t = String((meta && meta.type) || "").toLowerCase();
  if (t === "series" || t === "tv" || t === "show") return "series";
  if (t === "movie") return "movie";
  const h = String(kindHint || "").toLowerCase();
  return h === "series" ? "series" : (h === "movie" ? "movie" : null);
}

function catalogMetaIsEpisode(meta) {
  return String(meta.type || "").toLowerCase() === "episode" || meta.seasonNum != null || meta.episodeNum != null;
}

// Which title a row names, before any lookup: { imdb } | { tmdb, kind } |
// { alt, scheme, kind } | { keep: id } (a channel) | null (nothing usable).
function planCatalogId(meta, kindHint) {
  if (!meta || typeof meta !== "object") return null;
  const id = String(meta.id == null ? "" : meta.id).trim();
  if (id.startsWith("channel_")) return { keep: id };
  const kind = catalogMetaKind(meta, kindHint);
  const own = parseCatalogId(id);
  const episode = catalogMetaIsEpisode(meta);
  if (own && own.imdb) return { imdb: own.imdb };
  const imdb = parseCatalogId(meta.imdbId);
  if (imdb && imdb.imdb) return { imdb: imdb.imdb };
  // An episode's own number is TMDB's id for the episode, not a title's.
  if (episode || !own) {
    const show = parseCatalogId(meta.showId);
    if (show && show.imdb) return { imdb: show.imdb };
    if (show && show.tmdb) return { tmdb: show.tmdb, kind: "series" };
  }
  if (own && own.tmdb) return { tmdb: own.tmdb, kind: own.kind || kind };
  const tmdb = parseCatalogId(typeof meta.tmdbId === "number" ? String(meta.tmdbId) : meta.tmdbId);
  if (tmdb && (tmdb.tmdb || tmdb.number)) return { tmdb: tmdb.tmdb || tmdb.number, kind };
  if (own && own.number && !episode) return { tmdb: own.number, kind };
  if (own && own.alt) return { alt: own.alt, scheme: own.scheme, kind };
  return null;
}

// Media rows for the plans that could use one, or null when there is no table
// to ask. Read-only.
async function catalogIdMediaRows(env, plans) {
  const db = env && env.DB;
  if (!db || typeof lookupMediaRows !== "function") return null;
  if (catalogIdsNoTable && catalogIdsNoTable.db === db && Date.now() < catalogIdsNoTable.until) return null;
  const refs = [];
  for (const p of plans) {
    if (!p || !p.kind) continue;
    if (p.tmdb) refs.push({ kind: p.kind, tmdbId: p.tmdb });
    else if (p.alt) refs.push({ kind: p.kind, altId: p.alt });
  }
  if (!refs.length) return null;
  try {
    return indexMediaRows(await lookupMediaRows(env, refs));
  } catch (err) {
    if (/no such table/i.test(String(err && err.message))) {
      catalogIdsNoTable = { db, until: Date.now() + CATALOG_IDS_TABLE_RETRY_MS };
    } else {
      console.warn("[CatalogIds] media lookup failed; serving ids without it.", err && err.message);
    }
    return null;
  }
}

function catalogIdFromRow(row) {
  if (!row) return null;
  if (row.imdb_id) return row.imdb_id;
  if (row.tmdb_id) return "tmdb:" + row.tmdb_id;
  return null;
}

// The page with every id canonical, duplicates removed and the total adjusted.
// Returns `metas` itself when the switch is off. Never throws.
async function canonicalizeCatalogMetas(env, metas, { kind } = {}) {
  if (!isCanonicalIdsEnabled(env) || !Array.isArray(metas) || !metas.length) return metas;
  const plans = metas.map((m) => planCatalogId(m, kind));
  const index = await catalogIdMediaRows(env, plans);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < metas.length; i++) {
    const meta = metas[i];
    const plan = plans[i];
    let id = null;
    if (!plan) id = null;
    else if (plan.keep) id = plan.keep;
    else if (plan.imdb) id = plan.imdb;
    else if (plan.tmdb) {
      const row = index && plan.kind ? matchMediaRow(index, { kind: plan.kind, tmdbId: plan.tmdb }) : null;
      id = (row && row.imdb_id) || "tmdb:" + plan.tmdb;
    } else if (plan.alt) {
      const row = index && plan.kind ? matchMediaRow(index, { kind: plan.kind, altId: plan.alt }) : null;
      id = catalogIdFromRow(row) || (CATALOG_ALT_ID_SCHEMES.includes(plan.scheme) ? plan.alt : null);
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(meta.id === id ? meta : { ...meta, id });
  }
  const total = metas.totalItems;
  if (typeof total === "number") out.totalItems = Math.max(out.length, total - (metas.length - out.length));
  return out;
}
