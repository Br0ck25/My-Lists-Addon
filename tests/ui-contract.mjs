// UI contract: the computed style of the shared components, in a real browser.
//
// The design system test (design-system.test.mjs) reads the stylesheet as text.
// This renders the stylesheet the Worker actually serves (/app.css) and records
// what the browser computes for each shared component -- size, padding, radius,
// font, colours -- in light and dark mode, at phone and desktop width. The
// result is committed in tests/ui-contract.json. A change that makes a button a
// different size or colour changes that file, so it shows up in the diff and
// has to be accepted on purpose:
//
//   node tests/ui-contract.mjs            compare; exit 1 on any difference
//   node tests/ui-contract.mjs --update   accept the current look
//
// Transitions are switched off in the test page: a colour read mid-transition
// differs from run to run.
//
// Only properties the stylesheet itself declares are recorded (no measured
// width or height), so the result does not depend on which fonts the machine
// has. Needs Playwright:  npm install --no-save playwright@1.56.1
// (CI does this in the "ui-contract" job; locally set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
// if a Chromium is already installed.)
//
// Add a component here when you add one to DESIGN_SYSTEM.md section 3.

import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { makeEnv, makeD1, makeKv, call } from "./harness.mjs";

const CONTRACT_FILE = new URL("./ui-contract.json", import.meta.url);

// name -> markup (class names are the ones DESIGN_SYSTEM.md section 3 documents)
const COMPONENTS = {
  "button (bare)": `<button type="button">Label</button>`,
  "btn-primary": `<button type="button" class="btn-primary">Label</button>`,
  "btn-secondary": `<button type="button" class="btn-secondary">Label</button>`,
  "btn-ghost": `<button type="button" class="btn-ghost">Label</button>`,
  "btn-danger": `<button type="button" class="btn-danger">Label</button>`,
  "btn-primary btn-sm": `<button type="button" class="btn-primary btn-sm">Label</button>`,
  "btn-primary btn-lg": `<button type="button" class="btn-primary btn-lg">Label</button>`,
  "btn-primary disabled": `<button type="button" class="btn-primary" disabled>Label</button>`,
  "lc-btn": `<button type="button" class="lc-btn">Label</button>`,
  "lc-btn secondary": `<button type="button" class="lc-btn secondary">Label</button>`,
  "header-icon-btn": `<button type="button" class="header-icon-btn" aria-label="Search">x</button>`,
  "tab-btn": `<button type="button" class="tab-btn">Label</button>`,
  "tab-btn active": `<button type="button" class="tab-btn active">Label</button>`,
  "subnav-pill": `<button type="button" class="subnav-pill">Label</button>`,
  "subnav-pill active": `<button type="button" class="subnav-pill active">Label</button>`,
  "input": `<input type="text" aria-label="x" value="Text">`,
  "select": `<select aria-label="x"><option>One</option></select>`,
  "textarea": `<textarea aria-label="x">Text</textarea>`,
};

const PROPS = [
  "display", "boxSizing", "minHeight", "minWidth",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderTopWidth", "borderTopStyle", "borderTopColor",
  "borderTopLeftRadius", "fontSize", "fontWeight", "lineHeight",
  "color", "backgroundColor", "opacity", "cursor", "boxShadow",
];

const VIEWPORTS = { phone: { width: 390, height: 800 }, desktop: { width: 1280, height: 800 } };
const THEMES = ["light", "dark"];

async function readStylesheet() {
  const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
  const res = await call(env, "/app.css");
  if (res.status !== 200) throw new Error(`/app.css answered ${res.status}`);
  const css = typeof res.text === "string" ? res.text : String(res.body);
  if (!css.includes(".btn-primary")) throw new Error("/app.css does not contain the shared button styles");
  return css;
}

async function measure() {
  const css = await readStylesheet();
  const browser = await chromium.launch();
  const result = {};
  try {
    for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
      const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
      const body = Object.entries(COMPONENTS).map(([n, html]) => `<div data-c="${n}">${html}</div>`).join("");
      await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>${css}</style><style>*,*::before,*::after{transition:none!important;animation:none!important}</style></head><body>${body}</body></html>`);
      for (const theme of THEMES) {
        await page.evaluate((t) => document.documentElement.classList.toggle("dark-theme", t === "dark"), theme);
        const rows = await page.evaluate(([props]) => {
          const out = {};
          for (const wrap of document.querySelectorAll("[data-c]")) {
            const el = wrap.firstElementChild;
            const cs = getComputedStyle(el);
            out[wrap.dataset.c] = Object.fromEntries(props.map((p) => [p, cs[p]]));
          }
          return out;
        }, [PROPS]);
        for (const [name, style] of Object.entries(rows)) {
          result[`${name} | ${vpName} | ${theme}`] = style;
        }
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
  return result;
}

const current = await measure();
const sorted = Object.fromEntries(Object.keys(current).sort().map((k) => [k, current[k]]));

if (process.argv.includes("--update")) {
  writeFileSync(CONTRACT_FILE, JSON.stringify(sorted, null, 1) + "\n");
  console.log(`ui-contract: wrote ${Object.keys(sorted).length} entries to tests/ui-contract.json`);
  process.exit(0);
}

const saved = JSON.parse(readFileSync(CONTRACT_FILE, "utf8"));
const problems = [];
for (const key of new Set([...Object.keys(saved), ...Object.keys(sorted)])) {
  if (!(key in sorted)) { problems.push(`${key}: no longer measured`); continue; }
  if (!(key in saved)) { problems.push(`${key}: new, not in the contract`); continue; }
  for (const p of PROPS) {
    if (saved[key][p] !== sorted[key][p]) problems.push(`${key}: ${p} was ${saved[key][p]}, is now ${sorted[key][p]}`);
  }
}
if (problems.length) {
  console.error(`ui-contract: ${problems.length} difference(s) from tests/ui-contract.json\n  ` + problems.slice(0, 60).join("\n  "));
  console.error("\nIf the new look is intended (and DESIGN_SYSTEM.md says so), run: node tests/ui-contract.mjs --update");
  process.exit(1);
}
console.log(`ui-contract: ${Object.keys(sorted).length} component states match tests/ui-contract.json`);
