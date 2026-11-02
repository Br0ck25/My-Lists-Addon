
// --- More background jobs (Phase 5, P5-10) ---------------------------------------
//
//   channel.presets (periodic, daily; with the queue) sends one
//   `channel.pool.build` job per Quick Add network, which rebuilds that
//   network's preset (buildNetworkChannelPreset). It replaces the cron's
//   one-network-per-tick rotation (cron.channel-presets), which rebuilt every
//   network about every three hours. Without the queue the cron keeps doing
//   that, as before.
//
//   nos.sweep is the New on Streaming sweep (sweepNewOnStreaming, then
//   bumpNewOnStreamingEpisodes), every tick as before (the old
//   cron.new-on-streaming). Its RapidAPI monthly quota ledger moved from the
//   KV key cron:rapidapi:usage to a `jobs` row (rapidApiLedgerD1, below), where
//   adding to it is one atomic statement rather than a read and a write two
//   overlapping sweeps could both base on the same count.
//
//   recs.build (periodic, hourly) finds accounts that watched something since
//   their recommendations were last built (50 a run) and sends a
//   `recs.build-account` job for each: seeds from the account's latest shows
//   and movies (activity database), buildTmdbRecommendations (the same code as
//   the website's Discover shelves), titles recorded in `media`, and the
//   account's `account_recommendations` rows replaced.
//
//   rollup.daily (periodic, daily) fills `title_daily_stats` (event_type
//   'play') for each day since the last one rolled up, up to a week at a
//   time: plays per title from watch_events over every activity database, the
//   top TITLE_DAILY_TOP titles a day. Days older than TITLE_DAILY_KEEP_DAYS go.
//
// recs.build and rollup.daily only write: the Recommended rows and Most
// Watched keep reading what they read today until the reads move to the
// activity database.
//
// Module level, after the Worker's exports, like 27_ onward.

const RECS_BUILD_ACCOUNTS = 50;
const RECS_SEEDS = 12;
const TITLE_DAILY_TOP = 2000;
const TITLE_DAILY_KEEP_DAYS = 400;
const ROLLUP_DAYS_PER_RUN = 7;
const DAY_MS = 86400000;

// --- channel.presets / channel.pool.build -----------------------------------------

async function runChannelPresets(env, job = {}) {
  const networks = CHANNEL_PRESET_NETWORKS || [];
  if (!networks.length) return { networks: 0 };
  if (jobsQueueBound(env)) {
    const sent = await enqueueJobs(env, networks.map((n) => ({ type: "channel.pool.build", payload: { networkId: n.id } })));
    if (sent.ok) return { networks: networks.length, queued: true };
  }
  let built = 0;
  for (const n of networks) {
    const r = await buildNetworkChannelPreset(n.id, n.name, CHANNEL_PRESET_PREWARM_ORIGIN, { env, ctx: job.ctx, forceRebuild: true });
    if (r && r.ok) built++;
  }
  return { networks: networks.length, built };
}

async function runChannelPoolBuild(env, payload, job) {
  const net = (CHANNEL_PRESET_NETWORKS || []).find((n) => String(n.id) === String(payload.networkId));
  if (!net) return { skipped: "unknown network" };
  const r = await buildNetworkChannelPreset(net.id, net.name, CHANNEL_PRESET_PREWARM_ORIGIN, { env, ctx: job.ctx, forceRebuild: true });
  if (!r || !r.ok) throw new Error(`Could not build the ${net.name} preset${r && r.error ? `: ${r.error}` : ""}`);
  return { built: net.name };
}

definePeriodicJob("channel.presets", {
  everyMs: DAY_MS,
  // With the queue only; without it the cron's rotation does this.
  legacy: true,
  run: (env, payload, job) => runChannelPresets(env, job),
});

defineJobType("channel.pool.build", {
  retryDelaySec: 300,
  run: (env, payload, job) => runChannelPoolBuild(env, payload, job),
});

