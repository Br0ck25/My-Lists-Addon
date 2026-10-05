import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadClient } from "./client-harness.mjs";

// The Buy Me a Coffee strip: a monthly goal and the amount given so far, set in
// the admin page and shown at the top of Catalogs.

const { makeKv, makeEnv, call } = await import("./harness.mjs");

async function adminCookie(env) {
  const login = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
  return (login.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/)[1];
}
const month = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit" }).format(new Date()).slice(0, 7);

describe("support goal: the public endpoint and the admin save", () => {
  it("is off until the admin turns it on", async () => {
    const env = makeEnv({ CONFIGS: makeKv() });
    const r = await call(env, "/api/support-goal");
    assert.equal(r.body.ok, true);
    assert.equal(r.body.enabled, false);
    assert.equal(r.body.goal, 0);
  });

  it("needs the admin to save, and to read the admin copy", async () => {
    const env = makeEnv({ CONFIGS: makeKv() });
    const post = await call(env, "/admin/api/support-goal", { method: "POST", json: { enabled: true, goal: 60 } });
    assert.equal(post.status, 401);
    const get = await call(env, "/admin/api/support-goal");
    assert.equal(get.status, 401);
  });

  it("saves a goal and the amount given, and the public endpoint shows them", async () => {
    const env = makeEnv({ CONFIGS: makeKv() });
    const cookie = await adminCookie(env);
    const saved = await call(env, "/admin/api/support-goal", { method: "POST", cookie, json: { enabled: true, goal: 60, raised: 42.5 } });
    assert.equal(saved.body.ok, true, JSON.stringify(saved.body));
    const pub = await call(env, "/api/support-goal");
    assert.deepEqual({ ...pub.body, url: undefined }, { ok: true, enabled: true, goal: 60, raised: 42.5, month: month(), url: undefined });
    assert.equal(pub.body.url, "https://buymeacoffee.com/brock25");
    const admin = await call(env, "/admin/api/support-goal", { cookie });
    assert.equal(admin.body.goal, 60);
    assert.equal(admin.body.raised, 42.5);
  });

  it("keeps the amount when only the goal changes, and counts it as 0 next month", async () => {
    const kv = makeKv();
    const env = makeEnv({ CONFIGS: kv });
    const cookie = await adminCookie(env);
    await call(env, "/admin/api/support-goal", { method: "POST", cookie, json: { enabled: true, goal: 60, raised: 20 } });
    await call(env, "/admin/api/support-goal", { method: "POST", cookie, json: { goal: 80 } });
    let pub = (await call(env, "/api/support-goal")).body;
    assert.equal(pub.goal, 80);
    assert.equal(pub.raised, 20);
    // The same record, as it would be a month on.
    const stored = JSON.parse(kv._store.get("support:goal:v1"));
    stored.raisedMonth = "2000-01";
    kv._store.set("support:goal:v1", JSON.stringify(stored));
    pub = (await call(env, "/api/support-goal")).body;
    assert.equal(pub.raised, 0, "last month's amount does not carry over");
    assert.equal(pub.goal, 80);
  });

  it("turning it off hides everything, and bad numbers are refused", async () => {
    const env = makeEnv({ CONFIGS: makeKv() });
    const cookie = await adminCookie(env);
    await call(env, "/admin/api/support-goal", { method: "POST", cookie, json: { enabled: true, goal: 60, raised: 5 } });
    await call(env, "/admin/api/support-goal", { method: "POST", cookie, json: { enabled: false } });
    const pub = (await call(env, "/api/support-goal")).body;
    assert.deepEqual([pub.enabled, pub.goal, pub.raised], [false, 0, 0]);

    for (const bad of [{ goal: -1 }, { goal: "abc" }, { goal: 1e9 }, { raised: -5 }, { raised: "x" }]) {
      const r = await call(env, "/admin/api/support-goal", { method: "POST", cookie, json: bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    const noGoal = makeEnv({ CONFIGS: makeKv() });
    const cookie2 = await adminCookie(noGoal);
    const r = await call(noGoal, "/admin/api/support-goal", { method: "POST", cookie: cookie2, json: { enabled: true, goal: 0 } });
    assert.equal(r.status, 400, "the strip cannot be turned on without a goal");
  });

  it("has its own tab in the admin page, and its page and strip markup are in the site", async () => {
    const env = makeEnv({ CONFIGS: makeKv() });
    const cookie = await adminCookie(env);
    const admin = await call(env, "/admin", { cookie });
    assert.match(admin.text, /data-admin-panel="supportgoal"/);
    assert.match(admin.text, /Support Goal<\/button>/);
    const site = (await call(env, "/")).text;
    assert.match(site, /id="supportStrip"/);
  });
});

describe("support goal: the strip on the page", () => {
  const goal = (over) => ({ ok: true, enabled: true, goal: 60, raised: 42, month: "2026-10", url: "https://buymeacoffee.com/brock25", ...over });
  async function strip(over, storage) {
    const client = loadClient({ routes: { "/api/support-goal": () => ({ json: goal(over) }) }, storage });
    await new Promise((r) => setTimeout(r, 20));
    return client;
  }
  const el = (c, id) => c.get("document").getElementById(id);

  it("shows the amount and the goal, with the bar filled to match", async () => {
    const c = await strip();
    assert.equal(el(c, "supportStrip").hidden, false);
    assert.equal(el(c, "supportStripText").textContent, "Server costs: $42 of $60");
    assert.equal(el(c, "supportStripFill").style.width, "70%");
  });

  it("turns to a thank-you when the goal is met", async () => {
    const c = await strip({ raised: 75 });
    assert.equal(el(c, "supportStripText").textContent, "Covered this month. Thank you!");
    assert.equal(el(c, "supportStripFill").style.width, "100%");
  });

  it("stays hidden when the admin has it off", async () => {
    const c = await strip({ enabled: false, goal: 0, raised: 0 });
    assert.notEqual(el(c, "supportStrip").hidden, false);
  });

  it("is hidden for the month once dismissed, and back in a new month", async () => {
    const c = await strip({}, { "myListAddon:supportDismissed": "2026-10" });
    assert.notEqual(el(c, "supportStrip").hidden, false);
    const next = await strip({ month: "2026-11" }, { "myListAddon:supportDismissed": "2026-10" });
    assert.equal(el(next, "supportStrip").hidden, false);
  });

  it("the X remembers the month", async () => {
    const c = await strip();
    c.call("dismissSupportStrip");
    assert.notEqual(el(c, "supportStrip").hidden, false);
    assert.equal(c.get("localStorage").getItem("myListAddon:supportDismissed"), "2026-10");
  });

  it("formats cents only when there are some", async () => {
    const c = await strip();
    assert.equal(c.call("supportMoney", 42), "$42");
    assert.equal(c.call("supportMoney", 42.5), "$42.50");
  });
});
