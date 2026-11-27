// The lists the bare /manifest.json (the addon link with no install config) shows.
//
// The admin curates them in /admin. They are kept as one KV record, an array of
// the same rows an install config holds ({ id, name, type, url, enabled }), so
// buildManifest advertises them unchanged and stremioCatalogRow reads them with
// no config the way it reads a chart row (findDefaultManifestEntry).
const DEFAULT_MANIFEST_KEY = "default:manifest:lists:v1";
const DEFAULT_MANIFEST_MAX_LISTS = 50;
const DEFAULT_MANIFEST_NAME_MAX = 80;
const DEFAULT_MANIFEST_URL_MAX = 2000;

async function readDefaultManifestLists(env) {
  try {
    const raw = env && env.CONFIGS ? await env.CONFIGS.get(DEFAULT_MANIFEST_KEY) : null;
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) => e && typeof e === "object" && e.id && e.type && e.url);
  } catch {
    return [];
  }
}

// The row a config-less catalog request names, or null.
async function findDefaultManifestEntry(env, id, type) {
  const lists = await readDefaultManifestLists(env);
  return lists.find((e) => e.id === id && e.type === type && e.enabled !== false) || null;
}

// What the admin sent, as rows ready to store: { value } or { error }. The id is
// made here (home-<type>-<name>, numbered when two rows would share one) because
// it is a catalog id in a URL path and has to be the same each time it is built.
function cleanDefaultManifestLists(input) {
  if (!Array.isArray(input)) return { error: "Send the lists as a list." };
  if (input.length > DEFAULT_MANIFEST_MAX_LISTS) return { error: "At most " + DEFAULT_MANIFEST_MAX_LISTS + " lists." };
  const taken = new Set();
  const value = [];
  for (let i = 0; i < input.length; i++) {
    const row = input[i];
    const where = "List " + (i + 1) + ": ";
    if (!row || typeof row !== "object" || Array.isArray(row)) return { error: where + "not a list row." };
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const url = typeof row.url === "string" ? row.url.trim() : "";
    if (!name || name.length > DEFAULT_MANIFEST_NAME_MAX) return { error: where + "give it a name of up to " + DEFAULT_MANIFEST_NAME_MAX + " characters." };
    if (row.type !== "movie" && row.type !== "series") return { error: where + 'the type has to be "movie" or "series".' };
    if (!url || url.length > DEFAULT_MANIFEST_URL_MAX) return { error: where + "give it a source link." };
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "list";
    const base = "home-" + row.type + "-" + slug;
    let id = base;
    for (let n = 2; taken.has(id); n++) id = base + "-" + n;
    taken.add(id);
    value.push({ id, name, type: row.type, url, enabled: row.enabled !== false });
  }
  return { value };
}

// /admin/api/default-manifest -> the lists the bare manifest shows (GET), and
// the save (POST { lists: [{ name, type, url, enabled? }] }), which replaces them.
async function adminApiDefaultManifest(request, env) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  if (!env || !env.CONFIGS) return json({ ok: false, error: "No CONFIGS namespace is bound." });
  if (request.method === "POST") {
    let body = {};
    try { body = await readJsonObject(request); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400); }
    const next = cleanDefaultManifestLists(body && body.lists);
    if (next.error) return json({ ok: false, error: next.error }, 400, { "Cache-Control": "no-store" });
    await env.CONFIGS.put(DEFAULT_MANIFEST_KEY, JSON.stringify(next.value));
  }
  return json({ ok: true, lists: await readDefaultManifestLists(env) }, 200, { "Cache-Control": "no-store" });
}

