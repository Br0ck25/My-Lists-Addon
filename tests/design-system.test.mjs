// Guards for docs/DESIGN_SYSTEM.md: the standards that can be checked by machine.
// If one of these fails, fix the CSS (use a token) rather than the test; if a
// new token or colour is genuinely needed, add it to DESIGN_TOKENS_CSS
// (src/core/00_constants.js) and to docs/DESIGN_SYSTEM.md first.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeEnv, call } from "./harness.mjs";
import { listSources } from "./sources.mjs";

// The generated u-* helpers (UTILITY_CSS) are faithful copies of what used to be
// inline style="" values, literals included, so the checks below look at the
// component CSS only. docs/DESIGN_SYSTEM.md section 9 lists the literals they carry.
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
    // the documented exceptions (docs/DESIGN_SYSTEM.md section 9).
    assert.deepEqual(hex, [], "hard-coded hex colours in component CSS; use a token (DESIGN_TOKENS_CSS)");
  });

  it("modals sit above the mobile bottom nav", async () => {
    const css = await appCss();
    const z = (name) => Number(css.match(new RegExp(`--${name}:\\s*(\\d+)`))[1]);
    assert.ok(z("z-modal") > z("z-nav"));
    assert.ok(z("z-toast") > z("z-modal"));
  });

  it("no static pop-up form carries its own z-index, so dialogs opened from it (errors, confirms) stack above it", async () => {
    // UI-01: forms with an inline z-index:10001 sat above the --z-modal layer that
    // showModal()/showAppNoticeModal() use, hiding the "Could Not Save" message.
    const res = await call(makeEnv(), "/");
    assert.equal(res.status, 200);
    const bad = [...res.text.matchAll(/<div id="(\w+)" class="modal-overlay[^>]*style="[^"]*z-index\s*:\s*\d+/g)].map((m) => m[1]);
    assert.deepEqual(bad, [], "modal-overlay forms with a numeric inline z-index; use the --z-modal layer");
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

describe("design system: danger and warn buttons are readable in both themes (UI-10)", () => {
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const toHex = (rgb) => "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  // Light is the first definition of a token, dark the last (see the brand-fill test above).
  const defs = (css, name) => [...css.matchAll(new RegExp(`${name}:\\s*([^;]+);`, "g"))].map((m) => m[1].trim());
  const both = (css, name) => { const d = defs(css, name); assert.ok(d.length >= 1, name + " is defined"); return { light: d[0], dark: d[d.length - 1] }; };
  // A token that is #rrggbb, or rgba() laid over a page colour.
  const resolve = (value, under) => {
    if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
    const m = value.match(/^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/);
    assert.ok(m, "not a plain colour: " + value + " (a *-fill token is needed)");
    const a = Number(m[4]);
    const base = hexToRgb(under);
    return toHex([0, 1, 2].map((i) => Number(m[i + 1]) * a + base[i] * (1 - a)));
  };
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  it("every solid fill that carries --color-on-brand text reaches 4.5:1, light and dark", async () => {
    const css = await appCss();
    const onBrand = both(css, "--color-on-brand");
    const seen = new Set();
    const bad = [];
    for (const f of listSources(root).filter((n) => /(?:^|\/)\d\d_.*\.js$/.test(n) && !n.includes("/00_"))) {
      const src = fs.readFileSync(path.join(root, f), "utf8");
      for (const m of src.matchAll(/class="([^"]*)"/g)) {
        const cls = m[1].split(/\s+/);
        if (!cls.includes("u-c-v_color_on_brand")) continue;
        for (const c of cls.filter((x) => x.startsWith("u-bg-v_"))) {
          const token = "--" + c.slice("u-bg-v_".length).replace(/_/g, "-");
          if (seen.has(token)) continue;
          seen.add(token);
          const d = both(css, token);
          for (const theme of ["light", "dark"]) {
            let ratio = 0;
            try { ratio = contrast(resolve(d[theme], "#ffffff"), onBrand[theme]); } catch { ratio = 0; }
            if (ratio < 4.5) bad.push(`${token} ${theme}: ${ratio.toFixed(2)} (${f})`);
          }
        }
      }
    }
    assert.deepEqual(bad, []);
    assert.ok(seen.has("--color-danger-fill") && seen.has("--color-warn-fill"), "the destructive buttons use the fill tokens: " + [...seen].join(", "));
  });

  // Every state of the destructive button and of the soft add/remove pills: text
  // against its own (possibly translucent) background laid over each page colour
  // it can sit on, in both themes.
  it(".btn-danger and the add/remove pills reach 4.5:1 in every state, light and dark", async () => {
    const css = await appCss();
    const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim(), body: m[2] }));
    // The rule whose selector list STARTS with the given selector (not a :where() that merely mentions it).
    const rule = (start, exact) => {
      const b = blocks.find((x) => (exact ? x.sel === start : x.sel.startsWith(start)));
      assert.ok(b, "found the rule " + start);
      return b.body;
    };
    const tok = (body, prop) => {
      const m = body.match(new RegExp(`(?:^|[;\\s])${prop}:\\s*var\\((--[\\w-]+)\\)`));
      assert.ok(m, `${prop} is a token in: ${body.trim().slice(0, 80)}`);
      return m[1];
    };
    const states = {
      "btn-danger rest": rule(".btn-danger,"),
      "btn-danger hover": rule(".btn-danger:hover"),
      "btn-danger pressed": rule(".btn-danger:hover") + rule(".btn-danger:active"),
      "+ Add rest": rule(".list-add-btn:not(.is-added):not(:disabled)"),
      "+ Add hover": rule(".list-add-btn:not(.is-added):hover"),
      "Remove rest": rule(".list-add-btn.is-added", true),
      "Remove hover": rule(".list-add-btn.is-added:hover"),
    };
    const pages = ["--color-bg-canvas", "--color-bg-surface"];
    const bad = [];
    for (const theme of ["light", "dark"]) {
      for (const [label, body] of Object.entries(states)) {
        // A rule that sets no background of its own keeps the one from its rest state.
        const bgName = /background:\s*var\(/.test(body) ? tok(body, "background") : null;
        for (const pageName of pages) {
          const page = resolve(both(css, pageName)[theme], "#ffffff");
          const bg = bgName ? resolve(both(css, bgName)[theme], page) : page;
          const fgName = /(?:^|[;\s])color:\s*var\(/.test(body) ? tok(body, "color") : null;
          if (!fgName) continue;
          const r = contrast(resolve(both(css, fgName)[theme], bg), bg);
          if (r < 4.5) bad.push(`${label} ${theme} on ${pageName}: ${r.toFixed(2)}`);
        }
      }
    }
    assert.deepEqual(bad, []);
  });
});

describe("design system: add/remove list buttons share one class", () => {
  // The add/remove button look lives in `.list-add-btn` rules (src/page/09_page-shell.js).
  // A button built with one of the legacy names but without the shared class
  // would silently lose its styling, so every place that builds one must carry it.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const legacy = /\b(localListAddToConfigBtn|creatorListAddToConfigBtn|myListAddBtn|searchAddBtn|curatedAddBtn|channelAddBtn|customListAddBtn|detailAddBtn)\b/;
  it("every button that is built with a legacy add-button name also has list-add-btn", () => {
    const missing = [];
    for (const f of listSources(root).filter((n) => /(?:^|\/)\d\d_.*\.js$/.test(n))) {
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
    for (const f of listSources(root).filter((n) => /(?:^|\/)\d\d_.*\.js$/.test(n) && !n.includes("/00_"))) {
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
      assert.match(text, /AI_UI_RULES\.md/, `${f} must reference docs/AI_UI_RULES.md`);
      assert.match(text, /DESIGN_SYSTEM\.md/, `${f} must reference docs/DESIGN_SYSTEM.md`);
    }
  });
  it("docs/AI_UI_RULES.md stays short enough to paste into a prompt", () => {
    assert.ok(read("docs/AI_UI_RULES.md").trimEnd().split("\n").length <= 40);
  });
  it("docs/DESIGN_SYSTEM.md keeps its recipes for buttons and wording", () => {
    const text = read("docs/DESIGN_SYSTEM.md");
    assert.match(text, /### 10\.1 Add a button/);
    assert.match(text, /### 10\.6 Add or change text, labels and counts/);
  });
});


describe("design system: phone tap areas (UI-17)", () => {
  // Icon-only buttons and inline links are narrower or shorter than a fingertip.
  // The invisible ::after extension (docs/DESIGN_SYSTEM.md section 9) must reach them
  // sideways as well, and links that are not .lc-btn need it too.
  const phoneBlock = (css) => {
    const start = css.indexOf("Touch targets: on phones");
    assert.ok(start > -1, "found the phone touch-target block");
    return css.slice(start, start + 2500);
  };
  const extension = (block, selector) => {
    const re = new RegExp(`${selector.replace(/[.]/g, "\\.")}::after[^{}]*\\{[^}]*inset:\\s*([^;}]+)`);
    const m = block.match(re);
    return m ? m[1].trim() : null;
  };
  it("icon-only buttons are extended sideways as well as up and down", async () => {
    const block = phoneBlock(await appCss());
    for (const sel of [".lc-btn.searchLikeBtn", ".lc-btn.searchLikeExternalBtn", ".lc-btn.customizeListBtn"]) {
      const inset = extension(block, sel);
      assert.ok(inset, sel + " has its own extension");
      const parts = []; let depth = 0, cur = "";
      for (const ch of inset) {
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        if (ch === " " && depth === 0) { if (cur) parts.push(cur); cur = ""; } else cur += ch;
      }
      if (cur) parts.push(cur);
      assert.ok(parts.length === 2 && !/^0(px)?$/.test(parts[1]), `${sel} inset "${inset}" must extend sideways`);
    }
  });
  it("'See All' links get an extension too", async () => {
    const block = phoneBlock(await appCss());
    for (const sel of [".text-action-btn", ".discover-chart-seeall"]) {
      assert.ok(extension(block, sel), sel + " has an extension");
      assert.match(block, new RegExp(`${sel.replace(".", "\\.")}[^{}]*\\{[^}]*position:\\s*relative|:where\\([^)]*${sel.replace(".", "\\.")}`), sel + " is positioned so the extension sits on it");
    }
  });
});

describe("design system: the guide page does not scroll sideways (UI-13)", () => {
  it("inline code can wrap, so a long example address cannot push the page wider than a phone", async () => {
    const res = await call(makeEnv(), "/guide");
    assert.equal(res.status, 200);
    const rule = res.text.match(/\n\s*code\s*\{([^}]*)\}/);
    assert.ok(rule, "found the guide's inline code rule");
    assert.match(rule[1], /overflow-wrap:\s*anywhere/);
  });
});

describe("design system: the page scripts follow the same rules as the stylesheet (UI-14)", () => {
  // The component CSS is checked above; colours and wording written from JavaScript
  // strings were not. Whole-line // comments are skipped.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const scan = (dirs, test) => {
    const found = [];
    for (const f of listSources(root).filter((n) => dirs.some((d) => n.startsWith(d)) && /\d\d_.*\.js$/.test(n))) {
      fs.readFileSync(path.join(root, f), "utf8").split("\n").forEach((line, i) => {
        if (/^\s*\/\//.test(line)) return;
        if (test(line)) found.push(`${f}:${i + 1}`);
      });
    }
    return found;
  };

  it("no hard-coded hex colour in the client scripts (the avatar palette and the browser theme-color meta are the documented exceptions)", () => {
    const hex = /['"( =:]#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b(?![\w-])/;
    assert.deepEqual(scan(["src/client/"], (l) => hex.test(l) && !/var palette = \[|theme-color/.test(l)), []);
  });

  it("no colour fallback inside var(--x, #hex), which can differ from the real token", () => {
    assert.deepEqual(scan(["src/client/"], (l) => /var\(--[\w-]+,\s*#/.test(l)), []);
  });

  it("no javascript: links (the page's CSP refuses them)", () => {
    assert.deepEqual(scan(["src/client/", "src/page/", "src/catalog/"], (l) => /href=\\?["']javascript:/.test(l)), []);
  });

  it("visible texts use the ellipsis character, not three dots", () => {
    const dots = /(?<=[A-Za-z0-9 ,])\.\.\.(?=['"`<]|\\n|&)/;
    // Data, not interface: a show called "And Just Like That..." and channel descriptions.
    assert.deepEqual(scan(["src/client/"], (l) => dots.test(l) && !/showName|"description"/.test(l)), []);
  });
});
