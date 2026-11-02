// --- router ---------------------------------------------------------------
//
// This is the real fetch handler, but it isn't the exported one -- see the
// export default { fetch(...) {...} } wrapper at the very end of
// 26_api-creator-and-admin-routes.js (this function's body actually spans
// both files; build.ps1 just concatenates them back into one). The wrapper
// exists purely to run every response back through withSecurityHeaders
// (02_http-and-creator-utils.js) on the way out, without needing to touch
// any of the dozens of individual `new Response(...)` call sites below.
// /api/poster-badge only ever receives a `poster` value this add-on put
// there itself (see applyBadgedPostersToMetas, 05_catalog-core.js) --
// every source fetcher resolves posters to one of these three image hosts
// (TMDB, the Cinemeta/metahub IMDb-poster fallback, or Simkl's own
// artwork host); nothing in this codebase ever lets a user supply a raw
// poster URL. A request that names any other host, or a non-https scheme,
// isn't a real poster -- it's someone probing the endpoint directly, and
// gets rejected before either the redirect or the fetch further down.
// What a catalog answer carries when it is not a real answer: its provider
// failed, or the install or row is not there. A good shared row is cached five
// minutes; these (last good copy, the "temporarily unavailable" tile, an empty
// page) used to take jsonPublic's one-hour default, so a short outage, or a
// link not yet visible where the app asked, lasted an hour in the apps.
const CATALOG_NO_CACHE = { "Cache-Control": "no-store" };
// How long an app may reuse a row before asking again (Workers requests are
// billed per call, and a home screen asks once per row). Shared rows (charts,
// streaming shelves, public lists) change slowly; a Creator list row is the
// account's own and is re-read on every request, so it gets a short window: an
// edit made on the website shows in the apps within this many seconds. The
// same number goes in the body as Stremio's own cacheMaxAge, which Stremio
// honours and plain Cache-Control it largely ignores. Personal shelves
// (watch history, Continue Watching and the like) stay no-store.
const CATALOG_SHARED_MAX_AGE = 1800;
const CATALOG_LIVE_LIST_MAX_AGE = 90;
const CATALOG_STALE_REVALIDATE = 86400;

// What /api/save refuses to store, so a bad row cannot become a manifest the
// apps reject. The id is a catalog id in a URL path (/catalog/<type>/<id>.json),
// so it has no slash or space; the type is a catalog type. The builder always
// sends both (it also de-duplicates ids), so only a hand-made or very old
// request is turned away. Returns a message, or "" when every row is fine.
function saveEntriesProblem(entries) {
  for (const e of entries) {
    if (!e || typeof e !== "object" || Array.isArray(e)) return "Every list needs to be a list row.";
    if (typeof e.id !== "string" || !e.id || e.id.length > 100 || /[\/\s]/.test(e.id)) {
      return "A list is missing a usable id.";
    }
    if (e.type !== "movie" && e.type !== "series") return "A list's type has to be movie or series.";
  }
  return "";
}

const POSTER_IMAGE_HOSTS = new Set([
  "image.tmdb.org",
  "images.metahub.space",
  "simkl.in",
  // BetterPosters. This set is "hosts this add-on itself puts in a poster
  // field", and with the Better Posters setting on, it does. Missing here,
  // /api/poster-badge 404s the moment a badge is drawn over BetterPosters
  // artwork -- which is every Airing Next and Continue Watching tile, the
  // two rows that always carry a badge, while unbadged rows looked fine.
  "btttr.cc",
]);

// `origin` is this Worker's own origin. The safe-poster tile is this add-on's
// own route, so it counts only on that origin: matched by path alone it let
// any host through (an open redirect and an open image proxy).
function isAllowedPosterUrl(raw, origin) {
  let u;
  try {
    u = new URL(String(raw || ""));
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.origin === origin && u.pathname.startsWith("/api/safe-poster")) return true;
  return POSTER_IMAGE_HOSTS.has(u.hostname.toLowerCase());
}

// Finished badged posters, per isolate (P8-4). Each one carries its poster's
// bytes (see /api/poster-badge on why), so the cache is bounded by size, not
// by count: 500 of them was up to ~150 MB, past an isolate's 128 MB. The key
// is the request's query string, which carries the day (`d=`), so a date
// pill never outlives its day.
const BADGED_POSTER_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const BADGED_POSTER_CACHE_ENTRY_MAX_BYTES = 1024 * 1024;
const BADGED_POSTER_CACHE = new Map();
let badgedPosterCacheBytes = 0;

