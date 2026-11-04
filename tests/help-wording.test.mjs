// UI-09 / UI-16: help and placeholder text must name buttons and sections that
// exist. Two renames left stale copy behind: the "Refresh Preview" button is now
// "Refresh", and the "External Accounts & API Keys" settings section is now
// "Connected Services".
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listSources } from "./sources.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientAndPage = () => listSources(root).filter((n) => /^src\/(client|page)\/\d\d_.*\.js$/.test(n));
// Visible strings only: a whole-line // comment may still tell the history.
const codeLines = (f) => fs.readFileSync(path.join(root, f), "utf8").split("\n")
  .map((text, i) => ({ text, n: i + 1 })).filter((l) => !/^\s*\/\//.test(l.text));

describe("help text names things that exist", () => {
  it("nothing tells the person to press 'Refresh Preview' (the button is 'Refresh')", () => {
    const bad = [];
    for (const f of clientAndPage()) for (const l of codeLines(f)) if (/Refresh Preview/.test(l.text)) bad.push(`${f}:${l.n}`);
    assert.deepEqual(bad, []);
  });

  it("the catalog placeholder while posters load is neutral", () => {
    const row = fs.readFileSync(path.join(root, "src/client/16_client-row-core.js"), "utf8");
    assert.match(row, /live-preview-posters"><p[^>]*><small>Loading posters/);
  });

  it("help sends people to Settings -> Connected Services, not 'External Accounts & API Keys -> Import List' (Import List is under the Connected Services pill)", () => {
    const pills = fs.readFileSync(path.join(root, "src/page/14_tab-presets-backup.js"), "utf8");
    assert.match(pills, />Connected Services</, "the pill that holds Import List exists under this name");
    const bad = [];
    for (const f of clientAndPage()) for (const l of codeLines(f)) {
      if (/External Accounts\s*(&amp;|&) API Keys\s*(&rarr;|->|\u2192)\s*Import List/.test(l.text)) bad.push(`${f}:${l.n}`);
    }
    assert.deepEqual(bad, []);
  });
});
