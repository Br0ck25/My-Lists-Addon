import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadClient, requestsTo } from "./client-harness.mjs";

// The shell's home-screen editor (Phase 6, P6-3): paste a link, see what it is,
// then add it. The three E2E scenarios the task is measured by are the paste
// flow (1), the live preview that follows it (2) and the duplicate toggle (3).
//
// These load the real shell page and drive the real functions. What they check
// is what the person sees and what goes to the server: the review table is
// built from real /api/preview answers, and nothing is added that was not
// checked first.

const PACK_ROWS = 8;

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
  it("renders the paste box and the duplicate toggle, with no inline handlers", () => {
    const client = loadEditorClient();
    client.call("appShellRenderHomeEditor");
    const markup = editor(client);
    assert.ok(markup.includes('id="appShellAddBox"'), "the paste box is missing");
    assert.ok(markup.includes('data-app-shell-action="home-check"'));
    assert.ok(markup.includes('id="appShellDedupeToggle"'));
    assert.equal(/on[a-z]+=/.test(markup), false, "the editor must not add inline handlers");
  });

  it("does nothing at all on the old page", () => {
    const client = loadClient({ newUi: false, routes: previewRoutes({}) });
    assert.equal(client.call("appShellRenderHomeEditor"), false);
    assert.equal(editor(client), "");
    assert.equal(client.get("APP_SHELL_STARTER_PACK").length, 0);
  });

  it("checks every pasted line as both kinds of list and keeps the bigger answer", async () => {
    const client = loadEditorClient();
    client.__byId.get("appShellAddBox").value =
      "https://mdblist.com/lists/you/horror\n" +
      "https://trakt.tv/users/alice/lists/shows\n" +
      "\n" +
      "https://example.com/not-a-list";
    const results = await client.call("appShellHomeCheck");

    // One line is one movie check plus one series check, and a blank line is
    // not a line.
    const asked = requestsTo(client, "/api/preview");
    assert.equal(asked.length, 6);
    assert.equal(asked.every((r) => r.method === "POST" && r.body.sample === 1), true);
    assert.deepEqual(asked.slice(0, 2).map((r) => r.body.type), ["movie", "series"]);

    // The type is whichever side has more in it: 41 films beats 3 shows, and
    // 18 shows beats 2 films.
    assert.equal(results[0].type, "movie");
    assert.equal(results[0].count, 41);
    // guessNameFromUrl turns the slug into something a person would write.
    assert.equal(results[0].name, "Horror");
    assert.equal(results[1].type, "series");
    assert.equal(results[1].count, 18);
    assert.equal(results[2].ok, false);
    assert.match(results[2].error, /supported list source/);

    const markup = editor(client);
    assert.ok(markup.includes("horror"));
    assert.match(markup, /Movies &middot; 41 titles/);
    assert.match(markup, /Shows &middot; 18 titles/);
    assert.ok(markup.includes("Skipped"));
    assert.match(markup, /Add 2 lists/);
  });

  it("adds only the lines that came back ready, and clears the box", async () => {
    const client = loadEditorClient();
    client.__byId.get("appShellAddBox").value =
      "https://mdblist.com/lists/you/horror\nhttps://example.com/not-a-list";
    await client.call("appShellHomeCheck");
    const made = client.call("appShellHomeAddChecked");

    assert.equal(made, 1);
    assert.deepEqual(client.added, [{
      name: "Horror",
      url: "https://mdblist.com/lists/you/horror",
      type: "movie",
      enabled: true,
      group: "Custom",
    }]);
    assert.equal(client.__byId.get("appShellAddBox").value, "");
    assert.equal(editor(client).includes("app-shell-review"), false, "the review is done with");
  });

  it("will not add anything before the links have been checked", () => {
    const client = loadEditorClient();
    client.__byId.get("appShellAddBox").value = "https://mdblist.com/lists/you/horror";
    assert.equal(client.call("appShellHomeAddChecked"), 0);
    assert.deepEqual(client.added, []);
    assert.equal(requestsTo(client, "/api/preview").length, 0);
  });

  it("checks at most fifty lines, and says how many it left out", async () => {
    const client = loadEditorClient();
    const lines = [];
    for (let i = 0; i < 60; i++) lines.push("https://mdblist.com/lists/you/list-" + i);
    client.__byId.get("appShellAddBox").value = lines.join("\n");
    await client.call("appShellHomeCheck");
    assert.equal(requestsTo(client, "/api/preview").length, 50 * 2);
    assert.match(editor(client), /10 more line\(s\) were not checked/);
  });

  it("offers the starter pack only while the screen is empty", () => {
    const client = loadEditorClient();
    client.call("appShellRenderHomeEditor");
    assert.match(editor(client), /data-app-shell-action="home-starter"/);
    assert.equal(client.get("APP_SHELL_STARTER_PACK").length, PACK_ROWS);

    // Once there are rows of your own, the offer is gone.
    client.document.querySelectorAll = (sel) => (sel === "#lists .entry" ? [{}, {}] : []);
    client.call("appShellRenderHomeEditor");
    assert.equal(/home-starter/.test(editor(client)), false);
    assert.match(editor(client), /Your 2 rows are below/);
  });

  it("adds the starter pack as ordinary rows", () => {
    const client = loadEditorClient();
    assert.equal(client.call("appShellAddStarterPack"), PACK_ROWS);
    assert.equal(client.added.length, PACK_ROWS);
    assert.equal(client.added[0].name, "Popular");
    assert.equal(client.added[0].type, "movie");
    assert.equal(client.added.every((r) => r.group === "Combined Charts"), true);
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
