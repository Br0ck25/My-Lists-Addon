// Stat counters: bumpStat / bumpStatBy and their in-isolate batching (PERF-04).
// Moved out of 03_admin.js, which is over its size baseline and may only shrink;
// d1BumpStat and every stats reader stay there.

// --- In-isolate batching of the D1 counters (PERF-04) -----------------------
//
// bumpStat / bumpStatBy used to write two upserts per event, and the `total` row
// of a busy kind (pageviews, apiuse:*) is one row every request contends on at
// the single D1 primary. They now add up in this isolate and are written as ONE
// batch when the oldest unwritten bump is a minute old, or 50 kinds are waiting.
//
// The owner accepted the cost (2026-11-03): an isolate recycled between flushes
// loses up to a minute of its counts, so the admin numbers are approximate by
// that much. To keep the numbers honest otherwise: every stats READ in this file
// flushes this isolate's pending counts first, the cron tick does too, and a
// failed flush puts its counts back for the next one. bumpStat returns the flush
// when it is due, so the existing ctx.waitUntil(bumpStat(...)) call sites carry
// it (no call site changed). The day key is taken when the event happens, so a
// batch spanning midnight Eastern still splits into two day rows.
const STAT_FLUSH_AFTER_MS = 60 * 1000;
const STAT_FLUSH_MAX_KINDS = 50;
const STAT_FLUSH_STATEMENTS_PER_BATCH = 100;
const STAT_PENDING_BY_DB = new WeakMap();

// Playback counters are low-volume and arrive one at a time on many different
// isolates, so a bump is almost never followed by a second one on the same isolate
// to trigger the minute flush. Held in memory they were simply lost when the isolate
// was recycled (the "Playback streams" column fell from 200+ a day to under 100 on
// 2026-11-03). They are written at once; the hot kinds (pageviews, apiuse:*) stay batched.
function statWritesImmediately(kind) {
  return kind === "playback_pings" || kind.startsWith("watch_type:");
}

// The one object that stays the same across requests: instrumentEnv wraps env.DB
// per request and keeps the real binding on __raw.
function statBindingOf(env) {
  const db = env && env.DB;
  return db && db.__raw ? db.__raw : db;
}

function statPendingFor(env) {
  const key = statBindingOf(env);
  let st = STAT_PENDING_BY_DB.get(key);
  if (!st) {
    st = { db: key, kinds: new Map(), firstAt: 0 };
    STAT_PENDING_BY_DB.set(key, st);
  }
  return st;
}

function statPendingAdd(st, kind, day, amount) {
  let k = st.kinds.get(kind);
  if (!k) {
    k = { total: 0, days: new Map() };
    st.kinds.set(kind, k);
  }
  if (!st.firstAt) st.firstAt = Date.now();
  if (day === "total") {
    k.total += amount;
  } else {
    k.days.set(day, (k.days.get(day) || 0) + amount);
  }
}

function statPendingDue(st) {
  return st.kinds.size >= STAT_FLUSH_MAX_KINDS || (st.firstAt && Date.now() - st.firstAt >= STAT_FLUSH_AFTER_MS);
}

async function flushPendingStats(env) {
  if (!env || !env.DB) return;
  const st = STAT_PENDING_BY_DB.get(statBindingOf(env));
  if (!st || !st.kinds.size) return;
  // Swap first, so a bump arriving while the batch is in flight starts a new window.
  const taken = st.kinds;
  st.kinds = new Map();
  st.firstAt = 0;
  const upsert = "INSERT INTO stats (kind, day, n) VALUES (?, ?, ?) ON CONFLICT(kind, day) DO UPDATE SET n = n + excluded.n";
  const stmts = [];
  for (const [kind, k] of taken) {
    if (k.total) stmts.push(st.db.prepare(upsert).bind(kind, "total", k.total));
    for (const [day, n] of k.days) stmts.push(st.db.prepare(upsert).bind(kind, day, n));
  }
  try {
    for (let i = 0; i < stmts.length; i += STAT_FLUSH_STATEMENTS_PER_BATCH) {
      await st.db.batch(stmts.slice(i, i + STAT_FLUSH_STATEMENTS_PER_BATCH));
    }
  } catch (e) {
    // Best-effort like every counter: put the counts back for the next flush.
    for (const [kind, k] of taken) {
      if (k.total) statPendingAdd(st, kind, "total", k.total);
      for (const [day, n] of k.days) statPendingAdd(st, kind, day, n);
    }
  }
}

