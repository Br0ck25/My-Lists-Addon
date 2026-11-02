// Creator account and Custom Lists API (/api/creator/track-status ... /lists/save), moved out of handleFetch (CQ-01).

// Moved unchanged: each route body is now its own function; the dispatchers keep each route's
// original path/method test. Every route still authenticates itself, exactly as before, through
// authenticateCreatorFor (62_creator-auth.js).

// Moved out of handleFetch unchanged (it only needs json): the one answer every creator route gives when authenticateCreatorFor says no.
// Every failure path above returns the exact same generic message
// deliberately -- "that name doesn't exist" vs "that key is wrong"
// would let someone enumerate which creator names are already taken
// just by trying to restore them.
//
// The one failure that is NOT generic is a throttle. Eighteen routes had
// this ternary written out inline, and every one of them replaced
// auth.error with the generic string -- so when the verification throttle
// started refusing requests, a person who had simply been polling too hard
// (or was sharing a CGNAT address with other users) was told their key was
// wrong. That is a misleading answer to a question they got right. One
// helper so the three cases stay distinguishable and cannot drift apart
// again: storage missing, throttled, or genuinely not authenticated.
function authFailureResponse(auth) {
  if (auth.error === "no-kv") return json({ ok: false, error: "no-kv" }, 500);
  if (auth.throttled) return json({ ok: false, error: auth.error }, 429);
  return json({ ok: false, error: "Username or Key is incorrect." }, 401);
}

// /api/creator/track-status, scrobble-seen-users, create and reset-key, at their original place. Returns a Response, or null.
async function handleCreatorApiAccountRoutes(request, env, ctx, url, path) {
  if (path === "/api/creator/track-status" && request.method === "POST") return creatorApiTrackStatus(request, env, ctx, path);
  if (path === "/api/creator/scrobble-seen-users" && request.method === "POST") return creatorApiScrobbleSeenUsers(request, env, ctx, path);
  if (path === "/api/creator/create" && request.method === "POST") return creatorApiCreate(request, env, ctx);
  if (path === "/api/creator/reset-key" && request.method === "POST") return creatorApiResetKey(request, env, ctx);
  return null;
}

// /api/creator/track-status  (POST)  { creatorName, creatorKey } ->
// { ok, lastPingAt, lastPingId, matched } -- powers the "last ping"
// status line on the Settings page's Auto-track playback panel, same
// idea as the reference implementation's ping diagnostics. Kept in its
// own creatortrack:{username} KV key rather than folded into the
// creatorsync:{username} blob, since that blob gets wholesale-
// overwritten by the browser's own background sync (pushCreatorSync)
// on a timer -- storing this there would mean it kept getting quietly
// wiped out by the very next sync from any signed-in device.
async function creatorApiTrackStatus(request, env, ctx, path) {
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const auth = await authenticateCreatorFor(request, env, ctx, path, body.creatorName, body.creatorKey);
  if (!auth.ok) return authFailureResponse(auth);
  const raw = await env.CONFIGS.get(`creatortrack:${auth.username}`);
  let status = { lastPingAt: null, lastPingId: null, lastServer: null, lastUser: null, matched: null, lastAuthForm: null, legacyAuthForm: null };
  if (raw) {
    try {
      status = JSON.parse(raw);
    } catch {
      // leave status as the empty default
    }
  }
  return jsonPrivate({ ok: true, ...status });
}

// /api/creator/scrobble-seen-users  (POST)  { creatorName, creatorKey } ->
// { ok, users: { "James": { server: "Plex", lastSeen: 1234567890 }, ... } }
// Returns all media server usernames ever seen in webhook events for this account.
// Populated automatically by handleMediaServerScrobble whenever a username is
// present in the incoming payload. Used by the settings page to show checkboxes
// for user filtering without requiring manual name entry.
async function creatorApiScrobbleSeenUsers(request, env, ctx, path) {
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const auth = await authenticateCreatorFor(request, env, ctx, path, body.creatorName, body.creatorKey);
  if (!auth.ok) return authFailureResponse(auth);
  const raw = await env.CONFIGS.get(`scrobbleseenusers:${auth.username}`);
  let users = {};
  if (raw) {
    try { users = JSON.parse(raw); } catch {}
  }
  // If scrobbleseenusers is empty, check if creatortrack diagnostics has a lastUser
  if (!Object.keys(users).length) {
    try {
      const diagRaw = await env.CONFIGS.get(`creatortrack:${auth.username}`);
      if (diagRaw) {
        const diag = JSON.parse(diagRaw);
        if (diag && diag.lastUser) {
          users[diag.lastUser] = { server: diag.lastServer || "Media Server", lastSeen: diag.lastPingAt || Date.now() };
        }
      }
    } catch {}
  }
  return jsonPrivate({ ok: true, users });
}