// --- The RapidAPI quota ledger, in D1 ---------------------------------------------

const RAPIDAPI_LEDGER_KEY = "ledger:rapidapi";

// { month, count, lastAt } from D1, adding `add` first when given. Null when
// D1 cannot be used (the caller keeps the KV ledger). The first read seeds
// the row from the KV ledger, so switching over never forgets this month's
// spending.
async function rapidApiLedgerD1(env, add = 0) {
  if (!env || !env.DB) return null;
  const month = new Date().toISOString().slice(0, 7);
  const now = Date.now();
  try {
    let row = await env.DB.prepare("SELECT progress_json FROM jobs WHERE dedupe_key = ?").bind(RAPIDAPI_LEDGER_KEY).first();
    if (!row) {
      let seed = { month, count: 0, lastAt: null };
      if (env.CONFIGS) {
        try {
          const kv = JSON.parse((await env.CONFIGS.get("cron:rapidapi:usage")) || "null");
          if (kv && kv.month === month && Number.isFinite(kv.count)) seed = { month, count: Math.max(0, Math.floor(kv.count)), lastAt: kv.lastAt || null };
        } catch {}
      }
      await env.DB.prepare(
        "INSERT INTO jobs (type, dedupe_key, status, run_after, progress_json, created_at, updated_at) VALUES ('ledger.rapidapi', ?, 'done', 0, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING"
      ).bind(RAPIDAPI_LEDGER_KEY, JSON.stringify(seed), now, now).run();
    }
    if (add > 0) {
      await env.DB.prepare(
        `UPDATE jobs SET progress_json = json_object(
           'month', ?,
           'count', (CASE WHEN json_extract(progress_json, '$.month') = ? THEN COALESCE(json_extract(progress_json, '$.count'), 0) ELSE 0 END) + ?,
           'lastAt', ?), updated_at = ?
         WHERE dedupe_key = ?`
      ).bind(month, month, Math.floor(add), Math.floor(now / 1000), now, RAPIDAPI_LEDGER_KEY).run();
    }
    row = await env.DB.prepare("SELECT progress_json FROM jobs WHERE dedupe_key = ?").bind(RAPIDAPI_LEDGER_KEY).first();
    const p = parseJobProgress(row && row.progress_json);
    return { month, count: p.month === month ? Math.max(0, Math.floor(Number(p.count) || 0)) : 0, lastAt: p.month === month ? p.lastAt || null : null };
  } catch (err) {
    if (!/no such table/i.test(jobErrorText(err))) console.warn("[Jobs] RapidAPI ledger in D1 unavailable; using KV:", jobErrorText(err));
    return null;
  }
}

// --- recs.build ----------------------------------------------------------------------

// Accounts with activity since their recommendations were built. { accountId }[].
async function accountsDueForRecs(env, limit) {
  const built = new Map();
  try {
    const { results } = await env.DB.prepare("SELECT account_id, max(built_at) AS at FROM account_recommendations GROUP BY account_id").all();
    for (const r of results || []) built.set(r.account_id, Number(r.at) || 0);
  } catch (err) {
    if (/no such table/i.test(jobErrorText(err))) return [];
    throw err;
  }
  const latest = new Map();
  for (const db of activityDbs(env)) {
    if (!db) continue;
    const { results } = await db.prepare(
      `SELECT account_id, max(t) AS at FROM (
         SELECT account_id, max(last_watched_at) AS t FROM show_progress GROUP BY account_id
         UNION ALL SELECT account_id, max(last_watched_at) AS t FROM user_media_state GROUP BY account_id
       ) GROUP BY account_id`
    ).all();
    for (const r of results || []) latest.set(r.account_id, Math.max(latest.get(r.account_id) || 0, Number(r.at) || 0));
  }
  const due = [];
  for (const [accountId, at] of latest) {
    if (at > (built.get(accountId) || 0)) due.push({ accountId, at });
  }
  due.sort((a, b) => b.at - a.at);
  return due.slice(0, limit);
}

