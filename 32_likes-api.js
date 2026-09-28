
// --- Likes API (Phase 3b, P3b-5) ---------------------------------------------
//
//   GET    /api/likes/{type}/{id}   { liked, likes } -- liked is false signed out
//   PUT    /api/likes/{type}/{id}   like
//   DELETE /api/likes/{type}/{id}   take the like back
//
// {type} is list, channel or external:
//   list      {id} is lists.public_id. A public or unlisted list can be liked;
//             a private one, a deleted one, and a legacy anonymous one (D-6)
//             answer 404, as the legacy route answers for a private list.
//   channel   {id} is channels.public_code, for a channel listed in Explore
//             Channels (visibility public), as the legacy route requires.
//   external  {id} is the list's URL, percent-encoded. It must be a list on a
//             provider this add-on integrates with (normalizeExternalListUrl),
//             which is what stops this being an open-ended keyspace; it is
//             stored under the same hash the legacy route and the backfill use.
//
// The voter is the signed-in account, "acct:<id>" (D-6). There is no cap.
// Liking twice, or taking back a like that is not there, changes nothing and
// answers the same. The legacy signed-out "a:" votes the backfill carried
// across are never touched here and keep counting (D-9).
//
// A like is INSERT OR IGNORE, and the target's like_count moves by changes()
// in the same batch, so the count moves by exactly the rows that changed even
// when the same account double-clicks from two devices. like_count can sit
// above the rows on record (the backfill keeps a higher legacy total), which
// is why it is adjusted rather than recounted. An external list has no row of
// its own, so its count is the rows.
//
// Behind FF_V2_LISTS_API with the list API, and off until reads move to v2
// (P3b-7): until then a backfill re-run replaces each target's likes with the
// legacy ones. P3b-7 maps /api/lists/like and /like-external onto this.

const LIKES_API_TYPES = new Set(["list", "channel", "external"]);

// The target a like names, or { error, status }. For a list or a channel,
// `table` is where its like_count lives.
async function resolveLikeTarget(env, type, rawId) {
  if (type === "list") {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(rawId)) return { error: "List not found.", status: 404 };
    const row = await env.DB.prepare(
      "SELECT id, like_count FROM lists WHERE public_id = ? AND deleted_at IS NULL AND visibility IN ('public', 'unlisted') AND kind != 'legacy_anonymous'"
    ).bind(rawId).first();
    if (!row) return { error: "List not found.", status: 404 };
    return { type, targetId: rawId, table: "lists", key: "public_id" };
  }
  if (type === "channel") {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(rawId)) return { error: "Channel not found.", status: 404 };
    const row = await env.DB.prepare(
      "SELECT id FROM channels WHERE public_code = ? AND deleted_at IS NULL AND visibility = 'public'"
    ).bind(rawId).first();
    if (!row) return { error: "Channel not found.", status: 404 };
    return { type, targetId: rawId, table: "channels", key: "public_code" };
  }
  let decoded;
  try {
    decoded = decodeURIComponent(rawId);
  } catch {
    decoded = "";
  }
  const normalized = normalizeExternalListUrl(decoded);
  if (!normalized) {
    return { error: "That URL can't be liked -- only MDBList, Trakt, TMDB, Simkl, and Letterboxd list links are supported.", status: 400 };
  }
  return { type, targetId: await hashStringForKey(normalized), table: null, key: null };
}

async function likeTargetCount(env, target) {
  if (target.table) {
    const row = await env.DB.prepare(`SELECT like_count AS n FROM ${target.table} WHERE ${target.key} = ?`).bind(target.targetId).first();
    return Number(row && row.n) || 0;
  }
  const row = await env.DB.prepare("SELECT count(*) AS n FROM likes WHERE target_type = ? AND target_id = ?").bind(target.type, target.targetId).first();
  return Number(row && row.n) || 0;
}

async function hasLiked(env, target, voter) {
  const row = await env.DB.prepare(
    "SELECT 1 AS yes FROM likes WHERE target_type = ? AND target_id = ? AND voter = ?"
  ).bind(target.type, target.targetId, voter).first();
  return Boolean(row);
}

async function handleLikesApi(request, env, url, path) {
  if (!path.startsWith("/api/likes/")) return null;
  if (!isListsApiEnabled(env)) return null;
  if (!env || !env.DB) return json({ ok: false, error: "Likes aren't available right now." }, 503);
  try {
    return await handleLikesApiRoutes(request, env, path);
  } catch (e) {
    console.error("Likes API failed:", e);
    return json({ ok: false, error: "Likes aren't available right now." }, 503);
  }
}

async function handleLikesApiRoutes(request, env, path) {
  const parts = path.split("/").filter(Boolean); // ["api", "likes", type, id]
  if (parts.length !== 4 || !LIKES_API_TYPES.has(parts[2])) return json({ ok: false, error: "Not found." }, 404);
  const method = request.method;
  if (method !== "GET" && method !== "PUT" && method !== "DELETE") return json({ ok: false, error: "Not found." }, 404);
  const account = request.account || null;
  if (method !== "GET" && !account) {
    return json({ ok: false, error: "Sign in to like lists.", signInRequired: true }, 401);
  }
  const target = await resolveLikeTarget(env, parts[2], parts[3]);
  if (target.error) return json({ ok: false, error: target.error }, target.status);
  const voter = account ? `acct:${account.id}` : null;

  if (method === "GET") {
    return json({ ok: true, liked: voter ? await hasLiked(env, target, voter) : false, likes: await likeTargetCount(env, target) });
  }

  const liking = method === "PUT";
  // Already as asked: answer without writing. The batch is still safe on its
  // own if two requests race past this check.
  if ((await hasLiked(env, target, voter)) !== liking) {
    await env.DB.batch(likeWriteStatements(env, target, voter, liking, account.id));
  }
  return json({ ok: true, liked: liking, likes: await likeTargetCount(env, target) });
}

// One like or unlike, as one batch. Run twice for the same voter (two
// devices at once), it moves the count once.
function likeWriteStatements(env, target, voter, liking, accountId) {
  const stmts = [
    liking
      ? env.DB.prepare("INSERT OR IGNORE INTO likes (target_type, target_id, voter, created_at) VALUES (?, ?, ?, ?)")
        .bind(target.type, target.targetId, voter, Date.now())
      : env.DB.prepare("DELETE FROM likes WHERE target_type = ? AND target_id = ? AND voter = ?")
        .bind(target.type, target.targetId, voter),
  ];
  // Must come straight after the like itself: changes() is the row count of
  // the statement before it.
  if (target.table) {
    stmts.push(env.DB.prepare(
      liking
        ? `UPDATE ${target.table} SET like_count = like_count + changes() WHERE ${target.key} = ?`
        : `UPDATE ${target.table} SET like_count = max(0, like_count - changes()) WHERE ${target.key} = ?`
    ).bind(target.targetId));
  }
  // What this account has liked changed: its other devices should look.
  stmts.push(accountVersionStatement(env, accountId));
  return stmts;
}
