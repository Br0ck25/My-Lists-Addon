// SEC-03 follow-up: refusing the Account Key in the address must not break the
// TV Launcher page. It reads its saved setup through the sign-in cookie, signs
// in again with the stored key when the cookie has ended, and when it cannot
// load, says so and never saves from the empty defaults.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { makeEnv, makeD1, makeKv, call, createUser } from "./harness.mjs";

const SAVED = [{ name: "Saved TV shelf", url: "custom:saved-tv" }];

async function setupAccount(extraEnv = {}) {
  const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), FF_SESSIONS: "1", ...extraEnv });
  const u = await createUser(env, "tvlaunch");
  await env.CONFIGS.put("creatorsync:tvlaunch:tv", JSON.stringify({ mirror: false, entries: SAVED, updatedAt: 5 }));
  return { env, key: u.creatorKey };
}

// Runs the page's real config functions against the real Worker.
async function launcherPage(env, { key, cookie = "" }) {
  const page = await call(env, "/nuvio-tv-launcher");
  const block = page.text.split(/<script[^>]*>/).find((b) => b.includes("async function loadTvLauncherConfig"));
  assert.ok(block, "launcher script found");
  const start = block.indexOf("var ORIGIN");
  const end = block.indexOf("function copyTvManifestUrl");
  const src = block.slice(start, block.indexOf("\n}\n", end) + 3);
  const store = new Map([["myListAddon:creatorName", "tvlaunch"]]);
  if (key) store.set("myListAddon:creatorKey", key);
  const jar = { cookie };
  const sent = [];
  const toasts = [];
  const sandbox = {
    console: { log() {}, error() {}, warn() {} }, JSON, encodeURIComponent, Array, Promise,
    location: { origin: "https://example.test", pathname: "/nuvio-tv-launcher" },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem() {}, removeItem() {} },
    document: { getElementById: () => null },
    renderTvHomeShelves() {},
    showToast: (msg, kind) => toasts.push({ msg, kind }),
    async fetch(input, init = {}) {
      const u = new URL(String(input));
      const method = (init.method || "GET").toUpperCase();
      sent.push({ method, path: u.pathname, search: u.search, body: init.body ? JSON.parse(init.body) : null });
      const r = await call(env, u.pathname + u.search, { method, json: init.body ? JSON.parse(init.body) : undefined, cookie: jar.cookie });
      const set = (r.headers.get("set-cookie") || "").split(";")[0];
      if (set && set.includes("=") && !/=$/.test(set)) jar.cookie = set;
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__get = (n) => eval(n); globalThis.__fn = (n, a) => eval(n).apply(null, a);", sandbox);
  return { sandbox, sent, toasts, get: (n) => sandbox.__get(n), run: (n, ...a) => sandbox.__fn(n, a) };
}

const tvConfig = async (env) => JSON.parse(await env.CONFIGS.get("creatorsync:tvlaunch:tv"));

describe("TV Launcher page loads its saved setup without a key in the address", () => {
  it("loads through a live sign-in cookie", async () => {
    const { env, key } = await setupAccount();
    const s = await call(env, "/api/session", { method: "POST", json: { username: "tvlaunch", key } });
    const p = await launcherPage(env, { key: "", cookie: (s.headers.get("set-cookie") || "").split(";")[0] });
    await p.run("loadTvLauncherConfig");
    assert.deepEqual(p.get("tvLauncherTvLists"), SAVED);
    assert.equal(p.get("tvLauncherIsMirror"), false);
    assert.equal(p.toasts.length, 0);
    assert.ok(p.sent.every((r) => !/creatorKey|key=/i.test(r.search)), "no key in any address");
  });

  it("signs in again with the stored key when the cookie has ended, then loads", async () => {
    const { env, key } = await setupAccount();
    const p = await launcherPage(env, { key, cookie: "" });
    await p.run("loadTvLauncherConfig");
    assert.deepEqual(p.get("tvLauncherTvLists"), SAVED, "saved TV lineup loaded, not the defaults");
    assert.equal(p.get("tvLauncherIsMirror"), false);
    assert.equal(p.toasts.length, 0);
    assert.ok(p.sent.every((r) => !/creatorKey|key=/i.test(r.search)), "no key in any address");
  });

  it("with no session and no way to sign in, says so and never overwrites the saved setup from defaults", async () => {
    const { env, key } = await setupAccount({ FF_SESSIONS: "" });
    const p = await launcherPage(env, { key, cookie: "" });
    await p.run("loadTvLauncherConfig");
    assert.ok(p.toasts.some((t) => t.kind === "error" && /^Could not load/.test(t.msg)), JSON.stringify(p.toasts));
    // The next change the person makes on the page would save from the defaults.
    const saved = await p.run("saveTvLauncherConfig", true, []);
    assert.equal(saved, false);
    assert.ok(!p.sent.some((r) => r.method === "POST" && r.path === "/api/nuvio-tv/config"), "no save request was sent");
    const kv = await tvConfig(env);
    assert.equal(kv.mirror, false);
    assert.deepEqual(kv.entries, SAVED);
  });
});
