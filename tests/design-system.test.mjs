// Guards for DESIGN_SYSTEM.md: the standards that can be checked by machine.
// If one of these fails, fix the CSS (use a token) rather than the test; if a
// new token or colour is genuinely needed, add it to DESIGN_TOKENS_CSS
// (00_constants.js) and to DESIGN_SYSTEM.md first.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, call } from "./harness.mjs";

// The generated u-* helpers (UTILITY_CSS) are faithful copies of what used to be
// inline style="" values, literals included, so the checks below look at the
// component CSS only. DESIGN_SYSTEM.md section 9 lists the literals they carry.
async function appCss() {
  const env = makeEnv();
  const res = await call(env, "/app.css");
  assert.equal(res.status, 200);
  return res.text.split("\n").filter((l) => !/^\.u-[\w-]+\{/.test(l)).join("\n");
}

describe("design system: shared stylesheet", () => {
  it("every var(--x) it uses is defined, or carries a fallback", async () => {
    const css = await appCss();
    const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    const missing = new Set();
    for (const m of css.matchAll(/var\((--[\w-]+)\s*([,)])/g)) {
      if (m[2] === ")" && !defined.has(m[1])) missing.add(m[1]);
    }
    assert.deepEqual([...missing], [], "undefined CSS variables used without a fallback");
  });

  it("dark mode is one selector, :root.dark-theme", async () => {
    const css = await appCss();
    assert.doesNotMatch(css, /(^|[^:\w])html\.dark-theme|body\.dark-theme/);
  });

  it("never uses transition: all", async () => {
    const css = await appCss();
    assert.doesNotMatch(css, /transition:\s*all\b/);
  });

  it("has no malformed transition shorthand", async () => {
    const css = await appCss();
    assert.doesNotMatch(css, /transition:\s*[\w-]+:/);
  });

  it("uses the two real breakpoints only (640/641), plus the 360px nav exception", async () => {
    const css = await appCss();
    const bad = [...css.matchAll(/@media \((?:min|max)-width:\s*(\d+)px\)/g)]
      .map((m) => m[1]).filter((w) => !["640", "641", "360"].includes(w));
    assert.deepEqual(bad, []);
  });

  it("font sizes in rem are tokens, not literals", async () => {
    const css = await appCss();
    // Display sizes (2rem and up, e.g. the Trakt device code) are exempt.
    const lits = [...css.matchAll(/font-size:\s*([\d.]+)rem/g)].filter((m) => Number(m[1]) < 2).map((m) => m[0]);
    // The token definitions live in :root as '--font-size-x: 0.75rem' (no
    // 'font-size:' prefix match), so any hit here is a hard-coded size.
    assert.deepEqual(lits, []);
  });

  it("does not grow new hard-coded hex colours (provider brand colours aside)", async () => {
    const css = await appCss();
    const rules = css.replace(/:root(\.dark-theme)?\s*\{[^}]*\}/g, "");
    const hex = [...rules.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase());
    // Provider brand colours, platform gradients and the support strip are
    // the documented exceptions (DESIGN_SYSTEM.md section 9).
    assert.ok(hex.length <= 30, `${hex.length} hex literals in component CSS; the budget is 30. Use a token.`);
  });

  it("modals sit above the mobile bottom nav", async () => {
    const css = await appCss();
    const z = (name) => Number(css.match(new RegExp(`--${name}:\\s*(\\d+)`))[1]);
    assert.ok(z("z-modal") > z("z-nav"));
    assert.ok(z("z-toast") > z("z-modal"));
  });

  it("white text sits on --color-brand-fill, never straight on --color-brand", async () => {
    const css = await appCss();
    const bad = [...css.matchAll(/\{[^{}]*\}/g)].map((m) => m[0]).filter((b) =>
      /background(-color)?:\s*var\(--(accent|color-brand|brand)\)/.test(b) &&
      /(^|[;\s{])color:\s*(var\(--color-on-brand\)|var\(--color-text-inverse[^)]*\)|#fff)/.test(b));
    assert.deepEqual(bad, []);
  });
});
