// stripJsComments (src/core/05_js-comment-strip.js): the shipped /app.js and /app-features.js
// are sent without comments, which every visitor used to download for nothing. The source files
// keep them. What matters is that nothing but comments goes, so besides the unit cases below the
// whole real bundle is parsed before and after with Node's own parser and the trees are compared.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";

import { call, makeEnv } from "./harness.mjs";
import { renderPage } from "./client-harness.mjs";

const strip = vm.runInNewContext(fs.readFileSync(new URL("../src/core/05_js-comment-strip.js", import.meta.url), "utf8") + "\n;stripJsComments");

describe("stripJsComments: what it removes", () => {
  it("removes a whole-line comment with its line, and a trailing one with the space before it", () => {
    assert.equal(strip("a = 1;\n  // note\nb = 2; // why\nc = 3;\n"), "a = 1;\nb = 2;\nc = 3;\n");
  });

  it("removes block comments, keeping a line break when the comment held one", () => {
    assert.equal(strip("a = 1; /* x */ b = 2;"), "a = 1;   b = 2;");
    assert.equal(strip("a = 1\n/* one\n two */\nb = 2"), "a = 1\nb = 2", "a comment on its own lines goes entirely");
    assert.equal(strip("a = 1 /* one\ntwo */ b = 2"), "a = 1 \n b = 2", "a line break inside still separates the statements");
  });

  it("keeps the line break that ends a statement without a semicolon", () => {
    assert.equal(strip("let a = 1 // one\nlet b = 2"), "let a = 1\nlet b = 2");
  });
});

describe("stripJsComments: what it must not touch", () => {
  const same = (src) => assert.equal(strip(src), src);

  it("strings", () => {
    same(`x = "http://example.com/a"; y = 'a /* b */ c'; z = "// not a comment";`);
    same(`x = "she said \\"//\\" twice"; y = 'it\\'s // fine';`);
  });

  it("template literals, including the code inside ${ }", () => {
    same("x = `a // b /* c */ ${ 1 + 2 } d`;");
    same("x = `a ${ \"//\" + `nested // ${ y } ` } b`;");
    assert.equal(strip("x = `a ${ y /* c */ } b`;"), "x = `a ${ y   } b`;", "a comment inside ${ } is code, so it goes");
  });

  it("regular expressions, even ones that look like comments", () => {
    same("x = /\\/\\//.test(s);");
    same("x = s.replace(/[/]/g, '/'); // c".replace(" // c", ""));
    same("if (/https?:\\/\\//.test(s)) {}");
    same("y = a.split(/\\s*\\/\\*\\s*/);");
    same("return /a\\/b/g.test(s);");
  });

  it("division, which is not a regular expression", () => {
    same("x = a / b / c;");
    same("x = (a + b) / 2 / 3;");
    same("x = arr[0] / 2; y = n++ / 2;");
    assert.equal(strip("x = a / b; // c"), "x = a / b;");
  });

  it("code that only looks odd", () => {
    same("x = { a: 1 }; y = [1, 2].map((n) => n / 2);");
    same("label: for (;;) { break label; }");
  });
});

describe("the shipped bundles", () => {
  const env = makeEnv({});
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "strip-js-"));

  // The bundle exactly as the page carries it, between the markers splitAppBundle cuts at.
  function unstripped(startMarker, endMarker) {
    const html = renderPage();
    const start = html.indexOf(startMarker) + startMarker.length;
    return html.slice(start, html.indexOf(endMarker, start));
  }

  for (const [name, route, start, end] of [
    ["/app.js", "/app.js", '/*MYLISTS_APP_BUNDLE_START*/', '/*MYLISTS_APP_BUNDLE_END*/'],
    ["/app-features.js", "/app-features.js", '/*MYLISTS_APP_FEATURES_START*/', '/*MYLISTS_APP_FEATURES_END*/'],
  ]) {
    it(`${name} is the same program as before, only without comments`, async () => {
      const before = unstripped(start, end);
      const page = await call(env, "/");
      const ref = page.text.match(new RegExp('<script src="(' + route.replace(/[.\\/]/g, "\\$&") + '\\?v=[0-9a-f]+)"'));
      assert.ok(ref, "the page references " + route);
      const served = await call(env, ref[1]);
      assert.equal(served.status, 200);
      const after = served.text;
      assert.ok(after.length > 1000, "got the served bundle");
      assert.ok(after.length < before.length * 0.95, `comments really are gone: ${before.length} -> ${after.length} bytes`);
      assert.ok(!/\n\s*\/\/ [A-Za-z]/.test(after.slice(0, 200000)), "no whole-line comments are left");
      fs.writeFileSync(path.join(tmp, "a.js"), before);
      fs.writeFileSync(path.join(tmp, "b.js"), after);
      const r = spawnSync(process.execPath, ["--expose-internals", new URL("./tools/compare-js-ast.cjs", import.meta.url).pathname, path.join(tmp, "a.js"), path.join(tmp, "b.js")], { encoding: "utf8", maxBuffer: 1 << 28 });
      assert.match(r.stdout, /^SAME/, r.stdout + r.stderr);
    });
  }
});
