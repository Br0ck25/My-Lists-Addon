// Auto-track Playback ping from the /:config/subtitles/... route, moved out of handleFetch (CQ-01).

// Moved unchanged apart from the captured ctx and path becoming parameters
// (and authenticateCreator, which read handleFetch's request/env/ctx/path,
// becoming a call to authenticateCreatorFor with them). handleFetch keeps a
// one-line handleSubtitlesTrack wrapper. detectClientApp, which only this
// ping used, moved with it. Split into helpers only for the 150-line limit;
// each helper is a block of the original, in the same order.
// Handles a single "this just started playing" ping from the
// /:config/subtitles/... route (25_api-catalog-routes.js) -- see
// buildManifest's comment for the full mechanism. Never throws back
// to the caller (that route already responded before this runs, via
// ctx.waitUntil), so every failure path below just records a
// diagnostic and returns quietly instead.
//
// An episode gets marked watched outright: if you're playing it,
// you're caught up to it -- a discrete, already-aired unit with
// nothing ambiguous about it. A movie ping gets treated the same way
// here, marked watched immediately, which is a deliberate
// simplification versus where this idea started (a similar reference
// implementation treats a movie ping as merely "in progress," since
// one ping at the start doesn't prove you finished a 2-hour movie the
// way starting an episode implies you're caught up to that episode).
// This addon's Watch History has no in-progress state to put a movie
// into, only watched/not-watched, so there isn't a cleanly analogous
// middle ground to preserve that distinction with.
async function handleSubtitlesTrackFor(configParam, stremioType, id, env, request, ctx, path) {
  if (!env || !env.CONFIGS) return;

  let track, trackCreatorName, trackCreatorKey, tmdbKey, installTrackOwner;
  try {
    ({ track, trackCreatorName, trackCreatorKey, tmdbKey, installTrackOwner } = await resolveConfig(configParam, env));
  } catch {
    return;
  }
  // A v2 install link carries no Creator Key: its "track" scope, granted
  // to the signed-in account that created it, stands in for one (see
  // resolveV2InstallConfig, 27_installs.js).
  if (installTrackOwner) {
    trackCreatorName = installTrackOwner;
  } else if (!trackCreatorName || !trackCreatorKey) {
    return;
  }
  if (!track) {
    // Auto-track Playback resolved to off for this install link. This
    // can happen even when the user sees the toggle on in Settings, if
    // their install link is stale (see the config staleness note on
    // resolveConfig / Configure -> Update) -- write a diagnostic so
    // "nothing showed up" is visible and traceable instead of silent.
    const diagnosticsKey = `creatortrack:${trackCreatorName.toLowerCase()}`;
    await env.CONFIGS.put(diagnosticsKey, JSON.stringify({
      lastPingAt: Date.now(),
      lastPingId: `${stremioType}:${id}`,
      matched: "no (Auto-track Playback is off for this install link -- go to Configure, re-enable it, then Update your install link)",
    }));
    return;
  }

  const auth = installTrackOwner
    ? ((await isCreatorTombstoned(env, installTrackOwner)) ? { ok: false } : { ok: true, username: installTrackOwner })
    : await authenticateCreatorFor(request, env, ctx, path, trackCreatorName, trackCreatorKey);
  const diagnosticsKey = `creatortrack:${auth.ok ? auth.username : String(trackCreatorName).toLowerCase()}`;
  const pingId = `${stremioType}:${id}`;

  const incomingClient = detectClientApp(request);
  const isNuvioClient = incomingClient === "Nuvio" ||
    (request && request.headers && (
      (request.headers.get("x-nuvio-client") || "").toLowerCase().includes("nuvio") ||
      (request.headers.get("user-agent") || "").toLowerCase().includes("nuvio")
    ));
  if (isNuvioClient) {
    await env.CONFIGS.put(diagnosticsKey, JSON.stringify({
      lastPingAt: Date.now(),
      lastPingId: pingId,
      lastServer: "Nuvio",
      matched: "skipped (Nuvio client reports true completion via /api/nuvio-tv/history)",
    }));
    return;
  }

  if (!auth.ok) {
    await env.CONFIGS.put(diagnosticsKey, JSON.stringify({
      lastPingAt: Date.now(),
      lastPingId: pingId,
      matched: "error: this install's Profile credentials no longer authenticate -- re-generate the install link from Settings.",
    }));
    return;
  }

  const effectiveTmdbKey = tmdbKey || TMDB_API_KEY;
  // Already running inside the caller's ctx.waitUntil (see
  // handleSubtitlesTrack's own call site), so no extra waitUntil
  // needed here -- see trackSharedApiUse in 05_catalog-core.js for
  // the same pattern elsewhere.
  if (!tmdbKey) bumpStat(env, "apiuse:tmdb");
  let cleanId = String(id || "").trim();
  let imdbId = "";
  let season = null;
  let episode = null;

  if (cleanId.startsWith("tmdb:")) {
    const rest = cleanId.slice("tmdb:".length);
    const tmdbParts = rest.split(":");
    imdbId = "tmdb:" + tmdbParts[0];
    if (tmdbParts.length >= 3) {
      season = Number(tmdbParts[1]);
      episode = Number(tmdbParts[2]);
    } else if (tmdbParts.length === 2) {
      season = Number(tmdbParts[0]);
      episode = Number(tmdbParts[1]);
    }
  } else if (cleanId.startsWith("kitsu:")) {
    const rest = cleanId.slice("kitsu:".length);
    const kParts = rest.split(":");
    imdbId = "kitsu:" + kParts[0];
    if (kParts.length >= 2) {
      season = 1;
      episode = Number(kParts[1]);
    }
  } else {
    const parts = cleanId.split(":");
    imdbId = parts[0];
    if (parts.length >= 3) {
      season = Number(parts[1]);
      episode = Number(parts[2]);
    } else if (parts.length === 2) {
      season = 1;
      episode = Number(parts[1]);
    }
  }
  let matched = "no";

  try {
    matched = await recordSubtitlesPlay(env, ctx, auth, stremioType, imdbId, season, episode, effectiveTmdbKey);
  } catch (err) {
    matched = "error: " + (err && err.message ? err.message : String(err));
  }


  const clientApp = detectClientApp(request);
  await env.CONFIGS.put(diagnosticsKey, JSON.stringify({
    lastPingAt: Date.now(),
    lastPingId: pingId,
    lastServer: clientApp,
    matched: matched,
  }));
}

