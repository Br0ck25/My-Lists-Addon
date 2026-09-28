// Phase 4: the provider layer.
//
// P4-1 replaced detectSource's if/else and fetchCatalog's matching if/else
// with one table, CATALOG_SOURCES (04_config-resolution.js), and the provider
// adapters built from it. It is meant to change nothing a person can see, so
// the tests below keep a FROZEN copy of the two old chains (as they were on
// main before P4-1) and hold the registry to them: the same name for every
// input, the same fetcher called with the same arguments, and the same shared
// API use counted.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { freshIsolate, makeEnv, makeKv, nextIp } from "./harness.mjs";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// The files share one sandbox, as they share one scope in the built Worker.
// No `fetch`: nothing here may reach a provider.
function loadSourceFunctions(...relFiles) {
  const sandbox = {
    console, URL, URLSearchParams, atob, btoa, Uint8Array, TextDecoder, TextEncoder,
    Response, Headers, Request,
    crypto: globalThis.crypto,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const relFile of relFiles) {
    const src = fs.readFileSync(path.join(REPO_ROOT, relFile), "utf8");
    vm.runInContext(src, sandbox, { filename: relFile });
  }
  return sandbox;
}

// --- The old chains, frozen --------------------------------------------------
// detectSource as it was before P4-1, word for word apart from taking its two
// helpers as arguments (they are unchanged, and read from the sandbox).
function legacyDetectSource(input, parseTmdbWebChartUrl, parsePublishedListUrl) {
  const s = (input || "").trim();
  if (s === "mdblist:watchlist" || s.startsWith("mdblist:watchlist:") || /^https?:\/\/(www\.)?mdblist\.com\/(?:lists\/[^/]+\/)?watchlist\/?/i.test(s)) return "mdblist-watchlist";
  if (s === "mdblist:history" || s.startsWith("mdblist:history:") || /^https?:\/\/(www\.)?mdblist\.com\/(?:lists\/[^/]+\/)?history\/?/i.test(s)) return "mdblist-history";
  if (s === "mdblist:airing-next" || s.startsWith("mdblist:airing-next:") || s === "mdblist:user:shows:airing-next") return "mdblist-airing-next";
  if (s === "mdblist:upnext" || s.startsWith("mdblist:upnext:") || s === "mdblist:user:shows:upnext") return "mdblist-upnext";
  if (s === "trakt:watchlist" || s.startsWith("trakt:watchlist:") || /^https?:\/\/(www\.|app\.)?trakt\.tv\/users\/[^/]+\/watchlist\/?(?:[?#].*)?$/i.test(s)) return "trakt-watchlist";
  if (s === "trakt:history" || s.startsWith("trakt:history:") || /^https?:\/\/(www\.|app\.)?trakt\.tv\/users\/[^/]+\/history\/?(?:[?#].*)?$/i.test(s)) return "trakt-history";
  if (s === "trakt:airing-next" || s.startsWith("trakt:airing-next:") || s === "trakt:user:shows:airing-next") return "trakt-airing-next";
  if (s === "trakt:continue-watching" || s.startsWith("trakt:continue-watching:") || s === "trakt:user:continue-watching" || /^https?:\/\/(www\.|app\.)?trakt\.tv\/users\/[^/]+\/continue-watching\/?(?:[?#].*)?$/i.test(s)) return "trakt-continue-watching";
  if (s.startsWith("tmdb:chart:") || parseTmdbWebChartUrl(s)) return "tmdb-chart";
  if (s.startsWith("tmdb:top10:")) return "tmdb-top10";
  if (s === "tmdb:hidden-gems") return "tmdb-hidden-gems";
  if (s.startsWith("tmdb:kids:")) return "tmdb-kids";
  if (s.startsWith("tmdb:holiday:")) return "tmdb-holiday";
  if (s.startsWith("tmdb:genre:")) return "tmdb-genre";
  if (
    s === "tmdb:new-on-streaming" || s.startsWith("tmdb:new-on-streaming:") ||
    s === "rapidapi:new-on-streaming" || s.startsWith("rapidapi:new-on-streaming:") ||
    s === "streaming:new-on-streaming" || s.startsWith("streaming:new-on-streaming:")
  ) return "tmdb-new-on-streaming";
  if (s.startsWith("mylists:most-watched:")) return "mylists-most-watched";
  if (s.startsWith("trakt:chart:")) return "trakt-chart";
  if (s.startsWith("simkl:chart:")) return "simkl-chart";
  if (s.startsWith("simkl:user:")) return "simkl-user";
  if (s.startsWith("channel:v1:")) return "channel";
  if (s.startsWith("customlist:v1:")) return "custom-list";
  if (s.startsWith("autotrack:") || s === "custom:watch-history" || s === "custom:continue-watching" || s === "custom:watchlist" || s.startsWith("custom:watch-history:") || s.startsWith("custom:continue-watching:")) return "autotrack";
  if (s.startsWith("custom:curated:") || s.startsWith("curated:")) return "curated";
  if (s.startsWith("tmdb:collection:") || /^https?:\/\/(?:www\.)?themoviedb\.org\/collection\//i.test(s)) return "tmdb-collection";
  if (parsePublishedListUrl(s)) return "published-list";
  if (/^https?:\/\/(www\.|app\.)?trakt\.tv\//i.test(s)) return "trakt";
  if (/^https?:\/\/(www\.)?themoviedb\.org\/list\//i.test(s)) return "tmdb";
  return "mdblist";
}

// fetchCatalog's single-source branch as it was before P4-1, with every
// fetcher (and trackSharedApiUse) reached through `f`, and the site's keys
// through `K`.
async function legacyDispatch(entry, skip, keys, f, K, detect) {
  let result;
  const mdblistKey = keys.mdblistAccessToken || keys.mdblistKey || K.MDBLIST_API_KEY;
  const traktKey = keys.traktKey || K.TRAKT_CLIENT_ID;
  const TMDB_API_KEY = K.TMDB_API_KEY;
  const SIMKL_CLIENT_ID = K.SIMKL_CLIENT_ID;
  const trackSharedApiUse = f.trackSharedApiUse;
  const source = detect(entry.url);
  if (source === "mdblist-watchlist") { trackSharedApiUse(keys, !(keys.mdblistKey || keys.mdblistAccessToken), "mdblist"); result = await f.fetchMdblistWatchlist(entry, skip, mdblistKey, keys.mdblistAccessToken || ""); }
  else if (source === "mdblist-history") { trackSharedApiUse(keys, !(keys.mdblistKey || keys.mdblistAccessToken), "mdblist"); result = await f.fetchMdblistHistory(entry, skip, mdblistKey, keys.mdblistAccessToken || ""); }
  else if (source === "mdblist-airing-next") { trackSharedApiUse(keys, !(keys.mdblistKey || keys.mdblistAccessToken), "mdblist"); result = await f.fetchMdblistAiringNext(entry, skip, mdblistKey, keys.mdblistAccessToken || "", keys.tmdbKey || TMDB_API_KEY, keys.env, keys.ctx); }
  else if (source === "mdblist-upnext") { trackSharedApiUse(keys, !(keys.mdblistKey || keys.mdblistAccessToken), "mdblist"); result = await f.fetchMdblistUpNext(entry, skip, mdblistKey, keys.mdblistAccessToken || "", keys.tmdbKey || TMDB_API_KEY, keys.env, keys.ctx); }
  else if (source === "trakt") { trackSharedApiUse(keys, !keys.traktKey, "trakt"); result = await f.fetchTrakt(entry, skip, traktKey, keys.traktAccessToken || "", keys.env, keys.ctx); }
  else if (source === "trakt-watchlist") { trackSharedApiUse(keys, !keys.traktKey, "trakt"); result = await f.fetchTraktWatchlist(entry, skip, traktKey, keys.traktAccessToken || "", keys.env, keys.ctx); }
  else if (source === "trakt-history") { trackSharedApiUse(keys, !keys.traktKey, "trakt"); result = await f.fetchTraktHistory(entry, skip, traktKey, keys.traktAccessToken || "", keys.env, keys.ctx); }
  else if (source === "trakt-airing-next") { trackSharedApiUse(keys, !keys.traktKey, "trakt"); result = await f.fetchTraktAiringNext(entry, skip, traktKey, keys.traktAccessToken || "", keys.tmdbKey || TMDB_API_KEY, keys.env, keys.ctx); }
  else if (source === "trakt-continue-watching") { trackSharedApiUse(keys, !keys.traktKey, "trakt"); result = await f.fetchTraktContinueWatching(entry, skip, traktKey, keys.traktAccessToken || "", keys.env, keys.ctx); }
  else if (source === "tmdb") { trackSharedApiUse(keys, true, "tmdb"); result = await f.fetchTmdb(entry, skip, TMDB_API_KEY); }
  else if (source === "tmdb-chart") {
    trackSharedApiUse(keys, true, "tmdb");
    const webChart = f.parseTmdbWebChartUrl(entry.url);
    const chartKey = webChart ? webChart.chartKey : entry.url.trim().slice("tmdb:chart:".length);
    result = await f.fetchTmdbChart(entry, skip, TMDB_API_KEY, chartKey, keys.region, keys.hideNonDigitalReleases, keys.env, keys.ctx);
  }
  else if (source === "tmdb-collection") { trackSharedApiUse(keys, true, "tmdb"); result = await f.fetchTmdbCollection(entry, skip, TMDB_API_KEY, keys.env, keys.ctx); }
  else if (source === "tmdb-top10") { trackSharedApiUse(keys, true, "tmdb"); result = await f.fetchTmdbProviderTop10(entry, skip, TMDB_API_KEY, entry.url.trim().slice("tmdb:top10:".length), keys.region); }
  else if (source === "tmdb-hidden-gems") { trackSharedApiUse(keys, true, "tmdb"); result = await f.fetchTmdbHiddenGems(entry, skip, TMDB_API_KEY); }
  else if (source === "tmdb-kids") { trackSharedApiUse(keys, true, "tmdb"); result = await f.fetchTmdbKids(entry, skip, TMDB_API_KEY, entry.url.trim().slice("tmdb:kids:".length)); }
  else if (source === "tmdb-holiday") { trackSharedApiUse(keys, true, "tmdb"); result = await f.fetchTmdbHoliday(entry, skip, TMDB_API_KEY, entry.url.trim().slice("tmdb:holiday:".length)); }
  else if (source === "tmdb-genre") { trackSharedApiUse(keys, true, "tmdb"); result = await f.fetchTmdbGenre(entry, skip, TMDB_API_KEY, entry.url.trim().slice("tmdb:genre:".length), keys.region); }
  else if (source === "tmdb-new-on-streaming") { result = await f.fetchNewOnStreaming(entry, skip, keys); }
  else if (source === "mylists-most-watched") { result = await f.fetchMostWatchedCatalog(entry, skip, keys); }
  else if (source === "trakt-chart") { trackSharedApiUse(keys, !keys.traktKey, "trakt"); result = await f.fetchTraktChart(entry, skip, traktKey, entry.url.trim().slice("trakt:chart:".length), keys.env, keys.ctx); }
  else if (source === "simkl-chart") { trackSharedApiUse(keys, true, "simkl"); result = await f.fetchSimklChart(entry, skip, SIMKL_CLIENT_ID, entry.url.trim().slice("simkl:chart:".length), keys.env, keys.ctx); }
  else if (source === "simkl-user") { trackSharedApiUse(keys, true, "simkl"); result = await f.fetchSimklUserList(entry, skip, keys.simklAccessToken, SIMKL_CLIENT_ID, entry.url.trim().slice("simkl:user:".length), keys.tmdbKey, keys.env, keys.ctx); }
  else if (source === "channel") result = f.fetchChannelCatalog(entry, keys.origin);
  else if (source === "custom-list") result = await f.fetchCustomListCatalog(entry, skip, keys);
  else if (source === "autotrack") result = await f.fetchAutoTrackedCatalog(entry, keys.env, keys);
  else if (source === "curated") { trackSharedApiUse(keys, true, "tmdb"); result = await f.fetchCuratedCatalog(entry, skip, keys); }
  else if (source === "published-list") result = await f.fetchPublishedListCatalog(entry, keys.env);
  else {
    trackSharedApiUse(keys, !(keys.mdblistKey || keys.mdblistAccessToken), "mdblist");
    result = await f.fetchMdblist(entry, skip, mdblistKey, keys.env, keys.ctx);
  }
  return result;
}

const FETCHERS = [
  "fetchMdblist", "fetchMdblistWatchlist", "fetchMdblistHistory", "fetchMdblistAiringNext", "fetchMdblistUpNext",
  "fetchTrakt", "fetchTraktWatchlist", "fetchTraktHistory", "fetchTraktAiringNext", "fetchTraktContinueWatching", "fetchTraktChart",
  "fetchTmdb", "fetchTmdbChart", "fetchTmdbCollection", "fetchTmdbProviderTop10", "fetchTmdbHiddenGems", "fetchTmdbKids",
  "fetchTmdbHoliday", "fetchTmdbGenre", "fetchNewOnStreaming", "fetchMostWatchedCatalog", "fetchSimklChart",
  "fetchSimklUserList", "fetchChannelCatalog", "fetchCustomListCatalog", "fetchAutoTrackedCatalog",
  "fetchCuratedCatalog", "fetchPublishedListCatalog",
];

// Every shape of source string the add-on has produced or accepted, including
// the awkward ones (surrounding whitespace, a filter query string, app.
// hosts, upper case, look-alikes that must NOT match).
const SOURCE_CORPUS = [
  "", "   ", "\n", "mdblist:watchlist", "mdblist:watchlist:movies", "mdblist:watchlistx",
  "https://mdblist.com/watchlist", "https://www.mdblist.com/watchlist/", "https://mdblist.com/lists/bob/watchlist",
  "https://mdblist.com/lists/bob/watchlist?sort=rank", "HTTPS://MDBLIST.COM/WATCHLIST",
  "mdblist:history", "mdblist:history:shows", "https://mdblist.com/history", "https://mdblist.com/lists/bob/history/",
  "mdblist:airing-next", "mdblist:airing-next:x", "mdblist:user:shows:airing-next",
  "mdblist:upnext", "mdblist:upnext:x", "mdblist:user:shows:upnext", "mdblist:user:x",
  "trakt:watchlist", "trakt:watchlist:movies", "https://trakt.tv/users/bob/watchlist", "https://app.trakt.tv/users/bob/watchlist",
  "https://trakt.tv/users/bob/watchlist?Mode=Show", "https://trakt.tv/users/bob/watchlist/extra", "HTTPS://TRAKT.TV/USERS/X/WATCHLIST",
  "trakt:history", "trakt:history:shows", "https://trakt.tv/users/bob/history", "https://www.trakt.tv/users/bob/history#top",
  "trakt:airing-next", "trakt:airing-next:x", "trakt:user:shows:airing-next",
  "trakt:continue-watching", "trakt:continue-watching:x", "trakt:user:continue-watching",
  "https://trakt.tv/users/bob/continue-watching", "https://app.trakt.tv/users/bob/continue-watching/",
  "trakt:collection", "trakt:user:lists",
  "tmdb:chart:popular", "tmdb:chart:trending:series", "tmdb:chart:", "https://www.themoviedb.org/movie",
  "https://www.themoviedb.org/movie/top-rated", "https://themoviedb.org/tv/airing-today", "https://www.themoviedb.org/trending/tv",
  "https://www.themoviedb.org/trending", "https://www.themoviedb.org/movie/12345-some-film",
  "tmdb:top10:netflix", "tmdb:top10:", "tmdb:hidden-gems", "tmdb:hidden-gems:x",
  "tmdb:kids:G", "tmdb:holiday:christmas", "tmdb:genre:28", "tmdb:genre:",
  "tmdb:new-on-streaming", "tmdb:new-on-streaming:netflix+hulu", "rapidapi:new-on-streaming", "rapidapi:new-on-streaming:max",
  "streaming:new-on-streaming", "streaming:new-on-streaming:prime", "tmdb:new-on-streamingx",
  "mylists:most-watched:today", "mylists:most-watched:7", "mylists:most-watched",
  "trakt:chart:trending-movies", "trakt:chart:", "simkl:chart:week", "simkl:user:watchlist:shows", "simkl:user:",
  "simkl:watchlist", "simkl:history:shows", "simkl:airing-next",
  "channel:v1:" + JSON.stringify({ name: "C", items: [] }), "channel:v1:{not json", "channel:v2:x",
  "customlist:v1:" + JSON.stringify({ name: "L", items: [] }),
  "autotrack:watchlist:series:bob", "autotrack:", "custom:watch-history", "custom:watch-history:movies",
  "custom:continue-watching", "custom:continue-watching:x", "custom:watchlist", "custom:watchlist:x",
  "custom:curated:movies", "curated:shows", "custom:other",
  "tmdb:collection:86311", "tmdb:collection:", "https://www.themoviedb.org/collection/86311-the-avengers",
  "https://mylistsaddon.com/lists/alice/my-list", "https://example.workers.dev/lists/Bob/Best%20Of/", "https://x.com/lists/a/b.json",
  "https://mdblist.com/lists/alice/my-list", "https://mdblist.com/lists/alice/my-list/?Mode=Show", "https://mdblist.com/lists/official/movies/top",
  "alice/my-list", "  alice/my-list  ", "https://trakt.tv/users/bob/lists/best-of-2024", "https://app.trakt.tv/users/bob/lists/123",
  "https://trakt.tv/movies/trending", "https://www.themoviedb.org/list/8290920", "https://themoviedb.org/list/8290920-my-favorites",
  "https://letterboxd.com/dave/list/official-top-250-narrative-feature-films/", "https://letterboxd.com/dave/watchlist/",
  "https://simkl.com/5/list/abc", "not a url", "ftp://mdblist.com/watchlist", "tmdb:watchlist", "tmdb:favorites", "tmdb:account:x",
  " tmdb:chart:popular ", "\ttrakt:watchlist\n",
];

describe("P4-1: the provider registry", () => {
  const sb = loadSourceFunctions("00_constants.js", "04_config-resolution.js", "05_catalog-core.js");
  const CATALOG_SOURCES = vm.runInContext("CATALOG_SOURCES", sb);
  const PROVIDER_ADAPTERS = vm.runInContext("PROVIDER_ADAPTERS", sb);
  const STREMIO_LIVE_ROW_SOURCES = vm.runInContext("STREMIO_LIVE_ROW_SOURCES", sb);
  const legacy = (s) => legacyDetectSource(s, sb.parseTmdbWebChartUrl, sb.parsePublishedListUrl);

  // The acceptance test for P4-1: every source string detectSource knew maps
  // to an adapter.
  it("names every input exactly as the old detectSource did", () => {
    const seen = new Set();
    for (const s of SOURCE_CORPUS) {
      const name = sb.detectSource(s);
      assert.equal(name, legacy(s), `they disagree on ${JSON.stringify(s)}`);
      seen.add(name);
    }
    // The corpus reaches every source, so the comparison covers all of them.
    for (const src of CATALOG_SOURCES) assert.ok(seen.has(src.name), `the corpus never reaches ${src.name}`);
    // And the old chain had no name the registry lacks.
    for (const name of seen) assert.ok(sb.catalogSourceByName(name), `${name} has no registry row`);
  });

  it("maps every source to an adapter, and each adapter lists its own sources", () => {
    const names = CATALOG_SOURCES.map((s) => s.name);
    assert.equal(new Set(names).size, names.length, "source names are unique");
    assert.equal(names.length, 28);
    for (const src of CATALOG_SOURCES) {
      const adapter = sb.providerAdapter(src.provider);
      assert.ok(adapter, `${src.name} names an unknown provider ${src.provider}`);
      assert.ok(adapter.sources.includes(src.name), `${src.provider} does not list ${src.name}`);
      assert.ok(["chart", "list", "personal", "own"].includes(src.kind), `${src.name} has kind ${src.kind}`);
      assert.equal(typeof src.fetchPage, "function");
      if (src.apiUse) {
        assert.equal(typeof sb.providerAdapter(src.apiUse).usesSharedKey, "function", `${src.name} spends ${src.apiUse}, which has no usesSharedKey`);
      }
    }
    const listed = Object.values(PROVIDER_ADAPTERS).flatMap((a) => a.sources);
    assert.equal(listed.length, names.length, "no source is listed twice");
    // The providers the plan names (NEXT_VERSION_TASKS P4-1), plus this site.
    for (const id of ["tmdb", "trakt", "mdblist", "simkl", "justwatch", "rapidapi", "tvmaze", "cinemeta", "letterboxd", "mylists"]) {
      const a = sb.providerAdapter(id);
      assert.ok(a, `no adapter for ${id}`);
      assert.equal(a.id, id);
      assert.ok(Array.isArray(a.hosts));
      assert.equal(typeof a.parseRef, "function");
    }
    assert.equal(sb.providerAdapter("toString"), null, "no inherited names");
    assert.equal(sb.providerAdapter("nope"), null);
  });

  it("the catch-all is last, so nothing after it is unreachable", () => {
    const last = CATALOG_SOURCES[CATALOG_SOURCES.length - 1];
    assert.equal(last.name, "mdblist");
    for (const src of CATALOG_SOURCES.slice(0, -1)) {
      assert.equal(src.match("zz-matches-nothing-zz"), false, `${src.name} claims anything`);
    }
  });

  // The rows the catalog route serves no-store are the personal sources.
  it("personal sources are exactly the rows served no-store", () => {
    // Spread: the sandbox's arrays come from another realm.
    const personal = [...CATALOG_SOURCES.filter((s) => s.kind === "personal").map((s) => s.name)].sort();
    assert.deepEqual(personal, [...STREMIO_LIVE_ROW_SOURCES].sort());
  });

  it("parseRef reads a source into a ref for its own provider only", () => {
    const tmdb = sb.providerAdapter("tmdb");
    const ref = tmdb.parseRef("  tmdb:chart:top_rated ");
    assert.equal(ref.source, "tmdb-chart");
    assert.equal(ref.provider, "tmdb");
    assert.equal(ref.kind, "chart");
    assert.equal(ref.arg, "top_rated");
    assert.equal(ref.url, "tmdb:chart:top_rated");
    assert.equal(tmdb.parseRef("https://www.themoviedb.org/tv/on-the-air").arg, "upcoming");
    assert.equal(sb.providerAdapter("trakt").parseRef("tmdb:chart:popular"), null);
    assert.equal(sb.providerAdapter("simkl").parseRef("simkl:user:watchlist:shows").arg, "watchlist:shows");
    assert.equal(sb.providerAdapter("mdblist").parseRef("alice/my-list").source, "mdblist");
    assert.equal(sb.providerAdapter("mylists").parseRef("customlist:v1:{}").source, "custom-list");
    for (const id of ["justwatch", "rapidapi", "tvmaze", "cinemeta"]) {
      assert.equal(sb.providerAdapter(id).parseRef("tmdb:chart:popular"), null, `${id} has no rows to parse`);
    }
  });

  it("Letterboxd is import only: its adapter reads list URLs, and detectSource leaves them alone", () => {
    const lb = sb.providerAdapter("letterboxd");
    const ref = lb.parseRef("https://letterboxd.com/Dave/list/official-top-250-narrative-feature-films/?by=rating");
    assert.equal(ref.provider, "letterboxd");
    assert.equal(ref.kind, "import");
    assert.equal(ref.user, "dave");
    assert.equal(ref.slug, "official-top-250-narrative-feature-films");
    assert.equal(lb.parseRef("https://www.letterboxd.com/dave/watchlist").slug, "watchlist");
    assert.equal(lb.parseRef("https://letterboxd.com/film/parasite-2019/"), null);
    assert.equal(lb.parseRef("https://letterboxd.com/dave/"), null);
    assert.equal(lb.parseRef("https://evil.com/letterboxd.com/dave/list/x"), null);
    assert.equal(lb.sources.length, 0);
    assert.equal(sb.detectSource("https://letterboxd.com/dave/list/x/"), "mdblist", "unchanged: the MDBList default");
  });

  // fetchCatalog through the registry against the frozen chain, with every
  // fetcher replaced by a recorder, over the whole corpus and several key sets.
  it("fetchCatalog calls the same fetcher with the same arguments, and counts the same API use", async () => {
    const K = { TMDB_API_KEY: "site-tmdb", MDBLIST_API_KEY: "site-mdblist", TRAKT_CLIENT_ID: "site-trakt", SIMKL_CLIENT_ID: "site-simkl" };
    vm.runInContext(Object.entries(K).map(([k, v]) => `${k} = ${JSON.stringify(v)};`).join("\n"), sb);

    let calls = [];
    const env = { tag: "env" };
    const ctx = { tag: "ctx" };
    const label = (v, entry, keys) => {
      if (v === entry) return "<entry>";
      if (v === keys) return "<keys>";
      if (v === env) return "<env>";
      if (v === ctx) return "<ctx>";
      return v;
    };
    const recorder = (name) => function (...args) {
      calls.push([name, args]);
      const out = [{ id: "tt0000001", name }];
      return name === "fetchChannelCatalog" ? out : Promise.resolve(out);
    };
    const f = { parseTmdbWebChartUrl: sb.parseTmdbWebChartUrl };
    for (const name of FETCHERS) {
      f[name] = recorder(name);
      sb[name] = f[name];
    }
    f.trackSharedApiUse = sb.trackSharedApiUse = (keys, isShared, provider) => { calls.push(["trackSharedApiUse", [keys, isShared, provider]]); };

    const keySets = [
      {},
      { mdblistKey: "own-mdblist" },
      { mdblistKey: "own-mdblist", mdblistAccessToken: "mdb-token" },
      { mdblistAccessToken: "mdb-token" },
      { traktKey: "own-trakt", traktAccessToken: "trakt-token" },
      { traktAccessToken: "trakt-token" },
      { tmdbKey: "own-tmdb", simklAccessToken: "simkl-token", region: "GB", hideNonDigitalReleases: true, origin: "https://o.example" },
    ];
    let compared = 0;
    for (const url of SOURCE_CORPUS) {
      for (const base of keySets) {
        for (const skip of [0, 100]) {
          const keys = { ...base, env, ctx };
          const entry = { id: "row", type: "movie", name: "Row", url };
          calls = [];
          await legacyDispatch(entry, skip, keys, f, K, legacy);
          const want = calls.map(([n, args]) => [n, args.map((a) => label(a, entry, keys))]);
          calls = [];
          await sb.fetchCatalog(entry, skip, keys);
          const got = calls.map(([n, args]) => [n, args.map((a) => label(a, entry, keys))]);
          assert.deepEqual(got, want, `different calls for ${JSON.stringify(url)} with ${JSON.stringify(base)} at skip ${skip}`);
          compared++;
        }
      }
    }
    assert.equal(compared, SOURCE_CORPUS.length * keySets.length * 2);
  });
});

// --- P4-4: the provider breaker ----------------------------------------------
//
// Fault injection through the real Worker: a fake TMDB that can be switched
// off, fresh isolates (the breaker's state is per isolate, shared through KV),
// and a clock the test moves. Hidden Gems asks TMDB for five pages at once
// and has no cache of its own, so one request is exactly five calls.

async function callIsolate(w, env, path) {
  const pending = [];
  const ctx = { waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})); } };
  const req = new Request("https://example.test" + path, { headers: { "CF-Connecting-IP": nextIp(), Origin: "https://example.test" } });
  const res = await w.fetch(req, env, ctx);
  await Promise.all(pending);
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body };
}

// TMDB, answering discover/chart pages with three titles and details with an
// IMDb id. `mode.status` set makes every TMDB call answer with it instead;
// `mode.timeout` makes them fail the way a call cut off by its timeout
// signal does.
function makeFakeTmdb(mode) {
  const calls = { tmdb: 0 };
  const handler = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname !== "api.themoviedb.org") return new Response("not here", { status: 404 });
    calls.tmdb++;
    if (mode.timeout) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }
    if (mode.status) return new Response("{}", { status: mode.status });
    const detail = /^\/3\/(movie|tv)\/(\d+)$/.exec(url.pathname);
    if (detail) {
      const id = Number(detail[2]);
      return Response.json({ id, title: "Title " + id, external_ids: { imdb_id: "tt" + String(9000000 + id) }, vote_average: 7 });
    }
    return Response.json({
      page: 1, total_results: 3, total_pages: 1,
      results: [1, 2, 3].map((id) => ({ id, title: "Title " + id, poster_path: "/p" + id + ".jpg", release_date: "2020-01-01" })),
    });
  };
  return { calls, handler };
}

describe("P4-4: the provider breaker", () => {
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  let clock = 0;
  const useClock = () => {
    clock = realNow.call(Date);
    Date.now = () => clock;
  };
  const restore = () => {
    globalThis.fetch = realFetch;
    Date.now = realNow;
  };

  // A KV that remembers the options each key was last written with.
  function kvWithOptions() {
    const kv = makeKv();
    const put = kv.put.bind(kv);
    kv._opts = new Map();
    kv.put = async (key, value, opts) => {
      kv._opts.set(key, opts || null);
      return put(key, value, opts);
    };
    return kv;
  }

  const GEMS = "/api/preview?url=tmdb:hidden-gems&type=movie";
  const CHART = "/api/preview?url=tmdb:chart:popular&type=movie";

  it("opens after five failures in a row, then refuses calls at once", async () => {
    useClock();
    try {
      const mode = { status: 503 };
      const tmdb = makeFakeTmdb(mode);
      globalThis.fetch = tmdb.handler;
      const kv = kvWithOptions();
      const env = makeEnv({ FF_PROVIDER_BREAKER: "1", TMDB_API_KEY: "k", CONFIGS: kv });
      const w = await freshIsolate();

      await callIsolate(w, env, GEMS);
      assert.equal(tmdb.calls.tmdb, 5, "the first request makes its five calls");
      const shared = JSON.parse(kv._store.get("pb:tmdb"));
      assert.ok(shared.openUntil > clock, "the opening is shared through KV");
      assert.equal(kv._opts.get("pb:tmdb").expirationTtl, 60);

      const second = await callIsolate(w, env, GEMS);
      assert.equal(tmdb.calls.tmdb, 5, "open: no call reaches TMDB");
      assert.equal(second.body.ok, false);

      // After a minute one call is let through, and one success closes it.
      clock += 61 * 1000;
      mode.status = 0;
      const third = await callIsolate(w, env, GEMS);
      assert.ok(tmdb.calls.tmdb > 5, "the trial call goes through");
      assert.equal(third.body.ok, true);
      const before = tmdb.calls.tmdb;
      await callIsolate(w, env, GEMS);
      assert.ok(tmdb.calls.tmdb > before, "closed again");
    } finally {
      restore();
    }
  });

  it("opens again on the first failure after it was let through", async () => {
    useClock();
    try {
      const mode = { status: 502 };
      const tmdb = makeFakeTmdb(mode);
      globalThis.fetch = tmdb.handler;
      const env = makeEnv({ FF_PROVIDER_BREAKER: "1", TMDB_API_KEY: "k" });
      const w = await freshIsolate();
      await callIsolate(w, env, GEMS);
      clock += 61 * 1000;
      await callIsolate(w, env, GEMS);
      const afterTrial = tmdb.calls.tmdb;
      assert.ok(afterTrial > 5 && afterTrial <= 10, "the trial request's calls went out");
      await callIsolate(w, env, GEMS);
      assert.equal(tmdb.calls.tmdb, afterTrial, "still down: open again straight away");
    } finally {
      restore();
    }
  });

  it("another isolate takes up the opening from KV without calling the provider", async () => {
    useClock();
    try {
      const tmdb = makeFakeTmdb({ status: 503 });
      globalThis.fetch = tmdb.handler;
      const env = makeEnv({ FF_PROVIDER_BREAKER: "1", TMDB_API_KEY: "k" });
      await callIsolate(await freshIsolate(), env, GEMS);
      assert.equal(tmdb.calls.tmdb, 5);
      await callIsolate(await freshIsolate(), env, GEMS);
      assert.equal(tmdb.calls.tmdb, 5, "a cold isolate reads pb:tmdb and fails fast");
    } finally {
      restore();
    }
  });

  it("serves the last good copy straight away while open", async () => {
    useClock();
    try {
      const mode = { status: 0 };
      const tmdb = makeFakeTmdb(mode);
      globalThis.fetch = tmdb.handler;
      const env = makeEnv({ FF_PROVIDER_BREAKER: "1", TMDB_API_KEY: "k" });
      const w = await freshIsolate();
      const good = await callIsolate(w, env, CHART);
      assert.equal(good.body.ok, true);
      assert.ok(good.body.count > 0);

      // The copy goes stale, TMDB goes down, and the breaker opens.
      clock += 20 * 60 * 1000;
      mode.status = 503;
      await callIsolate(w, env, GEMS);
      const calls = tmdb.calls.tmdb;
      const served = await callIsolate(w, env, CHART);
      assert.equal(tmdb.calls.tmdb, calls, "no call while open");
      assert.equal(served.body.ok, true, "the stale chart is served");
      assert.equal(served.body.count, good.body.count);
    } finally {
      restore();
    }
  });

  it("a timeout counts as a failure", async () => {
    try {
      const tmdb = makeFakeTmdb({ timeout: true });
      globalThis.fetch = tmdb.handler;
      const env = makeEnv({ FF_PROVIDER_BREAKER: "1", TMDB_API_KEY: "k" });
      const w = await freshIsolate();
      await callIsolate(w, env, GEMS);
      assert.equal(tmdb.calls.tmdb, 5);
      // The request answers at the first page that fails; let the other four
      // time out too, as they would while the next request came in.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await callIsolate(w, env, GEMS);
      assert.equal(tmdb.calls.tmdb, 5, "five timeouts opened it");
    } finally {
      restore();
    }
  });

  it("a 401 or 404 is an answer, not a failure", async () => {
    try {
      const mode = { status: 401 };
      const tmdb = makeFakeTmdb(mode);
      globalThis.fetch = tmdb.handler;
      const env = makeEnv({ FF_PROVIDER_BREAKER: "1", TMDB_API_KEY: "k" });
      const w = await freshIsolate();
      for (let i = 0; i < 3; i++) await callIsolate(w, env, GEMS);
      mode.status = 404;
      for (let i = 0; i < 3; i++) await callIsolate(w, env, GEMS);
      assert.equal(tmdb.calls.tmdb, 30, "every request still reaches TMDB");
      assert.equal(env.CONFIGS._store.has("pb:tmdb"), false);
    } finally {
      restore();
    }
  });

  it("is off without FF_PROVIDER_BREAKER: every request still calls the provider", async () => {
    try {
      const tmdb = makeFakeTmdb({ status: 503 });
      globalThis.fetch = tmdb.handler;
      const env = makeEnv({ TMDB_API_KEY: "k" });
      const w = await freshIsolate();
      for (let i = 0; i < 3; i++) await callIsolate(w, env, GEMS);
      assert.equal(tmdb.calls.tmdb, 15);
      assert.equal(env.CONFIGS._store.has("pb:tmdb"), false);
    } finally {
      restore();
    }
  });

  it("an opening in one provider leaves the others alone", async () => {
    try {
      const tmdb = makeFakeTmdb({ status: 503 });
      const other = { calls: 0 };
      globalThis.fetch = async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input.url);
        if (url.hostname === "api.trakt.tv") {
          other.calls++;
          return Response.json([]);
        }
        return tmdb.handler(input, init);
      };
      const env = makeEnv({ FF_PROVIDER_BREAKER: "1", TMDB_API_KEY: "k", TRAKT_CLIENT_ID: "t" });
      const w = await freshIsolate();
      await callIsolate(w, env, GEMS);
      await callIsolate(w, env, "/api/preview?url=trakt:chart:trending&type=movie");
      assert.ok(other.calls > 0, "Trakt is still called");
    } finally {
      restore();
    }
  });

  it("writes one metrics point per provider, at most once a minute", async () => {
    useClock();
    try {
      const tmdb = makeFakeTmdb({ status: 503 });
      globalThis.fetch = tmdb.handler;
      const points = [];
      const env = makeEnv({ FF_PROVIDER_BREAKER: "1", TMDB_API_KEY: "k", ANALYTICS: { writeDataPoint: (p) => points.push(p) } });
      const w = await freshIsolate();
      await callIsolate(w, env, GEMS);
      const first = points.filter((p) => p.indexes[0] === "provider");
      assert.equal(first.length, 1);
      assert.deepEqual(first[0].blobs, ["provider", "tmdb", "open"]);
      const [calls, failed, refused, , opened] = first[0].doubles;
      assert.deepEqual([calls, failed, refused, opened], [5, 5, 0, 1]);

      await callIsolate(w, env, GEMS);
      assert.equal(points.filter((p) => p.indexes[0] === "provider").length, 1, "not again within the minute");
      clock += 61 * 1000;
      await callIsolate(w, env, "/api/health-nothing-here");
      const later = points.filter((p) => p.indexes[0] === "provider");
      assert.equal(later.length, 2);
      assert.equal(later[1].doubles[2], 5, "the refused calls of the second request are counted");
    } finally {
      restore();
    }
  });
});
