// Routes the Stremio, Nuvio and Wako apps call (configure, manifest, subtitles ping, catalog rows, meta, scrobble webhook), moved out of handleFetch (CQ-01).

// Moved unchanged: each route body is now its own function; the dispatchers keep each route's
// original path/method test and are plain functions that return a Response promise or null, so
// the hot catalog path takes no extra await. Auth goes through the top-level ...For functions
// (authenticateCreatorFor, handleSubtitlesTrackFor, handleMediaServerScrobbleFor).

// /:config/configure, /channel/<code> and /configure, at their original place. Returns a Response promise, or null.
function handleInstallConfigureRoutes(request, env, ctx, url, path) {
  let m = path.match(/^\/([^/]+)\/configure$/);
  if (m) return installConfigurePage(request, env, ctx, url, m);
  m = path.match(/^\/channel\/([A-Za-z0-9_-]{1,64})$/);
  if (m) return channelShareRedirect(env, ctx, url, m);
  if (path === "/configure") return builderConfigurePage(request, env, ctx, url);
  return null;
}

// /:config/configure  -> opened by wako itself when the user taps
// "Configure" on the already-installed add-on
async function installConfigurePage(request, env, ctx, url, m) {
  ctx.waitUntil(bumpStat(env, "pageviews"));
  // The page no longer carries the config's provider keys or tokens. It
  // used to write them into the HTML, so anyone holding an install link --
  // which gets pasted into apps and shared -- could read a Trakt or
  // MDBList token straight out of /<id>/configure. The builder does not
  // need them: a signed-in save uses the account's own keys (restored to
  // any device by account sync), and a signed-out save stores none
  // (docs/DECISIONS.md D-8). With nothing embedded, the page falls back to
  // whatever this browser already has.
  const resolvedForPage = await resolveConfig(m[1], env);
  // The one page that still sends no-store (it renders the person's own
  // API keys -- see the note on the headers below), but it should not
  // also be re-sending the 1.3MB client bundle every time. The split
  // separates the two concerns exactly: the small page that carries the
  // keys stays uncacheable, while the bundle it references is the same
  // shared, immutable /app.js everyone else already has.
  return new Response(
    await pageWithExternalBundle(renderPage(request, url.origin, {
      initialEntries: resolvedForPage.entries,
      // Every setting the link carries except its keys and tokens. This
      // used to name seven fields by hand and left Better Posters out, so
      // the page showed it off for an install that had it on.
      initialKeys: nonSecretInstallConfigFields(resolvedForPage),
      isConfigureMode: true,
    })),
    // The one builder page that deliberately keeps no-store rather than
    // moving to an ETag like the rest: this variant renders the install
    // link's own rows into the HTML (its API keys are no longer part of
    // that -- see nonSecretInstallConfigFields above), and no-store keeps
    // a page built for one link out of the browser's on-disk cache and
    // out of any intermediary.
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );
}

// /channel/<code> -- what a channel share link actually points at.
//
// A redirect rather than its own page: everything needed to accept a
// shared channel (the local channel store, the Catalogs rows, the
// Channels tab) already lives on the builder page, so this hands the
// code to it in the fragment and handleInitialDeepLink takes it from
// there. The fragment, not the query string, because a fragment is
// never sent to the server or written into its logs -- an unlisted
// channel's code is the only thing protecting it.
async function channelShareRedirect(env, ctx, url, m) {
  ctx.waitUntil(bumpStat(env, "pageviews"));
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${url.origin}/configure#channel=${encodeURIComponent(m[1])}`,
      "Cache-Control": "no-store",
      ...corsHeaders(),
    },
  });
}

// bare /configure (no config yet) -> same builder, empty/default state
async function builderConfigurePage(request, env, ctx, url) {
  ctx.waitUntil(bumpStat(env, "pageviews"));
  return await htmlPageResponse(
    request,
    renderPageCached(request, url.origin, { isConfigureMode: true })
  );
}

// /:config/manifest.json, /manifest.json and /:config/subtitles/..., at their original place. Returns a Response promise, or null.
function handleStremioManifestRoutes(request, env, ctx, url, path) {
  let m = path.match(/^\/([^/]+)\/manifest\.json$/);
  if (!m && path.indexOf("/c/") === 0) m = path.slice(2).match(/^\/([^/]+)\/manifest\.json$/);
  if (m) return installManifest(request, env, ctx, url, m);
  if (path === "/manifest.json" || path.indexOf("/c/manifest.json") === 0) return bareManifest(request, url);
  m = path.match(/^\/([^/]+)\/subtitles\/(movie|series)\/([^/]+?)(?:\/[^/]+)?\.json$/);
  if (!m && path.indexOf("/c/") === 0) m = path.slice(2).match(/^\/([^/]+)\/subtitles\/(movie|series)\/([^/]+?)(?:\/[^/]+)?\.json$/);
  if (m) return subtitlesPing(request, env, ctx, path, m);
  return null;
}

