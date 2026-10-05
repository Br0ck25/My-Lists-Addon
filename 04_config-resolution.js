const SHORT_ID_LENGTH = 12;

// Stored install configs live under a namespace like every other key.
//
// They used to be written at the bare id -- `CONFIGS.put(id, payload)` -- which
// made this function a read of an ARBITRARY 12-character KV key: whatever
// /:config/... is asked for is handed straight to CONFIGS.get. Nothing is
// exposed by that today, because every other namespace in this Worker is
// prefixed and longer than twelve characters, but that is an accident of
// current key names rather than a rule, and the day something shorter is added
// it becomes readable through /api/resolve with no further code change.
//
// Prefixing the STORAGE key fixes that without touching a single install URL:
// the id in the link is unchanged, only where it is filed changes. Old configs
// are still read at their bare key, because those links are in people's Stremio
// installs and will be for years.
const SAVED_CONFIG_KEY_PREFIX = "cfg:";

function savedConfigKey(id) {
  return SAVED_CONFIG_KEY_PREFIX + id;
}

// `withTracking`: also read the owner's tracking record (creatorsynctracking:)
// and fill watchHistory / continueWatching / watchlist / airingNext from it.
// Off by default (BE-H04, task P2-9): that record can be megabytes, and every
// catalog row request used to read and parse it -- for a Trending row as much
// as for Continue Watching -- while nothing on those paths used it. The
// channel meta route and /api/resolve ask for it; a personal shelf reads its
// own data in fetchAutoTrackedCatalog.
async function resolveConfig(configParam, env, { withTracking = false } = {}) {
  // A v2 install link, /i/{token}/... (P3a-8, 27_installs.js).
  if (isV2InstallParam(configParam)) return resolveV2InstallConfig(configParam, env, { withTracking });
  if (configParam.length <= SHORT_ID_LENGTH && env && env.CONFIGS) {
    const stored = (await env.CONFIGS.get(savedConfigKey(configParam)))
      || (await env.CONFIGS.get(configParam));
    if (stored) {
      try {
        let parsed = JSON.parse(stored);
        // A record whose keys and tokens have moved into install_secrets
        // (P3a-8) gets them back here, so nothing below can tell the
        // difference. One that still holds them is noted for the move.
        if (parsed && parsed._install) {
          parsed = await applyLegacyInstallRecord(env, configParam, parsed);
          if (parsed._revoked) return emptyResolvedInstallConfig();
        } else {
          noteLegacyInstallCandidate(configParam, parsed);
        }
        let watchHistory = Array.isArray(parsed.watchHistory) ? parsed.watchHistory : [];
        let continueWatching = Array.isArray(parsed.continueWatching) ? parsed.continueWatching : [];
        let watchlist = Array.isArray(parsed.watchlist) ? parsed.watchlist : [];
        let airingNext = Array.isArray(parsed.airingNext) ? parsed.airingNext : [];

        let creatorName = parsed.trackCreatorName || parsed.creatorName || "";
        if (!creatorName && Array.isArray(parsed.entries)) {
          for (const e of parsed.entries) {
            if (e && e.url && typeof e.url === 'string' && e.url.startsWith("autotrack:")) {
              const parts = e.url.split(":");
              if (parts.length >= 4 && parts[3]) {
                creatorName = parts[3];
                break;
              }
            }
          }
        }
        // Who, if anyone, this config PROVES it speaks for.
        //
        // `creatorName` above is a name lifted out of the stored payload -- and
        // /api/save used to accept `trackCreatorName` (and an
        // `autotrack:...:<username>` entry url) from anyone, unauthenticated, so
        // it was a claim rather than a credential. Everything downstream treated
        // it as one: the tracking read immediately below, and
        // fetchAutoTrackedCatalog via keys.trackOwner. That is SEC-001 -- see
        // mayReadTrackedShelf (02_http-and-creator-utils.js).
        //
        // Three ways a config can prove it now, in descending order of strength:
        //   * it carries the account's own Creator Key (track-on links always
        //     have, and /api/save now stores one whenever a personal shelf is
        //     present) -- verified here, memoized, so it costs one PBKDF2 per
        //     isolate per config rather than one per request;
        //   * /api/save stamped `trackOwner` on it after verifying at save time,
        //     so a later key rotation does not silently empty the shelf;
        //   * it predates both, and LEGACY_UNVERIFIED_CONFIG_SHELVES says to
        //     honour those -- see that constant for exactly what it costs.
        let trackOwner = "";
        // Proven by the config's own Creator Key, the strongest of the three.
        // P3a-10 lends provider connections only to this or an ownerId stamp.
        let keyVerifiedOwner = "";
        if (creatorName) {
          if (parsed.trackCreatorKey) {
            trackOwner = await verifyShelfOwner(env, creatorName, parsed.trackCreatorKey);
            keyVerifiedOwner = trackOwner;
          }
          if (!trackOwner && typeof parsed.trackOwner === "string" && parsed.trackOwner) {
            const stamped = String(parsed.trackOwner).toLowerCase();
            if (stamped === String(creatorName).toLowerCase()) trackOwner = stamped;
          }
          if (!trackOwner && LEGACY_UNVERIFIED_CONFIG_SHELVES && !parsed.trackCreatorKey && !parsed.trackOwner && !parsed._legacyShelfRuleOff) {
            trackOwner = String(creatorName).toLowerCase();
          }
        }
        // The keys and tokens this config does not carry itself, from its
        // proven owner's own connections (P3a-10, 28_connections.js). Its own
        // always win, so a link that has them serves exactly as before.
        // Guarded: a failure here must leave the link serving as it would
        // without connections, not fall through to the base64 decode below.
        try {
          const connectionOwnerId = await connectionOwnerForConfig(env, parsed, keyVerifiedOwner);
          if (connectionOwnerId != null) {
            parsed = { ...parsed, ...(await connectionFieldsForConfig(env, connectionOwnerId, readInstallConfigFields(parsed))) };
          }
        } catch (e) {
          console.error("Could not read the install owner's connections:", e);
        }
        if (withTracking && trackOwner && env.CONFIGS) {
          const trackingRaw = await env.CONFIGS.get(`creatorsynctracking:${trackOwner}`);
          if (trackingRaw) {
            try {
              const tracking = JSON.parse(trackingRaw);
              if (Array.isArray(tracking.watchHistory) && tracking.watchHistory.length && !watchHistory.length) {
                watchHistory = tracking.watchHistory;
              }
              if (Array.isArray(tracking.continueWatching) && tracking.continueWatching.length && !continueWatching.length) {
                continueWatching = tracking.continueWatching;
              }
              if (Array.isArray(tracking.watchlist) && tracking.watchlist.length && !watchlist.length) {
                watchlist = tracking.watchlist;
              }
              if (Array.isArray(tracking.airingNext) && tracking.airingNext.length && !airingNext.length) {
                airingNext = tracking.airingNext;
              }
            } catch {}
          }
        }

        return {
          entries: Array.isArray(parsed.entries) ? parsed.entries : [],
          watchHistory,
          continueWatching,
          watchlist,
          airingNext,
          // Every install setting, with its default, from the one schema
          // (INSTALL_CONFIG_FIELDS, 00_constants.js).
          ...readInstallConfigFields(parsed),
          track: !!parsed.track,
          trackCreatorName: parsed.trackCreatorName || "",
          trackCreatorKey: parsed.trackCreatorKey || "",
          // Providers whose connection needs signing in again (P5-7).
          reconnect: Array.isArray(parsed._reconnect) ? parsed._reconnect : [],
          // The verified username, or "". Every personal-shelf read downstream
          // is gated on this rather than on trackCreatorName -- see the block
          // above and mayReadTrackedShelf (02_http-and-creator-utils.js).
          trackOwner,
        };
      } catch {
        // fall through to legacy decode below
      }
    }
  }
  return decodeConfig(configParam);
}

