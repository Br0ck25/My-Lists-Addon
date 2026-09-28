import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { call, createUser, makeD1, makeEnv } from "./harness.mjs";

// Phase 3c: watch history and progress in their own database, DB_ACTIVITY
// (migrations/activity/, schema_activity.sql, 36_activity-db.js).

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
const MIGRATION_DIR = "migrations/activity";
const MIGRATIONS = fs.readdirSync(path.join(REPO_ROOT, MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();

function loadActivity() {
  const errors = [];
  const sandbox = { console: { ...console, error: (...a) => errors.push(a.join(" ")) } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read("36_activity-db.js"), sandbox, { filename: "36_activity-db.js" });
  sandbox.errors = errors;
  return sandbox;
}

function shape(db) {
  const objects = db.prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  return objects.map((o) => {
    const cols = o.type === "table"
      ? db.prepare(`PRAGMA table_info(${o.name})`).all().map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value}:${c.pk}`)
      : db.prepare(`PRAGMA index_info(${o.name})`).all().map((c) => c.name);
    return `${o.type} ${o.name} on ${o.tbl_name} (${cols.join(", ")})`;
  });
}

describe("P3c-1: the activity database schema", () => {
  it("schema_activity.sql is the same as running every activity migration in order", () => {
    const fresh = new DatabaseSync(":memory:");
    fresh.exec(read("schema_activity.sql"));
    const migrated = new DatabaseSync(":memory:");
    for (const f of MIGRATIONS) migrated.exec(read(`${MIGRATION_DIR}/${f}`));
    assert.deepEqual(shape(fresh), shape(migrated));
  });

  it("records itself in its own ledger and applies twice without error", () => {
    const db = makeD1({ schema: "activity" })._db;
    db.exec("DELETE FROM schema_migrations");
    db.exec(read(`${MIGRATION_DIR}/A0001_activity.sql`));
    db.exec(read(`${MIGRATION_DIR}/A0001_activity.sql`));
    const row = db.prepare("SELECT applied_at FROM schema_migrations WHERE version = 'A0001'").get();
    assert.ok(row && row.applied_at > 0);
  });

  it("can be pasted into the D1 Console as it is: no semicolon or apostrophe in a comment", () => {
    for (const f of MIGRATIONS) {
      const bad = read(`${MIGRATION_DIR}/${f}`).split("\n").filter((l) => l.trim().startsWith("--") && /[;']/.test(l));
      assert.deepEqual(bad, [], f);
    }
  });

  it("keeps its migrations apart from the main database", () => {
    // The main drift test runs every migrations/*.sql against schema.sql; an
    // activity migration there would put these tables in the wrong database.
    const main = fs.readdirSync(path.join(REPO_ROOT, "migrations")).filter((f) => f.endsWith(".sql"));
    assert.ok(main.every((f) => /^\d{4}/.test(f)), "only numbered migrations in migrations/");
    assert.ok(MIGRATIONS.every((f) => /^A\d{4}_/.test(f)), "activity migrations start with A");
    assert.doesNotMatch(read("schema.sql"), /watch_events|show_progress|user_media_state/);
  });

  it("stores one play once: the same dedupe key is refused", () => {
    const db = makeD1({ schema: "activity" })._db;
    const ins = db.prepare("INSERT OR IGNORE INTO watch_events (account_id, media_id, season, episode, watched_at, source, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?)");
    ins.run(1, 10, 1, 2, 1000, "ping", "1:10:1:2:0");
    ins.run(1, 10, 1, 2, 1500, "webhook", "1:10:1:2:0");
    ins.run(1, 20, null, null, 1500, "web", "1:20:::0");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM watch_events").get().n, 2);
  });

  it("show_progress takes one row per account and show, and only known statuses", () => {
    const db = makeD1({ schema: "activity" })._db;
    const up = db.prepare(`INSERT INTO show_progress (account_id, media_id, last_season, last_episode, last_watched_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (account_id, media_id) DO UPDATE SET last_season = excluded.last_season,
      last_episode = excluded.last_episode, last_watched_at = excluded.last_watched_at, updated_at = excluded.updated_at`);
    up.run(1, 10, 1, 1, 100, 100);
    up.run(1, 10, 1, 2, 200, 200);
    const row = db.prepare("SELECT * FROM show_progress").get();
    assert.equal(row.last_episode, 2);
    assert.equal(row.status, "watching");
    assert.throws(() => db.exec("UPDATE show_progress SET status = 'paused'"));
  });

  it("the history and progress reads use their indexes", () => {
    const db = makeD1({ schema: "activity" })._db;
    const plan = (sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(" | ");
    assert.match(plan("SELECT * FROM watch_events WHERE account_id = 1 ORDER BY watched_at DESC LIMIT 50"), /idx_we_account_time/);
    assert.match(plan("SELECT * FROM watch_events WHERE account_id = 1 AND media_id = 5 AND season = 1 AND episode = 2"), /idx_we_account_media/);
    assert.match(plan("SELECT * FROM show_progress WHERE account_id = 1 ORDER BY last_watched_at DESC LIMIT 200"), /idx_sp_account_recent/);
  });
});

describe("P3c-1: activityDb and shardFor", () => {
  it("returns null without the binding, so callers keep the legacy store", () => {
    const sb = loadActivity();
    assert.equal(sb.activityDb({}, 1), null);
    assert.equal(sb.activityDbs({}).length, 0);
  });

  it("uses DB_ACTIVITY for everyone while there is one database", () => {
    const sb = loadActivity();
    const env = { DB_ACTIVITY: { name: "a0" } };
    for (const id of [1, 2, 3, 999999]) assert.equal(sb.activityDb(env, id), env.DB_ACTIVITY);
    assert.equal(sb.shardFor(env, 7), 0);
  });

  it("routes by account id modulo the shard count once every shard is bound", () => {
    const sb = loadActivity();
    const env = { DB_ACTIVITY: { n: 0 }, DB_ACTIVITY_1: { n: 1 }, DB_ACTIVITY_2: { n: 2 }, ACTIVITY_SHARD_COUNT: "3" };
    assert.equal(sb.activityDb(env, 3).n, 0);
    assert.equal(sb.activityDb(env, 4).n, 1);
    assert.equal(sb.activityDb(env, 5).n, 2);
    assert.equal(sb.activityDb(env, 4), sb.activityDb(env, 4), "the same account always lands in the same place");
    assert.equal(sb.activityDbs(env).length, 3);
    assert.throws(() => sb.shardFor(env, "not-an-id"));
  });

  it("ignores a shard count whose databases are not bound, and says so", () => {
    const sb = loadActivity();
    const env = { DB_ACTIVITY: { n: 0 }, DB_ACTIVITY_1: { n: 1 }, ACTIVITY_SHARD_COUNT: "3" };
    assert.equal(sb.activityDb(env, 5).n, 0);
    assert.equal(sb.activityDbs(env).length, 1);
    assert.ok(sb.errors.some((e) => e.includes("DB_ACTIVITY_2")));
  });

  it("activitySchemaReady is true only once A0001 is applied", async () => {
    const sb = loadActivity();
    const ready = makeD1({ schema: "activity" });
    assert.equal(await sb.activitySchemaReady(ready), true);
    const empty = makeD1({ schema: "activity" });
    empty._db.exec("DELETE FROM schema_migrations");
    assert.equal(await sb.activitySchemaReady(empty), false);
    assert.equal(await sb.activitySchemaReady(null), false);
  });
});

// --- P3c-2: migrations/0017_show_schedule.sql, in the main database ----------

const MIGRATION_0017 = read("migrations/0017_show_schedule.sql");

function mainDb() {
  const db = makeD1()._db;
  db.exec("INSERT INTO accounts (id, username, display_name, key_hash, created_at) VALUES (1, 'ann', 'Ann', 'h', 0)");
  db.exec("INSERT INTO media (id, kind, tmdb_id, created_at, updated_at) VALUES (10, 'series', 1399, 0, 0), (20, 'movie', 603, 0, 0)");
  return db;
}

describe("P3c-2: the show schedule, recommendations and daily title counts", () => {
  it("records itself in the ledger and applies twice without error", () => {
    const db = makeD1()._db;
    db.exec("DELETE FROM schema_migrations WHERE version = '0017'");
    db.exec(MIGRATION_0017);
    db.exec(MIGRATION_0017);
    const row = db.prepare("SELECT applied_at FROM schema_migrations WHERE version = '0017'").get();
    assert.ok(row && row.applied_at > 0);
  });

  it("can be pasted into the D1 Console as it is: no semicolon or apostrophe in a comment", () => {
    const bad = MIGRATION_0017.split("\n").filter((l) => l.trim().startsWith("--") && /[;']/.test(l));
    assert.deepEqual(bad, []);
  });

  it("the schema check knows every table and index it adds", () => {
    const names = [...MIGRATION_0017.matchAll(/CREATE (?:TABLE|INDEX) IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
    const sb = { console };
    vm.createContext(sb);
    vm.runInContext(`${read("00_constants.js")}\nglobalThis.__m = D1_SCHEMA_MANIFEST;`, sb);
    const listed = sb.__m.filter((e) => e.migration === "0017").map((e) => e.name);
    assert.deepEqual([...listed].sort(), [...names].sort());
  });

  it("finds the shows due for a refresh through its index, skipping shows nobody watches", () => {
    const db = mainDb();
    db.exec("INSERT INTO media (id, kind, created_at, updated_at) VALUES (11, 'series', 0, 0)");
    db.exec("INSERT INTO show_schedule (media_id, watcher_count, next_check_at) VALUES (10, 3, 100), (11, 0, 50)");
    const sql = "SELECT media_id FROM show_schedule WHERE next_check_at <= ? AND watcher_count > 0 ORDER BY next_check_at LIMIT 500";
    assert.deepEqual(db.prepare(sql).all(1000).map((r) => r.media_id), [10]);
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1000).map((r) => r.detail).join(" | ");
    assert.match(plan, /idx_show_schedule_due/);
  });

  it("keeps one recommendation per rank, only for movies and series, and drops them with the account", () => {
    const db = mainDb();
    const ins = db.prepare("INSERT INTO account_recommendations (account_id, kind, rank, media_id, built_at) VALUES (?, ?, ?, ?, 0)");
    ins.run(1, "movie", 0, 20);
    ins.run(1, "series", 0, 10);
    assert.throws(() => ins.run(1, "movie", 0, 10), /UNIQUE|PRIMARY/);
    assert.throws(() => ins.run(1, "tv", 1, 10), /CHECK/);
    db.exec("DELETE FROM accounts WHERE id = 1");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM account_recommendations").get().n, 0);
  });

  it("counts a title once per day and event, and reads a day's top titles through its index", () => {
    const db = mainDb();
    const bump = db.prepare(`INSERT INTO title_daily_stats (day, event_type, media_id, n) VALUES (?, ?, ?, 1)
      ON CONFLICT (day, event_type, media_id) DO UPDATE SET n = n + 1`);
    bump.run("2026-09-28", "watched", 10);
    bump.run("2026-09-28", "watched", 10);
    bump.run("2026-09-28", "watched", 20);
    const top = "SELECT media_id, n FROM title_daily_stats WHERE event_type = ? AND day = ? ORDER BY n DESC LIMIT 20";
    assert.deepEqual(db.prepare(top).all("watched", "2026-09-28").map((r) => [r.media_id, r.n]), [[10, 2], [20, 1]]);
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${top}`).all("watched", "2026-09-28").map((r) => r.detail).join(" | ");
    assert.match(plan, /idx_title_daily_stats_top/);
    assert.doesNotMatch(plan, /TEMP B-TREE/, "no sort step: the index gives the order");
  });

  it("a title removed from media takes its schedule, recommendations and counts with it", () => {
    const db = mainDb();
    db.exec("INSERT INTO show_schedule (media_id, watcher_count, next_check_at) VALUES (10, 1, 0)");
    db.exec("INSERT INTO account_recommendations (account_id, kind, rank, media_id, built_at) VALUES (1, 'series', 0, 10, 0)");
    db.exec("INSERT INTO title_daily_stats (day, event_type, media_id, n) VALUES ('2026-09-28', 'watched', 10, 4)");
    db.exec("DELETE FROM media WHERE id = 10");
    for (const t of ["show_schedule", "account_recommendations", "title_daily_stats"]) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, t);
    }
  });
});

