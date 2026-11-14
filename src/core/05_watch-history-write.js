// Watch History rows for the older (non-activity-database) tracking write,
// writeCreatorTrackingD1 in 02_http-and-creator-utils.js.
//
// PERF-02: that write used to upsert EVERY history entry on every save, so one
// play cost one row write per play the account ever had. The stored rows are
// read in one statement and only entries that are new or differ are written.
// Up to WATCH_HISTORY_DIFF_MIN entries (one write batch) the read is skipped:
// writing that many rows costs less than the extra round trip, and every
// scrobble pays that round trip (tests/load-performance.test.mjs counts it).

const WATCH_HISTORY_DIFF_MIN = 80;

const WATCH_HISTORY_PRINT_SQL = "SELECT item_id, item_type, title, poster, show_id, show_title, show_poster, season_num, episode_num, year, air_date, watched_at FROM watch_history WHERE username = ?";

function watchHistoryPrint(r) {
  return JSON.stringify([r.item_type, r.title, r.poster, r.show_id, r.show_title, r.show_poster, r.season_num, r.episode_num, r.year, r.air_date, r.watched_at]);
}

// item_id -> fingerprint of what is stored. null (read failed) means "write everything".
async function storedWatchHistoryPrints(env, username) {
  try {
    const res = await env.DB.prepare(WATCH_HISTORY_PRINT_SQL).bind(username).all();
    return new Map((res.results || []).map((r) => [r.item_id, watchHistoryPrint(r)]));
  } catch (_) { return null; }
}

async function pushWatchHistoryWrites(env, username, watchHistory, fallbackStamp, isIntentionalRemoval, stmts, prunes) {
  const stored = watchHistory.length > WATCH_HISTORY_DIFF_MIN ? await storedWatchHistoryPrints(env, username) : null;
  const whSeen = new Set();
  for (const item of watchHistory) {
    if (!item) continue;
    const itemId = String(item.id || (item.showId ? `${item.showId}:${item.seasonNum}:${item.episodeNum}` : ""));
    if (!itemId || whSeen.has(itemId)) continue;
    whSeen.add(itemId);
    const row = {
      item_id: itemId,
      item_type: item.type || (item.seasonNum != null ? "episode" : "movie"),
      title: item.name || item.title || null,
      poster: item.poster || null,
      show_id: item.showId ? String(item.showId) : null,
      show_title: item.showTitle || null,
      show_poster: item.showPoster || null,
      season_num: item.seasonNum != null ? Number(item.seasonNum) : null,
      episode_num: item.episodeNum != null ? Number(item.episodeNum) : null,
      year: item.year ? String(item.year) : null,
      air_date: item.airDate ? String(item.airDate) : null,
      watched_at: Number(item.watchedAt) || fallbackStamp,
    };
    if (stored && stored.get(itemId) === watchHistoryPrint(row)) continue;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO watch_history (
          username, item_id, item_type, title, poster, show_id, show_title,
          show_poster, season_num, episode_num, year, air_date, watched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(username, item_id) DO UPDATE SET
          item_type = excluded.item_type,
          title = excluded.title,
          poster = excluded.poster,
          show_id = excluded.show_id,
          show_title = excluded.show_title,
          show_poster = excluded.show_poster,
          season_num = excluded.season_num,
          episode_num = excluded.episode_num,
          year = excluded.year,
          air_date = excluded.air_date,
          watched_at = excluded.watched_at`
      ).bind(
        username, itemId, row.item_type, row.title, row.poster, row.show_id, row.show_title,
        row.show_poster, row.season_num, row.episode_num, row.year, row.air_date, row.watched_at
      )
    );
  }
  // Only an INTENTIONAL removal shortens Watch History -- an ordinary
  // autosave is additive, and the rescue-merge in save-tracking exists
  // precisely so a stale push cannot shorten it by accident.
  if (isIntentionalRemoval) {
    prunes.push(...await d1ReplaceRowsById(env, "watch_history", username, "item_id", whSeen));
  }
}
