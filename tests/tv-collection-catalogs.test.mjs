import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadWorkerWithHooks } from "./perf-hooks.mjs";

// The TV launcher's Studios and Franchises collections name their lists tmdb-studio-<id> and tmdb-collection-<id>.
// Those ids used to return an empty list, so every Studios and Franchises tile opened to nothing.

async function load() {
  return loadWorkerWithHooks(`
    export const __probe = {
      find: (id, type) => findChartOrCollectionEntry(id, type),
      async studioUrls(id) {
        const seen = [];
        const real = globalThis.fetch;
        globalThis.fetch = async (u) => { seen.push(String(u)); return new Response(JSON.stringify({ results: [], total_pages: 1, total_results: 0 }), { status: 200, headers: { "content-type": "application/json" } }); };
        try { await fetchTmdbGenre({ type: "movie", url: "tmdb:genre:studio-" + id }, 0, "key", "studio-" + id, "US"); } finally { globalThis.fetch = real; }
        return seen;
      },
    };
  `);
}

describe("TV collections: studio and franchise catalogs", () => {
  it("a studio id becomes a genre-style list filtered by that company", async () => {
    const m = await load();
    const e = m.__probe.find("tmdb-studio-420", "movie");
    assert.equal(e.url, "tmdb:genre:studio-420");
    assert.equal(e.type, "movie");
  });

  it("a franchise id becomes the TMDB collection list", async () => {
    const m = await load();
    const e = m.__probe.find("tmdb-collection-86311", "movie");
    assert.equal(e.url, "tmdb:collection:86311");
  });

  it("ids that are not numbers are not claimed", async () => {
    const m = await load();
    assert.ok(!m.__probe.find("tmdb-studio-abc", "movie"));
    assert.ok(!m.__probe.find("tmdb-collection-", "movie"));
  });

  it("the studio list asks TMDB for that company's films", async () => {
    const m = await load();
    const urls = await m.__probe.studioUrls("420");
    assert.ok(urls.some((u) => u.includes("discover/movie") && u.includes("with_companies=420")), JSON.stringify(urls));
  });
});
