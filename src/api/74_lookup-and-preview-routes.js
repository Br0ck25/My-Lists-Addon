// CSP reports, install tracking, the list preview, channel posters/logos/presets/lineups and the TMDB title and person lookups, moved out of handleFetch (CQ-01).

// Moved unchanged: each route body is now its own function; the dispatchers keep each route's
// original path/method test and are plain functions that return a Response promise or null.
// generateSearchVariations used to be a function inside handleFetch; it is top-level now and unchanged.

// CSP reports, /api/track-install, /api/preview and /api/channel-poster, at their original place. Returns a Response promise, or null.
function handlePreviewRoutes(request, env, ctx, url, path) {
  if (path === CSP_REPORT_PATH && request.method === "POST") return cspReport(request, env, ctx);
  if (path === "/api/track-install" && request.method === "POST") return apiTrackInstall(request, env, ctx);
  if (path === "/api/preview") return apiPreview(request, env, ctx, url, path);
  if (path === "/api/channel-poster") return apiChannelPoster(url);
  return null;
}

// /api/track-install  (POST)  { groups?: { [groupName]: count } } -> { ok: true }
// Fire-and-forget beacon the builder page calls right when "Generate
// install link"/"Update" produces a link -- that action is otherwise
// entirely client-side (it's just base64-encoding the current config
// into a URL, no server round trip), so this is the one place a count
// of "an install link was generated" can be recorded at all. No
// identifying info sent or stored, just a counter bump for the
// admin-only dashboard below. The optional groups breakdown feeds the
// same dashboard's "sources people actually use" table -- see
// bumpStatBy/sanitizeStatGroupName above.
// The browser's own CSP / Trusted Types reports (P7-1). Anonymous, sent
// by the browser rather than by a page, and therefore exempt from the CSRF
// checks (verifyCsrf, 02_); see handleCspReport for what it does and does
// not do. Rate-limited per IP, because nothing about the request is
// authenticated -- and answered 204 either way, so a browser never sees an
// error and a stranger never sees a difference.
async function cspReport(request, env, ctx) {
  const ip = clientIpKey(request);
  if (ip && await consumeRateLimit(env, ctx, "csp-report", ip, CSP_REPORT_MAX_PER_MINUTE, 60)) {
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
  return await handleCspReport(request, env, ctx);
}

async function apiTrackInstall(request, env, ctx) {
  // Anonymous, and it writes: the same per-address budget as
  // /api/track-event. A beacon, so over the limit is still a plain ok.
  const installIp = clientIpKey(request);
  if (!installIp || await consumeRateLimit(env, ctx, "trackinstall", installIp, TRACK_INSTALL_PER_MINUTE)) {
    return json({ ok: true });
  }
  ctx.waitUntil(bumpStat(env, "installs"));
  try {
    const body = await readJsonObject(request);
    if (body && body.groups && typeof body.groups === "object") {
      // Known categories under their own name, the rest together as Other.
      const counted = new Map();
      for (const [rawGroup, rawCount] of Object.entries(body.groups).slice(0, 30)) {
        const group = installStatGroupName(rawGroup);
        const count = Math.max(0, Math.min(SAVED_CONFIG_ENTRIES_MAX, parseInt(rawCount, 10) || 0));
        if (group && count) counted.set(group, Math.min(SAVED_CONFIG_ENTRIES_MAX, (counted.get(group) || 0) + count));
      }
      for (const [group, count] of counted) ctx.waitUntil(bumpStatBy(env, `sourcegroup:${group}`, count));
    }
  } catch {
    // no body, or not JSON -- the plain install counter above still
    // recorded either way, this part is just best-effort extra detail
  }
  return json({ ok: true });
}

// /api/preview -> GET with ?url=...&type=movie|series[&tmdbKey=...&mdblistKey=...&sample=N&skip=N],
// or POST with the same fields as a JSON body. Used by the "Test"
// button in the builder page to check a list (or the watchlist quick-
// add), by Live Preview to render a row's actual shelf and its "See
// All" infinite-scroll view, and by the search results' "View list"
// button. Always uncached (unlike the shared json() helper's default
// hour-long cache) since all of those should reflect the current live
// state, not a stale result from before some earlier fix. sample
// defaults to 5 (the original/Test-button size); Live Preview and View
// List ask for more (100, a full catalog page) and page through with
// skip for infinite scroll -- the same skip fetchCatalog already
// supports for the real /:config/catalog/:type/:id/skip=N.json route
// below, reused as-is.
//
// POST exists because a Channel's own url can be enormous (hundreds of
// episodes' worth of embedded JSON) -- passed as a GET query string
// that routinely exceeded URL length limits and failed outright before
// ever reaching this handler, which is exactly what surfaced as "no
// streams"-style network errors previewing a Channel. GET is kept for
// callers with a normal-sized url (a plain mdblist/trakt/tmdb list
// link is never going to hit that limit).
async function apiPreview(request, env, ctx, url, path) {
  let testUrl, type, tmdbKey, mdblistKey, mdblistAccessToken, traktKey, traktAccessToken, simklKey, simklAccessToken, sampleSize, skip, creatorName, creatorKey, hideNonDigitalReleases, adultContentFilter, region, previewShuffle = false, previewShuffleId = "";
  if (request.method === "POST") {
    let reqBody;
    try {
      reqBody = await readJsonObject(request);
    } catch {
      reqBody = {};
    }
    testUrl = reqBody.url || "";
    if (reqBody.validateOnly === true) return previewSourceCheckResponse(testUrl);
    type = reqBody.type === "series" ? "series" : (reqBody.type === "movie" ? "movie" : "mixed");
    tmdbKey = reqBody.tmdbKey || "";
    mdblistKey = reqBody.mdblistKey || "";
    mdblistAccessToken = reqBody.mdblistAccessToken || "";
    traktKey = reqBody.traktKey || "";
    traktAccessToken = reqBody.traktAccessToken || "";
    simklKey = reqBody.simklKey || "";
    simklAccessToken = reqBody.simklAccessToken || "";
    creatorName = reqBody.creatorName || "";
    creatorKey = reqBody.creatorKey || "";
    region = reqBody.region || "";
    hideNonDigitalReleases = !!reqBody.hideNonDigitalReleases;
    adultContentFilter = !!reqBody.adultContentFilter;
    // The builder's live preview shows a list as it will arrive once the
    // daily item shuffle is on for it, so toggling it is visible at once.
    previewShuffle = reqBody.shuffle === true;
    previewShuffleId = String(reqBody.shuffleId || "").slice(0, 200);
    sampleSize = Math.max(1, Math.min(PAGE_SIZE, parseInt(reqBody.sample, 10) || 5));
    skip = Math.min(Math.max(0, parseInt(reqBody.skip, 10) || 0), 9900); // same cap as the catalog rows (audit API-05)
  } else {
    // GET is kept for plain public previews only. Every caller in the
    // builder page uses POST; credentials in the query string are refused
    // (see refuseQueryCredentials).
    const refused = refuseQueryCredentials(url, [
      "tmdbKey", "mdblistKey", "mdblistAccessToken", "traktKey", "traktAccessToken",
      "simklKey", "simklAccessToken", "creatorKey",
    ]);
    if (refused) return refused;
    testUrl = url.searchParams.get("url") || "";
    const rawType = url.searchParams.get("type") || "";
    type = rawType === "series" ? "series" : (rawType === "movie" ? "movie" : "mixed");
    tmdbKey = "";
    mdblistKey = "";
    mdblistAccessToken = "";
    traktKey = "";
    traktAccessToken = "";
    simklKey = "";
    simklAccessToken = "";
    creatorName = url.searchParams.get("creatorName") || "";
    creatorKey = "";
    region = url.searchParams.get("region") || "";
    hideNonDigitalReleases = url.searchParams.get("hideNonDigitalReleases") === "1";
    adultContentFilter = url.searchParams.get("adultContentFilter") === "1";
    sampleSize = Math.max(1, Math.min(PAGE_SIZE, parseInt(url.searchParams.get("sample"), 10) || 5));
    skip = Math.min(Math.max(0, parseInt(url.searchParams.get("skip"), 10) || 0), 9900);
  }
  return apiPreviewLoad(request, env, ctx, { url, path, testUrl, type, tmdbKey, mdblistKey, mdblistAccessToken, traktKey, traktAccessToken, simklKey, simklAccessToken, sampleSize, skip, creatorName, creatorKey, hideNonDigitalReleases, adultContentFilter, region, previewShuffle, previewShuffleId });
}

// The rest of apiPreview, moved unchanged: the same statements in the same order, split only for the 150-line limit.
async function apiPreviewLoad(request, env, ctx, { url, path, testUrl, type, tmdbKey, mdblistKey, mdblistAccessToken, traktKey, traktAccessToken, simklKey, simklAccessToken, sampleSize, skip, creatorName, creatorKey, hideNonDigitalReleases, adultContentFilter, region, previewShuffle, previewShuffleId }) {
  region = String(region || "").toUpperCase(); // one cache entry per country, not per spelling, whichever way the request came (GET or POST)
  // Unauthenticated and heavyweight: each call can fan out to TMDB /
  // Trakt / MDBList. Same IP-keyed bucket as create/restore/feedback --
  // 240/minute provides sufficient budget for browsing multi-card
  // Discover shelves while protecting against automated scraping.
  const ip = clientIpKey(request);
  if (!ip) return json({ ok: false, error: "Couldn't load that list." }, 400, { "Cache-Control": "no-store" });
  if (!isFreeChartPreview(testUrl, skip, { region, keys: [tmdbKey, mdblistKey, mdblistAccessToken, traktKey, traktAccessToken, simklKey, simklAccessToken, creatorName] }) && await consumeRateLimit(env, ctx, "preview", ip, 240)) {
    return json({ ok: false, error: "Couldn't load that list." }, 429, { "Cache-Control": "no-store" });
  }

  const sourceUrls = previewSourceUrls(testUrl);
  if (!sourceUrls.length || !sourceUrls.every(isAllowedCatalogSourceUrl)) {
    return json({ ok: false, error: "That URL isn't a supported list source." }, 400, { "Cache-Control": "no-store" });
  }

  // An `autotrack:<slug>:<type>:<username>` source reads that account's
  // private Watch History / Continue Watching / Watchlist. This endpoint is
  // unauthenticated, so until the caller proves who it is, the username in
  // that string is a claim and nothing more -- which is exactly how the
  // whole of any account's viewing history became readable with one GET
  // (SEC-001). authenticateCreator is used rather than a bare verify so the
  // per-IP PBKDF2 throttle and the tombstone check both apply here too.
  //
  // A caller that sends nothing, or the wrong key, is not refused: it simply
  // proves nothing, and mayReadTrackedShelf then falls back to whatever the
  // owner has explicitly shared. Every other source type is unaffected.
  // A page signed in with a session holds no Creator Key and sends only the
  // name: authenticateCreator then proves it by the session, as on every
  // other creator route.
  let previewVerifiedOwner = "";
  if (creatorName && (creatorKey || request.account)) {
    const previewAuth = await authenticateCreatorFor(request, env, ctx, path, creatorName, creatorKey);
    if (previewAuth.ok) previewVerifiedOwner = previewAuth.username;
  }

  let body;
  try {
    let metas = await fetchCatalog({ url: testUrl, type, shuffle: previewShuffle }, skip, { tmdbKey, mdblistKey, mdblistAccessToken, traktKey, traktAccessToken, simklKey, simklAccessToken, creatorName, verifiedOwner: previewVerifiedOwner, hideNonDigitalReleases, adultContentFilter, region, shuffleSalt: previewShuffleId, env, ctx, origin: url.origin });
    const totalItems = (typeof metas.totalItems === "number") ? metas.totalItems : (metas.length < PAGE_SIZE && skip === 0 ? metas.length : null);
    // Enrich sample items that lack ratings with TMDb data.
    // fetchTmdbDetails is cached (7 days) so popular titles are cache hits.
    const sampleMetas = metas.slice(0, sampleSize);
    const effectiveTmdbKey = tmdbKey || (env && env.TMDB_API_KEY) || TMDB_API_KEY;
    if (effectiveTmdbKey) {
      await mapWithConcurrency(sampleMetas.slice(0, 12), 6, async (m) => {
        if (m.vote_average != null || m.rating != null || m.score != null) return;
        const rawTmdbId = m.tmdbId || (m.id && String(m.id).startsWith("tmdb:") ? String(m.id).slice(5) : null) || (m.imdbId && String(m.imdbId).startsWith("tt") ? m.imdbId : (m.id && String(m.id).startsWith("tt") ? m.id : null));
        if (!rawTmdbId) return;
        const kind = (m.type === "series" || m.mediatype === "show" || m.mediatype === "series" || m.mediatype === "tv") ? "tv" : "movie";
        try {
          const details = await fetchTmdbDetails(rawTmdbId, kind, effectiveTmdbKey, env, ctx);
          if (details && typeof details.vote_average === "number" && details.vote_average > 0) {
            m.vote_average = details.vote_average;
            m.rating = details.vote_average;
          }
        } catch {}
      });
    }
    body = {
      ok: true,
      count: metas.length,
      totalItems: totalItems,
      maybeMore: totalItems != null ? (skip + metas.length < totalItems) : (metas.length >= PAGE_SIZE),
      sample: sampleMetas.map((m) => ({
        id: m.id,
        showId: m.showId || undefined,
        type: m.type || (m.mediatype === "show" || m.mediatype === "series" || m.mediatype === "tv" ? "series" : (m.mediatype === "episode" ? "episode" : (type === "series" ? "series" : "movie"))),
        name: m.name,
        subtitle: m.subtitle || undefined,
        poster: m.poster,
        year: m.releaseInfo,
        showTitle: m.showTitle,
        posterShape: m.posterShape,
        season: m.season,
        episode: m.episode,
        seasonNum: m.seasonNum != null ? m.seasonNum : (m.season != null ? m.season : undefined),
        episodeNum: m.episodeNum != null ? m.episodeNum : (m.episode != null ? m.episode : undefined),
        airDate: m.airDate || undefined,
        airTime: m.airTime || undefined,
        isUnaired: m.isUnaired || undefined,
        isSeasonPremiere: m.isSeasonPremiere || undefined,
        isSeasonFinale: m.isSeasonFinale || undefined,
        seasonFinaleAirDate: m.seasonFinaleAirDate || undefined,
        seasonFinaleEpisodeNumber: m.seasonFinaleEpisodeNumber != null ? m.seasonFinaleEpisodeNumber : undefined,
        isCompanion: m.isCompanion || undefined,
        companionType: m.companionType || undefined,
        companionNote: m.companionNote || undefined,
        companionStoryline: m.companionStoryline || undefined,
        precedingShowId: m.precedingShowId || undefined,
        imdbRating: m.imdbRating || undefined,
        rating: m.rating != null ? m.rating : (m.vote_average != null ? m.vote_average : (m.imdbRating ? parseFloat(m.imdbRating) : undefined)),
        vote_average: m.vote_average != null ? m.vote_average : (m.rating != null ? m.rating : undefined),
        score: m.score != null ? m.score : undefined,
        isAdult: isAdultOrNsfw(m),
        isAdultPosterFiltered: !!m.isAdultPosterFiltered,
        progress: typeof m.progress === "number" ? m.progress : undefined,
        timeLeftMin: typeof m.timeLeftMin === "number" ? m.timeLeftMin : undefined,
      })),
    };
  } catch (err) {
    console.error("preview failed:", err);
    body = { ok: false, error: (err && err.message) || "Couldn't load that list." };
  }

  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(),
    },
  });
}

