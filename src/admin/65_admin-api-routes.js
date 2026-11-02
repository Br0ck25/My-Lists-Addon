// Admin dashboard API, part 1 (/admin/api/creators ... /export-kv-to-r2), moved out of handleFetch (CQ-01).

// Moved unchanged: each route body is now its own function; the dispatcher keeps each route's
// original path/method test. Every route still checks isAdminRequest itself, as before.

// The /admin/api/ routes of part 1, in their original order. Returns a Response, or null when none matched.
async function handleAdminApiRoutes(request, env, ctx, url, path) {
  if (path === "/admin/api/creators" && request.method === "GET") return adminApiCreators(request, env, url);
  if (path === "/admin/api/leaderboard" && request.method === "GET") return adminApiLeaderboard(request, env, url);
  if (path === "/admin/api/backfill-trending" && request.method === "POST") return adminApiBackfillTrending(request, env);
  if ((path === "/admin/api/rebuild-search-index" || path === "/admin/api/rebuild-public-index") && request.method === "POST") return adminApiRebuildSearchIndex(request, env);
  if (path === "/admin/api/creator-lists" && request.method === "GET") return adminApiCreatorLists(request, env, url);
  if (path === "/admin/api/delete-creator-list" && request.method === "POST") return adminApiDeleteCreatorList(request, env);
  if (path === "/admin/api/schema-status" && request.method === "GET") return adminApiSchemaStatus(request, env);
  if (path === "/admin/api/published-channels" && request.method === "GET") return adminApiPublishedChannels(request, env, url);
  if (path === "/admin/api/channel-moderate" && request.method === "POST") return adminApiChannelModerate(request, env);
  if (path === "/admin/api/channel-ownerless" && request.method === "POST") return adminApiChannelOwnerless(request, env);
  if (path === "/admin/api/key-lookup-cleanup" && request.method === "POST") return adminApiKeyLookupCleanup(request, env);
  if (path === "/admin/api/migrate-day-counts" && request.method === "POST") return adminApiMigrateDayCounts(request, env);
  if (path === "/admin/api/export-kv-to-r2" && request.method === "POST") return adminApiExportKvToR2(request, env);
  return null;
}

// /admin/api/creators?q=&page=&pageSize=50|100 -> { ok, total, matched,
// page, pages, pageSize, rows } -- one page of creator accounts for the
// Creator Accounts tab, searchable over every username and display name.
async function adminApiCreators(request, env, url) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  try {
    const data = await listAdminCreators(env, url.searchParams.get("q"), url.searchParams.get("page"), url.searchParams.get("pageSize"));
    return json({ ok: true, ...data }, 200, { "Cache-Control": "no-store" });
  } catch (e) {
    console.error("admin creators list failed:", e);
    return json({ ok: false, error: "Could not load creator accounts." }, 500, { "Cache-Control": "no-store" });
  }
}

// /admin/api/leaderboard?type=watched|list-add&window=today|7|30|90|alltime&mediaType=movie|series
// -> { ok, entries } -- backs the Trending Data tab's dropdown, computed
// on demand rather than eagerly for every window/type combo on every
// page load (see computeLeaderboard's own comment on why this can fan
// out to a meaningful number of KV reads). mediaType is optional --
// omitted or anything else means both movies and shows together.
async function adminApiLeaderboard(request, env, url) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  const eventType = url.searchParams.get("type") === "list-add" ? "list-add" : "watched";
  const allowedWindows = new Set(["today", "7", "30", "90", "alltime"]);
  const window = allowedWindows.has(url.searchParams.get("window")) ? url.searchParams.get("window") : "7";
  const mediaTypeParam = url.searchParams.get("mediaType");
  const mediaType = mediaTypeParam === "movie" || mediaTypeParam === "series" ? mediaTypeParam : null;
  const entries = await computeLeaderboard(env, eventType, window, mediaType);
  // no-store -- json()'s own default (max-age=3600) would otherwise
  // have the browser silently reuse an hour-old leaderboard on the
  // next tab switch/refresh instead of hitting the network again (see
  // /admin/api/feedback's own comment, which is where this was first
  // caught).
  return json({ ok: true, entries }, 200, { "Cache-Control": "no-store" });
}

