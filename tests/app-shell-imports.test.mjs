import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { loadClient, requestsTo } from "./client-harness.mjs";

// The shell's Imports screen (Phase 6, P6-6, E2E scenario 5): import a
// Letterboxd zip or CSV, an IMDb CSV, a Trakt export -- as a server job with
// real progress, a review step for the titles TMDB could not place on its own,
// and a result that is a list plus ONE toggle that puts it on the home screen.
//
// The whole point of this screen is that the matching is not done here: the
// rows are handed over once and the job keeps going after the tab is closed, so
// these tests are mostly about that contract -- what is posted, what is polled,
// and what the page does when the answer arrives late.
//
// They load the real shell page and drive the real functions.

const ACCOUNT = { id: 7, username: "alice", displayName: "Alice" };

// A Letterboxd export: names and years, no ids (that is why the server matches
// it rather than taking it as given), every row a film.
const LETTERBOXD_CSV = [
  "Date,Name,Year,Letterboxd URI",
  "2024-01-01,Fight Club,1999,https://boxd.it/1",
  "2024-01-02,Pulp Fiction,1994,https://boxd.it/2",
  "2024-01-03,Arrival,2016,https://boxd.it/3",
].join("\n");

// An IMDb export: real ids AND both kinds in one file.
const IMDB_CSV = [
  "Const,Title,Year,Title Type",
  "tt0137523,Fight Club,1999,movie",
  "tt0903747,Breaking Bad,2008,tvSeries",
].join("\n");

function status(over) {
  return Object.assign({
    ok: true, id: 7, status: "running", kind: "movie", name: "Letterboxd Watchlist",
    total: 3, done: 1, matched: 1, ambiguous: 0, unmatched: 0, error: null,
  }, over || {});
}

function importRoutes(overrides) {
  return Object.assign({
    "/api/imports": async () => ({ status: 202, json: { ok: true, id: 7, total: 3 } }),
    "/api/imports/7": async () => ({ json: status() }),
    "/api/imports/7/review": async () => ({ json: { ok: true, id: 7, review: [] } }),
    "/api/imports/7/result": async () => ({ json: { ok: true, id: 7, done: true, items: [] } }),
    "/api/creator/lists/save": async () => ({ json: { ok: true, slug: "letterboxd-watchlist" } }),
  }, overrides || {});
}

function loadImportsClient(overrides, opts) {
  const client = loadClient({
    newUi: true,
    signedIn: true,
    routes: importRoutes(overrides),
    storage: (opts && opts.storage) || {},
  });
  client.call("appShellState.set", { account: ACCOUNT });
  return client;
}

function host(client) {
  return client.__byId.get("appShellImports").innerHTML;
}

// Cross-vm objects: deepEqual across two realms is not structural.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// The harness's getElementById hands back a live stub for any id, and that is
// the only way a test can reach a control the screen rendered as markup.
function byId(client, id) {
  client.call("document.getElementById", id);
  return client.__byId.get(id);
}

function fakeFile(name, text) {
  return { name, text: async () => text, arrayBuffer: async () => new ArrayBuffer(0) };
}

function toastsOf(client) {
  const seen = [];
  client.set("showToast", (msg, kind) => seen.push({ msg: String(msg), kind }));
  return seen;
}

// A finished job on screen, with whatever review rows and titles the test wants.
function finish(client, opts) {
  const o = opts || {};
  client.set("appShellImportJob", {
    id: 7, status: "done", kind: o.kind || "movie", name: o.name || "Letterboxd Watchlist",
    total: o.total || 2, done: o.total || 2, matched: o.matched || 2,
    ambiguous: o.ambiguous || 0, unmatched: o.unmatched || 0, error: null,
  });
  return client;
}

