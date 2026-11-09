// Comments out of the JavaScript that is sent to browsers.
//
// The sources are full of comments: why something is done a certain way, which bug a line
// fixed. They are for whoever maintains the code, and a browser ignores them, but they made up
// about a quarter of what every visitor downloaded. /app.js and /app-features.js are cut out of
// the page in splitAppBundle (02_http-and-creator-utils.js) and pass through here first. The
// source files are never touched.
//
// It reads the code the way a browser does, so a "//" inside a string, a template literal or a
// regular expression is left alone: strings, template literals (with their ${ } code), regular
// expressions (told from division by what comes before the slash) and comments. Nothing else is
// changed: no renaming, no whitespace squeezing. A comment that held a line break leaves one,
// because a line break can end a statement. tests/strip-js-comments.test.mjs checks the unit
// cases and then parses the whole real bundle before and after with Node's own parser, and
// requires the two syntax trees to be identical.

// After one of these words a "/" starts a regular expression ("return /a/"), not a division.
const JS_REGEX_AFTER_WORD = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

// Where the template literal text starting at i ends: { end, expr } where expr says it stopped
// at a "${" (code follows) and not at the closing backtick.
function jsScanTemplate(js, i) {
  const n = js.length;
  while (i < n) {
    const c = js[i];
    if (c === "\\") i += 2;
    else if (c === "`") return { end: i + 1, expr: false };
    else if (c === "$" && js[i + 1] === "{") return { end: i + 2, expr: true };
    else i++;
  }
  return { end: n, expr: false };
}

// The end of the regular expression literal starting at i, or -1 when it is not one.
function jsScanRegex(js, i) {
  const n = js.length;
  let j = i + 1;
  let inClass = false;
  while (j < n) {
    const c = js[j];
    if (c === "\n") return -1;
    if (c === "\\") j += 2;
    else if (inClass) { if (c === "]") inClass = false; j++; }
    else if (c === "[") { inClass = true; j++; }
    else if (c === "/") {
      j++;
      while (j < n && /[a-z]/i.test(js[j])) j++;
      return j;
    }
    else j++;
  }
  return -1;
}

function stripJsComments(js) {
  const n = js.length;
  let out = "";
  let seg = 0; // js[seg..] is not yet copied to out
  let i = 0;
  let regexOk = true; // a "/" here starts a regular expression
  let braces = 0;
  const outer = []; // braces count of the code around each open "${"

  // Drops the comment js[from..to). A comment that has its line to itself takes the line with it;
  // one that shares a line leaves the code beside it (and a line break if it held one).
  const cut = (from, to, isLine) => {
    let lineStart = from;
    while (lineStart > 0 && (js[lineStart - 1] === " " || js[lineStart - 1] === "\t")) lineStart--;
    let after = to;
    while (after < n && (js[after] === " " || js[after] === "\t")) after++;
    const alone = (lineStart === 0 || js[lineStart - 1] === "\n") && (after >= n || js[after] === "\n" || js[after] === "\r");
    if (alone) {
      out += js.slice(seg, lineStart);
      if (js[after] === "\r") after++;
      if (js[after] === "\n") after++;
      seg = after;
      return after;
    }
    out += js.slice(seg, isLine ? lineStart : from) + (isLine ? "" : (js.slice(from, to).indexOf("\n") >= 0 ? "\n" : " "));
    seg = to;
    return to;
  };

  // Template text from j: either all of it, or up to a "${" whose code is then read as code.
  const template = (j) => {
    const t = jsScanTemplate(js, j);
    if (t.expr) { outer.push(braces); braces = 0; regexOk = true; } else regexOk = false;
    return t.end;
  };

  while (i < n) {
    const c = js[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    if (c === "/") {
      const next = js[i + 1];
      if (next === "/") {
        const end = js.indexOf("\n", i);
        i = cut(i, end < 0 ? n : end, true);
        continue;
      }
      if (next === "*") {
        const close = js.indexOf("*/", i + 2);
        i = cut(i, close < 0 ? n : close + 2, false);
        continue;
      }
      const end = regexOk ? jsScanRegex(js, i) : -1;
      if (end > 0) { i = end; regexOk = false; } else { i++; regexOk = true; }
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && js[j] !== c) j += js[j] === "\\" ? 2 : 1;
      i = j + 1;
      regexOk = false;
    } else if (c === "`") {
      i = template(i + 1);
    } else if (c === "}" && braces === 0 && outer.length) {
      braces = outer.pop();
      i = template(i + 1);
    } else if (c === "{" || c === "}") {
      braces = c === "{" ? braces + 1 : Math.max(0, braces - 1);
      regexOk = true;
      i++;
    } else if (/[A-Za-z0-9_$\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$\u0080-￿]/.test(js[j])) j++;
      regexOk = JS_REGEX_AFTER_WORD.has(js.slice(i, j));
      i = j;
    } else if (c === ")" || c === "]") {
      regexOk = false;
      i++;
    } else if ((c === "+" || c === "-") && js[i + 1] === c && !regexOk) {
      i += 2; // a postfix ++ or --, after which a slash divides
    } else {
      regexOk = true;
      i++;
    }
  }
  return out + js.slice(seg);
}
