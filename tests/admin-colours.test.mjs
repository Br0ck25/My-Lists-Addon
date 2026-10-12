// The admin pages carry their own stylesheet (03_admin.js), so the guards that
// read /app.css never saw them (AI_UI_RULES: no `transition: all`; contrast
// >= 4.5:1, never white text straight on --color-danger or the brand colour).
//
//   * .subnav-pill named `transition: all`.
//   * .lc-btn.danger was white on --danger (3.5:1).
//   * .lc-btn, .subnav-pill.active and the sign-in button were white on
//     --accent, which is --color-brand: fine in light, 3.7:1 in dark mode.
//     The main app's primary buttons already use --color-brand-fill with
//     --color-on-brand for this reason.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { call, makeD1, makeEnv, makeKv } from "./harness.mjs";

async function pages() {
  const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
  const login = await call(env, "/admin");
  assert.equal(login.status, 200);
  const signIn = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
  const cookie = (signIn.headers.get("set-cookie") || "").match(/^(mla_admin=[^;]+)/)[1];
  const dash = await call(env, "/admin", { cookie });
  assert.equal(dash.status, 200);
  assert.ok(/subnav-pill/.test(dash.text), "this is the dashboard, not the sign-in page");
  return { login: login.text, dash: dash.text };
}

const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// Defined once for light and again for dark when dark differs.
const tokenValues = (css, name) => [...css.matchAll(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`, "g"))].map((m) => m[1]);
const blocks = (css) => [...css.matchAll(/\{[^{}]*\}/g)].map((m) => m[0]);

describe("admin pages: colours and transitions", () => {
  it("never use transition: all", async () => {
    const { login, dash } = await pages();
    assert.doesNotMatch(login, /transition:\s*all\b/);
    assert.doesNotMatch(dash, /transition:\s*all\b/);
  });

  it("no rule puts white text straight on --accent or --danger", async () => {
    const { login, dash } = await pages();
    const bad = [...blocks(login), ...blocks(dash)].filter((b) =>
      /background(-color)?:\s*var\(--(accent|danger)\)/.test(b) && /(^|[;\s{])color:\s*(#fff\b|#ffffff\b|white\b)/i.test(b));
    assert.deepEqual(bad.map((b) => b.replace(/\s+/g, " ")), []);
  });

  it("the danger button and the primary fills reach 4.5:1 in light and dark", async () => {
    const { dash } = await pages();
    const [onBrand] = tokenValues(dash, "--color-on-brand");
    const [inverseLight, inverseDark] = tokenValues(dash, "--color-text-inverse");
    const [dangerLight, dangerDark] = tokenValues(dash, "--color-danger-text");
    const [fillLight, fillDark] = tokenValues(dash, "--color-brand-fill");
    // The pairs the admin CSS must use, so the ratios checked are the ones shown.
    assert.match(dash, /\.lc-btn\.danger\s*\{[^}]*background:\s*var\(--color-danger-text\)[^}]*color:\s*var\(--color-text-inverse\)/);
    assert.match(dash, /\.lc-btn\s*\{[^}]*background:\s*var\(--color-brand-fill\)[^}]*color:\s*var\(--color-on-brand\)/);
    assert.match(dash, /\.subnav-pill\.active\s*\{[^}]*background:\s*var\(--color-brand-fill\)[^}]*color:\s*var\(--color-on-brand\)/);
    for (const [label, fg, bg] of [
      ["danger, light", inverseLight, dangerLight], ["danger, dark", inverseDark, dangerDark],
      ["primary, light", onBrand, fillLight], ["primary, dark", onBrand, fillDark],
    ]) assert.ok(contrast(fg, bg) >= 4.5, `${label}: ${contrast(fg, bg).toFixed(2)}`);
  });

  it("the sign-in button takes the same primary pair", async () => {
    const { login } = await pages();
    const rule = blocks(login).find((b) => /padding:\s*11px 18px/.test(b));
    assert.ok(rule, "found the sign-in button rule");
    assert.match(rule, /background:\s*var\(--color-brand-fill\)/);
    assert.match(rule, /color:\s*var\(--color-on-brand\)/);
  });
});
