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

// The sync payload's tag is its versionHash, so a launcher that sends it back
// (If-None-Match) gets a bare 304 instead of the whole payload when nothing
// changed. If-None-Match can carry a list and a cache may weaken a tag, so each
// entry is compared with any W/ prefix removed, as htmlPageResponse (05_) does.
function nuvioTvSyncResponse(request, payload, versionHash, cacheControl) {
  const etag = `"${versionHash}"`;
  const headers = { ...corsHeaders(), "Cache-Control": cacheControl, "ETag": etag };
  const inm = request && request.headers ? (request.headers.get("If-None-Match") || "") : "";
  if (inm && inm.split(",").map((t) => t.trim().replace(/^W\//, "")).some((t) => t === etag || t === "*")) {
    return new Response(null, { status: 304, headers });
  }
  return jsonPublic(payload, 200, headers);
}

// What this Worker offers a launcher beyond the original sync payload, so it asks only for what
// exists instead of probing and backing off on a 404. Add a name when a launcher-facing feature
// is added; never remove one a released launcher may rely on.
const NUVIO_TV_SERVER_FEATURES = ["etag", "schedule", "schedules"];

// GET /api/nuvio-tv/sync/:target -- unified sync route for Nuvio TV Launcher
async function buildNuvioTvSyncDefaultResponse(url, request) {
  const defaultConfig = typeof buildNuvioTvDefaultConfig === "function" ? buildNuvioTvDefaultConfig() : {};
  const manifestUrl = `${url.origin}/nuvio-default/tv/manifest.json`;
  const collectionsUrl = `${url.origin}/api/nuvio-tv/collections/default`;
  const catalogIds = defaultConfig.catalogIds || defaultConfig.catalogOrder || [];
  const catalogOrder = defaultConfig.catalogOrder || catalogIds;
  const collections = defaultConfig.collections || [];
  const channels = defaultConfig.channels || [];
  const randomizeItemsDaily = true;
  const updatedAt = 0;

  const payloadToHash = JSON.stringify({ catalogIds, collections, channels, randomizeItemsDaily, updatedAt });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payloadToHash));
  const versionHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

  return nuvioTvSyncResponse(request, {
    ok: true,
    versionHash,
    manifestUrl,
    collectionsUrl,
    randomizeItemsDaily: true,
    catalogIds,
    catalogOrder,
    collections,
    channels,
    features: NUVIO_TV_SERVER_FEATURES,
  }, versionHash, "public, max-age=300");
}

function formatNuvioUserCollections(userCollections) {
  if (!Array.isArray(userCollections) || !userCollections.length) {
    return typeof PREMADE_COLLECTIONS !== "undefined" ? PREMADE_COLLECTIONS : [];
  }
  const userFolders = userCollections.map((col) => {
    const tileShape = col.tileShape || "LANDSCAPE";
    const name = col.name || col.title || "User Collection";
    const fallbackCover = tileShape === "POSTER"
      ? `https://mylistsaddon.com/api/channel-poster?name=${encodeURIComponent(name)}&v=6`
      : `https://mylistsaddon.com/api/channel-poster?name=${encodeURIComponent(name)}&format=landscape&v=6`;
    return {
      id: col.id || `folder_${Math.random().toString(36).slice(2, 8)}`,
      title: name,
      name: name,
      tileShape: tileShape,
      hideTitle: !!col.hideTitle,
      coverImageUrl: col.coverImageUrl || fallbackCover,
      hidden: false,
      isVisible: true,
      enabled: true,
      catalogSources: (col.lists || []).map((l) => ({
        addonId: l.addonId || "app.my-list.collections",
        catalogId: l.catalogId || (typeof slugifyServer === "function" ? slugifyServer(l.url || l.name || "") : (l.name || "catalog")),
        name: (l.name || "").replace(/\s*\((?:movies?|shows?|series|tv)\)\s*$/ig, "").trim(),
        title: (l.name || "").replace(/\s*\((?:movies?|shows?|series|tv)\)\s*$/ig, "").trim(),
        type: l.type || "movie",
      })),
    };
  });
  return [
    {
      id: "my-lists-collections",
      title: "My Lists Collections",
      name: "My Lists Collections",
      viewMode: "FOLLOW_LAYOUT",
      showAllTab: false,
      pinToTop: false,
      focusGlowEnabled: true,
      backdropImageUrl: "/icon.png",
      hidden: false,
      isVisible: true,
      enabled: true,
      folders: userFolders,
    },
    ...(typeof PREMADE_COLLECTIONS !== "undefined" ? PREMADE_COLLECTIONS : []),
  ];
}