// /:config/manifest.json
async function installManifest(request, env, ctx, url, m) {
  // If this looks like a browser page-load (e.g. wako sent you here for
  // "Configure") rather than a JSON fetch by the app, send the user to
  // the actual editable configure page instead of showing raw JSON.
  if (isBrowserNavigation(request) && m[1] !== "nuvio-default") {
    return Response.redirect(`${url.origin}/${m[1]}/configure`, 302);
  }
  const resolved = await resolveConfig(m[1], env);
  // Nothing by that name: a 404 the app can show, and nothing cached, so a
  // link whose record is not yet visible here works on the next try.
  if (resolved.unresolved) {
    return json({ ok: false, error: "That install link was not found." }, 404, { ...corsHeaders(), "Cache-Control": "no-store" });
  }
  const { entries, track, shuffleShelves } = resolved;
  // Moves this link's keys and tokens out of its KV record, if they are
  // still there and the move is switched on. After the response.
  ctx.waitUntil(maybeMigrateLegacyInstall(env, m[1]));
  // A shelf's title in the apps comes from here, so the title has to be
  // read from the same live copy the shelf's items are read from
  // (liveShelfNames, 05_catalog-core.js) -- otherwise renaming a list on
  // the website changed it everywhere except in Stremio and Nuvio, which
  // kept showing the old name for as long as the link existed.
  //
  // Only a manifest holding a list with a live copy is sent no-store: the
  // title is part of what can still change, and a cached copy is a copy
  // that disagrees. This is the request an app makes on install and on
  // refresh, not the per-board-visit catalog read, so the cost of not
  // caching it is a KV read or two per custom-list row on the rare
  // request rather than on every shelf fetch.
  const liveNames = await liveShelfNames(env, entries, {
    trackCreatorName: resolved.trackCreatorName,
    verifiedOwner: resolved.trackOwner,
  });
  const hasLiveShelf = entries.some((e) => e && typeof e.url === 'string' && (
    customListRowIsLive(e.url, !!resolved.trackCreatorName) || !!parsePublishedListUrl(e.url)
  ));
  const manifestEntries = [...entries];
  const userChannels = await loadUserChannelsForManifest(m[1], env);
  const hasLiveState = (hasLiveShelf || resolved.collectionsAddon || !!resolved.trackOwner || (Array.isArray(userChannels) && userChannels.length > 0));
  return jsonPublic(
    buildManifest(manifestEntries, url.origin, track, shuffleShelves, m[1], liveNames, resolved.provideMetadata !== false, url.searchParams.get("collections") === "1", resolved.collectionsAddon === true),
    200,
    hasLiveState ? { "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0" } : {}
  );
}

// bare manifest.json with no config
async function bareManifest(request, url) {
  if (isBrowserNavigation(request)) {
    return Response.redirect(`${url.origin}/configure`, 302);
  }
  return jsonPublic(buildManifest([], url.origin));
}

// /:config/subtitles/:type/:id.json -- see buildManifest's comment
// above on why wako/Stremio calls this even though the addon has no
// real subtitles to offer. type is "movie" or "series"; id is a plain
// "tt1234567" for a movie, or "tt1234567:5:10" (imdbId:season:episode)
// for an episode -- Stremio's own id convention for TV, nothing
// specific to this addon. The trailing (?:\/[^/]+)? tolerates the extra
// videoHash=...&videoSize=...&filename=... path segment real Stremio
// (as opposed to hand-built test requests) appends before .json when a
// stream actually has that metadata -- without it, every genuine
// Stremio playback ping 404'd here and never reached
// handleSubtitlesTrack below, so Auto-track Playback looked broken
// specifically on Stremio even though it worked fine against a bare
// .../subtitles/movie/tt1234567.json test call.
async function subtitlesPing(request, env, ctx, path, m) {
  const [, configParam, stremioType, rawId] = m;
  // Answer immediately with an empty subtitle list regardless of what
  // happens below -- there's nothing to show wako/Stremio either way,
  // and the actual tracking write (a TMDB lookup plus a KV read/write)
  // shouldn't hold up how fast this responds. ctx.waitUntil lets it
  // keep running after the response is already on its way.
  ctx.waitUntil(handleSubtitlesTrackFor(configParam, stremioType, safeDecodeURIComponent(rawId), env, request, ctx, path));
  return jsonPublic({ subtitles: [] });
}

// /:config/catalog/:type/:id.json, at its original place. Returns a Response promise, or null.
function handleStremioCatalogRoute(request, env, ctx, url, path) {
  let m = path.match(/^(?:\/([^/]+))?\/catalog\/([^/]+)\/(.+)\.json$/);
  if (!m && path.indexOf("/c/") === 0) m = path.slice(2).match(/^(?:\/([^/]+))?\/catalog\/([^/]+)\/(.+)\.json$/);
  if (m) return stremioCatalogRow(request, env, ctx, url, m);
  return null;
}

