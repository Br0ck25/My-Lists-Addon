// Creator list delete/reorder, account reset/delete and the sync save routes (/api/creator/lists/delete ... /sync/save-tracking), moved out of handleFetch (CQ-01).

// Moved unchanged: each route body is now its own function; the dispatcher keeps each route's
// original path/method test. Every route still authenticates itself, exactly as before, through
// authenticateCreatorFor (62_creator-auth.js).

// /api/creator/lists/delete ... /sync/save-tracking, at their original place after the channel routes. Returns a Response, or null.
async function handleCreatorApiAccountAndSaveRoutes(request, env, ctx, url, path) {
  if (path === "/api/creator/lists/delete" && request.method === "POST") return creatorApiListsDelete(request, env, ctx, path);
  if (path === "/api/creator/lists/reorder" && request.method === "POST") return creatorApiListsReorder(request, env, ctx, path);
  if (path === "/api/creator/account/reset" && request.method === "POST") return creatorApiAccountReset(request, env, ctx, path);
  if (path === "/api/creator/delete-account" && request.method === "POST") return creatorApiDeleteAccount(request, env, ctx, path);
  if (path === "/api/creator/sync/save" && request.method === "POST") return creatorApiSyncSave(request, env, ctx, path);
  if (path === "/api/creator/sync/save-tracking" && request.method === "POST") return creatorApiSyncSaveTracking(request, env, ctx, path);
  return null;
}

// /api/creator/lists/delete  (POST)  { creatorName, creatorKey, slug }
async function creatorApiListsDelete(request, env, ctx, path) {
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const auth = await authenticateCreatorFor(request, env, ctx, path, body.creatorName, body.creatorKey);
  if (!auth.ok) return authFailureResponse(auth);
  const slug = String(body.slug || "");
  if (!slug) return json({ ok: false, error: "Missing slug." }, 400);
  // Shared with /admin/api/delete-creator-list so the two cannot drift --
  // the same lesson purgeCreatorData records about itself. It also drops
  // the like ledger, which this route used to leave behind for whoever
  // next created a list at the same slug to inherit.
  //
  // `ok` is checked rather than assumed. This route used to return
  // { ok: true } unconditionally, so a KV outage on the delete -- or a
  // directory removal that failed -- answered "deleted" while the list
  // stayed live at its public URL and in the directory, with nothing to
  // retry it. See deleteCreatorLists' own comment.
  const removal = await deleteCreatorLists(env, auth.username, [slug]);
  if (!removal.ok) {
    return json({
      ok: false,
      error: "Couldn't finish deleting that list. It may still be visible -- please try again in a moment.",
    }, 500);
  }
  return json({ ok: true });
}

// /api/creator/lists/reorder  (POST)  { creatorName, creatorKey, order: [slug, ...] }
async function creatorApiListsReorder(request, env, ctx, path) {
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const auth = await authenticateCreatorFor(request, env, ctx, path, body.creatorName, body.creatorKey);
  if (!auth.ok) return authFailureResponse(auth);
  // Bounded, and no ":" -- that is the KV key separator, and slugifyServer
  // (which produces every slug this app writes) can only emit
  // [a-z0-9-] within 60 characters anyway. The array itself had no cap
  // at all, so an authenticated caller could park an arbitrarily large
  // value under one key; 5,000 is far above any real account, where the
  // worst case ever observed was 129 records.
  const newOrder = Array.isArray(body.order)
    ? body.order
        .map(String)
        .filter((s) => s.length <= 60 && /^[a-zA-Z0-9._-]+$/.test(s))
        .slice(0, CREATOR_LIST_ORDER_MAX)
    : [];
  // FF_V2_LISTS_ONLY (P3b-9): the order is kept in v2 only.
  if (isV2ListsOnly(env)) {
    try {
      await listsV2WriteOrder(env, auth.username, newOrder);
    } catch (e) {
      console.error("lists v2: reorder failed", e);
      return json({ ok: false, error: "Couldn't save the new order right now. Please try again in a moment." }, 503);
    }
    await bumpCreatorListsStamp(env, auth.username);
    return json({ ok: true, order: newOrder });
  }
  if (env.DB) {
    try {
      const stmts = newOrder.map((slug, idx) =>
        env.DB.prepare("UPDATE creator_lists SET sort_order = ? WHERE id = ?").bind(idx, `${auth.username}:${slug}`)
      );
      if (stmts.length > 0) {
        await env.DB.batch(stmts);
      }
    } catch (dbErr) {
      console.error("D1 write error (/api/creator/lists/reorder):", dbErr);
    }
  }
  await env.CONFIGS.put(`creatorlistorder:${auth.username}`, JSON.stringify({ order: newOrder }));
  // Order is what the dashboard renders in, so a reorder on one device is
  // a visible change on every other one -- and it touches only the order
  // key, which is why the stamp cannot be derived from the list records.
  await bumpCreatorListsStamp(env, auth.username);
  await listsV2MirrorOrder(env, auth.username, newOrder);
  return json({ ok: true, order: newOrder });
}