function formatNuvioUserChannels(userChannelsRaw) {
  if (userChannelsRaw) {
    let raw = userChannelsRaw;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      if (raw.channels && typeof raw.channels === "object") {
        raw = raw.channels;
      }
    }
    const list = Array.isArray(raw) ? raw : (typeof raw === "object" && raw ? Object.values(raw) : []);
    const valid = list.filter((ch) => ch && typeof ch === "object" && !Array.isArray(ch) && (ch.name || ch.channelName || ch.id || ch.channelId));
    if (valid.length) {
      return valid.map((ch, i) => {
        const id = String(ch.id || ch.channelId || `ch_${i + 1}`);
        const name = ch.name || ch.channelName || `Channel ${i + 1}`;
        const posterCandidate = ch.posterUrl || ch.poster || "";
        const posterUrl = posterCandidate || `https://mylistsaddon.com/api/channel-poster?name=${encodeURIComponent(name)}&v=6`;

        let backdropCandidate = ch.backdropUrl || ch.backdrop || "";
        if (backdropCandidate && (backdropCandidate === posterUrl || backdropCandidate === posterCandidate || backdropCandidate === ch.poster)) {
          backdropCandidate = "";
        }
        if (!backdropCandidate && Array.isArray(ch.items)) {
          const itemWithBackdrop = ch.items.find((it) => it && (it.backdrop || it.showBackdrop || it.thumbnail) &&
            it.backdrop !== posterUrl && it.showBackdrop !== posterUrl && it.thumbnail !== posterUrl &&
            it.backdrop !== posterCandidate && it.showBackdrop !== posterCandidate && it.thumbnail !== posterCandidate);
          if (itemWithBackdrop) {
            backdropCandidate = itemWithBackdrop.backdrop || itemWithBackdrop.showBackdrop || itemWithBackdrop.thumbnail;
          }
        }
        let backdropUrl = backdropCandidate || `https://mylistsaddon.com/api/channel-poster?name=${encodeURIComponent(name)}&format=landscape&v=6`;
        if (backdropUrl.includes("/api/channel-poster") && !backdropUrl.includes("format=landscape")) {
          backdropUrl = backdropUrl.includes("?") ? `${backdropUrl}&format=landscape` : `${backdropUrl}?format=landscape`;
        }

        let logoUrl = null;
        const logoPath = ch.logoPath || (typeof extractLogoPath === "function" ? extractLogoPath(ch.logo || "") : "");
        if (logoPath) {
          logoUrl = `https://mylistsaddon.com/api/channel-logo?path=${encodeURIComponent(logoPath)}&v=7`;
        } else if (ch.networkId || ch.presetNetworkId) {
          logoUrl = `https://mylistsaddon.com/api/channel-logo?netId=${ch.networkId || ch.presetNetworkId}&v=7`;
        } else {
          const rawLogo = ch.logoUrl || ch.logo;
          const isPosterLogo = rawLogo && (rawLogo === posterUrl || rawLogo === posterCandidate || rawLogo === ch.poster);
          if (rawLogo && !isPosterLogo && (rawLogo.includes("clearlogo") || rawLogo.includes("/logo") || rawLogo.endsWith(".svg") || rawLogo.endsWith(".png") || rawLogo.includes("/api/channel-logo"))) {
            logoUrl = rawLogo;
          }
        }

        return {
          id: id,
          name: name,
          poster: posterUrl,
          posterUrl: posterUrl,
          backdrop: backdropUrl,
          backdropUrl: backdropUrl,
          logoUrl: logoUrl || null,
          category: ch.category || "My Lists Addon Channels",
          catalogId: ch.catalogId || (id.startsWith("channel_") ? id : `channel_${id}`),
          playOrder: typeof ch.playOrder === "number" ? ch.playOrder : (i + 1),
        };
      });
    }
  }
  return typeof buildNuvioDefaultChannels === "function" ? buildNuvioDefaultChannels() : [];
}

function parseNuvioInstRowConfig(instRow, username, updatedAt) {
  if (!instRow || !instRow.config_json) return null;
  try {
    const p = JSON.parse(instRow.config_json);
    const list = Array.isArray(p) ? p : (p.entries || p.config || p.lists || []);
    return {
      entries: list,
      lists: list,
      ...(typeof readInstallConfigFields === "function" && typeof p === "object" ? readInstallConfigFields(p) : {}),
      randomizeItemsDaily: p.randomizeItemsDaily !== undefined ? p.randomizeItemsDaily : true,
      shuffleItems: true,
      trackOwner: username,
      trackCreatorName: username,
      updatedAt: instRow.updated_at || updatedAt,
    };
  } catch {
    return null;
  }
}

