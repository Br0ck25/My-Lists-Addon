// Comprehensive migration verification test suite for Phase 9 (P9-2).
// Runs across anonymized production-shaped data fixtures to prove that schema
// upgrades, backfills, and v2 transitions preserve 100% of accounts, lists,
// likes, channels, watch history, and installs without data loss.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  makeEnv,
  makeD1,
  makeKv,
  makeR2,
  call,
} from "./harness.mjs";

import {
  TEST_TOKEN_KEY,
  MIGRATION_TMDB_FIXTURES,
  MIGRATION_FIXTURES,
  seedLegacyProductionFixtures,
  snapshotLegacyStores,
} from "./fixtures/migration-fixtures.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

async function adminCookie(env) {
  const r = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
  const m = (r.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/);
  return m ? m[1] : "";
}

function withFakeTmdb({ finds = {}, shows = {}, movies = {} } = {}) {
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    if (u.hostname !== "api.themoviedb.org") return new Response("{}", { status: 404 });
    const parts = u.pathname.split("/");
    const kind = parts[2];
    const id = parts[3];
    const body = kind === "find" ? (finds[id] || { movie_results: [], tv_results: [] })
      : kind === "tv" ? shows[id]
      : kind === "movie" ? movies[id]
      : null;
    return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response("{}", { status: 404 });
  };
  return () => { globalThis.fetch = real; };
}

