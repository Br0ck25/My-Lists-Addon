// Creator sync routes (/api/creator/sync/save-presets ... /sync/share-tracking), moved out of handleFetch (CQ-01).

// Moved unchanged: each route body is now its own function; the dispatcher keeps each route's
// original path/method test. Every route still authenticates itself, exactly as before, through
// authenticateCreatorFor (62_creator-auth.js).

// /api/creator/sync/save-presets ... /sync/share-tracking, directly after the previous creator call. Returns a Response, or null.
async function handleCreatorApiSyncRoutes(request, env, ctx, url, path) {
  if (path === "/api/creator/sync/save-presets" && request.method === "POST") return creatorApiSyncSavePresets(request, env, ctx, path);
  if (path === "/api/creator/sync/save-channels" && request.method === "POST") return creatorApiSyncSaveChannels(request, env, ctx, path);
  if (path === "/api/creator/sync/meta" && request.method === "POST") return creatorApiSyncMeta(request, env, ctx, path);
  if (path === "/api/creator/sync/load" && request.method === "POST") return creatorApiSyncLoad(request, env, ctx, path);
  if (path === "/api/creator/sync/like" && request.method === "POST") return creatorApiSyncLike(request, env, ctx, path);
  if (path === "/api/creator/sync/share-tracking" && request.method === "POST") return creatorApiSyncShareTracking(request, env, ctx, path);
  if (path === "/api/nuvio-tv/device/code") return handleNuvioTvDeviceCode(request, env, ctx, url);
  if (path === "/api/nuvio-tv/device/poll") return handleNuvioTvDevicePoll(request, env, ctx, url);
  if (path === "/api/nuvio-tv/device/claim") return handleNuvioTvDeviceClaim(request, env, ctx, url, path);
  return null;
}

// /api/creator/sync/save-presets  (POST)  { creatorName, creatorKey,
// presets?, presetsB64? } -> { ok }
// The dedicated, lightweight sibling of /api/creator/sync/save just for
// presets -- split out because presets are the one piece of synced
// state that can genuinely grow large (a TV Channel's "url" is its
// entire episode list, see collectEntries' comment,
// 21_client-custom-list-builder.js, and a preset stores a full copy of
// everything in it), while everything else in the main blob
// (config/watchHistory/collapsedPanels/etc) changes far more often but
// stays small. Before this split, EVERY autosave -- not just an
// explicit "save preset" -- re-sent and re-processed the entire,
// ever-growing presets payload alongside that small, frequent state,
// which is what could tip a request over Cloudflare's free-plan 10ms
// CPU budget (PBKDF2 verification below plus a large JSON parse/
// stringify) and fail with no useful error. This endpoint only gets
// called when presets actually change (see schedulePresetsSync,
// 24_client-backup-restore-presets.js), and does no deep JSON work of
// its own -- presetsB64 is already gzip-compressed client-side into an
// opaque string, so storing it here is close to a raw pass-through.
async function creatorApiSyncSavePresets(request, env, ctx, path) {
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const auth = await authenticateCreatorFor(request, env, ctx, path, body.creatorName, body.creatorKey);
  if (!auth.ok) return authFailureResponse(auth);
  // Same conflict guard as /api/creator/sync/save. Presets are the blob
  // this codebase itself calls "the one piece of synced state that can
  // genuinely grow large" -- a TV Channel's url is its entire episode
  // list -- and it had no guard at all, so a second device autosaving a
  // stale snapshot silently replaced the whole set. Additive: a client
  // that sends no expectedUpdatedAt keeps the previous behaviour.
  const presetsExpected = parseExpectedUpdatedAt(body.expectedUpdatedAt);
  if (!presetsExpected.ok) {
    return json({ ok: false, error: "expectedUpdatedAt must be a number." }, 400);
  }
  const presetsCurrentRaw = await env.CONFIGS.get(`creatorsyncpresets:${auth.username}`);
  let presetsCurrentUpdatedAt = 0;
  if (presetsCurrentRaw) {
    try {
      const cur = JSON.parse(presetsCurrentRaw);
      presetsCurrentUpdatedAt = Number(cur.updatedAt) || 0;
      if (presetsExpected.value !== null && presetsCurrentUpdatedAt > presetsExpected.value) {
        ctx.waitUntil(bumpStat(env, "sync_conflict"));
        return json({ ok: false, error: "conflict", conflict: true, updatedAt: cur.updatedAt }, 409);
      }
    } catch {
      // Unreadable -- nothing coherent to protect; write normally.
    }
  }
  const presetsBlob = {
    presets: body.presets && typeof body.presets === "object" ? body.presets : {},
    presetsB64: body.presetsB64 || null,
    updatedAt: nextSyncVersion(presetsCurrentUpdatedAt),
  };
  const serialized = JSON.stringify(presetsBlob);
  if (serialized.length > 24 * 1024 * 1024) {
    return json({ ok: false, error: "Your saved presets are too large to store (over the 25MB limit) \u2014 likely from several TV Channels with a lot of episodes. Try removing an older preset or a large Channel." });
  }
  try {
    await env.CONFIGS.put(`creatorsyncpresets:${auth.username}`, serialized);
  } catch (e) {
    return json({ ok: false, error: "Could not save to storage right now. Please try again in a moment." }, 500);
  }
  // Handed back so the client can advance its baseline without a
  // separate /sync/meta round trip, exactly as /sync/save does.
  return json({ ok: true, updatedAt: presetsBlob.updatedAt });
}

