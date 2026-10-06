
// --- Shelf shadow comparison (Phase 5, P5-4, first half) ------------------------
//
// Before FF_SHOW_SCHEDULE lets Continue Watching and Airing Next be worked out
// from show_schedule (39_activity-shelves.js), the two answers are compared
// with what the legacy sweeps stored, account by account, for about a week
// (MIGRATION_PLAN.md Phase 5). Nothing a visitor sees changes: this only reads.
//
//   shelf.shadow (periodic, hourly): the next SHELF_SHADOW_ACCOUNTS accounts
//   whose history copy is done (P3c-3), after a cursor kept in the job's
//   progress. For each, the stored shelves (the tracking record, read through
//   env.CONFIGS so FF_EVENT_TRACKING's assembled record is what is compared)
//   against continueWatching() / airingNext().
//
// Items are compared by title, not by id text: a show's id is mapped to its
// `media` row, so "tt…" and "tmdb:…" for the same show agree. Continue
// Watching compares (show, season, episode); a storyline suggestion or a
// movie compares its own id. Airing Next compares the show.
//
// A round is one pass over every copied account. The finished round's totals
// (`progress.last`) are what the admin's Check jobs shows: the difference
// rate, (legacy only + new only) / everything, with a few examples. Shows the
// schedule does not know yet (missingSchedule) are counted apart, not as
// differences: they mean show.refresh (P5-3) has not reached them.
//
// Every difference also gets a reason (shelfShadowWhy): a code, counted per
// shelf in `whyOld` / `whyNew`, and a line of detail in the examples. The first
// full comparison on the live site was 20% different with nothing to say why
// (2026-10-04); "only in the old" can as well mean the stored shelf is stale
// (an episode already watched, a show that ended) as that the new one is wrong.
//
// Each account also writes one Analytics Engine point per shelf, index
// `shelf-shadow`: blobs ["shelf-shadow", "cw" | "an"], doubles [legacy, new,
// both, legacy only, new only, not known yet].
//
// Module level, after the Worker's exports, like 27_ onward.

const SHELF_SHADOW_ACCOUNTS = 50;
const SHELF_SHADOW_EXAMPLES = 10;

function shelfShadowEmpty() {
  return {
    accounts: 0,
    cw: { legacy: 0, v2: 0, both: 0, legacyOnly: 0, v2Only: 0, unknown: 0, whyOld: {}, whyNew: {}, unknownWhy: {} },
    an: { legacy: 0, v2: 0, both: 0, legacyOnly: 0, v2Only: 0, unknown: 0, whyOld: {}, whyNew: {}, unknownWhy: {} },
    examples: [],
    unknownExamples: [],
  };
}

// --- Why the schedule does not know a show yet ----------------------------------
//
// A show is "not known yet" when it has no refreshed show_schedule row
// (shelfTitles, 39_). Those shows keep their stored entry while
// FF_SHOW_SCHEDULE is on (shelfStoredForUnknown), and the legacy writers keep
// those entries current, so the writers cannot be removed (P5-4) while there
// are many. The comparison of 2026-10-06 had 26 on Continue Watching and 9 on
// Airing Next, with nothing to say why; each now gets one of:
//   movie-row        the title's media row is a movie, and only series get a
//                    schedule row (recountShowWatchers, 46_)
//   no-schedule-row  a series nobody has been counted for yet (show.watchers
//                    is daily; a play adds the row at once)
//   not-counted      the row says nobody watches it (watcher_count 0), so
//                    show.refresh never takes it
//   refresh-tried    show.refresh took it and kept no answer: TMDB failing for
//                    it, or a refresh under way
//   waiting-refresh  due, and the hourly show.refresh has not reached it
async function shelfShadowUnknownWhy(env, mediaIds, now) {
  const out = new Map();
  const ids = [...new Set((mediaIds || []).filter((m) => m != null))];
  for (let i = 0; i < ids.length; i += SHELF_JOIN_CHUNK) {
    const part = ids.slice(i, i + SHELF_JOIN_CHUNK);
    const { results } = await env.DB.prepare(
      `SELECT m.id, m.kind, m.title, m.year, m.imdb_id, m.tmdb_id, m.alt_id,
              s.media_id AS s_media, s.watcher_count, s.checked_at, s.next_check_at
       FROM media m LEFT JOIN show_schedule s ON s.media_id = m.id WHERE m.id IN (${part.map(() => "?").join(", ")})`
    ).bind(...part).all();
    for (const m of results || []) {
      const name = `${m.title || "untitled"}${m.year ? ` (${m.year})` : ""}`;
      const ids2 = [m.imdb_id, m.tmdb_id ? `tmdb:${m.tmdb_id}` : null, m.alt_id].filter(Boolean).join(", ") || "no ids";
      let why;
      if (m.kind !== "series") why = ["movie-row", `${name} is a ${m.kind || "untyped"} row (${ids2})`];
      else if (m.s_media == null) why = ["no-schedule-row", `${name} has no schedule row yet (${ids2})`];
      else if (!(Number(m.watcher_count) > 0)) why = ["not-counted", `${name}: watcher_count is 0 (${ids2})`];
      else if (Number(m.next_check_at) > now) why = ["refresh-tried", `${name}: taken by show.refresh, no answer kept, next try in ${Math.max(1, Math.round((Number(m.next_check_at) - now) / 60000))} min (${ids2})`];
      else why = ["waiting-refresh", `${name}: due since ${Math.max(0, Math.round((now - Number(m.next_check_at)) / 3600000))} h, not refreshed yet (${ids2})`];
      out.set(m.id, why);
    }
  }
  return out;
}

