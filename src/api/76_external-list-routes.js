// Adding to and removing from lists on Trakt, TMDB, MDBList and Simkl, syncing watch history to them, creating and deleting their lists, and the TMDB sign-in and my-lists routes, moved out of handleFetch (CQ-01).

// Moved unchanged: each route body is now its own function; the dispatcher keeps each route's
// original path/method test and is a plain function that returns a Response promise or null.

// /api/external-list/*, /api/external-sync/history and the TMDB OAuth and my-lists routes, at their original place. Returns a Response promise, or null.
function handleExternalListRoutes(request, env, ctx, url, path) {
  if ((path === "/api/external-list/item-mutate" || path === "/api/external-list/item-add" || path === "/api/external-list/item-remove") && request.method === "POST") return apiExternalListItemMutate(request, env, path);
  if (path === "/api/external-sync/history" && request.method === "POST") return apiExternalSyncHistory(request, env);
  if (path === "/api/external-list/create" && request.method === "POST") return apiExternalListCreate(request, env);
  if (path === "/api/external-list/delete" && request.method === "POST") return apiExternalListDelete(request, env);
  if (path === "/api/tmdb/oauth/start") return apiTmdbOauthStart(env, url);
  if (path === "/api/tmdb/oauth/callback") return apiTmdbOauthCallback(request, env, url);
  if (path === "/api/tmdb-my-lists") return apiTmdbMyLists(request, env, url);
  return null;
}

// /api/external-list/item-mutate -> adds or removes items on external provider accounts (Trakt, Simkl, TMDB, MDBList)
//
// The item-add / item-remove spellings are kept deliberately. The 2026-09-08
// audit listed them as dead code (no client reference) and said so itself:
// "they are cheap aliases -- leaving them costs nothing". item-remove is not
// even a pure alias, it is the path form of `action: "remove"`. They share
// this handler's validation and limits, so keeping them adds no surface,
// while deleting a published path breaks any out-of-band caller -- which
// cannot be verified from inside the repo. Same reasoning as /api/publish-list.
async function apiExternalListItemMutate(request, env, path) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const action = (path.endsWith("/item-remove") || body.action === "remove") ? "remove" : "add";
  const provider = String(body.provider || "").toLowerCase().trim();
  const target = String(body.target || "watchlist").toLowerCase().trim(); // watchlist | favorite | history | custom | status
  const listId = body.listId || body.status || "";
  const mediaType = (body.mediaType === "series" || body.type === "series" || body.type === "tv" || body.type === "episode") ? "series" : "movie";
  const title = body.title || body.name || "";
  const year = body.year || "";
  let id = String(body.id || "").trim();
  let imdbId = String(body.imdbId || "").trim();
  let tmdbId = String(body.tmdbId || "").trim();

  let seasonNum = body.season != null ? parseInt(body.season, 10) : (body.seasonNum != null ? parseInt(body.seasonNum, 10) : null);
  let episodeNum = body.episode != null ? parseInt(body.episode, 10) : (body.episodeNum != null ? parseInt(body.episodeNum, 10) : null);

  if (id.includes(":")) {
    const parts = id.split(":");
    if (parts[0].startsWith("tt") || parts[0].startsWith("tmdb")) {
      if (!imdbId && parts[0].startsWith("tt")) imdbId = parts[0];
      if (!tmdbId && parts[0].startsWith("tmdb:")) tmdbId = parts[0].slice(5);
      if (seasonNum == null && !isNaN(parseInt(parts[1], 10))) seasonNum = parseInt(parts[1], 10);
      if (episodeNum == null && !isNaN(parseInt(parts[2], 10))) episodeNum = parseInt(parts[2], 10);
    }
  }

  if (!imdbId && id.startsWith("tt")) imdbId = id;
  if (!tmdbId && id.startsWith("tmdb:")) tmdbId = id.slice(5);

  if (imdbId.includes(":")) imdbId = imdbId.split(":")[0];
  if (tmdbId.includes(":")) tmdbId = tmdbId.split(":")[0];

  const apiKeyTmdb = TMDB_API_KEY || (env && env.TMDB_API_KEY) || body.tmdbKey || "";

  // Resolve TMDB ID or IMDb ID if missing
  if (!tmdbId && imdbId && apiKeyTmdb) {
    try {
      const findRes = await fetch(`https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?api_key=${encodeURIComponent(apiKeyTmdb)}&external_source=imdb_id`);
      if (findRes.ok) {
        const findData = await findRes.json();
        const hit = (mediaType === "series" ? (findData.tv_results && findData.tv_results[0]) : (findData.movie_results && findData.movie_results[0])) || (findData.movie_results && findData.movie_results[0]) || (findData.tv_results && findData.tv_results[0]);
        if (hit && hit.id) tmdbId = String(hit.id);
      }
    } catch {}
  }

  if (!imdbId && tmdbId && apiKeyTmdb) {
    try {
      const detRes = await fetch(`https://api.themoviedb.org/3/${mediaType === "series" ? "tv" : "movie"}/${encodeURIComponent(tmdbId)}/external_ids?api_key=${encodeURIComponent(apiKeyTmdb)}`);
      if (detRes.ok) {
        const detData = await detRes.json();
        if (detData && detData.imdb_id) imdbId = detData.imdb_id;
      }
    } catch {}
  }

  // 1. TRAKT
  if (provider === "trakt") {
    const token = body.traktAccessToken || body.token || "";
    const clientId = body.traktKey || TRAKT_CLIENT_ID || (env && env.TRAKT_CLIENT_ID) || "";
    const username = body.traktUsername || "me";
    if (!token) return json({ ok: false, error: "Please connect your Trakt account first." }, 400);

    const idsObj = {};
    if (imdbId && imdbId.startsWith("tt")) idsObj.imdb = imdbId;
    if (tmdbId && !isNaN(parseInt(tmdbId, 10))) idsObj.tmdb = parseInt(tmdbId, 10);
    if (!idsObj.imdb && !idsObj.tmdb && id) idsObj.imdb = id.split(":")[0];

    let traktPayload = {};
    if (target === "history" && mediaType === "series" && seasonNum != null && episodeNum != null) {
      traktPayload = {
        shows: [{
          ids: idsObj,
          title: title || undefined,
          seasons: [{ number: seasonNum, episodes: [{ number: episodeNum }] }],
        }],
      };
    } else {
      const mediaKey = mediaType === "series" ? "shows" : "movies";
      traktPayload = {
        [mediaKey]: [{
          ids: idsObj,
          title: title || undefined,
          year: year ? parseInt(year, 10) : undefined,
        }],
      };
    }

    let traktUrl = `https://api.trakt.tv/sync/watchlist${action === "remove" ? "/remove" : ""}`;
    if (target === "history") {
      traktUrl = `https://api.trakt.tv/sync/history${action === "remove" ? "/remove" : ""}`;
    } else if (target === "collection") {
      traktUrl = `https://api.trakt.tv/sync/collection${action === "remove" ? "/remove" : ""}`;
    } else if (target === "custom" && listId) {
      traktUrl = `https://api.trakt.tv/users/${encodeURIComponent(username)}/lists/${encodeURIComponent(listId)}/items${action === "remove" ? "/remove" : ""}`;
    }

    try {
      const tRes = await fetch(traktUrl, {
        method: "POST",
        headers: traktHeaders(token, clientId),
        body: JSON.stringify(traktPayload),
      });
      const tData = await tRes.json().catch(() => ({}));
      if (!tRes.ok) {
        return json({ ok: false, error: tData.error || `Trakt API error (HTTP ${tRes.status})` }, tRes.status);
      }
      invalidatePerUserCache("trakt", safeUserHash(token));
      return json({ ok: true, provider: "trakt", action, target, data: tData });
    } catch (err) {
      return json({ ok: false, error: safeErrorMessage(err) }, 500);
    }
  }
  return apiExternalListMutateFromSimkl(env, { body, action, provider, target, listId, mediaType, title, id, imdbId, tmdbId, seasonNum, episodeNum, apiKeyTmdb });
}

