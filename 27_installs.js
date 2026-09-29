
// --- Installs (Phase 3a, P3a-8) ---------------------------------------------
//
// An install is one add-on link someone put into Stremio, Nuvio or wako. Two
// kinds live in the `installs` table (migration 0015):
//
//   * v2 installs, /i/{token}/manifest.json. The token is 32 random bytes and
//     only its SHA-256 is stored (token_hash). One is created through
//     POST /api/installs by a signed-in account, which owns it and can rename,
//     edit, rotate or revoke it (behind FF_INSTALLS).
//   * legacy installs, /{id}/manifest.json: the short KV ids /api/save has
//     always handed out. token_hash is "legacy:{id}", which no SHA-256 can
//     equal, and legacy_cfg_id is the id.
//
// A legacy id moves into the table the first time it is used after the move is
// switched on (INSTALL_MIGRATION_PERCENT), and only when its KV record holds
// something to move: a provider key or token, or a Creator Key. Those go to
// install_secrets, encrypted under TOKEN_ENCRYPTION_KEY with a context naming
// the install and provider, and the KV record is rewritten without them,
// carrying `_install: <id>` instead. resolveConfig puts them back when it reads
// the record, so everything downstream behaves exactly as before: the
// catalogs, the Creator Key check that authorises playback tracking, and a key
// reset stopping that tracking.
//
// The URL never changes. Stremio installs pin it, so legacy URLs are served
// indefinitely and never redirected (MIGRATION_PLAN.md §3.2).
//
// Reads never depend on the flags. A record that has been moved is always read
// through the table, so switching a flag off later cannot strand its secrets.

// The config segment a v2 install is handed on as. "~" is not in the base64url
// alphabet, so it can collide with neither a KV id nor a base64 config.
const INSTALL_TOKEN_PARAM_PREFIX = "i~";
const INSTALL_LEGACY_HASH_PREFIX = "legacy:";
const INSTALL_SNAPSHOT_KEY_PREFIX = "install:";
// KV snapshot of one install row and its encrypted secrets, so a catalog
// request does not reach D1. Every change deletes it (and bumps `version`).
const INSTALL_SNAPSHOT_TTL_SEC = 86400;
// And an isolate copy on top: a Stremio home screen asks for every row of one
// install at once.
const INSTALL_SNAPSHOT_CACHE = new Map();
const INSTALL_SNAPSHOT_CACHE_TTL_MS = 30 * 1000;
const INSTALL_SNAPSHOT_CACHE_MAX = 500;
// D1 caps a row at 2 MB. A v2 install's config is stored in its row.
const INSTALL_CONFIG_JSON_MAX = 1500000;
// Active v2 installs one account may hold.
const INSTALLS_PER_ACCOUNT_MAX = 50;
const INSTALL_NAME_MAX = 80;

// Where each secret config field is filed in install_secrets. A test checks
// that every `secret: true` field of INSTALL_CONFIG_FIELDS is named here.
const INSTALL_SECRET_COLUMNS = {
  tmdbKey: ["tmdb", "api_key_enc"],
  mdblistKey: ["mdblist", "api_key_enc"],
  mdblistAccessToken: ["mdblist", "access_token_enc"],
  traktKey: ["trakt", "api_key_enc"],
  traktAccessToken: ["trakt", "access_token_enc"],
  simklKey: ["simkl", "api_key_enc"],
  simklAccessToken: ["simkl", "access_token_enc"],
  // The account's own key, carried by a config with a personal shelf. Kept
  // (encrypted) because it is what authorises that link's playback tracking,
  // and because it lets the move be undone.
  trackCreatorKey: ["creator", "api_key_enc"],
};
// Any other top-level field whose name says it is a credential. Saves were
// written field by field before INSTALL_CONFIG_FIELDS, so an old record may
// hold one the table above does not name. Kept together, as one encrypted JSON
// object, and put back as they were.
const INSTALL_OTHER_SECRETS_PROVIDER = "legacy";

function isInstallSecretFieldName(name) {
  if (Object.prototype.hasOwnProperty.call(INSTALL_SECRET_COLUMNS, name)) return true;
  if (/(Key|Token|Secret|Password)$/.test(name)) return true;
  return /^(apikey|api_key|access_token|refresh_token|token|key|secret|password|creatorkey)$/i.test(name);
}

function isInstallsEnabled(env) {
  const v = env ? env.FF_INSTALLS : undefined;
  return v === "1" || v === "true" || v === true;
}

// INSTALL_MIGRATION_PERCENT: the share of legacy ids moved on first use, 0 to
// 100, chosen by a stable hash of the id so a rollout can start small and
// widen. A percentage rather than an on/off flag on purpose: "1" means 1%, and
// "100" means every id. Unset, "0" or anything unreadable moves nothing.
function installMigrationPercent(env) {
  const raw = env ? env.INSTALL_MIGRATION_PERCENT : undefined;
  const n = parseInt(String(raw == null ? "" : raw).trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(100, n);
}

async function installMigrationBucket(id) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("installbucket:" + id));
  const b = new Uint8Array(digest);
  return ((b[0] << 24 >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3]) % 100;
}

