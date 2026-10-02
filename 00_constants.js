// --- Logs never carry a secret (S-14, task P2-7) -----------------------------
//
// Every console call in the Worker goes through here. This top-level `console`
// shadows the global one for all the numbered files -- they share one module
// scope -- the same way the `fetch` guard in 02_http-and-creator-utils.js does,
// so the ~120 existing log lines and any added later are covered without each
// one remembering. Each argument passes through redactForLog first.
//
// The real console is looked up at call time, so a test that swaps
// console.error still sees every line. Declared first, in the first file, so
// nothing can log before it exists; it and its helpers depend on nothing
// declared later.
const console = makeRedactingConsole();

function makeRedactingConsole() {
  const out = {};
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    out[level] = (...args) => {
      const real = globalThis.console;
      if (!real || typeof real[level] !== "function") return;
      let safe;
      try {
        safe = args.map((a) => redactForLog(a));
      } catch {
        safe = ["[log line dropped: it could not be redacted]"];
      }
      real[level](...safe);
    };
  }
  return out;
}

// Masks secrets in a value that is about to be logged:
//   - key, token and session query parameters in any URL in a string
//     (api_key, apikey, access_token, refresh_token, token, key, client_secret,
//     session_id, creatorKey, code);
//   - "Bearer <token>" (an Authorization header value);
//   - a Creator Key (MYL-XXXX-XXXX-XXXX);
//   - in a plain object, array or Headers, any field whose name says it is a
//     key, token, secret, password, cookie or Authorization -- two levels deep.
// An Error keeps its name, with its message and stack redacted. Anything else
// is logged as it is.
// Types are told apart by their tag rather than instanceof, so an object made
// in another realm (a test sandbox, a vm context) is recognized too.
function redactForLog(value, depth = 0) {
  if (typeof value === "string") return redactSecretsInText(value);
  if (!value || typeof value !== "object") return value;
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object Error]") {
    const copy = new Error(redactSecretsInText(value.message));
    copy.name = value.name;
    if (value.stack) copy.stack = redactSecretsInText(value.stack);
    return copy;
  }
  if (depth >= 2) return value;
  if (tag === "[object Headers]" && typeof value.forEach === "function") {
    const copy = {};
    value.forEach((v, k) => { copy[k] = isSecretFieldName(k) ? "[redacted]" : redactSecretsInText(v); });
    return copy;
  }
  if (Array.isArray(value)) return value.map((v) => redactForLog(v, depth + 1));
  // A plain object: its prototype is some realm's Object.prototype (whose own
  // prototype is null), or null. Class instances are logged as they are.
  const proto = Object.getPrototypeOf(value);
  if (tag !== "[object Object]" || (proto !== null && Object.getPrototypeOf(proto) !== null)) return value;
  const copy = {};
  for (const [k, v] of Object.entries(value)) {
    copy[k] = isSecretFieldName(k) ? "[redacted]" : redactForLog(v, depth + 1);
  }
  return copy;
}

