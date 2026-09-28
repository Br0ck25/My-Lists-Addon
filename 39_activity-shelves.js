
// --- Personal shelves from the activity database (Phase 3c, P3c-5) ------------
//
// Continue Watching, Airing Next, Watch History and the Watchlist, worked
// out when read instead of stored:
//
//   - Continue Watching and Airing Next are two queries and a join in the
//     Worker: up to SHELF_PROGRESS_LIMIT show_progress rows for the account
//     (activity database), then the titles and show_schedule rows for them
//     (main database), SHELF_JOIN_CHUNK ids at a time -- the two live in
//     different databases, so SQL cannot join them.
//   - Watch History pages the account's watch_events, newest first.
//   - The Watchlist is the account's watchlist list (lists v2).
//
// The rules are the legacy ones (checkForNewEpisodes, refreshAiringNext-
// Sweep and the website's), applied to rows:
//   - Continue Watching: per show, the episode after the furthest one
//     watched, once it exists (aired, or announced with a date: isUnaired);
//     not while the show's dismissal stands (made at or after the furthest
//     episode watched); storyline suggestions and movies kept whole in
//     companion_json as they were. Most recently watched first.
//   - Airing Next: per show with a watched episode (or finished), the next
//     episode when it has not aired yet; not while the show's removal stands
//     (made at or after the furthest episode watched). Soonest first.
//   - Progress (S, 0) means "nothing of season S yet", so the episode after
//     it is (S, 1). 37_activity-backfill.js keeps a Continue Watching show
//     with no history that way.
//
// Items come back in the legacy shapes the catalogs and the website already
// read (see fetchAutoTrackedCatalog), each with its mediaId. A show whose
// schedule row is missing (not refreshed yet, Phase 5) is left off and
// named in `missingSchedule`, so a caller can tell "nothing new" from "not
// known yet".
//
// Nothing calls these yet: P3c-6 serves /sync/load and the personal rows
// from them, behind FF_EVENT_TRACKING.

const SHELF_PROGRESS_LIMIT = 200;
const SHELF_JOIN_CHUNK = 90;
const SHELF_HISTORY_PAGE = 50;
const SHELF_HISTORY_PAGE_MAX = 500;

// Today as YYYY-MM-DD. An episode has aired when its date is before today,
// as isEpisodeAired has it.
function shelfToday(now) {
  const d = new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now());
  return d.toISOString().slice(0, 10);
}

function shelfAired(date, today) {
  return !!date && String(date).slice(0, 10) < today;
}

// (a, b) at or before (c, d), episode by episode.
function shelfAtOrBefore(aS, aE, bS, bE) {
  return aS < bS || (aS === bS && aE <= bE);
}

function shelfShowId(m) {
  if (m.imdb_id) return m.imdb_id;
  if (m.tmdb_id) return `tmdb:${m.tmdb_id}`;
  return m.alt_id || `media:${m.id}`;
}

function shelfPoster(m) {
  if (m.poster_path) return String(m.poster_path).startsWith("http") ? m.poster_path : LEGACY_ITEM_POSTER_BASE + m.poster_path;
  return m.imdb_id ? `https://images.metahub.space/poster/medium/${m.imdb_id}/img` : "";
}

function shelfEpisodeCounts(sched) {
  if (!sched || !sched.season_episode_counts) return null;
  try {
    const raw = JSON.parse(sched.season_episode_counts);
    const out = new Map();
    for (const [k, v] of Object.entries(raw || {})) {
      const s = Number(k);
      const n = Number(v);
      if (Number.isInteger(s) && Number.isFinite(n)) out.set(s, n);
    }
    return out;
  } catch {
    return null;
  }
}

