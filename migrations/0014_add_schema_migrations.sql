-- 0014_add_schema_migrations.sql
--
-- A ledger of applied migrations. Until now nothing recorded which migrations
-- had been run, so the Worker inferred it from sqlite_master and could only
-- warn. With this table the Worker knows the database's version and refuses
-- writes (503, "being updated") when it is running ahead of the database,
-- instead of silently writing a shape the database cannot hold.
--
-- Every later migration ends with its own INSERT into this table.
--
-- Safe to run against a live database, and safe to run twice. Migrations
-- 0001a-0013 are recorded with applied_at = 0 (their dates are unknown).

CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES
  ('0001a', 0),
  ('0001b', 0),
  ('0002', 0),
  ('0003', 0),
  ('0004', 0),
  ('0005', 0),
  ('0006', 0),
  ('0007', 0),
  ('0008', 0),
  ('0009', 0),
  ('0010', 0),
  ('0011', 0),
  ('0012', 0),
  ('0013', 0);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
  VALUES ('0014', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
