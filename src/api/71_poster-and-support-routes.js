// Poster images and placeholders (icon, safe poster, Better Posters, RPDB, poster badge), the Ko-fi webhook, the support goal and the site notice, moved out of handleFetch (CQ-01).

// Moved unchanged: each route body is now its own function; the dispatcher keeps each route's
// original path/method test and is a plain function that returns a Response promise or null.

// /icon.png, poster placeholders, /bp/, /rpdb/, support goal, site notice, Ko-fi webhook, RPDB check, Better Posters warm-up and poster badge, at their original place. Returns a Response promise, or null.
function handlePosterAndSupportRoutes(request, env, ctx, url, path) {
  if (path === "/icon.png") return iconPng();
  if (path === "/unavailable-poster.svg") return unavailablePosterSvg();
  if (path === "/reconnect-poster.svg") return reconnectPosterSvg(url);
  if (path === "/api/safe-poster") return apiSafePoster(url);
  if (path.startsWith("/bp/") && (request.method === "GET" || request.method === "HEAD")) return betterPosterImage(request, env, ctx, url, path);
  const rpdbMatch = path.match(/^\/rpdb\/([^/]+)\/(tt\d+)\.jpg$/);
  if (rpdbMatch && (request.method === "GET" || request.method === "HEAD")) return rpdbPosterImage(env, ctx, rpdbMatch);
  if (path === "/api/support-goal" && request.method === "GET") return apiSupportGoal(env);
  if (path === "/api/site-notice" && request.method === "GET") return apiSiteNotice(env);
  if (path === "/api/kofi-webhook" && request.method === "POST") return apiKofiWebhook(request, env, ctx);
  if (path === "/api/rpdb-check" && request.method === "POST") return apiRpdbCheck(request, env, ctx);
  if (path === "/api/bp/warm" && request.method === "POST") return apiBpWarm(request, env, ctx, url);
  if (path === "/api/poster-badge") return apiPosterBadge(env, ctx, url);
  return null;
}

// add-on icon, served straight from this Worker using precomputed bytes (P8-4)
async function iconPng() {
  return new Response(getIconBytes(), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
      ...corsHeaders(),
    },
  });
}

// Poster-shaped placeholder shown in place of a real catalog when a
// source fails and there's no stale last-known-good data to fall back
// on (see the catalog route below). Generated on the fly rather than
// stored as an asset -- it's just text on a flat background.
async function unavailablePosterSvg() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">
        <rect width="300" height="450" fill="#161a2e"/>
        <rect x="0.5" y="0.5" width="299" height="449" fill="none" stroke="#2a2f4a"/>
        <text x="150" y="205" text-anchor="middle" font-family="sans-serif" font-size="42" fill="#5865a8">\u26a0</text>
        <text x="150" y="250" text-anchor="middle" font-family="sans-serif" font-size="17" fill="#c7cde6">Temporarily</text>
        <text x="150" y="274" text-anchor="middle" font-family="sans-serif" font-size="17" fill="#c7cde6">unavailable</text>
      </svg>`;
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=86400",
      ...corsHeaders(),
    },
  });
}

// The "Reconnect" tile's poster (P5-7): a personal row whose provider
// connection needs signing in again.
async function reconnectPosterSvg(url) {
  const provider = String(url.searchParams.get("provider") || "");
  const adapter = isConnectionProvider(provider) ? providerAdapter(provider) : null;
  const label = adapter ? adapter.label : "your account";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">
        <rect width="300" height="450" fill="#161a2e"/>
        <rect x="0.5" y="0.5" width="299" height="449" fill="none" stroke="#2a2f4a"/>
        <text x="150" y="195" text-anchor="middle" font-family="sans-serif" font-size="42" fill="#5865a8">\u21bb</text>
        <text x="150" y="245" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#c7cde6">Reconnect</text>
        <text x="150" y="270" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#c7cde6">${escapeXml(label)}</text>
        <text x="150" y="300" text-anchor="middle" font-family="sans-serif" font-size="13" fill="#8a91b4">at mylistsaddon.com</text>
      </svg>`;
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=86400",
      ...corsHeaders(),
    },
  });
}