// The rest of apiExternalListItemMutate, moved unchanged: the same statements in the same order, split only for the 150-line limit.
async function apiExternalListMutateFromSimkl(env, { body, action, provider, target, listId, mediaType, title, id, imdbId, tmdbId, seasonNum, episodeNum, apiKeyTmdb }) {
  // 2. SIMKL
  if (provider === "simkl") {
    const token = body.simklAccessToken || body.token || "";
    const clientId = body.simklKey || SIMKL_CLIENT_ID || (env && env.SIMKL_CLIENT_ID) || "";
    if (!token) return json({ ok: false, error: "Please connect your Simkl account first." }, 400);

    const idsObj = {};
    if (imdbId && imdbId.startsWith("tt")) idsObj.imdb = imdbId;
    if (tmdbId && !isNaN(parseInt(tmdbId, 10))) idsObj.tmdb = parseInt(tmdbId, 10);
    if (!idsObj.imdb && !idsObj.tmdb && id) idsObj.imdb = id.split(":")[0];

    const mediaKey = mediaType === "series" ? "shows" : "movies";
    const targetStatus = target || "plantowatch";

    let simklUrl = "https://api.simkl.com/sync/add-to-list";
    let simklBody = {};

    if (target === "history") {
      simklUrl = action === "remove" ? "https://api.simkl.com/sync/history/remove" : "https://api.simkl.com/sync/history";
      if (mediaType === "series" && seasonNum != null && episodeNum != null) {
        simklBody = {
          shows: [{
            ids: idsObj,
            title: title || undefined,
            seasons: [{ number: seasonNum, episodes: [{ number: episodeNum }] }],
          }],
        };
      } else if (mediaType === "series") {
        simklBody = {
          shows: [{
            ids: idsObj,
            title: title || undefined,
          }],
        };
      } else {
        simklBody = {
          movies: [{
            ids: idsObj,
            title: title || undefined,
          }],
        };
      }
    } else if (action === "remove") {
      simklUrl = "https://api.simkl.com/sync/remove-from-list";
      simklBody = {
        [mediaKey]: [{
          ids: idsObj,
          title: title || undefined,
        }],
      };
    } else {
      simklBody = {
        [mediaKey]: [{
          ids: idsObj,
          to: targetStatus,
        }],
      };
    }

    try {
      const sRes = await fetch(simklUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
          "simkl-api-key": clientId,
          "User-Agent": `my-list-addon/${ADDON_VERSION}`,
        },
        body: JSON.stringify(simklBody),
      });
      const sData = await sRes.json().catch(() => ({}));
      if (!sRes.ok) {
        return json({ ok: false, error: sData.error || `Simkl API error (HTTP ${sRes.status})` }, sRes.status);
      }
      invalidatePerUserCache("simkl", safeUserHash(token));
      return json({ ok: true, provider: "simkl", action, target: targetStatus, data: sData });
    } catch (err) {
      return json({ ok: false, error: safeErrorMessage(err) }, 500);
    }
  }
  return apiExternalListMutateFromTmdb({ body, action, provider, target, listId, mediaType, id, imdbId, tmdbId, seasonNum, episodeNum, apiKeyTmdb });
}

// The rest of apiExternalListItemMutate, moved unchanged: the same statements in the same order, split only for the 150-line limit.
async function apiExternalListMutateFromTmdb({ body, action, provider, target, listId, mediaType, id, imdbId, tmdbId, seasonNum, episodeNum, apiKeyTmdb }) {
  // 3. TMDB
  if (provider === "tmdb") {
    const apiKey = apiKeyTmdb;
    const sessionId = body.tmdbSessionId || body.sessionId || "";
    const accountId = body.tmdbAccountId || "null";
    const v4Token = body.tmdbAccessToken || "";
    if (!apiKey) return json({ ok: false, error: "TMDB API Key missing." }, 400);
    if (!sessionId && !v4Token) return json({ ok: false, error: "Please connect your TMDB account first." }, 400);
    if (!tmdbId) return json({ ok: false, error: "Could not find a valid TMDB media ID for this title." }, 400);

    const tmdbType = mediaType === "series" ? "tv" : "movie";
    const numId = parseInt(tmdbId, 10);

    if (target === "watchlist") {
      const wUrl = `https://api.themoviedb.org/3/account/${encodeURIComponent(accountId)}/watchlist?api_key=${encodeURIComponent(apiKey)}${sessionId ? `&session_id=${encodeURIComponent(sessionId)}` : ""}`;
      try {
        const tmdbRes = await fetch(wUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(v4Token ? { "Authorization": `Bearer ${v4Token}` } : {}),
            "User-Agent": `my-list-addon/${ADDON_VERSION}`,
          },
          body: JSON.stringify({ media_type: tmdbType, media_id: numId, watchlist: (action === "add") }),
        });
        const tmdbData = await tmdbRes.json().catch(() => ({}));
        if (!tmdbRes.ok || (tmdbData.success === false)) {
          return json({ ok: false, error: tmdbData.status_message || `TMDB error (HTTP ${tmdbRes.status})` }, tmdbRes.status);
        }
        invalidatePerUserCache("tmdb", safeUserHash(sessionId || v4Token));
        return json({ ok: true, provider: "tmdb", action, target: "watchlist", data: tmdbData });
      } catch (err) {
        return json({ ok: false, error: safeErrorMessage(err) }, 500);
      }
    }

    if (target === "favorite") {
      const fUrl = `https://api.themoviedb.org/3/account/${encodeURIComponent(accountId)}/favorite?api_key=${encodeURIComponent(apiKey)}${sessionId ? `&session_id=${encodeURIComponent(sessionId)}` : ""}`;
      try {
        const tmdbRes = await fetch(fUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(v4Token ? { "Authorization": `Bearer ${v4Token}` } : {}),
            "User-Agent": `my-list-addon/${ADDON_VERSION}`,
          },
          body: JSON.stringify({ media_type: tmdbType, media_id: numId, favorite: (action === "add") }),
        });
        const tmdbData = await tmdbRes.json().catch(() => ({}));
        if (!tmdbRes.ok || (tmdbData.success === false)) {
          return json({ ok: false, error: tmdbData.status_message || `TMDB error (HTTP ${tmdbRes.status})` }, tmdbRes.status);
        }
        invalidatePerUserCache("tmdb", safeUserHash(sessionId || v4Token));
        return json({ ok: true, provider: "tmdb", action, target: "favorite", data: tmdbData });
      } catch (err) {
        return json({ ok: false, error: safeErrorMessage(err) }, 500);
      }
    }

    if (target === "custom" && listId) {
      const lUrl = `https://api.themoviedb.org/3/list/${encodeURIComponent(listId)}/${action === "add" ? "add_item" : "remove_item"}?api_key=${encodeURIComponent(apiKey)}${sessionId ? `&session_id=${encodeURIComponent(sessionId)}` : ""}`;
      try {
        const tmdbRes = await fetch(lUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(v4Token ? { "Authorization": `Bearer ${v4Token}` } : {}),
            "User-Agent": `my-list-addon/${ADDON_VERSION}`,
          },
          body: JSON.stringify({ media_id: numId }),
        });
        const tmdbData = await tmdbRes.json().catch(() => ({}));
        if (!tmdbRes.ok || (tmdbData.success === false)) {
          return json({ ok: false, error: tmdbData.status_message || `TMDB error (HTTP ${tmdbRes.status})` }, tmdbRes.status);
        }
        invalidatePerUserCache("tmdb", safeUserHash(sessionId || v4Token));
        return json({ ok: true, provider: "tmdb", action, target: "custom", listId, data: tmdbData });
      } catch (err) {
        return json({ ok: false, error: safeErrorMessage(err) }, 500);
      }
    }
  }

  // 4. MDBLIST
  if (provider === "mdblist") {
    const accessToken = String(body.mdblistAccessToken || "").trim();
    const apiKey = (body.mdblistKey || body.apikey || body.token || "").trim();
    const token = accessToken || apiKey;
    if (!token) return json({ ok: false, error: "Please connect your MDBList account or API key first." }, 400);

    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": `my-list-addon/${ADDON_VERSION}`,
    };
    const authParam = accessToken ? "" : `?apikey=${encodeURIComponent(apiKey || token)}`;
    if (accessToken) {
      headers["Authorization"] = `Bearer ${accessToken}`;
    } else if (apiKey) {
      headers["x-api-key"] = apiKey;
    }

    let cleanId = String(imdbId || id || "").trim();
    while (cleanId.startsWith("tmdb:")) cleanId = cleanId.slice(5).trim();
    const cleanImdb = cleanId.startsWith("tt") ? cleanId : (imdbId && imdbId.startsWith("tt") ? imdbId : null);
    const numTmdb = tmdbId ? parseInt(tmdbId, 10) : (!cleanId.startsWith("tt") && /^\d+$/.test(cleanId) ? parseInt(cleanId, 10) : null);
    const bestId = cleanImdb || numTmdb || cleanId;
    const isMovie = mediaType === "movie" || body.type === "movie";
    const mdbType = isMovie ? "movie" : "show";

    const idsObj = {};
    if (cleanImdb) idsObj.imdb = cleanImdb;
    if (numTmdb) idsObj.tmdb = numTmdb;
    if (bestId) idsObj.id = bestId;

    if (target === "watchlist") {
      return apiExternalListMutateMdblistWatchlist({ action, token, headers, authParam, cleanImdb, numTmdb, bestId, isMovie, mdbType, idsObj });
    }

    const isHistoryTarget = target === "history" || (target === "custom" && String(listId || "").toLowerCase().includes("history"));
    if (isHistoryTarget) {
      return apiExternalListMutateMdblistHistory({ action, seasonNum, episodeNum, token, headers, authParam, cleanImdb, numTmdb, bestId, isMovie, mdbType, idsObj });
    }

    if (target === "custom" && listId) {
      return apiExternalListMutateMdblistCustom({ action, listId, token, headers, authParam, cleanImdb, numTmdb, bestId, isMovie, mdbType, idsObj });
    }
  }

  return json({ ok: false, error: "Unsupported provider or target." }, 400);
}

