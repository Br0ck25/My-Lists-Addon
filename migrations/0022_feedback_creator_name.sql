-- 0022_feedback_creator_name.sql
--
-- Lets "my support history" ask the database for one account's threads.
--
-- The lookup used to read the newest 300 feedback rows of everyone and pick the
-- account's out in the Worker, so once 300 newer threads existed an account's
-- older conversation silently dropped out of its own list. creator_name holds
-- the account a thread was filed under (lower case, the same form the Worker
-- compares), so the lookup is a WHERE on an index instead of a window.
--
-- NULL means the thread belongs to nobody (an anonymous report), which is what
-- the backfill below leaves for every thread filed without a signed-in account.
--
-- Safe to run against a live database. The Worker falls back to the old
-- newest-300 statement while this column is absent, so a deployment that has
-- not run this yet keeps working, with the old limit. Run the ALTER once only:
-- SQLite cannot add a column twice. The UPDATE and the index are safe to repeat.
--
-- Run it (README.md's D1 section has the full walkthrough):
--   Dashboard: open this database's Console tab and paste/run the statements below.
--   Wrangler:  npx wrangler d1 execute my-lists-db --remote --file=./migrations/0022_feedback_creator_name.sql

ALTER TABLE feedback ADD COLUMN creator_name TEXT;

UPDATE feedback
   SET creator_name = lower(trim(json_extract(body_json, '$.creatorName')))
 WHERE creator_name IS NULL
   AND json_valid(body_json)
   AND json_extract(body_json, '$.creatorName') IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_feedback_creator_updated ON feedback(creator_name, updated_at DESC);