// /api/creator/sync/save-channels (POST) { creatorName, creatorKey, channels, mergedChannels }
async function creatorApiSyncSaveChannels(request, env, ctx, path) {
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const auth = await authenticateCreatorFor(request, env, ctx, path, body.creatorName, body.creatorKey);
  if (!auth.ok) return authFailureResponse(auth);
  // Same conflict guard and the same reasoning as save-presets above.
  const channelsExpected = parseExpectedUpdatedAt(body.expectedUpdatedAt);
  if (!channelsExpected.ok) {
    return json({ ok: false, error: "expectedUpdatedAt must be a number." }, 400);
  }
  const channelsCurrentRaw = await env.CONFIGS.get(`creatorsyncchannels:${auth.username}`);
  let channelsCurrentUpdatedAt = 0;
  if (channelsCurrentRaw) {
    try {
      const cur = JSON.parse(channelsCurrentRaw);
      channelsCurrentUpdatedAt = Number(cur.updatedAt) || 0;
      if (channelsExpected.value !== null && channelsCurrentUpdatedAt > channelsExpected.value) {
        ctx.waitUntil(bumpStat(env, "sync_conflict"));
        return json({ ok: false, error: "conflict", conflict: true, updatedAt: cur.updatedAt }, 409);
      }
    } catch {
      // Unreadable -- nothing coherent to protect; write normally.
    }
  }
  // Keep only plain-object entries; an array counts as empty. One null entry
  // saved here would be loaded by every device and break its page.
  const plainObjectEntries = (map) => {
    const out = {};
    if (!map || typeof map !== "object" || Array.isArray(map)) return out;
    for (const [k, v] of Object.entries(map)) {
      if (v && typeof v === "object" && !Array.isArray(v)) out[k] = v;
    }
    return out;
  };
  const channelsBlob = {
    channels: plainObjectEntries(body.channels),
    mergedChannels: plainObjectEntries(body.mergedChannels),
    updatedAt: nextSyncVersion(channelsCurrentUpdatedAt),
  };
  const serialized = JSON.stringify(channelsBlob);
  if (serialized.length > 24 * 1024 * 1024) {
    return json({ ok: false, error: "Your saved channels are too large to store (over the 25MB limit)." });
  }
  try {
    await env.CONFIGS.put(`creatorsyncchannels:${auth.username}`, serialized);
  } catch (e) {
    return json({ ok: false, error: "Could not save to storage right now. Please try again in a moment." }, 500);
  }
  return json({ ok: true, updatedAt: channelsBlob.updatedAt });
}

// /api/creator/sync/meta  (POST)  { creatorName, creatorKey }
//   -> { ok, config, tracking, presets, channels, lists }
// A deliberately tiny sibling of /api/creator/sync/load below, holding
// nothing but the five updatedAt stamps that tell a browser whether
// anything it cares about has actually changed.
//
// It exists because the dashboard polls for multi-device changes on a
// timer while it is simply open (see handleForegroundResumeSync,
// 22_client-creator-profile.js), and that poll used to call sync/load
// itself -- which reads six KV keys, JSON-parses a watchHistory that
// can run to thousands of items, re-serializes all of it, and ships
// the whole thing back down the wire. For an active account that was
// megabytes of response, several times a minute, almost always to
// conclude that nothing had changed at all.
//
// Two things keep this cheap. The five reads run concurrently rather
// than one after another, and each updatedAt is pulled straight out of
// the raw stored string (see readUpdatedAtFromRaw) instead of parsing
// the blob -- so a 4MB tracking record costs a substring scan here,
// not a full parse. The response is a few dozen bytes either way.
//
// Deliberately derived from the same keys sync/load reads rather than
// from a separate "last changed" record: a dedicated key would have to
// be updated by every write path that touches any of these blobs, and
// a single missed write there would silently stop a device from ever
// syncing again. Reading the real thing cannot drift.
async function creatorApiSyncMeta(request, env, ctx, path) {
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    if (request.account && isSessionsEnabled(env)) {
      body = {};
    } else {
      return json({ ok: false, error: "Invalid JSON body." }, 400);
    }
  }
  const auth = await authenticateCreatorFor(request, env, ctx, path, body.creatorName, body.creatorKey);
  if (!auth.ok) return authFailureResponse(auth);

  // Pulls "updatedAt": <number> out of a stored blob without parsing
  // it. Every blob these keys hold writes updatedAt as a plain number
  // at the top level, and lastIndexOf finds the last (top-level) one
  // rather than any nested occurrence inside an item. A miss returns 0,
  // which reads as "older than anything the client has" and simply
  // causes a normal full load -- never a skipped one.
  function readUpdatedAtFromRaw(raw) {
    if (!raw) return 0;
    const marker = '"updatedAt":';
    const at = raw.lastIndexOf(marker);
    if (at === -1) return 0;
    const num = parseInt(raw.slice(at + marker.length, at + marker.length + 20).replace(/[^0-9].*$/, ""), 10);
    return Number.isFinite(num) ? num : 0;
  }

  let configRaw = null, trackingRaw = null, presetsRaw = null, channelsRaw = null, listsRaw = null, metaResetAt = 0;
  // An account on the activity database: reading creatorsynctracking: through
  // the shim assembles every play and both shelves, just to find one number.
  // Take the record's own stamp from its stored settings instead (the same
  // value sync/load hands the browser as trackingUpdatedAt).
  let activityTrackingStamp = null;
  try {
    activityTrackingStamp = typeof trackingUpdatedAtFor === "function" ? await trackingUpdatedAtFor(env, auth.username) : null;
  } catch {
    activityTrackingStamp = null;
  }
  try {
    [configRaw, trackingRaw, presetsRaw, channelsRaw, listsRaw, metaResetAt] = await Promise.all([
      env.CONFIGS.get(`creatorsync:${auth.username}`),
      activityTrackingStamp !== null ? null : env.CONFIGS.get(`creatorsynctracking:${auth.username}`),
      env.CONFIGS.get(`creatorsyncpresets:${auth.username}`),
      env.CONFIGS.get(`creatorsyncchannels:${auth.username}`),
      env.CONFIGS.get(`creatorliststamp:${auth.username}`),
      readCreatorResetAt(env, auth.username),
    ]);
  } catch {
    // A read failure must not look like "nothing changed" -- returning
    // ok:false makes the client fall back to a full sync/load.
    return json({ ok: false, error: "Could not read sync state right now." }, 500);
  }

  let listsStamp = null;
  let d1TrackingStamp = null;
  let d1TrackingExists = false;
  if (env.DB) {
    try {
      const [creatorsRow, metaRow] = await Promise.all([
        env.DB.prepare("SELECT lists_stamp FROM creators WHERE username = ?").bind(auth.username).first(),
        env.DB.prepare("SELECT updated_at FROM creator_tracking_meta WHERE username = ?").bind(auth.username).first(),
      ]);
      if (creatorsRow && creatorsRow.lists_stamp != null) {
        listsStamp = creatorsRow.lists_stamp;
      }
      if (metaRow) {
        d1TrackingExists = true;
        if (metaRow.updated_at != null) {
          d1TrackingStamp = Number(metaRow.updated_at) || 0;
        }
      }
    } catch (e) {}
  }

  const rawTrackingStamp = activityTrackingStamp !== null ? activityTrackingStamp : readUpdatedAtFromRaw(trackingRaw);
  const trackingUpdatedAt = d1TrackingStamp !== null
    ? Math.max(d1TrackingStamp, rawTrackingStamp)
    : rawTrackingStamp;

  return jsonPrivate({
    ok: true,
    exists: configRaw !== null || trackingRaw !== null || activityTrackingStamp !== null || d1TrackingExists,
    config: readUpdatedAtFromRaw(configRaw),
    tracking: trackingUpdatedAt,
    presets: readUpdatedAtFromRaw(presetsRaw),
    channels: readUpdatedAtFromRaw(channelsRaw),
    // The fifth stamp. Unlike the four above it is not read out of the
    // blob it describes -- custom lists have no single blob -- but out of
    // a tiny record every list mutation bumps. See bumpCreatorListsStamp
    // (02_http-and-creator-utils.js) for why that key exists and what
    // keeps it honest. A never-touched account has no such key, which
    // reads as 0 and matches the 0 a fresh browser starts from, so this
    // costs an existing account no spurious reload.
    lists: listsStamp != null ? Number(listsStamp) || 0 : readUpdatedAtFromRaw(listsRaw),
    // A sixth, which is not a stamp of stored state but of stored state
    // having been DELETED. The five above all read 0 after an account
    // reset, and 0 is exactly what a brand-new account reads -- which is
    // how a reset came to undo itself. This is what tells the two apart.
    resetAt: metaResetAt || 0,
  });
}

