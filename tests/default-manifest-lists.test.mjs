// The bare /manifest.json (no install link) used to be an empty addon. The admin
// can now curate the lists it shows: they are saved in /admin, advertised by
// the bare manifest, and their rows load with no install config, the same way a
// chart row does. A browser opening the link sees the JSON, not a redirect.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeEnv, makeD1, makeKv, call, realFetch } from "./harness.mjs";

const KEY = "default-manifest-admin";

async function adminCookie(env) {
  const res = await call(env, "/admin/login", { method: "POST", form: { key: KEY }, ip: "203.0.113.9" });
  assert.equal(res.status, 302);
  return (res.headers.get("set-cookie") || "").match(/^(mla_admin=[^;]+)/)[1];
}

const newEnv = () => makeEnv({ DB: makeD1(), CONFIGS: makeKv(), ADMIN_KEY: KEY, TMDB_API_KEY: "k" });
const curated = (body) => (body.catalogs || []).filter((c) => !/^search_/.test(c.id));

const LISTS = [
  { name: "Popular Movies", type: "movie", url: "tmdb:chart:popular" },
  { name: "Popular Shows", type: "series", url: "tmdb:chart:popular" },
];

describe("default manifest lists", () => {
  it("shows no lists until the admin saves some", async () => {
    const env = newEnv();
    const r = await call(env, "/manifest.json");
    assert.equal(r.status, 200);
    assert.deepEqual(curated(r.body), []);
  });

  it("advertises the saved lists, in the saved order, with their names and types", async () => {
    const env = newEnv();
    const cookie = await adminCookie(env);
    const save = await call(env, "/admin/api/default-manifest", { method: "POST", cookie, json: { lists: LISTS } });
    assert.equal(save.status, 200, save.text);
    const r = await call(env, "/manifest.json");
    const rows = curated(r.body);
    assert.deepEqual(rows.map((c) => [c.name, c.type]), [["Popular Movies", "movie"], ["Popular Shows", "series"]]);
    for (const c of rows) assert.ok(c.id && !/[\/\s]/.test(c.id), `id ${c.id} is safe in a URL path`);
  });

  it("serves each advertised row with no install config", async () => {
    const env = newEnv();
    const cookie = await adminCookie(env);
    await call(env, "/admin/api/default-manifest", { method: "POST", cookie, json: { lists: LISTS } });
    const asked = [];
    globalThis.fetch = async (u) => {
      const href = typeof u === "string" ? u : u.url;
      asked.push(String(href));
      return new Response(JSON.stringify({ results: [{ id: 603, title: "The Matrix", release_date: "1999-03-31", poster_path: "/p.jpg" }], total_pages: 1 }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const id = curated((await call(env, "/manifest.json")).body)[0].id;
      const row = await call(env, `/catalog/movie/${id}.json`);
      assert.equal(row.status, 200, row.text);
      assert.ok(asked.some((u) => /themoviedb\.org\/3\/movie\/popular/.test(u)), "the row's own source was read: " + asked.join(" "));
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("a browser opening the link gets the JSON, not a redirect", async () => {
    const env = newEnv();
    const r = await call(env, "/manifest.json", { headers: { "Sec-Fetch-Mode": "navigate", Accept: "text/html" } });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.catalogs));
  });

  it("only an admin can save, and a bad row is refused without changing what is saved", async () => {
    const env = newEnv();
    const stranger = await call(env, "/admin/api/default-manifest", { method: "POST", json: { lists: LISTS } });
    assert.equal(stranger.status, 401);
    const cookie = await adminCookie(env);
    await call(env, "/admin/api/default-manifest", { method: "POST", cookie, json: { lists: LISTS } });
    for (const bad of [
      [{ name: "", type: "movie", url: "tmdb:chart:popular" }],
      [{ name: "X", type: "episode", url: "tmdb:chart:popular" }],
      [{ name: "X", type: "movie", url: "" }],
    ]) {
      const r = await call(env, "/admin/api/default-manifest", { method: "POST", cookie, json: { lists: bad } });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.equal(curated((await call(env, "/manifest.json")).body).length, 2);
  });

  it("two lists with the same name and type get different ids", async () => {
    const env = newEnv();
    const cookie = await adminCookie(env);
    const dup = { name: "Same", type: "movie", url: "tmdb:chart:popular" };
    await call(env, "/admin/api/default-manifest", { method: "POST", cookie, json: { lists: [dup, { ...dup, url: "tmdb:chart:trending" }] } });
    const ids = curated((await call(env, "/manifest.json")).body).map((c) => c.id);
    assert.equal(new Set(ids).size, 2);
  });
});

// The picker also searches what Quick Add and Discover offer: charts, genres,
// kids and holiday shelves, streaming services and their rows.
describe("default manifest: searching Quick Add and Discover", () => {
  const search = (env, cookie, q) => call(env, "/admin/api/default-manifest/catalog?q=" + encodeURIComponent(q), { cookie });

  it("only an admin can search it", async () => {
    const r = await call(newEnv(), "/admin/api/default-manifest/catalog?q=horror");
    assert.equal(r.status, 401);
  });

  it("finds a genre shelf and says it holds both movies and series", async () => {
    const env = newEnv();
    const cookie = await adminCookie(env);
    const r = await search(env, cookie, "horror");
    assert.equal(r.status, 200, r.text);
    const hit = r.body.lists.find((l) => l.movieUrl === "tmdb:genre:horror");
    assert.ok(hit, "the Horror genre shelf is found");
    assert.equal(hit.type, "mixed");
    assert.equal(hit.showUrl, "tmdb:genre:horror");
    assert.ok(hit.group, "it says where it came from");
  });

  it("keeps a chart's different movie and series sources apart", async () => {
    const env = newEnv();
    const cookie = await adminCookie(env);
    const r = await search(env, cookie, "mdblist popular");
    const hit = r.body.lists.find((l) => /mdblist\.com\/lists\/official\/movies\/popular/.test(l.movieUrl));
    assert.ok(hit);
    assert.match(hit.showUrl, /mdblist\.com\/lists\/official\/shows\/popular/);
  });

  it("finds a streaming service's own rows, and a movie-only chart is typed movie", async () => {
    const env = newEnv();
    const cookie = await adminCookie(env);
    const rows = (await search(env, cookie, "netflix")).body.lists;
    assert.ok(rows.length > 3, "Netflix has its service and its rows");
    assert.ok(rows.every((l) => /netflix/i.test(l.name + " " + l.group)));
    const box = (await search(env, cookie, "box office")).body.lists.find((l) => l.movieUrl === "trakt:chart:box_office");
    assert.ok(box);
    assert.equal(box.type, "movie");
    assert.equal(box.showUrl, "");
  });

  it("every word has to match, an empty search finds nothing, and results are capped", async () => {
    const env = newEnv();
    const cookie = await adminCookie(env);
    assert.deepEqual((await search(env, cookie, "")).body.lists, []);
    assert.deepEqual((await search(env, cookie, "horror zzzzqqq")).body.lists, []);
    assert.ok((await search(env, cookie, "e")).body.lists.length <= 60);
  });

  it("a found shelf, saved, loads on the bare manifest with no install link", async () => {
    const env = newEnv();
    const cookie = await adminCookie(env);
    const hit = (await search(env, cookie, "horror")).body.lists.find((l) => l.movieUrl === "tmdb:genre:horror");
    await call(env, "/admin/api/default-manifest", { method: "POST", cookie, json: { lists: [{ type: "movie", name: hit.name, url: hit.movieUrl }] } });
    const asked = [];
    globalThis.fetch = async (u) => {
      asked.push(String(typeof u === "string" ? u : u.url));
      return new Response(JSON.stringify({ results: [{ id: 603, title: "Alien", release_date: "1979-05-25", poster_path: "/p.jpg" }], total_pages: 1 }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const id = curated((await call(env, "/manifest.json")).body)[0].id;
      const row = await call(env, `/catalog/movie/${id}.json`);
      assert.equal(row.status, 200, row.text);
      assert.ok(asked.some((u) => /themoviedb\.org\/3\/discover\/movie/.test(u)), "the genre's own source was read: " + asked.join(" "));
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
