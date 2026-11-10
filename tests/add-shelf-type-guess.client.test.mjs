// Audit PROD-01: typing a link into "+ New Catalog" switched the type to Shows
// whenever the text contained "tv" anywhere, and "trakt.tv" does. Only the path
// and query of the link are looked at now, for whole words.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadClient } from "./client-harness.mjs";

function typeFor(link, startingType = "movie") {
  const client = loadClient({});
  client.document.getElementById("addShelfModalType").value = startingType;
  client.document.querySelectorAll = () => [{}]; // one link box, as the dialog opens
  client.call("onAddShelfModalLinkInput", { value: link });
  return client.document.getElementById("addShelfModalType").value;
}

describe("PROD-01: guessing a new catalog's type from its link", () => {
  for (const link of [
    "https://trakt.tv/users/bob/lists/best-action-films",
    "https://trakt.tv/users/bob/lists/best-tv-moments",
    "https://mdblist.com/lists/bob/best-action",
    "https://letterboxd.com/bob/list/best-action-films/",
    "https://www.themoviedb.org/list/8123",
  ]) {
    it(`leaves a movie as a movie: ${link}`, () => assert.equal(typeFor(link), "movie"));
  }

  for (const link of [
    "https://trakt.tv/users/bob/lists/best-shows",
    "https://mdblist.com/lists/bob/top-series",
    "https://trakt.tv/shows/trending",
    "https://mdblist.com/lists/bob/anything?type=show",
    "https://www.themoviedb.org/tv/popular",
    "https://www.themoviedb.org/tv",
  ]) {
    it(`still picks Shows for: ${link}`, () => assert.equal(typeFor(link), "series"));
  }

  it("a pasted movie link still puts a Shows dropdown back to Movies", () => {
    assert.equal(typeFor("https://trakt.tv/users/bob/lists/best-movies", "series"), "movie");
  });
});