async function resolveNuvioTvTargetData(target, env) {
  let resolved = null;
  let installToken = target;
  let username = "";
  let updatedAt = 0;

  if (env && env.DB) {
    try {
      const acct = await env.DB.prepare(
        "SELECT id, username, key_hash, created_at, last_active_at FROM accounts WHERE username = ? OR id = ? OR key_hash = ? LIMIT 1"
      ).bind(target, target, target).first();
      if (acct) {
        username = acct.username;
        updatedAt = acct.last_active_at || acct.created_at || 0;
        const instRow = await env.DB.prepare(
          "SELECT legacy_cfg_id, token_hash, config_json, updated_at FROM installs WHERE account_id = ? AND revoked_at IS NULL ORDER BY updated_at DESC LIMIT 1"
        ).bind(acct.id).first();
        if (instRow) {
          installToken = instRow.legacy_cfg_id || instRow.token_hash || String(instRow.id);
          if (instRow.updated_at && instRow.updated_at > updatedAt) updatedAt = instRow.updated_at;
          resolved = parseNuvioInstRowConfig(instRow, username, updatedAt);
        }
        if (!resolved) {
          resolved = { entries: [], lists: [], randomizeItemsDaily: true, shuffleItems: true, trackOwner: username, trackCreatorName: username, updatedAt };
        }
      } else {
        const instRow = await env.DB.prepare(
          "SELECT account_id, legacy_cfg_id, token_hash, config_json, updated_at FROM installs WHERE (legacy_cfg_id = ? OR token_hash = ? OR id = ?) AND revoked_at IS NULL LIMIT 1"
        ).bind(target, target, target).first();
        if (instRow) {
          if (instRow.updated_at && instRow.updated_at > updatedAt) updatedAt = instRow.updated_at;
          if (instRow.account_id) {
            const linkedAcct = await env.DB.prepare(
              "SELECT id, username, last_active_at, created_at FROM accounts WHERE id = ? LIMIT 1"
            ).bind(instRow.account_id).first();
            if (linkedAcct) {
              username = linkedAcct.username;
              if (linkedAcct.last_active_at || linkedAcct.created_at) {
                updatedAt = Math.max(updatedAt, linkedAcct.last_active_at || linkedAcct.created_at);
              }
            }
          }
          resolved = parseNuvioInstRowConfig(instRow, username, updatedAt);
        }
      }
    } catch (e) {
      console.error("nuvio tv sync: DB account lookup failed:", e);
    }
  }

  if (!username && env && env.CONFIGS && target && target !== "default") {
    try {
      const directSync = await env.CONFIGS.get(`creatorsync:${target}`);
      if (directSync) username = target;
    } catch {}
  }

  if (!resolved) {
    try {
      resolved = await resolveConfig(target, env, { withTracking: true });
      if (resolved && resolved.unresolved) resolved = null;
    } catch {}
    if (!resolved && target.length === 43) {
      try {
        resolved = await resolveConfig("i-" + target, env, { withTracking: true });
        if (resolved && resolved.unresolved) resolved = null;
      } catch {}
    }
    if (resolved && !username) {
      if (resolved.trackOwner) {
        username = resolved.trackOwner;
      } else if (resolved.ownerId && env && env.DB) {
        try {
          const oAcct = await env.DB.prepare("SELECT username, created_at, last_active_at FROM accounts WHERE id = ? LIMIT 1").bind(resolved.ownerId).first();
          if (oAcct && oAcct.username) {
            username = oAcct.username;
            if (oAcct.last_active_at || oAcct.created_at) {
              updatedAt = Math.max(updatedAt, oAcct.last_active_at || oAcct.created_at);
            }
          }
        } catch {}
      }
    }
  }

  if (username && env && env.CONFIGS) {
    try {
      const creatorConfig = typeof resolveCreatorSyncConfig === "function" ? await resolveCreatorSyncConfig(username, env, { isTvLauncher: true }) : null;
      if (creatorConfig && Array.isArray(creatorConfig.entries)) {
        resolved = creatorConfig;
        updatedAt = Math.max(updatedAt, creatorConfig.updatedAt || 0);
      }
    } catch (e) {
      console.error("nuvio tv sync: creatorsync lookup failed:", e);
    }
  }

  if (username && env && env.DB) {
    try {
      const inst = await env.DB.prepare(
        "SELECT legacy_cfg_id, token_hash FROM installs WHERE account_id = (SELECT id FROM accounts WHERE username = ? COLLATE NOCASE LIMIT 1) AND revoked_at IS NULL ORDER BY updated_at DESC LIMIT 1"
      ).bind(username).first();
      if (inst) {
        installToken = inst.legacy_cfg_id || inst.token_hash || username;
      }
    } catch {}
  }

  return { resolved, installToken: installToken || username || target, username, updatedAt };
}

async function handleNuvioTvCollectionsRoute(request, env, ctx, url, path) {
  const isDefaultPath = path === "/nuvio-default/collections.json";
  const isApiPrefix = path === "/api/nuvio-tv/collections" || path.indexOf("/api/nuvio-tv/collections/") === 0;
  if (!isDefaultPath && !isApiPrefix) return null;

  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ ok: false, error: "Method not allowed." }, 405, corsHeaders());
  }

  let target = "default";
  if (isDefaultPath) {
    target = "default";
  } else if (path.indexOf("/api/nuvio-tv/collections/") === 0) {
    target = path.slice("/api/nuvio-tv/collections/".length).trim();
  } else if (path === "/api/nuvio-tv/collections") {
    target = (url.searchParams.get("target") || "").trim() || "default";
  }
  if (!target || target === ":target") target = "default";

  if (target === "default") {
    const defaultConfig = typeof buildNuvioTvDefaultConfig === "function" ? buildNuvioTvDefaultConfig() : {};
    const collections = defaultConfig.collections || [];
    return jsonPublic({ ok: true, collections }, 200, {
      ...corsHeaders(),
      "Cache-Control": "public, max-age=300",
    });
  }

  const { resolved, username } = await resolveNuvioTvTargetData(target, env);
  if (!resolved) {
    return json({ ok: false, error: "Target not found." }, 404, { ...corsHeaders(), "Cache-Control": "no-store" });
  }

  let userCollections = null;
  if (username && env && env.CONFIGS) {
    try {
      const storedPresets = await env.CONFIGS.get(`creatorsyncpresets:${username}`);
      if (storedPresets) {
        const parsedPresets = JSON.parse(storedPresets);
        if (Array.isArray(parsedPresets.customCollections) && parsedPresets.customCollections.length) {
          userCollections = parsedPresets.customCollections;
        }
      }
    } catch {}
  }
  const formattedCollections = formatNuvioUserCollections(userCollections);
  return jsonPublic({ ok: true, collections: formattedCollections }, 200, {
    ...corsHeaders(),
    "Cache-Control": "public, max-age=300",
  });
}