// /api/safe-poster -> Dynamic age-appropriate vector SVG poster for Adult Content Filter
async function apiSafePoster(url) {
  const title = url.searchParams.get("title") || "Untitled";
  const year = url.searchParams.get("year") || "";
  const type = url.searchParams.get("type") || "movie";
  const cert = url.searchParams.get("cert") || "AGE-FILTERED";
  const svg = generateSafePosterSvg({ title, year, type, certification: cert });
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
      ...corsHeaders(),
    },
  });
}

// /api/poster-badge -> Dynamic badged SVG poster for Stremio / Nuvio
// This Worker's copy of a BetterPosters image -- see serveBetterPoster
// (05_catalog-core.js).
async function betterPosterImage(request, env, ctx, url, path) {
  const bp = parseBetterPosterPath(path, url.searchParams);
  if (!bp) return new Response(null, { status: 404 });
  return await serveBetterPoster(env, ctx, bp, url.origin, request);
}

// /rpdb/<config>/<imdb id>.jpg -> a RatingPosterDB poster from this Worker's
// own copy, see serveRpdbPoster (05_catalog-core.js).
async function rpdbPosterImage(env, ctx, rpdbMatch) {
  return await serveRpdbPoster(env, ctx, safeDecodeURIComponent(rpdbMatch[1]), rpdbMatch[2]);
}

// /api/support-goal -> what the Ko-fi support strip shows, or enabled:false
// until the admin turns it on. See readSupportGoal (03_admin.js).
async function apiSupportGoal(env) {
  const view = publicSupportGoal(await readSupportGoal(env));
  return jsonPublic({ ok: true, ...view }, 200, { "Cache-Control": "public, max-age=300" });
}

// /api/site-notice -> the message shown to every visitor once per session
// (openShutdownNotice, 16_), or enabled:false once the admin has turned it
// off. See readSiteNotice (03_admin.js). A minute of caching, so turning it
// off takes effect quickly.
async function apiSiteNotice(env) {
  const notice = await readSiteNotice(env);
  return jsonPublic({
    ok: true,
    enabled: notice.enabled,
    title: notice.title,
    body: notice.body,
    showDonate: notice.showDonate,
    showBackup: notice.showBackup,
    showGuide: notice.showGuide,
    donateUrl: SUPPORT_GOAL_URL,
  }, 200, { "Cache-Control": "public, max-age=60" });
}

