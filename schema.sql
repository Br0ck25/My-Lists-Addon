-- schema.sql
--
-- The complete CURRENT schema, for a brand-new database (local development,
-- tests, a new staging database). It is equivalent to running every file in
-- migrations/ in order.
--
-- It is NOT destructive: every statement is CREATE ... IF NOT EXISTS and
-- nothing is dropped, so running it against a live database by mistake
-- changes nothing that exists. (It used to begin with DROP TABLE for every
-- table.) To change a deployed database, add a file under migrations/ and
-- see docs/OPERATIONS.md.

CREATE TABLE IF NOT EXISTS creators (
    username TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    recovery_answer_hash TEXT,
    created_at INTEGER NOT NULL,
    last_active INTEGER,
    share_json TEXT,
    lists_stamp INTEGER
);

CREATE TABLE IF NOT EXISTS creator_lists (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'private',
    items_json TEXT NOT NULL DEFAULT '[]',
    likes INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    sort_order INTEGER,
    FOREIGN KEY (username) REFERENCES creators(username) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS creator_key_lookups (
    lookup_hash TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (username) REFERENCES creators(username) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_creator_key_lookups_username ON creator_key_lookups(username);

CREATE TABLE IF NOT EXISTS source_groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    install_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stats (
    -- 'pageviews', 'installs', 'apiuse:tmdb', 'list_copy:top-ten', ...
    -- i.e. the same {kind} that used to sit inside a stats:{kind}:{bucket}
    -- KV key name.
    kind TEXT NOT NULL,
    -- 'YYYY-MM-DD' (Eastern calendar day, see easternDateKey) for a daily
    -- bucket, or the literal 'total' for the all-time one. Same two shapes
    -- the KV keys always had.
    day  TEXT NOT NULL,
    n    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kind, day)
);

-- A strongly-consistent "this account was deleted" marker -- see
-- migrations/0004 for why a missing `creators` row cannot serve as one.
CREATE TABLE IF NOT EXISTS creator_tombstones (
    username TEXT PRIMARY KEY,
    until    INTEGER NOT NULL
);

-- Indexes for fast querying.
--
-- These have to match what migrations/0001, 0002 and 0003 leave behind, or a
-- database provisioned the documented way (run this file) ends up a different
-- shape from one that grew through the migrations. idx_creator_lists_likes
-- existed only in 0001, so a fresh deployment did not have it; there is a test
-- that now diffs the two provisioning paths and fails on any such drift.
CREATE INDEX IF NOT EXISTS idx_creator_lists_username ON creator_lists(username);
CREATE INDEX IF NOT EXISTS idx_creator_lists_visibility ON creator_lists(visibility);
CREATE INDEX IF NOT EXISTS idx_creator_lists_likes ON creator_lists(likes);

-- The two the admin dashboard's own queries actually need -- see
-- migrations/0003 for the query plans. Without the first, listing accounts is
-- a full scan of `creators` plus an in-memory sort on every dashboard load;
-- without the second, the Community Lists panel reads roughly half of
-- `creator_lists` and sorts it to return 200 rows.
CREATE INDEX IF NOT EXISTS idx_creators_last_active ON creators(last_active DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_creator_lists_vis_likes ON creator_lists(visibility, likes DESC, updated_at DESC);

-- The dashboard's counter panels: WHERE day = 'total' AND kind LIKE ?
-- ORDER BY n DESC. The (kind, day) primary key cannot serve that, so it was a
-- full scan plus a sort -- over a table whose `kind` dimension is unbounded,
-- because list_copy:{slug} mints one per list. See migrations/0005.
CREATE INDEX IF NOT EXISTS idx_stats_day_totals ON stats(day, n DESC, kind);

CREATE TABLE IF NOT EXISTS published_lists (
    slug        TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,
    visibility  TEXT NOT NULL DEFAULT 'private',
    items_json  TEXT NOT NULL DEFAULT '[]',
    likes       INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_published_vis_likes ON published_lists(visibility, likes DESC, updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS lists_fts USING fts5(
    list_id UNINDEXED,
    name,
    creator_name,
    username,
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS list_tombstones (
    username TEXT NOT NULL,
    slug     TEXT NOT NULL,
    until    INTEGER NOT NULL,
    PRIMARY KEY (username, slug)
);
CREATE INDEX IF NOT EXISTS idx_list_tombstones_user_until ON list_tombstones(username, until);

CREATE TABLE IF NOT EXISTS list_likes (
    list_id    TEXT NOT NULL,
    voter_id   TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (list_id, voter_id)
);
CREATE INDEX IF NOT EXISTS idx_list_likes_voter ON list_likes(voter_id);

CREATE TABLE IF NOT EXISTS feedback (
    id         TEXT PRIMARY KEY,
    status     TEXT NOT NULL DEFAULT 'open',
    subject    TEXT,
    body_json  TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_status_updated ON feedback(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS scrobble_tokens (
    token      TEXT PRIMARY KEY,
    username   TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scrobble_tokens_user ON scrobble_tokens(username);

CREATE TABLE IF NOT EXISTS event_meta (
    event_type TEXT NOT NULL,
    item_id    TEXT NOT NULL,
    title      TEXT,
    media_type TEXT,
    last_seen  INTEGER NOT NULL,
    PRIMARY KEY (event_type, item_id)
);

CREATE TABLE IF NOT EXISTS watch_history (
    username    TEXT NOT NULL,
    item_id     TEXT NOT NULL,
    item_type   TEXT NOT NULL,
    title       TEXT,
    poster      TEXT,
    show_id     TEXT,
    show_title  TEXT,
    show_poster TEXT,
    season_num  INTEGER,
    episode_num INTEGER,
    year        TEXT,
    air_date    TEXT,
    watched_at  INTEGER NOT NULL,
    PRIMARY KEY (username, item_id)
);
CREATE INDEX IF NOT EXISTS idx_watch_history_user_watched ON watch_history(username, watched_at DESC);

CREATE TABLE IF NOT EXISTS continue_watching (
    username    TEXT NOT NULL,
    show_id     TEXT NOT NULL,
    item_id     TEXT NOT NULL,
    name        TEXT,
    poster      TEXT,
    show_title  TEXT,
    show_poster TEXT,
    season_num  INTEGER,
    episode_num INTEGER,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (username, show_id)
);
CREATE INDEX IF NOT EXISTS idx_continue_watching_user_updated ON continue_watching(username, updated_at DESC);

CREATE TABLE IF NOT EXISTS airing_next (
    username                     TEXT NOT NULL,
    show_id                      TEXT NOT NULL,
    item_id                      TEXT NOT NULL,
    name                         TEXT,
    poster                       TEXT,
    show_title                   TEXT,
    show_poster                  TEXT,
    season_num                   INTEGER,
    episode_num                  INTEGER,
    air_date                     TEXT,
    is_season_premiere           INTEGER DEFAULT 0,
    is_season_finale             INTEGER DEFAULT 0,
    season_finale_air_date       TEXT,
    season_finale_episode_number INTEGER,
    updated_at                   INTEGER NOT NULL,
    PRIMARY KEY (username, show_id)
);
CREATE INDEX IF NOT EXISTS idx_airing_next_user ON airing_next(username, air_date ASC);

CREATE TABLE IF NOT EXISTS creator_user_lists (
    username    TEXT NOT NULL,
    list_id     TEXT NOT NULL,
    list_type   TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (username, list_id, list_type)
);
CREATE INDEX IF NOT EXISTS idx_creator_user_lists_lookup ON creator_user_lists(username, list_type);

CREATE TABLE IF NOT EXISTS creator_show_states (
    username               TEXT NOT NULL,
    show_id                TEXT NOT NULL,
    is_fully_watched       INTEGER DEFAULT 0,
    dismissed_season       INTEGER,
    dismissed_episode      INTEGER,
    -- The watched episode an Airing Next removal was made at; NULL means the
    -- show has not been removed from that shelf. See migrations/0012.
    airing_removed_season  INTEGER,
    airing_removed_episode INTEGER,
    updated_at             INTEGER NOT NULL,
    PRIMARY KEY (username, show_id)
);
CREATE INDEX IF NOT EXISTS idx_creator_show_states_fw ON creator_show_states(username, is_fully_watched);

CREATE TABLE IF NOT EXISTS creator_tracking_meta (
    username                   TEXT PRIMARY KEY,
    track_playback             INTEGER NOT NULL DEFAULT 0,
    remove_watched_watchlist   INTEGER NOT NULL DEFAULT 1,
    scrobble_filter_users      INTEGER NOT NULL DEFAULT 0,
    scrobble_allowed_users     TEXT NOT NULL DEFAULT '',
    scrobble_block_anonymous   INTEGER NOT NULL DEFAULT 0,
    curated_recommendations    TEXT,
    client_version             INTEGER NOT NULL DEFAULT 0,
    updated_at                 INTEGER NOT NULL
);


-- Observed provider-catalog arrivals, behind the "New on Streaming" catalog
-- (tmdb:new-on-streaming[:service]). Written only by the cron sweep; see
-- migrations/0011_add_streaming_events.sql for why the add-on has to observe
-- these dates rather than read them from an upstream API.
CREATE TABLE IF NOT EXISTS streaming_events (
    region         TEXT NOT NULL,
    service        TEXT NOT NULL,
    imdb_id        TEXT NOT NULL,
    tmdb_id        INTEGER,
    kind           TEXT NOT NULL,
    added_at       INTEGER NOT NULL,
    last_event_at  INTEGER NOT NULL,
    event_kind     TEXT NOT NULL,
    season         INTEGER,
    episode        INTEGER,
    seeded         INTEGER NOT NULL DEFAULT 0,
    last_seen_walk INTEGER NOT NULL DEFAULT 0,
    removed_at     INTEGER,
    name           TEXT,
    poster         TEXT,
    background     TEXT,
    year           TEXT,
    PRIMARY KEY (region, service, imdb_id)
);
CREATE INDEX IF NOT EXISTS idx_streaming_events_feed ON streaming_events(region, kind, last_event_at DESC);
CREATE INDEX IF NOT EXISTS idx_streaming_events_tmdb ON streaming_events(region, kind, tmdb_id);

-- Phase 3a: Identity, sessions, installs, connections (migrations/0015)
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

-- Phase 3b: lists, likes, channels, presets and jobs (migrations/0016).
-- The migration file explains each table.
CREATE TABLE IF NOT EXISTS media (
    id            INTEGER PRIMARY KEY,
    kind          TEXT NOT NULL CHECK (kind IN ('movie', 'series')),
    tmdb_id       INTEGER,
    imdb_id       TEXT,
    tvdb_id       INTEGER,
    alt_id        TEXT,
    title         TEXT,
    year          INTEGER,
    poster_path   TEXT,
    backdrop_path TEXT,
    resolved_at   INTEGER,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_tmdb ON media(kind, tmdb_id) WHERE tmdb_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_imdb ON media(imdb_id) WHERE imdb_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_alt ON media(kind, alt_id) WHERE alt_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_media_unresolved ON media(updated_at) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS lists (
    id               INTEGER PRIMARY KEY,
    public_id        TEXT NOT NULL UNIQUE,
    owner_account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
    slug             TEXT NOT NULL,
    name             TEXT NOT NULL,
    description      TEXT,
    kind             TEXT NOT NULL DEFAULT 'custom',
    media_type       TEXT NOT NULL CHECK (media_type IN ('movie', 'series', 'mixed')),
    visibility       TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'unlisted', 'public')),
    legacy_id        TEXT UNIQUE,
    legacy_hash      TEXT,
    source_provider  TEXT,
    source_ref       TEXT,
    source_json      TEXT,
    synced_at        INTEGER,
    item_count       INTEGER NOT NULL DEFAULT 0,
    like_count       INTEGER NOT NULL DEFAULT 0,
    add_count        INTEGER NOT NULL DEFAULT 0,
    position         REAL NOT NULL DEFAULT 0,
    version          INTEGER NOT NULL DEFAULT 1,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    deleted_at       INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lists_owner_slug ON lists(owner_account_id, slug) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lists_owner ON lists(owner_account_id, position) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lists_dir_popular ON lists(like_count DESC, updated_at DESC, id DESC) WHERE visibility = 'public' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lists_dir_new ON lists(created_at DESC, id DESC) WHERE visibility = 'public' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lists_dir_added ON lists(add_count DESC, like_count DESC, id DESC) WHERE visibility = 'public' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS list_items (
    id         INTEGER PRIMARY KEY,
    list_id    INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    media_id   INTEGER NOT NULL REFERENCES media(id),
    season     INTEGER,
    episode    INTEGER,
    position   REAL NOT NULL,
    added_at   INTEGER NOT NULL,
    note       TEXT,
    extra_json TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_list_items_entry ON list_items(list_id, media_id, ifnull(season, -1), ifnull(episode, -1));
CREATE INDEX IF NOT EXISTS idx_list_items_order ON list_items(list_id, position);
CREATE INDEX IF NOT EXISTS idx_list_items_media ON list_items(media_id);

CREATE TABLE IF NOT EXISTS list_slug_history (
    owner_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    old_slug         TEXT NOT NULL,
    list_id          INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    created_at       INTEGER NOT NULL,
    PRIMARY KEY (owner_account_id, old_slug)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_list_slug_history_list ON list_slug_history(list_id);

CREATE VIRTUAL TABLE IF NOT EXISTS lists_fts2 USING fts5(
    name,
    description,
    owner_name,
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS likes (
    target_type TEXT NOT NULL,
    target_id   TEXT NOT NULL,
    voter       TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (target_type, target_id, voter)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_likes_voter ON likes(voter);

CREATE TABLE IF NOT EXISTS channels (
    id               INTEGER PRIMARY KEY,
    public_code      TEXT NOT NULL UNIQUE,
    owner_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    client_id        TEXT,
    slug             TEXT,
    name             TEXT NOT NULL,
    description      TEXT,
    visibility       TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'unlisted', 'public')),
    definition_json  TEXT NOT NULL DEFAULT '{}',
    pool_r2_key      TEXT,
    pool_version     INTEGER NOT NULL DEFAULT 0,
    item_count       INTEGER NOT NULL DEFAULT 0,
    show_count       INTEGER NOT NULL DEFAULT 0,
    like_count       INTEGER NOT NULL DEFAULT 0,
    add_count        INTEGER NOT NULL DEFAULT 0,
    published_at     INTEGER,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    deleted_at       INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_owner_client ON channels(owner_account_id, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_channels_owner_slug ON channels(owner_account_id, slug) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_channels_dir_new ON channels(published_at DESC, id DESC) WHERE visibility = 'public' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_channels_dir_liked ON channels(like_count DESC, add_count DESC, id DESC) WHERE visibility = 'public' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_channels_dir_added ON channels(add_count DESC, like_count DESC, id DESC) WHERE visibility = 'public' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS account_list_prefs (
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    pref       TEXT NOT NULL,
    target     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    position   REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, pref, target)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS presets (
    id          INTEGER PRIMARY KEY,
    account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    config_json TEXT NOT NULL,
    position    REAL NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE (account_id, name)
);

CREATE TABLE IF NOT EXISTS jobs (
    id            INTEGER PRIMARY KEY,
    type          TEXT NOT NULL,
    dedupe_key    TEXT UNIQUE,
    account_id    INTEGER,
    status        TEXT NOT NULL DEFAULT 'queued',
    attempts      INTEGER NOT NULL DEFAULT 0,
    run_after     INTEGER NOT NULL,
    payload_json  TEXT,
    progress_json TEXT,
    last_error    TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, run_after);
CREATE INDEX IF NOT EXISTS idx_jobs_account ON jobs(account_id, type) WHERE account_id IS NOT NULL;

-- Migration ledger (migrations/0014). A fresh database starts at the latest version.
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
  ('0013', 0),
  ('0014', 0),
  ('0015', 0),
  ('0016', 0);
