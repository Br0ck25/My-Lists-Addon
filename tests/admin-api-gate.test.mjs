// Audit TEST-04: the route-access scan reads source text, so a route written in a way it
// cannot see (path.endsWith(...), a lookup table keyed by the last segment) could skip
// isAdminRequest and answer a stranger. The gate does not look at how routes are
// written: any /admin/api/ path needs an admin identity before a route runs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeEnv, makeD1, makeKv, call } from "./harness.mjs";

const KEY = "gate-admin-secret";

async function adminCookie(env) {
  const res = await call(env, "/admin/login", { method: "POST", form: { key: KEY }, ip: "203.0.113.7" });
  assert.equal(res.status, 302);
  return (res.headers.get("set-cookie") || "").match(/^(mla_admin=[^;]+)/)[1];
}

describe("TEST-04: /admin/api/ answers 401 before any route runs", () => {
  it("a path no route knows answers a stranger 401, not 404", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), ADMIN_KEY: KEY });
    for (const path of ["/admin/api/zz-ends", "/admin/api/leak", "/admin/api/a/b/c"]) {
      for (const method of ["GET", "POST"]) {
        const r = await call(env, path, method === "POST" ? { method, json: {} } : { method });
        assert.equal(r.status, 401, `${method} ${path} answered ${r.status}`);
      }
    }
  });

  it("an admin is let through: the same unknown path is then a 404 from the router", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), ADMIN_KEY: KEY });
    const cookie = await adminCookie(env);
    const r = await call(env, "/admin/api/zz-ends", { cookie });
    assert.equal(r.status, 404, "the gate lets an admin through to the router");
  });

  it("a forged admin cookie does not pass the gate", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), ADMIN_KEY: KEY });
    const r = await call(env, "/admin/api/zz-ends", { cookie: "mla_admin=9999999999999.forged" });
    assert.equal(r.status, 401);
  });

  it("each admin request still leaves exactly one audit row (the gate does not log)", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), ADMIN_KEY: KEY });
    const cookie = await adminCookie(env);
    const before = env.DB._db.prepare("SELECT count(*) AS n FROM admin_audit_log").get().n;
    const r = await call(env, "/admin/api/site-notice", { method: "POST", cookie, json: { enabled: false } });
    assert.equal(r.status, 200, r.text);
    const after = env.DB._db.prepare("SELECT count(*) AS n FROM admin_audit_log").get().n;
    assert.equal(after - before, 1);
  });
});
