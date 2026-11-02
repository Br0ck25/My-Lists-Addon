// Media server webhook (Plex, Jellyfin, Emby) behind /api/scrobble, moved out of handleFetch (CQ-01).

// Moved unchanged: it captured nothing from handleFetch except its own four
// parameters, so only a one-line handleMediaServerScrobble wrapper stays there.
// Split into helpers only for the 150-line limit; each helper is a block of the
// original in the same order, and the values a later block read from an earlier
// one are returned and passed on. The filter block stays in this function,
// because it reads the ids and flags parsed above.

// Handles incoming webhooks from Plex, Jellyfin, and Emby media servers
// Automatically marks watched episodes/movies and advances Continue Watching
async function handleMediaServerScrobbleFor(request, url, env, ctx) {
  if (!env || !env.CONFIGS) {
    return json({ ok: false, error: "Cloudflare KV storage (CONFIGS) not configured." }, 500);
  }

  const authed = await authenticateScrobbleRequest(url, env);
  if (authed.response) return authed.response;
  const { authUser, authForm, effectiveTmdbKey } = authed;

  const payload = await parseScrobblePayload(request);
  if (!payload || typeof payload !== "object") {
    return json({ ok: false, error: "Invalid payload format. Expected JSON or multipart form." }, 400);
  }

  // 3. Detect Media Server Type & Event
  let { server, eventType, mediaType, mediaServerUser, imdbId, tmdbId, title, showTitle, season, episode, isPlayed, plexEpisodeImdbId, plexEpisodeTvdbId, plexShowTvdbId } = detectMediaServerPayload(payload);

  // 4a. Record this username in the seen-users list
  if (mediaServerUser) {
    await recordScrobbleSeenUser(env, ctx, authUser, server, mediaServerUser);
  }

  // 4b. Apply user filter (URL param first, fallback to user's saved account settings in KV)
  const { filterEnabled, allowedUsersParam, blockAnon } = await loadScrobbleFilterSettings(url, env, authUser);

  // P7-6: Record scrobble auth form usage metrics in Analytics Engine
  try {
    if (env && env.ANALYTICS && typeof env.ANALYTICS.writeDataPoint === "function") {
      env.ANALYTICS.writeDataPoint({
        blobs: ["scrobble_auth", authForm || "unknown", server || "unknown"],
        doubles: [1],
        indexes: ["scrobble_auth"],
      });
    }
  } catch {}

  if (filterEnabled) {
    // Same formula as pingId below, from the ids the payload carried (TMDB lookup has not run yet).
    const filterPingId = mediaType === "series" ? `${imdbId || tmdbId}:${season || 1}:${episode || 1}` : (imdbId || tmdbId || title);
    const allowed = allowedUsersParam.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!mediaServerUser) {
      if (blockAnon || allowed.length > 0) {
        const ignoredMsg = "No username in payload and user filtering is active.";
        const diagnosticsKey = `creatortrack:${authUser}`;
        await env.CONFIGS.put(diagnosticsKey, JSON.stringify({
          lastPingAt: Date.now(),
          lastPingId: filterPingId || "unknown",
          lastServer: server,
          lastUser: null,
          matched: `ignored (${ignoredMsg})`,
          lastAuthForm: authForm || null,
          legacyAuthForm: authForm === "st" ? null : (authForm || null),
        }));
        return json({ ok: true, ignored: ignoredMsg });
      }
    } else if (!allowed.includes(mediaServerUser.toLowerCase())) {
      const ignoredMsg = `User '${mediaServerUser}' is not in the allowed list.`;
      const diagnosticsKey = `creatortrack:${authUser}`;
      await env.CONFIGS.put(diagnosticsKey, JSON.stringify({
        lastPingAt: Date.now(),
        lastPingId: filterPingId || mediaServerUser,
        lastServer: server,
        lastUser: mediaServerUser,
        matched: `ignored (${ignoredMsg})`,
        lastAuthForm: authForm || null,
        legacyAuthForm: authForm === "st" ? null : (authForm || null),
      }));
      return json({ ok: true, ignored: ignoredMsg });
    }
  }

  if (!isPlayed) {
    return json({ ok: true, ignored: `Event '${eventType}' is not a scrobble/play event.` });
  }

  // 4. Resolve IDs via TMDB if needed
  const resolvedIds = await resolveScrobbleIds(mediaType, imdbId, tmdbId, showTitle, title, plexShowTvdbId, plexEpisodeImdbId, plexEpisodeTvdbId, effectiveTmdbKey);
  imdbId = resolvedIds.imdbId;
  tmdbId = resolvedIds.tmdbId;
  const searchFoundPoster = resolvedIds.searchFoundPoster;

  const pingId = mediaType === "series" ? `${imdbId || tmdbId}:${season || 1}:${episode || 1}` : (imdbId || tmdbId || title);

  // 5. Execute Watch Record
  let matched = "no";
  try {
    matched = await recordScrobblePlay(env, ctx, authUser, server, mediaType, title, showTitle, season, episode, imdbId, tmdbId, searchFoundPoster, effectiveTmdbKey);
  } catch (err) {
    matched = `error (${server}): ` + (err && err.message ? err.message : String(err));
  }

  // Update diagnostics
  const diagnosticsKey = `creatortrack:${authUser}`;
  await env.CONFIGS.put(diagnosticsKey, JSON.stringify({
    lastPingAt: Date.now(),
    lastPingId: pingId,
    lastServer: server,
    lastUser: mediaServerUser || null,
    matched: matched,
    lastAuthForm: authForm || null,
    legacyAuthForm: authForm === "st" ? null : (authForm || null),
  }));

  return json({
    ok: true,
    server: server,
    user: mediaServerUser || null,
    event: eventType,
    matched: matched,
  });
}

