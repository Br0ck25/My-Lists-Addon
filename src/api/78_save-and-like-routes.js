// /api/resolve, /api/save, /api/list-live/save, list likes and the title details routes, moved out of handleFetch (CQ-01).

// Moved unchanged: each route body is now its own function; the dispatcher keeps each route's
// original path/method test and is a plain function that returns a Response promise or null.
// Saves and likes authenticate through authenticateCreatorFor (62_creator-auth.js).

// /api/resolve, /api/save, /api/list-live/save, /api/lists/like, /api/lists/like-external, /api/details/batch and /api/details, at their original place. Returns a Response promise, or null.
function handleSaveAndLikeRoutes(request, env, ctx, url, path) {
  if (path === "/api/resolve") return apiResolve(env, url);
  if (path === "/api/save" && request.method === "POST") return apiSave(request, env, ctx, path);
  if (path === "/api/list-live/save" && request.method === "POST") return apiListLiveSave(request, env, ctx);
  if (path === "/api/lists/like" && request.method === "POST") return apiListsLike(request, env, ctx, path);
  if (path === "/api/lists/like-external" && request.method === "POST") return apiListsLikeExternal(request, env, ctx, path);
  if (path === "/api/details/batch" && request.method === "POST") return apiDetailsBatch(request, env, ctx);
  if (path === "/api/details") return apiDetails(request, env, ctx, url);
  return null;
}

// /api/resolve?config=...
// -> powers "Import from a link" in the builder page. Reuses the same
// resolveConfig() the manifest/configure routes already use (handles
// both a short KV id and a legacy self-contained base64 blob), just
// returned as plain JSON instead of a manifest or an HTML page -- so
// pasting an existing install/configure link can rebuild the same rows
// client-side via addRow(), the same way importing a config JSON blob
// does.
async function apiResolve(env, url) {
  const config = url.searchParams.get("config") || "";
  if (!config) return json({ ok: false, error: "Missing config." }, 400);
  try {
    const resData = await resolveConfig(config, env, { withTracking: true });
    const { entries, traktUsername, watchHistory, continueWatching, watchlist, airingNext } = resData;
    if (!entries || !entries.length) return json({ ok: false, error: "That link has no lists in it." });
    // No provider keys or tokens. This used to hand back the link's MDBList
    // key and Trakt/MDBList OAuth tokens, so "Import from link" connected
    // whoever pasted a link to the link owner's accounts -- and anyone
    // holding a shared install link could read the tokens. Importing needs
    // only the rows: a signed-in builder uses its account's own keys and a
    // signed-out one stores none (docs/DECISIONS.md D-8).
    //
    // jsonPrivate still: the tracking rows below are one account's. isPrivateApiPath
    // names this route too, so the header is also set at the boundary.
    return jsonPrivate({
      ok: true,
      entries,
      watchHistory: watchHistory || [],
      continueWatching: continueWatching || [],
      watchlist: watchlist || [],
      airingNext: airingNext || [],
      traktUsername,
    });
  } catch (err) {
    return json({ ok: false, error: safeErrorMessage(err) });
  }
}

