// Counters are written to D1, which is where everything reads them.
//
// P8-2 (2026-10-02) sent page views, install links, playback pings, tracked
// events (Most Watched, list adds) and searches to Analytics Engine INSTEAD of
// D1 whenever ANALYTICS was bound -- and it is bound on the live site. Nothing
// reads Analytics Engine, so the admin dashboard showed zeros from that day and
// Most Watched stopped moving. These pin the counters back on D1, and cover the
// one-time tool that puts the missing days back from Analytics Engine
// (recoverStatsFromAnalyticsEngine, 03_admin.js).
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const { makeEnv, makeD1, makeKv, call } = await import("./harness.mjs");

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function loadSourceFunctions(...relFiles) {
  const sandbox = {
    console, URL, URLSearchParams, atob, btoa, Uint8Array, TextDecoder, TextEncoder,
    Response, Headers, Request, Intl, Date,
    crypto: globalThis.crypto,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const relFile of relFiles) {
    const src = fs.readFileSync(path.join(REPO_ROOT, relFile), "utf8");
    vm.runInContext(src, sandbox, { filename: relFile });
  }
  return sandbox;
}

const adminFns = loadSourceFunctions("00_constants.js", "01_icon-asset.js", "02_http-and-creator-utils.js", "03_admin.js");
const { bumpStatBy, recordSearchQuery, computeLeaderboard } = adminFns;
// A top-level const is not a property of the sandbox; read it from its scope.
const WORKER_RELEASE = vm.runInContext("WORKER_RELEASE", adminFns);

const analyticsBound = (points) => ({ writeDataPoint: (p) => points.push(p) });

describe("counters are written to D1 even with Analytics Engine bound", () => {
  it("a page view counts in D1, and the admin dashboard reads it", async () => {
    const points = [];
    const db = makeD1();
    const env = makeEnv({ CONFIGS: makeKv(), DB: db, ANALYTICS: analyticsBound(points) });

    const res = await call(env, "/");
    assert.equal(res.status, 200);
    assert.equal(db._stat("pageviews", "total"), 1, "the dashboard's Total page views");
    assert.equal(db._stat("pageviews", adminFns.statsToday()), 1, "and today's");
    assert.equal(points.filter((p) => p.blobs && p.blobs[0] === "stat").length, 0, "no stat copy in Analytics Engine");
  });

  it("an amount (API use) is added to its total in D1", async () => {
    const db = makeD1();
    const env = makeEnv({ CONFIGS: makeKv(), DB: db, ANALYTICS: analyticsBound([]) });
    await bumpStatBy(env, "apiuse:tmdb", 5);
    assert.equal(db._stat("apiuse:tmdb", "total"), 5);
  });

  it("a search is counted in D1, whatever language it is in", async () => {
    const db = makeD1();
    const env = makeEnv({ CONFIGS: makeKv(), DB: db, ANALYTICS: analyticsBound([]) });
    await recordSearchQuery(env, "inception");
    const long = "千と千尋の神隠し".repeat(6);
    await recordSearchQuery(env, long);
    assert.equal(db._stat("searchq:inception", "total"), 1);
    assert.equal(db._stat("searchq:" + long.toLowerCase().slice(0, 60), "total"), 1);
  });

  it("a watch counts toward Most Watched, today included", async () => {
    const db = makeD1();
    const env = makeEnv({ CONFIGS: makeKv(), DB: db, ANALYTICS: analyticsBound([]) });
    const res = await call(env, "/api/track-event", {
      method: "POST",
      json: { events: [{ eventType: "watched", id: "tt0137523", title: "Fight Club", mediaType: "movie" }] },
    });
    assert.equal(res.status, 200);
    assert.equal(db._stat("evt:watched:tt0137523", "total"), 1);

    const today = await computeLeaderboard(env, "watched", "today", "movie");
    assert.equal(today[0] && today[0].id, "tt0137523");
    assert.equal(today[0].count, 1);
  });

  it("Most Watched does not switch to title_daily_stats once it has rows", async () => {
    // title_daily_stats holds only the plays of accounts on event tracking,
    // by UTC day, up to yesterday. Reading it instead dropped every other
    // watch, and today's.
    const db = makeD1();
    const env = makeEnv({ CONFIGS: makeKv(), DB: db });
    const now = Date.now();
    await db.prepare("INSERT INTO media (id, kind, imdb_id, tmdb_id, title, created_at, updated_at) VALUES (1, 'movie', 'tt0001001', 1001, 'Rollup Only', ?, ?)").bind(now, now).run();
    await db.prepare("INSERT INTO title_daily_stats (day, event_type, media_id, n) VALUES (?, 'play', 1, 50)").bind(adminFns.statsToday()).run();
    await call(env, "/api/track-event", { method: "POST", json: { events: [{ eventType: "watched", id: "tt0137523", title: "Fight Club", mediaType: "movie" }] } });

    const board = await computeLeaderboard(env, "watched", "7", "movie");
    assert.deepEqual(board.map((e) => e.id), ["tt0137523"]);
  });
});

