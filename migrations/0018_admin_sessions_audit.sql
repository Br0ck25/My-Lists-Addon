-- 0018_admin_sessions_audit.sql
--
-- Phase 7 (P7-2): the admin dashboard stops being a single shared secret with a
-- stateless cookie, and starts recording what it did.
--
-- Two tables, both in the MAIN database (my-lists-db):
--
--   admin_sessions  -- one row per signed-in admin browser. The cookie carries
--                      an opaque token, only its SHA-256 is stored, and a row
--                      can be revoked (sign that browser out) without rotating
--                      ADMIN_KEY. Before this, the cookie WAS the session: an
--                      HMAC over its own expiry, which nothing could revoke and
--                      nothing could attribute.
--
--   admin_audit_log -- one row per admin login, logout and mutating admin
--                      request: who, what, when, from where. There was no
--                      record of any admin action before this (S-10).
--
-- Nothing reads these tables until the code that ships with them is deployed,
-- and that code degrades to the old stateless cookie when they are missing --
-- so running this changes nothing a visitor can see, and no existing table or
-- row is touched. Safe to run against a live database, and safe to run twice.
--
-- Comments in this file avoid semicolons and apostrophes on purpose, so the
-- file can be pasted into the D1 dashboard Console as it is.

-- id          random 16 bytes, hex -- the cookie identifies the row by this
-- token_hash  SHA-256 of the token half of the cookie. A leaked database row
--             cannot be replayed as a cookie, the same rule sessions follows.
-- actor       who this is: access:<email> for a Cloudflare Access identity,
--             or key for the shared ADMIN_KEY (break-glass).
-- revoked_at  set on logout, on a key rotation and by the dashboard's own
--             sign-out control. NULL means live.
CREATE TABLE IF NOT EXISTS admin_sessions (
    id          TEXT PRIMARY KEY,
    token_hash  TEXT NOT NULL,
    actor       TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    revoked_at  INTEGER,
    ip          TEXT,
    user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_actor ON admin_sessions(actor);

-- at      milliseconds since the epoch, like every other timestamp here
-- actor   who did it -- the same values as admin_sessions.actor
-- action  a stable name (admin.login, admin.audit.delete, ...), never a path
--         with an id in it, so the log can be grouped
-- target  what it was done to, when the request named one (a slug, a username)
-- detail  the handful of identifying fields from the request body, as JSON,
--         capped; never a key, token or password
-- status  the HTTP status the route answered with
CREATE TABLE IF NOT EXISTS admin_audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          INTEGER NOT NULL,
    actor       TEXT NOT NULL,
    action      TEXT NOT NULL,
    target      TEXT,
    detail      TEXT,
    status      INTEGER,
    ip          TEXT,
    user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON admin_audit_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit_log(action);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
  VALUES ('0018', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