// Steps 1 of the webhook: who is calling. Returns { response } to answer straight away, or the account.
async function authenticateScrobbleRequest(url, env) {
  const configParam = url.searchParams.get("config") || url.searchParams.get("token") || "";
  const queryCreator = url.searchParams.get("creator") || url.searchParams.get("user") || "";
  const queryKey = url.searchParams.get("key") || "";
  // The preferred credential for this endpoint: a revocable token that
  // authorises recording playback for one account and nothing else. A
  // webhook URL necessarily carries its credential in the query string
  // (Plex/Jellyfin/Emby accept a URL and nothing else), where it lands in
  // the media server's config and logs -- so what it carries should not
  // be the Creator Key. See getOrCreateScrobbleToken.
  const scrobbleToken = url.searchParams.get("st") || "";

  let authUser = null;
  let effectiveTmdbKey = TMDB_API_KEY;
  let authForm = "";

  if (scrobbleToken) {
    const tokenUser = await usernameForScrobbleToken(env, scrobbleToken);
    // An account in the middle of deletion has a tombstone before its token
    // is purged. The key and config forms below already check it; without
    // this a ping in that window wrote tracking the purge then had to
    // chase (audit AUTH-003).
    if (tokenUser && !(await isCreatorTombstoned(env, tokenUser))) {
      authUser = tokenUser;
      authForm = "st";
    }
  }

  // The old forms -- the Account Key in the query string (?creator=&key=)
  // and an install link (?config=, alias ?token=) -- were retired on
  // 2026-11-02 (docs/DECISIONS.md D-36). They are refused whatever the
  // Worker's variables say, and before anything is verified: the key is
  // not checked, so a request still carrying one learns nothing from the
  // answer. A URL that also has a working ?st= token is served by it.
  if (!authUser && (configParam || queryCreator || queryKey)) {
    return { response: json({
      ok: false,
      error: "Legacy scrobble authentication (?config= and ?creator=&key=) has been sunset. Please update your media server webhook URL in Settings to use the '?st=' token.",
      sunset: true,
    }, 410) };
  }

  if (!authUser) {
    return { response: json({ ok: false, error: "Unauthorized: Invalid or missing user credentials / config parameter." }, 401) };
  }
  await ensureTrackingMigrated(env, authUser);

  if (!effectiveTmdbKey && authUser && env && env.CONFIGS) {
    try {
      const rawSync = await env.CONFIGS.get(`creatorsync:${authUser}`);
      if (rawSync) {
        const syncObj = JSON.parse(rawSync);
        if (syncObj && syncObj.keys && syncObj.keys.tmdbKey) {
          effectiveTmdbKey = String(syncObj.keys.tmdbKey).trim();
        }
      }
    } catch {}
  }
  if (!effectiveTmdbKey) {
    effectiveTmdbKey = (env && env.TMDB_API_KEY) || TMDB_API_KEY || "";
  }
  return { authUser, authForm, effectiveTmdbKey };
}