// /api/creator/account/reset  (POST)  { creatorName, creatorKey, confirm }
//   -> { ok, cleared: { lists, keys } }
// Empties an account back to how it looked the moment it was created,
// WITHOUT deleting the account itself: the creator record, its key hash
// and its recovery answer are all left alone, so the same Creator Name
// and Key keep working and the person stays signed in.
//
// Distinct from /api/creator/delete-account below, which removes the
// profile outright. The two share purgeCreatorData, so they cannot drift
// apart the way they once had -- the paragraph that used to sit here,
// warning that delete-account still named `creatorprofile:` /
// `creatorpresets:` / `creatorchannels:` and so "leaves most of an
// account's data behind", described a state that has not existed since
// both callers were moved onto one function.
async function creatorApiAccountReset(request, env, ctx, path) {
  if (!env || !env.CONFIGS) return json({ ok: false, error: "Database not configured." }, 500);
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const auth = await authenticateCreatorFor(request, env, ctx, path, body.creatorName, body.creatorKey);
  if (!auth.ok) return authFailureResponse(auth);

  // A second, explicit confirmation carried in the request itself. The
  // key alone is enough to authenticate, but this is irreversible and
  // there is no undo, so it should not be reachable by a stray request.
  if (String(body.confirm || "") !== "RESET") {
    return json({ ok: false, error: "Missing confirmation." }, 400);
  }

  // Same sweep as delete-account, minus the identity -- see
  // purgeCreatorData (02_http-and-creator-utils.js). Keeping both
  // callers on one function is what stops the two from drifting apart
  // again the way they had.
  // recordReset asks purgeCreatorData to announce this to the account's
  // other devices -- see its own comment. Only this route sets it: the same
  // sweep runs on delete-account (nothing left to announce to) and as a
  // pre-create purge (nothing was reset).
  const purged = await purgeCreatorData(env, auth.username, { deleteIdentity: false, recordReset: true });
  // A sweep that threw is not a reset. Saying ok:true here would tell
  // someone their account is empty while their lists are still live and
  // still in the public directory.
  if (!purged.ok) {
    return json({
      ok: false,
      error: "Couldn't finish clearing this account. Nothing has been lost -- please try again in a moment.",
      cleared: { lists: purged.listsCleared, keys: purged.keysCleared },
    }, 500);
  }

  // resetAt goes back so THIS device records that it has seen the reset.
  // Without it the browser that performed the reset meets its own, now
  // empty account on the next load and takes the very branch every other
  // device takes: "nothing is stored here, so my copy is the first save".
  return json({
    ok: true,
    cleared: { lists: purged.listsCleared, keys: purged.keysCleared },
    resetAt: purged.resetAt || 0,
  });
}

// /api/creator/delete-account  (POST)  { creatorName, creatorKey } -> { ok }
// Permanently removes the creator profile, their published lists, order, and sync data
async function creatorApiDeleteAccount(request, env, ctx, path) {
  if (!env || !env.CONFIGS) return json({ ok: false, error: "Database not configured." }, 500);
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const auth = await authenticateCreatorFor(request, env, ctx, path, body.creatorName, body.creatorKey);
  if (!auth.ok) return authFailureResponse(auth);

  // A second, explicit confirmation carried in the request itself,
  // matching /api/creator/account/reset. The key alone authenticates,
  // but this is irreversible and there is no undo, so it must not be
  // reachable by a stray or replayed request.
  if (String(body.confirm || "") !== "DELETE") {
    return json({ ok: false, error: "Missing confirmation." }, 400);
  }

  // deleteIdentity: true is the whole difference from account/reset --
  // the profile, the D1 row, and the last-seen marker go too, so the
  // key stops authenticating and the username becomes reclaimable.
  const purged = await purgeCreatorData(env, auth.username, { deleteIdentity: true });
  // Only a purge that actually removed everything, identity included, is
  // a deletion. Anything else leaves the account signed-in-able so its
  // owner can retry, and must say so rather than reporting success --
  // this endpoint used to return ok:true while leaving every list live,
  // public, and attached to a username anyone could then re-register.
  if (!purged.ok) {
    return json({
      ok: false,
      error: "Couldn't finish deleting this account. Nothing has been removed -- please try again in a moment.",
      cleared: { lists: purged.listsCleared, keys: purged.keysCleared },
    }, 500);
  }
  // purgeCreatorData has already removed the accounts row and its sessions;
  // this only tells the browser to drop the cookie.
  if (request.account || request._sessionCookie) {
    request._sessionCookie = buildClearSessionCookieHeader();
  }
  return json({ ok: true, cleared: { lists: purged.listsCleared, keys: purged.keysCleared } });
}

