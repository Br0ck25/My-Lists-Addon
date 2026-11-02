// --- Media-server webhook tokens, stored hashed (SEC-04) ------------------------
//
// A webhook token (?st=) used to be the primary key of scrobble_tokens and a KV
// key name, so a copy of the database or a KV listing was a list of working
// tokens. With TOKEN_ENCRYPTION_KEY set and migration 0024 applied:
//
//   * scrobble_tokens.token_hash = SHA-256(token) is what a request is looked up by,
//   * scrobble_tokens.token_enc  = the token encrypted for the Settings page
//     (context "scrobble:<username>"), so the webhook URL can be shown again,
//   * scrobble_tokens.token      = "hashed:<hash>", which no request can send
//     (a token may not contain ":"),
//   * KV is keyed by the hash (scrobbletoken:h:<hash>), and the reverse index
//     creatorscrobbletoken:<username> holds "h:<hash>", so the existing
//     account-purge code, which deletes scrobbleTokenKey(<reverse index value>),
//     removes it unchanged.
//
// A plain-text row is converted the first time it authenticates or is shown.
// Without the key or the migration every function here hands over to the older
// getOrCreateScrobbleToken / usernameForScrobbleToken (02_) and nothing changes.

let scrobbleHashColumnsMissing = false;

function scrobbleHashUsable(env) {
  return Boolean(env && env.DB && !scrobbleHashColumnsMissing && hasTokenEncryptionKey(env));
}

// True (and remembered for this isolate) when the error is the missing 0024 columns.
function noteScrobbleHashColumnsMissing(err) {
  if (!/no such column/i.test(String((err && err.message) || err))) return false;
  scrobbleHashColumnsMissing = true;
  return true;
}

const SCROBBLE_STORED_FORM = /^(hashed:|h:)/;

function scrobbleTokenContext(username) {
  return "scrobble:" + String(username || "");
}

async function scrobbleHashRow(env, username) {
  return env.DB.prepare("SELECT token, token_hash, token_enc FROM scrobble_tokens WHERE username = ?").bind(username).first();
}

// Fills hash + encrypted copy for a plain-text token and removes the raw token
// from D1 and KV. Best-effort: a failure leaves the plain row working as before.
async function migrateScrobbleToken(env, username, token) {
  try {
    const hash = await hashSessionToken(token);
    const enc = await encryptToken(token, env, scrobbleTokenContext(username));
    if (env.CONFIGS) {
      await env.CONFIGS.put(scrobbleTokenKey("h:" + hash), username);
      await env.CONFIGS.put(creatorScrobbleTokenKey(username), "h:" + hash);
    }
    await env.DB.prepare(
      "UPDATE scrobble_tokens SET token_hash = ?, token_enc = ?, token = ? WHERE username = ? AND token = ?"
    ).bind(hash, enc, "hashed:" + hash, username, token).run();
    if (env.CONFIGS) await env.CONFIGS.delete(scrobbleTokenKey(token));
  } catch (err) {
    noteScrobbleHashColumnsMissing(err);
    console.error("Could not hash a webhook token:", err && err.message);
  }
}

// Mints a token stored hashed. "" when a rotation could not reach D1 (as the
// older function), null when the 0024 columns are missing (caller falls back).
async function mintHashedScrobbleToken(env, username, rotate, previous) {
  const token = generateShortId() + generateShortId();
  const hash = await hashSessionToken(token);
  const enc = await encryptToken(token, env, scrobbleTokenContext(username));
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM scrobble_tokens WHERE username = ?").bind(username),
      env.DB.prepare(
        "INSERT INTO scrobble_tokens (token, username, created_at, token_hash, token_enc) VALUES (?, ?, ?, ?, ?)"
      ).bind("hashed:" + hash, username, Date.now(), hash, enc),
    ]);
  } catch (err) {
    if (noteScrobbleHashColumnsMissing(err)) return null;
    console.error("D1 write error (scrobble_tokens):", err);
    if (rotate) return "";
  }
  if (env.CONFIGS) {
    await env.CONFIGS.put(scrobbleTokenKey("h:" + hash), username);
    await env.CONFIGS.put(creatorScrobbleTokenKey(username), "h:" + hash);
    if (previous) {
      try {
        await env.CONFIGS.delete(scrobbleTokenKey(previous));
      } catch {
        console.error("scrobble token rotation: could not revoke the previous token");
      }
    }
  }
  return token;
}