// A branch of apiExternalListItemMutate, moved unchanged: its body, split out only for the 150-line limit.
async function apiExternalListMutateMdblistWatchlist({ action, token, headers, authParam, cleanImdb, numTmdb, bestId, isMovie, mdbType, idsObj }) {
  const endpoints = [
    `https://api.mdblist.com/watchlist/items/${action === "add" ? "add" : "remove"}${authParam}`,
    `https://api.mdblist.com/watchlist/${action === "add" ? "add" : "remove"}${authParam}`,
  ];
  const payload = {
    id: bestId,
    imdb: cleanImdb,
    tmdb: numTmdb,
    mediatype: mdbType,
    movies: isMovie ? [idsObj] : [],
    shows: !isMovie ? [idsObj] : [],
  };
  let success = false;
  let lastErr = null;
  let mData = {};
  for (const mUrl of endpoints) {
    try {
      const mRes = await fetch(mUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      mData = await mRes.json().catch(() => ({}));
      if (mRes.ok) {
        success = true;
        break;
      } else {
        lastErr = mData.error || `MDBList error (HTTP ${mRes.status})`;
      }
    } catch (err) {
      lastErr = safeErrorMessage(err);
    }
  }
  if (!success) {
    return json({ ok: false, error: lastErr || "Failed to update MDBList watchlist." }, 400);
  }
  invalidatePerUserCache("mdblist", safeUserHash(token));
  return json({ ok: true, provider: "mdblist", action, target: "watchlist", data: mData });
}

// A branch of apiExternalListItemMutate, moved unchanged: its body, split out only for the 150-line limit.
async function apiExternalListMutateMdblistHistory({ action, seasonNum, episodeNum, token, headers, authParam, cleanImdb, numTmdb, bestId, isMovie, mdbType, idsObj }) {
  const itemObj = Object.assign({}, idsObj);
  if (action === "remove") {
    itemObj.watched_at = null;
  }
  if (!isMovie && seasonNum != null && episodeNum != null) {
    itemObj.seasons = [{
      number: seasonNum,
      episodes: [{
        number: episodeNum,
        ...(action === "remove" ? { watched_at: null } : {})
      }]
    }];
  }
  const payload = isMovie ? { movies: [itemObj] } : { shows: [itemObj] };
  const mdbEndpoints = action === "remove"
    ? [
        `https://api.mdblist.com/sync/watched/remove${authParam}`,
        `https://api.mdblist.com/sync/watched${authParam}`,
        `https://api.mdblist.com/sync/watched/${authParam}`,
      ]
    : [
        `https://api.mdblist.com/sync/watched${authParam}`,
        `https://api.mdblist.com/sync/watched/${authParam}`,
      ];

  let success = false;
  let lastErr = null;
  let mData = {};

  for (const mUrl of mdbEndpoints) {
    try {
      const mRes = await fetch(mUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      mData = await mRes.json().catch(() => ({}));
      if (mRes.ok) {
        success = true;
        break;
      } else if (mRes.status !== 404 && mRes.status !== 405) {
        lastErr = mData.error || mData.message || `MDBList error (HTTP ${mRes.status})`;
      }
    } catch (err) {
      lastErr = safeErrorMessage(err);
    }
  }

  if (!success && action === "remove") {
    try {
      const singleUrl = `https://api.mdblist.com/history/remove${authParam}`;
      const sRes = await fetch(singleUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          id: bestId,
          imdb: cleanImdb,
          tmdb: numTmdb,
          mediatype: mdbType,
        }),
      });
      const sData = await sRes.json().catch(() => ({}));
      if (sRes.ok) {
        success = true;
        mData = sData;
      } else if (sRes.status !== 404 && sRes.status !== 405) {
        lastErr = sData.error || sData.message || lastErr;
      }
    } catch {}
  }

  if (!success) {
    return json({ ok: false, error: lastErr || "Failed to update MDBList watch history." }, 400);
  }

  invalidatePerUserCache("mdblist", safeUserHash(token));
  return json({ ok: true, provider: "mdblist", action, target: "history", data: mData });
}