// /api/kofi-webhook (POST, from Ko-fi) -> adds a donation or membership
// payment to the support strip's total. Ko-fi posts form data whose `data`
// field is a JSON string; the verification token inside it has to match the
// KOFI_VERIFICATION_TOKEN secret. Ko-fi retries until it gets a 200, so a
// message_id already counted is answered 200 and not counted twice.
async function apiKofiWebhook(request, env, ctx) {
  if (!env || !env.KOFI_VERIFICATION_TOKEN || !env.CONFIGS) {
    await recordKofiDelivery(env, "no-token-on-worker");
    return json({ ok: false, error: "Not set up." }, 503, { "Cache-Control": "no-store" });
  }
  const kofiIp = clientIpKey(request);
  if (!kofiIp || await consumeRateLimit(env, ctx, "kofiwebhook", kofiIp, 120, 60)) {
    return json({ ok: false, error: "Too many requests." }, 429, { "Cache-Control": "no-store" });
  }
  if ((Number(request.headers.get("content-length")) || 0) > KOFI_WEBHOOK_BODY_MAX) {
    return json({ ok: false, error: "Too large." }, 413, { "Cache-Control": "no-store" });
  }
  let data = null;
  try {
    // Ko-fi posts application/x-www-form-urlencoded. Read at most the cap
    // (the Content-Length above is only the sender's word), then parse it.
    const body = await readRequestTextCapped(request, KOFI_WEBHOOK_BODY_MAX);
    if (body.tooLarge) return json({ ok: false, error: "Too large." }, 413, { "Cache-Control": "no-store" });
    const raw = new URLSearchParams(body.text).get("data");
    if (typeof raw !== "string" || raw.length > KOFI_WEBHOOK_BODY_MAX) throw new Error("no data");
    data = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "Bad request." }, 400, { "Cache-Control": "no-store" });
  }
  if (!data || typeof data !== "object" || !(await timingSafeEqualSecret(data.verification_token, env.KOFI_VERIFICATION_TOKEN))) {
    await recordKofiDelivery(env, "wrong-token");
    return json({ ok: false, error: "Not authorized." }, 401, { "Cache-Control": "no-store" });
  }
  const amount = kofiAmountToCount(data);
  const messageId = String(data.message_id || "");
  if (amount === null || !KOFI_MESSAGE_ID_RE.test(messageId)) {
    await recordKofiDelivery(env, amount === null ? "not-counted" : "bad-message-id", { authed: true, type: data.type, currency: data.currency });
    return json({ ok: true, counted: false }, 200, { "Cache-Control": "no-store" });
  }
  // The goal's settings are read first, and a read that fails is a failure
  // the sender sees: Ko-fi retries until it gets a 200, and counting from
  // "nothing saved" would write defaults over the real goal (BA-001).
  let settings;
  try {
    settings = shapeSupportGoal(await readSupportGoalSettings(env));
  } catch (e) {
    console.error("/api/kofi-webhook: could not read the support goal settings; Ko-fi will retry", e);
    return json({ ok: false, error: "Try again." }, 503, { "Cache-Control": "no-store" });
  }
  if (env.DB) {
    // D1 is bound: the month's total is an atomic counter and the message
    // id goes in the ledger in the same batch (countKofiPaymentInD1).
    let counted;
    try {
      counted = await countKofiPaymentInD1(env, settings, messageId, amount);
    } catch (e) {
      console.error("/api/kofi-webhook: could not count the payment in D1; Ko-fi will retry", e);
      return json({ ok: false, error: "Try again." }, 503, { "Cache-Control": "no-store" });
    }
    if (!counted) return json({ ok: true, counted: false, duplicate: true }, 200, { "Cache-Control": "no-store" });
    try {
      const nowMs = Date.now();
      await env.CONFIGS.put(SUPPORT_GOAL_KEY, JSON.stringify({ ...settings, lastPayment: { at: nowMs, amount }, updatedAt: nowMs }));
    } catch (e) {
      // Only the "last payment" note for the admin page; the payment is counted.
      console.error("/api/kofi-webhook: counted, but could not save the last-payment note", e);
    }
  } else {
    // No D1 (a KV-only copy): the old read-add-write on the settings record.
    const seenKey = `kofi:msg:${messageId}`;
    if (await env.CONFIGS.get(seenKey)) return json({ ok: true, counted: false, duplicate: true }, 200, { "Cache-Control": "no-store" });
    const next = addKofiPaymentToSupportGoal(settings, amount);
    await env.CONFIGS.put(SUPPORT_GOAL_KEY, JSON.stringify(next));
    await env.CONFIGS.put(seenKey, "1", { expirationTtl: 40 * 86400 });
  }
  await recordKofiDelivery(env, "counted", { authed: true, type: data.type, currency: data.currency });
  return json({ ok: true, counted: true }, 200, { "Cache-Control": "no-store" });
}

// /api/rpdb-check  (POST)  { key } -> { ok, valid, used, limit }: whether a
// key works and how much of its monthly limit is spent, for Settings.
async function apiRpdbCheck(request, env, ctx) {
  const body = await readJsonBody(request);
  if (!body) return jsonInvalidBody({ "Cache-Control": "no-store" });
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!isValidRpdbKey(key)) return json({ ok: false, error: "That does not look like an RPDB key (it starts with t1- to t4-)." }, 400, { "Cache-Control": "no-store" });
  const checkIp = clientIpKey(request);
  if (!checkIp || await consumeRateLimit(env, ctx, "rpdbcheck", checkIp, 10, 60)) {
    return json({ ok: false, error: "Too many requests just now." }, 429, { "Cache-Control": "no-store" });
  }
  try {
    const valid = await fetchWithTimeout(`${RPDB_ORIGIN}/${key}/isValid`, { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` } }, RPDB_FETCH_TIMEOUT_MS);
    if (!valid.ok) return json({ ok: true, valid: false }, 200, { "Cache-Control": "no-store" });
    const usage = await fetchWithTimeout(`${RPDB_ORIGIN}/${key}/requests`, { headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` } }, RPDB_FETCH_TIMEOUT_MS);
    const data = usage.ok ? await usage.json() : null;
    return json({ ok: true, valid: true, used: data && Number.isFinite(data.req) ? data.req : null, limit: data && Number.isFinite(data.limit) ? data.limit : null }, 200, { "Cache-Control": "no-store" });
  } catch {
    return json({ ok: false, error: "RatingPosterDB did not answer. Try again in a moment." }, 502, { "Cache-Control": "no-store" });
  }
}

