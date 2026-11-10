// Audit OPS-04: the deploy checklist told the owner to take a `wrangler d1 export`
// of my-lists-db (D1 cannot export a database with virtual tables) and, in the
// emergency steps, to load that file over the live database. Neither is wanted.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const text = readFileSync(new URL("../docs/DEPLOY_CHECKLIST.md", import.meta.url), "utf8");

describe("docs/DEPLOY_CHECKLIST.md backup and restore steps", () => {
  it("never uses d1 export on the main database", () => {
    assert.doesNotMatch(text, /d1 export my-lists-db/);
  });

  it("never loads a SQL file onto the live database", () => {
    assert.doesNotMatch(text, /d1 execute my-lists-db\s+--file=backups\//);
    assert.doesNotMatch(text, /pre-deploy-XXXX\.sql/);
  });

  it("has balanced code fences (a lost fence hides or shows the wrong lines)", () => {
    const fences = text.split("\n").filter((l) => /^\s*```/.test(l)).length;
    assert.equal(fences % 2, 0, `${fences} fence lines`);
    assert.doesNotMatch(text, /\.bash\s*$/m, "a fence opener glued to a sentence");
  });
});