function hasTokenEncryptionKey(env) {
  try {
    const ring = parseTokenEncryptionKeys(env);
    const key = ring.activeKeyId ? ring.keys.get(ring.activeKeyId) : null;
    return Boolean(key && key.length === 32);
  } catch {
    return false;
  }
}

function isV2InstallParam(param) {
  return typeof param === "string" && param.startsWith(INSTALL_TOKEN_PARAM_PREFIX);
}

function isWellFormedInstallToken(token) {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

// /i/{token}/rest -> /i~{token}/rest, which the existing manifest, catalog,
// meta, subtitles and configure routes then serve like any other config.
function v2InstallPath(path) {
  const m = /^\/i\/([A-Za-z0-9_-]{43})(\/.*)$/.exec(String(path || ""));
  return m ? `/${INSTALL_TOKEN_PARAM_PREFIX}${m[1]}${m[2]}` : null;
}

function generateInstallToken() {
  return base64UrlEncodeBytes(crypto.getRandomValues(new Uint8Array(32)));
}

async function installTokenHash(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(token)));
  return bufferToHex(new Uint8Array(digest));
}

function installSecretContext(installId, provider) {
  return `install:${installId}:${provider}`;
}

// Same shape resolveConfig returns for an unreadable config: no rows, every
// setting at its default, no account.
function emptyResolvedInstallConfig() {
  return {
    entries: [],
    watchHistory: [],
    continueWatching: [],
    watchlist: [],
    airingNext: [],
    ...readInstallConfigFields({}),
    track: false,
    trackCreatorName: "",
    trackCreatorKey: "",
    trackOwner: "",
  };
}

// Splits a stored config into what may stay in KV and what has to move.
// `byProvider` maps provider -> { column: plaintext }; `other` collects
// credential-looking fields the table does not name.
function splitInstallSecrets(parsed) {
  const publicPart = {};
  const byProvider = new Map();
  const other = {};
  let hasSecrets = false;
  for (const name of Object.keys(parsed || {})) {
    const value = parsed[name];
    if (!isInstallSecretFieldName(name)) {
      publicPart[name] = value;
      continue;
    }
    if (value == null || value === "") continue;
    hasSecrets = true;
    const target = INSTALL_SECRET_COLUMNS[name];
    if (target && typeof value === "string") {
      const [provider, column] = target;
      if (!byProvider.has(provider)) byProvider.set(provider, {});
      byProvider.get(provider)[column] = value;
    } else {
      other[name] = value;
    }
  }
  if (Object.keys(other).length) {
    byProvider.set(INSTALL_OTHER_SECRETS_PROVIDER, { api_key_enc: JSON.stringify(other) });
  }
  return { publicPart, byProvider, hasSecrets };
}

function installRecordHasSecrets(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  for (const name of Object.keys(parsed)) {
    if (isInstallSecretFieldName(name) && parsed[name] != null && parsed[name] !== "") return true;
  }
  return false;
}

async function encryptInstallSecrets(env, installId, byProvider) {
  const rows = [];
  for (const [provider, cols] of byProvider) {
    const context = installSecretContext(installId, provider);
    rows.push({
      provider,
      access_token_enc: cols.access_token_enc ? await encryptToken(cols.access_token_enc, env, context) : null,
      api_key_enc: cols.api_key_enc ? await encryptToken(cols.api_key_enc, env, context) : null,
    });
  }
  return rows;
}

// install_secrets rows (as stored, or as the snapshot carries them) back into
// config fields. A row that will not decrypt is logged and left out: the
// install then serves as it would without that key, rather than not at all.
async function decryptInstallSecretFields(env, installId, rows) {
  const fields = {};
  const byColumn = {};
  for (const [field, [provider, column]] of Object.entries(INSTALL_SECRET_COLUMNS)) {
    byColumn[provider + ":" + column] = field;
  }
  for (const row of rows || []) {
    const provider = row.provider;
    const context = installSecretContext(installId, provider);
    try {
      if (provider === INSTALL_OTHER_SECRETS_PROVIDER) {
        if (row.api_key_enc) Object.assign(fields, JSON.parse(await decryptToken(row.api_key_enc, env, context)));
        continue;
      }
      for (const column of ["access_token_enc", "api_key_enc"]) {
        const field = byColumn[provider + ":" + column];
        if (field && row[column]) fields[field] = await decryptToken(row[column], env, context);
      }
    } catch (e) {
      console.error(`Install ${installId}: could not decrypt its ${provider} secrets:`, e);
    }
  }
  return fields;
}