// /api/bp/warm  (POST)  { urls: ["/bp/...", ...] } -> { ok, stored, fetched, ready: [...] }
//
// Fetches, from btttr.cc, any of these posters this Worker does not hold
// yet -- so the wait for a poster btttr.cc has never drawn happens before
// it is scrolled to, not while someone is looking at an empty tile. The
// website sends every BetterPosters image on a page as soon as it is
// rendered, including the lazy ones far below the fold.
//
// `ready` lists which of the urls, exactly as sent, this Worker now holds:
// a tile that has been showing the title's ordinary poster while its
// Better one was fetched is switched over when it appears there.
//
// The request stays open until the fetches finish rather than running
// them after the response: a draw can take most of a minute, and work
// left to waitUntil is cut off 30 seconds after the response is sent. A
// poster btttr.cc failed to supply in the last few minutes is not asked
// for again here -- the cron retries those.
async function apiBpWarm(request, env, ctx, url) {
  const body = await readJsonBody(request);
  if (!body) return jsonInvalidBody({ "Cache-Control": "no-store" });

  const warmIp = clientIpKey(request);
  if (!warmIp) return json({ ok: false }, 400, { "Cache-Control": "no-store" });
  const wanted = [];
  const seen = new Set();
  for (const raw of (Array.isArray(body && body.urls) ? body.urls : []).slice(0, BETTER_POSTER_WARM_MAX)) {
    let u;
    try { u = new URL(String(raw || ""), url.origin); } catch { continue; }
    if (u.origin !== url.origin) continue;
    const bp = parseBetterPosterPath(u.pathname, u.searchParams);
    if (bp && !seen.has(bp.kvKey)) { seen.add(bp.kvKey); wanted.push({ bp, sent: String(raw) }); }
  }
  if (!wanted.length) return json({ ok: true, stored: 0, fetched: 0, ready: [] }, 200, { "Cache-Control": "no-store" });
  if (await consumeRateLimit(env, ctx, "bpwarm", warmIp, BETTER_POSTER_WARM_IDS_PER_MINUTE, 60, wanted.length)) {
    return json({ ok: false, error: "Too many requests just now." }, 429, { "Cache-Control": "no-store" });
  }
  let stored = 0;
  let fetched = 0;
  const ready = [];
  let cursor = 0;
  // A few at a time: btttr.cc's origin is the thing being slow, and
  // piling onto it would make every draw slower, ours included.
  await Promise.all(Array.from({ length: Math.min(4, wanted.length) }, async () => {
    while (cursor < wanted.length) {
      const { bp, sent } = wanted[cursor++];
      if (await readStoredBetterPoster(env, ctx, bp)) { stored++; ready.push(sent); continue; }
      if (await betterPosterRecentlyMissed(url.origin, bp)) continue;
      // P5-9: handed to the poster.fetch job instead of waited on.
      if (typeof betterPostersInR2 === "function" && betterPostersInR2(env)) { await sendBetterPosterFetch(env, bp); continue; }
      if (await fetchBetterPosterForPage(env, ctx, bp, url.origin, BETTER_POSTER_UPSTREAM_TIMEOUT_MS)) { fetched++; ready.push(sent); }
    }
  }));
  await flushBetterPosterRetries(env, true);
  return json({ ok: true, stored, fetched, ready }, 200, { "Cache-Control": "no-store" });
}

