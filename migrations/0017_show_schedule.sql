-- 0017_show_schedule.sql
--
-- Phase 3c groundwork (P3c-2): the shared, per-show and per-title tables
-- that go with the activity database. See MIGRATION_PLAN.md section 3c and
-- NEXT_VERSION_ARCHITECTURE.md sections 4.3, 4.6 and 5.
--
-- These live in the MAIN database (my-lists-db), not in mylists-activity:
-- a show schedule and a daily title count are shared by every account, and
-- recommendations point at media rows, which are here.
--
-- Nothing reads or writes these tables yet. Running this changes nothing a
-- visitor can see, and no existing table or row is touched.
--
-- Safe to run against a live database, and safe to run twice.
--
-- Comments in this file avoid semicolons and apostrophes on purpose, so the
-- file can be pasted into the D1 dashboard Console as it is.

-- One row per show anybody is watching: its last aired and next episode, as
-- TMDB (and TVmaze for the air time) last reported them. Continue Watching
-- and Airing Next are worked out when read, from this and show_progress in
-- the activity database, instead of being stored per account.
-- Dates are YYYY-MM-DD. next_air_time is HH:MM in air_tz (an IANA zone).
-- status is the TMDB status as given (Returning Series, Ended and the like).
-- season_finale_* is the finale of the season now airing (or last aired).
-- season_episode_counts is a JSON object of season number to episode count,
-- so the episode after the last one watched can be named across a season
-- boundary without asking TMDB.
-- watcher_count is how many accounts have the show in show_progress. A show
-- nobody watches is not refreshed, and next_check_at says when it is due.
CREATE TABLE IF NOT EXISTS show_schedule (
    media_id              INTEGER PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
    status                TEXT,
    last_aired_season     INTEGER,
    last_aired_episode    INTEGER,
    last_aired_date       TEXT,
    next_season           INTEGER,
    next_episode          INTEGER,
    next_air_date         TEXT,
    next_air_time         TEXT,
    air_tz                TEXT,
    season_finale_season  INTEGER,
    season_finale_date    TEXT,
    season_finale_episode INTEGER,
    season_episode_counts TEXT,
    watcher_count         INTEGER NOT NULL DEFAULT 0,
    checked_at            INTEGER,
    next_check_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_show_schedule_due ON show_schedule(next_check_at) WHERE watcher_count > 0;

-- An account recommendations shelf, rebuilt whole by a job when the account
-- watches something (Phase 5). kind is movie or series, one shelf each.
-- Replaces the curatedRecommendations snapshot in the tracking blob.
CREATE TABLE IF NOT EXISTS account_recommendations (
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('movie', 'series')),
    rank       INTEGER NOT NULL,
    media_id   INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    built_at   INTEGER NOT NULL,
    PRIMARY KEY (account_id, kind, rank)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_account_recs_media ON account_recommendations(media_id);

-- How many times each title was watched (or otherwise counted) each day, for
-- Most Watched. day is the Eastern calendar day, YYYY-MM-DD, the same day
-- the stats table uses. Only the top titles of each day are kept.
CREATE TABLE IF NOT EXISTS title_daily_stats (
    day        TEXT NOT NULL,
    event_type TEXT NOT NULL,
    media_id   INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    n          INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, event_type, media_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_title_daily_stats_top ON title_daily_stats(event_type, day, n DESC);
CREATE INDEX IF NOT EXISTS idx_title_daily_stats_media ON title_daily_stats(media_id);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
  VALUES ('0017', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
