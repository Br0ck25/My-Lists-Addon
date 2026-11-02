// Trakt and MDBList private lists and raw watch history, feedback, and the search and event trackers, moved out of handleFetch (CQ-01).

// Moved unchanged: each route body is now its own function; the dispatcher keeps each route's
// original path/method test and is a plain function that returns a Response promise or null.
// Feedback routes authenticate through authenticateCreatorFor (62_creator-auth.js).

// /api/trakt-my-private-lists, /api/trakt-history-raw, /api/feedback*, /api/track-search, /api/track-event, /api/mdblist-my-lists and /api/mdblist-history-raw, at their original place. Returns a Response promise, or null.
function handleMyListsAndFeedbackRoutes(request, env, ctx, url, path) {
  if (path === "/api/trakt-my-private-lists" && request.method === "POST") return apiTraktMyPrivateLists(request, env, ctx);
  if (path === "/api/trakt-history-raw" && request.method === "POST") return apiTraktHistoryRaw(request, env, ctx);
  if (path === "/api/feedback" && request.method === "POST") return apiFeedback(request, env, ctx, path);
  if (path === "/api/feedback/threads" && (request.method === "POST" || request.method === "GET")) return apiFeedbackThreads(request, env, ctx, url, path);
  if (path === "/api/feedback/delete" && request.method === "POST") return apiFeedbackDelete(request, env, ctx, path);
  if (path === "/api/track-search" && request.method === "POST") return apiTrackSearch(request, env, ctx);
  if (path === "/api/track-event" && request.method === "POST") return apiTrackEvent(request, env, ctx, url);
  if (path === "/api/mdblist-my-lists") return apiMdblistMyLists(request, url);
  if (path === "/api/mdblist-history-raw" && request.method === "POST") return apiMdblistHistoryRaw(request);
  return null;
}

// /api/trakt-my-private-lists  (POST)  { accessToken } -> { ok, lists }
// Same shape as /api/trakt-my-lists above, but hits /users/me/lists
// with the OAuth token as a Bearer header instead of a plain username
// lookup -- "me" resolves to whichever account approved the
// connection, and includes their private lists (which the public,
// username-based endpoint above can never see). POST, not GET, so the
// token travels in the body rather than sitting in a URL/query string
// that could end up in logs.
async function apiTraktMyPrivateLists(request, env, ctx) {
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const accessToken = String(body.accessToken || "").trim();
  if (!accessToken) return json({ ok: false, error: "Not connected to Trakt." }, 400);
  try {
    const userHash = safeUserHash(accessToken);
    const cacheKey = `user_cache:trakt:private_lists:${userHash}`;

    const result = await fetchWithPerUserCacheAndCircuitBreaker({
      cacheKey,
      kvKey: cacheKey,
      env,
      ctx,
      freshTtlSec: 60,
      staleTtlSec: 1800,
      kvTtlSec: 1800,
      providerLabel: "Trakt Private Lists",
      fetchFn: async () => {
        const res = await fetchTraktWithRetry("https://api.trakt.tv/users/me/lists", {
          headers: traktHeaders(accessToken),
          cf: { cacheTtl: 0, cacheEverything: false },
        });
        if (res.status === 401) {
          throw new Error("Your Trakt connection has expired or was revoked -- reconnect in Settings.");
        }
        if (!res.ok) throw new Error(`Trakt request failed (HTTP ${res.status}).`);
        const data = await res.json();
        const meRes = await fetchTraktWithRetry("https://api.trakt.tv/users/me", {
          headers: traktHeaders(accessToken),
          cf: { cacheTtl: 0, cacheEverything: false },
        });
        const me = meRes.ok ? await meRes.json() : null;
        const meSlug = me && me.ids && me.ids.slug ? me.ids.slug : "me";
        const rawLists = (Array.isArray(data) ? data : [])
          .filter((l) => l && l.ids && l.ids.slug)
          .map((l) => {
            const name = l.name || "";
            const isMovie = /\bmovie(s)?\b/i.test(name);
            const isSeries = /\b(show|shows|series|anime|tv|season(s)?)\b/i.test(name);
            const contentType = isMovie && !isSeries ? "movie" : (isSeries && !isMovie ? "series" : "unknown");
            return {
              name: l.name,
              slug: l.ids.slug,
              items: l.item_count || 0,
              likes: l.likes || 0,
              private: l.privacy !== "public",
              contentType,
              url: `https://trakt.tv/users/${encodeURIComponent(meSlug)}/lists/${encodeURIComponent(l.ids.slug)}`,
            };
          });

        let watchlistCount = 0;
        try {
          const watchlistRes = await fetchTraktWithRetry("https://api.trakt.tv/users/me/watchlist?limit=1&page=1", {
            headers: traktHeaders(accessToken),
            cf: { cacheTtl: 0, cacheEverything: false },
          });
          if (watchlistRes.ok) {
            watchlistCount = parseInt(watchlistRes.headers.get("X-Pagination-Item-Count") || "0", 10) || 0;
          }
        } catch {}
        const watchlistEntry = {
          name: "Trakt Watch List",
          slug: "watchlist",
          items: watchlistCount,
          likes: 0,
          private: true,
          url: "trakt:watchlist",
          contentType: "unknown",
        };

        let historyCount = 0;
        try {
          const historyRes = await fetchTraktWithRetry("https://api.trakt.tv/users/me/history?limit=1&page=1", {
            headers: traktHeaders(accessToken),
            cf: { cacheTtl: 0, cacheEverything: false },
          });
          if (historyRes.ok) {
            historyCount = parseInt(historyRes.headers.get("X-Pagination-Item-Count") || "0", 10) || 0;
          }
        } catch {}
        const historyEntry = {
          name: "Trakt Watch History",
          slug: "history",
          items: historyCount,
          likes: 0,
          private: true,
          url: "trakt:history",
          contentType: "unknown",
        };

        let continueWatchingCandidates = [];
        let wData = [];
        await apiTraktMyPrivateListsContinueWatchingBlock(accessToken, continueWatchingCandidates, wData);
        return apiTraktMyPrivateListsEntries(env, ctx, { accessToken, me, meSlug, rawLists, watchlistEntry, historyEntry, continueWatchingCandidates });
      }
    });

    const lists = Array.isArray(result) ? result : (result && result.lists) || [];
    const username = (result && result.username) || "";
    return json({ ok: true, lists, username });
  } catch (err) {
    return json({ ok: false, error: safeErrorMessage(err) });
  }
}

// The rest of the callback inside apiTraktMyPrivateLists, moved unchanged: the same statements in the same order, split only for the 150-line limit.
async function apiTraktMyPrivateListsEntries(env, ctx, { accessToken, me, meSlug, rawLists, watchlistEntry, historyEntry, continueWatchingCandidates }) {
  const continueWatchingEntry = {
    name: "Trakt Continue Watching",
    slug: "continue-watching",
    statusKey: "continue-watching",
    type: "mixed",
    contentType: "mixed",
    itemCount: continueWatchingCandidates.length,
    items: continueWatchingCandidates,
    private: true,
    url: "trakt:continue-watching",
  };

  let airingCandidates = [];
  await apiTraktMyPrivateListsAiringNext(accessToken, airingCandidates);

  const airingNextEntry = {
    name: "Trakt Airing Next",
    slug: "airing-next",
    statusKey: "airing-next",
    type: "series",
    contentType: "series",
    itemCount: airingCandidates.length,
    items: airingCandidates,
    private: true,
    url: "trakt:user:shows:airing-next",
  };

  const meUsername = (me && me.username) || (meSlug !== "me" ? meSlug : "");

  ctx.waitUntil(bumpStatBy(env, "apiuse:trakt", 4));
  return { lists: [continueWatchingEntry, airingNextEntry, watchlistEntry, historyEntry, ...rawLists], username: meUsername };
}

