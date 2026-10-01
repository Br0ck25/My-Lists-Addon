// Every drag-to-reorder marks the item being moved with the same dashed
// outline. Your Custom Lists' cards had it and nothing else did; the owner
// asked for it on every drag and drop (2026-10-01).
//
// Read from the sources rather than listed here: each createSortableList call
// names the items it moves (itemSelector), and each of those must be in the
// outline rule in 09_page-shell.js -- including a list added later.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

function outlinedSelectors() {
  const css = read("09_page-shell.js");
  const at = css.indexOf("outline: 2px dashed var(--accent) !important;");
  assert.ok(at > 0, "the shared drag outline rule is missing");
  const open = css.lastIndexOf("{", at);
  const start = css.lastIndexOf("}", open) + 1;
  return css.slice(start, open).split(",").map((s) => s.replace(/\/\*[\s\S]*?\*\//g, "").trim()).filter(Boolean);
}

function sortableItemClasses() {
  const out = [];
  for (const f of fs.readdirSync(ROOT).filter((n) => /^[0-9]{2}_.*\.js$/.test(n))) {
    const src = read(f);
    for (const m of src.matchAll(/createSortableList\([^,]+,\s*\{[\s\S]*?itemSelector:\s*'([^']+)'/g)) {
      const cls = m[1].match(/^\.([a-z0-9_-]+)/i);
      if (cls) out.push({ file: f, cls: cls[1] });
    }
  }
  return out;
}

describe("the item being dragged", () => {
  it("has the dashed outline on every drag-to-reorder list", () => {
    const outlined = new Set(outlinedSelectors());
    const items = sortableItemClasses();
    assert.ok(items.length >= 5, "expected the catalog rows, Your Custom Lists, My Channels and both builders");
    for (const { file, cls } of items) {
      assert.ok(outlined.has("." + cls + ".dragging"), `.${cls} (dragged in ${file}) has no outline while it moves`);
    }
  });
});