function buildNuvioTvLinkPageCss() {
  return `* { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--color-bg-canvas); color: var(--color-text-primary); font-family: var(--font-body);
    min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 20px;
  }
  .card {
    background: var(--color-bg-surface); border: 1px solid var(--color-border-subtle); border-radius: var(--radius);
    padding: 32px 28px; max-width: 440px; width: 100%; box-shadow: var(--shadow-md); text-align: center;
  }
  .logo {
    display: inline-flex; align-items: center; justify-content: center; width: 56px; height: 56px;
    border-radius: var(--radius-md); background: var(--color-brand-subtle); border: 1px solid var(--color-brand-line);
    font-size: 28px; margin-bottom: 16px;
  }
  h1 { font-size: 22px; font-weight: 700; margin-bottom: 8px; color: var(--color-text-primary); }
  p.sub { font-size: 14px; color: var(--color-text-muted); margin-bottom: 24px; line-height: 1.5; }
  .code-box {
    background: var(--color-bg-sunken); border: 1.5px dashed var(--color-border-strong); border-radius: var(--radius-sm);
    padding: 16px; margin-bottom: 24px;
  }
  .code-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-text-muted); font-weight: 600; }
  .code-val { font-size: 28px; font-weight: 800; letter-spacing: 0.15em; color: var(--color-brand); margin-top: 4px; font-family: var(--font-mono); }
  .user-pill { font-size: 13px; color: var(--color-text-muted); margin-top: 6px; }
  .user-pill strong { color: var(--color-text-primary); }
  .btn {
    display: inline-block; width: 100%; padding: 13px 20px; border-radius: var(--radius-pill); font-size: 15px;
    font-weight: 600; border: none; cursor: pointer; transition: background var(--duration-base) var(--ease); text-decoration: none;
  }
  .btn-primary { background: var(--color-brand-fill); color: var(--color-on-brand); }
  .btn-primary:hover { background: var(--color-brand-fill-hover); }
  .btn-secondary { background: var(--color-bg-sunken); color: var(--color-text-primary); border: 1px solid var(--color-border-subtle); margin-top: 10px; }
  .btn-secondary:hover { background: var(--color-bg-elevated); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .input-field {
    width: 100%; padding: 12px 14px; background: var(--color-bg-sunken); border: 1px solid var(--color-border-subtle);
    border-radius: var(--radius-sm); color: var(--color-text-primary); font-size: 14px; margin-bottom: 12px; outline: none;
  }
  .input-field:focus { border-color: var(--color-border-focus); }
  .error-msg { color: var(--color-danger); font-size: 13px; margin-top: 12px; }
  .success-box {
    background: var(--color-brand-subtle); border: 1px solid var(--color-brand-line);
    border-radius: var(--radius-sm); padding: 20px; margin-bottom: 20px;
  }
  .success-icon { font-size: 40px; color: var(--color-brand); margin-bottom: 8px; }
  .success-title { font-size: 18px; font-weight: 700; color: var(--color-brand); margin-bottom: 6px; }
  .success-desc { font-size: 13px; color: var(--color-text-muted); line-height: 1.4; }
  .switch-mode-btn { background: none; border: none; color: var(--color-text-muted); font-size: 13px; cursor: pointer; text-decoration: underline; margin-top: 14px; }
  .switch-mode-btn:hover { color: var(--color-text-primary); }`;
}

function buildNuvioTvLinkPageAuthJs() {
  return `var regSubmitBtn = document.getElementById('regSubmitBtn');
    if (regSubmitBtn) {
      regSubmitBtn.addEventListener('click', async function() {
        var u = (document.getElementById('regUsername').value || '').trim();
        var r = (document.getElementById('regRecovery').value || '').trim();
        if (!u) { showError('Please choose a username.'); return; }
        if (!code) { showError('Missing pairing code.'); return; }
        showError(''); regSubmitBtn.disabled = true; regSubmitBtn.textContent = 'Creating Account\u2026';
        try {
          var regRes = await fetch('/api/creator/account/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u, recoveryAnswer: r, source: 'nuvio_tv' })
          });
          var regData = await regRes.json();
          if (!regData || !regData.ok) {
            showError((regData && regData.error) || 'Account registration failed.');
            regSubmitBtn.disabled = false; regSubmitBtn.textContent = 'Create Account & Link TV';
            return;
          }
          try {
            localStorage.setItem('myListAddon:creatorName', regData.username || u);
            if (regData.key) localStorage.setItem('myListAddon:creatorKey', regData.key);
          } catch (e) {}

          regSubmitBtn.textContent = 'Linking TV\u2026';
          var claimData = await claimTv(code, regData.username || u, regData.key);
          if (claimData && claimData.ok) {
            actionArea.style.display = 'none'; successBox.style.display = 'block';
          } else {
            showError((claimData && claimData.error) || 'Account created, but linking TV failed. Please retry.');
            regSubmitBtn.disabled = false; regSubmitBtn.textContent = 'Link TV';
          }
        } catch (err) {
          showError('Network error connecting to server.'); regSubmitBtn.disabled = false; regSubmitBtn.textContent = 'Create Account & Link TV';
        }
      });
    }

    var loginSubmitBtn = document.getElementById('loginSubmitBtn');
    if (loginSubmitBtn) {
      loginSubmitBtn.addEventListener('click', async function() {
        var u = (document.getElementById('loginUsername').value || '').trim();
        var k = (document.getElementById('loginKey').value || '').trim();
        if (!u || !k) { showError('Please enter username and key.'); return; }
        if (!code) { showError('Missing pairing code.'); return; }
        showError(''); loginSubmitBtn.disabled = true; loginSubmitBtn.textContent = 'Signing In\u2026';
        try {
          var logRes = await fetch('/api/creator/account/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u, key: k })
          });
          var logData = await logRes.json();
          if (!logData || !logData.ok) {
            showError((logData && logData.error) || 'Login failed. Check credentials.');
            loginSubmitBtn.disabled = false; loginSubmitBtn.textContent = 'Sign In & Link TV';
            return;
          }
          try {
            localStorage.setItem('myListAddon:creatorName', logData.username || u);
            localStorage.setItem('myListAddon:creatorKey', k);
          } catch (e) {}

          loginSubmitBtn.textContent = 'Linking TV\u2026';
          var claimData = await claimTv(code, logData.username || u, k);
          if (claimData && claimData.ok) {
            actionArea.style.display = 'none'; successBox.style.display = 'block';
          } else {
            showError((claimData && claimData.error) || 'Signed in, but linking TV failed. Please retry.');
            loginSubmitBtn.disabled = false; loginSubmitBtn.textContent = 'Link TV';
          }
        } catch (err) {
          showError('Network error connecting to server.'); loginSubmitBtn.disabled = false; loginSubmitBtn.textContent = 'Sign In & Link TV';
        }
      });
    }`;
}

