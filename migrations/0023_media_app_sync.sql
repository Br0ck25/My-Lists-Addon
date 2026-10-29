-- 0023_media_app_sync.sql
--
-- Stremio and Nuvio account sync: one row per connected app per account.
--
-- The sign-in itself lives in provider_connections (migration 0015). This table
-- holds what the sync needs besides the sign-in: which Nuvio profile to read,
-- whether to pull, whether to push back (off until the person turns it on),
-- where the last pull got to, and the last error to show on the settings page.
--
-- cursor_json is the provider's own position, for example { "mtime": 1760000000000 }
-- for the newest Stremio library change already read.
--
-- Safe to run twice. The Worker answers "not available yet" for connecting a
-- Stremio or Nuvio account while this table is absent, and nothing else changes.
--
-- Run it (README.md's D1 section has the full walkthrough):
--   Dashboard: open this database's Console tab and paste/run the statements below.
--   Wrangler:  npx wrangler d1 execute my-lists-db --remote --file=./migrations/0023_media_app_sync.sql

CREATE TABLE IF NOT EXISTS media_app_sync (
    account_id     INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    provider       TEXT NOT NULL,
    profile_index  INTEGER,
    pull_enabled   INTEGER NOT NULL DEFAULT 1,
    push_enabled   INTEGER NOT NULL DEFAULT 0,
    cursor_json    TEXT,
    last_pull_at   INTEGER,
    last_push_at   INTEGER,
    last_error     TEXT,
    updated_at     INTEGER NOT NULL,
    PRIMARY KEY (account_id, provider)
);
