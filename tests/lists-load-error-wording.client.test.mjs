// Audit UI-09: when the lists request failed with a server error, the dashboard
// printed the server's own text ("boom", "db down") after the cross. The house
// wording is "Could not ...": the page now always says that, with the server's
// text only as a detail after it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadClient } from "./client-harness.mjs";

async function render(json, status = 500) {
  const c = loadClient({ signedIn: "alice", routes: { "/api/creator/lists": () => ({ status, json }) } });
  const box = c.document.getElementById("creatorDashboard");
  await c.call("renderCreatorDashboard");
  return box.innerHTML;
}

describe("UI-09: a failed lists load starts with Could not", () => {
  it("server text is a detail, not the message", async () => {
    const html = await render({ ok: false, error: "db down" });
    assert.match(html, /✗ Could not load your lists\./);
    assert.match(html, /db down/);
    assert.doesNotMatch(html, /✗ db down/);
  });
  it("without server text it still says Could not load", async () => {
    const html = await render({ ok: false });
    assert.match(html, /✗ Could not load your lists\./);
  });
});
