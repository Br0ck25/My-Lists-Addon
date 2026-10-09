// --- Admin stats (page views, install links generated) -----------------
//
// Deliberately simple counters -- KV has no atomic increment (each bump is
// a read-then-write), so under truly simultaneous requests a bump can very
// occasionally get lost. That's an acceptable tradeoff for a personal
// project's traffic; this isn't meant to be exact to the request, just a
// reasonable running total and day-by-day trend for the admin-only
// dashboard below. No cookies, no per-visitor identity involved -- just a
// running count of events.
// Calendar date (YYYY-MM-DD) for a given moment, in Eastern time -- this
// admin dashboard is for a single owner in a fixed timezone, and using
// UTC's day boundary meant "today" started rolling over into "tomorrow"
// as early as ~7-8pm Eastern, well before the day was actually over
// locally. en-CA formats as YYYY-MM-DD directly; America/New_York's IANA
// data handles the EST/EDT switch automatically, unlike a fixed offset
// would.
function easternDateKey(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function statsToday() {
  return easternDateKey(new Date());
}

// --- Counter storage ---------------------------------------------------------
//
// Every counter here used to be a KV read-modify-write: GET, add one, PUT.
// KV has no atomic increment and no compare-and-swap, so two overlapping
// requests both read the same number and both write the same number+1, and
// one is silently lost. Measured against this Worker: twenty concurrent
// requests recorded as ONE.
//
// Production is worse than that measurement, in two ways that compound with
// traffic: KV reads are edge-cached, so every request inside a cache window
// can read the same stale value; and KV allows roughly one write per second
// per key, which the hot keys (stats:pageviews:total and each day bucket)
// are. The dashboard therefore drifts further from reality the busier the
// deployment gets -- downward, silently, while still rendering a confident,
// precise-looking number.
//
// SQLite's upsert is atomic and removes the class outright. This is the same
// shape the source_groups counter has always used (see bumpStatBy below) --
// every other counter now works the way that one already did.
//
// D1 stays OPTIONAL, exactly as it is everywhere else in this codebase: with
// no DB bound the KV path below runs unchanged, lost updates and all. That
// is a real remaining limitation for KV-only deployments, not an oversight
// -- KV genuinely cannot do this correctly, and the honest options there are
// to bind D1 or to read the numbers as approximate.
//
// Counters are the ONE data family where "D1 is optional and removable at any
// time without data loss" -- true of accounts, lists and likes, which are
// always written to KV -- does not hold. Once D1 is bound these write to D1
// alone, because dual-writing would put the lost-update race straight back in
// (and spend a second write per bump on a key KV rate-limits to one per
// second). So unbinding D1, or rebuilding it from schema.sql, rolls every
// counter back to the KV value it had at migration time. That trade is the
// right one and is now stated in wrangler.toml where an operator will see it,
// rather than being a surprise.
async function d1BumpStat(env, kind, buckets, amount) {
  // One statement per bucket, sent as a batch so the whole bump is a single
  // round trip. ON CONFLICT ... n = n + excluded.n is the atomic part.
  const stmts = buckets.map((bucket) =>
    env.DB.prepare(
      "INSERT INTO stats (kind, day, n) VALUES (?, ?, ?) ON CONFLICT(kind, day) DO UPDATE SET n = n + excluded.n"
    ).bind(kind, bucket, amount)
  );
  await env.DB.batch(stmts);
}

async function bumpStat(env, kind) {
  if (!env || !env.CONFIGS) return;
  try {
    // D1 is where every counter is read from (readStatCount, loadStatsByDay,
    // the leaderboards), so it is where every counter is written. From
    // 2026-10-02 to the fix these went to Analytics Engine only, which
    // nothing reads, and the admin dashboard froze at zero
    // (recoverStatsFromAnalyticsEngine puts those days back).
    if (env.DB) {
      await d1BumpStat(env, kind, ["total", statsToday()], 1);
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
      await d1BumpStat(env, kind, ["total"], amount);
    } else {
      const totalRaw = await env.CONFIGS.get(totalKey);
      const total = (parseInt(totalRaw, 10) || 0) + amount;
      await env.CONFIGS.put(totalKey, String(total));
    }
  } catch (e) {
    // best-effort, see bumpStat above
  }
}

// Bumps one or more named counters that all live inside a single JSON blob
// at `key`, in one read + one write total -- rather than a separate KV key
// (and separate bumpStat total+day pair) per counter. Used for genre/decade
// playback telemetry (see recordPlaybackTelemetry below): a single ping
// with up to 5 genres used to cost 10 writes just for the genre piece
// (bumpStat's total+day pair x5); this costs 1, regardless of how many
// fields are bumped in the same call.
//
// The tradeoff, on purpose: every field sharing one key means any two
// concurrent playback pings -- even on completely different genres --
// now race on the same read-modify-write, where before only two pings on
// the *same* genre could collide. KV has no atomic increment either way
// (see bumpStat's own comment), so this trades a wider collision surface
// for a large write-count cut. Worth it here specifically because this
// data was already "a reasonable running total, not an exact ledger" (see
// computeAudienceAnalytics, which only ever reads the all-time snapshot --
// there's no day-by-day genre/decade view for a dropped increment to be
// conspicuously missing from), not because undercounting is free in
// general.
async function bumpJsonCounterBlob(env, key, fields) {
  if (!fields || !fields.length) return;
  // If D1 is bound, explode genres and decades into atomic stats rows per §5.2
  if (env && env.DB) {
    try {
      const isGenre = key === "stats:genres:alltime";
      const isDecade = key === "stats:decades:alltime";
      if (isGenre || isDecade) {
        const prefix = isGenre ? "genre:" : "decade:";
        for (const f of fields) {
          if (!f) continue;
          await d1BumpStat(env, prefix + f, ["total"], 1);
        }
      }
    } catch (e) {
      // best-effort
    }
  }
  if (!env || !env.CONFIGS) return;
  try {
    const raw = await env.CONFIGS.get(key);
    let counts = {};
    if (raw) {
      try {
        counts = JSON.parse(raw) || {};
      } catch {
        counts = {};
      }
    }
    for (const f of fields) {
      if (!f) continue;
      counts[f] = (parseInt(counts[f], 10) || 0) + 1;
    }
    await env.CONFIGS.put(key, JSON.stringify(counts));
  } catch (e) {
    // best-effort, see bumpStat above
  }
}

// One-time migration: folds the old per-genre/per-decade
// "stats:genre:X:total" / "stats:decade:X:total" keys (written by the
// bumpStat-per-genre approach recordPlaybackTelemetry used before it
// switched to bumpJsonCounterBlob above) into the new single-blob keys
// (stats:genres:alltime / stats:decades:alltime), adding their values into
// those all-time totals so switching formats didn't reset the Trending
// Data tab's existing genre/decade counts back to zero.
//
// Guarded by its own sentinel key so the list()+N-gets below -- exactly
// the expensive read pattern the new blob format exists to get away from
// -- only ever runs once, no matter how many times the dashboard's
// Audience tab gets loaded afterward. Old counts are added to (not
// overwritten over) whatever the new blob already has, so any plays that
// already landed in the new blob in the window before this migration ran
// P10-4: migrateGenreDecadeStatsIfNeeded removed (stats are in Analytics Engine/D1)
async function migrateGenreDecadeStatsIfNeeded(env) {
  return;
}

// Records roughly how recently a creator account was last active -- feeds
// the "Last Active" column in the admin dashboard's Creator Accounts tab.
// Throttled to at most once per 30 minutes per account (one extra read to
// check, skipped write if already recent) so a burst of debounced
// autosaves during a single active session doesn't turn into a KV write
// on every one of them -- called from authenticateCreator on every
// successful auth, fire-and-forget (never awaited there), so this can
// never add latency or a failure mode to the actual authenticated action
// it's riding along with.
//
// The timestamp is mirrored into D1's creators.last_active on the same
// throttle. That column existed for a long time but nothing ever wrote to
// it, which forced the dashboard to do one KV `get` per account just to
// render the "Last Active" column -- linear in the account count, and
// over Cloudflare's 1,000-storage-operations/invocation cap past roughly a
// thousand creators (the admin dashboard then stopped loading entirely in
// production; Miniflare doesn't enforce that limit, so it rendered fine
// locally). Writing it here lets the dashboard read last-active straight
// out of the creators SELECT it already runs. Accounts that predate this
// have NULL in D1 and are repaired lazily by backfillCreatorLastActive.
const _lastSeenMemo = new Map();
const LAST_SEEN_THROTTLE_MS = 30 * 60 * 1000;

async function touchCreatorLastSeen(env, username) {
  if (!env || !username) return;
  const now = Date.now();
  const last = _lastSeenMemo.get(username) || 0;
  if (now - last < LAST_SEEN_THROTTLE_MS) return;

  _lastSeenMemo.set(username, now);
  if (_lastSeenMemo.size > 2000) {
    const pruneBefore = now - LAST_SEEN_THROTTLE_MS;
    for (const [u, ts] of _lastSeenMemo.entries()) {
      if (ts < pruneBefore) _lastSeenMemo.delete(u);
    }
  }

  if (env.DB) {
    try {
      await env.DB.prepare("UPDATE creators SET last_active = ? WHERE username = ?")
        .bind(now, username)
        .run();
      return;
    } catch (dbErr) {
      // D1 write error, best-effort fallback to KV
    }
  }

  if (env.CONFIGS) {
    try {
      const key = `creatorlastseen:${username}`;
      await env.CONFIGS.put(key, String(now));
    } catch (e) {
      // best-effort
    }
  }
}

// How many NULL last_active rows one dashboard load repairs. Kept well
// under the subrequest cap: at most this many KV reads plus a single D1
// batch write per call, so the backfill itself can never be the thing
// that tips a dashboard load over the limit even mid-migration.
const LAST_ACTIVE_BACKFILL_BATCH = 100;

// Lazily fills creators.last_active in D1 from the KV creatorlastseen:
// marker for accounts that still have NULL there -- every account created
// before touchCreatorLastSeen started mirroring into D1. Runs only on an
// admin dashboard load, repairs a bounded batch each time, and then has
// nothing left to do: once a row is set, touchCreatorLastSeen keeps it
// current going forward. Converges over a handful of loads (1,200 accounts
// -> ~12 loads) and then costs zero KV reads. Each repaired value is also
// written onto the in-memory account object so it shows the right "Last
// Active" on the load that repairs it, not one load later.
// P10-4 (FT-42): backfillCreatorLastActive removed (accounts in D1 v2)
async function backfillCreatorLastActive(env, accounts) {
  return;
}


// Records one "marked as watched" or "added to a list" event for a given
// title -- feeds the admin dashboard's Trending Data tab, which is meant
// to eventually seed this add-on's own trending/popular catalogs once
// there's enough data. Bucketed by Eastern calendar day (see
// easternDateKey) rather than a raw event log, so an arbitrary rolling
// window (7/30/90 days) can be summed later without needing a real
// time-series database -- evtdayindex tracks which title ids had any
// activity on a given day, so the dashboard only has to sum counts for
// titles that were actually active in the requested window instead of
// checking every title that's ever been tracked. KV has no atomic
// increment (same tradeoff as bumpStat above), so this is a reasonable
// running total, not an exact ledger.
// Telemetry keys used to live forever. `evtcount:` / `evtmeta:` grow one
// pair per title ever watched; `searchquery:` is worse -- the query string
// is the key, so an unauthenticated `/api/track-search` loop mints unbounded
// KV. Day-scoped blobs and indexes expire after 120 days (wider than the
// 90-day dashboard window). All-time counters expire 400 days after the
// last increment, so dormant titles/queries drop and active ones refresh.
const TELEMETRY_DAY_TTL_SEC = 120 * 24 * 60 * 60;
const TELEMETRY_ALLTIME_TTL_SEC = 400 * 24 * 60 * 60;
const EVT_DAY_INDEX_CAP = 1000;
const SEARCH_DAY_INDEX_CAP = 400;
// Support threads: 180 days from last write (create/reply/edit refreshes).
const FEEDBACK_TTL_SEC = 180 * 24 * 60 * 60;
const FEEDBACK_ADMIN_GET_CAP = 300;

async function putFeedbackThread(env, key, entry) {
  const id = key.startsWith("feedback:") ? key.slice("feedback:".length) : (entry.id || key);
  const status = (entry.completed ? "closed" : null) || entry.status || "open";
  const subject = entry.category || entry.subject || (entry.messages && entry.messages[0] && entry.messages[0].text ? entry.messages[0].text.slice(0, 100) : null);
  const createdAt = Number(entry.createdAt) || Date.now();
  const updatedAt = Number(entry.updatedAt) || createdAt;
  const bodyJson = JSON.stringify(entry);

  if (env && env.DB) {
    try {
      await env.DB.prepare(
        `INSERT INTO feedback (id, status, subject, body_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           subject = excluded.subject,
           body_json = excluded.body_json,
           updated_at = excluded.updated_at`
      ).bind(id, status, subject, bodyJson, createdAt, updatedAt).run();
    } catch (dbErr) {
      console.error("D1 write error (putFeedbackThread):", dbErr);
    }
  }
  if (env && env.CONFIGS) {
    await env.CONFIGS.put(key, bodyJson, { expirationTtl: FEEDBACK_TTL_SEC });
  }
}

// The display fields for a tracked title -- its name and media type.
// In D1 they live in the event_meta table; in KV they live at evtmeta:{type}:{id}.
// Written when the title or media type has actually changed, and otherwise
// at most once a day per title so lastSeen stays meaningful.
//
// Returns whether it wrote, which is what the tests assert on.
const EVT_META_REFRESH_MS = 24 * 60 * 60 * 1000;
async function writeEventMetaIfChanged(env, eventType, id, title, mediaType) {
  let changed = false;
  if (env && env.DB) {
    try {
      const existing = await env.DB.prepare(
        "SELECT title, media_type, last_seen FROM event_meta WHERE event_type = ? AND item_id = ?"
      ).bind(eventType, id).first();
      if (
        !existing ||
        (existing.title || "") !== (title || "") ||
        (existing.media_type || "") !== (mediaType || "") ||
        Date.now() - (existing.last_seen || 0) >= EVT_META_REFRESH_MS
      ) {
        await env.DB.prepare(
          `INSERT INTO event_meta (event_type, item_id, title, media_type, last_seen)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(event_type, item_id) DO UPDATE SET
             title = excluded.title,
             media_type = excluded.media_type,
             last_seen = excluded.last_seen`
        ).bind(eventType, id, title || "", mediaType || "", Date.now()).run();
        changed = true;
      }
    } catch (e) {
      console.error("D1 write error (event_meta):", e);
    }
  }

  if (env && env.CONFIGS) {
    const metaKey = `evtmeta:${eventType}:${id}`;
    const metaRaw = await env.CONFIGS.get(metaKey);
    try {
      const prev = metaRaw ? JSON.parse(metaRaw) : null;
      if (prev
        && (prev.title || "") === (title || "")
        && (prev.mediaType || "") === (mediaType || "")
        && Number.isFinite(prev.lastSeen)
        && Date.now() - prev.lastSeen < EVT_META_REFRESH_MS) {
        return changed;
      }
    } catch {
      // Unreadable -- rewrite it.
    }
    await env.CONFIGS.put(metaKey, JSON.stringify({ title: title || "", mediaType: mediaType || "", lastSeen: Date.now() }), { expirationTtl: TELEMETRY_ALLTIME_TTL_SEC });
    return true;
  }
  return changed;
}

// An id that is a stringified missing value -- String(null) is "null" -- not
// a title. Every one of them counted as ONE title, so all the watches with a
// lost id piled up under "null" and it topped the Most Watched chart (named
// "null iv" by the TMDB lookup that tried to resolve it). Rejected on the way
// in (/api/track-event, recordTrackedEvent) and skipped on the way out
// (computeLeaderboard), so counts already recorded under one stop showing too.
function isJunkTrackedId(id) {
  const s = String(id == null ? "" : id).trim().toLowerCase();
  if (!s) return true;
  const base = s.split(":")[0];
  return base === "null" || base === "undefined" || base === "nan" || base === "false" || base === "true" || s.startsWith("[object");
}

async function recordTrackedEvent(env, eventType, id, title, mediaType) {
  if (!env || !env.CONFIGS || !id || isJunkTrackedId(id)) return;
  try {
    const day = statsToday();
    // With D1 bound the counts go there and cost ZERO KV writes, the same way
    // bumpStat's counters already did. This function was the biggest consumer
    // of the free plan's 1,000-writes-a-day budget that bumpStat's move left
    // behind: four KV writes per tracked title, so a browser posting a
    // ten-title batch spent 41 of them and roughly 250 watched titles in a
    // day exhausted the whole allowance -- at which point every KV write in
    // the app fails, which is how this was found (marking a feedback item
    // done started answering "KV put() limit exceeded for the day").
    //
    // No migration was needed: `stats` is keyed (kind, day) and its `kind`
    // dimension is already unbounded (list_copy:{slug} mints one per list),
    // so `evt:{eventType}:{id}` just goes in beside them. The day index is
    // not written at all on this path -- a range scan over `day` is what
    // replaces it (see d1LeaderboardCounts).
    if (env.DB) {
      await d1BumpStat(env, `evt:${eventType}:${id}`, ["total", day], 1);
      // The display fields still live in KV, and are still written at most
      // once a day per title rather than on every event.
      await writeEventMetaIfChanged(env, eventType, id, title, mediaType);
      return;
    }
    const daysKey = `evtcount:${eventType}:${id}:days`;
    const totalKey = `evtcount:${eventType}:${id}:alltime`;
    const indexKey = `evtdayindex:${eventType}:${day}`;

    const [daysRaw, totalRaw, indexRaw] = await Promise.all([
      env.CONFIGS.get(daysKey),
      env.CONFIGS.get(totalKey),
      env.CONFIGS.get(indexKey),
    ]);
    // One JSON blob per (eventType, id) holding every day's count, rather
    // than one KV key per (eventType, id, day) -- summing a 90-day window
    // used to mean 90 separate reads per candidate title (see
    // computeLeaderboard below), which multiplied against even a modest
    // candidate list blew past a safe per-invocation KV read budget and
    // was quietly capping the leaderboard to far fewer than 100 entries
    // for every window wider than a day or two. One read per candidate
    // here, regardless of window width, fixes that at the root instead of
    // just raising a cap number. Trimmed to the most recent 95 days on
    // write (a few days' buffer past the widest window this dashboard
    // ever queries, 90) so this blob can't grow without bound for a title
    // that's been tracked for years.
    let dayCounts = {};
    try {
      dayCounts = daysRaw ? JSON.parse(daysRaw) : {};
    } catch {
      dayCounts = {};
    }
    dayCounts[day] = (dayCounts[day] || 0) + 1;
    const dayKeys = Object.keys(dayCounts).sort();
    if (dayKeys.length > 95) {
      dayKeys.slice(0, dayKeys.length - 95).forEach((k) => delete dayCounts[k]);
    }
    const totalCount = (parseInt(totalRaw, 10) || 0) + 1;

    let index = [];
    try {
      index = indexRaw ? JSON.parse(indexRaw) : [];
    } catch {
      index = [];
    }
    // Written only when it actually changed. This key is one list per
    // (eventType, day), so after the first event for a given title every
    // later one rewrote a blob it had not altered.
    const indexChanged = !index.includes(id) && index.length < EVT_DAY_INDEX_CAP;
    if (indexChanged) index.push(id);

    const writes = [
      env.CONFIGS.put(daysKey, JSON.stringify(dayCounts), { expirationTtl: TELEMETRY_DAY_TTL_SEC }),
      env.CONFIGS.put(totalKey, String(totalCount), { expirationTtl: TELEMETRY_ALLTIME_TTL_SEC }),
    ];
    if (indexChanged) {
      writes.push(env.CONFIGS.put(indexKey, JSON.stringify(index), { expirationTtl: TELEMETRY_DAY_TTL_SEC }));
    }
    // Both this and the day index above were rewritten on EVERY event even
    // when their contents had not changed -- half of this function's four
    // KV writes per tracked title, so a ten-title batch spent 41 of the free
    // plan's 1,000 a day.
    writes.push(writeEventMetaIfChanged(env, eventType, id, title, mediaType));
    await Promise.all(writes);
  } catch (e) {
    // best-effort -- never breaks the actual watch/list action riding along
  }
}

// Computes a top-100 leaderboard of the most tracked titles for a given
// event type ("watched" or "list-add") and time window -- powers the
// admin dashboard's Trending Data tab. See recordTrackedEvent's own
// comment for the underlying data model. "today"/"7"/"30"/"90" sum via
// each day's index (bounded to titles that were actually active
// somewhere in that window, not every title ever tracked); "alltime"
// reads each title's running total directly instead, since there's no
// day-index for it that would need summing. mediaTypeFilter ("movie" /
// "series" / falsy for both) is applied before the top-100 cut, not
// after, so filtering to just movies still returns up to 100 movies
// instead of whatever happened to survive filtering an already-mixed
// top 100.
// Attaches the display fields (title, media type) to a set of tracked ids.
//
// These stay in KV on every deployment, D1-bound or not. The COUNTS are what
// were spending the write budget -- four KV writes per tracked title, and a
// ten-title batch was 41 -- and those move to D1 below. This blob is now
// written at most once a day per title (see recordTrackedEvent), and it is
// only ever READ here, bounded by the candidate cap. Reads are the cheap
// side: 100,000 a day against 1,000 writes.
async function attachEventMeta(env, eventType, ids) {
  if (!ids || !ids.length) return [];
  const metaMap = new Map();
  if (env && env.DB) {
    // Chunked: D1 allows at most 100 bound parameters per statement, and the
    // leaderboard asks for up to CANDIDATE_CAP (400) ids plus event_type. As a
    // single statement this threw on every call and fell through to one KV
    // read per id; the local SQLite harness allows 32,766 parameters, so no
    // test could see it. 90 matches the chunk size used elsewhere.
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      try {
        const placeholders = chunk.map(() => "?").join(",");
        const rows = await env.DB.prepare(
          `SELECT item_id, title, media_type FROM event_meta WHERE event_type = ? AND item_id IN (${placeholders})`
        ).bind(eventType, ...chunk).all();
        if (rows && Array.isArray(rows.results)) {
          for (const r of rows.results) {
            metaMap.set(r.item_id, { title: r.title || r.item_id, mediaType: r.media_type || "" });
          }
        }
      } catch (e) {
        console.error("D1 read error (attachEventMeta):", e);
      }
    }
  }
  return await Promise.all(
    ids.map(async (id) => {
      if (metaMap.has(id)) {
        const m = metaMap.get(id);
        return { id, title: m.title, mediaType: m.mediaType };
      }
      let title = id;
      let mediaType = "";
      try {
        if (env && env.CONFIGS) {
          const metaRaw = await env.CONFIGS.get(`evtmeta:${eventType}:${id}`);
          if (metaRaw) {
            const meta = JSON.parse(metaRaw);
            title = meta.title || id;
            mediaType = meta.mediaType || "";
          }
        }
      } catch {
        // fall back to the raw id as the title
      }
      return { id, title, mediaType };
    })
  );
}

// The D1 candidate source. One indexed query replaces the whole day-index
// dance the KV branches need: `stats` is keyed (kind, day), so a window is a
// range scan and "alltime" is the single day='total' row per title.
//
// The kind is `evt:{eventType}:{id}` -- the same shape bumpStat has always
// written into this table for its own counters, and the same unbounded
// `kind` dimension list_copy:{slug} already uses. That is why this needed no
// migration: the table it wants already exists.
async function d1CountsByKindPrefix(env, prefix, window, candidateCap) {
  const [lo, hi] = statKindRange(prefix);
  let rows;
  if (window === "alltime") {
    rows = await env.DB.prepare(
      "SELECT kind, n AS total FROM stats WHERE kind >= ? AND kind < ? AND day = 'total' ORDER BY n DESC LIMIT ?"
    ).bind(lo, hi, candidateCap).all();
  } else {
    const days = window === "today" ? 1 : parseInt(window, 10) || 7;
    const nowMs = Date.now();
    const oldest = easternDateKey(new Date(nowMs - (days - 1) * 86400000));
    const newest = easternDateKey(new Date(nowMs));
    rows = await env.DB.prepare(
      "SELECT kind, SUM(n) AS total FROM stats WHERE kind >= ? AND kind < ? AND day >= ? AND day <= ? GROUP BY kind ORDER BY total DESC LIMIT ?"
    ).bind(lo, hi, oldest, newest, candidateCap).all();
  }
  return (rows && rows.results ? rows.results : [])
    .map((r) => ({ key: String(r.kind).slice(prefix.length), count: Number(r.total) || 0 }))
    .filter((e) => e.key);
}

async function d1LeaderboardCounts(env, eventType, window, candidateCap) {
  const rows = await d1CountsByKindPrefix(env, `evt:${eventType}:`, window, candidateCap);
  return rows.map((r) => ({ id: r.key, count: r.count }));
}

async function computeLeaderboard(env, eventType, window, mediaTypeFilter) {
  if (!env || !env.CONFIGS) return [];
  const prefix = `evtcount:${eventType}:`;
  const wantType = mediaTypeFilter === "movie" || mediaTypeFilter === "series" ? mediaTypeFilter : null;

  // Cap the candidate pool before any per-title work. The KV branches below
  // pay reads per candidate, so this is what stops the Trending tab crossing
  // Cloudflare's 1,000-storage-operations-per-invocation cap on a large
  // corpus; the D1 branch does not need it for cost, but keeping the same
  // ceiling keeps the three paths returning the same shape of answer.
  const CANDIDATE_CAP = 400;

  // Candidates: { id, count }. Three sources, one tail.
  let candidates;
  // Only the KV window branch can produce a zero -- see the note where it
  // builds its id set.
  let dropZero = false;

  if (env.DB) {
    // Every watch is counted in `stats` (recordTrackedEvent). title_daily_stats
    // holds only the plays of accounts on event tracking, by UTC day, up to
    // yesterday: reading it instead (as P8-2 did) dropped everyone else's
    // watches and today's.
    candidates = await d1LeaderboardCounts(env, eventType, window, CANDIDATE_CAP);
  } else if (window === "alltime") {
    const listResult = await listAllKeys(env.CONFIGS, prefix);
    const alltimeKeys = listResult.keys
      .filter((k) => k.name.endsWith(":alltime"))
      .slice(0, CANDIDATE_CAP);
    candidates = await Promise.all(
      alltimeKeys.map(async (k) => ({
        id: k.name.slice(prefix.length, -":alltime".length),
        count: parseInt(await env.CONFIGS.get(k.name), 10) || 0,
      }))
    );
  } else {
    const days = window === "today" ? 1 : parseInt(window, 10) || 7;
    const nowMs = Date.now();
    const dateKeys = [];
    for (let i = 0; i < days; i++) {
      dateKeys.push(easternDateKey(new Date(nowMs - i * 86400000)));
    }
    // Union of every title id that had any activity anywhere in this window.
    const indexResults = await Promise.all(dateKeys.map((d) => env.CONFIGS.get(`evtdayindex:${eventType}:${d}`)));
    const idSet = new Set();
    indexResults.forEach((raw) => {
      if (!raw) return;
      try {
        JSON.parse(raw).forEach((id) => idSet.add(id));
      } catch {
        // skip an unparseable day index rather than failing the whole window
      }
    });
    const ids = [...idSet].slice(0, CANDIDATE_CAP);
    candidates = await Promise.all(
      ids.map(async (id) => {
        const daysRaw = await env.CONFIGS.get(`evtcount:${eventType}:${id}:days`);
        let dayCounts = {};
        try {
          dayCounts = daysRaw ? JSON.parse(daysRaw) : {};
        } catch {
          dayCounts = {};
        }
        return { id, count: dateKeys.reduce((sum, d) => sum + (parseInt(dayCounts[d], 10) || 0), 0) };
      })
    );
    // An id in the day index with no data in the counts blob -- e.g. one only
    // ever tracked before the blob format shipped -- would otherwise show as a
    // real-looking row stuck at 0 forever. The other two branches cannot
    // produce one: both read the count itself rather than an index of ids.
    dropZero = true;
  }

  candidates = candidates.filter((c) => !isJunkTrackedId(c.id));
  const meta = await attachEventMeta(env, eventType, candidates.map((c) => c.id));
  const entries = candidates.map((c, i) => ({
    id: c.id,
    count: c.count,
    title: (meta[i] && meta[i].title) || c.title || c.id,
    mediaType: (meta[i] && meta[i].mediaType) || c.mediaType || "",
  }));

  const filtered = wantType ? entries.filter((e) => e.mediaType === wantType) : entries;
  const nonZero = dropZero ? filtered.filter((e) => e.count > 0) : filtered;
  nonZero.sort((a, b) => b.count - a.count);
  const topEntries = nonZero.slice(0, 100);

  // Auto-resolve raw tt... or tmdb:... IDs to real titles if missing. This is
  // also what repopulates evtmeta after it expires, and what fills it in on a
  // D1 deployment for a title first seen since the counters moved.
  await Promise.all(
    topEntries.map(async (e) => {
      if (!e.title || e.title === e.id || /^tt\d+$/i.test(e.title) || /^tmdb:\d+$/i.test(e.title)) {
        try {
          if (typeof fetchTmdbItemDetails === "function") {
            const det = await fetchTmdbItemDetails(e.id, TMDB_API_KEY, e.mediaType, "", false, env, null).catch(() => null);
            if (det && det.title) {
              e.title = det.title;
              if (!e.mediaType && det.type) e.mediaType = (det.type === "tv" || det.type === "series") ? "series" : "movie";
              if (env && env.DB) {
                env.DB.prepare(
                  `INSERT INTO event_meta (event_type, item_id, title, media_type, last_seen)
                   VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(event_type, item_id) DO UPDATE SET
                     title = excluded.title,
                     media_type = excluded.media_type,
                     last_seen = excluded.last_seen`
                ).bind(eventType, e.id, det.title, e.mediaType || "", Date.now()).run().catch(() => {});
              }
              if (env && env.CONFIGS) {
                env.CONFIGS.put(`evtmeta:${eventType}:${e.id}`, JSON.stringify({ title: det.title, mediaType: e.mediaType || "", lastSeen: Date.now() }), { expirationTtl: TELEMETRY_ALLTIME_TTL_SEC }).catch(() => {});
              }
            }
          }
        } catch {}
      }
    })
  );

  return topEntries;
}

// Lean sibling of recordTrackedEvent used only by the trending-data
// backfill (26_api-creator-and-admin-routes.js) -- updates just the
// all-time counter and metadata for a title, skipping the day-bucket and
// day-index writes recordTrackedEvent also does. Backfilling from
// existing Watch History/Custom List data has no natural "today" to
// bucket it under, and walking real historical per-day data would
// multiply KV operations well past a single Worker invocation's practical
// budget (Cloudflare's free-plan subrequest limit in particular) for any
// account with meaningful history. All-time-only is also the
// semantically correct home for this anyway: a rolling "last 7 days"
// window showing something watched two years ago wouldn't make sense
// even if it were cheap to compute. Returns true/false so the caller can
// track how many titles it actually got through this call.
async function backfillTitleCount(env, eventType, id, title, mediaType, incrementBy) {
  if (!env || !env.CONFIGS || !id || !incrementBy) return false;
  try {
    // Has to follow recordTrackedEvent onto D1, not just for the write
    // budget: computeLeaderboard reads its counts from D1 wherever D1 is
    // bound, so a backfill that only wrote KV would run to completion, report
    // its title counts, and leave the All Time board showing nothing.
    //
    // "total" only, no day bucket -- see this function's comment above.
    if (env.DB) {
      await d1BumpStat(env, `evt:${eventType}:${id}`, ["total"], incrementBy);
      await writeEventMetaIfChanged(env, eventType, id, title, mediaType);
      return true;
    }
    const totalKey = `evtcount:${eventType}:${id}:alltime`;
    const totalRaw = await env.CONFIGS.get(totalKey);
    const total = (parseInt(totalRaw, 10) || 0) + incrementBy;
    await Promise.all([
      env.CONFIGS.put(totalKey, String(total), { expirationTtl: TELEMETRY_ALLTIME_TTL_SEC }),
      writeEventMetaIfChanged(env, eventType, id, title, mediaType),
    ]);
    return true;
  } catch (e) {
    return false;
  }
}

// Anonymous search query tracking
async function recordSearchQuery(env, query) {
  if (!env || !env.CONFIGS) return;
  const q = String(query || "").trim().toLowerCase().slice(0, 60);
  if (q.length < 2) return;
  try {
    const day = statsToday();
    // A day's writes are capped across everyone (SEARCH_QUERY_RECORDS_PER_DAY):
    // the query text is part of `kind`, so distinct queries are not bounded by
    // (kind, day) at all -- they are bounded by what callers send (DATA-001).
    if (await consumeRateLimit(env, null, "searchrecord", "all", SEARCH_QUERY_RECORDS_PER_DAY, 86400)) return;
    // Same move as recordTrackedEvent above, and the same reason: three KV
    // writes per search, none of which the free plan's write budget can
    // afford. Nothing but counts here, so there is no meta to keep.
    //
    // The KV path caps unique queries per day through SEARCH_DAY_INDEX_CAP.
    // This path is capped by the daily write ceiling above instead.
    if (env.DB) {
      await d1BumpStat(env, `searchq:${q}`, ["total", day], 1);
      return;
    }
    const daysKey = `searchquery:${q}:days`;
    const totalKey = `searchquery:${q}:alltime`;
    const indexKey = `searchquerydayindex:${day}`;

    const [daysRaw, totalRaw, indexRaw] = await Promise.all([
      env.CONFIGS.get(daysKey),
      env.CONFIGS.get(totalKey),
      env.CONFIGS.get(indexKey),
    ]);
    // Same consolidated-blob shape as recordTrackedEvent above, and the
    // same reason: one JSON blob per query holding every day's count,
    // instead of one KV key per (query, day), so summing a wide window
    // costs one read per candidate query instead of one read per
    // candidate per day. See recordTrackedEvent's own comment for the
    // full story -- this is the same fix applied to the same bug in the
    // Search & Queries leaderboard.
    let dayCounts = {};
    try {
      dayCounts = daysRaw ? JSON.parse(daysRaw) : {};
    } catch {
      dayCounts = {};
    }
    dayCounts[day] = (dayCounts[day] || 0) + 1;
    const dayKeys = Object.keys(dayCounts).sort();
    if (dayKeys.length > 95) {
      dayKeys.slice(0, dayKeys.length - 95).forEach((k) => delete dayCounts[k]);
    }
    const totalCount = (parseInt(totalRaw, 10) || 0) + 1;

    let index = [];
    try {
      index = indexRaw ? JSON.parse(indexRaw) : [];
    } catch {
      index = [];
    }
    const alreadyListed = index.includes(q);
    // Written only when it actually changed -- the same waste
    // recordTrackedEvent had. This is one list per day, so the second and
    // every later search for the same term rewrote a blob identical to the
    // one already there. `listed` keeps its old meaning (is this query in
    // the day index at all) for the guard below; `indexChanged` is the
    // narrower question of whether the blob needs storing again.
    const indexChanged = !alreadyListed && index.length < SEARCH_DAY_INDEX_CAP;
    if (indexChanged) index.push(q);
    const listed = alreadyListed || indexChanged;
    // Day index full of other queries: still bump counters for a query
    // that already has keys, but do not mint a brand-new unique-query
    // pair -- that is the unbounded, user-controlled keyspace.
    if (!listed && !daysRaw && !totalRaw) return;

    const writes = [
      env.CONFIGS.put(daysKey, JSON.stringify(dayCounts), { expirationTtl: TELEMETRY_DAY_TTL_SEC }),
      env.CONFIGS.put(totalKey, String(totalCount), { expirationTtl: TELEMETRY_ALLTIME_TTL_SEC }),
    ];
    if (indexChanged) {
      writes.push(env.CONFIGS.put(indexKey, JSON.stringify(index), { expirationTtl: TELEMETRY_DAY_TTL_SEC }));
    }
    await Promise.all(writes);
  } catch (e) {}
}

async function computeSearchLeaderboard(env, window) {
  if (!env || !env.CONFIGS) return [];
  // D1 is where recordSearchQuery puts the counts when it is bound, so read
  // them back from there. Same shape of query as the Trending leaderboard
  // (see d1CountsByKindPrefix), minus the meta join -- a search term is its
  // own display value, so there is nothing to attach.
  //
  // Deployments that switched over see their Search & Queries numbers start
  // from the switchover: the KV history is still there under its existing
  // TTL, but it is not merged in. Merging would mean reading the whole KV
  // corpus on every call to add a shrinking tail of pre-switch counts to
  // rows that D1 already answers in one query, and the two would double-count
  // for any day both paths wrote.
  if (env.DB) {
    const rows = await d1CountsByKindPrefix(env, "searchq:", window, 100);
    return rows
      .map((r) => ({ query: r.key, count: r.count }))
      .filter((e) => e.count > 0)
      .slice(0, 100);
  }
  const prefix = "searchquery:";
  if (window === "alltime") {
    const listResult = await listAllKeys(env.CONFIGS, prefix);
    // Same fan-out bound as computeLeaderboard's alltime branch: one read
    // per query ever recorded, so cap the candidates before the reads.
    const SEARCH_ALLTIME_CANDIDATE_CAP = 1000;
    const alltimeKeys = listResult.keys
      .filter((k) => k.name.endsWith(":alltime"))
      .slice(0, SEARCH_ALLTIME_CANDIDATE_CAP);
    const entries = await Promise.all(
      alltimeKeys.map(async (k) => {
        const query = k.name.slice(prefix.length, -":alltime".length);
        const countRaw = await env.CONFIGS.get(k.name);
        return { query, count: parseInt(countRaw, 10) || 0 };
      })
    );
    const valid = entries.filter((e) => e.count > 0);
    valid.sort((a, b) => b.count - a.count);
    return valid.slice(0, 100);
  }

  const days = window === "today" ? 1 : parseInt(window, 10) || 7;
  const nowMs = Date.now();
  const dateKeys = [];
  for (let i = 0; i < days; i++) {
    dateKeys.push(easternDateKey(new Date(nowMs - i * 86400000)));
  }

  // Union of every query that had any activity anywhere in this window,
  // from the day-index only -- same pattern as computeLeaderboard above.
  // This used to also list()-scan the entire "searchquery:" prefix (up to
  // 1000 keys) unconditionally on every call, which pulled in every query
  // ever recorded on any day, not just this window -- defeating the
  // day-index's entire purpose and inflating the candidate set (and the
  // KV reads below) regardless of how narrow a window was actually asked
  // for. Removed rather than kept "just in case": the day-index is
  // written every time recordSearchQuery runs, so there's nothing a raw
  // prefix scan would catch that the index doesn't already have.
  const indexResults = await Promise.all(dateKeys.map((d) => env.CONFIGS.get(`searchquerydayindex:${d}`)));
  const querySet = new Set();
  indexResults.forEach((raw) => {
    if (!raw) return;
    try {
      JSON.parse(raw).forEach((q) => querySet.add(q));
    } catch {}
  });

  // Flat top-100 cap regardless of window width -- see recordSearchQuery's
  // own comment: summing a window now costs one read per candidate query
  // (the days-blob), not one per candidate per day.
  const queries = [...querySet].slice(0, 100);

  const entries = await Promise.all(
    queries.map(async (q) => {
      const daysRaw = await env.CONFIGS.get(`searchquery:${q}:days`);
      let dayCounts = {};
      try {
        dayCounts = daysRaw ? JSON.parse(daysRaw) : {};
      } catch {
        dayCounts = {};
      }
      const count = dateKeys.reduce((sum, d) => sum + (parseInt(dayCounts[d], 10) || 0), 0);
      return { query: q, count };
    })
  );
  const valid = entries.filter((e) => e.count > 0);
  valid.sort((a, b) => b.count - a.count);
  return valid.slice(0, 100);
}

// Telemetry for Stremio playback tracking. Genre and decade counters are
// batched into one JSON blob write each (bumpJsonCounterBlob above)
// instead of a separate KV key per genre -- see that function's own
// comment for the write-count math and the tradeoff it makes.
// playback_pings and watch_type stay on bumpStat as-is: playback_pings is
// the one kind here that actually has a day-by-day reader (loadStatsByDay,
// used for the dashboard's 30-day trend table), so it needs its daily key.
async function recordPlaybackTelemetry(env, mediaType, genres, releaseYear) {
  if (!env || !env.CONFIGS) return;
  try {
    const promises = [bumpStat(env, "playback_pings")];
    const mt = mediaType === "episode" ? "episode" : mediaType === "series" ? "series" : "movie";
    promises.push(bumpStat(env, `watch_type:${mt}`));

    const genreList = Array.isArray(genres)
      ? genres
      : typeof genres === "string"
      ? genres.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

    const cleanGenres = genreList.slice(0, 5).map((g) => String(g || "").trim()).filter(Boolean);
    if (cleanGenres.length) {
      promises.push(bumpJsonCounterBlob(env, "stats:genres:alltime", cleanGenres));
    }

    const yearNum = parseInt(releaseYear, 10);
    if (yearNum && yearNum > 1900 && yearNum < 2100) {
      let decade = "Classic (<1970)";
      if (yearNum >= 2020) decade = "2020s";
      else if (yearNum >= 2010) decade = "2010s";
      else if (yearNum >= 2000) decade = "2000s";
      else if (yearNum >= 1990) decade = "1990s";
      else if (yearNum >= 1980) decade = "1980s";
      else if (yearNum >= 1970) decade = "1970s";
      promises.push(bumpJsonCounterBlob(env, "stats:decades:alltime", [decade]));
    }
    await Promise.all(promises);
  } catch (e) {}
}

// Hard ceilings on what this one panel may cost, independent of how many
// stats:* keys exist.
//
// This function enumerates three prefixes and then issues one KV get per
// ":total" key it finds, so its subrequest count used to scale 1:1 with
// the size of those key spaces -- and none of the three is intrinsically
// bounded. A caller who minted enough keys (see recordListCopySlug's
// comment for how that was possible without any authentication) pushed
// this past Cloudflare's per-invocation subrequest limit, at which point
// the panel threw on every load and there was no route that could delete
// the keys again to recover it.
//
// The scan cap bounds the enumeration (one list() call per 1,000 keys);
// the read cap bounds the far more expensive per-key gets. Both are far
// above any real deployment -- a genuine install has tens of catalog
// names and source groups, not hundreds -- so this truncates abuse and
// nothing else. Truncating renders a partial panel rather than throwing,
// which is the right failure mode for a dashboard: some data beats a
// permanently broken tab.
const STAT_KEY_SCAN_CAP = 20000;
const STAT_TOTALS_READ_CAP = 500;

async function computeCatalogAndCommunityLeaderboards(env, ctx) {
  if (!env || !env.CONFIGS) return { catalogs: [], communityLists: [] };

  // 1. Installed Catalogs (combining catalog_add events and sourcegroup install counts)
  const catalogMap = new Map();
  const [catalogTotals, sourceGroupTotals] = await Promise.all([
    readStatTotalsByPrefix(env, "catalog_add:"),
    readSourceGroupTotals(env),
  ]);
  for (const [name, count] of catalogTotals) {
    if (count > 0 && name) catalogMap.set(name, (catalogMap.get(name) || 0) + count);
  }
  for (const [name, count] of sourceGroupTotals) {
    if (count > 0 && name) catalogMap.set(name, (catalogMap.get(name) || 0) + count);
  }

  const catalogEntries = Array.from(catalogMap.entries()).map(([name, count]) => ({ name, count }));
  catalogEntries.sort((a, b) => b.count - a.count);

  // 2. Community / Creator Lists
  //
  // Copy counts live under stats:list_copy:{slug}:total, one key per slug
  // that has EVER been copied. Enumerate that short prefix ONCE (it's
  // bounded by real copy activity, not by list count, and lists that have
  // never been copied have no key) rather than doing one get per list --
  // that per-list fan-out (plus the reads below) is what made this panel
  // cost ~2 subrequests per list and eventually cross the 1,000 cap.
  let copiesBySlug = new Map();
  try {
    copiesBySlug = await readStatTotalsByPrefix(env, "list_copy:");
  } catch (e) {
    // best-effort: copy counts are a ranking tiebreak, not load-bearing
  }

  // Bounded candidate set regardless of store: the panel shows 100 lists,
  // so there is no reason to read every list in the system to get there.
  const COMMUNITY_CAP = 100;
  let communityListsRaw = [];
  if (env.DB) {
    // Project only what's needed and compute the item count in SQL. This
    // used to SELECT * (pulling every list's full items_json over the wire
    // just to call .length on it) with no limit. Likes come straight from
    // the likes column (kept current by the like route), which replaces
    // the old read of `creatorlistlikes:{slug}` -- a key no code path
    // writes, so the column used to show 0 for every list.
    const { results } = await env.DB.prepare(
      "SELECT id, username, name, type, visibility, likes, created_at, updated_at, json_array_length(items_json) AS item_count FROM creator_lists WHERE visibility = 'public' ORDER BY likes DESC, updated_at DESC LIMIT ?"
    ).bind(COMMUNITY_CAP).all();
    communityListsRaw = (results || []).map((row) => ({
      slug: row.id.split(':')[1] || row.id,
      name: row.name,
      creatorName: row.username,
      type: row.type || 'mixed',
      likes: Number(row.likes) || 0,
      itemCount: Number(row.item_count) || 0,
      updatedAt: row.updated_at || row.created_at || 0,
    }));
  } else {
    // KV-only: rank from the directory index, which already carries likes,
    // itemCount and the creator's display name, and is already sorted by
    // likes (see sortPublicIndexEntries, 02_http-and-creator-utils.js).
    //
    // This replaces a bounded prefix scan that was wrong twice over:
    //
    //  * It read the alphabetically-first COMMUNITY_CAP keys and then
    //    sorted THOSE by likes, so with more lists than the cap the panel
    //    reported a lexicographic sample as "top". You cannot get the top
    //    100 by likes out of an arbitrary 100.
    //  * It then dropped every candidate without a `creatorName` field --
    //    and /api/creator/lists/save has never written one (the record is
    //    { name, slug, type, items, visibility, likes, createdAt,
    //    updatedAt }, and the creator is in the KEY). So in practice the
    //    filter discarded everything and this panel showed nothing at all
    //    whenever D1 was unbound.
    //
    // Reading the index also removes the one-KV-get-per-candidate fan-out
    // entirely: it is a single get.
    const indexEntries = await getPublicListIndex(env, ctx);
    if (indexEntries) {
      communityListsRaw = indexEntries
        .filter((e) => e && e.isCreator && (e.itemCount || 0) > 0)
        .slice(0, COMMUNITY_CAP)
        .map((e) => ({
          slug: e.slug,
          name: e.name || e.slug,
          creatorName: e.creatorName || e.username,
          type: e.type || 'mixed',
          likes: Number(e.likes) || 0,
          itemCount: Number(e.itemCount) || 0,
          updatedAt: e.updatedAt || 0,
        }));
    } else {
      // Index absent and a rebuild is already running (or could not start).
      // Bounded scan for this one request; the creator comes from the key,
      // which is where it has always actually lived.
      const listResult = await env.CONFIGS.list({ prefix: "creatorlist:", limit: COMMUNITY_CAP });
      communityListsRaw = (await Promise.all(
        (listResult.keys || []).map(async (k) => {
          const raw = await env.CONFIGS.get(k.name);
          if (!raw) return null;
          let data;
          try { data = JSON.parse(raw); } catch { return null; }
          if (!data || !isPublicListVisibility(data.visibility)) return null;
          const rest = k.name.slice("creatorlist:".length);
          const sep = rest.indexOf(":");
          if (sep === -1) return null;
          const username = rest.slice(0, sep);
          const slug = data.slug || rest.slice(sep + 1);
          if (!username || !slug) return null;
          return {
            slug,
            name: data.name || slug,
            creatorName: username,
            type: data.type || 'mixed',
            likes: Number(data.likes) || 0,
            itemCount: Array.isArray(data.items) ? data.items.length : 0,
            updatedAt: data.updatedAt || data.createdAt || 0,
          };
        })
      )).filter(Boolean);
    }
  }

  // No per-list KV reads remain: likes and itemCount already came from the
  // row/record above, copies come from the one prefix scan.
  const communityLists = communityListsRaw.map((data) => ({
    slug: data.slug,
    name: data.name || data.slug,
    creator: data.creatorName,
    type: data.type || 'mixed',
    itemCount: data.itemCount || 0,
    likes: data.likes || 0,
    copies: copiesBySlug.get(data.slug) || 0,
    updatedAt: data.updatedAt || 0,
  }));
  const validLists = communityLists.filter(Boolean);
  validLists.sort((a, b) => (b.likes + b.copies * 2) - (a.likes + a.copies * 2));

  return { catalogs: catalogEntries.slice(0, 100), communityLists: validLists.slice(0, 100) };
}

async function computeAudienceAnalytics(env) {
  if (!env || (!env.CONFIGS && !env.DB)) return { watchTypes: {}, genres: [], decades: [] };

  if (env.CONFIGS) {
    // Self-healing, same pattern as ensureTrackingMigrated elsewhere in this
    // add-on: runs the old-keys-into-new-blob migration once (see its own
    // comment), a no-op single read on every call after that.
    await migrateGenreDecadeStatsIfNeeded(env);
  }

  const [movies, series, episodes, genreBlobRaw, decadeBlobRaw] = await Promise.all([
    readStatCount(env, "watch_type:movie", "total"),
    readStatCount(env, "watch_type:series", "total"),
    readStatCount(env, "watch_type:episode", "total"),
    env.CONFIGS ? env.CONFIGS.get("stats:genres:alltime") : null,
    env.CONFIGS ? env.CONFIGS.get("stats:decades:alltime") : null,
  ]);

  const totalWatch = movies + series + episodes;

  let validGenres = null;
  let validDecades = null;

  if (env.DB) {
    try {
      const genreRows = await env.DB.prepare(
        "SELECT kind, n FROM stats WHERE kind >= ? AND kind < ? AND day = 'total' ORDER BY n DESC LIMIT 50"
      ).bind(...statKindRange("genre:")).all();
      if (genreRows && Array.isArray(genreRows.results) && genreRows.results.length > 0) {
        validGenres = genreRows.results.map((r) => ({
          name: r.kind.slice("genre:".length),
          count: Number(r.n) || 0,
        })).filter((g) => g.count > 0 && g.name);
      }
      const decadeRows = await env.DB.prepare(
        "SELECT kind, n FROM stats WHERE kind >= ? AND kind < ? AND day = 'total' ORDER BY n DESC LIMIT 50"
      ).bind(...statKindRange("decade:")).all();
      if (decadeRows && Array.isArray(decadeRows.results) && decadeRows.results.length > 0) {
        validDecades = decadeRows.results.map((r) => ({
          name: r.kind.slice("decade:".length),
          count: Number(r.n) || 0,
        })).filter((d) => d.count > 0 && d.name);
      }
    } catch {}
  }

  if (!validGenres) {
    let genreCounts = {};
    try {
      genreCounts = genreBlobRaw ? JSON.parse(genreBlobRaw) || {} : {};
    } catch {
      genreCounts = {};
    }
    validGenres = Object.entries(genreCounts)
      .map(([name, count]) => ({ name, count: parseInt(count, 10) || 0 }))
      .filter((g) => g.count > 0 && g.name);
    validGenres.sort((a, b) => b.count - a.count);
  }

  if (!validDecades) {
    let decadeCounts = {};
    try {
      decadeCounts = decadeBlobRaw ? JSON.parse(decadeBlobRaw) || {} : {};
    } catch {
      decadeCounts = {};
    }
    validDecades = Object.entries(decadeCounts)
      .map(([name, count]) => ({ name, count: parseInt(count, 10) || 0 }))
      .filter((d) => d.count > 0 && d.name);
    validDecades.sort((a, b) => b.count - a.count);
  }

  return {
    watchTypes: { movies, series, episodes, total: totalWatch },
    genres: validGenres.slice(0, 50),
    decades: validDecades.slice(0, 50),
  };
}

// The group names bumpStatBy above gets called with ultimately come from
// the client's own collectEntries() -- not attacker-controlled in the
// normal case, but /api/track-install has no auth on it (same as the
// plain pageview/install counters), so a malicious request could send
// arbitrary junk trying to spam garbage keys into KV. This caps length and
// character set rather than trusting it outright; doesn't need to be
// exhaustive, just enough that a genuine group name always passes through
// untouched.
//
// NOTE: this bounds the character set and the LENGTH of a single name, not
// the NUMBER of distinct names -- a caller sending 40-char random strings
// still mints a new key every time. That is acceptable here only because
// /api/track-install is rate-limited per IP; anywhere without a rate limit
// needs a real allowlist instead (see recordListCopySlug below, and the
// caps in computeCatalogAndCommunityLeaderboards that stop a large key
// space from breaking the dashboard whatever produced it).
function sanitizeStatGroupName(raw) {
  const s = String(raw || "").trim().slice(0, 40);
  return /^[A-Za-z0-9 &().'-]+$/.test(s) ? s : null;
}

// The "copies" column of the admin Community Lists panel is keyed by a
// list's own slug (see computeCatalogAndCommunityLeaderboards, which looks
// up copiesBySlug.get(data.slug)). The client, though, sends
// `listUrl || listName` as the event id -- a full provider URL, or a
// human-readable list title. Neither is a slug, so the stored counts
// essentially never matched anything the panel could display: the whole
// stats:list_copy: namespace was write-only.
//
// Worse, because the id was accepted verbatim (any 100 characters), every
// distinct URL or title minted two brand-new permanent KV keys from an
// endpoint with no authentication -- an unbounded key-space write
// primitive, and one that the panel above then paid one KV read per key to
// enumerate.
//
// Both problems have the same fix: only record a copy of a list that
// actually lives on THIS add-on, keyed by the slug the panel is already
// looking for. The key space is then bounded by the number of real
// published lists, and the counts land where they can actually be read.
// Copies of external provider lists are simply not counted -- which is
// what was already happening in practice, just without the storage cost.
function recordListCopySlug(rawId, origin) {
  const raw = String(rawId || "").trim();
  if (!raw || raw.length > 300) return null;
  let pathname = "";
  if (/^https?:\/\//i.test(raw)) {
    let u;
    try {
      u = new URL(raw);
    } catch {
      return null;
    }
    // Only this Worker's own list URLs. An external provider's URL is not
    // a list this dashboard can show a copy count for.
    if (origin) {
      let originHost = "";
      try {
        originHost = new URL(origin).hostname.toLowerCase();
      } catch {
        return null;
      }
      if (u.hostname.toLowerCase() !== originHost) return null;
    }
    pathname = u.pathname;
  } else {
    // Also accept a bare path, which is what a same-origin relative link
    // resolves to before the client expands it.
    if (!raw.startsWith("/")) return null;
    pathname = raw;
  }
  // /lists/{user}/{slug}  ->  {slug}
  const m = pathname.match(/^\/lists\/[^/]+\/([^/]+?)(?:\.json)?\/?$/);
  if (!m) return null;
  let slug;
  try {
    slug = decodeURIComponent(m[1]).toLowerCase();
  } catch {
    slug = m[1].toLowerCase();
  }
  // Same shape slugifyServer produces, so this can only ever name a key
  // that a real list could also have produced.
  return /^[a-z0-9][a-z0-9-]{0,80}$/.test(slug) ? slug : null;
}

// --- Putting back the counts Analytics Engine took (2026-10-02 onward) ----------
//
// From the P8-2 deploy (2026-10-02) to its fix, bumpStat, bumpStatBy,
// recordTrackedEvent and recordSearchQuery wrote to Analytics Engine INSTEAD
// of D1. Nothing reads Analytics Engine, so the admin dashboard and Most
// Watched froze. Those writes are still in the dataset (it keeps 90 days), and
// they are the only rows there whose blob1 is "stat", "event" or "search":
// the per-request metrics (writeRequestMetrics) put a route family there.
//
// This adds them to D1 the way the counters would have. Each source row
// (counter, day) is recorded as `aerecovery:<counter>` in the same batch --
// one transaction -- as the additions, and an addition only happens while that
// record is absent: a second run, or a run after a failed one, adds nothing
// twice. Needs the Analytics Engine SQL API: CF_ANALYTICS_TOKEN (an API token
// with Account Analytics: Read) and CF_ANALYTICS_ACCOUNT_ID.
const AE_RECOVERY_LEDGER_PREFIX = "aerecovery:";
const AE_RECOVERY_ROW_LIMIT = 50000;

async function analyticsEngineRows(env, sql) {
  const token = env && (env.CF_ANALYTICS_TOKEN || env.CLOUDFLARE_API_TOKEN);
  const accountId = env && (env.CF_ANALYTICS_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID);
  if (!token || !accountId) return { ok: false, error: "Set CF_ANALYTICS_TOKEN (Account Analytics: Read) and CF_ANALYTICS_ACCOUNT_ID first." };
  let res;
  try {
    res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
      body: sql + " FORMAT JSON",
    });
  } catch (err) {
    return { ok: false, error: "Analytics Engine could not be reached: " + safeErrorMessage(err) };
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) return { ok: false, error: `Analytics Engine answered ${res.status}: ${text.slice(0, 200)}` };
  let body = null;
  try { body = JSON.parse(text); } catch {}
  if (!body || !Array.isArray(body.data)) return { ok: false, error: "Analytics Engine sent an answer this could not read." };
  return { ok: true, rows: body.data };
}

// What there is to put back, per counter and day. `day` is "total" for a
// counter bumpStatBy keeps as an all-time total only.
async function readAnalyticsEngineCounts(env) {
  const dataset = String((env && env.CF_ANALYTICS_DATASET) || "mylists_events");
  if (!/^[A-Za-z0-9_]+$/.test(dataset)) return { ok: false, error: "CF_ANALYTICS_DATASET is not a dataset name." };
  const limit = ` LIMIT ${AE_RECOVERY_ROW_LIMIT}`;
  // Kept inside what the live API accepts (it refused both of these, 422):
  //  - only functions its SQL reference lists. There is no concat ("unknown
  //    function call: CONCAT"), so each query returns the raw blobs and the
  //    counter names are put together here;
  //  - GROUP BY takes column names only ("in the GROUP BY clause you may only
  //    provide column names: formatDateTime(...)"). A name given with AS
  //    counts: Cloudflare's own example groups "intDiv(...) * 60 AS t" by `t`.
  //    Not `hour` or `day`, which the SQL also has as keywords (INTERVAL).
  const sum = "SUM(_sample_interval * double1) AS n";
  // An event carries no day of its own: the day is when it was written, in
  // the Eastern time statsToday() counts in. Asked for by the hour, as a plain
  // number, and turned into the Eastern day here (an hour never straddles two
  // Eastern days), so the query needs no time zone support from the service.
  const hourOf = "toUnixTimestamp(toStartOfHour(timestamp))";
  const queries = {
    stat: {
      label: "Reading page views and other counters",
      sql: `SELECT blob2, blob3, ${sum} FROM ${dataset} WHERE blob1 = 'stat' GROUP BY blob2, blob3${limit}`,
      kindOf: (row) => String(row.blob2 || ""),
      dayOf: (row) => String(row.blob3 || ""),
    },
    event: {
      label: "Reading Most Watched and list adds",
      sql: `SELECT blob2, blob3, ${hourOf} AS event_hour, ${sum} FROM ${dataset} WHERE blob1 = 'event' GROUP BY blob2, blob3, event_hour${limit}`,
      kindOf: (row) => (row.blob2 && row.blob3 ? `evt:${row.blob2}:${row.blob3}` : ""),
      dayOf: (row) => {
        const seconds = Number(row.event_hour);
        return Number.isFinite(seconds) && seconds > 0 ? easternDateKey(new Date(seconds * 1000)) : "";
      },
    },
    search: {
      label: "Reading searches",
      sql: `SELECT blob2, blob3, ${sum} FROM ${dataset} WHERE blob1 = 'search' GROUP BY blob2, blob3${limit}`,
      kindOf: (row) => (row.blob2 ? `searchq:${row.blob2}` : ""),
      dayOf: (row) => String(row.blob3 || ""),
    },
  };
  // Rows that end up on the same counter and day (none expected) are added
  // together, so the ledger has one entry for each.
  const merged = new Map();
  const truncated = [];
  for (const [source, q] of Object.entries(queries)) {
    const r = await analyticsEngineRows(env, q.sql);
    if (!r.ok) return { ...r, error: `${q.label}: ${r.error}` };
    if (r.rows.length >= AE_RECOVERY_ROW_LIMIT) truncated.push(source);
    for (const row of r.rows) {
      const kind = q.kindOf(row);
      const day = q.dayOf(row);
      const n = Number(row.n) || 0;
      if (!kind || n <= 0 || kind.length > 300) continue;
      if (day !== "total" && !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      // bumpStatBy kept writing source groups to D1 all along.
      if (kind.startsWith("sourcegroup:")) continue;
      const key = kind + "\u0000" + day;
      const prev = merged.get(key);
      if (prev) prev.n += n;
      else merged.set(key, { source, kind, day, n });
    }
  }
  const out = [];
  for (const r of merged.values()) {
    const n = Math.round(r.n);
    if (n > 0) out.push({ ...r, n });
  }
  return { ok: true, rows: out, truncated };
}

// Preview (apply false) or put back (apply true).
async function recoverStatsFromAnalyticsEngine(env, { apply = false } = {}) {
  if (!env || !env.DB) return { ok: false, error: "No database binding." };
  const read = await readAnalyticsEngineCounts(env);
  if (!read.ok) return read;
  const rows = read.rows;
  // Which of them were put back already.
  const done = new Set();
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50);
    const { results } = await env.DB.prepare(
      `SELECT kind, day FROM stats WHERE (kind, day) IN (${chunk.map(() => "(?, ?)").join(", ")})`
    ).bind(...chunk.flatMap((r) => [AE_RECOVERY_LEDGER_PREFIX + r.kind, r.day])).all();
    for (const x of results || []) done.add(x.kind + "\u0000" + x.day);
  }
  const todo = rows.filter((r) => !done.has(AE_RECOVERY_LEDGER_PREFIX + r.kind + "\u0000" + r.day));
  const summary = { stat: 0, event: 0, search: 0 };
  for (const r of todo) summary[r.source] += r.n;
  const byKind = {};
  for (const r of todo.filter((x) => x.source === "stat")) byKind[r.kind] = (byKind[r.kind] || 0) + r.n;
  const result = {
    ok: true,
    applied: false,
    rows: rows.length,
    alreadyPutBack: rows.length - todo.length,
    toPutBack: todo.length,
    totals: summary,
    counters: Object.fromEntries(Object.entries(byKind).sort((a, b) => b[1] - a[1]).slice(0, 25)),
    truncated: read.truncated,
  };
  if (!apply || !todo.length) return result;

  // One row = its additions plus its ledger record, all conditional on that
  // record being absent; 15 rows (45 statements) per batch.
  const ledgerAbsent = "WHERE NOT EXISTS (SELECT 1 FROM stats WHERE kind = ? AND day = ?)";
  for (let i = 0; i < todo.length; i += 15) {
    const stmts = [];
    for (const r of todo.slice(i, i + 15)) {
      const ledgerKind = AE_RECOVERY_LEDGER_PREFIX + r.kind;
      const buckets = r.day === "total" ? ["total"] : ["total", r.day];
      for (const bucket of buckets) {
        stmts.push(env.DB.prepare(
          `INSERT INTO stats (kind, day, n) SELECT ?, ?, ? ${ledgerAbsent} ON CONFLICT(kind, day) DO UPDATE SET n = n + excluded.n`
        ).bind(r.kind, bucket, r.n, ledgerKind, r.day));
      }
      stmts.push(env.DB.prepare(
        "INSERT INTO stats (kind, day, n) VALUES (?, ?, ?) ON CONFLICT(kind, day) DO NOTHING"
      ).bind(ledgerKind, r.day, r.n));
    }
    await env.DB.batch(stmts);
  }
  return { ...result, applied: true };
}

// --- Counter reads -----------------------------------------------------------
//
// D1 is authoritative when bound, and falls back to KV when the row is
// ABSENT rather than reporting zero. A missing row means "not migrated
// yet", not "never happened" -- the same rule getCreator already applies to
// accounts, and the reason binding D1 does not make a dashboard's history
// vanish before the operator presses "Migrate KV -> D1". Once the migration
// has run (or once new activity lands), D1 wins and the KV copy is inert.
//
// Deliberately NOT "D1 + KV summed": /admin/api/migrate-d1 COPIES the KV
// value into D1, so summing would double every migrated counter.
async function readStatCount(env, kind, bucket) {
  if (env && env.DB) {
    try {
      const { results } = await env.DB.prepare(
        "SELECT n FROM stats WHERE kind = ? AND day = ?"
      ).bind(kind, bucket).all();
      if (results && results.length) return Number(results[0].n) || 0;
    } catch (e) {
      // Table missing (migration 0002 not applied yet) or D1 unavailable --
      // fall through to KV rather than showing zeroes.
    }
  }
  if (!env || !env.CONFIGS) return 0;
  const raw = await env.CONFIGS.get(`stats:${kind}:${bucket}`);
  return parseInt(raw, 10) || 0;
}

// Escapes the LIKE metacharacters in a literal string so it can be used as a
// prefix pattern. `%` and `_` are wildcards, and the escape character itself
// has to be escaped first or `\%` would be produced from a lone backslash.
// Pair it with `ESCAPE '\'` in the statement.
//
// SQL LIKE patterns built by concatenation are how the account purge came to
// delete other creators' rows (see purgeCreatorData,
// 02_http-and-creator-utils.js): the input there was a username, which may
// contain `_`. Nothing reaches the call sites below from a request today, but
// a helper is cheaper than remembering the rule at each new one.
// Every `stats` row whose kind starts with `prefix`, as a half-open range
// [prefix, upper) over the (kind, day) primary key. A `LIKE 'prefix%'` cannot
// use that key and scans the table; a range can (BE-H11). The upper bound is
// the prefix with its last character stepped up by one, so the range holds
// every kind that starts with the prefix and nothing else -- and it has no
// wildcards to escape, which is what the old `ESCAPE '\\'` was for (two of
// the prefixes contain `_`, LIKE's single-character wildcard).
function statKindRange(prefix) {
  const p = String(prefix == null ? "" : prefix);
  if (!p) return ["", "\uffff"];
  return [p, p.slice(0, -1) + String.fromCharCode(p.charCodeAt(p.length - 1) + 1)];
}

// All-time totals for a family of counters ("catalog_add:", "list_copy:"),
// as a Map of the name after the prefix -> count.
//
// With D1 this is one indexed query. Without it, it is the prefix scan it
// always was, still bounded by STAT_KEY_SCAN_CAP / STAT_TOTALS_READ_CAP so
// a large key space cannot push this request past Cloudflare's subrequest
// limit (see computeCatalogAndCommunityLeaderboards' own comment).
async function readStatTotalsByPrefix(env, prefix) {
  const out = new Map();
  if (!env || !env.CONFIGS) return out;
  if (env.DB) {
    try {
      // A key range, not LIKE: see statKindRange. (LIKE here needed an
      // ESCAPE clause too, because `catalog_add:` and `list_copy:` contain
      // `_`, LIKE's single-character wildcard.)
      const [lo, hi] = statKindRange(prefix);
      const { results } = await env.DB.prepare(
        "SELECT kind, n FROM stats WHERE day = 'total' AND kind >= ? AND kind < ? ORDER BY n DESC LIMIT ?"
      ).bind(lo, hi, STAT_TOTALS_READ_CAP).all();
      if (results && results.length) {
        for (const row of results) {
          const name = String(row.kind).slice(prefix.length);
          if (name) out.set(name, Number(row.n) || 0);
        }
        return out;
      }
      // No rows: fall through to KV, same "not migrated yet" rule as
      // readStatCount.
    } catch (e) {
      // Table missing or D1 unavailable -- fall through to KV.
    }
  }
  const listed = await listAllKeys(env.CONFIGS, `stats:${prefix}`, STAT_KEY_SCAN_CAP);
  const totalKeys = (listed.keys || [])
    .filter((k) => k.name.endsWith(":total"))
    .slice(0, STAT_TOTALS_READ_CAP);
  await Promise.all(
    totalKeys.map(async (k) => {
      const raw = await env.CONFIGS.get(k.name);
      const count = parseInt(raw, 10) || 0;
      const name = k.name.slice(`stats:${prefix}`.length, -":total".length);
      if (name) out.set(name, count);
    })
  );
  return out;
}

// Source groups keep their own table and their own migrate-d1 branch (see
// bumpStatBy), so they are read separately from the generic stats table --
// this mirrors the split renderAdminDashboard already makes.
async function readSourceGroupTotals(env) {
  const out = new Map();
  if (!env || !env.CONFIGS) return out;
  if (env.DB) {
    try {
      const { results } = await env.DB.prepare(
        "SELECT name, install_count FROM source_groups ORDER BY install_count DESC LIMIT ?"
      ).bind(STAT_TOTALS_READ_CAP).all();
      if (results && results.length) {
        for (const row of results) out.set(row.name, Number(row.install_count) || 0);
        return out;
      }
    } catch (e) {
      // fall through to KV
    }
  }
  return readStatTotalsByPrefix({ CONFIGS: env.CONFIGS }, "sourcegroup:");
}

// Reads every stats:{kind}:YYYY-MM-DD entry via a prefix list (there's no
// KV range-query, so this is the only way to enumerate them) and returns a
// { "YYYY-MM-DD": count } map, skipping the :total key itself.
async function loadStatsByDay(env, kind) {
  if (!env || !env.CONFIGS) return {};
  if (env.DB) {
    try {
      const { results } = await env.DB.prepare(
        "SELECT day, n FROM stats WHERE kind = ? AND day != 'total'"
      ).bind(kind).all();
      // Same fallback rule as readStatCount: no rows at all means this
      // counter has not been migrated yet, so read KV instead of drawing an
      // empty chart. One real day bucket is enough to trust D1.
      if (results && results.length) {
        const byDay = {};
        for (const row of results) byDay[row.day] = Number(row.n) || 0;
        return byDay;
      }
    } catch (e) {
      // Table missing or D1 unavailable -- fall through to the KV scan.
    }
  }
  const prefix = `stats:${kind}:`;
  const result = await listAllKeys(env.CONFIGS, prefix);
  const byDay = {};
  await Promise.all(
    result.keys.map(async (k) => {
      const day = k.name.slice(prefix.length);
      if (day === "total") return;
      const raw = await env.CONFIGS.get(k.name);
      byDay[day] = parseInt(raw, 10) || 0;
    })
  );
  return byDay;
}

// HMAC-SHA256 via the Workers runtime's native Web Crypto API, same
// approach as hashStringForKey above -- used to sign the admin session
// cookie so it can't be forged without knowing ADMIN_KEY, without needing
// any server-side session storage (the cookie IS the session: an
// expiry timestamp plus a signature over that timestamp).
async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const ADMIN_COOKIE_NAME = "mla_admin";
const ADMIN_SESSION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function makeAdminCookieValue(env) {
  const expiresAt = Date.now() + ADMIN_SESSION_MS;
  const sig = await hmacHex(env.ADMIN_KEY, String(expiresAt));
  return `${expiresAt}.${sig}`;
}

async function isValidAdminCookie(env, value) {
  if (!value || !env || !env.ADMIN_KEY) return false;
  const dot = value.indexOf(".");
  if (dot === -1) return false;
  const expiresAtStr = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expiresAt = parseInt(expiresAtStr, 10);
  if (!expiresAt || Date.now() > expiresAt) return false;
  const expectedSig = await hmacHex(env.ADMIN_KEY, expiresAtStr);
  return timingSafeEqualHex(sig, expectedSig);
}

function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const map = {};
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) {
      try {
        map[k] = decodeURIComponent(v);
      } catch {
        map[k] = v;
      }
    }
  });
  return map;
}

// --- P7-2: who the admin is, revocable sessions, and the audit log ----------
//
// Before this, one shared ADMIN_KEY was the whole of the admin's identity: the
// cookie was an HMAC over its own expiry, so it could not be revoked (only
// rotating the key signed anyone out), it named nobody, and nothing recorded
// what the dashboard did with the power it holds -- which includes rotating any
// creator's key. S-10. Three things changed:
//
//  1. Cloudflare Access first. When CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD are
//     set, a request carrying a valid Access JWT (Cf-Access-Jwt-Assertion) IS
//     the admin, named by the email in it. The signature is verified against
//     the team's own certs -- a header alone is not proof, since anyone who can
//     reach the Worker directly could set one. See docs/OPERATIONS.md section
//     25 for turning Access on; nothing here is required for the dashboard to
//     work.
//  2. A session that is a row. Signing in with the key (break-glass) or through
//     Access creates an admin_sessions row; the cookie carries an opaque token,
//     only its SHA-256 is stored, and a row can be revoked on its own. The old
//     signed cookie still validates, so a browser signed in before this deploy
//     is not thrown out, and a Worker with no D1 bound behaves exactly as it
//     did -- sign-in must never depend on a migration having been applied.
//  3. An audit row per login, logout and mutating admin request, written here
//     because this IS the one place every admin route already goes through
//     (39 call sites). See recordAdminAudit.

// The team's own certs. Cached per isolate for five minutes: they rotate about
// once a year, and a fetch on every admin request would put Cloudflare's Access
// service on the dashboard's own critical path.
const ADMIN_ACCESS_JWKS_TTL_MS = 5 * 60 * 1000;
const ADMIN_ACCESS_JWKS = { keys: null, url: "", fetchedAt: 0 };
// One warning per distinct rejected token per isolate, so a flood of forged
// headers cannot fill the log (same shape as the CSP report sink, 02_).
const ADMIN_ACCESS_WARNED = new Set();
const ADMIN_ACCESS_WARN_MAX = 100;

function adminAccessTeam(env) {
  const raw = String((env && env.CF_ACCESS_TEAM_DOMAIN) || "").trim();
  if (!raw) return "";
  return raw.replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
}

// Access is on when BOTH are set. The AUD tag is what says which Access
// application this is: without it, a token minted for any other Access app in
// the same account would open this dashboard.
function adminAccessConfigured(env) {
  return !!(adminAccessTeam(env) && String((env && env.CF_ACCESS_AUD) || "").trim());
}

function adminBase64UrlToBytes(value) {
  const s = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = s + (s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "");
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function adminBase64UrlToText(value) {
  try {
    return new TextDecoder().decode(adminBase64UrlToBytes(value));
  } catch {
    return "";
  }
}

async function adminAccessKeys(env) {
  const team = adminAccessTeam(env);
  const url = "https://" + team + "/cdn-cgi/access/certs";
  const now = Date.now();
  if (ADMIN_ACCESS_JWKS.keys && ADMIN_ACCESS_JWKS.url === url && now - ADMIN_ACCESS_JWKS.fetchedAt < ADMIN_ACCESS_JWKS_TTL_MS) {
    return ADMIN_ACCESS_JWKS.keys;
  }
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res || !res.ok) throw new Error("access certs: HTTP " + (res ? res.status : "no response"));
  const jwks = await res.json();
  const keys = (jwks && jwks.keys) || [];
  if (!keys.length) throw new Error("access certs: no keys");
  ADMIN_ACCESS_JWKS.keys = keys;
  ADMIN_ACCESS_JWKS.url = url;
  ADMIN_ACCESS_JWKS.fetchedAt = now;
  return keys;
}

// Returns the Access identity ({ email, sub }) or null. Null means "this
// request is not an Access identity", which is not the same as invalid: a
// browser that signed in with the key has no JWT at all and is handled next.
async function adminAccessIdentity(request, env) {
  if (!adminAccessConfigured(env) || !request) return null;
  const token = request.headers.get("Cf-Access-Jwt-Assertion") || request.headers.get("cf-access-jwt-assertion") || "";
  if (!token) return null;
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(adminBase64UrlToText(parts[0]) || "{}");
    if (header.alg !== "RS256" || !header.kid) return null;
    const keys = await adminAccessKeys(env);
    const jwk = keys.find((k) => k && k.kid === header.kid);
    if (!jwk) return null;
    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty || "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      adminBase64UrlToBytes(parts[2]),
      new TextEncoder().encode(parts[0] + "." + parts[1])
    );
    if (!ok) throw new Error("signature");
    const claims = JSON.parse(adminBase64UrlToText(parts[1]) || "{}");
    const nowSec = Math.floor(Date.now() / 1000);
    if (!(typeof claims.exp === "number" && claims.exp > nowSec)) throw new Error("expired");
    if (typeof claims.nbf === "number" && claims.nbf > nowSec + 60) throw new Error("not yet valid");
    if (claims.iss !== "https://" + adminAccessTeam(env)) throw new Error("issuer");
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(String(env.CF_ACCESS_AUD).trim())) throw new Error("audience");
    const email = String(claims.email || "").trim().toLowerCase();
    if (!email) throw new Error("no email on the token");
    // Optional second lock: Access decides who may reach /admin, this decides
    // who may use it. Comma-separated FF_ADMIN_EMAILS.
    const allow = String((env && env.FF_ADMIN_EMAILS) || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (allow.length && !allow.includes(email)) throw new Error("not an allowed admin email");
    return { email: email, sub: String(claims.sub || "") };
  } catch (err) {
    const why = String((err && err.message) || err);
    const key = why + ":" + String(token).slice(-12);
    if (!ADMIN_ACCESS_WARNED.has(key) && ADMIN_ACCESS_WARNED.size < ADMIN_ACCESS_WARN_MAX) {
      ADMIN_ACCESS_WARNED.add(key);
      console.warn("[admin] refused a Cloudflare Access token:", why);
    }
    return null;
  }
}

// --- admin sessions (a revocable row per signed-in browser) -----------------

function adminSessionActorForAccess(identity) {
  return identity && identity.email ? "access:" + identity.email : "key";
}

async function createAdminSession(env, actor, request) {
  if (!env || !env.DB) return null;
  const id = bufferToHex(crypto.getRandomValues(new Uint8Array(16)));
  const secret = bufferToHex(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await hashSessionToken(secret);
  const now = Date.now();
  const ip = clientIpKey(request) || null;
  let userAgent = "";
  try {
    userAgent = String((request && request.headers.get("User-Agent")) || "").slice(0, 200);
  } catch {}
  try {
    // Expired rows go first, so a long-lived deployment does not accumulate
    // them. Best effort: a failure here must not stop a sign-in.
    await env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at < ?").bind(now).run().catch(() => {});
    await env.DB.prepare(
      "INSERT INTO admin_sessions (id, token_hash, actor, created_at, last_seen_at, expires_at, revoked_at, ip, user_agent) " +
      "VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)"
    ).bind(id, tokenHash, actor, now, now, now + ADMIN_SESSION_MS, ip, userAgent || null).run();
  } catch (e) {
    // No admin_sessions table (migration 0018 not applied yet) -- fall back to
    // the old stateless cookie. Never fail a sign-in over this.
    if (!/no such table/i.test(String((e && e.message) || e))) console.error("admin session: create failed:", e);
    return null;
  }
  return { id: id, token: id + "." + secret, actor: actor, expiresAt: now + ADMIN_SESSION_MS };
}

// The cookie's two halves: 32 hex characters that name the row, and the secret
// whose hash is what the row stores. A revoked row stops working the moment it
// is revoked, unlike the signed cookie it replaces.
async function resolveAdminSession(env, cookieValue) {
  if (!env || !env.DB || !cookieValue) return null;
  const dot = String(cookieValue).indexOf(".");
  if (dot === -1) return null;
  const id = String(cookieValue).slice(0, dot);
  const secret = String(cookieValue).slice(dot + 1);
  if (!/^[0-9a-f]{32}$/.test(id) || !secret) return null;
  const tokenHash = await hashSessionToken(secret);
  const now = Date.now();
  try {
    const { results } = await env.DB.prepare(
      "SELECT id, token_hash, actor, last_seen_at, expires_at, revoked_at FROM admin_sessions WHERE id = ?"
    ).bind(id).all();
    const row = results && results[0];
    if (!row) return null;
    if (row.revoked_at != null) return null;
    if (typeof row.expires_at === "number" && row.expires_at <= now) return null;
    if (!timingSafeEqualHex(String(row.token_hash || ""), tokenHash)) return null;
    // At most one write an hour per browser: last_seen_at is a convenience,
    // not a security property, and D1 writes are the scarce thing here.
    if (typeof row.last_seen_at === "number" && now - row.last_seen_at > 60 * 60 * 1000) {
      env.DB.prepare("UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?").bind(now, id).run().catch(() => {});
    }
    return { id: row.id, actor: row.actor, expiresAt: row.expires_at };
  } catch (e) {
    if (!/no such table/i.test(String((e && e.message) || e))) console.error("admin session: lookup failed:", e);
    return null;
  }
}

async function revokeAdminSessionById(env, id) {
  if (!env || !env.DB || !id) return false;
  try {
    const res = await env.DB.prepare("UPDATE admin_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .bind(Date.now(), String(id)).run();
    return !!(res && res.meta && res.meta.changes > 0);
  } catch (e) {
    if (!/no such table/i.test(String((e && e.message) || e))) console.error("admin session: revoke failed:", e);
    return false;
  }
}

async function revokeAllAdminSessions(env, actor) {
  if (!env || !env.DB) return 0;
  try {
    const now = Date.now();
    const res = actor
      ? await env.DB.prepare("UPDATE admin_sessions SET revoked_at = ? WHERE revoked_at IS NULL AND actor = ?").bind(now, actor).run()
      : await env.DB.prepare("UPDATE admin_sessions SET revoked_at = ? WHERE revoked_at IS NULL").bind(now).run();
    return (res && res.meta && res.meta.changes) || 0;
  } catch (e) {
    if (!/no such table/i.test(String((e && e.message) || e))) console.error("admin session: revoke-all failed:", e);
    return 0;
  }
}

// Same cookie, same attributes as the signed value it replaces -- only the
// value's meaning changed (an id, then the session's secret). Strict is
// deliberate and unchanged: nothing outside this site has any business
// carrying an admin cookie.
function adminSessionCookieHeader(token) {
  return `${ADMIN_COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(ADMIN_SESSION_MS / 1000)}`;
}

// Reads the cookie back out of a request and revokes the row it names.
async function revokeAdminSessionFromRequest(request, env) {
  const cookies = parseCookies(request);
  const value = cookies[ADMIN_COOKIE_NAME] || "";
  const id = String(value).slice(0, String(value).indexOf("."));
  if (!/^[0-9a-f]{32}$/.test(id)) return false;
  return revokeAdminSessionById(env, id);
}

async function listAdminSessions(env, limit = 50) {
  if (!env || !env.DB) return { ok: true, sessions: [], unavailable: "no-d1" };
  const now = Date.now();
  try {
    await env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at < ?").bind(now).run().catch(() => {});
    const { results } = await env.DB.prepare(
      "SELECT id, actor, created_at, last_seen_at, expires_at, revoked_at, ip, user_agent FROM admin_sessions " +
      "ORDER BY last_seen_at DESC LIMIT ?"
    ).bind(Math.max(1, Math.min(200, limit))).all();
    return {
      ok: true,
      sessions: (results || []).map((r) => ({
        id: r.id,
        actor: r.actor,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at,
        expiresAt: r.expires_at,
        revokedAt: r.revoked_at == null ? null : r.revoked_at,
        ip: r.ip || "",
        userAgent: r.user_agent || "",
        expired: typeof r.expires_at === "number" && r.expires_at <= now,
      })),
    };
  } catch (e) {
    if (/no such table/i.test(String((e && e.message) || e))) return { ok: true, sessions: [], unavailable: "migration-0018" };
    console.error("admin session: list failed:", e);
    return { ok: false, sessions: [], error: "Could not read the session list." };
  }
}

// --- the audit log ----------------------------------------------------------

// What each mutating admin route is called in the log. A route that is not
// listed falls back to its own path (admin.api.<path with dots>), so a new
// admin route is audited the moment it exists rather than only once someone
// remembers to add it here. GETs are never audited except the few paths named
// in ADMIN_AUDIT_GET_MUTATORS, which change state behind a GET.
const ADMIN_AUDIT_ACTIONS = {
  "/admin/api/reset-creator-key": "admin.creator.reset-key",
  "/admin/api/rebuild-search-index": "admin.search.rebuild",
  "/admin/api/rebuild-public-index": "admin.search.rebuild",
  "/admin/api/delete-creator-list": "admin.list.delete",
  "/admin/api/delete-published-list": "admin.published-list.delete",
  "/admin/api/channel-moderate": "admin.channel.moderate",
  "/admin/api/channel-presets/rebuild": "admin.channel-presets.rebuild",
  "/admin/api/channel-presets/clear": "admin.channel-presets.clear",
  "/admin/api/feedback/reply": "admin.feedback.reply",
  "/admin/api/feedback/edit": "admin.feedback.edit",
  "/admin/api/feedback/delete": "admin.feedback.delete",
  "/admin/api/feedback/status": "admin.feedback.set-status",
  "/admin/api/migrate-d1": "admin.migrate.kv-to-d1",
  "/admin/api/migrate-accounts": "admin.migrate.accounts",
  "/admin/api/migrate-day-counts": "admin.migrate.day-counts",
  "/admin/api/backfill-trending": "admin.backfill.trending",
  "/admin/api/recover-stats-from-analytics": "admin.recover.stats-from-analytics",
  "/admin/api/support-goal": "admin.support-goal.set",
  "/admin/api/new-on-streaming/sweep": "admin.new-on-streaming.sweep",
  "/admin/api/new-on-streaming/add": "admin.new-on-streaming.add",
  "/admin/api/installs/restore": "admin.installs.undo-move",
  "/admin/api/lists-backfill/step": "admin.backfill.lists",
  "/admin/api/lists-backfill/restart": "admin.backfill.lists.restart",
  "/admin/api/activity-backfill/step": "admin.backfill.activity",
  "/admin/api/activity-backfill/restart": "admin.backfill.activity.restart",
  "/admin/api/jobs/ping": "admin.jobs.test",
  "/admin/api/jobs/shelf-shadow-now": "admin.jobs.shelf-compare",
  "/admin/api/revoke-admin-session": "admin.session.revoke",
  "/admin/api/revoke-all-admin-sessions": "admin.session.revoke-all",
};
const ADMIN_AUDIT_GET_MUTATORS = new Set(["/admin/api/migrate-accounts"]);
// Body fields worth keeping. Nothing else is read, so a field this list does
// not name cannot end up in the log -- including, deliberately, any key or
// token an admin form might carry. `slugs` is here for the delete flows.
const ADMIN_AUDIT_BODY_FIELDS = [
  "username", "creatorName", "slug", "slugs", "name", "listName", "channelId", "networkId",
  "feedbackId", "id", "ids", "status", "action", "day", "job", "nonce", "reason",
];
const ADMIN_AUDIT_VALUE_MAX = 200;
const ADMIN_AUDIT_DETAIL_MAX = 600;

function adminAuditActionFor(path) {
  if (ADMIN_AUDIT_ACTIONS[path]) return ADMIN_AUDIT_ACTIONS[path];
  const rest = String(path || "").replace(/^\/admin\/api\//, "").replace(/[^A-Za-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "");
  return rest ? "admin.api." + rest : "admin.api";
}

function adminAuditIsMutating(method, path) {
  if (!path || path.indexOf("/admin/api/") !== 0) return false;
  if (ADMIN_AUDIT_GET_MUTATORS.has(path)) return true;
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

// The identifying fields of a request body, as a short JSON string. The body is
// read from a CLONE: the route still has to be able to read it itself.
async function adminAuditDetail(request, path) {
  try {
    const contentType = String(request.headers.get("Content-Type") || "");
    if (contentType.indexOf("application/json") === -1) return { target: "", detail: "" };
    const clone = request.clone();
    const text = await clone.text();
    if (!text || text.length > 20000) return { target: "", detail: "" };
    const body = JSON.parse(text);
    if (!body || typeof body !== "object") return { target: "", detail: "" };
    const picked = {};
    for (const field of ADMIN_AUDIT_BODY_FIELDS) {
      if (body[field] === undefined || body[field] === null) continue;
      const value = String(body[field]);
      picked[field] = value.length > ADMIN_AUDIT_VALUE_MAX ? value.slice(0, ADMIN_AUDIT_VALUE_MAX) + "\u2026" : value;
    }
    const keys = Object.keys(picked);
    if (!keys.length) return { target: "", detail: "" };
    // Which field is "what it was done to" differs per route, so the order is
    // most-specific-first: a slug or an id names one row, a username names an
    // account, and anything else is left to the detail string.
    const target = String(
      picked.slug || picked.slugs || picked.channelId || picked.networkId ||
      picked.feedbackId || picked.username || picked.creatorName || picked.job || picked.day || picked.id || ""
    ).slice(0, 120);
    let detail = JSON.stringify(picked);
    if (detail.length > ADMIN_AUDIT_DETAIL_MAX) detail = detail.slice(0, ADMIN_AUDIT_DETAIL_MAX);
    return { target: target, detail: detail };
  } catch {
    return { target: "", detail: "" };
  }
}

// Best effort, always: the dashboard must not fail because its log could not be
// written, and a failed write is reported to the console instead. `status` is
// filled in only where the caller already knows it (login, logout, revoke);
// an audited route's row is written when the request is authorized, which is
// what makes this one place able to cover all of them -- see isAdminRequest.
async function recordAdminAudit(env, request, actor, action, detail, status) {
  if (!env || !env.DB) {
    console.warn("[admin] " + action + " by " + (actor || "unknown") + (detail && detail.detail ? " " + detail.detail : "") + " (no D1, not recorded)");
    return false;
  }
  const info = detail || {};
  const now = Date.now();
  let ip = null;
  try {
    ip = clientIpKey(request) || null;
  } catch {}
  let userAgent = "";
  try {
    userAgent = String((request && request.headers.get("User-Agent")) || "").slice(0, 200);
  } catch {}
  try {
    await env.DB.prepare(
      "INSERT INTO admin_audit_log (at, actor, action, target, detail, status, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(now, String(actor || "unknown"), String(action || "admin.unknown"), info.target || null, info.detail || null,
      typeof status === "number" ? status : null, ip, userAgent || null).run();
    // A bounded log: the newest 5,000 rows are plenty, and this keeps a busy
    // dashboard (or a scripted one) from growing the table forever.
    if (Math.random() < 0.02) {
      await env.DB.prepare("DELETE FROM admin_audit_log WHERE id <= (SELECT MAX(id) - 5000 FROM admin_audit_log)").run().catch(() => {});
    }
    return true;
  } catch (e) {
    if (!/no such table/i.test(String((e && e.message) || e))) console.error("admin audit: write failed:", e);
    return false;
  }
}

async function listAdminAudit(env, limit = 100) {
  if (!env || !env.DB) return { ok: true, entries: [], unavailable: "no-d1" };
  try {
    const { results } = await env.DB.prepare(
      "SELECT id, at, actor, action, target, detail, status, ip FROM admin_audit_log ORDER BY at DESC, id DESC LIMIT ?"
    ).bind(Math.max(1, Math.min(500, limit))).all();
    return { ok: true, entries: (results || []).map((r) => ({
      id: r.id, at: r.at, actor: r.actor, action: r.action, target: r.target || "",
      detail: r.detail || "", status: r.status == null ? null : r.status, ip: r.ip || "",
    })) };
  } catch (e) {
    if (/no such table/i.test(String((e && e.message) || e))) return { ok: true, entries: [], unavailable: "migration-0018" };
    console.error("admin audit: read failed:", e);
    return { ok: false, entries: [], error: "Could not read the audit log." };
  }
}

// One request, one audit row for the mutating routes. A WeakSet on the Request
// object: the row is written the first time a route asks whether this request
// is an admin, and never twice, even though several routes check twice.
const ADMIN_AUDITED_REQUESTS = new WeakSet();

async function auditMutatingAdminRequest(request, env, actor, path, method) {
  if (!adminAuditIsMutating(method, path)) return;
  try {
    if (ADMIN_AUDITED_REQUESTS.has(request)) return;
    ADMIN_AUDITED_REQUESTS.add(request);
  } catch {
    return;
  }
  const info = await adminAuditDetail(request, path);
  await recordAdminAudit(env, request, actor, adminAuditActionFor(path), info, undefined);
}

// Who this request is, or null. In order: a Cloudflare Access identity, then a
// live admin session row, then the break-glass signed cookie (ADMIN_KEY).
async function resolveAdminIdentity(request, env) {
  const identity = await adminAccessIdentity(request, env);
  if (identity) return { actor: adminSessionActorForAccess(identity), via: "access", identity: identity };
  const cookies = parseCookies(request);
  const session = await resolveAdminSession(env, cookies[ADMIN_COOKIE_NAME]);
  if (session) return { actor: session.actor, via: "session", session: session };
  if (await isValidAdminCookie(env, cookies[ADMIN_COOKIE_NAME])) {
    return { actor: "key", via: "key" };
  }
  return null;
}

async function isAdminRequest(request, env) {
  const identity = await resolveAdminIdentity(request, env);
  if (!identity) return false;
  let path = "";
  let method = "GET";
  try {
    path = new URL(request.url).pathname;
    method = String(request.method || "GET").toUpperCase();
  } catch {}
  // Awaiting the audit here (not after the route) is what lets ONE place cover
  // every admin route: this call is the gate they all pass through. It records
  // that the request was authorized; the outcome is on the route's own
  // response, and the log's status column is filled in where a handler can see
  // it (login, logout, session revoke).
  await auditMutatingAdminRequest(request, env, identity.actor, path, method).catch(() => {});
  return true;
}

// `accessOn` says Cloudflare Access is configured for this deployment (P7-2).
// The page still offers the key box -- Access can be misconfigured or an admin
// may be reaching the Worker by a hostname Access does not cover, and being
// unable to sign in at all is worse than a longer page. The note says which is
// which, so a locked-out admin knows to look at Access rather than at the key.
function renderAdminLoginPage(errorMsg, accessOn) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#F2F2F7">
<title>Admin \u2014 ${ADDON_NAME}</title>
<link rel="icon" type="image/png" href="/icon.png">
<!-- The device's own fonts (P7-1) -- this page used to pull Inter, Space
     Grotesk and JetBrains Mono from Google Fonts. See docs/DECISIONS.md D-20. -->
<script nonce="${CSP_NONCE_PLACEHOLDER}">
  if (localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark-theme');
  }
</script>
<style nonce="${CSP_NONCE_PLACEHOLDER}">
${DESIGN_TOKENS_CSS}
${UTILITY_CSS}
  * { box-sizing: border-box; }
  body {
    font-family: var(--font-body);
    margin: 0;
    min-height: 100vh;
    background: var(--bg);
    color: var(--text);
    font-size: 15px;
    -webkit-font-smoothing: antialiased;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px 16px;
  }
  .login-wrap { width: 100%; max-width: 380px; }
  .login-header {
    display: flex; align-items: center; justify-content: center; gap: 10px;
    margin-bottom: 20px;
  }
  .login-header img { width: 36px; height: 36px; border-radius: 10px; box-shadow: var(--shadow-sm); }
  .login-header span { font-size: 1.2rem; font-weight: 800; letter-spacing: -0.02em; color: var(--text); }
  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-sm);
    padding: 20px;
    width: 100%;
  }
  .panel-title { font-size: 1.1rem; font-weight: 700; margin: 0 0 14px; letter-spacing: -0.01em; color: var(--text); }
  .row { display: flex; flex-direction: column; align-items: stretch; gap: 10px; margin-bottom: 0; width: 100%; }
  input {
    width: 100%;
    padding: 11px 14px;
    border-radius: var(--radius-sm);
    border: 1.5px solid var(--border-strong);
    background: var(--surface);
    color: var(--text);
    outline: none;
    font-size: 16px;
    font-family: inherit;
    min-height: 44px;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(0,122,255,0.15); }
  button {
    width: 100%;
    margin-top: 14px;
    padding: 11px 18px;
    min-height: 44px;
    border-radius: var(--radius-pill);
    border: none;
    background: var(--accent);
    color: #fff;
    cursor: pointer;
    font-weight: 600;
    font-size: 0.925rem;
    font-family: inherit;
    transition: opacity 0.12s;
  }
  button:hover { opacity: 0.85; }
  .err { color: var(--danger); margin: 14px 0 0; font-size: 0.85rem; }
</style></head>
<body>
  <div class="login-wrap">
    <div class="login-header">
      <img src="/icon.png" alt="${ADDON_NAME}">
      <span>${ADDON_NAME}</span>
    </div>
    <div class="panel">
      <h2 class="panel-title">Admin sign in</h2>
      ${accessOn
        ? `<p class="u-c-v_text_2 u-m-0_0_14px u-fs-v_font_size_sm u-lh-1_45">Cloudflare Access is <strong>on</strong> for this dashboard. If you reached this page through Access, you are already signed in &mdash; <a href="/admin" class="u-c-v_accent">open the dashboard</a>.<br>If you are seeing this instead, Access did not let the request through (check the Access application&rsquo;s policy for <code>/admin</code>), or this hostname is not covered by it. The key below is the break-glass way in.</p>`
        : ""}
      <form method="POST" action="/admin/login">
        <div class="row">
          <input type="password" name="key" placeholder="Admin key" autofocus>
        </div>
        <button type="submit">Sign in</button>
      </form>
      ${errorMsg ? `<p class="err">${escapeHtmlServer(errorMsg)}</p>` : ""}
    </div>
  </div>
</body></html>`;
}

// The arguments of a delegated control on /admin, as one attribute value.
//
// Same contract as the builder page's appActArgs (16_client-row-core.js) and
// the same pair of functions: this one runs in the Worker, while the page's
// own script carries adminActAttr, its browser-side twin, for the markup that
// script builds itself. /admin does not load the builder's bundle -- it is its
// own document with its own script -- so it carries its own copy of the
// contract (P6-10).
//
// Encoded once, escaped once: JSON.stringify makes the arguments data (a
// display name with a quote in it is a string in an array, not a way out of
// the attribute) and escapeHtmlServer makes them markup. The dispatcher
// JSON.parses the attribute and never evaluates it.
function adminActArgs(values) {
  const out = [];
  const list = values || [];
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    out.push(v === undefined || v === null ? "" : v);
  }
  return escapeHtmlServer(JSON.stringify(out));
}

// --- The support goal (the strip at the top of Catalogs) ---------------------
//
// What the Ko-fi support strip shows: a monthly hosting goal and how much has
// been given so far this month, both typed in under Management & Tools ->
// Support Goal. It stays hidden until it is turned on there. The amount given
// belongs to the month it was entered in and counts as 0 in the next one, so
// the bar starts over on the 1st by itself.
const SUPPORT_GOAL_KEY = "support:goal:v1";
const SUPPORT_GOAL_URL = "https://ko-fi.com/mylistsaddon";
// Ko-fi's webhook (POST /api/kofi-webhook, below) adds each USD donation to the
// month's total by itself. These are the payment types it counts: tips and
// monthly memberships. Commissions and shop orders are sales, not support.
const KOFI_COUNTED_TYPES = new Set(["Donation", "Subscription"]);
const KOFI_WEBHOOK_BODY_MAX = 20000;
const KOFI_MESSAGE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const SUPPORT_GOAL_MAX = 100000;

function supportGoalMonth(now = new Date()) {
  return easternDateKey(now).slice(0, 7);
}

// What is stored, as it is read: always complete, whatever was written.
async function readSupportGoal(env) {
  let stored = null;
  try {
    const raw = env && env.CONFIGS ? await env.CONFIGS.get(SUPPORT_GOAL_KEY) : null;
    stored = raw ? JSON.parse(raw) : null;
  } catch {
    stored = null;
  }
  const s = stored && typeof stored === "object" ? stored : {};
  const num = (v, max) => (Number.isFinite(v) && v >= 0 ? Math.min(max, Math.round(v * 100) / 100) : 0);
  return {
    enabled: s.enabled === true,
    goal: num(s.goal, SUPPORT_GOAL_MAX),
    raised: num(s.raised, SUPPORT_GOAL_MAX * 10),
    raisedMonth: typeof s.raisedMonth === "string" ? s.raisedMonth : "",
    updatedAt: Number.isFinite(s.updatedAt) ? s.updatedAt : 0,
    // The last payment Ko-fi told us about, for the admin page.
    lastPayment: s.lastPayment && Number.isFinite(s.lastPayment.at) && Number.isFinite(s.lastPayment.amount)
      ? { at: s.lastPayment.at, amount: s.lastPayment.amount }
      : null,
  };
}

// One Ko-fi payment (the webhook's `data` object) as a dollar amount to count,
// or null when it is not one: the wrong type, not US dollars (the goal is in
// dollars, and there is no exchange rate to convert with), or a number that
// makes no sense. Whether the donor chose to be public does not matter here:
// only the total is ever shown, never who gave.
function kofiAmountToCount(data) {
  if (!data || typeof data !== "object") return null;
  if (!KOFI_COUNTED_TYPES.has(String(data.type || ""))) return null;
  if (String(data.currency || "").toUpperCase() !== "USD") return null;
  const amount = Number(data.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > SUPPORT_GOAL_MAX) return null;
  return Math.round(amount * 100) / 100;
}

// The stored goal with one payment added to the month's total. A total that
// belongs to an earlier month starts again from 0 first.
function addKofiPaymentToSupportGoal(stored, amount, now = new Date()) {
  const month = supportGoalMonth(now);
  const base = stored.raisedMonth === month ? stored.raised : 0;
  return {
    ...stored,
    raised: Math.round((base + amount) * 100) / 100,
    raisedMonth: month,
    lastPayment: { at: now.getTime(), amount },
    updatedAt: now.getTime(),
  };
}

// What the page gets: nothing at all until it is on and has a goal, and the
// month's amount only while it is still that month's.
function publicSupportGoal(stored, now = new Date()) {
  const month = supportGoalMonth(now);
  const on = stored.enabled && stored.goal > 0;
  return {
    enabled: on,
    goal: on ? stored.goal : 0,
    raised: on && stored.raisedMonth === month ? stored.raised : 0,
    month,
    url: SUPPORT_GOAL_URL,
  };
}

// The admin's save: only what is a sensible number is accepted, and an amount
// not sent keeps what was there.
function applySupportGoalUpdate(stored, body, now = new Date()) {
  const b = body && typeof body === "object" ? body : {};
  const out = { ...stored };
  if (typeof b.enabled === "boolean") out.enabled = b.enabled;
  if (b.goal !== undefined) {
    const goal = Number(b.goal);
    if (!Number.isFinite(goal) || goal < 0 || goal > SUPPORT_GOAL_MAX) return { error: "The goal has to be a number from 0 to " + SUPPORT_GOAL_MAX + "." };
    out.goal = Math.round(goal * 100) / 100;
  }
  if (b.raised !== undefined) {
    const raised = Number(b.raised);
    if (!Number.isFinite(raised) || raised < 0 || raised > SUPPORT_GOAL_MAX * 10) return { error: "The amount given has to be a number, 0 or more." };
    out.raised = Math.round(raised * 100) / 100;
    out.raisedMonth = supportGoalMonth(now);
  }
  if (out.enabled && !(out.goal > 0)) return { error: "Set a goal above 0 before turning the strip on." };
  out.updatedAt = now.getTime();
  return { value: out };
}

async function renderAdminDashboard(env) {
  if (!env || !env.CONFIGS) {
    return `<!DOCTYPE html><html><body class="u-bg-F2F2F7 u-c-1C1C1E u-ff-sans_serif u-p-40px">This Worker has no CONFIGS KV namespace bound, so there's no stats to show.</body></html>`;
  }
  // Surfaced in the Maintenance tab below so a dashboard-only self-hoster
  // (no wrangler.toml in front of them) can see at a glance whether this
  // Worker even has a D1 database bound, instead of guessing -- D1 is
  // entirely optional, and every D1-specific action in that tab only
  // makes sense once this is true.
  const isD1Bound = !!(env && env.DB);
  const isActivityBound = !!(env && env.DB && env.DB_ACTIVITY);
  const isJobsBound = !!(env && env.JOBS && typeof env.JOBS.send === "function");
  const today = statsToday();
  const [
    totalPV, todayPV, totalIN, todayIN, totalPP, todayPP,
    pvByDay, inByDay, ppByDay,
    creatorResult, sourceGroupResult, authKeyByDay
  ] = await Promise.all([
    readStatCount(env, "pageviews", "total"),
    readStatCount(env, "pageviews", today),
    readStatCount(env, "installs", "total"),
    readStatCount(env, "installs", today),
    readStatCount(env, "playback_pings", "total"),
    readStatCount(env, "playback_pings", today),
    loadStatsByDay(env, "pageviews"),
    loadStatsByDay(env, "installs"),
    loadStatsByDay(env, "playback_pings"),
    // "creator:" (with the colon) is deliberately narrow -- creatorlist:,
    // creatorsync:, etc. all start with "creator" too but not "creator:",
    // so this can't accidentally sweep those in as if they were accounts.
    listAllKeys(env.CONFIGS, "creator:"),
    listAllKeys(env.CONFIGS, "stats:sourcegroup:"),
    loadStatsByDay(env, "authkey"),
  ]);
  // Requests that still sent the Account Key where the session would do
  // (Release 19): today, and the last 7 days.
  let authKeyWeek = 0;
  for (let i = 0; i < 7; i++) authKeyWeek += Number(authKeyByDay[easternDateKey(new Date(Date.now() - i * 86400000))]) || 0;
  const authKeyToday = Number(authKeyByDay[today]) || 0;

  // Walks the last 30 calendar days explicitly (rather than just listing
  // whatever KV happens to have) so days with zero activity still show up
  // as a 0 row instead of silently vanishing from the table. Same Eastern-
  // time day boundary as statsToday()/bumpStat() above, so these labels
  // actually match the keys being looked up.
  const rows = [];
  const nowMs = Date.now();
  for (let i = 0; i < 30; i++) {
    const key = easternDateKey(new Date(nowMs - i * 86400000));
    rows.push(`<tr><td>${key}</td><td>${pvByDay[key] || 0}</td><td>${inByDay[key] || 0}</td><td>${ppByDay[key] || 0}</td></tr>`);
  }

  // Creator accounts. The total is counted separately from the rows we
  // render because creators can outnumber a single request's safe read
  // budget: the stat card must report the true number of accounts rather
  // than silently displaying the capped number as if it were the total.
  let creatorAccounts = [];
  let totalCreatorCount = 0;
  // Hard ceiling on how many accounts one dashboard load will render. The
  // page is for a human eyeballing the newest/most-recent accounts, not
  // paging through thousands, and this keeps a load bounded regardless of
  // how large the site grows (the real cap is Cloudflare's 1,000
  // subrequests/invocation; D1 rows are cheap, so this sits just under it
  // to leave headroom for everything else the page does).
  const CREATOR_RENDER_CAP = 1000;
  if (env.DB) {
    // One query for the count, one bounded query for the rows -- no
    // per-account reads. last_active now comes straight from the row (kept
    // current by touchCreatorLastSeen), which is what removed the old
    // one-KV-get-per-creator fan-out.
    let count = 0;
    try {
      const countRes = await env.DB.prepare("SELECT COUNT(*) AS n FROM creators").all();
      count = countRes.results && countRes.results[0] ? Number(countRes.results[0].n) || 0 : 0;
    } catch (e) {
      console.error("D1 creator count failed:", e);
    }
    totalCreatorCount = count;
    const { results } = await env.DB.prepare(
      "SELECT username, display_name, created_at, last_active FROM creators ORDER BY last_active DESC, created_at DESC LIMIT ?"
    ).bind(CREATOR_RENDER_CAP).all();
    creatorAccounts = (results || []).map((row) => ({
      username: row.username,
      displayName: row.display_name,
      createdAt: row.created_at || null,
      lastActive: row.last_active || null,
    }));
  } else {
    // KV-only fallback. listAllKeys is a full cursor sweep (fine for
    // enumerating, no per-key reads), then bound the fan-out: a KV get per
    // account over more than this many would blow the subrequest cap, so
    // cap the renders and report the real total.
    totalCreatorCount = (creatorResult.keys || []).length;
    const keys = (creatorResult.keys || []).slice(0, CREATOR_RENDER_CAP);
    creatorAccounts = await Promise.all(
      keys.map(async (k) => {
        const username = k.name.slice("creator:".length);
        let displayName = username;
        let createdAt = null;
        try {
          const raw = await env.CONFIGS.get(k.name);
          if (raw) {
            const data = JSON.parse(raw);
            displayName = data.displayName || username;
            createdAt = typeof data.createdAt === "number" ? data.createdAt : null;
          }
        } catch {}
        let lastActive = null;
        try {
          const lastRaw = await env.CONFIGS.get(`creatorlastseen:${username}`);
          lastActive = lastRaw ? parseInt(lastRaw, 10) || null : null;
        } catch {}
        return { username, displayName, createdAt, lastActive };
      })
    );
  }

  creatorAccounts.sort((a, b) => (b.lastActive || b.createdAt || 0) - (a.lastActive || a.createdAt || 0));
  const shownCreatorCount = creatorAccounts.length;
  const accountRows = creatorAccounts
    .map(
      (c) =>
        `<tr><td>${escapeHtmlServer(c.displayName)}</td><td>${escapeHtmlServer(c.username)}</td>` +
        `<td>${c.createdAt ? easternDateKey(new Date(c.createdAt)) : "\u2014"}</td>` +
        `<td>${c.lastActive ? easternDateKey(new Date(c.lastActive)) : "\u2014"}</td>` +
        // data-* attributes here rather than passing c.displayName inline into
        // the onclick string -- displayName is arbitrary creator-chosen text
        // (only .trim()'d server-side, not restricted to safe characters the
        // way the normalized username is), so splicing it directly into an
        // attribute would both break on a display name
        // containing a quote and, worse, let a crafted display name inject
        // script into this admin page. escapeHtmlServer handles the HTML-
        // attribute escaping here the same way it already does for the two
        // <td> values above; resetCreatorKey reads the values back off the
        // element at click time instead of receiving them as literals.
        `<td><button type="button" class="lc-btn secondary u-p-4px_10px u-fs-v_font_size_sm" data-username="${escapeHtmlServer(c.username)}" data-displayname="${escapeHtmlServer(c.displayName)}" data-act="resetCreatorKey" data-act-args="${adminActArgs(['@self'])}">Reset Key</button></td></tr>`
    )
    .join("");
  const creatorTruncatedNote = shownCreatorCount < totalCreatorCount
    ? `, showing ${shownCreatorCount} of ${totalCreatorCount}`
    : "";

  // Each key is stats:sourcegroup:{group}:total -- strip both ends to get
  // the group name back. ":total" is a fixed suffix here (see bumpStatBy's
  // total-only design above), so a plain slice is enough, no need to guard
  // against a stray per-day key existing alongside it the way
  // loadStatsByDay has to for pageviews/installs.
  let sourceGroups = [];
  if (env.DB) {
    const { results } = await env.DB.prepare("SELECT * FROM source_groups").all();
    sourceGroups = results.map(row => ({ group: row.name, count: row.install_count }));
  } else {
    const sourceGroupPrefix = "stats:sourcegroup:";
    sourceGroups = await Promise.all(
      sourceGroupResult.keys.map(async (k) => {
        const group = k.name.slice(sourceGroupPrefix.length, -":total".length);
        const raw = await env.CONFIGS.get(k.name);
        return { group, count: parseInt(raw, 10) || 0 };
      })
    );
  }
  sourceGroups.sort((a, b) => b.count - a.count);
  const sourceGroupTotal = sourceGroups.reduce((sum, g) => sum + g.count, 0);
  const sourceGroupRows = sourceGroups
    .map((g) => {
      const pct = sourceGroupTotal ? Math.round((g.count / sourceGroupTotal) * 100) : 0;
      return `<tr><td>${escapeHtmlServer(g.group)}</td><td>${g.count}</td><td>${pct}%</td></tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin \u2014 My Lists Addon</title>
<script nonce="${CSP_NONCE_PLACEHOLDER}">
  if (localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark-theme');
  }
</script>
<style nonce="${CSP_NONCE_PLACEHOLDER}">
${DESIGN_TOKENS_CSS}
${UTILITY_CSS}
  * { box-sizing: border-box; }
  body { background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,system-ui,sans-serif; max-width:900px; margin:0 auto; padding:20px 14px; }
  h1 { margin-bottom:4px; font-size:1.6rem; color:var(--text); }
  h2 { font-size:1.1rem; color:var(--text); }
  .stat-cards { display:grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap:12px; margin:16px 0; }
  .stat-card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:14px; box-shadow:var(--shadow-sm); }
  .stat-value { font-size:1.6rem; font-weight:700; color:var(--text); }
  .stat-label { color:var(--muted); font-size:0.82rem; margin-top:4px; }
  .table-wrap { width:100%; overflow-x:auto; -webkit-overflow-scrolling:touch; margin-top:10px; background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); box-shadow:var(--shadow-sm); }
  table { width:100%; border-collapse:collapse; background:var(--surface); border:none; margin:0; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--border); font-size:0.85rem; white-space:nowrap; color:var(--text); }
  th { color:var(--muted); font-weight:600; background:var(--panel-strong); }
  a { color:var(--accent); }
  .admin-main-tab-bar { display:flex; gap:16px; border-bottom:1px solid var(--border); margin-top:20px; flex-wrap:wrap; }
  .admin-main-tab-btn {
    background:none; border:none; color:var(--muted); font-size:0.95rem; font-weight:700; cursor:pointer;
    padding:10px 4px; margin-bottom:-1px; border-bottom:2px solid transparent; transition:color 0.15s ease;
  }
  .admin-main-tab-btn:hover { color:var(--text); }
  .admin-main-tab-btn.active { color:var(--text); border-bottom-color:var(--accent); }
  .admin-subnav-bar { display:flex; gap:8px; margin:14px 0 16px; flex-wrap:wrap; }
  .subnav-pill {
    background:var(--surface); border:1px solid var(--border); border-radius:20px; padding:6px 14px;
    font-size:0.85rem; font-weight:600; color:var(--muted); cursor:pointer; transition:all 0.15s ease;
  }
  .subnav-pill:hover { border-color:var(--border-strong); color:var(--text); }
  .subnav-pill.active { background:var(--accent); color:#FFFFFF; border-color:var(--accent); }
  .admin-tab-panel { display:none; }
  .admin-tab-panel.active { display:block; }
  .admin-select { padding:6px 10px; border-radius:var(--radius-sm); border:1px solid var(--border-strong); background:var(--surface); color:var(--text); font-size:0.85rem; margin-right:6px; outline:none; }
  .admin-badge { display:inline-block; padding:2px 8px; border-radius:6px; font-size:0.75rem; font-weight:700; text-transform:uppercase; }
  .admin-badge.bug { background:rgba(255,59,48,0.12); color:var(--danger); }
  .admin-badge.improvement { background:rgba(0,122,255,0.12); color:var(--accent); }
  .admin-badge.idea { background:rgba(255,149,0,0.12); color:#FF9500; }
  .admin-badge.other { background:rgba(142,142,147,0.15); color:var(--muted); }
  .admin-badge.series { background:rgba(175,82,222,0.15); color:#af52de; }
  .admin-badge.movie { background:rgba(0,122,255,0.15); color:var(--accent); }
  .admin-badge.service { background:var(--panel-strong); color:var(--text); text-transform:none; font-weight:500; margin:1px 4px 1px 0; }
  .feedback-card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:14px 16px; margin-top:10px; box-shadow:var(--shadow-sm); }
  .feedback-card.completed { opacity:0.55; }
  .feedback-card-header { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap; }
  .feedback-actions { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
  .feedback-meta { color:var(--muted); font-size:0.8rem; margin-top:6px; }
  .feedback-message { margin-top:8px; white-space:pre-wrap; font-size:0.92rem; word-break:break-word; color:var(--text); }
  .netflix-preview-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap:10px; margin-top:10px; }
  .netflix-preview-poster { width:100%; aspect-ratio:2/3; object-fit:cover; border-radius:8px; background:var(--panel-strong); box-shadow:var(--shadow-sm); }
  .netflix-preview-poster-placeholder { width:100%; aspect-ratio:2/3; border-radius:8px; background:var(--panel-strong); display:flex; align-items:center; justify-content:center; color:var(--muted); font-size:0.75rem; text-align:center; padding:6px; }
  .netflix-preview-title { font-size:0.8rem; margin-top:4px; line-height:1.25; color:var(--text); }
  .netflix-preview-year { color:var(--muted); font-size:0.75rem; }

  /* Support Desk */
  .admin-badge.open { background:rgba(0,122,255,0.12); color:var(--accent); }
  .admin-badge.replied { background:rgba(52,199,89,0.12); color:#34c759; }
  .admin-badge.closed { background:rgba(142,142,147,0.15); color:var(--muted); }
  .admin-badge.spam { background:rgba(255,59,48,0.12); color:var(--danger); }
  .support-desk-layout { display:grid; grid-template-columns:360px 1fr; gap:16px; min-height:550px; align-items:start; margin-top:14px; }
  @media (max-width:860px) { .support-desk-layout { grid-template-columns:1fr; } }
  .support-thread-card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:12px 14px; margin-bottom:8px; cursor:pointer; transition:border-color 0.12s; }
  .support-thread-card:hover { border-color:var(--border-strong); }
  .support-thread-card.active { border-color:var(--accent); background:var(--panel-strong); }
  .support-thread-card.unread { border-left:4px solid var(--accent); }
  .support-bubble { border-radius:14px; padding:12px 16px; margin-bottom:12px; }
  .support-bubble.inbound { background:var(--surface); border:1px solid var(--border); margin-right:40px; }
  .support-bubble.outbound { background:var(--panel-strong); border:1.5px solid var(--accent); margin-left:40px; }

  /* Standard Modals & Buttons */
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.5);
    display: flex; align-items: center; justify-content: center;
    padding: 16px; z-index: 1000;
  }
  .modal-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 20px; padding: 22px; max-width: 440px; width: 100%;
    max-height: 90vh; overflow-y: auto; box-shadow: var(--shadow-md);
    color: var(--text);
  }
  button.linklike {
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    color: var(--accent);
    cursor: pointer;
    text-decoration: underline;
  }
  button.linklike:hover { opacity: 0.85; }

  .modal-close-x {
    float: right; background: var(--bg); border: 1px solid var(--border-strong);
    color: var(--muted); font-size: 1rem; cursor: pointer;
    padding: 4px 10px; border-radius: 8px;
  }
  .modal-close-x:hover { color: var(--text); border-color: var(--text-2); }
  .lc-btn {
    padding: 10px 18px; min-height: 38px; border-radius: var(--radius-pill);
    border: none; background: var(--accent); color: #fff; cursor: pointer;
    font-weight: 600; font-size: 0.925rem; font-family: inherit;
    display: inline-flex; align-items: center; justify-content: center;
    transition: opacity 0.12s; text-decoration: none;
  }
  .lc-btn.secondary {
    background: var(--surface); color: var(--text);
    border: 1.5px solid var(--border-strong);
  }
  .lc-btn.danger {
    background: var(--danger); color: #fff; border: none;
  }
  .lc-btn:hover:not(:disabled) { opacity: 0.85; }
  .lc-btn:disabled { opacity: 0.4; cursor: default; }

  @media (max-width: 600px) {
    body { padding: 14px 10px; }
    .stat-cards { grid-template-columns: repeat(2, 1fr); gap: 8px; }
    .feedback-card { padding: 12px; }
    .feedback-card-header { flex-direction: column; align-items: flex-start !important; }
    .feedback-actions { width: 100%; }
    .feedback-actions button { flex-grow: 1; text-align: center; }
  }
</style></head>
<body>
  <h1>Admin Dashboard</h1>
  <p class="u-c-v_muted u-mt-0">My Lists Addon usage stats. <span id="workerRelease">Release ${WORKER_RELEASE}</span> <span id="workerBuild">(build ${WORKER_BUILD})</span></p>
  ${isD1Bound ? '' : '<div class="u-bg-rgba_255_59_48_0_12 u-bd-1px_solid_v_color_danger u-br-v_radius_sm u-p-12px_16px u-m-0_0_18px u-c-v_color_danger_text u-fs-v_font_size_sm u-lh-1_4"><strong>Warning: No D1 database bound.</strong> D1 is required for authoritative accounts, lists, full-text search, likes, feedback, and tracking. Please bind your D1 database as <code>DB</code> in the Cloudflare Dashboard (Worker Settings &rarr; Bindings).</div>'}

  <!-- Not a tablist: these three buttons do not reveal panels, they choose
       which row of sub-tabs is shown, and it is the sub-tab that selects
       content. role="tablist" with nothing inside it carrying role="tab"
       told assistive technology to expect tabs and hand it none, so this
       is a labelled group of toggle buttons, which is what it is. -->
  <div class="admin-main-tab-bar" role="group" aria-label="Dashboard sections">
    <button type="button" class="admin-main-tab-btn active" aria-pressed="true" data-main-tab="overview" data-act="switchAdminMainTab" data-act-args="${adminActArgs(['overview'])}">Overview &amp; Traffic</button>
    <button type="button" class="admin-main-tab-btn" aria-pressed="false" data-main-tab="discovery" data-act="switchAdminMainTab" data-act-args="${adminActArgs(['discovery'])}">Analytics &amp; Discovery</button>
    <button type="button" class="admin-main-tab-btn" aria-pressed="false" data-main-tab="management" data-act="switchAdminMainTab" data-act-args="${adminActArgs(['management'])}">Management &amp; Tools</button>
  </div>

  <div class="admin-subnav-bar" id="adminSubnavOverview">
    <button type="button" class="subnav-pill active" data-sub-tab="last30" data-act="switchAdminSubTab" data-act-args="${adminActArgs(['last30'])}">Last 30 Days</button>
    <button type="button" class="subnav-pill" data-sub-tab="sources" data-act="switchAdminSubTab" data-act-args="${adminActArgs(['sources'])}">Sources people use</button>
    <button type="button" class="subnav-pill" data-sub-tab="apiusage" data-act="switchAdminSubTab" data-act-args="${adminActArgs(['apiusage'])}">API Usage</button>
  </div>
  <div class="admin-subnav-bar" id="adminSubnavDiscovery" style="display:none;">
    <button type="button" class="subnav-pill" data-sub-tab="trending" data-act="switchAdminSubTab" data-act-args="${adminActArgs(['trending'])}">Trending Data</button>
    <button type="button" class="subnav-pill" data-sub-tab="search" data-act="switchAdminSubTab" data-act-args="${adminActArgs(['search'])}">Search &amp; Queries</button>
    <button type="button" class="subnav-pill" data-sub-tab="catalogs_lists" data-act="switchAdminSubTab" data-act-args="${adminActArgs(['catalogs_lists'])}">Catalogs &amp; Lists</button>
    <button type="button" class="subnav-pill" data-sub-tab="audience" data-act="switchAdminSubTab" data-act-args="${adminActArgs(['audience'])}">Playback &amp; Audience</button>
  </div>
  <div class="admin-subnav-bar" id="adminSubnavManagement" style="display:none;">
    <button type="button" class="subnav-pill" data-sub-tab="creators" data-act="switchAdminSubTab" data-act-args="${adminActArgs(['creators'])}">Creator Accounts</button>
    <button type="button" class="subnav-pill" data-sub-tab="feedback" data-act="switchAdminSubTab" data-act-args="${adminActArgs(['feedback'])}">Feedback</button>
    <button type="button" class="subnav-pill" data-sub-tab="support_emails" data-act="switchAdminSubTab" data-act-args="${adminActArgs(['support_emails'])}">Support Emails <span id="supportEmailsBadge" class="u-fs-v_font_size_xs u-fw-700 u-p-2px_6px u-br-v_radius_pill u-ml-4px" style="display:none;background:var(--accent);color:#fff;">0</span></button>
    <button type="button" class="subnav-pill" data-sub-tab="netflixpreview" data-act="switchAdminSubTab" data-act-args="${adminActArgs(['netflixpreview'])}">Provider Preview</button>
    <button type="button" class="subnav-pill" data-sub-tab="newonstreaming" data-act="switchAdminSubTab" data-act-args="${adminActArgs(['newonstreaming'])}">New on Streaming</button>
    <button type="button" class="subnav-pill" data-sub-tab="channelpresets" data-act="switchAdminSubTab" data-act-args="${adminActArgs(['channelpresets'])}">Channel Presets</button>
    <button type="button" class="subnav-pill" data-sub-tab="supportgoal" data-act="switchAdminSubTab" data-act-args="${adminActArgs(['supportgoal'])}">Support Goal</button>
    <button type="button" class="subnav-pill" data-sub-tab="maintenance" data-act="switchAdminSubTab" data-act-args="${adminActArgs(['maintenance'])}">Maintenance</button>
  </div>

  <div class="admin-tab-panel active" data-admin-panel="last30">
    <div class="stat-cards">
      <div class="stat-card"><div class="stat-value">${Number(totalPV) || 0}</div><div class="stat-label">Total page views</div></div>
      <div class="stat-card"><div class="stat-value">${Number(todayPV) || 0}</div><div class="stat-label">Page views today</div></div>
      <div class="stat-card"><div class="stat-value">${Number(totalIN) || 0}</div><div class="stat-label">Total install links</div></div>
      <div class="stat-card"><div class="stat-value">${Number(todayIN) || 0}</div><div class="stat-label">Install links today</div></div>
      <div class="stat-card"><div class="stat-value">${Number(totalPP) || 0}</div><div class="stat-label">Total playback streams</div></div>
      <div class="stat-card"><div class="stat-value">${Number(todayPP) || 0}</div><div class="stat-label">Streams today</div></div>
    </div>
    <div class="table-wrap">
      <table>
        <tr><th>Date</th><th>Page views</th><th>Install links</th><th>Playback pings</th></tr>
        ${rows.join("")}
      </table>
    </div>
  </div>

  <div class="admin-tab-panel" data-admin-panel="creators">
    <div class="stat-cards">
      <div class="stat-card"><div class="stat-value">${totalCreatorCount}</div><div class="stat-label">Creator accounts${creatorTruncatedNote}</div></div>
      <div class="stat-card"><div class="stat-value">${authKeyToday}</div><div class="stat-label">Saves that sent the Account Key today</div></div>
      <div class="stat-card"><div class="stat-value">${authKeyWeek}</div><div class="stat-label">... in the last 7 days</div></div>
    </div>
    <div class="table-wrap">
      <table>
        <tr><th>Display name</th><th>Username</th><th>Created</th><th>Last Active</th><th>Key</th></tr>
        ${accountRows || '<tr><td colspan="5">No accounts yet.</td></tr>'}
      </table>
    </div>
  </div>

  <div class="admin-tab-panel" data-admin-panel="sources">
    <p class="u-c-v_muted u-mt-0 u-fs-v_font_size_base">Counted from each row's group at the moment an install link is generated -- one Custom List and one Channel in the same install still count as one of each, five MDBList Charts rows count as five.</p>
    <div class="table-wrap">
      <table>
        <tr><th>Source</th><th>Count</th><th>Share</th></tr>
        ${sourceGroupRows || '<tr><td colspan="3">No data yet.</td></tr>'}
      </table>
    </div>
  </div>

  <div class="admin-tab-panel" data-admin-panel="trending">
    <p class="u-c-v_muted u-mt-0 u-fs-v_font_size_base">How many times each title has been marked watched or added to a list, across everyone using this add-on. The <strong>Most Watched</strong> counts for Today, Last 7 Days and Last 30 Days are what the public <strong>Most Watched Today / 7 Days / 30 Days</strong> charts show (top 25; Quick Add &rarr; My Lists Addon Charts, and Discover); those refresh hourly for Today and daily for 7/30 days. Entries recorded without a real title id (such as "null") are left out of both this table and those charts.</p>
    <div class="u-m-12px_0">
      <select class="admin-select" id="trendingTypeSelect" data-act="loadTrendingData">
        <option value="watched">Most Watched</option>
        <option value="list-add">Most Added to Lists</option>
      </select>
      <select class="admin-select" id="trendingWindowSelect" data-act="loadTrendingData">
        <option value="today">Today</option>
        <option value="7" selected>Last 7 Days</option>
        <option value="30">Last 30 Days</option>
        <option value="90">Last 90 Days</option>
        <option value="alltime">All Time</option>
      </select>
      <select class="admin-select" id="trendingMediaTypeSelect" data-act="loadTrendingData">
        <option value="">Movies + Shows</option>
        <option value="movie">Movies Only</option>
        <option value="series">Shows Only</option>
      </select>
      <button type="button" class="admin-select u-cur-pointer" id="backfillTrendingBtn" data-act="runBackfillTrending">Backfill Existing Data</button>
      <span id="backfillTrendingStatus" class="u-fs-v_font_size_sm u-ml-6px" style="color:var(--muted);"></span>
    </div>
    <p class="u-c-v_muted u-m-0_0_12px u-fs-v_font_size_sm">Backfill only adds to the <strong>All Time</strong> window (there's no historical date to bucket existing data into 7/30/90-day windows) -- it seeds counts from Watch History and Custom Lists that already existed before this feature shipped. Safe to run more than once; it only adds, never resets anything. Processes accounts a few at a time, so it may take a minute for larger sites.</p>
    <div class="u-m-0_0_12px">
      <button type="button" class="admin-select u-cur-pointer" id="migrateDayCountsBtn" data-act="runMigrateDayCounts">Migrate Historical Day Counts</button>
      <span id="migrateDayCountsStatus" class="u-fs-v_font_size_sm u-ml-6px" style="color:var(--muted);"></span>
      <p class="u-c-v_muted u-m-6px_0_0 u-fs-v_font_size_sm">One-time migration for the switch from one KV key per day to one JSON blob per title -- reads every old per-day count still sitting in KV and folds it into the new format, so 7/30/90-day windows reflect activity from before that switch instead of only counting forward from it. Safe to run more than once (adds, never subtracts); old keys are deleted once folded in, so re-running just confirms there's nothing left. Also covers the Search &amp; Queries leaderboard.</p>
    </div>
    <div class="table-wrap">
      <table>
        <tr><th>#</th><th>Title</th><th>Type</th><th>Count</th></tr>
        <tbody id="trendingTableBody"><tr><td colspan="4">Loading\u2026</td></tr></tbody>
      </table>
    </div>
  </div>

  <div class="admin-tab-panel" data-admin-panel="search">
    <p class="u-c-v_muted u-mt-0 u-fs-v_font_size_base">Anonymous queries and search terms users have entered in the Discover and Search tabs.</p>
    <div class="u-m-12px_0">
      <select class="admin-select" id="searchWindowSelect" data-act="loadSearchData">
        <option value="today">Today</option>
        <option value="7" selected>Last 7 Days</option>
        <option value="30">Last 30 Days</option>
        <option value="90">Last 90 Days</option>
        <option value="alltime">All Time</option>
      </select>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Search Query</th><th>Count</th></tr></thead>
        <tbody id="searchTableBody"><tr><td colspan="3">Loading\u2026</td></tr></tbody>
      </table>
    </div>
  </div>

  <div class="admin-tab-panel" data-admin-panel="catalogs_lists">
    <h2 class="u-mt-0">Most Installed Curated &amp; Provider Catalogs</h2>
    <p class="u-c-v_muted u-mt-0 u-fs-v_font_size_base">Which built-in charts and provider catalogs users add to their Stremio configuration.</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Catalog / Chart Name</th><th>Times Installed</th></tr></thead>
        <tbody id="installedCatalogsTableBody"><tr><td colspan="3">Loading\u2026</td></tr></tbody>
      </table>
    </div>

    <h2 class="u-mt-28px">Top Community &amp; Creator Lists</h2>
    <p class="u-c-v_muted u-mt-0 u-fs-v_font_size_base">Ranked by community engagement (likes and list copies/imports).</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>List Name</th><th>Creator</th><th>Type</th><th>Items</th><th>Likes</th><th>Copies</th></tr></thead>
        <tbody id="topCommunityListsTableBody"><tr><td colspan="7">Loading\u2026</td></tr></tbody>
      </table>
    </div>
  </div>

  <div class="admin-tab-panel" data-admin-panel="audience">
    <p class="u-c-v_muted u-mt-0 u-fs-v_font_size_base">Audience viewing breakdown derived from Stremio stream playback pings.</p>
    
    <div class="stat-cards">
      <div class="stat-card"><div class="stat-value" id="audienceTotalPlays">0</div><div class="stat-label">Total streams tracked</div></div>
      <div class="stat-card"><div class="stat-value" id="audienceMoviePlays">0</div><div class="stat-label">Movie plays</div></div>
      <div class="stat-card"><div class="stat-value" id="audienceSeriesPlays">0</div><div class="stat-label">Show plays</div></div>
      <div class="stat-card"><div class="stat-value" id="audienceEpisodePlays">0</div><div class="stat-label">Episode plays</div></div>
    </div>

    <h2 class="u-mt-20px">Top Watched Genres</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Genre</th><th>Stream Count</th></tr></thead>
        <tbody id="topGenresTableBody"><tr><td colspan="3">Loading\u2026</td></tr></tbody>
      </table>
    </div>

    <h2 class="u-mt-28px">Release Era / Decades</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Release Era</th><th>Stream Count</th></tr></thead>
        <tbody id="topDecadesTableBody"><tr><td colspan="3">Loading\u2026</td></tr></tbody>
      </table>
    </div>
  </div>

  <div class="admin-tab-panel" data-admin-panel="feedback">
    <p class="u-c-v_muted u-mt-0 u-fs-v_font_size_base">Bug reports, improvement requests, and ideas submitted from Settings &gt; Feedback, newest first.</p>
    <div class="feedback-card">
      <div class="u-fw-600 u-mb-8px">Log something yourself</div>
      <select class="admin-select u-mb-8px" id="newFeedbackCategory">
        <option value="bug" selected>Bug</option>
        <option value="improvement">Improvement</option>
        <option value="idea">Idea</option>
        <option value="other">Other</option>
      </select>
      <textarea id="newFeedbackMessage" placeholder="What did you find?" class="u-minh-70px u-bs-border_box u-p-10px_12px u-br-v_radius_sm u-bd-1px_solid_rgba_0_0_0_0_15 u-ff-inherit u-fs-v_font_size_base u-rs-vertical" style="width:100%;"></textarea>
      <div class="u-mt-8px u-ai-center u-gap-10px" style="display:flex;">
        <button type="button" class="admin-select u-cur-pointer" id="newFeedbackSubmitBtn" data-act="submitAdminFeedback">Add to list</button>
        <span id="newFeedbackStatus" class="u-fs-v_font_size_sm" style="color:var(--muted);"></span>
      </div>
    </div>
    <div id="feedbackList">Loading\u2026</div>
  </div>

  <!-- Edit Feedback Modal -->
  <div id="editFeedbackModal" class="modal-overlay" style="display:none;">
    <div class="modal-card u-maxw-500px">
      <div class="u-jc-space_between u-ai-center u-mb-12px" style="display:flex;">
        <h3 class="u-m-0 u-fs-v_font_size_lg u-fw-700 u-c-v_text">Edit Feedback</h3>
        <button type="button" class="modal-close-x" aria-label="Close" data-act="closeEditFeedbackModal">&#x2715;</button>
      </div>
      <input type="hidden" id="editFeedbackId">
      <label class="u-fs-v_font_size_sm u-fw-600 u-c-v_muted u-mb-6px" style="display:block;">Category</label>
      <select class="admin-select u-mb-14px u-p-10px_12px u-br-v_radius_sm u-bd-1_5px_solid_v_border_strong u-bg-v_surface u-c-v_text" id="editFeedbackCategory" style="width:100%;">
        <option value="bug">bug</option>
        <option value="improvement">improvement</option>
        <option value="idea">idea</option>
        <option value="other">other</option>
      </select>
      <label class="u-fs-v_font_size_sm u-fw-600 u-c-v_muted u-mb-6px" style="display:block;">Message</label>
      <textarea id="editFeedbackMessage" class="u-minh-120px u-bs-border_box u-p-10px_12px u-br-v_radius_sm u-bd-1_5px_solid_v_border_strong u-bg-v_surface u-c-v_text u-ff-inherit u-fs-v_font_size_base u-rs-vertical u-mb-16px u-ol-none" style="width:100%;"></textarea>
      <div class="u-jc-flex_end u-gap-10px" style="display:flex;">
        <button type="button" class="lc-btn secondary" data-act="closeEditFeedbackModal">Cancel</button>
        <button type="button" class="lc-btn primary" id="editFeedbackSaveBtn" data-act="saveEditFeedback">Save Changes</button>
      </div>
    </div>
  </div>

  <div class="admin-tab-panel" data-admin-panel="support_emails">
    <div class="u-jc-space_between u-ai-center u-mb-12px u-fw2-wrap u-gap-10px" style="display:flex;">
      <div>
        <p class="u-c-v_muted u-m-0 u-fs-v_font_size_base">Direct customer inquiries received at <code>support@mylistsaddon.com</code> via Cloudflare Email Routing. Reply directly using Cloudflare Email Sending.</p>
      </div>
      <button type="button" class="lc-btn primary" data-act="openComposeEmailModal">+ Compose Email</button>
    </div>

    <!-- Filter & Search Toolbar -->
    <div class="panel u-p-10px_14px u-mb-14px u-ai-center u-jc-space_between u-fw2-wrap u-gap-10px" style="display:flex;">
      <div class="u-ai-center u-gap-6px u-fw2-wrap" style="display:flex;" id="supportEmailFilterGroup">
        <button type="button" class="subnav-pill active" data-status="all" data-act="filterSupportEmails" data-act-args="${adminActArgs(['all'])}">All</button>
        <button type="button" class="subnav-pill" data-status="open" data-act="filterSupportEmails" data-act-args="${adminActArgs(['open'])}">Open</button>
        <button type="button" class="subnav-pill" data-status="replied" data-act="filterSupportEmails" data-act-args="${adminActArgs(['replied'])}">Replied</button>
        <button type="button" class="subnav-pill" data-status="closed" data-act="filterSupportEmails" data-act-args="${adminActArgs(['closed'])}">Closed</button>
      </div>
      <div class="u-ai-center u-gap-8px u-flex-1 u-maxw-340px" style="display:flex;">
        <input type="text" id="supportEmailSearchInput" class="admin-select u-flex-1 u-m-0" placeholder="Search by email, name or subject..." data-act="onSupportEmailSearchInput" data-act-on="input">
      </div>
    </div>

    <div class="support-desk-layout">
      <!-- Left Column: Thread List -->
      <div class="panel u-p-12px u-m-0" style="max-height:750px; overflow-y:auto;">
        <div id="supportEmailThreadList" class="u-fs-v_font_size_sm u-c-v_muted">Loading conversations&hellip;</div>
      </div>

      <!-- Right Column: Conversation & Reply -->
      <div class="panel u-p-16px u-m-0" id="supportEmailDetailContainer" style="display:flex; flex-direction:column; min-height:550px;">
        <div id="supportEmailEmptyDetail" class="u-ta-center u-p-40px_20px u-c-v_muted">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="u-mb-10px u-o-0_4" aria-hidden="true"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
          <div class="u-fs-v_font_size_base u-fw-600">No conversation selected</div>
          <div class="u-fs-v_font_size_sm u-mt-4px">Select a thread from the list on the left to read and reply.</div>
        </div>

        <div id="supportEmailActiveDetail" style="display:none; flex-direction:column; flex:1;">
          <!-- Thread Header -->
          <div class="u-jc-space_between u-ai-flex_start u-bb-1px_solid_v_border u-pb-12px u-mb-14px" style="display:flex; gap:12px; flex-wrap:wrap;">
            <div class="u-flex-1">
              <h3 id="supportActiveSubject" class="u-m-0_0_4px u-fs-v_font_size_lg u-fw-700 u-c-v_text"></h3>
              <div class="u-fs-v_font_size_xs u-c-v_muted">
                From: <strong id="supportActiveFrom" class="u-c-v_text"></strong> &bull; <span id="supportActiveDate"></span>
              </div>
            </div>
            <div class="u-ai-center u-gap-8px" style="display:flex;">
              <span id="supportActiveStatusBadge" class="admin-badge"></span>
              <button type="button" class="admin-select u-cur-pointer" id="supportActiveStatusBtn" data-act="changeSupportThreadStatus">Toggle Status</button>
              <button type="button" class="admin-select u-cur-pointer u-c-v_color_danger_text" data-act="deleteSupportEmailThread">Delete</button>
            </div>
          </div>

          <!-- Message History Timeline -->
          <div id="supportActiveMessageList" class="u-flex-1 u-ov-auto u-mb-16px u-p-4px" style="max-height:480px; display:flex; flex-direction:column;"></div>

          <!-- Reply Composer -->
          <div class="u-bt-1px_solid_v_border u-pt-14px u-mt-auto">
            <div class="u-fw-600 u-fs-v_font_size_sm u-mb-6px u-c-v_text">Reply from support@mylistsaddon.com</div>
            <textarea id="supportEmailReplyText" class="u-minh-100px u-bs-border_box u-p-10px_12px u-br-v_radius_sm u-bd-1_5px_solid_v_border_strong u-bg-v_surface u-c-v_text u-ff-inherit u-fs-v_font_size_base u-rs-vertical u-mb-10px u-ol-none" placeholder="Type your reply to customer..." style="width:100%;"></textarea>
            <div class="u-jc-space_between u-ai-center u-fw2-wrap u-gap-10px" style="display:flex;">
              <label class="u-ai-center u-gap-6px u-fs-v_font_size_xs u-c-v_muted u-cur-pointer" style="display:flex;">
                <input type="checkbox" id="supportEmailCloseOnReply" checked> Close thread after sending reply
              </label>
              <div class="u-ai-center u-gap-10px" style="display:flex;">
                <span id="supportEmailReplyStatus" class="u-fs-v_font_size_xs" style="color:var(--muted);"></span>
                <button type="button" class="lc-btn primary" id="supportEmailSendReplyBtn" data-act="sendSupportEmailReplyBtn">Send Reply</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Compose Email Modal -->
  <div id="composeEmailModal" class="modal-overlay" style="display:none;">
    <div class="modal-card u-maxw-500px">
      <div class="u-jc-space_between u-ai-center u-mb-12px" style="display:flex;">
        <h3 class="u-m-0 u-fs-v_font_size_lg u-fw-700 u-c-v_text">New Support Email</h3>
        <button type="button" class="modal-close-x" aria-label="Close" data-act="closeComposeEmailModal">&#x2715;</button>
      </div>
      <label class="u-fs-v_font_size_xs u-fw-600 u-c-v_muted u-mb-4px" style="display:block;">Recipient Email</label>
      <input type="email" id="composeEmailTo" class="admin-select u-mb-10px u-p-8px_10px u-br-v_radius_sm u-bd-1px_solid_v_border_strong u-bg-v_surface u-c-v_text" placeholder="user@example.com" style="width:100%;">
      <label class="u-fs-v_font_size_xs u-fw-600 u-c-v_muted u-mb-4px" style="display:block;">Customer Name (optional)</label>
      <input type="text" id="composeEmailName" class="admin-select u-mb-10px u-p-8px_10px u-br-v_radius_sm u-bd-1px_solid_v_border_strong u-bg-v_surface u-c-v_text" placeholder="John Doe" style="width:100%;">
      <label class="u-fs-v_font_size_xs u-fw-600 u-c-v_muted u-mb-4px" style="display:block;">Subject</label>
      <input type="text" id="composeEmailSubject" class="admin-select u-mb-10px u-p-8px_10px u-br-v_radius_sm u-bd-1px_solid_v_border_strong u-bg-v_surface u-c-v_text" placeholder="Regarding your inquiry" style="width:100%;">
      <label class="u-fs-v_font_size_xs u-fw-600 u-c-v_muted u-mb-4px" style="display:block;">Message</label>
      <textarea id="composeEmailBody" class="u-minh-120px u-bs-border_box u-p-10px_12px u-br-v_radius_sm u-bd-1_5px_solid_v_border_strong u-bg-v_surface u-c-v_text u-ff-inherit u-fs-v_font_size_base u-rs-vertical u-mb-14px u-ol-none" placeholder="Write your message..." style="width:100%;"></textarea>
      <div class="u-jc-flex_end u-gap-10px u-ai-center" style="display:flex;">
        <span id="composeEmailStatus" class="u-fs-v_font_size_xs" style="color:var(--muted);"></span>
        <button type="button" class="lc-btn secondary" data-act="closeComposeEmailModal">Cancel</button>
        <button type="button" class="lc-btn primary" id="composeEmailSendBtn" data-act="sendComposedEmailBtn">Send Email</button>
      </div>
    </div>
  </div>

  <div class="admin-tab-panel" data-admin-panel="apiusage">
    <p class="u-c-v_muted u-mt-0 u-fs-v_font_size_base">Requests made using this Worker's own shared API keys (the fallback used whenever a visitor hasn't supplied their own) -- not counting anyone's personal keys, which only they can rate-limit. Watch these against each provider's limit if catalogs start coming back empty or slow.</p>
    <div class="table-wrap">
      <table>
        <tr><th>Key</th><th>Last 24h</th><th>Last 7 days</th><th>Last 30 days</th><th>Provider limit</th></tr>
        <tbody id="apiUsageTableBody"><tr><td colspan="5">Loading\u2026</td></tr></tbody>
      </table>
    </div>
  </div>
  </div>

  <div class="admin-tab-panel" data-admin-panel="netflixpreview">
    <p class="u-c-v_muted u-mt-0 u-fs-v_font_size_base">A look at what a TMDB-discover-based shelf would actually contain for any streaming provider, before wiring it into Quick Add for real -- pulled live from TMDB, not a saved list. Counts are TMDB/JustWatch's own tracking, not the provider's real numbers, and typically run a bit under what trackers like FlixPatrol report.</p>

    <div class="panel u-m-0_0_18px u-p-14px_16px">
      <div class="u-fw-600 u-fs-v_font_size_base u-mb-8px">Find a provider's id</div>
      <p class="u-c-v_muted u-m-0_0_10px u-fs-v_font_size_sm">TMDB sometimes has more than one entry for the same service (e.g. two separate "Disney Plus" ids) -- look the name up here rather than guessing, since a wrong id fails silently: it just quietly shows the wrong catalog under the right label.</p>
      <div class="u-gap-8px u-ai-center" style="display:flex;">
        <input type="text" id="providerLookupQueryInput" class="admin-select u-mr-0 u-flex-1 u-maxw-220px" placeholder="e.g. disney, max, hulu" data-act="lookupProviderIds" data-act-keys="Enter" data-act-prevent>
        <button type="button" class="secondary lc-btn" data-act="lookupProviderIds">Search</button>
        <span id="providerLookupStatus" class="u-fs-v_font_size_sm" style="color:var(--muted);"></span>
      </div>
      <div id="providerLookupResults" class="u-mt-10px"></div>
    </div>

    <div class="u-gap-8px u-ai-center u-mb-16px u-fw2-wrap" style="display:flex;">
      <label class="u-fs-v_font_size_sm u-c-v_muted">Provider id
        <input type="text" id="netflixPreviewProviderIdInput" class="admin-select u-mr-0" style="width:60px;" value="8" placeholder="8">
      </label>
      <label class="u-fs-v_font_size_sm u-c-v_muted">Region
        <input type="text" id="netflixPreviewRegionInput" class="admin-select u-mr-0 u-tt-uppercase" style="width:70px;" value="US" maxlength="2" placeholder="US">
      </label>
      <button type="button" class="secondary lc-btn" data-act="loadNetflixPreview">Load Preview</button>
      <span id="netflixPreviewStatus" class="u-fs-v_font_size_sm" style="color:var(--muted);"></span>
    </div>
    <div id="netflixPreviewMovies"></div>
    <div id="netflixPreviewShows" class="u-mt-28px"></div>
  </div>

  <div class="admin-tab-panel" data-admin-panel="supportgoal">
    <p class="u-c-v_muted u-mt-0 u-fs-v_font_size_base">The <strong>Ko-fi support strip</strong> at the top of Catalogs on the main site: a goal for the month's hosting bill and how much has been given toward it. It stays hidden until you turn it on. Visitors can hide it for the rest of the month with its &#x2715;; that only hides it for them.</p>
    <div class="panel u-m-0_0_18px u-p-14px_16px u-maxw-520px">
      <label class="u-ai-center u-gap-8px u-fw-600 u-fs-v_font_size_base u-mb-14px" style="display:flex;">
        <input type="checkbox" id="supportGoalEnabled"> Show the strip on the site
      </label>
      <label class="u-fs-v_font_size_sm u-c-v_muted u-mb-12px" style="display:block;">Monthly goal (US dollars)
        <input type="number" id="supportGoalAmount" class="admin-select u-m-4px_0_0" min="0" max="100000" step="1" style="display:block; width:160px;" placeholder="60">
      </label>
      <label class="u-fs-v_font_size_sm u-c-v_muted u-mb-6px" style="display:block;">Given so far this month (US dollars)
        <input type="number" id="supportGoalRaised" class="admin-select u-m-4px_0_0" min="0" step="0.01" style="display:block; width:160px;" placeholder="0">
      </label>
      <div class="u-fs-v_font_size_sm u-c-v_muted u-mb-14px">Ko-fi adds each US-dollar donation and membership payment to this by itself (set up below); type a number here to correct it. It counts toward <span id="supportGoalMonth">this month</span> only and starts again at 0 on the 1st.</div>
      <div class="u-gap-10px u-ai-center u-fw2-wrap" style="display:flex;">
        <button type="button" class="primary lc-btn" data-act="saveSupportGoal">Save</button>
        <span id="supportGoalStatus" class="u-fs-v_font_size_sm" style="color:var(--muted);"></span>
      </div>
    </div>
    <div class="panel u-m-0_0_18px u-p-14px_16px u-maxw-520px">
      <div class="u-fw-600 u-fs-v_font_size_base u-mb-8px">Automatic totals from Ko-fi</div>
      <ol class="u-m-0_0_12px_18px u-p-0 u-fs-v_font_size_sm u-c-v_muted u-lh-1_5">
        <li>In Ko-fi, go to <strong>Settings &rarr; API &rarr; Webhooks</strong> and paste this as the Webhook URL, then press Update:
          <div><code id="supportGoalWebhookUrl" class="u-us-all"></code></div></li>
        <li>Copy Ko-fi's <strong>verification token</strong> and add it to this Worker as a secret named <code>KOFI_VERIFICATION_TOKEN</code> (Cloudflare dashboard &rarr; Worker &rarr; Settings &rarr; Variables and Secrets).</li>
        <li>Use Ko-fi's <strong>Send a test</strong>. It shows up below.</li>
      </ol>
      <div class="u-fs-v_font_size_sm">Token: <span id="supportGoalTokenState" style="color:var(--muted);">checking&hellip;</span></div>
      <div class="u-fs-v_font_size_sm u-mt-4px">Last payment counted: <span id="supportGoalLastPayment" class="u-c-v_muted">none yet</span></div>
      <div class="u-fs-v_font_size_xs u-c-v_muted u-mt-10px">Counts donations and membership payments made in US dollars. Other currencies, shop orders and commissions are skipped; type those in above if you want them counted. Who gave is never shown.</div>
    </div>
  </div>

  <div class="admin-tab-panel" data-admin-panel="newonstreaming">
    <p class="u-c-v_muted u-mt-0 u-fs-v_font_size_base">The <strong>New on Streaming</strong> catalog &mdash; what actually arrived on a streaming service, newest first, with a show pushed back to the top the day a new episode airs. It is a real catalog row right now and can be installed into Stremio or Nuvio from the URLs below; it is in the My Lists Addon Charts section of Quick Add and in Discover.</p>
    <p class="u-c-v_muted u-m-0_0_16px u-fs-v_font_size_sm">Powered by RapidAPI's <strong>Streaming Availability API</strong> (/changes) to capture the exact date titles and new episodes are added to streaming services (not release dates), with new arrivals first and recent episodes bumping shows to the top within a rolling 30-day window.</p>

    <div class="panel u-m-0_0_18px u-p-14px_16px">
      <div class="u-fw-600 u-fs-v_font_size_base u-mb-8px">Sweep status</div>
      <div id="nosStatus" class="u-fs-v_font_size_sm" style="color:var(--muted);">Loading&hellip;</div>
      <div class="u-mt-12px u-gap-8px u-ai-center u-fw2-wrap" style="display:flex;">
        <button type="button" class="secondary lc-btn" data-act="loadNewOnStreaming">Refresh</button>
        <label class="u-fs-v_font_size_sm u-c-v_muted">Pages
          <input type="number" id="nosSweepUnits" class="admin-select u-mr-0" style="width:70px;" value="30" min="1" max="100">
        </label>
        <button type="button" class="admin-select u-cur-pointer" id="nosSweepBtn" data-act="runNewOnStreamingSweep" data-act-args="${adminActArgs([false])}">Run a sweep now</button>
        <button type="button" class="secondary lc-btn u-cur-pointer u-c-v_color_warn_text u-bdc-rgba_255_149_0_0_4" id="nosResetBtn" data-act="runNewOnStreamingSweep" data-act-args="${adminActArgs([true])}">Clear &amp; pull fresh data</button>
        <span id="nosSweepStatus" class="u-fs-v_font_size_sm" style="color:var(--muted);"></span>
      </div>
      <p class="u-c-v_muted u-m-10px_0_0 u-fs-v_font_size_sm">Each page fetches up to 25 changes from RapidAPI. Automated sweeps run every 6 hours via cron and read each change stream (new titles, new seasons, new episodes, removals) oldest-first from where the last sweep stopped, so a busy day is finished on the next run instead of being cut off. The per-run budget is the month&#39;s remaining quota spread over the runs left; a safety cap halts sweeps at 950 calls to ensure zero overages. "Run a sweep now" continues the same streams with the page count given. Older titles (&gt;30 days) are pruned automatically each sweep.</p>
    </div>

    <div class="panel u-m-0_0_18px u-p-14px_16px">
      <div class="u-fw-600 u-fs-v_font_size_base u-mb-8px">Rows in 30-day window</div>
      <div class="table-wrap">
        <table>
          <tr><th>Service</th><th>Type</th><th>Titles</th><th>Removed</th><th>Newest Arrival</th></tr>
          <tbody id="nosByServiceBody"><tr><td colspan="5">Loading&hellip;</td></tr></tbody>
        </table>
      </div>
    </div>

    <div class="panel u-m-0_0_18px u-p-14px_16px">
      <div class="u-fw-600 u-fs-v_font_size_base u-mb-8px">Add / Sync Title to Catalog</div>
      <p class="u-c-v_muted u-m-0_0_10px u-fs-v_font_size_sm">Directly add or bump any movie or series in New on Streaming by IMDb ID (e.g. <code>tt45851964</code>), TMDB ID (e.g. <code>324931</code>), or title name.</p>
      <div class="u-gap-8px u-ai-center u-fw2-wrap" style="display:flex;">
        <input type="text" id="nosAddTitleInput" class="admin-select" placeholder="Title, IMDb ID (tt...) or TMDB ID" style="width:240px;">
        <select class="admin-select" id="nosAddServiceSelect">
          <option value="netflix">Netflix</option>
          <option value="primevideo">Prime Video</option>
          <option value="hulu">Hulu</option>
          <option value="disney">Disney+</option>
          <option value="hbomax">HBO Max</option>
          <option value="appletv">Apple TV+</option>
          <option value="paramount">Paramount+</option>
          <option value="peacock">Peacock</option>
        </select>
        <select class="admin-select" id="nosAddKindSelect">
          <option value="series">Show</option>
          <option value="movie">Movie</option>
        </select>
        <input type="date" id="nosAddDateInput" class="admin-select" style="width:130px;" title="Optional arrival date (defaults to episode air date or today)">
        <button type="button" class="admin-select u-cur-pointer" id="nosAddBtn" data-act="nosAddTitle">Add / Sync Title</button>
        <span id="nosAddStatus" class="u-fs-v_font_size_sm" style="color:var(--muted);"></span>
      </div>
    </div>

    <div class="panel u-m-0_0_18px u-p-14px_16px">
      <div class="u-fw-600 u-fs-v_font_size_base u-mb-8px">Preview the catalog</div>
      <p class="u-c-v_muted u-m-0_0_10px u-fs-v_font_size_sm">Read through the same code that serves the row to Stremio, so this is the actual shelf and not a second implementation of it. Order is always most recently arrived first.</p>
      <div class="u-gap-8px u-ai-center u-mb-12px u-fw2-wrap" style="display:flex;">
        <select class="admin-select" id="nosPreviewType" data-act="nosResetAndPreview">
          <option value="all" selected>All (Movies &amp; Shows)</option>
          <option value="movie">Movies</option>
          <option value="series">Shows</option>
        </select>
        <select class="admin-select" id="nosPreviewService" data-act="nosResetAndPreview">
          <option value="">All services</option>
        </select>
        <input type="text" id="nosPreviewSearch" class="admin-select" placeholder="Filter by title or ID…" style="width:180px;" data-act="onNosPreviewSearchInput" data-act-on="input">
        <button type="button" class="secondary lc-btn" data-act="nosResetAndPreview">Load preview</button>
        <button type="button" class="secondary lc-btn" id="nosPrevBtn" data-act="nosChangePage" data-act-args="${adminActArgs([-1])}" disabled>&larr; Prev</button>
        <span id="nosPageLabel" class="u-fs-v_font_size_sm u-c-v_muted u-fw-600">Page 1</span>
        <button type="button" class="secondary lc-btn" id="nosNextBtn" data-act="nosChangePage" data-act-args="${adminActArgs([1])}" disabled>Next &rarr;</button>
        <span id="nosPreviewStatus" class="u-fs-v_font_size_sm" style="color:var(--muted);"></span>
      </div>
      <div class="u-mb-12px u-fs-v_font_size_sm u-c-v_muted">Catalog URL: <code id="nosPreviewSource">tmdb:new-on-streaming</code> &mdash; paste this into <strong>Catalogs &rarr; + New Catalog</strong> on the main site to install this exact row into Stremio or Nuvio while it is still hidden.</div>
      <div id="nosPreviewResults"></div>
    </div>
  </div>

  <div class="admin-tab-panel" data-admin-panel="channelpresets">
    <p class="u-c-v_muted u-mt-0 u-fs-v_font_size_base">The shared pool behind every <strong>Quick Add Popular Networks</strong> channel (up to 5,000 episodes per network, cached 24h under <code>channel:preset:v2:&lt;networkId&gt;</code>) &mdash; every visitor who Quick Adds the same network reads this same cache. A daily cron rotation keeps it warm automatically, but a cache built under an older version of the build code keeps serving its old shape until that rotation reaches it again, which can take a few hours. Clear or rebuild a network here to skip the wait.</p>

    <div class="panel u-m-0_0_18px u-p-14px_16px">
      <div class="u-gap-8px u-ai-center u-fw2-wrap" style="display:flex;">
        <button type="button" class="secondary lc-btn" data-act="loadChannelPresets">Refresh</button>
        <button type="button" class="secondary lc-btn u-cur-pointer u-c-v_color_danger_text u-bdc-rgba_255_59_48_0_4" id="cpClearAllBtn" data-act="clearAllChannelPresets">Clear all caches</button>
        <span id="cpStatus" class="u-fs-v_font_size_sm" style="color:var(--muted);"></span>
      </div>
      <p class="u-c-v_muted u-m-10px_0_0 u-fs-v_font_size_sm">Clearing never touches anyone's already-saved channels -- each saved row carries its own small item sample as a fallback, so a cleared cache just means the next Quick Add click (or the cron rotation) rebuilds it fresh instead of serving what was cached before.</p>
    </div>

    <div class="panel u-m-0 u-p-14px_16px">
      <div class="table-wrap">
        <table>
          <tr><th>Network</th><th>Cached</th><th>Episodes</th><th>Built</th><th></th></tr>
          <tbody id="cpTableBody"><tr><td colspan="5">Loading&hellip;</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="admin-tab-panel" data-admin-panel="maintenance">
    <p class="u-c-v_muted u-mt-0 u-fs-v_font_size_base">One-off, click-to-run maintenance actions -- everything here is also reachable as a raw <code>POST</code> request for anyone using <code>wrangler</code>/curl, but these buttons are the point-and-click way to run the same thing entirely from this dashboard, no terminal required.</p>

    <div class="panel u-m-0_0_18px u-p-14px_16px">
      <div class="u-fw-600 u-fs-v_font_size_base u-mb-8px">D1 database: ${isD1Bound
        ? '<span class="u-c-v_color_success_text">bound</span>'
        : '<span class="u-c-v_color_danger_text">not bound (required)</span>'}</div>
      <p class="u-c-v_muted u-m-0_0_10px u-fs-v_font_size_sm">${isD1Bound
        ? 'This Worker has a D1 database bound as <code>DB</code>. Use the button below to backfill existing KV records into D1.'
        : 'This Worker has no D1 database bound (Settings &rarr; Bindings). D1 is required for authoritative accounts, lists, search, likes, feedback, and tracking. Bind a D1 database as <code>DB</code> to enable full functionality.'}</p>
      <button type="button" class="admin-select u-cur-pointer" id="migrateD1Btn" data-act="runMigrateD1" ${isD1Bound ? '' : 'disabled'}>Migrate KV &rarr; D1</button>
      <span id="migrateD1Status" class="u-fs-v_font_size_sm u-ml-6px" style="color:var(--muted);"></span>
      <p class="u-c-v_muted u-m-10px_0_0 u-fs-v_font_size_sm">Copies existing Creator Profiles, Custom Lists, likes, feedback, and tracking records from KV into D1. Safe to run more than once.</p>
    </div>

    <div class="panel u-m-0_0_18px u-p-14px_16px">
      <div class="u-fw-600 u-fs-v_font_size_base u-mb-8px">Unified accounts table (v2 identity)</div>
      <p class="u-c-v_muted u-m-0_0_10px u-fs-v_font_size_sm">Backfills existing creator identities from D1 <code>creators</code> and KV <code>creator:*</code> into the unified <code>accounts</code> table. Newest key hash wins; D1 wins ties. Copies data only &mdash; safe to run more than once.</p>
      <button type="button" class="admin-select u-cur-pointer" id="migrateAccountsBtn" data-act="runMigrateAccounts" ${isD1Bound ? '' : 'disabled'}>Migrate Accounts</button>
      <span id="migrateAccountsStatus" class="u-fs-v_font_size_sm u-ml-6px" style="color:var(--muted);"></span>
    </div>

    <div class="panel u-m-0_0_18px u-p-14px_16px">
      <div class="u-fw-600 u-fs-v_font_size_base u-mb-8px">Install links: keys moving to encrypted storage</div>
      <p class="u-c-v_muted u-m-0_0_10px u-fs-v_font_size_sm">The first time an existing install link is used, its provider keys, tokens and Creator Key move out of its KV record into encrypted D1 storage, for the share of links set in <code>INSTALL_MIGRATION_PERCENT</code>. Links keep their URL and serve exactly as before. Needs <code>TOKEN_ENCRYPTION_KEY</code> and migration 0015. Read-only: this button only reports progress.</p>
      <button type="button" class="admin-select u-cur-pointer" id="installsStatusBtn" data-act="runInstallsStatus" ${isD1Bound ? '' : 'disabled'}>Check progress</button>
      <span id="installsStatus" class="u-fs-v_font_size_sm u-ml-6px" style="color:var(--muted);"></span>
      <p class="u-c-v_muted u-m-12px_0_8px u-fs-v_font_size_sm">Emergency only: puts every moved link's keys back into its KV record, exactly as they were, and empties the table. Set <code>INSTALL_MIGRATION_PERCENT</code> to <code>0</code> first. Links removed from an account stay removed.</p>
      <button type="button" class="admin-select u-cur-pointer" id="installsRestoreBtn" data-act="runInstallsRestore" ${isD1Bound ? '' : 'disabled'}>Undo the move</button>
      <span id="installsRestoreStatus" class="u-fs-v_font_size_sm u-ml-6px" style="color:var(--muted);"></span>
    </div>

    <div class="panel u-m-0_0_18px u-p-14px_16px">
      <div class="u-fw-600 u-fs-v_font_size_base u-mb-8px">Lists v2: copy existing lists</div>
      <p class="u-c-v_muted u-m-0_0_10px u-fs-v_font_size_sm">Copies every account&rsquo;s lists, the old anonymous lists, shared and published channels (their episode lists go to the <code>BLOBS</code> R2 bucket when it is bound), and their likes into the new tables (migration 0016). It only copies: the lists and channels people use today are not changed, and nothing reads the copies until <code>FF_V2_LISTS_READ</code> is on. Run <strong>Migrate Accounts</strong> first, and back up D1 before the first run. It works in small steps and can be stopped and carried on; <strong>Start over</strong> runs it again from the first account, copying only what changed.</p>
      <button type="button" class="admin-select u-cur-pointer" id="listsBackfillBtn" data-act="runListsBackfill" data-act-args="${adminActArgs([false])}" ${isD1Bound ? '' : 'disabled'}>Copy lists</button>
      <button type="button" class="admin-select u-cur-pointer" id="listsBackfillRestartBtn" data-act="runListsBackfill" data-act-args="${adminActArgs([true])}" ${isD1Bound ? '' : 'disabled'}>Start over</button>
      <button type="button" class="admin-select u-cur-pointer" id="listsBackfillStatusBtn" data-act="runListsBackfillStatus" ${isD1Bound ? '' : 'disabled'}>Check results</button>
      <span id="listsBackfillStatus" class="u-fs-v_font_size_sm u-ml-6px" style="color:var(--muted);"></span>
      <div id="listsBackfillResult" class="u-mt-10px u-fs-v_font_size_sm u-c-v_muted"></div>
    </div>

    <div class="panel u-m-0_0_18px u-p-14px_16px">
      <div class="u-fw-600 u-fs-v_font_size_base u-mb-8px">Activity: copy watch history</div>
      <p class="u-c-v_muted u-m-0_0_10px u-fs-v_font_size_sm">Copies every account&rsquo;s Watch History, and where each show is up to (finished, hidden from Continue Watching or Airing Next, storyline suggestions), into the activity database (<code>DB_ACTIVITY</code>, migration A0001). It only copies: the history people see today is not changed, and nothing reads the copy yet. Needs <code>DB_ACTIVITY</code> bound, and <strong>Migrate Accounts</strong> and migration 0016 first. It works in small steps and can be stopped and carried on; <strong>Start over</strong> copies every account again from the start.</p>
      <button type="button" class="admin-select u-cur-pointer" id="activityBackfillBtn" data-act="runActivityBackfill" data-act-args="${adminActArgs([false])}" ${isActivityBound ? '' : 'disabled'}>Copy history</button>
      <button type="button" class="admin-select u-cur-pointer" id="activityBackfillRestartBtn" data-act="runActivityBackfill" data-act-args="${adminActArgs([true])}" ${isActivityBound ? '' : 'disabled'}>Start over</button>
      <button type="button" class="admin-select u-cur-pointer" id="activityBackfillStatusBtn" data-act="runActivityBackfillStatus" ${isActivityBound ? '' : 'disabled'}>Check results</button>
      <span id="activityBackfillStatus" class="u-fs-v_font_size_sm u-ml-6px" style="color:var(--muted);">${isActivityBound ? '' : 'DB_ACTIVITY is not bound.'}</span>
      <div id="activityBackfillResult" class="u-mt-10px u-fs-v_font_size_sm u-c-v_muted"></div>
    </div>

    <div class="panel u-m-0_0_18px u-p-14px_16px">
      <div class="u-fw-600 u-fs-v_font_size_base u-mb-8px">Background jobs queue: ${isJobsBound
        ? '<span class="u-c-v_color_success_text">bound</span>'
        : '<span class="u-c-v_muted">not bound yet</span>'}</div>
      <p class="u-c-v_muted u-m-0_0_10px u-fs-v_font_size_sm">Background work moves onto the Cloudflare Queue <code>mylists-jobs</code>, which this Worker also reads (Phase 5). Setting it up: create the queues <code>mylists-jobs</code> and <code>mylists-jobs-dlq</code>, add this Worker as the consumer of <code>mylists-jobs</code> (batch size 25, 5 retries, dead-letter queue <code>mylists-jobs-dlq</code>), and bind <code>mylists-jobs</code> to this Worker as <code>JOBS</code>. See docs/OPERATIONS.md section 18. <strong>Send a test job</strong> puts one job on the queue and waits for this Worker to pick it up, which proves all three steps worked.</p>
      <button type="button" class="admin-select u-cur-pointer" id="jobsPingBtn" data-act="runJobsPing" ${isJobsBound ? '' : 'disabled'}>Send a test job</button>
      <span id="jobsPingStatus" class="u-fs-v_font_size_sm u-ml-6px" style="color:var(--muted);">${isJobsBound ? '' : 'JOBS is not bound.'}</span>
      <p class="u-c-v_muted u-m-12px_0_8px u-fs-v_font_size_sm">Once the queue is bound, every cron tick only hands out the work that is due (the Continue Watching and Airing Next sweeps, New on Streaming, chart and poster warming, channel presets, housekeeping), and the queue does it. Without it, the tick does the work itself, as before. <strong>Check jobs</strong> shows when each one last ran. Needs migration 0016.</p>
      <button type="button" class="admin-select u-cur-pointer" id="jobsStatusBtn" data-act="runJobsStatus" ${isD1Bound ? '' : 'disabled'}>Check jobs</button>
      <span id="jobsStatusStatus" class="u-fs-v_font_size_sm u-ml-6px" style="color:var(--muted);"></span>
      <div id="jobsStatusResult" class="u-mt-10px u-fs-v_font_size_sm u-c-v_muted"></div>
      <p class="u-c-v_muted u-m-12px_0_8px u-fs-v_font_size_sm"><strong>Compare shelves now</strong> runs the whole Continue Watching and Airing Next comparison (<code>shelf.shadow</code>) from this page, a few minutes instead of the hourly job's 15 hours, and shows why each difference is there. Keep the page open until it says Done. It only reads.</p>
      <button type="button" class="admin-select u-cur-pointer" id="shelfCompareBtn" data-act="runShelfCompareNow" ${isD1Bound ? '' : 'disabled'}>Compare shelves now</button>
      <span id="shelfCompareStatus" class="u-fs-v_font_size_sm u-ml-6px" style="color:var(--muted);"></span>
      <div id="shelfCompareResult" class="u-mt-10px u-fs-v_font_size_sm u-c-v_muted u-ws-pre_wrap u-wb-break_word"></div>
    </div>

    <div class="panel u-m-0 u-p-14px_16px">
      <div class="u-fw-600 u-fs-v_font_size_base u-mb-8px">Database schema</div>
      <p class="u-c-v_muted u-m-0_0_10px u-fs-v_font_size_sm">Migrations are applied by hand and nothing records that it happened, so this Worker can end up running ahead of its own database. It degrades quietly when that happens rather than refusing to start &mdash; which is why this check exists. Run it after any deploy that shipped a new file under <code>migrations/</code>.</p>
      <button type="button" class="admin-select u-cur-pointer" id="schemaCheckBtn" data-act="runSchemaCheck">Check schema</button>
      <span id="schemaCheckStatus" class="u-fs-v_font_size_sm u-ml-6px" style="color:var(--muted);"></span>
      <div id="schemaCheckResult" class="u-mt-10px"></div>
    </div>

    <div class="panel u-m-0 u-p-14px_16px">
      <div class="u-fw-600 u-fs-v_font_size_base u-mb-8px">Counts missing since 2 October</div>
      <p class="u-c-v_muted u-m-0_0_10px u-fs-v_font_size_sm">From 2 October until the fix, page views, install links, playback pings, Most Watched, list adds and searches were counted in Cloudflare Analytics instead of here, so this dashboard showed zeros. This puts them back. It needs the secret <code>CF_ANALYTICS_TOKEN</code> (an API token with <em>Account Analytics: Read</em>) and the variable <code>CF_ANALYTICS_ACCOUNT_ID</code>. <strong>Preview</strong> shows what would be added; <strong>Put them back</strong> adds it. Running it again adds nothing twice.</p>
      <button type="button" class="admin-select u-cur-pointer" id="statsRecoveryPreviewBtn" data-act="runStatsRecovery" data-act-args="${adminActArgs([false])}">Preview</button>
      <button type="button" class="admin-select u-cur-pointer" id="statsRecoveryApplyBtn" data-act="runStatsRecovery" data-act-args="${adminActArgs([true])}">Put them back</button>
      <span id="statsRecoveryStatus" class="u-fs-v_font_size_sm u-ml-6px" style="color:var(--muted);"></span>
      <div id="statsRecoveryResult" class="u-mt-10px u-fs-v_font_size_sm u-c-v_muted"></div>
    </div>

    <div class="panel u-m-0 u-p-14px_16px">
      <div class="u-fw-600 u-fs-v_font_size_base u-mb-8px">Export old data to R2 (a copy)</div>
      <p class="u-c-v_muted u-m-0_0_10px u-fs-v_font_size_sm">Copies every KV key that starts with the text below into the <code>BLOBS</code> bucket, under <code>kv-archive/</code>, a batch at a time, then writes a <code>manifest.json</code> when the copy is complete. It deletes nothing. Type the prefix exactly, with no <code>*</code> (for example <code>stats:</code>). Deleting old data is not safe yet: see docs/CUTOVER.md.</p>
      <input type="text" id="kvExportPrefix" class="admin-select u-minw-180px" placeholder="creator:">
      <button type="button" class="admin-select u-cur-pointer" id="kvExportBtn" data-act="runKvExport">Export</button>
      <span id="kvExportStatus" class="u-fs-v_font_size_sm u-ml-6px" style="color:var(--muted);"></span>
    </div>

    <div class="panel u-m-0 u-p-14px_16px">
      <div class="u-fw-600 u-fs-v_font_size_base u-mb-8px">Public list directory &amp; search index</div>
      <p class="u-c-v_muted u-m-0_0_10px u-fs-v_font_size_sm">The public list directory and in-app search query D1 tables and the full-text search index (lists_fts). This button rebuilds the search index directly from creator_lists &mdash; useful after importing data or to recreate the index after a D1 database export.</p>
      <button type="button" class="admin-select u-cur-pointer" id="rebuildIndexBtn" data-act="runRebuildPublicIndex">Rebuild Search Index</button>
      <span id="rebuildIndexStatus" class="u-fs-v_font_size_sm u-ml-6px" style="color:var(--muted);"></span>
    </div>

    <div class="panel u-m-0 u-p-14px_16px">
      <div class="u-fw-600 u-fs-v_font_size_base u-mb-8px">Delete a creator&rsquo;s lists</div>
      <p class="u-c-v_muted u-m-0_0_10px u-fs-v_font_size_sm">Removes specific lists belonging to one Creator Profile: the list itself, its likes, its place in that creator&rsquo;s order, and its directory entry. Use it for content a creator cannot or will not remove themselves. A slug whose list is already gone is still cleared from the directory, which is how you get rid of an entry that shows an item count but opens empty.</p>
      <p class="u-c-v_muted u-m-0_0_10px u-fs-v_font_size_sm">Browse first: this reads the creator&rsquo;s actual stored records, including any the creator&rsquo;s own dashboard cannot see because they are missing from their display order &mdash; which is how an account ends up with dozens of copies of one list under slugs nobody could guess. Filter by name, select them all, then delete. Deleting also records the deletion on the account, so the creator&rsquo;s other signed-in browsers drop their copies instead of uploading them straight back.</p>
      <p class="u-c-v_color_warn_text u-m-0_0_10px u-fs-v_font_size_sm"><strong>This cannot be undone.</strong> There is no backup of a deleted list. Prefer &ldquo;Rebuild Public List Index&rdquo; above first &mdash; if the lists are only phantom directory entries, that fixes them without deleting anything.</p>
      <div class="row u-mb-8px">
        <input type="text" id="deleteListUserInput" class="admin-select u-mr-6px" placeholder="Creator username">
        <button type="button" class="admin-select u-cur-pointer u-mr-6px" id="browseCreatorListsBtn" data-act="loadCreatorLists" data-act-args="${adminActArgs([true])}">Browse this creator&rsquo;s lists</button>
        <button type="button" class="admin-select u-cur-pointer" id="browseCreatorListsMoreBtn" data-act="loadCreatorLists" data-act-args="${adminActArgs([false])}" hidden>Load more</button>
        <span id="creatorListsStatus" class="u-fs-v_font_size_sm u-ml-6px" style="color:var(--muted);"></span>
      </div>
      <div class="row u-mb-8px">
        <input type="text" id="creatorListsFilterInput" class="admin-select u-minw-280px u-mr-6px" placeholder="Filter by name or slug (e.g. coming of age)" data-act="renderCreatorListsTable" data-act-on="input">
        <button type="button" class="admin-select u-cur-pointer u-mr-6px" id="selectShownListsBtn" data-act="selectShownCreatorLists">Select all shown</button>
        <button type="button" class="admin-select u-cur-pointer" id="clearSelectedListsBtn" data-act="clearSelectedCreatorLists">Clear selection</button>
      </div>
      <div id="creatorListsResults" class="u-mb-8px u-maxh-340px u-ov-auto"></div>
      <div class="row u-mb-8px">
        <input type="text" id="deleteListSlugsInput" class="admin-select u-minw-320px" placeholder="Slugs, comma or newline separated">
      </div>
      <button type="button" class="admin-select u-cur-pointer u-c-v_color_danger_text u-bdc-rgba_255_59_48_0_35" id="deleteListBtn" data-act="runDeleteCreatorLists">Delete these lists</button>
      <span id="deleteListStatus" class="u-fs-v_font_size_sm u-ml-6px" style="color:var(--muted);"></span>
    </div>

    <div class="panel u-m-0 u-p-14px_16px">
      <div class="u-fw-600 u-fs-v_font_size_base u-mb-8px">Anonymously published lists</div>
      <p class="u-c-v_muted u-m-0_0_10px u-fs-v_font_size_sm">Lists published without a Creator Profile, under the shared <code>user</code> namespace. Anyone can create one and no owner exists to ask, so this is the only way to remove one. Browse to find a list, or type slugs directly if you already know them.</p>
      <p class="u-c-v_color_warn_text u-m-0_0_10px u-fs-v_font_size_sm"><strong>This cannot be undone.</strong> There is no backup of a deleted list.</p>
      <div class="row u-mb-8px">
        <button type="button" class="admin-select u-cur-pointer u-mr-6px" id="browseAnonBtn" data-act="loadPublishedLists" data-act-args="${adminActArgs([true])}">Browse</button>
        <button type="button" class="admin-select u-cur-pointer" id="browseAnonMoreBtn" data-act="loadPublishedLists" data-act-args="${adminActArgs([false])}" hidden>Load more</button>
        <span id="anonListStatus" class="u-fs-v_font_size_sm u-ml-6px" style="color:var(--muted);"></span>
      </div>
      <div id="anonListResults" class="u-mb-8px"></div>
      <div class="row u-mb-8px">
        <input type="text" id="deleteAnonSlugsInput" class="admin-select u-minw-320px" placeholder="Slugs, comma or newline separated">
      </div>
      <button type="button" class="admin-select u-cur-pointer u-c-v_color_danger_text u-bdc-rgba_255_59_48_0_35" id="deleteAnonBtn" data-act="runDeletePublishedLists">Delete these lists</button>
      <span id="deleteAnonStatus" class="u-fs-v_font_size_sm u-ml-6px" style="color:var(--muted);"></span>
    </div>

    <div class="admin-card u-mt-12px">
      <h3 class="u-m-0_0_6px u-fs-v_font_size_base">Published channels</h3>
      <p class="u-m-0_0_10px u-c-v_muted u-fs-v_font_size_sm">
        The Explore Channels directory. Publishing a channel is owner-only, so without this panel
        a channel could only be withdrawn by whoever put it there.
        <strong>Unlist</strong> removes it from the directory and leaves existing share links working &mdash;
        the same thing its owner&rsquo;s own Unpublish does. <strong>Delete</strong> removes the stored channel,
        so every link to it stops working.
      </p>
      <div class="row u-mb-8px">
        <button type="button" class="admin-select u-cur-pointer u-mr-6px" id="browseChannelsBtn" data-act="loadPublishedChannels" data-act-args="${adminActArgs(['listed'])}">Browse the directory</button>
        <button type="button" class="admin-select u-cur-pointer" id="browseChannelsAllBtn" data-act="loadPublishedChannels" data-act-args="${adminActArgs(['all'])}">Browse every stored channel</button>
        <span id="publishedChannelStatus" class="u-fs-v_font_size_sm u-ml-6px" style="color:var(--muted);"></span>
      </div>
      <div id="publishedChannelResults"></div>
    </div>

    <div class="panel u-m-0_0_18px u-p-14px_16px">
      <div class="u-fw-600 u-fs-v_font_size_base u-mb-8px">Signed-in admin browsers</div>
      <p class="u-c-v_muted u-m-0_0_10px u-fs-v_font_size_sm">Every browser signed in to this dashboard, newest activity first, with the address it signed in from. Before P7-2 there was no such list: the cookie was self-contained, so signing anyone out meant changing <code>ADMIN_KEY</code> and signing everyone out. <strong>Sign out</strong> ends one browser's session on its own &mdash; it stops working on the next request, not in seven days. Needs migration 0018. If you are signed in with Cloudflare Access, your browser may appear here too; closing its row does not stop Access from letting you back in.</p>
      <button type="button" class="admin-select u-cur-pointer" id="adminSessionsBtn" data-act="loadAdminSessions">Load</button>
      <button type="button" class="admin-select u-cur-pointer u-ml-6px u-c-v_color_danger_text u-bdc-rgba_255_59_48_0_35" id="adminSessionsRevokeAllBtn" data-act="revokeAllAdminSessions">Sign out every browser</button>
      <span id="adminSessionsStatus" class="u-fs-v_font_size_sm u-ml-6px" style="color:var(--muted);"></span>
      <div id="adminSessionsResult" class="u-mt-10px"></div>
    </div>

    <div class="panel u-m-0 u-p-14px_16px">
      <div class="u-fw-600 u-fs-v_font_size_base u-mb-8px">Audit log</div>
      <p class="u-c-v_muted u-m-0_0_10px u-fs-v_font_size_sm">What this dashboard has been used for: sign-ins, sign-outs, and every action that changes something &mdash; resetting a creator&rsquo;s key, deleting a list or a channel, running a migration, replying to feedback. Each row is written as the request is authorized, with the address it came from and the identifying details it named (never a key or a token). Newest first, and read-only: nothing in this dashboard can edit it. Needs migration 0018.</p>
      <button type="button" class="admin-select u-cur-pointer" id="adminAuditBtn" data-act="loadAdminAudit">Load recent activity</button>
      <span id="adminAuditStatus" class="u-fs-v_font_size_sm u-ml-6px" style="color:var(--muted);"></span>
      <div id="adminAuditResult" class="u-mt-10px"></div>
    </div>
  </div>

  <!-- A form, not a link: logging out is a state change, and /admin/logout
       answers POST only now. See that route for why. -->
  <form method="POST" action="/admin/logout" class="u-mt-24px">
    <button type="submit" class="linklike">Log out</button>
  </form>
  <script nonce="${CSP_NONCE_PLACEHOLDER}">
    const categoryDefaults = {
      overview: 'last30',
      discovery: 'trending',
      management: 'creators',
    };
    const tabToCategory = {
      last30: 'overview',
      sources: 'overview',
      apiusage: 'overview',
      trending: 'discovery',
      search: 'discovery',
      catalogs_lists: 'discovery',
      audience: 'discovery',
      creators: 'management',
      feedback: 'management',
      support_emails: 'management',
      netflixpreview: 'management',
      newonstreaming: 'management',
      channelpresets: 'management',
      supportgoal: 'management',
      maintenance: 'management',
    };

    function switchAdminMainTab(catId) {
      document.querySelectorAll('.admin-main-tab-btn').forEach((b) => {
        const on = b.dataset.mainTab === catId;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      document.querySelectorAll('.admin-subnav-bar').forEach((bar) => {
        bar.style.display = bar.id === ('adminSubnav' + catId.charAt(0).toUpperCase() + catId.slice(1)) ? 'flex' : 'none';
      });
      let targetSubTab = categoryDefaults[catId] || 'last30';
      try {
        const savedTab = localStorage.getItem('myListAddon:adminActiveTab');
        if (savedTab && tabToCategory[savedTab] === catId) {
          targetSubTab = savedTab;
        }
      } catch (e) {}
      switchAdminSubTab(targetSubTab);
    }

    function switchAdminSubTab(tabId, updateUrl = true) {
      const cat = tabToCategory[tabId] || 'overview';
      try {
        localStorage.setItem('myListAddon:adminActiveTab', tabId);
      } catch (e) {}
      if (updateUrl && history.replaceState) {
        history.replaceState(null, '', '#' + tabId);
      }
      document.querySelectorAll('.admin-main-tab-btn').forEach((b) => {
        const on = b.dataset.mainTab === cat;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      document.querySelectorAll('.admin-subnav-bar').forEach((bar) => {
        bar.style.display = bar.id === ('adminSubnav' + cat.charAt(0).toUpperCase() + cat.slice(1)) ? 'flex' : 'none';
      });
      document.querySelectorAll('.subnav-pill').forEach((p) => p.classList.toggle('active', p.dataset.subTab === tabId));
      document.querySelectorAll('.admin-tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.adminPanel === tabId));

      if (tabId === 'trending' && !window._trendingLoadedOnce) { window._trendingLoadedOnce = true; loadTrendingData(); }
      if (tabId === 'search' && !window._searchLoadedOnce) { window._searchLoadedOnce = true; loadSearchData(); }
      if (tabId === 'catalogs_lists' && !window._catalogsListsLoadedOnce) { window._catalogsListsLoadedOnce = true; loadCatalogsAndListsData(); }
      if (tabId === 'audience' && !window._audienceLoadedOnce) { window._audienceLoadedOnce = true; loadAudienceData(); }
      if (tabId === 'feedback' && !window._feedbackLoadedOnce) { window._feedbackLoadedOnce = true; loadFeedback(); }
      if (tabId === 'support_emails' && !window._supportEmailsLoadedOnce) { window._supportEmailsLoadedOnce = true; loadSupportEmailThreads(); }
      if (tabId === 'apiusage' && !window._apiUsageLoadedOnce) { window._apiUsageLoadedOnce = true; loadApiUsage(); }
      if (tabId === 'netflixpreview' && !window._netflixPreviewLoadedOnce) { window._netflixPreviewLoadedOnce = true; loadNetflixPreview(); }
      if (tabId === 'newonstreaming' && !window._newOnStreamingLoadedOnce) { window._newOnStreamingLoadedOnce = true; loadNewOnStreaming(); }
      if (tabId === 'channelpresets' && !window._channelPresetsLoadedOnce) { window._channelPresetsLoadedOnce = true; loadChannelPresets(); }
      if (tabId === 'supportgoal' && !window._supportGoalLoadedOnce) { window._supportGoalLoadedOnce = true; loadSupportGoal(); }
    }

    async function loadSupportGoal() {
      const status = document.getElementById('supportGoalStatus');
      try {
        const res = await fetch('/admin/api/support-goal', { cache: 'no-store' });
        const data = await res.json();
        if (!data || !data.ok) { if (status) status.textContent = (data && data.error) || 'Could not load.'; return; }
        document.getElementById('supportGoalEnabled').checked = !!data.enabled;
        document.getElementById('supportGoalAmount').value = data.goal ? data.goal : '';
        document.getElementById('supportGoalRaised').value = data.raised ? data.raised : '';
        const m = document.getElementById('supportGoalMonth');
        if (m) m.textContent = data.month || 'this month';
        const w = document.getElementById('supportGoalWebhookUrl');
        if (w) w.textContent = data.webhookUrl || '';
        const t = document.getElementById('supportGoalTokenState');
        if (t) { t.textContent = data.kofiTokenSet ? 'set' : 'not set yet'; t.style.color = data.kofiTokenSet ? '#30d158' : '#ff9f0a'; }
        const l = document.getElementById('supportGoalLastPayment');
        if (l && data.lastPayment) l.textContent = '$' + data.lastPayment.amount + ' on ' + new Date(data.lastPayment.at).toLocaleString();
      } catch (e) {
        if (status) status.textContent = 'Could not load.';
      }
    }

    async function saveSupportGoal() {
      const status = document.getElementById('supportGoalStatus');
      const say = (text, color) => { if (status) { status.textContent = text; status.style.color = color || '#8E8E93'; } };
      const goalText = document.getElementById('supportGoalAmount').value.trim();
      const raisedText = document.getElementById('supportGoalRaised').value.trim();
      say('Saving...');
      try {
        const res = await fetch('/admin/api/support-goal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            enabled: document.getElementById('supportGoalEnabled').checked,
            goal: goalText === '' ? 0 : Number(goalText),
            raised: raisedText === '' ? 0 : Number(raisedText),
          }),
        });
        const data = await res.json();
        if (!data || !data.ok) { say((data && data.error) || 'Could not save.', '#ff453a'); return; }
        say('Saved. The site shows it within five minutes.', '#30d158');
        loadSupportGoal();
      } catch (e) {
        say('Could not save.', '#ff453a');
      }
    }

    function restoreAdminActiveTab() {
      let targetTab = '';
      const hashTab = (window.location.hash || '').replace(/^#/, '').trim();
      if (hashTab && tabToCategory[hashTab]) {
        targetTab = hashTab;
      } else {
        try {
          const savedTab = localStorage.getItem('myListAddon:adminActiveTab');
          if (savedTab && tabToCategory[savedTab]) {
            targetTab = savedTab;
          }
        } catch (e) {}
      }
      if (!targetTab) targetTab = 'last30';
      switchAdminSubTab(targetTab, false);
    }

    window.addEventListener('hashchange', () => {
      const hashTab = (window.location.hash || '').replace(/^#/, '').trim();
      if (hashTab && tabToCategory[hashTab]) {
        switchAdminSubTab(hashTab, false);
      }
    });

    restoreAdminActiveTab();

    // Resets a creator's login key server-side (see /admin/api/reset-creator-key
    // -- it can only invalidate + replace, never recover the original,
    // since only a salted hash of it is ever stored). Two-step confirm
    // matching this dashboard's other destructive actions: a plain
    // confirm() naming exactly what's about to happen and to whom, then
    // the new key is shown once in a copyable box -- there is no second
    // chance to see it, same as the reveal shown at signup.
    async function resetCreatorKey(btn) {
      const username = btn.dataset.username;
      const displayName = btn.dataset.displayname;
      const sure = confirm(
        'Reset the login key for "' + displayName + '" (' + username + ')?\\n\\n' +
        'Their current key will stop working immediately. You will need to ' +
        'send them the new key yourself -- there is no email on file to send it to.'
      );
      if (!sure) return;
      try {
        const res = await fetch('/admin/api/reset-creator-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: username }),
        });
        const data = await res.json();
        if (!data.ok) {
          showAdminAlert('Reset Failed', 'Could not reset key: ' + (data.error || 'unknown error'), false);
          return;
        }
        showResetKeyModal(displayName, data.creatorKey);
      } catch (e) {
        showAdminAlert('Network Error', 'Could not reset the key -- check your connection and try again.', false);
      }
    }

    function showResetKeyModal(displayName, creatorKey) {
      const overlay = document.createElement('div');
      overlay.id = 'resetKeyOverlay';
      overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:9999;';
      overlay.innerHTML =
        '<div class="u-bg-v_color_on_brand u-br-v_radius_md u-p-24px u-maxw-380px" style="width:90%;">' +
          '<h3 class="u-mt-0">New key for ' + escapeHtmlAdmin(displayName) + '</h3>' +
          '<p class="u-c-v_muted u-fs-v_font_size_base">This is shown once. Copy it now and send it to the creator yourself -- their old key no longer works.</p>' +
          '<div id="resetKeyDisplay" class="u-ff-monospace u-fs-v_font_size_lg u-bg-F2F2F7 u-br-v_radius_sm u-p-10px u-ta-center u-m-12px_0 u-us-all">' + escapeHtmlAdmin(creatorKey) + '</div>' +
          '<div class="u-gap-8px" style="display:flex;">' +
            '<button type="button" class="lc-btn secondary u-flex-1" data-act="copyResetKey" data-act-args="' + adminActAttr(['@self', creatorKey]) + '">Copy Key</button>' +
            '<button type="button" class="lc-btn u-flex-1" data-act="closeResetKeyOverlay">Done</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
    }

    // The two buttons inside that box. The key used to be written into a
    // JavaScript string inside the button's own handler; it arrives as data
    // now, through the same delegated args every other control uses (P6-10).
    function copyResetKey(btn, key) {
      const text = String(key == null ? '' : key);
      const done = function () {
        if (btn) btn.textContent = 'Copied!';
      };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, done);
        } else {
          done();
        }
      } catch (e) {
        done();
      }
    }

    function closeResetKeyOverlay() {
      const overlay = document.getElementById('resetKeyOverlay');
      if (overlay && overlay.remove) overlay.remove();
    }

    // --- P7-2: the two security panels -------------------------------------

    function adminWhen(ms) {
      if (!ms) return '\u2014';
      try {
        return new Date(ms).toLocaleString();
      } catch (e) {
        return String(ms);
      }
    }

    async function loadAdminSessions() {
      const box = document.getElementById('adminSessionsResult');
      const status = document.getElementById('adminSessionsStatus');
      status.textContent = 'Loading\u2026';
      box.innerHTML = '';
      try {
        const res = await fetch('/admin/api/admin-sessions');
        const data = await res.json();
        status.textContent = '';
        if (!data.ok) {
          status.textContent = data.error || 'Could not load.';
          return;
        }
        if (data.unavailable) {
          box.innerHTML = '<p class="u-c-v_muted u-fs-v_font_size_sm u-m-0">No session list yet &mdash; apply migration 0018 (<code>migrations/0018_admin_sessions_audit.sql</code>). Until then, this dashboard signs in with the older cookie, which cannot be listed or revoked on its own.</p>';
          return;
        }
        if (!data.sessions.length) {
          box.innerHTML = '<p class="u-c-v_muted u-fs-v_font_size_sm u-m-0">No signed-in browsers.</p>';
          return;
        }
        const rows = data.sessions.map((s) => {
          const current = s.id === data.current ? ' <span class="u-c-v_color_success_text">(this browser)</span>' : '';
          const state = s.revokedAt ? '<span class="u-c-v_color_danger_text">signed out</span>' : (s.expired ? '<span class="u-c-v_color_warn_text">expired</span>' : '<span class="u-c-v_color_success_text">live</span>');
          return '<tr>' +
            '<td>' + escapeHtmlAdmin(s.actor) + current + '</td>' +
            '<td>' + state + '</td>' +
            '<td>' + escapeHtmlAdmin(adminWhen(s.lastSeenAt)) + '</td>' +
            '<td>' + escapeHtmlAdmin(adminWhen(s.expiresAt)) + '</td>' +
            '<td>' + escapeHtmlAdmin(s.ip || '\u2014') + '</td>' +
            '<td class="u-maxw-220px u-ov-hidden u-to-ellipsis u-ws-nowrap">' + escapeHtmlAdmin(s.userAgent || '\u2014') + '</td>' +
            '<td>' + (s.revokedAt || s.expired ? '' : '<button type="button" class="admin-select u-cur-pointer u-c-v_color_danger_text u-bdc-rgba_255_59_48_0_35" data-act="revokeAdminSession" data-act-args="' + adminActAttr([s.id]) + '">Sign out</button>') + '</td>' +
            '</tr>';
        }).join('');
        box.innerHTML = '<table><tr><th>Signed in as</th><th>State</th><th>Last seen</th><th>Expires</th><th>IP</th><th>Browser</th><th></th></tr>' + rows + '</table>';
      } catch (e) {
        status.textContent = 'Could not load \u2014 try again.';
      }
    }

    async function revokeAdminSession(btn, id) {
      const sure = confirm('Sign that browser out of the admin dashboard?\\n\\nIt stops working on its next request. If it is this browser, you will be asked to sign in again.');
      if (!sure) return;
      try {
        const res = await fetch('/admin/api/revoke-admin-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id }),
        });
        const data = await res.json();
        if (!data.ok) {
          showAdminAlert('Could not sign out', data.error || 'Unknown error.', false);
          return;
        }
        if (data.self) {
          window.location.href = '/admin';
          return;
        }
        loadAdminSessions();
      } catch (e) {
        showAdminAlert('Network Error', 'Could not reach the server \u2014 try again.', false);
      }
    }

    async function revokeAllAdminSessions() {
      const sure = confirm('Sign every browser out of the admin dashboard, including this one?\\n\\nEach one stops working on its next request, and you will need the admin key (or Cloudflare Access) to get back in. Nothing else about the site is affected.');
      if (!sure) return;
      try {
        const res = await fetch('/admin/api/revoke-admin-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ all: true }),
        });
        const data = await res.json();
        if (!data.ok) {
          showAdminAlert('Could not sign out', data.error || 'Unknown error.', false);
          return;
        }
        showAdminAlert('Signed out', (data.revoked || 0) + ' session(s) ended.', true);
        loadAdminSessions();
      } catch (e) {
        showAdminAlert('Network Error', 'Could not reach the server \u2014 try again.', false);
      }
    }

    async function loadAdminAudit() {
      const box = document.getElementById('adminAuditResult');
      const status = document.getElementById('adminAuditStatus');
      status.textContent = 'Loading\u2026';
      box.innerHTML = '';
      try {
        const res = await fetch('/admin/api/audit?limit=100');
        const data = await res.json();
        status.textContent = '';
        if (!data.ok) {
          status.textContent = data.error || 'Could not load.';
          return;
        }
        if (data.unavailable) {
          box.innerHTML = '<p class="u-c-v_muted u-fs-v_font_size_sm u-m-0">No log yet &mdash; apply migration 0018 (<code>migrations/0018_admin_sessions_audit.sql</code>). Until then, admin actions are not recorded.</p>';
          return;
        }
        if (!data.entries.length) {
          box.innerHTML = '<p class="u-c-v_muted u-fs-v_font_size_sm u-m-0">Nothing recorded yet. Signing out and back in writes the first two rows.</p>';
          return;
        }
        const rows = data.entries.map((e) =>
          '<tr>' +
          '<td>' + escapeHtmlAdmin(adminWhen(e.at)) + '</td>' +
          '<td>' + escapeHtmlAdmin(e.actor) + '</td>' +
          '<td><strong>' + escapeHtmlAdmin(e.action) + '</strong></td>' +
          '<td>' + escapeHtmlAdmin(e.target || '\u2014') + '</td>' +
          '<td class="u-maxw-320px u-ov-hidden u-to-ellipsis u-ws-nowrap" title="' + escapeHtmlAdmin(e.detail || '') + '">' + escapeHtmlAdmin(e.detail || '\u2014') + '</td>' +
          '<td>' + escapeHtmlAdmin(e.ip || '\u2014') + '</td>' +
          '</tr>'
        ).join('');
        box.innerHTML = '<table><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Detail</th><th>IP</th></tr>' + rows + '</table>';
      } catch (e) {
        status.textContent = 'Could not load \u2014 try again.';
      }
    }

    async function loadSearchData() {
      const body = document.getElementById('searchTableBody');
      body.innerHTML = '<tr><td colspan="3">Loading\u2026</td></tr>';
      const win = document.getElementById('searchWindowSelect').value;
      try {
        const res = await fetch('/admin/api/analytics?section=search&window=' + encodeURIComponent(win));
        const data = await res.json();
        if (!data.ok || !data.searches || !data.searches.length) {
          body.innerHTML = '<tr><td colspan="3">No searches recorded yet for this window.</td></tr>';
          return;
        }
        body.innerHTML = data.searches.map((s, i) =>
          '<tr><td>' + (i + 1) + '</td><td><strong>' + escapeHtmlAdmin(s.query) + '</strong></td><td>' + s.count + '</td></tr>'
        ).join('');
      } catch (e) {
        body.innerHTML = '<tr><td colspan="3">Could not load search data -- try again.</td></tr>';
      }
    }

    async function loadCatalogsAndListsData() {
      const catBody = document.getElementById('installedCatalogsTableBody');
      const listBody = document.getElementById('topCommunityListsTableBody');
      catBody.innerHTML = '<tr><td colspan="3">Loading\u2026</td></tr>';
      listBody.innerHTML = '<tr><td colspan="7">Loading\u2026</td></tr>';
      try {
        const res = await fetch('/admin/api/analytics?section=catalogs_lists');
        const data = await res.json();
        if (!data.ok) {
          catBody.innerHTML = '<tr><td colspan="3">Could not load.</td></tr>';
          listBody.innerHTML = '<tr><td colspan="7">Could not load.</td></tr>';
          return;
        }
        if (!data.catalogs || !data.catalogs.length) {
          catBody.innerHTML = '<tr><td colspan="3">No catalog installations recorded yet.</td></tr>';
        } else {
          catBody.innerHTML = data.catalogs.map((c, i) =>
            '<tr><td>' + (i + 1) + '</td><td>' + escapeHtmlAdmin(c.name) + '</td><td>' + c.count + '</td></tr>'
          ).join('');
        }

        if (!data.communityLists || !data.communityLists.length) {
          listBody.innerHTML = '<tr><td colspan="7">No community lists found.</td></tr>';
        } else {
          listBody.innerHTML = data.communityLists.map((l, i) =>
            '<tr><td>' + (i + 1) + '</td><td><strong>' + escapeHtmlAdmin(l.name) + '</strong></td><td>' + escapeHtmlAdmin(l.creator) + '</td><td>' + escapeHtmlAdmin(l.type) + '</td><td>' + l.itemCount + '</td><td>&#x2764; ' + l.likes + '</td><td>' + l.copies + '</td></tr>'
          ).join('');
        }
      } catch (e) {
        catBody.innerHTML = '<tr><td colspan="3">Could not load -- try again.</td></tr>';
        listBody.innerHTML = '<tr><td colspan="7">Could not load -- try again.</td></tr>';
      }
    }

    async function loadAudienceData() {
      const genresBody = document.getElementById('topGenresTableBody');
      const decadesBody = document.getElementById('topDecadesTableBody');
      genresBody.innerHTML = '<tr><td colspan="3">Loading\u2026</td></tr>';
      decadesBody.innerHTML = '<tr><td colspan="3">Loading\u2026</td></tr>';
      try {
        const res = await fetch('/admin/api/analytics?section=audience');
        const data = await res.json();
        if (!data.ok) {
          genresBody.innerHTML = '<tr><td colspan="3">Could not load.</td></tr>';
          decadesBody.innerHTML = '<tr><td colspan="3">Could not load.</td></tr>';
          return;
        }

        const wt = data.watchTypes || {};
        document.getElementById('audienceTotalPlays').textContent = (wt.total || 0).toLocaleString();
        document.getElementById('audienceMoviePlays').textContent = (wt.movies || 0).toLocaleString();
        document.getElementById('audienceSeriesPlays').textContent = (wt.series || 0).toLocaleString();
        document.getElementById('audienceEpisodePlays').textContent = (wt.episodes || 0).toLocaleString();

        if (!data.genres || !data.genres.length) {
          genresBody.innerHTML = '<tr><td colspan="3">No genre playback data yet.</td></tr>';
        } else {
          genresBody.innerHTML = data.genres.map((g, i) =>
            '<tr><td>' + (i + 1) + '</td><td>' + escapeHtmlAdmin(g.name) + '</td><td>' + g.count + '</td></tr>'
          ).join('');
        }

        if (!data.decades || !data.decades.length) {
          decadesBody.innerHTML = '<tr><td colspan="3">No decade playback data yet.</td></tr>';
        } else {
          decadesBody.innerHTML = data.decades.map((d, i) =>
            '<tr><td>' + (i + 1) + '</td><td>' + escapeHtmlAdmin(d.name) + '</td><td>' + d.count + '</td></tr>'
          ).join('');
        }
      } catch (e) {
        genresBody.innerHTML = '<tr><td colspan="3">Could not load -- try again.</td></tr>';
        decadesBody.innerHTML = '<tr><td colspan="3">Could not load -- try again.</td></tr>';
      }
    }

    function escapeHtmlAdmin(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // --- the delegated actions (P6-10) ---------------------------------------
    //
    // Every control on this page used to carry its action in an inline on*=
    // attribute -- 76 of them. That is what kept script-src on 'unsafe-inline'
    // for this page and what made a display name spliced into a handler a way
    // into it. A control now names its action the way the builder page's do
    // (P6-8, appActDispatch in 16_client-row-core.js): data-act, arguments as
    // one JSON attribute, one listener per event type. /admin does not load
    // that bundle -- it is its own document with its own script -- so this page
    // carries its own copy of the contract, and the attribute names match on
    // purpose.
    //
    // adminActAttr is the browser-side twin of adminActArgs (the Worker-side
    // one above renderAdminDashboard): this one is for the markup built here,
    // in the page, from data the server sent.
    function adminActAttr(values) {
      const out = [];
      const list = values || [];
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        out.push(v === undefined || v === null ? '' : v);
      }
      return escapeHtmlAdmin(JSON.stringify(out));
    }

    const ADMIN_ACT_EVENT_TYPES = ['click', 'change', 'input', 'keydown'];
    const _adminActMissing = {};

    function adminActElement(node) {
      let el = node;
      while (el && typeof el.getAttribute === 'function') {
        if (el.getAttribute('data-act')) return el;
        el = el.parentNode || el.parentElement || null;
      }
      return null;
    }

    function adminActReadArgs(el, ev) {
      const raw = el.getAttribute('data-act-args');
      if (!raw) return [];
      let values = null;
      try {
        values = JSON.parse(raw);
      } catch (e) {
        return [];
      }
      if (!Array.isArray(values)) return [];
      const out = [];
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v === '@self') out.push(el);
        else if (v === '@checked') out.push(!!el.checked);
        else if (v === '@value') out.push(el.value);
        else if (v === '@event') out.push(ev);
        else out.push(v);
      }
      return out;
    }

    // Which event a control answers to: what it says, or its tag. A select
    // answers change, a button click, and an input that searches as you type
    // says data-act-on="input" -- an input answering both would run twice.
    function adminActAnswers(el, ev) {
      if (!ev) return false;
      const explicit = el.getAttribute('data-act-on');
      if (explicit) {
        const list = String(explicit).split(',');
        for (let i = 0; i < list.length; i++) {
          if (list[i].trim() === ev.type) return true;
        }
        return false;
      }
      if (el.hasAttribute('data-act-keys')) return ev.type === 'keydown';
      const tag = String(el.tagName || el.nodeName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return ev.type === 'change';
      return ev.type === 'click';
    }

    function adminActRunOne(el, ev) {
      const name = el.getAttribute('data-act') || '';
      if (!name) return false;
      if (!adminActAnswers(el, ev)) return false;
      if (el.hasAttribute('data-act-keys')) {
        const wanted = el.getAttribute('data-act-keys') || '';
        if (String(ev.key || '') !== wanted) return false;
      }
      const fn = window[name];
      if (typeof fn !== 'function') {
        // A renamed or misspelled action fails loudly once per name, instead of
        // being a button that silently does nothing -- the same net the builder
        // page has, and html_checks.py checks these names the same way.
        if (!_adminActMissing[name]) {
          _adminActMissing[name] = true;
          console.warn('Admin action not found: ' + name);
        }
        return false;
      }
      if (ev && el.hasAttribute('data-act-stop') && typeof ev.stopPropagation === 'function') ev.stopPropagation();
      if (ev && el.hasAttribute('data-act-prevent') && typeof ev.preventDefault === 'function') ev.preventDefault();
      fn.apply(null, adminActReadArgs(el, ev));
      const then = el.getAttribute('data-act-then');
      if (then && typeof window[then] === 'function') window[then]();
      return true;
    }

    function adminActDispatch(ev) {
      if (!ev) return false;
      let el = adminActElement(ev.target || null);
      let ran = false;
      // Innermost first, the order nested inline handlers ran in; a control
      // that says data-act-stop ends the walk.
      while (el) {
        const stops = el.hasAttribute('data-act-stop');
        if (adminActRunOne(el, ev)) ran = true;
        if (stops) break;
        el = adminActElement(el.parentNode || el.parentElement || null);
      }
      return ran;
    }

    function initAdminDelegatedActions() {
      if (window._adminActBound) return false;
      window._adminActBound = true;
      const handler = function (ev) { adminActDispatch(ev); };
      for (let i = 0; i < ADMIN_ACT_EVENT_TYPES.length; i++) {
        document.addEventListener(ADMIN_ACT_EVENT_TYPES[i], handler, false);
      }
      return true;
    }

    // Bound here, right after the block that declares ADMIN_ACT_EVENT_TYPES --
    // not up with restoreAdminActiveTab() further down the file, which runs
    // EARLIER than this point in the script and would hit the const's
    // temporal dead zone and take the whole dashboard down with it.
    initAdminDelegatedActions();

    async function loadTrendingData() {
      const body = document.getElementById('trendingTableBody');
      body.innerHTML = '<tr><td colspan="4">Loading\u2026</td></tr>';
      const type = document.getElementById('trendingTypeSelect').value;
      const win = document.getElementById('trendingWindowSelect').value;
      const mediaType = document.getElementById('trendingMediaTypeSelect').value;
      try {
        const res = await fetch('/admin/api/leaderboard?type=' + encodeURIComponent(type) + '&window=' + encodeURIComponent(win) + (mediaType ? '&mediaType=' + encodeURIComponent(mediaType) : ''));
        const data = await res.json();
        if (!data.ok || !data.entries || !data.entries.length) {
          body.innerHTML = '<tr><td colspan="4">No data yet for this window.</td></tr>';
          return;
        }
        body.innerHTML = data.entries.map((e, i) =>
          '<tr><td>' + (i + 1) + '</td><td>' + escapeHtmlAdmin(e.title || e.id) + '</td><td>' + escapeHtmlAdmin(e.mediaType === 'series' ? 'Show' : 'Movie') + '</td><td>' + e.count + '</td></tr>'
        ).join('');
      } catch (e) {
        body.innerHTML = '<tr><td colspan="4">Could not load -- try again.</td></tr>';
      }
    }

    async function runBackfillTrending() {
      const btn = document.getElementById('backfillTrendingBtn');
      const status = document.getElementById('backfillTrendingStatus');
      btn.disabled = true;
      let accountsDone = 0;
      let titlesDone = 0;
      let safetyCounter = 0;
      // safetyCounter guards against an unexpected infinite loop (e.g. a
      // bug that never returns done:true) -- 500 calls is comfortably
      // past what any realistic account count needs right now, and this
      // is a manual, admin-triggered action, not something that runs
      // unattended.
      try {
        while (safetyCounter < 500) {
          safetyCounter++;
          const res = await fetch('/admin/api/backfill-trending', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
          const data = await res.json();
          if (!data.ok) {
            status.textContent = 'Stopped: ' + (data.error || 'unknown error') + ' (processed ' + accountsDone + ' account' + (accountsDone === 1 ? '' : 's') + ')';
            break;
          }
          if (data.done) {
            status.textContent = 'Done \u2014 processed ' + accountsDone + ' account' + (accountsDone === 1 ? '' : 's') + ', ' + titlesDone + ' title update' + (titlesDone === 1 ? '' : 's') + '.';
            break;
          }
          accountsDone += data.accountsThisCall || 0;
          titlesDone += data.titlesThisCall || 0;
          status.textContent = 'Working\u2026 ' + accountsDone + ' account' + (accountsDone === 1 ? '' : 's') + ' processed so far.';
        }
      } catch (e) {
        status.textContent = 'Stopped: network error (processed ' + accountsDone + ' accounts).';
      }
      btn.disabled = false;
      loadTrendingData();
    }

    // Same shape as runBackfillTrending just above -- see
    // /admin/api/migrate-day-counts's own comment for what this is
    // actually migrating and why.
    async function runMigrateDayCounts() {
      const btn = document.getElementById('migrateDayCountsBtn');
      const status = document.getElementById('migrateDayCountsStatus');
      btn.disabled = true;
      let keysMigrated = 0;
      let safetyCounter = 0;
      try {
        while (safetyCounter < 1000) {
          safetyCounter++;
          const res = await fetch('/admin/api/migrate-day-counts', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
          const data = await res.json();
          if (!data.ok) {
            status.textContent = 'Stopped: ' + (data.error || 'unknown error') + ' (migrated ' + keysMigrated + ' day-count' + (keysMigrated === 1 ? '' : 's') + ')';
            break;
          }
          if (data.done) {
            status.textContent = 'Done \u2014 migrated ' + keysMigrated + ' old day-count' + (keysMigrated === 1 ? '' : 's') + ' into the new format.';
            break;
          }
          keysMigrated += data.keysMigratedThisCall || 0;
          status.textContent = 'Working\u2026 ' + keysMigrated + ' day-count' + (keysMigrated === 1 ? '' : 's') + ' migrated so far.';
        }
      } catch (e) {
        status.textContent = 'Stopped: network error (migrated ' + keysMigrated + ' day-counts).';
      }
      btn.disabled = false;
      loadTrendingData();
      if (typeof loadSearchData === 'function') loadSearchData();
    }

    // Like the loops above, /admin/api/migrate-d1 now does one bounded chunk
    // per call rather than the whole sweep -- see its own comment for why a
    // single pass could not survive a site large enough to need migrating --
    // so this keeps calling until it reports done. The results object comes
    // back cumulative for the whole run, so the final response already holds
    // the totals and there is nothing to add up here.
    //
    // No backticks in this function, or anywhere else inside
    // renderAdminDashboard's returned template literal: everything from that
    // opening backtick onwards is string content, so one here would close the
    // template early and break the whole admin page. (The module-scope
    // helpers at the top of this file are ordinary JS and do use them.)
    async function runMigrateD1() {
      const btn = document.getElementById('migrateD1Btn');
      const status = document.getElementById('migrateD1Status');
      btn.disabled = true;
      status.textContent = 'Working\u2026 this can take a moment on a large site.';
      let safetyCounter = 0;
      try {
        while (safetyCounter < 1000) {
          safetyCounter++;
          const res = await fetch('/admin/api/migrate-d1', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
          const data = await res.json();
          if (!data.ok) {
            status.textContent = 'Failed: ' + (data.error || 'unknown error');
            break;
          }
          const r = data.results || {};
          if (!data.done) {
            status.textContent = 'Working\u2026 ' + (data.scanned || 0) + ' key' + ((data.scanned || 0) === 1 ? '' : 's') +
              ' scanned, ' + (r.creators || 0) + ' creator' + ((r.creators || 0) === 1 ? '' : 's') + ' and ' +
              (r.lists || 0) + ' list' + ((r.lists || 0) === 1 ? '' : 's') + ' migrated so far.';
            continue;
          }
          const errCount = (r.errors || []).length;
          status.textContent = 'Done \u2014 ' + (r.creators || 0) + ' creator' + ((r.creators || 0) === 1 ? '' : 's') + ', ' +
            (r.lists || 0) + ' list' + ((r.lists || 0) === 1 ? '' : 's') + ', ' +
            (r.sourcegroups || 0) + ' source group' + ((r.sourcegroups || 0) === 1 ? '' : 's') + ', ' +
            (r.feedback || 0) + ' feedback, ' +
            (r.tracking || 0) + ' tracking migrated' +
            (errCount ? (', ' + errCount + ' error' + (errCount === 1 ? '' : 's') + ' (see console)') : '') + '.';
          if (errCount) console.error('migrate-d1 errors:', r.errors);
          break;
        }
      } catch (e) {
        status.textContent = 'Failed: network error.';
      }
      btn.disabled = false;
    }

    async function runMigrateAccounts() {
      const btn = document.getElementById('migrateAccountsBtn');
      const status = document.getElementById('migrateAccountsStatus');
      btn.disabled = true;
      status.textContent = 'Working…';
      try {
        const res = await fetch('/admin/api/migrate-accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        const data = await res.json();
        if (!data.ok) {
          status.textContent = 'Failed: ' + (data.error || 'unknown error');
        } else {
          status.textContent = 'Done — ' + (data.accountsCount || 0) + ' accounts in table (' +
            (data.d1Count || 0) + ' D1, ' + (data.kvCount || 0) + ' KV, union ' + (data.unionCount || 0) + '). ' +
            (data.reconciled ? 'Reconciled ✓' : 'Mismatch!');
        }
      } catch (e) {
        status.textContent = 'Failed: network error.';
      }
      btn.disabled = false;
    }

    async function runInstallsStatus() {
      const btn = document.getElementById('installsStatusBtn');
      const status = document.getElementById('installsStatus');
      btn.disabled = true;
      status.textContent = 'Checking...';
      try {
        const res = await fetch('/admin/api/installs/status');
        const data = await res.json();
        if (!data.ok) {
          status.textContent = 'Unavailable: ' + (data.error || 'unknown error');
        } else {
          status.textContent = 'Moving ' + data.migrationPercent + '% of links' +
            (data.encryptionKeyConfigured ? '' : ' (TOKEN_ENCRYPTION_KEY is missing, so nothing with a key can move)') +
            '. Moved so far: ' + data.legacy + '. New-style links: ' + data.v2 +
            '. Linked to an account: ' + data.owned + '. Removed: ' + data.revoked + '.';
        }
      } catch (e) {
        status.textContent = 'Failed: network error.';
      }
      btn.disabled = false;
    }

    async function runInstallsRestore() {
      if (!confirm('Put the keys back into every moved install link and empty the installs table? Only do this if the move has gone wrong.')) return;
      const btn = document.getElementById('installsRestoreBtn');
      const status = document.getElementById('installsRestoreStatus');
      btn.disabled = true;
      let afterId = 0;
      let restored = 0;
      let failed = 0;
      let safetyCounter = 0;
      try {
        while (safetyCounter < 1000) {
          safetyCounter++;
          status.textContent = 'Working... ' + restored + ' restored';
          const res = await fetch('/admin/api/installs/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ limit: 50, afterId: afterId }),
          });
          const data = await res.json();
          if (data.error) {
            status.textContent = 'Stopped: ' + data.error;
            break;
          }
          restored += data.restored || 0;
          failed += (data.failed || []).length;
          if (data.done) {
            status.textContent = 'Done: ' + restored + ' restored' + (failed ? ', ' + failed + ' could not be (see the Worker logs)' : '') + '.';
            break;
          }
          afterId = data.nextAfterId;
        }
      } catch (e) {
        status.textContent = 'Failed: network error (' + restored + ' restored so far).';
      }
      btn.disabled = false;
    }

    // Lists v2 backfill (P3b-3). One bounded step per request; this keeps
    // asking until the server says it is done, so closing the page just
    // pauses it and Copy lists carries on from where it stopped.
    async function runListsBackfill(restart) {
      if (restart && !confirm('Run the copy again from the first account? Copies already made are kept; only lists that changed are copied again.')) return;
      const btns = [document.getElementById('listsBackfillBtn'), document.getElementById('listsBackfillRestartBtn')];
      const status = document.getElementById('listsBackfillStatus');
      btns.forEach(function (b) { b.disabled = true; });
      let pendingRestart = !!restart;
      let steps = 0;
      try {
        while (steps < 20000) {
          steps++;
          const res = await fetch('/admin/api/lists-backfill/step', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ restart: pendingRestart }),
          });
          const data = await res.json();
          if (data.busy) {
            status.textContent = 'Another step is running. Waiting...';
            await new Promise(function (r) { setTimeout(r, 5000); });
            continue;
          }
          pendingRestart = false;
          if (!data.ok) {
            status.textContent = 'Stopped: ' + (data.error || 'unknown error');
            break;
          }
          const failedNote = data.accountsFailed ? ' (' + data.accountsFailed + ' failed)' : '';
          if (data.done) {
            status.textContent = 'Done: ' + data.accountsDone + ' accounts' + failedNote + '. Press Check results.';
            break;
          }
          status.textContent = 'Copying (' + data.phase + '): ' + data.accountsDone + ' of ' + data.accountsTotal + ' accounts' + failedNote + '...';
        }
      } catch (e) {
        status.textContent = 'Stopped: network error. Press Copy lists to carry on.';
      }
      btns.forEach(function (b) { b.disabled = false; });
    }

    async function runListsBackfillStatus() {
      const status = document.getElementById('listsBackfillStatus');
      const out = document.getElementById('listsBackfillResult');
      status.textContent = 'Checking...';
      try {
        const res = await fetch('/admin/api/lists-backfill/status');
        const d = await res.json();
        if (!d.ok) {
          status.textContent = 'Unavailable: ' + (d.error || 'unknown error');
          return;
        }
        status.textContent = 'Phase: ' + d.run.phase + (d.run.lastError ? ' (last error: ' + d.run.lastError + ')' : '') + '.';
        const t = d.totals;
        const lines = [
          'Accounts: ' + (d.accounts.done || 0) + ' done, ' + (d.accounts.running || 0) + ' in progress, ' + (d.accounts.queued || 0) + ' waiting to be copied again, ' + (d.accounts.failed || 0) + ' failed.',
          'Lists: ' + t.lists.legacy + ' found, ' + t.lists.copied + ' copied, ' + t.lists.unchanged + ' unchanged since the last run, ' + t.lists.removed + ' copies of deleted lists retired, ' + t.lists.missing + ' order entries with no list behind them.',
          'Items: ' + t.items.legacy + ' in the old lists, ' + t.items.copied + ' copied, ' + (d.mismatchRate * 100).toFixed(3) + '% not carried: ' + t.items.unusable + ' with no usable id (no catalog could show them), ' + t.items.duplicates + ' listed twice' + (t.items.carried ? ', ' + t.items.carried + ' on lists copied in an earlier run' : '') + '. ' + t.items.stubs + ' titles TMDB could not place yet (kept, tried again later).',
          'Likes: ' + t.likes.legacy + ' shown before, ' + t.likes.voters + ' voters copied, ' + t.likes.keptFromCount + ' kept from the old totals with no voter on record.',
        ];
        if (d.listsOnly) lines.unshift('FF_V2_LISTS_ONLY is on: the new tables are the only store, so there is nothing left to copy.');
        else if (d.run.phase === 'done' && !(d.accounts.running || d.accounts.queued || d.accounts.failed)) lines.push('Every account is copied. FF_V2_LISTS_ONLY can be considered once reads have been on the new tables for a while (docs/OPERATIONS.md section 11).');
        if (d.anonymous) lines.push('Anonymous lists: ' + d.anonymous.lists.legacy + ' found, ' + d.anonymous.items.copied + ' of ' + d.anonymous.items.legacy + ' items copied.');
        if (d.external) lines.push('Likes on outside lists: ' + d.external.targets + ' lists, ' + d.external.voters + ' voters copied.');
        if (d.channels) {
          const c = d.channels;
          lines.push('Shared channels: ' + c.channels.legacy + ' found (' + c.channels.listed + ' listed in Explore Channels), ' + c.channels.copied + ' copied, ' + c.channels.unchanged + ' unchanged since the last run, ' + c.channels.unreadable + ' unreadable' + (c.samples.unreadable.length ? ' (' + c.samples.unreadable.join(', ') + ')' : '') + '. Episode lists: ' + c.pools.written + ' written to R2' + (c.pools.skipped ? ', ' + c.pools.skipped + ' left in KV because the BLOBS bucket is not bound' : '') + '. Likes: ' + c.likes.voters + ' voters copied, ' + c.likes.keptFromCount + ' kept from the old totals. Adds: ' + c.adds.adders + ' accounts copied, ' + c.adds.keptFromCount + ' kept from the old totals.');
        }
        if (d.failed.length) lines.push('Failed accounts: ' + d.failed.map(function (f) { return '#' + f.accountId + ' (' + f.error + ')'; }).join('; '));
        if (d.worst.length) lines.push('Most items not carried: ' + d.worst.map(function (w) { return '#' + w.accountId + ' ' + (w.mismatchRate * 100).toFixed(2) + '%'; }).join(', ') + '. Examples from the first: ' + JSON.stringify(d.worst[0].samples));
        out.innerHTML = '';
        lines.forEach(function (line) {
          const div = document.createElement('div');
          div.style.margin = '0 0 4px';
          div.textContent = line;
          out.appendChild(div);
        });
      } catch (e) {
        status.textContent = 'Failed: network error.';
      }
    }

    // Activity backfill (P3c-3): the same loop as the list copy above.
    async function runActivityBackfill(restart) {
      if (restart && !confirm('Copy every account again from the start? What an earlier copy made is replaced; the history people use today is not touched.')) return;
      const btns = [document.getElementById('activityBackfillBtn'), document.getElementById('activityBackfillRestartBtn')];
      const status = document.getElementById('activityBackfillStatus');
      btns.forEach(function (b) { b.disabled = true; });
      let pendingRestart = !!restart;
      let steps = 0;
      try {
        while (steps < 20000) {
          steps++;
          const res = await fetch('/admin/api/activity-backfill/step', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ restart: pendingRestart }),
          });
          const data = await res.json();
          if (data.busy) {
            status.textContent = 'Another step is running. Waiting...';
            await new Promise(function (r) { setTimeout(r, 5000); });
            continue;
          }
          pendingRestart = false;
          if (!data.ok) {
            status.textContent = 'Stopped: ' + (data.error || 'unknown error');
            break;
          }
          const failedNote = data.accountsFailed ? ' (' + data.accountsFailed + ' failed)' : '';
          if (data.done) {
            status.textContent = 'Done: ' + data.accountsDone + ' accounts' + failedNote + '. Press Check results.';
            break;
          }
          status.textContent = 'Copying: ' + data.accountsDone + ' of ' + data.accountsTotal + ' accounts' + failedNote + '...';
        }
      } catch (e) {
        status.textContent = 'Stopped: network error. Press Copy history to carry on.';
      }
      btns.forEach(function (b) { b.disabled = false; });
    }

    async function runActivityBackfillStatus() {
      const status = document.getElementById('activityBackfillStatus');
      const out = document.getElementById('activityBackfillResult');
      status.textContent = 'Checking...';
      try {
        const res = await fetch('/admin/api/activity-backfill/status');
        const d = await res.json();
        if (!d.ok) {
          status.textContent = 'Unavailable: ' + (d.error || 'unknown error');
          return;
        }
        status.textContent = 'Phase: ' + d.run.phase + (d.run.lastError ? ' (last error: ' + d.run.lastError + ')' : '') + '.';
        const h = d.totals.history;
        const sh = d.totals.shows;
        const lines = [
          'Accounts: ' + (d.accounts.done || 0) + ' done, ' + (d.accounts.running || 0) + ' in progress, ' + (d.accounts.queued || 0) + ' waiting, ' + (d.accounts.failed || 0) + ' failed.',
          'History: ' + h.kv + ' entries in KV, ' + h.d1 + ' in D1, ' + h.queue + ' in the scrobble queue, ' + h.union + ' different entries in all. ' + h.copied + ' plays copied; ' + h.duplicates + ' were the same play twice (within ten minutes), ' + h.unusable + ' had no usable id' + (h.undated ? ', ' + h.undated + ' had no date (given the record date)' : '') + '. ' + h.stubs + ' titles TMDB could not place yet (kept, tried again later).',
          'Shows: ' + sh.progress + ' with progress, ' + sh.completed + ' finished, ' + sh.dismissed + ' hidden from Continue Watching, ' + sh.airingHidden + ' hidden from Airing Next, ' + sh.kept + ' storyline or movie suggestions kept, ' + sh.cwOnly + ' in Continue Watching with no history' + (sh.unusable ? ', ' + sh.unusable + ' with no usable id' : '') + '. Movies watched: ' + d.totals.movies + '.',
          'Plays now in the activity database: ' + d.totals.events + ' (the larger of the KV and D1 histories added up: ' + d.totals.legacyMax + '). Accounts with fewer plays than their old history: ' + d.totals.shortAccounts + '.',
        ];
        if (d.run.phase === 'done' && !(d.accounts.running || d.accounts.queued || d.accounts.failed) && !d.totals.shortAccounts) lines.push('Every account is copied, none with fewer plays than before.');
        if (d.failed.length) lines.push('Failed accounts: ' + d.failed.map(function (f) { return '#' + f.accountId + ' (' + f.error + ')'; }).join('; '));
        if (d.short.length) lines.push('Fewest plays against their old history: ' + d.short.map(function (s) { return '#' + s.accountId + ' ' + s.short + ' of ' + s.legacy; }).join(', ') + '. Examples from the first: ' + JSON.stringify(d.short[0].samples));
        out.innerHTML = '';
        lines.forEach(function (line) {
          const div = document.createElement('div');
          div.style.margin = '0 0 4px';
          div.textContent = line;
          out.appendChild(div);
        });
      } catch (e) {
        status.textContent = 'Failed: network error.';
      }
    }

    // Background jobs queue (P5-1): send one test job, then ask every two
    // seconds whether the consumer has picked it up, for up to a minute.
    async function runJobsPing() {
      const btn = document.getElementById('jobsPingBtn');
      const status = document.getElementById('jobsPingStatus');
      btn.disabled = true;
      status.textContent = 'Sending...';
      try {
        const res = await fetch('/admin/api/jobs/ping', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const sent = await res.json();
        if (!sent.ok) {
          status.textContent = 'Failed: ' + (sent.error || 'unknown error');
          btn.disabled = false;
          return;
        }
        const startedAt = Date.now();
        let answered = false;
        while (Date.now() - startedAt < 60000) {
          status.textContent = 'Sent. Waiting for the Worker to pick it up (' + Math.round((Date.now() - startedAt) / 1000) + ' s)...';
          await new Promise(function (r) { setTimeout(r, 2000); });
          const check = await fetch('/admin/api/jobs/ping?nonce=' + encodeURIComponent(sent.nonce));
          const d = await check.json();
          if (d.ok && d.received) {
            answered = true;
            status.textContent = 'Round trip works: picked up after ' + (d.roundTripMs != null ? (d.roundTripMs / 1000).toFixed(1) + ' s' : 'a moment') + (d.attempts > 1 ? ' (on delivery ' + d.attempts + ')' : '') + '.';
            break;
          }
        }
        if (!answered) status.textContent = 'Sent, but not picked up within a minute. Check that this Worker is the consumer of mylists-jobs (Queues, mylists-jobs, Settings, Consumers), then try again.';
      } catch (e) {
        status.textContent = 'Failed: network error.';
      }
      btn.disabled = false;
    }

    function jobsAgo(ms) {
      const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
      if (s < 90) return s + ' s ago';
      if (s < 5400) return Math.round(s / 60) + ' min ago';
      return Math.round(s / 3600) + ' h ago';
    }

    // The jobs table's view (P5-2): each periodic job's last run, and one-off
    // jobs by state.
    async function runJobsStatus() {
      const status = document.getElementById('jobsStatusStatus');
      const out = document.getElementById('jobsStatusResult');
      status.textContent = 'Checking...';
      try {
        const res = await fetch('/admin/api/jobs/status');
        const d = await res.json();
        if (!d.ok) {
          status.textContent = 'Unavailable: ' + (d.error || 'unknown error');
          return;
        }
        status.textContent = d.bound ? 'The queue does the work.' : 'No queue: each cron tick does the work itself.';
        const lines = [];
        if (!d.jobs) {
          lines.push('No jobs table yet (apply migration 0016).');
        } else {
          if (!d.jobs.periodic.length) lines.push(d.bound ? 'No cron tick has run since the queue was bound.' : 'Jobs are recorded here once the queue is bound.');
          d.jobs.periodic.forEach(function (j) {
            let line = j.type + ': ';
            if (j.status === 'running') line += 'running now';
            else if (j.status === 'sent') line += 'sent to the queue ' + jobsAgo(j.sentAt) + ', waiting to be picked up';
            else if (!j.runs) line += 'not run yet';
            else line += 'last ran ' + jobsAgo(j.lastStartedAt) + (j.lastMs != null ? ' (took ' + (j.lastMs / 1000).toFixed(1) + ' s)' : '');
            if (j.runs) line += ', ' + j.runs + ' runs';
            if (j.failuresInARow) line += '. FAILING, ' + j.failuresInARow + ' in a row: ' + (j.lastError || 'unknown error');
            else if (j.lastOkAt) line += ', last success ' + jobsAgo(j.lastOkAt);
            lines.push(line + '.');
            if (j.type === 'shelf.shadow' && j.last) {
              const t = j.last;
              lines.push('  Last full comparison (' + t.accounts + ' accounts, finished ' + jobsAgo(t.finishedAt) + '): ' + (t.rate * 100).toFixed(2) + '% different' + (t.rateNew != null ? ' (' + (t.rateNew * 100).toFixed(2) + '% leaving out mistakes in the old list)' : '') + '. Continue Watching: ' + t.cw.both + ' the same, ' + t.cw.legacyOnly + ' only in the old, ' + t.cw.v2Only + ' only in the new, ' + t.cw.unknown + ' shows not known yet. Airing Next: ' + t.an.both + ' the same, ' + t.an.legacyOnly + ' only in the old, ' + t.an.v2Only + ' only in the new, ' + t.an.unknown + ' not known yet.' + (t.examples && t.examples.length ? ' Examples: ' + JSON.stringify(t.examples.slice(0, 3)) : ''));
              if (t.verdict) {
                lines.push('  If FF_SHOW_SCHEDULE were on: ' + t.verdict.lost + ' lost, ' + t.verdict.changed + ' at another episode, ' + t.verdict.added + ' added, ' + t.verdict.oldWrong + ' old-list mistakes put right.');
              }
              // Why each difference is there (47_shelf-shadow.js), most common first.
              if (t.cw.whyOld) {
                const whyText = function (w) {
                  const keys = Object.keys(w || {}).sort(function (a, b) { return w[b] - w[a]; });
                  return keys.length ? keys.map(function (k) { return k + ' ' + w[k]; }).join(', ') : 'none';
                };
                lines.push('  Why: Continue Watching only in the old: ' + whyText(t.cw.whyOld) + '; only in the new: ' + whyText(t.cw.whyNew) + '. Airing Next only in the old: ' + whyText(t.an.whyOld) + '; only in the new: ' + whyText(t.an.whyNew) + '.');
              }
            }
          });
          Object.keys(d.jobs.durable || {}).forEach(function (type) {
            const c = d.jobs.durable[type];
            lines.push(type + ': ' + Object.keys(c).map(function (k) { return c[k] + ' ' + k; }).join(', ') + '.');
          });
        }
        out.innerHTML = '';
        lines.forEach(function (line) {
          const div = document.createElement('div');
          div.style.margin = '0 0 4px';
          div.textContent = line;
          out.appendChild(div);
        });
      } catch (e) {
        status.textContent = 'Failed: network error.';
      }
    }

    // Browsing one creator's stored list records.
    //
    // The delete below takes exact slugs, and until now nothing here could
    // tell you what they were: the creator's own dashboard is the only place
    // that lists them, an admin cannot open it, and the slugs of a duplicate
    // run (coming-of-age-3 ... coming-of-age-53) are not guessable. Typing the
    // base name deletes exactly one of fifty-three.
    //
    // Kept in memory rather than re-fetched on every keystroke: the filter
    // below is a view of what has already been loaded, and paging with "Load
    // more" appends to it.
    let creatorListsLoaded = [];
    let creatorListsCursor = null;
    let creatorListsUser = '';

    function creatorListsFilterText() {
      return (document.getElementById('creatorListsFilterInput').value || '').trim().toLowerCase();
    }

    // Matched against name AND slug, and with spaces treated as the hyphens a
    // slug actually uses -- someone hunting "coming of age" is typing the
    // list's name, not "coming-of-age".
    function creatorListMatchesFilter(L, q) {
      if (!q) return true;
      const name = String(L.name || '').toLowerCase();
      const slug = String(L.slug || '').toLowerCase();
      const dashed = q.replace(/\\s+/g, '-');
      return name.indexOf(q) !== -1 || slug.indexOf(q) !== -1 || slug.indexOf(dashed) !== -1;
    }

    function shownCreatorLists() {
      const q = creatorListsFilterText();
      return creatorListsLoaded.filter(function (L) { return creatorListMatchesFilter(L, q); });
    }

    function renderCreatorListsTable() {
      const results = document.getElementById('creatorListsResults');
      const status = document.getElementById('creatorListsStatus');
      if (!creatorListsLoaded.length) {
        results.innerHTML = '';
        return;
      }
      const shown = shownCreatorLists();
      if (!shown.length) {
        results.innerHTML = '<p class="u-c-v_muted u-m-0 u-fs-v_font_size_sm">No list matches that filter.</p>';
      } else {
        const rows = shown.map(function (L) {
          const vis = L.visibility ? escapeHtmlAdmin(L.visibility) : 'unreadable';
          // A record the creator's own dashboard cannot see, because its
          // order entry was lost. These are the ones that get re-uploaded and
          // re-duplicated, so they are worth calling out rather than hiding.
          const orphan = L.inOrder ? '' :
            '<span title="not in this creator\\'s display order" class="u-c-v_color_warn_text"> orphan</span>';
          return '<tr>' +
            '<td class="u-p-4px_8px_4px_0"><button type="button" class="admin-select u-cur-pointer u-p-2px_8px u-fs-v_font_size_xs" data-creator-slug="' +
              escapeHtmlAdmin(L.slug) + '">Select</button></td>' +
            '<td class="u-p-4px_8px_4px_0"><code>' + escapeHtmlAdmin(L.slug) + '</code>' + orphan + '</td>' +
            '<td class="u-p-4px_8px_4px_0">' + escapeHtmlAdmin(L.name) + '</td>' +
            '<td class="u-p-4px_8px_4px_0 u-ta-right">' + (Number(L.itemCount) || 0) + '</td>' +
            '<td class="u-p-4px_8px_4px_0">' + vis + '</td>' +
            '<td class="u-p-4px_0"><a href="' + escapeHtmlAdmin(L.url) + '" target="_blank" rel="noopener">open</a></td>' +
            '</tr>';
        }).join('');
        results.innerHTML = '<table class="u-bordercollapse-collapse u-fs-v_font_size_sm" style="width:100%;">' +
          '<thead><tr class="u-c-v_muted u-ta-left">' +
          '<th></th><th class="u-pr-8px">Slug</th><th class="u-pr-8px">Name</th>' +
          '<th class="u-pr-8px u-ta-right">Items</th>' +
          '<th class="u-pr-8px">Visibility</th><th></th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table>';
      }
      const q = creatorListsFilterText();
      status.textContent = creatorListsLoaded.length + ' list' + (creatorListsLoaded.length === 1 ? '' : 's') +
        ' loaded for "' + creatorListsUser + '"' +
        (q ? (', ' + shown.length + ' matching') : '') +
        (creatorListsCursor ? ', more available.' : '.');
    }

    async function loadCreatorLists(reset) {
      const btn = document.getElementById('browseCreatorListsBtn');
      const moreBtn = document.getElementById('browseCreatorListsMoreBtn');
      const status = document.getElementById('creatorListsStatus');
      const username = (document.getElementById('deleteListUserInput').value || '').trim();
      if (!username) {
        status.textContent = 'Enter a creator username first.';
        return;
      }
      // Switching creator without resetting would mix two accounts' slugs
      // into one selection, and this is a delete tool.
      if (reset || username !== creatorListsUser) {
        creatorListsLoaded = [];
        creatorListsCursor = null;
        creatorListsUser = username;
        document.getElementById('creatorListsResults').innerHTML = '';
        moreBtn.hidden = true;
      }
      btn.disabled = true;
      moreBtn.disabled = true;
      status.textContent = 'Loading…';
      try {
        const qs = '?username=' + encodeURIComponent(username) + '&limit=200' +
          (creatorListsCursor ? '&cursor=' + encodeURIComponent(creatorListsCursor) : '');
        const res = await fetch('/admin/api/creator-lists' + qs);
        const data = await res.json();
        if (!data.ok) {
          status.textContent = 'Failed: ' + (data.error || 'unknown error');
          return;
        }
        if (data.username && data.username !== username) {
          document.getElementById('deleteListUserInput').value = data.username;
          creatorListsUser = data.username;
        }
        creatorListsLoaded = creatorListsLoaded.concat(data.lists || []);
        creatorListsCursor = data.cursor || null;
        moreBtn.hidden = !creatorListsCursor;
        renderCreatorListsTable();
        if (!creatorListsLoaded.length) {
          document.getElementById('creatorListsResults').innerHTML =
            '<p class="u-c-v_muted u-m-0 u-fs-v_font_size_sm">This creator has no stored lists.</p>';
        }
      } catch (e) {
        status.textContent = 'Failed: network error.';
      } finally {
        btn.disabled = false;
        moreBtn.disabled = false;
      }
    }

    // Fills the slug box rather than deleting, exactly as the anonymous browse
    // does: a one-click delete next to a browse list is how the wrong list
    // gets removed. The delete button still asks, and still names what it is
    // about to remove.
    function setSelectedCreatorSlugs(slugs) {
      const input = document.getElementById('deleteListSlugsInput');
      input.value = slugs.join(', ');
      document.getElementById('deleteListStatus').textContent =
        slugs.length + ' slug' + (slugs.length === 1 ? '' : 's') + ' selected.';
    }

    function currentSelectedCreatorSlugs() {
      const input = document.getElementById('deleteListSlugsInput');
      return (input.value || '').split(/[\\s,]+/).map(function (x) { return x.trim(); }).filter(Boolean);
    }

    function selectShownCreatorLists() {
      const shown = shownCreatorLists();
      if (!shown.length) {
        document.getElementById('deleteListStatus').textContent = 'Nothing shown to select.';
        return;
      }
      const current = currentSelectedCreatorSlugs();
      shown.forEach(function (L) {
        if (current.indexOf(L.slug) === -1) current.push(L.slug);
      });
      setSelectedCreatorSlugs(current);
    }

    function clearSelectedCreatorLists() {
      setSelectedCreatorSlugs([]);
      document.getElementById('deleteListStatus').textContent = 'Selection cleared.';
    }

    document.getElementById('creatorListsResults').addEventListener('click', function (ev) {
      const btn = ev.target.closest('[data-creator-slug]');
      if (!btn) return;
      const slug = btn.getAttribute('data-creator-slug');
      const current = currentSelectedCreatorSlugs();
      if (current.indexOf(slug) === -1) current.push(slug);
      setSelectedCreatorSlugs(current);
    });

    // Irreversible, so it asks first and names exactly what it is about to
    // remove. The endpoint caps each call (ADMIN_LIST_DELETE_MAX), so a bigger
    // cleanup is sent as several batches here rather than rejected.
    async function runDeleteCreatorLists() {
      const btn = document.getElementById('deleteListBtn');
      const status = document.getElementById('deleteListStatus');
      const username = (document.getElementById('deleteListUserInput').value || '').trim();
      const rawSlugs = (document.getElementById('deleteListSlugsInput').value || '').trim();
      if (!username || !rawSlugs) {
        status.textContent = 'Enter a username and at least one slug.';
        return;
      }
      const slugs = rawSlugs.split(/[\\s,]+/).map(function (x) { return x.trim(); }).filter(Boolean);
      if (!slugs.length) {
        status.textContent = 'Enter at least one slug.';
        return;
      }
      const ok = confirm('Permanently delete ' + slugs.length + ' list' + (slugs.length === 1 ? '' : 's') +
        ' belonging to "' + username + '"?\\n\\n' + slugs.slice(0, 12).join(', ') +
        (slugs.length > 12 ? ', and ' + (slugs.length - 12) + ' more' : '') +
        '\\n\\nThis cannot be undone.');
      if (!ok) return;

      btn.disabled = true;
      const BATCH = 50;
      let deleted = 0;
      let missing = 0;
      let remaining = null;
      try {
        for (let i = 0; i < slugs.length; i += BATCH) {
          const batch = slugs.slice(i, i + BATCH);
          status.textContent = 'Deleting\u2026 ' + (deleted + missing) + ' of ' + slugs.length + ' processed.';
          const res = await fetch('/admin/api/delete-creator-list', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: username, slugs: batch }),
          });
          const data = await res.json();
          if (!data.ok) {
            // The endpoint reports what it managed to remove even when the
            // sweep as a whole failed -- most often the records are gone and
            // only the directory cleanup did not finish. Saying just "Failed"
            // hid that difference, so a delete that had actually worked read
            // as one that had not, and got retried forever.
            deleted += (data.deleted || []).length;
            missing += (data.missing || []).length;
            const detail = (data.remaining === null || data.remaining === undefined)
              ? ''
              : (' ' + data.remaining + ' list' + (data.remaining === 1 ? '' : 's') + ' left for this creator.');
            status.textContent = 'Failed: ' + (data.error || 'unknown error') +
              ' (removed ' + deleted + ' before stopping.' + detail + ')';
            btn.disabled = false;
            return;
          }
          deleted += (data.deleted || []).length;
          missing += (data.missing || []).length;
          remaining = data.remaining;
        }
        status.textContent = 'Done \u2014 deleted ' + deleted + ', cleared ' + missing +
          ' stale directory entr' + (missing === 1 ? 'y' : 'ies') +
          (remaining === null ? '.' : ('. ' + remaining + ' list' + (remaining === 1 ? '' : 's') + ' left for this creator.'));
        document.getElementById('deleteListSlugsInput').value = '';
        await loadCreatorLists(true);
      } catch (e) {
        status.textContent = 'Failed: network error.';
      }
      btn.disabled = false;
    }

    // Anonymous published lists (publishedlist:user:*). These have no owner,
    // so runDeleteCreatorLists above cannot reach them -- it requires a
    // creator username, and "user" is a reserved one. The keyspace is
    // unbounded by construction, so this pages rather than scanning: the
    // cursor is kept here between calls and "Load more" continues it.
    let anonListCursor = null;
    let anonListCount = 0;

    async function loadPublishedLists(reset) {
      const btn = document.getElementById('browseAnonBtn');
      const moreBtn = document.getElementById('browseAnonMoreBtn');
      const status = document.getElementById('anonListStatus');
      const results = document.getElementById('anonListResults');
      if (reset) {
        anonListCursor = null;
        anonListCount = 0;
        results.innerHTML = '';
        moreBtn.hidden = true;
      }
      btn.disabled = true;
      moreBtn.disabled = true;
      status.textContent = 'Loading\u2026';
      try {
        const qs = '?limit=50' + (anonListCursor ? '&cursor=' + encodeURIComponent(anonListCursor) : '');
        const res = await fetch('/admin/api/published-lists' + qs);
        const data = await res.json();
        if (!data.ok) {
          status.textContent = 'Failed: ' + (data.error || 'unknown error');
          btn.disabled = false;
          moreBtn.disabled = false;
          return;
        }
        const lists = data.lists || [];
        anonListCount += lists.length;
        if (!anonListCount) {
          results.innerHTML = '<p class="u-c-v_muted u-m-0 u-fs-v_font_size_sm">No anonymously published lists.</p>';
        } else {
          const rows = lists.map(function (L) {
            const vis = L.visibility ? escapeHtmlAdmin(L.visibility) : 'unreadable';
            return '<tr>' +
              '<td class="u-p-4px_8px_4px_0"><button type="button" class="admin-select u-cur-pointer u-p-2px_8px u-fs-v_font_size_xs" data-anon-slug="' +
                escapeHtmlAdmin(L.slug) + '">Select</button></td>' +
              '<td class="u-p-4px_8px_4px_0"><code>' + escapeHtmlAdmin(L.slug) + '</code></td>' +
              '<td class="u-p-4px_8px_4px_0">' + escapeHtmlAdmin(L.name) + '</td>' +
              '<td class="u-p-4px_8px_4px_0 u-ta-right">' + (Number(L.itemCount) || 0) + '</td>' +
              '<td class="u-p-4px_8px_4px_0 u-ta-right">' + (Number(L.likes) || 0) + '</td>' +
              '<td class="u-p-4px_8px_4px_0">' + vis + '</td>' +
              '<td class="u-p-4px_0"><a href="' + escapeHtmlAdmin(L.url) + '" target="_blank" rel="noopener">open</a></td>' +
              '</tr>';
          }).join('');
          if (reset || !results.querySelector('tbody')) {
            results.innerHTML = '<table class="u-bordercollapse-collapse u-fs-v_font_size_sm" style="width:100%;">' +
              '<thead><tr class="u-c-v_muted u-ta-left">' +
              '<th></th><th class="u-pr-8px">Slug</th><th class="u-pr-8px">Name</th>' +
              '<th class="u-pr-8px u-ta-right">Items</th>' +
              '<th class="u-pr-8px u-ta-right">Likes</th>' +
              '<th class="u-pr-8px">Visibility</th><th></th>' +
              '</tr></thead><tbody>' + rows + '</tbody></table>';
          } else {
            results.querySelector('tbody').insertAdjacentHTML('beforeend', rows);
          }
        }
        anonListCursor = data.cursor || null;
        moreBtn.hidden = !anonListCursor;
        status.textContent = anonListCount + ' list' + (anonListCount === 1 ? '' : 's') + ' shown' +
          (anonListCursor ? ', more available.' : '. That is all of them.');
      } catch (e) {
        status.textContent = 'Failed: network error.';
      }
      btn.disabled = false;
      moreBtn.disabled = false;
    }

    // --- published channels ---------------------------------------------
    //
    // Two scopes. "listed" is the directory itself -- one cheap read of the
    // index, and what the public actually sees. "all" walks the
    // channelshare: keyspace, which also holds channels that were published,
    // reported and then quietly unlisted, and any row a lost index write
    // orphaned. An operator needs both.
    async function loadPublishedChannels(scope) {
      const status = document.getElementById('publishedChannelStatus');
      const results = document.getElementById('publishedChannelResults');
      const btn = document.getElementById(scope === 'all' ? 'browseChannelsAllBtn' : 'browseChannelsBtn');
      if (btn) btn.disabled = true;
      status.textContent = 'Loading\u2026';
      try {
        const res = await fetch('/admin/api/published-channels?scope=' + encodeURIComponent(scope) + '&limit=100');
        const data = await res.json();
        if (!data.ok) {
          status.textContent = 'Failed: ' + (data.error || 'unknown error');
          if (btn) btn.disabled = false;
          return;
        }
        const channels = data.channels || [];
        if (!channels.length) {
          results.innerHTML = '<p class="u-c-v_muted u-m-0 u-fs-v_font_size_sm">Nothing to show.</p>';
          status.textContent = '';
          if (btn) btn.disabled = false;
          return;
        }
        const rows = channels.map(function (C) {
          const code = escapeHtmlAdmin(C.code);
          return '<tr data-channel-row="' + code + '">' +
            '<td class="u-p-4px_8px_4px_0"><code>' + code + '</code></td>' +
            '<td class="u-p-4px_8px_4px_0">' + escapeHtmlAdmin(C.name || '') + '</td>' +
            '<td class="u-p-4px_8px_4px_0">' + escapeHtmlAdmin(C.owner || '\u2014') + '</td>' +
            '<td class="u-p-4px_8px_4px_0 u-ta-right">' + (Number(C.itemCount) || 0) + '</td>' +
            '<td class="u-p-4px_8px_4px_0 u-ta-right">' + (Number(C.likes) || 0) + '</td>' +
            '<td class="u-p-4px_8px_4px_0">' + (C.listed ? 'listed' : 'unlisted') + '</td>' +
            '<td class="u-p-4px_8px_4px_0"><a href="' + escapeHtmlAdmin(C.url || '') + '" target="_blank" rel="noopener">open</a></td>' +
            '<td class="u-p-4px_0 u-ws-nowrap">' +
              '<button type="button" class="admin-select u-cur-pointer u-p-2px_8px u-fs-v_font_size_xs u-mr-4px" data-channel-action="unlist" data-code="' + code + '">Unlist</button>' +
              '<button type="button" class="admin-select u-cur-pointer u-p-2px_8px u-fs-v_font_size_xs u-c-v_color_danger_text u-bdc-rgba_255_59_48_0_35" data-channel-action="delete" data-code="' + code + '">Delete</button>' +
            '</td>' +
            '</tr>';
        }).join('');
        results.innerHTML = '<table class="u-bordercollapse-collapse u-fs-v_font_size_sm" style="width:100%;">' +
          '<thead><tr class="u-c-v_muted u-ta-left">' +
          '<th class="u-pr-8px">Code</th><th class="u-pr-8px">Name</th>' +
          '<th class="u-pr-8px">Owner</th>' +
          '<th class="u-pr-8px u-ta-right">Items</th>' +
          '<th class="u-pr-8px u-ta-right">Likes</th>' +
          '<th class="u-pr-8px">State</th><th></th><th></th>' +
          '</tr></thead><tbody>' + rows + '</tbody></table>';
        status.textContent = channels.length + ' channel' + (channels.length === 1 ? '' : 's') + ' shown' +
          (data.done ? '. That is all of them.' : ', more available.');
      } catch (e) {
        status.textContent = 'Failed: network error.';
      }
      if (btn) btn.disabled = false;
    }

    // Both actions confirm by name before they run. Delete says plainly that
    // it breaks every link, because that is the part an operator reaching
    // for "take this down" may not have meant.
    document.getElementById('publishedChannelResults').addEventListener('click', async function (ev) {
      const btn = ev.target.closest('[data-channel-action]');
      if (!btn) return;
      const action = btn.getAttribute('data-channel-action');
      const code = btn.getAttribute('data-code');
      const row = btn.closest('tr');
      const name = row ? (row.children[1].textContent || code) : code;
      const question = action === 'delete'
        ? 'Delete the stored channel "' + name + '"? Every share link to it stops working. This cannot be undone.'
        : 'Remove "' + name + '" from the Explore Channels directory? Links already handed out keep working.';
      if (!confirm(question)) return;
      const status = document.getElementById('publishedChannelStatus');
      btn.disabled = true;
      status.textContent = 'Working\u2026';
      try {
        const res = await fetch('/admin/api/channel-moderate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: code, action: action }),
        });
        const data = await res.json();
        if (!data.ok) {
          status.textContent = 'Failed: ' + (data.error || 'unknown error');
          btn.disabled = false;
          return;
        }
        status.textContent = (action === 'delete' ? 'Deleted ' : 'Unlisted ') + name + '.';
        if (row) row.remove();
      } catch (e) {
        status.textContent = 'Failed: network error.';
        btn.disabled = false;
      }
    });

    // "Select" fills the slug box rather than deleting directly: a one-click
    // delete next to a browse list is how the wrong list gets removed.
    document.getElementById('anonListResults').addEventListener('click', function (ev) {
      const btn = ev.target.closest('[data-anon-slug]');
      if (!btn) return;
      const input = document.getElementById('deleteAnonSlugsInput');
      const slug = btn.getAttribute('data-anon-slug');
      const current = (input.value || '').split(/[\\s,]+/).map(function (x) { return x.trim(); }).filter(Boolean);
      if (current.indexOf(slug) === -1) current.push(slug);
      input.value = current.join(', ');
      document.getElementById('deleteAnonStatus').textContent = current.length + ' slug' + (current.length === 1 ? '' : 's') + ' selected.';
    });

    // Same shape as runDeleteCreatorLists: irreversible, so it names what it
    // is about to remove, and batches to ADMIN_LIST_DELETE_MAX per call.
    async function runDeletePublishedLists() {
      const btn = document.getElementById('deleteAnonBtn');
      const status = document.getElementById('deleteAnonStatus');
      const raw = (document.getElementById('deleteAnonSlugsInput').value || '').trim();
      const slugs = raw.split(/[\\s,]+/).map(function (x) { return x.trim(); }).filter(Boolean);
      if (!slugs.length) {
        status.textContent = 'Enter at least one slug.';
        return;
      }
      const ok = confirm('Permanently delete ' + slugs.length + ' anonymously published list' +
        (slugs.length === 1 ? '' : 's') + '?\\n\\n' + slugs.slice(0, 12).join(', ') +
        (slugs.length > 12 ? ', and ' + (slugs.length - 12) + ' more' : '') +
        '\\n\\nThis cannot be undone.');
      if (!ok) return;

      btn.disabled = true;
      const BATCH = 50;
      let deleted = 0;
      let missing = 0;
      try {
        for (let i = 0; i < slugs.length; i += BATCH) {
          const batch = slugs.slice(i, i + BATCH);
          status.textContent = 'Deleting\u2026 ' + (deleted + missing) + ' of ' + slugs.length + ' processed.';
          const res = await fetch('/admin/api/delete-published-list', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slugs: batch }),
          });
          const data = await res.json();
          if (!data.ok) {
            status.textContent = 'Failed: ' + (data.error || 'unknown error');
            btn.disabled = false;
            return;
          }
          deleted += (data.deleted || []).length;
          missing += (data.missing || []).length;
        }
        status.textContent = 'Done \u2014 deleted ' + deleted + ', ' + missing +
          ' slug' + (missing === 1 ? '' : 's') + ' had no list to remove.';
        document.getElementById('deleteAnonSlugsInput').value = '';
        if (anonListCount) await loadPublishedLists(true);
      } catch (e) {
        status.textContent = 'Failed: network error.';
      }
      btn.disabled = false;
    }

    // Reports which files under migrations/ this database has not had run,
    // and what each omission silently costs. The consequence text is the
    // useful part: "creator_tombstones is missing" is not something an
    // operator can act on.
    // The whole shelf comparison, a batch per request (runShelfShadowNow).
    function shelfCompareWhy(w) {
      const keys = Object.keys(w || {}).sort(function (a, b) { return w[b] - w[a]; });
      return keys.length ? keys.map(function (k) { return k + ' ' + w[k]; }).join(', ') : 'none';
    }

    async function runShelfCompareNow() {
      const btn = document.getElementById('shelfCompareBtn');
      const status = document.getElementById('shelfCompareStatus');
      const out = document.getElementById('shelfCompareResult');
      btn.disabled = true;
      out.textContent = '';
      status.textContent = 'Starting...';
      let state = { afterId: 0, round: null };
      let total = null;
      let scanned = 0;
      try {
        for (let i = 0; i < 2000; i++) {
          const res = await fetch('/admin/api/jobs/shelf-shadow-now', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) });
          const data = await res.json();
          if (!data.ok) { status.textContent = 'Stopped: ' + (data.error || 'unknown error'); break; }
          if (data.total != null) total = data.total;
          scanned += Number(data.scanned) || 0;
          if (data.done) {
            const t = data.last;
            status.textContent = 'Done: ' + t.accounts + ' accounts compared.';
            out.textContent = [
              (t.rate * 100).toFixed(2) + '% different' + (t.rateNew != null ? '; ' + (t.rateNew * 100).toFixed(2) + '% leaving out mistakes in the old list.' : '.'),
              t.verdict ? 'If FF_SHOW_SCHEDULE were on now: ' + t.verdict.lost + ' entries lost' + (t.verdict.lost ? ' (' + shelfCompareWhy(t.verdict.lostWhy) + ')' : '') + ', ' + t.verdict.changed + ' shown at another episode, ' + t.verdict.added + ' added; ' + t.verdict.oldWrong + ' mistakes in the old list put right. Shows not known yet keep their current entry.' : '',
              'Continue Watching: ' + t.cw.both + ' the same, ' + t.cw.legacyOnly + ' only in the old, ' + t.cw.v2Only + ' only in the new, ' + t.cw.unknown + ' shows not known yet.',
              '  Why only in the old: ' + shelfCompareWhy(t.cw.whyOld),
              '  Why only in the new: ' + shelfCompareWhy(t.cw.whyNew),
              '  Why not known yet: ' + shelfCompareWhy(t.cw.unknownWhy),
              'Airing Next: ' + t.an.both + ' the same, ' + t.an.legacyOnly + ' only in the old, ' + t.an.v2Only + ' only in the new, ' + t.an.unknown + ' not known yet.',
              '  Why only in the old: ' + shelfCompareWhy(t.an.whyOld),
              '  Why only in the new: ' + shelfCompareWhy(t.an.whyNew),
              '  Why not known yet: ' + shelfCompareWhy(t.an.unknownWhy),
              'Not known yet, examples: ' + ((t.unknownExamples || []).length ? (t.unknownExamples || []).map(function (e) { return String.fromCharCode(10) + '  ' + (e.shelf === 'an' ? 'Airing Next' : 'Continue Watching') + ', media ' + e.mediaId + ': ' + e.why; }).join('') : 'none'),
              'Examples: ' + JSON.stringify(t.examples || []),
            ].join(String.fromCharCode(10));
            break;
          }
          status.textContent = 'Comparing... ' + scanned + (total ? ' of ' + total : '') + ' accounts so far.';
          state = { afterId: data.afterId, round: data.round };
        }
      } catch (e) {
        status.textContent = 'Stopped: network error. Press it again to start over.';
      }
      btn.disabled = false;
    }

    async function runKvExport() {
      const btn = document.getElementById('kvExportBtn');
      const status = document.getElementById('kvExportStatus');
      const prefix = String(document.getElementById('kvExportPrefix').value || '').trim();
      if (!prefix) { status.textContent = 'Type a prefix first.'; return; }
      btn.disabled = true;
      let state = { prefix: prefix };
      try {
        for (let i = 0; i < 5000; i++) {
          const res = await fetch('/admin/api/export-kv-to-r2', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) });
          const data = await res.json();
          if (!data.ok) { status.textContent = 'Stopped: ' + (data.error || 'unknown error') + ' (nothing is marked complete).'; break; }
          if (data.done) { status.textContent = 'Done: ' + data.keysSoFar + ' keys copied, manifest at ' + data.manifestKey + '.'; break; }
          status.textContent = 'Copying\u2026 ' + data.keysSoFar + ' keys so far.';
          state = { prefix: prefix, runId: data.runId, part: data.part + 1, keysSoFar: data.keysSoFar, cursor: data.cursor };
        }
      } catch (e) {
        status.textContent = 'Stopped: network error (nothing is marked complete).';
      }
      btn.disabled = false;
    }

    async function runStatsRecovery(apply) {
      const status = document.getElementById('statsRecoveryStatus');
      const out = document.getElementById('statsRecoveryResult');
      const buttons = [document.getElementById('statsRecoveryPreviewBtn'), document.getElementById('statsRecoveryApplyBtn')];
      buttons.forEach(function (b) { if (b) b.disabled = true; });
      status.textContent = apply ? 'Putting the counts back\u2026' : 'Reading Cloudflare Analytics\u2026';
      out.textContent = '';
      try {
        const res = await fetch('/admin/api/recover-stats-from-analytics', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apply: apply === true }),
        });
        const data = await res.json();
        if (!data.ok) {
          status.textContent = 'Failed: ' + (data.error || 'unknown error') + (data.release ? ' (Release ' + data.release + ')' : '');
        } else {
          status.textContent = data.applied
            ? 'Done: ' + data.toPutBack + ' counts put back.'
            : (data.toPutBack ? data.toPutBack + ' counts to put back' : 'Nothing left to put back') + (data.alreadyPutBack ? ' (' + data.alreadyPutBack + ' already back).' : '.');
          const lines = [
            'Page views, installs, pings and other counters: ' + data.totals.stat + '. Watched and list adds: ' + data.totals.event + '. Searches: ' + data.totals.search + '.',
          ];
          Object.keys(data.counters || {}).forEach(function (k) { lines.push(k + ': ' + data.counters[k]); });
          if (data.truncated && data.truncated.length) lines.push('More rows than one pass reads (' + data.truncated.join(', ') + '): run it again.');
          lines.forEach(function (line) {
            const div = document.createElement('div');
            div.textContent = line;
            out.appendChild(div);
          });
        }
      } catch (e) {
        status.textContent = 'Failed: network error.';
      }
      buttons.forEach(function (b) { if (b) b.disabled = false; });
    }

    async function runSchemaCheck() {
      const btn = document.getElementById('schemaCheckBtn');
      const status = document.getElementById('schemaCheckStatus');
      const out = document.getElementById('schemaCheckResult');
      btn.disabled = true;
      status.textContent = 'Checking\u2026';
      out.innerHTML = '';
      try {
        const res = await fetch('/admin/api/schema-status');
        const data = await res.json();
        if (!data.ok) {
          status.textContent = 'Failed: ' + (data.error || 'unknown error');
          btn.disabled = false;
          return;
        }
        // The public directory index truncates silently at its entry cap --
        // it keeps the most-liked and drops the tail, which is the right
        // choice, but nothing said it had happened. Reported here in every
        // branch below, because it has nothing to do with D1: a KV-only
        // deployment can hit it too.
        var idx = data.publicIndex;
        var indexNote = '';
        if (idx) {
          var pct = idx.max ? Math.round((idx.entries / idx.max) * 100) : 0;
          indexNote = idx.truncated
            ? '<p class="u-c-v_color_warn_text u-m-10px_0_0 u-fs-v_font_size_sm"><strong>The public list directory is full.</strong> ' +
              'It holds ' + idx.entries.toLocaleString() + ' of a maximum ' + idx.max.toLocaleString() +
              ' entries, so the least-liked lists past that point are no longer being advertised. ' +
              'They are still reachable by their own URL.</p>'
            : '<p class="u-c-v_muted u-m-10px_0_0 u-fs-v_font_size_sm">Public list directory: ' +
              idx.entries.toLocaleString() + ' of ' + idx.max.toLocaleString() + ' entries (' + pct + '%).</p>';
        }
        if (!data.bound) {
          status.textContent = '';
          out.innerHTML = '<p class="u-c-v_color_danger_text u-m-0 u-fs-v_font_size_sm"><strong>Warning: No D1 database is bound.</strong> D1 is required for authoritative accounts, lists, search, likes, feedback, and tracking. Bind a D1 database as <code>DB</code> in Cloudflare Settings &rarr; Bindings.</p>' + indexNote;
          btn.disabled = false;
          return;
        }
        if (!data.checked) {
          status.textContent = '';
          out.innerHTML = '<p class="u-c-v_color_warn_text u-m-0 u-fs-v_font_size_sm">Could not read the database to check' +
            (data.error ? (': ' + escapeHtmlAdmin(data.error)) : '.') +
            ' This is not the same as a missing migration \u2014 try again.</p>' + indexNote;
          btn.disabled = false;
          return;
        }
        // The migration ledger comes first: while it is behind, the site
        // refuses every API write, which matters more than anything below.
        var ledger = data.ledger;
        var ledgerNote = '';
        if (ledger && ledger.behind) {
          ledgerNote = '<p class="u-c-v_color_danger_text u-m-0_0_10px u-fs-v_font_size_sm"><strong>Writes are paused.</strong> ' +
            'The database is at migration ' + escapeHtmlAdmin(ledger.version) + ' and this Worker needs ' +
            escapeHtmlAdmin(ledger.required) + '. Visitors see &ldquo;My Lists is being updated&rdquo; on every save until the missing migrations are applied.</p>';
        } else if (ledger && ledger.readable && !ledger.version) {
          ledgerNote = '<p class="u-c-v_color_warn_text u-m-0_0_10px u-fs-v_font_size_sm">The migration ledger is empty.</p>';
        } else if (ledger && !ledger.readable) {
          ledgerNote = '<p class="u-c-v_color_warn_text u-m-0_0_10px u-fs-v_font_size_sm">No migration ledger yet. Apply <code>migrations/0014_add_schema_migrations.sql</code> so the Worker can tell which migrations have run.</p>';
        } else if (ledger) {
          ledgerNote = '<p class="u-c-v_muted u-m-0_0_10px u-fs-v_font_size_sm">Database at migration ' +
            escapeHtmlAdmin(ledger.version) + ' (this Worker needs ' + escapeHtmlAdmin(ledger.required) + ').</p>';
        }
        var dbStats = data.databaseStats;
        var dbStatsNote = '';
        if (dbStats && dbStats.estimatedSizeBytes != null) {
          var mb = (dbStats.estimatedSizeBytes / (1024 * 1024)).toFixed(2);
          var rowsStr = dbStats.rowCounts
            ? Object.entries(dbStats.rowCounts).map(function (e) { return e[0] + ': ' + e[1].toLocaleString(); }).join(', ')
            : '';
          dbStatsNote = '<p class="u-c-v_muted u-m-8px_0_0 u-fs-v_font_size_sm">Database size: ~' +
            mb + ' MB (' + (dbStats.pageCount || 0).toLocaleString() + ' pages &times; ' +
            (dbStats.pageSize || 0).toLocaleString() + ' B).' +
            (rowsStr ? ('<br><span class="u-fs-v_font_size_xs">Rows: ' + escapeHtmlAdmin(rowsStr) + '</span>') : '') +
            '</p>';
        }
        if (data.upToDate) {
          status.textContent = '';
          out.innerHTML = ledgerNote + '<p class="u-c-v_color_success_text u-m-0 u-fs-v_font_size_sm">Up to date \u2014 every migration has been applied.</p>' + dbStatsNote + indexNote;
          btn.disabled = false;
          return;
        }
        const rows = (data.missing || []).map(function (m) {
          return '<tr>' +
            '<td class="u-p-4px_10px_4px_0 u-va-top u-ws-nowrap"><code>' + escapeHtmlAdmin(m.migration) + '</code></td>' +
            '<td class="u-p-4px_10px_4px_0 u-va-top u-ws-nowrap"><code>' + escapeHtmlAdmin(m.name) + '</code></td>' +
            '<td class="u-p-4px_0 u-va-top">' + escapeHtmlAdmin(m.consequence) + '</td>' +
            '</tr>';
        }).join('');
        status.textContent = '';
        out.innerHTML = ledgerNote + '<p class="u-c-v_color_warn_text u-m-0_0_8px u-fs-v_font_size_sm"><strong>This Worker is running ahead of its database.</strong> ' +
          'Unapplied migration' + ((data.pendingMigrations || []).length === 1 ? '' : 's') + ': ' +
          escapeHtmlAdmin((data.pendingMigrations || []).join(', ')) +
          '. Apply the matching file(s) under <code>migrations/</code> in the D1 Console, in filename order.</p>' +
          '<div class="u-ovx-auto"><table class="u-bordercollapse-collapse u-fs-v_font_size_sm" style="width:100%;">' +
          '<thead><tr class="u-c-v_muted u-ta-left"><th class="u-pr-10px">Migration</th><th class="u-pr-10px">Missing</th><th>What does not work without it</th></tr></thead>' +
          '<tbody>' + rows + '</tbody></table></div>' + dbStatsNote + indexNote;
      } catch (e) {
        status.textContent = 'Failed: network error.';
      }
      btn.disabled = false;
    }

    // The endpoint does one bounded chunk per call (see its own comment for
    // why a rebuild cannot be one pass), so this loops until it reports
    // done -- the same shape as runMigrateDayCounts above.
    async function runRebuildPublicIndex() {
      const btn = document.getElementById('rebuildIndexBtn');
      const status = document.getElementById('rebuildIndexStatus');
      btn.disabled = true;
      status.textContent = 'Working\u2026';
      const started = Date.now();
      let scanned = 0;
      let safetyCounter = 0;
      try {
        while (safetyCounter < 1000) {
          safetyCounter++;
          const res = await fetch('/admin/api/rebuild-public-index', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
          const data = await res.json();
          if (!data.ok) {
            status.textContent = 'Failed: ' + (data.error || 'unknown error');
            break;
          }
          scanned += data.scanned || 0;
          if (data.done) {
            status.textContent = 'Done \u2014 indexed ' + data.count + ' list' + (data.count === 1 ? '' : 's') +
              ' from ' + scanned + ' record' + (scanned === 1 ? '' : 's') + ' in ' + (Date.now() - started) + 'ms.';
            break;
          }
          status.textContent = 'Working\u2026 ' + scanned + ' record' + (scanned === 1 ? '' : 's') +
            ' scanned, ' + data.count + ' indexed so far.';
        }
      } catch (e) {
        status.textContent = 'Failed: network error.';
      }
      btn.disabled = false;
    }

    async function loadApiUsage() {
      const body = document.getElementById('apiUsageTableBody');
      body.innerHTML = '<tr><td colspan="5">Loading\u2026</td></tr>';
      try {
        const res = await fetch('/admin/api/apiusage');
        const data = await res.json();
        if (!data.ok || !data.keys || !data.keys.length) {
          body.innerHTML = '<tr><td colspan="5">No data yet.</td></tr>';
          return;
        }
        body.innerHTML = data.keys.map((k) =>
          '<tr>' +
            '<td>' + escapeHtmlAdmin(k.label) + (k.configured ? '' : ' <span class="u-c-v_color_warn_text">(not set)</span>') + '</td>' +
            '<td>' + k.last24h + '</td>' +
            '<td>' + k.last7d + '</td>' +
            '<td>' + k.last30d + '</td>' +
            '<td class="u-c-v_muted">' + escapeHtmlAdmin(k.limit) + '</td>' +
          '</tr>'
        ).join('');
      } catch (e) {
        body.innerHTML = '<tr><td colspan="5">Could not load -- try again.</td></tr>';
      }
    }

    function netflixPreviewSectionHtml(label, section) {
      if (!section) return '';
      const posters = section.items.map((it) =>
        '<div>' +
          (it.poster
            ? '<img class="netflix-preview-poster" src="' + escapeHtmlAdmin(it.poster) + '" alt="" loading="lazy">'
            : '<div class="netflix-preview-poster-placeholder">No poster</div>') +
          '<div class="netflix-preview-title">' + escapeHtmlAdmin(it.title) + '</div>' +
          (it.date ? '<div class="netflix-preview-year">' + escapeHtmlAdmin(it.date) + '</div>' : '') +
        '</div>'
      ).join('');
      return '<h3 class="u-m-0_0_4px u-fs-v_font_size_md">' + label + ' <span class="u-c-v_muted u-fw-400 u-fs-v_font_size_sm">(~' + section.total.toLocaleString() + ' total on TMDB/JustWatch, showing first ' + section.items.length + ')</span></h3>' +
        '<div class="netflix-preview-grid">' + posters + '</div>';
    }

    async function loadNetflixPreview() {
      const statusEl = document.getElementById('netflixPreviewStatus');
      const moviesEl = document.getElementById('netflixPreviewMovies');
      const showsEl = document.getElementById('netflixPreviewShows');
      const regionInput = document.getElementById('netflixPreviewRegionInput');
      const providerIdInput = document.getElementById('netflixPreviewProviderIdInput');
      const region = (regionInput.value || 'US').trim().toUpperCase().slice(0, 2) || 'US';
      const providerId = (providerIdInput.value || '8').trim() || '8';
      statusEl.textContent = 'Loading\u2026';
      moviesEl.innerHTML = '';
      showsEl.innerHTML = '';
      try {
        const res = await fetch('/admin/api/netflix-preview?region=' + encodeURIComponent(region) + '&providerId=' + encodeURIComponent(providerId));
        const data = await res.json();
        if (!data.ok) {
          statusEl.textContent = data.error || 'Could not load preview.';
          return;
        }
        statusEl.textContent = '';
        moviesEl.innerHTML = netflixPreviewSectionHtml('Movies', data.movies);
        showsEl.innerHTML = netflixPreviewSectionHtml('Shows', data.shows);
      } catch (e) {
        statusEl.textContent = 'Could not load -- check your connection.';
      }
    }

    // Fills the Provider id field from a lookup result and immediately
    // reloads the preview with it -- clicking a name found this way should
    // just show that provider's shelf, not require a second manual click.
    function pickProviderId(id) {
      document.getElementById('netflixPreviewProviderIdInput').value = id;
      loadNetflixPreview();
    }

    async function lookupProviderIds() {
      const statusEl = document.getElementById('providerLookupStatus');
      const resultsEl = document.getElementById('providerLookupResults');
      const queryInput = document.getElementById('providerLookupQueryInput');
      const regionInput = document.getElementById('netflixPreviewRegionInput');
      const query = (queryInput.value || '').trim();
      const region = (regionInput.value || 'US').trim().toUpperCase().slice(0, 2) || 'US';
      statusEl.textContent = 'Searching\u2026';
      resultsEl.innerHTML = '';
      try {
        const res = await fetch('/admin/api/provider-lookup?region=' + encodeURIComponent(region) + (query ? '&query=' + encodeURIComponent(query) : ''));
        const data = await res.json();
        if (!data.ok) {
          statusEl.textContent = data.error || 'Could not search.';
          return;
        }
        statusEl.textContent = '';
        if (!data.results.length) {
          resultsEl.innerHTML = '<p class="u-c-v_muted u-fs-v_font_size_sm">No matches.</p>';
          return;
        }
        resultsEl.innerHTML = data.results.map((p) =>
          '<button type="button" class="admin-select u-cur-pointer u-m-0_6px_6px_0" data-act="pickProviderId" data-act-args="' + adminActAttr([p.id]) + '">' +
            escapeHtmlAdmin(p.name) + ' <span class="u-c-v_muted">(' + p.id + ')</span>' +
          '</button>'
        ).join('');
      } catch (e) {
        statusEl.textContent = 'Could not search -- check your connection.';
      }
    }


    // --- New on Streaming ---------------------------------------------------
    //
    // The whole test surface for a catalog that is deliberately not on the
    // site yet: what the sweep has collected, a way to push it along, and a
    // preview that goes through the real fetchNewOnStreaming rather than
    // re-deriving the shelf here (a second implementation would be the one
    // thing guaranteed to disagree with what Stremio gets).
    let nosProviders = [];

    function nosEpochToDay(sec) {
      const n = Number(sec) || 0;
      if (!n) return '--';
      try {
        return new Date(n * 1000).toISOString().slice(0, 10);
      } catch (e) {
        return '--';
      }
    }

    function nosProviderLabel(svc) {
      if (!svc) return '';
      const p = (nosProviders || []).find(function (x) { return x.key === svc; });
      return p ? p.name : (svc.charAt(0).toUpperCase() + svc.slice(1));
    }

    async function loadNewOnStreaming() {
      const statusEl = document.getElementById('nosStatus');
      const bodyEl = document.getElementById('nosByServiceBody');
      statusEl.textContent = 'Loading…';
      try {
        const res = await fetch('/admin/api/new-on-streaming');
        const data = await res.json();
        if (!data.ok) {
          statusEl.textContent = data.error || 'Could not load status.';
          return;
        }
        const st = data.status || {};
        nosProviders = st.providers || [];

        const bits = [];
        bits.push('<div>D1: ' + (st.d1Bound
          ? (st.tableReady
            ? '<span class="u-c-v_color_success_text">bound, streaming_events ready</span>'
            : '<span class="u-c-v_color_danger_text">bound, but the table is missing</span>')
          : '<span class="u-c-v_color_danger_text">not bound -- this catalog is D1-only</span>') + '</div>');
        if (st.error) {
          bits.push('<div class="u-c-v_color_danger_text">' + escapeHtmlAdmin(st.error) + '</div>');
        }
        if (st.engine === 'justwatch') {
          bits.push('<div>Engine: <span class="u-c-v_color_success_text u-fw-600">JustWatch &ldquo;new&rdquo; feed</span> &mdash; the same source mdblist.com/new-on-streaming uses. Last 3 days re-read every 2 hours; ' + (st.jwDaysDone || 0) + ' older days of the 30-day window fully read. (Set the Worker var NEW_ON_STREAMING_ENGINE=rapidapi to switch back.)</div>');
        }
        if (st.engine === 'rapidapi') {
          bits.push('<div>Engine: <span class="u-c-v_color_success_text u-fw-600">RapidAPI Streaming Availability</span> &mdash; pulling direct streaming arrivals &amp; episode updates (previous 30 days)</div>');
        }
        if (st.engine === 'rapidapi' && !st.rapidKeyConfigured) {
          bits.push('<div class="u-c-v_color_danger_text"><strong>RAPIDAPI_KEY is not set.</strong> Run <code>npx wrangler secret put RAPIDAPI_KEY</code> to enable sweeps.</div>');
        }
        const usage = st.monthlyUsage || { count: 0, limit: 1000, remaining: 1000, safetyCap: 950 };
        const quotaColor = usage.count >= usage.safetyCap ? '#FF3B30' : (usage.count >= 750 ? '#FF9500' : '#30d158');
        bits.push('<div>Monthly Quota (' + escapeHtmlAdmin(usage.month || '') + '): <strong style="color:' + quotaColor + ';">' + usage.count + ' / ' + usage.limit + ' requests</strong> (' + usage.remaining + ' remaining; safety cap: ' + usage.safetyCap + ')</div>');
        const hrs = Math.round((st.intervalSeconds || 21600) / 3600);
        bits.push('<div>Automated Schedule: <strong>every ' + hrs + ' hours</strong>' + (st.nextTickPages ? ', next run may use up to <strong>' + st.nextTickPages + '</strong> requests (the month&#39;s remaining quota spread over the runs left)' : '') + '</div>');
        if (st.streams && st.streams.length) {
          bits.push('<div>Change streams: ' + st.streams.map(function (s) {
            const label = s.changeType === 'removed' ? 'removals' : (s.itemType === 'show' ? 'new titles' : 'new ' + s.itemType + 's');
            const upTo = s.readUpTo ? nosEpochToDay(s.readUpTo) + ' ' + new Date(s.readUpTo * 1000).toISOString().slice(11, 16) + ' UTC' : 'not started';
            return '<strong>' + escapeHtmlAdmin(label) + '</strong> read to ' + escapeHtmlAdmin(upTo) +
              (s.catchingUp ? ' <span class="u-c-v_color_warn_text">(catching up)</span>' : '');
          }).join(' &middot; ') + '</div>');
        }
        bits.push('<div>Region: <strong>' + escapeHtmlAdmin(st.region || '') + '</strong> &mdash; 30-day rolling window</div>');
        bits.push('<div>Visible to users: <span class="u-c-v_color_success_text">yes -- My Lists Addon Charts in Quick Add, and Discover</span></div>');
        const totals = st.totals || {};
        bits.push('<div>Active titles in 30d window: <strong>' + (totals.movie || 0) + '</strong> movies, <strong>' + (totals.series || 0) + '</strong> shows (' + (totals.removed || 0) + ' marked removed)</div>');
        if (st.lastSweep) {
          bits.push('<div>Last sweep: ' + nosEpochToDay(st.lastSweep.at) + ' &mdash; ' + (st.lastSweep.units || 0) + ' API calls, ' + (st.lastSweep.seen || 0) + ' changes seen, ' + (st.lastSweep.added || 0) + ' new arrivals, ' + (st.lastSweep.bumped || 0) + ' episodes bumped' + (st.lastSweep.pruned ? ', ' + st.lastSweep.pruned + ' pruned (>30d)' : '') + (st.lastSweep.errors ? ', ' + st.lastSweep.errors + ' errors' + (st.lastSweep.lastError ? ': ' + escapeHtmlAdmin(st.lastSweep.lastError) : '') : '') + (st.lastSweep.reason ? ' (' + escapeHtmlAdmin(st.lastSweep.reason) + ')' : '') + '</div>');
        } else {
          bits.push('<div class="u-c-v_color_warn_text">No sweep has completed yet.</div>');
        }
        statusEl.innerHTML = bits.join('');

        const rows = st.byService || [];
        bodyEl.innerHTML = rows.length
          ? rows.map(function (r) {
              return '<tr><td>' + escapeHtmlAdmin(r.service) + '</td><td>' + escapeHtmlAdmin(r.kind) + '</td><td>' + r.count + '</td><td>' + r.removed + '</td><td>' + nosEpochToDay(r.newest) + '</td></tr>';
            }).join('')
          : '<tr><td colspan="5">Nothing collected yet -- run a sweep.</td></tr>';

        const sel = document.getElementById('nosPreviewService');
        if (sel && sel.options.length <= 1) {
          nosProviders.forEach(function (p) {
            const opt = document.createElement('option');
            opt.value = p.key;
            opt.textContent = p.name;
            sel.appendChild(opt);
          });
        }
      } catch (e) {
        statusEl.textContent = 'Could not load -- check your connection.';
      }
    }

    async function runNewOnStreamingSweep(isReset) {
      if (isReset) {
        if (!confirm('This will remove all current items from New on Streaming and pull fresh data from RapidAPI across the 30-day window. Continue?')) {
          return;
        }
      }
      const btn = document.getElementById('nosSweepBtn');
      const resetBtn = document.getElementById('nosResetBtn');
      const statusEl = document.getElementById('nosSweepStatus');
      let units = parseInt(document.getElementById('nosSweepUnits').value, 10) || 30;
      if (isReset && units < 30) {
        units = 30;
      }
      if (btn) btn.disabled = true;
      if (resetBtn) resetBtn.disabled = true;
      statusEl.textContent = isReset ? 'Clearing items & pulling fresh data from RapidAPI…' : 'Sweeping RapidAPI…';
      try {
        const res = await fetch('/admin/api/new-on-streaming/sweep', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ units: units, manual: true, reset: !!isReset, full: !!isReset }),
        });
        const data = await res.json();
        if (!data.ok) {
          statusEl.textContent = data.error || 'Sweep failed.';
          if (btn) btn.disabled = false;
          if (resetBtn) resetBtn.disabled = false;
          return;
        }
        const sw = data.sweep || {};
        if (!sw.ran) {
          statusEl.textContent = sw.reason || 'The sweep did not run.';
        } else {
          let msg = (sw.cleared ? 'Existing items cleared. ' : '') + sw.units + ' API calls, ' + sw.seen + ' changes seen, ' + sw.added + ' added, ' + sw.bumped + ' episodes bumped';
          if (sw.pruned) msg += ', ' + sw.pruned + ' pruned (>30d)';
          if (sw.errors) msg += '; ' + sw.errors + ' errors' + (sw.lastError ? ': ' + sw.lastError : ' (see Worker log)');
          statusEl.textContent = msg;
        }
        await loadNewOnStreaming();
        if (typeof loadNewOnStreamingPreview === 'function') {
          await loadNewOnStreamingPreview();
        }
      } catch (e) {
        statusEl.textContent = 'Could not run -- check your connection.';
      }
      if (btn) btn.disabled = false;
      if (resetBtn) resetBtn.disabled = false;
    }

    let nosCurrentPage = 0;
    const nosPageLimit = 100;
    let nosSearchTimeout = null;

    function nosResetAndPreview() {
      nosCurrentPage = 0;
      loadNewOnStreamingPreview();
    }

    function onNosPreviewSearchInput() {
      if (nosSearchTimeout) clearTimeout(nosSearchTimeout);
      nosSearchTimeout = setTimeout(function() {
        nosCurrentPage = 0;
        loadNewOnStreamingPreview();
      }, 350);
    }

    function nosChangePage(delta) {
      nosCurrentPage = Math.max(0, nosCurrentPage + delta);
      loadNewOnStreamingPreview();
    }

    async function nosAddTitle() {
      const inputEl = document.getElementById('nosAddTitleInput');
      const svcEl = document.getElementById('nosAddServiceSelect');
      const kindEl = document.getElementById('nosAddKindSelect');
      const dateEl = document.getElementById('nosAddDateInput');
      const statusEl = document.getElementById('nosAddStatus');
      const btn = document.getElementById('nosAddBtn');
      const input = (inputEl.value || '').trim();
      if (!input) {
        statusEl.textContent = 'Please enter a title, IMDb ID, or TMDB ID.';
        return;
      }
      btn.disabled = true;
      statusEl.textContent = 'Searching & syncing title…';
      try {
        const res = await fetch('/admin/api/new-on-streaming/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            input: input,
            service: svcEl.value,
            kind: kindEl.value,
            date: dateEl.value || null,
          }),
        });
        const data = await res.json();
        if (!data.ok) {
          statusEl.textContent = data.error || 'Failed to add title.';
        } else {
          const r = data.result || {};
          statusEl.innerHTML = '<span class="u-c-v_color_success_text u-fw-600">Added: ' + escapeHtmlAdmin(r.name) + ' (' + escapeHtmlAdmin(nosProviderLabel(r.service)) + ', ' + (r.eventKind === 'episode' ? 'Episode ' + r.season + 'x' + r.episode + ', ' : '') + nosEpochToDay(r.eventAt) + ')</span>';
          inputEl.value = '';
          await loadNewOnStreaming();
          nosResetAndPreview();
        }
      } catch (e) {
        statusEl.textContent = 'Could not sync title -- check connection.';
      }
      btn.disabled = false;
    }

    async function loadNewOnStreamingPreview() {
      const statusEl = document.getElementById('nosPreviewStatus');
      const resultsEl = document.getElementById('nosPreviewResults');
      const sourceEl = document.getElementById('nosPreviewSource');
      const type = document.getElementById('nosPreviewType').value;
      const service = document.getElementById('nosPreviewService').value;
      const qInput = document.getElementById('nosPreviewSearch');
      const q = qInput ? (qInput.value || '').trim() : '';
      const prevBtn = document.getElementById('nosPrevBtn');
      const nextBtn = document.getElementById('nosNextBtn');
      const pageLabel = document.getElementById('nosPageLabel');

      statusEl.textContent = 'Loading…';
      resultsEl.innerHTML = '';
      try {
        const skip = nosCurrentPage * nosPageLimit;
        let url = '/admin/api/new-on-streaming/preview?type=' + encodeURIComponent(type) +
          (service ? '&services=' + encodeURIComponent(service) : '') +
          (q ? '&q=' + encodeURIComponent(q) : '') +
          '&skip=' + skip + '&limit=' + nosPageLimit;

        const res = await fetch(url);
        const data = await res.json();
        if (!data.ok) {
          statusEl.textContent = data.error || 'Could not load preview.';
          return;
        }
        sourceEl.textContent = data.source;
        const total = data.totalItems != null ? data.totalItems : 0;
        statusEl.textContent = (data.totalItems != null ? data.totalItems + ' titles in this row' : '');

        if (pageLabel) pageLabel.textContent = 'Page ' + (nosCurrentPage + 1);
        if (prevBtn) prevBtn.disabled = nosCurrentPage <= 0;
        if (nextBtn) nextBtn.disabled = (nosCurrentPage + 1) * nosPageLimit >= total;

        if (!data.items || !data.items.length) {
          resultsEl.innerHTML = '<p class="u-c-v_muted u-fs-v_font_size_sm">Empty -- no matching titles found.</p>';
          return;
        }
        // Grouped by day like mdblist.com/new-on-streaming, so the two can be
        // compared side by side.
        let lastDay = '';
        resultsEl.innerHTML =
          '<div class="table-wrap"><table><tr><th>#</th><th>Poster</th><th>Title</th><th>Type</th><th>Service</th><th>Added Date</th><th>Year</th><th>Id</th></tr>' +
          data.items.map(function (it, i) {
            const isSeries = it.type === 'series';
            const typeBadge = isSeries
              ? '<span class="admin-badge series">Show</span>'
              : '<span class="admin-badge movie">Movie</span>';
            const svcs = (it.services && it.services.length ? it.services : (it.service ? [it.service] : []));
            const svcBadges = svcs.length
              ? svcs.map(function (s) {
                  return '<span class="admin-badge service">' + escapeHtmlAdmin(nosProviderLabel(s)) + '</span>';
                }).join('')
              : '<span class="u-c-v_muted">--</span>';
            const dateStr = it.addedAt ? nosEpochToDay(it.addedAt) : '--';
            let dayHeader = '';
            if (dateStr !== lastDay) {
              lastDay = dateStr;
              dayHeader = '<tr><td colspan="8" class="u-fw-600 u-pt-14px">' + escapeHtmlAdmin(dateStr) + '</td></tr>';
            }

            return dayHeader + '<tr><td>' + (skip + i + 1) + '</td>' +
              '<td>' + (it.poster ? '<img src="' + escapeHtmlAdmin(it.poster) + '" alt="" class="u-objectfit-cover u-br-v_radius_xs" style="width:38px; height:56px; display:block;">' : '') + '</td>' +
              '<td><strong>' + escapeHtmlAdmin(it.name || '') + '</strong></td>' +
              '<td>' + typeBadge + '</td>' +
              '<td>' + svcBadges + '</td>' +
              '<td class="u-ws-nowrap">' + escapeHtmlAdmin(dateStr) + '</td>' +
              '<td>' + escapeHtmlAdmin(it.releaseInfo || '') + '</td>' +
              '<td class="u-c-v_muted u-ff-monospace u-fs-v_font_size_sm">' + escapeHtmlAdmin(it.id || '') + '</td></tr>';
          }).join('') +
          '</table></div>';
      } catch (e) {
        statusEl.textContent = 'Could not load -- check your connection.';
      }
    }

    // --- Channel Presets -----------------------------------------------------
    //
    // Status of the shared channel:preset:v2:<networkId> cache behind every
    // Quick Add network channel, and one-click clear/rebuild for when it is
    // still serving what an older version of buildNetworkChannelPreset built.

    function cpAgoText(ms) {
      if (!ms) return '--';
      const secs = Math.max(0, Math.floor((Date.now() - ms) / 1000));
      if (secs < 60) return secs + 's ago';
      const mins = Math.floor(secs / 60);
      if (mins < 60) return mins + 'm ago';
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + 'h ago';
      return Math.floor(hrs / 24) + 'd ago';
    }

    async function loadChannelPresets() {
      const statusEl = document.getElementById('cpStatus');
      const body = document.getElementById('cpTableBody');
      statusEl.textContent = 'Loading…';
      try {
        const res = await fetch('/admin/api/channel-presets');
        const data = await res.json();
        if (!data.ok) {
          statusEl.textContent = data.error || 'Could not load.';
          return;
        }
        statusEl.textContent = data.networks.length + ' networks';
        body.innerHTML = data.networks.map((net) => {
          const cachedBadge = net.cached
            ? '<span class="admin-badge u-bg-rgba_52_199_89_0_15 u-c-v_color_success_text">cached</span>'
            : '<span class="u-c-v_muted">not cached</span>';
          return '<tr>' +
            '<td><strong>' + escapeHtmlAdmin(net.name) + '</strong> <span class="u-c-v_muted u-ff-monospace u-fs-v_font_size_xs">(' + escapeHtmlAdmin(net.id) + ')</span></td>' +
            '<td>' + cachedBadge + '</td>' +
            '<td>' + (net.cached ? net.itemCount : '--') + '</td>' +
            '<td class="u-ws-nowrap">' + cpAgoText(net.builtAt) + '</td>' +
            '<td class="u-ws-nowrap">' +
              '<button type="button" class="secondary lc-btn u-p-4px_10px u-fs-v_font_size_sm" data-act="rebuildOneChannelPreset" data-act-args="' + adminActAttr([net.id, '@self']) + '">Rebuild</button> ' +
              '<button type="button" class="secondary lc-btn u-p-4px_10px u-fs-v_font_size_sm u-c-v_color_danger_text" data-act="clearOneChannelPreset" data-act-args="' + adminActAttr([net.id, '@self']) + '"' + (net.cached ? '' : ' disabled') + '>Clear</button>' +
            '</td>' +
          '</tr>';
        }).join('');
      } catch (e) {
        statusEl.textContent = 'Could not load -- check your connection.';
      }
    }

    async function clearOneChannelPreset(networkId, btn) {
      if (btn) btn.disabled = true;
      try {
        const res = await fetch('/admin/api/channel-presets/clear', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ networkId: networkId }),
        });
        const data = await res.json();
        if (!data.ok) {
          showAdminAlert('Clear Failed', data.error || 'Could not clear the cached preset.', false);
        }
      } catch (e) {
        showAdminAlert('Network Error', 'Could not clear the cached preset -- check your connection.', false);
      }
      loadChannelPresets();
    }

    async function rebuildOneChannelPreset(networkId, btn) {
      const originalLabel = btn ? btn.textContent : '';
      if (btn) { btn.disabled = true; btn.textContent = 'Building…'; }
      try {
        const res = await fetch('/admin/api/channel-presets/rebuild', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ networkId: networkId }),
        });
        const data = await res.json();
        if (!data.ok) {
          showAdminAlert('Rebuild Failed', data.error || 'Could not rebuild the cached preset.', false);
        }
      } catch (e) {
        showAdminAlert('Network Error', 'Could not rebuild the cached preset -- check your connection.', false);
      }
      if (btn) btn.textContent = originalLabel;
      loadChannelPresets();
    }

    async function clearAllChannelPresets() {
      if (!confirm('Clear every network’s cached preset? Each one rebuilds fresh the next time it is Quick Added or the cron rotation reaches it.')) return;
      const btn = document.getElementById('cpClearAllBtn');
      if (btn) btn.disabled = true;
      try {
        const res = await fetch('/admin/api/channel-presets/clear', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ all: true }),
        });
        const data = await res.json();
        if (!data.ok) {
          showAdminAlert('Clear Failed', data.error || 'Could not clear the cached presets.', false);
        }
      } catch (e) {
        showAdminAlert('Network Error', 'Could not clear the cached presets -- check your connection.', false);
      }
      if (btn) btn.disabled = false;
      loadChannelPresets();
    }

    // feedbackEntries is the client's local copy of the list, kept in sync
    // with the server -- submitAdminFeedback and toggleFeedbackStatus both
    // mutate this array and re-render immediately (optimistic), then send
    // the real change to the server in the background, only reaching back
    // into the DOM again if that background call fails and the local
    // change needs to be rolled back.
    let feedbackEntries = [];
    let feedbackTruncated = false;

    async function loadFeedback() {
      const box = document.getElementById('feedbackList');
      box.textContent = 'Loading\u2026';
      try {
        const res = await fetch('/admin/api/feedback');
        const data = await res.json();
        if (!data.ok) {
          box.innerHTML = '<p class="u-c-v_color_danger_text">Could not load feedback -- try again.</p>';
          return;
        }
        feedbackEntries = data.entries || [];
        feedbackTruncated = !!data.truncated;
        renderFeedbackList();
      } catch (e) {
        box.innerHTML = '<p class="u-c-v_color_danger_text">Could not load feedback -- try again.</p>';
      }
    }

    // Pure render of whatever's currently in feedbackEntries -- called
    // after the initial load, and again (instantly, no fetch) any time
    // submitAdminFeedback/toggleFeedbackStatus change that array so the
    // list reflects the change right away instead of waiting on a round
    // trip back to the server.
    function renderFeedbackList() {
      const box = document.getElementById('feedbackList');
      if (!box) return;
      if (!feedbackEntries.length) {
        box.innerHTML = '<p class="u-c-v_muted">No feedback yet.</p>';
        return;
      }
      const open = feedbackEntries.filter((f) => !f.completed);
      const done = feedbackEntries.filter((f) => f.completed);
      box.innerHTML = open.map(feedbackCardHtml).join('') +
        (done.length ? '<h3 class="u-m-20px_0_4px u-fs-v_font_size_base u-c-v_muted">Completed</h3>' + done.map(feedbackCardHtml).join('') : '') +
        (feedbackTruncated ? '<p class="u-c-v_muted u-fs-v_font_size_sm">Showing the most recent 300.</p>' : '');
      initFeedbackListEvents();
    }

    function feedbackCardHtml(f) {
      const cat = ['bug', 'improvement', 'idea', 'other'].includes(f.category) ? f.category : 'other';
      const when = f.createdAt ? new Date(f.createdAt).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }) : '';
      const isSelfLogged = f.creatorName === 'admin';
      // Already escaped here, so every use of it below must NOT escape it
      // again -- the reply placeholder did, and rendered a creator called
      // A&B as A&amp;B. (No backticks in this function: everything from
      // renderAdminDashboard's opening backtick onwards is string content.)
      const who = isSelfLogged ? 'admin (self-logged)' : (f.creatorName ? escapeHtmlAdmin(f.creatorName) : 'anonymous');
      const contact = f.contact ? ' \u2014 ' + escapeHtmlAdmin(f.contact) : '';
      const completed = !!f.completed;
      const statusLabel = (!isSelfLogged && f.status === 'replied')
        ? '<span class="admin-badge improvement u-ml-6px">Replied</span>'
        : (completed ? '<span class="admin-badge other u-ml-6px">Resolved</span>' : '<span class="admin-badge bug u-ml-6px">Open</span>');

      const messages = Array.isArray(f.messages) && f.messages.length
        ? f.messages
        : [{
            id: 'msg_init',
            sender: isSelfLogged ? 'admin' : 'user',
            senderName: isSelfLogged ? 'Admin' : (f.creatorName || 'User'),
            text: f.message || '',
            timestamp: f.createdAt || Date.now()
          }];

      const messagesHtml = messages.map((m) => {
        const isAdmin = m.sender === 'admin';
        const sender = isAdmin ? '\uD83D\uDC68\u200D\uD83D\uDCBB Developer (Admin)' : (m.senderName || who);
        const mTime = m.timestamp ? new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        const bg = isAdmin ? 'rgba(0,122,255,0.08)' : 'rgba(255,255,255,0.04)';
        const border = isAdmin ? 'rgba(0,122,255,0.25)' : 'var(--border)';
        return '<div style="margin-top:6px; padding:8px 12px; border-radius:var(--radius-sm); background:' + bg + '; border:1px solid ' + border + ';">' +
          '<div style="display:flex; justify-content:space-between; font-size:var(--font-size-xs); font-weight:700; color:' + (isAdmin ? 'var(--accent)' : 'var(--text)') + ';">' +
            '<span>' + escapeHtmlAdmin(sender) + '</span>' +
            '<span class="u-c-v_muted u-fw-normal">' + escapeHtmlAdmin(mTime) + '</span>' +
          '</div>' +
          '<div class="u-mt-4px u-fs-v_font_size_sm u-ws-pre_wrap u-wb-break_word u-c-v_text">' + escapeHtmlAdmin(m.text || '') + '</div>' +
        '</div>';
      }).join('');

      return '<div class="feedback-card' + (completed ? ' completed' : '') + '" id="feedbackCard_' + escapeHtmlAdmin(f.id) + '">' +
        '<div class="feedback-card-header">' +
          '<div>' +
            '<span class="admin-badge ' + cat + '">' + cat + '</span>' +
            statusLabel +
          '</div>' +
          '<div class="feedback-actions">' +
            '<button type="button" class="admin-select fb-copy-btn u-m-0 u-cur-pointer" data-id="' + escapeHtmlAdmin(f.id) + '">&#x2398; Copy</button>' +
            '<button type="button" class="admin-select fb-edit-btn u-m-0 u-cur-pointer" data-id="' + escapeHtmlAdmin(f.id) + '">&#x270E; Edit</button>' +
            '<button type="button" class="admin-select fb-status-btn u-m-0 u-cur-pointer" data-id="' + escapeHtmlAdmin(f.id) + '" data-completed="' + (!completed) + '">' +
              (completed ? '\u21a9 Reopen' : '\u2713 Mark done') +
            '</button>' +
            '<button type="button" class="admin-select fb-delete-btn u-m-0 u-cur-pointer u-c-v_color_danger_text u-bdc-rgba_255_59_48_0_3" data-id="' + escapeHtmlAdmin(f.id) + '">&#x2715; Delete</button>' +
          '</div>' +
        '</div>' +
        '<div class="u-mt-10px">' + messagesHtml + '</div>' +
        '<div class="feedback-meta u-mt-8px">' + when + ' \u2014 ' + who + contact + '</div>' +
        (!isSelfLogged ?
          '<div class="u-mt-10px u-gap-8px u-ai-center" style="display:flex;">' +
            '<input type="text" id="adminReplyInput_' + escapeHtmlAdmin(f.id) + '" class="admin-select fb-reply-input u-flex-1 u-mr-0 u-p-8px_10px" data-id="' + escapeHtmlAdmin(f.id) + '" placeholder="Type reply to ' + who + '...">' +
            '<button type="button" class="secondary lc-btn fb-reply-btn u-p-6px_14px u-fs-v_font_size_sm" data-id="' + escapeHtmlAdmin(f.id) + '">Reply</button>' +
          '</div>' : ''
        ) +
      '</div>';
    }

    function initFeedbackListEvents() {
      const listEl = document.getElementById('feedbackList');
      if (!listEl || listEl._eventsBound) return;
      listEl._eventsBound = true;

      listEl.addEventListener('click', (e) => {
        const replyBtn = e.target.closest('.fb-reply-btn');
        if (replyBtn) {
          sendAdminFeedbackReply(replyBtn.dataset.id);
          return;
        }
        const copyBtn = e.target.closest('.fb-copy-btn');
        if (copyBtn) {
          copyFeedbackMessage(copyBtn, copyBtn.dataset.id);
          return;
        }
        const editBtn = e.target.closest('.fb-edit-btn');
        if (editBtn) {
          openEditFeedbackModal(editBtn.dataset.id);
          return;
        }
        const statusBtn = e.target.closest('.fb-status-btn');
        if (statusBtn) {
          toggleFeedbackStatus(statusBtn.dataset.id, statusBtn.dataset.completed === 'true');
          return;
        }
        const deleteBtn = e.target.closest('.fb-delete-btn');
        if (deleteBtn) {
          deleteFeedbackEntry(deleteBtn.dataset.id);
          return;
        }
      });

      listEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const input = e.target.closest('.fb-reply-input');
          if (input) {
            e.preventDefault();
            sendAdminFeedbackReply(input.dataset.id);
          }
        }
      });
    }

    async function sendAdminFeedbackReply(id) {
      const input = document.getElementById('adminReplyInput_' + id);
      const text = (input ? input.value : '').trim();
      if (!text) return;
      input.disabled = true;

      try {
        const res = await fetch('/admin/api/feedback/reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id, message: text }),
        });
        const data = await res.json().catch(() => null);
        if (data && data.ok && data.entry) {
          const idx = feedbackEntries.findIndex((f) => f.id === id);
          if (idx !== -1) {
            feedbackEntries[idx] = data.entry;
          }
          renderFeedbackList();
        } else {
          showAdminAlert('Reply Failed', (data && data.error) || 'Could not send reply.', false);
          if (input) input.disabled = false;
        }
      } catch (e) {
        showAdminAlert('Connection Error', 'Could not send reply -- check your connection.', false);
        if (input) input.disabled = false;
      }
    }

    // Lets the admin log an issue directly from the dashboard, without
    // going through Settings > Feedback -- posts to the same /api/feedback
    // endpoint real users hit, just tagged so it's obviously self-logged
    // in the list below. Optimistic: the card appears the instant this
    // function runs, built from a temporary client-side id, and is
    // swapped for the server's real entry once the save actually
    // completes (or removed again if it fails).
    async function submitAdminFeedback() {
      const category = document.getElementById('newFeedbackCategory').value;
      const messageBox = document.getElementById('newFeedbackMessage');
      const message = messageBox.value.trim();
      const status = document.getElementById('newFeedbackStatus');
      const btn = document.getElementById('newFeedbackSubmitBtn');
      if (!message) {
        status.textContent = 'Type something first.';
        return;
      }
      btn.disabled = true;

      const tempId = 'temp:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8);
      const optimisticEntry = {
        id: tempId,
        category: category,
        message: message,
        contact: null,
        creatorName: 'admin',
        createdAt: Date.now(),
        completed: false,
      };
      feedbackEntries.unshift(optimisticEntry);
      renderFeedbackList();
      messageBox.value = '';
      status.textContent = 'Saving\u2026';

      try {
        const res = await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // fromAdminPanel: true is the deliberate signal that this
          // request really is the admin dashboard's own "Log something
          // yourself" feature, not just any page that happens to load in
          // a browser that also has a valid admin cookie. /api/feedback
          // is the same public endpoint the regular addon's Settings page
          // posts to -- without this flag, isAdmin there was based on
          // cookie presence alone, so testing the public feedback UI
          // (e.g. under a different Creator Profile/persona) in the same
          // browser as an active admin session got every message
          // mislabeled as sent by "Developer" instead of that persona.
          body: JSON.stringify({ category: category, message: message, creatorName: 'admin', fromAdminPanel: true }),
        });
        const data = await res.json().catch(() => null);
        if (!data || !data.ok) {
          feedbackEntries = feedbackEntries.filter((f) => f.id !== tempId);
          renderFeedbackList();
          messageBox.value = message;
          status.textContent = (data && data.error) || 'Could not save -- try again.';
          btn.disabled = false;
          return;
        }
        // Swap the temp id for the server's real one -- otherwise a Mark
        // Completed click on this card would send an id the server has
        // never heard of.
        if (data.entry && data.entry.id) {
          const idx = feedbackEntries.findIndex((f) => f.id === tempId);
          if (idx !== -1) {
            feedbackEntries[idx] = data.entry;
            renderFeedbackList();
          }
        }
        status.textContent = 'Added.';
      } catch (e) {
        feedbackEntries = feedbackEntries.filter((f) => f.id !== tempId);
        renderFeedbackList();
        messageBox.value = message;
        status.textContent = 'Could not save -- check your connection.';
      }
      btn.disabled = false;
    }

    function closeAdminModal() {
      const existing = document.getElementById('activeAdminModalOverlay');
      if (existing) existing.remove();
    }

    function showAdminModal(innerHtml) {
      closeAdminModal();
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.id = 'activeAdminModalOverlay';
      overlay.innerHTML = '<div class="modal-card"><div class="modal-body">' + innerHtml + '</div></div>';
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeAdminModal();
      });
      document.body.appendChild(overlay);
    }

    function showAdminAlert(title, message, isSuccess = false) {
      const icon = isSuccess ? '\u2713' : '\u2715';
      const iconColor = isSuccess ? 'var(--success, #34C759)' : 'var(--danger, #FF3B30)';
      const html =
        '<div class="u-jc-space_between u-ai-flex_start u-mb-12px" style="display:flex;">' +
          '<h3 class="u-m-0 u-fs-v_font_size_lg u-fw-700 u-ai-center u-gap-8px u-c-v_text" style="display:flex;">' +
            '<span style="color:' + iconColor + '; font-weight:bold; font-size:var(--font-size-lg);">' + icon + '</span> ' +
            escapeHtmlAdmin(title) +
          '</h3>' +
          '<button type="button" class="modal-close-x" aria-label="Close" data-act="closeAdminModal">\u2715</button>' +
        '</div>' +
        '<p class="u-m-0_0_18px u-c-v_muted u-fs-v_font_size_base u-lh-1_45 u-ws-pre_wrap">' + escapeHtmlAdmin(message) + '</p>' +
        '<div class="u-jc-flex_end u-gap-8px" style="display:flex;">' +
          '<button type="button" class="lc-btn primary u-minw-80px" data-act="closeAdminModal">OK</button>' +
        '</div>';
      showAdminModal(html);
    }

    function showAdminConfirm(title, message, confirmBtnText, onConfirm, isDanger = true) {
      const icon = isDanger ? '\u26A0' : '?';
      const iconColor = isDanger ? 'var(--danger, #FF3B30)' : 'var(--accent, #007AFF)';
      const btnClass = isDanger ? 'lc-btn danger' : 'lc-btn primary';
      const html =
        '<div class="u-jc-space_between u-ai-flex_start u-mb-12px" style="display:flex;">' +
          '<h3 class="u-m-0 u-fs-v_font_size_lg u-fw-700 u-ai-center u-gap-8px u-c-v_text" style="display:flex;">' +
            '<span style="color:' + iconColor + '; font-weight:bold; font-size:var(--font-size-lg);">' + icon + '</span> ' +
            escapeHtmlAdmin(title) +
          '</h3>' +
          '<button type="button" class="modal-close-x" aria-label="Close" data-act="closeAdminModal">\u2715</button>' +
        '</div>' +
        '<p class="u-m-0_0_18px u-c-v_muted u-fs-v_font_size_base u-lh-1_45 u-ws-pre_wrap">' + escapeHtmlAdmin(message) + '</p>' +
        '<div class="u-jc-flex_end u-gap-10px" style="display:flex;">' +
          '<button type="button" class="lc-btn secondary" data-act="closeAdminModal">Cancel</button>' +
          '<button type="button" class="' + btnClass + '" id="adminConfirmOkBtn">' + escapeHtmlAdmin(confirmBtnText || 'Confirm') + '</button>' +
        '</div>';
      showAdminModal(html);
      document.getElementById('adminConfirmOkBtn')?.addEventListener('click', () => {
        closeAdminModal();
        if (typeof onConfirm === 'function') onConfirm();
      });
    }

    // Optimistic: flips the entry's completed flag (and re-renders,
    // moving the card between the Open/Completed groups) the instant
    // it's clicked, then sends the real change to the server in the
    // background. Rolled back to whatever the server still actually has
    // if that background call fails.
    async function toggleFeedbackStatus(id, completed) {
      const idx = feedbackEntries.findIndex((f) => f.id === id);
      if (idx === -1) return;
      const previousCompleted = feedbackEntries[idx].completed;
      feedbackEntries[idx] = Object.assign({}, feedbackEntries[idx], { completed: completed });
      renderFeedbackList();
      try {
        const res = await fetch('/admin/api/feedback/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id, completed: completed }),
        });
        const data = await res.json().catch(() => null);
        if (!data || !data.ok) {
          const stillIdx = feedbackEntries.findIndex((f) => f.id === id);
          if (stillIdx !== -1) {
            feedbackEntries[stillIdx] = Object.assign({}, feedbackEntries[stillIdx], { completed: previousCompleted });
            renderFeedbackList();
          }
          const err = (data && data.error) || 'Could not update -- try again.';
          showAdminAlert(err === 'Not authorized.' ? 'Not Authorized' : 'Update Failed', err, false);
          return;
        }
      } catch (e) {
        const stillIdx = feedbackEntries.findIndex((f) => f.id === id);
        if (stillIdx !== -1) {
          feedbackEntries[stillIdx] = Object.assign({}, feedbackEntries[stillIdx], { completed: previousCompleted });
          renderFeedbackList();
        }
        showAdminAlert('Connection Error', 'Could not update -- check your connection.', false);
      }
    }

    function openEditFeedbackModal(id) {
      const entry = feedbackEntries.find((f) => f.id === id);
      if (!entry) return;
      document.getElementById('editFeedbackId').value = entry.id;
      document.getElementById('editFeedbackCategory').value = entry.category || 'other';
      document.getElementById('editFeedbackMessage').value = entry.message || '';
      document.getElementById('editFeedbackSaveBtn').disabled = false;
      document.getElementById('editFeedbackSaveBtn').textContent = 'Save Changes';
      document.getElementById('editFeedbackModal').style.display = 'flex';
    }

    function closeEditFeedbackModal() {
      document.getElementById('editFeedbackModal').style.display = 'none';
    }

    async function saveEditFeedback() {
      const id = document.getElementById('editFeedbackId').value;
      const category = document.getElementById('editFeedbackCategory').value;
      const message = document.getElementById('editFeedbackMessage').value.trim();
      const saveBtn = document.getElementById('editFeedbackSaveBtn');
      if (!message) {
        showAdminAlert('Missing Message', 'Please enter a message.', false);
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving\u2026';
      try {
        const res = await fetch('/admin/api/feedback/edit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, category, message }),
        });
        const data = await res.json().catch(() => null);
        if (!data || !data.ok) {
          const err = (data && data.error) || 'Could not save feedback edits.';
          showAdminAlert(err === 'Not authorized.' ? 'Not Authorized' : 'Save Error', err, false);
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save Changes';
          return;
        }
        const idx = feedbackEntries.findIndex((f) => f.id === id);
        if (idx !== -1 && data.entry) {
          feedbackEntries[idx] = data.entry;
          renderFeedbackList();
        }
        closeEditFeedbackModal();
      } catch (err) {
        showAdminAlert('Network Error', 'Network error while saving feedback edits.', false);
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Changes';
      }
    }

    async function copyFeedbackMessage(btn, id) {
      const entry = feedbackEntries.find((f) => f.id === id);
      let text = '';
      if (entry) {
        if (Array.isArray(entry.messages) && entry.messages.length) {
          text = entry.messages.map((m) => m.text).join('\\n\\n');
        } else {
          text = entry.message || '';
        }
      }
      try {
        await navigator.clipboard.writeText(text);
        const prevText = btn.innerHTML;
        btn.innerHTML = '&#x2713; Copied!';
        btn.style.color = '#34C759';
        setTimeout(() => {
          btn.innerHTML = prevText;
          btn.style.color = '';
        }, 1800);
      } catch (e) {
        showAdminAlert('Copy Failed', 'Could not copy message to clipboard.', false);
      }
    }

    async function deleteFeedbackEntry(id) {
      showAdminConfirm('Delete Feedback', 'Permanently delete this feedback entry?', 'Delete', async () => {
        const idx = feedbackEntries.findIndex((f) => f.id === id);
        if (idx === -1) return;
        const removedEntry = feedbackEntries[idx];
        feedbackEntries.splice(idx, 1);
        renderFeedbackList();

        try {
          const res = await fetch('/admin/api/feedback/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id }),
          });
          const data = await res.json().catch(() => null);
          if (!data || !data.ok) {
            feedbackEntries.splice(idx, 0, removedEntry);
            renderFeedbackList();
            const err = (data && data.error) || 'Could not delete feedback entry.';
            showAdminAlert(err === 'Not authorized.' ? 'Not Authorized' : 'Delete Failed', err, false);
          }
        } catch (err) {
          feedbackEntries.splice(idx, 0, removedEntry);
          renderFeedbackList();
          showAdminAlert('Network Error', 'Network error while deleting feedback entry.', false);
        }
      }, true);
    }

    // --- Support Emails Desk ---
    let supportEmailThreads = [];
    let currentSupportThreadId = null;
    let supportEmailFilter = 'all';
    let supportEmailSearchTimeout = null;

    try {
      const savedFilter = localStorage.getItem('myListAddon:supportEmailFilter');
      if (savedFilter && ['all', 'open', 'replied', 'closed'].includes(savedFilter)) {
        supportEmailFilter = savedFilter;
      }
      const savedThread = localStorage.getItem('myListAddon:supportActiveThreadId');
      if (savedThread) {
        currentSupportThreadId = savedThread;
      }
    } catch (e) {}

    function syncSupportEmailFilterUI() {
      const group = document.getElementById('supportEmailFilterGroup');
      if (group) {
        group.querySelectorAll('.subnav-pill').forEach((btn) => {
          const btnStatus = btn.getAttribute('data-status') || btn.textContent.trim().toLowerCase();
          btn.classList.toggle('active', btnStatus === supportEmailFilter);
        });
      }
    }

    async function loadSupportEmailThreads() {
      const listEl = document.getElementById('supportEmailThreadList');
      if (!listEl) return;
      try {
        const savedFilter = localStorage.getItem('myListAddon:supportEmailFilter');
        if (savedFilter && ['all', 'open', 'replied', 'closed'].includes(savedFilter)) {
          supportEmailFilter = savedFilter;
        }
      } catch (e) {}
      syncSupportEmailFilterUI();

      const q = (document.getElementById('supportEmailSearchInput') && document.getElementById('supportEmailSearchInput').value || '').trim();
      const url = '/admin/api/support-emails/threads?status=' + encodeURIComponent(supportEmailFilter) + (q ? '&q=' + encodeURIComponent(q) : '');

      try {
        const res = await fetch(url, { cache: 'no-store' });
        const data = await res.json();
        if (data && data.notConfigured) {
          listEl.innerHTML = '<div class="u-p-12px u-c-v_muted u-fs-v_font_size_sm">' + escapeHtmlAdmin(data.error) + '</div>';
          return;
        }
        if (!data || !data.ok) {
          listEl.innerHTML = '<div class="u-p-12px u-c-v_color_danger_text u-fs-v_font_size_sm">Could not load email threads.</div>';
          return;
        }

        supportEmailThreads = data.threads || [];
        const badge = document.getElementById('supportEmailsBadge');
        if (badge && data.counts) {
          badge.textContent = String(data.counts.open || 0);
          badge.style.display = data.counts.open > 0 ? 'inline-block' : 'none';
        }

        renderSupportEmailThreadList();

        // Restore active thread if it exists in current thread list
        if (currentSupportThreadId && supportEmailThreads.some((t) => t.id === currentSupportThreadId)) {
          selectSupportEmailThread(currentSupportThreadId);
        }
      } catch (err) {
        listEl.innerHTML = '<div class="u-p-12px u-c-v_color_danger_text u-fs-v_font_size_sm">Network error loading emails.</div>';
      }
    }
    window.loadSupportEmailThreads = loadSupportEmailThreads;

    function renderSupportEmailThreadList() {
      const listEl = document.getElementById('supportEmailThreadList');
      if (!listEl) return;
      if (!supportEmailThreads.length) {
        listEl.innerHTML = '<div class="u-p-20px_10px u-ta-center u-c-v_muted u-fs-v_font_size_sm">No support conversations found.</div>';
        return;
      }

      listEl.innerHTML = supportEmailThreads.map((t) => {
        const activeClass = (t.id === currentSupportThreadId) ? ' active' : '';
        const unreadClass = (t.unread > 0) ? ' unread' : '';
        const statusClass = t.status || 'open';
        const dateStr = new Date(t.last_message_at || t.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const sender = t.customer_name ? (t.customer_name + ' &lt;' + t.customer_email + '&gt;') : t.customer_email;

        return '<div class="support-thread-card' + activeClass + unreadClass + '" data-act="selectSupportEmailThread" data-act-args="' + adminActAttr([t.id]) + '">' +
          '<div class="u-jc-space_between u-ai-center u-mb-4px" style="display:flex;">' +
            '<strong class="u-fs-v_font_size_sm u-c-v_text u-to-ellipsis u-ov-hidden u-ws-nowrap" style="max-width:190px;">' + sender + '</strong>' +
            '<span class="admin-badge ' + statusClass + '">' + escapeHtmlAdmin(statusClass) + '</span>' +
          '</div>' +
          '<div class="u-fs-v_font_size_xs u-fw-600 u-c-v_text u-to-ellipsis u-ov-hidden u-ws-nowrap u-mb-4px">' + escapeHtmlAdmin(t.subject || '(No subject)') + '</div>' +
          '<div class="u-fs-v_font_size_xs u-c-v_muted">' + dateStr + (t.unread > 0 ? ' &bull; <strong style="color:var(--accent);">New</strong>' : '') + '</div>' +
        '</div>';
      }).join('');
    }

    function filterSupportEmails(status) {
      supportEmailFilter = status;
      try {
        localStorage.setItem('myListAddon:supportEmailFilter', status);
      } catch (e) {}
      syncSupportEmailFilterUI();
      loadSupportEmailThreads();
    }
    window.filterSupportEmails = filterSupportEmails;

    function onSupportEmailSearchInput() {
      if (supportEmailSearchTimeout) clearTimeout(supportEmailSearchTimeout);
      supportEmailSearchTimeout = setTimeout(() => {
        loadSupportEmailThreads();
      }, 300);
    }
    window.onSupportEmailSearchInput = onSupportEmailSearchInput;

    async function selectSupportEmailThread(threadId) {
      currentSupportThreadId = threadId;
      try {
        localStorage.setItem('myListAddon:supportActiveThreadId', threadId);
      } catch (e) {}
      renderSupportEmailThreadList();

      const emptyBox = document.getElementById('supportEmailEmptyDetail');
      const activeBox = document.getElementById('supportEmailActiveDetail');
      if (emptyBox) emptyBox.style.display = 'none';
      if (activeBox) activeBox.style.display = 'flex';

      const msgContainer = document.getElementById('supportActiveMessageList');
      if (msgContainer) msgContainer.innerHTML = '<div class="u-p-20px u-c-v_muted">Loading message history...</div>';

      try {
        const res = await fetch('/admin/api/support-emails/thread?id=' + encodeURIComponent(threadId), { cache: 'no-store' });
        const data = await res.json();
        if (!data || !data.ok || !data.thread) {
          if (msgContainer) msgContainer.innerHTML = '<div class="u-p-20px u-c-v_color_danger_text">Could not load conversation.</div>';
          return;
        }

        const t = data.thread;
        const messages = data.messages || [];

        // Update active header
        const subjEl = document.getElementById('supportActiveSubject');
        const fromEl = document.getElementById('supportActiveFrom');
        const dateEl = document.getElementById('supportActiveDate');
        const badgeEl = document.getElementById('supportActiveStatusBadge');
        const statusBtn = document.getElementById('supportActiveStatusBtn');

        if (subjEl) subjEl.textContent = t.subject || '(No subject)';
        if (fromEl) fromEl.textContent = (t.customer_name ? (t.customer_name + ' <' + t.customer_email + '>') : t.customer_email);
        if (dateEl) dateEl.textContent = new Date(t.created_at).toLocaleString();
        if (badgeEl) {
          badgeEl.className = 'admin-badge ' + (t.status || 'open');
          badgeEl.textContent = t.status || 'open';
        }
        if (statusBtn) statusBtn.textContent = (t.status === 'closed') ? 'Reopen Thread' : 'Close Thread';

        // Update list unread status locally
        const localIdx = supportEmailThreads.findIndex((it) => it.id === threadId);
        if (localIdx !== -1 && supportEmailThreads[localIdx].unread > 0) {
          supportEmailThreads[localIdx].unread = 0;
          renderSupportEmailThreadList();
        }

        // Render messages
        if (msgContainer) {
          msgContainer.innerHTML = messages.map((m) => {
            const isInbound = (m.direction === 'inbound');
            const senderLabel = isInbound ? (m.from_email || 'Customer') : 'Support Team (support@mylistsaddon.com)';
            const timeStr = new Date(m.created_at).toLocaleString();
            const textContent = m.body_text || (m.body_html ? m.body_html.replace(/<[^>]+>/g, '') : '(Empty message)');

            return '<div class="support-bubble ' + (isInbound ? 'inbound' : 'outbound') + '">' +
              '<div class="u-jc-space_between u-ai-center u-mb-6px u-fs-v_font_size_xs u-c-v_muted" style="display:flex; gap:8px;">' +
                '<strong>' + escapeHtmlAdmin(senderLabel) + '</strong>' +
                '<span>' + timeStr + '</span>' +
              '</div>' +
              '<div class="u-fs-v_font_size_sm u-lh-1_5 u-c-v_text" style="white-space:pre-wrap; word-break:break-word;">' + escapeHtmlAdmin(textContent) + '</div>' +
            '</div>';
          }).join('');
          msgContainer.scrollTop = msgContainer.scrollHeight;
        }
      } catch (err) {
        if (msgContainer) msgContainer.innerHTML = '<div class="u-p-20px u-c-v_color_danger_text">Error loading conversation messages.</div>';
      }
    }
    window.selectSupportEmailThread = selectSupportEmailThread;

    async function sendSupportEmailReplyBtn() {
      if (!currentSupportThreadId) return;
      const textInput = document.getElementById('supportEmailReplyText');
      const statusEl = document.getElementById('supportEmailReplyStatus');
      const closeCheckbox = document.getElementById('supportEmailCloseOnReply');
      const sendBtn = document.getElementById('supportEmailSendReplyBtn');

      const text = textInput ? textInput.value.trim() : '';
      if (!text) {
        if (statusEl) { statusEl.textContent = 'Please enter a reply.'; statusEl.style.color = 'var(--danger)'; }
        return;
      }

      if (sendBtn) sendBtn.disabled = true;
      if (statusEl) { statusEl.textContent = 'Sending...'; statusEl.style.color = 'var(--muted)'; }

      try {
        const res = await fetch('/admin/api/support-emails/reply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            threadId: currentSupportThreadId,
            text: text,
            closeOnSend: closeCheckbox ? closeCheckbox.checked : false,
          }),
        });

        const data = await res.json();
        if (sendBtn) sendBtn.disabled = false;

        if (!data || !data.ok) {
          if (statusEl) { statusEl.textContent = (data && data.error) || 'Failed to send reply.'; statusEl.style.color = 'var(--danger)'; }
          return;
        }

        if (statusEl) { statusEl.textContent = 'Reply sent.'; statusEl.style.color = '#34c759'; }
        if (textInput) textInput.value = '';

        // Reload the thread conversation to display the new message
        await selectSupportEmailThread(currentSupportThreadId);
        await loadSupportEmailThreads();
      } catch (err) {
        if (sendBtn) sendBtn.disabled = false;
        if (statusEl) { statusEl.textContent = 'Network error while sending.'; statusEl.style.color = 'var(--danger)'; }
      }
    }
    window.sendSupportEmailReplyBtn = sendSupportEmailReplyBtn;

    async function changeSupportThreadStatus() {
      if (!currentSupportThreadId) return;
      const thread = supportEmailThreads.find((t) => t.id === currentSupportThreadId);
      const nextStatus = (thread && thread.status === 'closed') ? 'open' : 'closed';

      try {
        const res = await fetch('/admin/api/support-emails/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threadId: currentSupportThreadId, status: nextStatus }),
        });
        const data = await res.json();
        if (data && data.ok) {
          if (thread) thread.status = nextStatus;
          const badgeEl = document.getElementById('supportActiveStatusBadge');
          const statusBtn = document.getElementById('supportActiveStatusBtn');
          if (badgeEl) {
            badgeEl.className = 'admin-badge ' + nextStatus;
            badgeEl.textContent = nextStatus;
          }
          if (statusBtn) statusBtn.textContent = (nextStatus === 'closed') ? 'Reopen Thread' : 'Close Thread';
          renderSupportEmailThreadList();
        }
      } catch (err) {
        showAdminAlert('Status Error', 'Could not update thread status.', false);
      }
    }
    window.changeSupportThreadStatus = changeSupportThreadStatus;

    function deleteSupportEmailThread() {
      if (!currentSupportThreadId) return;
      showAdminConfirm('Delete Conversation', 'Permanently delete this email thread and all messages in it?', 'Delete', async () => {
        try {
          const res = await fetch('/admin/api/support-emails/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ threadId: currentSupportThreadId }),
          });
          const data = await res.json();
          if (data && data.ok) {
            supportEmailThreads = supportEmailThreads.filter((t) => t.id !== currentSupportThreadId);
            currentSupportThreadId = null;
            try {
              localStorage.removeItem('myListAddon:supportActiveThreadId');
            } catch (e) {}
            const emptyBox = document.getElementById('supportEmailEmptyDetail');
            const activeBox = document.getElementById('supportEmailActiveDetail');
            if (emptyBox) emptyBox.style.display = 'block';
            if (activeBox) activeBox.style.display = 'none';
            renderSupportEmailThreadList();
          } else {
            showAdminAlert('Delete Failed', (data && data.error) || 'Could not delete conversation.', false);
          }
        } catch (err) {
          showAdminAlert('Network Error', 'Error deleting conversation.', false);
        }
      }, true);
    }
    window.deleteSupportEmailThread = deleteSupportEmailThread;

    function openComposeEmailModal() {
      const modal = document.getElementById('composeEmailModal');
      const statusEl = document.getElementById('composeEmailStatus');
      if (statusEl) statusEl.textContent = '';
      if (modal) modal.style.display = 'flex';
    }
    window.openComposeEmailModal = openComposeEmailModal;

    function closeComposeEmailModal() {
      const modal = document.getElementById('composeEmailModal');
      if (modal) modal.style.display = 'none';
    }
    window.closeComposeEmailModal = closeComposeEmailModal;

    async function sendComposedEmailBtn() {
      const toInput = document.getElementById('composeEmailTo');
      const nameInput = document.getElementById('composeEmailName');
      const subjInput = document.getElementById('composeEmailSubject');
      const bodyInput = document.getElementById('composeEmailBody');
      const statusEl = document.getElementById('composeEmailStatus');
      const sendBtn = document.getElementById('composeEmailSendBtn');

      const to = toInput ? toInput.value.trim() : '';
      const name = nameInput ? nameInput.value.trim() : '';
      const subject = subjInput ? subjInput.value.trim() : '';
      const body = bodyInput ? bodyInput.value.trim() : '';

      if (!to || !to.includes('@')) {
        if (statusEl) { statusEl.textContent = 'Valid email is required.'; statusEl.style.color = 'var(--danger)'; }
        return;
      }
      if (!subject) {
        if (statusEl) { statusEl.textContent = 'Subject is required.'; statusEl.style.color = 'var(--danger)'; }
        return;
      }
      if (!body) {
        if (statusEl) { statusEl.textContent = 'Message body is required.'; statusEl.style.color = 'var(--danger)'; }
        return;
      }

      if (sendBtn) sendBtn.disabled = true;
      if (statusEl) { statusEl.textContent = 'Sending...'; statusEl.style.color = 'var(--muted)'; }

      try {
        const res = await fetch('/admin/api/support-emails/compose', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            toEmail: to,
            customerName: name,
            subject: subject,
            text: body,
          }),
        });
        const data = await res.json();
        if (sendBtn) sendBtn.disabled = false;

        if (!data || !data.ok) {
          if (statusEl) { statusEl.textContent = (data && data.error) || 'Failed to send.'; statusEl.style.color = 'var(--danger)'; }
          return;
        }

        closeComposeEmailModal();
        if (toInput) toInput.value = '';
        if (nameInput) nameInput.value = '';
        if (subjInput) subjInput.value = '';
        if (bodyInput) bodyInput.value = '';

        await loadSupportEmailThreads();
        if (data.thread && data.thread.id) {
          await selectSupportEmailThread(data.thread.id);
        }
      } catch (err) {
        if (sendBtn) sendBtn.disabled = false;
        if (statusEl) { statusEl.textContent = 'Network error while sending.'; statusEl.style.color = 'var(--danger)'; }
      }
    }
    window.sendComposedEmailBtn = sendComposedEmailBtn;
  </script>
</body></html>`;
}

// generateShortId() always produces a 12-character id; legacy base64
// configs are virtually always much longer than that (even a single list's
// JSON encodes to well over 100 characters), so length alone reliably
// tells the two apart without needing a prefix.