function shelfShadowRate(t) {
  const diff = t.cw.legacyOnly + t.cw.v2Only + t.an.legacyOnly + t.an.v2Only;
  const all = t.cw.both + t.an.both + diff;
  return all ? diff / all : 0;
}

// Differences that are the old list's own mistake, not the new one's, by the
// rules both lists share (39_activity-shelves.js):
//   already-watched     an episode offered although the history says it was watched
//   not-aired-yet       an episode offered that has not aired and has no date
//   dismissed, dropped  a show the person dismissed or dropped, still offered
//   hidden              a show the person took off Airing Next, still listed
//   no-upcoming, next-already-aired   an Airing Next entry with nothing coming
//   replaces-old-mistake   the worked-out episode standing in for one of those
// Left out of `rateNew`, and not counted as lost in the verdict.
const SHELF_SHADOW_OLD_LIST_WRONG = new Set([
  "already-watched", "not-aired-yet", "dismissed", "dropped", "hidden", "no-upcoming", "next-already-aired", "replaces-old-mistake",
]);

// What switching would do, from the round's reasons: entries only the old list
// has that are not its mistakes (lost), shows offered at another episode
// (changed, counted once, on the old side), and entries only the new list has
// (added). Shows the schedule does not know yet keep their stored entry
// (shelfStoredForUnknown), so they are not lost.
function shelfShadowVerdict(t) {
  const out = { lost: 0, changed: 0, added: 0, oldWrong: 0, lostWhy: {} };
  for (const shelf of [t.cw, t.an]) {
    for (const [code, n] of Object.entries(shelf.whyOld || {})) {
      const k = Number(n) || 0;
      if (SHELF_SHADOW_OLD_LIST_WRONG.has(code)) out.oldWrong += k;
      else if (code === "different-episode") out.changed += k;
      else {
        out.lost += k;
        out.lostWhy[code] = (out.lostWhy[code] || 0) + k;
      }
    }
    for (const [code, n] of Object.entries(shelf.whyNew || {})) {
      const k = Number(n) || 0;
      if (SHELF_SHADOW_OLD_LIST_WRONG.has(code)) out.oldWrong += k;
      else if (code !== "different-episode") out.added += k;
    }
  }
  return out;
}

function shelfShadowRateNew(t) {
  const { oldWrong } = shelfShadowVerdict(t);
  const diff = t.cw.legacyOnly + t.cw.v2Only + t.an.legacyOnly + t.an.v2Only;
  const all = t.cw.both + t.an.both + diff - oldWrong;
  return all > 0 ? (diff - oldWrong) / all : 0;
}

