// --- Old Account Key fingerprints (SEC-01) ---------------------------------------
//
// Before the peppered blind index, every key create/reset wrote an unsalted
// SHA-256 fingerprint of the Account Key: a creator_key_lookups row and two KV
// keys (keylookup:<hash>, creatorlookuphash:<name>). Someone holding a copy of
// those can test key guesses against every account at once, so accounts that
// already have accounts.key_lookup_hmac do not need them. /admin/api/key-lookup-cleanup
// counts them (the default) and removes them in batches, only when told to and
// only with the confirmation phrase.
//
// Accounts WITHOUT an HMAC are never touched: their legacy copy is the only way
// forgot-username finds them without scanning every account with PBKDF2. They
// lose it by signing in once with LOOKUP_PEPPER set (see storeCreatorKeyLookup).

const KEY_LOOKUP_CLEANUP_CONFIRM = "delete legacy key lookups";
const KEY_LOOKUP_CLEANUP_BATCH = 50;
const KEY_LOOKUP_CLEANUP_BATCH_MAX = 200;

async function accountHasLegacyKeyLookup(env, username) {
  if (env.DB) {
    const row = await env.DB.prepare("SELECT 1 AS one FROM creator_key_lookups WHERE username = ? LIMIT 1").bind(username).first();
    if (row) return true;
  }
  if (env.CONFIGS && (await env.CONFIGS.get(creatorLookupHashKey(username)))) return true;
  return false;
}

// One batch. `cursor` is the previous call's `next` (an accounts.id); `done` is
// true when every account with an HMAC has been looked at.
async function cleanLegacyKeyLookups(env, { cursor, limit, apply } = {}) {
  if (!env || !env.DB) return { ok: false, error: "no-database" };
  const n = Math.max(1, Math.min(KEY_LOOKUP_CLEANUP_BATCH_MAX, Number(limit) || KEY_LOOKUP_CLEANUP_BATCH));
  const out = { ok: true, apply: !!apply, scanned: 0, withLegacy: 0, cleaned: 0, next: null, done: true };
  let rows;
  try {
    const res = await env.DB.prepare(
      "SELECT id, username FROM accounts WHERE key_lookup_hmac IS NOT NULL AND id > ? ORDER BY id LIMIT ?"
    ).bind(Math.max(0, Number(cursor) || 0), n).all();
    rows = (res && res.results) || [];
  } catch (err) {
    if (/no such column/i.test(String((err && err.message) || err))) return { ok: false, error: "The accounts table has no key_lookup_hmac column yet." };
    throw err;
  }
  out.scanned = rows.length;
  for (const r of rows) {
    if (!(await accountHasLegacyKeyLookup(env, r.username))) continue;
    out.withLegacy++;
    if (!apply) continue;
    await deleteLegacyCreatorKeyLookup(env, r.username);
    out.cleaned++;
  }
  if (rows.length === n) {
    out.next = rows[rows.length - 1].id;
    out.done = false;
  }
  return out;
}
