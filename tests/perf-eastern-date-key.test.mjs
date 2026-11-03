import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// PERF-12: easternDateKey runs on every counter bump, daily shuffle and Most Watched
// snapshot. Building a new Intl.DateTimeFormat per call was a top self-time function.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src03 = fs.readFileSync(path.join(REPO_ROOT, "src/admin/03_admin.js"), "utf8");

function grab(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} must exist`);
  let i = src.indexOf("{", start), d = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") d++;
    else if (src[i] === "}") { d--; if (!d) { i++; break; } }
  }
  return src.slice(start, i);
}
const load = () => new Function(`${grab(src03, "easternDateKey")}\nreturn easternDateKey;`)();

describe("PERF-12: easternDateKey reuses one formatter", () => {
  it("constructs Intl.DateTimeFormat at most once over many calls", () => {
    const fn = load();
    const Real = Intl.DateTimeFormat;
    let built = 0;
    Intl.DateTimeFormat = function (...a) { built++; return new Real(...a); };
    try {
      for (let i = 0; i < 500; i++) fn(new Date(Date.UTC(2026, 5, 1) + i * 3600e3));
    } finally { Intl.DateTimeFormat = Real; }
    assert.ok(built <= 1, `built ${built} formatters for 500 calls`);
  });

  it("gives the right Eastern date either side of both 2026 DST changes", () => {
    const fn = load();
    const cases = [
      ["2026-03-08T04:59:00Z", "2026-03-07"], // 23:59 EST the night before
      ["2026-03-08T05:00:00Z", "2026-03-08"], // midnight EST, spring forward day starts
      ["2026-03-09T03:59:00Z", "2026-03-08"], // 23:59 EDT
      ["2026-03-09T04:00:00Z", "2026-03-09"],
      ["2026-11-01T03:59:00Z", "2026-10-31"], // 23:59 EDT
      ["2026-11-01T04:00:00Z", "2026-11-01"], // midnight EDT, 25-hour day starts
      ["2026-11-02T04:59:00Z", "2026-11-01"], // 23:59 EST
      ["2026-11-02T05:00:00Z", "2026-11-02"],
    ];
    for (const [iso, want] of cases) assert.equal(fn(new Date(iso)), want, iso);
  });
});
