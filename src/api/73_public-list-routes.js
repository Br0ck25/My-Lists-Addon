// Public list pages and feeds (/lists/..., /channels/..., /api/search-published-lists), moved out of handleFetch (CQ-01).

// Moved unchanged: each route body is now its own function; the dispatchers keep each route's
// original path/method test (including the path.match regexes) and are plain functions that
// return a Response promise or null.

// /lists/public.json, /lists/curated/<slug>, /lists/<slug>, provider list pages and /channels/..., at their original place. Returns a Response promise, or null.
function handlePublicListPageRoutes(request, env, ctx, url, path) {
  if (path === "/lists/public.json" || path === "/api/public-lists.json") return listsPublicJson(env, ctx, url);
  let m = path.match(/^\/lists\/curated\/([A-Za-z0-9-]+)$/);
  if (m) return curatedListPage(request, env, ctx, url, m);
  m = path.match(/^\/lists\/([A-Za-z0-9-]+)$/);
  if (m) return chartListPage(request, env, ctx, url, m);
  if (path.startsWith("/lists/") && !path.endsWith(".json") && (path.startsWith("/lists/mdblist/") || path.startsWith("/lists/trakt/") || path.startsWith("/lists/tmdb/") || path.startsWith("/lists/simkl/") || path.startsWith("/lists/custom/") || path.startsWith("/lists/curated/"))) return providerListPage(request, env, ctx, url);
  if (path.startsWith("/channels/")) return publishedChannelPage(request, env, ctx, url, path);
  return null;
}

// /lists/<slug>  (single segment, no second "/") -> a clean, shareable
// url for one of the native/official charts (see CHART_SLUG_ENTRIES,
// 08_quickadd-chart-data.js) -- resolves the slug and serves the same
// builder page, but with that chart pre-opened in the list-details view
// (see SERVER_DEEP_LINK_LIST, 09_page-shell.js, and
// handleInitialDeepLink, 24_client-backup-restore-presets.js). This is
// distinct from /lists/:username/:listname below (always two segments,
// a person's own published Custom List) -- an unrecognized slug here
// just lands on the normal default builder page rather than a hard
// /lists/public.json or /api/public-lists.json -> JSON directory of all published public lists
async function listsPublicJson(env, ctx, url) {
  // From the v2 tables when FF_V2_LISTS_READ is on (P3b-6,
  // 33_lists-directory.js); null means use the legacy path below.
  const v2Directory = await v2PublicListsResponse(env, url);
  if (v2Directory) return v2Directory;
  if (!env || !env.CONFIGS) {
    return json({ ok: true, lists: [] }, 200, { "Cache-Control": "public, max-age=60", ...corsHeaders() });
  }
  // Preferred path: one KV read of the maintained index, no per-list
  // gets, no truncation at 150 keys. Falls back to the legacy bounded
  // scan below only while the index is being built for the first time.
  const limitParam = parseInt(url.searchParams.get("limit") || "", 10);
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
  // Default page stays 100 to match the previous response size;
  // callers can page through the rest instead of silently losing it.
  const pageSize = Math.min(Math.max(limitParam || 100, 1), 500);
  // The page is asked for in SQL now rather than sliced out of the whole
  // directory afterwards -- see getPublicListIndex.
  const indexEntries = await getPublicListIndex(env, ctx, { limit: pageSize, offset });
  if (indexEntries) {
    const page = indexEntries;
    const lists = page.map((e) => {
      const cleanSlug = e.slug || slugifyServer(e.name) || "list";
      const username = e.isCreator ? e.username : "user";
      return {
        name: e.name,
        slug: cleanSlug,
        creator: e.isCreator ? e.username : "Anonymous",
        type: e.type || "mixed",
        itemCount: e.itemCount || 0,
        likes: e.likes || 0,
        updatedAt: e.updatedAt || null,
        url: `${url.origin}/lists/${username}/${cleanSlug}`,
        jsonUrl: `${url.origin}/lists/${username}/${cleanSlug}.json`,
      };
    });
    return json(
      { ok: true, count: lists.length, total: Number(indexEntries.total) || lists.length, offset, lists },
      200,
      { "Cache-Control": "public, max-age=120", ...corsHeaders() }
    );
  }

  const fetchLimit = 150;
  // Account-owned lists only (legacy anonymous lists are not listed).
  const creatorRes = await env.CONFIGS.list({ prefix: "creatorlist:", limit: fetchLimit });
  const listKeys = [];
  (creatorRes.keys || []).forEach(k => {
    const rest = k.name.slice("creatorlist:".length);
    if (rest.includes(":")) listKeys.push({ key: k.name, isCreator: true });
  });

  const creatorExists = makeCreatorExistsMemo(env);
  const listPromises = listKeys.slice(0, 100).map(async ({ key, isCreator }) => {
    const raw = await env.CONFIGS.get(key);
    if (!raw) return null;
    try {
      const l = JSON.parse(raw);
      await stampListVisibilityIfNeeded(env, key, l);
      if (!isPublicListVisibility(l.visibility)) return null;
      let username = "Anonymous";
      let slug = l.slug || "";
      if (isCreator) {
        const parts = key.slice("creatorlist:".length).split(":");
        username = parts[0] || "creator";
        slug = parts[1] || slug;
      }
      // Never advertise a list whose creator no longer exists -- see
      // makeCreatorExistsMemo. The index path cannot produce one (the
      // rebuild skips orphans); this scan reads records directly, so it
      // has to ask.
      if (isCreator && !(await creatorExists(username))) return null;
      const cleanSlug = slug || slugifyServer(l.name) || "list";
      // `creator` is a display label; the URL needs the KEY NAMESPACE.
      // An anonymous list lives at publishedlist:user:<slug> and is served
      // from /lists/user/<slug>, but this fallback built the path out of
      // the display label instead -- so every anonymous list in the
      // directory advertised /lists/Anonymous/<slug>, which 404s. The
      // index path and /api/search-published-lists both get this right;
      // only this scan disagreed, and it is the one that runs on a fresh
      // deployment and for the whole of the first index rebuild.
      const urlUser = isCreator ? username : "user";
      return {
        name: l.name,
        slug: cleanSlug,
        creator: username,
        type: l.type || "mixed",
        itemCount: Array.isArray(l.items) ? l.items.length : (l.itemCount || 0),
        likes: l.likes || 0,
        updatedAt: l.updatedAt || l.createdAt || l.publishedAt || null,
        url: `${url.origin}/lists/${urlUser}/${cleanSlug}`,
        jsonUrl: `${url.origin}/lists/${urlUser}/${cleanSlug}.json`,
      };
    } catch {
      return null;
    }
  });

  const lists = (await Promise.all(listPromises)).filter(Boolean);
  return json({ ok: true, count: lists.length, lists }, 200, {
    "Cache-Control": "public, max-age=120",
    ...corsHeaders(),
  });
}

