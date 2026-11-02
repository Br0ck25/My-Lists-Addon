// The web manifest, robots.txt, sitemap, guide and the built page assets (app.css, app.js, app-features.js, sw.js, fflate), moved out of handleFetch (CQ-01).

// Moved unchanged: each route body is now its own function; the dispatcher keeps each route's
// original path test and is a plain function that returns a Response promise or null.

// /app.webmanifest, /robots.txt, /sitemap.xml, /guide, the fflate vendor file, /app.css, /app.js, /app-features.js and /sw.js, at their original place. Returns a Response promise, or null.
function handleStaticAssetRoutes(request, env, ctx, url, path) {
  if (path === "/app.webmanifest") return appWebmanifest();
  if (path === "/robots.txt") return robotsTxt(url);
  if (path === "/sitemap.xml") return sitemapXml(url);
  if (path === "/guide") return guidePage(url);
  if (path === FFLATE_VENDOR_PATH) return fflateVendor(request);
  if (path === "/app.css") return appCss(request, url);
  if (path === "/app.js") return appJs(request, url);
  if (path === "/app-features.js") return appFeaturesJs(request, url);
  if (path === "/sw.js") return swJs();
  return null;
}

async function appWebmanifest() {
  // background_color (the splash-screen fill while the PWA cold-starts)
  // and theme_color (the OS status bar / task-switcher chrome color for
  // an installed PWA) are both static -- the manifest spec has no dark
  // mode variant, unlike the page's own <meta name="theme-color">,
  // which 09_page-shell.js already flips between light/dark on load and
  // on toggleTheme(). So these match that page-level light default
  // (#F2F2F7) instead of the button accent blue (#007AFF) they were set
  // to before, which is what showed up as a flat blue bar at launch
  // regardless of theme -- a dark-theme user still gets the correct
  // dark chrome within a frame or two, once that in-page script runs.
  const manifest = {
    name: "My Lists",
    short_name: "My Lists",
    description: "Build and manage the lists, charts and channels that show up in Stremio, Nuvio and Wako.",
    id: "/",
    scope: "/",
    start_url: "/",
    display: "standalone",
    background_color: "#F2F2F7",
    theme_color: "#F2F2F7",
    // One file, declared at the size it actually is.
    //
    // These two entries claimed 192x192 and 512x512 while /icon.png's own
    // IHDR says 256x256 -- so the splash screen and the installed app icon
    // were upscaled from a source half the declared resolution, and the
    // 192 entry was downscaling for no reason. Chrome's installability
    // check wants an icon of at least 192px, which 256 satisfies, so
    // telling the truth costs nothing and stops the browser being lied to.
    //
    // No `purpose: "maskable"` entry: a maskable icon has to be DRAWN with
    // the safe zone in mind (Android crops to a circle), and declaring this
    // one maskable would crop its edges rather than fix anything. That is a
    // design task, not a manifest edit.
    icons: [
      { src: "/icon.png", sizes: "256x256", type: "image/png", purpose: "any" }
    ]
  };
  return new Response(JSON.stringify(manifest), {
    headers: { "Content-Type": "application/manifest+json; charset=utf-8" }
  });
}

async function robotsTxt(url) {
  // Only the plain / install page is meant to be publicly
  // discoverable -- see seoHeadHtml's comment in 09_page-shell.js for
  // why /:config/configure pages (personal base64 config, and any
  // personal API keys the user pasted in, baked straight into the
  // URL) get an explicit noindex there too, on top of being
  // Disallow'd here. /admin is a password-protected dashboard with
  // no business being crawled at all, and everything under /api/ and
  // the manifest/catalog/subtitles endpoints are raw JSON data
  // routes, not content.
  const robots = `User-agent: *
Allow: /$
Disallow: /admin
Disallow: /api/
Disallow: /*/configure
Disallow: /*/manifest.json
Disallow: /*/catalog/
Disallow: /*/subtitles/

Sitemap: ${url.origin}/sitemap.xml`;
  return new Response(robots, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" }
  });
}