// /:config/catalog/:type/:id.json (or /catalog/:type/:id.json)
// optionally /:config/catalog/:type/:id/skip=N.json or /:config/catalog/:type/:id/search=Q.json
async function stremioCatalogRow(request, env, ctx, url, m) {
  const [, config, type, idWithExtra] = m;
  const [id, extraStr] = idWithExtra.split("/");
  // New browse rows have explicit kind restrictions, even when a stale or
  // hand-edited install config tries to address the other kind.
  const browseKey = id.startsWith("tmdb-chart-") ? id.slice("tmdb-chart-".length) : "";
  const browseRow = browseKey && typeof STREAMING_ROW_BY_CHART_KEY !== "undefined" ? STREAMING_ROW_BY_CHART_KEY[browseKey] : null;
  if (browseRow && browseRow.additional && !browseRow.kinds[type]) return jsonPublic({ metas: [] }, 200, CATALOG_NO_CACHE);
  const extra = Object.fromEntries(new URLSearchParams(extraStr || ""));
  const skip = parseInt(extra.skip, 10) || 0;
  const searchQuery = extra.search ? safeDecodeURIComponent(extra.search).trim() : "";

  // Dedicated search catalogs for Stremio and Nuvio
  const isSearchCatalog = id === "search_movies" || id === "search_series" || id === "search" || id === "search_movie" || (id === "top" && searchQuery);
  if (isSearchCatalog) {
    if (!searchQuery) return jsonPublic({ metas: [] });
    const searchLimited = await searchRateLimitResponse(request, env, ctx);
    if (searchLimited) return searchLimited;
    const searchConfig = config ? await resolveConfig(config, env) : {};
    const effectiveTmdbKey = searchConfig.tmdbKey || TMDB_API_KEY;
    let metas = await searchCatalogMetas(searchQuery, type, skip, effectiveTmdbKey, env, ctx, url.origin);
    // FF_CANONICAL_IDS (43_catalog-ids.js), as fetchCatalog does for rows.
    metas = await canonicalizeCatalogMetas(env, metas, { kind: type });
    // This route builds its metas directly rather than through
    // fetchCatalog, so it needs its own call -- otherwise search results
    // would be the one row in Stremio still showing the old artwork.
    const searchArt = betterPostersOptionsFrom(searchConfig, url.origin, config);
    if (searchConfig.betterPosters || searchArt.pictoriumTemplate || searchArt.rpdbBase) {
      metas = applyBetterPostersToMetas(metas, searchArt);
    }
    metas = await enrichCatalogPreviews(metas, effectiveTmdbKey);
    return jsonPublic({ metas }, 200, { "Cache-Control": metas.previewIncomplete ? "public, max-age=30" : "public, max-age=3600, stale-while-revalidate=86400" });
  }

  // Only a request with no install config needs the chart/collection lookup up
  // front. With a config, a row it lists is served from the config, and a row it
  // does not list reaches the same two lookups below (entryIndex < 0).
  let unconfiguredEntry = null;
  if (!config) {
    if (typeof findChartOrCollectionEntry === "function") {
      unconfiguredEntry = findChartOrCollectionEntry(id, type);
    }
    if (!unconfiguredEntry && env && env.CONFIGS) {
      try {
        unconfiguredEntry = await env.CONFIGS.get(`col_cat:${id}:${type}`, "json");
      } catch {}
    }
  }
  if (!config && !unconfiguredEntry) return jsonPublic({ metas: [] });

  // Kept as a whole object as well as destructured: the betterPosters*
  // style keys are passed through wholesale rather than one at a time.
  const resolvedConfig = config
    ? await resolveConfig(config, env)
    : { entries: [unconfiguredEntry], tmdbKey: null, mdblistKey: null, mdblistAccessToken: null, traktKey: null, traktAccessToken: null, simklKey: null, simklAccessToken: null, shuffleItems: false, trackCreatorName: null, trackOwner: null, region: null, hideNonDigitalReleases: false, adultContentFilter: false, dedupeAcrossLists: false, betterPosters: null, showBadgesStremio: false, showBadgesStremioAiringNext: false, showBadgesStremioContinueWatching: false, showBadgesStremioCatalogs: false, showBadgesStremioWatchlist: false };

  // As in the manifest route: most installs ask for catalogs far more often.
  if (config) {
    ctx.waitUntil(maybeMigrateLegacyInstall(env, config));
  }
  const { entries, tmdbKey, mdblistKey, mdblistAccessToken, traktKey, traktAccessToken, simklKey, simklAccessToken, shuffleItems, trackCreatorName, trackOwner, region, hideNonDigitalReleases, adultContentFilter, dedupeAcrossLists, betterPosters, showBadgesStremio, showBadgesStremioAiringNext, showBadgesStremioContinueWatching, showBadgesStremioCatalogs, showBadgesStremioWatchlist } = resolvedConfig;
  const entryIndex = entries.findIndex((e) => e.id === id && e.type === type);
  if (resolvedConfig.collectionsAddon && entryIndex < 0) return jsonPublic({ metas: [] }, 200, CATALOG_NO_CACHE);
  let entry = entryIndex >= 0 ? entries[entryIndex] : unconfiguredEntry;
  if (!entry && typeof findChartOrCollectionEntry === "function") {
    entry = findChartOrCollectionEntry(id, type);
  }
  if (!entry && env && env.CONFIGS) {
    try {
      entry = await env.CONFIGS.get(`col_cat:${id}:${type}`, "json");
    } catch {}
  }
  if (!entry && typeof CHART_SLUG_ENTRIES !== "undefined" && Array.isArray(CHART_SLUG_ENTRIES)) {
    const found = CHART_SLUG_ENTRIES.find((c) => {
      const mSlug = typeof slugifyServer === "function" ? slugifyServer(c.movieUrl || c.url || "") : "";
      const sSlug = typeof slugifyServer === "function" ? slugifyServer(c.showUrl || c.url || "") : "";
      const nSlug = typeof slugifyServer === "function" ? slugifyServer(c.name || "") : "";
      const cSlug = typeof slugifyServer === "function" ? slugifyServer(c.slug || "") : "";
      return id === mSlug || id === sSlug || id === nSlug || id === cSlug;
    });
    if (found) {
      entry = {
        id,
        name: found.name,
        type: type,
        url: type === "series" ? (found.showUrl || found.movieUrl) : (found.movieUrl || found.showUrl),
        enabled: true
      };
    }
  }
  if (resolvedConfig.unresolved || !entry || entry.enabled === false) {
    const channelMetas = await fetchChannelItemsCatalog(id, type, config, env, ctx, url, resolvedConfig);
    if (channelMetas && channelMetas.length) {
      return jsonPublic({ metas: channelMetas }, 200, CATALOG_NO_CACHE);
    }
    return jsonPublic({ metas: [] }, 200, CATALOG_NO_CACHE);
  }

  // Every line of the row, not just the first: a merged row stores its
  // sources newline-separated (see fetchCatalog), and one personal source
  // anywhere in it makes the whole row one account's live state.
  const rowSources = String(entry.url || "").split("\n").map((u) => u.trim()).filter(Boolean).map(detectSource);
  const isAutoTrack = rowSources.includes("autotrack");
  // Rows whose content is one account's live state, and so must never be
  // cached: the next request has to see what changed since. "curated" is
  // Recommended Movies/Shows (the account's pushed Discover snapshot),
  // and the Trakt/MDBList progress shelves change every time something
  // is watched. All of them used to fall through to the day-long public
  // cache below, which let Stremio and Nuvio keep a day-old copy.
  const isUserPersonal = rowSources.some((src) => STREMIO_LIVE_ROW_SOURCES.has(src));
  // A custom-list row that resolves live -- a Creator list, a
  // token-addressed one, or a local snapshot this config's account has a
  // server copy of -- changes because of something the person DID on the
  // website, so it gets the same no-store treatment as the shelves above
  // rather than the five-minute public cache: an item removed from a
  // list has to disappear from the row on the next fetch, not five
  // minutes later. A row that names nothing live keeps the public cache
  // (there is nothing server-side for it to change).
  const isLiveCustomList = rowSources.includes("custom-list") &&
    customListRowIsLive(entry.url, !!trackCreatorName);

  // A personal row whose provider connection needs signing in again
  // (token.refresh, P5-7): one tile saying so, instead of an empty row.
  if (isUserPersonal && Array.isArray(resolvedConfig.reconnect) && resolvedConfig.reconnect.length) {
    const rowProviders = String(entry.url || "").split("\n").map((u) => u.trim()).filter(Boolean).map((u) => resolveSourceRef(u).provider);
    const reconnectProvider = rowProviders.find((p) => resolvedConfig.reconnect.includes(p));
    if (reconnectProvider) {
      const label = (providerAdapter(reconnectProvider) || {}).label || reconnectProvider;
      return jsonPublic({
        metas: skip === 0 ? [{
          id: "tt0000000",
          type: entry.type,
          name: `Reconnect ${label} at mylistsaddon.com`,
          description: `${label} asked to be signed in again. Open mylistsaddon.com, sign in, and reconnect ${label} in Settings; this row then fills again.`,
          poster: `${url.origin}/reconnect-poster.svg?provider=${encodeURIComponent(reconnectProvider)}`,
        }] : [],
      }, 200, { "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0" });
    }
  }
  return stremioCatalogRowFetch(env, ctx, { url, config, type, id, skip, searchQuery, resolvedConfig, entries, tmdbKey, mdblistKey, mdblistAccessToken, traktKey, traktAccessToken, simklKey, simklAccessToken, shuffleItems, trackCreatorName, trackOwner, region, hideNonDigitalReleases, adultContentFilter, dedupeAcrossLists, betterPosters, showBadgesStremio, showBadgesStremioAiringNext, showBadgesStremioContinueWatching, showBadgesStremioCatalogs, showBadgesStremioWatchlist, entryIndex, entry, isAutoTrack, isUserPersonal, isLiveCustomList });
}

