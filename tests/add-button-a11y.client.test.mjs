// Audit UI-05: "+ Add", "Remove", "+ Movies", "+ Shows" and "See All" were
// repeated on every card with no list name, so a screen reader could not tell
// them apart. Each now carries a name that says which list it acts on, and the
// add/remove wording follows the button's added state.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadClient } from "./client-harness.mjs";

function fakeBtn({ name, added = false, text = "+ Add", chartTitle, cls = "searchAddBtn" }) {
  const attrs = { "data-name": name };
  const card = chartTitle ? { querySelector: () => ({ textContent: chartTitle }) } : null;
  return {
    textContent: text,
    getAttribute: (k) => (k in attrs && attrs[k] !== undefined ? attrs[k] : null),
    setAttribute: (k, v) => { attrs[k] = v; },
    classList: { contains: (c) => (c === "is-added" ? added : false) },
    matches: (sel) => (chartTitle ? sel.includes("discover-chart") && cls === "chart" : false),
    closest: () => card,
    attrs,
  };
}

describe("UI-05: repeated buttons say which list they belong to", () => {
  const c = loadClient();
  it("add button names the list", () => {
    const b = fakeBtn({ name: "New on Streaming" });
    c.call("syncAddButtonA11y", b);
    assert.equal(b.attrs["aria-label"], "Add New on Streaming to my lists");
  });
  it("remove state says remove", () => {
    const b = fakeBtn({ name: "New on Streaming", added: true, text: "Remove" });
    c.call("syncAddButtonA11y", b);
    assert.equal(b.attrs["aria-label"], "Remove New on Streaming from my lists");
  });
  it("chart card buttons use the card title", () => {
    const m = fakeBtn({ chartTitle: "Netflix", text: "+ Movies", cls: "chart" });
    const s = fakeBtn({ chartTitle: "Netflix", text: "+ Shows", cls: "chart" });
    const a = fakeBtn({ chartTitle: "Netflix", text: "See All ›", cls: "chart" });
    [m, s, a].forEach((b) => c.call("syncAddButtonA11y", b));
    assert.equal(m.attrs["aria-label"], "Add Netflix movies");
    assert.equal(s.attrs["aria-label"], "Add Netflix shows");
    assert.equal(a.attrs["aria-label"], "See all of Netflix");
  });
});
