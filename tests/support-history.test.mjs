// "My support history" (/api/feedback/threads) and deleting it (/api/feedback/delete).
//
//   * The by-account lookup read the newest 300 feedback rows of EVERYONE and
//     filtered by name in JavaScript, so once 300 newer threads existed an
//     account's older conversation vanished from its own list. It now asks the
//     database for that account's rows (migration 0022 adds feedback.creator_name).
//     A database that has not run 0022 yet keeps working on the old statement.
//   * A person can delete their own chat history. The rule is the one replying
//     already follows: a thread nobody owns can be deleted by whoever holds its
//     id (that id is its only credential); a thread that belongs to an account
//     takes that account's key.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { awaitFreshRateWindow, call, createUser, makeD1, makeEnv, makeKv, nextIp } from "./harness.mjs";

const ROOT = new URL("../", import.meta.url);
const read = (f) => readFileSync(new URL(f, ROOT), "utf8");

const newEnv = () => makeEnv({ DB: makeD1(), CONFIGS: makeKv() });

async function file(env, message, who = null) {
  const r = await call(env, "/api/feedback", {
    method: "POST",
    ip: nextIp(),
    json: { message, ...(who ? { creatorName: who.creatorName, creatorKey: who.creatorKey } : {}) },
  });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  return r.body.entry;
}

const mine = (env, who) =>
  call(env, "/api/feedback/threads", { method: "POST", json: { creatorName: who.creatorName, creatorKey: who.creatorKey } });

const remove = (env, json, ip = nextIp()) => call(env, "/api/feedback/delete", { method: "POST", ip, json });

async function stored(env, id) {
  const row = await env.DB.prepare("SELECT id FROM feedback WHERE id = ?").bind(id).first();
  const kv = await env.CONFIGS.get(`feedback:${id}`);
  return { d1: !!row, kv: !!kv };
}

describe("support history by account", () => {
  it("still lists an old conversation after 300+ newer threads from other people", async () => {
    const env = newEnv();
    const alice = await createUser(env, "histalice");
    const old = await file(env, "my first report", alice);
    for (let i = 0; i < 305; i++) await file(env, "someone else " + i);
    const r = await mine(env, alice);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.threads.map((t) => t.id), [old.id]);
  });

  it("returns only that account's threads, newest first", async () => {
    const env = newEnv();
    const alice = await createUser(env, "histcarol");
    const bob = await createUser(env, "histbob");
    const a1 = await file(env, "alice one", alice);
    await file(env, "bob one", bob);
    await file(env, "anonymous");
    const a2 = await file(env, "alice two", alice);
    const r = await mine(env, alice);
    assert.deepEqual(r.body.threads.map((t) => t.id), [a2.id, a1.id]);
  });

  it("a database without migration 0022 still files and lists threads", async () => {
    const DB = makeD1();
    DB.failWhen((sql) => /creator_name/.test(sql));
    const env = makeEnv({ DB, CONFIGS: makeKv() });
    const alice = await createUser(env, "histdave");
    const t = await file(env, "before the migration", alice);
    assert.equal((await stored(env, t.id)).d1, true, "the thread is still written to the database");
    const r = await mine(env, alice);
    assert.deepEqual(r.body.threads.map((x) => x.id), [t.id]);
  });

  it("migration 0022 gives existing rows the creator_name they were filed under", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE feedback (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'open', subject TEXT,
             body_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
    const ins = db.prepare("INSERT INTO feedback (id, body_json, created_at, updated_at) VALUES (?, ?, 1, 1)");
    ins.run("a", JSON.stringify({ id: "a", creatorName: "  Alice " }));
    ins.run("b", JSON.stringify({ id: "b", creatorName: null }));
    ins.run("c", JSON.stringify({ id: "c" }));
    db.exec(read("migrations/0022_feedback_creator_name.sql"));
    const rows = Object.fromEntries(db.prepare("SELECT id, creator_name FROM feedback").all().map((r) => [r.id, r.creator_name]));
    assert.deepEqual(rows, { a: "alice", b: null, c: null });
  });
});