// The try block of handleSubtitlesTrackFor: look the play up, record it, take it off the Watchlist.
async function recordSubtitlesPlay(env, ctx, auth, stremioType, imdbId, season, episode, effectiveTmdbKey) {
  await ensureTrackingMigrated(env, auth.username);
  const syncKey = `creatorsynctracking:${auth.username}`;

  // Resolve what we're actually recording (TMDB lookups) exactly
  // once, before touching KV at all -- these are the slow, expensive
  // part and don't need to be repeated if the KV write below has to
  // retry.
  const resolved = await resolveSubtitlesPlayRecord(stremioType, imdbId, season, episode, effectiveTmdbKey, env, ctx);
  let matched = resolved.matched;
  const { recordEpisode, recordMovie } = resolved;

  // Read-modify-write the shared per-account blob, with a bounded
  // retry: two scrobble pings for the same account (e.g. Nuvio
  // auto-advancing to the next episode and firing another ping
  // moments later, or a player re-probing subtitles mid-playback)
  // both run as independent ctx.waitUntil invocations with no
  // coordination between them, and Cloudflare KV has no
  // compare-and-swap -- if both read the blob before either writes,
  // whichever writes second silently discards whatever the first
  // one added. Re-reading fresh on each attempt and re-checking
  // alreadyWatched against that fresh copy (rather than reusing the
  // blob read at the top of this function) is what makes a retry
  // actually fix the collision instead of just moving it later.
  if (recordEpisode || recordMovie) {
    let alreadyWatched = false;
    await writeSubtitlesPlayRecord(env, { auth, syncKey, imdbId, season, episode, effectiveTmdbKey, recordEpisode, recordMovie });

    if (recordEpisode) {
      const epLabel = recordEpisode.showTitle;
      matched = alreadyWatched
        ? `yes (already watched: ${epLabel} S${season}E${episode})`
        : `yes (${epLabel} S${season}E${episode})`;
    } else if (recordMovie) {
      matched = alreadyWatched ? `yes (already watched: ${recordMovie.movieTitle})` : `yes (${recordMovie.movieTitle})`;
    }
  }

  // Auto-remove watched item from user's Creator Watchlist if present.
  //
  // This used to enumerate the account's whole creatorlist: prefix and
  // then GET every single list, on EVERY playback ping, just to find
  // the one named "Watchlist" -- so the cost of a ping scaled with how
  // many lists the person owns. The enumeration also had no cursor, so
  // past a thousand lists it silently stopped looking.
  //
  // The watchlist has a canonical key: /api/creator/sync/save-tracking
  // writes creatorlist:{user}:watchlist directly, and slugifyServer
  // turns any list actually named "Watchlist" into that same slug. So
  // the common path is one GET. The scan survives only as a fallback
  // for the shapes the old loop also accepted (an isWatchlist flag, or
  // a name that slugified differently), and is now paged and bounded
  // rather than silently truncating.
  try {
    const removeWatchedFrom = async (key, rawList) => {
      if (!rawList) return;
      const l = JSON.parse(rawList);
      if (!Array.isArray(l.items) || !l.items.length) return;
      const initLen = l.items.length;
      l.items = l.items.filter((it) => it && String(it.id || it.imdbId) !== imdbId && String(it.showId || '') !== imdbId);
      if (l.items.length !== initLen) {
        l.updatedAt = Date.now();
        await env.CONFIGS.put(key, JSON.stringify(l));
        // And its v2 copy (P3b-7), which this write used to miss.
        await listsV2MirrorLists(env, auth.username, [key.split(":").slice(2).join(":")]);
        // Auto-Track Playback silently takes what you just watched off
        // the Watchlist. That is a list change made by one device that
        // every other device is showing, which is exactly what the
        // stamp is for -- and the least obvious of the six mutation
        // sites, since nothing here looks like a list edit.
        await bumpCreatorListsStamp(env, auth.username);
      }
    };

    // FF_V2_LISTS_ONLY (P3b-9): the Watchlist lives in v2 only.
    const wlOnlyAccount = isV2ListsOnly(env) ? await listsV2Account(env, auth.username) : null;
    const canonicalKey = `creatorlist:${auth.username}:watchlist`;
    const canonicalRaw = isV2ListsOnly(env) ? null : await env.CONFIGS.get(canonicalKey);
    if (wlOnlyAccount) {
      const raw = await listsV2GetRecordRaw(env, wlOnlyAccount, "watchlist");
      const l = raw ? JSON.parse(raw) : null;
      const before = l && Array.isArray(l.items) ? l.items.length : 0;
      if (before) {
        l.items = l.items.filter((it) => it && String(it.id || it.imdbId) !== imdbId && String(it.showId || '') !== imdbId);
        if (l.items.length !== before) {
          l.updatedAt = Date.now();
          await listsV2WriteRecord(env, wlOnlyAccount, "watchlist", l);
          await bumpCreatorListsStamp(env, auth.username);
        }
      }
    } else if (isV2ListsOnly(env)) {
      // No account row: nothing in v2 to take it off.
    } else if (canonicalRaw) {
      await removeWatchedFrom(canonicalKey, canonicalRaw);
    } else {
      const listKeys = await listAllKeys(env.CONFIGS, `creatorlist:${auth.username}:`, 200);
      for (const k of (listKeys.keys || [])) {
        const rawList = await env.CONFIGS.get(k.name);
        if (!rawList) continue;
        const l = JSON.parse(rawList);
        const isWatchlist = l.slug === 'watchlist' || (l.name && l.name.toLowerCase() === 'watchlist') || l.isWatchlist;
        if (isWatchlist) await removeWatchedFrom(k.name, rawList);
      }
    }
  } catch {}

  return matched;
}

