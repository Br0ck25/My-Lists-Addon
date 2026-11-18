-- 0029_creator_lists_base_indexes.sql
--
-- schema.sql has two indexes on creator_lists that no migration ever created,
-- so a database built from the migration files lacked them (audit DB-06,
-- 2026-11-10). A database made from schema.sql already has both. Additive,
-- safe to run twice.

CREATE INDEX IF NOT EXISTS idx_creator_lists_username ON creator_lists(username);
CREATE INDEX IF NOT EXISTS idx_creator_lists_visibility ON creator_lists(visibility);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
  VALUES ('0029', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
