// UI-06 / UI-07: an address that names nothing must not turn into a made-up
// channel or an endless "Loading…" list page.
//
//   * /channels/<user>/<slug> is a share address. The Worker redirects a live
//     one, so a page that still sees one is dead. It used to build a channel
//     called after the address, credited to "My Lists Addon", with an "+ Add".
//   * /lists/<unknown> opened the list view and never filled it in.
//
// handleInitialDeepLink runs when the page loads. Whether it opened a list is
// read from window._currentListDetailsKey, which openListDetailsPage sets.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadClient } from "./client-harness.mjs";

function open(pathname, head) {
  const c = loadClient({ pathname });
  return {
    opened: c.get("window._currentListDetailsKey") || null,
    replaced: c.historyCalls.filter((h) => h.kind === "replace").map((h) => h.args[2]),
    notice: c.get("window._deepLinkNotFound") || null,
  };
}

describe("dead links do not invent a page", () => {
  it("a two-part channel address with no saved channel opens no channel", () => {
    const r = open("/channels/someone/deleted-channel");
    assert.equal(r.opened, null, "no list page was built from the address");
    assert.match(r.notice || "", /channel/i, "the person is told it was not found");
  });

  it("an unknown /lists/<slug> leaves the list view instead of loading forever", () => {
    const r = open("/lists/bogus");
    assert.equal(r.opened, null);
    assert.match(r.notice || "", /list/i);
  });

  it("a one-part channel address (network channels such as /channels/tlc) still opens", () => {
    const r = open("/channels/tlc");
    assert.ok(r.opened, "network channel links keep working");
    assert.equal(r.notice, null);
  });

  it("a known provider list address still opens", () => {
    const r = open("/lists/watchlist");
    assert.ok(r.opened);
    assert.equal(r.notice, null);
  });
});
