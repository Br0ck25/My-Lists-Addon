// Sign-in sessions (/api/session, /api/me, /api/me/sessions) and shared channels (/api/channel/*), moved out of handleFetch (CQ-01).

// Moved unchanged: each route body is now its own function; the dispatchers keep each route's
// original path/method test and are plain functions that return a Response promise or null.
// Channel routes authenticate through authenticateCreatorFor (62_creator-auth.js).

// /api/session (sign in and out), /api/me and /api/me/sessions, at their original place. Returns a Response promise, or null.
function handleSessionRoutes(request, env, ctx, url, path) {
  if (path === "/api/session" && request.method === "POST") return apiSessionSignIn(request, env, ctx, path);
  if (path === "/api/session" && request.method === "DELETE") return apiSessionSignOut(request, env);
  if (path === "/api/me" && request.method === "GET") return apiMe(request);
  if (path === "/api/me/sessions" && request.method === "GET") return apiMeSessionsList(request, env);
  if (path === "/api/me/sessions" && request.method === "DELETE") return apiMeSessionsRevoke(request, env);
  return null;
}

// POST /api/session  { username, key } -> { ok, account }
// Authenticates account credentials via PBKDF2, issues a 256-bit session token,
// stores its SHA-256 hash in D1 sessions, and sets the mla_session cookie.
async function apiSessionSignIn(request, env, ctx, path) {
  if (!env || !env.DB) return json({ ok: false, error: "Database unavailable." }, 503);
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const usernameRaw = body.username || body.creatorName;
  const keyRaw = body.key || body.creatorKey;
  if (!usernameRaw || !keyRaw) {
    return json({ ok: false, error: "Username and Account Key are required." }, 400);
  }
  // The creator profile decides, exactly as it does for every key-in-body
  // route: authenticateCreator applies the deletion tombstone, the per-IP
  // PBKDF2 throttle and the memo. This used to verify against
  // accounts.key_hash alone, which nothing kept current -- a deleted
  // account's key still signed in, with no throttle on guessing.
  const auth = await authenticateCreatorFor(request, env, ctx, path, usernameRaw, keyRaw);
  if (!auth.ok) return authFailureResponse(auth);

  let profile = null;
  try {
    const raw = await getCreator(env, auth.username);
    profile = raw ? JSON.parse(raw) : null;
  } catch {
    profile = null;
  }
  // Brought up to date from the profile just verified, before a session is
  // tied to it. Null means the accounts table cannot be written: most
  // likely migration 0015 has not been applied yet.
  const accountRow = profile ? await getOrBackfillAccount(env, auth.username, profile) : null;
  if (!accountRow) {
    return json({ ok: false, error: "Signing in isn't available right now. Please try again later." }, 503);
  }

  // A key stored under fewer PBKDF2 iterations than today's target is
  // rehashed while the plaintext is at hand. Through the same path as a
  // key reset (D1 first, then KV), because the profile is the copy that
  // is checked: upgrading only the accounts row would change nothing.
  const hashParts = String(profile.keyHash || "").split(":");
  if (hashParts.length === 4 && hashParts[0] === "pbkdf2" && parseInt(hashParts[1], 10) < PBKDF2_ITERATIONS) {
    try {
      const upgradedHash = await hashCreatorKey(keyRaw);
      const rotation = await rotateCreatorKeyHashInD1(env, auth.username, upgradedHash);
      if (rotation.ok) {
        await env.CONFIGS.put(`creator:${auth.username}`, JSON.stringify({ ...profile, keyHash: upgradedHash }));
        accountRow.key_hash = upgradedHash;
      }
    } catch (e) {
      console.error("Failed to upgrade PBKDF2 iterations:", e);
    }
  }

  // Blind index v2: if LOOKUP_PEPPER is configured, write accounts.key_lookup_hmac
  if (env.LOOKUP_PEPPER) {
    try {
      const hmac = await hmacLookupKey(keyRaw, env);
      if (hmac && accountRow.key_lookup_hmac !== hmac) {
        await env.DB.prepare(
          "UPDATE accounts SET key_lookup_hmac = ? WHERE id = ?"
        ).bind(hmac, accountRow.id).run();
        accountRow.key_lookup_hmac = hmac;
      }
    } catch (hmacErr) {
      console.error("Failed to write accounts.key_lookup_hmac on login:", hmacErr);
    }
  }

  // Update last active
  const now = Date.now();
  await env.DB.prepare("UPDATE accounts SET last_active_at = ? WHERE id = ?").bind(now, accountRow.id).run().catch(() => {});

  // Create session
  const userAgent = request.headers.get("user-agent") || null;
  const session = await createSession(env, accountRow.id, userAgent);

  const cookie = buildSessionCookieHeader(session.token);
  return json(
    {
      ok: true,
      account: {
        id: accountRow.id,
        username: accountRow.username,
        displayName: accountRow.display_name,
        createdAt: accountRow.created_at,
        lastActiveAt: now,
      },
    },
    200,
    {
      "Set-Cookie": cookie,
      "Cache-Control": "no-store",
    }
  );
}