// --- P3c-3: the activity backfill, migrate.activity (37_activity-backfill.js) --

const H = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 10, 20, 0, 0);

async function adminCookie(env) {
  const r = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
  const m = (r.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/);
  return m ? m[1] : "";
}

function activityEnv(extra = {}) {
  return makeEnv({ DB: makeD1(), DB_ACTIVITY: makeD1({ schema: "activity" }), ...extra });
}

async function runActivityBackfill(env, cookie, opts = {}) {
  const responses = [];
  for (let i = 0; i < 500; i++) {
    const r = await call(env, "/admin/api/activity-backfill/step", { method: "POST", cookie, json: { ...opts, restart: i === 0 && !!opts.restart } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    responses.push(r.body);
    if (r.body.done) return responses;
  }
  throw new Error("activity backfill did not finish");
}

// One account's tracking, spread over the three places it lives today.
async function seedLegacyActivity(env, username) {
  const bb = "tt0903747";
  await env.CONFIGS.put(`creatorsynctracking:${username}`, JSON.stringify({
    updatedAt: T0 + 5 * H,
    watchHistory: [
      { id: "e1", type: "episode", showId: bb, showTitle: "Breaking Bad", seasonNum: 1, episodeNum: 1, watchedAt: T0 },
      { id: "e2", type: "episode", showId: bb, showTitle: "Breaking Bad", seasonNum: 1, episodeNum: 2, watchedAt: T0 + H },
      { id: "tt0137523", type: "movie", name: "Fight Club", watchedAt: T0 + 2 * H },
      // An episode saved without its show: the id carries it.
      { id: "tt0944947:2:3", type: "episode", name: "Game of Thrones", watchedAt: T0 + 3 * H },
      // No id at all: nothing could ever show it. Two of them, at the same
      // time, so a resumed copy has to tell them apart.
      { name: "Ghost", type: "movie", watchedAt: T0 },
      { name: "Ghost 2", type: "movie", watchedAt: T0 },
      // The same play of S1E2 under its other id, five minutes later.
      { id: `${bb}:1:2`, type: "episode", showId: bb, seasonNum: 1, episodeNum: 2, watchedAt: T0 + H + 5 * 60 * 1000 },
    ],
    continueWatching: [
      { id: "e3", type: "episode", showId: bb, showTitle: "Breaking Bad", seasonNum: 1, episodeNum: 3 },
      { id: "tt0120737", type: "movie", kind: "movie", name: "The Fellowship", isCompanion: true, companionType: "sequel_movie", companionNote: "Next Movie in Storyline", companionStoryline: "Middle-earth", updatedAt: T0 },
      { id: "x1", type: "episode", showId: "tt0386676", showTitle: "The Office", seasonNum: 2, episodeNum: 1, updatedAt: T0 - H },
    ],
    fullyWatchedShowIds: ["tt0944947"],
    dismissedContinueWatching: { [bb]: { seasonNum: 1, episodeNum: 2 } },
    removedAiringNext: { tt0944947: { seasonNum: 2, episodeNum: 3 } },
    watchlist: [{ id: "tt0068646", type: "movie" }],
  }));
  const db = env.DB._db;
  db.prepare("INSERT INTO creator_tracking_meta (username, updated_at) VALUES (?, ?)").run(username, T0 + H);
  db.prepare(`INSERT INTO watch_history (username, item_id, item_type, title, show_id, season_num, episode_num, watched_at)
    VALUES (?, 'e1', 'episode', 'Pilot', ?, 1, 1, ?), (?, 'tt0068646', 'movie', 'The Godfather', NULL, NULL, NULL, ?)`)
    .run(username, bb, T0, username, T0 - 24 * H);
  // An older store's dismissal of another show: kept (dismissals are never undone).
  db.prepare("INSERT INTO creator_show_states (username, show_id, is_fully_watched, dismissed_season, dismissed_episode, updated_at) VALUES (?, 'tmdb:1399', 0, 1, 5, ?)")
    .run(username, T0);
  await env.CONFIGS.put(`creatorscrobblequeue:${username}`, JSON.stringify({
    watchHistory: [{ id: "e4", type: "episode", showId: bb, showTitle: "Breaking Bad", seasonNum: 1, episodeNum: 4, watchedAt: T0 + 4 * H }],
    continueWatching: [],
  }));
}

function legacyActivitySnapshot(env) {
  const kv = [...env.CONFIGS._store.entries()].filter(([k]) => /^(creatorsynctracking|creatorscrobblequeue|creatorsync):/.test(k)).sort();
  const tables = {};
  for (const t of ["watch_history", "continue_watching", "airing_next", "creator_show_states", "creator_tracking_meta"]) {
    tables[t] = env.DB._db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all();
  }
  return JSON.stringify({ kv, tables });
}

function mediaIdBy(env, col, value) {
  const row = env.DB._db.prepare(`SELECT id FROM media WHERE ${col} = ?`).get(value);
  return row ? row.id : null;
}

function accountId(env, username) {
  return env.DB._db.prepare("SELECT id FROM accounts WHERE username = ?").get(username).id;
}

function eventsOf(env, id) {
  return env.DB_ACTIVITY._db.prepare("SELECT media_id, season, episode, watched_at, source FROM watch_events WHERE account_id = ? ORDER BY watched_at").all(id);
}

describe("P3c-3: copying watch history into the activity database", () => {
  it("copies the union of the three histories, once per play, and leaves the legacy store alone", async () => {
    const env = activityEnv();
    await createUser(env, "annwatch");
    await seedLegacyActivity(env, "annwatch");
    const before = legacyActivitySnapshot(env);
    const cookie = await adminCookie(env);
    const steps = await runActivityBackfill(env, cookie);
    assert.equal(steps.at(-1).accountsFailed, 0);
    assert.equal(legacyActivitySnapshot(env), before, "the legacy store is unchanged");

    const id = accountId(env, "annwatch");
    const bb = mediaIdBy(env, "imdb_id", "tt0903747");
    const got = mediaIdBy(env, "imdb_id", "tt0944947");
    const fc = mediaIdBy(env, "imdb_id", "tt0137523");
    const gf = mediaIdBy(env, "imdb_id", "tt0068646");
    const events = eventsOf(env, id);
    assert.deepEqual(events.map((e) => [e.media_id, e.season, e.episode, e.watched_at]), [
      [gf, null, null, T0 - 24 * H],   // only in D1
      [bb, 1, 1, T0],                  // in KV and D1: once
      [bb, 1, 2, T0 + H],              // its twin five minutes later is the same play
      [fc, null, null, T0 + 2 * H],
      [got, 2, 3, T0 + 3 * H],         // show and episode read from the id
      [bb, 1, 4, T0 + 4 * H],          // only in the scrobble queue
    ]);
    assert.ok(events.every((e) => e.source === "migrated"));

    const status = await call(env, "/admin/api/activity-backfill/status", { cookie });
    const h = status.body.totals.history;
    assert.deepEqual([h.kv, h.d1, h.queue, h.union, h.copied, h.duplicates, h.unusable], [7, 2, 1, 9, 6, 1, 2]);
    assert.equal(status.body.totals.events, 6);
    assert.equal(h.stubs, 4, "no TMDB key here: all four titles watched are kept as stubs");
    assert.equal(status.body.totals.shortAccounts, 1, "7 entries in KV, 6 plays: one short");
    const short = status.body.short[0];
    assert.equal(short.short, 1);
    assert.match(short.samples.short[0], /1 duplicates, 2 with no usable id/);
    assert.equal(status.body.accounts.done, 1);
  });

  it("works out where each show is up to, with what was hidden, finished and suggested", async () => {
    const env = activityEnv();
    await createUser(env, "annwatch");
    await seedLegacyActivity(env, "annwatch");
    await runActivityBackfill(env, await adminCookie(env));
    const id = accountId(env, "annwatch");
    const rows = env.DB_ACTIVITY._db.prepare("SELECT * FROM show_progress WHERE account_id = ?").all(id);
    const by = (col, v) => rows.find((r) => r.media_id === mediaIdBy(env, col, v));

    const bb = by("imdb_id", "tt0903747");
    assert.deepEqual([bb.last_season, bb.last_episode, bb.last_watched_at, bb.status], [1, 4, T0 + 4 * H, "watching"]);
    assert.deepEqual([bb.dismissed_at_season, bb.dismissed_at_episode], [1, 2]);

    const got = by("imdb_id", "tt0944947");
    assert.deepEqual([got.last_season, got.last_episode, got.status], [2, 3, "completed"]);
    assert.deepEqual([got.airing_hidden_at_season, got.airing_hidden_at_episode], [2, 3]);

    // In Continue Watching with no history: kept just before the episode it offered.
    const office = by("imdb_id", "tt0386676");
    assert.deepEqual([office.last_season, office.last_episode, office.last_watched_at], [2, 0, T0 - H]);

    // A storyline suggestion is kept whole.
    const lotr = by("imdb_id", "tt0120737");
    const entry = JSON.parse(lotr.companion_json);
    assert.equal(entry.companionType, "sequel_movie");
    assert.equal(entry.companionStoryline, "Middle-earth");
    assert.equal(lotr.last_season, null);

    // The older store's dismissal of a show nobody watched here.
    const other = rows.find((r) => r.media_id === env.DB._db.prepare("SELECT id FROM media WHERE tmdb_id = 1399 AND kind = 'series'").get().id);
    assert.deepEqual([other.dismissed_at_season, other.dismissed_at_episode, other.last_season], [1, 5, null]);
    assert.equal(rows.length, 5);

    const movies = env.DB_ACTIVITY._db.prepare("SELECT media_id, watched_count, last_watched_at FROM user_media_state WHERE account_id = ? ORDER BY last_watched_at").all(id);
    assert.deepEqual(movies.map((m) => [m.media_id, m.watched_count, m.last_watched_at]), [
      [mediaIdBy(env, "imdb_id", "tt0068646"), 1, T0 - 24 * H],
      [mediaIdBy(env, "imdb_id", "tt0137523"), 1, T0 + 2 * H],
    ]);
  });

  it("gives the same result in many small steps as in one", async () => {
    const whole = activityEnv();
    await createUser(whole, "annwatch");
    await seedLegacyActivity(whole, "annwatch");
    await runActivityBackfill(whole, await adminCookie(whole));

    const small = activityEnv();
    await createUser(small, "annwatch");
    await seedLegacyActivity(small, "annwatch");
    const steps = await runActivityBackfill(small, await adminCookie(small), { maxItems: 1, maxOps: 20 });
    assert.ok(steps.length > 3, `took ${steps.length} steps`);

    const shape = (env) => {
      const id = accountId(env, "annwatch");
      const m = (mid) => env.DB._db.prepare("SELECT coalesce(imdb_id, kind || ':' || tmdb_id) AS k FROM media WHERE id = ?").get(mid).k;
      return JSON.stringify({
        events: eventsOf(env, id).map((e) => [m(e.media_id), e.season, e.episode, e.watched_at]),
        progress: env.DB_ACTIVITY._db.prepare("SELECT * FROM show_progress WHERE account_id = ?").all(id)
          .map((r) => [m(r.media_id), r.last_season, r.last_episode, r.status, r.dismissed_at_season, r.airing_hidden_at_season, !!r.companion_json]).sort(),
      });
    };
    assert.equal(shape(small), shape(whole));
    const recon = async (env) => (await call(env, "/admin/api/activity-backfill/status", { cookie: await adminCookie(env) })).body.totals;
    assert.deepEqual(await recon(small), await recon(whole), "the same counts too");
  });

  it("treats two plays ten minutes apart or less as one, even when different steps copy them", async () => {
    const env = activityEnv();
    await createUser(env, "benwatch");
    await env.CONFIGS.put("creatorsynctracking:benwatch", JSON.stringify({
      updatedAt: T0,
      watchHistory: [
        { id: "a", type: "episode", showId: "tt0903747", seasonNum: 1, episodeNum: 1, watchedAt: T0 },
        { id: "b", type: "episode", showId: "tt0903747", seasonNum: 1, episodeNum: 1, watchedAt: T0 + 9 * 60 * 1000 },
        { id: "c", type: "episode", showId: "tt0903747", seasonNum: 1, episodeNum: 1, watchedAt: T0 + 3 * H },
      ],
    }));
    await runActivityBackfill(env, await adminCookie(env), { maxItems: 1 });
    const events = eventsOf(env, accountId(env, "benwatch"));
    assert.deepEqual(events.map((e) => e.watched_at), [T0, T0 + 3 * H], "a rewatch hours later is a second play");
  });

  it("starting over reflects the legacy store as it now is, and keeps plays recorded some other way", async () => {
    const env = activityEnv();
    await createUser(env, "annwatch");
    await seedLegacyActivity(env, "annwatch");
    const cookie = await adminCookie(env);
    await runActivityBackfill(env, cookie);
    const id = accountId(env, "annwatch");
    const fc = mediaIdBy(env, "imdb_id", "tt0137523");
    // A play written by the future scrobble path, and a removal in the legacy store.
    env.DB_ACTIVITY._db.prepare("INSERT INTO watch_events (account_id, media_id, watched_at, source, dedupe_key) VALUES (?, ?, ?, 'ping', 'live-1')").run(id, fc, T0 + 10 * H);
    const blob = JSON.parse(await env.CONFIGS.get("creatorsynctracking:annwatch"));
    blob.watchHistory = blob.watchHistory.filter((it) => it.id !== "tt0137523");
    await env.CONFIGS.put("creatorsynctracking:annwatch", JSON.stringify(blob));

    const again = await runActivityBackfill(env, cookie);
    assert.equal(again.length, 1, "a finished run is not repeated by Copy");
    await runActivityBackfill(env, cookie, { restart: true });
    const fcEvents = eventsOf(env, id).filter((e) => e.media_id === fc);
    assert.deepEqual(fcEvents.map((e) => [e.source, e.watched_at]), [["ping", T0 + 10 * H]]);
    const state = env.DB_ACTIVITY._db.prepare("SELECT watched_count, last_watched_at FROM user_media_state WHERE account_id = ? AND media_id = ?").get(id, fc);
    assert.deepEqual([state.watched_count, state.last_watched_at], [1, T0 + 10 * H]);
  });

  it("copies an account whose tracking is still inside its old sync record", async () => {
    const env = activityEnv();
    await createUser(env, "oldtimer");
    const sync = JSON.parse((await env.CONFIGS.get("creatorsync:oldtimer")) || "{}");
    await env.CONFIGS.put("creatorsync:oldtimer", JSON.stringify({ ...sync, watchHistory: [{ id: "tt0137523", type: "movie", watchedAt: T0 }] }));
    await env.CONFIGS.delete("creatorsynctracking:oldtimer");
    await runActivityBackfill(env, await adminCookie(env));
    assert.equal(eventsOf(env, accountId(env, "oldtimer")).length, 1);
  });

  it("says what is missing before it starts", async () => {
    const unbound = makeEnv({ DB: makeD1() });
    await createUser(unbound, "annwatch");
    const cookie = await adminCookie(unbound);
    let r = await call(unbound, "/admin/api/activity-backfill/step", { method: "POST", cookie, json: {} });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /DB_ACTIVITY/);

    const unmigrated = activityEnv();
    unmigrated.DB_ACTIVITY._db.exec("DELETE FROM schema_migrations");
    r = await call(unmigrated, "/admin/api/activity-backfill/step", { method: "POST", cookie: await adminCookie(unmigrated), json: {} });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /A0001/);

    r = await call(unmigrated, "/admin/api/activity-backfill/step", { method: "POST", json: {} });
    assert.equal(r.status, 401, "admin only");
  });

  it("a failing account is recorded and the run carries on", async () => {
    const env = activityEnv();
    await createUser(env, "annwatch");
    await createUser(env, "benwatch");
    await seedLegacyActivity(env, "annwatch");
    await seedLegacyActivity(env, "benwatch");
    env.DB_ACTIVITY._hooks = env.DB_ACTIVITY._hooks || {};
    const annId = accountId(env, "annwatch");
    const realPrepare = env.DB_ACTIVITY.prepare.bind(env.DB_ACTIVITY);
    env.DB_ACTIVITY.prepare = (sql) => {
      const st = realPrepare(sql);
      if (!/^\s*INSERT OR IGNORE INTO watch_events/.test(sql)) return st;
      return { ...st, bind: (...args) => (args[0] === annId ? { run: async () => { throw new Error("boom"); } } : st.bind(...args)) };
    };
    const steps = await runActivityBackfill(env, await adminCookie(env));
    assert.equal(steps.at(-1).accountsFailed, 1);
    const status = await call(env, "/admin/api/activity-backfill/status", { cookie: await adminCookie(env) });
    assert.equal(status.body.accounts.failed, 1);
    assert.equal(status.body.accounts.done, 1);
    assert.equal(status.body.failed[0].accountId, annId);
    assert.ok(eventsOf(env, accountId(env, "benwatch")).length > 0, "the next account was still copied");
  });

  it("the admin page offers it only with the activity database bound", async () => {
    const env = activityEnv();
    const page = await call(env, "/admin", { cookie: await adminCookie(env) });
    assert.match(page.text, /id="activityBackfillBtn" onclick="runActivityBackfill\(false\)" >/);
    const unbound = makeEnv({ DB: makeD1() });
    const page2 = await call(unbound, "/admin", { cookie: await adminCookie(unbound) });
    assert.match(page2.text, /id="activityBackfillBtn" onclick="runActivityBackfill\(false\)" disabled>/);
  });
});