function rememberBadgedPoster(key, svg) {
  const size = svg.length;
  if (size > BADGED_POSTER_CACHE_ENTRY_MAX_BYTES) return;
  if (BADGED_POSTER_CACHE.has(key)) {
    badgedPosterCacheBytes -= BADGED_POSTER_CACHE.get(key).length;
    BADGED_POSTER_CACHE.delete(key);
  }
  while (BADGED_POSTER_CACHE.size && badgedPosterCacheBytes + size > BADGED_POSTER_CACHE_MAX_BYTES) {
    const oldest = BADGED_POSTER_CACHE.keys().next().value;
    badgedPosterCacheBytes -= BADGED_POSTER_CACHE.get(oldest).length;
    BADGED_POSTER_CACHE.delete(oldest);
  }
  BADGED_POSTER_CACHE.set(key, svg);
  badgedPosterCacheBytes += size;
}

// Bytes -> base64 a chunk at a time, not a character at a time.
function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// --- badged poster as a real image (Stremio) --------------------------------
// Stremio cannot draw an SVG poster, so with the Cloudflare Images binding
// (env.IMAGES) the badges are laid over the poster as a JPEG instead. The
// pills and fades are small PNGs made right here; the words are drawn by
// Images itself from a bold font. All in the 500x750 space the SVG uses.
const BADGE_FONT_URL = "https://cdn.jsdelivr.net/fontsource/fonts/roboto@5.0.8/latin-700-normal.woff";
let badgePngCrcTable = null;

function badgePngCrc(bytes) {
  if (!badgePngCrcTable) {
    badgePngCrcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      badgePngCrcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = badgePngCrcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// RGBA pixels (w*h*4) -> PNG bytes.
async function encodeBadgePng(w, h, rgba) {
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }
  const zipped = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, badgePngCrc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const idv = new DataView(ihdr.buffer);
  idv.setUint32(0, w);
  idv.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zipped), chunk("IEND", new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((n, a) => n + a.length, 0));
  let off = 0;
  for (const a of parts) { png.set(a, off); off += a.length; }
  return png;
}

function badgeHexRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// A rounded pill, optionally outlined, with soft (anti-aliased) edges.
function badgePillPng(w, h, radius, fillHex, fillOpacity, borderHex, borderOpacity, borderWidth) {
  const rgba = new Uint8Array(w * h * 4);
  const fill = badgeHexRgb(fillHex);
  const border = borderHex ? badgeHexRgb(borderHex) : null;
  const cover = (d) => Math.max(0, Math.min(1, 0.5 - d));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const qx = Math.abs(x + 0.5 - w / 2) - (w / 2 - radius);
      const qy = Math.abs(y + 0.5 - h / 2) - (h / 2 - radius);
      const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
      const inside = cover(d);
      if (!inside) continue;
      let col = fill;
      let alpha = Number(fillOpacity);
      if (border && -d < borderWidth) {
        col = border;
        alpha = Number(borderOpacity);
      }
      const i = (y * w + x) * 4;
      rgba[i] = col[0]; rgba[i + 1] = col[1]; rgba[i + 2] = col[2];
      rgba[i + 3] = Math.round(255 * alpha * inside);
    }
  }
  return encodeBadgePng(w, h, rgba);
}

// Black fade, top-to-bottom: from topAlpha to bottomAlpha.
function badgeFadePng(w, h, topAlpha, bottomAlpha) {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const a = Math.round(255 * (topAlpha + (bottomAlpha - topAlpha) * (y / (h - 1))));
    for (let x = 0; x < w; x++) rgba[(y * w + x) * 4 + 3] = a;
  }
  return encodeBadgePng(w, h, rgba);
}

// A w x h clear strip with the words centred on it.
async function badgeTextPng(env, w, h, text, size, color) {
  const clear = await encodeBadgePng(w, h, new Uint8Array(w * h * 4));
  const res = (await env.IMAGES.input(new Blob([clear]).stream())
    .draw(env.IMAGES.text(String(text), { font: { url: BADGE_FONT_URL }, size, color }))
    .output({ format: "image/png" })).response();
  return new Uint8Array(await res.arrayBuffer());
}