// A part of apiTraktMyPrivateLists, moved unchanged: the same statements in the same order, split out only for the 150-line limit.
async function apiTraktMyPrivateListsContinueWatchingBlock(accessToken, continueWatchingCandidates, wData) {
  try {
    const [playbackRes, wShowsRes, hProgRes, hDroppedRes, hResetRes] = await Promise.all([
      fetchTraktWithRetry("https://api.trakt.tv/sync/playback?limit=50", {
        headers: traktHeaders(accessToken),
        cf: { cacheTtl: 0, cacheEverything: false },
      }).catch(() => null),
      fetchTraktWithRetry("https://api.trakt.tv/users/me/watched/shows?extended=noseasons", {
        headers: traktHeaders(accessToken),
        cf: { cacheTtl: 60, cacheEverything: false },
      }).catch(() => null),
      fetchTraktWithRetry("https://api.trakt.tv/users/hidden/progress_watched?type=show&limit=100", {
        headers: traktHeaders(accessToken),
        cf: { cacheTtl: 300, cacheEverything: false },
      }).catch(() => null),
      fetchTraktWithRetry("https://api.trakt.tv/users/hidden/dropped?type=show&limit=100", {
        headers: traktHeaders(accessToken),
        cf: { cacheTtl: 300, cacheEverything: false },
      }).catch(() => null),
      fetchTraktWithRetry("https://api.trakt.tv/users/hidden/progress_watched_reset?type=show&limit=100", {
        headers: traktHeaders(accessToken),
        cf: { cacheTtl: 300, cacheEverything: false },
      }).catch(() => null),
    ]);

    const hiddenShowKeys = new Set();
    for (const hRes of [hProgRes, hDroppedRes, hResetRes]) {
      if (hRes && hRes.ok) {
        const hData = await hRes.json().catch(() => []);
        if (Array.isArray(hData)) {
          for (const item of hData) {
            if (!item) continue;
            const s = item.show || item.movie || item;
            const ids = s.ids || item.ids || {};
            if (ids.trakt) hiddenShowKeys.add(String(ids.trakt));
            if (ids.imdb) hiddenShowKeys.add(String(ids.imdb).toLowerCase());
            if (ids.tmdb) hiddenShowKeys.add(String(ids.tmdb));
            if (ids.slug) hiddenShowKeys.add(String(ids.slug).toLowerCase());
            if (s.title) hiddenShowKeys.add(String(s.title).toLowerCase().trim());
          }
        }
      }
    }

    const seenShowIds = new Set();
    if (playbackRes && playbackRes.ok) {
      const pbData = await playbackRes.json().catch(() => []);
      if (Array.isArray(pbData)) {
        for (const it of pbData) {
          if (!it) continue;
          const isEp = it.type === "episode" || !!it.episode;
          const ep = it.episode || {};
          const show = it.show || {};
          const mov = it.movie || {};
          const inner = isEp ? show : mov;
          // An episode row is filed under the SHOW's ids, like the shelf (fetchTraktContinueWatching); the episode's own ids are only a fallback.
          const ids = (isEp ? (show.ids || ep.ids) : mov.ids) || {};
          if (traktIsHiddenShow(hiddenShowKeys, inner, ids)) continue;
          const imdbId = ids.imdb || show.ids?.imdb || mov.ids?.imdb || "";
          const tmdbId = ids.tmdb || show.ids?.tmdb || mov.ids?.tmdb || "";
          const traktId = ids.trakt || show.ids?.trakt || mov.ids?.trakt || null;
          if (traktId) seenShowIds.add(String(traktId));
          // Same keys as the shelf: IMDB ids lower-cased, plus the slug.
          if (imdbId) seenShowIds.add(String(imdbId).toLowerCase());
          if (tmdbId) seenShowIds.add(String(tmdbId));
          if (ids.slug) seenShowIds.add(String(ids.slug).toLowerCase());
          const bestId = imdbId || (tmdbId ? `tmdb:${tmdbId}` : String(it.id));
          const sNum = isEp ? (ep.season != null ? ep.season : 1) : null;
          const eNum = isEp ? (ep.number != null ? ep.number : 1) : null;
          const epTitle = isEp ? (ep.title || "") : "";
          const showTitle = isEp ? (show.title || "") : (mov.title || "");
          const fullId = isEp ? (bestId + ":" + sNum + ":" + eNum) : bestId;
          continueWatchingCandidates.push({
            id: fullId,
            showId: bestId,
            imdbId: imdbId || null,
            tmdbId: tmdbId || null,
            name: showTitle,
            title: isEp ? (showTitle + (sNum != null && eNum != null ? ` S${String(sNum).padStart(2, "0")}E${String(eNum).padStart(2, "0")}` : "")) : showTitle,
            episodeTitle: epTitle,
            seasonNum: sNum,
            episodeNum: eNum,
            year: (isEp ? show.year : mov.year) || "",
            poster: imdbId ? `https://images.metahub.space/poster/medium/${imdbId}/img` : (tmdbId ? `https://images.metahub.space/poster/medium/tmdb:${tmdbId}/img` : ""),
            type: isEp ? "series" : "movie",
            progress: typeof it.progress === "number" ? Math.round(it.progress) : 0,
            pausedAt: it.paused_at || null,
            lastWatched: it.paused_at || null,
          });
        }
      }
    }

    await apiTraktMyPrivateListsContinueWatching(accessToken, continueWatchingCandidates, wData, wShowsRes, hiddenShowKeys, seenShowIds);
  } catch (e) {
    console.error("/api/trakt-my-private-lists: the Continue Watching / Up Next block failed; the shelf is left out", e);
  }
}

// A part of apiTraktMyPrivateLists, moved unchanged: the same statements in the same order, split out only for the 150-line limit.
async function apiTraktMyPrivateListsAiringNext(accessToken, airingCandidates) {
  try {
    const [wShowsRes, wlShowsRes] = await Promise.all([
      fetchTraktWithRetry("https://api.trakt.tv/users/me/watched/shows?extended=noseasons", {
        headers: traktHeaders(accessToken),
        cf: { cacheTtl: 60, cacheEverything: false },
      }).catch(() => null),
      fetchTraktWithRetry("https://api.trakt.tv/users/me/watchlist/shows?limit=50", {
        headers: traktHeaders(accessToken),
        cf: { cacheTtl: 60, cacheEverything: false },
      }).catch(() => null),
    ]);

    const rawAiring = [];
    if (wShowsRes && wShowsRes.ok) {
      const wData = await wShowsRes.json();
      if (Array.isArray(wData)) rawAiring.push(...wData);
    }
    if (wlShowsRes && wlShowsRes.ok) {
      const wlData = await wlShowsRes.json();
      if (Array.isArray(wlData)) rawAiring.push(...wlData);
    }

    const seenIds = new Set();
    for (const it of rawAiring) {
      const show = it.show || it;
      if (show && show.ids) {
        const imdbId = show.ids.imdb || "";
        const tmdbId = show.ids.tmdb || "";
        const bestId = imdbId || (tmdbId ? `tmdb:${tmdbId}` : "");
        if (bestId && !seenIds.has(bestId)) {
          seenIds.add(bestId);
          airingCandidates.push({
            id: bestId,
            imdbId: imdbId || null,
            tmdbId: tmdbId || null,
            name: show.title || "",
            year: show.year || "",
            poster: imdbId ? `https://images.metahub.space/poster/medium/${imdbId}/img` : "",
            type: "series",
            lastWatched: it.last_watched_at || null,
          });
        }
      }
    }
  } catch {}
}