// /admin/api/backfill-trending  (POST) -> { ok, done, accountsThisCall, titlesThisCall }
// Seeds the All Time trending leaderboards (see backfillTitleCount's
// own comment on why all-time-only) from data that already existed
// before trending tracking shipped -- each creator account's Watch
// History (aggregated to distinct shows/movies, dedupe-by-showId same
// as the live tracking does) and their own Custom Lists' current
// items. Processes exactly one account per call, capped to a handful
// of titles from each source, to stay comfortably under Cloudflare's
// per-request subrequest limit -- the admin dashboard's "Backfill
// Existing Data" button calls this repeatedly until it reports
// done:true, so this only needs to make forward progress each call,
// not finish everything at once. Resumes via a cursor stored at
// backfilltrending:cursor (same list()-cursor pattern
// checkForNewEpisodes already uses for its own account sweep);
// starting the sweep over from the top once every account has been
// visited is intentional, so an account created after the last full
// pass eventually gets covered too, and running this again later
// picks up anyone whose history grew since the first pass -- entries
// just accumulate (each backfill run adds its own snapshot on top of
// whatever's already there, same as any other watch/list-add event
// would), it doesn't overwrite.
async function adminApiBackfillTrending(request, env) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  if (!env || !env.CONFIGS) return json({ ok: true, done: true, accountsThisCall: 0, titlesThisCall: 0 });
  if (isV2ListsOnly(env)) {
    return json({ ok: true, done: true, accountsThisCall: 0, titlesThisCall: 0, retired: true });
  }

  const WATCHED_TITLE_CAP = 6;
  const LIST_ITEM_CAP = 6;

  const cursorRaw = await env.CONFIGS.get("backfilltrending:cursor");
  const listOpts = { prefix: "creator:", limit: 1 };
  if (cursorRaw) listOpts.cursor = cursorRaw;
  const listResult = await env.CONFIGS.list(listOpts);

  if (!listResult.keys.length) {
    // Reached the end of the account list (or there are no accounts
    // at all) -- reset to the top so a later run starts fresh rather
    // than permanently reporting "done" against a stale cursor.
    await env.CONFIGS.put("backfilltrending:cursor", "");
    return json({ ok: true, done: true, accountsThisCall: 0, titlesThisCall: 0 });
  }
  await env.CONFIGS.put("backfilltrending:cursor", listResult.list_complete ? "" : (listResult.cursor || ""));

  const username = listResult.keys[0].name.slice("creator:".length);
  let titlesThisCall = 0;

  // Watch History -> "watched", aggregated to distinct shows/movies
  // (episodes collapse to their show, same as live tracking).
  try {
    const trackingRaw = await env.CONFIGS.get(`creatorsynctracking:${username}`);
    if (trackingRaw) {
      const tracking = JSON.parse(trackingRaw);
      const watchHistory = Array.isArray(tracking.watchHistory) ? tracking.watchHistory : [];
      const counts = new Map(); // id -> { title, mediaType, count }
      watchHistory.forEach((it) => {
        const id = it.showId || it.id;
        if (!id) return;
        const title = it.showTitle || it.name || "";
        const mediaType = it.type === "movie" ? "movie" : "series";
        const existing = counts.get(id);
        if (existing) existing.count++;
        else counts.set(id, { title, mediaType, count: 1 });
      });
      const topTitles = [...counts.entries()].slice(0, WATCHED_TITLE_CAP);
      for (const [id, info] of topTitles) {
        const ok = await backfillTitleCount(env, "watched", id, info.title, info.mediaType, info.count);
        if (ok) titlesThisCall++;
      }
    }
  } catch (e) {
    // Skip this account's Watch History on any read/parse error --
    // still worth trying its Custom Lists below, and the account
    // will simply be revisited on a future full pass.
  }

  // Custom Lists -> "list-add", using each list's current items
  // (there's no historical "added at" timestamp to work from, only
  // present membership -- see this endpoint's own comment on why
  // that's fine for an all-time-only count). Lists directly, by this
  // account's own creatorlist: prefix, rather than going through
  // creatorlistorder:{username} (which tracks display order for
  // reordering specifically, not guaranteed to be a complete
  // inventory of every list the account has).
  try {
    const listsResult = await env.CONFIGS.list({ prefix: `creatorlist:${username}:`, limit: 20 });
    let itemsSeen = 0;
    for (const listKey of listsResult.keys) {
      if (itemsSeen >= LIST_ITEM_CAP) break;
      const listRaw = await env.CONFIGS.get(listKey.name);
      if (!listRaw) continue;
      const list = JSON.parse(listRaw);
      const items = Array.isArray(list.items) ? list.items : [];
      for (const it of items) {
        if (itemsSeen >= LIST_ITEM_CAP) break;
        const id = it.imdbId || it.id;
        if (!id) continue;
        const ok = await backfillTitleCount(env, "list-add", id, it.title || it.name || "", list.type === "series" ? "series" : "movie", 1);
        if (ok) titlesThisCall++;
        itemsSeen++;
      }
    }
  } catch (e) {
    // Skip this account's Custom Lists on any read/parse error.
  }

  return json({ ok: true, done: false, accountsThisCall: 1, titlesThisCall, username });
}

// /admin/api/rebuild-search-index (and alias /admin/api/rebuild-public-index) (POST) -> { ok, done, count, scanned, ms }
// Rebuilds lists_fts from creator_lists and published_lists in D1.
// Also serves as the post-export recreation procedure.
async function adminApiRebuildSearchIndex(request, env) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  const started = Date.now();
  if (!env || !env.DB) {
    return json({ ok: true, done: true, count: 0, scanned: 0, ms: Date.now() - started });
  }
  // The v2 search table too (P3b-9), and with FF_V2_LISTS_ONLY only that:
  // the legacy one is built from tables that are no longer written.
  const v2Count = await rebuildListsFts2(env);
  if (isV2ListsOnly(env)) {
    if (v2Count == null) return json({ ok: false, error: "Rebuild failed: the v2 list tables are not there." }, 500);
    return json({ ok: true, done: true, count: v2Count, scanned: v2Count, v2Count, ms: Date.now() - started });
  }
  try {
    await env.DB.prepare(`
          CREATE VIRTUAL TABLE IF NOT EXISTS lists_fts USING fts5(
            list_id UNINDEXED,
            name,
            creator_name,
            username,
            tokenize = 'unicode61 remove_diacritics 2'
          )
        `).run();
    await env.DB.prepare("DELETE FROM lists_fts").run();
    await env.DB.prepare(`
          INSERT INTO lists_fts (list_id, name, creator_name, username)
          SELECT
            'c:' || cl.id,
            cl.name,
            COALESCE(c.display_name, cl.username),
            cl.username
          FROM creator_lists cl
          LEFT JOIN creators c ON c.username = cl.username
          WHERE cl.visibility = 'public'
        `).run();
    const countRes = await env.DB.prepare("SELECT COUNT(*) AS n FROM lists_fts").all();
    const count = (countRes && countRes.results && countRes.results[0]) ? Number(countRes.results[0].n) || 0 : 0;

    return json({
      ok: true,
      done: true,
      count,
      scanned: count,
      v2Count: v2Count == null ? undefined : v2Count,
      ms: Date.now() - started,
    });
  } catch (e) {
    return json({ ok: false, error: "Rebuild failed: " + (e && e.message ? e.message : String(e)) }, 500);
  }
}

