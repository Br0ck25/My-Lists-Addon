// Creator Key and session check behind every authenticated creator route (moved out of handleFetch, CQ-01)

// Moved out of handleFetch unchanged apart from the captured request, env,
// ctx and path becoming parameters. Every caller passes them in (the one-line
// authenticateCreator wrapper handleFetch kept is gone: its last caller moved).
// Split in two only for the 150-line limit: this first half decides whether
// the caller is who they say; creatorKeyAuthAccepted below records the
// key-sign-in counters and issues the session cookie once they are.

// --- Creator Profile system --------------------------------------------
//
// No accounts, no email, no passwords -- a Creator Profile is just a
// chosen name plus a randomly generated Creator Key (see
// generateCreatorKey), with only a salted hash of that key ever stored
// (see hashCreatorKey/verifyCreatorKey above). There's no session or
// token issued on "login" either: every authenticated request below
// re-sends the creatorName + creatorKey and gets re-verified against
// the stored hash each time, which is what "no authentication system"
// means here in practice -- simple, stateless, and nothing to expire
// or revoke separately from the key itself.
async function authenticateCreatorFor(request, env, ctx, path, creatorNameRaw, creatorKey, via) {
  if (!env || !env.CONFIGS) return { ok: false, error: "no-kv" };

  const sessionsEnabled = isSessionsEnabled(env);

  // Behind FF_SESSIONS: if a session is present and creatorKey was not provided,
  // authenticate via the session (request.account).
  if (sessionsEnabled && request && request.account && !creatorKey) {
    if (creatorNameRaw !== undefined && creatorNameRaw !== null && String(creatorNameRaw).trim() !== "") {
      const v = validateCreatorUsername(creatorNameRaw);
      if (!v.ok || v.normalized !== request.account.username.toLowerCase()) {
        return { ok: false, error: "Username or Key is incorrect." };
      }
    }
    if (request.account.deletedAt || request.account.status === "deleted") {
      return { ok: false, error: "Username or Key is incorrect." };
    }
    const tombstoned = await isCreatorTombstoned(env, request.account.username.toLowerCase());
    if (tombstoned) {
      return { ok: false, error: "Username or Key is incorrect." };
    }
    touchCreatorLastSeen(env, request.account.username.toLowerCase());
    return {
      ok: true,
      username: request.account.username,
      displayName: request.account.displayName || request.account.username,
      hasRecoveryAnswer: Boolean(request.account.hasRecoveryAnswer),
      sessionAuth: true,
    };
  }

  const v = validateCreatorUsername(creatorNameRaw);
  if (!v.ok) return { ok: false, error: "Username or Key is incorrect." };
  // No key and no live session for the account: the page signing with a
  // session that has ended (it then sends the key). Nothing to verify --
  // an empty key cannot match -- so no PBKDF2 run and no throttle spent.
  if (!creatorKey) return { ok: false, error: "Username or Key is incorrect.", noKey: true };
  // A username being deleted right now stops authenticating, whatever the
  // record says. Two things this catches that the record cannot: a request
  // arriving mid-purge, which would otherwise write its key back after the
  // sweep had passed; and a colo still serving the pre-deletion
  // `creator:{u}` out of KV's read cache, where the record claims the
  // account is alive because that copy is stale. See the tombstone comment
  // in 02_http-and-creator-utils.js.
  //
  // Issued alongside the profile read rather than before it: this is the
  // hottest authenticated path in the Worker (every autosave, every
  // playback ping), and one extra round trip on it is worth avoiding even
  // though the extra read is not.
  const [tombstoned, raw] = await Promise.all([
    isCreatorTombstoned(env, v.normalized),
    getCreator(env, v.normalized),
  ]);
  if (tombstoned) return { ok: false, error: "Username or Key is incorrect." };
  if (!raw) return { ok: false, error: "Username or Key is incorrect." };
  let profile;
  try {
    profile = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Username or Key is incorrect." };
  }
  // profile.keyHash is authoritative because getCreator reads D1 first when bound.
  const keyHash = profile.keyHash;
  // Every verification below runs PBKDF2 at 100,000 iterations, which is
  // ~15ms of CPU, and it runs BEFORE the caller has proved anything at
  // all. /api/creator/restore had a per-IP bucket and a daily failure
  // budget; the fifteen other routes that verify a Creator Key --
  // /api/creator/sync/load, /api/creator/lists/save,
  // /api/scrobble?creator=&key=, all of them -- had neither, so an
  // unauthenticated caller could drive unbounded Worker CPU through any
  // of them, and route around restore's protection for guessing.
  //
  // Gating it HERE rather than at each route is the point: this is the one
  // function every one of them goes through, so a route added later
  // inherits the bound instead of having to remember it. The cap is
  // deliberately generous -- a signed-in dashboard polls, autosaves and
  // pings while simply open, and a shared IP behind CGNAT is several
  // people -- because the aim is to bound abuse, not to shape normal use.
  //
  // Charged only when the memo will NOT answer, so the thing being bounded
  // is the PBKDF2 run itself. A warm, signed-in client polling and
  // autosaving never touches the bucket; a caller sending a different
  // wrong key every time touches it on every request, which is the case
  // that matters. A request with no CF-Connecting-IP cannot reach the
  // hosted Worker through Cloudflare's edge, so it is refused rather than
  // let through unthrottled (that exemption existed for self-hosters
  // running this code off Cloudflare).
  const authIp = clientIpKey(request);
  if (!authIp) return { ok: false, error: "Username or Key is incorrect." };
  if (!(await isCreatorAuthMemoized(creatorKey || "", keyHash, v.normalized))) {
    if (await consumeRateLimit(env, ctx, "creatorauth", authIp, CREATOR_AUTH_VERIFY_PER_MINUTE)) {
      return { ok: false, error: "Too many attempts. Please wait a minute and try again.", throttled: true };
    }
  }
  // Memoized only after a successful PBKDF2 verification, in this
  // isolate's memory, for a few minutes -- see
  // verifyCreatorKeyMemoized (02_http-and-creator-utils.js) for why
  // that is not a weakening of the check. A wrong key still costs a
  // full PBKDF2 run every single time.
  const valid = await verifyCreatorKeyMemoized(creatorKey || "", keyHash, v.normalized);
  if (!valid) return { ok: false, error: "Username or Key is incorrect." };
  return creatorKeyAuthAccepted(request, env, ctx, { path, creatorKey, via, v, profile, sessionsEnabled });
}

