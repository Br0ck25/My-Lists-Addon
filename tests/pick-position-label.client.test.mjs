// The number box on each pick of a custom list or channel ("type a position to
// move it") had only a title, so a screen reader announced an unnamed spin
// button. It carries an aria-label now, saying what the number is.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadClient } from "./client-harness.mjs";

const ITEMS = () => [
  { id: "tt1", title: "One", type: "movie" },
  { id: "tt2", title: "Two", type: "movie" },
];
const positionInputs = (html, cls) => (html.match(/<input[^>]*>/g) || []).filter((t) => t.includes(cls));

describe("pick position inputs are labelled", () => {
  it("custom list: every pick has a named position box", () => {
    const c = loadClient();
    c.set("customListDraftItems", ITEMS());
    c.call("renderCustomListDraftList");
    const inputs = positionInputs(c.document.getElementById("customListDraftList").innerHTML, "customListPosInput");
    assert.equal(inputs.length, 2);
    for (const t of inputs) assert.match(t, /aria-label="Position in list"/);
  });

  it("channel: every pick has a named position box", () => {
    const c = loadClient();
    c.set("channelDraftItems", ITEMS());
    c.call("renderChannelDraftList");
    const inputs = positionInputs(c.document.getElementById("channelDraftList").innerHTML, "channelPosInput");
    assert.equal(inputs.length, 2);
    for (const t of inputs) assert.match(t, /aria-label="Position in channel"/);
  });
});