async function curatedListPage(request, env, ctx, url, m) {
  ctx.waitUntil(bumpStat(env, "pageviews"));
  const slug = m[1];
  // Looked up, not inferred -- see CURATED_LIST_ENTRIES
  // (08_quickadd-chart-data.js). An unknown slug falls through to the
  // default builder page, exactly as an unknown chart slug does.
  const curated = resolveCuratedSlug(slug);
  return await htmlPageResponse(
    request,
    curated
      ? renderPage(request, url.origin, { deepLinkList: { name: curated.name, type: curated.type, url: "custom:curated:" + curated.slug } })
      : renderPageCached(request, url.origin, {})
  );
}

async function chartListPage(request, env, ctx, url, m) {
  ctx.waitUntil(bumpStat(env, "pageviews"));
  let chart = resolveChartSlug(m[1]);
  if (!chart) {
    const slugLower = m[1].toLowerCase();
    if (slugLower === "continue-watching" || slugLower === "continue_watching") chart = { name: "Continue Watching", movieUrl: "autotrack:continue-watching", showUrl: "autotrack:continue-watching", type: "series" };
    if (slugLower === "watch-history" || slugLower === "watch_history") chart = { name: "Watch History", movieUrl: "autotrack:watch-history", showUrl: "autotrack:watch-history", type: "movie" };
    if (slugLower === "watchlist") chart = { name: "Watchlist", movieUrl: "autotrack:watchlist", showUrl: "autotrack:watchlist", type: "mixed" };
    if (slugLower === "new-movies") chart = { name: "New Releases", movieUrl: "tmdb:chart:new_movies", showUrl: "tmdb:chart:new_movies", type: "movie" };
    if (slugLower === "new-shows") chart = { name: "New Releases", movieUrl: "tmdb:chart:new_shows", showUrl: "tmdb:chart:new_shows", type: "series" };
  }
  return await htmlPageResponse(
    request,
    chart
      ? renderPage(request, url.origin, { deepLinkList: { name: chart.name, type: chart.type || ((chart.showUrl && chart.showUrl.includes('shows')) ? "series" : "movie"), url: chart.movieUrl } })
      : renderPageCached(request, url.origin, {})
  );
}

// Catch-all for browser navigation on provider/custom list paths (e.g. /lists/mdblist/..., /lists/trakt/..., /lists/tmdb/..., /lists/simkl/..., /lists/custom/...)
// Note: Creator/user public lists (/lists/:user/:slug) and .json endpoints pass through to creator routes.
async function providerListPage(request, env, ctx, url) {
  ctx.waitUntil(bumpStat(env, "pageviews"));
  return await htmlPageResponse(request, renderPageCached(request, url.origin, {}));
}