async function bumpStat(env, kind) {
  if (!env || !env.CONFIGS) return;
  try {
    // D1 is where every counter is read from (readStatCount, loadStatsByDay,
    // the leaderboards), so it is where every counter is written. From
    // 2026-10-02 to the fix these went to Analytics Engine only, which
    // nothing reads, and the admin dashboard froze at zero.
    if (env.DB) {
      const st = statPendingFor(env);
      statPendingAdd(st, kind, "total", 1);
      statPendingAdd(st, kind, statsToday(), 1);
      if (statWritesImmediately(kind) || statPendingDue(st)) await flushPendingStats(env);
      return;
    }
    // KV path: get-then-put, so concurrent bumps lose increments
    // (AUDIT-2026-09-05 §14). Deliberately left as it is, and recorded here
    // rather than silently: KV has no atomic increment and no
    // compare-and-swap, so the only correct fix is a different storage
    // primitive -- which is exactly what the D1 branch above is
    // (d1BumpStat's upsert is atomic, and it is the path any deployment
    // that cares about exact counters should be on). What is lost is a
    // display statistic under simultaneous load; nothing reads these
    // numbers to make a decision, and no user-visible behaviour depends on
    // one. Spending a durable object per counter on that would be the
    // wrong trade.
    const totalKey = `stats:${kind}:total`;
    const dayKey = `stats:${kind}:${statsToday()}`;
    const [totalRaw, dayRaw] = await Promise.all([env.CONFIGS.get(totalKey), env.CONFIGS.get(dayKey)]);
    const total = (parseInt(totalRaw, 10) || 0) + 1;
    const day = (parseInt(dayRaw, 10) || 0) + 1;
    await Promise.all([env.CONFIGS.put(totalKey, String(total)), env.CONFIGS.put(dayKey, String(day))]);
  } catch (e) {
    // best-effort -- a failed stat bump should never break the actual
    // request it's riding along on (see the ctx.waitUntil call sites,
    // which don't await this at all for exactly that reason).
  }
}

// Like bumpStat above, but by a caller-supplied amount in one write
// instead of always +1 -- used for the per-source-group counters (a
// single "generate install link" beacon can represent several rows of the
// same group at once, e.g. five Custom Lists in one install). Total only,
// no daily breakdown -- "which sources people use" reads more like a
// standing preference than a day-to-day trend, and this keeps the write
// count reasonable for a request that can touch several groups at once.
async function bumpStatBy(env, kind, amount) {
  if (!env || !env.CONFIGS || !amount) return;
  try {
    const totalKey = `stats:${kind}:total`;
    if (env.DB && kind.startsWith("sourcegroup:")) {
      // Left exactly as it was: source groups have their own table, their
      // own read path in renderAdminDashboard, and their own branch in
      // /admin/api/migrate-d1. It was already atomic -- it is the precedent
      // the rest of this now follows, not something to re-route.
      const groupName = kind.slice("sourcegroup:".length);
      await env.DB.prepare(
        "INSERT INTO source_groups (id, name, install_count) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET install_count = source_groups.install_count + excluded.install_count"
      ).bind(groupName, groupName, amount).run();
    } else if (env.DB) {
      // Total only, no day bucket -- see this function's own comment on why
      // per-source-group counters are all-time.
      const st = statPendingFor(env);
      statPendingAdd(st, kind, "total", amount);
      if (statPendingDue(st)) await flushPendingStats(env);
    } else {
      const totalRaw = await env.CONFIGS.get(totalKey);
      const total = (parseInt(totalRaw, 10) || 0) + amount;
      await env.CONFIGS.put(totalKey, String(total));
    }
  } catch (e) {
    // best-effort, see bumpStat above
  }
}

