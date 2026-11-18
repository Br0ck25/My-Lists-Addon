// UI-04: the active sub-nav pill is blue text on a pale blue wash. With
// --accent it measured 4.11:1 (light) and 3.76:1 (dark), under the 4.5:1 rule
// (AI_UI_RULES 9). Coloured text on a brand tint must use the *-text token,
// which is defined for both themes.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, call } from "./harness.mjs";

async function appCss() {
  const res = await call(makeEnv(), "/app.css");
  assert.equal(res.status, 200);
  return res.text;
}

describe("active sub-nav pill contrast (UI-04)", () => {
  it("draws its text with --color-brand-text, not --accent", async () => {
    const css = await appCss();
    const rule = css.match(/(?:^|[\s}])\.subnav-pill\.active\s*\{([^}]*)\}/);
    assert.ok(rule, ".subnav-pill.active rule exists");
    assert.match(rule[1], /background:\s*var\(--color-brand-subtle\)/, "still the brand wash");
    assert.match(rule[1], /(?:^|[;\s])color:\s*var\(--color-brand-text\)\s*;/);
  });

  it("--color-brand-text is defined for light and dark themes", async () => {
    const css = await appCss();
    const defs = [...css.matchAll(/([^{}]*)\{([^{}]*--color-brand-text\s*:\s*(#[0-9A-Fa-f]{6})[^{}]*)\}/g)];
    assert.ok(defs.length >= 2, "defined in at least two blocks");
    assert.ok(defs.some((m) => !/dark-theme/.test(m[1])), "a light (default) definition");
    assert.ok(defs.some((m) => /dark-theme/.test(m[1])), "a :root.dark-theme definition");
    assert.notEqual(defs[0][3].toLowerCase(), defs[defs.length - 1][3].toLowerCase(), "the two themes differ");
  });
});
