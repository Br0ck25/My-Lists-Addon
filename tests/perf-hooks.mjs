// Test helper for the PERF-* tests: loads the built Worker once more, as its own
// isolate, with a small block of test code appended to the module. The appended
// code shares the Worker's scope, so it can wrap an internal function (function
// declarations are assignable bindings) to count calls, and export the counters.
// The Worker source is not changed.
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

let seq = 0;
export async function loadWorkerWithHooks(appended) {
  const src = readFileSync(new URL("../worker_entry_combined.js", import.meta.url), "utf8");
  const file = `${tmpdir()}/mla-perf-${process.pid}-${Date.now()}-${++seq}.mjs`;
  writeFileSync(file, src + "\n" + appended + "\n");
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    unlinkSync(file);
  }
}