// POST /api/save  { entries, mdblistKey, traktKey, traktUsername } -> { ok, id }
// Stores the config server-side (when a CONFIGS KV namespace is bound)
// and returns a short id to use in the install URL instead of a long
// base64 blob. Returns { ok: false, error: "no-kv" } when no KV
// namespace is bound, so the builder page can fall back to the old
// client-side base64 link instead.
async function apiSave(request, env, ctx, path) {
  if (!env || !env.CONFIGS) {
    return json({ ok: false, error: "no-kv" });
  }
  // Unauthenticated, and each call writes a permanent KV key (the
  // install config) that nothing ever expires or deletes. Generous
  // bucket -- regenerating an install link a few times while adjusting
  // rows is normal -- but not unlimited.
  //
  // No TTL on the key itself, deliberately (AUDIT-2026-09-05 top-10 §9
  // left this open; this is the answer). The id IS somebody's install
  // URL -- it is pasted into Stremio or wako and read on every catalog
  // request, for as long as they keep the add-on. An expiry would break
  // those installs silently, months later, with nothing to point at:
  // the failure would arrive as "my lists stopped loading" from someone
  // who had done nothing at all. So the growth is bounded at the door
  // instead -- this per-IP limit, plus SAVED_CONFIG_ENTRIES_MAX and
  // SAVED_CONFIG_BYTES_MAX below -- rather than by throwing away data
  // somebody is still using.
  const saveIp = clientIpKey(request);
  if (!saveIp) return json({ ok: false, error: "Could not process this request." }, 400);
  if (await consumeRateLimit(env, ctx, "save", saveIp, 20)) {
    return json({ ok: false, error: "Too many saves just now. Please wait a minute and try again." }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const entries = Array.isArray(body.entries) ? body.entries : [];
  if (!entries.length) {
    return json({ ok: false, error: "No lists provided." }, 400);
  }
  // A config is a list of catalog rows; the builder's own URL-length
  // problem (see generateShortId's comment) starts around 20 rows, so
  // this ceiling is orders of magnitude above real use and only
  // rejects a payload built to waste storage. Rejected, not truncated
  // -- a silently shortened install config would be worse than an
  // error.
  if (entries.length > SAVED_CONFIG_ENTRIES_MAX) {
    return json({ ok: false, error: "Too many lists in that configuration." }, 413);
  }
  // Rejected, not repaired: a quietly changed row would be a different install
  // link from the one the person built.
  const entriesProblem = saveEntriesProblem(entries);
  if (entriesProblem) return json({ ok: false, error: entriesProblem }, 400);
  // A config that names a Creator Profile must prove it belongs to it.
  //
  // This endpoint is unauthenticated by design -- a config is just a list of
  // catalog rows, and most of them belong to nobody. But two things in a
  // config DO name an account: `trackCreatorName`, and an
  // `autotrack:<slug>:<type>:<username>` entry url, which is a Watch History
  // / Continue Watching / Watchlist shelf. Both were accepted from anyone,
  // so anyone could mint a config naming any account and then read that
  // account's private tracking record straight back out of /api/resolve or
  // the catalog route. That is SEC-001; see mayReadTrackedShelf
  // (02_http-and-creator-utils.js).
  //
  // Refused rather than silently stripped: a builder page that is signed in
  // always has the key (see collectKeys, 23_client-list-management.js), so a
  // save that cannot prove ownership is either a bug or a forgery, and
  // quietly dropping the shelf from somebody's install link would be the
  // same class of silent failure this codebase already refuses elsewhere.
  const namedCreators = new Set();
  if (body.trackCreatorName) namedCreators.add(String(body.trackCreatorName).toLowerCase().trim());
  for (const e of entries) {
    const eUrl = e && typeof e.url === "string" ? e.url : "";
    if (!eUrl.startsWith("autotrack:")) continue;
    const segs = eUrl.split(":");
    if (segs.length >= 4 && segs[3]) namedCreators.add(String(segs[3]).toLowerCase().trim());
  }
  namedCreators.delete("");
  let saveVerifiedOwner = "";
  if (namedCreators.size) {
    if (namedCreators.size > 1) {
      return json({ ok: false, error: "A configuration can only carry personal shelves for one account." }, 400);
    }
    const claimed = [...namedCreators][0];
    // A session for the claimed account signs this save; the key is then
    // only checked, because it is stored in the link for playback
    // tracking (see "trackCreatorKey" below). Without a session the key
    // signs the save, as before. Either way it is counted as "trackkey"
    // on /admin, and a wrong key is refused.
    const trackKey = body.trackCreatorKey || "";
    const sessionHeld = !!(request.account && String(request.account.username || "").toLowerCase() === claimed);
    let saveAuth = await authenticateCreatorFor(request, env, ctx, path, claimed, sessionHeld ? "" : trackKey, "trackkey");
    if (saveAuth.ok && sessionHeld && trackKey) saveAuth = await authenticateCreatorFor(request, env, ctx, path, claimed, trackKey, "trackkey");
    if (!saveAuth.ok) {
      if (saveAuth.throttled) return authFailureResponse(saveAuth);
      return json({
        ok: false,
        error: "Sign in to that Creator Profile before adding its Watch History, Continue Watching or Watchlist to an install link.",
      }, 401);
    }
    saveVerifiedOwner = saveAuth.username;
  }

  // docs/DECISIONS.md D-8: signed out, an install link carries the site's
  // public lists and nothing else (see entryAccountRequirement,
  // 04_config-resolution.js). A signed-in builder proves its account with
  // creatorName/creatorKey; those are verified here and NOT stored -- the
  // install link is a bearer credential, and only a config with one of the
  // account's own shelves carries its key (trackCreatorKey, above).
  //
  // A personal or user-made row is refused rather than dropped: the
  // builder asks a signed-out visitor to sign in before adding one, so a
  // save that still has one is an old page or a builder restored from
  // before D-8, and silently removing rows from somebody's install link is
  // the failure this endpoint refuses everywhere else. Provider keys and
  // tokens are different: public lists never need them, so a signed-out
  // save simply does not store them.
  let saveAccount = saveVerifiedOwner;
  if (!saveAccount && body.creatorName && body.creatorKey) {
    const accountAuth = await authenticateCreatorFor(request, env, ctx, path, body.creatorName, body.creatorKey);
    if (accountAuth.ok) saveAccount = accountAuth.username;
    else if (accountAuth.throttled) return authFailureResponse(accountAuth);
  }
  return apiSaveStore(env, body, entries, saveVerifiedOwner, saveAccount);
}

// The rest of apiSave, moved unchanged: the same statements in the same order, split only for the 150-line limit.
async function apiSaveStore(env, body, entries, saveVerifiedOwner, saveAccount) {
  let savedEntries = entries;
  if (!saveAccount) {
    const needs = entries.map((e) => entryAccountRequirement(e && e.url)).find(Boolean);
    if (needs) {
      return json({
        ok: false,
        signInRequired: true,
        error: `Sign in to add ${needs} to an install link.`,
      }, 401);
    }
    // An Explore Channels listing is public only while it is listed, and
    // only as its owner published it. A signed-out save stores the
    // published lineup itself rather than whatever the row carried, so a
    // row claiming a share code cannot smuggle in a channel of its own.
    const listed = new Map();
    const rewritten = [];
    for (const e of entries) {
      const eUrl = e && typeof e.url === "string" ? e.url.trim() : "";
      const p = eUrl.startsWith("channel:v1:") ? publicChannelRowPayload(eUrl) : null;
      const code = p && !p.storylineId && typeof p.shareCode === "string" ? p.shareCode : "";
      if (!code) {
        rewritten.push(e);
        continue;
      }
      if (!listed.has(code)) {
        // From v2 when its copy of the channel is current (P3b-8).
        let record = await channelsV2Record(env, code, { items: true });
        if (!record && !isV2ListsOnly(env)) {
          try {
            const raw = await env.CONFIGS.get(`channelshare:${code}`);
            record = raw ? JSON.parse(raw) : null;
          } catch {
            record = null;
          }
        }
        listed.set(code, record && record.published && record.channel ? record : null);
      }
      const record = listed.get(code);
      if (!record) {
        return json({
          ok: false,
          signInRequired: true,
          error: `Sign in to add ${ACCOUNT_LABEL_CHANNELS} to an install link.`,
        }, 401);
      }
      rewritten.push(Object.assign({}, e, {
        url: "channel:v1:" + JSON.stringify(Object.assign({}, record.channel, {
          channelId: p.channelId || undefined,
          shareCode: code,
          sharePublished: false,
          catalogOnly: true,
        })),
      }));
    }
    savedEntries = rewritten;
  }

  // Every install setting comes from the one schema
  // (INSTALL_CONFIG_FIELDS, 00_constants.js): only what differs from its
  // default, only what passes its check, and account keys and tokens only
  // for a signed-in save. This used to be written out field by field here,
  // and a field missing from that list was dropped on the floor -- the
  // badge toggles and then Better Posters each were, once.
  const payload = { entries: savedEntries, ...storedInstallConfigFields(body, !!saveAccount) };
  // `track` (the Auto-track Playback flag, which is what makes the manifest
  // declare a subtitles resource) and the account credential are now stored
  // independently. They used to be one branch, so a config with a personal
  // shelf but playback tracking switched OFF carried no credential at all --
  // and that is the shape that has to keep working after the check above.
  // Playback tracking records to an account, so it needs one.
  if (body.track && saveAccount) payload.track = true;
  if (saveVerifiedOwner) {
    payload.trackCreatorName = saveVerifiedOwner;
    if (body.trackCreatorKey) payload.trackCreatorKey = body.trackCreatorKey;
    // Stamped by the server after verifying, so the shelf keeps working
    // through a later Creator Key rotation instead of going empty the
    // moment the stored key stops matching. See resolveConfig.
    payload.trackOwner = saveVerifiedOwner;
  }
  // A signed-in save names its account in a way a reused username cannot
  // match: the accounts row's id and when it was created (P3a-10). With
  // that proof the link's personal rows can use the account's own
  // connections, so the keys and tokens those supply are not copied into
  // it. Without a table, a key or any connection, this changes nothing.
  if (saveAccount) {
    const ownerRow = await getOrBackfillAccount(env, saveAccount);
    if (ownerRow && ownerRow.created_at) {
      payload.ownerId = ownerRow.id;
      payload.ownerSince = ownerRow.created_at;
      for (const field of await connectionSuppliedConfigFields(env, ownerRow.id)) delete payload[field];
    }
  }

  const savePayload = JSON.stringify(payload);
  // Row count alone is not a size bound -- a row carries a URL, a
  // name and a group. Checked on the exact bytes about to be stored --
  // bytes, not UTF-16 code units, which the constant's name has always
  // said and the check did not do.
  if (utf8ByteLength(savePayload) > SAVED_CONFIG_BYTES_MAX) {
    return json({ ok: false, error: "That configuration is too large to save." }, 413);
  }

  let id;
  for (let attempt = 0; attempt < 5; attempt++) {
    id = generateShortId();
    // Both shapes, so a fresh id cannot collide with a pre-prefix one.
    const existing = (await env.CONFIGS.get(savedConfigKey(id))) || (await env.CONFIGS.get(id));
    if (!existing) break;
  }
  await env.CONFIGS.put(savedConfigKey(id), savePayload);
  return json({ ok: true, id });
}

// POST /api/list-live/save  { token, name, type, items } -> { ok: true }
//
// Writes the server-side copy of a Custom List that belongs to no
// Creator Profile, so its catalog row can be re-read live instead of
// serving the snapshot baked into the install link (see
// readLiveListRecord / fetchCustomListCatalog, 05_catalog-core.js). This
// is what makes a signed-out browser's list behave like Continue
// Watching: an item added or removed on the website reaches Stremio
// without the link being regenerated.
//
// The token is the capability and the only authorization there is. It is
// minted in the browser (128 bits, base64url), kept in the list's own
// local record and embedded in the row's URL -- so it only ever exists
// inside an install link that already carries the list's entire
// contents. A write for a token nobody holds can only touch that token's
// own key, which is why an unauthenticated write is acceptable here in a
// way it would not be for an account's data. The same shape of endpoint
// as /api/save above, and the same bounds: rate-limited per IP, capped on
// items and on the exact bytes about to be stored, rejected rather than
// truncated.
async function apiListLiveSave(request, env, ctx) {
  if (!env || !env.CONFIGS) {
    return json({ ok: false, error: "no-kv" });
  }
  const liveIp = clientIpKey(request);
  if (!liveIp) return json({ ok: false, error: "Could not process this request." }, 400);
  // Higher than /api/save's 20: this fires on every list edit (debounced
  // in the browser), and someone working through a batch of adds is
  // normal. It is a KV write of a list the caller already owns, not a
  // mint of a new install link.
  if (await consumeRateLimit(env, ctx, "listlive", liveIp, LIVE_LIST_SAVE_PER_MINUTE)) {
    return json({ ok: false, error: "Too many saves just now. Please wait a minute and try again." }, 429);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const token = String(body.token || "");
  if (!isValidLiveListToken(token)) {
    return json({ ok: false, error: "That list reference is not valid." }, 400);
  }
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length > PUBLISHED_LIST_ITEMS_MAX) {
    return json({ ok: false, error: `That list is too large to save (limit ${PUBLISHED_LIST_ITEMS_MAX} items).` }, 413);
  }
  const name = String(body.name || "").slice(0, PUBLISHED_LIST_NAME_MAX);
  const type = body.type === "series" || body.type === "movie" || body.type === "mixed" ? body.type : "movie";
  const payload = { name, type, items, updatedAt: Date.now() };
  const bytes = utf8ByteLength(JSON.stringify(payload));
  if (bytes > CREATOR_LIST_BYTES_MAX) {
    return json({ ok: false, error: "That list is too large to save. Try splitting it into more than one list." }, 413);
  }
  // A long TTL rather than none, unlike the install configs above: this
  // key is only ever read through a row that ALSO carries the list's
  // items as a snapshot, so an expired key degrades to the last snapshot
  // the link carried rather than to an empty shelf -- and every edit
  // re-writes the key, which re-stamps the TTL. That bounds the storage a
  // signed-out browser can accumulate without a way for anyone to be
  // left with a broken row.
  await env.CONFIGS.put(LIVE_LIST_KEY_PREFIX + token, JSON.stringify(payload), {
    expirationTtl: LIVE_LIST_TTL_SEC,
  });
  return json({ ok: true });
}

// /api/publish-list was removed in 1.5.3.
//
// It was an unauthenticated endpoint that minted a permanent KV key on
// every call, it had no caller anywhere in the shipped bundle, and it was
// vector A of the stored-XSS finding in AUDIT-2026-09-08-ADVERSARIAL-III.
// Round 5 tightened it (5,000 items, 512 KB, 5 publishes a minute,
// per-item shape validation) and left the keep-or-remove call to the
// maintainer, who chose remove.
//
// What is NOT removed: the records themselves. Lists already published
// under `publishedlist:user:<slug>` still serve at /lists/user/<slug>, so
// an install that points at one keeps working, and they are still
// browsable and deletable from /admin (see /admin/api/published-lists and
// /admin/api/delete-published-list, 26_). They are no longer promoted:
// not in the directory, not in search, not likeable (docs/DECISIONS.md
// D-6). A signed-in account publishes through /api/creator/lists/save,
// which is authenticated, owned, and deletable by the person who made it.

async function apiListsLike(request, env, ctx, path) {
  if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" });
  let likeBody;
  try { likeBody = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400); }
  const likeUser = String(likeBody.username || "").toLowerCase().trim();
  const likeSlug = String(likeBody.slug || "").toLowerCase().trim();
  const likeUnlike = likeBody.action === "unlike";
  if (!likeUser || !likeSlug) return json({ ok: false, error: "Missing list reference." }, 400);
  // Likes need an account: every like belongs to a real person, one per
  // account across every device. Anonymous (per-IP) likes were retired --
  // they could be cast by any page a visitor happened to open.
  const likeAuth = await authenticateCreatorFor(request, env, ctx, path, likeBody.creatorName, likeBody.creatorKey);
  if (!likeAuth.ok) {
    if (likeAuth.throttled) return authFailureResponse(likeAuth);
    return json({ ok: false, error: "Sign in to like lists.", signInRequired: true }, 401);
  }
  const likeVoterName = likeAuth.username;

  // FF_V2_LISTS_ONLY (P3b-9): the like is v2's alone.
  if (isV2ListsOnly(env)) {
    const v2 = await listsV2LikeList(env, likeUser, likeSlug, likeVoterName, !likeUnlike);
    if (v2.error) return json({ ok: false, error: v2.error }, v2.status);
    return json({ ok: true, likes: v2.likes, liked: !likeUnlike });
  }

  // The list must actually exist before any vote is recorded --
  // otherwise a ledger (and a permanent KV key) could be created for
  // any username/slug pair someone cared to invent.
  const likeCreatorKey = "creatorlist:" + likeUser + ":" + likeSlug;
  let likeKey = null;
  // Only lists that belong to an account can be liked. Legacy anonymous
  // lists (publishedlist:user:*) still resolve at their URLs, but they are
  // no longer promoted: not in the directory, not in search, not likeable.
  let likeRaw = await env.CONFIGS.get(likeCreatorKey);
  if (likeRaw) likeKey = likeCreatorKey;
  if (!likeKey) return json({ ok: false, error: "List not found." }, 404);
  let likeData;
  try { likeData = JSON.parse(likeRaw); } catch { return json({ ok: false, error: "Corrupted." }, 500); }
  await stampListVisibilityIfNeeded(env, likeKey, likeData);

  // A private list is not likeable, and this route is the only public
  // path to a list record that did not say so.
  //
  // Visibility used to be consulted only much further down, to decide
  // whether to touch the directory index -- so the vote itself was
  // recorded either way. Three things came out of that. The 404-vs-200
  // split told any anonymous caller exactly which private slugs a creator
  // owned (and /lists/public.json publishes the usernames, so only the
  // slug had to be guessed). A stranger could change the stored `likes`
  // on a private record in both stores and mint a permanent
  // listlikevoters: key for it. And because a save deliberately preserves
  // `likes` across an edit, the count a stranger built up while the list
  // was private carried straight into the public directory the moment its
  // owner published it.
  //
  // The SAME error and status as a list that does not exist, deliberately
  // -- a distinguishable response here is the oracle, not the vote.
  if (!isPublicListVisibility(likeData.visibility)) {
    return json({ ok: false, error: "List not found." }, 404);
  }

  // One account is worth exactly one like, however many times it POSTs
  // and from however many devices.
  const listScopeId = `${likeUser}:${likeSlug}`;
  const voterId = await likeVoterId(request, env, likeVoterName, listScopeId);
  if (!voterId) return json({ ok: false, error: "Could not process this request." }, 400);
  const ledgerKey = `listlikevoters:${listScopeId}`;
  const { count, capped } = await applyLikeVote(env, ledgerKey, voterId, !likeUnlike);

  // The count lives on the list record too, because the directory,
  // search, and the admin dashboard all read it from there and none of
  // them should have to open a ledger per list. Derived from the
  // ledger, never incremented, so it cannot drift upward on its own.
  //
  // Re-read before writing. `likeData` was parsed before applyLikeVote,
  // which spends several KV round-trips on the ledger (up to four
  // read/write/verify attempts under contention). Writing that stale
  // snapshot back put the WHOLE record -- items included -- on top of
  // whatever landed in the meantime, so a like arriving while the
  // list's owner was saving silently reverted their edit, with both
  // requests returning 200. Only the one field this route owns gets
  // written, onto the current record.
  if ((likeData.likes || 0) !== count) {
    // Re-read, then copy only `likes` onto the CURRENT record. If it
    // vanished or turned unparseable while the vote was being
    // recorded, write nothing at all: the ledger already holds the
    // vote, and re-creating the record from a stale copy would be
    // worse than leaving the denormalised count to catch up on the
    // next like.
    const freshRaw = await env.CONFIGS.get(likeKey);
    let updated = null;
    if (freshRaw) {
      try {
        updated = JSON.parse(freshRaw);
        updated.likes = count;
      } catch {
        updated = null;
      }
    }
    if (updated) {
      await env.CONFIGS.put(likeKey, JSON.stringify(updated));
    }
  }

  if (env.DB) {
    try {
      await env.DB.prepare("UPDATE creator_lists SET likes = ? WHERE id = ?").bind(count, listScopeId).run();
    } catch (dbErr) {
      // Non-fatal: KV above holds the authoritative count, so a like is
      // never lost by D1 being unavailable. Requires the `likes` column
      // from migrations/0001; without it this throws on every like.
      console.error("D1 write error (list likes):", dbErr);
    }
  }

  // The same like in v2 (P3b-7). With reads on v2 the count people see
  // is v2's, which keeps any higher legacy total the copy carried over.
  const v2Likes = await listsV2MirrorLike(env, likeUser, likeSlug, likeVoterName, !likeUnlike);
  const shownLikes = isV2ListsReadEnabled(env) && v2Likes != null ? v2Likes : count;
  return json({ ok: true, likes: shownLikes, liked: !likeUnlike, capped: capped || undefined });
}

async function apiListsLikeExternal(request, env, ctx, path) {
  if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" });
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const rawUrl = String(body.url || "").trim();
  if (!rawUrl) return json({ ok: false, error: "Missing list URL." }, 400);
  // Validated and normalized before it is allowed anywhere near a KV
  // key -- see normalizeExternalListUrl. Rejects non-http(s) schemes,
  // over-long strings, and any host that isn't a provider this add-on
  // integrates with, which is what stops this endpoint being an
  // unbounded attacker-controlled keyspace.
  const normalizedUrl = normalizeExternalListUrl(rawUrl);
  if (!normalizedUrl) {
    return json({ ok: false, error: "That URL can't be liked -- only MDBList, Trakt, TMDB, Simkl and Letterboxd list links and this add-on's own charts are supported." }, 400);
  }
  const unlike = body.action === "unlike";

  // Likes need an account -- see /api/lists/like.
  const extAuth = await authenticateCreatorFor(request, env, ctx, path, body.creatorName, body.creatorKey);
  if (!extAuth.ok) {
    if (extAuth.throttled) return authFailureResponse(extAuth);
    return json({ ok: false, error: "Sign in to like lists.", signInRequired: true }, 401);
  }
  const extVoterName = extAuth.username;

  const hash = await hashStringForKey(normalizedUrl);
  // FF_V2_LISTS_ONLY (P3b-9): the like is v2's alone, under the same hash.
  if (isV2ListsOnly(env)) {
    return json({ ok: true, likes: await listsV2LikeExternal(env, hash, extVoterName, !unlike), liked: !unlike });
  }
  const key = `externallike:${hash}`;
  const voterId = await likeVoterId(request, env, extVoterName, hash);
  if (!voterId) return json({ ok: false, error: "Could not process this request." }, 400);
  const { count, capped } = await applyLikeVote(env, `extlikevoters:${hash}`, voterId, !unlike);

  const raw = await env.CONFIGS.get(key);
  let data = { url: normalizedUrl, likes: 0 };
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { url: normalizedUrl, likes: 0 };
    }
  }
  if (data.likes !== count || data.url !== normalizedUrl) {
    data.likes = count;
    data.url = normalizedUrl;
    data.updatedAt = Date.now();
    await env.CONFIGS.put(key, JSON.stringify(data));
  }
  // The same like in v2, under the same hash (P3b-7).
  await listsV2MirrorExternalLike(env, hash, extVoterName, !unlike);
  return json({ ok: true, likes: count, liked: !unlike, capped: capped || undefined });
}

