// The site notice's server side: the public answer, the admin's edit and
// reset, and what Ko-fi's webhook leaves behind so a donation that did not
// count has a reason on the Support Goal screen.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { makeKv, makeEnv, call } = await import("./harness.mjs");

async function adminCookie(env) {
  const login = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
  return (login.headers.get("set-cookie") || "").match(/^([^=]+=[^;]+)/)[1];
}
const setup = async (extra = {}) => {
  const env = makeEnv({ CONFIGS: makeKv(), ...extra });
  return { env, cookie: await adminCookie(env) };
};
const save = (env, cookie, json) => call(env, "/admin/api/site-notice", { method: "POST", cookie, json });
const publicNotice = async (env) => (await call(env, "/api/site-notice")).body;

describe("site notice: what visitors are told", () => {
  it("is the shutdown message, on, until the admin changes it", async () => {
    const { env } = await setup();
    const n = await publicNotice(env);
    assert.equal(n.ok, true);
    assert.equal(n.enabled, true);
    assert.equal(n.title, "A Message About the Future of My Lists Addon");
    assert.match(n.body, /November 8, 2026/);
    assert.deepEqual([n.showDonate, n.showBackup, n.showGuide], [true, true, true]);
    assert.equal(n.donateUrl, "https://ko-fi.com/mylistsaddon");
  });

  it("can be turned off, and the text kept for turning it back on", async () => {
    const { env, cookie } = await setup();
    assert.equal((await save(env, cookie, { enabled: false })).body.ok, true);
    assert.equal((await publicNotice(env)).enabled, false);
    assert.equal((await save(env, cookie, { enabled: true })).body.ok, true);
    const n = await publicNotice(env);
    assert.equal(n.enabled, true);
    assert.match(n.body, /November 8, 2026/, "turning it off and on must not lose the message");
  });

  it("serves the admin's own words and button choices", async () => {
    const { env, cookie } = await setup();
    const r = await save(env, cookie, { title: "Good news", body: "We are staying.", showDonate: true, showBackup: false, showGuide: false });
    assert.equal(r.body.ok, true, r.body.error);
    const n = await publicNotice(env);
    assert.deepEqual([n.title, n.body, n.showDonate, n.showBackup, n.showGuide], ["Good news", "We are staying.", true, false, false]);
  });

  it("restores the original message", async () => {
    const { env, cookie } = await setup();
    await save(env, cookie, { title: "Other", body: "Other text", enabled: false });
    const r = await save(env, cookie, { reset: true });
    assert.equal(r.body.ok, true);
    const n = await publicNotice(env);
    assert.equal(n.enabled, true);
    assert.equal(n.title, "A Message About the Future of My Lists Addon");
  });

  it("will not turn on with no title or no message, and refuses text that is too long", async () => {
    const { env, cookie } = await setup();
    assert.equal((await save(env, cookie, { title: "", enabled: true })).status, 400);
    assert.equal((await save(env, cookie, { body: "   ", enabled: true })).status, 400);
    assert.equal((await save(env, cookie, { title: "x".repeat(121) })).status, 400);
    assert.equal((await save(env, cookie, { body: "x".repeat(4001) })).status, 400);
    // Off, it may be empty.
    assert.equal((await save(env, cookie, { enabled: false, title: "", body: "" })).body.ok, true);
  });

  it("is edited by the admin only", async () => {
    const { env } = await setup();
    const r = await call(env, "/admin/api/site-notice", { method: "POST", json: { enabled: false } });
    assert.equal(r.status, 401);
    assert.equal((await call(env, "/admin/api/site-notice")).status, 401);
    assert.equal((await publicNotice(env)).enabled, true, "an unauthenticated POST must change nothing");
  });

  it("has its own tab in the admin page", async () => {
    const { env, cookie } = await setup();
    const admin = await call(env, "/admin", { cookie });
    assert.match(admin.text, /data-admin-panel="sitenotice"/);
    assert.match(admin.text, /Site Notice<\/button>/);
  });
});

describe("Ko-fi webhook: the reason a donation did not count is on the admin page", () => {
  const TOKEN = "kofi-test-token-123";
  let n = 0;
  const payment = (over = {}) => ({
    verification_token: TOKEN, message_id: `00000000-0000-4000-8000-${String(++n + 500).padStart(12, "0")}`,
    timestamp: new Date().toISOString(), type: "Donation", is_public: true, from_name: "Someone",
    amount: "5.00", currency: "USD", ...over,
  });
  const send = (env, data) => call(env, "/api/kofi-webhook", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://ko-fi.com" },
    rawBody: new URLSearchParams({ data: JSON.stringify(data) }).toString(),
  });
  const last = async (env, cookie) => (await call(env, "/admin/api/support-goal", { cookie })).body.lastDelivery;

  it("a Worker with no token says so", async () => {
    const { env, cookie } = await setup();
    assert.equal((await send(env, payment())).status, 503);
    assert.equal((await last(env, cookie)).outcome, "no-token-on-worker");
  });

  it("a token that does not match says so", async () => {
    const { env, cookie } = await setup({ KOFI_VERIFICATION_TOKEN: TOKEN });
    assert.equal((await send(env, payment({ verification_token: "wrong" }))).status, 401);
    assert.equal((await last(env, cookie)).outcome, "wrong-token");
  });

  it("a payment in another currency says what it was, and does not move the total", async () => {
    const { env, cookie } = await setup({ KOFI_VERIFICATION_TOKEN: TOKEN });
    await call(env, "/admin/api/support-goal", { method: "POST", cookie, json: { enabled: true, goal: 60 } });
    await send(env, payment({ currency: "EUR", amount: "5.00" }));
    const d = await last(env, cookie);
    assert.deepEqual([d.outcome, d.currency, d.type], ["not-counted", "EUR", "Donation"]);
    assert.equal((await call(env, "/api/support-goal")).body.raised, 0);
  });

  it("a counted payment is recorded as counted", async () => {
    const { env, cookie } = await setup({ KOFI_VERIFICATION_TOKEN: TOKEN });
    await call(env, "/admin/api/support-goal", { method: "POST", cookie, json: { enabled: true, goal: 60 } });
    await send(env, payment({ amount: "7.00" }));
    assert.equal((await last(env, cookie)).outcome, "counted");
    assert.equal((await call(env, "/api/support-goal")).body.raised, 7);
  });

  it("repeated refused deliveries are written once, not once per attempt", async () => {
    const { env } = await setup({ KOFI_VERIFICATION_TOKEN: TOKEN });
    const puts = [];
    env.CONFIGS._hooks.beforePut = async (k) => { puts.push(k); };
    for (let i = 0; i < 5; i++) await send(env, payment({ verification_token: "wrong" }));
    assert.equal(puts.filter((k) => k === "kofi:lastdelivery:v1").length, 1);
  });
});
