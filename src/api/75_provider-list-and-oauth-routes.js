// IMDb id and recommendation lookups, list search/browse for TMDB and Trakt, and the Trakt, MDBList and Simkl sign-in and list routes, moved out of handleFetch (CQ-01).

// Moved unchanged: each route body is now its own function; the dispatcher keeps each route's
// original path/method test and is a plain function that returns a Response promise or null.

// /api/imdb-ids, /api/recommendations, the TMDB and Trakt list search/browse routes and the Trakt, MDBList and Simkl OAuth start/callback, device-code and my-lists routes, at their original place. Returns a Response promise, or null.
function handleProviderListRoutes(request, env, ctx, url, path) {
  if (path === "/api/imdb-ids" && request.method === "POST") return apiImdbIds(request, env, ctx);
  if (path === "/api/recommendations" && request.method === "POST") return apiRecommendations(request, env, ctx);
  if (path === "/api/tmdb-search-lists") return apiTmdbSearchLists(request, env, ctx, url);
  if (path === "/api/trakt-search") return apiTraktSearch(env, ctx, url);
  if (path === "/api/trakt-popular-lists") return apiTraktPopularLists(env, ctx, url);
  if (path === "/api/trakt-my-lists") return apiTraktMyLists(env, ctx, url);
  if (path === "/api/trakt/oauth/start") return apiTraktOauthStart(url);
  if (path === "/api/trakt/oauth/callback") return apiTraktOauthCallback(request, env, url);
  if (path === "/api/trakt/device/code" && request.method === "POST") return apiTraktDeviceCode(request, env);
  if (path === "/api/trakt/device/token" && request.method === "POST") return apiTraktDeviceToken(request, env);
  if (path === "/api/mdblist/oauth/start") return apiMdblistOauthStart(env, url);
  if (path === "/api/mdblist/oauth/callback") return apiMdblistOauthCallback(request, env, url);
  if (path === "/api/simkl/oauth/start") return apiSimklOauthStart(env, url);
  if (path === "/api/simkl/oauth/callback") return apiSimklOauthCallback(request, env, url);
  if (path === "/api/simkl/my-lists") return apiSimklMyLists(request, env, url);
  return null;
}