async function apiPosterBadge(env, ctx, url) {
  const posterUrl = url.searchParams.get("poster") || "";
  const rawAirDate = url.searchParams.get("airDate") || "";
  const isAired = rawAirDate && typeof isEpisodeAired === "function" && isEpisodeAired(rawAirDate);
  const airDate = !isAired ? rawAirDate : "";
  const airTime = !isAired ? (url.searchParams.get("airTime") || "") : "";
  const isPremiere = !isAired && url.searchParams.get("premiere") === "1";
  const isFinale = !isAired && url.searchParams.get("finale") === "1";
  const rawFinaleDate = url.searchParams.get("finaleDate") || "";
  const isFinaleAired = rawFinaleDate && typeof isEpisodeAired === "function" && isEpisodeAired(rawFinaleDate);
  const finaleDate = !isFinaleAired ? rawFinaleDate : "";
  const companion = url.searchParams.get("companion") || "";

  // This Worker's own BetterPosters copy. Recognised by being on THIS
  // origin under /bp/ -- never by path alone, which would let any host's
  // /bp/ through the allowlist below -- and read directly: a Worker
  // fetching its own hostname does not reliably reach itself.
  let ownBetterPoster = null;
  try {
    const pu = new URL(posterUrl);
    if (pu.origin === url.origin && pu.pathname.startsWith("/bp/")) ownBetterPoster = parseBetterPosterPath(pu.pathname, pu.searchParams);
  } catch {}

  if (!posterUrl || (!ownBetterPoster && !isAllowedPosterUrl(posterUrl, url.origin))) {
    // Missing entirely, or not one of the image hosts this add-on
    // itself ever puts in a `poster` field (see isAllowedPosterUrl).
    // This is a public, CORS-open, unauthenticated endpoint -- without
    // this check it was both an open redirect (Response.redirect
    // below, with no badge params) and an SSRF/open image proxy (the
    // fetch further down, with any badge param present): a caller
    // could point `poster=` at any http(s) URL and have this Worker
    // either send a visitor's browser there directly, or fetch it
    // server-side and echo the response back embedded in the SVG.
    return new Response(null, { status: 404 });
  }

  // If no badges are requested or all dates have aired, redirect straight to the original poster
  if (!airDate && !isPremiere && !isFinale && !finaleDate && !companion) {
    return Response.redirect(posterUrl, 302);
  }

  // Check isolate memo cache (P8-4)
  const cacheKey = url.search;
  if (BADGED_POSTER_CACHE.has(cacheKey)) {
    return new Response(BADGED_POSTER_CACHE.get(cacheKey), {
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
        ...corsHeaders(),
      },
    });
  }

  // The poster goes INTO the SVG, as a data URI. An SVG shown as an image
  // -- an <img>, a Stremio tile -- may not load anything from outside
  // itself, so an SVG that only links to the poster shows the badge on a
  // blank card. P8-4 did that for TMDB and Metahub posters (2026-10-02);
  // every badged Airing Next tile lost its picture. A Better Poster of
  // this Worker's own is read from storage, because a Worker fetching its
  // own hostname does not reliably reach itself.
  let embeddedPoster = "";
  let posterBytes = null;
  try {
    let contentType = "";
    let buffer = null;
    if (ownBetterPoster) {
      const found = await getBetterPoster(env, ctx, ownBetterPoster, url.origin, { waitMs: BETTER_POSTER_PAGE_WAIT_MS });
      if (found && found.bytes) {
        contentType = found.contentType;
        buffer = found.bytes;
      }
    } else {
      const imgRes = await fetch(posterUrl, {
        headers: { "User-Agent": "my-list-addon/1.14" },
        cf: { cacheTtl: 86400, cacheEverything: true },
      });
      if (imgRes.ok) {
        contentType = imgRes.headers.get("content-type") || "image/jpeg";
        buffer = await imgRes.arrayBuffer();
      }
    }
    if (buffer && String(contentType || "image/jpeg").startsWith("image/")) {
      posterBytes = buffer;
      embeddedPoster = `data:${contentType || "image/jpeg"};base64,${bytesToBase64(buffer)}`;
    }
  } catch (e) {}
  return apiPosterBadgeRender(env, { posterUrl, airDate, airTime, isPremiere, isFinale, finaleDate, companion, cacheKey, embeddedPoster, posterBytes });
}

