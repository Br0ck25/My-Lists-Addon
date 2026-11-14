// CQ-03, second half (docs/audit-2026-11-10/01-code-quality.md, Verification):
// after the cache merge was unified, the per-poster air-date and
// premiere/finale badge code was still pasted into the MDBList and Trakt
// renderers (Up Next / Continue Watching tiles) and into the MDBList, Trakt
// and Simkl renderers (Airing Next tiles). A change to when a "Season Finale"
// or "Finale: <date>" badge shows had to be made in every copy.
//
// These tests pin what every provider panel must show, and that each badge
// rule is written once.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadClient } from "./client-harness.mjs";

const FUTURE = "2099-01-05";

function render(fn, list, setup) {
  const client = loadClient();
  for (const k of ["_mdblistAiringNextEnriching", "_traktAiringNextEnriching", "_simklAiringNextEnriching"]) client.set(k, true);
  if (setup) setup(client);
  client.call(fn, [list]);
  const box = { renderMyMdblistLists: "myMdblistListsResult", renderMyPrivateTraktLists: "myPrivateTraktListsResult", renderMySimklLists: "mySimklListsResult" }[fn];
  return client.call("document.getElementById", box).innerHTML;
}

const AIRING = [
  { fn: "renderMyMdblistLists", url: "mdblist:user:shows:airing-next" },
  { fn: "renderMyPrivateTraktLists", url: "trakt:airing-next" },
  { fn: "renderMySimklLists", url: "simkl:airing-next" },
];

const UP_NEXT = [
  { fn: "renderMyMdblistLists", list: { name: "Up Next", statusKey: "upnext", url: "mdblist:user:shows:upnext" } },
  { fn: "renderMyPrivateTraktLists", list: { name: "Continue Watching", statusKey: "continue-watching", url: "trakt:continue-watching" } },
];

describe("provider panels show the same Airing Next badges (CQ-03)", () => {
  for (const p of AIRING) {
    it(p.fn + ": an unaired episode 1 gets the Season Premiere badge", () => {
      const html = render(p.fn, { name: "Airing Next", statusKey: "airing-next", url: p.url, items: [
        { id: "tt1", type: "series", name: "Show", airDate: FUTURE, seasonNum: 2, episodeNum: 1 },
      ] });
      assert.match(html, /cw-date-badge-premiere[^>]*>Season Premiere</);
    });

    it(p.fn + ": an unaired finale gets the Season Finale badge", () => {
      const html = render(p.fn, { name: "Airing Next", statusKey: "airing-next", url: p.url, items: [
        { id: "tt1", type: "series", name: "Show", airDate: FUTURE, seasonNum: 2, episodeNum: 8, isSeasonFinale: true },
      ] });
      assert.match(html, /cw-date-badge-finale"[^>]*>Season Finale</);
    });

    it(p.fn + ": a mid-season episode shows the upcoming finale date instead", () => {
      const html = render(p.fn, { name: "Airing Next", statusKey: "airing-next", url: p.url, items: [
        { id: "tt1", type: "series", name: "Show", airDate: FUTURE, seasonNum: 2, episodeNum: 4, seasonFinaleAirDate: "2099-03-01" },
      ] });
      assert.match(html, /cw-date-badge-finale-date[^>]*title="Season finale airs on 2099-03-01">Finale: /);
      assert.doesNotMatch(html, />Season Premiere</);
    });
  }
});

describe("Up Next and Continue Watching tiles use the Airing Next match the same way (CQ-03)", () => {
  for (const p of UP_NEXT) {
    it(p.fn + ": premiere and air date come from the Airing Next match when the item has none", () => {
      const html = render(p.fn, { ...p.list, items: [{ id: "tt9", type: "series", name: "Show", seasonNum: 3, episodeNum: 1 }] },
        (c) => c.set("findAiringMatchFor", () => ({ airDate: FUTURE, isUnaired: true, isSeasonPremiere: true })));
      assert.match(html, /cw-date-badge-premiere" title="Airs on 2099-01-05">Season Premiere</);
    });

    it(p.fn + ": a match marked as finale gives a Season Finale badge", () => {
      const html = render(p.fn, { ...p.list, items: [{ id: "tt9", type: "series", name: "Show", seasonNum: 3, episodeNum: 9 }] },
        (c) => c.set("findAiringMatchFor", () => ({ airDate: FUTURE, isUnaired: true, isSeasonFinale: true })));
      assert.match(html, /cw-date-badge-finale" title="Airs on 2099-01-05">Season Finale</);
    });

    it(p.fn + ": the panel's own badge toggle hides the badges", () => {
      const off = { showBadgesMdblistUpNext: false, showBadgesTraktContinueWatching: false };
      const html = render(p.fn, { ...p.list, items: [{ id: "tt9", type: "series", name: "Show", airDate: FUTURE, seasonNum: 3, episodeNum: 1 }] },
        (c) => c.set("getBadgeSetting", (k) => (k in off ? off[k] : true)));
      assert.doesNotMatch(html, /cw-date-badge/);
    });
  }
});

it("each list-panel badge rule is written once in the provider renderers file", () => {
  const src = readFileSync(new URL("../src/client/17_client-my-lists-and-trakt-oauth.js", import.meta.url), "utf8");
  const copies = src.split("cw-date-badge cw-date-badge-finale-date").length - 1;
  assert.equal(copies, 2, "found " + copies + " copies of the finale-date badge; use upNextTileBadgesHtml / airingNextTileBadgesHtml");
});