// The episode after (season, episode) as the schedule knows it:
// { season, episode, airDate, aired }, or null when there is none yet (or
// the schedule cannot say). Episode counts name it across a season boundary;
// without them, only what the last aired and next episodes pin down.
function shelfEpisodeAfter(sched, season, episode, today) {
  if (!sched) return null;
  const lastS = sched.last_aired_season;
  const lastE = sched.last_aired_episode;
  const nextS = sched.next_season;
  const nextE = sched.next_episode;
  let cand = null;
  const counts = shelfEpisodeCounts(sched);
  if (counts) {
    if ((counts.get(season) || 0) > episode) {
      cand = { season, episode: episode + 1 };
    } else {
      const later = [...counts.entries()].filter(([s, n]) => s > season && s > 0 && n > 0).map(([s]) => s).sort((a, b) => a - b);
      if (later.length) cand = { season: later[0], episode: 1 };
    }
  }
  // No counts, or counts that do not list the season TMDB has just
  // announced: what the last aired and next episodes pin down.
  if (!cand) {
    if (lastS != null && lastE != null && lastS === season && lastE > episode) {
      cand = { season, episode: episode + 1 };
    } else if (nextS === season && nextE === episode + 1) {
      cand = { season, episode: episode + 1 };
    } else if (nextS != null && nextS > season && nextE === 1) {
      cand = { season: nextS, episode: 1 };
    } else if (episode === 0 && lastS != null && (lastS > season || (lastS === season && lastE >= 1))) {
      cand = { season, episode: 1 };
    }
  }
  if (!cand) return null;
  if (nextS === cand.season && nextE === cand.episode) {
    return { ...cand, airDate: sched.next_air_date || null, aired: shelfAired(sched.next_air_date, today) };
  }
  if (lastS != null && lastE != null && shelfAtOrBefore(cand.season, cand.episode, lastS, lastE)) {
    return { ...cand, airDate: lastS === cand.season && lastE === cand.episode ? sched.last_aired_date || null : null, aired: true };
  }
  // Past the last aired episode and not the announced next one: not known.
  return null;
}

function shelfBadges(sched, season, episode) {
  const finaleSeason = sched.season_finale_season != null ? sched.season_finale_season : (sched.next_season != null ? sched.next_season : sched.last_aired_season);
  const inFinaleSeason = finaleSeason === season;
  return {
    isSeasonPremiere: episode === 1 || undefined,
    isSeasonFinale: (inFinaleSeason && sched.season_finale_episode != null && episode === sched.season_finale_episode) || undefined,
    seasonFinaleAirDate: inFinaleSeason ? sched.season_finale_date || undefined : undefined,
    seasonFinaleEpisodeNumber: inFinaleSeason && sched.season_finale_episode != null ? sched.season_finale_episode : undefined,
  };
}

// Query one: the account's shows and suggestions, most recent first.
async function shelfProgressRows(env, accountId) {
  const actDb = activityDb(env, accountId);
  if (!actDb) return [];
  const { results } = await actDb.prepare(
    `SELECT * FROM show_progress WHERE account_id = ?
     ORDER BY last_watched_at IS NULL, last_watched_at DESC, media_id LIMIT ?`
  ).bind(accountId, SHELF_PROGRESS_LIMIT).all();
  return results || [];
}

// Query two: the titles and their schedules, SHELF_JOIN_CHUNK at a time.
// Without migration 0017 the titles alone.
async function shelfTitles(env, mediaIds) {
  const out = new Map();
  const ids = [...new Set(mediaIds.filter((id) => id != null))];
  for (let i = 0; i < ids.length; i += SHELF_JOIN_CHUNK) {
    const part = ids.slice(i, i + SHELF_JOIN_CHUNK);
    const marks = part.map(() => "?").join(", ");
    let rows;
    try {
      ({ results: rows } = await env.DB.prepare(
        `SELECT m.id, m.kind, m.imdb_id, m.tmdb_id, m.alt_id, m.title, m.year, m.poster_path,
                s.media_id AS s_media, s.status AS s_status, s.last_aired_season, s.last_aired_episode, s.last_aired_date,
                s.next_season, s.next_episode, s.next_air_date, s.next_air_time, s.air_tz,
                s.season_finale_season, s.season_finale_date, s.season_finale_episode, s.season_episode_counts
         FROM media m LEFT JOIN show_schedule s ON s.media_id = m.id WHERE m.id IN (${marks})`
      ).bind(...part).all());
    } catch (e) {
      if (!/no such table|no such column/i.test(String((e && e.message) || e))) throw e;
      ({ results: rows } = await env.DB.prepare(
        `SELECT id, kind, imdb_id, tmdb_id, alt_id, title, year, poster_path FROM media WHERE id IN (${marks})`
      ).bind(...part).all());
    }
    for (const r of rows || []) out.set(r.id, { media: r, sched: r.s_media != null ? r : null });
  }
  return out;
}