// /api/creator/create  (POST)  { creatorName, displayName?, recoveryAnswer? }
//   -> { ok, creatorName, displayName, creatorKey }
// Rate limited to one new profile per minute per IP, counted in D1
// (rate_counters, P7-3) -- this add-on has no user-identity system to
// rate-limit against besides the requester's own IP.
async function creatorApiCreate(request, env, ctx) {
  if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" });
  const ip = clientIpKey(request);
  if (!ip) return json({ ok: false, error: "Could not process this request." }, 400);
  if (await consumeRateLimit(env, ctx, "creatorcreate", ip, 1)) {
    return json({ ok: false, error: "Please wait a moment before creating another Profile." }, 429);
  }
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const v = validateCreatorUsername(body.creatorName);
  if (!v.ok) return json({ ok: false, error: v.error });
  const dn = normalizeCreatorDisplayName(body.displayName, v.normalized);
  if (!dn.ok) return json({ ok: false, error: dn.error }, 400);
  const displayName = dn.displayName;
  // The rate-limit slot was already spent above, BEFORE this uniqueness
  // check -- otherwise two requests landing at nearly the same instant
  // could both pass the "is it taken" check before either had written
  // anything, and both succeed. That order is why the limiter is the
  // spend-first kind (consumeRateLimit, 02_http-and-creator-utils.js):
  // reading a counter and writing it back later would reopen exactly that
  // window, which is what the KV version did.
  const existing = await getCreator(env, v.normalized);
  if (existing) {
    return json({ ok: false, error: "That username is already taken." });
  }
  // A username that was deleted moments ago is not available yet.
  //
  // This is the half of the tombstone that actually prevents disclosure.
  // A purge is a sweep, so a request already in flight when it ran can put
  // a key back after it finished -- and `creatorsync:{u}` holds the
  // account's own provider API keys. Holding the name for a few minutes
  // means the straggler has finished, and the second sweep has run, long
  // before anyone else can claim it. Same message as a name that is simply
  // taken, which is what it is for now.
  if (await isCreatorTombstoned(env, v.normalized)) {
    return json({ ok: false, error: "That username is already taken." });
  }
  const creatorKey = generateCreatorKey();
  const keyHash = await hashCreatorKey(creatorKey);
  // Recovery answer is optional and, unlike the Creator Key itself,
  // chosen by the person rather than generated -- normalized
  // (trimmed + lowercased) before hashing so a small casing slip
  // months later at reset time doesn't lock them out over nothing.
  // Same PBKDF2 hash-only storage as the key: this value is never
  // recoverable, only checkable, and it's never shown to an admin --
  // self-service reset (/api/creator/reset-key) is the only thing
  // that ever reads it.
  const recoveryAnswerRaw = String(body.recoveryAnswer || "").trim();
  // Optional -- but if one is given it has to be long enough to be worth
  // hashing. It is lowercased before hashing and it can replace the
  // Creator Key outright via /api/creator/reset-key, so a three-character
  // answer is a three-character password on the whole account. Rejected
  // rather than silently accepted, since the person setting it is the
  // only one who can pick a better one. Existing short answers are
  // untouched; the per-account failure budget on reset-key is what
  // protects those.
  if (recoveryAnswerRaw && recoveryAnswerRaw.length < RECOVERY_ANSWER_MIN_LENGTH) {
    return json({
      ok: false,
      error: `Recovery Answer must be at least ${RECOVERY_ANSWER_MIN_LENGTH} characters -- it can reset your key, so treat it like a password.`,
    }, 400);
  }
  const recoveryAnswerHash = recoveryAnswerRaw ? await hashRecoveryAnswer(recoveryAnswerRaw.toLowerCase()) : null;
  const nowMs = Date.now();
  const profileObj = { displayName, keyHash, recoveryAnswerHash, createdAt: nowMs };

  // A new account starts empty BY CONSTRUCTION, not because whatever
  // happened to this username previously is assumed to have finished
  // cleanly.
  //
  // The tombstone above holds a just-deleted name long enough for any
  // in-flight write to land and for the post-deletion sweep to run, but
  // "long enough" is a judgement about request duration, and inheriting a
  // previous owner's synced config -- which carries their TMDB/Trakt API
  // keys -- is too sharp an outcome to leave resting on one. Sweeping here
  // as well means it does not matter how a stray key got there, or how
  // long ago: nothing under this username survives into the new account.
  //
  // Cheap and safe: for a name that was never used this is one list() that
  // returns nothing plus a handful of deletes against absent keys, on an
  // endpoint already rate-limited to one call per IP per minute. It cannot
  // touch a live account either, because the uniqueness check above has
  // already established there is none.
  const preCreatePurge = await purgeCreatorData(env, v.normalized, { deleteIdentity: false, detachSupportThreads: true });
  if (!preCreatePurge.ok) {
    return json({
      ok: false,
      error: "Couldn't set that Profile up just now. Please try again in a moment.",
    }, 503);
  }
  // Same principle for the accounts row: one left by an earlier holder of
  // this username would carry its sessions, installs and provider
  // connections into the new account. The uniqueness check above has
  // established there is no live profile, so any row here is a leftover.
  if (!(await deleteAccountRow(env, v.normalized)).ok) {
    return json({
      ok: false,
      error: "Couldn't set that Profile up just now. Please try again in a moment.",
    }, 503);
  }

  // D1 write is authoritative when DB is bound: fail the request if D1 fails,
  // then populate the KV read-through cache.
  if (env.DB) {
    try {
      await env.DB.prepare("DELETE FROM creator_tombstones WHERE username = ?").bind(v.normalized).run();
    } catch (dbErr) {
      // An expired row is inert anyway (isCreatorTombstoned compares `until`), so failing to tidy it changes nothing.
    }
    try {
      await env.DB.prepare(
        "INSERT INTO creators (username, display_name, key_hash, recovery_answer_hash, created_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(v.normalized, displayName, keyHash, recoveryAnswerHash, nowMs).run();
    } catch (dbErr) {
      console.error("D1 write error (creator create):", dbErr);
      return json({
        ok: false,
        error: "Failed to create creator account. Please try again.",
      }, 500);
    }
  }
  await env.CONFIGS.put(`creator:${v.normalized}`, JSON.stringify(profileObj));
  // The accounts row from the start, so a new account never waits on the
  // backfill. Best-effort: without migration 0015 this does nothing, and
  // the first sign-in fills the row anyway.
  await getOrBackfillAccount(env, v.normalized, profileObj);
  await storeCreatorKeyLookup(env, creatorKey, v.normalized);

  try {
    const countRaw = await env.CONFIGS.get("stats:creator_count");
    const count = parseInt(countRaw || "0", 10) + 1;
    await env.CONFIGS.put("stats:creator_count", String(count));
  } catch (err) {}

  // The Creator Key is returned exactly once, right here -- it's never
  // stored anywhere (only its hash is), so this is the only moment it
  // will ever exist outside whoever's holding onto it themselves.
  // no-store: this is the one and only moment the plaintext Creator Key
  // exists outside whoever is holding it. Same reasoning
  // /api/creator/scrobble-token already applied to its own token.
  return json({ ok: true, creatorName: v.normalized, displayName, creatorKey }, 200, { "Cache-Control": "no-store" });
}

// /api/creator/reset-key  (POST)  { username, recoveryAnswer } -> { ok, creatorKey }
// Public, self-service. This is the reason recoveryAnswerHash exists
// at all: someone who's lost their Creator Key but still knows the
// recovery answer they set at signup can get a working key back
// without ever filing a Feedback ticket or needing an admin. Same
// reset-not-recovery shape as /admin/api/reset-creator-key -- a new
// key is generated and the old one stops working immediately -- the
// only difference is what proves the requester is allowed to do this
// (a matching recovery answer here, an authenticated admin there).
// The recovery answer itself is intentionally NOT rotated on a
// successful reset: unlike a single-use recovery code, this is a
// chosen, memorized answer meant to keep working for next time too,
// the same way a security question's answer would.
async function creatorApiResetKey(request, env, ctx) {
  if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" });
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const ip = clientIpKey(request);
  if (!ip) return json({ ok: false, error: "Could not process this request." }, 400);
  // Spend-first and atomic (D1), not a KV get-then-put: KV has no atomic
  // increment and edge-caches reads, so a burst from one address slipped
  // past it (audit AUTH-002).
  if (await consumeRateLimit(env, ctx, "resetkey", ip, 10, 86400)) {
    // 429, not 200. Round 1 moved fourteen endpoints off "HTTP 200 with
    // ok:false" on an auth failure; this one kept it, so a client that
    // branches on the status code read a refused reset as a success.
    return json({ ok: false, error: "Too many attempts today -- please try again tomorrow, or reach out via Feedback & Support." }, 429);
  }

  const v = validateCreatorUsername(body.username);
  const answer = String(body.recoveryAnswer || "").trim();
  // Generic error for every failure case below (unknown username, no
  // recovery answer on file, wrong answer) -- distinguishing them
  // would let this endpoint be used to enumerate which usernames
  // exist and which have a recovery answer set at all.
  // The message stays byte-identical across all of them so the status
  // code carries no more information than the body already did: 401 on
  // every one of these, 429 on the two throttles.
  const genericError = "That username and recovery answer don't match, or no recovery answer is set for this account.";
  if (!v.ok || !answer) return json({ ok: false, error: genericError }, 401);
  const raw = await getCreator(env, v.normalized);
  if (!raw) return json({ ok: false, error: genericError }, 401);
  let profile;
  try {
    profile = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: genericError }, 401);
  }
  if (!profile.recoveryAnswerHash) return json({ ok: false, error: genericError }, 401);

  // Per-ACCOUNT failure budget, on top of the per-IP one above. The IP
  // counter alone did not defend this endpoint at all: rotating source
  // addresses is free, so it bought an attacker unlimited guesses at one
  // account's recovery answer -- a secret weak enough to fall in a
  // handful of tries, in exchange for a working Creator Key. See
  // RESET_KEY_ACCOUNT_MAX_FAILURES (00_constants.js).
  //
  // Reserved here, after the profile is known to exist and to have a
  // recovery answer set, so a wrong or unknown username can never spend
  // (or create a counter for) an account budget. The attempt is SPENT
  // before the PBKDF2 verification below and given back only if the answer
  // is right: reading the count first and noting the failure afterwards
  // let every request already past the read verify a guess (AUTH-002).
  const resetDay = statsToday();
  const resetScope = `reset:${v.normalized}`;
  const resetBudget = await reserveAuthAttempt(env, resetScope, resetDay, RESET_KEY_ACCOUNT_MAX_FAILURES);
  if (resetBudget.over) {
    // Same generic message as every other failure path here, so this
    // does not become a way to ask whether an account exists. 429 rather
    // than 401 because it IS a throttle -- but the message is the same
    // string, so the pair still says nothing about the account.
    return json({ ok: false, error: genericError }, 429);
  }

  const matches = await verifyRecoveryAnswer(answer.toLowerCase(), profile.recoveryAnswerHash);
  if (!matches) {
    // The spend stays. Answering correctly must never consume the budget
    // that protects you, so only that path gives it back.
    return json({ ok: false, error: genericError }, 401);
  }
  await resetBudget.release();
  // An answer stored the old way is rehashed while it is at hand (P7-4).
  // Before the key is rotated: the profile written below then carries it.
  await upgradeRecoveryAnswerHash(env, v.normalized, answer.toLowerCase(), profile);

  const creatorKey = generateCreatorKey();
  const keyHash = await hashCreatorKey(creatorKey);

  // D1 first, and its outcome decides whether this rotation happens at
  // all -- see rotateCreatorKeyHashInD1 (02_http-and-creator-utils.js).
  // Nothing is written to KV until D1 is known to be either updated or
  // unable to answer with the old hash.
  const d1Rotation = await rotateCreatorKeyHashInD1(env, v.normalized, keyHash);
  if (!d1Rotation.ok) {
    return json({
      ok: false,
      error: "Couldn't reset that key right now. Please try again in a moment -- your existing key still works.",
    }, 503);
  }

  // The previous key must stop working on a warm isolate the instant
  // it is rotated -- see invalidateCreatorAuthMemo's own comment.
  invalidateCreatorAuthMemo();

  // Written unconditionally, not only when D1 missed. getCreator()
  // falls back to D1, so leaving KV holding an older key_hash than D1
  // means two different valid passwords for one account depending on
  // which store answers. Both stores always get the same hash.
  await env.CONFIGS.put(
    `creator:${v.normalized}`,
    JSON.stringify({ ...profile, keyHash })
  );
  await storeCreatorKeyLookup(env, creatorKey, v.normalized);
  // Every device signs in again with the new key. A session opened with the
  // old one would otherwise outlive it, and a lost or leaked key is the
  // usual reason to reset.
  await revokeSessionsForUsername(env, v.normalized);
  return json({ ok: true, creatorName: v.normalized, displayName: profile.displayName, creatorKey }, 200, { "Cache-Control": "no-store" });
}

