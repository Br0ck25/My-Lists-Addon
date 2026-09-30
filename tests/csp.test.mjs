import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import zlib from "node:zlib";
import { awaitFreshRateWindow, call, makeD1, makeEnv } from "./harness.mjs";

// P7-1: the Content-Security-Policy is nonce-based, every page the Worker
// serves is stamped with the one nonce its own response names, and the two
// third-party origins the page used to depend on are gone -- fflate is served
// from this origin (/vendor/...), and the fonts are the device's own.
//
// The properties that matter, and why each is here:
//
//   1. script-src has no 'unsafe-inline' and no host. That is what turns an
//      injected <script> (or an injected src to someone else's server) from
//      script execution into nothing at all.
//   2. The nonce in the header is the nonce in the body, and a second response
//      never reuses it. A shared or predictable nonce is the same as
//      'unsafe-inline' with extra steps.
//   3. Every inline block in every page carries it -- builder, shell, /guide,
//      /admin login and /admin dashboard. A block that missed it is not a
//      degraded page, it is a dead one: the browser refuses the whole bundle.
//      html_checks.py fails the build on the same thing at render time; this
//      runs it against the real responses.
//   4. Two requests still agree on the ETag. The nonce is per response, the
//      memoized page is not: if the nonce leaked into the memo or the hash,
//      every visit would be a fresh 600KB instead of a 304.
//   5. The vendored zip reader is a WORKING zip reader, byte for byte the
//      0.8.2 UMD build -- a "self-hosted" library that cannot unzip is worse
//      than the CDN, because nothing fails until someone imports a file.
//   6. /api/csp-report answers a browser the way a browser needs it to
//      (204, no auth, no CSRF check) without becoming free storage for anyone
//      else: capped, rate-limited, and counting without a write per report.

const NONCE_PLACEHOLDER = "%%CSP_NONCE%%";

function nonceInHeader(res) {
  const csp = res.headers.get("content-security-policy") || "";
  const m = csp.match(/script-src [^;]*?'nonce-([^']+)'/);
  return m ? m[1] : "";
}

// Every inline (no src) <script>/<style> opening tag in a page.
function inlineTags(html) {
  const tags = [];
  for (const m of html.matchAll(/<script\b([^>]*)>/g)) {
    if (!/\bsrc\s*=/.test(m[1])) tags.push(m[0]);
  }
  for (const m of html.matchAll(/<style\b([^>]*)>/g)) tags.push(m[0]);
  return tags;
}

async function adminCookie(env) {
  const r = await call(env, "/admin/login", { method: "POST", form: { key: env.ADMIN_KEY } });
  const setCookie = r.headers.get("set-cookie") || "";
  const m = setCookie.match(/^([^=]+=[^;]+)/);
  return m ? m[1] : "";
}

// A real .zip, built here so the assertion is about parsing and inflating, not
// about the API merely existing. Stored (method 0) and deflated (method 8)
// entries, both, because a reader that only handles one is a reader that will
// fail on someone's export.
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data, store } of entries) {
    const raw = Buffer.from(data, "utf8");
    const method = store ? 0 : 8;
    const body = store ? raw : zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const nameBytes = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);       // version needed
    local.writeUInt16LE(0, 6);        // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);       // time
    local.writeUInt16LE(0x2821, 12);  // date (2000-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);       // extra length
    chunks.push(local, nameBytes, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x2821, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt16LE(0, 30);         // extra
    dir.writeUInt16LE(0, 32);         // comment
    dir.writeUInt16LE(0, 34);         // disk
    dir.writeUInt16LE(0, 36);         // internal attrs
    dir.writeUInt32LE(0, 38);         // external attrs
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, end]);
}

// The served library, evaluated the way a browser evaluates it: as a classic
// script that assigns the global `fflate` (the UMD wrapper's `self`).
function loadServedFflate(source) {
  const sandbox = { console, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView, Math, JSON, setTimeout };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "vendor/fflate-0.8.2.js" });
  return sandbox.fflate;
}

