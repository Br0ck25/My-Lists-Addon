// Shared channels that no account owns.
//
// Before shares needed an account, anyone could mint a channel link with no
// owner. Those records are still there. They keep opening (a link already handed
// out), but nobody can withdraw one, and /api/channel/share let any signed-in
// person who knew such a code overwrite it and take it over, replacing the
// channel for everyone holding the link.
//
//   * Sharing under an ownerless code now makes a NEW link and leaves the old
//     record alone.
//   * /admin/api/channel-ownerless counts them (a dry run, the default) and
//     deletes them in batches, only when told to and only with the confirmation
//     phrase, so the operator can look first and take a backup first.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { call, createUser, makeD1, makeEnv, makeKv } from "./harness.mjs";

const EPISODE = { kind: "episode", imdbId: "tt0108778", season: 5, episode: 13, showName: "Friends", epName: "The One", title: "Friends S5E13" };
const channelOf = (name) => ({ name, items: [EPISODE] });
const CONFIRM = "delete ownerless channels";

async function adminCookie(env) {
  const r = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
  const m = (r.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/);
  return m ? m[1] : "";
}

async function seed(env, code, over = {}) {
  const record = { code, channel: channelOf("Chan " + code), description: "", owner: "", published: false, updatedAt: 1, ...over };
  await env.CONFIGS.put("channelshare:" + code, JSON.stringify(record));
  return record;
}

const newEnv = () => makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
const keys = (env, prefix) => [...env.CONFIGS._store.keys()].filter((k) => k.startsWith(prefix)).sort();

