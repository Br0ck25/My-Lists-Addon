// traktIsHiddenShow is the one rule both the Continue Watching shelf and
// /api/trakt-my-private-lists use to drop shows the account hid, dropped or
// reset on Trakt (CQ-04 step 1). It matches on any of Trakt id, IMDB id, TMDB
// id, slug or title, with IMDB ids, slugs and titles lowercased.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(ROOT, "src/catalog/06_source-fetchers-mdblist-trakt.js"), "utf8");
const m = src.match(/function traktIsHiddenShow\([\s\S]*?\n}\n/);
assert.ok(m, "traktIsHiddenShow is defined at the top level of 06_");
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(m[0], sandbox);
const hidden = sandbox.traktIsHiddenShow;

describe("traktIsHiddenShow", () => {
  const keys = new Set(["123", "tt0944947", "603", "game-of-thrones", "the wire"]);
  it("matches each kind of id", () => {
    assert.equal(hidden(keys, {}, { trakt: 123 }), true);
    assert.equal(hidden(keys, {}, { imdb: "TT0944947" }), true);
    assert.equal(hidden(keys, {}, { tmdb: 603 }), true);
    assert.equal(hidden(keys, {}, { slug: "Game-Of-Thrones" }), true);
  });
  it("matches by title, ignoring case and outer spaces", () => {
    assert.equal(hidden(keys, { title: "  The Wire " }, {}), true);
  });
  it("reads ids from the show object when no ids are passed", () => {
    assert.equal(hidden(keys, { ids: { trakt: 123 } }, null), true);
  });
  it("lets an unrelated show through", () => {
    assert.equal(hidden(keys, { title: "Other" }, { trakt: 999, imdb: "tt1", tmdb: 5, slug: "other" }), false);
  });
  it("lets everything through when nothing is hidden or nothing is given", () => {
    assert.equal(hidden(new Set(), { title: "The Wire" }, { trakt: 123 }), false);
    assert.equal(hidden(keys, null, null), false);
  });
});