// First part of the try block: the TMDB lookups, done once before any KV write.
async function resolveSubtitlesPlayRecord(stremioType, imdbId, season, episode, effectiveTmdbKey, env, ctx) {
  let matched = "no";
  let recordEpisode = null; // { epIdStr, episodeEntry, showTitle }
  let recordMovie = null; // { movieId, movieEntry, movieTitle }

  if (stremioType === "series" || (season != null && episode != null)) {
    if (season == null || episode == null || !Number.isFinite(season) || !Number.isFinite(episode)) {
      matched = "no (unrecognized episode id format)";
    } else {
      const seasonData = await fetchTmdbSeasonDetails(imdbId, season, effectiveTmdbKey, null, env, ctx);
      let ep = seasonData && seasonData.episodes ? seasonData.episodes.find((e) => e.episode_number === episode) : null;
      if (!ep && seasonData && Array.isArray(seasonData.episodes) && seasonData.episodes.length > 0) {
        ep = seasonData.episodes[episode - 1] || seasonData.episodes[0];
      }
      if (!ep) {
        matched = "no (could not look up this episode on TMDB)";
      } else {
        const showDetails = await fetchTmdbItemDetails(imdbId, effectiveTmdbKey, "series", "", false, env, ctx).catch(() => null);
        const showGenres = (showDetails && showDetails.genres) || [];
        const showYear = (showDetails && (showDetails.releaseYear || showDetails.year || (showDetails.releaseDate && showDetails.releaseDate.slice(0, 4)))) || null;
        ctx.waitUntil(recordPlaybackTelemetry(env, "episode", showGenres, showYear));
        if (showDetails && showDetails.title) {
          ctx.waitUntil(recordTrackedEvent(env, "watched", imdbId, showDetails.title, "series"));
        }
        const epIdStr = String(ep.id || `${imdbId}:${season}:${episode}`);
        recordEpisode = {
          epIdStr,
          showTitle: (showDetails && showDetails.title) || imdbId,
          episodeEntry: {
            id: epIdStr,
            type: "episode",
            name: ep.name || ("Episode " + episode),
            poster: ep.still_path ? (ep.still_path.startsWith("http") ? ep.still_path : "https://image.tmdb.org/t/p/w500" + ep.still_path) : ((showDetails && showDetails.poster) || ""),
            showId: imdbId,
            showTitle: (showDetails && showDetails.title) || "",
            showPoster: (showDetails && showDetails.poster) || "",
            seasonNum: season,
            episodeNum: episode,
          },
        };
      }
    }
  } else if (stremioType === "movie") {
    const details = await fetchTmdbItemDetails(imdbId, effectiveTmdbKey, "movie", "", false, env, ctx).catch(() => null);
    const movieGenres = (details && details.genres) || [];
    const movieYear = (details && (details.releaseYear || details.year || (details.releaseDate && details.releaseDate.slice(0, 4)))) || null;
    ctx.waitUntil(recordPlaybackTelemetry(env, "movie", movieGenres, movieYear));
    if (details && details.title) {
      ctx.waitUntil(recordTrackedEvent(env, "watched", imdbId, details.title, "movie"));
    }
    const movieTitle = (details && details.title) || imdbId;
    recordMovie = {
      movieId: imdbId,
      movieTitle,
      movieEntry: {
        id: imdbId,
        type: "movie",
        name: movieTitle,
        poster: (details && details.poster) || "",
      },
    };
  } else {
    matched = "no (unrecognized id format)";
  }

  return { matched, recordEpisode, recordMovie };
}

