// Admin dashboard API, part 2 (/admin/api/feedback ... /channel-presets/rebuild), moved out of handleFetch (CQ-01).

// Moved unchanged: each route body is now its own function; the dispatcher keeps each route's
// original path/method test. Every route still checks isAdminRequest itself, as before.

// The /admin/api/ routes of part 2, in their original order. Returns a Response, or null when none matched.
async function handleAdminApiFeedbackAndToolsRoutes(request, env, ctx, url, path) {
  if (path === "/admin/api/feedback" && request.method === "GET") return adminApiFeedback(request, env);
  if (path === "/admin/api/feedback/reply" && request.method === "POST") return adminApiFeedbackReply(request, env);
  if (path === "/admin/api/feedback/status" && request.method === "POST") return adminApiFeedbackStatus(request, env);
  if (path === "/admin/api/feedback/edit" && request.method === "POST") return adminApiFeedbackEdit(request, env);
  if (path === "/admin/api/feedback/delete" && request.method === "POST") return adminApiFeedbackDelete(request, env);
  if (path === "/admin/api/support-emails/threads" && request.method === "GET") return adminApiSupportEmailsThreads(request, env, path);
  if (path === "/admin/api/support-emails/thread" && request.method === "GET") return adminApiSupportEmailsThread(request, env, path);
  if (path === "/admin/api/support-emails/reply" && request.method === "POST") return adminApiSupportEmailsReply(request, env, path);
  if (path === "/admin/api/support-emails/compose" && request.method === "POST") return adminApiSupportEmailsCompose(request, env, path);
  if (path === "/admin/api/support-emails/status" && request.method === "POST") return adminApiSupportEmailsStatus(request, env, path);
  if (path === "/admin/api/support-emails/delete" && request.method === "POST") return adminApiSupportEmailsDelete(request, env, path);
  if (path === "/admin/api/analytics" && request.method === "GET") return adminApiAnalytics(request, env, ctx, url);
  if (path === "/admin/api/apiusage" && request.method === "GET") return adminApiApiusage(request, env);
  if (path === "/admin/api/support-goal" && (request.method === "GET" || request.method === "POST")) return adminApiSupportGoal(request, env, url);
  if (path === "/admin/api/site-notice" && (request.method === "GET" || request.method === "POST")) return adminApiSiteNotice(request, env);
  if (path === "/admin/api/new-on-streaming" && request.method === "GET") return adminApiNewOnStreaming(request, env);
  if (path === "/admin/api/new-on-streaming/sweep" && request.method === "POST") return adminApiNewOnStreamingSweep(request, env, ctx);
  if (path === "/admin/api/new-on-streaming/preview" && request.method === "GET") return adminApiNewOnStreamingPreview(request, env, ctx, url);
  if (path === "/admin/api/new-on-streaming/add" && request.method === "POST") return adminApiNewOnStreamingAdd(request, env);
  if (path === "/admin/api/channel-presets" && request.method === "GET") return adminApiChannelPresets(request, env);
  if (path === "/admin/api/channel-presets/clear" && request.method === "POST") return adminApiChannelPresetsClear(request, env);
  if (path === "/admin/api/channel-presets/rebuild" && request.method === "POST") return adminApiChannelPresetsRebuild(request, env, ctx, url);
  return null;
}