// Media ids for legacy show ids ("tt…", "tmdb:N", "tmdb:tv:N").
async function shelfShadowMediaIds(env, showIds) {
  const imdb = [];
  const tmdb = [];
  for (const raw of showIds) {
    const id = String(raw || "");
    if (id.startsWith("tt")) imdb.push(id.split(":")[0]);
    else if (id.startsWith("tmdb:")) {
      const n = Number(id.split(":").filter((p) => /^\d+$/.test(p))[0]);
      if (n) tmdb.push(n);
    }
  }
  const out = new Map();
  if (!imdb.length && !tmdb.length) return out;
  const { results } = await env.DB.prepare(
    `SELECT id, imdb_id, tmdb_id FROM media WHERE kind = 'series' AND (imdb_id IN (SELECT value FROM json_each(?)) OR tmdb_id IN (SELECT value FROM json_each(?)))`
  ).bind(JSON.stringify(imdb), JSON.stringify(tmdb)).all();
  for (const r of results || []) {
    if (r.imdb_id) out.set(r.imdb_id, r.id);
    if (r.tmdb_id) {
      out.set(`tmdb:${r.tmdb_id}`, r.id);
      out.set(`tmdb:tv:${r.tmdb_id}`, r.id);
    }
  }
  return out;
}

// The titles the account's progress rows name, by their ids too, so a stored
// item is matched to its media row even when shelfShadowMediaIds did not find
// it (and a show the schedule does not know yet is then recognized as such).
function shelfShadowAddTitleIds(ids, titles) {
  for (const [mediaId, t] of titles) {
    const m = t && t.media;
    if (!m) continue;
    if (m.imdb_id && !ids.has(m.imdb_id)) ids.set(m.imdb_id, mediaId);
    if (m.tmdb_id) {
      if (!ids.has(`tmdb:${m.tmdb_id}`)) ids.set(`tmdb:${m.tmdb_id}`, mediaId);
      if (!ids.has(`tmdb:tv:${m.tmdb_id}`)) ids.set(`tmdb:tv:${m.tmdb_id}`, mediaId);
    }
  }
}

function shelfShadowShowKey(showId, ids) {
  const id = String(showId || "");
  const m = ids.get(id.startsWith("tt") ? id.split(":")[0] : id);
  return m != null ? `m${m}` : `id:${id}`;
}

function shelfShadowCwKey(item, ids) {
  if (!item || typeof item !== "object") return null;
  if (item.isCompanion || item.type === "movie" || item.kind === "movie" || item.seasonNum == null) return `c:${item.id}`;
  return `${item.mediaId != null ? `m${item.mediaId}` : shelfShadowShowKey(item.showId, ids)}:${Number(item.seasonNum)}:${Number(item.episodeNum)}`;
}

function shelfShadowAnKey(item, ids) {
  if (!item || typeof item !== "object") return null;
  return item.mediaId != null ? `m${item.mediaId}` : shelfShadowShowKey(item.showId || item.id, ids);
}

function shelfShadowDiff(legacyKeys, v2Keys) {
  const a = new Set(legacyKeys.filter(Boolean));
  const b = new Set(v2Keys.filter(Boolean));
  const legacyOnly = [...a].filter((k) => !b.has(k));
  const v2Only = [...b].filter((k) => !a.has(k));
  return { legacy: a.size, v2: b.size, both: a.size - legacyOnly.length, legacyOnly, v2Only };
}

// --- Why one shelf has an item the other has not -------------------------------

function shelfShadowEp(season, episode) {
  return `S${season}E${episode}`;
}

function shelfShadowScheduleText(sched) {
  if (!sched) return "no schedule";
  const last = sched.last_aired_season != null ? `last aired ${shelfShadowEp(sched.last_aired_season, sched.last_aired_episode)}` : "nothing aired";
  const next = sched.next_season != null ? `next ${shelfShadowEp(sched.next_season, sched.next_episode)} ${sched.next_air_date || "(no date)"}` : "no next episode";
  return `${last}, ${next}${sched.season_episode_counts ? "" : ", no episode counts"}${sched.s_status ? ` (${sched.s_status})` : ""}`;
}

