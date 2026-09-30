
// --- Show schedules: show.refresh (Phase 5, P5-3) -------------------------------
//
// Continue Watching and Airing Next are worked out when read (39_activity-
// shelves.js) from each account's show_progress and one shared show_schedule
// row per show (migration 0017). This file keeps those rows current.
//
//   show.watchers (periodic, daily): counts, over every activity database,
//   how many accounts have each show in show_progress, and writes
//   show_schedule.watcher_count (making the row the first time, due at once).
//   recordActivityPlay (38_) adds one as plays arrive; this recount is what
//   fills the table after the history copy (P3c-3) and corrects any drift.
//
//   show.refresh (periodic, hourly): takes the shows that are due
//   (`next_check_at <= now AND watcher_count > 0`, at most
//   SHOW_REFRESH_SELECT_LIMIT, soonest first), holds them for
//   SHOW_REFRESH_HOLD_MS so the next run does not take them again, and hands
//   them out SHOW_REFRESH_BATCH at a time as `show.refresh-batch` jobs, or
//   refreshes them itself without the queue.
//
//   show.refresh-batch (plain job): one TMDB details call per show (plus a
//   `/find` when only its IMDb id is known), and TVmaze for the air time when
//   an episode is coming. It sets the row, and when to look again:
//     ended or cancelled                       14 days
//     an episode airs within a day             1 hour
//     otherwise                                6 hours
//     TMDB failed                              1 hour (404: 14 days)
//   It is safe to run twice: it only writes what TMDB said.
//
// Module level, after the Worker's exports, like 27_ onward.

const SHOW_REFRESH_SELECT_LIMIT = 500;
const SHOW_REFRESH_BATCH = 50;
const SHOW_REFRESH_HOLD_MS = 30 * 60 * 1000;
const SHOW_CHECK_ENDED_MS = 14 * 24 * 60 * 60 * 1000;
const SHOW_CHECK_AIR_DAY_MS = 60 * 60 * 1000;
const SHOW_CHECK_RETURNING_MS = 6 * 60 * 60 * 1000;
const SHOW_CHECK_RETRY_MS = 60 * 60 * 1000;
const SHOW_WATCHERS_CHUNK = 2000;

function showScheduleTmdbKey(env) {
  return (env && env.TMDB_API_KEY) || (typeof TMDB_API_KEY === "string" ? TMDB_API_KEY : "");
}

async function showTmdbGet(path, key) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`https://api.themoviedb.org/3${path}${sep}api_key=${encodeURIComponent(key)}`, {
    headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
  });
  if (res.status === 404) return { notFound: true };
  if (!res.ok) throw new Error(`TMDB answered ${res.status}`);
  return { data: await res.json() };
}

