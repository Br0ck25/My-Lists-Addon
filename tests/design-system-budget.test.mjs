// Audit UI-08: docs/AI_UI_RULES.md forbids hard-coded rgba colours, odd pixel
// values (5/7/9/11/13px), radii that are not tokens, and says the number of
// !important rules may not grow. design-system.test.mjs checks hex colours but
// none of these, so a change could add all of them and still pass. Today's
// counts are the baseline in design-system-budget.json: they may only go down.
// Fix the CSS (use a token), never raise the baseline.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { makeEnv, call } from "./harness.mjs";

const BASELINE_PATH = fileURLToPath(new URL("./design-system-budget.json", import.meta.url));

// Component CSS only: the generated .u-* helpers copy old inline values on
// purpose (see design-system.test.mjs), and :root holds the token definitions.
export async function componentCss() {
  const res = await call(makeEnv(), "/app.css");
  assert.equal(res.status, 200);
  return res.text.split("\n").filter((l) => !/^\.u-[\w-]+\{/.test(l)).join("\n")
    .replace(/:root(\.dark-theme)?\s*\{[^}]*\}/g, "");
}

export function measure(css) {
  const radii = [...css.matchAll(/border-radius:\s*([^;}]*)/g)].map((m) => m[1].trim())
    .filter((v) => !/^(var\(|0\b|50%|inherit|initial|unset)/.test(v));
  return {
    rgbaLiterals: (css.match(/rgba?\(\s*\d/g) || []).length,
    oddPixelValues: (css.match(/(?<![\w.#-])(5|7|9|11|13)px\b/g) || []).length,
    nonTokenRadii: radii.length,
    importantRules: (css.match(/!important/g) || []).length,
  };
}

describe("design system budget: rule breaks may only shrink (UI-08)", () => {
  it("the counter really counts (it sees a planted rule break)", () => {
    const m = measure(".x{background:rgba(1,2,3,.5);padding:7px 13px;border-radius:9px;color:red!important}");
    assert.deepEqual(m, { rgbaLiterals: 1, oddPixelValues: 3, nonTokenRadii: 1, importantRules: 1 });
  });

  it("no count is above its baseline", async () => {
    const now = measure(await componentCss());
    const base = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
    const grew = Object.keys(now).filter((k) => now[k] > base[k])
      .map((k) => `${k}: ${base[k]} -> ${now[k]}`);
    assert.deepEqual(grew, [], "component CSS got more rule breaks; use tokens instead (see docs/AI_UI_RULES.md)");
  });
});