// /admin/api/feedback -> { ok, entries } -- backs the Feedback tab,
// newest first. In D1, queries the indexed feedback table directly
// replacing the multi-page KV list scan.
async function adminApiFeedback(request, env) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  if (env && env.DB) {
    try {
      const rows = await env.DB.prepare(
        "SELECT body_json FROM feedback ORDER BY updated_at DESC LIMIT ?"
      ).bind(FEEDBACK_ADMIN_GET_CAP).all();
      if (rows && Array.isArray(rows.results) && rows.results.length > 0) {
        const entries = rows.results.map((r) => {
          try {
            const entry = JSON.parse(r.body_json);
            if (!Array.isArray(entry.messages) || !entry.messages.length) {
              entry.messages = [{
                id: `msg_init`,
                sender: entry.creatorName === "admin" ? "admin" : "user",
                senderName: entry.creatorName === "admin" ? "Admin" : (entry.creatorName || "User"),
                text: entry.message || "(Initial message)",
                timestamp: entry.createdAt || Date.now()
              }];
            }
            return entry;
          } catch {
            return null;
          }
        }).filter(Boolean);
        return json({ ok: true, entries, truncated: false }, 200, { "Cache-Control": "no-store" });
      }
    } catch (e) {
      // fall through to KV
    }
  }
  if (!env || !env.CONFIGS) return json({ ok: true, entries: [] }, 200, { "Cache-Control": "no-store" });
  let newestKeys = [];
  let cursor = undefined;
  let listComplete = false;
  let pages = 0;
  let sawMore = false;
  while (!listComplete && pages < 30) {
    const listResult = await env.CONFIGS.list({ prefix: "feedback:", limit: 1000, cursor });
    newestKeys.push(...(listResult.keys || []));
    if (newestKeys.length > FEEDBACK_ADMIN_GET_CAP) {
      newestKeys = newestKeys.slice(-FEEDBACK_ADMIN_GET_CAP);
      sawMore = true;
    }
    pages++;
    if (listResult.list_complete || !listResult.cursor) {
      listComplete = true;
    } else {
      cursor = listResult.cursor;
    }
  }
  const truncated = !listComplete || sawMore;
  const keys = newestKeys.slice().reverse();
  const entries = await Promise.all(
    keys.map(async (k) => {
      try {
        const raw = await env.CONFIGS.get(k.name);
        if (!raw) return null;
        const entry = JSON.parse(raw);
        if (!Array.isArray(entry.messages) || !entry.messages.length) {
          entry.messages = [{
            id: `msg_init`,
            sender: "user",
            senderName: entry.creatorName || "User",
            text: entry.message || "(Initial message)",
            timestamp: entry.createdAt || Date.now()
          }];
        }
        return entry;
      } catch {
        return null;
      }
    })
  );
  return json({ ok: true, entries: entries.filter(Boolean), truncated: !!truncated }, 200, { "Cache-Control": "no-store" });
}

// /admin/api/feedback/reply  (POST)  { id, message } -> { ok, entry }
// Allows admin to send a threaded reply back to the user.
async function adminApiFeedbackReply(request, env) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  if (!env || (!env.CONFIGS && !env.DB)) return json({ ok: false, error: "Feedback storage isn't configured on this deployment." });
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const id = String(body.id || "").trim();
  const message = String(body.message || "").trim();
  if (!id) return json({ ok: false, error: "Missing thread id." }, 400);
  if (!message) return json({ ok: false, error: "Reply message can't be empty." }, 400);

  const key = `feedback:${id}`;
  let entry = null;
  if (env && env.DB) {
    try {
      const row = await env.DB.prepare("SELECT body_json FROM feedback WHERE id = ?").bind(id).first();
      if (row && row.body_json) entry = JSON.parse(row.body_json);
    } catch {}
  }
  if (!entry && env && env.CONFIGS) {
    const raw = await env.CONFIGS.get(key);
    if (raw) {
      try {
        entry = JSON.parse(raw);
      } catch {
        return json({ ok: false, error: "Could not parse feedback thread." }, 500);
      }
    }
  }
  if (!entry) return json({ ok: false, error: "Feedback thread not found." }, 404);

  if (!Array.isArray(entry.messages) || !entry.messages.length) {
    entry.messages = [{
      id: `msg_init`,
      sender: entry.creatorName === "admin" ? "admin" : "user",
      senderName: entry.creatorName === "admin" ? "Admin" : (entry.creatorName || "User"),
      text: entry.message || "(Initial message)",
      timestamp: entry.createdAt || Date.now()
    }];
  }

  const replyMsg = {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    sender: "admin",
    senderName: "Developer",
    text: message,
    timestamp: Date.now()
  };
  entry.messages.push(replyMsg);
  entry.updatedAt = Date.now();
  entry.status = "replied";
  entry.completed = false;

  try {
    await putFeedbackThread(env, key, entry);
  } catch (e) {
    return json({ ok: false, error: safeErrorMessage(e, "Could not save reply.") }, 500);
  }
  return json({ ok: true, entry }, 200, { "Cache-Control": "no-store" });
}

