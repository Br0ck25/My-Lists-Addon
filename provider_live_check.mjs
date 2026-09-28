// Provider contract check (Phase 4, P4-5).
//
// tests/fixtures/providers/<provider>/<name>.json holds one example answer per
// provider endpoint the Worker reads, with the fields the Worker depends on
// listed under `required`. Two things use them:
//
//   * the test suite (tests/provider-contracts.test.mjs), which feeds the
//     fixtures to the real fetchers and checks what comes out, and which checks
//     each fixture against its own `required` list;
//   * this script, run nightly by .github/workflows/provider-live-check.yml,
//     which asks each live API the same question and checks the live answer
//     against the same list. When a provider renames or drops a field the
//     Worker reads, this fails and names the field, before anyone's catalog
//     quietly empties.
//
// Run it:  node provider_live_check.mjs
// Keys come from the environment (TMDB_API_KEY, TRAKT_CLIENT_ID,
// MDBLIST_API_KEY, SIMKL_CLIENT_ID, RAPIDAPI_KEY). A fixture whose key is not
// set is skipped and reported as skipped; the keyless providers (MDBList's
// public lists, Simkl's chart files, TVmaze, Cinemeta, JustWatch) always run.
// Exit code 1 when any checked endpoint failed.
//
// A `required` entry is a path into the answer:
//   a.b.c          present (not null or missing)
//   a[]            a non-empty list; the rest of the path must hold for EVERY item
//   a[*]           a non-empty list; the rest of the path must hold for AT LEAST ONE item
//   ...:type       and of that type: string, number, boolean, array, object
//   p || q         either path holds
// A path starting with [] or [*] is into an answer that is itself a list.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = path.join(REPO_ROOT, "tests", "fixtures", "providers");
// The only secrets a fixture may name. Their values are masked in anything
// this script prints.
export const LIVE_SECRETS = ["TMDB_API_KEY", "TRAKT_CLIENT_ID", "MDBLIST_API_KEY", "SIMKL_CLIENT_ID", "RAPIDAPI_KEY"];
const TYPES = new Set(["string", "number", "boolean", "array", "object"]);

export function loadFixtures(dir = FIXTURE_DIR) {
  const out = [];
  for (const provider of fs.readdirSync(dir).sort()) {
    const sub = path.join(dir, provider);
    if (!fs.statSync(sub).isDirectory()) continue;
    for (const file of fs.readdirSync(sub).filter((f) => f.endsWith(".json")).sort()) {
      const fx = JSON.parse(fs.readFileSync(path.join(sub, file), "utf8"));
      fx.file = `${provider}/${file}`;
      fx.name = file.replace(/\.json$/, "");
      out.push(fx);
    }
  }
  return out;
}

function parsePath(rule) {
  const colon = rule.lastIndexOf(":");
  let body = rule;
  let type = null;
  if (colon > 0 && TYPES.has(rule.slice(colon + 1))) {
    body = rule.slice(0, colon);
    type = rule.slice(colon + 1);
  }
  const steps = [];
  for (const part of body.split(".")) {
    const key = part.replace(/\[\*?\]/g, "");
    if (key) steps.push({ key });
    for (const b of part.match(/\[\*?\]/g) || []) steps.push(b === "[]" ? { every: true } : { some: true });
  }
  return { steps, type };
}

function typeOf(v) {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}

function describe(steps, i) {
  return steps.slice(0, i).map((s) => (s.key ? "." + s.key : s.every ? "[]" : "[*]")).join("").replace(/^\./, "") || "(the answer)";
}

// null when the path holds, otherwise why not.
function walk(value, steps, i, type) {
  if (i === steps.length) {
    if (value === undefined || value === null) return `${describe(steps, i)} is missing`;
    if (type && typeOf(value) !== type) {
      return `${describe(steps, i)} is ${typeOf(value)}, not ${type}`;
    }
    if (type === "number" && !Number.isFinite(value)) return `${describe(steps, i)} is not a finite number`;
    return null;
  }
  const step = steps[i];
  if (step.key) {
    if (value === undefined || value === null || typeof value !== "object") return `${describe(steps, i)} is missing`;
    return walk(value[step.key], steps, i + 1, type);
  }
  if (!Array.isArray(value)) return `${describe(steps, i)} is not a list`;
  if (!value.length) return `${describe(steps, i)} is an empty list`;
  if (step.every) {
    for (let n = 0; n < value.length; n++) {
      const why = walk(value[n], steps, i + 1, type);
      if (why) return `item ${n}: ${why}`;
    }
    return null;
  }
  let first = null;
  for (const item of value) {
    const why = walk(item, steps, i + 1, type);
    if (!why) return null;
    first = first || why;
  }
  return `no item passes (${first})`;
}

// The rules the value breaks, each with the reason; [] when it keeps them all.
export function checkRequired(value, required) {
  const problems = [];
  for (const rule of required || []) {
    const reasons = rule.split("||").map((alt) => {
      const { steps, type } = parsePath(alt.trim());
      return walk(value, steps, 0, type);
    });
    if (!reasons.some((r) => r === null)) problems.push(`${rule} -- ${reasons.join("; ")}`);
  }
  return problems;
}

