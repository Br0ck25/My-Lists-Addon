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

    // --- Sessions API (Phase 3a: P3a-4) ------------------------------------

    // /api/session (sign in and out), /api/me and /api/me/sessions, at their original place. Returns a Response promise, or null.
    // -- 79_session-and-channel-routes.js.
    const sessionResponse = handleSessionRoutes(request, env, ctx, url, path);
    if (sessionResponse) return sessionResponse;

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

    // /api/channel/share, directory, like, added, mine and unpublish, at their original place. Returns a Response promise, or null.
    // -- 79_session-and-channel-routes.js.
    const channelResponse = handleChannelRoutes(request, env, ctx, url, path);
    if (channelResponse) return channelResponse;

    // /api/creator/lists/delete ... /sync/save-tracking, at their original place after the channel routes. Returns a Response, or null.
    // -- 68_creator-api-account-and-save-routes.js.
    const creatorApiAccountAndSaveResponse = await handleCreatorApiAccountAndSaveRoutes(request, env, ctx, url, path);
    if (creatorApiAccountAndSaveResponse) return creatorApiAccountAndSaveResponse;

    // /api/creator/sync/save-presets ... /sync/share-tracking, directly after the previous creator call. Returns a Response, or null.
    // -- 69_creator-api-sync-routes.js.
    const creatorApiSyncResponse = await handleCreatorApiSyncRoutes(request, env, ctx, url, path);
    if (creatorApiSyncResponse) return creatorApiSyncResponse;

    // /api/search-published-lists and the /lists/mdblist, /lists/trakt, /lists/tmdb and /lists/<user>/<slug> pages and feeds, at their original place. Returns a Response promise, or null.
    // -- 73_public-list-routes.js.
    const publishedListResponse = handlePublishedListRoutes(request, env, ctx, url, path);
    if (publishedListResponse) return publishedListResponse;

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