describe("sharing under a code nobody owns", () => {
  it("makes a new link and leaves the old record exactly as it was", async () => {
    const env = newEnv();
    const before = await seed(env, "OLDANON1");
    const u = await createUser(env, "newowner");
    const r = await call(env, "/api/channel/share", {
      method: "POST",
      json: { creatorName: u.creatorName, creatorKey: u.creatorKey, code: "OLDANON1", channel: channelOf("Taken over") },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.notEqual(r.body.code, "OLDANON1", "a new code, not the old one");
    assert.deepEqual(JSON.parse(env.CONFIGS._store.get("channelshare:OLDANON1")), before, "the old record is untouched");
    const fresh = JSON.parse(env.CONFIGS._store.get("channelshare:" + r.body.code));
    assert.equal(fresh.owner, "newowner");
    assert.equal(fresh.channel.name, "Taken over");
  });

  it("an owner can still update their own code in place", async () => {
    const env = newEnv();
    const u = await createUser(env, "keeper");
    const auth = { creatorName: u.creatorName, creatorKey: u.creatorKey };
    const first = await call(env, "/api/channel/share", { method: "POST", json: { ...auth, channel: channelOf("One") } });
    const again = await call(env, "/api/channel/share", { method: "POST", json: { ...auth, code: first.body.code, channel: channelOf("Two") } });
    assert.equal(again.body.code, first.body.code);
    assert.equal(JSON.parse(env.CONFIGS._store.get("channelshare:" + first.body.code)).channel.name, "Two");
  });

  it("someone else's code is still refused", async () => {
    const env = newEnv();
    const a = await createUser(env, "ownera");
    const b = await createUser(env, "ownerb");
    const first = await call(env, "/api/channel/share", { method: "POST", json: { creatorName: a.creatorName, creatorKey: a.creatorKey, channel: channelOf("A's") } });
    const r = await call(env, "/api/channel/share", { method: "POST", json: { creatorName: b.creatorName, creatorKey: b.creatorKey, code: first.body.code, channel: channelOf("B's") } });
    assert.equal(r.status, 403);
  });

  it("an ownerless link still opens for whoever holds it", async () => {
    const env = newEnv();
    await seed(env, "OLDANON2");
    const r = await call(env, "/api/channel/share?code=OLDANON2");
    assert.equal(r.body.ok, true);
    assert.equal(r.body.channel.name, "Chan OLDANON2");
  });
});

describe("/admin/api/channel-ownerless", () => {
  async function setup() {
    const env = newEnv();
    await seed(env, "ANON0001");
    await seed(env, "ANON0002", { published: true });
    await seed(env, "ANON0003");
    await seed(env, "OWNED001", { owner: "alice", published: true });
    await env.CONFIGS.put("channellikevoters:ANON0002", JSON.stringify(["u:bob"]));
    await env.CONFIGS.put("channellikevoters:OWNED001", JSON.stringify(["u:bob"]));
    return { env, cookie: await adminCookie(env) };
  }
  const post = (env, cookie, json) => call(env, "/admin/api/channel-ownerless", { method: "POST", cookie, json });

  it("is for the admin only", async () => {
    const { env } = await setup();
    const r = await post(env, "", {});
    assert.ok([401, 403].includes(r.status), String(r.status));
  });

  it("by default only counts: it lists the ownerless ones and deletes nothing", async () => {
    const { env, cookie } = await setup();
    const r = await post(env, cookie, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.apply, false);
    assert.deepEqual(r.body.ownerless.map((c) => c.code).sort(), ["ANON0001", "ANON0002", "ANON0003"]);
    assert.equal(r.body.deleted, 0);
    assert.equal(r.body.done, true);
    assert.deepEqual(keys(env, "channelshare:"), ["channelshare:ANON0001", "channelshare:ANON0002", "channelshare:ANON0003", "channelshare:OWNED001"]);
  });

  it("will not delete without the confirmation phrase", async () => {
    const { env, cookie } = await setup();
    for (const confirm of [undefined, "yes", "DELETE"]) {
      const r = await post(env, cookie, { apply: true, confirm });
      assert.equal(r.status, 400, "confirm " + JSON.stringify(confirm));
    }
    assert.equal(keys(env, "channelshare:").length, 4);
  });

  it("with the phrase, deletes the ownerless ones, their like records and listings, and nothing else", async () => {
    const { env, cookie } = await setup();
    await env.CONFIGS.put("index:publicchannels", JSON.stringify({ entries: [
      { code: "ANON0002", name: "x", owner: "", likes: 0 }, { code: "OWNED001", name: "y", owner: "alice", likes: 0 },
    ], updatedAt: 1 }));
    const r = await post(env, cookie, { apply: true, confirm: CONFIRM });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.deleted, 3);
    assert.deepEqual(r.body.failed, []);
    assert.deepEqual(keys(env, "channelshare:"), ["channelshare:OWNED001"], "the owned channel stays");
    assert.deepEqual(keys(env, "channellikevoters:"), ["channellikevoters:OWNED001"]);
    const index = JSON.parse(env.CONFIGS._store.get("index:publicchannels"));
    assert.deepEqual(index.entries.map((e) => e.code), ["OWNED001"], "gone from Explore Channels too");
  });

  it("works through a large set in batches with a cursor, and says when it is done", async () => {
    const env = newEnv();
    for (let i = 0; i < 7; i++) await seed(env, "ANONB00" + i);
    await seed(env, "OWNEDB01", { owner: "alice" });
    const cookie = await adminCookie(env);
    let cursor;
    let deleted = 0;
    let rounds = 0;
    for (;;) {
      const r = await post(env, cookie, { apply: true, confirm: CONFIRM, limit: 3, cursor });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      deleted += r.body.deleted;
      rounds++;
      if (r.body.done) break;
      cursor = r.body.next;
      assert.ok(cursor, "not done means there is a cursor");
      assert.ok(rounds < 10, "it must finish");
    }
    assert.equal(deleted, 7);
    assert.ok(rounds >= 3, "7 channels in batches of 3 take at least 3 calls: " + rounds);
    assert.deepEqual(keys(env, "channelshare:"), ["channelshare:OWNEDB01"]);
  });

  it("a record it cannot read is reported, not deleted", async () => {
    const { env, cookie } = await setup();
    await env.CONFIGS.put("channelshare:BROKEN01", "{not json");
    const r = await post(env, cookie, { apply: true, confirm: CONFIRM });
    assert.equal(r.body.deleted, 3);
    assert.deepEqual(r.body.unreadable, ["BROKEN01"]);
    assert.ok(env.CONFIGS._store.has("channelshare:BROKEN01"));
  });
});

describe("/admin/api/channel-ownerless with channels in the new tables only", () => {
  const insert = (DB, code, { owner = null, deletedAt = null, visibility = "unlisted" } = {}) =>
    DB.prepare(
      "INSERT INTO channels (public_code, owner_account_id, name, visibility, definition_json, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, '{}', 1, 1, ?)"
    ).bind(code, owner, "Chan " + code, visibility, deletedAt).run();

  it("counts, then deletes, the channels with no owner, and skips ones already deleted", async () => {
    const DB = makeD1();
    const env = makeEnv({ DB, CONFIGS: makeKv(), FF_V2_LISTS_ONLY: "1" });
    await insert(DB, "V2ANON01");
    await insert(DB, "V2ANON02", { visibility: "public" });
    await insert(DB, "V2GONE01", { deletedAt: 5 });
    const cookie = await adminCookie(env);
    const count = await call(env, "/admin/api/channel-ownerless", { method: "POST", cookie, json: {} });
    assert.equal(count.status, 200, JSON.stringify(count.body));
    assert.deepEqual(count.body.ownerless.map((c) => c.code), ["V2ANON01", "V2ANON02"]);
    assert.equal(count.body.ownerless[1].published, true);
    const live = async () => (await DB.prepare("SELECT public_code FROM channels WHERE deleted_at IS NULL ORDER BY id").all()).results.map((r) => r.public_code);
    assert.deepEqual(await live(), ["V2ANON01", "V2ANON02"], "a count deletes nothing");
    const gone = await call(env, "/admin/api/channel-ownerless", { method: "POST", cookie, json: { apply: true, confirm: CONFIRM } });
    assert.equal(gone.body.deleted, 2);
    assert.deepEqual(await live(), []);
  });
});
