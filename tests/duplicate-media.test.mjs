import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { call, makeD1, makeEnv } from "./harness.mjs";

// Two media rows for one title (findDuplicateMedia, 29_media.js): the count the
// admin runs before any merge. It must find a title stored once by its IMDb id
// and once by its TMDB id, count what sits on each copy, leave two different
// films that share a name and year alone, and change nothing.

async function adminCookie(env) {
  const r = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
  const m = (r.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/);
  return m ? m[1] : "";
}

function seededEnv() {
  const env = makeEnv({ DB: makeD1(), DB_ACTIVITY: makeD1({ schema: "activity" }) });
  const db = env.DB._db;
  const ins = db.prepare(
    "INSERT INTO media (id, kind, tmdb_id, imdb_id, title, year, resolved_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)"
  );
  // One show twice: by IMDb id (from a list import), by TMDB id (from a search).
  ins.run(1, "series", null, "tt0903747", "Breaking Bad", 2008, 1);
  ins.run(2, "series", 1396, null, "breaking bad ", 2008, 1);
  // Two different films with one name and year: each has its own ids.
  ins.run(3, "movie", 111, "tt0000111", "Home", 2015, 1);
  ins.run(4, "movie", 222, "tt0000222", "Home", 2015, 1);
  // The same name as a film and as a show: different kinds, not compared.
  ins.run(5, "movie", null, "tt0000555", "Dark Matter", 2024, 1);
  ins.run(6, "series", 999, null, "Dark Matter", 2024, 1);
  const act = env.DB_ACTIVITY._db;
  const play = act.prepare("INSERT INTO watch_events (account_id, media_id, season, episode, watched_at, source, dedupe_key) VALUES (7, ?, 1, ?, ?, 'ping', ?)");
  play.run(1, 1, 100, "a");
  play.run(1, 2, 200, "b");
  play.run(2, 3, 300, "c");
  act.prepare("INSERT INTO show_progress (account_id, media_id, last_season, last_episode, updated_at) VALUES (7, 2, 1, 3, 1)").run();
  return env;
}

describe("Check duplicate titles (admin, read-only)", () => {
  it("finds a title stored by its IMDb id and again by its TMDB id, with what sits on each copy", async () => {
    const env = seededEnv();
    const before = JSON.stringify(env.DB._db.prepare("SELECT * FROM media ORDER BY id").all());
    const r = await call(env, "/admin/api/jobs/duplicate-media", { cookie: await adminCookie(env) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.likelyGroups, 1);
    assert.equal(r.body.likelyRows, 2);
    assert.equal(r.body.splitGroups, 1, "both copies of Breaking Bad have plays");
    assert.equal(r.body.sameNameDifferent, 1, "the two films called Home are different titles");
    const [g] = r.body.examples;
    assert.equal(g.title, "Breaking Bad");
    const byId = Object.fromEntries(g.rows.map((row) => [row.id, row]));
    assert.deepEqual([byId[1].plays, byId[1].progress], [2, 0]);
    assert.deepEqual([byId[2].plays, byId[2].progress], [1, 1]);
    assert.equal(JSON.stringify(env.DB._db.prepare("SELECT * FROM media ORDER BY id").all()), before, "it only reads");
  });

  it("is for the admin only", async () => {
    const r = await call(seededEnv(), "/admin/api/jobs/duplicate-media");
    assert.equal(r.status, 401);
  });
});
