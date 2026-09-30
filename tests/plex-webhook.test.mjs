// A Plex episode play through the media server webhook (26_), with TMDB faked.
//
// Plex's current agent sends an episode's OWN ids in Metadata.Guid (the
// episode's IMDb, TMDB and TheTVDB ids) and names the show only as
// plex://show/..., which means nothing outside Plex. The webhook used to read
// the episode's IMDb id as the show's: TMDB found no show by it, so the play
// was stored with no poster and no next episode in Continue Watching.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { call, createUser, makeD1, makeEnv, makeKv, nextIp } from "./harness.mjs";

const SHOW = { id: 1399, name: "A Show", first_air_date: "2011-04-17", poster_path: "/show.jpg" };
const SHOW_IMDB = "tt0944947";
const EP1_IMDB = "tt1480055";
const EP1_TVDB = "3254641";
const SHOW_TVDB = "121361";

let restoreFetch = null;
let asked = [];
function fakeTmdb() {
  asked = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname !== "api.themoviedb.org") return new Response("{}", { status: 404 });
    const p = url.pathname;
    const source = url.searchParams.get("external_source");
    asked.push(p + (source ? "?" + source : ""));
    const episodeHit = { tv_episode_results: [{ id: 63056, show_id: SHOW.id, season_number: 1, episode_number: 1 }], tv_results: [], movie_results: [] };
    if (p === "/3/find/" + EP1_IMDB && source === "imdb_id") return Response.json(episodeHit);
    if (p === "/3/find/" + EP1_TVDB && source === "tvdb_id") return Response.json(episodeHit);
    if (p === "/3/find/" + SHOW_TVDB && source === "tvdb_id") return Response.json({ tv_results: [SHOW], tv_episode_results: [], movie_results: [] });
    if (p === "/3/find/" + SHOW_IMDB) return Response.json({ tv_results: [SHOW], movie_results: [] });
    if (p.startsWith("/3/find/")) return Response.json({ tv_results: [], movie_results: [], tv_episode_results: [] });
    if (p === "/3/tv/1399") {
      return Response.json({ ...SHOW, external_ids: { imdb_id: SHOW_IMDB }, number_of_seasons: 1, seasons: [{ season_number: 1, episode_count: 3 }] });
    }
    if (p === "/3/tv/1399/season/1") {
      return Response.json({
        season_number: 1,
        episodes: [1, 2, 3].map((n) => ({ id: 100 + n, episode_number: n, season_number: 1, name: "Episode " + n, air_date: "2011-04-1" + n })),
      });
    }
    return new Response("{}", { status: 404 });
  };
  restoreFetch = () => { globalThis.fetch = realFetch; };
}
afterEach(() => { if (restoreFetch) restoreFetch(); restoreFetch = null; });

async function plexPlay(metadata) {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1(), TMDB_API_KEY: "test-tmdb-key" });
  const u = await createUser(env, "plexposter" + Math.floor(Math.random() * 1e6));
  const cred = { creatorName: u.creatorName, creatorKey: u.creatorKey };
  const tok = await call(env, "/api/creator/scrobble-token", { method: "POST", ip: nextIp(), json: cred });
  const r = await call(env, "/api/scrobble?st=" + encodeURIComponent(tok.body.token), {
    method: "POST", ip: nextIp(), json: { event: "media.scrobble", Account: { title: "owner" }, Metadata: metadata },
  });
  assert.equal(r.status, 200);
  assert.match(String(r.body.matched), /^yes/, JSON.stringify(r.body));
  const loaded = await call(env, "/api/creator/sync/load", { method: "POST", json: cred });
  return loaded.body.data;
}

const episodeOne = (extra) => ({
  type: "episode",
  title: "Episode 1",
  grandparentTitle: SHOW.name,
  parentTitle: "Season 1",
  parentIndex: 1,
  index: 1,
  guid: "plex://episode/5d9c1275e98e47001eb84d13",
  parentGuid: "plex://season/602e67a888a2fd002c37fe54",
  grandparentGuid: "plex://show/5d9c086c46115600200aa2fe",
  ...extra,
});

function assertShowPlay(data) {
  const wh = data.watchHistory[0];
  assert.equal(wh.showId, SHOW_IMDB, "the play was filed under the episode's id, not the show's");
  assert.equal(wh.showPoster, "https://image.tmdb.org/t/p/w500/show.jpg");
  assert.equal(wh.poster, "https://image.tmdb.org/t/p/w500/show.jpg");
  const cw = data.continueWatching.find((it) => it.showId === SHOW_IMDB);
  assert.ok(cw, "no next episode in Continue Watching");
  assert.equal(cw.episodeNum, 2);
  assert.equal(cw.poster, "https://image.tmdb.org/t/p/w500/show.jpg");
}

describe("Plex episode plays are filed under the show, with its poster", () => {
  it("finds the show from the episode's own IMDb id (Plex's current agent)", async () => {
    fakeTmdb();
    const data = await plexPlay(episodeOne({
      Guid: [{ id: "imdb://" + EP1_IMDB }, { id: "tmdb://63056" }, { id: "tvdb://" + EP1_TVDB }],
    }));
    assertShowPlay(data);
    assert.ok(asked.includes("/3/find/" + EP1_IMDB + "?imdb_id"));
    // The episode's TMDB id is not a show id, and was never asked about as one.
    assert.ok(!asked.includes("/3/tv/63056"));
  });

  it("falls back to the episode's TheTVDB id", async () => {
    fakeTmdb();
    const data = await plexPlay(episodeOne({ Guid: [{ id: "tvdb://" + EP1_TVDB }] }));
    assertShowPlay(data);
  });

  it("reads the show's TheTVDB id from Plex's older agent", async () => {
    fakeTmdb();
    const data = await plexPlay(episodeOne({
      guid: "com.plexapp.agents.thetvdb://" + SHOW_TVDB + "/1/1?lang=en",
      grandparentGuid: "com.plexapp.agents.thetvdb://" + SHOW_TVDB + "?lang=en",
      parentGuid: "com.plexapp.agents.thetvdb://" + SHOW_TVDB + "/1?lang=en",
    }));
    assertShowPlay(data);
  });

  it("still takes a show id Plex does share", async () => {
    fakeTmdb();
    const data = await plexPlay(episodeOne({ grandparentGuid: "imdb://" + SHOW_IMDB, Guid: [{ id: "imdb://" + EP1_IMDB }] }));
    assertShowPlay(data);
  });
});
