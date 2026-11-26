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
