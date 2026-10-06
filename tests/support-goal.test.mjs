import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadClient } from "./client-harness.mjs";

// The Ko-fi support strip: a monthly goal and the amount given so far, set in
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
    assert.equal(pub.body.url, "https://ko-fi.com/mylistsaddon");
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

describe("support goal: Ko-fi's webhook adds payments by itself", () => {
  const TOKEN = "kofi-test-token-123";
  let n = 0;
  const payment = (over = {}) => ({
    verification_token: TOKEN, message_id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    timestamp: new Date().toISOString(), type: "Donation", is_public: true, from_name: "Someone",
    amount: "5.00", currency: "USD", ...over,
  });
  // As Ko-fi sends it: form-urlencoded, no Origin, a `data` field holding JSON.
  const post = (env, data) => call(env, "/api/kofi-webhook", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://ko-fi.com" },
    rawBody: new URLSearchParams({ data }).toString(),
  });
  const send = (env, data) => post(env, JSON.stringify(data));
  const total = async (env) => (await call(env, "/api/support-goal")).body.raised;
  async function setup() {
    const env = makeEnv({ CONFIGS: makeKv(), KOFI_VERIFICATION_TOKEN: TOKEN });
    const cookie = await adminCookie(env);
    await call(env, "/admin/api/support-goal", { method: "POST", cookie, json: { enabled: true, goal: 60 } });
    return { env, cookie };
  }

  it("adds a donation and a membership payment to the month's total", async () => {
    const { env } = await setup();
    assert.equal((await send(env, payment({ amount: "5.00" }))).status, 200);
    await send(env, payment({ type: "Subscription", amount: "3.50", is_subscription_payment: true }));
    assert.equal(await total(env), 8.5);
  });

  it("counts a payment once however many times Ko-fi sends it", async () => {
    const { env } = await setup();
    const p = payment({ amount: "10" });
    for (let i = 0; i < 3; i++) assert.equal((await send(env, p)).status, 200);
    assert.equal(await total(env), 10);
  });

  it("adds a private donation too, and never shows who gave", async () => {
    const { env } = await setup();
    await send(env, payment({ is_public: false, amount: "4", from_name: "Secret Person" }));
    assert.equal(await total(env), 4);
    const pub = JSON.stringify((await call(env, "/api/support-goal")).body);
    assert.ok(!pub.includes("Secret Person"));
  });

  it("skips shop orders, commissions, other currencies and nonsense amounts", async () => {
    const { env } = await setup();
    for (const over of [{ type: "Shop Order" }, { type: "Commission" }, { currency: "EUR" }, { amount: "0" }, { amount: "-5" }, { amount: "abc" }, { amount: "99999999" }]) {
      const r = await send(env, payment(over));
      assert.equal(r.status, 200, JSON.stringify(over));
      assert.equal(r.body.counted, false, JSON.stringify(over));
    }
    assert.equal(await total(env), 0);
  });

  it("refuses a wrong or missing token, and does nothing until the secret is set", async () => {
    const { env } = await setup();
    assert.equal((await send(env, payment({ verification_token: "nope" }))).status, 401);
    assert.equal((await send(env, payment({ verification_token: undefined }))).status, 401);
    assert.equal((await post(env, "not json")).status, 400);
    assert.equal(await total(env), 0);
    const noSecret = makeEnv({ CONFIGS: makeKv() });
    assert.equal((await send(noSecret, payment())).status, 503);
  });

  it("starts again from 0 in a new month", async () => {
    const { env } = await setup();
    await send(env, payment({ amount: "20" }));
    const stored = JSON.parse(env.CONFIGS._store.get("support:goal:v1"));
    stored.raisedMonth = "2000-01";
    env.CONFIGS._store.set("support:goal:v1", JSON.stringify(stored));
    await send(env, payment({ amount: "7" }));
    assert.equal(await total(env), 7, "last month's total is not carried into this one");
  });

  it("shows the webhook address, whether the token is set, and the last payment in the admin page data", async () => {
    const { env, cookie } = await setup();
    await send(env, payment({ amount: "12" }));
    const admin = (await call(env, "/admin/api/support-goal", { cookie })).body;
    assert.equal(admin.webhookUrl, "https://example.test/api/kofi-webhook");
    assert.equal(admin.kofiTokenSet, true);
    assert.equal(admin.lastPayment.amount, 12);
    const bare = makeEnv({ CONFIGS: makeKv() });
    const c2 = await adminCookie(bare);
    assert.equal((await call(bare, "/admin/api/support-goal", { cookie: c2 })).body.kofiTokenSet, false);
  });

  it("links to Ko-fi on the site", async () => {
    const site = (await call(makeEnv({}), "/")).text;
    assert.ok(site.includes("https://ko-fi.com/mylistsaddon"));
    assert.equal(site.includes("buymeacoffee.com"), false);
  });
});

describe("support goal: the strip on the page", () => {
  const goal = (over) => ({ ok: true, enabled: true, goal: 60, raised: 42, month: "2026-10", url: "https://ko-fi.com/mylistsaddon", ...over });
  async function strip(over, storage) {
    const client = loadClient({ routes: { "/api/support-goal": () => ({ json: goal(over) }) }, storage });
    await new Promise((r) => setTimeout(r, 20));
    return client;
  }
  const el = (c, id) => c.get("document").getElementById(id);

  it("shows the amount and the goal, with the bar filled to match", async () => {
    const c = await strip();
    assert.equal(el(c, "supportStrip").hidden, false);
    assert.equal(el(c, "supportStripText").textContent, "Server Costs: $42 of $60");
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

  it("is hidden for 30 days once dismissed, and back after that", async () => {
    const c = await strip({}, { "myListAddon:supportDismissed": String(Date.now() - 5 * 86400000) });
    assert.notEqual(el(c, "supportStrip").hidden, false);
    const later = await strip({}, { "myListAddon:supportDismissed": String(Date.now() - 31 * 86400000) });
    assert.equal(el(later, "supportStrip").hidden, false);
  });

  it("the X remembers the time", async () => {
    const c = await strip();
    c.call("dismissSupportStrip");
    assert.notEqual(el(c, "supportStrip").hidden, false);
    const at = Number(c.get("localStorage").getItem("myListAddon:supportDismissed"));
    assert.ok(Date.now() - at < 60000);
  });

  it("formats cents only when there are some", async () => {
    const c = await strip();
    assert.equal(c.call("supportMoney", 42), "$42");
    assert.equal(c.call("supportMoney", 42.5), "$42.50");
  });
});
