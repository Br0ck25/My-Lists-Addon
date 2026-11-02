// SEC-02: the provider keys and tokens of the cloud-sync blob (creatorsync:<name>.keys)
// are stored as { enc: "<encryptToken(JSON)>" } when TOKEN_ENCRYPTION_KEY is set,
// bound to the account name. openSyncKeys also accepts the old plain object, so
// nothing has to be migrated: a blob is sealed the next time it is saved. With no
// encryption key both functions pass the plain object through, as before.
function syncKeysContext(username) {
  return "creatorsync:" + String(username || "");
}

async function sealSyncKeys(env, username, keys) {
  if (!keys || typeof keys !== "object" || !Object.keys(keys).length || !hasTokenEncryptionKey(env)) return keys;
  return { enc: await encryptToken(JSON.stringify(keys), env, syncKeysContext(username)) };
}

// Always a plain object. A sealed value that cannot be opened (key removed from
// the ring, copied from another account) reads as empty rather than throwing.
async function openSyncKeys(env, username, stored) {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  if (typeof stored.enc !== "string") return stored;
  try {
    const plain = JSON.parse(await decryptToken(stored.enc, env, syncKeysContext(username)));
    return plain && typeof plain === "object" && !Array.isArray(plain) ? plain : {};
  } catch (err) {
    console.error("Could not open the sealed sync keys:", err && err.message);
    return {};
  }
}
