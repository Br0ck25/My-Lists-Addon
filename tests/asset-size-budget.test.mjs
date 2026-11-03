// PERF-11 step 1: a ratchet on the gzip size of what every visitor downloads.
//
// tests/bundle-budget.test.mjs only checks /app.js against an absolute 150 KB.
// This file records today's gzip sizes of the page HTML, /app.js, /app-features.js
// and /app.css in tests/asset-size-budget.json and fails when one grows more than
// 2% over its baseline, so a slow creep is caught long before a wall is hit.
// Same rules as tests/size-budget.json (CLAUDE.md rule 12): the baseline may only
// shrink. `node tests/asset-size-budget.test.mjs --update` lowers numbers, never
// raises them. A feature that really needs more bytes has to pay for it elsewhere.
import { readFileSync, writeFileSync } from "node:fs";
import zlib from "node:zlib";
import test from "node:test";
import assert from "node:assert/strict";
import { makeEnv, call } from "./harness.mjs";

const BASELINE_FILE = new URL("./asset-size-budget.json", import.meta.url);
const TOLERANCE = 1.02;
const gz = (text) => zlib.gzipSync(Buffer.from(text)).length;

export async function measure() {
  const env = makeEnv();
  const page = await call(env, "/");
  assert.equal(page.status, 200);
  const grab = async (re, what) => {
    const m = page.text.match(re);
    assert.ok(m, `the page must reference ${what}`);
    const res = await call(env, m[1]);
    assert.equal(res.status, 200, what);
    return res.text;
  };
  return {
    html: gz(page.text),
    appJs: gz(await grab(/<script src="(\/app\.js\?v=[0-9a-f]+)"/, "/app.js")),
    appFeaturesJs: gz(await grab(/<script src="(\/app-features\.js\?v=[0-9a-f]+)"/, "/app-features.js")),
    appCss: gz(await grab(/href="(\/app\.css\?v=[0-9a-f]+)"/, "/app.css")),
  };
}

export function compare(current, saved) {
  const problems = [];
  for (const [k, base] of Object.entries(saved)) {
    const now = current[k];
    if (now === undefined) problems.push(`${k}: no longer measured; remove it from tests/asset-size-budget.json`);
    else if (now > Math.floor(base * TOLERANCE)) {
      problems.push(`${k}: ${now} B gzip is more than 2% over its baseline of ${base} B. Make it smaller (the baseline may only shrink); if it shrank elsewhere run node tests/asset-size-budget.test.mjs --update`);
    }
  }
  return problems;
}

if (process.argv.includes("--update")) {
  const current = await measure();
  const saved = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
  const next = {};
  let lowered = 0, grew = 0;
  for (const [k, old] of Object.entries(saved)) {
    const n = current[k];
    if (n === undefined) continue;
    if (n > old) { grew++; next[k] = old; continue; } // never raise
    if (n < old) lowered++;
    next[k] = n;
  }
  writeFileSync(BASELINE_FILE, JSON.stringify(next, null, 1) + "\n");
  console.log(`asset-size-budget: ${lowered} lowered, ${grew} above baseline (left as is; the 2% allowance still applies).`);
  process.exit(0);
}

test("asset size budget: no shipped asset grew more than 2% over its gzip baseline", async () => {
  const problems = compare(await measure(), JSON.parse(readFileSync(BASELINE_FILE, "utf8")));
  assert.equal(problems.length, 0, "\n  " + problems.join("\n  "));
});

test("asset size budget: the ratchet really fails when an asset grows", () => {
  const saved = { appJs: 1000 };
  assert.deepEqual(compare({ appJs: 1020 }, saved), []);
  assert.equal(compare({ appJs: 1021 }, saved).length, 1);
  assert.equal(compare({ appJs: 900 }, saved).length, 0);
  assert.equal(compare({}, saved).length, 1);
});