// /admin/api/migrate-day-counts  (POST) -> { ok, done, keysMigratedThisCall }
// One-time migration for the switch (see recordTrackedEvent's own
// comment) from one KV key per (eventType/query, id, day) to one JSON
// blob per (eventType/query, id) holding every day's count. Old
// per-day keys are still sitting in KV from before that switch --
// this reads them, folds each into the corresponding new blob (merging
// with whatever's already there from live tracking since the switch,
// never overwriting), and deletes the old key once it's safely folded
// in. Deleting as it goes is what makes this safe to run repeatedly:
// a second run finds nothing left to migrate and reports done
// immediately, the same idempotent shape backfill-trending above has.
// Same paginated-cursor pattern as that endpoint too, for the same
// reason -- covers three prefixes in sequence (evtcount:watched:,
// evtcount:list-add:, searchquery:), storing which prefix and how far
// into its key list this run has reached in migratedaycounts:state so
// repeated calls make forward progress without redoing work.
// /admin/api/creator-lists  (GET)  ?username=...&limit=...&cursor=...
//   -> { ok, username, count, lists: [...], cursor, done, orderCount }
//
// The half of "Delete a creator's lists" that was missing: nothing in this
// dashboard could tell you WHICH lists a creator has, and the delete below
// takes exact slugs. That is fine for the case it was written for -- an
// admin acting on one list somebody reported -- and useless for the case
// it keeps being needed for: an account carrying dozens of duplicates of
// the same list, minted by the runaway that /api/creator/lists/save's own
// comment records (one account reached 129 records for 22 real lists,
// coming-of-age-3 through coming-of-age-53). Their slugs are not
// guessable, they are not all in the creator's display order, and typing
// the base name deletes exactly one of them -- which is what "it will not
// delete them" actually is.
//
// Enumerates the KV records themselves rather than creatorlistorder:,
// deliberately. The order key is one value rewritten read-modify-write by
// every save, it is what LOST entries during that runaway, and a list
// missing from it is precisely the kind that needs cleaning up. inOrder
// reports the difference rather than hiding it.
async function adminApiCreatorLists(request, env, url) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  if (!env || (!env.CONFIGS && !env.DB)) return json({ ok: false, error: "no-storage" });
  const rawUser = (url.searchParams.get("username") || "").replace(/^@+/, "").trim();
  const v = validateCreatorUsername(rawUser);
  if (!v.ok) return json({ ok: false, error: "Invalid username." }, 400);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 1), 200);
  const cursor = url.searchParams.get("cursor") || "";

  let targetUsername = v.normalized;
  targetUsername = await adminResolveCreatorListsUsername(env, targetUsername);

  // FF_V2_LISTS_ONLY (P3b-9): the lists are v2's; the legacy records are
  // behind.
  if (isV2ListsOnly(env)) {
    let v2Lists;
    try {
      v2Lists = await listsV2AdminLists(env, targetUsername, url.origin);
    } catch (e) {
      return json({ ok: false, error: "Could not read this creator's lists right now." }, 500, { "Cache-Control": "no-store" });
    }
    const v2Offset = /^\d+$/.test(cursor) ? parseInt(cursor, 10) : 0;
    const v2Page = v2Lists.slice(v2Offset, v2Offset + limit);
    const v2Next = v2Offset + limit < v2Lists.length ? String(v2Offset + limit) : null;
    return json({
      ok: true, username: targetUsername, count: v2Page.length, lists: v2Page, orderCount: v2Lists.length,
      cursor: v2Next, done: v2Next === null,
    }, 200, { "Cache-Control": "no-store" });
  }

  let order = [];
  let hasOrderKey = false;
  if (env.CONFIGS) {
    try {
      const orderRaw = await env.CONFIGS.get(`creatorlistorder:${targetUsername}`);
      if (orderRaw) {
        hasOrderKey = true;
        const parsed = JSON.parse(orderRaw);
        order = Array.isArray(parsed.order) ? parsed.order : [];
      }
    } catch {
      order = [];
    }
  }
  const inOrderSet = new Set(order);

  const listsMap = new Map();

  await adminCreatorListsFromD1(env, url, targetUsername, hasOrderKey, inOrderSet, listsMap);

  let kvScanTruncated = false;
  if (env.CONFIGS) {
    const prefix = `creatorlist:${targetUsername}:`;
    try {
      // Bounded, and honest about being bounded.
      //
      // This was list({ limit: 1000 }) with no cursor followed by one get
      // per key, all inside one invocation -- so an account with a lot of
      // lists could spend the whole 1,000-storage-operations budget here and
      // the request would die, and anything past the first 1,000 keys was
      // silently invisible either way. D1 above is the real source for this
      // panel; this scan exists to surface records D1 does not have.
      const kvListed = await env.CONFIGS.list({ prefix, limit: ADMIN_CREATOR_LIST_KV_SCAN_MAX });
      if (kvListed && Array.isArray(kvListed.keys)) {
        if (kvListed.list_complete === false) kvScanTruncated = true;
        for (const k of kvListed.keys) {
          const slug = k.name.slice(prefix.length);
          let data = null;
          try {
            const raw = await env.CONFIGS.get(k.name);
            data = raw ? JSON.parse(raw) : null;
          } catch {
            data = null;
          }
          const inOrder = hasOrderKey ? inOrderSet.has(slug) : false;
          if (!listsMap.has(slug)) {
            listsMap.set(slug, {
              slug,
              name: data ? (data.name || "(untitled)") : "(unreadable record)",
              type: data ? (data.type || "mixed") : null,
              itemCount: data && Array.isArray(data.items) ? data.items.length : 0,
              likes: data ? (data.likes || 0) : 0,
              visibility: data ? effectiveListVisibility(data.visibility) : null,
              updatedAt: data && Number.isFinite(Number(data.updatedAt)) ? Number(data.updatedAt) : null,
              inOrder,
              url: `${url.origin}/lists/${targetUsername}/${slug}`,
            });
          } else if (data && typeof data.updatedAt === "number") {
            const existing = listsMap.get(slug);
            if (!existing.updatedAt || data.updatedAt > existing.updatedAt) {
              existing.name = data.name || existing.name;
              existing.type = data.type || existing.type;
              existing.visibility = effectiveListVisibility(data.visibility);
              if (Array.isArray(data.items)) existing.itemCount = data.items.length;
              if (typeof data.likes === "number") existing.likes = data.likes;
              existing.updatedAt = data.updatedAt;
            }
          }
        }
      }
    } catch (kvErr) {
      if (!env.DB || listsMap.size === 0) {
        return json({ ok: false, error: "Could not read this creator's lists right now." }, 500, { "Cache-Control": "no-store" });
      }
    }
  }

  const allLists = Array.from(listsMap.values());
  const offset = /^\d+$/.test(cursor) ? parseInt(cursor, 10) : 0;
  const page = allLists.slice(offset, offset + limit);
  const nextCursor = (offset + limit < allLists.length) ? String(offset + limit) : null;
  const done = nextCursor === null;
  const orderCount = hasOrderKey ? inOrderSet.size : allLists.filter((l) => l.inOrder).length;

  return json({
    ok: true,
    username: targetUsername,
    count: page.length,
    lists: page,
    orderCount,
    cursor: nextCursor,
    done,
    // True when the KV scan hit its per-invocation bound, so the panel can
    // say "this may not be all of them" rather than quietly implying it is.
    kvScanTruncated: kvScanTruncated || undefined,
  }, 200, { "Cache-Control": "no-store" });
}

