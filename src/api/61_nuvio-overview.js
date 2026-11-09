// Two read-only extras from the Nuvio API, both best effort: neither can fail a sync.
//
// get_sync_overview: per-profile counts (library, progress, watched, addons), kept in
// the last-result record after a completed pull for the settings card.
// GET /functions/v1/health-check: asked only after a pull failed, so the message can
// say Nuvio itself is down instead of leaving it to look like the sign-in.

// { library, progress, watched, addons } for one profile, or undefined.
async function nuvioFetchOverview(env, accessToken, profileIndex) {
  try {
    const o = await nuvioRpc(env, accessToken, "get_sync_overview", {});
    if (!o || typeof o !== "object") return undefined;
    const at = (map) => (map && typeof map === "object" && Number.isFinite(Number(map[String(profileIndex)])) ? Number(map[String(profileIndex)]) : undefined);
    const out = { library: at(o.library_items), progress: at(o.watch_progress), watched: at(o.watched_items), addons: at(o.addons) };
    return Object.values(out).some((v) => v !== undefined) ? JSON.parse(JSON.stringify(out)) : undefined;
  } catch {
    return undefined;
  }
}

// "healthy", "slow", "degraded" or "down"; null when Nuvio does not answer sensibly.
async function nuvioHealth(env) {
  try {
    const res = await mediaAppFetch(`${nuvioBase(env)}/functions/v1/health-check`, { headers: { "apikey": nuvioKey(env) }, signal: AbortSignal.timeout(5000) });
    const d = await res.json().catch(() => null);
    return d && ["healthy", "slow", "degraded", "down"].includes(d.status) ? d.status : null;
  } catch {
    return null;
  }
}

// What to show on the settings card for a failed Nuvio read. A refusal Nuvio gave on
// purpose (429, 409, 422) keeps its own message; anything else asks the health check.
async function nuvioFailureMessage(env, e) {
  if ([429, 409, 422].includes(e && e.nuvioStatus)) return e.message;
  const health = await nuvioHealth(env);
  if (health === "down") return "Nuvio is down right now. It will try again.";
  if (health === "degraded") return "Nuvio is having problems right now. It will try again.";
  return e.message;
}
