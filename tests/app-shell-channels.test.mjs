import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadClient, requestsTo } from "./client-harness.mjs";

// The shell's Channels screen (Phase 6, P6-7, E2E scenario 6): "I want to
// create a channel" becomes choose a template, look at today's lineup, then
// add it to the home screen.
//
// Two things these tests are actually pinning:
//
//   1. Templates wrap the page's own builders -- TV network and From a list
//      go through quickAddChannel, a saga through the Storylines machinery,
//      an actor through the shared spotlight pick builder, and Custom through
//      the legacy builder itself. Nothing here is a second implementation of
//      "make a channel", and a test that stubs one of those functions is
//      checking that the wrap is still there.
//   2. Nothing lands in the config until "Add to home screen" is pressed: a
//      build saves the channel to this browser (saveLocalChannel) and shows
//      the server's lineup, and the row is added by the page's own
//      toggleChannelInCatalog afterwards.
//
// The files are loaded from the real shell page and driven through the real
// functions, the same way the other app-shell suites work.

const ACCOUNT = { id: 7, username: "alice", displayName: "Alice" };

const LINEUP = {
  ok: true,
  rotating: true,
  plan: { shows: 24, episodes: 3, turnover: 0 },
  poolSize: 900,
  unappliedRules: [],
  generatedAt: 1,
  items: [
    { kind: "episode", showName: "Breaking Bad", season: 1, episode: 1, title: "Breaking Bad S1E1 — Pilot", poster: "https://img.example/bb.jpg", thumbnail: "https://img.example/bb.jpg" },
    { kind: "episode", showName: "The Wire", season: 1, episode: 1, title: "The Wire S1E1 — The Target", poster: "https://img.example/wire.jpg", thumbnail: "https://img.example/wire.jpg" },
  ],
};

function channelRoutes(overrides) {
  return Object.assign({
    "/api/channel-lineup": async () => ({ json: LINEUP }),
    "/api/person-search": async () => ({ json: { ok: true, results: [{ personId: 5, name: "Christopher Lloyd", knownFor: "Back to the Future", department: "Acting" }] } }),
    "/api/person-credits": async () => ({
      json: {
        ok: true, name: "Christopher Lloyd", poster: "https://img.example/cl.jpg", backdrop: null,
        movies: [{ tmdbId: 105, title: "Back to the Future", year: 1985, poster: "https://img.example/btf.jpg", rating: 8.3, released: "1985-07-03" }],
        shows: [{ tmdbId: 1400, title: "Taxi", year: 1978, poster: "https://img.example/taxi.jpg", rating: 7.8 }],
      },
    }),
    "/api/resolve-movie": async () => ({ json: { ok: true, imdbId: "tt0088763", runtime: 116 } }),
    "/api/person-show-episodes": async () => ({
      json: { ok: true, regular: true, imdbId: "tt0077089", poster: "https://img.example/taxi.jpg", showName: "Taxi",
        episodes: [{ season: 1, episode: 1, name: "Like Father, Like Daughter", released: "1978-09-12", runtime: 24, thumbnail: "https://img.example/t1.jpg" }] },
    }),
  }, overrides || {});
}

function loadChannelsClient(overrides, opts) {
  const o = opts || {};
  const client = loadClient({
    signedIn: o.signedIn === false ? false : true,
    routes: channelRoutes(overrides),
    storage: o.storage || {},
  });
  if (o.signedIn !== false) client.call("appShellState.set", { account: ACCOUNT });
  return client;
}