// What the stored entry itself says beyond its episode, and how long ago the
// schedule was last refreshed: enough to tell an entry the old list kept from
// a schedule that has not caught up.
function shelfShadowStoredText(item) {
  const bits = [];
  if (item && item.airDate) bits.push(`air date ${String(item.airDate).slice(0, 10)}`);
  if (item && item.isUnaired) bits.push("marked unaired");
  return bits.length ? ` (stored entry: ${bits.join(", ")})` : "";
}

function shelfShadowCheckedText(sched, today) {
  const at = Number(sched && sched.checked_at);
  if (!Number.isFinite(at) || at <= 1) return "";
  const days = Math.floor((Date.parse(`${today}T12:00:00Z`) - at) / 86400000);
  return days >= 1 ? `, schedule checked ${days} days ago` : ", schedule checked today";
}

function shelfShadowMediaIdOf(key) {
  const m = /^m(\d+)(?::|$)/.exec(String(key || ""));
  return m ? Number(m[1]) : null;
}

// Why a stored Continue Watching item is not on the worked-out shelf.
function shelfShadowCwWhyOld(item, key, ctx) {
  if (String(key).startsWith("c:")) {
    return ["suggestion", "a storyline suggestion or movie the activity database does not keep"];
  }
  const mediaId = shelfShadowMediaIdOf(key);
  if (mediaId == null) return ["no-title", `no media row for ${item && item.showId}`];
  const row = ctx.rows.get(mediaId);
  if (!row) return ["no-progress", "no show_progress row for the show"];
  if (row.status === "dropped") return ["dropped", "the show is marked dropped"];
  if (row.last_season == null || row.last_episode == null) return ["no-episode-progress", "show_progress has no episode"];
  // The worked-out shelf reads only the account's SHELF_PROGRESS_LIMIT most
  // recently watched shows.
  if (!ctx.served.has(mediaId)) return ["beyond-limit", `the show is not among the account's ${SHELF_PROGRESS_LIMIT} most recently watched`];
  const lastS = Number(row.last_season);
  const lastE = Number(row.last_episode);
  const S = Number(item.seasonNum);
  const E = Number(item.episodeNum);
  if (row.dismissed_at_season != null && shelfAtOrBefore(lastS, lastE, Number(row.dismissed_at_season), Number(row.dismissed_at_episode) || 0)) {
    return ["dismissed", `dismissed at ${shelfShadowEp(row.dismissed_at_season, row.dismissed_at_episode)}, progress ${shelfShadowEp(lastS, lastE)}`];
  }
  // The old list's own mistake: it offers an episode the history says was
  // watched (the ping and the webhook put the old entry back when TMDB had
  // nothing newer, fixed in Release 17).
  if (shelfAtOrBefore(S, E, lastS, lastE)) return ["already-watched", `stored ${shelfShadowEp(S, E)}, but progress is at ${shelfShadowEp(lastS, lastE)}`];
  const t = ctx.titles.get(mediaId);
  if (!t || !t.sched) return ["schedule-unknown", "the schedule does not know the show yet"];
  const next = shelfEpisodeAfter(t.sched, lastS, lastE, ctx.today);
  if (!next) {
    // An episode past the last one aired, with no date: the old list offered
    // an episode nobody can watch yet (the ping and webhook take TMDB's next
    // episode whether or not it has aired). 44 of these on 2026-10-04, most of
    // them next seasons of returning, ended or cancelled shows.
    const lastAiredS = t.sched.last_aired_season;
    const lastAiredE = t.sched.last_aired_episode;
    const notAired = lastAiredS == null || !shelfAtOrBefore(S, E, Number(lastAiredS), Number(lastAiredE) || 0);
    return [notAired ? "not-aired-yet" : "schedule-nothing-after", `nothing after ${shelfShadowEp(lastS, lastE)} (stored ${shelfShadowEp(S, E)}${shelfShadowStoredText(item)}): ${shelfShadowScheduleText(t.sched)}${shelfShadowCheckedText(t.sched, ctx.today)}`];
  }
  if (next.season !== S || next.episode !== E) return ["different-episode", `stored ${shelfShadowEp(S, E)}, worked out ${shelfShadowEp(next.season, next.episode)} after ${shelfShadowEp(lastS, lastE)}`];
  const v2 = ctx.v2Keys.cw.filter((k) => k.split(":")[0] === `m${mediaId}`);
  return ["other", `stored ${JSON.stringify({ id: item.id, showId: item.showId, seasonNum: item.seasonNum, episodeNum: item.episodeNum })}, progress ${shelfShadowEp(lastS, lastE)}, new shelf has ${v2.length ? v2.join(", ") : "nothing"} for it: ${shelfShadowScheduleText(t.sched)}`];
}

