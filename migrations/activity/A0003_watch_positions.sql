-- Where each person stopped in a title, and plays removed by Nuvio mirroring.
--
-- watch_positions: one resume point per account, title and source. position_ms
-- and duration_ms are milliseconds. season and episode are NULL for a movie.
-- pushed_at is when the point was last sent to Nuvio, NULL if it never was.
-- watch_events_removed: a copy of every play removed because the person deleted
-- it in Nuvio with mirroring on. Kept 30 days so it can be restored, then purged.
-- sources_json is the list of other apps that had reported the same play.
--
-- Comments in this file avoid semicolons and apostrophes on purpose, so the
-- file can be pasted into the D1 dashboard Console as it is.
CREATE TABLE IF NOT EXISTS watch_positions (
    account_id   INTEGER NOT NULL,
    media_id     INTEGER NOT NULL,
    source       TEXT NOT NULL,
    season       INTEGER,
    episode      INTEGER,
    position_ms  INTEGER NOT NULL,
    duration_ms  INTEGER NOT NULL,
    watched_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    pushed_at    INTEGER,
    PRIMARY KEY (account_id, media_id, source)
);
CREATE TABLE IF NOT EXISTS watch_events_removed (
    id            INTEGER PRIMARY KEY,
    account_id    INTEGER NOT NULL,
    media_id      INTEGER NOT NULL,
    season        INTEGER,
    episode       INTEGER,
    watched_at    INTEGER NOT NULL,
    source        TEXT NOT NULL,
    dedupe_key    TEXT NOT NULL,
    legacy_id     TEXT,
    sources_json  TEXT,
    removed_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wer_account_source ON watch_events_removed(account_id, source, removed_at);
INSERT OR IGNORE INTO schema_migrations (version, applied_at)
  VALUES ('A0003', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