// One install row and its encrypted secrets, from the isolate copy, then KV,
// then D1 (which refreshes both).
//   null            D1 could not be asked (not bound, or it failed)
//   { missing }     no such install: never created, or deleted with its account
//   snapshot        { id, v, accountId, owner, scopes, revoked, secrets, config? }
// A v2 snapshot carries its config; a legacy one does not, since that lives in
// the cfg: record the request has already read.
async function loadInstallSnapshot(env, tokenHash) {
  const now = Date.now();
  const cached = INSTALL_SNAPSHOT_CACHE.get(tokenHash);
  if (cached && now - cached.at < INSTALL_SNAPSHOT_CACHE_TTL_MS) return cached.snap;
  let snap = null;
  if (env && env.CONFIGS) {
    try {
      const raw = await env.CONFIGS.get(INSTALL_SNAPSHOT_KEY_PREFIX + tokenHash);
      if (raw) snap = JSON.parse(raw);
    } catch {
      snap = null;
    }
  }
  if (!snap) {
    if (!env || !env.DB) return null;
    try {
      const row = await env.DB.prepare(
        "SELECT i.id, i.account_id, i.config_json, i.version, i.scopes, i.revoked_at, a.username " +
        "FROM installs i LEFT JOIN accounts a ON a.id = i.account_id WHERE i.token_hash = ?"
      ).bind(tokenHash).first();
      if (!row) {
        // Isolate only. Writing a KV key for every token nobody holds would let
        // anyone mint billed writes by guessing.
        snap = { missing: true };
      } else {
        const { results } = await env.DB.prepare(
          "SELECT provider, access_token_enc, api_key_enc FROM install_secrets WHERE install_id = ?"
        ).bind(row.id).all();
        snap = {
          id: row.id,
          v: row.version,
          accountId: row.account_id,
          owner: row.username ? String(row.username).toLowerCase() : "",
          scopes: row.scopes || "read",
          revoked: row.revoked_at != null,
          secrets: (results || []).map((r) => ({
            provider: r.provider,
            access_token_enc: r.access_token_enc || null,
            api_key_enc: r.api_key_enc || null,
          })),
        };
        if (!tokenHash.startsWith(INSTALL_LEGACY_HASH_PREFIX)) snap.config = row.config_json;
        // Day-level "last used": the snapshot is rebuilt at most once a day.
        try {
          await env.DB.prepare("UPDATE installs SET last_used_at = ? WHERE id = ?").bind(now, row.id).run();
        } catch {}
        if (env.CONFIGS) {
          try {
            await env.CONFIGS.put(INSTALL_SNAPSHOT_KEY_PREFIX + tokenHash, JSON.stringify(snap), { expirationTtl: INSTALL_SNAPSHOT_TTL_SEC });
          } catch {}
        }
      }
    } catch (e) {
      console.error("Install lookup failed:", e);
      return null;
    }
  }
  if (INSTALL_SNAPSHOT_CACHE.size >= INSTALL_SNAPSHOT_CACHE_MAX) {
    const oldest = INSTALL_SNAPSHOT_CACHE.keys().next().value;
    if (oldest !== undefined) INSTALL_SNAPSHOT_CACHE.delete(oldest);
  }
  INSTALL_SNAPSHOT_CACHE.set(tokenHash, { snap, at: now });
  return snap;
}

async function forgetInstallSnapshot(env, tokenHash) {
  if (!tokenHash) return;
  INSTALL_SNAPSHOT_CACHE.delete(tokenHash);
  if (env && env.CONFIGS) {
    try {
      await env.CONFIGS.delete(INSTALL_SNAPSHOT_KEY_PREFIX + tokenHash);
    } catch {}
  }
}

// Before an account's installs are deleted: their snapshots would otherwise
// keep serving them, owner and secrets included, for up to a day.
async function forgetAccountInstallSnapshots(env, accountId) {
  if (!env || !env.DB || accountId == null) return;
  try {
    const { results } = await env.DB.prepare("SELECT token_hash FROM installs WHERE account_id = ?").bind(accountId).all();
    for (const r of results || []) await forgetInstallSnapshot(env, r.token_hash);
  } catch {
    // No installs table yet: nothing was ever snapshotted.
  }
}

// A moved legacy record, as resolveConfig reads it: the KV part plus its
// secrets from the table.
//
// The two ways the table cannot answer are treated differently. D1 failing is
// an outage, and the record serves without its secrets until it recovers. No
// row means it was deleted with its account (deleteAccountRow): the record's
// stamped owner is dropped too, so a link from a deleted account cannot read
// the shelves of whoever registers that username next. In both cases the
// unverified-shelf fallback (LEGACY_UNVERIFIED_CONFIG_SHELVES) is off, since
// what it relies on -- that the config never had a key -- is no longer known.
async function applyLegacyInstallRecord(env, id, parsed) {
  const out = { ...parsed };
  delete out._install;
  const snap = await loadInstallSnapshot(env, INSTALL_LEGACY_HASH_PREFIX + id);
  if (!snap) {
    out._legacyShelfRuleOff = true;
    return out;
  }
  if (snap.missing) {
    delete out.trackOwner;
    out._legacyShelfRuleOff = true;
    return out;
  }
  if (snap.revoked) return { _revoked: true };
  return { ...out, ...(await decryptInstallSecretFields(env, snap.id, snap.secrets)) };
}

