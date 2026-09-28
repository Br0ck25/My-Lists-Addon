// P5-7: token.refresh renews connections expiring within a week; one the
// provider refuses becomes reauth_required, and then shows a "Reconnect" tile
// in Stremio and a banner on the website. Through the real Worker and queue,
// with Trakt faked (the same fake as P3a-10 in worker.test.mjs).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeEnv, makeD1, makeQueue, drainQueue, call, createUser, runScheduledTick } from "./harness.mjs";

const TEST_KEY = "k1:" + Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => 90 + i)).toString("base64");
const SITE = { TOKEN_ENCRYPTION_KEY: TEST_KEY, TRAKT_CLIENT_ID: "site-trakt-id", TRAKT_CLIENT_SECRET: "site-trakt-secret", FF_INSTALLS: "1" };
const DAY = 86400000;
const nowSec = () => Math.floor(Date.now() / 1000);

function stubTrakt(state) {
  const seen = { watchlistTokens: [], refreshes: [] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, init = {}) => {
    const href = typeof u === "string" ? u : u.url;
    const headers = new Headers(init.headers || {});
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (href === "https://api.trakt.tv/oauth/token") {
      const body = JSON.parse(init.body || "{}");
      if (body.grant_type === "refresh_token") {
        seen.refreshes.push(body);
        return state.refresh ? state.refresh(body) : json({ error: "invalid_grant" }, 400);
      }
      return json(state.issue);
    }
    if (href === "https://api.trakt.tv/users/me") return json({ username: "traktfan" });
    if (href.startsWith("https://api.trakt.tv/users/me/watchlist")) {
      seen.watchlistTokens.push((headers.get("authorization") || "").replace(/^Bearer /, ""));
      return json([{ type: "movie", movie: { title: "Heat", year: 1995, ids: { imdb: "tt0113277", tmdb: 949 } } }]);
    }
    return json({});
  };
  seen.restore = () => { globalThis.fetch = realFetch; };
  return seen;
}

// Account ids restart at 1 in every database, while the Worker remembers each
// account's connections for a minute: each test gets ids no other one uses.
let idBase = 7000;
async function setup(name) {
  const env = makeEnv({ DB: makeD1(), JOBS: makeQueue(), ...SITE });
  idBase += 1000;
  await env.DB.prepare("INSERT INTO accounts (id, username, display_name, key_hash, created_at) VALUES (?, ?, 'placeholder', 'x', 1)").bind(idBase, "placeholder" + idBase).run();
  const u = await createUser(env, name);
  const r = await call(env, "/api/session", { method: "POST", json: { username: name, key: u.creatorKey } });
  const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  return { env, cookie };
}

async function connectTrakt(env, cookie) {
  const st = "st" + Math.random().toString(36).slice(2, 8);
  const r = await call(env, `/api/trakt/oauth/callback?code=C&state=${st}`, { cookie: `${cookie}; mla_trakt_state=${st}` });
  assert.equal(r.headers.get("location"), "https://example.test/?connected=trakt");
}

const watchlistRow = { id: "tw", name: "Watchlist", type: "movie", url: "trakt:watchlist" };

async function tokenRefreshTick(env) {
  await runScheduledTick(env);
  env.DB._db.exec("UPDATE jobs SET run_after = 9999999999999 WHERE dedupe_key LIKE 'periodic:%' AND dedupe_key != 'periodic:token.refresh'");
  env.DB._db.exec("UPDATE jobs SET run_after = 1 WHERE dedupe_key = 'periodic:token.refresh'");
  env.JOBS._pending.length = 0;
  await runScheduledTick(env);
  env.JOBS._pending.splice(0, env.JOBS._pending.length, ...env.JOBS._pending.filter((m) => m.body.type === "token.refresh"));
  await drainQueue(env);
}

const conn = (env) => env.DB._db.prepare("SELECT status, expires_at, last_error FROM provider_connections WHERE provider = 'trakt'").get();

