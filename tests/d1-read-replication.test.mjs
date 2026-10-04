// D1 Read Replication (P8-1, Sessions API).
// Catalog, directory, and public list reads use env.DB.withSession()
// to query edge read replicas, reducing p95 latency worldwide.
// Sequential consistency bookmarks (x-d1-bookmark) are propagated
// across requests and responses.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeEnv, makeD1, call } from "./harness.mjs";

describe("P8-1: D1 Read Replication with withSession()", () => {
  it("routes /manifest.json reads through withSession and sets x-d1-bookmark", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db });

    const res = await call(env, "/manifest.json");
    assert.equal(res.status, 200);
    assert.equal(db._state.sessions, 1, "manifest read should use withSession");
    assert.equal(db._state.lastBookmark, "first-unconstrained");
    assert.equal(res.headers.get("x-d1-bookmark"), "bmk_1");
  });

  it("propagates client x-d1-bookmark to withSession on directory reads", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db });

    const res = await call(env, "/lists/public.json", {
      headers: { "x-d1-bookmark": "bmk_client_prev" },
    });
    assert.equal(res.status, 200);
    assert.equal(db._state.sessions, 1, "public directory read should use withSession");
    assert.equal(db._state.lastBookmark, "bmk_client_prev");
    assert.ok(res.headers.get("x-d1-bookmark"));
  });

  it("routes catalog reads through withSession", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db });

    const res = await call(env, "/testcfg/catalog/movie/top.json");
    assert.equal(res.status, 200);
    assert.equal(db._state.sessions, 1, "catalog read should use withSession");
    assert.equal(res.headers.get("x-d1-bookmark"), "bmk_1");
  });

  it("routes v2 install link reads through withSession", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db });
    const token = "A".repeat(43);

    const res = await call(env, `/i/${token}/manifest.json`);
    assert.equal(res.status, 200);
    assert.equal(db._state.sessions, 1, "v2 install read should use withSession");
    assert.equal(res.headers.get("x-d1-bookmark"), "bmk_1");
  });

  // The playback ping reads the account's tracking and writes it back: from a
  // replica that has not caught up, it would write old state over new (a
  // title just removed from Continue Watching coming back).
  it("keeps the playback ping (/subtitles/) on the primary", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db });
    await call(env, "/someconfig/subtitles/series/tt0944947:1:1.json");
    await call(env, "/i/sometoken/subtitles/movie/tt0137523.json");
    assert.equal(db._state.sessions || 0, 0);
  });

  // Its owner reads a list right after changing it and sends the ETag back.
  it("keeps /api/lists/:id reads on the primary", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db });
    await call(env, "/api/lists/abc123");
    await call(env, "/api/lists/abc123/items");
    assert.equal(db._state.sessions || 0, 0);
  });

  it("does not use read replica session on admin routes", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db });

    const res = await call(env, "/admin");
    assert.equal(res.status, 200);
    assert.equal(db._state.sessions, 0, "admin routes must not route to read replica session");
    assert.equal(res.headers.get("x-d1-bookmark"), null);
  });

  it("does not use read replica session on mutating API routes", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db });

    const res = await call(env, "/api/session", {
      method: "POST",
      json: { username: "nobody", key: "nokey" },
    });
    assert.equal(db._state.sessions, 0, "mutating session API must not route to read replica session");
    assert.equal(res.headers.get("x-d1-bookmark"), null);
  });

  it("routes /api/public-lists.json through withSession", async () => {
    const db = makeD1();
    const env = makeEnv({ DB: db });

    const res = await call(env, "/api/public-lists.json");
    assert.equal(res.status, 200);
    assert.equal(db._state.sessions, 1, "api public lists read should use withSession");
    assert.equal(res.headers.get("x-d1-bookmark"), "bmk_1");
  });

  it("gracefully falls back when env.DB.withSession is not supported", async () => {
    const db = makeD1();
    delete db.withSession;
    const env = makeEnv({ DB: db });

    const res = await call(env, "/manifest.json");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-d1-bookmark"), null);
  });
});
