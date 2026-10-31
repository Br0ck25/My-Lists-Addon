// The premade streaming collections' browse rows (STREAMING_ROWS, 08_quickadd-chart-data.js).
// The rule that matters: a row on a service's collection only ever holds titles that are
// INCLUDED with that service (TMDB with_watch_providers + flatrate), never another service's.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { loadClient } from "./client-harness.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function loadServer() {
  const sandbox = { console, URL, URLSearchParams, atob, btoa, Uint8Array, TextDecoder, TextEncoder, Response, Headers, Request, crypto: globalThis.crypto };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of ["00_constants.js", "02_http-and-creator-utils.js", "05_catalog-core.js", "07_source-fetchers-tmdb-simkl.js", "08_quickadd-chart-data.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, f), "utf8"), sandbox, { filename: f });
  }
  // const declarations are not properties of the context: read them through a script.
  const get = (expr) => vm.runInContext(expr, sandbox);
  return { sandbox, get };
}

describe("streaming service rows", () => {
  const { sandbox, get } = loadServer();
  const rows = get("STREAMING_ROW_CATALOGS");
  const services = get("STREAMING_ROW_SERVICES");
  const chartPaths = get("TMDB_CHART_PATHS");

  it("every service with a premade collection has plenty of rows", () => {
    for (const svc of ["netflix", "hulu", "paramount", "disney", "hbomax", "primevideo", "peacock", "appletv"]) {
      assert.ok(rows.filter((r) => r.service === svc).length >= 18, svc + " has too few rows");
    }
  });

  it("the rows named for each service exist", () => {
    const names = (svc) => rows.filter((r) => r.service === svc).map((r) => r.name);
    for (const n of ["Hooked from the First Episode", "Action TV", "Award-Winning TV Shows", "Watch for a While", "Feel-Good TV Shows", "Get in on the Action", "Casual Viewing", "Anime", "Dark TV Horror", "Goofy TV Shows"]) assert.ok(names("netflix").includes(n), "Netflix: " + n);
    for (const n of ["Bingeable TV", "Travel & Lifestyle", "Stream & Scream", "Kids", "Full Series Comedies", "Popular TV", "Blockbuster Movies", "Easy-to-Watch TV", "Complete Series", "True Crime", "Family Movies", "Comedy Movies", "Mystery TV Shows"]) assert.ok(names("hulu").includes(n), "Hulu: " + n);
    for (const n of ["Unmissable Action", "Psychological Thrillers", "Reality Shows", "Movie Night", "Adult Animation", "Sci-Fi Series", "Romantic Comedies", "NickRewind", "Nick Jr. Shows", "Movies Based on Books", "Best of the 90s", "Looking for a Laugh?"]) assert.ok(names("paramount").includes(n), "Paramount+: " + n);
  });

  it("every row is limited to titles included with its own service", () => {
    for (const r of rows) {
      const providerId = services[r.service].provider;
      for (const url of Object.values(r.kinds)) {
        const q = new URL("https://x.test/" + url).searchParams;
        assert.equal(q.get("with_watch_providers"), String(providerId), r.chartKey + " must filter to its own service");
        assert.equal(q.get("with_watch_monetization_types"), "flatrate", r.chartKey + " must be included-with-subscription only");
        assert.equal(q.get("watch_region"), "US");
      }
    }
  });

  it("adds narrowly defined Discovery+ and Netflix Kids rows with service and content-type restrictions", () => {
    const discovery = rows.filter((r) => r.service === "discovery");
    const kids = rows.filter((r) => r.service === "netflixkids");
    assert.deepEqual(Array.from(discovery, (r) => r.name), ["Reality TV", "Documentary Series"]);
    assert.deepEqual(Array.from(kids, (r) => r.name), ["Kids TV Shows", "Animated TV Shows", "Animated Movies", "Family Movies"]);
    for (const r of discovery) {
      assert.ok(r.kinds.series && !r.kinds.movie);
      assert.equal(new URL("https://x/" + r.kinds.series).searchParams.get("with_watch_providers"), "520");
    }
    for (const r of kids) {
      const url = r.kinds.movie || r.kinds.series;
      const q = new URL("https://x/" + url).searchParams;
      assert.equal(q.get("with_watch_providers"), "175");
      if (r.kinds.movie) {
        assert.equal(q.get("certification_country"), "US");
        assert.equal(q.get("certification.lte"), "PG");
      } else assert.ok(q.get("with_genres").split(",").includes("10762"));
    }
    const client = loadClient();
    const cols = client.call("getPremadeCollections");
    const kidFolder = cols.find((c) => c.id === "col_netflixkids");
    assert.equal(kidFolder.lists[0].url, "tmdb:chart:netflixkids");
    assert.equal(kidFolder.lists[1].url, "tmdb:chart:netflixkids");
    assert.equal(kidFolder.lists.length, 6);
    assert.equal(cols.find((c) => c.id === "col_discovery").lists.length, 2);
    const manifest = sandbox.buildManifest([], "https://mylistsaddon.com", false, false, "", null, true, true).catalogs;
    assert.ok(manifest.some((c) => c.id === "tmdb-chart-discovery-reality-tv" && c.type === "series"));
    assert.ok(manifest.some((c) => c.id === "tmdb-chart-netflixkids-animated-movies" && c.type === "movie"));
  });

  it("leaves the existing premade catalogs in place and in order", () => {
    const client = loadClient();
    const base = client.call("getPremadeCollectionsBase");
    const augmented = client.call("getPremadeCollections");
    for (const old of base) {
      const next = augmented.find((c) => c.id === old.id);
      assert.ok(next, old.id);
      assert.deepEqual(JSON.parse(JSON.stringify(next.lists.slice(0, old.lists.length))), JSON.parse(JSON.stringify(old.lists)), old.id);
    }
    // Discovery+ has an existing full catalog, but did not previously have a premade folder.
    assert.equal(get("TMDB_CHART_PATHS.discovery.movie").includes("with_watch_providers=520"), true);
    assert.equal(get("TMDB_CHART_PATHS.netflixkids.movie").includes("with_watch_providers=175"), true);
  });

  it("routes new rows through the existing paged, cached TMDB chart fetcher", async () => {
    const isolated = loadServer();
    const calls = [];
    isolated.sandbox.capture = calls;
    vm.runInContext(`
      fetchWithPerUserCacheAndCircuitBreaker = async function (opts) {
        capture.push({ cacheKey: opts.cacheKey, fresh: opts.freshTtlSec, stale: opts.staleTtlSec });
        return opts.fetchFn();
      };
      fetchTmdbPagedResults = async function (path, key, skip) {
        capture.push({ path, skip });
        const results = [{ id: 42 }]; results.totalItems = 101; return results;
      };
      mapWithConcurrency = async function (arr, concurrency, fn) { return Promise.all(arr.map(fn)); };
      fetchTmdbDetails = async function () { return { imdbId: 'tt0000042', videos: [] }; };
      mapTmdbItem = function (item, imdb, type) { return { id: imdb, type: type }; };
    `, isolated.sandbox);
    const result = await isolated.sandbox.fetchTmdbChart({ type: "series" }, 100, "test-key", "discovery-documentary-series", "US", false);
    assert.equal(result[0].id, "tt0000042");
    assert.equal(result.totalItems, 101);
    assert.equal(calls[0].fresh, 600);
    assert.equal(calls[0].stale, 86400);
    assert.match(calls[0].cacheKey, /discovery-documentary-series:tv:100:US/);
    assert.equal(calls[1].skip, 100);
    const query = new URL("https://x/" + calls[1].path).searchParams;
    assert.equal(query.get("with_watch_providers"), "520");
    assert.equal(query.get("with_genres"), "99");
    assert.equal(query.get("with_watch_monetization_types"), "flatrate");
  });

  it("no row sends sort_by twice, and chart keys / catalog ids are unique", () => {
    for (const r of rows) for (const url of Object.values(r.kinds)) assert.equal((url.match(/sort_by=/g) || []).length, 1, r.chartKey);
    assert.equal(new Set(rows.map((r) => r.chartKey)).size, rows.length);
    assert.equal(new Set(rows.map((r) => r.catalogId)).size, rows.length);
  });

  it("a shows-only row has no movie catalog, so no movie is shown under it", () => {
    const hooked = rows.find((r) => r.chartKey === "netflix-hooked");
    assert.ok(hooked.kinds.series && !hooked.kinds.movie);
    assert.equal(chartPaths["netflix-hooked"].movie, undefined);
    const stream = rows.find((r) => r.chartKey === "hulu-stream-and-scream");
    assert.ok(stream.kinds.series && stream.kinds.movie);
  });

  it("rows are served by the chart fetcher and resolve to a readable name", () => {
    const entry = sandbox.findChartOrCollectionEntry("tmdb-chart-netflix-hooked", "series");
    assert.equal(entry.url, "tmdb:chart:netflix-hooked");
    assert.equal(entry.name, "Netflix: Hooked from the First Episode");
  });

  it("the Stremio manifest stays small; the Nuvio link (?collections=1) lists every row", () => {
    const plain = sandbox.buildManifest([], "https://mylistsaddon.com").catalogs.map((c) => c.id);
    const withRows = sandbox.buildManifest([], "https://mylistsaddon.com", false, false, "", null, true, true).catalogs;
    assert.ok(!plain.includes("tmdb-chart-netflix-hooked"));
    assert.ok(plain.includes("tmdb-chart-netflix"), "the existing premade catalogs are unchanged");
    assert.ok(withRows.some((c) => c.id === "tmdb-chart-netflix-hooked" && c.type === "series"));
    assert.ok(!withRows.some((c) => c.id === "tmdb-chart-netflix-hooked" && c.type === "movie"));
  });

  it("each premade collection in the app gets its service's rows, after its Top 10 and catalog", () => {
    const client = loadClient();
    const cols = client.call("getPremadeCollections");
    const nf = cols.find((c) => c.id === "col_netflix");
    assert.ok(nf.lists.length > 30);
    assert.equal(nf.lists[0].name, "Netflix Top 10");
    assert.ok(nf.lists.some((l) => l.name === "Hooked from the First Episode" && l.type === "series" && l.url === "tmdb:chart:netflix-hooked"));
    assert.ok(!nf.lists.some((l) => /Stream & Scream/.test(l.name)), "another service's rows never leak in");
  });
});
