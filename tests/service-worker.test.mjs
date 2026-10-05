import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { makeEnv, call } from "./harness.mjs";

async function loadServiceWorker() {
  const res = await call(makeEnv(), "/sw.js");
  assert.equal(res.status, 200);
  const listeners = {};
  const fetchCalls = [];
  const cache = { put: async () => {}, match: async () => undefined, keys: async () => [], delete: async () => true, add: async () => {} };
  const sandbox = {
    self: {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      location: { origin: "https://example.test" },
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
    caches: { open: async () => cache, keys: async () => [], delete: async () => true },
    fetch: async (r) => { fetchCalls.push(r); return { ok: true, status: 200, clone() { return this; } }; },
    Request, Headers, URL, Response,
  };
  vm.createContext(sandbox);
  vm.runInContext(res.text, sandbox);
  return { listeners, fetchCalls, source: res.text };
}

describe("service worker: page loads", () => {
  it("sends the browser's own navigation request to the network, untouched", async () => {
    const { listeners, fetchCalls } = await loadServiceWorker();
    const req = { method: "GET", mode: "navigate", url: "https://example.test/api/trakt/oauth/callback?code=x&state=y" };
    let answer;
    listeners.fetch({ request: req, respondWith: (p) => { answer = p; } });
    await answer;
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0], req, "a rebuilt Request follows redirects itself, and OAuth sign-ins break");
  });

  it("never rebuilds a page load as a same-origin request", async () => {
    const { source } = await loadServiceWorker();
    assert.doesNotMatch(source, /mode:\s*'same-origin'/);
  });
});
