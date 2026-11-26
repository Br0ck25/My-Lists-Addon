// The /admin "Default addon link" screen is a search-and-add picker: the admin
// searches the site's published lists and clicks Add, nothing is typed. These
// tests run the screen's real script (04_default-manifest-admin-ui.js) with a
// stub page and hold what the clicks turn into: a movie or series list becomes
// one row, a list with both becomes a Movies row and a Series row, and adding
// the same list twice changes nothing.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = fs.readFileSync(path.join(ROOT, "src/admin/04_default-manifest-admin-ui.js"), "utf8");

function pageScript() {
  const maker = vm.runInNewContext(SRC + "\n;defaultManifestAdminScript", {});
  return maker();
}

// The page script run against a page that has no elements, so only its logic runs.
function loadScript() {
  const ctx = { document: { getElementById: () => null, createElement: () => ({}) }, window: {}, fetch: async () => { throw new Error("no network"); } };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(pageScript(), ctx);
  // Arrays made inside the stub page are another realm's arrays, which deepEqual
  // will not match with ours; a round trip through JSON hands back plain ones.
  const plain = (v) => JSON.parse(JSON.stringify(v));
  return {
    defaultManifestRowsFor: (f) => plain(ctx.defaultManifestRowsFor(f)),
    defaultManifestMerge: (a, b) => plain(ctx.defaultManifestMerge(a, b)),
  };
}

const found = (type) => ({ name: "Best Heist Films", type, url: "https://example.test/lists/ann/best-heist-films", creatorName: "ann", items: 12 });

describe("default addon link picker", () => {
  it("the page script has no template placeholders or closing script tag in it", () => {
    const s = pageScript();
    assert.ok(!s.includes("${"), "a placeholder would be filled in by the dashboard's own template");
    assert.ok(!/<\/script/i.test(s));
  });

  it("a movie list becomes one Movies row, a series list one Series row", () => {
    const p = loadScript();
    assert.deepEqual(p.defaultManifestRowsFor(found("movie")).map((r) => r.type), ["movie"]);
    assert.deepEqual(p.defaultManifestRowsFor(found("series")).map((r) => r.type), ["series"]);
  });

  it("a list holding both becomes a Movies row and a Series row from the same link", () => {
    const p = loadScript();
    const rows = p.defaultManifestRowsFor(found("mixed"));
    assert.deepEqual(rows.map((r) => r.type), ["movie", "series"]);
    assert.ok(rows.every((r) => r.url === found("mixed").url && r.name === "Best Heist Films"));
  });

  it("adding a list that is already there changes nothing, and a new one goes last", () => {
    const p = loadScript();
    const have = p.defaultManifestRowsFor(found("movie"));
    assert.equal(p.defaultManifestMerge(have, p.defaultManifestRowsFor(found("movie"))).length, 1);
    const other = { name: "Other", type: "movie", url: "https://example.test/lists/bob/other" };
    const merged = p.defaultManifestMerge(have, p.defaultManifestRowsFor(other));
    assert.deepEqual(merged.map((r) => r.name), ["Best Heist Films", "Other"]);
  });

  it("the same link may be on the link once as Movies and once as Series", () => {
    const p = loadScript();
    const have = p.defaultManifestRowsFor(found("movie"));
    assert.equal(p.defaultManifestMerge(have, p.defaultManifestRowsFor(found("mixed"))).length, 2);
  });

  it("a row has only what the save needs, so nothing from the search result leaks into it", () => {
    const p = loadScript();
    const row = p.defaultManifestRowsFor(found("movie"))[0];
    assert.deepEqual(Object.keys(row).sort(), ["name", "type", "url"]);
  });

  it("a Quick Add result uses its own movie link for Movies and its own show link for Series", () => {
    const p = loadScript();
    const chart = { name: "MDBList Popular", type: "mixed", group: "Charts", movieUrl: "https://mdblist.com/lists/official/movies/popular", showUrl: "https://mdblist.com/lists/official/shows/popular" };
    assert.deepEqual(p.defaultManifestRowsFor(chart).map((r) => [r.type, r.url]), [
      ["movie", "https://mdblist.com/lists/official/movies/popular"],
      ["series", "https://mdblist.com/lists/official/shows/popular"],
    ]);
    const movieOnly = { name: "Trakt Box Office", type: "movie", movieUrl: "trakt:chart:box_office", showUrl: "" };
    assert.deepEqual(p.defaultManifestRowsFor(movieOnly).map((r) => [r.type, r.url]), [["movie", "trakt:chart:box_office"]]);
  });
});