// /api/creator/recovery-answer ... /lists/save, at their original place after the admin reset-key call. Returns a Response, or null.
async function handleCreatorApiListsRoutes(request, env, ctx, url, path) {
  if (path === "/api/creator/recovery-answer" && request.method === "POST") return creatorApiRecoveryAnswer(request, env, ctx, path);
  if (path === "/api/creator/forgot-username" && request.method === "POST") return creatorApiForgotUsername(request, env, ctx);
  if (path === "/api/creator/scrobble-token" && request.method === "POST") return creatorApiScrobbleToken(request, env, ctx, path);
  if (path === "/api/creator/restore" && request.method === "POST") return creatorApiRestore(request, env, ctx, path);
  if (path === "/api/creator/lists" && request.method === "POST") return creatorApiLists(request, env, ctx, url, path);
  if (path === "/api/creator/lists/items" && request.method === "POST") return creatorApiListsItems(request, env, ctx, path);
  if (path === "/api/creator/lists/save" && request.method === "POST") return creatorApiListsSave(request, env, ctx, url, path);
  return null;
}

// /api/creator/recovery-answer  (POST)  { creatorName, creatorKey, recoveryAnswer } -> { ok, hasRecoveryAnswer }
// Authenticated self-service. Allows an existing creator to set or update
// their recovery answer so they can reset their key or retrieve their
// username if ever forgotten.
async function creatorApiRecoveryAnswer(request, env, ctx, path) {
  if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" }, 500);
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const auth = await authenticateCreatorFor(request, env, ctx, path, body.creatorName, body.creatorKey);
  if (!auth.ok) return authFailureResponse(auth);

  const recoveryAnswerRaw = String(body.recoveryAnswer || "").trim();
  if (!recoveryAnswerRaw || recoveryAnswerRaw.length < RECOVERY_ANSWER_MIN_LENGTH) {
    return json({
      ok: false,
      error: `Recovery Answer must be at least ${RECOVERY_ANSWER_MIN_LENGTH} characters -- it can reset your key, so treat it like a password.`,
    }, 400);
  }

  const recoveryAnswerHash = await hashRecoveryAnswer(recoveryAnswerRaw.toLowerCase());
  const stored = await storeRecoveryAnswerHash(env, auth.username, recoveryAnswerHash);
  if (!stored.ok) {
    return json({ ok: false, error: "Failed to update recovery answer. Please try again." }, 500);
  }

  if (body.creatorKey) {
    await storeCreatorKeyLookup(env, body.creatorKey, auth.username);
  }

  return jsonPrivate({ ok: true, hasRecoveryAnswer: true });
}

// /api/creator/forgot-username  (POST)  { creatorKey, recoveryAnswer? } -> { ok, username, displayName }
// Self-service recovery for anyone who knows their Account Key (and Recovery Answer if set)
// but forgot their username.
async function creatorApiForgotUsername(request, env, ctx) {
  if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" }, 500);
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const ip = clientIpKey(request);
  if (!ip) return json({ ok: false, error: "Could not process this request." }, 400);

  // A wrong Key or Recovery Answer is what spends this bucket, never a
  // right one -- the constant is literally named ..._MAX_FAILURES, and the
  // same rule the daily budgets follow (a correct secret must not consume
  // the budget that protects it). P7-3: counted in D1, so the number is
  // the real one rather than a per-edge-cache approximation of it.
  // Spent up front and given back on success (reserveRateLimit), so a burst
  // cannot get more attempts than the budget by arriving together.
  const forgotBudget = await reserveRateLimit(env, ctx, "forgotusername", ip, FORGOT_USERNAME_IP_MAX_FAILURES, FORGOT_USERNAME_IP_TTL_SEC);
  if (forgotBudget.over) {
    return json({ ok: false, error: "Too many attempts. Please wait 15 minutes and try again." }, 429);
  }
  const failForgot = async (error, status) => json({ ok: false, error }, status);

  const presentedKey = String(body.creatorKey || "").trim().toUpperCase();
  const presentedAnswer = String(body.recoveryAnswer || "").trim();

  const genericError = "No matching account found. Check your Key and Recovery Answer and try again.";
  if (!presentedKey || !/^MYL-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(presentedKey)) {
    return failForgot(genericError, 401);
  }

  const lookupMeta = {};
  let resolvedUsername = await usernameForCreatorKeyLookup(env, presentedKey, lookupMeta);
  let isLegacyHit = Boolean(lookupMeta.source && lookupMeta.source.startsWith("legacy"));

  // Fallback for pre-migration accounts that never got a lookup entry. It
  // used to walk the first 50 `creators` rows and run PBKDF2 against each,
  // so every wrong, well-formed key cost about 50 verifications (audit
  // DOS-001) and could never reach an account past row 50 anyway. Now it
  // only looks at accounts with NO lookup entry of either kind. A hit
  // stores one (below), so the set shrinks to nothing as these accounts
  // are used, and a wrong key costs as many verifications as there are
  // accounts still waiting for one.
  if (!resolvedUsername && env.DB) {
    try {
      const rows = await env.DB.prepare(
        "SELECT c.username, c.key_hash, c.recovery_answer_hash FROM creators c " +
        "WHERE NOT EXISTS (SELECT 1 FROM creator_key_lookups l WHERE l.username = c.username) " +
        "AND NOT EXISTS (SELECT 1 FROM accounts a WHERE lower(a.username) = lower(c.username) AND a.key_lookup_hmac IS NOT NULL) " +
        "LIMIT 50"
      ).all();
      if (rows && rows.results) {
        for (const r of rows.results) {
          if (r.key_hash && (await verifyCreatorKey(presentedKey, r.key_hash))) {
            resolvedUsername = r.username;
            isLegacyHit = true;
            await storeCreatorKeyLookup(env, presentedKey, r.username);
            break;
          }
        }
      }
    } catch (scanErr) {
      console.error("D1 scan error (forgot username fallback):", scanErr);
    }
  }

  if (!resolvedUsername) {
    return failForgot(genericError, 401);
  }

  if (isLegacyHit) {
    await recordLegacyLookupHit(env);
  }

  const v = validateCreatorUsername(resolvedUsername);
  if (!v.ok) return failForgot(genericError, 401);

  let profile = null;
  let accountRow = null;
  if (env.DB) {
    try {
      accountRow = await env.DB.prepare(
        "SELECT id, username, display_name, key_hash, recovery_answer_hash, status FROM accounts WHERE lower(username) = lower(?) AND (status != 'deleted' AND deleted_at IS NULL)"
      ).bind(v.normalized).first();
    } catch {}
  }

  const raw = await getCreator(env, v.normalized);
  if (raw) {
    try {
      profile = JSON.parse(raw);
    } catch {}
  }

  if (!profile && accountRow) {
    profile = {
      username: accountRow.username,
      displayName: accountRow.display_name,
      keyHash: accountRow.key_hash,
      recoveryAnswerHash: accountRow.recovery_answer_hash,
    };
  }

  if (!profile) return failForgot(genericError, 401);

  const keyMatches = await verifyCreatorKey(presentedKey, profile.keyHash);
  if (!keyMatches) {
    return failForgot(genericError, 401);
  }

  if (profile.recoveryAnswerHash) {
    if (!presentedAnswer) {
      return failForgot("A Recovery Answer is required for this account. Please enter your Recovery Answer.", 401);
    }
    const answerMatches = await verifyRecoveryAnswer(presentedAnswer.toLowerCase(), profile.recoveryAnswerHash);
    if (!answerMatches) {
      return failForgot(genericError, 401);
    }
    // Rehashed if it was stored the old way (P7-4).
    await upgradeRecoveryAnswerHash(env, v.normalized, presentedAnswer.toLowerCase(), profile);
  }

  await forgotBudget.release();
  await storeCreatorKeyLookup(env, presentedKey, v.normalized);

  return jsonPrivate({
    ok: true,
    username: profile.username || v.normalized,
    displayName: profile.displayName || profile.username || v.normalized,
    hasRecoveryAnswer: Boolean(profile.recoveryAnswerHash),
  });
}

