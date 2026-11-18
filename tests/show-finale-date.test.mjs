// The "Finale: <date>" badge on a show in the middle of its season.
//
// With FF_SHOW_SCHEDULE (on in production since 2026-10-04) Continue Watching
// and Airing Next come from show_schedule, and show.refresh only knew the
// finale's date when the finale was the next episode or the last one aired.
// TMDB's /tv/{id} lists a season's episode count but not its dates, so for a
// show at episode 4 of 6 the date stayed empty and the badge never appeared,
// where the older path (fetchTmdbItemDetailsUncached) reads the season's
// episode list for it. Owner report, 2026-11-15: no finale badges on the Lists
// tab for FBI, Tulsa King, Dexter: Resurrection and others, all mid-season.
//
// Also covers the air time on Continue Watching: the shelf now carries it
// itself for the scheduled next episode, so a show removed from Airing Next
// still shows the hour.
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
  for (const rel of ["src/core/00_constants.js", "src/core/02_http-and-creator-utils.js", "src/data/29_media.js", "src/data/30_lists-backfill.js", "src/data/34_lists-v2-bridge.js", "src/data/36_activity-db.js", "src/data/39_activity-shelves.js"]) {
    vm.runInContext(read(rel), sandbox, { filename: rel });
  }
  return sandbox;
}
const shelves = loadShelves();

const DAY = 86400000;
const day = (offset) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

// TMDB: /tv/100 and /tv/100/season/N; TVmaze for the air time.
function fakeProviders(state) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const u = String(input && input.url ? input.url : input);
    calls.push(u);
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    const season = /\/3\/tv\/(\d+)\/season\/(\d+)/.exec(u);
    if (season) {
      if (state.seasonDown) return new Response("busy", { status: 503 });
      const eps = (state.seasons[season[1]] || {})[season[2]];
      return eps ? json({ season_number: Number(season[2]), episodes: eps }) : json({ status_message: "not found" }, 404);
    }
    const tv = /\/3\/tv\/(\d+)/.exec(u);
    if (tv) return state.shows[tv[1]] ? json(state.shows[tv[1]]) : json({}, 404);
    if (u.startsWith("https://api.tvmaze.com/lookup/shows")) {
      return json({ schedule: { time: "21:00", days: ["Sunday"] }, network: { country: { timezone: "America/New_York" } }, _links: {} });
    }
    throw new Error("network disabled in test: " + u);
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

// Ann has watched S2E3 of The Show (media 10, TMDB 100).
function showEnv() {
  const env = makeEnv({ DB: makeD1(), DB_ACTIVITY: makeD1({ schema: "activity" }), JOBS: makeQueue(), TMDB_API_KEY: "k" });
  env.DB._db.prepare("INSERT INTO media (id, kind, imdb_id, tmdb_id, title, created_at, updated_at) VALUES (10, 'series', 'tt0000010', 100, 'The Show', 0, 0)").run();
  env.DB_ACTIVITY._db.prepare(
    "INSERT INTO show_progress (account_id, media_id, last_season, last_episode, last_watched_at, status, updated_at) VALUES (1, 10, 2, 3, ?, 'watching', 0)"
  ).run(Date.now() - DAY);
  env.DB._db.exec("INSERT INTO show_schedule (media_id, watcher_count, next_check_at) VALUES (10, 1, 0)");
  env.DB._db.exec("INSERT INTO jobs (type, dedupe_key, status, run_after, created_at, updated_at) VALUES ('show.watchers', 'periodic:show.watchers', 'queued', 9999999999999, 0, 0)");
  return env;
}

async function refreshNow(env) {
  env.DB._db.exec("UPDATE jobs SET run_after = 1 WHERE dedupe_key = 'periodic:show.refresh'");
  env.DB._db.exec("UPDATE show_schedule SET next_check_at = 0");
  await runScheduledTick(env);
  env.JOBS._pending.splice(0, env.JOBS._pending.length, ...env.JOBS._pending.filter((m) => m.body.type.startsWith("show.")));
  await drainQueue(env);
}

const sched = (env) => env.DB._db.prepare("SELECT * FROM show_schedule WHERE media_id = 10").get();

async function shelvesNow(env) {
  return {
    cw: plain(await shelves.continueWatching(env, 1, {})),
    an: plain(await shelves.airingNext(env, 1, {})),
  };
}

