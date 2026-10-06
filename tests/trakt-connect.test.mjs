import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { call, makeEnv, freshIsolate } from "./harness.mjs";
import { loadClient, requestsTo } from "./client-harness.mjs";

// Connect Trakt with a PIN / code (2026-10-06). The live site showed "Trakt is
// busy (rate limit)" every time: the Worker asked Trakt for the code from the
// site's own address, which every catalog the site loads from Trakt shares, and
// Trakt was limiting it. The page now asks Trakt from the visitor's browser
// first, the Worker route is the fallback, and a refusal says what Trakt said.

const CODE = { user_code: "WXYZ1234", device_code: "dev-1", verification_url: "https://trakt.tv/activate", interval: 5, expires_in: 600 };

function traktClient(routes) {
  const client = loadClient({ signedIn: true, routes: Object.assign({
    "/api/trakt/device/token": () => ({ json: { ok: false, pending: true } }),
  }, routes) });
  // The person's own Trakt app id, the way the page reads it; on the live page
  // TRAKT_PUBLIC_CLIENT_ID (the site's) is used when there is none.
  client.document.getElementById("traktKeyInput").value = "cid-own";
  return client;
}

describe("Connect Trakt with a code: asked from the browser first", () => {
  it("gets the code from Trakt directly and never asks the Worker", async () => {
    const client = traktClient({
      "/oauth/device/code": () => ({ json: CODE }),
    });
    await client.call("startTraktDeviceLogin");
    const direct = requestsTo(client, "/oauth/device/code");
    assert.equal(direct.length, 1);
    assert.match(direct[0].url, /^https:\/\/api\.trakt\.tv\/oauth\/device\/code$/);
    assert.equal(direct[0].method, "POST");
    assert.equal(direct[0].headers["trakt-api-key"], "cid-own");
    assert.deepEqual(direct[0].body, { client_id: "cid-own" }, "the app id only: no secret leaves the server");
    assert.equal(requestsTo(client, "/api/trakt/device/code").length, 0);
    assert.equal(client.document.getElementById("traktDeviceUserCode").innerText, "WXYZ1234");
  });

  it("falls back to the Worker when Trakt refuses the browser", async () => {
    const client = traktClient({
      "/oauth/device/code": () => ({ status: 429, json: {} }),
      "/api/trakt/device/code": () => ({ json: Object.assign({ ok: true }, CODE) }),
    });
    await client.call("startTraktDeviceLogin");
    assert.equal(requestsTo(client, "/api/trakt/device/code").length, 1);
    assert.equal(client.document.getElementById("traktDeviceUserCode").innerText, "WXYZ1234");
  });

  it("says a long wait instead of retrying too early", async () => {
    const client = traktClient({
      "/oauth/device/code": () => ({ status: 429, json: {} }),
      "/api/trakt/device/code": () => ({ status: 429, json: { ok: false, error: "Trakt is limiting requests from this site right now (wait about 5 minutes). Please try again later.", retryAfter: 300 } }),
    });
    const timers = [];
    client.set("setTimeout", (fn, ms) => { timers.push({ fn, ms }); return timers.length; });
    await client.call("startTraktDeviceLogin");
    assert.equal(timers.length, 0, "no retry 30 seconds into a 5-minute wait");
    assert.match(client.document.getElementById("traktDevicePollingStatus").innerHTML, /about 5 minutes/);
  });

  it("says why an approval is slow to show when Trakt slows the Worker's checks", async () => {
    const client = traktClient({
      "/oauth/device/code": () => ({ json: CODE }),
      "/api/trakt/device/token": () => ({ json: { ok: false, slowDown: true, error: "Slow down polling." } }),
    });
    const ticks = [];
    client.set("setInterval", (fn) => { ticks.push(fn); return ticks.length; });
    await client.call("startTraktDeviceLogin");
    assert.equal(ticks.length, 1);
    await ticks[0]();
    assert.match(client.document.getElementById("traktDevicePollingStatus").innerText, /Trakt is answering slowly/);
  });
});

describe("Connect Trakt with a code: the Worker's fallback says what Trakt said", () => {
  async function refusal(headers, body) {
    const env = makeEnv({ TRAKT_CLIENT_ID: "cid" });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      if (String(input && input.url ? input.url : input).includes("api.trakt.tv/oauth/device/code")) {
        return new Response(body, { status: 429, headers });
      }
      return new Response("{}", { status: 404 });
    };
    try {
      return await call(env, "/api/trakt/device/code", { method: "POST", json: {} });
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  it("names Trakt's limit and a long wait, and hands the whole wait back", async () => {
    const r = await refusal({ "Retry-After": "300", "X-Ratelimit": JSON.stringify({ name: "UNAUTHED_API_POST_LIMIT", period: 300, limit: 1, remaining: 0 }) }, "{}");
    assert.equal(r.status, 429);
    assert.equal(r.body.retryAfter, 300, "not cut to 30 seconds any more");
    assert.match(r.body.error, /UNAUTHED_API_POST_LIMIT/);
    assert.match(r.body.error, /about 5 minutes/);
  });

  it("recognises Cloudflare's own block on Trakt's side", async () => {
    const r = await refusal({ "Retry-After": "10" }, "<html><title>Access denied | api.trakt.tv used Cloudflare to restrict access</title>error code: 1015</html>");
    assert.match(r.body.error, /Cloudflare 1015/);
    assert.match(r.body.error, /wait 10 seconds/);
  });
});

describe("Connect Trakt with a code: the page carries the site's public app id", () => {
  it("in the per-visit preamble, not the shared bundle", async () => {
    const w = await freshIsolate();
    const env = makeEnv({ TRAKT_CLIENT_ID: "site-public-cid" });
    const page = await call(env, "/", { w });
    assert.match(page.text, /const TRAKT_PUBLIC_CLIENT_ID = "site-public-cid";/);
    const bundle = await call(env, "/app.js", { w });
    assert.equal(bundle.text.includes("site-public-cid"), false, "the bundle is the same file for every deployment and visitor");
  });
});