// /api/imdb-ids  (POST)  { items: [{ id, type }] } -> { ok, map: { "tmdb:278": "tt0068646" } }
//
// BetterPosters is keyed by IMDB id and nothing else -- there is no
// /poster/tmdb/... route, it 404s -- so a tile whose item carries only a
// TMDB id cannot have BetterPosters artwork built for it. That is exactly
// what the Curated For You / Recommended cards hold: /api/recommendations
// answers with "tmdb:<n>" ids, because TMDB's recommendation endpoints
// return TMDB ids and nothing else.
//
// fetchCuratedCatalog already pays for the same translation when it serves
// those lists as a catalog (one external_ids call per item, edge-cached for
// a day), which is why the identical rows DO get BetterPosters artwork in
// Live Preview and in Stremio/Nuvio while the dashboard cards did not.
//
// Per-request rather than resolving a whole list up front: the caller asks
// only for the tiles it is about to draw, so a card costs ~9 lookups and a
// See All page up to IMDB_ID_LOOKUP_MAX, IMDB_ID_LOOKUP_CONCURRENCY at a
// time. Every answer is edge-cached for a day, so the second visit costs
// nothing.
async function apiImdbIds(request, env, ctx) {
  let idBody;
  try {
    idBody = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const rawItems = Array.isArray(idBody.items) ? idBody.items.slice(0, IMDB_ID_LOOKUP_MAX) : [];
  if (!rawItems.length) return json({ ok: true, map: {} });
  const idTmdbKey = idBody.tmdbKey || TMDB_API_KEY;

  // Same shape as /api/recommendations above, and for the same reason: a
  // caller spending their own TMDB quota still spends this Worker's
  // subrequest and CPU budget, so the ceiling differs but the limit does
  // not go away.
  const idIp = clientIpKey(request);
  if (!idIp) return json({ ok: false, error: "Could not resolve those ids." }, 400);
  if (await consumeRateLimit(env, ctx, "imdbids", idIp, idBody.tmdbKey ? 240 : 60)) {
    return json({ ok: false, error: "Too many requests just now. Please wait a minute and try again." }, 429);
  }

  const map = {};
  await mapWithConcurrency(rawItems, IMDB_ID_LOOKUP_CONCURRENCY, async (raw) => {
    const key = String((raw && raw.id) || "").trim();
    if (!key.startsWith("tmdb:")) return;
    // The id segment only -- an episode id ("tmdb:1234:1:2") resolves to
    // its show, which is the artwork a poster tile wants anyway.
    const tmdbId = key.slice(5).split(":")[0];
    if (!/^\d{1,12}$/.test(tmdbId)) return;
    const isSeries = (raw && raw.type) === "series" || (raw && raw.type) === "tv";
    try {
      const res = await fetch(
        `https://api.themoviedb.org/3/${isSeries ? "tv" : "movie"}/${tmdbId}/external_ids?api_key=${encodeURIComponent(idTmdbKey)}`,
        { cf: { cacheTtl: 86400, cacheEverything: true } }
      );
      if (!res.ok) return;
      const data = await res.json();
      // Only a real IMDB id is useful here; anything else and the caller
      // keeps the poster it already had.
      if (data && typeof data.imdb_id === "string" && /^tt\d{5,12}$/.test(data.imdb_id)) {
        map[key] = data.imdb_id;
      }
    } catch (e) {}
  });
  return json({ ok: true, map }, 200, { "Cache-Control": "no-store" });
}

// /api/recommendations  (POST)  { movieIds: [...], showIds: [...] } -> { ok, movies: [...], shows: [...] }
// Generates personalized movie and show recommendations from TMDB based on user watch history.
async function apiRecommendations(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const movieIds = Array.isArray(body.movieIds) ? body.movieIds.slice(0, 12) : [];
  const showIds = Array.isArray(body.showIds) ? body.showIds.slice(0, 12) : [];
  const tmdbKey = body.tmdbKey || TMDB_API_KEY;
  // Up to 24 ids, each costing a find + a recommendations call (and a
  // similar call when recommendations comes back empty), so a single
  // request is up to ~72 outbound subrequests.
  //
  // This used to skip the limit ENTIRELY whenever the body carried a
  // tmdbKey, on the reasoning that a caller spending their own quota
  // needs no protecting. True of TMDB's quota; not true of this
  // Worker's. The field was never validated, so `tmdbKey: "x"` bought
  // unlimited invocations of that fan-out against this deployment's own
  // subrequest, CPU and billing budget -- measured at 0 of 40 requests
  // blocked, versus 10 of 40 without the field.
  //
  // So: always limited, only the ceiling differs. A visitor who really
  // has their own key gets far more headroom (they are not competing for
  // the shared key), while the endpoint stops being an open amplifier.
  // The Discover tab issues one of these per load, so even 30/minute is
  // well beyond what a real session needs.
  const recIp = clientIpKey(request);
  if (!recIp) return json({ ok: false, error: "Could not load recommendations." }, 400);
  if (await consumeRateLimit(env, ctx, "recommendations", recIp, body.tmdbKey ? 120 : 30)) {
    return json({ ok: false, error: "Too many requests just now. Please wait a minute and try again." }, 429);
  }

  // Shared with the Recommended catalog row, which builds the same list
  // itself once the website's snapshot of it has gone stale -- see
  // buildTmdbRecommendations (05_catalog-core.js).
  const recs = await buildTmdbRecommendations(movieIds, showIds, tmdbKey);
  return json({ ok: true, movies: recs.movies, shows: recs.shows });
}

// /api/tmdb-search-lists?q=...[&tmdbKey=...]
// -> searches TMDB for Franchise Collections (e.g. Marvel, Harry Potter, Star Wars)
// and matching TMDB Official Charts (Popular, Top Rated, Streaming Channels, etc.)
async function apiTmdbSearchLists(request, env, ctx, url) {
  const q = (url.searchParams.get("q") || "").trim();
  const tmdbKeyParam = url.searchParams.get("tmdbKey") || "";
  const tmdbKey = tmdbKeyParam || TMDB_API_KEY;
  const isAdultFilterActive = url.searchParams.get("adultContentFilter") === "1";
  if (!q || !tmdbKey) {
    return jsonCacheable({ ok: true, lists: [] });
  }
  const searchLimited = await searchRateLimitResponse(request, env, ctx);
  if (searchLimited) return searchLimited;

  try {
    if (!tmdbKeyParam) ctx.waitUntil(bumpStat(env, "apiuse:tmdb"));
    const qLower = q.toLowerCase();
    const results = [];

    // 1. Search TMDB Collections
    const collRes = await fetch(
      `https://api.themoviedb.org/3/search/collection?api_key=${encodeURIComponent(tmdbKey)}&query=${encodeURIComponent(q)}&include_adult=true`,
      {
        headers: { "User-Agent": "my-list-addon/1.14" },
        cf: { cacheTtl: 86400, cacheEverything: true },
      }
    );

    if (collRes.ok) {
      const collData = await collRes.json();
      const collections = Array.isArray(collData.results) ? collData.results : [];
      for (const c of collections.slice(0, 15)) {
        if (!c || !c.id) continue;
        const isCollAdult = c.adult === true || (typeof isAdultOrNsfw === "function" && isAdultOrNsfw({ name: c.name, title: c.name, franchise: c.name }));
        const poster = isAdultFilterActive && isCollAdult
          ? getSafePosterUrl(url.origin, { title: c.name || "Collection", type: "movie", certification: "ADULT" })
          : (c.poster_path ? `https://image.tmdb.org/t/p/w500${c.poster_path}` : undefined);
        results.push({
          name: c.name || "Unnamed Collection",
          user: "TMDB Franchise",
          url: `https://www.themoviedb.org/collection/${c.id}`,
          type: "movie",
          items: "Franchise",
          poster,
          likes: 0,
          isCollection: true,
          adult: isCollAdult,
          isAdult: isCollAdult,
          isAdultPosterFiltered: isAdultFilterActive && isCollAdult,
        });
      }
    }

    // 2. Check TMDB Official Charts matching query
    const builtinTmdbCharts = [
      { name: "TMDB Trending Movies", url: "tmdb:chart:trending", type: "movie", tags: ["trending", "popular", "top", "tmdb"] },
      { name: "TMDB Trending Shows", url: "tmdb:chart:trending", type: "series", tags: ["trending", "popular", "top", "tv", "shows", "tmdb"] },
      { name: "TMDB Popular Movies", url: "tmdb:chart:popular", type: "movie", tags: ["popular", "top", "movies", "tmdb"] },
      { name: "TMDB Popular Shows", url: "tmdb:chart:popular", type: "series", tags: ["popular", "top", "shows", "tv", "tmdb"] },
      { name: "TMDB Top Rated Movies", url: "tmdb:chart:top_rated", type: "movie", tags: ["top rated", "best", "movies", "tmdb"] },
      { name: "TMDB Top Rated Shows", url: "tmdb:chart:top_rated", type: "series", tags: ["top rated", "best", "shows", "tv", "tmdb"] },
      { name: "TMDB Now Playing", url: "tmdb:chart:now_playing", type: "movie", tags: ["now playing", "theater", "cinema", "new", "tmdb"] },
      { name: "TMDB Upcoming Movies", url: "tmdb:chart:upcoming", type: "movie", tags: ["upcoming", "coming soon", "future", "tmdb"] },
      { name: "Netflix Movies", url: "tmdb:chart:netflix", type: "movie", tags: ["netflix", "streaming"] },
      { name: "Netflix Shows", url: "tmdb:chart:netflix", type: "series", tags: ["netflix", "streaming", "shows"] },
      { name: "Apple TV+ Movies", url: "tmdb:chart:appletv", type: "movie", tags: ["apple", "apple tv", "streaming"] },
      { name: "Apple TV+ Shows", url: "tmdb:chart:appletv", type: "series", tags: ["apple", "apple tv", "streaming", "shows"] },
      { name: "Disney+ Movies", url: "tmdb:chart:disney", type: "movie", tags: ["disney", "disney plus", "streaming", "marvel", "star wars"] },
      { name: "Disney+ Shows", url: "tmdb:chart:disney", type: "series", tags: ["disney", "disney plus", "streaming", "shows"] },
      { name: "HBO Max Movies", url: "tmdb:chart:hbomax", type: "movie", tags: ["hbo", "hbo max", "max", "warner"] },
      { name: "HBO Max Shows", url: "tmdb:chart:hbomax", type: "series", tags: ["hbo", "hbo max", "max", "warner", "shows"] },
      { name: "Hulu Movies", url: "tmdb:chart:hulu", type: "movie", tags: ["hulu", "streaming"] },
      { name: "Hulu Shows", url: "tmdb:chart:hulu", type: "series", tags: ["hulu", "streaming", "shows"] },
      { name: "Prime Video Movies", url: "tmdb:chart:primevideo", type: "movie", tags: ["amazon", "prime", "prime video"] },
      { name: "Prime Video Shows", url: "tmdb:chart:primevideo", type: "series", tags: ["amazon", "prime", "prime video", "shows"] },
      { name: "Paramount+ Movies", url: "tmdb:chart:paramount", type: "movie", tags: ["paramount", "paramount plus"] },
      { name: "Paramount+ Shows", url: "tmdb:chart:paramount", type: "series", tags: ["paramount", "paramount plus", "shows"] },
      { name: "Peacock Movies", url: "tmdb:chart:peacock", type: "movie", tags: ["peacock", "nbc"] },
      { name: "Peacock Shows", url: "tmdb:chart:peacock", type: "series", tags: ["peacock", "nbc", "shows"] },
      { name: "Hidden Gems", url: "tmdb:hidden-gems", type: "movie", tags: ["hidden gems", "underrated", "gems", "cult"] },
      { name: "Kids Movies", url: "tmdb:kids:movie", type: "movie", tags: ["kids", "children", "family", "animation", "disney"] },
      { name: "Kids Shows", url: "tmdb:kids:tv", type: "series", tags: ["kids", "children", "family", "animation", "cartoons"] },
      { name: "Family Movies", url: "tmdb:genre:family", type: "movie", tags: ["family", "genre", "newest", "tmdb"] },
      { name: "Family Shows", url: "tmdb:genre:family", type: "series", tags: ["family", "genre", "newest", "shows", "tv", "tmdb"] },
      { name: "Fantasy Movies", url: "tmdb:genre:fantasy", type: "movie", tags: ["fantasy", "genre", "newest", "tmdb"] },
      { name: "Fantasy Shows", url: "tmdb:genre:fantasy", type: "series", tags: ["fantasy", "genre", "newest", "shows", "tv", "tmdb"] },
      { name: "History Movies", url: "tmdb:genre:history", type: "movie", tags: ["history", "historical", "genre", "newest", "tmdb"] },
      { name: "History Shows", url: "tmdb:genre:history", type: "series", tags: ["history", "historical", "genre", "newest", "shows", "tv", "tmdb"] },
      { name: "Horror Movies", url: "tmdb:genre:horror", type: "movie", tags: ["horror", "scary", "genre", "newest", "tmdb"] },
      { name: "Horror Shows", url: "tmdb:genre:horror", type: "series", tags: ["horror", "scary", "genre", "newest", "shows", "tv", "tmdb"] },
      { name: "Mystery Movies", url: "tmdb:genre:mystery", type: "movie", tags: ["mystery", "detective", "genre", "newest", "tmdb"] },
      { name: "Mystery Shows", url: "tmdb:genre:mystery", type: "series", tags: ["mystery", "detective", "genre", "newest", "shows", "tv", "tmdb"] },
      { name: "Romance Movies", url: "tmdb:genre:romance", type: "movie", tags: ["romance", "romantic", "love", "genre", "newest", "tmdb"] },
      { name: "Romance Shows", url: "tmdb:genre:romance", type: "series", tags: ["romance", "romantic", "love", "genre", "newest", "shows", "tv", "tmdb"] },
      { name: "Science Fiction Movies", url: "tmdb:genre:science-fiction", type: "movie", tags: ["science fiction", "scifi", "sci-fi", "genre", "newest", "tmdb"] },
      { name: "Science Fiction Shows", url: "tmdb:genre:science-fiction", type: "series", tags: ["science fiction", "scifi", "sci-fi", "genre", "newest", "shows", "tv", "tmdb"] },
      { name: "Stream Releases Movies", url: "tmdb:genre:stream-releases", type: "movie", tags: ["stream releases", "streaming", "newest", "tmdb"] },
      { name: "Stream Releases Shows", url: "tmdb:genre:stream-releases", type: "series", tags: ["stream releases", "streaming", "newest", "shows", "tv", "tmdb"] },
      { name: "Thriller Movies", url: "tmdb:genre:thriller", type: "movie", tags: ["thriller", "suspense", "genre", "newest", "tmdb"] },
      { name: "Thriller Shows", url: "tmdb:genre:thriller", type: "series", tags: ["thriller", "suspense", "genre", "newest", "shows", "tv", "tmdb"] },
      { name: "War Movies", url: "tmdb:genre:war", type: "movie", tags: ["war", "military", "genre", "newest", "tmdb"] },
      { name: "War Shows", url: "tmdb:genre:war", type: "series", tags: ["war", "military", "genre", "newest", "shows", "tv", "tmdb"] },
      { name: "Western Movies", url: "tmdb:genre:western", type: "movie", tags: ["western", "cowboy", "genre", "newest", "tmdb"] },
      { name: "Western Shows", url: "tmdb:genre:western", type: "series", tags: ["western", "cowboy", "genre", "newest", "shows", "tv", "tmdb"] },
      { name: "Simkl Anime Trending", url: "simkl:anime:trending", type: "series", source: "Simkl", user: "Simkl Official", tags: ["simkl", "anime", "trending", "animation", "japanese", "otaku", "charts"] },
      { name: "Simkl Top 50 Anime", url: "simkl:anime:top", type: "series", source: "Simkl", user: "Simkl Official", tags: ["simkl", "anime", "top", "best", "popular", "animation", "charts"] },
      { name: "Simkl Airing Anime", url: "simkl:anime:airing", type: "series", source: "Simkl", user: "Simkl Official", tags: ["simkl", "anime", "airing", "new", "season", "charts"] },
      { name: "Simkl Trending Shows", url: "simkl:shows:trending", type: "series", source: "Simkl", user: "Simkl Official", tags: ["simkl", "shows", "trending", "tv", "popular", "charts"] },
      { name: "Simkl Trending Movies", url: "simkl:movies:trending", type: "movie", source: "Simkl", user: "Simkl Official", tags: ["simkl", "movies", "trending", "popular", "charts"] },
    ];

    for (const chart of builtinTmdbCharts) {
      const matchName = chart.name.toLowerCase().includes(qLower);
      const matchTag = chart.tags.some((t) => t.includes(qLower) || qLower.includes(t));
      const matchUser = chart.user && chart.user.toLowerCase().includes(qLower);
      if (matchName || matchTag || matchUser) {
        results.push({
          name: chart.name,
          user: chart.user || "TMDB Official",
          url: chart.url,
          type: chart.type,
          items: "Chart",
          likes: 0,
          source: chart.source || "TMDB",
        });
      }
    }

    return jsonCacheable({ ok: true, lists: results.slice(0, 30) });
  } catch (err) {
    return json({ ok: false, error: safeErrorMessage(err), lists: [] });
  }
}

// /api/trakt-search?q=...
// -> powers the "Search Trakt Lists" box in the builder page. Proxies
// trakt.tv's public list-search endpoint so people can find and add
// public trakt.tv lists with a click instead of copy-pasting URLs.
async function apiTraktSearch(env, ctx, url) {
  const q = url.searchParams.get("q") || "";
  const traktKey = url.searchParams.get("traktKey") || "";

  try {
    const lists = await searchTraktLists(q, traktKey);
    if (!traktKey) ctx.waitUntil(bumpStatBy(env, "apiuse:trakt", 1 + lists.length));
    return jsonCacheable({ ok: true, lists });
  } catch (err) {
    return json({ ok: false, error: safeErrorMessage(err) });
  }
}

// /api/trakt-popular-lists?traktKey=...
// -> returns popular public community lists directly from Trakt's API
async function apiTraktPopularLists(env, ctx, url) {
  const traktKeyParam = url.searchParams.get("traktKey") || "";
  const traktKey = traktKeyParam || TRAKT_CLIENT_ID;
  if (!traktKey) {
    return json({ ok: false, lists: [] });
  }
  try {
    const cacheKey = "user_cache:trakt:popular-lists";
    const kvKey = "trakt:popular-lists";
    const lists = await fetchWithPerUserCacheAndCircuitBreaker({
      cacheKey,
      kvKey,
      env,
      ctx,
      freshTtlSec: 3600,
      staleTtlSec: 86400,
      kvTtlSec: 86400,
      providerLabel: "Trakt Popular Lists",
      fetchFn: async () => {
        const src = "https://api.trakt.tv/lists/popular?limit=30";
        const res = await fetchTraktWithRetry(src, {
          headers: traktHeaders(null, traktKey),
          cf: { cacheTtl: 3600, cacheEverything: true },
        });
        if (!res.ok) {
          throw new Error(`Trakt popular lists failed (HTTP ${res.status}).`);
        }
        const data = await res.json();
        return (Array.isArray(data) ? data : [])
          .map((r) => r.list || r)
          .filter((l) => l && l.ids && l.ids.slug && l.user && (l.user.username || (l.user.ids && l.user.ids.slug)))
          .map((l) => {
            // ids.slug FIRST, username only as a fallback. username is
            // Trakt's DISPLAY name and is not always addressable by their
            // API: "Fidel.cb" has to be fetched as "fidel-cb", and
            // building the URL from the display name made that list fail
            // to load at all ("Couldn't load that list."). searchTraktLists
            // (04_config-resolution.js) already prefers the slug for
            // exactly this reason -- which is why the same list has always
            // worked when found through search and not from here.
            const userSlug = (l.user.ids && l.user.ids.slug) || l.user.username;
            const displayName = l.user.username || userSlug;
            const slug = l.ids.slug;
            const name = l.name || slug;
            // Trakt's popular-lists payload carries no media type, and
            // this used to answer "movie" for every single entry. A
            // shows-only list previewed as movies comes back with zero
            // items, so on the Discover feed it rendered with no posters
            // at all and its See All said "No items found" -- for
            // "IMDB: Top Rated TV Shows", "Great Popular Shows" and
            // "Rolling Stone's 100 Greatest TV Shows of All Time" among
            // others, all of which hold 100+ shows.
            //
            // Same name heuristic searchTraktLists uses, including its
            // "unknown" for anything ambiguous. Reported as `type:
            // "mixed"` so the client previews movies AND series and
            // merges them, which is what it already does for an
            // ambiguous search result.
            const isMovie = /\bmovie(s)?\b/i.test(name);
            const isSeries = /\b(show|shows|series|anime|tv|season(s)?)\b/i.test(name);
            const contentType = isMovie && !isSeries ? "movie" : (isSeries && !isMovie ? "series" : "unknown");
            return {
              name: l.name,
              user: displayName,
              slug: slug,
              items: l.item_count || 0,
              likes: l.likes || 0,
              contentType,
              url: `https://trakt.tv/users/${encodeURIComponent(userSlug)}/lists/${encodeURIComponent(slug)}`,
              type: contentType === "unknown" ? "mixed" : contentType,
            };
          });
      },
    });
    return jsonCacheable({ ok: true, lists });
  } catch (err) {
    return json({ ok: false, lists: [] });
  }
}

// /api/trakt-my-lists?username=...&traktKey=...
// -> powers the "Your Trakt Lists" section in the builder: once someone
// fills in a Trakt username, this lists everything they've made public
// at trakt.tv/users/:username/lists (public data -- no OAuth/user-level
// token needed, just the usual app-level Trakt-Api-Key, same as every
// other Trakt call here). traktKey overrides the shared TRAKT_CLIENT_ID
// the same way it does everywhere else.
async function apiTraktMyLists(env, ctx, url) {
  const username = (url.searchParams.get("username") || "").trim();
  const traktKeyParam = url.searchParams.get("traktKey") || "";
  if (!username) return json({ ok: false, error: "Missing username." }, 400);
  const traktKey = traktKeyParam || TRAKT_CLIENT_ID;
  if (!traktKey) {
    return json({ ok: false, error: "Trakt lists are temporarily unavailable. You can enter your own Trakt Client ID in Settings to keep using them." });
  }
  try {
    const src = `https://api.trakt.tv/users/${encodeURIComponent(username)}/lists`;
    const res = await fetchTraktWithRetry(src, {
      headers: traktHeaders(null, traktKey),
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!res.ok) {
      if (res.status === 404) {
        return json({ ok: false, error: `No Trakt user found with the username "${username}".` });
      }
      if (res.status === 403) {
        return json({
          ok: false,
          error: traktKeyParam
            ? "Trakt rejected the Client ID you entered (HTTP 403 = invalid or unapproved app). Double check it against https://trakt.tv/oauth/applications."
            : "Trakt rejected this add-on's API key (HTTP 403 = invalid or unapproved app). Enter your own Trakt Client ID above to bypass this. If it keeps happening, let us know via Feedback.",
        });
      }
      if (res.status === 429) {
        return json({ ok: false, error: "Trakt is temporarily busy (rate limit). Please wait a few seconds and try again." });
      }
      return json({ ok: false, error: `Trakt request failed (HTTP ${res.status}).` });
    }
    const data = await res.json();
    const customLists = (Array.isArray(data) ? data : [])
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
          contentType,
          url: `https://trakt.tv/users/${encodeURIComponent(username)}/lists/${encodeURIComponent(l.ids.slug)}`,
        };
      });

    let watchlistCount = 0;
    let airingCandidates = [];
    try {
      const [wlRes, wShowsRes, wlShowsRes] = await Promise.all([
        fetchTraktWithRetry(`https://api.trakt.tv/users/${encodeURIComponent(username)}/watchlist?limit=1&page=1`, {
          headers: traktHeaders(null, traktKey),
          cf: { cacheTtl: 120, cacheEverything: false },
        }).catch(() => null),
        fetchTraktWithRetry(`https://api.trakt.tv/users/${encodeURIComponent(username)}/watched/shows?extended=noseasons`, {
          headers: traktHeaders(null, traktKey),
          cf: { cacheTtl: 120, cacheEverything: false },
        }).catch(() => null),
        fetchTraktWithRetry(`https://api.trakt.tv/users/${encodeURIComponent(username)}/watchlist/shows?limit=50`, {
          headers: traktHeaders(null, traktKey),
          cf: { cacheTtl: 120, cacheEverything: false },
        }).catch(() => null),
      ]);

      if (wlRes && wlRes.ok) {
        watchlistCount = parseInt(wlRes.headers.get("X-Pagination-Item-Count") || "0", 10) || 0;
      }

      const rawAiring = [];
      if (wShowsRes && wShowsRes.ok) {
        const wData = await wShowsRes.json().catch(() => []);
        if (Array.isArray(wData)) rawAiring.push(...wData);
      }
      if (wlShowsRes && wlShowsRes.ok) {
        const wlData = await wlShowsRes.json().catch(() => []);
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
    return await apiTraktMyListsCards(env, ctx, username, traktKeyParam, customLists, watchlistCount, airingCandidates);
  } catch (err) {
    return json({ ok: false, error: safeErrorMessage(err) });
  }
}

// The rest of apiTraktMyLists, moved unchanged: the same statements in the same order, split only for the 150-line limit.
async function apiTraktMyListsCards(env, ctx, username, traktKeyParam, customLists, watchlistCount, airingCandidates) {
  const airingNextCard = {
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

  const watchlistCard = {
    name: "Trakt Watch List",
    slug: "watchlist",
    items: watchlistCount,
    likes: 0,
    private: true,
    url: `https://trakt.tv/users/${encodeURIComponent(username)}/watchlist`,
    contentType: "unknown",
  };

  const historyCard = {
    name: "Trakt Watch History",
    slug: "history",
    items: 0,
    likes: 0,
    private: true,
    url: `https://trakt.tv/users/${encodeURIComponent(username)}/history`,
    contentType: "unknown",
  };

  if (!traktKeyParam) ctx.waitUntil(bumpStat(env, "apiuse:trakt"));
  // no-store. This is one person's Trakt account contents, and the
  // request that produced it carries their access token in the query
  // string -- so the URL that would be the cache key is itself the
  // credential. json()'s cacheable default had no business on it.
  return json({ ok: true, lists: [airingNextCard, watchlistCard, historyCard, ...customLists], username }, 200, { "Cache-Control": "no-store" });
}

// --- Trakt OAuth (private lists) ----------------------------------------
//
// Everything above this point only ever needed TRAKT_CLIENT_ID (an
// app-level key, same for every visitor) since it's all public data.
// A private list is only visible to its own owner, which Trakt only
// recognizes via a real user-level OAuth token -- this is that flow.
// TRAKT_CLIENT_SECRET is a genuine secret (unlike TRAKT_CLIENT_ID,
// which is already public-facing in every request this Worker makes)
// and must be set via `wrangler secret put TRAKT_CLIENT_SECRET`, never
// hardcoded here.
//
// No server-side token storage: the resulting access token is handed
// straight back to the browser and saved into the person's own config,
// the same way their MDBList key or Trakt Client ID already are (see
// traktAccessToken throughout). That keeps this consistent with how
// every other credential in this add-on works -- nothing here is tied
// to an account on this Worker -- at the cost of no silent background
// refresh: Trakt access tokens last about 3 months, and reconnecting
// after that is a deliberate manual step, not automatic.

// /api/trakt/oauth/start -> redirects to Trakt's own login/approve page.
// A short-lived, HttpOnly state cookie (scoped to just this OAuth path)
// guards against CSRF -- the callback below refuses to proceed unless
// the state Trakt hands back matches what was stored here.
async function apiTraktOauthStart(url) {
  if (!TRAKT_CLIENT_ID) {
    return new Response("Trakt sign-in is temporarily unavailable. Please try again later.", { status: 503 });
  }
  const state = generateShortId();
  const redirectUri = `${url.origin}/api/trakt/oauth/callback`;
  const authorizeUrl =
    `https://trakt.tv/oauth/authorize?response_type=code&client_id=${encodeURIComponent(TRAKT_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`;
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizeUrl,
      // SameSite=Lax (not Strict) -- this cookie has to survive the
      // top-level cross-site redirect Trakt sends the browser back
      // through to reach the callback below; Strict cookies aren't
      // sent on that kind of navigation.
      "Set-Cookie": `mla_trakt_state=${state}; Path=/api/trakt/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}

// /api/trakt/oauth/callback -> exchanges the code Trakt sends back for
// an access token, then redirects to the builder page with that token
// in a URL *fragment* (#trakt_token=...) rather than a query string --
// fragments are never sent to any server on subsequent requests or
// typically written to server access logs, unlike a query param would
// be. The builder page's own init script reads it from
// location.hash, saves it, and strips it from the address bar
// immediately (see the client-side pickUpTraktTokenFromUrl below).
async function apiTraktOauthCallback(request, env, url) {
  const cookies = parseCookies(request);
  const expectedState = cookies.mla_trakt_state || "";
  const clearStateCookie = "mla_trakt_state=; Path=/api/trakt/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
  const failWith = (reason, detail) => {
    const params = new URLSearchParams({ trakt_error: reason });
    if (detail) params.set("trakt_error_detail", detail);
    return new Response(null, {
      status: 302,
      headers: { Location: `${url.origin}/?${params.toString()}`, "Set-Cookie": clearStateCookie },
    });
  };

  if (url.searchParams.get("error")) return failWith(url.searchParams.get("error"));
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  if (!code || !state || !expectedState || !timingSafeEqualHex(state, expectedState)) {
    return failWith("state_mismatch");
  }
  if (!env || !env.TRAKT_CLIENT_SECRET) return failWith("not_configured");

  try {
    const redirectUri = `${url.origin}/api/trakt/oauth/callback`;
    const traktHeaders = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "trakt-api-version": "2",
      "trakt-api-key": TRAKT_CLIENT_ID,
      "User-Agent": "my-list-addon/1.4",
    };
    const tokenBody = JSON.stringify({
      code,
      client_id: TRAKT_CLIENT_ID,
      client_secret: env.TRAKT_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });

    let tokenRes = null;
    // One retry at most, after a short pause: Trakt answers a burst of
    // token exchanges with 429/403, and the code is single-use, so one more
    // try is worth it -- but not the 6 s of sleeping inside the request this
    // used to allow. The one in-request pause left in the Worker, on
    // purpose: this is a browser redirect with no page in the loop to retry
    // it, unlike the device-code flow, which hands its 429 back to the page.
    const delays = [0, 1500];
    for (const delay of delays) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      try {
        tokenRes = await fetch("https://api.trakt.tv/oauth/token", {
          method: "POST",
          headers: traktHeaders,
          body: tokenBody,
        });
        if (tokenRes.ok) break;
        if (tokenRes.status !== 429 && tokenRes.status !== 403 && tokenRes.status !== 503) {
          break;
        }
      } catch {}
    }
    if (!tokenRes || !tokenRes.ok) {
      let detail = tokenRes ? `HTTP ${tokenRes.status}` : "Network failed";
      try {
        if (tokenRes && tokenRes.status === 429) {
          // A rate limit: say which one, not a page of Cloudflare HTML.
          const retrySec = parseInt(tokenRes.headers.get("Retry-After") || "0", 10) || 0;
          detail = `HTTP 429: ${traktLimitNote(tokenRes, await tokenRes.text().catch(() => ""), retrySec)}`;
        } else if (tokenRes) {
          const text = await tokenRes.text();
          try {
            const errBody = JSON.parse(text);
            if (errBody && (errBody.error || errBody.error_description)) {
              detail = [errBody.error, errBody.error_description].filter(Boolean).join(": ");
            } else if (text) {
              detail = text.slice(0, 200);
            }
          } catch {
            if (text) detail = text.slice(0, 200);
          }
        }
      } catch {}
      return failWith("exchange_failed", detail);
    }
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return failWith("no_token");
    let traktUsername = "";
    try {
      const meRes = await fetch("https://api.trakt.tv/users/me", {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${tokenData.access_token}`,
          "trakt-api-version": "2",
          // TRAKT_CLIENT_ID, not `clientId`: that name is declared only inside
          // the /api/trakt/device/* blocks, which are siblings of this one,
          // not enclosing scopes. Evaluating this object therefore threw a
          // ReferenceError BEFORE fetch was called, the surrounding catch
          // swallowed it, and every browser-based Trakt login silently
          // failed to learn the user's Trakt username -- while the device
          // flow, which does the same lookup correctly, worked. This is the
          // value the token exchange fifteen lines above already uses.
          "trakt-api-key": TRAKT_CLIENT_ID,
          "User-Agent": "my-list-addon/1.4",
        },
      });
      if (meRes.ok) {
        const meData = await meRes.json();
        if (meData && meData.username) traktUsername = meData.username;
      }
    } catch {}
    // Signed in: the token is kept on the server, encrypted, and the
    // address bar never carries it (P3a-9, 28_connections.js). The page
    // fetches it back over the session. Anything else, as before.
    if (await storeProviderConnection(env, request.account, "trakt", {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: tokenData.created_at && tokenData.expires_in ? (tokenData.created_at + tokenData.expires_in) * 1000 : null,
      externalUser: { username: traktUsername },
    })) {
      return new Response(null, {
        status: 302,
        headers: { Location: `${url.origin}/?connected=trakt`, "Set-Cookie": clearStateCookie },
      });
    }
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${url.origin}/#trakt_token=${encodeURIComponent(tokenData.access_token)}${traktUsername ? `&trakt_username=${encodeURIComponent(traktUsername)}` : ""}`,
        "Set-Cookie": clearStateCookie,
      },
    });
  } catch {
    return failWith("network");
  }
}

