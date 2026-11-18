// API-06: Simkl charts keep TMDB-only titles, carry a year, and type an anime
// movie as a movie, the way the Trakt and MDBList mappers already do.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync(new URL("../src/catalog/07_source-fetchers-tmdb-simkl.js", import.meta.url), "utf8");
const start = src.indexOf("function mapSimklItems");
const end = src.indexOf("\n}\n", start) + 3;
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src.slice(start, end), sandbox);
const map = (data, type, anime) => JSON.parse(JSON.stringify(sandbox.mapSimklItems(data, type, anime)));

const data = [
  { title: "Has IMDb", ids: { imdb: "tt1111111", tmdb: "1" }, release_date: "08/12/2026" },
  { title: "TMDB only film", ids: { tmdb: "22222" }, release_date: "2025-03-04" },
  { title: "Anime movie", ids: { imdb: "tt3333333" }, anime_type: "movie", release_date: "06/17/2026" },
  { title: "Anime show", ids: { imdb: "tt4444444" }, anime_type: "tv" },
  { title: "No ids at all", ids: {} },
];

describe("Simkl chart mapping (API-06)", () => {
  it("keeps a title that only has a TMDB id, as tmdb:<id>", () => {
    const m = map(data, "movie", false);
    const t = m.find((x) => x.name === "TMDB only film");
    assert.equal(t.id, "tmdb:22222");
    assert.equal(m.some((x) => x.name === "No ids at all"), false);
  });

  it("sends the year from release_date, in either date form", () => {
    const m = map(data, "movie", false);
    assert.equal(m[0].releaseInfo, "2026");
    assert.equal(m[1].releaseInfo, "2025");
  });

  it("types an anime movie as a movie and other anime as the row's type", () => {
    const m = map(data, "series", true);
    assert.equal(m.find((x) => x.name === "Anime movie").type, "movie");
    assert.equal(m.find((x) => x.name === "Anime show").type, "series");
  });

  it("does not look at anime_type outside the anime chart", () => {
    const m = map(data, "series", false);
    assert.equal(m.find((x) => x.name === "Anime movie").type, "series");
  });
});
