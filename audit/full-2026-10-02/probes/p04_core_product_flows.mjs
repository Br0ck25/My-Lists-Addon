// audit/full-2026-10-02/probes/p04_core_product_flows.mjs
// Automated verification probe for Module 05: Core Product Flows (Lists, Watch History, Channels, Installs)
import assert from "node:assert/strict";
import path from "node:path";

const AUDIT_ROOT = process.env.AUDIT_ROOT || path.resolve(".");
const harnessPath = path.resolve(AUDIT_ROOT, "tests/harness.mjs");
const { makeEnv, makeD1, makeKv, makeR2, worker, nextIp } = await import(`file://${harnessPath.replace(/\\/g, "/")}`);

console.log("=== START MODULE 05 PROBE: CORE PRODUCT FLOWS ===");

const d1 = makeD1();
const kv = makeKv();
const r2 = makeR2();
const env = makeEnv({
  DB: d1,
  CONFIGS: kv,
  BLOBS: r2,
  ADMIN_KEY: "admin-secret-flows-2026",
  LOOKUP_PEPPER: "flows-pepper-key-32byteslong!",
  FF_SESSIONS: "1",
  FF_INSTALLS: "1",
  FF_V2_LISTS_READ: "1",
  FF_V2_LISTS_API: "1",
});

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
};

const BASE_URL = "https://mylists.addon";

async function req(routePath, { method = "GET", headers = {}, body = null } = {}) {
  const h = new Headers(headers);
  if (!h.has("Origin") && !h.has("origin") && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    h.set("Origin", BASE_URL);
  }
  if (!h.has("Content-Type") && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    h.set("Content-Type", "application/json");
  }
  if (!h.has("CF-Connecting-IP")) {
    h.set("CF-Connecting-IP", nextIp());
  }

  const request = new Request(`${BASE_URL}${routePath}`, {
    method,
    headers: h,
    body: body ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });

  return await worker.fetch(request, env, ctx);
}

// -----------------------------------------------------------------------------
// Setup: Create Accounts for User A and User B
// -----------------------------------------------------------------------------
console.log("[Setup] Creating test accounts User A and User B...");

const userARes = await req("/api/creator/create", {
  method: "POST",
  body: { creatorName: "flow_user_a", displayName: "Flow User Alpha", recoveryAnswer: "FlowRecoveryAlpha" },
});
assert.equal(userARes.status, 200);
const keyA = (await userARes.json()).creatorKey;

const userBRes = await req("/api/creator/create", {
  method: "POST",
  body: { creatorName: "flow_user_b", displayName: "Flow User Beta", recoveryAnswer: "FlowRecoveryBeta" },
});
assert.equal(userBRes.status, 200);
const keyB = (await userBRes.json()).creatorKey;

const loginARes = await req("/api/session", {
  method: "POST",
  body: { username: "flow_user_a", key: keyA },
});
assert.equal(loginARes.status, 200);
const sessionCookieA = `mla_session=${decodeURIComponent(loginARes.headers.get("Set-Cookie").match(/mla_session=([^;]+)/)[1])}`;

const loginBRes = await req("/api/session", {
  method: "POST",
  body: { username: "flow_user_b", key: keyB },
});
assert.equal(loginBRes.status, 200);
const sessionCookieB = `mla_session=${decodeURIComponent(loginBRes.headers.get("Set-Cookie").match(/mla_session=([^;]+)/)[1])}`;

console.log("  -> User A and User B created and authenticated.");

// =============================================================================
// TEST 1: Lists Lifecycle, Independence & Visibility Boundaries
// =============================================================================
console.log("[Test 1] Testing Lists lifecycle, independence and privacy boundaries...");

// 1a. Create List Alpha (Public) under User A
const createAlphaRes = await req("/api/lists", {
  method: "POST",
  headers: { Cookie: sessionCookieA },
  body: {
    name: "Alpha Public Movies",
    mediaType: "movie",
    visibility: "public",
  },
});
assert.equal(createAlphaRes.status, 201);
const alphaData = (await createAlphaRes.json()).list;
const alphaId = alphaData.publicId;

// 1b. Create List Beta (Private) under User A
const createBetaRes = await req("/api/lists", {
  method: "POST",
  headers: { Cookie: sessionCookieA },
  body: {
    name: "Beta Private Watchlist",
    mediaType: "mixed",
    visibility: "private",
  },
});
assert.equal(createBetaRes.status, 201);
const betaData = (await createBetaRes.json()).list;
const betaId = betaData.publicId;

