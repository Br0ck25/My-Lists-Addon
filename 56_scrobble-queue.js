// --- The scrobble queue: a fallback for a record not yet readable -------------
//
// creatorscrobblequeue:{user} holds the last 20 plays the two scrobble paths
// recorded (handleSubtitlesTrack and the media server webhook, 26_), written
// right after the tracking record itself. It exists for one case: that record
// not being readable yet -- KV at another edge up to a minute behind, or a D1
// write that failed.
//
// sync/load and save-tracking used to merge it in on every call, whatever the
// record said. So a recent play the owner removed from Watch History or
// Continue Watching came straight back on the next load, and the next autosave
// stored it again: the removal never held for anything among the last 20
// plays.
//
// Each write now stamps the queue with the updatedAt of the record written
// alongside it (recordUpdatedAt). A record at least that new already holds
// everything the queue does, or has removed it since on purpose, so the queue
// is merged only when the record read is OLDER than the queue -- the one case
// it is for. A queue written before the stamp existed is merged only when
// there is no record at all.
//
// Module level, after the Worker's exports, like 27_ onward.

// { watchHistory, continueWatching, recordUpdatedAt } from the stored value,
// or null. The oldest format is a bare array of Watch History entries.
function parseScrobbleQueue(raw) {
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) {
    return { watchHistory: parsed, continueWatching: [], recordUpdatedAt: 0 };
  }
  if (!parsed || typeof parsed !== "object") return null;
  return {
    watchHistory: Array.isArray(parsed.watchHistory) ? parsed.watchHistory : [],
    continueWatching: Array.isArray(parsed.continueWatching) ? parsed.continueWatching : [],
    recordUpdatedAt: Number(parsed.recordUpdatedAt) || 0,
  };
}

// Whether the queue holds plays the tracking record read does not reflect
// yet. `record` is the record the caller read (anything with an updatedAt),
// or null when the account has none.
function scrobbleQueueIsAhead(queue, record) {
  if (!queue) return false;
  if (!record) return true;
  return queue.recordUpdatedAt > (Number(record.updatedAt) || 0);
}

// The Continue Watching filter save-tracking's merges already apply: never
// bring back a show marked fully watched -- which is also what dismissing a
// show from Continue Watching marks it (dismissContinueWatchingShow).
function scrobbleCwIsFullyWatched(item, fullyWatchedSet) {
  if (!item || item.isCompanion) return false;
  const key = String(item.showId || item.id || "");
  if (!key) return false;
  return fullyWatchedSet.has(key) || fullyWatchedSet.has(trackingShowKey(key)) ||
    (item.showId != null && fullyWatchedSet.has(String(item.showId)));
}

// An intentional removal replaces Watch History with exactly what the browser
// sent. A play a scrobble recorded AFTER that browser last loaded the account
// cannot be in it -- the browser never saw it -- so it is not part of what was
// removed. These are those plays: entries of the stored record that a
// scrobble wrote (their id is in the queue) with a watchedAt newer than the
// record version the browser loaded (seenAt), and missing from the push.
//
// seenAt is the trackingUpdatedAt sync/load handed the browser; a browser
// that does not send one gets none of this, as before. A scrobble's
// watchedAt is taken just before the record's updatedAt, so a play the
// browser has loaded is never newer than seenAt.
function scrobblePlaysUnseenBy(queue, existingBlob, seenAt, incomingIds) {
  const since = Number(seenAt);
  if (!queue || !existingBlob || !Number.isFinite(since) || since <= 0) return [];
  const queued = new Set(queue.watchHistory.filter((it) => it && it.id).map((it) => String(it.id)));
  if (!queued.size) return [];
  const stored = Array.isArray(existingBlob.watchHistory) ? existingBlob.watchHistory : [];
  return stored.filter((it) => it && it.id &&
    queued.has(String(it.id)) &&
    !incomingIds.has(String(it.id)) &&
    (Number(it.watchedAt) || 0) > since);
}