// Season 2: six episodes, E3 aired, E4 is next, E6 (the finale) in three weeks.
function midSeason() {
  return {
    shows: {
      100: {
        status: "Returning Series",
        last_episode_to_air: { season_number: 2, episode_number: 3, air_date: day(-6) },
        next_episode_to_air: { season_number: 2, episode_number: 4, air_date: day(1) },
        seasons: [{ season_number: 1, episode_count: 8 }, { season_number: 2, episode_count: 6 }],
      },
    },
    seasons: {
      100: {
        2: [1, 2, 3, 4, 5, 6].map((n) => ({ episode_number: n, air_date: day(-27 + 7 * n) })),
      },
    },
  };
}

describe("show.refresh: the finale's date for a show in the middle of its season", () => {
  it("reads the season's episode list, so Airing Next and Continue Watching carry the finale date", async () => {
    const state = midSeason();
    const finale = day(-27 + 42);
    const net = fakeProviders(state);
    try {
      const env = showEnv();
      await refreshNow(env);
      const row = sched(env);
      assert.deepEqual([row.next_season, row.next_episode], [2, 4]);
      assert.deepEqual([row.season_finale_season, row.season_finale_episode, row.season_finale_date], [2, 6, finale],
        "episode 4 of 6: the finale is E6, and its date comes from the season's episode list");
      assert.ok(net.calls.some((u) => u.includes("/tv/100/season/2")), "asked TMDB for season 2");

      const s = await shelvesNow(env);
      assert.equal(s.an.items.length, 1);
      assert.equal(s.an.items[0].seasonFinaleAirDate, finale, "Airing Next tile: Finale: <date>");
      assert.equal(s.an.items[0].isSeasonFinale, undefined, "E4 is not the finale itself");
      assert.equal(s.cw.items.length, 1);
      assert.deepEqual([s.cw.items[0].seasonNum, s.cw.items[0].episodeNum], [2, 4]);
      assert.equal(s.cw.items[0].seasonFinaleAirDate, finale, "Continue Watching tile: Finale: <date>");
    } finally {
      net.restore();
    }
  });

  it("keeps the rest of the schedule when the season list cannot be read", async () => {
    const state = { ...midSeason(), seasonDown: true };
    const net = fakeProviders(state);
    try {
      const env = showEnv();
      await refreshNow(env);
      const row = sched(env);
      assert.equal(row.status, "Returning Series", "the refresh itself succeeded");
      assert.deepEqual([row.next_season, row.next_episode, row.next_air_date], [2, 4, day(1)]);
      assert.deepEqual([row.season_finale_episode, row.season_finale_date], [6, null], "no date rather than a wrong one");
      assert.equal(row.next_check_at - row.checked_at, 60 * 60 * 1000, "airs tomorrow: asked again in an hour, as before");
    } finally {
      net.restore();
    }
  });

  it("does not ask for the season list when the premiere or the finale is next (as the older path)", async () => {
    const state = midSeason();
    state.shows[100].next_episode_to_air = { season_number: 2, episode_number: 6, air_date: day(15) };
    state.shows[100].last_episode_to_air = { season_number: 2, episode_number: 5, air_date: day(8) };
    const net = fakeProviders(state);
    try {
      const env = showEnv();
      await refreshNow(env);
      assert.equal(sched(env).season_finale_date, day(15), "the finale is next: its own date");
      state.shows[100].next_episode_to_air = { season_number: 3, episode_number: 1, air_date: day(30) };
      state.shows[100].seasons.push({ season_number: 3, episode_count: 10 });
      await refreshNow(env);
      assert.equal(sched(env).season_finale_date, null);
      assert.ok(!net.calls.some((u) => /\/season\//.test(u)), "no season call: " + net.calls.filter((u) => /\/season\//.test(u)).join(", "));
    } finally {
      net.restore();
    }
  });

  it("Continue Watching carries the air time of the scheduled next episode itself", async () => {
    const net = fakeProviders(midSeason());
    try {
      const env = showEnv();
      await refreshNow(env);
      // Ann removed the show from Airing Next: the page has no entry there to borrow the hour from.
      env.DB_ACTIVITY._db.exec("UPDATE show_progress SET airing_hidden_at_season = 2, airing_hidden_at_episode = 3 WHERE media_id = 10");
      const s = await shelvesNow(env);
      assert.equal(s.an.items.length, 0);
      assert.equal(s.cw.items.length, 1);
      assert.ok(s.cw.items[0].airTime && /9\s*PM/i.test(s.cw.items[0].airTime), "air time on the tile: " + s.cw.items[0].airTime);
    } finally {
      net.restore();
    }
  });
});