// /channels/:username/:channelSlug -- public shareable URL for a creator's published channel
async function publishedChannelPage(request, env, ctx, url, path) {
  const wantsJson = path.endsWith(".json") || (request.headers.get("Accept") || "").includes("application/json");
  const cleanPath = path.endsWith(".json") ? path.slice(0, -5) : path;
  const parts = cleanPath.split("/").filter(Boolean);
  if (parts.length >= 3) {
    const u = safeDecodeURIComponent(parts[1]).toLowerCase();
    const s = safeDecodeURIComponent(parts[2]).toLowerCase();
    // From v2 when reads are there (P3b-8), else the legacy map and index.
    let code = (await channelsV2CodeBySlug(env, u, s)) || "";
    if (!code && env && env.CONFIGS && !isV2ListsOnly(env)) {
      code = await legacyPublishedChannelCode(env, u, s);
      if (!code) {
        try {
          const indexEntries = await readPublicChannelIndex(env);
          const found = indexEntries.find((e) => e && e.owner && e.owner.toLowerCase() === u && (e.slug === s || (typeof slugifyServer === 'function' ? slugifyServer(e.name) : '') === s));
          if (found && found.code) code = found.code;
        } catch {}
      }
    }
    if (code) {
      if (wantsJson) {
        try {
          let record = await channelsV2Record(env, code, { items: true });
          if (!record && !isV2ListsOnly(env)) {
            const raw = await env.CONFIGS.get(`channelshare:${code}`);
            record = raw ? JSON.parse(raw) : null;
          }
          if (record && record.channel) {
            const ch = sanitizeSharedChannel(record.channel);
            if (ch) {
              return json({
                ok: true,
                code: code,
                channel: ch,
                description: record.description || "",
                owner: record.owner || "",
                published: !!record.published,
              }, 200, { "Cache-Control": "public, max-age=60", ...corsHeaders() });
            }
          }
        } catch {}
      }
      ctx.waitUntil(bumpStat(env, "pageviews"));
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${url.origin}/configure#channel=${encodeURIComponent(code)}`,
          "Cache-Control": "no-store",
          ...corsHeaders(),
        },
      });
    }
  }
  ctx.waitUntil(bumpStat(env, "pageviews"));
  return await htmlPageResponse(request, renderPageCached(request, url.origin, {}));
}

// /api/search-published-lists and the /lists/mdblist, /lists/trakt, /lists/tmdb and /lists/<user>/<slug> pages and feeds, at their original place. Returns a Response promise, or null.
function handlePublishedListRoutes(request, env, ctx, url, path) {
  if (path === "/api/search-published-lists") return apiSearchPublishedLists(env, ctx, url);
  let m = path.match(/^\/lists\/mdblist\/([^/]+)\/([^/]+)(?:\.json)?$/i);
  if (m) return mdblistListPage(request, env, ctx, url, m);
  m = path.match(/^\/lists\/trakt\/([^/]+)\/([^/]+)(?:\.json)?$/i);
  if (m) return traktListPage(request, env, ctx, url, m);
  m = path.match(/^\/lists\/tmdb\/collection\/([0-9]+)(?:-([a-z0-9_-]+))?(?:\.json)?$/i);
  if (m) return tmdbCollectionListPage(request, env, ctx, url, m);
  m = path.match(/^\/lists\/tmdb\/([0-9]+)(?:-([a-z0-9_-]+))?(?:\.json)?$/i);
  if (m) return tmdbListPage(request, env, ctx, url, m);
  m = path.match(/^\/lists\/([^/]+)\/([^/]+?)(?:\.json)?$/i);
  if (m) return creatorListPageOrFeed(request, env, ctx, url, path, m);
  return null;
}

