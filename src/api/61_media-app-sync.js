
// --- Stremio and Nuvio accounts: connect, pull watch history (Release 20) ----------
//
// A signed-in account can connect its Stremio and Nuvio accounts. Their real
// watch history and Continue Watching are then pulled into the activity
// database (36_) the same way a play from a media server is, so the shelves
// (39_) show them. Nuvio documents a public API; Stremio calls follow what
// its app uses. Calls are checked by tests/fixtures/providers/
// {stremio,nuvio} and is kept to the few calls needed.
//
// Stremio (api.strem.io): no password ever reaches us. The person approves a
// code in their Stremio app (the Link flow, link.stremio.com) and gets back an
// authKey, kept encrypted in provider_connections like any other token. The
// page runs the Link flow itself (link.stremio.com answers the Worker with a 404
// and allows the browser, like Trakt's code login, Release 23) and hands the
// authKey over once, to /api/connections/stremio/link/complete. The
// library (collection libraryItem) holds, per title, state.lastWatched,
// timeOffset, duration, video_id and, for a show, state.watched: a bitfield of
// watched episodes in the show's Cinemeta order. It keeps no date per play, so
// only the latest play of a title has a date here. Earlier episodes move the
// show's furthest-watched mark without a Watch History entry of their own.
//
// Nuvio (api.nuvio.tv, Supabase): signed in with email and password, once.
// The password is exchanged for a refresh token and dropped. A refresh token
// works once (each refresh issues the next), which is why renewing goes through
// refreshProviderConnectionIfDue (28_), which re-reads the row when another
// isolate got there first. Data is read with RPCs (sync_pull_*) for one of the
// account's up to six profiles. Watched items carry their own dates.
//
// What lands where, per title:
//   * a play with a date          -> watch_events (source "stremio" or "nuvio"),
//                                    through activityPlayStatements (38_)
//   * furthest episode watched    -> show_progress, only ever moving forward
//   * a movie part way through    -> show_progress.companion_json, the kept entry
//                                    Continue Watching already shows for movies
//   * an episode part way through -> show_progress, one episode before it, so
//                                    Continue Watching offers that episode
// A play within MEDIA_APP_PLAY_WINDOW_MS of one already stored for the same
// title and episode is skipped, whatever its source: the subtitles ping (38_)
// records a play when it starts and the app's library when it ends.
//
// Two-way sync (off unless FF_MEDIA_APP_PUSH is on AND the person turned it on
// for that app): plays recorded here from any other source are sent to the app,
// merging only, never deleting. The app's own plays are never sent back to it
// (source = that app is skipped), a play the app already has is not sent again,
// and the position in watch_events.id is kept in media_app_sync.cursor_json, so
// nothing is sent twice. Stremio: only titles already in the person's library
// are touched, and only state.watched (a show) or timesWatched, flaggedWatched
// and lastWatched (a movie) change, on the library item as it was just read.
// Nuvio: watched items only, in the shape its own rows have.
//
// Settings and the pull position are in media_app_sync (migration 0023). The
// hourly job mediaapp.sync starts a mediaapp.sync-account job for each account
// that is due, and that job works through the library in bounded steps.
//
// Module level, after the Worker's exports, like 27_ onward.

const STREMIO_API_URL = "https://api.strem.io/api/";
const CINEMETA_URL = "https://v3-cinemeta.strem.io";
// Nuvio's public (publishable) key: the one its own apps ship with. NUVIO_APP_ANON_KEY
// overrides it, as it does for a self-hosted project.
const NUVIO_API_URL = "https://api.nuvio.tv";
const NUVIO_DEFAULT_ANON_KEY = "sb_publishable_1Clq8rlTVACkdcZuqr6_AD__xUUC_EN";
const MEDIA_APP_TIMEOUT_MS = 20 * 1000;
const MEDIA_APP_EVERY_MS = 60 * 60 * 1000;
const MEDIA_APP_DUE_MS = 55 * 60 * 1000;
const MEDIA_APP_ACCOUNTS_PER_RUN = 25;
const MEDIA_APP_STEP_ITEMS = 120;
const MEDIA_APP_CINEMETA_PER_STEP = 30;
const MEDIA_APP_LOOKUPS_PER_STEP = 100;
// A later pull re-reads what changed in this long before the last one ended.
const MEDIA_APP_OVERLAP_MS = 5 * 60 * 1000;
const MEDIA_APP_PLAY_WINDOW_MS = 6 * 60 * 60 * 1000;
// Under this a title is not started, from this it is finished.
const MEDIA_APP_STARTED = 0.02;
const MEDIA_APP_FINISHED = 0.9;
const MEDIA_APP_SYNC_JOB = "mediaapp.sync-account";

// --- Small helpers -------------------------------------------------------------------

// kind: "invalid" (the service refused the sign-in), "pending" (a Link code not
// approved yet) or "unreachable" (no answer we can trust either way).
// detail: what to show next to the generic message, never a secret.
function mediaAppError(kind, message, detail) {
  const e = new Error(message || kind);
  e.kind = kind;
  if (detail) e.detail = detail;
  return e;
}

async function mediaAppFetch(url, init = {}) {
  try {
    return await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(MEDIA_APP_TIMEOUT_MS),
      ...init,
      headers: { "User-Agent": `my-list-addon/${ADDON_VERSION}`, ...(init.headers || {}) },
    });
  } catch (e) {
    let host = "the service";
    try {
      host = new URL(url).hostname;
    } catch {}
    throw mediaAppError("unreachable", "The service could not be reached.", `${host} request failed (${(e && e.name) || "error"})`);
  }
}

// Milliseconds since the epoch from the forms the two services use: an ISO
// string, epoch seconds or epoch milliseconds, as a number or numeric string.
function mediaAppTime(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? (v < 1e11 ? Math.round(v * 1000) : Math.round(v)) : 0;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return mediaAppTime(Number(s));
  const t = Date.parse(s);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

function mediaAppPick(o, ...keys) {
  for (const k of keys) if (o && o[k] != null && o[k] !== "") return o[k];
  return undefined;
}

function mediaAppInt(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

function mediaAppKind(v) {
  const s = String(v || "").toLowerCase();
  if (s === "movie" || s === "film") return "movie";
  if (s === "series" || s === "show" || s === "tv" || s === "episode") return "series";
  return null;
}

// "tt0944947" or "tmdb:1396" as the id a media ref reads; null for any other
// id scheme (kitsu:, mal:, a bare number of unknown kind).
function mediaAppTitleId(v) {
  const s = String(v == null ? "" : v).trim();
  if (/^tt\d+$/i.test(s)) return { imdbId: s.toLowerCase() };
  const t = /^tmdb:(\d+)$/i.exec(s);
  if (t) return { tmdbId: Number(t[1]) };
  return null;
}

// --- Stremio ---------------------------------------------------------------------------

// One call on the account API. Resolves to the "result"; throws a mediaAppError.
async function stremioCall(method, body) {
  const res = await mediaAppFetch(STREMIO_API_URL + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401 || res.status === 403) throw mediaAppError("invalid", "Stremio refused this sign-in.");
  if (!res.ok) throw mediaAppError("unreachable", `Stremio answered ${res.status}.`);
  const data = await res.json().catch(() => null);
  if (!data || typeof data !== "object") throw mediaAppError("unreachable", "Stremio sent a reply we could not read.");
  if (data.error) {
    const msg = typeof data.error === "object" ? String(data.error.message || "") : String(data.error);
    throw mediaAppError(/session|auth|key|unauthori|not logged/i.test(msg) ? "invalid" : "unreachable", msg.slice(0, 120) || "Stremio refused the request.");
  }
  if (!("result" in data)) throw mediaAppError("unreachable", "Stremio sent a reply we could not read.");
  return data.result;
}

async function stremioUser(authKey) {
  const u = await stremioCall("getUser", { type: "GetUser", authKey });
  if (!u || typeof u !== "object" || !u._id) throw mediaAppError("invalid", "Stremio refused this sign-in.");
  return { id: String(u._id), name: String(u.email || u._id) };
}

async function stremioLogout(authKey) {
  try {
    await stremioCall("logout", { type: "Logout", authKey });
  } catch {}
}

// The whole library, newest change first. Removed items are left out here.
async function stremioFetchLibrary(authKey) {
  const result = await stremioCall("datastoreGet", { authKey, collection: "libraryItem", ids: [], all: true });
  const items = Array.isArray(result) ? result.filter((x) => x && typeof x === "object" && !x.removed) : [];
  items.sort((a, b) => mediaAppTime(b._mtime) - mediaAppTime(a._mtime));
  return items;
}

// Read a consistent Nuvio snapshot: capture the event cursor first, then
// replay mutations that happened while the offset-paginated snapshot was read.
async function nuvioFetchLibrary(env, token, profileIndex) {
  let cursor = Number(await nuvioRpc(env, token, "sync_get_library_delta_cursor", { p_profile_id: profileIndex }));
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw mediaAppError("unreachable", "Nuvio sent an invalid library cursor.");
  const items = new Map();
  const key = (r) => `${String(r.content_type || "").toLowerCase()}:${String(r.content_id || "").toLowerCase()}`;
  let complete = false;
  for (let offset = 0; offset < 50000; offset += 500) {
    const rows = await nuvioRpc(env, token, "sync_pull_library", { p_profile_id: profileIndex, p_limit: 500, p_offset: offset });
    if (!Array.isArray(rows)) throw mediaAppError("unreachable", "Nuvio sent an invalid library page.");
    for (const row of rows) if (row && row.content_id && row.content_type) items.set(key(row), row);
    if (rows.length < 500) { complete = true; break; }
  }
  if (!complete) throw mediaAppError("unreachable", "Nuvio's library is too large to read safely.");
  complete = false;
  for (let page = 0; page < 100; page++) {
    const rows = await nuvioRpc(env, token, "sync_pull_library_delta", { p_profile_id: profileIndex, p_since_event_id: cursor, p_limit: 500 });
    if (!Array.isArray(rows)) throw mediaAppError("unreachable", "Nuvio sent an invalid library update.");
    for (const row of rows) {
      const eventId = Number(row && row.event_id);
      if (!Number.isSafeInteger(eventId) || eventId <= cursor || !row.content_id || !row.content_type || !["upsert", "delete"].includes(row.operation)) throw mediaAppError("unreachable", "Nuvio sent an invalid library update.");
      cursor = eventId;
      if (row.operation === "delete") items.delete(key(row)); else items.set(key(row), row);
    }
    if (rows.length < 500) { complete = true; break; }
  }
  if (!complete) throw mediaAppError("unreachable", "Nuvio's library is changing too quickly to read safely.");
  return [...items.values()].sort((a, b) => (Number(b.added_at) || 0) - (Number(a.added_at) || 0));
}

// Remote library rows are read directly, so changes in either app show on the
// next read; there is no stale mirrored snapshot to reconcile or overwrite.
async function mediaAppLibraryItems(env, accountId, provider) {
  let conn = await loadProviderConnection(env, accountId, provider);
  const sync = await loadMediaAppSync(env, accountId, provider);
  if (!conn || conn.status !== "ok" || !sync) return [];
  if (provider === "nuvio") {
    if (!sync.profile_index) return [];
    conn = await refreshProviderConnectionIfDue(env, accountId, provider, conn);
    if (!conn || !conn.accessToken) throw mediaAppError("invalid", "Sign in to Nuvio again first.");
    const rows = await nuvioFetchLibrary(env, conn.accessToken, sync.profile_index);
    return rows.filter((r) => mediaAppTitleId(r.content_id) && mediaAppKind(r.content_type)).map((r) => ({ id: r.content_id, type: mediaAppKind(r.content_type), name: r.name || "", poster: r.poster || (String(r.content_id).startsWith("tt") ? `https://images.metahub.space/poster/medium/${r.content_id}/img` : ""), year: r.release_info || undefined }));
  }
  const rows = await stremioFetchLibrary(conn.accessToken);
  return rows.filter((r) => !r.temp && mediaAppTitleId(r._id) && mediaAppKind(r.type)).map((r) => ({ id: r._id, type: mediaAppKind(r.type), name: r.name || "", poster: r.poster || (String(r._id).startsWith("tt") ? `https://images.metahub.space/poster/medium/${r._id}/img` : "") }));
}

// A show's episodes in the order Stremio numbers them: by season, with
// specials (season 0) last. null when Cinemeta cannot say.
async function stremioEpisodes(imdbId) {
  try {
    const res = await mediaAppFetch(`${CINEMETA_URL}/meta/series/${encodeURIComponent(imdbId)}.json`);
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const videos = data && data.meta && Array.isArray(data.meta.videos) ? data.meta.videos : [];
    const eps = [];
    for (const v of videos) {
      const season = mediaAppInt(v.season);
      const episode = mediaAppInt(v.episode != null ? v.episode : v.number);
      if (season == null || episode == null) continue;
      eps.push({ id: String(v.id || `${imdbId}:${season}:${episode}`), season, episode });
    }
    eps.sort((a, b) => ((a.season === 0) - (b.season === 0)) || a.season - b.season || a.episode - b.episode);
    return eps.length ? eps : null;
  } catch {
    return null;
  }
}

// state.watched is "<anchor video id>:<anchor length>:<base64 of zlib bytes>".
// One bit per episode, least significant bit first. The anchor says where the
// bits sit in today's episode list: bit p is the episode at index
// p + (anchorIndex + 1 - anchorLength). Returns the watched episodes of `eps`,
// or [] when the string cannot be read.
async function stremioWatchedEpisodes(watched, eps) {
  try {
    const s = String(watched || "");
    const last = s.lastIndexOf(":");
    const mid = s.lastIndexOf(":", last - 1);
    if (last < 0 || mid < 0) return [];
    const anchorId = s.slice(0, mid);
    const length = Number(s.slice(mid + 1, last));
    const anchorIndex = eps.findIndex((e) => e.id === anchorId);
    if (anchorIndex < 0 || !(length > 0)) return [];
    const bin = atob(s.slice(last + 1));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
    const data = new Uint8Array(await new Response(stream).arrayBuffer());
    const offset = anchorIndex + 1 - length;
    const out = [];
    for (let p = 0; p < length; p++) {
      if (!(data[p >> 3] & (1 << (p & 7)))) continue;
      const e = eps[p + offset];
      if (e) out.push({ season: e.season, episode: e.episode });
    }
    return out;
  } catch {
    return [];
  }
}

// A library item as what to record, or null when it is not a movie or show we
// can name. `episodes` is the show's list when the caller fetched it.
//   { imdbId|tmdbId, kind, title, poster, mtime, plays: [{season, episode, watchedAt}],
//     furthest: {season, episode}|null, at, resume: {season, episode, ratio}|null }
async function stremioItemRecord(item, episodes) {
  const kind = mediaAppKind(item && item.type);
  const id = mediaAppTitleId(item && item._id);
  if (!kind || !id || kind === "series" && !id.imdbId) return null;
  const st = item.state && typeof item.state === "object" ? item.state : {};
  const lastWatched = mediaAppTime(st.lastWatched);
  const duration = Number(st.duration) || 0;
  const offset = Number(st.timeOffset) || 0;
  const ratio = duration > 0 ? Math.min(1, offset / duration) : 0;
  const rec = {
    ...id, kind, title: String(item.name || "").slice(0, 200), poster: typeof item.poster === "string" ? item.poster : "",
    mtime: mediaAppTime(item._mtime), plays: [], furthest: null, at: lastWatched || mediaAppTime(item._mtime) || 1, resume: null,
  };
  if (kind === "movie") {
    const finished = Number(st.timesWatched) > 0 || Number(st.flaggedWatched) > 0 || ratio >= MEDIA_APP_FINISHED;
    if (finished && lastWatched) rec.plays.push({ season: null, episode: null, watchedAt: lastWatched });
    else if (!finished && ratio >= MEDIA_APP_STARTED) rec.resume = { season: null, episode: null, ratio, position: offset, duration };
    return rec;
  }
  const watchedEps = episodes && st.watched ? await stremioWatchedEpisodes(st.watched, episodes) : [];
  const current = /^(tt\d+):(\d+):(\d+)$/i.exec(String(st.video_id || ""));
  const cur = current ? { season: Number(current[2]), episode: Number(current[3]) } : null;
  const inWatched = (e) => watchedEps.some((w) => w.season === e.season && w.episode === e.episode);
  if (cur) {
    if (inWatched(cur) || ratio >= MEDIA_APP_FINISHED) {
      if (!inWatched(cur)) watchedEps.push(cur);
      if (lastWatched) rec.plays.push({ season: cur.season, episode: cur.episode, watchedAt: lastWatched });
    } else if (ratio >= MEDIA_APP_STARTED) {
      rec.resume = { ...cur, ratio, position: offset, duration };
    }
  }
  for (const e of watchedEps) {
    if (e.season < 1) continue;
    if (!rec.furthest || e.season > rec.furthest.season || (e.season === rec.furthest.season && e.episode > rec.furthest.episode)) rec.furthest = e;
  }
  return rec;
}

// --- Nuvio -----------------------------------------------------------------------------

function nuvioBase(env) {
  return String((env && env.NUVIO_API_URL) || NUVIO_API_URL).replace(/\/+$/, "");
}

function nuvioKey(env) {
  return String((env && env.NUVIO_APP_ANON_KEY) || NUVIO_DEFAULT_ANON_KEY);
}

// Sign in (grant "password") or renew (grant "refresh_token"). Throws a
// mediaAppError; "invalid" when Nuvio refused the credentials or the token.
async function nuvioToken(env, grant, body) {
  const res = await mediaAppFetch(`${nuvioBase(env)}/auth/v1/token?grant_type=${grant}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": nuvioKey(env) },
    body: JSON.stringify(body),
  });
  if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 422) {
    throw mediaAppError("invalid", grant === "password" ? "Nuvio did not accept that email and password." : "Nuvio refused to renew this sign-in.");
  }
  if (!res.ok) throw nuvioStatusError(res.status);
  const d = await res.json().catch(() => null);
  if (!d || !d.access_token || !d.refresh_token) throw mediaAppError("unreachable", "Nuvio sent a reply we could not read.");
  const user = d.user && typeof d.user === "object" ? d.user : {};
  return {
    accessToken: String(d.access_token),
    refreshToken: String(d.refresh_token),
    expiresAt: Number(d.expires_in) > 0 ? Date.now() + Number(d.expires_in) * 1000 : null,
    userId: user.id ? String(user.id) : "",
    email: user.email ? String(user.email) : "",
  };
}

async function nuvioRpc(env, accessToken, fn, params, options = {}) {
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await mediaAppFetch(`${nuvioBase(env)}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": nuvioKey(env), "Authorization": `Bearer ${accessToken}`, ...(options.range ? { "Range-Unit": "items", "Range": options.range, "Prefer": "count=exact" } : {}) },
      body: JSON.stringify(params || {}),
    });
    if (res.status !== 429 || attempt >= NUVIO_RETRIES) break;
    await nuvioBackoff(res, attempt);
  }
  if (res.status === 401 || res.status === 403) throw mediaAppError("invalid", "Nuvio refused this sign-in.");
  if (options.range && res.status === 416) {
    const match = /^\*\/(\d+)$/.exec(res.headers.get("content-range") || "");
    if (match && Number(options.range.split("-")[0]) >= Number(match[1])) return options.returnPage ? { rows: [], total: Number(match[1]) } : [];
  }
  if (!res.ok) throw nuvioStatusError(res.status);
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    const rows = JSON.parse(text);
    if (!options.returnPage) return rows;
    const match = /\/(\d+)$/.exec(res.headers.get("content-range") || "");
    return { rows, total: match ? Number(match[1]) : null };
  } catch {
    throw mediaAppError("unreachable", "Nuvio sent a reply we could not read.");
  }
}

