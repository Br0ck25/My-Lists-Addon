-- 0020_media_episodes.sql
--
-- Episode names and stills, once per episode.
--
-- The activity database (A0001) records a play as a title (media_id) and a
-- season and episode -- it has no column for the episode's own name or
-- picture, which the legacy Watch History kept on every entry. So with
-- FF_EVENT_TRACKING on, Watch History showed every episode as Episode 3 with
-- the show poster. An episode is called the same thing for everyone, so the
-- name belongs once per episode here, beside media, rather than on every play
-- of every account.
--
-- Filled by the plays themselves (the Stremio and Nuvio ping, the media server
-- webhook, a save from the website), and by the history copy (Start over),
-- which reads every account legacy Watch History. Read by Watch History from
-- the activity database (watchHistoryItems, 39_activity-shelves.js).
--
--   title   the episode name, as the play or the legacy entry had it
--   image   its still, when the entry had one of its own (not the show poster)
--
-- Nothing reads or writes any other table differently because of this, and no
-- existing row is touched. Safe to run against a live database, and safe to
-- run twice.
--
-- Comments in this file avoid semicolons and apostrophes on purpose, so the
-- file can be pasted into the D1 dashboard Console as it is.

CREATE TABLE IF NOT EXISTS media_episodes (
    media_id    INTEGER NOT NULL,
    season      INTEGER NOT NULL,
    episode     INTEGER NOT NULL,
    title       TEXT,
    image       TEXT,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (media_id, season, episode)
) WITHOUT ROWID;

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
  VALUES ('0020', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
