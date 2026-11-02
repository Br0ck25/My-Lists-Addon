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

    // The home page, the app shell paths and the shell sub-tab pages, at their original place. Returns a Response promise, or null.
    // -- 80_shell-admin-entry-and-bulk-resolve-routes.js.
    const appShellResponse = handleAppShellRoutes(request, env, ctx, url, path);
    if (appShellResponse) return appShellResponse;

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

    // /api/resolve, /api/save, /api/list-live/save, /api/lists/like, /api/lists/like-external, /api/details/batch and /api/details, at their original place. Returns a Response promise, or null.
    // -- 78_save-and-like-routes.js.
    const saveAndLikeResponse = handleSaveAndLikeRoutes(request, env, ctx, url, path);
    if (saveAndLikeResponse) return saveAndLikeResponse;

