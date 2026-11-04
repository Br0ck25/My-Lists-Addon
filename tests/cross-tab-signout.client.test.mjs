// UI-05: signing out (or in, or switching account) in one tab must show in the
// other open tabs. The page reads the account from localStorage when it acts but
// only paints the header on load, so a second tab kept showing the old account.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadClient, fireListeners } from "./client-harness.mjs";

function tab(storage) {
  const c = loadClient({ signedIn: "alice", storage: { "myListAddon:creatorName": "alice", ...storage } });
  let reloads = 0;
  c.location.reload = () => { reloads++; };
  const storageEvent = (key, newValue) => fireListeners(c, { type: "storage", bubbles: true, key, newValue });
  return { c, storageEvent, reloads: () => reloads };
}

describe("another tab changes the signed-in account", () => {
  it("sign-out elsewhere (name removed) reloads this tab", () => {
    const t = tab();
    t.c.localStorage.removeItem("myListAddon:creatorName");
    t.storageEvent("myListAddon:creatorName", null);
    assert.equal(t.reloads(), 1);
  });

  it("a different account elsewhere reloads this tab", () => {
    const t = tab();
    t.c.localStorage.setItem("myListAddon:creatorName", "bob");
    t.storageEvent("myListAddon:creatorName", "bob");
    assert.equal(t.reloads(), 1);
  });

  it("signing in elsewhere while this tab is signed out reloads this tab", () => {
    const c = loadClient({});
    let reloads = 0;
    c.location.reload = () => { reloads++; };
    c.localStorage.setItem("myListAddon:creatorName", "bob");
    fireListeners(c, { type: "storage", bubbles: true, key: "myListAddon:creatorName", newValue: "bob" });
    assert.equal(reloads, 1);
  });

  it("the same account written again does not reload (no reload loop)", () => {
    const t = tab();
    t.storageEvent("myListAddon:creatorKey", "K-2");
    assert.equal(t.reloads(), 0);
  });

  it("unrelated keys are ignored", () => {
    const t = tab();
    t.c.localStorage.removeItem("myListAddon:creatorName");
    t.storageEvent("myListAddon:discoverSubmenu", "kids");
    assert.equal(t.reloads(), 0);
  });
});