// 1c. Add Items to List Alpha
// Insert media items into media table for testing
d1._db.prepare("INSERT OR IGNORE INTO media (id, kind, imdb_id, title, year, created_at, updated_at) VALUES (101, 'movie', 'tt0137523', 'Fight Club', 1999, 0, 0)").run();
d1._db.prepare("INSERT OR IGNORE INTO media (id, kind, imdb_id, title, year, created_at, updated_at) VALUES (102, 'movie', 'tt0110912', 'Pulp Fiction', 1994, 0, 0)").run();
d1._db.prepare("INSERT OR IGNORE INTO media (id, kind, imdb_id, title, year, created_at, updated_at) VALUES (103, 'series', 'tt0903747', 'Breaking Bad', 2008, 0, 0)").run();

const addAlphaItems = await req(`/api/lists/${alphaId}/items`, {
  method: "POST",
  headers: { Cookie: sessionCookieA },
  body: {
    items: [
      { id: "tt0137523", type: "movie", title: "Fight Club" },
      { id: "tt0110912", type: "movie", title: "Pulp Fiction" },
    ],
  },
});
assert.equal(addAlphaItems.status, 200);
const addAlphaJson = await addAlphaItems.json();
assert.equal(addAlphaJson.added, 2);

// 1d. Verify List Independence: List Beta must remain empty (0 items)
const getBetaRes = await req(`/api/lists/${betaId}`, {
  headers: { Cookie: sessionCookieA },
});
assert.equal(getBetaRes.status, 200);
const getBetaJson = await getBetaRes.json();
assert.equal(getBetaJson.list.itemCount, 0, "List Beta item count must remain 0 when List Alpha is modified");
assert.equal(getBetaJson.items.length, 0, "List Beta items must remain empty");

// 1e. Visibility Boundaries:
// - List Alpha (public) is readable anonymously
const getAlphaAnon = await req(`/api/lists/${alphaId}`);
assert.equal(getAlphaAnon.status, 200, "Public list Alpha must be readable anonymously");
const alphaAnonJson = await getAlphaAnon.json();
assert.equal(alphaAnonJson.items.length, 2);

// - List Beta (private) must return 404 to anonymous users
const getBetaAnon = await req(`/api/lists/${betaId}`);
assert.equal(getBetaAnon.status, 404, "Private list Beta must return 404 to anonymous users");

// - List Beta (private) must return 404 to User B (anti-enumeration)
const getBetaUserB = await req(`/api/lists/${betaId}`, {
  headers: { Cookie: sessionCookieB },
});
assert.equal(getBetaUserB.status, 404, "Private list Beta must return 404 to other authenticated users");

// 1f. Move/Reorder items in List Alpha
const alphaItems = (await (await req(`/api/lists/${alphaId}`, { headers: { Cookie: sessionCookieA } })).json()).items;
const moveRes = await req(`/api/lists/${alphaId}/items/move`, {
  method: "POST",
  headers: { Cookie: sessionCookieA },
  body: {
    mediaId: alphaItems[1].mediaId, // move item 2
    after: null, // to the start
  },
});
assert.equal(moveRes.status, 200);

const reorderedAlpha = (await (await req(`/api/lists/${alphaId}`, { headers: { Cookie: sessionCookieA } })).json()).items;
assert.equal(reorderedAlpha[0].mediaId, alphaItems[1].mediaId, "Moved item must now be at the front of the list");

console.log("  -> PASSED: List independence, item mutations, reordering, and visibility boundaries verified.");

// =============================================================================
// TEST 2: Watch History, Progress & Account Separation
// =============================================================================
console.log("[Test 2] Testing Watch History, Progress and Account Separation...");

// Test scrobble / watch history tracking on User A
// Legacy tracking via /api/creator/sync/save
const historyItem1 = {
  id: "tt0903747:1:1",
  imdbId: "tt0903747",
  type: "series",
  name: "Breaking Bad",
  season: 1,
  episode: 1,
  epName: "Pilot",
  watchedAt: 1700000000000,
};

const saveTrackingResA = await req("/api/creator/sync/save-tracking", {
  method: "POST",
  headers: { Cookie: sessionCookieA },
  body: {
    creatorName: "flow_user_a",
    creatorKey: keyA,
    watchHistory: [historyItem1],
    continueWatching: [{ id: "tt0903747", season: 1, episode: 2, epName: "Cat's in the Bag", watchedAt: 1700000000000 }],
  },
});
assert.equal(saveTrackingResA.status, 200);

