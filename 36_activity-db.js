
// --- The activity database: watch history and progress (Phase 3c, P3c-1) -----
//
// Watch history is the biggest thing the site stores (about 4.5 GB at 100k
// accounts, NEXT_VERSION_ARCHITECTURE.md 3.4), so it lives in its own D1
// database, mylists-activity, bound as DB_ACTIVITY, with the tables of
// migrations/activity/A0001_activity.sql. Every query there is for one
// account, which is what lets it be split later.
//
// Always reach it through activityDb(env, accountId), never env.DB_ACTIVITY:
// that is the one place that decides which database holds an account.
// Today there is one. When it nears D1's size limit, the owner binds
// DB_ACTIVITY_1 ... DB_ACTIVITY_{N-1} next to it and sets
// ACTIVITY_SHARD_COUNT to N. Accounts then route by id % N. Changing N moves
// accounts between databases, so it goes with a copy job; it is not a
// switch to flip alone.
//
// Nothing calls this yet. The backfill (P3c-3), scrobbles (P3c-4) and the
// shelves (P3c-5) will. Without the binding every caller gets null and keeps
// the legacy tracking store.

const ACTIVITY_SHARD_MAX = 16;

// How many activity databases there are: ACTIVITY_SHARD_COUNT when every
// binding it names exists, else 1. A count whose bindings are missing would
// send accounts to a database that is not there, so it is not honored.
function activityShardCount(env) {
  const raw = Number.parseInt(String((env && env.ACTIVITY_SHARD_COUNT) || "1"), 10);
  const n = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), ACTIVITY_SHARD_MAX) : 1;
  for (let i = 1; i < n; i++) {
    if (!env[`DB_ACTIVITY_${i}`]) {
      console.error(`[activity] ACTIVITY_SHARD_COUNT is ${n} but DB_ACTIVITY_${i} is not bound: using one database.`);
      return 1;
    }
  }
  return n;
}

// Which activity database holds an account: 0 is DB_ACTIVITY, i is
// DB_ACTIVITY_i. Account ids are accounts.id (a positive integer).
function shardFor(env, accountId) {
  const n = activityShardCount(env);
  if (n <= 1) return 0;
  const id = Number(accountId);
  if (!Number.isSafeInteger(id) || id < 0) throw new Error(`shardFor: bad account id ${accountId}`);
  return id % n;
}

// The D1 binding for an account's activity, or null when the activity
// database is not bound (the caller keeps the legacy store).
function activityDb(env, accountId) {
  if (!env || !env.DB_ACTIVITY) return null;
  const shard = shardFor(env, accountId);
  return shard === 0 ? env.DB_ACTIVITY : env[`DB_ACTIVITY_${shard}`];
}

// Every activity database, for work that crosses accounts (the admin status
// panel, a copy job).
function activityDbs(env) {
  if (!env || !env.DB_ACTIVITY) return [];
  const n = activityShardCount(env);
  const out = [env.DB_ACTIVITY];
  for (let i = 1; i < n; i++) out.push(env[`DB_ACTIVITY_${i}`]);
  return out;
}

// Whether an activity database has A0001 applied. Remembered per database
// object (each test has its own), for a minute once true.
let activitySchemaCache = null;
async function activitySchemaReady(db) {
  if (!db) return false;
  const now = Date.now();
  if (activitySchemaCache && activitySchemaCache.db === db && activitySchemaCache.until > now) return true;
  try {
    const row = await db.prepare("SELECT version FROM schema_migrations WHERE version = 'A0001'").first();
    if (!row) return false;
    activitySchemaCache = { db, until: now + 60 * 1000 };
    return true;
  } catch (_) {
    return false;
  }
}

// The same play reported twice (the subtitles ping and the webhook, a retry,
// or two copies of one history entry) is one row: watch_events.dedupe_key
// is the account, the title, the episode and the watch time rounded down to
// ten minutes. Writers also skip a play within ten minutes either side of one
// already stored (a pair either side of a boundary has different keys).
const ACTIVITY_DEDUPE_WINDOW_MS = 10 * 60 * 1000;

function activityDedupeKey(accountId, mediaId, season, episode, watchedAt) {
  const s = season == null ? "" : String(season);
  const e = episode == null ? "" : String(episode);
  return `${accountId}:${mediaId}:${s}:${e}:${Math.floor(Number(watchedAt) / ACTIVITY_DEDUPE_WINDOW_MS)}`;
}