// /admin/api/feedback/status  (POST)  { id, completed } -> { ok }
// Toggles the "completed" flag on one feedback entry.
async function adminApiFeedbackStatus(request, env) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  if (!env || (!env.CONFIGS && !env.DB)) return json({ ok: false, error: "Feedback storage isn't configured on this deployment." });
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const id = String(body.id || "").trim();
  if (!id) return json({ ok: false, error: "Missing id." }, 400);
  const key = `feedback:${id}`;
  let entry = null;
  if (env && env.DB) {
    try {
      const row = await env.DB.prepare("SELECT body_json FROM feedback WHERE id = ?").bind(id).first();
      if (row && row.body_json) entry = JSON.parse(row.body_json);
    } catch {}
  }
  if (!entry && env && env.CONFIGS) {
    const raw = await env.CONFIGS.get(key);
    if (raw) {
      try {
        entry = JSON.parse(raw);
      } catch {
        return json({ ok: false, error: "Could not read that feedback entry." }, 500);
      }
    }
  }
  if (!entry) return json({ ok: false, error: "That feedback entry no longer exists." }, 404);
  entry.completed = !!body.completed;
  if (entry.completed) entry.status = "closed";
  else if (entry.status === "closed") entry.status = "open";
  try {
    await putFeedbackThread(env, key, entry);
  } catch (e) {
    return json({ ok: false, error: safeErrorMessage(e, "Could not save that change. Please try again.") }, 500);
  }
  return json({ ok: true }, 200, { "Cache-Control": "no-store" });
}

// /admin/api/feedback/edit  (POST)  { id, message, category } -> { ok, entry }
// Allows the admin to edit the message or category of any feedback entry.
async function adminApiFeedbackEdit(request, env) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  if (!env || (!env.CONFIGS && !env.DB)) return json({ ok: false, error: "Feedback storage isn't configured on this deployment." });
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const id = String(body.id || "").trim();
  if (!id) return json({ ok: false, error: "Missing id." }, 400);
  const key = `feedback:${id}`;
  let entry = null;
  if (env && env.DB) {
    try {
      const row = await env.DB.prepare("SELECT body_json FROM feedback WHERE id = ?").bind(id).first();
      if (row && row.body_json) entry = JSON.parse(row.body_json);
    } catch {}
  }
  if (!entry && env && env.CONFIGS) {
    const raw = await env.CONFIGS.get(key);
    if (raw) {
      try {
        entry = JSON.parse(raw);
      } catch {
        return json({ ok: false, error: "Could not read that feedback entry." }, 500);
      }
    }
  }
  if (!entry) return json({ ok: false, error: "That feedback entry no longer exists." }, 404);
  if (typeof body.message === "string" && body.message.trim()) {
    const trimmedMessage = body.message.trim().slice(0, 4000);
    entry.message = trimmedMessage;
    if (Array.isArray(entry.messages) && entry.messages.length && entry.messages[0]) {
      entry.messages[0].text = trimmedMessage;
    }
  }
  if (typeof body.category === "string" && ["bug", "improvement", "idea", "other"].includes(body.category.trim())) {
    entry.category = body.category.trim();
  }
  entry.updatedAt = Date.now();
  try {
    await putFeedbackThread(env, key, entry);
    return json({ ok: true, entry }, 200, { "Cache-Control": "no-store" });
  } catch (e) {
    return json({ ok: false, error: safeErrorMessage(e, "Could not save edits. Please try again.") }, 500);
  }
}

// /admin/api/feedback/delete (POST) { id } -> { ok }
// Allows the admin to permanently delete a feedback entry from storage.
async function adminApiFeedbackDelete(request, env) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  if (!env || (!env.CONFIGS && !env.DB)) return json({ ok: false, error: "Feedback storage isn't configured on this deployment." });
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const id = String(body.id || "").trim();
  if (!id) return json({ ok: false, error: "Missing id." }, 400);
  const key = `feedback:${id}`;
  if (env && env.DB) {
    try {
      await env.DB.prepare("DELETE FROM feedback WHERE id = ?").bind(id).run();
    } catch (dbErr) {
      console.error("D1 write error (feedback delete):", dbErr);
    }
  }
  try {
    if (env && env.CONFIGS) {
      await env.CONFIGS.delete(key);
    }
    return json({ ok: true }, 200, { "Cache-Control": "no-store" });
  } catch (e) {
    return json({ ok: false, error: "Could not delete feedback entry. Please try again." }, 500);
  }
}

// /admin/api/support-emails/* -> Customer support email management (59_support-emails.js)
async function adminApiSupportEmailsThreads(request, env, path) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return jsonUnauthorized();
  return handleSupportEmailsApi(path, request, env);
}

async function adminApiSupportEmailsThread(request, env, path) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return jsonUnauthorized();
  return handleSupportEmailsApi(path, request, env);
}

async function adminApiSupportEmailsReply(request, env, path) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return jsonUnauthorized();
  return handleSupportEmailsApi(path, request, env);
}

async function adminApiSupportEmailsCompose(request, env, path) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return jsonUnauthorized();
  return handleSupportEmailsApi(path, request, env);
}

async function adminApiSupportEmailsStatus(request, env, path) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return jsonUnauthorized();
  return handleSupportEmailsApi(path, request, env);
}

