# Storage Operations & Data Integrity Matrix

This matrix provides the exhaustive inventory of database (D1), key-value (KV), object storage (R2), and memory/HTTP caching operations across My Lists Addon (`worker_entry_combined.js`), documenting storage mutations, consistency semantics, and failure handling mechanisms.

## Matrix Legend

- **Operation:** API route or backend subsystem operation.
- **D1:** Authoritative relational table(s) mutated or queried (`DB` or `DB_ACTIVITY`).
- **KV:** Authoritative or cached key-value key(s) mutated or queried (`CONFIGS`).
- **R2:** Object store bucket (`BLOBS`) path or lifecycle operation.
- **Cache:** In-memory LRU / Map cache, or HTTP `Cache-Control` header policy.
- **Failure handling:** Idempotency, transactional batching, zero-row mutation checks, rollback, or compensating actions.

---

## 1. Creator & Account Management

| Operation | D1 | KV | R2 | Cache | Failure handling |
|---|---|---|---|---|---|
| `POST /api/creator/create` | `INSERT INTO creators`, `INSERT INTO accounts`, `INSERT INTO creator_key_lookups` | `creator:{username}` profile | — | — | Spend-first rate limit counter (`consumeRateLimit`); checks uniqueness against both active accounts and `isCreatorTombstoned`; D1 failure aborts before KV write; returns `{ ok: false, error: "That username is already taken." }`. |
| `POST /api/creator/restore` | `SELECT` from `creators` / `accounts`; `UPDATE creators SET last_active = ?` | `creator:{username}` read fallback | — | Memoized in `isolateMemoryCache` (60s) | Constant-time PBKDF2 comparison (`timingSafeEqualSecret`); throttled by daily IP brute-force budget (10/min, 50/day). |
| `POST /api/creator/reset-key` | `UPDATE creators SET key_hash = ?`, `UPDATE accounts SET key_hash = ?, version = version + 1`, `DELETE FROM creator_key_lookups`, `UPDATE sessions SET revoked_at = ?` | `creator:{username}` updated | — | Account sessions evicted from `SESSION_CACHE` | Explicit `res.meta.changes > 0` verification in `rotateCreatorKeyHashInD1`; if D1 update throws, compensating `DELETE FROM creators` permits safe KV fallback; if D1 unreachable, refuses KV update to prevent account lockout. |
| `POST /api/creator/forgot-username` | `SELECT` lookups across blind index and key hashes | `creator:{username}` read | — | — | Constant-time recovery answer verification; per-IP failure budget (10/min) mitigates brute force. |
| `POST /api/creator/account/reset` | `DELETE FROM creator_lists`, `lists_fts`, `watch_events`, etc.; preserves `creators` row | `DELETE creatorsync:*`, `creatorlist:*`, etc.; preserves `creator:{username}` | — | Install snapshots purged | Requires `confirm: "RESET"`; atomic sweep in D1 via username equality (`WHERE username = ?`); failure flips `dataSweepFailed` and returns 500 without reporting false success. |
| `POST /api/creator/delete-account` | Cascade delete across `creators`, `accounts`, `sessions`, `installs`, `lists_fts`; `INSERT INTO creator_tombstones (username, until)` | `DELETE creator:*`, `creatorsync:*`; `PUT creatordeleted:{username}` (TTL 300s) | Channel R2 pools marked stale | Clears `mla_session` cookie; evicts `SESSION_CACHE` and install snapshots | Requires `confirm: "DELETE"`; dual-layer tombstones (D1 `creator_tombstones` + KV `creatordeleted:`) prevent account resurrection and in-flight request race conditions. |

---

## 2. Modern Session Architecture (`FF_SESSIONS`)

| Operation | D1 | KV | R2 | Cache | Failure handling |
|---|---|---|---|---|---|
| `POST /api/session` (Login) | `INSERT INTO sessions (id_hash, account_id, created_at, expires_at, ...)` | — | — | Memoized in `SESSION_CACHE` (60s) | Session token is 32 cryptographically random bytes; only SHA-256 hash (`id_hash`) stored in D1; cookie emitted with `HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`. |
| `DELETE /api/session` (Logout) | `UPDATE sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL` | — | — | Evicted from `SESSION_CACHE` | Idempotent; always clears browser cookie with `Max-Age=0`. |
| `GET /api/me` | `SELECT` joining `sessions` and `accounts` | — | — | `SESSION_CACHE` hit prevents D1 query; `Cache-Control: private, no-store` | Rejects expired (`expires_at <= now`) or revoked (`revoked_at IS NOT NULL`) sessions with 401; touches `last_seen_at` asynchronously. |
| `POST /api/me/sessions/revoke` | `UPDATE sessions SET revoked_at = ? WHERE id_hash = ? AND account_id = ?` | — | — | Evicted from `SESSION_CACHE` | Scoped strictly by `account_id = ?` preventing cross-account session revocation. |

---

## 3. Install Links & Secrets (`27_installs.js`)

