// Audit SEC-01 and SEC-02. A username is public (it is in every creator page
// address), so it must not work as a password.
//
//   SEC-01  POST /api/nuvio-tv/history and /history/remove acted on whichever
//           account `targetId` named, by username or numeric id, with no secret.
//   SEC-02  /<username>/... was served as an install "verified" as that owner,
//           so anyone could read the private Watch History shelf and make the
//           playback ping record plays.
//
// Pairing a TV now hands it a secret of its own (an install link with the `tv`
// scope): the TV's manifest address and the id it sends are built on that.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeEnv, makeD1, makeKv, call, accountProof } from "./harness.mjs";

const HEADERS = { "x-nuvio-client": "NuvioTVLauncher", origin: "https://evil.example", "sec-fetch-site": "cross-site" };

async function pair(env, name, existing) {
  const proof = existing || await accountProof(env, name);
  const code = await call(env, "/api/nuvio-tv/device/code", { method: "POST" });
  const claim = await call(env, "/api/nuvio-tv/device/claim", { method: "POST", json: { userCode: code.body.userCode, creatorName: name, creatorKey: proof.creatorKey } });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const poll = await call(env, `/api/nuvio-tv/device/poll?deviceCode=${code.body.deviceCode}`);
  return { proof, claim: claim.body, poll: poll.body };
}
const tracked = async (env, name) => {
  const raw = await env.CONFIGS.get(`creatorsynctracking:${name}`);
  return raw ? JSON.parse(raw).watchHistory.map((x) => x.id) : [];
};
const history = (env, targetId, extra = {}, path = "/api/nuvio-tv/history") =>
  call(env, path, { method: "POST", headers: HEADERS, json: { targetId, type: "movie", contentId: "tt0133093", imdbId: "tt0133093", progress: 95, completed: true, watchedAt: 1730825000000, ...extra } });

describe("SEC-01: the TV history routes need the secret the TV was given", () => {
  it("pairing hands the TV a secret address, not the username", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), FF_INSTALLS: "1" });
    const { claim, poll } = await pair(env, "tvowner");
    assert.match(claim.installId, /^[A-Za-z0-9_-]{43}$/, "the id the TV keeps is a secret token");
    assert.notEqual(claim.installId, "tvowner");
    assert.equal(claim.manifestUrl, `https://example.test/i/${claim.installId}/tv/manifest.json`);
    assert.equal(claim.syncUrl, `https://example.test/api/nuvio-tv/sync/${claim.installId}`);
    assert.equal(poll.installId, claim.installId, "and the TV's poll returns the same");
    assert.ok(!JSON.stringify(claim).includes("tvowner/"), "the username is not in the addresses");
  });

  it("a stranger who knows only the username or numeric id can neither add nor remove history", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), FF_INSTALLS: "1" });
    await pair(env, "victimtv");
    const id = env.DB._db.prepare("SELECT id FROM accounts WHERE username = 'victimtv'").get().id;
    for (const target of ["victimtv", "VICTIMTV", String(id)]) {
      const add = await history(env, target);
      assert.ok([401, 403, 404].includes(add.status), `add by ${target} answered ${add.status}`);
      const rem = await history(env, target, {}, "/api/nuvio-tv/history/remove");
      assert.ok([401, 403, 404].includes(rem.status), `remove by ${target} answered ${rem.status}`);
    }
    assert.deepEqual(await tracked(env, "victimtv"), [], "nothing was written");
  });

  it("the paired TV, with its token, can add and remove", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), FF_INSTALLS: "1" });
    const { claim } = await pair(env, "pairedtv");
    const add = await history(env, claim.installId);
    assert.equal(add.status, 200, add.text);
    assert.deepEqual(await tracked(env, "pairedtv"), ["tt0133093"]);
    const rem = await history(env, claim.installId, {}, "/api/nuvio-tv/history/remove");
    assert.equal(rem.status, 200, rem.text);
    assert.deepEqual(await tracked(env, "pairedtv"), []);
  });

  it("an ordinary install link is not a TV secret", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), FF_INSTALLS: "1" });
    const proof = await accountProof(env, "plainlink");
    const login = await call(env, "/api/session", { method: "POST", json: { username: "plainlink", key: proof.creatorKey } });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    const made = await call(env, "/api/installs", { method: "POST", cookie, json: { track: true, entries: [{ id: "r1", name: "Popular", type: "movie", url: "tmdb:chart:popular" }] } });
    assert.equal(made.status, 201, made.text);
    const r = await history(env, made.body.token);
    assert.ok([401, 403, 404].includes(r.status), `answered ${r.status}`);
    assert.deepEqual(await tracked(env, "plainlink"), []);
  });

  it("removing the TV's install link stops it", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), FF_INSTALLS: "1" });
    const { claim } = await pair(env, "revokedtv");
    env.DB._db.exec("UPDATE installs SET revoked_at = 1");
    const r = await history(env, claim.installId);
    assert.ok([401, 403, 404].includes(r.status), `answered ${r.status}`);
  });
});