async function adminApiSupportEmailsDelete(request, env, path) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return jsonUnauthorized();
  return handleSupportEmailsApi(path, request, env);
}

// /admin/api/analytics?section=search|catalogs_lists|audience&window=...
// Backs the Search, Catalogs & Lists, and Playback & Audience tabs in the admin dashboard.
async function adminApiAnalytics(request, env, ctx, url) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  const section = url.searchParams.get("section") || "search";
  if (section === "search") {
    const windowParam = url.searchParams.get("window") || "7";
    const searches = await computeSearchLeaderboard(env, windowParam);
    return json({ ok: true, searches }, 200, { "Cache-Control": "no-store" });
  }
  if (section === "catalogs_lists") {
    const data = await computeCatalogAndCommunityLeaderboards(env, ctx);
    return json({ ok: true, ...data }, 200, { "Cache-Control": "no-store" });
  }
  if (section === "audience") {
    const data = await computeAudienceAnalytics(env);
    return json({ ok: true, ...data }, 200, { "Cache-Control": "no-store" });
  }
  return json({ ok: false, error: "Invalid section." }, 400);
}

// /admin/api/apiusage -> { ok, keys: [{ name, label, configured, last24h,
// last7d, last30d, limit }] } -- backs the API Usage tab. Only counts
// requests that used one of this Worker's own shared keys (the
// fallback used when a visitor hasn't supplied a personal one, see
// trackSharedApiUse in 05_catalog-core.js and its call sites) -- a
// visitor's own key is never counted here since only they can exhaust
// its rate limit. Day-bucketed the same way as every other stat in
// this file (see bumpStat/loadStatsByDay), so "last 24h" really means
// "today's Eastern-calendar-day bucket", same as the Trending tab's
// "Today" window.
async function adminApiApiusage(request, env) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  const defs = [
    { name: "tmdb", label: "TMDB (TMDB_API_KEY)", envVar: "TMDB_API_KEY", limit: "~40 req/sec per IP -- no published daily cap" },
    { name: "trakt", label: "Trakt (TRAKT_CLIENT_ID)", envVar: "TRAKT_CLIENT_ID", limit: "1,000 GET calls / 5 min" },
    { name: "simkl", label: "Simkl (SIMKL_CLIENT_ID)", envVar: "SIMKL_CLIENT_ID", limit: "10 req/sec (GET)" },
    { name: "mdblist", label: "MDBList (MDBLIST_API_KEY)", envVar: "MDBLIST_API_KEY", limit: "1,000/day (free tier -- higher on paid plans)" },
    { name: "mdblistpopular", label: "MDBList Popular Lists (MDBLIST_POPULAR_KEY)", envVar: "MDBLIST_POPULAR_KEY", limit: "1,000/day (free tier -- higher on paid plans)" },
  ];
  const nowMs = Date.now();
  const keys = await Promise.all(defs.map(async (d) => {
    const byDay = await loadStatsByDay(env, `apiuse:${d.name}`);
    let last24h = 0, last7d = 0, last30d = 0;
    for (let i = 0; i < 30; i++) {
      const count = byDay[easternDateKeyDaysAgo(nowMs, i)] || 0;
      if (i < 1) last24h += count;
      if (i < 7) last7d += count;
      last30d += count;
    }
    return { name: d.name, label: d.label, configured: !!(env && env[d.envVar]), last24h, last7d, last30d, limit: d.limit };
  }));
  // no-store -- see /admin/api/feedback's own comment on why every
  // admin JSON endpoint needs this (json()'s default lets the browser
  // silently reuse an hour-old response instead of refetching).
  return json({ ok: true, keys }, 200, { "Cache-Control": "no-store" });
}

// --- New on Streaming admin routes ---------------------------------------
//
// What the sweep has actually collected, a way to push it along without
// waiting out the cron, and a preview that reads through the SAME
// fetchNewOnStreaming the add-on serves, so what the dashboard shows is
// what Stremio would get rather than a second implementation that can
// drift from it.

