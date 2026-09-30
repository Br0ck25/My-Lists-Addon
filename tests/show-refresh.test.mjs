// P5-3: show.refresh keeps show_schedule current, and the shelves worked out
// from it (39_activity-shelves.js) stay right as time passes. Driven through
// the real Worker (cron tick + queue), with TMDB and TVmaze faked.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { makeEnv, makeD1, makeQueue, drainQueue, runScheduledTick } from "./harness.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(REPO_ROOT, f), "utf8");
const plain = (v) => JSON.parse(JSON.stringify(v));

function loadShelves() {
  const sandbox = { console, URL, TextEncoder, TextDecoder, crypto: globalThis.crypto, Response, Headers, Request, Intl };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of ["00_constants.js", "02_http-and-creator-utils.js", "29_media.js", "30_lists-backfill.js", "34_lists-v2-bridge.js", "36_activity-db.js", "39_activity-shelves.js"]) {
    vm.runInContext(read(rel), sandbox, { filename: rel });
  }
  return sandbox;
}
const shelves = loadShelves();

const DAY = 86400000;
const day = (offset) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

// The show TMDB describes, changed by each test step.
function fakeProviders(state) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const u = String(input && input.url ? input.url : input);
    calls.push(u);
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (u.startsWith("https://api.themoviedb.org/3/tv/")) {
      const id = Number(u.split("/tv/")[1].split("?")[0]);
      if (state.down) return new Response("busy", { status: 503 });
      return state.shows[id] ? json(state.shows[id]) : json({ status_message: "not found" }, 404);
    }
    if (u.startsWith("https://api.themoviedb.org/3/find/")) {
      return json({ tv_results: state.find ? [{ id: state.find }] : [] });
    }
    if (u.startsWith("https://api.tvmaze.com/lookup/shows")) {
      return json({ schedule: { time: "21:00", days: ["Sunday"] }, network: { country: { timezone: "America/New_York" } }, _links: {} });
    }
    throw new Error("network disabled in test: " + u);
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

function showEnv() {
  const env = makeEnv({ DB: makeD1(), DB_ACTIVITY: makeD1({ schema: "activity" }), JOBS: makeQueue(), TMDB_API_KEY: "k" });
  const db = env.DB._db;
  db.prepare("INSERT INTO media (id, kind, imdb_id, tmdb_id, title, created_at, updated_at) VALUES (10, 'series', 'tt0000010', 100, 'The Show', 0, 0)").run();
  db.prepare("INSERT INTO media (id, kind, imdb_id, tmdb_id, title, created_at, updated_at) VALUES (11, 'series', 'tt0000011', NULL, 'Only IMDb', 0, 0)").run();
  db.prepare("INSERT INTO media (id, kind, imdb_id, tmdb_id, title, created_at, updated_at) VALUES (12, 'movie', 'tt0000012', 120, 'A Film', 0, 0)").run();
  // Ann has watched S1E3 of The Show.
  env.DB_ACTIVITY._db.prepare(
    "INSERT INTO show_progress (account_id, media_id, last_season, last_episode, last_watched_at, status, updated_at) VALUES (1, 10, 1, 3, ?, 'watching', 0)"
  ).run(Date.now() - DAY);
  return env;
}

// One cron tick with show.refresh due, then the queue.
async function refreshNow(env) {
  env.DB._db.exec("UPDATE jobs SET run_after = 1 WHERE dedupe_key IN ('periodic:show.refresh', 'periodic:show.watchers')");
  await runScheduledTick(env);
  env.JOBS._pending.splice(0, env.JOBS._pending.length, ...env.JOBS._pending.filter((m) => m.body.type.startsWith("show.")));
  await drainQueue(env);
}

const sched = (env, id) => env.DB._db.prepare("SELECT * FROM show_schedule WHERE media_id = ?").get(id);

async function shelvesAt(env, offsetDays) {
  const now = Date.now() + offsetDays * DAY;
  return {
    cw: plain(await shelves.continueWatching(env, 1, { now })),
    an: plain(await shelves.airingNext(env, 1, { now })),
  };
}