async function resolveV2InstallConfig(param, env, { withTracking = false } = {}) {
  const token = param.slice(INSTALL_TOKEN_PARAM_PREFIX.length);
  if (!isWellFormedInstallToken(token)) return emptyResolvedInstallConfig();
  const snap = await loadInstallSnapshot(env, await installTokenHash(token));
  if (!snap || snap.missing || snap.revoked || typeof snap.config !== "string") return emptyResolvedInstallConfig();
  let cfg;
  try {
    cfg = JSON.parse(snap.config);
  } catch {
    return emptyResolvedInstallConfig();
  }
  if (!cfg || typeof cfg !== "object") return emptyResolvedInstallConfig();
  // The owner is the account that created it while signed in: proven once, at
  // creation, and ended by revoking the install or deleting the account (which
  // deletes the row).
  const owner = snap.owner || "";
  const canTrack = Boolean(owner) && String(snap.scopes || "").split(",").includes("track");
  let watchHistory = [];
  let continueWatching = [];
  let watchlist = [];
  let airingNext = [];
  if (withTracking && owner && env && env.CONFIGS) {
    try {
      const trackingRaw = await env.CONFIGS.get(`creatorsynctracking:${owner}`);
      const tracking = trackingRaw ? JSON.parse(trackingRaw) : null;
      if (tracking) {
        if (Array.isArray(tracking.watchHistory)) watchHistory = tracking.watchHistory;
        if (Array.isArray(tracking.continueWatching)) continueWatching = tracking.continueWatching;
        if (Array.isArray(tracking.watchlist)) watchlist = tracking.watchlist;
        if (Array.isArray(tracking.airingNext)) airingNext = tracking.airingNext;
      }
    } catch {}
  }
  const secrets = snap.secrets && snap.secrets.length ? await decryptInstallSecretFields(env, snap.id, snap.secrets) : {};
  // A v2 install carries no keys: its personal rows use the owner's own
  // connections (P3a-10, 28_connections.js).
  let fromConnections = {};
  if (snap.accountId != null) {
    try {
      fromConnections = await connectionFieldsForConfig(env, snap.accountId, readInstallConfigFields({ ...cfg, ...secrets }));
    } catch (e) {
      console.error("Could not read the install owner's connections:", e);
    }
  }
  const track = Boolean(cfg.track) && canTrack;
  return {
    entries: Array.isArray(cfg.entries) ? cfg.entries : [],
    watchHistory,
    continueWatching,
    watchlist,
    airingNext,
    ...readInstallConfigFields({ ...cfg, ...secrets, ...fromConnections }),
    track,
    trackCreatorName: owner,
    trackCreatorKey: "",
    trackOwner: owner,
    // Playback pings from this link record to this account. A legacy link
    // proves that with the Creator Key it carries; a v2 link has no key, and
    // its "track" scope, granted to a signed-in owner, is the proof instead.
    installTrackOwner: track ? owner : "",
  };
}

// Ids whose record resolveConfig found holding secrets and not yet moved. The
// manifest and catalog routes hand these to maybeMigrateLegacyInstall.
const LEGACY_INSTALL_CANDIDATES = new Set();
const LEGACY_INSTALL_CANDIDATES_MAX = 5000;

function noteLegacyInstallCandidate(id, parsed) {
  if (!installRecordHasSecrets(parsed)) return;
  if (LEGACY_INSTALL_CANDIDATES.size >= LEGACY_INSTALL_CANDIDATES_MAX) LEGACY_INSTALL_CANDIDATES.clear();
  LEGACY_INSTALL_CANDIDATES.add(id);
}

// Run from the manifest and catalog routes under ctx.waitUntil, so a request
// never waits on the move. Tried once per isolate per id; a failure is left for
// a later isolate to retry.
async function maybeMigrateLegacyInstall(env, id) {
  if (!LEGACY_INSTALL_CANDIDATES.has(id)) return;
  LEGACY_INSTALL_CANDIDATES.delete(id);
  const percent = installMigrationPercent(env);
  if (!percent) return;
  if (percent < 100 && (await installMigrationBucket(id)) >= percent) return;
  try {
    const result = await migrateLegacyInstall(env, id);
    // Never the id itself in a log line: it is the link, and works like a
    // password for it.
    if (!result.ok && result.reason !== "nothing-to-move") {
      console.warn(`An install link was not moved: ${result.reason}`);
    }
  } catch (e) {
    console.error("An install link's move failed:", e);
  }
}

// The creator a legacy config names, the way resolveConfig finds it.
function legacyInstallNamedCreator(parsed) {
  let name = parsed.trackCreatorName || parsed.creatorName || "";
  if (!name && Array.isArray(parsed.entries)) {
    for (const e of parsed.entries) {
      if (e && typeof e.url === "string" && e.url.startsWith("autotrack:")) {
        const parts = e.url.split(":");
        if (parts.length >= 4 && parts[3]) {
          name = parts[3];
          break;
        }
      }
    }
  }
  return String(name || "");
}

