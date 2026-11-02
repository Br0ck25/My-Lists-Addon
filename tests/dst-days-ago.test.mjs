import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// "N days ago" as an Eastern calendar date must be calendar arithmetic, not
// `now - N * 24h`: on the 25-hour "clocks go back" day the subtraction lands
// on today's date during the last hour (a day repeats), and on the 23-hour
// "clocks go forward" day it skips one. The admin day-by-day series and the
// Most Watched windows read these keys, so a repeat or gap shows wrong totals.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src03 = fs.readFileSync(path.join(REPO_ROOT, "src/admin/03_admin.js"), "utf8");

function grab(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} must exist in src/admin/03_admin.js`);
  let i = src.indexOf("{", start), d = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") d++;
    else if (src[i] === "}") { d--; if (!d) { i++; break; } }
  }
  return src.slice(start, i);
}

const daysAgo = new Function(
  `${grab(src03, "easternDateKey")}\n${grab(src03, "easternDateKeyDaysAgo")}\nreturn easternDateKeyDaysAgo;`
)();

const nextDay = (key) => {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

describe("easternDateKeyDaysAgo is DST-safe", () => {
  const cases = [
    ["25-hour day, last hour (23:30 EST on 1 Nov)", "2026-11-02T04:30:00Z", "2026-11-01"],
    ["23-hour day, first hour (00:30 EDT on 8 Mar)", "2026-03-09T04:30:00Z", "2026-03-09"],
  ];
  for (const [label, iso, today] of cases) {
    it(`gives 8 distinct consecutive dates: ${label}`, () => {
      const now = new Date(iso).getTime();
      const keys = [];
      for (let n = 0; n <= 7; n++) keys.push(daysAgo(now, n));
      assert.equal(keys[0], today);
      assert.equal(new Set(keys).size, 8, `dates repeated: ${keys.join(",")}`);
      for (let n = 0; n < 7; n++) assert.equal(nextDay(keys[n + 1]), keys[n], `gap or repeat at ${n}: ${keys.join(",")}`);
    });
  }

  it("no call site goes back to subtracting 24h multiples", () => {
    const api = fs.readFileSync(path.join(REPO_ROOT, "src/api/26_api-creator-and-admin-routes.js"), "utf8");
    for (const [name, src] of [["03_admin.js", src03], ["26_api", api]]) {
      assert.doesNotMatch(src, /easternDateKey\(new Date\([^)]*86400000/, `${name} still builds N-days-ago from 86,400,000 ms`);
    }
  });
});
