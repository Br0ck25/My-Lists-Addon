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
// P8-2 code wrote them.
function fakeAnalyticsEngine(points) {
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input && input.url ? input.url : input);
    if (!url.includes("/analytics_engine/sql")) return realFetch(input, init);
    const sql = String(init && init.body);
    asked.push({ sql, auth: init.headers.Authorization });
    const group = new Map();
    const add = (kind, day, n) => {
      const k = kind + "|" + day;
      group.set(k, { kind, day, n: (group.get(k) ? group.get(k).n : 0) + n });
    };
    for (const p of points) {
      if (sql.includes("blob1 = 'stat'") && p.blobs[0] === "stat") add(p.blobs[1], p.blobs[2], p.doubles[0]);
      if (sql.includes("blob1 = 'event'") && p.blobs[0] === "event") add(`evt:${p.blobs[1]}:${p.blobs[2]}`, p.day, p.doubles[0]);
      if (sql.includes("blob1 = 'search'") && p.blobs[0] === "search") add(`searchq:${p.blobs[1]}`, p.blobs[2], p.doubles[0]);
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
  { blobs: ["event", "watched", "tt0137523", "Fight Club", "movie"], doubles: [4], day: "2026-10-03" },
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
    assert.match(asked[1].sql, /formatDateTime\(timestamp, '%Y-%m-%d', 'America\/New_York'\)/, "a watch counts on its Eastern day");
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
    assert.equal(db._stat("evt:watched:tt0137523", "2026-10-03"), 4);
    assert.equal(db._stat("searchq:dune", "total"), 2);

    // Again: nothing is added twice.
    const again = await recover(env, cookie, true);
    assert.equal(again.body.toPutBack, 0);
    assert.equal(again.body.alreadyPutBack, again.body.rows);
    assert.equal(db._stat("pageviews", "total"), 12388 + 123);
    assert.equal(db._stat("evt:watched:tt0137523", "total"), 4);
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