// DELETE /api/session -> logs out by revoking current session and clearing cookie
async function apiSessionSignOut(request, env) {
  const token = extractSessionToken(request);
  if (token) {
    const idHash = await hashSessionToken(token);
    await revokeSession(env, idHash);
  }
  return json(
    { ok: true },
    200,
    {
      "Set-Cookie": buildClearSessionCookieHeader(),
      "Cache-Control": "no-store",
    }
  );
}

// GET /api/me -> returns the current authenticated account profile
async function apiMe(request) {
  if (!request.account) {
    return json({ ok: false, error: "Authentication required." }, 401);
  }
  return json(
    {
      ok: true,
      account: {
        id: request.account.id,
        username: request.account.username,
        displayName: request.account.displayName,
        createdAt: request.account.createdAt,
        lastActiveAt: request.account.lastActiveAt,
        version: request.account.version || 0,
        status: request.account.status || "active",
      },
    },
    200,
    { "Cache-Control": "no-store" }
  );
}

// GET /api/me/sessions -> lists active sessions for the current account
async function apiMeSessionsList(request, env) {
  if (!request.account || !env || !env.DB) {
    return json({ ok: false, error: "Authentication required." }, 401);
  }
  const now = Date.now();
  const currentHash = request.session ? request.session.idHash : null;
  try {
    const { results } = await env.DB.prepare(
      "SELECT id_hash, created_at, last_seen_at, expires_at, user_agent " +
      "FROM sessions " +
      "WHERE account_id = ? AND revoked_at IS NULL AND expires_at > ? " +
      "ORDER BY last_seen_at DESC"
    ).bind(request.account.id, now).all();

    const sessions = (results || []).map((s) => ({
      id: s.id_hash.slice(0, 16),
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      expiresAt: s.expires_at,
      userAgent: s.user_agent,
      current: s.id_hash === currentHash,
    }));
    return json({ ok: true, sessions }, 200, { "Cache-Control": "no-store" });
  } catch (e) {
    return json({ ok: false, error: "Failed to load sessions." }, 500);
  }
}

