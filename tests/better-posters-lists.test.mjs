import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

// Better Posters lists (mylists:better-posters:today|trending|popular|top,
// read from btttr.cc's public catalogs) and the "Order Today tags" setting
// (betterPostersTodayOrder).

const { makeKv, makeEnv, call } = await import("./harness.mjs");

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const item = (id, name, rank) => ({ id, type: "movie", name, releaseInfo: "2026", poster: `https://btttr.cc/poster/movie/${id}/x.png`, ...(rank ? { _rank: rank } : {}) });

// What btttr.cc answers, by catalog id. Trending lists the Today titles out of
// order (#3, #1, an untagged one, #2).
const CATALOGS = {
  "tmdb-today": [item("tt1000001", "One", 1), item("tt1000002", "Two", 2), item("tt1000003", "Three", 3)],
  "trakt-popular": [item("tt1000004", "Popular One")],
  "trakt-trending": [item("tt1000003", "Three"), item("tt1000001", "One"), item("tt1000009", "Untagged"), item("tt1000002", "Two")],
};
let hits;
function stubBtttr() {
  hits = [];
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const m = /^https:\/\/btttr\.cc\/catalog\/(?:movie|series)\/([a-z-]+)\.json/.exec(url);
    if (!m) return realFetch(input, init);
    hits.push(m[1]);
    return new Response(JSON.stringify({ metas: CATALOGS[m[1]] || [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

async function preview(env, url, type = "movie") {
  const r = await call(env, "/api/preview", { method: "POST", json: { url, type, sample: 50 } });
  assert.equal(r.body.ok, true, r.body.error);
  return r.body;
}

async function names(kv, env, cfgId, extra) {
  await kv.put(cfgId, JSON.stringify({
    entries: [{ id: "bp-trending", type: "movie", name: "Trending", url: "mylists:better-posters:trending" }],
    ...extra,
  }));
  const r = await call(env, `/${cfgId}/catalog/movie/bp-trending.json`);
  assert.equal(r.status, 200);
  return r.body.metas.map((m) => m.name);
}

// First on purpose: the ranking is also kept in memory for the life of the
// process, so once any test has read it, "btttr.cc is down" would be answered
// from that copy (which is the right behaviour, and not what this checks).
describe("Order Today tags when btttr.cc is down", () => {
  it("leaves the list alone when btttr.cc's ranking cannot be read", async () => {
    stubBtttr();
    const inner = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("tmdb-today")) return new Response("down", { status: 503 });
      return inner(input, init);
    };
    const kv = makeKv();
    const env = makeEnv({ CONFIGS: kv });
    assert.deepEqual(
      await names(kv, env, "cfgdown", { betterPosters: true, betterPostersTodayOrder: true }),
      ["Three", "One", "Untagged", "Two"]
    );
  });

});

describe("Better Posters lists", () => {
  it("Top Today comes back in btttr.cc's rank order, with the plain poster", async () => {
    stubBtttr();
    const env = makeEnv({ CONFIGS: makeKv() });
    const body = await preview(env, "mylists:better-posters:today");
    assert.deepEqual(body.sample.map((m) => m.name), ["One", "Two", "Three"]);
    assert.equal(body.totalItems, 3);
    assert.equal(body.sample[0].poster, "https://images.metahub.space/poster/medium/tt1000001/img");
  });

  it("keeps a half hour of btttr.cc's answer instead of asking again", async () => {
    stubBtttr();
    const env = makeEnv({ CONFIGS: makeKv() });
    await preview(env, "mylists:better-posters:popular");
    await preview(env, "mylists:better-posters:popular");
    assert.equal(hits.filter((h) => h === "trakt-popular").length, 1);
  });

  it("refuses an unknown list", async () => {
    stubBtttr();
    const env = makeEnv({ CONFIGS: makeKv() });
    const r = await call(env, "/api/preview", { method: "POST", json: { url: "mylists:better-posters:nope", type: "movie", sample: 5 } });
    assert.notEqual(r.body.ok, true);
  });

  it("is in Quick Add and Discover, and has a shareable page", async () => {
    const env = makeEnv({});
    const html = (await call(env, "/")).text;
    assert.match(html, /<h2 class="shelf-title">Better Posters<\/h2>/);
    assert.match(html, /data-add-all-action="better-posters-charts"/);
    for (const url of ["mylists:better-posters:today", "mylists:better-posters:trending", "mylists:better-posters:popular", "mylists:better-posters:top"]) {
      assert.ok(html.includes(`&quot;${url}&quot;,&quot;movie&quot;,true`) && html.includes(`&quot;${url}&quot;,&quot;series&quot;,true`), `missing buttons for ${url}`);
    }
    assert.ok(html.includes("&quot;tmdb:chart:now_playing&quot;,&quot;movie&quot;,true"), "In Cinema (movies) missing");
    const m = html.match(/window\._CHARTS_BETTER_POSTERS = (\[.*?\]);/);
    assert.ok(m, "Discover table missing");
    assert.deepEqual(JSON.parse(m[1]).map((c) => c.name), [
      "Better Posters Top Today", "Better Posters Trending", "Better Posters Popular", "Better Posters Top Rated", "Better Posters In Cinema",
      "Better Posters New Movie", "Better Posters New Series", "Better Posters Just Added", "Better Posters Returning", "Better Posters Limited Series",
    ]);
    assert.ok(html.includes("&quot;tmdb:chart:returning&quot;,&quot;series&quot;,true"), "Returning (shows) missing");
    assert.ok(html.includes("&quot;tmdb:new-on-streaming&quot;,&quot;movie&quot;,true") && html.includes("&quot;Better Posters Just Added&quot;"), "Just Added missing");
    assert.equal(html.includes("&quot;tmdb:chart:returning&quot;,&quot;movie&quot;"), false, "Returning has no movies side");
    const page = await call(env, "/lists/Better-Posters-Top-Today");
    assert.equal(page.status, 200);
  });
});

describe("Returning and Limited Series use TMDB's own filters", () => {
  it("asks TMDB for Returning Series and Miniseries, shows only", async () => {
    const asked = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith("https://api.themoviedb.org/3/discover/tv")) { asked.push(url); return new Response(JSON.stringify({ results: [], total_results: 0 }), { status: 200 }); }
      return real(input, init);
    };
    const env = makeEnv({ CONFIGS: makeKv(), TMDB_API_KEY: "k" });
    await call(env, "/api/preview", { method: "POST", json: { url: "tmdb:chart:returning", type: "series", sample: 5 } });
    await call(env, "/api/preview", { method: "POST", json: { url: "tmdb:chart:limited", type: "series", sample: 5 } });
    assert.ok(asked.some((u) => u.includes("with_status=0")), asked.join("\n"));
    assert.ok(asked.some((u) => u.includes("with_type=2")), asked.join("\n"));
    const movies = await call(env, "/api/preview", { method: "POST", json: { url: "tmdb:chart:returning", type: "movie", sample: 5 } });
    assert.notEqual(movies.body.ok, true);
  });
});

describe("Order Today tags", () => {
  it("is off by default and leaves the list as btttr.cc gave it", async () => {
    stubBtttr();
    const kv = makeKv();
    const env = makeEnv({ CONFIGS: kv });
    assert.deepEqual(await names(kv, env, "cfgoff", { betterPosters: true }), ["Three", "One", "Untagged", "Two"]);
  });

  it("puts #1, #2, #3 Today in order and leaves everything else where it was", async () => {
    stubBtttr();
    const kv = makeKv();
    const env = makeEnv({ CONFIGS: kv });
    assert.deepEqual(
      await names(kv, env, "cfgon", { betterPosters: true, betterPostersTodayOrder: true }),
      ["One", "Two", "Untagged", "Three"]
    );
  });

  it("does nothing with Better Posters off, or with Trend tags off", async () => {
    stubBtttr();
    const kv = makeKv();
    const env = makeEnv({ CONFIGS: kv });
    const asGiven = ["Three", "One", "Untagged", "Two"];
    assert.deepEqual(await names(kv, env, "cfgnobp", { betterPostersTodayOrder: true }), asGiven);
    assert.deepEqual(await names(kv, env, "cfgnotag", { betterPosters: true, betterPostersTrendTags: false, betterPostersTodayOrder: true }), asGiven);
  });

  it("is saved with the install link and shown in Settings", async () => {
    const env = makeEnv({ CONFIGS: makeKv() });
    const html = (await call(env, "/")).text;
    assert.match(html, /id="betterPostersTodayOrderCheckbox"/);
    assert.match(html, /Order Today tags/);
  });
});
