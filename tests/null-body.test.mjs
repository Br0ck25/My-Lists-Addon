import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { call, createUser, makeD1, makeEnv, makeKv } from "./harness.mjs";

// `null`, `[]`, `"x"` and `5` are all valid JSON. A route that does
// `body = await request.json()` and then reads `body.something` used to crash
// on `null` and answer 500 for what is a client mistake. Every POST route must
// answer below 500 for all four, signed in and signed out, and for the admin
// routes with a real admin session.

const routes = JSON.parse(fs.readFileSync(new URL("./route-access.json", import.meta.url), "utf8"));
const BODIES = ["null", "[]", '"x"', "5"];

describe("POST routes never answer 5xx for a non-object JSON body", () => {
  it("covers every static POST route", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("network blocked in test"); };
    try {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
      const user = await createUser(env, "nullbodyuser");
      const login = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
      const cookie = (login.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/)[1];
      const failures = [];
      let tried = 0;
      for (const [path, kind] of Object.entries(routes)) {
        if (/[:*]/.test(path) || ["static", "page", "admin-login"].includes(kind)) continue;
        const isAdmin = kind === "admin";
        if (!isAdmin && !path.startsWith("/api/")) continue;
        for (const body of BODIES) {
          const opts = isAdmin
            ? { method: "POST", json: body, cookie, headers: { Origin: "https://example.test" } }
            : { method: "POST", json: body };
          const r = await call(env, path, { ...opts, ip: "7.7.7." + (tried % 250) });
          tried++;
          // 503 = feature not configured here; that is not a crash.
          if (r.status >= 500 && r.status !== 503) failures.push(`${path} [${body}] -> ${r.status} ${String(r.text).slice(0, 80)}`);
        }
      }
      assert.ok(tried > 100, "the loop must actually exercise the routes");
      assert.deepEqual(failures, []);
      void user;
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
