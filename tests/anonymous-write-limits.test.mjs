// The anonymous routes that write something: how much one caller can write.
//
//   * /api/track-install had no limit at all, and it let the caller name its own
//     "source groups": 100 requests from one address made 3,000 rows and
//     3,000,000 installs, which is the admin dashboard's "sources people use"
//     table. Known categories are counted under their own name now, anything
//     else under "Other", and each caller has a per-minute budget.
//   * /api/save (20 a minute) and /api/feedback (20 a day) had limits that no
//     test mentioned: removing either left the whole suite green.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { awaitFreshRateWindow, call, makeD1, makeEnv, makeKv } from "./harness.mjs";

const ROOT = new URL("../", import.meta.url);
const read = (f) => readFileSync(new URL(f, ROOT), "utf8");

async function groupTotals(DB) {
  const { results } = await DB.prepare("SELECT name, install_count FROM source_groups").all();
  return Object.fromEntries((results || []).map((r) => [r.name, r.install_count]));
}

describe("/api/track-install", () => {
  it("counts a known category under its own name and everything else under Other", async () => {
    const DB = makeD1();
    const env = makeEnv({ DB, CONFIGS: makeKv() });
    const r = await call(env, "/api/track-install", {
      method: "POST",
      json: { groups: { Kids: 2, "Fake A (visit evil.example)": 5, "Fake B": 7 } },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await groupTotals(DB), { Kids: 2, Other: 12 });
  });

  it("one caller cannot make table rows: 30 invented names add one row", async () => {
    const DB = makeD1();
    const env = makeEnv({ DB, CONFIGS: makeKv() });
    const groups = {};
    for (let i = 0; i < 30; i++) groups[`Invented ${i}`] = 1;
    await call(env, "/api/track-install", { method: "POST", json: { groups } });
    assert.deepEqual(Object.keys(await groupTotals(DB)), ["Other"]);
  });

  it("a count cannot exceed what one install can hold (500 rows)", async () => {
    const DB = makeD1();
    const env = makeEnv({ DB, CONFIGS: makeKv() });
    await call(env, "/api/track-install", { method: "POST", json: { groups: { Kids: 100000 } } });
    assert.equal((await groupTotals(DB)).Kids, 500);
  });

  it("every category the builder puts on a row is counted under its own name", async () => {
    // Read from the sources, so a new category added to the builder without
    // being added to the known list fails here instead of becoming "Other".
    const labels = new Set(["Custom"]);
    const q08 = read("08_quickadd-chart-data.js");
    const q16 = read("16_client-row-core.js");
    const q20 = read("20_client-channel-builder.js");
    const q19 = read("19_client-search-and-likes.js");
    for (const m of q08.matchAll(/buildStreamingRowsHtml\([^;]*?,\s*"[^"]*",\s*"([^"]+)"\)/g)) labels.add(m[1]);
    for (const m of q16.matchAll(/buildAddAllPairsCallsJs\([A-Z_0-9]+,\s*"([^"]+)"/g)) labels.add(m[1]);
    for (const m of q08.matchAll(/"([A-Za-z ]+)"\]\)\}">\+ (?:Movies|Shows)/g)) labels.add(m[1]);
    for (const m of q20.matchAll(/addRow\([^;]*?,\s*true,\s*'([^']+)'/g)) labels.add(m[1]);
    for (const m of q19.matchAll(/addRow\([^;]*?,\s*true,\s*'([^']+)'/g)) labels.add(m[1]);
    assert.ok(labels.size >= 14, "the scan found only " + [...labels].join(", "));
    const DB = makeD1();
    const env = makeEnv({ DB, CONFIGS: makeKv() });
    const groups = Object.fromEntries([...labels].map((l) => [l, 1]));
    await call(env, "/api/track-install", { method: "POST", json: { groups } });
    const totals = await groupTotals(DB);
    assert.equal(totals.Other, undefined, "these were counted as Other: add them to the known list: " + JSON.stringify(totals));
    assert.deepEqual(Object.keys(totals).sort(), [...labels].sort());
  });

  it("has a per-address budget: the 40th request in a minute counts nothing", async () => {
    await awaitFreshRateWindow();
    const DB = makeD1();
    const env = makeEnv({ DB, CONFIGS: makeKv() });
    const ip = "203.0.113.77";
    for (let i = 0; i < 40; i++) {
      const r = await call(env, "/api/track-install", { method: "POST", ip, json: { groups: { Kids: 1 } } });
      assert.equal(r.status, 200, "a beacon never answers an error");
    }
    const total = (await groupTotals(DB)).Kids;
    assert.ok(total >= 1 && total <= 30, "counted " + total + " of 40 from one address");
  });
});

describe("/api/save and /api/feedback keep their limits", () => {
  it("/api/save refuses the 21st save from one address in a minute", async () => {
    await awaitFreshRateWindow();
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const ip = "203.0.113.78";
    const entries = [{ id: "a", url: "https://mdblist.com/lists/u/l", name: "A", type: "movie" }];
    const statuses = [];
    for (let i = 0; i < 25; i++) statuses.push((await call(env, "/api/save", { method: "POST", ip, json: { entries } })).status);
    assert.ok(statuses.slice(0, 20).every((s) => s === 200), "the first 20 are saved: " + statuses.join(","));
    assert.ok(statuses.slice(20).every((s) => s === 429), "the rest are refused: " + statuses.join(","));
  });

  it("/api/feedback takes 20 messages a day from one address, then asks to try tomorrow", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const ip = "203.0.113.79";
    const results = [];
    for (let i = 0; i < 22; i++) results.push((await call(env, "/api/feedback", { method: "POST", ip, json: { message: "m" + i } })).body);
    assert.ok(results.slice(0, 20).every((b) => b.ok === true), "the first 20 go through");
    assert.equal(results[20].ok, false);
    assert.match(results[20].error, /tomorrow/);
  });
});
