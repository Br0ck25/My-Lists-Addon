import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, makeD1, makeKv, call, accountProof } from "./harness.mjs";
import { loadWorkerWithHooks } from "./perf-hooks.mjs";

// PERF-08 / PERF-07: a configured catalog row must not look the id up as a chart
// or collection first (an extra serial KV read plus a scan of every chart table).

const tt = (n) => "tt" + String(2000000 + n);
const customRow = (n) => ({
  id: `row${n}`,
  type: "movie",
  name: `Row ${n}`,
  url: "customlist:v1:" + JSON.stringify({
    listSlug: `row-${n}`,
    items: Array.from({ length: 3 }, (_, k) => ({ id: tt(n + k), title: `Film ${n + k}`, type: "movie" })),
  }),
});

async function setup() {
  const mod = await loadWorkerWithHooks(`
    export const __count = { slug: 0, find: 0 };
    { const s = slugifyServer; slugifyServer = (...a) => (__count.slug++, s(...a)); }
    { const f = findChartOrCollectionEntry; findChartOrCollectionEntry = (...a) => (__count.find++, f(...a)); }
  `);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, ...rest) => {
    const u = String(typeof input === "string" ? input : input?.url || input);
    if (/cinemeta|themoviedb\.org/i.test(u)) return new Response("{}", { status: 404 });
    return realFetch(input, ...rest);
  };
  const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
  const gets = [];
  const kvGet = env.CONFIGS.get.bind(env.CONFIGS);
  env.CONFIGS.get = (k, ...a) => (gets.push(String(k)), kvGet(k, ...a));
  return { mod, env, gets, restore: () => { globalThis.fetch = realFetch; } };
}

describe("PERF-08/07: configured rows skip the chart/collection pre-lookup", () => {
  it("a configured custom-list row reads no col_cat: key and never scans chart tables", async () => {
    const t = await setup();
    try {
      const proof = await accountProof(t.env, "perflookup");
      const saved = await call(t.env, "/api/save", { method: "POST", json: { ...proof, entries: [customRow(1), customRow(2)], dedupeAcrossLists: false, showBadgesStremio: false } });
      assert.equal(saved.body.ok, true);
      const id = saved.body.id;
      const worker = t.mod.default;
      t.gets.length = 0;
      t.mod.__count.slug = 0; t.mod.__count.find = 0;
      // Go through the isolated copy so the counters see the calls.
      const res = await worker.fetch(new Request(`https://example.com/${id}/catalog/movie/row1.json`), t.env, { waitUntil() {}, passThroughOnException() {} });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.metas.length > 0, "the row still serves its titles");
      assert.deepEqual(t.gets.filter((k) => k.startsWith("col_cat:")), [], "no col_cat: read for a configured row");
      assert.equal(t.mod.__count.find, 0, "findChartOrCollectionEntry is not called for a row the config contains");
      assert.equal(t.mod.__count.slug, 0, "no slugifyServer scan for a configured row");
    } finally { t.restore(); }
  });

  it("an unconfigured collection URL still serves its row from col_cat:", async () => {
    const t = await setup();
    try {
      const row = customRow(7);
      await t.env.CONFIGS.put(`col_cat:${row.id}:movie`, JSON.stringify({ id: row.id, type: "movie", name: row.name, url: row.url, enabled: true }));
      const res = await t.mod.default.fetch(new Request(`https://example.com/catalog/movie/${row.id}.json`), t.env, { waitUntil() {}, passThroughOnException() {} });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.metas.length > 0, "collection row served without a config");
      assert.ok(t.gets.some((k) => k === `col_cat:${row.id}:movie`));
    } finally { t.restore(); }
  });
});
