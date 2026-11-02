// Parity guard for the functions that exist twice: once in the Worker and once
// in the page's own script (docs/CODE_QUALITY_AUDIT.md, CQ-03). The client
// cannot import server code, so each pair is a hand copy. This runs both copies
// on the same inputs and fails the moment one of them changes a rule the other
// does not. It does not merge the copies.
//
// The server copies come from the combined Worker, evaluated in a vm the way
// tests/client-harness.mjs renderPage does (tests/harness.mjs is imported first
// because it refuses to run against a stale build). The client copies come from
// tests/client-harness.mjs loadClient, which runs the real rendered page script,
// so the doubled backslashes in client regexes are cooked exactly as in a browser.
//
// A case marked { todo } is a place where the two copies already DISAGREE. It
// is reported, not hidden, and neither function was changed to make it pass.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import "./harness.mjs";
import { loadClient } from "./client-harness.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Local noon, Monday 15 June 2026. Both copies read "today" from `new Date()`
// in local time, so a local-time pin keeps the day arithmetic the same in
// every time zone.
const PINNED = new Date(2026, 5, 15, 12, 0, 0).getTime();
class PinnedDate extends Date {
  constructor(...args) { if (args.length === 0) super(PINNED); else super(...args); }
  static now() { return PINNED; }
}

function loadServer() {
  let src = fs.readFileSync(path.join(ROOT, "worker_entry_combined.js"), "utf8");
  // Later numbered files (61_ and up) sit after `export default`, so the
  // keyword is swapped for a plain assignment rather than cutting the text off.
  const at = src.lastIndexOf("export default");
  src = src.slice(0, at) + "var __workerDefault = " + src.slice(at + "export default".length);
  const sandbox = {
    console, Date: PinnedDate, Math, JSON, TextEncoder, TextDecoder, URL, URLSearchParams,
    crypto: globalThis.crypto,
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    fetch: async () => { throw new Error("no network"); },
    caches: { default: { match: async () => null, put: async () => {} } },
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "worker_entry_combined.js" });
  return sandbox;
}

const server = loadServer();
const client = loadClient();
client.Date = PinnedDate;
const clientFn = (name) => {
  const fn = client.get(name);
  assert.equal(typeof fn, "function", `${name} is defined on the client`);
  return fn;
};
const serverFn = (name) => {
  assert.equal(typeof server[name], "function", `${name} is defined on the server`);
  return server[name];
};

// The two copies run in different vm realms, so arrays and objects have
// different prototypes. Compare plain data.
const plain = (v) => (v === undefined ? "__undefined__" : JSON.parse(JSON.stringify(v)));

// cases: [{ args: [...], todo?: "what differs" }]. serverCall/clientCall take
// the args and return the observable result; norm maps a result to what is compared.
function parity(title, cases, { serverCall, clientCall, norm = plain }) {
  describe(title, () => {
    cases.forEach((c, i) => {
      const label = `#${i + 1} ${JSON.stringify(c.args).slice(0, 90)}`;
      const body = () => {
        const s = norm(serverCall(...c.args));
        const k = norm(clientCall(...c.args));
        assert.deepStrictEqual(k, s, `server and client disagree on ${JSON.stringify(c.args)}`);
      };
      if (c.todo) it(label, { todo: c.todo }, body);
      else it(label, body);
    });
  });
}
const same = (name) => ({ serverCall: (...a) => serverFn(name)(...a), clientCall: (...a) => clientFn(name)(...a) });

