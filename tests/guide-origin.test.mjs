// UI-18: the Guide and FAQ named "mylistsaddon.com" in their text on every copy of
// the site, including one someone runs themselves (their buttons already led to
// their own origin). The text now shows the host the page is served from.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import vm from "node:vm";

function loadWorker() {
  let src = fs.readFileSync(new URL("../worker_entry_combined.js", import.meta.url), "utf8");
  src = src.slice(0, src.lastIndexOf("export default"));
  const sandbox = { console, Date, Math, JSON, TextEncoder, TextDecoder, URL, URLSearchParams, crypto: globalThis.crypto,
    atob: (s) => Buffer.from(s, "base64").toString("binary"), btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    fetch: async () => { throw new Error("no network"); }, caches: { default: { match: async () => null, put: async () => {} } },
    setTimeout, clearTimeout, setInterval, clearInterval };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: "worker_entry_combined.js" });
  return sandbox;
}

// The support address and the sentence about the public site's own funding are the
// owner's, and stay as they are.
const withoutOwnerText = (html) => html
  .replace(/support@mylistsaddon\.com/g, "")
  .replace(/The public site at mylistsaddon\.com will shut down[^"<]*/g, "");

describe("the Guide names the site it is served from", () => {
  const w = loadWorker();

  it("a copy on another host says its own host, not mylistsaddon.com", () => {
    const html = String(w.renderGuidePage("https://lists.example.org"));
    assert.match(html, /Go to lists\.example\.org/);
    assert.match(html, /Open lists\.example\.org/);
    assert.match(html, /Import List on lists\.example\.org/);
    assert.doesNotMatch(withoutOwnerText(html), /mylistsaddon\.com/);
  });

  it("the public site's own Guide is unchanged", () => {
    const html = String(w.renderGuidePage("https://mylistsaddon.com"));
    assert.match(html, /Go to mylistsaddon\.com/);
    assert.match(html, /Import List on mylistsaddon\.com/);
  });

  it("the FAQ data search engines read matches the page text", () => {
    const html = String(w.renderGuidePage("https://lists.example.org"));
    const ld = html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
    assert.ok(ld, "the guide carries structured data");
    assert.doesNotMatch(withoutOwnerText(ld[1]), /mylistsaddon\.com/);
    assert.match(ld[1], /lists\.example\.org/);
  });
});
