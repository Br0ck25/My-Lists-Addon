import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadWorkerWithHooks } from "./perf-hooks.mjs";

// PERF-01: saveTrackingRecord matched incoming watch history to stored rows with
// findIndex + splice over all stored rows per item: O(n^2) (1 s at 10,000 plays).
// The match is now a Map keyed by legacy_id. Same first-match rule, same result.

const load = () => loadWorkerWithHooks(`export const __m = { group: groupStoredHistoryRows, take: takeStoredHistoryRow, rest: remainingStoredHistoryRows };`);

// The rule the old loop implemented, kept here as the oracle.
function oldMatch(storedRows, incoming) {
  const unmatched = [...storedRows];
  for (const { id, t } of incoming) {
    let i = t ? unmatched.findIndex((r) => r.legacy_id === id && r.watched_at === t) : -1;
    if (i < 0) i = unmatched.findIndex((r) => r.legacy_id === id);
    if (i >= 0) unmatched.splice(i, 1);
  }
  // saveTrackingRecord only ever reads the unmatched rows that have a legacy id
  // (a play with none came from somewhere the website never listed).
  return unmatched.filter((r) => r.legacy_id);
}
function newMatch(m, storedRows, incoming) {
  const g = m.group(storedRows);
  for (const { id, t } of incoming) m.take(g, id, t);
  return m.rest(g);
}
const key = (rows) => rows.map((r) => r.id).sort((a, b) => a - b).join(",");

describe("PERF-01: stored watch history is matched in linear time", () => {
  it("removes exactly the rows the old first-match rule removed, duplicates included", async () => {
    const { __m: m } = await load();
    const stored = [
      { id: 1, legacy_id: "a", watched_at: 100 },
      { id: 2, legacy_id: "a", watched_at: 200 },
      { id: 3, legacy_id: "a", watched_at: 300 },
      { id: 4, legacy_id: "b", watched_at: 50 },
      { id: 5, legacy_id: null, watched_at: 60 },
      { id: 6, legacy_id: "c", watched_at: 70 },
    ];
    const cases = [
      [{ id: "a", t: 200 }],                          // exact time wins over first
      [{ id: "a", t: 999 }],                          // no time match: first row for the id
      [{ id: "a", t: 0 }, { id: "a", t: 0 }],         // no time: first, then next
      [{ id: "a", t: 300 }, { id: "a", t: 300 }],     // second one falls back to first remaining
      [{ id: "zzz", t: 5 }],                          // unknown id removes nothing
      [{ id: "b", t: 50 }, { id: "c", t: 0 }, { id: "a", t: 100 }],
      [],
    ];
    for (const inc of cases) assert.equal(key(newMatch(m, stored, inc)), key(oldMatch(stored, inc)), JSON.stringify(inc));
  });

  it("matches the old rule on a large random history", async () => {
    const { __m: m } = await load();
    let seed = 12345;
    const rnd = (n) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    const stored = Array.from({ length: 1500 }, (_, i) => ({ id: i + 1, legacy_id: rnd(10) ? "t" + rnd(400) : null, watched_at: 1000 + rnd(50) }));
    const incoming = Array.from({ length: 1200 }, () => ({ id: "t" + rnd(450), t: rnd(3) ? 1000 + rnd(50) : 0 }));
    assert.equal(key(newMatch(m, stored, incoming)), key(oldMatch(stored, incoming)));
  });

  it("reads the stored rows a linear number of times, not quadratically", async () => {
    const { __m: m } = await load();
    const N = 3000;
    let reads = 0;
    const stored = Array.from({ length: N }, (_, i) => {
      const row = { id: i + 1, watched_at: 1000 + i };
      Object.defineProperty(row, "legacy_id", { enumerable: true, get() { reads++; return "t" + i; } });
      return row;
    });
    // Newest first: the old loop then scanned to the end of the list for every item.
    const incoming = stored.map((r, i) => ({ id: "t" + i, t: 1000 + i })).reverse();
    const rest = newMatch(m, stored, incoming);
    assert.equal(rest.length, 0);
    assert.ok(reads <= 4 * N, `${reads} legacy_id reads for ${N} rows (old loop made ~${N * N / 2 * 2} on this order)`);
  });
});
