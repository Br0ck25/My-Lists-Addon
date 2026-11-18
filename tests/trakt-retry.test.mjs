// API-07: a rate-limited Trakt call must not hold the app for ~7 s and send
// three calls; a long or date-form Retry-After is answered at once and then
// remembered, so the next request does not call Trakt while it is limited.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function load() {
  const sandbox = { console, Response, Headers, Date, Math, URL, parseInt, Number, Map };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["src/core/02_http-and-creator-utils.js", "src/core/82_trakt-retry.js"]) {
    vm.runInContext(fs.readFileSync(new URL("../" + f, import.meta.url), "utf8"), sandbox, { filename: f });
  }
  sandbox.calls = 0;
  sandbox.sleeps = [];
  sandbox.setTimeout = (fn, ms) => { sandbox.sleeps.push(ms); fn(); return 0; };
  sandbox.clearTimeout = () => {};
  return sandbox;
}
const limited = (retryAfter) => () => new Response("", { status: 429, headers: retryAfter === null ? {} : { "Retry-After": retryAfter } });
const opts = (key) => ({ headers: { "trakt-api-key": key, Authorization: "Bearer t-" + key } });

describe("Trakt 429 handling (API-07)", () => {
  it("does not sleep or retry when Trakt says to wait 30 s", async () => {
    const s = load();
    s.fetch = async () => { s.calls++; return limited("30")(); };
    const res = await s.fetchTraktWithRetry("https://api.trakt.tv/a", opts("k1"));
    assert.equal(res.status, 429);
    assert.equal(s.calls, 1);
    assert.deepEqual(s.sleeps, []);
  });

  it("reads a Retry-After given as a date", async () => {
    const s = load();
    s.fetch = async () => { s.calls++; return limited(new Date(Date.now() + 40000).toUTCString())(); };
    await s.fetchTraktWithRetry("https://api.trakt.tv/a", opts("k2"));
    assert.equal(s.calls, 1, "a date 40 s ahead is a long wait, not NaN");
    assert.deepEqual(s.sleeps, []);
  });

  it("makes no call at all while the key is cooling down, but other keys still go out", async () => {
    const s = load();
    s.fetch = async () => { s.calls++; return limited("30")(); };
    await s.fetchTraktWithRetry("https://api.trakt.tv/a", opts("k3"));
    const again = await s.fetchTraktWithRetry("https://api.trakt.tv/b", opts("k3"));
    assert.equal(again.status, 429);
    assert.equal(s.calls, 1);
    await s.fetchTraktWithRetry("https://api.trakt.tv/b", opts("other"));
    assert.equal(s.calls, 2);
  });

  it("still retries a short wait", async () => {
    const s = load();
    s.fetch = async () => { s.calls++; return s.calls < 2 ? limited("1")() : new Response("[]", { status: 200 }); };
    const res = await s.fetchTraktWithRetry("https://api.trakt.tv/a", opts("k4"));
    assert.equal(res.status, 200);
    assert.equal(s.calls, 2);
    assert.equal(s.sleeps.length, 1);
  });

  it("a missing Retry-After counts as a short wait and gives up after the retries", async () => {
    const s = load();
    s.fetch = async () => { s.calls++; return limited(null)(); };
    const res = await s.fetchTraktWithRetry("https://api.trakt.tv/a", opts("k5"));
    assert.equal(res.status, 429);
    assert.equal(s.calls, 3);
  });
});