function buildNuvioTvLinkPageJs(codeParam) {
  const authJs = buildNuvioTvLinkPageAuthJs();
  return `(function() {
    var code = ${JSON.stringify(codeParam)};
    if (!code) {
      var sp = new URLSearchParams(window.location.search || '');
      code = (sp.get('code') || sp.get('tv_code') || '').trim().toUpperCase();
    }
    var codeDisplay = document.getElementById('tvCodeDisplay');
    if (code && codeDisplay) codeDisplay.textContent = code;

    var userPill = document.getElementById('userPill');
    var signedInView = document.getElementById('signedInView');
    var registerView = document.getElementById('registerView');
    var loginView = document.getElementById('loginView');
    var successBox = document.getElementById('successBox');
    var actionArea = document.getElementById('actionArea');
    var errorMsg = document.getElementById('errorMsg');

    function showError(msg) {
      if (!errorMsg) return;
      errorMsg.textContent = msg || '';
      errorMsg.style.display = msg ? 'block' : 'none';
    }

    var storedUser = '';
    var storedKey = '';
    try {
      storedUser = localStorage.getItem('myListAddon:creatorDisplayName') || localStorage.getItem('myListAddon:creatorName') || '';
      storedKey = localStorage.getItem('myListAddon:creatorKey') || '';
    } catch (e) {}

    function applyUserView(username) {
      storedUser = username;
      if (storedUser) {
        userPill.innerHTML = 'Signed in as <strong>' + storedUser.replace(/</g, '&lt;') + '</strong>';
        signedInView.style.display = 'block';
        registerView.style.display = 'none';
        loginView.style.display = 'none';
      } else {
        userPill.innerHTML = 'Not signed in';
        registerView.style.display = 'block';
        signedInView.style.display = 'none';
        loginView.style.display = 'none';
      }
    }

    if (storedUser) {
      applyUserView(storedUser);
    } else {
      fetch('/api/me', { credentials: 'same-origin' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data && data.ok && data.account && data.account.username) {
            applyUserView(data.account.displayName || data.account.username);
          } else {
            applyUserView('');
          }
        })
        .catch(function() { applyUserView(''); });
    }

    var showLoginBtn = document.getElementById('showLoginBtn');
    if (showLoginBtn) {
      showLoginBtn.addEventListener('click', function() {
        showError(''); registerView.style.display = 'none'; loginView.style.display = 'block';
      });
    }

    var showRegBtn = document.getElementById('showRegBtn');
    if (showRegBtn) {
      showRegBtn.addEventListener('click', function() {
        showError(''); loginView.style.display = 'none'; registerView.style.display = 'block';
      });
    }

    async function claimTv(userCode, username, key) {
      var res = await fetch('/api/nuvio-tv/device/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ userCode: userCode, creatorName: username, creatorKey: key })
      });
      return await res.json();
    }

    var confirmLinkBtn = document.getElementById('confirmLinkBtn');
    if (confirmLinkBtn) {
      confirmLinkBtn.addEventListener('click', async function() {
        if (!code) { showError('Missing pairing code.'); return; }
        showError(''); confirmLinkBtn.disabled = true; confirmLinkBtn.textContent = 'Linking TV\u2026';
        try {
          var data = await claimTv(code, storedUser, storedKey);
          if (data && data.ok) {
            actionArea.style.display = 'none'; successBox.style.display = 'block';
          } else {
            showError((data && data.error) || 'Failed to link TV. Please verify the code on your TV.');
            confirmLinkBtn.disabled = false; confirmLinkBtn.textContent = 'Link TV Now';
          }
        } catch (err) {
          showError('Network error connecting to server.'); confirmLinkBtn.disabled = false; confirmLinkBtn.textContent = 'Link TV Now';
        }
      });
    }

    ${authJs}
  })();`;
}

function handleNuvioTvLinkPage(request, env, ctx, url, path) {
  const codeParam = (url.searchParams.get("code") || url.searchParams.get("tv_code") || "").trim().toUpperCase();
  const safeCode = escapeHtmlServer(codeParam);
  const css = buildNuvioTvLinkPageCss();
  const js = buildNuvioTvLinkPageJs(codeParam);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Link Nuvio TV Launcher &bull; My Lists Addon</title>
  <script nonce="${CSP_NONCE_PLACEHOLDER}">try { if (localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && matchMedia('(prefers-color-scheme: dark)').matches)) document.documentElement.classList.add('dark-theme'); } catch (e) {}<\/script>
  <style nonce="${CSP_NONCE_PLACEHOLDER}">
${DESIGN_TOKENS_CSS}
${css}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">&#128250;</div>
    <h1>Link Nuvio TV Launcher</h1>
    <p class="sub">Connect your My Lists Addon account to sync your Catalogs, Collections, and Channels to your TV.</p>

    <div class="code-box">
      <div class="code-label">Pairing Code</div>
      <div class="code-val" id="tvCodeDisplay">${safeCode || "&mdash;"}</div>
      <div class="user-pill" id="userPill">Checking account status&hellip;</div>
    </div>

    <div class="success-box" id="successBox" style="display:none;">
      <div class="success-icon">&#x2713;</div>
      <div class="success-title">TV Linked Successfully!</div>
      <div class="success-desc">Your Catalogs, Collections, and Live TV Channels have synced to your TV screen. You can now return to your TV.</div>
      <a href="/" class="btn btn-primary" style="margin-top:16px;">Open My Lists Addon</a>
    </div>

    <div id="actionArea">
      <div id="signedInView" style="display:none;">
        <button type="button" class="btn btn-primary" id="confirmLinkBtn">Link TV Now</button>
        <a href="/" class="btn btn-secondary">Cancel</a>
      </div>

      <div id="registerView" style="display:none;">
        <input type="text" id="regUsername" class="input-field" placeholder="Choose a Username" maxlength="25">
        <input type="text" id="regRecovery" class="input-field" placeholder="Recovery Answer (optional, 8+ chars)">
        <button type="button" class="btn btn-primary" id="regSubmitBtn">Create Account &amp; Link TV</button>
        <div><button type="button" class="switch-mode-btn" id="showLoginBtn">Already have an account? Sign in</button></div>
      </div>

      <div id="loginView" style="display:none;">
        <input type="text" id="loginUsername" class="input-field" placeholder="Account Username">
        <input type="password" id="loginKey" class="input-field" placeholder="Account Key or Password">
        <button type="button" class="btn btn-primary" id="loginSubmitBtn">Sign In &amp; Link TV</button>
        <div><button type="button" class="switch-mode-btn" id="showRegBtn">Need an account? Create one</button></div>
      </div>
    </div>

    <div class="error-msg" id="errorMsg" style="display:none;"></div>
  </div>

  <script nonce="${CSP_NONCE_PLACEHOLDER}">${js}<\/script>
