
// --- Stremio and Nuvio accounts: connect, pull watch history (Release 20) ----------
//
// A signed-in account can connect its Stremio and Nuvio accounts. Their real
// watch history and Continue Watching are then pulled into the activity
// database (36_) the same way a play from a media server is, so the shelves
// (39_) show them. Neither service has a public API; what is used here is what
// their own apps use, so every call is checked by tests/fixtures/providers/
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
    else if (!finished && ratio >= MEDIA_APP_STARTED) rec.resume = { season: null, episode: null, ratio };
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
      rec.resume = { ...cur, ratio };
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
  if (!res.ok) throw mediaAppError("unreachable", `Nuvio answered ${res.status}.`);
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

async function nuvioRpc(env, accessToken, fn, params) {
  const res = await mediaAppFetch(`${nuvioBase(env)}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": nuvioKey(env), "Authorization": `Bearer ${accessToken}` },
    body: JSON.stringify(params || {}),
  });
  if (res.status === 401 || res.status === 403) throw mediaAppError("invalid", "Nuvio refused this sign-in.");
  if (!res.ok) throw mediaAppError("unreachable", `Nuvio answered ${res.status}.`);
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
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
  for (let page = 1; page <= 40; page++) {
    const rows = await nuvioRpc(env, accessToken, "sync_pull_watched_items", { p_profile_id: profileIndex, p_page: page, p_page_size: 500 });
    const list = Array.isArray(rows) ? rows : [];
    watched.push(...list);
    if (list.length < 500) break;
  }
  const progress = await nuvioRpc(env, accessToken, "sync_pull_watch_progress", { p_profile_id: profileIndex, p_limit: 200 });
  return { watched, progress: Array.isArray(progress) ? progress : [] };
}

// Nuvio's watched items and progress entries as one record per title (the same
// shape as stremioItemRecord). Both name a title by content_id (or contentId).
function nuvioRecords({ watched, progress }) {
  const by = new Map();
  const recFor = (rawId, rawType, title, poster) => {
    const id = mediaAppTitleId(rawId);
    if (!id) return null;
    const key = id.imdbId || `tmdb:${id.tmdbId}`;
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
      rec.resume = { season: rec.kind === "series" ? season : null, episode: rec.kind === "series" ? episode : null, ratio, at };
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
    if (rec.resume && rec.kind === "movie" && rec.plays.length) rec.resume = null;
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// --- Writing records to the activity database -------------------------------------------

// Records an account's pulled titles. Returns { plays, progress, resumes, unresolved,
// lookups } or { skipped: reason } when the activity database cannot take them yet.
async function applyMediaAppRecords(env, accountId, provider, records, { lookups = MEDIA_APP_LOOKUPS_PER_STEP } = {}) {
  const actDb = activityDb(env, accountId);
  if (!actDb || !(await activitySchemaReady(actDb))) return { skipped: "The activity database is not ready." };
  // Like recordActivityPlay: before the account's history is copied the copy
  // would rebuild show_progress and undo these, so wait.
  const copied = await env.DB.prepare("SELECT status FROM jobs WHERE dedupe_key = ?").bind(`${ACTIVITY_BACKFILL_TYPE}:acct:${accountId}`).first();
  if (!copied || copied.status !== "done") return { skipped: "Your existing history is still being copied. This will run again shortly." };
  const out = { plays: 0, progress: 0, resumes: 0, unresolved: 0, lookups: 0 };
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
    "SELECT media_id, season, episode, watched_at FROM watch_events WHERE account_id = ? AND media_id IN (SELECT value FROM json_each(?))"
  ).bind(accountId, mediaIdsJson).all();
  const stored = new Map();
  for (const e of known || []) {
    const k = `${e.media_id}:${e.season == null ? "" : e.season}:${e.episode == null ? "" : e.episode}`;
    (stored.get(k) || stored.set(k, []).get(k)).push(Number(e.watched_at));
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
      const near = (stored.get(k) || []).some((t) => Math.abs(t - p.watchedAt) < MEDIA_APP_PLAY_WINDOW_MS);
      if (near) continue;
      (stored.get(k) || stored.set(k, []).get(k)).push(p.watchedAt);
      stmts.push(...activityPlayStatements(actDb, accountId, r.mediaId, { season: p.season, episode: p.episode, watchedAt: p.watchedAt, legacyId: null }, provider, now));
      out.plays++;
      if (isSeries && (!datedLast || p.season > datedLast.season || (p.season === datedLast.season && p.episode > datedLast.episode))) datedLast = p;
      if (isSeries && !knownShows.has(r.mediaId) && !newShows.includes(r.mediaId)) newShows.push(r.mediaId);
    }
    if (!isSeries && r.plays.length) {
      // A movie that is finished no longer has a resume point.
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
        const entry = { id: r.imdbId || `tmdb:${r.tmdbId}`, imdbId: r.imdbId || undefined, type: "movie", name: r.title || undefined, poster: r.poster || undefined, progress: Math.round(r.resume.ratio * 100) };
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
    return { records, total: changed.length, newest: library.length ? mediaAppTime(library[0]._mtime) : 0 };
  }
  const profile = await nuvioFetchProfile(env, conn.accessToken, sync.profile_index);
  const all = nuvioRecords(profile).filter(fresh);
  return { records: all.slice(step.offset, step.offset + MEDIA_APP_STEP_ITEMS), total: all.length, newest: all.length ? all[0].mtime : 0 };
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
  const since = cursorSince != null ? cursorSince : (Number(cursor.mtime) > 0 ? Number(cursor.mtime) - MEDIA_APP_OVERLAP_MS : 0);
  let fetched;
  try {
    fetched = await mediaAppFetchRecords(env, accountId, provider, conn, sync, { offset, since });
  } catch (e) {
    if (e && e.kind === "invalid") {
      await markConnectionStatus(env, accountId, provider, "reauth_required", "The service refused this sign-in. Connect it again.");
      await setMediaAppSyncError(env, accountId, provider, "Sign in again to keep syncing.");
      return { done: true, skipped: "reauth" };
    }
    throw e;
  }
  const applied = await applyMediaAppRecords(env, accountId, provider, fetched.records);
  if (applied.skipped) {
    await setMediaAppSyncError(env, accountId, provider, applied.skipped);
    return { done: true, skipped: applied.skipped };
  }
  const next = offset + MEDIA_APP_STEP_ITEMS;
  if (next < fetched.total) return { done: false, offset: next, total: fetched.total, since, applied };
  const nowMs = Date.now();
  await env.DB.prepare(
    "UPDATE media_app_sync SET cursor_json = ?, last_pull_at = ?, last_error = NULL, updated_at = ? WHERE account_id = ? AND provider = ?"
  ).bind(JSON.stringify({ ...cursor, mtime: Math.max(Number(cursor.mtime) || 0, fetched.newest || 0) }), nowMs, nowMs, accountId, provider).run();
  return { done: true, total: fetched.total, applied, pullDone: true };
}

// The job. Each run is one bounded step: a slice of the pull, then (when
// two-way sync is on) slices of the push. The first step of a pull fixes the
// "changed since" mark so later steps see the same list.
async function runMediaAppSyncJob(env, payload, job = {}) {
  const accountId = Number(payload && payload.accountId);
  const provider = String((payload && payload.provider) || "");
  if (!Number.isInteger(accountId) || !MEDIA_APP_PROVIDERS.includes(provider)) return { progress: {} };
  const prev = job.progress || {};
  const totals = { plays: Number(prev.plays) || 0, progress: Number(prev.progress) || 0, pushed: Number(prev.pushed) || 0 };
  if (prev.phase !== "push") {
    const offset = Number(prev.offset) || 0;
    const out = await pullMediaAppStep(env, accountId, provider, offset, offset > 0 && prev.since != null ? Number(prev.since) : null);
    if (out.applied) {
      totals.plays += out.applied.plays;
      totals.progress += out.applied.progress;
    }
    if (!out.done) return { progress: { offset: out.offset, since: out.since, total: out.total, ...totals }, again: true };
    if (!out.pullDone) return { progress: { finishedAt: Date.now(), total: out.total || 0, skipped: out.skipped || null, ...totals } };
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

// A watched item in the shape Nuvio's own rows have. `sample` is one of the
// account's rows, which tells snake_case from camelCase and how time is written.
function nuvioWatchedItem(sample, rec) {
  const snake = sample && Object.prototype.hasOwnProperty.call(sample, "content_id");
  const k = (a, b) => (snake ? a : b);
  const raw = mediaAppPick(sample, "watched_at", "watchedAt");
  const at = typeof raw === "string" && !/^\d+(\.\d+)?$/.test(raw) ? new Date(rec.watchedAt).toISOString()
    : (mediaAppTime(raw) && Number(raw) < 1e11 ? Math.round(rec.watchedAt / 1000) : rec.watchedAt);
  const item = { [k("content_id", "contentId")]: rec.contentId, [k("content_type", "contentType")]: rec.kind, title: rec.title || "", [k("watched_at", "watchedAt")]: at };
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
    const { results: rows } = await actDb.prepare(
      "SELECT id, media_id, season, episode, watched_at FROM watch_events WHERE account_id = ? AND id > ? AND source != ? ORDER BY id LIMIT ?"
    ).bind(accountId, after, provider, MEDIA_APP_PUSH_EVENTS).all();
    const events = rows || [];
    if (!events.length) return none(null);
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
        const sample = profile.watched.find((w) => mediaAppPick(w, "content_id", "contentId")) || profile.progress.find((w) => mediaAppPick(w, "content_id", "contentId"));
        const present = new Set(profile.watched.map((w) => `${String(mediaAppPick(w, "content_id", "contentId") || "").toLowerCase()}:${mediaAppInt(w.season) == null ? "" : mediaAppInt(w.season)}:${mediaAppInt(w.episode) == null ? "" : mediaAppInt(w.episode)}`));
        const fresh = plays.filter((p) => !present.has(`${p.contentId}:${p.season == null ? "" : p.season}:${p.episode == null ? "" : p.episode}`));
        if (fresh.length && !sample) {
          // Nothing of the account's own to copy the format from.
          await setMediaAppSyncError(env, accountId, provider, "Two-way sync starts once there is something watched in Nuvio to match.");
          return none("no sample");
        }
        for (let i = 0; i < fresh.length; i += MEDIA_APP_PUSH_CHUNK) {
          await nuvioRpc(env, conn.accessToken, "sync_push_watched_items", { p_profile_id: sync.profile_index, p_items: fresh.slice(i, i + MEDIA_APP_PUSH_CHUNK).map((p) => nuvioWatchedItem(sample, p)) });
        }
        sent = fresh.length;
      }
    }
    const nowMs = Date.now();
    await env.DB.prepare("UPDATE media_app_sync SET cursor_json = ?, last_push_at = ?, last_error = NULL, updated_at = ? WHERE account_id = ? AND provider = ?")
      .bind(JSON.stringify({ ...cursor, pushedId: events[events.length - 1].id }), nowMs, nowMs, accountId, provider).run();
    return { sent, more: events.length >= MEDIA_APP_PUSH_EVENTS, skipped: null };
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

// Starts a pull for one account's app (what connecting and "Sync now" do).
async function startMediaAppSync(env, accountId, provider) {
  return createJob(env, MEDIA_APP_SYNC_JOB, { dedupeKey: `mediaapp:${accountId}:${provider}`, accountId, payload: { accountId, provider } });
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
    lastPullAt: row.last_pull_at || null,
    lastPushAt: row.last_push_at || null,
    error: row.last_error || null,
  };
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
      await startMediaAppSync(env, accountId, provider);
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
      if (row && row.profile_index) await startMediaAppSync(env, accountId, provider);
      return json({ ok: true, status: "connected", username: session.email || email, profiles, profileIndex: row ? row.profile_index : only });
    }
    if (sub === "settings") {
      const row = await loadMediaAppSync(env, accountId, provider);
      if (!row) return json({ ok: false, error: "That account isn't connected." }, 404);
      const sets = [];
      const binds = [];
      if (body.pull != null) {
        sets.push("pull_enabled = ?");
        binds.push(body.pull ? 1 : 0);
      }
      if (body.push != null) {
        if (body.push && !mediaAppPushFlag(env)) return json({ ok: false, error: "Two-way sync isn't switched on yet." }, 409);
        sets.push("push_enabled = ?");
        binds.push(body.push ? 1 : 0);
      }
      if (body.profileIndex != null) {
        const idx = mediaAppInt(body.profileIndex);
        if (idx == null || idx < 1 || idx > 6) return json({ ok: false, error: "Choose one of your profiles." }, 400);
        // A new profile starts its pull over; the profile names are kept.
        const names = mediaAppProfilesOf(row);
        sets.push("profile_index = ?", "cursor_json = ?", "last_pull_at = NULL");
        binds.push(idx, names.length ? JSON.stringify({ profiles: names }) : null);
      }
      if (sets.length) {
        await env.DB.prepare(`UPDATE media_app_sync SET ${sets.join(", ")}, updated_at = ? WHERE account_id = ? AND provider = ?`)
          .bind(...binds, Date.now(), accountId, provider).run();
        if (body.profileIndex != null || body.pull || body.push) await startMediaAppSync(env, accountId, provider);
      }
      return json({ ok: true, sync: mediaAppSyncSummary(await loadMediaAppSync(env, accountId, provider)) });
    }
    if (sub === "sync") {
      const row = await loadMediaAppSync(env, accountId, provider);
      if (!row) return json({ ok: false, error: "That account isn't connected." }, 404);
      const made = await startMediaAppSync(env, accountId, provider);
      return json({ ok: Boolean(made && made.ok), started: Boolean(made && made.created) }, made && made.ok ? 202 : 503);
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