// /api/creator/sync/load -> { ok, data: blob | null }
// null specifically (rather than an empty blob) distinguishes "this
// account has never synced from any device" from "this account synced
// an empty state" -- the client uses that to decide whether to adopt
// what's already on this browser and push it up as this account's
// first save, versus overwriting this browser with what the account
// already has.
async function creatorApiSyncLoad(request, env, ctx, path) {
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    if (request.account && isSessionsEnabled(env)) {
      body = {};
    } else {
      return json({ ok: false, error: "Invalid JSON body." }, 400);
    }
  }
  const auth = await authenticateCreatorFor(request, env, ctx, path, body.creatorName, body.creatorKey);
  if (!auth.ok) return authFailureResponse(auth);
  await ensureTrackingMigrated(env, auth.username);
  // These reads are independent of one another and awaited in parallel.
  // (ensureTrackingMigrated above runs first on purpose: it can WRITE the
  // tracking key, so reading it alongside would be a race.)
  const [raw, presetsRawInit, channelsRawInit, trackingRawInit, orderRawInit, d1Tracking, d1UserLists, syncResetAt] = await Promise.all([
    env.CONFIGS.get(`creatorsync:${auth.username}`),
    env.CONFIGS.get(`creatorsyncpresets:${auth.username}`),
    env.CONFIGS.get(`creatorsyncchannels:${auth.username}`),
    env.CONFIGS.get(`creatorsynctracking:${auth.username}`),
    env.CONFIGS.get(`creatorlistorder:${auth.username}`),
    env.DB ? readCreatorTrackingD1(env, auth.username) : Promise.resolve(null),
    env.DB ? readCreatorUserListsD1(env, auth.username) : Promise.resolve(null),
    // When this account was last emptied. A browser that has not seen this
    // reset must discard its local copy rather than upload it back -- see
    // purgeCreatorData (02_http-and-creator-utils.js).
    readCreatorResetAt(env, auth.username),
  ]);
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  if (data && data.keys) data.keys = await openSyncKeys(env, auth.username, data.keys);
  if (d1UserLists) {
    if (!data) {
      data = { config: [], collapsedPanels: {}, likedLists: [], updatedAt: Date.now() };
    }
    data.likedLists = d1UserLists.likedLists;
    data.hiddenLists = d1UserLists.hiddenLists;
    data.hiddenMyListsSections = d1UserLists.hiddenMyListsSections;
  }
  data = await creatorSyncLoadMergePresets(env, auth, data, presetsRawInit);
  // Channels & merged channels live in their own key -- merge them back in for signed-in sync across browsers.
  const channelsRaw = channelsRawInit;
  if (channelsRaw) {
    let channelsBlob = null;
    try {
      channelsBlob = JSON.parse(channelsRaw);
    } catch {
      channelsBlob = null;
    }
    if (channelsBlob) {
      if (!data) {
        data = { config: [], collapsedPanels: {}, likedLists: [], updatedAt: Date.now() };
      }
      data.channels = channelsBlob.channels || {};
      data.mergedChannels = channelsBlob.mergedChannels || {};
      data.channelsUpdatedAt = channelsBlob.updatedAt || 0;
    }
  }
  data = await creatorSyncLoadMergeTracking(env, auth, data, d1Tracking, trackingRawInit);
  data = await creatorSyncLoadMergeQueue(env, auth, data);
  let orderRaw = orderRawInit;
  // FF_V2_LISTS_ONLY (P3b-9): the order is kept in v2, not in the
  // legacy key. An account with no lists has none, as before.
  if (isV2ListsOnly(env)) {
    orderRaw = null;
    try {
      const orderAccount = await listsV2Account(env, auth.username);
      const v2Order = orderAccount ? await listsV2OrderSlugs(env, orderAccount) : [];
      if (v2Order.length) orderRaw = JSON.stringify({ order: v2Order });
    } catch (e) {
      console.error("lists v2: sync/load order failed", e);
    }
  }
  if (orderRaw) {
    try {
      const orderBlob = JSON.parse(orderRaw);
      if (Array.isArray(orderBlob.order)) {
        if (!data) data = { config: [], collapsedPanels: {}, likedLists: [], updatedAt: Date.now() };
        data.dashboardListOrder = orderBlob.order;
      }
    } catch {}
  }
  return jsonPrivate({ ok: true, data, resetAt: syncResetAt || 0, sunset_notices: getLegacySunsetNotices(env) });
}