function redactSecretsInText(text) {
  return String(text)
    .replace(/([?&#;](?:api_key|apikey|access_token|refresh_token|token|key|client_secret|session_id|sessionid|creatorkey|code)=)[^&#\s"'<>]*/gi, "$1[redacted]")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/=-]+/gi, "$1 [redacted]")
    .replace(/\bMYL-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}\b/g, "MYL-[redacted]");
}

// Field names that hold a credential: exact names (authorization, cookie,
// password, token, secret) and names ending in one (apiKey, tmdbKey,
// creatorKey, traktAccessToken, client_secret, sessionId). A bare `key` is
// left alone -- in this codebase that is almost always a KV key name.
function isSecretFieldName(name) {
  const n = String(name);
  if (/^(authorization|cookie|set-cookie|password|token|secret)$/i.test(n)) return true;
  if (/(api_?key|_key|secret|_token|access_?token|refresh_?token|session_?id|password)$/i.test(n)) return true;
  return /[a-z](Key|Token)$/.test(n);
}

const ADDON_ID = "app.my-list";
const ADDON_VERSION = "1.5.5";
const ADDON_NAME = "My Lists";

// How many items a "Recommended Movies"/"Recommended Shows" list holds --
// shared deliberately by the two places that build one, because they used
// to disagree. /api/recommendations (25_api-catalog-routes.js) is what the
// Discover tab's card renders and counts; fetchCuratedCatalog
// (05_catalog-core.js) is what the actual catalog row and the Live Preview
// serve. The card said 40 and the shelf said 100 (PAGE_SIZE) purely
// because each hardcoded its own number. One constant so they cannot
// drift apart again.
const CURATED_RECOMMENDATION_LIMIT = 40;

// --- Bounds on the unauthenticated permanent-KV-write endpoint --------------
//
// /api/save accepts a body from anyone at all and stores it under a KV key
// that nothing in this Worker ever expires or deletes. It used to bound
// nothing, so a single anonymous request could park multiple megabytes in KV
// permanently, as many times as it liked.
//
// It used to have a sibling. /api/publish-list did the same for an anonymous
// published LIST and was removed in 1.5.3 -- unauthenticated, unowned,
// permanent, with no caller anywhere in the shipped bundle. Its own tighter
// ceilings went with it; the two below are still shared with the
// authenticated list save, which is what publishes a list now.
//
// These ceilings are set far above real usage on purpose -- the largest
// genuine list observed in an account export was ~1,200 items, and a
// realistic install config is tens of rows, not thousands. Anything over
// these is rejected with a clear error rather than silently truncated:
// quietly storing a shortened list or a shortened install config would
// trade one bug for a worse, invisible one.
const PUBLISHED_LIST_ITEMS_MAX = 10000;
const PUBLISHED_LIST_NAME_MAX = 200;

// --- shared channels ----------------------------------------------------
//
// A shared channel is stored whole under one KV key, so it needs a ceiling
// that KV itself does not give it in any useful form: 25MB is the hard
// limit, but a 25MB record is also a 25MB read on every import and every
// directory card built from it. 4MB is roughly a 5,000-episode channel with
// full artwork -- the largest thing this add-on can actually build -- and
// is rejected rather than truncated, for the reason PUBLISHED_LIST_ITEMS_MAX
// already spells out: quietly storing a shortened channel is a worse bug
// than refusing an oversized one.
const SHARED_CHANNEL_BYTES_MAX = 4000000;
// How many channels the Explore Channels directory holds. One KV key, read
// on every visit to the tab, so this is a page-weight budget as much as a
// storage one; the oldest listing falls off when a new one arrives.
const PUBLIC_CHANNEL_INDEX_MAX = 500;

// A Spotlight channel reads one show a season at a time to find the episodes
// its subject is actually in (see /api/person-show-episodes). These bound
// what one show can cost and contribute: a soap with 40 seasons would
// otherwise be 40 TMDB calls, and a series regular on a 300-episode run
// would drown every other credit in the channel.
const PERSON_SHOW_MAX_SEASONS = 20;
const PERSON_SHOW_MAX_EPISODES = 400;
const SAVED_CONFIG_ENTRIES_MAX = 500;
const SAVED_CONFIG_BYTES_MAX = 10 * 1024 * 1024;        // 10 MB of serialized JSON

// --- Bounds on the AUTHENTICATED list write ----------------------------------
//
// The ceilings above bound /api/save, which anyone at all can call, and once
// bounded /api/publish-list too. /api/creator/lists/save had no bound of any
// kind -- not on
// items, not on the name, not on bytes -- even though a Creator Profile costs
// one unauthenticated POST to create. The reasoning that produced the
// anonymous limits applies here almost unchanged; it simply was not carried
// across. Measured before this existed: one account parked 21.8 MB across
// eight saves, and /api/creator/lists returns every list's FULL items array
// on every dashboard render, so that came straight back down the wire.
//
// The item and name caps are deliberately the same numbers as the anonymous
// ones -- there is no reason a signed-in list should be allowed to be larger
// than a published one, and sharing the constants stops the two drifting.
//
// The byte ceiling is different, and lower, because of a limit the anonymous
// path does not have to care about: D1's maximum string/row size is 2,000,000
// bytes. A creator list is mirrored into creator_lists.items_json, and a
// record over that limit cannot be written -- the failure lands in a catch
// that logs and carries on, so the list simply stops being mirrored, silently,
// which is exactly the state that made a missing D1 row destroy a real like
// count. Rejecting at 1.8 MB keeps the mirror honest with room for the other
// columns. Far above any genuine list: the largest observed in an account
// export was ~1,200 items.
const CREATOR_LIST_BYTES_MAX = 1_800_000;

// --- Bound on what /api/creator/lists reads in one invocation ---------------
//
// That route is the creator dashboard's only data source. It read the account's
// whole list order and then issued ONE KV get per list, with no cap: 990 lists
// is 1,001 KV operations, past Cloudflare's 1,000-operations-per-invocation
// limit (that is the KV/D1 cap -- 1,000 on Free and Paid alike -- not the
// outbound-fetch one). At that point the invocation is terminated and the
// dashboard never loads again. Because deleting a list is done FROM the
// dashboard, an account that crossed the line had no in-app way back.
//
// Not hypothetical: one real account reached 129 list records for 22 real
// lists through the duplicate-slug bug, and a repeat of anything like that
// walks straight into this wall.
//
// So the route pages. The default is well clear of any real account (the
// measured average is ~6 lists) so the common case is still exactly one
// request, and the client pages through the rest rather than losing it.
const CREATOR_LISTS_PAGE_DEFAULT = 200;
const CREATOR_LISTS_PAGE_MAX = 500;
// A stop on the client's paging loop, so a server that never sets hasMore=false
// cannot spin forever. 100 pages x 200 = 20,000 lists, far past anything the
// rest of these bounds allow.
const CREATOR_LISTS_MAX_PAGES = 100;

// --- The transfer half of the same finding --------------------------------
//
// Paging bounded the KV OPERATIONS /api/creator/lists spends. It did not bound
// the BYTES: the route still returned every list's full `items` array, and
// renderCreatorDashboard calls it after every save, delete, tab switch and
// background sync. Measured at 1,200 lists that was 15.08 MB, and the
// overwhelming majority of it was data the browser already held.
//
// So the route no longer sends `items` at all -- it sends `itemCount` and
// `updatedAt`, and the client asks this endpoint for the contents of only the
// slugs whose `updatedAt` it does not already have cached. After a one-list
// edit that is one list's items instead of every list's.
//
// The batch is capped so this endpoint has the same property the paged one
// does: cost bounded by the request, not by what the account owns. 100 reads
// plus the auth lookups is an order of magnitude clear of Cloudflare's
// 1,000-KV-operations-per-invocation cap (which is the storage-op cap, not
// the outbound-fetch one -- see the two caps spelled out below).
const CREATOR_LIST_ITEMS_BATCH_MAX = 100;

// --- Bound on /api/bulk-resolve's fan-out ------------------------------------
//
// That endpoint issues up to two TMDB calls per item and always uses the
// Worker owner's shared key. The request size is the bound: 200 items is ~400
// outbound fetches, well inside the Workers Paid limit of 10,000 per
// invocation. (It used to also carry BULK_RESOLVE_SUBREQUEST_BUDGET = 48 and a
// resume protocol so an import could crawl through the Free plan's 50; the
// hosted Worker is on Paid, so that is gone. The import moves to a background
// job in a later phase.)
//
// Shared with the client so the chunk size it sends and the size the server
// accepts cannot drift apart.
const BULK_RESOLVE_ITEMS_MAX = 200;
// The per-IP ceiling, counted in TITLES rather than requests -- the thing the
// endpoint actually spends (someone else's TMDB quota).
const BULK_RESOLVE_ITEMS_PER_MINUTE = 4000;

// --- /api/details/batch --------------------------------------------------------
//
// Per-IP ceilings, charged in IDS rather than requests.
const DETAILS_BATCH_IDS_PER_MINUTE = 3600;
const DETAILS_BATCH_IDS_PER_MINUTE_OWN_KEY = 14400;
// A stop on the client's resume loop. The server now always resolves the whole
// batch and answers done:true, so the loop ends after one round; the constant
// stays until the client's loop is removed.
const DETAILS_BATCH_MAX_ROUNDS = 8;

// --- The Continue Watching sweep's per-tick size ------------------------------
//
// How many shows one cron tick checks for a newly aired episode (two TMDB
// season lookups each at worst). This sweep is replaced by a show-centric
// schedule in a later phase (NEXT_VERSION_ARCHITECTURE.md section 5).
const CRON_EPISODE_CHECK_MAX = 150;

// --- New on Streaming -------------------------------------------------------
//
// The catalog behind tmdb:new-on-streaming[:service]: what actually arrived on
// a streaming service, newest first, with a show pushed back to the top when
// a new episode airs.
//
// It cannot be a discover query, and that is the whole reason any of this
// exists. TMDB's with_watch_providers answers "is this on Netflix right now";
// nothing in TMDB, Trakt or Simkl answers "when did it get there". The closest
// existing row in this add-on, tmdb:genre:stream-releases, sorts by
// primary_release_date instead -- which is why it shows theatrical-era titles
// and completely misses a 1998 film being added to Hulu this morning.
//
// So the add-on observes it. Each cron tick walks a slice of a provider's
// catalog; a title that was not in streaming_events already is an arrival, and
// the moment it is first seen is the date the shelf sorts on. That date is
// only ever as good as the observation, which is why the sweep is written to
// be cheap enough to run constantly rather than accurate in one pass.
//
// Provider ids are the ones already verified for TMDB_CHART_PATHS (see
// tmdbProviderChartPaths, 07_source-fetchers-tmdb-simkl.js): TMDB carries more
// than one entry for some services, a wrong id fails silently by showing the
// wrong catalog under the right label, and these were confirmed through the
// admin dashboard's Provider Preview tab. Do NOT hand-edit them from memory --
// re-verify through that tab, the same rule that block already carries.
//
// jwPackage is the JustWatch package shortName -- the same eight services
// mdblist.com/new-on-streaming offers ticked by default in its service picker
// (Netflix, Amazon Prime Video, Disney Plus, Apple TV, Hulu, HBO Max, Peacock
// Premium, Paramount Plus Premium), confirmed against JustWatch's own
// `packages(country: US)` query.
const NEW_ON_STREAMING_PROVIDERS = [
  { key: "netflix", name: "Netflix", rapidId: "netflix", jwPackage: "nfx" },
  { key: "primevideo", name: "Prime Video", rapidId: "prime", jwPackage: "amp" },
  { key: "disney", name: "Disney+", rapidId: "disney", jwPackage: "dnp" },
  { key: "hbomax", name: "HBO Max", rapidId: "hbo", jwPackage: "mxx" },
  { key: "hulu", name: "Hulu", rapidId: "hulu", jwPackage: "hlu" },
  { key: "appletv", name: "Apple TV+", rapidId: "apple", jwPackage: "atp" },
  { key: "paramount", name: "Paramount+", rapidId: "paramount", jwPackage: "ppp" },
  { key: "peacock", name: "Peacock", rapidId: "peacock", jwPackage: "pct" },
];

// Where the sweep reads arrivals from. "justwatch" is what mdblist's New on
// Streaming is built on (its changelog, Aug 20 2026), so it is the only way
// to show the same titles on the same days -- RapidAPI's /changes feed is a
// different crawler with different dates and, often, different titles (the
// 2024 Road House "on Hulu", Velvet "on Peacock"). "rapidapi" is kept as a
// fallback. A Worker var NEW_ON_STREAMING_ENGINE overrides this.
//
// JustWatch's GraphQL API is the one its own website calls. It has no key and
// no published terms for third-party use -- mdblist presumably has an
// arrangement. Using it here is the operator's call.
const NEW_ON_STREAMING_ENGINE = "justwatch";
const JUSTWATCH_GRAPHQL_URL = "https://apis.justwatch.com/graphql";
// A JustWatch day keeps filling up for a while after it starts (the 1st of a
// month has 600 entries by the evening), so the most recent days are re-read
// on every sweep. Older days are read once and kept.
const NEW_ON_STREAMING_JW_REFRESH_DAYS = 3;
const NEW_ON_STREAMING_JW_PAGE_SIZE = 100;
const NEW_ON_STREAMING_JW_MAX_PAGES_PER_SWEEP = 30;
const JUSTWATCH_NEW_TITLES_CAP = 600;
// TMDB lookups one sweep may spend checking the IMDb ids JustWatch gives
// (resolveJustWatchIds). Each title is checked once and remembered in the
// table, so only first sightings cost one; a busy day spills into the next
// sweep rather than going unchecked.
const NEW_ON_STREAMING_JW_MAX_ID_LOOKUPS = 300;
const NEW_ON_STREAMING_JW_INTERVAL_SECONDS = 7200;

const RAPIDAPI_CHANGES_URL = "https://streaming-availability.p.rapidapi.com/changes";
const RAPIDAPI_HOST = "streaming-availability.p.rapidapi.com";
const NEW_ON_STREAMING_WINDOW_DAYS = 30;
// Subscription (and Peacock's free tier) catalogs ONLY. The bare service ids
// ("prime", "apple", "hulu") also match that service's rent/buy store and its
// add-on channels -- "prime" is every Prime Video Channels title and every
// Amazon digital rental, "apple" is essentially the iTunes Store -- and every
// one of those changes spent one of a page's 25 slots before being thrown
// away client-side. That is also how a Starz-via-Prime title ended up labelled
// "Prime Video". JustWatch (what mdblist.com/new-on-streaming reads) lists
// those channels as separate providers, so leaving them out here is what
// matching it means, not just what saves quota.
const NEW_ON_STREAMING_DEFAULT_CATALOGS = [
  "netflix.subscription",
  "prime.subscription",
  "hulu.subscription",
  "disney.subscription",
  "hbo.subscription",
  "apple.subscription",
  "paramount.subscription",
  "peacock.subscription",
  "peacock.free",
].join(",");
const NEW_ON_STREAMING_REGIONS = ["US"];

// RapidAPI Streaming Availability Quota Limits & Schedule:
// Basic plan hard limit: 1,000 requests per month, 1,000 requests per hour.
// Safety cap stops automated and manual sweeps at 950 to ensure no overages occur.
const RAPIDAPI_MONTHLY_LIMIT = 1000;
const RAPIDAPI_MONTHLY_SAFETY_CAP = 950;

// Automated sweeps run every 6 hours (~120/month). The page budget of each one
// is not fixed: it is whatever is left of the month's safety cap divided by the
// sweeps left in the month (newOnStreamingTickBudget), clamped to the range
// below. So a month with a few big manual sweeps spends less per tick later,
// and one that has been quiet can afford to catch up -- the cap is never the
// thing that stops the sweep in the last week.
//
// Every tick has to spend one request per change stream just to ask "anything
// new?" (see NEW_ON_STREAMING_STREAMS), so fewer, fuller ticks buy more real
// changes per request than frequent near-empty ones. mdblist's own list moves
// once a day; four sweeps a day is already finer than that.
const NEW_ON_STREAMING_SWEEP_INTERVAL_SECONDS = 21600;
const NEW_ON_STREAMING_MIN_PAGES_PER_TICK = 4;
const NEW_ON_STREAMING_MAX_PAGES_PER_TICK = 16;

// The /changes feed as four independent streams, each with its own resume
// point in KV (cron:newonstreaming:streams:<region>). A stream is read oldest
// first from where it last stopped and follows RapidAPI's cursor across ticks,
// so a busy day (the 1st of the month, a 20-episode season drop) is finished on
// the next tick instead of everything past the first page being dropped --
// which is what reading newest-first with a fixed page count per tick did.
//
// Listed in priority order: a tick polls every due stream once, then spends
// what is left in this order. A title's first arrival matters most; episode
// changes are by far the largest stream (one change per episode, per service)
// and so get what remains. `everySeconds` throttles a stream that does not need
// polling every tick. `maxLagSeconds` lets a stream that has fallen hopelessly
// behind skip forward rather than spend days replaying stale changes that
// could only ever land below what is already on the shelf.
const NEW_ON_STREAMING_STREAMS = [
  { id: "show", changeType: "new", itemType: "show", everySeconds: 0, maxLagSeconds: 0 },
  { id: "season", changeType: "new", itemType: "season", everySeconds: 0, maxLagSeconds: 0 },
  { id: "episode", changeType: "new", itemType: "episode", everySeconds: 0, maxLagSeconds: 3 * 86400 },
  { id: "removed", changeType: "removed", itemType: "show", everySeconds: 86400, maxLagSeconds: 0 },
];
// A stream's next query starts this far before where the last one ended, in
// case a change is published with a timestamp slightly older than the moment
// it became visible. Re-reading it costs a slot on a page, never a wrong row:
// every write is an idempotent upsert.
const NEW_ON_STREAMING_RESUME_OVERLAP_SECONDS = 1800;

// Kept for the admin route's default and the "Clear & pull fresh data" path,
// which still backfills newest-first (see sweepRapidApiNewOnStreaming).
const NEW_ON_STREAMING_MAX_PAGES_PER_SWEEP = 4;
const NEW_ON_STREAMING_PAGES_PER_TICK = NEW_ON_STREAMING_MAX_PAGES_PER_SWEEP;
const NEW_ON_STREAMING_SWEEP_FETCHES = 1;

// TMDB network ids of each service's own originals. bumpNewOnStreamingEpisodes
// (the TMDB-based fallback for episode bumps) only moves a service's row when
// the show is that service's original, because a broadcast air date says
// nothing about when -- or whether -- a library service gets the episode:
// Live PD airing on A&E is not new on Netflix, which only has old seasons.
const NEW_ON_STREAMING_ORIGINAL_NETWORKS = {
  netflix: [213],
  primevideo: [1024],
  disney: [2739],
  hbomax: [49, 3186],
  hulu: [453],
  appletv: [2552],
  paramount: [4330],
  peacock: [3353],
};

// The shelf is public: "New on Streaming" is in the My Lists Addon Charts
// section of Quick Add and in Discover (MY_LISTS_ADDON_CHARTS,
// 08_quickadd-chart-data.js).

// --- My Lists Addon Most Watched ---------------------------------------------
//
// mylists:most-watched:<window> -- this add-on's own chart, built from the
// same "watched" counts as the admin dashboard's Trending Data tab
// (computeLeaderboard, 03_admin.js). Windows are Eastern calendar days, the
// same buckets that tab uses.
//
// Each window/type is a snapshot in KV (mylists:mostwatched:v2:<window>:<type>),
// rebuilt on the first request after it goes stale: the 7- and 30-day charts
// once per Eastern day, "today" every 15 minutes, so a title just watched
// reaches the top of it promptly. "today" also rolls over rather than
// starting empty at midnight -- see rollMostWatchedToday.
const MOST_WATCHED_WINDOWS = ["today", "7", "30"];
const MOST_WATCHED_TODAY_REFRESH_SECONDS = 900;
// How long the rolling "today" list survives with nobody opening it. Past
// this it starts again from that day's watches alone.
const MOST_WATCHED_TODAY_KEEP_SECONDS = 60 * 86400;
// Each Most Watched chart is its top 25. (New on Streaming is not capped: it
// is the whole 30-day window.)
const MOST_WATCHED_MAX_ITEMS = 25;
// Titles with an IMDb id get a Metahub poster with no API call at all. Only
// the rest (a tmdb: id, or no stored name) need a TMDB lookup. A build is
// bounded at this many lookups so one chart can't fan out across hundreds of
// candidates -- it used to be 20 so a build fit the Free plan's 50 fetches.
// Two per chart slot is plenty; titles come from the media table in v2.
const MOST_WATCHED_MAX_LOOKUPS = MOST_WATCHED_MAX_ITEMS * 2;

// --- Quick Add network channel presets --------------------------------------
//
// Same id/name pairs as the "Quick Add Popular Networks" buttons in
// 13_tab-channels.js -- kept as a second, server-side list rather than
// scraped from that HTML, since the cron sweep below needs to walk them with
// no page loaded. Adding a network button there is not "live" for this sweep
// until its id/name pair is added here too.
const CHANNEL_PRESET_NETWORKS = [
  { id: "129", name: "A&E" },
  { id: "2", name: "ABC" },
  { id: "80", name: "Adult Swim" },
  { id: "174", name: "AMC" },
  { id: "4", name: "BBC One" },
  { id: "56", name: "Cartoon Network" },
  { id: "16", name: "CBS" },
  { id: "47", name: "Comedy Central" },
  { id: "64", name: "Discovery" },
  { id: "54", name: "Disney Channel" },
  { id: "143", name: "Food Network" },
  { id: "19", name: "FOX" },
  { id: "88", name: "FX" },
  { id: "384", name: "Hallmark Channel" },
  { id: "49", name: "HBO" },
  { id: "209", name: "HGTV" },
  { id: "65", name: "History" },
  { id: "436", name: "Ion Television" },
  { id: "738", name: "MeTV" },
  { id: "33", name: "MTV" },
  { id: "6", name: "NBC" },
  { id: "13", name: "Nickelodeon" },
  { id: "149", name: "Syfy" },
  { id: "68", name: "TBS" },
  { id: "71", name: "The CW" },
  { id: "84", name: "TLC" },
  { id: "41", name: "TNT" },
  { id: "30", name: "USA Network" },
];
// buildNetworkChannelPreset (07_source-fetchers-tmdb-simkl.js) only uses this
// to build a `/api/channel-logo?path=...` URL, and that URL is never read as
// a live link -- every consumer (getPremadeChannelLogo/extractLogoPath,
// 05_catalog-core.js) re-extracts just the `path=` query param and rebuilds
// the link against the real request's origin at serve time. So the cron
// sweep, which has no request to take an origin from, can use any placeholder
// here without the cached preset ever pointing at a dead host.
const CHANNEL_PRESET_PREWARM_ORIGIN = "https://prewarm.internal";

// Server-side copy of 20_client-channel-builder.js's own CHANNEL_POOL_MAX_ITEMS
// -- the two have to agree (this one is the real cap on a Quick Add preset's
// pool; the client's is the cap on the hand-built/import-from-link path,
// which still runs client-side). A preset this big is cached in KV
// (channel:preset:v2:<networkId>, well under KV's 25MB value limit) and
// NEVER embedded whole into a saved config -- a catalog row only ever
// carries a tiny `{presetNetworkId, channelId, ...}` pointer at
// entry.url (channel:v1:), resolved back to the full pool from that KV
// cache at the moment something actually needs the episode list
// (channelSourceItems, 05_catalog-core.js). That split is what lets this be
// 5,000 without reviving the "too large to save" bug several Quick Add
// channels in one config used to hit when the whole pool rode in the URL.
const CHANNEL_POOL_MAX_ITEMS = 5000;
// Discover pages pulled per network before building episodes -- 20 shows a
// page, so 10 pages is the same up-to-200-show candidate pool
// /api/quick-channel-shows already offers the client-built path. Building
// stops the moment CHANNEL_POOL_MAX_ITEMS is reached regardless of how much
// of this pool was actually walked (see buildNetworkChannelPreset), so a
// bigger candidate pool costs nothing extra for a popular network that hits
// the cap early -- it only matters for a network sparse enough to need it.
const CHANNEL_PRESET_DISCOVER_PAGES = 10;

// --- Bounds on the KV -> D1 backfill sweep ----------------------------------
//
// /admin/api/migrate-d1 walks five KV prefixes (creator:, creatorlist:,
// publishedlist:user:, stats:sourcegroup:, stats:) and spends a KV read plus
// a D1 write on each key it keeps -- both of which count against Cloudflare's
// 1,000-storage-operations-per-invocation limit. That is the KV/D1/R2 cap,
// 1,000 on both the Free and the Paid plan; the separate outbound-fetch cap
// (50 free, 10,000 paid) does not apply here, since this sweep makes no
// outbound requests. It used to do the whole sweep in one request with no
// cap, so on a site big enough to need migrating it aborted partway through
// with "Too many subrequests" and backfilled only whatever it had reached.
//
// That failure is worse than it looks: per wrangler.toml, an account present
// in KV but missing from D1 is exactly the case /api/creator/reset-key and
// /admin/api/reset-creator-key handle incorrectly, because a D1 UPDATE
// matching zero rows still reports success. So the endpoint whose job is to
// prevent that state was itself the thing leaving accounts in it.
//
// It now runs in resumable chunks against migrated1:state, the same shape
// /admin/api/migrate-day-counts and the public-index rebuild use. Every
// section of the sweep is idempotent (DO NOTHING, or DO UPDATE to a value
// derived only from KV), so re-processing a key across a chunk boundary is
// harmless -- which is what makes chunking safe here.
const MIGRATE_D1_STATE_KEY = "migrated1:state";
const MIGRATE_D1_PREFIXES = [
  "creator:",
  "creatorlist:",
  "publishedlist:user:",
  "stats:sourcegroup:",
  "stats:",
  "listlikevoters:",
  "feedback:",
  "evtmeta:",
  "creatorscrobbletoken:",
  "creatorsynctracking:",
  "creatorsync:",
];
// This endpoint has its invocation to itself (it is admin-triggered, not
// ridden along on the cron), so it can claim more of the 1,000 storage
// operations than the index rebuild does -- but still well short of it,
// since a chunk that throws saves no progress.
const MIGRATE_D1_OPS_PER_RUN = 700;
const MIGRATE_D1_PAGE = 200;
// Errors accumulate across every chunk of a run and are handed back to the
// admin panel, so they need a ceiling of their own.
const MIGRATE_D1_ERROR_CAP = 50;

// --- Bound on the display-order array ----------------------------------------
//
// /api/creator/lists/reorder writes whatever slugs it is handed into one KV
// key, and had no cap on how many. Authenticated, so the blast radius is the
// caller's own key -- hygiene rather than a vulnerability -- but an unbounded
// authenticated write is still an unbounded write. Far above any real
// account: the worst case ever observed on a live one was 129 records, and
// that was the duplicate-list bug.
const CREATOR_LIST_ORDER_MAX = 5000;

// --- Recovery-answer strength and throttle ----------------------------------
//
// A Creator Key is ~60 bits of entropy and infeasible to guess. The optional
// recovery answer that can REPLACE it via /api/creator/reset-key is not: it
// is free text a human picks, usually the answer to an implicit security
// question, and it is lowercased before hashing. That endpoint hands back a
// brand-new working key on a match, so the recovery answer is a second,
// far weaker credential for full account takeover.
//
// It used to be throttled by IP alone (10/day). IPs are cheap and rotate;
// the account being attacked does not. Rotating source IPs took over a test
// account in five guesses. Two things follow from that:
//
//   * the throttle has to count per ACCOUNT, not just per source, so the
//     budget an attacker is spending belongs to the thing being attacked;
//   * the answer needs a floor on its length, because no rate limit rescues
//     a secret with a handful of plausible values.
//
// Only the per-account failure budget defends existing accounts, so it is
// the load-bearing half. The minimum length applies to newly set answers.
const RESET_KEY_ACCOUNT_MAX_FAILURES = 5;
const RECOVERY_ANSWER_MIN_LENGTH = 8;
const FORGOT_USERNAME_IP_MAX_FAILURES = 5;
const FORGOT_USERNAME_IP_TTL_SEC = 900;

// --- Bound on /api/channel-logo's inlined image ------------------------------
//
// That endpoint fetches a TMDB image and base64-encodes it into an SVG,
// holding the whole thing in memory twice (a byte array, then a binary
// string) before encoding. It is unauthenticated, so the size of what it
// will buffer needs a ceiling rather than being whatever the upstream
// happens to return. A w500 poster is tens of kilobytes.
const CHANNEL_LOGO_MAX_BYTES = 2 * 1024 * 1024;

// --- Connecting the env-backed API key globals -------------------------------
//
// The `let` globals below are the names every helper in this add-on
// references (TMDB_API_KEY, TRAKT_CLIENT_ID, ...). They start empty and have
// to be pointed at whatever this Worker owner configured. This is the one
// place that does it, so the fetch and scheduled entry points cannot drift.
//
// scheduled() has to call it too, and did not. Nothing is broken today only
// because both cron functions happen to read env.X directly and thread it
// down -- but 36 bare references to these globals exist across 03_, 05_,
// 06_ and 07_, and the first cron-reachable call into any of them would have
// silently used an empty key: no crash, no error, just a provider quietly
// returning nothing. Three lines here retires the whole class.
//
// `|| ""` guards against `env` not carrying the property at all, which is
// how a missing Worker secret or var normally reads.
function applyEnvApiKeys(env) {
  TMDB_API_KEY = (env && env.TMDB_API_KEY) || "";
  RAPIDAPI_KEY = (env && (env.RAPIDAPI_KEY || env.STREAMING_AVAILABILITY_API_KEY)) || "";
  TRAKT_CLIENT_ID = (env && env.TRAKT_CLIENT_ID) || "";
  SIMKL_CLIENT_ID = (env && env.SIMKL_CLIENT_ID) || "";
  SIMKL_CLIENT_SECRET = (env && env.SIMKL_CLIENT_SECRET) || "";
  MDBLIST_API_KEY = (env && env.MDBLIST_API_KEY) || "";
  MDBLIST_POPULAR_KEY = (env && env.MDBLIST_POPULAR_KEY) || "";
  MDBLIST_CLIENT_ID = (env && env.MDBLIST_CLIENT_ID) || "";
}

// --- Daily failure budgets on the credential endpoints -----------------------
//
// /admin/login and /api/creator/restore each already carry a 60-second
// per-IP bucket in KV. Those bound a burst, but KV reads are edge-cached and
// KV has no atomic increment, so a determined caller can read a stale count
// and slip past. That is acceptable as burst-shaping and NOT as the only
// thing standing in front of a credential.
//
// So both also carry a per-IP DAILY budget, spent only on failures and
// backed by D1's atomic upsert wherever D1 is bound (see noteAuthFailure,
// 02_http-and-creator-utils.js). Successes never consume it, so a legitimate
// admin or someone restoring on a run of new devices is unaffected; the
// ceilings are set far above any plausible honest failure count and reset
// daily on their own.
//
// The secrets behind these are strong -- ADMIN_KEY is a chosen secret and a
// Creator Key is ~60 bits -- so this is defence in depth, not the load-
// bearing control that RESET_KEY_ACCOUNT_MAX_FAILURES is for the weak one.
// How many of one creator's lists /admin/api/delete-creator-list will remove
// in a single call. Each slug costs a KV read, a KV delete, a ledger delete
// and (with D1 bound) a statement -- storage operations, so the cap that
// applies is the 1,000-per-invocation one, the same on Free and Paid. This
// keeps one call well inside it. The admin panel loops, so a
// larger cleanup still completes -- it just arrives as several bounded calls,
// the same shape the other maintenance tools use.
const ADMIN_LIST_DELETE_MAX = 50;

const ADMIN_LOGIN_MAX_FAILURES_PER_DAY = 50;
const CREATOR_RESTORE_MAX_FAILURES_PER_DAY = 100;

// How many Creator Key verifications one IP may force per minute.
//
// Every one of them is PBKDF2 at 100,000 iterations -- about 15ms of CPU,
// measured -- and it runs before the caller has proved anything, on any of the
// sixteen routes that take a Creator Key. Only /api/creator/restore was
// throttled, so /api/creator/sync/load or /api/scrobble?creator=&key= would
// serve unbounded PBKDF2 runs to an anonymous caller: a cheap way to burn
// Worker CPU, and a way around restore's own limit for guessing.
//
// Charged only when the per-isolate memo cannot answer (see
// isCreatorAuthMemoized), so this counts real key checks rather than
// requests. A signed-in dashboard polls, autosaves and pings continuously and
// is memoized throughout, so the ceiling is deliberately far above anything a
// person generates -- several people behind one CGNAT address should never
// see it -- while still bounding a flood to something that cannot dominate an
// invocation budget.
const CREATOR_AUTH_VERIFY_PER_MINUTE = 60;

// --- Personal shelves in install links minted before they were verified ------
//
// A Watch History / Continue Watching / Watchlist shelf in a Stremio config is
// an `autotrack:<slug>:<type>:<username>` row, and reading it means reading the
// account's private tracking record. /api/save now REFUSES to store a config
// naming an account unless the request proved it owns that account (see the
// ownership check there), so from this release on, a stored config that names
// a creator is itself proof and its 12-character id (72 bits, unguessable) is
// the bearer credential the README already describes.
//
// Configs saved BEFORE that check existed carry no proof, and there is no way
// to tell an honestly-saved one from a forged one after the fact. Two choices,
// and both cost something:
//
//   true  -- honour them. Every install link that works today keeps working.
//            The residual is an attacker who forged a config id BEFORE this
//            release and kept it; they retain read access to that one account's
//            shelves until this is flipped.
//   false -- refuse them. Fully closed, and every personal shelf in a link
//            generated before this release goes empty in Stremio -- silently,
//            because a catalog row has no way to explain itself -- until its
//            owner opens Configure and presses Update.
//
// It ships `true` because the hole this release closes is the one anyone can
// walk through today with a single GET, and that one is shut either way; the
// residual requires an attacker who was already exploiting it. Flip this to
// false once your users have had time to regenerate their links, and the last
// of it is gone.
//
// This has no effect on base64 (no-KV) configs, which are caller-authored and
// are never trusted to name an account.
const LEGACY_UNVERIFIED_CONFIG_SHELVES = true;

// --- Bound on /admin/api/creator-lists' KV fallback scan ---------------------
//
// That panel reads D1 (the real source) and then scans this creator's
// `creatorlist:` prefix in KV to surface records D1 does not have. The scan was
// list({ limit: 1000 }) with no cursor, followed by ONE get per key -- so a
// single request could ask for 1,001 storage operations against Cloudflare's
// 1,000-per-invocation cap and simply die, and anything past the first 1,000
// keys was invisible whether it died or not.
//
// 250 keeps the whole request comfortably inside the cap alongside the D1
// queries and the order-key read, and is far past any real account (the largest
// pathological case on record was 129 records for 22 real lists). When the scan
// does hit the bound the response says so, rather than implying it saw
// everything.
const ADMIN_CREATOR_LIST_KV_SCAN_MAX = 250;

// --- Ceiling on one read of the public list directory ------------------------
//
// getPublicListIndex's D1 query had no LIMIT. /lists/public.json therefore
// fetched every public list on the deployment -- evaluating json_array_length
// over each one's items_json to count its entries -- and then kept 100 of them.
// Page one cost as much as the whole directory, and the failure mode past a
// certain size is a D1 response-size error, not a slow page.
//
// This is the ceiling for ONE read, which is also the cap on the search
// fallback's whole-index scan. Paging is how a caller reaches past it.
const PUBLIC_INDEX_MAX_ROWS = 1000;

// --- How long an account reset stays announced -------------------------------
//
// /api/creator/account/reset empties an account but keeps the identity, so every
// other browser signed into it still holds the whole thing in localStorage --
// and each of them treats an empty account as "nothing has ever been saved
// here, so my copy is the first save" and uploads it back. That is why a reset
// appeared to undo itself a few hours later.
//
// This is how long the reset marker announces itself for. It has to outlast a
// device that is simply not in use -- a phone in a drawer over a long weekend,
// a laptop that stays shut -- so it is generous. Past it, a device that has
// STILL not synced is one whose copy is months stale, and the account's own
// data has moved on anyway.
const CREATOR_RESET_TTL_SEC = 90 * 24 * 60 * 60;

// --- Env-backed API keys ----------------------------------------------------
//
// These five all used to be hardcoded literals here. They're declared with
// `let` (not `const`) and start out empty -- the actual values get read from
// `env` and assigned to these same module-level names at the very top of the
// fetch() handler in 25_api-catalog-routes.js, once per request. That keeps
// every helper function throughout this add-on that already references
// these constants by name working completely unchanged (no need to thread
// `env` through dozens of call sites), while making sure nothing here in
// source is a real credential. See the file header comment above for what
// each one unlocks and where to get a free one; see
// 25_api-catalog-routes.js for the assignment itself and
// TRAKT_CLIENT_SECRET (a genuine secret, read directly from `env` where
// it's used, never mirrored into a global like these) for the pattern this
// followed.
//
// A per-user override still takes priority over these where one exists
// (the MDBList key / Trakt Client ID boxes in the builder page) -- these
// are only ever the fallback for someone who hasn't filled those in.
let TMDB_API_KEY = "";
let RAPIDAPI_KEY = "";
let MDBLIST_API_KEY = "";
let MDBLIST_POPULAR_KEY = "";
let MDBLIST_CLIENT_ID = "";
let TRAKT_CLIENT_ID = "";
let SIMKL_CLIENT_ID = "";
let SIMKL_CLIENT_SECRET = "";

// Countries for the Settings > External Accounts & API Keys region picker
// (streaming-availability catalogs and content ratings -- see
// 07_source-fetchers-tmdb-simkl.js's tmdbProviderChartPaths/
// fetchTmdbItemDetailsUncached). ISO 3166-1 alpha-2 codes, matching what
// TMDB's own watch_region/certification data expects. Not every country
// TMDB recognizes is listed here -- this covers the markets TMDB actually
// has meaningful watch-provider coverage for, sorted by country name so
// the dropdown reads naturally rather than needing anyone to already know
// their own ISO code.
const REGION_OPTIONS = [
  ["AR", "Argentina"], ["AU", "Australia"], ["AT", "Austria"], ["BE", "Belgium"],
  ["BO", "Bolivia"], ["BR", "Brazil"], ["CA", "Canada"], ["CL", "Chile"],
  ["CO", "Colombia"], ["CR", "Costa Rica"], ["HR", "Croatia"], ["CZ", "Czech Republic"],
  ["DK", "Denmark"], ["DO", "Dominican Republic"], ["EC", "Ecuador"], ["EG", "Egypt"],
  ["FI", "Finland"], ["FR", "France"], ["DE", "Germany"], ["GR", "Greece"],
  ["HK", "Hong Kong"], ["HU", "Hungary"], ["IN", "India"], ["ID", "Indonesia"],
  ["IE", "Ireland"], ["IL", "Israel"], ["IT", "Italy"], ["JP", "Japan"],
  ["MY", "Malaysia"], ["MX", "Mexico"], ["NL", "Netherlands"], ["NZ", "New Zealand"],
  ["NO", "Norway"], ["PA", "Panama"], ["PE", "Peru"], ["PH", "Philippines"],
  ["PL", "Poland"], ["PT", "Portugal"], ["RO", "Romania"], ["SA", "Saudi Arabia"],
  ["SG", "Singapore"], ["ZA", "South Africa"], ["KR", "South Korea"], ["ES", "Spain"],
  ["SE", "Sweden"], ["CH", "Switzerland"], ["TW", "Taiwan"], ["TH", "Thailand"],
  ["TR", "Turkey"], ["AE", "United Arab Emirates"], ["GB", "United Kingdom"],
  ["US", "United States"], ["UY", "Uruguay"], ["VE", "Venezuela"], ["VN", "Vietnam"],
];

// Renders REGION_OPTIONS as <option> tags for the Settings region <select>,
// called at render time in 15_tab-settings-html.js with whatever region
// this install's config already carries (or "US" for a fresh one).
function buildRegionOptionsHtml(selectedRegion) {
  const sel = (selectedRegion || "US").toUpperCase().slice(0, 2) || "US";
  return REGION_OPTIONS.map(
    ([code, name]) => `<option value="${code}"${code === sel ? " selected" : ""}>${name}</option>`
  ).join("");
}



const PUBLIC_INDEX_MAX = 20000;

// --- D1 schema manifest ------------------------------------------------------
//
// What each file under migrations/ adds, so the Worker can tell an operator
// when it is running ahead of its own database.
//
// This exists because the failure is otherwise silent and measured: deploy the
// Worker without running migration 0004 and account deletion still answers
// ok:true, still writes its KV tombstone, and still refuses the deleted
// account on a normal request -- but the strongly-consistent half of R3 is
// gone, and a colo with a stale KV cache authenticates a deleted account. The
// only trace is one line in the Worker's logs, which nobody reads until after
// something has gone wrong.
//
// `consequence` is the point of the whole structure. "creator_tombstones is
// missing" tells an operator nothing they can act on; "deleted accounts can
// still authenticate from a colo whose KV cache is stale" tells them whether
// it matters this afternoon.
//
// Kept in step with migrations/ by a test, not by discipline: adding a
// migration without adding its objects here fails the suite, the same way
// FUNCTION-MAP.md and the combined Worker are kept honest by a drift check.
// The newest migration this code needs. The Worker refuses API writes with a
// 503 while the database's schema_migrations ledger is behind this (see
// schemaWriteGate, 02_http-and-creator-utils.js). Bump it in the same change
// that adds a migration the code depends on.
const REQUIRED_SCHEMA_VERSION = "0014";

const D1_SCHEMA_MANIFEST = [
  {
    migration: "0001a", kind: "column", table: "creator_lists", name: "likes",
    consequence: "Every list save and the whole D1 mirror fail -- creator_lists has no likes column to write.",
  },
  {
    migration: "0001b", kind: "index", name: "idx_creator_lists_likes",
    consequence: "Ordering public lists by likes scans the table instead of using an index. Slower, not broken.",
  },
  {
    migration: "0002", kind: "table", name: "stats",
    consequence: "Counters fall back to the older KV-only path. Admin totals still work; day-by-day history is thinner.",
  },
  {
    migration: "0003", kind: "index", name: "idx_creators_last_active",
    consequence: "The admin creators list sorts by scanning every row. Slower, not broken.",
  },
  {
    migration: "0003", kind: "index", name: "idx_creator_lists_vis_likes",
    consequence: "The public directory query sorts the whole table rather than walking an index. Slower, not broken.",
  },
  {
    migration: "0004", kind: "table", name: "creator_tombstones",
    consequence: "A deleted account can still authenticate from a colo whose KV cache predates the deletion. This is a security property, not a performance one -- apply this one.",
  },
  {
    migration: "0005", kind: "index", name: "idx_stats_day_totals",
    consequence: "The dashboard's counter panels scan and sort the whole stats table on every load. Slower, not broken.",
  },
  {
    migration: "0006", kind: "table", name: "published_lists",
    consequence: "Anonymous published lists cannot be mirrored or served from D1.",
  },
  {
    migration: "0006", kind: "index", name: "idx_published_vis_likes",
    consequence: "Ordering published lists by likes scans the table instead of using an index. Slower, not broken.",
  },
  {
    migration: "0007", kind: "table", name: "lists_fts",
    consequence: "Full-text search over public lists falls back or fails.",
  },
  {
    migration: "0008", kind: "column", table: "creators", name: "share_json",
    consequence: "Per-slug tracking share opt-in settings fall back to KV only.",
  },
  {
    migration: "0008", kind: "column", table: "creators", name: "lists_stamp",
    consequence: "List change synchronization stamp falls back to KV only.",
  },
  {
    migration: "0008", kind: "column", table: "creator_lists", name: "sort_order",
    consequence: "Creator list display ordering falls back to KV creatorlistorder.",
  },
  {
    migration: "0008", kind: "table", name: "list_tombstones",
    consequence: "Deleted list sync tombstones fall back to KV creatorlistdeleted.",
  },
  {
    migration: "0008", kind: "index", name: "idx_list_tombstones_user_until",
    consequence: "Querying active list tombstones scans the table instead of an index.",
  },
  {
    migration: "0009", kind: "table", name: "list_likes",
    consequence: "Per-voter like ledgers fall back to KV listlikevoters.",
  },
  {
    migration: "0009", kind: "index", name: "idx_list_likes_voter",
    consequence: "Querying likes by voter scans the table instead of an index.",
  },
  {
    migration: "0009", kind: "table", name: "feedback",
    consequence: "Feedback threads fall back to KV feedback:* multi-page list scanning.",
  },
  {
    migration: "0009", kind: "index", name: "idx_feedback_status_updated",
    consequence: "Querying feedback by status and date scans the table instead of an index.",
  },
  {
    migration: "0009", kind: "table", name: "scrobble_tokens",
    consequence: "Scrobble webhook tokens fall back to KV scrobbletoken.",
  },
  {
    migration: "0009", kind: "index", name: "idx_scrobble_tokens_user",
    consequence: "Looking up scrobble tokens by username scans the table instead of an index.",
  },
  {
    migration: "0009", kind: "table", name: "event_meta",
    consequence: "Title event display metadata falls back to KV evtmeta.",
  },
  {
    migration: "0010", kind: "table", name: "watch_history",
    consequence: "Watch history items fall back to creatorsynctracking:* monolithic KV blob.",
  },
  {
    migration: "0010", kind: "index", name: "idx_watch_history_user_watched",
    consequence: "Ordering watch history by date scans the table instead of an index.",
  },
  {
    migration: "0010", kind: "table", name: "continue_watching",
    consequence: "Continue watching items fall back to creatorsynctracking:* monolithic KV blob.",
  },
  {
    migration: "0010", kind: "index", name: "idx_continue_watching_user_updated",
    consequence: "Ordering continue watching by date scans the table instead of an index.",
  },
  {
    migration: "0010", kind: "table", name: "airing_next",
    consequence: "Airing next items fall back to creatorsynctracking:* monolithic KV blob.",
  },
  {
    migration: "0010", kind: "index", name: "idx_airing_next_user",
    consequence: "Looking up airing next by air date scans the table instead of an index.",
  },
  {
    migration: "0010", kind: "table", name: "creator_user_lists",
    consequence: "User list preferences (liked, hidden) fall back to creatorsync:* KV blob.",
  },
  {
    migration: "0010", kind: "index", name: "idx_creator_user_lists_lookup",
    consequence: "Looking up user list preferences scans the table instead of an index.",
  },
  {
    migration: "0010", kind: "table", name: "creator_show_states",
    consequence: "Show states (fully watched / dismissed) fall back to creatorsynctracking:* KV blob.",
  },
  {
    migration: "0010", kind: "index", name: "idx_creator_show_states_fw",
    consequence: "Querying fully watched shows scans the table instead of an index.",
  },
  {
    migration: "0010", kind: "table", name: "creator_tracking_meta",
    consequence: "Tracking metadata and conflict versioning fall back to creatorsynctracking:* KV blob.",
  },
  {
    migration: "0011", kind: "table", name: "streaming_events",
    consequence: "New on Streaming has nowhere to record provider arrivals, so the sweep writes nothing and the catalog stays empty. Unlike the rest of this manifest there is no KV fallback: the dates in this table are observed over time and cannot be refetched, so every tick that runs without it is history not collected.",
  },
  {
    migration: "0011", kind: "index", name: "idx_streaming_events_feed",
    consequence: "Every page of the New on Streaming shelf sorts the whole table instead of walking an index. Slower, not broken.",
  },
  {
    migration: "0011", kind: "index", name: "idx_streaming_events_tmdb",
    consequence: "The sweep's \"which of these titles do I already have\" lookup scans the table once per page walked, and so does the episode re-bump. Slower, not broken.",
  },
  {
    migration: "0012", kind: "column", table: "creator_show_states", name: "airing_removed_season",
    consequence: "Removing a show from Airing Next stops sticking: the removal cannot be stored on the account, so it holds only in the browser that made it and any other device puts the show back. Everything else about tracking keeps working -- the Worker checks for this column and writes the older statement without it.",
  },
  {
    migration: "0012", kind: "column", table: "creator_show_states", name: "airing_removed_episode",
    consequence: "The other half of the pair above; without it a stored removal has no episode to be superseded by, so watching another episode could not bring the show back.",
  },
  {
    migration: "0013", kind: "table", name: "creator_key_lookups",
    consequence: "Account Key lookup index falls back to KV keylookup:* only.",
  },
  {
    migration: "0013", kind: "index", name: "idx_creator_key_lookups_username",
    consequence: "Deleting or updating an account's key lookup by username scans the table instead of an index. Slower, not broken.",
  },
  {
    migration: "0014", kind: "table", name: "schema_migrations",
    consequence: "The Worker cannot tell which migrations have run, so it cannot refuse writes while it is ahead of the database. Apply migrations/0014.",
  },
  {
    migration: "0015", kind: "table", name: "accounts",
    consequence: "The unified accounts system is unavailable. User profiles, authentication, and session-based identity fall back to legacy creators store.",
  },
  {
    migration: "0015", kind: "table", name: "sessions",
    consequence: "Session storage is unavailable. Browser login sessions, cookies, and multi-device authentication cannot be established.",
  },
  {
    migration: "0015", kind: "index", name: "idx_sessions_account",
    consequence: "Listing or revoking an account's active sessions scans the sessions table instead of an index. Slower, not broken.",
  },
  {
    migration: "0015", kind: "table", name: "installs",
    consequence: "Modern install links and permanent install configs cannot be stored or resolved from D1.",
  },
  {
    migration: "0015", kind: "index", name: "idx_installs_account",
    consequence: "Querying installs by account scans the installs table instead of an index. Slower, not broken.",
  },
  {
    migration: "0015", kind: "table", name: "provider_connections",
    consequence: "Server-side encrypted OAuth tokens and provider credentials cannot be stored on the account.",
  },
  {
    migration: "0015", kind: "table", name: "install_secrets",
    consequence: "Transitional encrypted provider credentials on unowned install links cannot be stored.",
  },
  {
    migration: "0015", kind: "table", name: "rate_counters",
    consequence: "Per-account and credential rate limits cannot be tracked in D1.",
  },
  {
    migration: "0015", kind: "table", name: "account_settings",
    consequence: "Account-level UI and sync preferences cannot be stored in D1.",
  },
];


// ---------------------------------------------------------------------------
// BetterPosters (https://btttr.cc) -- optional replacement artwork.
//
// BetterPosters renders a title's poster with the text baked in: genre, star
// rating, a trend tag ("Trending"/"New"), quality flags (4K/DV/Atmos) and an
// age rating. It keys off the IMDB id alone -- no API key, no account, nothing
// to register -- so the whole integration is a URL rewrite over metas this
// add-on already built. Off by default; "Better Posters" in Settings ->
// Artwork & Badges turns it on.
//
// The URL contract is the one btttr.cc's own configurator emits for external
// add-ons (its "AIOMetadata / Other Addon" mode):
//
//   https://btttr.cc/{base}/imdb/poster-default/{imdb_id}.jpg[?tag=none][&lang=..][&rs=..]
//
// {base} is what selects the artwork -- NOT the literal "poster-default"
// segment after it. That segment is fixed: the service ignores whatever is put
// there (every value, including a nonsense one, returns byte-identical bytes),
// which is why the nuvio-better-posters-addon project's single hard-coded
// "/poster/imdb/poster-default/{id}.jpg" only ever yields the default style.
// buildBetterPosterUrl (05_catalog-core.js) assembles the base properly.
const BETTER_POSTERS_ORIGIN = "https://btttr.cc";

// Rating sources btttr.cc accepts for "rs", straight off its configurator's
// own dropdown. "avg" is its default and is sent as no parameter at all.
const BETTER_POSTERS_RATING_SOURCES = [
  { value: "avg", label: "Average" },
  { value: "IM", label: "IMDb (/10)" },
  { value: "TM", label: "TMDB (/10)" },
  { value: "RT", label: "Rotten Tomatoes (%)" },
  { value: "MC", label: "Metacritic (/100)" },
  { value: "TR", label: "Trakt (/10)" },
  { value: "LB", label: "Letterboxd (/5)" },
  { value: "RE", label: "Roger Ebert (/4)" },
];

// Languages btttr.cc's configurator offers for "lang". Anything not on this
// list is treated as English (again: sent as no parameter).
const BETTER_POSTERS_LANGS = [
  { value: "en", label: "English" },
  { value: "es-ES", label: "Espa\u00f1ol (Espa\u00f1a)" },
  { value: "es-MX", label: "Espa\u00f1ol (Latinoam\u00e9rica)" },
  { value: "fr", label: "Fran\u00e7ais" },
  { value: "de", label: "Deutsch" },
  { value: "pt-BR", label: "Portugu\u00eas (Brasil)" },
  { value: "pt-PT", label: "Portugu\u00eas (Portugal)" },
  { value: "it", label: "Italiano" },
  { value: "nl", label: "Nederlands" },
  { value: "pl", label: "Polski" },
  { value: "ru", label: "\u0420\u0443\u0441\u0441\u043a\u0438\u0439" },
  { value: "tr", label: "T\u00fcrk\u00e7e" },
  { value: "ar", label: "\u0627\u0644\u0639\u0631\u0628\u064a\u0629" },
  { value: "ja", label: "\u65e5\u672c\u8a9e" },
  { value: "ko", label: "\ud55c\uad6d\uc5b4" },
  { value: "zh", label: "\u4e2d\u6587" },
  { value: "hi", label: "\u0939\u093f\u0928\u094d\u0926\u0940" },
  { value: "sv", label: "Svenska" },
  { value: "cs", label: "\u010ce\u0161tina" },
];

function buildBetterPostersLangOptionsHtml(selected) {
  const sel = BETTER_POSTERS_LANGS.some((l) => l.value === selected) ? selected : "en";
  return BETTER_POSTERS_LANGS.map(
    ({ value, label }) => `<option value="${value}"${value === sel ? " selected" : ""}>${label}</option>`
  ).join("");
}

function buildBetterPostersRatingSourceOptionsHtml(selected) {
  const sel = BETTER_POSTERS_RATING_SOURCES.some((r) => r.value === selected) ? selected : "avg";
  return BETTER_POSTERS_RATING_SOURCES.map(
    ({ value, label }) => `<option value="${value}"${value === sel ? " selected" : ""}>${label}</option>`
  ).join("");
}

// --- personal, auto-tracked shelves --------------------------------------
//
// Continue Watching, Airing Next, Watch History and Watchlist, across every
// provider that can supply one. These are not lists in the ordinary sense:
// each is a live view OF ONE ACCOUNT, derived per request, and its whole job
// is to answer "what am I in the middle of / what is next for me".
//
// That makes them the wrong input and the wrong target for anything that
// treats lists as interchangeable collections -- "Remove duplicate items
// across lists" most of all, which would otherwise strip the show you are
// three episodes into out of Continue Watching purely because it also turned
// up in Trending higher on the page.
const PERSONAL_SHELF_URL_PREFIXES = [
  "autotrack:",
  "trakt:watchlist", "trakt:history", "trakt:airing-next", "trakt:continue-watching", "trakt:user:",
  "mdblist:watchlist", "mdblist:history", "mdblist:airing-next", "mdblist:upnext", "mdblist:user:",
  "simkl:watchlist", "simkl:history", "simkl:airing-next", "simkl:user:",
];

// True when ANY source line of a (possibly merged) row names a personal
// shelf -- a merged row carrying one is still reading somebody's account.
function isPersonalShelfUrl(url) {
  if (!url) return false;
  return String(url).split(/[\r\n]+/).some((line) => {
    const u = line.trim().toLowerCase();
    return !!u && PERSONAL_SHELF_URL_PREFIXES.some((p) => u.startsWith(p));
  });
}

// How many TMDB->IMDB translations one /api/imdb-ids call will do, and how
// many run at once. 100 covers a whole See All page of tiles in one call; the
// concurrency is what keeps a batch that size polite to TMDB. Each lookup is
// one outbound request, edge-cached for a day. (Results are persisted in the
// media table in a later phase.) The builder page batches to the same number.
const IMDB_ID_LOOKUP_MAX = 100;
const IMDB_ID_LOOKUP_CONCURRENCY = 8;

// The Stremio/Nuvio artwork-overlay toggles, as stored in an install config.
// Named in one place because they have to agree across four: the builder
// page's save request, /api/save's stored payload, resolveConfig's read, and
// the badge gate in fetchCatalog. Each reads as ON when absent, so only a
// switched-off one is ever written.
const STREMIO_BADGE_KEYS = [
  "showBadgesStremio",
  "showBadgesStremioAiringNext",
  "showBadgesStremioContinueWatching",
  "showBadgesStremioWatchlist",
  "showBadgesStremioCatalogs",
];

// --- The install config, field by field (task P2-8) -------------------------
//
// Every setting an install link can carry, in one place. It used to be written
// out by hand in six -- /api/save's allowlist, resolveConfig, decodeConfig, the
// builder's save body, its signed-out filter and the configure page -- and the
// copies drifted: the badge toggles and then Better Posters were each missing
// from the save allowlist (the setting looked saved and never reached the
// apps), resolveConfig never read simklUsername back, and the configure page
// was never handed Better Posters, so opening Configure on an install that
// used it showed it off, and pressing Update saved it off.
//
// kind:
//   "account" -- belongs to a connected provider account. Stored only for a
//                signed-in save (docs/DECISIONS.md D-8); read back as "".
//                `secret` marks the keys and tokens, which never leave the
//                server in a page or an API answer.
//   "flag"    -- off unless set; stored only when on.
//   "flagOn"  -- on unless set to false; stored only when off, so a config
//                with everything on stays as small as it was.
//   "choice"  -- a string with a default and, optionally, the values allowed
//                (checked at the door: /api/save is unauthenticated and some of
//                these end up in a URL); stored only when allowed and not the
//                default.
// requires: stored only while that flag is on (Better Posters' style options).
//
// Not here: `entries`, and the account-proof fields (track, trackCreatorName,
// trackCreatorKey, trackOwner), which /api/save sets only after verifying the
// account.
const INSTALL_CONFIG_FIELDS = [
  { name: "tmdbKey", kind: "account", secret: true },
  { name: "mdblistKey", kind: "account", secret: true },
  { name: "mdblistAccessToken", kind: "account", secret: true },
  { name: "traktKey", kind: "account", secret: true },
  { name: "traktUsername", kind: "account" },
  { name: "traktAccessToken", kind: "account", secret: true },
  { name: "simklKey", kind: "account", secret: true },
  { name: "simklAccessToken", kind: "account", secret: true },
  { name: "simklUsername", kind: "account" },
  { name: "shuffleShelves", kind: "flag" },
  { name: "shuffleItems", kind: "flag" },
  { name: "region", kind: "choice", default: "US" },
  { name: "hideNonDigitalReleases", kind: "flag" },
  { name: "adultContentFilter", kind: "flag" },
  { name: "dedupeAcrossLists", kind: "flag" },
  ...STREMIO_BADGE_KEYS.map((name) => ({ name, kind: "flagOn" })),
  { name: "betterPosters", kind: "flag" },
  { name: "betterPostersGenre", kind: "flagOn", requires: "betterPosters" },
  { name: "betterPostersRating", kind: "flagOn", requires: "betterPosters" },
  { name: "betterPostersTrendTags", kind: "flagOn", requires: "betterPosters" },
  { name: "betterPostersQuality", kind: "flag", requires: "betterPosters" },
  { name: "betterPostersAge", kind: "flag", requires: "betterPosters" },
  { name: "betterPostersOrderTodayBadges", kind: "flag", requires: "betterPosters" },
  {
    name: "betterPostersLang", kind: "choice", default: "en", requires: "betterPosters",
    allowed: BETTER_POSTERS_LANGS.map((l) => l.value),
  },
  {
    name: "betterPostersRatingSource", kind: "choice", default: "avg", requires: "betterPosters",
    allowed: BETTER_POSTERS_RATING_SOURCES.map((r) => r.value),
  },
];

// Every field, read out of a stored or decoded config with its default
// applied. `parsed` may be anything -- an old link's bare entries array, or
// garbage -- and the answer is always complete.
function readInstallConfigFields(parsed) {
  const src = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const out = {};
  for (const f of INSTALL_CONFIG_FIELDS) {
    const v = src[f.name];
    if (f.kind === "account") out[f.name] = typeof v === "string" ? v : "";
    else if (f.kind === "flag") out[f.name] = !!v;
    else if (f.kind === "flagOn") out[f.name] = v !== false;
    else out[f.name] = (typeof v === "string" && v) ? v : f.default;
  }
  return out;
}

// The fields /api/save stores from a request body: only what differs from its
// default, only what passes its check, and account fields only for a signed-in
// save.
function storedInstallConfigFields(body, withAccountFields) {
  const src = body && typeof body === "object" ? body : {};
  const out = {};
  for (const f of INSTALL_CONFIG_FIELDS) {
    if (f.requires && !src[f.requires]) continue;
    const v = src[f.name];
    if (f.kind === "account") {
      if (withAccountFields && typeof v === "string" && v) out[f.name] = v;
    } else if (f.kind === "flag") {
      if (v) out[f.name] = true;
    } else if (f.kind === "flagOn") {
      if (v === false) out[f.name] = false;
    } else if (typeof v === "string" && v && v !== f.default && (!f.allowed || f.allowed.includes(v))) {
      out[f.name] = v;
    }
  }
  return out;
}

// The same values with every key and token removed: what a page or an API
// answer may carry (the configure page's starting values, for one).
function nonSecretInstallConfigFields(values) {
  const out = {};
  for (const f of INSTALL_CONFIG_FIELDS) {
    if (!f.secret && values && f.name in values) out[f.name] = values[f.name];
  }
  return out;
}

// --- Catalog rows that are one account's live state -------------------------
//
// The detectSource names (04_config-resolution.js) whose catalog response is
// sent no-store instead of the 24-hour public cache every other row gets --
// see the catalog route (25_api-catalog-routes.js). A row belongs here when
// its items change because of something the account DID (watched, added,
// removed), under a URL that stays the same: the install link's config id
// only changes when the config does, so a cached copy of one of these would
// sit there, stale, for a day.
//
//   autotrack        Watchlist, Watch History, Continue Watching, Airing Next
//   curated          Recommended Movies / Recommended Shows
//   trakt-*, mdblist-*, simkl-user
//                    the same shelves read from a connected account
const STREMIO_LIVE_ROW_SOURCES = new Set([
  "autotrack",
  "curated",
  "simkl-user",
  "trakt-watchlist",
  "trakt-history",
  "trakt-continue-watching",
  "trakt-airing-next",
  "mdblist-watchlist",
  "mdblist-history",
  "mdblist-airing-next",
  "mdblist-upnext",
]);

// --- Keeping Airing Next and Recommended fresh without the website ----------
//
// Both shelves are built by the website and pushed up as snapshots (see
// refreshAiringNext, 21_client-custom-list-builder.js, and
// persistCuratedRecommendations, 22_client-creator-profile.js). Someone who
// only uses Stremio or Nuvio for a while used to keep seeing the last snapshot
// indefinitely: Airing Next with episodes that had long since aired, and
// Recommended frozen at whatever Discover last showed.

// How often the cron rebuilds an account's Airing Next -- the same cadence the
// website refreshes its own copy at (AIRING_NEXT_REFRESH_MS), so an account is
// never refreshed more often than its own browser would.
const AIRING_NEXT_SERVER_REFRESH_MS = 6 * 3600 * 1000;
// Shows looked up per account per rebuild -- the website's own
// AIRING_NEXT_MAX_SHOWS_PER_RUN, so the two build the same shelf.
const AIRING_NEXT_SERVER_MAX_SHOWS = 60;

// How old the Discover snapshot may be before the Recommended row stops
// serving it and builds its own from the account's viewing. The website
// re-stamps an unchanged snapshot at most every CURATED_RECS_RESTAMP_MS
// (22_client-creator-profile.js), so a snapshot this old means the website
// has not shown Discover for days -- not that its recommendations happened
// not to change.
const CURATED_SNAPSHOT_MAX_AGE_MS = 3 * 24 * 3600 * 1000;
// Seeds per side, as the website sends /api/recommendations (sampleMovieIds /
// sampleShowIds, 19_client-search-and-likes.js).
const RECOMMENDATION_SEEDS_PER_SIDE = 12;
// Accounts the Airing Next sweep rebuilds per tick. Each rebuild is up to
// AIRING_NEXT_SERVER_MAX_SHOWS cached details lookups, and every one of those
// reads a cache (a KV operation) even when it spends no outbound fetch -- so
// this, not the fetch budget, is what keeps one tick under the invocation's
// 1,000-operation cap. 3 a tick at a 6-minute cron is 720 rebuilds a day:
// every account every six hours up to ~180 accounts, and a proportionally
// slower cadence beyond that rather than a tick that fails.
const AIRING_NEXT_SWEEP_ACCOUNTS_PER_TICK = 3;

// /api/bp/warm (25_api-catalog-routes.js): posters per request, and per IP
// per minute. A long Discover page is a few hundred posters, sent in batches
// of BETTER_POSTER_WARM_MAX; almost all of them are already stored after the
// first visit and cost one KV read each, so the ceiling is about the fetches
// a caller could make btttr.cc do, not about this Worker.
const BETTER_POSTER_WARM_MAX = 40;
const BETTER_POSTER_WARM_IDS_PER_MINUTE = 800;
// prewarmBetterPosters (07_source-fetchers-tmdb-simkl.js): how many title x
// style pairs one tick checks against the Worker's copy (a KV read each), and
// how many missing ones it fetches from btttr.cc. A fetch btttr.cc has to draw
// can take most of a minute, so the fetch count is what bounds the tick's
// wall-clock time: 8 at 4 at a time is two waits, not eight.
const BETTER_POSTER_PREWARM_CHECKS_PER_TICK = 60;
const BETTER_POSTER_PREWARM_FETCHES_PER_TICK = 8;
