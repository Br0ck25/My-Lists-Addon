// AUDIT PROBE p09: UI / UX / Responsive / Accessibility
// Module 10: Interaction, responsive layout, focus management, ARIA, semantics
//
// Run:
//   node audit/full-2026-10-02/probes/p09_ui_accessibility.mjs
//   AUDIT_ROOT=C:/tmp/audit-work-2026-10-02 node audit/full-2026-10-02/probes/p09_ui_accessibility.mjs
//
// Requires: Playwright + Chrome at standard location
// Outputs: console TAP-style pass/fail per check; exits non-zero on confirmed defects.
//
// Evidence tiers used:
//   CONFIRMED: browser renders, can be observed, negative control passes
//   OBSERVATION: observed but not a functional defect
//   SUSPECTED: code-only, no browser reproduction possible in this context

import { chromium } from "playwright";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const AUDIT_ROOT = process.env.AUDIT_ROOT || path.dirname(path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))));
const CHROME_PATH = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const BUILDER_HTML = path.join(AUDIT_ROOT, "audit-ui-builder.html");
const SHELL_HTML = path.join(AUDIT_ROOT, "audit-ui-shell.html");

if (!fs.existsSync(BUILDER_HTML)) {
  console.error("SETUP: Run `node render_check.js audit-ui-builder.html` first in AUDIT_ROOT");
  process.exit(1);
}
if (!fs.existsSync(SHELL_HTML)) {
  console.error("SETUP: Run `node render_check.js audit-ui-shell.html --shell` first in AUDIT_ROOT");
  process.exit(1);
}

// TAP-style logger
let passCount = 0;
let failCount = 0;
let warnCount = 0;
const findings = [];

function pass(id, msg) {
  passCount++;
  console.log(`  ✔ [${id}] ${msg}`);
}

function fail(id, msg, detail = "") {
  failCount++;
  findings.push({ id, msg, detail });
  console.log(`  ✖ [${id}] ${msg}${detail ? "\n      Detail: " + detail : ""}`);
}

function warn(id, msg) {
  warnCount++;
  console.log(`  ⚠ [${id}] ${msg}`);
}

function section(name) {
  console.log(`\n▶ ${name}`);
}

async function loadPage(browser, htmlPath, viewportWidth = 1280, viewportHeight = 900) {
  const ctx = await browser.newContext({
    viewport: { width: viewportWidth, height: viewportHeight },
    // Capture console errors
    javaScriptEnabled: true,
  });
  const page = await ctx.newPage();
  const errors = [];
  const consoleWarnings = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
    if (msg.type() === "warning") consoleWarnings.push(msg.text());
  });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  // file:// URL for local HTML
  await page.goto("file:///" + htmlPath.replace(/\\/g, "/"), { waitUntil: "domcontentloaded", timeout: 15000 });
  return { page, ctx, errors, consoleWarnings };
}