// The rest of stremioCatalogRow, moved unchanged: the same statements in the same order, split only for the 150-line limit.
async function stremioCatalogRowFetch(env, ctx, { url, config, type, id, skip, searchQuery, resolvedConfig, entries, tmdbKey, mdblistKey, mdblistAccessToken, traktKey, traktAccessToken, simklKey, simklAccessToken, shuffleItems, trackCreatorName, trackOwner, region, hideNonDigitalReleases, adultContentFilter, dedupeAcrossLists, betterPosters, showBadgesStremio, showBadgesStremioAiringNext, showBadgesStremioContinueWatching, showBadgesStremioCatalogs, showBadgesStremioWatchlist, entryIndex, entry, isAutoTrack, isUserPersonal, isLiveCustomList }) {
  // Graceful degradation only applies to the first page (skip === 0):
  // that's the case that makes a whole shelf silently vanish from the
  // home screen, whereas a failure deeper into pagination (scrolling
  // for "load more") is far less disruptive to just show as empty, like
  // before.
  //
  // The last good page is kept in this data center's Cache API, not KV.
  // It used to be a KV `lastgood:` key written on EVERY successful
  // first-page load -- one billed KV write per Stremio row request, against
  // KV's one-write-per-second-per-key limit. A per-colo copy is enough for
  // what it is for (a provider outage longer than the provider cache's own
  // stale window), and Cache API writes cost nothing.
  const staleReq = !isAutoTrack && !isUserPersonal && !isLiveCustomList
    ? new Request(`https://my-lists-addon.internal/lastgood/${encodeURIComponent(config)}/${encodeURIComponent(type)}/${encodeURIComponent(id)}`)
    : null;

  try {
    // verifiedOwner, not trackCreatorName: a personal shelf is served only
    // to a config that PROVED it belongs to that account. See resolveConfig
    // (04_config-resolution.js) for how that is established and
    // mayReadTrackedShelf (02_http-and-creator-utils.js) for what it gates.
    const catalogKeys = { tmdbKey, mdblistKey, mdblistAccessToken, traktKey, traktAccessToken, simklKey, simklAccessToken, shuffleItems, configParam: config, trackCreatorName, verifiedOwner: trackOwner, region, hideNonDigitalReleases, adultContentFilter, isStremioCatalog: true, canonicalIds: true, betterPosters, betterPostersOptions: betterPostersOptionsFrom(resolvedConfig, url.origin, config), showBadgesStremio, showBadgesStremioAiringNext, showBadgesStremioContinueWatching, showBadgesStremioCatalogs, showBadgesStremioWatchlist, env, ctx, origin: url.origin };
    // FF_MATERIALIZER (P5-11, 54_materializer.js): with de-duplication, the
    // first page of every non-personal row is built once per install and
    // de-duplicated in one pass, instead of each row rebuilding the rows
    // above it. Null means the usual path below.
    let metas = dedupeAcrossLists && skip === 0 && !searchQuery && !isUserPersonal && isMaterializerEnabled(env)
      ? await materializedRowPage(env, ctx, { config, entries, entryIndex, keys: catalogKeys })
      : null;
    const materialized = !!metas;
    if (!metas) metas = await fetchCatalog(entry, skip, catalogKeys);
    if (dedupeAcrossLists && !materialized) {
      metas = await dedupeAcrossListEntries(entries, entryIndex, skip, metas, { tmdbKey, mdblistKey, mdblistAccessToken, traktKey, traktAccessToken, simklKey, simklAccessToken, shuffleItems, configParam: config, trackCreatorName, verifiedOwner: trackOwner, region, hideNonDigitalReleases, canonicalIds: true, env, ctx });
    }
    if (searchQuery && Array.isArray(metas) && metas.length > 0) {
      const sq = searchQuery.toLowerCase();
      metas = metas.filter((it) => (it.name && it.name.toLowerCase().includes(sq)) || (it.title && it.title.toLowerCase().includes(sq)));
    }
    // All catalog sources (including user lists and merged rows) use the
    // same preview enrichment after filtering and deduplication.
    metas = await enrichCatalogPreviews(metas, tmdbKey || TMDB_API_KEY);
    if (staleReq && skip === 0 && metas.length > 0 && !searchQuery && !metas.previewIncomplete) {
      // Fire-and-forget -- the response doesn't wait on this write.
      try {
        ctx.waitUntil(
          caches.default.put(staleReq, new Response(JSON.stringify(metas), {
            headers: { "Content-Type": "application/json", "Cache-Control": "s-maxage=2592000" },
          })).catch(() => {})
        );
      } catch {
        // No Cache API available: the fallback just has nothing to serve.
      }
    }
    if (isUserPersonal) {
      return jsonPublic({ metas }, 200, { "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0" });
    }
    // An account's own list: re-read on every request, so only a short
    // window (CATALOG_LIVE_LIST_MAX_AGE) -- not a day, and not none.
    if (isLiveCustomList) {
      return jsonPublic({ metas, cacheMaxAge: CATALOG_LIVE_LIST_MAX_AGE, staleRevalidate: CATALOG_LIVE_LIST_MAX_AGE },
        200, { "Cache-Control": `public, max-age=${CATALOG_LIVE_LIST_MAX_AGE}` });
    }
    // Thirty minutes for every shared row -- charts, New on Streaming, Most
    // Watched, public/provider lists. It was five minutes, and a day before
    // that; the apps ask once per row per home screen, so this is the
    // number that sets the Workers request count. Upstream rate limits are
    // still guarded by the fetchers' own freshTtlSec windows.
    // A deadline-limited page retries promptly, rather than caching the
    // incomplete preview for the entire shared-catalog lifetime.
    const previewMaxAge = metas.previewIncomplete ? 30 : CATALOG_SHARED_MAX_AGE;
    return jsonPublic({ metas, cacheMaxAge: previewMaxAge, staleRevalidate: metas.previewIncomplete ? 30 : CATALOG_STALE_REVALIDATE },
      200, { "Cache-Control": `public, max-age=${previewMaxAge}, s-maxage=${previewMaxAge}` });
  } catch (err) {
    const errMsg = safeErrorMessage(err);
    if (isUserPersonal || isLiveCustomList) {
      console.error("User personal catalog fetch error:", errMsg);
      return jsonPublic({ metas: [] }, 200, { "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0" });
    }

    if (skip === 0 && staleReq) {
      try {
        const hit = await caches.default.match(staleReq);
        const stale = hit ? await hit.text() : null;
        if (stale) {
          // Genuine last-known-good data -- real "tt" ids, renders
          // exactly like a normal successful load. `stale` is
          // informational only (visible when debugging via curl), not
          // read by wako/Stremio itself.
          return jsonPublic({ metas: JSON.parse(stale), stale: true, error: errMsg }, 200, CATALOG_NO_CACHE);
        }
      } catch {
        // Cache read/parse failed -- fall through to the placeholder below.
      }
      // No last-known-good data to fall back on (this list has never
      // successfully loaded in this data center) -- show one placeholder
      // tile so the row still appears instead of silently disappearing.
      // Uses a dummy "tt"-prefixed id since the manifest declares
      // idPrefixes: ["tt", ...] and some clients filter out anything else.
      return jsonPublic({
        metas: [
          {
            id: "tt0000000",
            type: entry.type,
            name: (entry.name || "This list") + " \u2014 temporarily unavailable",
            poster: `${url.origin}/unavailable-poster.svg`,
          },
        ],
        error: errMsg,
      }, 200, CATALOG_NO_CACHE);
    }

    // Metas stays empty so wako/Stremio just shows an empty row instead
    // of erroring out, but the reason is still visible if you curl this
    // URL directly while debugging.
    return jsonPublic({ metas: [], error: errMsg }, 200, CATALOG_NO_CACHE);
  }
}