// A branch of apiExternalListItemMutate, moved unchanged: its body, split out only for the 150-line limit.
async function apiExternalListMutateMdblistCustom({ action, listId, token, headers, authParam, cleanImdb, numTmdb, bestId, isMovie, mdbType, idsObj }) {
  const endpoints = [
    `https://api.mdblist.com/lists/${encodeURIComponent(listId)}/items/${action === "add" ? "add" : "remove"}${authParam}`,
    `https://api.mdblist.com/lists/${encodeURIComponent(listId)}/${action === "add" ? "add" : "remove"}${authParam}`,
  ];
  const payload = {
    id: bestId,
    imdb: cleanImdb,
    tmdb: numTmdb,
    mediatype: mdbType,
    movies: isMovie ? [idsObj] : [],
    shows: !isMovie ? [idsObj] : [],
  };
  let success = false;
  let lastErr = null;
  let mData = {};
  for (const mUrl of endpoints) {
    try {
      const mRes = await fetch(mUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      mData = await mRes.json().catch(() => ({}));
      if (mRes.ok) {
        success = true;
        break;
      } else {
        lastErr = mData.error || `MDBList error (HTTP ${mRes.status})`;
      }
    } catch (err) {
      lastErr = safeErrorMessage(err);
    }
  }
  if (!success) {
    return json({ ok: false, error: lastErr || `MDBList error` }, 400);
  }
  invalidatePerUserCache("mdblist", safeUserHash(token));
  return json({ ok: true, provider: "mdblist", action, target: "custom", listId, data: mData });
}

// /api/external-sync/history -> bulk syncs Watch History items to Trakt, MDBList, or Simkl
async function apiExternalSyncHistory(request, env) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const provider = String(body.provider || "").toLowerCase().trim();
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) {
    return json({ ok: true, syncedCount: 0, message: "No items to sync." });
  }

  function parseWatchItem(it) {
    const isMovie = it.type === "movie" || it.kind === "movie" || it.mediaType === "movie";
    let rawId = String(it.id || "").trim();
    let showId = String(it.showId || "").trim();
    let imdbId = String(it.imdbId || "").trim();
    let tmdbId = String(it.tmdbId || "").trim();

    let parsedSeason = it.seasonNum != null ? parseInt(it.seasonNum, 10) : (it.season != null ? parseInt(it.season, 10) : null);
    let parsedEpisode = it.episodeNum != null ? parseInt(it.episodeNum, 10) : (it.episode != null ? parseInt(it.episode, 10) : (it.number != null ? parseInt(it.number, 10) : null));

    if (rawId.includes(":")) {
      const parts = rawId.split(":");
      if (parts[0].startsWith("tt") || parts[0].startsWith("tmdb")) {
        if (!showId) showId = parts[0];
        if (parsedSeason == null && !isNaN(parseInt(parts[1], 10))) parsedSeason = parseInt(parts[1], 10);
        if (parsedEpisode == null && !isNaN(parseInt(parts[2], 10))) parsedEpisode = parseInt(parts[2], 10);
      }
    }

    let cleanImdb = "";
    if (imdbId && imdbId.startsWith("tt")) cleanImdb = imdbId.split(":")[0];
    else if (showId && showId.startsWith("tt")) cleanImdb = showId.split(":")[0];
    else if (rawId.startsWith("tt")) cleanImdb = rawId.split(":")[0];

    let cleanTmdb = null;
    if (tmdbId && !isNaN(parseInt(tmdbId, 10))) cleanTmdb = parseInt(tmdbId, 10);
    else if (showId && showId.startsWith("tmdb:")) cleanTmdb = parseInt(showId.slice(5), 10);
    else if (rawId.startsWith("tmdb:")) cleanTmdb = parseInt(rawId.slice(5).split(":")[0], 10);
    else if (!isNaN(parseInt(rawId, 10))) cleanTmdb = parseInt(rawId, 10);

    const title = it.title || it.name || it.showTitle || "";
    const showTitle = it.showTitle || it.title || it.name || "";

    let watchedAtIso = "";
    if (it.watchedAt || it.watched_at || it.date) {
      try {
        const d = new Date(it.watchedAt || it.watched_at || it.date);
        if (!isNaN(d.getTime())) watchedAtIso = d.toISOString();
      } catch {}
    }

    return {
      isMovie,
      cleanImdb,
      cleanTmdb,
      title,
      showTitle,
      season: parsedSeason,
      episode: parsedEpisode,
      watchedAtIso
    };
  }
  return apiExternalSyncHistoryTrakt(env, body, provider, items, parseWatchItem);
}

// The rest of apiExternalSyncHistory, moved unchanged: the same statements in the same order, split only for the 150-line limit.
async function apiExternalSyncHistoryTrakt(env, body, provider, items, parseWatchItem) {
  // 1. TRAKT BATCH HISTORY SYNC
  if (provider === "trakt") {
    const token = body.traktAccessToken || body.token || "";
    const clientId = body.traktKey || TRAKT_CLIENT_ID || (env && env.TRAKT_CLIENT_ID) || "";
    if (!token) return json({ ok: false, error: "Please connect your Trakt account first." }, 400);

    const traktMovies = [];
    const traktShowMap = new Map();

    items.forEach((it) => {
      const p = parseWatchItem(it);
      const ids = {};
      if (p.cleanImdb) ids.imdb = p.cleanImdb;
      if (p.cleanTmdb) ids.tmdb = p.cleanTmdb;

      if (p.isMovie) {
        const movieObj = { ids, title: p.title };
        if (p.watchedAtIso) movieObj.watched_at = p.watchedAtIso;
        traktMovies.push(movieObj);
      } else {
        const showKey = p.cleanImdb || (p.cleanTmdb ? "tmdb:" + p.cleanTmdb : p.showTitle);
        if (!traktShowMap.has(showKey)) {
          traktShowMap.set(showKey, {
            ids,
            title: p.showTitle,
            seasonMap: new Map(),
          });
        }
        const showEntry = traktShowMap.get(showKey);
        const sNum = p.season || 1;
        const eNum = p.episode || 1;
        if (!showEntry.seasonMap.has(sNum)) {
          showEntry.seasonMap.set(sNum, []);
        }
        const epObj = { number: eNum };
        if (p.watchedAtIso) epObj.watched_at = p.watchedAtIso;
        showEntry.seasonMap.get(sNum).push(epObj);
      }
    });

    const traktShows = [];
    traktShowMap.forEach((showEntry) => {
      const seasons = [];
      showEntry.seasonMap.forEach((eps, sNum) => {
        seasons.push({ number: sNum, episodes: eps });
      });
      traktShows.push({
        ids: showEntry.ids,
        title: showEntry.title,
        seasons: seasons,
      });
    });

    const traktPayload = {};
    if (traktMovies.length) traktPayload.movies = traktMovies;
    if (traktShows.length) traktPayload.shows = traktShows;

    try {
      const tRes = await fetch("https://api.trakt.tv/sync/history", {
        method: "POST",
        headers: traktHeaders(token, clientId),
        body: JSON.stringify(traktPayload),
      });
      const tData = await tRes.json().catch(() => ({}));
      if (!tRes.ok) {
        return json({ ok: false, error: tData.error || `Trakt sync error (HTTP ${tRes.status})` }, tRes.status);
      }
      invalidatePerUserCache("trakt", safeUserHash(token));
      return json({ ok: true, provider: "trakt", syncedCount: items.length, data: tData });
    } catch (err) {
      return json({ ok: false, error: safeErrorMessage(err) }, 500);
    }
  }
  return apiExternalSyncHistorySimkl(env, body, provider, items, parseWatchItem);
}