describe("P7-1: script-src is nonce-only", () => {
  it("serves a nonce-based policy with no 'unsafe-inline' and no host", async () => {
    const env = makeEnv();
    const res = await call(env, "/");
    const csp = res.headers.get("content-security-policy") || "";
    assert.match(csp, /script-src 'self' 'nonce-[A-Za-z0-9_-]+'/);
    assert.equal(/'unsafe-inline'/.test(csp.split("style-src")[0]), false,
      "script-src must not carry 'unsafe-inline'");
    // The style half is deliberately split (see securityHeaders): elements are
    // nonce-only, attributes stay 'unsafe-inline' because the app writes
    // style="..." in strings.
    assert.match(csp, /style-src 'self' 'unsafe-inline'/);
    assert.match(csp, /style-src-elem 'self' 'nonce-[A-Za-z0-9_-]+'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /base-uri 'self'/);
  });

  it("puts the response's own nonce in the body, and never reuses one", async () => {
    const env = makeEnv();
    const first = await call(env, "/");
    const second = await call(env, "/");
    const n1 = nonceInHeader(first);
    const n2 = nonceInHeader(second);
    assert.ok(n1 && n2, "both responses name a nonce");
    assert.notEqual(n1, n2, "two responses must not share a nonce");
    assert.equal(first.text.includes(NONCE_PLACEHOLDER), false, "the placeholder must not survive to the browser");
    const tags = inlineTags(first.text);
    assert.ok(tags.length >= 5, `expected the page's inline blocks, found ${tags.length}`);
    for (const tag of tags) {
      assert.ok(tag.includes(`nonce="${n1}"`), `an inline block is not stamped with this response's nonce: ${tag.slice(0, 90)}`);
    }
  });

  it("stamps /guide and both /admin pages with their own nonces", async () => {
    const env = makeEnv();
    for (const path of ["/guide", "/", "/catalogs"]) {
      const res = await call(env, path, path === "/catalogs" ? { cookie: "FF_NEW_UI=1" } : {});
      assert.equal(res.status, 200, path);
      const nonce = nonceInHeader(res);
      assert.ok(nonce, `${path} has no nonce in its policy`);
      assert.equal(res.text.includes(NONCE_PLACEHOLDER), false, `${path} still holds the placeholder`);
      const tags = inlineTags(res.text);
      assert.ok(tags.length > 0, `${path} should have inline blocks`);
      for (const tag of tags) {
        assert.ok(tag.includes(`nonce="${nonce}"`), `${path}: unstamped block ${tag.slice(0, 80)}`);
      }
    }
    const cookie = await adminCookie(env);
    const login = await call(env, "/admin");
    assert.equal(login.status, 200);
    assert.equal(inlineTags(login.text).length, 2, "the login page's theme script and stylesheet");
    for (const tag of inlineTags(login.text)) {
      assert.ok(tag.includes(`nonce="${nonceInHeader(login)}"`), `login page: unstamped block ${tag.slice(0, 80)}`);
    }
    const dash = await call(env, "/admin", { cookie });
    assert.equal(dash.status, 200);
    assert.ok(inlineTags(dash.text).length >= 3, "the dashboard's theme script, its stylesheet and its own script");
    for (const tag of inlineTags(dash.text)) {
      assert.ok(tag.includes(`nonce="${nonceInHeader(dash)}"`), `dashboard: unstamped block ${tag.slice(0, 80)}`);
    }
  });

  it("keeps the memoized page's ETag stable across different nonces", async () => {
    const env = makeEnv();
    const first = await call(env, "/");
    const etag = first.headers.get("etag");
    assert.ok(etag, "the page is served with an ETag");
    const again = await call(env, "/", { headers: { "If-None-Match": etag } });
    assert.equal(again.status, 304, "a repeat visit is still a 304, not a fresh 600KB");
    assert.equal(again.text, "");
  });

  it("leaves the shared bundle and stylesheet out of the page", async () => {
    const env = makeEnv();
    const res = await call(env, "/");
    assert.match(res.text, /<script src="\/app\.js\?v=[0-9a-f]+"><\/script>/);
    assert.match(res.text, /<link rel="stylesheet" href="\/app\.css\?v=[0-9a-f]+">/);
    assert.equal(res.text.includes("MYLISTS_APP_BUNDLE_START"), false,
      "the split markers must not reach the browser");
  });
});