// /api/search-published-lists?q=...
// -> powers the "Search Lists" panel including this Worker's own
// published Custom Lists -- both anonymously published ones (see
// /api/publish-list) and public Creator-owned ones (see
// /api/creator/lists/save) -- alongside the existing mdblist.com/Trakt
// results. Private Creator lists are filtered out entirely here, per
// the spec ("Not appear in search or browse pages"). KV's list() only
// returns keys, not values, so this fetches each candidate's stored
// data to filter/display by name -- capped at 50 keys per prefix per
// search to keep this fast even once a lot of lists have been
// published.
async function apiSearchPublishedLists(env, ctx, url) {
  if (!env || !env.CONFIGS) return jsonCacheable({ ok: true, lists: [] });
  const rawQ = url.searchParams.get("q") || "";
  const q = rawQ.toLowerCase().trim();

  // Check if query is targeting My Lists platform lists and extract any username/term
  const isMyListsSentinel = (q === "my lists" || q === "mylists" || q === "my list" || q === "mylist" || q.includes("my list") || q.includes("mylist"));
  const userTerm = q
    .replace(/\bmy\s+lists\b/gi, "")
    .replace(/\bmylists\b/gi, "")
    .replace(/\bmy\s+list\b/gi, "")
    .replace(/\bmylist\b/gi, "")
    .replace(/@+/g, "")
    .trim();

  const isMyListsSearch = isMyListsSentinel || !userTerm;

  // From the v2 tables when FF_V2_LISTS_READ is on (P3b-6,
  // 33_lists-directory.js), with the same query handling; null means use
  // the legacy search below.
  const v2Search = await v2SearchListsResponse(env, url, (userTerm || (isMyListsSentinel ? "" : q)).replace(/@+/g, "").trim(), isMyListsSearch);
  if (v2Search) return v2Search;

  try {
    if (env.DB) {
      const targetFilterIdx = (userTerm || (isMyListsSentinel ? "" : q)).replace(/@+/g, "").trim();
      const tokensIdx = targetFilterIdx.split(/\s+/).filter(Boolean);

      if (tokensIdx.length && !isMyListsSentinel) {
        const ftsQuery = tokensIdx
          .map((t) => `"${t.replace(/[^\p{L}\p{N}_]+/gu, "")}"*`)
          .filter((t) => t !== '""*')
          .join(" ");

        if (ftsQuery) {
          const ftsSql = `
                SELECT
                  f.list_id,
                  COALESCE(cl.name, pl.name) AS name,
                  COALESCE(cl.type, pl.type) AS type,
                  CASE
                    WHEN cl.id IS NOT NULL THEN (CASE WHEN json_valid(cl.items_json) THEN json_array_length(cl.items_json) ELSE 0 END)
                    WHEN pl.slug IS NOT NULL THEN (CASE WHEN json_valid(pl.items_json) THEN json_array_length(pl.items_json) ELSE 0 END)
                    ELSE 0
                  END AS items,
                  COALESCE(cl.likes, pl.likes, 0) AS likes,
                  COALESCE(f.creator_name, 'Anonymous') AS creatorName,
                  CASE WHEN cl.id IS NOT NULL THEN cl.username ELSE 'user' END AS username,
                  CASE WHEN cl.id IS NOT NULL THEN substr(cl.id, length(cl.username) + 2) ELSE pl.slug END AS slug,
                  CASE WHEN cl.id IS NOT NULL THEN 1 ELSE 0 END AS isCreator,
                  f.rank
                FROM lists_fts f
                LEFT JOIN creator_lists cl ON ('c:' || cl.id) = f.list_id AND cl.visibility = 'public'
                LEFT JOIN published_lists pl ON ('a:' || pl.slug) = f.list_id AND pl.visibility = 'public'
                WHERE lists_fts MATCH ? AND cl.id IS NOT NULL
                ORDER BY likes DESC, items DESC;
              `;
          try {
            const ftsRes = await env.DB.prepare(ftsSql).bind(ftsQuery).all();
            const ftsRows = (ftsRes && ftsRes.results) ? ftsRes.results : [];
            const matchesIdx = ftsRows
              .filter((e) => (e.items || 0) > 0)
              .map((e) => ({
                name: e.name,
                type: e.type,
                items: e.items || 0,
                likes: e.likes || 0,
                creatorName: e.isCreator ? (e.creatorName || e.username) : "Anonymous",
                username: e.isCreator ? e.username : "user",
                url: `${url.origin}/lists/${e.isCreator ? e.username : "user"}/${e.slug}`,
                source: "My Lists Addon",
              }));
            return json({ ok: true, lists: isMyListsSearch ? matchesIdx : matchesIdx.slice(0, 50) },
              200, { "Cache-Control": "public, max-age=60" });
          } catch (ftsErr) {
            console.error("lists_fts search error:", ftsErr);
          }
        }
      }
    }
    return await apiSearchPublishedListsFromIndex(env, ctx, url, q, isMyListsSentinel, userTerm, isMyListsSearch);
  } catch (err) {
    return json({ ok: false, error: safeErrorMessage(err) });
  }
}