</body>
</html>`;
  return pageResponseWithBody(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function handleNuvioTvHistoryRemove(env, username, body) {
  await ensureTrackingMigrated(env, username);
  const syncKey = `creatorsynctracking:${username}`;
  let blob = null;
  if (env.DB) {
    try { blob = await readCreatorTrackingD1(env, username); } catch {}
  }
  if (!blob) {
    try {
      const raw = await env.CONFIGS.get(syncKey);
      if (raw) blob = JSON.parse(raw);
    } catch {}
  }
  if (!blob || typeof blob !== "object") {
    blob = { watchHistory: [], continueWatching: [], fullyWatchedShowIds: [], dismissedContinueWatching: {}, watchlist: [] };
  }
  blob.watchHistory = Array.isArray(blob.watchHistory) ? blob.watchHistory : [];

  const rawType = String((body && body.type) || "").toLowerCase();
  const contentId = String((body && (body.contentId || body.id)) || "").trim();
  const imdbId = String((body && body.imdbId) || (contentId.startsWith("tt") ? contentId.split(":")[0] : "")).trim();
  const tmdbId = body && body.tmdbId != null ? String(body.tmdbId).trim() : (!contentId.startsWith("tt") && /^\d+/.test(contentId) ? contentId.split(":")[0] : "");
  let season = body && body.season != null ? Number(body.season) : null;
  let episode = body && body.episode != null ? Number(body.episode) : null;
  if ((season == null || episode == null) && contentId.includes(":")) {
    const parts = contentId.split(":");
    if (parts.length >= 3) {
      season = Number(parts[1]);
      episode = Number(parts[2]);
    }
  }

  const isSeries = rawType === "series" || rawType === "tv" || season != null || episode != null;
  if (isSeries) {
    if (season != null && episode != null) {
      blob.watchHistory = blob.watchHistory.filter((it) => {
        if (!it) return false;
        const matchesShow = (imdbId && (it.showId === imdbId || it.id === imdbId)) ||
          (tmdbId && (it.showId === tmdbId || it.showId === `tmdb:${tmdbId}`)) ||
          (contentId && (it.showId === contentId || it.id === contentId));
        const matchesEp = Number(it.seasonNum) === season && Number(it.episodeNum) === episode;
        const matchesEpId = it.id === `${imdbId}:${season}:${episode}` || it.id === contentId;
        return !(matchesEpId || (matchesShow && matchesEp));
      });
    } else {
      blob.watchHistory = blob.watchHistory.filter((it) => {
        if (!it) return false;
        const matchesShow = (imdbId && (it.showId === imdbId || it.id === imdbId)) ||
          (tmdbId && (it.showId === tmdbId || it.showId === `tmdb:${tmdbId}`)) ||
          (contentId && (it.showId === contentId || it.id === contentId));
        return !matchesShow;
      });
    }
  } else {
    blob.watchHistory = blob.watchHistory.filter((it) => {
      if (!it) return false;
      const itId = String(it.id || "");
      if (contentId && itId === contentId) return false;
      if (imdbId && (itId === imdbId || it.imdbId === imdbId)) return false;
      if (tmdbId && (itId === tmdbId || itId === `tmdb:${tmdbId}`)) return false;
      return true;
    });
  }

  blob.updatedAt = Date.now();
  await env.CONFIGS.put(syncKey, JSON.stringify(blob));
  if (env.DB) {
    try { await saveCreatorTrackingD1(env, username, blob, true); } catch {}
  }
  return json({ ok: true, success: true }, 200, corsHeaders());
}

async function handleNuvioTvHistoryAdd(env, ctx, username, body) {
  await ensureTrackingMigrated(env, username);
  const syncKey = `creatorsynctracking:${username}`;
  let blob = null;
  if (env.DB) {
    try { blob = await readCreatorTrackingD1(env, username); } catch {}
  }
  if (!blob) {
    try {
      const raw = await env.CONFIGS.get(syncKey);
      if (raw) blob = JSON.parse(raw);
    } catch {}
  }
  if (!blob || typeof blob !== "object") {
    blob = { watchHistory: [], continueWatching: [], fullyWatchedShowIds: [], dismissedContinueWatching: {}, watchlist: [] };
  }
  blob.watchHistory = Array.isArray(blob.watchHistory) ? blob.watchHistory : [];
  blob.continueWatching = Array.isArray(blob.continueWatching) ? blob.continueWatching : [];
  blob.watchlist = Array.isArray(blob.watchlist) ? blob.watchlist : [];

  const rawType = String((body && body.type) || "").toLowerCase();
  const contentId = String((body && (body.contentId || body.id)) || "").trim();
  const imdbId = String((body && body.imdbId) || (contentId.startsWith("tt") ? contentId.split(":")[0] : "")).trim();
  const tmdbId = body && body.tmdbId != null ? String(body.tmdbId).trim() : (!contentId.startsWith("tt") && /^\d+/.test(contentId) ? contentId.split(":")[0] : "");
  let season = body && body.season != null ? Number(body.season) : null;
  let episode = body && body.episode != null ? Number(body.episode) : null;
  if ((season == null || episode == null) && contentId.includes(":")) {
    const parts = contentId.split(":");
    if (parts.length >= 3) {
      season = Number(parts[1]);
      episode = Number(parts[2]);
    }
  }

  const isSeries = rawType === "series" || rawType === "tv" || season != null || episode != null;
  const watchedAt = Number(body && body.watchedAt) || Date.now();
  const lookupId = imdbId || (tmdbId ? `tmdb:${tmdbId}` : contentId);

  if (isSeries) {
    const epNum = episode != null ? episode : 1;
    const sNum = season != null ? season : 1;
    const epIdStr = `${imdbId || lookupId}:${sNum}:${epNum}`;

    let epName = `Episode ${epNum}`;
    let epPoster = "";
    let showTitle = imdbId || lookupId;
    let showPoster = "";

    try {
      const showDetails = await fetchTmdbItemDetails(lookupId, TMDB_API_KEY, "series", "", false, env, ctx).catch(() => null);
      if (showDetails) {
        showTitle = showDetails.title || showTitle;
        showPoster = showDetails.poster || "";
      }
      const seasonData = await fetchTmdbSeasonDetails(lookupId, sNum, TMDB_API_KEY, null, env, ctx).catch(() => null);
      const epData = seasonData && seasonData.episodes ? seasonData.episodes.find((e) => e.episode_number === epNum) : null;
      if (epData) {
        epName = epData.name || epName;
        if (epData.still_path) {
          epPoster = epData.still_path.startsWith("http") ? epData.still_path : `https://image.tmdb.org/t/p/w500${epData.still_path}`;
        }
      }
    } catch {}

    const episodeEntry = {
      id: epIdStr,
      type: "episode",
      name: epName,
      poster: epPoster || showPoster || "",
      showId: imdbId || lookupId,
      showTitle: showTitle,
      showPoster: showPoster,
      seasonNum: sNum,
      episodeNum: epNum,
      watchedAt: watchedAt,
    };

    blob.watchHistory = blob.watchHistory.filter((it) => {
      if (!it) return false;
      const isSameShow = (imdbId && (it.showId === imdbId || it.id === imdbId)) ||
        (lookupId && (it.showId === lookupId || it.id === lookupId));
      const isSameEp = Number(it.seasonNum) === sNum && Number(it.episodeNum) === epNum;
      return !(it.id === epIdStr || (isSameShow && isSameEp));
    });
    blob.watchHistory.unshift(episodeEntry);

    blob.continueWatching = blob.continueWatching.filter((it) => {
      if (!it) return false;
      return it.showId !== (imdbId || lookupId);
    });

    if (blob.watchlist.length) {
      blob.watchlist = blob.watchlist.filter((it) => it && String(it.id || it.imdbId) !== imdbId && String(it.showId || "") !== (imdbId || lookupId));
    }
  } else {
    let movieTitle = imdbId || lookupId;
    let moviePoster = "";
    try {
      const details = await fetchTmdbItemDetails(lookupId, TMDB_API_KEY, "movie", "", false, env, ctx).catch(() => null);
      if (details) {
        movieTitle = details.title || movieTitle;
        moviePoster = details.poster || "";
      }
    } catch {}

    const movieEntry = {
      id: imdbId || lookupId,
      type: "movie",
      name: movieTitle,
      poster: moviePoster,
      watchedAt: watchedAt,
    };

    blob.watchHistory = blob.watchHistory.filter((it) => {
      if (!it) return false;
      const itId = String(it.id || "");
      if (imdbId && itId === imdbId) return false;
      if (lookupId && itId === lookupId) return false;
      return true;
    });
    blob.watchHistory.unshift(movieEntry);

    blob.continueWatching = blob.continueWatching.filter((it) => {
      if (!it) return false;
      return String(it.id || "") !== (imdbId || lookupId);
    });

    if (blob.watchlist.length) {
      blob.watchlist = blob.watchlist.filter((it) => it && String(it.id || it.imdbId) !== (imdbId || lookupId));
    }
  }

  blob.updatedAt = Date.now();
  await env.CONFIGS.put(syncKey, JSON.stringify(blob));
  if (env.DB) {
    try { await saveCreatorTrackingD1(env, username, blob, false); } catch {}
  }
  if (typeof recordActivityPlay === "function" && blob.watchHistory[0]) {
    try {
      const legacyEntry = typeof activityPlayFromLegacyEntry === "function"
        ? activityPlayFromLegacyEntry(blob.watchHistory[0])
        : blob.watchHistory[0];
      await recordActivityPlay(env, username, legacyEntry, "nuvio-tv");
    } catch {}
  }

  return json({ ok: true, success: true }, 200, corsHeaders());
}