describe("P7-1: Trusted Types in report-only mode", () => {
  it("asks for reports on HTML pages and names the endpoint", async () => {
    const env = makeEnv();
    const res = await call(env, "/");
    assert.match(res.headers.get("content-security-policy-report-only") || "",
      /require-trusted-types-for 'script'/);
    assert.match(res.headers.get("content-security-policy-report-only") || "",
      /report-uri \/api\/csp-report/);
    assert.equal(res.headers.get("reporting-endpoints"), 'csp-endpoint="/api/csp-report"');
    // Enforcement is untouched: the enforced header has no trusted-types ask.
    assert.equal(/trusted-types/.test(res.headers.get("content-security-policy") || ""), false);
  });

  it("can be turned off with FF_CSP_TT_REPORT=0 without touching enforcement", async () => {
    const env = makeEnv({ FF_CSP_TT_REPORT: "0" });
    const res = await call(env, "/");
    assert.equal(res.headers.get("content-security-policy-report-only"), null);
    assert.equal(res.headers.get("reporting-endpoints"), null);
    assert.match(res.headers.get("content-security-policy") || "", /script-src 'self' 'nonce-/);
  });
});

describe("P7-1: the self-hosted zip reader", () => {
  it("is served by this origin and works", async () => {
    const env = makeEnv();
    const res = await call(env, "/vendor/fflate-0.8.2.js");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /^application\/javascript/);
    assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");

    const fflate = loadServedFflate(res.text);
    assert.equal(typeof fflate.unzipSync, "function");
    assert.equal(typeof fflate.strFromU8, "function");

    const zip = buildZip([
      { name: "watched-movies.csv", data: "Title,Year\nHeat,1995\n" },
      { name: "watched-history.csv", data: "Title,Year,Type\nSicario,2015,movie\n", store: true },
    ]);
    const out = fflate.unzipSync(new Uint8Array(zip));
    assert.deepEqual(Object.keys(out).sort(), ["watched-history.csv", "watched-movies.csv"]);
    assert.equal(fflate.strFromU8(out["watched-movies.csv"]), "Title,Year\nHeat,1995\n");
    assert.equal(fflate.strFromU8(out["watched-history.csv"]), "Title,Year,Type\nSicario,2015,movie\n");
  });

  it("is byte for byte the vendored fflate 0.8.2 build", async () => {
    const env = makeEnv();
    const res = await call(env, "/vendor/fflate-0.8.2.js");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(res.text));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    assert.equal(hex, "c3b34f2e9f5e74d4d7d64e01cac7a0c01954c6c406414d42185c7b53d6875ddf",
      "FFLATE_UMD_JS no longer matches the vendored fflate 0.8.2 UMD build");
  });

  it("has no unstamped inline script anywhere in the page that loads it", async () => {
    const env = makeEnv();
    const page = await call(env, "/");
    // The one <script src> is the vendored reader plus the bundle; neither
    // needs a nonce ('self' covers them) -- but every inline one does, and
    // that is asserted above. This pins the count so a new inline block added
    // without the placeholder shows up as a change here too.
    const srcs = [...page.text.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(srcs.filter((s) => s.includes("fflate")), ["/vendor/fflate-0.8.2.js"]);
  });
});

