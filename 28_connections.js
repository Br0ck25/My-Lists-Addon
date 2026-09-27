
// --- Provider connections (Phase 3a, P3a-9) ---------------------------------
//
// A signed-in account's Trakt, MDBList, Simkl and TMDB connections, kept on the
// server in provider_connections (migration 0015), each secret encrypted under
// TOKEN_ENCRYPTION_KEY with the context "account:<id>:<provider>".
//
// How a connection gets here:
//   * the OAuth callbacks (25_api-catalog-routes.js) store it whenever the
//     browser finishing the sign-in has a session, and then redirect to
//     /?connected=<provider> with no token in the address bar. Signed out, or
//     with no encryption key or no table yet, they do what they always did;
//   * the Trakt device-code flow stores it the same way;
//   * POST /api/connections/import-local takes the tokens a browser already
//     holds, once, checks each with its provider, and stores the good ones.
//
// The page still works from its own copy of each token (about 430 places read
// one), so after a signed-in connect it asks for it once, over the session:
// POST /api/connections/:provider/token. That bridge goes when the Phase 6
// pages stop holding tokens. P3a-10 is what makes catalogs read from here.

const CONNECTION_PROVIDERS = ["trakt", "mdblist", "simkl", "tmdb"];

function isConnectionProvider(p) {
  return CONNECTION_PROVIDERS.includes(p);
}

function connectionContext(accountId, provider) {
  return `account:${accountId}:${provider}`;
}

// external_user holds who the connection is, as JSON: { username, id }. A
// plain string (written by hand, or by an older build) reads as a username.
function parseConnectionUser(raw) {
  if (!raw) return { username: "", id: "" };
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object") return { username: String(v.username || ""), id: String(v.id || "") };
  } catch {}
  return { username: String(raw), id: "" };
}

// Stores (or replaces) one connection for a signed-in account. Answers false,
// having stored nothing, when there is no account, no encryption key, or no
// table -- the callers then fall back to what they did before, so connecting
// never breaks because of this. An API key already on file is kept when the
// new connection brings none (an OAuth sign-in never does).
async function storeProviderConnection(env, account, provider, conn) {
  if (!account || account.id == null || !env || !env.DB) return false;
  if (!isConnectionProvider(provider) || !conn || !conn.accessToken) return false;
  if (!hasTokenEncryptionKey(env)) return false;
  try {
    const context = connectionContext(account.id, provider);
    const accessEnc = await encryptToken(conn.accessToken, env, context);
    const refreshEnc = conn.refreshToken ? await encryptToken(conn.refreshToken, env, context) : null;
    const apiKeyEnc = conn.apiKey ? await encryptToken(conn.apiKey, env, context) : null;
    const user = conn.externalUser || {};
    const externalUser = JSON.stringify({ username: String(user.username || ""), id: String(user.id || "") });
    const expiresAt = Number.isFinite(conn.expiresAt) && conn.expiresAt > 0 ? Math.floor(conn.expiresAt) : null;
    await env.DB.prepare(
      "INSERT INTO provider_connections (account_id, provider, external_user, access_token_enc, refresh_token_enc, expires_at, api_key_enc, status, last_error, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, 'ok', NULL, ?) " +
      "ON CONFLICT(account_id, provider) DO UPDATE SET " +
      "  external_user = excluded.external_user," +
      "  access_token_enc = excluded.access_token_enc," +
      "  refresh_token_enc = excluded.refresh_token_enc," +
      "  expires_at = excluded.expires_at," +
      "  api_key_enc = COALESCE(excluded.api_key_enc, provider_connections.api_key_enc)," +
      "  status = 'ok', last_error = NULL, updated_at = excluded.updated_at"
    ).bind(account.id, provider, externalUser, accessEnc, refreshEnc, expiresAt, apiKeyEnc, Date.now()).run();
    return true;
  } catch (e) {
    console.error(`Could not store a ${provider} connection:`, e);
    return false;
  }
}

// One connection, decrypted. Null when there is none, or it cannot be read.
async function loadProviderConnection(env, accountId, provider) {
  if (!env || !env.DB || accountId == null || !isConnectionProvider(provider)) return null;
  try {
    const row = await env.DB.prepare(
      "SELECT external_user, access_token_enc, refresh_token_enc, expires_at, api_key_enc, status, updated_at " +
      "FROM provider_connections WHERE account_id = ? AND provider = ?"
    ).bind(accountId, provider).first();
    if (!row) return null;
    const context = connectionContext(accountId, provider);
    const user = parseConnectionUser(row.external_user);
    return {
      provider,
      accessToken: row.access_token_enc ? await decryptToken(row.access_token_enc, env, context) : "",
      refreshToken: row.refresh_token_enc ? await decryptToken(row.refresh_token_enc, env, context) : "",
      apiKey: row.api_key_enc ? await decryptToken(row.api_key_enc, env, context) : "",
      expiresAt: row.expires_at,
      username: user.username,
      id: user.id,
      status: row.status,
      updatedAt: row.updated_at,
    };
  } catch (e) {
    console.error(`Could not read a ${provider} connection:`, e);
    return null;
  }
}