parity("isAdultOrNsfw", [
  { args: [null] }, { args: [undefined] }, { args: [{}] },
  { args: [{ adult: true }] }, { args: [{ isAdult: true }] }, { args: [{ adult: "true" }] },
  { args: [{ certification: "NC-17" }] }, { args: [{ certification: "nc-17" }] },
  { args: [{ certification: " xxx " }] }, { args: [{ ageRating: "R18+" }] },
  { args: [{ contentRating: "tv-ma-s" }] }, { args: [{ certification: "TV-MA" }] },
  { args: [{ certification: "X" }] }, { args: [{ certification: "rx" }] }, { args: [{ certification: "XX" }] },
  { args: [{ certification: "TV-MA (ADULT)" }] }, { args: [{ certification: "adult" }] },
  { args: [{ certification: "R" }] }, { args: [{ certification: "18+" }] },
  { args: [{ certification: "PG-13", ageRating: "X" }] },
  { args: [{ genres: ["Drama", "Hentai"] }] }, { args: [{ genres: [{ name: "Erotica" }] }] },
  { args: [{ genres: [null, { id: 3 }, 7, "comedy"] }] },
  { args: [{ genres: "Comedy, Adult" }] }, { args: [{ genres: "Comedy,Drama" }] },
  { args: [{ genres: ["Adult Animation"] }] }, { args: [{ genres: [] }] },
  { args: [{ title: "Brazzers Exxtra" }] }, { args: [{ name: "A Porn Star Is Born" }] },
  { args: [{ listName: "My BDSM picks" }] }, { args: [{ user: "evil angel" }] },
  { args: [{ title: "Pornography of the Mind" }] }, { args: [{ title: "Class of 1984" }] },
  { args: [{ title: "Hardcore Henry" }] }, { args: [{ title: "Scunthorpe" }] },
  { args: [{ title: "Milfoil" }] }, { args: [{ showTitle: "Sweet Sinner", franchise: "x" }] },
], same("isAdultOrNsfw"));

parity("getSafePosterUrl (compared as path + query values)", [
  { args: [{ title: "The Matrix", year: "1999", type: "movie", certification: "NC-17" }] },
  { args: [{ title: "Show & Tell: 100%", year: 2020, type: "series", certification: "X" }] },
  { args: [{ title: "Über Café", year: "2021", type: "movie", certification: "XXX" }] },
  { args: [{ title: "Two  Spaces", year: "2001", type: "series", certification: "ADULT" }] },
  { args: [{ title: "No Cert", year: "2001", type: "movie", certification: "" }] },
  { args: [{ title: "No Year", year: "", type: "movie", certification: "X" }] },
  { args: [{ title: "No Year Null", year: null, type: "series", certification: "X" }] },
  { args: [{ title: "Slash/Plus+Equals=", year: "1", type: "movie", certification: "R18+" }] },
  { args: [{ title: "Quote\"Apos'", year: "1999", type: "series", certification: "18+" }] },
  { args: [{ title: "Only a title" }], todo: "client defaults an empty type to 'movie' (or 'series' when showId is set) and server leaves type out" },
  { args: [{ title: "", year: "2000", type: "movie", certification: "X" }], todo: "client always writes title= (even empty); server leaves an empty title out" },
  { args: [{ year: "2000", type: "movie", certification: "X" }], todo: "client always writes title= (even empty); server leaves a missing title out" },
  { args: [{ title: "Typed Series", year: "2000", type: "tv", certification: "X" }] },
], {
  serverCall: (item) => server.getSafePosterUrl("https://example.com", item),
  clientCall: (item) => clientFn("getSafePosterUrl")(item),
  norm: (u) => {
    const url = new URL(u, "https://example.com");
    return { path: url.pathname, origin: url.origin, params: Object.fromEntries([...url.searchParams.entries()].sort()) };
  },
});

parity("isEpisodeAired (string input, today pinned to 2026-06-15)", [
  { args: ["2026-06-14"] }, { args: ["2026-06-15"] }, { args: ["2026-06-16"] },
  { args: ["2020-01-01"] }, { args: ["2030-01-01"] },
  { args: ["2026-06-14T23:00:00Z"] }, { args: ["2026-06-14 08:00"] }, { args: ["2026-06-15T00:00:00"] },
  { args: ["2026-6-1"] }, { args: ["2026-13-01"] }, { args: ["2026-02-30"] },
  { args: ["2026-06"] }, { args: ["2026"] }, { args: ["TBA"] }, { args: ["abc-de-fg"] },
  { args: [""] }, { args: [null] }, { args: [undefined] }, { args: [0] }, { args: [20260614] },
], same("isEpisodeAired"));

