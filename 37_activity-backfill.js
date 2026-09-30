
// --- Activity backfill: migrate.activity (Phase 3c, P3c-3) --------------------
//
// Copies every account's watch history and show state into the activity
// database (DB_ACTIVITY, 36_activity-db.js, migrations/activity/):
//
//   1. Watch History becomes watch_events, one row per play, source
//      'migrated'. The history is the union of the three places it lives
//      today -- the KV record creatorsynctracking:{u} (or, for an account
//      that never had one, the older creatorsync:{u}), the D1 table
//      watch_history, and the scrobble queue creatorscrobblequeue:{u} --
//      taking the newest copy of an entry that is in more than one. That is
//      also what /api/creator/sync/load shows today: it merges the queue in.
//      A play already stored within ten minutes of another for the same
//      title and episode is kept once (ACTIVITY_DEDUPE_WINDOW_MS).
//   2. show_progress and user_media_state are then worked out from those
//      events: per show, the furthest episode watched (the one the legacy
//      Continue Watching counts from) and when it was last watched; per
//      movie, how many plays and when last.
//   3. On top of that, per show: completed (fullyWatchedShowIds), the
//      Continue Watching dismissal and the Airing Next removal (each the
//      watched episode it was made at), and the Continue Watching entries
//      progress cannot rebuild -- companions (the next movie or spin-off in
//      a storyline) and movies -- kept whole in companion_json. A Continue
//      Watching show with no history at all keeps its place as progress
//      "just before" the episode it offered (last_episode one less).
//
// Not copied here: Airing Next and the recommendations are worked out, not
// kept (show_schedule and a job, Phase 5), and the Watchlist is a list
// (P3b-3 copies its list record; one kept only in the tracking record moves
// when the tracking reads do, P3c-6).
//
// It COPIES. The legacy keys and tables are only read: the env it works
// through (activityBackfillEnv) cannot write KV at all, may write only the
// media rows and its own job rows in DB, and only the three activity tables
// in DB_ACTIVITY. An account copied afresh first removes its earlier
// 'migrated' rows, so a copy made again after the legacy store changed
// shows that store as it now is; plays written some other way stay.
//
// It runs only when an operator asks, from /admin -> Maintenance, one bounded
// step per request, with its progress and a per-account reconciliation in
// `jobs` (the same shape as the list copy, 30_lists-backfill.js).

const ACTIVITY_BACKFILL_TYPE = "migrate.activity";
const ACTIVITY_BACKFILL_RUN_KEY = "migrate.activity:run";
const ACTIVITY_BACKFILL_STEP_OPS = 350;      // D1 statements and KV reads started per step
const ACTIVITY_BACKFILL_STEP_ITEMS = 1000;   // history entries copied per step
const ACTIVITY_BACKFILL_STEP_LOOKUPS = 100;  // TMDB lookups per step
const ACTIVITY_BACKFILL_CHUNK = 200;         // history entries resolved and written together
const ACTIVITY_BACKFILL_SAMPLES = 5;         // examples kept of each kind of difference
const ACTIVITY_BACKFILL_LEASE_MS = 90000;    // one step at a time
const ACTIVITY_BACKFILL_ENTRY_MAX = 4000;    // characters of a Continue Watching entry kept in companion_json
const ACTIVITY_BACKFILL_MAIN_TABLES = new Set(["media", "jobs", "media_episodes"]);
const ACTIVITY_BACKFILL_ACTIVITY_TABLES = new Set(["watch_events", "show_progress", "user_media_state"]);

// A D1 binding that counts every statement against the step's budget and
// refuses a schema change or a write to any table not in `tables`.
function activityBackfillD1(db, tables, meter, label) {
  const guard = (sql) => {
    const s = String(sql);
    if (/^\s*(?:DROP|ALTER|CREATE)\b/i.test(s)) throw new Error(`activity backfill: refusing a schema change on ${label}`);
    // A statement that opens with WITH could hide a write behind it.
    if (/^\s*WITH\b/i.test(s) && /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(s)) {
      throw new Error(`activity backfill: refusing a WITH write on ${label}`);
    }
    const m = /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+([A-Za-z_]\w*)/i.exec(s);
    if (m && !tables.has(m[1].toLowerCase())) throw new Error(`activity backfill: refusing to write to ${m[1]} on ${label}`);
  };
  const wrap = (st) => ({
    _inner: st,
    bind: (...args) => wrap(st.bind(...args)),
    run: () => { meter.ops++; return st.run(); },
    all: () => { meter.ops++; return st.all(); },
    first: (col) => { meter.ops++; return col === undefined ? st.first() : st.first(col); },
  });
  return {
    prepare: (sql) => { guard(sql); return wrap(db.prepare(sql)); },
    batch: (stmts) => { meter.ops += stmts.length; return db.batch(stmts.map((s) => (s && s._inner) || s)); },
  };
}

// The env every step works through. KV has no write methods at all; R2 is
// not there; DB may write media (29_media.js resolves titles) and jobs;
// every activity database may write only the activity tables.
function activityBackfillEnv(env, meter) {
  const kv = env.CONFIGS;
  const out = {
    ...env,
    DB: activityBackfillD1(env.DB, ACTIVITY_BACKFILL_MAIN_TABLES, meter, "DB"),
    CONFIGS: kv ? {
      get: (...args) => { meter.ops++; return kv.get(...args); },
      list: (...args) => { meter.ops++; return kv.list(...args); },
    } : undefined,
    BLOBS: undefined,
  };
  for (const name of Object.keys(env)) {
    if (name === "DB_ACTIVITY" || /^DB_ACTIVITY_\d+$/.test(name)) {
      out[name] = env[name] ? activityBackfillD1(env[name], ACTIVITY_BACKFILL_ACTIVITY_TABLES, meter, name) : env[name];
    }
  }
  return out;
}

