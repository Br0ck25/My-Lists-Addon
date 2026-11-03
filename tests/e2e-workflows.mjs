// End-to-end workflows in a real browser (audit TEST-08).
//
// ui-contract.mjs records what shared components look like; nothing else ever
// ran the real page, the real client script and the real Worker together. This
// starts dev/server.mjs (the real Worker over HTTP with SQLite D1 and in-memory
// KV, outside providers stubbed) and drives Chromium through what a person does:
//
//   1. create an account, create a list, reload: the list is still there
//   2. sign out, sign back in with the key: the list is there
//   3. delete the account: signed out, the list is gone from the server
//   4. add a channel: it is saved to the account and survives a reload
//
//   node tests/e2e-workflows.mjs
//
// Needs Playwright, like ui-contract.mjs (CI: the "e2e" job installs
// playwright@1.56.1). Each browser context sends its own CF-Connecting-IP
// because the sign-up limit is one account per IP, and the page is opened as
// "localhost".
import { spawn } from "node:child_process";
import net from "node:net";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const SERVER = fileURLToPath(new URL("../dev/server.mjs", import.meta.url));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on("error", reject);
  });
}

async function startServer() {
  const port = await freePort();
  const control = await freePort();
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, PORT: String(port), CONTROL_PORT: String(control) }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stderr.on("data", (d) => { log += d; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("dev server did not start:\n" + log)), 30000);
    child.stdout.on("data", (d) => { log += d; if (String(d).includes("LIVE on")) { clearTimeout(t); resolve(); } });
    child.on("exit", (code) => reject(new Error(`dev server exited (${code}):\n${log}`)));
  });
  return { origin: `http://localhost:${port}`, stop: () => child.kill() };
}

let ipSeq = 0;
async function newPerson(browser, origin) {
  const ctx = await browser.newContext({ extraHTTPHeaders: { "CF-Connecting-IP": `203.0.113.${100 + ++ipSeq}` } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  const problems = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  if (process.env.E2E_TRACE) page.on("response", async (r) => { if (r.url().includes("/api/creator/restore")) console.log("   restore ->", r.status(), (await r.text().catch(() => "")).slice(0, 200)); });
  if (process.env.E2E_TRACE) page.on("request", (r) => { if (new URL(r.url()).pathname.startsWith("/api/creator")) console.log("  ", r.method(), new URL(r.url()).pathname); });
  await page.goto(origin + "/");
  await page.waitForSelector("#headerProfileBtn");
  return { ctx, page, origin, problems };
}

async function signUp(p, name) {
  await p.page.click("#headerProfileBtn");
  await p.page.click("text=Need an account? Create one");
  await p.page.fill("#createProfileNameInput", name);
  await p.page.click("#createProfileSubmitBtn");
  await p.page.waitForSelector("#activeModalOverlay >> text=Profile Created");
  const key = await p.page.evaluate(() => localStorage.getItem("myListAddon:creatorKey"));
  assert.match(key, /^MYL-/, "the browser holds the new account key");
  await p.page.click("#activeModalOverlay button:has-text(\"Continue\")");
  return key;
}

async function createList(p, name) {
  await p.page.click("#tab-desktop-lists");
  await p.page.click('[data-act="openCreateListModal"]');
  await p.page.fill("#createListModalName", name);
  await p.page.click("#createListModalBtn");
  await p.page.waitForSelector(`#creatorDashboard >> text=${name}`);
}

// Asked from inside the page, like the client does, so it is a same-origin request.
async function api(p, path, json) {
  return p.page.evaluate(async ({ path, json }) => {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) });
    let body = {};
    try { body = await r.json(); } catch (e) {}
    return { status: r.status, body };
  }, { path, json });
}

async function serverListNames(p, name, key) {
  const { status, body } = await api(p, "/api/creator/lists", { creatorName: name, creatorKey: key });
  return { status, names: (body.lists || []).map((l) => l.name), body };
}

