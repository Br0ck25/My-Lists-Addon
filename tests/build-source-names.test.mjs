// Audit OPS-01: build.py only assembles src/header.js and src/<folder>/NN_name.js
// (two digits). A source file named any other way was silently left out of the
// live Worker while every check stayed green. The build now refuses.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;

function buildIn(dir) {
  return spawnSync("python3", ["build.py"], { cwd: dir, encoding: "utf8" });
}

describe("OPS-01: every .js under src/ is part of the build, or the build fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "mla-build-"));
  cpSync(join(root, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(root, "build.py"), join(dir, "build.py"));

  it("the real source tree builds", () => {
    const r = buildIn(dir);
    assert.equal(r.status, 0, r.stderr);
  });

  for (const [label, rel] of [
    ["a three-digit prefix", "src/core/100_extra.js"],
    ["no number", "src/core/extra.js"],
    ["a nested folder", "src/core/nested/20_extra.js"],
  ]) {
    it(`refuses ${label}, naming the file`, () => {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), "const __opsProbe = 1;\n");
      const r = buildIn(dir);
      rmSync(join(dir, rel));
      assert.notEqual(r.status, 0);
      assert.ok(r.stderr.includes(rel), r.stderr);
    });
  }

  it("cleanup", () => rmSync(dir, { recursive: true, force: true }));
});
