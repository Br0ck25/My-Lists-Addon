
// --- Recording one play directly (audit PERF-01) ------------------------------
//
// Behind FF_DIRECT_PLAY ("1" or "true"; anything else, or unset, is off -- set it
// to "0" in the dashboard to turn it off again, no deploy). The Plex/Jellyfin/Emby
// webhook (64_) and the Stremio/Nuvio ping (63_) used to treat a play as an edit
// of the account's whole tracking record: read the record (for an account on the
// activity database that rebuilds EVERY play, 40_event-tracking.js), change it,
// put it back (a diff of every stored play, then a rebuild of all show progress).
// One play cost work proportional to the account's history -- about 300 database
// statements at 5,000 plays, and past Cloudflare's 1,000-call limit near 18,000,
// where plays were dropped.
//
// Here an account served from the activity database records the play itself:
//   - the play: recordActivityPlay (38_), one batch, whatever the history size;
//   - the record's other parts (Continue Watching, fully watched, dismissals, the
//     Watchlist copy, the settings, the updated stamp): the small "tracking" JSON
//     in account_settings, which is the record without its Watch History;
//   - the show's state: show_progress.status, completed or not.
// The three things the blob path did and recordActivityPlay alone does not are kept
// by running the SAME next-episode code on a record whose Watch History holds only
// the show's furthest watched episode:
//   1. the next episode and "fully watched" decision (and un-completing a show);
//   2. the first Continue Watching entry of a show the schedule does not know yet;
//   3. the stamp other open tabs poll (settings.tracking.updatedAt, sync/meta).
//
// Not used (the old path runs unchanged) when the switch is off, FF_EVENT_TRACKING
// is off, the account's history has not been copied yet, or its settings have not
// been stored yet (the first read after the switch assembles and stores them).

function isDirectPlayEnabled(env) {
  const v = env ? env.FF_DIRECT_PLAY : undefined;
  return v === "1" || v === "true" || v === true;
}

// The account id when plays are recorded directly for this account, else null.
async function directPlayAccount(env, username) {
  if (!isDirectPlayEnabled(env) || !isEventTrackingEnabled(env) || !username) return null;
  return eventTrackingOwns(env, username);
}

// The record without its Watch History, as the play code expects to find it, or
// null when the old path has to run.
async function directPlayLoad(env, username) {
  const accountId = await directPlayAccount(env, username);
  if (accountId == null) return null;
  const { tracking } = await readTrackingSettings(env, accountId);
  if (!tracking) return null;
  const blob = { ...tracking, watchHistory: [] };
  await ensureTrackingWatchlist(env, username, blob);
  blob.continueWatching = Array.isArray(blob.continueWatching) ? blob.continueWatching : [];
  blob.fullyWatchedShowIds = Array.isArray(blob.fullyWatchedShowIds) ? blob.fullyWatchedShowIds : [];
  blob.dismissedContinueWatching = blob.dismissedContinueWatching && typeof blob.dismissedContinueWatching === "object" ? blob.dismissedContinueWatching : {};
  return { accountId, blob };
}

// What the next-episode code needs of the show's history: its furthest watched
// episode (it works the next one out from that). One indexed lookup. `showId` is
// the key the show is filed under in the record (the code matches on it).
async function directPlayShowHistory(env, direct, { showId, showTitle, showPoster, season, episode }) {
  const ref = legacyHistoryPlay({ type: "episode", showId, showTitle, seasonNum: season, episodeNum: episode }, 0).ref;
  const { ids } = await resolveMediaBatch(env, [ref], { maxLookups: 1 });
  if (ids[0] == null) return [];
  const far = await activityDb(env, direct.accountId).prepare(
    `SELECT season, episode FROM watch_events WHERE account_id = ? AND media_id = ? AND season IS NOT NULL AND episode IS NOT NULL
     ORDER BY season DESC, episode DESC LIMIT 1`
  ).bind(direct.accountId, ids[0]).first();
  if (!far) return [];
  return [{ id: `${showId}:${far.season}:${far.episode}`, type: "episode", showId, showTitle: showTitle || "", showPoster: showPoster || "", seasonNum: far.season, episodeNum: far.episode }];
}

// Writes the play (the entry at the top of the record's Watch History) and the
// rest of the record's changes. Returns recordActivityPlay's answer.
async function directPlayCommit(env, username, direct, blob, source) {
  const entry = blob.watchHistory[0];
  const res = await recordActivityPlay(env, username, activityPlayFromLegacyEntry(entry), source);
  if (res.reason === "error") throw new Error("could not record the play in the activity database");
  const settings = await readTrackingSettings(env, direct.accountId);
  await writeTrackingSettings(env, direct.accountId, settings.all, trackingRecordRest(blob));
  // The show's own state: finished, or not (the rebuild the old path ran did this for every show).
  if (res.mediaId != null && entry && String(entry.type) === "episode") {
    const done = blob.fullyWatchedShowIds.map(String).includes(String(entry.showId));
    const actDb = activityDb(env, direct.accountId);
    await actDb.prepare(
      done
        ? "UPDATE show_progress SET status = 'completed', updated_at = ? WHERE account_id = ? AND media_id = ? AND status = 'watching'"
        : "UPDATE show_progress SET status = 'watching', updated_at = ? WHERE account_id = ? AND media_id = ? AND status = 'completed'"
    ).bind(Date.now(), direct.accountId, res.mediaId).run();
  }
  // A new play goes on to the apps with two-way sync on, as a website save does.
  if (res.recorded && typeof nudgeMediaAppPush === "function") await nudgeMediaAppPush(env, direct.accountId);
  return res;
}
