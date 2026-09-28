
// --- Connections: token.refresh (Phase 5, P5-7) ---------------------------------
//
// A connected Trakt or MDBList account (28_connections.js) holds a token that
// expires. Until now it was renewed only when a catalog row happened to need
// it within the hour before it expired (refreshProviderConnectionIfDue), so a
// connection nobody's Stremio asked for in that hour lapsed, and the rows went
// quietly empty.
//
//   token.refresh (periodic, daily): every connection whose token expires
//   within TOKEN_REFRESH_WINDOW_MS and that has a refresh token is renewed
//   (exchangeRefreshToken, the same call as on the request path). When the
//   provider refuses the refresh token (and no other isolate renewed it
//   meanwhile), the connection is marked `reauth_required`: its token is no
//   longer used, the person's personal rows show a "Reconnect" tile in Stremio
//   (the catalog route, 25_), and the website shows a banner (17_). A provider
//   that could not be asked (network, not configured) is left for the next day.
//   Connecting again (storeProviderConnection) sets it back to `ok`.
//
// Module level, after the Worker's exports, like 27_ onward.

const TOKEN_REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_REFRESH_LIMIT = 500;

async function runTokenRefresh(env, { now = Date.now() } = {}) {
  const out = { due: 0, renewed: 0, reauth: 0, skipped: 0, unreadable: 0 };
  if (!env || !env.DB || !hasTokenEncryptionKey(env)) return out;
  let rows;
  try {
    ({ results: rows } = await env.DB.prepare(
      `SELECT account_id, provider, external_user, access_token_enc, refresh_token_enc, expires_at, api_key_enc, status, updated_at
       FROM provider_connections
       WHERE status = 'ok' AND refresh_token_enc IS NOT NULL AND expires_at IS NOT NULL AND expires_at < ?
       ORDER BY expires_at LIMIT ?`
    ).bind(now + TOKEN_REFRESH_WINDOW_MS, TOKEN_REFRESH_LIMIT).all());
  } catch (err) {
    if (/no such table/i.test(jobErrorText(err))) return out;
    throw err;
  }
  for (const row of rows || []) {
    out.due++;
    const conn = await decryptConnectionRow(env, row.account_id, row);
    if (!conn || !conn.refreshToken) {
      out.unreadable++;
      continue;
    }
    const fresh = await exchangeRefreshToken(env, row.provider, conn);
    if (fresh && fresh.accessToken) {
      const stored = await storeProviderConnection(env, { id: row.account_id }, row.provider, {
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken,
        expiresAt: fresh.expiresAt,
        externalUser: { username: conn.username, id: conn.id },
      });
      if (stored) out.renewed++;
      else out.skipped++;
      continue;
    }
    if (fresh && fresh.rejected) {
      // Refresh tokens are single use: a request may have renewed it a moment
      // ago, in which case the row now holds a different token.
      const again = await loadProviderConnection(env, row.account_id, row.provider);
      if (again && again.accessToken && again.accessToken !== conn.accessToken) {
        out.renewed++;
        continue;
      }
      await markConnectionStatus(env, row.account_id, row.provider, "reauth_required", "The provider refused to renew this sign-in. Connect it again.");
      out.reauth++;
      continue;
    }
    out.skipped++;
  }
  if (out.reauth || out.renewed) console.log(`[Jobs] token.refresh: ${out.renewed} renewed, ${out.reauth} need signing in again, ${out.skipped} left for tomorrow.`);
  return out;
}

definePeriodicJob("token.refresh", {
  everyMs: 24 * 60 * 60 * 1000,
  run: (env) => runTokenRefresh(env),
});