// The rest of apiSearchPublishedLists, moved unchanged: the same statements in the same order, split only for the 150-line limit.
async function apiSearchPublishedListsFromIndex(env, ctx, url, q, isMyListsSentinel, userTerm, isMyListsSearch) {
  const searchIndex = await getPublicListIndex(env, ctx);
  if (searchIndex) {
    const targetFilterIdx = (userTerm || (isMyListsSentinel ? "" : q)).replace(/@+/g, "").trim();
    const tokensIdx = targetFilterIdx.split(/\s+/).filter(Boolean);
    const matchesIdx = searchIndex
      .filter((e) => (e.itemCount || 0) > 0)
      .filter((e) => {
        if (!targetFilterIdx || !tokensIdx.length) return true;
        const fullText = `${e.name || ""} ${e.creatorName || ""} ${e.username || ""}`.toLowerCase();
        if (fullText.includes(targetFilterIdx)) return true;
        return tokensIdx.every((tok) => fullText.includes(tok));
      })
      .map((e) => ({
        name: e.name,
        type: e.type,
        items: e.itemCount || 0,
        likes: e.likes || 0,
        creatorName: e.isCreator ? (e.creatorName || e.username) : "Anonymous",
        username: e.isCreator ? e.username : "user",
        url: `${url.origin}/lists/${e.isCreator ? e.username : "user"}/${e.slug}`,
        source: "My Lists Addon",
      }))
      .sort((a, b) => {
        const likesDiff = (b.likes || 0) - (a.likes || 0);
        if (likesDiff !== 0) return likesDiff;
        return (b.items || 0) - (a.items || 0);
      });
    // Response shape is identical to the scan path below: key is
    // `lists`, entries carry `source`, and only the non-"my lists"
    // search is capped at 50.
    // A GET, so unlike the account endpoints this one really is stored
    // by browser and shared caches. At the inherited max-age=3600 a list
    // its owner had just made private stayed findable by search for an
    // hour after the API itself had stopped returning it. Matched to
    // /lists/public.json's own 120s, which is the same data.
    return json({ ok: true, lists: isMyListsSearch ? matchesIdx : matchesIdx.slice(0, 50) },
      200, { "Cache-Control": "public, max-age=60" });
  }

  const fetchLimit = isMyListsSearch ? 250 : 80;
  // Legacy anonymous lists are no longer searchable (see /api/lists/like).
  const anonResult = { keys: [] };
  const creatorResult = await env.CONFIGS.list({ prefix: "creatorlist:", limit: fetchLimit });
  const creatorExists = makeCreatorExistsMemo(env);
  const anonCandidates = await Promise.all(
    anonResult.keys.map(async (k) => {
      const raw = await env.CONFIGS.get(k.name);
      if (!raw) return null;
      try {
        const data = JSON.parse(raw);
        await stampListVisibilityIfNeeded(env, k.name, data);
        if (!isPublicListVisibility(data.visibility)) return null;
        const listSlug = k.name.slice("publishedlist:user:".length);
        const itemCount = (data.items || []).length;
        if (itemCount === 0) return null; // Never display lists with 0 items
        return {
          name: data.name,
          type: data.type,
          items: itemCount,
          likes: data.likes || 0,
          creatorName: "Anonymous",
          username: "user",
          url: `${url.origin}/lists/user/${listSlug}`,
        };
      } catch {
        return null;
      }
    })
  );
  const creatorCandidates = await Promise.all(
    creatorResult.keys.map(async (k) => {
      const raw = await env.CONFIGS.get(k.name);
      if (!raw) return null;
      try {
        const data = JSON.parse(raw);
        await stampListVisibilityIfNeeded(env, k.name, data);
        if (!isPublicListVisibility(data.visibility)) return null;
        const itemCount = (data.items || []).length;
        if (itemCount === 0) return null; // Never display lists with 0 items
        // key shape is creatorlist:{username}:{slug}
        const rest = k.name.slice("creatorlist:".length);
        const sep = rest.indexOf(":");
        if (sep === -1) return null;
        const username = rest.slice(0, sep);
        // Same orphan filter as the directory's own fallback above.
        if (!(await creatorExists(username))) return null;
        const listSlug = rest.slice(sep + 1);
        let creatorName = username;
        try {
          const profileRaw = await getCreator(env, username);
          if (profileRaw) creatorName = JSON.parse(profileRaw).displayName || username;
        } catch {
          // fall back to the raw username slug
        }
        return {
          name: data.name,
          type: data.type,
          items: itemCount,
          likes: data.likes || 0,
          creatorName,
          username,
          url: `${url.origin}/lists/${username}/${listSlug}`,
        };
      } catch {
        return null;
      }
    })
  );
  const targetFilter = (userTerm || (isMyListsSentinel ? "" : q)).replace(/@+/g, "").trim();
  const tokens = targetFilter.split(/\s+/).filter(Boolean);
  const matches = [...anonCandidates, ...creatorCandidates]
    .filter(Boolean)
    .filter((l) => (l.items || 0) > 0)
    .filter((l) => {
      if (!targetFilter || !tokens.length) return true;
      const fullText = `${l.name || ""} ${l.creatorName || ""} ${l.username || ""} ${l.url || ""}`.toLowerCase();
      if (fullText.includes(targetFilter)) return true;
      return tokens.every((tok) => fullText.includes(tok));
    })
    .map((l) => ({ ...l, source: "My Lists Addon" }))
    .sort((a, b) => {
      const likesDiff = (b.likes || 0) - (a.likes || 0);
      if (likesDiff !== 0) return likesDiff;
      return (b.items || 0) - (a.items || 0);
    });
  return json({ ok: true, lists: isMyListsSearch ? matches : matches.slice(0, 50) },
    200, { "Cache-Control": "public, max-age=60" });
}