function host(client) {
  return client.__byId.get("appShellChannels").innerHTML;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function byId(client, id) {
  client.call("document.getElementById", id);
  return client.__byId.get(id);
}

function toastsOf(client) {
  const seen = [];
  client.set("showToast", (msg, kind) => seen.push({ msg: String(msg), kind }));
  return seen;
}

// Lets an unawaited follow-up (a preview fetch fired after a build) land.
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

// The payload a request carried as a channel url.
function payloadOf(body) {
  return JSON.parse(String(body.url).slice("channel:v1:".length));
}

describe("the shell's Channels screen", () => {
  it("offers the five templates with no inline handlers", async () => {
    const client = loadChannelsClient();
    client.call("appShellRenderChannels");
    const markup = host(client);
    assert.match(markup, /New channel/);
    for (const title of ["TV network", "Franchise or universe", "Actor or creator", "From a list", "Custom"]) {
      assert.ok(markup.includes(title), `${title} is missing from the templates`);
    }
    assert.equal((markup.match(/data-app-shell-action="chan-template"/g) || []).length, 5);
    assert.equal(/on[a-z]+=/.test(markup), false, "the screen must not add inline handlers");
  });

  it("renders when the Channels view is opened, and when the page is served at it", async () => {
    const client = loadChannelsClient();
    // Boot already rendered it (the page's own boot check), so an explicit
    // route change has to be able to render it again rather than throw.
    assert.equal(client.call("appShellApplyRoute", { tab: "channels", sub: "my-channels" }), true);
    assert.match(host(client), /New channel/);
    assert.match(host(client), /Choose a template/);
  });

  it("signed out, a saga is offered and the rest ask for an account", async () => {
    const client = loadChannelsClient({}, { signedIn: false });
    client.call("appShellChannelsAction", "chan-template", "saga");
    let markup = host(client);
    assert.ok(markup.includes('id="appShellChannelSagaSelect"'), "a saga needs no account (D-8)");
    assert.equal(markup.includes("Sign in first"), false);

    await client.call("appShellChannelsAction", "chan-template", "network");
    markup = host(client);
    assert.match(markup, /Sign in first/);
    assert.ok(markup.includes('data-app-shell-action="chan-account"'));
    assert.equal(requestsTo(client, "/api/channel-lineup").length, 0);
  });

  it("says so when the network buttons are not on the page", async () => {
    const client = loadChannelsClient();
    // The harness's DOM reads back nothing, which is exactly the case the
    // screen has to survive: no Quick Add markup, no silent empty select.
    assert.deepEqual(plain(client.call("appShellChannelNetworks")), []);
    client.call("appShellChannelsAction", "chan-template", "network");
    const markup = host(client);
    assert.match(markup, /network list is not on this page yet/);
    assert.equal(markup.includes('id="appShellChannelNetworkSelect"'), false);
  });

  it("builds a TV network through the page's own quickAddChannel, and previews the server's lineup", async () => {
    const client = loadChannelsClient();
    client.set("appShellChannelNetworks", () => [{ networkId: "49", name: "HBO" }]);
    const calls = [];
    client.set("quickAddChannel", async (name, listUrl, networkId, btn, options) => {
      calls.push({ name, listUrl, networkId, options });
      return { channelId: "ch-hbo", name, items: new Array(120).fill({ kind: "episode" }), dailyRotate: true };
    });
    client.call("appShellChannelsAction", "chan-template", "network");
    byId(client, "appShellChannelNetworkSelect").value = "49";
    assert.equal(await client.call("appShellChannelsAction", "chan-build"), true);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "HBO");
    assert.equal(calls[0].networkId, "49");
    assert.equal(calls[0].listUrl, null);
    assert.equal(calls[0].options.addToCatalog, false, "the row is added after the preview, not during the build");
    assert.equal(calls[0].options.preferPreset, true, "a default schedule can use the server's preset");
    assert.equal(calls[0].options.maxEpisodesPerShow, 50);
    assert.equal(calls[0].options.schedule.dailyRotate, true);

    const draft = client.get("appShellChannelDraft");
    assert.equal(draft.channelId, "ch-hbo");
    assert.equal(draft.poolSize, 120);
    assert.match(draft.url, /^channel:v1:/);
    await tick();
    const lineup = requestsTo(client, "/api/channel-lineup");
    assert.equal(lineup.length, 1);
    assert.equal(lineup[0].method, "POST");
    assert.equal(plain(lineup[0].body).url, draft.url, "the preview asks about the exact url a row would carry");

    const markup = host(client);
    assert.match(markup, /Today\u2019s lineup/);
    assert.match(markup, /24 shows a day/);
    assert.match(markup, /3 episodes a block/);
    assert.match(markup, /900 episodes in the pool/);
    assert.match(markup, /rotates daily/);
    assert.match(markup, /Breaking Bad/);
    assert.match(markup, /https:\/\/img.example\/bb.jpg/);
    assert.ok(markup.includes('data-app-shell-action="chan-home"'), "the one toggle is missing");
    assert.equal(/on[a-z]+=/.test(markup), false);
  });

  it("adds and removes one row with the page's own toggle", async () => {
    const client = loadChannelsClient();
    client.set("appShellChannelNetworks", () => [{ networkId: "49", name: "HBO" }]);
    client.set("quickAddChannel", async (name) => ({ channelId: "ch-hbo", name, items: [{ kind: "episode" }] }));
    let inConfig = false;
    const toggled = [];
    client.set("isChannelInConfig", (channelId) => { assert.equal(channelId, "ch-hbo"); return inConfig; });
    client.set("toggleChannelInCatalog", (channelId) => { toggled.push(channelId); inConfig = !inConfig; });

    client.call("appShellChannelsAction", "chan-template", "network");
    byId(client, "appShellChannelNetworkSelect").value = "49";
    await client.call("appShellChannelsAction", "chan-build");
    await tick();
    assert.match(host(client), /Add to home screen/);

    assert.equal(await client.call("appShellChannelsAction", "chan-home", "on"), true);
    assert.deepEqual(toggled, ["ch-hbo"]);
    assert.match(host(client), /On your home screen/, "the button has to follow what is in the config");

    assert.equal(await client.call("appShellChannelsAction", "chan-home", "off"), true);
    assert.deepEqual(toggled, ["ch-hbo", "ch-hbo"]);
    assert.match(host(client), /Add to home screen/);
    assert.match(host(client), /saved in My Channels either way/);
  });

  it("takes a saga's canon order through the Storylines machinery, signed out", async () => {
    const client = loadChannelsClient({}, { signedIn: false });
    const items = [
      { kind: "movie", imdbId: "tt0458339", title: "Captain America: The First Avenger", showName: "Captain America: The First Avenger", epName: "Movie", poster: "https://img.example/ca.jpg", backdrop: "https://img.example/ca-b.jpg" },
      { kind: "movie", imdbId: "tt4154664", title: "Captain Marvel", showName: "Captain Marvel", epName: "Movie", poster: "https://img.example/cm.jpg" },
    ];
    const fetched = [];
    client.set("fetchStorylineOrderedItems", async (eventId) => {
      fetched.push(eventId);
      return { event: { id: eventId, name: "Marvel Cinematic Universe: The Infinity Saga" }, items };
    });
    const added = [];
    client.set("createInstantStorylineChannel", (eventId) => { added.push(eventId); });

    client.call("appShellChannelsAction", "chan-template", "saga");
    byId(client, "appShellChannelSagaSelect").value = "movie_mcu_infinity_saga";
    assert.equal(await client.call("appShellChannelsAction", "chan-build"), true);
    assert.deepEqual(fetched, ["movie_mcu_infinity_saga"]);

    await tick();
    const body = plain(requestsTo(client, "/api/channel-lineup")[0].body);
    const payload = payloadOf(body);
    assert.equal(payload.channelId, "channel-movie_mcu_infinity_saga");
    assert.equal(payload.storylineId, "movie_mcu_infinity_saga", "a saga row is recognized by its storylineId server-side");
    assert.equal(payload.catalogOnly, true, "a saga row is not copied into My Channels");
    assert.equal(payload.items.length, 2);
    assert.equal(payload.poster, "https://img.example/ca.jpg");

    assert.equal(await client.call("appShellChannelsAction", "chan-home", "on"), true);
    assert.deepEqual(added, ["movie_mcu_infinity_saga"], "the Storylines tab's own add is what puts the row in");
  });

  it("builds Actor or creator through the shared spotlight pick builder", async () => {
    const client = loadChannelsClient();
    const saved = [];
    client.set("saveLocalChannel", (payload) => saved.push(payload));
    client.set("generateChannelId", () => "ch-lloyd");

    assert.equal(await client.call("appShellChannelsAction", "chan-template", "person"), true);
    byId(client, "appShellChannelPersonQuery").value = "Christopher Lloyd";
    assert.equal(await client.call("appShellChannelsAction", "chan-person-search"), true);
    assert.match(host(client), /Christopher Lloyd/);
    assert.equal(await client.call("appShellChannelsAction", "chan-person-pick", "5"), true);
    assert.match(host(client), /Building from/);

    assert.equal(await client.call("appShellChannelsAction", "chan-build"), true);
    assert.equal(requestsTo(client, "/api/person-credits").length, 1);
    assert.equal(saved.length, 1);
    const payload = saved[0];
    assert.equal(payload.channelId, "ch-lloyd");
    assert.equal(payload.name, "Christopher Lloyd Spotlight");
    assert.equal(payload.items.length, 2, "a film and an episode the person was in");
    assert.equal(payload.items[0].kind, "movie");
    assert.equal(payload.items[0].imdbId, "tt0088763", "a film's id IS the stream request, so it is resolved");
    assert.equal(payload.items[1].kind, "episode");
    assert.equal(payload.items[1].season, 1);
    assert.match(payload.items[1].title, /Taxi S1E1/);
    // Same traversal the legacy Spotlight uses -- one implementation, and no
    // row anywhere yet.
    assert.equal(client.get("appShellChannelDraft").channelId, "ch-lloyd");
    await tick();
    assert.equal(requestsTo(client, "/api/channel-lineup").length, 1);
  });

  it("takes From a list, with live sync, through quickAddChannel too", async () => {
    const client = loadChannelsClient();
    const calls = [];
    client.set("quickAddChannel", async (name, listUrl, networkId, btn, options) => {
      calls.push({ name, listUrl, networkId, options });
      return { channelId: "ch-sitcoms", name, items: [{ kind: "episode" }] };
    });
    client.call("appShellChannelsAction", "chan-template", "list");
    byId(client, "appShellChannelListUrl").value = "https://mdblist.com/lists/kit/sitcoms";
    byId(client, "appShellChannelNameInput").value = "Sitcom Central";
    // Ticked in the rendered HTML; the DOM stub cannot read that, so a test
    // ticks it the way a person would.
    byId(client, "appShellChannelLiveSyncCheck").checked = true;
    assert.equal(await client.call("appShellChannelsAction", "chan-build"), true);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "Sitcom Central");
    assert.equal(calls[0].listUrl, "https://mdblist.com/lists/kit/sitcoms");
    assert.equal(calls[0].options.liveSync, true);
    assert.equal(calls[0].options.addToCatalog, false);

    // A blank name falls back to the list's own last path segment.
    assert.equal(client.call("appShellChannelListNameFromUrl", "https://mdblist.com/lists/kit/sitcoms"), "Sitcoms");
    assert.equal(client.call("appShellChannelListNameFromUrl", "https://trakt.tv/users/kit/lists/my-shows"), "My shows");
  });

  it("carries the schedule options into the build, and skips the preset when they are not its defaults", async () => {
    const client = loadChannelsClient();
    client.set("appShellChannelNetworks", () => [{ networkId: "49", name: "HBO" }]);
    const calls = [];
    client.set("quickAddChannel", async (name, listUrl, networkId, btn, options) => {
      calls.push({ networkId, options });
      return { channelId: "ch-1", name, items: [] };
    });
    client.call("appShellChannelsAction", "chan-template", "network");
    byId(client, "appShellChannelNetworkSelect").value = "49";

    // Off, then 12 shows, interleaved, hiding watched.
    assert.equal(await client.call("appShellChannelsAction", "chan-rotate", "off"), true);
    byId(client, "appShellChannelRotateShows").value = "12";
    byId(client, "appShellChannelRotateEpisodes").value = "4";
    byId(client, "appShellChannelPerShow").value = "25";
    byId(client, "appShellChannelOrderSelect").value = "interleave";
    assert.equal(await client.call("appShellChannelsAction", "chan-hide-watched", "on"), true);
    assert.match(host(client), /Daily rotation: off/);
    await client.call("appShellChannelsAction", "chan-build");

    const schedule = calls[0].options.schedule;
    assert.equal(schedule.dailyRotate, false);
    assert.equal(schedule.rotateShows, 0, "a channel that does not rotate stores no shows-per-day");
    assert.equal(schedule.rotateEpisodes, 0);
    assert.equal(schedule.autoSort, "interleave");
    assert.equal(schedule.sortByAired, false);
    assert.equal(schedule.shuffle, false);
    assert.equal(schedule.hideWatched, true);
    assert.equal(calls[0].options.maxEpisodesPerShow, 25);
    assert.equal(calls[0].options.preferPreset, false, "the server's preset is not this channel");

    // Back to the defaults the preset is: rotation on, 24 x 3, as listed. The
    // three numbers are read out of their inputs when a build starts, which is
    // also when the state catches up with them.
    await client.call("appShellChannelsAction", "chan-rotate", "on");
    await client.call("appShellChannelsAction", "chan-hide-watched", "off");
    byId(client, "appShellChannelOrderSelect").value = "listed";
    byId(client, "appShellChannelRotateShows").value = "24";
    byId(client, "appShellChannelRotateEpisodes").value = "3";
    byId(client, "appShellChannelPerShow").value = "50";
    client.call("appShellChannelReadSchedule");
    assert.equal(client.call("appShellChannelScheduleIsDefault"), true);
    await client.call("appShellChannelsAction", "chan-build");
    assert.equal(calls[1].options.preferPreset, true);
    assert.equal(calls[1].options.schedule.autoSort, "");
  });

  it("hands Custom off to the legacy builder instead of rebuilding it", async () => {
    const client = loadChannelsClient();
    let opened = 0;
    client.set("openBuildCustomChannel", () => { opened += 1; });
    client.call("appShellChannelsAction", "chan-template", "custom");
    assert.match(host(client), /full builder is still the page\u2019s own/);
    assert.equal(await client.call("appShellChannelsAction", "chan-custom"), true);
    assert.equal(opened, 1);
  });

  it("says what went wrong instead of showing an empty channel", async () => {
    const client = loadChannelsClient();
    client.set("appShellChannelNetworks", () => [{ networkId: "49", name: "HBO" }]);
    client.set("quickAddChannel", async () => null);
    const toasts = toastsOf(client);
    client.call("appShellChannelsAction", "chan-template", "network");
    byId(client, "appShellChannelNetworkSelect").value = "49";
    assert.equal(await client.call("appShellChannelsAction", "chan-build"), false);
    assert.equal(client.get("appShellChannelDraft"), null);
    assert.equal(requestsTo(client, "/api/channel-lineup").length, 0);
    assert.match(host(client), /Build this channel/, "the form is still there to try again");
    assert.equal(toasts.length, 0, "quickAddChannel is the thing that reports its own failures");
  });

  it("says which rules the preview could not apply", async () => {
    const client = loadChannelsClient({
      "/api/channel-lineup": async () => ({ json: Object.assign({}, LINEUP, { unappliedRules: ["hideWatched"] }) }),
    });
    client.set("appShellChannelNetworks", () => [{ networkId: "49", name: "HBO" }]);
    client.set("quickAddChannel", async (name) => ({ channelId: "ch-hbo", name, items: [{ kind: "episode" }] }));
    client.call("appShellChannelsAction", "chan-template", "network");
    byId(client, "appShellChannelNetworkSelect").value = "49";
    await client.call("appShellChannelsAction", "chan-build");
    await tick();
    assert.match(host(client), /Hide watched/);
    assert.match(host(client), /not applied here/);
  });
});
