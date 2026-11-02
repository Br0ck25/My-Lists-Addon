// The web app's home and shell pages, the /admin page and sign-in/sign-out, and /api/bulk-resolve, moved out of handleFetch (CQ-01).

// Moved unchanged: each route body is now its own function; the dispatchers keep each route's
// original path/method test and are plain functions that return a Response promise or null.
// The admin routes check their own login (isAdminRequest / the admin key), exactly as before.

// The home page, the app shell paths and the shell sub-tab pages, at their original place. Returns a Response promise, or null.
function handleAppShellRoutes(request, env, ctx, url, path) {
  if (path === "/" || path === "") return appHomePage(request, env, ctx, url);
  if (APP_SHELL_PATHS.has(path)) return appShellPage(request, env, ctx, url);
  return appShellTabPage(request, env, ctx, url, path);
}

// A sub-tab below a shell path (/settings/account, /catalogs/quickadd): the old `for (const shellTab of APP_SHELL_TABS)` loop that
// followed the branch above, moved unchanged except that it is a function now. It is not async so it can return null at once
// when the path is not a sub-tab (a promise would always be truthy); a match returns the page promise the loop used to await.
function appShellTabPage(request, env, ctx, url, path) {
  for (const shellTab of APP_SHELL_TABS) {
    if (path.indexOf(shellTab.path + "/") !== 0) continue;
    const shellSub = path.slice(shellTab.path.length + 1);
    if (shellTab.subs.indexOf(shellSub) === -1) continue;
    ctx.waitUntil(bumpStat(env, "pageviews"));
    return htmlPageResponse(request, renderPageCached(request, url.origin, {}));
  }
  return null;
}

async function appHomePage(request, env, ctx, url) {
  ctx.waitUntil(bumpStat(env, "pageviews"));
  // Memoized per origin and answered with a 304 when the browser
  // already holds this exact build -- see htmlPageResponse and
  // renderBuilderCached (02_http-and-creator-utils.js). Previously this
  // rebuilt and resent ~1.6MB on every navigation, with no validator at
  // all, which also left the browser free to heuristically cache a copy
  // it had no way to check.
  return await htmlPageResponse(request, renderPageCached(request, url.origin, {}));
}

// The new UI shell's own paths (Phase 6, P6-1): /catalogs, /lists,
// /channels, /discover, /search, /settings and a sub-tab below any of them
// (/settings/account, /catalogs/quickadd).
//
// Exact paths only: /lists/<slug> and /channels/<user>/<slug> are share
// links and keep their own routes below.
async function appShellPage(request, env, ctx, url) {
  ctx.waitUntil(bumpStat(env, "pageviews"));
  return await htmlPageResponse(request, renderPageCached(request, url.origin, {}));
}

// GET /admin (the dashboard or the sign-in form), at its original place. Returns a Response promise, or null.
function handleAdminPageRoute(request, env, ctx, url, path) {
  if (path === "/admin" && request.method === "GET") return adminDashboardPage(request, env);
  return null;
}

// --- Admin dashboard (page views / install links generated) -----------
//
// Locked behind ADMIN_KEY, a secret set via `wrangler secret put
// ADMIN_KEY` (or the Cloudflare dashboard) -- never lives in this file.
// A correct key gets a signed, HttpOnly, Secure, SameSite=Strict cookie
// scoped to /admin (see makeAdminCookieValue/isValidAdminCookie above),
// not a bare ?key=... in the URL that would sit around in browser
// history/logs.
async function adminDashboardPage(request, env) {

  const authed = await isAdminRequest(request, env);
  if (!authed) {
    return new Response(renderAdminLoginPage("", adminAccessConfigured(env)), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  }
  const html = await renderAdminDashboard(env);
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

// POST /admin/login, at its original place. Returns a Response promise, or null.
function handleAdminLoginRoute(request, env, ctx, url, path) {
  if (path === "/admin/login" && request.method === "POST") return adminLoginPost(request, env, ctx);
  return null;
}

async function adminLoginPost(request, env, ctx) {
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

// /admin/logout and /api/bulk-resolve, at their original place. Returns a Response promise, or null.
function handleAdminLogoutAndBulkResolveRoutes(request, env, ctx, url, path) {
  if (path === "/admin/logout" && request.method !== "POST") return adminLogoutWrongMethod();
  if (path === "/admin/logout") return adminLogoutPost(request, env);
  if (path === "/api/bulk-resolve" && request.method === "POST") return apiBulkResolve(request, env, ctx);
  return null;
}

// POST only. A logout that answers a GET is a state change any page can
// trigger with an <img src>, and while the session cookie is SameSite=Strict
// (so this was never actually reachable cross-site) that is protection by a
// property of the cookie rather than by the method being right. The
// dashboard's own control already posts a form.
async function adminLogoutWrongMethod() {
  return new Response(null, { status: 405, headers: { "Allow": "POST", "Cache-Control": "no-store" } });
}

async function adminLogoutPost(request, env) {
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
async function apiBulkResolve(request, env, ctx) {
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
        // One bad title or one failed TMDB call must not lose the whole batch.
        try {
        if (!item || typeof item !== "object") return null;
        const q = String(item.title || "").trim();
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
        } catch {
          return null;
        }
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
