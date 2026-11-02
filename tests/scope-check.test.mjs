// tools/scope_check.mjs must not excuse a free name just because the same name
// exists somewhere else in the bundle as a local, a typeof guard or a string
// (docs/CODE_QUALITY_AUDIT.md, CQ-19). A moved function that used `m` without
// receiving it passed `verify.sh --fast` because `m` was a local elsewhere.
//
// Each case runs the real tool on a tiny synthetic file and checks the exit
// code AND which names it reports, so a case cannot pass for the wrong reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "..", "tools", "scope_check.mjs");

function run(mode, code) {
  const dir = mkdtempSync(join(tmpdir(), "scope-check-"));
  try {
    const file = join(dir, mode === "page" ? "t.html" : "t.js");
    const body = mode === "page"
      ? `<script>${code}</script>\n<script>;</script>`
      : code;
    writeFileSync(file, body);
    const r = spawnSync(process.execPath, [TOOL, mode, file], { encoding: "utf8" });
    return { status: r.status, out: r.stdout + r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const names = (out) => [...out.matchAll(/^ {4}(\S+)\s+\(\d+ reference/gm)].map((m) => m[1]);

for (const mode of ["worker", "page"]) {
  test(`${mode}: a local of a DIFFERENT function does not satisfy a read`, () => {
    const r = run(mode, `function a() { const m = 1; return m; }\nfunction b() { return m + 1; }\na(); b();\n`);
    assert.equal(r.status, 1, r.out);
    assert.deepEqual(names(r.out), ["m"]);
  });

  test(`${mode}: exact miss pattern (let m in A, bare read in B) with a typeof of m inside A`, () => {
    const r = run(mode, `function a() { let m = 1; if (typeof m === "number") return m; }\nfunction b() { return m.length; }\na(); b();\n`);
    assert.equal(r.status, 1, r.out);
    assert.deepEqual(names(r.out), ["m"]);
  });

  test(`${mode}: a typeof elsewhere in ANOTHER function does not excuse an unguarded read`, () => {
    const r = run(mode, `function a() { return typeof m !== "undefined"; }\nfunction b() { return m; }\na(); b();\n`);
    assert.equal(r.status, 1, r.out);
    assert.deepEqual(names(r.out), ["m"]);
  });

  test(`${mode}: window.x text inside a string is not an export`, () => {
    const r = run(mode, `const s = "window.m = 1";\nfunction b() { return m; }\nb(s);\n`);
    assert.equal(r.status, 1, r.out);
    assert.deepEqual(names(r.out), ["m"]);
  });

  test(`${mode}: a read guarded by typeof in the same function still passes`, () => {
    const r = run(mode, `function b() { return typeof opt !== "undefined" ? opt : 0; }\nb();\n`);
    assert.equal(r.status, 0, r.out);
  });

  test(`${mode}: runtime globals and a real window.* export still pass`, () => {
    const r = run(mode, `window.exported = 1;\nfunction b() { return [JSON.stringify(1), fetch, exported]; }\nb();\n`);
    assert.equal(r.status, 0, r.out);
  });
}

test("page: a genuine implicit global (bare top-level assignment) still passes", () => {
  const r = run("page", `traktName = "x";\nfunction b() { return traktName; }\nb();\n`);
  assert.equal(r.status, 0, r.out);
});

test("worker: a bare assignment is itself the bug (ES module)", () => {
  const r = run("worker", `traktName = "x";\nfunction b() { return traktName; }\nb();\n`);
  assert.equal(r.status, 1, r.out);
});