// /api/details/batch  (POST)  { ids: [...], type?, tmdbKey?, region?, fresh? }
//   -> { ok, results: { <id>: details | null } }
// The plural sibling of /api/details below, for callers that already
// know they need many shows at once. Airing Next is the one that
// matters (refreshAiringNext, 21_client-custom-list-builder.js): it
// walks up to 60 shows per refresh, and was doing so as 60 separate
// round trips at a concurrency of 4 -- so fifteen sequential waves of
// request latency before the shelf could be rebuilt, per browser, per
// refresh.
//
// This is not a way to make MORE upstream calls in one go. Each id
// still goes through fetchTmdbItemDetails, which means the shared
// memory/KV/edge cache and, as of the same change, in-flight
// coalescing -- so ids already known cost nothing, ids being fetched
// concurrently by another request are joined rather than duplicated,
// and only genuine misses reach TMDB. The batch simply removes the
// round trips.
//
// Capped at 60 ids to bound the worst case for a single request, and
// resolved with a small worker pool rather than one Promise.all over
// every id, so a large batch of genuine misses cannot open sixty
// simultaneous TMDB connections. A failed id resolves to null rather
// than failing the batch -- the caller simply retries it next refresh,
// exactly as it did when each id was its own request.
async function apiDetailsBatch(request, env, ctx) {
  let reqBody;
  try {
    reqBody = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const rawIds = Array.isArray(reqBody.ids) ? reqBody.ids : [];
  // De-duplicated up front: the same show can legitimately appear under
  // both an imdb and a tmdb-prefixed id in a Watch History, and there is
  // no reason to resolve it twice.
  const ids = [...new Set(rawIds.map((v) => String(v || "").trim()).filter(Boolean))].slice(0, 60);
  if (!ids.length) return json({ ok: false, error: "Missing ids" }, 400);

  const tmdbKey = reqBody.tmdbKey || TMDB_API_KEY;
  // Same correction as /api/recommendations above: this used to skip the
  // limit outright whenever the body carried a tmdbKey. Supplying your
  // own key does mean you are spending your own TMDB quota, but it never
  // meant you were spending your own subrequests -- and the field was
  // never validated, so any non-empty string unlocked an unlimited
  // 60-id fan-out against this Worker.
  //
  // Always limited now, with a much higher ceiling for a caller who
  // brought a key, so the power users this exemption existed for keep
  // their headroom. 60/minute already leaves plenty of room for the real
  // bulk caller (refreshAiringNext pages a large Watch History 60 ids at
  // a time).
  const batchIp = clientIpKey(request);
  if (!batchIp) return json({ ok: false, error: "Could not load those details." }, 400);
  // Charged in IDS, not requests. The ceilings used to be 60 and 240
  // REQUESTS a minute while one request carried up to 60 ids; now that the
  // budget below can split a refresh across invocations, counting requests
  // would have quietly cut the real ceiling by the number of chunks. See
  // DETAILS_BATCH_IDS_PER_MINUTE (00_constants.js).
  const batchIdCeiling = reqBody.tmdbKey ? DETAILS_BATCH_IDS_PER_MINUTE_OWN_KEY : DETAILS_BATCH_IDS_PER_MINUTE;
  if (await consumeRateLimit(env, ctx, "detailsbatch", batchIp, batchIdCeiling, 60, ids.length)) {
    return json({ ok: false, error: "Too many lookups just now. Please wait a minute and try again." }, 429);
  }
  if (!reqBody.tmdbKey) ctx.waitUntil(bumpStat(env, "apiuse:tmdb"));
  const wantType = reqBody.type || "";
  const region = reqBody.region || "";
  const isFreshReq = reqBody.fresh === "1" || reqBody.fresh === true;

  // Every id in the batch is resolved in this one request, six at a time.
  // (A per-invocation outbound-fetch budget with a resume protocol used to
  // sit here so a cold 60-id batch -- ~180 fetches -- could crawl through
  // the Workers Free plan's 50. The hosted Worker is on Paid.)
  const results = {};
  let cursor = 0;
  async function worker() {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      try {
        results[id] = await fetchTmdbItemDetails(id, tmdbKey, wantType, region, isFreshReq, env, ctx);
      } catch {
        results[id] = null;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(6, ids.length) }, () => worker())
  );

  // `remainingIds` / `done` are kept in the response shape for clients
  // still running the old resume loop; the batch is always complete now.
  // Same short max-age as /api/details for the same reason -- this
  // response's shape changes occasionally and an hour-old copy would
  // strand anyone who had just opened it.
  return json({ ok: true, results, remainingIds: [], done: true }, 200, { "Cache-Control": "max-age=60" });
}