// The read-modify-write of the account's tracking blob, retried a bounded number of times.
async function writeSubtitlesPlayRecord(env, { auth, syncKey, imdbId, season, episode, effectiveTmdbKey, recordEpisode, recordMovie }) {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let blob = null;
    if (env.DB) {
      blob = await readCreatorTrackingD1(env, auth.username);
    }
    const raw = await env.CONFIGS.get(syncKey);
    if (!blob && raw) {
      try {
        blob = JSON.parse(raw);
      } catch {
        blob = null;
      }
    }
    if (!blob || typeof blob !== "object") {
      blob = { watchHistory: [], continueWatching: [], fullyWatchedShowIds: [], dismissedContinueWatching: {}, trackPlayback: false };
    }
    // This whole record is written back below, Watchlist included --
    // see ensureTrackingWatchlist for why it has to be put back first.
    await ensureTrackingWatchlist(env, auth.username, blob);
    blob.watchHistory = Array.isArray(blob.watchHistory) ? blob.watchHistory : [];
    blob.continueWatching = Array.isArray(blob.continueWatching) ? blob.continueWatching : [];
    blob.fullyWatchedShowIds = Array.isArray(blob.fullyWatchedShowIds) ? blob.fullyWatchedShowIds : [];
    blob.dismissedContinueWatching = blob.dismissedContinueWatching && typeof blob.dismissedContinueWatching === "object" ? blob.dismissedContinueWatching : {};
    blob.watchlist = Array.isArray(blob.watchlist) ? blob.watchlist : [];

    const beforeWrite = raw || "";

    if (recordEpisode) {
      await applyEpisodePlayToBlob(blob, recordEpisode, imdbId, season, episode, effectiveTmdbKey, env);
    } else if (recordMovie) {
      const { movieId, movieEntry } = recordMovie;
      blob.watchHistory = blob.watchHistory.filter((it) => String(it.id) !== movieId);
      blob.watchHistory.unshift({ ...movieEntry, watchedAt: Date.now() });
    }

    if (blob.watchlist.length) {
      blob.watchlist = blob.watchlist.filter((it) => it && String(it.id || it.imdbId) !== imdbId && String(it.showId || '') !== imdbId);
    }

    blob.updatedAt = Date.now();
    const serializedBlob = JSON.stringify(blob);

    // Verify nothing else wrote to this key between our read and
    // now before committing -- if it changed, another ping (or
    // the client's own autosave) won the race for this attempt,
    // so retry against a fresh read rather than clobber it.
    const stillCurrent = await env.CONFIGS.get(syncKey);
    if ((stillCurrent || "") !== beforeWrite && attempt < MAX_ATTEMPTS - 1) {
      continue;
    }
    await env.CONFIGS.put(syncKey, serializedBlob);
    if (env.DB) {
      await saveCreatorTrackingD1(env, auth.username, blob, false);
    }
    // And the activity database (P3c-4, 38_activity-scrobble.js):
    // the entry just put first in Watch History is this play.
    await recordActivityPlay(env, auth.username, activityPlayFromLegacyEntry(blob.watchHistory[0]), "ping");

    await writeSubtitlesScrobbleQueue(env, auth, blob, recordEpisode, recordMovie);

    break;
  }
}