// /admin/api/new-on-streaming -> the sweep's own state: cursor position,
// walk generation, rows per service, and how much of it is seeded (dated
// by the title's release because the first walk had nothing to compare
// against) versus observed (a genuine arrival this add-on watched happen).
// The seeded/observed split is the one number that says whether the list
// is working yet: observed only starts growing after walk 0 completes.
// /admin/api/support-goal -> the Ko-fi support strip's goal and the amount
// given so far (GET), and the save (POST). See readSupportGoal (03_admin.js).
async function adminApiSupportGoal(request, env, url) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  if (!env || !env.CONFIGS) return json({ ok: false, error: "No CONFIGS namespace is bound." });
  let stored;
  if (request.method === "POST") {
    // A save writes the whole record back, so a KV read that fails must
    // stop it, not turn into "nothing was saved" (BA-001). An unreadable
    // record can still be saved over.
    try {
      stored = await withKofiRaisedFromD1(env, shapeSupportGoal(await readSupportGoalSettings(env, { lenientParse: true })));
    } catch (e) {
      console.error("/admin/api/support-goal: could not read the saved settings", e);
      return json({ ok: false, error: "Could not read the saved settings. Try again." }, 503);
    }
    let body = {};
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400); }
    const next = applySupportGoalUpdate(stored, body);
    if (next.error) return json({ ok: false, error: next.error }, 400);
    // A typed amount is the month's total itself: with D1 bound it goes
    // where the webhook adds to it.
    if (env.DB && body && body.raised !== undefined) await setKofiRaisedInD1(env, next.value.raised);
    await env.CONFIGS.put(SUPPORT_GOAL_KEY, JSON.stringify(next.value));
    return json({ ok: true, ...publicSupportGoal(next.value), goal: next.value.goal, raised: next.value.raised, enabled: next.value.enabled }, 200, { "Cache-Control": "no-store" });
  }
  stored = await readSupportGoal(env);
  const month = supportGoalMonth();
  return json({
    ok: true, enabled: stored.enabled, goal: stored.goal, raised: stored.raisedMonth === month ? stored.raised : 0, month,
    webhookUrl: `${url.origin}/api/kofi-webhook`,
    kofiTokenSet: !!(env && env.KOFI_VERIFICATION_TOKEN),
    lastPayment: stored.lastPayment,
    lastDelivery: await readKofiLastDelivery(env),
  }, 200, { "Cache-Control": "no-store" });
}

// /admin/api/site-notice -> the message every visitor sees once per
// session: its text, buttons and on/off switch (GET), and the save (POST).
// See readSiteNotice (03_admin.js). reset:true goes back to the original.
async function adminApiSiteNotice(request, env) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  if (!env || !env.CONFIGS) return json({ ok: false, error: "No CONFIGS namespace is bound." });
  const stored = await readSiteNotice(env);
  if (request.method === "POST") {
    let body = {};
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON body." }, 400); }
    if (body && body.reset === true) {
      await env.CONFIGS.delete(SITE_NOTICE_KEY);
      return json({ ok: true, ...(await readSiteNotice(env)), defaults: DEFAULT_SITE_NOTICE }, 200, { "Cache-Control": "no-store" });
    }
    const next = applySiteNoticeUpdate(stored, body);
    if (next.error) return json({ ok: false, error: next.error }, 400);
    await env.CONFIGS.put(SITE_NOTICE_KEY, JSON.stringify(next.value));
    return json({ ok: true, ...(await readSiteNotice(env)) }, 200, { "Cache-Control": "no-store" });
  }
  return json({ ok: true, ...stored }, 200, { "Cache-Control": "no-store" });
}

async function adminApiNewOnStreaming(request, env) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  try {
    const status = await newOnStreamingStatus(env);
    return json({ ok: true, status }, 200, { "Cache-Control": "no-store" });
  } catch (err) {
    return json({ ok: false, error: safeErrorMessage(err) });
  }
}

// /admin/api/new-on-streaming/sweep -> runs sweep units right now, and
// optionally the episode re-bump with them.
//
// Bounded at 40 units because this runs inside a REQUEST, not the cron
// tick, so it spends the request's own subrequest allowance: 40 units is
// up to 840 outbound fetches against the paid plan's 10,000, and on a
// first walk (when every title needs an IMDb resolution) that ceiling is
// real rather than theoretical.
async function adminApiNewOnStreamingSweep(request, env, ctx) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    body = {};
  }
  const requested = parseInt(body && body.units, 10);
  const units = Number.isFinite(requested) ? Math.max(1, Math.min(150, requested)) : NEW_ON_STREAMING_PAGES_PER_TICK;
  const withBump = body && body.bump === true;
  const isReset = body && (body.reset === true || body.clear === true);
  const isFull = (body && body.full === true) || isReset;
  const isManual = body && body.manual === false ? false : true;
  try {
    const sweep = await sweepNewOnStreaming(env, ctx, units * NEW_ON_STREAMING_SWEEP_FETCHES, units, {
      full: isFull,
      reset: isReset,
      manual: isManual,
    });
    let bump = null;
    if (withBump) bump = await bumpNewOnStreamingEpisodes(env, ctx, NEW_ON_STREAMING_SWEEP_FETCHES * 4);
    // Counted the same way every other shared-key path is, so a
    // dashboard sweep shows up in the API Usage tab rather than looking
    // like the key spent itself.
    const spent = (sweep && sweep.units ? sweep.units : 0) + (sweep && sweep.resolved ? sweep.resolved : 0);
    if (spent > 0 && sweep.source !== "justwatch") {
      const statKey = sweep && sweep.source === "rapidapi" ? "apiuse:rapidapi" : "apiuse:tmdb";
      ctx.waitUntil(bumpStatBy(env, statKey, spent));
    }
    return json({ ok: true, sweep, bump }, 200, { "Cache-Control": "no-store" });
  } catch (err) {
    return json({ ok: false, error: safeErrorMessage(err) });
  }
}