// /lists/:username/:listname[.json]  (GET)
// -> the public, shareable page/feed for a Custom List -- either
// published anonymously (/api/publish-list, always under the literal
// "user" namespace) or owned by a Creator Profile (/api/creator/lists/
// save, under that creator's own username). A browser gets a small
// landing page; the .json variant (or anything that isn't a browser
// navigation -- see isBrowserNavigation) gets the raw list data.
// Either way this reads straight from KV; it never round-trips through
// fetchCatalog itself (that's only for *other* configs pointing at
// Clean external list paths: /lists/mdblist/:user/:slug, /lists/trakt/:user/:slug, /lists/tmdb/:id
async function mdblistListPage(request, env, ctx, url, m) {
  const mdblistUser = m[1];
  const mdblistSlug = m[2];
  const targetUrl = `https://mdblist.com/lists/${mdblistUser}/${mdblistSlug}`;
  ctx.waitUntil(bumpStat(env, "pageviews"));
  // Validator-based caching instead of no-store -- see
  // htmlPageResponse (02_http-and-creator-utils.js). These shared list
  // pages are the ones people follow links to and press back from, and
  // each was resending ~1.6MB every time with nothing for the browser to
  // revalidate against. The ETag hashes the exact bytes returned, so a
  // 304 can only happen when the browser already holds this list.
  return await htmlPageResponse(
    request,
    renderPage(request, url.origin, {
      deepLinkList: {
        name: deslugifyServer(mdblistSlug),
        type: "movie",
        url: targetUrl,
        creatorName: mdblistUser,
        maybeMore: true,
      },
    }),
    { ...corsHeaders() }
  );
}

async function traktListPage(request, env, ctx, url, m) {
  const traktUser = m[1];
  const traktSlug = m[2];
  const targetUrl = `https://trakt.tv/users/${traktUser}/lists/${traktSlug}`;
  ctx.waitUntil(bumpStat(env, "pageviews"));
  // Validator-based caching instead of no-store -- see
  // htmlPageResponse (02_http-and-creator-utils.js). These shared list
  // pages are the ones people follow links to and press back from, and
  // each was resending ~1.6MB every time with nothing for the browser to
  // revalidate against. The ETag hashes the exact bytes returned, so a
  // 304 can only happen when the browser already holds this list.
  return await htmlPageResponse(
    request,
    renderPage(request, url.origin, {
      deepLinkList: {
        name: deslugifyServer(traktSlug),
        type: "movie",
        url: targetUrl,
        creatorName: traktUser,
        maybeMore: true,
      },
    }),
    { ...corsHeaders() }
  );
}

async function tmdbCollectionListPage(request, env, ctx, url, m) {
  const tmdbId = m[1];
  const targetUrl = `https://www.themoviedb.org/collection/${tmdbId}`;
  const name = m[2] ? deslugifyServer(m[2]) : `TMDB Collection ${tmdbId}`;
  ctx.waitUntil(bumpStat(env, "pageviews"));
  // Validator-based caching instead of no-store -- see
  // htmlPageResponse (02_http-and-creator-utils.js). These shared list
  // pages are the ones people follow links to and press back from, and
  // each was resending ~1.6MB every time with nothing for the browser to
  // revalidate against. The ETag hashes the exact bytes returned, so a
  // 304 can only happen when the browser already holds this list.
  return await htmlPageResponse(
    request,
    renderPage(request, url.origin, {
      deepLinkList: {
        name,
        type: "movie",
        url: targetUrl,
        creatorName: "TMDB",
        maybeMore: true,
      },
    }),
    { ...corsHeaders() }
  );
}

async function tmdbListPage(request, env, ctx, url, m) {
  const tmdbId = m[1];
  const targetUrl = `https://www.themoviedb.org/list/${tmdbId}`;
  const name = m[2] ? deslugifyServer(m[2]) : `TMDB List ${tmdbId}`;
  ctx.waitUntil(bumpStat(env, "pageviews"));
  // Validator-based caching instead of no-store -- see
  // htmlPageResponse (02_http-and-creator-utils.js). These shared list
  // pages are the ones people follow links to and press back from, and
  // each was resending ~1.6MB every time with nothing for the browser to
  // revalidate against. The ETag hashes the exact bytes returned, so a
  // 304 can only happen when the browser already holds this list.
  return await htmlPageResponse(
    request,
    renderPage(request, url.origin, {
      deepLinkList: {
        name,
        type: "movie",
        url: targetUrl,
        creatorName: "TMDB",
        maybeMore: true,
      },
    }),
    { ...corsHeaders() }
  );
}