async function continueWatching(env, accountId, opts = {}) {
  const today = shelfToday(opts.now);
  const rows = await shelfProgressRows(env, accountId);
  const titles = await shelfTitles(env, rows.map((r) => r.media_id));
  const items = [];
  const missingSchedule = [];
  for (const row of rows) {
    if (row.status === "dropped") continue;
    const t = titles.get(row.media_id);
    if (row.last_season == null || row.last_episode == null) {
      // A storyline suggestion or a movie, kept as the entry it was.
      if (row.companion_json) {
        try {
          const entry = JSON.parse(row.companion_json);
          items.push({ ...entry, mediaId: row.media_id, updatedAt: Number(row.last_watched_at) || Number(entry.updatedAt) || 0 });
        } catch {}
      }
      continue;
    }
    if (!t) continue;
    const lastS = Number(row.last_season);
    const lastE = Number(row.last_episode);
    if (row.dismissed_at_season != null && shelfAtOrBefore(lastS, lastE, Number(row.dismissed_at_season), Number(row.dismissed_at_episode) || 0)) continue;
    if (!t.sched) {
      missingSchedule.push(row.media_id);
      continue;
    }
    const next = shelfEpisodeAfter(t.sched, lastS, lastE, today);
    if (!next) continue;
    const showId = shelfShowId(t.media);
    const poster = shelfPoster(t.media);
    items.push({
      id: `${showId}:${next.season}:${next.episode}`,
      type: "episode",
      name: next.episode === 1 ? "Season Premiere" : `Episode ${next.episode}`,
      poster,
      showId,
      showTitle: t.media.title || "",
      showPoster: poster,
      seasonNum: next.season,
      episodeNum: next.episode,
      airDate: next.airDate || undefined,
      isUnaired: next.aired ? undefined : true,
      ...shelfBadges(t.sched, next.season, next.episode),
      updatedAt: Number(row.last_watched_at) || 0,
      mediaId: row.media_id,
    });
  }
  items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return { items, missingSchedule };
}

async function airingNext(env, accountId, opts = {}) {
  const today = shelfToday(opts.now);
  const rows = await shelfProgressRows(env, accountId);
  const candidates = rows.filter((r) => r.status !== "dropped" && (r.last_season != null || r.status === "completed"));
  const titles = await shelfTitles(env, candidates.map((r) => r.media_id));
  const items = [];
  const missingSchedule = [];
  for (const row of candidates) {
    if (row.airing_hidden_at_season != null) {
      const stands = row.last_season == null
        || shelfAtOrBefore(Number(row.last_season), Number(row.last_episode) || 0, Number(row.airing_hidden_at_season), Number(row.airing_hidden_at_episode) || 0);
      if (stands) continue;
    }
    const t = titles.get(row.media_id);
    if (!t || t.media.kind !== "series") continue;
    if (!t.sched) {
      missingSchedule.push(row.media_id);
      continue;
    }
    const s = t.sched;
    if (!s.next_air_date || shelfAired(s.next_air_date, today) || s.next_season == null || s.next_episode == null) continue;
    const showId = shelfShowId(t.media);
    const name = s.next_episode === 1 ? "Season Premiere" : `Episode ${s.next_episode}`;
    const label = s.next_air_time && typeof formatAirTimeLabel === "function" ? formatAirTimeLabel(s.next_air_time, s.air_tz) : "";
    items.push({
      id: showId,
      type: "series",
      showId,
      canonicalTmdbId: t.media.tmdb_id ? String(t.media.tmdb_id) : null,
      showTitle: t.media.title || "",
      showPoster: shelfPoster(t.media),
      name,
      episodeTitle: name,
      airDate: s.next_air_date,
      seasonNum: s.next_season,
      episodeNum: s.next_episode,
      ...shelfBadges(s, s.next_season, s.next_episode),
      airTime: label || null,
      isUnaired: true,
      mediaId: row.media_id,
    });
  }
  items.sort((a, b) => String(a.airDate || "").localeCompare(String(b.airDate || "")) || a.mediaId - b.mediaId);
  return { items, missingSchedule };
}

