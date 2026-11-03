// D-37: no anonymous like votes are kept.
//
// Votes cast signed-out before D-6 are stored with a voter id "a:<hash of the
// visitor's IP and the list>", in several places, and the hash can be reversed
// to the IP address. The owner decided (2026-11-02) to remove them all and to
// lower every like total by the votes removed, so each total equals the
// signed-in likes behind it. /admin/api/anonymous-likes-purge does that:
//
//   * a dry run (the default) only counts;
//   * it deletes only with {"apply":true,"confirm":"delete anonymous likes"};
//   * it works in batches (cursor / next / done);
//   * signed-in votes ("u:", "acct:") and the channel "added" records are kept;
//   * the same vote held in the KV ledger AND in D1 list_likes lowers the legacy
//     total once; the new tables (likes, lists.like_count, channels.like_count)
//     are a separate store with their own total, lowered once for their own rows;
//   * a total never goes below 0, and a second run changes nothing.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { call, createUser, listsBackfillStep, makeD1, makeEnv, makeKv, seedAnonPublishedList } from "./harness.mjs";

const CONFIRM = "delete anonymous likes";
const ROUTE = "/admin/api/anonymous-likes-purge";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function adminCookie(env) {
  const r = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
  const m = (r.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/);
  return m ? m[1] : "";
}

const kvJson = (env, key) => JSON.parse(env.CONFIGS._store.get(key));
const all = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).all().then((r) => r.results.map((row) => ({ ...row })));
const one = async (env, sql, ...args) => (await all(env, sql, ...args))[0];