// What Quick Add and Discover offer, as one flat list the admin can search:
// { group, name, type, movieUrl, showUrl }. `type` is "mixed" when it has both a
// movie and a series source, otherwise "movie" or "series". A source link is the
// same string a row's `url` holds, so a pick is saved as it is. Several sources
// merged into one shelf are newline-separated, as fetchMergedCatalog reads them.
function adminQuickAddCatalog() {
  const out = [];
  const add = (group, name, movieUrl, showUrl) => {
    if (!name || (!movieUrl && !showUrl)) return;
    const type = movieUrl && showUrl ? "mixed" : (movieUrl ? "movie" : "series");
    out.push({ group, name, type, movieUrl: movieUrl || "", showUrl: showUrl || "" });
  };
  const pairs = (group, list) => {
    for (const e of list || []) {
      add(group, e.name, e.movieUrl || (e.type === "movie" ? e.url : ""), e.showUrl || (e.type === "series" ? e.url : ""));
    }
  };
  pairs("Charts", [...MDBLIST_OFFICIAL_CHARTS, ...TMDB_CHART_LISTS, ...TRAKT_CHART_LISTS, ...TRAKT_BOXOFFICE_LIST, ...SIMKL_CHART_LISTS, ...SIMKL_ANIME_LIST, ...MY_LISTS_ADDON_CHARTS, ...HIDDEN_GEMS_LIST]);
  for (const c of COMBINED_CHART_LISTS) add("Charts", c.name + " (combined)", (c.movieUrls || []).join("\n"), (c.showUrls || []).join("\n"));
  pairs("Streaming services", STREAMING_ALL);
  for (const r of STREAMING_ROW_CATALOGS) {
    const link = `tmdb:chart:${r.chartKey}`;
    add("Streaming services", `${r.serviceName}: ${r.name}`, r.kinds.movie ? link : "", r.kinds.series ? link : "");
  }
  pairs("Kids", KIDS_LISTS);
  pairs("Holidays", HOLIDAY_LISTS);
  pairs("Genres", GENRE_LISTS);
  for (const c of CURATED_LIST_ENTRIES) add("Curated", c.name, c.type === "series" ? "" : `curated:${c.slug}`, c.type === "series" ? `curated:${c.slug}` : "");
  return out;
}

// The entries whose group and name hold every word typed, at most 60.
function searchAdminQuickAddCatalog(q) {
  const words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return adminQuickAddCatalog()
    .filter((e) => { const hay = `${e.group} ${e.name}`.toLowerCase(); return words.every((w) => hay.includes(w)); })
    .slice(0, 60);
}

// /admin/api/default-manifest/catalog?q=  (GET) -> { ok, lists }
async function adminApiDefaultManifestCatalog(request, env, url) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  return json({ ok: true, lists: searchAdminQuickAddCatalog(url.searchParams.get("q")) }, 200, { "Cache-Control": "no-store" });
}

// --- The default link's lists as Live TV channels (experiment) ---------------
//
// For apps that look for Stremio's "tv" type (Ether, for one): each saved row is
// a channel in one tv catalog. Only the bare /manifest.json does this; an install
// link's manifest is untouched. No channel has a playable stream yet, so the
// stream answer is an empty list -- the experiment is whether the app lists them.
const DEFAULT_TV_CATALOG_ID = "tv-channels";
const DEFAULT_TV_PREFIX = "tvch_";

// One channel per saved row. Two rows with one name (the same list as Movies and
// as Series) are told apart by a suffix.
function defaultTvChannels(lists, origin) {
  const count = {};
  for (const l of lists) count[l.name] = (count[l.name] || 0) + 1;
  return lists.map((l) => {
    const name = count[l.name] > 1 ? `${l.name} (${l.type === "series" ? "Series" : "Movies"})` : l.name;
    const art = `${origin}/api/channel-poster?name=${encodeURIComponent(name)}`;
    return { id: DEFAULT_TV_PREFIX + l.id, type: "tv", name, poster: art, posterShape: "landscape", background: art };
  });
}

// The bare manifest with the tv type, catalog, metadata and streams added.
function withDefaultTvChannels(manifest, lists) {
  if (!lists.length) return manifest;
  const resources = manifest.resources.map((r) => (r && r.name === "meta"
    ? { ...r, types: [...r.types, "tv"], idPrefixes: [...r.idPrefixes, DEFAULT_TV_PREFIX] }
    : r));
  resources.push({ name: "stream", types: ["tv"], idPrefixes: [DEFAULT_TV_PREFIX] });
  return {
    ...manifest,
    types: [...manifest.types, "tv"],
    idPrefixes: [...manifest.idPrefixes, DEFAULT_TV_PREFIX],
    resources,
    catalogs: [...manifest.catalogs, { type: "tv", id: DEFAULT_TV_CATALOG_ID, name: "Live channels", extra: [{ name: "skip", isRequired: false }] }],
  };
}

async function defaultTvCatalogResponse(env, url) {
  const channels = defaultTvChannels(await readDefaultManifestLists(env), url.origin);
  return jsonPublic({ metas: channels }, 200, { "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0" });
}

async function defaultTvMetaResponse(env, url, id) {
  const channel = defaultTvChannels(await readDefaultManifestLists(env), url.origin).find((c) => c.id === id);
  return jsonPublic({ meta: channel || null }, 200, { "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0" });
}

// /stream/tv/<id>.json on the bare link: nothing playable yet.
function defaultTvStreamResponse() {
  return jsonPublic({ streams: [] }, 200, { "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0" });
}
