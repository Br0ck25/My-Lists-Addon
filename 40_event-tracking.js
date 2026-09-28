
// --- The tracking record served from the activity database (P3c-6) ------------
//
// FF_EVENT_TRACKING (off). With it on, for an account whose history copy
// (P3c-3) has finished, the legacy tracking stores stop being written and
// the tracking record every route reads is put together from the activity
// database:
//
//   creatorsynctracking:{u}  (KV)  get -> assembled; put -> the diff shim below
//   creatorscrobblequeue:{u} (KV)  get -> nothing; put -> dropped
//   trackingd1behind:{u}     (KV)  get -> nothing; put -> dropped
//   the D1 tracking tables          not written (saveCreatorTrackingD1 and
//                                   saveAiringNextD1 return early), not read
//                                   (readCreatorTrackingD1 answers null, and
//                                   isTrackingD1Behind true, so the catalog
//                                   rows read the assembled record instead)
//
// It is done at the storage boundary (eventTrackingEnv wraps CONFIGS once, in
// the fetch and scheduled handlers) so the fifteen places that read or write
// the record -- save-tracking, /sync/load, the ping, the webhook, the crons,
// the catalog rows -- keep their code and their answers.
//
// Where each part of the record lives:
//   - Watch History: watch_events. A put inserts the entries v2 does not have
//     (a new play, the website's "mark watched"); an entry missing from a put
//     is removed only when the put is an intentional removal (save-tracking's
//     intentionalRemoval: Clear Watch History, deleting an entry) -- the same
//     rule the D1 tables followed.
//   - Show state (finished, dismissed, removed from Airing Next, companions):
//     show_progress, rebuilt from the events and the put's state on each put.
//   - Everything else (the settings, the Watchlist copy, Continue Watching and
//     Airing Next as the writers computed them, the stamps): a small JSON in
//     account_settings under "tracking". Continue Watching and Airing Next are
//     served from there until FF_SHOW_SCHEDULE (Phase 5) switches them to the
//     shelves worked out from show_schedule (39_activity-shelves.js).
//
// The flag is ONE-WAY per account: once an account is served from here its
// legacy stores stop moving, so turning it off shows them as they were.
// Accounts whose copy has not finished stay on the legacy stores until it
// has, and the copy's Start over is refused while the flag is on.

const EVENT_TRACKING_HISTORY_MAX = 5000;   // Watch History entries a record holds
const EVENT_TRACKING_CACHE_MS = 60 * 1000;
const EVENT_TRACKING_KEY = "creatorsynctracking:";

function isEventTrackingEnabled(env) {
  const v = env ? env.FF_EVENT_TRACKING : undefined;
  return (v === "1" || v === "true" || v === true) && !!(env && env.DB && env.DB_ACTIVITY);
}

// Whether this account's record is served from the activity database: the
// flag, the database, and a finished history copy. Remembered a minute per
// isolate, per database (each test has its own).
let eventTrackingOwnerCache = null;
async function eventTrackingOwns(env, username) {
  if (!isEventTrackingEnabled(env) || !username) return null;
  const now = Date.now();
  const db = env.DB;
  if (!eventTrackingOwnerCache || eventTrackingOwnerCache.db !== db) eventTrackingOwnerCache = { db, map: new Map() };
  const key = String(username).toLowerCase();
  const hit = eventTrackingOwnerCache.map.get(key);
  if (hit && hit.until > now) return hit.accountId;
  let accountId = null;
  try {
    const row = await db.prepare(
      `SELECT a.id FROM accounts a JOIN jobs j ON j.dedupe_key = 'migrate.activity:acct:' || a.id
       WHERE a.username = ? COLLATE NOCASE AND a.deleted_at IS NULL AND j.status = 'done'`
    ).bind(String(username)).first();
    accountId = row ? row.id : null;
  } catch {
    accountId = null;
  }
  // Only "yes" is remembered: an account whose copy finishes is served from
  // here on its next request.
  if (accountId != null) eventTrackingOwnerCache.map.set(key, { accountId, until: now + EVENT_TRACKING_CACHE_MS });
  return accountId;
}