// --- Site-wide account sync ---------------------------------------------
//
// A Creator Profile started out scoped to just publishing/managing
// Custom Lists (the block above). This extends the same account to the
// rest of the builder page too: the person's full list of source rows
// and their order, their saved presets, which panels they'd left
// collapsed, and which lists they'd liked -- so signing in on another
// device or browser picks up where they left off instead of starting
// from a blank page. Still no email/password: the same Creator Name +
// Creator Key from above is all that's needed.
//
// Deliberately a single wholesale blob rather than four separate
// endpoints -- the client always has the complete current picture of
// all four in memory already (collectEntries(), the presets map, the
// collapsed-panel state, and the liked-lists set), so there's no
// partial-update case that actually needs a smaller request, and one
// key is simpler to reason about than keeping four in sync with each
// other.
async function creatorApiSyncSave(request, env, ctx, path) {
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const auth = await authenticateCreatorFor(request, env, ctx, path, body.creatorName, body.creatorKey);
  if (!auth.ok) return authFailureResponse(auth);

  // Same one-time forward migration, this time for tracking data
  // (watchHistory/continueWatching/fullyWatchedShowIds/
  // dismissedContinueWatching/trackPlayback) -- see
  // ensureTrackingMigrated's own comment. Critical to run here
  // specifically: this endpoint is the most frequent write to
  // creatorsync:{username} of any of them (any routine autosave), and
  // the blob built below no longer includes tracking fields at all --
  // without migrating first, the very next autosave after this
  // shipped would silently erase anyone's tracking data before
  // save-tracking ever got a chance to run for them.
  await ensureTrackingMigrated(env, auth.username);

  // One-time forward migration: presets used to live embedded in this
  // same blob, but as of this endpoint no longer accepts them here at
  // all (see /api/creator/sync/save-presets below) -- an updated client
  // never sends body.presets/presetsB64 anymore. Without this check,
  // the very first autosave after updating would overwrite this blob
  // with no presets embedded, and since nothing would have copied the
  // old embedded presets into the dedicated key yet either, they'd be
  // gone. Only runs once per account: after the dedicated key exists
  // (whether from this migration or a real preset save), this block is
  // skipped on every subsequent save.
  const existingPresetsKey = await env.CONFIGS.get(`creatorsyncpresets:${auth.username}`);
  if (existingPresetsKey === null) {
    const oldRaw = await env.CONFIGS.get(`creatorsync:${auth.username}`);
    if (oldRaw) {
      try {
        const oldBlob = JSON.parse(oldRaw);
        if (oldBlob.presetsB64 || (oldBlob.presets && Object.keys(oldBlob.presets).length)) {
          await env.CONFIGS.put(`creatorsyncpresets:${auth.username}`, JSON.stringify({
            presets: (oldBlob.presets && typeof oldBlob.presets === "object") ? oldBlob.presets : {},
            presetsB64: oldBlob.presetsB64 || null,
          }));
        }
      } catch {
        // Old blob was unreadable -- nothing to migrate; whatever's
        // already in the dedicated key (or lack of one) stands as-is.
      }
    }
  }

  // Conflict guard -- this endpoint used to always blindly overwrite
  // creatorsync:{username} with whatever this request's snapshot was,
  // no matter how stale. Two tabs/devices autosaving around the same
  // time meant whichever PUT landed last in KV won completely, silently
  // discarding the other one's edits with no error anywhere.
  //
  // An updated client now sends expectedUpdatedAt: the updatedAt it
  // last actually saw (from a prior /sync/load or /sync/save response)
  // -- i.e. the version its current edits are built on top of. If the
  // record in KV has moved past that, another device saved in between;
  // rather than clobber that write, this responds 409 and leaves KV
  // untouched. The client's own pending edits aren't lost either: they
  // stay in its DOM/localStorage and go up on the very next autosave,
  // now against the correct baseline. An older client that doesn't
  // send expectedUpdatedAt at all gets exactly its previous behavior
  // (last-write-wins) -- this is purely additive, not a breaking
  // change to the request shape.
  // Present-but-malformed is a client error, not a reason to drop the
  // guard -- see parseExpectedUpdatedAt (02_http-and-creator-utils.js).
  const expected = parseExpectedUpdatedAt(body.expectedUpdatedAt);
  if (!expected.ok) {
    return json({ ok: false, error: "expectedUpdatedAt must be a number." }, 400);
  }
  const expectedUpdatedAt = expected.value;
  // Read unconditionally now, because the stamp below has to be strictly
  // newer than whatever is stored, not merely Date.now() -- see
  // nextSyncVersion.
  const currentRaw = await env.CONFIGS.get(`creatorsync:${auth.username}`);
  let currentUpdatedAt = 0;
  let currentKeys = null;
  if (currentRaw) {
    try {
      const current = JSON.parse(currentRaw);
      currentUpdatedAt = Number(current.updatedAt) || 0;
      currentKeys = current.keys && typeof current.keys === "object" ? current.keys : null;
      if (expectedUpdatedAt !== null && currentUpdatedAt > expectedUpdatedAt) {
        // Purely for visibility -- this was previously invisible even
        // to us; now it's at least countable on the admin dashboard.
        ctx.waitUntil(bumpStat(env, "sync_conflict"));
        return json({ ok: false, error: "conflict", conflict: true, updatedAt: current.updatedAt }, 409);
      }
    } catch {
      // Existing blob unreadable -- nothing coherent to protect
      // against; fall through and write normally.
    }
  }

  // A provider credential the request leaves OUT is kept as stored. Since
  // P6-8 a browser holds the account's keys and tokens only in memory,
  // once a load has handed them back; a tab whose load failed omits the
  // ones it does not know instead of sending them blank (see
  // creatorSyncKeysForPush, 22_), because a blank here used to be stored
  // as-is and cost the account every connection. A blank that IS sent
  // still clears the credential: that is what a disconnect sends.
  const incomingKeys = body.keys && typeof body.keys === "object" && !Array.isArray(body.keys) ? body.keys : {};
  const mergedKeys = Object.assign({}, incomingKeys);
  if (currentKeys) {
    for (const field of ["tmdbKey", "tmdbSessionId", "mdblistKey", "mdblistAccessToken", "traktKey", "traktAccessToken", "simklKey", "simklAccessToken"]) {
      if (!Object.prototype.hasOwnProperty.call(incomingKeys, field) && typeof currentKeys[field] === "string" && currentKeys[field]) {
        mergedKeys[field] = currentKeys[field];
      }
    }
  }

  const blob = {
    config: Array.isArray(body.config) ? body.config : [],
    keys: mergedKeys,
    collapsedPanels: body.collapsedPanels && typeof body.collapsedPanels === "object" ? body.collapsedPanels : {},
    likedLists: Array.isArray(body.likedLists) ? body.likedLists.map(String) : [],
    hiddenLists: Array.isArray(body.hiddenLists) ? body.hiddenLists.map(String) : [],
    hiddenMyListsSections: Array.isArray(body.hiddenMyListsSections) ? body.hiddenMyListsSections.map(String) : [],
    updatedAt: nextSyncVersion(currentUpdatedAt),
  };
  const serialized = JSON.stringify(blob);
  // Workers KV hard-caps a value at 25MB. Presets/Channels and tracking
  // data (watchHistory/continueWatching/etc) no longer live in this
  // blob at all (see above), so this is now just a defensive backstop
  // rather than the main thing it used to guard against.
  if (serialized.length > 24 * 1024 * 1024) {
    return json({ ok: false, error: "This account's saved data is too large to store (over the 25MB limit)." });
  }
  if (env.DB) {
    await saveCreatorUserListsD1(env, auth.username, blob.likedLists, blob.hiddenLists, blob.hiddenMyListsSections);
  }
  try {
    await env.CONFIGS.put(`creatorsync:${auth.username}`, serialized);
  } catch (e) {
    // A real KV failure (rate limit, transient error, etc.) previously
    // surfaced to the client as nothing more than a failed fetch --
    // this at least tells the person something specific went wrong
    // server-side rather than leaving "check your connection" as the
    // only explanation, which is misleading when the connection was
    // never the problem.
    return json({ ok: false, error: "Could not save to storage right now. Please try again in a moment." }, 500);
  }
  // updatedAt lets the client advance its own baseline without a
  // separate /sync/meta round trip -- see expectedUpdatedAt above.
  return json({ ok: true, updatedAt: blob.updatedAt });
}

