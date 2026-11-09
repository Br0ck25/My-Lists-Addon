// Stored playback positions, and Nuvio "mirroring" (activity migration A0003).
//
// Positions. Where a person stopped in a title (position and length in
// milliseconds) is kept in watch_positions, one row per account, title and
// source. Nuvio is the only source that reports one today. A title that is
// finished, or whose progress Nuvio deleted, has no row.
//
// Mirroring (off until the person turns it on, per account; kept as `mirror` in
// media_app_sync.cursor_json). With it on, a watched item deleted in Nuvio is
// removed here too, with these limits:
//   * only deletions made from now on: they come from the change feed, which a
//     full read cannot replace, so a full read never deletes anything;
//   * a play another app also reported is never deleted: only Nuvio's claim on it
//     goes (ownership moves to the other app, as the tile remove button does);
//   * every play actually removed is copied to watch_events_removed first and can
//     be restored for NUVIO_REMOVED_KEEP_MS (30 days), then it is purged.
// Without A0003 positions are not stored and mirroring cannot be turned on; the
// rest of the sync is unaffected.

const NUVIO_REMOVED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

async function mediaAppPositionsReady(actDb) {
  try {
    return Boolean(await actDb.prepare("SELECT version FROM schema_migrations WHERE version = 'A0003'").first());
  } catch {
    return false;
  }
}

function mediaAppMirrorOn(row) {
  try {
    return Boolean(row && row.cursor_json && JSON.parse(row.cursor_json).mirror === true);
  } catch {
    return false;
  }
}

// Statements that make watch_positions match what the app says about these
// titles: a row for one part way through (with a known length), none otherwise.
function mediaAppPositionStatements(actDb, accountId, provider, usable, now) {
  return usable.map((r) => {
    const resume = r.resume && r.resume.duration > 0 && r.resume.position >= 0 ? r.resume : null;
    if (!resume) return actDb.prepare("DELETE FROM watch_positions WHERE account_id = ? AND media_id = ? AND source = ?").bind(accountId, r.mediaId, provider);
    return actDb.prepare(
      `INSERT INTO watch_positions (account_id, media_id, source, season, episode, position_ms, duration_ms, watched_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, media_id, source) DO UPDATE SET season = excluded.season, episode = excluded.episode,
         updated_at = CASE WHEN position_ms IS excluded.position_ms AND duration_ms IS excluded.duration_ms AND season IS excluded.season AND episode IS excluded.episode
           THEN updated_at ELSE excluded.updated_at END,
         position_ms = excluded.position_ms, duration_ms = excluded.duration_ms, watched_at = excluded.watched_at`
    ).bind(accountId, r.mediaId, provider, r.kind === "series" ? resume.season : null, r.kind === "series" ? resume.episode : null,
      Math.round(resume.position), Math.round(resume.duration), resume.at || r.at || now, now);
  });
}

// A record with nothing in it, standing for a resume point Nuvio dropped, so the
// normal write path clears the stored point and position for that title.
function nuvioClearedStub(key, kind) {
  const tmdb = key.includes("|") ? /tmdb:(\d+)$/.exec(key) : null;
  const id = tmdb ? { tmdbId: Number(tmdb[1]) } : { imdbId: key };
  return { ...id, kind: kind === "series" ? "series" : "movie", title: "", poster: "", mtime: 0, plays: [], furthest: null, at: 1, resume: null };
}

// The local plays of the same episode (or movie) that Nuvio claimed, within the
// play window of the deleted one.
async function nuvioClaimedPlays(actDb, accountId, provider, mediaId, play) {
  const { results } = await actDb.prepare(
    `SELECT id, source, watched_at, season, episode, dedupe_key, legacy_id FROM watch_events
     WHERE account_id = ? AND media_id = ? AND season IS ? AND episode IS ?
       AND (source = ? OR EXISTS (SELECT 1 FROM watch_event_sources s WHERE s.event_id = watch_events.id AND s.source = ?))`
  ).bind(accountId, mediaId, play.season, play.episode, provider, provider).all();
  return (results || []).filter((e) => !play.watchedAt || Math.abs(Number(e.watched_at) - play.watchedAt) < MEDIA_APP_PLAY_WINDOW_MS);
}

