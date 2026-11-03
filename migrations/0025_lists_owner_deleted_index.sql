-- 0025_lists_owner_deleted_index.sql
--
-- Every signed-in Lists load asks for the account's recently deleted lists
-- (listsV2DashboardResponse, src/data/34_lists-v2-bridge.js):
--
--   SELECT slug FROM lists WHERE owner_account_id = ?
--     AND deleted_at IS NOT NULL AND deleted_at > ?
--
-- Every index on lists.owner_account_id covers live lists only
-- (WHERE deleted_at IS NULL), so that lookup read the whole lists table
-- (audit DB-03). This indexes the deleted ones. Additive, safe to run twice.

CREATE INDEX IF NOT EXISTS idx_lists_owner_deleted ON lists(owner_account_id, deleted_at) WHERE deleted_at IS NOT NULL;

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
  VALUES ('0025', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