describe("SEC-02: a username link is not the owner; the TV's own link is", () => {
  async function withPrivateShelf(env, name) {
    const proof = await accountProof(env, name);
    const save = (path, extra) => call(env, path, { method: "POST", json: { creatorName: name, creatorKey: proof.creatorKey, ...extra } });
    const rows = [{ id: "watch-history", name: "Watch History", type: "movie", url: `autotrack:watch-history:movie:${name}` }];
    assert.equal((await save("/api/creator/sync/save", { config: rows })).body.ok, true);
    assert.equal((await save("/api/creator/sync/save-tracking", { watchHistory: [{ id: "tt0111161", type: "movie", name: "Private Movie Title", watchedAt: 1 }] })).body.ok, true);
    return proof;
  }
  const titles = (r) => (r.body && r.body.metas ? r.body.metas.map((m) => m.name) : []);

  it("the private Watch History shelf is not served to whoever types the username", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), FF_INSTALLS: "1" });
    await withPrivateShelf(env, "shelfowner");
    const r = await call(env, "/shelfowner/catalog/movie/watch-history.json", { ip: "198.51.100.9" });
    assert.ok(!titles(r).includes("Private Movie Title"), r.text);
  });

  it("the paired TV's own link serves it", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), FF_INSTALLS: "1" });
    const proof = await withPrivateShelf(env, "tvshelf");
    const { claim } = await pair(env, "tvshelf", proof);
    const m = await call(env, new URL(claim.manifestUrl).pathname);
    assert.equal(m.status, 200, m.text);
    assert.ok(m.body.catalogs.some((c) => c.id === "watch-history"), "the TV link carries the account's rows");
    const r = await call(env, `/i/${claim.installId}/tv/catalog/movie/watch-history.json`);
    assert.ok(titles(r).includes("Private Movie Title"), r.text);
  });

  it("a ping on the username link records nothing; on the TV's link it does", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), FF_INSTALLS: "1" });
    const proof = await withPrivateShelf(env, "pinged");
    const { claim } = await pair(env, "pinged", proof);
    const ping = (base) => call(env, `${base}/subtitles/movie/tt0068646.json`, { ip: "198.51.100.10" });
    await ping("/pinged");
    assert.ok(!(await tracked(env, "pinged")).includes("tt0068646"), "a username link cannot mark titles watched");
    await ping(`/i/${claim.installId}`);
    assert.ok((await tracked(env, "pinged")).includes("tt0068646"), "the TV's own link can");
  });

  it("the sync address of a paired TV answers with the TV's own manifest address", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), FF_INSTALLS: "1" });
    const { claim } = await pair(env, "syncer");
    const r = await call(env, new URL(claim.syncUrl).pathname);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.manifestUrl, claim.manifestUrl);
  });

  it("LEGACY_USERNAME_OWNER_LINKS=1 puts the old behaviour back", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), FF_INSTALLS: "1", LEGACY_USERNAME_OWNER_LINKS: "1" });
    await withPrivateShelf(env, "legacyowner");
    const r = await call(env, "/legacyowner/catalog/movie/watch-history.json", { ip: "198.51.100.11" });
    assert.ok(titles(r).includes("Private Movie Title"), r.text);
  });
});
