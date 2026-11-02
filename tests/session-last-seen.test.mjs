import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { call, createUser, freshIsolate, makeD1, makeEnv, makeKv } from "./harness.mjs";

// The last_seen_at refresh is a D1 write started while the request is being
// answered. It must be handed to ctx.waitUntil, or the runtime may cancel it
// once the response is returned, and every later request in that session would
// try the write again.

describe("session last_seen_at refresh", () => {
  it("is handed to ctx.waitUntil, so it finishes with the request", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const u = await createUser(env, "seenuser");
    const login = await call(env, "/api/session", { method: "POST", json: { username: u.creatorName, key: u.creatorKey } });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    await env.DB.prepare("UPDATE sessions SET last_seen_at = 0").run();

    // The refresh now takes a moment, like a real D1 round trip.
    let finished = false;
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (sql) => {
      const st = realPrepare(sql);
      if (!/UPDATE sessions SET last_seen_at/.test(sql)) return st;
      const realBind = st.bind.bind(st);
      st.bind = (...args) => {
        const bound = realBind(...args);
        const realRun = bound.run.bind(bound);
        bound.run = async () => {
          await new Promise((r) => setTimeout(r, 40));
          const out = await realRun();
          finished = true;
          return out;
        };
        return bound;
      };
      return st;
    };

    const registered = [];
    const ctx = { waitUntil: (p) => { registered.push(Promise.resolve(p).catch(() => {})); } };
    const w = await freshIsolate();
    const res = await w.fetch(new Request("https://example.test/api/me", {
      headers: { Cookie: cookie, Origin: "https://example.test", "CF-Connecting-IP": "10.9.8.7" },
    }), env, ctx);
    assert.equal(res.status, 200);
    await res.text();
    await Promise.all(registered); // what the runtime waits for after the response
    assert.equal(finished, true, "the write was not handed to waitUntil");
  });
});

// The admin session has the same refresh, but its lookup has no ctx (it sits
// under isAdminRequest, which 41 routes call with just request and env). The
// write is about once an hour for the one admin, so it is awaited instead:
// one short D1 round trip an hour, finished before the response goes out.
describe("admin session last_seen_at refresh", () => {
  it("finishes before the response is returned", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const login = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    await env.DB.prepare("UPDATE admin_sessions SET last_seen_at = 0").run();

    let finished = false;
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (sql) => {
      const st = realPrepare(sql);
      if (!/UPDATE admin_sessions SET last_seen_at/.test(sql)) return st;
      const realBind = st.bind.bind(st);
      st.bind = (...args) => {
        const bound = realBind(...args);
        const realRun = bound.run.bind(bound);
        bound.run = async () => {
          await new Promise((r) => setTimeout(r, 40));
          const out = await realRun();
          finished = true;
          return out;
        };
        return bound;
      };
      return st;
    };

    const ctx = { waitUntil: () => {} }; // nothing registered here is waited for
    const w = await freshIsolate();
    const res = await w.fetch(new Request("https://example.test/admin/api/admin-sessions", {
      headers: { Cookie: cookie, Origin: "https://example.test", "CF-Connecting-IP": "10.9.8.8" },
    }), env, ctx);
    assert.equal(res.status, 200);
    await res.text();
    assert.equal(finished, true, "the admin last_seen_at write was left running after the response");
  });
});
