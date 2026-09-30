// media.retry (55_media-retry.js): the titles the list and history copies
// could not place at TMDB are asked about again, hourly, through the real
// Worker and queue with TMDB faked.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeEnv, makeD1, makeQueue, drainQueue, runScheduledTick } from "./harness.mjs";

const DAY = 86400000;
const FIGHT_CLUB = { id: 550, title: "Fight Club", release_date: "1999-10-15", poster_path: "/fc.jpg" };

// TMDB knows Fight Club and nothing else.
function fakeTmdb() {
  const asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname !== "api.themoviedb.org") throw new Error("network disabled in test: " + url);
    asked.push(url.pathname);
    if (url.pathname === "/3/find/tt0137523") return Response.json({ movie_results: [FIGHT_CLUB], tv_results: [] });
    if (url.pathname === "/3/movie/550") return Response.json({ ...FIGHT_CLUB, external_ids: { imdb_id: "tt0137523" } });
    if (url.pathname.startsWith("/3/find/")) return Response.json({ movie_results: [], tv_results: [] });
    return new Response("{}", { status: 404 });
  };
  return { asked, restore: () => { globalThis.fetch = realFetch; } };
}

// Runs one tick with only media.retry due, then the queue. (A row made due
// this way was already sent by the first tick, so the second tick may run it
// itself as a message not picked up: either way it runs once.)
async function runRetry(env) {
  await runScheduledTick(env);
  env.DB._db.exec("UPDATE jobs SET run_after = 9999999999999 WHERE dedupe_key LIKE 'periodic:%'");
  env.DB._db.prepare("UPDATE jobs SET run_after = 1 WHERE dedupe_key = 'periodic:media.retry'").run();
  env.JOBS._pending.length = 0;
  await runScheduledTick(env);
  env.JOBS._pending.splice(0, env.JOBS._pending.length, ...env.JOBS._pending.filter((m) => m.body.type === "media.retry"));
  return drainQueue(env, { rounds: 20 });
}

// A stub as the copies leave one: resolved_at NULL, updated_at = created_at.
function stub(db, imdbId, title, at) {
  db._db.prepare(
    "INSERT INTO media (kind, imdb_id, title, resolved_at, created_at, updated_at) VALUES ('movie', ?, ?, NULL, ?, ?)"
  ).run(imdbId, title, at, at);
  return db._db.prepare("SELECT id FROM media WHERE imdb_id = ?").get(imdbId).id;
}

const row = (db, id) => db._db.prepare("SELECT tmdb_id, resolved_at, created_at, updated_at FROM media WHERE id = ?").get(id);

describe("media.retry: stubs are asked about again", () => {
  it("places a stub TMDB now knows, on its hourly run", async () => {
    const tmdb = fakeTmdb();
    try {
      const env = makeEnv({ DB: makeD1(), JOBS: makeQueue(), TMDB_API_KEY: "k" });
      const id = stub(env.DB, "tt0137523", "Fight Club", Date.now() - 3 * DAY);
      await runRetry(env);
      const r = row(env.DB, id);
      assert.equal(r.tmdb_id, 550);
      assert.ok(r.resolved_at > 0, "placed");
      const job = env.DB._db.prepare("SELECT progress_json FROM jobs WHERE dedupe_key = 'periodic:media.retry'").get();
      assert.equal(JSON.parse(job.progress_json).totalResolved, 1);
    } finally {
      tmdb.restore();
    }
  });

  it("gives a title TMDB does not know a week's rest, and still asks about new stubs", async () => {
    const tmdb = fakeTmdb();
    try {
      const env = makeEnv({ DB: makeD1(), JOBS: makeQueue(), TMDB_API_KEY: "k" });
      const unknown = stub(env.DB, "tt9999991", "Nobody Knows", Date.now() - 3 * DAY);
      await runRetry(env);
      const after = row(env.DB, unknown);
      assert.equal(after.resolved_at, null);
      assert.ok(after.updated_at > after.created_at, "moved to the back of the queue");

      tmdb.asked.length = 0;
      const fresh = stub(env.DB, "tt0137523", "Fight Club", Date.now() - DAY);
      await runRetry(env);
      assert.ok(!tmdb.asked.includes("/3/find/tt9999991"), "not asked again within the week");
      assert.ok(row(env.DB, fresh).resolved_at > 0, "a stub never tried again is due at once");

      // A week on, it is asked again.
      env.DB._db.prepare("UPDATE media SET updated_at = ? WHERE id = ?").run(Date.now() - 8 * DAY, unknown);
      tmdb.asked.length = 0;
      await runRetry(env);
      assert.ok(tmdb.asked.includes("/3/find/tt9999991"));
    } finally {
      tmdb.restore();
    }
  });

  it("does nothing without a TMDB key, and does not fail", async () => {
    const tmdb = fakeTmdb();
    try {
      const env = makeEnv({ DB: makeD1(), JOBS: makeQueue(), TMDB_API_KEY: "" });
      const id = stub(env.DB, "tt0137523", "Fight Club", Date.now() - 3 * DAY);
      await runRetry(env);
      const job = env.DB._db.prepare("SELECT status FROM jobs WHERE dedupe_key = 'periodic:media.retry'").get();
      assert.equal(job.status, "queued", "waiting for its next turn, not failed");
      assert.equal(row(env.DB, id).resolved_at, null);
      assert.equal(tmdb.asked.length, 0);
    } finally {
      tmdb.restore();
    }
  });
});