// Merges the dedicated presets key back into the sync blob (a step of creatorApiSyncLoad).
async function creatorSyncLoadMergePresets(env, auth, data, presetsRawInit) {
  // Presets live in their own key now (see save-presets above) -- merge
  // them back in here so the client's loadCreatorSync doesn't need to
  // know or care that this is two KV reads instead of one; it still
  // just reads data.presets/data.presetsB64 exactly like before.
  let presetsRaw = presetsRawInit;
  let presetsBlob = null;
  if (presetsRaw) {
    try {
      presetsBlob = JSON.parse(presetsRaw);
    } catch {
      presetsBlob = null;
    }
  }

  // Extract presets safely regardless of storage format
  let dedicatedPresets = {};
  let dedicatedPresetsB64 = null;
  let dedicatedUpdatedAt = 0;

  if (presetsBlob) {
    if (presetsBlob.presetsB64 && typeof presetsBlob.presetsB64 === "string") {
      dedicatedPresetsB64 = presetsBlob.presetsB64;
    }
    if (presetsBlob.presets && typeof presetsBlob.presets === "object" && !Array.isArray(presetsBlob.presets)) {
      dedicatedPresets = { ...presetsBlob.presets };
    } else if (typeof presetsBlob === "object" && !Array.isArray(presetsBlob)) {
      Object.keys(presetsBlob).forEach((k) => {
        if (k !== "presets" && k !== "presetsB64" && k !== "updatedAt" && presetsBlob[k] && typeof presetsBlob[k] === "object") {
          dedicatedPresets[k] = presetsBlob[k];
        }
      });
    } else if (Array.isArray(presetsBlob)) {
      presetsBlob.forEach((p) => {
        if (p && p.name) dedicatedPresets[p.name] = p;
      });
    }
    if (presetsBlob.updatedAt) dedicatedUpdatedAt = presetsBlob.updatedAt;
  }

  const dedicatedHasPresets = !!(dedicatedPresetsB64 || Object.keys(dedicatedPresets).length > 0);
  const mainHasPresets = !!(data && (data.presetsB64 || (data.presets && typeof data.presets === 'object' && Object.keys(data.presets).length > 0)));

  if (!dedicatedHasPresets && mainHasPresets) {
    let adoptedMap = {};
    if (data.presets && typeof data.presets === "object" && !Array.isArray(data.presets)) {
      adoptedMap = { ...data.presets };
    } else if (Array.isArray(data.presets)) {
      data.presets.forEach((p) => { if (p && p.name) adoptedMap[p.name] = p; });
    }
    dedicatedPresets = adoptedMap;
    dedicatedPresetsB64 = data.presetsB64 || null;
    dedicatedUpdatedAt = Date.now();
    try {
      await env.CONFIGS.put(`creatorsyncpresets:${auth.username}`, JSON.stringify({
        presets: dedicatedPresets,
        presetsB64: dedicatedPresetsB64,
        updatedAt: dedicatedUpdatedAt,
      }));
    } catch {}
  }

  if (!data) {
    data = { config: [], collapsedPanels: {}, likedLists: [], updatedAt: Date.now() };
  }
  data.presets = dedicatedPresets;
  data.presetsB64 = dedicatedPresetsB64;
  data.presetsUpdatedAt = dedicatedUpdatedAt;
  if (presetsBlob && Array.isArray(presetsBlob.customCollections)) {
    data.customCollections = presetsBlob.customCollections;
    data.customCollectionGroups = Array.isArray(presetsBlob.customCollectionGroups) ? presetsBlob.customCollectionGroups : [];
  }
  return data;
}

