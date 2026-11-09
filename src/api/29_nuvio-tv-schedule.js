// One authoritative programme schedule per channel, for the Nuvio TV Launcher.
//
// Before this, each launcher built its own timeline for a channel (seeded from
// the channel id, anchored to whenever that device first opened it), so two
// devices on one account showed different guides. Now the Worker keeps the
// schedule: a list of programmes with fixed start and end times, laid end to
// end from the channel's lineup and extended ahead of time. A launcher only
// draws it and joins the programme airing now.
//
// GET /api/nuvio-tv/schedule/:target/:channelId   (public, like /sync)
//
// What the schedule does when the channel changes:
//  - A NEW channel starts its first programme at the current five-minute mark.
//  - An EDITED channel (picks added, removed or reordered, or a rotating
//    channel's day turning over) keeps the programme airing right now exactly
//    as it was and rebuilds everything after it from the new lineup. Past
//    programmes are never rewritten.
//  - Programmes the launcher already holds stay valid: nothing is shifted.
//
// The state lives in KV (nuviotvsched:<account>:<channel>), so two requests see
// one schedule. Two requests racing on a brand-new channel can each write a
// first schedule; the last write wins and the next request reads that one.

const NUVIO_TV_SCHEDULE_PREFIX = "/api/nuvio-tv/schedule/";
const NUVIO_TV_SCHEDULE_HORIZON_MS = 26 * 60 * 60 * 1000;
const NUVIO_TV_SCHEDULE_KEEP_PAST_MS = 6 * 60 * 60 * 1000;
const NUVIO_TV_SCHEDULE_MAX_SLOTS = 150;
const NUVIO_TV_SCHEDULE_STEP_MS = 5 * 60 * 1000;
const NUVIO_TV_SCHEDULE_TTL_SEC = 14 * 24 * 60 * 60;
// How long a schedule is served as it is before the lineup is read again to
// notice an edit. Per isolate; another isolate may read it sooner.
const NUVIO_TV_SCHEDULE_RECHECK_MS = 5 * 60 * 1000;
// Used when a pick has no runtime on record (the launcher's own defaults).
const NUVIO_TV_SCHEDULE_DEFAULT_MOVIE_MIN = 100;
const NUVIO_TV_SCHEDULE_DEFAULT_EPISODE_MIN = 45;
const NUVIO_TV_SCHEDULE_CHECKED = new Map();

function nuvioTvScheduleSlotTemplate(it, payload) {
  const kind = it.kind === "movie" ? "movie" : "episode";
  const season = kind === "movie" ? null : channelItemNumber(it.season);
  const episode = kind === "movie" ? null : channelItemNumber(it.episode);
  const label = season !== null && episode !== null ? `S${season}E${episode}` : "";
  const title = kind === "movie"
    ? (it.title || it.showName || "")
    : (it.showName && label
      ? `${it.showName} · ${label}${it.epName ? " " + it.epName : ""}`
      : (it.title || it.showName || ""));
  const runtime = Number.isInteger(it.runtime) && it.runtime > 0
    ? it.runtime
    : (kind === "movie" ? NUVIO_TV_SCHEDULE_DEFAULT_MOVIE_MIN : NUVIO_TV_SCHEDULE_DEFAULT_EPISODE_MIN);
  return {
    videoId: channelItemStreamId(it),
    itemId: String(it.imdbId || ""),
    type: kind === "movie" ? "movie" : "series",
    season,
    episode,
    title,
    description: it.overview || it.description || null,
    image: it.thumbnail || it.poster || (payload && payload.poster) || null,
    runtimeMin: Math.min(Math.max(runtime, 5), 240),
  };
}