// Why a stored Airing Next show is not on the worked-out shelf.
function shelfShadowAnWhyOld(item, key, ctx) {
  const mediaId = shelfShadowMediaIdOf(key);
  if (mediaId == null) return ["no-title", `no media row for ${item && (item.showId || item.id)}`];
  const t = ctx.titles.get(mediaId);
  if (t && t.media && t.media.kind !== "series") return ["not-a-series", `media row ${mediaId} is a ${t.media.kind}`];
  const row = ctx.rows.get(mediaId);
  if (!row) return ["no-progress", "no show_progress row for the show"];
  if (row.status === "dropped") return ["dropped", "the show is marked dropped"];
  if (row.last_season == null && row.status !== "completed") return ["nothing-watched", "no episode watched"];
  if (row.airing_hidden_at_season != null) {
    const stands = row.last_season == null
      || shelfAtOrBefore(Number(row.last_season), Number(row.last_episode) || 0, Number(row.airing_hidden_at_season), Number(row.airing_hidden_at_episode) || 0);
    if (stands) return ["hidden", `removed from Airing Next at ${shelfShadowEp(row.airing_hidden_at_season, row.airing_hidden_at_episode)}`];
  }
  if (!t || !t.sched) return ["schedule-unknown", "the schedule does not know the show yet"];
  const s = t.sched;
  if (!s.next_air_date || s.next_season == null || s.next_episode == null) return ["no-upcoming", `stored ${item && item.airDate ? item.airDate : "(no date)"}: ${shelfShadowScheduleText(s)}`];
  if (shelfAired(s.next_air_date, ctx.today)) return ["next-already-aired", `${shelfShadowScheduleText(s)}, which is not after today`];
  return ["other", shelfShadowScheduleText(s)];
}

// Why the worked-out shelf has an item the stored one has not. `whyOld` is
// what was found for the stored side's own differences: a worked-out episode
// standing in for a stored one the old list had wrong is that mistake put right.
function shelfShadowWhyNew(shelf, key, ctx, whyOld = {}) {
  const show = String(key).split(":")[0];
  const stored = ctx.legacyKeys[shelf].filter((k) => k && k.split(":")[0] === show);
  if (shelf === "cw" && stored.length) {
    const codes = stored.map((k) => (whyOld[k] ? whyOld[k][0] : null)).filter(Boolean);
    if (codes.length && codes.every((c) => SHELF_SHADOW_OLD_LIST_WRONG.has(c))) {
      return ["replaces-old-mistake", `stored ${stored.join(", ")} (${codes.join(", ")})`];
    }
    return ["different-episode", `stored ${stored.join(", ")}`];
  }
  return ["not-stored", "the stored shelf does not have it"];
}