// Asks the provider whether a token works: "ok" (with the username it belongs
// to), "invalid" (the provider refused it), or "unreachable" (no answer we can
// trust either way).
async function checkProviderCredentials(env, provider, creds) {
  const ua = `my-list-addon/${ADDON_VERSION}`;
  const verdict = (res) => (res.status === 401 || res.status === 403 ? "invalid" : "unreachable");
  try {
    if (provider === "trakt") {
      const clientId = creds.apiKey || TRAKT_CLIENT_ID;
      if (!creds.accessToken || !clientId) return { status: "invalid" };
      const res = await fetch("https://api.trakt.tv/users/me", {
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${creds.accessToken}`,
          "trakt-api-version": "2",
          "trakt-api-key": clientId,
          "User-Agent": ua,
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return { status: verdict(res) };
      const me = await res.json().catch(() => ({}));
      return { status: "ok", username: (me && me.username) || creds.username || "" };
    }
    if (provider === "mdblist") {
      const token = creds.accessToken || creds.apiKey;
      if (!token) return { status: "invalid" };
      const headers = { "User-Agent": ua, "Accept": "application/json" };
      if (creds.accessToken) headers["Authorization"] = `Bearer ${creds.accessToken}`;
      const res = await fetch(`https://api.mdblist.com/user?apikey=${encodeURIComponent(token)}`, {
        headers,
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return { status: verdict(res) };
      const u = await res.json().catch(() => ({}));
      return { status: "ok", username: (u && (u.username || u.user_name || u.name)) || creds.username || "" };
    }
    if (provider === "simkl") {
      const clientId = creds.apiKey || SIMKL_CLIENT_ID;
      if (!creds.accessToken || !clientId) return { status: "invalid" };
      const res = await fetch("https://api.simkl.com/users/settings", {
        headers: {
          "Authorization": `Bearer ${creds.accessToken}`,
          "simkl-api-key": clientId,
          "User-Agent": ua,
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return { status: verdict(res) };
      const s = await res.json().catch(() => ({}));
      const user = s && s.user ? (s.user.username || s.user.name) : "";
      return { status: "ok", username: user || creds.username || "" };
    }
    if (provider === "tmdb") {
      const apiKey = creds.apiKey || TMDB_API_KEY;
      if (!creds.accessToken || !apiKey) return { status: "invalid" };
      const res = await fetch(
        `https://api.themoviedb.org/3/account?api_key=${encodeURIComponent(apiKey)}&session_id=${encodeURIComponent(creds.accessToken)}`,
        { headers: { "User-Agent": ua }, signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) return { status: verdict(res) };
      const a = await res.json().catch(() => ({}));
      return { status: "ok", username: (a && a.username) || creds.username || "", id: a && a.id != null ? String(a.id) : (creds.id || "") };
    }
  } catch {
    return { status: "unreachable" };
  }
  return { status: "invalid" };
}

// Best effort: tells the provider to forget the token, where it has a way to.
// Trakt only for tokens issued to this site's own client (its secret is the
// one we hold); TMDB deletes the session. MDBList and Simkl have no revoke
// endpoint, so for them removing our copy is all there is.
async function revokeAtProvider(env, provider, conn) {
  try {
    if (provider === "trakt" && conn.accessToken && !conn.apiKey && TRAKT_CLIENT_ID && env && env.TRAKT_CLIENT_SECRET) {
      await fetch("https://api.trakt.tv/oauth/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": `my-list-addon/${ADDON_VERSION}` },
        body: JSON.stringify({ token: conn.accessToken, client_id: TRAKT_CLIENT_ID, client_secret: env.TRAKT_CLIENT_SECRET }),
        signal: AbortSignal.timeout(10000),
      });
      return true;
    }
    if (provider === "tmdb" && conn.accessToken) {
      const apiKey = conn.apiKey || TMDB_API_KEY;
      if (!apiKey) return false;
      await fetch(`https://api.themoviedb.org/3/authentication/session?api_key=${encodeURIComponent(apiKey)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "User-Agent": `my-list-addon/${ADDON_VERSION}` },
        body: JSON.stringify({ session_id: conn.accessToken }),
        signal: AbortSignal.timeout(10000),
      });
      return true;
    }
  } catch {}
  return false;
}

// The page's own keys (collectKeys, 23_client-list-management.js), as one
// credential set per provider.
function localConnectionCredentials(keys) {
  const s = (v) => (typeof v === "string" ? v.trim() : "");
  const k = keys && typeof keys === "object" ? keys : {};
  return {
    trakt: { accessToken: s(k.traktAccessToken), apiKey: s(k.traktKey), username: s(k.traktUsername) },
    mdblist: { accessToken: s(k.mdblistAccessToken), apiKey: s(k.mdblistKey), username: s(k.mdblistUsername) },
    simkl: { accessToken: s(k.simklAccessToken), apiKey: s(k.simklKey), username: s(k.simklUsername) },
    tmdb: { accessToken: s(k.tmdbSessionId), apiKey: s(k.tmdbKey), username: s(k.tmdbUsername), id: s(k.tmdbAccountId) },
  };
}

function connectionSummary(row) {
  const user = parseConnectionUser(row.external_user);
  return {
    provider: row.provider,
    username: user.username || null,
    status: row.status,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
    hasToken: Boolean(row.access_token_enc),
    hasApiKey: Boolean(row.api_key_enc),
  };
}

async function handleConnectionsApi(request, env, url, path) {
  if (path !== "/api/connections" && !path.startsWith("/api/connections/")) return null;
  try {
    return await handleConnectionsApiRoutes(request, env, url, path);
  } catch (e) {
    // Most often migration 0015 not applied yet.
    console.error("Connections API failed:", e);
    return json({ ok: false, error: "Connected accounts aren't available right now." }, 503);
  }
}

async function handleConnectionsApiRoutes(request, env, url, path) {
  if (!env || !env.DB) return json({ ok: false, error: "Connected accounts aren't available right now." }, 503);
  if (!request.account) {
    return json({ ok: false, error: "Sign in to manage your connected accounts.", signInRequired: true }, 401);
  }
  const accountId = request.account.id;

  if (path === "/api/connections") {
    if (request.method !== "GET") return json({ ok: false, error: "Method not allowed." }, 405);
    const { results } = await env.DB.prepare(
      "SELECT provider, external_user, access_token_enc, api_key_enc, expires_at, status, updated_at FROM provider_connections WHERE account_id = ? ORDER BY provider"
    ).bind(accountId).all();
    return json({ ok: true, connections: (results || []).map(connectionSummary) });
  }

  if (path === "/api/connections/import-local") {
    if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);
    if (!hasTokenEncryptionKey(env)) return json({ ok: false, error: "Connected accounts can't be stored yet." }, 503);
    // Each import can call four providers with this site's own client ids, so
    // a loop of them would spend those providers' rate limits for everyone.
    // The page imports once per device; five a minute per account is plenty.
    if (await consumeRateLimit(env, null, "connimport", "a" + accountId, 5)) {
      return json({ ok: false, error: "Too many attempts. Please wait a minute and try again." }, 429);
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "Invalid JSON body." }, 400);
    }
    const local = localConnectionCredentials(body && body.keys ? body.keys : body);
    const { results } = await env.DB.prepare(
      "SELECT provider, status FROM provider_connections WHERE account_id = ?"
    ).bind(accountId).all();
    const existing = new Map((results || []).map((r) => [r.provider, r.status]));
    const outcome = {};
    for (const provider of CONNECTION_PROVIDERS) {
      const creds = local[provider];
      // MDBList works from an API key alone; the others need a sign-in token.
      const credential = provider === "mdblist" ? (creds.accessToken || creds.apiKey) : creds.accessToken;
      if (!credential) continue;
      // Once: a connection already here is the newer one -- it came from a
      // sign-in on the server, or from an earlier import.
      if (existing.get(provider) === "ok") {
        outcome[provider] = "exists";
        continue;
      }
      const checked = await checkProviderCredentials(env, provider, creds);
      if (checked.status !== "ok") {
        outcome[provider] = checked.status;
        continue;
      }
      const stored = await storeProviderConnection(env, request.account, provider, {
        // An API-key-only MDBList connection keeps the key in both places, so
        // whatever reads the token finds it.
        accessToken: creds.accessToken || creds.apiKey,
        apiKey: creds.apiKey,
        externalUser: { username: checked.username || creds.username, id: checked.id || creds.id },
      });
      outcome[provider] = stored ? "imported" : "failed";
    }
    return json({ ok: true, results: outcome });
  }

  const m = /^\/api\/connections\/([a-z]+)(\/token)?$/.exec(path);
  if (!m || !isConnectionProvider(m[1])) return json({ ok: false, error: "Not found." }, 404);
  const provider = m[1];

  // The bridge for this page (see the header above): the token, once, to the
  // signed-in browser that just connected. POST, so the CSRF check applies.
  if (m[2]) {
    if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);
    const conn = await loadProviderConnection(env, accountId, provider);
    if (!conn || !conn.accessToken) return json({ ok: false, error: "That account isn't connected." }, 404);
    return json({ ok: true, provider, accessToken: conn.accessToken, username: conn.username, id: conn.id });
  }

  if (request.method === "DELETE") {
    const conn = await loadProviderConnection(env, accountId, provider);
    const revoked = conn ? await revokeAtProvider(env, provider, conn) : false;
    await env.DB.prepare("DELETE FROM provider_connections WHERE account_id = ? AND provider = ?").bind(accountId, provider).run();
    return json({ ok: true, removed: Boolean(conn), revokedAtProvider: revoked });
  }

  return json({ ok: false, error: "Method not allowed." }, 405);
}