const workflows = {
  async "create account, create a list, reload: the list is still there"(browser, origin) {
    const p = await newPerson(browser, origin);
    const key = await signUp(p, "e2eone");
    await createList(p, "E2E Movies");
    const onServer = await serverListNames(p, "e2eone", key);
    assert.ok(onServer.names.includes("E2E Movies"), "the server has the list: " + JSON.stringify(onServer).slice(0, 400));
    await p.page.reload();
    await p.page.click("#tab-desktop-lists");
    await p.page.waitForSelector("#creatorDashboard >> text=E2E Movies");
    assert.deepEqual(p.problems, []);
    await p.ctx.close();
  },

  async "sign out, sign in with the key: the list is there"(browser, origin) {
    const p = await newPerson(browser, origin);
    const key = await signUp(p, "e2etwo");
    await createList(p, "E2E Shows");
    await p.page.click("#headerProfileBtn");
    await p.page.click('[data-act="switchCreatorProfile"]');
    await p.page.waitForFunction(() => !localStorage.getItem("myListAddon:creatorKey"));
    await p.page.click("#headerProfileBtn");
    await p.page.fill("#restoreNameInput", "e2etwo");
    await p.page.fill("#restoreKeyInput", key);
    await p.page.click("#restoreSubmitBtn");
    await p.page.waitForFunction(() => !!localStorage.getItem("myListAddon:creatorKey"));
    await p.page.click("#tab-desktop-lists");
    await p.page.waitForSelector("#creatorDashboard >> text=E2E Shows");
    assert.deepEqual(p.problems, []);
    await p.ctx.close();
  },

  async "delete the account: signed out, and the server no longer has the list"(browser, origin) {
    const p = await newPerson(browser, origin);
    const key = await signUp(p, "e2ethree");
    await createList(p, "E2E Gone");
    await p.page.click("#headerProfileBtn");
    await p.page.click("summary.danger-zone-summary");
    await p.page.click('[data-act="openDeleteAccountModal"]');
    await p.page.click("#confirmDeleteAccountBtn");
    await p.page.waitForFunction(() => !localStorage.getItem("myListAddon:creatorKey"));
    const after = await serverListNames(p, "e2ethree", key);
    assert.ok(after.status >= 400 || !after.names.includes("E2E Gone"), `list must be gone, got ${JSON.stringify(after)}`);
    assert.notEqual(after.status, 200, "the old key no longer works");
    assert.deepEqual(p.problems, []);
    await p.ctx.close();
  },

  async "add a channel: it is saved to the account and survives a reload"(browser, origin) {
    const p = await newPerson(browser, origin);
    const key = await signUp(p, "e2efour");
    await p.page.click("#tab-desktop-channels");
    await p.page.click('[data-act="createNextUpChannel"]');
    await p.page.waitForFunction(() => /dynamic.{0,5}next-up/.test(localStorage.getItem("myListAddon:channels") || localStorage.getItem("myListAddon:localChannels") || JSON.stringify(Object.fromEntries(Object.entries(localStorage)))));
    let saved = "";
    for (let i = 0; i < 40 && !/next-up/.test(saved); i++) {
      const res = await api(p, "/api/creator/sync/load", { creatorName: "e2efour", creatorKey: key });
      saved = JSON.stringify(res.body);
      if (!/next-up/.test(saved)) await p.page.waitForTimeout(250);
    }
    assert.match(saved, /next-up/, "the channel reached the server: " + saved.slice(0, 400));
    await p.page.reload();
    await p.page.click("#tab-desktop-channels");
    await p.page.waitForSelector("#myCreatedChannelsList >> text=Next Up");
    assert.deepEqual(p.problems, []);
    await p.ctx.close();
  },
};

const server = await startServer();
const browser = await chromium.launch();
let failed = 0;
try {
  for (const [name, run] of Object.entries(workflows)) {
    if (process.env.E2E_ONLY && !name.includes(process.env.E2E_ONLY)) continue;
    try { await run(browser, server.origin); console.log("ok   " + name); }
    catch (e) { failed++; console.log("FAIL " + name + "\n     " + String(e && e.stack || e).split("\n").slice(0, 6).join("\n     ")); }
  }
} finally {
  await browser.close();
  server.stop();
}
if (failed) { console.log(`${failed} workflow(s) failed`); process.exit(1); }
console.log("all workflows passed");