// Everything the purge may touch, as plain data, so "nothing changed" is one deepEqual.
async function snapshot(env) {
  return {
    kv: [...env.CONFIGS._store.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    listLikes: await all(env, "SELECT * FROM list_likes ORDER BY list_id, voter_id"),
    likes: await all(env, "SELECT target_type, target_id, voter FROM likes ORDER BY target_type, target_id, voter"),
    creatorLists: await all(env, "SELECT id, likes FROM creator_lists ORDER BY id"),
    publishedLists: await all(env, "SELECT slug, likes FROM published_lists ORDER BY slug"),
    lists: await all(env, "SELECT public_id, like_count FROM lists ORDER BY public_id"),
    channels: await all(env, "SELECT public_code, like_count, add_count FROM channels ORDER BY public_code"),
  };
}

// Runs the route to the end, adding up the counts of every batch.
async function runAll(env, cookie, body, limit = 3) {
  const total = {};
  let cursor;
  for (let i = 0; i < 200; i++) {
    const r = await call(env, ROUTE, { method: "POST", cookie, json: { ...body, limit, ...(cursor ? { cursor } : {}) } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    for (const [k, v] of Object.entries(r.body)) if (typeof v === "number") total[k] = (total[k] || 0) + v;
    if (r.body.done) return total;
    assert.ok(r.body.next, "a batch that is not done names where to go on");
    cursor = r.body.next;
  }
  throw new Error("the purge did not finish");
}

const record = (likes, extra = {}) => JSON.stringify({ name: "x", type: "movie", items: [], visibility: "public", likes, ...extra });

// Lists, an external list and channels, each with signed-in and anonymous votes
// in every store that holds votes. Anonymous ids are a:<hex>.
async function seed() {
  const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
  await createUser(env, "alice");
  const kv = env.CONFIGS._store;
  const run = (sql, ...args) => env.DB.prepare(sql).bind(...args).run();
  const listLike = (id, voter) => run("INSERT INTO list_likes (list_id, voter_id, created_at) VALUES (?, ?, 1)", id, voter);
  const v2Like = (type, id, voter) => run("INSERT INTO likes (target_type, target_id, voter, created_at) VALUES (?, ?, ?, 1)", type, id, voter);
  const v2List = (publicId, likes) => run(
    "INSERT INTO lists (public_id, slug, name, media_type, visibility, like_count, created_at, updated_at) VALUES (?, ?, 'x', 'movie', 'public', ?, 1, 1)", publicId, publicId, likes);
  const v2Channel = (code, likes, adds) => run(
    "INSERT INTO channels (public_code, name, visibility, like_count, add_count, created_at, updated_at) VALUES (?, 'x', 'public', ?, ?, 1, 1)", code, likes, adds);

  // 1. alice:top. Signed in: u:bob. Anonymous: k1 in BOTH the KV ledger and list_likes,
  //    k2 in KV only, d1 in list_likes only: three distinct votes. Total 4 = 1 + 3.
  kv.set("creatorlist:alice:top", record(4));
  kv.set("listlikevoters:alice:top", JSON.stringify(["u:bob", "a:k1", "a:k2"]));
  await run("INSERT INTO creator_lists (id, username, name, type, visibility, likes, created_at, updated_at) VALUES ('alice:top', 'alice', 'x', 'movie', 'public', 4, 1, 1)");
  for (const v of ["u:bob", "a:k1", "a:d1"]) await listLike("c:alice:top", v);
  await v2List("pubtop", 4);
  for (const v of ["acct:7", "a:k1", "a:k2", "a:d1"]) await v2Like("list", "pubtop", v);

  // 2. alice:d1only: its anonymous vote is in D1 only (no KV ledger).
  kv.set("creatorlist:alice:d1only", record(1));
  await run("INSERT INTO creator_lists (id, username, name, type, visibility, likes, created_at, updated_at) VALUES ('alice:d1only', 'alice', 'x', 'movie', 'public', 1, 1, 1)");
  await listLike("c:alice:d1only", "a:o1");

  // 3. A legacy anonymous published list: two anonymous votes, nothing else.
  seedAnonPublishedList(env, "oldie", { likes: 2 });
  kv.set("listlikevoters:user:oldie", JSON.stringify(["a:z1", "a:z2"]));
  await run("INSERT INTO published_lists (slug, name, type, visibility, likes, created_at, updated_at) VALUES ('oldie', 'x', 'movie', 'public', 2, 1, 1)");

  // 4. An external list (H1): total 3 = 1 signed in + e1 and e2; e1 is in all three stores.
  kv.set("externallike:H1", JSON.stringify({ url: "https://trakt.tv/users/u/lists/l", likes: 3 }));
  kv.set("extlikevoters:H1", JSON.stringify(["u:bob", "a:e1", "a:e2"]));
  for (const v of ["u:bob", "a:e1"]) await listLike("ext:H1", v);
  for (const v of ["acct:7", "a:e1", "a:e2"]) await v2Like("external", "H1", v);

  // 5. A total LOWER than its votes (H2: total 1, three anonymous votes) must stop at 0.
  kv.set("externallike:H2", JSON.stringify({ url: "https://trakt.tv/users/u/lists/m", likes: 1 }));
  kv.set("extlikevoters:H2", JSON.stringify(["a:f1", "a:f2", "a:f3"]));

  // 6. A published channel: total 3 = u:bob + c1 + c2. Its "added" records are not likes.
  kv.set("channelshare:CH1", JSON.stringify({ code: "CH1", published: true, owner: "alice", channel: { name: "C", items: [] }, likes: 3 }));
  kv.set("index:publicchannels", JSON.stringify({ entries: [{ code: "CH1", name: "C", likes: 3, adds: 5 }, { code: "CH2", name: "D", likes: 9, adds: 1 }], updatedAt: 1 }));
  kv.set("channellikevoters:CH1", JSON.stringify(["u:bob", "a:c1"]));
  for (const v of ["u:bob", "a:c1", "a:c2"]) await listLike("ch:CH1", v);
  await listLike("channeladdvoters:CH1", "a:addr");
  await v2Channel("CH1", 3, 5);
  for (const v of ["acct:7", "a:c1", "a:c2"]) await v2Like("channel", "CH1", v);
  await v2Like("channel_add", "CH1", "a:addr");

  // 7. A channel whose new-tables total (1) is lower than its anonymous rows (2).
  await v2Channel("CH2", 1, 0);
  for (const v of ["a:g1", "a:g2"]) await v2Like("channel", "CH2", v);

  return { env, cookie: await adminCookie(env) };
}

describe("D-37: /admin/api/anonymous-likes-purge", () => {
  it("is for the admin only", async () => {
    const { env } = await seed();
    const before = await snapshot(env);
    const r = await call(env, ROUTE, { method: "POST", json: { apply: true, confirm: CONFIRM } });
    assert.equal(r.status, 401);
    assert.deepEqual(await snapshot(env), before);
  });

  it("a dry run changes nothing and reports exactly what an apply would remove", async () => {
    const { env, cookie } = await seed();
    const before = await snapshot(env);
    const dry = await runAll(env, cookie, {});
    assert.deepEqual(await snapshot(env), before, "a dry run writes nothing");
    assert.equal(dry.kvVotes, 10, "anonymous voters in KV ledgers: 2 + 2 + 2 + 3 + 1");
    assert.equal(dry.d1Votes, 6, "anonymous rows in list_likes (not the channel 'added' records): 2 + 1 + 1 + 2");
    assert.equal(dry.legacyVotes, 13, "distinct votes taken off the old totals; one in KV and D1 counts once");
    assert.equal(dry.legacyTargets, 6);
    assert.equal(dry.v2Votes, 9, "anonymous rows in the new likes table (not channel_add): 3 + 2 + 2 + 2");
    assert.equal(dry.v2Targets, 4);
    assert.ok(!dry.removed, "a dry run removes nothing");
  });

  it("apply needs the confirmation phrase", async () => {
    const { env, cookie } = await seed();
    const before = await snapshot(env);
    for (const confirm of [undefined, "yes", "delete legacy key lookups"]) {
      const r = await call(env, ROUTE, { method: "POST", cookie, json: { apply: true, confirm } });
      assert.equal(r.status, 400);
    }
    assert.deepEqual(await snapshot(env), before);
  });

  it("apply removes every anonymous vote, keeps the signed-in ones, and lowers each total by the votes removed", async () => {
    const { env, cookie } = await seed();
    const done = await runAll(env, cookie, { apply: true, confirm: CONFIRM });
    assert.equal(done.legacyVotes, 13);
    assert.equal(done.v2Votes, 9);

    // No anonymous id is left in any ledger, list_likes or likes row (except the 'added' records).
    for (const [key, raw] of env.CONFIGS._store) {
      if (key.includes("likevoters:")) assert.ok(!JSON.parse(raw).some((v) => v.startsWith("a:")), `${key} still holds an anonymous vote`);
    }
    assert.deepEqual((await all(env, "SELECT list_id, voter_id FROM list_likes WHERE voter_id LIKE 'a:%' ORDER BY list_id")).map((r) => r.list_id),
      ["channeladdvoters:CH1"], "only the channel 'added' record is left");
    assert.deepEqual(await all(env, "SELECT target_type, target_id, voter FROM likes WHERE voter LIKE 'a:%'"),
      [{ target_type: "channel_add", target_id: "CH1", voter: "a:addr" }]);

    // Signed-in votes are untouched.
    assert.deepEqual(kvJson(env, "listlikevoters:alice:top"), ["u:bob"]);
    assert.deepEqual(kvJson(env, "extlikevoters:H1"), ["u:bob"]);
    assert.deepEqual(kvJson(env, "channellikevoters:CH1"), ["u:bob"]);
    assert.deepEqual((await all(env, "SELECT voter_id FROM list_likes WHERE list_id IN ('c:alice:top', 'ext:H1', 'ch:CH1') ORDER BY list_id")).map((r) => r.voter_id), ["u:bob", "u:bob", "u:bob"]);
    assert.deepEqual((await all(env, "SELECT voter FROM likes WHERE target_type IN ('list', 'external', 'channel') AND voter LIKE 'acct:%' ORDER BY target_type")).map((r) => r.voter), ["acct:7", "acct:7", "acct:7"]);

    // Totals equal the signed-in likes behind them, in every place a total is kept.
    assert.equal(kvJson(env, "creatorlist:alice:top").likes, 1);
    assert.equal((await one(env, "SELECT likes FROM creator_lists WHERE id = 'alice:top'")).likes, 1);
    assert.equal((await one(env, "SELECT like_count AS n FROM lists WHERE public_id = 'pubtop'")).n, 1);
    assert.equal(kvJson(env, "creatorlist:alice:d1only").likes, 0);
    assert.equal((await one(env, "SELECT likes FROM creator_lists WHERE id = 'alice:d1only'")).likes, 0);
    assert.equal(kvJson(env, "publishedlist:user:oldie").likes, 0);
    assert.equal((await one(env, "SELECT likes FROM published_lists WHERE slug = 'oldie'")).likes, 0);
    assert.equal(kvJson(env, "externallike:H1").likes, 1);
    assert.equal(kvJson(env, "channelshare:CH1").likes, 1);
    assert.equal(kvJson(env, "index:publicchannels").entries.find((e) => e.code === "CH1").likes, 1);
    assert.equal((await one(env, "SELECT like_count AS n FROM channels WHERE public_code = 'CH1'")).n, 1);

    // Never below 0, and nothing that is not a like moves.
    assert.equal(kvJson(env, "externallike:H2").likes, 0);
    assert.equal((await one(env, "SELECT like_count AS n FROM channels WHERE public_code = 'CH2'")).n, 0);
    assert.equal((await one(env, "SELECT add_count AS n FROM channels WHERE public_code = 'CH1'")).n, 5, "the 'added' count is not a like");
    assert.equal(kvJson(env, "index:publicchannels").entries.find((e) => e.code === "CH1").adds, 5);
    assert.equal(kvJson(env, "index:publicchannels").entries.find((e) => e.code === "CH2").likes, 9, "a channel with no anonymous votes keeps its total");
  });

  it("a second apply removes nothing and lowers nothing", async () => {
    const { env, cookie } = await seed();
    await runAll(env, cookie, { apply: true, confirm: CONFIRM });
    const after = await snapshot(env);
    const again = await runAll(env, cookie, { apply: true, confirm: CONFIRM });
    assert.deepEqual(await snapshot(env), after);
    for (const k of ["kvVotes", "d1Votes", "legacyVotes", "legacyTargets", "v2Votes", "v2Targets"]) assert.equal(again[k] || 0, 0, k);
    const dry = await runAll(env, cookie, {});
    assert.equal((dry.legacyVotes || 0) + (dry.v2Votes || 0), 0, "a dry run afterwards finds nothing either");
  });

  it("batches of one target give the same result as one big batch", async () => {
    const a = await seed();
    const b = await seed();
    await runAll(a.env, a.cookie, { apply: true, confirm: CONFIRM }, 1);
    await runAll(b.env, b.cookie, { apply: true, confirm: CONFIRM }, 100);
    // Account keys and timestamps differ between the two environments; the likes do not.
    const likeState = async (env) => {
      const snap = await snapshot(env);
      const kv = snap.kv.filter(([k]) => /likevoters:|^externallike:|^channelshare:|^creatorlist:/.test(k));
      return { ...snap, kv };
    };
    assert.deepEqual(await likeState(a.env), await likeState(b.env));
  });
});

// An interrupted run must be finishable: each total is lowered once, by the votes
// that were on the target before the first run, whatever step failed.
describe("D-37: the purge can be re-run after a failure part-way through a target", () => {
  const likeState = async (env) => {
    const snap = await snapshot(env);
    return { ...snap, kv: snap.kv.filter(([k]) => /likevoters:|^externallike:|^channelshare:|^creatorlist:|^publishedlist:|^index:publicchannels/.test(k)).map(([k, v]) => [k, k === "index:publicchannels" ? JSON.stringify(JSON.parse(v).entries) : v.replace(/"publishedAt":\d+/, "")]) };
  };
  const markers = (env) => [...env.CONFIGS._store.keys()].filter((k) => k.startsWith("anonlikespurge:"));

  // One pass over every batch, whatever the status: a failed batch still says where to go on.
  async function passIgnoringFailures(env, cookie) {
    let cursor;
    const failed = [];
    for (let i = 0; i < 200; i++) {
      const r = await call(env, ROUTE, { method: "POST", cookie, json: { apply: true, confirm: CONFIRM, limit: 3, ...(cursor ? { cursor } : {}) } });
      failed.push(...((r.body && r.body.failed) || []));
      if (r.body.done) return failed;
      cursor = r.body.next;
    }
    throw new Error("did not finish");
  }

  const faults = [
    ["the KV record total of a list", (e) => { e.CONFIGS._hooks.beforePut = (k) => { if (k === "creatorlist:alice:top") throw new Error("kv down"); }; }],
    ["the KV ledger of a list", (e) => { e.CONFIGS._hooks.beforePut = (k) => { if (k === "listlikevoters:alice:top") throw new Error("kv down"); }; }],
    ["the KV ledger of an outside list (deleted when empty)", (e) => { e.CONFIGS._hooks.beforeDelete = (k) => { if (k === "extlikevoters:H2") throw new Error("kv down"); }; }],
    ["the channel directory row", (e) => { e.CONFIGS._hooks.beforePut = (k) => { if (k === "index:publicchannels") throw new Error("kv down"); }; }],
    ["the channel record total", (e) => { e.CONFIGS._hooks.beforePut = (k) => { if (k === "channelshare:CH1") throw new Error("kv down"); }; }],
    ["the D1 total of a list", (e) => e.DB.failWhen((sql) => /UPDATE creator_lists/.test(sql))],
    ["the D1 rows of a list", (e) => e.DB.failWhen((sql) => /DELETE FROM list_likes/.test(sql))],
    ["the D1 total of an anonymous published list", (e) => e.DB.failWhen((sql) => /UPDATE published_lists/.test(sql))],
    ["the new-table total of a list", (e) => e.DB.failWhen((sql) => /UPDATE lists SET like_count/.test(sql))],
    ["the new-table rows of a channel", (e) => e.DB.failWhen((sql) => /DELETE FROM likes/.test(sql))],
  ];

  for (const [name, inject] of faults) {
    it(`a failure on ${name}, then a normal run, ends exactly like one clean run; a third run changes nothing`, async () => {
      const clean = await seed();
      await runAll(clean.env, clean.cookie, { apply: true, confirm: CONFIRM });

      const { env, cookie } = await seed();
      inject(env);
      const failed = await passIgnoringFailures(env, cookie);
      assert.ok(failed.length > 0, "the injected failure was hit");
      env.CONFIGS._hooks.beforePut = null;
      env.CONFIGS._hooks.beforeDelete = null;
      env.DB.failWhen(null);
      await runAll(env, cookie, { apply: true, confirm: CONFIRM });
      await runAll(env, cookie, { apply: true, confirm: CONFIRM }); // an extra run is harmless
      assert.deepEqual(await likeState(env), await likeState(clean.env));
      assert.deepEqual(markers(env), [], "no progress record is left behind");
      const after = await snapshot(env);
      const third = await runAll(env, cookie, { apply: true, confirm: CONFIRM });
      assert.deepEqual(await snapshot(env), after);
      for (const k of ["legacyVotes", "v2Votes"]) assert.equal(third[k] || 0, 0, k);
    });
  }

  it("a failure on the last step of a list is still counted by a dry run, once", async () => {
    const { env, cookie } = await seed();
    env.CONFIGS._hooks.beforePut = (k) => { if (k === "listlikevoters:alice:top") throw new Error("kv down"); };
    await passIgnoringFailures(env, cookie);
    env.CONFIGS._hooks.beforePut = null;
    const dry = await runAll(env, cookie, {});
    assert.equal(dry.legacyVotes, 3, "alice:top still has its three votes to finish, counted once");
    assert.equal(dry.legacyTargets, 1);
    assert.equal(dry.v2Votes || 0, 0);
  });
});

describe("D-37: nothing creates or restores an anonymous vote", () => {
  it("a signed-out like request gets 401 and stores nothing", async () => {
    const { env } = await seed();
    const before = await snapshot(env);
    const calls = [
      ["/api/lists/like", { username: "alice", slug: "top", action: "like" }],
      ["/api/lists/like-external", { url: "https://trakt.tv/users/u/lists/l", action: "like" }],
      ["/api/channel/like", { code: "CH1", action: "like" }],
    ];
    for (const [route, json] of calls) {
      const r = await call(env, route, { method: "POST", json });
      assert.equal(r.status, 401, `${route}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.signInRequired, true);
    }
    assert.deepEqual(await snapshot(env), before);
  });

  it("likeVoterId gives a signed-out caller no voter id, and a signed-in one their account", async () => {
    const sb = { console, URL, URLSearchParams, atob, btoa, Uint8Array, TextDecoder, TextEncoder, Response, Headers, Request, crypto: globalThis.crypto };
    sb.globalThis = sb;
    vm.createContext(sb);
    for (const f of ["src/core/00_constants.js", "src/core/02_http-and-creator-utils.js"]) {
      vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sb, { filename: f });
    }
    const req = new Request("https://example.test/x", { headers: { "CF-Connecting-IP": "203.0.113.9" } });
    assert.equal(await sb.likeVoterId(req, {}, "", "alice:list"), null);
    assert.equal(await sb.likeVoterId(req, { LIKE_VOTER_PEPPER: "x".repeat(32) }, "", "alice:list"), null);
    assert.equal(await sb.likeVoterId(req, {}, "alice", "alice:list"), "u:alice");
  });

  it("after the purge, copying the old lists into the new tables brings no anonymous vote or count back", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), FF_V2_LISTS_API: "1" });
    const owner = await createUser(env, "listowner");
    const fan = await createUser(env, "fan");
    const save = await call(env, "/api/creator/lists/save", {
      method: "POST",
      json: { creatorName: owner.creatorName, creatorKey: owner.creatorKey, slug: "faves", name: "Faves", type: "movie", visibility: "public", items: [{ id: "tt0000001", imdbId: "tt0000001", type: "movie", title: "One" }] },
    });
    assert.equal(save.body && save.body.ok, true, JSON.stringify(save.body));
    const like = await call(env, "/api/lists/like", { method: "POST", json: { creatorName: fan.creatorName, creatorKey: fan.creatorKey, username: "listowner", slug: "faves", action: "like" } });
    assert.equal(like.body.likes, 1, JSON.stringify(like.body));

    // Two votes from before D-6, in KV and in D1, counted in both totals.
    const ledgerKey = "listlikevoters:listowner:faves";
    const voters = JSON.parse(env.CONFIGS._store.get(ledgerKey));
    env.CONFIGS._store.set(ledgerKey, JSON.stringify([...voters, "a:old1", "a:old2"]));
    for (const v of ["a:old1", "a:old2"]) await env.DB.prepare("INSERT INTO list_likes (list_id, voter_id, created_at) VALUES ('c:listowner:faves', ?, 1)").bind(v).run();
    const rec = JSON.parse(env.CONFIGS._store.get("creatorlist:listowner:faves"));
    env.CONFIGS._store.set("creatorlist:listowner:faves", JSON.stringify({ ...rec, likes: 3 }));
    await env.DB.prepare("UPDATE creator_lists SET likes = 3 WHERE id = 'listowner:faves'").run();

    const cookie = await adminCookie(env);
    await runAll(env, cookie, { apply: true, confirm: CONFIRM });
    assert.equal(JSON.parse(env.CONFIGS._store.get("creatorlist:listowner:faves")).likes, 1);

    for (let i = 0; i < 500; i++) {
      const r = await listsBackfillStep(env, { restart: i === 0 });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      if (r.body.done) break;
    }
    assert.deepEqual(await all(env, "SELECT voter FROM likes WHERE target_type = 'list' AND voter NOT LIKE 'acct:%'"), []);
    const list = await one(env, "SELECT like_count AS n FROM lists WHERE slug = 'faves'");
    assert.equal(list.n, 1, "the new total is the one signed-in like");
    assert.deepEqual(await all(env, "SELECT voter_id FROM list_likes WHERE voter_id LIKE 'a:%'"), []);
    assert.ok(!JSON.parse(env.CONFIGS._store.get(ledgerKey)).some((v) => v.startsWith("a:")));
  });
});
