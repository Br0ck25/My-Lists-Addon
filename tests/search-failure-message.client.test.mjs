// Audit UI-01: when the title or public-list lookup answered with an error, the
// Search page said "No titles found." / "No published ... lists available yet.",
// as if the catalogue were empty. Only a thrown network error said it could not
// load. A server error now says the same.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadClient } from "./client-harness.mjs";

async function render(routes, type) {
  const client = loadClient({ routes });
  if (type) client.set("currentCatalogSearchType", type);
  const res = client.document.getElementById("catalogSearchResult");
  await client.call("renderDefaultCatalogSearch", true);
  return res.innerHTML;
}

describe("UI-01: a failed search is not shown as an empty one", () => {
  it("titles: HTTP 500 says it could not load", async () => {
    const html = await render({ "/api/title-search": () => ({ status: 500, json: { ok: false, error: "boom" } }) }, "movie");
    assert.match(html, /Could not load top titles/);
    assert.doesNotMatch(html, /No titles found/);
  });

  it("titles: ok:false says it could not load", async () => {
    const html = await render({ "/api/title-search": () => ({ json: { ok: false } }) }, "movie");
    assert.match(html, /Could not load top titles/);
  });

  it("titles: a real empty answer still says none were found", async () => {
    const html = await render({ "/api/title-search": () => ({ json: { ok: true, results: [] } }) }, "movie");
    assert.match(html, /No titles found/);
  });

  it("public lists: HTTP 500 says it could not load", async () => {
    const html = await render({ "/api/search-published-lists": () => ({ status: 500, json: { ok: false } }) }, "lists");
    assert.match(html, /Could not load public lists/);
    assert.doesNotMatch(html, /No published My Lists Addon lists/);
  });

  it("public lists: a real empty answer still says none are published", async () => {
    const html = await render({ "/api/search-published-lists": () => ({ json: { ok: true, lists: [] } }) }, "lists");
    assert.match(html, /No published My Lists Addon lists available yet/);
  });
});