async function creatorListPageOrFeed(request, env, ctx, url, path, m) {
  let rawUser = m[1];
  let rawList = m[2];
  let decodedUser = rawUser;
  let decodedList = rawList;
  try {
    decodedUser = decodeURIComponent(rawUser);
    decodedList = decodeURIComponent(rawList);
  } catch {}
  const username = decodedUser.toLowerCase();
  const listName = decodedList.toLowerCase();
  if (!env || !env.CONFIGS) {
    return json({ ok: false, error: "This Worker has no CONFIGS KV namespace bound, so nothing is published here." }, 404);
  }
  let listData = null;
  let isCreatorList = false;
  // From v2 when FF_V2_LISTS_READ is on and the owner's copy is finished
  // (P3b-7); otherwise, or when v2 has no public list here, the legacy
  // keys below.
  const v2List = await listsV2PublicListRecord(env, username, listName);
  if (v2List) {
    listData = v2List;
    isCreatorList = true;
  }
  // With FF_V2_LISTS_ONLY (P3b-9) a creator's list is v2's or nobody's;
  // the legacy anonymous lists (publishedlist:) stay where they are.
  const keysToTry = [
    ...(isV2ListsOnly(env) ? [] : [`creatorlist:${username}:${listName}`, `creatorlist:${rawUser}:${rawList}`]),
    `publishedlist:${username}:${listName}`,
    `publishedlist:${rawUser}:${rawList}`,
  ];
  for (const k of keysToTry) {
    if (listData) break;
    const raw = await env.CONFIGS.get(k);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed) {
          await stampListVisibilityIfNeeded(env, k, parsed);
          if (isPublicListVisibility(parsed.visibility)) {
            listData = parsed;
            isCreatorList = k.startsWith("creatorlist:");
          }
        }
      } catch {}
    }
  }
  // Watchlist / Watch History / Continue Watching are NOT ordinary
  // published lists -- they live in `creatorsynctracking:{username}`,
  // which is the account's PRIVATE sync blob, written only by the
  // authenticated /api/creator/sync/save-tracking. This route has no
  // authentication at all (it's the public share-a-list page), so
  // reading that blob here used to hand any anonymous caller the
  // complete viewing history of any account whose username they knew
  // -- and usernames are published by /lists/public.json for every
  // shared list, so they didn't even need guessing.
  //
  // The blob has no `visibility` field to check (it isn't a list), so
  // there is nothing here that could have failed closed on its own.
  // Sharing is now strictly opt-in per slug, recorded in
  // `creatorshare:{username}` by the owner via
  // /api/creator/sync/share-tracking. Absent key, unparseable key, or
  // a slug not explicitly set to boolean true => not shared, and this
  // block does nothing at all (the request then 404s below exactly as
  // it does for any other unknown list).
  if (listName === "watchlist" || listName === "watch-history" || listName === "continue-watching") {
    let sharedSlugs = {};
    let d1ShareLoaded = false;
    if (env.DB) {
      try {
        const { results } = await env.DB.prepare("SELECT share_json FROM creators WHERE username = ?").bind(username).all();
        if (results && results.length > 0 && results[0].share_json) {
          sharedSlugs = JSON.parse(results[0].share_json) || {};
          d1ShareLoaded = true;
        }
      } catch (e) {}
    }
    if (!d1ShareLoaded && env.CONFIGS) {
      try {
        const shareRaw = await env.CONFIGS.get(`creatorshare:${username}`);
        if (shareRaw) sharedSlugs = JSON.parse(shareRaw) || {};
      } catch {
        sharedSlugs = {};
      }
    }
    // Strict === true: a truthy string/number from a hand-edited or
    // legacy value must not be enough to expose someone's history.
    if (sharedSlugs[listName] === true) {
      const trackingRaw = await env.CONFIGS.get(`creatorsynctracking:${username}`);
      if (trackingRaw) {
        try {
          const tracking = JSON.parse(trackingRaw);
          const items = tracking[listName === "watch-history" ? "watchHistory" : (listName === "continue-watching" ? "continueWatching" : "watchlist")] || [];
          if (Array.isArray(items)) {
            if (!listData && items.length > 0) {
              listData = {
                name: listName === "watch-history" ? "Watch History" : (listName === "continue-watching" ? "Continue Watching" : "Watchlist"),
                slug: listName,
                type: "mixed",
                visibility: "public",
                items: items,
                updatedAt: tracking.updatedAt || Date.now()
              };
              isCreatorList = true;
            } else if (listData && Array.isArray(items) && items.length > 0 && (!listData.items || listData.items.length === 0)) {
              // A genuine published Custom List that happens to be
              // named "Watchlist" and is currently empty gets its
              // items filled in from tracking. Also gated -- this
              // path copies the same private data into a public
              // response, so it cannot be allowed without opt-in
              // either.
              listData.items = items;
            }
          }
        } catch {}
      }
    }
  }
  return creatorListPageOrFeedRender(request, env, ctx, { url, path, username, listName, listData, isCreatorList });
}