// Which stored username a typed one refers to (display name or a spelling without dashes).
async function adminResolveCreatorListsUsername(env, targetUsername) {
  if (env.DB) {
    try {
      const directCheck = await env.DB.prepare(
        "SELECT 1 FROM creator_lists WHERE username = ? LIMIT 1"
      ).bind(targetUsername).first();
      if (!directCheck) {
        const altCreator = await env.DB.prepare(
          "SELECT username FROM creators WHERE username = ? OR LOWER(display_name) = ? OR REPLACE(username, '-', '') = REPLACE(?, '-', '') LIMIT 1"
        ).bind(targetUsername, targetUsername, targetUsername).first();
        if (altCreator && altCreator.username) {
          targetUsername = altCreator.username;
        } else {
          const altList = await env.DB.prepare(
            "SELECT username FROM creator_lists WHERE REPLACE(username, '-', '') = REPLACE(?, '-', '') LIMIT 1"
          ).bind(targetUsername).first();
          if (altList && altList.username) {
            targetUsername = altList.username;
          }
        }
      }
    } catch (dbErr) {
      console.error("D1 username resolution error in creator-lists:", dbErr);
    }
  }
  return targetUsername;
}

// The creator's lists as D1 holds them, added to listsMap by slug.
async function adminCreatorListsFromD1(env, url, targetUsername, hasOrderKey, inOrderSet, listsMap) {
  if (env.DB) {
    try {
      const d1Res = await env.DB.prepare(`
            SELECT id, username, name, type, visibility, likes, created_at, updated_at, sort_order,
                   CASE WHEN json_valid(items_json) THEN json_array_length(items_json) ELSE 0 END AS item_count
            FROM creator_lists
            WHERE username = ?
            ORDER BY CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END, sort_order ASC, created_at ASC
          `).bind(targetUsername).all();
      const rows = (d1Res && d1Res.results) ? d1Res.results : [];
      for (const r of rows) {
        const slug = r.id.startsWith(`${targetUsername}:`)
          ? r.id.slice(targetUsername.length + 1)
          : (r.id.includes(":") ? r.id.split(":").slice(1).join(":") : r.id);
        const inOrder = hasOrderKey
          ? inOrderSet.has(slug)
          : (r.sort_order !== null && r.sort_order !== undefined);
        listsMap.set(slug, {
          slug,
          name: r.name || "(untitled)",
          type: r.type || "mixed",
          itemCount: Number(r.item_count) || 0,
          likes: Number(r.likes) || 0,
          visibility: effectiveListVisibility(r.visibility),
          updatedAt: Number.isFinite(Number(r.updated_at)) && Number(r.updated_at) > 0 ? Number(r.updated_at) : null,
          inOrder,
          url: `${url.origin}/lists/${targetUsername}/${slug}`,
        });
      }
    } catch (d1Err) {
      console.error("D1 creator_lists read error in /admin/api/creator-lists:", d1Err);
    }
  }
}

// /admin/api/delete-creator-list  (POST)  { username, slugs: [...] }
//   -> { ok, deleted: [...], missing: [...], remaining }
// Admin-only removal of one creator's lists, for cleaning up content the
// owner cannot or will not remove themselves -- and, in particular, for
// clearing PHANTOM directory entries: a list whose index entry survived
// but whose record is gone advertises an item count and then 404s when
// opened, and until now there was no way to get rid of one at all. Slugs
// whose record has already vanished still come out of the index, and are
// reported back under `missing` rather than treated as an error.
//
// Deliberately per-list rather than per-creator: "delete this account's
// lists" is what /api/creator/delete-account already does, with the
// account's own key. This is a scalpel, and it is irreversible -- there is
// no undo and no backup of a deleted list.
//
// Goes through the same deleteCreatorLists the creator's own delete route
// uses, so an admin deletion cannot clean up differently (or less
// thoroughly) than the owner's does.
async function adminApiDeleteCreatorList(request, env) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" });
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const v = validateCreatorUsername(body.username);
  if (!v.ok) return json({ ok: false, error: "Invalid username." }, 400);

  // Accepts one slug or many; both shapes end up as a bounded list.
  const rawSlugs = Array.isArray(body.slugs)
    ? body.slugs
    : (body.slug ? [body.slug] : []);
  const slugs = [...new Set(
    rawSlugs.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean)
  )];
  if (!slugs.length) return json({ ok: false, error: "No slugs given." }, 400);
  if (slugs.length > ADMIN_LIST_DELETE_MAX) {
    return json({
      ok: false,
      error: `Too many lists in one request (limit ${ADMIN_LIST_DELETE_MAX}). Send them in batches.`,
    }, 413);
  }

  const result = await deleteCreatorLists(env, v.normalized, slugs);
  // How many that creator has left, so the caller can tell when a
  // multi-batch cleanup is finished without guessing.
  let remaining = null;
  try {
    if (env.DB && isV2ListsOnly(env)) {
      remaining = await listsV2CountLists(env, v.normalized);
    } else if (env.DB) {
      const countRow = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM creator_lists WHERE username = ?"
      ).bind(v.normalized).first();
      remaining = countRow ? Number(countRow.n) || 0 : 0;
    } else if (env.CONFIGS) {
      const listed = await listAllKeys(env.CONFIGS, `creatorlist:${v.normalized}:`, 1000);
      remaining = listed.keys.length;
    }
  } catch (e) {
    remaining = null;
  }
  // Same rule as the creator-facing sibling: a sweep that left the record
  // or the directory entry behind is not a deletion, and an admin
  // clearing something up is the last person who should be told it
  // worked when it did not. `deleted` is still reported so a partial
  // batch is legible.
  if (!result.ok) {
    return json({
      ok: false,
      error: "Couldn't finish deleting those lists. Some may still be visible -- please try again in a moment.",
      username: v.normalized,
      deleted: result.deleted,
      missing: result.missing,
      remaining,
    }, 500, { "Cache-Control": "no-store" });
  }
  return json({
    ok: true,
    username: v.normalized,
    deleted: result.deleted,
    missing: result.missing,
    remaining,
  }, 200, { "Cache-Control": "no-store" });
}