// /api/creator/scrobble-token  (POST)  { creatorName, creatorKey, rotate? }
//   -> { ok, token }
// Returns this account's media-server scrobble token, minting one on
// first use. `rotate: true` issues a fresh one and revokes the previous,
// which is what "regenerate" in the dashboard does when a webhook URL
// has been shared or logged somewhere it should not have been.
//
// Authenticated with the Creator Key, like every other account
// operation -- the token is what the WEBHOOK carries, not what this
// endpoint accepts.
async function creatorApiScrobbleToken(request, env, ctx, path) {
  if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" });
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const auth = await authenticateCreatorFor(request, env, ctx, path, body.creatorName, body.creatorKey);
  if (!auth.ok) {
    return authFailureResponse(auth);
  }
  const token = await getOrCreateScrobbleTokenSecure(env, auth.username, body.rotate === true);
  if (!token) return json({ ok: false, error: "Could not issue a webhook token." }, 500);
  return json({ ok: true, token }, 200, { "Cache-Control": "no-store" });
}

// /api/creator/restore  (POST)  { creatorName, creatorKey } -> { ok, creatorName, displayName }
async function creatorApiRestore(request, env, ctx, path) {
  if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" });
  const ip = clientIpKey(request);
  if (!ip) return json({ ok: false, error: "Could not process this request." }, 400);
  // More generous than profile creation (this is a normal, repeatable
  // action -- someone restoring on a new device isn't abuse), but still
  // capped well below what's useful for guessing a ~60-bit key. Like the
  // daily budget below it, spent on FAILURES only (P7-3): restoring on a
  // run of new devices must not be what locks someone out.
  const restoreBurst = await reserveRateLimit(env, ctx, "creatorrestore", ip, 20, 60);
  if (restoreBurst.over) {
    return json({ ok: false, error: "Too many attempts. Please wait a minute and try again." }, 429);
  }

  // Same reasoning as /admin/login: the 60s bucket shapes a burst, this
  // daily budget is what actually bounds guessing at a Creator Key over
  // time. Spent on failures only, so restoring on a run of new devices
  // costs nothing.
  const restoreFailScope = `restore:${ip}`;
  const restoreFailDay = statsToday();
  const restoreDaily = await reserveAuthAttempt(env, restoreFailScope, restoreFailDay, CREATOR_RESTORE_MAX_FAILURES_PER_DAY);
  if (restoreDaily.over) {
    await restoreBurst.release();
    return json({ ok: false, error: "Too many failed attempts today. Please try again tomorrow." }, 429);
  }
  // Anything that is not a wrong guess gives both spends back.
  const releaseRestore = async () => { await restoreBurst.release(); await restoreDaily.release(); };

  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    if (request.account && isSessionsEnabled(env)) {
      body = {};
    } else {
      await releaseRestore();
      return json({ ok: false, error: "Invalid JSON body." }, 400);
    }
  }
  const auth = await authenticateCreatorFor(request, env, ctx, path, body.creatorName, body.creatorKey);
  if (!auth.ok) {
    // A request without a key guessed nothing (see noKey above); the
    // spends of every other failure stay.
    if (auth.error === "no-kv" || auth.noKey) await releaseRestore();
    return authFailureResponse(auth);
  }
  await releaseRestore();
  if (body.creatorKey) {
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(storeCreatorKeyLookup(env, body.creatorKey, auth.username).catch(() => {}));
    } else {
      await storeCreatorKeyLookup(env, body.creatorKey, auth.username).catch(() => {});
    }
  }
  return jsonPrivate({
    ok: true,
    creatorName: auth.username,
    displayName: auth.displayName,
    hasRecoveryAnswer: Boolean(auth.hasRecoveryAnswer),
    // Whether this browser now holds a session for the account (FF_SESSIONS).
    // The page offers its locally held provider tokens to
    // /api/connections/import-local only when it does (P3a-9).
    session: Boolean(request.session && request.account && String(request.account.username || "").toLowerCase() === String(auth.username || "").toLowerCase()),
  });
}

// /api/creator/lists  (POST)  { creatorName, creatorKey } -> { ok, displayName, lists }
// The Dashboard's data source -- every list this creator owns (public
// AND private, since this is an authenticated request only the owner
// can make), in their own persisted order.
async function creatorApiLists(request, env, ctx, url, path) {
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    if (request.account && isSessionsEnabled(env)) {
      body = {};
    } else {
      return json({ ok: false, error: "Invalid JSON body." }, 400);
    }
  }
  const auth = await authenticateCreatorFor(request, env, ctx, path, body.creatorName, body.creatorKey);
  if (!auth.ok) return authFailureResponse(auth);
  // From v2 when FF_V2_LISTS_READ is on and this account's copy is
  // finished (P3b-7, 34_lists-v2-bridge.js); null means read the legacy
  // store below, as before.
  const v2Dashboard = await listsV2DashboardResponse(env, url, auth, body);
  if (v2Dashboard) return v2Dashboard;
  if (isV2ListsOnly(env)) return jsonPrivate({ ok: false, error: "Your lists can't be loaded right now. Please try again in a moment." }, 503);
  // Paging. The route used to issue one KV get per list with no cap, so
  // an account at 990 lists spent 1,001 KV operations and Cloudflare
  // terminated the invocation -- the dashboard 500s forever, and since
  // deleting a list is done FROM the dashboard there was no way back.
  // See CREATOR_LISTS_PAGE_DEFAULT (00_constants.js).
  //
  // The slug ORDER is resolved in full first (one KV get plus the orphan
  // sweep's list() pages -- both independent of list count), and only the
  // requested window is read. So the per-invocation cost is bounded by
  // `limit`, not by how many lists the account owns.
  const { listLimit, listOffset } = creatorListsPaging(body);

  // The transfer half of the same finding. Paging bounded the KV
  // operations; the response still carried every list's full `items`
  // array -- 15.08 MB at 1,200 lists, re-sent after every save, delete
  // and tab switch. It now carries `itemCount` and `updatedAt`, and the
  // contents come from /api/creator/lists/items for the slugs whose
  // version the caller does not already hold.
  //
  // includeItems is the way back to the old shape, and it exists for one
  // reason: it is what the client falls back to if the delta fetch fails.
  // A dashboard that renders lists with silently-empty items is worse
  // than one that transfers too much, so the degraded path is exactly
  // the behaviour this endpoint had before.
  const includeItems = body.includeItems === true;

  let order = await creatorListsReadOrder(env, auth);

  // Anything the account owns that creatorlistorder: has lost.
  //
  // order is one KV key rewritten read-modify-write by every save, with
  // no compare-and-swap, so concurrent saves drop each other's entries.
  // Building the dashboard from order alone meant a list whose entry was
  // lost became invisible even though its record was sitting right there
  // in KV -- and the client, seeing it missing, uploaded it again. That
  // feedback loop is what produced 129 list records for 22 real lists on
  // one account.
  //
  // So order decides DISPLAY ORDER, not existence: a record with no
  // order entry is appended rather than dropped, and order is repaired in
  // the same breath so it converges instead of drifting further. Costs
  // one KV list() on a healthy account, where the recovered set is empty.
  //
  // The sweep runs on EVERY page, not just the first: it is what decides
  // how many lists there are, and a `total` that changed between pages
  // would let the client stop early and lose the tail.
  const orderedSlugs = new Set(order);
  const { recovered, sweepOk } = await creatorListsOrphanSweep(env, auth, orderedSlugs);
  if (recovered.length) {
    order = order.concat(recovered);
    ctx.waitUntil(
      env.CONFIGS.put(`creatorlistorder:${auth.username}`, JSON.stringify({ order })).catch(() => {})
    );
  }

  // The Watchlist, when no creatorlist: record for it turned up above.
  //
  // Resolved before paging so it counts toward `total` and cannot be
  // lost off the end of a page. The sweep sees every creatorlist: key, so
  // when it succeeded a missing `watchlist` slug means the record really
  // is absent and only the tracking blob can supply one; when it failed,
  // the one key is probed directly rather than assuming.
  const watchlistFallback = await creatorListsWatchlistFallback(env, url, auth, orderedSlugs, sweepOk);

  // The fallback Watchlist is displayed first, so it occupies index 0 of
  // the virtual sequence the offsets address.
  const allSlugs = watchlistFallback ? ["\u0000watchlist"].concat(order) : order.slice();
  const total = allSlugs.length;
  const pageSlugs = allSlugs.slice(listOffset, listOffset + listLimit);
  const hasMore = listOffset + pageSlugs.length < total;

  const lists = await creatorListsReadPage(env, url, auth, pageSlugs, watchlistFallback, includeItems);

  // Content version + conditional response.
  //
  // This endpoint returns the FULL items array for every list the
  // account owns, and renderCreatorDashboard calls it on every render --
  // after a save, after a delete, on a tab switch, after a background
  // sync adopts server state. For anyone with large Custom Lists that
  // was megabytes down the wire and a megabytes-sized JSON.parse on the
  // main thread, over and over, almost always producing exactly the
  // data the browser already had.
  //
  // So the browser now sends back the version it last received, and
  // when nothing has changed it gets a few dozen bytes instead of the
  // whole payload and keeps using the copy it already holds.
  //
  // The version is a hash of the actual response body rather than a
  // separately-maintained counter. That costs a hash of a string this
  // endpoint had to build anyway, and in exchange it cannot drift: there
  // is no bump-on-write to forget in some future list-mutating route,
  // and any change to any list, its order, or the display name changes
  // the version by construction. Note it deliberately does NOT save the
  // KV reads above -- the lists still have to be read to know whether
  // they changed. What it removes is the transfer and the parse, which
  // is where the stall the person actually feels comes from.
  // Slugs this account has deleted, so a browser still holding a local
  // copy of one drops it instead of helpfully uploading it again. Without
  // this the dashboard's own reconciliation re-created every list deleted
  // on another device, a minute or two after it was deleted -- see
  // readCreatorListDeletions (02_http-and-creator-utils.js) and
  // applyServerListDeletions (22_client-creator-profile.js) for the two
  // halves of that.
  //
  // Part of the payload the version hash is taken over, so a delete made
  // elsewhere can never be hidden behind an "unchanged" reply.
  // Filtered against every slug the account owns, not against this PAGE
  // of them: a slug that is alive but sits on another page would
  // otherwise be reported to the client as deleted, and the client
  // deletes its local copy of anything named here.
  const deletedSlugs = await creatorListsDeletedSlugs(env, auth, orderedSlugs, watchlistFallback);
  const listsPayload = {
    ok: true, displayName: auth.displayName, lists, order, deletedSlugs,
    total, offset: listOffset, limit: listLimit, hasMore,
  };
  const listsVersion = await creatorListsVersion(listsPayload);
  if (listsVersion && body.knownVersion && body.knownVersion === listsVersion) {
    // The paging fields ride along on the unchanged reply too. Without
    // them a client that cached page 0 could not know whether to ask for
    // page 1, and would stop at whatever it already had.
    return jsonPrivate({
      ok: true, unchanged: true, version: listsVersion,
      total, offset: listOffset, limit: listLimit, hasMore,
    });
  }
  return jsonPrivate({ ...listsPayload, version: listsVersion });
}