// /api/creator/sync/save-tracking  (POST)  { creatorName, creatorKey,
// watchHistory, continueWatching, fullyWatchedShowIds,
// dismissedContinueWatching, trackPlayback } -> { ok }
// The dedicated, lightweight sibling of /api/creator/sync/save for
// Watch History / Continue Watching tracking data -- split out for the
// same reason presets were (see save-presets' own comment just below):
// watchHistory in particular can grow into the thousands of items for
// an active account (e.g. a bulk "mark as watched" import), and it used
// to ride along in the same blob as config/collapsedPanels/likedLists,
// making EVERY routine autosave -- and every single Auto-Track Playback
// ping (handleSubtitlesTrack, further down this file), which fires on
// every video play -- re-send and re-process the whole thing. Also read
// by the Continue Watching cron (checkForNewEpisodes) and
// fetchAutoTrackedCatalog (what Stremio/wako actually see for the
// Watch History/Continue Watching catalog rows) -- if this never
// successfully saves (e.g. it silently failed under the old combined
// blob's size), those rows show "No items found" even though the
// browser's own local copy looks complete.
async function creatorApiSyncSaveTracking(request, env, ctx, path) {
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const auth = await authenticateCreatorFor(request, env, ctx, path, body.creatorName, body.creatorKey);
  if (!auth.ok) return authFailureResponse(auth);
  const watchlistUpdatedAt = Number(body.watchlistUpdatedAt) || Date.now();

  // The stored record, read once: the conflict guard immediately below
  // and the scrobble merge further down both need it, and it used to be
  // read only inside the merge.
  const existingBlob = await creatorTrackingReadExisting(env, auth);

  // Conflict guard, the same one /api/creator/sync/save has carried for a
  // while -- this endpoint had none, and it is the endpoint that overwrites
  // Watch History and Continue Watching wholesale.
  //
  // Two devices signed into one account is the ordinary case here: change
  // something on the desktop, open the phone, and the phone's own stale
  // snapshot went up as the full current state with nothing to stop it.
  // The scrobble merge below cannot help -- it only ever RESCUES items the
  // stored record has and the push does not, which is precisely what makes
  // it re-add whatever another device just removed.
  //
  // Guarded on a dedicated clientVersion rather than on updatedAt, because
  // updatedAt also moves for writes no browser made: a scrobble ping
  // (handleSubtitlesTrack, handleMediaServerScrobble) and the Continue
  // Watching cron both rewrite this record. Rejecting a browser because a
  // scrobble landed would 409 constantly during ordinary playback, which
  // the merge already handles correctly. clientVersion moves only when a
  // browser saves here, so it answers exactly the question the guard is
  // asking: has another BROWSER replaced this state since the one I built
  // my copy on? Those other writers read-modify-write the parsed blob, so
  // the field survives them; a record written before this existed has no
  // clientVersion at all, which reads as "no opinion" and behaves exactly
  // as this endpoint did before.
  const expectedClient = parseExpectedUpdatedAt(body.expectedClientVersion);
  if (!expectedClient.ok) {
    return json({ ok: false, error: "expectedClientVersion must be a number." }, 400);
  }
  const storedClientVersion = existingBlob && Number.isFinite(Number(existingBlob.clientVersion))
    ? Number(existingBlob.clientVersion)
    : null;
  if (expectedClient.value !== null && storedClientVersion !== null && storedClientVersion > expectedClient.value) {
    ctx.waitUntil(bumpStat(env, "sync_conflict"));
    return json({
      ok: false,
      error: "conflict",
      conflict: true,
      clientVersion: storedClientVersion,
      updatedAt: Number(existingBlob.updatedAt) || 0,
    }, 409);
  }

  // Guard against a narrow but real race: handleSubtitlesTrack and
  // handleMediaServerScrobble both read-modify-write this same KV key
  // directly and outside of any request this browser initiated, so a
  // scrobble can land *between* this browser's last load and this
  // push. Since this endpoint's whole design is "always the full
  // current list" (see pushTrackingSync's own comment -- deliberate,
  // so Clear Watch History and per-item removal both work by just
  // sending a shorter array), a stale client push would otherwise
  // silently erase whatever a scrobble just added.
  //
  // Rather than merging the *entire* history (which would make Clear
  // Watch History and per-item removal impossible to ever fully commit
  // -- the deleted item would just come back on the next autosave),
  // only rescue items added by a scrobble ping inside a short recency
  // window right before this push, and skip the rescue entirely when
  // the client flags this push as an intentional removal (Clear Watch
  // History, deleting a single item) -- see pushTrackingSync's
  // intentionalRemoval comment. That's the one case a stale client
  // snapshot can plausibly be missing something real; anything older
  // than that the client's own load would already have picked up.
  // Always merge server KV state with incoming client state to preserve
  // any scrobbles written by handleSubtitlesTrack or handleMediaServerScrobble
  // that landed between this browser's last load and this push.
  //
  // We cannot gate this on the diagnostic timestamp because handleSubtitlesTrack
  // runs inside ctx.waitUntil (async after the response is sent), so the
  // diagnostic write may arrive AFTER save-tracking has already run -- which
  // was silently wiping every scrobble.
  //
  // Strategy: read KV directly, find any watchHistory items with a watchedAt
  // timestamp newer than body.watchHistory's newest item (i.e. added by the
  // server after the client's last load) and prepend them. Same for
  // continueWatching: show IDs in KV but not in the incoming body are
  // preserved at the front. Skip the merge only for intentionalRemoval.
  let rescuedCount = 0;
  if (!body.intentionalRemoval) {
    rescuedCount = creatorTrackingRescueFromStored(body, existingBlob, rescuedCount);
    rescuedCount = await creatorTrackingRescueFromQueue(env, auth, body, existingBlob, rescuedCount);
  } else {
    rescuedCount = await creatorTrackingRescueUnseen(env, auth, body, existingBlob, rescuedCount);
  }

  const blob = creatorTrackingBuildBlob(body, watchlistUpdatedAt, existingBlob, storedClientVersion);
  // With FF_EVENT_TRACKING the record goes to the activity database
  // (40_event-tracking.js), which needs to know that entries left out
  // were removed on purpose. Never stored.
  const serialized = JSON.stringify(body.intentionalRemoval && isEventTrackingEnabled(env) ? { ...blob, _intentionalRemoval: true } : blob);
  if (serialized.length > 24 * 1024 * 1024) {
    return json({ ok: false, error: "Your Watch History is too large to store (over the 25MB limit)." });
  }
  const persistFailed = await creatorTrackingPersist(env, auth, blob, serialized, body);
  if (persistFailed) return persistFailed;
  try {
    if (Array.isArray(body.watchlist)) {
      const wlTooLarge = await creatorTrackingWriteWatchlist(env, auth, body, watchlistUpdatedAt);
      if (wlTooLarge) return wlTooLarge;
    }
  } catch (e) {
    // The activity database is not bound: the outer boundary answers 503.
    if (e && e.code === EVENT_TRACKING_UNAVAILABLE) throw e;
    return json({ ok: false, error: "Could not save to storage right now. Please try again in a moment." }, 500);
  }
  // clientVersion goes back so the browser can advance its baseline from
  // the save itself, without a /sync/load round trip in between -- exactly
  // what sync/save returns updatedAt for.
  return json({ ok: true, rescuedFromScrobble: rescuedCount, clientVersion: blob.clientVersion });
}

