// --- Title details for a title TMDB does not have yet -------------------------
//
// /api/details (25_) finds a title at TMDB by its IMDb id. New on Streaming
// (fetchNewOnStreaming, 07_) lists titles by IMDb id the day JustWatch or
// RapidAPI sees a service add them -- some of them before TMDB has an entry
// at all. Seen on the site (2026-10-01): The Devil's Mark (tt39833082) and
// Full Figured Flings (tt35457754), both 2026. Opening either said "Not found
// or TMDB error", with Better Posters on or off.
//
// What is known about such a title -- the name, poster, backdrop and year New
// on Streaming stored with it, and Cinemeta's record when it has one -- is
// handed back in the shape fetchTmdbItemDetails answers with: tmdbId null,
// and nothing only TMDB knows (its rating, seasons, budget). null when
// neither knows the title, so the route still answers "not found" then.
//
// Module level, after the Worker's exports, like 27_ onward.

// The New on Streaming row for one title, newest event first. Narrowed by
// region and service so the lookup walks the table's primary key
// (region, service, imdb_id) instead of scanning it.
async function streamingEventTitle(env, imdbId, region) {
  if (!env || !env.DB || typeof NEW_ON_STREAMING_PROVIDERS === "undefined") return null;
  const services = NEW_ON_STREAMING_PROVIDERS.map((p) => p.key);
  const where = typeof newOnStreamingRegion === "function" ? newOnStreamingRegion(region) : String(region || "US").toUpperCase().slice(0, 2);
  try {
    return await env.DB.prepare(
      `SELECT kind, name, poster, background, year
         FROM streaming_events
        WHERE region = ? AND service IN (${services.map(() => "?").join(",")}) AND imdb_id = ?
        ORDER BY last_event_at DESC
        LIMIT 1`
    ).bind(where, ...services, imdbId).first();
  } catch {
    return null;
  }
}

// Cinemeta's record for one title, trying the kind it was asked for first.
async function cinemetaTitleMeta(imdbId, kinds) {
  for (const kind of kinds) {
    try {
      const res = await fetch(`https://v3-cinemeta.strem.io/meta/${kind}/${imdbId}.json`, {
        cf: { cacheTtl: 86400, cacheEverything: true },
      });
      if (!res.ok) continue;
      const data = await res.json().catch(() => null);
      if (data && data.meta && data.meta.name) return data.meta;
    } catch {}
  }
  return null;
}

// "1h 32min", "92 min", 92 -> 92; anything else -> null.
function cinemetaRuntimeMinutes(raw) {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.round(raw);
  const s = String(raw || "").toLowerCase();
  const h = s.match(/(\d+)\s*h/);
  const m = s.match(/(\d+)\s*min/);
  const total = (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
  return total > 0 ? total : null;
}

async function titleDetailsWithoutTmdb(env, rawId, type, region) {
  const imdbId = String(rawId || "").trim().split(":")[0].toLowerCase();
  if (!/^tt\d{5,12}$/.test(imdbId)) return null;
  const row = await streamingEventTitle(env, imdbId, region);
  const wantSeries = type === "series" || type === "tv" || (row && row.kind === "series");
  const meta = await cinemetaTitleMeta(imdbId, wantSeries ? ["series", "movie"] : ["movie", "series"]);
  const title = (meta && meta.name) || (row && row.name) || "";
  if (!title) return null;

  const trailer = meta && Array.isArray(meta.trailers)
    ? meta.trailers.find((t) => t && t.source && (!t.type || t.type === "Trailer"))
    : null;
  const listOf = (v) => (Array.isArray(v) && v.length ? v.filter((x) => typeof x === "string" && x).slice(0, 8) : undefined);
  const released = meta && typeof meta.released === "string" ? meta.released.slice(0, 10) : "";
  const year = String((meta && (meta.year || meta.releaseInfo)) || (row && row.year) || "").slice(0, 4);

  let nextEpisodeAirDate = null;
  let nextEpisodeNumber = null;
  let nextEpisodeSeasonNumber = null;
  let nextEpisodeName = null;

  if (wantSeries && meta && Array.isArray(meta.videos)) {
    const todayStr = new Date().toISOString().slice(0, 10);
    const futureVids = meta.videos.filter((v) => {
      const d = (v && (v.released || v.firstAired) ? String(v.released || v.firstAired).slice(0, 10) : "");
      return d && d >= todayStr;
    });
    futureVids.sort((a, b) => {
      const da = (a.released || a.firstAired || "").slice(0, 10);
      const db = (b.released || b.firstAired || "").slice(0, 10);
      return da.localeCompare(db);
    });
    const nextV = futureVids[0];
    if (nextV) {
      nextEpisodeAirDate = (nextV.released || nextV.firstAired || "").slice(0, 10) || null;
      nextEpisodeNumber = nextV.episode != null ? nextV.episode : null;
      nextEpisodeSeasonNumber = nextV.season != null ? nextV.season : null;
      const vName = nextV.name || nextV.title;
      if (vName && !isGenericEpisodeTitle(vName, nextV.episode)) {
        nextEpisodeName = vName;
      }
    }
  }

  return {
    id: imdbId,
    imdbId: imdbId,
    title: title,
    overview: (meta && meta.description) || "",
    // The stored poster first: it is the one the New on Streaming tile shows.
    poster: (row && row.poster) || (meta && meta.poster) || "",
    background: (row && row.background) || (meta && meta.background) || "",
    rating: null,
    releaseYear: /^\d{4}$/.test(year) ? year : "",
    releaseDate: /^\d{4}-\d{2}-\d{2}$/.test(released) ? released : null,
    seasonsData: null,
    tmdbId: null,
    runtime: meta ? cinemetaRuntimeMinutes(meta.runtime) : null,
    budget: null,
    revenue: null,
    contentRating: null,
    genres: meta && Array.isArray(meta.genres) ? meta.genres.filter((g) => typeof g === "string").join(", ") : "",
    trailerKey: trailer ? String(trailer.source) : null,
    cast: listOf(meta && meta.cast),
    director: listOf(meta && meta.director),
    nextEpisodeAirDate,
    nextEpisodeNumber,
    nextEpisodeSeasonNumber,
    nextEpisodeName,
    notOnTmdb: true,
  };
}
