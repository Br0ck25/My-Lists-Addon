// OPS-09: production is updated by pasting worker_entry_combined.js by hand.
// CI prints the build stamp and file size so the owner can compare them with
// /admin after pasting. The step is read-only: no deploy, no Cloudflare secret.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const code = ci.replace(/^\s*#.*$/gm, ""); // comments may mention deploys and secrets

describe("CI prints the build stamp (OPS-09)", () => {
  it("has a step that prints the stamp and the size of the built Worker", () => {
    const m = ci.match(/- name: Print the build stamp[^\n]*\n([\s\S]*?)(?=\n\s*(?:#[^\n]*\n\s*)*- (?:name|uses):|\n\S|$)/);
    assert.ok(m, "ci.yml needs a step named 'Print the build stamp ...'");
    assert.match(m[1], /python3 build\.py/, "the step must run the build");
    assert.match(m[1], /WORKER_BUILD/, "the step must read the stamp from the built file");
    assert.match(m[1], /wc -c|stat /, "the step must print the file size");
  });

  it("has no deploy command", () => {
    assert.ok(!/wrangler/i.test(code), "CI must not call wrangler");
    assert.ok(!/\bdeploy\b/i.test(code), "CI must not deploy");
    assert.ok(!/cloudflare\/wrangler-action/i.test(ci));
  });

  it("references no secret", () => {
    assert.ok(!/secrets\./.test(code), "CI must not read secrets");
    assert.ok(!/CLOUDFLARE|CF_API/i.test(code), "CI must not mention Cloudflare credentials");
  });
});
