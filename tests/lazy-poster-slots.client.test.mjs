// Discover and the home page draw a card per list, and each card fills its
// poster strip with one /api/preview call. They all fired at once: 168 calls
// for one page load against a limit of 240 a minute per address, so the next
// load (or a second person on the same network) got 429 and rows full of
// "Couldn't load previews". Now a card loads when it comes near the screen (the
// observer reports the ones already on screen straight away).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadClient } from "./client-harness.mjs";

function makeSlots(n) {
  return Array.from({ length: n }, (_, i) => ({ id: "slot" + i, dataset: {}, closest: () => null }));
}

// A stand-in for the browser's IntersectionObserver that a test can drive.
function fakeObserverClass() {
  const instances = [];
  class FakeObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.observed = new Set();
      instances.push(this);
    }
    observe(el) { this.observed.add(el); }
    unobserve(el) { this.observed.delete(el); }
    disconnect() { this.observed.clear(); }
    // The browser reports an element coming into view.
    show(el) { this.callback([{ isIntersecting: true, target: el }]); }
  }
  FakeObserver.instances = instances;
  return FakeObserver;
}

function setup(slotCount, { observer = true } = {}) {
  const c = loadClient();
  const slots = makeSlots(slotCount);
  const loaded = [];
  c.set("loadPosterSlot", async (slot) => { loaded.push(slot.id); });
  c.document.querySelectorAll = (sel) => (sel === ".poster-preview-slot" ? slots : []);
  const FakeObserver = fakeObserverClass();
  if (observer) c.IntersectionObserver = FakeObserver;
  return { c, slots, loaded, FakeObserver };
}

const tick = () => new Promise((r) => setImmediate(r));

describe("poster strips load as cards come into view", () => {
  it("loads nothing until a card is reported near the screen", async () => {
    const { c, loaded } = setup(40);
    await c.call("populateSearchResultPosters");
    await tick();
    assert.deepEqual(loaded, []);
  });

  it("watches every card, a little ahead of the screen", async () => {
    const { c, FakeObserver } = setup(40);
    await c.call("populateSearchResultPosters");
    const [obs] = FakeObserver.instances;
    assert.equal(obs.observed.size, 40);
    assert.match(obs.options.rootMargin, /^[1-9]\d*px/, "it starts loading before the card is on screen");
  });

  it("loads a card when it comes into view, and only that one", async () => {
    const { c, loaded, FakeObserver, slots } = setup(40);
    await c.call("populateSearchResultPosters");
    const [obs] = FakeObserver.instances;
    obs.show(slots[0]);
    obs.show(slots[1]);
    obs.show(slots[20]);
    await tick();
    assert.deepEqual(loaded.sort(), ["slot0", "slot1", "slot20"]);
    assert.equal(obs.observed.size, 37, "no longer watched once queued");
  });

  it("calling it again, or a card reported twice, loads a card once", async () => {
    const { c, loaded, FakeObserver, slots } = setup(10);
    await c.call("populateSearchResultPosters");
    await c.call("populateSearchResultPosters");
    const [obs] = FakeObserver.instances;
    assert.equal(FakeObserver.instances.length, 1, "one observer for the page");
    assert.equal(obs.observed.size, 10);
    obs.show(slots[3]);
    obs.show(slots[3]);
    await tick();
    assert.deepEqual(loaded, ["slot3"]);
  });

  it("a card in a hidden tab is not watched, so showing the tab picks it up", async () => {
    const c = loadClient();
    const slots = makeSlots(4);
    slots[2].closest = () => ({});
    const loaded = [];
    c.set("loadPosterSlot", async (slot) => { loaded.push(slot.id); });
    c.document.querySelectorAll = (sel) => (sel === ".poster-preview-slot" ? slots : []);
    const FakeObserver = fakeObserverClass();
    c.IntersectionObserver = FakeObserver;
    await c.call("populateSearchResultPosters");
    assert.equal(FakeObserver.instances[0].observed.size, 3);
    assert.ok(!FakeObserver.instances[0].observed.has(slots[2]));
  });

  it("never has more than five loading at a time", async () => {
    const c = loadClient();
    const slots = makeSlots(40);
    c.document.querySelectorAll = (sel) => (sel === ".poster-preview-slot" ? slots : []);
    let running = 0;
    let peak = 0;
    c.set("loadPosterSlot", async () => {
      running++;
      peak = Math.max(peak, running);
      await tick();
      running--;
    });
    // No observer: every card is queued, which is the busiest case.
    await c.call("populateSearchResultPosters");
    for (let i = 0; i < 20; i++) await tick();
    assert.ok(peak <= 5, "peak " + peak);
    assert.ok(peak >= 2, "and it does load several at once, not one by one: peak " + peak);
  });

  it("without IntersectionObserver every card still loads, as before", async () => {
    const { c, loaded } = setup(40, { observer: false });
    await c.call("populateSearchResultPosters");
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(loaded.length, 40);
  });
});