// /admin/api/schema-status  (GET)
//   -> { ok, bound, checked, missing: [...], pendingMigrations: [...] }
//
// Answers "is this Worker running ahead of its database", which nothing
// could answer before. A migration is applied by hand (see the README),
// nothing records that it happened, and the Worker degrades quietly when
// one is missing rather than refusing to start -- so the only way an
// operator learned they had skipped one was by noticing the behaviour it
// was supposed to provide had never worked.
async function adminApiSchemaStatus(request, env) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  const status = await checkD1Schema(env);
  // The directory index also silently truncates.
  //
  // writePublicListIndex keeps the PUBLIC_INDEX_MAX highest-liked entries
  // and drops the tail -- the right entries to drop, but nothing anywhere
  // said it had happened, so a deployment past the cap would simply stop
  // advertising its least popular lists with no signal at all. This panel
  // already exists to answer "is something quietly not working", so the
  // count goes here.
  let publicIndex = null;
  try {
    if (env && env.DB) {
      let count = 0;
      try {
        // Account-owned lists only: legacy anonymous lists are not listed
        // (docs/DECISIONS.md D-6).
        const row = await env.DB.prepare(`
              SELECT count(*) AS cnt FROM creator_lists WHERE visibility = 'public'
            `).first();
        count = row ? Number(row.cnt || 0) : 0;
      } catch {
        // In case tables do not exist yet
      }
      publicIndex = {
        entries: count,
        max: PUBLIC_INDEX_MAX,
        truncated: count >= PUBLIC_INDEX_MAX,
        updatedAt: Date.now(),
        shards: 0,
        d1: true,
      };
    } else if (env && env.CONFIGS) {
      const raw = await env.CONFIGS.get("index:publiclists");
      if (raw) {
        const parsed = JSON.parse(raw);
        const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
        publicIndex = {
          entries: entries.length,
          max: PUBLIC_INDEX_MAX,
          truncated: entries.length >= PUBLIC_INDEX_MAX,
          updatedAt: parsed.updatedAt || null,
          shards: 1,
        };
      }
    }
  } catch (e) {
    console.error("schema-status: could not read public index status", e);
  }

  let databaseStats = null;
  if (env && env.DB) {
    try {
      const pageCountRow = await env.DB.prepare("PRAGMA page_count").first();
      const pageSizeRow = await env.DB.prepare("PRAGMA page_size").first();
      const pageCount = pageCountRow ? Number(Object.values(pageCountRow)[0] || 0) : 0;
      const pageSize = pageSizeRow ? Number(Object.values(pageSizeRow)[0] || 0) : 0;
      const estimatedSizeBytes = pageCount * pageSize;

      const tables = [
        "creators",
        "creator_lists",
        "published_lists",
        "source_groups",
        "stats",
        "creator_tombstones",
        "list_tombstones",
        "list_likes",
        "feedback",
        "scrobble_tokens",
        "event_meta",
        "watch_history",
        "continue_watching",
        "airing_next",
        "creator_user_lists",
        "creator_show_states",
        "creator_tracking_meta",
      ];
      const rowCounts = {};
      for (const tbl of tables) {
        try {
          const cRow = await env.DB.prepare(`SELECT count(*) AS c FROM ${tbl}`).first();
          rowCounts[tbl] = cRow ? Number(cRow.c || 0) : 0;
        } catch {}
      }
      databaseStats = {
        pageCount,
        pageSize,
        estimatedSizeBytes,
        rowCounts,
      };
    } catch (dbErr) {
      console.error("schema-status: could not read databaseStats", dbErr);
    }
  }

  return json({
    ok: true,
    bound: status.bound,
    checked: status.checked,
    upToDate: status.ok,
    error: status.error,
    missing: status.missing.map((m) => ({
      migration: m.migration, kind: m.kind, name: m.name, consequence: m.consequence,
    })),
    pendingMigrations: status.pendingMigrations,
    // The migration ledger (migrations/0014) and what this Worker needs.
    // While `behind`, API writes are refused -- see schemaWriteGate.
    ledger: (env && env.DB) ? await readSchemaLedger(env) : null,
    publicIndex,
    databaseStats,
  }, 200, { "Cache-Control": "no-store" });
}

