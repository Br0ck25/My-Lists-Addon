import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, makeD1, makeKv, call } from "./harness.mjs";

// A non-numeric limit or offset became NaN, which D1 refuses to bind, so the
// admin support-thread list answered 500 "datatype mismatch".

describe("admin support threads: bad paging values fall back to the defaults", () => {
  it("limit=abc&offset=abc answers 200", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const login = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
    const cookie = (login.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/)[1];
    for (const q of ["?limit=abc&offset=abc", "?limit=abc", "?offset=abc", "?limit=&offset="]) {
      const r = await call(env, "/admin/api/support-emails/threads" + q, { cookie });
      assert.equal(r.status, 200, q + " -> " + r.status + " " + String(r.text).slice(0, 80));
      assert.equal(r.body.ok, true);
    }
  });
});