// Same inputs as generateBadgedPosterSvg (plus the poster's bytes); returns a
// JPEG Response, or throws so the caller can fall back to the SVG.
async function renderBadgedPosterJpeg(env, posterBytes, o) {
  const draws = [];
  const top = String(o.airDateText || "").toUpperCase();
  const time = top ? String(o.airTimeText || "").toUpperCase() : "";
  const bottom = String(o.bottomText || "");
  if (top) {
    draws.push([await badgeFadePng(500, 220, 0.85 * 0.85, 0), { top: 0, left: 0 }]);
    if (time) {
      const w = Math.max(170, Math.round(Math.max(top.length * 25, time.length * 22) + 60));
      draws.push([await badgePillPng(w, 96, 16, "#007aff", 0.96, "#ffffff", 0.25, 2), { top: 20, left: 20 }]);
      draws.push([await badgeTextPng(env, w, 44, top, 32, "#ffffff"), { top: 24, left: 20 }]);
      draws.push([await badgeTextPng(env, w, 40, time, 28, "#ffffff"), { top: 68, left: 20 }]);
    } else {
      const w = Math.max(160, Math.round(top.length * 26 + 56));
      draws.push([await badgePillPng(w, 72, 16, "#007aff", 0.96, "#ffffff", 0.25, 2), { top: 20, left: 20 }]);
      draws.push([await badgeTextPng(env, w, 72, top, 34, "#ffffff"), { top: 20, left: 20 }]);
    }
  }
  if (bottom) {
    draws.push([await badgeFadePng(500, 310, 0, 0.95 * 0.95), { top: 440, left: 0 }]);
    const w = Math.min(460, Math.max(340, Math.round(bottom.length * 24 + 64)));
    const bg = parseSvgColor(o.bottomBg || "#28a745", o.bottomBgOpacity || "0.95");
    const border = parseSvgColor(o.bottomBorder, o.bottomBorderOpacity || "0.7");
    const left = Math.round((500 - w) / 2);
    draws.push([await badgePillPng(w, 84, 18, bg.color, bg.opacity, border.isNone ? null : border.color, border.opacity, 3.5), { top: 631, left }]);
    draws.push([await badgeTextPng(env, w, 84, bottom, 36, o.bottomColor || "#ffffff"), { top: 631, left }]);
  }
  let img = env.IMAGES.input(new Blob([posterBytes]).stream()).transform({ width: 500, height: 750, fit: "cover" });
  for (const [bytes, pos] of draws) img = img.draw(env.IMAGES.input(new Blob([bytes]).stream()), pos);
  const res = (await img.output({ format: "image/jpeg", quality: 88 })).response({
    headers: {
      "Cache-Control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
      ...corsHeaders(),
    },
  });
  if (!String(res.headers.get("Content-Type") || "").startsWith("image/jpeg")) throw new Error("not a jpeg");
  return res;
}