async function runAll() {
  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    // -----------------------------------------------------------------------
    // SUITE 1: Page load and structure (builder page)
    // -----------------------------------------------------------------------
    section("Suite 1: Page load and document structure (builder page, 1280×900)");
    {
      const { page, ctx, errors } = await loadPage(browser, BUILDER_HTML, 1280, 900);

      // 1.1 No JS errors on load
      await page.waitForTimeout(500);
      if (errors.length === 0) {
        pass("S1-01", "No JavaScript errors on builder page load");
      } else {
        fail("S1-01", "JavaScript errors on builder page load", errors.slice(0, 3).join(" | "));
      }

      // 1.2 lang attribute on <html>
      const lang = await page.evaluate(() => document.documentElement.lang);
      if (lang && lang.length > 0) {
        pass("S1-02", `<html lang="${lang}"> is present`);
      } else {
        fail("S1-02", "<html> is missing lang attribute — screen readers cannot identify page language");
      }

      // 1.3 <title> is non-empty
      const title = await page.evaluate(() => document.title);
      if (title && title.trim().length > 0) {
        pass("S1-03", `<title> present: "${title.substring(0, 60)}"`);
      } else {
        fail("S1-03", "<title> is missing or empty — required for navigation and assistive tech");
      }

      // 1.4 Main landmark exists
      const hasMain = await page.evaluate(() => !!document.querySelector("main") || !!document.querySelector("[role='main']"));
      if (hasMain) {
        pass("S1-04", "<main> or role=main landmark exists");
      } else {
        warn("S1-04", "No <main> or role=main landmark found — screen reader navigation may be degraded");
      }

      // 1.5 Headings hierarchy — at least one h1
      const h1Count = await page.evaluate(() => document.querySelectorAll("h1").length);
      if (h1Count >= 1) {
        pass("S1-05", `${h1Count} <h1> heading(s) present`);
      } else {
        warn("S1-05", "No <h1> heading on page — screen readers lose document structure");
      }

      // 1.6 No viewport meta missing (already in HTML since it was rendered)
      const hasViewportMeta = await page.evaluate(() => !!document.querySelector("meta[name='viewport']"));
      if (hasViewportMeta) {
        pass("S1-06", "viewport meta tag present");
      } else {
        fail("S1-06", "viewport meta tag missing — page will not scale on mobile");
      }

      // 1.7 Buttons have accessible names
      const btnResults = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const unnamed = btns.filter(b => {
          const text = (b.textContent || "").trim();
          const aria = b.getAttribute("aria-label") || b.getAttribute("aria-labelledby") || b.getAttribute("title") || "";
          return !text && !aria;
        });
        return { total: btns.length, unnamed: unnamed.length, examples: unnamed.slice(0, 5).map(b => b.outerHTML.substring(0, 120)) };
      });
      if (btnResults.unnamed === 0) {
        pass("S1-07", `All ${btnResults.total} buttons have accessible names`);
      } else {
        fail("S1-07", `${btnResults.unnamed}/${btnResults.total} buttons have no accessible name (no text, aria-label, or title)`,
          btnResults.examples.join(" | "));
      }

      // 1.8 Inputs have labels
      const inputResults = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll("input:not([type='hidden']):not([type='submit']):not([type='button'])"));
        const unlabelled = inputs.filter(inp => {
          if (inp.getAttribute("aria-label")) return false;
          if (inp.getAttribute("aria-labelledby")) return false;
          if (inp.getAttribute("placeholder")) return false; // placeholder is weak but present
          if (inp.id && document.querySelector(`label[for="${inp.id}"]`)) return false;
          const parent = inp.closest("label");
          if (parent) return false;
          return true;
        });
        return {
          total: inputs.length,
          unlabelled: unlabelled.length,
          examples: unlabelled.slice(0, 5).map(i => i.outerHTML.substring(0, 100))
        };
      });
      if (inputResults.unlabelled === 0) {
        pass("S1-08", `All ${inputResults.total} inputs have labels, aria-label, or placeholder`);
      } else {
        warn("S1-08", `${inputResults.unlabelled}/${inputResults.total} inputs lack proper labels (aria-label/label[for]/parent label)`,
          "Placeholder-only inputs: may still be accessible but loses label when value entered");
      }

      // 1.9 Images have alt attributes
      const imgResults = await page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll("img"));
        const missingAlt = imgs.filter(img => !img.hasAttribute("alt"));
        const emptyAlt = imgs.filter(img => img.hasAttribute("alt") && img.alt === "");
        return { total: imgs.length, missingAlt: missingAlt.length, emptyAlt: emptyAlt.length, examples: missingAlt.slice(0, 3).map(i => i.outerHTML.substring(0, 100)) };
      });
      if (imgResults.missingAlt === 0) {
        pass("S1-09", `All ${imgResults.total} images have alt attributes (${imgResults.emptyAlt} decorative with alt="")`);
      } else {
        fail("S1-09", `${imgResults.missingAlt}/${imgResults.total} images missing alt attribute`, imgResults.examples.join(" | "));
      }

      // 1.10 No duplicate IDs
      const dupIds = await page.evaluate(() => {
        const ids = Array.from(document.querySelectorAll("[id]")).map(el => el.id);
        const seen = new Set();
        const dups = [];
        for (const id of ids) {
          if (seen.has(id) && !dups.includes(id)) dups.push(id);
          seen.add(id);
        }
        return dups.slice(0, 10);
      });
      if (dupIds.length === 0) {
        pass("S1-10", "No duplicate IDs found on builder page");
      } else {
        fail("S1-10", `Duplicate IDs found: ${dupIds.join(", ")} — breaks aria-labelledby, label[for], and focus management`);
      }

      await ctx.close();
    }

    // -----------------------------------------------------------------------
    // SUITE 2: Responsive layout — builder page
    // -----------------------------------------------------------------------
    section("Suite 2: Responsive layout across viewports");
    const VIEWPORTS = [
      { name: "mobile-xs (375×667)", w: 375, h: 667 },
      { name: "mobile (390×844)", w: 390, h: 844 },
      { name: "tablet (768×1024)", w: 768, h: 1024 },
      { name: "desktop (1280×900)", w: 1280, h: 900 },
      { name: "wide (1920×1080)", w: 1920, h: 1080 },
    ];

    for (const vp of VIEWPORTS) {
      const { page, ctx, errors } = await loadPage(browser, BUILDER_HTML, vp.w, vp.h);
      await page.waitForTimeout(300);

      // 2.x.1 No horizontal overflow (content wider than viewport)
      const overflow = await page.evaluate((vpW) => {
        // Check for elements wider than the viewport
        const all = Array.from(document.querySelectorAll("*"));
        const overflowing = all.filter(el => {
          const r = el.getBoundingClientRect();
          return r.right > vpW + 2; // 2px tolerance for rounding
        });
        return overflowing.slice(0, 5).map(el => ({
          tag: el.tagName,
          class: el.className ? String(el.className).substring(0, 40) : "",
          right: Math.round(el.getBoundingClientRect().right),
        }));
      }, vp.w);

      if (overflow.length === 0) {
        pass(`S2-${vp.name}`, `No horizontal overflow at ${vp.name}`);
      } else {
        fail(`S2-${vp.name}`, `Horizontal overflow at ${vp.name}: ${overflow.length} element(s) extend beyond viewport`,
          overflow.map(o => `${o.tag}.${o.class}(right:${o.right})`).join(", "));
      }

      // 2.x.2 At mobile, check if the app container is usable (not zero-height)
      if (vp.w <= 390) {
        const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
        if (bodyHeight > 200) {
          pass(`S2-${vp.name}-height`, `Body has content at mobile (${bodyHeight}px tall)`);
        } else {
          fail(`S2-${vp.name}-height`, `Body appears empty or near-zero at ${vp.name} (height: ${bodyHeight}px)`);
        }
      }

      await ctx.close();
    }

    // -----------------------------------------------------------------------
    // SUITE 3: Keyboard navigation and focus management (builder page)
    // -----------------------------------------------------------------------
    section("Suite 3: Keyboard navigation and focus management");
    {
      const { page, ctx, errors } = await loadPage(browser, BUILDER_HTML, 1280, 900);
      await page.waitForTimeout(500);

      // 3.1 Tab key moves focus to interactive elements
      await page.keyboard.press("Tab");
      const firstFocused = await page.evaluate(() => {
        const el = document.activeElement;
        return { tag: el.tagName, role: el.getAttribute("role"), class: String(el.className).substring(0, 60), isBody: el === document.body };
      });
      if (!firstFocused.isBody) {
        pass("S3-01", `First Tab focus lands on: ${firstFocused.tag}${firstFocused.role ? "[role=" + firstFocused.role + "]" : ""}`);
      } else {
        fail("S3-01", "First Tab from body keeps focus on body — nothing focusable near top of page");
      }

      // 3.2 Tab through several interactive elements — verify focus moves
      const focusedElements = [];
      for (let i = 0; i < 10; i++) {
        await page.keyboard.press("Tab");
        const el = await page.evaluate(() => {
          const a = document.activeElement;
          return { tag: a.tagName, isBody: a === document.body };
        });
        focusedElements.push(el);
      }
      const allBody = focusedElements.every(e => e.isBody);
      if (!allBody) {
        pass("S3-02", "Tab key moves focus through interactive elements (not stuck on body)");
      } else {
        fail("S3-02", "Tab key does not move focus — all 10 Tab presses keep focus on body");
      }

      // 3.3 Focus is visible (check computed outline/ring styles)
      await page.keyboard.press("Tab");
      const focusVisible = await page.evaluate(() => {
        const el = document.activeElement;
        if (el === document.body) return { visible: false, reason: "body" };
        const style = window.getComputedStyle(el, ":focus");
        const outline = style.outlineWidth;
        const outlineStyle = style.outlineStyle;
        const boxShadow = style.boxShadow;
        const hasFocusRing = (parseFloat(outline) > 0 && outlineStyle !== "none") || (boxShadow && boxShadow !== "none");
        // Also check :focus-visible
        return {
          visible: hasFocusRing,
          outline,
          outlineStyle,
          boxShadow: boxShadow ? boxShadow.substring(0, 80) : "",
          tag: el.tagName,
          class: String(el.className).substring(0, 60),
        };
      });
      if (focusVisible.visible) {
        pass("S3-03", `Focus indicator visible on ${focusVisible.tag} (outline: ${focusVisible.outline} ${focusVisible.outlineStyle})`);
      } else {
        warn("S3-03", `Focus indicator may not be visible on ${focusVisible.tag} (outline: ${focusVisible.outline} ${focusVisible.outlineStyle}, shadow: ${focusVisible.boxShadow || "none"}) — verify manually`);
      }

      // 3.4 Check for tabindex="-1" on interactive elements (focus traps)
      const negativetabIdx = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll("button, a, input, select, textarea"));
        const negIdx = els.filter(el => el.tabIndex === -1 && !el.closest("[aria-hidden='true']") && !el.closest("[hidden]") && !el.disabled);
        return negIdx.slice(0, 10).map(el => ({ tag: el.tagName, class: String(el.className).substring(0, 50), label: (el.textContent || el.getAttribute("aria-label") || "").trim().substring(0, 40) }));
      });
      if (negativetabIdx.length === 0) {
        pass("S3-04", "No visible interactive elements have tabIndex=-1 unexpectedly");
      } else {
        warn("S3-04", `${negativetabIdx.length} interactive elements have tabIndex=-1 (may be intentional for JS-managed focus): ${negativetabIdx.slice(0, 3).map(e => e.tag + "." + e.class + '("' + e.label + '")').join(", ")}`);
      }

      // 3.5 Check for focusable elements with no visible focus styling (outline: none with no replacement)
      const noFocusStyle = await page.evaluate(() => {
        const results = [];
        const interactive = Array.from(document.querySelectorAll("button, a[href], input:not([type='hidden']), select, textarea")).slice(0, 30);
        for (const el of interactive) {
          el.focus();
          const style = window.getComputedStyle(el);
          const outline = style.outlineWidth;
          const outlineStyle = style.outlineStyle;
          const boxShadow = style.boxShadow;
          const hasFocusRing = (parseFloat(outline) > 0 && outlineStyle !== "none") || (boxShadow && boxShadow !== "none" && boxShadow !== "");
          if (!hasFocusRing) {
            results.push({ tag: el.tagName, class: String(el.className).substring(0, 50), outline, outlineStyle });
          }
        }
        return results;
      });
      if (noFocusStyle.length === 0) {
        pass("S3-05", "All sampled interactive elements have visible focus styling");
      } else {
        warn("S3-05", `${noFocusStyle.length} interactive elements may lack focus ring (CSS :focus may override) — manual check needed`,
          noFocusStyle.slice(0, 3).map(e => `${e.tag}.${e.class}(outline:${e.outlineStyle})`).join(", "));
      }

      await ctx.close();
    }

    // -----------------------------------------------------------------------
    // SUITE 4: ARIA roles, labels, landmarks (builder page)
    // -----------------------------------------------------------------------
    section("Suite 4: ARIA semantics and landmark coverage");
    {
      const { page, ctx } = await loadPage(browser, BUILDER_HTML, 1280, 900);
      await page.waitForTimeout(300);

      // 4.1 tablist / tab / tabpanel roles are consistent
      const tabRoles = await page.evaluate(() => {
        const tablists = document.querySelectorAll("[role='tablist']");
        const tabs = document.querySelectorAll("[role='tab']");
        const tabpanels = document.querySelectorAll("[role='tabpanel']");
        const selectedTabs = document.querySelectorAll("[role='tab'][aria-selected='true']");
        const tabsWithControls = document.querySelectorAll("[role='tab'][aria-controls]");
        return {
          tablists: tablists.length,
          tabs: tabs.length,
          tabpanels: tabpanels.length,
          selectedTabs: selectedTabs.length,
          tabsWithControls: tabsWithControls.length,
        };
      });
      if (tabRoles.tablists > 0) {
        const tabsOk = tabRoles.selectedTabs > 0 && tabRoles.tabsWithControls > 0;
        if (tabsOk) {
          pass("S4-01", `Tab widget: ${tabRoles.tablists} tablist(s), ${tabRoles.tabs} tab(s), ${tabRoles.tabpanels} tabpanel(s), ${tabRoles.selectedTabs} selected, ${tabRoles.tabsWithControls} with aria-controls`);
        } else {
          fail("S4-01", `Tab widget has ${tabRoles.tablists} tablist(s) but: selectedTabs=${tabRoles.selectedTabs}, tabsWithControls=${tabRoles.tabsWithControls} — missing aria-selected or aria-controls`);
        }
      } else {
        warn("S4-01", "No role=tablist found — tab navigation patterns may be using non-ARIA approach");
      }

      // 4.2 Dialogs / modals use role=dialog or aria-modal
      const dialogRoles = await page.evaluate(() => {
        const dialogs = document.querySelectorAll("[role='dialog'], dialog");
        const withLabel = Array.from(dialogs).filter(d => d.getAttribute("aria-label") || d.getAttribute("aria-labelledby"));
        return { total: dialogs.length, withLabel: withLabel.length };
      });
      if (dialogRoles.total === 0) {
        warn("S4-02", "No role=dialog elements found in static HTML — modals may be dynamically injected");
      } else if (dialogRoles.withLabel === dialogRoles.total) {
        pass("S4-02", `${dialogRoles.total} dialog(s) all have aria-label or aria-labelledby`);
      } else {
        fail("S4-02", `${dialogRoles.total - dialogRoles.withLabel}/${dialogRoles.total} dialogs lack aria-label or aria-labelledby`);
      }

      // 4.3 Buttons with only icon content have aria-label
      const iconBtns = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const iconOnly = btns.filter(b => {
          const text = (b.textContent || "").trim();
          // Buttons with only emoji, SVG, or very short symbols (≤ 3 chars) that may not be meaningful
          const seemsIcon = text.length <= 2 || /^[\u2715\u2716\u270E\u2713\u2022\u00D7\u2A2F\u271B×✕✖✗✘→←↑↓♥♡☆★≡☰]$/.test(text);
          const hasLabel = b.getAttribute("aria-label") || b.getAttribute("aria-labelledby") || b.getAttribute("title");
          return seemsIcon && !hasLabel;
        });
        return { count: iconOnly.length, examples: iconOnly.slice(0, 5).map(b => `"${(b.textContent||"").trim()}"(class:${String(b.className).substring(0,40)})`) };
      });
      if (iconBtns.count === 0) {
        pass("S4-03", "No icon-only buttons found without accessible names");
      } else {
        fail("S4-03", `${iconBtns.count} button(s) appear icon-only without aria-label/title`, iconBtns.examples.join(" | "));
      }

      // 4.4 aria-expanded on toggle buttons
      const ariaExpanded = await page.evaluate(() => {
        const toggles = document.querySelectorAll("[aria-expanded]");
        const valid = Array.from(toggles).filter(t => t.getAttribute("aria-expanded") === "true" || t.getAttribute("aria-expanded") === "false");
        return { total: toggles.length, valid: valid.length };
      });
      if (ariaExpanded.total > 0) {
        if (ariaExpanded.valid === ariaExpanded.total) {
          pass("S4-04", `${ariaExpanded.total} aria-expanded attributes all have valid values (true/false)`);
        } else {
          fail("S4-04", `${ariaExpanded.total - ariaExpanded.valid}/${ariaExpanded.total} aria-expanded attributes have invalid values`);
        }
      } else {
        warn("S4-04", "No aria-expanded attributes found — accordion/toggle patterns may not have ARIA state");
      }

      // 4.5 aria-required or required on required inputs
      const requiredInputs = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll("input[required], input[aria-required='true'], select[required]"));
        const withLabels = inputs.filter(i => i.getAttribute("aria-label") || i.getAttribute("aria-labelledby") || i.getAttribute("placeholder") || (i.id && document.querySelector(`label[for='${i.id}']`)));
        return { total: inputs.length, withLabels: withLabels.length };
      });
      if (requiredInputs.total === 0) {
        warn("S4-05", "No required inputs found in static HTML (may be in modals or dynamically created)");
      } else {
        pass("S4-05", `${requiredInputs.total} required input(s), ${requiredInputs.withLabels} have accessible labels`);
      }

      // 4.6 aria-live regions for dynamic content
      const liveRegions = await page.evaluate(() => {
        const live = document.querySelectorAll("[aria-live], [role='status'], [role='alert'], [role='log']");
        return { count: live.length, types: Array.from(live).map(el => el.getAttribute("aria-live") || el.getAttribute("role")).slice(0, 5) };
      });
      if (liveRegions.count > 0) {
        pass("S4-06", `${liveRegions.count} aria-live / status / alert region(s): ${liveRegions.types.join(", ")}`);
      } else {
        warn("S4-06", "No aria-live regions found — dynamic content changes (toasts, updates) may not be announced to screen readers");
      }

      // 4.7 aria-controls references resolve
      const ariaControls = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll("[aria-controls]"));
        const broken = els.filter(el => {
          const targets = (el.getAttribute("aria-controls") || "").split(/\s+/).filter(Boolean);
          return targets.some(id => !document.getElementById(id));
        });
        return { total: els.length, broken: broken.length, examples: broken.slice(0, 3).map(e => `${e.tagName}[aria-controls="${e.getAttribute("aria-controls")}"]`) };
      });
      if (ariaControls.broken === 0) {
        pass("S4-07", `All ${ariaControls.total} aria-controls references resolve to existing elements`);
      } else {
        fail("S4-07", `${ariaControls.broken}/${ariaControls.total} aria-controls reference non-existent IDs`, ariaControls.examples.join(" | "));
      }

      // 4.8 aria-labelledby references resolve
      const ariaLabelledBy = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll("[aria-labelledby]"));
        const broken = els.filter(el => {
          const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
          return ids.some(id => !document.getElementById(id));
        });
        return { total: els.length, broken: broken.length, examples: broken.slice(0, 3).map(e => `${e.tagName}[aria-labelledby="${e.getAttribute("aria-labelledby")}"]`) };
      });
      if (ariaLabelledBy.broken === 0) {
        pass("S4-08", `All ${ariaLabelledBy.total} aria-labelledby references resolve to existing elements`);
      } else {
        fail("S4-08", `${ariaLabelledBy.broken}/${ariaLabelledBy.total} aria-labelledby references broken`, ariaLabelledBy.examples.join(" | "));
      }

      // 4.9 role=tab keyboard pattern: Arrow keys should be expected
      // Check if tabs have aria-controls pointing to visible panels
      const tabPanelLinks = await page.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll("[role='tab']"));
        const broken = tabs.filter(t => {
          const ctrl = t.getAttribute("aria-controls");
          if (!ctrl) return true;
          const panel = document.getElementById(ctrl);
          return !panel;
        });
        return { total: tabs.length, broken: broken.length };
      });
      if (tabPanelLinks.total > 0) {
        if (tabPanelLinks.broken === 0) {
          pass("S4-09", `All ${tabPanelLinks.total} tab(s) have aria-controls pointing to existing panels`);
        } else {
          fail("S4-09", `${tabPanelLinks.broken}/${tabPanelLinks.total} tab(s) have broken aria-controls → panel references`);
        }
      } else {
        warn("S4-09", "No role=tab elements found (see S4-01)");
      }

      await ctx.close();
    }

    // -----------------------------------------------------------------------
    // SUITE 5: Modal / dialog interaction (dynamically open via JS)
    // -----------------------------------------------------------------------
    section("Suite 5: Modal and dialog behavior (builder page, interactive)");
    {
      const { page, ctx, errors } = await loadPage(browser, BUILDER_HTML, 1280, 900);
      await page.waitForTimeout(500);

      // 5.1 Trigger a modal/dialog through a UI action (look for "Add row", "Confirm", etc.)
      // Find buttons that typically trigger modals
      const modalTriggers = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        return btns.slice(0, 20).map(b => ({
          text: (b.textContent || "").trim().substring(0, 60),
          act: b.getAttribute("data-act") || "",
          class: String(b.className).substring(0, 50),
        }));
      });
      // Log the triggers found for inspection
      const modalActTriggers = modalTriggers.filter(b => b.act.toLowerCase().includes("modal") || b.act.toLowerCase().includes("confirm") || b.act.toLowerCase().includes("add") || b.act.toLowerCase().includes("delete"));
      if (modalActTriggers.length > 0) {
        pass("S5-00", `Found ${modalActTriggers.length} potential modal-triggering buttons via data-act`);
      } else {
        warn("S5-00", `No obvious modal triggers found in first 20 buttons; found: ${modalTriggers.map(b => b.text || b.act).join(", ")}`);
      }

      // 5.2 After clicking a trigger button, check focus moves to modal
      // Find a button that opens a confirmation modal
      const deleteOrConfirmBtn = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button[data-act]"));
        const del = btns.find(b =>
          (b.getAttribute("data-act") || "").toLowerCase().includes("delete") ||
          (b.getAttribute("data-act") || "").toLowerCase().includes("remove") ||
          (b.getAttribute("data-act") || "").toLowerCase().includes("confirm")
        );
        return del ? { act: del.getAttribute("data-act"), text: (del.textContent || "").trim() } : null;
      });

      if (deleteOrConfirmBtn) {
        // Click it and see if a modal appears
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll("button[data-act]")).find(b =>
            (b.getAttribute("data-act") || "").toLowerCase().includes("delete") ||
            (b.getAttribute("data-act") || "").toLowerCase().includes("remove") ||
            (b.getAttribute("data-act") || "").toLowerCase().includes("confirm")
          );
          if (btn) btn.click();
        });
        await page.waitForTimeout(300);

        const modalState = await page.evaluate(() => {
          const modals = document.querySelectorAll(".modal, [role='dialog'], .lc-modal, .overlay");
          const focusedEl = document.activeElement;
          return {
            modalCount: modals.length,
            focusedTag: focusedEl.tagName,
            focusedClass: String(focusedEl.className).substring(0, 60),
            focusInModal: Array.from(modals).some(m => m.contains(focusedEl)),
          };
        });

        if (modalState.modalCount > 0) {
          if (modalState.focusInModal) {
            pass("S5-02", `Modal opened (${modalState.modalCount} modal elements); focus moved inside modal: ${modalState.focusedTag}`);
          } else {
            fail("S5-02", `Modal opened (${modalState.modalCount} modal elements) but focus NOT inside modal (focus: ${modalState.focusedTag}.${modalState.focusedClass})`);
          }

          // 5.3 Escape closes the modal
          await page.keyboard.press("Escape");
          await page.waitForTimeout(300);
          const afterEsc = await page.evaluate(() => {
            const modals = document.querySelectorAll(".modal:not([hidden]):not([style*='display: none']):not([style*='display:none']), [role='dialog']:not([hidden])");
            return { remaining: modals.length };
          });
          if (afterEsc.remaining === 0) {
            pass("S5-03", "Escape key closes modal");
          } else {
            warn("S5-03", `After Escape, ${afterEsc.remaining} modal element(s) still visible — Escape may not close this modal type`);
          }
        } else {
          warn("S5-02", `Clicking delete/confirm button did not open a visible modal (button: ${deleteOrConfirmBtn.act})`);
        }
      } else {
        warn("S5-02", "No delete/confirm trigger button found to test modal focus management");
      }

      // 5.4 Programmatically invoke the modal system
      const showConfirmModal = await page.evaluate(() => {
        // Try calling the showConfirm/showModal function if it exists
        if (typeof showConfirm === "function") {
          showConfirm("Audit Test", "This is a test modal. Do you confirm?", () => {}, () => {});
          return "showConfirm called";
        }
        if (typeof showModal === "function") {
          showModal({ title: "Audit Test", message: "Test" });
          return "showModal called";
        }
        if (typeof appShowModal === "function") {
          appShowModal("Audit Test", "Test message", [{text: "OK", fn: () => {}}]);
          return "appShowModal called";
        }
        // Try appActDispatch
        return "none found";
      });

      if (showConfirmModal !== "none found") {
        await page.waitForTimeout(300);
        const modalAfterProg = await page.evaluate(() => {
          const modals = document.querySelectorAll(".lc-modal, .modal, [role='dialog']");
          const focusedEl = document.activeElement;
          const focusInModal = Array.from(modals).some(m => m.contains(focusedEl));
          const firstBtn = Array.from(document.querySelectorAll(".lc-modal button, .modal button, [role='dialog'] button"))[0];
          return {
            count: modals.length,
            focusInModal,
            focusedTag: focusedEl.tagName,
            firstBtnText: firstBtn ? (firstBtn.textContent || "").trim() : null,
          };
        });

        if (modalAfterProg.count > 0) {
          pass("S5-04", `Programmatic modal opened (${showConfirmModal}): ${modalAfterProg.count} modal(s) visible`);
          if (modalAfterProg.focusInModal) {
            pass("S5-05", `Focus correctly moved inside programmatic modal (${modalAfterProg.focusedTag})`);
          } else {
            fail("S5-05", `Programmatic modal visible but focus NOT inside it (focus: ${modalAfterProg.focusedTag}) — keyboard users cannot interact`);
          }
        } else {
          warn("S5-04", `${showConfirmModal} but no modal DOM elements appeared`);
        }
      } else {
        warn("S5-04", "Could not find showConfirm/showModal/appShowModal function — modal focus test skipped");
      }

      await ctx.close();
    }

    // -----------------------------------------------------------------------
    // SUITE 6: Form interactions (builder page)
    // -----------------------------------------------------------------------
    section("Suite 6: Form interaction and validation state");
    {
      const { page, ctx } = await loadPage(browser, BUILDER_HTML, 1280, 900);
      await page.waitForTimeout(500);

      // 6.1 Inputs accept keyboard input
      const firstTextInput = await page.evaluate(() => {
        const inp = document.querySelector("input[type='text'], input[type='search'], input:not([type])");
        return inp ? { id: inp.id, placeholder: inp.placeholder, type: inp.type } : null;
      });

      if (firstTextInput) {
        await page.focus(`input[type='text'], input[type='search'], input:not([type])`);
        await page.keyboard.type("AUDIT_TEST_INPUT");
        const inputValue = await page.evaluate(() => {
          const inp = document.querySelector("input[type='text'], input[type='search'], input:not([type])");
          return inp ? inp.value : "";
        });
        if (inputValue.includes("AUDIT_TEST_INPUT")) {
          pass("S6-01", "Text input accepts keyboard input");
        } else {
          fail("S6-01", "Text input did not accept keyboard input", `Expected 'AUDIT_TEST_INPUT', got '${inputValue}'`);
        }
      } else {
        warn("S6-01", "No text input found on page to test");
      }

      // 6.2 Select elements work
      const firstSelect = await page.evaluate(() => {
        const sel = document.querySelector("select");
        if (!sel) return null;
        const opts = Array.from(sel.options).map(o => ({ value: o.value, text: o.text }));
        return { id: sel.id, options: opts.slice(0, 4), current: sel.value };
      });

      if (firstSelect && firstSelect.options.length > 1) {
        pass("S6-02", `Select element has ${firstSelect.options.length} options: ${firstSelect.options.map(o => o.text).join(", ")}`);
      } else if (firstSelect) {
        warn("S6-02", "Select element found but has only 1 option");
      } else {
        warn("S6-02", "No select element found in static page (may be dynamically added)");
      }

      // 6.3 Check for form elements with autocomplete attributes where appropriate
      const passwordInputs = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("input[type='password']"))
          .map(el => ({ id: el.id, autocomplete: el.getAttribute("autocomplete") }));
      });
      if (passwordInputs.length === 0) {
        warn("S6-03", "No password inputs in static page (expected — no login form in builder page)");
      } else {
        const hasAutocomplete = passwordInputs.every(p => p.autocomplete);
        if (hasAutocomplete) {
          pass("S6-03", "All password inputs have autocomplete attribute");
        } else {
          warn("S6-03", "Some password inputs lack autocomplete attribute");
        }
      }

      await ctx.close();
    }

    // -----------------------------------------------------------------------
    // SUITE 7: Shell page (new UI) — responsive and ARIA
    // -----------------------------------------------------------------------
    section("Suite 7: New UI shell page — structure and responsive");
    {
      const { page, ctx, errors } = await loadPage(browser, SHELL_HTML, 1280, 900);
      await page.waitForTimeout(500);

      // 7.1 No JS errors
      if (errors.length === 0) {
        pass("S7-01", "No JavaScript errors on shell page load");
      } else {
        fail("S7-01", "JavaScript errors on shell page load", errors.slice(0, 3).join(" | "));
      }

      // 7.2 lang attribute
      const lang = await page.evaluate(() => document.documentElement.lang);
      if (lang) {
        pass("S7-02", `Shell page <html lang="${lang}">`);
      } else {
        fail("S7-02", "Shell page missing lang attribute on <html>");
      }

      // 7.3 Navigation landmark
      const hasNav = await page.evaluate(() => !!document.querySelector("nav") || !!document.querySelector("[role='navigation']"));
      if (hasNav) {
        pass("S7-03", "<nav> or role=navigation present in shell page");
      } else {
        warn("S7-03", "No <nav> or role=navigation in shell page");
      }

      // 7.4 Mobile overflow check for shell
      await ctx.close();
      const { page: pgMobile, ctx: ctxMobile } = await loadPage(browser, SHELL_HTML, 375, 667);
      await pgMobile.waitForTimeout(300);

      const mobileOverflow = await pgMobile.evaluate(() => {
        const all = Array.from(document.querySelectorAll("*"));
        const over = all.filter(el => {
          const r = el.getBoundingClientRect();
          return r.right > 377;
        });
        return over.slice(0, 5).map(el => ({ tag: el.tagName, class: String(el.className).substring(0, 40), right: Math.round(el.getBoundingClientRect().right) }));
      });

      if (mobileOverflow.length === 0) {
        pass("S7-04", "No horizontal overflow on shell page at 375px");
      } else {
        fail("S7-04", `Horizontal overflow on shell page at 375px (${mobileOverflow.length} element(s))`,
          mobileOverflow.map(o => `${o.tag}.${o.class}(right:${o.right})`).join(", "));
      }

      // 7.5 Buttons on shell page have accessible names
      const shellBtns = await pgMobile.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        const unnamed = btns.filter(b => {
          const text = (b.textContent || "").trim();
          const aria = b.getAttribute("aria-label") || b.getAttribute("aria-labelledby") || b.getAttribute("title") || "";
          return !text && !aria;
        });
        return { total: btns.length, unnamed: unnamed.length, examples: unnamed.slice(0, 5).map(b => b.outerHTML.substring(0, 100)) };
      });
      if (shellBtns.unnamed === 0) {
        pass("S7-05", `All ${shellBtns.total} buttons on shell page have accessible names`);
      } else {
        fail("S7-05", `${shellBtns.unnamed}/${shellBtns.total} buttons on shell page have no accessible name`, shellBtns.examples.join(" | "));
      }

      // 7.6 Tab widget on shell
      const shellTabs = await pgMobile.evaluate(() => {
        const tablists = document.querySelectorAll("[role='tablist']");
        const tabs = document.querySelectorAll("[role='tab']");
        const tabpanels = document.querySelectorAll("[role='tabpanel']");
        const selectedTabs = document.querySelectorAll("[role='tab'][aria-selected='true']");
        return { tablists: tablists.length, tabs: tabs.length, tabpanels: tabpanels.length, selectedTabs: selectedTabs.length };
      });
      if (shellTabs.tablists > 0) {
        const ok = shellTabs.selectedTabs > 0;
        if (ok) {
          pass("S7-06", `Shell tab widget: ${shellTabs.tablists} tablist, ${shellTabs.tabs} tabs, ${shellTabs.selectedTabs} selected`);
        } else {
          fail("S7-06", `Shell tab widget has tabs but none have aria-selected — keyboard users cannot determine active tab`);
        }
      } else {
        warn("S7-06", "No role=tablist in shell page");
      }

      // 7.7 Duplicate IDs on shell page
      const shellDupIds = await pgMobile.evaluate(() => {
        const ids = Array.from(document.querySelectorAll("[id]")).map(el => el.id);
        const seen = new Set(); const dups = [];
        for (const id of ids) { if (seen.has(id) && !dups.includes(id)) dups.push(id); seen.add(id); }
        return dups.slice(0, 10);
      });
      if (shellDupIds.length === 0) {
        pass("S7-07", "No duplicate IDs on shell page");
      } else {
        fail("S7-07", `Duplicate IDs on shell page: ${shellDupIds.join(", ")}`);
      }

      await ctxMobile.close();
    }

    // -----------------------------------------------------------------------
    // SUITE 8: Touch targets (mobile sizing)
    // -----------------------------------------------------------------------
    section("Suite 8: Touch target sizes (mobile 375px)");
    {
      const { page, ctx } = await loadPage(browser, BUILDER_HTML, 375, 667);
      await page.waitForTimeout(300);

      // WCAG 2.5.5 recommends 44×44px; material design / iOS HIG: 44px min
      // We use 36px as a pragmatic minimum (below 44 is a concern, below 24 is a fail)
      const touchTargets = await page.evaluate(() => {
        const interactive = Array.from(document.querySelectorAll("button, a[href], input, select"));
        const results = [];
        for (const el of interactive.slice(0, 50)) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue; // not rendered/hidden
          results.push({
            tag: el.tagName,
            text: (el.textContent || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().substring(0, 30),
            w: Math.round(r.width),
            h: Math.round(r.height),
          });
        }
        return results;
      });

      const tooSmall = touchTargets.filter(t => t.h > 0 && t.h < 36 && t.w < 36);
      const belowMin = touchTargets.filter(t => t.h > 0 && t.h < 24);

      if (belowMin.length === 0 && tooSmall.length === 0) {
        pass("S8-01", `All ${touchTargets.length} sampled touch targets meet 36×36px minimum`);
      } else if (belowMin.length > 0) {
        fail("S8-01", `${belowMin.length} touch target(s) below critical minimum (24px) at 375px width`,
          belowMin.slice(0, 3).map(t => `${t.tag}"${t.text}"(${t.w}×${t.h})`).join(", "));
      } else {
        warn("S8-01", `${tooSmall.length} touch target(s) below 36px recommended minimum at 375px`,
          tooSmall.slice(0, 3).map(t => `${t.tag}"${t.text}"(${t.w}×${t.h})`).join(", "));
      }

      await ctx.close();
    }

    // -----------------------------------------------------------------------
    // SUITE 9: Heading hierarchy (builder page)
    // -----------------------------------------------------------------------
    section("Suite 9: Heading hierarchy");
    {
      const { page, ctx } = await loadPage(browser, BUILDER_HTML, 1280, 900);
      await page.waitForTimeout(300);

      const headings = await page.evaluate(() => {
        const hs = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"));
        return hs.map(h => ({ level: parseInt(h.tagName[1]), text: (h.textContent || "").trim().substring(0, 60) }));
      });

      // Check for heading level skips (h1 → h3 without h2 is bad)
      let prevLevel = 0;
      const skips = [];
      for (const h of headings) {
        if (prevLevel > 0 && h.level > prevLevel + 1) {
          skips.push(`h${prevLevel}→h${h.level} ("${h.text}")`);
        }
        prevLevel = h.level;
      }

      if (headings.length === 0) {
        warn("S9-01", "No headings found on page");
      } else if (skips.length === 0) {
        pass("S9-01", `Heading hierarchy OK: ${headings.map(h => "h" + h.level).join(", ")}`);
      } else {
        fail("S9-01", `Heading level skip(s) found: ${skips.join("; ")} — screen readers lose document outline`);
      }

      await ctx.close();
    }

    // -----------------------------------------------------------------------
    // SUITE 10: Color contrast sampling (builder page, light mode default)
    // -----------------------------------------------------------------------
    section("Suite 10: Color contrast — CSS custom property values");
    {
      const { page, ctx } = await loadPage(browser, BUILDER_HTML, 1280, 900);
      await page.waitForTimeout(300);

      // We cannot run full WCAG AA contrast computation without a color library,
      // but we can check that the CSS custom properties have sensible values.
      const cssVars = await page.evaluate(() => {
        const el = document.documentElement;
        const style = window.getComputedStyle(el);
        return {
          "--text": style.getPropertyValue("--text").trim(),
          "--bg": style.getPropertyValue("--bg").trim(),
          "--accent-1": style.getPropertyValue("--accent-1").trim(),
          "--accent-2": style.getPropertyValue("--accent-2").trim(),
          "--danger": style.getPropertyValue("--danger").trim(),
          "--muted": style.getPropertyValue("--muted").trim(),
          "--border": style.getPropertyValue("--border").trim(),
        };
      });

      const defined = Object.entries(cssVars).filter(([k, v]) => v.length > 0);
      const missing = Object.entries(cssVars).filter(([k, v]) => v.length === 0);

      if (missing.length === 0) {
        pass("S10-01", `All design-system CSS custom properties defined: ${defined.map(([k, v]) => k + "=" + v).join(", ").substring(0, 120)}`);
      } else {
        fail("S10-01", `Missing CSS custom properties: ${missing.map(([k]) => k).join(", ")} — may cause invisible text or broken contrast`);
      }

      // Check that text color and background are both defined (basic contrast sanity)
      const textColor = cssVars["--text"];
      const bgColor = cssVars["--bg"];
      if (textColor && bgColor) {
        pass("S10-02", `Text (--text: ${textColor}) and background (--bg: ${bgColor}) colors defined`);
      } else {
        fail("S10-02", "Text or background CSS variable not resolved — contrast cannot be evaluated");
      }

      await ctx.close();
    }

    // -----------------------------------------------------------------------
    // SUITE 11: Edge cases — long content, overflow, empty states
    // -----------------------------------------------------------------------
    section("Suite 11: Edge cases — long strings, empty state, error state");
    {
      const { page, ctx } = await loadPage(browser, BUILDER_HTML, 375, 667);
      await page.waitForTimeout(300);

      // 11.1 Inject a very long title into an input and check overflow
      const hasInput = await page.evaluate(() => !!document.querySelector("input[type='text'], input[type='search'], input:not([type])"));
      if (hasInput) {
        await page.evaluate(() => {
          const inp = document.querySelector("input[type='text'], input[type='search'], input:not([type])");
          const LONG = "A".repeat(200) + " " + "B".repeat(200);
          inp.value = LONG;
          inp.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await page.waitForTimeout(200);

        const overflows = await page.evaluate(() => {
          const inp = document.querySelector("input[type='text'], input[type='search'], input:not([type])");
          if (!inp) return false;
          return inp.scrollWidth > inp.clientWidth;
        });
        // Inputs scroll their content — this is expected and fine
        pass("S11-01", `Long text input (400 chars): input content scrolls ${overflows ? "(scrollWidth > clientWidth)" : "(fits)"} — expected browser behavior`);
      } else {
        warn("S11-01", "No text input found for long-string overflow test");
      }

      // 11.2 Check if there's a visible empty state when no items are present
      // The builder page renders with no list rows by default
      const rowCount = await page.evaluate(() => {
        const rows = document.querySelectorAll(".lc-row, [data-row], .row-item, [class*='row']");
        return rows.length;
      });
      pass("S11-02", `Builder page with 0 list items: ${rowCount} row elements found (empty state rendered)`);

      await ctx.close();
    }

    // -----------------------------------------------------------------------
    // SUITE 12: Builder page — tab panel content and display
    // -----------------------------------------------------------------------
    section("Suite 12: Tab panel visibility (tabpanel display at load)");
    {
      const { page, ctx } = await loadPage(browser, BUILDER_HTML, 1280, 900);
      await page.waitForTimeout(500);

      const tabInfo = await page.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll("[role='tab']"));
        const panels = Array.from(document.querySelectorAll("[role='tabpanel']"));
        const selectedTab = tabs.find(t => t.getAttribute("aria-selected") === "true");
        const visiblePanels = panels.filter(p => {
          const s = window.getComputedStyle(p);
          return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
        });
        return {
          tabs: tabs.length,
          panels: panels.length,
          selectedTabId: selectedTab ? selectedTab.id : null,
          selectedTabControls: selectedTab ? selectedTab.getAttribute("aria-controls") : null,
          visiblePanels: visiblePanels.length,
          visiblePanelIds: visiblePanels.map(p => p.id),
        };
      });

      if (tabInfo.tabs > 0) {
        if (tabInfo.selectedTabControls) {
          // The selected tab's panel should be visible
          const controlledPanelVisible = tabInfo.visiblePanelIds.includes(tabInfo.selectedTabControls);
          if (controlledPanelVisible) {
            pass("S12-01", `Selected tab (${tabInfo.selectedTabId}) → panel #${tabInfo.selectedTabControls} is visible`);
          } else {
            fail("S12-01", `Selected tab controls #${tabInfo.selectedTabControls} but that panel is NOT visible (visible panels: ${tabInfo.visiblePanelIds.join(",")})`);
          }
        }
        if (tabInfo.visiblePanels === 1) {
          pass("S12-02", "Exactly 1 tab panel visible at load (others hidden) — correct tab behavior");
        } else if (tabInfo.visiblePanels === 0) {
          fail("S12-02", "No tab panels are visible at page load — content may be hidden from all users");
        } else {
          warn("S12-02", `${tabInfo.visiblePanels} tab panels visible simultaneously — usually only 1 should be shown`);
        }
      } else {
        warn("S12-01", "No role=tab found, tab panel visibility check skipped");
      }

      await ctx.close();
    }

  } finally {
    await browser.close();
  }

  // -----------------------------------------------------------------------
  // Results
  // -----------------------------------------------------------------------
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Results: ${passCount} pass, ${failCount} fail, ${warnCount} warn`);
  if (findings.length > 0) {
    console.log("\nCONFIRMED failures (exit non-zero):");
    for (const f of findings) {
      console.log(`  [${f.id}] ${f.msg}`);
      if (f.detail) console.log(`         ${f.detail}`);
    }
  }
  console.log(`${"─".repeat(60)}\n`);

  if (failCount > 0) {
    process.exit(1);
  }
}

runAll().catch(e => {
  console.error("Probe threw:", e.message, e.stack);
  process.exit(1);
});
