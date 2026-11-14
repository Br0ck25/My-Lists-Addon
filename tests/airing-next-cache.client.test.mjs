// CQ-03: the "apply the cached Airing Next dates to a provider's list" step was
// pasted into renderMyMdblistLists, renderMyPrivateTraktLists and
// renderMySimklLists. It now lives in applyAiringNextCache(list, cacheKey); the
// three renderers differ only in which localStorage cache they pass.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadClient } from "./client-harness.mjs";

const cacheEntry = { id: "tt1", airDate: "2999-01-01", seasonNum: 2, episodeNum: 1 };
const freshList = () => ({ statusKey: "airing-next", items: [{ id: "tt1", name: "A" }, { id: "tt2", name: "B" }] });
const KEYS = { mdblist: "myListAddon:mdblistAiringNextCache", trakt: "myListAddon:traktAiringNextCache", simkl: "myListAddon:simklAiringNextCache" };

describe("applyAiringNextCache", () => {
  for (const [provider, key] of Object.entries(KEYS)) {
    it(`${provider}: fills the date, season and premiere from that provider's own cache`, () => {
      const c = loadClient({ storage: { [key]: JSON.stringify([cacheEntry]) } });
      const list = freshList();
      c.call("applyAiringNextCache", list, key.replace("myListAddon:", ""));
      const it1 = list.items[0];
      assert.equal(it1.airDate, "2999-01-01");
      assert.equal(it1.seasonNum, 2);
      assert.equal(it1.isSeasonPremiere, true, "episode 1 with no stored flag is a premiere");
      assert.equal(it1.episodeTitle, "Season Premiere");
      assert.equal(it1.isUnaired, true);
      assert.equal(list.items[1].airDate, undefined, "a show not in the cache is untouched");
      assert.equal(list._cachedApplied, true);
    });
  }

  it("another provider's cache is not read", () => {
    const c = loadClient({ storage: { [KEYS.trakt]: JSON.stringify([cacheEntry]) } });
    const list = freshList();
    c.call("applyAiringNextCache", list, "simklAiringNextCache");
    assert.equal(list.items[0].airDate, undefined);
  });

  it("applies only once per list", () => {
    const c = loadClient({ storage: { [KEYS.mdblist]: JSON.stringify([cacheEntry]) } });
    const list = freshList();
    c.call("applyAiringNextCache", list, "mdblistAiringNextCache");
    list.items[0].airDate = "changed";
    c.call("applyAiringNextCache", list, "mdblistAiringNextCache");
    assert.equal(list.items[0].airDate, "changed");
  });

  it("the three renderers call it instead of carrying their own copy", () => {
    const c = loadClient();
    for (const fn of ["renderMyMdblistLists", "renderMyPrivateTraktLists", "renderMySimklLists"]) {
      const text = c.get(`${fn}.toString()`);
      assert.match(text, /applyAiringNextCache\(/, fn);
      assert.doesNotMatch(text, /cacheMap/, fn + " still has its own cache merge");
    }
  });
});