// /api/trakt/device/code -> starts Trakt device activation flow (bypasses browser redirects & 1015).
// The page asks Trakt itself first (requestTraktDeviceCode, 17_); this is
// the fallback.
async function apiTraktDeviceCode(request, env) {
  let body = {};
  try { body = await request.json(); } catch {}
  const userKey = String(body.traktKey || body.clientId || "").trim();
  const clientId = userKey || TRAKT_CLIENT_ID || (env && env.TRAKT_CLIENT_ID) || "";
  if (!clientId) return json({ ok: false, error: "Trakt Client ID is not configured. Add your Trakt Client ID in Settings." }, 400);
  try {
    let res = await fetch("https://api.trakt.tv/oauth/device/code", {
      method: "POST",
      headers: traktHeaders(null, clientId),
      body: JSON.stringify({ client_id: clientId }),
    });

    // Rate limited: hand Trakt's wait straight back instead of sleeping
    // inside the request. The page waits out a short one and asks once
    // more (see startTraktDeviceLogin, 17_client-my-lists-and-trakt-oauth.js);
    // a long one is said, with what Trakt said (traktLimitNote).
    if (res.status === 429) {
      const retrySec = Math.min(3600, Math.max(1, parseInt(res.headers.get("Retry-After") || "2", 10) || 2));
      const note = traktLimitNote(res, await res.text().catch(() => ""), retrySec);
      return json({
        ok: false,
        error: `Trakt is limiting requests from this site right now (${note}). Please try again later.`,
        retryAfter: retrySec,
      }, 429, { "Retry-After": String(retrySec) });
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errMsg = data.error_description || data.error || (res.status === 429 ? "Trakt is busy (rate limit). Please wait a few seconds and try again." : `Trakt error (HTTP ${res.status})`);
      return json({ ok: false, error: errMsg }, res.status);
    }
    return json({ ok: true, ...data });
  } catch (err) {
    return json({ ok: false, error: safeErrorMessage(err) }, 500);
  }
}