// Moves one legacy record's secrets into the table and rewrites the record
// without them. Order is what makes it safe to interrupt at any point:
//   1. the install row, and its owner if the record proves one;
//   2. the secrets, encrypted, then decrypted again and compared with the
//      originals -- nothing is removed from KV unless they match exactly;
//   3. only then the KV record, rewritten without them.
// A retry after a failure at any step finds the row (INSERT OR IGNORE),
// rewrites the secrets and carries on. /api/save never rewrites an id, so no
// save can race this.
async function migrateLegacyInstall(env, id) {
  if (!env || !env.DB || !env.CONFIGS) return { ok: false, reason: "unbound" };
  if (typeof id !== "string" || !id || id.length > SHORT_ID_LENGTH) return { ok: false, reason: "not-a-legacy-id" };
  let raw = await env.CONFIGS.get(savedConfigKey(id));
  let atBareKey = false;
  if (!raw) {
    raw = await env.CONFIGS.get(id);
    atBareKey = Boolean(raw);
  }
  if (!raw) return { ok: false, reason: "missing" };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "shape" };
  if (parsed._install) return { ok: true, already: true };
  const { publicPart, byProvider, hasSecrets } = splitInstallSecrets(parsed);
  if (!hasSecrets) return { ok: false, reason: "nothing-to-move" };
  if (!hasTokenEncryptionKey(env)) return { ok: false, reason: "no-encryption-key" };

  // The owner, bound only when the record proves it the way resolveConfig
  // accepts: the Creator Key it carries still verifies, or /api/save stamped
  // the owner after verifying. This binding is for listing and for deletion
  // with the account; serving still derives the owner from the record.
  let accountId = null;
  const named = legacyInstallNamedCreator(parsed);
  const v = named ? validateCreatorUsername(named) : { ok: false };
  if (v.ok) {
    const [tombstoned, rawProfile] = await Promise.all([
      isCreatorTombstoned(env, v.normalized),
      getCreator(env, v.normalized),
    ]);
    // Mid-deletion: wait until the account is gone, then move it unowned.
    if (tombstoned) return { ok: false, reason: "owner-being-deleted" };
    let profile = null;
    try {
      profile = rawProfile ? JSON.parse(rawProfile) : null;
    } catch {
      profile = null;
    }
    if (profile && typeof profile.keyHash === "string" && profile.keyHash) {
      const keyOk = typeof parsed.trackCreatorKey === "string" && parsed.trackCreatorKey
        ? await verifyCreatorKeyMemoized(parsed.trackCreatorKey, profile.keyHash, v.normalized)
        : false;
      const stampOk = typeof parsed.trackOwner === "string" && parsed.trackOwner.toLowerCase() === v.normalized;
      if (keyOk || stampOk) {
        const account = await getOrBackfillAccount(env, v.normalized, profile);
        if (!account) return { ok: false, reason: "no-accounts-table" };
        accountId = account.id;
      }
    }
  }

  const tokenHash = INSTALL_LEGACY_HASH_PREFIX + id;
  const now = Date.now();
  let row;
  try {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO installs (token_hash, legacy_cfg_id, account_id, name, config_json, version, scopes, created_at, updated_at, last_used_at) " +
      // config_json stays "{}": a legacy install's config lives in its cfg:
      // record, which every request reads anyway.
      "VALUES (?, ?, ?, NULL, '{}', 1, 'read', ?, ?, ?)"
    ).bind(tokenHash, id, accountId, now, now, now).run();
    row = await env.DB.prepare("SELECT id, account_id, revoked_at FROM installs WHERE legacy_cfg_id = ?").bind(id).first();
  } catch (e) {
    return { ok: false, reason: "d1-failed", error: safeErrorMessage(e) };
  }
  if (!row) return { ok: false, reason: "d1-failed" };
  if (row.revoked_at != null) return { ok: false, reason: "revoked" };

  let secretRows;
  try {
    secretRows = await encryptInstallSecrets(env, row.id, byProvider);
    const restored = await decryptInstallSecretFields(env, row.id, secretRows);
    for (const name of Object.keys(parsed)) {
      if (!isInstallSecretFieldName(name) || parsed[name] == null || parsed[name] === "") continue;
      if (JSON.stringify(restored[name]) !== JSON.stringify(parsed[name])) {
        return { ok: false, reason: "round-trip-mismatch", field: name };
      }
    }
    const stmts = secretRows.map((s) => env.DB.prepare(
      "INSERT OR REPLACE INTO install_secrets (install_id, provider, access_token_enc, refresh_token_enc, expires_at, api_key_enc, updated_at) " +
      "VALUES (?, ?, ?, NULL, NULL, ?, ?)"
    ).bind(row.id, s.provider, s.access_token_enc, s.api_key_enc, now));
    if (accountId != null && row.account_id == null) {
      stmts.push(env.DB.prepare("UPDATE installs SET account_id = ? WHERE id = ? AND account_id IS NULL").bind(accountId, row.id));
    }
    await env.DB.batch(stmts);
  } catch (e) {
    return { ok: false, reason: "secrets-failed", error: safeErrorMessage(e) };
  }

  await forgetInstallSnapshot(env, tokenHash);
  await env.CONFIGS.put(savedConfigKey(id), JSON.stringify({ ...publicPart, _install: row.id }));
  if (atBareKey) {
    // The pre-prefix copy still holds the secrets. resolveConfig reads cfg:
    // first, so the record just written is the one served from here on.
    try {
      await env.CONFIGS.delete(id);
    } catch {}
  }
  return { ok: true, installId: row.id, owned: (accountId != null) || row.account_id != null };
}

