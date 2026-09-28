-- schema_activity.sql
--
-- The whole schema of the mylists-activity database (DB_ACTIVITY), for a
-- fresh database. Kept identical to running migrations/activity/ in order
-- (a test checks). Today that is A0001 alone.
--
--
-- Phase 3c groundwork: watch history and show progress in their own D1
-- database, mylists-activity, bound to the Worker as DB_ACTIVITY.
-- See MIGRATION_PLAN.md section 3c and NEXT_VERSION_ARCHITECTURE.md
-- sections 3.4 and 4.3.
--
-- Run this in the Console of the mylists-activity database, NOT in the main
-- database. The main database keeps its own numbered migrations (0001 to
-- 0016 so far). This one carries an A prefix so the two never mix.
--
-- Nothing reads or writes these tables yet. Running this changes nothing a
-- visitor can see. Safe to run twice.
--
-- media_id is media.id in the main database. There is no foreign key: the
-- two are separate databases.
--
-- Comments in this file avoid semicolons and apostrophes on purpose, so the
-- file can be pasted into the D1 dashboard Console as it is.

-- Every play, one row. dedupe_key is account, media, season, episode and
-- the watch time rounded down to 10 minutes, so the same play reported
-- twice (the subtitles ping and the webhook, or a retry) is stored once.
-- season and episode are NULL for a movie.
-- source says where the play came from: ping, webhook, web, migrated,
-- trakt, simkl, mdblist.
-- legacy_id is the id the old Watch History knew the play by (a TMDB episode
-- id, an IMDb id), so the website keeps recognising its own entries.
CREATE TABLE IF NOT EXISTS watch_events (
    id          INTEGER PRIMARY KEY,
    account_id  INTEGER NOT NULL,
    media_id    INTEGER NOT NULL,
    season      INTEGER,
    episode     INTEGER,
    watched_at  INTEGER NOT NULL,
    source      TEXT NOT NULL,
    dedupe_key  TEXT NOT NULL UNIQUE,
    legacy_id   TEXT
);
CREATE INDEX IF NOT EXISTS idx_we_account_time ON watch_events(account_id, watched_at DESC);
CREATE INDEX IF NOT EXISTS idx_we_account_media ON watch_events(account_id, media_id, season, episode);

-- One row per show an account has watched: where they are, and what they
-- chose to hide. Continue Watching and Airing Next are computed from this
-- and show_schedule (main database) when read, never stored.
-- dismissed_at_* hides the show from Continue Watching until an episode
-- after that one exists. airing_hidden_at_* does the same for Airing Next.
-- companion_json replaces the COMPANION: text the old tracking kept in the
-- show title.
CREATE TABLE IF NOT EXISTS show_progress (
    account_id                INTEGER NOT NULL,
    media_id                  INTEGER NOT NULL,
    last_season               INTEGER,
    last_episode              INTEGER,
    last_watched_at           INTEGER,
    status                    TEXT NOT NULL DEFAULT 'watching'
                              CHECK (status IN ('watching', 'completed', 'dropped')),
    dismissed_at_season       INTEGER,
    dismissed_at_episode      INTEGER,
    airing_hidden_at_season   INTEGER,
    airing_hidden_at_episode  INTEGER,
    companion_json            TEXT,
    updated_at                INTEGER NOT NULL,
    PRIMARY KEY (account_id, media_id)
);
CREATE INDEX IF NOT EXISTS idx_sp_account_recent ON show_progress(account_id, last_watched_at DESC);

-- One row per movie (or show) an account has finished: how many times, and
-- when last.
CREATE TABLE IF NOT EXISTS user_media_state (
    account_id       INTEGER NOT NULL,
    media_id         INTEGER NOT NULL,
    watched_count    INTEGER NOT NULL DEFAULT 0,
    last_watched_at  INTEGER,
    PRIMARY KEY (account_id, media_id)
);

-- This database keeps its own ledger, like the main one (0014).
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     TEXT PRIMARY KEY,
    applied_at  INTEGER NOT NULL
);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
  VALUES ('A0001', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
