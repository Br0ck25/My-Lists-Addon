// My Lists TV: marking a whole show watched, and reading back what the account has finished.
//
// POST /api/nuvio-tv/history { targetId, type: "series", imdbId, whole: true, watchedAt? } records every aired episode
// of the show, files the show under fullyWatchedShowIds and takes it off Continue Watching and the Watchlist.
// POST /api/nuvio-tv/watched { targetId, action: "get" } answers { ok, movies: ["tt.."], shows: [{ id, complete, episodes: ["1:2"] }] }
// so the launcher can draw the watched check mark. Both read and write the same tracking record the website uses
// (for an account on the activity database, the KV key is wrapped and does the translating).
const TV_WATCHED_MAX_MOVIES = 5000;
const TV_WATCHED_MAX_SHOWS = 500;
const TV_WATCHED_MAX_EPISODES = 3000;
const TV_WHOLE_SHOW_MAX_SEASONS = 80;

// The account's tracking record from where it lives, or an empty one.
async function tvLoadTrackingBlob(env, username) {
  await ensureTrackingMigrated(env, username);
  let blob = null;
  if (env.DB) { try { blob = await readCreatorTrackingD1(env, username); } catch {} }
  if (!blob) { try { const raw = await env.CONFIGS.get(`creatorsynctracking:${username}`); if (raw) blob = JSON.parse(raw); } catch {} }
  if (!blob || typeof blob !== "object") blob = { watchHistory: [], continueWatching: [], fullyWatchedShowIds: [], dismissedContinueWatching: {}, watchlist: [] };
  blob.watchHistory = Array.isArray(blob.watchHistory) ? blob.watchHistory : [];
  blob.continueWatching = Array.isArray(blob.continueWatching) ? blob.continueWatching : [];
  blob.watchlist = Array.isArray(blob.watchlist) ? blob.watchlist : [];
  blob.fullyWatchedShowIds = Array.isArray(blob.fullyWatchedShowIds) ? blob.fullyWatchedShowIds : [];
  return blob;
}

// The show's title, poster and every episode that has already aired (today counts), from the same TMDB lookups the
// single-episode path uses. null when TMDB has nothing for the id.
async function tvAiredEpisodes(lookupId, env, ctx) {
  const details = await fetchTmdbItemDetails(lookupId, TMDB_API_KEY, "series", "", false, env, ctx).catch(() => null);
  if (!details || !Array.isArray(details.seasonsData)) return null;
  const seasons = details.seasonsData.filter((s) => s && s.season_number > 0).slice(0, TV_WHOLE_SHOW_MAX_SEASONS);
  const results = await Promise.all(seasons.map((s) => fetchTmdbSeasonDetails(lookupId, s.season_number, TMDB_API_KEY, details.tmdbId, env, ctx).catch(() => null)));
  const today = new Date().toISOString().slice(0, 10);
  const episodes = [];
  results.forEach((r, i) => {
    for (const ep of (r && Array.isArray(r.episodes) ? r.episodes : [])) {
      if (!ep || !(ep.episode_number >= 1) || !ep.air_date || String(ep.air_date).slice(0, 10) > today) continue;
      const still = ep.still_path ? (String(ep.still_path).startsWith("http") ? ep.still_path : `https://image.tmdb.org/t/p/w500${ep.still_path}`) : "";
      episodes.push({ season: seasons[i].season_number, episode: ep.episode_number, name: ep.name || `Episode ${ep.episode_number}`, still });
    }
  });
  return { title: details.title || "", poster: details.poster || "", episodes };
}

