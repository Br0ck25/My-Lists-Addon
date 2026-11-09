// Whether a playback ping (the subtitles request, 63_subtitles-track.js) should be left unrecorded
// because the person's app is already syncing its real watch history here.
//
// A ping fires when playback STARTS and marks the title watched there and then, so a movie begun and
// abandoned counted as watched. A connected Stremio account is read for its real watch dates and
// resume points instead (pullMediaAppStep). So a ping from Stremio is skipped only when that
// account is connected, its sign-in works and its pull is on: with any of those off nothing else
// would record the play. A ping from any other app (Wako, other players) is always recorded, and
// so is one from a client we do not recognise as Stremio. Nuvio's pings are skipped separately.

async function mediaAppPullsFrom(env, accountId, provider) {
  if (!env || !env.DB || accountId == null) return false;
  try {
    const row = await env.DB.prepare(
      `SELECT 1 AS yes FROM media_app_sync s JOIN provider_connections c ON c.account_id = s.account_id AND c.provider = s.provider
       WHERE s.account_id = ? AND s.provider = ? AND s.pull_enabled = 1 AND c.status = 'ok'`
    ).bind(accountId, provider).first();
    return Boolean(row);
  } catch {
    return false;
  }
}

// True when the ping was skipped (and says why on the diagnostics key).
async function stremioSyncCoversPing(env, auth, client, diagnosticsKey, pingId) {
  if (client !== "Stremio" || !auth.ok || !(await mediaAppPullsFrom(env, await activityAccountId(env, auth.username), "stremio"))) return false;
  await env.CONFIGS.put(diagnosticsKey, JSON.stringify({
    lastPingAt: Date.now(),
    lastPingId: pingId,
    lastServer: "Stremio",
    matched: "skipped (Stremio is connected and syncing your real watch history)",
  }));
  return true;
}