async function runRecsBuild(env, job = {}) {
  if (!env || !env.DB || !activityDbs(env).length) return { accounts: 0 };
  const due = await accountsDueForRecs(env, RECS_BUILD_ACCOUNTS);
  if (due.length && jobsQueueBound(env)) {
    const sent = await enqueueJobs(env, due.map((d) => ({ type: "recs.build-account", payload: { accountId: d.accountId } })));
    if (sent.ok) return { accounts: due.length, queued: true };
  }
  let built = 0;
  for (const d of due) {
    const r = await buildAccountRecommendations(env, d.accountId);
    if (r.built) built++;
  }
  return { accounts: due.length, built };
}

// Records titles in `media` (by TMDB id) and returns kind:tmdbId -> media id.
async function recordRecommendedMedia(env, items, now) {
  const rows = items.map((it) => ({ kind: it.type === "series" ? "series" : "movie", tmdb: Number(it.tmdbId), title: it.name || null, year: Number(String(it.year || "").slice(0, 4)) || null }))
    .filter((r) => r.tmdb > 0);
  const out = new Map();
  for (let i = 0; i < rows.length; i += 200) {
    const part = rows.slice(i, i + 200);
    await env.DB.prepare(
      `INSERT INTO media (kind, tmdb_id, title, year, created_at, updated_at)
       SELECT json_extract(value, '$.kind'), json_extract(value, '$.tmdb'), json_extract(value, '$.title'), json_extract(value, '$.year'), ?, ?
       FROM json_each(?) WHERE true
       ON CONFLICT(kind, tmdb_id) WHERE tmdb_id IS NOT NULL DO NOTHING`
    ).bind(now, now, JSON.stringify(part)).run();
    const { results } = await env.DB.prepare(
      "SELECT id, kind, tmdb_id FROM media WHERE tmdb_id IN (SELECT json_extract(value, '$.tmdb') FROM json_each(?))"
    ).bind(JSON.stringify(part)).all();
    for (const r of results || []) out.set(`${r.kind}:${r.tmdb_id}`, r.id);
  }
  return out;
}