// Writes the tracking record to KV and D1. Returns a Response when it did not land, else null (a step of creatorApiSyncSaveTracking).
async function creatorTrackingPersist(env, auth, blob, serialized, body) {
  // A D1 write that did not land must not be reported as a save.
  //
  // saveCreatorTrackingD1 returns false on failure and that value was
  // dropped on the floor, so this route answered ok:true with a new
  // clientVersion whatever happened. D1 is what /api/creator/sync/load and
  // every personal catalog row read FIRST, so the account then served the
  // pre-save state -- and the browser, told the push succeeded, advanced its
  // baseline (saveSyncBaselines) and recorded the pushed stamps
  // (recordTrackingLocalBaseline). On the next load shouldLocalOnlyTracking
  // therefore judged its own unsaved items stale and dropped them. A
  // transient D1 error turned into permanent, silent data loss, with a
  // console line the only trace.
  //
  // KV is written first and kept either way: it holds the only surviving
  // copy of this push, which is what getCreatorList's kvIsFresher repair
  // exists to recover from on the list side. Then the failure is reported,
  // so the browser keeps its copy and retries.
  let trackingD1Ok = true;
  try {
    await env.CONFIGS.put(`creatorsynctracking:${auth.username}`, serialized);
  } catch (e) {
    // The activity database is not bound: the outer boundary answers 503.
    if (e && e.code === EVENT_TRACKING_UNAVAILABLE) throw e;
    return json({ ok: false, error: "Could not save to storage right now. Please try again in a moment." }, 500);
  }
  if (env.DB) {
    trackingD1Ok = await saveCreatorTrackingD1(env, auth.username, blob, !!body.intentionalRemoval);
  }
  if (!trackingD1Ok) {
    return json({
      ok: false,
      error: "Could not save your Watch History right now. Your changes are still here -- please try again in a moment.",
    }, 500);
  }
  return null;
}

// The stored tracking record, D1 first and KV as the fallback (a step of creatorApiSyncSaveTracking).
async function creatorTrackingReadExisting(env, auth) {
  let existingBlob = null;
  if (env.DB) {
    existingBlob = await readCreatorTrackingD1(env, auth.username);
  }
  if (!existingBlob) {
    try {
      const existingRaw = await env.CONFIGS.get(`creatorsynctracking:${auth.username}`);
      if (existingRaw) existingBlob = JSON.parse(existingRaw);
    } catch {
      existingBlob = null;
    }
  }
  return existingBlob;
}