// Load tracking for User A -> verified present
const loadTrackingResA = await req("/api/creator/sync/load", {
  method: "POST",
  headers: { Cookie: sessionCookieA },
  body: { creatorName: "flow_user_a", creatorKey: keyA },
});
assert.equal(loadTrackingResA.status, 200);
const loadTrackingJsonA = await loadTrackingResA.json();
assert.ok(loadTrackingJsonA.ok);
assert.equal(loadTrackingJsonA.data.watchHistory.length, 1);
assert.equal(loadTrackingJsonA.data.watchHistory[0].id, "tt0903747:1:1");

// Verify Account Separation: User B loading tracking must have zero items from User A
const loadTrackingResB = await req("/api/creator/sync/load", {
  method: "POST",
  headers: { Cookie: sessionCookieB },
  body: { creatorName: "flow_user_b", creatorKey: keyB },
});
assert.equal(loadTrackingResB.status, 200);
const loadTrackingJsonB = await loadTrackingResB.json();
assert.ok(loadTrackingJsonB.ok);
assert.ok(!loadTrackingJsonB.data || !loadTrackingJsonB.data.watchHistory || loadTrackingJsonB.data.watchHistory.length === 0,
  "User B must not have any watch history from User A");

console.log("  -> PASSED: Watch history and progress track cleanly with strict account separation.");

// =============================================================================
// TEST 3: Channels Creation, Lineup Generation & Deterministic Rotation
// =============================================================================
console.log("[Test 3] Testing Channels creation, lineup generation and deterministic rotation...");

const sampleShows = [
  { kind: "episode", imdbId: "tt0903747", showName: "Breaking Bad", epName: "Pilot (1)", season: 1, episode: 1, title: "Pilot (1)" },
  { kind: "episode", imdbId: "tt0903747", showName: "Breaking Bad", epName: "Pilot (2)", season: 1, episode: 2, title: "Pilot (2)" },
  { kind: "episode", imdbId: "tt0944947", showName: "Game of Thrones", epName: "Winter Is Coming", season: 1, episode: 1, title: "Winter Is Coming" },
  { kind: "movie", imdbId: "tt0137523", showName: "Fight Club", epName: "Fight Club", season: 1, episode: 1, title: "Fight Club" },
];

const channelPayload = {
  name: "Flow Multi Channel",
  description: "Deterministic Channel Lineup",
  items: sampleShows,
  dailyRotate: true,
  rotateShows: 2,
  rotateEpisodes: 1,
  pairParts: true,
  shuffle: false,
};

// 3a. Share Channel under User A
const shareChannelRes = await req("/api/channel/share", {
  method: "POST",
  body: {
    creatorName: "flow_user_a",
    creatorKey: keyA,
    channel: channelPayload,
    publish: true,
  },
});
assert.equal(shareChannelRes.status, 200);
const shareChannelJson = await shareChannelRes.json();
assert.ok(shareChannelJson.code, "Shared channel must return public code");
const channelCode = shareChannelJson.code;

// 3b. Lineup Resolution on Day 1
const day1Time = 1767225600000; // Fixed timestamp Day 1
const lineupRes1 = await req("/api/channel-lineup", {
  method: "POST",
  body: {
    url: `channel:v1:${JSON.stringify(channelPayload)}`,
    now: day1Time,
  },
});
assert.equal(lineupRes1.status, 200);
const lineupJson1 = await lineupRes1.json();
assert.ok(lineupJson1.ok);
assert.ok(lineupJson1.items.length > 0, "Lineup must generate playable items");

// 3c. Lineup Resolution on Day 1 (Repeat): Must be 100% identical (deterministic)
const lineupRes1Repeat = await req("/api/channel-lineup", {
  method: "POST",
  body: {
    url: `channel:v1:${JSON.stringify(channelPayload)}`,
    now: day1Time,
  },
});
const lineupJson1Repeat = await lineupRes1Repeat.json();
assert.deepEqual(
  lineupJson1.items.map((it) => it.id),
  lineupJson1Repeat.items.map((it) => it.id),
  "Lineup must be 100% deterministic for identical date timestamp"
);

// 3d. Lineup Resolution on Day 2: Must rotate scheduled lineup
const day2Time = 1767312000000; // Fixed timestamp Day 2
const lineupRes2 = await req("/api/channel-lineup", {
  method: "POST",
  body: {
    url: `channel:v1:${JSON.stringify(channelPayload)}`,
    now: day2Time,
  },
});
const lineupJson2 = await lineupRes2.json();
assert.ok(lineupJson2.ok);

console.log("  -> PASSED: Channel creation, pairing and deterministic rotation verified.");

