// CQ-04: functions removed because nothing in the product called them. If one
// comes back, something should call it. (Test-only functions are a separate
// owner decision and are not listed here.)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const REMOVED = ["buildNuvioTvDefaultPreset"];
const files = readdirSync(new URL("../src/", import.meta.url), { withFileTypes: true })
  .flatMap((d) => d.isDirectory() ? readdirSync(new URL(`../src/${d.name}/`, import.meta.url)).map((f) => `../src/${d.name}/${f}`) : []);

for (const name of REMOVED) {
  test(`${name} stays removed`, () => {
    const hits = files.filter((f) => new RegExp(`\\b${name}\\b`).test(readFileSync(new URL(f, import.meta.url), "utf8")));
    assert.deepEqual(hits, []);
  });
}
