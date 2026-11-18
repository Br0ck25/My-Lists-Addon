// My Lists TV: where a signed-in box stopped part way through a title.
//
// POST /api/nuvio-tv/progress { targetId, type, imdbId, season?, episode?, name, poster?, showTitle?, positionMs, durationMs }
// Finished plays go to /api/nuvio-tv/history (which also clears the entry made here). This keeps two records of a
// part-watched title: a playback position (watch_positions, so the Nuvio and Stremio sends pick it up) and a
// Continue Watching entry with its percentage, so the website shows it. Under 2% in is just a start, 90% or more is
// finished: both are ignored here.
const TV_PROGRESS_MAX = 50;

async function handleNuvioTvProgress(request, env, ctx) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405, corsHeaders());
  let body;
  try { body = await readJsonObject(request); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400, corsHeaders()); }
  // Only the secret the TV was given at pairing opens this, as with /history (a username is public).
  const device = await resolveNuvioTvDeviceToken(env, String((body && body.targetId) || "").trim());
  if (!device) return json({ ok: false, error: "Target not found or not paired. Pair the TV again." }, 404, corsHeaders());
  const username = device.username;
  if (await consumeRateLimit(env, ctx, "tvprogress", username, 120, 60)) return json({ ok: false, error: "Too many requests." }, 429, corsHeaders());

  const imdbId = String(body.imdbId || "").trim();
  const isSeries = String(body.type || "").toLowerCase() === "series";
  const season = Number(body.season), episode = Number(body.episode);
  const positionMs = Math.round(Number(body.positionMs)), durationMs = Math.round(Number(body.durationMs));
  if (!/^tt\d+$/.test(imdbId) || !(durationMs > 0) || !(positionMs >= 0) || (isSeries && !(season >= 0 && episode >= 1))) {
    return json({ ok: false, error: "Missing or invalid title or position." }, 400, corsHeaders());
  }
  const ratio = positionMs / durationMs;
  if (ratio < 0.02 || ratio >= 0.9) return json({ ok: true, ignored: true }, 200, corsHeaders());

  const acct = env.DB ? await env.DB.prepare("SELECT id FROM accounts WHERE username = ? COLLATE NOCASE LIMIT 1").bind(username).first().catch(() => null) : null;
  if (acct) await recordWatchPosition(env, acct.id, "mylists-tv", { imdbId, kind: isSeries ? "series" : "movie", season: isSeries ? season : null, episode: isSeries ? episode : null, positionMs, durationMs, title: String(body.name || "") });

  // An account on the activity database keeps this part of its record in account_settings (41_), the others in KV and D1.
  const direct = await directPlayLoad(env, username);
  if (!direct) await ensureTrackingMigrated(env, username);
  const syncKey = `creatorsynctracking:${username}`;
  let blob = direct ? direct.blob : null;
  if (!blob && env.DB) { try { blob = await readCreatorTrackingD1(env, username); } catch {} }
  if (!blob) { try { const raw = await env.CONFIGS.get(syncKey); if (raw) blob = JSON.parse(raw); } catch {} }
  if (!blob || typeof blob !== "object") blob = { watchHistory: [], continueWatching: [], fullyWatchedShowIds: [], dismissedContinueWatching: {}, watchlist: [] };
  const name = String(body.name || "").slice(0, 200), poster = String(body.poster || "").slice(0, 500);
  const entry = { watchedAt: Date.now(), positionMs, durationMs, progress: Math.round(ratio * 100), poster };
  if (isSeries) Object.assign(entry, { id: `${imdbId}:${season}:${episode}`, type: "episode", name: name || `Episode ${episode}`, showId: imdbId, showTitle: String(body.showTitle || "").slice(0, 200), showPoster: poster, seasonNum: season, episodeNum: episode });
  else Object.assign(entry, { id: imdbId, type: "movie", name: name || imdbId });
  const rest = (Array.isArray(blob.continueWatching) ? blob.continueWatching : []).filter((it) => it && (isSeries ? it.showId !== imdbId : String(it.id || "") !== imdbId));
  blob.continueWatching = [entry, ...rest].slice(0, TV_PROGRESS_MAX);
  blob.updatedAt = Date.now();
  if (direct) {
    const settings = await readTrackingSettings(env, direct.accountId);
    await writeTrackingSettings(env, direct.accountId, settings.all, trackingRecordRest(blob));
  } else {
    await env.CONFIGS.put(syncKey, JSON.stringify(blob));
    if (env.DB) { try { await saveCreatorTrackingD1(env, username, blob, false); } catch {} }
  }
  return json({ ok: true, progress: entry.progress }, 200, corsHeaders());
}
