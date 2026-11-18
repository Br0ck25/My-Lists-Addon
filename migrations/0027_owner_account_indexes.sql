-- 0027_owner_account_indexes.sql
--
-- Account deletion (and the foreign-key cascade of DELETE FROM accounts) asks
-- for every list and channel of one owner with no deleted_at condition:
--
--   SELECT id FROM lists WHERE owner_account_id = ?
--   UPDATE channels SET owner_account_id = NULL WHERE owner_account_id = ?
--
-- Every existing owner index is partial or needs a second column, so SQLite
-- read the whole lists and channels tables each time (audit DB-04,
-- 2026-11-10). One plain index each. Additive, safe to run twice.

CREATE INDEX IF NOT EXISTS idx_lists_owner_account ON lists(owner_account_id);
CREATE INDEX IF NOT EXISTS idx_channels_owner_account ON channels(owner_account_id);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
  VALUES ('0027', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
