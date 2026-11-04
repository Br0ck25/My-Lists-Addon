// UI-12: on a phone the pill rows scroll sideways. Opening Settings -> Feedback &
// Support (or Channels -> Explore) from a link or reload left the ticked pill off
// the side of the row. The active pill is centred in its row when the row shows.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadClient } from "./client-harness.mjs";

function bar({ barLeft, barWidth, pillLeft, pillWidth, scrollLeft = 0, active = true }) {
  const pill = { getBoundingClientRect: () => ({ left: pillLeft, width: pillWidth }) };
  return {
    clientWidth: barWidth, scrollLeft,
    getBoundingClientRect: () => ({ left: barLeft, width: barWidth }),
    querySelector: (sel) => (active && sel.includes(".active") ? pill : null),
  };
}

describe("active pill is centred in its row", () => {
  it("a pill off to the right moves to the middle", () => {
    const b = bar({ barLeft: 0, barWidth: 360, pillLeft: 334, pillWidth: 181 });
    loadClient().call("centerActivePill", b);
    assert.equal(b.scrollLeft, 334 - (360 - 181) / 2);
  });

  it("the row's own offset and current scroll are accounted for", () => {
    const b = bar({ barLeft: 16, barWidth: 328, pillLeft: 300, pillWidth: 100, scrollLeft: 50 });
    loadClient().call("centerActivePill", b);
    assert.equal(b.scrollLeft, 50 + (300 - 16) - (328 - 100) / 2);
  });

  it("a pill already near the start does not scroll below zero", () => {
    const b = bar({ barLeft: 0, barWidth: 360, pillLeft: 8, pillWidth: 100 });
    loadClient().call("centerActivePill", b);
    assert.equal(b.scrollLeft, 0);
  });

  it("a row with no active pill is left alone", () => {
    const b = bar({ barLeft: 0, barWidth: 360, pillLeft: 300, pillWidth: 100, active: false });
    loadClient().call("centerActivePill", b);
    assert.equal(b.scrollLeft, 0);
  });
});
