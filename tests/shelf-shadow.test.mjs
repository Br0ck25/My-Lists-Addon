// P5-4 (first half): shelf.shadow compares the stored Continue Watching and
// Airing Next with the ones worked out from show_schedule, and reports the
// difference in the admin's Check jobs. Through the real Worker and queue.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeEnv, makeD1, makeQueue, drainQueue, runScheduledTick, call } from "./harness.mjs";

const DAY = 86400000;
const day = (offset) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

async function adminCookie(env) {
  const r = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
  const m = (r.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/);
  return m ? m[1] : "";
}

function shadowEnv() {
  const env = makeEnv({ DB: makeD1(), DB_ACTIVITY: makeD1({ schema: "activity" }), JOBS: makeQueue() });
  const db = env.DB._db;
  db.prepare("INSERT INTO accounts (id, username, display_name, key_hash, created_at) VALUES (1, 'ann', 'Ann', 'x', 0)").run();
  db.prepare("INSERT INTO accounts (id, username, display_name, key_hash, created_at) VALUES (2, 'bob', 'Bob', 'x', 0)").run();
  for (const id of [1, 2]) {
    db.prepare("INSERT INTO jobs (type, dedupe_key, account_id, status, run_after, created_at, updated_at) VALUES ('migrate.activity', ?, ?, 'done', 0, 0, 0)").run(`migrate.activity:acct:${id}`, id);
  }
  const media = db.prepare("INSERT INTO media (id, kind, imdb_id, tmdb_id, title, created_at, updated_at) VALUES (?, 'series', ?, ?, ?, 0, 0)");
  media.run(10, "tt0000010", 100, "Airing Show");
  media.run(11, "tt0000011", 110, "Caught Up");
  media.run(12, "tt0000012", 120, "Never Refreshed");
  const sched = db.prepare(`INSERT INTO show_schedule (media_id, status, last_aired_season, last_aired_episode, last_aired_date, next_season, next_episode, next_air_date, season_episode_counts, watcher_count, checked_at, next_check_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 9999999999999)`);
  // 10: S1E4 aired, E5 next week. 11: ended at S1E3.
  sched.run(10, "Returning Series", 1, 4, day(-2), 1, 5, day(7), JSON.stringify({ 1: 6 }));
  sched.run(11, "Ended", 1, 3, "2020-01-01", null, null, null, JSON.stringify({ 1: 3 }));
  // 12 was watched but never refreshed: not known yet.
  db.prepare("INSERT INTO show_schedule (media_id, watcher_count, next_check_at) VALUES (12, 1, 9999999999999)").run();
  const p = env.DB_ACTIVITY._db.prepare("INSERT INTO show_progress (account_id, media_id, last_season, last_episode, last_watched_at, status, updated_at) VALUES (?, ?, 1, ?, ?, 'watching', 0)");
  p.run(1, 10, 3, Date.now() - DAY);
  p.run(1, 11, 3, Date.now() - 2 * DAY);
  p.run(1, 12, 1, Date.now() - 3 * DAY);
  // Ann's stored shelves: the same E4 (by its TMDB id, which must not count as
  // a difference), a stale Airing Next entry for the ended show, and the
  // never-refreshed show.
  env.CONFIGS._store.set("creatorsynctracking:ann", JSON.stringify({
    continueWatching: [
      { id: "tmdb:100:1:4", showId: "tmdb:100", type: "episode", seasonNum: 1, episodeNum: 4 },
      { id: "tt0000012:1:2", showId: "tt0000012", type: "episode", seasonNum: 1, episodeNum: 2 },
    ],
    airingNext: [
      { id: "tt0000010", showId: "tt0000010", seasonNum: 1, episodeNum: 5 },
      { id: "tt0000011", showId: "tt0000011", seasonNum: 2, episodeNum: 1 },
    ],
  }));
  // Bob has no stored record: nothing to compare.
  return env;
}

async function runShadow(env) {
  env.DB._db.exec("UPDATE jobs SET run_after = 9999999999999 WHERE dedupe_key LIKE 'periodic:%' AND dedupe_key != 'periodic:shelf.shadow'");
  env.DB._db.exec("UPDATE jobs SET run_after = 1 WHERE dedupe_key = 'periodic:shelf.shadow'");
  await runScheduledTick(env);
  env.JOBS._pending.splice(0, env.JOBS._pending.length, ...env.JOBS._pending.filter((m) => m.body.type === "shelf.shadow"));
  await drainQueue(env);
}

describe("P5-4: shelf.shadow", () => {
  it("compares the stored shelves with the worked-out ones, by title, and reports the difference", async () => {
    const points = [];
    const env = shadowEnv();
    env.ANALYTICS = { writeDataPoint: (p) => points.push(p) };
    // The first tick makes the periodic rows (and runs them); run it again on its own.
    await runScheduledTick(env);
    env.JOBS._pending.length = 0;
    await runShadow(env);

    const row = env.DB._db.prepare("SELECT progress_json, last_error FROM jobs WHERE dedupe_key = 'periodic:shelf.shadow'").get();
    assert.equal(row.last_error, null);
    const last = JSON.parse(row.progress_json).last;
    assert.equal(last.accounts, 1, "Bob has nothing stored to compare");
    // Continue Watching: S1E4 of show 10 in both (one by tmdb id, one by imdb).
    assert.deepEqual(
      [last.cw.both, last.cw.legacyOnly, last.cw.v2Only, last.cw.unknown],
      [1, 0, 0, 1],
    );
    // Airing Next: show 10 in both; the ended show only in the old one.
    assert.deepEqual([last.an.both, last.an.legacyOnly, last.an.v2Only], [1, 1, 0]);
    assert.equal(last.rate, 1 / 3);
    assert.deepEqual(last.examples, [{ accountId: 1, shelf: "an", legacyOnly: ["m11"], v2Only: [] }]);

    const shadowPoints = points.filter((p) => p.indexes && p.indexes[0] === "shelf-shadow");
    assert.deepEqual(shadowPoints.map((p) => p.blobs[1]), ["cw", "an"]);

    const status = await call(env, "/admin/api/jobs/status", { cookie: await adminCookie(env) });
    const job = status.body.jobs.periodic.find((j) => j.type === "shelf.shadow");
    assert.equal(job.last.accounts, 1);
  });

  it("walks the accounts in steps and does nothing without the activity database", async () => {
    const env = makeEnv({ DB: makeD1(), JOBS: makeQueue() });
    await runScheduledTick(env);
    env.JOBS._pending.splice(0, env.JOBS._pending.length, ...env.JOBS._pending.filter((m) => m.body.type === "shelf.shadow"));
    await drainQueue(env);
    const row = env.DB._db.prepare("SELECT attempts, last_error FROM jobs WHERE dedupe_key = 'periodic:shelf.shadow'").get();
    assert.deepEqual([row.attempts, row.last_error], [0, null]);
  });
});