// Compares one account. Returns { cw, an } diffs, or null when it has no
// stored record to compare with.
async function compareAccountShelves(env, account, { now = Date.now() } = {}) {
  const raw = env.CONFIGS ? await env.CONFIGS.get(`creatorsynctracking:${account.username}`) : null;
  let legacy = null;
  try {
    legacy = raw ? JSON.parse(raw) : null;
  } catch {
    legacy = null;
  }
  if (!legacy || typeof legacy !== "object") return null;
  const legacyCw = Array.isArray(legacy.continueWatching) ? legacy.continueWatching : [];
  const legacyAn = Array.isArray(legacy.airingNext) ? legacy.airingNext : [];
  const [cw, an, progressRows] = await Promise.all([
    continueWatching(env, account.id, { now }),
    airingNext(env, account.id, { now }),
    shelfProgressRows(env, account.id),
  ]);
  const ids = await shelfShadowMediaIds(env, [...legacyCw, ...legacyAn].map((i) => i && (i.showId || i.id)));
  const titles = await shelfTitles(env, progressRows.map((r) => r.media_id));
  shelfShadowAddTitleIds(ids, titles);
  // A show the schedule does not know yet is left out of both sides.
  const unknown = new Set([...(cw.missingSchedule || []), ...(an.missingSchedule || [])].map((m) => `m${m}`));
  const known = (k) => k && !unknown.has(k.split(":")[0]);
  const legacyCwKeyed = legacyCw.map((i) => [shelfShadowCwKey(i, ids), i]).filter(([k]) => known(k));
  const legacyAnKeyed = legacyAn.map((i) => [shelfShadowAnKey(i, ids), i]).filter(([k]) => known(k));
  const cwDiff = shelfShadowDiff(legacyCwKeyed.map(([k]) => k), cw.items.map((i) => shelfShadowCwKey(i, ids)));
  const anDiff = shelfShadowDiff(legacyAnKeyed.map(([k]) => k), an.items.map((i) => shelfShadowAnKey(i, ids)));
  cwDiff.unknown = (cw.missingSchedule || []).length;
  anDiff.unknown = (an.missingSchedule || []).length;
  if (cwDiff.unknown || anDiff.unknown) {
    const unknownWhy = await shelfShadowUnknownWhy(env, [...(cw.missingSchedule || []), ...(an.missingSchedule || [])], now);
    cwDiff.unknownWhy = (cw.missingSchedule || []).map((m) => [m, unknownWhy.get(m) || ["no-title", "no media row"]]);
    anDiff.unknownWhy = (an.missingSchedule || []).map((m) => [m, unknownWhy.get(m) || ["no-title", "no media row"]]);
  }

  // The reasons. Progress rows beyond the shelves' own limit, and titles no
  // progress row names, are looked up for the items that need them.
  if (cwDiff.legacyOnly.length || anDiff.legacyOnly.length || cwDiff.v2Only.length || anDiff.v2Only.length) {
    const rows = new Map(progressRows.map((r) => [r.media_id, r]));
    const wanted = [...cwDiff.legacyOnly, ...anDiff.legacyOnly].map(shelfShadowMediaIdOf).filter((m) => m != null);
    const missingRows = [...new Set(wanted.filter((m) => !rows.has(m)))];
    const actDb = activityDb(env, account.id);
    for (let i = 0; actDb && i < missingRows.length; i += SHELF_JOIN_CHUNK) {
      const part = missingRows.slice(i, i + SHELF_JOIN_CHUNK);
      const { results } = await actDb.prepare(
        `SELECT * FROM show_progress WHERE account_id = ? AND media_id IN (${part.map(() => "?").join(", ")})`
      ).bind(account.id, ...part).all();
      for (const r of results || []) rows.set(r.media_id, r);
    }
    const moreTitles = await shelfTitles(env, [...new Set(wanted.filter((m) => !titles.has(m)))]);
    for (const [k, v] of moreTitles) titles.set(k, v);
    const ctx = {
      rows, titles, today: shelfToday(now),
      served: new Set(progressRows.map((r) => r.media_id)),
      legacyKeys: { cw: legacyCwKeyed.map(([k]) => k), an: legacyAnKeyed.map(([k]) => k) },
      v2Keys: { cw: cw.items.map((i) => shelfShadowCwKey(i, ids)), an: an.items.map((i) => shelfShadowAnKey(i, ids)) },
    };
    const byKey = { cw: new Map(legacyCwKeyed), an: new Map(legacyAnKeyed) };
    for (const [shelf, diff, whyOld] of [["cw", cwDiff, shelfShadowCwWhyOld], ["an", anDiff, shelfShadowAnWhyOld]]) {
      diff.why = {};
      for (const key of diff.legacyOnly) {
        try {
          diff.why[key] = whyOld(byKey[shelf].get(key) || {}, key, ctx);
        } catch (err) {
          diff.why[key] = ["error", jobErrorText(err)];
        }
      }
      for (const key of diff.v2Only) diff.why[key] = shelfShadowWhyNew(shelf, key, ctx, diff.why);
    }
  }
  return { cw: cwDiff, an: anDiff };
}