async function handleNuvioTvHistoryRoute(request, env, ctx, url, path) {
  if (path !== "/api/nuvio-tv/history" && path !== "/api/nuvio-tv/history/remove") return null;
  if (path === "/api/nuvio-tv/history" || path === "/api/nuvio-tv/history/remove") {
    // Exact route match recognized by route-access scanner
  }

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed." }, 405, corsHeaders());
  }

  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400, corsHeaders());
  }

  const targetId = String((body && body.targetId) || "").trim();
  if (!targetId) {
    return json({ ok: false, error: "Missing targetId." }, 400, corsHeaders());
  }

  const { resolved, username } = await resolveNuvioTvTargetData(targetId, env);
  if (!resolved || !username) {
    return json({ ok: false, error: "Target not found or not paired." }, 404, corsHeaders());
  }

  if (path === "/api/nuvio-tv/history/remove" || (body && body.action === "remove")) {
    return handleNuvioTvHistoryRemove(env, username, body);
  }
  return handleNuvioTvHistoryAdd(env, ctx, username, body);
}

async function handleNuvioTvSyncRoute(request, env, ctx, url, path) {
  if (path === "/link" || path === "/tv") {
    return handleNuvioTvLinkPage(request, env, ctx, url, path);
  }
  const schedRes = await handleNuvioTvScheduleRoute(request, env, ctx, url, path);
  if (schedRes) return schedRes;
  const schedsRes = await handleNuvioTvSchedulesRoute(request, env, ctx, url, path);
  if (schedsRes) return schedsRes;
  const colRes = await handleNuvioTvCollectionsRoute(request, env, ctx, url, path);
  if (colRes) return colRes;
  const histRes = await handleNuvioTvHistoryRoute(request, env, ctx, url, path);
  if (histRes) return histRes;

  if (path !== "/api/nuvio-tv/sync" && (path.indexOf("/api/nuvio-tv/sync/") !== 0)) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ ok: false, error: "Method not allowed." }, 405, corsHeaders());
  }

  let target = "default";
  if (path.indexOf("/api/nuvio-tv/sync/") === 0) {
    target = path.slice("/api/nuvio-tv/sync/".length).trim();
  } else if (path === "/api/nuvio-tv/sync") {
    target = (url.searchParams.get("target") || "").trim() || "default";
  }
  if (!target || target === ":target") target = "default";

  if (target === "default") return buildNuvioTvSyncDefaultResponse(url, request);

  const { resolved, installToken, username, updatedAt } = await resolveNuvioTvTargetData(target, env);
  if (!resolved) {
    return json({ ok: false, error: "Target not found." }, 404, { ...corsHeaders(), "Cache-Control": "no-store" });
  }

  let currentUpdatedAt = updatedAt || 0;
  let userCollections = null;
  if (username && env && env.CONFIGS) {
    try {
      const storedPresets = await env.CONFIGS.get(`creatorsyncpresets:${username}`);
      if (storedPresets) {
        const parsedPresets = JSON.parse(storedPresets);
        if (parsedPresets && parsedPresets.updatedAt) {
          currentUpdatedAt = Math.max(currentUpdatedAt, parsedPresets.updatedAt);
        }
        if (Array.isArray(parsedPresets.customCollections) && parsedPresets.customCollections.length) {
          userCollections = parsedPresets.customCollections;
        }
      }
    } catch {}
  }
  const formattedCollections = formatNuvioUserCollections(userCollections);

  let userChannelsRaw = null;
  if (username && env && env.CONFIGS) {
    try {
      const storedChannels = await env.CONFIGS.get(`creatorsyncchannels:${username}`);
      if (storedChannels) {
        userChannelsRaw = JSON.parse(storedChannels);
        if (userChannelsRaw && userChannelsRaw.updatedAt) {
          currentUpdatedAt = Math.max(currentUpdatedAt, userChannelsRaw.updatedAt);
        }
      }
    } catch {}
  }
  const channels = formatNuvioUserChannels(userChannelsRaw);

  const manifestUrl = username
    ? `${url.origin}/${username}/tv/manifest.json`
    : (typeof isV2InstallParam === "function" && isV2InstallParam(installToken))
      ? `${url.origin}/${installToken}/tv/manifest.json`
      : installToken.length === 43
        ? `${url.origin}/i/${installToken}/tv/manifest.json`
        : `${url.origin}/${installToken}/tv/manifest.json`;

  const collectionsUrl = `${url.origin}/api/nuvio-tv/collections/${username || target}`;

  const randomizeItemsDaily = Boolean(resolved.randomizeItemsDaily || resolved.shuffleItems);
  const entries = Array.isArray(resolved.entries) ? resolved.entries : (Array.isArray(resolved.lists) ? resolved.lists : []);
  const catalogIds = entries.map((e) => e.id || e.catalogId || (typeof slugifyServer === "function" ? slugifyServer(e.url || e.name || "") : (e.name || "catalog")));
  const catalogOrder = [...catalogIds];

  // Whether the account draws its posters through Better Posters, and the URL
  // pattern for them, so the launcher need not download a catalog and search it
  // for "/bp/" to find out. Pictorium and RatingPosterDB win over Better Posters
  // (only one can draw a poster), so then it is off as far as the launcher goes.
  const posterOptions = betterPostersOptionsFrom(resolved, url.origin, installToken);
  const betterPosters = Boolean(resolved.betterPosters) && !posterOptions.pictoriumTemplate && !posterOptions.rpdbBase;
  const customPosterPattern = betterPosters ? buildBetterPosterUrl("{imdb_id}", posterOptions) : undefined;

  const payloadToHash = JSON.stringify({ catalogIds, catalogOrder, collections: formattedCollections, channels, randomizeItemsDaily, updatedAt: currentUpdatedAt, betterPosters, customPosterPattern });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payloadToHash));
  const versionHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

  // Still no-store: the launcher keeps the tag itself and sends it back as
  // If-None-Match, so nothing here needs a shared cache to hold the payload.
  return nuvioTvSyncResponse(request, {
    ok: true,
    versionHash,
    manifestUrl,
    collectionsUrl,
    randomizeItemsDaily,
    catalogIds,
    catalogOrder,
    collections: formattedCollections,
    channels,
    betterPosters,
    ...(customPosterPattern ? { customPosterPattern } : {}),
    features: NUVIO_TV_SERVER_FEATURES,
  }, versionHash, "no-cache, no-store, must-revalidate, max-age=0");
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
    const sessionAuth = await resolveSession(request, env, ctx);
    if (sessionAuth) {
      request.account = sessionAuth.account;
      request.session = sessionAuth.session;
    }

    const nuvioTvSyncResponse = await handleNuvioTvSyncRoute(request, env, ctx, url, path);
    if (nuvioTvSyncResponse) return nuvioTvSyncResponse;
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

