// Phase 4, P4-5: provider contract fixtures.
//
// Each fixture in tests/fixtures/providers/ is one provider answer the Worker
// reads, with the fields it depends on listed under `required` (see
// provider_live_check.mjs for the path syntax). This file checks:
//   * each fixture is well-formed and keeps its own contract;
//   * every provider the Worker calls has fixtures;
//   * the real fetchers turn the fixtures into rows Stremio can use;
//   * the path checker itself.
// The nightly workflow (.github/workflows/provider-live-check.yml) checks the
// same `required` lists against the live APIs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { call, freshIsolate, makeEnv, nextIp } from "./harness.mjs";
import { checkRequired, loadFixtures, LIVE_SECRETS, pickPath, runLiveCheck } from "../provider_live_check.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = loadFixtures();
const byFile = new Map(FIXTURES.map((fx) => [fx.file, fx]));
const fixture = (file) => {
  const fx = byFile.get(file);
  assert.ok(fx, `no fixture ${file}`);
  return fx;
};

function loadSourceFunctions(...relFiles) {
  const sandbox = {
    console, URL, URLSearchParams, atob, btoa, Uint8Array, TextDecoder, TextEncoder,
    Response, Headers, Request, setTimeout, clearTimeout,
    crypto: globalThis.crypto,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const relFile of relFiles) {
    vm.runInContext(fs.readFileSync(path.join(REPO_ROOT, relFile), "utf8"), sandbox, { filename: relFile });
  }
  return sandbox;
}

const registry = loadSourceFunctions("00_constants.js", "04_config-resolution.js");
const ADAPTERS = vm.runInContext("PROVIDER_ADAPTERS", registry);
const SERVER_SOURCES = fs.readdirSync(REPO_ROOT)
  .filter((f) => /^\d\d_.*\.js$/.test(f) && !/^(09|1\d|2[0-4])_/.test(f))
  .map((f) => fs.readFileSync(path.join(REPO_ROOT, f), "utf8"))
  .join("\n");

// Serves every provider request from the fixtures, the way the fetchers ask.
// A detail lookup answers for the id it was asked about, with an IMDb id made
// from it, so every title in a page is a different title.
function fixtureRouter() {
  const used = new Set();
  const calls = [];
  const answer = (file, body) => {
    const fx = fixture(file);
    used.add(file);
    return new Response(JSON.stringify(body === undefined ? fx.response : body), {
      status: 200,
      headers: { "content-type": "application/json", ...(fx.headers || {}) },
    });
  };
  const handler = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const p = url.pathname;
    calls.push(url.hostname + p);
    let m;
    switch (url.hostname) {
      case "api.themoviedb.org": {
        if ((m = /^\/3\/(movie|tv)\/(\d+)$/.exec(p))) {
          const file = m[1] === "tv" ? "tmdb/tv-details.json" : "tmdb/movie-details.json";
          const id = Number(m[2]);
          const imdb = "tt" + String(9000000 + id);
          const body = { ...fixture(file).response, id, imdb_id: imdb };
          body.external_ids = { ...body.external_ids, imdb_id: imdb };
          return answer(file, body);
        }
        if (p.startsWith("/3/find/")) return answer("tmdb/find.json");
        if (p.startsWith("/3/collection/")) return answer("tmdb/collection.json");
        if (p.startsWith("/4/list/")) return answer("tmdb/list-v4.json");
        if (/\/tv(\/|$)/.test(p)) return answer("tmdb/chart-tv.json");
        return answer("tmdb/chart-movies.json");
      }
      case "api.trakt.tv":
        if (/\/lists\/[^/]+\/items/.test(p)) return answer("trakt/list-items.json");
        if (/^\/(movies|shows)\/popular/.test(p)) return answer("trakt/shows-popular.json");
        return answer("trakt/movies-trending.json");
      case "mdblist.com":
        return answer("mdblist/list-json.json");
      case "api.mdblist.com":
        if (p.startsWith("/lists/top")) return answer("mdblist/top-lists.json");
        break;
      case "data.simkl.in":
        return answer(p.includes("/tv/") ? "simkl/trending-tv.json" : "simkl/trending-movies.json");
      case "api.tvmaze.com":
        if (p.startsWith("/episodes/")) return answer("tvmaze/episode.json");
        return answer("tvmaze/lookup-show.json", {
          ...fixture("tvmaze/lookup-show.json").response,
          _links: { self: { href: "https://api.tvmaze.com/shows/82" }, nextepisode: { href: "https://api.tvmaze.com/episodes/2939710" } },
        });
      case "v3-cinemeta.strem.io":
        return answer("cinemeta/series-meta.json");
      case "apis.justwatch.com":
        return answer("justwatch/new-titles.json");
      case "streaming-availability.p.rapidapi.com":
        return answer("rapidapi/changes.json");
      default:
        break;
    }
    return new Response("not a fixture", { status: 404 });
  };
  return { used, calls, handler };
}

