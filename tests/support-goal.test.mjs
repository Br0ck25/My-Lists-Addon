import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadClient } from "./client-harness.mjs";

// The Ko-fi support strip: a monthly goal and the amount given so far, set in
// the admin page and shown at the top of Catalogs.

const { makeKv, makeEnv, makeD1, call } = await import("./harness.mjs");

async function adminCookie(env) {
  const login = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
  return (login.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/)[1];
}
const month = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now).split("-");
  let year = Number(parts[0]);
  let m = Number(parts[1]);
  const day = Number(parts[2]);
  if (day < 9) {
    m -= 1;
    if (m < 1) {
      m = 12;
      year -= 1;
    }
  }
  return `${year}-${String(m).padStart(2, "0")}`;
};

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

  it("billing cycle starts on the 9th: day 8 belongs to previous month, day 9 to current month", async () => {
    assert.equal(month(new Date("2026-10-08T12:00:00-04:00")), "2026-09");
    assert.equal(month(new Date("2026-10-09T12:00:00-04:00")), "2026-10");
    assert.equal(month(new Date("2027-01-05T12:00:00-05:00")), "2026-12");
    assert.equal(month(new Date("2027-01-09T12:00:00-05:00")), "2027-01");
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
    assert.match(admin.text, /Support goal<\/button>/);
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

// BA-001: the month's total used to live in one KV record, read, added to and
// written back by the webhook and by the admin save. KV has no atomic add, so
// two payments close together lost one, and a failed read made the webhook
// write "enabled: false, raised: this one payment" over everything. With D1
// bound the total is an atomic counter (cents, one row per month) and the
// payment's message id is recorded in the same batch, so "seen" and "counted"
// are one step.
describe("support goal: the total is an atomic counter in D1 (BA-001)", () => {
  const TOKEN = "kofi-test-token-123";
  let n = 1000;
  const payment = (over = {}) => ({
    verification_token: TOKEN, message_id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    timestamp: new Date().toISOString(), type: "Donation", is_public: true, from_name: "Someone",
    amount: "5.00", currency: "USD", ...over,
  });
  const send = (env, data) => call(env, "/api/kofi-webhook", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://ko-fi.com" },
    rawBody: new URLSearchParams({ data: JSON.stringify(data) }).toString(),
  });
  const total = async (env) => (await call(env, "/api/support-goal")).body.raised;
  async function setup() {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1(), KOFI_VERIFICATION_TOKEN: TOKEN });
    const cookie = await adminCookie(env);
    await call(env, "/admin/api/support-goal", { method: "POST", cookie, json: { enabled: true, goal: 60 } });
    return { env, cookie };
  }
  const rawKv = (env) => env.CONFIGS._store.get("support:goal:v1");

  it("adds two different payments that arrive at the same moment", async () => {
    const { env } = await setup();
    // Both webhook calls read the KV settings before either has written
    // anything: the second read waits at a gate until the first has arrived.
    let arrived = 0;
    let open;
    const gate = new Promise((r) => { open = r; });
    env.CONFIGS._hooks.beforeGet = async (key) => {
      if (key !== "support:goal:v1") return;
      if (++arrived >= 2) open();
      await gate;
    };
    const [a, b] = await Promise.all([
      send(env, payment({ amount: "5.00" })),
      send(env, payment({ amount: "7.25" })),
    ]);
    env.CONFIGS._hooks.beforeGet = null;
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(await total(env), 12.25, "neither payment replaced the other");
  });

  it("counts a payment once, even when Ko-fi sends it twice at once", async () => {
    const { env } = await setup();
    const p = payment({ amount: "10" });
    const rs = await Promise.all([send(env, p), send(env, p), send(env, p)]);
    assert.deepEqual(rs.map((r) => r.status), [200, 200, 200]);
    assert.equal(rs.filter((r) => r.body.counted === true).length, 1, "exactly one delivery did the counting");
    assert.equal(await total(env), 10);
    assert.equal((await send(env, p)).body.duplicate, true, "and a later retry is told it is a duplicate");
    assert.equal(await total(env), 10);
  });

  it("stores whole cents, so adding never drifts", async () => {
    const { env } = await setup();
    for (const amount of ["0.10", "0.20", "0.30"]) await send(env, payment({ amount }));
    assert.equal(await total(env), 0.6);
    const row = await env.DB.prepare("SELECT n FROM stats WHERE kind LIKE 'kofi:raised:%' AND day = 'total'").first();
    assert.equal(row.n, 60, "60 cents, an integer");
  });

  it("a failed settings read answers 503 and changes nothing, so Ko-fi retries", async () => {
    const { env } = await setup();
    await send(env, payment({ amount: "20" }));
    const settingsBefore = rawKv(env);
    let failures = 1;
    env.CONFIGS._hooks.beforeGet = async (key) => {
      if (key === "support:goal:v1" && failures-- > 0) throw new Error("KV read failed");
    };
    const p = payment({ amount: "9" });
    const r = await send(env, p);
    assert.notEqual(r.status, 200, "Ko-fi must see a failure so it sends the payment again");
    assert.equal(rawKv(env), settingsBefore, "the goal and the on/off switch are not rewritten");
    env.CONFIGS._hooks.beforeGet = null;
    assert.equal(await total(env), 20, "and the total has not been touched");
    // The retry then counts it.
    assert.equal((await send(env, p)).body.counted, true);
    assert.equal(await total(env), 29);
  });

  it("an unreadable settings record is not overwritten with defaults either", async () => {
    const { env } = await setup();
    env.CONFIGS._store.set("support:goal:v1", "{not json");
    const r = await send(env, payment({ amount: "9" }));
    assert.notEqual(r.status, 200);
    assert.equal(rawKv(env), "{not json");
  });

  it("keeps the manual amount the admin types, and adds payments on top of it", async () => {
    const { env, cookie } = await setup();
    await call(env, "/admin/api/support-goal", { method: "POST", cookie, json: { raised: 20 } });
    assert.equal(await total(env), 20, "the typed amount shows on the public strip");
    assert.equal((await call(env, "/admin/api/support-goal", { cookie })).body.raised, 20);
    await send(env, payment({ amount: "5" }));
    assert.equal(await total(env), 25);
    await call(env, "/admin/api/support-goal", { method: "POST", cookie, json: { raised: 3 } });
    assert.equal(await total(env), 3, "typing a lower amount replaces it");
  });

  it("saving only the goal does not touch the total", async () => {
    const { env, cookie } = await setup();
    await send(env, payment({ amount: "8" }));
    await call(env, "/admin/api/support-goal", { method: "POST", cookie, json: { goal: 90 } });
    const pub = (await call(env, "/api/support-goal")).body;
    assert.deepEqual([pub.goal, pub.raised], [90, 8]);
  });

  it("starts the next month at 0, whatever last month's row says", async () => {
    const { env } = await setup();
    await env.DB.prepare("INSERT INTO stats (kind, day, n) VALUES ('kofi:raised:2000-01', 'total', 999900)").run();
    assert.equal(await total(env), 0);
  });

  it("carries on from the total a KV-only deployment had already collected this month", async () => {
    const { env, cookie } = await setup();
    await call(env, "/admin/api/support-goal", { method: "POST", cookie, json: { raised: 42 } });
    // Put the world back to how it was before D1 held the total: KV has the
    // amount, D1 has no row for the month.
    await env.DB.prepare("DELETE FROM stats WHERE kind LIKE 'kofi:raised:%'").run();
    assert.equal(await total(env), 42, "read from the KV record until D1 has its own");
    await send(env, payment({ amount: "5" }));
    assert.equal(await total(env), 47, "the first payment is added to it, not to nothing");
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