// Put an episode play into the blob's Watch History and recompute that show's Continue Watching.
async function applyEpisodePlayToBlob(blob, recordEpisode, imdbId, season, episode, effectiveTmdbKey, env) {
  const { epIdStr, episodeEntry } = recordEpisode;
  blob.watchHistory = blob.watchHistory.filter((it) => !(String(it.id) === epIdStr || (it.showId === imdbId && it.seasonNum === season && it.episodeNum === episode)));
  blob.watchHistory.unshift({ ...episodeEntry, watchedAt: Date.now() });
  // Recompute this show's Continue Watching the same way the
  // cron does (checkForNewEpisodes, 07_source-fetchers-tmdb-
  // simkl.js) -- if this ping's episode happens to be the
  // latest watched one, this naturally finds and queues
  // whatever airs next.
  const oldCwItems = blob.continueWatching.filter((it) => it.showId === imdbId);
  blob.continueWatching = blob.continueWatching.filter((it) => it.showId !== imdbId);
  const watchedEps = blob.watchHistory.filter((it) => it.type === "episode" && it.showId === imdbId && it.seasonNum != null && it.episodeNum != null);
  if (watchedEps.length) {
    const latest = watchedEps.reduce((best, e) => {
      const eS = Number(e.seasonNum);
      const eE = Number(e.episodeNum);
      const bS = Number(best.seasonNum);
      const bE = Number(best.episodeNum);
      if (eS > bS) return e;
      if (eS === bS && eE > bE) return e;
      return best;
    }, watchedEps[0]);
    const dismissed = blob.dismissedContinueWatching[imdbId];
    const stillDismissed = !!(dismissed && dismissed.seasonNum === latest.seasonNum && dismissed.episodeNum === latest.episodeNum);
    if (!stillDismissed) {
      const next = await findNextAiredEpisodeForShow(imdbId, latest.seasonNum, latest.episodeNum, effectiveTmdbKey, env).catch(() => null);
      if (next) {
        blob.continueWatching.unshift({
          id: String(next.episode.id),
          type: "episode",
          name: next.episode.name,
          // Show poster, not episode still -- see the matching
          // comment on the cron's own continueWatching.unshift.
          poster: latest.showPoster || "",
          showId: imdbId,
          showTitle: latest.showTitle || "",
          showPoster: latest.showPoster || "",
          seasonNum: next.seasonNum,
          episodeNum: next.episode.episode_number,
        });
        blob.fullyWatchedShowIds = blob.fullyWatchedShowIds.filter((s) => s !== imdbId);
      } else if (!blob.fullyWatchedShowIds.includes(imdbId)) {
        // TMDB either had no next episode (show is finished) OR the fetch failed (rate limit/timeout).
        // If it was a network failure, we don't want to completely lose the show from Continue Watching,
        // so we restore the old state just in case -- but only entries still ahead of what was just
        // watched (cwEntriesStillAhead). Otherwise the show is marked fully watched, and the episode
        // sweep adds the next episode when it airs.
        const stillAhead = cwEntriesStillAhead(oldCwItems, latest.seasonNum, latest.episodeNum);
        if (stillAhead.length > 0) {
          blob.continueWatching = [...stillAhead, ...blob.continueWatching];
        } else {
          blob.fullyWatchedShowIds.push(imdbId);
        }
      }
    }
  }
}