// Merges the tracking record (D1 first, KV as the fallback) into the sync blob (a step of creatorApiSyncLoad).
async function creatorSyncLoadMergeTracking(env, auth, data, d1Tracking, trackingRawInit) {
  // Tracking data (Watch History/Continue Watching/etc) also lives in
  // its own key now -- see save-tracking's own comment above for why.
  // Same merge pattern as presets: the client's loadCreatorSync still
  // just reads data.watchHistory/data.continueWatching/etc exactly
  // like before, unaware this is a third KV read.
  const trackingRaw = trackingRawInit;
  if (d1Tracking) {
    if (!data) {
      data = { config: [], collapsedPanels: {}, likedLists: [], updatedAt: Date.now() };
    }
    data.watchHistory = Array.isArray(d1Tracking.watchHistory) ? d1Tracking.watchHistory : [];
    data.continueWatching = Array.isArray(d1Tracking.continueWatching) ? d1Tracking.continueWatching : [];
    data.airingNext = Array.isArray(d1Tracking.airingNext) ? d1Tracking.airingNext : [];
    data.curatedRecommendations = (d1Tracking.curatedRecommendations && typeof d1Tracking.curatedRecommendations === "object")
      ? d1Tracking.curatedRecommendations
      : null;
    data.trackingUpdatedAt = d1Tracking.updatedAt || 0;
    data.trackingClientVersion = Number.isFinite(Number(d1Tracking.clientVersion))
      ? Number(d1Tracking.clientVersion)
      : undefined;
    data.fullyWatchedShowIds = Array.isArray(d1Tracking.fullyWatchedShowIds) ? d1Tracking.fullyWatchedShowIds : [];
    data.dismissedContinueWatching = d1Tracking.dismissedContinueWatching && typeof d1Tracking.dismissedContinueWatching === "object" ? d1Tracking.dismissedContinueWatching : {};
    data.removedAiringNext = d1Tracking.removedAiringNext && typeof d1Tracking.removedAiringNext === "object" ? d1Tracking.removedAiringNext : {};
    data.trackPlayback = typeof d1Tracking.trackPlayback === "boolean" ? d1Tracking.trackPlayback : false;
    data.removeWatchedFromWatchlist = typeof d1Tracking.removeWatchedFromWatchlist === "boolean" ? d1Tracking.removeWatchedFromWatchlist : true;
    data.scrobbleFilterUsers = typeof d1Tracking.scrobbleFilterUsers === "boolean" ? d1Tracking.scrobbleFilterUsers : false;
    data.scrobbleAllowedUsers = typeof d1Tracking.scrobbleAllowedUsers === "string" ? d1Tracking.scrobbleAllowedUsers : "";
    data.scrobbleBlockAnonymous = typeof d1Tracking.scrobbleBlockAnonymous === "boolean" ? d1Tracking.scrobbleBlockAnonymous : false;
    // The newest of the Watchlist's copies, which readCreatorTrackingD1
    // has already chosen -- see readAccountWatchlist. Reading only the
    // tracking record's copy handed this browser an EMPTY Watchlist after
    // any play in Stremio or Plex had emptied that copy.
    data.watchlist = Array.isArray(d1Tracking.watchlist) ? d1Tracking.watchlist : [];
    data.watchlistUpdatedAt = Number(d1Tracking.watchlistUpdatedAt) || 0;
    if (trackingRaw) {
      try {
        const tb = JSON.parse(trackingRaw);
        if (Array.isArray(tb.continueWatching) && tb.continueWatching.length && Array.isArray(data.continueWatching)) {
          const tbCwMap = new Map();
          tb.continueWatching.forEach((it) => {
            if (it && it.id) tbCwMap.set(String(it.id), it);
          });
          data.continueWatching.forEach((it) => {
            if (!it || !it.id) return;
            const tbItem = tbCwMap.get(String(it.id));
            if (tbItem) {
              if (tbItem.isCompanion) it.isCompanion = true;
              if (tbItem.companionType && !it.companionType) it.companionType = tbItem.companionType;
              if (tbItem.companionNote && !it.companionNote) it.companionNote = tbItem.companionNote;
              if (tbItem.companionStoryline && !it.companionStoryline) it.companionStoryline = tbItem.companionStoryline;
              if (tbItem.precedingShowId && !it.precedingShowId) it.precedingShowId = tbItem.precedingShowId;
              if (tbItem.kind && !it.kind) it.kind = tbItem.kind;
              if (tbItem.type && it.type === 'episode' && tbItem.type !== 'episode') it.type = tbItem.type;
            }
          });
        }
      } catch {}
    }
  } else if (trackingRaw) {
    let trackingBlob = null;
    try {
      trackingBlob = JSON.parse(trackingRaw);
    } catch {
      trackingBlob = null;
    }
    if (trackingBlob) {
      if (!data) {
        data = { config: [], collapsedPanels: {}, likedLists: [], updatedAt: Date.now() };
      }
      data.watchHistory = Array.isArray(trackingBlob.watchHistory) ? trackingBlob.watchHistory : [];
      data.continueWatching = Array.isArray(trackingBlob.continueWatching) ? trackingBlob.continueWatching : [];
      // Newest copy, not just this record's -- see readAccountWatchlist.
      const wl = await readAccountWatchlist(env, auth.username, trackingBlob);
      data.watchlist = wl ? wl.items : [];
      data.watchlistUpdatedAt = wl ? wl.updatedAt : 0;
      // Airing Next and the Discover recommendations were stored by
      // save-tracking but never handed back here, so loadCreatorSync's
      // own restore branches for them (22_client-creator-profile.js)
      // could never fire. A browser that signed in fresh therefore had
      // no copy of either, and its first autosave pushed empty arrays
      // straight back over the account's real ones -- see
      // save-tracking's derived-list guard above for the other half of
      // this fix.
      data.airingNext = Array.isArray(trackingBlob.airingNext) ? trackingBlob.airingNext : [];
      data.curatedRecommendations = (trackingBlob.curatedRecommendations && typeof trackingBlob.curatedRecommendations === "object")
        ? trackingBlob.curatedRecommendations
        : null;
      data.trackingUpdatedAt = trackingBlob.updatedAt || 0;
      // The baseline save-tracking's conflict guard compares against --
      // see its own comment. Absent on a record written before that guard
      // existed, and deliberately left undefined rather than 0 in that
      // case: 0 is an opinion, and the wrong one.
      data.trackingClientVersion = Number.isFinite(Number(trackingBlob.clientVersion))
        ? Number(trackingBlob.clientVersion)
        : undefined;
      data.fullyWatchedShowIds = Array.isArray(trackingBlob.fullyWatchedShowIds) ? trackingBlob.fullyWatchedShowIds : [];
      data.dismissedContinueWatching = trackingBlob.dismissedContinueWatching && typeof trackingBlob.dismissedContinueWatching === "object" ? trackingBlob.dismissedContinueWatching : {};
      data.removedAiringNext = trackingBlob.removedAiringNext && typeof trackingBlob.removedAiringNext === "object" ? trackingBlob.removedAiringNext : {};
      data.trackPlayback = typeof trackingBlob.trackPlayback === "boolean" ? trackingBlob.trackPlayback : false;
      data.removeWatchedFromWatchlist = typeof trackingBlob.removeWatchedFromWatchlist === "boolean" ? trackingBlob.removeWatchedFromWatchlist : true;
      data.scrobbleFilterUsers = typeof trackingBlob.scrobbleFilterUsers === "boolean" ? trackingBlob.scrobbleFilterUsers : false;
      data.scrobbleAllowedUsers = typeof trackingBlob.scrobbleAllowedUsers === "string" ? trackingBlob.scrobbleAllowedUsers : "";
      data.scrobbleBlockAnonymous = typeof trackingBlob.scrobbleBlockAnonymous === "boolean" ? trackingBlob.scrobbleBlockAnonymous : false;
    }
  }
  return data;
}