function showDayOffset(date, now) {
  if (!date) return null;
  const t = Date.parse(String(date).slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(t)) return null;
  return (t - Date.parse(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z")) / 86400000;
}

// TMDB's /tv/{id} answer (and TVmaze's air time) as a show_schedule row.
// Pure, so the tests can hold it to the shelves' reading of the columns.
function showScheduleFromTmdb(tv, airTime, now) {
  const last = tv && tv.last_episode_to_air;
  const next = tv && tv.next_episode_to_air;
  const counts = {};
  for (const s of (tv && Array.isArray(tv.seasons) ? tv.seasons : [])) {
    const n = Number(s && s.season_number);
    const c = Number(s && s.episode_count);
    if (Number.isInteger(n) && Number.isFinite(c) && c > 0) counts[n] = c;
  }
  const row = {
    status: (tv && tv.status) || "Unknown",
    last_aired_season: last ? Number(last.season_number) : null,
    last_aired_episode: last ? Number(last.episode_number) : null,
    last_aired_date: last && last.air_date ? String(last.air_date).slice(0, 10) : null,
    next_season: next ? Number(next.season_number) : null,
    next_episode: next ? Number(next.episode_number) : null,
    next_air_date: next && next.air_date ? String(next.air_date).slice(0, 10) : null,
    next_air_time: null,
    air_tz: null,
    season_finale_season: null,
    season_finale_date: null,
    season_finale_episode: null,
    season_episode_counts: Object.keys(counts).length ? JSON.stringify(counts) : null,
  };
  // The finale of the season now airing (or last aired): its last episode.
  const finaleSeason = row.next_season != null ? row.next_season : row.last_aired_season;
  if (finaleSeason != null && counts[finaleSeason]) {
    const fin = counts[finaleSeason];
    row.season_finale_season = finaleSeason;
    row.season_finale_episode = fin;
    if (row.next_season === finaleSeason && row.next_episode === fin) row.season_finale_date = row.next_air_date;
    else if (row.last_aired_season === finaleSeason && row.last_aired_episode === fin) row.season_finale_date = row.last_aired_date;
  }
  if (next && airTime) {
    const own = airTime.next && Number(airTime.next.season) === row.next_season && Number(airTime.next.number) === row.next_episode;
    row.next_air_time = (own && airTime.next.time) || airTime.time || null;
    row.air_tz = airTime.timezone || null;
  }
  const status = String(row.status).toLowerCase();
  const soon = showDayOffset(row.next_air_date, now);
  let wait;
  if (status === "ended" || status === "canceled" || status === "cancelled") wait = SHOW_CHECK_ENDED_MS;
  else if (soon != null && soon <= 1) wait = SHOW_CHECK_AIR_DAY_MS;
  else wait = SHOW_CHECK_RETURNING_MS;
  row.checked_at = now;
  row.next_check_at = now + wait;
  return row;
}

const SHOW_SCHEDULE_COLUMNS = [
  "status", "last_aired_season", "last_aired_episode", "last_aired_date", "next_season", "next_episode",
  "next_air_date", "next_air_time", "air_tz", "season_finale_season", "season_finale_date",
  "season_finale_episode", "season_episode_counts", "checked_at", "next_check_at",
];

// Refreshes the schedule rows of `mediaIds`. Returns counts. Throws only when
// D1 does (the job is then tried again).
async function refreshShowSchedules(env, mediaIds, { now = Date.now(), ctx = null } = {}) {
  const ids = [...new Set((mediaIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const out = { shows: ids.length, refreshed: 0, failed: 0, notFound: 0 };
  if (!ids.length || !env || !env.DB) return out;
  const key = showScheduleTmdbKey(env);
  const { results } = await env.DB.prepare(
    "SELECT id, kind, tmdb_id, imdb_id FROM media WHERE id IN (SELECT value FROM json_each(?))"
  ).bind(JSON.stringify(ids)).all();
  const writes = [];
  for (const m of results || []) {
    let row;
    try {
      if (!key) throw new Error("TMDB_API_KEY is not set");
      let tmdbId = m.tmdb_id;
      if (!tmdbId && m.imdb_id) {
        const found = await showTmdbGet(`/find/${encodeURIComponent(m.imdb_id)}?external_source=imdb_id`, key);
        const tv = found.data && Array.isArray(found.data.tv_results) ? found.data.tv_results[0] : null;
        tmdbId = tv ? tv.id : null;
      }
      const got = tmdbId ? await showTmdbGet(`/tv/${Number(tmdbId)}`, key) : { notFound: true };
      if (got.notFound) {
        out.notFound++;
        writes.push(env.DB.prepare("UPDATE show_schedule SET status = COALESCE(status, 'Unknown'), checked_at = ?, next_check_at = ? WHERE media_id = ?")
          .bind(now, now + SHOW_CHECK_ENDED_MS, m.id));
        continue;
      }
      const tv = got.data;
      let airTime = null;
      if (tv && tv.next_episode_to_air && m.imdb_id && typeof fetchShowAirTime === "function") {
        try {
          airTime = await fetchShowAirTime(m.imdb_id, env, ctx);
        } catch {
          airTime = null;
        }
      }
      row = showScheduleFromTmdb(tv, airTime, now);
    } catch (err) {
      out.failed++;
      console.warn(`[Jobs] show.refresh: media ${m.id}: ${jobErrorText(err)}`);
      writes.push(env.DB.prepare("UPDATE show_schedule SET next_check_at = ? WHERE media_id = ?").bind(now + SHOW_CHECK_RETRY_MS, m.id));
      continue;
    }
    out.refreshed++;
    writes.push(env.DB.prepare(
      `UPDATE show_schedule SET ${SHOW_SCHEDULE_COLUMNS.map((c) => `${c} = ?`).join(", ")} WHERE media_id = ?`
    ).bind(...SHOW_SCHEDULE_COLUMNS.map((c) => row[c]), m.id));
  }
  for (let i = 0; i < writes.length; i += 50) await env.DB.batch(writes.slice(i, i + 50));
  return out;
}

// Takes the due shows and holds them. Returns their ids.
async function takeDueShows(env, now) {
  const { results } = await env.DB.prepare(
    "SELECT media_id FROM show_schedule WHERE next_check_at <= ? AND watcher_count > 0 ORDER BY next_check_at LIMIT ?"
  ).bind(now, SHOW_REFRESH_SELECT_LIMIT).all();
  const ids = (results || []).map((r) => r.media_id);
  if (ids.length) {
    await env.DB.prepare(
      "UPDATE show_schedule SET next_check_at = ? WHERE media_id IN (SELECT value FROM json_each(?)) AND next_check_at <= ?"
    ).bind(now + SHOW_REFRESH_HOLD_MS, JSON.stringify(ids), now).run();
  }
  return ids;
}

async function runShowRefresh(env, job = {}, { now = Date.now() } = {}) {
  if (!env || !env.DB) return { shows: 0 };
  let ids;
  try {
    ids = await takeDueShows(env, now);
  } catch (err) {
    if (/no such table/i.test(jobErrorText(err))) return { shows: 0, reason: "no 0017" };
    throw err;
  }
  const batches = [];
  for (let i = 0; i < ids.length; i += SHOW_REFRESH_BATCH) batches.push(ids.slice(i, i + SHOW_REFRESH_BATCH));
  if (batches.length && jobsQueueBound(env)) {
    const sent = await enqueueJobs(env, batches.map((b) => ({ type: "show.refresh-batch", payload: { mediaIds: b } })));
    if (sent.ok) return { shows: ids.length, batches: batches.length, queued: true };
    console.warn(`[Jobs] show.refresh: ${sent.failed} batches not sent (${sent.reason}); refreshing here.`);
  }
  const total = { shows: ids.length, batches: batches.length, refreshed: 0, failed: 0, notFound: 0 };
  for (const b of batches) {
    const r = await refreshShowSchedules(env, b, { now, ctx: job.ctx });
    total.refreshed += r.refreshed;
    total.failed += r.failed;
    total.notFound += r.notFound;
  }
  return total;
}

// Recounts show watchers over every activity database.
async function recountShowWatchers(env, { now = Date.now() } = {}) {
  const dbs = typeof activityDbs === "function" ? activityDbs(env) : [];
  if (!env || !env.DB || !dbs.length) return { shows: 0, reason: "no activity database" };
  const counts = new Map();
  for (const db of dbs) {
    if (!db) continue;
    const { results } = await db.prepare(
      "SELECT media_id, count(*) AS n FROM show_progress WHERE last_season IS NOT NULL OR status = 'completed' GROUP BY media_id"
    ).all();
    for (const r of results || []) counts.set(r.media_id, (counts.get(r.media_id) || 0) + Number(r.n));
  }
  const entries = [...counts.entries()];
  const writes = [];
  for (let i = 0; i < entries.length; i += SHOW_WATCHERS_CHUNK) {
    const part = entries.slice(i, i + SHOW_WATCHERS_CHUNK).map(([id, n]) => ({ id, n }));
    // Series only, and only titles the main database has (a stale id would
    // break the foreign key).
    writes.push(env.DB.prepare(
      `INSERT INTO show_schedule (media_id, watcher_count, next_check_at)
       SELECT m.id, json_extract(j.value, '$.n'), 0 FROM json_each(?) j JOIN media m ON m.id = json_extract(j.value, '$.id') AND m.kind = 'series'
       WHERE true
       ON CONFLICT (media_id) DO UPDATE SET watcher_count = excluded.watcher_count`
    ).bind(JSON.stringify(part)));
  }
  writes.push(env.DB.prepare(
    "UPDATE show_schedule SET watcher_count = 0 WHERE watcher_count > 0 AND media_id NOT IN (SELECT value FROM json_each(?))"
  ).bind(JSON.stringify(entries.map(([id]) => id))));
  await env.DB.batch(writes);
  return { shows: entries.length, at: now };
}

definePeriodicJob("show.watchers", {
  everyMs: 24 * 60 * 60 * 1000,
  run: async (env) => {
    try {
      return await recountShowWatchers(env);
    } catch (err) {
      if (/no such table/i.test(jobErrorText(err))) return { shows: 0, reason: "no 0017 or A0001" };
      throw err;
    }
  },
});

definePeriodicJob("show.refresh", {
  everyMs: 60 * 60 * 1000,
  run: (env, payload, job) => runShowRefresh(env, job),
});

defineJobType("show.refresh-batch", {
  run: (env, payload, job) => refreshShowSchedules(env, Array.isArray(payload.mediaIds) ? payload.mediaIds : [], { ctx: job.ctx }),
});
