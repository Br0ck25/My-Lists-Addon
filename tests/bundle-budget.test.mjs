import { describe, it } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { makeEnv, call } from "./harness.mjs";

describe("P8-3: Bundle Budget & Two-Tier Split", () => {
  it("serves /app.js within the 150 KB gzip budget with immutable headers", async () => {
    const env = makeEnv();
    const pageRes = await call(env, "/");
    assert.equal(pageRes.status, 200);

    const m = pageRes.text.match(/<script src="\/app\.js\?v=([0-9a-f]+)">/);
    assert.ok(m, "page must reference content-hashed /app.js");
    const hash = m[1];
    assert.equal(hash.length, 20, "hash must be 20 hex characters (SHA-256 slice)");

    const res = await call(env, `/app.js?v=${hash}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/javascript; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(res.headers.get("etag"), `"${hash}"`);

    const gzLen = zlib.gzipSync(Buffer.from(res.text)).length;
    const maxBudget = 150 * 1024;
    assert.ok(
      gzLen <= maxBudget,
      `/app.js gzip size (${gzLen} B / ${(gzLen/1024).toFixed(2)} KB) must be <= 150 KB (${maxBudget} B)`
    );

    // 304 revalidation
    const reval = await call(env, `/app.js?v=${hash}`, {
      headers: { "if-none-match": `"${hash}"` }
    });
    assert.equal(reval.status, 304);
  });

  it("serves /app-features.js as deferred secondary bundle with immutable headers", async () => {
    const env = makeEnv();
    const pageRes = await call(env, "/");
    assert.equal(pageRes.status, 200);

    const m = pageRes.text.match(/<script src="\/app-features\.js\?v=([0-9a-f]+)" defer>/);
    assert.ok(m, "page must reference content-hashed /app-features.js with defer");
    const hash = m[1];
    assert.equal(hash.length, 20, "features hash must be 20 hex characters");

    const res = await call(env, `/app-features.js?v=${hash}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/javascript; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(res.headers.get("etag"), `"${hash}"`);
    assert.ok(res.text.length > 500000, "features bundle contains secondary builders and tabs");

    // 304 revalidation
    const reval = await call(env, `/app-features.js?v=${hash}`, {
      headers: { "if-none-match": `"${hash}"` }
    });
    assert.equal(reval.status, 304);
  });

  it("service worker recognizes /app-features.js as an immutable asset", async () => {
    const env = makeEnv();
    const swRes = await call(env, "/sw.js");
    assert.equal(swRes.status, 200);
    assert.match(
      swRes.text,
      /\/app-features\.js/,
      "service worker must include /app-features.js in isImmutableAsset"
    );
  });

  it("serves identical bundle hashes regardless of whether user is on new UI or legacy", async () => {
    const envLegacy = makeEnv();
    const legacy = await call(envLegacy, "/");
    const envShell = makeEnv();
    const shell = await call(envShell, "/", { cookie: "FF_NEW_UI=1" });

    const mLegacy = legacy.text.match(/<script src="\/app\.js\?v=([0-9a-f]+)">/);
    const mShell = shell.text.match(/<script src="\/app\.js\?v=([0-9a-f]+)">/);
    assert.ok(mLegacy && mShell);
    assert.equal(mShell[1], mLegacy[1], "core bundle hash must be identical across UI modes");

    const mfLegacy = legacy.text.match(/<script src="\/app-features\.js\?v=([0-9a-f]+)" defer>/);
    const mfShell = shell.text.match(/<script src="\/app-features\.js\?v=([0-9a-f]+)" defer>/);
    assert.ok(mfLegacy && mfShell);
    assert.equal(mfShell[1], mfLegacy[1], "features bundle hash must be identical across UI modes");
  });
});
