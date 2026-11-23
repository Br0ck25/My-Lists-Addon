// My Lists TV: a signed-in profile's stream addons, kept on its account.
//
// POST /api/nuvio-tv/setup { targetId, action: "get" }                       -> { ok, addons, updatedAt }
// POST /api/nuvio-tv/setup { targetId, action: "set", addons: [{ url, on }] } -> { ok, updatedAt }
// The list holds debrid keys inside the links, so it is stored encrypted at rest with the Worker's
// TOKEN_ENCRYPTION_KEY (the same key and AES-GCM the install secrets use), bound to the account, and never written when no
// key is configured. Only the secret the TV got at pairing opens it; one record per account.
const TV_SETUP_ADDONS_MAX = 50;
const TV_SETUP_URL_MAX = 2000;

function tvSetupContext(username) { return `tvsetup:${username}`; }

async function handleNuvioTvSetup(request, env, ctx) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405, corsHeaders());
  const noStore = { ...corsHeaders(), "Cache-Control": "no-store" };
  let body;
  try { body = await readJsonObject(request); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400, noStore); }
  const device = await resolveNuvioTvDeviceToken(env, String((body && body.targetId) || "").trim());
  if (!device) return json({ ok: false, error: "Target not found or not paired. Pair the TV again." }, 404, noStore);
  const username = device.username;
  if (await consumeRateLimit(env, ctx, "tvsetup", username, 60, 60)) return json({ ok: false, error: "Too many requests." }, 429, noStore);
  if (!env || !env.CONFIGS || !hasTokenEncryptionKey(env)) return json({ ok: false, error: "This server cannot store addon lists safely." }, 503, noStore);
  const key = `tvsetup:${username}`;

  if (body.action === "get") {
    const raw = await env.CONFIGS.get(key);
    if (!raw) return json({ ok: true, addons: [], updatedAt: 0, username }, 200, noStore);
    try {
      const rec = JSON.parse(raw);
      const data = JSON.parse(await decryptToken(rec.enc, env, tvSetupContext(username)));
      return json({ ok: true, addons: data.addons || [], updatedAt: Number(rec.updatedAt) || 0, username }, 200, noStore);
    } catch (e) {
      console.error("tv setup: could not read", e);
      return json({ ok: false, error: "The stored setup could not be read." }, 500, noStore);
    }
  }
  const okUrl = (u) => typeof u === "string" && /^https?:\/\//i.test(u) && u.length <= TV_SETUP_URL_MAX;
  if (body.action !== "set" || !Array.isArray(body.addons) || body.addons.length > TV_SETUP_ADDONS_MAX) {
    return json({ ok: false, error: "Send action get, or set with addons (up to 50)." }, 400, noStore);
  }
  const addons = body.addons.filter((a) => a && okUrl(a.url)).map((a) => ({ url: a.url, on: a.on !== false }));
  const updatedAt = Date.now();
  await env.CONFIGS.put(key, JSON.stringify({ updatedAt, enc: await encryptToken(JSON.stringify({ addons }), env, tvSetupContext(username)) }));
  return json({ ok: true, updatedAt, addons: addons.length }, 200, noStore);
}
