// The build stamp: /admin shows which pasted file is live, so the owner can
// tell whether the Worker in Cloudflare is the code that passed the checks.
// build.py fills in WORKER_BUILD (00_constants.js) from a hash of the sources.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
});
