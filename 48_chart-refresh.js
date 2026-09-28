
// --- Chart snapshots refreshed by a job (Phase 5, P5-5) -------------------------
//
// P4-3 (42_chart-snapshots.js) serves chart rows from shared snapshots, rebuilt
// on a request once they are two hours old. This keeps them fresh off the
// request instead, so a visitor is never the one who waits:
//
//   chart.refresh (periodic, hourly): lists the snapshots in use
//   (`snap:chartuse:*`, noted by 42_ when one is served, with its recipe as
//   KV metadata) and hands them out CHART_REFRESH_PER_JOB at a time as
//   `chart.refresh-pages` jobs, or rebuilds them itself without the queue.
//   "In use" is exactly the charts, types, regions and settings someone asked
//   for in the last three days: every region an install uses, and no other.
//
//   chart.refresh-pages (plain job): rebuilds each page through its source's
//   fetcher with the shared keys (buildChartSnapshot, so an empty answer never
//   replaces a good copy). A page rebuilt less than CHART_REFRESH_MIN_AGE_MS
//   ago is left alone; one whose key no longer comes out the same (Hidden
//   Gems rotates daily) is skipped and expires by itself. The titles on the
//   first pages are passed to the BetterPosters warm-up, as the old chart
//   warm-up did.
//
// While FF_CHART_SNAPSHOTS is on, the old warm-up (prewarmSharedCatalogs, the
// cron.charts job) leaves these charts to this job and only warms MDBList.
// With it off nothing is noted as in use, this job does nothing, and the old
// warm-up does everything as before.
//
// Module level, after the Worker's exports, like 27_ onward.

const CHART_REFRESH_PER_JOB = 10;
const CHART_REFRESH_MAX_PAGES = 5000;
const CHART_REFRESH_MIN_AGE_MS = 45 * 60 * 1000;

async function listChartSnapshotUses(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.CONFIGS.list({ prefix: CHART_SNAPSHOT_USE_PREFIX, cursor });
    for (const k of page.keys || []) {
      const m = k.metadata;
      if (m && typeof m.key === "string" && m.key.startsWith(CHART_SNAPSHOT_PREFIX) && m.recipe && typeof m.recipe === "object") {
        out.push({ key: m.key, recipe: m.recipe });
      }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor && out.length < CHART_REFRESH_MAX_PAGES);
  return out.slice(0, CHART_REFRESH_MAX_PAGES);
}

// Rebuilds one page. Resolves to "built", "kept" (came back empty: the last
// copy stays), "fresh", "moved" or "unknown". Throws when the fetcher does.
async function refreshChartSnapshotPage(env, key, recipe, ctx, posterIds) {
  const source = typeof catalogSourceByName === "function" ? catalogSourceByName(recipe.s) : null;
  if (!source || source.kind !== "chart" || !source.snapshot || typeof recipe.u !== "string") return "unknown";
  const ref = resolveSourceRef(recipe.u);
  if (!ref || ref.source !== source.name) return "unknown";
  const page = {
    entry: { type: recipe.t || "movie" },
    skip: Number(recipe.k) || 0,
    keys: { env, ctx, region: recipe.r || undefined, hideNonDigitalReleases: !!recipe.d },
  };
  if (chartSnapshotKey(source, ref, page) !== key) return "moved";
  let previous = null;
  try {
    const raw = await env.CONFIGS.get(key, "json");
    if (raw && Array.isArray(raw.items) && Number.isFinite(raw.builtAt)) previous = raw;
  } catch {
    previous = null;
  }
  if (previous && Date.now() - previous.builtAt < CHART_REFRESH_MIN_AGE_MS) return "fresh";
  const built = await buildChartSnapshot(source, ref, page, key, previous);
  const fresh = built.snap && built.snap !== previous;
  if (fresh && !page.skip && Array.isArray(posterIds) && typeof betterPostersImdbId === "function") {
    for (const m of built.snap.items) {
      const id = betterPostersImdbId(m);
      if (id) posterIds.push(id);
    }
  }
  return fresh ? "built" : "kept";
}

async function refreshChartSnapshotPages(env, entries, ctx) {
  const out = { pages: 0, built: 0, kept: 0, fresh: 0, moved: 0, unknown: 0, failed: 0 };
  const posterIds = [];
  for (const e of entries || []) {
    if (!e || typeof e.key !== "string" || !e.recipe) continue;
    out.pages++;
    try {
      out[await refreshChartSnapshotPage(env, e.key, e.recipe, ctx, posterIds)]++;
    } catch (err) {
      out.failed++;
      console.warn(`[Jobs] chart.refresh: ${e.key}: ${jobErrorText(err)}`);
    }
  }
  if (posterIds.length && typeof rememberSharedPosterIds === "function") {
    try {
      await rememberSharedPosterIds(env, posterIds);
    } catch {
      // Poster warming is a nicety.
    }
  }
  return out;
}

async function runChartRefresh(env, job = {}) {
  if (!env || !env.CONFIGS || !isChartSnapshotsEnabled(env)) return { pages: 0 };
  const uses = await listChartSnapshotUses(env);
  const chunks = [];
  for (let i = 0; i < uses.length; i += CHART_REFRESH_PER_JOB) chunks.push(uses.slice(i, i + CHART_REFRESH_PER_JOB));
  if (chunks.length && jobsQueueBound(env)) {
    const sent = await enqueueJobs(env, chunks.map((c) => ({ type: "chart.refresh-pages", payload: { entries: c } })));
    if (sent.ok) return { pages: uses.length, jobs: chunks.length, queued: true };
    console.warn(`[Jobs] chart.refresh: ${sent.failed} jobs not sent (${sent.reason}); refreshing here.`);
  }
  return refreshChartSnapshotPages(env, uses, job.ctx);
}

definePeriodicJob("chart.refresh", {
  everyMs: 60 * 60 * 1000,
  run: (env, payload, job) => runChartRefresh(env, job),
});

defineJobType("chart.refresh-pages", {
  run: (env, payload, job) => refreshChartSnapshotPages(env, Array.isArray(payload.entries) ? payload.entries : [], job.ctx),
});
