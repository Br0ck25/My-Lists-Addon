// Counters are written to D1, which is where everything reads them.
//
// P8-2 (2026-10-02) sent page views, install links, playback pings, tracked
// events (Most Watched, list adds) and searches to Analytics Engine INSTEAD of
// D1 whenever ANALYTICS was bound -- and it is bound on the live site. Nothing
// reads Analytics Engine, so the admin dashboard showed zeros from that day and
// Most Watched stopped moving. These pin the counters on D1.
import { describe, it } from "node:test";
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

async function adminCookie(env) {
  const login = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
  return ((login.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/) || [])[1];
}

describe("the admin page names the build", () => {
  it("shows the build that is live, and the day it was built", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
    const page = await call(env, "/admin", { cookie: await adminCookie(env) });
    assert.equal(page.status, 200);
    assert.match(page.text, /<span id="workerRelease">Built \d{4}-\d{2}-\d{2}<\/span> <span id="workerBuild">\(build [0-9a-f]{10}\)<\/span>/);
  });
});