// The rest of apiExternalSyncHistory, moved unchanged: the same statements in the same order, split only for the 150-line limit.
async function apiExternalSyncHistorySimkl(env, body, provider, items, parseWatchItem) {
  // 2. SIMKL BATCH HISTORY SYNC
  if (provider === "simkl") {
    const token = body.simklAccessToken || body.token || "";
    const clientId = body.simklKey || SIMKL_CLIENT_ID || (env && env.SIMKL_CLIENT_ID) || "";
    if (!token) return json({ ok: false, error: "Please connect your Simkl account first." }, 400);

    const simklMovies = [];
    const simklShowMap = new Map();

    items.forEach((it) => {
      const p = parseWatchItem(it);
      const ids = {};
      if (p.cleanImdb) ids.imdb = p.cleanImdb;
      if (p.cleanTmdb) ids.tmdb = p.cleanTmdb;

      if (p.isMovie) {
        const movieObj = { ids, title: p.title };
        if (p.watchedAtIso) movieObj.watched_at = p.watchedAtIso;
        simklMovies.push(movieObj);
      } else {
        const showKey = p.cleanImdb || (p.cleanTmdb ? "tmdb:" + p.cleanTmdb : p.showTitle);
        if (!simklShowMap.has(showKey)) {
          simklShowMap.set(showKey, {
            ids,
            title: p.showTitle,
            seasonMap: new Map(),
          });
        }
        const showEntry = simklShowMap.get(showKey);
        const sNum = p.season || 1;
        const eNum = p.episode || 1;
        if (!showEntry.seasonMap.has(sNum)) {
          showEntry.seasonMap.set(sNum, []);
        }
        const epObj = { number: eNum };
        if (p.watchedAtIso) epObj.watched_at = p.watchedAtIso;
        showEntry.seasonMap.get(sNum).push(epObj);
      }
    });

    const simklShows = [];
    simklShowMap.forEach((showEntry) => {
      const seasons = [];
      showEntry.seasonMap.forEach((eps, sNum) => {
        seasons.push({ number: sNum, episodes: eps });
      });
      simklShows.push({
        ids: showEntry.ids,
        title: showEntry.title,
        seasons: seasons,
      });
    });

    const simklPayload = {};
    if (simklMovies.length) simklPayload.movies = simklMovies;
    if (simklShows.length) simklPayload.shows = simklShows;

    try {
      const sRes = await fetch("https://api.simkl.com/sync/history", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
          "simkl-api-key": clientId,
          "User-Agent": `my-list-addon/${ADDON_VERSION}`,
        },
        body: JSON.stringify(simklPayload),
      });
      const sData = await sRes.json().catch(() => ({}));
      if (!sRes.ok) {
        return json({ ok: false, error: sData.error || `Simkl sync error (HTTP ${sRes.status})` }, sRes.status);
      }
      invalidatePerUserCache("simkl", safeUserHash(token));
      return json({ ok: true, provider: "simkl", syncedCount: items.length, data: sData });
    } catch (err) {
      return json({ ok: false, error: safeErrorMessage(err) }, 500);
    }
  }
  return apiExternalSyncHistoryMdblist(body, provider, items, parseWatchItem);
}

// The rest of apiExternalSyncHistory, moved unchanged: the same statements in the same order, split only for the 150-line limit.
async function apiExternalSyncHistoryMdblist(body, provider, items, parseWatchItem) {
  // 3. MDBLIST BATCH HISTORY SYNC
  if (provider === "mdblist") {
    const accessToken = String(body.mdblistAccessToken || "").trim();
    const apiKey = (body.mdblistKey || body.apikey || "").trim();
    const token = accessToken || apiKey || body.token || "";
    if (!token) return json({ ok: false, error: "Please connect your MDBList account or API key first." }, 400);

    const movies = [];
    const episodes = [];

    items.forEach((it) => {
      const p = parseWatchItem(it);
      const obj = {};
      if (p.cleanImdb) obj.imdb = p.cleanImdb;
      if (p.cleanTmdb) obj.tmdb = p.cleanTmdb;

      if (p.isMovie) {
        movies.push(obj);
      } else {
        episodes.push({
          ...obj,
          season: p.season || 1,
          episode: p.episode || 1,
        });
      }
    });

    const mdblistPayload = {};
    if (movies.length) mdblistPayload.movies = movies;
    if (episodes.length) mdblistPayload.episodes = episodes;

    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": `my-list-addon/${ADDON_VERSION}`,
    };
    let mUrl = "https://api.mdblist.com/sync/watched";
    if (accessToken) {
      headers["Authorization"] = `Bearer ${accessToken}`;
    } else {
      headers["x-api-key"] = apiKey;
      mUrl += `?apikey=${encodeURIComponent(apiKey)}`;
    }

    try {
      const mRes = await fetch(mUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(mdblistPayload),
      });
      const mData = await mRes.json().catch(() => ({}));
      if (!mRes.ok) {
        let successCount = 0;
        await mapWithConcurrency(items.slice(0, 50), 6, async (it) => {
          const isMovie = it.type === "movie" || it.kind === "movie" || it.mediaType === "movie";
          const mdbId = (it.imdbId && it.imdbId.startsWith("tt")) ? it.imdbId : (it.id || it.tmdbId);
          if (!mdbId) return;
          try {
            let singleUrl = `https://api.mdblist.com/history/add`;
            if (!accessToken && apiKey) singleUrl += `?apikey=${encodeURIComponent(apiKey)}`;
            const sRes = await fetch(singleUrl, {
              method: "POST",
              headers,
              body: JSON.stringify({
                id: mdbId,
                mediatype: isMovie ? "movie" : "show",
              }),
            });
            if (sRes.ok) successCount++;
          } catch {}
        });
        if (successCount > 0) {
          invalidatePerUserCache("mdblist", safeUserHash(token));
          return json({ ok: true, provider: "mdblist", syncedCount: successCount });
        }
        return json({ ok: false, error: mData.error || `MDBList sync error (HTTP ${mRes.status})` }, mRes.status);
      }
      invalidatePerUserCache("mdblist", safeUserHash(token));
      return json({ ok: true, provider: "mdblist", syncedCount: items.length, data: mData });
    } catch (err) {
      return json({ ok: false, error: safeErrorMessage(err) }, 500);
    }
  }

  return json({ ok: false, error: "Unsupported provider." }, 400);
}

// /api/external-list/create -> creates a new custom list on Trakt, TMDB, or MDBList
async function apiExternalListCreate(request, env) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  // String() every one of these before .trim(). A JSON body is caller data,
  // not a contract: `{"name":{}}` reached `.trim` on an object and was the
  // only uncaught 5xx in ~1,700 fuzzed requests. The sibling route at
  // 26_...:1816 has always done it this way.
  const provider = String(body.provider || "").toLowerCase().trim();
  const name = String(body.name || "").trim();
  const description = String(body.description || "").trim();
  const privacy = String(body.privacy || "private").toLowerCase().trim();
  const listType = String(body.type || "mixed").toLowerCase().trim();

  if (!name) {
    return json({ ok: false, error: "List name is required." }, 400);
  }

  // 1. TRAKT
  if (provider === "trakt") {
    const token = body.traktAccessToken || body.token || "";
    const traktKey = body.traktKey || TRAKT_CLIENT_ID || (env && env.TRAKT_CLIENT_ID) || "";
    const username = body.traktUsername || "me";
    if (!token) return json({ ok: false, error: "Please connect your Trakt account first." }, 400);

    try {
      const res = await fetch("https://api.trakt.tv/users/me/lists", {
        method: "POST",
        headers: traktHeaders(token, traktKey),
        body: JSON.stringify({
          name: name,
          description: description,
          privacy: privacy === "public" ? "public" : "private",
          display_numbers: false,
          allow_comments: true,
          sort_by: "rank",
          sort_how: "asc"
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return json({ ok: false, error: data.error || data.message || `Trakt error (HTTP ${res.status})` }, res.status);
      }
      const slug = data.ids?.slug || data.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const traktUser = data.user?.ids?.slug || username || "me";
      invalidatePerUserCache("trakt", safeUserHash(token));
      return json({
        ok: true,
        provider: "trakt",
        list: {
          id: data.ids?.trakt || data.id || slug,
          slug: slug,
          name: data.name || name,
          description: data.description || description,
          privacy: data.privacy || privacy,
          url: `https://trakt.tv/users/${traktUser}/lists/${slug}`,
          type: listType
        }
      });
    } catch (err) {
      return json({ ok: false, error: safeErrorMessage(err) }, 500);
    }
  }

  // 2. TMDB
  if (provider === "tmdb") {
    const sessionId = body.tmdbSessionId || "";
    const apiKey = body.tmdbKey || TMDB_API_KEY || (env && env.TMDB_API_KEY) || "";
    if (!apiKey) return json({ ok: false, error: "TMDB API key is missing." }, 400);
    if (!sessionId) return json({ ok: false, error: "Please connect your TMDB account in Settings first." }, 400);

    try {
      const res = await fetch(`https://api.themoviedb.org/3/list?api_key=${encodeURIComponent(apiKey)}&session_id=${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": `my-list-addon/${ADDON_VERSION}`,
        },
        body: JSON.stringify({
          name: name,
          description: description,
          language: "en"
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) {
        return json({ ok: false, error: data.status_message || `TMDB error (HTTP ${res.status})` }, res.status || 400);
      }
      const listId = String(data.list_id || data.id);
      invalidatePerUserCache("tmdb", safeUserHash(sessionId));
      return json({
        ok: true,
        provider: "tmdb",
        list: {
          id: listId,
          name: name,
          description: description,
          url: `https://www.themoviedb.org/list/${listId}`,
          type: listType
        }
      });
    } catch (err) {
      return json({ ok: false, error: safeErrorMessage(err) }, 500);
    }
  }
  return apiExternalListCreateMdblist(body, provider, name, description, privacy, listType);
}

