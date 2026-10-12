// Guards for DESIGN_SYSTEM.md: the standards that can be checked by machine.
// If one of these fails, fix the CSS (use a token) rather than the test; if a
// new token or colour is genuinely needed, add it to DESIGN_TOKENS_CSS
// (00_constants.js) and to DESIGN_SYSTEM.md first.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

  it("the guide page never uses transition: all either (it has its own stylesheet)", async () => {
    const res = await call(makeEnv(), "/guide");
    assert.equal(res.status, 200);
    assert.ok(/<style[\s>]/.test(res.text), "the guide page carries its own CSS");
    assert.doesNotMatch(res.text, /transition:\s*all\b/);
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

  it("has no hard-coded hex colours (brand colours live in DESIGN_TOKENS_CSS)", async () => {
    const css = await appCss();
    const rules = css.replace(/:root(\.dark-theme)?\s*\{[^}]*\}/g, "");
    const hex = [...rules.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase());
    // Provider brand colours, platform gradients and the support strip are
    // the documented exceptions (DESIGN_SYSTEM.md section 9).
    assert.deepEqual(hex, [], "hard-coded hex colours in component CSS; use a token (DESIGN_TOKENS_CSS)");
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

describe("design system: text on the brand fill is readable in both themes", () => {
  // Relative luminance and contrast ratio (WCAG 2.x), enough for hex colours.
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  // A token is defined once for light, and again for dark when dark differs.
  const tokenValues = (css, name) => [...css.matchAll(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`, "g"))].map((m) => m[1]);

  it("a button on --color-brand-fill takes --color-on-brand, never --color-text-inverse (black in dark mode)", async () => {
    const css = await appCss();
    const bad = [...css.matchAll(/\{[^{}]*\}/g)].map((m) => m[0]).filter((b) =>
      /background(-color)?:\s*var\(--color-brand-fill/.test(b) && /(^|[;\s{])color:\s*var\(--color-text-inverse/.test(b));
    assert.deepEqual(bad, []);
  });

  it("--color-on-brand reaches 4.5:1 on the fill, its hover and its pressed colour, in light and dark", async () => {
    const css = await appCss();
    const onBrand = tokenValues(css, "--color-on-brand");
    for (const name of ["--color-brand-fill", "--color-brand-fill-hover", "--color-brand-fill-active"]) {
      const [light, dark] = tokenValues(css, name);
      assert.ok(light && dark, name + " is defined for light and dark");
      assert.ok(contrast(onBrand[0], light) >= 4.5, `${name} light: ${contrast(onBrand[0], light).toFixed(2)}`);
      assert.ok(contrast(onBrand[onBrand.length - 1], dark) >= 4.5, `${name} dark: ${contrast(onBrand[onBrand.length - 1], dark).toFixed(2)}`);
    }
  });
});

describe("design system: add/remove list buttons share one class", () => {
  // The add/remove button look lives in `.list-add-btn` rules (09_page-shell.js).
  // A button built with one of the legacy names but without the shared class
  // would silently lose its styling, so every place that builds one must carry it.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const legacy = /\b(localListAddToConfigBtn|creatorListAddToConfigBtn|myListAddBtn|searchAddBtn|curatedAddBtn|channelAddBtn|customListAddBtn|detailAddBtn)\b/;
  it("every button that is built with a legacy add-button name also has list-add-btn", () => {
    const missing = [];
    for (const f of fs.readdirSync(root).filter((n) => /^\d\d_.*\.js$/.test(n))) {
      fs.readFileSync(path.join(root, f), "utf8").split("\n").forEach((line, i) => {
        const builds = /<button[^>]*class="[^"]*\blc-btn\b/.test(line) || /'lc-btn (secondary )?customListAddBtn'/.test(line);
        if (builds && legacy.test(line) && !/list-add-btn/.test(line)) missing.push(`${f}:${i + 1}`);
      });
    }
    assert.deepEqual(missing, []);
  });
});

describe("design system: helpers must not block colours that scripts set at runtime", () => {
  // Status and hint elements are coloured by scripts (el.style.color = ...). A
  // u-* helper is !important, so a colour helper on one would stop that working.
  // Keep the colour in the element's own style="" instead.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  it("no *Status / *Hint / *State element carries a colour helper", () => {
    const bad = [];
    for (const f of fs.readdirSync(root).filter((n) => /^\d\d_.*\.js$/.test(n) && !n.startsWith("00_"))) {
      const src = fs.readFileSync(path.join(root, f), "utf8");
      for (const m of src.matchAll(/<[a-z0-9]+\s[^<>]*\sid="([A-Za-z0-9_]*(?:Status|Hint|State)|copyUrlBtn|detailAddBtn)"[^<>]*>/g)) {
        if (/class="[^"]*\bu-(?:c|bg|bgc|bdc)-/.test(m[0])) bad.push(`${f}: #${m[1]}`);
      }
    }
    assert.deepEqual(bad, []);
  });
});

describe("design system: the rules reach everyone who changes the UI", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
  it("CLAUDE.md, AGENTS.md and README.md point to the UI rules", () => {
    for (const f of ["CLAUDE.md", "AGENTS.md", "README.md"]) {
      const text = read(f);
      assert.match(text, /AI_UI_RULES\.md/, `${f} must reference AI_UI_RULES.md`);
      assert.match(text, /DESIGN_SYSTEM\.md/, `${f} must reference DESIGN_SYSTEM.md`);
    }
  });
  it("AI_UI_RULES.md stays short enough to paste into a prompt", () => {
    assert.ok(read("AI_UI_RULES.md").trimEnd().split("\n").length <= 40);
  });
  it("DESIGN_SYSTEM.md keeps its recipes for buttons and wording", () => {
    const text = read("DESIGN_SYSTEM.md");
    assert.match(text, /### 10\.1 Add a button/);
    assert.match(text, /### 10\.6 Add or change text, labels and counts/);
  });
});

