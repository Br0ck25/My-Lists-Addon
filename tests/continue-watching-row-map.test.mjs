// CQ-02: one stored continue_watching row -> one item, written once.
// The catalog read path and the creator-tracking read path both used to carry
// their own copy of this (COMPANION: marker, movie vs episode, 17 fields). A fix
// in one would not reach the other, so both now call mapContinueWatchingRow.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const bundle = readFileSync(new URL("../worker_entry_combined.js", import.meta.url), "utf8");
const tmpFile = `${tmpdir()}/mla-cwmap-${process.pid}-${Date.now()}.mjs`;
writeFileSync(tmpFile, bundle + "\nexport const __m = { mapContinueWatchingRow };\n");
const { __m } = await import(pathToFileURL(tmpFile).href).finally(() => unlinkSync(tmpFile));
const map = __m.mapContinueWatchingRow;

const row = (o) => ({ item_id: "i1", show_id: "s1", name: "N", poster: "p", show_title: null, show_poster: null, season_num: null, episode_num: null, updated_at: 5, ...o });

test("a row with no season, episode or show title is a movie, and has no showId", () => {
  const m = map(row({}));
  assert.equal(m.type, "movie"); assert.equal(m.kind, "movie"); assert.equal(m.showId, undefined);
});
test("a row with a show title and numbers is an episode that keeps its showId", () => {
  const m = map(row({ show_title: "Show", season_num: 2, episode_num: 3 }));
  assert.equal(m.type, "episode"); assert.equal(m.kind, undefined); assert.equal(m.showId, "s1");
  assert.equal(m.seasonNum, 2); assert.equal(m.episodeNum, 3); assert.equal(m.showTitle, "Show"); assert.equal(m.updatedAt, 5);
});
test("a COMPANION: row is unpacked, and a companion movie stays a movie", () => {
  const meta = { companionType: "prequel", companionNote: "n", companionStoryline: "st", precedingShowId: "p9", showTitle: "Real", type: "movie" };
  const m = map(row({ show_title: "COMPANION:" + JSON.stringify(meta) }));
  assert.deepEqual([m.isCompanion, m.companionType, m.companionNote, m.companionStoryline, m.precedingShowId, m.showTitle, m.type, m.kind],
    [true, "prequel", "n", "st", "p9", "Real", "movie", "movie"]);
});
test("a COMPANION: row with broken JSON falls back to a plain episode row, not a crash", () => {
  const m = map(row({ show_title: "COMPANION:{oops", season_num: 1, episode_num: 1 }));
  assert.equal(m.type, "episode"); assert.equal(m.isCompanion, undefined);
});
test("the row-to-item mapping exists once in the sources", () => {
  const dirs = ["core", "catalog"].flatMap((d) => readdirSync(new URL(`../src/${d}/`, import.meta.url)).map((f) => `../src/${d}/${f}`));
  const hits = dirs.filter((f) => /let type = \(r\.season_num == null && r\.episode_num == null && !r\.show_title\)/.test(readFileSync(new URL(f, import.meta.url), "utf8")));
  assert.equal(hits.length, 1, "found in: " + hits.join(", "));
});