// The service worker, hoisted to module scope for one reason: a string inside
// a route handler is unreachable, and `node --check` on the combined Worker
// sees this whole thing as string content either way. As a module-level
// binding it can be pulled out of a vm sandbox and syntax-checked like any
// other emitted script -- which is exactly the gap that let a SyntaxError sit
// in the admin page for two days. See tools/render_check.js --sw.
//
// Two caches, because the two kinds of thing here have opposite needs.
//
// /app.js?v=<hash> and /app.css?v=<hash> are content-addressed: a change gets
// a different URL, so cache-first is safe by construction and the cache is
// never consulted for a version it does not hold.
//
// The page itself is NOT content-addressed. It is served no-cache with an
// ETag, and it is the thing that NAMES the current bundle hash. Cache-first on
// it would pin yesterday's page, which names yesterday's bundle, and hold the
// whole app a deploy behind -- the precise failure the versioned URLs exist to
// prevent. So the page is network-first: the network wins whenever it answers,
// and the copy in the cache is reached only when it does not.
//
// What this buys, stated honestly: the app OPENS offline instead of showing
// the browser's error page. It does not work offline -- every API call still
// fails, and the app shows the error states it already had. Since P7-1 the
// zip reader is this origin's own file and is cached like the two above, so
// reading a Trakt or Letterboxd export no longer needs the network; the fonts
// are the device's own (no third-party origin left in the page at all).
const SERVICE_WORKER_JS = `
const ASSETS = 'mylists-assets-v4';
const SHELL = 'mylists-shell-v4';
const SHELL_URL = '/';
const KEEP = [ASSETS, SHELL];

self.addEventListener('install', (e) => e.waitUntil((async () => {
  // Warm the page now, so the first offline load works rather than only one
  // that happens to follow an online visit. Failure here is not fatal: the
  // navigation handler caches it on the next successful load anyway.
  try {
    const cache = await caches.open(SHELL);
    await cache.add(new Request(SHELL_URL, { cache: 'reload' }));
  } catch (err) {}
  await self.skipWaiting();
})()));

self.addEventListener('activate', (e) => e.waitUntil((async () => {
  // Anything from an older naming scheme is orphaned the moment this
  // activates, so drop it rather than leave it on the user's disk.
  try {
    for (const name of await caches.keys()) {
      if (KEEP.indexOf(name) === -1) await caches.delete(name);
    }
  } catch (err) {}
  await self.clients.claim();
})()));

function isImmutableAsset(url) {
  // /vendor/<versioned name> is the same contract as the two above: the
  // version is in the path, so a bump is a new URL and a cached copy can
  // never be stale. That is what makes the zip reader work offline (P7-1).
  return ((url.pathname === '/app.js' || url.pathname === '/app-features.js' || url.pathname === '/app.css')
    && !!url.searchParams.get('v'))
    || url.pathname.indexOf('/vendor/') === 0;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try {
    url = new URL(req.url);
  } catch (err) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (isImmutableAsset(url)) {
    e.respondWith((async () => {
      try {
        const cache = await caches.open(ASSETS);
        const key = url.pathname + url.search;
        const hit = await cache.match(key);
        if (hit) return hit;
        const res = await fetch(req);
        if (res && res.ok) {
          // One entry per asset, not one entry total: this cache now holds two
          // different files, and pruning everything would evict the other one
          // on every deploy. A previous hash for THIS path is dead weight the
          // moment it stops being asked for.
          for (const k of await cache.keys()) {
            if (new URL(k.url).pathname === url.pathname) await cache.delete(k);
          }
          await cache.put(key, res.clone());
        }
        return res;
      } catch (err) {
        // A cache that misbehaves must never be able to break the page. When
        // it is the network that failed, this rethrows exactly as it would
        // have with no service worker at all.
        return fetch(req);
      }
    })());
    return;
  }

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        // The browser's own request, untouched: a rebuilt one follows redirects itself, and a sign-in redirect then fails.
        const res = await fetch(req);
        // Only the plain page is worth keeping. A deep link renders
        // per-request data, and replaying yesterday's copy of it later would
        // be worse than not answering.
        if (res && res.ok && url.pathname === SHELL_URL && !url.search) {
          try {
            const cache = await caches.open(SHELL);
            await cache.put(SHELL_URL, res.clone());
          } catch (err) {}
        }
        return res;
      } catch (err) {
        const cache = await caches.open(SHELL);
        const cached = await cache.match(SHELL_URL);
        if (cached) return cached;
        throw err;
      }
    })());
  }
});
`.trim();

// What Trakt said when it refused a request with 429, in a few words for the
// person and for a screenshot: Cloudflare's own block (error 1015, on Trakt's
// side, aimed at the address the request came from), or Trakt's limit by name
// (its X-Ratelimit header), and how long it asked to wait.
function traktLimitNote(res, text, retrySec) {
  const parts = [];
  if (/\b1015\b/.test(String(text || ""))) parts.push("Cloudflare 1015");
  try {
    const rl = JSON.parse((res && res.headers && res.headers.get("X-Ratelimit")) || "null");
    if (rl && rl.name) parts.push(String(rl.name).slice(0, 60));
  } catch {}
  const wait = Number(retrySec) || 0;
  parts.push(wait >= 120 ? `wait about ${Math.round(wait / 60)} minutes` : `wait ${wait || 2} seconds`);
  return parts.join(", ");
}

