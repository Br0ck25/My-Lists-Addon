import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const { makeEnv, makeD1, makeKv, call, authCookieFor } = await import("./harness.mjs");

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function loadSourceFunctions(...relFiles) {
  const sandbox = {
    console, URL, URLSearchParams, atob, btoa, Uint8Array, TextDecoder, TextEncoder,
    Response, Headers, Request,
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
const { bumpStat, bumpStatBy, recordSearchQuery, recordTrackedEvent, computeLeaderboard, backfillTitleDailyStatsFromStats } = adminFns;

describe("P8-2: Analytics Engine Stat Counters & Zero D1 Writes on Pageviews", () => {
  it("bumpStat writes to Analytics Engine and makes 0 D1 writes when ANALYTICS is bound", async () => {
    const points = [];
    const db = makeD1();
    const env = makeEnv({
      CONFIGS: makeKv(),
      DB: db,
      ANALYTICS: { writeDataPoint: (p) => points.push(p) },
    });

    // Call pageview on public root
    const res = await call(env, "/");
    assert.equal(res.status, 200);

    // Verify Analytics Engine received the stat point
    const statPoint = points.find((p) => p.blobs && p.blobs[0] === "stat" && p.blobs[1] === "pageviews");
    assert.ok(statPoint, "expected stat:pageviews in Analytics Engine");
    assert.equal(statPoint.doubles[0], 1);
    assert.equal(statPoint.indexes[0], "pageviews");

    // Verify D1 stats table was NOT written to
    const d1Stats = db._stat("pageviews", "total") || 0;
    assert.equal(d1Stats, 0, "D1 stats must have 0 writes when ANALYTICS is active");
  });

  it("bumpStatBy writes to Analytics Engine with custom amount", async () => {
    const points = [];
    const db = makeD1();
    const env = makeEnv({
      CONFIGS: makeKv(),
      DB: db,
      ANALYTICS: { writeDataPoint: (p) => points.push(p) },
    });

    await bumpStatBy(env, "apiuse:tmdb", 5);

    const statPoint = points.find((p) => p.blobs && p.blobs[0] === "stat" && p.blobs[1] === "apiuse:tmdb");
    assert.ok(statPoint, "expected apiuse:tmdb stat point");
    assert.equal(statPoint.doubles[0], 5);
    assert.equal(db._stat("apiuse:tmdb", "total") || 0, 0, "D1 stats table must not receive apiuse write");
  });

  it("recordSearchQuery writes to Analytics Engine without D1 writes", async () => {
    const points = [];
    const db = makeD1();
    const env = makeEnv({
      CONFIGS: makeKv(),
      DB: db,
      ANALYTICS: { writeDataPoint: (p) => points.push(p) },
    });

    await recordSearchQuery(env, "inception");

    const searchPoint = points.find((p) => p.blobs && p.blobs[0] === "search" && p.blobs[1] === "inception");
    assert.ok(searchPoint, "expected search query point in Analytics Engine");
    assert.equal(searchPoint.doubles[0], 1);
    assert.equal(db._stat("searchq:inception", "total") || 0, 0, "D1 search stats must not be written");
  });

  it("recordTrackedEvent writes to Analytics Engine without D1 writes", async () => {
    const points = [];
    const db = makeD1();
    const env = makeEnv({
      CONFIGS: makeKv(),
      DB: db,
      ANALYTICS: { writeDataPoint: (p) => points.push(p) },
    });

    const res = await call(env, "/api/track-event", {
      method: "POST",
      json: {
        events: [
          { eventType: "watched", id: "tt0137523", title: "Fight Club", mediaType: "movie" },
        ],
      },
    });
    assert.equal(res.status, 200);

    const eventPoint = points.find((p) => p.blobs && p.blobs[0] === "event" && p.blobs[1] === "watched");
    assert.ok(eventPoint, "expected event:watched point in Analytics Engine");
    assert.equal(eventPoint.blobs[2], "tt0137523");
    assert.equal(eventPoint.blobs[3], "Fight Club");
    assert.equal(db._stat("evt:watched:tt0137523", "total") || 0, 0, "D1 stats table must not receive tracked event write");
  });

  it("gracefully falls back to D1 when ANALYTICS is not bound", async () => {
    const db = makeD1();
    const env = makeEnv({
      CONFIGS: makeKv(),
      DB: db,
      // No ANALYTICS binding
    });

    await bumpStat(env, "pageviews");
    await recordSearchQuery(env, "matrix");

    assert.equal(db._stat("pageviews", "total"), 1, "D1 receives pageviews fallback write");
    assert.equal(db._stat("searchq:matrix", "total"), 1, "D1 receives search query fallback write");
  });

  it("Most Watched reads from title_daily_stats when populated", async () => {
    const db = makeD1();
    const env = makeEnv({ CONFIGS: makeKv(), DB: db });

    const now = Date.now();
    // Seed media table
    await db.prepare("INSERT INTO media (id, kind, imdb_id, tmdb_id, title, created_at, updated_at) VALUES (1, 'movie', 'tt0001001', 1001, 'Title Daily Hit', ?, ?)").bind(now, now).run();
    await db.prepare("INSERT INTO media (id, kind, imdb_id, tmdb_id, title, created_at, updated_at) VALUES (2, 'movie', 'tt0001002', 1002, 'Second Hit', ?, ?)").bind(now, now).run();

    // Seed title_daily_stats
    const today = adminFns.easternDateKey(new Date());
    await db.prepare("INSERT INTO title_daily_stats (day, event_type, media_id, n) VALUES (?, 'play', 1, 50)").bind(today).run();
    await db.prepare("INSERT INTO title_daily_stats (day, event_type, media_id, n) VALUES (?, 'play', 2, 20)").bind(today).run();

    const leaderboard = await computeLeaderboard(env, "watched", "today", "movie");

    assert.ok(leaderboard.length >= 2);
    assert.equal(leaderboard[0].id, "tt0001001");
    assert.equal(leaderboard[0].count, 50);
    assert.equal(leaderboard[1].id, "tt0001002");
    assert.equal(leaderboard[1].count, 20);
  });

  it("backfills title_daily_stats from legacy stats table via admin endpoint", async () => {
    const db = makeD1();
    const env = makeEnv({ CONFIGS: makeKv(), DB: db, ADMIN_KEY: "secret" });

    const now = Date.now();
    // Seed legacy stats and media
    await db.prepare("INSERT INTO media (id, kind, imdb_id, tmdb_id, title, created_at, updated_at) VALUES (10, 'movie', 'tt9999001', 9999001, 'Legacy Watched Film', ?, ?)").bind(now, now).run();
    await db.prepare("INSERT INTO stats (kind, day, n) VALUES ('evt:watched:tt9999001', '2026-09-15', 42)").run();

    const login = await call(env, "/admin/login", { method: "POST", form: { key: "secret" } });
    assert.equal(login.status, 302);
    const m = (login.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/);
    const cookie = m ? m[1] : "";

    const res = await call(env, "/admin/api/backfill-title-daily-stats", {
      method: "POST",
      cookie,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(res.body.rowsWritten >= 1);

    // Verify row landed in title_daily_stats
    const row = await db.prepare("SELECT * FROM title_daily_stats WHERE media_id = 10 AND day = '2026-09-15'").first();
    assert.ok(row, "expected backfilled row in title_daily_stats");
    assert.equal(row.n, 42);
    assert.equal(row.event_type, "watched");
  });
});
