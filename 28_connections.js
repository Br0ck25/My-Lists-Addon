
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
// pages stop holding tokens. Catalogs read from here too: see "Catalogs read
// an account's connections (P3a-10)" below.

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
    forgetAccountConnectionsCache(account.id);
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
    forgetAccountConnectionsCache(accountId);
    return json({ ok: true, removed: Boolean(conn), revokedAtProvider: revoked });
  }

  return json({ ok: false, error: "Method not allowed." }, 405);
}

// --- Catalogs read an account's connections (P3a-10) --------------------------
//
// A personal Trakt, MDBList or Simkl row (and every row, for a TMDB key) can
// get its keys and tokens from the account's own connections instead of from
// the install config. resolveConfig asks for them only for an install whose
// owner is PROVEN, never for one that merely names a user:
//   * a v2 install: its installs.account_id, set by the signed-in account that
//     created it, and deleted with that account;
//   * a stored config whose Creator Key still verifies (a re-registered
//     username has a new key, so it cannot);
//   * a stored config /api/save stamped with ownerId + ownerSince, the
//     accounts row's id and created_at -- a username deleted and registered
//     again gets a new row with a new created_at, so the stamp stops matching.
// The older trackOwner stamp and the unverified-shelf fallback are NOT enough:
// both are names, and a name can change hands.
//
// A key or token the config carries itself always wins, so an existing link
// serves exactly as before; connections fill only what it lacks. A token and
// the client id it was issued to travel together (Trakt and Simkl reject a
// token presented with another app's id).
//
// Nothing here runs without TOKEN_ENCRYPTION_KEY: no connection can exist.

const CONNECTION_ROWS_CACHE = new Map();
const CONNECTION_ROWS_CACHE_TTL_MS = 60 * 1000;
const CONNECTION_ROWS_CACHE_MAX = 500;
const CONNECTION_OWNER_CACHE = new Map();
// A token is renewed when it has less than this left, so a request never
// carries one that expires on the way.
const CONNECTION_REFRESH_MARGIN_MS = 60 * 60 * 1000;
// The site is hosted only at mylistsaddon.com (docs/DECISIONS.md D-1), and a
// refresh has to name the redirect URI the token was issued under.
const TRAKT_OAUTH_REDIRECT_URI = "https://mylistsaddon.com/api/trakt/oauth/callback";

// The config fields each provider's connection supplies. `paired`: the token is
// only good with the client id it was issued to, so both come from the
// connection or neither does.
const CONNECTION_CONFIG_FIELDS = {
  trakt: { token: "traktAccessToken", apiKey: "traktKey", user: "traktUsername", paired: true },
  simkl: { token: "simklAccessToken", apiKey: "simklKey", user: "simklUsername", paired: true },
  mdblist: { token: "mdblistAccessToken", apiKey: "mdblistKey" },
  // A TMDB session is a website feature; catalogs use only the API key.
  tmdb: { apiKey: "tmdbKey" },
};

function forgetAccountConnectionsCache(accountId) {
  if (accountId != null) CONNECTION_ROWS_CACHE.delete(String(accountId));
}

function connectionCacheSet(map, key, value) {
  if (map.size >= CONNECTION_ROWS_CACHE_MAX) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, { value, at: Date.now() });
}

function connectionCacheGet(map, key) {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < CONNECTION_ROWS_CACHE_TTL_MS) return hit;
  if (hit) map.delete(key);
  return null;
}

// `fresh` skips the isolate copy. A save decides from it what to leave out of
// a link for good, so it must not act on a connection another isolate has
// just removed.
async function accountConnectionRows(env, accountId, { fresh = false } = {}) {
  const key = String(accountId);
  const cached = fresh ? null : connectionCacheGet(CONNECTION_ROWS_CACHE, key);
  if (cached) return cached.value;
  let rows = [];
  try {
    const { results } = await env.DB.prepare(
      "SELECT provider, external_user, access_token_enc, refresh_token_enc, expires_at, api_key_enc, status, updated_at " +
      "FROM provider_connections WHERE account_id = ?"
    ).bind(accountId).all();
    rows = results || [];
  } catch {
    // No table yet: no connections.
    rows = [];
  }
  connectionCacheSet(CONNECTION_ROWS_CACHE, key, rows);
  return rows;
}