parity("isGenericEpisodeTitle", [
  { args: [null, 1] }, { args: [undefined] }, { args: ["", 1] }, { args: ["   ", 1] }, { args: [42, 1] },
  { args: ["TBA", 1] }, { args: ["tbd", 1] }, { args: ["TBA - Season 2", 1] }, { args: ["Untitled", 1] },
  { args: ["Unknown", 1] }, { args: ["N/A", 1] }, { args: ["None", 1] }, { args: ["-", 1] }, { args: ["--", 1] },
  { args: ["Episode 5", 5] }, { args: ["episode   12", 3] }, { args: ["Episode 5 ", 5] }, { args: ["Episode 5: Pilot", 5] },
  { args: ["Season 2", 1] }, { args: ["Series 3", 1] }, { args: ["Season 3, Episode 6", 6] },
  { args: ["Season 3 Episode 6", 6] }, { args: ["S03E06", 6] }, { args: ["s3 e6", 6] }, { args: ["S03E06 Pilot", 6] },
  { args: ["Season Premiere", 1] }, { args: ["season finale", 1] }, { args: ["Episode Finale", 1] },
  { args: ["Series Premiere", 1] }, { args: ["Series Finale", 1] }, { args: ["Season Finale: Part 2", 1] },
  { args: ["Ep 7", 7] }, { args: ["ep. 7", 7] }, { args: ["Ep 7", 8] }, { args: ["Ep 7", null] }, { args: ["Ep 7", "7"] },
  { args: ["Ep 7", "x"] }, { args: ["Episode 7", 8] },
  { args: ["Sugar Land", 6] }, { args: ["A Pretty Nasty One", 11] }, { args: ["Tba Tba", 1] }, { args: ["Tbaby", 1] },
], same("isGenericEpisodeTitle"));

// Server badges are upper case and the client's are title case on purpose, so
// the comparison ignores case. The RULE (which day gets which label) must match.
parity("formatAirDateBadge (today pinned to 2026-06-15, compared ignoring case)", [
  { args: ["2026-06-15"] }, { args: ["2026-06-16"] }, { args: ["2026-06-17"] }, { args: ["2026-06-20"] },
  { args: ["2026-06-21"] }, { args: ["2026-06-22"] }, { args: ["2026-07-04"] }, { args: ["2026-12-31"] },
  { args: ["2027-01-05"] }, { args: ["2030-03-03"] }, { args: ["2026-06-16T20:00:00Z"] }, { args: ["2026-06-17 21:00"] },
  { args: ["2026-6-18"] }, { args: ["2026-13-01"] }, { args: ["2026-06"] }, { args: ["TBA"] },
  { args: [""] }, { args: [null] }, { args: [undefined] },
], {
  ...same("formatAirDateBadge"),
  norm: (v) => (typeof v === "string" ? v.toUpperCase() : plain(v)),
});

// INTENDED difference, not a bug: the owner chose on 2026-11-02 that Stremio and
// Nuvio posters (server) say "AIRED" for a day already past, while the web page
// (client) shows nothing for it. Today and tomorrow still match on both sides.
describe("formatAirDateBadge: past dates differ on purpose (owner decision 2026-11-02)", () => {
  const cases = [
    ["2026-06-14", "AIRED", ""], ["2025-01-01", "AIRED", ""],
    ["2026-06-15", "TODAY", "TODAY"], ["2026-06-16", "TOMORROW", "TOMORROW"],
  ];
  for (const [date, serverWants, clientWants] of cases) {
    it(`${date}: server "${serverWants}", client "${clientWants}"`, () => {
      assert.equal(String(serverFn("formatAirDateBadge")(date)).toUpperCase(), serverWants);
      assert.equal(String(clientFn("formatAirDateBadge")(date)).toUpperCase(), clientWants);
    });
  }
});

// Random ids ("col_mylists_" + 6 random characters) are the one thing that
// differs run to run, so they are masked. Ids the input supplies are kept.
// Every random collection id ("col_mylists_" + up to 6 base-36 chars) is masked.
// No input id in these cases has that shape, so stable ids are still compared.
const maskIds = (v) => JSON.parse(JSON.stringify(v), (k, x) => (typeof x === "string" && /^col_mylists_[a-z0-9]{1,6}$/.test(x) ? "col_mylists_<random>" : x));