async function handleNuvioTvWholeShowAdd(env, ctx, username, { imdbId, lookupId, watchedAt }) {
  const aired = await tvAiredEpisodes(lookupId, env, ctx);
  if (!aired || !aired.episodes.length) return json({ ok: false, error: "No aired episodes found for that show." }, 404, corsHeaders());
  const showId = imdbId || lookupId;
  const blob = await tvLoadTrackingBlob(env, username);
  const title = aired.title || showId;
  const entries = aired.episodes.map((e) => ({
    id: `${showId}:${e.season}:${e.episode}`, type: "episode", name: e.name, poster: e.still || aired.poster || "",
    showId, showTitle: title, showPoster: aired.poster, seasonNum: e.season, episodeNum: e.episode, watchedAt,
  }));
  const isThisShow = (it) => it && (it.showId === showId || it.id === showId);
  // Highest episode first, as the newest play is first in the record; older entries for the show are replaced.
  entries.sort((a, b) => b.seasonNum - a.seasonNum || b.episodeNum - a.episodeNum);
  blob.watchHistory = [...entries, ...blob.watchHistory.filter((it) => it && !isThisShow(it))];
  if (!blob.fullyWatchedShowIds.map(String).includes(showId)) blob.fullyWatchedShowIds.push(showId);
  blob.continueWatching = blob.continueWatching.filter((it) => it && it.showId !== showId);
  blob.watchlist = blob.watchlist.filter((it) => it && String(it.id || it.imdbId) !== showId && String(it.showId || "") !== showId);
  blob.updatedAt = Date.now();
  await env.CONFIGS.put(`creatorsynctracking:${username}`, JSON.stringify(blob));
  if (env.DB) { try { await saveCreatorTrackingD1(env, username, blob, false); } catch {} }
  return json({ ok: true, success: true, episodes: entries.length }, 200, corsHeaders());
}

// The record with the show's plays and its "fully watched" mark gone. `intentional` tells an account on the activity
// database that leaving the plays out is a removal.
async function handleNuvioTvWholeShowRemove(env, username, imdbId) {
  const blob = await tvLoadTrackingBlob(env, username);
  blob.watchHistory = blob.watchHistory.filter((it) => it && it.showId !== imdbId && it.id !== imdbId);
  blob.fullyWatchedShowIds = blob.fullyWatchedShowIds.filter((id) => String(id) !== imdbId);
  blob.updatedAt = Date.now();
  const stored = isEventTrackingEnabled(env) ? { ...blob, _intentionalRemoval: true } : blob;
  await env.CONFIGS.put(`creatorsynctracking:${username}`, JSON.stringify(stored));
  if (env.DB) { try { await saveCreatorTrackingD1(env, username, blob, true); } catch {} }
  return json({ ok: true, success: true }, 200, corsHeaders());
}

// What the account has finished, as bare IMDb ids: movies, and per show its watched episodes ("season:episode").
async function handleNuvioTvWatched(env, username) {
  const blob = await tvLoadTrackingBlob(env, username);
  const isImdb = (id) => /^tt\d+$/.test(String(id || ""));
  const movies = new Set();
  const byShow = new Map();
  const showEntry = (id) => { let s = byShow.get(id); if (!s) { s = { id, complete: false, eps: new Map(), last: 0 }; byShow.set(id, s); } return s; };
  for (const it of blob.watchHistory) {
    if (!it) continue;
    if (it.type === "episode" && isImdb(it.showId) && Number.isFinite(Number(it.seasonNum)) && Number(it.episodeNum) >= 1) {
      const s = showEntry(String(it.showId));
      s.eps.set(`${Number(it.seasonNum)}:${Number(it.episodeNum)}`, [Number(it.seasonNum), Number(it.episodeNum)]);
      s.last = Math.max(s.last, Number(it.watchedAt) || 0);
    } else if (it.type !== "episode" && !it.showId && isImdb(it.id)) {
      movies.add(String(it.id));
    }
  }
  for (const id of blob.fullyWatchedShowIds) if (isImdb(id)) showEntry(String(id)).complete = true;
  const shows = [...byShow.values()].sort((a, b) => b.last - a.last).slice(0, TV_WATCHED_MAX_SHOWS).map((s) => ({
    id: s.id, complete: s.complete,
    episodes: [...s.eps.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, TV_WATCHED_MAX_EPISODES).map(([se, ep]) => `${se}:${ep}`),
  }));
  return json({ ok: true, movies: [...movies].slice(0, TV_WATCHED_MAX_MOVIES), shows }, 200, { ...corsHeaders(), "Cache-Control": "no-store" });
}
