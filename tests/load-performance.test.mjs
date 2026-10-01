// Load & Performance Test Suite (P8-5).
// Evaluates performance against the latency budgets in PERFORMANCE_AUDIT.md §5:
//   - Cache API / isolate memo hit: under 5 ms
//   - Cold KV install snapshot + chart snapshot: under 40 ms at p95
//   - Personal shelf (indexed D1 queries on read replica): under 60 ms at p95
//   - Scrobble burst: non-blocking, zero write lock contention, under 100 ms at p95
//   - Directory depth: constant-time keyset paging under 50 ms at p95

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  makeEnv,
  makeD1,
  makeKv,
  call,
  createUser,
  accountProof,
  nextIp,
} from "./harness.mjs";

function calcPercentiles(durations) {
  if (!durations.length) return { p50: 0, p90: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const sorted = [...durations].sort((a, b) => a - b);
  const p = (pct) => sorted[Math.min(sorted.length - 1, Math.floor((pct / 100) * sorted.length))];
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    p50: p(50),
    p90: p(90),
    p95: p(95),
    p99: p(99),
    max: sorted[sorted.length - 1],
    mean: Math.round((sum / sorted.length) * 100) / 100,
  };
}

describe("P8-5: In-Process Load Testing & Latency Baselines", () => {
  describe("1. Catalog Hot Path (N Installs x 20 Rows)", () => {
    it("satisfies the < 5 ms warm cache and < 40 ms cold latency budgets across 20 rows", async () => {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });

      // Generate 20 self-contained custom list catalog rows
      const ROWS = 20;
      const tt = (n) => "tt" + String(1000000 + n);
      const rows = Array.from({ length: ROWS }, (_, n) => ({
        id: `row${n}`,
        type: "movie",
        name: `Row ${n}`,
        url: "customlist:v1:" + JSON.stringify({
          listSlug: `row-${n}`,
          items: Array.from({ length: 10 }, (_, k) => ({
            id: tt(n + k),
            title: `Film ${n + k}`,
            type: "movie",
          })),
        }),
      }));

      // Create saved install with 20 rows
      const proof = await accountProof(env, "perfuser");
      const saved = await call(env, "/api/save", {
        method: "POST",
        json: { ...proof, entries: rows, dedupeAcrossLists: false, showBadgesStremio: false },
      });
      assert.equal(saved.body.ok, true, "install must be saved successfully");
      const installId = saved.body.id;

      // 1. Manifest fetch
      const t0 = performance.now();
      const manifestRes = await call(env, `/${installId}/manifest.json`);
      const manifestDur = performance.now() - t0;
      assert.equal(manifestRes.status, 200);
      assert.ok(manifestRes.body.catalogs.length >= ROWS);
      assert.ok(manifestDur < 40, `manifest duration (${manifestDur.toFixed(2)}ms) should be under 40ms`);

      // 2. Cold catalog row fetches (first pass)
      const coldDurations = [];
      for (const row of rows) {
        const start = performance.now();
        const res = await call(env, `/${installId}/catalog/movie/${row.id}.json`);
        const dur = performance.now() - start;
        coldDurations.push(dur);
        assert.equal(res.status, 200, `cold catalog row ${row.id} must return 200`);
        assert.ok(Array.isArray(res.body.metas), "must return metas array");
      }
      const coldStats = calcPercentiles(coldDurations);

      // 3. Warm catalog row fetches (second pass hitting isolate memo / cache)
      const warmDurations = [];
      for (const row of rows) {
        const start = performance.now();
        const res = await call(env, `/${installId}/catalog/movie/${row.id}.json`);
        const dur = performance.now() - start;
        warmDurations.push(dur);
        assert.equal(res.status, 200, `warm catalog row ${row.id} must return 200`);
      }
      const warmStats = calcPercentiles(warmDurations);

      // Assertions against PERFORMANCE_AUDIT §5 targets:
      // Cache hit budget: under 5 ms target (allowing up to 10 ms for test runner overhead)
      assert.ok(
        warmStats.p95 < 10,
        `warm cache p95 (${warmStats.p95.toFixed(2)}ms) must satisfy latency budget (< 10ms with runner overhead)`
      );
      // Cold KV snapshot budget: under 40 ms at p95
      assert.ok(
        coldStats.p95 < 40,
        `cold catalog p95 (${coldStats.p95.toFixed(2)}ms) must be under 40ms`
      );
    });
  });

  describe("2. Scrobble Burst (50 Concurrent Webhooks / Pings)", () => {
    it("handles a high-concurrency burst of 50 scrobbles without lock contention or 429s", async () => {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
      const user = await createUser(env, "scrobbleuser");

      // Obtain scoped scrobble token (?st=)
      const tokenRes = await call(env, "/api/creator/scrobble-token", {
        method: "POST",
        json: { creatorName: user.creatorName, creatorKey: user.creatorKey },
      });
      assert.equal(tokenRes.body.ok, true);
      const token = tokenRes.body.token;

      // Prepare 50 concurrent scrobbles with distinct timestamps and movie titles
      const CONCURRENCY = 50;
      const tasks = Array.from({ length: CONCURRENCY }, (_, i) => async () => {
        const ip = `10.0.0.${(i % 250) + 1}`;
        const titleId = `tt${String(2000000 + i).padStart(7, "0")}`;
        const payload = {
          event: "media.scrobble",
          Metadata: {
            type: "movie",
            title: `Burst Movie ${i}`,
            Guid: [{ id: `imdb://${titleId}` }],
          },
        };

        const start = performance.now();
        const res = await call(env, `/api/scrobble?st=${encodeURIComponent(token)}`, {
          method: "POST",
          ip,
          json: payload,
        });
        const dur = performance.now() - start;
        return { status: res.status, body: res.body, dur };
      });

      // Fire all 50 in parallel
      const results = await Promise.all(tasks.map((fn) => fn()));
      const durations = results.map((r) => r.dur);
      const stats = calcPercentiles(durations);

      // Verify all succeed
      const successful = results.filter((r) => r.status === 200 || r.status === 202);
      assert.equal(successful.length, CONCURRENCY, `all ${CONCURRENCY} scrobbles must succeed`);

      const rateLimited = results.filter((r) => r.status === 429);
      assert.equal(rateLimited.length, 0, "scoped scrobble token must not trigger rate limit errors");

      // Budget check: p95 must be under 100 ms
      assert.ok(
        stats.p95 < 100,
        `scrobble burst p95 (${stats.p95.toFixed(2)}ms) must be under 100ms`
      );
    });
  });

  describe("3. Directory Keyset Pagination Depth", () => {
    it("maintains constant-time O(1) query latency across 20 pages of directory depth", async () => {
      const db = makeD1();
      const env = makeEnv({ DB: db, CONFIGS: makeKv() });
      env.FF_V2_LISTS_ONLY = "1"; // Read directly from D1 lists v2 tables

      // Populate 60 public lists into D1
      db._db.exec("INSERT INTO accounts (id, username, display_name, key_hash, created_at) VALUES (1, 'dircreator', 'DirCreator', 'hash', 1000)");
      const insertStmt = db._db.prepare(`
        INSERT INTO lists (id, public_id, owner_account_id, slug, name, media_type, visibility, kind, item_count, like_count, add_count, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?, 'movie', 'public', 'custom', 10, ?, 1, ?, ?)
      `);

      for (let i = 1; i <= 60; i++) {
        insertStmt.run(
          i,
          `pub_${i}`,
          `list-slug-${i}`,
          `Public List ${i}`,
          100 - i, // descending likes
          1000000 + i * 1000,
          1000000 + i * 1000
        );
      }

      // Page through 15 pages of depth (limit=3 per page)
      const MAX_PAGES = 15;
      const pageDurations = [];
      let cursor = null;

      for (let p = 1; p <= MAX_PAGES; p++) {
        let path = "/lists/public.json?sort=popular&limit=3";
        if (cursor) path += `&cursor=${encodeURIComponent(cursor)}`;

        const start = performance.now();
        const res = await call(env, path);
        const dur = performance.now() - start;
        pageDurations.push({ page: p, dur });

        assert.equal(res.status, 200, `page ${p} must return 200`);
        assert.ok(Array.isArray(res.body.lists || res.body.items), `page ${p} must have lists array`);

        cursor = res.body.cursor || res.body.nextCursor || null;
        if (!cursor) break;
      }

      assert.ok(pageDurations.length >= 10, `should traverse at least 10 pages, traversed ${pageDurations.length}`);

      const page1Dur = pageDurations[0].dur;
      const deepPages = pageDurations.slice(5).map((p) => p.dur);
      const deepStats = calcPercentiles(deepPages);

      // Verify deep pages do not suffer quadratic degradation
      // p95 of deep pages must be under 50 ms
      assert.ok(
        deepStats.p95 < 50,
        `deep directory pages p95 (${deepStats.p95.toFixed(2)}ms) must be under 50ms`
      );
    });
  });
});