// /admin/api/published-channels  (GET)  ?limit=&cursor=
//   -> { ok, count, channels: [...], cursor, done }
//
// The operator's view of the Explore Channels directory.
//
// Publishing a channel was owner-only with no operator path at all: if
// someone published something abusive, the only person who could take it
// down was the person who put it there. Published LISTS have had
// /admin/api/published-lists for exactly this reason; this is the same
// door for channels.
//
// Two sources, deliberately. The directory index is what the public
// actually sees and is one cheap read. The channelshare: keyspace is
// everything ever stored, listed or not -- which is where a channel that
// was published, reported, and then quietly unpublished still lives, and
// where an index write that lost a race leaves an orphan. An operator
// needs to be able to see both.
async function adminApiPublishedChannels(request, env, url) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  if (!env || !env.CONFIGS) return json({ ok: false, error: "no-storage" });
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 1), 200);
  const scope = url.searchParams.get("scope") === "all" ? "all" : "listed";

  if (scope === "listed") {
    // What the public sees: the channels rows once Explore Channels reads
    // them (P3b-8), the legacy index until then.
    const index = (await channelsV2Listings(env, null)) || (isV2ListsOnly(env) ? [] : await readPublicChannelIndex(env));
    return json({
      ok: true,
      scope,
      count: index.length,
      channels: index.slice(0, limit).map((e) => Object.assign({}, e, {
        url: `${url.origin}/channel/${e.code}`,
        listed: true,
      })),
      done: index.length <= limit,
      cursor: null,
    }, 200, { "Cache-Control": "no-store" });
  }

  const cursor = url.searchParams.get("cursor") || "";
  // FF_V2_LISTS_ONLY (P3b-9): every stored channel is a row.
  if (isV2ListsOnly(env)) {
    const offset = Math.max(0, parseInt(cursor, 10) || 0);
    const rows = await channelsV2AllRows(env, limit, offset);
    const page = rows.slice(0, limit);
    return json({
      ok: true,
      scope,
      count: page.length,
      channels: page.map((r) => ({
        code: r.public_code,
        name: r.name || "(untitled)",
        description: r.description || channelsV2Definition(r).description || "",
        owner: channelsV2OwnerName(r),
        listed: r.visibility === "public",
        itemCount: r.item_count || 0,
        likes: r.like_count || 0,
        publishedAt: r.created_at || null,
        updatedAt: r.updated_at || null,
        url: `${url.origin}/channel/${r.public_code}`,
      })),
      cursor: rows.length > limit ? String(offset + limit) : null,
      done: rows.length <= limit,
    }, 200, { "Cache-Control": "no-store" });
  }
  let listed;
  try {
    listed = await env.CONFIGS.list({ prefix: "channelshare:", limit, ...(cursor ? { cursor } : {}) });
  } catch {
    return json({ ok: false, error: "Could not read the stored channels right now." }, 500, { "Cache-Control": "no-store" });
  }
  const channels = await Promise.all((listed.keys || []).map(async (k) => {
    const code = k.name.slice("channelshare:".length);
    let record = null;
    try {
      const raw = await env.CONFIGS.get(k.name);
      record = raw ? JSON.parse(raw) : null;
    } catch {
      record = null;
    }
    if (!record) {
      return { code, name: "(unreadable record)", listed: false, url: `${url.origin}/channel/${code}` };
    }
    const channel = record.channel || {};
    return {
      code,
      name: channel.name || "(untitled)",
      description: record.description || channel.description || "",
      owner: record.owner || "",
      listed: !!record.published,
      itemCount: Array.isArray(channel.items) ? channel.items.length : 0,
      likes: Number(record.likes) || 0,
      publishedAt: record.publishedAt || null,
      updatedAt: record.updatedAt || null,
      url: `${url.origin}/channel/${code}`,
    };
  }));
  return json({
    ok: true,
    scope,
    count: channels.length,
    channels,
    cursor: listed.list_complete ? null : (listed.cursor || null),
    done: !!listed.list_complete,
  }, 200, { "Cache-Control": "no-store" });
}

// /admin/api/channel-moderate  (POST)  { code, action: "unlist"|"delete" }
//
// Two different acts, kept apart on purpose.
//
// "unlist" takes the channel out of the directory and leaves the stored
// record alone, so a link already handed out keeps working -- the same
// thing the owner's own Unpublish does, which is the right response to
// "this does not belong in a public directory".
//
// "delete" removes the record itself, so every link to it stops working.
// That is the response to content that should not exist at all, and it
// takes the like ledger with it rather than leaving one behind for
// whoever mints the same code next.
async function adminApiChannelModerate(request, env) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  if (!env || !env.CONFIGS) return json({ ok: false, error: "no-storage" });
  let body;
  try {
    body = await readJsonObject(request);
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const code = String(body.code || "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) return json({ ok: false, error: "Missing code." }, 400);
  const action = body.action === "delete" ? "delete" : "unlist";

  // FF_V2_LISTS_ONLY (P3b-9): in v2 alone, and checked the same way.
  if (isV2ListsOnly(env)) {
    let done = false;
    try {
      if (action === "delete") {
        done = await channelsV2Delete(env, code);
      } else {
        const v2 = await channelsV2Unlist(env, code, null);
        done = !v2.error || v2.status === 404;
      }
    } catch (e) {
      console.error("channels v2: takedown failed", e);
    }
    if (!done) {
      return json({ ok: false, error: "Couldn't finish that takedown. It may still be reachable -- please try again." }, 500, { "Cache-Control": "no-store" });
    }
    return json({ ok: true, action, code }, 200, { "Cache-Control": "no-store" });
  }

  // The directory row goes either way, and its removal is checked
  // rather than assumed: reporting success on a takedown that left the
  // channel advertised is the failure mode worth designing against.
  let removedFromIndex = true;
  try {
    await removePublicChannelIndex(env, code);
  } catch {
    removedFromIndex = false;
  }

  if (action === "delete") {
    try {
      await env.CONFIGS.delete(`channelshare:${code}`);
      await env.CONFIGS.delete(`channellikevoters:${code}`);
    } catch {
      return json({
        ok: false,
        error: "Couldn't finish removing that channel. It may still be reachable -- please try again.",
      }, 500, { "Cache-Control": "no-store" });
    }
    if (!removedFromIndex) {
      return json({
        ok: false,
        error: "The channel was deleted but its directory listing could not be removed. Please try again.",
      }, 500, { "Cache-Control": "no-store" });
    }
    // And its v2 copy (P3b-8), checked for the same reason.
    if (!(await channelsV2Delete(env, code))) {
      return json({
        ok: false,
        error: "The channel was deleted but its copy in the new tables could not be removed. Please try again.",
      }, 500, { "Cache-Control": "no-store" });
    }
    return json({ ok: true, action, code }, 200, { "Cache-Control": "no-store" });
  }

  let unlisted = null;
  try {
    const raw = await env.CONFIGS.get(`channelshare:${code}`);
    if (raw) {
      const record = JSON.parse(raw);
      record.published = false;
      record.updatedAt = Date.now();
      await env.CONFIGS.put(`channelshare:${code}`, JSON.stringify(record));
      unlisted = record;
    }
  } catch {
    return json({
      ok: false,
      error: "Couldn't mark that channel unlisted. Please try again.",
    }, 500, { "Cache-Control": "no-store" });
  }
  if (!removedFromIndex) {
    return json({ ok: false, error: "That channel is still listed. Please try again." }, 500, { "Cache-Control": "no-store" });
  }
  // The v2 listing goes too (P3b-8), and a failure is reported: a
  // takedown that left the channel listed there is not finished.
  if (unlisted && !(await channelsV2SyncShare(env, code, unlisted))) {
    return json({ ok: false, error: "That channel is still listed in the new tables. Please try again." }, 500, { "Cache-Control": "no-store" });
  }
  return json({ ok: true, action, code }, 200, { "Cache-Control": "no-store" });
}

// /admin/api/channel-ownerless  (POST)  { cursor?, limit?, apply?, confirm? }
//   -> { ok, apply, scanned, ownerless: [{ code, name, published, updatedAt }],
//        deleted, failed, unreadable, next, done }
// The shared channels no account owns (see 60_ownerless-channels.js). A count
// by default; with apply it deletes this batch, and only when `confirm` is the
// confirmation phrase. Run it again with `next` as `cursor` until `done`.
async function adminApiChannelOwnerless(request, env) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  let body = {};
  try {
    body = (await request.json()) || {};
  } catch {
    body = {};
  }
  const apply = body.apply === true;
  if (apply && body.confirm !== OWNERLESS_CHANNELS_CONFIRM) {
    return json({ ok: false, error: `To delete, send confirm: "${OWNERLESS_CHANNELS_CONFIRM}".` }, 400, { "Cache-Control": "no-store" });
  }
  let result;
  try {
    result = await removeOwnerlessChannels(env, { cursor: body.cursor, limit: body.limit, apply });
  } catch (e) {
    return json({ ok: false, error: safeErrorMessage(e) }, 500, { "Cache-Control": "no-store" });
  }
  return json(result, result.ok ? 200 : 400, { "Cache-Control": "no-store" });
}