// Step 2: read the Plex / Jellyfin / Emby body (JSON or multipart); null when it is neither.
async function parseScrobblePayload(request) {
  const contentType = request.headers.get("content-type") || "";
  let payload = null;

  if (contentType.includes("multipart/form-data")) {
    try {
      const formData = await request.formData();
      const rawPayload = formData.get("payload");
      if (rawPayload && typeof rawPayload === "string") {
        payload = JSON.parse(rawPayload);
      }
    } catch {}
  } else {
    try {
      payload = await request.json();
    } catch {
      try {
        const text = await request.text();
        payload = JSON.parse(text);
      } catch {}
    }
  }
  return payload;
}

// Step 3: which media server sent it, and what it says was played.
function detectMediaServerPayload(payload) {
  let server = "Media Server";
  let eventType = "";
  let mediaType = "movie"; // "movie" or "series"
  let mediaServerUser = ""; // username who triggered the event
  let imdbId = "";
  let tmdbId = "";
  let title = "";
  let showTitle = "";
  let season = null;
  let episode = null;
  let year = null;
  let isPlayed = false;
  // Plex only: an episode's OWN external ids, and a show's TheTVDB id --
  // see the Guid comment in the Plex branch.
  let plexEpisodeImdbId = "";
  let plexEpisodeTvdbId = "";
  let plexShowTvdbId = "";

  // A. Plex Webhook format
  if (payload.Metadata || payload.event) {
    server = "Plex";
    eventType = String(payload.event || "").toLowerCase();
    isPlayed = eventType === "media.scrobble" || eventType === "media.play" || eventType === "media.stop" || eventType === "media.resume";

    let pUser = (payload.Account && (payload.Account.title || payload.Account.name || payload.Account.id)) ||
                (payload.User && (payload.User.title || payload.User.name || payload.User.Name)) ||
                payload.username || payload.user_name || payload.account || "";
    if (typeof pUser !== "string" && typeof pUser !== "number") pUser = "";
    pUser = String(pUser).trim();
    if (pUser === "true" || pUser === "false" || pUser === "null" || pUser === "undefined") pUser = "";
    mediaServerUser = pUser;

    const meta = payload.Metadata || {};
    mediaType = meta.type === "episode" ? "series" : "movie";
    title = meta.title || "";
    showTitle = meta.grandparentTitle || meta.parentTitle || "";
    season = meta.parentIndex != null ? Number(meta.parentIndex) : null;
    episode = meta.index != null ? Number(meta.index) : null;
    year = meta.year || null;

    // An episode's Guid list holds the EPISODE's own ids (imdb://tt...
    // of the episode, tmdb:// of the episode), not the show's -- and with
    // Plex's current agent the show's own guid is plex://show/..., which
    // names nothing outside Plex. Taking the episode's ids as the show's
    // looked the show up by an episode id: TMDB found no show, so the
    // play was stored with no poster and no next episode. For an episode
    // only the show's guid is read as the show; the episode's imdb/tvdb
    // ids are kept aside to find the show through TMDB (below).
    const ownGuids = Array.isArray(meta.Guid) ? meta.Guid : (meta.guid ? [{ id: meta.guid }] : []);
    const guids = mediaType === "series"
      ? (meta.grandparentGuid ? [{ id: meta.grandparentGuid }] : [])
      : ownGuids;
    for (const g of guids) {
      const gid = String(g.id || "");
      if (gid.includes("imdb://tt")) {
        const m = gid.match(/tt\d+/);
        if (m && !imdbId) imdbId = m[0];
      } else if (gid.includes("tmdb://") || gid.includes("themoviedb://")) {
        // themoviedb:// is Plex's older TMDB agent.
        const m = gid.match(/(?:tmdb|themoviedb):\/\/(\d+)/);
        if (m && !tmdbId) tmdbId = m[1];
      } else if (gid.includes("tvdb://")) {
        // Plex's older TheTVDB agent: com.plexapp.agents.thetvdb://81189?lang=en
        const m = gid.match(/tvdb:\/\/(\d+)/);
        if (m && !plexShowTvdbId) plexShowTvdbId = m[1];
      } else if (gid.startsWith("tt") && !imdbId) {
        imdbId = gid;
      }
    }
    if (mediaType === "series") {
      for (const g of ownGuids) {
        const gid = String((g && g.id) || "");
        const imdbM = gid.includes("imdb://") ? gid.match(/tt\d+/) : null;
        const tvdbM = gid.startsWith("tvdb://") ? gid.match(/tvdb:\/\/(\d+)/) : null;
        if (imdbM && !plexEpisodeImdbId) plexEpisodeImdbId = imdbM[0];
        if (tvdbM && !plexEpisodeTvdbId) plexEpisodeTvdbId = tvdbM[1];
      }
    }
  }
  // B. Jellyfin Webhook format
  else if (payload.NotificationType || payload.ItemType || payload.ServerId) {
    server = "Jellyfin";
    eventType = String(payload.NotificationType || payload.Event || "").toLowerCase();
    isPlayed = eventType.includes("playback") || eventType.includes("userdata") || eventType.includes("scrobble") || payload.Played === true;

    let jUser = payload.NotificationUsername || payload.UserName || payload.Username || (payload.User && (payload.User.Name || payload.User.name)) || payload.user || "";
    if (typeof jUser !== "string" && typeof jUser !== "number") jUser = "";
    jUser = String(jUser).trim();
    if (jUser === "true" || jUser === "false" || jUser === "null" || jUser === "undefined") jUser = "";
    mediaServerUser = jUser;

    mediaType = (payload.ItemType === "Episode" || payload.SeriesName) ? "series" : "movie";
    title = payload.Name || payload.ItemName || "";
    showTitle = payload.SeriesName || "";
    season = payload.SeasonNumber != null ? Number(payload.SeasonNumber) : null;
    episode = payload.EpisodeNumber != null ? Number(payload.EpisodeNumber) : null;
    year = payload.Year || null;

    const sPIds = payload.SeriesProviderIds || (payload.Item && payload.Item.SeriesProviderIds) || {};
    const pIds = payload.ProviderIds || (payload.Item && payload.Item.ProviderIds) || {};
    imdbId = sPIds.Imdb || sPIds.imdb || payload.SeriesImdbId || pIds.Imdb || pIds.imdb || payload.Provider_imdb || "";
    tmdbId = sPIds.Tmdb || sPIds.tmdb || payload.SeriesTmdbId || pIds.Tmdb || pIds.tmdb || payload.Provider_tmdb || "";
  }
  // C. Emby Webhook format
  else if (payload.Item || (payload.Event && String(payload.Event).startsWith("playback."))) {
    server = "Emby";
    eventType = String(payload.Event || "").toLowerCase();
    isPlayed = eventType.includes("scrobble") || eventType.includes("playback.start") || eventType.includes("playback.stop") || eventType.includes("markplayed");

    let eUser = (payload.User && (payload.User.Name || payload.User.name || payload.User.Id || payload.User.id)) || payload.UserName || payload.Username || payload.user || "";
    if (typeof eUser !== "string" && typeof eUser !== "number") eUser = "";
    eUser = String(eUser).trim();
    if (eUser === "true" || eUser === "false" || eUser === "null" || eUser === "undefined") eUser = "";
    mediaServerUser = eUser;

    const item = payload.Item || payload;
    mediaType = (item.Type === "Episode" || item.SeriesName) ? "series" : "movie";
    title = item.Name || "";
    showTitle = item.SeriesName || "";
    season = item.ParentIndexNumber != null ? Number(item.ParentIndexNumber) : null;
    episode = item.IndexNumber != null ? Number(item.IndexNumber) : null;

    const sPIds = item.SeriesProviderIds || {};
    const pIds = item.ProviderIds || {};
    imdbId = sPIds.Imdb || sPIds.imdb || pIds.Imdb || pIds.imdb || "";
    tmdbId = sPIds.Tmdb || sPIds.tmdb || pIds.Tmdb || pIds.tmdb || "";
  }
  return { server, eventType, mediaType, mediaServerUser, imdbId, tmdbId, title, showTitle, season, episode, year, isPlayed, plexEpisodeImdbId, plexEpisodeTvdbId, plexShowTvdbId };
}

