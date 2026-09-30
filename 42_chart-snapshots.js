
// --- Chart snapshots (Phase 4, P4-3) --------------------------------------------
//
// A chart (TMDB Popular, Trakt Trending, a genre or kids shelf ...) is the same
// rows for everyone who asks for it with the same settings. So one copy of each
// page is kept in KV, under
//
//   snap:chart:{source}:{chart}:{type}:{region}:{skip}[:{variant}]
//
// and every catalog request for it reads that copy:
//
//   fresh (built less than CHART_SNAPSHOT_FRESH_MS ago)  served as it is;
//   stale                                                served as it is, and
//       rebuilt in the background (at most once per CHART_SNAPSHOT_RETRY_MS per
//       isolate, so a provider that keeps failing is not asked on every request);
//   missing                                              built now, then stored.
//
// An empty result never replaces a non-empty snapshot: a chart is never really
// empty, so an empty answer is a provider fault, and keeping the last good copy
// is the whole point. An empty result is never stored at all.
//
// Which rows: the catalog sources of kind "chart" (CATALOG_SOURCES,
// 04_config-resolution.js) that name a `snapshot` rule, which says which of
// the request's settings change the rows (the region; the digital-release
// setting; the day, for Hidden Gems' daily rotation). Personal rows never do.
// This site's own charts (Most Watched, New on Streaming) are snapshots already.
//
// The snapshot holds what the fetcher returned, before the per-install steps
// in fetchCatalog (shuffle, BetterPosters, badges, the adult filter), which
// still run on every request.
//
// The fetchers keep their own caches underneath; a snapshot is built through
// them. Until the chart refresh job (P5-5), building happens here, on a
// request, as MIGRATION_PLAN Phase 4 says.
//
// Behind FF_CHART_SNAPSHOTS (off). Module level, after the Worker's exports.

const CHART_SNAPSHOT_PREFIX = "snap:chart:";
const CHART_SNAPSHOT_FRESH_MS = 2 * 60 * 60 * 1000;
// Kept this long, so an outage makes charts older, not empty.
const CHART_SNAPSHOT_KV_TTL_SEC = 7 * 24 * 60 * 60;
// How long this isolate trusts what it last read from KV for one key: other
// isolates' rebuilds reach it within this.
const CHART_SNAPSHOT_MEMO_MS = 60 * 1000;
const CHART_SNAPSHOT_MEMO_MAX = 500;
// A rebuild that failed or came back empty is not tried again sooner than this.
const CHART_SNAPSHOT_RETRY_MS = 5 * 60 * 1000;

const CHART_SNAPSHOT_MEMO = new Map();     // key -> { snap, checkedAt, triedAt }
const CHART_SNAPSHOT_BUILDING = new Map(); // key -> promise of the build

function isChartSnapshotsEnabled(env) {
  const v = env && env.FF_CHART_SNAPSHOTS;
  return v === "1" || v === "true" || v === true;
}

function chartSnapshotKeyPart(v) {
  const s = String(v == null || v === "" ? "-" : v);
  return encodeURIComponent(s).slice(0, 120);
}

// The KV key for this page of this chart, or null when the source is not
// snapshotted.
function chartSnapshotKey(source, ref, { entry, skip, keys }) {
  const rule = source && source.kind === "chart" ? source.snapshot : null;
  if (!rule) return null;
  const parts = [
    source.name,
    ref.arg,
    entry && entry.type,
    rule.region ? (keys && keys.region) : "",
    Number(skip) || 0,
  ].map(chartSnapshotKeyPart);
  const variant = typeof rule.variant === "function" ? rule.variant(ref, { entry, skip, keys }) : "";
  if (variant) parts.push(chartSnapshotKeyPart(variant));
  return CHART_SNAPSHOT_PREFIX + parts.join(":");
}

function chartSnapshotItems(snap) {
  const items = Array.isArray(snap && snap.items) ? snap.items.slice() : [];
  if (typeof snap.totalItems === "number") items.totalItems = snap.totalItems;
  return items;
}