// A part of apiTraktMyPrivateLists, moved unchanged: the same statements in the same order, split out only for the 150-line limit.
async function apiTraktMyPrivateListsContinueWatching(accessToken, continueWatchingCandidates, wData, wShowsRes, hiddenShowKeys, seenShowIds) {
  if (wShowsRes && wShowsRes.ok) {
    const rawW = await wShowsRes.json().catch(() => []);
    if (Array.isArray(rawW)) wData = rawW;
  }

  if (wData && wData.length) {
    const sorted = wData
      .filter((it) => it && it.show && it.show.ids)
      .sort((a, b) => new Date(b.last_watched_at || 0) - new Date(a.last_watched_at || 0));

    const candidates = sorted
      .filter((it) => {
        const ids = it.show.ids;
        if (traktIsHiddenShow(hiddenShowKeys, it.show, ids)) return false;
        const hasPb = (ids.trakt && seenShowIds.has(String(ids.trakt))) ||
                      (ids.imdb && seenShowIds.has(String(ids.imdb).toLowerCase())) ||
                      (ids.tmdb && seenShowIds.has(String(ids.tmdb))) ||
                      (ids.slug && seenShowIds.has(String(ids.slug).toLowerCase()));
        return !hasPb;
      })
      .slice(0, TRAKT_CONTINUE_NEXT_EPISODE_SHOWS);

    await mapWithConcurrency(candidates, 5, async (c) => {
      const show = c.show;
      const showKey = show.ids.trakt || show.ids.imdb || show.ids.slug;
      if (!showKey) return;
      try {
        const pRes = await fetchTraktWithRetry(`https://api.trakt.tv/shows/${encodeURIComponent(showKey)}/progress/watched?last_activity=watched&hidden=false&specials=false&count_specials=false`, {
          headers: traktHeaders(accessToken),
          cf: { cacheTtl: 60, cacheEverything: false },
        });
        if (!pRes.ok) return;
        const prog = await pRes.json();
        if (!prog) return;

        const aired = typeof prog.aired === "number" ? prog.aired : 0;
        const completed = typeof prog.completed === "number" ? prog.completed : 0;
        const now = new Date();

        let nextEp = prog.next_episode || null;
        const isNextEpUnaired = nextEp && nextEp.first_aired && new Date(nextEp.first_aired) > now;

        // If nextEp points to a future unaired episode or is missing, but user hasn't finished all aired episodes:
        // search prog.seasons for the earliest uncompleted aired episode (handles FBI S01E02!)
        if ((!nextEp || isNextEpUnaired) && completed < aired && Array.isArray(prog.seasons)) {
          for (const s of prog.seasons) {
            if (s.number > 0 && s.completed < s.aired && Array.isArray(s.episodes)) {
              const unwatched = s.episodes.find((ep) => !ep.completed);
              if (unwatched) {
                nextEp = {
                  season: s.number,
                  number: unwatched.number,
                  title: unwatched.title || "",
                  first_aired: unwatched.first_aired || null,
                };
                break;
              }
            }
          }
        }

        const imdbId = show.ids.imdb || "";
        const tmdbId = show.ids.tmdb || "";
        const bestId = imdbId || (tmdbId ? `tmdb:${tmdbId}` : String(show.ids.trakt));
        const showTitle = show.title || "Show";
        const poster = imdbId ? `https://images.metahub.space/poster/medium/${imdbId}/img` : (tmdbId ? `https://images.metahub.space/poster/medium/tmdb:${tmdbId}/img` : "");

        // An episode belongs in Continue Watching ONLY if it has already aired AND user hasn't completed all aired episodes:
        const hasAiredUnwatched = nextEp && (!nextEp.first_aired || new Date(nextEp.first_aired) <= now) && (completed < aired || !prog.aired);

        if (hasAiredUnwatched) {
          const sNum = nextEp.season != null ? nextEp.season : 1;
          const eNum = nextEp.number != null ? nextEp.number : 1;
          const epTitle = nextEp.title || "";
          const fullId = `${bestId}:${sNum}:${eNum}`;
          continueWatchingCandidates.push({
            id: fullId,
            showId: bestId,
            imdbId: imdbId || null,
            tmdbId: tmdbId || null,
            name: showTitle,
            title: `${showTitle} S${String(sNum).padStart(2, "0")}E${String(eNum).padStart(2, "0")}`,
            episodeTitle: epTitle,
            seasonNum: sNum,
            episodeNum: eNum,
            year: show.year || "",
            poster: poster,
            type: "series",
            progress: 0,
            pausedAt: null,
            lastWatched: prog.last_watched_at || c.last_watched_at || null,
          });
        }
      } catch {}
    });
  }
}

// /api/trakt-history-raw  (POST)  { accessToken, type: 'movies'|'episodes', page, limit }
// -> { ok, items: [...raw Trakt history rows...], hasMore }
async function apiTraktHistoryRaw(request, env, ctx) {
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const accessToken = String(body.accessToken || "").trim();
  if (!accessToken) return json({ ok: false, error: "Not connected to Trakt." }, 400);
  const itemKind = body.type === "episodes" ? "episodes" : "movies";
  const page = Math.max(1, parseInt(body.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(body.limit, 10) || 100));
  try {
    const userHash = safeUserHash(accessToken);
    const cacheKey = `user_cache:trakt:history_raw:${itemKind}:${page}:${limit}:${userHash}`;

    const historyResult = await fetchWithPerUserCacheAndCircuitBreaker({
      cacheKey,
      kvKey: cacheKey,
      env,
      ctx,
      freshTtlSec: 60,
      staleTtlSec: 1800,
      kvTtlSec: 1800,
      providerLabel: "Trakt History Raw",
      fetchFn: async () => {
        ctx.waitUntil(bumpStat(env, "apiuse:trakt"));
        const res = await fetchTraktWithRetry(`https://api.trakt.tv/users/me/history/${itemKind}?limit=${limit}&page=${page}`, {
          headers: traktHeaders(accessToken),
          cf: { cacheTtl: 0, cacheEverything: false },
        });
        if (res.status === 401) {
          throw new Error("Your Trakt connection has expired or was revoked -- reconnect in Settings.");
        }
        if (!res.ok) throw new Error(`Trakt history request failed (HTTP ${res.status}).`);
        const items = await res.json();
        const totalPages = parseInt(res.headers.get("x-pagination-page-count") || "1", 10) || 1;
        return { items: Array.isArray(items) ? items : [], hasMore: page < totalPages };
      }
    });

    return json({ ok: true, items: historyResult.items || [], hasMore: !!historyResult.hasMore });
  } catch (err) {
    return json({ ok: false, error: safeErrorMessage(err) });
  }
}

// /api/feedback  (POST)  { category, message, contact?, creatorName?, threadId? } -> { ok, entry }
// Settings > Feedback & Support 2-way chat.
async function apiFeedback(request, env, ctx, path) {
  if (!env || !env.CONFIGS) return json({ ok: false, error: "Feedback storage isn't configured on this deployment." });
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const message = String(body.message || "").trim();
  if (!message) return json({ ok: false, error: "Message can't be empty." }, 400);
  if (message.length > 4000) return json({ ok: false, error: "That's a bit long -- please keep it under 4000 characters." }, 400);
  const allowedCategories = new Set(["bug", "improvement", "idea", "other"]);
  const category = allowedCategories.has(body.category) ? body.category : "other";
  const contact = String(body.contact || "").trim().slice(0, 200);
  const claimedCreator = body.creatorName ? String(body.creatorName).trim().slice(0, 100) : null;
  const threadId = body.threadId ? String(body.threadId).trim() : null;

  const isAdmin = (await isAdminRequest(request, env)) && body.fromAdminPanel === true;

  // A claimed creatorName used to be recorded, and rendered in the admin
  // panel as the sender, on nothing but the caller's say-so -- so anyone
  // could file or answer feedback wearing someone else's name. It is now
  // proven before it is stored anywhere.
  //
  // An unprovable claim is DROPPED, not rejected. This is the support
  // channel: the person whose key stopped working is exactly the person
  // who needs to reach support, and 401ing them here would close the one
  // door they have left. Their message still goes through, just as an
  // anonymous one -- which is all "we could not verify who you are"
  // honestly supports. (Replying to a thread that already belongs to an
  // account is the separate, stricter case, handled below.)
  //
  // The admin panel is the one exemption: its "Log something yourself"
  // button posts creatorName:"admin" with fromAdminPanel:true and no key
  // (see submitAdminFeedback, 03_admin.js), and "admin" is a marker that
  // feedbackCardHtml keys off, not a Creator Profile to authenticate.
  let authedCreator = null;
  if (!isAdmin && claimedCreator) {
    const auth = await authenticateCreatorFor(request, env, ctx, path, claimedCreator, body.creatorKey ? String(body.creatorKey) : "");
    if (auth.ok) authedCreator = auth.username;
  }
  // What actually gets stored: the admin marker, a proven username, or
  // nothing. Never the raw claim.
  const creatorName = isAdmin ? claimedCreator : authedCreator;
  let rateLimitKey = null;
  let rateCount = 0;
  if (!isAdmin) {
    const ip = clientIpKey(request);
    if (!ip) return json({ ok: false, error: "Could not process this request." }, 400);
    rateLimitKey = `feedbackrate:${ip}:${statsToday()}`;
    const rateCountRaw = await env.CONFIGS.get(rateLimitKey);
    rateCount = parseInt(rateCountRaw, 10) || 0;
    if (rateCount >= 20) {
      return json({ ok: false, error: "You've sent a few messages today -- please try again tomorrow." });
    }
  }
  return apiFeedbackThreadReply(request, env, { message, category, contact, threadId, isAdmin, authedCreator, creatorName, rateLimitKey, rateCount });
}

