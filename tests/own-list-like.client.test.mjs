// Liking one of this add-on's own lists from a heart built for external lists
// (19_client-search-and-likes.js). The Discover cards and the list details
// page give every list the external heart, which posts to
// /api/lists/like-external -- and that refuses anything but MDBList, Trakt,
// TMDB, Simkl and Letterboxd links: "Could Not Update Like -- That URL can't
// be liked". An own list is now recognised by its URL and liked by its
// username/slug through /api/lists/like, as Search's own heart does.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadClient } from "./client-harness.mjs";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

describe("own lists behind an external heart", () => {
  it("recognises this add-on's own list pages and nothing else", () => {
    const c = loadClient();
    const slugOf = (u) => c.call("ownListUsernameSlug", u);
    assert.equal(slugOf("https://example.com/lists/alice/top-films"), "alice/top-films");
    assert.equal(slugOf("https://mylistsaddon.com/lists/bob/horror%20picks"), "bob/horror picks");
    assert.equal(slugOf("/lists/alice/top-films"), "alice/top-films");
    assert.equal(slugOf("https://mdblist.com/lists/alice/top-films"), "");
    assert.equal(slugOf("https://trakt.tv/users/alice/lists/top-films"), "");
    assert.equal(slugOf("https://example.com/lists/alice"), "");
    assert.equal(slugOf("https://example.com/lists/alice/top-films/extra"), "");
    assert.equal(slugOf("tmdb:chart:popular"), "");
    assert.equal(slugOf("javascript:alert(1)"), "");
    assert.equal(slugOf(""), "");
  });

  it("shows an own list as liked however the like was stored", () => {
    const c = loadClient({ storage: { "myListAddon:likedLists": JSON.stringify(["alice/top-films", "https://mdblist.com/lists/x/y"]) } });
    assert.equal(c.call("isListUrlLiked", "https://example.com/lists/alice/top-films"), true);
    assert.equal(c.call("isListUrlLiked", "https://mdblist.com/lists/x/y"), true);
    assert.equal(c.call("isListUrlLiked", "https://example.com/lists/alice/other"), false);
  });

  it("the click handler sends an own list's external heart down the own-list path", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, "19_client-search-and-likes.js"), "utf8");
    const at = src.indexOf("let likeBtn = e.target.closest('.searchLikeBtn');");
    assert.ok(at >= 0, "the own-list like branch moved");
    const branch = src.slice(at, src.indexOf("/api/lists/like'", at));
    assert.match(branch, /closest\('\.searchLikeExternalBtn'\)/);
    assert.match(branch, /ownListUsernameSlug\(externalBtn\.dataset\.url\)/);
    // And it comes BEFORE the like-external branch, which would refuse it.
    assert.ok(at < src.indexOf("const likeExternalBtn = e.target.closest('.searchLikeExternalBtn');"));
  });
});