function activityBackfillOpsLeft(budget) {
  return budget.meter.ops < budget.maxOps;
}

function activityBackfillSample(arr, value) {
  if (Array.isArray(arr) && arr.length < ACTIVITY_BACKFILL_SAMPLES) arr.push(value);
}

function emptyActivityRecon() {
  return {
    history: { kv: 0, d1: 0, queue: 0, union: 0, copied: 0, duplicates: 0, unusable: 0, undated: 0, stubs: 0 },
    shows: { progress: 0, completed: 0, dismissed: 0, airingHidden: 0, kept: 0, cwOnly: 0, unusable: 0 },
    movies: 0,
    events: 0,
    legacyMax: 0,
    short: 0,
    samples: { unusable: [], duplicates: [], short: [] },
  };
}

async function loadActivityBackfillJob(env, key) {
  const row = await env.DB.prepare(
    "SELECT id, status, attempts, run_after, progress_json, last_error FROM jobs WHERE dedupe_key = ?"
  ).bind(key).first();
  if (!row) return null;
  let progress = {};
  try {
    progress = row.progress_json ? JSON.parse(row.progress_json) : {};
  } catch {
    progress = {};
  }
  return { ...row, progress };
}

async function saveActivityBackfillJob(env, key, accountId, fields) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO jobs (type, dedupe_key, account_id, status, attempts, run_after, progress_json, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dedupe_key) DO UPDATE SET status = excluded.status, attempts = excluded.attempts, run_after = excluded.run_after,
       progress_json = excluded.progress_json, last_error = excluded.last_error, updated_at = excluded.updated_at`
  ).bind(ACTIVITY_BACKFILL_TYPE, key, accountId, fields.status, fields.attempts || 0, fields.runAfter || 0,
    JSON.stringify(fields.progress || {}), fields.lastError || null, now, now).run();
}

// --- Reading the legacy store (read only) -------------------------------------

function parseActivityJson(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

function activityStamp(raw) {
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  const d = Date.parse(String(raw || ""));
  return Number.isFinite(d) && d > 0 ? d : 0;
}

// A legacy table that is not there (its migration never applied) reads as
// empty, as the legacy reads treat it.
async function readLegacyActivityRows(env, sql, username) {
  try {
    const { results } = await env.DB.prepare(sql).bind(username).all();
    return results || [];
  } catch (e) {
    if (/no such table|no such column/i.test(String((e && e.message) || e))) return [];
    throw e;
  }
}

// D1's continue_watching row as the entry it was saved from (the reverse of
// writeCreatorTrackingD1, as readCreatorTrackingD1 reads it).
function legacyContinueWatchingFromRow(r) {
  let entry = {
    id: r.item_id,
    showId: r.show_id,
    name: r.name || undefined,
    poster: r.poster || undefined,
    showTitle: r.show_title || undefined,
    showPoster: r.show_poster || undefined,
    seasonNum: r.season_num != null ? r.season_num : undefined,
    episodeNum: r.episode_num != null ? r.episode_num : undefined,
    updatedAt: r.updated_at,
  };
  if (r.show_title && String(r.show_title).startsWith("COMPANION:")) {
    const meta = parseActivityJson(String(r.show_title).slice(10));
    if (meta) {
      entry = {
        ...entry,
        isCompanion: true,
        companionType: meta.companionType,
        companionNote: meta.companionNote,
        companionStoryline: meta.companionStoryline,
        precedingShowId: meta.precedingShowId,
        showTitle: meta.showTitle || undefined,
        kind: meta.kind || undefined,
        type: meta.type || (meta.kind === "movie" ? "movie" : "episode"),
      };
    }
  } else if (r.season_num == null && r.episode_num == null && !r.show_title) {
    entry.type = "movie";
    entry.kind = "movie";
  } else {
    entry.type = "episode";
  }
  return entry;
}

function legacyStatesFromRows(rows) {
  const fullyWatched = [];
  const dismissed = {};
  const removedAiring = {};
  for (const s of rows) {
    const id = String(s.show_id || "");
    if (!id) continue;
    if (s.is_fully_watched) fullyWatched.push(id);
    if (s.dismissed_season != null || s.dismissed_episode != null) {
      dismissed[id] = { seasonNum: s.dismissed_season != null ? s.dismissed_season : 0, episodeNum: s.dismissed_episode != null ? s.dismissed_episode : 0 };
    }
    if (s.airing_removed_season != null || s.airing_removed_episode != null) {
      removedAiring[id] = { seasonNum: s.airing_removed_season != null ? s.airing_removed_season : 0, episodeNum: s.airing_removed_episode != null ? s.airing_removed_episode : 0 };
    }
  }
  return { fullyWatched, dismissed, removedAiring };
}

// Everything one account has, from the three places, without changing any.
async function readLegacyActivity(env, username) {
  const [trackingRaw, queueRaw] = await Promise.all([
    env.CONFIGS ? env.CONFIGS.get(`creatorsynctracking:${username}`) : null,
    env.CONFIGS ? env.CONFIGS.get(`creatorscrobblequeue:${username}`) : null,
  ]);
  let kv = parseActivityJson(trackingRaw);
  // Tracking kept inside the sync record, from before it had its own key
  // (ensureTrackingMigrated moves it on the account's next write).
  if (!kv && trackingRaw == null && env.CONFIGS) {
    const old = parseActivityJson(await env.CONFIGS.get(`creatorsync:${username}`));
    if (old && (Array.isArray(old.watchHistory) || Array.isArray(old.continueWatching) || Array.isArray(old.fullyWatchedShowIds) || old.dismissedContinueWatching)) {
      kv = { ...old, updatedAt: activityStamp(old.updatedAt) };
    }
  }

  let d1 = null;
  if (env.DB) {
    const meta = (await readLegacyActivityRows(env, "SELECT updated_at FROM creator_tracking_meta WHERE username = ?", username))[0] || null;
    const wh = await readLegacyActivityRows(env, "SELECT * FROM watch_history WHERE username = ?", username);
    const cw = await readLegacyActivityRows(env, "SELECT * FROM continue_watching WHERE username = ?", username);
    const states = await readLegacyActivityRows(env, "SELECT * FROM creator_show_states WHERE username = ?", username);
    if (meta || wh.length || cw.length || states.length) {
      d1 = {
        updatedAt: meta ? activityStamp(meta.updated_at) : 0,
        watchHistory: wh.map((r) => ({
          id: r.item_id,
          type: r.item_type,
          name: r.title || undefined,
          showId: r.show_id || undefined,
          showTitle: r.show_title || undefined,
          seasonNum: r.season_num != null ? r.season_num : undefined,
          episodeNum: r.episode_num != null ? r.episode_num : undefined,
          year: r.year || undefined,
          watchedAt: r.watched_at,
        })),
        continueWatching: cw.map(legacyContinueWatchingFromRow),
        ...legacyStatesFromRows(states),
      };
    }
  }

  const queue = parseActivityJson(queueRaw);
  const queueWh = Array.isArray(queue) ? queue : (queue && Array.isArray(queue.watchHistory) ? queue.watchHistory : []);
  const queueCw = queue && !Array.isArray(queue) && Array.isArray(queue.continueWatching) ? queue.continueWatching : [];

  return {
    kv: kv ? {
      updatedAt: activityStamp(kv.updatedAt),
      watchHistory: Array.isArray(kv.watchHistory) ? kv.watchHistory : [],
      continueWatching: Array.isArray(kv.continueWatching) ? kv.continueWatching : [],
      fullyWatched: Array.isArray(kv.fullyWatchedShowIds) ? kv.fullyWatchedShowIds.map(String) : [],
      dismissed: kv.dismissedContinueWatching && typeof kv.dismissedContinueWatching === "object" ? kv.dismissedContinueWatching : {},
      removedAiring: kv.removedAiringNext && typeof kv.removedAiringNext === "object" ? kv.removedAiringNext : {},
    } : null,
    d1,
    queue: { watchHistory: queueWh, continueWatching: queueCw },
  };
}

// --- History -------------------------------------------------------------------

// A history entry's identity in the legacy store: its id, or for an episode
// without one, show:season:episode (writeCreatorTrackingD1's fallback).
function legacyHistoryId(item) {
  if (!item || typeof item !== "object") return "";
  if (item.id != null && String(item.id)) return String(item.id);
  if (item.showId) return `${item.showId}:${item.seasonNum}:${item.episodeNum}`;
  return "";
}

// The entry as a play: which title (as a ref resolveMediaBatch reads), which
// episode, and when. An episode saved without its show (the web page does
// that when it had no show loaded) is named by its composite id, which
// carries both: "tt0903747:1:2" or "tmdb:1396:1:2".
function legacyHistoryPlay(item, fallbackAt) {
  const id = legacyHistoryId(item);
  let season = Number.isFinite(Number(item.seasonNum)) && item.seasonNum !== null && item.seasonNum !== "" ? Number(item.seasonNum) : null;
  let episode = Number.isFinite(Number(item.episodeNum)) && item.episodeNum !== null && item.episodeNum !== "" ? Number(item.episodeNum) : null;
  let showId = item.showId ? String(item.showId) : "";
  const isEpisode = String(item.type || "").toLowerCase() === "episode" || season != null || episode != null || !!showId;
  if (isEpisode && (!showId || season == null || episode == null)) {
    const parts = id.split(":");
    const tail = parts.length >= 3 ? parts.slice(-2) : null;
    if (tail && /^\d+$/.test(tail[0]) && /^\d+$/.test(tail[1])) {
      if (!showId) showId = parts.slice(0, -2).join(":");
      if (season == null) season = Number(tail[0]);
      if (episode == null) episode = Number(tail[1]);
    }
  }
  let watchedAt = activityStamp(item.watchedAt);
  const undated = !watchedAt;
  if (!watchedAt) watchedAt = fallbackAt || 0;
  const ref = isEpisode
    ? { type: "episode", showId, imdbId: item.imdbId, showTitle: item.showTitle, seasonNum: season, episodeNum: episode }
    : { ...item };
  // The episode's own name and still, which the activity database keeps in
  // media_episodes rather than on the play (29_media.js).
  const names = isEpisode ? episodeTitleFromLegacy(item) : null;
  return {
    id,
    ref,
    season: isEpisode ? season : null,
    episode: isEpisode ? episode : null,
    title: names ? names.title : "",
    image: names ? names.image : "",
    watchedAt,
    undated,
    label: String(item.showTitle || item.name || item.title || id || "(no id)").slice(0, 80) + (isEpisode && season != null ? ` S${season}E${episode}` : ""),
  };
}

// The union of the three histories, the newest copy of an entry kept, oldest
// play first (so plays added while a copy is under way land after its
// cursor). Also the counts the reconciliation compares against.
function mergeLegacyHistory(legacy) {
  const merged = new Map();
  const counts = { kv: 0, d1: 0, queue: 0 };
  const add = (items, source, fallbackAt) => {
    const seen = new Set();
    for (const item of items || []) {
      if (!item || typeof item !== "object") continue;
      const id = legacyHistoryId(item);
      if (!id) {
        // No identity at all: cannot be copied, and the legacy store could
        // not show it either. Counted, and reported as having no usable id.
        counts[source]++;
        merged.set(`(no id):${source}:${counts[source]}`, { item, fallbackAt });
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      counts[source]++;
      const prev = merged.get(id);
      if (!prev || activityStamp(item.watchedAt) > activityStamp(prev.item.watchedAt)) merged.set(id, { item, fallbackAt });
    }
  };
  if (legacy.kv) add(legacy.kv.watchHistory, "kv", legacy.kv.updatedAt);
  if (legacy.d1) add(legacy.d1.watchHistory, "d1", legacy.d1.updatedAt);
  add(legacy.queue.watchHistory, "queue", 0);
  // Each play's cursor key is its merge key, so entries with no id (which
  // share an empty id) still each have their own place in the order.
  const plays = [...merged.entries()].map(([key, { item, fallbackAt }]) => ({ ...legacyHistoryPlay(item || {}, fallbackAt), id: key }));
  plays.sort((a, b) => a.watchedAt - b.watchedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { plays, counts, union: merged.size };
}

function activityCursorAfter(play, cursor) {
  if (!cursor) return true;
  return play.watchedAt > cursor.t || (play.watchedAt === cursor.t && play.id > cursor.k);
}

// One chunk of plays: titles resolved, then written as events, skipping a
// play within ten minutes of one already stored for the same episode.
async function copyActivityHistoryChunk(env, actDb, accountId, chunk, budget, recon) {
  const { ids, stats } = await resolveMediaBatch(env, chunk.map((p) => p.ref), { maxLookups: Math.max(0, budget.lookups) });
  budget.lookups -= stats.lookups;
  budget.items -= chunk.length;

  const rows = [];
  chunk.forEach((play, i) => {
    if (play.undated) recon.history.undated++;
    const mediaId = ids[i];
    if (mediaId == null) {
      recon.history.unusable++;
      activityBackfillSample(recon.samples.unusable, play.label);
      return;
    }
    rows.push({ mediaId, season: play.season, episode: play.episode, t: play.watchedAt, label: play.label,
      legacyId: String(play.id).startsWith("(no id)") ? null : play.id, title: play.title, image: play.image });
  });
  const { inserted, kept } = await insertActivityPlays(actDb, accountId, rows, "migrated", (r) => {
    recon.history.duplicates++;
    activityBackfillSample(recon.samples.duplicates, r.label);
  });
  // Every episode name the legacy entries carry, duplicates' included: the
  // one place the names of plays copied before 0020 can come from.
  await saveEpisodeTitles(env, rows);
  recon.history.copied += inserted;
  // A play the statement skipped was within ten minutes of one stored by
  // an earlier chunk (or a same-key play): a duplicate as well.
  recon.history.duplicates += Math.max(0, kept - inserted);
}

// Writes plays ({ mediaId, season, episode, t, legacyId }) as events, one
// statement per JSON chunk. Two plays of one episode ten minutes apart or
// less are one: within `rows` here (a statement cannot see its own rows),
// and against what is stored by the NOT EXISTS. onDuplicate is called for
// each play dropped here. Returns { inserted, kept }: kept minus inserted
// is the plays the statement skipped (duplicates of stored ones). Shared by
// the history copy and the save-tracking shim (40_event-tracking.js).
async function insertActivityPlays(actDb, accountId, rows, source, onDuplicate) {
  const sorted = rows.slice().sort((a, b) => a.mediaId - b.mediaId || String(a.season).localeCompare(String(b.season))
    || String(a.episode).localeCompare(String(b.episode)) || a.t - b.t);
  const kept = [];
  for (const r of sorted) {
    const last = kept[kept.length - 1];
    if (last && last.mediaId === r.mediaId && last.season === r.season && last.episode === r.episode && r.t - last.t < ACTIVITY_DEDUPE_WINDOW_MS) {
      if (onDuplicate) onDuplicate(r);
      continue;
    }
    kept.push(r);
  }
  let inserted = 0;
  const data = kept.map((r) => [r.mediaId, r.season, r.episode, r.t, activityDedupeKey(accountId, r.mediaId, r.season, r.episode, r.t), r.legacyId || null]);
  for (const part of d1JsonChunks(data)) {
    const out = await actDb.prepare(
      `INSERT OR IGNORE INTO watch_events (account_id, media_id, season, episode, watched_at, source, dedupe_key, legacy_id)
       SELECT ?, j.m, j.s, j.e, j.t, ?, j.k, j.l
       FROM (SELECT json_extract(value, '$[0]') AS m, json_extract(value, '$[1]') AS s, json_extract(value, '$[2]') AS e,
                    json_extract(value, '$[3]') AS t, json_extract(value, '$[4]') AS k, json_extract(value, '$[5]') AS l FROM json_each(?)) AS j
       WHERE NOT EXISTS (
         SELECT 1 FROM watch_events w
         WHERE w.account_id = ? AND w.media_id = j.m AND w.season IS j.s AND w.episode IS j.e
           AND w.watched_at > j.t - ? AND w.watched_at < j.t + ?)`
    ).bind(accountId, source, part, accountId, ACTIVITY_DEDUPE_WINDOW_MS, ACTIVITY_DEDUPE_WINDOW_MS).run();
    inserted += Number(out && out.meta && out.meta.changes) || 0;
  }
  return { inserted, kept: kept.length };
}

// --- Show state ------------------------------------------------------------------

function legacyShowRefInput(key) {
  return { id: key, type: "series" };
}

// Which show a Continue Watching entry is about, and whether progress can
// rebuild it: an episode of a show can; a companion (the next movie or
// spin-off in a storyline) or a movie cannot, so it is kept whole.
function legacyContinueWatchingKey(entry) {
  return trackingShowKey(entry.showId || entry.id || entry.imdbId || (entry.tmdbId ? "tmdb:" + entry.tmdbId : ""));
}

// The show state both stores hold, the newer store winning where they
// differ: fully watched is the newer store's set (it is cleared when a new
// episode turns up); a dismissal or an Airing Next removal is only ever
// replaced, never undone, so the older store's are kept under the newer's.
// Continue Watching entries in the order /api/creator/sync/load shows them:
// the queue first, then the newer store, then the older.
function mergeLegacyShowState(legacy) {
  const stores = [legacy.kv, legacy.d1].filter(Boolean).sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
  const newer = stores[stores.length - 1] || null;
  const fullyWatched = new Set((newer ? newer.fullyWatched : []).map((s) => trackingShowKey(s)).filter(Boolean));
  const dismissed = new Map();
  const removedAiring = new Map();
  for (const store of stores) {
    for (const [k, v] of Object.entries(store.dismissed || {})) if (trackingShowKey(k)) dismissed.set(trackingShowKey(k), v || {});
    for (const [k, v] of Object.entries(store.removedAiring || {})) if (trackingShowKey(k)) removedAiring.set(trackingShowKey(k), v || {});
  }
  const cw = new Map();
  for (const list of [legacy.queue.continueWatching, ...stores.slice().reverse().map((s) => s.continueWatching)]) {
    for (const entry of list || []) {
      if (!entry || typeof entry !== "object") continue;
      const key = legacyContinueWatchingKey(entry);
      if (!key || cw.has(key)) continue;
      if (!entry.isCompanion && fullyWatched.has(key)) continue;
      cw.set(key, entry);
    }
  }
  return { fullyWatched, dismissed, removedAiring, cw };
}

function legacyEpisodeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

// show_progress and user_media_state, rebuilt for the account in one batch
// on its activity database: from its events, then the legacy show state on
// top. Returns the counts for the reconciliation.
async function rebuildActivityProgress(env, actDb, accountId, legacy, budget, recon) {
  const state = mergeLegacyShowState(legacy);
  const keys = new Set([...state.fullyWatched, ...state.dismissed.keys(), ...state.removedAiring.keys()]);
  const stateKeys = [...keys];
  const cwEntries = [...state.cw.entries()];
  const inputs = [
    ...stateKeys.map(legacyShowRefInput),
    ...cwEntries.map(([, entry]) => entry),
  ];
  let ids = [];
  if (inputs.length) {
    const out = await resolveMediaBatch(env, inputs, { maxLookups: Math.max(0, budget.lookups) });
    budget.lookups -= out.stats.lookups;
    ids = out.ids;
  }

  const now = Date.now();
  // media id -> the state columns for it.
  const rows = new Map();
  const rowFor = (mediaId) => {
    let r = rows.get(mediaId);
    if (!r) {
      r = { status: null, ds: null, de: null, as: null, ae: null, entry: null, cs: null, ce: null, ct: null };
      rows.set(mediaId, r);
    }
    return r;
  };
  stateKeys.forEach((key, i) => {
    const mediaId = ids[i];
    if (mediaId == null) {
      recon.shows.unusable++;
      return;
    }
    const r = rowFor(mediaId);
    if (state.fullyWatched.has(key)) r.status = "completed";
    const dis = state.dismissed.get(key);
    if (dis) {
      r.ds = legacyEpisodeNumber(dis.seasonNum);
      r.de = legacyEpisodeNumber(dis.episodeNum);
    }
    const rem = state.removedAiring.get(key);
    if (rem) {
      r.as = legacyEpisodeNumber(rem.seasonNum);
      r.ae = legacyEpisodeNumber(rem.episodeNum);
    }
  });
  cwEntries.forEach(([key, entry], j) => {
    const mediaId = ids[stateKeys.length + j];
    if (mediaId == null) {
      recon.shows.unusable++;
      return;
    }
    const r = rowFor(mediaId);
    const season = Number(entry.seasonNum);
    const episode = Number(entry.episodeNum);
    const isEpisode = !entry.isCompanion && String(entry.type || "episode") !== "movie" && entry.kind !== "movie"
      && Number.isFinite(season) && Number.isFinite(episode);
    if (isEpisode) {
      // Used only when the show has no history to count from (below).
      r.cs = Math.trunc(season);
      r.ce = Math.max(0, Math.trunc(episode) - 1);
      r.ct = activityStamp(entry.updatedAt || entry.watchedAt) || null;
      return;
    }
    let text = null;
    try {
      text = JSON.stringify(entry);
    } catch {
      text = null;
    }
    if (text && text.length <= ACTIVITY_BACKFILL_ENTRY_MAX) r.entry = text;
    if (!r.ct) r.ct = activityStamp(entry.updatedAt || entry.watchedAt) || null;
  });

  const stateData = [...rows.entries()].map(([mediaId, r]) => [mediaId, r.status, r.ds, r.de, r.as, r.ae, r.entry, r.cs, r.ce, r.ct]);
  const stmts = [
    actDb.prepare("DELETE FROM show_progress WHERE account_id = ?").bind(accountId),
    actDb.prepare("DELETE FROM user_media_state WHERE account_id = ?").bind(accountId),
    // Per show: the furthest episode watched, and when the show was last
    // watched at all.
    actDb.prepare(
      `INSERT INTO show_progress (account_id, media_id, last_season, last_episode, last_watched_at, updated_at)
       SELECT account_id, media_id, season, episode, last_at, ?
       FROM (SELECT account_id, media_id, season, episode,
                    max(watched_at) OVER (PARTITION BY media_id) AS last_at,
                    row_number() OVER (PARTITION BY media_id ORDER BY season DESC, episode DESC, watched_at DESC) AS rn
             FROM watch_events WHERE account_id = ? AND season IS NOT NULL AND episode IS NOT NULL)
       WHERE rn = 1`
    ).bind(now, accountId),
    // Per movie (or a show marked watched as a whole): plays and the last one.
    actDb.prepare(
      `INSERT INTO user_media_state (account_id, media_id, watched_count, last_watched_at)
       SELECT account_id, media_id, count(*), max(watched_at)
       FROM watch_events WHERE account_id = ? AND season IS NULL AND episode IS NULL
       GROUP BY account_id, media_id`
    ).bind(accountId),
  ];
  for (const part of d1JsonChunks(stateData)) {
    stmts.push(actDb.prepare(
      `INSERT INTO show_progress (account_id, media_id, last_season, last_episode, last_watched_at, status,
         dismissed_at_season, dismissed_at_episode, airing_hidden_at_season, airing_hidden_at_episode, companion_json, updated_at)
       SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[7]'), json_extract(value, '$[8]'), json_extract(value, '$[9]'),
              COALESCE(json_extract(value, '$[1]'), 'watching'), json_extract(value, '$[2]'), json_extract(value, '$[3]'),
              json_extract(value, '$[4]'), json_extract(value, '$[5]'), json_extract(value, '$[6]'), ?
       FROM json_each(?) WHERE true
       ON CONFLICT (account_id, media_id) DO UPDATE SET
         status = excluded.status,
         dismissed_at_season = excluded.dismissed_at_season,
         dismissed_at_episode = excluded.dismissed_at_episode,
         airing_hidden_at_season = excluded.airing_hidden_at_season,
         airing_hidden_at_episode = excluded.airing_hidden_at_episode,
         companion_json = excluded.companion_json`
    ).bind(accountId, now, part));
  }
  await actDb.batch(stmts);

  for (const r of rows.values()) {
    if (r.status === "completed") recon.shows.completed++;
    if (r.ds != null) recon.shows.dismissed++;
    if (r.as != null) recon.shows.airingHidden++;
    if (r.entry) recon.shows.kept++;
  }
  const counts = await actDb.prepare(
    `SELECT (SELECT count(*) FROM watch_events WHERE account_id = ?) AS events,
            (SELECT count(*) FROM show_progress WHERE account_id = ?) AS progress,
            (SELECT count(*) FROM show_progress WHERE account_id = ? AND last_season IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM watch_events w WHERE w.account_id = show_progress.account_id AND w.media_id = show_progress.media_id AND w.season IS NOT NULL)) AS cw_only,
            (SELECT count(*) FROM user_media_state WHERE account_id = ?) AS movies`
  ).bind(accountId, accountId, accountId, accountId).first();
  recon.events = Number(counts && counts.events) || 0;
  // Titles in the account's history TMDB could not place yet (stubs, tried
  // again later): counted over the finished copy, however it was split up.
  const { results: watched } = await actDb.prepare("SELECT DISTINCT media_id FROM watch_events WHERE account_id = ?").bind(accountId).all();
  const mediaIds = (watched || []).map((r) => r.media_id);
  recon.history.stubs = 0;
  for (let i = 0; i < mediaIds.length; i += MEDIA_LOOKUP_CHUNK) {
    const part = mediaIds.slice(i, i + MEDIA_LOOKUP_CHUNK);
    const row = await env.DB.prepare(`SELECT count(*) AS n FROM media WHERE resolved_at IS NULL AND id IN (${part.map(() => "?").join(", ")})`).bind(...part).first();
    recon.history.stubs += Number(row && row.n) || 0;
  }
  recon.shows.progress = Number(counts && counts.progress) || 0;
  recon.shows.cwOnly = Number(counts && counts.cw_only) || 0;
  recon.movies = Number(counts && counts.movies) || 0;
}

// --- One account --------------------------------------------------------------

// Returns { finished, failed }. Not finished: the budget ran out and the
// account's job row holds where to resume. A failure is recorded on the
// account's row and the run moves on.
async function backfillAccountActivity(env, account, budget) {
  const key = `${ACTIVITY_BACKFILL_TYPE}:acct:${account.id}`;
  const job = await loadActivityBackfillJob(env, key);
  if (job && job.status === "done") return { finished: true, failed: false, skipped: true };
  const actDb = activityDb(env, account.id);
  let p = job && job.status === "running" && job.progress && job.progress.phase ? job.progress : null;
  try {
    const legacy = await readLegacyActivity(env, account.username);
    const { plays, counts, union } = mergeLegacyHistory(legacy);
    if (!p) {
      // A fresh copy: what an earlier one left is replaced, so a play the
      // legacy store no longer has does not linger.
      await actDb.prepare("DELETE FROM watch_events WHERE account_id = ? AND source = 'migrated'").bind(account.id).run();
      p = { phase: "history", cursor: null, recon: emptyActivityRecon(), startedAt: Date.now() };
    }
    if (p.phase === "history") {
      let i = 0;
      while (i < plays.length && !activityCursorAfter(plays[i], p.cursor)) i++;
      while (i < plays.length) {
        if (!activityBackfillOpsLeft(budget) || budget.items <= 0) {
          await saveActivityBackfillJob(env, key, account.id, { status: "running", attempts: job ? job.attempts : 0, progress: p });
          return { finished: false };
        }
        const chunk = plays.slice(i, i + Math.min(ACTIVITY_BACKFILL_CHUNK, budget.items));
        await copyActivityHistoryChunk(env, actDb, account.id, chunk, budget, p.recon);
        i += chunk.length;
        const last = chunk[chunk.length - 1];
        p.cursor = { t: last.watchedAt, k: last.id };
      }
      p.phase = "shows";
    }
    if (!activityBackfillOpsLeft(budget)) {
      await saveActivityBackfillJob(env, key, account.id, { status: "running", attempts: job ? job.attempts : 0, progress: p });
      return { finished: false };
    }
    await rebuildActivityProgress(env, actDb, account.id, legacy, budget, p.recon);

    const recon = p.recon;
    recon.history.kv = counts.kv;
    recon.history.d1 = counts.d1;
    recon.history.queue = counts.queue;
    recon.history.union = union;
    recon.legacyMax = Math.max(counts.kv, counts.d1);
    recon.short = Math.max(0, recon.legacyMax - recon.events);
    if (recon.short) {
      activityBackfillSample(recon.samples.short, `${recon.short} fewer plays than the old history (${recon.history.duplicates} duplicates, ${recon.history.unusable} with no usable id)`);
    }
    await saveActivityBackfillJob(env, key, account.id, {
      status: "done", attempts: job ? job.attempts : 0,
      progress: { recon, startedAt: p.startedAt, finishedAt: Date.now() },
    });
    return { finished: true, failed: false };
  } catch (e) {
    console.error("activity backfill: account " + account.id + " failed", e);
    await saveActivityBackfillJob(env, key, account.id, {
      status: "failed", attempts: (job ? job.attempts : 0) + 1,
      progress: { recon: p ? p.recon : emptyActivityRecon(), phase: p ? p.phase : null, failedAt: Date.now() },
      lastError: safeErrorMessage(e),
    });
    return { finished: true, failed: true };
  }
}

// --- The driver ---------------------------------------------------------------

function activityBackfillLimit(value, min, max) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : max;
}

// Why the copy cannot run yet, or null.
async function activityBackfillBlocker(env) {
  if (!env.DB_ACTIVITY) return "The activity database is not bound. Create mylists-activity, run migrations/activity/A0001_activity.sql in it, and bind it as DB_ACTIVITY.";
  for (const db of activityDbs(env)) {
    if (!(await activitySchemaReady(db))) return "Run migrations/activity/A0001_activity.sql in the activity database first.";
  }
  return null;
}

// One bounded step. opts (admin only): restart -- copy every account again
// from the start; maxOps / maxItems / maxLookups -- a smaller step (tests use
// these to force a copy across many steps).
async function runActivityBackfillStep(env, opts = {}) {
  // With FF_EVENT_TRACKING, copied accounts are served from the activity
  // database and their legacy stores stop moving: copying them again would
  // undo what happened since. New accounts are still copied.
  if (opts.restart && typeof isEventTrackingEnabled === "function" && isEventTrackingEnabled(env)) {
    return { ok: false, error: "FF_EVENT_TRACKING is on: copied accounts are served from the activity database, so they cannot be copied again. Copy history still copies the rest." };
  }
  const blocker = await activityBackfillBlocker(env);
  if (blocker) return { ok: false, error: blocker };
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO jobs (type, dedupe_key, status, run_after, progress_json, created_at, updated_at) VALUES (?, ?, 'queued', 0, '{}', ?, ?) ON CONFLICT(dedupe_key) DO NOTHING"
  ).bind(ACTIVITY_BACKFILL_TYPE, ACTIVITY_BACKFILL_RUN_KEY, now, now).run();
  const claim = await env.DB.prepare(
    "UPDATE jobs SET run_after = ?, updated_at = ? WHERE dedupe_key = ? AND run_after <= ?"
  ).bind(now + ACTIVITY_BACKFILL_LEASE_MS, now, ACTIVITY_BACKFILL_RUN_KEY, now).run();
  if (!claim || !claim.meta || Number(claim.meta.changes) !== 1) {
    return { ok: false, busy: true, error: "Another copy step is running. Try again in a minute." };
  }
  const meter = { ops: 0 };
  const menv = activityBackfillEnv(env, meter);
  const budget = {
    meter,
    maxOps: activityBackfillLimit(opts.maxOps, 20, ACTIVITY_BACKFILL_STEP_OPS),
    items: activityBackfillLimit(opts.maxItems, 1, ACTIVITY_BACKFILL_STEP_ITEMS),
    lookups: activityBackfillLimit(opts.maxLookups, 0, ACTIVITY_BACKFILL_STEP_LOOKUPS),
  };
  let run;
  try {
    const job = await loadActivityBackfillJob(menv, ACTIVITY_BACKFILL_RUN_KEY);
    run = !opts.restart && job && job.progress && job.progress.phase ? job.progress : null;
    if (!run) {
      run = { phase: "accounts", afterAccountId: 0, accountsTotal: 0, accountsDone: 0, accountsFailed: 0, startedAt: Date.now() };
      if (opts.restart) {
        // Every account is copied afresh.
        await menv.DB.prepare("UPDATE jobs SET status = 'queued' WHERE type = ? AND account_id IS NOT NULL")
          .bind(ACTIVITY_BACKFILL_TYPE).run();
      }
      const counted = await menv.DB.prepare("SELECT count(*) AS n FROM accounts WHERE deleted_at IS NULL").first();
      run.accountsTotal = Number(counted && counted.n) || 0;
      if (!run.accountsTotal) {
        await saveActivityBackfillJob(menv, ACTIVITY_BACKFILL_RUN_KEY, null, { status: "queued", progress: {}, runAfter: 0 });
        return { ok: false, error: "The accounts table is empty. Run Migrate Accounts first." };
      }
    }
    while (run.phase !== "done" && activityBackfillOpsLeft(budget)) {
      const account = await menv.DB.prepare(
        "SELECT id, username FROM accounts WHERE id > ? AND deleted_at IS NULL ORDER BY id LIMIT 1"
      ).bind(run.afterAccountId).first();
      if (!account) {
        run.phase = "done";
        run.finishedAt = Date.now();
        break;
      }
      const r = await backfillAccountActivity(menv, account, budget);
      if (!r.finished) break;
      run.afterAccountId = account.id;
      run.accountsDone++;
      if (r.failed) run.accountsFailed++;
    }
    run.updatedAt = Date.now();
    await saveActivityBackfillJob(menv, ACTIVITY_BACKFILL_RUN_KEY, null, { status: run.phase === "done" ? "done" : "running", progress: run, runAfter: 0 });
  } catch (e) {
    // Let go of the lease so the next step can try again.
    await env.DB.prepare("UPDATE jobs SET run_after = 0, last_error = ?, updated_at = ? WHERE dedupe_key = ?")
      .bind(safeErrorMessage(e), Date.now(), ACTIVITY_BACKFILL_RUN_KEY).run();
    throw e;
  }
  return {
    ok: true, done: run.phase === "done", phase: run.phase,
    accountsTotal: run.accountsTotal, accountsDone: run.accountsDone, accountsFailed: run.accountsFailed,
    ops: meter.ops,
  };
}

// Where the run is, and the reconciliation added up over every account.
async function activityBackfillStatus(env) {
  const run = await loadActivityBackfillJob(env, ACTIVITY_BACKFILL_RUN_KEY);
  const sum = (path) => `COALESCE(sum(json_extract(progress_json, '$.recon.${path}')), 0)`;
  const fields = {
    history: ["kv", "d1", "queue", "union", "copied", "duplicates", "unusable", "undated", "stubs"],
    shows: ["progress", "completed", "dismissed", "airingHidden", "kept", "cwOnly", "unusable"],
  };
  const cols = [];
  for (const [group, names] of Object.entries(fields)) {
    for (const n of names) cols.push(`${sum(`${group}.${n}`)} AS ${group}_${n}`);
  }
  cols.push(`${sum("movies")} AS movies`, `${sum("events")} AS events`, `${sum("legacyMax")} AS legacy_max`,
    `COALESCE(sum(CASE WHEN json_extract(progress_json, '$.recon.short') > 0 THEN 1 ELSE 0 END), 0) AS short_accounts`);
  const { results } = await env.DB.prepare(
    `SELECT status, count(*) AS n, ${cols.join(", ")} FROM jobs WHERE type = ? AND account_id IS NOT NULL GROUP BY status`
  ).bind(ACTIVITY_BACKFILL_TYPE).all();
  const accounts = { done: 0, running: 0, failed: 0, queued: 0 };
  const totals = { history: {}, shows: {}, movies: 0, events: 0, legacyMax: 0, shortAccounts: 0 };
  for (const [group, names] of Object.entries(fields)) for (const n of names) totals[group][n] = 0;
  for (const r of results || []) {
    accounts[r.status] = (accounts[r.status] || 0) + r.n;
    for (const [group, names] of Object.entries(fields)) for (const n of names) totals[group][n] += Number(r[`${group}_${n}`]) || 0;
    totals.movies += Number(r.movies) || 0;
    totals.events += Number(r.events) || 0;
    totals.legacyMax += Number(r.legacy_max) || 0;
    totals.shortAccounts += Number(r.short_accounts) || 0;
  }
  const { results: failed } = await env.DB.prepare(
    "SELECT account_id, last_error FROM jobs WHERE type = ? AND status = 'failed' ORDER BY updated_at DESC LIMIT 20"
  ).bind(ACTIVITY_BACKFILL_TYPE).all();
  const { results: short } = await env.DB.prepare(
    `SELECT account_id, json_extract(progress_json, '$.recon.short') AS short, json_extract(progress_json, '$.recon.legacyMax') AS legacy,
            json_extract(progress_json, '$.recon.samples') AS samples
     FROM jobs WHERE type = ? AND status = 'done' AND account_id IS NOT NULL AND json_extract(progress_json, '$.recon.short') > 0
     ORDER BY short DESC LIMIT 10`
  ).bind(ACTIVITY_BACKFILL_TYPE).all();
  const progress = run ? run.progress || {} : {};
  return {
    ok: true,
    run: run ? {
      phase: progress.phase || "not started", accountsTotal: progress.accountsTotal || 0, accountsDone: progress.accountsDone || 0,
      startedAt: progress.startedAt || null, updatedAt: progress.updatedAt || null, finishedAt: progress.finishedAt || null,
      lastError: run.last_error || null,
    } : { phase: "not started" },
    accounts,
    totals,
    failed: (failed || []).map((r) => ({ accountId: r.account_id, error: r.last_error })),
    short: (short || []).map((r) => {
      let samples = null;
      try {
        samples = typeof r.samples === "string" ? JSON.parse(r.samples) : r.samples;
      } catch {
        samples = null;
      }
      return { accountId: r.account_id, short: r.short, legacy: r.legacy, samples };
    }),
  };
}

async function handleActivityBackfillApi(request, env, url, path) {
  if (!path.startsWith("/admin/api/activity-backfill/")) return null;
  if (!(await isAdminRequest(request, env))) return json({ ok: false, error: "Not authorized." }, 401);
  if (!env || !env.DB) return json({ ok: false, error: "No D1 database binding 'DB'." }, 503);
  try {
    if (path === "/admin/api/activity-backfill/step" && request.method === "POST") {
      let body = {};
      try {
        body = await request.json();
      } catch {
        body = {};
      }
      const out = await runActivityBackfillStep(env, body || {});
      return json(out, out.ok || out.busy ? 200 : 409);
    }
    if (path === "/admin/api/activity-backfill/status" && request.method === "GET") {
      return json(await activityBackfillStatus(env));
    }
    return json({ ok: false, error: "Not found." }, 404);
  } catch (e) {
    console.error("Activity backfill failed:", e);
    const msg = safeErrorMessage(e);
    if (/no such table|no such column/i.test(msg)) return json({ ok: false, error: "Apply migrations 0016 (main database) and A0001 (activity database) first." }, 503);
    return json({ ok: false, error: msg }, 500);
  }
}