// Applies Nuvio's deletions of watched items here. `removed` = [{ imdbId, tmdbId, kind, season, episode, watchedAt }].
// Returns how many plays were removed (plays that stay because another app also
// reported them are not counted).
async function mirrorRemovePlays(env, accountId, provider, removed) {
  const actDb = activityDb(env, accountId);
  if (!removed.length || !actDb || !(await mediaAppPositionsReady(actDb))) return 0;
  const refs = removed.map((r) => normalizeMediaRef({ imdbId: r.imdbId, tmdbId: r.tmdbId, kind: r.kind, title: "" }));
  const known = indexMediaRows(await lookupMediaRows(env, refs.filter(Boolean)));
  const now = Date.now();
  let count = 0;
  for (let i = 0; i < removed.length; i++) {
    const row = refs[i] ? matchMediaRow(known, refs[i]) : null;
    if (!row) continue;
    for (const e of await nuvioClaimedPlays(actDb, accountId, provider, row.id, removed[i])) {
      const { results: others } = await actDb.prepare("SELECT source FROM watch_event_sources WHERE event_id = ? AND source != ? ORDER BY source").bind(e.id, provider).all();
      const stmts = [actDb.prepare("DELETE FROM watch_event_sources WHERE event_id = ? AND source = ?").bind(e.id, provider)];
      if (e.source !== provider) {
        // Another app's play that Nuvio also reported: only Nuvio's claim goes.
      } else if (others && others.length) {
        stmts.push(actDb.prepare("UPDATE watch_events SET source = ? WHERE id = ?").bind(others[0].source, e.id));
      } else {
        stmts.unshift(actDb.prepare(
          `INSERT INTO watch_events_removed (account_id, media_id, season, episode, watched_at, source, dedupe_key, legacy_id, sources_json, removed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`
        ).bind(accountId, row.id, e.season, e.episode, e.watched_at, provider, e.dedupe_key, e.legacy_id, now));
        stmts.push(actDb.prepare("DELETE FROM watch_events WHERE id = ?").bind(e.id));
        count++;
      }
      await actDb.batch(stmts);
    }
  }
  return count;
}

// Puts back the plays mirroring removed (all of them for this app that are still kept).
async function restoreRemovedPlays(env, accountId, provider) {
  const actDb = activityDb(env, accountId);
  if (!actDb || !(await mediaAppPositionsReady(actDb))) return 0;
  const { results } = await actDb.prepare("SELECT id FROM watch_events_removed WHERE account_id = ? AND source = ?").bind(accountId, provider).all();
  const ids = (results || []).map((r) => r.id);
  if (!ids.length) return 0;
  const idsJson = JSON.stringify(ids);
  await actDb.batch([
    actDb.prepare(
      `INSERT OR IGNORE INTO watch_events (account_id, media_id, season, episode, watched_at, source, dedupe_key, legacy_id)
       SELECT account_id, media_id, season, episode, watched_at, source, dedupe_key, legacy_id FROM watch_events_removed WHERE id IN (SELECT value FROM json_each(?))`
    ).bind(idsJson),
    actDb.prepare("DELETE FROM watch_events_removed WHERE id IN (SELECT value FROM json_each(?))").bind(idsJson),
  ]);
  return ids.length;
}

async function purgeRemovedPlays(env, accountId) {
  const actDb = activityDb(env, accountId);
  if (!actDb || !(await mediaAppPositionsReady(actDb))) return;
  await actDb.prepare("DELETE FROM watch_events_removed WHERE account_id = ? AND removed_at < ?").bind(accountId, Date.now() - NUVIO_REMOVED_KEEP_MS).run();
}

