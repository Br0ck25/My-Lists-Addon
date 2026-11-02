-- 0024_scrobble_token_hash.sql
--
-- Media-server webhook tokens (?st=) stop being stored as plain text.
--
-- A webhook token used to be the primary key of scrobble_tokens, so a copy of
-- the database was a list of working tokens that can write fake plays into
-- anyone's watch history. Sessions and install links already keep only a
-- SHA-256.
--
--   token_hash  SHA-256 of the token, what a request is looked up by.
--   token_enc   the token encrypted with TOKEN_ENCRYPTION_KEY, so Settings can
--               show the webhook URL again later.
--
-- A row whose token is still plain text is migrated the first time it is used:
-- both columns are filled and `token` is replaced by "hashed:<token_hash>", a
-- value no request can send. Nothing is converted by this file, and the Worker
-- keeps the old behaviour while these columns are absent or
-- TOKEN_ENCRYPTION_KEY is not set.
--
-- Run the two ALTERs once only: SQLite cannot add a column twice. The index is
-- safe to repeat.
--
-- Run it (README.md's D1 section has the full walkthrough):
--   Dashboard: open this database's Console tab and paste/run the statements below.
--   Wrangler:  npx wrangler d1 execute my-lists-db --remote --file=./migrations/0024_scrobble_token_hash.sql

ALTER TABLE scrobble_tokens ADD COLUMN token_hash TEXT;
ALTER TABLE scrobble_tokens ADD COLUMN token_enc TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_scrobble_tokens_hash ON scrobble_tokens(token_hash);
