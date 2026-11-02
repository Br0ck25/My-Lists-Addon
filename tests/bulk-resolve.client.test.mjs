import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadClient } from "./client-harness.mjs";

// The import matches /api/bulk-resolve answers back to its rows by
// title|year|type. Without the type, a movie and a show with the same title and
// year were given the same IMDb id and poster.

describe("client: bulk-resolve answers are matched back by title, year and type", () => {
  it("a show and a movie with the same title and year get different keys", () => {
    const c = loadClient({});
    assert.notEqual(c.call("bulkResolveKey", "Same", "2000", "series"), c.call("bulkResolveKey", "Same", "2000", "movie"));
  });

  it("is case-insensitive and treats a missing type as a movie (older server answers)", () => {
    const c = loadClient({});
    assert.equal(c.call("bulkResolveKey", "SAME", 2000, undefined), c.call("bulkResolveKey", "same", "2000", "movie"));
  });
});