async function readTrackingSettings(env, accountId) {
  const row = await env.DB.prepare("SELECT settings_json FROM account_settings WHERE account_id = ?").bind(accountId).first();
  let all = {};
  try {
    all = row && row.settings_json ? JSON.parse(row.settings_json) : {};
  } catch {
    all = {};
  }
  return { all: all && typeof all === "object" ? all : {}, tracking: all && all.tracking && typeof all.tracking === "object" ? all.tracking : null };
}

async function writeTrackingSettings(env, accountId, all, tracking) {
  const next = { ...all, tracking };
  await env.DB.prepare(
    `INSERT INTO account_settings (account_id, settings_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (account_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`
  ).bind(accountId, JSON.stringify(next), Date.now()).run();
}

// The record as the legacy routes read it.
async function assembleTrackingRecord(env, rawKv, username, accountId) {
  const settings = await readTrackingSettings(env, accountId);
  let rest = settings.tracking;
  if (!rest) {
    // The first read after the switch: everything but the history comes over
    // from the legacy record once.
    let legacy = null;
    try {
      legacy = JSON.parse((await rawKv.get(EVENT_TRACKING_KEY + username)) || "null");
    } catch {
      legacy = null;
    }
    rest = trackingRecordRest(legacy || {});
    await writeTrackingSettings(env, accountId, settings.all, rest);
  }
  const history = [];
  let cursor = null;
  do {
    const page = await watchHistoryPage(env, accountId, { cursor, limit: SHELF_HISTORY_PAGE_MAX });
    history.push(...page.items.map((it) => {
      const { mediaId, ...legacyItem } = it;
      return legacyItem;
    }));
    cursor = page.cursor;
  } while (cursor && history.length < EVENT_TRACKING_HISTORY_MAX);
  const record = { ...rest, watchHistory: history };
  if (isShowScheduleEnabled(env)) {
    const [cw, an] = await Promise.all([continueWatching(env, accountId), airingNext(env, accountId)]);
    record.continueWatching = cw.items.map(({ mediaId, ...it }) => it);
    record.airingNext = an.items.map(({ mediaId, ...it }) => it);
  }
  return record;
}

function isShowScheduleEnabled(env) {
  const v = env ? env.FF_SHOW_SCHEDULE : undefined;
  return v === "1" || v === "true" || v === true;
}

// Everything in a record but its Watch History.
function trackingRecordRest(record) {
  const { watchHistory, _intentionalRemoval, ...rest } = record && typeof record === "object" ? record : {};
  return rest;
}

// The diff shim: a record written by any route goes into the activity
// database. New entries become plays; with an intentional removal, plays
// the record no longer lists are removed; the show state is rebuilt.
async function saveTrackingRecord(env, username, accountId, record) {
  const intentional = !!(record && record._intentionalRemoval);
  const rest = trackingRecordRest(record);
  const settings = await readTrackingSettings(env, accountId);
  await writeTrackingSettings(env, accountId, settings.all, rest);

  const actDb = activityDb(env, accountId);
  const incoming = Array.isArray(record.watchHistory) ? record.watchHistory : [];
  const { results: storedRows } = await actDb.prepare(
    "SELECT id, legacy_id FROM watch_events WHERE account_id = ?"
  ).bind(accountId).all();
  const known = new Set((storedRows || []).map((r) => r.legacy_id).filter(Boolean));
  const listed = new Set();
  const fresh = [];
  for (const item of incoming) {
    if (!item || typeof item !== "object") continue;
    const id = legacyHistoryId(item);
    if (!id) continue;
    listed.add(id);
    if (!known.has(id)) fresh.push({ ...legacyHistoryPlay(item, Number(record.updatedAt) || Date.now()), id });
  }
  if (fresh.length) {
    for (let i = 0; i < fresh.length; i += ACTIVITY_BACKFILL_CHUNK) {
      const chunk = fresh.slice(i, i + ACTIVITY_BACKFILL_CHUNK);
      const { ids } = await resolveMediaBatch(env, chunk.map((p) => p.ref), { maxLookups: 20 });
      const rows = [];
      chunk.forEach((p, j) => {
        if (ids[j] != null) rows.push({ mediaId: ids[j], season: p.season, episode: p.episode, t: p.watchedAt, legacyId: p.id });
      });
      await insertActivityPlays(actDb, accountId, rows, "web");
    }
  }
  if (intentional) {
    // Only plays the website knows by id can be removed by leaving them out:
    // a play with no legacy id came from somewhere the website never listed.
    const gone = (storedRows || []).filter((r) => r.legacy_id && !listed.has(r.legacy_id)).map((r) => r.id);
    for (let i = 0; i < gone.length; i += 90) {
      const part = gone.slice(i, i + 90);
      await actDb.prepare(`DELETE FROM watch_events WHERE account_id = ? AND id IN (${part.map(() => "?").join(", ")})`).bind(accountId, ...part).run();
    }
  }
  const legacy = {
    kv: {
      updatedAt: Number(record.updatedAt) || Date.now(),
      watchHistory: [],
      continueWatching: Array.isArray(record.continueWatching) ? record.continueWatching : [],
      fullyWatched: Array.isArray(record.fullyWatchedShowIds) ? record.fullyWatchedShowIds.map(String) : [],
      dismissed: record.dismissedContinueWatching && typeof record.dismissedContinueWatching === "object" ? record.dismissedContinueWatching : {},
      removedAiring: record.removedAiringNext && typeof record.removedAiringNext === "object" ? record.removedAiringNext : {},
    },
    d1: null,
    queue: { watchHistory: [], continueWatching: [] },
  };
  await rebuildActivityProgress(env, actDb, accountId, legacy, { lookups: 20 }, emptyActivityRecon());
}