// /admin/api/new-on-streaming/preview?type=movie&services=netflix+hulu&q=...&skip=0&limit=60
// -> exactly what a Stremio catalog request for this row returns, through
// fetchNewOnStreaming itself. `source` comes back so the url under test
// can be copied straight into a catalog row.
async function adminApiNewOnStreamingPreview(request, env, ctx, url) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  const rawType = (url.searchParams.get("type") || "").toLowerCase().trim();
  const type = rawType === "series" ? "series" : (rawType === "movie" ? "movie" : "all");
  const servicesParam = (url.searchParams.get("services") || "").trim();
  const q = (url.searchParams.get("q") || "").trim();
  const skipParam = parseInt(url.searchParams.get("skip"), 10);
  const skip = Number.isFinite(skipParam) && skipParam > 0 ? skipParam : 0;
  const limitParam = parseInt(url.searchParams.get("limit"), 10);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(100, limitParam) : 60;
  const region = (url.searchParams.get("region") || "US").trim().toUpperCase().slice(0, 2) || "US";
  const source = servicesParam ? `tmdb:new-on-streaming:${servicesParam}` : "tmdb:new-on-streaming";
  try {
    const items = await fetchNewOnStreaming({ type, url: source, name: "New on Streaming", q }, skip, { env, ctx, region, limit, wantTotal: true });
    return json({
      ok: true,
      source,
      type,
      region,
      skip,
      limit,
      totalItems: items && items.totalItems != null ? items.totalItems : null,
      items: items || [],
    }, 200, { "Cache-Control": "no-store" });
  } catch (err) {
    return json({ ok: false, error: safeErrorMessage(err) });
  }
}

// /admin/api/new-on-streaming/add -> directly add or sync a movie/series into streaming_events
async function adminApiNewOnStreamingAdd(request, env) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    body = {};
  }
  const input = String((body && body.input) || "").trim();
  const service = String((body && body.service) || "netflix").trim().toLowerCase();
  const kind = (body && body.kind === "movie") ? "movie" : "series";
  const customDate = body && body.date ? String(body.date).trim() : "";
  if (!input) return json({ ok: false, error: "Title, IMDb ID, or TMDB ID is required." }, 400);

  try {
    const result = await addOrSyncStreamingEvent(env, { input, service, kind, date: customDate });
    return json({ ok: true, result }, 200, { "Cache-Control": "no-store" });
  } catch (err) {
    return json({ ok: false, error: safeErrorMessage(err) });
  }
}

// --- Channel presets: the shared, cron-prewarmed pool behind every Quick
// Add network channel (channel:preset:v2:<networkId>, buildNetworkChannelPreset
// in 07_source-fetchers-tmdb-simkl.js) -- 24h-TTL'd, so a cache built under
// an older version of that function keeps serving its old shape (item
// count, fields) until the daily cron rotation reaches it again, which can
// take a few hours. These three routes are the point-and-click way to see
// that state and force it fresh right now, without waiting.

// /admin/api/channel-presets -> status of all CHANNEL_PRESET_NETWORKS.
async function adminApiChannelPresets(request, env) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" });
  try {
    const networks = await Promise.all(CHANNEL_PRESET_NETWORKS.map(async (net) => {
      let cached = false;
      let itemCount = 0;
      let builtAt = null;
      try {
        const raw = await env.CONFIGS.get(`channel:preset:v2:${net.id}`);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.items)) {
            cached = true;
            itemCount = parsed.items.length;
            builtAt = Number.isFinite(parsed.builtAt) ? parsed.builtAt : null;
          }
        }
      } catch (e) {}
      return { id: net.id, name: net.name, cached, itemCount, builtAt };
    }));
    return json({ ok: true, networks }, 200, { "Cache-Control": "no-store" });
  } catch (err) {
    return json({ ok: false, error: safeErrorMessage(err) });
  }
}

