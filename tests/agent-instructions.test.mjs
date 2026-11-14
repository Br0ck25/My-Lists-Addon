// CQ-06: AGENTS.md told agents to bump a WORKER_RELEASE constant that no longer
// exists (build.py fills WORKER_BUILD / WORKER_BUILD_DATE; there is no release
// number), and it did not carry CLAUDE.md's rules. Every WORKER_* name the
// instruction files mention must exist in the sources, and AGENTS.md must send
// agents to CLAUDE.md for the hard rules.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const constants = read("src/core/00_constants.js");

for (const file of ["AGENTS.md", "CLAUDE.md"]) {
  test(`${file} names only WORKER_* constants that exist`, () => {
    const names = [...new Set(read(file).match(/\bWORKER_[A-Z_]+\b/g) || [])];
    const missing = names.filter((n) => !new RegExp(`\\bconst ${n}\\b`).test(constants));
    assert.deepEqual(missing, []);
  });
}

test("AGENTS.md sends every agent to CLAUDE.md's hard rules", () => {
  assert.match(read("AGENTS.md"), /CLAUDE\.md/);
});
