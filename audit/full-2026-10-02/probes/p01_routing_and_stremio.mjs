// Automated verification probe for Module 02: Routing, API Contracts, and Stremio Protocol
// Reads target root from AUDIT_ROOT env var (default: cwd)
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env.AUDIT_ROOT || process.cwd();
const harnessPath = pathToFileURL(path.join(root, "tests", "harness.mjs")).href;
const { makeEnv, makeKv, makeD1, createUser, call } = await import(harnessPath);

console.log(`[PROBE] Running Module 02 API & Stremio Verification Probe against: ${root}`);

const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
const user = await createUser(env, "probe_m02");
const auth = { creatorName: "probe_m02", creatorKey: user.creatorKey };

// 1. Stremio Manifest & Protocol
{
  const r = await call(env, "/manifest.json");
  assert.equal(r.status, 200, "Manifest must return 200");
  assert.equal(r.headers.get("access-control-allow-origin"), "*", "Manifest must allow permissive CORS");
  assert.ok(r.body.id, "Manifest must contain addon ID");
  assert.ok(Array.isArray(r.body.resources), "Manifest must declare resources array");
  assert.ok(r.body.resources.some((res) => typeof res === "string" ? res === "catalog" : res.name === "catalog"), "Manifest must declare catalog");
  assert.ok(r.body.resources.some((res) => typeof res === "object" && res.name === "meta"), "Manifest must declare meta");
}

// 2. Stremio Catalogs & Error Resilience
{
  const r = await call(env, "/catalog/movie/non_existent_catalog.json");
  assert.equal(r.status, 200, "Unknown catalog must return 200 to prevent breaking Stremio UI");
  assert.deepEqual(r.body.metas, [], "Unknown catalog must return empty metas array");
  assert.equal(r.headers.get("access-control-allow-origin"), "*", "Catalog must allow permissive CORS");
}

// 3. Stremio Meta & Fallbacks
{
  const r = await call(env, "/meta/movie/tt999999999999.json");
  assert.equal(r.status, 200, "Unknown title meta must return 200");
  assert.equal(r.body.meta, null, "Unknown title meta must be null");
  assert.equal(r.headers.get("access-control-allow-origin"), "*", "Meta must allow permissive CORS");
}

// 4. Stremio Undeclared Resource (Stream)
{
  const r = await call(env, "/stream/movie/tt0111161.json");
  assert.equal(r.status, 404, "Undeclared stream resource must return 404");
}

// 5. Protected API Boundary & Invariant N10
{
  // POST protected creator endpoints
  const protectedPostRoutes = [
    "/api/creator/sync/load",
    "/api/creator/sync/save",
    "/api/creator/lists"
  ];
  for (const p of protectedPostRoutes) {
    // Unauthenticated request with invalid/empty body must 401
    const unauth = await call(env, p, { method: "POST", json: {} });
    assert.equal(unauth.status, 401, `${p} must reject unauthenticated call with 401`);

    // Authenticated response must be private, no-store
    const authResp = await call(env, p, { method: "POST", json: auth });
    const cc = (authResp.headers.get("cache-control") || "").toLowerCase();
    assert.match(cc, /no-store/, `${p} must return Cache-Control: private, no-store`);
  }

  // GET protected session endpoint /api/me
  const unauthMe = await call(env, "/api/me", { method: "GET" });
  assert.equal(unauthMe.status, 401, "/api/me must reject unauthenticated call with 401");
  const ccMe = (unauthMe.headers.get("cache-control") || "").toLowerCase();
  assert.match(ccMe, /no-store/, "/api/me must return Cache-Control: private, no-store");
}

// 6. Cross-Account Authorization Enforcement
{
  const attacker = await createUser(env, "attacker");
  const r = await call(env, "/api/creator/lists/save", {
    method: "POST",
    json: { creatorName: "probe_m02", creatorKey: attacker.creatorKey, name: "Stolen List", type: "movie", items: [] },
  });
  assert.equal(r.status, 401, "Cross-account list save must be rejected with 401");
}

console.log("[PROBE] ALL MODULE 02 VERIFICATION CHECKS PASSED DETERMINISTICALLY.");