// The rescue merge from the stored record: plays and rows the browser's copy lacks are put back (a step of creatorApiSyncSaveTracking).
// Returns the running count of rescued plays.
async function creatorTrackingRescueFromStored(body, existingBlob, rescuedCount) {
  try {
    if (existingBlob) {
      // Watch History: find server items not present in the incoming payload
      const incomingIds = new Set(
        (Array.isArray(body.watchHistory) ? body.watchHistory : []).map((it) => String(it && it.id))
      );
      const serverOnlyItems = (Array.isArray(existingBlob.watchHistory) ? existingBlob.watchHistory : [])
        .filter((it) => it && it.id && !incomingIds.has(String(it.id)));
      if (serverOnlyItems.length) {
        // Sort server-only items newest-first and prepend them
        serverOnlyItems.sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0));
        body.watchHistory = [...serverOnlyItems, ...(Array.isArray(body.watchHistory) ? body.watchHistory : [])];
        rescuedCount = serverOnlyItems.length;
      }

      // Continue Watching: when scrobbles occur on the server (Nuvio / Plex),
      // the server computes the next episode and updates existingBlob.continueWatching.
      // If the server has a show in continueWatching, its version must take precedence
      // over the client's stale incoming item for that same show!
      const serverCwList = Array.isArray(existingBlob.continueWatching) ? existingBlob.continueWatching : [];
      if (serverCwList.length) {
        const incomingCwList = Array.isArray(body.continueWatching) ? body.continueWatching : [];
        const mergedCw = [];
        const handledShows = new Set();
        const fullyWatchedSet = new Set([
          ...(Array.isArray(body.fullyWatchedShowIds) ? body.fullyWatchedShowIds.map(String) : []),
          ...(Array.isArray(existingBlob.fullyWatchedShowIds) ? existingBlob.fullyWatchedShowIds.map(String) : [])
        ]);

        // Server's updated Continue Watching items come first, but NEVER resurrect fully watched shows!
        for (const sItem of serverCwList) {
          if (sItem && (sItem.showId || sItem.id)) {
            const sKey = String(sItem.showId || sItem.id);
            const baseKey = trackingShowKey(sKey);
            if (!sItem.isCompanion && (fullyWatchedSet.has(sKey) || fullyWatchedSet.has(baseKey) || (sItem.showId && fullyWatchedSet.has(String(sItem.showId))))) {
              continue;
            }
            mergedCw.push(sItem);
            handledShows.add(sKey);
            if (baseKey) handledShows.add(baseKey);
          }
        }
        // Add any client-only Continue Watching shows that aren't on the server
        for (const cItem of incomingCwList) {
          if (cItem && (cItem.showId || cItem.id)) {
            const cKey = String(cItem.showId || cItem.id);
            const baseKey = trackingShowKey(cKey);
            if (!handledShows.has(cKey) && !handledShows.has(baseKey)) {
              mergedCw.push(cItem);
              handledShows.add(cKey);
              if (baseKey) handledShows.add(baseKey);
            }
          }
        }
        body.continueWatching = mergedCw;
      }

      // Airing Next and the Discover recommendations are DERIVED
      // lists: a browser only has them once it has computed them
      // (refreshAiringNext, and opening the Discover tab). A browser
      // that has not done that yet still pushes the full tracking
      // payload on its first autosave, with those two fields empty
      // -- and since this endpoint is "always the full current
      // list", that empty array used to overwrite a perfectly good
      // one another browser had already computed. The catalog row
      // reading it (fetchAutoTrackedCatalog / fetchCuratedCatalog)
      // then served nothing, which is what "No items found" in the
      // Live Preview actually was.
      //
      // So: an empty incoming derived list never replaces a
      // non-empty stored one. Deliberately shrinking one still
      // works -- a real change sends a non-empty array, and an
      // intentional clear (Clear Watch History) sets
      // intentionalRemoval and skips this whole block.
      if ((!Array.isArray(body.airingNext) || !body.airingNext.length) &&
          Array.isArray(existingBlob.airingNext) && existingBlob.airingNext.length) {
        body.airingNext = existingBlob.airingNext;
      }
      const incomingRecs = body.curatedRecommendations;
      const incomingRecsEmpty = !incomingRecs || typeof incomingRecs !== "object" ||
        ((!Array.isArray(incomingRecs.movies) || !incomingRecs.movies.length) &&
         (!Array.isArray(incomingRecs.shows) || !incomingRecs.shows.length));
      const storedRecs = existingBlob.curatedRecommendations;
      const storedRecsPresent = storedRecs && typeof storedRecs === "object" &&
        ((Array.isArray(storedRecs.movies) && storedRecs.movies.length) ||
         (Array.isArray(storedRecs.shows) && storedRecs.shows.length));
      if (incomingRecsEmpty && storedRecsPresent) {
        body.curatedRecommendations = storedRecs;
      }

      // The watchlist is the one array in this payload that had
      // neither a merge nor an empty-guard, and it overwrites two
      // records: the tracking blob AND creatorlist:{user}:watchlist
      // (in KV and D1). pushTrackingSync always sends the browser's
      // full local copy, so a second device that has not finished
      // loading -- or one whose localStorage was cleared -- pushed an
      // empty array and the account's Watchlist was gone from
      // everywhere at once.
      //
      // Same rule the derived lists just above already use: an empty
      // incoming array never replaces a non-empty stored one. A real
      // change still sends a non-empty array, and a deliberate clear
      // sets intentionalRemoval and skips this whole block -- which is
      // exactly the distinction that field exists to draw.
      if ((!Array.isArray(body.watchlist) || !body.watchlist.length) &&
          Array.isArray(existingBlob.watchlist) && existingBlob.watchlist.length) {
        body.watchlist = existingBlob.watchlist;
        // Keep the stamp with the data it belongs to, or the record
        // would claim this browser's clock for someone else's items.
        if (Number(existingBlob.watchlistUpdatedAt)) {
          body.watchlistUpdatedAt = Number(existingBlob.watchlistUpdatedAt);
        }
      }

      // fullyWatchedShowIds: union
      if (Array.isArray(existingBlob.fullyWatchedShowIds) && existingBlob.fullyWatchedShowIds.length) {
        const incomingFW = new Set(Array.isArray(body.fullyWatchedShowIds) ? body.fullyWatchedShowIds.map(String) : []);
        for (const sid of existingBlob.fullyWatchedShowIds) {
          if (!incomingFW.has(String(sid))) {
            body.fullyWatchedShowIds = body.fullyWatchedShowIds || [];
            body.fullyWatchedShowIds.push(sid);
          }
        }
      }
    }
  } catch (e) {
    // Merge is best-effort -- never block the save over it. It is logged
    // because a failure here means plays were not put back (BA-008).
    console.error("/api/creator/sync/save-tracking: the rescue merge from the stored record failed", e);
  }
  return rescuedCount;
}