| Operation | D1 | KV | R2 | Cache | Failure handling |
|---|---|---|---|---|---|
| `POST /api/installs` | `INSERT INTO installs (token_hash, account_id, name, config_json, version, scopes, ...)` | — | — | `INSTALL_SNAPSHOT_CACHE` | Enforces max 20 installs per account; generates cryptographically random token; only hash stored in D1. |
| `GET /i/:token/manifest.json` | `SELECT` joining `installs` and `accounts` (on cache miss); `UPDATE installs SET last_used_at = ?` | `installsnap:<tokenHash>` (TTL 1 day) | — | `INSTALL_SNAPSHOT_CACHE` in memory (60s) | Snapshot cached in memory and KV; day-level `last_used_at` batching; returns 404 if revoked or missing. |
| `PATCH /api/installs/:id` | `UPDATE installs SET name = ?, config_json = ?, scopes = ?, token_hash = ?, version = version + 1 WHERE id = ? AND account_id = ? AND version = ?` | `DELETE installsnap:<tokenHash>` | — | Evicted from `INSTALL_SNAPSHOT_CACHE` | Optimistic concurrency: verifies `version = ?`; if 0 rows affected (`changes === 0`), returns `409 Conflict`; purges old and new snapshot caches. |
| `DELETE /api/installs/:id` | `UPDATE installs SET revoked_at = ?, version = version + 1 WHERE id = ? AND account_id = ? AND revoked_at IS NULL` | `DELETE installsnap:<tokenHash>` | — | Evicted from `INSTALL_SNAPSHOT_CACHE` | Soft delete sets `revoked_at`; snapshot evicted; subsequent resolution answers with revoked/empty config. |

---

## 4. Custom Lists v2 (`31_lists-api.js`)

| Operation | D1 | KV | R2 | Cache | Failure handling |
|---|---|---|---|---|---|
| `POST /api/lists` | D1 Batch: `INSERT INTO lists`, `INSERT INTO list_items`, conditional `INSERT INTO lists_fts2`, `UPDATE accounts SET version = version + 1` | — | — | — | Atomic batch execution; slug conflict resolution via candidate probing; position assigned monotonically; updates change feed. |
| `GET /api/lists/:publicId` | `SELECT` from `lists` and `list_items` joining `media` | — | — | `ETag: "{version}"`; 404 for private lists if not owner | Keyspace cursor pagination (`position, id`); returns 404 for non-owners on private lists to prevent presence disclosure. |
| `PATCH /api/lists/:publicId` | D1 Batch: `UPDATE lists ... WHERE id = ? AND version = ?`, conditional `INSERT INTO list_slug_history`, `DELETE FROM lists_fts2`, conditional `INSERT INTO lists_fts2`, `UPDATE accounts SET version = version + 1` | — | — | If-Match validation | Mandatory `If-Match` header (428 if absent); optimistic locking checks `out[0].meta.changes > 0`; returns `412 Precondition Failed` if stale. |
| `DELETE /api/lists/:publicId` | D1 Batch: `UPDATE lists SET deleted_at = ?, version = version + 1 WHERE id = ? AND version = ? AND deleted_at IS NULL`, `DELETE FROM lists_fts2`, `UPDATE accounts SET version = version + 1` | — | — | Evicted from search and public views | Soft delete via `deleted_at`; requires `If-Match`; checks `meta.changes > 0` returning 412 on conflict; cleans FTS virtual table. |
| `POST /api/lists/:publicId/items` | D1 Batch: chunked `INSERT INTO list_items`, `UPDATE lists SET item_count = (SELECT count(*)...), version = version + 1`, `UPDATE accounts SET version = ...` | — | — | — | Chunked parameter binding (12 rows / 96 params per statement) under SQLite limits; enforces max 500 items per add, 10,000 per list. |
| `DELETE /api/lists/:publicId/items/:mediaId` | D1 Batch: `DELETE FROM list_items WHERE id = ?`, `UPDATE lists SET item_count = ..., version = version + 1`, `UPDATE accounts SET version = ...` | — | — | — | Atomic batch recalculates `item_count` and bumps list/account versions. |
| `POST /api/lists/:publicId/items/move` | `UPDATE list_items SET position = ? WHERE id = ?`, `UPDATE lists SET item_count = ..., version = version + 1` | — | — | — | Dense fractional positioning (`(low + high) / 2`); automatically re-spaces list items via window function when gap `< 1e-9`. |

---

## 5. Likes Ledger (`32_likes-api.js`)

| Operation | D1 | KV | R2 | Cache | Failure handling |
|---|---|---|---|---|---|
| `PUT /api/likes/:type/:id` | D1 Batch: `INSERT OR IGNORE INTO likes (target_type, target_id, voter, ...)`, `UPDATE {table} SET like_count = like_count + changes() WHERE {key} = ?`, `UPDATE accounts SET version = ...` | Legacy ledger sync via `syncLegacyLikes` | — | `Cache-Control: no-store` | Atomic `changes()` accounting: duplicate like inserts 0 rows, so `like_count + 0` prevents double counting; account version bumped. |
| `DELETE /api/likes/:type/:id` | D1 Batch: `DELETE FROM likes WHERE target_type = ? AND target_id = ? AND voter = ?`, `UPDATE {table} SET like_count = max(0, like_count - changes()) WHERE {key} = ?`, `UPDATE accounts SET version = ...` | Legacy ledger sync via `syncLegacyLikes` | — | `Cache-Control: no-store` | Atomic `changes()` accounting: duplicate unlike deletes 0 rows, so `like_count - 0` prevents double decrement; `max(0, ...)` prevents negative counts. |

