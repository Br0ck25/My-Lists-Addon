// CQ-04 step 2. Two places build the Trakt "continue watching" candidates:
//   * fetchTraktContinueWatching (catalog 06_): the shelf Stremio/Nuvio show.
//   * apiTraktMyPrivateLists (api 77_): the "Trakt Continue Watching" list the
//     website offers in Settings > My Lists (and the importer reads).
// Both read the same Trakt data (playback, watched shows, progress, hidden).
// This feeds both the same mocked Trakt answers and compares WHICH titles
// (movie, or show + season + episode) each returns, in order. Cases where they
// differ today are marked todo with the reason; the owner decides which side is
// right before either is changed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { call, makeEnv, makeD1 } from "./harness.mjs";

// The shelf function is not exported from the Worker: load the bundle once more
// with it added to the end (the same trick harness.mjs uses for the copy engines).
const bundle = readFileSync(new URL("../worker_entry_combined.js", import.meta.url), "utf8");
const tmpFile = `${tmpdir()}/mla-cw-${process.pid}-${Date.now()}.mjs`;
writeFileSync(tmpFile, bundle + "\nexport const __cw = { fetchTraktContinueWatching };\n");
const { __cw } = await import(pathToFileURL(tmpFile).href).finally(() => unlinkSync(tmpFile));

const PAST = "2020-01-01T00:00:00.000Z";
const ids = (n, extra = {}) => ({ trakt: n, imdb: `tt${n}`, tmdb: n + 5000, slug: `show-${n}`, ...extra });
const show = (n, extra = {}) => ({ title: `Show ${n}`, year: 2010, ids: ids(n, extra) });
const movie = (n, extra = {}) => ({ title: `Movie ${n}`, year: 2000, ids: ids(n, extra) });
const pbEpisode = (n, s, e, epIds) => ({ id: n * 10, type: "episode", progress: 40.4, paused_at: PAST, show: show(n), episode: { season: s, number: e, title: `Ep ${e}`, ids: epIds } });
const pbMovie = (n) => ({ id: n * 10, type: "movie", progress: 12.2, paused_at: PAST, movie: movie(n) });
const watched = (n, at, extra) => ({ last_watched_at: at, show: show(n, extra) });
const nextEp = (s, e) => ({ aired: 10, completed: 4, last_watched_at: PAST, next_episode: { season: s, number: e, title: `N${e}`, first_aired: PAST } });

// data: { playback, watched, hidden: {progress, dropped, reset}, progress: {traktId: progressBody} }
function installTrakt(data) {
  const json = (b) => Response.json(b);
  const real = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname !== "api.trakt.tv") return new Response("{}", { status: 404 });
    const p = url.pathname;
    if (p.startsWith("/sync/playback")) return json(data.playback || []);
    if (p === "/users/me/watched/shows") return json(data.watched || []);
    if (p === "/users/hidden/progress_watched") return json((data.hidden || {}).progress || []);
    if (p === "/users/hidden/dropped") return json((data.hidden || {}).dropped || []);
    if (p === "/users/hidden/progress_watched_reset") return json((data.hidden || {}).reset || []);
    const m = p.match(/^\/shows\/([^/]+)\/progress\/watched$/);
    if (m) return data.progress && data.progress[m[1]] ? json(data.progress[m[1]]) : new Response("{}", { status: 404 });
    if (p === "/users/me") return json({ username: "me", ids: { slug: "me" } });
    return json([]);
  };
  return () => { globalThis.fetch = real; };
}

let tokenSeq = 0;
// What the Worker's own shelf returns, reduced to titles.
async function shelfTitles(data) {
  const restore = installTrakt(data);
  try {
    const env = makeEnv({ DB: makeD1(), TRAKT_CLIENT_ID: "cid" });
    const metas = await __cw.fetchTraktContinueWatching({ type: "mixed" }, 0, "cid", `shelf-${++tokenSeq}`, env, { waitUntil() {} });
    return metas.map((m) => (m.type === "series" ? `${m.id}:${m.season}:${m.episode}` : m.id));
  } finally { restore(); }
}
// What the website's list route exposes for the same Trakt data.
async function routeTitles(data) {
  const restore = installTrakt(data);
  try {
    const env = makeEnv({ DB: makeD1(), TRAKT_CLIENT_ID: "cid" });
    const r = await call(env, "/api/trakt-my-private-lists", { method: "POST", json: { accessToken: `route-${++tokenSeq}` } });
    assert.equal(r.body.ok, true);
    const entry = r.body.lists.find((l) => l.slug === "continue-watching");
    assert.ok(entry, "the route lists a Continue Watching entry");
    return entry.items.map((i) => i.id);
  } finally { restore(); }
}
async function both(data) { return { shelf: await shelfTitles(data), route: await routeTitles(data) }; }