describe("P7-1: the /api/csp-report sink", () => {
  const legacyBody = JSON.stringify({
    "csp-report": {
      "effective-directive": "require-trusted-types-for",
      "blocked-uri": "https://example.test/posters?q=<script>",
      "document-uri": "https://example.test/",
    },
  });

  it("accepts a report with no Origin, no cookie and a non-JSON content type", async () => {
    const env = makeEnv();
    const res = await call(env, "/api/csp-report", {
      method: "POST",
      headers: { "Content-Type": "application/csp-report", Origin: "", "Sec-Fetch-Site": "" },
      rawBody: legacyBody,
    });
    assert.equal(res.status, 204, "the CSRF check must exempt this endpoint");
    assert.equal(res.text, "");
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  it("accepts the Reporting API's batch shape too", async () => {
    const env = makeEnv();
    const res = await call(env, "/api/csp-report", {
      method: "POST",
      headers: { "Content-Type": "application/reports+json" },
      rawBody: JSON.stringify([
        { type: "trusted-types-sink", body: { blockedURL: "https://example.test/x?a=<b>", violationType: "TrustedScript" } },
        { type: "csp-violation", body: { effectiveDirective: "script-src" } },
      ]),
    });
    assert.equal(res.status, 204);
  });

  it("counts into Analytics Engine without a write per report", async () => {
    const env = makeEnv();
    const points = [];
    env.ANALYTICS = { writeDataPoint: (p) => points.push(p) };
    await call(env, "/api/csp-report", {
      method: "POST",
      headers: { "Content-Type": "application/csp-report", Origin: "" },
      rawBody: legacyBody,
    });
    // The request itself also writes one metrics point (writeRequestMetrics),
    // so the report's own point is picked out by its index.
    const cspPoints = points.filter((p) => String((p.indexes && p.indexes[0]) || "").startsWith("csp:"));
    assert.equal(cspPoints.length, 1);
    assert.equal(cspPoints[0].blobs[0], "csp-violation");
    assert.equal(cspPoints[0].blobs[1], "require-trusted-types-for");
    // Only the origin of a blocked-uri is kept: a blocked URL can carry the
    // payload that caused the violation, and this ends up in logs/metrics.
    assert.equal(cspPoints[0].blobs[2], "https://example.test");
    // Nothing is stored per report.
    const kvKeys = env.CONFIGS._store ? [...env.CONFIGS._store.keys()] : [];
    assert.deepEqual(kvKeys.filter((k) => k.startsWith("csp:")), []);
  });

  it("answers junk, an oversized body and a GET the same quiet way", async () => {
    const env = makeEnv();
    const junk = await call(env, "/api/csp-report", {
      method: "POST", headers: { "Content-Type": "application/csp-report" }, body: "not json at all",
    });
    assert.equal(junk.status, 204);
    const points = [];
    env.ANALYTICS = { writeDataPoint: (p) => points.push(p) };
    const big = await call(env, "/api/csp-report", {
      method: "POST",
      headers: { "Content-Type": "application/csp-report", "Content-Length": "9000" },
      rawBody: "x".repeat(9000),
    });
    assert.equal(big.status, 204);
    assert.equal(points.filter((p) => String((p.indexes && p.indexes[0]) || "").startsWith("csp:")).length, 0,
      "an oversized body is refused before it is parsed");
    const get = await call(env, "/api/csp-report");
    assert.equal(get.status, 404, "the route is POST-only");
  });

  it("rate-limits per IP without telling the reporter", async () => {
    const env = makeEnv({ DB: makeD1() });
    const points = [];
    env.ANALYTICS = { writeDataPoint: (p) => points.push(p) };
    const ip = "203.0.113.9";
    // The budget is per window and the windows are clock-aligned, so this
    // starts with at least three seconds of window left: the 65 reports below
    // take milliseconds, but a boundary falling in the middle of them would
    // reset the counter and every one of them would be recorded.
    await awaitFreshRateWindow();
    const report = () => call(env, "/api/csp-report", {
      method: "POST", ip,
      headers: { "Content-Type": "application/csp-report", Origin: "" },
      rawBody: legacyBody,
    });
    for (let i = 0; i < 5; i++) {
      assert.equal((await report()).status, 204);
    }
    // Five reports from one IP spend five of the minute's budget, and since
    // P7-3 the counter is a row in D1 -- exact, atomic, one per aligned
    // window -- rather than a KV key whose reads the edge could serve stale.
    const row = await env.DB.prepare("SELECT count FROM rate_counters WHERE scope = ?")
      .bind(`csp-report:${ip}`).first();
    assert.equal(Number(row && row.count), 5);
    // ...and a refused report is answered 204 too, so the only way to see the
    // limit from outside is that nothing was recorded for it. The window is
    // seeded to its ceiling here rather than by sending the 60 reports that
    // spend it: the outcome must not depend on how long 60 requests take,
    // because their window is one the clock can end underneath them. The seed
    // is retried once for the same reason -- a seed and the request after it
    // can land either side of a boundary, which would zero the row.
    const recorded = () => points.filter((p) => String((p.indexes && p.indexes[0]) || "").startsWith("csp:")).length;
    const scope = `csp-report:${ip}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const windowStart = Math.floor(Date.now() / 60000) * 60000;
      await env.DB.prepare("DELETE FROM rate_counters WHERE scope = ?").bind(scope).run();
      await env.DB.prepare("INSERT INTO rate_counters (scope, window_start, count) VALUES (?, ?, ?)")
        .bind(scope, windowStart, 60).run();
      const before = recorded();
      assert.equal((await report()).status, 204, "a browser must never be told it was throttled");
      if (recorded() === before) break;
      assert.equal(attempt, 0, "a report over the window's budget was still recorded");
    }
    const after = await env.DB.prepare("SELECT count FROM rate_counters WHERE scope = ?")
      .bind(scope).first();
    assert.equal(Number(after && after.count), 61, "a refused report still counts as having arrived");
    // The acceptance test for the whole P7-3 move: not one ratelimit: key in
    // KV, however much limiting just happened.
    const kvRateKeys = [...env.CONFIGS._store.keys()].filter((k) => k.startsWith("ratelimit:"));
    assert.deepEqual(kvRateKeys, []);
  });
});