// /admin/api/key-lookup-cleanup  (POST)  { cursor?, limit?, apply?, confirm? }
//   -> { ok, apply, scanned, withLegacy, cleaned, next, done }
// SEC-01: removes the old unsalted Account Key fingerprints of accounts that
// already have the peppered HMAC (see 60_key-lookup-cleanup.js). A count by
// default; with apply it cleans this batch, and only when `confirm` is the
// confirmation phrase. Run it again with `next` as `cursor` until `done`.
async function adminApiKeyLookupCleanup(request, env) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  let body = {};
  try {
    body = (await request.json()) || {};
  } catch {
    body = {};
  }
  const apply = body.apply === true;
  if (apply && body.confirm !== KEY_LOOKUP_CLEANUP_CONFIRM) {
    return json({ ok: false, error: `To delete, send confirm: "${KEY_LOOKUP_CLEANUP_CONFIRM}".` }, 400, { "Cache-Control": "no-store" });
  }
  let result;
  try {
    result = await cleanLegacyKeyLookups(env, { cursor: body.cursor, limit: body.limit, apply });
  } catch (e) {
    return json({ ok: false, error: safeErrorMessage(e) }, 500, { "Cache-Control": "no-store" });
  }
  return json(result, result.ok ? 200 : 400, { "Cache-Control": "no-store" });
}

async function adminApiMigrateDayCounts(request, env) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  if (!env || !env.CONFIGS) return json({ ok: true, done: true, keysMigratedThisCall: 0 });
  if (isV2ListsOnly(env)) {
    return json({ ok: true, done: true, keysMigratedThisCall: 0, retired: true });
  }

  const PREFIXES = ["evtcount:watched:", "evtcount:list-add:", "searchquery:"];
  const BATCH_LIMIT = 100;

  let state;
  try {
    const stateRaw = await env.CONFIGS.get("migratedaycounts:state");
    state = stateRaw ? JSON.parse(stateRaw) : { prefixIndex: 0, cursor: null };
  } catch {
    state = { prefixIndex: 0, cursor: null };
  }

  if (state.prefixIndex >= PREFIXES.length) {
    return json({ ok: true, done: true, keysMigratedThisCall: 0 });
  }

  const prefix = PREFIXES[state.prefixIndex];
  const listOpts = { prefix, limit: BATCH_LIMIT };
  if (state.cursor) listOpts.cursor = state.cursor;
  const listResult = await env.CONFIGS.list(listOpts);

  // Old per-day keys only -- the running total (:alltime) and the
  // new blob format itself (:days) share this same prefix and would
  // otherwise get misread as if "alltime" or "days" were date strings.
  const dayKeyPattern = /^\d{4}-\d{2}-\d{2}$/;
  const oldDayKeys = listResult.keys.filter((k) => {
    const rest = k.name.slice(prefix.length);
    const lastColon = rest.lastIndexOf(":");
    if (lastColon === -1) return false;
    return dayKeyPattern.test(rest.slice(lastColon + 1));
  });

  // Group by id first so a title/query with many old day-keys in this
  // batch costs one blob read-modify-write, not one per day.
  const byId = new Map(); // id -> { day: count, ... } (partial, this batch only)
  oldDayKeys.forEach((k) => {
    const rest = k.name.slice(prefix.length);
    const lastColon = rest.lastIndexOf(":");
    const id = rest.slice(0, lastColon);
    const day = rest.slice(lastColon + 1);
    if (!byId.has(id)) byId.set(id, {});
    byId.get(id)[day] = k.name; // stash the real key name for the read pass below
  });

  let keysMigratedThisCall = 0;
  await Promise.all(
    [...byId.entries()].map(async ([id, dayKeyNames]) => {
      const days = Object.keys(dayKeyNames);
      const [oldValues, existingBlobRaw] = await Promise.all([
        Promise.all(days.map((d) => env.CONFIGS.get(dayKeyNames[d]))),
        env.CONFIGS.get(`${prefix}${id}:days`),
      ]);
      let blob;
      try {
        blob = existingBlobRaw ? JSON.parse(existingBlobRaw) : {};
      } catch {
        blob = {};
      }
      days.forEach((d, i) => {
        const oldCount = parseInt(oldValues[i], 10) || 0;
        if (oldCount <= 0) return;
        // Additive, not overwrite -- if live tracking already wrote
        // something for this exact id+day since the format switch,
        // that count is just as real as the migrated one.
        blob[d] = (blob[d] || 0) + oldCount;
      });
      const dayKeysSorted = Object.keys(blob).sort();
      if (dayKeysSorted.length > 95) {
        dayKeysSorted.slice(0, dayKeysSorted.length - 95).forEach((k) => delete blob[k]);
      }
      await env.CONFIGS.put(`${prefix}${id}:days`, JSON.stringify(blob), { expirationTtl: TELEMETRY_DAY_TTL_SEC });
      await Promise.all(days.map((d) => env.CONFIGS.delete(dayKeyNames[d])));
      keysMigratedThisCall += days.length;
    })
  );

  const prefixDone = listResult.list_complete || !listResult.cursor;
  const nextState = prefixDone
    ? { prefixIndex: state.prefixIndex + 1, cursor: null }
    : { prefixIndex: state.prefixIndex, cursor: listResult.cursor };
  await env.CONFIGS.put("migratedaycounts:state", JSON.stringify(nextState));

  const done = nextState.prefixIndex >= PREFIXES.length;
  return json({ ok: true, done, keysMigratedThisCall, prefix, prefixDone });
}

