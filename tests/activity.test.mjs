import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { call, createUser, drainQueue, makeD1, makeEnv, makeQueue, runScheduledTick } from "./harness.mjs";

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
    assert.match(page.text, /id="activityBackfillBtn" data-act="runActivityBackfill" data-act-args="\[false\]" >/);
    const unbound = makeEnv({ DB: makeD1() });
    const page2 = await call(unbound, "/admin", { cookie: await adminCookie(unbound) });
    assert.match(page2.text, /id="activityBackfillBtn" data-act="runActivityBackfill" data-act-args="\[false\]" disabled>/);
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

// --- P3c-4: recording a play (38_activity-scrobble.js) ------------------------

function loadScrobble() {
  const sandbox = { console, URL, TextEncoder, crypto: globalThis.crypto, fetch: async () => new Response("{}", { status: 404 }) };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext("function trackingShowKey(r){const s=String(r==null?'':r);if(!s)return '';if(s.startsWith('tmdb:')){const p=s.split(':');return p.length>=2?p[0]+':'+p[1]:s;}return s.split(':')[0];}", sandbox);
  for (const rel of ["00_constants.js", "29_media.js", "36_activity-db.js", "37_activity-backfill.js", "38_activity-scrobble.js"]) {
    vm.runInContext(read(rel), sandbox, { filename: rel });
  }
  return sandbox;
}

// A D1 binding that counts writes (statements that are not SELECTs).
function countingDb(db) {
  const counter = { writes: 0 };
  const isWrite = (sql) => !/^\s*SELECT\b/i.test(sql);
  const wrapped = {
    _db: db._db,
    prepare: (sql) => {
      const st = db.prepare(sql);
      const w = (s) => ({ _inner: s, bind: (...a) => w(s.bind(...a)), run: () => { if (isWrite(sql)) counter.writes++; return s.run(); }, all: () => s.all(), first: (c) => s.first(c), _sql: sql });
      return w(st);
    },
    batch: (stmts) => { for (const s of stmts) if (isWrite(s._sql)) counter.writes++; return db.batch(stmts.map((s) => s._inner)); },
  };
  return { db: wrapped, counter };
}

async function playEnv({ copied = true } = {}) {
  const main = countingDb(makeD1());
  const act = countingDb(makeD1({ schema: "activity" }));
  main.db._db.exec("INSERT INTO accounts (id, username, display_name, key_hash, created_at) VALUES (7, 'ann', 'Ann', 'h', 0)");
  if (copied) main.db._db.exec("INSERT INTO jobs (type, dedupe_key, account_id, status, run_after, created_at, updated_at) VALUES ('migrate.activity', 'migrate.activity:acct:7', 7, 'done', 0, 0, 0)");
  return { env: { DB: main.db, DB_ACTIVITY: act.db }, main, act };
}

const episodeEntry = (s, e, at) => ({ id: `ep${s}${e}`, type: "episode", showId: "tt0903747", showTitle: "Breaking Bad", seasonNum: s, episodeNum: e, watchedAt: at });