async function handleFetch(request, env, ctx) {
    // Point the env-backed API key globals (00_constants.js) at whatever
    // this Worker owner configured, before anything can read them. A feature
    // whose key is unset degrades to a clear in-app message rather than
    // crashing -- see each key's usage for that message.
    applyEnvApiKeys(env);

    const url = new URL(request.url);
    // A v2 install link, /i/{token}/..., is handed to the same manifest,
    // catalog, meta, subtitles and configure routes as a legacy id, with the
    // token as its config segment (see v2InstallPath, 27_installs.js).
    const path = v2InstallPath(url.pathname) || url.pathname;

    // ?ff_new_ui=1 (or 0) used to switch between the classic page and the new
    // interface. The classic page is retired (Release 21): a link that still
    // carries it bounces to the same address without it (appShellSwitchResponse,
    // 02_). Handled before anything else so it works from any page of the site.
    if (request.method === "GET" || request.method === "HEAD") {
      const shellSwitch = appShellSwitchResponse(url);
      if (shellSwitch) return shellSwitch;
    }

    if (request.method === "OPTIONS") {
      if (isPublicCorsPath(path)) {
        return new Response(null, { headers: corsHeaders() });
      }
      return new Response(null, { status: 204 });
    }

    // CSRF protection for mutating requests (P3a-5)
    const csrfErr = verifyCsrf(request);
    if (csrfErr) return csrfErr;

    // Resolve session if mla_session cookie or Bearer token is present
    const sessionAuth = await resolveSession(request, env);
    if (sessionAuth) {
      request.account = sessionAuth.account;
      request.session = sessionAuth.session;
    }

    // /api/installs (an account's install links) and the admin status of the
    // install move -- 27_installs.js.
    const installsResponse = await handleInstallsApi(request, env, url, path);
    if (installsResponse) return installsResponse;
    // /api/connections (an account's Trakt, MDBList, Simkl and TMDB
    // connections) -- 28_connections.js.
    const connectionsResponse = await handleConnectionsApi(request, env, url, path);
    if (connectionsResponse) return connectionsResponse;
    // /admin/api/jobs/* (the background job queue: is it bound, and a test
    // job's round trip) -- 44_jobs-queue.js.
    const jobsAdminResponse = await handleJobsAdminApi(request, env, url, path);
    if (jobsAdminResponse) return jobsAdminResponse;
    // /api/lists (the item-level list API over the v2 tables, behind
    // FF_V2_LISTS_API) -- 31_lists-api.js. The legacy /api/lists/like and
    // /api/lists/like-external routes below are left to answer as they do.
    const listsApiResponse = await handleListsApi(request, env, url, path);
    if (listsApiResponse) return listsApiResponse;
    // /api/likes/{list|channel|external}/{id} (likes over the v2 tables, behind
    // the same flag) -- 32_likes-api.js.
    const likesApiResponse = await handleLikesApi(request, env, url, path);
    if (likesApiResponse) return likesApiResponse;
    // /api/imports (imports resolved by a background job, P5-6) --
    // 49_imports.js.
    const importsResponse = await handleImportsApi(request, env, url, path);
    if (importsResponse) return importsResponse;
    // DELETE /api/me (deleting an account in the background, P5-8) --
    // 51_account-purge.js.
    const accountDeleteResponse = await handleAccountDeleteApi(request, env, url, path);
    if (accountDeleteResponse) return accountDeleteResponse;

    if (path === "/" || path === "") {
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
    if (APP_SHELL_PATHS.has(path)) {
      ctx.waitUntil(bumpStat(env, "pageviews"));
      return await htmlPageResponse(request, renderPageCached(request, url.origin, {}));
    }
    for (const shellTab of APP_SHELL_TABS) {
      if (path.indexOf(shellTab.path + "/") !== 0) continue;
      const shellSub = path.slice(shellTab.path.length + 1);
      if (shellTab.subs.indexOf(shellSub) === -1) continue;
      ctx.waitUntil(bumpStat(env, "pageviews"));
      return await htmlPageResponse(request, renderPageCached(request, url.origin, {}));
    }

    // /icon.png, poster placeholders, /bp/, /rpdb/, support goal, site notice, Ko-fi webhook, RPDB check, Better Posters warm-up and poster badge, at their original place. Returns a Response promise, or null.
    // -- 71_poster-and-support-routes.js.
    const posterAndSupportResponse = handlePosterAndSupportRoutes(request, env, ctx, url, path);
    if (posterAndSupportResponse) return posterAndSupportResponse;

    // /:config/configure, /channel/<code> and /configure, at their original place. Returns a Response promise, or null.
    // -- 70_stremio-routes.js.
    const installConfigureResponse = handleInstallConfigureRoutes(request, env, ctx, url, path);
    if (installConfigureResponse) return installConfigureResponse;

    // /lists/public.json, /lists/curated/<slug>, /lists/<slug>, provider list pages and /channels/..., at their original place. Returns a Response promise, or null.
    // -- 73_public-list-routes.js.
    const publicListPageResponse = handlePublicListPageRoutes(request, env, ctx, url, path);
    if (publicListPageResponse) return publicListPageResponse;

    // /:config/manifest.json, /manifest.json and /:config/subtitles/..., at their original place. Returns a Response promise, or null.
    // -- 70_stremio-routes.js.
    const stremioManifestResponse = handleStremioManifestRoutes(request, env, ctx, url, path);
    if (stremioManifestResponse) return stremioManifestResponse;

    // /app.webmanifest, /robots.txt, /sitemap.xml, /guide, the fflate vendor file, /app.css, /app.js, /app-features.js and /sw.js, at their original place. Returns a Response promise, or null.
    // -- 72_static-asset-routes.js.
    const staticAssetResponse = handleStaticAssetRoutes(request, env, ctx, url, path);
    if (staticAssetResponse) return staticAssetResponse;

    // /:config/catalog/:type/:id.json, at its original place. Returns a Response promise, or null.
    // -- 70_stremio-routes.js.
    const stremioCatalogResponse = handleStremioCatalogRoute(request, env, ctx, url, path);
    if (stremioCatalogResponse) return stremioCatalogResponse;

    // CSP reports, /api/track-install, /api/preview and /api/channel-poster, at their original place. Returns a Response promise, or null.
    // -- 74_lookup-and-preview-routes.js.
    const previewResponse = handlePreviewRoutes(request, env, ctx, url, path);
    if (previewResponse) return previewResponse;

    // /api/scrobble and /:config/meta/:type/:id.json, at their original place. Returns a Response promise, or null.
    // -- 70_stremio-routes.js.
    const scrobbleAndMetaResponse = handleScrobbleAndMetaRoutes(request, env, ctx, url, path);
    if (scrobbleAndMetaResponse) return scrobbleAndMetaResponse;

    // /api/channel-logo, /api/toplists, /api/season, the title, poster, show, channel and person lookups and /api/resolve-movie and -show, at their original place. Returns a Response promise, or null.
    // -- 74_lookup-and-preview-routes.js.
    const lookupResponse = handleLookupRoutes(request, env, ctx, url, path);
    if (lookupResponse) return lookupResponse;

    // /api/imdb-ids, /api/recommendations, the TMDB and Trakt list search/browse routes and the Trakt, MDBList and Simkl OAuth start/callback, device-code and my-lists routes, at their original place. Returns a Response promise, or null.
    // -- 75_provider-list-and-oauth-routes.js.
    const providerListResponse = handleProviderListRoutes(request, env, ctx, url, path);
    if (providerListResponse) return providerListResponse;

    // /api/external-list/*, /api/external-sync/history and the TMDB OAuth and my-lists routes, at their original place. Returns a Response promise, or null.
    // -- 76_external-list-routes.js.
    const externalListResponse = handleExternalListRoutes(request, env, ctx, url, path);
    if (externalListResponse) return externalListResponse;


    // /api/trakt-my-private-lists, /api/trakt-history-raw, /api/feedback*, /api/track-search, /api/track-event, /api/mdblist-my-lists and /api/mdblist-history-raw, at their original place. Returns a Response promise, or null.
    // -- 77_my-lists-history-and-feedback-routes.js.
    const myListsAndFeedbackResponse = handleMyListsAndFeedbackRoutes(request, env, ctx, url, path);
    if (myListsAndFeedbackResponse) return myListsAndFeedbackResponse;

    // /api/resolve?config=...
    // -> powers "Import from a link" in the builder page. Reuses the same
    // resolveConfig() the manifest/configure routes already use (handles
    // both a short KV id and a legacy self-contained base64 blob), just
    // returned as plain JSON instead of a manifest or an HTML page -- so
    // pasting an existing install/configure link can rebuild the same rows
    // client-side via addRow(), the same way importing a config JSON blob
    // does.
    if (path === "/api/resolve") {
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
    if (path === "/api/save" && request.method === "POST") {
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
        let saveAuth = await authenticateCreator(claimed, sessionHeld ? "" : trackKey, "trackkey");
        if (saveAuth.ok && sessionHeld && trackKey) saveAuth = await authenticateCreator(claimed, trackKey, "trackkey");
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
        const accountAuth = await authenticateCreator(body.creatorName, body.creatorKey);
        if (accountAuth.ok) saveAccount = accountAuth.username;
        else if (accountAuth.throttled) return authFailureResponse(accountAuth);
      }
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
    if (path === "/api/list-live/save" && request.method === "POST") {
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

    if (path === "/api/lists/like" && request.method === "POST") {
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
      const likeAuth = await authenticateCreator(likeBody.creatorName, likeBody.creatorKey);
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

    if (path === "/api/lists/like-external" && request.method === "POST") {
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
      const extAuth = await authenticateCreator(body.creatorName, body.creatorKey);
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
    if (path === "/api/details/batch" && request.method === "POST") {
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
    if (path === "/api/details") {
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