// The secondary rescue merge, from the scrobble queue key (a step of creatorApiSyncSaveTracking).
async function creatorTrackingRescueFromQueue(env, auth, body, existingBlob, rescuedCount) {
  // SECONDARY MERGE: the dedicated scrobble-queue key. It is written by
  // both scrobble paths right after the tracking record and is tiny
  // (≤20 items), so it covers the case where the record read above
  // does not have the latest plays yet. Only then: a record at least as
  // new as the queue already holds them, or has had them removed on
  // purpose since -- see 56_scrobble-queue.js.
  try {
    const queue = parseScrobbleQueue(await env.CONFIGS.get(`creatorscrobblequeue:${auth.username}`));
    if (scrobbleQueueIsAhead(queue, existingBlob)) {
      const queueWh = queue.watchHistory;
      const queueCw = queue.continueWatching;
      if (queueWh.length) {
        const currentIds = new Set(
          (Array.isArray(body.watchHistory) ? body.watchHistory : []).map((it) => String(it && it.id))
        );
        const queueOnly = queueWh.filter((it) => it && it.id && !currentIds.has(String(it.id)));
        if (queueOnly.length) {
          queueOnly.sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0));
          body.watchHistory = [...queueOnly, ...(Array.isArray(body.watchHistory) ? body.watchHistory : [])];
          rescuedCount += queueOnly.length;
        }
      }
      if (queueCw.length) {
        const fullyWatchedSet = new Set([
          ...(Array.isArray(body.fullyWatchedShowIds) ? body.fullyWatchedShowIds.map(String) : []),
          ...(existingBlob && Array.isArray(existingBlob.fullyWatchedShowIds) ? existingBlob.fullyWatchedShowIds.map(String) : [])
        ]);
        const mergedCw = [];
        const handledShows = new Set();
        for (const qItem of queueCw) {
          if (qItem && (qItem.showId || qItem.id)) {
            const qKey = String(qItem.showId || qItem.id);
            const baseKey = trackingShowKey(qKey);
            if (!qItem.isCompanion && (fullyWatchedSet.has(qKey) || fullyWatchedSet.has(baseKey) || (qItem.showId && fullyWatchedSet.has(String(qItem.showId))))) {
              continue;
            }
            mergedCw.push(qItem);
            handledShows.add(qKey);
            if (baseKey) handledShows.add(baseKey);
          }
        }
        for (const bItem of (Array.isArray(body.continueWatching) ? body.continueWatching : [])) {
          if (bItem && (bItem.showId || bItem.id)) {
            const bKey = String(bItem.showId || bItem.id);
            const baseKey = trackingShowKey(bKey);
            if (!handledShows.has(bKey) && !handledShows.has(baseKey)) {
              mergedCw.push(bItem);
              handledShows.add(bKey);
              if (baseKey) handledShows.add(baseKey);
            }
          }
        }
        body.continueWatching = mergedCw;
      }
    }
  } catch (e) {
    // Best-effort, but logged (BA-008).
    console.error("/api/creator/sync/save-tracking: the rescue merge from the scrobble queue failed", e);
  }
  return rescuedCount;
}

// The intentional-removal path: only plays the stored copy has not seen are put back (a step of creatorApiSyncSaveTracking).
async function creatorTrackingRescueUnseen(env, auth, body, existingBlob, rescuedCount) {
  // An intentional removal skips both merges above: it is the browser
  // saying "exactly this". Except for plays a scrobble recorded after
  // that browser last loaded the account, which it cannot have meant to
  // remove because it never had them -- see scrobblePlaysUnseenBy.
  // Those, and the Continue Watching entry the same scrobble computed
  // for the show, are kept.
  try {
    const queue = parseScrobbleQueue(await env.CONFIGS.get(`creatorscrobblequeue:${auth.username}`));
    const incomingWh = Array.isArray(body.watchHistory) ? body.watchHistory : [];
    const unseen = scrobblePlaysUnseenBy(
      queue,
      existingBlob,
      body.baseTrackingUpdatedAt,
      new Set(incomingWh.map((it) => String(it && it.id)))
    );
    if (unseen.length) {
      body.watchHistory = [...unseen, ...incomingWh];
      rescuedCount = unseen.length;
      const fullyWatchedSet = new Set(Array.isArray(body.fullyWatchedShowIds) ? body.fullyWatchedShowIds.map(String) : []);
      const unseenShows = new Set(unseen.filter((it) => it.showId).map((it) => trackingShowKey(it.showId)));
      const storedCw = Array.isArray(existingBlob.continueWatching) ? existingBlob.continueWatching : [];
      const keptCw = storedCw.filter((it) => it && it.showId &&
        unseenShows.has(trackingShowKey(it.showId)) &&
        !scrobbleCwIsFullyWatched(it, fullyWatchedSet));
      if (keptCw.length) {
        const keptShows = new Set(keptCw.map((it) => trackingShowKey(it.showId)));
        const incomingCw = Array.isArray(body.continueWatching) ? body.continueWatching : [];
        body.continueWatching = [
          ...keptCw,
          ...incomingCw.filter((it) => !(it && it.showId && keptShows.has(trackingShowKey(it.showId)))),
        ];
      }
    }
  } catch {
    // Best-effort, like the merges above.
  }
  return rescuedCount;
}