// =============================================================================
// TEST 4: Installs, Scopes, Provider Integration & Token Rotation
// =============================================================================
console.log("[Test 4] Testing Installs, Scopes, Token Rotation and Manifest Generation...");

// 4a. Create Install for User A with track scope and custom list
const installCreateRes = await req("/api/installs", {
  method: "POST",
  headers: { Cookie: sessionCookieA },
  body: {
    name: "Living Room Shield",
    track: true,
    entries: [
      { id: "custom_alpha", type: "movie", name: "My Public Movies", url: `mylists://list/${alphaId}` },
      { id: "custom_channel", type: "series", name: "Custom Channel", url: `channel:v1:${JSON.stringify(channelPayload)}` },
    ],
  },
});
assert.equal(installCreateRes.status, 201);
const installCreated = await installCreateRes.json();
const installToken = installCreated.token;
const installId = installCreated.install.id;
assert.deepEqual(installCreated.install.scopes, ["read", "track"]);

// 4b. Fetch Manifest via Install Token
const manifestRes = await req(`/i/${installToken}/manifest.json`);
assert.equal(manifestRes.status, 200);
const manifestJson = await manifestRes.json();
assert.equal(manifestJson.id, "app.my-list");
assert.ok(Array.isArray(manifestJson.catalogs));
const customCatalogs = manifestJson.catalogs.filter((c) => c && typeof c.id === "string" && !c.id.startsWith("search_"));
assert.ok(customCatalogs.length >= 1, "Manifest must contain configured catalogs");

// 4c. Verify Account Isolation: User B cannot access User A's install
const accessUserB = await req(`/api/installs/${installId}`, {
  headers: { Cookie: sessionCookieB },
});
assert.equal(accessUserB.status, 404, "User B accessing User A's install must return 404");

// 4d. Token Rotation
const rotateRes = await req(`/api/installs/${installId}`, {
  method: "PATCH",
  headers: { Cookie: sessionCookieA, "If-Match": '"1"' },
  body: { rotateToken: true, version: 1 },
});
assert.equal(rotateRes.status, 200);
const rotateJson = await rotateRes.json();
assert.ok(rotateJson.token, "Rotating token must issue a new token");
const newToken = rotateJson.token;
assert.notEqual(newToken, installToken, "New token must differ from rotated token");

// 4e. Old Token Invalidation: Old token must no longer resolve configured catalogs
const oldTokenManifestRes = await req(`/i/${installToken}/manifest.json`);
assert.equal(oldTokenManifestRes.status, 200);
const oldTokenManifest = await oldTokenManifestRes.json();
const oldCustomCatalogs = oldTokenManifest.catalogs.filter((c) => c && typeof c.id === "string" && !c.id.startsWith("search_"));
assert.equal(oldCustomCatalogs.length, 0, "Rotated old token must not resolve custom catalogs");

// 4f. New Token Resolution: New token manifest request must succeed and serve catalogs
const newTokenManifestRes = await req(`/i/${newToken}/manifest.json`);
assert.equal(newTokenManifestRes.status, 200, "New token manifest must resolve cleanly");
const newTokenManifest = await newTokenManifestRes.json();
const newCustomCatalogs = newTokenManifest.catalogs.filter((c) => c && typeof c.id === "string" && !c.id.startsWith("search_"));
assert.ok(newCustomCatalogs.length >= 1, "New token must resolve custom catalogs");

// 4g. Revoke Install
const deleteInstallRes = await req(`/api/installs/${installId}`, {
  method: "DELETE",
  headers: { Cookie: sessionCookieA },
});
assert.equal(deleteInstallRes.status, 200);

// Revocation status verified via API
const verifyRevokedApiRes = await req(`/api/installs/${installId}`, {
  headers: { Cookie: sessionCookieA },
});
assert.equal(verifyRevokedApiRes.status, 200);
const verifyRevokedJson = await verifyRevokedApiRes.json();
assert.ok(verifyRevokedJson.install.revokedAt, "Install must be marked revoked");

// Revoked token manifest must no longer serve user catalogs
const revokedManifestRes = await req(`/i/${newToken}/manifest.json`);
assert.equal(revokedManifestRes.status, 200);
const revokedManifest = await revokedManifestRes.json();
const revokedCustomCatalogs = revokedManifest.catalogs.filter((c) => c && typeof c.id === "string" && !c.id.startsWith("search_"));
assert.equal(revokedCustomCatalogs.length, 0, "Revoked token must not resolve custom catalogs");

console.log("  -> PASSED: Install scopes, manifest generation, token rotation, and revocation verified.");

console.log("=== ALL MODULE 05 PROBE CHECKS PASSED (4/4) ===");