const folderA = { id: "f1", title: "Action", catalogSources: [{ addonId: "a", type: "movie", catalogId: "x", name: "Top (Movies)" }] };
const folderB = { id: "f2", title: "Drama", catalogSources: [{ addonId: "a", type: "series", catalogId: "y", title: "Best (Shows)" }] };
const myLists = { id: "my-lists-collections", title: "My Lists Collections", folders: [folderA] };
const other = { id: "other-1", title: "Community Pack", folders: [{ id: "o1", title: "Cool" }] };

const NUVIO_RAWS = [
  null, undefined, "", "not json", "[]", "{}", 0,
  [], [null, undefined], [myLists], [myLists, other], { collections: [myLists] }, { collections_json: JSON.stringify([other]) },
  { p_collections_json: [other] }, { p_collections: [myLists, other] }, { data: [other] }, { data: { collections: [other] } },
  JSON.stringify([myLists]), JSON.stringify({ collections: [other] }), JSON.stringify("text"),
  [{ collections_json: [other] }, { p_collections: [myLists] }, { data: [folderB] }, { collections: [] }],
  [{ title: "  " }, { name: "Named" }, { folders: [{ id: "z" }] }, { catalogSources: [{ x: 1 }] }, { id: 0 }, { id: "q" }, {}],
  { title: "Single" }, { name: "Single by name" }, { folders: [folderA] }, { catalogSources: [{ catalogId: "c" }] }, { id: "only-id" },
  { unrelated: true }, [1, "a", true],
];
parity("extractNuvioCollections", NUVIO_RAWS.map((r) => ({ args: [r] })), same("extractNuvioCollections"));

parity("isMyListsNuvioCollectionId", [
  "my-lists-collections", "my-lists-addon", "col_mylists_abc123", "col_mylists_", "col_mylists", "COL_MYLISTS_X",
  "My-Lists-Collections", " my-lists-collections", "my-lists-collections ", "other-1", "", null, undefined, 0, 123, "xcol_mylists_a",
].map((v) => ({ args: [v] })), same("isMyListsNuvioCollectionId"));

const mergeCases = [
  [null, null], [[], []], [[myLists], []], [[], [myLists]], [[myLists, other], []], [[], [myLists, other]],
  [[other], [myLists]], [[myLists, other], [{ id: "my-lists-collections", folders: [folderB] }]],
  [[myLists], [{ id: "my-lists-collections", folders: [{ ...folderA, title: "Action Updated" }] }]],
  [[myLists], [{ title: "my lists", folders: [folderB] }]], [[myLists], [{ title: "MY LISTS ADDON", folders: [folderB] }]],
  [[myLists, { id: "dup", title: "My Lists Collections", folders: [folderB] }], [{ id: "n", title: "N", folders: [{ id: "f9", title: "Nine" }] }]],
  [[other], [{ id: "other-1", title: "Community Pack v2", folders: [] }]],
  [[other, null, myLists], [{ id: "fresh", title: "Fresh", folders: [{ id: "f3", title: "Three", catalogSources: [{ name: "Z (TV) (Movies)" }] }] }]],
  [[myLists], [{ id: "f2", title: "drama" }, { id: "f9", name: "Nameonly" }, { title: "" }, null, {}]],
  [[{ id: "my-lists-addon", title: "Legacy" }], [{ id: "x", folders: [folderA] }]],
  [[{ id: "keepme", title: "Plain", folders: [] }], [{ title: "Loose", catalogSources: [{ catalogId: "c", name: "C (Series)" }] }]],
  [JSON.stringify([myLists]), JSON.stringify({ collections: [other] })],
  [[{ title: "My Lists", folders: [{ name: "Case Test" }] }], [{ id: "x", folders: [{ name: "case test", title: "Changed" }] }]],
  [[myLists], [{ id: "f", folders: [{ id: "f1", hidden: true, isVisible: false, enabled: false }] }]],
  [[{ id: "my-lists-collections", folders: "oops" }], [{ id: "x", folders: [folderB] }]],
];
parity("mergeNuvioCollections", mergeCases.map((a) => ({ args: a })), { ...same("mergeNuvioCollections"), norm: (v) => maskIds(plain(v)) });