// /api/details (GET or POST) -> { ok: true, details: { title, overview, rating, releaseYear, poster, background } }
async function apiDetails(request, env, ctx, url) {
  let reqBody;
  if (request.method === "POST") {
    try {
      reqBody = await request.json();
    } catch {
      reqBody = {};
    }
  } else {
    const q = url.searchParams;
    reqBody = { imdbId: q.get("imdbId") || q.get("id") || "", tmdbKey: q.get("tmdbKey") || "", type: q.get("type") || "", region: q.get("region") || "" };
  }

  const imdbId = reqBody.imdbId || reqBody.id;
  const tmdbKey = reqBody.tmdbKey || TMDB_API_KEY;
  if (!imdbId) return json({ ok: false, error: "Missing imdbId" }, 400);
  if (!reqBody.tmdbKey) ctx.waitUntil(bumpStat(env, "apiuse:tmdb"));

  const isFreshReq = reqBody.fresh === "1" || reqBody.fresh === true || (url && url.searchParams.get("fresh") === "1");
  let details = await fetchTmdbItemDetails(imdbId, tmdbKey, reqBody.type, reqBody.region, isFreshReq, env, ctx);
  // A title TMDB has no entry for yet -- New on Streaming lists some the
  // day a service adds them -- opens from what else is known about it
  // (57_title-details-fallback.js).
  if (!details && typeof titleDetailsWithoutTmdb === "function") {
    details = await titleDetailsWithoutTmdb(env, imdbId, reqBody.type, reqBody.region);
  }
  if (!details) return json({ ok: false, error: "Not found or TMDB error" }, 404);

  // Short max-age -- same reasoning as /api/season's own comment: this
  // response's shape changes occasionally (tmdbId is a recent
  // addition), and json()'s 3600s default would leave anyone who'd
  // opened this exact show recently stuck looking at an hour-old,
  // pre-fix cached copy.
  return json({ ok: true, details }, 200, { "Cache-Control": "max-age=60" });
}
