// UI-08: pressing "Generate Install Link" twice while the first save is still
// waiting must not make a second install link (signed-out links never expire).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadClient, requestsTo } from "./client-harness.mjs";

describe("Generate Install Link", () => {
  function setup() {
    let release;
    const gate = new Promise((r) => { release = r; });
    const c = loadClient({
      signedIn: true,
      routes: { "/api/save": async () => { await gate; return { json: { ok: true, id: "abc" } }; } },
    });
    c.set("collectEntries", () => [{ url: "https://example.com/lists/a/b", name: "A", type: "movie" }]);
    return { c, release };
  }

  it("a second press while the first save waits sends no second /api/save", async () => {
    const { c, release } = setup();
    const first = c.call("generate");
    const second = c.call("generate");
    await new Promise((r) => setImmediate(r));
    release();
    await Promise.all([first, second]);
    assert.equal(requestsTo(c, "/api/save").length, 1);
  });

  it("works again after the first call has finished (Try again)", async () => {
    const { c, release } = setup();
    release();
    await c.call("generate");
    await c.call("generate");
    assert.equal(requestsTo(c, "/api/save").length, 2);
  });
});