// /admin/api/export-kv-to-r2  (POST) { prefix, runId?, part?, cursor? }
//   -> { ok, done, runId, part, keysExported, keysSoFar, partKey, manifestKey?, cursor? }
//
// P10-3: copies one KV prefix to the BLOBS bucket, a batch per call. The
// page calls it until done:true (Maintenance -> Export old data).
//
//   kv-archive/<prefix>/<runId>/part-00001.json.gz   one per batch
//   kv-archive/<prefix>/<runId>/manifest.json        written last
//
// Each batch is its own object, so no call reads, merges or rewrites what
// an earlier one wrote: a storage error fails that call alone, and the
// work per call does not grow with the export. A run keeps one runId from
// its first call to its last, whatever the clock does. The manifest exists
// only once every batch is written, so its presence is what "complete"
// means. Values are read as bytes and kept as text when they are UTF-8,
// as base64 otherwise (Better Poster images), with each key's expiration
// and metadata. The prefix is matched literally: "stats:*" is refused,
// because KV would look for keys starting with a star and find none.
//
// It only copies. Deleting the old data is not safe yet: see
// docs/CUTOVER.md P10-3.
async function adminApiExportKvToR2(request, env) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  if (!env || !env.CONFIGS) return json({ ok: false, error: "No KV binding." }, 500);
  if (!env.BLOBS) return json({ ok: false, error: "No R2 BLOBS binding. Cannot export." }, 500);

  let body;
  try { body = await readJsonObject(request); } catch { body = {}; }
  const prefix = typeof body.prefix === "string" ? body.prefix.trim() : "";
  if (!prefix) return json({ ok: false, error: "prefix is required." }, 400);
  if (/[*?]/.test(prefix)) {
    return json({ ok: false, error: "A prefix is matched literally: leave out the * (\"stats:\", not \"stats:*\")." }, 400);
  }
  const runId = typeof body.runId === "string" && /^[0-9TZ-]{10,30}$/.test(body.runId)
    ? body.runId
    : new Date().toISOString().replace(/[:.]/g, "-");
  const part = Number.isInteger(body.part) && body.part > 0 ? body.part : 1;
  const keysBefore = Number.isInteger(body.keysSoFar) && body.keysSoFar >= 0 ? body.keysSoFar : 0;

  const safePrefix = prefix.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "") || "_";
  const base = `kv-archive/${safePrefix}/${runId}`;
  const partKey = `${base}/part-${String(part).padStart(5, "0")}.json.gz`;

  const listOpts = { prefix, limit: 50 };
  if (body.cursor) listOpts.cursor = body.cursor;
  const listResult = await env.CONFIGS.list(listOpts);
  const listed = listResult.keys || [];

  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const entries = [];
  for (const k of listed) {
    const buf = await env.CONFIGS.get(k.name, { type: "arrayBuffer" });
    if (buf === null) continue;   // deleted since it was listed
    const entry = { key: k.name };
    try {
      entry.text = utf8.decode(buf);
    } catch {
      entry.base64 = bytesToBase64(buf);
    }
    if (k.expiration) entry.expiration = k.expiration;
    if (k.metadata !== undefined && k.metadata !== null) entry.metadata = k.metadata;
    entries.push(entry);
  }

  const cs = new CompressionStream("gzip");
  const gzipped = new Uint8Array(await new Response(
    new Blob([JSON.stringify({ prefix, runId, part, entries })]).stream().pipeThrough(cs)
  ).arrayBuffer());
  await env.BLOBS.put(partKey, gzipped, {
    httpMetadata: { contentType: "application/json", contentEncoding: "gzip" },
    customMetadata: { kvPrefix: prefix, runId, part: String(part), keyCount: String(entries.length) },
  });

  const keysSoFar = keysBefore + entries.length;
  const done = listResult.list_complete || !listResult.cursor;
  let manifestKey;
  if (done) {
    manifestKey = `${base}/manifest.json`;
    await env.BLOBS.put(manifestKey, JSON.stringify({
      prefix, runId, parts: part, keys: keysSoFar, completedAt: new Date().toISOString(),
    }), { httpMetadata: { contentType: "application/json" } });
  }
  return json({
    ok: true,
    done,
    runId,
    part,
    keysExported: entries.length,
    keysSoFar,
    partKey,
    manifestKey,
    cursor: done ? undefined : listResult.cursor,
  }, 200, { "Cache-Control": "no-store" });
}