// Step 4a: remember this media-server username for the filter settings.
async function recordScrobbleSeenUser(env, ctx, authUser, server, mediaServerUser) {
  const recordUserTask = async () => {
    try {
      const seenKey = `scrobbleseenusers:${authUser}`;
      const raw = await env.CONFIGS.get(seenKey);
      const seen = raw ? JSON.parse(raw) : {};
      seen[mediaServerUser] = { server, lastSeen: Date.now() };
      // 90-day TTL — stale accounts from old servers quietly expire
      await env.CONFIGS.put(seenKey, JSON.stringify(seen), { expirationTtl: 60 * 60 * 24 * 90 });
    } catch {}
  };
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(recordUserTask());
  } else {
    await recordUserTask();
  }
}

// Step 4b: the user filter, from the URL first and the account's saved settings after.
async function loadScrobbleFilterSettings(url, env, authUser) {
  let filterEnabled = false;
  let allowedUsersParam = (url.searchParams.get("allowedUsers") || "").trim();
  let blockAnon = url.searchParams.get("blockAnon") === "1";

  if (url.searchParams.has("filterUsers")) {
    filterEnabled = url.searchParams.get("filterUsers") === "1";
  } else if (allowedUsersParam) {
    filterEnabled = true;
  }

  if (authUser) {
    try {
      let trackingObj = null;
      if (env.DB) {
        const metaRow = await env.DB.prepare(
          "SELECT scrobble_filter_users, scrobble_allowed_users, scrobble_block_anonymous FROM creator_tracking_meta WHERE username = ?"
        ).bind(authUser).first();
        if (metaRow) {
          trackingObj = {
            scrobbleFilterUsers: Boolean(metaRow.scrobble_filter_users),
            scrobbleAllowedUsers: metaRow.scrobble_allowed_users || "",
            scrobbleBlockAnonymous: Boolean(metaRow.scrobble_block_anonymous),
          };
        }
      }
      if (!trackingObj) {
        let trackingRaw = await env.CONFIGS.get(`creatorsynctracking:${authUser}`);
        if (!trackingRaw) {
          trackingRaw = await env.CONFIGS.get(`creatorsync:${authUser}`);
        }
        if (trackingRaw) {
          trackingObj = JSON.parse(trackingRaw);
        }
      }
      if (trackingObj) {
        if (trackingObj.scrobbleFilterUsers === true || trackingObj.scrobbleFilterUsers === "1" || trackingObj.scrobbleFilterUsers === 1) {
          filterEnabled = true;
        } else if (trackingObj.scrobbleFilterUsers === false || trackingObj.scrobbleFilterUsers === "0" || trackingObj.scrobbleFilterUsers === 0) {
          filterEnabled = false;
        } else if (trackingObj.scrobbleAllowedUsers) {
          filterEnabled = true;
        }
        if (trackingObj.scrobbleAllowedUsers !== undefined && !url.searchParams.has("allowedUsers")) {
          allowedUsersParam = String(trackingObj.scrobbleAllowedUsers || "").trim();
        }
        if (trackingObj.scrobbleBlockAnonymous && !url.searchParams.has("blockAnon")) {
          blockAnon = true;
        }
      }
    } catch {}
  }
  return { filterEnabled, allowedUsersParam, blockAnon };
}