describe("P5-7: token.refresh", () => {
  it("renews a token that expires within a week, before anyone needs it", async () => {
    const trakt = stubTrakt({
      issue: { access_token: "OLD", refresh_token: "R1", expires_in: 3 * 86400, created_at: nowSec() },
      refresh: () => new Response(JSON.stringify({ access_token: "NEW", refresh_token: "R2", expires_in: 90 * 86400, created_at: nowSec() }), { status: 200 }),
    });
    try {
      const { env, cookie } = await setup("tr1");
      await connectTrakt(env, cookie);
      await tokenRefreshTick(env);
      assert.equal(trakt.refreshes.length, 1);
      assert.equal(trakt.refreshes[0].refresh_token, "R1");
      const row = conn(env);
      assert.equal(row.status, "ok");
      assert.ok(row.expires_at > Date.now() + 80 * DAY);
      const created = await call(env, "/api/installs", { method: "POST", cookie, json: { entries: [watchlistRow] } });
      await call(env, `/i/${created.body.token}/catalog/movie/tw.json`);
      assert.deepEqual(trakt.watchlistTokens, ["NEW"]);
    } finally {
      trakt.restore();
    }
  });

  it("leaves tokens that are not close to expiring, and ones the provider could not be asked about", async () => {
    const trakt = stubTrakt({
      issue: { access_token: "T", refresh_token: "R1", expires_in: 30 * 86400, created_at: nowSec() },
      refresh: () => new Response("busy", { status: 503 }),
    });
    try {
      const { env, cookie } = await setup("tr2");
      await connectTrakt(env, cookie);
      await tokenRefreshTick(env);
      assert.equal(trakt.refreshes.length, 0, "30 days left: not yet");
      env.DB._db.prepare("UPDATE provider_connections SET expires_at = ?").run(Date.now() + 2 * DAY);
      await tokenRefreshTick(env);
      assert.equal(trakt.refreshes.length > 0, true);
      assert.equal(conn(env).status, "ok", "an unanswered refresh is tried again tomorrow, not treated as refused");
    } finally {
      trakt.restore();
    }
  });

  it("a refused renewal asks to reconnect: a Stremio tile, a website banner, and connecting again clears it", async () => {
    const trakt = stubTrakt({ issue: { access_token: "OLD", refresh_token: "R1", expires_in: 3 * 86400, created_at: nowSec() } });
    try {
      const { env, cookie } = await setup("tr3");
      await connectTrakt(env, cookie);
      const created = await call(env, "/api/installs", { method: "POST", cookie, json: { entries: [watchlistRow] } });
      await tokenRefreshTick(env);
      const row = conn(env);
      assert.equal(row.status, "reauth_required");
      assert.match(row.last_error, /Connect it again/);

      const tile = await call(env, `/i/${created.body.token}/catalog/movie/tw.json`);
      assert.equal(tile.status, 200);
      assert.equal(tile.body.metas.length, 1);
      assert.equal(tile.body.metas[0].name, "Reconnect Trakt at mylistsaddon.com");
      assert.equal(tile.body.metas[0].poster, "https://example.test/reconnect-poster.svg?provider=trakt");
      assert.deepEqual(trakt.watchlistTokens, [], "the refused token is not used");
      const more = await call(env, `/i/${created.body.token}/catalog/movie/tw/skip=100.json`);
      assert.deepEqual(more.body.metas, []);
      const poster = await call(env, "/reconnect-poster.svg?provider=trakt");
      assert.equal(poster.headers.get("content-type"), "image/svg+xml");
      assert.match(poster.text, /Reconnect/);
      assert.match(poster.text, /Trakt/);

      const list = await call(env, "/api/connections", { cookie });
      assert.deepEqual(list.body.connections.map((c) => [c.provider, c.status]), [["trakt", "reauth_required"]]);

      // Connecting again.
      await connectTrakt(env, cookie);
      assert.equal(conn(env).status, "ok");
      const back = await call(env, `/i/${created.body.token}/catalog/movie/tw.json`);
      assert.equal(back.body.metas[0].id, "tt0113277");
    } finally {
      trakt.restore();
    }
  });

  it("the page shows a banner for a connection that needs reconnecting", () => {
    // The page asks once per load (warnAboutLapsedConnections, 17_), after
    // picking up a fresh connection.
    const fs = globalThis.process.getBuiltinModule("node:fs");
    const src = fs.readFileSync(new URL("../17_client-my-lists-and-trakt-oauth.js", import.meta.url), "utf8");
    assert.match(src, /async function warnAboutLapsedConnections\(\)/);
    assert.match(src, /c\.status !== 'ok'/);
    const boot = fs.readFileSync(new URL("../24_client-backup-restore-presets.js", import.meta.url), "utf8");
    assert.match(boot, /warnAboutLapsedConnections\(\);/);
  });
});