// The move, undone: a moved legacy record gets its keys and tokens back, as
// they were, and its rows leave the table. For an emergency only, and only
// while INSTALL_MIGRATION_PERCENT is 0 -- otherwise the next request would
// move it straight back. KV is written before anything in D1 is deleted, so a
// failure part-way leaves each record either moved or restored, never
// stripped with its secrets gone. A removed (revoked) install is left as it
// is: restoring it would make its link serve again.
async function restoreLegacyInstalls(env, { limit = 50, afterId = 0 } = {}) {
  if (!env || !env.DB || !env.CONFIGS) return { ok: false, error: "D1 and KV must both be bound." };
  if (installMigrationPercent(env) > 0) {
    return { ok: false, error: "Set INSTALL_MIGRATION_PERCENT to 0 first, or the links would be moved again on their next use." };
  }
  if (!hasTokenEncryptionKey(env)) return { ok: false, error: "TOKEN_ENCRYPTION_KEY is missing, so the stored keys cannot be read." };
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  // A cursor, so a record that keeps failing cannot hold up every one after it.
  const { results } = await env.DB.prepare(
    "SELECT id, legacy_cfg_id, token_hash FROM installs WHERE legacy_cfg_id IS NOT NULL AND revoked_at IS NULL AND id > ? ORDER BY id LIMIT ?"
  ).bind(Number(afterId) || 0, n).all();
  let restored = 0;
  let lastId = Number(afterId) || 0;
  const failed = [];
  for (const r of results || []) {
    lastId = r.id;
    const id = r.legacy_cfg_id;
    try {
      const raw = await env.CONFIGS.get(savedConfigKey(id));
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && parsed._install) {
        const { results: secretRows } = await env.DB.prepare(
          "SELECT provider, access_token_enc, api_key_enc FROM install_secrets WHERE install_id = ?"
        ).bind(r.id).all();
        // Every row has to come back. decryptInstallSecretFields skips one it
        // cannot read, which is right for serving and wrong here: the rows are
        // deleted next.
        const fields = {};
        for (const sr of secretRows || []) {
          const one = await decryptInstallSecretFields(env, r.id, [sr]);
          if (!Object.keys(one).length) throw new Error(`its ${sr.provider} keys would not decrypt`);
          Object.assign(fields, one);
        }
        const record = { ...parsed, ...fields };
        delete record._install;
        await env.CONFIGS.put(savedConfigKey(id), JSON.stringify(record));
      }
      await env.DB.batch([
        env.DB.prepare("DELETE FROM install_secrets WHERE install_id = ?").bind(r.id),
        env.DB.prepare("DELETE FROM installs WHERE id = ?").bind(r.id),
      ]);
      await forgetInstallSnapshot(env, r.token_hash);
      restored++;
    } catch (e) {
      console.error(`Install ${r.id}: restore failed:`, e);
      failed.push({ installId: r.id, error: safeErrorMessage(e) });
    }
  }
  const left = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM installs WHERE legacy_cfg_id IS NOT NULL AND revoked_at IS NULL"
  ).first();
  return {
    ok: failed.length === 0,
    restored,
    failed,
    remaining: Number(left && left.n) || 0,
    // Pass back as afterId for the next batch; done when a batch is empty.
    nextAfterId: lastId,
    done: !(results || []).length,
  };
}

// --- /api/installs: an account's own installs (session required) ------------

