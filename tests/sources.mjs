// The numbered source files live in src/<group>/NN_name.js and build.py joins
// them in the order of their NN_ prefix, not their folder. Tests that scan
// "every source file" call this instead of reading the repo root, so a file
// moving between groups never changes what a test scans.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function listSources(root, { header = false } = {}) {
  const base = root instanceof URL ? fileURLToPath(root) : String(root);
  const src = path.join(base, "src");
  const out = [];
  for (const dir of fs.readdirSync(src, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(src, dir.name))) {
      if (/^\d\d_.*\.js$/.test(f)) out.push(`src/${dir.name}/${f}`);
    }
  }
  out.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  if (header) out.unshift("src/header.js");
  return out;
}