// DELETE /api/me/sessions -> revokes active sessions for current account
async function apiMeSessionsRevoke(request, env) {
  if (!request.account || !env || !env.DB) {
    return json({ ok: false, error: "Authentication required." }, 401);
  }
  let body = {};
  try {
    body = await readJsonObject(request);
  } catch {}

  const currentHash = request.session ? request.session.idHash : null;
  const url = new URL(request.url);
  const revokeOthers = body.allExceptCurrent || url.searchParams.get("other") === "1";
  // An id the caller names must be exactly what GET /api/me/sessions hands
  // out (16 hex characters). It used to be a LIKE prefix, so "%" matched
  // every session and "" fell through to "revoke everything". Leaving the
  // id out altogether still means every session.
  const idGiven = body.id !== undefined || url.searchParams.has("id");
  const targetId = body.id !== undefined ? body.id : url.searchParams.get("id");

  if (revokeOthers) {
    await revokeAccountSessions(env, request.account.id, currentHash);
    return json({ ok: true, revokedOthers: true }, 200, { "Cache-Control": "no-store" });
  }

  if (idGiven) {
    if (typeof targetId !== "string" || !/^[0-9a-f]{16}$/.test(targetId)) {
      return json({ ok: false, error: "Invalid session id." }, 400, { "Cache-Control": "no-store" });
    }
    const { results } = await env.DB.prepare(
      "SELECT id_hash FROM sessions WHERE account_id = ? AND substr(id_hash, 1, 16) = ? AND revoked_at IS NULL"
    ).bind(request.account.id, targetId).all();

    let revokedCurrent = false;
    for (const r of (results || [])) {
      await revokeSession(env, r.id_hash);
      if (r.id_hash === currentHash) revokedCurrent = true;
    }
    const headers = { "Cache-Control": "no-store" };
    if (revokedCurrent) {
      headers["Set-Cookie"] = buildClearSessionCookieHeader();
    }
    return json({ ok: true, revoked: (results || []).length }, 200, headers);
  }

  // No target specified: revoke all sessions including current
  await revokeAccountSessions(env, request.account.id, null);
  return json(
    { ok: true, revokedAll: true },
    200,
    {
      "Set-Cookie": buildClearSessionCookieHeader(),
      "Cache-Control": "no-store",
    }
  );
}

// /api/channel/share, directory, like, added, mine and unpublish, at their original place. Returns a Response promise, or null.
function handleChannelRoutes(request, env, ctx, url, path) {
  if (path === "/api/channel/share" && request.method === "POST") return apiChannelSharePublish(request, env, ctx, url, path);
  if (path === "/api/channel/share" && request.method === "GET") return apiChannelShareRead(env, url);
  if (path === "/api/channel/directory" && request.method === "GET") return apiChannelDirectory(env, url);
  if (path === "/api/channel/like" && request.method === "POST") return apiChannelLike(request, env, ctx, path);
  if (path === "/api/channel/added" && request.method === "POST") return apiChannelAdded(request, env, ctx, path);
  if (path === "/api/channel/mine" && request.method === "POST") return apiChannelMine(request, env, ctx, path);
  if (path === "/api/channel/unpublish" && request.method === "POST") return apiChannelUnpublish(request, env, ctx, path);
  return null;
}

