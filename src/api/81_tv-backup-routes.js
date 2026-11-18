// My Lists TV: encrypted setup backup.
//
// The TV encrypts its whole setup (addons with their keys, IPTV logins, settings, profiles)
// on the box before anything is sent, using a recovery code only the owner holds. This
// Worker stores one opaque blob per hash of that code. It cannot read the blob, never sees
// the code, and a blob it holds is useless without the code. One blob per code: a new
// backup replaces the last. Entries expire after 400 days without a backup.
const TV_BACKUP_MAX_BYTES = 256 * 1024;
const TV_BACKUP_TTL_SEC = 400 * 24 * 3600;
const TV_BACKUP_ID_RE = /^[a-f0-9]{32}$/;
const TV_BACKUP_NO_STORE = { "Cache-Control": "no-store" };

// /api/tv-backup?id=<32 hex>   PUT stores the body, GET returns it.
function handleTvBackupRoutes(request, env, ctx, url, path) {
  if (path !== "/api/tv-backup") return null;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method === "PUT") return apiTvBackupPut(request, env, ctx, url);
  if (request.method === "GET") return apiTvBackupGet(request, env, ctx, url);
  return json({ ok: false, error: "Method not allowed." }, 405, TV_BACKUP_NO_STORE);
}

// Shared checks: a sane id, a rate limit by caller, and storage that exists.
async function tvBackupGate(request, env, ctx, url) {
  const id = String(url.searchParams.get("id") || "");
  if (!TV_BACKUP_ID_RE.test(id)) return { error: json({ ok: false, error: "Bad backup id." }, 400, TV_BACKUP_NO_STORE) };
  if (!env || !env.CONFIGS) return { error: json({ ok: false, error: "Not set up." }, 503, TV_BACKUP_NO_STORE) };
  const ip = clientIpKey(request);
  if (!ip || await consumeRateLimit(env, ctx, "tvbackup", ip, 30, 60)) {
    return { error: json({ ok: false, error: "Too many requests. Please wait a moment." }, 429, { ...TV_BACKUP_NO_STORE, "Retry-After": "30" }) };
  }
  return { key: `tvbk:${id}` };
}

async function apiTvBackupPut(request, env, ctx, url) {
  const gate = await tvBackupGate(request, env, ctx, url);
  if (gate.error) return gate.error;
  const body = await readRequestTextCapped(request, TV_BACKUP_MAX_BYTES);
  if (body.tooLarge) return json({ ok: false, error: "That backup is too large." }, 413, TV_BACKUP_NO_STORE);
  if (!body.text) return json({ ok: false, error: "Nothing to store." }, 400, TV_BACKUP_NO_STORE);
  await env.CONFIGS.put(gate.key, body.text, { expirationTtl: TV_BACKUP_TTL_SEC });
  return json({ ok: true, bytes: body.text.length }, 200, TV_BACKUP_NO_STORE);
}

async function apiTvBackupGet(request, env, ctx, url) {
  const gate = await tvBackupGate(request, env, ctx, url);
  if (gate.error) return gate.error;
  const text = await env.CONFIGS.get(gate.key);
  if (text === null || text === undefined) return json({ ok: false, error: "No backup found for that code." }, 404, TV_BACKUP_NO_STORE);
  return new Response(text, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", ...TV_BACKUP_NO_STORE, ...corsHeaders() } });
}