// /api/scrobble and /:config/meta/:type/:id.json, at their original place. Returns a Response promise, or null.
function handleScrobbleAndMetaRoutes(request, env, ctx, url, path) {
  if (path.startsWith("/api/scrobble")) return mediaServerScrobbleRoute(request, env, ctx, url);
  let m = path.match(/^(?:\/([^/]+))?\/meta\/([^/]+)\/(.+)\.json$/);
  if (m) return stremioMetaItem(env, ctx, url, m);
  return null;
}

// /api/scrobble (and subpaths /api/scrobble/webhook, /api/scrobble/plex, /api/scrobble/jellyfin, /api/scrobble/emby)
// Automated scrobbling endpoint for media servers (Plex, Jellyfin, Emby)
async function mediaServerScrobbleRoute(request, env, ctx, url) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }
  return handleMediaServerScrobbleFor(request, url, env, ctx);
}

// /:config/meta/:type/:id.json (or /meta/:type/:id.json)
// Resolves metadata for Channels (channel_*) and standard IMDb titles (tt*).
// Provides full metadata (posters, backgrounds, overviews, ratings, cast, and
// full episode lists) so clients without dedicated metadata addons (like Nuvio)
// automatically render complete detail and playback pages.
async function stremioMetaItem(env, ctx, url, m) {
  const [, config, metaType, idRaw] = m;
  const id = safeDecodeURIComponent(idRaw);

  // 1. Synthetic meta for Channels
  if (id.startsWith("channel_")) {
    if (metaType !== "series") return jsonPublic({ meta: null });
    const wantedChannelId = id.slice("channel_".length);
    try {
      // watchHistory/continueWatching feed the channel flags that read
      // the account rather than the payload -- "Hide watched" and the
      // dynamic Next Up channel. resolveConfig only fills them in for a
      // config that PROVED whose it is (see trackOwner there), so an
      // unverified config simply gets a channel with neither applied.
      const metaResolved = await resolveConfig(config, env, { withTracking: true });
      if (metaResolved.unresolved) return jsonPublic({ meta: null }, 200, CATALOG_NO_CACHE);
      const { entries, watchHistory, continueWatching, tmdbKey, mdblistKey, traktKey, traktAccessToken } = metaResolved;
      let matchedEntry = null;
      for (const e of entries) {
        if (e.enabled === false) continue;
        const subUrls = String(e.url || "").split("\n").map((s) => s.trim()).filter(Boolean);
        for (const subUrl of subUrls) {
          const payload = parseChannelPayload(subUrl);
          if (!payload) continue;
          if ((payload.channelId || e.id) === wantedChannelId) {
            matchedEntry = { ...e, url: subUrl };
            break;
          }
        }
        if (matchedEntry) break;
      }
      if (!matchedEntry && (wantedChannelId || id)) {
        matchedEntry = await findChannelEntryById(wantedChannelId || id, config, env);
      }
      if (!matchedEntry) return jsonPublic({ meta: null });
      const meta = await buildChannelMeta(matchedEntry, url.origin, {
        env, ctx, origin: url.origin,
        watchHistory, continueWatching,
        tmdbKey, mdblistKey, traktKey, traktAccessToken,
      });
      return jsonPublic({ meta: meta || null });
    } catch (err) {
      return jsonPublic({ meta: null, error: safeErrorMessage(err) });
    }
  }

  // 2. Standard title metadata for IMDb ids ("tt...") or TMDB ids ("tmdb:...")
  if (id.startsWith("tt") || id.startsWith("tmdb:")) {
    try {
      const metaConfig = config ? await resolveConfig(config, env) : {};
      const effectiveKey = metaConfig.tmdbKey || TMDB_API_KEY;
      let meta = await fetchStandardItemMeta(id, metaType, effectiveKey, env, ctx);
      if (!meta) return jsonPublic({ meta: null });
      // Same opt-in artwork the catalog rows get, so a title's detail
      // page does not fall back to the plain poster the moment it is
      // opened. Only the poster is touched -- background, logo, cast and
      // the episode list all stay exactly as fetchStandardItemMeta built
      // them, and a non-IMDB id (tmdb:...) is left alone.
      const metaArt = betterPostersOptionsFrom(metaConfig, url.origin, config);
      if (metaConfig.betterPosters || metaArt.pictoriumTemplate || metaArt.rpdbBase) {
        meta = applyBetterPosterToMeta(meta, metaArt);
      }
      return jsonPublic(
        { meta },
        200,
        { "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800" }
      );
    } catch (err) {
      return jsonPublic({ meta: null, error: safeErrorMessage(err) });
    }
  }

  return jsonPublic({ meta: null });
}