// The rest of apiPosterBadge, moved unchanged: the same statements in the same order, split only for the 150-line limit.
async function apiPosterBadgeRender(env, { posterUrl, airDate, airTime, isPremiere, isFinale, finaleDate, companion, cacheKey, embeddedPoster, posterBytes }) {
  // Without the bytes, the plain poster is better than a blank badge.
  if (!embeddedPoster) return Response.redirect(posterUrl, 302);

  // Format air date tag text (e.g. WED, SEP 16)
  let airDateText = "";
  if (airDate && typeof formatAirDateBadge === "function") {
    airDateText = formatAirDateBadge(airDate);
  } else if (airDate) {
    try {
      const d = new Date(airDate + "T00:00:00Z");
      const m = d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase();
      const day = d.getUTCDate();
      airDateText = `${m} ${day}`;
    } catch (e) {
      airDateText = airDate;
    }
  }
  if (airDateText) airDateText = String(airDateText).toUpperCase();
  const airTimeText = airDateText && airTime ? String(airTime).toUpperCase() : "";

  // Format bottom badge text (matches website's .cw-date-badge-* styling)
  let bottomText = "";
  let bottomBg = "#28a745"; // Green for premiere
  let bottomBgOpacity = "0.95";
  let bottomBorder = "#28a745";
  let bottomBorderOpacity = "0.6";
  let bottomColor = "#ffffff";

  if (companion) {
    bottomText = companion;
    bottomBg = "rgba(37, 99, 235, 0.95)";
    bottomBgOpacity = "0.95";
    bottomBorder = "#2563eb";
    bottomBorderOpacity = "0.8";
    bottomColor = "#ffffff";
  } else if (isPremiere) {
    bottomText = "SEASON PREMIERE";
    bottomBg = "#28a745";
    bottomBgOpacity = "0.95";
    bottomBorder = "#28a745";
    bottomBorderOpacity = "0.6";
    bottomColor = "#ffffff";
  } else if (isFinale) {
    bottomText = "SEASON FINALE";
    bottomBg = "#ff9500";
    bottomBgOpacity = "0.95";
    bottomBorder = "#ff9500";
    bottomBorderOpacity = "0.7";
    bottomColor = "#ffffff";
  } else if (finaleDate) {
    let fText = "";
    if (typeof formatAirDateBadge === "function") {
      fText = formatAirDateBadge(finaleDate);
    } else {
      try {
        const d = new Date(finaleDate + "T00:00:00Z");
        const m = d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
        const day = d.getUTCDate();
        fText = `${m} ${day}`;
      } catch (e) {
        fText = finaleDate;
      }
    }
    bottomText = fText ? `FINALE: ${fText.toUpperCase()}` : "SEASON FINALE";
    bottomBg = "#121218";
    bottomBgOpacity = "0.94";
    bottomBorder = "#ff9f0a";
    bottomBorderOpacity = "0.75";
    bottomColor = "#ffd166";
  }

  const svg = generateBadgedPosterSvg({
    posterUrl: embeddedPoster,
    airDateText,
    airTimeText,
    bottomText,
    bottomBg,
    bottomBgOpacity,
    bottomBorder,
    bottomBorderOpacity,
    bottomColor,
  });

  // Stremio cannot draw an SVG, so with the Images binding the same badges
  // go over the poster as a JPEG. Any failure falls through to the SVG,
  // which Nuvio shows as before.
  if (env && env.IMAGES && posterBytes) {
    try {
      return await renderBadgedPosterJpeg(env, posterBytes, {
        airDateText, airTimeText, bottomText, bottomBg, bottomBgOpacity,
        bottomBorder, bottomBorderOpacity, bottomColor,
      });
    } catch (e) {
      // Still falls back to the SVG, but says so: a silent failure here meant
      // blank Stremio posters with no error anywhere (audit TEST-03).
      console.error("/api/poster-badge: could not draw the JPEG badge, sending the SVG instead", e);
    }
  }

  rememberBadgedPoster(cacheKey, svg);

  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
      ...corsHeaders(),
    },
  });
}