// The paging window a caller asked for (a step of creatorApiLists).
function creatorListsPaging(body) {
  const rawLimit = parseInt(body.limit, 10);
  const listLimit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, CREATOR_LISTS_PAGE_MAX)
    : CREATOR_LISTS_PAGE_DEFAULT;
  const rawOffset = parseInt(body.offset, 10);
  const listOffset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  return { listLimit, listOffset };
}

// The slugs this account has deleted, so a browser drops its local copy of each (a step of creatorApiLists).
async function creatorListsDeletedSlugs(env, auth, orderedSlugs, watchlistFallback) {
  return Object.keys(await readCreatorListDeletions(env, auth.username))
    .filter((s) => !orderedSlugs.has(s) && !(watchlistFallback && s === "watchlist"));
}

// The display order of an account's lists: D1 sort order merged with the KV order (first step of creatorApiLists).
async function creatorListsReadOrder(env, auth) {
  let order = [];
  let d1Ordered = false;
  if (env.DB) {
    try {
      const { results } = await env.DB.prepare(
        "SELECT id, sort_order FROM creator_lists WHERE username = ? ORDER BY CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END, sort_order ASC, created_at ASC"
      ).bind(auth.username).all();
      if (results && results.length > 0) {
        const hasSortOrder = results.some((r) => r.sort_order != null);
        if (hasSortOrder) {
          const prefix = auth.username + ":";
          order = results.map((r) => (r.id.startsWith(prefix) ? r.id.slice(prefix.length) : r.id)).filter(Boolean);
          d1Ordered = true;
        }
      }
    } catch (e) {
      console.error("D1 order read error (/api/creator/lists):", e);
    }
  }
  if (env.CONFIGS) {
    try {
      const orderRaw = await env.CONFIGS.get(`creatorlistorder:${auth.username}`);
      const kvOrder = orderRaw ? JSON.parse(orderRaw).order || [] : [];
      if (Array.isArray(kvOrder) && kvOrder.length > 0) {
        if (d1Ordered && order.length > 0) {
          const d1Slugs = new Set(order);
          const merged = [];
          kvOrder.forEach((s) => {
            if (typeof s === "string" && (d1Slugs.has(s) || s === "continue-watching" || s === "watch-history" || s === "watchlist" || s === "airing-next")) {
              merged.push(s);
            }
          });
          order.forEach((s) => {
            if (!merged.includes(s)) merged.push(s);
          });
          order = merged;
        } else if (!d1Ordered) {
          order = kvOrder.filter((s) => typeof s === "string" && s);
        }
      }
    } catch {
      if (!d1Ordered) order = [];
    }
  }
  return order;
}

// The orphan sweep of creatorApiLists: every creatorlist: key the order has lost. Adds the slugs it finds to orderedSlugs.
async function creatorListsOrphanSweep(env, auth, orderedSlugs) {
  const recovered = [];
  let sweepOk = true;
  try {
    let listCursor;
    for (let page = 0; page < 5; page++) {
      const res = await env.CONFIGS.list({ prefix: `creatorlist:${auth.username}:`, cursor: listCursor });
      for (const k of res.keys) {
        const s = k.name.slice(`creatorlist:${auth.username}:`.length);
        if (s && !orderedSlugs.has(s)) { orderedSlugs.add(s); recovered.push(s); }
      }
      if (res.list_complete || !res.cursor) break;
      listCursor = res.cursor;
    }
  } catch (e) {
    // Best-effort: without it the dashboard is exactly as complete as it
    // was before, never less.
    sweepOk = false;
    console.error("creator lists: orphan sweep failed", e);
  }
  return { recovered, sweepOk };
}

// The Watchlist fallback of creatorApiLists, when no creatorlist: record for it turned up.
async function creatorListsWatchlistFallback(env, url, auth, orderedSlugs, sweepOk) {
  let watchlistFallback = null;
  if (!orderedSlugs.has("watchlist")) {
    let wlRaw = null;
    if (!sweepOk) wlRaw = await getCreatorList(env, auth.username, "watchlist");
    if (wlRaw) {
      try {
        const data = JSON.parse(wlRaw);
        watchlistFallback = {
          slug: "watchlist",
          name: data.name || "Watchlist",
          type: data.type || "mixed",
          items: data.items || [],
          itemCount: (data.items || []).length,
          likes: data.likes || 0,
          visibility: effectiveListVisibility(data.visibility),
          url: `${url.origin}/lists/${auth.username}/watchlist`,
        };
      } catch {}
    } else {
      const trackingRaw = await env.CONFIGS.get(`creatorsynctracking:${auth.username}`);
      if (trackingRaw) {
        try {
          const tb = JSON.parse(trackingRaw);
          if (Array.isArray(tb.watchlist) && tb.watchlist.length > 0) {
            watchlistFallback = {
              slug: "watchlist",
              name: "Watchlist",
              type: "mixed",
              items: tb.watchlist,
              itemCount: tb.watchlist.length,
              likes: 0,
              visibility: "private",
              url: `${url.origin}/lists/${auth.username}/watchlist`,
            };
          }
        } catch {}
      }
    }
  }
  return watchlistFallback;
}

