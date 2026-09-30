// P5-10: channel.pool.build, recs.build, nos.sweep's quota ledger in D1, and
// rollup.daily. Through the real Worker and queue, with TMDB faked, except
// the ledger, which is exercised directly in a sandbox.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { makeEnv, makeKv, makeD1, makeQueue, drainQueue, runScheduledTick } from "./harness.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 86400000;
const plain = (v) => JSON.parse(JSON.stringify(v));

function loadSourceFunctions(...relFiles) {
  const sandbox = { console, URL, URLSearchParams, TextEncoder, TextDecoder, crypto: globalThis.crypto, Response, Headers, Request };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of relFiles) vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, f), "utf8"), sandbox, { filename: f });
  return sandbox;
}

function fakeTmdb() {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname !== "api.themoviedb.org") throw new Error("network disabled in test: " + url);
    calls.push(url.pathname);
    const json = (b) => Response.json(b);
    const rec = /^\/3\/(movie|tv)\/(\d+)\/recommendations$/.exec(url.pathname);
    if (rec) {
      const base = rec[1] === "movie" ? 5000 : 6000;
      return json({ results: [1, 2, 3].map((n) => ({ id: base + n, title: `Rec ${base + n}`, name: `Rec ${base + n}`, poster_path: "/p.jpg", release_date: "2020-01-01", first_air_date: "2019-01-01" })) });
    }
    if (url.pathname.startsWith("/3/trending/")) return json({ results: [] });
    if (url.pathname.startsWith("/3/discover/tv")) return json({ results: [{ id: 501 }] });
    if (url.pathname.startsWith("/3/network/")) return json({ logo_path: "/l.png" });
    if (/^\/3\/tv\/\d+$/.test(url.pathname)) return json({ id: 501, name: "Net Show", poster_path: "/p.jpg", external_ids: { imdb_id: "tt0000501" }, seasons: [{ season_number: 1 }] });
    if (/^\/3\/tv\/\d+\/season\/\d+$/.test(url.pathname)) return json({ episodes: [{ episode_number: 1, name: "Pilot", air_date: "2020-01-01", still_path: "/s.jpg" }] });
    return json({});
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

// Runs one tick with only `type` due, then its jobs.
async function runPeriodic(env, type) {
  await runScheduledTick(env);
  env.DB._db.exec("UPDATE jobs SET run_after = 9999999999999 WHERE dedupe_key LIKE 'periodic:%'");
  env.DB._db.prepare("UPDATE jobs SET run_after = 1 WHERE dedupe_key = ?").run(`periodic:${type}`);
  env.JOBS._pending.length = 0;
  await runScheduledTick(env);
  const prefix = type.split(".")[0] + ".";
  // The job, and the work it hands out (channel.pool.build, recs.build-account).
  env.JOBS._pending.splice(0, env.JOBS._pending.length, ...env.JOBS._pending.filter((m) => m.body.type.startsWith(prefix)));
  return drainQueue(env, { rounds: 100 });
}

describe("P5-10: nos.sweep's quota ledger in D1", () => {
  const sb = loadSourceFunctions("44_jobs-queue.js", "45_jobs-dispatcher.js", "53_more-jobs.js");
  const month = new Date().toISOString().slice(0, 7);

  it("starts from the KV ledger, so nothing already spent this month is forgotten", async () => {
    const env = { DB: makeD1(), CONFIGS: makeKv({ "cron:rapidapi:usage": JSON.stringify({ month, count: 50, lastAt: 1 }) }) };
    assert.equal(plain(await sb.rapidApiLedgerD1(env, 0)).count, 50);
    assert.equal(plain(await sb.rapidApiLedgerD1(env, 2)).count, 52);
  });

  it("adds atomically: overlapping sweeps lose no request", async () => {
    const env = { DB: makeD1(), CONFIGS: makeKv() };
    await Promise.all(Array.from({ length: 10 }, () => sb.rapidApiLedgerD1(env, 1)));
    assert.equal(plain(await sb.rapidApiLedgerD1(env, 0)).count, 10);
  });

  it("starts again at zero in a new month", async () => {
    const env = { DB: makeD1(), CONFIGS: makeKv() };
    await sb.rapidApiLedgerD1(env, 5);
    env.DB._db.exec(`UPDATE jobs SET progress_json = json_set(progress_json, '$.month', '2000-01') WHERE dedupe_key = 'ledger:rapidapi'`);
    assert.equal(plain(await sb.rapidApiLedgerD1(env, 0)).count, 0);
    assert.equal(plain(await sb.rapidApiLedgerD1(env, 3)).count, 3);
  });

  it("without D1 it answers null, and the KV ledger is used", async () => {
    assert.equal(await sb.rapidApiLedgerD1({ CONFIGS: makeKv() }, 1), null);
    const noTable = { DB: makeD1(), CONFIGS: makeKv() };
    noTable.DB._db.exec("DROP TABLE jobs");
    assert.equal(await sb.rapidApiLedgerD1(noTable, 1), null);
  });
});

describe("P5-10: channel.presets and channel.pool.build", () => {
  it("builds every network's preset through one job each", async () => {
    const tmdb = fakeTmdb();
    try {
      const env = makeEnv({ DB: makeD1(), JOBS: makeQueue(), TMDB_API_KEY: "k" });
      const log = await runPeriodic(env, "channel.presets");
      const builds = log.deliveries.filter((d) => d.type === "channel.pool.build");
      const networks = new Set(env.JOBS._sent.filter((b) => b.type === "channel.pool.build").map((b) => b.payload.networkId));
      assert.ok(networks.size > 20, `${networks.size} networks`);
      assert.equal(builds.length, networks.size);
      assert.ok(builds.every((d) => d.outcome === "ack"));
      const presets = [...env.CONFIGS._store.keys()].filter((k) => k.startsWith("channel:preset:v2:"));
      assert.equal(presets.length, networks.size);
      assert.equal(env.CONFIGS._store.has("cron:channelpresets:cursor"), false, "no rotation any more");
    } finally {
      tmdb.restore();
    }
  });
});