async function decryptConnectionRow(env, accountId, row) {
  const context = connectionContext(accountId, row.provider);
  try {
    const user = parseConnectionUser(row.external_user);
    return {
      provider: row.provider,
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
    console.error(`Could not read a ${row.provider} connection:`, e);
    return null;
  }
}

async function markConnectionStatus(env, accountId, provider, status, error) {
  try {
    await env.DB.prepare(
      "UPDATE provider_connections SET status = ?, last_error = ?, updated_at = ? WHERE account_id = ? AND provider = ?"
    ).bind(status, error ? String(error).slice(0, 300) : null, Date.now(), accountId, provider).run();
  } catch {}
  forgetAccountConnectionsCache(accountId);
}

// Asks the provider for a new token. { accessToken, refreshToken, expiresAt },
// or { rejected: true } when the provider refused the refresh token, or null
// when it could not be asked (not configured, network) -- a transient failure
// must not mark a connection broken.
async function exchangeRefreshToken(env, provider, conn) {
  const ua = `my-list-addon/${ADDON_VERSION}`;
  if (provider === "trakt") {
    // Only a token issued to this site's own client: renewing one issued to a
    // person's own Trakt app needs that app's secret, which we never had.
    if (conn.apiKey || !TRAKT_CLIENT_ID || !env || !env.TRAKT_CLIENT_SECRET) return null;
    let rejected = false;
    // The web sign-in's redirect URI, then the device flow's out-of-band one:
    // a token from either flow is renewed under the URI it was issued with.
    for (const redirectUri of [TRAKT_OAUTH_REDIRECT_URI, "urn:ietf:wg:oauth:2.0:oob"]) {
      try {
        const res = await fetch("https://api.trakt.tv/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/json", "trakt-api-version": "2", "trakt-api-key": TRAKT_CLIENT_ID, "User-Agent": ua },
          body: JSON.stringify({
            refresh_token: conn.refreshToken,
            client_id: TRAKT_CLIENT_ID,
            client_secret: env.TRAKT_CLIENT_SECRET,
            redirect_uri: redirectUri,
            grant_type: "refresh_token",
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) {
          const d = await res.json().catch(() => ({}));
          if (!d.access_token) return null;
          return {
            accessToken: d.access_token,
            refreshToken: d.refresh_token || conn.refreshToken,
            expiresAt: d.created_at && d.expires_in ? (d.created_at + d.expires_in) * 1000 : null,
          };
        }
        if (res.status === 400 || res.status === 401 || res.status === 403) rejected = true;
        else return null;
      } catch {
        return null;
      }
    }
    return rejected ? { rejected: true } : null;
  }
  if (provider === "mdblist") {
    const clientId = MDBLIST_CLIENT_ID || (env && env.MDBLIST_CLIENT_ID) || "";
    const clientSecret = (env && env.MDBLIST_CLIENT_SECRET) || "";
    if (!clientId || !clientSecret) return null;
    try {
      const form = new URLSearchParams();
      form.set("grant_type", "refresh_token");
      form.set("refresh_token", conn.refreshToken);
      form.set("client_id", clientId);
      form.set("client_secret", clientSecret);
      const res = await fetch("https://api.mdblist.com/oauth/token/", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "Authorization": `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
          "User-Agent": ua,
          "Accept": "application/json",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const d = await res.json().catch(() => ({}));
        const token = d.access_token || d.token;
        if (!token) return null;
        return {
          accessToken: token,
          refreshToken: d.refresh_token || conn.refreshToken,
          expiresAt: d.expires_in ? Date.now() + Number(d.expires_in) * 1000 : null,
        };
      }
      if (res.status === 400 || res.status === 401 || res.status === 403) return { rejected: true };
    } catch {}
    return null;
  }
  return null;
}

// The connection, renewed first if its token is expired or about to be. Null
// when there is no usable token.
//
// Refresh tokens are single-use, and two isolates can reach an expiring token
// at once: the one whose refresh is refused re-reads the row, and uses what the
// other one stored rather than marking a working connection broken.
async function refreshProviderConnectionIfDue(env, accountId, provider, conn) {
  const now = Date.now();
  if (!conn.expiresAt || conn.expiresAt - now > CONNECTION_REFRESH_MARGIN_MS) return conn;
  const stillValid = conn.expiresAt > now ? conn : null;
  if (!conn.refreshToken) return stillValid;
  const fresh = await exchangeRefreshToken(env, provider, conn);
  if (fresh && fresh.accessToken) {
    await storeProviderConnection(env, { id: accountId }, provider, {
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken,
      expiresAt: fresh.expiresAt,
      externalUser: { username: conn.username, id: conn.id },
    });
    return { ...conn, ...fresh };
  }
  if (fresh && fresh.rejected) {
    const again = await loadProviderConnection(env, accountId, provider);
    if (again && again.accessToken && again.accessToken !== conn.accessToken) {
      forgetAccountConnectionsCache(accountId);
      return again;
    }
    if (!stillValid) await markConnectionStatus(env, accountId, provider, "expired", "The provider refused to renew this sign-in.");
  }
  return stillValid;
}

// The config fields an account's connections supply that `current` (the
// config's own values, from readInstallConfigFields) lacks.
async function connectionFieldsForConfig(env, accountId, current) {
  if (!env || !env.DB || accountId == null || !hasTokenEncryptionKey(env)) return {};
  const rows = await accountConnectionRows(env, accountId);
  const out = {};
  for (const row of rows) {
    const map = CONNECTION_CONFIG_FIELDS[row.provider];
    if (!map) continue;
    if (row.status !== "ok") {
      // The provider refused to renew this sign-in (P5-7): the rows that
      // needed it show a "Reconnect" tile instead of going quietly empty.
      if (map.token && !current[map.token]) (out._reconnect = out._reconnect || []).push(row.provider);
      continue;
    }
    const tokenMissing = Boolean(map.token && !current[map.token] && row.access_token_enc);
    const keyMissing = Boolean(map.apiKey && !current[map.apiKey] && row.api_key_enc);
    if (!tokenMissing && !keyMissing) continue;
    let conn = await decryptConnectionRow(env, accountId, row);
    if (!conn) continue;
    if (tokenMissing) {
      conn = await refreshProviderConnectionIfDue(env, accountId, row.provider, conn);
      if (!conn || !conn.accessToken) continue;
      // An MDBList connection made from an API key alone stores the key as its
      // token too (import-local). It is a key, not a bearer token.
      if (row.provider === "mdblist" && conn.apiKey && conn.accessToken === conn.apiKey) {
        if (!current.mdblistKey) out.mdblistKey = conn.apiKey;
        continue;
      }
      out[map.token] = conn.accessToken;
      // "" means this site's own client id, the one the token was issued to.
      if (map.paired) out[map.apiKey] = conn.apiKey || "";
      else if (keyMissing && conn.apiKey) out[map.apiKey] = conn.apiKey;
      if (map.user && !current[map.user] && conn.username) out[map.user] = conn.username;
      continue;
    }
    // Only a key is missing. A paired key is never borrowed on its own: the
    // config's token was issued to some other client id.
    if (!map.paired && conn.apiKey) out[map.apiKey] = conn.apiKey;
  }
  return out;
}

// The accounts row a stored config's provider keys may come from, or null. See
// the header above for what counts as proof. `keyVerifiedOwner` is the username
// resolveConfig just proved with the config's own Creator Key, or "".
async function connectionOwnerForConfig(env, parsed, keyVerifiedOwner) {
  if (!env || !env.DB || !hasTokenEncryptionKey(env)) return null;
  if (keyVerifiedOwner) {
    const key = "u:" + keyVerifiedOwner;
    const cached = connectionCacheGet(CONNECTION_OWNER_CACHE, key);
    if (cached) return cached.value;
    const row = await getOrBackfillAccount(env, keyVerifiedOwner);
    const id = row ? row.id : null;
    connectionCacheSet(CONNECTION_OWNER_CACHE, key, id);
    return id;
  }
  const ownerId = Number(parsed && parsed.ownerId);
  const ownerSince = Number(parsed && parsed.ownerSince);
  if (!Number.isFinite(ownerId) || !Number.isFinite(ownerSince) || !ownerId || !ownerSince) return null;
  const key = `i:${ownerId}:${ownerSince}`;
  const cached = connectionCacheGet(CONNECTION_OWNER_CACHE, key);
  if (cached) return cached.value;
  let id = null;
  try {
    const row = await env.DB.prepare(
      "SELECT id, created_at, status, deleted_at FROM accounts WHERE id = ?"
    ).bind(ownerId).first();
    if (row && Number(row.created_at) === ownerSince && row.deleted_at == null && (!row.status || row.status === "active")) id = row.id;
  } catch {
    id = null;
  }
  connectionCacheSet(CONNECTION_OWNER_CACHE, key, id);
  return id;
}

// For /api/save: the config fields a signed-in save can leave out, because the
// account's connections supply them when the link is read. Only connections
// that work now; paired fields go together.
async function connectionSuppliedConfigFields(env, accountId) {
  if (!env || !env.DB || accountId == null || !hasTokenEncryptionKey(env)) return [];
  const rows = await accountConnectionRows(env, accountId, { fresh: true });
  const fields = [];
  for (const row of rows) {
    const map = CONNECTION_CONFIG_FIELDS[row.provider];
    if (!map || row.status !== "ok") continue;
    if (row.provider === "mdblist") {
      const conn = await decryptConnectionRow(env, accountId, row);
      if (!conn) continue;
      const keyOnly = conn.apiKey && conn.accessToken === conn.apiKey;
      if (!keyOnly && conn.accessToken) fields.push(map.token);
      if (conn.apiKey) fields.push(map.apiKey);
      continue;
    }
    if (map.token && row.access_token_enc) {
      fields.push(map.token);
      if (map.paired) fields.push(map.apiKey);
    } else if (!map.token && row.api_key_enc) {
      fields.push(map.apiKey);
    }
  }
  return fields;
}