// The account's profiles: [{ index, name }]. An account with none yet has one.
async function nuvioProfiles(env, accessToken) {
  const rows = await nuvioRpc(env, accessToken, "sync_pull_profiles", {});
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const index = mediaAppInt(mediaAppPick(r, "profile_index", "profileIndex"));
    if (index != null && index >= 1 && index <= 6) out.push({ index, name: String(r.name || `Profile ${index}`).slice(0, 40) });
  }
  return out;
}

// Everything one profile holds. The sync RPCs name a profile by its index, as
// p_profile_id.
async function nuvioFetchProfile(env, accessToken, profileIndex) {
  const watched = [];
  let complete = false;
  for (let page = 1; page <= 200; page++) {
    const rows = await nuvioRpc(env, accessToken, "sync_pull_watched_items", { p_profile_id: profileIndex, p_page: page, p_page_size: 500 });
    if (!Array.isArray(rows)) throw mediaAppError("unreachable", "Nuvio sent an invalid watch history page.");
    watched.push(...rows);
    if (rows.length < 500) { complete = true; break; }
  }
  if (!complete) throw mediaAppError("unreachable", "Nuvio's watch history is too large to read safely.");
  // The timestamp parameter filters NEWER rows, not older pages. Paginate the
  // unbounded RPC result with PostgREST item ranges instead. A repeated page
  // means the server ignored Range; fail rather than silently drop old items.
  const progress = [];
  const seen = new Set();
  complete = false;
  for (let offset = 0; offset < 100000;) {
    const result = await nuvioRpc(env, accessToken, "sync_pull_watch_progress", { p_profile_id: profileIndex }, { range: `${offset}-${offset + 499}`, returnPage: true });
    const page = result && result.rows;
    if (!Array.isArray(page)) throw mediaAppError("unreachable", "Nuvio sent invalid watch progress.");
    for (const item of page) {
      const id = mediaAppPick(item, "id", "progress_key", "progressKey") || JSON.stringify([mediaAppPick(item, "content_id", "contentId"), item.season, item.episode]);
      if (seen.has(id)) throw mediaAppError("unreachable", "Nuvio repeated a watch progress page; the pull was not saved.");
      seen.add(id);
      progress.push(item);
    }
    offset += page.length;
    if (result.total != null ? offset >= result.total : page.length < 500) { complete = true; break; }
    if (!page.length) throw mediaAppError("unreachable", "Nuvio returned an incomplete watch progress page.");
  }
  if (!complete) throw mediaAppError("unreachable", "Nuvio's watch progress is too large to read safely.");
  return { watched, progress };
}

