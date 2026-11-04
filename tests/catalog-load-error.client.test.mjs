// UI-03: when a catalog preview fails (a 502 page, not JSON), My Catalogs said
// "Network error loading this catalog" even though the person's connection was
// fine, and offered no way to try again (Discover has a Retry).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import { loadClient } from "./client-harness.mjs";
import { listSources } from "./sources.mjs";

describe("catalog preview failure", () => {
  it("is worded 'Could not ...' and offers Retry, which re-runs the catalogs preview", () => {
    const html = loadClient().call("catalogLoadErrorHtml");
    assert.match(html, /Could not load this catalog\./);
    assert.doesNotMatch(html, /network/i);
    assert.match(html, /<button[^>]*data-act="renderLivePreview"[^>]*>Retry<\/button>/);
  });

  it("the preview's catch block uses it, not its old wording", () => {
    const root = new URL("../", import.meta.url).pathname;
    const src = fs.readFileSync(root + "src/client/23_client-list-management.js", "utf8");
    assert.doesNotMatch(src, /Network error loading this catalog/);
    assert.match(src, /catalogLoadErrorHtml\(\)/);
  });
});