// /api/trakt/device/token -> polls for authorization of device code
async function apiTraktDeviceToken(request, env) {
  let body = {};
  try { body = await request.json(); } catch {}
  const code = String(body.code || "").trim();
  const userKey = String(body.traktKey || body.clientId || "").trim();
  const clientId = userKey || TRAKT_CLIENT_ID || (env && env.TRAKT_CLIENT_ID) || "";
  const clientSecret = (env && env.TRAKT_CLIENT_SECRET) || "";
  if (!code) return json({ ok: false, error: "Device code is required." }, 400);
  if (!clientId || !clientSecret) return json({ ok: false, error: "TRAKT_CLIENT_SECRET not configured on worker." }, 500);

  try {
    const res = await fetch("https://api.trakt.tv/oauth/device/token", {
      method: "POST",
      headers: traktHeaders(null, clientId),
      body: JSON.stringify({
        code,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (res.status === 400) {
      return json({ ok: false, pending: true, error: "Pending authorization." }, 200);
    }
    if (res.status === 404) {
      return json({ ok: false, error: "Invalid device code." }, 404);
    }
    if (res.status === 409) {
      return json({ ok: false, error: "Code already approved or expired." }, 409);
    }
    if (res.status === 410) {
      return json({ ok: false, error: "Code expired. Please request a new code." }, 410);
    }
    if (res.status === 418) {
      return json({ ok: false, error: "Authorization was denied by user." }, 418);
    }
    if (res.status === 429) {
      return json({ ok: false, slowDown: true, error: "Slow down polling." }, 200);
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      return json({ ok: false, error: data.error || `HTTP ${res.status}` }, res.status);
    }

    let traktUsername = "";
    try {
      const meRes = await fetch("https://api.trakt.tv/users/me", {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${data.access_token}`,
          "trakt-api-version": "2",
          "trakt-api-key": clientId,
          "User-Agent": "my-list-addon/1.4",
        },
      });
      if (meRes.ok) {
        const meData = await meRes.json();
        if (meData && meData.username) traktUsername = meData.username;
      }
    } catch {}

    // Kept on the server too when signed in (P3a-9). The token still comes
    // back in this JSON: it never passes through an address bar here, and
    // the page works from its own copy until Phase 6.
    await storeProviderConnection(env, request.account, "trakt", {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.created_at && data.expires_in ? (data.created_at + data.expires_in) * 1000 : null,
      apiKey: userKey || null,
      externalUser: { username: traktUsername },
    });
    return json({ ok: true, access_token: data.access_token, username: traktUsername });
  } catch (err) {
    return json({ ok: false, error: safeErrorMessage(err) }, 500);
  }
}

// /api/mdblist/oauth/start -> redirects to MDBList login/authorization
async function apiMdblistOauthStart(env, url) {
  const clientId = MDBLIST_CLIENT_ID || (env && env.MDBLIST_CLIENT_ID) || "";
  if (!clientId) {
    return new Response("MDBList sign-in is temporarily unavailable. Please try again later.", { status: 503 });
  }
  const state = generateShortId();
  const { verifier, challenge } = await generatePkcePair();
  const redirectUri = url.hostname.includes("mylistsaddon.com")
    ? "https://mylistsaddon.com/api/mdblist/oauth/callback"
    : `${url.origin}/api/mdblist/oauth/callback`;
  const authorizeUrl =
    `https://mdblist.com/oauth/authorize/?response_type=code&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}` +
    `&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`;
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizeUrl,
      "Set-Cookie": `mla_mdblist_state=${state}:${verifier}; Path=/api/mdblist/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}

// /api/mdblist/oauth/callback -> exchanges the code for an MDBList token
async function apiMdblistOauthCallback(request, env, url) {
  const cookies = parseCookies(request);
  const rawState = cookies.mla_mdblist_state || "";
  const [expectedState, verifier] = rawState.split(":");
  const clearStateCookie = "mla_mdblist_state=; Path=/api/mdblist/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
  const failWith = (reason, detail) => {
    const params = new URLSearchParams({ mdblist_error: reason });
    if (detail) params.set("mdblist_error_detail", detail);
    return new Response(null, {
      status: 302,
      headers: { Location: `${url.origin}/?${params.toString()}`, "Set-Cookie": clearStateCookie },
    });
  };

  if (url.searchParams.get("error")) return failWith(url.searchParams.get("error"));
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  if (!code || !state || !expectedState || !timingSafeEqualHex(state, expectedState)) {
    return failWith("state_mismatch");
  }
  const clientId = MDBLIST_CLIENT_ID || (env && env.MDBLIST_CLIENT_ID) || "";
  const clientSecret = (env && env.MDBLIST_CLIENT_SECRET) || "";
  if (!clientId || !clientSecret) return failWith("not_configured");

  try {
    const redirectUri = url.hostname.includes("mylistsaddon.com")
      ? "https://mylistsaddon.com/api/mdblist/oauth/callback"
      : `${url.origin}/api/mdblist/oauth/callback`;

    const formParams = new URLSearchParams();
    formParams.set("grant_type", "authorization_code");
    formParams.set("code", code);
    formParams.set("client_id", clientId);
    formParams.set("client_secret", clientSecret);
    formParams.set("redirect_uri", redirectUri);
    if (verifier) formParams.set("code_verifier", verifier);

    const basicAuth = btoa(`${clientId}:${clientSecret}`);

    let tokenRes = await fetch("https://api.mdblist.com/oauth/token/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "Authorization": `Basic ${basicAuth}`,
        "User-Agent": `my-list-addon/${ADDON_VERSION}`,
        "Accept": "application/json",
      },
      body: formParams.toString(),
    });

    if (!tokenRes.ok) {
      // Fallback: try without Authorization header (credentials in form body only)
      const fallbackRes = await fetch("https://api.mdblist.com/oauth/token/", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": `my-list-addon/${ADDON_VERSION}`,
          "Accept": "application/json",
        },
        body: formParams.toString(),
      });
      if (fallbackRes.ok) {
        tokenRes = fallbackRes;
      }
    }

    if (!tokenRes.ok) {
      let detail = `HTTP ${tokenRes.status}`;
      try {
        const text = await tokenRes.text();
        try {
          const errBody = JSON.parse(text);
          if (errBody && (errBody.error || errBody.error_description || errBody.message)) {
            detail = [errBody.error, errBody.error_description, errBody.message].filter(Boolean).join(": ");
          } else if (text) {
            detail = text.slice(0, 200);
          }
        } catch {
          if (text) detail = text.slice(0, 200);
        }
      } catch {}
      return failWith("exchange_failed", detail);
    }
    const tokenData = await tokenRes.json();
    const token = tokenData.access_token || tokenData.apikey || tokenData.token;
    if (!token) return failWith("no_token");
    let mdblistUsername = tokenData.username || tokenData.user || "";
    if (!mdblistUsername) {
      try {
        const uRes = await fetch(`https://api.mdblist.com/user?apikey=${encodeURIComponent(token)}`, {
          headers: { "User-Agent": `my-list-addon/${ADDON_VERSION}` }
        });
        if (uRes.ok) {
          const uData = await uRes.json();
          if (uData && (uData.username || uData.user_name || uData.name)) {
            mdblistUsername = uData.username || uData.user_name || uData.name;
          }
        }
      } catch {}
    }
    // Signed in: kept on the server, no token in the address bar (P3a-9).
    if (await storeProviderConnection(env, request.account, "mdblist", {
      accessToken: token,
      refreshToken: tokenData.refresh_token,
      expiresAt: tokenData.expires_in ? Date.now() + Number(tokenData.expires_in) * 1000 : null,
      externalUser: { username: mdblistUsername },
    })) {
      return new Response(null, {
        status: 302,
        headers: { Location: `${url.origin}/?connected=mdblist`, "Set-Cookie": clearStateCookie },
      });
    }
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${url.origin}/#mdblist_token=${encodeURIComponent(token)}${mdblistUsername ? `&mdblist_username=${encodeURIComponent(mdblistUsername)}` : ""}`,
        "Set-Cookie": clearStateCookie,
      },
    });
  } catch (err) {
    return failWith("network", safeErrorMessage(err));
  }
}