// The rest of apiFeedback, moved unchanged: the same statements in the same order, split only for the 150-line limit.
async function apiFeedbackThreadReply(request, env, { message, category, contact, threadId, isAdmin, authedCreator, creatorName, rateLimitKey, rateCount }) {
  // If replying to an existing thread
  if (threadId) {
    let entry = null;
    if (env && env.DB) {
      try {
        const row = await env.DB.prepare("SELECT body_json FROM feedback WHERE id = ?").bind(threadId).first();
        if (row && row.body_json) entry = JSON.parse(row.body_json);
      } catch {}
    }
    if (!entry && env && env.CONFIGS) {
      try {
        const raw = await env.CONFIGS.get(`feedback:${threadId}`);
        if (raw) entry = JSON.parse(raw);
      } catch (e) {
        entry = null;
      }
    }

    // A thread id is a capability, and for a thread nobody owns that is
    // the whole design: an anonymous reporter has no account and follows
    // up with nothing else. But a thread that DOES belong to an account
    // is not a bare capability -- the id alone used to be enough for any
    // stranger to append to it, reopen it, and pick their own display
    // name, which the admin panel then rendered as the sender.
    //
    // A stored name that no longer normalises to a valid username (legacy
    // free-text) cannot be authenticated as by anyone, so treating it as
    // owned would strand the thread. Those stay id-capability threads.
    if (entry && !isAdmin) {
      const ownerRaw = entry.creatorName ? String(entry.creatorName).trim() : "";
      let ownerNorm = "";
      if (ownerRaw) {
        const ownerV = validateCreatorUsername(ownerRaw);
        if (ownerV && ownerV.ok) ownerNorm = ownerV.normalized;
      }
      if (ownerNorm && ownerNorm !== authedCreator) {
        return json(
          { ok: false, error: "That conversation belongs to an account. Sign in to reply to it." },
          403,
          { "Cache-Control": "no-store" }
        );
      }
    }

    try {
      if (entry) {
        if (!Array.isArray(entry.messages) || !entry.messages.length) {
          entry.messages = [{
            id: `msg_init`,
            sender: "user",
            senderName: entry.creatorName || "User",
            text: entry.message || "(Initial message)",
            timestamp: entry.createdAt || Date.now()
          }];
        }
        const newMsg = {
          id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          sender: isAdmin ? "admin" : "user",
          // Derived, never taken from the request body. This is what
          // the admin panel renders as the sender, so letting the
          // caller choose it meant a stranger could plant a message
          // signed "Developer" inside someone else's thread.
          senderName: isAdmin ? "Developer" : (entry.creatorName || authedCreator || "User"),
          text: message,
          timestamp: Date.now()
        };
        entry.messages.push(newMsg);
        entry.updatedAt = Date.now();
        entry.status = isAdmin ? "replied" : "open";
        entry.completed = false;
        if (contact && !entry.contact) entry.contact = contact;
        // Claiming an unowned thread now takes proof, not just the id --
        // otherwise anyone holding it could attach their own account to
        // someone else's report.
        if (creatorName && !entry.creatorName) entry.creatorName = creatorName;
        await putFeedbackThread(env, `feedback:${threadId}`, entry);
        if (!isAdmin) await env.CONFIGS.put(rateLimitKey, String(rateCount + 1), { expirationTtl: 86400 });
        return json({ ok: true, entry });
      }
    } catch (e) {
      // This was `catch (e) {}` -- an empty one, and the worst of the five
      // feedback writes that dropped their error.
      //
      // Falling out of this block does not stop here: execution carries on
      // into the "New Thread" path below, which mints a fresh id and files
      // the message as its own report. So a reply that failed to save was
      // silently turned into a DUPLICATE THREAD, detached from the
      // conversation it was answering -- the sender was told it went
      // through, the admin saw a new orphan report, and nothing was logged
      // either way.
      //
      // A reply that cannot be saved is an error, so it is reported as
      // one. The empty-entry case is unaffected: that never enters this
      // `if (entry)` block, so an unknown thread id still falls through to
      // New Thread exactly as it always did.
      return json({ ok: false, error: safeErrorMessage(e, "Could not save your reply right now. Please try again in a moment.") }, 500);
    }
  }
  return apiFeedbackNewEntry(request, env, { message, category, contact, isAdmin, creatorName, rateLimitKey, rateCount });
}

// The rest of apiFeedback, moved unchanged: the same statements in the same order, split only for the 150-line limit.
async function apiFeedbackNewEntry(request, env, { message, category, contact, isAdmin, creatorName, rateLimitKey, rateCount }) {
  // New Thread
  //
  // The id is a capability: /api/feedback/threads hands the whole thread
  // -- every message plus the contact address the form asks for -- to
  // anyone who presents it, deliberately, so anonymous reporters can
  // follow up. It was minted with Math.random(), which is not a CSPRNG:
  // V8's xorshift128+ state is recoverable from a handful of outputs, so
  // filing a few reports of your own leaked the ids being handed to
  // other people from the same isolate. generateShortId is the same
  // crypto.getRandomValues helper the OAuth state cookies use.
  // Date.now() stays as the prefix -- /admin/api/feedback relies on
  // these keys sorting chronologically.
  const id = `${Date.now()}:${generateShortId()}`;
  const entry = {
    id, category, message, contact: contact || null, creatorName,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completed: false,
    status: "open",
    messages: [
      {
        id: `msg_${Date.now()}_1`,
        sender: isAdmin ? "admin" : "user",
        // creatorName here is the proven name (or the admin marker),
        // never the raw claim -- see its assignment above.
        senderName: isAdmin ? "Developer" : (creatorName || "User"),
        text: message,
        timestamp: Date.now()
      }
    ],
    userAgent: (request.headers.get("User-Agent") || "").slice(0, 300),
  };
  try {
    await putFeedbackThread(env, `feedback:${id}`, entry);
    if (!isAdmin) await env.CONFIGS.put(rateLimitKey, String(rateCount + 1), { expirationTtl: 86400 });
  } catch (e) {
    // Logged rather than swallowed, for the reason spelled out at the
    // admin status route (26_...). This one is NOT admin-only, so the
    // caller keeps the generic wording -- safeErrorMessage still writes
    // the real error to the log, which is the half that was missing.
    safeErrorMessage(e);
    return json({ ok: false, error: "Could not save your feedback right now. Please try again in a moment." }, 500);
  }
  return json({ ok: true, entry });
}