describe("the shell's Imports screen", () => {
  it("renders the importer with no inline handlers", async () => {
    const client = loadImportsClient();
    client.call("appShellRenderImports");
    const markup = host(client);
    assert.match(markup, /Import a file/);
    assert.match(markup, /Letterboxd zip or CSV, an IMDb CSV, a Trakt export/);
    assert.ok(markup.includes('data-app-shell-action="import-pick"'), "the file picker is missing");
    assert.ok(markup.includes('id="appShellImportFileInput"'), "the file input is missing");
    assert.match(markup, /Nothing chosen yet/);
    assert.equal(/on[a-z]+=/.test(markup), false, "the screen must not add inline handlers");
  });

  it("does nothing at all on the old page", async () => {
    const client = loadClient({ newUi: false, routes: importRoutes({}) });
    assert.equal(client.call("appShellRenderImports"), false);
    assert.equal(await client.call("appShellResumeImport"), false);
    assert.equal(host(client), "");
  });

  it("signed out, points at signing in and asks nobody", async () => {
    const client = loadClient({ newUi: true, routes: importRoutes({}) });
    client.call("appShellRenderImports");
    const markup = host(client);
    assert.match(markup, /Sign in first/);
    assert.ok(markup.includes('data-app-shell-action="import-account"'));
    assert.equal(requestsTo(client, "/api/imports").length, 0);
    assert.equal(requestsTo(client, "/api/creator/lists/save").length, 0);
  });

  it("reads a Letterboxd CSV with the page's own parser", async () => {
    const client = loadImportsClient();
    const ok = await client.call("appShellImportReadFiles", [fakeFile("letterboxd-watchlist.csv", LETTERBOXD_CSV)]);
    assert.equal(ok, true);

    const file = plain(client.get("appShellImportFile"));
    assert.equal(file.counts.movie, 3);
    assert.equal(file.counts.series, 0);
    assert.equal(file.byKind.movie.length, 3);
    assert.deepEqual(file.byKind.movie[0], { title: "Fight Club", year: 1999, imdbId: null, tmdbId: null });
    assert.deepEqual(file.byKind.movie[2], { title: "Arrival", year: 2016, imdbId: null, tmdbId: null });

    const markup = host(client);
    assert.match(markup, /letterboxd-watchlist\.csv/);
    assert.match(markup, /3 titles/);
    assert.ok(markup.includes(">Movies (3)</button>"), "the kind chip should count the films");
    assert.match(markup, /Start the import \(3 titles\)/);
    // The name defaults to the file's own name, tidied up.
    assert.ok(markup.includes('id="appShellImportName" value="Letterboxd Watchlist"'), "the name should default to the file's");
  });

  it("reads a zip's CSVs through the page's own unzipper", async () => {
    const client = loadImportsClient();
    // A Letterboxd export is a zip of CSVs, and the page already loads fflate
    // for exactly this. The stub stands in for it: same call, same answer.
    client.set("fflate", {
      unzipSync: () => ({
        "export/watchlist.csv": LETTERBOXD_CSV,
        "__MACOSX/._watchlist.csv": "junk",
        "export/notes.txt": "no titles here",
      }),
      strFromU8: (u8) => String(u8),
    });
    await client.call("appShellImportReadFiles", [{
      name: "letterboxd-export.zip",
      arrayBuffer: async () => new ArrayBuffer(0),
      text: async () => "",
    }]);
    const file = plain(client.get("appShellImportFile"));
    assert.equal(file.counts.movie, 3);
    assert.equal(file.byKind.movie[0].title, "Fight Club");
    const markup = host(client);
    assert.match(markup, /letterboxd-export\.zip/);
    assert.ok(markup.includes('value="Letterboxd Export"'));
  });

  it("takes the ids an IMDb export gives it, and sends one kind at a time", async () => {
    const client = loadImportsClient();
    await client.call("appShellImportReadFiles", [fakeFile("imdb-export.csv", IMDB_CSV)]);
    const file = plain(client.get("appShellImportFile"));
    assert.deepEqual(file.counts, { movie: 1, series: 1 });
    // An imdb id survives as given: the server matches those without searching.
    assert.equal(file.byKind.movie[0].imdbId, "tt0137523");
    assert.equal(file.byKind.series[0].imdbId, "tt0903747");
    // A file with both opens on the bigger half -- here a coin toss, films.
    assert.equal(client.get("appShellImportKind"), "movie");

    await client.call("appShellImportsAction", "import-kind", "series");
    assert.equal(client.get("appShellImportKind"), "series");
    assert.match(host(client), /this sends the 1 shows/);
    assert.match(host(client), /Start the import \(1 title\)/);

    await client.call("appShellImportsAction", "import-start");
    const posted = requestsTo(client, "/api/imports");
    assert.equal(posted.length, 1);
    const body = plain(posted[0].body);
    assert.equal(body.kind, "series");
    assert.equal(body.rows.length, 1);
    assert.equal(body.rows[0].title, "Breaking Bad");
    assert.equal(body.rows[0].imdbId, "tt0903747");
  });

  it("refuses a kind the file does not hold, rather than sending the wrong rows", async () => {
    const client = loadImportsClient();
    const toasts = toastsOf(client);
    await client.call("appShellImportReadFiles", [fakeFile("letterboxd-watchlist.csv", LETTERBOXD_CSV)]);
    await client.call("appShellImportsAction", "import-kind", "series");
    assert.equal(await client.call("appShellImportsAction", "import-start"), false);
    assert.equal(requestsTo(client, "/api/imports").length, 0);
    assert.match(toasts[0].msg, /no shows in it/);
    // ...and the chip for the empty kind is disabled, so it is not a trap.
    assert.match(host(client), /data-app-shell-id="series" disabled/);
  });

  it("hands the rows over once, then shows the job's real progress", async () => {
    const client = loadImportsClient();
    await client.call("appShellImportReadFiles", [fakeFile("letterboxd-watchlist.csv", LETTERBOXD_CSV)]);
    const started = await client.call("appShellImportsAction", "import-start");
    assert.equal(started, true);

    const posted = requestsTo(client, "/api/imports");
    assert.equal(posted.length, 1);
    assert.equal(posted[0].method, "POST");
    assert.equal(posted[0].credentials, "same-origin");
    const body = plain(posted[0].body);
    assert.equal(body.kind, "movie");
    assert.equal(body.source, "file");
    assert.equal(body.name, "Letterboxd Watchlist");
    assert.equal(body.rows.length, 3);
    assert.deepEqual(body.rows[1], { title: "Pulp Fiction", year: 1994, imdbId: null, tmdbId: null });

    // The id is remembered, so leaving and coming back finds it again.
    assert.equal(client.get("localStorage.getItem('myListAddon:lastImport')"), "7");
    assert.match(host(client), /Matched <strong>0<\/strong> of 3/);
    assert.match(host(client), /You can close this page/);

    // A poll reads the job's own numbers.
    await client.call("appShellImportRefresh");
    const reads = requestsTo(client, "/api/imports/7");
    assert.equal(reads.length, 1);
    assert.equal(reads[0].method, "GET");
    assert.match(host(client), /Matched <strong>1<\/strong> of 3/);
    assert.match(host(client), /role="progressbar"/);
    assert.match(host(client), /aria-valuenow="33"/);
  });

  it("picks up an import that was already running instead of failing", async () => {
    const client = loadImportsClient({
      "/api/imports": async () => ({
        status: 409,
        json: { ok: false, error: "An import is already running. Wait for it to finish.", id: 7 },
      }),
      "/api/imports/7": async () => ({ json: status({ status: "running", done: 2, matched: 2 }) }),
    });
    const toasts = toastsOf(client);
    await client.call("appShellImportReadFiles", [fakeFile("letterboxd-watchlist.csv", LETTERBOXD_CSV)]);
    await client.call("appShellImportsAction", "import-start");

    assert.equal(client.get("localStorage.getItem('myListAddon:lastImport')"), "7");
    assert.equal(requestsTo(client, "/api/imports/7").length, 1, "the running import should have been read");
    assert.match(host(client), /Matched <strong>2<\/strong> of 3/);
    assert.match(toasts[toasts.length - 1].msg, /picked it up/);
  });

  it("offers the titles it could not place on its own, one decision at a time", async () => {
    const REVIEW = {
      ok: true,
      id: 7,
      review: [
        {
          row: 1, title: "The Thing", year: 1982,
          candidates: [
            { tmdbId: 1091, title: "The Thing", year: 1982, poster: "/p/1091.jpg" },
            { tmdbId: 4764, title: "The Thing", year: 2011, poster: "/p/4764.jpg" },
          ],
        },
      ],
    };
    let review = REVIEW;
    const client = loadImportsClient({
      "/api/imports/7": async () => ({
        json: status({ status: "done", total: 2, done: 2, matched: 1, ambiguous: 1, unmatched: 0 }),
      }),
      "/api/imports/7/review": async (req) => (req && req.method === "POST"
        ? { json: { ok: true, total: 2, done: 2, matched: 2, ambiguous: 0, unmatched: 0 } }
        : { json: review }),
      "/api/imports/7/result": async () => ({
        json: { ok: true, id: 7, done: true, items: [{ id: "tt1", type: "movie", name: "Arrival", year: 2016 }] },
      }),
    }, { storage: { "myListAddon:lastImport": "7" } });
    // The page load resumed once by itself; this test resumes on purpose.
    await new Promise((resolve) => setImmediate(resolve));
    client.set("appShellImportsResumed", false);
    client.requests.length = 0;

    // Leave and come back: nothing on screen, the remembered import is read.
    assert.equal(client.get("appShellImportJob"), null);
    assert.equal(await client.call("appShellResumeImport"), true);

    const markup = host(client);
    assert.match(markup, /Review 1 title/);
    assert.match(markup, /The Thing/);
    assert.ok(markup.includes('data-app-shell-id="1|1091"'), "the 1982 candidate is missing");
    assert.ok(markup.includes('data-app-shell-id="1|4764"'), "the 2011 candidate is missing");
    assert.ok(markup.includes('data-app-shell-id="1|skip"'), "Skip is missing");
    assert.match(markup, /Save 1 titles as a list/);

    // One press, one choice, and the row leaves the review.
    review = { ok: true, id: 7, review: [] };
    await client.call("appShellImportsAction", "import-choose", "1|1091");
    const posts = requestsTo(client, "/api/imports/7/review").filter((r) => r.method === "POST");
    assert.equal(posts.length, 1);
    assert.deepEqual(plain(posts[0].body), { choices: [{ row: 1, tmdbId: 1091 }] });
    assert.equal(client.get("appShellImportJob").ambiguous, 0);
    assert.equal(client.get("appShellImportReview").length, 0);
    assert.equal(/Review 1 title/.test(host(client)), false, "a decided row should not still be waiting");
  });

  it("can skip a row, which says it as such", async () => {
    const client = loadImportsClient({
      "/api/imports/7/review": async (req) => (req && req.method === "POST"
        ? { json: { ok: true, total: 2, done: 2, matched: 1, ambiguous: 0, unmatched: 1 } }
        : { json: { ok: true, id: 7, review: [{ row: 0, title: "The Thing", year: 1982, candidates: [{ tmdbId: 1091, title: "The Thing", year: 1982, poster: "" }] }] } }),
      "/api/imports/7/result": async () => ({ json: { ok: true, id: 7, done: true, items: [] } }),
    });
    finish(client);
    await client.call("appShellImportLoadDone", true);
    client.call("appShellRenderImports");

    await client.call("appShellImportsAction", "import-choose", "0|skip");
    const posts = requestsTo(client, "/api/imports/7/review").filter((r) => r.method === "POST");
    assert.equal(posts.length, 1);
    assert.deepEqual(plain(posts[0].body), { choices: [{ row: 0, tmdbId: null }] });
  });

  it("saves the result as a list and puts one row on the home screen", async () => {
    const client = loadImportsClient({
      "/api/imports/7/result": async () => ({
        json: {
          ok: true, id: 7, done: true,
          items: [
            { id: "tt0137523", type: "movie", name: "Fight Club", year: 1999 },
            { id: "tmdb:680", type: "movie", name: "Pulp Fiction", year: 1994 },
          ],
        },
      }),
    });
    const added = [];
    const removed = [];
    let onHome = false;
    client.set("addRow", (name, url, type, enabled, group) => {
      added.push({ name, url, type, enabled, group });
      onHome = true;
    });
    client.set("removeListFromConfig", (...args) => { removed.push(args[2]); onHome = false; });
    client.set("isListAddedToConfig", () => onHome);
    client.set("generateChannelId", () => "row-9");
    client.set("renumber", () => {});
    client.set("saveState", () => {});

    finish(client);
    await client.call("appShellImportLoadDone", true);
    client.call("appShellRenderImports");
    assert.match(host(client), /Import finished/);
    assert.match(host(client), /Save 2 titles as a list/);
    assert.ok(host(client).includes('id="appShellImportHomeToggle"'), "the one toggle is missing");
    assert.ok(host(client).includes('aria-valuenow="100"'), "the finished job should read as done");

    // The checkbox is ticked in the rendered HTML; the stub cannot read that,
    // so a test ticks it the way a person would.
    byId(client, "appShellImportHomeToggle").checked = true;
    assert.equal(await client.call("appShellImportsAction", "import-save"), true);

    const saves = requestsTo(client, "/api/creator/lists/save");
    assert.equal(saves.length, 1);
    const body = plain(saves[0].body);
    assert.equal(body.name, "Letterboxd Watchlist");
    assert.equal(body.type, "movie");
    assert.equal(body.visibility, "private");
    // The route authenticates with these (empty strings would fall back to a
    // session cookie), exactly as the Lists view's own save does.
    assert.equal(body.creatorName, "alice");
    assert.equal(body.creatorKey, "KEY-1");
    assert.equal(body.items.length, 2);
    assert.deepEqual(body.items[0], {
      id: "tt0137523", imdbId: "tt0137523", tmdbId: "", type: "movie",
      name: "Fight Club", title: "Fight Club",
      poster: "https://images.metahub.space/poster/medium/tt0137523/img", year: 1999,
    });
    // A title the server only knows by TMDB id still gets a usable id.
    assert.equal(body.items[1].imdbId, "");
    assert.equal(body.items[1].tmdbId, "680");

    // One row, in the same shape the Lists view's own toggle builds.
    assert.equal(added.length, 1);
    assert.equal(added[0].name, "Letterboxd Watchlist");
    assert.equal(added[0].type, "movie");
    assert.equal(added[0].enabled, true);
    assert.equal(added[0].group, "My Lists");
    assert.match(added[0].url, /^customlist:v1:/);
    const snapshot = JSON.parse(added[0].url.slice("customlist:v1:".length));
    assert.equal(snapshot.localSlug, "letterboxd-watchlist");
    assert.equal(snapshot.listSlug, "letterboxd-watchlist");
    assert.equal(snapshot.type, "movie");
    assert.equal(snapshot.items.length, 2);
    assert.equal(snapshot.listId, "row-9");

    assert.match(host(client), /On your home screen/);
    assert.ok(host(client).includes('data-app-shell-id="off"'), "the toggle should now offer to remove it");

    // ...and the screen offers the way on: another file.
    assert.ok(host(client).includes('data-app-shell-action="import-forget"'));

    // ...and the same control takes it back off.
    assert.equal(await client.call("appShellImportsAction", "import-home", "off"), true);
    assert.deepEqual(removed, ["letterboxd-watchlist", "letterboxd-watchlist", "letterboxd-watchlist"]);
    assert.match(host(client), /Show it on my home screen/);
    assert.ok(host(client).includes('data-app-shell-id="on"'));
  });

  it("leaves the home screen alone when the toggle is off", async () => {
    const client = loadImportsClient({
      "/api/imports/7/result": async () => ({
        json: { ok: true, id: 7, done: true, items: [{ id: "tt1", type: "movie", name: "Arrival", year: 2016 }] },
      }),
    });
    const added = [];
    client.set("addRow", (...args) => added.push(args));
    client.set("isListAddedToConfig", () => false);

    finish(client, { total: 1, matched: 1 });
    await client.call("appShellImportLoadDone", true);
    client.call("appShellRenderImports");
    byId(client, "appShellImportHomeToggle").checked = false;

    await client.call("appShellImportsAction", "import-save");
    assert.equal(requestsTo(client, "/api/creator/lists/save").length, 1);
    assert.deepEqual(added, [], "the list is saved either way; the toggle only decides the home screen");
    assert.match(host(client), /Show it on my home screen/);

    // "Import another file" starts over rather than leaving the finished one
    // on screen forever.
    assert.equal(await client.call("appShellImportsAction", "import-forget"), true);
    assert.equal(client.get("appShellImportJob"), null);
    assert.equal(client.get("appShellImportSaved"), null);
    assert.equal(client.get("localStorage.getItem('myListAddon:lastImport')"), null);
    assert.match(host(client), /Choose a file/);
  });

  it("says an import finished once, and keeps saying the numbers", async () => {
    const client = loadImportsClient();
    const toasts = toastsOf(client);
    client.set("appShellImportJob", { id: 7, status: "running", kind: "movie", name: "Watchlist", total: 3, done: 1, matched: 1, ambiguous: 0, unmatched: 0, error: null });
    // The job finished while the tab was open: the poll reads "done" and the
    // page says so -- once, however many times it asks.
    const client2Routes = {
      "/api/imports/7": async () => ({
        json: status({ status: "done", total: 3, done: 3, matched: 3, ambiguous: 0, unmatched: 0 }),
      }),
    };
    const second = loadImportsClient(client2Routes, { storage: { "myListAddon:lastImport": "7" } });
    const seen = toastsOf(second);
    second.set("appShellImportsResumed", false);
    second.requests.length = 0;

    await second.call("appShellImportRefresh");
    await second.call("appShellImportRefresh");
    assert.equal(requestsTo(second, "/api/imports/7").length, 2, "both reads should go out");
    const said = seen.filter((t) => /finished/.test(t.msg));
    assert.equal(said.length, 1, "an import should be announced once, not on every visit");
    assert.match(said[0].msg, /3 of 3 titles matched/);

    // The running screen still reports what the server last said.
    await client.call("appShellImportRefresh");
    assert.match(host(client), /Matched <strong>1<\/strong> of 3/);
    assert.equal(toasts.filter((t) => /finished/.test(t.msg)).length, 0);
  });

  it("reads the import's status again when the Lists view is opened", async () => {
    const client = loadImportsClient({}, { storage: { "myListAddon:lastImport": "7" } });
    client.set("appShellImportsResumed", false);
    client.requests.length = 0;

    // Opening Lists > Import is what asks: the view does not poll in the
    // background, and a page load that never goes there sends nothing.
    assert.equal(client.call("appShellApplyRoute", { tab: "lists", sub: "import" }), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requestsTo(client, "/api/imports/7").length, 1);

    // A second visit does not ask again for the same page load.
    assert.equal(await client.call("appShellResumeImport"), true);
    assert.equal(requestsTo(client, "/api/imports/7").length, 1);
  });

  it("forgets an import the server no longer has", async () => {
    const client = loadImportsClient({
      "/api/imports/7": async () => ({ status: 404, json: { ok: false, error: "Not found." } }),
    }, { storage: { "myListAddon:lastImport": "7" } });
    await client.call("appShellImportRefresh");
    assert.equal(client.get("localStorage.getItem('myListAddon:lastImport')"), null);
    assert.equal(client.get("appShellImportJob"), null);
  });

  it("agrees with the server about how many rows one import can hold", async () => {
    // The screen reads and trims the file itself, so its ceiling has to be the
    // server's (IMPORT_ROWS_MAX, 49_imports.js) and not a number of its own.
    const source = fs.readFileSync(new URL("../49_imports.js", import.meta.url), "utf8");
    const match = source.match(/const IMPORT_ROWS_MAX = (\d+);/);
    assert.ok(match, "IMPORT_ROWS_MAX should be declared in 49_imports.js");
    const client = loadImportsClient();
    assert.equal(client.get("APP_SHELL_IMPORT_ROWS_MAX"), Number(match[1]));
  });
});