// /api/simkl/oauth/start -> redirects to Simkl login/authorization
async function apiSimklOauthStart(env, url) {
  const clientId = SIMKL_CLIENT_ID || (env && env.SIMKL_CLIENT_ID) || "";
  if (!clientId) {
    return new Response("Simkl sign-in is temporarily unavailable. Please try again later.", { status: 503 });
  }
  const state = generateShortId();
  const redirectUri = url.hostname.includes("mylistsaddon.com")
    ? "https://mylistsaddon.com/api/simkl/oauth/callback"
    : `${url.origin}/api/simkl/oauth/callback`;
  const authorizeUrl = `https://simkl.com/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}&app-name=MyListsAddon&app-version=${encodeURIComponent(ADDON_VERSION)}`;
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizeUrl,
      "Set-Cookie": `mla_simkl_state=${state}; Path=/api/simkl/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}

// /api/simkl/oauth/callback -> exchanges authorization code for Simkl access token
async function apiSimklOauthCallback(request, env, url) {
  const cookies = parseCookies(request);
  const stateCookie = cookies.mla_simkl_state || "";
  const clearStateCookie = "mla_simkl_state=; Path=/api/simkl/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
  const failWith = (code, detail) => {
    const dest = `${url.origin}/#settings&simkl_error=${encodeURIComponent(code)}` +
      (detail ? `&simkl_error_detail=${encodeURIComponent(detail)}` : "");
    return new Response(null, { status: 302, headers: { Location: dest, "Set-Cookie": clearStateCookie } });
  };

  const clientId = SIMKL_CLIENT_ID || (env && env.SIMKL_CLIENT_ID) || "";
  const clientSecret = SIMKL_CLIENT_SECRET || (env && env.SIMKL_CLIENT_SECRET) || "";
  if (!clientId) return failWith("not_configured");

  const q = new URLSearchParams(url.search);
  const code = q.get("code");
  const state = q.get("state");
  const err = q.get("error");
  if (err) return failWith("access_denied", q.get("error_description") || err);
  if (!code) return failWith("no_code");
  if (!stateCookie) return failWith("state_mismatch", "missing cookie");
  if (state !== stateCookie) return failWith("state_mismatch", "state mismatch");

  const redirectUri = url.hostname.includes("mylistsaddon.com")
    ? "https://mylistsaddon.com/api/simkl/oauth/callback"
    : `${url.origin}/api/simkl/oauth/callback`;

  try {
    const tokenRes = await fetch("https://api.simkl.com/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": `my-list-addon/${ADDON_VERSION}`,
        "Accept": "application/json",
      },
      body: JSON.stringify({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      let detail = `HTTP ${tokenRes.status}`;
      try {
        const text = await tokenRes.text();
        try {
          const errBody = JSON.parse(text);
          if (errBody && (errBody.error || errBody.error_description || errBody.message)) {
            detail = [errBody.error, errBody.error_description, errBody.message].filter(Boolean).join(": ");
          } else if (text) {
            detail = text.slice(0, 200);
          }
        } catch {
          if (text) detail = text.slice(0, 200);
        }
      } catch {}
      return failWith("exchange_failed", detail);
    }
    const tokenData = await tokenRes.json();
    const token = tokenData.access_token || tokenData.token;
    if (!token) return failWith("no_token");
    let simklUsername = "";
    try {
      const uRes = await fetch("https://api.simkl.com/users/settings", {
        headers: {
          "Authorization": `Bearer ${token}`,
          "simkl-api-key": clientId,
          "User-Agent": `my-list-addon/${ADDON_VERSION}`,
          "Accept": "application/json",
        },
      });
      if (uRes.ok) {
        const uData = await uRes.json();
        if (uData && uData.user && (uData.user.username || uData.user.name)) {
          simklUsername = uData.user.username || uData.user.name;
        }
      }
    } catch {}

    // Signed in: kept on the server, no token in the address bar (P3a-9).
    if (await storeProviderConnection(env, request.account, "simkl", {
      accessToken: token,
      externalUser: { username: simklUsername },
    })) {
      return new Response(null, {
        status: 302,
        headers: { Location: `${url.origin}/?connected=simkl`, "Set-Cookie": clearStateCookie },
      });
    }
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${url.origin}/#simkl_token=${encodeURIComponent(token)}${simklUsername ? `&simkl_username=${encodeURIComponent(simklUsername)}` : ""}`,
        "Set-Cookie": clearStateCookie,
      },
    });
  } catch (err) {
    return failWith("network", safeErrorMessage(err));
  }
}

