// The admin Creator Accounts tab: one page at a time, searchable over every
// account (it used to render the first 1,000 and stop, so the rest could not
// be found), and the Show plays figure on the Playback tab.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { call, makeD1, makeEnv, makeKv } from "./harness.mjs";

async function adminCookie(env) {
  const login = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
  const m = (login.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/);
  return m ? m[1] : "";
}

function seed(DB, n) {
  for (let i = 1; i <= n; i++) {
    const name = "user" + String(i).padStart(4, "0");
    DB.q(
      "INSERT INTO creators (username, display_name, key_hash, created_at, last_active) VALUES (?, ?, 'h', ?, ?)",
      name, "Name " + name, 1000 + i, 1000 + i
    );
  }
}

describe("admin creator accounts paging and search", () => {
  it("serves 50 per page by default and reaches every account", async () => {
    const DB = makeD1();
    const env = makeEnv({ DB, CONFIGS: makeKv() });
    seed(DB, 120);
    const cookie = await adminCookie(env);
    const p1 = await call(env, "/admin/api/creators", { cookie });
    assert.equal(p1.body.ok, true);
    assert.equal(p1.body.rows.length, 50);
    assert.equal(p1.body.total, 120);
    assert.equal(p1.body.pages, 3);
    // newest activity first
    assert.equal(p1.body.rows[0].username, "user0120");
    const p3 = await call(env, "/admin/api/creators?page=3", { cookie });
    assert.equal(p3.body.rows.length, 20);
    assert.equal(p3.body.rows[19].username, "user0001");
    const big = await call(env, "/admin/api/creators?pageSize=100", { cookie });
    assert.equal(big.body.rows.length, 100);
    assert.equal(big.body.pages, 2);
    const odd = await call(env, "/admin/api/creators?pageSize=7", { cookie });
    assert.equal(odd.body.pageSize, 50, "only 50 or 100 are accepted");
  });

  it("searches every username, past the first page, and treats % and _ literally", async () => {
    const DB = makeD1();
    const env = makeEnv({ DB, CONFIGS: makeKv() });
    seed(DB, 120);
    DB.q("INSERT INTO creators (username, display_name, key_hash, created_at, last_active) VALUES ('a_b', 'Under', 'h', 1, 1)");
    DB.q("INSERT INTO creators (username, display_name, key_hash, created_at, last_active) VALUES ('axb', 'Other', 'h', 1, 1)");
    const cookie = await adminCookie(env);
    const hit = await call(env, "/admin/api/creators?q=USER0003", { cookie });
    assert.deepEqual(hit.body.rows.map((r) => r.username), ["user0003"]);
    assert.equal(hit.body.matched, 1);
    assert.equal(hit.body.total, 122);
    const wild = await call(env, "/admin/api/creators?q=a_b", { cookie });
    assert.deepEqual(wild.body.rows.map((r) => r.username), ["a_b"], "_ is not a wildcard");
    const pct = await call(env, "/admin/api/creators?q=%25", { cookie });
    assert.equal(pct.body.matched, 0, "% is not a wildcard");
  });

  it("clamps a page past the end and refuses a signed-out request", async () => {
    const DB = makeD1();
    const env = makeEnv({ DB, CONFIGS: makeKv() });
    seed(DB, 60);
    const cookie = await adminCookie(env);
    const far = await call(env, "/admin/api/creators?page=99", { cookie });
    assert.equal(far.body.page, 2);
    assert.equal(far.body.rows.length, 10);
    const out = await call(env, "/admin/api/creators");
    assert.equal(out.status, 401);
  });

  it("works from KV when there is no D1", async () => {
    const CONFIGS = makeKv();
    const env = makeEnv({ CONFIGS });
    for (const n of ["zed", "amy", "bob"]) await CONFIGS.put("creator:" + n, JSON.stringify({ displayName: n.toUpperCase(), createdAt: 5 }));
    const cookie = await adminCookie(env);
    const all = await call(env, "/admin/api/creators", { cookie });
    assert.deepEqual(all.body.rows.map((r) => r.username), ["amy", "bob", "zed"]);
    const one = await call(env, "/admin/api/creators?q=bo", { cookie });
    assert.deepEqual(one.body.rows.map((r) => [r.username, r.displayName]), [["bob", "BOB"]]);
  });
});

describe("admin Playback tab: Show plays", () => {
  it("counts episodes played as show plays and does not double count the total", async () => {
    const DB = makeD1();
    const env = makeEnv({ DB, CONFIGS: makeKv() });
    DB.q("INSERT INTO stats (kind, day, n) VALUES ('watch_type:movie', 'total', 4)");
    DB.q("INSERT INTO stats (kind, day, n) VALUES ('watch_type:episode', 'total', 9)");
    const cookie = await adminCookie(env);
    const r = await call(env, "/admin/api/analytics?section=audience", { cookie });
    assert.equal(r.body.watchTypes.movies, 4);
    assert.equal(r.body.watchTypes.shows, 9, "show plays are the episodes played");
    assert.equal(r.body.watchTypes.total, 13);
  });
});
