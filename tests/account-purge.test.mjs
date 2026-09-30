// P5-8: DELETE /api/me deletes an account at once (tombstone, sessions and
// install links revoked) and the account.purge job removes its data, including
// everything filed under its id in the v2 and activity tables. A username
// registered again, even one handed the same id, inherits nothing.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeEnv, makeD1, makeQueue, drainQueue, call, createUser, lapseCreatorTombstone } from "./harness.mjs";

async function signIn(env, username, key) {
  const r = await call(env, "/api/session", { method: "POST", json: { username, key } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return (r.headers.get("set-cookie") || "").split(";")[0];
}

const count = (db, sql, ...args) => db.prepare(sql).get(...args).n;

// An account with something in every place purgeAccountRowsById clears, and
// another account's public list it liked.
async function populated(extra = {}) {
  const env = makeEnv({ DB: makeD1(), DB_ACTIVITY: makeD1({ schema: "activity" }), JOBS: makeQueue(), FF_INSTALLS: "1", ...extra });
  const other = await createUser(env, "otherowner");
  const ann = await createUser(env, "annpurge");
  const cookie = await signIn(env, "annpurge", ann.creatorKey);
  const db = env.DB._db;
  const id = db.prepare("SELECT id FROM accounts WHERE username = 'annpurge'").get().id;
  const otherId = db.prepare("SELECT id FROM accounts WHERE username = 'otherowner'").get().id;
  db.prepare("INSERT INTO media (id, kind, imdb_id, title, created_at, updated_at) VALUES (77, 'series', 'tt0000077', 'Show', 0, 0)").run();
  env.DB_ACTIVITY._db.prepare("INSERT INTO watch_events (account_id, media_id, season, episode, watched_at, source, dedupe_key) VALUES (?, 77, 1, 1, 1, 'web', ?)").run(id, `d${id}`);
  env.DB_ACTIVITY._db.prepare("INSERT INTO show_progress (account_id, media_id, last_season, last_episode, updated_at) VALUES (?, 77, 1, 1, 0)").run(id);
  db.prepare("INSERT INTO lists (public_id, owner_account_id, slug, name, media_type, visibility, like_count, created_at, updated_at) VALUES ('pubL1', ?, 'theirs', 'Theirs', 'movie', 'public', 1, 0, 0)").run(otherId);
  db.prepare("INSERT INTO likes (target_type, target_id, voter, created_at) VALUES ('list', 'pubL1', ?, 0)").run(`acct:${id}`);
  db.prepare("INSERT INTO account_recommendations (account_id, kind, rank, media_id, built_at) VALUES (?, 'series', 1, 77, 0)").run(id);
  db.prepare("INSERT INTO channels (public_code, owner_account_id, name, visibility, pool_version, created_at, updated_at) VALUES ('privch', ?, 'Mine', 'private', 1, 0, 0)").run(id);
  db.prepare("INSERT INTO channels (public_code, owner_account_id, name, visibility, pool_version, created_at, updated_at) VALUES ('sharedch', ?, 'Shared', 'public', 1, 0, 0)").run(id);
  await env.BLOBS.put("channels/privch/1.json", "[]");
  await env.BLOBS.put("channels/sharedch/1.json", "[]");
  // A legacy list in KV, and an install link.
  const saved = await call(env, "/api/creator/lists/save", { method: "POST", json: { creatorName: "annpurge", creatorKey: ann.creatorKey, slug: "mine", name: "Mine", type: "movie", items: [{ id: "tt0133093" }] } });
  assert.equal(saved.body.ok, true, JSON.stringify(saved.body));
  const install = await call(env, "/api/installs", { method: "POST", cookie, json: { entries: [{ id: "r1", name: "Popular", type: "movie", url: "tmdb:chart:popular" }] } });
  assert.equal(install.status, 201, JSON.stringify(install.body));
  return { env, db, id, ann, cookie, installToken: install.body.token };
}

function assertNothingLeft(env, db, id) {
  assert.equal(count(env.DB_ACTIVITY._db, "SELECT count(*) AS n FROM watch_events WHERE account_id = ?", id), 0);
  assert.equal(count(env.DB_ACTIVITY._db, "SELECT count(*) AS n FROM show_progress WHERE account_id = ?", id), 0);
  assert.equal(count(db, "SELECT count(*) AS n FROM likes WHERE voter = ?", `acct:${id}`), 0);
  assert.equal(db.prepare("SELECT like_count FROM lists WHERE public_id = 'pubL1'").get().like_count, 0, "the like it cast is taken back");
  assert.equal(count(db, "SELECT count(*) AS n FROM account_recommendations WHERE account_id = ?", id), 0);
  assert.equal(count(db, "SELECT count(*) AS n FROM channels WHERE public_code = 'privch'"), 0);
  assert.equal(env.BLOBS._store.has("channels/privch/1.json"), false);
  assert.equal(db.prepare("SELECT owner_account_id FROM channels WHERE public_code = 'sharedch'").get().owner_account_id, null, "a shared channel stays, with no owner");
  assert.equal(env.BLOBS._store.has("channels/sharedch/1.json"), true);
  assert.equal(count(db, "SELECT count(*) AS n FROM accounts WHERE username = 'annpurge'"), 0);
  assert.equal(env.CONFIGS._store.has("creator:annpurge"), false);
  assert.equal(env.CONFIGS._store.has("creatorlist:annpurge:mine"), false);
}

describe("P5-8: account.purge", () => {
  it("DELETE /api/me takes effect at once, and the job removes everything", async () => {
    const { env, db, id, ann, cookie, installToken } = await populated();
    const r = await call(env, "/api/me", { method: "DELETE", cookie, json: { confirm: "DELETE" } });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.deleting, true);
    assert.match(r.headers.get("set-cookie") || "", /mla_session=;/);

    // At once, before the job has run.
    assert.equal(count(db, "SELECT count(*) AS n FROM sessions WHERE account_id = ? AND revoked_at IS NULL", id), 0);
    assert.equal((await call(env, "/api/me", { cookie })).status, 401, "the session stops working");
    assert.ok(db.prepare("SELECT deleted_at FROM accounts WHERE id = ?").get(id).deleted_at > 0);
    assert.equal(count(db, "SELECT count(*) AS n FROM installs WHERE account_id = ? AND revoked_at IS NULL", id), 0);
    const gone = await call(env, `/i/${installToken}/manifest.json`);
    assert.deepEqual(gone.body.catalogs.filter((c) => !c.id.startsWith("search")), [], "the install link stops serving rows");
    const keyAuth = await call(env, "/api/creator/sync/load", { method: "POST", json: { creatorName: "annpurge", creatorKey: ann.creatorKey } });
    assert.equal(keyAuth.body.ok, false, "the key stops working");
    const again = await call(env, "/api/creator/create", { method: "POST", json: { creatorName: "annpurge" } });
    assert.equal(again.body.ok, false, "the username cannot be taken while the purge runs");

    const log = await drainQueue(env);
    assert.deepEqual(log.deliveries.filter((d) => d.type === "account.purge").map((d) => d.outcome), ["ack"]);
    assert.equal(db.prepare("SELECT status FROM jobs WHERE dedupe_key = ?").get(`account.purge:${id}`).status, "done");
    assertNothingLeft(env, db, id);
  });

  it("a re-registered username inherits nothing, even when it is handed the same id", async () => {
    const { env, db, id, cookie } = await populated();
    await call(env, "/api/me", { method: "DELETE", cookie, json: { confirm: "DELETE" } });
    await drainQueue(env);
    lapseCreatorTombstone(env, "annpurge");
    const fresh = await createUser(env, "annpurge");
    const newId = db.prepare("SELECT id FROM accounts WHERE username = 'annpurge'").get().id;
    assert.equal(newId, id, "SQLite handed the new account the deleted one's id");
    // Nothing filed under the id came with it.
    assert.equal(count(env.DB_ACTIVITY._db, "SELECT count(*) AS n FROM watch_events WHERE account_id = ?", newId), 0);
    assert.equal(count(env.DB_ACTIVITY._db, "SELECT count(*) AS n FROM show_progress WHERE account_id = ?", newId), 0);
    assert.equal(count(db, "SELECT count(*) AS n FROM likes WHERE voter = ?", `acct:${newId}`), 0);
    assert.equal(count(db, "SELECT count(*) AS n FROM account_recommendations WHERE account_id = ?", newId), 0);
    assert.equal(count(db, "SELECT count(*) AS n FROM channels WHERE owner_account_id = ?", newId), 0);
    assert.equal(count(db, "SELECT count(*) AS n FROM installs WHERE account_id = ?", newId), 0);
    assert.equal(env.CONFIGS._store.has("creatorlist:annpurge:mine"), false);
    const lists = await call(env, "/api/creator/lists", { method: "POST", json: { creatorName: "annpurge", creatorKey: fresh.creatorKey } });
    assert.deepEqual(lists.body.lists || [], []);
    const sync = await call(env, "/api/creator/sync/load", { method: "POST", json: { creatorName: "annpurge", creatorKey: fresh.creatorKey } });
    assert.deepEqual(sync.body.data && sync.body.data.watchHistory ? sync.body.data.watchHistory : [], []);
  });

  it("the old delete-account route clears the same rows", async () => {
    const { env, db, id, ann } = await populated();
    const r = await call(env, "/api/creator/delete-account", { method: "POST", json: { creatorName: "annpurge", creatorKey: ann.creatorKey, confirm: "DELETE" } });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assertNothingLeft(env, db, id);
  });

  it("needs a session and the confirmation, and a failed step is tried again", async () => {
    const { env, db, id, cookie } = await populated();
    assert.equal((await call(env, "/api/me", { method: "DELETE", json: { confirm: "DELETE" } })).status, 401);
    assert.equal((await call(env, "/api/me", { method: "DELETE", cookie, json: {} })).status, 400);

    await call(env, "/api/me", { method: "DELETE", cookie, json: { confirm: "DELETE" } });
    let fail = true;
    env.DB_ACTIVITY.failWhen((sql) => fail && sql.startsWith("DELETE FROM watch_events"));
    await drainQueue(env);
    const job = db.prepare("SELECT status, attempts, last_error FROM jobs WHERE dedupe_key = ?").get(`account.purge:${id}`);
    assert.deepEqual([job.status, job.attempts], ["queued", 1]);
    assert.ok(count(env.DB_ACTIVITY._db, "SELECT count(*) AS n FROM watch_events WHERE account_id = ?", id) > 0);
    assert.equal((await call(env, "/api/creator/create", { method: "POST", json: { creatorName: "annpurge" } })).body.ok, false, "still out of reach");

    fail = false;
    env.DB_ACTIVITY.failWhen(null);
    db.prepare("UPDATE jobs SET run_after = 1 WHERE dedupe_key = ?").run(`account.purge:${id}`);
    const { runScheduledTick } = await import("./harness.mjs");
    await runScheduledTick(env);
    env.JOBS._pending.splice(0, env.JOBS._pending.length, ...env.JOBS._pending.filter((m) => m.body.type === "account.purge"));
    await drainQueue(env);
    assert.equal(db.prepare("SELECT status FROM jobs WHERE dedupe_key = ?").get(`account.purge:${id}`).status, "done");
    assertNothingLeft(env, db, id);
  });
});
