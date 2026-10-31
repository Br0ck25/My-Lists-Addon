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
import { call, makeEnv } from "./harness.mjs";

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
    const discoveryFolder = cols.find((c) => c.id === "col_discovery");
    assert.deepEqual(Array.from(discoveryFolder.lists.slice(0, 2), (r) => [r.catalogId, r.type, r.url]), [
      ["tmdb-chart-discovery", "movie", "tmdb:chart:discovery"],
      ["tmdb-chart-discovery", "series", "tmdb:chart:discovery"],
    ]);
    assert.equal(discoveryFolder.lists.length, 4);
    const manifest = sandbox.buildManifest([], "https://mylistsaddon.com", false, false, "", null, true, true).catalogs;
    for (const type of ["movie", "series"]) {
      assert.ok(manifest.some((c) => c.id === "tmdb-chart-discovery" && c.type === type), "Discovery+ " + type + " catalog is advertised");
      const path = get("TMDB_CHART_PATHS.discovery")[type === "movie" ? "movie" : "tv"];
      const q = new URL("https://x/" + path).searchParams;
      assert.equal(q.get("with_watch_providers"), "520");
      assert.equal(q.get("with_watch_monetization_types"), "flatrate");
    }
    assert.ok(manifest.some((c) => c.id === "tmdb-chart-discovery-reality-tv" && c.type === "series"));
    assert.ok(manifest.some((c) => c.id === "tmdb-chart-netflixkids-animated-movies" && c.type === "movie"));
  });

  it("adds exact genre, language and network intersections without duplicating existing queries", () => {
    const extra = get("STREAMING_ADDITIONAL_ROWS");
    const canonical = (path) => {
      const u = new URL("https://test/" + path);
      return u.pathname + "?" + [...u.searchParams.entries()].sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv)).map(([k, v]) => k + "=" + v).join("&");
    };
    for (const [service, definitions] of Object.entries(extra)) {
      const addedIds = new Set(definitions.map((def) => service + "-" + def[0]));
      const previousQueries = new Set(rows.filter((r) => r.service === service && !addedIds.has(r.chartKey)).flatMap((r) => Object.values(r.kinds).map(canonical)));
      const seen = new Set();
      for (const def of definitions) {
        assert.doesNotMatch(def[1], /(?:top 10|popular|trending|recently|new releases|coming soon|leaving soon|watchlist|continue watching|recommended)/i, def[1]);
        const row = rows.find((r) => r.chartKey === service + "-" + def[0]);
        assert.ok(row, service + ":" + def[0]);
        for (const path of Object.values(row.kinds)) {
          const q = canonical(path);
          assert.ok(!previousQueries.has(q), row.chartKey + " duplicates an existing query");
          assert.ok(!seen.has(q), row.chartKey + " duplicates another new query");
          seen.add(q);
        }
      }
    }
    const query = (id, kind) => new URL("https://test/" + rows.find((r) => r.chartKey === id).kinds[kind]).searchParams;
    assert.equal(query("netflix-genre-crime-movies", "movie").get("with_genres"), "80");
    assert.equal(query("netflix-language-english-movies", "movie").get("with_original_language"), "en");
    assert.equal(query("paramount-cbs-dramas", "series").get("with_networks"), "16");
    assert.equal(query("paramount-cbs-dramas", "series").get("with_genres"), "18");
    assert.equal(query("disney-marvel-animation", "movie").get("with_companies"), "420");
    assert.equal(query("disney-marvel-animation", "movie").get("with_genres"), "16");
    assert.equal(rows.find((r) => r.chartKey === "netflix-genre-crime-movies").kinds.series, undefined);
    assert.equal(rows.find((r) => r.chartKey === "hbomax-hbo-drama").kinds.movie, undefined);
  });

  it("refuses duplicate additional queries and duplicate IDs without removing old rows", () => {
    const isolated = loadServer();
    const before = isolated.get("STREAMING_ROW_CATALOGS.length");
    vm.runInContext(`
      const duplicateQuery = ["test-duplicate", "Duplicate", { movie: "with_genres=28" }];
      STREAMING_ADDITIONAL_ROWS.netflix.push(duplicateQuery);
      STREAMING_ROWS.netflix.push(duplicateQuery);
      const duplicateId = ["genre-war-movies", "Wrong duplicate", { movie: "with_genres=14" }];
      STREAMING_ADDITIONAL_ROWS.netflix.push(duplicateId);
      STREAMING_ROWS.netflix.push(duplicateId);
      const oldId = ["originals", "Wrong legacy override", { movie: "with_genres=27" }];
      STREAMING_ADDITIONAL_ROWS.netflix.push(oldId);
      STREAMING_ROWS.netflix.push(oldId);
    `, isolated.sandbox);
    const result = isolated.get("getStreamingRowCatalogs()");
    assert.equal(result.length, before);
    assert.equal(result.filter((r) => r.chartKey === "netflix-genre-war-movies").length, 1);
    assert.ok(!result.some((r) => r.chartKey === "netflix-test-duplicate"));
    assert.ok(result.some((r) => r.chartKey === "netflix-get-in-on-the-action"), "legacy rows remain available");
    assert.equal(result.find((r) => r.chartKey === "netflix-originals").additional, false, "duplicate key must not reclassify a legacy row");
  });

  it("adds the new genre rows with the correct provider and movie/series filters", () => {
    const required = [
      ["netflix-genre-family-tv", "series", "10751", 8],
      ["netflix-genre-family-movies", "movie", "10751", 8],
      ["netflix-sports-docs", "movie", "99", 8],
      ["hulu-genre-scifi-movies", "movie", "878", 15],
      ["hulu-genre-thriller-movies", "movie", "53", 15],
      ["paramount-genre-drama-movies", "movie", "18", 2303],
      ["paramount-genre-thriller-movies", "movie", "53", 2303],
      ["paramount-genre-scifi-movies", "movie", "878", 2303],
      ["paramount-genre-family-movies", "movie", "10751", 2303],
      ["paramount-genre-romance-movies", "movie", "10749", 2303],
      ["disney-genre-scifi-movies", "movie", "878", 337],
      ["disney-genre-fantasy-movies", "movie", "14", 337],
      ["peacock-sports-docs", "movie", "99", 387],
      ["hulu-genre-animated-series", "series", "16", 15],
      ["hulu-genre-comedy-series", "series", "35", 15],
      ["hulu-genre-crime-mystery", "series", "80|9648", 15],
      ["paramount-genre-animated-movies", "movie", "16", 2303],
      ["hbomax-hbo-crime-mystery", "series", "80|9648", 1899],
      ["primevideo-genre-scifi-movies", "movie", "878", 9],
      ["primevideo-genre-fantasy-movies", "movie", "14", 9],
      ["primevideo-genre-family-movies", "movie", "10751", 9],
      ["primevideo-genre-animated-movies", "movie", "16", 9],
      ["primevideo-genre-war-movies", "movie", "10752", 9],
      ["appletv-genre-scifi-movies", "movie", "878", 350],
      ["appletv-genre-fantasy-movies", "movie", "14", 350],
      ["peacock-genre-scifi-movies", "movie", "878", 387],
      ["peacock-genre-family-movies", "movie", "10751", 387],
    ];
    for (const [key, type, genre, provider] of required) {
      const row = rows.find((r) => r.chartKey === key);
      assert.ok(row && row.additional, key);
      if (!key.endsWith("sports-docs")) assert.deepEqual(Object.keys(row.kinds), [type], key);
      else assert.deepEqual(Object.keys(row.kinds), ["movie", "series"], key);
      const q = new URL("https://x/" + row.kinds[type]).searchParams;
      assert.equal(q.get("with_genres"), genre);
      assert.equal(q.get("with_watch_providers"), String(provider));
      assert.equal(q.get("with_watch_monetization_types"), "flatrate");
    }
    for (const service of ["netflix", "peacock"]) {
      for (const path of Object.values(rows.find((r) => r.chartKey === service + "-sports-docs").kinds)) {
        const q = new URL("https://x/" + path).searchParams;
        assert.equal(q.get("with_genres"), "99");
        assert.equal(q.get("with_keywords"), "6075");
      }
    }
    const adultSwim = new URL("https://x/" + rows.find((r) => r.chartKey === "hbomax-adult-swim-network").kinds.series).searchParams;
    assert.equal(adultSwim.get("with_networks"), "80");
    assert.equal(adultSwim.get("with_watch_providers"), "1899");
    const hbo = new URL("https://x/" + rows.find((r) => r.chartKey === "hbomax-hbo-crime-mystery").kinds.series).searchParams;
    assert.equal(hbo.get("with_networks"), "49");
    assert.equal(hbo.get("with_genres"), "80|9648");
  });

  it("applies provider, genre and network intersections against fixture titles", async () => {
    const isolated = loadServer();
    const fixtures = [
      { id: 1, kind: "tv", providers: [1899], networks: [80], genres: [16] },
      { id: 2, kind: "tv", providers: [8], networks: [80], genres: [16] },
      { id: 3, kind: "tv", providers: [1899], networks: [49], genres: [16] },
      { id: 4, kind: "movie", providers: [8], networks: [], genres: [99], keywords: [6075] },
      { id: 5, kind: "movie", providers: [8], networks: [], genres: [18], keywords: [6075] },
      { id: 6, kind: "movie", providers: [9], networks: [], genres: [99], keywords: [6075] },
    ];
    isolated.sandbox.fixtureRows = fixtures;
    vm.runInContext(`
      fetchWithPerUserCacheAndCircuitBreaker = async function (opts) { return opts.fetchFn(); };
      fetchTmdbPagedResults = async function (path, key, skip) {
        const u = new URL('https://test/' + path), q = u.searchParams;
        const requiredGenre = q.get('with_genres'), requiredNetwork = q.get('with_networks'), requiredKeyword = q.get('with_keywords');
        const items = fixtureRows.filter((item) => item.kind === u.pathname.split('/').pop() &&
          item.providers.includes(Number(q.get('with_watch_providers'))) &&
          (!requiredGenre || item.genres.includes(Number(requiredGenre))) &&
          (!requiredNetwork || item.networks.includes(Number(requiredNetwork))) &&
          (!requiredKeyword || (item.keywords || []).includes(Number(requiredKeyword))));
        items.totalItems = items.length; return items.slice(skip);
      };
      fetchTmdbDetails = async function (id) { return { imdbId: 'tt' + String(id).padStart(7, '0') }; };
      mapTmdbItem = function (item, imdb, type) { return { id: imdb, type: type }; };
    `, isolated.sandbox);
    const adult = await isolated.sandbox.fetchTmdbChart({ type: "series" }, 0, "key", "hbomax-adult-swim-network", "US", false);
    const sports = await isolated.sandbox.fetchTmdbChart({ type: "movie" }, 0, "key", "netflix-sports-docs", "US", false);
    assert.deepEqual(Array.from(adult, (item) => item.id), ["tt0000001"]);
    assert.deepEqual(Array.from(sports, (item) => item.id), ["tt0000004"]);
  });

  it("returns empty for the wrong content type, even with a configured install", async () => {
    assert.equal(sandbox.findChartOrCollectionEntry("tmdb-chart-hulu-genre-animated-series", "movie"), null);
    assert.equal(sandbox.findChartOrCollectionEntry("tmdb-chart-primevideo-genre-war-movies", "series"), null);
    assert.ok(sandbox.findChartOrCollectionEntry("tmdb-chart-primevideo-genre-war-movies", "movie"));
    const env = makeEnv();
    for (const path of ["/catalog/movie/tmdb-chart-hulu-genre-animated-series.json", "/someconfig/catalog/series/tmdb-chart-primevideo-genre-war-movies.json"]) {
      const result = await call(env, path);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, { metas: [] });
    }
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

  it("coalesces simultaneous detail lookups and retries after failures", async () => {
    const isolated = loadServer();
    let calls = 0;
    let finish;
    isolated.sandbox.fetch = () => { calls++; return new Promise((resolve) => { finish = resolve; }); };
    const a = isolated.sandbox.fetchTmdbDetails(42, "movie", "key");
    const b = isolated.sandbox.fetchTmdbDetails(42, "movie", "key");
    assert.equal(calls, 1);
    finish(new Response(JSON.stringify({ external_ids: { imdb_id: "tt0000042" } }), { status: 200 }));
    assert.equal((await a).imdbId, "tt0000042");
    assert.equal((await b).imdbId, "tt0000042");
    const waiters = [];
    isolated.sandbox.fetch = () => new Promise((resolve) => { waiters.push(resolve); });
    const one = isolated.sandbox.fetchTmdbDetails(44, "movie", "key-1");
    const two = isolated.sandbox.fetchTmdbDetails(44, "movie", "key-2");
    assert.equal(waiters.length, 2, "different credentials must not share an in-flight request");
    waiters.forEach((resolve) => resolve(new Response(JSON.stringify({ external_ids: { imdb_id: "tt0000044" } }), { status: 200 })));
    await Promise.all([one, two]);
    let failures = 0;
    isolated.sandbox.fetch = async () => { failures++; throw new Error("offline"); };
    await assert.rejects(isolated.sandbox.fetchTmdbDetails(43, "movie", "key"), /offline/);
    await assert.rejects(isolated.sandbox.fetchTmdbDetails(43, "movie", "key"), /offline/);
    assert.equal(failures, 2);
  });

  it("refuses partial or malformed Discover pages for the new rows", async () => {
    const isolated = loadServer();
    isolated.sandbox.fetch = async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      return page === 2 ? new Response("error", { status: 500 }) : new Response(JSON.stringify({ results: [], total_results: 40 }), { status: 200 });
    };
    await assert.rejects(isolated.sandbox.fetchTmdbPagedResults("discover/tv?with_genres=99", "key", 0, 0, true), /500/);
    let emptyCalls = 0;
    isolated.sandbox.fetch = async () => { emptyCalls++; return new Response(JSON.stringify({ results: [], total_results: 0 }), { status: 200 }); };
    const empty = await isolated.sandbox.fetchTmdbPagedResults("discover/tv?with_genres=99", "key", 0, 0, true);
    assert.equal(empty.length, 0);
    assert.equal(empty.totalItems, 0);
    assert.equal(emptyCalls, 1, "empty rows need one upstream page rather than five");
    isolated.sandbox.fetch = async () => new Response(JSON.stringify({ total_results: 0 }), { status: 200 });
    await assert.rejects(isolated.sandbox.fetchTmdbPagedResults("discover/tv?with_genres=99", "key", 0, 0, true), /502/);
  });

  it("preserves upstream ordering and pagination without fetching beyond the last page", async () => {
    const isolated = loadServer();
    const pages = [];
    isolated.sandbox.fetch = async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      pages.push(page);
      const results = Array.from({ length: Math.max(0, Math.min(20, 101 - (page - 1) * 20)) }, (_, i) => ({ id: (page - 1) * 20 + i }));
      return new Response(JSON.stringify({ results, total_results: 101 }), { status: 200 });
    };
    const window = await isolated.sandbox.fetchTmdbPagedResults("discover/tv?sort_by=popularity.desc", "key", 15, 0, true);
    assert.equal(window.totalItems, 101);
    assert.equal(window.length, 86);
    assert.deepEqual(Array.from(window, (x) => x.id), Array.from({ length: 86 }, (_, i) => i + 15));
    assert.deepEqual(pages, [1, 2, 3, 4, 5, 6]);
    pages.length = 0;
    const last = await isolated.sandbox.fetchTmdbPagedResults("discover/tv?sort_by=popularity.desc", "key", 100, 0, true);
    assert.deepEqual(Array.from(last, (x) => x.id), [100]);
    assert.deepEqual(pages, [6]);
  });

  it("deduplicates new-row titles before and after metadata resolution", async () => {
    const isolated = loadServer();
    const resolvedIds = [];
    isolated.sandbox.resolvedIds = resolvedIds;
    vm.runInContext(`
      fetchWithPerUserCacheAndCircuitBreaker = async function (opts) { return opts.fetchFn(); };
      fetchTmdbPagedResults = async function () {
        const a = [{ id: 1 }, { id: 1 }, { id: 2 }, { id: 3 }]; a.totalItems = 4; return a;
      };
      fetchTmdbDetails = async function (id) { resolvedIds.push(id); return { imdbId: id === 3 ? 'tt0000003' : 'tt0000001' }; };
      mapTmdbItem = function (it, id, type) { return { id: id, type: type }; };
    `, isolated.sandbox);
    const result = await isolated.sandbox.fetchTmdbChart({ type: "series" }, 0, "key", "discovery-reality-tv", "US", false);
    assert.deepEqual([...resolvedIds], [1, 2, 3]);
    assert.deepEqual(Array.from(result, (item) => item.id), ["tt0000001", "tt0000003"]);
    assert.equal(result.totalItems, 4, "upstream count is not presented as a deduplicated count");
  });

  it("accepts confirmed empty new rows but keeps stale data when IDs are missing", async () => {
    const isolated = loadServer();
    isolated.sandbox.setTimeout = setTimeout;
    isolated.sandbox.clearTimeout = clearTimeout;
    const key = "user_cache:tmdb:chart:discovery-reality-tv:tv:0:US:0";
    isolated.sandbox.setPerUserCache(key, [{ id: "ttold" }], 10, 3600);
    isolated.get(`PER_USER_CACHE_MAP.get(${JSON.stringify(key)}).freshUntil = 0`);
    vm.runInContext(`
      fetchTmdbPagedResults = async function () { const a = [{ id: 1 }]; a.totalItems = 1; return a; };
      fetchTmdbDetails = async function () { return { imdbId: null }; };
    `, isolated.sandbox);
    const stale = await isolated.sandbox.fetchTmdbChart({ type: "series" }, 0, "key", "discovery-reality-tv", "US", false);
    assert.equal(stale[0].id, "ttold");
    isolated.get(`PER_USER_CACHE_MAP.get(${JSON.stringify(key)}).freshUntil = 0`);
    vm.runInContext(`fetchTmdbPagedResults = async function () { const a = []; a.totalItems = 0; return a; };`, isolated.sandbox);
    const empty = await isolated.sandbox.fetchTmdbChart({ type: "series" }, 0, "key", "discovery-reality-tv", "US", false);
    assert.equal(empty.length, 0);
    assert.equal(isolated.sandbox.getPerUserCache(key).data.length, 0);
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
