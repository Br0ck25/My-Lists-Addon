-- 0021_support_emails.sql
--
-- Support email threads and messages for Cloudflare Email Routing & Sending.
--
-- Receives incoming emails sent to support@mylistsaddon.com (via Cloudflare
-- Email Routing Worker binding) and records outgoing replies dispatched
-- from the Admin panel via Cloudflare Email Sending (env.EMAIL.send()).
--
--   support_threads: one row per customer conversation thread
--   support_messages: individual inbound and outbound messages in each thread
--
-- Safe to run against a live database, and safe to run twice.
-- Comments avoid semicolons and apostrophes on purpose so this can be pasted
-- directly into the Cloudflare D1 dashboard Console.

CREATE TABLE IF NOT EXISTS support_threads (
    id               TEXT PRIMARY KEY,
    customer_email   TEXT NOT NULL,
    customer_name    TEXT,
    subject          TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'open',
    unread           INTEGER NOT NULL DEFAULT 1,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    last_message_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_support_threads_status_updated ON support_threads(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_threads_customer ON support_threads(customer_email);

CREATE TABLE IF NOT EXISTS support_messages (
    id           TEXT PRIMARY KEY,
    thread_id    TEXT NOT NULL,
    direction    TEXT NOT NULL,
    from_email   TEXT NOT NULL,
    to_email     TEXT NOT NULL,
    subject      TEXT NOT NULL,
    body_text    TEXT,
    body_html    TEXT,
    message_id   TEXT,
    in_reply_to  TEXT,
    created_at   INTEGER NOT NULL,
    FOREIGN KEY(thread_id) REFERENCES support_threads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_support_messages_thread ON support_messages(thread_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_support_messages_rfc_id ON support_messages(message_id);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
  VALUES ('0021', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
