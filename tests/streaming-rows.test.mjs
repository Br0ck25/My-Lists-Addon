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
