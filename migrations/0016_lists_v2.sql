-- 0016_lists_v2.sql
--
-- Phase 3b groundwork: lists, likes, channels and presets as real tables.
--
-- Today a list is one JSON blob (in KV creatorlist:* and D1 creator_lists),
-- rewritten whole on every edit. These tables hold the same things row by
-- row, so adding one title is one small write and the directory, search and
-- counts become plain SQL. See MIGRATION_PLAN.md section 3b and
-- NEXT_VERSION_ARCHITECTURE.md section 4.3.
--
-- Nothing reads or writes these tables yet. Running this changes nothing a
-- visitor can see, and no existing table or row is touched. The backfill that
-- copies lists across (P3b-3) comes later, and only with the owner approval.
--
-- Safe to run against a live database, and safe to run twice.
--
-- Comments in this file avoid semicolons and apostrophes on purpose, so the
-- file can be pasted into the D1 dashboard Console as it is.

-- One row per movie or show, shared by every list that holds it.
-- A stub is a title TMDB could not place (P3b-2, 29_media.js). It keeps its
-- row with only the ids it came with, and the title the list item gave as a
-- hint (or NULL). resolved_at stays NULL so a later pass can try again.
-- alt_id holds any other id an item arrived with (kitsu:1, mal:5 and the
-- like) when it has no TMDB or IMDb id.
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

-- One row per list.
--   kind         custom | watchlist | imported | synced | legacy_anonymous
--   media_type   the legacy list type: movie | series | mixed
--   legacy_id    the record it was copied from (a creator_lists id, or an
--                anonymous published list), so the backfill can run again
--                without making copies. NULL for a list made on v2.
--   source_ref   where an imported or synced list came from (its URL), and
--   source_json  the sync bookkeeping (baseItemIds) the importer keeps.
--   owner_account_id is NULL only for legacy anonymous lists (D-6), which are
--   read-only and never listed in the directory.
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
-- A live list owns its slug. A deleted one gives it up, so the name can be
-- used again.
CREATE UNIQUE INDEX IF NOT EXISTS idx_lists_owner_slug ON lists(owner_account_id, slug) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lists_owner ON lists(owner_account_id, position) WHERE deleted_at IS NULL;
-- The public directory, one index per order (P3b-6). popular is the order the
-- directory has today: likes, then the most recently updated.
CREATE INDEX IF NOT EXISTS idx_lists_dir_popular ON lists(like_count DESC, updated_at DESC, id DESC) WHERE visibility = 'public' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lists_dir_new ON lists(created_at DESC, id DESC) WHERE visibility = 'public' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lists_dir_added ON lists(add_count DESC, like_count DESC, id DESC) WHERE visibility = 'public' AND deleted_at IS NULL;

-- One row per entry in a list.
-- A whole movie or show has season and episode NULL. Storyline and crossover
-- lists also hold single episodes, so the same show can appear more than once
-- with different episode numbers. extra_json keeps the item fields that have
-- no column of their own (companion notes, air dates, a poster chosen for
-- this list), so copying a list across loses nothing.
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
-- ifnull because NULLs never collide in a UNIQUE index, and a whole title
-- (season and episode NULL) must still appear only once per list.
CREATE UNIQUE INDEX IF NOT EXISTS idx_list_items_entry ON list_items(list_id, media_id, ifnull(season, -1), ifnull(episode, -1));
CREATE INDEX IF NOT EXISTS idx_list_items_order ON list_items(list_id, position);
CREATE INDEX IF NOT EXISTS idx_list_items_media ON list_items(media_id);

-- A renamed list keeps answering at its old address.
CREATE TABLE IF NOT EXISTS list_slug_history (
    owner_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    old_slug         TEXT NOT NULL,
    list_id          INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    created_at       INTEGER NOT NULL,
    PRIMARY KEY (owner_account_id, old_slug)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_list_slug_history_list ON list_slug_history(list_id);

-- Full-text search over public lists (P3b-6). rowid is lists.id. It holds
-- only lists that are public and not deleted, and the code keeps it in step
-- by rowid in the same batch as each list write. It keeps its own copy of the
-- text rather than reading it from lists, so removing a row never depends on
-- knowing what was indexed before. Separate from lists_fts (migration 0007),
-- which the current directory search still uses.
CREATE VIRTUAL TABLE IF NOT EXISTS lists_fts2 USING fts5(
    name,
    description,
    owner_name,
    tokenize = 'unicode61 remove_diacritics 2'
);

-- One row per vote.
--   target_type  list | channel | external | channel_add
--   target_id    lists.public_id, channels.public_code, or the key of an
--                external list (MDBList, Trakt and the like)
--   voter        acct:<accounts.id> for an account. Votes cast signed out
--                before D-6 keep their legacy a:<hash> id and keep counting (D-9).
-- channel_add rows are the once-per-account adds behind the channel
-- directory order Most added.
CREATE TABLE IF NOT EXISTS likes (
    target_type TEXT NOT NULL,
    target_id   TEXT NOT NULL,
    voter       TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (target_type, target_id, voter)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_likes_voter ON likes(voter);

-- One row per channel, built or shared.
--   public_code      the share code in /channel/<code>
--   client_id        the id the owner browser gives the channel in account sync
--   visibility       private (only the owner), unlisted (anyone with the
--                    code), public (listed in Explore Channels)
--   definition_json  the channel settings without its episodes
--   pool_r2_key      where the episode pool lives in R2, by version
-- A deleted account leaves its shared channels in place for the people who
-- added them (owner becomes NULL). Its private channels are removed by the
-- account deletion code, not by the database.
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
-- The Explore Channels directory orders: Newest, Most liked, Most added.
CREATE INDEX IF NOT EXISTS idx_channels_dir_new ON channels(published_at DESC, id DESC) WHERE visibility = 'public' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_channels_dir_liked ON channels(like_count DESC, add_count DESC, id DESC) WHERE visibility = 'public' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_channels_dir_added ON channels(add_count DESC, like_count DESC, id DESC) WHERE visibility = 'public' AND deleted_at IS NULL;

-- Liked lists, hidden lists and hidden My Lists sections, per account.
-- Replaces creator_user_lists and the copies in the creatorsync blob.
--   pref    liked | hidden | hidden_section
--   target  the list or section id as the page names it
CREATE TABLE IF NOT EXISTS account_list_prefs (
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    pref       TEXT NOT NULL,
    target     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, pref, target)
) WITHOUT ROWID;

-- Saved presets, one row each. Replaces the creatorsyncpresets blob.
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

-- Background work that runs in steps and can pick up where it stopped. The
-- list backfill (migrate.lists, P3b-3) keeps its progress and its per-account
-- reconciliation record in progress_json. Phase 5 adds the dispatcher.
--   status  queued | running | done | failed
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

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
  VALUES ('0016', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