function activityEnv() {
  const env = makeEnv({ DB: makeD1(), DB_ACTIVITY: makeD1({ schema: "activity" }), JOBS: makeQueue(), TMDB_API_KEY: "k" });
  const db = env.DB._db;
  for (const id of [1, 2]) db.prepare("INSERT INTO accounts (id, username, display_name, key_hash, created_at) VALUES (?, ?, 'x', 'x', 0)").run(id, "acct" + id);
  db.prepare("INSERT INTO media (id, kind, tmdb_id, imdb_id, title, created_at, updated_at) VALUES (10, 'series', 100, 'tt0000100', 'Show', 0, 0)").run();
  db.prepare("INSERT INTO media (id, kind, tmdb_id, imdb_id, title, created_at, updated_at) VALUES (20, 'movie', 200, 'tt0000200', 'Film', 0, 0)").run();
  return env;
}

describe("P5-10: recs.build", () => {
  it("builds recommendations for accounts that watched something since, and only for them", async () => {
    const tmdb = fakeTmdb();
    try {
      const env = activityEnv();
      const act = env.DB_ACTIVITY._db;
      act.prepare("INSERT INTO show_progress (account_id, media_id, last_season, last_episode, last_watched_at, updated_at) VALUES (1, 10, 1, 2, ?, 0)").run(Date.now() - DAY);
      act.prepare("INSERT INTO user_media_state (account_id, media_id, watched_count, last_watched_at) VALUES (1, 20, 1, ?)").run(Date.now() - DAY);
      await runPeriodic(env, "recs.build");
      const recs = env.DB._db.prepare("SELECT r.kind, r.rank, m.tmdb_id, m.title FROM account_recommendations r JOIN media m ON m.id = r.media_id WHERE r.account_id = 1 ORDER BY r.kind, r.rank").all();
      assert.deepEqual(recs.map((r) => [r.kind, r.rank, r.tmdb_id]), [["movie", 1, 5001], ["movie", 2, 5002], ["movie", 3, 5003], ["series", 1, 6001], ["series", 2, 6002], ["series", 3, 6003]]);
      assert.equal(recs[0].title, "Rec 5001");
      assert.ok(tmdb.calls.includes("/3/tv/100/recommendations") && tmdb.calls.includes("/3/movie/200/recommendations"));
      assert.equal(env.DB._db.prepare("SELECT count(*) AS n FROM account_recommendations WHERE account_id = 2").get().n, 0, "account 2 watched nothing");

      // Nothing new: not built again.
      tmdb.calls.length = 0;
      await runPeriodic(env, "recs.build");
      assert.deepEqual(tmdb.calls, []);
      // New activity: built again.
      act.prepare("UPDATE show_progress SET last_watched_at = ? WHERE account_id = 1").run(Date.now() + 1000);
      await runPeriodic(env, "recs.build");
      assert.ok(tmdb.calls.length > 0);
    } finally {
      tmdb.restore();
    }
  });
});

describe("P5-10: rollup.daily", () => {
  it("counts yesterday's plays per title, and catches up on missed days", async () => {
    const env = activityEnv();
    const act = env.DB_ACTIVITY._db;
    const dayStart = (offset) => Date.parse(new Date(Date.now() + offset * DAY).toISOString().slice(0, 10) + "T00:00:00Z");
    const play = (acct, media, at, n) => act.prepare("INSERT INTO watch_events (account_id, media_id, season, episode, watched_at, source, dedupe_key) VALUES (?, ?, 1, 1, ?, 'web', ?)").run(acct, media, at, `k${n}`);
    play(1, 10, dayStart(-1) + 1000, 1);
    play(2, 10, dayStart(-1) + 2000, 2);
    play(1, 20, dayStart(-1) + 3000, 3);
    play(1, 20, dayStart(-3) + 3000, 4);
    play(1, 10, dayStart(0) + 1000, 5); // today: not yet
    const stats = () => env.DB._db.prepare("SELECT day, media_id, n FROM title_daily_stats WHERE event_type = 'play' ORDER BY day, n DESC").all().map((r) => [r.day, r.media_id, r.n]);
    const yesterday = new Date(dayStart(-1)).toISOString().slice(0, 10);
    const threeAgo = new Date(dayStart(-3)).toISOString().slice(0, 10);

    await runPeriodic(env, "rollup.daily");
    assert.deepEqual(stats(), [[yesterday, 10, 2], [yesterday, 20, 1]]);

    // A run that restarts four days back catches up, day by day.
    const fourAgo = new Date(dayStart(-4)).toISOString().slice(0, 10);
    env.DB._db.prepare("UPDATE jobs SET progress_json = json_set(progress_json, '$.lastDay', ?) WHERE dedupe_key = 'periodic:rollup.daily'").run(fourAgo);
    await runPeriodic(env, "rollup.daily");
    assert.deepEqual(stats(), [[threeAgo, 20, 1], [yesterday, 10, 2], [yesterday, 20, 1]]);
    const progress = JSON.parse(env.DB._db.prepare("SELECT progress_json FROM jobs WHERE dedupe_key = 'periodic:rollup.daily'").get().progress_json);
    assert.equal(progress.lastDay, yesterday);
    assert.equal(progress.lastRun.length, 3);
  });
});