// The rest of creatorListPageOrFeed, moved unchanged: the same statements in the same order, split only for the 150-line limit.
async function creatorListPageOrFeedRender(request, env, ctx, { url, path, username, listName, listData, isCreatorList }) {
  if (!listData) {
    return notFoundForPeople(request, path, () => json({ ok: false, error: "No list found at that address." }, 404));
  }
  let creatorDisplayName = "Anonymous";
  if (isCreatorList) {
    creatorDisplayName = username;
    // A creator list whose creator no longer exists is not servable.
    //
    // purgeCreatorData sweeps twice, but a save that authenticated a
    // millisecond before the deletion tombstone was written keeps running
    // and its KV put lands after both passes. Measured: 6 of 10 plain
    // concurrent delete+save runs left a record behind, and because the
    // record is genuinely `public`, it stayed readable here, stayed in the
    // directory, and could never be removed -- every authenticated route
    // answers 401 for that username, so the owner had no way to take down
    // a list they had just asked to be deleted along with their account.
    //
    // A sweep can only narrow that window; nothing bounds how late a KV
    // write may land. Refusing to serve an ownerless list closes it,
    // whatever put the record there.
    //
    // Gated on isCreatorList: anonymous published lists live under
    // publishedlist:user: and have no creator record BY DESIGN. Applying
    // this to them would take every one of them offline.
    //
    // A read failure is not an absence: getCreator falls back to D1 and
    // only returns null when neither store has the account, so a transient
    // KV blip cannot 404 a live list on its own -- and this is the same
    // read the display name already needed, so it costs nothing new.
    const profileRaw = await getCreator(env, username);
    if (!profileRaw) {
      return notFoundForPeople(request, path, () => json({ ok: false, error: "No list found at that address." }, 404));
    }
    try {
      creatorDisplayName = JSON.parse(profileRaw).displayName || username;
    } catch {
      // Unparseable record -- the account exists, so serve the list under
      // the raw username slug rather than hiding it.
    }
  }
  const likes = listData.likes || 0;
  const wantsJson = path.endsWith(".json") || (request.headers.get("Accept") || "").includes("application/json") || !isBrowserNavigation(request);
  if (wantsJson) {
    const cleanItems = (listData.items || []).map((it) => {
      const itId = it.imdbId || (String(it.id || '').startsWith('tt') ? it.id : (it.id ? ('tt' + it.id) : ''));
      let poster = it.poster || it.showPoster || "";
      if (!poster && itId && itId.startsWith("tt")) {
        poster = `https://images.metahub.space/poster/medium/${itId}/img`;
      }
      const itemTitle = it.name || it.title || '';
      const itemType = it.type || (it.showId ? 'series' : (listData.type === 'mixed' ? 'movie' : (listData.type || 'movie')));
      return {
        id: itId || it.id,
        imdb_id: it.imdbId || (String(it.id || '').startsWith('tt') ? it.id : null),
        imdbId: it.imdbId || (String(it.id || '').startsWith('tt') ? it.id : null),
        tmdb_id: it.tmdbId || it.tmdb_id || null,
        tmdbId: it.tmdbId || it.tmdb_id || null,
        title: itemTitle,
        name: itemTitle,
        year: it.year || null,
        type: itemType,
        poster: poster || null,
        overview: it.overview || null,
        genres: it.genres || null,
        rating: it.rating || null
      };
    });

    // If client specifically requests format=object or format=meta
    if (url.searchParams.get("format") === "object" || url.searchParams.get("meta") === "1") {
      return json({
        ok: true,
        name: listData.name,
        slug: listName,
        creator: creatorDisplayName,
        type: listData.type,
        visibility: "public",
        itemCount: cleanItems.length,
        likes: likes,
        updatedAt: listData.updatedAt || listData.createdAt || null,
        url: `${url.origin}/lists/${username}/${listName}`,
        jsonUrl: `${url.origin}/lists/${username}/${listName}.json`,
        items: cleanItems
      }, 200, { "Cache-Control": "public, max-age=300", ...corsHeaders() });
    }

    // Standard JSON Array for Cinephage, Kometa, Jellyfin, and external list scrapers
    return json(cleanItems, 200, { "Cache-Control": "public, max-age=300", ...corsHeaders() });
  }
  ctx.waitUntil(bumpStat(env, "pageviews"));
  const shareUrl = `${url.origin}/lists/${username}/${listName}`;
  // Validator-based caching instead of no-store -- see
  // htmlPageResponse (02_http-and-creator-utils.js). These shared list
  // pages are the ones people follow links to and press back from, and
  // each was resending ~1.6MB every time with nothing for the browser to
  // revalidate against. The ETag hashes the exact bytes returned, so a
  // 304 can only happen when the browser already holds this list.
  return await htmlPageResponse(
    request,
    renderPage(request, url.origin, {
      deepLinkList: {
        name: listData.name,
        type: listData.type,
        url: shareUrl,
        creatorName: creatorDisplayName,
        likes: likes,
        sample: (listData.items || []).map((it) => {
          const itId = it.imdbId || (String(it.id || '').startsWith('tt') ? it.id : (it.id ? `tt${it.id}` : ''));
          let poster = it.poster || it.showPoster || "";
          if (!poster && itId && itId.startsWith("tt")) {
            poster = `https://images.metahub.space/poster/medium/${itId}/img`;
          }
          return {
            id: itId || (it.tmdb_id ? String(it.tmdb_id) : String(it.id || "")),
            name: it.title || it.name || "Item",
            poster: poster,
            year: it.year || it.releaseInfo || "",
            type: it.type || listData.type || "movie",
          };
        }),
        maybeMore: false,
      },
    }),
    { ...corsHeaders() }
  );
}