// The small dedicated scrobble-queue copy of a play (see the comment inside).
async function writeSubtitlesScrobbleQueue(env, auth, blob, recordEpisode, recordMovie) {
  // Also write a tiny dedicated scrobble-queue key.
  // Cloudflare KV is eventually consistent -- a write from one edge
  // location (where Nuvio's request lands) can take up to 60 seconds
  // to be readable from another edge (where the browser's save-tracking
  // or load request lands). By writing the just-scrobbled items to a
  // second, separate small key, save-tracking and load can always merge
  // from it as an independent read that's unaffected by the big blob's
  // propagation lag. Keep only the most recent 20 items to stay tiny.
  try {
    const queueKey = `creatorscrobblequeue:${auth.username}`;
    const queueRaw = await env.CONFIGS.get(queueKey);
    let qObj = { watchHistory: [], continueWatching: [] };
    if (queueRaw) {
      try {
        const parsed = JSON.parse(queueRaw);
        if (Array.isArray(parsed)) {
          qObj.watchHistory = parsed;
        } else if (parsed && typeof parsed === "object") {
          qObj.watchHistory = Array.isArray(parsed.watchHistory) ? parsed.watchHistory : [];
          qObj.continueWatching = Array.isArray(parsed.continueWatching) ? parsed.continueWatching : [];
        }
      } catch {}
    }
    if (recordEpisode) {
      const { epIdStr, episodeEntry } = recordEpisode;
      qObj.watchHistory = qObj.watchHistory.filter((it) => it && String(it.id) !== epIdStr);
      qObj.watchHistory.unshift({ ...episodeEntry, watchedAt: Date.now() });
    } else if (recordMovie) {
      const { movieId, movieEntry } = recordMovie;
      qObj.watchHistory = qObj.watchHistory.filter((it) => it && String(it.id) !== movieId);
      qObj.watchHistory.unshift({ ...movieEntry, watchedAt: Date.now() });
    }
    if (blob.continueWatching && blob.continueWatching.length > 0) {
      const latestCw = blob.continueWatching[0];
      qObj.continueWatching = qObj.continueWatching.filter((it) => it && String(it.showId || it.id) !== String(latestCw.showId || latestCw.id));
      qObj.continueWatching.unshift(latestCw);
    }
    qObj.watchHistory = qObj.watchHistory.slice(0, 20);
    qObj.continueWatching = qObj.continueWatching.slice(0, 20);
    // The record version this queue is a copy of -- see
    // 56_scrobble-queue.js for why readers need it.
    qObj.recordUpdatedAt = blob.updatedAt;
    await env.CONFIGS.put(queueKey, JSON.stringify(qObj));
  } catch {}
}

function detectClientApp(request) {
  if (!request) return "Streaming App";
  const ua = (request.headers.get("user-agent") || "").toLowerCase();
  const referer = (request.headers.get("referer") || "").toLowerCase();
  const origin = (request.headers.get("origin") || "").toLowerCase();
  const appHeader = (request.headers.get("x-app-name") || request.headers.get("x-client-name") || request.headers.get("x-application") || "").toLowerCase();

  if (appHeader.includes("nuvio") || ua.includes("nuvio") || referer.includes("nuvio") || origin.includes("nuvio")) {
    return "Nuvio";
  }
  if (appHeader.includes("stremio") || ua.includes("stremio") || referer.includes("stremio") || origin.includes("stremio") || ua.includes("smarttv") || ua.includes("stremio-streaming-server")) {
    return "Stremio";
  }
  if (appHeader.includes("wako") || ua.includes("wako") || referer.includes("wako") || origin.includes("wako")) {
    return "Wako";
  }
  if (ua.includes("dart") || ua.includes("flutter")) {
    return "Nuvio";
  }
  if (ua.includes("cfnetwork") || (ua.includes("darwin") && !ua.includes("stremio"))) {
    return "Wako / iOS Player";
  }
  if (ua.includes("okhttp") && !ua.includes("stremio")) {
    return "Nuvio";
  }
  return "Streaming App";
}