async function loadUserChannelsForManifest(config, env) {
  if (!config || !env || !env.CONFIGS || config === "nuvio-default" || config === "default") return [];
  let username = "";
  if (env.DB) {
    try {
      const acct = await env.DB.prepare(
        "SELECT username FROM accounts WHERE username = ? COLLATE NOCASE OR id = ? OR key_hash = ? LIMIT 1"
      ).bind(config, config, config).first();
      if (acct) username = acct.username;
      else {
        const instRow = await env.DB.prepare(
          "SELECT account_id FROM installs WHERE legacy_cfg_id = ? OR token_hash = ? OR id = ? LIMIT 1"
        ).bind(config, config, config).first();
        if (instRow && instRow.account_id) {
          const linked = await env.DB.prepare("SELECT username FROM accounts WHERE id = ? LIMIT 1").bind(instRow.account_id).first();
          if (linked) username = linked.username;
        }
      }
    } catch {}
  }
  if (!username) {
    try {
      if (await env.CONFIGS.get(`creatorsyncchannels:${config}`)) username = config;
      else if (await env.CONFIGS.get(`creatorsync:${config}`)) username = config;
    } catch {}
  }
  if (!username) return [];

  try {
    const raw = await env.CONFIGS.get(`creatorsyncchannels:${username}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const channelsObj = (parsed && parsed.channels && typeof parsed.channels === "object") ? parsed.channels : parsed;
    if (!channelsObj || typeof channelsObj !== "object") return [];
    return Object.values(channelsObj).filter((ch) => ch && typeof ch === "object" && (ch.id || ch.channelId));
  } catch {
    return [];
  }
}

async function findChannelEntryById(wantedId, config, env) {
  if (!wantedId) return null;
  const cleanId = String(wantedId).trim();
  const strippedId = cleanId.replace(/^channel_/, "");

  let username = "";
  if (config && config !== "nuvio-default" && config !== "default") {
    if (env && env.DB) {
      try {
        const acct = await env.DB.prepare(
          "SELECT username FROM accounts WHERE username = ? COLLATE NOCASE OR id = ? OR key_hash = ? LIMIT 1"
        ).bind(config, config, config).first();
        if (acct) username = acct.username;
        else {
          const instRow = await env.DB.prepare(
            "SELECT account_id FROM installs WHERE legacy_cfg_id = ? OR token_hash = ? OR id = ? LIMIT 1"
          ).bind(config, config, config).first();
          if (instRow && instRow.account_id) {
            const linked = await env.DB.prepare("SELECT username FROM accounts WHERE id = ? LIMIT 1").bind(instRow.account_id).first();
            if (linked) username = linked.username;
          }
        }
      } catch {}
    }
    if (!username && env && env.CONFIGS) {
      try {
        if (await env.CONFIGS.get(`creatorsyncchannels:${config}`)) username = config;
        else if (await env.CONFIGS.get(`creatorsync:${config}`)) username = config;
      } catch {}
    }
  }

  if (username && env && env.CONFIGS) {
    try {
      const raw = await env.CONFIGS.get(`creatorsyncchannels:${username}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        const map = (parsed && parsed.channels && typeof parsed.channels === "object") ? parsed.channels : parsed;
        if (map && typeof map === "object") {
          for (const ch of Object.values(map)) {
            if (!ch || typeof ch !== "object") continue;
            const chId = String(ch.id || ch.channelId || "");
            if (chId === cleanId || chId === strippedId || `channel_${chId}` === cleanId || `ch_${chId}` === cleanId || `channel_preset_${chId}` === cleanId) {
              return {
                id: chId,
                name: ch.name || "Custom Channel",
                type: "series",
                url: "channel:v1:" + JSON.stringify(ch),
                enabled: true,
                payload: ch,
              };
            }
          }
        }
      }
    } catch {}
  }

  const netId = strippedId.replace(/^preset_/, "").replace(/^net_/, "");
  const networks = typeof QUICK_CHANNEL_PRESETS !== "undefined"
    ? QUICK_CHANNEL_PRESETS
    : (typeof CHANNEL_PRESET_NETWORKS !== "undefined" ? CHANNEL_PRESET_NETWORKS : []);
  const matchedNet = networks.find((n) => n.id === netId || `net_${n.id}` === netId || `ch_preset_${n.id}` === cleanId || `channel_preset_${n.id}` === cleanId || `ch_preset_${n.id}` === strippedId);
  if (matchedNet) {
    const netPayload = {
      channelId: `ch_preset_${matchedNet.id}`,
      id: `ch_preset_${matchedNet.id}`,
      name: matchedNet.name,
      presetNetworkId: String(matchedNet.id),
      dailyRotate: true,
      poster: `https://mylistsaddon.com/api/channel-poster?name=${encodeURIComponent(matchedNet.name)}&v=6`,
      posterUrl: `https://mylistsaddon.com/api/channel-poster?name=${encodeURIComponent(matchedNet.name)}&v=6`,
      logoUrl: matchedNet.logoPath ? `https://mylistsaddon.com/api/channel-logo?path=${encodeURIComponent(matchedNet.logoPath)}&v=7` : `/api/channel-logo?netId=${matchedNet.id}&v=7`,
    };
    return {
      id: `ch_preset_${matchedNet.id}`,
      name: matchedNet.name,
      type: "series",
      url: "channel:v1:" + JSON.stringify(netPayload),
      enabled: true,
      payload: netPayload,
    };
  }

  return null;
}