// One page of Watch History, newest first. cursor is the opaque string the
// previous page returned ("watchedAt:id"); null at the end.
async function watchHistoryPage(env, accountId, opts = {}) {
  const actDb = activityDb(env, accountId);
  if (!actDb) return { items: [], cursor: null };
  const limit = Math.max(1, Math.min(SHELF_HISTORY_PAGE_MAX, Math.floor(Number(opts.limit)) || SHELF_HISTORY_PAGE));
  let sql = "SELECT id, media_id, season, episode, watched_at FROM watch_events WHERE account_id = ?";
  const args = [accountId];
  const m = /^(\d+):(\d+)$/.exec(String(opts.cursor || ""));
  if (m) {
    sql += " AND (watched_at < ? OR (watched_at = ? AND id < ?))";
    args.push(Number(m[1]), Number(m[1]), Number(m[2]));
  }
  sql += " ORDER BY watched_at DESC, id DESC LIMIT ?";
  args.push(limit + 1);
  const { results } = await actDb.prepare(sql).bind(...args).all();
  const rows = results || [];
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const titles = await shelfTitles(env, page.map((r) => r.media_id));
  const items = [];
  for (const r of page) {
    const t = titles.get(r.media_id);
    if (!t) continue;
    const showId = shelfShowId(t.media);
    const poster = shelfPoster(t.media);
    if (r.season != null && r.episode != null) {
      items.push({
        id: `${showId}:${r.season}:${r.episode}`, type: "episode", name: `Episode ${r.episode}`, poster,
        showId, showTitle: t.media.title || "", showPoster: poster, seasonNum: r.season, episodeNum: r.episode,
        watchedAt: r.watched_at, mediaId: r.media_id,
      });
    } else {
      items.push({
        id: showId, type: t.media.kind === "series" ? "series" : "movie", name: t.media.title || "", poster,
        year: t.media.year ? String(t.media.year) : undefined, watchedAt: r.watched_at, mediaId: r.media_id,
      });
    }
  }
  const last = page[page.length - 1];
  return { items, cursor: more && last ? `${last.watched_at}:${last.id}` : null };
}

// The Watchlist: the account's watchlist list in lists v2, as legacy items.
async function watchlistShelf(env, accountId) {
  try {
    const row = await env.DB.prepare(
      "SELECT slug FROM lists WHERE owner_account_id = ? AND kind = 'watchlist' AND deleted_at IS NULL ORDER BY id LIMIT 1"
    ).bind(accountId).first();
    const rec = await listsV2RecordFor(env, { id: accountId }, row ? row.slug : "watchlist");
    return { items: rec && Array.isArray(rec.items) ? rec.items : [], updatedAt: rec && Number(rec.updatedAt) || 0 };
  } catch (e) {
    if (/no such table/i.test(String((e && e.message) || e))) return { items: [], updatedAt: 0 };
    throw e;
  }
}