// /api/feedback/threads (POST) { creatorName?, threadIds? } -> { ok, threads }
// Loads active support chat threads for a user/device
async function apiFeedbackThreads(request, env, ctx, url, path) {
  if (!env || !env.CONFIGS) return json({ ok: true, threads: [] }, 200, { "Cache-Control": "no-store" });
  // The last piece of the thread-id finding (AUDIT-2026-09-05 §3): the id
  // is a capability, it is now 72 bits of CSPRNG rather than 31 bits of
  // Math.random, and this endpoint is deliberately unauthenticated for the
  // threadIds path -- anonymous users with no account rely on it to follow
  // up on what they filed. What it had no answer for was VOLUME: 20 ids
  // per request, no limit, so guessing cost nothing to attempt.
  //
  // Generous against real use (the support panel calls this when it opens
  // and on a manual refresh, not on a timer) and ruinous against
  // enumeration, which needs orders of magnitude more than this to be
  // worth starting.
  const threadsIp = clientIpKey(request);
  if (await consumeRateLimit(env, ctx, "feedbackthreads", threadsIp, 60)) {
    return json({ ok: false, error: "Too many requests. Please wait a moment." }, 429, { "Cache-Control": "no-store" });
  }
  let threadIds = [];
  let creatorName = null;
  let creatorKey = null;
  if (request.method === "POST") {
    try {
      const body = await readJsonObject(request);
      if (Array.isArray(body.threadIds)) threadIds = body.threadIds.map((t) => String(t).trim()).filter(Boolean);
      if (body.creatorName) creatorName = String(body.creatorName).trim().toLowerCase();
      if (body.creatorKey) creatorKey = String(body.creatorKey);
    } catch {}
  } else {
    const pIds = url.searchParams.get("threadIds");
    if (pIds) threadIds = pIds.split(",").map((s) => s.trim()).filter(Boolean);
    const pCreator = url.searchParams.get("creatorName");
    if (pCreator) creatorName = pCreator.trim().toLowerCase();
    // The Creator Key is never accepted from a URL; see
    // refuseQueryCredentials. The builder page always POSTs.
    const refusedFb = refuseQueryCredentials(url, ["creatorKey"]);
    if (refusedFb) return refusedFb;
  }

  // Looking a creator up BY NAME returns their whole support history --
  // free-text messages plus the optional `contact` field the feedback
  // form explicitly asks for. That used to require nothing but the
  // username, which /lists/public.json publishes for everyone who has
  // ever shared a list, so anyone could harvest every user's
  // correspondence and contact details by iterating the directory.
  //
  // The name-based scan below now requires the account's own key. The
  // threadIds path is deliberately left unauthenticated: a thread id
  // is a capability (it is only ever shown to the person who filed the
  // report), and anonymous users with no account at all rely on it to
  // follow up on what they submitted.
  // authenticateCreator is declared further down in
  // 26_api-creator-and-admin-routes.js, which is the same function
  // body as this file after the build concatenates them -- a hoisted
  // function declaration, so it is in scope here.
  if (creatorName) {
    const auth = await authenticateCreatorFor(request, env, ctx, path, creatorName, creatorKey);
    if (!auth.ok) {
      return json({ ok: false, error: "Username or Key is incorrect." }, 401, { "Cache-Control": "no-store" });
    }
    creatorName = auth.username;
  }

  const threadsMap = new Map();

  // 1. Fetch explicitly listed thread IDs
  if (threadIds.length) {
    const lookups = threadIds.slice(0, 20).map(async (tid) => {
      try {
        let entry = null;
        if (env && env.DB) {
          try {
            const row = await env.DB.prepare("SELECT body_json FROM feedback WHERE id = ?").bind(tid).first();
            if (row && row.body_json) entry = JSON.parse(row.body_json);
          } catch {}
        }
        if (!entry && env && env.CONFIGS) {
          const raw = await env.CONFIGS.get(`feedback:${tid}`);
          if (raw) entry = JSON.parse(raw);
        }
        if (entry) {
          if (!Array.isArray(entry.messages) || !entry.messages.length) {
            entry.messages = [{
              id: `msg_init`,
              sender: "user",
              senderName: entry.creatorName || "User",
              text: entry.message || "(Initial message)",
              timestamp: entry.createdAt || Date.now()
            }];
          }
          threadsMap.set(entry.id, entry);
        }
      } catch {}
    });
    await Promise.all(lookups);
  }

  // 2. If creatorName is given, also load every thread filed under that account
  if (creatorName) {
    for (const entry of await findFeedbackThreadsByCreator(env, creatorName)) {
      if (threadsMap.has(entry.id)) continue;
      if (!Array.isArray(entry.messages) || !entry.messages.length) {
        entry.messages = [{
          id: `msg_init`,
          sender: "user",
          senderName: entry.creatorName || "User",
          text: entry.message || "(Initial message)",
          timestamp: entry.createdAt || Date.now()
        }];
      }
      threadsMap.set(entry.id, entry);
    }
  }

  const threads = Array.from(threadsMap.values()).sort((a, b) => {
    const timeA = a.updatedAt || a.createdAt || 0;
    const timeB = b.updatedAt || b.createdAt || 0;
    return timeB - timeA;
  });

  return json({ ok: true, threads }, 200, { "Cache-Control": "no-store" });
}

// /api/feedback/delete (POST) { threadIds?, creatorName?, creatorKey? } -> { ok, deleted }
// Settings > Support: "Delete chat history". Removes the threads from the
// database and the KV copy, for good, so the developer's panel loses them too.
//
// Who may delete what is the rule replying already follows. A thread nobody
// owns is a bare capability -- whoever holds its id can delete it, which is
// how an anonymous reporter, with no account, clears their own. A thread
// that belongs to an account takes that account's key. Signing in with the
// key also removes every thread filed under the account, including ones
// this device never saw. An id that belongs to somebody else is skipped,
// not an error: `deleted` says how many went.
async function apiFeedbackDelete(request, env, ctx, path) {
  if (!env || !env.CONFIGS) return json({ ok: true, deleted: 0 }, 200, { "Cache-Control": "no-store" });
  const deleteIp = clientIpKey(request);
  if (await consumeRateLimit(env, ctx, "feedbackdelete", deleteIp, 20)) {
    return json({ ok: false, error: "Too many requests. Please wait a moment." }, 429, { "Cache-Control": "no-store" });
  }
  let body = null;
  try { body = await readJsonObject(request); } catch {}
  body = body && typeof body === "object" ? body : {};
  const threadIds = Array.isArray(body.threadIds) ? body.threadIds.map((t) => String(t).trim()).filter(Boolean).slice(0, 30) : [];
  let owner = null;
  if (body.creatorName) {
    const auth = await authenticateCreatorFor(request, env, ctx, path, String(body.creatorName).trim().toLowerCase(), body.creatorKey ? String(body.creatorKey) : "");
    if (!auth.ok) {
      return json({ ok: false, error: "Username or Key is incorrect." }, 401, { "Cache-Control": "no-store" });
    }
    owner = auth.username;
  }

  const doomed = new Set();
  for (const tid of threadIds) {
    let entry = null;
    if (env.DB) {
      try {
        const row = await env.DB.prepare("SELECT body_json FROM feedback WHERE id = ?").bind(tid).first();
        if (row && row.body_json) entry = JSON.parse(row.body_json);
      } catch {}
    }
    if (!entry) {
      try {
        const raw = await env.CONFIGS.get(`feedback:${tid}`);
        if (raw) entry = JSON.parse(raw);
      } catch {}
    }
    if (!entry) continue;
    const ownerRaw = entry.creatorName ? String(entry.creatorName).trim() : "";
    let ownerNorm = "";
    if (ownerRaw) {
      const v = validateCreatorUsername(ownerRaw);
      if (v && v.ok) ownerNorm = v.normalized;
    }
    if (ownerNorm && ownerNorm !== owner) continue;
    doomed.add(tid);
  }
  if (owner) {
    for (const entry of await findFeedbackThreadsByCreator(env, owner)) doomed.add(entry.id);
  }

  let deleted = 0;
  for (const tid of doomed) {
    if (env.DB) {
      try {
        await env.DB.prepare("DELETE FROM feedback WHERE id = ?").bind(tid).run();
      } catch (dbErr) {
        console.error("D1 write error (feedback delete):", dbErr);
      }
    }
    try {
      await env.CONFIGS.delete(`feedback:${tid}`);
      deleted++;
    } catch (e) {
      safeErrorMessage(e);
    }
  }
  return json({ ok: true, deleted }, 200, { "Cache-Control": "no-store" });
}