// The rest of apiExternalListCreate, moved unchanged: the same statements in the same order, split only for the 150-line limit.
async function apiExternalListCreateMdblist(body, provider, name, description, privacy, listType) {
  // 3. MDBLIST
  if (provider === "mdblist") {
    const token = body.mdblistAccessToken || body.mdblistKey || body.apikey || "";
    const username = body.mdblistUsername || "";
    if (!token) return json({ ok: false, error: "Please connect your MDBList account first." }, 400);

    try {
      const res = await fetch("https://api.mdblist.com/lists/create", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": `my-list-addon/${ADDON_VERSION}`,
        },
        body: JSON.stringify({
          apikey: token,
          access_token: token,
          name: name,
          description: description,
          private: privacy !== "public",
          dynamic: false
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false || data.error) {
        return json({ ok: false, error: data.error || `MDBList error (HTTP ${res.status})` }, res.status || 400);
      }
      const listId = String(data.id || data.slug || "");
      const slug = data.slug || listId;
      invalidatePerUserCache("mdblist", safeUserHash(token));
      return json({
        ok: true,
        provider: "mdblist",
        list: {
          id: listId,
          slug: slug,
          name: data.name || name,
          description: description,
          url: username ? `https://mdblist.com/lists/${username}/${slug}` : `mdblist:list:${listId}`,
          type: listType
        }
      });
    } catch (err) {
      return json({ ok: false, error: safeErrorMessage(err) }, 500);
    }
  }

  // 4. SIMKL
  if (provider === "simkl") {
    const token = body.simklAccessToken || body.token || "";
    if (!token) return json({ ok: false, error: "Please connect your Simkl account first." }, 400);

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const simklUrl = `simkl:user:${listType === "series" ? "shows" : "movies"}:${slug || "plantowatch"}`;
    invalidatePerUserCache("simkl", safeUserHash(token));
    return json({
      ok: true,
      provider: "simkl",
      list: {
        id: slug,
        slug: slug,
        name: name,
        description: description,
        url: simklUrl,
        type: listType
      }
    });
  }

  return json({ ok: false, error: "Unsupported provider for creating lists." }, 400);
}

// /api/external-list/delete -> deletes a custom list from Trakt, TMDB, or MDBList
async function apiExternalListDelete(request, env) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const provider = String(body.provider || "").toLowerCase().trim();
  const listId = String(body.listId || "").trim();

  if (!listId) {
    return json({ ok: false, error: "List ID is required for deletion." }, 400);
  }

  // 1. TRAKT
  if (provider === "trakt") {
    const token = body.traktAccessToken || body.token || "";
    const traktKey = body.traktKey || TRAKT_CLIENT_ID || (env && env.TRAKT_CLIENT_ID) || "";
    if (!token) return json({ ok: false, error: "Please connect your Trakt account first." }, 400);

    try {
      const res = await fetch(`https://api.trakt.tv/users/me/lists/${encodeURIComponent(listId)}`, {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${token}`,
          "trakt-api-key": traktKey,
          "trakt-api-version": "2",
          "User-Agent": `my-list-addon/${ADDON_VERSION}`,
        },
      });
      if (!res.ok && res.status !== 204 && res.status !== 200) {
        const data = await res.json().catch(() => ({}));
        return json({ ok: false, error: data.error || `Trakt error (HTTP ${res.status})` }, res.status);
      }
      invalidatePerUserCache("trakt", safeUserHash(token));
      return json({ ok: true, provider: "trakt", listId });
    } catch (err) {
      return json({ ok: false, error: safeErrorMessage(err) }, 500);
    }
  }

  // 2. TMDB
  if (provider === "tmdb") {
    const sessionId = body.tmdbSessionId || "";
    const apiKey = body.tmdbKey || TMDB_API_KEY || (env && env.TMDB_API_KEY) || "";
    if (!apiKey) return json({ ok: false, error: "TMDB API key is missing." }, 400);
    if (!sessionId) return json({ ok: false, error: "Please connect your TMDB account in Settings first." }, 400);

    try {
      const res = await fetch(`https://api.themoviedb.org/3/list/${encodeURIComponent(listId)}?api_key=${encodeURIComponent(apiKey)}&session_id=${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
        headers: {
          "User-Agent": `my-list-addon/${ADDON_VERSION}`,
        },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && data.success === false) {
        return json({ ok: false, error: data.status_message || `TMDB error (HTTP ${res.status})` }, res.status || 400);
      }
      invalidatePerUserCache("tmdb", safeUserHash(sessionId));
      return json({ ok: true, provider: "tmdb", listId });
    } catch (err) {
      return json({ ok: false, error: safeErrorMessage(err) }, 500);
    }
  }

  // 3. MDBLIST
  if (provider === "mdblist") {
    const accessToken = String(body.mdblistAccessToken || "").trim();
    const apiKey = (body.mdblistKey || body.apikey || "").trim();
    const token = accessToken || apiKey;
    if (!token) return json({ ok: false, error: "Please connect your MDBList account first." }, 400);

    try {
      const headers = {
        "Accept": "application/json",
        "User-Agent": `my-list-addon/${ADDON_VERSION}`,
      };
      let deleteUrl = `https://api.mdblist.com/lists/${encodeURIComponent(listId)}`;
      if (accessToken) {
        headers["Authorization"] = `Bearer ${accessToken}`;
      } else {
        headers["x-api-key"] = apiKey;
        deleteUrl += `?apikey=${encodeURIComponent(apiKey)}`;
      }

      let res = await fetch(deleteUrl, {
        method: "DELETE",
        headers,
      });

      // Fallback: If slug was passed or initial attempt returned 404, resolve numeric id via /lists/user
      if (!res.ok && (res.status === 404 || res.status === 400 || res.status === 405)) {
        try {
          let userListsUrl = "https://api.mdblist.com/lists/user";
          const userHeaders = {
            "Accept": "application/json",
            "User-Agent": `my-list-addon/${ADDON_VERSION}`,
          };
          if (accessToken) {
            userHeaders["Authorization"] = `Bearer ${accessToken}`;
          } else {
            userHeaders["x-api-key"] = apiKey;
            userListsUrl += `?apikey=${encodeURIComponent(apiKey)}`;
          }
          const userRes = await fetch(userListsUrl, { headers: userHeaders });
          if (userRes.ok) {
            const udata = await userRes.json();
            const raw = Array.isArray(udata) ? udata : (Array.isArray(udata.lists) ? udata.lists : []);
            const match = raw.find((l) => l && (String(l.id) === listId || l.slug === listId || l.name === listId));
            if (match && match.id && String(match.id) !== listId) {
              let retryUrl = `https://api.mdblist.com/lists/${encodeURIComponent(match.id)}`;
              if (!accessToken) retryUrl += `?apikey=${encodeURIComponent(apiKey)}`;
              res = await fetch(retryUrl, { method: "DELETE", headers });
            }
          }
        } catch {}
      }

      if (!res.ok && res.status !== 204 && res.status !== 200) {
        const errData = await res.json().catch(() => ({}));
        const errMsg = errData.error || errData.message || `MDBList error (HTTP ${res.status})`;
        return json({ ok: false, error: errMsg }, res.status || 400);
      }

      invalidatePerUserCache("mdblist", safeUserHash(token));
      return json({ ok: true, provider: "mdblist", listId });
    } catch (err) {
      return json({ ok: false, error: safeErrorMessage(err) }, 500);
    }
  }

  return json({ ok: false, error: "Unsupported provider for deleting lists." }, 400);
}

// /api/tmdb/oauth/start -> requests temporary request token from TMDB & redirects to authenticate page
async function apiTmdbOauthStart(env, url) {
  const apiKey = TMDB_API_KEY || (env && env.TMDB_API_KEY) || "";
  if (!apiKey) {
    return new Response("TMDB sign-in is temporarily unavailable. Please try again later.", { status: 503 });
  }
  try {
    const tokenRes = await fetch(`https://api.themoviedb.org/3/authentication/token/new?api_key=${encodeURIComponent(apiKey)}`, {
      headers: { "User-Agent": `my-list-addon/${ADDON_VERSION}` },
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.success || !tokenData.request_token) {
      return new Response("Could not create TMDB request token: " + (tokenData.status_message || "unknown error"), { status: 500 });
    }
    const requestToken = tokenData.request_token;
    const redirectUri = `${url.origin}/api/tmdb/oauth/callback`;
    const authorizeUrl = `https://www.themoviedb.org/authenticate/${encodeURIComponent(requestToken)}?redirect_to=${encodeURIComponent(redirectUri)}`;
    return new Response(null, {
      status: 302,
      headers: {
        Location: authorizeUrl,
        "Set-Cookie": `mla_tmdb_token=${encodeURIComponent(requestToken)}; Path=/api/tmdb/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      },
    });
  } catch (err) {
    return new Response("Could not reach TMDB just now. Please try again.", { status: 502 });
  }
}

// /api/tmdb/oauth/callback -> exchanges request token for session ID & account details
async function apiTmdbOauthCallback(request, env, url) {
  const cookies = parseCookies(request);
  const cookieToken = cookies.mla_tmdb_token || "";
  const clearCookie = "mla_tmdb_token=; Path=/api/tmdb/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
  const failWith = (reason, detail) => {
    const params = new URLSearchParams({ tmdb_error: reason });
    if (detail) params.set("tmdb_error_detail", detail);
    return new Response(null, {
      status: 302,
      headers: { Location: `${url.origin}/?${params.toString()}`, "Set-Cookie": clearCookie },
    });
  };

  const denied = url.searchParams.get("denied") === "true";
  if (denied) return failWith("access_denied");
  // The request token must be the one THIS browser started the flow with.
  //
  // This used to take `request_token` from the query string and fall back
  // to the cookie, without ever comparing the two -- so anyone could approve
  // a request token with their own TMDB account and send someone a link to
  // this callback carrying it. The victim's browser then stored the
  // attacker's session, and every TMDB list the victim added to or created
  // afterwards went into the attacker's account (login CSRF). The cookie is
  // set by /api/tmdb/oauth/start in this browser only, so requiring the two
  // to match binds the callback to the flow that started it.
  const queryToken = url.searchParams.get("request_token") || "";
  if (!cookieToken) return failWith("state_mismatch", "missing cookie");
  if (queryToken && !(await timingSafeEqualSecret(queryToken, cookieToken))) {
    return failWith("state_mismatch");
  }
  const requestToken = cookieToken;

  const apiKey = TMDB_API_KEY || (env && env.TMDB_API_KEY) || "";
  if (!apiKey) return failWith("not_configured");

  try {
    // Exchange request token for session_id
    const sessionRes = await fetch(`https://api.themoviedb.org/3/authentication/session/new?api_key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `my-list-addon/${ADDON_VERSION}`,
      },
      body: JSON.stringify({ request_token: requestToken }),
    });
    const sessionData = await sessionRes.json();
    if (!sessionData.success || !sessionData.session_id) {
      return failWith("session_failed", sessionData.status_message || "");
    }
    const sessionId = sessionData.session_id;

    // Fetch account profile
    const accountRes = await fetch(`https://api.themoviedb.org/3/account?api_key=${encodeURIComponent(apiKey)}&session_id=${encodeURIComponent(sessionId)}`, {
      headers: { "User-Agent": `my-list-addon/${ADDON_VERSION}` },
    });
    const accountData = await accountRes.json();
    const accountId = accountData.id ? String(accountData.id) : "";
    const username = accountData.username || "";

    // Signed in: kept on the server, no session id in the address bar (P3a-9).
    if (await storeProviderConnection(env, request.account, "tmdb", {
      accessToken: sessionId,
      externalUser: { username, id: accountId },
    })) {
      return new Response(null, {
        status: 302,
        headers: { Location: `${url.origin}/?connected=tmdb`, "Set-Cookie": clearCookie },
      });
    }
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${url.origin}/#tmdb_session=${encodeURIComponent(sessionId)}&tmdb_account=${encodeURIComponent(accountId)}&tmdb_user=${encodeURIComponent(username)}`,
        "Set-Cookie": clearCookie,
      },
    });
  } catch (err) {
    return failWith("network", safeErrorMessage(err));
  }
}