// /admin/api/channel-presets/clear  { networkId }  or  { all: true }
// -> deletes the cached preset(s). The very next Quick Add click (or the
// next time the cron rotation reaches that network) rebuilds it fresh --
// this never touches anyone's already-saved catalog rows, which carry
// their own small item sample as a fallback (see CHANNEL_POINTER_SAMPLE_ITEMS,
// 20_client-channel-builder.js) and keep working regardless.
async function adminApiChannelPresetsClear(request, env) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" });
  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    body = {};
  }
  const clearAll = body && body.all === true;
  const targets = clearAll
    ? CHANNEL_PRESET_NETWORKS
    : CHANNEL_PRESET_NETWORKS.filter((net) => net.id === String((body && body.networkId) || "").trim());
  if (!targets.length) return json({ ok: false, error: "Unknown network." }, 400);
  try {
    await Promise.all(targets.map((net) => env.CONFIGS.delete(`channel:preset:v2:${net.id}`)));
    return json({ ok: true, cleared: targets.map((net) => net.id) }, 200, { "Cache-Control": "no-store" });
  } catch (err) {
    return json({ ok: false, error: safeErrorMessage(err) });
  }
}

// /admin/api/channel-presets/rebuild  { networkId }
// -> forces one network's cache fresh right now, same build
// buildNetworkChannelPreset always does on a cold cache -- this just
// skips waiting for the cron rotation or the next real Quick Add click.
// One network at a time (not "rebuild all"): a single network can mean
// dozens of TMDB requests (up to CHANNEL_PRESET_DISCOVER_PAGES pages of
// shows, then seasons for each), and doing that for all 28 in one HTTP
// request risks the request itself timing out.
async function adminApiChannelPresetsRebuild(request, env, ctx, url) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" });
  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    body = {};
  }
  const net = CHANNEL_PRESET_NETWORKS.find((n) => n.id === String((body && body.networkId) || "").trim());
  if (!net) return json({ ok: false, error: "Unknown network." }, 400);
  try {
    const result = await buildNetworkChannelPreset(net.id, net.name, url.origin, { env, ctx, forceRebuild: true });
    if (!result.ok) return json({ ok: false, error: result.error }, result.status || 200);
    return json({
      ok: true,
      network: { id: net.id, name: net.name, itemCount: result.channel.items.length, builtAt: result.channel.builtAt || null },
    }, 200, { "Cache-Control": "no-store" });
  } catch (err) {
    return json({ ok: false, error: safeErrorMessage(err) });
  }
}

// The two admin routes that sit apart from the rest in handleFetch: the creator key reset
// (early, among the creator routes) and the sign-in sessions and audit log (after /admin/login).

// POST /admin/api/reset-creator-key, called where it sat among the creator routes. Returns a Response, or null.
async function handleAdminApiResetKeyRoute(request, env, ctx, url, path) {
  if (path === "/admin/api/reset-creator-key" && request.method === "POST") return adminApiResetCreatorKey(request, env);
  return null;
}

// /admin/api/reset-creator-key  (POST)  { username } -> { ok, creatorKey }
// Admin-only. There's no email or password on a Creator Profile (see
// authenticateCreator's own comment above), so a lost key can never be
// recovered -- only a hash of it is ever stored. This is a reset, not
// a recovery: it generates a brand-new key the same way signup does,
// overwrites the stored hash, and hands the plaintext key back exactly
// once, same as /api/creator/create does. The old key stops working
// the instant this runs -- anywhere it was in use (other devices,
// scrobble webhook URLs that embed it) breaks until updated with the
// new one. This endpoint has no way to confirm the requester actually
// is the creator in question; that verification is left entirely to
// the admin using it, out of band, before calling it.
async function adminApiResetCreatorKey(request, env) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  if (!env || !env.CONFIGS) return json({ ok: false, error: "no-kv" });
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }
  const v = validateCreatorUsername(body.username);
  if (!v.ok) return json({ ok: false, error: "Unknown creator." });
  const raw = await getCreator(env, v.normalized);
  if (!raw) return json({ ok: false, error: "Unknown creator." });
  let profile;
  try {
    profile = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "Could not read that creator's profile." });
  }
  const creatorKey = generateCreatorKey();
  const keyHash = await hashCreatorKey(creatorKey);

  // Same contract as /api/creator/reset-key above: D1 has to be either
  // updated or unable to answer with the old hash before KV is touched.
  // See rotateCreatorKeyHashInD1 (02_http-and-creator-utils.js).
  const d1Rotation = await rotateCreatorKeyHashInD1(env, v.normalized, keyHash);
  if (!d1Rotation.ok) {
    return json({
      ok: false,
      error: "Couldn't reset that key right now. Please try again in a moment -- the creator's existing key still works.",
    }, 503);
  }

  // The previous key must stop working on a warm isolate the instant
  // it is rotated -- see invalidateCreatorAuthMemo's own comment.
  invalidateCreatorAuthMemo();

  // Written unconditionally, not only when D1 missed. getCreator()
  // falls back to D1, so leaving KV holding an older key_hash than D1
  // means two different valid passwords for one account depending on
  // which store answers. Both stores always get the same hash.
  await env.CONFIGS.put(
    `creator:${v.normalized}`,
    JSON.stringify({ ...profile, keyHash })
  );
  await storeCreatorKeyLookup(env, creatorKey, v.normalized);
  // Signed out everywhere, for the same reason as the self-service reset.
  await revokeSessionsForUsername(env, v.normalized);
  return json({ ok: true, creatorKey }, 200, { "Cache-Control": "no-store" });
}