// /api/track-search  (POST)  { query } -> { ok }
// Fire-and-forget anonymous search query telemetry
async function apiTrackSearch(request, env, ctx) {
  if (!env || !env.CONFIGS) return json({ ok: true });
  let body;
  try { body = await readJsonObject(request); } catch { return json({ ok: true }); }
  // recordSearchQuery keys `searchquery:{q}:days` on the query text
  // itself, so like /api/track-event this is an unauthenticated write
  // whose key name comes from the caller. Same per-IP bucket, same
  // ok:true-on-limit behaviour (it's a beacon, not a feature).
  const searchIp = clientIpKey(request);
  if (!searchIp) return json({ ok: true });
  if (await consumeRateLimit(env, ctx, "tracksearch", searchIp, 30)) return json({ ok: true });

  if (body && typeof body.query === "string" && body.query.trim()) {
    ctx.waitUntil(recordSearchQuery(env, body.query.trim()));
  }
  return json({ ok: true });
}

// /api/track-event  (POST)  { events: [{ eventType, id, title, mediaType }, ...] } -> { ok }
// Fire-and-forget analytics beacon feeding recordTrackedEvent above --
// "watched" for anything marked watched, "list-add" for anything added
// to a Custom List, "list-copy" for imported lists, "catalog-add" for installed catalogs.
async function apiTrackEvent(request, env, ctx, url) {
  if (!env || !env.CONFIGS) return json({ ok: true });
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: true });
  }
  // Unauthenticated, and every branch below writes a KV key derived
  // from caller input -- so it gets the same per-IP bucket the other
  // anonymous write endpoints here use. Returns ok:true rather than
  // 429 on purpose: this is a fire-and-forget beacon, and a real
  // client has nothing useful to do with a rejection.
  const trackIp = clientIpKey(request);
  if (!trackIp) return json({ ok: true });
  if (await consumeRateLimit(env, ctx, "trackevent", trackIp, 30)) return json({ ok: true });

  const events = Array.isArray(body.events) ? body.events.slice(0, 50) : [];
  // "catalog-add" is deliberately absent: no client has ever sent it
  // (installed catalogs are counted by /api/track-install, which feeds
  // stats:sourcegroup: instead), so the only thing that branch could
  // still do was let an anonymous caller mint stats:catalog_add: keys
  // that nothing legitimate ever writes.
  const allowedTypes = new Set(["watched", "list-add", "list-copy"]);
  await Promise.all(
    events.map((e) => {
      if (!e || !allowedTypes.has(e.eventType)) return Promise.resolve();
      if (e.eventType === "list-copy") {
        // Only this add-on's own lists, keyed by the slug the admin
        // panel actually reads -- see recordListCopySlug (03_admin.js).
        const slug = recordListCopySlug(e.id, url.origin);
        if (slug) return bumpStat(env, `list_copy:${slug}`);
        return Promise.resolve();
      }
      if (!e.id) return Promise.resolve();
      // The id becomes part of three permanent KV key names
      // (evtcount:/evtmeta:), so it is constrained to the shape a real
      // title id actually has -- "tt123", "tt123:1:2", "tmdb:456",
      // "channel_x", a bare TMDB number. Truncating to 100 characters
      // bounded the length but not the contents, which let arbitrary
      // text (including markup) end up in key names.
      const evtId = String(e.id).trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,99}$/.test(evtId) || isJunkTrackedId(evtId)) return Promise.resolve();
      return recordTrackedEvent(
        env,
        e.eventType,
        evtId,
        String(e.title || "").slice(0, 200),
        e.mediaType === "series" ? "series" : "movie"
      );
    })
  );
  return json({ ok: true });
}

// /api/mdblist-my-lists?apikey=... OR ?accessToken=...
// -> powers the "Your MDBList Lists" section in the builder: includes
// your Watchlist, Watch History, and all created public & private lists.
async function apiMdblistMyLists(request, url) {
  // An MDBList API key or access token is full access to that MDBList
  // account, so it travels in a POST body only -- see refuseQueryCredentials.
  const refusedMdb = refuseQueryCredentials(url, ["apikey", "accessToken", "key"]);
  if (refusedMdb) return refusedMdb;
  let mdbBody = {};
  if (request.method === "POST") {
    try { mdbBody = (await request.json()) || {}; } catch { mdbBody = {}; }
  }
  const apikey = String(mdbBody.apikey || "").trim();
  const accessToken = String(mdbBody.accessToken || "").trim();
  if (!apikey && !accessToken) return json({ ok: false, error: "Missing apikey or accessToken." }, 400);
  try {
    const token = accessToken || apikey;
    const headers = { "User-Agent": `my-list-addon/${ADDON_VERSION}` };
    if (accessToken) {
      headers["Authorization"] = `Bearer ${accessToken}`;
    }
    const targetUrl = `https://api.mdblist.com/lists/user?apikey=${encodeURIComponent(token)}`;
    const res = await fetch(targetUrl, {
      headers,
      cf: { cacheTtl: 60, cacheEverything: false },
    });
    if (!res.ok) {
      // 429 means MDBList's own rate limit was hit -- a bad/expired
      // key would come back as 401/403, not 429, so don't tell the
      // person to "double check the API key" for a rate limit; that
      // sends them looking in the wrong place. See the matching hint
      // logic in fetchMdblistList (06_source-fetchers-mdblist-trakt.js)
      // for the same distinction on the other MDBList call site.
      const hint = res.status === 429
        ? " MDBList's rate limit was hit -- wait a bit and try again."
        : (res.status === 401 || res.status === 403 ? " Double check the API key or connection." : "");
      return json({ ok: false, error: `MDBList request failed (HTTP ${res.status}).${hint}` });
    }
    const data = await res.json();
    const rawLists = Array.isArray(data) ? data : Array.isArray(data.lists) ? data.lists : [];

    let username = "";
    for (const l of rawLists) {
      if (l && (l.user_name || l.username || l.user)) {
        username = l.user_name || l.username || l.user;
        break;
      }
    }

    if (!username) {
      try {
        const uRes = await fetch(`https://api.mdblist.com/user?apikey=${encodeURIComponent(token)}`, {
          headers,
          cf: { cacheTtl: 300, cacheEverything: false },
        });
        if (uRes.ok) {
          const uData = await uRes.json();
          if (uData) {
            username = uData.user || uData.username || uData.user_name || uData.name || "";
          }
        }
      } catch {}
    }

    const lists = rawLists
      .filter((l) => l && (l.slug || l.id))
      .map((l) => {
        const itemUser = l.user_name || l.username || l.user || username || "";
        return {
          id: l.id != null ? String(l.id) : (l.slug || ""),
          name: l.name || l.slug,
          slug: l.slug,
          dynamic: !!l.dynamic,
          mediatype: l.mediatype || "",
          contentType: l.mediatype === "show" ? "series" : (l.mediatype === "movie" ? "movie" : "unknown"),
          items: l.items || 0,
          likes: l.likes || 0,
          private: l.public === false || l.private === true,
          url: itemUser ? `https://mdblist.com/lists/${encodeURIComponent(itemUser)}/${encodeURIComponent(l.slug)}` : `https://mdblist.com/lists/${encodeURIComponent(l.slug)}`,
        };
      });
    return await apiMdblistMyListsShelves(token, headers, rawLists, username, lists);
  } catch (err) {
    return json({ ok: false, error: safeErrorMessage(err) });
  }
}

