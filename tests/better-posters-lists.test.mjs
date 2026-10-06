import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

// The "Order Today tags" setting (betterPostersTodayOrder): titles Better
// Posters tags "#N Today" come out in that order, in installed catalogs
// (Stremio, Nuvio) and in the website's list previews.

const { accountProof, makeKv, makeD1, makeEnv, call } = await import("./harness.mjs");

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const item = (id, name, rank) => ({ id, type: "movie", name, releaseInfo: "2026", poster: `https://btttr.cc/poster/movie/${id}/x.png`, ...(rank ? { _rank: rank } : {}) });
// btttr.cc's daily ranking: One is #1 Today, Two #2, Three #3.
const TODAY = [item("tt1000001", "One", 1), item("tt1000002", "Two", 2), item("tt1000003", "Three", 3)];
function stubBtttr(status = 200) {
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (!/^https:\/\/btttr\.cc\/catalog\/(movie|series)\/tmdb-today(-shows)?\.json/.test(url)) return realFetch(input, init);
    return status === 200
      ? new Response(JSON.stringify({ metas: TODAY }), { status: 200, headers: { "content-type": "application/json" } })
      : new Response("down", { status });
  };
}

// A list that holds those titles out of order, with one the ranking does not
// know (Untagged) in the middle: Three, One, Untagged, Two.
const LIST = "customlist:v1:" + JSON.stringify({
  listSlug: "today-order",
  items: [
    { id: "tt1000003", title: "Three", year: "2026", type: "movie" },
    { id: "tt1000001", title: "One", year: "2026", type: "movie" },
    { id: "tt1000009", title: "Untagged", year: "2026", type: "movie" },
    { id: "tt1000002", title: "Two", year: "2026", type: "movie" },
  ],
});
const AS_GIVEN = ["Three", "One", "Untagged", "Two"];

async function installedNames(extra) {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
  const saved = await call(env, "/api/save", { method: "POST", json: {
    ...(await accountProof(env)),
    entries: [{ id: "today-order", type: "movie", name: "Today order", url: LIST }],
    showBadgesStremio: false,
    ...extra,
  } });
  assert.equal(saved.body.ok, true, JSON.stringify(saved.body));
  const r = await call(env, `/${saved.body.id}/catalog/movie/today-order.json`);
  assert.equal(r.status, 200);
  return r.body.metas.map((m) => m.name);
}

async function previewNames(todayOrder) {
  const env = makeEnv({ CONFIGS: makeKv() });
  const r = await call(env, "/api/preview", { method: "POST", json: { url: LIST, type: "movie", sample: 50, ...(todayOrder === undefined ? {} : { todayOrder }) } });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  return r.body.sample.map((m) => m.name);
}

// First on purpose: the ranking is also kept in memory for the life of the
// process, so once any test has read it, "btttr.cc is down" would be answered
// from that copy (which is the right behaviour, and not what this checks).
describe("Order Today tags when btttr.cc is down", () => {
  it("leaves the list as it was when the ranking cannot be read", async () => {
    stubBtttr(503);
    assert.deepEqual(await installedNames({ betterPosters: true, betterPostersTodayOrder: true }), AS_GIVEN);
  });
});

describe("Order Today tags in an installed catalog (Stremio, Nuvio)", () => {
  it("is off by default and leaves the list as it was given", async () => {
    stubBtttr();
    assert.deepEqual(await installedNames({ betterPosters: true }), AS_GIVEN);
  });

  it("puts #1, #2, #3 Today in order and leaves everything else where it was", async () => {
    stubBtttr();
    assert.deepEqual(await installedNames({ betterPosters: true, betterPostersTodayOrder: true }), ["One", "Two", "Untagged", "Three"]);
  });

  it("does nothing with Better Posters off, or with Trend tags off", async () => {
    stubBtttr();
    assert.deepEqual(await installedNames({ betterPostersTodayOrder: true }), AS_GIVEN);
    assert.deepEqual(await installedNames({ betterPosters: true, betterPostersTrendTags: false, betterPostersTodayOrder: true }), AS_GIVEN);
  });
});

describe("Order Today tags in the website's list previews", () => {
  it("orders a preview when the page asks for it, and not otherwise", async () => {
    stubBtttr();
    assert.deepEqual(await previewNames(true), ["One", "Two", "Untagged", "Three"]);
    assert.deepEqual(await previewNames(false), AS_GIVEN);
    assert.deepEqual(await previewNames(), AS_GIVEN);
  });
});

describe("Order Today tags setting in the page", () => {
  it("is shown in Settings", async () => {
    const html = (await call(makeEnv({ CONFIGS: makeKv() }), "/")).text;
    assert.match(html, /id="betterPostersTodayOrderCheckbox"/);
    assert.match(html, /Order Today tags/);
  });
});