// Step 4: find the IMDb / TMDB ids the payload did not carry.
async function resolveScrobbleIds(mediaType, imdbId, tmdbId, showTitle, title, plexShowTvdbId, plexEpisodeImdbId, plexEpisodeTvdbId, effectiveTmdbKey) {
  //
  // A Plex episode whose show has no id Plex shares (see the Guid comment
  // above): TMDB's /find turns the show's TheTVDB id, or the episode's own
  // IMDb or TheTVDB id, into the show's TMDB id -- exact, where a search
  // by the show's title can pick the wrong one of two shows with one name.
  if (mediaType === "series" && !imdbId && !tmdbId && (plexShowTvdbId || plexEpisodeImdbId || plexEpisodeTvdbId)) {
    const finds = [
      plexShowTvdbId ? { id: plexShowTvdbId, source: "tvdb_id", pick: (d) => d.tv_results && d.tv_results[0] && d.tv_results[0].id } : null,
      plexEpisodeImdbId ? { id: plexEpisodeImdbId, source: "imdb_id", pick: (d) => d.tv_episode_results && d.tv_episode_results[0] && d.tv_episode_results[0].show_id } : null,
      plexEpisodeTvdbId ? { id: plexEpisodeTvdbId, source: "tvdb_id", pick: (d) => d.tv_episode_results && d.tv_episode_results[0] && d.tv_episode_results[0].show_id } : null,
    ].filter(Boolean);
    for (const f of finds) {
      try {
        const findRes = await fetch(`https://api.themoviedb.org/3/find/${encodeURIComponent(f.id)}?api_key=${effectiveTmdbKey}&external_source=${f.source}`);
        if (!findRes.ok) continue;
        const showTmdbId = f.pick(await findRes.json());
        if (showTmdbId) {
          tmdbId = String(showTmdbId);
          break;
        }
      } catch {}
    }
  }
  if (!imdbId && tmdbId) {
    try {
      const tmdbType = mediaType === "series" ? "tv" : "movie";
      const tmdbRes = await fetch(`https://api.themoviedb.org/3/${tmdbType}/${tmdbId}?api_key=${effectiveTmdbKey}&append_to_response=external_ids`);
      if (tmdbRes.ok) {
        const d = await tmdbRes.json();
        imdbId = (d.external_ids && d.external_ids.imdb_id) || d.imdb_id || "";
      }
    } catch {}
  }

  let searchFoundPoster = "";
  if (!imdbId && (showTitle || title)) {
    try {
      let q = showTitle || title;
      if (mediaType === "series") {
        q = String(q)
          .replace(/[\s._-]+[sS]\d+[\s._-]*[eE]\d+.*$/i, "")
          .replace(/[\s._-]+\d+x\d+.*$/i, "")
          .replace(/[\s._-]+season[\s._-]*\d+.*$/i, "")
          .replace(/[\s._-]+episode[\s._-]*\d+.*$/i, "")
          .replace(/\s*\(\d{4}\).*$/, "")
          .trim();
      }
      const searchType = mediaType === "series" ? "tv" : "movie";
      const searchRes = await fetch(`https://api.themoviedb.org/3/search/${searchType}?api_key=${effectiveTmdbKey}&query=${encodeURIComponent(q)}&page=1`);
      if (searchRes.ok) {
        const sd = await searchRes.json();
        if (sd.results && sd.results.length) {
          const first = sd.results[0];
          tmdbId = String(first.id);
          if (first.poster_path) {
            searchFoundPoster = `https://image.tmdb.org/t/p/w500${first.poster_path}`;
          }
          const extRes = await fetch(`https://api.themoviedb.org/3/${searchType}/${first.id}?api_key=${effectiveTmdbKey}&append_to_response=external_ids`);
          if (extRes.ok) {
            const ed = await extRes.json();
            imdbId = (ed.external_ids && ed.external_ids.imdb_id) || ed.imdb_id || "";
          }
        }
      }
    } catch {}
  }
  return { imdbId, tmdbId, searchFoundPoster };
}

