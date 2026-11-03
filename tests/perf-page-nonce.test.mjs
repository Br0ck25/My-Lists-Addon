import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, call } from "./harness.mjs";

// PERF-06: withSecurityHeaders read every HTML response back out of its own body
// (decode) only to swap the nonce placeholder, then encoded it again. The page
// string is now handed over directly. The nonce must still be fresh per response.

describe("PERF-06: the page nonce is inserted without re-reading the body", () => {
  it("serves a fresh nonce per response, in the CSP header and in every inline script/style", async () => {
    const env = makeEnv();
    const a = await call(env, "/");
    const b = await call(env, "/");
    const nonceOf = (r) => /'nonce-([^']+)'/.exec(r.headers.get("content-security-policy") || "")?.[1];
    const na = nonceOf(a), nb = nonceOf(b);
    assert.ok(na && nb && na !== nb, "each response has its own nonce");
    for (const [r, n] of [[a, na], [b, nb]]) {
      assert.ok(!r.text.includes("%%CSP_NONCE%%"), "no placeholder left");
      const tags = [...r.text.matchAll(/<(script|style)\b[^>]*>/g)].map((m) => m[0]).filter((t) => !/\bsrc=/.test(t) && !/application\/(ld\+json)/.test(t) || /ld\+json/.test(t));
      assert.ok(tags.length > 0);
      for (const t of tags) assert.match(t, new RegExp(`nonce="${n}"`), `tag without this response's nonce: ${t}`);
      assert.ok(!r.text.includes(n === na ? nb : na), "the other response's nonce does not leak in");
    }
  });

  it("does not call Response.text() on the page response", async () => {
    const env = makeEnv();
    await call(env, "/"); // warm the page memo
    const orig = Response.prototype.text;
    let htmlReads = 0;
    Response.prototype.text = function () {
      if ((this.headers.get("content-type") || "").startsWith("text/html")) htmlReads++;
      return orig.call(this);
    };
    try {
      const r = await call(env, "/");
      assert.equal(r.status, 200);
    } finally { Response.prototype.text = orig; }
    // call() itself reads the final body once with text(); that is the one allowed read.
    assert.ok(htmlReads <= 1, `the page body was read ${htmlReads} times`);
  });
});
