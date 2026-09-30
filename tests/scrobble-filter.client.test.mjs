// "Enable media server user filtering" (renderTrackPlaybackSection,
// 22_client-creator-profile.js): unticking it with names still in the list
// has to stay unticked. Having names saved used to switch the box on at every
// redraw -- and every sync load redraws the section -- while the server, which
// reads the saved choice, had filtering off.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadClient } from "./client-harness.mjs";

function renderedFilterBox(storage) {
  const client = loadClient({ signedIn: true, storage });
  client.call("renderTrackPlaybackSection");
  const html = client.document.getElementById("trackPlaybackSection").innerHTML;
  const input = html.match(/<input type="checkbox" id="scrobbleFilterUsersCb"[^>]*>/);
  assert.ok(input, "the filtering checkbox was not rendered");
  return / checked /.test(input[0]) || /\schecked\b/.test(input[0]);
}

describe("media server user filtering checkbox", () => {
  it("stays off when switched off with names saved", () => {
    assert.equal(renderedFilterBox({
      "myListAddon:scrobbleFilterUsers": "0",
      "myListAddon:scrobbleAllowedUsers": "alice, bob",
    }), false);
  });

  it("is on when switched on", () => {
    assert.equal(renderedFilterBox({
      "myListAddon:scrobbleFilterUsers": "1",
      "myListAddon:scrobbleAllowedUsers": "alice",
    }), true);
  });

  it("follows the names for a browser that never saved a choice", () => {
    assert.equal(renderedFilterBox({ "myListAddon:scrobbleAllowedUsers": "alice" }), true);
    assert.equal(renderedFilterBox({}), false);
  });
});