async function runShelfShadow(env, job = {}, { accounts: batchSize = SHELF_SHADOW_ACCOUNTS } = {}) {
  if (!env || !env.DB || typeof activityDbs !== "function" || !activityDbs(env).length) return { progress: job.progress || {}, skipped: "no activity database" };
  const progress = { ...(job.progress || {}) };
  const round = progress.round || shelfShadowEmpty();
  const afterId = Number(progress.afterId) || 0;
  let accounts;
  try {
    ({ results: accounts } = await env.DB.prepare(
      `SELECT a.id, a.username FROM jobs j JOIN accounts a ON a.id = j.account_id
       WHERE j.type = ? AND j.status = 'done' AND j.account_id > ? ORDER BY j.account_id LIMIT ?`
    ).bind(ACTIVITY_BACKFILL_TYPE, afterId, batchSize).all());
  } catch (err) {
    if (/no such table/i.test(jobErrorText(err))) return { progress, skipped: "no 0016" };
    throw err;
  }
  const analytics = env.ANALYTICS && typeof env.ANALYTICS.writeDataPoint === "function" ? env.ANALYTICS : null;
  let lastId = afterId;
  for (const account of accounts || []) {
    lastId = account.id;
    let diff;
    try {
      diff = await compareAccountShelves(env, account);
    } catch (err) {
      if (/no such table|no such column/i.test(jobErrorText(err))) return { progress, skipped: "no 0017 or A0001" };
      console.warn(`[Jobs] shelf.shadow: account ${account.id}: ${jobErrorText(err)}`);
      continue;
    }
    if (!diff) continue;
    round.accounts++;
    for (const shelf of ["cw", "an"]) {
      const d = diff[shelf];
      const t = round[shelf];
      t.legacy += d.legacy;
      t.v2 += d.v2;
      t.both += d.both;
      t.legacyOnly += d.legacyOnly.length;
      t.v2Only += d.v2Only.length;
      t.unknown += d.unknown;
      // A round started before the reasons existed has no tallies yet.
      t.whyOld = t.whyOld || {};
      t.whyNew = t.whyNew || {};
      t.unknownWhy = t.unknownWhy || {};
      round.unknownExamples = round.unknownExamples || [];
      for (const [mediaId, [code, text]] of d.unknownWhy || []) {
        t.unknownWhy[code] = (t.unknownWhy[code] || 0) + 1;
        if (round.unknownExamples.length < SHELF_SHADOW_EXAMPLES && !round.unknownExamples.some((e) => e.mediaId === mediaId)) {
          round.unknownExamples.push({ mediaId, shelf, why: `${code}: ${text}` });
        }
      }
      const why = d.why || {};
      for (const key of d.legacyOnly) {
        const code = (why[key] || ["other"])[0];
        t.whyOld[code] = (t.whyOld[code] || 0) + 1;
      }
      for (const key of d.v2Only) {
        const code = (why[key] || ["other"])[0];
        t.whyNew[code] = (t.whyNew[code] || 0) + 1;
      }
      if ((d.legacyOnly.length || d.v2Only.length) && round.examples.length < SHELF_SHADOW_EXAMPLES) {
        const legacyOnly = d.legacyOnly.slice(0, 5);
        const v2Only = d.v2Only.slice(0, 5);
        const example = { accountId: account.id, shelf, legacyOnly, v2Only, why: {} };
        for (const key of [...legacyOnly, ...v2Only]) {
          if (why[key]) example.why[key] = `${why[key][0]}: ${why[key][1]}`;
        }
        round.examples.push(example);
      }
      if (analytics) {
        try {
          analytics.writeDataPoint({
            blobs: ["shelf-shadow", shelf],
            doubles: [d.legacy, d.v2, d.both, d.legacyOnly.length, d.v2Only.length, d.unknown],
            indexes: ["shelf-shadow"],
          });
        } catch {
          // Metrics must never affect a job.
        }
      }
    }
  }
  if (!accounts || accounts.length < batchSize) {
    // The round is over: keep its totals, start the next one.
    return { scanned: (accounts || []).length, progress: { afterId: 0, round: shelfShadowEmpty(), last: { ...round, rate: shelfShadowRate(round), rateNew: shelfShadowRateNew(round), verdict: shelfShadowVerdict(round), finishedAt: Date.now() } } };
  }
  return { scanned: accounts.length, progress: { ...progress, afterId: lastId, round } };
}