// A short fingerprint of what a lineup plays and for how long, so an edit is noticed.
function nuvioTvScheduleSignature(templates) {
  let h = 0x811c9dc5;
  const text = templates.map((t) => `${t.videoId}|${t.runtimeMin}`).join(";");
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${templates.length}:${h.toString(16)}`;
}

// The schedule after `now`, given the saved one (or null) and the lineup. Pure:
// the same inputs give the same schedule, which is what lets a test pin it down.
function planNuvioTvSchedule(prev, templates, now) {
  if (!templates.length) return prev || null;
  const sig = nuvioTvScheduleSignature(templates);
  let slots = prev && Array.isArray(prev.slots)
    ? prev.slots.filter((s) => s && s.endMs > now - NUVIO_TV_SCHEDULE_KEEP_PAST_MS)
    : [];
  let cursor = prev && Number.isInteger(prev.cursor) ? prev.cursor : 0;
  // Away for longer than the schedule covered: start again from now.
  if (slots.length && slots[slots.length - 1].endMs < now) slots = [];
  if (prev && prev.sig !== sig) {
    // The lineup changed: the programme airing now and anything before it stay;
    // what was planned after it is rebuilt from the new lineup.
    slots = slots.filter((s) => s.startMs <= now);
    cursor = 0;
  }
  while ((slots.length ? slots[slots.length - 1].endMs : 0) < now + NUVIO_TV_SCHEDULE_HORIZON_MS && slots.length < NUVIO_TV_SCHEDULE_MAX_SLOTS) {
    const template = templates[cursor % templates.length];
    cursor++;
    const startMs = slots.length
      ? slots[slots.length - 1].endMs
      : Math.floor(now / NUVIO_TV_SCHEDULE_STEP_MS) * NUVIO_TV_SCHEDULE_STEP_MS;
    slots.push({ ...template, startMs, endMs: startMs + template.runtimeMin * 60000 });
  }
  return { v: 1, sig, cursor, slots };
}

// The channel a target (an account name, install id or "default") means by channelId.
async function findNuvioTvScheduleChannel(target, wantedId, env) {
  let scope = target;
  if (target !== "default") {
    try {
      const { resolved, username } = await resolveNuvioTvTargetData(target, env);
      if (username) scope = username;
      const entries = resolved && Array.isArray(resolved.entries) ? resolved.entries : [];
      for (const e of entries) {
        if (!e || e.enabled === false) continue;
        for (const subUrl of String(e.url || "").split("\n").map((s) => s.trim()).filter(Boolean)) {
          const payload = parseChannelPayload(subUrl);
          if (payload && String(payload.channelId || e.id) === wantedId) return { payload, scope };
        }
      }
    } catch {}
  }
  const found = await findChannelEntryById(wantedId, target === "default" ? "" : target, env);
  if (found) {
    const payload = found.payload || parseChannelPayload(found.url);
    if (payload) return { payload, scope };
  }
  return null;
}

async function nuvioTvScheduleSha(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function handleNuvioTvScheduleRoute(request, env, ctx, url, path) {
  // Written as a literal startsWith so tests/route-access.test.mjs sees this route.
  if (!path.startsWith("/api/nuvio-tv/schedule/")) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ ok: false, error: "Method not allowed." }, 405, corsHeaders());
  }
  const rest = path.slice(NUVIO_TV_SCHEDULE_PREFIX.length).split("/");
  const target = safeDecodeURIComponent(rest[0] || "").trim();
  const wantedId = safeDecodeURIComponent(rest.slice(1).join("/")).trim().replace(/^channel_/, "");
  if (!target || !wantedId) return json({ ok: false, error: "Channel not found." }, 404, { ...corsHeaders(), "Cache-Control": "no-store" });

  const found = await findNuvioTvScheduleChannel(target, wantedId, env);
  if (!found) return json({ ok: false, error: "Channel not found." }, 404, { ...corsHeaders(), "Cache-Control": "no-store" });

  const key = `nuviotvsched:${found.scope}:${wantedId}`;
  const now = Date.now();
  let saved = null;
  try {
    const raw = env && env.CONFIGS ? await env.CONFIGS.get(key) : null;
    if (raw) saved = JSON.parse(raw);
  } catch {}

  const lastCheck = NUVIO_TV_SCHEDULE_CHECKED.get(key) || 0;
  const coversAhead = saved && Array.isArray(saved.slots) && saved.slots.length
    && saved.slots[saved.slots.length - 1].endMs >= now + NUVIO_TV_SCHEDULE_HORIZON_MS / 2
    && saved.slots[0].startMs <= now;
  let state = saved;
  if (!(coversAhead && now - lastCheck < NUVIO_TV_SCHEDULE_RECHECK_MS)) {
    let items = [];
    try {
      const lineup = await resolveChannelLineup(found.payload, { env, ctx, origin: url.origin, now });
      items = lineup && Array.isArray(lineup.items) ? lineup.items : [];
    } catch {}
    const templates = items.map((it) => nuvioTvScheduleSlotTemplate(it, found.payload)).filter((t) => t.videoId);
    NUVIO_TV_SCHEDULE_CHECKED.set(key, now);
    const planned = planNuvioTvSchedule(saved, templates, now);
    if (planned && JSON.stringify(planned) !== JSON.stringify(saved)) {
      state = planned;
      if (env && env.CONFIGS) {
        try { await env.CONFIGS.put(key, JSON.stringify(planned), { expirationTtl: NUVIO_TV_SCHEDULE_TTL_SEC }); } catch {}
      }
    }
  }
  if (!state || !Array.isArray(state.slots) || !state.slots.length) {
    return json({ ok: false, error: "No programmes could be planned for this channel." }, 404, { ...corsHeaders(), "Cache-Control": "no-store" });
  }
  const slots = state.slots.filter((s) => s.endMs > now - NUVIO_TV_SCHEDULE_KEEP_PAST_MS);
  const versionHash = await nuvioTvScheduleSha(JSON.stringify(slots));
  return nuvioTvSyncResponse(request, { ok: true, channelId: wantedId, versionHash, slots }, versionHash, "no-cache, no-store, must-revalidate, max-age=0");
}