// /api/channel-poster -> Returns branded SVG channel poster or landscape backdrop
async function apiChannelPoster(url) {
  // Bounded: the name is rendered into the SVG, and wrapSvgText does not
  // break a single long word, so an unbounded value just inflates the
  // response. 200 is far past any real channel name.
  const name = (url.searchParams.get("name") || "TV Channel").slice(0, 200);
  const bg = url.searchParams.get("bg") || "";
  const format = url.searchParams.get("format") || "";
  const svg = format === "landscape"
    ? generateChannelBackdropSvg(name, bg)
    : generateChannelPosterSvg(name, bg);
  // Deterministic for a given name/bg/format -- it is text on a
  // generated background, with no per-viewer or time-varying content --
  // so there is nothing to keep fresh. It was marked no-store, which
  // meant every request re-rendered it at the edge and at the client for
  // an image that never changes.
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
      ...corsHeaders(),
    },
  });
}

// /api/channel-logo, /api/toplists, /api/season, the title, poster, show, channel and person lookups and /api/resolve-movie and -show, at their original place. Returns a Response promise, or null.
function handleLookupRoutes(request, env, ctx, url, path) {
  if (path === "/api/channel-logo") return apiChannelLogo(url);
  if (path === "/api/toplists") return apiToplists(env, ctx);
  if (path === "/api/season") return apiSeason(env, ctx, url);
  if (path === "/api/title-search") return apiTitleSearch(request, env, ctx, url);
  if (path === "/api/poster-fallback") return apiPosterFallback(env, ctx, url);
  if (path === "/api/show-seasons") return apiShowSeasons(env, ctx, url);
  if (path === "/api/show-episodes") return apiShowEpisodes(env, ctx, url);
  if (path === "/api/channel-preset") return apiChannelPreset(env, ctx, url);
  if (path === "/api/channel-lineup") {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
    if (request.method === "POST") return apiChannelLineup(request, env, ctx, url);
  }
  if (path === "/api/person-search") return apiPersonSearch(request, env, ctx, url);
  if (path === "/api/person-credits") return apiPersonCredits(env, ctx, url);
  if (path === "/api/person-show-episodes") return apiPersonShowEpisodes(env, ctx, url);
  if (path === "/api/quick-channel-shows") return apiQuickChannelShows(request, env, ctx, url);
  if (path === "/api/resolve-movie") return apiResolveMovie(env, ctx, url);
  if (path === "/api/resolve-show") return apiResolveShow(env, ctx, url);
  return null;
}