// Step 5: write the play into the account's tracking record.
async function recordScrobblePlay(env, ctx, authUser, server, mediaType, title, showTitle, season, episode, imdbId, tmdbId, searchFoundPoster, effectiveTmdbKey) {
  let matched = "no";
  const syncKey = `creatorsynctracking:${authUser}`;
  let blob = null;
  if (env.DB) {
    blob = await readCreatorTrackingD1(env, authUser);
  }
  const raw = await env.CONFIGS.get(syncKey);
  if (!blob && raw) {
    try { blob = JSON.parse(raw); } catch {}
  }
  if (!blob || typeof blob !== "object") {
    blob = { watchHistory: [], continueWatching: [], fullyWatchedShowIds: [], dismissedContinueWatching: {}, trackPlayback: true };
  }
  // Written back whole below -- see ensureTrackingWatchlist.
  await ensureTrackingWatchlist(env, authUser, blob);
  blob.watchHistory = Array.isArray(blob.watchHistory) ? blob.watchHistory : [];
  blob.continueWatching = Array.isArray(blob.continueWatching) ? blob.continueWatching : [];
  blob.fullyWatchedShowIds = Array.isArray(blob.fullyWatchedShowIds) ? blob.fullyWatchedShowIds : [];
  blob.dismissedContinueWatching = blob.dismissedContinueWatching && typeof blob.dismissedContinueWatching === "object" ? blob.dismissedContinueWatching : {};

  if (mediaType === "series") {
    const played = await recordScrobbleEpisodePlay(blob, env, ctx, server, title, showTitle, season, episode, imdbId, tmdbId, searchFoundPoster, effectiveTmdbKey);
    matched = played.matched;
    imdbId = played.imdbId;
  } else {
    const played = await recordScrobbleMoviePlay(blob, env, ctx, server, title, imdbId, tmdbId, searchFoundPoster, effectiveTmdbKey);
    matched = played.matched;
    imdbId = played.imdbId;
  }

  // Clean from watchlist if present
  if (Array.isArray(blob.watchlist)) {
    blob.watchlist = blob.watchlist.filter((it) => it && String(it.id || it.imdbId) !== imdbId && String(it.showId || "") !== imdbId);
  }

  blob.updatedAt = Date.now();
  await env.CONFIGS.put(syncKey, JSON.stringify(blob));
  if (env.DB) {
    await saveCreatorTrackingD1(env, authUser, blob, false);
  }
  // And the activity database (P3c-4, 38_activity-scrobble.js).
  if (matched.startsWith("yes")) {
    await recordActivityPlay(env, authUser, activityPlayFromLegacyEntry(blob.watchHistory[0]), "webhook");
  }

  await writeScrobbleQueueCopy(env, authUser, blob);

  return matched;
}