// Merges the scrobble queue into the sync blob when it is ahead of the tracking record (a step of creatorApiSyncLoad).
async function creatorSyncLoadMergeQueue(env, auth, data) {
  // Merge the dedicated scrobble-queue key in, so that recent scrobbles
  // are visible even when the tracking record read above does not have
  // them yet (KV eventual consistency, or a D1 write that failed). Only
  // then: merged unconditionally, it brought back every recent play the
  // owner had removed -- see 56_scrobble-queue.js.
  try {
    const sq = parseScrobbleQueue(await env.CONFIGS.get(`creatorscrobblequeue:${auth.username}`));
    const trackingRecord = data && data.trackingUpdatedAt !== undefined ? { updatedAt: data.trackingUpdatedAt } : null;
    if (scrobbleQueueIsAhead(sq, trackingRecord)) {
      const queueWh = sq.watchHistory;
      const queueCw = sq.continueWatching;
      if (queueWh.length || queueCw.length) {
        if (!data) data = { config: [], collapsedPanels: {}, likedLists: [], updatedAt: Date.now() };
        // This response now reflects the record as of the queue's write,
        // and a later removal is judged against what the browser was
        // shown (scrobblePlaysUnseenBy).
        if (sq.recordUpdatedAt > (Number(data.trackingUpdatedAt) || 0)) data.trackingUpdatedAt = sq.recordUpdatedAt;
        if (queueWh.length) {
          const existingWhIds = new Set((Array.isArray(data.watchHistory) ? data.watchHistory : []).map((it) => String(it && it.id)));
          const queueWhOnly = queueWh.filter((it) => it && it.id && !existingWhIds.has(String(it.id)));
          if (queueWhOnly.length) {
            queueWhOnly.sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0));
            data.watchHistory = [...queueWhOnly, ...(Array.isArray(data.watchHistory) ? data.watchHistory : [])];
          }
        }
        if (queueCw.length) {
          const fullyWatchedSet = new Set(Array.isArray(data.fullyWatchedShowIds) ? data.fullyWatchedShowIds.map(String) : []);
          const mergedCw = [];
          const handledShows = new Set();
          for (const qItem of queueCw) {
            if (qItem && (qItem.showId || qItem.id)) {
              if (scrobbleCwIsFullyWatched(qItem, fullyWatchedSet)) continue;
              mergedCw.push(qItem);
              handledShows.add(String(qItem.showId || qItem.id));
            }
          }
          for (const dItem of (Array.isArray(data.continueWatching) ? data.continueWatching : [])) {
            if (dItem && (dItem.showId || dItem.id)) {
              const dKey = String(dItem.showId || dItem.id);
              if (!handledShows.has(dKey)) {
                mergedCw.push(dItem);
                handledShows.add(dKey);
              }
            }
          }
          data.continueWatching = mergedCw;
        }
      }
    }
  } catch {}
  return data;
}