// Accepts a full mdblist URL (https://mdblist.com/lists/user/listname[/...])
// or a bare "user/listname" and returns the public JSON feed URL. Pass an
// apikey to also reach a private/personal list you own (mdblist honors the
// key on this endpoint the same way its own site does when you're signed
// in) — public lists work fine with no key.
function mdblistJsonUrl(input, apikey, type) {
  let s = (input || "").trim();
  // Query string / fragment stripped before anything else. Without this,
  // a URL copied while some filter/view toggle on mdblist's own site is
  // active (e.g. "?sort=rank", or a trailing "/?Mode=Show"-shaped param)
  // becomes part of the list slug below -- either glued onto the last
  // segment, or its own segment entirely if there's a trailing slash
  // before the "?". Either way the constructed JSON-feed URL points at a
  // list that doesn't exist, and mdblist 404s (or returns something
  // unrelated) instead of the real list.
  s = s.split(/[?#]/)[0];

  s = s.replace(/^https?:\/\/(www\.)?mdblist\.com\/lists\//i, "");
  s = s.replace(/\/(json\/?)?$/i, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  // Normal user lists are /lists/{username}/{slug} (2 segments), but
  // mdblist's own "Official Lists" (mdblist.com/lists/official) are one
  // level deeper -- /lists/official/{movies|shows}/{slug} (3 segments).
  // mdblist's JSON-feed convention is simply "whatever the display page's
  // own path is, plus /json/", so preserving however many segments there
  // are (rather than assuming exactly 2) handles both shapes correctly.
  const encodedPath = parts.map((p) => encodeURIComponent(p)).join("/");
  const base = `https://mdblist.com/lists/${encodedPath}/json/`;
  // append_to_response=poster is documented for mdblist's api.mdblist.com
  // REST endpoint; this add-on actually uses their simpler public JSON feed
  // (this URL), which isn't confirmed to support the same param. Requesting
  // it anyway is a safe bet either way: if unsupported, mdblist just ignores
  // the unknown query param and responds exactly as before (mapMdblistItems
  // below falls back to the metahub poster whenever `poster` isn't present).
  const params = new URLSearchParams({ append_to_response: "poster" });
  if (apikey) params.set("apikey", apikey);
  return `${base}?${params.toString()}`;
}

// --- list-site detection -----------------------------------------------

// Looks at a pasted URL (or the special "mdblist:watchlist" sentinel) and
// figures out which backend should handle it.
// Matches the shareable "/lists/{username}/{listname}" path a published
// Custom List gets, regardless of domain -- this is deliberately domain-
// agnostic (checked structurally, not against a hardcoded hostname) so it
// keeps working whether someone's on the raw *.workers.dev subdomain or a
// custom domain, and so one deployment can resolve a link shared from
// another. Reading this always goes straight to this Worker's OWN KV (see
// fetchPublishedListCatalog) rather than an HTTP fetch of the URL itself.
//
// Critical exception: mdblist.com's own list URLs use this *exact* same
// shape (mdblist.com/lists/{user}/{list}) -- without excluding it here,
// every ordinary mdblist list URL already in use throughout this add-on
// would get misdetected as one of our own published lists and resolved
// against our (empty, for that key) KV instead of mdblist's real data.
function parsePublishedListUrl(rawUrl) {
  const s = String(rawUrl || "").trim();
  if (/^https?:\/\/(www\.)?mdblist\.com\//i.test(s)) return null;
  const m = s.match(/\/lists\/([^/?#]+)\/([^/?#]+)(?:\.json)?\/?(?:[?#].*)?$/i);
  if (!m) return null;
  let username = m[1];
  let listName = m[2];
  try {
    username = decodeURIComponent(username);
    listName = decodeURIComponent(listName);
  } catch {}
  return {
    username: username.toLowerCase(),
    listName: listName.toLowerCase(),
    rawUsername: m[1],
    rawListName: m[2],
  };
}

function parseTmdbWebChartUrl(rawUrl) {
  const s = String(rawUrl || "").trim();
  const m = s.match(/^https?:\/\/(?:www\.)?themoviedb\.org\/(movie|tv|trending)(?:\/([a-z0-9_-]+))?/i);
  if (!m) return null;
  const section = m[1].toLowerCase();
  const sub = (m[2] || "").toLowerCase();
  
  if (section === "movie") {
    if (!sub || sub === "popular") return { chartKey: "popular", type: "movie", name: "TMDB Popular Movies" };
    if (sub === "top-rated" || sub === "top_rated") return { chartKey: "top_rated", type: "movie", name: "TMDB Top Rated Movies" };
    if (sub === "now-playing" || sub === "now_playing") return { chartKey: "now_playing", type: "movie", name: "TMDB Now Playing" };
    if (sub === "upcoming") return { chartKey: "upcoming", type: "movie", name: "TMDB Upcoming Movies" };
  } else if (section === "tv") {
    if (!sub || sub === "popular") return { chartKey: "popular", type: "series", name: "TMDB Popular Shows" };
    if (sub === "top-rated" || sub === "top_rated") return { chartKey: "top_rated", type: "series", name: "TMDB Top Rated Shows" };
    if (sub === "airing-today" || sub === "airing_today") return { chartKey: "now_playing", type: "series", name: "TMDB Airing Today" };
    if (sub === "on-the-air" || sub === "on_the_air") return { chartKey: "upcoming", type: "series", name: "TMDB On The Air" };
  } else if (section === "trending") {
    if (sub === "movie" || sub === "movies") return { chartKey: "trending", type: "movie", name: "TMDB Trending Movies" };
    if (sub === "tv" || sub === "shows") return { chartKey: "trending", type: "series", name: "TMDB Trending Shows" };
    return { chartKey: "trending", type: "movie", name: "TMDB Trending" };
  }
  return null;
}

// --- The provider registry (P4-1) -------------------------------------------
//
// Every catalog source this add-on serves, in the order they are tried, and
// the provider adapter that owns each. It replaces two chains that had to be
// kept in step by hand: detectSource's if/else (what a row's URL is) and the
// matching if/else in fetchCatalog (which fetcher serves it). One row of
// CATALOG_SOURCES now says both, so a new source is added in one place.
//
// A source:
//   name       What detectSource returns. Other code keys off these names
//              (STREMIO_LIVE_ROW_SOURCES, the catalog route), so never rename
//              one.
//   provider   The adapter that owns it (PROVIDER_ADAPTERS below).
//   kind       "chart"    a ranking, the same for everyone;
//              "list"     a public list, the same for everyone;
//              "personal" one account's shelf (watchlist, history, Up Next,
//                         Airing Next, Recommended). These are exactly the rows
//                         STREMIO_LIVE_ROW_SOURCES (00_constants.js) serves
//                         no-store, and a test keeps the two in agreement;
//              "own"      a row whose payload is in the row itself (a channel,
//                         a custom list).
//              The adapter contract in NEXT_VERSION_ARCHITECTURE §6.2 calls
//              "chart" and "list" shared, and "personal" user-authenticated.
//   match(s)   True when the trimmed URL or sentinel is this source. ORDER
//              MATTERS: the first match wins, exactly as the if/else did.
//              mdblist:watchlist is tried before the MDBList catch-all, the
//              published-list shape before trakt.tv and themoviedb.org, and
//              the MDBList public list takes anything nothing else claimed,
//              as it always has (old configs rely on it).
//   arg(s)     Optional: the part of the string the fetcher needs (a chart or
//              genre key), so fetchCatalog no longer slices it out itself.
//   apiUse     The provider whose key the request may spend, counted against
//              the shared key in the admin API Usage tab (trackSharedApiUse,
//              05_catalog-core.js). null when the row makes no provider call.
//   fetchPage(ref, { entry, skip, keys })
//              The fetcher, called with exactly the arguments fetchCatalog
//              used to pass it.
//   snapshot   Charts only, optional: the page may be served from a chart
//              snapshot (P4-3, 42_chart-snapshots.js). { region: true } when
//              the install's region changes the rows; variant(ref, page) for
//              anything else that does (a setting, the day). The chart key,
//              the row's type and the page are always part of the snapshot.
//
// The fetchers live in 05_, 06_ and 07_. They are only named inside the
// closures, so this file still loads on its own (the tests load it that way to
// check detection).

// "trakt:watchlist", or the same sentinel with a suffix ("trakt:watchlist:x").
function isSourceSentinel(s, name) {
  return s === name || s.startsWith(name + ":");
}

function sourceArgAfter(prefix) {
  return (s) => s.slice(prefix.length);
}

// The MDBList credential a row uses: the connected account's token, then the
// install's own key, then the site's.
function catalogMdblistKey(keys) {
  return keys.mdblistAccessToken || keys.mdblistKey || MDBLIST_API_KEY;
}

function catalogTraktKey(keys) {
  return keys.traktKey || TRAKT_CLIENT_ID;
}

const CATALOG_SOURCES = [
  {
    name: "mdblist-watchlist", provider: "mdblist", kind: "personal", apiUse: "mdblist",
    match: (s) => isSourceSentinel(s, "mdblist:watchlist") || /^https?:\/\/(www\.)?mdblist\.com\/(?:lists\/[^/]+\/)?watchlist\/?/i.test(s),
    fetchPage: (ref, { entry, skip, keys }) => fetchMdblistWatchlist(entry, skip, catalogMdblistKey(keys), keys.mdblistAccessToken || ""),
  },
  {
    name: "mdblist-history", provider: "mdblist", kind: "personal", apiUse: "mdblist",
    match: (s) => isSourceSentinel(s, "mdblist:history") || /^https?:\/\/(www\.)?mdblist\.com\/(?:lists\/[^/]+\/)?history\/?/i.test(s),
    fetchPage: (ref, { entry, skip, keys }) => fetchMdblistHistory(entry, skip, catalogMdblistKey(keys), keys.mdblistAccessToken || ""),
  },
  {
    name: "mdblist-airing-next", provider: "mdblist", kind: "personal", apiUse: "mdblist",
    match: (s) => isSourceSentinel(s, "mdblist:airing-next") || s === "mdblist:user:shows:airing-next",
    fetchPage: (ref, { entry, skip, keys }) => fetchMdblistAiringNext(entry, skip, catalogMdblistKey(keys), keys.mdblistAccessToken || "", keys.tmdbKey || TMDB_API_KEY, keys.env, keys.ctx),
  },
  {
    name: "mdblist-upnext", provider: "mdblist", kind: "personal", apiUse: "mdblist",
    match: (s) => isSourceSentinel(s, "mdblist:upnext") || s === "mdblist:user:shows:upnext",
    fetchPage: (ref, { entry, skip, keys }) => fetchMdblistUpNext(entry, skip, catalogMdblistKey(keys), keys.mdblistAccessToken || "", keys.tmdbKey || TMDB_API_KEY, keys.env, keys.ctx),
  },
  // (www.|app.) and a trailing "?query" or "#hash" are tolerated in the
  // trakt.tv URLs below. A fully $-anchored .../watchlist$ failed to recognize
  // a URL copied while a filter was active on trakt.tv (a trailing
  // "?something=x"), or one copied from app.trakt.tv. It then fell through to
  // the generic "trakt" source, which expects a /lists/ path, and the row
  // never resolved.
  {
    name: "trakt-watchlist", provider: "trakt", kind: "personal", apiUse: "trakt",
    match: (s) => isSourceSentinel(s, "trakt:watchlist") || /^https?:\/\/(www\.|app\.)?trakt\.tv\/users\/[^/]+\/watchlist\/?(?:[?#].*)?$/i.test(s),
    fetchPage: (ref, { entry, skip, keys }) => fetchTraktWatchlist(entry, skip, catalogTraktKey(keys), keys.traktAccessToken || "", keys.env, keys.ctx),
  },
  {
    name: "trakt-history", provider: "trakt", kind: "personal", apiUse: "trakt",
    match: (s) => isSourceSentinel(s, "trakt:history") || /^https?:\/\/(www\.|app\.)?trakt\.tv\/users\/[^/]+\/history\/?(?:[?#].*)?$/i.test(s),
    fetchPage: (ref, { entry, skip, keys }) => fetchTraktHistory(entry, skip, catalogTraktKey(keys), keys.traktAccessToken || "", keys.env, keys.ctx),
  },
  {
    name: "trakt-airing-next", provider: "trakt", kind: "personal", apiUse: "trakt",
    match: (s) => isSourceSentinel(s, "trakt:airing-next") || s === "trakt:user:shows:airing-next",
    fetchPage: (ref, { entry, skip, keys }) => fetchTraktAiringNext(entry, skip, catalogTraktKey(keys), keys.traktAccessToken || "", keys.tmdbKey || TMDB_API_KEY, keys.env, keys.ctx),
  },
  {
    name: "trakt-continue-watching", provider: "trakt", kind: "personal", apiUse: "trakt",
    match: (s) => isSourceSentinel(s, "trakt:continue-watching") || s === "trakt:user:continue-watching" || /^https?:\/\/(www\.|app\.)?trakt\.tv\/users\/[^/]+\/continue-watching\/?(?:[?#].*)?$/i.test(s),
    fetchPage: (ref, { entry, skip, keys }) => fetchTraktContinueWatching(entry, skip, catalogTraktKey(keys), keys.traktAccessToken || "", keys.env, keys.ctx),
  },
  {
    name: "tmdb-chart", provider: "tmdb", kind: "chart", apiUse: "tmdb",
    snapshot: { region: true, variant: (ref, { keys }) => (keys.hideNonDigitalReleases ? "digital" : "") },
    match: (s) => s.startsWith("tmdb:chart:") || !!parseTmdbWebChartUrl(s),
    arg: (s) => {
      const webChart = parseTmdbWebChartUrl(s);
      return webChart ? webChart.chartKey : s.slice("tmdb:chart:".length);
    },
    fetchPage: (ref, { entry, skip, keys }) => fetchTmdbChart(entry, skip, TMDB_API_KEY, ref.arg, keys.region, keys.hideNonDigitalReleases, keys.env, keys.ctx),
  },
  {
    name: "tmdb-top10", provider: "tmdb", kind: "chart", apiUse: "tmdb",
    snapshot: { region: true },
    match: (s) => s.startsWith("tmdb:top10:"),
    arg: sourceArgAfter("tmdb:top10:"),
    fetchPage: (ref, { entry, skip, keys }) => fetchTmdbProviderTop10(entry, skip, TMDB_API_KEY, ref.arg, keys.region),
  },
  {
    name: "tmdb-hidden-gems", provider: "tmdb", kind: "chart", apiUse: "tmdb",
    // A different slice each UTC day (fetchTmdbHiddenGems), so the day is part of the snapshot.
    snapshot: { variant: () => "day" + Math.floor(Date.now() / 86400000) },
    match: (s) => s === "tmdb:hidden-gems",
    fetchPage: (ref, { entry, skip }) => fetchTmdbHiddenGems(entry, skip, TMDB_API_KEY),
  },
  {
    name: "tmdb-kids", provider: "tmdb", kind: "chart", apiUse: "tmdb",
    snapshot: {},
    match: (s) => s.startsWith("tmdb:kids:"),
    arg: sourceArgAfter("tmdb:kids:"),
    fetchPage: (ref, { entry, skip }) => fetchTmdbKids(entry, skip, TMDB_API_KEY, ref.arg),
  },
  {
    name: "tmdb-holiday", provider: "tmdb", kind: "chart", apiUse: "tmdb",
    snapshot: {},
    match: (s) => s.startsWith("tmdb:holiday:"),
    arg: sourceArgAfter("tmdb:holiday:"),
    fetchPage: (ref, { entry, skip }) => fetchTmdbHoliday(entry, skip, TMDB_API_KEY, ref.arg),
  },
  {
    name: "tmdb-genre", provider: "tmdb", kind: "chart", apiUse: "tmdb",
    snapshot: { region: true },
    match: (s) => s.startsWith("tmdb:genre:"),
    arg: sourceArgAfter("tmdb:genre:"),
    fetchPage: (ref, { entry, skip, keys }) => fetchTmdbGenre(entry, skip, TMDB_API_KEY, ref.arg, keys.region),
  },
  // New on Streaming: bare, or with a "+"-separated service selection after a
  // colon ("tmdb:new-on-streaming:netflix+hulu"). It reads D1 and makes no
  // provider call: the JustWatch (or RapidAPI) and TMDB calls happen in the
  // cron sweep (sweepNewOnStreaming), counted against the sweep's own budget
  // rather than against whoever opened the shelf. So it belongs to this site,
  // and spends no key here.
  {
    name: "tmdb-new-on-streaming", provider: "mylists", kind: "chart", apiUse: null,
    match: (s) => isSourceSentinel(s, "tmdb:new-on-streaming") || isSourceSentinel(s, "rapidapi:new-on-streaming") || isSourceSentinel(s, "streaming:new-on-streaming"),
    fetchPage: (ref, { entry, skip, keys }) => fetchNewOnStreaming(entry, skip, keys),
  },
  // This add-on's own Most Watched chart ("mylists:most-watched:today|7|30"),
  // read from a KV snapshot rebuilt at most hourly or daily
  // (fetchMostWatchedCatalog).
  {
    name: "mylists-most-watched", provider: "mylists", kind: "chart", apiUse: null,
    match: (s) => s.startsWith("mylists:most-watched:"),
    fetchPage: (ref, { entry, skip, keys }) => fetchMostWatchedCatalog(entry, skip, keys),
  },
  // The Better Posters lists ("mylists:better-posters:today|trending|popular|top"),
  // read from btttr.cc's public catalogs (fetchBetterPostersCatalog). No
  // provider key is spent.
  {
    name: "mylists-better-posters", provider: "mylists", kind: "chart", apiUse: null,
    match: (s) => s.startsWith("mylists:better-posters:"),
    fetchPage: (ref, { entry, skip, keys }) => fetchBetterPostersCatalog(entry, skip, keys),
  },
  {
    name: "trakt-chart", provider: "trakt", kind: "chart", apiUse: "trakt",
    snapshot: {},
    match: (s) => s.startsWith("trakt:chart:"),
    arg: sourceArgAfter("trakt:chart:"),
    fetchPage: (ref, { entry, skip, keys }) => fetchTraktChart(entry, skip, catalogTraktKey(keys), ref.arg, keys.env, keys.ctx),
  },
  {
    name: "simkl-chart", provider: "simkl", kind: "chart", apiUse: "simkl",
    snapshot: {},
    match: (s) => s.startsWith("simkl:chart:"),
    arg: sourceArgAfter("simkl:chart:"),
    fetchPage: (ref, { entry, skip, keys }) => fetchSimklChart(entry, skip, SIMKL_CLIENT_ID, ref.arg, keys.env, keys.ctx),
  },
  {
    name: "simkl-user", provider: "simkl", kind: "personal", apiUse: "simkl",
    match: (s) => s.startsWith("simkl:user:"),
    arg: sourceArgAfter("simkl:user:"),
    fetchPage: (ref, { entry, skip, keys }) => fetchSimklUserList(entry, skip, keys.simklAccessToken, SIMKL_CLIENT_ID, ref.arg, keys.tmdbKey, keys.env, keys.ctx),
  },
  {
    name: "channel", provider: "mylists", kind: "own", apiUse: null,
    match: (s) => s.startsWith("channel:v1:"),
    fetchPage: (ref, { entry, keys }) => fetchChannelCatalog(entry, keys.origin),
  },
  {
    name: "custom-list", provider: "mylists", kind: "own", apiUse: null,
    match: (s) => s.startsWith("customlist:v1:"),
    fetchPage: (ref, { entry, skip, keys }) => fetchCustomListCatalog(entry, skip, keys),
  },
  {
    name: "autotrack", provider: "mylists", kind: "personal", apiUse: null,
    match: (s) => s.startsWith("autotrack:") || s === "custom:watch-history" || s === "custom:continue-watching" || s === "custom:watchlist" || s.startsWith("custom:watch-history:") || s.startsWith("custom:continue-watching:"),
    fetchPage: (ref, { entry, keys }) => fetchAutoTrackedCatalog(entry, keys.env, keys),
  },
  // Recommended Movies / Shows: the account's own Discover snapshot, or, when
  // that is too old, recommendations built from TMDB (so it counts as TMDB).
  {
    name: "curated", provider: "mylists", kind: "personal", apiUse: "tmdb",
    match: (s) => s.startsWith("custom:curated:") || s.startsWith("curated:"),
    fetchPage: (ref, { entry, skip, keys }) => fetchCuratedCatalog(entry, skip, keys),
  },
  {
    name: "tmdb-collection", provider: "tmdb", kind: "list", apiUse: "tmdb",
    match: (s) => s.startsWith("tmdb:collection:") || /^https?:\/\/(?:www\.)?themoviedb\.org\/collection\//i.test(s),
    fetchPage: (ref, { entry, skip, keys }) => fetchTmdbCollection(entry, skip, TMDB_API_KEY, keys.env, keys.ctx),
  },
  // A list published on this site, read from its own storage, never fetched.
  {
    name: "published-list", provider: "mylists", kind: "list", apiUse: null,
    match: (s) => !!parsePublishedListUrl(s),
    fetchPage: (ref, { entry, keys }) => fetchPublishedListCatalog(entry, keys.env),
  },
  {
    name: "trakt", provider: "trakt", kind: "list", apiUse: "trakt",
    match: (s) => /^https?:\/\/(www\.|app\.)?trakt\.tv\//i.test(s),
    fetchPage: (ref, { entry, skip, keys }) => fetchTrakt(entry, skip, catalogTraktKey(keys), keys.traktAccessToken || "", keys.env, keys.ctx),
  },
  {
    name: "tmdb", provider: "tmdb", kind: "list", apiUse: "tmdb",
    match: (s) => /^https?:\/\/(www\.)?themoviedb\.org\/list\//i.test(s),
    fetchPage: (ref, { entry, skip }) => fetchTmdb(entry, skip, TMDB_API_KEY),
  },
  // The default, and backwards-compatible with existing configs: anything not
  // claimed above is an MDBList public list (a URL, or a bare "user/list").
  {
    name: "mdblist", provider: "mdblist", kind: "list", apiUse: "mdblist",
    match: () => true,
    fetchPage: (ref, { entry, skip, keys }) => fetchMdblist(entry, skip, catalogMdblistKey(keys), keys.env, keys.ctx),
  },
];

const CATALOG_SOURCE_BY_NAME = new Map(CATALOG_SOURCES.map((src) => [src.name, src]));

function catalogSourceByName(name) {
  return CATALOG_SOURCE_BY_NAME.get(name) || null;
}

// What a row's URL (or sentinel) is, as the adapters see it:
//   { source, provider, kind, url, arg }
// Always returns a ref: the last source takes anything.
function resolveSourceRef(input) {
  const s = String(input || "").trim();
  for (const src of CATALOG_SOURCES) {
    if (src.match(s)) {
      return { source: src.name, provider: src.provider, kind: src.kind, url: s, arg: src.arg ? src.arg(s) : "" };
    }
  }
  return null;
}

function detectSource(input) {
  return resolveSourceRef(input).source;
}

// A Letterboxd list or watchlist URL: { provider, kind: "import", user, slug }.
// Letterboxd has no API, so its rows are never served live: a Letterboxd list
// is imported (read in the browser, matched through /api/bulk-resolve) and
// becomes one of the person's own lists. detectSource does not claim these
// URLs, so a pasted one still goes to the MDBList default, as before.
function parseLetterboxdListUrl(input) {
  const s = String(input || "").trim();
  const m = s.match(/^https?:\/\/(?:www\.)?letterboxd\.com\/([A-Za-z0-9_]{1,40})\/(?:list\/([A-Za-z0-9_-]{1,120})|(watchlist))\/?(?:[?#].*)?$/i);
  if (!m) return null;
  return { provider: "letterboxd", kind: "import", url: s, user: m[1].toLowerCase(), slug: (m[2] || m[3]).toLowerCase() };
}

// The provider adapters. Each one names the hosts it talks to, the catalog
// sources it owns (filled from CATALOG_SOURCES below) and parseRef, which
// reads a URL or sentinel into a ref when it is one of that provider's.
//
// usesSharedKey(keys): whether a request with these install keys spends the
// site's own key rather than the person's. Only the providers some source
// names as its apiUse have one.
//
// Some providers serve no catalog row. JustWatch and RapidAPI feed the New on
// Streaming sweep, TVmaze gives air times, Cinemeta is the metadata fallback,
// and Letterboxd is import only. They are here so every provider this Worker
// calls has one entry to hang its breaker, metrics and fixtures on (P4-4,
// P4-5).
function makeProviderAdapter(id, label, hosts, extra) {
  return {
    id,
    label,
    hosts,
    sources: [],
    parseRef(input) {
      const ref = resolveSourceRef(input);
      return ref && ref.provider === id ? ref : null;
    },
    ...(extra || {}),
  };
}

const PROVIDER_ADAPTERS = {
  tmdb: makeProviderAdapter("tmdb", "TMDB", ["api.themoviedb.org", "themoviedb.org", "www.themoviedb.org"], {
    usesSharedKey: () => true,
  }),
  trakt: makeProviderAdapter("trakt", "Trakt", ["api.trakt.tv", "trakt.tv", "www.trakt.tv", "app.trakt.tv"], {
    usesSharedKey: (keys) => !keys.traktKey,
  }),
  mdblist: makeProviderAdapter("mdblist", "MDBList", ["api.mdblist.com", "mdblist.com", "www.mdblist.com"], {
    usesSharedKey: (keys) => !(keys.mdblistKey || keys.mdblistAccessToken),
  }),
  simkl: makeProviderAdapter("simkl", "Simkl", ["api.simkl.com", "data.simkl.in", "simkl.com", "www.simkl.com"], {
    usesSharedKey: () => true,
  }),
  justwatch: makeProviderAdapter("justwatch", "JustWatch", ["apis.justwatch.com"], { parseRef: () => null }),
  rapidapi: makeProviderAdapter("rapidapi", "RapidAPI Streaming Availability", ["streaming-availability.p.rapidapi.com"], { parseRef: () => null }),
  tvmaze: makeProviderAdapter("tvmaze", "TVmaze", ["api.tvmaze.com"], { parseRef: () => null }),
  cinemeta: makeProviderAdapter("cinemeta", "Cinemeta", ["v3-cinemeta.strem.io", "images.metahub.space"], { parseRef: () => null }),
  letterboxd: makeProviderAdapter("letterboxd", "Letterboxd", ["letterboxd.com", "www.letterboxd.com"], { parseRef: parseLetterboxdListUrl }),
  // This site's own rows: channels, custom and published lists, the tracked
  // shelves, Recommended, Most Watched and New on Streaming. Served from its
  // own storage; no host.
  mylists: makeProviderAdapter("mylists", "My Lists", []),
};

for (const src of CATALOG_SOURCES) PROVIDER_ADAPTERS[src.provider].sources.push(src.name);

function providerAdapter(id) {
  return Object.prototype.hasOwnProperty.call(PROVIDER_ADAPTERS, id) ? PROVIDER_ADAPTERS[id] : null;
}

// --- What a signed-out install may carry (docs/DECISIONS.md D-8) ------------
//
// Signed out, someone can add the site's public lists and generate an install
// link, and nothing else: charts, curated and storyline shelves, community
// lists and public provider list links need no account. Anything personal or
// user-made does -- custom lists, channels, and the watchlist / history / Up
// Next / Airing Next shelves, whether they come from this site's own tracking
// or from a connected Trakt, MDBList, Simkl or TMDB account.
//
// Two kinds of channel are public too: a storyline, and a channel listed in
// Explore Channels, each added as it is (isPublicChannelRow, below).
//
// Returns what the row is, phrased to follow "Sign in to add ...", or "" when
// anyone may add it. /api/save enforces this; the builder page mirrors it in
// rowNeedsAccount (16_client-row-core.js) so a signed-out visitor is asked to
// sign in before doing the work rather than at the end. A test keeps the two
// in agreement, so change both together.
const ACCOUNT_LABEL_CUSTOM_LISTS = "custom lists";
const ACCOUNT_LABEL_CHANNELS = "channels";
const ACCOUNT_LABEL_PERSONAL = "your watchlist, history and Airing Next shelves";

function entryAccountRequirement(rawUrl) {
  const s = String(rawUrl || "").trim();
  if (!s) return "";
  // Whole-blob forms first: their JSON may contain newlines that are not
  // source separators (see previewSourceUrls).
  if (s.startsWith("customlist:v1:")) return ACCOUNT_LABEL_CUSTOM_LISTS;
  if (s.startsWith("channel:v1:")) return isPublicChannelRow(s) ? "" : ACCOUNT_LABEL_CHANNELS;
  for (const line of s.split("\n")) {
    const l = line.trim().toLowerCase();
    if (!l) continue;
    if (l.startsWith("customlist:v1:")) return ACCOUNT_LABEL_CUSTOM_LISTS;
    if (l.startsWith("channel:v1:")) return ACCOUNT_LABEL_CHANNELS;
    if (isPersonalShelfSource(l)) return ACCOUNT_LABEL_PERSONAL;
  }
  return "";
}

// A storyline ("+ Add" on Storylines, Sagas & Universes) carries its
// storylineId; an Explore Channels listing carries the shareCode it was
// published under. /api/save checks the second against the published record
// and stores that record's own lineup for a signed-out save. A storyline's
// episodes cannot be checked the same way -- the storyline catalogue lives in
// the page (TV_CROSSOVER_EVENTS, 20_), not in the Worker -- so it is
// recognized by its id alone. Several channels merged into one row are a
// channel someone built, and never match.
const STORYLINE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,80}$/;
const SHARE_CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function publicChannelRowPayload(s) {
  let p = null;
  try {
    p = JSON.parse(String(s || "").trim().slice("channel:v1:".length));
  } catch {
    return null;
  }
  return (p && typeof p === "object" && !Array.isArray(p)) ? p : null;
}

function isPublicChannelRow(s) {
  const p = publicChannelRowPayload(s);
  if (!p) return false;
  if (typeof p.storylineId === "string" && STORYLINE_ID_PATTERN.test(p.storylineId)) return true;
  if (typeof p.shareCode === "string" && SHARE_CODE_PATTERN.test(p.shareCode)) return true;
  return false;
}

// One source line, lowercased. The sentinel names match detectSource above;
// the two URL shapes are the pasted forms of a provider watchlist or history.
function isPersonalShelfSource(l) {
  // PERSONAL_SHELF_URL_PREFIXES (00_constants.js) is the one list of provider
  // and tracked shelves; "Remove duplicates across lists" reads it too.
  if (PERSONAL_SHELF_URL_PREFIXES.some((p) => l.startsWith(p))) return true;
  if (l.startsWith("custom:watch-history") || l.startsWith("custom:continue-watching") || l === "custom:watchlist") return true;
  if (l === "trakt:collection") return true;
  if (l.startsWith("tmdb:account:") || l === "tmdb:watchlist" || l === "tmdb:favorites") return true;
  let u;
  try {
    u = new URL(l);
  } catch {
    return false;
  }
  const host = u.hostname.replace(/^(www|app)\./, "");
  const segs = u.pathname.split("/").filter(Boolean);
  if (host === "mdblist.com") {
    const tail = segs[0] === "lists" ? segs[2] : segs[0];
    return tail === "watchlist" || tail === "history";
  }
  if (host === "trakt.tv") {
    return segs.length === 3 && segs[0] === "users" &&
      (segs[2] === "watchlist" || segs[2] === "history" || segs[2] === "continue-watching");
  }
  return false;
}

// /api/preview takes a caller-supplied url and feeds it to fetchCatalog.
// detectSource used to default unknown strings to "mdblist", and the
// preview handler echoed the raw fetch error, so an unauthenticated
// client could probe hosts by the distinct failure strings even though
// Workers block RFC1918. Gate first: only the sentinels fetchCatalog
// actually dispatches on, plus https URLs on the provider hosts those
// fetchers talk to. Published-list URLs are KV-only (no outbound fetch)
// so any https host with that path shape is fine. Failures after this
// check still collapse to one generic message at the route.
function isAllowedCatalogSourceUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return false;
  if (
    s.startsWith("mdblist:") ||
    s.startsWith("trakt:") ||
    s.startsWith("tmdb:") ||
    s.startsWith("simkl:") ||
    s.startsWith("channel:v1:") ||
    s.startsWith("customlist:v1:") ||
    s.startsWith("autotrack:") ||
    s.startsWith("custom:") ||
    s.startsWith("curated:") ||
    s.startsWith("mylists:most-watched:") ||
    s.startsWith("mylists:better-posters:")
  ) {
    return true;
  }
  // Bare "user/listname" -- mdblistJsonUrl accepts this and always fetches
  // mdblist.com, never the string as a URL.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) {
    const parts = s.split("/").filter(Boolean);
    return parts.length >= 2 && parts.length <= 8 && parts.every((p) => /^[A-Za-z0-9._-]+$/.test(p));
  }
  let u;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (
    host === "mdblist.com" || host === "www.mdblist.com" ||
    host === "trakt.tv" || host === "www.trakt.tv" || host === "app.trakt.tv" ||
    host === "themoviedb.org" || host === "www.themoviedb.org" ||
    host === "simkl.com" || host === "www.simkl.com" ||
    host === "letterboxd.com" || host === "www.letterboxd.com"
  ) {
    return true;
  }
  // Own published lists -- resolved from KV, never fetched. Any https host
  // with /lists/{user}/{slug} is the share URL shape parsePublishedListUrl
  // already accepts (including a sibling workers.dev deployment).
  if (typeof parsePublishedListUrl === "function" && parsePublishedListUrl(s)) return true;
  return false;
}

function previewSourceUrls(raw) {
  const s = String(raw || "").trim();
  if (!s) return [];
  // channel:v1: / customlist:v1: payloads are JSON that may contain
  // newlines. Those are not merge separators -- fetchCatalog only splits
  // the whole url when it is several sources stacked, not a single
  // sentinel blob. Treat the payload as one URL so a Live Preview of a
  // Channel still works.
  if (s.startsWith("channel:v1:") || s.startsWith("customlist:v1:")) return [s];
  return s.split("\n").map((line) => line.trim()).filter(Boolean);
}

// Parses a pasted trakt.tv list URL into the { user, list } pair the Trakt
// API needs. Accepts the standard public-list URL shape:
//   https://trakt.tv/users/USERNAME/lists/LIST-SLUG-OR-ID
// (also tolerates a trailing slash or extra path segments like /items).
// `list` can be either the list's slug or its numeric id — Trakt's API
// accepts both interchangeably in this position.
function traktListPath(input) {
  const s = (input || "").trim().replace(/^https?:\/\/(www\.|app\.)?trakt\.tv\//i, "");
  const m = s.match(/^users\/([^/]+)\/lists\/([^/?#]+)/i);
  if (!m) return null;
  return { user: m[1], list: m[2] };
}

// Parses a pasted themoviedb.org list URL into its numeric list id.
// TMDB lists are global (not scoped under a username the way Trakt's are),
// referenced as either https://www.themoviedb.org/list/8290920 or with a
// trailing display slug like .../list/8290920-my-favorites.
function tmdbListId(input) {
  const s = (input || "").trim();
  const m = s.match(/themoviedb\.org\/list\/(\d+)/i);
  return m ? m[1] : null;
}

// Parses a TMDB collection URL or sentinel (e.g. tmdb:collection:86311 or
// https://www.themoviedb.org/collection/86311) into its numeric collection id.
function tmdbCollectionId(input) {
  const s = (input || "").trim();
  if (s.startsWith("tmdb:collection:")) {
    const id = s.slice("tmdb:collection:".length).split(/[^0-9]/)[0];
    return id || null;
  }
  const m = s.match(/themoviedb\.org\/collection\/(\d+)/i);
  return m ? m[1] : null;
}

// --- popular lists (mdblist.com/toplists) -------------------------------

// Pulls mdblist.com's own "Popular Lists" page (https://mdblist.com/toplists/)
// via their REST API and normalizes each entry into something the builder
// page can turn into an entry with one click. Requires an MDBList API key —
// same one used for private lists / the watchlist quick-add.
async function fetchTopLists(apikey, env = null, ctx = null) {
  if (!apikey) {
    throw new Error(
      "Popular Lists is temporarily unavailable. Please try again later."
    );
  }

  const cacheKey = "user_cache:mdblist:toplists";
  const kvKey = "mdblist:toplists";

  return await fetchWithPerUserCacheAndCircuitBreaker({
    cacheKey,
    kvKey,
    env,
    ctx,
    freshTtlSec: 3600,
    staleTtlSec: 86400,
    kvTtlSec: 86400,
    providerLabel: "MDBList Toplists",
    fetchFn: async () => {
      const res = await fetch(
        `https://api.mdblist.com/lists/top?apikey=${encodeURIComponent(apikey)}`,
        {
          headers: { "User-Agent": `my-list-addon/${ADDON_VERSION}` },
          cf: { cacheTtl: 3600, cacheEverything: true },
        }
      );
      if (!res.ok) {
        const hint =
          res.status === 401 || res.status === 403 ? " Double-check your MDBList API key." : "";
        throw new Error(`MDBList top-lists request failed (HTTP ${res.status}).${hint}`);
      }

      const data = await res.json();
      return (Array.isArray(data) ? data : []).map((l) => ({
        name: l.name,
        user: l.user_name,
        slug: l.slug,
        type: l.mediatype === "show" ? "series" : "movie",
        items: l.items,
        likes: l.likes,
        url: `https://mdblist.com/lists/${encodeURIComponent(l.user_name)}/${encodeURIComponent(l.slug)}`,
      }));
    },
  });
}

async function searchTraktLists(query, traktKeyOverride) {
  const rawQ = (query || "").trim();
  if (!rawQ) return [];
  const q = rawQ.replace(/^@/, "").trim();
  const traktKey = traktKeyOverride || TRAKT_CLIENT_ID;
  if (!traktKey) {
    throw new Error("Trakt lists are temporarily unavailable. Please try again later.");
  }

  const headers = {
    "Content-Type": "application/json",
    "trakt-api-version": "2",
    "trakt-api-key": traktKey,
    "User-Agent": `my-list-addon/${ADDON_VERSION}`,
  };

  const requests = [
    fetchTraktWithRetry(`https://api.trakt.tv/search/list?query=${encodeURIComponent(q)}&limit=30`, {
      headers,
      cf: { cacheTtl: 900, cacheEverything: true },
    }).then(async (r) => (r.ok ? await r.json() : [])).catch(() => [])
  ];

  // If query looks like a possible username (single token without spaces), also query user lists directly
  const isPossibleUsername = /^[a-zA-Z0-9_-]{2,32}$/.test(q);
  if (isPossibleUsername) {
    requests.push(
      fetchTraktWithRetry(`https://api.trakt.tv/users/${encodeURIComponent(q)}/lists`, {
        headers,
        cf: { cacheTtl: 900, cacheEverything: true },
      }).then(async (r) => {
        if (!r.ok) return [];
        const userLists = await r.json();
        if (!Array.isArray(userLists)) return [];
        return userLists.map((l) => ({ list: { ...l, user: l.user || { ids: { slug: q }, username: q } } }));
      }).catch(() => [])
    );
  }

  const [searchData, userData] = await Promise.all(requests);
  const combinedRaw = [...(Array.isArray(searchData) ? searchData : []), ...(Array.isArray(userData) ? userData : [])];

  const seenUrls = new Set();
  const lists = [];

  for (const r of combinedRaw) {
    const l = r && r.list ? r.list : r;
    if (!l || !l.ids || !l.ids.slug) continue;
    const userSlug = (l.user && l.user.ids && l.user.ids.slug) || (l.user && l.user.username) || (isPossibleUsername ? q : '');
    if (!userSlug) continue;
    const url = `https://trakt.tv/users/${encodeURIComponent(userSlug)}/lists/${encodeURIComponent(l.ids.slug)}`;
    if (seenUrls.has(url.toLowerCase())) continue;
    seenUrls.add(url.toLowerCase());

    const name = l.name || "";
    const isMovie = /\bmovie(s)?\b/i.test(name);
    const isSeries = /\b(show|shows|series|anime|tv|season(s)?)\b/i.test(name);
    const contentType = isMovie && !isSeries ? "movie" : (isSeries && !isMovie ? "series" : "unknown");

    lists.push({
      name: l.name || l.ids.slug,
      user: (l.user && l.user.username) || userSlug,
      slug: l.ids.slug,
      items: l.item_count || 0,
      likes: l.likes || 0,
      contentType,
      url,
      source: "Trakt",
    });
  }

  return lists;
}
