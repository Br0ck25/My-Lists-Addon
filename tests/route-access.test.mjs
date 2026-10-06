// Route access inventory. Every route the Worker answers has to be listed in
// tests/route-access.json with who may call it. Adding a route without that
// entry fails here, so "does this need a login?" is decided on purpose, in a
// diff a reviewer can read, not by whoever wrote the handler.
//
// Classes (tests/route-access.json):
//   admin        needs an admin session; refused with 401/403 when anonymous
//   account      needs a signed-in account or its key; refused when anonymous
//   admin-login  the admin sign-in and sign-out endpoints themselves
//   integration  a provider callback or webhook, checked by its own secret
//   public       open to anyone (reads, validation, Stremio addon traffic)
//   page         the admin page shell, which shows the sign-in form
//   static       assets and manifests
//
// Admin routes check their login one by one (isAdminRequest, 03_admin.js), so a
// new one that forgets the check is the mistake this file exists to catch.
//
// Adding a route: add its line to route-access.json with the right class. If it
// is "admin" or "account" the test below calls it anonymously and expects it
// to be refused, with no further work.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// Nothing here may reach a real provider.
globalThis.fetch = async () => {
  throw new Error("network blocked in route-access test");
};

import { makeEnv, makeD1, makeKv, call } from "./harness.mjs";

const ROOT = new URL("../", import.meta.url);
const SOURCES = readdirSync(ROOT)
  .filter((f) => /^\d\d_.*\.js$/.test(f))
  .map((f) => readFileSync(new URL(f, ROOT), "utf8"))
  .join("\n");
const MANIFEST = JSON.parse(readFileSync(new URL("route-access.json", import.meta.url), "utf8"));

// Routes the Worker matches by prefix (a path with a dynamic part). Each is
// covered by its own suite; this list makes a NEW prefix a conscious decision.
const PREFIXES = {
  "/admin/": "admin pages and API: every /admin/api/* route is listed individually above",
  "/admin/api/activity-backfill/": "admin, tests/activity.test.mjs",
  "/admin/api/installs/": "admin, tests/admin-actions.test.mjs",
  "/admin/api/jobs/": "admin, tests/jobs.test.mjs",
  "/admin/api/lists-backfill/": "admin, tests/lists-v2.test.mjs",
  "/api/": "the API as a whole",
  "/api/connections/": "account, tests/security-suite.test.mjs",
  "/api/creator/": "account, listed individually above",
  "/api/imports/": "account, tests/imports.test.mjs",
  "/api/installs/": "account, tests/security-suite.test.mjs",
  "/api/likes/": "account, tests/lists-v2.test.mjs",
  "/api/lists/": "public reads, account writes, tests/lists-v2.test.mjs",
  "/api/me/": "account, tests/security-suite.test.mjs",
  "/api/poster/": "public images",
  "/api/safe-poster": "public images",
  "/api/scrobble": "token in the URL or body, tests/scrobble-queue.test.mjs",
};

const sourceRoutes = [...new Set([...SOURCES.matchAll(/(?:path|pathname|p)\s*===\s*"(\/[^"]*)"/g)].map((m) => m[1]))].sort();
const sourcePrefixes = [...new Set([...SOURCES.matchAll(/startsWith\("(\/(?:admin|api)[^"]*)"\)/g)].map((m) => m[1]))].sort();

describe("route access inventory", () => {
  it("every route in the source is listed in tests/route-access.json", () => {
    const missing = sourceRoutes.filter((r) => !(r in MANIFEST));
    assert.deepEqual(missing, [], "add each of these to tests/route-access.json with its class (see the top of this file)");
  });

  it("route-access.json lists no route that no longer exists", () => {
    const stale = Object.keys(MANIFEST).filter((r) => !sourceRoutes.includes(r));
    assert.deepEqual(stale, [], "remove these from tests/route-access.json");
  });

  it("every class is one of the known ones, and every /admin/api route is 'admin'", () => {
    const known = new Set(["admin", "account", "admin-login", "integration", "public", "page", "static"]);
    for (const [route, cls] of Object.entries(MANIFEST)) {
      assert.ok(known.has(cls), `${route} has unknown class ${cls}`);
      if (route.startsWith("/admin/api/")) assert.equal(cls, "admin", `${route} must be admin`);
    }
  });

  it("every route matched by prefix is known", () => {
    const unknown = sourcePrefixes.filter((p) => !(p in PREFIXES));
    assert.deepEqual(unknown, [], "a new prefix route needs a line in PREFIXES above and its own access tests");
  });
});

describe("route access: admin and account routes refuse anonymous callers", () => {
  const gated = Object.entries(MANIFEST).filter(([, cls]) => cls === "admin" || cls === "account");

  for (const [route, cls] of gated) {
    it(`${cls} ${route}`, async () => {
      const seen = [];
      for (const method of ["GET", "POST"]) {
        const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
        const res = await call(env, route, method === "POST" ? { method, json: {} } : { method });
        seen.push(res.status);
        assert.ok(
          [401, 403, 404, 405].includes(res.status),
          `${method} ${route} answered ${res.status} to an anonymous caller`
        );
      }
      assert.ok(
        seen.some((s) => s === 401 || s === 403),
        `${route} never answered 401/403 (got ${seen.join(", ")}): it may have no login check`
      );
    });
  }
});

describe("route access: nothing answers an anonymous empty request with a server error", () => {
  const open = Object.entries(MANIFEST).filter(([, cls]) => cls === "public" || cls === "integration");

  for (const [route, cls] of open) {
    it(`${cls} ${route}`, async () => {
      for (const method of ["GET", "POST"]) {
        const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
        const res = await call(env, route, method === "POST" ? { method, json: {} } : { method });
        // 503 is a provider that is not configured here (OAuth start routes).
        assert.ok(res.status < 500 || res.status === 503, `${method} ${route} answered ${res.status}`);
      }
    });
  }
});