// One page of an account's lists, read from KV and shaped for the dashboard (a step of creatorApiLists).
async function creatorListsReadPage(env, url, auth, pageSlugs, watchlistFallback, includeItems) {
  const lists = (
    await Promise.all(
      pageSlugs.map(async (slug) => {
        if (slug === "\u0000watchlist") {
          return includeItems ? watchlistFallback : { ...watchlistFallback, items: undefined };
        }
        const raw = await getCreatorList(env, auth.username, slug);
        if (!raw) return null;
        try {
          const data = JSON.parse(raw);
          return {
            slug,
            name: data.name,
            type: data.type,
            // Omitted unless asked for -- see includeItems above. The key
            // is left off entirely rather than set to [], so a client that
            // reads it can tell "not sent" from "empty list".
            items: includeItems ? (data.items || []) : undefined,
            itemCount: (data.items || []).length,
            likes: data.likes || 0,
            visibility: effectiveListVisibility(data.visibility),
            sourceUrl: data.sourceUrl || undefined,
            synced: !!data.synced || undefined,
            lastSyncedAt: Number.isFinite(data.lastSyncedAt) ? data.lastSyncedAt : undefined,
            baseItemIds: Array.isArray(data.baseItemIds) ? data.baseItemIds : undefined,
            // The version these items are, so an editor can send it back
            // as expectedUpdatedAt and have lists/save refuse a write
            // built on a copy another device has since replaced.
            //
            // The guard was added first and this was not, which made it
            // unreachable: the only baseline a browser could cite is one
            // the server told it about, and nothing did. A missing
            // updatedAt on a legacy record stays undefined rather than
            // becoming 0 -- lists/save treats a non-finite expected value
            // as "no opinion", and 0 would be an opinion, and a wrong one.
            updatedAt: Number.isFinite(data.updatedAt) ? data.updatedAt : undefined,
            url: `${url.origin}/lists/${auth.username}/${slug}`,
          };
        } catch {
          return null;
        }
      })
    )
  ).filter(Boolean);
  return lists;
}

// The content version of the lists payload: a hash of the body, so it cannot drift (a step of creatorApiLists).
async function creatorListsVersion(listsPayload) {
  let listsVersion = "";
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(listsPayload)));
    listsVersion = [...new Uint8Array(digest)].slice(0, 10).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    // No digest available -- fall through with an empty version, which
    // can never match what a client sends, so it always gets the full
    // response. Degrades to the previous behaviour rather than to a
    // browser that stops seeing its own list changes.
  }
  return listsVersion;
}

// /api/creator/lists/items  (POST)
//   { creatorName, creatorKey, slugs: [...] } -> { ok, lists: [{ slug, items, itemCount, updatedAt }] }
//
// The per-list read that lets /api/creator/lists stop returning `items`.
// The dashboard asks for the contents of only the slugs whose updatedAt
// it does not already hold, so a re-render after a one-list edit costs
// one list's items instead of every list's.
//
// Bounded the same way the paged endpoint is: at most
// CREATOR_LIST_ITEMS_BATCH_MAX slugs per call, so the KV cost is set by
// the request rather than by what the account owns. Over the cap is a
// 400, not a silent truncation -- a caller that got back fewer lists than
// it asked for and could not tell would render them empty.
async function creatorApiListsItems(request, env, ctx, path) {
  if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" }, 500);
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const auth = await authenticateCreatorFor(request, env, ctx, path, body.creatorName, body.creatorKey);
  if (!auth.ok) return authFailureResponse(auth);

  const rawSlugs = Array.isArray(body.slugs) ? body.slugs : [];
  // De-duplicated before the cap is applied, so a caller that repeats a
  // slug spends one read for it and cannot be refused for a length its
  // own duplicates produced.
  const slugs = [...new Set(rawSlugs.filter((sl) => typeof sl === "string" && sl))];
  if (!slugs.length) return jsonPrivate({ ok: true, lists: [] });
  if (slugs.length > CREATOR_LIST_ITEMS_BATCH_MAX) {
    return json({
      ok: false,
      error: `Too many lists in one request (max ${CREATOR_LIST_ITEMS_BATCH_MAX}).`,
    }, 400);
  }
  // From v2 when FF_V2_LISTS_READ is on (P3b-7); null means the legacy store.
  const v2Items = await listsV2ItemsResponse(env, auth, slugs);
  if (v2Items) return v2Items;
  if (isV2ListsOnly(env)) return jsonPrivate({ ok: false, error: "Your lists can't be loaded right now. Please try again in a moment." }, 503);

  const out = (
    await Promise.all(
      slugs.map(async (slug) => {
        const raw = await getCreatorList(env, auth.username, slug);
        if (raw) {
          try {
            const data = JSON.parse(raw);
            const items = Array.isArray(data.items) ? data.items : [];
            return {
              slug,
              items,
              itemCount: items.length,
              baseItemIds: Array.isArray(data.baseItemIds) ? data.baseItemIds : undefined,
              updatedAt: Number.isFinite(data.updatedAt) ? data.updatedAt : undefined,
            };
          } catch {
            return null;
          }
        }
        // The same Watchlist fallback /api/creator/lists applies: when no
        // creatorlist: record exists the tracking blob is the only place
        // the Watchlist lives, and the dashboard shows it from there. If
        // this endpoint did not mirror that, the one list most accounts
        // have would be the one that came back empty.
        if (slug !== "watchlist") return null;
        const trackingRaw = await env.CONFIGS.get(`creatorsynctracking:${auth.username}`);
        if (!trackingRaw) return null;
        try {
          const tb = JSON.parse(trackingRaw);
          if (!Array.isArray(tb.watchlist)) return null;
          return {
            slug,
            items: tb.watchlist,
            itemCount: tb.watchlist.length,
            updatedAt: Number.isFinite(tb.updatedAt) ? tb.updatedAt : undefined,
          };
        } catch {
          return null;
        }
      })
    )
  ).filter(Boolean);

  // jsonPrivate, not json: this is one account's list contents. The
  // /api/creator/ prefix in isPrivateApiPath() already forces no-store on
  // it, which is the point of that choke point -- a route added later
  // cannot forget. This says so at the route as well, the way its
  // siblings do.
  return jsonPrivate({ ok: true, lists: out });
}

