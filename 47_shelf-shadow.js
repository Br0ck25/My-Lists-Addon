
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
    cw: { legacy: 0, v2: 0, both: 0, legacyOnly: 0, v2Only: 0, unknown: 0 },
    an: { legacy: 0, v2: 0, both: 0, legacyOnly: 0, v2Only: 0, unknown: 0 },
    examples: [],
  };
}

function shelfShadowRate(t) {
  const diff = t.cw.legacyOnly + t.cw.v2Only + t.an.legacyOnly + t.an.v2Only;
  const all = t.cw.both + t.an.both + diff;
  return all ? diff / all : 0;
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
  const [cw, an] = await Promise.all([continueWatching(env, account.id, { now }), airingNext(env, account.id, { now })]);
  const ids = await shelfShadowMediaIds(env, [...legacyCw, ...legacyAn].map((i) => i && (i.showId || i.id)));
  // A show the schedule does not know yet is left out of both sides.
  const unknown = new Set([...(cw.missingSchedule || []), ...(an.missingSchedule || [])].map((m) => `m${m}`));
  const known = (k) => k && !unknown.has(k.split(":")[0]);
  const cwDiff = shelfShadowDiff(legacyCw.map((i) => shelfShadowCwKey(i, ids)).filter(known), cw.items.map((i) => shelfShadowCwKey(i, ids)));
  const anDiff = shelfShadowDiff(legacyAn.map((i) => shelfShadowAnKey(i, ids)).filter(known), an.items.map((i) => shelfShadowAnKey(i, ids)));
  cwDiff.unknown = (cw.missingSchedule || []).length;
  anDiff.unknown = (an.missingSchedule || []).length;
  return { cw: cwDiff, an: anDiff };
}

async function runShelfShadow(env, job = {}) {
  if (!env || !env.DB || typeof activityDbs !== "function" || !activityDbs(env).length) return { progress: job.progress || {}, skipped: "no activity database" };
  const progress = { ...(job.progress || {}) };
  const round = progress.round || shelfShadowEmpty();
  const afterId = Number(progress.afterId) || 0;
  let accounts;
  try {
    ({ results: accounts } = await env.DB.prepare(
      `SELECT a.id, a.username FROM jobs j JOIN accounts a ON a.id = j.account_id
       WHERE j.type = ? AND j.status = 'done' AND j.account_id > ? ORDER BY j.account_id LIMIT ?`
    ).bind(ACTIVITY_BACKFILL_TYPE, afterId, SHELF_SHADOW_ACCOUNTS).all());
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
      if ((d.legacyOnly.length || d.v2Only.length) && round.examples.length < SHELF_SHADOW_EXAMPLES) {
        round.examples.push({ accountId: account.id, shelf, legacyOnly: d.legacyOnly.slice(0, 5), v2Only: d.v2Only.slice(0, 5) });
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
  if (!accounts || accounts.length < SHELF_SHADOW_ACCOUNTS) {
    // The round is over: keep its totals, start the next one.
    return { progress: { afterId: 0, round: shelfShadowEmpty(), last: { ...round, rate: shelfShadowRate(round), finishedAt: Date.now() } } };
  }
  return { progress: { ...progress, afterId: lastId, round } };
}

definePeriodicJob("shelf.shadow", {
  everyMs: 60 * 60 * 1000,
  run: (env, payload, job) => runShelfShadow(env, job),
});