// /api/creator/sync/like  (POST)  { creatorName, creatorKey, usernameSlug, liked } -> { ok }
// A narrower sibling of sync/save above, just for the likedLists piece
// of the blob -- exists because the standalone public list page
// (/lists/:username/:listname below) has its own tiny like button but
// no access to the rest of a signed-in creator's state (their current
// list config, presets, panel layout aren't loaded there, and
// shouldn't need to be just to record a like). It reads the same
// Creator Name/Key straight out of localStorage as the builder page
// does, since both live on the same origin -- if this browser was
// signed in on the builder, that list page can tell, without any
// separate login of its own. Read-modify-write against whatever's
// already saved (or a fresh blob if this account has never synced)
// rather than requiring the caller to send the full state, unlike
// sync/save.
async function creatorApiSyncLike(request, env, ctx, path) {
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const auth = await authenticateCreatorFor(request, env, ctx, path, body.creatorName, body.creatorKey);
  if (!auth.ok) return authFailureResponse(auth);
  const usernameSlug = String(body.usernameSlug || "").trim();
  if (!usernameSlug) return json({ ok: false, error: "Missing list reference." }, 400);
  const key = `creatorsync:${auth.username}`;
  const raw = await env.CONFIGS.get(key);
  let blob = { config: [], presets: {}, collapsedPanels: {}, likedLists: [], watchHistory: [], continueWatching: [], fullyWatchedShowIds: [], dismissedContinueWatching: {} };
  if (raw) {
    try {
      blob = JSON.parse(raw);
    } catch {
      blob = { config: [], presets: {}, collapsedPanels: {}, likedLists: [], watchHistory: [], continueWatching: [], fullyWatchedShowIds: [], dismissedContinueWatching: {} };
    }
  }
  const set = new Set(Array.isArray(blob.likedLists) ? blob.likedLists : []);
  if (body.liked) set.add(usernameSlug);
  else set.delete(usernameSlug);
  blob.likedLists = [...set];
  blob.updatedAt = Date.now();
  if (env.DB) {
    try {
      if (body.liked) {
        await env.DB.prepare(
          "INSERT OR IGNORE INTO creator_user_lists (username, list_id, list_type, created_at) VALUES (?, ?, 'liked', ?)"
        ).bind(auth.username, usernameSlug, Date.now()).run();
      } else {
        await env.DB.prepare(
          "DELETE FROM creator_user_lists WHERE username = ? AND list_id = ? AND list_type = 'liked'"
        ).bind(auth.username, usernameSlug).run();
      }
    } catch (dbErr) {
      console.error("D1 write error (/api/creator/sync/like):", dbErr);
    }
  }
  await env.CONFIGS.put(key, JSON.stringify(blob));
  return json({ ok: true });
}

// /api/creator/sync/share-tracking  (POST)
//   { creatorName, creatorKey, slug, shared } -> { ok, shared: {...} }
//   { creatorName, creatorKey } (no slug)     -> { ok, shared: {...} }  (read current state)
//
// API-ONLY, deliberately. Nothing in the shipped UI calls this, which the
// 2026-09-08 audit listed under dead code with the note "keep the route,
// add the UI or document it as API-only". Documented: see README's
// "API-only endpoints". It is authenticated and it is the only way to make
// these three shelves public at all, so removing it would remove the
// feature rather than tidy it up.
//
// Owner-controlled opt-in for exposing Watchlist / Watch History /
// Continue Watching at the public /lists/:username/:slug address.
// Those three come out of the private `creatorsynctracking:` blob,
// so they are NOT public by default and there is no way to make them
// public except by an authenticated call here (see the gate in the
// /lists/:username/:listname handler). Stored as its own small key
// rather than inside the tracking blob itself, so that the frequent,
// high-churn tracking writes (playback pings, scrobbles, the cron)
// can never accidentally clobber a privacy setting in a
// read-modify-write race.
async function creatorApiSyncShareTracking(request, env, ctx, path) {
  if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" }, 500);
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const auth = await authenticateCreatorFor(request, env, ctx, path, body.creatorName, body.creatorKey);
  if (!auth.ok) return authFailureResponse(auth);

  const shareKey = `creatorshare:${auth.username}`;
  let shared = {};
  let d1SharedLoaded = false;
  if (env.DB) {
    try {
      const { results } = await env.DB.prepare("SELECT share_json FROM creators WHERE username = ?").bind(auth.username).all();
      if (results && results.length > 0 && results[0].share_json) {
        shared = JSON.parse(results[0].share_json) || {};
        d1SharedLoaded = true;
      }
    } catch (e) {
      console.error("D1 read error (/api/creator/sync/share-tracking):", e);
    }
  }
  if (!d1SharedLoaded && env.CONFIGS) {
    try {
      const raw = await env.CONFIGS.get(shareKey);
      if (raw) shared = JSON.parse(raw) || {};
    } catch {
      shared = {};
    }
  }

  // No slug -> read-only query of the current settings.
  const slug = String(body.slug || "").trim().toLowerCase();
  if (!slug) {
    return json({
      ok: true,
      shared: {
        "watchlist": shared["watchlist"] === true,
        "watch-history": shared["watch-history"] === true,
        "continue-watching": shared["continue-watching"] === true,
      },
    }, 200, { "Cache-Control": "no-store" });
  }

  const ALLOWED_SHARE_SLUGS = new Set(["watchlist", "watch-history", "continue-watching"]);
  if (!ALLOWED_SHARE_SLUGS.has(slug)) {
    return json({ ok: false, error: "That list cannot be shared this way." }, 400);
  }

  // Coerced to a real boolean -- the read side checks === true, so
  // anything else stored here would silently mean "not shared".
  shared[slug] = body.shared === true;
  const shareJson = JSON.stringify(shared);
  if (env.DB) {
    try {
      await env.DB.prepare("UPDATE creators SET share_json = ? WHERE username = ?").bind(shareJson, auth.username).run();
    } catch (dbErr) {
      console.error("D1 write error (/api/creator/sync/share-tracking):", dbErr);
    }
  }
  if (env.CONFIGS) {
    await env.CONFIGS.put(shareKey, shareJson);
  }

  return json({
    ok: true,
    shared: {
      "watchlist": shared["watchlist"] === true,
      "watch-history": shared["watch-history"] === true,
      "continue-watching": shared["continue-watching"] === true,
    },
  }, 200, { "Cache-Control": "no-store" });
}

