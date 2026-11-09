// POST /api/connections/stremio/install-addon: puts this site's addon in the person's Stremio
// account, so they need not open the stremio:// link on the device (which TVs and some phones
// cannot do).
//
// Stremio's account API has addonCollectionSet, but it REPLACES the whole collection, and a
// partial list would silently delete someone's addons. This never calls it. The client library
// (Stremio/stremio-api-client) sends addonCollectionGet with an addFromURL list, and the server
// adds those addons itself, so the collection is only ever added to. The collection is read
// first (a reply we cannot read stops everything), and the result is read back: success is only
// reported if the addon is really in the returned list. Behind FF_MEDIA_APP_PUSH like the other
// writes into an app account. The request and reply shapes come from the client library's source;
// none was checked against a live account.

// The manifest URL to install, or null: our own origin only, an install link or a config id,
// nothing after the path (no query, no fragment, no credentials).
function stremioManifestUrlOk(raw, origin) {
  let u;
  try {
    u = new URL(String(raw || ""));
  } catch {
    return null;
  }
  if (u.origin !== origin || u.search || u.hash || u.username || u.password) return null;
  return /^\/(?:i\/[A-Za-z0-9_-]{43}|[A-Za-z0-9_-]{6,64})\/manifest\.json$/.test(u.pathname) ? u.origin + u.pathname : null;
}

async function stremioAddonList(authKey, addFromURL) {
  const result = await stremioCall("addonCollectionGet", { authKey, update: true, addFromURL });
  if (!result || !Array.isArray(result.addons)) throw mediaAppError("unreachable", "Stremio sent an addon list we could not read.");
  return result.addons;
}

async function mediaAppStremioInstall(env, accountId, provider, body, origin) {
  if (provider !== "stremio") return json({ ok: false, error: "This is only for Stremio." }, 400);
  if (!mediaAppPushFlag(env)) return json({ ok: false, error: "Installing in Stremio isn't switched on yet." }, 409);
  const url = stremioManifestUrlOk(body && body.manifestUrl, origin);
  if (!url) return json({ ok: false, error: "Make an install link first, then try again." }, 400);
  const conn = await loadProviderConnection(env, accountId, provider);
  if (!conn || conn.status !== "ok" || !conn.accessToken) return json({ ok: false, error: "Your Stremio account isn't connected." }, 404);
  const has = (list) => list.some((a) => a && typeof a.transportUrl === "string" && a.transportUrl.replace(/\/+$/, "") === url);
  try {
    if (has(await stremioAddonList(conn.accessToken, []))) return json({ ok: true, alreadyInstalled: true });
    if (!has(await stremioAddonList(conn.accessToken, [url]))) return json({ ok: false, error: "Stremio did not add the addon. Use the Install in Stremio link instead." }, 502);
    return json({ ok: true, installed: true });
  } catch (e) {
    if (e && e.kind === "invalid") {
      await markConnectionStatus(env, accountId, provider, "reauth_required", "The service refused this sign-in. Connect it again.");
      return json({ ok: false, error: "Sign in to Stremio again first." }, 400);
    }
    return json({ ok: false, error: String((e && e.message) || "Could not reach Stremio.") }, 502);
  }
}

// --- Removing one episode from a show's watched state ------------------------------------------
//
// Stremio keeps a show's watched episodes in one bitfield (see stremioEncodeWatched). Removing one
// episode reads the show's episode list, clears that episode's bit and writes the item back with
// the new bitfield, changing nothing else on it. Anything it cannot read cleanly (no library item,
// no episode list, an anchor episode that is not in the list) changes nothing, so a failed read
// can never become a rewritten bitfield. Returns whether Stremio had that episode as watched.
async function stremioRemoveEpisode(conn, imdbId, episode) {
  const library = await stremioFetchLibrary(conn.accessToken);
  const item = library.find((it) => String(it._id) === imdbId);
  if (!item) return false;
  const eps = await stremioEpisodes(imdbId);
  if (!eps) throw mediaAppError("unreachable", "Could not list this show's episodes just now. Please try again.");
  const state = item.state && typeof item.state === "object" ? { ...item.state } : {};
  const have = new Set((state.watched ? await stremioWatchedEpisodes(state.watched, eps) : []).map((e) => `${e.season}:${e.episode}`));
  const key = `${episode.season}:${episode.episode}`;
  if (!have.delete(key)) return false;
  if (have.size) state.watched = await stremioEncodeWatched(eps, have);
  else delete state.watched;
  const res = await stremioCall("datastorePut", { authKey: conn.accessToken, collection: "libraryItem", changes: [{ ...item, _mtime: new Date().toISOString(), state }] });
  if (!res || res.success !== true) throw mediaAppError("unreachable", "Stremio did not accept the change.");
  return true;
}