describe("P9-2: Migration Test Suite with Production Fixtures", () => {

  // ---------------------------------------------------------------------------
  // 1. Schema Upgrade Sequence
  // ---------------------------------------------------------------------------
  describe("1. Schema Migration Execution (0001a through 0020 & A0001)", () => {
    it("applies every SQL migration in sequence to a populated legacy database without error", () => {
      const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      const db = new DatabaseSync(":memory:");

      // Start with the baseline pre-migration tables
      db.exec(`
        CREATE TABLE creators (
          username TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          key_hash TEXT NOT NULL,
          recovery_answer_hash TEXT,
          created_at INTEGER NOT NULL,
          last_active INTEGER
        );
        CREATE TABLE creator_lists (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          visibility TEXT NOT NULL DEFAULT 'private',
          items_json TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (username) REFERENCES creators(username) ON DELETE CASCADE
        );
        CREATE TABLE source_groups (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          install_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_creator_lists_username ON creator_lists(username);
        CREATE INDEX idx_creator_lists_visibility ON creator_lists(visibility);
      `);

      // Seed representative legacy records
      db.prepare(`
        INSERT INTO creators (username, display_name, key_hash, created_at)
        VALUES ('pre_mig_user', 'Pre-Migration User', 'hash123', 1700000000000)
      `).run();
      db.prepare(`
        INSERT INTO creator_lists (id, username, name, type, visibility, items_json, created_at, updated_at)
        VALUES ('pre_mig_user:initial-picks', 'pre_mig_user', 'Initial Picks', 'movie', 'public', '[]', 1700000000000, 1700000000000)
      `).run();

      // Read and execute all migrations in order
      const migrationFiles = fs.readdirSync(path.join(REPO_ROOT, "migrations"))
        .filter((f) => f.endsWith(".sql"))
        .sort();

      assert.ok(migrationFiles.length >= 20, `expected at least 20 migration files, got ${migrationFiles.length}`);

      for (const file of migrationFiles) {
        const sql = read(path.join("migrations", file));
        assert.doesNotThrow(() => {
          db.exec(sql);
        }, `Migration ${file} must apply cleanly on populated database`);
      }

      // Verify schema_migrations ledger recorded migrations
      const applied = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => r.version);
      assert.ok(applied.includes("0014"), "schema_migrations table must record migration 0014");
      assert.ok(applied.includes("0016"), "schema_migrations table must record migration 0016");
      assert.ok(applied.includes("0020"), "schema_migrations table must record migration 0020");

      // Verify activity database migration
      const actDb = new DatabaseSync(":memory:");
      const actSql = read("migrations/activity/A0001_activity.sql");
      assert.doesNotThrow(() => {
        actDb.exec(actSql);
      }, "Activity migration A0001 must apply cleanly");

      const actTables = actDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
      assert.ok(actTables.includes("watch_events"));
      assert.ok(actTables.includes("show_progress"));
      assert.ok(actTables.includes("user_media_state"));
      assert.ok(actTables.includes("schema_migrations"));
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Account Backfill
  // ---------------------------------------------------------------------------
  describe("2. Account Backfill (migrate.accounts / backfillAccounts)", () => {
    it("preserves 100% of accounts across D1 and KV, authenticates passwords, and remains idempotent", async () => {
      const env = makeEnv({
        DB: makeD1(),
        DB_ACTIVITY: makeD1({ schema: "activity" }),
        CONFIGS: makeKv(),
        BLOBS: makeR2(),
        TOKEN_ENCRYPTION_KEY: TEST_TOKEN_KEY,
        TMDB_API_KEY: "test-tmdb-key",
      });

      await seedLegacyProductionFixtures(env);
      const cookie = await adminCookie(env);
      const beforeSnapshot = snapshotLegacyStores(env);

      // Execute account migration via admin endpoint
      const res = await call(env, "/admin/api/migrate-accounts", {
        method: "POST",
        cookie,
        json: { dryRun: false },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.reconciled, true);
      assert.equal(res.body.unionCount, 5, "5 total non-deleted creators in D1 and KV");
      assert.equal(res.body.accountsCount, 5);
      assert.equal(res.body.inserted, 5);
      assert.deepEqual(res.body.errors, []);

      // Verify all creators exist in accounts table
      const db = env.DB._db;
      const accounts = db.prepare("SELECT id, username, display_name, key_hash, recovery_answer_hash FROM accounts ORDER BY id").all();
      assert.equal(accounts.length, 5);

      const byUser = Object.fromEntries(accounts.map((a) => [a.username, a]));

      // Verify cinemabuff99 (in both D1 and KV)
      const cb = byUser["cinemabuff99"];
      assert.ok(cb);
      assert.equal(cb.display_name, "Cinema Buff 🎥");
      assert.ok(cb.key_hash.startsWith("pbkdf2:"));

      // Verify retrocurator (D1 only)
      const rc = byUser["retrocurator"];
      assert.ok(rc);
      assert.equal(rc.display_name, "Retro Curator 📼");
      assert.ok(rc.key_hash.startsWith("pbkdf2:"), "key_hash preserved");

      // Verify animeotaku (KV only)
      const ao = byUser["animeotaku"];
      assert.ok(ao);
      assert.equal(ao.display_name, "Anime Enthusiast ⚔️");

      // Verify deleteduser88 was NOT migrated as an active account
      assert.equal(byUser["deleteduser88"], undefined, "tombstoned user must not be an active account");

      // Verify backfill idempotency: running again changes 0 rows
      const rerun = await call(env, "/admin/api/migrate-accounts", {
        method: "POST",
        cookie,
        json: { dryRun: false },
      });
      assert.equal(rerun.body.inserted, 0);
      assert.equal(rerun.body.updated, 5);
      assert.equal(rerun.body.reconciled, true);

      // Verify legacy stores were not mutated by the backfill
      assert.equal(snapshotLegacyStores(env), beforeSnapshot, "account backfill must not mutate legacy stores");

      // Verify authentication works for migrated accounts via /api/session
      const loginPbkdf2 = await call(env, "/api/session", {
        method: "POST",
        json: { username: "cinemabuff99", key: "k_cinemabuff_secret_12345" },
      });
      assert.equal(loginPbkdf2.status, 200, "PBKDF2 login must succeed");
      assert.ok(loginPbkdf2.headers.get("set-cookie").includes("mla_session="));

      const loginRetro = await call(env, "/api/session", {
        method: "POST",
        json: { username: "retrocurator", key: "k_retrocurator_secret_11223" },
      });
      assert.equal(loginRetro.status, 200, "D1-only account login must succeed");
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Lists & Likes Migration
  // ---------------------------------------------------------------------------
  describe("3. Custom Lists & Likes Backfill (migrate.lists / 30_lists-backfill.js)", () => {
    it("preserves 100% of lists, items, and likes with exact ordering and conflict resolution", async () => {
      const restoreTmdb = withFakeTmdb(MIGRATION_TMDB_FIXTURES);
      try {
        const env = makeEnv({
          DB: makeD1(),
          DB_ACTIVITY: makeD1({ schema: "activity" }),
          CONFIGS: makeKv(),
          BLOBS: makeR2(),
          TOKEN_ENCRYPTION_KEY: TEST_TOKEN_KEY,
          TMDB_API_KEY: "test-tmdb-key",
        });

        await seedLegacyProductionFixtures(env);
        const cookie = await adminCookie(env);

        // Pre-condition: backfill accounts first
        await call(env, "/admin/api/migrate-accounts", { method: "POST", cookie, json: { dryRun: false } });

        const beforeSnapshot = snapshotLegacyStores(env);

        // Run lists backfill in steps until complete
        let done = false;
        let stepCount = 0;
        while (!done && stepCount < 50) {
          stepCount++;
          const stepRes = await call(env, "/admin/api/lists-backfill/step", {
            method: "POST",
            cookie,
            json: { maxOps: 200, maxItems: 15 },
          });
          assert.equal(stepRes.status, 200, JSON.stringify(stepRes.body));
          done = !!stepRes.body.done;
        }

        assert.ok(done, `lists backfill must finish within 50 steps (took ${stepCount})`);

        // INVARIANT 0: Legacy Store Immutability
        assert.equal(snapshotLegacyStores(env), beforeSnapshot, "lists backfill must not mutate legacy stores");

        const db = env.DB._db;

        // INVARIANT 1: Zero Lost Lists
        const lists = db.prepare("SELECT * FROM lists ORDER BY id").all();
        // 6 custom lists + 1 anonymous published list + 1 watchlist = 8 lists total
        assert.equal(lists.length, 8, "all 8 fixture lists must be in lists table");

        const bySlug = Object.fromEntries(lists.map((l) => [l.slug, l]));

        // Verify Watchlist migrated as kind='watchlist'
        const watchlist = bySlug["watchlist"];
        assert.ok(watchlist, "watchlist must be present in lists table");
        assert.equal(watchlist.kind, "watchlist");
        assert.equal(watchlist.item_count, 1);

        // INVARIANT 2: Item Deduplication & Canonical Resolution
        const noir = bySlug["top-noir-classics"];
        assert.ok(noir);
        assert.equal(noir.item_count, 3, "Fight Club duplicate deduplicated; unresolvable mystery dropped");
        assert.equal(noir.visibility, "public");
        assert.equal(noir.like_count, 12, "like count preserved");

        const noirItems = db.prepare(`
          SELECT li.position, m.imdb_id, m.tmdb_id, m.title, m.resolved_at
          FROM list_items li
          JOIN media m ON m.id = li.media_id
          WHERE li.list_id = ?
          ORDER BY li.position
        `).all(noir.id);

        assert.equal(noirItems.length, 3);
        assert.equal(noirItems[0].imdb_id, "tt0137523", "Fight Club mapped to canonical IMDb id");
        assert.equal(noirItems[1].imdb_id, "tt0068646", "The Godfather mapped to canonical IMDb id");
        assert.equal(noirItems[2].imdb_id, "tt9999999", "Lost Film stub preserved in media table");
        assert.equal(noirItems[2].resolved_at, null, "stub has null resolved_at");

        // INVARIANT 3: Episodes and Companion Movie Preservation
        const chronology = bySlug["crossover-chronology"];
        assert.ok(chronology);
        assert.equal(chronology.item_count, 4);

        const chronoItems = db.prepare(`
          SELECT li.position, li.season, li.episode, li.extra_json, m.kind, m.imdb_id, m.title
          FROM list_items li
          JOIN media m ON m.id = li.media_id
          WHERE li.list_id = ?
          ORDER BY li.position
        `).all(chronology.id);

        assert.equal(chronoItems.length, 4);
        assert.equal(chronoItems[0].season, 1);
        assert.equal(chronoItems[0].episode, 1);
        assert.equal(chronoItems[1].season, 1);
        assert.equal(chronoItems[1].episode, 2);

        // Companion movie check
        const companionItem = chronoItems[2];
        assert.equal(companionItem.imdb_id, "tt9243946");
        assert.ok(companionItem.extra_json);
        const extra = JSON.parse(companionItem.extra_json);
        assert.equal(extra.isCompanion, true);
        assert.equal(extra.companionType, "bridge_movie");
        assert.equal(extra.companionNote, "Watch immediately after S5 finale");

        // INVARIANT 4: Large List Batch Insertion
        const vault = bySlug["sci-fi-vault"];
        assert.ok(vault);
        assert.equal(vault.item_count, 42, "all 42 items in large sci-fi vault preserved");
        const vaultItemCount = db.prepare("SELECT COUNT(*) AS c FROM list_items WHERE list_id = ?").get(vault.id).c;
        assert.equal(vaultItemCount, 42);

        // INVARIANT 5: Fresher KV Conflict Resolution
        const weekend = bySlug["weekend-specials"];
        assert.ok(weekend);
        assert.equal(weekend.item_count, 3, "fresher KV record with 3 items took precedence over D1 1 item");
        assert.equal(weekend.like_count, 20);

        // INVARIANT 6: Anonymous Published List
        const anon = bySlug["cult-classics-1980s"];
        assert.ok(anon);
        assert.equal(anon.owner_account_id, null, "legacy anonymous list has no owner account");
        assert.equal(anon.kind, "legacy_anonymous");
        assert.equal(anon.visibility, "unlisted");
        assert.equal(anon.item_count, 2);
        assert.equal(anon.like_count, 7);

        // INVARIANT 7: Likes Migration
        const likesCount = db.prepare("SELECT COUNT(*) AS c FROM likes").get().c;
        assert.ok(likesCount >= 6, "likes table must contain votes from D1 and KV voter ledgers");

        // INVARIANT 8: URL Resolution Compatibility
        const urlResLegacy = await call(env, "/lists/cinemabuff99/top-noir-classics");
        assert.equal(urlResLegacy.status, 200, "legacy list URL must resolve with 200");

        const urlResV2 = await call({ ...env, FF_V2_LISTS_READ: "1" }, "/lists/cinemabuff99/top-noir-classics");
        assert.equal(urlResV2.status, 200, "list URL must resolve under FF_V2_LISTS_READ=1");

        const anonRes = await call(env, "/lists/user/cult-classics-1980s");
        assert.equal(anonRes.status, 200, "anonymous published list URL must resolve");


        // INVARIANT 10: Status Check & Idempotency
        const status = await call(env, "/admin/api/lists-backfill/status", { cookie });
        assert.equal(status.status, 200);
        assert.equal(status.body.run.phase, "done");
        assert.equal(status.body.accounts.failed, 0);
        assert.equal(status.body.totals.lists.missing, 0);
        assert.equal(status.body.failed.length, 0);
      } finally {
        restoreTmdb();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Virtual Channels v2 Backfill & Lineup Invariants
  // ---------------------------------------------------------------------------
  describe("4. Channels v2 Backfill & Lineup Invariants (35_channels-v2.js)", () => {
    it("migrates channels, generates R2 blob pools, and preserves identical lineups for identical date seeds", async () => {
      const restoreTmdb = withFakeTmdb(MIGRATION_TMDB_FIXTURES);
      try {
        const env = makeEnv({
          DB: makeD1(),
          CONFIGS: makeKv(),
          BLOBS: makeR2(),
          TOKEN_ENCRYPTION_KEY: TEST_TOKEN_KEY,
          TMDB_API_KEY: "test-tmdb-key",
          FF_V2_LISTS_READ: "1",
        });

        await seedLegacyProductionFixtures(env);
        const cookie = await adminCookie(env);

        // Run accounts and lists backfill (channels backfill runs as phase 4 of lists backfill)
        await call(env, "/admin/api/migrate-accounts", { method: "POST", cookie, json: { dryRun: false } });

        let done = false;
        let stepCount = 0;
        while (!done && stepCount < 50) {
          stepCount++;
          const stepRes = await call(env, "/admin/api/lists-backfill/step", { method: "POST", cookie, json: {} });
          done = !!stepRes.body.done;
        }
        assert.ok(done);

        const db = env.DB._db;

        // INVARIANT 1: Channels Table Rows
        const channels = db.prepare("SELECT * FROM channels ORDER BY id").all();
        assert.equal(channels.length, 3, "all 3 shared channels migrated to channels table");

        const byCode = Object.fromEntries(channels.map((c) => [c.public_code, c]));

        const nightshift = byCode["ch_nightshift"];
        assert.ok(nightshift);
        assert.equal(nightshift.name, "Night Shift TV");
        assert.equal(nightshift.visibility, "public");
        assert.equal(nightshift.like_count, 8);
        assert.equal(nightshift.add_count, 15);
        assert.ok(nightshift.pool_r2_key, "R2 key must be generated when BLOBS is bound");

        // INVARIANT 2: R2 Pools Created
        const r2Object = await env.BLOBS.get(nightshift.pool_r2_key);
        assert.ok(r2Object, "R2 blob pool must exist");
        const poolData = await r2Object.json();
        assert.ok(Array.isArray(poolData));
        assert.ok(poolData.length > 0);

        // INVARIANT 3: Deterministic Lineup Equality (Rotating Channel)
        const SEED_DAYS = [1767225600000, 1767312000000, 1769904000000 + 3600000 * 5];
        const legacyShareNightshift = await call(env, "/api/channel/share?code=ch_nightshift");
        assert.equal(legacyShareNightshift.status, 200);
        const v2ShareNightshift = await call({ ...env, FF_V2_LISTS_READ: "1" }, "/api/channel/share?code=ch_nightshift");
        assert.equal(v2ShareNightshift.status, 200);

        for (const dayNow of SEED_DAYS) {
          // Lineup generated from legacy channel payload
          const legacyLineupRes = await call(env, "/api/channel-lineup", {
            method: "POST",
            json: { url: "channel:v1:" + JSON.stringify(legacyShareNightshift.body.channel), now: dayNow },
          });
          assert.equal(legacyLineupRes.status, 200);

          // Lineup resolved from migrated v2 channel payload
          const v2LineupRes = await call(env, "/api/channel-lineup", {
            method: "POST",
            json: { url: "channel:v1:" + JSON.stringify(v2ShareNightshift.body.channel), now: dayNow },
          });
          assert.equal(v2LineupRes.status, 200);

          assert.deepEqual(
            v2LineupRes.body.items,
            legacyLineupRes.body.items,
            `Channel lineup for day ${dayNow} must be byte-identical between legacy and v2`
          );
        }

        // INVARIANT 4: Shuffled Channel with Paired Episodes
        const legacyShareShuffled = await call(env, "/api/channel/share?code=ch_cine_mix");
        const v2ShareShuffled = await call({ ...env, FF_V2_LISTS_READ: "1" }, "/api/channel/share?code=ch_cine_mix");
        assert.equal(v2ShareShuffled.status, 200);

        const shufLegacyRes = await call(env, "/api/channel-lineup", {
          method: "POST",
          json: { url: "channel:v1:" + JSON.stringify(legacyShareShuffled.body.channel), now: SEED_DAYS[0] },
        });
        const shufV2Res = await call(env, "/api/channel-lineup", {
          method: "POST",
          json: { url: "channel:v1:" + JSON.stringify(v2ShareShuffled.body.channel), now: SEED_DAYS[0] },
        });
        assert.deepEqual(shufV2Res.body.items, shufLegacyRes.body.items, "Shuffled lineup with paired parts must match");

        // INVARIANT 5: Share URL Resolution
        const codeRes = await call(env, "/channel/ch_nightshift");
        assert.equal(codeRes.status, 302, "/channel/:code redirects to app/manifest");
        const userSlugRes = await call(env, "/channels/communitystar/ch_nightshift");
        assert.equal(userSlugRes.status, 200, "/channels/:user/:slug must resolve");
      } finally {
        restoreTmdb();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Activity Database Backfill
  // ---------------------------------------------------------------------------
  describe("5. Watch History & Activity Backfill (migrate.activity / 37_activity-backfill.js)", () => {
    it("merges the three tracking sources, deduplicates twin scrobbles, preserves show states, and enables v2 shelves", async () => {
      const env = makeEnv({
        DB: makeD1(),
        DB_ACTIVITY: makeD1({ schema: "activity" }),
        CONFIGS: makeKv(),
        BLOBS: makeR2(),
        TOKEN_ENCRYPTION_KEY: TEST_TOKEN_KEY,
        TMDB_API_KEY: "test-tmdb-key",
      });

      await seedLegacyProductionFixtures(env);
      const cookie = await adminCookie(env);

      // Pre-condition: accounts backfill
      await call(env, "/admin/api/migrate-accounts", { method: "POST", cookie, json: { dryRun: false } });

      const beforeSnapshot = snapshotLegacyStores(env);

      // Run activity backfill in steps until complete
      let done = false;
      let stepCount = 0;
      while (!done && stepCount < 50) {
        stepCount++;
        const stepRes = await call(env, "/admin/api/activity-backfill/step", {
          method: "POST",
          cookie,
          json: { maxOps: 200, maxItems: 10 },
        });
        assert.equal(stepRes.status, 200, JSON.stringify(stepRes.body));
        done = !!stepRes.body.done;
      }

      assert.ok(done, `activity backfill must finish within 50 steps (took ${stepCount})`);

      // INVARIANT 0: Legacy Stores Unchanged
      assert.equal(snapshotLegacyStores(env), beforeSnapshot, "activity backfill must not mutate legacy stores");

      const actDb = env.DB_ACTIVITY._db;
      const mainDb = env.DB._db;

      // bingewatcher42 is account id 2
      const accountId = mainDb.prepare("SELECT id FROM accounts WHERE username = 'bingewatcher42'").get().id;
      assert.ok(accountId);

      // INVARIANT 1: Watch Events Union & Deduplication
      const events = actDb.prepare(`
        SELECT media_id, season, episode, watched_at, source
        FROM watch_events
        WHERE account_id = ?
        ORDER BY watched_at ASC
      `).all(accountId);

      // Expected events:
      // 1. The Godfather (from D1 history: T0 - 24h)
      // 2. Breaking Bad S1E1 (from KV & D1: T0) -> counted once
      // 3. Breaking Bad S1E2 (from KV: T0 + 1h) -> twin scrobble at T0 + 1h + 4min deduplicated!
      // 4. Fight Club (from KV: T0 + 2h)
      // 5. Game of Thrones S2E3 (from KV composite id: T0 + 3h)
      // 6. Breaking Bad S1E4 (from scrobble queue: T0 + 4h)
      // Ghost items dropped.
      assert.equal(events.length, 6, "exactly 6 deduplicated watch events");
      assert.ok(events.every((e) => e.source === "migrated"));

      // Verify twin scrobbles deduplicated: only one event for Breaking Bad S1E2
      const bbS1E2Plays = events.filter((e) => e.season === 1 && e.episode === 2);
      assert.equal(bbS1E2Plays.length, 1, "twin scrobbles 4 minutes apart must produce exactly 1 play");

      // INVARIANT 2: Show Progress & Dismissals
      const progress = actDb.prepare("SELECT * FROM show_progress WHERE account_id = ? ORDER BY media_id").all(accountId);
      assert.ok(progress.length >= 3);

      const bbProgress = progress.find((p) => p.last_season === 1 && p.last_episode === 4);
      assert.ok(bbProgress, "Breaking Bad progress updated to S1E4");
      assert.equal(bbProgress.status, "watching");
      assert.equal(bbProgress.dismissed_at_season, 1);
      assert.equal(bbProgress.dismissed_at_episode, 2);

      const gotProgress = progress.find((p) => p.status === "completed");
      assert.ok(gotProgress, "Game of Thrones marked completed");
      assert.equal(gotProgress.airing_hidden_at_season, 2);
      assert.equal(gotProgress.airing_hidden_at_episode, 3);

      // Companion movie in show_progress
      const companionProgress = progress.find((p) => p.companion_json != null);
      assert.ok(companionProgress, "companion movie stored in companion_json");
      assert.ok(companionProgress.companion_json.includes("The Fellowship of the Ring"));

      // INVARIANT 3: Finished Media Recorded in user_media_state
      const mediaStates = actDb.prepare("SELECT * FROM user_media_state WHERE account_id = ?").all(accountId);
      assert.ok(mediaStates.length > 0, "finished media tracked in user_media_state");

      // INVARIANT 4: FF_EVENT_TRACKING Compatibility
      const syncLoadRes = await call({ ...env, FF_EVENT_TRACKING: "1" }, "/api/creator/sync/load", {
        method: "POST",
        json: {
          creatorName: "bingewatcher42",
          creatorKey: "k_bingewatcher_secret_67890",
        },
      });
      assert.equal(syncLoadRes.status, 200);
      assert.ok(syncLoadRes.body.ok);
      assert.ok(Array.isArray(syncLoadRes.body.data?.watchHistory));
      assert.equal(syncLoadRes.body.data.watchHistory.length, 6);


      // INVARIANT 6: Status Metrics
      const actStatus = await call(env, "/admin/api/activity-backfill/status", { cookie });
      assert.equal(actStatus.status, 200);
      assert.equal(actStatus.body.run.phase, "done");
      assert.equal(actStatus.body.accounts.failed, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Install Secrets Migration
  // ---------------------------------------------------------------------------
  describe("6. Install Secrets Migration (27_installs.js & install_secrets)", () => {
    it("migrates plaintext keys into encrypted install_secrets, purges KV credentials, and maintains manifest integrity", async () => {
      const env = makeEnv({
        DB: makeD1(),
        CONFIGS: makeKv(),
        BLOBS: makeR2(),
        TOKEN_ENCRYPTION_KEY: TEST_TOKEN_KEY,
        INSTALL_MIGRATION_PERCENT: "100",
      });

      await seedLegacyProductionFixtures(env);

      // 1. Initial State: Secrets are in KV
      const rawBefore = env.CONFIGS._store.get("cfg:inst_full_01");
      assert.ok(rawBefore.includes("TEST_USER_TMDB_KEY_99"));
      assert.ok(rawBefore.includes("TRAKT_BEARER_TOKEN_VAL_1"));

      const manifestBefore = (await call(env, "/inst_full_01/manifest.json")).body;
      assert.ok(manifestBefore);
      assert.equal(manifestBefore.id, "app.my-list");

      // 2. Trigger Migration via request
      const r = await call(env, "/inst_full_01/manifest.json");
      assert.equal(r.status, 200);

      // 3. Verify Plaintext Secrets Purged from KV
      const rawAfter = env.CONFIGS._store.get("cfg:inst_full_01");
      assert.ok(rawAfter);
      assert.doesNotMatch(rawAfter, /TEST_USER_TMDB_KEY_99/, "Plaintext TMDB key must not remain in KV");
      assert.doesNotMatch(rawAfter, /TRAKT_BEARER_TOKEN_VAL_1/, "Plaintext Trakt token must not remain in KV");

      const stripped = JSON.parse(rawAfter);
      assert.ok(stripped._install, "_install pointer must be stamped");
      assert.equal(stripped.region, "US", "non-secret fields preserved");
      assert.equal(stripped.entries.length, 2, "catalog rows preserved");

      // 4. Verify Encrypted Secrets in D1
      const secretRows = env.DB._db.prepare(`
        SELECT install_id, provider, api_key_enc, access_token_enc
        FROM install_secrets
      `).all();

      assert.ok(secretRows.length >= 4, "at least 4 provider secret rows written");
      const serializedSecrets = JSON.stringify(secretRows);
      assert.doesNotMatch(serializedSecrets, /TEST_USER_TMDB_KEY_99/, "Secrets must be stored encrypted");
      assert.doesNotMatch(serializedSecrets, /TRAKT_BEARER_TOKEN_VAL_1/, "Tokens must be stored encrypted");

      // 5. Verify Shelf Install with trackCreatorKey
      await call(env, "/inst_shelf02/manifest.json");
      const shelfRawAfter = env.CONFIGS._store.get("cfg:inst_shelf02");
      assert.doesNotMatch(shelfRawAfter, /k_bingewatcher_secret_67890/, "trackCreatorKey purged from KV");
      const creatorSecretRow = env.DB._db.prepare("SELECT * FROM install_secrets WHERE provider = 'creator'").get();
      assert.ok(creatorSecretRow, "creator secret stored in install_secrets");

      // 6. Verify Anonymous Install (No Secrets)
      await call(env, "/inst_anon_03/manifest.json");
      const anonManifest = (await call(env, "/inst_anon_03/manifest.json")).body;
      assert.ok(anonManifest);

      // 7. Verify Downstream Manifest Identity Preserved
      const manifestAfter = (await call(env, "/inst_full_01/manifest.json")).body;
      assert.deepEqual(manifestAfter, manifestBefore, "Manifest served must remain identical after migration");
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Full End-to-End Migration Invariant Audit
  // ---------------------------------------------------------------------------
  describe("7. Full End-to-End Migration Invariant Reconciliation", () => {
    it("completes the entire end-to-end migration pipeline with 0 lost entities and 0 reconciliation errors", async () => {
      const restoreTmdb = withFakeTmdb(MIGRATION_TMDB_FIXTURES);
      try {
        const env = makeEnv({
          DB: makeD1(),
          DB_ACTIVITY: makeD1({ schema: "activity" }),
          CONFIGS: makeKv(),
          BLOBS: makeR2(),
          TOKEN_ENCRYPTION_KEY: TEST_TOKEN_KEY,
          TMDB_API_KEY: "test-tmdb-key",
          INSTALL_MIGRATION_PERCENT: "100",
        });

        await seedLegacyProductionFixtures(env);
        const cookie = await adminCookie(env);

        // Stage 1: Account Backfill
        const accRes = await call(env, "/admin/api/migrate-accounts", { method: "POST", cookie, json: { dryRun: false } });
        assert.equal(accRes.status, 200);
        assert.equal(accRes.body.reconciled, true);

        // Stage 2: Lists & Channels Backfill
        let listsDone = false;
        let lSteps = 0;
        while (!listsDone && lSteps < 50) {
          lSteps++;
          const r = await call(env, "/admin/api/lists-backfill/step", { method: "POST", cookie, json: {} });
          listsDone = !!r.body.done;
        }
        assert.ok(listsDone);

        // Stage 3: Activity Backfill
        let actDone = false;
        let aSteps = 0;
        while (!actDone && aSteps < 50) {
          aSteps++;
          const r = await call(env, "/admin/api/activity-backfill/step", { method: "POST", cookie, json: {} });
          actDone = !!r.body.done;
        }
        assert.ok(actDone);

        // Stage 4: Installs Migration
        for (const inst of MIGRATION_FIXTURES.installs) {
          await call(env, `/${inst.id}/manifest.json`);
        }

        // --- FINAL INVARIANT AUDIT ---
        const db = env.DB._db;
        const actDb = env.DB_ACTIVITY._db;

        const totalAccounts = db.prepare("SELECT COUNT(*) AS c FROM accounts").get().c;
        const totalLists = db.prepare("SELECT COUNT(*) AS c FROM lists WHERE kind != 'watchlist'").get().c;
        const totalChannels = db.prepare("SELECT COUNT(*) AS c FROM channels").get().c;
        const totalWatchEvents = actDb.prepare("SELECT COUNT(*) AS c FROM watch_events").get().c;
        const totalInstallSecrets = db.prepare("SELECT COUNT(*) AS c FROM install_secrets").get().c;

        assert.equal(totalAccounts, 5, "100% of accounts preserved (0 lost)");
        assert.equal(totalLists, 7, "100% of custom lists preserved (0 lost)");
        assert.equal(totalChannels, 3, "100% of channels preserved (0 lost)");
        assert.equal(totalWatchEvents, 6, "100% of deduplicated watch events preserved (0 lost)");
        assert.ok(totalInstallSecrets >= 5, "100% of install secrets migrated to encrypted storage");

        // Reconciliation reports verification
        const listsStatus = (await call(env, "/admin/api/lists-backfill/status", { cookie })).body;
        assert.equal(listsStatus.run.phase, "done");
        // 57 valid items copied + 1 duplicate deduplicated + 1 unresolvable item without id = 59 total legacy items
        const { copied, duplicates, unusable, legacy } = listsStatus.totals.items;
        assert.equal(copied + duplicates + unusable, legacy, "100% of legacy items accounted for");
        assert.equal(unusable, 1, "only the item with no id is marked unusable");
        assert.equal(duplicates, 1, "Fight Club duplicate deduplicated");

        const actStatus = (await call(env, "/admin/api/activity-backfill/status", { cookie })).body;
        assert.equal(actStatus.run.phase, "done");
        assert.equal(actStatus.accounts.failed, 0);
      } finally {
        restoreTmdb();
      }
    });
  });

});