// POST /api/nuvio-tv/device/code -- generates pairing codes for Nuvio TV Launcher
async function handleNuvioTvDeviceCode(request, env, ctx, url) {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405, corsHeaders());
  const kv = (env && (env.CONFIGS || env["LIST_CACHE"]));
  if (!kv) return json({ ok: false, error: "no-storage" }, 500, corsHeaders());

  const deviceCode = crypto.randomUUID();
  const chars = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let raw = "";
  for (let i = 0; i < 6; i++) {
    raw += chars[bytes[i] % chars.length];
  }
  const userCode = raw.slice(0, 3) + "-" + raw.slice(3);
  const origin = url ? url.origin : "";
  const verificationUrl = `${origin}/?source=nuvio_tv&tv_code=${userCode}`;

  const payload = {
    deviceCode,
    userCode,
    status: "pending",
    createdAt: Date.now()
  };
  const jsonStr = JSON.stringify(payload);
  await kv.put("nuvio_tv_device:" + deviceCode, jsonStr, { expirationTtl: 600 });
  await kv.put("nuvio_tv_code:" + userCode, jsonStr, { expirationTtl: 600 });
  await kv.put("nuvio_tv_code:" + raw, jsonStr, { expirationTtl: 600 });

  return json({ ok: true, deviceCode, userCode, verificationUrl }, 200, corsHeaders());
}

// GET /api/nuvio-tv/device/poll -- polled by Nuvio TV Launcher
async function handleNuvioTvDevicePoll(request, env, ctx, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return json({ ok: false, error: "Method not allowed." }, 405, corsHeaders());
  const deviceCode = (url.searchParams.get("deviceCode") || "").trim();
  if (!deviceCode) return json({ ok: false, error: "Missing deviceCode parameter." }, 400, corsHeaders());
  const kv = (env && (env.CONFIGS || env["LIST_CACHE"]));
  if (!kv) return json({ ok: false, error: "no-storage" }, 500, corsHeaders());

  const raw = await kv.get("nuvio_tv_device:" + deviceCode);
  if (!raw) return json({ ok: false, error: "Device code expired or not found." }, 404, corsHeaders());
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "Malformed device record." }, 500, corsHeaders());
  }

  if (record.status === "authenticated") {
    return json({
      ok: true,
      status: "authenticated",
      installId: record.installId,
      manifestUrl: record.manifestUrl,
      syncUrl: record.syncUrl
    }, 200, { ...corsHeaders(), "Cache-Control": "no-store" });
  }

  return json({ ok: true, status: "pending" }, 200, { ...corsHeaders(), "Cache-Control": "no-store" });
}

// POST /api/nuvio-tv/device/claim -- binds logged-in creator session to TV device
async function handleNuvioTvDeviceClaim(request, env, ctx, url, path) {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405, corsHeaders());
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400, corsHeaders());
  }

  const auth = await authenticateCreatorFor(request, env, ctx, path, body.creatorName, body.creatorKey);
  if (!auth.ok) return authFailureResponse(auth);

  const rawCode = (body.userCode || "").toString().trim().toUpperCase();
  if (!rawCode) return json({ ok: false, error: "Missing userCode." }, 400, corsHeaders());
  const kv = (env && (env.CONFIGS || env["LIST_CACHE"]));
  if (!kv) return json({ ok: false, error: "no-storage" }, 500, corsHeaders());

  let codeRaw = await kv.get("nuvio_tv_code:" + rawCode);
  if (!codeRaw && rawCode.includes("-")) {
    codeRaw = await kv.get("nuvio_tv_code:" + rawCode.replace(/-/g, ""));
  }
  if (!codeRaw && !rawCode.includes("-") && rawCode.length === 6) {
    codeRaw = await kv.get("nuvio_tv_code:" + rawCode.slice(0, 3) + "-" + rawCode.slice(3));
  }
  if (!codeRaw) return json({ ok: false, error: "Invalid or expired user code." }, 404, corsHeaders());

  let record;
  try {
    record = JSON.parse(codeRaw);
  } catch {
    return json({ ok: false, error: "Malformed device record." }, 500, corsHeaders());
  }

  let installToken = auth.username;
  if (env && env.DB) {
    try {
      const acct = await env.DB.prepare(
        "SELECT id FROM accounts WHERE username = ? COLLATE NOCASE LIMIT 1"
      ).bind(auth.username).first();
      if (acct) {
        const inst = await env.DB.prepare(
          "SELECT legacy_cfg_id, token_hash FROM installs WHERE account_id = ? AND revoked_at IS NULL ORDER BY updated_at DESC LIMIT 1"
        ).bind(acct.id).first();
        if (inst) {
          installToken = inst.legacy_cfg_id || inst.token_hash || auth.username;
        }
      }
    } catch {}
  }

  const origin = url ? url.origin : "";
  const manifestUrl = (typeof isV2InstallParam === "function" && isV2InstallParam(installToken))
    ? `${origin}/${installToken}/manifest.json`
    : installToken.length === 43
      ? `${origin}/i/${installToken}/manifest.json`
      : `${origin}/${installToken}/manifest.json`;
  const syncUrl = `${origin}/api/nuvio-tv/sync/${installToken || auth.username}`;

  const updated = {
    ...record,
    status: "authenticated",
    claimedBy: auth.username,
    installId: installToken || auth.username,
    manifestUrl,
    syncUrl,
    claimedAt: Date.now()
  };
  const updatedStr = JSON.stringify(updated);
  await kv.put("nuvio_tv_device:" + record.deviceCode, updatedStr, { expirationTtl: 600 });
  await kv.put("nuvio_tv_code:" + record.userCode, updatedStr, { expirationTtl: 600 });
  const cleanCode = record.userCode.replace(/-/g, "");
  await kv.put("nuvio_tv_code:" + cleanCode, updatedStr, { expirationTtl: 600 });

  return json({ ok: true, installId: updated.installId, manifestUrl, syncUrl }, 200, corsHeaders());
}