function installSummary(row, origin) {
  const legacy = row.legacy_cfg_id != null;
  let rows = null;
  if (!legacy) {
    try {
      const cfg = JSON.parse(row.config_json || "{}");
      rows = Array.isArray(cfg.entries) ? cfg.entries.length : 0;
    } catch {
      rows = 0;
    }
  }
  return {
    id: row.id,
    kind: legacy ? "legacy" : "v2",
    name: row.name || null,
    // A legacy link is its id, so its owner can be shown it again. A v2
    // link's token is only ever shown when it is created or rotated.
    manifestUrl: legacy ? `${origin}/${row.legacy_cfg_id}/manifest.json` : null,
    rows,
    scopes: String(row.scopes || "read").split(","),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

// The config a v2 install stores: its rows, and every setting except keys and
// tokens. A personal shelf may only be the signed-in account's own.
function buildV2InstallConfig(body, account) {
  const entries = Array.isArray(body.entries) ? body.entries : [];
  if (!entries.length) return { error: "No lists provided.", status: 400 };
  if (entries.length > SAVED_CONFIG_ENTRIES_MAX) return { error: "Too many lists in that configuration.", status: 413 };
  const me = String(account.username || "").toLowerCase();
  for (const e of entries) {
    const eUrl = e && typeof e.url === "string" ? e.url : "";
    for (const line of eUrl.split("\n")) {
      const s = line.trim();
      if (!s.startsWith("autotrack:")) continue;
      const segs = s.split(":");
      if (segs.length >= 4 && segs[3] && String(segs[3]).toLowerCase().trim() !== me) {
        return { error: "An install can only carry your own Watch History, Continue Watching or Watchlist.", status: 400 };
      }
    }
  }
  const config = { entries, ...nonSecretInstallConfigFields(storedInstallConfigFields(body, true)) };
  if (body.track) config.track = true;
  const json = JSON.stringify(config);
  if (utf8ByteLength(json) > INSTALL_CONFIG_JSON_MAX) return { error: "That configuration is too large to save.", status: 413 };
  return { config, json };
}

function installNameFrom(value) {
  if (value == null) return null;
  const name = String(value).trim().slice(0, INSTALL_NAME_MAX);
  return name || null;
}

const INSTALL_ROW_COLUMNS = "id, token_hash, legacy_cfg_id, account_id, name, config_json, version, scopes, created_at, updated_at, last_used_at, revoked_at";

async function handleInstallsApi(request, env, url, path) {
  if (path !== "/api/installs" && !path.startsWith("/api/installs/") && !path.startsWith("/admin/api/installs/")) return null;
  try {
    return await handleInstallsApiRoutes(request, env, url, path);
  } catch (e) {
    // Most often migration 0015 not applied yet.
    console.error("Installs API failed:", e);
    return json({ ok: false, error: "Installs aren't available right now." }, 503);
  }
}

async function handleInstallsApiRoutes(request, env, url, path) {
  if (path.startsWith("/admin/api/installs/")) {
    if (!(await isAdminRequest(request, env))) return json({ ok: false, error: "Not authorized." }, 401);
    if (path === "/admin/api/installs/status" && request.method === "GET") return json(await installsStatus(env));
    if (path === "/admin/api/installs/restore" && request.method === "POST") {
      let body = {};
      try {
        body = await request.json();
      } catch {}
      return json(await restoreLegacyInstalls(env, { limit: body && body.limit, afterId: body && body.afterId }));
    }
    return json({ ok: false, error: "Not found." }, 404);
  }
  if (path !== "/api/installs" && !path.startsWith("/api/installs/")) return null;
  if (!isInstallsEnabled(env)) return json({ ok: false, error: "Not found." }, 404);
  if (!env || !env.DB) return json({ ok: false, error: "Installs aren't available right now." }, 503);
  if (!request.account) {
    return json({ ok: false, error: "Sign in to manage your installs.", signInRequired: true }, 401);
  }
  const accountId = request.account.id;
  const sub = path.slice("/api/installs".length);

  if (sub === "" || sub === "/") {
    if (request.method === "GET") {
      const { results } = await env.DB.prepare(
        `SELECT ${INSTALL_ROW_COLUMNS} FROM installs WHERE account_id = ? ORDER BY created_at DESC LIMIT 200`
      ).bind(accountId).all();
      return json({ ok: true, installs: (results || []).map((r) => installSummary(r, url.origin)) });
    }
    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const built = buildV2InstallConfig(body || {}, request.account);
      if (built.error) return json({ ok: false, error: built.error }, built.status);
      const active = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM installs WHERE account_id = ? AND legacy_cfg_id IS NULL AND revoked_at IS NULL"
      ).bind(accountId).first();
      if (active && active.n >= INSTALLS_PER_ACCOUNT_MAX) {
        return json({ ok: false, error: `You can have up to ${INSTALLS_PER_ACCOUNT_MAX} install links. Remove one first.` }, 409);
      }
      const token = generateInstallToken();
      const tokenHash = await installTokenHash(token);
      const now = Date.now();
      await env.DB.prepare(
        "INSERT INTO installs (token_hash, legacy_cfg_id, account_id, name, config_json, version, scopes, created_at, updated_at, last_used_at) " +
        "VALUES (?, NULL, ?, ?, ?, 1, ?, ?, ?, NULL)"
      ).bind(tokenHash, accountId, installNameFrom(body.name), built.json, built.config.track ? "read,track" : "read", now, now).run();
      const row = await env.DB.prepare(`SELECT ${INSTALL_ROW_COLUMNS} FROM installs WHERE token_hash = ?`).bind(tokenHash).first();
      return json({
        ok: true,
        install: installSummary(row, url.origin),
        // Shown this once. Only its hash is kept, so it cannot be shown again;
        // rotating it (PATCH { rotateToken: true }) issues a new one.
        token,
        manifestUrl: `${url.origin}/i/${token}/manifest.json`,
      }, 201);
    }
    return json({ ok: false, error: "Method not allowed." }, 405);
  }

  const m = /^\/(\d+)$/.exec(sub);
  if (!m) return json({ ok: false, error: "Not found." }, 404);
  const installId = Number(m[1]);
  const row = await env.DB.prepare(
    `SELECT ${INSTALL_ROW_COLUMNS} FROM installs WHERE id = ? AND account_id = ?`
  ).bind(installId, accountId).first();
  // Someone else's install answers exactly like one that does not exist.
  if (!row) return json({ ok: false, error: "Not found." }, 404);

  if (request.method === "GET") {
    return json({ ok: true, install: installSummary(row, url.origin) });
  }

  if (request.method === "DELETE") {
    const now = Date.now();
    await env.DB.prepare(
      "UPDATE installs SET revoked_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL"
    ).bind(now, now, installId, accountId).run();
    await forgetInstallSnapshot(env, row.token_hash);
    return json({ ok: true, revoked: true });
  }

  if (request.method === "PATCH") {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "Invalid JSON body." }, 400);
    }
    body = body || {};
    if (row.revoked_at != null) return json({ ok: false, error: "That install link has been removed." }, 409);
    // Optimistic concurrency: a client that read version N may only replace N.
    const expected = body.version != null ? Number(body.version) : Number(String(request.headers.get("If-Match") || "").replace(/"/g, "") || NaN);
    if (Number.isFinite(expected) && expected !== row.version) {
      return json({ ok: false, error: "That install link was changed somewhere else. Reload and try again.", version: row.version }, 409);
    }
    const legacy = row.legacy_cfg_id != null;
    const changesConfig = body.entries !== undefined || body.track !== undefined ||
      INSTALL_CONFIG_FIELDS.some((f) => body[f.name] !== undefined);
    if (legacy && (changesConfig || body.rotateToken)) {
      return json({ ok: false, error: "An older install link can only be renamed or removed here. Update its lists from its Configure page." }, 400);
    }
    let name = row.name;
    if (body.name !== undefined) name = installNameFrom(body.name);
    let configJson = row.config_json;
    let scopes = row.scopes;
    if (changesConfig) {
      const current = (() => {
        try { return JSON.parse(row.config_json || "{}"); } catch { return {}; }
      })();
      const merged = { ...current, ...body };
      if (body.entries === undefined) merged.entries = current.entries;
      if (body.track === undefined) merged.track = current.track;
      const built = buildV2InstallConfig(merged, request.account);
      if (built.error) return json({ ok: false, error: built.error }, built.status);
      configJson = built.json;
      scopes = built.config.track ? "read,track" : "read";
    }
    let token = null;
    let tokenHash = row.token_hash;
    if (body.rotateToken) {
      token = generateInstallToken();
      tokenHash = await installTokenHash(token);
    }
    const now = Date.now();
    const res = await env.DB.prepare(
      "UPDATE installs SET name = ?, config_json = ?, scopes = ?, token_hash = ?, version = version + 1, updated_at = ? " +
      "WHERE id = ? AND account_id = ? AND version = ?"
    ).bind(name, configJson, scopes, tokenHash, now, installId, accountId, row.version).run();
    if (!(res && res.meta && res.meta.changes > 0)) {
      return json({ ok: false, error: "That install link was changed somewhere else. Reload and try again." }, 409);
    }
    await forgetInstallSnapshot(env, row.token_hash);
    if (tokenHash !== row.token_hash) await forgetInstallSnapshot(env, tokenHash);
    const updated = await env.DB.prepare(`SELECT ${INSTALL_ROW_COLUMNS} FROM installs WHERE id = ?`).bind(installId).first();
    const out = { ok: true, install: installSummary(updated, url.origin) };
    if (token) {
      out.token = token;
      out.manifestUrl = `${url.origin}/i/${token}/manifest.json`;
    }
    return json(out);
  }

  return json({ ok: false, error: "Method not allowed." }, 405);
}

