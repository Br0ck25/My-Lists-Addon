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

// The merge (mergeDuplicateMedia, 29_media.js). Name and year are not enough
// (two films called Alone came out in 2020), so a pair is only what TMDB
// confirms: the stub's TMDB id belongs to the IMDb id another row holds.
function mergeEnv() {
  const env = makeEnv({ DB: makeD1(), DB_ACTIVITY: makeD1({ schema: "activity" }), TMDB_API_KEY: "k" });
  const db = env.DB._db;
  const ins = db.prepare(
    "INSERT INTO media (id, kind, tmdb_id, imdb_id, title, year, poster_path, resolved_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)"
  );
  ins.run(1, "series", null, "tt0903747", "Breaking Bad", 2008, null, 1);    // from a list, by IMDb id
  ins.run(2, "series", 1396, null, "Breaking Bad", 2008, null, null);        // from recommendations, by TMDB id
  ins.run(3, "movie", 661950, "tt10192566", "Alone", 2020, null, 1);
  ins.run(4, "movie", 509635, null, "Alone", 2020, null, null);              // another film called Alone
  ins.run(5, "movie", 777, null, "Lonely Stub", 2020, null, null);           // TMDB knows no other copy
  db.prepare("INSERT INTO accounts (id, username, display_name, key_hash, created_at) VALUES (7, 'ann', 'ann', 'h', 1)").run();
  db.prepare("INSERT INTO lists (id, public_id, owner_account_id, slug, name, media_type, item_count, created_at, updated_at) VALUES (1, 'p1', 7, 'a', 'A', 'series', 2, 1, 1), (2, 'p2', 7, 'b', 'B', 'series', 1, 1, 1)").run();
  const item = db.prepare("INSERT INTO list_items (list_id, media_id, position, added_at) VALUES (?, ?, ?, 1)");
  item.run(1, 1, 1); item.run(1, 2, 2);  // list A has both copies
  item.run(2, 2, 1);                     // list B only the stub
  db.prepare("INSERT INTO account_recommendations (account_id, kind, rank, media_id, built_at) VALUES (7, 'series', 0, 2, 1)").run();
  db.prepare("INSERT INTO title_daily_stats (day, event_type, media_id, n) VALUES ('2026-10-10', 'install', 1, 2), ('2026-10-10', 'install', 2, 3)").run();
  const act = env.DB_ACTIVITY._db;
  const play = act.prepare("INSERT INTO watch_events (account_id, media_id, season, episode, watched_at, source, dedupe_key) VALUES (7, ?, 1, ?, ?, 'ping', ?)");
  play.run(1, 1, 100, "a");
  play.run(2, 2, 200, "b");
  act.prepare("INSERT INTO show_progress (account_id, media_id, last_season, last_episode, last_watched_at, updated_at) VALUES (7, 1, 1, 1, 100, 1), (7, 2, 1, 2, 200, 1)").run();
  return env;
}

async function withTmdb(fn) {
  const realFetch = globalThis.fetch;
  const answers = {
    "/tv/1396": { id: 1396, name: "Breaking Bad", first_air_date: "2008-01-20", poster_path: "/bb.jpg", external_ids: { imdb_id: "tt0903747", tvdb_id: 81189 } },
    "/movie/509635": { id: 509635, title: "Alone", release_date: "2020-09-18", external_ids: { imdb_id: "tt10192566" } },
    "/movie/777": { id: 777, title: "Lonely Stub", release_date: "2020-01-01", external_ids: { imdb_id: "tt0000777" } },
  };
  globalThis.fetch = async (input) => {
    const url = String(input && input.url ? input.url : input);
    const hit = Object.keys(answers).find((k) => url.includes(`api.themoviedb.org/3${k}?`));
    return hit ? new Response(JSON.stringify(answers[hit]), { status: 200 }) : new Response("{}", { status: 404 });
  };
  try { return await fn(); } finally { globalThis.fetch = realFetch; }
}

const merge = async (env, apply) => {
  const cookie = await adminCookie(env);
  return withTmdb(() => call(env, "/admin/api/jobs/duplicate-media-merge", { method: "POST", cookie, json: { apply } }));
};

describe("Merge duplicate titles (admin)", () => {
  it("Preview pairs only what TMDB confirms, and writes nothing", async () => {
    const env = mergeEnv();
    const snap = () => JSON.stringify([env.DB._db.prepare("SELECT * FROM media ORDER BY id").all(), env.DB._db.prepare("SELECT * FROM list_items ORDER BY id").all(), env.DB_ACTIVITY._db.prepare("SELECT * FROM watch_events ORDER BY id").all()]);
    const before = snap();
    const r = await merge(env, false);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.pairs, 1);
    assert.equal(r.body.merged, 0);
    assert.equal(r.body.otherTmdb, 1, "the other Alone: its IMDb id's row already has another TMDB id");
    assert.equal(r.body.notStored, 1);
    assert.deepEqual(r.body.examples.map((e) => [e.keep, e.spare]), [[1, 2]]);
    assert.equal(snap(), before);
  });

  it("Merge moves everything onto the kept title, deletes the empty copy, and completes the kept one", async () => {
    const env = mergeEnv();
    const r = await merge(env, true);
    assert.equal(r.body.merged, 1, JSON.stringify(r.body));
    const db = env.DB._db;
    const act = env.DB_ACTIVITY._db;
    assert.equal(db.prepare("SELECT count(*) AS n FROM media WHERE id = 2").get().n, 0, "the empty copy is gone");
    const kept = db.prepare("SELECT tmdb_id, imdb_id, tvdb_id, poster_path FROM media WHERE id = 1").get();
    assert.deepEqual({ ...kept }, { tmdb_id: 1396, imdb_id: "tt0903747", tvdb_id: 81189, poster_path: "/bb.jpg" });
    assert.deepEqual(db.prepare("SELECT list_id, media_id FROM list_items ORDER BY list_id").all().map((x) => [x.list_id, x.media_id]), [[1, 1], [2, 1]], "list A keeps one entry, list B's entry moves");
    assert.deepEqual(db.prepare("SELECT id, item_count FROM lists ORDER BY id").all().map((x) => [x.id, x.item_count]), [[1, 1], [2, 1]]);
    assert.equal(db.prepare("SELECT media_id FROM account_recommendations").get().media_id, 1);
    assert.equal(db.prepare("SELECT n FROM title_daily_stats WHERE media_id = 1").get().n, 5, "counts are added, not lost");
    assert.deepEqual(act.prepare("SELECT media_id FROM watch_events ORDER BY id").all().map((x) => x.media_id), [1, 1], "every play is kept");
    const progress = act.prepare("SELECT media_id, last_episode FROM show_progress").all();
    assert.deepEqual(progress.map((x) => [x.media_id, x.last_episode]), [[1, 2]], "the more recent progress is kept");
    assert.equal(db.prepare("SELECT count(*) AS n FROM media WHERE id IN (4, 5)").get().n, 2, "titles TMDB did not pair are untouched");
  });

  it("is for the admin only", async () => {
    const r = await call(mergeEnv(), "/admin/api/jobs/duplicate-media-merge", { method: "POST", json: { apply: true } });
    assert.equal(r.status, 401);
  });
});
