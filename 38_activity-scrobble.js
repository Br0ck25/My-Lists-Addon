
// --- Recording a play in the activity database (Phase 3c, P3c-4) --------------
//
// One play -- the subtitles ping (Stremio, Nuvio), a media-server webhook
// (Plex, Jellyfin, Emby) -- becomes, on the account's activity database
// (36_activity-db.js), in one batch:
//   1. a watch_events row, skipped when the same title and episode was
//      recorded within ten minutes either side (activityDedupeKey);
//   2. for an episode, its show_progress row (made if new; moved on only
//      when this episode is further than the furthest one watched);
//      for a movie, its user_media_state row (one more play);
// and, the first time an account watches a show, one more watcher on the
// show's show_schedule row in the main database. That is at most four
// writes; finding the title's media row is a read (plus an insert the first
// time a title is ever seen, 29_media.js).
//
// Until P3c-6 the legacy tracking store stays the one people see: the play
// routes write it exactly as before, then call this. Nothing here can fail
// them -- every error is logged and swallowed. Nothing is written to KV.
// Without the activity database (or before A0001 is applied), or before the
// copy of the account's history (P3c-3) exists at all, it does nothing: the
// copy picks the play up from the legacy store. A play recorded here and
// then copied is one row (the ten-minute rule).
//
// The web page's "mark watched" reaches the server only as a whole tracking
// record (save-tracking); its plays are taken from there by the P3c-6 shim.

const ACTIVITY_SOURCES = new Set(["ping", "webhook", "web"]);

async function activityAccountId(env, username) {
  if (!env.DB || !username) return null;
  const row = await env.DB.prepare("SELECT id FROM accounts WHERE username = ? COLLATE NOCASE AND deleted_at IS NULL").bind(String(username)).first();
  return row ? row.id : null;
}

// The play a legacy history entry describes (the entry the play routes just
// put first in Watch History), in the form recordActivityPlay takes.
function activityPlayFromLegacyEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const play = legacyHistoryPlay(entry, Date.now());
  return { ref: play.ref, season: play.season, episode: play.episode, watchedAt: play.watchedAt };
}

// The statements for one play, given its media id. Exposed for the tests
// that count them.
function activityPlayStatements(actDb, accountId, mediaId, play, source, now) {
  const { season, episode, watchedAt } = play;
  const stmts = [
    actDb.prepare(
      `INSERT OR IGNORE INTO watch_events (account_id, media_id, season, episode, watched_at, source, dedupe_key)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM watch_events w WHERE w.account_id = ? AND w.media_id = ? AND w.season IS ? AND w.episode IS ?
                           AND w.watched_at > ? AND w.watched_at < ?)`
    ).bind(accountId, mediaId, season, episode, watchedAt, source, activityDedupeKey(accountId, mediaId, season, episode, watchedAt),
      accountId, mediaId, season, episode, watchedAt - ACTIVITY_DEDUPE_WINDOW_MS, watchedAt + ACTIVITY_DEDUPE_WINDOW_MS),
  ];
  if (season != null && episode != null) {
    stmts.push(actDb.prepare(
      `INSERT INTO show_progress (account_id, media_id, last_season, last_episode, last_watched_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, media_id) DO UPDATE SET
         last_season = CASE WHEN show_progress.last_season IS NULL OR excluded.last_season > show_progress.last_season
                              OR (excluded.last_season = show_progress.last_season AND excluded.last_episode > COALESCE(show_progress.last_episode, -1))
                            THEN excluded.last_season ELSE show_progress.last_season END,
         last_episode = CASE WHEN show_progress.last_season IS NULL OR excluded.last_season > show_progress.last_season
                               OR (excluded.last_season = show_progress.last_season AND excluded.last_episode > COALESCE(show_progress.last_episode, -1))
                             THEN excluded.last_episode ELSE show_progress.last_episode END,
         last_watched_at = max(COALESCE(show_progress.last_watched_at, 0), excluded.last_watched_at),
         updated_at = excluded.updated_at`
    ).bind(accountId, mediaId, season, episode, watchedAt, now));
  } else {
    stmts.push(actDb.prepare(
      `INSERT INTO user_media_state (account_id, media_id, watched_count, last_watched_at)
       SELECT ?, ?, 1, ? WHERE changes() > 0
       ON CONFLICT (account_id, media_id) DO UPDATE SET
         watched_count = user_media_state.watched_count + 1,
         last_watched_at = max(COALESCE(user_media_state.last_watched_at, 0), excluded.last_watched_at)`
    ).bind(accountId, mediaId, watchedAt));
  }
  return stmts;
}

// Records one play. Returns { recorded, reason } -- never throws.
async function recordActivityPlay(env, username, play, source) {
  try {
    if (!env || !env.DB || !env.DB_ACTIVITY || !play || !play.ref) return { recorded: false, reason: "unbound" };
    const src = ACTIVITY_SOURCES.has(source) ? source : "ping";
    const accountId = await activityAccountId(env, username);
    if (accountId == null) return { recorded: false, reason: "no account" };
    const actDb = activityDb(env, accountId);
    if (!(await activitySchemaReady(actDb))) return { recorded: false, reason: "no schema" };
    // Before the account's history is copied, the copy will bring this play.
    const job = await env.DB.prepare("SELECT status FROM jobs WHERE dedupe_key = ?").bind(`${ACTIVITY_BACKFILL_TYPE}:acct:${accountId}`).first();
    if (!job || job.status !== "done") return { recorded: false, reason: "not copied yet" };

    const { ids } = await resolveMediaBatch(env, [play.ref], { maxLookups: 1 });
    const mediaId = ids[0];
    if (mediaId == null) return { recorded: false, reason: "no usable id" };
    const watchedAt = Number(play.watchedAt) || Date.now();
    const p = { season: play.season == null ? null : Number(play.season), episode: play.episode == null ? null : Number(play.episode), watchedAt };
    const isEpisode = p.season != null && p.episode != null;
    const now = Date.now();

    // Whether this is the account's first play of the show, for the schedule.
    const known = isEpisode
      ? await actDb.prepare("SELECT 1 AS x FROM show_progress WHERE account_id = ? AND media_id = ?").bind(accountId, mediaId).first()
      : true;
    const out = await actDb.batch(activityPlayStatements(actDb, accountId, mediaId, p, src, now));
    const inserted = Number(out && out[0] && out[0].meta && out[0].meta.changes) > 0;
    if (!known) {
      try {
        await env.DB.prepare(
          `INSERT INTO show_schedule (media_id, watcher_count, next_check_at) VALUES (?, 1, 0)
           ON CONFLICT (media_id) DO UPDATE SET watcher_count = show_schedule.watcher_count + 1`
        ).bind(mediaId).run();
      } catch (e) {
        // 0017 not applied: the schedule job (Phase 5) recounts anyway.
        if (!/no such table/i.test(String((e && e.message) || e))) console.error("activity: watcher count failed", e);
      }
    }
    try {
      if (env.ANALYTICS && typeof env.ANALYTICS.writeDataPoint === "function") {
        env.ANALYTICS.writeDataPoint({ blobs: ["play", src, isEpisode ? "episode" : "movie"], doubles: [inserted ? 1 : 0, mediaId], indexes: ["play"] });
      }
    } catch {}
    return { recorded: inserted, reason: inserted ? "ok" : "duplicate", mediaId, accountId };
  } catch (e) {
    console.error("activity: recording a play failed", e);
    return { recorded: false, reason: "error" };
  }
}