async function buildAccountRecommendations(env, accountId) {
  const key = showScheduleTmdbKey(env);
  const actDb = activityDb(env, accountId);
  if (!key || !actDb) return { built: false, reason: key ? "no activity database" : "no TMDB key" };
  const [shows, movies] = await Promise.all([
    actDb.prepare("SELECT media_id FROM show_progress WHERE account_id = ? AND last_watched_at IS NOT NULL ORDER BY last_watched_at DESC LIMIT ?").bind(accountId, RECS_SEEDS).all(),
    actDb.prepare("SELECT media_id FROM user_media_state WHERE account_id = ? AND last_watched_at IS NOT NULL ORDER BY last_watched_at DESC LIMIT ?").bind(accountId, RECS_SEEDS).all(),
  ]);
  const seedIds = [...(shows.results || []), ...(movies.results || [])].map((r) => r.media_id);
  if (!seedIds.length) return { built: false, reason: "nothing watched" };
  const { results: seedMedia } = await env.DB.prepare(
    "SELECT id, kind, tmdb_id, imdb_id FROM media WHERE id IN (SELECT value FROM json_each(?))"
  ).bind(JSON.stringify(seedIds)).all();
  const seed = (kind) => (seedMedia || []).filter((m) => m.kind === kind).map((m) => (m.tmdb_id ? String(m.tmdb_id) : m.imdb_id)).filter(Boolean);
  const recs = await buildTmdbRecommendations(seed("movie"), seed("series"), key);
  const now = Date.now();
  const all = [...recs.movies, ...recs.shows];
  const ids = await recordRecommendedMedia(env, all, now);
  const stmts = [env.DB.prepare("DELETE FROM account_recommendations WHERE account_id = ?").bind(accountId)];
  for (const [kind, list] of [["movie", recs.movies], ["series", recs.shows]]) {
    let rank = 0;
    for (const it of list) {
      const mediaId = ids.get(`${kind}:${Number(it.tmdbId)}`);
      if (mediaId == null) continue;
      stmts.push(env.DB.prepare(
        "INSERT OR IGNORE INTO account_recommendations (account_id, kind, rank, media_id, built_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(accountId, kind, ++rank, mediaId, now));
    }
  }
  for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
  return { built: true, movies: recs.movies.length, shows: recs.shows.length };
}

definePeriodicJob("recs.build", {
  everyMs: 60 * 60 * 1000,
  run: (env, payload, job) => runRecsBuild(env, job),
});

defineJobType("recs.build-account", {
  run: async (env, payload) => {
    try {
      return await buildAccountRecommendations(env, Number(payload.accountId));
    } catch (err) {
      if (/no such table/i.test(jobErrorText(err))) return { built: false, reason: "no 0017" };
      throw err;
    }
  },
});

// --- rollup.daily --------------------------------------------------------------------

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Plays per title on one UTC day, over every activity database, top first.
async function rollupDay(env, day) {
  const start = Date.parse(day + "T00:00:00Z");
  const end = start + DAY_MS;
  const counts = new Map();
  for (const db of activityDbs(env)) {
    if (!db) continue;
    const { results } = await db.prepare(
      "SELECT media_id, count(*) AS n FROM watch_events WHERE watched_at >= ? AND watched_at < ? GROUP BY media_id ORDER BY n DESC LIMIT ?"
    ).bind(start, end, TITLE_DAILY_TOP).all();
    for (const r of results || []) counts.set(r.media_id, (counts.get(r.media_id) || 0) + Number(r.n));
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, TITLE_DAILY_TOP).map(([id, n]) => ({ id, n }));
  const stmts = [env.DB.prepare("DELETE FROM title_daily_stats WHERE day = ? AND event_type = 'play'").bind(day)];
  for (let i = 0; i < top.length; i += 500) {
    stmts.push(env.DB.prepare(
      `INSERT INTO title_daily_stats (day, event_type, media_id, n)
       SELECT ?, 'play', m.id, json_extract(j.value, '$.n') FROM json_each(?) j JOIN media m ON m.id = json_extract(j.value, '$.id') WHERE true
       ON CONFLICT(day, event_type, media_id) DO UPDATE SET n = excluded.n`
    ).bind(day, JSON.stringify(top.slice(i, i + 500))));
  }
  await env.DB.batch(stmts);
  return top.length;
}

async function runRollupDaily(env, job = {}, { now = Date.now() } = {}) {
  const progress = { ...(job.progress || {}) };
  if (!env || !env.DB || !activityDbs(env).length) return { progress };
  const yesterday = utcDay(now - DAY_MS);
  // From the day after the last one done, or yesterday on the first run.
  let day = progress.lastDay ? utcDay(Date.parse(progress.lastDay + "T00:00:00Z") + DAY_MS) : yesterday;
  const days = [];
  while (day <= yesterday && days.length < ROLLUP_DAYS_PER_RUN) {
    try {
      days.push({ day, titles: await rollupDay(env, day) });
    } catch (err) {
      if (/no such table/i.test(jobErrorText(err))) return { progress };
      throw err;
    }
    progress.lastDay = day;
    day = utcDay(Date.parse(day + "T00:00:00Z") + DAY_MS);
  }
  await env.DB.prepare("DELETE FROM title_daily_stats WHERE day < ?").bind(utcDay(now - TITLE_DAILY_KEEP_DAYS * DAY_MS)).run();
  return { progress: { ...progress, lastRun: days } };
}

definePeriodicJob("rollup.daily", {
  everyMs: DAY_MS,
  run: (env, payload, job) => runRollupDaily(env, job),
});