// --- Sending positions recorded here to Nuvio ---------------------------------------------
//
// Only positions from another source (never Nuvio's own), only part way through
// (90% or more is a finished play, which the history push covers), and only when
// Nuvio has no progress for that title and episode that is as new or newer, or a
// watched item at least as new: a progress push replaces what Nuvio holds under
// that key, so it must never replace something real with something older.
// Behind the same switches as the history push. Returns how many were sent.
async function pushNuvioPositions(env, accountId, conn, sync, actDb) {
  if (!(await mediaAppPositionsReady(actDb))) return 0;
  const { results } = await actDb.prepare(
    `SELECT media_id, season, episode, position_ms, duration_ms, watched_at, updated_at FROM watch_positions
     WHERE account_id = ? AND source != 'nuvio' AND (pushed_at IS NULL OR updated_at > pushed_at) ORDER BY updated_at LIMIT ?`
  ).bind(accountId, MEDIA_APP_PUSH_EVENTS).all();
  const rows = results || [];
  if (!rows.length) return 0;
  const { results: media } = await env.DB.prepare("SELECT id, imdb_id FROM media WHERE id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify([...new Set(rows.map((r) => r.media_id))])).all();
  const imdbOf = new Map((media || []).filter((m) => m.imdb_id).map((m) => [m.id, m.imdb_id]));
  const profile = await nuvioFetchProfile(env, conn.accessToken, sync.profile_index);
  const slot = (id, season, episode) => `${String(id || "").toLowerCase()}|${season == null ? "" : season}|${episode == null ? "" : episode}`;
  const newest = new Map();
  for (const p of profile.progress) {
    const k = slot(mediaAppPick(p, "content_id", "contentId"), mediaAppInt(p.season), mediaAppInt(p.episode));
    newest.set(k, Math.max(newest.get(k) || 0, mediaAppTime(mediaAppPick(p, "last_watched", "lastWatched"))));
  }
  for (const w of profile.watched) {
    const k = slot(mediaAppPick(w, "content_id", "contentId"), mediaAppInt(w.season), mediaAppInt(w.episode));
    newest.set(k, Math.max(newest.get(k) || 0, mediaAppTime(mediaAppPick(w, "watched_at", "watchedAt"))));
  }
  const entries = [];
  for (const r of rows) {
    const id = imdbOf.get(r.media_id);
    const at = Number(r.watched_at);
    if (!id || !(r.duration_ms > 0) || r.position_ms / r.duration_ms >= MEDIA_APP_FINISHED || (newest.get(slot(id, r.season, r.episode)) || 0) >= at) continue;
    const series = r.season != null && r.episode != null;
    entries.push({ content_id: id, content_type: series ? "series" : "movie", video_id: series ? `${id}:${r.season}:${r.episode}` : id,
      ...(series ? { season: r.season, episode: r.episode } : {}), position: r.position_ms, duration: r.duration_ms, last_watched: at });
  }
  for (let i = 0; i < entries.length; i += MEDIA_APP_PUSH_CHUNK) {
    await nuvioRpc(env, conn.accessToken, "sync_push_watch_progress", { p_profile_id: sync.profile_index, p_entries: entries.slice(i, i + MEDIA_APP_PUSH_CHUNK) });
  }
  // Every row looked at is marked, sent or not, so a skipped one is not retried until it changes.
  const now = Date.now();
  await actDb.prepare("UPDATE watch_positions SET pushed_at = ? WHERE account_id = ? AND source != 'nuvio' AND updated_at <= ? AND (pushed_at IS NULL OR updated_at > pushed_at) AND media_id IN (SELECT value FROM json_each(?))")
    .bind(now, accountId, Math.max(...rows.map((r) => Number(r.updated_at))), JSON.stringify([...new Set(rows.map((r) => r.media_id))])).run();
  return entries.length;
}

// POST /api/connections/:provider/settings: pull, push, mirror, and the chosen profile.
async function mediaAppSaveSettings(env, accountId, provider, body) {
  const row = await loadMediaAppSync(env, accountId, provider);
  if (!row) return json({ ok: false, error: "That account isn't connected." }, 404);
  const sets = [];
  const binds = [];
  if (body.pull != null) {
    sets.push("pull_enabled = ?");
    binds.push(body.pull ? 1 : 0);
  }
  if (body.push != null) {
    if (body.push && !mediaAppPushFlag(env)) return json({ ok: false, error: "Two-way sync isn't switched on yet." }, 409);
    sets.push("push_enabled = ?");
    binds.push(body.push ? 1 : 0);
  }
  // Mirroring lives in cursor_json (no column), so it is rewritten with the cursor and kept across a profile change.
  let mirror = mediaAppMirrorOn(row);
  if (body.mirror != null) {
    if (provider !== "nuvio") return json({ ok: false, error: "Mirroring is only for Nuvio." }, 400);
    const actDb = activityDb(env, accountId);
    if (body.mirror && !(actDb && await mediaAppPositionsReady(actDb))) return json({ ok: false, error: "The activity database needs migration A0003 before mirroring can be turned on." }, 409);
    mirror = Boolean(body.mirror);
    if (body.profileIndex == null) {
      let current = {};
      try {
        current = row.cursor_json ? JSON.parse(row.cursor_json) : {};
      } catch {}
      if (mirror) current.mirror = true;
      else delete current.mirror;
      sets.push("cursor_json = ?");
      binds.push(JSON.stringify(current));
    }
  }
  if (body.profileIndex != null) {
    const idx = mediaAppInt(body.profileIndex);
    if (idx == null || idx < 1 || idx > 6) return json({ ok: false, error: "Choose one of your profiles." }, 400);
    // A new profile starts its pull over; the profile names are kept.
    const keep = {};
    const names = mediaAppProfilesOf(row);
    if (names.length) keep.profiles = names;
    const last = mediaAppLastResultOf(row);
    if (last) keep.last = last;
    if (mirror) keep.mirror = true;
    sets.push("profile_index = ?", "cursor_json = ?", "last_pull_at = NULL");
    binds.push(idx, Object.keys(keep).length ? JSON.stringify(keep) : null);
  }
  if (sets.length) {
    await env.DB.prepare(`UPDATE media_app_sync SET ${sets.join(", ")}, updated_at = ? WHERE account_id = ? AND provider = ?`)
      .bind(...binds, Date.now(), accountId, provider).run();
    if (body.profileIndex != null || body.pull || body.push) await startMediaAppSync(env, accountId, provider);
  }
  return json({ ok: true, sync: mediaAppSyncSummary(await loadMediaAppSync(env, accountId, provider)) });
}

// POST /api/connections/nuvio/restore-removed: puts back the plays mirroring removed.
async function mediaAppRestoreRoute(env, accountId, provider) {
  if (provider !== "nuvio") return json({ ok: false, error: "Only Nuvio mirroring removes plays." }, 400);
  return json({ ok: true, restored: await restoreRemovedPlays(env, accountId, provider) });
}

// A remove request for one episode: { season, episode } when the body names both, null when
// it names neither, false when it names only one (a request that cannot be honoured).
function mediaAppEpisodeOf(body) {
  const season = mediaAppInt(body.season);
  const episode = mediaAppInt(body.episode);
  if (season == null && episode == null) return null;
  return season != null && episode != null ? { season, episode } : false;
}

// --- Sending positions recorded here to Stremio ---------------------------------------------
//
// A position from any app but Stremio itself (Nuvio's, Plex's, Jellyfin's, Emby's, Trakt's) is
// written on that title's library item as Stremio's own resume point: timeOffset and duration
// (milliseconds), lastWatched, and for a show video_id, the episode it is at ("tt123:1:3").
// Nothing else on the item changes: not which episodes are watched, not the watched counts.
// Rules: only part way through (90% or more is a finished play, which the history push covers);
// only titles already in the person's library; only when the item's lastWatched is older than the
// position, so a resume point Stremio already holds that is as new or newer is never replaced.
// Behind the same switches as the history push. The pushed_at column is Nuvio's; this keeps its
// own place in the sync state (positionsPushedAt, the newest updated_at looked at), so sending to
// one app never hides a position from the other. Returns how many items were written.
async function pushStremioPositions(env, accountId, conn, actDb, cursor) {
  if (!(await mediaAppPositionsReady(actDb))) return 0;
  const since = Number(cursor.positionsPushedAt) || 0;
  const { results } = await actDb.prepare(
    "SELECT media_id, season, episode, position_ms, duration_ms, watched_at, updated_at FROM watch_positions WHERE account_id = ? AND source != 'stremio' AND updated_at > ? ORDER BY updated_at LIMIT ?"
  ).bind(accountId, since, MEDIA_APP_PUSH_EVENTS).all();
  const rows = results || [];
  if (!rows.length) return 0;
  const { results: media } = await env.DB.prepare("SELECT id, kind, imdb_id FROM media WHERE id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify([...new Set(rows.map((r) => r.media_id))])).all();
  const titleOf = new Map((media || []).filter((m) => m.imdb_id).map((m) => [m.id, m]));
  const library = new Map((await stremioFetchLibrary(conn.accessToken)).map((it) => [String(it._id), it]));
  const latest = new Map(); // one position per title: the newest
  for (const r of rows) {
    const m = titleOf.get(r.media_id);
    const series = r.season != null && r.episode != null;
    if (m && library.has(m.imdb_id) && (m.kind === "series") === series && r.duration_ms > 0 && r.position_ms / r.duration_ms < MEDIA_APP_FINISHED) latest.set(m.imdb_id, r);
  }
  const now = new Date().toISOString();
  const changes = [];
  for (const [id, r] of latest) {
    const item = library.get(id);
    const st = item.state && typeof item.state === "object" ? item.state : {};
    const at = Number(r.watched_at);
    if (mediaAppTime(st.lastWatched) >= at) continue;
    const state = { ...st, timeOffset: r.position_ms, duration: r.duration_ms, lastWatched: new Date(at).toISOString() };
    if (r.season != null) state.video_id = `${id}:${r.season}:${r.episode}`;
    changes.push({ ...item, _mtime: now, state });
  }
  for (let i = 0; i < changes.length; i += 50) {
    const res = await stremioCall("datastorePut", { authKey: conn.accessToken, collection: "libraryItem", changes: changes.slice(i, i + 50) });
    if (!res || res.success !== true) throw mediaAppError("unreachable", "Stremio did not accept the update.");
  }
  // A full page may have more of the same millisecond behind it: step back one, which only repeats
  // work the lastWatched rule above already skips.
  const newest = Number(rows[rows.length - 1].updated_at);
  cursor.positionsPushedAt = Math.max(since, rows.length >= MEDIA_APP_PUSH_EVENTS ? newest - 1 : newest);
  await env.DB.prepare("UPDATE media_app_sync SET cursor_json = ? WHERE account_id = ? AND provider = 'stremio'").bind(JSON.stringify(cursor), accountId).run();
  return changes.length;
}