describe("Trakt continue watching: shelf (fetchTraktContinueWatching) vs list route", () => {
  it("agree on a paused episode and a paused movie", async () => {
    const { shelf, route } = await both({ playback: [pbMovie(2), pbEpisode(1, 2, 3)] });
    assert.deepEqual(shelf, ["tt2", "tt1:2:3"], "the mock really produces both titles");
    assert.deepEqual(route, shelf);
  });

  it("agree that a hidden or dropped show is left out of playback and up next", async () => {
    const { shelf, route } = await both({
      playback: [pbEpisode(1, 1, 1), pbEpisode(3, 1, 1)],
      watched: [watched(2, "2024-05-01T00:00:00Z")],
      hidden: { dropped: [{ show: show(1) }], reset: [{ show: show(2) }] },
      progress: { 2: nextEp(1, 5), 3: nextEp(1, 5) },
    });
    assert.deepEqual(shelf, ["tt3:1:1"]);
    assert.deepEqual(route, shelf);
  });

  it("agree on the next unwatched episode of a show with no paused playback, newest watch first", async () => {
    const { shelf, route } = await both({
      watched: [watched(5, "2024-01-01T00:00:00Z"), watched(6, "2024-06-01T00:00:00Z")],
      progress: { 5: nextEp(2, 3), 6: nextEp(1, 7) },
    });
    assert.deepEqual(shelf, ["tt6:1:7", "tt5:2:3"], "the mock really produces both titles");
    assert.deepEqual(route, shelf);
  });

  it("agree that a show already paused in playback gets no second 'next episode' row", async () => {
    const { shelf, route } = await both({
      playback: [pbEpisode(1, 1, 2)],
      watched: [watched(1, "2024-06-01T00:00:00Z")],
      progress: { 1: nextEp(1, 3) },
    });
    assert.deepEqual(shelf, ["tt1:1:2"]);
    assert.deepEqual(route, shelf);
  });

  it("agree that an episode that has not aired yet is not offered", async () => {
    const { shelf, route } = await both({
      watched: [watched(7, "2024-06-01T00:00:00Z")],
      progress: { 7: { aired: 4, completed: 4, last_watched_at: PAST, next_episode: { season: 1, number: 5, title: "x", first_aired: "2999-01-01T00:00:00.000Z" } } },
    });
    assert.deepEqual(shelf, []);
    assert.deepEqual(route, shelf);
  });

  // ---- differences found (nothing below is changed by this commit) ----

  it("agree on a paused episode when Trakt gives the episode its own ids", async () => {
    const { shelf, route } = await both({ playback: [pbEpisode(1, 2, 3, { trakt: 777, tmdb: 9001, imdb: "tt9001" })] });
    assert.deepEqual(shelf, ["tt1:2:3"]);
    assert.deepEqual(route, shelf);
  });

  it("agree on how many 'next episode' rows a long watched history gives", { todo: "DIFFERENT: the shelf looks at the 15 most recently watched shows, the list route at the 40 most recent, so a heavy watcher sees up to 15 rows on the shelf but up to 40 in the website list." }, async () => {
    const many = Array.from({ length: 20 }, (_, i) => 100 + i);
    const { shelf, route } = await both({
      watched: many.map((n, i) => watched(n, `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`)),
      progress: Object.fromEntries(many.map((n) => [n, nextEp(1, 2)])),
    });
    assert.equal(shelf.length, 15, "the mock really gives the shelf its cap");
    assert.deepEqual(route, shelf);
  });

  it("agree on a show Trakt knows only by its Trakt id", { todo: "DIFFERENT: with no IMDB or TMDB id the shelf drops the row (Stremio cannot open it) but the list route keeps it under its Trakt id." }, async () => {
    const bare = { title: "Bare", year: 2011, ids: { trakt: 42 } };
    const { shelf, route } = await both({
      watched: [{ last_watched_at: "2024-06-01T00:00:00Z", show: bare }],
      progress: { 42: nextEp(1, 2) },
    });
    assert.deepEqual(shelf, []);
    assert.deepEqual(route, shelf);
  });

  it("agree that a show paused under an upper-case IMDB id is not repeated as 'next episode'", { todo: "DIFFERENT: the shelf lowercases IMDB ids (and also matches on slug) when deciding a show is already in playback; the list route compares IMDB ids exactly, so a show Trakt pauses as TT8 but lists as tt8 appears twice in the website list." }, async () => {
    const { shelf, route } = await both({
      playback: [{ id: 80, type: "episode", progress: 10, paused_at: PAST, show: { title: "Show 8", year: 2010, ids: { imdb: "TT8", slug: "show-8" } }, episode: { season: 1, number: 2, title: "e" } }],
      watched: [{ last_watched_at: "2024-06-01T00:00:00Z", show: { title: "Show 8", year: 2010, ids: { trakt: 8, imdb: "tt8", tmdb: 5008, slug: "show-8" } } }],
      progress: { 8: nextEp(1, 3) },
    });
    assert.deepEqual(shelf, ["TT8:1:2"], "the shelf shows the paused episode once");
    assert.deepEqual(route, shelf);
  });
});