const addCases = [
  [null, null], [[myLists], null], [[myLists, other], []], [[], [other]], [[myLists], [other]],
  [[myLists], [{ id: "my-lists-collections", title: "Dup id", folders: [folderB] }]],
  [[other], [{ id: "fresh", title: "Fresh (Movies)", folders: [folderA, folderB] }]],
  [[], [{ title: "Loose Folder", catalogSources: [{ catalogId: "c", name: "C (TV)" }] }]],
  [[], [{ id: "a", title: "A" }, { id: "b", title: "B" }], { collectionName: "Ignored for two" }],
  [[], [{ id: "a", title: "A" }], { collectionName: "Renamed (Shows)" }],
  [[], [{ id: "a", title: "A" }], { collectionName: "" }],
  [[], [{ id: "a", title: "A", viewMode: "ROWS" }]], [[], [{ id: "a", title: "A", backdropImageUrl: "https://x/b.jpg" }]],
  { args: [[], [{ id: "a", title: "A" }], { backdropImageUrl: "https://x/opt.jpg" }], todo: "the options.backdropImageUrl setting is honoured by the server only; the client drops it" },
  [[], [{ id: "a", title: "A", backdropImageUrl: "https://x/own.jpg" }], { backdropImageUrl: "https://x/opt.jpg" }],
  [[], [{ id: "a", title: "(Movies)", folders: [folderA] }], {}],
  [[], [{ id: "a", title: "(Shows)" }], { collectionName: " (TV) " }],
  [[], [{ id: "a", title: "Tab\t(Movies)" , folders: [folderA] }], {}],
  [[], [{ id: "a", title: "Line\n(Movies)", folders: [folderA] }], {}],
  [[], [{ id: "a", title: "Nbsp (Movies)", folders: [folderA] }], {}],
  [[], [{ id: "a", name: "By Name (Series)", folders: [] }]], [[], [{ id: "a", folders: [{ id: "q", catalogSources: [{ title: "T (tv)" }, { catalogId: "cid" }, { name: "" }] }] }]],
  [[null, other], [{ id: "a", title: "A" }]],
];
// The server writes backdropImageUrl: "" on every new collection and the
// client leaves the key out. An empty value and no value mean the same to
// Nuvio, so that one empty key is dropped before comparing; a real URL is not.
// A name that is only a media suffix ("(Movies)") must fall back to the default
// name on both sides, never an empty one (owner decision 2026-11-02).
it("addNewNuvioCollection: a suffix-only name becomes 'My Lists Collections' on the server", () => {
  const out = serverFn("addNewNuvioCollection")([], [{ id: "a", title: "(Movies)", folders: [folderA] }], {});
  assert.equal(out[0].title, "My Lists Collections");
  assert.equal(out[0].name, "My Lists Collections");
});
const dropEmptyBackdrop = (v) => JSON.parse(JSON.stringify(v), (k, x) => (k === "backdropImageUrl" && x === "" ? undefined : x));
parity("addNewNuvioCollection", addCases.map((a) => (Array.isArray(a) ? { args: a } : a)), { ...same("addNewNuvioCollection"), norm: (v) => dropEmptyBackdrop(maskIds(plain(v))) });

const rowSL = (o) => "channel:v1:" + JSON.stringify(o);
parity("isPublicChannelRow", [
  rowSL({ storylineId: "abc" }), rowSL({ storylineId: "a" }), rowSL({ storylineId: "A" }), rowSL({ storylineId: "-a" }),
  rowSL({ storylineId: "a_b-c9" }), rowSL({ storylineId: "a".repeat(81) }), rowSL({ storylineId: "a".repeat(82) }),
  rowSL({ storylineId: "has space" }), rowSL({ storylineId: 5 }), rowSL({ shareCode: "AbC_-9" }), rowSL({ shareCode: "x".repeat(64) }),
  rowSL({ shareCode: "x".repeat(65) }), rowSL({ shareCode: "" }), rowSL({ shareCode: "bad code" }), rowSL({ shareCode: "bad!" }),
  rowSL({}), rowSL([]), rowSL(null), rowSL("str"), rowSL({ storylineId: "bad id", shareCode: "good" }),
  "channel:v1:{not json", "channel:v1:", "  " + rowSL({ shareCode: "ok" }) + "  ", "other:v1:" + JSON.stringify({ shareCode: "ok" }),
  JSON.stringify({ shareCode: "ok" }), "", null, undefined, 12,
].map((v) => ({ args: [v] })), same("isPublicChannelRow"));