// Nuvio's watched items and progress entries as one record per title (the same
// shape as stremioItemRecord). Both name a title by content_id (or contentId).
function nuvioRecords({ watched, progress }) {
  const by = new Map();
  const recFor = (rawId, rawType, title, poster) => {
    const id = mediaAppTitleId(rawId);
    if (!id) return null;
    // TMDB IDs are scoped by media type: movie 550 and TV 550 are unrelated.
    const kind = mediaAppKind(rawType) || "movie";
    const key = `${kind}:${id.imdbId || `tmdb:${id.tmdbId}`}`;
    let rec = by.get(key);
    if (!rec) {
      rec = { ...id, kind: mediaAppKind(rawType) || "movie", title: "", poster: "", mtime: 0, plays: [], furthest: null, at: 1, resume: null };
      by.set(key, rec);
    }
    if (mediaAppKind(rawType) === "series") rec.kind = "series";
    if (title && !rec.title) rec.title = String(title).slice(0, 200);
    if (typeof poster === "string" && poster && !rec.poster) rec.poster = poster;
    return rec;
  };
  const bump = (rec, t) => {
    if (t > rec.mtime) rec.mtime = t;
    if (t > rec.at) rec.at = t;
  };
  const addPlay = (rec, season, episode, watchedAt) => {
    if (rec.kind === "series" && (season == null || episode == null)) return;
    const s = rec.kind === "series" ? season : null;
    const e = rec.kind === "series" ? episode : null;
    if (!rec.plays.some((p) => p.season === s && p.episode === e && p.watchedAt === watchedAt)) rec.plays.push({ season: s, episode: e, watchedAt });
    bump(rec, watchedAt);
  };
  for (const w of watched || []) {
    const kindRaw = mediaAppPick(w, "content_type", "contentType");
    const season = mediaAppInt(w.season);
    const episode = mediaAppInt(w.episode);
    const rec = recFor(mediaAppPick(w, "content_id", "contentId"), season != null && episode != null ? "series" : kindRaw, mediaAppPick(w, "title", "name"), mediaAppPick(w, "poster"));
    const at = mediaAppTime(mediaAppPick(w, "watched_at", "watchedAt"));
    if (rec && at) addPlay(rec, season, episode, at);
  }
  for (const p of progress || []) {
    const season = mediaAppInt(p.season);
    const episode = mediaAppInt(p.episode);
    const rec = recFor(mediaAppPick(p, "content_id", "contentId"), season != null && episode != null ? "series" : mediaAppPick(p, "content_type", "contentType"), mediaAppPick(p, "name", "title"), mediaAppPick(p, "poster"));
    if (!rec) continue;
    const duration = Number(mediaAppPick(p, "duration")) || 0;
    const position = Number(mediaAppPick(p, "position")) || 0;
    const ratio = duration > 0 ? Math.min(1, position / duration) : 0;
    const at = mediaAppTime(mediaAppPick(p, "last_watched", "lastWatched")) || 1;
    bump(rec, at);
    if (ratio >= MEDIA_APP_FINISHED) addPlay(rec, season, episode, at);
    else if (ratio >= MEDIA_APP_STARTED && (!rec.resume || at > rec.resume.at)) {
      rec.resume = { season: rec.kind === "series" ? season : null, episode: rec.kind === "series" ? episode : null, ratio, at, position, duration };
    }
  }
  const out = [...by.values()];
  for (const rec of out) {
    for (const p of rec.plays) {
      if (p.season == null || p.season < 1) continue;
      if (!rec.furthest || p.season > rec.furthest.season || (p.season === rec.furthest.season && p.episode > rec.furthest.episode)) {
        rec.furthest = { season: p.season, episode: p.episode };
      }
    }
    // A resume point behind what is already finished is stale.
    if (rec.resume && rec.kind === "series" && rec.furthest
      && (rec.resume.season < rec.furthest.season || (rec.resume.season === rec.furthest.season && rec.resume.episode <= rec.furthest.episode))) rec.resume = null;
    // An older watched play does not cancel a later rewatch in progress.
    if (rec.resume && rec.kind === "movie" && rec.plays.some((play) => play.watchedAt >= rec.resume.at)) rec.resume = null;
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// --- Writing records to the activity database -------------------------------------------

// Stored resume points use the app's own title identity, not a guessed next
// episode. A full Nuvio snapshot replaces this map so remote deletions clear it.
function mediaAppResumeChanges(records, provider) {
  return records.map((r) => [
    r.imdbId || (provider === "nuvio" ? `${r.kind}|tmdb:${r.tmdbId}` : `tmdb:${r.tmdbId}`),
    r.resume && r.resume.duration > 0 ? { kind: r.kind, season: r.resume.season, episode: r.resume.episode, position: r.resume.position, duration: r.resume.duration, at: r.resume.at || r.at } : null,
  ]);
}

// Records an account's pulled titles. Returns { plays, progress, resumes, unresolved,
// lookups } or { skipped: reason } when the activity database cannot take them yet.
async function applyMediaAppRecords(env, accountId, provider, records, { lookups = MEDIA_APP_LOOKUPS_PER_STEP } = {}) {
  const actDb = activityDb(env, accountId);
  if (!actDb || !(await activitySchemaReady(actDb))) return { skipped: "The activity database is not ready." };
  const sourcesReady = await actDb.prepare("SELECT version FROM schema_migrations WHERE version = 'A0002'").first();
  if (!sourcesReady) return { skipped: "The activity database needs migration A0002 before app history can sync." };
  // Like recordActivityPlay: before the account's history is copied the copy
  // would rebuild show_progress and undo these, so wait.
  const copied = await env.DB.prepare("SELECT status FROM jobs WHERE dedupe_key = ?").bind(`${ACTIVITY_BACKFILL_TYPE}:acct:${accountId}`).first();
  if (!copied || copied.status !== "done") return { skipped: "Your existing history is still being copied. This will run again shortly." };
  const positionsReady = await mediaAppPositionsReady(actDb);
  const out = { plays: 0, progress: 0, resumes: 0, unresolved: 0, lookups: 0 };
  // How far through each title is, for the lists' bars: set for a title part way through with a
  // known length, removed for one that is not (finished, or not started).
  out.resumeChanges = mediaAppResumeChanges(records, provider);
  if (!records.length) return out;

  const refs = records.map((r) => ({ imdbId: r.imdbId, tmdbId: r.tmdbId, kind: r.kind, title: r.title }));
  const { ids, stats } = await resolveMediaBatch(env, refs, { maxLookups: Math.max(0, lookups) });
  out.lookups = stats.lookups;
  const usable = [];
  records.forEach((r, i) => {
    if (ids[i] == null) out.unresolved++;
    else usable.push({ ...r, mediaId: ids[i] });
  });
  if (!usable.length) return out;

  // What the activity database already knows of these titles.
  const mediaIdsJson = JSON.stringify([...new Set(usable.map((r) => r.mediaId))]);
  const { results: known } = await actDb.prepare(
    "SELECT id, source, media_id, season, episode, watched_at FROM watch_events WHERE account_id = ? AND media_id IN (SELECT value FROM json_each(?))"
  ).bind(accountId, mediaIdsJson).all();
  const stored = new Map();
  for (const e of known || []) {
    const k = `${e.media_id}:${e.season == null ? "" : e.season}:${e.episode == null ? "" : e.episode}`;
    (stored.get(k) || stored.set(k, []).get(k)).push({ id: e.id, source: e.source, at: Number(e.watched_at) });
  }
  const { results: haveShow } = await actDb.prepare(
    "SELECT media_id FROM show_progress WHERE account_id = ? AND media_id IN (SELECT value FROM json_each(?))"
  ).bind(accountId, mediaIdsJson).all();
  const knownShows = new Set((haveShow || []).map((r) => r.media_id));

  const now = Date.now();
  const stmts = [];
  const newShows = [];
  for (const r of usable) {
    const isSeries = r.kind === "series";
    let datedLast = null;
    for (const p of r.plays) {
      const k = `${r.mediaId}:${p.season == null ? "" : p.season}:${p.episode == null ? "" : p.episode}`;
      const near = (stored.get(k) || []).filter((e) => Math.abs(e.at - p.watchedAt) < MEDIA_APP_PLAY_WINDOW_MS)
        .sort((a, b) => Math.abs(a.at - p.watchedAt) - Math.abs(b.at - p.watchedAt))[0];
      if (near) {
        if (near.id != null && near.source !== provider) {
          stmts.push(actDb.prepare(`INSERT INTO watch_event_sources (event_id, source, watched_at) VALUES (?, ?, ?)
            ON CONFLICT(event_id, source) DO UPDATE SET watched_at = excluded.watched_at`).bind(near.id, provider, p.watchedAt));
        }
        continue;
      }
      (stored.get(k) || stored.set(k, []).get(k)).push({ id: null, source: provider, at: p.watchedAt });
      stmts.push(...activityPlayStatements(actDb, accountId, r.mediaId, { season: p.season, episode: p.episode, watchedAt: p.watchedAt, legacyId: null }, provider, now));
      out.plays++;
      if (isSeries && (!datedLast || p.season > datedLast.season || (p.season === datedLast.season && p.episode > datedLast.episode))) datedLast = p;
      if (isSeries && !knownShows.has(r.mediaId) && !newShows.includes(r.mediaId)) newShows.push(r.mediaId);
    }
    if (!isSeries && r.plays.length && !r.resume) {
      // A movie that is finished no longer has a resume point. (nuvioRecords already
      // dropped a resume that an equal or later play cancels, so one still here is a
      // rewatch in progress and stays.)
      stmts.push(actDb.prepare("UPDATE show_progress SET companion_json = NULL WHERE account_id = ? AND media_id = ? AND last_season IS NULL").bind(accountId, r.mediaId));
    }
    if (isSeries && r.furthest && (!datedLast || r.furthest.season > datedLast.season
      || (r.furthest.season === datedLast.season && r.furthest.episode > datedLast.episode))) {
      // Watched, with no date of its own: move the show's furthest mark only.
      // The second statement of a play is the forward-only show_progress upsert.
      stmts.push(activityPlayStatements(actDb, accountId, r.mediaId, { season: r.furthest.season, episode: r.furthest.episode, watchedAt: r.at, legacyId: null }, provider, now)[1]);
      out.progress++;
      if (!knownShows.has(r.mediaId) && !newShows.includes(r.mediaId)) newShows.push(r.mediaId);
    }
    if (r.resume) {
      if (isSeries) {
        // Part way through an episode: the show stands one episode before it,
        // so Continue Watching offers this episode.
        stmts.push(activityPlayStatements(actDb, accountId, r.mediaId, { season: r.resume.season, episode: Math.max(0, r.resume.episode - 1), watchedAt: r.at, legacyId: null }, provider, now)[1]);
        out.resumes++;
        if (!knownShows.has(r.mediaId) && !newShows.includes(r.mediaId)) newShows.push(r.mediaId);
      } else {
        const entry = { id: r.imdbId || `tmdb:${r.tmdbId}`, imdbId: r.imdbId || undefined, source: provider, type: "movie", name: r.title || undefined, poster: r.poster || undefined, progress: Math.round(r.resume.ratio * 100) };
        stmts.push(actDb.prepare(
          `INSERT INTO show_progress (account_id, media_id, last_watched_at, companion_json, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (account_id, media_id) DO UPDATE SET
             companion_json = excluded.companion_json, last_watched_at = excluded.last_watched_at, updated_at = excluded.updated_at
           WHERE show_progress.last_season IS NULL AND COALESCE(show_progress.last_watched_at, 0) < excluded.last_watched_at`
        ).bind(accountId, r.mediaId, r.at, JSON.stringify(entry), now));
        out.resumes++;
      }
    }
  }
  if (positionsReady) stmts.push(...mediaAppPositionStatements(actDb, accountId, provider, usable, now));
  for (let i = 0; i < stmts.length; i += 50) await actDb.batch(stmts.slice(i, i + 50));
  // The first time an account watches a show, one more watcher on its schedule.
  for (const mediaId of newShows) {
    try {
      await env.DB.prepare(
        `INSERT INTO show_schedule (media_id, watcher_count, next_check_at) VALUES (?, 1, 0)
         ON CONFLICT (media_id) DO UPDATE SET watcher_count = show_schedule.watcher_count + 1`
      ).bind(mediaId).run();
    } catch (e) {
      if (!/no such table/i.test(String((e && e.message) || e))) console.error("mediaapp: watcher count failed", e);
    }
  }
  return out;
}

// --- Settings row ----------------------------------------------------------------------

async function loadMediaAppSync(env, accountId, provider) {
  try {
    return await env.DB.prepare(
      "SELECT profile_index, pull_enabled, push_enabled, cursor_json, last_pull_at, last_push_at, last_error FROM media_app_sync WHERE account_id = ? AND provider = ?"
    ).bind(accountId, provider).first();
  } catch (e) {
    if (/no such table/i.test(String((e && e.message) || e))) return null;
    throw e;
  }
}

// Makes the row for a newly connected app (settings keep their values when the
// person connects again). false when migration 0023 has not been applied.
async function ensureMediaAppSync(env, accountId, provider, profileIndex) {
  try {
    await env.DB.prepare(
      `INSERT INTO media_app_sync (account_id, provider, profile_index, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (account_id, provider) DO UPDATE SET
         profile_index = COALESCE(excluded.profile_index, media_app_sync.profile_index), last_error = NULL, updated_at = excluded.updated_at`
    ).bind(accountId, provider, profileIndex == null ? null : profileIndex, Date.now()).run();
    return true;
  } catch (e) {
    if (/no such table/i.test(String((e && e.message) || e))) return false;
    throw e;
  }
}

// The Nuvio profile names, kept in cursor_json beside the pull position so the
// settings page can name them (cursor_json is otherwise { mtime, pushedId }).
async function saveNuvioProfiles(env, accountId, profiles) {
  const row = await loadMediaAppSync(env, accountId, "nuvio");
  if (!row) return;
  let cursor = {};
  try {
    cursor = row.cursor_json ? JSON.parse(row.cursor_json) : {};
  } catch {}
  await env.DB.prepare("UPDATE media_app_sync SET cursor_json = ?, updated_at = ? WHERE account_id = ? AND provider = 'nuvio'")
    .bind(JSON.stringify({ ...cursor, profiles }), Date.now(), accountId).run();
}

// What the last finished pull found, kept in cursor_json for the settings card:
// titles the app holds, what was recorded this run, and titles with no usable id.
async function saveMediaAppLastResult(env, accountId, provider, last) {
  try {
    const row = await loadMediaAppSync(env, accountId, provider);
    if (!row) return;
    let cursor = {};
    try {
      cursor = row.cursor_json ? JSON.parse(row.cursor_json) : {};
    } catch {}
    await env.DB.prepare("UPDATE media_app_sync SET cursor_json = ? WHERE account_id = ? AND provider = ?")
      .bind(JSON.stringify({ ...cursor, last }), accountId, provider).run();
  } catch (e) {
    console.error("mediaapp: could not keep the last result", e);
  }
}

function mediaAppLastResultOf(row) {
  try {
    const l = row && row.cursor_json ? JSON.parse(row.cursor_json).last : null;
    return l && typeof l === "object" ? l : null;
  } catch {
    return null;
  }
}

// The resume map with the changes applied, newest MEDIA_APP_RESUMES_MAX kept.
const MEDIA_APP_RESUMES_MAX = 10000;
function mergeMediaAppResumes(current, changes) {
  const map = { ...(current && typeof current === "object" ? current : {}) };
  for (const [key, value] of changes || []) {
    if (value) map[key] = value;
    else delete map[key];
  }
  const keys = Object.keys(map);
  if (keys.length > MEDIA_APP_RESUMES_MAX) {
    keys.sort((a, b) => (map[b].at || 0) - (map[a].at || 0)).slice(MEDIA_APP_RESUMES_MAX).forEach((k) => delete map[k]);
  }
  return map;
}

function mediaAppProfilesOf(row) {
  try {
    const p = row && row.cursor_json ? JSON.parse(row.cursor_json).profiles : null;
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

async function setMediaAppSyncError(env, accountId, provider, message) {
  try {
    await env.DB.prepare("UPDATE media_app_sync SET last_error = ?, updated_at = ? WHERE account_id = ? AND provider = ?")
      .bind(message ? String(message).slice(0, 300) : null, Date.now(), accountId, provider).run();
  } catch {}
}

// --- One account's pull ------------------------------------------------------------------

// Reads the app's data and returns { records } for the step's slice, plus how
// many titles there are to go through. Throws a mediaAppError.
async function mediaAppFetchRecords(env, accountId, provider, conn, sync, step) {
  const since = step.since;
  const fresh = (rec) => !since || rec.mtime >= since;
  if (provider === "stremio") {
    const library = await stremioFetchLibrary(conn.accessToken);
    const changed = library.filter((it) => !since || mediaAppTime(it._mtime) >= since);
    const slice = changed.slice(step.offset, step.offset + MEDIA_APP_STEP_ITEMS);
    let cinemeta = MEDIA_APP_CINEMETA_PER_STEP;
    const records = [];
    for (const item of slice) {
      let episodes = null;
      const hasBits = mediaAppKind(item.type) === "series" && item.state && item.state.watched;
      if (hasBits && cinemeta > 0) {
        cinemeta--;
        episodes = await stremioEpisodes(String(item._id));
      }
      const rec = await stremioItemRecord(item, episodes);
      if (rec) records.push(rec);
    }
    return { records, total: changed.length, libraryTotal: library.length, newest: library.length ? mediaAppTime(library[0]._mtime) : 0 };
  }
  const read = await nuvioReadProfile(env, conn.accessToken, sync.profile_index, step);
  const delta = read.mode === "delta";
  const every = nuvioRecords(delta ? read : read.profile);
  // A resume point Nuvio dropped is written as a record with none, unless the title has a record already.
  const have = new Set(every.map((r) => r.imdbId || `${r.kind}|tmdb:${r.tmdbId}`));
  for (const c of read.cleared) if (!have.has(c.key)) every.push(nuvioClearedStub(c.key, c.kind));
  // A change read has no "changed since" filter (the events are the changes) and
  // no whole-profile resume map: it edits the stored one.
  const all = delta ? every : every.filter(fresh);
  const snapshotResumes = !delta && step.offset === 0 ? mediaAppResumeChanges(every, provider).filter(([, value]) => value) : null;
  if (snapshotResumes && snapshotResumes.length > MEDIA_APP_RESUMES_MAX) throw mediaAppError("unreachable", "Nuvio has too many resume points to sync safely.");
  return { records: all.slice(step.offset, step.offset + MEDIA_APP_STEP_ITEMS), total: all.length, libraryTotal: delta ? null : every.length, newest: all.length ? all[0].mtime : 0, snapshotResumes, delta, removedPlays: read.removed, pendingDelta: read.pending };
}

// One step of an account's pull. Returns { done, offset, total, ... }; throws
// for a failure worth trying again (the job's retry) and marks the connection
// when the service refuses the sign-in.
async function pullMediaAppStep(env, accountId, provider, offset, cursorSince) {
  if (!env || !env.DB || !hasTokenEncryptionKey(env)) return { done: true, skipped: "not available" };
  const sync = await loadMediaAppSync(env, accountId, provider);
  if (!sync || !sync.pull_enabled) return { done: true, skipped: "off" };
  if (provider === "nuvio" && !sync.profile_index) return { done: true, skipped: "no profile chosen" };
  let conn = await loadProviderConnection(env, accountId, provider);
  if (!conn || conn.status !== "ok") return { done: true, skipped: "not connected" };
  if (provider === "nuvio") {
    conn = await refreshProviderConnectionIfDue(env, accountId, provider, conn);
    if (!conn || !conn.accessToken) {
      await setMediaAppSyncError(env, accountId, provider, "Nuvio needs you to sign in again.");
      return { done: true, skipped: "reauth" };
    }
  }
  let cursor = {};
  try {
    cursor = sync.cursor_json ? JSON.parse(sync.cursor_json) : {};
  } catch {}
  const since = cursorSince != null ? cursorSince : (provider === "nuvio" && cursor.provenanceVersion !== 1 ? 0 : (Number(cursor.mtime) > 0 ? Number(cursor.mtime) - MEDIA_APP_OVERLAP_MS : 0));
  let fetched;
  try {
    fetched = await mediaAppFetchRecords(env, accountId, provider, conn, sync, { offset, since, cursor, delta: provider === "nuvio" && cursorSince == null });
  } catch (e) {
    if (e && e.kind === "invalid") {
      await markConnectionStatus(env, accountId, provider, "reauth_required", "The service refused this sign-in. Connect it again.");
      await setMediaAppSyncError(env, accountId, provider, "Sign in again to keep syncing.");
      return { done: true, skipped: "reauth" };
    }
    // Busy, a conflict, data refused, or Nuvio down: say so on the settings page, and let the job try again.
    if (provider === "nuvio" && e && e.kind === "unreachable") await setMediaAppSyncError(env, accountId, provider, await nuvioFailureMessage(env, e));
    throw e;
  }
  const applied = await applyMediaAppRecords(env, accountId, provider, fetched.records);
  if (applied.skipped) {
    await setMediaAppSyncError(env, accountId, provider, applied.skipped);
    return { done: true, skipped: applied.skipped };
  }
  if (fetched.snapshotResumes) cursor.resumes = mergeMediaAppResumes({}, fetched.snapshotResumes);
  // Watched items deleted in Nuvio, when this account mirrors it: once, on the first step of a change read.
  if (offset === 0 && fetched.delta && fetched.removedPlays && fetched.removedPlays.length && mediaAppMirrorOn(sync)) {
    applied.removed = await mirrorRemovePlays(env, accountId, provider, fetched.removedPlays);
  }
  if (applied.resumeChanges && applied.resumeChanges.length) cursor.resumes = mergeMediaAppResumes(cursor.resumes, applied.resumeChanges);
  if (offset === 0) {
    // Never keep a mark from an earlier, abandoned pull.
    if (fetched.pendingDelta) cursor.pendingDelta = fetched.pendingDelta;
    else delete cursor.pendingDelta;
  }
  const next = offset + MEDIA_APP_STEP_ITEMS;
  if (next < fetched.total) {
    if (fetched.snapshotResumes || fetched.pendingDelta || (applied.resumeChanges && applied.resumeChanges.length)) {
      await env.DB.prepare("UPDATE media_app_sync SET cursor_json = ? WHERE account_id = ? AND provider = ?").bind(JSON.stringify(cursor), accountId, provider).run();
    }
    // A change read continues as one (no "since"), a full read with the mark it started with.
    return { done: false, offset: next, total: fetched.total, since: fetched.delta ? null : since, applied };
  }
  if (provider === "nuvio" && since === 0) cursor.provenanceVersion = 1;
  if (provider === "nuvio") {
    // The change cursors are kept only once everything up to them has been applied.
    if (cursor.pendingDelta) cursor.delta = cursor.pendingDelta;
    else delete cursor.delta;
    delete cursor.pendingDelta;
  }
  await purgeRemovedPlays(env, accountId);
  const nowMs = Date.now();
  await env.DB.prepare(
    "UPDATE media_app_sync SET cursor_json = ?, last_pull_at = ?, last_error = NULL, updated_at = ? WHERE account_id = ? AND provider = ?"
  ).bind(JSON.stringify({ ...cursor, mtime: Math.max(Number(cursor.mtime) || 0, fetched.newest || 0) }), nowMs, nowMs, accountId, provider).run();
  // A change read does not count the whole profile, so the last full count stands.
  const found = fetched.libraryTotal != null ? fetched.libraryTotal : ((mediaAppLastResultOf(sync) || {}).found || 0);
  const overview = provider === "nuvio" ? await nuvioFetchOverview(env, conn.accessToken, sync.profile_index) : undefined;
  return { done: true, total: fetched.total, found, applied, pullDone: true, overview };
}

// The job. Each run is one bounded step: a slice of the pull, then (when
// two-way sync is on) slices of the push. The first step of a pull fixes the
// "changed since" mark so later steps see the same list.
async function runMediaAppSyncJob(env, payload, job = {}) {
  const accountId = Number(payload && payload.accountId);
  const provider = String((payload && payload.provider) || "");
  if (!Number.isInteger(accountId) || !MEDIA_APP_PROVIDERS.includes(provider)) return { progress: {} };
  const prev = job.progress || {};
  const totals = { plays: Number(prev.plays) || 0, progress: Number(prev.progress) || 0, resumes: Number(prev.resumes) || 0, unresolved: Number(prev.unresolved) || 0, pushed: Number(prev.pushed) || 0 };
  if (prev.phase !== "push") {
    // Where to start: this job's own progress, or where the request that started it stopped.
    const offset = Number(prev.offset != null ? prev.offset : payload.offset) || 0;
    const sinceAt = prev.offset != null ? prev.since : payload.since;
    const out = await pullMediaAppStep(env, accountId, provider, offset, offset > 0 && sinceAt != null ? Number(sinceAt) : null);
    if (out.applied) {
      totals.plays += out.applied.plays;
      totals.progress += out.applied.progress;
      totals.resumes += out.applied.resumes;
      totals.unresolved += out.applied.unresolved;
    }
    if (!out.done) return { progress: { offset: out.offset, since: out.since, total: out.total, ...totals }, again: true };
    if (!out.pullDone) return { progress: { finishedAt: Date.now(), total: out.total || 0, skipped: out.skipped || null, ...totals } };
    await saveMediaAppLastResult(env, accountId, provider, { found: out.found || 0, plays: totals.plays, progress: totals.progress, resumes: totals.resumes, unresolved: totals.unresolved, overview: out.overview });
  }
  const pushed = await pushMediaAppStep(env, accountId, provider);
  totals.pushed += pushed.sent || 0;
  if (pushed.more) return { progress: { phase: "push", ...totals }, again: true };
  return { progress: { finishedAt: Date.now(), skipped: pushed.skipped || null, ...totals } };
}

// --- Two-way sync: sending plays to the app ---------------------------------------------------

const MEDIA_APP_PUSH_EVENTS = 200;
const MEDIA_APP_PUSH_CHUNK = 500;

function mediaAppPushFlag(env) {
  const v = env ? env.FF_MEDIA_APP_PUSH : undefined;
  return v === "1" || v === "true" || v === true;
}

// The bitfield for `episodes` (the show's list, in Stremio's order) with the
// episodes in `watchedKeys` ("season:episode") set. The inverse of
// stremioWatchedEpisodes: the anchor is the last watched episode.
async function stremioEncodeWatched(episodes, watchedKeys) {
  let last = 0;
  episodes.forEach((e, i) => { if (watchedKeys.has(`${e.season}:${e.episode}`)) last = i; });
  const length = last + 1;
  const bytes = new Uint8Array(Math.ceil(length / 8));
  for (let i = 0; i <= last; i++) {
    if (watchedKeys.has(`${episodes[i].season}:${episodes[i].episode}`)) bytes[i >> 3] |= 1 << (i & 7);
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  const zipped = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = "";
  for (const b of zipped) bin += String.fromCharCode(b);
  return `${episodes[last].id}:${length}:${btoa(bin)}`;
}

// The library items to write for `groups` (imdb id -> { kind, plays }), each
// the item as just read with only its watched state changed. Titles that are
// not in the library, and shows Cinemeta cannot list, are skipped.
async function stremioPushChanges(library, groups, nowIso) {
  const byId = new Map(library.map((it) => [String(it._id), it]));
  const changes = [];
  let skipped = 0;
  let cinemeta = MEDIA_APP_CINEMETA_PER_STEP;
  for (const [imdb, g] of groups) {
    const item = byId.get(imdb);
    if (!item) {
      skipped++;
      continue;
    }
    const st = item.state && typeof item.state === "object" ? item.state : {};
    if (g.kind === "movie") {
      if (Number(st.timesWatched) > 0 || Number(st.flaggedWatched) > 0) continue;
      const at = Math.max(...g.plays.map((p) => p.watchedAt));
      const later = !mediaAppTime(st.lastWatched) || mediaAppTime(st.lastWatched) < at;
      changes.push({ ...item, _mtime: nowIso, state: { ...st, flaggedWatched: 1, timesWatched: Math.max(1, Number(st.timesWatched) || 0), lastWatched: later ? new Date(at).toISOString() : st.lastWatched } });
      continue;
    }
    if (cinemeta <= 0) {
      skipped++;
      continue;
    }
    cinemeta--;
    const eps = await stremioEpisodes(imdb);
    if (!eps) {
      skipped++;
      continue;
    }
    const have = new Set((st.watched ? await stremioWatchedEpisodes(st.watched, eps) : []).map((e) => `${e.season}:${e.episode}`));
    const listed = new Set(eps.map((e) => `${e.season}:${e.episode}`));
    let added = 0;
    for (const p of g.plays) {
      const key = `${p.season}:${p.episode}`;
      if (listed.has(key) && !have.has(key)) {
        have.add(key);
        added++;
      }
    }
    if (!added) continue;
    changes.push({ ...item, _mtime: nowIso, state: { ...st, watched: await stremioEncodeWatched(eps, have) } });
  }
  return { changes, skipped };
}

// The public Nuvio API accepts snake_case fields and epoch milliseconds,
// even when the profile has no watched items yet.
function nuvioWatchedItem(rec) {
  const item = { content_id: rec.contentId, content_type: rec.kind, title: rec.title || "", watched_at: rec.watchedAt };
  if (rec.kind === "series") {
    item.season = rec.season;
    item.episode = rec.episode;
  }
  return item;
}

// One slice of plays for the app. { sent, more, skipped }; never throws: a
// failure is written on the settings row and the next run tries again from the
// same place.
async function pushMediaAppStep(env, accountId, provider) {
  const none = (skipped) => ({ sent: 0, more: false, skipped });
  try {
    if (!mediaAppPushFlag(env)) return none("off");
    const sync = await loadMediaAppSync(env, accountId, provider);
    if (!sync || !sync.push_enabled || (provider === "nuvio" && !sync.profile_index)) return none("off");
    const actDb = activityDb(env, accountId);
    if (!actDb || !(await activitySchemaReady(actDb))) return none("no activity database");
    let conn = await loadProviderConnection(env, accountId, provider);
    if (!conn || conn.status !== "ok") return none("not connected");
    if (provider === "nuvio") {
      conn = await refreshProviderConnectionIfDue(env, accountId, provider, conn);
      if (!conn || !conn.accessToken) return none("reauth");
    }
    let cursor = {};
    try {
      cursor = sync.cursor_json ? JSON.parse(sync.cursor_json) : {};
    } catch {}
    const after = Number(cursor.pushedId) || 0;
    if (provider === "nuvio") await refreshTraktPositions(env, accountId);
    const positionsSent = provider === "nuvio" ? await pushNuvioPositions(env, accountId, conn, sync, actDb) : 0;
    const { results: rows } = await actDb.prepare(
      "SELECT id, media_id, season, episode, watched_at FROM watch_events WHERE account_id = ? AND id > ? AND source != ? AND NOT EXISTS (SELECT 1 FROM watch_event_sources s WHERE s.event_id = watch_events.id AND s.source = ?) ORDER BY id LIMIT ?"
    ).bind(accountId, after, provider, provider, MEDIA_APP_PUSH_EVENTS).all();
    const events = rows || [];
    if (!events.length) return { sent: positionsSent, more: false, skipped: null };
    const ids = [...new Set(events.map((e) => e.media_id))];
    const { results: media } = await env.DB.prepare(
      "SELECT id, kind, imdb_id, title FROM media WHERE id IN (SELECT value FROM json_each(?))"
    ).bind(JSON.stringify(ids)).all();
    const titleOf = new Map((media || []).filter((m) => m.imdb_id).map((m) => [m.id, m]));
    const plays = events.filter((e) => titleOf.has(e.media_id)).map((e) => {
      const m = titleOf.get(e.media_id);
      const isEpisode = e.season != null && e.episode != null;
      return { contentId: m.imdb_id, title: m.title || "", kind: isEpisode ? "series" : "movie", season: e.season, episode: e.episode, watchedAt: Number(e.watched_at) };
    });

    let sent = 0;
    if (plays.length) {
      if (provider === "stremio") {
        const library = await stremioFetchLibrary(conn.accessToken);
        const groups = new Map();
        for (const p of plays) {
          const g = groups.get(p.contentId) || { kind: p.kind, plays: [] };
          g.plays.push(p);
          groups.set(p.contentId, g);
        }
        const { changes } = await stremioPushChanges(library, groups, new Date().toISOString());
        for (let i = 0; i < changes.length; i += 50) {
          const res = await stremioCall("datastorePut", { authKey: conn.accessToken, collection: "libraryItem", changes: changes.slice(i, i + 50) });
          if (!res || res.success !== true) throw mediaAppError("unreachable", "Stremio did not accept the update.");
        }
        sent = changes.length;
      } else {
        const profile = await nuvioFetchProfile(env, conn.accessToken, sync.profile_index);
        const present = new Set(profile.watched.map((w) => `${String(mediaAppPick(w, "content_id", "contentId") || "").toLowerCase()}:${mediaAppInt(w.season) == null ? "" : mediaAppInt(w.season)}:${mediaAppInt(w.episode) == null ? "" : mediaAppInt(w.episode)}`));
        const fresh = plays.filter((p) => !present.has(`${p.contentId}:${p.season == null ? "" : p.season}:${p.episode == null ? "" : p.episode}`));
        for (let i = 0; i < fresh.length; i += MEDIA_APP_PUSH_CHUNK) {
          await nuvioRpc(env, conn.accessToken, "sync_push_watched_items", { p_profile_id: sync.profile_index, p_items: fresh.slice(i, i + MEDIA_APP_PUSH_CHUNK).map((p) => nuvioWatchedItem(p)) });
        }
        sent = fresh.length;
      }
    }
    const nowMs = Date.now();
    await env.DB.prepare("UPDATE media_app_sync SET cursor_json = ?, last_push_at = ?, last_error = NULL, updated_at = ? WHERE account_id = ? AND provider = ?")
      .bind(JSON.stringify({ ...cursor, pushedId: events[events.length - 1].id }), nowMs, nowMs, accountId, provider).run();
    return { sent: sent + positionsSent, more: events.length >= MEDIA_APP_PUSH_EVENTS, skipped: null };
  } catch (e) {
    if (e && e.kind === "invalid") {
      await markConnectionStatus(env, accountId, provider, "reauth_required", "The service refused this sign-in. Connect it again.");
      await setMediaAppSyncError(env, accountId, provider, "Sign in again to keep syncing.");
      return none("reauth");
    }
    console.error(`mediaapp: push to ${provider} failed`, e);
    await setMediaAppSyncError(env, accountId, provider, "Could not send your plays just now. It will try again.");
    return none("error");
  }
}

// --- Removing an item from the app, from the website -------------------------------------------
//
// The tile's remove button on the Nuvio and Stremio lists. It removes the item in the app
// itself (so it is gone there too, and a later pull does not bring it back), then here.
// Behind the same switch as two-way sync (FF_MEDIA_APP_PUSH): it writes into the person's
// account, in formats not checked against a live one. If the app refuses, nothing is changed
// here either.
//   history            Stremio: marked unwatched, position cleared. Nuvio: its watched rows deleted.
//   continue-watching  Stremio: position cleared. Nuvio: its progress keys deleted.
// A show means all of its episodes. Nothing of any other title is touched.

const MEDIA_APP_REMOVE_TARGETS = ["history", "continue-watching"];

async function stremioRemoveTitle(conn, imdbId, target) {
  const library = await stremioFetchLibrary(conn.accessToken);
  const item = library.find((it) => String(it._id) === imdbId);
  if (!item) return false;
  const st = item.state && typeof item.state === "object" ? item.state : {};
  const state = target === "continue-watching" ? { ...st, timeOffset: 0 } : { ...st, timesWatched: 0, flaggedWatched: 0, timeOffset: 0 };
  if (target === "history") delete state.watched;
  const res = await stremioCall("datastorePut", { authKey: conn.accessToken, collection: "libraryItem", changes: [{ ...item, _mtime: new Date().toISOString(), state }] });
  if (!res || res.success !== true) throw mediaAppError("unreachable", "Stremio did not accept the change.");
  return true;
}

async function nuvioRemoveTitle(env, conn, profileIndex, titleIds, target, kind) {
  const profile = await nuvioFetchProfile(env, conn.accessToken, profileIndex);
  const mine = (row) => titleIds.includes(String(mediaAppPick(row, "content_id", "contentId") || "").toLowerCase()) && (!kind || mediaAppKind(mediaAppPick(row, "content_type", "contentType")) === kind);
  if (target === "history") {
    const rows = profile.watched.filter(mine);
    // The public delete RPC always expects snake_case identity keys.
    const keys = rows.map((r) => {
      const key = { content_id: mediaAppPick(r, "content_id", "contentId") };
      if (r.season != null && r.episode != null) { key.season = r.season; key.episode = r.episode; }
      return key;
    });
    for (let i = 0; i < keys.length; i += MEDIA_APP_PUSH_CHUNK) {
      await nuvioRpc(env, conn.accessToken, "sync_delete_watched_items", { p_profile_id: profileIndex, p_keys: keys.slice(i, i + MEDIA_APP_PUSH_CHUNK) });
    }
    return rows.length > 0;
  }
  const rows = profile.progress.filter(mine);
  const keys = rows.map((r) => {
    const id = String(mediaAppPick(r, "content_id", "contentId"));
    const season = mediaAppInt(r.season), episode = mediaAppInt(r.episode);
    return season != null && episode != null ? `${id}_s${season}e${episode}` : id;
  });
  for (let i = 0; i < keys.length; i += MEDIA_APP_PUSH_CHUNK) {
    await nuvioRpc(env, conn.accessToken, "sync_delete_watch_progress", { p_profile_id: profileIndex, p_keys: keys.slice(i, i + MEDIA_APP_PUSH_CHUNK) });
  }
  return rows.length > 0;
}

// The same removal here: the app's own plays of the title (history), its resume numbers, and
// for Continue Watching the kept movie entry or, for a show, a dismissal at the furthest episode
// watched (the way the website's own Continue Watching removal works). Returns the plays removed.
async function removeMediaAppItemLocally(env, accountId, provider, media, imdbId, target) {
  const actDb = activityDb(env, accountId);
  let removed = 0;
  if (actDb && media && (await activitySchemaReady(actDb))) {
    if (target === "history") {
      // Unlink this app from other sources' plays. If an event originated in
      // this app but another app also reported it, transfer ownership rather
      // than deleting that other app's only copy.
      const out = await actDb.batch([
        actDb.prepare("DELETE FROM watch_event_sources WHERE source = ? AND event_id IN (SELECT id FROM watch_events WHERE account_id = ? AND media_id = ?)").bind(provider, accountId, media.id),
        actDb.prepare(`UPDATE watch_events SET source = (SELECT s.source FROM watch_event_sources s WHERE s.event_id = watch_events.id ORDER BY s.source LIMIT 1)
          WHERE account_id = ? AND media_id = ? AND source = ? AND EXISTS (SELECT 1 FROM watch_event_sources s WHERE s.event_id = watch_events.id)`).bind(accountId, media.id, provider),
        actDb.prepare("DELETE FROM watch_events WHERE account_id = ? AND media_id = ? AND source = ?").bind(accountId, media.id, provider),
      ]);
      removed = out.reduce((n, r) => n + (Number(r && r.meta && r.meta.changes) || 0), 0);
    } else {
      await actDb.batch([
        actDb.prepare("UPDATE show_progress SET companion_json = NULL WHERE account_id = ? AND media_id = ? AND last_season IS NULL").bind(accountId, media.id),
        actDb.prepare("UPDATE show_progress SET dismissed_at_season = last_season, dismissed_at_episode = COALESCE(last_episode, 0) WHERE account_id = ? AND media_id = ? AND last_season IS NOT NULL").bind(accountId, media.id),
      ]);
    }
  }
  const row = await loadMediaAppSync(env, accountId, provider);
  if (row) {
    let cursor = {};
    try {
      cursor = row.cursor_json ? JSON.parse(row.cursor_json) : {};
    } catch {}
    const resumeIds = [imdbId, media && media.tmdb_id ? `tmdb:${media.tmdb_id}` : null].filter(Boolean);
    const resumeKeys = resumeIds.flatMap((id) => [id, ...(media && media.kind ? [`${media.kind}|${id}`] : [`movie|${id}`, `series|${id}`])]);
    if (cursor.resumes && resumeKeys.some((key) => cursor.resumes[key])) {
      cursor.resumes = mergeMediaAppResumes(cursor.resumes, resumeKeys.map((key) => [key, null]));
      await env.DB.prepare("UPDATE media_app_sync SET cursor_json = ? WHERE account_id = ? AND provider = ?").bind(JSON.stringify(cursor), accountId, provider).run();
    }
  }
  return { removed, found: Boolean(media) };
}

// A play the website has just recorded is sent to each app with two-way sync on, soon,
// rather than at the next hourly job.
async function nudgeMediaAppPush(env, accountId) {
  try {
    if (!mediaAppPushFlag(env)) return;
    const { results } = await env.DB.prepare("SELECT provider FROM media_app_sync WHERE account_id = ? AND push_enabled = 1").bind(accountId).all();
    for (const r of results || []) await startMediaAppSync(env, accountId, r.provider);
  } catch (e) {
    if (!/no such table/i.test(String((e && e.message) || e))) console.error("mediaapp: could not start a push", e);
  }
}

// Starts a pull for one account's app (what connecting and "Sync now" do).
async function startMediaAppSync(env, accountId, provider, from) {
  const payload = { accountId, provider };
  if (from && from.offset > 0) {
    payload.offset = from.offset;
    payload.since = from.since;
  }
  return createJob(env, MEDIA_APP_SYNC_JOB, { dedupeKey: `mediaapp:${accountId}:${provider}`, accountId, payload });
}

// A copy younger than this is not asked about again when someone looks.
const MEDIA_APP_FRESH_MS = 2 * 60 * 1000;
// What one request may do: a few slices of the library, the rest goes to the job.
const MEDIA_APP_REQUEST_STEPS = 3;

// The pull, done now and in the request, so what is on the page is what the app
// holds (connecting, opening Lists, Sync now). The same step the job runs, so it is
// idempotent. Skipped when the copy is fresh or the account's job is running; a
// library too big for the request is handed on from where it stopped.
// { skipped } or { done, completed }. Throws what the pull throws.
async function refreshMediaAppNow(env, accountId, provider, { maxSteps = MEDIA_APP_REQUEST_STEPS, force = false } = {}) {
  const sync = await loadMediaAppSync(env, accountId, provider);
  if (!sync) return { skipped: "off" };
  if (!force && sync.last_pull_at && Date.now() - Number(sync.last_pull_at) < MEDIA_APP_FRESH_MS) return { skipped: "fresh" };
  try {
    const running = await env.DB.prepare("SELECT status, run_after FROM jobs WHERE dedupe_key = ?").bind(`mediaapp:${accountId}:${provider}`).first();
    if (running && running.status === "running" && Number(running.run_after) > Date.now()) return { skipped: "busy" };
  } catch {}
  const totals = { plays: 0, progress: 0, resumes: 0, unresolved: 0 };
  let offset = 0;
  // A forced Nuvio sync must revisit old records too, including ones an
  // earlier incomplete pull never stored. Carry zero through queued steps.
  let since = force && provider === "nuvio" ? 0 : null;
  for (let i = 0; i < maxSteps; i++) {
    const out = await pullMediaAppStep(env, accountId, provider, offset, since);
    if (out.applied) for (const k of Object.keys(totals)) totals[k] += out.applied[k] || 0;
    if (!out.done) {
      offset = out.offset;
      since = out.since;
      continue;
    }
    if (!out.pullDone) return { done: true, skipped: out.skipped || "off" };
    await saveMediaAppLastResult(env, accountId, provider, { found: out.found || 0, ...totals, overview: out.overview });
    return { done: true, completed: true };
  }
  await startMediaAppSync(env, accountId, provider, { offset, since });
  return { done: false };
}

// After connecting: the first slices now, so the lists have content when the card says
// Connected. Never fails the connection: whatever is left, or went wrong, is the job's.
async function refreshAfterConnect(env, accountId, provider) {
  let done = false;
  try {
    const r = await refreshMediaAppNow(env, accountId, provider, { maxSteps: 2, force: true });
    done = Boolean(r.completed || r.done === false);
  } catch (e) {
    console.error(`mediaapp: the first pull of ${provider} failed`, e);
  }
  if (!done) await startMediaAppSync(env, accountId, provider);
}

// Accounts whose last pull is older than the interval, a few at a time.
async function runMediaAppSyncSweep(env) {
  if (!env || !env.DB) return { due: 0 };
  let rows;
  try {
    ({ results: rows } = await env.DB.prepare(
      `SELECT s.account_id, s.provider FROM media_app_sync s
       JOIN provider_connections c ON c.account_id = s.account_id AND c.provider = s.provider
       WHERE s.pull_enabled = 1 AND c.status = 'ok' AND COALESCE(s.last_pull_at, 0) < ?
       ORDER BY COALESCE(s.last_pull_at, 0) LIMIT ?`
    ).bind(Date.now() - MEDIA_APP_DUE_MS, MEDIA_APP_ACCOUNTS_PER_RUN).all());
  } catch (e) {
    if (/no such table/i.test(jobErrorText(e))) return { due: 0 };
    throw e;
  }
  let started = 0;
  for (const r of rows || []) {
    const made = await startMediaAppSync(env, r.account_id, r.provider);
    if (made && made.ok && made.created) started++;
  }
  return { due: (rows || []).length, started };
}

defineDurableJob(MEDIA_APP_SYNC_JOB, { run: (env, payload, job) => runMediaAppSyncJob(env, payload, job) });
definePeriodicJob("mediaapp.sync", { everyMs: MEDIA_APP_EVERY_MS, run: (env) => runMediaAppSyncSweep(env) });

// --- Routes (reached from handleConnectionsApiRoutes, 28_) --------------------------------

function mediaAppSyncSummary(row) {
  if (!row) return null;
  return {
    profileIndex: row.profile_index == null ? null : row.profile_index,
    pull: Boolean(row.pull_enabled),
    push: Boolean(row.push_enabled),
    mirror: mediaAppMirrorOn(row),
    lastPullAt: row.last_pull_at || null,
    lastPushAt: row.last_push_at || null,
    lastResult: mediaAppLastResultOf(row),
    error: row.last_error || null,
  };
}

// Twin of src/client/17_client-my-lists-and-trakt-oauth.js:extractNuvioCollections; tests/server-client-parity.test.mjs keeps them equal.
function extractNuvioCollections(raw) {
  let val = raw;
  if (typeof val === "string") {
    try { val = JSON.parse(val); } catch { return []; }
  }
  if (!val) return [];
  if (val.collections_json != null) return extractNuvioCollections(val.collections_json);
  if (val.p_collections_json != null) return extractNuvioCollections(val.p_collections_json);
  if (val.collections != null) return extractNuvioCollections(val.collections);
  if (val.p_collections != null) return extractNuvioCollections(val.p_collections);
  if (val.data != null) return extractNuvioCollections(val.data);
  if (Array.isArray(val)) {
    const out = [];
    for (const item of val) {
      if (!item) continue;
      if (item.collections_json != null) {
        out.push(...extractNuvioCollections(item.collections_json));
      } else if (item.p_collections_json != null) {
        out.push(...extractNuvioCollections(item.p_collections_json));
      } else if (item.collections != null) {
        out.push(...extractNuvioCollections(item.collections));
      } else if (item.p_collections != null) {
        out.push(...extractNuvioCollections(item.p_collections));
      } else if (item.data != null) {
        out.push(...extractNuvioCollections(item.data));
      } else {
        const itemTitle = String(item.title || item.name || "").trim();
        const hasFolders = Array.isArray(item.folders) && item.folders.length > 0;
        const hasSources = Array.isArray(item.catalogSources) && item.catalogSources.length > 0;
        if (item.id || itemTitle || hasFolders || hasSources) {
          out.push(item);
        }
      }
    }
    return out;
  }
  if (typeof val === "object") {
    const valTitle = String(val.title || val.name || "").trim();
    const hasFolders = Array.isArray(val.folders) && val.folders.length > 0;
    const hasSources = Array.isArray(val.catalogSources) && val.catalogSources.length > 0;
    if (val.id || valTitle || hasFolders || hasSources) {
      return [val];
    }
  }
  return [];
}

// My Lists owns these collection IDs; catalog sources or display names alone
// do not identify the collection creator.
// Twin of src/client/17_client-my-lists-and-trakt-oauth.js:isMyListsNuvioCollectionId; tests/server-client-parity.test.mjs keeps them equal.
function isMyListsNuvioCollectionId(id) {
  const value = String(id || "");
  return value === "my-lists-collections" || value === "my-lists-addon" || value.startsWith("col_mylists_");
}

// Twin of src/client/17_client-my-lists-and-trakt-oauth.js:addNewNuvioCollection; tests/server-client-parity.test.mjs keeps them equal.
function addNewNuvioCollection(existing, incoming, options = {}) {
  const existingArr = extractNuvioCollections(existing);
  const incomingArr = extractNuvioCollections(incoming);

  // An empty collection can be intentional. Keep it, including unknown fields.
  const cleanedExisting = existingArr.filter(Boolean);

  if (!incomingArr.length) return cleanedExisting;

  // Build the incoming collections with unique IDs and clean titles
  const newCols = incomingArr.map((inCol) => {
    const rawName = (incomingArr.length === 1 && options.collectionName) || inCol.title || inCol.name || "My Lists Collections";
    const colName = rawName.replace(/\s*\((?:movies?|shows?|series|tv)\)\s*$/ig, "").trim() || "My Lists Collections";
    const colId = inCol.id && !cleanedExisting.some((e) => e.id === inCol.id)
      ? inCol.id
      : "col_mylists_" + Math.random().toString(36).slice(2, 8);

    const cleanFolders = (Array.isArray(inCol.folders) ? inCol.folders : [inCol]).map((inF) => {
      const cleanF = {
        ...inF,
        hidden: false,
        isVisible: true,
        enabled: true
      };
      if (Array.isArray(cleanF.catalogSources)) {
        cleanF.catalogSources = cleanF.catalogSources.map((cs) => {
          let cName = String(cs.name || cs.title || cs.catalogId || "").trim();
          cName = cName.replace(/\s*\((?:movies?|shows?|series|tv)\)\s*$/ig, "").trim();
          cName = cName.replace(/\s*\((?:movies?|shows?|series|tv)\)\s*$/ig, "").trim();
          return {
            ...cs,
            name: cName,
            title: cName
          };
        });
      }
      return cleanF;
    });

    return {
      ...inCol,
      id: colId,
      title: colName,
      name: colName,
      viewMode: inCol.viewMode || "FOLLOW_LAYOUT",
      showAllTab: false,
      pinToTop: false,
      focusGlowEnabled: true,
      backdropImageUrl: inCol.backdropImageUrl || options.backdropImageUrl || "",
      hidden: false,
      isVisible: true,
      enabled: true,
      folders: cleanFolders
    };
  });

  return [...cleanedExisting, ...newCols];
}

// Add the incoming folders to ONE existing collection (the one the person picked);
// every other collection is returned untouched, in its original position.
function mergeIntoNuvioCollection(existing, incoming, targetId) {
  const existingArr = extractNuvioCollections(existing);
  const idx = existingArr.findIndex((c) => c && String(c.id) === String(targetId));
  if (idx === -1) return null;
  const target = JSON.parse(JSON.stringify(existingArr[idx]));
  if (!Array.isArray(target.folders)) target.folders = [];
  for (const inCol of extractNuvioCollections(incoming)) {
    if (!inCol) continue;
    for (const inF of Array.isArray(inCol.folders) ? inCol.folders : [inCol]) {
      if (!inF || (!inF.id && !inF.title && !inF.name)) continue;
      const cleanFolder = { ...inF, hidden: false, isVisible: true, enabled: true };
      if (Array.isArray(cleanFolder.catalogSources)) {
        cleanFolder.catalogSources = cleanFolder.catalogSources.map((cs) => {
          const cName = String(cs.name || cs.title || cs.catalogId || "").trim().replace(/\s*\((?:movies?|shows?|series|tv)\)\s*$/ig, "").trim();
          return { ...cs, name: cName, title: cName };
        });
      }
      const fIdx = target.folders.findIndex((f) =>
        (f.id && inF.id && f.id === inF.id) ||
        (f.title && inF.title && f.title.toLowerCase() === inF.title.toLowerCase())
      );
      if (fIdx !== -1) target.folders[fIdx] = { ...target.folders[fIdx], ...cleanFolder };
      else target.folders.push(cleanFolder);
    }
  }
  return existingArr.map((c, i) => (i === idx ? target : c));
}

// Twin of src/client/17_client-my-lists-and-trakt-oauth.js:mergeNuvioCollections; tests/server-client-parity.test.mjs keeps them equal.
function mergeNuvioCollections(existing, incoming) {
  const existingArr = extractNuvioCollections(existing);
  const incomingArr = extractNuvioCollections(incoming);

  if (!existingArr.length) return incomingArr;
  if (!incomingArr.length) return existingArr;

  // Preserve all collections from other providers / community templates 100% untouched
  const otherCollections = [];
  let myListsCol = null;

  for (const c of existingArr) {
    if (!c) continue;
    const cTitle = String(c.title || c.name || "").trim();
    const cFolders = Array.isArray(c.folders) ? c.folders : [];


    const isMyLists = (c.id && (c.id === "my-lists-collections" || c.id === "my-lists-addon")) ||
                      (cTitle && (cTitle.toLowerCase() === "my lists collections" || cTitle.toLowerCase() === "my lists addon" || cTitle.toLowerCase() === "my lists"));
    if (isMyLists) {
      if (!myListsCol) {
        myListsCol = JSON.parse(JSON.stringify(c));
      } else if (cFolders.length > 0) {
        if (!Array.isArray(myListsCol.folders)) myListsCol.folders = [];
        myListsCol.folders.push(...JSON.parse(JSON.stringify(cFolders)));
      }
    } else {
      otherCollections.push(JSON.parse(JSON.stringify(c)));
    }
  }

  if (!myListsCol) {
    myListsCol = {
      id: "my-lists-collections",
      title: "My Lists Collections",
      name: "My Lists Collections",
      viewMode: "FOLLOW_LAYOUT",
      showAllTab: false,
      pinToTop: false,
      focusGlowEnabled: true,
      hidden: false,
      isVisible: true,
      enabled: true,
      folders: []
    };
  } else {
    myListsCol.id = "my-lists-collections";
    myListsCol.title = "My Lists Collections";
    myListsCol.name = "My Lists Collections";
    myListsCol.hidden = false;
    myListsCol.isVisible = true;
    myListsCol.enabled = true;
    if (!Array.isArray(myListsCol.folders)) myListsCol.folders = [];
  }

  // Merge incoming folders ONLY into myListsCol. If an incoming collection matches otherCollections, update that collection.
  for (const inCol of incomingArr) {
    if (!inCol) continue;
    const inTitle = String(inCol.title || inCol.name || "").trim();
    const isIncomingMyLists = (inCol.id && (inCol.id === "my-lists-collections" || inCol.id === "my-lists-addon")) ||
                             (inTitle && (inTitle.toLowerCase() === "my lists collections" || inTitle.toLowerCase() === "my lists addon" || inTitle.toLowerCase() === "my lists"));

    if (inCol.id && !isIncomingMyLists) {
      const existingOtherIdx = otherCollections.findIndex((oc) => oc.id === inCol.id);
      if (existingOtherIdx !== -1) {
        otherCollections[existingOtherIdx] = JSON.parse(JSON.stringify(inCol));
        continue;
      }
    }

    // Folders intended for My Lists Collections
    const foldersToMerge = Array.isArray(inCol.folders) ? inCol.folders : [inCol];
    for (const inF of foldersToMerge) {
      if (!inF || (!inF.id && !inF.title && !inF.name)) continue;
      const cleanFolder = {
        ...inF,
        hidden: false,
        isVisible: true,
        enabled: true
      };
      if (Array.isArray(cleanFolder.catalogSources)) {
        cleanFolder.catalogSources = cleanFolder.catalogSources.map((cs) => {
          let cName = String(cs.name || cs.title || cs.catalogId || "").trim();
          cName = cName.replace(/\s*\((?:movies?|shows?|series|tv)\)\s*$/ig, "").trim();
          cName = cName.replace(/\s*\((?:movies?|shows?|series|tv)\)\s*$/ig, "").trim();
          return {
            ...cs,
            name: cName,
            title: cName
          };
        });
      }
      const fIdx = myListsCol.folders.findIndex((f) =>
        (f.id && inF.id && f.id === inF.id) ||
        (f.title && inF.title && f.title.toLowerCase() === inF.title.toLowerCase()) ||
        (f.name && inF.name && f.name.toLowerCase() === inF.name.toLowerCase())
      );
      if (fIdx !== -1) {
        myListsCol.folders[fIdx] = { ...myListsCol.folders[fIdx], ...cleanFolder };
      } else {
        myListsCol.folders.push(JSON.parse(JSON.stringify(cleanFolder)));
      }
    }
  }

  return [...otherCollections, myListsCol];
}

// JSONB can reorder object keys after a write. Treat key order as irrelevant,
// but preserve all values, object membership, and array/folder/source order.
function nuvioSnapshotEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => nuvioSnapshotEqual(value, b[i]));
  }
  const keys = Object.keys(a).sort(), other = Object.keys(b).sort();
  return keys.length === other.length && keys.every((key, i) => key === other[i] && nuvioSnapshotEqual(a[key], b[key]));
}

// Nuvio's documented read: sync_pull_collections returns [{ profile_id, collections_json, updated_at }].
// sync_pull_profiles has no collections in it (its rows are the profiles themselves), so it is not used
// here: a profile row read as a collection made the profile look empty. Errors are thrown, never turned
// into "no collections": sync_push_collections replaces the whole blob, so a failed read must stop a push.
async function nuvioPullCollections(env, accessToken, profileId) {
  const rows = await nuvioRpc(env, accessToken, "sync_pull_collections", { p_profile_id: profileId });
  const list = Array.isArray(rows) ? rows : (rows ? [rows] : []);
  const row = list.find((r) => r && r.profile_id != null && Number(r.profile_id) === Number(profileId)) || (list.length === 1 ? list[0] : null);
  if (!row) return [];
  let blob = row.collections_json;
  if (typeof blob === "string") {
    try { blob = JSON.parse(blob); } catch { throw new Error("Nuvio returned collections that could not be read."); }
  }
  if (!Array.isArray(blob) || blob.some((c) => !c || typeof c !== "object" || Array.isArray(c))) {
    throw new Error("Nuvio returned collections in an unexpected format.");
  }
  return blob;
}

// Nuvio TV, Smart, Desktop and mobile share this namespace and SyncHomeCatalogPayload.items
// format (not the illustrative rows/hidden_catalogs blob in the API docs):
// NuvioMedia/NuvioTV core/sync/HomeCatalogSettingsSyncService.kt and
// NuvioMedia/NuvioTVSmart js/core/profile/homeCatalogSettingsSyncService.js;
// Desktop 0.1.33-alpha features/home/HomeCatalogSettingsRepository.kt also uses
// an explicit key, taking precedence over addon_id/type/catalog_id.
// This RPC replaces the whole settings blob: never write after a failed read.
async function nuvioPullHomeSettings(env, accessToken, profileId) {
  const rows = await nuvioRpc(env, accessToken, "sync_pull_home_catalog_settings", {
    p_profile_id: profileId, p_platform: "home_catalog_shared"
  });
  if (!Array.isArray(rows) || rows.length > 1) throw new Error("Unexpected home settings response.");
  let settings = rows.length ? rows[0] && rows[0].settings_json : {};
  if (typeof settings === "string") settings = JSON.parse(settings);
  if (!settings || typeof settings !== "object" || Array.isArray(settings) ||
      (settings.items != null && (!Array.isArray(settings.items) || settings.items.some((i) => !i || typeof i !== "object" || Array.isArray(i))))) {
    throw new Error("Nuvio home settings could not be read.");
  }
  return settings;
}

// Mirrors Desktop/mobile SyncCatalogItem.preferenceKey(): a nonblank key
// overrides the tuple, while a blank/whitespace key falls back to the tuple.
function nuvioHomeCatalogKey(item) {
  return typeof item.key === "string" && item.key.trim() ? item.key : `${item.addon_id}:${item.type}:${item.catalog_id}`;
}

async function nuvioCollectionHomeSettings(env, accessToken, profileId, collections, hidden) {
  const settings = await nuvioPullHomeSettings(env, accessToken, profileId);
  const items = (settings.items || []).map((i) => ({ ...i }));
  let nextOrder = items.reduce((max, i) => Number.isFinite(i.order) ? Math.max(max, i.order + 1) : max, items.length);
  for (const collection of extractNuvioCollections(collections)) {
    for (const folder of Array.isArray(collection.folders) ? collection.folders : [collection]) {
      for (const source of folder.catalogSources || []) {
        if (!source || source.addonId !== COLLECTIONS_ADDON_ID || !source.type || !source.catalogId) continue;
        // Desktop/mobile prefer an explicit key over the separate identity
        // fields. Match key-only entries too, or a later enabled duplicate can
        // override the disabled row when the app associates items by key.
        const key = `${source.addonId}:${source.type}:${source.catalogId}`;
        const matches = items.filter((i) => !i.is_collection && nuvioHomeCatalogKey(i) === key);
        if (matches.length) {
          for (const item of matches) Object.assign(item, {
            key, addon_id: source.addonId, type: source.type, catalog_id: source.catalogId, enabled: !hidden
          });
        } else {
          items.push({ key, addon_id: source.addonId, type: source.type, catalog_id: source.catalogId,
            enabled: !hidden, order: nextOrder++, custom_title: "", is_collection: false, collection_id: "" });
        }
      }
    }
  }
  return { ...settings, items };
}

// Save home rows prepared by nuvioCollectionHomeSettings and read them back.
// The RPC returns no payload, so confirm the stored values rather than treating
// an accepted write (or a concurrent overwrite) as success. Collections may
// already be saved, so a failure is reported as false, never thrown.
async function nuvioSaveHomeVisibility(env, accessToken, profileId, homeSettings, hidden) {
  try {
    await nuvioRpc(env, accessToken, "sync_push_home_catalog_settings", {
      p_profile_id: profileId, p_platform: "home_catalog_shared",
      p_settings_json: homeSettings, p_origin_client_id: "my-lists-addon"
    });
    const savedHome = await nuvioPullHomeSettings(env, accessToken, profileId);
    const savedItems = Array.isArray(savedHome.items) ? savedHome.items : [];
    const targets = homeSettings.items.filter((i) => i.key && !i.is_collection && i.enabled === !hidden);
    return targets.every((target) => {
      const matches = savedItems.filter((i) => !i.is_collection && nuvioHomeCatalogKey(i) === target.key);
      return matches.length > 0 && matches.every((i) => i.enabled === target.enabled);
    });
  } catch (homeErr) {
    console.warn("Could not save Nuvio home catalog visibility:", homeErr);
    return false;
  }
}

// Addon writes replace the complete profile list. A failed/malformed read
// must never be mistaken for an empty profile (or another profile's addons).
async function nuvioGetAddons(env, accessToken, profileId) {
  const res = await mediaAppFetch(`${nuvioBase(env)}/rest/v1/addons?profile_id=eq.${profileId}&select=*`, {
    headers: { "apikey": nuvioKey(env), "Authorization": `Bearer ${accessToken}` },
  });
  if (res.status === 401 || res.status === 403) throw mediaAppError("invalid", "Sign in to Nuvio again first.");
  if (!res.ok) throw mediaAppError("unreachable", "Could not read your Nuvio addons. Nothing was changed.");
  let addons;
  try { addons = await res.json(); } catch { throw mediaAppError("unreachable", "Nuvio returned an unreadable addon list. Nothing was changed."); }
  if (!Array.isArray(addons) || addons.some((a) => !a || typeof a.url !== "string" || !a.url || (a.profile_id != null && Number(a.profile_id) !== profileId))) {
    throw mediaAppError("unreachable", "Nuvio returned an unreadable addon list. Nothing was changed.");
  }
  return addons;
}

// Only our source references change. External addons and collection/folder
// visibility remain exactly as supplied. Also migrates existing shared-ID refs.
function nuvioSeparateCollectionSources(collections) {
  return extractNuvioCollections(collections).map((c) => ({ ...c,
    folders: (Array.isArray(c.folders) ? c.folders : [c]).map((f) => !Array.isArray(f.catalogSources) ? f : ({ ...f,
      catalogSources: f.catalogSources.map((source) => source && source.addonId === ADDON_ID
        ? { ...source, addonId: COLLECTIONS_ADDON_ID } : source)
    }))
  }));
}

// One durable, account-owned v2 install per Nuvio profile. Reuse its bearer URL
// from Nuvio's addon list; only the hash is stored locally, as for other v2
// installs. No home-link config/token or expiring global col_cat mapping is
// required to keep collections working after a home addon edit/reinstall.
async function nuvioEnsureAddonInstalled(env, accessToken, profileId, origin, account, collections, lists, homeManifestUrl) {
  const sources = collections.flatMap((c) => c.folders || []).flatMap((f) => f.catalogSources || [])
    .filter((s) => s && s.addonId === COLLECTIONS_ADDON_ID);
  const addons = await nuvioGetAddons(env, accessToken, profileId);
  let index = -1, install = null, config = {}, manifestUrl = "";
  for (let i = 0; i < addons.length; i++) {
    let u;
    try { u = new URL(addons[i].url); } catch { continue; }
    const match = u.origin === origin && /^\/i\/([A-Za-z0-9_-]{43})(?:\/manifest\.json)?\/?$/.exec(u.pathname);
    if (!match) continue;
    const row = await env.DB.prepare("SELECT id, token_hash, config_json, version FROM installs WHERE token_hash = ? AND account_id = ? AND revoked_at IS NULL")
      .bind(await installTokenHash(match[1]), account.id).first();
    if (!row) continue;
    const cfg = JSON.parse(row.config_json);
    if (cfg.nuvioCollectionsProfile !== profileId) continue;
    index = i; install = row; config = cfg; manifestUrl = `${origin}/i/${match[1]}/manifest.json`;
    break;
  }
  if (!sources.length && !install) return null;
  // Copy non-secret appearance/preferences once, never depend on that link
  // afterwards. Future changes to the home install cannot change this config.
  if (!install && homeManifestUrl) {
    try {
      const u = new URL(homeManifestUrl);
      const match = u.origin === origin && /^\/(i\/[A-Za-z0-9_-]{43}|[^/]+)\/manifest\.json$/.exec(u.pathname);
      if (match) {
        const param = match[1].startsWith("i/") ? INSTALL_TOKEN_PARAM_PREFIX + match[1].slice(2) : match[1];
        config = nonSecretInstallConfigFields(await resolveConfig(param, env));
      }
    } catch {}
  }
  const supplied = Array.isArray(lists) ? lists : [];
  const previous = Array.isArray(config.entries) ? config.entries : [];
  const entries = new Map();
  for (const source of sources) {
    const key = `${source.type}:${source.catalogId}`;
    if (entries.has(key)) continue;
    const ownList = supplied.find((l) => l && (!l.addonId || l.addonId === ADDON_ID || l.addonId === COLLECTIONS_ADDON_ID) &&
      typeof l.url === "string" && l.url && !l.url.startsWith("catalog:") &&
      (l.catalogId || slugifyServer(l.url || l.name || "")) === source.catalogId && (l.type || "movie") === source.type);
    const prior = previous.find((e) => e.id === source.catalogId && e.type === source.type);
    const premade = findChartOrCollectionEntry(source.catalogId, source.type);
    const sourceUrl = [(ownList && ownList.url), source.url, (prior && prior.url), (premade && premade.url)]
      .find((value) => typeof value === "string" && value && !value.startsWith("catalog:"));
    if (!sourceUrl) throw mediaAppError("unreachable", "Could not resolve a collection catalog. Sync all local collections once to migrate custom catalogs.");
    entries.set(key, { id: source.catalogId, type: source.type, name: source.name || source.title || source.catalogId, url: sourceUrl, enabled: true });
  }
  const entryList = [...entries.values()];
  const problem = saveEntriesProblem(entryList);
  if (problem) throw mediaAppError("unreachable", problem);
  const built = entryList.length ? buildV2InstallConfig({ ...config, entries: entryList, track: false }, account)
    : { config: { ...nonSecretInstallConfigFields(config), entries: [] } };
  if (built.error) throw mediaAppError("unreachable", built.error);
  built.config.nuvioCollectionsProfile = profileId;
  const configJson = JSON.stringify(built.config);
  const now = Date.now();
  if (install) {
    const result = await env.DB.prepare("UPDATE installs SET config_json = ?, version = version + 1, updated_at = ? WHERE id = ? AND account_id = ? AND version = ? AND revoked_at IS NULL")
      .bind(configJson, now, install.id, account.id, install.version).run();
    if (!result.meta.changes) throw mediaAppError("unreachable", "The collection install changed. Try syncing again.");
    await forgetInstallSnapshot(env, install.token_hash);
  } else {
    const active = await env.DB.prepare("SELECT COUNT(*) AS n FROM installs WHERE account_id = ? AND legacy_cfg_id IS NULL AND revoked_at IS NULL").bind(account.id).first();
    if (active && active.n >= INSTALLS_PER_ACCOUNT_MAX) throw mediaAppError("unreachable", "Remove an unused install link before adding the collections addon.");
    const token = generateInstallToken();
    await env.DB.prepare("INSERT INTO installs (token_hash, legacy_cfg_id, account_id, name, config_json, version, scopes, created_at, updated_at, last_used_at) VALUES (?, NULL, ?, ?, ?, 1, 'read', ?, ?, NULL)")
      .bind(await installTokenHash(token), account.id, COLLECTIONS_ADDON_NAME, configJson, now, now).run();
    manifestUrl = `${origin}/i/${token}/manifest.json`;
  }
  const updatedAddons = addons.map((a, i) => ({ url: a.url, name: a.name || `Addon ${i + 1}`, enabled: a.enabled !== false, sort_order: a.sort_order != null ? a.sort_order : i }));
  const entry = { url: manifestUrl, name: COLLECTIONS_ADDON_NAME, enabled: true,
    sort_order: index >= 0 ? updatedAddons[index].sort_order : updatedAddons.reduce((max, a) => Math.max(max, a.sort_order + 1), 0) };
  if (index >= 0) updatedAddons[index] = entry;
  else updatedAddons.push(entry);
  await nuvioRpc(env, accessToken, "sync_push_addons", {
    p_profile_id: profileId, p_addons: updatedAddons, p_origin_client_id: "my-lists-addon"
  });
  return manifestUrl;
}

// POST /api/connections/stremio/link/complete, POST .../nuvio/login,
// GET|POST /api/connections/:provider/settings, POST /api/connections/:provider/sync.
// The caller has already required a session.
async function handleMediaAppRoute(request, env, account, provider, sub) {
  const accountId = account.id;
  // `why` is for whoever runs the site: it names what is missing.
  const unavailable = (why) => json({ ok: false, error: "Connecting this account isn't available right now.", detail: why }, 503);
  if (!hasTokenEncryptionKey(env)) return unavailable("TOKEN_ENCRYPTION_KEY is not set");

  if (sub === "settings" && request.method === "GET") {
    const conn = await loadProviderConnection(env, accountId, provider);
    const row = await loadMediaAppSync(env, accountId, provider);
    return json({ ok: true, provider, connected: Boolean(conn && conn.accessToken), status: conn ? conn.status : null, username: conn ? conn.username : null, pushAvailable: mediaAppPushFlag(env), profiles: provider === "nuvio" ? mediaAppProfilesOf(row) : undefined, sync: mediaAppSyncSummary(row) });
  }

  if (sub === "collections" && request.method === "GET") {
    if (provider !== "nuvio") return json({ ok: false, error: "Collections sync is only supported for Nuvio." }, 400);
    let conn = await loadProviderConnection(env, accountId, provider);
    const row = await loadMediaAppSync(env, accountId, provider);
    if (!conn || conn.status !== "ok" || !row) return json({ ok: false, error: "Your Nuvio account isn't connected." }, 404);
    conn = await refreshProviderConnectionIfDue(env, accountId, provider, conn);
    if (!conn || !conn.accessToken) return json({ ok: false, error: "Sign in to Nuvio again first." }, 400);
    const profileId = Number(row.profile_index) || 1;
    let data;
    try {
      data = await nuvioPullCollections(env, conn.accessToken, profileId);
    } catch {
      return json({ ok: false, error: "Couldn't read your collections from Nuvio. Please try again." }, 502);
    }
    // Bind browser-side links to both accounts, not just profile/folder IDs.
    const scope = conn.id ? await installTokenHash("nuvio-collections:" + JSON.stringify([accountId, conn.id])) : null;
    return json({ ok: true, profileId, profiles: mediaAppProfilesOf(row), collections: data || [], scope });
  }

  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);
  // Each of these calls the service on the person's behalf.
  if (await consumeRateLimit(env, null, "mediaappconnect", "a" + accountId, 20)) {
    return json({ ok: false, error: "Too many attempts. Please wait a minute and try again." }, 429);
  }
  let body = {};
  try {
    body = await request.json();
  } catch {}
  if (!body || typeof body !== "object") body = {};

  try {
    if (provider === "stremio" && sub === "link/complete") {
      const authKey = typeof body.authKey === "string" ? body.authKey.trim() : "";
      if (!/^[\x21-\x7e]{8,200}$/.test(authKey)) return json({ ok: false, error: "Stremio did not give a sign-in. Please start again." }, 400);
      const user = await stremioUser(authKey);
      if (!(await ensureMediaAppSync(env, accountId, provider, null))) return unavailable("migration 0023 has not been applied");
      const stored = await storeProviderConnection(env, account, provider, { accessToken: authKey, externalUser: { username: user.name, id: user.id } });
      if (!stored) return unavailable("the connection could not be stored");
      await refreshAfterConnect(env, accountId, provider);
      return json({ ok: true, status: "connected", username: user.name });
    }
    if (provider === "nuvio" && sub === "login") {
      const email = String(body.email || "").trim();
      const password = String(body.password || "");
      if (!email || !password || email.length > 254 || password.length > 256) return json({ ok: false, error: "Enter your Nuvio email and password." }, 400);
      const session = await nuvioToken(env, "password", { email, password });
      const profiles = await nuvioProfiles(env, session.accessToken);
      const only = profiles.length === 1 ? profiles[0].index : (profiles.length === 0 ? 1 : null);
      if (!(await ensureMediaAppSync(env, accountId, provider, only))) return unavailable("migration 0023 has not been applied");
      const stored = await storeProviderConnection(env, account, provider, {
        accessToken: session.accessToken, refreshToken: session.refreshToken, expiresAt: session.expiresAt,
        externalUser: { username: session.email || email, id: session.userId },
      });
      if (!stored) return unavailable("the connection could not be stored");
      await saveNuvioProfiles(env, accountId, profiles);
      const row = await loadMediaAppSync(env, accountId, provider);
      if (row && row.profile_index) await refreshAfterConnect(env, accountId, provider);
      return json({ ok: true, status: "connected", username: session.email || email, profiles, profileIndex: row ? row.profile_index : only });
    }
    if (sub === "settings") return mediaAppSaveSettings(env, accountId, provider, body);
    if (sub === "restore-removed") return mediaAppRestoreRoute(env, accountId, provider);
    if (sub === "library-item") {
      if (!mediaAppPushFlag(env)) return json({ ok: false, error: "App writes aren't switched on yet." }, 409);
      const id = mediaAppTitleId(body.id);
      const kind = mediaAppKind(body.mediaType);
      const action = body.action;
      if (!id || !kind || !["add", "remove"].includes(action)) return json({ ok: false, error: "Choose a movie or show." }, 400);
      let conn = await loadProviderConnection(env, accountId, provider);
      const sync = await loadMediaAppSync(env, accountId, provider);
      if (!conn || conn.status !== "ok" || !sync) return json({ ok: false, error: "That account isn't connected." }, 404);
      const contentId = id.imdbId || `tmdb:${id.tmdbId}`;
      if (provider === "nuvio") {
        if (!sync.profile_index) return json({ ok: false, error: "Choose a Nuvio profile first." }, 400);
        conn = await refreshProviderConnectionIfDue(env, accountId, provider, conn);
        if (!conn || !conn.accessToken) return json({ ok: false, error: "Sign in to Nuvio again first." }, 400);
        const existing = await nuvioFetchLibrary(env, conn.accessToken, sync.profile_index);
        const found = existing.find((r) => String(r.content_id).toLowerCase() === contentId && mediaAppKind(r.content_type) === kind);
        if (action === "add" && !found) {
          await nuvioRpc(env, conn.accessToken, "sync_push_library_items", { p_profile_id: sync.profile_index, p_origin_client_id: "my-lists-addon", p_items: [{ content_id: contentId, content_type: kind, name: String(body.title || "").slice(0, 200), added_at: Date.now() }] });
        } else if (action === "remove" && found) {
          await nuvioRpc(env, conn.accessToken, "sync_delete_library_items", { p_profile_id: sync.profile_index, p_origin_client_id: "my-lists-addon", p_keys: [{ content_id: found.content_id, content_type: found.content_type }] });
        }
      } else {
        if (!id.imdbId) return json({ ok: false, error: "Stremio needs an IMDb ID for this title." }, 400);
        const all = await stremioCall("datastoreGet", { authKey: conn.accessToken, collection: "libraryItem", ids: [], all: true });
        if (!Array.isArray(all)) throw mediaAppError("unreachable", "Stremio sent an invalid library.");
        const existing = all.find((r) => r && String(r._id) === id.imdbId);
        if (existing && mediaAppKind(existing.type) !== kind) return json({ ok: false, error: "This title has a different type in Stremio." }, 409);
        if (action === "remove" && !existing) return json({ ok: true });
        const now = new Date().toISOString();
        const item = existing || { _id: id.imdbId, type: kind, name: String(body.title || "").slice(0, 200), poster: null, posterShape: "poster", _ctime: now, behaviorHints: {}, state: { lastWatched: null, timeWatched: 0, timeOffset: 0, overallTimeWatched: 0, timesWatched: 0, flaggedWatched: 0, duration: 0, video_id: null, watched: null, noNotif: false } };
        const result = await stremioCall("datastorePut", { authKey: conn.accessToken, collection: "libraryItem", changes: [{ ...item, removed: action === "remove", temp: false, _mtime: now }] });
        if (!result || result.success !== true) throw mediaAppError("unreachable", "Stremio did not accept the update.");
      }
      return json({ ok: true });
    }
    if (sub === "add-history") {
      if (!mediaAppPushFlag(env)) return json({ ok: false, error: "App writes aren't switched on yet." }, 409);
      const id = mediaAppTitleId(body.id);
      const kind = mediaAppKind(body.mediaType);
      const season = body.season == null ? null : mediaAppInt(body.season);
      const episode = body.episode == null ? null : mediaAppInt(body.episode);
      if (!id || !kind || (kind === "series" && (season == null || episode == null || episode < 1))) {
        return json({ ok: false, error: "Choose a movie or a show episode." }, 400);
      }
      let conn = await loadProviderConnection(env, accountId, provider);
      const sync = await loadMediaAppSync(env, accountId, provider);
      if (!conn || conn.status !== "ok" || !sync) return json({ ok: false, error: "That account isn't connected." }, 404);
      const now = Date.now();
      const contentId = id.imdbId || `tmdb:${id.tmdbId}`;
      const play = { contentId, kind, title: String(body.title || "").slice(0, 200), season: kind === "series" ? season : null, episode: kind === "series" ? episode : null, watchedAt: now };
      if (provider === "nuvio") {
        conn = await refreshProviderConnectionIfDue(env, accountId, provider, conn);
        if (!conn || !conn.accessToken || !sync.profile_index) return json({ ok: false, error: "Sign in and choose a Nuvio profile first." }, 400);
        await nuvioRpc(env, conn.accessToken, "sync_push_watched_items", { p_profile_id: sync.profile_index, p_items: [nuvioWatchedItem(play)] });
      } else {
        if (!id.imdbId) return json({ ok: false, error: "Stremio needs an IMDb ID for this title." }, 400);
        const library = await stremioFetchLibrary(conn.accessToken);
        const item = library.find((it) => String(it._id) === id.imdbId && mediaAppKind(it.type) === kind);
        if (!item) return json({ ok: false, error: "Add this title to your Stremio library first." }, 400);
        let state = { ...(item.state || {}) };
        if (kind === "series") {
          const eps = await stremioEpisodes(id.imdbId);
          if (!eps || !eps.some((e) => e.season === season && e.episode === episode)) return json({ ok: false, error: "Stremio could not find that episode." }, 400);
          const watched = new Set((state.watched ? await stremioWatchedEpisodes(state.watched, eps) : []).map((e) => `${e.season}:${e.episode}`));
          watched.add(`${season}:${episode}`);
          state.watched = await stremioEncodeWatched(eps, watched);
          state.video_id = `${id.imdbId}:${season}:${episode}`;
        } else {
          state.timesWatched = Math.max(1, Number(state.timesWatched) || 0);
          state.flaggedWatched = 1;
        }
        state.lastWatched = new Date(now).toISOString();
        const result = await stremioCall("datastorePut", { authKey: conn.accessToken, collection: "libraryItem", changes: [{ ...item, _mtime: new Date(now).toISOString(), state }] });
        if (!result || result.success !== true) throw mediaAppError("unreachable", "Stremio did not accept the update.");
      }
      const rec = { ...id, kind, title: play.title, mtime: now, at: now, plays: [{ season: play.season, episode: play.episode, watchedAt: now }], furthest: kind === "series" ? { season, episode } : null, resume: null };
      let local = null;
      try { local = await applyMediaAppRecords(env, accountId, provider, [rec]); }
      catch (e) { console.error("mediaapp: could not mirror added history", e); }
      return json({ ok: true, mirrored: !!local && !local.skipped && !local.unresolved && local.plays > 0 });
    }
    if (sub === "remove") {
      const name = provider === "nuvio" ? "Nuvio" : "Stremio";
      if (!mediaAppPushFlag(env)) return json({ ok: false, error: `Removing from ${name} isn't switched on yet.` }, 409);
      const removeDb = activityDb(env, accountId);
      if (removeDb && !(await removeDb.prepare("SELECT version FROM schema_migrations WHERE version = 'A0002'").first())) {
        return json({ ok: false, error: "The activity database needs migration A0002 before app history can be changed." }, 503);
      }
      const target = String(body.target || "");
      const id = mediaAppTitleId(body.id);
      if (!MEDIA_APP_REMOVE_TARGETS.includes(target) || !id) return json({ ok: false, error: "Choose an item to remove." }, 400);
      const requestedKind = mediaAppKind(body.mediaType);
      let media;
      if (id.imdbId) {
        media = await env.DB.prepare("SELECT id, kind, imdb_id, tmdb_id FROM media WHERE imdb_id = ?").bind(id.imdbId).first();
        if (media && requestedKind && media.kind !== requestedKind) return json({ ok: false, error: "Choose the matching movie or show." }, 400);
      } else if (requestedKind) {
        media = await env.DB.prepare("SELECT id, kind, imdb_id, tmdb_id FROM media WHERE tmdb_id = ? AND kind = ?").bind(id.tmdbId, requestedKind).first();
      } else {
        const found = await env.DB.prepare("SELECT id, kind, imdb_id, tmdb_id FROM media WHERE tmdb_id = ? LIMIT 2").bind(id.tmdbId).all();
        if ((found.results || []).length > 1) return json({ ok: false, error: "Choose whether this title is a movie or show." }, 400);
        media = (found.results || [])[0] || null;
      }
      const imdbId = id.imdbId || (media && media.imdb_id) || null;
      const titleIds = [...new Set([id.imdbId, id.tmdbId ? `tmdb:${id.tmdbId}` : null, imdbId, media && media.tmdb_id ? `tmdb:${media.tmdb_id}` : null].filter(Boolean))];
      if (provider === "stremio" && !imdbId) return json({ ok: false, error: "This title needs an IMDb ID to remove it from Stremio." }, 400);
      let conn = await loadProviderConnection(env, accountId, provider);
      const row = await loadMediaAppSync(env, accountId, provider);
      if (!conn || conn.status !== "ok" || !row) return json({ ok: false, error: "That account isn't connected." }, 404);
      if (provider === "nuvio") {
        conn = await refreshProviderConnectionIfDue(env, accountId, provider, conn);
        if (!conn || !conn.accessToken) return json({ ok: false, error: "Sign in to Nuvio again first." }, 400);
        if (!row.profile_index) return json({ ok: false, error: "Choose a Nuvio profile first." }, 400);
      }
      // In the app first: if it refuses, nothing here changes either.
      const inApp = provider === "stremio"
        ? await stremioRemoveTitle(conn, imdbId, target)
        : await nuvioRemoveTitle(env, conn, row.profile_index, titleIds, target, requestedKind || (media && media.kind));
      const here = await removeMediaAppItemLocally(env, accountId, provider, media, imdbId, target);
      if (!inApp && !here.removed && !here.found) return json({ ok: false, error: `That title isn't in your ${name} account.` }, 404);
      return json({ ok: true, removedInApp: inApp, removedPlays: here.removed });
    }
    if (sub === "sync") {
      const row = await loadMediaAppSync(env, accountId, provider);
      if (!row) return json({ ok: false, error: "That account isn't connected." }, 404);
      if (body.wait === true) {
        // Done now, in this request: what Lists shows next is what the app holds.
        const r = await refreshMediaAppNow(env, accountId, provider, { force: body.force === true });
        return json({ ok: true, done: Boolean(r.done), skipped: r.skipped || null, sync: mediaAppSyncSummary(await loadMediaAppSync(env, accountId, provider)) });
      }
      const made = await startMediaAppSync(env, accountId, provider);
      return json({ ok: Boolean(made && made.ok), started: Boolean(made && made.created) }, made && made.ok ? 202 : 503);
    }
    if (provider === "nuvio" && sub === "collections") {
      let conn = await loadProviderConnection(env, accountId, provider);
      const row = await loadMediaAppSync(env, accountId, provider);
      if (!conn || conn.status !== "ok" || !row) return json({ ok: false, error: "Your Nuvio account isn't connected." }, 404);
      conn = await refreshProviderConnectionIfDue(env, accountId, provider, conn);
      if (!conn || !conn.accessToken) return json({ ok: false, error: "Sign in to Nuvio again first." }, 400);
      const profileId = (body && body.profileId != null) ? Number(body.profileId) : (Number(row.profile_index) || 1);
      if (!Number.isInteger(profileId) || profileId < 1 || profileId > 6) return json({ ok: false, error: "Choose a valid Nuvio profile." }, 400);
      const installMode = String(body.installMode || (body.merge === false ? "replace" : "new")).toLowerCase();
      if (body.hideHomeCatalogs != null && typeof body.hideHomeCatalogs !== "boolean") {
        return json({ ok: false, error: "Home catalog visibility must be a boolean." }, 400);
      }
      // Scoped collection management never replaces or normalizes unrelated
      // collections or addons. Home rows change only for this collection, and
      // only when the request carries the person's saved hide/show choice.
      // Nuvio only has a whole-blob write, so verify the exact target snapshot
      // against a fresh pull first.
      if (installMode === "update-collection" || installMode === "delete-collection") {
        const scope = conn.id ? await installTokenHash("nuvio-collections:" + JSON.stringify([accountId, conn.id])) : null;
        if (!scope || body.scope !== scope) return json({ ok: false, error: "This collection belongs to a different connection. Pull it again before making changes." }, 409);
        if (profileId !== (Number(row.profile_index) || 1)) return json({ ok: false, error: "The selected Nuvio profile changed. Pull again before making changes." }, 409);
        const expected = body.expectedCollection;
        if (typeof body.targetCollectionId !== "string" || !body.targetCollectionId || !expected || typeof expected !== "object" || Array.isArray(expected)) {
          return json({ ok: false, error: "Provide the collection and its original snapshot." }, 400);
        }
        let existing;
        try { existing = await nuvioPullCollections(env, conn.accessToken, profileId); }
        catch { return json({ ok: false, error: "Couldn't read your existing Nuvio collections, so nothing was changed." }, 502); }
        const matches = existing.filter((c) => c.id === body.targetCollectionId);
        if (matches.length !== 1 || !nuvioSnapshotEqual(matches[0], expected)) {
          return json({ ok: false, error: "This Nuvio collection changed or was removed. Your local copy is kept. Remove the local copy and pull again to discard its edits." }, 409);
        }
        const target = matches[0];
        let updated = null;
        let collectionsManifestUrl = null;
        if (installMode === "update-collection") {
          const incoming = body.updatedCollection;
          const folders = incoming && incoming.folders;
          if (!incoming || typeof incoming !== "object" || Array.isArray(incoming) || incoming.id !== target.id || !Array.isArray(folders) ||
              ["title", "name"].some((key) => incoming[key] != null && typeof incoming[key] !== "string") ||
              folders.some((f) => !f || typeof f !== "object" || Array.isArray(f) || typeof f.id !== "string" || !f.id || !Array.isArray(f.catalogSources) ||
                f.catalogSources.some((source) => !source || typeof source !== "object" || typeof source.addonId !== "string" || !source.addonId || typeof source.catalogId !== "string" || !source.catalogId || typeof source.type !== "string" || !source.type)) ||
              new Set(folders.map((f) => f.id)).size !== folders.length) {
            return json({ ok: false, error: "Invalid collection update. Each folder needs a unique ID and valid catalog sources." }, 400);
          }
          const mergedFolders = folders.map((folder) => {
            const original = (target.folders || []).find((f) => f && f.id === folder.id);
            return { ...original, ...folder, catalogSources: folder.catalogSources.map((source) => {
              const prior = ((original && original.catalogSources) || []).find((s) => s &&
                (s.addonId === ADDON_ID ? COLLECTIONS_ADDON_ID : s.addonId) === (source.addonId === ADDON_ID ? COLLECTIONS_ADDON_ID : source.addonId) &&
                s.catalogId === source.catalogId && s.type === source.type);
              return { ...prior, ...source };
            }) };
          });
          updated = nuvioSeparateCollectionSources([{ ...target, ...incoming, id: target.id, folders: mergedFolders }])[0];
        }
        let homeSettings = null;
        if (updated && typeof body.hideHomeCatalogs === "boolean") {
          try { homeSettings = await nuvioCollectionHomeSettings(env, conn.accessToken, profileId, [updated], body.hideHomeCatalogs); }
          catch (homeErr) {
            if (homeErr && homeErr.kind === "invalid") throw homeErr;
            return json({ ok: false, error: "Couldn't read your Nuvio home settings, so nothing was changed. Please try again." }, 502);
          }
        }
        const collections = installMode === "delete-collection" ? existing.filter((c) => c !== target) : existing.map((c) => c === target ? updated : c);
        const ownsSources = [target, updated].filter(Boolean).some((c) => (c.folders || []).some((f) => (f.catalogSources || []).some((source) => source && (source.addonId === ADDON_ID || source.addonId === COLLECTIONS_ADDON_ID))));
        if (updated && ownsSources) {
          collectionsManifestUrl = await nuvioEnsureAddonInstalled(env, conn.accessToken, profileId, new URL(request.url).origin, account, collections, body.collectionLists, body.manifestUrl);
        }
        await nuvioRpc(env, conn.accessToken, "sync_push_collections", { p_profile_id: profileId, p_collections_json: collections, p_origin_client_id: "my-lists-addon" });
        const homeVisibilityUpdated = homeSettings ? await nuvioSaveHomeVisibility(env, conn.accessToken, profileId, homeSettings, body.hideHomeCatalogs) : null;
        return json({ ok: true, profileId, scope, collections, deletedCollectionId: updated ? null : target.id, writtenCollectionIds: updated ? [target.id] : [], collectionsManifestUrl, homeVisibilityUpdated });
      }
      let collections = body.collections != null ? body.collections : (body.p_collections_json != null ? body.p_collections_json : null);
      if (!collections) return json({ ok: false, error: "Provide collections to push." }, 400);
      const incomingCollections = nuvioSeparateCollectionSources(collections);

      let existing = [];
      if (installMode !== "replace") {
        // The push replaces everything Nuvio holds, so it only goes ahead on a successful read.
        try {
          existing = await nuvioPullCollections(env, conn.accessToken, profileId);
        } catch (pullErr) {
          if (pullErr && pullErr.kind === "invalid") throw pullErr;
          return json({ ok: false, error: "Couldn't read your existing Nuvio collections, so nothing was changed. Please try again." }, 502);
        }
      }

      const existingCount = (existing || []).length;
      const backdropImageUrl = `${new URL(request.url).origin}/icon.png`;
      if (installMode === "update-folder") {
        const scope = conn.id ? await installTokenHash("nuvio-collections:" + JSON.stringify([accountId, conn.id])) : null;
        if (!scope || body.scope !== scope) return json({ ok: false, error: "This folder belongs to a different connection. Pull it again before editing." }, 409);
        if (profileId !== (Number(row.profile_index) || 1)) return json({ ok: false, error: "The selected Nuvio profile changed. Pull again before editing." }, 409);
        if (!isMyListsNuvioCollectionId(body.targetCollectionId)) return json({ ok: false, error: "Only collections created by My Lists can be updated here." }, 403);
        const targets = existing.filter((c) => c && String(c.id) === String(body.targetCollectionId));
        const target = targets.length === 1 ? targets[0] : null;
        const folders = target && Array.isArray(target.folders) ? target.folders : [];
        const matches = folders.filter((f) => f && String(f.id) === String(body.folderId));
        const expected = body.expectedFolder;
        const updated = body.updatedFolder;
        if (!body.targetCollectionId || !body.folderId || !expected || typeof expected !== "object" || !updated || typeof updated !== "object" || Array.isArray(updated) || String(updated.id) !== String(body.folderId) || !Array.isArray(updated.catalogSources)) {
          return json({ ok: false, error: "Invalid collection folder update." }, 400);
        }
        if (matches.length !== 1 || !nuvioSnapshotEqual(matches[0], expected)) {
          return json({ ok: false, error: "This Nuvio folder changed or was removed. Your local edits are kept. To discard them, delete the local folder and pull again." }, 409);
        }
        collections = existing.map((c) => c === target ? { ...c, folders: c.folders.map((f) => f === matches[0] ? updated : f) } : c);
      } else if (installMode === "new") {
        collections = addNewNuvioCollection(existing || [], collections, { collectionName: body.collectionName, backdropImageUrl });
      } else if (installMode === "replace") {
        collections = extractNuvioCollections(collections).map((c) => ({ ...c, backdropImageUrl: c.backdropImageUrl || backdropImageUrl }));
      } else if (body.targetCollectionId) {
        const merged = mergeIntoNuvioCollection(existing || [], collections, body.targetCollectionId);
        if (!merged) return json({ ok: false, error: "That Nuvio collection wasn't found. Reopen the dialog and pick it again." }, 400);
        collections = merged;
      } else {
        collections = mergeNuvioCollections(existing || [], collections);
      }

      collections = installMode === "update-folder"
        ? collections.map((c) => c.id === body.targetCollectionId ? { ...c, folders: c.folders.map((f) => f.id === body.folderId ? nuvioSeparateCollectionSources([{ folders: [f] }])[0].folders[0] : f) } : c)
        : nuvioSeparateCollectionSources(collections);
      let homeSettings = null;
      if (typeof body.hideHomeCatalogs === "boolean") {
        try {
          homeSettings = await nuvioCollectionHomeSettings(env, conn.accessToken, profileId, incomingCollections, body.hideHomeCatalogs);
        } catch (homeErr) {
          if (homeErr && homeErr.kind === "invalid") throw homeErr;
          return json({ ok: false, error: "Couldn't read your Nuvio home settings, so nothing was changed. Please try again." }, 502);
        }
      }

      // Read/merge the complete addon list and install the independent config
      // before publishing references to it. Never overwrite the regular addon.
      const collectionsManifestUrl = await nuvioEnsureAddonInstalled(env, conn.accessToken, profileId,
        new URL(request.url).origin, account, collections, body.collectionLists, body.manifestUrl);
      const addonInstalled = Boolean(collectionsManifestUrl);

      await nuvioRpc(env, conn.accessToken, "sync_push_collections", {
        p_profile_id: profileId,
        p_collections_json: collections,
        p_origin_client_id: "my-lists-addon"
      });

      // Collections/addon may already be saved: a failure here is reported as
      // partial success, not a generic failure that invites a duplicate push.
      const homeVisibilityUpdated = homeSettings ? await nuvioSaveHomeVisibility(env, conn.accessToken, profileId, homeSettings, body.hideHomeCatalogs) : null;
      const scope = conn.id ? await installTokenHash("nuvio-collections:" + JSON.stringify([accountId, conn.id])) : null;
      const writtenCollectionIds = installMode === "new" ? collections.slice(existingCount).map((c) => c.id)
        : installMode === "replace" ? collections.map((c) => c.id) : body.targetCollectionId ? [body.targetCollectionId] : [];
      return json({ ok: true, profileId, scope, collections, writtenCollectionIds, addonInstalled, collectionsManifestUrl, existingCount, homeVisibilityUpdated });
    }
  } catch (e) {
    if (e && e.kind) {
      const status = e.kind === "invalid" ? 400 : 502;
      if (e.kind === "unreachable") return json({ ok: false, error: "That service didn't answer. Please try again in a minute.", detail: e.detail || e.message }, status);
      return json({ ok: false, error: e.message }, status);
    }
    throw e;
  }
  return json({ ok: false, error: "Not found." }, 404);
}