// For the admin panel: how far the move has got, and whether it can run.
async function installsStatus(env) {
  const out = {
    ok: true,
    installsEnabled: isInstallsEnabled(env),
    migrationPercent: installMigrationPercent(env),
    encryptionKeyConfigured: hasTokenEncryptionKey(env),
    total: 0,
    legacy: 0,
    v2: 0,
    owned: 0,
    revoked: 0,
    withSecrets: 0,
  };
  if (!env || !env.DB) return { ...out, ok: false, error: "D1 is not bound." };
  try {
    const counts = await env.DB.prepare(
      "SELECT COUNT(*) AS total, " +
      "COALESCE(SUM(CASE WHEN legacy_cfg_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS legacy, " +
      "COALESCE(SUM(CASE WHEN account_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS owned, " +
      "COALESCE(SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS revoked " +
      "FROM installs"
    ).first();
    const secrets = await env.DB.prepare("SELECT COUNT(DISTINCT install_id) AS n FROM install_secrets").first();
    out.total = Number(counts.total) || 0;
    out.legacy = Number(counts.legacy) || 0;
    out.v2 = out.total - out.legacy;
    out.owned = Number(counts.owned) || 0;
    out.revoked = Number(counts.revoked) || 0;
    out.withSecrets = Number(secrets && secrets.n) || 0;
  } catch (e) {
    return { ...out, ok: false, error: "Migration 0015 has not been applied: " + safeErrorMessage(e) };
  }
  return out;
}