describe("P3c-3: the copy can only copy", () => {
  function loadBackfill() {
    const sandbox = { console };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(read("37_activity-backfill.js"), sandbox, { filename: "37_activity-backfill.js" });
    return sandbox;
  }
  const fakeDb = () => ({ prepare: (sql) => ({ sql, bind() { return this; }, run: async () => ({}), all: async () => ({ results: [] }), first: async () => null }), batch: async () => [] });

  it("refuses writes to the legacy tables, schema changes, and has no KV writes", () => {
    const sb = loadBackfill();
    const meter = { ops: 0 };
    const env = sb.activityBackfillEnv({ DB: fakeDb(), DB_ACTIVITY: fakeDb(), DB_ACTIVITY_1: fakeDb(), CONFIGS: { get() {}, put() {}, delete() {}, list() {} }, BLOBS: {} }, meter);
    assert.equal(env.CONFIGS.put, undefined);
    assert.equal(env.CONFIGS.delete, undefined);
    assert.equal(env.BLOBS, undefined);
    for (const sql of ["INSERT INTO watch_history (username) VALUES (?)", "UPDATE creator_show_states SET x = 1", "DELETE FROM creator_tracking_meta", "INSERT INTO watch_events (x) VALUES (1)", "DROP TABLE media"]) {
      assert.throws(() => env.DB.prepare(sql), /refusing/, sql);
    }
    for (const sql of ["DELETE FROM media", "UPDATE creator_lists SET likes = 0", "DROP TABLE watch_events", "WITH x AS (SELECT 1) DELETE FROM watch_events"]) {
      assert.throws(() => env.DB_ACTIVITY.prepare(sql), /refusing/, sql);
      assert.throws(() => env.DB_ACTIVITY_1.prepare(sql), /refusing/, sql);
    }
    env.DB.prepare("INSERT OR IGNORE INTO media (kind) VALUES ('movie')");
    env.DB.prepare("UPDATE jobs SET status = 'done'");
    env.DB_ACTIVITY.prepare("DELETE FROM watch_events WHERE account_id = 1");
    env.DB_ACTIVITY_1.prepare("INSERT INTO show_progress (account_id) VALUES (1)");
  });
});
