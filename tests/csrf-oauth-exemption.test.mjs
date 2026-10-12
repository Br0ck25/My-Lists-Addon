// verifyCsrf exempts the OAuth start/callback routes. The exemption was
// `path.includes("/oauth/")`, so any path with those characters anywhere skipped
// the same-origin and application/json checks, including ones that reach real
// handlers through a trailing id segment (/api/connections/x/oauth/x,
// /api/imports/x/oauth/x, /admin/api/jobs/x/oauth/x). Today those handlers
// still ask for a sign-in, but the CSRF check is the layer meant to stand in
// front of them. The exemption is now the eight real routes and nothing else.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { call, makeD1, makeEnv, makeKv } from "./harness.mjs";

const ROOT = new URL("../", import.meta.url);
const CROSS = { Origin: "https://evil.example", "Content-Type": "text/plain" };
const refusedAsCrossOrigin = (r) => r.status === 403 && /cross-origin/i.test(JSON.stringify(r.body));

const REAL = [];
for (const provider of ["trakt", "mdblist", "simkl", "tmdb"]) {
  for (const leg of ["start", "callback"]) REAL.push(`/api/${provider}/oauth/${leg}`);
}

describe("the CSRF exemption for OAuth routes", () => {
  for (const path of REAL) {
    it(path + " is still exempt (the provider, not our page, calls it)", async () => {
      const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
      const r = await call(env, path, { method: "POST", headers: CROSS });
      assert.equal(refusedAsCrossOrigin(r), false, "not refused by the CSRF check: " + r.status);
    });
  }

  it("the exempt routes are exactly the OAuth routes in the route manifest", () => {
    const manifest = JSON.parse(readFileSync(new URL("tests/route-access.json", ROOT), "utf8"));
    assert.deepEqual(Object.keys(manifest).filter((p) => p.includes("/oauth/")).sort(), [...REAL].sort());
  });

  for (const path of [
    "/api/connections/x/oauth/x",
    "/api/connections/import-local/x/oauth/x",
    "/api/imports/x/oauth/x",
    "/admin/api/jobs/x/oauth/x",
    "/admin/api/installs/x/oauth/x",
    "/api/trakt/oauth/callback/extra",
    "/api/other/oauth/callback",
    "/x/api/trakt/oauth/callback",
  ]) {
    for (const method of ["POST", "DELETE"]) {
      it(method + " " + path + " is a cross-origin request like any other", async () => {
        const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
        const r = await call(env, path, { method, headers: CROSS });
        assert.equal(refusedAsCrossOrigin(r), true, "got " + r.status + " " + JSON.stringify(r.body));
      });
    }
  }
});
