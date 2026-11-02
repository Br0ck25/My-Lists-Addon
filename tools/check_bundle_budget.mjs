// Bundle Budget Check (Phase 8, P8-3)
// Enforces that the initial first-view client bundle (/app.js) remains strictly under 150 KB gzip.
import fs from "node:fs";
import zlib from "node:zlib";
import vm from "node:vm";

let src = fs.readFileSync("worker_entry_combined.js", "utf8");
const idx = src.lastIndexOf("export default");
if (idx === -1) {
  console.error("FAIL: no `export default` found in worker_entry_combined.js");
  process.exit(1);
}
src = src.slice(0, idx);

const sandbox = {
  console, Date, Math, JSON, TextEncoder, TextDecoder, URL, URLSearchParams,
  crypto: globalThis.crypto,
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  fetch: async () => { throw new Error("no network in sandbox"); },
  caches: { default: { match: async () => null, put: async () => {} } },
  setTimeout, clearTimeout, setInterval, clearInterval,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "worker_entry_combined.js" });

async function main() {
  const origin = "https://example.com";
  const html = sandbox.renderBuilder(origin, {});
  const split = await sandbox.splitAppBundle(html);
  const splitCss = await sandbox.splitAppCss(split.page);

  const pageHtml = splitCss.page;
  const appJs = split.bundle ? split.bundle.js : "";
  const appFeaturesJs = split.featuresBundle ? split.featuresBundle.js : "";
  const appCss = splitCss.css ? splitCss.css.css : "";

  if (!appJs || !split.bundle.hash) {
    console.error("FAIL: /app.js bundle was not extracted properly");
    process.exit(1);
  }
  if (!appFeaturesJs || !split.featuresBundle.hash) {
    console.error("FAIL: /app-features.js bundle was not extracted properly");
    process.exit(1);
  }
  if (!appCss || !splitCss.css.hash) {
    console.error("FAIL: /app.css stylesheet was not extracted properly");
    process.exit(1);
  }

  const gz = (buf) => zlib.gzipSync(Buffer.from(buf)).length;

  const pageHtmlGz = gz(pageHtml);
  const appCssGz = gz(appCss);
  const appJsGz = gz(appJs);
  const appFeaturesGz = gz(appFeaturesJs);
  const firstViewTotalGz = pageHtmlGz + appCssGz + appJsGz;

  console.log("=== BUNDLE BUDGET AUDIT (P8-3) ===");
  console.log(`Page HTML (split):          raw: ${pageHtml.length.toLocaleString().padStart(9)} B | gzip: ${pageHtmlGz.toLocaleString().padStart(7)} B (${(pageHtmlGz/1024).toFixed(2)} KB)`);
  console.log(`Stylesheet (/app.css):        raw: ${appCss.length.toLocaleString().padStart(9)} B | gzip: ${appCssGz.toLocaleString().padStart(7)} B (${(appCssGz/1024).toFixed(2)} KB)`);
  console.log(`First View JS (/app.js):      raw: ${appJs.length.toLocaleString().padStart(9)} B | gzip: ${appJsGz.toLocaleString().padStart(7)} B (${(appJsGz/1024).toFixed(2)} KB)`);
  console.log(`Features (/app-features.js):  raw: ${appFeaturesJs.length.toLocaleString().padStart(9)} B | gzip: ${appFeaturesGz.toLocaleString().padStart(7)} B (${(appFeaturesGz/1024).toFixed(2)} KB)`);
  console.log("---------------------------------------------------------------");
  console.log(`First View JS Bundle (/app.js): ${(appJsGz/1024).toFixed(2)} KB gzip (budget: <= 150.00 KB)`);
  console.log(`Critical First View Total:      ${(firstViewTotalGz/1024).toFixed(2)} KB gzip`);
  console.log("===============================================================");

  const BUDGET_APP_JS_GZIP = 150 * 1024; // 150 KB
  if (appJsGz > BUDGET_APP_JS_GZIP) {
    console.error(`FAIL: /app.js gzip size (${appJsGz} B) exceeds the 150 KB budget (${BUDGET_APP_JS_GZIP} B)!`);
    process.exit(1);
  }
  console.log(`OK: First view JS bundle is ${(appJsGz/1024).toFixed(2)} KB gzip, within the 150 KB budget.`);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