// "results.0.id" into a value.
export function pickPath(value, dotted) {
  let v = value;
  for (const k of String(dotted).split(".")) {
    if (v === undefined || v === null) return undefined;
    v = v[/^\d+$/.test(k) ? Number(k) : k];
  }
  return v;
}

function fill(template, vars) {
  if (typeof template === "string") {
    return template.replace(/\{([A-Z][A-Z0-9_]*)\}/g, (all, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : all));
  }
  if (Array.isArray(template)) return template.map((t) => fill(t, vars));
  if (template && typeof template === "object") {
    const out = {};
    for (const [k, v] of Object.entries(template)) out[k] = fill(v, vars);
    return out;
  }
  return template;
}

function mask(text, secrets) {
  let s = String(text);
  for (const v of secrets) if (v && v.length >= 4) s = s.split(v).join("***");
  return s;
}

// The GraphQL query the Worker really sends, read from its source, so the
// nightly check asks JustWatch exactly what production asks.
function workerJustWatchQuery() {
  const src = fs.readFileSync(path.join(REPO_ROOT, "07_source-fetchers-tmdb-simkl.js"), "utf8");
  const m = /const JUSTWATCH_NEW_TITLES_QUERY = `([\s\S]*?)`;/.exec(src);
  return m ? m[1] : "";
}

async function send(spec, vars) {
  const req = fill(spec, vars);
  const init = {
    method: req.method || "GET",
    headers: { "User-Agent": "my-lists-addon-live-check", Accept: "application/json", ...(req.headers || {}) },
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  };
  if (req.body !== undefined) init.body = JSON.stringify(req.body);
  const res = await fetch(req.url, init);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, json, url: req.url };
}

// One retry for a network error, a 5xx or a 429: a provider having a bad
// minute is not a contract change.
async function sendWithRetry(spec, vars) {
  try {
    const first = await send(spec, vars);
    if (first.status < 500 && first.status !== 429) return first;
  } catch {
    // fall through to the retry
  }
  await new Promise((r) => setTimeout(r, 3000));
  return send(spec, vars);
}

export async function runLiveCheck({ env = process.env, fixtures = loadFixtures(), log = console.log } = {}) {
  const secrets = LIVE_SECRETS.map((n) => env[n]).filter(Boolean);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const results = [];
  for (const fx of fixtures) {
    const live = fx.live;
    if (!live || !live.request) {
      results.push({ fx, status: "skipped", detail: (live && live.reason) || "no live request" });
      continue;
    }
    const missing = (live.needs || []).filter((n) => !env[n]);
    if (missing.length) {
      results.push({ fx, status: "skipped", detail: `${missing.join(", ")} not set` });
      continue;
    }
    const vars = { YESTERDAY: yesterday, JUSTWATCH_NEW_TITLES_QUERY: workerJustWatchQuery() };
    for (const n of LIVE_SECRETS) if (env[n]) vars[n] = env[n];
    try {
      if (live.discover) {
        const found = await sendWithRetry(live.discover, vars);
        if (found.status < 200 || found.status >= 300) throw new Error(`finding a sample failed: HTTP ${found.status} from ${mask(found.url, secrets)}`);
        const picked = pickPath(found.json, live.discover.pick);
        if (picked === undefined || picked === null || picked === "") throw new Error(`finding a sample: ${live.discover.pick} is missing in ${mask(found.url, secrets)}`);
        vars.DISCOVERED = picked;
      }
      const got = await sendWithRetry(live.request, vars);
      if (got.status < 200 || got.status >= 300) throw new Error(`HTTP ${got.status} from ${mask(got.url, secrets)}`);
      if (got.json === undefined) throw new Error(`the answer from ${mask(got.url, secrets)} is not JSON`);
      const problems = checkRequired(got.json, fx.required);
      results.push(problems.length
        ? { fx, status: "failed", detail: problems.join(" | ") }
        : { fx, status: "passed", detail: "" });
    } catch (err) {
      results.push({ fx, status: "failed", detail: mask(err && err.message ? err.message : err, secrets) });
    }
  }
  for (const r of results) log(`${r.status.padEnd(7)} ${r.fx.file}${r.detail ? "  " + r.detail : ""}`);
  return results;
}

async function main() {
  const results = await runLiveCheck();
  const count = (s) => results.filter((r) => r.status === s).length;
  console.log(`\n${count("passed")} passed, ${count("failed")} failed, ${count("skipped")} skipped`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = results.map((r) => `| ${r.status} | \`${r.fx.file}\` | ${r.fx.endpoint || ""} | ${String(r.detail || "").replace(/\|/g, "\\|")} |`);
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
      "## Provider live check", "",
      `${count("passed")} passed, ${count("failed")} failed, ${count("skipped")} skipped.`, "",
      "| Result | Fixture | Endpoint | Detail |", "|---|---|---|---|", ...rows, "",
    ].join("\n"));
  }
  process.exitCode = count("failed") ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