// /api/creator/lists/save  (POST)
// { creatorName, creatorKey, slug (optional -- present means "update
//   this existing list", absent means "create a new one"), name, type,
//   items, visibility } -> { ok, slug, url }
async function creatorApiListsSave(request, env, ctx, url, path) {
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const auth = await authenticateCreatorFor(request, env, ctx, path, body.creatorName, body.creatorKey);
  if (!auth.ok) return authFailureResponse(auth);

  const type = (body.type === "series" || body.type === "mixed") ? body.type : (body.type === "movie" ? "movie" : null);
  const items = Array.isArray(body.items) ? body.items : [];
  const visibility = normalizeListVisibility(body.visibility);
  const name = String(body.name || "").trim();
  if (!name) return json({ ok: false, error: "Missing a list name." }, 400);
  if (!type) return json({ ok: false, error: "Missing or invalid list type." }, 400);
  // The same bounds /api/publish-list has always had, which this
  // authenticated sibling never picked up -- see CREATOR_LIST_BYTES_MAX
  // (00_constants.js). Rejected rather than truncated, for the reason
  // that file already spells out: quietly storing a shortened list is a
  // worse bug than refusing an oversized one.
  if (name.length > PUBLISHED_LIST_NAME_MAX) {
    return json({ ok: false, error: "That list name is too long." }, 400);
  }
  if (items.length > PUBLISHED_LIST_ITEMS_MAX) {
    return json({ ok: false, error: `That list is too large to save (limit ${PUBLISHED_LIST_ITEMS_MAX} items).` }, 413);
  }

  // With FF_V2_LISTS_ONLY (P3b-9) the list is read and written in v2
  // only: the same request and answer, a different store underneath.
  const listsOnly = isV2ListsOnly(env);
  const onlyAccount = listsOnly ? await listsV2Account(env, auth.username) : null;
  if (listsOnly && !onlyAccount) {
    return json({ ok: false, error: "Your account isn't ready to save lists yet. Please try again later." }, 503);
  }
  const order = await creatorListSaveReadOrder(env, auth, listsOnly, onlyAccount);

  const editingSlug = slugifyServer(body.slug) || null;
  const slug = await creatorListSaveSlug(env, auth, name, editingSlug, order, listsOnly, onlyAccount);
  if (!slug) {
    return json(
      { ok: false, error: "Couldn't find a free URL for that list name. Please try a slightly different name." },
      409
    );
  }

  // Item count alone is not a size bound -- items carry titles,
  // overviews and poster URLs -- so this is checked on the exact bytes
  // about to be stored, before a slug is allocated or anything is
  // written. BYTES, via utf8ByteLength: .length counts UTF-16 code
  // units, and the ceiling exists because of D1's byte limit.
  const itemsJson = JSON.stringify(items || []);
  if (utf8ByteLength(itemsJson) > CREATOR_LIST_BYTES_MAX) {
    return json({
      ok: false,
      error: "That list is too large to save. Try splitting it into more than one list.",
    }, 413);
  }

  const now = Date.now();
  // The same conflict guard the four sync blobs got, on the one wholesale
  // write that was left out of it.
  //
  // A list record is replaced entirely by this handler, so two devices
  // editing the same list is last-write-wins with both answering 200 --
  // the exact shape /api/creator/sync/save was given expectedUpdatedAt
  // for. Whichever save lands second silently discards the other's edits,
  // with no error anywhere.
  //
  // Additive, exactly as it is there: a client that sends no
  // expectedUpdatedAt keeps the previous behaviour, so an older browser is
  // not broken by this. Parsed here rather than inside the branch below so
  // that a malformed value is rejected whether or not the record already
  // exists -- present-but-unusable is a client bug, and silently dropping
  // the only protection against overwriting someone's work is the worst
  // available response to it (see parseExpectedUpdatedAt).
  const listExpected = parseExpectedUpdatedAt(body.expectedUpdatedAt);
  if (!listExpected.ok) {
    return json({ ok: false, error: "expectedUpdatedAt must be a number." }, 400);
  }

  const sourceUrl = typeof body.sourceUrl === "string" ? body.sourceUrl.trim() : (body.sourceUrl === "" ? "" : null);
  const synced = body.synced != null ? !!body.synced : (sourceUrl ? true : null);
  const lastSyncedAt = Number.isFinite(Number(body.lastSyncedAt)) ? Number(body.lastSyncedAt) : null;
  const baseItemIds = Array.isArray(body.baseItemIds)
    ? body.baseItemIds.filter((id) => typeof id === "string" || typeof id === "number").map(String)
    : null;

  const existing = await creatorListSaveReadExisting(env, ctx, { auth, slug, editingSlug, listsOnly, onlyAccount, now, listExpected });
  if (existing.response) return existing.response;
  const { createdAt, likes, storedUpdatedAt } = existing;
  // Strictly newer than what is stored, not merely Date.now().
  //
  // Date.now() is frozen for the duration of a Workers request, so two
  // saves genuinely can carry the same millisecond -- and with a bare
  // timestamp as the version, `stored > expected` then cannot tell a stale
  // write from a current one and the stale one wins. Same reasoning, and
  // the same helper, as the sync blobs: see nextSyncVersion.
  const updatedAt = nextSyncVersion(storedUpdatedAt);
  if (env.DB && !listsOnly) await creatorListSaveD1Row(env, { auth, slug, name, type, visibility, itemsJson, likes, createdAt, updatedAt, order });

  const { kvPayload, savedAnswer } = creatorListSavePayload({ url, auth, slug, name, type, items, visibility, likes, createdAt, updatedAt, sourceUrl, synced, lastSyncedAt, baseItemIds, existing });

  // FF_V2_LISTS_ONLY: this record into v2 (its details, items by diff,
  // its place at the end of the order when it is new), and nothing into
  // the legacy store. A save that did not land says so, so the browser
  // keeps its copy and tries again.
  if (listsOnly) {
    try {
      await listsV2WriteRecord(env, onlyAccount, slug, kvPayload);
    } catch (e) {
      console.error("lists v2: save failed", e);
      return json({ ok: false, error: "Couldn't save that list right now. Please try again in a moment." }, 503);
    }
    await bumpCreatorListsStamp(env, auth.username);
    return json(savedAnswer);
  }

  await env.CONFIGS.put(
    `creatorlist:${auth.username}:${slug}`,
    JSON.stringify(kvPayload)
  );
  if (!order.includes(slug)) await creatorListSaveAddToOrder(env, auth, slug, order);

  // Saving a list at a slug the account previously deleted retires that
  // deletion. The tombstone tells every other device to drop its local
  // copy of the slug (see readCreatorListDeletions,
  // 02_http-and-creator-utils.js), so leaving it standing would have them
  // throw away a list that has just been deliberately re-created.
  await clearCreatorListDeletion(env, auth.username, slug);

  // The record is stored; tell the account's other browsers. Placed here
  // rather than beside the response because the directory step below can
  // return 500 on a save whose data DID land, and a browser that never
  // hears about a stored change is exactly the failure this stamp exists
  // to prevent. See bumpCreatorListsStamp (02_http-and-creator-utils.js).
  await bumpCreatorListsStamp(env, auth.username);

  await creatorListSaveSearchIndex(env, auth, slug, name, visibility);
  // The same change into v2, by diff (P3b-7, 34_lists-v2-bridge.js). It
  // never fails the save: a mirror that cannot finish marks the
  // account's v2 copy stale, and reads fall back to what was just saved.
  await listsV2MirrorLists(env, auth.username, [slug]);
  return json(savedAnswer);
}

// The stored record and the answer of a list save, with the sourceUrl/sync fields falling back to the stored ones (a step of creatorApiListsSave).
function creatorListSavePayload({ url, auth, slug, name, type, items, visibility, likes, createdAt, updatedAt, sourceUrl, synced, lastSyncedAt, baseItemIds, existing }) {
  const { existingSourceUrl, existingSynced, existingLastSyncedAt, existingBaseItemIds } = existing;
  const finalSourceUrl = (sourceUrl !== null) ? sourceUrl : existingSourceUrl;
  const finalSynced = (synced !== null) ? synced : (finalSourceUrl ? existingSynced : false);
  const finalLastSyncedAt = (lastSyncedAt !== null) ? lastSyncedAt : existingLastSyncedAt;
  const finalBaseItemIds = (baseItemIds !== null) ? baseItemIds : existingBaseItemIds;

  // Unconditional -- KV must not be allowed to hold a stale copy of a
  // list that D1 has since updated, because the public read paths
  // (/lists/:user/:slug, the directory, search) all read KV.
  //
  // And unlike the tracking record, a D1 failure above is NOT reported as a
  // failed save, because it genuinely is not one: this write lands in KV
  // either way, and getCreatorList compares the two stamps on every read
  // ("If KV has a fresher edit because a D1 write was dropped, prefer KV
  // and repair D1"). The list recovers by itself. There used to be a
  // `d1Success` flag here tracking that outcome and nothing ever read it;
  // this comment is what it was reaching for.
  const kvPayload = { name, slug, type, items, visibility, likes, createdAt, updatedAt };
  if (finalSourceUrl) kvPayload.sourceUrl = finalSourceUrl;
  if (finalSynced) kvPayload.synced = true;
  if (finalLastSyncedAt) kvPayload.lastSyncedAt = finalLastSyncedAt;
  if (finalBaseItemIds) kvPayload.baseItemIds = finalBaseItemIds;
  const savedAnswer = {
    ok: true,
    slug,
    updatedAt,
    sourceUrl: finalSourceUrl || undefined,
    synced: finalSynced || undefined,
    lastSyncedAt: finalLastSyncedAt || undefined,
    baseItemIds: finalBaseItemIds || undefined,
    url: `${url.origin}/lists/${auth.username}/${slug}`,
  };
  return { kvPayload, savedAnswer };
}

// Whether this account saves into v2 only, and the order its lists are in (a step of creatorApiListsSave).
async function creatorListSaveReadOrder(env, auth, listsOnly, onlyAccount) {
  const orderRaw = listsOnly ? null : await env.CONFIGS.get(`creatorlistorder:${auth.username}`);
  let order = [];
  try {
    order = listsOnly ? await listsV2OrderSlugs(env, onlyAccount) : (orderRaw ? JSON.parse(orderRaw).order || [] : []);
  } catch {
    order = [];
  }
  return order;
}

