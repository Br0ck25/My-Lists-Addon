-- 0028_ledger_backfill_0022_0023.sql
--
-- Migrations 0022 and 0023 did not write their schema_migrations row (audit
-- DB-05, 2026-11-10; the files now do). A database that applied them before
-- that has a ledger with holes. This records each one only where its change is
-- really present, so the ledger never claims something that did not run.
-- Additive, safe to run twice.

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
  SELECT '0022', CAST(strftime('%s', 'now') AS INTEGER) * 1000
   WHERE EXISTS (SELECT 1 FROM pragma_table_info('feedback') WHERE name = 'creator_name');

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
  SELECT '0023', CAST(strftime('%s', 'now') AS INTEGER) * 1000
   WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media_app_sync');

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
  VALUES ('0028', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