// The tracking record about to be stored, built from the request and the stored copy (a step of creatorApiSyncSaveTracking).
function creatorTrackingBuildBlob(body, watchlistUpdatedAt, existingBlob, storedClientVersion) {
  const blob = {
    watchHistory: Array.isArray(body.watchHistory) ? body.watchHistory : [],
    continueWatching: Array.isArray(body.continueWatching) ? body.continueWatching : [],
    watchlist: Array.isArray(body.watchlist) ? body.watchlist : [],
    watchlistUpdatedAt: watchlistUpdatedAt,
    // Airing Next -- unlike watchHistory/continueWatching, this is
    // purely derived (recomputed client-side against TMDB on a timer,
    // see refreshAiringNext, 21_client-custom-list-builder.js), so
    // there's nothing to migrate from an older creatorsync: blob the
    // way ensureTrackingMigrated handles the other tracking fields --
    // it just starts empty on an account that hasn't pushed one yet,
    // same as a brand new field always would.
    airingNext: Array.isArray(body.airingNext) ? body.airingNext : [],
    // The Discover tab's Recommended Movies/Shows lists, exactly as
    // that tab rendered them. Pushed rather than recomputed for the
    // same reason airingNext is: fetchCuratedCatalog
    // (05_catalog-core.js) cannot see the browser-side inputs the
    // card is built from, so the only way the catalog row and the
    // card can hold the same items is for the browser to hand the
    // server the list it actually showed.
    curatedRecommendations: (body.curatedRecommendations && typeof body.curatedRecommendations === "object")
      ? {
          movies: Array.isArray(body.curatedRecommendations.movies) ? body.curatedRecommendations.movies : [],
          shows: Array.isArray(body.curatedRecommendations.shows) ? body.curatedRecommendations.shows : [],
          updatedAt: Number(body.curatedRecommendations.updatedAt) || Date.now(),
        }
      : null,
    fullyWatchedShowIds: Array.isArray(body.fullyWatchedShowIds) ? body.fullyWatchedShowIds.map(String) : [],
    dismissedContinueWatching: body.dismissedContinueWatching && typeof body.dismissedContinueWatching === "object" ? body.dismissedContinueWatching : {},
    // Shows taken off Airing Next, each mapped to the watched episode the
    // removal was made at -- the account's copy of what removeAiringNextShow
    // recorded (21_client-custom-list-builder.js). Unlike airingNext itself
    // this is not derived: no browser can recompute it, so losing it means
    // every device puts the removed shows straight back.
    //
    // A push that does not carry the field at all (an older browser) has
    // no opinion about removals rather than saying there are none, so the
    // stored set is carried forward. Defaulting it to {} here would erase
    // the account's removals on the first autosave from such a browser --
    // and would erase them in D1 too, since what this route hands
    // saveCreatorTrackingD1 is this blob, not the raw body.
    removedAiringNext: (body.removedAiringNext && typeof body.removedAiringNext === "object")
      ? body.removedAiringNext
      : ((existingBlob && existingBlob.removedAiringNext && typeof existingBlob.removedAiringNext === "object")
          ? existingBlob.removedAiringNext
          : {}),
    trackPlayback: typeof body.trackPlayback === "boolean" ? body.trackPlayback : false,
    removeWatchedFromWatchlist: typeof body.removeWatchedFromWatchlist === "boolean" ? body.removeWatchedFromWatchlist : true,
    scrobbleFilterUsers: typeof body.scrobbleFilterUsers === "boolean" ? body.scrobbleFilterUsers : false,
    scrobbleAllowedUsers: typeof body.scrobbleAllowedUsers === "string" ? body.scrobbleAllowedUsers : "",
    scrobbleBlockAnonymous: typeof body.scrobbleBlockAnonymous === "boolean" ? body.scrobbleBlockAnonymous : false,
    // Bumped only here, and strictly increasing for the same reason
    // /api/creator/sync/save's version is (see nextSyncVersion): two saves
    // inside one frozen Workers millisecond must not be able to claim the
    // same version, or the guard above cannot tell them apart. This is the
    // baseline a browser cites as expectedClientVersion.
    clientVersion: nextSyncVersion(storedClientVersion || 0),
    updatedAt: Date.now(),
  };
  return blob;
}

// Mirrors the pushed watchlist into the Watchlist list record. Returns a Response when it is too large, else null (a step of creatorApiSyncSaveTracking).
async function creatorTrackingWriteWatchlist(env, auth, body, watchlistUpdatedAt) {
  // With FF_V2_LISTS_ONLY (P3b-9) the Watchlist is read and written in
  // v2, like every other list.
  const wlOnly = isV2ListsOnly(env);
  const wlAccount = wlOnly ? await listsV2Account(env, auth.username) : null;
  if (wlOnly && !wlAccount) throw new Error("lists v2: no account for " + auth.username);
  const wlRaw = wlOnly ? await listsV2GetRecordRaw(env, wlAccount, "watchlist") : await getCreatorList(env, auth.username, "watchlist");
  let wlObj = null;
  if (wlRaw) {
    try {
      wlObj = JSON.parse(wlRaw);
    } catch {}
  }
  if (!wlObj) {
    wlObj = {
      name: "Watchlist",
      slug: "watchlist",
      type: "mixed",
      isWatchlist: true,
      visibility: "private",
      createdAt: Date.now(),
    };
  }
  wlObj.items = body.watchlist;
  wlObj.updatedAt = watchlistUpdatedAt;
  // Same D1 row-size reasoning as /api/creator/lists/save: a
  // watchlist over the ceiling cannot be mirrored, and a mirror that
  // silently stops is how a missing D1 row comes about. Measured in
  // bytes for the same reason it is there.
  if (utf8ByteLength(JSON.stringify(wlObj.items || [])) > CREATOR_LIST_BYTES_MAX) {
    return json({ ok: false, error: "Your Watchlist is too large to store. Try removing some items." }, 413);
  }

  if (wlOnly) {
    // A new one goes first, as the legacy order put it. A failure
    // answers 500 below, so the browser keeps its copy and retries.
    await listsV2WriteRecord(env, wlAccount, "watchlist", wlObj);
    await bumpCreatorListsStamp(env, auth.username);
  } else {
    if (env.DB) {
      try {
        const listId = `${auth.username}:watchlist`;
        const itemsJson = JSON.stringify(wlObj.items || []);
        // Carries `likes` on the INSERT for the same reason the
        // creator-list save above does -- a Watchlist is private by
        // default but nothing stops one being shared and liked.
        await env.DB.prepare(
          "INSERT INTO creator_lists (id, username, name, type, visibility, items_json, likes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type, visibility=excluded.visibility, items_json=excluded.items_json, updated_at=excluded.updated_at"
        ).bind(listId, auth.username, wlObj.name, wlObj.type, wlObj.visibility, itemsJson, wlObj.likes || 0, wlObj.createdAt, wlObj.updatedAt).run();
      } catch (dbErr) {
        console.error("D1 write error (creatorlist watchlist):", dbErr);
      }
    }

    // Unconditional -- see the creatorlist put above.
    await env.CONFIGS.put(`creatorlist:${auth.username}:watchlist`, JSON.stringify(wlObj));

    const orderRaw = await env.CONFIGS.get(`creatorlistorder:${auth.username}`);
    let order = [];
    try { order = orderRaw ? JSON.parse(orderRaw).order || [] : []; } catch {}
    if (!order.includes("watchlist")) {
      order.unshift("watchlist");
      await env.CONFIGS.put(`creatorlistorder:${auth.username}`, JSON.stringify({ order }));
    }
    // The Watchlist is a creatorlist: record like any other and shows on
    // the same dashboard, so adding to it here counts as a list change.
    await bumpCreatorListsStamp(env, auth.username);
    // Its v2 copy too (34_lists-v2-bridge.js): reads of the Watchlist
    // stay on the legacy store, but a shared one is in the directory.
    await listsV2MirrorLists(env, auth.username, ["watchlist"]);
  }
  return null;
}
