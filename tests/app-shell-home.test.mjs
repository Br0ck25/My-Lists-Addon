import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadClient, requestsTo } from "./client-harness.mjs";

// The shell's home-screen editor (Phase 6, P6-3): the live preview that follows
// the rows, and the duplicate toggle.
//
// These load the real shell page and drive the real functions.

function editor(client) {
  return client.__byId.get("appShellHomeEditor").innerHTML;
}

function previewRoutes(counts) {
  return {
    "/api/preview": async (req) => {
      const url = req.body && req.body.url;
      if (String(url).indexOf("not-a-list") !== -1) {
        return { status: 400, json: { ok: false, error: "That URL isn't a supported list source." } };
      }
      const type = req.body && req.body.type;
      const table = counts[url] || {};
      return { json: { ok: true, count: table[type] || 0, totalItems: table[type] || 0, sample: [] } };
    },
  };
}

// A client whose row-building, saving and previewing are recorded rather than
// performed: those parts belong to other tests, and this one is about what the
// editor hands them.
function loadEditorClient(overrides, opts) {
  const client = loadClient(Object.assign({
    newUi: true,
    signedIn: true,
    routes: Object.assign(previewRoutes({
      "https://mdblist.com/lists/you/horror": { movie: 41, series: 3 },
      "https://trakt.tv/users/alice/lists/shows": { movie: 2, series: 18 },
    }), overrides || {}),
  }, opts || {}));
  const added = [];
  client.set("addRow", (name, url, type, enabled, group) => {
    added.push({ name, url, type, enabled, group });
    return { name };
  });
  client.saved = 0;
  client.previews = 0;
  client.set("saveState", () => { client.saved += 1; });
  client.set("renderLivePreview", () => { client.previews += 1; });
  client.added = added;
  return client;
}

describe("the shell's home-screen editor", () => {
  // The paste box, its check-links review and the starter-pack button were
  // taken out at the owner's request (the starter rows are pre-filled for a
  // first-time visitor instead -- see app-shell.test.mjs). What is left is
  // the duplicate toggle, below the rows and above the Daily Randomizer.
  it("renders only the duplicate toggle, with no inline handlers", () => {
    const client = loadEditorClient();
    client.call("appShellRenderHomeEditor");
    const markup = editor(client);
    assert.ok(markup.includes('id="appShellDedupeToggle"'));
    assert.ok(markup.includes("Hide titles already shown in rows above"));
    assert.equal(markup.includes("appShellAddBox"), false, "the paste box is back");
    assert.equal(markup.includes("Add to your home screen"), false);
    assert.equal(markup.includes("home-starter"), false, "the starter-pack button is back");
    assert.equal(/on[a-z]+=/.test(markup), false, "the editor must not add inline handlers");
  });

  it("does nothing at all on the old page", () => {
    const client = loadClient({ newUi: false, routes: previewRoutes({}) });
    assert.equal(client.call("appShellRenderHomeEditor"), false);
    assert.equal(editor(client), "");
  });

  it("writes the duplicate toggle to the one key the server reads back", () => {
    const client = loadEditorClient();
    client.call("appShellSetDedupe", true);
    assert.equal(client.localStorage.getItem("myListAddon:dedupeAcrossLists"), "1");
    assert.equal(client.__byId.get("dedupeAcrossListsCheckbox").checked, true);
    client.call("appShellSetDedupe", false);
    assert.equal(client.localStorage.getItem("myListAddon:dedupeAcrossLists"), "0");
    assert.equal(client.__byId.get("dedupeAcrossListsCheckbox").checked, false);
  });

  it("keeps the live preview following the rows, on the new UI only", () => {
    // The debounce itself is a timer, and timers are stubbed out in this
    // harness on purpose, so what is checked here is the two things that can
    // regress without anybody noticing: that a row change schedules it at all,
    // and that the old page gets nothing scheduled for it.
    const shell = loadClient({ newUi: true, signedIn: true, routes: previewRoutes({}) });
    assert.equal(shell.call("appShellSchedulePreview"), true);
    assert.match(shell.get("saveState").toString(), /appShellSchedulePreview\(\)/,
      "every row change goes through saveState, so that is where the refresh is scheduled");
    const legacy = loadClient({ newUi: false, routes: previewRoutes({}) });
    assert.equal(legacy.call("appShellSchedulePreview"), false);
  });

  it("refreshes the preview right away when the editor itself changes a row", () => {
    const client = loadEditorClient();
    client.call("appShellSetDedupe", true);
    assert.equal(client.previews, 1, "the toggle changes what every row shows");
    assert.equal(client.saved, 1);
  });

  it("opens on the stored duplicate setting", () => {
    const client = loadEditorClient();
    client.localStorage.setItem("myListAddon:dedupeAcrossLists", "1");
    client.call("appShellRenderHomeEditor");
    assert.match(editor(client), /id="appShellDedupeToggle" checked/);
  });
});
