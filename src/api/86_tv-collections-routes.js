// My Lists TV: the account's own collections, kept on the server so the TV launcher can show them.
//
// The website keeps a signed-in account's collections (folders of lists, with a cover picture each) in the browser. Nothing saved them to
// the server, so the launcher could only ever be handed the built-in set. POST /api/creator/sync/save-collections
// { creatorName, creatorKey, customCollections, customCollectionGroups } stores them in the account's presets record
// (`creatorsyncpresets:<user>`), which is where /api/nuvio-tv/collections and /api/creator/sync/load already look for them, and which
// the account-reset sweep already deletes. It leaves the presets themselves and their version stamp alone.

const TV_COLLECTIONS_MAX_BYTES = 2 * 1024 * 1024;

// The folder's group (the collection it sits in on the Lists > Collections page), by the same rules the page uses.
function tvCollectionGroupOf(folder) {
  if (folder.parentCollectionId) {
    return { id: String(folder.parentCollectionId), name: String(folder.parentCollectionName || "My Lists Collections") };
  }
  const premade = typeof PREMADE_COLLECTIONS !== "undefined"
    ? PREMADE_COLLECTIONS.find((c) => c && c.id === "col_mylists_streaming_services")
    : null;
  const inStreaming = folder.id === "col_discovery" || !!(premade && (premade.folders || []).some((f) => f && f.id === folder.id));
  return inStreaming
    ? { id: "col_mylists_streaming_services", name: "Streaming Services" }
    : { id: "my-lists-collections", name: "My Lists Collections" };
}

async function creatorApiSyncSaveCollections(request, env, ctx, path) {
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const auth = await authenticateCreatorFor(request, env, ctx, path, body.creatorName, body.creatorKey);
  if (!auth.ok) return authFailureResponse(auth);
  if (!Array.isArray(body.customCollections)) {
    return json({ ok: false, error: "customCollections must be a list." }, 400);
  }
  const folders = body.customCollections.filter((f) => f && typeof f === "object" && !Array.isArray(f));
  const groups = Array.isArray(body.customCollectionGroups)
    ? body.customCollectionGroups.filter((g) => g && typeof g === "object" && !Array.isArray(g))
    : [];
  if (JSON.stringify({ folders, groups }).length > TV_COLLECTIONS_MAX_BYTES) {
    return json({ ok: false, error: "Your collections are too large to store (over 2MB)." }, 413);
  }
  const key = `creatorsyncpresets:${auth.username}`;
  let record = {};
  try {
    const raw = await env.CONFIGS.get(key);
    if (raw) record = JSON.parse(raw) || {};
  } catch {
    record = {};
  }
  record.customCollections = folders;
  record.customCollectionGroups = groups;
  try {
    await env.CONFIGS.put(key, JSON.stringify(record));
  } catch {
    return json({ ok: false, error: "Could not save to storage right now. Please try again in a moment." }, 500);
  }
  return json({ ok: true, folders: folders.length });
}