// The series branch of step 5.
async function recordScrobbleEpisodePlay(blob, env, ctx, server, title, showTitle, season, episode, imdbId, tmdbId, searchFoundPoster, effectiveTmdbKey) {
  const seasonNum = season != null ? season : 1;
  const episodeNum = episode != null ? episode : 1;

  let epName = title;
  let epPoster = "";
  let sTitle = showTitle || title;
  let sPoster = "";

  const cleanShowName = String(showTitle || title)
    .replace(/[\s._-]+[sS]\d+[\s._-]*[eE]\d+.*$/i, "")
    .replace(/[\s._-]+\d+x\d+.*$/i, "")
    .replace(/[\s._-]+season[\s._-]*\d+.*$/i, "")
    .replace(/[\s._-]+episode[\s._-]*\d+.*$/i, "")
    .replace(/\s*\(\d{4}\).*$/, "")
    .trim();

  const lookupShowId = imdbId || (tmdbId ? `tmdb:${tmdbId}` : "") || cleanShowName || showTitle || title;

  let epIdStr = "";
  if (lookupShowId) {
    const seasonData = await fetchTmdbSeasonDetails(lookupShowId, seasonNum, effectiveTmdbKey, tmdbId, env, ctx).catch(() => null);
    const ep = seasonData && seasonData.episodes ? seasonData.episodes.find((e) => e.episode_number === episodeNum) : null;
    if (ep) {
      epName = ep.name || title;
      epPoster = ep.still_path ? (ep.still_path.startsWith("http") ? ep.still_path : `https://image.tmdb.org/t/p/w500${ep.still_path}`) : "";
      if (ep.id) epIdStr = String(ep.id);
    }
    const showDetails = await fetchTmdbItemDetails(lookupShowId, effectiveTmdbKey, "series", "", false, env, ctx).catch(() => null);
    if (showDetails) {
      sTitle = showDetails.title || sTitle;
      sPoster = showDetails.poster || searchFoundPoster || "";
      if (!imdbId && showDetails.id && showDetails.id.startsWith("tt")) {
        imdbId = showDetails.id;
      }
      if (!tmdbId && showDetails.tmdbId) {
        tmdbId = String(showDetails.tmdbId);
      }
    }
    if (!sPoster && imdbId && imdbId.startsWith("tt")) {
      sPoster = `https://images.metahub.space/poster/medium/${imdbId}/img`;
    }
  }

  const resolvedShowId = imdbId || (tmdbId ? `tmdb:${tmdbId}` : "") || sTitle;
  const itemKey = epIdStr || `${resolvedShowId}:${seasonNum}:${episodeNum}`;
  const finalEpisodePoster = epPoster || sPoster || (imdbId && imdbId.startsWith("tt") ? `https://images.metahub.space/poster/medium/${imdbId}/img` : "");
  const finalShowPoster = sPoster || (imdbId && imdbId.startsWith("tt") ? `https://images.metahub.space/poster/medium/${imdbId}/img` : "") || epPoster;

  // Re-watching or newly watching an episode always brings it to the top of Watch History
  blob.watchHistory = blob.watchHistory.filter((it) => !((it.showId === resolvedShowId || it.showTitle === sTitle) && it.seasonNum === seasonNum && it.episodeNum === episodeNum));
  blob.watchHistory.unshift({
    id: itemKey,
    type: "episode",
    name: epName,
    poster: finalEpisodePoster,
    showId: resolvedShowId,
    showTitle: sTitle,
    showPoster: finalShowPoster,
    seasonNum: seasonNum,
    episodeNum: episodeNum,
    watchedAt: Date.now(),
  });

  // Recompute Continue Watching for this show
  const oldCwItems = blob.continueWatching.filter((it) => it.showId === resolvedShowId || (imdbId && it.showId === imdbId) || (sTitle && it.showId === sTitle));
  blob.continueWatching = blob.continueWatching.filter((it) => it.showId !== resolvedShowId && it.showId !== (imdbId || sTitle));
  if (resolvedShowId) {
    const watchedEps = blob.watchHistory.filter((it) => it.type === "episode" && (it.showId === resolvedShowId || (sTitle && it.showTitle === sTitle)) && it.seasonNum != null && it.episodeNum != null);
    let latestSeason = seasonNum;
    let latestEpisode = episodeNum;
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
      latestSeason = Number(latest.seasonNum);
      latestEpisode = Number(latest.episodeNum);
    }
    const next = await findNextAiredEpisodeForShow(resolvedShowId, latestSeason, latestEpisode, effectiveTmdbKey, env, ctx).catch(() => null);
    if (next) {
      blob.continueWatching.unshift({
        id: next.episode.id ? String(next.episode.id) : `${resolvedShowId}:${next.seasonNum}:${next.episode.episode_number}`,
        type: "episode",
        name: next.episode.name,
        poster: finalShowPoster,
        showId: resolvedShowId,
        showTitle: sTitle,
        showPoster: finalShowPoster,
        seasonNum: next.seasonNum,
        episodeNum: next.episode.episode_number,
      });
      blob.fullyWatchedShowIds = blob.fullyWatchedShowIds.filter((s) => s !== resolvedShowId && s !== imdbId);
    } else if (!blob.fullyWatchedShowIds.includes(resolvedShowId)) {
      // Only what is still ahead of the episode just watched (see the
      // ping above, and cwEntriesStillAhead).
      const stillAhead = cwEntriesStillAhead(oldCwItems, latestSeason, latestEpisode);
      if (stillAhead.length > 0) {
        blob.continueWatching = [...stillAhead, ...blob.continueWatching];
      } else {
        blob.fullyWatchedShowIds.push(resolvedShowId);
      }
    }
  }
  const matched = `yes (${server}: ${sTitle} S${seasonNum}E${episodeNum})`;
  return { matched, imdbId };
}

