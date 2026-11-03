// --- Sliding sessions (SEC-03, step 0) ----------------------------------------------
//
// A session used to expire 30 days after sign-in whatever happened in between.
// Now a session that is in use is renewed: at most every 5 minutes, together with
// the last_seen_at refresh, expires_at moves to now + SESSION_TTL_MS, and the
// response to an /api/creator/ request carries the same cookie again with a fresh
// Max-Age so the browser's copy moves too. Someone who visits regularly never has
// to sign in again; someone away for 30 days does.
//
// Only a live session is renewed: revoked, expired and deleted-account sessions
// are refused by resolveSession before this runs, and the UPDATE below also
// requires revoked_at IS NULL, so a request racing a sign-out cannot undo it.

const SESSION_RENEW_AFTER_MS = 5 * 60 * 1000;

// True when this request renews the session (the write itself is handed to waitUntil).
function renewSessionIfDue(env, ctx, row, now) {
  if (typeof row.last_seen_at !== "number" || now - row.last_seen_at <= SESSION_RENEW_AFTER_MS) return false;
  const write = env.DB.prepare(
    "UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id_hash = ? AND revoked_at IS NULL"
  ).bind(now, now + SESSION_TTL_MS, row.id_hash).run().catch(() => {});
  (ctx || { waitUntil() {} }).waitUntil(write);
  return true;
}

// The Set-Cookie value that renews the browser's copy, or null when this request
// did not renew or did not come with the cookie (a Bearer token has no cookie).
function sessionCookieRenewal(request) {
  if (!request || !request._sessionRenewed) return null;
  const cookieHeader = request.headers.get("Cookie") || request.headers.get("cookie") || "";
  if (!/(?:^|;\s*)mla_session=/.test(cookieHeader)) return null;
  const token = extractSessionToken(request);
  return token ? buildSessionCookieHeader(token) : null;
}

// --- FF_FORGET_KEY (SEC-03) -----------------------------------------------------------
//
// When set to 1, every answer that confirms a session (X-MLA-Session) also says
// X-MLA-Forget-Key: 1, and a page that has seen both stops keeping the Account
// Key in this browser (16_client-forget-key.js). Off by default.
function isForgetKeyEnabled(env) {
  return Boolean(env) && (env.FF_FORGET_KEY === "1" || env.FF_FORGET_KEY === "true" || env.FF_FORGET_KEY === true);
}