// The env every handler runs with: CONFIGS wrapped for the tracking keys of
// accounts served from the activity database. Unchanged without the flag.
function eventTrackingEnv(env) {
  if (!isEventTrackingEnabled(env) || !env.CONFIGS) return env;
  const kv = env.CONFIGS;
  const owner = (key, prefix) => (String(key).startsWith(prefix) ? String(key).slice(prefix.length) : null);
  const wrapped = {
    get: async (key, ...rest) => {
      const u = owner(key, EVENT_TRACKING_KEY);
      if (u) {
        const accountId = await eventTrackingOwns(env, u);
        if (accountId != null) {
          const record = await assembleTrackingRecord(env, kv, u, accountId);
          const type = rest[0] && typeof rest[0] === "object" ? rest[0].type : rest[0];
          return type === "json" ? record : JSON.stringify(record);
        }
      }
      for (const prefix of ["creatorscrobblequeue:", "trackingd1behind:"]) {
        const q = owner(key, prefix);
        if (q && (await eventTrackingOwns(env, q)) != null) return prefix === "trackingd1behind:" ? "1" : null;
      }
      return kv.get(key, ...rest);
    },
    put: async (key, value, ...rest) => {
      const u = owner(key, EVENT_TRACKING_KEY);
      if (u) {
        const accountId = await eventTrackingOwns(env, u);
        if (accountId != null) {
          let record = null;
          try {
            record = typeof value === "string" ? JSON.parse(value) : null;
          } catch {
            record = null;
          }
          if (record && typeof record === "object") return saveTrackingRecord(env, u, accountId, record);
          return undefined;
        }
      }
      for (const prefix of ["creatorscrobblequeue:", "trackingd1behind:"]) {
        const q = owner(key, prefix);
        if (q && (await eventTrackingOwns(env, q)) != null) return undefined;
      }
      return kv.put(key, value, ...rest);
    },
    delete: async (key, ...rest) => {
      const u = owner(key, EVENT_TRACKING_KEY);
      if (u) {
        const accountId = await eventTrackingOwns(env, u);
        if (accountId != null) {
          // The account's tracking is being wiped (account reset or delete).
          const actDb = activityDb(env, accountId);
          await actDb.batch([
            actDb.prepare("DELETE FROM watch_events WHERE account_id = ?").bind(accountId),
            actDb.prepare("DELETE FROM show_progress WHERE account_id = ?").bind(accountId),
            actDb.prepare("DELETE FROM user_media_state WHERE account_id = ?").bind(accountId),
          ]);
          const settings = await readTrackingSettings(env, accountId);
          const { tracking, ...others } = settings.all;
          await writeTrackingSettings(env, accountId, others, {});
        }
      }
      return kv.delete(key, ...rest);
    },
  };
  for (const name of ["list", "getWithMetadata"]) {
    if (typeof kv[name] === "function") wrapped[name] = (...a) => kv[name](...a);
  }
  return new Proxy(env, {
    get(target, prop, receiver) {
      if (prop === "CONFIGS") return wrapped;
      return Reflect.get(target, prop, receiver);
    },
  });
}