// The rest of apiMdblistMyLists, moved unchanged: the same statements in the same order, split only for the 150-line limit.
async function apiMdblistMyListsShelves(token, headers, rawLists, username, lists) {
  let mdblistAiringCandidates = [];
  let wlItemCount = 0;
  let wlSampleItems = [];
  let mdblistUpNextCandidates = [];
  try {
    const authQuery = `?apikey=${encodeURIComponent(token)}`;
    const [showsRes, epsRes, wlRes, wlItemsRes, wlSyncRes, upnextRes] = await Promise.all([
      fetch(`https://api.mdblist.com/sync/watched${authQuery}&mediatype=show&limit=50&append_to_response=poster`, {
        headers,
        cf: { cacheTtl: 60, cacheEverything: false },
      }).catch(() => null),
      fetch(`https://api.mdblist.com/sync/watched${authQuery}&mediatype=episode&limit=50&append_to_response=poster`, {
        headers,
        cf: { cacheTtl: 60, cacheEverything: false },
      }).catch(() => null),
      fetch(`https://api.mdblist.com/watchlist${authQuery}`, {
        headers,
        cf: { cacheTtl: 120, cacheEverything: false },
      }).catch(() => null),
      fetch(`https://api.mdblist.com/watchlist/items${authQuery}`, {
        headers,
        cf: { cacheTtl: 120, cacheEverything: false },
      }).catch(() => null),
      fetch(`https://api.mdblist.com/sync/watchlist${authQuery}`, {
        headers,
        cf: { cacheTtl: 120, cacheEverything: false },
      }).catch(() => null),
      fetch(`https://api.mdblist.com/upnext${authQuery}&limit=50&hide_unreleased=true&append_to_response=poster`, {
        headers,
        cf: { cacheTtl: 60, cacheEverything: false },
      }).catch(() => null),
    ]);

    await apiMdblistMyListsUpNext(mdblistUpNextCandidates, upnextRes);

    const rawAiringItems = [];
    if (showsRes && showsRes.ok) {
      const d = await showsRes.json().catch(() => []);
      if (Array.isArray(d)) rawAiringItems.push(...d);
      else if (d && Array.isArray(d.shows)) rawAiringItems.push(...d.shows);
      else if (d && Array.isArray(d.results)) rawAiringItems.push(...d.results);
    }
    if (epsRes && epsRes.ok) {
      const d = await epsRes.json().catch(() => []);
      if (Array.isArray(d)) rawAiringItems.push(...d);
      else if (d && Array.isArray(d.episodes)) rawAiringItems.push(...d.episodes);
      else if (d && Array.isArray(d.results)) rawAiringItems.push(...d.results);
    }

    let wlAll = [];
    const wlResponses = [wlRes, wlItemsRes, wlSyncRes];
    for (const r of wlResponses) {
      if (r && r.ok) {
        const d = await r.json().catch(() => null);
        if (d) {
          const target = d.watchlist || d.data || d;
          if (Array.isArray(target) && target.length) {
            wlAll = target;
            break;
          } else if (target && typeof target === "object") {
            const movies = Array.isArray(target.movies) ? target.movies : [];
            const shows = Array.isArray(target.shows) ? target.shows : [];
            const series = Array.isArray(target.series) ? target.series : [];
            const episodes = Array.isArray(target.episodes) ? target.episodes : [];
            const seasons = Array.isArray(target.seasons) ? target.seasons : [];
            const results = Array.isArray(target.results) ? target.results : [];
            const items = Array.isArray(target.items) ? target.items : [];
            const combined = [...movies, ...shows, ...series, ...episodes, ...seasons, ...results, ...items];
            if (combined.length) {
              wlAll = combined;
              break;
            }
          }
        }
      }
    }

    if (!wlAll.length) {
      const wlListObj = rawLists.find(l => l && (l.slug === 'watchlist' || (l.name && l.name.toLowerCase() === 'watchlist') || l.is_watchlist || l.watchlist));
      if (wlListObj && wlListObj.id) {
        const customWlRes = await fetch(`https://api.mdblist.com/lists/${encodeURIComponent(wlListObj.id)}/items${authQuery}`, { headers }).catch(() => null);
        if (customWlRes && customWlRes.ok) {
          const customWlData = await customWlRes.json().catch(() => null);
          if (Array.isArray(customWlData)) wlAll = customWlData;
          else if (customWlData && typeof customWlData === "object") {
            wlAll = [
              ...(Array.isArray(customWlData.movies) ? customWlData.movies : []),
              ...(Array.isArray(customWlData.shows) ? customWlData.shows : []),
              ...(Array.isArray(customWlData.results) ? customWlData.results : []),
              ...(Array.isArray(customWlData.items) ? customWlData.items : []),
            ];
          }
        }
      }
    }

    if (wlAll.length) {
      rawAiringItems.push(...wlAll);
      const parsedMetas = (typeof mapMdblistItems === "function") ? mapMdblistItems(wlAll, "mixed") : [];
      wlItemCount = parsedMetas.length || wlAll.length;
      wlSampleItems = parsedMetas.slice(0, 10);
    }

    await apiMdblistMyListsAiringItems(mdblistAiringCandidates, rawAiringItems);
  } catch (e) {
    console.error("/api/mdblist-my-lists: the Airing / Up Next block failed; the shelf is left out", e);
  }
  return apiMdblistMyListsCards(username, lists, mdblistAiringCandidates, wlItemCount, wlSampleItems, mdblistUpNextCandidates);
}

// The rest of apiMdblistMyListsShelves, moved unchanged: the same statements in the same order, split only for the 150-line limit.
async function apiMdblistMyListsCards(username, lists, mdblistAiringCandidates, wlItemCount, wlSampleItems, mdblistUpNextCandidates) {
  const upNextCard = {
    name: "MDBList Up Next",
    slug: "upnext",
    statusKey: "upnext",
    type: "series",
    contentType: "series",
    itemCount: mdblistUpNextCandidates.length,
    items: mdblistUpNextCandidates,
    private: true,
    url: "mdblist:user:shows:upnext",
  };

  const watchlistCard = {
    name: "MDBList My Watch List",
    slug: "watchlist",
    items: wlItemCount,
    likes: 0,
    private: true,
    url: "mdblist:watchlist",
    contentType: "unknown",
    previewItems: wlSampleItems,
  };

  const historyCard = {
    name: "MDBList Watch History",
    slug: "history",
    items: 0,
    likes: 0,
    private: true,
    url: "mdblist:history",
    contentType: "unknown",
  };

  const airingNextCard = {
    name: "MDBList Airing Next",
    slug: "airing-next",
    statusKey: "airing-next",
    type: "series",
    contentType: "series",
    itemCount: mdblistAiringCandidates.length,
    items: mdblistAiringCandidates,
    private: true,
    url: "mdblist:user:shows:airing-next",
  };

  return json({ ok: true, lists: [upNextCard, airingNextCard, watchlistCard, historyCard, ...lists], username }, 200, { "Cache-Control": "no-store" }); // no-store: a per-person answer keyed on a credential in the URL (see A12).
}

// A part of apiMdblistMyLists, moved unchanged: the same statements in the same order, split out only for the 150-line limit.
async function apiMdblistMyListsUpNext(mdblistUpNextCandidates, upnextRes) {
  if (upnextRes && upnextRes.ok) {
    const upData = await upnextRes.json().catch(() => null);
    const upItems = Array.isArray(upData) ? upData : (upData && Array.isArray(upData.items) ? upData.items : (upData && Array.isArray(upData.results) ? upData.results : []));
    for (const it of upItems) {
      if (!it) continue;
      const extracted = typeof extractMdblistItem === "function" ? extractMdblistItem(it) : null;
      const nextEp = it.next_episode || (extracted && extracted.nextEpisode) || null;
      const imdbId = it.imdb_id || (extracted && extracted.imdbId) || (typeof it.id === "string" && it.id.startsWith("tt") ? it.id : null);
      const tmdbId = it.tmdb_id || (extracted && extracted.tmdbId) || null;
      const bestId = (extracted && extracted.id) || imdbId || (tmdbId ? `tmdb:${tmdbId}` : String(it.id));
      const sNum = nextEp ? (nextEp.season != null ? nextEp.season : 1) : (it.season != null ? it.season : null);
      const eNum = nextEp ? (nextEp.episode != null ? nextEp.episode : (nextEp.number != null ? nextEp.number : 1)) : (it.episode != null ? it.episode : null);
      const epTitle = nextEp ? (nextEp.title || nextEp.name || "") : (it.episode_title || "");
      const showTitle = it.title || it.name || (extracted && (extracted.showTitle || extracted.name)) || "Show";
      const fullId = (sNum != null && eNum != null) ? `${bestId}:${sNum}:${eNum}` : bestId;
      let posterUrl = it.poster || (extracted && extracted.poster) || "";
      if (typeof posterUrl === "string" && posterUrl.startsWith("/")) {
        posterUrl = "https://image.tmdb.org/t/p/w500" + posterUrl;
      }
      if (!posterUrl && imdbId && String(imdbId).startsWith("tt")) {
        posterUrl = `https://images.metahub.space/poster/medium/${imdbId}/img`;
      }
      mdblistUpNextCandidates.push({
        id: fullId,
        showId: bestId,
        imdbId: imdbId || null,
        tmdbId: tmdbId || null,
        name: showTitle,
        title: (sNum != null && eNum != null) ? `${showTitle} S${String(sNum).padStart(2, "0")}E${String(eNum).padStart(2, "0")}` : showTitle,
        episodeTitle: epTitle,
        seasonNum: sNum,
        episodeNum: eNum,
        year: it.year || (extracted && extracted.releaseInfo) || "",
        poster: posterUrl,
        type: "series",
        lastWatched: it.last_watched || it.last_watched_at || null,
        airDate: nextEp ? (nextEp.air_date || nextEp.air_date_utc || "") : "",
      });
    }
  }
}