describe("P5-3: show.refresh", () => {
  it("fills the schedule from TMDB and TVmaze, and the shelves follow it over time", async () => {
    const state = {
      shows: {
        100: {
          status: "Returning Series",
          last_episode_to_air: { season_number: 1, episode_number: 3, air_date: day(-6) },
          next_episode_to_air: { season_number: 1, episode_number: 4, air_date: day(1) },
          seasons: [{ season_number: 1, episode_count: 5 }],
        },
      },
    };
    const net = fakeProviders(state);
    try {
      const env = showEnv();
      // First tick: the watchers job makes the row (not known yet).
      await refreshNow(env);
      assert.equal(sched(env, 10).watcher_count, 1);
      assert.equal(sched(env, 12), undefined, "a film gets no schedule");
      let s = await shelvesAt(env, 0);
      if (sched(env, 10).checked_at == null) assert.deepEqual(s.cw.missingSchedule, [10], "not known yet, not \"nothing new\"");

      // It is due: refreshed.
      await refreshNow(env);
      let row = sched(env, 10);
      assert.equal(row.status, "Returning Series");
      assert.deepEqual([row.next_season, row.next_episode, row.next_air_date], [1, 4, day(1)]);
      assert.deepEqual([row.next_air_time, row.air_tz], ["21:00", "America/New_York"]);
      assert.deepEqual([row.season_finale_season, row.season_finale_episode, row.season_finale_date], [1, 5, null]);
      assert.equal(row.season_episode_counts, JSON.stringify({ 1: 5 }));
      assert.ok(row.next_check_at - row.checked_at === 60 * 60 * 1000, "airs tomorrow: look again in an hour");

      // Today: E4 is announced, not aired. Airing Next has it; Continue Watching offers it as upcoming.
      s = await shelvesAt(env, 0);
      assert.deepEqual(s.an.items.map((i) => i.showId), ["tt0000010"]);
      assert.deepEqual(s.cw.items.map((i) => [i.seasonNum, i.episodeNum, !!i.isUnaired]), [[1, 4, true]]);

      // Two days on, TMDB says E4 aired and E5 (the finale) is next.
      state.shows[100] = {
        status: "Returning Series",
        last_episode_to_air: { season_number: 1, episode_number: 4, air_date: day(1) },
        next_episode_to_air: { season_number: 1, episode_number: 5, air_date: day(8) },
        seasons: [{ season_number: 1, episode_count: 5 }],
      };
      env.DB._db.exec("UPDATE show_schedule SET next_check_at = 0");
      await refreshNow(env);
      row = sched(env, 10);
      assert.deepEqual([row.last_aired_episode, row.next_episode, row.season_finale_date], [4, 5, day(8)]);
      assert.equal(row.next_check_at - row.checked_at, 6 * 60 * 60 * 1000);
      s = await shelvesAt(env, 2);
      assert.deepEqual(s.cw.items.map((i) => [i.seasonNum, i.episodeNum, !!i.isUnaired]), [[1, 4, false]]);
      assert.equal(s.an.items.length, 1);
      assert.equal(s.an.items[0].isSeasonFinale, true, "E5 is the finale");

      // It ends.
      state.shows[100] = {
        status: "Ended",
        last_episode_to_air: { season_number: 1, episode_number: 5, air_date: day(8) },
        next_episode_to_air: null,
        seasons: [{ season_number: 1, episode_count: 5 }],
      };
      env.DB._db.exec("UPDATE show_schedule SET next_check_at = 0");
      await refreshNow(env);
      row = sched(env, 10);
      assert.equal(row.next_check_at - row.checked_at, 14 * DAY);
      assert.equal(row.season_finale_date, day(8));
      s = await shelvesAt(env, 10);
      assert.deepEqual(s.cw.items.map((i) => [i.seasonNum, i.episodeNum]), [[1, 4]]);
      assert.deepEqual(s.an.items, []);
    } finally {
      net.restore();
    }
  });

  it("finds a show by its IMDb id, backs off when TMDB fails, and only refreshes shows people watch", async () => {
    const state = { shows: { 110: { status: "Ended", last_episode_to_air: { season_number: 2, episode_number: 8, air_date: "2020-01-01" }, seasons: [] } }, find: 110 };
    const net = fakeProviders(state);
    try {
      const env = showEnv();
      env.DB._db.exec("INSERT INTO show_schedule (media_id, watcher_count, next_check_at) VALUES (11, 2, 0)");
      env.DB._db.exec("INSERT INTO show_schedule (media_id, watcher_count, next_check_at) VALUES (10, 0, 0)");
      // The watchers job would give 10 a watcher; hold it off for this test.
      env.DB._db.exec("INSERT INTO jobs (type, dedupe_key, status, run_after, created_at, updated_at) VALUES ('show.watchers', 'periodic:show.watchers', 'queued', 9999999999999, 0, 0)");
      await runScheduledTick(env);
      env.JOBS._pending.splice(0, env.JOBS._pending.length, ...env.JOBS._pending.filter((m) => m.body.type.startsWith("show.")));
      await drainQueue(env);
      assert.equal(sched(env, 11).status, "Ended");
      assert.ok(net.calls.some((u) => u.includes("/find/tt0000011")));
      assert.equal(sched(env, 10).checked_at, null, "nobody watches it: not refreshed");

      state.down = true;
      env.DB._db.exec("UPDATE show_schedule SET next_check_at = 0 WHERE media_id = 11");
      env.DB._db.exec("UPDATE jobs SET run_after = 1 WHERE dedupe_key = 'periodic:show.refresh'");
      await runScheduledTick(env);
      env.JOBS._pending.splice(0, env.JOBS._pending.length, ...env.JOBS._pending.filter((m) => m.body.type.startsWith("show.")));
      const before = Date.now();
      await drainQueue(env);
      const row = sched(env, 11);
      assert.equal(row.status, "Ended", "a failed refresh keeps what was known");
      assert.ok(row.next_check_at >= before + 60 * 60 * 1000 - 1000 && row.next_check_at <= Date.now() + 60 * 60 * 1000);
    } finally {
      net.restore();
    }
  });

  it("hands out due shows in batches of 50, and holds them so the next run does not take them again", async () => {
    const net = fakeProviders({ shows: {} });
    try {
      const env = showEnv();
      const ins = env.DB._db.prepare("INSERT INTO media (id, kind, tmdb_id, title, created_at, updated_at) VALUES (?, 'series', ?, 'S', 0, 0)");
      const sch = env.DB._db.prepare("INSERT INTO show_schedule (media_id, watcher_count, next_check_at) VALUES (?, 1, 0)");
      for (let i = 0; i < 120; i++) {
        ins.run(1000 + i, 5000 + i);
        sch.run(1000 + i);
      }
      env.DB._db.exec("INSERT INTO jobs (type, dedupe_key, status, run_after, created_at, updated_at) VALUES ('show.watchers', 'periodic:show.watchers', 'queued', 9999999999999, 0, 0)");
      await runScheduledTick(env);
      env.JOBS._pending.splice(0, env.JOBS._pending.length, ...env.JOBS._pending.filter((m) => m.body.type === "show.refresh"));
      const log = await drainQueue(env, { rounds: 1 });
      assert.equal(log.deliveries.length, 1);
      const batches = env.JOBS._pending.filter((m) => m.body.type === "show.refresh-batch").map((m) => m.body.payload.mediaIds.length);
      assert.deepEqual(batches, [50, 50, 20]);
      const held = env.DB._db.prepare("SELECT count(*) AS n FROM show_schedule WHERE next_check_at > ?").get(Date.now()).n;
      assert.equal(held, 120);
      await drainQueue(env);
      // TMDB knows none of them: looked at again in 14 days, not every hour.
      const late = env.DB._db.prepare("SELECT min(next_check_at) AS t FROM show_schedule WHERE media_id >= 1000").get().t;
      assert.ok(late > Date.now() + 13 * DAY);
    } finally {
      net.restore();
    }
  });
});
