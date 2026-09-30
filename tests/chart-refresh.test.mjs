// P5-5: chart.refresh keeps the chart snapshots in use fresh off the request,
// for every region an install asked for, and the old warm-up leaves those
// charts to it. Through the real Worker, with TMDB faked.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { freshIsolate, makeEnv, makeD1, makeQueue, drainQueue, runScheduledTick, nextIp } from "./harness.mjs";

async function preview(w, env, path) {
  const pending = [];
  const ctx = { waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})); } };
  const res = await w.fetch(new Request("https://example.test" + path, { headers: { "CF-Connecting-IP": nextIp(), Origin: "https://example.test" } }), env, ctx);
  await Promise.all(pending);
  return res.json();
}

function fakeTmdb() {
  const calls = [];
  const state = { status: 0, empty: false, title: "Title" };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname !== "api.themoviedb.org") throw new Error("network disabled in test: " + url);
    calls.push(url.pathname + "?" + url.searchParams.get("region"));
    if (state.status) return new Response("{}", { status: state.status });
    const detail = /^\/3\/(movie|tv)\/(\d+)$/.exec(url.pathname);
    if (detail) return Response.json({ id: Number(detail[2]), title: "T", external_ids: { imdb_id: "tt" + String(9000000 + Number(detail[2])) } });
    const results = state.empty ? [] : [1, 2, 3].map((id) => ({ id, title: `${state.title} ${id}`, poster_path: "/p.jpg", release_date: "2020-01-01" }));
    return Response.json({ page: 1, total_results: results.length, total_pages: 1, results });
  };
  return { calls, state, restore: () => { globalThis.fetch = realFetch; } };
}

const KEY_GB = "snap:chart:tmdb-chart:popular:movie:GB:0";
const KEY_US = "snap:chart:tmdb-chart:popular:movie:US:0";

function onlyChartJobs(env) {
  env.JOBS._pending.splice(0, env.JOBS._pending.length, ...env.JOBS._pending.filter((m) => m.body.type.startsWith("chart.")));
}

// An hour later: the fetchers' own caches (cache:*, tmdbdetail_v2:*) have
// expired, and the job runs in another isolate.
async function refreshTick(env) {
  const w = await freshIsolate();
  for (const k of [...env.CONFIGS._store.keys()]) if (k.startsWith("cache:") || k.startsWith("tmdbdetail_v2:")) env.CONFIGS._store.delete(k);
  env.DB._db.exec("UPDATE jobs SET run_after = 9999999999999 WHERE dedupe_key LIKE 'periodic:%' AND dedupe_key != 'periodic:chart.refresh'");
  env.DB._db.exec("UPDATE jobs SET run_after = 1 WHERE dedupe_key = 'periodic:chart.refresh'");
  await runScheduledTick(env, {}, w);
  onlyChartJobs(env);
  await drainQueue(env, { w });
}

describe("P5-5: chart.refresh", () => {
  it("refreshes every chart page in use, per region, off the request", async () => {
    const tmdb = fakeTmdb();
    try {
      const env = makeEnv({ DB: makeD1(), JOBS: makeQueue(), FF_CHART_SNAPSHOTS: "1", TMDB_API_KEY: "k" });
      const w = await freshIsolate();
      // Installs in two regions read the chart.
      await preview(w, env, "/api/preview?url=tmdb:chart:popular&type=movie&region=GB");
      await preview(w, env, "/api/preview?url=tmdb:chart:popular&type=movie&region=US");
      for (const key of [KEY_GB, KEY_US]) {
        assert.ok(env.CONFIGS._store.has(key));
        const use = env.CONFIGS._metadata.get("snap:chartuse:" + key.slice("snap:chart:".length));
        assert.equal(use.key, key);
        assert.equal(use.recipe.s, "tmdb-chart");
      }
      // The first tick makes the periodic rows; the refresh then finds both
      // pages fresh (just built) and leaves them.
      await runScheduledTick(env, {}, w);
      env.JOBS._pending.length = 0;
      const builtAt = JSON.parse(env.CONFIGS._store.get(KEY_GB)).builtAt;

      // An hour on: both are rebuilt, each for its own region, by the job.
      for (const key of [KEY_GB, KEY_US]) {
        const snap = JSON.parse(env.CONFIGS._store.get(key));
        env.CONFIGS._store.set(key, JSON.stringify({ ...snap, builtAt: snap.builtAt - 60 * 60 * 1000 }));
      }
      tmdb.state.title = "Newer";
      tmdb.calls.length = 0;
      await refreshTick(env);
      assert.ok(tmdb.calls.filter((c) => c.startsWith("/3/movie/popular")).length >= 2, tmdb.calls.join(" "));
      for (const key of [KEY_GB, KEY_US]) {
        const snap = JSON.parse(env.CONFIGS._store.get(key));
        assert.ok(snap.builtAt >= builtAt, key);
        assert.match(snap.items[0].name, /^Newer/);
      }
      assert.equal(env.DB._db.prepare("SELECT last_error FROM jobs WHERE dedupe_key = 'periodic:chart.refresh'").get().last_error, null);
    } finally {
      tmdb.restore();
    }
  });

  it("an empty or failed answer keeps the last copy", async () => {
    const tmdb = fakeTmdb();
    try {
      const env = makeEnv({ DB: makeD1(), JOBS: makeQueue(), FF_CHART_SNAPSHOTS: "1", TMDB_API_KEY: "k" });
      const w = await freshIsolate();
      await preview(w, env, "/api/preview?url=tmdb:chart:popular&type=movie&region=GB");
      await runScheduledTick(env, {}, w);
      env.JOBS._pending.length = 0;
      const age = () => {
        const snap = JSON.parse(env.CONFIGS._store.get(KEY_GB));
        env.CONFIGS._store.set(KEY_GB, JSON.stringify({ ...snap, builtAt: snap.builtAt - 60 * 60 * 1000 }));
        return JSON.parse(env.CONFIGS._store.get(KEY_GB));
      };
      let before = age();
      tmdb.state.empty = true;
      await refreshTick(env);
      assert.deepEqual(JSON.parse(env.CONFIGS._store.get(KEY_GB)), before);
      before = age();
      tmdb.state.empty = false;
      tmdb.state.status = 503;
      await refreshTick(env);
      assert.deepEqual(JSON.parse(env.CONFIGS._store.get(KEY_GB)).items, before.items);
    } finally {
      tmdb.restore();
    }
  });

  it("with snapshots off it does nothing, and the old warm-up keeps warming the charts", async () => {
    const tmdb = fakeTmdb();
    try {
      const env = makeEnv({ DB: makeD1(), TMDB_API_KEY: "k" });
      await runScheduledTick(env, {}, await freshIsolate());
      assert.ok(tmdb.calls.some((c) => /^\/3\/(trending|movie\/)/.test(c)), "the chart warm-up called TMDB");
      assert.ok(![...env.CONFIGS._store.keys()].some((k) => k.startsWith("snap:chart")));

      // Snapshots on: the warm-up leaves TMDB's charts to chart.refresh.
      const on = makeEnv({ DB: makeD1(), TMDB_API_KEY: "k", FF_CHART_SNAPSHOTS: "1" });
      tmdb.calls.length = 0;
      await runScheduledTick(on, {}, await freshIsolate());
      // (The channel-preset warm-up still asks TMDB for a network's shows.)
      assert.deepEqual(tmdb.calls.filter((c) => /^\/3\/(trending|movie\/|discover\/movie)/.test(c)), [], tmdb.calls.join(" "));
    } finally {
      tmdb.restore();
    }
  });
});