// /api/channel/share  (POST)
//   { channel, description?, publish?, creatorName?, creatorKey? }
//     -> { ok, code, url, published }
async function apiChannelSharePublish(request, env, ctx, url, path) {
  if (!env || !env.CONFIGS) return json({ ok: false, error: "Sharing isn't available on this add-on." }, 503);
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const channel = sanitizeSharedChannel(body.channel);
  if (!channel) {
    return json({ ok: false, error: "That channel has nothing playable in it to share." }, 400);
  }
  const publish = !!body.publish;
  // Every share needs an account now, unlisted or published: a link
  // anyone can open needs an owner who can update or withdraw it.
  // (Anonymous unlisted shares used to be allowed. Codes already handed
  // out keep working for everyone who has them -- see the GET below.)
  const shareAuth = await authenticateCreatorFor(request, env, ctx, path, body.creatorName, body.creatorKey);
  if (!shareAuth.ok) {
    if (shareAuth.throttled) return authFailureResponse(shareAuth);
    return json({ ok: false, error: "Sign in to share channels.", signInRequired: true }, 401);
  }
  const owner = shareAuth.username;
  const description = (String(body.description || "").trim() || channel.description || "").slice(0, SHARED_CHANNEL_DESCRIPTION_MAX);
  // Reusing the code someone already has is what makes "Share" on an
  // edited channel update the link they handed out rather than mint a
  // second one beside it. Only the owner of a PUBLISHED code may do
  // that; an unlisted code is its own proof, the same way the link is.
  let code = String(body.code || "").trim().slice(0, 64);
  if (code && !/^[A-Za-z0-9_-]+$/.test(code)) code = "";
  let existing = null;
  // FF_V2_LISTS_ONLY (P3b-9): shared channels live in v2 only.
  const channelsOnly = isV2ListsOnly(env);
  if (code) {
    try {
      if (channelsOnly) {
        existing = await channelsV2Record(env, code);
      } else {
        const raw = await env.CONFIGS.get(`channelshare:${code}`);
        existing = raw ? JSON.parse(raw) : null;
      }
    } catch {
      existing = null;
    }
    // A link minted before shares needed an account has no owner, so nobody
    // may overwrite it: sharing under its code makes a new link and leaves the
    // old one as it was (it still opens for whoever holds it).
    if (existing && !existing.owner) existing = null;
    if (existing && existing.owner && existing.owner !== owner) {
      return json({ ok: false, error: "That share link belongs to someone else." }, 403);
    }
    if (!existing) code = "";
  }
  if (!code) code = generateShortId();
  const record = {
    code: code,
    channel: channel,
    description: description,
    owner: owner || (existing && existing.owner) || "",
    published: publish || !!(existing && existing.published),
    publishedAt: (existing && existing.publishedAt) || Date.now(),
    updatedAt: Date.now(),
  };
  const serialized = JSON.stringify(record);
  if (serialized.length > SHARED_CHANNEL_BYTES_MAX) {
    return json({
      ok: false,
      error: "That channel is too large to share. Trim it down and try again.",
    }, 413);
  }
  const channelSlug = typeof slugifyServer === 'function' ? slugifyServer(channel.name || "channel") : "channel";
  if (channelsOnly) {
    let stored;
    try {
      stored = await channelsV2Share(env, code, record);
    } catch (e) {
      console.error("channels v2: share failed", e);
      stored = { error: "Couldn't save that share link. Please try again.", status: 500 };
    }
    if (stored.error) return json({ ok: false, error: stored.error }, stored.status);
  } else {
    try {
      await env.CONFIGS.put(`channelshare:${code}`, serialized);
    } catch {
      return json({ ok: false, error: "Couldn't save that share link. Please try again." }, 500);
    }
    if (record.published && owner) {
      try {
        await env.CONFIGS.put(`creatorchannel:${owner.toLowerCase()}:${channelSlug}`, code);
      } catch {}
    }
    if (record.published) {
      await upsertPublicChannelIndex(env, code, record).catch(() => {});
    }
    // The same share into v2 (P3b-8, 35_channels-v2.js). It never fails
    // the share: a mirror that cannot finish marks the v2 row stale, and
    // reads of it go back to what was just stored here.
    await channelsV2SyncShare(env, code, record);
  }
  ctx.waitUntil(bumpStat(env, publish ? "channels:published" : "channels:shared"));
  return json({
    ok: true,
    code: code,
    url: (record.published && owner) ? `${url.origin}/channels/${encodeURIComponent(owner)}/${channelSlug}` : `${url.origin}/channel/${code}`,
    published: record.published,
  });
}