// /api/simkl/my-lists -> returns authenticated user's personal Simkl watchlists
async function apiSimklMyLists(request, env, url) {
  const refusedSimkl = refuseQueryCredentials(url, ["token", "simklKey"]);
  if (refusedSimkl) return refusedSimkl;
  let token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
  let manualKey = "";
  if (request.method === "POST") {
    try {
      const body = await request.json();
      if (body.token) token = body.token;
      if (body.simklKey) manualKey = body.simklKey;
    } catch {}
  }
  const clientId = manualKey || SIMKL_CLIENT_ID || (env && env.SIMKL_CLIENT_ID) || "";
  if (!token) {
    return json({ ok: false, error: "Please connect your Simkl account first." }, 400);
  }
  try {
    // extended=full is required to get watched_episodes_count/
    // total_episodes_count/not_aired_episodes_count back on each item --
    // without it Simkl's default (summary) shape omits or zeroes these,
    // which breaks isCaughtUp's fallback check in
    // enrichSimklAiringNextDates (17_client-my-lists-and-trakt-oauth.js)
    // for any show whose completion isn't otherwise obvious from
    // status alone. No date_from on purpose -- this always wants the
    // full current watchlist, not a delta since a stored checkpoint.
    const res = await fetch("https://api.simkl.com/sync/all-items/?extended=full", {
      headers: {
        "Authorization": `Bearer ${token}`,
        "simkl-api-key": clientId,
        "User-Agent": `my-list-addon/${ADDON_VERSION}`,
        "Accept": "application/json",
      },
    });
    if (!res.ok) {
      return json({ ok: false, error: `Simkl sync request failed (HTTP ${res.status}).` }, res.status);
    }
    const data = await res.json();
    const statusLabels = {
      plantowatch: "Plan to Watch",
      watching: "Watching",
      completed: "Completed",
      hold: "On Hold",
      dropped: "Dropped",
    };

    const lists = [];
    const categories = [
      { key: "movies", type: "movie", label: "Movies" },
      { key: "shows", type: "series", label: "Shows" },
      { key: "anime", type: "series", label: "Anime" },
    ];

    for (const cat of categories) {
      const itemsArr = Array.isArray(data[cat.key]) ? data[cat.key] : [];
      if (!itemsArr.length) continue;
      const byStatus = {};
      for (const item of itemsArr) {
        const st = item.status || "plantowatch";
        if (!byStatus[st]) byStatus[st] = [];
        const mediaObj = item.movie || item.show || item.anime;
        if (mediaObj) {
          const ids = mediaObj.ids || {};
          const imdbId = ids.imdb || "";
          const tmdbId = ids.tmdb || "";
          const simklId = ids.simkl || "";
          const bestId = imdbId || (tmdbId ? `tmdb:${tmdbId}` : (simklId ? `simkl:${simklId}` : ""));
          if (bestId) {
            byStatus[st].push({
              id: bestId,
              imdbId: imdbId || null,
              tmdbId: tmdbId || null,
              name: mediaObj.title || "",
              year: mediaObj.year || "",
              poster: ids.poster ? `https://simkl.in/posters/${ids.poster}_m.jpg` : (imdbId ? `https://images.metahub.space/poster/medium/${imdbId}/img` : ""),
              type: cat.type,
            });
          }
        }
      }

      for (const [stKey, stItems] of Object.entries(byStatus)) {
        if (!stItems.length) continue;
        const stLabel = statusLabels[stKey] || stKey;
        lists.push({
          name: `Simkl ${stLabel} (${cat.label})`,
          type: cat.type,
          itemCount: stItems.length,
          statusKey: stKey,
          categoryKey: cat.key,
          items: stItems,
          url: `simkl:user:${cat.key}:${stKey}`,
        });
      }
    }
    return await apiSimklMyListsAiring(token, clientId, data, lists);
  } catch (err) {
    return json({ ok: false, error: safeErrorMessage(err) }, 500);
  }
}

