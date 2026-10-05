import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadClient } from "./client-harness.mjs";

// Discover / Lists page fixes: a list's Movies and Shows buttons are separate,
// Liked lists name who they are by, and Discover reopens on the tab it was on.

function button(url, type) {
  const classes = new Set(["lc-btn", "primary", "searchAddBtn"]);
  return {
    dataset: { url, type },
    style: {},
    textContent: "+ Add",
    classList: {
      toggle(c, on) { if (on) classes.add(c); else classes.delete(c); },
      add(...c) { c.forEach((x) => classes.add(x)); },
      remove(...c) { c.forEach((x) => classes.delete(x)); },
      contains: (c) => classes.has(c),
    },
    has: (c) => classes.has(c),
  };
}

describe("client: Movies and Shows add buttons of one list are separate", () => {
  it("shows Remove only on the type that was added", () => {
    const client = loadClient({});
    const url = "tmdb:new-on-streaming";
    const movieBtn = button(url, "movie");
    const showBtn = button(url, "series");
    const doc = client.get("document");
    doc.querySelectorAll = (sel) => {
      if (sel === "#lists .entry") {
        return [{
          querySelector: (s) => (s === ".type" ? { value: "movie" } : null),
          querySelectorAll: (s) => (s === ".url" ? [{ value: url }] : []),
        }];
      }
      if (sel === ".list-search-add-btn, .searchAddBtn") return [movieBtn, showBtn];
      return [];
    };
    client.call("updateAllListAddButtons");
    assert.equal(movieBtn.textContent, "Remove");
    assert.ok(movieBtn.has("is-added"));
    assert.equal(showBtn.textContent, "+ Add", "the Shows list was never added");
    assert.ok(!showBtn.has("is-added"));
  });
});

describe("client: Liked lists say who they are by", () => {
  const info = (link) => JSON.parse(JSON.stringify(loadClient({}).call("likedListInfo", link)));
  it("names this add-on's own charts, including a combined one", () => {
    assert.equal(info("mylists:most-watched:today").user, "My Lists Addon");
    assert.equal(info("tmdb:new-on-streaming").user, "My Lists Addon");
    assert.equal(info("mylists:better-posters:trending").user, "My Lists Addon");
    assert.equal(info("tmdb:chart:trending\ntrakt:chart:trending").user, "My Lists Addon");
  });
  it("names a provider's chart as the provider, and a list as its owner", () => {
    assert.equal(info("tmdb:chart:popular").user, "TMDB");
    assert.equal(info("trakt:chart:trending").user, "Trakt");
    assert.equal(info("simkl:chart:today").user, "Simkl");
    assert.equal(info("https://mdblist.com/lists/ahmed2250/apple-tv-top-10-movies-today").user, "ahmed2250");
    assert.equal(info("https://mdblist.com/lists/official/movies/popular").user, "MDBList");
    assert.equal(info("https://trakt.tv/users/bob/lists/favs").user, "bob");
    assert.equal(info("https://letterboxd.com/dave/list/best/").user, "dave");
  });
  it("uses the chart's real name when it is one of ours, and Community only when nothing says", () => {
    assert.equal(info("mylists:most-watched:7").name, "Most Watched 7 Days");
    assert.equal(info("https://example.com/whatever").user, "Community");
  });
});

describe("client: Discover reopens on the tab it was on", () => {
  it("uses the remembered sub-tab when the route names none", () => {
    const client = loadClient({});
    const opened = [];
    client.set("filterDiscoverShelves", (sub) => { opened.push(sub); });
    client.set("switchTab", () => {});
    client.get("window")._currentDiscoverFilter = "series";
    client.call("appShellApplyRoute", { tab: "discover", sub: "" });
    assert.deepEqual(opened, ["series"]);
  });
  it("falls back to the last one used, then Movies", () => {
    const stored = loadClient({ storage: { "myListAddon:discoverSubmenu": "gems" } });
    const opened = [];
    stored.set("filterDiscoverShelves", (sub) => { opened.push(sub); });
    stored.set("switchTab", () => {});
    stored.call("appShellApplyRoute", { tab: "discover", sub: "" });
    const fresh = loadClient({});
    fresh.set("filterDiscoverShelves", (sub) => { opened.push(sub); });
    fresh.set("switchTab", () => {});
    fresh.call("appShellApplyRoute", { tab: "discover", sub: "" });
    assert.deepEqual(opened, ["gems", "movie"]);
  });
});
