// Playback positions from other apps (see 61_nuvio-positions.js for the table).
//
// A position is where someone stopped in a title: position and length, in
// milliseconds, in watch_positions (activity migration A0003), one per account,
// title and source. Sources: the media server webhook (Plex, Jellyfin, Emby) and
// Trakt's playback list. The rules are the same for all of them:
//   * no length, no position: a length is never invented;
//   * under 2% in is just a start, nothing is stored (an older point stays);
//   * 90% or more is a finished play, and the title's point from that source goes;
//   * the fields are the ones each service documents (tests/playback-positions.test.mjs
//     says which); none was captured from a live server.
// Writing never throws and never changes what the webhook answers.

const POSITION_MIN_RATIO = 0.02;
const POSITION_DONE_RATIO = 0.9;
const TICKS_PER_MS = 10000;

function positionNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// { positionMs, durationMs } from a media server webhook payload, or null.
function extractPlaybackPosition(payload, server) {
  if (!payload || typeof payload !== "object") return null;
  let position = null;
  let duration = null;
  if (server === "Plex") {
    const meta = payload.Metadata || {};
    position = positionNumber(meta.viewOffset);
    duration = positionNumber(meta.duration);
  } else {
    const item = payload.Item || {};
    const info = payload.PlaybackInfo || {};
    const posTicks = positionNumber(payload.PlaybackPositionTicks != null ? payload.PlaybackPositionTicks : info.PositionTicks);
    const lenTicks = positionNumber(payload.RunTimeTicks != null ? payload.RunTimeTicks : item.RunTimeTicks);
    position = posTicks == null ? null : Math.round(posTicks / TICKS_PER_MS);
    duration = lenTicks == null ? null : Math.round(lenTicks / TICKS_PER_MS);
  }
  return position != null && duration != null && duration > 0 ? { positionMs: Math.round(position), durationMs: Math.round(duration) } : null;
}

// Writes (or, when finished, clears) one source's position for one title.
// `pos` = { imdbId, tmdbId, kind, season, episode, positionMs, durationMs, at }.
async function recordWatchPosition(env, accountId, source, pos) {
  try {
    const actDb = activityDb(env, accountId);
    if (!actDb || !(await mediaAppPositionsReady(actDb))) return false;
    if (!(pos.durationMs > 0)) return false;
    const ratio = pos.positionMs / pos.durationMs;
    if (ratio < POSITION_MIN_RATIO) return false;
    const { ids } = await resolveMediaBatch(env, [{ imdbId: pos.imdbId || undefined, tmdbId: pos.tmdbId ? Number(pos.tmdbId) : undefined, kind: pos.kind, title: pos.title || "" }], { maxLookups: 0 });
    if (ids[0] == null) return false;
    const now = Date.now();
    const finished = ratio >= POSITION_DONE_RATIO;
    const stmts = mediaAppPositionStatements(actDb, accountId, source, [{
      mediaId: ids[0], kind: pos.kind, at: pos.at || now,
      resume: finished ? null : { season: pos.season, episode: pos.episode, position: pos.positionMs, duration: pos.durationMs, at: pos.at || now },
    }], now);
    await actDb.batch(stmts);
    return true;
  } catch (e) {
    console.error("positions: could not record a position", e);
    return false;
  }
}

// The webhook's side: called after the play is recorded, with the ids as resolved.
async function recordScrobblePosition(env, authUser, payload, p) {
  const pos = extractPlaybackPosition(payload, p.server);
  if (!pos || !(p.imdbId || p.tmdbId)) return;
  const accountId = await activityAccountId(env, authUser);
  if (accountId == null) return;
  const series = p.mediaType === "series";
  await recordWatchPosition(env, accountId, String(p.server || "").toLowerCase(), {
    imdbId: p.imdbId, tmdbId: p.tmdbId, kind: series ? "series" : "movie", title: p.showTitle || p.title,
    season: series ? p.season : null, episode: series ? p.episode : null, ...pos,
  });
}

// A pause: the ids still have to be worked out (the play path does that after its own checks).
async function recordPausedPosition(env, authUser, payload, p) {
  try {
    if (!extractPlaybackPosition(payload, p.server)) return;
    const ids = await resolveScrobbleIds(p);
    await recordScrobblePosition(env, authUser, payload, { ...p, imdbId: ids.imdbId, tmdbId: ids.tmdbId });
  } catch (e) {
    console.error("positions: could not record a paused position", e);
  }
}

// --- Trakt -----------------------------------------------------------------------------------

// Trakt's /sync/playback rows as positions. progress is a percent; the length is
// the runtime in minutes that extended=full adds, so a row without one is left out.
function traktPlaybackPositions(rows) {
  const out = [];
  for (const it of Array.isArray(rows) ? rows : []) {
    const episode = it && (it.type === "episode" || it.episode) ? it.episode || {} : null;
    const show = (it && it.show) || {};
    const movie = (it && it.movie) || {};
    const ids = (episode ? show.ids : movie.ids) || {};
    const minutes = positionNumber(episode ? (episode.runtime != null ? episode.runtime : show.runtime) : movie.runtime);
    const percent = positionNumber(it && it.progress);
    if (!minutes || percent == null || percent > 100 || (!ids.imdb && !ids.tmdb) || (episode && (episode.season == null || episode.number == null))) continue;
    const durationMs = Math.round(minutes * 60000);
    out.push({
      imdbId: ids.imdb || "", tmdbId: ids.tmdb || "", kind: episode ? "series" : "movie", title: (episode ? show.title : movie.title) || "",
      season: episode ? Number(episode.season) : null, episode: episode ? Number(episode.number) : null,
      positionMs: Math.round(durationMs * percent / 100), durationMs, at: Date.parse(it.paused_at) || Date.now(),
    });
  }
  return out;
}

// Reads the account's Trakt playback list and stores its positions. Quietly does
// nothing when there is no working Trakt connection.
async function refreshTraktPositions(env, accountId) {
  try {
    const conn = await loadProviderConnection(env, accountId, "trakt");
    if (!conn || conn.status !== "ok" || !conn.accessToken) return 0;
    const res = await fetch("https://api.trakt.tv/sync/playback?extended=full&limit=50", {
      headers: traktHeaders(conn.accessToken, conn.apiKey || undefined),
      signal: AbortSignal.timeout(MEDIA_APP_TIMEOUT_MS),
    });
    if (!res.ok) return 0;
    let n = 0;
    for (const pos of traktPlaybackPositions(await res.json().catch(() => []))) if (await recordWatchPosition(env, accountId, "trakt", pos)) n++;
    return n;
  } catch (e) {
    console.error("positions: Trakt playback failed", e);
    return 0;
  }
}