// --- Compare now (/admin -> Maintenance -> Check jobs, Release 16) -------------
//
// The hourly job compares 50 accounts an hour, so one full comparison takes
// about 15 hours. The admin page can instead run the whole round itself, a
// batch of SHELF_SHADOW_NOW_ACCOUNTS accounts per request, carrying the round
// from one request to the next (POST /admin/api/jobs/shelf-shadow-now). It is
// the same comparison: runShelfShadow, with the round kept by the page instead
// of the jobs row. The finished round is also stored as the job's `last`, so
// Check jobs shows it; the hourly job's own round carries on untouched.
const SHELF_SHADOW_NOW_ACCOUNTS = 20;

// A round as the page sends it back: only the known fields, as numbers.
function shelfShadowRoundFrom(raw) {
  const round = shelfShadowEmpty();
  if (!raw || typeof raw !== "object") return round;
  round.accounts = Math.max(0, Number(raw.accounts) || 0);
  for (const shelf of ["cw", "an"]) {
    const from = raw[shelf] && typeof raw[shelf] === "object" ? raw[shelf] : {};
    for (const k of ["legacy", "v2", "both", "legacyOnly", "v2Only", "unknown"]) round[shelf][k] = Math.max(0, Number(from[k]) || 0);
    for (const w of ["whyOld", "whyNew", "unknownWhy"]) {
      const tally = from[w] && typeof from[w] === "object" ? from[w] : {};
      for (const [code, n] of Object.entries(tally)) {
        if (/^[a-z-]{1,40}$/.test(code) && Number(n) > 0) round[shelf][w][code] = Number(n);
      }
    }
  }
  if (Array.isArray(raw.examples)) round.examples = raw.examples.slice(0, SHELF_SHADOW_EXAMPLES);
  if (Array.isArray(raw.unknownExamples)) {
    round.unknownExamples = raw.unknownExamples.slice(0, SHELF_SHADOW_EXAMPLES)
      .filter((e) => e && typeof e === "object")
      .map((e) => ({ mediaId: Number(e.mediaId) || 0, shelf: e.shelf === "an" ? "an" : "cw", why: String(e.why || "").slice(0, 300) }));
  }
  return round;
}

async function runShelfShadowNow(env, { afterId = 0, round = null } = {}) {
  if (!env || !env.DB || typeof activityDbs !== "function" || !activityDbs(env).length) {
    return { ok: false, error: "Needs the activity database (DB_ACTIVITY)." };
  }
  const start = Math.max(0, Number(afterId) || 0);
  let total = null;
  if (!start) {
    // How many accounts the round will cover, for the page's progress line.
    try {
      const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs j JOIN accounts a ON a.id = j.account_id WHERE j.type = ? AND j.status = 'done'")
        .bind(ACTIVITY_BACKFILL_TYPE).first();
      total = row ? Number(row.n) || 0 : null;
    } catch {
      total = null;
    }
  }
  const out = await runShelfShadow(env, { progress: { afterId: start, round: shelfShadowRoundFrom(round) } }, { accounts: SHELF_SHADOW_NOW_ACCOUNTS });
  if (out.skipped) return { ok: false, error: `Not run: ${out.skipped}.` };
  const last = out.progress && out.progress.last;
  if (!last) return { ok: true, done: false, total, scanned: out.scanned, afterId: out.progress.afterId, round: out.progress.round };
  // Check jobs reads the job's `last`. Not while the hourly run is mid-way:
  // its own write at the end would replace this anyway.
  try {
    await env.DB.prepare(
      "UPDATE jobs SET progress_json = json_set(COALESCE(progress_json, '{}'), '$.last', json(?)) WHERE dedupe_key = 'periodic:shelf.shadow' AND status != 'running'"
    ).bind(JSON.stringify(last)).run();
  } catch (err) {
    console.warn(`[Jobs] shelf.shadow: could not store the comparison: ${jobErrorText(err)}`);
  }
  return { ok: true, done: true, total, scanned: out.scanned, last };
}

definePeriodicJob("shelf.shadow", {
  everyMs: 60 * 60 * 1000,
  run: (env, payload, job) => runShelfShadow(env, job),
});
