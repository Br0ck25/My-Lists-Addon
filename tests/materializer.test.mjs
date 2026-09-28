// P5-11: with FF_MATERIALIZER and "remove duplicates across lists", a home
// screen's rows are built once per install and de-duplicated in one pass.
// Rows are self-contained custom lists, so no provider is involved.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { freshIsolate, makeEnv, makeKv, makeD1, call, accountProof, nextIp } from "./harness.mjs";

// Row n holds titles n .. n+9: each overlaps the rows around it.
const ROWS = 20;
const tt = (n) => "tt" + String(1000000 + n);
const entries = Array.from({ length: ROWS }, (_, n) => ({
  id: `row${n}`,
  type: "movie",
  name: `Row ${n}`,
  url: "customlist:v1:" + JSON.stringify({ listSlug: `row-${n}`, items: Array.from({ length: 10 }, (_, k) => ({ id: tt(n + k), title: `Film ${n + k}`, type: "movie" })) }),
}));

async function get(w, env, path) {
  const pending = [];
  const ctx = { waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})); } };
  const res = await w.fetch(new Request("https://example.test" + path, { headers: { "CF-Connecting-IP": nextIp() } }), env, ctx);
  await Promise.all(pending);
  return res.json();
}

async function install(env, rows = entries) {
  const saved = await call(env, "/api/save", { method: "POST", json: { ...(await accountProof(env)), entries: rows, dedupeAcrossLists: true, showBadgesStremio: false } });
  assert.equal(saved.body.ok, true, JSON.stringify(saved.body));
  return saved.body.id;
}

async function homeScreen(w, env, id, rows = entries) {
  const out = [];
  for (const e of rows) out.push((await get(w, env, `/${id}/catalog/movie/${e.id}.json`)).metas.map((m) => m.id));
  return out;
}

describe("P5-11: the materializer", () => {
  it("serves the same rows as before, from one build of 20 rows instead of one per row", async () => {
    const points = [];
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1(), ANALYTICS: { writeDataPoint: (p) => points.push(p) } });
    const id = await install(env);

    const before = await homeScreen(await freshIsolate(), env, id);
    // Row 0 whole; every later row only its one new title.
    assert.deepEqual(before[0], Array.from({ length: 10 }, (_, k) => tt(k)));
    assert.deepEqual(before[5], [tt(14)]);

    env.FF_MATERIALIZER = "1";
    const w = await freshIsolate();
    const after = await homeScreen(w, env, id);
    assert.deepEqual(after, before);
    const builds = points.filter((p) => p.indexes && p.indexes[0] === "materializer");
    assert.equal(builds.length, 1, "one build for the whole home screen");
    assert.equal(builds[0].doubles[0], ROWS, "no more than one build per row");

    // Another isolate within the hour reads the stored copy: no build.
    await homeScreen(await freshIsolate(), env, id);
    assert.equal(points.filter((p) => p.indexes && p.indexes[0] === "materializer").length, 1);
    assert.equal([...env.CONFIGS._store.keys()].filter((k) => k.startsWith("snap:mat:")).length, 1);
  });

  it("a changed install is a new build; pages after the first and a switched-off flag take the usual path", async () => {
    const points = [];
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1(), FF_MATERIALIZER: "1", ANALYTICS: { writeDataPoint: (p) => points.push(p) } });
    const id = await install(env);
    const w = await freshIsolate();
    await homeScreen(w, env, id, entries.slice(0, 3));
    const fewer = entries.slice(0, 3).reverse();
    const id2 = await install(env, fewer);
    const reordered = await homeScreen(w, env, id2, fewer);
    assert.deepEqual(reordered[0], Array.from({ length: 10 }, (_, k) => tt(2 + k)), "the first row now is row 2, whole");
    assert.equal(points.filter((p) => p.indexes && p.indexes[0] === "materializer").length, 2);

    const page2 = await get(w, env, `/${id}/catalog/movie/row1/skip=100.json`);
    assert.deepEqual(page2.metas, []);
  });

  it("carries each title's media_id where the media table knows it", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1(), FF_MATERIALIZER: "1" });
    env.DB._db.prepare("INSERT INTO media (id, kind, imdb_id, title, created_at, updated_at) VALUES (42, 'movie', ?, 'Film 0', 0, 0)").run(tt(0));
    const id = await install(env);
    const row = await get(await freshIsolate(), env, `/${id}/catalog/movie/row0.json`);
    assert.equal(row.metas[0].media_id, 42);
    assert.equal(row.metas[1].media_id, undefined);
  });
});
