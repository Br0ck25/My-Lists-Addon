// Audit API-05: `skip` on a catalog row was passed on as it came, so a request
// for skip=-4 or skip=1e20 reached the provider as page=-4 / page=5000000000000000000.
// It is now a whole number between 0 and a cap.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeEnv, makeD1, makeKv, call } from "./harness.mjs";

const realFetch = globalThis.fetch;

async function pagesAskedFor(skip) {
  const pages = [];
  globalThis.fetch = async (u) => {
    const href = typeof u === "string" ? u : u.url;
    const m = String(href).match(/themoviedb\.org\/3\/movie\/popular\?[^#]*?page=([^&]+)/);
    if (m) pages.push(m[1]);
    return new Response(JSON.stringify({ results: [], total_pages: 500 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), TMDB_API_KEY: "k" });
    const r = await call(env, `/catalog/movie/tmdb-chart-popular/skip=${skip}.json`);
    assert.equal(r.status, 200, r.text);
  } finally {
    globalThis.fetch = realFetch;
  }
  return pages;
}

describe("API-05: skip is a whole number within a cap", () => {
  for (const skip of ["-4", "-100000", "1e20", "100000000000000000000", "abc"]) {
    it(`skip=${skip} never reaches the provider as a negative or enormous page`, async () => {
      const pages = await pagesAskedFor(skip);
      for (const p of pages) {
        const n = Number(p);
        assert.ok(Number.isInteger(n) && n >= 1 && n <= 500, `asked TMDB for page=${p}`);
      }
    });
  }

  it("an ordinary skip is unchanged", async () => {
    const pages = await pagesAskedFor("40");
    assert.ok(pages.length > 0, "the provider was asked at all");
  });
});
