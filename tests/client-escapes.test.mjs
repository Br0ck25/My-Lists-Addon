// The page's code lives inside the Worker's own template literal (09_..24_ are
// one big string), so it is read twice: once by the Worker, which cooks every
// escape in it, and again by the browser. A single backslash never reaches
// the browser -- `/\s+/` arrives as `/s+/` (split on the letter s), `/^\d+$/`
// as `/^d+$/` (one or more letter d), and `\b` as a backspace character. A
// regex built from a string needs four: `'\\\\b'` here is `'\\b'` in the
// browser, which is the `\b` the RegExp wants.
//
// Nothing complains when this goes wrong: the page parses, the render checks
// pass, and the code quietly matches something else. P6-6 found the first of
// these, HANDOFF listed three more, and a sweep found about thirty from the
// initial commit -- the IMDb-id finder in the file importer never matched an
// id, escapeRegex escaped nothing, "hide watched" never recognised a bare
// TMDB id. These tests keep the class from coming back.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadClient, renderPage } from "./client-harness.mjs";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Every line of page code, with where it is. 09_ starts with Worker-side
// helpers (the shell's nav, read by the Worker, not the browser), so only
// renderBuilder onwards is page code there. A line opening with ${ is a
// Worker expression spliced into the page, so its escapes are the Worker's.
function pageCodeLines() {
  const out = [];
  const files = fs.readdirSync(REPO_ROOT).filter((f) => /^(09|1[0-9]|2[0-4])_.*\.js$/.test(f)).sort();
  for (const file of files) {
    const lines = fs.readFileSync(path.join(REPO_ROOT, file), "utf8").split("\n");
    let inPage = file !== "09_page-shell.js";
    lines.forEach((line, i) => {
      if (!inPage && line.startsWith("function renderBuilder(")) inPage = true;
      if (!inPage) return;
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*") || code.startsWith("${")) return;
      out.push({ file, line: i + 1, text: line });
    });
  }
  return out;
}

// An odd run of backslashes is a lone one: the Worker cooks it away. The
// escapes that are deliberate here are \` and \${ (a backtick or a ${ meant
// for the browser) and \uXXXX (the character itself, the P6-7 apostrophe rule).
function loneBackslash(text) {
  const re = /(\\+)(.)/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[1].length % 2 === 0) continue;
    const next = m[2];
    if (next === "`" || next === "u") continue;
    if (next === "$" && text[m.index + m[0].length] === "{") continue;
    return m[0];
  }
  return null;
}

describe("escapes in the page's code survive the Worker's template literal", () => {
  it("has no lone backslash left in 09_..24_", () => {
    const found = pageCodeLines()
      .map((l) => ({ ...l, esc: loneBackslash(l.text) }))
      .filter((l) => l.esc)
      .map((l) => `${l.file}:${l.line} ${l.esc}  ${l.text.trim().slice(0, 90)}`);
    assert.deepEqual(found, [], "write it doubled (\\\\s, \\\\d, \\\\.), or four deep inside a RegExp string");
  });

  it("renders no backspace character and none of the broken patterns", () => {
    // Whole-line comments dropped: a few of them explain this very rule, and a
    // backspace in a comment is only a strange character in a comment.
    const html = renderPage().split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    assert.equal(html.includes("\b"), false, "a \\b reached the page as a backspace character");
    for (const broken of ["split(/s+/)", "/[^a-z0-9s]/", "/^d+$/", "/[-T s]/".replace(" ", ""), "/.[^.]+$/"]) {
      assert.equal(html.includes(broken), false, `the page carries ${broken}`);
    }
    for (const kept of ["split(/\\s+/)", "/^\\d+$/", "new RegExp('\\\\b(tt\\\\d{7,10})\\\\b')"]) {
      assert.ok(html.includes(kept), `the page should carry ${kept}`);
    }
  });

  it("escapeRegex escapes, and a word-boundary search built on it matches", () => {
    const client = loadClient();
    assert.equal(client.call("escapeRegex", "a.b*c(d)[e]$"), "a\\.b\\*c\\(d\\)\\[e\\]\\$");
    const rx = new RegExp("\\b" + client.call("escapeRegex", "c++") + "(?!\\w)", "i");
    assert.ok(rx.test("learn c++ today"));
  });
});
