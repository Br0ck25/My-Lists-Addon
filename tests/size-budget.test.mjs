// Size rule (docs/CODE_QUALITY_AUDIT.md, CQ-18): a ratchet, not a wall.
//
// New code: functions <= 150 lines, source files (src/**/NN_*.js) <= 3,000 lines.
// Code that is already over those limits is listed in tests/size-budget.json with
// its current size. That list may only SHRINK:
//   - an item over the limit that is not listed        -> fail (split it)
//   - a listed item bigger than its recorded size      -> fail (may only shrink)
//   - a listed item now under the limit, or gone       -> fail (remove it from the json)
//
// Functions are measured on the server sources joined the way build.py joins them
// (src/header.js, then every src/*/NN_*.js sorted by file name). Client code inside
// the page template is a string to the parser, so only the FILE limit applies to it.
// Exempt, because the page itself is their length: renderBuilder, renderAdminDashboard.
//
// Keys are "file::name" (nested: "file::outer>inner"), never line numbers, so moving
// unrelated code does not disturb them. Anonymous functions are named by the variable,
// property or class member they are assigned to; ones with no such name (callbacks,
// IIFEs) are skipped and do not add a level to the path. Two functions with the same
// key in one file get "#2", "#3" in source order.
//
// Run:  node --test tests/size-budget.test.mjs
//       node tests/size-budget.test.mjs --update   lower numbers / drop entries only
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BASELINE_FILE = new URL("./size-budget.json", import.meta.url);
const FUNCTION_LIMIT = 150;
const FILE_LIMIT = 3000;
const EXEMPT_FUNCTIONS = new Set(["renderBuilder", "renderAdminDashboard"]);
const NEED_ACORN = "acorn is not installed (node_modules/acorn is missing): run `bash verify.sh --fast` first, it installs the parser.";

const lineCount = (text) => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

function sourceFiles() {
  const out = [];
  for (const dir of readdirSync(join(ROOT, "src"), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const f of readdirSync(join(ROOT, "src", dir.name))) {
      if (/^\d\d_.*\.js$/.test(f)) out.push(`src/${dir.name}/${f}`);
    }
  }
  // build.py: sorted(glob('src/*/[0-9][0-9]_*.js'), key=os.path.basename)
  return out.sort((a, b) => (basename(a) < basename(b) ? -1 : basename(a) > basename(b) ? 1 : 0));
}

async function loadAcorn() {
  if (!existsSync(join(ROOT, "node_modules", "acorn"))) throw new Error(NEED_ACORN);
  return import("acorn");
}

function keyName(node, parent) {
  if (node.type === "FunctionDeclaration") return node.id && node.id.name;
  if (!parent) return null;
  if (parent.type === "VariableDeclarator" && parent.init === node && parent.id.type === "Identifier") return parent.id.name;
  if (parent.type === "AssignmentExpression" && parent.right === node) {
    const l = parent.left;
    if (l.type === "Identifier") return l.name;
    if (l.type === "MemberExpression" && !l.computed) return l.property.name;
  }
  if ((parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") && parent.value === node && !parent.computed) {
    return parent.key.name || (parent.key.value !== undefined ? String(parent.key.value) : null);
  }
  if (node.id && node.type === "FunctionExpression") return node.id.name;
  return null;
}

export async function measure() {
  const acorn = await loadAcorn();
  const files = sourceFiles();
  // Concatenate exactly like build.py (LF added after a file without a final newline).
  const parts = [["src/header.js", readFileSync(join(ROOT, "src/header.js"), "utf8")]];
  for (const f of files) parts.push([f, readFileSync(join(ROOT, f), "utf8")]);
  let code = "";
  const starts = []; // [firstLine (1-based), file]
  let line = 1;
  const fileSizes = {};
  for (const [f, text] of parts) {
    const t = text.endsWith("\n") ? text : text + "\n";
    starts.push([line, f]);
    code += t;
    line += lineCount(t);
    if (f !== "src/header.js") fileSizes[f] = lineCount(text.replace(/\r\n/g, "\n"));
  }
  const fileAt = (ln) => { let r = starts[0]; for (const s of starts) { if (s[0] <= ln) r = s; else break; } return r; };

  const ast = acorn.parse(code, { ecmaVersion: 2023, sourceType: "module", locations: true });
  const sizes = {};
  const seen = {};
  const isFn = (n) => n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression";
  (function walk(node, parent, path) {
    if (!node || typeof node.type !== "string") return;
    let nextPath = path;
    if (isFn(node)) {
      const name = keyName(node, parent);
      if (name) {
        const [, file] = fileAt(node.loc.start.line);
        const size = node.loc.end.line - node.loc.start.line + 1;
        const exempt = path.length === 0 && EXEMPT_FUNCTIONS.has(name);
        if (size > FUNCTION_LIMIT && !exempt) {
          let key = `${file}::${[...path, name].join(">")}`;
          seen[key] = (seen[key] || 0) + 1;
          if (seen[key] > 1) key += `#${seen[key]}`;
          sizes[key] = size;
        } else {
          const k = `${file}::${[...path, name].join(">")}`;
          seen[k] = (seen[k] || 0) + 1;
        }
        nextPath = [...path, name];
      }
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === "string" && walk(c, node, nextPath));
      else if (v && typeof v.type === "string") walk(v, node, nextPath);
    }
  })(ast, null, []);

  const bigFiles = {};
  for (const [f, n] of Object.entries(fileSizes)) if (n > FILE_LIMIT) bigFiles[f] = n;
  return { functions: sizes, files: bigFiles };
}

const sortObj = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

function compare(current, saved) {
  const problems = [];
  for (const kind of ["functions", "files"]) {
    const limit = kind === "functions" ? FUNCTION_LIMIT : FILE_LIMIT;
    const cur = current[kind], base = saved[kind] || {};
    for (const [k, n] of Object.entries(cur)) {
      if (!(k in base)) problems.push(`${k}: new code over the limit (${n} lines, limit ${limit}): split it`);
      else if (n > base[k]) problems.push(`${k}: grew from ${base[k]} to ${n}: may only shrink`);
    }
    for (const k of Object.keys(base)) {
      if (!(k in cur)) problems.push(`${k}: now under the limit or no longer exists: remove it from tests/size-budget.json (or run node tests/size-budget.test.mjs --update)`);
    }
  }
  return problems;
}

if (process.argv.includes("--update")) {
  let current;
  try { current = await measure(); } catch (e) { console.error("size-budget: " + e.message); process.exit(1); }
  const saved = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
  const next = { functions: {}, files: {} };
  let lowered = 0, removed = 0, refused = 0;
  for (const kind of ["functions", "files"]) {
    for (const [k, old] of Object.entries(saved[kind] || {})) {
      const n = current[kind][k];
      if (n === undefined) { removed++; continue; }
      if (n > old) { refused++; next[kind][k] = old; continue; } // never raise
      if (n < old) lowered++;
      next[kind][k] = n;
    }
  }
  writeFileSync(BASELINE_FILE, JSON.stringify({ functions: sortObj(next.functions), files: sortObj(next.files) }, null, 1) + "\n");
  console.log(`size-budget: ${lowered} lowered, ${removed} removed, ${refused} grew (left as is: they still fail). New items are never added.`);
  process.exit(0);
}

test("size budget: nothing new over the limit, nothing listed grew or is stale", async () => {
  const current = await measure(); // throws a clear message when acorn is missing
  const saved = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
  const problems = compare(current, saved);
  assert.equal(problems.length, 0, `\n  ` + problems.join("\n  "));
});