async function fetchChannelItemsCatalog(id, type, config, env, ctx, url, resolvedConfig) {
  if (!id) return null;
  const channelEntry = await findChannelEntryById(id, config, env);
  if (!channelEntry || !channelEntry.payload) return null;
  const payload = channelEntry.payload;
  try {
    const lineup = typeof resolveChannelLineup === "function"
      ? await resolveChannelLineup(payload, {
          env, ctx, origin: url.origin,
          now: Date.now(),
          watchHistory: resolvedConfig && resolvedConfig.watchHistory,
          continueWatching: resolvedConfig && resolvedConfig.continueWatching,
        })
      : null;
    let items = (lineup && Array.isArray(lineup.items) && lineup.items.length)
      ? lineup.items
      : (Array.isArray(payload.items) ? payload.items : []);
    if (!items.length && payload.presetNetworkId && typeof channelSourceItems === "function") {
      items = await channelSourceItems(payload, { env, ctx, origin: url.origin });
    }
    if (!items || !items.length) return [];

    return items.map((it, i) => {
      const streamId = (typeof channelItemStreamId === "function" ? channelItemStreamId(it) : "") || it.imdbId || (it.tmdbId ? `tmdb:${it.tmdbId}` : "") || it.id || `ch_item_${i}`;
      const itemType = it.kind === "movie" ? "movie" : (type === "movie" ? "movie" : "series");
      const itemTitle = it.title || (it.showName ? `${it.showName} S${it.season || 1}E${it.episode || (i + 1)}` : (it.name || "Item"));
      return {
        id: streamId,
        type: itemType,
        name: itemTitle,
        poster: it.poster || it.showPoster || it.thumbnail || payload.posterUrl || payload.poster || `${url.origin}/api/channel-poster?name=${encodeURIComponent(itemTitle)}&v=6`,
        thumbnail: it.thumbnail || it.poster || it.showBackdrop || payload.backdropUrl || payload.backdrop || `${url.origin}/api/channel-poster?name=${encodeURIComponent(itemTitle)}&format=landscape&v=6`,
        background: it.backdrop || it.showBackdrop || it.thumbnail || payload.backdropUrl || payload.backdrop || `${url.origin}/api/channel-poster?name=${encodeURIComponent(itemTitle)}&format=landscape&v=6`,
        description: it.overview || it.title || "",
        releaseInfo: it.released || (it.year ? String(it.year) : undefined),
      };
    });
  } catch (err) {
    console.error("fetchChannelItemsCatalog failed:", err);
    return [];
  }
}
