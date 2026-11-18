// Trakt calls with a rate-limit retry (API-07). Moved here from
// 02_http-and-creator-utils.js, which is over the size baseline.
//
// A 429 is only waited out inside the live request when Trakt asks for a
// short pause. A long one (Retry-After 30) is answered at once with the 429
// and remembered per key, so the next requests make no Trakt call until it
// has passed: the app gets the stale copy or the "temporarily unavailable"
// tile immediately instead of after ~7 s, and the limited key is not hit again.
const TRAKT_RETRY_MAX_WAIT_MS = 3000;
const TRAKT_COOLDOWN_MAX_MS = 60000;
const traktCooldownUntil = new Map();

// Retry-After is seconds or an HTTP date; anything else counts as 1 s.
function traktRetryAfterMs(res) {
  const raw = String((res.headers && res.headers.get("Retry-After")) || "").trim();
  if (/^\d+$/.test(raw)) return parseInt(raw, 10) * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 1000;
}

function traktCooldownKey(options) {
  const h = (options && options.headers) || {};
  const get = (n) => (typeof h.get === "function" ? h.get(n) : h[n]);
  return String(get("trakt-api-key") || "") + "|" + String(get("Authorization") || "");
}

async function fetchTraktWithRetry(url, options = {}, retries = 2) {
  const key = traktCooldownKey(options);
  const now = Date.now();
  const until = traktCooldownUntil.get(key) || 0;
  if (until > now) {
    return new Response("", { status: 429, headers: { "Retry-After": String(Math.ceil((until - now) / 1000)) } });
  }
  const res = await fetchWithTimeout(url, options);
  if (res.status !== 429) return res;
  const waitMs = traktRetryAfterMs(res);
  if (retries > 0 && waitMs <= TRAKT_RETRY_MAX_WAIT_MS) {
    const delayMs = Math.max(1000, waitMs) + Math.floor(Math.random() * 500);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return fetchTraktWithRetry(url, options, retries - 1);
  }
  if (traktCooldownUntil.size > 500) traktCooldownUntil.clear();
  traktCooldownUntil.set(key, Date.now() + Math.min(TRAKT_COOLDOWN_MAX_MS, Math.max(1000, waitMs)));
  return res;
}
