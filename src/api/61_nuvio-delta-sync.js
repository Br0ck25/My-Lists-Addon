// Nuvio pull by event cursor (the public API's "incremental sync", v1.2+).
//
// The first pull of a profile reads everything (nuvioFetchProfile, 61_media-app-sync.js).
// Before that read it asks Nuvio for the current history and progress event ids,
// so changes made while it reads are not missed. When the pull finishes those ids
// are kept in media_app_sync.cursor_json as `delta`. Every later pull asks only
// for events after them (sync_pull_watched_items_delta, sync_pull_watch_progress_delta),
// applies them in event order and moves the cursors on.
//
// Rules this file keeps:
//   * A failed or missing cursor never fails the pull: it reads everything instead.
//   * Watch history deletes are read but NOT applied: history here is merge-only
//     (the same rule two-way sync has), so a delete in Nuvio never removes a play.
//   * A progress delete clears the stored Continue Watching point only when it is
//     that point (same season and episode), never another episode's.
//   * The Continue Watching point already stored for a changed title is fed back in
//     as one more progress row, so nuvioRecords weighs it against the new plays
//     exactly as it does in a full read.

const NUVIO_DELTA_LIMIT = 1000;
const NUVIO_DELTA_MAX_PAGES = 50;

// Event ids now, or null when Nuvio does not answer or answers nonsense. Throws
// only when Nuvio refuses the sign-in (kind "invalid").
async function nuvioCaptureCursors(env, token, profileIndex) {
  try {
    const history = Number(await nuvioRpc(env, token, "sync_get_watched_items_delta_cursor", { p_profile_id: profileIndex }));
    const progress = Number(await nuvioRpc(env, token, "sync_get_watch_progress_delta_cursor", { p_profile_id: profileIndex }));
    if (!Number.isSafeInteger(history) || history < 0 || !Number.isSafeInteger(progress) || progress < 0) return null;
    return { history, progress, profile: profileIndex };
  } catch (e) {
    if (e && e.kind === "invalid") throw e;
    return null;
  }
}

// The cursors kept from a finished pull of this profile, or null.
function nuvioStoredDelta(cursor, profileIndex) {
  const d = cursor && cursor.delta;
  if (!d || cursor.provenanceVersion !== 1 || d.profile !== profileIndex) return null;
  return Number.isSafeInteger(d.history) && Number.isSafeInteger(d.progress) ? d : null;
}

// Every event after `since` up to and including `to`, oldest first.
async function nuvioPullEvents(env, token, fn, profileIndex, since, to) {
  const out = [];
  let after = since;
  for (let page = 0; page < NUVIO_DELTA_MAX_PAGES; page++) {
    const rows = await nuvioRpc(env, token, fn, { p_profile_id: profileIndex, p_since_event_id: after, p_limit: NUVIO_DELTA_LIMIT });
    if (!Array.isArray(rows)) throw mediaAppError("unreachable", "Nuvio sent invalid changes.");
    for (const row of rows) {
      const id = Number(row && row.event_id);
      if (!Number.isSafeInteger(id) || id <= after || !["upsert", "delete"].includes(row.operation)) throw mediaAppError("unreachable", "Nuvio sent a change we could not read.");
      after = id;
      if (id <= to) out.push(row);
    }
    if (rows.length < NUVIO_DELTA_LIMIT || after >= to) return out;
  }
  throw mediaAppError("unreachable", "Nuvio has too many changes to read at once.");
}

// What a title is called in the stored resume map (the key mediaAppResumeChanges makes).
function nuvioTitleKey(row) {
  const id = mediaAppTitleId(mediaAppPick(row, "content_id", "contentId"));
  if (!id) return null;
  const kind = mediaAppInt(row.season) != null && mediaAppInt(row.episode) != null ? "series" : (mediaAppKind(mediaAppPick(row, "content_type", "contentType")) || "movie");
  return id.imdbId || `${kind}|tmdb:${id.tmdbId}`;
}

// Events oldest to newest, the last one for each key standing.
function nuvioLastByKey(events, keyOf) {
  const by = new Map();
  for (const e of events) by.set(keyOf(e), e);
  return [...by.values()];
}

function nuvioEventKey(e) {
  return `${String(mediaAppPick(e, "content_id", "contentId") || "").toLowerCase()}|${mediaAppInt(e.season) == null ? "" : mediaAppInt(e.season)}|${mediaAppInt(e.episode) == null ? "" : mediaAppInt(e.episode)}`;
}

// A stored resume point as the progress row nuvioRecords reads.
function nuvioResumeRow(key, r) {
  return { content_id: key.includes("|") ? key.split("|")[1] : key, content_type: r.kind, season: r.season, episode: r.episode, position: r.position, duration: r.duration, last_watched: r.at };
}

// The changes since `base` as the rows nuvioRecords reads, plus the resume keys
// Nuvio dropped. `resumes` is the stored map ({ key: { kind, season, episode, position, duration, at } }).
async function nuvioReadChanges(env, token, profileIndex, base, to, resumes) {
  const stored = resumes && typeof resumes === "object" ? resumes : {};
  const history = await nuvioPullEvents(env, token, "sync_pull_watched_items_delta", profileIndex, base.history, to.history);
  const progressEvents = await nuvioPullEvents(env, token, "sync_pull_watch_progress_delta", profileIndex, base.progress, to.progress);
  const watched = nuvioLastByKey(history, nuvioEventKey).filter((e) => e.operation === "upsert");
  const progress = [];
  const cleared = new Set();
  for (const e of nuvioLastByKey(progressEvents, (x) => String(mediaAppPick(x, "progress_key", "progressKey") || nuvioEventKey(x)))) {
    if (e.operation === "upsert") {
      progress.push(e);
      continue;
    }
    const key = nuvioTitleKey(e);
    const point = key && stored[key];
    if (point && (point.season == null ? null : point.season) === mediaAppInt(e.season) && (point.episode == null ? null : point.episode) === mediaAppInt(e.episode)) cleared.add(key);
  }
  const touched = new Set([...watched, ...progress].map(nuvioTitleKey).filter(Boolean));
  for (const key of touched) if (stored[key] && !cleared.has(key)) progress.push(nuvioResumeRow(key, stored[key]));
  return { watched, progress, cleared: [...cleared] };
}

// Reads what this step needs. { mode: "delta" | "snapshot", profile, cleared, pending }.
// `pending` is the cursor pair to keep when the pull finishes (null if Nuvio gave none).
// It is taken on the first step and carried in cursor_json.pendingDelta for the rest.
// `step` = { offset, cursor, delta } where delta says a delta read may be tried.
async function nuvioReadProfile(env, token, profileIndex, step) {
  const cursor = step.cursor || {};
  const carried = step.offset > 0 && cursor.pendingDelta && cursor.pendingDelta.profile === profileIndex ? cursor.pendingDelta : null;
  const pending = carried || await nuvioCaptureCursors(env, token, profileIndex);
  const base = step.delta ? nuvioStoredDelta(cursor, profileIndex) : null;
  if (pending && base && pending.history >= base.history && pending.progress >= base.progress) {
    try {
      return { mode: "delta", pending, ...(await nuvioReadChanges(env, token, profileIndex, base, pending, cursor.resumes)) };
    } catch (e) {
      if (e && e.kind === "invalid") throw e;
      console.error("mediaapp: Nuvio change feed failed, reading everything", e);
    }
  }
  return { mode: "snapshot", pending, cleared: [], profile: await nuvioFetchProfile(env, token, profileIndex) };
}
