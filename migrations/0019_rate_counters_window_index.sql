-- 0019_rate_counters_window_index.sql
--
-- Phase 7 (P7-3): make the rate-limit sweep cheap.
--
-- `rate_counters` (0015) is one row per (scope, window_start) -- one counter
-- per bucket, key and window -- and a row is nothing once its window has
-- passed: nothing can be counted against a minute that ended. The code deletes
-- those rows opportunistically, at most once every ten minutes per isolate
-- (sweepRateCounters, 02_http-and-creator-utils.js), and it keeps a day's
-- worth because the longest window any caller uses is fifteen minutes.
--
-- That delete is WHERE window_start < <cutoff>, and the primary key is
-- (scope, window_start) -- scope first, so the primary key cannot serve it.
-- Without this index the sweep scans the whole table every ten minutes, on a
-- table whose entire purpose is to be written to constantly.
--
-- Nothing reads or writes any table differently because of this index, and no
-- existing row is touched. Safe to run against a live database, and safe to
-- run twice.
--
-- Comments in this file avoid semicolons and apostrophes on purpose, so the
-- file can be pasted into the D1 dashboard Console as it is.

CREATE INDEX IF NOT EXISTS idx_rate_counters_window ON rate_counters(window_start);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
  VALUES ('0019', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