// --- Putting the missing days back ----------------------------------------------

let restoreFetch = null;
afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

// The Analytics Engine SQL API, answering from points written the way the
// P8-2 code wrote them. It refuses what the real one refused on the live site,
// with the same 422s -- both were accepted by this fake at first:
//  - a function its SQL reference does not list ("unknown function call:
//    CONCAT");
//  - anything in GROUP BY but a column or a name given with AS ("in the GROUP
//    BY clause you may only provide column names: formatDateTime(...)").
const AE_FUNCTIONS = new Set([
  // developers.cloudflare.com/analytics/analytics-engine/sql-reference/
  // (aggregate, string, and date and time functions), lower-cased.
  "count", "sum", "avg", "min", "max", "quantileweighted", "quantileexactweighted",
  "length", "empty", "lower", "lowerutf8", "upper", "upperutf8", "startswith", "endswith", "position", "substring", "format", "extract",
  "now", "today", "todatetime", "tounixtimestamp", "formatdatetime", "tostartofinterval", "tostartofday", "toyear", "tomonth",
  "todayofweek", "todayofmonth", "tohour", "tominute", "tosecond", "tostartofyear", "tostartofmonth", "tostartofweek", "tostartofhour",
  "tostartoffifteenminutes", "tostartoftenminutes", "tostartoffiveminutes", "tostartofminute", "toyyyymm",
]);
const SQL_WORDS = new Set(["in", "and", "or", "not", "as", "from", "where", "select", "by", "on"]);

function fakeAnalyticsEngine(points) {
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input && input.url ? input.url : input);
    if (!url.includes("/analytics_engine/sql")) return realFetch(input, init);
    const sql = String(init && init.body);
    asked.push({ sql, auth: init.headers.Authorization });
    const withoutStrings = sql.replace(/'[^']*'/g, "''");
    for (const m of withoutStrings.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      const fn = m[1].toLowerCase();
      if (SQL_WORDS.has(fn)) continue;
      if (!AE_FUNCTIONS.has(fn)) {
        return new Response(`Input was invalid: unknown function call: ${m[1].toUpperCase()}`, { status: 422 });
      }
    }
    const groupBy = (sql.match(/ GROUP BY (.*?)(?: ORDER BY | LIMIT | FORMAT |$)/) || [])[1] || "";
    const aliases = new Set([...sql.matchAll(/ AS ([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]));
    for (const item of groupBy.split(",").map((x) => x.trim()).filter(Boolean)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(item)) {
        return new Response(`Input was invalid: in the GROUP BY clause you may only provide column names: ${item}`, { status: 422 });
      }
      if (!/^(blob\d+|double\d+|index1|timestamp)$/.test(item) && !aliases.has(item)) {
        return new Response(`Input was invalid: unknown column ${item}`, { status: 422 });
      }
    }
    assert.match(sql, /FORMAT JSON$/);
    const eventHours = /blob1 = 'event'/.test(sql);
    const want = (sql.match(/blob1 = '(\w+)'/) || [])[1];
    const group = new Map();
    for (const p of points) {
      if (p.blobs[0] !== want) continue;
      // toUnixTimestamp(toStartOfHour(timestamp)); sent as a string, as JSON
      // output may quote integers.
      const row = eventHours
        ? { blob2: p.blobs[1], blob3: p.blobs[2], event_hour: String(Math.floor(p.at / 3600000) * 3600) }
        : { blob2: p.blobs[1], blob3: p.blobs[2] };
      const k = JSON.stringify(row);
      group.set(k, { ...row, n: (group.get(k) ? group.get(k).n : 0) + p.doubles[0] });
    }
    return new Response(JSON.stringify({ meta: [], data: [...group.values()], rows: group.size }), { status: 200 });
  };
  restoreFetch = () => { globalThis.fetch = realFetch; };
  return asked;
}

async function adminCookie(env) {
  const login = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
  return ((login.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/) || [])[1];
}

const GAP_POINTS = [
  { blobs: ["stat", "pageviews", "2026-10-02"], doubles: [3] },
  { blobs: ["stat", "pageviews", "2026-10-03"], doubles: [120] },
  { blobs: ["stat", "installs", "2026-10-03"], doubles: [9] },
  { blobs: ["stat", "apiuse:tmdb", "total"], doubles: [40] },
  { blobs: ["stat", "sourcegroup:trakt", "total"], doubles: [2] },
  // Watched at noon and at 10:30 pm Eastern on 3 October (02:30 UTC on the 4th).
  { blobs: ["event", "watched", "tt0137523", "Fight Club", "movie"], doubles: [3], at: Date.parse("2026-10-03T16:05:00Z") },
  { blobs: ["event", "watched", "tt0137523", "Fight Club", "movie"], doubles: [1], at: Date.parse("2026-10-04T02:30:00Z") },
  { blobs: ["search", "dune", "2026-10-03"], doubles: [2] },
];