describe("P3c-4: recording a play in the activity database", () => {
  it("an episode: one event and the show's progress, at most four writes, nothing to KV", async () => {
    const sb = loadScrobble();
    const { env, main, act } = await playEnv();
    // The title is known already, as it is after the history copy.
    await sb.resolveMediaBatch(env, [{ id: "tt0903747", type: "series" }], { maxLookups: 0 });
    main.counter.writes = 0;
    const r = await sb.recordActivityPlay(env, "ann", sb.activityPlayFromLegacyEntry(episodeEntry(1, 2, T0)), "ping");
    assert.equal(r.recorded, true, JSON.stringify(r));
    assert.ok(main.counter.writes + act.counter.writes <= 4, `${main.counter.writes} + ${act.counter.writes} writes`);
    const p = act.db._db.prepare("SELECT last_season, last_episode, last_watched_at FROM show_progress WHERE account_id = 7").get();
    assert.deepEqual([p.last_season, p.last_episode, p.last_watched_at], [1, 2, T0]);
    const sched = main.db._db.prepare("SELECT watcher_count FROM show_schedule WHERE media_id = ?").get(r.mediaId);
    assert.equal(sched.watcher_count, 1, "a new watcher of the show");
  });

  it("an earlier episode later does not move progress back, and the watcher is counted once", async () => {
    const sb = loadScrobble();
    const { env, main, act } = await playEnv();
    await sb.recordActivityPlay(env, "ann", sb.activityPlayFromLegacyEntry(episodeEntry(2, 5, T0)), "ping");
    const r = await sb.recordActivityPlay(env, "ann", sb.activityPlayFromLegacyEntry(episodeEntry(1, 3, T0 + H)), "webhook");
    const p = act.db._db.prepare("SELECT last_season, last_episode, last_watched_at FROM show_progress WHERE account_id = 7").get();
    assert.deepEqual([p.last_season, p.last_episode, p.last_watched_at], [2, 5, T0 + H]);
    assert.equal(main.db._db.prepare("SELECT watcher_count FROM show_schedule WHERE media_id = ?").get(r.mediaId).watcher_count, 1);
    assert.equal(act.db._db.prepare("SELECT count(*) AS n FROM watch_events").get().n, 2);
  });

  it("the same play from the ping and the webhook is one play", async () => {
    const sb = loadScrobble();
    const { env, act } = await playEnv();
    const a = await sb.recordActivityPlay(env, "ann", sb.activityPlayFromLegacyEntry({ id: "tt0137523", type: "movie", watchedAt: T0 }), "ping");
    const b = await sb.recordActivityPlay(env, "ann", sb.activityPlayFromLegacyEntry({ id: "tt0137523", type: "movie", watchedAt: T0 + 4 * 60 * 1000 }), "webhook");
    assert.deepEqual([a.recorded, b.recorded, b.reason], [true, false, "duplicate"]);
    const m = act.db._db.prepare("SELECT watched_count, last_watched_at FROM user_media_state").get();
    assert.deepEqual([m.watched_count, m.last_watched_at], [1, T0], "a duplicate is not another play");
    await sb.recordActivityPlay(env, "ann", sb.activityPlayFromLegacyEntry({ id: "tt0137523", type: "movie", watchedAt: T0 + 5 * H }), "ping");
    assert.equal(act.db._db.prepare("SELECT watched_count FROM user_media_state").get().watched_count, 2, "a rewatch is");
  });

  it("does nothing before the account's history is copied, without the database, or for a stranger", async () => {
    const sb = loadScrobble();
    const { env, act } = await playEnv({ copied: false });
    const play = sb.activityPlayFromLegacyEntry(episodeEntry(1, 1, T0));
    assert.equal((await sb.recordActivityPlay(env, "ann", play, "ping")).reason, "not copied yet");
    assert.equal((await sb.recordActivityPlay({ DB: env.DB }, "ann", play, "ping")).reason, "unbound");
    assert.equal((await sb.recordActivityPlay(env, "nobody", play, "ping")).reason, "no account");
    assert.equal(act.db._db.prepare("SELECT count(*) AS n FROM watch_events").get().n, 0);
  });

  it("never throws: a failing database is logged and the legacy write goes on", async () => {
    const sb = loadScrobble();
    const { env } = await playEnv();
    env.DB_ACTIVITY.batch = async () => { throw new Error("down"); };
    const r = await sb.recordActivityPlay(env, "ann", sb.activityPlayFromLegacyEntry(episodeEntry(1, 1, T0)), "ping");
    assert.deepEqual([r.recorded, r.reason], [false, "error"]);
  });

  it("the ping and the webhook routes call it after their legacy write", () => {
    const src = read("26_api-creator-and-admin-routes.js");
    assert.match(src, /saveCreatorTrackingD1\(env, auth\.username, blob, false\);\s*\}\s*\/\/[^\n]*\n[^\n]*\n\s*await recordActivityPlay\(env, auth\.username, activityPlayFromLegacyEntry\(blob\.watchHistory\[0\]\), "ping"\)/);
    assert.match(src, /recordActivityPlay\(env, authUser, activityPlayFromLegacyEntry\(blob\.watchHistory\[0\]\), "webhook"\)/);
  });
});

// --- P3c-5: the shelves (39_activity-shelves.js) -------------------------------

// Results from the sandbox, as plain data (arrays made in another realm are
// never deepStrictEqual to ours).
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

const SHELF_NOW = Date.UTC(2026, 2, 1, 12, 0, 0); // 2026-03-01

// Nine titles, each showing one rule.
function shelfFixture() {
  const main = makeD1();
  const act = makeD1({ schema: "activity" });
  const db = main._db;
  db.exec("INSERT INTO accounts (id, username, display_name, key_hash, created_at) VALUES (7, 'ann', 'Ann', 'h', 0)");
  const media = [
    [1, "series", "tt0903747", 1396, "Breaking Bad", "/bb.jpg"],
    [2, "series", "tt0944947", 1399, "Game of Thrones", null],
    [3, "series", "tt0386676", 2316, "The Office", null],
    [4, "movie", "tt0120737", 120, "The Fellowship", null],
    [5, "series", "tt11280740", 95396, "Severance", null],
    [6, "series", "tt0000006", null, "Dismissed Show", null],
    [7, "series", "tt0000007", null, "Hidden From Airing", null],
    [8, "series", "tt0000008", null, "Not Refreshed Yet", null],
    [9, "movie", "tt0137523", 550, "Fight Club", null],
  ];
  for (const [id, kind, imdb, tmdb, title, poster] of media) {
    db.prepare("INSERT INTO media (id, kind, imdb_id, tmdb_id, title, poster_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0)").run(id, kind, imdb, tmdb, title, poster);
  }
  const sched = db.prepare(`INSERT INTO show_schedule (media_id, status, last_aired_season, last_aired_episode, last_aired_date, next_season, next_episode,
    next_air_date, next_air_time, air_tz, season_finale_season, season_finale_date, season_finale_episode, season_episode_counts, watcher_count, next_check_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`);
  // Finished show: the counts say season 2 comes after S1E7.
  sched.run(1, "Ended", 2, 13, "2013-09-29", null, null, null, null, null, 2, "2013-09-29", 13, JSON.stringify({ 1: 7, 2: 13 }));
  // Between seasons: season 2 announced for April (its counts not in yet).
  sched.run(2, "Returning Series", 1, 10, "2011-06-19", 2, 1, "2026-04-01", null, null, 2, "2026-06-01", 10, JSON.stringify({ 1: 10 }));
  sched.run(3, "Ended", 9, 23, "2013-05-16", null, null, null, null, null, null, null, null, null);
  // Airing: the finale is next, on the 20th at 9 PM Eastern.
  sched.run(5, "Returning Series", 2, 9, "2026-02-20", 2, 10, "2026-03-20", "21:00", "America/New_York", 2, "2026-03-20", 10, null);
  sched.run(6, "Ended", 1, 8, "2020-01-01", null, null, null, null, null, null, null, null, null);
  sched.run(7, "Returning Series", 1, 5, "2026-02-01", 1, 6, "2026-03-08", null, null, null, null, null, null);

  const p = act._db.prepare(`INSERT INTO show_progress (account_id, media_id, last_season, last_episode, last_watched_at, status,
    dismissed_at_season, dismissed_at_episode, airing_hidden_at_season, airing_hidden_at_episode, companion_json, updated_at)
    VALUES (7, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`);
  p.run(1, 1, 7, 900, "watching", null, null, null, null, null);
  p.run(2, 1, 10, 800, "completed", null, null, null, null, null);
  p.run(3, 2, 0, 700, "watching", null, null, null, null, null);   // in Continue Watching with no history
  p.run(4, null, null, 600, "watching", null, null, null, null, JSON.stringify({ id: "tt0120737", type: "movie", name: "The Fellowship", isCompanion: true, companionType: "sequel_movie", companionStoryline: "Middle-earth" }));
  p.run(5, 2, 9, 1000, "watching", null, null, null, null, null);
  p.run(6, 1, 3, 500, "watching", 1, 3, null, null, null);        // dismissed at the furthest episode watched
  p.run(7, 1, 5, 400, "watching", null, null, 1, 5, null);         // removed from Airing Next at it
  p.run(8, 1, 1, 300, "watching", null, null, null, null, null);   // no schedule yet
  return { env: { DB: main, DB_ACTIVITY: act }, main, act };
}

