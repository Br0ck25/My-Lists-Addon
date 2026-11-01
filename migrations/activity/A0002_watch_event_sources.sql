-- Track apps that report a play already recorded by another source. The
-- canonical event remains one row so global history and counts do not double.
CREATE TABLE IF NOT EXISTS watch_event_sources (
    event_id INTEGER NOT NULL REFERENCES watch_events(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    watched_at INTEGER NOT NULL,
    PRIMARY KEY (event_id, source)
);
CREATE INDEX IF NOT EXISTS idx_wes_source_event ON watch_event_sources(source, event_id);
INSERT OR IGNORE INTO schema_migrations (version, applied_at)
  VALUES ('A0002', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