// The rest of apiSimklMyLists, moved unchanged: the same statements in the same order, split only for the 150-line limit.
async function apiSimklMyListsAiring(token, clientId, data, lists) {
  const airingCandidateItems = [
    ...(Array.isArray(data.shows) ? data.shows : []),
    ...(Array.isArray(data.anime) ? data.anime : []),
  ].filter((it) => (it.status === "watching" || it.status === "completed"));

  airingCandidateItems.sort((a, b) => {
    const aTime = a.last_watched_at ? new Date(a.last_watched_at).getTime() : 0;
    const bTime = b.last_watched_at ? new Date(b.last_watched_at).getTime() : 0;
    if (a.status === "watching" && b.status !== "watching") return -1;
    if (b.status === "watching" && a.status !== "watching") return 1;
    return bTime - aTime;
  });

  const seenAiringIds = new Set();
  const dedupedAiring = [];
  for (const item of airingCandidateItems) {
    const mediaObj = item.show || item.anime;
    if (mediaObj && mediaObj.ids) {
      const imdbId = mediaObj.ids.imdb || "";
      const tmdbId = mediaObj.ids.tmdb || "";
      const simklId = mediaObj.ids.simkl || "";
      const bestId = imdbId || (tmdbId ? `tmdb:${tmdbId}` : (simklId ? `simkl:${simklId}` : ""));
      if (bestId && !seenAiringIds.has(bestId)) {
        seenAiringIds.add(bestId);
        dedupedAiring.push({
          id: bestId,
          imdbId: imdbId || null,
          tmdbId: tmdbId || null,
          name: mediaObj.title || "",
          year: mediaObj.year || "",
          poster: mediaObj.ids.poster ? `https://simkl.in/posters/${mediaObj.ids.poster}_m.jpg` : (imdbId ? `https://images.metahub.space/poster/medium/${imdbId}/img` : ""),
          type: "series",
          status: item.status || "watching",
          watchedCount: item.watched_episodes_count,
          totalCount: item.total_episodes_count,
          lastWatched: item.last_watched || null,
        });
      }
    }
  }

  if (dedupedAiring.length > 0) {
    lists.unshift({
      name: "Simkl Airing Next",
      type: "series",
      itemCount: dedupedAiring.length,
      statusKey: "airing-next",
      categoryKey: "shows",
      items: dedupedAiring,
      url: "simkl:user:shows:airing-next",
    });
  }
  let simklUsername = "";
  try {
    const uRes = await fetch("https://api.simkl.com/users/settings", {
      headers: {
        "Authorization": `Bearer ${token}`,
        "simkl-api-key": clientId,
        "User-Agent": `my-list-addon/${ADDON_VERSION}`,
        "Accept": "application/json",
      },
    });
    if (uRes.ok) {
      const uData = await uRes.json();
      if (uData && uData.user && (uData.user.username || uData.user.name)) {
        simklUsername = uData.user.username || uData.user.name;
      }
    }
  } catch {}

  return json({ ok: true, lists, username: simklUsername }, 200, { "Cache-Control": "no-store" }); // no-store: a per-person answer keyed on a credential in the URL (see A12).
}
