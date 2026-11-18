// Audit PERF-03: the home page asked /api/preview for the same chart twice at
// once (the same chart sits in two rows), because the page remembered only a
// finished answer. Each call costs a rate-limit write and counts against 240 a
// minute per address. Calls made while the first is still on the way now share
// it, and a failed answer is not remembered.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadClient, requestsTo } from "./client-harness.mjs";

const answer = { ok: true, items: [], sample: [] };

describe("PERF-03: identical preview requests made together share one call", () => {
  it("two cards asking for the same chart at once send one request and both get the answer", async () => {
    const client = loadClient({ routes: { "/api/preview": () => ({ json: answer }) } });
    const [a, b] = await Promise.all([
      client.call("fetchListPreviewOnce", "tmdb:chart:popular", "movie", 12),
      client.call("fetchListPreviewOnce", "tmdb:chart:popular", "movie", 12),
    ]);
    assert.equal(requestsTo(client, "/api/preview").length, 1, "one request, not two");
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
  });

  it("different charts, and different types of one chart, still get their own request", async () => {
    const client = loadClient({ routes: { "/api/preview": () => ({ json: answer }) } });
    await Promise.all([
      client.call("fetchListPreviewOnce", "tmdb:chart:popular", "movie", 12),
      client.call("fetchListPreviewOnce", "tmdb:chart:popular", "series", 12),
      client.call("fetchListPreviewOnce", "tmdb:chart:trending", "movie", 12),
    ]);
    assert.equal(requestsTo(client, "/api/preview").length, 3);
  });

  it("a failed answer is not kept: the next ask goes to the server again", async () => {
    let n = 0;
    const client = loadClient({ routes: { "/api/preview": () => (++n === 1 ? { status: 500, json: { ok: false } } : { json: answer }) } });
    const first = await client.call("fetchListPreviewOnce", "tmdb:chart:popular", "movie", 12);
    assert.equal(first.ok, false);
    const second = await client.call("fetchListPreviewOnce", "tmdb:chart:popular", "movie", 12);
    assert.equal(second.ok, true);
    assert.equal(requestsTo(client, "/api/preview").length, 2);
  });
});