// /api/channel/share?code=...  (GET) -> { ok, channel, description, owner }
//
// The import half. Unauthenticated by design: the code IS the
// credential for an unlisted channel, and a published one is public.
async function apiChannelShareRead(env, url) {
  if (!env || !env.CONFIGS) return json({ ok: false, error: "Sharing isn't available on this add-on." }, 503);
  let code = String(url.searchParams.get("code") || "").trim();
  // A creator's address names a code: from v2 when reads are there
  // (P3b-8), else the legacy map, which also keeps a renamed channel's
  // old slugs.
  if (code.startsWith("channels:")) {
    const parts = code.split(":");
    const u = parts[1] || "";
    const s = parts[2] || "";
    const resolved = (await channelsV2CodeBySlug(env, u, s))
      || (isV2ListsOnly(env) ? null : (await legacyPublishedChannelCode(env, u, s)) || null);
    if (resolved) code = resolved;
  } else if (!code && url.searchParams.get("username") && url.searchParams.get("slug")) {
    const u = url.searchParams.get("username").trim();
    const s = url.searchParams.get("slug").trim();
    const resolved = (await channelsV2CodeBySlug(env, u, s))
      || (isV2ListsOnly(env) ? null : (await legacyPublishedChannelCode(env, u, s)) || null);
    if (resolved) code = resolved;
  }
  if (!code || !/^[A-Za-z0-9_-]{1,64}$/.test(code)) {
    return json({ ok: false, error: "That doesn't look like a channel share link." }, 400);
  }
  // From v2 when FF_V2_LISTS_READ is on and its copy of this channel is
  // current, episodes and all (P3b-8); otherwise the legacy record.
  let record = await channelsV2Record(env, code, { items: true });
  if (!record && !isV2ListsOnly(env)) {
    try {
      const raw = await env.CONFIGS.get(`channelshare:${code}`);
      record = raw ? JSON.parse(raw) : null;
    } catch {
      record = null;
    }
  }
  if (!record || !record.channel) {
    return json({ ok: false, error: "That channel link has expired or was removed." }, 404);
  }
  // Sanitized again on the way out, not only on the way in: a record
  // written by an older build of this Worker has only been through
  // whatever that build checked.
  const channel = sanitizeSharedChannel(record.channel);
  if (!channel) return json({ ok: false, error: "That channel link is no longer readable." }, 404);
  return json({
    ok: true,
    code: code,
    channel: channel,
    description: record.description || "",
    owner: record.owner || "",
    published: !!record.published,
  }, 200, { "Cache-Control": "public, max-age=60" });
}

// /api/channel/directory  (GET)  ?limit=
//   -> { ok, channels: [summary, ...] }
//
// Explore Channels. One index key rather than a KV scan: the directory
// is read on every visit to the tab and a prefix scan plus one GET per
// entry would be dozens of round trips for a page of cards.
async function apiChannelDirectory(env, url) {
  // A query over the channels rows once reads are on v2 and the copy has
  // finished (P3b-8); the legacy index until then.
  const v2Directory = await channelsV2DirectoryResponse(env, url);
  if (v2Directory) return v2Directory;
  if (isV2ListsOnly(env)) return json({ ok: false, error: "Explore Channels isn't available right now." }, 503);
  if (!env || !env.CONFIGS) return jsonCacheable({ ok: true, channels: [] });
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "60", 10) || 60, 1), PUBLIC_CHANNEL_INDEX_MAX);
  const sort = String(url.searchParams.get("sort") || "newest");
  const index = sortPublicChannelIndex(await readPublicChannelIndex(env), sort);
  return json({
    ok: true,
    total: index.length,
    sort,
    channels: index.slice(0, limit),
  }, 200, { "Cache-Control": "public, max-age=120" });
}