async function sitemapXml(url) {
  // The plain install page and /guide (see the route just below) are
  // the only two URLs on this whole deployment meant to be indexed
  // (see /robots.txt just above) -- everything else either needs a
  // personal config in its own URL to mean anything, or is a raw
  // JSON/API endpoint rather than a page.
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${url.origin}/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${url.origin}/guide</loc>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
</urlset>`;
  return new Response(sitemap, {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=86400" }
  });
}

// Standalone SEO/content page, not the interactive builder -- see
// renderGuidePage's own comment (end of 24_client-backup-restore-
// presets.js, right after renderBuilder closes) for why it's a
// separate, lightweight template literal rather than reusing
// renderBuilder's app stylesheet.
async function guidePage(url) {
  return new Response(renderGuidePage(url.origin), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" }
  });
}

// /vendor/<name> -> the browser libraries this Worker serves itself
// instead of loading them from someone else's origin (P7-1).
//
// fflate is the only one: it reads a Trakt or Letterboxd export .zip in
// the browser. It used to come from cdn.jsdelivr.net, which meant a
// third-party origin in script-src, an SRI hash regenerated by hand on
// every bump, and a cross-origin request on every page load. See
// FFLATE_UMD_JS (01_icon-asset.js) -- the bytes served here are exactly
// the ones in that constant, and tests/csp.test.mjs pins both.
//
// The version is in the PATH, not a query string, so the file is
// immutable by construction: a bump is a new URL, a new URL is a new
// cache entry, and no browser can be left holding yesterday's copy. The
// ETag is the version too, which is what makes a repeat load a 304
// rather than a re-download.
async function fflateVendor(request) {
  const etag = `"fflate-${FFLATE_VENDOR_VERSION}"`;
  const inm = request.headers.get("If-None-Match") || "";
  const headers = {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=31536000, immutable",
    "ETag": etag,
  };
  if (inm.split(",").some((s) => s.trim().replace(/^W\//, "") === etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(FFLATE_UMD_JS, { headers });
}

// /app.js?v=<hash> -> the client bundle lifted out of the builder page.
// See splitAppBundle (02_http-and-creator-utils.js) for what is in it
// and why it can be shared. The URL is content-hashed, so it is safe to
// tell the browser to keep it forever: a deploy that changes the bundle
// changes the hash, which changes the src in the page, which changes the
// page's own ETag -- so nobody can be left holding a stale one.
// /app.css?v=<hash> -> the stylesheet lifted out of the builder page.
// Same content-addressed, immutable contract as /app.js below.
async function appCss(request, url) {
  const sheet = await getAppCss(url.origin);
  if (!sheet) {
    return new Response("/* app stylesheet unavailable */", {
      status: 503,
      headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  const isCurrent = (url.searchParams.get("v") || "") === sheet.hash;
  const etag = `"${sheet.hash}"`;
  const inm = request.headers.get("If-None-Match") || "";
  const headers = {
    "Content-Type": "text/css; charset=utf-8",
    "Cache-Control": isCurrent ? "public, max-age=31536000, immutable" : "no-cache",
    "ETag": etag,
  };
  if (inm.split(",").some((s) => s.trim().replace(/^W\//, "") === etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(sheet.css, { headers });
}

async function appJs(request, url) {
  const bundle = await getAppBundle(url.origin);
  if (!bundle) {
    // Markers missing (should be impossible -- the verification suite
    // asserts they render). 503 rather than an empty 200, so a broken
    // deploy is loud instead of a silently dead page.
    return new Response("/* app bundle unavailable */", {
      status: 503,
      headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  const askedFor = url.searchParams.get("v") || "";
  // Only the hash we are actually serving may be cached immutably. A
  // request for some older hash still gets a working bundle -- better
  // than a broken page -- but must not be allowed to pin today's bytes
  // under yesterday's URL forever.
  const isCurrent = askedFor === bundle.hash;
  const etag = `"${bundle.hash}"`;
  const inm = request.headers.get("If-None-Match") || "";
  const headers = {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": isCurrent ? "public, max-age=31536000, immutable" : "no-cache",
    "ETag": etag,
  };
  if (inm.split(",").some((s) => s.trim().replace(/^W\//, "") === etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(bundle.js, { headers });
}

// /app-features.js?v=<hash> -> the secondary features bundle (P8-3).
// Same content-addressed, immutable contract as /app.js above.
async function appFeaturesJs(request, url) {
  const bundle = await getAppFeaturesBundle(url.origin);
  if (!bundle) {
    return new Response("/* app features bundle unavailable */", {
      status: 503,
      headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  const askedFor = url.searchParams.get("v") || "";
  const isCurrent = askedFor === bundle.hash;
  const etag = `"${bundle.hash}"`;
  const inm = request.headers.get("If-None-Match") || "";
  const headers = {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": isCurrent ? "public, max-age=31536000, immutable" : "no-cache",
    "ETag": etag,
  };
  if (inm.split(",").some((s) => s.trim().replace(/^W\//, "") === etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(bundle.js, { headers });
}

async function swJs() {
  // The body lives in SERVICE_WORKER_JS at module scope so it can be
  // syntax-checked; see the comment there for the caching contract.
  return new Response(SERVICE_WORKER_JS, {
    headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache" }
  });
}
