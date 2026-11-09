// A read-only look at what Nuvio holds for the home catalog settings, for the
// Nuvio card's "Check home settings" button. This site writes them under
// p_platform "home_catalog_shared" (nuvioPullHomeSettings, nuvioSaveHomeVisibility);
// Nuvio's API document only describes "tv" as the platform namespace. The button
// shows both for the signed-in person's own profile, so which one a real Nuvio
// app reads can be settled from facts. It writes nothing and returns only the
// names of the saved keys with their sizes, never the settings themselves.

const NUVIO_HOME_PLATFORMS = ["tv", "home_catalog_shared"];

// { key: size } for the keys of a settings object: an array's length, a boolean
// as it is, anything else its type.
function nuvioSettingsShape(settings) {
  let value = settings;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = Array.isArray(v) ? v.length : (typeof v === "boolean" ? v : typeof v);
  return out;
}

async function mediaAppHomeSettingsCheck(env, accountId, provider) {
  if (provider !== "nuvio") return json({ ok: false, error: "This check is only for Nuvio." }, 400);
  let conn = await loadProviderConnection(env, accountId, provider);
  const row = await loadMediaAppSync(env, accountId, provider);
  if (!conn || conn.status !== "ok" || !row) return json({ ok: false, error: "Your Nuvio account isn't connected." }, 404);
  conn = await refreshProviderConnectionIfDue(env, accountId, provider, conn);
  if (!conn || !conn.accessToken) return json({ ok: false, error: "Sign in to Nuvio again first." }, 400);
  const profileId = Number(row.profile_index) || 1;
  const platforms = [];
  for (const platform of NUVIO_HOME_PLATFORMS) {
    try {
      const rows = await nuvioRpc(env, conn.accessToken, "sync_pull_home_catalog_settings", { p_profile_id: profileId, p_platform: platform });
      const list = Array.isArray(rows) ? rows : [];
      platforms.push({ platform, rows: list.length, updatedAt: (list[0] && list[0].updated_at) || undefined, keys: nuvioSettingsShape(list[0] && list[0].settings_json) });
    } catch (e) {
      platforms.push({ platform, error: String((e && e.message) || "Could not be read.").slice(0, 200) });
    }
  }
  return json({ ok: true, profileId, usedByThisSite: "home_catalog_shared", platforms });
}
