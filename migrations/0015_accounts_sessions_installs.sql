-- 0015_accounts_sessions_installs.sql
--
-- Phase 3a: Identity, sessions, installs, connections and account settings.
-- Introduces core relational tables for unified accounts, persistent login
-- sessions, clean install records without secrets, server-side encrypted provider
-- tokens, and per-account rate counters.
--
-- Safe to run against a live database, and safe to run twice.

CREATE TABLE IF NOT EXISTS accounts (
    id                   INTEGER PRIMARY KEY,
    username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name         TEXT NOT NULL,
    key_hash             TEXT NOT NULL,
    recovery_answer_hash TEXT,
    key_lookup_hmac      TEXT UNIQUE,
    created_at           INTEGER NOT NULL,
    last_active_at       INTEGER,
    version              INTEGER NOT NULL DEFAULT 0,
    deleted_at           INTEGER,
    status               TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS sessions (
    id_hash      TEXT PRIMARY KEY,
    account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    user_agent   TEXT,
    revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);

CREATE TABLE IF NOT EXISTS installs (
    id            INTEGER PRIMARY KEY,
    token_hash    TEXT NOT NULL UNIQUE,
    legacy_cfg_id TEXT UNIQUE,
    account_id    INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
    name          TEXT,
    config_json   TEXT NOT NULL,
    version       INTEGER NOT NULL DEFAULT 1,
    scopes        TEXT NOT NULL DEFAULT 'read',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    last_used_at  INTEGER,
    revoked_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_installs_account ON installs(account_id);

CREATE TABLE IF NOT EXISTS provider_connections (
    account_id        INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    provider          TEXT NOT NULL,
    external_user     TEXT,
    access_token_enc  TEXT,
    refresh_token_enc TEXT,
    expires_at        INTEGER,
    api_key_enc       TEXT,
    status            TEXT NOT NULL DEFAULT 'ok',
    last_error        TEXT,
    updated_at        INTEGER NOT NULL,
    PRIMARY KEY (account_id, provider)
);

CREATE TABLE IF NOT EXISTS install_secrets (
    install_id        INTEGER NOT NULL REFERENCES installs(id) ON DELETE CASCADE,
    provider          TEXT NOT NULL,
    access_token_enc  TEXT,
    refresh_token_enc TEXT,
    expires_at        INTEGER,
    api_key_enc       TEXT,
    updated_at        INTEGER NOT NULL,
    PRIMARY KEY (install_id, provider)
);

CREATE TABLE IF NOT EXISTS rate_counters (
    scope        TEXT NOT NULL,
    window_start INTEGER NOT NULL,
    count        INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (scope, window_start)
);

CREATE TABLE IF NOT EXISTS account_settings (
    account_id    INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    settings_json TEXT NOT NULL DEFAULT '{}',
    updated_at    INTEGER NOT NULL
);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
  VALUES ('0015', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