describe("deleting your support chat history", () => {
  it("an anonymous reporter can delete a thread with its id, from the database and the KV copy", async () => {
    const env = newEnv();
    const t = await file(env, "anonymous report");
    assert.deepEqual(await stored(env, t.id), { d1: true, kv: true });
    const r = await remove(env, { threadIds: [t.id] });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.deleted, 1);
    assert.deepEqual(await stored(env, t.id), { d1: false, kv: false });
    const again = await call(env, "/api/feedback/threads", { method: "POST", json: { threadIds: [t.id] } });
    assert.deepEqual(again.body.threads, []);
  });

  it("a thread that belongs to an account is not deleted by its id alone", async () => {
    const env = newEnv();
    const alice = await createUser(env, "delalice");
    const t = await file(env, "private", alice);
    const r = await remove(env, { threadIds: [t.id] });
    assert.equal(r.body.deleted, 0);
    assert.deepEqual(await stored(env, t.id), { d1: true, kv: true });
  });

  it("signed in, it deletes every thread of that account, including ones this device never saw", async () => {
    const env = newEnv();
    const alice = await createUser(env, "delcarol");
    const bob = await createUser(env, "delbob");
    const a1 = await file(env, "one", alice);
    const a2 = await file(env, "two", alice);
    const b1 = await file(env, "bob", bob);
    const anon = await file(env, "anon");
    const r = await remove(env, { creatorName: alice.creatorName, creatorKey: alice.creatorKey, threadIds: [] });
    assert.equal(r.body.deleted, 2);
    assert.equal((await stored(env, a1.id)).d1, false);
    assert.equal((await stored(env, a2.id)).d1, false);
    assert.equal((await stored(env, a2.id)).kv, false);
    assert.equal((await stored(env, b1.id)).d1, true, "another account's thread stays");
    assert.equal((await stored(env, anon.id)).d1, true, "an unrelated anonymous thread stays");
  });

  it("signed in, it also deletes this device's anonymous threads but not another account's by id", async () => {
    const env = newEnv();
    const alice = await createUser(env, "deleve");
    const bob = await createUser(env, "delfrank");
    const anon = await file(env, "anon from this device");
    const theirs = await file(env, "bob private", bob);
    const r = await remove(env, { creatorName: alice.creatorName, creatorKey: alice.creatorKey, threadIds: [anon.id, theirs.id] });
    assert.equal(r.body.deleted, 1);
    assert.equal((await stored(env, anon.id)).d1, false);
    assert.equal((await stored(env, theirs.id)).d1, true);
  });

  it("a wrong key is a 401 and nothing is deleted", async () => {
    const env = newEnv();
    const alice = await createUser(env, "delgina");
    const t = await file(env, "mine", alice);
    const r = await remove(env, { creatorName: alice.creatorName, creatorKey: "MYL-NOPE-NOPE-NOPE", threadIds: [t.id] });
    assert.equal(r.status, 401);
    assert.deepEqual(await stored(env, t.id), { d1: true, kv: true });
  });

  it("works on a database that has not run migration 0022", async () => {
    const DB = makeD1();
    DB.failWhen((sql) => /creator_name/.test(sql));
    const env = makeEnv({ DB, CONFIGS: makeKv() });
    const alice = await createUser(env, "delhank");
    const t = await file(env, "old shape", alice);
    const r = await remove(env, { creatorName: alice.creatorName, creatorKey: alice.creatorKey });
    assert.equal(r.body.deleted, 1);
    assert.deepEqual(await stored(env, t.id), { d1: false, kv: false });
  });

  it("is limited per address", async () => {
    const env = newEnv();
    const ip = nextIp();
    const results = [];
    // 20 a minute, counted per clock minute: 25 requests across a boundary
    // would get a second budget and never see the 429.
    await awaitFreshRateWindow();
    for (let i = 0; i < 25; i++) results.push((await remove(env, { threadIds: ["x"] }, ip)).status);
    assert.equal(results[0], 200);
    assert.ok(results.includes(429), "some request is refused: " + results.join(","));
  });
});
