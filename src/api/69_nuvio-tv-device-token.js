// A username is public (it is in every creator page address), so it cannot be
// the proof that a request comes from its owner (audit SEC-01, SEC-02, owner
// decision 2026-11-10).
//
// 1. Pairing a Nuvio TV mints an install link of its own, with the `tv` scope.
//    The TV keeps that secret token as its id, and its manifest and sync
//    addresses are built on it. Only the token opens the TV's history routes.
//    The link is a live view of the account's synced rows and counts as the
//    owner for private shelves and playback pings, like any signed-in install
//    link; removing it under Install links stops that TV.
// 2. A bare /<username>/... link still serves the account's public rows, but
//    no longer counts as the owner: private shelves and the playback ping need
//    a link that holds a secret. LEGACY_USERNAME_OWNER_LINKS=1 turns the old
//    behaviour back on if it has to be undone in a hurry.

const NUVIO_TV_INSTALL_NAME = "Nuvio TV";
const NUVIO_TV_INSTALLS_MAX = 5;

function legacyUsernameOwnerLinks(env) {
  return Boolean(env) && (env.LEGACY_USERNAME_OWNER_LINKS === "1" || env.LEGACY_USERNAME_OWNER_LINKS === "true" || env.LEGACY_USERNAME_OWNER_LINKS === true);
}

// The same rows, without the claim to be the owner.
function withoutOwnerProof(resolved) {
  return { ...resolved, trackOwner: "", installTrackOwner: "", trackCreatorName: "", trackCreatorKey: "" };
}

// A new TV install for this account. Returns its token (shown to the TV once)
// or null when it could not be made. Keeps the newest NUVIO_TV_INSTALLS_MAX.
async function mintNuvioTvInstall(env, accountId) {
  if (!env || !env.DB || !Number.isInteger(accountId)) return null;
  try {
    const token = generateInstallToken();
    const tokenHash = await installTokenHash(token);
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO installs (token_hash, legacy_cfg_id, account_id, name, config_json, version, scopes, created_at, updated_at, last_used_at) " +
      "VALUES (?, NULL, ?, ?, ?, 1, 'read,track,tv', ?, ?, NULL)"
    ).bind(tokenHash, accountId, NUVIO_TV_INSTALL_NAME, JSON.stringify({ liveSync: true }), now, now).run();
    const { results } = await env.DB.prepare(
      "SELECT id, token_hash FROM installs WHERE account_id = ? AND scopes LIKE '%tv%' AND revoked_at IS NULL ORDER BY created_at DESC, id DESC"
    ).bind(accountId).all();
    for (const old of (results || []).slice(NUVIO_TV_INSTALLS_MAX)) {
      await env.DB.prepare("UPDATE installs SET revoked_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now, now, old.id).run();
      await forgetInstallSnapshot(env, old.token_hash);
    }
    return token;
  } catch (e) {
    console.error("[NuvioTV] could not make the TV install link:", e);
    return null;
  }
}

// { username, accountId } for a live TV token, else null. Only a token proves
// it: not a username, an account id or an ordinary install link.
async function resolveNuvioTvDeviceToken(env, token) {
  if (!env || !env.DB || !isWellFormedInstallToken(token)) return null;
  try {
    const row = await env.DB.prepare(
      "SELECT i.account_id, i.scopes, a.username, a.deleted_at FROM installs i JOIN accounts a ON a.id = i.account_id WHERE i.token_hash = ? AND i.revoked_at IS NULL"
    ).bind(await installTokenHash(token)).first();
    if (!row || row.deleted_at || !String(row.scopes || "").split(",").includes("tv")) return null;
    return { username: row.username, accountId: row.account_id };
  } catch {
    return null;
  }
}