// The movie branch of step 5.
async function recordScrobbleMoviePlay(blob, env, ctx, server, title, imdbId, tmdbId, searchFoundPoster, effectiveTmdbKey) {
  // Movie
  let movieTitle = title;
  let moviePoster = "";
  const lookupMovieId = imdbId || (tmdbId ? `tmdb:${tmdbId}` : "") || title;
  if (lookupMovieId) {
    const details = await fetchTmdbItemDetails(lookupMovieId, effectiveTmdbKey, "movie", "", false, env, ctx).catch(() => null);
    if (details) {
      movieTitle = details.title || movieTitle;
      moviePoster = details.poster || searchFoundPoster || "";
      if (!imdbId && details.id && details.id.startsWith("tt")) {
        imdbId = details.id;
      }
      if (!tmdbId && details.tmdbId) {
        tmdbId = String(details.tmdbId);
      }
    }
    if (!moviePoster && imdbId && imdbId.startsWith("tt")) {
      moviePoster = `https://images.metahub.space/poster/medium/${imdbId}/img`;
    }
  }
  const resolvedMovieId = imdbId || (tmdbId ? `tmdb:${tmdbId}` : "") || movieTitle;
  const finalMoviePoster = moviePoster || (imdbId && imdbId.startsWith("tt") ? `https://images.metahub.space/poster/medium/${imdbId}/img` : "");

  blob.watchHistory = blob.watchHistory.filter((it) => !(String(it.id) === resolvedMovieId || String(it.id) === imdbId || it.name === movieTitle));
  blob.watchHistory.unshift({
    id: resolvedMovieId,
    type: "movie",
    name: movieTitle,
    poster: finalMoviePoster,
    watchedAt: Date.now(),
  });
  const matched = `yes (${server}: ${movieTitle})`;
  return { matched, imdbId };
}

// Also write to creatorscrobblequeue to protect against KV propagation lag.
async function writeScrobbleQueueCopy(env, authUser, blob) {
  try {
    const queueKey = `creatorscrobblequeue:${authUser}`;
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
    if (blob.watchHistory.length > 0) {
      const latestItem = blob.watchHistory[0];
      qObj.watchHistory = qObj.watchHistory.filter((it) => it && String(it.id) !== String(latestItem.id));
      qObj.watchHistory.unshift({ ...latestItem });
    }
    if (blob.continueWatching.length > 0) {
      const latestCw = blob.continueWatching[0];
      qObj.continueWatching = qObj.continueWatching.filter((it) => it && String(it.showId || it.id) !== String(latestCw.showId || latestCw.id));
      qObj.continueWatching.unshift(latestCw);
    }
    qObj.watchHistory = qObj.watchHistory.slice(0, 20);
    qObj.continueWatching = qObj.continueWatching.slice(0, 20);
    // See 56_scrobble-queue.js.
    qObj.recordUpdatedAt = blob.updatedAt;
    await env.CONFIGS.put(queueKey, JSON.stringify(qObj));
  } catch {}
}