describe("P3c-5: the shelves, worked out when read", () => {
  it("Continue Watching: the next episode of each show, suggestions kept, dismissals honoured", async () => {
    const sb = loadShelves();
    const { env } = shelfFixture();
    const cw = plain(await sb.continueWatching(env, 7, { now: SHELF_NOW }));
    const brief = cw.items.map((i) => [i.showTitle || i.name, i.seasonNum, i.episodeNum, !!i.isUnaired, !!i.isSeasonPremiere, !!i.isSeasonFinale]);
    assert.deepEqual(brief, [
      ["Severance", 2, 10, true, false, true],          // the finale, not aired yet
      ["Breaking Bad", 2, 1, false, true, false],        // across a season, from the counts
      ["Game of Thrones", 2, 1, true, true, false],      // finished, but a new season is announced
      ["The Office", 2, 1, false, true, false],          // (2, 0): nothing of season 2 yet
      ["The Fellowship", undefined, undefined, false, false, false],  // the storyline suggestion, as it was
      ["Hidden From Airing", 1, 6, true, false, false],  // only Airing Next was hidden
    ]);
    assert.equal(cw.items[1].id, "tt0903747:2:1");
    assert.equal(cw.items[1].showPoster, "https://image.tmdb.org/t/p/w500/bb.jpg");
    assert.equal(cw.items[4].companionType, "sequel_movie");
    assert.equal(cw.items[0].seasonFinaleAirDate, "2026-03-20");
    assert.deepEqual([...cw.missingSchedule], [8]);
  });

  it("a dismissal stops standing once a later episode is watched", async () => {
    const sb = loadShelves();
    const { env, act } = shelfFixture();
    act._db.exec("UPDATE show_progress SET last_episode = 4 WHERE media_id = 6");
    const cw = plain(await sb.continueWatching(env, 7, { now: SHELF_NOW }));
    const d = cw.items.find((i) => i.mediaId === 6);
    assert.deepEqual([d.seasonNum, d.episodeNum], [1, 5]);
  });

  it("Airing Next: unaired next episodes, soonest first, with finale badges and air times", async () => {
    const sb = loadShelves();
    const { env } = shelfFixture();
    const an = plain(await sb.airingNext(env, 7, { now: SHELF_NOW }));
    assert.deepEqual(an.items.map((i) => [i.showTitle, i.airDate, i.seasonNum, i.episodeNum]), [
      ["Severance", "2026-03-20", 2, 10],
      ["Game of Thrones", "2026-04-01", 2, 1],
    ], "Hidden From Airing stays off; finished shows with nothing coming are not there");
    const sev = an.items[0];
    assert.deepEqual([sev.isSeasonFinale, sev.isSeasonPremiere, sev.seasonFinaleEpisodeNumber, sev.airTime, sev.isUnaired], [true, undefined, 10, "9 PM ET", true]);
    const got = an.items[1];
    assert.deepEqual([got.isSeasonPremiere, got.isSeasonFinale, got.name, got.canonicalTmdbId], [true, undefined, "Season Premiere", "1399"]);
    assert.deepEqual([...an.missingSchedule], [8]);
    // Once the episode has aired it leaves Airing Next.
    const later = plain(await sb.airingNext(env, 7, { now: Date.UTC(2026, 2, 25) }));
    assert.deepEqual(later.items.map((i) => i.showTitle), ["Game of Thrones"]);
  });

  it("an Airing Next removal stops standing once a later episode is watched", async () => {
    const sb = loadShelves();
    const { env, act } = shelfFixture();
    act._db.exec("UPDATE show_progress SET last_episode = 6 WHERE media_id = 7");
    env.DB._db.exec("UPDATE show_schedule SET last_aired_episode = 6, next_episode = 7, next_air_date = '2026-03-15' WHERE media_id = 7");
    const an = plain(await sb.airingNext(env, 7, { now: SHELF_NOW }));
    assert.ok(an.items.some((i) => i.mediaId === 7 && i.episodeNum === 7));
  });

  it("uses two queries and a join, whatever the number of shows (90 titles a query)", async () => {
    const sb = loadShelves();
    const { env, main, act } = shelfFixture();
    for (let i = 100; i < 300; i++) {
      main._db.prepare("INSERT INTO media (id, kind, imdb_id, title, created_at, updated_at) VALUES (?, 'series', ?, ?, 0, 0)").run(i, `tt9${i}`, `Show ${i}`);
      act._db.prepare("INSERT INTO show_progress (account_id, media_id, last_season, last_episode, last_watched_at, updated_at) VALUES (7, ?, 1, 1, ?, 0)").run(i, i);
    }
    let mainQueries = 0;
    let actQueries = 0;
    const count = (db, bump) => ({ ...db, prepare: (sql) => { bump(); return db.prepare(sql); } });
    const counted = { DB: count(main, () => mainQueries++), DB_ACTIVITY: count(act, () => actQueries++) };
    const cw = plain(await sb.continueWatching(counted, 7, { now: SHELF_NOW }));
    assert.equal(actQueries, 1);
    assert.equal(mainQueries, 3, "203 shows: three chunks of at most 90");
    assert.equal(cw.missingSchedule.length + cw.items.length <= 1000, true);
  });

  it("Watch History pages newest first, and names episodes and movies", async () => {
    const sb = loadShelves();
    const { env, act } = shelfFixture();
    const ins = act._db.prepare("INSERT INTO watch_events (account_id, media_id, season, episode, watched_at, source, dedupe_key) VALUES (7, ?, ?, ?, ?, 'ping', ?)");
    ins.run(1, 1, 1, 100, "a");
    ins.run(9, null, null, 300, "b");
    ins.run(1, 1, 2, 200, "c");
    ins.run(5, 2, 9, 300, "d");
    const first = plain(await sb.watchHistoryPage(env, 7, { limit: 3 }));
    assert.deepEqual(first.items.map((i) => [i.id, i.type, i.watchedAt]), [
      ["tt11280740:2:9", "episode", 300],
      ["tt0137523", "movie", 300],
      ["tt0903747:1:2", "episode", 200],
    ]);
    assert.equal(first.items[1].name, "Fight Club");
    assert.ok(first.cursor);
    const second = plain(await sb.watchHistoryPage(env, 7, { limit: 3, cursor: first.cursor }));
    assert.deepEqual(second.items.map((i) => i.id), ["tt0903747:1:1"]);
    assert.equal(second.cursor, null);
  });

  it("the Watchlist is the account's watchlist list", async () => {
    const sb = loadShelves();
    const { env, main } = shelfFixture();
    assert.equal(plain(await sb.watchlistShelf(env, 7)).items.length, 0);
    main._db.exec(`INSERT INTO lists (id, public_id, owner_account_id, slug, name, media_type, visibility, kind, created_at, updated_at)
      VALUES (50, 'wl7', 7, 'watchlist', 'Watchlist', 'mixed', 'private', 'watchlist', 0, 5)`);
    main._db.exec("INSERT INTO list_items (list_id, media_id, position, added_at) VALUES (50, 9, 0, 0), (50, 1, 1, 0)");
    const wl = plain(await sb.watchlistShelf(env, 7));
    assert.deepEqual(wl.items.map((i) => i.id), ["tt0137523", "tt0903747"]);
  });

  it("works without migration 0017: titles only, every show named as missing a schedule", async () => {
    const sb = loadShelves();
    const { env } = shelfFixture();
    env.DB._db.exec("DROP TABLE show_schedule");
    const cw = plain(await sb.continueWatching(env, 7, { now: SHELF_NOW }));
    assert.deepEqual(cw.items.map((i) => i.name), ["The Fellowship"]);
    assert.equal(cw.missingSchedule.length, 6);
  });
});

