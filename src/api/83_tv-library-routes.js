// My Lists TV: the TV's Library is the account's Watchlist.
//
// POST /api/nuvio-tv/library { targetId, action: "get" }                      -> { ok, items, updatedAt }
// POST /api/nuvio-tv/library { targetId, action: "set", items: [{ id, type, name, poster }] } -> { ok, updatedAt }
// "set" replaces the Watchlist with the TV's list. A title already on the Watchlist keeps what the website stored for it
// (year, airing dates...); only titles new to it are written from the TV's fields. The write goes through the same
// mirror the website's own save uses, so the website, the activity database and the v2 lists all see it.
const TV_LIBRARY_MAX = 500;

async function handleNuvioTvLibrary(request, env, ctx) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405, corsHeaders());
  let body;
  try { body = await readJsonObject(request); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400, corsHeaders()); }
  const device = await resolveNuvioTvDeviceToken(env, String((body && body.targetId) || "").trim());
  if (!device) return json({ ok: false, error: "Target not found or not paired. Pair the TV again." }, 404, corsHeaders());
  const username = device.username;
  if (await consumeRateLimit(env, ctx, "tvlibrary", username, 60, 60)) return json({ ok: false, error: "Too many requests." }, 429, corsHeaders());

  const current = await readAccountWatchlist(env, username, null);
  const existing = current && Array.isArray(current.items) ? current.items : [];
  // The website files some titles under a TMDB id ("tmdb:693134") with the IMDb id beside it; the TV only knows IMDb ids.
  const imdbOf = (it) => { const m = [it && it.imdbId, it && it.id].map((v) => String(v || "")).find((v) => /^tt\d+$/.test(v)); return m || ""; };
  if (body.action === "get") {
    const forTv = existing.map((it) => { const id = imdbOf(it); return id ? { ...it, id } : null; }).filter(Boolean);
    return json({ ok: true, items: forTv, username, updatedAt: current ? Number(current.updatedAt) || 0 : 0 }, 200, { ...corsHeaders(), "Cache-Control": "no-store" });
  }
  if (body.action !== "set" || !Array.isArray(body.items) || body.items.length > TV_LIBRARY_MAX) return json({ ok: false, error: "Send action get, or set with up to 500 items." }, 400, corsHeaders());

  const byId = new Map(existing.filter((it) => it && imdbOf(it)).map((it) => [imdbOf(it), it]));
  // Titles on the Watchlist the TV cannot show (no IMDb id) are kept, so a save from the TV does not delete them.
  const unshown = existing.filter((it) => it && !imdbOf(it));
  const items = [];
  for (const it of body.items) {
    const id = String((it && it.id) || "").trim();
    if (!/^tt\d+$/.test(id) || items.some((x) => x.id === id)) continue;
    items.push(byId.get(id) || { id, type: it.type === "series" ? "series" : "movie", name: String(it.name || "").slice(0, 200), poster: String(it.poster || "").slice(0, 500) });
  }
  const updatedAt = Date.now();
  const refused = await creatorTrackingWriteWatchlist(env, { username }, { watchlist: [...items, ...unshown] }, updatedAt);
  if (refused) return refused;
  return json({ ok: true, updatedAt, count: items.length }, 200, corsHeaders());
}
