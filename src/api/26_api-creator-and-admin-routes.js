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

    // GET /admin (the dashboard or the sign-in form), at its original place. Returns a Response promise, or null.
    // -- 80_shell-admin-entry-and-bulk-resolve-routes.js.
    const adminPageResponse = handleAdminPageRoute(request, env, ctx, url, path);
    if (adminPageResponse) return adminPageResponse;

    // /admin/api/ creators, trending, search index, creator lists, schema,
    // published channels, day counts and the KV export -- 65_admin-api-routes.js.
    const adminApiResponse = await handleAdminApiRoutes(request, env, ctx, url, path);
    if (adminApiResponse) return adminApiResponse;

    // /admin/api/ feedback, support emails, analytics, support goal, site notice,
    // New on Streaming, channel presets -- 66_admin-api-feedback-and-tools-routes.js.
    const adminApiToolsResponse = await handleAdminApiFeedbackAndToolsRoutes(request, env, ctx, url, path);
    if (adminApiToolsResponse) return adminApiToolsResponse;

    // POST /admin/login, at its original place. Returns a Response promise, or null.
    // -- 80_shell-admin-entry-and-bulk-resolve-routes.js.
    const adminLoginResponse = handleAdminLoginRoute(request, env, ctx, url, path);
    if (adminLoginResponse) return adminLoginResponse;

    // /admin/api/admin-sessions, /revoke-admin-session, /audit -- 66_admin-api-feedback-and-tools-routes.js.
    const adminApiSessionResponse = await handleAdminApiSessionRoutes(request, env, ctx, url, path);
    if (adminApiSessionResponse) return adminApiSessionResponse;

    // /admin/logout and /api/bulk-resolve, at their original place. Returns a Response promise, or null.
    // -- 80_shell-admin-entry-and-bulk-resolve-routes.js.
    const adminLogoutAndBulkResolveResponse = handleAdminLogoutAndBulkResolveRoutes(request, env, ctx, url, path);
    if (adminLogoutAndBulkResolveResponse) return adminLogoutAndBulkResolveResponse;

    return notFoundForPeople(request, path, () => new Response("Not found", { status: 404 }));
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
        // SEC-03 step 0: a session renewed by this request gets its cookie renewed too.
        if (isForgetKeyEnabled(env)) secured.headers.set("X-MLA-Forget-Key", "1");
        const renewalCookie = sessionCookieRenewal(request);
        if (renewalCookie && !secured.headers.has("Set-Cookie")) secured.headers.set("Set-Cookie", renewalCookie);
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
      // Counts this isolate is still holding (PERF-04) go to D1 on every tick.
      await flushPendingStats(env);
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
    await flushPendingStats(env); // counts this isolate still holds (PERF-04)
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