// /api/tmdb-my-lists (GET or POST) -> returns user created lists, watchlist, and favorites
async function apiTmdbMyLists(request, env, url) {
  // POST only for the session id and key -- see refuseQueryCredentials.
  const refusedTmdb = refuseQueryCredentials(url, ["sessionId", "tmdbKey"]);
  if (refusedTmdb) return refusedTmdb;
  let sessionId = "";
  let accountId = url.searchParams.get("accountId") || "";
  let manualKey = "";

  if (request.method === "POST") {
    try {
      const body = await request.json();
      if (body.sessionId) sessionId = body.sessionId;
      if (body.accountId) accountId = body.accountId;
      if (body.tmdbKey) manualKey = body.tmdbKey;
    } catch {}
  }

  const apiKey = manualKey || TMDB_API_KEY || (env && env.TMDB_API_KEY) || "";
  if (!apiKey) {
    return json({ ok: false, error: "TMDB API key is missing." }, 400);
  }

  const isV4 = apiKey.startsWith("ey");
  const makeHeaders = () => {
    const h = { "User-Agent": `my-list-addon/${ADDON_VERSION}`, "Accept": "application/json" };
    if (isV4) h["Authorization"] = `Bearer ${apiKey}`;
    return h;
  };
  const makeUrl = (endpoint, params = {}) => {
    const u = new URL(`https://api.themoviedb.org/3${endpoint}`);
    if (!isV4) u.searchParams.set("api_key", apiKey);
    if (sessionId) u.searchParams.set("session_id", sessionId);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, v);
    }
    return u.toString();
  };
  let tmdbUsername = "";

  // If we don't have accountId but have sessionId, query account details
  if (sessionId) {
    try {
      const accRes = await fetch(makeUrl("/account"), { headers: makeHeaders() });
      const acc = await accRes.json();
      if (acc && acc.id) {
        accountId = String(acc.id);
        if (acc.username) tmdbUsername = acc.username;
      }
    } catch {}
  }

  if (!accountId && !sessionId) {
    return json({ ok: false, error: "Please connect your TMDB account first." }, 400);
  }

  const lists = [];

  try {
    // 1. Fetch user's custom lists
    if (accountId) {
      const listsRes = await fetch(makeUrl(`/account/${encodeURIComponent(accountId)}/lists`, { page: "1" }), {
        headers: makeHeaders()
      });
      if (listsRes.ok) {
        const listsData = await listsRes.json();
        const rawLists = Array.isArray(listsData.results) ? listsData.results : [];
        const fetched = await mapWithConcurrency(rawLists, 4, async (it) => {
          const listId = it.id;
          let itemCount = it.item_count || 0;
          let previewItems = [];
          try {
            const detailRes = await fetch(makeUrl(`/list/${encodeURIComponent(listId)}`), { headers: makeHeaders() });
            if (detailRes.ok) {
              const listDetail = await detailRes.json();
              const rawItems = Array.isArray(listDetail.items) ? listDetail.items : (Array.isArray(listDetail.results) ? listDetail.results : []);
              itemCount = listDetail.item_count || rawItems.length || itemCount;
              previewItems = rawItems.slice(0, 9).map((item) => ({
                id: item.id,
                title: item.title || item.name || "Untitled",
                year: (item.release_date || item.first_air_date || "").slice(0, 4),
                poster: item.poster_path ? `https://image.tmdb.org/t/p/w300${item.poster_path}` : "",
                type: item.media_type === "tv" ? "series" : "movie",
              }));
            }
          } catch {}
          return {
            id: String(listId),
            name: it.name || "Untitled List",
            url: `https://www.themoviedb.org/list/${encodeURIComponent(listId)}`,
            contentType: "mixed",
            items: itemCount,
            likes: it.favorite_count || 0,
            description: it.description || "",
            private: it.public === false,
            previewItems: previewItems,
          };
        });
        lists.push(...fetched);
      }
    }
    return await apiTmdbMyListsLists(accountId, makeHeaders, makeUrl, tmdbUsername, lists);
  } catch (err) {
    return json({ ok: false, error: "Failed to load TMDB lists: " + (err.message || String(err)) }, 500);
  }
}