async function preview(w, env, source, type) {
  const pending = [];
  const ctx = { waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})); } };
  const q = new URLSearchParams({ url: source, type, sample: "100" });
  const res = await w.fetch(new Request("https://example.test/api/preview?" + q, { headers: { "CF-Connecting-IP": nextIp() } }), env, ctx);
  await Promise.all(pending);
  return res.json();
}

describe("P4-5: provider contract fixtures", () => {
  it("every fixture is well-formed and keeps its own contract", () => {
    assert.ok(FIXTURES.length >= 15);
    for (const fx of FIXTURES) {
      const adapter = ADAPTERS[fx.provider];
      assert.ok(adapter, `${fx.file}: ${fx.provider} is not a provider adapter`);
      assert.equal(fx.file.split("/")[0], fx.provider, `${fx.file} sits under its provider's folder`);
      assert.ok(typeof fx.endpoint === "string" && fx.endpoint, `${fx.file}: endpoint`);
      assert.ok(typeof fx.origin === "string" && fx.origin, `${fx.file}: say where it came from`);
      assert.ok(Array.isArray(fx.required) && fx.required.length, `${fx.file}: required`);
      assert.ok(fx.response !== undefined, `${fx.file}: response`);
      assert.ok(Array.isArray(fx.usedBy) && fx.usedBy.length, `${fx.file}: usedBy`);
      for (const fn of fx.usedBy) {
        assert.ok(new RegExp(`function ${fn}\\(`).test(SERVER_SOURCES), `${fx.file}: usedBy names ${fn}, which does not exist`);
      }
      assert.deepEqual(checkRequired(fx.response, fx.required), [], `${fx.file} breaks its own contract`);
      // The live request goes to this provider, and names only known secrets.
      const live = fx.live;
      assert.ok(live && live.request && live.request.url, `${fx.file}: live.request`);
      for (const spec of [live.request, live.discover].filter(Boolean)) {
        const host = new URL(spec.url.replace(/\{[A-Z_]+\}/g, "x")).hostname;
        assert.ok(adapter.hosts.includes(host), `${fx.file}: ${host} is not one of ${fx.provider}'s hosts`);
        assert.ok(spec.url.startsWith("https://"), `${fx.file}: https only`);
      }
      for (const n of live.needs || []) assert.ok(LIVE_SECRETS.includes(n), `${fx.file}: unknown secret ${n}`);
      for (const n of LIVE_SECRETS) {
        if (JSON.stringify(live).includes(`{${n}}`)) assert.ok((live.needs || []).includes(n), `${fx.file} uses ${n} without needing it`);
      }
    }
  });

  it("every provider the Worker calls has fixtures", () => {
    const have = new Set(FIXTURES.map((fx) => fx.provider));
    const exempt = {
      letterboxd: "import only: Letterboxd has no API; its files are read in the browser",
      mylists: "this site's own storage, no provider",
    };
    for (const id of Object.keys(ADAPTERS)) {
      if (exempt[id]) continue;
      assert.ok(have.has(id), `no fixture for ${id}`);
    }
  });

  it("the path checker says what is wrong, and where", () => {
    const v = { a: [{ id: 1, t: "x" }, { id: "2" }], e: [], n: null, obj: { k: 1 } };
    assert.deepEqual(checkRequired(v, ["a[].id", "a[*].t:string", "obj:object", "a:array"]), []);
    assert.match(checkRequired(v, ["a[].id:number"])[0], /item 1: a\[\]\.id is string, not number/);
    assert.match(checkRequired(v, ["a[].t"])[0], /item 1: a\[\]\.t is missing/);
    assert.match(checkRequired(v, ["e[*].id"])[0], /e is an empty list/);
    assert.match(checkRequired(v, ["n"])[0], /n is missing/);
    assert.match(checkRequired(v, ["a[*].zz"])[0], /no item passes/);
    assert.deepEqual(checkRequired(v, ["missing.x || a[*].t"]), [], "either side of || will do");
    assert.equal(checkRequired([{ x: 1 }], ["[].x:number", "[*].x"]).length, 0, "an answer that is a list");
    assert.equal(checkRequired({}, ["[]"]).length, 1);
    assert.equal(pickPath({ results: [{ id: 7 }] }, "results.0.id"), 7);
  });

  it("the live check reports a changed field, a failed request, and a missing key", async () => {
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (url) => {
        if (String(url).includes("tvmaze")) return Response.json({ id: 1, name: "X", schedule: { days: [] }, _links: { self: { href: "h" } }, webChannel: { name: "W" } });
        return new Response("down", { status: 404 });
      };
      const lines = [];
      const results = await runLiveCheck({
        env: {},
        fixtures: [fixture("tvmaze/lookup-show.json"), fixture("cinemeta/series-meta.json"), fixture("tmdb/find.json")],
        log: (l) => lines.push(l),
      });
      assert.deepEqual(results.map((r) => r.status), ["failed", "failed", "skipped"]);
      assert.match(results[0].detail, /schedule\.time is missing/);
      assert.match(results[1].detail, /HTTP 404/);
      assert.match(results[2].detail, /TMDB_API_KEY not set/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("never prints a key", async () => {
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response("no", { status: 404 });
      const results = await runLiveCheck({ env: { TMDB_API_KEY: "sekrit-key-123" }, fixtures: [fixture("tmdb/find.json")], log: () => {} });
      assert.equal(results[0].status, "failed");
      assert.ok(!results[0].detail.includes("sekrit-key-123"));
      assert.match(results[0].detail, /\*\*\*/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // The real Worker, every catalog source that reads a provider's shared
  // data, over the fixtures.
  it("the fetchers turn the fixtures into rows Stremio can use", async () => {
    const realFetch = globalThis.fetch;
    const router = fixtureRouter();
    try {
      globalThis.fetch = router.handler;
      const env = makeEnv({ TMDB_API_KEY: "k", TRAKT_CLIENT_ID: "t", SIMKL_CLIENT_ID: "s", MDBLIST_API_KEY: "m" });
      const w = await freshIsolate();
      const cases = [
        ["tmdb:chart:trending", "movie"], ["tmdb:chart:popular", "series"], ["tmdb:hidden-gems", "movie"],
        ["tmdb:kids:pg", "movie"], ["tmdb:genre:horror", "series"], ["tmdb:holiday:christmas", "movie"],
        ["tmdb:top10:netflix", "movie"], ["tmdb:collection:10", "movie"], ["https://www.themoviedb.org/list/28", "movie"],
        ["trakt:chart:trending", "movie"], ["trakt:chart:popular", "series"], ["https://trakt.tv/users/alice/lists/favourites", "movie"],
        ["https://mdblist.com/lists/linaspurinis/top-watched-movies-of-the-week", "movie"],
        ["simkl:chart:today", "movie"], ["simkl:chart:week", "series"],
      ];
      for (const [source, type] of cases) {
        const body = await preview(w, env, source, type);
        assert.equal(body.ok, true, `${source}: ${body.error}`);
        assert.ok(body.count > 0, `${source} came back empty`);
        for (const m of body.sample) {
          assert.match(m.id, /^(tt\d+|tmdb:\d+)$/, `${source}: id ${m.id}`);
          assert.ok(m.type === "movie" || m.type === "series", `${source}: type ${m.type}`);
          assert.ok(typeof m.name === "string" && m.name.trim(), `${source}: a name`);
          assert.ok(m.poster === undefined || /^https:\/\//.test(m.poster), `${source}: poster ${m.poster}`);
        }
      }
      for (const file of ["tmdb/chart-movies.json", "tmdb/chart-tv.json", "tmdb/movie-details.json", "tmdb/tv-details.json", "tmdb/collection.json",
        "tmdb/list-v4.json", "trakt/movies-trending.json", "trakt/shows-popular.json", "trakt/list-items.json", "mdblist/list-json.json",
        "simkl/trending-movies.json", "simkl/trending-tv.json"]) {
        assert.ok(router.used.has(file), `${file} was never read by a catalog fetcher`);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // P4-2's acceptance test: with FF_CANONICAL_IDS on, no Stremio catalog row
  // emits an id outside tt... / tmdb:... / channel_... (the anime schemes aside,
  // see CATALOG_ALT_ID_SCHEMES; none of these providers sends one).
  it("every provider row in a Stremio catalog serves canonical ids", async () => {
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = fixtureRouter().handler;
      const env = makeEnv({ FF_CANONICAL_IDS: "1", TMDB_API_KEY: "k", TRAKT_CLIENT_ID: "t", SIMKL_CLIENT_ID: "s", MDBLIST_API_KEY: "m" });
      const rows = [
        ["tmdb:chart:trending", "movie"], ["tmdb:chart:popular", "series"], ["tmdb:genre:horror", "series"], ["tmdb:collection:10", "movie"],
        ["https://www.themoviedb.org/list/28", "movie"], ["trakt:chart:trending", "movie"], ["trakt:chart:popular", "series"],
        ["https://trakt.tv/users/alice/lists/favourites", "movie"], ["https://mdblist.com/lists/linaspurinis/top-watched-movies-of-the-week", "movie"],
        ["simkl:chart:today", "movie"], ["simkl:chart:week", "series"],
      ];
      const entries = rows.map(([url, type], i) => ({ id: "r" + i, type, name: "Row " + i, url }));
      const saved = await call(env, "/api/save", { method: "POST", json: { entries, showBadgesStremio: false } });
      assert.equal(saved.body.ok, true, JSON.stringify(saved.body));
      for (const e of entries) {
        const res = await call(env, `/${saved.body.id}/catalog/${e.type}/${e.id}.json`);
        const metas = res.body.metas || [];
        assert.ok(metas.length > 0, `${e.url} served nothing`);
        for (const m of metas) assert.match(m.id, /^(tt\d+|tmdb:\d+|channel_.+)$/, `${e.url}: ${m.id}`);
        assert.equal(new Set(metas.map((m) => m.id)).size, metas.length, `${e.url}: no id twice`);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("Trakt's page count survives from its headers", async () => {
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = fixtureRouter().handler;
      const env = makeEnv({ TRAKT_CLIENT_ID: "t" });
      const body = await preview(await freshIsolate(), env, "trakt:chart:trending", "movie");
      assert.equal(body.totalItems, 303);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // The providers no catalog row reads directly, through the functions that
  // read them.
  describe("the other providers", () => {
    function sandboxWithFixtures() {
      const sb = loadSourceFunctions("00_constants.js", "02_http-and-creator-utils.js", "04_config-resolution.js", "07_source-fetchers-tmdb-simkl.js");
      const router = fixtureRouter();
      // After loading: 02_'s own fetch guard would otherwise call itself here.
      sb.fetch = router.handler;
      return { sb, router };
    }
    function fakeDb() {
      return { prepare: (sql) => ({ bind: (...args) => ({ sql, args }) }) };
    }

    it("TVmaze: a show's slot, zone and next episode", async () => {
      const { sb, router } = sandboxWithFixtures();
      const out = await sb.fetchShowAirTimeUncached("tt0944947");
      const show = fixture("tvmaze/lookup-show.json").response;
      assert.equal(out.time, show.schedule.time);
      assert.equal(out.timezone, show.network.country.timezone);
      assert.ok(out.label, "a label to show");
      assert.deepEqual(Array.from(out.days), show.schedule.days);
      const ep = fixture("tvmaze/episode.json").response;
      assert.equal(out.next.season, ep.season);
      assert.equal(out.next.number, ep.number);
      assert.ok(router.used.has("tvmaze/episode.json"));
    });

    it("Cinemeta: a series' seasons and episodes", async () => {
      const { sb } = sandboxWithFixtures();
      const out = await sb.fetchCinemetaSeriesUnpacked("tt0944947");
      assert.deepEqual(Array.from(out.seasons, (s) => s.season_number), [1, 2]);
      assert.equal(out.episodesBySeason[1].length, 2);
      assert.ok(out.episodesBySeason[1][0].air_date);
      assert.equal(out.source, "cinemeta");
    });

    it("JustWatch: new titles become New on Streaming rows", async () => {
      const { sb } = sandboxWithFixtures();
      const nt = await sb.fetchJustWatchNewTitles({ country: "US", date: "2026-09-27", packages: ["nfx", "amp"] });
      const writes = [];
      const summary = { seen: 0, added: 0, bumped: 0 };
      sb.processJustWatchNewTitles(nt.edges, { env: { DB: fakeDb() }, region: "US", dayEpoch: 1790000000, startPosition: 0, nowSec: 1790100000, writes, summary, idCache: null });
      assert.equal(summary.seen, 4);
      assert.equal(writes.length, 4);
      const rows = writes.map((w) => ({ service: w.args[1], id: w.args[2], kind: w.args[4] }));
      for (const r of rows) {
        assert.match(r.id, /^(tt\d+|tmdb:\d+)$/);
        assert.ok(["netflix", "primevideo"].includes(r.service), r.service);
      }
      assert.deepEqual([...new Set(rows.map((r) => r.kind))].sort(), ["movie", "series"]);
    });

    it("RapidAPI: changes become New on Streaming rows", async () => {
      const { sb } = sandboxWithFixtures();
      const data = await sb.fetchRapidApiStreamingChanges({ apiKey: "r", country: "us", catalogs: "netflix.subscription" });
      const writes = [];
      const summary = { seen: 0 };
      sb.processRapidApiStreamingChanges(data, { env: { DB: fakeDb() }, region: "us", nowSec: 1790600000, writes, summary });
      assert.equal(summary.seen, 2);
      const ids = writes.map((w) => w.args.find((a) => typeof a === "string" && /^tt\d+$/.test(a)));
      assert.deepEqual(ids.sort(), ["tt0944947", "tt1375666"]);
    });

    it("MDBList: Popular Lists become list links", async () => {
      const { sb } = sandboxWithFixtures();
      const lists = await sb.fetchTopLists("m", null, null);
      assert.equal(lists.length, 2);
      assert.equal(lists[0].url, "https://mdblist.com/lists/linaspurinis/top-watched-movies-of-the-week");
      assert.equal(lists[1].type, "series");
    });
  });
});