describe("putting back the counts Analytics Engine took (2 October onward)", () => {
  async function setup() {
    const db = makeD1();
    const env = makeEnv({ CONFIGS: makeKv(), DB: db, CF_ANALYTICS_TOKEN: "ae-token", CF_ANALYTICS_ACCOUNT_ID: "acc123" });
    // What D1 already had before the gap.
    await db.prepare("INSERT INTO stats (kind, day, n) VALUES ('pageviews', 'total', 12388), ('installs', 'total', 1165), ('apiuse:tmdb', 'total', 1000)").run();
    return { db, env, cookie: await adminCookie(env) };
  }
  const recover = (env, cookie, apply) => call(env, "/admin/api/recover-stats-from-analytics", { method: "POST", cookie, json: { apply } });

  it("previews what it would put back, and writes nothing", async () => {
    const asked = fakeAnalyticsEngine(GAP_POINTS);
    const { db, env, cookie } = await setup();
    const r = await recover(env, cookie, false);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.applied, false);
    assert.equal(r.body.totals.stat, 3 + 120 + 9 + 40, "source groups were never lost");
    assert.equal(r.body.totals.event, 4);
    assert.equal(r.body.totals.search, 2);
    assert.equal(db._stat("pageviews", "total"), 12388);
    assert.equal(asked[0].auth, "Bearer ae-token");
    assert.match(asked[0].sql, /FROM mylists_events/);
    assert.match(asked[1].sql, /toUnixTimestamp\(toStartOfHour\(timestamp\)\) AS event_hour/, "events by the hour");
    for (const { sql } of asked) assert.match(sql, / GROUP BY [a-z0-9_]+(, [a-z0-9_]+)* LIMIT /, "GROUP BY names columns only");
  });

  it("puts every counter back on its day and in its total, once", async () => {
    fakeAnalyticsEngine(GAP_POINTS);
    const { db, env, cookie } = await setup();
    const r = await recover(env, cookie, true);
    assert.equal(r.body.applied, true, JSON.stringify(r.body));
    assert.equal(db._stat("pageviews", "total"), 12388 + 123);
    assert.equal(db._stat("pageviews", "2026-10-03"), 120);
    assert.equal(db._stat("installs", "2026-10-03"), 9);
    assert.equal(db._stat("apiuse:tmdb", "total"), 1040);
    assert.equal(db._stat("evt:watched:tt0137523", "2026-10-03"), 4, "10:30 pm Eastern is still the 3rd");
    assert.equal(db._stat("evt:watched:tt0137523", "2026-10-04"), undefined, "nothing on the 4th");
    assert.equal(db._stat("searchq:dune", "total"), 2);

    // Again: nothing is added twice.
    const again = await recover(env, cookie, true);
    assert.equal(again.body.toPutBack, 0);
    assert.equal(again.body.alreadyPutBack, again.body.rows);
    assert.equal(db._stat("pageviews", "total"), 12388 + 123);
    assert.equal(db._stat("evt:watched:tt0137523", "total"), 4);
  });

  it("asks Analytics Engine only with functions it has, and reports a refusal", async () => {
    const asked = fakeAnalyticsEngine(GAP_POINTS);
    const { env, cookie } = await setup();
    const r = await recover(env, cookie, false);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(asked.length, 3);
    for (const { sql } of asked) assert.doesNotMatch(sql, /concat/i);

    // And when the service refuses a query, the page is told why.
    restoreFetch();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (String(input).includes("/analytics_engine/sql")) return new Response("Input was invalid: unknown function call: CONCAT", { status: 422 });
      return realFetch(input, init);
    };
    restoreFetch = () => { globalThis.fetch = realFetch; };
    const refused = await recover(env, cookie, false);
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /^Reading page views and other counters: Analytics Engine answered 422/, "which query was refused");
    assert.equal(refused.body.release, WORKER_RELEASE, "and which release asked");
  });

  it("the admin page names the release that is live", async () => {
    const { env, cookie } = await setup();
    const page = await call(env, "/admin", { cookie });
    assert.equal(page.status, 200);
    assert.match(WORKER_RELEASE, /^\d+[a-z]?$/);
    assert.ok(page.text.includes(`<span id="workerRelease">Release ${WORKER_RELEASE}</span>`));
  });

  it("says what is missing instead of guessing without the API token", async () => {
    const db = makeD1();
    const env = makeEnv({ CONFIGS: makeKv(), DB: db });
    const r = await recover(env, await adminCookie(env), false);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /CF_ANALYTICS_TOKEN/);
  });

  it("is for an admin only", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    const r = await call(env, "/admin/api/recover-stats-from-analytics", { method: "POST", json: { apply: true } });
    assert.equal(r.status, 401);
  });
});
