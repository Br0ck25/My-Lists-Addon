// Owner check for a stored track-on config (resolveConfig). Moved out of
// 02_http-and-creator-utils.js unchanged apart from the 10 s memo (PERF-16), because
// that file is over its size baseline and may only shrink (tests/size-budget.json).

// Proves a Creator Name + Creator Key pair, and answers with the username it
// proves or "".
//
// This is authenticateCreator's check without the parts that need a request:
// same tombstone, same record read, same PBKDF2-with-memo. It exists because
// authenticateCreator lives inside handleFetch's closure and resolveConfig is
// a module-scope function every catalog request goes through.
//
// The ONE caller is resolveConfig, and only for a STORED config -- i.e. a
// credential this Worker itself wrote into KV, not one a caller just handed
// over -- so there is no unbounded-PBKDF2 path here to throttle. A base64
// config is caller-authored and is never given to this function.
//
// A success is remembered for 10 s in this isolate (the SESSION_CACHE window,
// audit SESS-001), because every row of a track-on link asks again and each ask
// was a KV tombstone read, a D1 tombstone query and SELECT * FROM creators. So an
// account deleted or re-keyed on another isolate can still serve its shelf here
// for up to 10 s; on this isolate purgeCreatorData and a key rotation clear it at
// once. Failures are never remembered, and the memo key is a SHA-256 of the name
// and the presented key, never the key itself.
const SHELF_OWNER_MEMO = new Map();
const SHELF_OWNER_MEMO_TTL_MS = 10 * 1000;
const SHELF_OWNER_MEMO_MAX = 1000;

async function verifyShelfOwner(env, creatorName, creatorKey) {
  if (!env || !env.CONFIGS || !creatorName || !creatorKey) return "";
  const v = validateCreatorUsername(creatorName);
  if (!v.ok) return "";
  let memoKey = "";
  try {
    memoKey = await creatorAuthMemoKey(v.normalized, String(creatorKey), "shelf-owner");
    const hit = SHELF_OWNER_MEMO.get(memoKey);
    if (hit !== undefined) {
      if (Date.now() < hit) return v.normalized;
      SHELF_OWNER_MEMO.delete(memoKey);
    }
  } catch {
    memoKey = "";
  }
  try {
    const [tombstoned, raw] = await Promise.all([
      isCreatorTombstoned(env, v.normalized),
      getCreator(env, v.normalized),
    ]);
    if (tombstoned || !raw) return "";
    const profile = JSON.parse(raw);
    if (!profile || !profile.keyHash) return "";
    const ok = await verifyCreatorKeyMemoized(String(creatorKey), profile.keyHash, v.normalized);
    if (ok && memoKey) {
      if (SHELF_OWNER_MEMO.size >= SHELF_OWNER_MEMO_MAX) {
        const oldest = SHELF_OWNER_MEMO.keys().next().value;
        if (oldest !== undefined) SHELF_OWNER_MEMO.delete(oldest);
      }
      SHELF_OWNER_MEMO.set(memoKey, Date.now() + SHELF_OWNER_MEMO_TTL_MS);
    }
    return ok ? v.normalized : "";
  } catch {
    return "";
  }
}

// Drops every remembered owner check (an account was purged or re-keyed on this
// isolate). Returns what it was given, so a caller can use it in place.
function forgetShelfOwner(username) {
  SHELF_OWNER_MEMO.clear();
  return username;
}