// /admin/api/admin-sessions, /revoke-admin-session and /audit, called where they sat after /admin/login. Returns a Response, or null.
async function handleAdminApiSessionRoutes(request, env, ctx, url, path) {
  if (path === "/admin/api/admin-sessions" && request.method === "GET") return adminApiAdminSessions(request, env);
  if (path === "/admin/api/revoke-admin-session" && request.method === "POST") return adminApiRevokeAdminSession(request, env);
  if (path === "/admin/api/audit" && request.method === "GET") return adminApiAudit(request, env, url);
  return null;
}

// /admin/api/admin-sessions  (GET) -> { ok, sessions }
// The browsers signed in to this dashboard right now. P7-2: before this,
// "who is signed in" had no answer at all -- the cookie was self-contained.
async function adminApiAdminSessions(request, env) {
  const identity = await resolveAdminIdentity(request, env);
  if (!identity) return json({ ok: false, error: "Not authorized." }, 401);
  const result = await listAdminSessions(env, 50);
  return json({ ...result, current: identity.session ? identity.session.id : null, via: identity.via }, 200, { "Cache-Control": "no-store" });
}

// /admin/api/revoke-admin-session  (POST) { id } -> { ok, revoked }
// Signs one browser out without rotating ADMIN_KEY. `all: true` signs every
// browser out, which is what a lost laptop or a shared password needs.
async function adminApiRevokeAdminSession(request, env) {
  const identity = await resolveAdminIdentity(request, env);
  if (!identity) return json({ ok: false, error: "Not authorized." }, 401);
  if (!env || !env.DB) return json({ ok: false, error: "No D1 database binding 'DB'." }, 503);
  let body = {};
  try {
    body = await request.json();
  } catch {}
  if (body && body.all === true) {
    const revoked = await revokeAllAdminSessions(env);
    await recordAdminAudit(env, request, identity.actor, "admin.session.revoke-all",
      { detail: JSON.stringify({ revoked: revoked }) }, 200);
    return json({ ok: true, revoked: revoked }, 200, { "Cache-Control": "no-store" });
  }
  const id = String((body && body.id) || "").trim();
  if (!/^[0-9a-f]{32}$/.test(id)) return json({ ok: false, error: "Unknown session." }, 400);
  const revoked = await revokeAdminSessionById(env, id);
  await recordAdminAudit(env, request, identity.actor, "admin.session.revoke",
    { target: id, detail: JSON.stringify({ id: id, revoked: revoked }) }, 200);
  return json({ ok: true, revoked: revoked, self: !!(identity.session && identity.session.id === id) }, 200, { "Cache-Control": "no-store" });
}

// /admin/api/audit?limit=100  (GET) -> { ok, entries }
// The admin audit log (P7-2, migration 0018): logins, logouts and every
// mutating admin request, newest first. Read-only; nothing here is writable
// through the API, because a log that can be edited from the same dashboard
// it records is not a log.
async function adminApiAudit(request, env, url) {
  const authed = await isAdminRequest(request, env);
  if (!authed) return json({ ok: false, error: "Not authorized." }, 401);
  const limit = parseInt(url.searchParams.get("limit") || "100", 10) || 100;
  const result = await listAdminAudit(env, limit);
  return json(result, 200, { "Cache-Control": "no-store" });
}