function rememberChartSnapshot(key, patch) {
  const prev = CHART_SNAPSHOT_MEMO.get(key);
  if (!prev && CHART_SNAPSHOT_MEMO.size >= CHART_SNAPSHOT_MEMO_MAX) {
    const oldest = CHART_SNAPSHOT_MEMO.keys().next().value;
    if (oldest !== undefined) CHART_SNAPSHOT_MEMO.delete(oldest);
  }
  const next = { snap: null, checkedAt: 0, triedAt: 0, ...(prev || {}), ...patch };
  CHART_SNAPSHOT_MEMO.set(key, next);
  return next;
}

async function readChartSnapshot(env, key, now) {
  const memo = CHART_SNAPSHOT_MEMO.get(key);
  if (memo && now - memo.checkedAt < CHART_SNAPSHOT_MEMO_MS) return memo.snap;
  let snap = null;
  try {
    const raw = await env.CONFIGS.get(key, "json");
    if (raw && Array.isArray(raw.items) && Number.isFinite(raw.builtAt)) snap = raw;
  } catch {
    // Unreadable: treated as missing, and rebuilt.
  }
  rememberChartSnapshot(key, { snap, checkedAt: now });
  return snap;
}

// Builds the page through the source's fetcher and stores it, unless it came
// back empty. Resolves to { snap, raw }: snap is the snapshot now in effect
// (the new one, or `previous` kept because the new one was empty, or null),
// raw what the fetcher returned. Rejects when the fetcher did.
function buildChartSnapshot(source, ref, page, key, previous) {
  const running = CHART_SNAPSHOT_BUILDING.get(key);
  if (running) return running;
  const { keys } = page;
  const env = keys.env;
  const job = (async () => {
    rememberChartSnapshot(key, { triedAt: Date.now() });
    const fresh = await source.fetchPage(ref, page);
    const items = Array.isArray(fresh) ? fresh : [];
    if (!items.length) {
      if (previous && previous.items.length) {
        console.warn(`[ChartSnapshot] ${key} came back empty; keeping the last copy.`);
      }
      return { snap: previous || null, raw: fresh };
    }
    const snap = {
      items: items.slice(),
      totalItems: typeof fresh.totalItems === "number" ? fresh.totalItems : null,
      builtAt: Date.now(),
    };
    rememberChartSnapshot(key, { snap, checkedAt: Date.now() });
    try {
      await env.CONFIGS.put(key, JSON.stringify(snap), { expirationTtl: CHART_SNAPSHOT_KV_TTL_SEC });
    } catch {
      // Another isolate wrote the same key this second, or KV is having a bad
      // moment: this isolate still serves what it built.
    }
    return { snap, raw: fresh };
  })();
  CHART_SNAPSHOT_BUILDING.set(key, job);
  job.then(() => CHART_SNAPSHOT_BUILDING.delete(key), () => CHART_SNAPSHOT_BUILDING.delete(key));
  return job;
}

// fetchCatalog's call for one source. Serves the chart snapshot when there is
// one, and otherwise calls the fetcher exactly as before.
async function fetchSourcePageWithSnapshot(source, ref, page) {
  const keys = page.keys || {};
  const env = keys.env;
  const key = env && env.CONFIGS && isChartSnapshotsEnabled(env) ? chartSnapshotKey(source, ref, page) : null;
  if (!key) return source.fetchPage(ref, page);

  const now = Date.now();
  const snap = await readChartSnapshot(env, key, now);
  if (snap && snap.items.length) {
    const memo = CHART_SNAPSHOT_MEMO.get(key);
    const stale = now - snap.builtAt >= CHART_SNAPSHOT_FRESH_MS;
    const mayRetry = !memo || now - (memo.triedAt || 0) >= CHART_SNAPSHOT_RETRY_MS;
    if (stale && mayRetry) {
      const rebuild = buildChartSnapshot(source, ref, page, key, snap).catch((err) => {
        console.warn(`[ChartSnapshot] rebuilding ${key} failed; serving the last copy.`, err && err.message);
      });
      if (keys.ctx && typeof keys.ctx.waitUntil === "function") keys.ctx.waitUntil(rebuild);
    }
    return chartSnapshotItems(snap);
  }
  // Nothing stored yet: built now. An empty answer is passed on as the
  // fetcher gave it (with any total it carries), and not stored.
  const built = await buildChartSnapshot(source, ref, page, key, null);
  return built.snap ? chartSnapshotItems(built.snap) : built.raw;
}
