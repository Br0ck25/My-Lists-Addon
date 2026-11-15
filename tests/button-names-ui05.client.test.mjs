// Audit UI-05 (second pass): the buttons the first fix missed. Each repeated
// "Retry", "See All", "+ Add", "Remove" must say which list or item it acts on,
// and two chart cards with the same title that add different lists must not
// share a name. A tiny DOM stub is used so the real selectors are exercised.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadClient } from "./client-harness.mjs";

// Matches "tag.class[attr="v"]" simple selectors, comma separated.
function selMatch(el, sel) {
  return sel.split(",").map((s) => s.trim()).some((chain) => {
    const parts = chain.split(/\s+/);
    if (!simpleMatch(el, parts.pop())) return false;
    let n = el.parent;
    while (parts.length && n) { if (simpleMatch(n, parts[parts.length - 1])) parts.pop(); n = n.parent; }
    return parts.length === 0;
  });
}
function simpleMatch(el, one) {
  {
    const m = one.match(/^([a-z]*)((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/);
    if (!m) return false;
    if (m[1] && m[1] !== el.tag) return false;
    for (const c of m[2].split(".").filter(Boolean)) if (!el.cls.includes(c)) return false;
    for (const a of m[3].split("]").filter(Boolean)) {
      const [k, v] = a.slice(1).split("=");
      const have = el.attrs[k];
      if (have === undefined || (v !== undefined && have !== v.replace(/"/g, ""))) return false;
    }
    return true;
  }
}
function el(tag, cls, attrs = {}, text = "", parent = null) {
  const e = { tag, cls: cls.split(" "), attrs: { ...attrs }, textContent: text, parent, kids: [] };
  if (parent) parent.kids.push(e);
  e.getAttribute = (k) => (k in e.attrs ? e.attrs[k] : null);
  e.setAttribute = (k, v) => { e.attrs[k] = v; };
  e.classList = { contains: (c) => e.cls.includes(c) };
  e.matches = (s) => selMatch(e, s);
  e.closest = (s) => { for (let n = e; n; n = n.parent) if (n.matches(s)) return n; return null; };
  e.querySelector = (s) => {
    const walk = (n) => { for (const k of n.kids) { if (k.matches(s)) return k; const r = walk(k); if (r) return r; } return null; };
    return walk(e);
  };
  return e;
}
const c = loadClient();
const label = (b) => { c.call("syncAddButtonA11y", b); return b.attrs["aria-label"]; };

describe("UI-05 second pass: repeated buttons are named", () => {
  it("Retry on a poster slot names its list", () => {
    const slot = el("div", "list-card-posters poster-preview-slot", { "data-name": "Top Rated" });
    const b = el("button", "lc-btn secondary", { "data-act": "retryPosterSlot" }, "Retry", slot);
    assert.equal(label(b), "Retry loading previews for Top Rated");
  });
  it("Retry on the catalogs preview names its shelf", () => {
    const shelf = el("div", "live-preview-shelf");
    const title = el("div", "live-preview-shelf-title", {}, "", shelf);
    el("span", "shelf-title-text", {}, "Trending - Movies", title);
    const b = el("button", "lc-btn secondary", { "data-act": "renderLivePreview" }, "Retry", el("div", "live-preview-posters", {}, "", shelf));
    assert.equal(label(b), "Retry loading Trending - Movies");
  });
  it("/catalogs shelf See All is named from its shelf title", () => {
    const title = el("div", "live-preview-shelf-title");
    el("span", "shelf-title-text", {}, "Trending - Movies", title);
    const b = el("button", "text-action-btn", {}, "See All ›", title);
    assert.equal(label(b), "See all of Trending - Movies");
  });
  it("add/remove buttons without data-name use the card title and follow added state", () => {
    for (const cls of ["creatorListAddToConfigBtn", "localListAddToConfigBtn", "channelAddBtn"]) {
      const card = el("div", "list-card");
      const body = el("div", "list-card-body", {}, "", card);
      el("div", "list-card-title", {}, "My Picks", body);
      const b = el("button", "lc-btn list-add-btn " + cls, { "data-slug": "x" }, "+ Add", card);
      assert.equal(label(b), "Add My Picks to my lists", cls);
      b.cls.push("is-added"); b.textContent = "Remove";
      assert.equal(label(b), "Remove My Picks from my lists", cls);
    }
  });
  it("myListAddBtn uses its own data-name", () => {
    const b = el("button", "lc-btn list-add-btn myListAddBtn", { "data-name": "Watched 2024" }, "+ Add");
    assert.equal(label(b), "Add Watched 2024 to my lists");
  });
  it("directory channel Remove is named from the card", () => {
    const card = el("div", "list-card");
    el("div", "list-card-title", {}, "Sci-Fi Channel", card);
    const b = el("button", "lc-btn secondary", { "data-act": "removeDirectoryChannel" }, "Remove", card);
    assert.equal(label(b), "Remove Sci-Fi Channel from my lists");
  });
  it("same card title, different list: the name comes from the list the button adds", () => {
    const mk = (labelArg) => {
      const card = el("div", "discover-chart-card");
      el("div", "discover-chart-title", {}, "Netflix", card);
      return el("button", "lc-btn secondary", { "data-act": "addRow", "data-act-args": JSON.stringify([labelArg, "u", "movie", true, "g"]) }, "+ Movies", el("div", "discover-chart-btns", {}, "", card));
    };
    const top10 = label(mk("Netflix Top 10")), all = label(mk("Netflix"));
    assert.equal(top10, "Add Netflix Top 10 movies");
    assert.equal(all, "Add Netflix movies");
    assert.notEqual(top10, all);
  });
  it("per-item remove names the item, and is stable when run twice", () => {
    const card = el("div", "live-preview-poster-card", { "data-title": "Dune" });
    el("div", "live-preview-poster-name", {}, "Dune", card);
    const b = el("button", "cw-remove-btn", { "aria-label": "Remove from Watchlist", title: "Remove from Watchlist" }, "✕", card);
    assert.equal(label(b), "Remove from Watchlist: Dune");
    assert.equal(label(b), "Remove from Watchlist: Dune");
    const card2 = el("div", "live-preview-poster-card");
    el("div", "live-preview-poster-name", {}, "Arrival", card2);
    assert.equal(label(el("button", "cw-remove-btn channelRemovePickBtn", { "aria-label": "Remove pick" }, "✕", card2)), "Remove pick: Arrival");
  });
  it("remove crosses on list-card poster tiles name their own item", () => {
    const mk = (name) => {
      const tile = el("div", "list-card-mini-poster-tile");
      el("div", "list-card-mini-poster-name", {}, name, tile);
      return el("button", "cw-remove-btn", { "aria-label": "Remove from Trakt History", title: "Remove from Trakt History" }, "✕", tile);
    };
    const dune = label(mk("Dune")), arrival = label(mk("Arrival"));
    assert.equal(dune, "Remove from Trakt History: Dune");
    assert.equal(arrival, "Remove from Trakt History: Arrival");
    assert.notEqual(dune, arrival);
  });
  it("per-item Remove in the select-list dialog names its list", () => {
    const row = el("div", "select-list-row");
    const lab = el("label", "", {}, "", row);
    el("span", "u-fw-500", {}, "Favourites", lab);
    const b = el("button", "lc-btn secondary", { "data-act": "removeSingleExternalItemDirect" }, "Remove", row);
    assert.equal(label(b), "Remove from Favourites");
  });
  it("the observer selector reaches every new button kind", () => {
    const sel = c.get("ADD_BUTTON_SELECTOR");
    for (const part of ["list-add-btn", "cw-remove-btn", "retryPosterSlot", "renderLivePreview", "text-action-btn", "removeDirectoryChannel"]) assert.ok(String(sel).includes(part), part);
  });
});