// Second half of authenticateCreatorFor: runs only after the Creator Key verified.
async function creatorKeyAuthAccepted(request, env, ctx, { path, creatorKey, via, v, profile, sessionsEnabled }) {
  // How many requests still sign with the key on the routes the page now
  // signs with its session (CREATOR_SESSION_PATH_PREFIXES): the count the
  // 60-day sunset waits on (Release 19, /admin -> Creators).
  //
  // Alongside the total (kept as it was, so the history stays comparable)
  // it counts the matched path and the reason the key was sent, which is
  // what tells a browser with no session from a bug that sends the key
  // next to a valid session (CQ-17). `via` is "trackkey" when the key
  // came from an install-link save's trackCreatorKey.
  const keyPathPrefix = typeof path === "string" ? CREATOR_SESSION_PATH_PREFIXES.find((p) => path.startsWith(p)) : undefined;
  if (keyPathPrefix) {
    const heldSessionFor = request && request.account ? String(request.account.username || "").toLowerCase() : "";
    const why = via === "trackkey" ? "trackkey"
      : heldSessionFor === v.normalized ? "withsession"
      : heldSessionFor ? "othersession"
      : "nocookie";
    if (why === "trackkey" && heldSessionFor === v.normalized) {
      // The session already signed this save and the key is only being
      // checked as the link's stored credential: not a key sign-in, so
      // the total and the path stay put.
      ctx.waitUntil(bumpStat(env, "authkey:why:trackkey"));
    } else {
      ctx.waitUntil(bumpStat(env, "authkey"));
      ctx.waitUntil(bumpStat(env, authKeyPathKind(keyPathPrefix)));
      ctx.waitUntil(bumpStat(env, "authkey:why:" + why));
    }
  }
  // Fire-and-forget, not awaited -- see touchCreatorLastSeen's own
  // comment for why this is throttled and safe to never wait on.
  touchCreatorLastSeen(env, v.normalized);

  // Behind FF_SESSIONS: a successful key-in-body auth also sets a session cookie (P3a-6).
  //
  // Only on the /api/creator/* routes, which the page calls and which keep
  // the cookie. The same check also serves /api/preview, /api/save and the
  // like, and a caller that never stores cookies would get a new 30-day
  // session row on every request. And not when the request already carries
  // a live session for this account: /api/creator/restore runs on every
  // page load, so re-issuing there grew one row per visit.
  if (sessionsEnabled && env.DB && request && typeof path === "string" && path.startsWith("/api/creator/")) {
    if (!request._sessionCookie && (!request.account || request.account.username.toLowerCase() !== v.normalized)) {
      try {
        const accountRow = await getOrBackfillAccount(env, v.normalized, profile);
        if (accountRow) {
          const userAgent = request.headers ? (request.headers.get("user-agent") || null) : null;
          const session = await createSession(env, accountRow.id, userAgent);
          request._sessionCookie = buildSessionCookieHeader(session.token);
          // Replaced, not filled in only when empty: a request carrying a
          // session for a different account is now acting as this one.
          request.account = {
            id: accountRow.id,
            username: accountRow.username,
            displayName: profile.displayName || accountRow.username,
            createdAt: accountRow.created_at,
            lastActiveAt: accountRow.last_active_at,
            version: accountRow.version || 0,
            status: accountRow.status || "active",
            hasRecoveryAnswer: Boolean(profile.recoveryAnswerHash),
          };
          request.session = session;
          if (env.LOOKUP_PEPPER && accountRow && creatorKey) {
            try {
              const hmac = await hmacLookupKey(creatorKey, env);
              if (hmac && accountRow.key_lookup_hmac !== hmac) {
                await env.DB.prepare(
                  "UPDATE accounts SET key_lookup_hmac = ? WHERE id = ?"
                ).bind(hmac, accountRow.id).run();
                accountRow.key_lookup_hmac = hmac;
              }
            } catch (hmacErr) {
              console.error("Failed to write accounts.key_lookup_hmac on creator auth:", hmacErr);
            }
          }
        }
      } catch (sessionErr) {
        console.error("Failed to issue session cookie on creator auth:", sessionErr);
      }
    }
  }

  return {
    ok: true,
    username: profile.username || v.normalized,
    displayName: profile.displayName,
    hasRecoveryAnswer: Boolean(profile.recoveryAnswerHash),
  };
}