// /api/channel/like  (POST)  { code, action: "like"|"unlike", creatorName?, creatorKey? }
//   -> { ok, likes, liked }
//
// The same one-identity-one-vote machinery lists use (applyLikeVote /
// likeVoterId): a signed-in visitor votes as themselves, everyone else
// as a per-channel hash of their IP, and the count is always DERIVED
// from the ledger rather than incremented -- so it cannot drift upward
// on its own.
//
// Only a PUBLISHED channel is likeable. An unlisted share is reachable
// by anyone holding its code, and letting those be voted on would mint
// a permanent ledger key for every link ever handed out.
async function apiChannelLike(request, env, ctx, path) {
  if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" });
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const code = String(body.code || "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) return json({ ok: false, error: "Channel not found." }, 404);
  // FF_V2_LISTS_ONLY (P3b-9): the like is v2's alone. The same answers, in
  // the same order: not listed (404) before signed out (401).
  if (isV2ListsOnly(env)) {
    const row = await channelsV2LiveRow(env, code);
    if (!row || row.visibility !== "public") return json({ ok: false, error: "Channel not found." }, 404);
    const onlyAuth = await authenticateCreatorFor(request, env, ctx, path, body.creatorName, body.creatorKey);
    if (!onlyAuth.ok) {
      if (onlyAuth.throttled) return authFailureResponse(onlyAuth);
      return json({ ok: false, error: "Sign in to like channels.", signInRequired: true }, 401);
    }
    const liking = body.action !== "unlike";
    const v2 = await channelsV2Like(env, code, onlyAuth.username, liking);
    if (v2.error) return json({ ok: false, error: v2.error }, v2.status);
    return json({ ok: true, likes: v2.likes, liked: liking }, 200, { "Cache-Control": "no-store" });
  }
  let record = null;
  try {
    const raw = await env.CONFIGS.get(`channelshare:${code}`);
    record = raw ? JSON.parse(raw) : null;
  } catch {
    record = null;
  }
  // The same answer for "no such channel" and "not published",
  // deliberately: a distinguishable response is an oracle for which
  // unlisted codes exist.
  if (!record || !record.published) return json({ ok: false, error: "Channel not found." }, 404);

  // Likes need an account -- see /api/lists/like.
  const chLikeAuth = await authenticateCreatorFor(request, env, ctx, path, body.creatorName, body.creatorKey);
  if (!chLikeAuth.ok) {
    if (chLikeAuth.throttled) return authFailureResponse(chLikeAuth);
    return json({ ok: false, error: "Sign in to like channels.", signInRequired: true }, 401);
  }
  const voterName = chLikeAuth.username;
  const voterId = await likeVoterId(request, env, voterName, `channel:${code}`);
  if (!voterId) return json({ ok: false, error: "Could not process this request." }, 400);
  const liked = body.action !== "unlike";
  const { count, capped } = await applyLikeVote(env, `channellikevoters:${code}`, voterId, liked);

  // The count is denormalised onto both the record and the directory
  // row, because the directory reads one key and must not open a ledger
  // per listing. Re-read before writing, and write only this one field:
  // the record may have been re-published while the ledger was being
  // updated, and putting a stale snapshot back would take the channel
  // with it.
  try {
    const freshRaw = await env.CONFIGS.get(`channelshare:${code}`);
    if (freshRaw) {
      const fresh = JSON.parse(freshRaw);
      if ((fresh.likes || 0) !== count) {
        fresh.likes = count;
        await env.CONFIGS.put(`channelshare:${code}`, JSON.stringify(fresh));
      }
    }
  } catch {
    // The ledger already holds the vote; the denormalised copy catches
    // up on the next one rather than this failing the request.
  }
  await updatePublicChannelIndexEntry(env, code, { likes: count }).catch(() => {});
  // The same like in v2 (P3b-8). With reads on v2 the count people see is
  // v2's, which keeps any higher legacy total the copy carried over.
  const v2Likes = await channelsV2MirrorLike(env, code, voterName, liked);
  const shownLikes = isV2ListsReadEnabled(env) && v2Likes != null ? v2Likes : count;
  return json({ ok: true, likes: shownLikes, liked, capped: capped || undefined }, 200, { "Cache-Control": "no-store" });
}

// /api/channel/added  (POST)  { code }
//
// "Someone took this channel." Counted so the directory can rank by what
// people actually use rather than only by what they upvote -- taking a
// channel costs something, so it is the better signal of the two.
//
// Deliberately not a vote: it is a counter, it only goes up, and it is
// best-effort. Nothing is shown to the caller and nothing fails if it
// does not land.
async function apiChannelAdded(request, env, ctx, path) {
  if (!env || !env.CONFIGS) return json({ ok: true });
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: true });
  }
  const code = String(body.code || "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) return json({ ok: true });
  // Counted once per ACCOUNT. A signed-out add is not counted at all (it
  // still succeeds for the person -- this is only the ranking signal), and
  // the same account adding again does not count twice, so the "most
  // added" order reflects real accounts rather than repeated taps.
  if (!body.creatorName || !body.creatorKey) return json({ ok: true, counted: false });
  const addAuth = await authenticateCreatorFor(request, env, ctx, path, body.creatorName, body.creatorKey);
  if (!addAuth.ok) return json({ ok: true, counted: false });
  // FF_V2_LISTS_ONLY (P3b-9): counted in v2 alone.
  if (isV2ListsOnly(env)) {
    return json({ ok: true, counted: await channelsV2Added(env, code, addAuth.username) }, 200, { "Cache-Control": "no-store" });
  }
  const entries = await readPublicChannelIndex(env);
  const row = entries.find((e) => e && e.code === code);
  if (!row) return json({ ok: true, counted: false });
  const addKey = `channeladdvoters:${code}`;
  const adderId = `u:${addAuth.username}`;
  const already = (await readLikeVoters(env, addKey)).includes(adderId);
  if (already) return json({ ok: true, counted: false }, 200, { "Cache-Control": "no-store" });
  await applyLikeVote(env, addKey, adderId, true);
  await updatePublicChannelIndexEntry(env, code, { adds: (Number(row.adds) || 0) + 1 }).catch(() => {});
  await channelsV2MirrorAdd(env, code, addAuth.username);
  return json({ ok: true, counted: true }, 200, { "Cache-Control": "no-store" });
}