// The rest of apiTmdbMyLists, moved unchanged: the same statements in the same order, split only for the 150-line limit.
async function apiTmdbMyListsLists(accountId, makeHeaders, makeUrl, tmdbUsername, lists) {
  // 2. Fetch user's Watchlist (Movies & TV Shows) and Favorites if accountId is available
  if (accountId) {
    const [wlMovRes, wlTvRes, favMovRes, favTvRes] = await Promise.all([
      fetch(makeUrl(`/account/${encodeURIComponent(accountId)}/watchlist/movies`, { page: "1" }), { headers: makeHeaders() }),
      fetch(makeUrl(`/account/${encodeURIComponent(accountId)}/watchlist/tv`, { page: "1" }), { headers: makeHeaders() }),
      fetch(makeUrl(`/account/${encodeURIComponent(accountId)}/favorite/movies`, { page: "1" }), { headers: makeHeaders() }),
      fetch(makeUrl(`/account/${encodeURIComponent(accountId)}/favorite/tv`, { page: "1" }), { headers: makeHeaders() }),
    ]);

    if (wlMovRes && wlMovRes.ok) {
      const wlMovData = await wlMovRes.json();
      const rawItems = Array.isArray(wlMovData.results) ? wlMovData.results : [];
      const total = wlMovData.total_results || rawItems.length;
      if (total > 0) {
        const previewItems = rawItems.slice(0, 9).map((it) => ({
          id: it.id,
          title: it.title || it.name || "Untitled",
          year: (it.release_date || it.first_air_date || "").slice(0, 4),
          poster: it.poster_path ? `https://image.tmdb.org/t/p/w300${it.poster_path}` : "",
          type: "movie",
        }));
        lists.push({
          id: "watchlist_movies",
          name: "TMDB Watchlist (Movies)",
          url: `tmdb:account:watchlist:movies`,
          contentType: "movie",
          items: total,
          likes: 0,
          description: "Your TMDB Watchlist Movies",
          private: true,
          previewItems: previewItems,
        });
      }
    }

    if (wlTvRes && wlTvRes.ok) {
      const wlTvData = await wlTvRes.json();
      const rawItems = Array.isArray(wlTvData.results) ? wlTvData.results : [];
      const total = wlTvData.total_results || rawItems.length;
      if (total > 0) {
        const previewItems = rawItems.slice(0, 9).map((it) => ({
          id: it.id,
          title: it.name || it.title || "Untitled",
          year: (it.first_air_date || it.release_date || "").slice(0, 4),
          poster: it.poster_path ? `https://image.tmdb.org/t/p/w300${it.poster_path}` : "",
          type: "series",
        }));
        lists.push({
          id: "watchlist_tv",
          name: "TMDB Watchlist (Shows)",
          url: `tmdb:account:watchlist:tv`,
          contentType: "series",
          items: total,
          likes: 0,
          description: "Your TMDB Watchlist TV Shows",
          private: true,
          previewItems: previewItems,
        });
      }
    }

    if (favMovRes && favMovRes.ok) {
      const favMovData = await favMovRes.json();
      const rawItems = Array.isArray(favMovData.results) ? favMovData.results : [];
      const total = favMovData.total_results || rawItems.length;
      if (total > 0) {
        const previewItems = rawItems.slice(0, 9).map((it) => ({
          id: it.id,
          title: it.title || it.name || "Untitled",
          year: (it.release_date || it.first_air_date || "").slice(0, 4),
          poster: it.poster_path ? `https://image.tmdb.org/t/p/w300${it.poster_path}` : "",
          type: "movie",
        }));
        lists.push({
          id: "favorites_movies",
          name: "TMDB Favorites (Movies)",
          url: `tmdb:account:favorites:movies`,
          contentType: "movie",
          items: total,
          likes: 0,
          description: "Your TMDB Favorite Movies",
          private: true,
          previewItems: previewItems,
        });
      }
    }

    if (favTvRes && favTvRes.ok) {
      const favTvData = await favTvRes.json();
      const rawItems = Array.isArray(favTvData.results) ? favTvData.results : [];
      const total = favTvData.total_results || rawItems.length;
      if (total > 0) {
        const previewItems = rawItems.slice(0, 9).map((it) => ({
          id: it.id,
          title: it.name || it.title || "Untitled",
          year: (it.first_air_date || it.release_date || "").slice(0, 4),
          poster: it.poster_path ? `https://image.tmdb.org/t/p/w300${it.poster_path}` : "",
          type: "series",
        }));
        lists.push({
          id: "favorites_tv",
          name: "TMDB Favorites (Shows)",
          url: `tmdb:account:favorites:tv`,
          contentType: "series",
          items: total,
          likes: 0,
          description: "Your TMDB Favorite TV Shows",
          private: true,
          previewItems: previewItems,
        });
      }
    }
  }

  return json({ ok: true, lists, username: tmdbUsername, accountId }, 200, { "Cache-Control": "no-store" }); // no-store: a per-person answer keyed on a credential in the URL (see A12).
}