// /api/channel-logo?path=...[&format=landscape]
// Generates a self-contained SVG channel poster with the network's official
// logo. Uses format=landscape for 16:9 widescreen banners (600x338) and default
// for vertical 2:3 posters (600x900). Uses embedded base64 so it renders reliably across
// Stremio, Nuvio, wako, and web clients without CORS issues.
async function apiChannelLogo(url) {
  const logoPath = url.searchParams.get("path");
  const format = url.searchParams.get("format") || "";
  if (!logoPath) return new Response("Missing path", { status: 400 });
  // Only something shaped like a TMDB image path. The value is
  // interpolated into an image.tmdb.org URL, and while URL parsing keeps
  // the host pinned there (so this was never SSRF), an unvalidated path
  // still made this a general fetch-and-base64 proxy for that host,
  // reachable by anyone, for any path they cared to name.
  if (!/^\/?[A-Za-z0-9._-]{1,128}\.(png|jpg|jpeg|webp|svg)$/i.test(logoPath)) {
    return new Response("Bad path", { status: 400 });
  }
  try {
    const tmdbUrl = `https://image.tmdb.org/t/p/w500${logoPath.startsWith("/") ? logoPath : "/" + logoPath}`;
    const tmdbRes = await fetch(tmdbUrl, {
      headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
      cf: { cacheTtl: 604800, cacheEverything: true },
    });
    if (!tmdbRes.ok) return new Response("Image not found", { status: 404 });
    // Bound what gets buffered and base64'd. A w500 poster is tens of
    // kilobytes; anything far past that is not a logo, and this endpoint
    // holds the whole thing in memory twice (bytes, then a binary string)
    // before encoding it.
    const declaredLength = parseInt(tmdbRes.headers.get("content-length") || "", 10);
    if (Number.isFinite(declaredLength) && declaredLength > CHANNEL_LOGO_MAX_BYTES) {
      return new Response("Image too large", { status: 413 });
    }
    const arrayBuffer = await tmdbRes.arrayBuffer();
    if (arrayBuffer.byteLength > CHANNEL_LOGO_MAX_BYTES) {
      // No content-length header, or it lied.
      return new Response("Image too large", { status: 413 });
    }
    const contentType = tmdbRes.headers.get("content-type") || "image/png";
    // Escaped because it lands in an SVG attribute and comes from an
    // upstream response header rather than from this Worker.
    const safeContentType = escapeXml(contentType.split(";")[0].trim() || "image/png");
    const base64 = bytesToBase64(arrayBuffer);
    const dataUri = `data:${safeContentType};base64,${base64}`;

    const svg = format === "landscape"
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="338" viewBox="0 0 600 338">
  <defs>
    <linearGradient id="bgGradL" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0b0d14"/>
      <stop offset="50%" stop-color="#131726"/>
      <stop offset="100%" stop-color="#06070a"/>
    </linearGradient>
  </defs>
  <rect width="600" height="338" fill="url(#bgGradL)"/>
  <rect x="12" y="12" width="576" height="314" rx="20" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="2"/>
  <image x="150" y="69" width="300" height="200" preserveAspectRatio="xMidYMid meet" href="${dataUri}"/>
</svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900">
  <defs>
    <linearGradient id="bgGradP" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0b0d14"/>
      <stop offset="50%" stop-color="#131726"/>
      <stop offset="100%" stop-color="#06070a"/>
    </linearGradient>
    <linearGradient id="accentGradP" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#007AFF"/>
      <stop offset="50%" stop-color="#5856D6"/>
      <stop offset="100%" stop-color="#AF52DE"/>
    </linearGradient>
    <filter id="glowP" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="16" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>
  </defs>
  <rect width="600" height="900" fill="url(#bgGradP)"/>
  <rect x="20" y="20" width="560" height="860" rx="32" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="3"/>
  <rect x="80" y="280" width="440" height="280" rx="24" fill="#141829" stroke="rgba(0,122,255,0.4)" stroke-width="2"/>
  <image x="100" y="300" width="400" height="240" preserveAspectRatio="xMidYMid meet" href="${dataUri}"/>
  <g transform="translate(300, 780)">
    <rect x="-120" y="-20" width="240" height="40" rx="20" fill="url(#accentGradP)"/>
    <text x="0" y="6" font-family="Arial, Helvetica, sans-serif" font-size="15" font-weight="bold" fill="#FFFFFF" text-anchor="middle" letter-spacing="2.5">TV CHANNEL</text>
  </g>
</svg>`;

    // Deterministic for a given path/format, and callers already append
    // their own `v` cache-buster (see getPremadeChannelLogo,
    // 05_catalog-core.js), so this can be cached hard. It was no-store,
    // which meant every single request re-fetched the image from TMDB
    // and re-base64'd it -- the whole cost of this endpoint, repeated
    // for output that cannot change.
    return new Response(svg, {
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "public, max-age=604800, immutable",
        ...corsHeaders(),
      },
    });
  } catch (err) {
    return new Response("Error generating logo", { status: 500 });
  }
}

// /api/toplists
// -> powers the "Popular Lists" browser in the builder page. Proxies
// mdblist.com's own top-lists endpoint so people can add lists from
// https://mdblist.com/toplists/ with a click instead of copy-pasting URLs.
// Uses the fixed MDBLIST_POPULAR_KEY (see top of file) — no per-user key
// needed for this, since it's the same public data for everyone.
async function apiToplists(env, ctx) {
  try {
    // Always the shared key here -- no per-user override exists for
    // this endpoint (see the comment above).
    ctx.waitUntil(bumpStat(env, "apiuse:mdblistpopular"));
    const lists = await fetchTopLists(MDBLIST_POPULAR_KEY, env, ctx);
    return jsonCacheable({ ok: true, lists });
  } catch (err) {
    return json({ ok: false, error: safeErrorMessage(err) });
  }
}

// /api/season (GET) -> { ok: true, season: { episodes: [...] } }
async function apiSeason(env, ctx, url) {
  const q = url.searchParams;
  const imdbId = q.get("imdbId");
  const seasonNum = q.get("seasonNum");
  const tmdbKeyParam = q.get("tmdbKey") || "";
  const tmdbKey = tmdbKeyParam || TMDB_API_KEY;
  if (!tmdbKeyParam) ctx.waitUntil(bumpStat(env, "apiuse:tmdb"));
  // Optional -- when the caller already resolved this show's tmdbId
  // (e.g. from the same /api/details response that gave it
  // imdbId/seasonsData in the first place), passing it straight
  // through skips a redundant imdbId -> tmdbId /find lookup here.
  // Matters most when several seasons of the same show are being
  // fetched concurrently (see markShowWatched's own comment): without
  // this, each one redundantly re-resolves the same show, and those
  // concurrent /find calls racing to fill a cold cache entry for a
  // show TMDB hasn't been asked about yet can come back empty under
  // that burst, silently dropping that season's episodes.
  const knownTmdbId = q.get("tmdbId") || null;

  if (!imdbId || !seasonNum) return json({ ok: false, error: "Missing imdbId or seasonNum" }, 400);

  const seasonData = await fetchTmdbSeasonDetails(imdbId, seasonNum, tmdbKey, knownTmdbId, env, ctx);
  if (!seasonData) return json({ ok: false, error: "Not found or TMDB error" }, 404);

  // A short max-age (not json()'s 3600s default) -- this response's
  // shape has changed before (the tmdbId passthrough above is a
  // recent example) and a stale hour-old browser cache of the old
  // shape is exactly the kind of thing that looks like "the fix
  // didn't work" for anyone re-testing a show/season they'd already
  // opened recently. The actual TMDB calls are still cached for a
  // full week at Cloudflare's edge (see fetchTmdbSeasonDetails's own
  // cf.cacheTtl) regardless of this -- this only governs how long
  // the browser reuses its own copy of this specific JSON reply.
  return json({ ok: true, season: seasonData }, 200, { "Cache-Control": "max-age=60" });
}

function generateSearchVariations(query) {
  if (!query || typeof query !== "string") return [];
  const variations = new Set();
  const trimmed = query.trim();

  // 1. Common missing-space words / compound nouns
  const compounds = [
    [/\bpickup\b/gi, "pick up"],
    [/\bpick up\b/gi, "pickup"],
    [/\bstandby\b/gi, "stand by"],
    [/\bspiderman\b/gi, "spider-man"],
    [/\bironman\b/gi, "iron man"],
    [/\bstarwars\b/gi, "star wars"],
    [/\bstartrek\b/gi, "star trek"],
    [/\bbreakingbad\b/gi, "breaking bad"],
    [/\bgameofthrones\b/gi, "game of thrones"],
    [/\blordoftherings\b/gi, "lord of the rings"],
    [/\bxmen\b/gi, "x-men"],
    [/\bantman\b/gi, "ant-man"],
    [/\btopgun\b/gi, "top gun"],
    [/\bdeadpool\b/gi, "dead pool"],
    [/\bfallout\b/gi, "fall out"],
    [/\bpayback\b/gi, "pay back"],
    [/\bstepup\b/gi, "step up"],
    [/\bhangover\b/gi, "hang over"],
    [/\bknockout\b/gi, "knock out"],
    [/\bstrangerthings\b/gi, "stranger things"],
  ];
  for (const [re, replacement] of compounds) {
    if (re.test(trimmed)) {
      variations.add(trimmed.replace(re, replacement));
    }
  }

  // 2. Glued numbers and words (e.g. "matrix4" -> "matrix 4", "ironman2" -> "ironman 2")
  const withSpacedNumbers = trimmed.replace(/([a-zA-Z])(\d+)/g, "$1 $2").replace(/(\d+)([a-zA-Z])/g, "$1 $2");
  if (withSpacedNumbers !== trimmed) variations.add(withSpacedNumbers);

  // 3. CamelCase transitions (e.g. "SpiderMan" -> "Spider Man")
  const withSpacedCamel = trimmed.replace(/([a-z])([A-Z])/g, "$1 $2");
  if (withSpacedCamel !== trimmed) variations.add(withSpacedCamel);

  // 4. Hyphen/colon variants
  if (trimmed.includes("-")) variations.add(trimmed.replace(/-/g, " "));
  if (trimmed.includes(":")) variations.add(trimmed.replace(/:/g, " "));

  variations.delete(trimmed);
  return Array.from(variations);
}

// /api/title-search?q=...&type=movie|tv
// -> powers the "Search a show/movie" box in the Channel builder and the Search tab.
// When no query is provided, returns the top 20 trending/popular titles for that category.
// When a query is provided, fetches all relevant matching results across pages.
async function apiTitleSearch(request, env, ctx, url) {
  const searchLimited = await searchRateLimitResponse(request, env, ctx);
  if (searchLimited) return searchLimited;
  const q = (url.searchParams.get("q") || "").trim();
  const kind = url.searchParams.get("type") === "movie" ? "movie" : "tv";
  const adultFilterParam = url.searchParams.get("adultContentFilter");
  const isAdultFilterActive = adultFilterParam === "1" || adultFilterParam === "true";
  try {
    // Always the shared key -- no per-user override for this endpoint.
    ctx.waitUntil(bumpStat(env, "apiuse:tmdb"));
    if (!q) {
      // When no query is provided, return the top 20 trending/popular titles
      const src = `https://api.themoviedb.org/3/trending/${kind}/week?api_key=${encodeURIComponent(TMDB_API_KEY)}&page=1`;
      const res = await fetchWithTimeout(src, {
        headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
        cf: { cacheTtl: 3600, cacheEverything: true },
      });
      if (!res.ok) return json({ ok: false, error: `TMDB lookup failed (HTTP ${res.status}).` });
      const data = await res.json();
      const results = (data.results || []).slice(0, 20).map((it) => {
        const isAdultItem = it.adult === true || it.is_adult === true || isAdultOrNsfw(it);
        let poster = it.poster_path ? `https://image.tmdb.org/t/p/w200${it.poster_path}` : null;
        if (isAdultFilterActive && isAdultItem) {
          poster = getSafePosterUrl(url.origin, {
            title: it.title || it.name,
            year: (it.release_date || it.first_air_date || "").slice(0, 4),
            type: kind === "tv" ? "series" : "movie",
            certification: "ADULT",
          });
        }
        return {
          tmdbId: it.id,
          title: it.title || it.name,
          year: (it.release_date || it.first_air_date || "").slice(0, 4),
          poster,
          backdrop: it.backdrop_path ? `https://image.tmdb.org/t/p/w780${it.backdrop_path}` : null,
          rating: typeof it.vote_average === "number" ? Math.round(it.vote_average * 10) / 10 : null,
          genreIds: Array.isArray(it.genre_ids) ? it.genre_ids : [],
          type: kind,
          adult: isAdultItem,
          isAdult: isAdultItem,
          isAdultPosterFiltered: isAdultFilterActive && isAdultItem,
        };
      });
      return jsonCacheable({ ok: true, results });
    }

    // Active search: fetch all relevant search results across pages
    if (env && env.CONFIGS && typeof recordSearchQuery === "function") {
      ctx.waitUntil(recordSearchQuery(env, q));
    }

    const page1Src = `https://api.themoviedb.org/3/search/${kind}?api_key=${encodeURIComponent(
      TMDB_API_KEY
    )}&query=${encodeURIComponent(q)}&include_adult=true&page=1`;
    const page1Res = await fetchWithTimeout(page1Src, {
      headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (!page1Res.ok) return json({ ok: false, error: `TMDB search failed (HTTP ${page1Res.status}).` });
    const page1Data = await page1Res.json();
    let allRawItems = Array.isArray(page1Data.results) ? [...page1Data.results] : [];
    const totalPages = typeof page1Data.total_pages === "number" ? page1Data.total_pages : 1;

    if (totalPages > 1) {
      const maxExtraPages = Math.min(totalPages, 5); // Up to 5 pages (100 relevant items)
      const extraPageNums = [];
      for (let p = 2; p <= maxExtraPages; p++) {
        extraPageNums.push(p);
      }
      const extraResults = await Promise.all(
        extraPageNums.map(async (p) => {
          try {
            const pSrc = `https://api.themoviedb.org/3/search/${kind}?api_key=${encodeURIComponent(
              TMDB_API_KEY
            )}&query=${encodeURIComponent(q)}&include_adult=true&page=${p}`;
            const pRes = await fetchWithTimeout(pSrc, {
              headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
              cf: { cacheTtl: 3600, cacheEverything: true },
            });
            if (!pRes.ok) return [];
            const pData = await pRes.json();
            return Array.isArray(pData.results) ? pData.results : [];
          } catch {
            return [];
          }
        })
      );
      for (const pageItems of extraResults) {
        allRawItems = allRawItems.concat(pageItems);
      }
    }

    // Fallback 1: Query Variations (missing spaces, glued numbers, compounds)
    if (allRawItems.length === 0) {
      const variations = generateSearchVariations(q);
      for (const altQ of variations) {
        try {
          const altSrc = `https://api.themoviedb.org/3/search/${kind}?api_key=${encodeURIComponent(
            TMDB_API_KEY
          )}&query=${encodeURIComponent(altQ)}&include_adult=true&page=1`;
          const altRes = await fetchWithTimeout(altSrc, {
            headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
            cf: { cacheTtl: 3600, cacheEverything: true },
          });
          if (altRes.ok) {
            const altData = await altRes.json();
            if (Array.isArray(altData.results) && altData.results.length > 0) {
              allRawItems = altData.results;
              break;
            }
          }
        } catch {}
      }
    }
    return await apiTitleSearchFallbacks(url, q, kind, isAdultFilterActive, allRawItems);
  } catch (err) {
    return json({ ok: false, error: safeErrorMessage(err) });
  }
}

// The rest of apiTitleSearch, moved unchanged: the same statements in the same order, split only for the 150-line limit.
async function apiTitleSearchFallbacks(url, q, kind, isAdultFilterActive, allRawItems) {
  // Fallback 2: Cinemeta Fuzzy Search (handles misspellings, typos, phonetic matches, missing words)
  if (allRawItems.length === 0) {
    try {
      const cinemetaType = kind === "tv" ? "series" : "movie";
      const cUrl = `https://v3-cinemeta.strem.io/catalog/${cinemetaType}/top/search=${encodeURIComponent(q)}.json`;
      const cRes = await fetchWithTimeout(cUrl, {
        headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
        cf: { cacheTtl: 86400, cacheEverything: true },
      });
      if (cRes.ok) {
        const cData = await cRes.json();
        const metas = Array.isArray(cData.metas) ? cData.metas.slice(0, 10) : [];
        if (metas.length > 0) {
          // A. Resolve top IMDB IDs to TMDB items via /3/find/
          if (TMDB_API_KEY) {
            const foundItems = await Promise.all(
              metas.slice(0, 6).map(async (m) => {
                const imdbId = m.imdb_id || (typeof m.id === "string" && m.id.startsWith("tt") ? m.id : null);
                if (!imdbId) return null;
                try {
                  const findUrl = `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?api_key=${encodeURIComponent(TMDB_API_KEY)}&external_source=imdb_id`;
                  const fRes = await fetchWithTimeout(findUrl, {
                    headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
                    cf: { cacheTtl: 604800, cacheEverything: true },
                  });
                  if (!fRes.ok) return null;
                  const fData = await fRes.json();
                  const match = kind === "tv"
                    ? ((fData.tv_results || [])[0] || (fData.tv_episode_results || [])[0])
                    : ((fData.movie_results || [])[0]);
                  return match || null;
                } catch {
                  return null;
                }
              })
            );
            for (const it of foundItems) {
              if (it && it.id) allRawItems.push(it);
            }
          }

          // B. If still needed, search TMDB using Cinemeta's top match title
          if (allRawItems.length === 0 && metas[0] && metas[0].name && TMDB_API_KEY) {
            const cleanTopTitle = metas[0].name.replace(/[-–—].*$/, "").trim() || metas[0].name.trim();
            if (cleanTopTitle && cleanTopTitle.toLowerCase() !== q.toLowerCase()) {
              try {
                const tSrc = `https://api.themoviedb.org/3/search/${kind}?api_key=${encodeURIComponent(
                  TMDB_API_KEY
                )}&query=${encodeURIComponent(cleanTopTitle)}&include_adult=true&page=1`;
                const tRes = await fetchWithTimeout(tSrc, {
                  headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
                  cf: { cacheTtl: 3600, cacheEverything: true },
                });
                if (tRes.ok) {
                  const tData = await tRes.json();
                  if (Array.isArray(tData.results) && tData.results.length > 0) {
                    allRawItems.push(...tData.results);
                  }
                }
              } catch {}
            }
          }

          // C. Fallback: map Cinemeta metas directly if TMDB didn't match
          if (allRawItems.length === 0) {
            for (const m of metas) {
              allRawItems.push({
                id: m.id || m.imdb_id,
                title: m.name,
                name: m.name,
                release_date: m.releaseInfo || m.year || "",
                first_air_date: m.releaseInfo || m.year || "",
                poster_path: null,
                direct_poster: m.poster || null,
                backdrop_path: null,
                direct_backdrop: m.background || m.poster || null,
                vote_average: m.imdbRating ? parseFloat(m.imdbRating) : null,
                genre_ids: [],
                adult: false,
              });
            }
          }
        }
      }
    } catch {}
  }
  return apiTitleSearchResults(url, kind, isAdultFilterActive, allRawItems);
}

// The rest of apiTitleSearch, moved unchanged: the same statements in the same order, split only for the 150-line limit.
async function apiTitleSearchResults(url, kind, isAdultFilterActive, allRawItems) {
  // Deduplicate by TMDB ID (or IMDB ID if Cinemeta fallback)
  const seenIds = new Set();
  const rawResults = [];
  for (const it of allRawItems) {
    if (!it || !it.id || seenIds.has(it.id)) continue;
    seenIds.add(it.id);
    rawResults.push(it);
  }

  const results = await Promise.all(
    rawResults.map(async (it) => {
      let poster = it.poster_path ? `https://image.tmdb.org/t/p/w200${it.poster_path}` : (it.direct_poster || null);
      const backdrop = it.backdrop_path ? `https://image.tmdb.org/t/p/w780${it.backdrop_path}` : (it.direct_backdrop || null);
      const isAdultItem = it.adult === true || it.is_adult === true || isAdultOrNsfw(it);

      // If TMDB poster is missing, fall back to the backdrop (already in
      // hand, no extra request). A still-missing poster is left null
      // rather than resolved here with a live per-item Cinemeta lookup:
      // with up to ~100 results in rawResults, that was up to ~100
      // uncapped, un-timed-out outbound fetches gating the whole
      // response on whichever one was slowest. The client already
      // resolves a null poster itself, the same way it resolves any
      // <img> that fails to load: renderTitlePosterCards marks it
      // data-needs-fallback="1" and calls resolveMissingPostersInDom
      // right after rendering (16_client-row-core.js), which hits
      // /api/poster-fallback per item, off the critical path and
      // without holding up the rest of the results.
      if (!poster && backdrop) {
        poster = backdrop;
      }

      if (isAdultFilterActive && isAdultItem) {
        poster = getSafePosterUrl(url.origin, {
          title: it.title || it.name,
          year: (it.release_date || it.first_air_date || "").slice(0, 4),
          type: kind === "tv" ? "series" : "movie",
          certification: "ADULT",
        });
      }

      return {
        tmdbId: it.id,
        title: it.title || it.name,
        year: (it.release_date || it.first_air_date || "").slice(0, 4),
        poster: poster || null,
        backdrop: backdrop || poster || null,
        rating: typeof it.vote_average === "number" ? Math.round(it.vote_average * 10) / 10 : null,
        genreIds: Array.isArray(it.genre_ids) ? it.genre_ids : [],
        type: kind,
        adult: isAdultItem,
        isAdult: isAdultItem,
        isAdultPosterFiltered: isAdultFilterActive && isAdultItem,
      };
    })
  );

  return jsonCacheable({ ok: true, results });
}

// /api/poster-fallback?title=...&year=...&type=movie|series|tv&tmdbId=...&imdbId=...
// Resolves missing posters via Cinemeta, Metahub, TMDB external IDs, or backdrops
async function apiPosterFallback(env, ctx, url) {
  const title = (url.searchParams.get("title") || "").trim();
  const type = (url.searchParams.get("type") || "movie").toLowerCase();
  const kind = (type === "tv" || type === "series") ? "series" : "movie";
  const tmdbKind = (type === "tv" || type === "series") ? "tv" : "movie";
  const tmdbId = (url.searchParams.get("tmdbId") || "").replace(/^tmdb:/, "").trim();
  const rawImdbId = (url.searchParams.get("imdbId") || "").trim();

  const cacheKey = `cache:poster_fallback:${tmdbId || rawImdbId || `${kind}:${title.toLowerCase()}`}`;
  if (env && env.CONFIGS) {
    try {
      const cached = await env.CONFIGS.get(cacheKey);
      if (cached) return jsonCacheable({ ok: true, poster: cached });
    } catch {}
  }

  let resolvedPoster = null;
  let imdbId = rawImdbId.startsWith("tt") ? rawImdbId : null;

  // 1. If tmdbId is provided and no imdbId yet, lookup TMDB details for external_ids/images
  if (tmdbId && !imdbId) {
    try {
      const detRes = await fetch(
        `https://api.themoviedb.org/3/${tmdbKind}/${encodeURIComponent(tmdbId)}?api_key=${encodeURIComponent(
          TMDB_API_KEY
        )}&append_to_response=external_ids,images`,
        {
          headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
          cf: { cacheTtl: 86400, cacheEverything: true },
        }
      );
      if (detRes.ok) {
        const det = await detRes.json();
        if (det.images && Array.isArray(det.images.posters) && det.images.posters.length > 0) {
          resolvedPoster = `https://image.tmdb.org/t/p/w500${det.images.posters[0].file_path}`;
        } else if (det.external_ids && det.external_ids.imdb_id) {
          imdbId = det.external_ids.imdb_id;
        } else if (det.backdrop_path) {
          resolvedPoster = `https://image.tmdb.org/t/p/w780${det.backdrop_path}`;
        }
      }
    } catch {}
  }

  // 2. If we have an IMDb ID, query Cinemeta and fallback to Metahub
  if (!resolvedPoster && imdbId) {
    try {
      const cRes = await fetch(`https://v3-cinemeta.strem.io/meta/${kind}/${imdbId}.json`, {
        cf: { cacheTtl: 86400, cacheEverything: true },
      });
      if (cRes.ok) {
        const cData = await cRes.json();
        if (cData.meta && cData.meta.poster) resolvedPoster = cData.meta.poster;
      }
    } catch {}
    if (!resolvedPoster) {
      resolvedPoster = `https://images.metahub.space/poster/medium/${imdbId}/img`;
    }
  }

  // 3. If still no poster, query Cinemeta catalog search by title
  if (!resolvedPoster && title) {
    try {
      const cSearchRes = await fetch(
        `https://v3-cinemeta.strem.io/catalog/${kind}/top/search=${encodeURIComponent(title)}.json`,
        { cf: { cacheTtl: 86400, cacheEverything: true } }
      );
      if (cSearchRes.ok) {
        const cData = await cSearchRes.json();
        const metas = Array.isArray(cData.metas) ? cData.metas : [];
        const exact = metas.find(
          (m) => m.name && m.name.toLowerCase() === title.toLowerCase() && m.poster
        );
        resolvedPoster = (exact && exact.poster) || (metas[0] && metas[0].poster) || null;
      }
    } catch {}
  }

  // 4. If still no poster, query TMDB search by title
  if (!resolvedPoster && title) {
    try {
      const tmdbSearch = await fetch(`https://api.themoviedb.org/3/search/${tmdbKind}?api_key=${encodeURIComponent(TMDB_API_KEY)}&query=${encodeURIComponent(title)}&page=1`, {
        headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
        cf: { cacheTtl: 86400, cacheEverything: true }
      });
      if (tmdbSearch.ok) {
        const sd = await tmdbSearch.json();
        if (sd.results && sd.results.length > 0) {
          const first = sd.results[0];
          if (first.poster_path) resolvedPoster = `https://image.tmdb.org/t/p/w500${first.poster_path}`;
          else if (first.backdrop_path) resolvedPoster = `https://image.tmdb.org/t/p/w780${first.backdrop_path}`;
        }
      }
    } catch {}
  }

  if (resolvedPoster && env && env.CONFIGS) {
    ctx.waitUntil(env.CONFIGS.put(cacheKey, resolvedPoster, { expirationTtl: 604800 })); // 7-day cache
  }

  return jsonCacheable({ ok: !!resolvedPoster, poster: resolvedPoster });
}

// /api/show-seasons?tmdbId=...
// -> once a show is picked in the Channel builder, lists its seasons so
// the person can drill into one. Also resolves the show's IMDB id up
// front (reusing fetchTmdbDetails -- same combined external_ids+videos
// call every other TMDB path here already makes) since every episode
// picked from this show will need it to build a resolvable stream id.
async function apiShowSeasons(env, ctx, url) {
  const tmdbId = url.searchParams.get("tmdbId") || "";
  if (!tmdbId) return json({ ok: false, error: "Missing tmdbId." }, 400);
  try {
    // Always the shared key -- 2 outbound TMDB calls per request.
    ctx.waitUntil(bumpStatBy(env, "apiuse:tmdb", 2));
    const [details, showRes] = await Promise.all([
      fetchTmdbDetails(tmdbId, "tv", TMDB_API_KEY, env, ctx),
      fetch(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${encodeURIComponent(TMDB_API_KEY)}&append_to_response=episode_groups`, {
        headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
        cf: { cacheTtl: 3600, cacheEverything: true },
      }),
    ]);
    if (!details.imdbId) {
      return json({ ok: false, error: "Couldn't resolve an IMDB id for this show, so streams likely won't work for any episode picked from it." });
    }
    if (!showRes.ok) return json({ ok: false, error: `TMDB show lookup failed (HTTP ${showRes.status}).` });
    const data = await showRes.json();
    // Specials (season 0) are kept, but out of the way of the "is this
    // show actually one giant unpacked season" heuristic below, which
    // only makes sense against the regular seasons -- so they're split
    // off here and tacked back on at the end, after the real seasons.
    const specials = (data.seasons || [])
      .filter((s) => s.season_number === 0)
      .map((s) => ({ season: s.season_number, name: s.name || "Specials", episodeCount: s.episode_count }));
    let seasons = (data.seasons || [])
      .filter((s) => s.season_number > 0)
      .map((s) => ({ season: s.season_number, name: s.name, episodeCount: s.episode_count }));
    const standardEpisodeCount = seasons.reduce((sum, s) => sum + (s.episodeCount || 0), 0);
    if (seasons.length === 1 && standardEpisodeCount > 1) {
      const groups = (data.episode_groups && Array.isArray(data.episode_groups.results)) ? data.episode_groups.results : [];
      const unpacked = await resolveUnpackedShowData(tmdbId, details.imdbId, data.seasons, TMDB_API_KEY, env, ctx, groups);
      if (unpacked && Array.isArray(unpacked.seasons) && unpacked.seasons.length > 1) {
        seasons = unpacked.seasons.map((s) => ({
          season: s.season_number || s.season,
          name: s.name || `Season ${s.season_number || s.season}`,
          episodeCount: s.episode_count || s.episodeCount,
        }));
      }
    }
    seasons = seasons.concat(specials);
    return jsonCacheable({
      ok: true,
      imdbId: details.imdbId,
      name: data.name,
      poster: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null,
      backdrop: data.backdrop_path ? `https://image.tmdb.org/t/p/w780${data.backdrop_path}` : null,
      seasons,
    });
  } catch (err) {
    return json({ ok: false, error: safeErrorMessage(err) });
  }
}

// /api/show-episodes?tmdbId=...&season=...
// -> the actual episode checklist for one season, once picked in the
// Channel builder.
async function apiShowEpisodes(env, ctx, url) {
  const tmdbId = url.searchParams.get("tmdbId") || "";
  const season = url.searchParams.get("season") || "";
  if (!tmdbId || !season) return json({ ok: false, error: "Missing tmdbId or season." }, 400);
  try {
    const numericSeason = parseInt(season, 10);
    // Check if show is unpacked
    const unpacked = await resolveUnpackedShowData(tmdbId, null, null, TMDB_API_KEY, env, ctx);
    if (unpacked && unpacked.episodesBySeason && unpacked.episodesBySeason[numericSeason]) {
      const episodes = unpacked.episodesBySeason[numericSeason].map((e) => ({
        episode: e.episode_number,
        name: e.name,
        released: e.air_date || null,
        thumbnail: e.still_path || null,
        runtime: Number.isInteger(e.runtime) ? e.runtime : null,
      }));
      return jsonCacheable({ ok: true, episodes });
    }

    // Always the shared key.
    ctx.waitUntil(bumpStat(env, "apiuse:tmdb"));
    const src = `https://api.themoviedb.org/3/tv/${tmdbId}/season/${encodeURIComponent(
      season
    )}?api_key=${encodeURIComponent(TMDB_API_KEY)}`;
    const res = await fetch(src, {
      headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (!res.ok) {
      const fallbackUnpacked = await resolveUnpackedShowData(tmdbId, null, null, TMDB_API_KEY, env, ctx);
      if (fallbackUnpacked && fallbackUnpacked.episodesBySeason && fallbackUnpacked.episodesBySeason[numericSeason]) {
        const episodes = fallbackUnpacked.episodesBySeason[numericSeason].map((e) => ({
          episode: e.episode_number,
          name: e.name,
          released: e.air_date || null,
          thumbnail: e.still_path || null,
          runtime: Number.isInteger(e.runtime) ? e.runtime : null,
        }));
        return jsonCacheable({ ok: true, episodes });
      }
      return json({ ok: false, error: `TMDB season lookup failed (HTTP ${res.status}).` });
    }
    const data = await res.json();
    const episodes = (data.episodes || []).map((e) => ({
      episode: e.episode_number,
      name: e.name,
      released: e.air_date || null,
      thumbnail: e.still_path ? `https://image.tmdb.org/t/p/w780${e.still_path}` : null,
      // Minutes, when TMDB has them. Carried onto the channel pick so a
      // channel can say how many hours of television it holds -- and so
      // a schedule can one day be built from real block lengths rather
      // than an assumed half hour. Often null, which is why nothing
      // downstream may require it.
      runtime: Number.isInteger(e.runtime) ? e.runtime : null,
    }));
    return jsonCacheable({ ok: true, episodes });
  } catch (err) {
    return json({ ok: false, error: safeErrorMessage(err) });
  }
}

// /api/quick-channel-shows?url=<any supported list url>  OR  ?networkId=<TMDB network id>
// -> powers the Channels panel's "Quick Add Channel" buttons (CBS, NBC,
// ABC, FOX, The CW, HBO, etc.) and "Import from link": resolves a source
// of shows to TMDB ids, so the client can then loop them through the
// same /api/show-seasons + /api/show-episodes endpoints the manual
// picker already uses. Deliberately split from that per-show/per-season
// fetching (rather than one giant server-side request that builds the
// whole channel) -- a full network lineup could mean dozens of shows
// and hundreds of TMDB calls, comfortably over what a single Worker
// request should be doing; spreading that across many small
// client-driven requests keeps each one fast and avoids leaning on
// Cloudflare's per-request subrequest ceiling.
async function apiChannelPreset(env, ctx, url) {
  const networkId = url.searchParams.get("networkId") || "";
  const name = url.searchParams.get("name") || "TV Channel";
  if (!networkId) return json({ ok: false, error: "Missing networkId." }, 400);

  // The build itself (TMDB discover -> up to ~200 candidate shows -> up
  // to 3 seasons each, capped at CHANNEL_POOL_MAX_ITEMS (5,000) episodes,
  // cached 24h under channel:preset:v2:<networkId>) is shared with the
  // daily cron prewarm (prewarmChannelPresets,
  // 07_source-fetchers-tmdb-simkl.js) so a Quick Add click almost always
  // hits that warm cache rather than paying for a live build. What comes
  // back here is the FULL pool -- the client only embeds a small pointer
  // to it in the saved catalog row (see quickAddChannel,
  // 20_client-channel-builder.js), not this whole response.
  const result = await buildNetworkChannelPreset(networkId, name, url.origin, { env, ctx });
  if (!result.ok) return json({ ok: false, error: result.error }, result.status || 200);
  // no-store, not the usual max-age=3600 default: the KV cache this
  // reads from (channel:preset:v2:<networkId>, 24h TTL) is already the
  // caching layer, invalidated instantly by the admin Channel Presets
  // tab's Clear/Rebuild buttons. A public, 24h Cache-Control on top of
  // that used to let a browser (or a shared/CDN cache, from "public")
  // keep replaying a stale response -- including a pre-fix 200-episode
  // build from long before this endpoint's pool cap was raised to
  // CHANNEL_POOL_MAX_ITEMS -- for up to a full day after an admin
  // rebuild, no matter how fresh the KV entry actually was.
  return json({ ok: true, channel: result.channel }, 200, { "Cache-Control": "no-store" });
}

// /api/channel-lineup  (POST)  { url, watchHistory?, continueWatching? }
//   -> { ok, items, rotating, plan, generatedAt }
//
// What this channel is running RIGHT NOW -- the same lineup the meta
// route would serve, produced by the same function (resolveChannelLineup)
// rather than by a second copy of the seeded shuffle living on the page.
//
// POST, like /api/preview and for the same reason: a channel's url is its
// whole payload and routinely exceeds what a query string can carry.
//
// Unauthenticated, and it reads nothing it is not given: "Hide watched"
// and a dynamic channel both depend on an account's tracking, and this
// route has no way to prove whose it is -- so a preview of one of those
// shows the channel WITHOUT those rules applied and says so, rather than
// quietly reading somebody's history on an unproven claim.
async function apiChannelLineup(request, env, ctx, url) {
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400, corsHeaders());
  }
  let payload = parseChannelPayload(body.url || "");
  if (!payload && (body.channelId || body.catalogId || body.id)) {
    const ch = typeof findChannelEntryById === "function"
      ? await findChannelEntryById(body.channelId || body.catalogId || body.id, body.username || body.target, env)
      : null;
    if (ch && ch.payload) payload = ch.payload;
  }
  if (!payload) return json({ ok: false, error: "That is not a channel." }, 400, corsHeaders());
  try {
    const lineup = await resolveChannelLineup(payload, {
      env, ctx, origin: url.origin,
      now: typeof body.now === "number" ? body.now : undefined,
    });
    if (!lineup) return json({ ok: true, items: [], rotating: !!payload.dailyRotate, plan: null }, 200, { ...corsHeaders(), "Cache-Control": "no-store" });
    const needsAccount = !!(payload.hideWatched || payload.dynamic);
    const items = (lineup.items || []).map((it) => {
      const mediaId = it.imdbId || (it.tmdbId ? `tmdb:${it.tmdbId}` : (it.id && (String(it.id).startsWith("tt") || String(it.id).startsWith("tmdb:")) ? it.id : ""));
      const itemTitle = it.title || it.name || it.epName || "";
      const poster = it.poster || it.thumbnail || it.showPoster || (itemTitle ? `${url.origin}/api/channel-poster?name=${encodeURIComponent(itemTitle)}&v=6` : null);
      const thumbnail = it.thumbnail || it.poster || it.showPoster || (itemTitle ? `${url.origin}/api/channel-poster?name=${encodeURIComponent(itemTitle)}&format=landscape&v=6` : null);
      return {
        ...it,
        id: mediaId || it.id || "",
        title: itemTitle,
        poster: poster,
        thumbnail: thumbnail,
      };
    });
    return json({
      ok: true,
      rotating: !!payload.dailyRotate,
      // Named so the page can say "24 shows x 3 episodes" from the same
      // numbers the Worker clamped, not from what the inputs say.
      plan: lineup.plan,
      poolSize: lineup.sourceItems.length,
      // The two rules this route cannot honour, so the page can label
      // the preview honestly instead of showing a lineup that differs
      // from what will actually play.
      unappliedRules: needsAccount
        ? [payload.hideWatched ? "hideWatched" : null, payload.dynamic ? "dynamic" : null].filter(Boolean)
        : [],
      generatedAt: Date.now(),
      items: items,
    }, 200, { ...corsHeaders(), "Cache-Control": "no-store" });
  } catch (err) {
    return json({ ok: false, error: safeErrorMessage(err) }, 500, { ...corsHeaders(), "Cache-Control": "no-store" });
  }
}

// /api/person-search?q=<name>
//   -> { ok, results: [{ personId, name, department, knownFor, poster }] }
//
// The third search type in the Channel builder, alongside Shows and
// Movies. Searching a PERSON is a different question from searching a
// title -- "everything Robin Williams was in" rather than one film -- so
// it gets its own endpoint rather than another branch of title-search,
// whose whole response shape is built around a title.
async function apiPersonSearch(request, env, ctx, url) {
  const q = (url.searchParams.get("q") || "").trim();
  if (!q) return jsonCacheable({ ok: true, results: [] });
  const searchLimited = await searchRateLimitResponse(request, env, ctx);
  if (searchLimited) return searchLimited;
  try {
    ctx.waitUntil(bumpStat(env, "apiuse:tmdb"));
    const res = await fetch(
      `https://api.themoviedb.org/3/search/person?api_key=${encodeURIComponent(TMDB_API_KEY)}&query=${encodeURIComponent(q)}&include_adult=false&page=1`,
      { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` }, cf: { cacheTtl: 3600, cacheEverything: true } }
    );
    if (!res.ok) return json({ ok: false, error: `TMDB lookup failed (HTTP ${res.status}).` });
    const data = await res.json();
    const results = (data.results || [])
      .filter((p) => p && p.id && !p.adult)
      .slice(0, 20)
      .map((p) => ({
        personId: p.id,
        name: p.name || "",
        department: p.known_for_department || "",
        // The two or three titles TMDB thinks this person is known for,
        // shown under the name because "Chris Evans" alone is not enough
        // to pick the right one out of a search result.
        knownFor: (p.known_for || [])
          .map((k) => k && (k.title || k.name))
          .filter(Boolean)
          .slice(0, 3)
          .join(", "),
        poster: p.profile_path ? `https://image.tmdb.org/t/p/w200${p.profile_path}` : null,
      }));
    return json({ ok: true, results }, 200, { "Cache-Control": "public, max-age=3600" });
  } catch (err) {
    return json({ ok: false, error: safeErrorMessage(err) });
  }
}

// /api/person-credits?personId=<id>&sort=chronological|rating&movies=N&shows=N
//   -> { ok, name, poster, backdrop, movies: [...], shows: [...] }
//
// What a Spotlight channel is built from. Acting credits and directing/
// creating credits both count -- a Nolan or a Miyazaki spotlight is the
// films they MADE, and TMDB files those under crew rather than cast.
//
// Both lists come back already cut and ordered, because the ordering is
// the whole feature: "chronological" walks a career forward, "rating"
// opens with the best of it.
async function apiPersonCredits(env, ctx, url) {
  const personId = (url.searchParams.get("personId") || "").trim();
  if (!/^[0-9]+$/.test(personId)) return json({ ok: false, error: "Missing personId." }, 400);
  const sort = url.searchParams.get("sort") === "rating" ? "rating" : "chronological";
  // A filmography is the whole point here, so the ceilings are a career
  // rather than a shelf. Popularity still decides the ORDER these are
  // cut in (see byWeight below), so asking for fewer gives the best of
  // them rather than an arbitrary slice.
  const movieLimit = Math.min(Math.max(parseInt(url.searchParams.get("movies") || "12", 10) || 12, 0), 120);
  const showLimit = Math.min(Math.max(parseInt(url.searchParams.get("shows") || "4", 10) || 4, 0), 60);
  try {
    ctx.waitUntil(bumpStatBy(env, "apiuse:tmdb", 2));
    const [personRes, creditsRes] = await Promise.all([
      fetch(
        `https://api.themoviedb.org/3/person/${encodeURIComponent(personId)}?api_key=${encodeURIComponent(TMDB_API_KEY)}`,
        { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` }, cf: { cacheTtl: 86400, cacheEverything: true } }
      ),
      fetch(
        `https://api.themoviedb.org/3/person/${encodeURIComponent(personId)}/combined_credits?api_key=${encodeURIComponent(TMDB_API_KEY)}`,
        { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` }, cf: { cacheTtl: 86400, cacheEverything: true } }
      ),
    ]);
    if (!creditsRes.ok) return json({ ok: false, error: `TMDB lookup failed (HTTP ${creditsRes.status}).` });
    const person = personRes.ok ? await personRes.json() : {};
    const credits = await creditsRes.json();
    const DIRECTING_JOBS = /^(director|writer|creator|screenplay|executive producer)$/i;
    const seen = new Set();
    const collect = (list, isCrew) => {
      const out = [];
      for (const c of (list || [])) {
        if (!c || !c.id || c.adult) continue;
        if (isCrew && !DIRECTING_JOBS.test(String(c.job || ""))) continue;
        const mediaType = c.media_type === "tv" ? "tv" : "movie";
        const key = `${mediaType}:${c.id}`;
        if (seen.has(key)) continue;
        // A talk-show or awards-ceremony appearance is a credit but not
        // a title anyone wants in a tribute channel, and TMDB marks
        // those 10767/10763 (talk / news). Same for a person's own
        // documentary interviews showing up with no votes at all.
        const genres = Array.isArray(c.genre_ids) ? c.genre_ids : [];
        if (genres.includes(10767) || genres.includes(10763)) continue;
        const votes = Number(c.vote_count) || 0;
        if (votes < 20) continue;
        seen.add(key);
        const date = c.release_date || c.first_air_date || "";
        out.push({
          tmdbId: c.id,
          type: mediaType,
          title: c.title || c.name || "",
          year: String(date).slice(0, 4),
          released: date || "",
          rating: typeof c.vote_average === "number" ? Math.round(c.vote_average * 10) / 10 : 0,
          votes: votes,
          poster: c.poster_path ? `https://image.tmdb.org/t/p/w500${c.poster_path}` : null,
          backdrop: c.backdrop_path ? `https://image.tmdb.org/t/p/w780${c.backdrop_path}` : null,
          role: isCrew ? (c.job || "Crew") : (c.character || "Cast"),
        });
      }
      return out;
    };
    const all = [...collect(credits.cast, false), ...collect(credits.crew, true)];
    const order = (a, b) => {
      if (sort === "rating") {
        if (b.rating !== a.rating) return b.rating - a.rating;
        return b.votes - a.votes;
      }
      // Chronological, and an undated credit goes last rather than
      // opening the channel -- the same call sortChannelItemsByAired
      // makes for the same reason.
      if (!a.year) return 1;
      if (!b.year) return -1;
      if (a.year !== b.year) return a.year < b.year ? -1 : 1;
      return b.votes - a.votes;
    };
    // Popularity picks WHICH credits make the cut; the chosen sort then
    // decides what order they play in. Ranking by the sort itself would
    // make "chronological" mean "their earliest 12 credits", which for
    // most careers is the student films.
    const byWeight = (a, b) => (b.rating * 10 + Math.log10(b.votes + 1)) - (a.rating * 10 + Math.log10(a.votes + 1));
    const movies = all.filter((c) => c.type === "movie").sort(byWeight).slice(0, movieLimit).sort(order);
    const shows = all.filter((c) => c.type === "tv").sort(byWeight).slice(0, showLimit).sort(order);
    return json({
      ok: true,
      name: person.name || "",
      poster: person.profile_path ? `https://image.tmdb.org/t/p/w500${person.profile_path}` : null,
      backdrop: (movies[0] && movies[0].backdrop) || (shows[0] && shows[0].backdrop) || null,
      movies,
      shows,
    }, 200, { "Cache-Control": "public, max-age=86400" });
  } catch (err) {
    return json({ ok: false, error: safeErrorMessage(err) });
  }
}

// /api/person-show-episodes?personId=<id>&tmdbId=<show id>
//   -> { ok, imdbId, showName, poster, backdrop, regular, episodes: [...] }
//
// The episodes of one show that a given person is ACTUALLY in.
//
// A Spotlight channel used to take a show's first N episodes whenever a
// person had any TV credit on it, so Tobey Maguire's single guest
// appearance in Roseanne put ten Roseanne episodes into the channel --
// nine of which he is not in. TMDB does not answer "which episodes" in
// one call, but it does carry the two facts that settle it:
//
//   * a season's own `credits.cast` is that season's REGULARS, who are
//     in every episode of it without being listed on each one;
//   * each episode's `guest_stars` and `crew` name everyone else --
//     which is where a one-episode guest, and a director, turn up.
//
// So: a regular contributes the whole season, and anyone else
// contributes exactly the episodes that name them.
async function apiPersonShowEpisodes(env, ctx, url) {
  const personId = (url.searchParams.get("personId") || "").trim();
  const tmdbId = (url.searchParams.get("tmdbId") || "").trim();
  if (!/^[0-9]+$/.test(personId) || !/^[0-9]+$/.test(tmdbId)) {
    return json({ ok: false, error: "Missing personId or tmdbId." }, 400);
  }
  const wantedPerson = parseInt(personId, 10);
  try {
    const showRes = await fetch(
      `https://api.themoviedb.org/3/tv/${encodeURIComponent(tmdbId)}?api_key=${encodeURIComponent(TMDB_API_KEY)}&append_to_response=external_ids`,
      { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` }, cf: { cacheTtl: 86400, cacheEverything: true } }
    );
    if (!showRes.ok) return json({ ok: false, error: `TMDB lookup failed (HTTP ${showRes.status}).` });
    const show = await showRes.json();
    const imdbId = (show.external_ids && show.external_ids.imdb_id) || `tmdb:${tmdbId}`;
    const showPoster = show.poster_path ? `https://image.tmdb.org/t/p/w500${show.poster_path}` : "";
    const showBackdrop = show.backdrop_path ? `https://image.tmdb.org/t/p/w780${show.backdrop_path}` : "";
    // Specials (season 0) are left out: they are recaps, gag reels and
    // clip shows as often as they are episodes, and a channel built out
    // of them plays badly.
    const seasons = (show.seasons || [])
      .filter((s) => s && s.season_number > 0)
      .map((s) => s.season_number)
      .slice(0, PERSON_SHOW_MAX_SEASONS);
    let anyRegular = false;
    const perSeason = await mapWithConcurrency(seasons, 4, async (seasonNumber) => {
      try {
        const sRes = await fetch(
          `https://api.themoviedb.org/3/tv/${encodeURIComponent(tmdbId)}/season/${seasonNumber}?api_key=${encodeURIComponent(TMDB_API_KEY)}&append_to_response=credits`,
          { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` }, cf: { cacheTtl: 86400, cacheEverything: true } }
        );
        if (!sRes.ok) return [];
        const sData = await sRes.json();
        const seasonCast = (sData.credits && Array.isArray(sData.credits.cast)) ? sData.credits.cast : [];
        const seasonCrew = (sData.credits && Array.isArray(sData.credits.crew)) ? sData.credits.crew : [];
        const isRegular =
          seasonCast.some((c) => c && c.id === wantedPerson) ||
          seasonCrew.some((c) => c && c.id === wantedPerson && /^(creator|executive producer)$/i.test(String(c.job || "")));
        if (isRegular) anyRegular = true;
        const out = [];
        for (const ep of (sData.episodes || [])) {
          if (!ep || !Number.isInteger(ep.episode_number)) continue;
          if (!isRegular) {
            const named =
              (ep.guest_stars || []).some((g) => g && g.id === wantedPerson) ||
              (ep.crew || []).some((c) => c && c.id === wantedPerson);
            if (!named) continue;
          }
          const stillUrl = ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : "";
          out.push({
            season: seasonNumber,
            episode: ep.episode_number,
            name: ep.name || `Episode ${ep.episode_number}`,
            released: ep.air_date || "",
            thumbnail: stillUrl,
            runtime: Number.isInteger(ep.runtime) ? ep.runtime : null,
          });
        }
        return out;
      } catch {
        return [];
      }
    });
    ctx.waitUntil(bumpStatBy(env, "apiuse:tmdb", 1 + seasons.length));
    const episodes = [];
    for (const run of perSeason) episodes.push(...run);
    episodes.sort((a, b) => (a.season - b.season) || (a.episode - b.episode));
    return json({
      ok: true,
      imdbId,
      showName: show.name || "",
      poster: showPoster,
      backdrop: showBackdrop,
      // True when the person is a season regular somewhere in this show,
      // which is what "every episode of that season" above is standing
      // on -- surfaced so the client can say which of the two answers
      // it got rather than presenting a guess as a fact.
      regular: anyRegular,
      episodes: episodes.slice(0, PERSON_SHOW_MAX_EPISODES),
    }, 200, { "Cache-Control": "public, max-age=86400" });
  } catch (err) {
    return json({ ok: false, error: safeErrorMessage(err) });
  }
}

//
// Three sources feed this: any mdblist.com/trakt.tv/themoviedb.org list
// link (someone else's hand-picked lineup, or "Import from link"'s own
// pasted URL), a TMDB network id directly (TMDB's own current/popular
// shows for that network, e.g. FOX/The CW/HBO -- doesn't depend on any
// third party's list existing or staying maintained), or -- implicitly,
// via the url branch -- a mixed movies+shows list, since requesting
// type "series" from the generic catalog fetch below silently drops any
// movies rather than erroring out (Channels are shows-only).
async function apiQuickChannelShows(request, env, ctx, url) {
  // Keys and tokens travel in a POST body. GET remains for the
  // credential-free forms (a network id or a public list URL).
  const refusedQs = refuseQueryCredentials(url, ["mdblistKey", "traktKey", "traktAccessToken"]);
  if (refusedQs) return refusedQs;
  let qcBody = {};
  if (request.method === "POST") {
    try { qcBody = (await request.json()) || {}; } catch { qcBody = {}; }
  }
  const listUrl = String(qcBody.url || url.searchParams.get("url") || "");
  const networkId = String(qcBody.networkId || url.searchParams.get("networkId") || "");
  const mdblistKey = String(qcBody.mdblistKey || "");
  const traktKey = String(qcBody.traktKey || "");
  const traktAccessToken = String(qcBody.traktAccessToken || "");
  if (!listUrl && !networkId) return json({ ok: false, error: "Missing url or networkId." }, 400);
  try {
    let showRefs; // [{ id: <imdb id>, name, poster }]
    if (networkId) {
      const discoverResults = [];
      // Up to 10 pages (200 shows) -- a much bigger candidate pool to
      // shuffle from than before, but safe to raise: CHANNEL_MAX_TOTAL_ITEMS
      // below already bounds how much actually gets processed regardless
      // of pool size, and this loop still stops early via total_pages
      // for any network with genuinely fewer than 10 pages of results.
      let discoverPagesFetched = 0;
      for (let page = 1; page <= 10; page++) {
        discoverPagesFetched++;
        const discoverRes = await fetch(
          `https://api.themoviedb.org/3/discover/tv?api_key=${encodeURIComponent(TMDB_API_KEY)}` +
            `&with_networks=${encodeURIComponent(networkId)}&sort_by=popularity.desc&page=${page}&include_adult=false`,
          { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` }, cf: { cacheTtl: 3600, cacheEverything: true } }
        );
        if (!discoverRes.ok) break;
        const discoverData = await discoverRes.json();
        discoverResults.push(...(discoverData.results || []));
        if (page >= (discoverData.total_pages || 1)) break;
      }
      if (!discoverResults.length) return json({ ok: false, error: "No shows found for that network." });
      // The network's own logo (e.g. the CBS eye) -- a much more
      // fitting default poster for a channel built to represent that
      // whole network than an arbitrary single show's poster, which is
      // what this fell back to before. Best-effort: if TMDB doesn't
      // have a logo for this network id, the client already has its
      // own fallback (the first show's poster) for that case.
      let networkLogo = null;
      try {
        const networkRes = await fetch(
          `https://api.themoviedb.org/3/network/${encodeURIComponent(networkId)}?api_key=${encodeURIComponent(TMDB_API_KEY)}`,
          { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` }, cf: { cacheTtl: 604800, cacheEverything: true } }
        );
        if (networkRes.ok) {
          const networkData = await networkRes.json();
          // A specific size (not "original") is required here --
          // TMDB serves the network's raw uploaded logo file at
          // "original", which for many networks is an .svg, and
          // Stremio/wako can't render an SVG as a poster (this was the
          // actual cause of the logo silently never showing and
          // falling back to a show's poster instead). Any fixed pixel
          // size forces TMDB to rasterize it to PNG first.
          if (networkData.logo_path) networkLogo = `${url.origin}/api/channel-logo?path=${encodeURIComponent(networkData.logo_path)}`;
        }
      } catch {
        // best-effort -- fall through with networkLogo left null
      }
      const shows = await mapWithConcurrency(discoverResults, 8, async (show) => {
        const details = await fetchTmdbDetails(show.id, "tv", TMDB_API_KEY);
        if (!details.imdbId) return null;
        return {
          imdbId: details.imdbId,
          tmdbId: show.id,
          name: show.name,
          poster: show.poster_path ? `https://image.tmdb.org/t/p/w500${show.poster_path}` : null,
          backdrop: show.backdrop_path ? `https://image.tmdb.org/t/p/w780${show.backdrop_path}` : null,
        };
      });
      // Always the shared key -- the discover page loop
      // (discoverPagesFetched), the network logo lookup (1), and one
      // fetchTmdbDetails call per discovered show all landed above.
      ctx.waitUntil(bumpStatBy(env, "apiuse:tmdb", discoverPagesFetched + 1 + discoverResults.length));
      const resolved = shows.filter(Boolean);
      if (!resolved.length) return json({ ok: false, error: "Couldn't resolve any shows for that network to IMDB." });
      return json({ ok: true, shows: resolved, networkLogo });
    }

    // A pasted list link can be any of this add-on's supported sources
    // (mdblist/trakt/tmdb) and can be mixed movies+shows -- requesting
    // type "series" specifically both narrows to just the shows
    // (silently dropping any movies in the same list) and reuses the
    // exact same fetchCatalog dispatch every other list source already
    // goes through, instead of this route only ever understanding
    // mdblist's own JSON shape like it used to.
    let metas;
    try {
      metas = await fetchCatalog({ url: listUrl, type: "series" }, 0, { mdblistKey, traktKey, traktAccessToken, env, ctx, origin: url.origin });
    } catch (err) {
      return json({ ok: false, error: `Could not read that list: ${err.message || err}` });
    }
    if (!metas.length) {
      return json({ ok: false, error: "That list has no shows in it (Channels are shows-only -- any movies are skipped)." });
    }

    const shows = await mapWithConcurrency(metas, 8, async (m) => {
      try {
        const findRes = await fetch(
          `https://api.themoviedb.org/3/find/${m.id}?api_key=${encodeURIComponent(TMDB_API_KEY)}&external_source=imdb_id`,
          { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` }, cf: { cacheTtl: 604800, cacheEverything: true } }
        );
        if (!findRes.ok) return null;
        const findData = await findRes.json();
        const match = (findData.tv_results || [])[0];
        if (!match) return null;
        return {
          imdbId: m.id,
          tmdbId: match.id,
          name: m.name,
          poster: m.poster || (match.poster_path ? `https://image.tmdb.org/t/p/w500${match.poster_path}` : null),
          backdrop: match.backdrop_path ? `https://image.tmdb.org/t/p/w780${match.backdrop_path}` : (m.poster || null),
        };
      } catch {
        return null;
      }
    });
    // Always the shared key -- one TMDB find call per item in the list.
    ctx.waitUntil(bumpStatBy(env, "apiuse:tmdb", metas.length));
    const resolved = shows.filter(Boolean);
    if (!resolved.length) return json({ ok: false, error: "Couldn't resolve any shows in that list to TMDB." });
    return json({ ok: true, shows: resolved });
  } catch (err) {
    return json({ ok: false, error: safeErrorMessage(err) });
  }
}

// /api/resolve-movie?tmdbId=...
// -> resolves a movie's IMDB id when it's added to a Custom List.
async function apiResolveMovie(env, ctx, url) {
  const tmdbId = url.searchParams.get("tmdbId") || "";
  if (!tmdbId) return json({ ok: false, error: "Missing tmdbId." }, 400);
  try {
    ctx.waitUntil(bumpStat(env, "apiuse:tmdb"));
    const details = await fetchTmdbDetails(tmdbId, "movie", TMDB_API_KEY);
    if (!details.imdbId) return json({ ok: false, error: "Couldn't resolve an IMDB id for this movie." });
    return jsonCacheable({ ok: true, imdbId: details.imdbId, runtime: Number.isInteger(details.runtime) ? details.runtime : null });
  } catch (err) {
    return json({ ok: false, error: safeErrorMessage(err) });
  }
}

// /api/resolve-show?tmdbId=...
// -> resolves a show's IMDB id when it's added to a Custom List (a
// whole-show pick, not per-episode -- that's the Channels panel).
async function apiResolveShow(env, ctx, url) {
  const tmdbId = url.searchParams.get("tmdbId") || "";
  if (!tmdbId) return json({ ok: false, error: "Missing tmdbId." }, 400);
  try {
    ctx.waitUntil(bumpStat(env, "apiuse:tmdb"));
    const details = await fetchTmdbDetails(tmdbId, "tv", TMDB_API_KEY);
    if (!details.imdbId) return json({ ok: false, error: "Couldn't resolve an IMDB id for this show." });
    return jsonCacheable({ ok: true, imdbId: details.imdbId });
  } catch (err) {
    return json({ ok: false, error: safeErrorMessage(err) });
  }
}