// /api/channel/mine  (POST)  { creatorName, creatorKey } -> { ok, channels }
//
// Everything this creator currently has listed in the directory.
//
// Exists because a listing can outlive the local channel it came from:
// deleting a channel in the builder removes this browser's copy, and if
// the withdrawal did not also land -- offline, signed out, a failed
// request -- the listing stayed up with nothing left on the device that
// knew its code. That is an advertised channel its own owner could no
// longer take down. This is how they find it again.
async function apiChannelMine(request, env, ctx, path) {
  if (!env || !env.CONFIGS) return json({ ok: true, channels: [] });
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const auth = await authenticateCreatorFor(request, env, ctx, path, body.creatorName, body.creatorKey);
  if (!auth.ok) return authFailureResponse(auth);
  // From the channels rows once the directory is (P3b-8).
  const v2Mine = await channelsV2Listings(env, auth.username);
  if (v2Mine) return json({ ok: true, channels: v2Mine }, 200, { "Cache-Control": "no-store" });
  if (isV2ListsOnly(env)) return json({ ok: false, error: "Your channels can't be loaded right now." }, 503);
  const entries = await readPublicChannelIndex(env);
  const mine = entries.filter((e) => e && e.owner === auth.username);
  return json({ ok: true, channels: mine }, 200, { "Cache-Control": "no-store" });
}

// /api/channel/unpublish  (POST)  { code, creatorName, creatorKey }
//
// Takes a channel out of the directory. The stored channel itself stays,
// so a link already handed out keeps working -- "stop advertising this"
// and "break everyone's link" are different asks.
async function apiChannelUnpublish(request, env, ctx, path) {
  if (!env || !env.CONFIGS) return json({ ok: false, error: "Sharing isn't available on this add-on." }, 503);
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const auth = await authenticateCreatorFor(request, env, ctx, path, body.creatorName, body.creatorKey);
  if (!auth.ok) return authFailureResponse(auth);
  const code = String(body.code || "").trim();
  if (!code || !/^[A-Za-z0-9_-]{1,64}$/.test(code)) return json({ ok: false, error: "Missing code." }, 400);
  // FF_V2_LISTS_ONLY (P3b-9): in v2 alone.
  if (isV2ListsOnly(env)) {
    const v2 = await channelsV2Unlist(env, code, auth.username);
    return v2.error ? json({ ok: false, error: v2.error }, v2.status) : json({ ok: true });
  }
  let record = null;
  try {
    const raw = await env.CONFIGS.get(`channelshare:${code}`);
    record = raw ? JSON.parse(raw) : null;
  } catch {
    record = null;
  }
  if (!record) return json({ ok: false, error: "No such channel." }, 404);
  if (record.owner && record.owner !== auth.username) {
    return json({ ok: false, error: "That channel belongs to someone else." }, 403);
  }
  record.published = false;
  record.updatedAt = Date.now();
  try {
    await env.CONFIGS.put(`channelshare:${code}`, JSON.stringify(record));
  } catch {}
  await removePublicChannelIndex(env, code).catch(() => {});
  await channelsV2SyncShare(env, code, record);
  return json({ ok: true });
}