---

## 6. Shared Channels v2 & R2 Episode Pools (`35_channels-v2.js`)

| Operation | D1 | KV | R2 | Cache | Failure handling |
|---|---|---|---|---|---|
| `POST /api/channel/share` (Create / Update) | `INSERT INTO channels ... ON CONFLICT(public_code) DO UPDATE ... WHERE channels.updated_at <= excluded.updated_at` | Legacy `channelshare:{code}` written first (strangler) | `channels/{code}/{poolVersion}.json` uploaded | — | If D1 write rejected due to concurrency (`changes === 0`), compensating delete purges newly written R2 blob (`blobs.delete(wrotePool)`), preventing orphan leaks; if D1 succeeds and replaces an older pool, old R2 blob is deleted (`blobs.delete(existing.pool_r2_key)`). |
| `GET /api/channel/share?code=...` | `SELECT` from `channels` | Legacy KV fallback if row stale | `BLOBS.get(pool_r2_key)` | `Cache-Control: public, max-age=120` | Reads metadata from D1 and full episode pool from R2; falls back to legacy KV if R2 blob absent or `legacy_hash` stale. |
| `POST /api/channel/unpublish` | `UPDATE channels SET visibility = 'unlisted', legacy_hash = NULL WHERE public_code = ?` | Legacy `channelshare:{code}` updated | R2 pool preserved for direct link holders | Evicted from Explore directory | Soft unpublish; channel remains playable by direct code link; directory queries exclude unlisted channels. |

---

## 7. Activity & Watch History (`36_activity-db.js`, `38_activity-scrobble.js`)

| Operation | D1 (`DB_ACTIVITY`) | KV | R2 | Cache | Failure handling |
|---|---|---|---|---|---|
| `recordActivityPlay` (Scrobble) | D1 Batch: `INSERT OR IGNORE INTO watch_events ... WHERE NOT EXISTS (...)` with `dedupe_key`, conditional `INSERT INTO show_progress ... ON CONFLICT DO UPDATE`, conditional `INSERT INTO user_media_state ... WHERE changes() > 0 ON CONFLICT DO UPDATE` | Legacy tracking sync written first | — | Sharded across `DB_ACTIVITY` via `id % N` | 10-minute sliding window deduplication (`ACTIVITY_DEDUPE_WINDOW_MS`); `WHERE changes() > 0` ensures duplicate scrobbles do not increment `user_media_state.watched_count`. |
| Sharded Routing (`shardFor`) | Routes to `DB_ACTIVITY` or `DB_ACTIVITY_{shard}` | — | — | `activitySchemaCache` (60s) | Bounds shard count (max 16); verifies all required bindings exist before enabling sharding; fails safe to primary DB. |

---

## 8. Full-Text Search Virtual Tables (`lists_fts`, `lists_fts2`)

| Operation | D1 | KV | R2 | Cache | Failure handling |
|---|---|---|---|---|---|
| List FTS Indexing | `DELETE FROM lists_fts2 WHERE rowid = ?`; conditional `INSERT INTO lists_fts2 SELECT ... FROM lists WHERE id = ? AND visibility = 'public' AND deleted_at IS NULL` | — | — | — | Kept in 100% sync within list mutation D1 batches; private, unlisted, and deleted lists evaluate to 0 rows in `SELECT` and are automatically omitted from FTS. |
| Search Query | `SELECT ... FROM lists_fts2 f JOIN lists l ON l.id = f.rowid WHERE lists_fts2 MATCH ?` | — | — | — | Uses FTS5 `unicode61 remove_diacritics 2` tokenizer; scoped to `visibility = 'public' AND deleted_at IS NULL AND item_count > 0`. |
| `/admin/api/rebuild-search-index` | `DELETE FROM lists_fts2`; `INSERT INTO lists_fts2 SELECT ... FROM lists WHERE visibility = 'public' AND deleted_at IS NULL` | — | — | — | Rebuilds FTS5 virtual table from authoritative relational data; handles D1 export/restore virtual table limitations. |

---

## 9. Background Jobs Queue (`44_jobs-queue.js`)

| Operation | D1 | KV | R2 | Cache | Failure handling |
|---|---|---|---|---|---|
| `enqueueJob` | `INSERT OR IGNORE INTO jobs (queue, type, dedupe_key, payload_json, run_after, status, ...)` | — | — | — | Unique `dedupe_key` prevents duplicate queueing; Cloudflare Queue `JOBS` producer handles async delivery. |
| Job Consumption & Retry | `UPDATE jobs SET status = 'running', attempts = attempts + 1 WHERE id = ?`; `UPDATE jobs SET status = 'done'` or `'failed'` | — | — | — | Queue consumer processes in batches of 25 with 5 retries; dead-letter queue (`mylists-jobs-dlq`) captures unrecoverable jobs. |
