// Adding to a connected Nuvio or Stremio Watch History from the website: one movie, one show
// episode, or a whole season (the page sends the season's episode numbers in `episodes`).

const MEDIA_APP_SEASON_MAX = 200;

// The episode numbers to add: [n] for one episode, the list for a season, or null when the
// request does not name a valid episode.
function mediaAppAddEpisodes(body) {
  if (body.episodes != null) {
    if (!Array.isArray(body.episodes) || body.episodes.length < 1 || body.episodes.length > MEDIA_APP_SEASON_MAX) return null;
    const list = [...new Set(body.episodes.map(mediaAppInt))];
    return list.every((n) => n != null && n >= 1) ? list.sort((x, y) => x - y) : null;
  }
  const episode = body.episode == null ? null : mediaAppInt(body.episode);
  return episode != null && episode >= 1 ? [episode] : null;
}

async function mediaAppAddHistory(env, accountId, provider, body) {
  if (!mediaAppPushFlag(env)) return json({ ok: false, error: "App writes aren't switched on yet." }, 409);
  const id = mediaAppTitleId(body.id);
  const kind = mediaAppKind(body.mediaType);
  const season = body.season == null ? null : mediaAppInt(body.season);
  const episodes = kind === "series" ? mediaAppAddEpisodes(body) : [];
  if (!id || !kind || (kind === "series" && (season == null || !episodes))) {
    return json({ ok: false, error: "Choose a movie, a show episode or a season." }, 400);
  }
  let conn = await loadProviderConnection(env, accountId, provider);
  const sync = await loadMediaAppSync(env, accountId, provider);
  if (!conn || conn.status !== "ok" || !sync) return json({ ok: false, error: "That account isn't connected." }, 404);
  const now = Date.now();
  const contentId = id.imdbId || `tmdb:${id.tmdbId}`;
  const title = String(body.title || "").slice(0, 200);
  const plays = kind === "series"
    ? episodes.map((episode) => ({ contentId, kind, title, season, episode, watchedAt: now }))
    : [{ contentId, kind, title, season: null, episode: null, watchedAt: now }];
  if (provider === "nuvio") {
    conn = await refreshProviderConnectionIfDue(env, accountId, provider, conn);
    if (!conn || !conn.accessToken || !sync.profile_index) return json({ ok: false, error: "Sign in and choose a Nuvio profile first." }, 400);
    await nuvioRpc(env, conn.accessToken, "sync_push_watched_items", { p_profile_id: sync.profile_index, p_items: plays.map(nuvioWatchedItem) });
  } else {
    if (!id.imdbId) return json({ ok: false, error: "Stremio needs an IMDb ID for this title." }, 400);
    const library = await stremioFetchLibrary(conn.accessToken);
    const item = library.find((it) => String(it._id) === id.imdbId && mediaAppKind(it.type) === kind);
    if (!item) return json({ ok: false, error: "Add this title to your Stremio library first." }, 400);
    const state = { ...(item.state || {}) };
    if (kind === "series") {
      const eps = await stremioEpisodes(id.imdbId);
      if (!eps || !episodes.every((n) => eps.some((e) => e.season === season && e.episode === n))) return json({ ok: false, error: "Stremio could not find that episode." }, 400);
      const watched = new Set((state.watched ? await stremioWatchedEpisodes(state.watched, eps) : []).map((e) => `${e.season}:${e.episode}`));
      for (const n of episodes) watched.add(`${season}:${n}`);
      state.watched = await stremioEncodeWatched(eps, watched);
      state.video_id = `${id.imdbId}:${season}:${episodes[episodes.length - 1]}`;
    } else {
      state.timesWatched = Math.max(1, Number(state.timesWatched) || 0);
      state.flaggedWatched = 1;
    }
    state.lastWatched = new Date(now).toISOString();
    const result = await stremioCall("datastorePut", { authKey: conn.accessToken, collection: "libraryItem", changes: [{ ...item, _mtime: new Date(now).toISOString(), state }] });
    if (!result || result.success !== true) throw mediaAppError("unreachable", "Stremio did not accept the update.");
  }
  const rec = { ...id, kind, title, mtime: now, at: now, plays: plays.map((p) => ({ season: p.season, episode: p.episode, watchedAt: now })), furthest: kind === "series" ? { season, episode: episodes[episodes.length - 1] } : null, resume: null };
  let local = null;
  try { local = await applyMediaAppRecords(env, accountId, provider, [rec]); }
  catch (e) { console.error("mediaapp: could not mirror added history", e); }
  return json({ ok: true, added: plays.length, mirrored: !!local && !local.skipped && !local.unresolved && local.plays > 0 });
}