// A part of apiMdblistMyLists, moved unchanged: the same statements in the same order, split out only for the 150-line limit.
async function apiMdblistMyListsAiringItems(mdblistAiringCandidates, rawAiringItems) {
  const seenIds = new Set();
  for (const it of rawAiringItems) {
    const extracted = typeof extractMdblistItem === "function" ? extractMdblistItem(it) : null;
    if (extracted && (extracted.mediatype === "series" || extracted.mediatype === "show" || extracted.mediatype === "tv" || extracted.season != null || extracted.episode != null)) {
      const bestId = extracted.id;
      if (bestId && !seenIds.has(bestId)) {
        seenIds.add(bestId);
        mdblistAiringCandidates.push({
          id: bestId,
          imdbId: extracted.imdbId || null,
          tmdbId: extracted.tmdbId || null,
          name: extracted.showTitle || extracted.name || "",
          year: extracted.releaseInfo || "",
          poster: extracted.poster || (extracted.imdbId ? `https://images.metahub.space/poster/medium/${extracted.imdbId}/img` : ""),
          type: "series",
        });
      }
    }
  }
}

// /api/mdblist-history-raw (POST) { apikey, accessToken, username? } -> { ok, items }
async function apiMdblistHistoryRaw(request) {
  let body;
  try { body = await readJsonObject(request); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400); }
  const apikey = String(body.apikey || "").trim();
  const accessToken = String(body.accessToken || "").trim();
  let username = String(body.username || "").trim();
  const token = accessToken || apikey;
  if (!token && !username) return json({ ok: false, error: "Not connected to MDBList." }, 400);
  try {
    const headers = { "User-Agent": `my-list-addon/${ADDON_VERSION}`, "Accept": "application/json" };
    const authQuery = accessToken ? "" : `?apikey=${encodeURIComponent(apikey)}`;
    if (accessToken) {
      headers["Authorization"] = `Bearer ${accessToken}`;
    }

    if (!username) {
      try {
        const userListsRes = await fetch(`https://api.mdblist.com/lists/user${authQuery}`, { headers });
        if (userListsRes.ok) {
          const udata = await userListsRes.json();
          const raw = Array.isArray(udata) ? udata : (Array.isArray(udata.lists) ? udata.lists : []);
          const found = raw.find((l) => l && l.user_name);
          if (found) username = found.user_name;
        }
      } catch {}
    }

    // Fetch all history from MDBList /sync/watched across mediatypes (movie, show, episode)
    let allItems = [];
    const logs = [];
    const LIMIT = 1000;
    const MAX_PAGES = 10;

    const mediatypes = ["movie", "show", "episode"];
    for (const mt of mediatypes) {
      let cursor = null;
      let offset = 0;
      let hasMore = true;
      let pageCount = 0;

      while (hasMore && pageCount < MAX_PAGES) {
        pageCount++;
        const sep = authQuery ? "&" : "?";
        const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : `&offset=${offset}`;
        const pageUrl = `https://api.mdblist.com/sync/watched${authQuery}${sep}mediatype=${mt}&limit=${LIMIT}${cursorParam}&append_to_response=poster`;
        try {
          const res = await fetch(pageUrl, {
            headers,
            cf: { cacheTtl: 0, cacheEverything: false },
          });
          const text = await res.text();
          let parsed = null;
          try { parsed = JSON.parse(text); } catch {}
          logs.push({ url: pageUrl.replace(apikey, "***").replace(accessToken, "***"), status: res.status, preview: text.slice(0, 120) });
          if (!res.ok || !parsed) break;

          const movies = Array.isArray(parsed.movies) ? parsed.movies : [];
          const shows = Array.isArray(parsed.shows) ? parsed.shows : [];
          const episodes = Array.isArray(parsed.episodes) ? parsed.episodes : [];
          const seasons = Array.isArray(parsed.seasons) ? parsed.seasons : [];
          const results = Array.isArray(parsed.results) ? parsed.results : [];
          const items = Array.isArray(parsed.items) ? parsed.items : [];
          const rawArray = Array.isArray(parsed) ? parsed : [];
          const batch = [...movies, ...shows, ...episodes, ...seasons, ...results, ...items, ...rawArray];
          allItems.push(...batch);

          if (parsed.next_cursor) {
            cursor = parsed.next_cursor;
            hasMore = true;
          } else if (batch.length >= LIMIT) {
            offset += batch.length;
            hasMore = true;
          } else {
            hasMore = false;
          }
        } catch (e) {
          logs.push({ url: pageUrl.replace(apikey, "***").replace(accessToken, "***"), error: safeErrorMessage(e) });
          break;
        }
      }
    }

    // If mediatype queries returned nothing, fallback to unfiltered /sync/watched
    if (!allItems.length) {
      let cursor = null;
      let offset = 0;
      let hasMore = true;
      let pageCount = 0;
      while (hasMore && pageCount < MAX_PAGES) {
        pageCount++;
        const sep = authQuery ? "&" : "?";
        const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : `&offset=${offset}`;
        const pageUrl = `https://api.mdblist.com/sync/watched${authQuery}${sep}limit=${LIMIT}${cursorParam}&append_to_response=poster`;
        try {
          const res = await fetch(pageUrl, {
            headers,
            cf: { cacheTtl: 0, cacheEverything: false },
          });
          const text = await res.text();
          let parsed = null;
          try { parsed = JSON.parse(text); } catch {}
          logs.push({ url: pageUrl.replace(apikey, "***").replace(accessToken, "***"), status: res.status, preview: text.slice(0, 120) });
          if (!res.ok || !parsed) break;

          const movies = Array.isArray(parsed.movies) ? parsed.movies : [];
          const shows = Array.isArray(parsed.shows) ? parsed.shows : [];
          const episodes = Array.isArray(parsed.episodes) ? parsed.episodes : [];
          const seasons = Array.isArray(parsed.seasons) ? parsed.seasons : [];
          const results = Array.isArray(parsed.results) ? parsed.results : [];
          const items = Array.isArray(parsed.items) ? parsed.items : [];
          const rawArray = Array.isArray(parsed) ? parsed : [];
          const batch = [...movies, ...shows, ...episodes, ...seasons, ...results, ...items, ...rawArray];
          allItems.push(...batch);

          if (parsed.next_cursor) {
            cursor = parsed.next_cursor;
            hasMore = true;
          } else if (batch.length >= LIMIT) {
            offset += batch.length;
            hasMore = true;
          } else {
            hasMore = false;
          }
        } catch (e) {
          logs.push({ url: pageUrl.replace(apikey, "***").replace(accessToken, "***"), error: safeErrorMessage(e) });
          break;
        }
      }
    }

    return json({ ok: true, items: allItems, debug: logs });
  } catch (err) {
    return json({ ok: false, error: safeErrorMessage(err) });
  }
}
