    // --- Creator Profile system --------------------------------------------
    //
    // No accounts, no email, no passwords -- a Creator Profile is just a
    // chosen name plus a randomly generated Creator Key (see
    // generateCreatorKey), with only a salted hash of that key ever stored
    // (see hashCreatorKey/verifyCreatorKey above). There's no session or
    // token issued on "login" either: every authenticated request below
    // re-sends the creatorName + creatorKey and gets re-verified against
    // the stored hash each time, which is what "no authentication system"
    // means here in practice -- simple, stateless, and nothing to expire
    // or revoke separately from the key itself.
    async function authenticateCreator(creatorNameRaw, creatorKey, via) {
      return authenticateCreatorFor(request, env, ctx, path, creatorNameRaw, creatorKey, via);
    }

    // Handles a single "this just started playing" ping from the
    // /:config/subtitles/... route (25_api-catalog-routes.js) -- see
    // buildManifest's comment for the full mechanism. Never throws back
    // to the caller (that route already responded before this runs, via
    // ctx.waitUntil), so every failure path below just records a
    // diagnostic and returns quietly instead.
    //
    // An episode gets marked watched outright: if you're playing it,
    // you're caught up to it -- a discrete, already-aired unit with
    // nothing ambiguous about it. A movie ping gets treated the same way
    // here, marked watched immediately, which is a deliberate
    // simplification versus where this idea started (a similar reference
    // implementation treats a movie ping as merely "in progress," since
    // one ping at the start doesn't prove you finished a 2-hour movie the
    // way starting an episode implies you're caught up to that episode).
    // This addon's Watch History has no in-progress state to put a movie
    // into, only watched/not-watched, so there isn't a cleanly analogous
    // middle ground to preserve that distinction with.
    async function handleSubtitlesTrack(configParam, stremioType, id, env, request) {
      return handleSubtitlesTrackFor(configParam, stremioType, id, env, request, ctx, path);
    }

    // Handles incoming webhooks from Plex, Jellyfin, and Emby media servers
    // Automatically marks watched episodes/movies and advances Continue Watching
    async function handleMediaServerScrobble(request, url, env, ctx) {
      return handleMediaServerScrobbleFor(request, url, env, ctx);
    }

    // --- Sessions API (Phase 3a: P3a-4) ------------------------------------

    // POST /api/session  { username, key } -> { ok, account }
    // Authenticates account credentials via PBKDF2, issues a 256-bit session token,
    // stores its SHA-256 hash in D1 sessions, and sets the mla_session cookie.
    if (path === "/api/session" && request.method === "POST") {
      if (!env || !env.DB) return json({ ok: false, error: "Database unavailable." }, 503);
      let body;
      try {
        body = await request.json();
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
      const auth = await authenticateCreator(usernameRaw, keyRaw);
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
    if (path === "/api/session" && request.method === "DELETE") {
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
    if (path === "/api/me" && request.method === "GET") {
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
    if (path === "/api/me/sessions" && request.method === "GET") {
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
    if (path === "/api/me/sessions" && request.method === "DELETE") {
      if (!request.account || !env || !env.DB) {
        return json({ ok: false, error: "Authentication required." }, 401);
      }
      let body = {};
      try {
        body = await request.json();
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

    // /api/creator/track-status, scrobble-seen-users, create and reset-key, at their original place. Returns a Response, or null.
    // -- 67_creator-api-routes.js.
    const creatorApiAccountResponse = await handleCreatorApiAccountRoutes(request, env, ctx, url, path);
    if (creatorApiAccountResponse) return creatorApiAccountResponse;

    // POST /admin/api/reset-creator-key -- 66_admin-api-feedback-and-tools-routes.js.
    const adminApiResetKeyResponse = await handleAdminApiResetKeyRoute(request, env, ctx, url, path);
    if (adminApiResetKeyResponse) return adminApiResetKeyResponse;

    // /api/creator/recovery-answer ... /lists/save, at their original place after the admin reset-key call. Returns a Response, or null.
    // -- 67_creator-api-routes.js.
    const creatorApiListsResponse = await handleCreatorApiListsRoutes(request, env, ctx, url, path);
    if (creatorApiListsResponse) return creatorApiListsResponse;

    // --- Sharing a channel, and the Explore Channels directory -----------
    //
    // A channel is thousands of episodes; a link is a few hundred characters.
    // So a share link carries a short code and the channel itself lives here
    // under channelshare:{code}, which is also what the directory indexes.
    //
    // Two levels, deliberately distinct, and both need an account
    // (docs/DECISIONS.md D-6):
    //   * a SHARE is unlisted -- anyone with the code can rebuild the
    //     channel, nobody can find it who was not given it.
    //   * PUBLISHING adds it to the Explore Channels directory.
    // Codes minted anonymously before accounts were required keep working
    // for everyone who has them (the GET below needs no account).

    // /api/channel/share  (POST)
    //   { channel, description?, publish?, creatorName?, creatorKey? }
    //     -> { ok, code, url, published }
    if (path === "/api/channel/share" && request.method === "POST") {
      if (!env || !env.CONFIGS) return json({ ok: false, error: "Sharing isn't available on this add-on." }, 503);
      let body;
      try {
        body = await request.json();
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
      const shareAuth = await authenticateCreator(body.creatorName, body.creatorKey);
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
    if (path === "/api/channel/share" && request.method === "GET") {
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
    if (path === "/api/channel/directory" && request.method === "GET") {
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
    if (path === "/api/channel/like" && request.method === "POST") {
      if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" });
      let body;
      try {
        body = await request.json();
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
        const onlyAuth = await authenticateCreator(body.creatorName, body.creatorKey);
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
      const chLikeAuth = await authenticateCreator(body.creatorName, body.creatorKey);
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
    if (path === "/api/channel/added" && request.method === "POST") {
      if (!env || !env.CONFIGS) return json({ ok: true });
      let body;
      try {
        body = await request.json();
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
      const addAuth = await authenticateCreator(body.creatorName, body.creatorKey);
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
    if (path === "/api/channel/mine" && request.method === "POST") {
      if (!env || !env.CONFIGS) return json({ ok: true, channels: [] });
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
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
    if (path === "/api/channel/unpublish" && request.method === "POST") {
      if (!env || !env.CONFIGS) return json({ ok: false, error: "Sharing isn't available on this add-on." }, 503);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const auth = await authenticateCreator(body.creatorName, body.creatorKey);
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

    // /api/creator/lists/delete ... /sync/save-tracking, at their original place after the channel routes. Returns a Response, or null.
    // -- 68_creator-api-account-and-save-routes.js.
    const creatorApiAccountAndSaveResponse = await handleCreatorApiAccountAndSaveRoutes(request, env, ctx, url, path);
    if (creatorApiAccountAndSaveResponse) return creatorApiAccountAndSaveResponse;

    // /api/creator/sync/save-presets ... /sync/share-tracking, directly after the previous creator call. Returns a Response, or null.
    // -- 69_creator-api-sync-routes.js.
    const creatorApiSyncResponse = await handleCreatorApiSyncRoutes(request, env, ctx, url, path);
    if (creatorApiSyncResponse) return creatorApiSyncResponse;

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
    if (path === "/api/search-published-lists") {
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
      } catch (err) {
        return json({ ok: false, error: safeErrorMessage(err) });
      }
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
    m = path.match(/^\/lists\/mdblist\/([^/]+)\/([^/]+)(?:\.json)?$/i);
    if (m) {
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

    m = path.match(/^\/lists\/trakt\/([^/]+)\/([^/]+)(?:\.json)?$/i);
    if (m) {
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

    m = path.match(/^\/lists\/tmdb\/collection\/([0-9]+)(?:-([a-z0-9_-]+))?(?:\.json)?$/i);
    if (m) {
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

    m = path.match(/^\/lists\/tmdb\/([0-9]+)(?:-([a-z0-9_-]+))?(?:\.json)?$/i);
    if (m) {
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

    m = path.match(/^\/lists\/([^/]+)\/([^/]+?)(?:\.json)?$/i);
    if (m) {
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
      if (!listData) {
        return json({ ok: false, error: "No list found at that address." }, 404);
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
          return json({ ok: false, error: "No list found at that address." }, 404);
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

    // --- Admin dashboard (page views / install links generated) -----------
    //
    // Locked behind ADMIN_KEY, a secret set via `wrangler secret put
    // ADMIN_KEY` (or the Cloudflare dashboard) -- never lives in this file.
    // A correct key gets a signed, HttpOnly, Secure, SameSite=Strict cookie
    // scoped to /admin (see makeAdminCookieValue/isValidAdminCookie above),
    // not a bare ?key=... in the URL that would sit around in browser
    // history/logs.
    if (path === "/admin" && request.method === "GET") {

      const authed = await isAdminRequest(request, env);
      if (!authed) {
        return new Response(renderAdminLoginPage("", adminAccessConfigured(env)), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
      }
      const html = await renderAdminDashboard(env);
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }

    // /admin/api/ creators, trending, search index, creator lists, schema,
    // published channels, day counts and the KV export -- 65_admin-api-routes.js.
    const adminApiResponse = await handleAdminApiRoutes(request, env, ctx, url, path);
    if (adminApiResponse) return adminApiResponse;

    // /admin/api/ feedback, support emails, analytics, support goal, site notice,
    // New on Streaming, channel presets -- 66_admin-api-feedback-and-tools-routes.js.
    const adminApiToolsResponse = await handleAdminApiFeedbackAndToolsRoutes(request, env, ctx, url, path);
    if (adminApiToolsResponse) return adminApiToolsResponse;

    if (path === "/admin/login" && request.method === "POST") {
      // P7-2: a valid Cloudflare Access identity signs in without the key. It
      // is checked before the key is looked at, so a deployment with Access on
      // does not need ADMIN_KEY at all.
      const accessIdentity = await adminAccessIdentity(request, env);
      if (accessIdentity) {
        const actor = adminSessionActorForAccess(accessIdentity);
        // A session row is not needed to stay signed in through Access (the
        // JWT is on every request), but it is what makes this sign-in visible
        // in the dashboard's own session list and revocable from it.
        const session = await createAdminSession(env, actor, request);
        await recordAdminAudit(env, request, actor, "admin.login", { target: actor, detail: JSON.stringify({ via: "access" }) }, 302);
        const headers = { "Location": "/admin" };
        if (session) headers["Set-Cookie"] = adminSessionCookieHeader(session.token);
        return new Response(null, { status: 302, headers: headers });
      }
      if (!env || !env.ADMIN_KEY) {
        return new Response(
          renderAdminLoginPage("This Worker has no ADMIN_KEY secret set -- run `wrangler secret put ADMIN_KEY` (or set it in the Cloudflare dashboard) first.", adminAccessConfigured(env)),
          { status: 500, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
        );
      }
      // Every other credential-bearing endpoint in this app (creator
      // create/restore/reset-key) rate-limits guesses by IP -- this one
      // never did, despite guarding the one secret that can rotate any
      // creator's key via /admin/api/reset-creator-key with no other
      // verification. Same pattern as /api/creator/restore: a per-IP
      // counter with a 60s window, in D1 since P7-3 (a KV counter is not a
      // counter: its reads are edge-cached, so a parallel guesser walked
      // straight through it). Failed closed when CF-Connecting-IP is
      // missing, same as restore, because there is no other safe
      // per-client identity to key a shared bucket on.
      // Both budgets are spent BEFORE the key is compared and given back by
      // this when it is right, so only a wrong key keeps its spend (AUTH-002).
      let releaseAdminLogin = async () => {};
      if (env.CONFIGS) {
        const ip = clientIpKey(request);
        if (!ip) {
          return new Response(renderAdminLoginPage("Could not process this request.", adminAccessConfigured(env)), {
            status: 400,
            headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
          });
        }
        // 10 guesses a minute from one address, counted in D1 (P7-3), spent up
        // front and kept only on failure, like the daily budget below it.
        const adminBurst = await reserveRateLimit(env, ctx, "adminlogin", ip, 10, 60);
        if (adminBurst.over) {
          return new Response(renderAdminLoginPage("Too many attempts. Please wait a minute and try again.", adminAccessConfigured(env)), {
            status: 429,
            headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
          });
        }

        // A minute is a very short window, and the address is not the secret:
        // an attacker rotating source IPs is back to a full 10 guesses on each
        // one. This daily budget is what bounds a slow, distributed guess at
        // ADMIN_KEY, and it is spent on failures only.
        const adminDaily = await reserveAuthAttempt(env, `adminlogin:${ip}`, statsToday(), ADMIN_LOGIN_MAX_FAILURES_PER_DAY);
        releaseAdminLogin = async () => { await adminBurst.release(); await adminDaily.release(); };
        if (adminDaily.over) {
          await adminBurst.release();
          return new Response(renderAdminLoginPage("Too many failed attempts today. Please try again tomorrow.", adminAccessConfigured(env)), {
            status: 429,
            headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
          });
        }
      }
      let submittedKey = "";
      try {
        const form = await request.formData();
        submittedKey = String(form.get("key") || "");
      } catch {
        // falls through with an empty key, which will fail the compare below
      }
      // Digests both sides first: ADMIN_KEY is whatever the deployer chose,
      // so its LENGTH is a secret too, and timingSafeEqualHex answers from
      // the length alone before its constant-time loop ever runs.
      if (!(await timingSafeEqualSecret(submittedKey, env.ADMIN_KEY))) {
        // The spends stay: failures only. A correct key gives them back
        // below, or an admin who logs in often would lock themselves out.
        return new Response(renderAdminLoginPage("Incorrect key.", adminAccessConfigured(env)), {
          status: 401,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      await releaseAdminLogin();
      // The key is the break-glass path: a session row when D1 has migration
      // 0018 (so this browser can be signed out on its own), and the old signed
      // expiry it has always been when it does not. Either way the sign-in
      // works -- a migration that has not been applied yet must never lock the
      // owner out of their own dashboard.
      const session = await createAdminSession(env, "key", request);
      const cookieValue = session ? session.token : await makeAdminCookieValue(env);
      await recordAdminAudit(env, request, "key", "admin.login",
        { target: "key", detail: JSON.stringify({ via: "key", revocable: !!session }) }, 302);
      return new Response(null, {
        status: 302,
        headers: {
          "Location": "/admin",
          // Path=/ (not /admin) -- this cookie needs to ride along on
          // fetch() calls the admin dashboard makes to endpoints outside
          // /admin too, e.g. /api/feedback for "Log something yourself"
          // (see isAdminRequest's call there). A browser withholds a
          // cookie entirely from any request whose path doesn't fall
          // under Path, silently, with no error surfaced anywhere --
          // isAdminRequest just always saw no cookie and treated every
          // one of those requests as anonymous, which is what made the
          // public rate limit apply to admin submissions too.
          "Set-Cookie": `${ADMIN_COOKIE_NAME}=${cookieValue}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(ADMIN_SESSION_MS / 1000)}`,
        },
      });
    }

    // /admin/api/admin-sessions, /revoke-admin-session, /audit -- 66_admin-api-feedback-and-tools-routes.js.
    const adminApiSessionResponse = await handleAdminApiSessionRoutes(request, env, ctx, url, path);
    if (adminApiSessionResponse) return adminApiSessionResponse;

    // POST only. A logout that answers a GET is a state change any page can
    // trigger with an <img src>, and while the session cookie is SameSite=Strict
    // (so this was never actually reachable cross-site) that is protection by a
    // property of the cookie rather than by the method being right. The
    // dashboard's own control already posts a form.
    if (path === "/admin/logout" && request.method !== "POST") {
      return new Response(null, { status: 405, headers: { "Allow": "POST", "Cache-Control": "no-store" } });
    }
    if (path === "/admin/logout") {
      // P7-2: the row is revoked, not just the cookie dropped. Dropping the
      // cookie alone would leave a live session that anything able to set the
      // cookie back could carry on using.
      const identity = await resolveAdminIdentity(request, env);
      const revoked = await revokeAdminSessionFromRequest(request, env);
      if (identity) {
        await recordAdminAudit(env, request, identity.actor, "admin.logout",
          { detail: JSON.stringify({ revoked: revoked }) }, 302);
      }
      return new Response(null, {
        status: 302,
        headers: {
          "Location": "/admin",
          // Path must match the cookie's own Path exactly for this to
          // actually clear it -- a Set-Cookie with a different Path is
          // treated as a distinct cookie, not an overwrite of the
          // original.
          "Set-Cookie": `${ADMIN_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
        },
      });
    }

    // /api/bulk-resolve
    // Resolves an array of {title, year} objects to TMDB/IMDB IDs
    // Used by the Letterboxd CSV import
    if (path === "/api/bulk-resolve" && request.method === "POST") {
      // Parsed separately from the work below so a malformed body returns
      // the same 400 + generic message every other route uses, instead of
      // falling into the catch and echoing the raw SyntaxError (which
      // included the caller's own payload) back at HTTP 500.
      let bulkBody;
      try {
        bulkBody = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      if (!bulkBody || !Array.isArray(bulkBody.items)) {
        return json({ ok: false, error: "Expected an `items` array." }, 400);
      }
      // Unauthenticated, and unlike every other TMDB route here this one
      // has no per-user key override at all -- it ALWAYS spends the Worker
      // owner's shared TMDB_API_KEY (see the comment on tmdbCallCount
      // below). Two things were missing:
      //
      // 1. A bound on `items`. The loop below issues up to two TMDB calls
      //    per item, so a single request with a few thousand items blew
      //    straight past Cloudflare's per-invocation subrequest limit --
      //    which meant large Letterboxd imports were already failing here
      //    -- while spending the owner's TMDB quota on the way.
      // 2. A rate limit, so the same request cannot simply be repeated.
      //
      // The cap rejects rather than truncates: silently resolving the
      // first N films of an import and dropping the rest is exactly the
      // kind of quiet data loss this audit was about. The client chunks
      // its own requests to this size (see resolveViaBulkResolve,
      // 18_client-copy-and-trakt-export.js), so a real import of any size
      // still completes -- it just arrives as several bounded calls.
      const bulkIp = clientIpKey(request);
      if (!bulkIp) return json({ ok: false, error: "Could not resolve those titles." }, 400);
      if (bulkBody.items.length > BULK_RESOLVE_ITEMS_MAX) {
        return json({ ok: false, error: `Too many titles in one request (limit ${BULK_RESOLVE_ITEMS_MAX}).` }, 413);
      }
      // The whole request (at most BULK_RESOLVE_ITEMS_MAX titles, ~2 TMDB
      // calls each) is resolved in this one invocation. A server-side budget
      // used to process only as many titles as fit the Workers Free plan's 50
      // subrequests and hand the rest back; the hosted Worker is on Paid.
      const bulkTake = bulkBody.items.length;
      // Charged in TITLES, not requests -- the endpoint always spends the
      // Worker owner's shared TMDB key, and that is what the ceiling is
      // protecting. Counting requests would have cut the effective ceiling
      // from 4,000 titles a minute to 480 the moment the budget above started
      // splitting a request into several.
      if (await consumeRateLimit(env, ctx, "bulkresolve", bulkIp, BULK_RESOLVE_ITEMS_PER_MINUTE, 60, bulkTake)) {
        return json({ ok: false, error: "Too many lookups just now. Please wait a minute and try again." }, 429);
      }
      try {
        const body = bulkBody;
        const items = (body.items || []).slice(0, BULK_RESOLVE_ITEMS_MAX);
        const resolved = [];
        // Always the shared TMDB_API_KEY -- no per-user override on this
        // endpoint. Counted precisely (not just items.length) since a
        // search miss skips the second (external-ids) call.
        let tmdbCallCount = 0;
        // Ten at a time, to be polite to TMDB rather than open 200 connections.
        const BATCH_SIZE = 10;
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
          const batch = items.slice(i, i + BATCH_SIZE);
          const promises = batch.map(async (item) => {
            const q = (item.title || "").trim();
            const y = item.year ? parseInt(item.year, 10) : null;
            if (!q) return null;
            
            // Step 1: Search TMDB
            const searchSrc = `https://api.themoviedb.org/3/search/movie?api_key=${encodeURIComponent(TMDB_API_KEY)}&query=${encodeURIComponent(q)}&include_adult=false${y ? '&primary_release_year=' + y : ''}`;
            tmdbCallCount++;
            const searchRes = await fetch(searchSrc, {
              headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
              cf: { cacheTtl: 86400, cacheEverything: true },
            });
            if (!searchRes.ok) return null;
            const searchData = await searchRes.json();
            const match = (searchData.results || [])[0];
            if (!match) return null;
            
            // Step 2: Get External IDs to find IMDB id
            const extSrc = `https://api.themoviedb.org/3/movie/${match.id}/external_ids?api_key=${encodeURIComponent(TMDB_API_KEY)}`;
            tmdbCallCount++;
            const extRes = await fetch(extSrc, {
              headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
              cf: { cacheTtl: 86400, cacheEverything: true },
            });
            if (!extRes.ok) return null;
            const extData = await extRes.json();
            
            if (extData.imdb_id) {
              return {
                title: match.title || match.original_title || item.title,
                year: match.release_date ? match.release_date.substring(0, 4) : item.year,
                imdbId: extData.imdb_id,
              };
            }
            return null;
          });
          
          const results = await Promise.all(promises);
          for (const res of results) {
            if (res) resolved.push(res);
          }
        }
        if (tmdbCallCount) ctx.waitUntil(bumpStatBy(env, "apiuse:tmdb", tmdbCallCount));
        // `nextIndex` is how many of the SUBMITTED items this invocation got
        // through, so the caller knows where to resume. `done` says there is
        // nothing left of what it sent. Both are additive: a caller that
        // ignores them sees the same { ok, resolved } it always did -- which
        // is why the client also treats a missing nextIndex as "the whole
        // chunk was processed", the behaviour of any older deployment.
        const nextIndex = items.length;
        return json({ ok: true, resolved, nextIndex, done: nextIndex >= bulkBody.items.length });
      } catch (e) {
        // Logged, not returned -- the message can carry upstream URLs and
        // internal detail that the caller has no business seeing.
        console.error("bulk-resolve failed:", e);
        return json({ ok: false, error: "Could not resolve those titles." }, 500);
      }
    }

    return new Response("Not found", { status: 404 });
}

// The actual Worker export. Delegates to handleFetch (25_api-catalog-
// routes.js) for everything, then runs the response back through
// withSecurityHeaders (02_http-and-creator-utils.js) before it goes out --
// see handleFetch's own opening comment for why it's split this way.
export default {
  async fetch(request, env, ctx) {
    let response;
    const startedAt = Date.now();
    // The wrapper always runs (it also answers a key read twice in one request
    // from its first read, see instrumentEnv); the data point is written only
    // when Analytics Engine is bound.
    const counters = env
      ? { kvReads: 0, kvWrites: 0, kvLists: 0, d1Statements: 0, d1Batches: 0, kvLegacyListPuts: 0,
        shareReads: !!request && (request.method === "GET" || request.method === "HEAD") }
      : null;
    const recordMetrics = !!(env && env.ANALYTICS);
    // FF_EVENT_TRACKING: tracking records of accounts served from the
    // activity database are read and written there (40_event-tracking.js).
    const runEnv = eventTrackingEnv(counters ? instrumentEnv(env, counters) : env);
    // P8-1: D1 Read Replication (withSession) for catalog, directory and public list reads.
    const effectiveEnv = isD1ReplicaReadRequest(request) ? withD1ReadSession(runEnv, request) : runEnv;
    // FF_PROVIDER_BREAKER (41_provider-breaker.js).
    configureProviderBreaker(env);
    try {
      response = await schemaWriteGate(request, env);
      if (!response) response = await handleFetch(request, effectiveEnv, ctx);
    } catch (err) {
      // The boundary this file did not have. handleFetch has no top-level
      // try, so any uncaught throw -- a KV put hitting its 1-write-per-second
      // limit, an upstream answering 200 with a truncated body, a bug in a
      // route -- escaped the Worker entirely, and Cloudflare answered with
      // its own 1101 error page: not JSON, no CORS, none of the security
      // headers below. A fetch() in the builder page saw an unparseable
      // response and could only report "check your connection".
      //
      // /api/creator/sync/save already wrapped its own KV write and returned
      // a clean 500; its sibling /api/creator/lists/save did not. One
      // boundary here is worth more than remembering to do that at every
      // future call site.
      //
      // safeErrorMessage logs the original and strips URLs, labelled secrets
      // and long opaque tokens from what goes back.
      // FF_EVENT_TRACKING with DB_ACTIVITY unbound (40_event-tracking.js):
      // the service is unavailable, which is a 503, not a bug.
      if (err && err.code === EVENT_TRACKING_UNAVAILABLE) {
        response = json({ ok: false, error: err.message }, 503, { "Cache-Control": "no-store", "Retry-After": "60" });
      } else {
        const message = safeErrorMessage(err);
        // The engine's own text names tables and columns ("D1_ERROR: no such
        // column ..."): it is logged above, not handed to whoever called.
        const fromDatabase = /\bD1_[A-Z]+|SQLITE_|no such (?:table|column)|constraint failed/i.test(message);
        response = json({ ok: false, error: fromDatabase ? "Something went wrong. Please try again." : message }, 500);
      }
    }
    // Parsed here rather than threaded down from handleFetch, so the answer
    // is the same whether the response came from a route or from the catch
    // above. Guarded because nothing in this boundary may itself throw.
    let privatePath = false;
    try {
      privatePath = isPrivateApiPath(new URL(request.url).pathname);
    } catch {
      // An unparseable URL cannot have reached a private route anyway.
    }
    if (recordMetrics) writeRequestMetrics(env, request, response, startedAt, counters);
    // A breaker this request opened is shared with other isolates, and the
    // provider metrics are written when due. No I/O when there is nothing to do.
    try {
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(providerBreakerFlush(env).catch(() => {}));
    } catch {
      // Never affects the response.
    }
    // One nonce per response (P7-1): it goes into the CSP header and,
    // for an HTML page, into every inline <script>/<style> the page
    // carries -- see withSecurityHeaders and CSP_NONCE_PLACEHOLDER.
    const nonce = cspNonce();
    let sessionBookmark = null;
    if (effectiveEnv && effectiveEnv._d1Session && typeof effectiveEnv._d1Session.getBookmark === "function") {
      try { sessionBookmark = effectiveEnv._d1Session.getBookmark(); } catch {}
    }
    const secured = await withSecurityHeaders(response, privatePath, request ? request._sessionCookie : null, nonce, env, sessionBookmark);
    // Tells the page that this browser holds a live session for the account
    // (one it sent, or one this response hands out), so its next requests can
    // be signed with the session instead of the Account Key (creatorApiFetch,
    // 16_; Release 19). The page cannot see the HttpOnly cookie itself.
    try {
      const p = new URL(request && request.url ? request.url : "https://x/").pathname;
      if (request && request.account && (p.startsWith("/api/creator/") || CREATOR_SESSION_PATH_PREFIXES.some((x) => p.startsWith(x)))) {
        secured.headers.set("X-MLA-Session", String(request.account.username || "").toLowerCase());
      }
    } catch {
      // Never affects the response.
    }
    return secured;
  },

  // Runs on whatever schedule this Worker's owner configured under
  // Triggers -> Cron Triggers in the Cloudflare dashboard (recommended:
  // every 5 minutes, "*/5 * * * *"; the older "*/6 * * * *" works the same).
  //
  // Since Phase 5 (P5-2) a tick is a dispatcher: with the JOBS queue bound it
  // only sends the jobs that are due to the queue (the Continue Watching and
  // Airing Next sweeps, New on Streaming, chart and poster warming, channel
  // presets, housekeeping, and later one-off jobs), and the `queue` export
  // below runs them. Without the queue it does that work itself, exactly as
  // before. runCronTick (45_jobs-dispatcher.js) decides.
  async scheduled(event, env, ctx) {
    // The boundary the fetch handler above has: nothing thrown here may escape
    // the handler, or Cloudflare records the whole invocation as failed and
    // hides which part broke.
    try {
      // Same as the fetch handler above: nothing that runs below may see an
      // empty API key just because this isolate's first event happened to be
      // a cron tick rather than a request. See applyEnvApiKeys.
      applyEnvApiKeys(env);
      configureProviderBreaker(env);
      // FF_EVENT_TRACKING, as in the fetch handler above.
      env = eventTrackingEnv(env);
      await runCronTick(event, env, ctx);
    } catch (err) {
      console.error("[Cron] scheduled() failed:", err);
    }
  },

  // Background jobs (Phase 5): the consumer of the mylists-jobs queue. It is
  // set up on the queue in the dashboard (Queues -> mylists-jobs -> Settings
  // -> Consumers -> this Worker; docs/OPERATIONS.md section 18). Each message
  // names its job type, and runJobsQueue (44_jobs-queue.js) runs its handler.
  async queue(batch, env, ctx) {
    await runJobsQueue(batch, env, ctx);
  },

  // Cloudflare Email Routing: receives incoming emails to support@mylistsaddon.com (59_support-emails.js)
  async email(message, env, ctx) {
    try {
      await handleIncomingEmail(message, env, ctx);
    } catch (err) {
      console.error("[Email] email() handler failed:", err);
    }
  },
};
