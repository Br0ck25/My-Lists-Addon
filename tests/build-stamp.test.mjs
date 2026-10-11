// The build stamp: /admin shows which pasted file is live, so the owner can
// tell whether the Worker in Cloudflare is the code that passed the checks.
// build.py fills in WORKER_BUILD (00_constants.js) from a hash of the sources.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

describe("build stamp", () => {
  it("the source keeps exactly one placeholder for build.py to fill in", () => {
    assert.equal(read("00_constants.js").split('"__BUILD_STAMP__"').length - 1, 1);
  });

  it("the combined Worker carries a 10-character stamp and no placeholder", () => {
    const worker = read("worker_entry_combined.js");
    assert.ok(!worker.includes("__BUILD_STAMP__"), "run python build.py");
    assert.match(worker, /^const WORKER_BUILD = "[0-9a-f]{10}";$/m);
  });

  it("/admin prints it beside the release", () => {
    assert.ok(read("03_admin.js").includes('<span id="workerBuild">(build ${WORKER_BUILD})</span>'));
  });

  it("/admin shows the day it was built in place of a hand-kept release number", () => {
    assert.ok(read("03_admin.js").includes('<span id="workerRelease">Built ${WORKER_BUILD_DATE}</span>'));
    assert.equal(read("00_constants.js").split('"__BUILD_DATE__"').length - 1, 1);
    assert.match(read("worker_entry_combined.js"), /^const WORKER_BUILD_DATE = "\d{4}-\d{2}-\d{2}";$/m);
  });

  // The date is the day the code last changed: building the same sources again
  // on a later day (verify.sh, CI) must give the same bytes, or the drift
  // checks would fail every morning.
  it("keeps the date of an earlier build of the same code, and takes today's for new code", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "build-date-"));
    const old = path.join(dir, "worker.js");
    writeFileSync(old, 'const WORKER_BUILD = "abcdef0123";\nconst WORKER_BUILD_DATE = "2020-01-02";\n');
    const py = process.platform === "win32" ? "python" : "python3";
    const ask = (stamp) => spawnSync(py, ["-c", "import sys; from build import build_date; print(build_date(sys.argv[1], sys.argv[2]))", stamp, old],
      { cwd: new URL("..", import.meta.url), encoding: "utf8" }).stdout.trim();
    assert.equal(ask("abcdef0123"), "2020-01-02");
    assert.equal(ask("9999999999"), new Date().toISOString().slice(0, 10));
  });
});