// The slug a list is saved under: the one the caller named, or a free one minted from the name (null when none is free).
async function creatorListSaveSlug(env, auth, name, editingSlug, order, listsOnly, onlyAccount) {
  // A caller that names a slug gets that slug.
  //
  // This used to be `order.includes(body.slug) ? body.slug : null`, so a
  // request to save AS a particular slug was honoured only if that slug
  // already appeared in creatorlistorder:{user} -- and silently discarded
  // otherwise, with a brand-new slug minted from the name and ok:true
  // returned as though the request had been carried out. That is the
  // whole duplicate-list bug:
  //
  //   creatorlistorder: is one KV key, rewritten read-modify-write by
  //   every save, and KV has no compare-and-swap. renderCreatorDashboard
  //   fires one save per local list missing from the account, all at
  //   once, so a browser holding 22 lists fired 22 concurrent saves and
  //   21 of the resulting order entries were lost. The records existed;
  //   order (and therefore the dashboard) could not see them; so the next
  //   render fired them again. Each round the client asked for its own
  //   slug and was given a different one it never learned about. One
  //   account reached 129 list records for 22 real lists -- 44 copies of
  //   the same 462-item list, coming-of-age-3 through coming-of-age-53.
  //
  // The slug namespace is per-creator and this request is authenticated
  // as its owner, so there is no one else's list to collide with: an
  // explicit slug is theirs to claim whether or not order has caught up.
  // Honouring it makes the save idempotent -- ask twice, get one list --
  // which is what stops the loop. Only a request that names NO slug goes
  // on to allocate a fresh one.
  //
  // Run through slugifyServer because it now reaches a KV key name and a
  // URL path from an arbitrary body field; previously it could only be a
  // value this Worker had itself written into order.
  let slug;
  if (editingSlug) {
    // Editing keeps its existing URL even if the name changed --
    // re-slugging on every rename would break links people already
    // have to it.
    slug = editingSlug;
  } else {
    // New list -- slug uniqueness only needs to hold within this
    // creator's own namespace (see the spec: jack/top-10 and
    // someone-else/top-10 are unrelated), so the collision check and
    // auto-increment only look at this creator's own list keys.
    const baseSlug = slugifyServer(name) || "list";
    // Checked against an in-memory array rather than KV, so this one was
    // never a subrequest problem -- but it had the same fall-through:
    // past the bound it kept a slug that WAS taken and saved over that
    // list. Scoped to this creator's own namespace, so only their own
    // list was ever at risk, but silently replacing it is still the
    // wrong answer.
    // Checked against KV as well as order, not order alone: order is a
    // single key that concurrent saves clobber (see the note above), so
    // a slug absent from it may still have a live record behind it, and
    // allocating it would write straight over that list.
    slug = await pickFreeSlug(baseSlug, async (candidate) =>
      order.includes(candidate) || (listsOnly
        ? await listsV2SlugTaken(env, onlyAccount, candidate)
        : !!(await env.CONFIGS.get(`creatorlist:${auth.username}:${candidate}`)))
    );
  }
  return slug;
}

// Reads the record being edited and applies the expectedUpdatedAt conflict guard (a step of creatorApiListsSave).
// Returns { response } on a conflict, otherwise what the save needs to know about the stored record.
async function creatorListSaveReadExisting(env, ctx, { auth, slug, editingSlug, listsOnly, onlyAccount, now, listExpected }) {
  const existingRaw = !editingSlug ? null
    : (listsOnly ? await listsV2GetRecordRaw(env, onlyAccount, slug) : await getCreatorList(env, auth.username, slug));
  let createdAt = now;
  let likes = 0;
  let storedUpdatedAt = 0;
  let existingReadable = false;
  let existingSourceUrl = "";
  let existingSynced = false;
  let existingLastSyncedAt = null;
  let existingBaseItemIds = null;
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw);
      createdAt = existing.createdAt || now;
      likes = existing.likes || 0;
      storedUpdatedAt = Number(existing.updatedAt) || 0;
      existingSourceUrl = existing.sourceUrl || "";
      existingSynced = !!existing.synced;
      existingLastSyncedAt = Number.isFinite(existing.lastSyncedAt) ? existing.lastSyncedAt : null;
      existingBaseItemIds = Array.isArray(existing.baseItemIds) ? existing.baseItemIds : null;
      existingReadable = true;
    } catch {
      // Unreadable stored record -- nothing coherent to protect against,
      // so the guard below is skipped and this save writes normally.
      createdAt = now;
    }
  }
  if (existingReadable && listExpected.value !== null && storedUpdatedAt > listExpected.value) {
    ctx.waitUntil(bumpStat(env, "sync_conflict"));
    return { response: json({
      ok: false,
      error: "conflict",
      conflict: true,
      slug,
      updatedAt: storedUpdatedAt,
    }, 409) };
  }
  return { createdAt, likes, storedUpdatedAt, existingSourceUrl, existingSynced, existingLastSyncedAt, existingBaseItemIds };
}

// The D1 row of a list save, with the one retry after a creator backfill (a step of creatorApiListsSave).
async function creatorListSaveD1Row(env, { auth, slug, name, type, visibility, itemsJson, likes, createdAt, updatedAt, order }) {
  try {
    const listId = `${auth.username}:${slug}`;
    await env.DB.prepare(
      "INSERT INTO creator_lists (id, username, name, type, visibility, items_json, likes, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type, visibility=excluded.visibility, items_json=excluded.items_json, updated_at=excluded.updated_at"
    ).bind(listId, auth.username, name, type, visibility, itemsJson, likes || 0, createdAt, updatedAt, order.length).run();
  } catch (dbErr) {
    const backfilled = await backfillCreatorRowInD1(env, auth.username);
    if (backfilled) {
      try {
        await env.DB.prepare(
          "INSERT INTO creator_lists (id, username, name, type, visibility, items_json, likes, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type, visibility=excluded.visibility, items_json=excluded.items_json, updated_at=excluded.updated_at"
        ).bind(`${auth.username}:${slug}`, auth.username, name, type, visibility, itemsJson, likes || 0, createdAt, updatedAt, order.length).run();
      } catch (retryErr) {
        console.error("D1 write error (creatorlist put, after creator backfill):", retryErr);
      }
    } else {
      console.error("D1 write error (creatorlist put):", dbErr);
    }
  }
}

// Adds a new slug to the stored list order, merging with a fresh read (a step of creatorApiListsSave).
async function creatorListSaveAddToOrder(env, auth, slug, order) {
  // Re-read and MERGE rather than writing back the array this handler
  // read at the top.
  //
  // `creatorlistorder:{u}` is one key, rewritten read-modify-write by
  // every save, and KV has no compare-and-swap -- so concurrent saves
  // each write back a snapshot taken before the others landed, and every
  // entry added in between is dropped. Measured with the reads forced to
  // interleave: twelve concurrent creations produced twelve records and
  // nine order entries. The records were never at risk (each is its own
  // key), so what is lost is the user's ordering, silently.
  //
  // Everything between reading `order` and here is real work -- a size
  // check, a slug allocation that hits KV, a D1 upsert, the record write
  // -- so the window is wide. Re-reading immediately before the write
  // and unioning shrinks it to the gap between these two lines, and
  // unioning rather than replacing means a concurrent writer's entry
  // survives even when it does land inside that gap.
  //
  // Not a full fix: two writers can still interleave between the get and
  // the put. Only moving ordering off a single key removes that, which
  // is a data-model change. This turns a routine loss into a rare one.
  try {
    const freshRaw = await env.CONFIGS.get(`creatorlistorder:${auth.username}`);
    const fresh = freshRaw ? (JSON.parse(freshRaw).order || []) : [];
    if (Array.isArray(fresh) && fresh.length) {
      // Preserve the stored order and append anything only this request
      // knows about, so a concurrent writer's positions are not
      // reshuffled by ours.
      const merged = [...fresh];
      for (const s of order) if (!merged.includes(s)) merged.push(s);
      order = merged;
      if (!order.includes(slug)) order.push(slug);
    } else {
      order.push(slug);
    }
  } catch {
    // Unreadable right now -- fall back to the snapshot this handler
    // already has rather than dropping the entry entirely.
    if (!order.includes(slug)) order.push(slug);
  }
  await env.CONFIGS.put(`creatorlistorder:${auth.username}`, JSON.stringify({ order }));
  if (env.DB) {
    try {
      await env.DB.prepare("UPDATE creator_lists SET sort_order = ? WHERE id = ?").bind(order.indexOf(slug), `${auth.username}:${slug}`).run();
    } catch (e) {}
  }
}

// Keeps the search index (lists_fts) in step with a list save (a step of creatorApiListsSave).
async function creatorListSaveSearchIndex(env, auth, slug, name, visibility) {
  // Keep search index (lists_fts) in step with this save.
  //
  // FTS5 has no primary key, so "update" here is delete-then-insert -- and
  // as two separate statements that is not one. Two concurrent saves of the
  // same list could interleave into zero rows (both deletes, then both
  // inserts is fine; delete/insert/delete is not) or two, and a failure
  // between them left the list unsearchable with nothing to say so. One
  // batch is one transaction, which is what this always meant.
  if (env.DB) {
    try {
      const ftsListId = `c:${auth.username}:${slug}`;
      const ftsStmts = [env.DB.prepare("DELETE FROM lists_fts WHERE list_id = ?").bind(ftsListId)];
      if (isPublicListVisibility(visibility)) {
        ftsStmts.push(env.DB.prepare(
          "INSERT INTO lists_fts (list_id, name, creator_name, username) VALUES (?, ?, ?, ?)"
        ).bind(ftsListId, name, auth.displayName || auth.username, auth.username));
      }
      await env.DB.batch(ftsStmts);
    } catch (dbErr) {
      console.error("D1 write error (lists_fts save):", dbErr);
    }
  }
}
