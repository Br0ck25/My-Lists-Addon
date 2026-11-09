// Run with: node --expose-internals tests/tools/compare-js-ast.cjs <original.js> <stripped.js>
// Parses both with the JavaScript parser Node itself ships (acorn) and checks the syntax trees are
// identical apart from source positions. Comments are not part of a tree, so a stripped file that
// passes means nothing but comments (and the whitespace around them) changed.
const fs = require("node:fs");
const acorn = require("internal/deps/acorn/acorn/dist/acorn");

const parse = (file) => acorn.parse(fs.readFileSync(file, "utf8"), { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true });
const plain = (node) => JSON.stringify(node, (k, v) => (k === "start" || k === "end" ? undefined : v));

const [a, b] = process.argv.slice(2);
const left = plain(parse(a));
const right = plain(parse(b));
if (left === right) {
  console.log("SAME " + left.length);
} else {
  let i = 0;
  while (i < left.length && left[i] === right[i]) i++;
  console.log("DIFFERENT at " + i + "\n" + left.slice(Math.max(0, i - 150), i + 150) + "\n---\n" + right.slice(Math.max(0, i - 150), i + 150));
  process.exit(1);
}