// What Settings calls: the account's token (minted if it has none), stored
// hashed when it can be. `rotate` revokes the old one.
async function getOrCreateScrobbleTokenSecure(env, username, rotate = false) {
  if (!scrobbleHashUsable(env)) return legacyScrobbleTokenOrRotate(env, username, rotate);
  let row = null;
  try {
    row = await scrobbleHashRow(env, username);
  } catch (err) {
    if (noteScrobbleHashColumnsMissing(err)) return legacyScrobbleTokenOrRotate(env, username, rotate);
  }
  let previous = "";
  if (row && !rotate) {
    if (row.token_enc) {
      try {
        const shown = await decryptToken(row.token_enc, env, scrobbleTokenContext(username));
        if (shown) return shown;
      } catch (err) {
        console.error("Could not read a webhook token; issuing a new one:", err && err.message);
      }
    } else if (row.token && !SCROBBLE_STORED_FORM.test(row.token)) {
      await migrateScrobbleToken(env, username, row.token);
      return row.token;
    }
  }
  if (!row && !rotate && env.CONFIGS) {
    // Known only to KV (never reached D1): let the older code back-fill D1, then convert.
    const kvToken = (await env.CONFIGS.get(creatorScrobbleTokenKey(username))) || "";
    if (kvToken && !SCROBBLE_STORED_FORM.test(kvToken)) {
      const t = await getOrCreateScrobbleToken(env, username, false);
      if (t && !SCROBBLE_STORED_FORM.test(t)) {
        await migrateScrobbleToken(env, username, t);
        return t;
      }
    }
  }
  if (env.CONFIGS) previous = ((await env.CONFIGS.get(creatorScrobbleTokenKey(username))) || "");
  const minted = await mintHashedScrobbleToken(env, username, rotate, previous);
  if (minted === null) return legacyScrobbleTokenOrRotate(env, username, rotate);
  return minted;
}

// The older function, guarded so a hashed row it cannot read is replaced
// rather than handed out ("hashed:..." must never be shown as a token).
async function legacyScrobbleTokenOrRotate(env, username, rotate) {
  const token = await getOrCreateScrobbleToken(env, username, rotate);
  if (token && SCROBBLE_STORED_FORM.test(token)) return getOrCreateScrobbleToken(env, username, true);
  return token;
}

// What the webhook calls: the account a presented token belongs to, or "".
async function usernameForScrobbleTokenSecure(env, token) {
  const t = String(token || "").trim();
  if (!t || t.length > 64 || !/^[A-Za-z0-9_-]+$/.test(t)) return "";
  if (!scrobbleHashUsable(env)) return usernameForScrobbleToken(env, t);
  const hash = await hashSessionToken(t);
  let d1Failed = false;
  try {
    const row = await env.DB.prepare("SELECT username FROM scrobble_tokens WHERE token_hash = ?").bind(hash).first();
    if (row && row.username) return row.username;
  } catch (err) {
    if (noteScrobbleHashColumnsMissing(err)) return usernameForScrobbleToken(env, t);
    d1Failed = true;
  }
  if (d1Failed && env.CONFIGS) {
    // D1 is down: the hashed KV copy keeps a working token working.
    try {
      return (await env.CONFIGS.get(scrobbleTokenKey("h:" + hash))) || "";
    } catch {
      return "";
    }
  }
  const user = await usernameForScrobbleToken(env, t);
  if (user) await migrateScrobbleToken(env, user, t);
  return user;
}
