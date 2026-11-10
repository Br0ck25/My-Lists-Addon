-- 0026_accounts_key_hash_index.sql
--
-- Every Stremio/Nuvio manifest request and every channel catalog request runs
--
--   SELECT username FROM accounts WHERE username = ? OR id = ? OR key_hash = ? LIMIT 1
--
-- with the install token as the value. accounts had no index on key_hash, so
-- SQLite could not answer the OR from indexes and read every account row each
-- time (audit DB-03, 2026-11-10). The Worker's statement also dropped a redundant
-- COLLATE NOCASE (the username column is already NOCASE), which stopped
-- SQLite from using the indexes together. Additive, safe to run twice.

CREATE INDEX IF NOT EXISTS idx_accounts_key_hash ON accounts(key_hash);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
  VALUES ('0026', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