// --- P3c-6: the tracking record served from the activity database -------------

async function eventTrackingSetup(extra = {}) {
  const env = activityEnv({ FF_EVENT_TRACKING: "1", ...extra });
  const user = await createUser(env, "annwatch");
  await seedLegacyActivity(env, "annwatch");
  const cookie = await adminCookie(env);
  await runActivityBackfill(env, cookie);
  return { env, user, cookie };
}

const creds = (user) => ({ creatorName: user.creatorName, creatorKey: user.creatorKey });
const loadTracking = async (env, user) => (await call(env, "/api/creator/sync/load", { method: "POST", json: creds(user) })).body.data;
const saveTrackingV2 = (env, user, body) => call(env, "/api/creator/sync/save-tracking", { method: "POST", json: { ...creds(user), ...body } });

function legacyTrackingStores(env) {
  const kv = [...env.CONFIGS._store.entries()].filter(([k]) => /^(creatorsynctracking|creatorscrobblequeue|trackingd1behind):/.test(k)).sort();
  const tables = {};
  for (const t of ["watch_history", "continue_watching", "airing_next", "creator_show_states", "creator_tracking_meta"]) {
    tables[t] = env.DB._db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all();
  }
  return JSON.stringify({ kv, tables });
}

// Audit CFG-001: with the flag on and DB_ACTIVITY lost, a copied account used
// to read an empty legacy store and write into a frozen one.
describe("FF_EVENT_TRACKING with DB_ACTIVITY unbound", () => {
  it("refuses a copied account's tracking with a 503 and writes nothing, then recovers when the binding returns", async () => {
    const { env, user } = await eventTrackingSetup();
    const before = legacyTrackingStores(env);
    const binding = env.DB_ACTIVITY;
    const data = await loadTracking(env, user);
    assert.ok(data.watchHistory.length > 0);

    env.DB_ACTIVITY = undefined;
    const load = await call(env, "/api/creator/sync/load", { method: "POST", json: creds(user) });
    assert.equal(load.status, 503, JSON.stringify(load.body));
    assert.equal(load.body.ok, false);
    const save = await saveTrackingV2(env, user, { ...data, trackPlayback: true, expectedClientVersion: data.trackingClientVersion });
    assert.equal(save.status, 503, JSON.stringify(save.body));
    assert.equal(legacyTrackingStores(env), before, "nothing landed in the frozen legacy stores");

    env.DB_ACTIVITY = binding;
    const back = await loadTracking(env, user);
    assert.deepEqual(back.watchHistory.map((it) => it.id), data.watchHistory.map((it) => it.id), "the history is all still there");
  });

  it("an account that has not been copied yet still works on the legacy stores", async () => {
    const { env } = await eventTrackingSetup();
    const other = await createUser(env, "notcopied");
    env.DB_ACTIVITY = undefined;
    const r = await call(env, "/api/creator/sync/load", { method: "POST", json: creds(other) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
});

describe("P3c-6: with FF_EVENT_TRACKING, a copied account is served from the activity database", () => {
  it("/sync/load hands back the same history ids and settings, from v2", async () => {
    const { env, user } = await eventTrackingSetup();
    const data = await loadTracking(env, user);
    const ids = new Set(data.watchHistory.map((it) => it.id));
    for (const id of ["e1", "e2", "tt0137523", "tt0944947:2:3", "tt0068646", "e4"]) assert.ok(ids.has(id), `history has ${id}`);
    assert.deepEqual(data.fullyWatchedShowIds, ["tt0944947"]);
    assert.deepEqual(data.dismissedContinueWatching, { tt0903747: { seasonNum: 1, episodeNum: 2 } });
    assert.equal(data.continueWatching.length, 3, "Continue Watching as last computed, until FF_SHOW_SCHEDULE");
  });

  it("save-tracking adds new plays to v2 and writes nothing to the legacy tracking stores", async () => {
    const { env, user } = await eventTrackingSetup();
    const before = legacyTrackingStores(env);
    const data = await loadTracking(env, user);
    const history = [{ id: "e5", type: "episode", showId: "tt0903747", showTitle: "Breaking Bad", seasonNum: 1, episodeNum: 5, watchedAt: T0 + 6 * H }, ...data.watchHistory];
    const r = await saveTrackingV2(env, user, { ...data, watchHistory: history, trackPlayback: true, expectedClientVersion: data.trackingClientVersion });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.equal(legacyTrackingStores(env), before, "no KV or D1 tracking write");
    const id = accountId(env, "annwatch");
    const e5 = env.DB_ACTIVITY._db.prepare("SELECT season, episode, source FROM watch_events WHERE account_id = ? AND legacy_id = 'e5'").get(id);
    assert.deepEqual([e5.season, e5.episode, e5.source], [1, 5, "web"]);
    const again = await loadTracking(env, user);
    assert.equal(again.trackPlayback, true);
    assert.equal(again.watchHistory[0].id, "e5");
    const bb = env.DB_ACTIVITY._db.prepare("SELECT last_episode FROM show_progress WHERE account_id = ? AND media_id = ?").get(id, mediaIdBy(env, "imdb_id", "tt0903747"));
    assert.equal(bb.last_episode, 5, "progress follows");
  });

  it("an entry left out is removed only when the save is an intentional removal", async () => {
    const { env, user } = await eventTrackingSetup();
    const id = accountId(env, "annwatch");
    const count = () => env.DB_ACTIVITY._db.prepare("SELECT count(*) AS n FROM watch_events WHERE account_id = ?").get(id).n;
    const n = count();
    let data = await loadTracking(env, user);
    const without = data.watchHistory.filter((it) => it.id !== "tt0137523");
    await saveTrackingV2(env, user, { ...data, watchHistory: without, expectedClientVersion: data.trackingClientVersion });
    assert.equal(count(), n, "an ordinary save never shortens the history");
    data = await loadTracking(env, user);
    const r = await saveTrackingV2(env, user, { ...data, watchHistory: without, intentionalRemoval: true, expectedClientVersion: data.trackingClientVersion });
    assert.equal(r.body.ok, true);
    assert.equal(count(), n - 1);
    assert.ok(!(await loadTracking(env, user)).watchHistory.some((it) => it.id === "tt0137523"));
  });

  it("an account whose history is not copied yet stays on the legacy stores", async () => {
    const env = activityEnv({ FF_EVENT_TRACKING: "1" });
    const user = await createUser(env, "newcomer");
    const r = await saveTrackingV2(env, user, { watchHistory: [{ id: "tt0137523", type: "movie", watchedAt: T0 }] });
    assert.equal(r.body.ok, true);
    const blob = JSON.parse(await env.CONFIGS.get("creatorsynctracking:newcomer"));
    assert.equal(blob.watchHistory[0].id, "tt0137523");
    assert.equal(env.DB_ACTIVITY._db.prepare("SELECT count(*) AS n FROM watch_events").get().n, 0);
  });

  it("without the flag nothing changes: the legacy stores are written", async () => {
    const env = activityEnv();
    const user = await createUser(env, "annwatch");
    await seedLegacyActivity(env, "annwatch");
    await runActivityBackfill(env, await adminCookie(env));
    const data = await loadTracking(env, user);
    await saveTrackingV2(env, user, { ...data, watchHistory: [{ id: "zz", type: "movie", watchedAt: T0 }, ...data.watchHistory], expectedClientVersion: data.trackingClientVersion });
    const blob = JSON.parse(await env.CONFIGS.get("creatorsynctracking:annwatch"));
    assert.ok(blob.watchHistory.some((it) => it.id === "zz"), "the legacy record holds the new entry");
  });

  // Release 17: an account made after the copy finished was never copied --
  // the finished run stayed finished, and Start over is refused with the flag
  // on -- so its history stayed in the legacy stores (39 of 748 accounts).
  async function lateAccount(env) {
    const late = await createUser(env, "latecomer");
    const r = await saveTrackingV2(env, late, { watchHistory: [{ id: "tt0068646", type: "movie", watchedAt: T0 + 9 * H }] });
    assert.equal(r.body.ok, true);
    assert.ok(JSON.parse(await env.CONFIGS.get("creatorsynctracking:latecomer")).watchHistory.length, "on the legacy store for now");
    return late;
  }
  const copiedEvents = (env, username) => env.DB_ACTIVITY._db.prepare("SELECT count(*) AS n FROM watch_events WHERE account_id = ?").get(accountId(env, username)).n;
  const copyJob = (env, username) => env.DB._db.prepare("SELECT status FROM jobs WHERE dedupe_key = ?").get(`migrate.activity:acct:${accountId(env, username)}`);

  it("Copy history takes on accounts made after the copy finished", async () => {
    const { env, cookie } = await eventTrackingSetup();
    const late = await lateAccount(env);
    const steps = await runActivityBackfill(env, cookie);
    assert.equal(steps[steps.length - 1].done, true);
    assert.equal(copyJob(env, "latecomer").status, "done");
    assert.equal(copiedEvents(env, "latecomer"), 1);
    // From here it is served from the activity database.
    const data = await loadTracking(env, late);
    assert.equal(data.watchHistory[0].id, "tt0068646");
  });

  it("the hourly activity.copy-new job copies them without anyone pressing anything", async () => {
    const { env } = await eventTrackingSetup({ JOBS: makeQueue() });
    await lateAccount(env);
    // The first tick makes the periodic rows; then run only this job.
    await runScheduledTick(env);
    env.JOBS._pending.length = 0;
    env.DB._db.exec("UPDATE jobs SET run_after = 9999999999999 WHERE dedupe_key LIKE 'periodic:%' AND dedupe_key != 'periodic:activity.copy-new'");
    env.DB._db.exec("UPDATE jobs SET run_after = 1 WHERE dedupe_key = 'periodic:activity.copy-new'");
    await runScheduledTick(env);
    env.JOBS._pending.splice(0, env.JOBS._pending.length, ...env.JOBS._pending.filter((m) => m.body.type === "activity.copy-new"));
    await drainQueue(env);
    assert.equal(copyJob(env, "latecomer").status, "done");
    assert.equal(copiedEvents(env, "latecomer"), 1);
    const row = env.DB._db.prepare("SELECT progress_json, last_error FROM jobs WHERE dedupe_key = 'periodic:activity.copy-new'").get();
    assert.equal(row.last_error, null);
    assert.equal(JSON.parse(row.progress_json).lastRun.done, true);
  });

  it("the copy cannot start over while the flag is on", async () => {
    const { env, cookie } = await eventTrackingSetup();
    const r = await call(env, "/admin/api/activity-backfill/step", { method: "POST", cookie, json: { restart: true } });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /FF_EVENT_TRACKING/);
  });
});

// --- Episode names, and no cap on Watch History (the release branch) ----------
//
// FF_SHOW_SCHEDULE: Continue Watching and Airing Next worked out from the show
// schedule (39_) instead of served as the writers stored them (Release 18).
describe("FF_SHOW_SCHEDULE: the shelves worked out from the schedule", () => {
  it("keeps the stored entry of a show the schedule does not know yet, and works out the rest", async () => {
    const { env, user } = await eventTrackingSetup({ FF_SHOW_SCHEDULE: "1" });
    // No schedule rows yet: Breaking Bad and The Office are not known, so they
    // keep their stored entries; the storyline suggestion is kept whole.
    let data = await loadTracking(env, user);
    assert.deepEqual(data.continueWatching.map((it) => it.id).sort(), ["e3", "tt0120737", "x1"]);

    // The Office's schedule arrives: its entry is worked out (S2E1, after the
    // copy's "nothing of season 2 yet"), and the stored one is not repeated.
    const office = mediaIdBy(env, "imdb_id", "tt0386676");
    env.DB._db.prepare(
      `INSERT INTO show_schedule (media_id, status, last_aired_season, last_aired_episode, last_aired_date, season_episode_counts, watcher_count, checked_at, next_check_at)
       VALUES (?, 'Ended', 9, 23, '2013-05-16', '{"2":22,"9":23}', 1, 1, 9999999999999)`
    ).run(office);
    data = await loadTracking(env, user);
    assert.deepEqual(data.continueWatching.map((it) => it.id).sort(), ["e3", "tt0120737", "tt0386676:2:1"]);
  });
});

// With FF_EVENT_TRACKING, Watch History comes from the activity database, which
// records a play as a title and an episode number -- so every episode showed as
// "Episode N" with the show poster, and the record stopped at the newest 5,000
// plays. The names now live once per episode in media_episodes (migration
// 0020, 29_media.js), written by the plays, a website save and the history
// copy; and the record holds every play, as the legacy record did.

describe("Watch History from the activity database: episode names, and every play", () => {
  it("names an episode as media_episodes has it, with its still; an unnamed one stays Episode N", async () => {
    const sb = loadShelves();
    const { env, main, act } = shelfFixture();
    const ins = act._db.prepare("INSERT INTO watch_events (account_id, media_id, season, episode, watched_at, source, dedupe_key) VALUES (7, ?, ?, ?, ?, 'ping', ?)");
    ins.run(1, 1, 1, 100, "a");
    ins.run(1, 1, 2, 200, "b");
    main._db.prepare("INSERT INTO media_episodes (media_id, season, episode, title, image, updated_at) VALUES (1, 1, 2, ?, ?, 0)")
      .run("Cat's in the Bag...", "https://image.tmdb.org/t/p/w500/s1e2.jpg");
    const page = plain(await sb.watchHistoryPage(env, 7, { limit: 10 }));
    assert.equal(page.items[0].name, "Cat's in the Bag...");
    assert.equal(page.items[0].poster, "https://image.tmdb.org/t/p/w500/s1e2.jpg");
    assert.equal(page.items[0].showPoster, "https://image.tmdb.org/t/p/w500/bb.jpg", "the show keeps its own poster");
    assert.equal(page.items[1].name, "Episode 1", "no name known: the placeholder, as before");
    assert.equal(page.items[1].poster, page.items[1].showPoster);
  });

  it("works on a database without 0020: every episode is Episode N, nothing breaks", async () => {
    const sb = loadShelves();
    const { env, main, act } = shelfFixture();
    main._db.exec("DROP TABLE media_episodes");
    act._db.prepare("INSERT INTO watch_events (account_id, media_id, season, episode, watched_at, source, dedupe_key) VALUES (7, 1, 1, 3, 100, 'ping', 'x')").run();
    const page = plain(await sb.watchHistoryPage(env, 7, { limit: 10 }));
    assert.equal(page.items[0].name, "Episode 3");
  });

  it("a play keeps its episode's name and still, and the same play again writes nothing more", async () => {
    const sb = loadScrobble();
    const { env, main, act } = await playEnv();
    await sb.resolveMediaBatch(env, [{ id: "tt0903747", type: "series" }], { maxLookups: 0 });
    const named = { ...episodeEntry(1, 3, T0), name: "...And the Bag's in the River", poster: "https://image.tmdb.org/t/p/w500/s1e3.jpg", showPoster: "https://image.tmdb.org/t/p/w500/bb.jpg" };
    const r = await sb.recordActivityPlay(env, "ann", sb.activityPlayFromLegacyEntry(named), "ping");
    assert.equal(r.recorded, true, JSON.stringify(r));
    const row = main.db._db.prepare("SELECT title, image FROM media_episodes WHERE media_id = ? AND season = 1 AND episode = 3").get(r.mediaId);
    assert.deepEqual([row.title, row.image], ["...And the Bag's in the River", "https://image.tmdb.org/t/p/w500/s1e3.jpg"]);
    main.db._db.prepare("UPDATE media_episodes SET updated_at = 1").run();
    await sb.recordActivityPlay(env, "ann", sb.activityPlayFromLegacyEntry({ ...named, watchedAt: T0 + 5 * H }), "ping");
    const again = main.db._db.prepare("SELECT title, updated_at FROM media_episodes WHERE media_id = ?").all(r.mediaId);
    assert.equal(again.length, 1, "one row per episode");
    assert.equal(again[0].updated_at, 1, "the same name again is not a write");
    await sb.recordActivityPlay(env, "ann", sb.activityPlayFromLegacyEntry({ ...named, name: "Episode 3", poster: "", watchedAt: T0 + 9 * H }), "ping");
    assert.equal(main.db._db.prepare("SELECT title FROM media_episodes WHERE media_id = ?").get(r.mediaId).title,
      "...And the Bag's in the River", "a later play without the name does not blank it");
  });

  it("does not take a show's name, the placeholder, or the show poster for the episode's", () => {
    const sb = loadScrobble();
    const plainOf = (v) => JSON.parse(JSON.stringify(v));
    assert.deepEqual(plainOf(sb.episodeTitleFromLegacy({ showId: "tt1", showTitle: "Show", name: "Pilot", poster: "https://x/still.jpg", showPoster: "https://x/show.jpg" })),
      { title: "Pilot", image: "https://x/still.jpg" });
    assert.equal(sb.episodeTitleFromLegacy({ showId: "tt1", name: "Episode 4", poster: "https://x/show.jpg", showPoster: "https://x/show.jpg" }), null);
    assert.equal(sb.episodeTitleFromLegacy({ showId: "tt1", showTitle: "Show", name: "Show" }), null);
    assert.equal(sb.episodeTitleFromLegacy({ id: "tt0944947:2:3", type: "episode", name: "Game of Thrones" }), null,
      "an entry saved without its show carries the show's name, not the episode's");
    assert.equal(sb.episodeTitleFromLegacy({ showId: "tt1", poster: "https://images.metahub.space/poster/medium/tt1/img" }), null);
  });

  it("the history copy brings the legacy names over, and /sync/load shows them", async () => {
    const env = activityEnv({ FF_EVENT_TRACKING: "1" });
    const user = await createUser(env, "namedwatch");
    await env.CONFIGS.put("creatorsynctracking:namedwatch", JSON.stringify({
      updatedAt: T0 + 5 * H,
      watchHistory: [
        { id: "n1", type: "episode", showId: "tt0903747", showTitle: "Breaking Bad", seasonNum: 1, episodeNum: 1, name: "Pilot", poster: "https://image.tmdb.org/t/p/w500/p1.jpg", showPoster: "https://image.tmdb.org/t/p/w500/bb.jpg", watchedAt: T0 },
        { id: "n2", type: "episode", showId: "tt0903747", showTitle: "Breaking Bad", seasonNum: 1, episodeNum: 2, name: "Cat's in the Bag...", watchedAt: T0 + H },
        { id: "tt0137523", type: "movie", name: "Fight Club", watchedAt: T0 + 2 * H },
      ],
    }));
    await runActivityBackfill(env, await adminCookie(env));
    const data = (await call(env, "/api/creator/sync/load", { method: "POST", json: { creatorName: user.creatorName, creatorKey: user.creatorKey } })).body.data;
    const byId = new Map(data.watchHistory.map((it) => [it.id, it]));
    assert.equal(byId.get("n1").name, "Pilot");
    assert.equal(byId.get("n1").poster, "https://image.tmdb.org/t/p/w500/p1.jpg");
    assert.equal(byId.get("n2").name, "Cat's in the Bag...");
    assert.equal(byId.get("tt0137523").name, "Fight Club");
  });

  it("a website save names the episodes it adds", async () => {
    const { env, user } = await eventTrackingSetup();
    const data = await loadTracking(env, user);
    const added = { id: "e9", type: "episode", showId: "tt0903747", showTitle: "Breaking Bad", seasonNum: 1, episodeNum: 6, name: "Crazy Handful of Nothin'", watchedAt: T0 + 7 * H };
    const r = await saveTrackingV2(env, user, { ...data, watchHistory: [added, ...data.watchHistory], expectedClientVersion: data.trackingClientVersion });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    const again = await loadTracking(env, user);
    assert.equal(again.watchHistory.find((it) => it.id === "e9").name, "Crazy Handful of Nothin'");
  });

  it("hands back every play, not just the newest 5,000", async () => {
    const { env, user } = await eventTrackingSetup();
    const id = accountId(env, "annwatch");
    const fightClub = mediaIdBy(env, "imdb_id", "tt0137523");
    const before = (await loadTracking(env, user)).watchHistory.length;
    const ins = env.DB_ACTIVITY._db.prepare("INSERT INTO watch_events (account_id, media_id, season, episode, watched_at, source, dedupe_key, legacy_id) VALUES (?, ?, NULL, NULL, ?, 'web', ?, ?)");
    env.DB_ACTIVITY._db.exec("BEGIN");
    for (let i = 0; i < 5200; i++) ins.run(id, fightClub, T0 - (i + 1) * H, `bulk${i}`, `bulk${i}`);
    env.DB_ACTIVITY._db.exec("COMMIT");
    const data = await loadTracking(env, user);
    assert.equal(data.watchHistory.length, before + 5200);
    assert.equal(data.watchHistory[data.watchHistory.length - 1].id, "bulk5199", "the oldest play is there too");
  });
});

// The live site turns on FF_V2_LISTS_ONLY and FF_EVENT_TRACKING within a day of
// each other, so the watch-history journeys must hold with both on: the
// Watchlist that save-tracking carries is a list (v2 only), and everything
// else is the activity database.
describe("FF_EVENT_TRACKING together with FF_V2_LISTS_ONLY", () => {
  const both = { FF_V2_LISTS_READ: "1", FF_V2_LISTS_ONLY: "1" };

  it("loads, adds a play with its name, and keeps a Watchlist change", async () => {
    const { env, user } = await eventTrackingSetup(both);
    const data = await loadTracking(env, user);
    assert.ok(data.watchHistory.length >= 5, `history served: ${data.watchHistory.length}`);
    const added = { id: "e8", type: "episode", showId: "tt0903747", showTitle: "Breaking Bad", seasonNum: 1, episodeNum: 7, name: "A No-Rough-Stuff-Type Deal", watchedAt: T0 + 8 * H };
    const watchlist = [{ id: "tt0133093", type: "movie", name: "The Matrix" }];
    const r = await saveTrackingV2(env, user, { ...data, watchHistory: [added, ...data.watchHistory], watchlist, watchlistUpdatedAt: T0 + 8 * H, expectedClientVersion: data.trackingClientVersion });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    const again = await loadTracking(env, user);
    assert.equal(again.watchHistory[0].id, "e8");
    assert.equal(again.watchHistory[0].name, "A No-Rough-Stuff-Type Deal");
    assert.deepEqual(again.watchlist.map((it) => it.id), ["tt0133093"], "the Watchlist is a v2 list and keeps the change");
    assert.equal(await env.CONFIGS.get(`creatorlist:${user.creatorName}:watchlist`), null, "nothing written to the old list storage");
  });

  it("an intentional removal holds", async () => {
    const { env, user } = await eventTrackingSetup(both);
    const data = await loadTracking(env, user);
    const without = data.watchHistory.filter((it) => it.id !== "tt0137523");
    const r = await saveTrackingV2(env, user, { ...data, watchHistory: without, intentionalRemoval: true, expectedClientVersion: data.trackingClientVersion });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.ok(!(await loadTracking(env, user)).watchHistory.some((it) => it.id === "tt0137523"));
  });
});
