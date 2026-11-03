import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadWorkerWithHooks } from "./perf-hooks.mjs";

// PERF-07 step 2: findChartOrCollectionEntry used to walk all eleven chart tables
// and CHART_SLUG_ENTRIES, calling the regex-based slugifyServer 4-5 times per item,
// for every id. It now answers from an index built once per isolate. The frozen old
// scan is the oracle: the indexed lookup must return exactly what it returned.

const OLD = readFileSync(new URL("./fixtures/old-find-chart-entry.js.txt", import.meta.url), "utf8");

async function load() {
  return loadWorkerWithHooks(`
    ${OLD}
    export const __count = { slug: 0 };
    { const s = slugifyServer; slugifyServer = (...a) => (__count.slug++, s(...a)); }
    export const __probe = {
      now: (id, type) => findChartOrCollectionEntry(id, type),
      old: (id, type) => __oldFindChartOrCollectionEntry(id, type),
      ids() {
        const out = new Set();
        const tables = [STREAMING_TOP10, STREAMING_ALL, KIDS_LISTS, HOLIDAY_LISTS, GENRE_LISTS, MDBLIST_OFFICIAL_CHARTS, TMDB_CHART_LISTS, TRAKT_CHART_LISTS, SIMKL_CHART_LISTS, HIDDEN_GEMS_LIST, MY_LISTS_ADDON_CHARTS, CHART_SLUG_ENTRIES];
        for (const t of tables) for (const it of t) {
          if (!it) continue;
          for (const u of [it.movieUrl, it.showUrl, it.url, it.name, it.slug]) {
            out.add(String(u || "")); out.add(slugifyServer(u || ""));
          }
          if (it.slug) out.add(String(it.slug).toLowerCase());
        }
        return [...out];
      },
    };
  `);
}

describe("PERF-07 step 2: indexed chart lookup equals the old linear scan", () => {
  it("returns the identical result for every known slug/name/url, both types, plus misses", async () => {
    const m = await load();
    const ids = m.__probe.ids().concat(["", " ", "  nope  ", "totally-unknown-row", "row1", "tmdb-chart-netflix", "tmdb-kids-pg", "tmdb-genre-28", "tmdb-holiday-x", null, undefined]);
    assert.ok(ids.length > 100, `expected a rich id set, got ${ids.length}`);
    let hits = 0;
    for (const type of ["movie", "series", "other"]) {
      for (const id of ids) {
        const want = m.__probe.old(id, type);
        const got = m.__probe.now(id, type);
        assert.deepEqual(got, want, `mismatch for id=${JSON.stringify(id)} type=${type}`);
        if (want) hits++;
      }
    }
    assert.ok(hits > 100, "the oracle must actually find charts");
  });

  it("does not re-slugify the tables once the index exists", async () => {
    const m = await load();
    m.__probe.now("warm-up-miss", "movie");
    const before = m.__count.slug;
    for (let i = 0; i < 20; i++) m.__probe.now("custom-list-" + i, "movie");
    assert.equal(m.__count.slug - before, 0, "a miss must be answered from the index with no slugifyServer calls");
  });
});
