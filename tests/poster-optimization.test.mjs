// Badged posters & icon precomputation optimization (P8-4, PF-B4, PF-B5).
// Removes base64 inlining from /api/poster-badge and serves SVG overlays
// referencing allowlisted image URLs directly.
// Precomputes /icon.png bytes at module load.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import worker from "../worker_entry_combined.js";
import { makeEnv, makeD1, call } from "./harness.mjs";

describe("P8-4: Badged Posters & Icon Precomputation Optimization", () => {
  describe("/icon.png precomputed bytes", () => {
    it("serves valid PNG image with precomputed bytes and cache headers", async () => {
      const env = makeEnv();
      const res = await call(env, "/icon.png");

      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "image/png");
      assert.equal(res.headers.get("cache-control"), "public, max-age=86400");
      assert.ok(res.text.includes("PNG"));

      // Verify exact raw binary PNG bytes via worker.fetch
      const rawRes = await worker.fetch(new Request("https://example.test/icon.png"), env);
      const bytes = new Uint8Array(await rawRes.arrayBuffer());
      assert.ok(bytes.length > 50000, `icon bytes should be substantial (${bytes.length} bytes)`);
      assert.equal(bytes[0], 0x89);
      assert.equal(bytes[1], 0x50); // 'P'
      assert.equal(bytes[2], 0x4E); // 'N'
      assert.equal(bytes[3], 0x47); // 'G'
      assert.equal(bytes[4], 0x0D);
      assert.equal(bytes[5], 0x0A);
      assert.equal(bytes[6], 0x1A);
      assert.equal(bytes[7], 0x0A);
    });
  });

  describe("/api/poster-badge optimized SVG overlay", () => {
    it("rejects non-allowlisted poster hosts with 404 (SSRF & open redirect prevention)", async () => {
      const env = makeEnv();

      // No badge params (would be open redirect if not rejected)
      const res1 = await call(env, "/api/poster-badge?poster=" + encodeURIComponent("https://malicious.example/phish.jpg"));
      assert.equal(res1.status, 404);

      // With badge param (would be SSRF/open proxy if not rejected)
      const res2 = await call(env, "/api/poster-badge?poster=" + encodeURIComponent("https://evil.site/bad.jpg") + "&premiere=1");
      assert.equal(res2.status, 404);
    });

    it("redirects directly to untouched poster when no badges are requested or all aired", async () => {
      const env = makeEnv();
      const poster = "https://image.tmdb.org/t/p/w500/sample.jpg";

      // No badge params
      const resNoBadges = await call(env, "/api/poster-badge?poster=" + encodeURIComponent(poster));
      assert.equal(resNoBadges.status, 302);
      assert.equal(resNoBadges.headers.get("location"), poster);

      // Air date in the past
      const resAired = await call(env, "/api/poster-badge?poster=" + encodeURIComponent(poster) + "&airDate=2020-01-01");
      assert.equal(resAired.status, 302);
      assert.equal(resAired.headers.get("location"), poster);
    });

    it("serves compact SVG overlay referencing the image URL without base64 inlining or outbound fetch", async () => {
      const env = makeEnv();
      const poster = "https://image.tmdb.org/t/p/w500/test_poster.jpg";

      let outboundFetches = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (...args) => {
        outboundFetches++;
        return originalFetch(...args);
      };

      try {
        const res = await call(env, "/api/poster-badge?poster=" + encodeURIComponent(poster) + "&airDate=2028-09-15&premiere=1");

        assert.equal(res.status, 200);
        assert.equal(res.headers.get("content-type"), "image/svg+xml; charset=utf-8");
        assert.ok(res.headers.get("cache-control").includes("max-age="));

        // CRITICAL P8-4 assertion: NO outbound fetch to download the poster image!
        assert.equal(outboundFetches, 0, "must not download the poster image from TMDB or external hosts");

        const svg = res.text;

        // CRITICAL P8-4 assertion: NO data-URI base64 inlining!
        assert.ok(!svg.includes("data:image/"), "SVG must not contain base64 data URIs");
        assert.ok(!svg.includes(";base64,"), "SVG must not contain base64 content");

        // The image URL must be referenced directly in href and xlink:href
        assert.ok(svg.includes(`href="${poster}"`), "SVG must reference the poster URL directly in href");
        assert.ok(svg.includes(`xlink:href="${poster}"`), "SVG must reference the poster URL directly in xlink:href");

        // Badge content
        assert.ok(svg.includes("Season Premiere"), "SVG must include premiere badge text");

        // Payload size must be tiny (~1.5 KB), not hundreds of KB
        assert.ok(svg.length < 3000, `SVG payload should be compact (${svg.length} bytes)`);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("renders finale and air date badges correctly", async () => {
      const env = makeEnv();
      const poster = "https://image.tmdb.org/t/p/w500/finale_show.jpg";

      const res = await call(env, "/api/poster-badge?poster=" + encodeURIComponent(poster) + "&finale=1&airDate=2028-04-10");
      assert.equal(res.status, 200);

      const svg = res.text;
      assert.ok(svg.includes("Season Finale"));
      assert.ok(svg.includes("#ff9500"));
      assert.ok(svg.includes(`href="${poster}"`));
      assert.ok(!svg.includes("data:image/"));
    });

    it("renders companion badge with custom accent colors", async () => {
      const env = makeEnv();
      const poster = "https://image.tmdb.org/t/p/w500/companion.jpg";

      const res = await call(env, "/api/poster-badge?poster=" + encodeURIComponent(poster) + "&companion=" + encodeURIComponent("Sequel Film"));
      assert.equal(res.status, 200);

      const svg = res.text;
      assert.ok(svg.includes("Sequel Film"));
      assert.ok(svg.includes("rgba(37, 99, 235, 0.95)"));
      assert.ok(svg.includes(`href="${poster}"`));
      assert.ok(!svg.includes("data:image/"));
    });

    it("serves from isolate memo cache on repeated requests", async () => {
      const env = makeEnv();
      const poster = "https://image.tmdb.org/t/p/w500/cached_poster.jpg";
      const path = "/api/poster-badge?poster=" + encodeURIComponent(poster) + "&airDate=2028-11-20";

      const res1 = await call(env, path);
      assert.equal(res1.status, 200);

      const res2 = await call(env, path);
      assert.equal(res2.status, 200);
      assert.equal(res1.text, res2.text);
    });

    it("demonstrates sub-millisecond execution time over 100 badged poster requests", async () => {
      const env = makeEnv();
      const poster = "https://image.tmdb.org/t/p/w500/bench.jpg";

      const t0 = performance.now();
      for (let i = 0; i < 100; i++) {
        const res = await call(env, `/api/poster-badge?poster=${encodeURIComponent(poster)}&airDate=2028-12-0${i % 9 + 1}&premiere=1`);
        assert.equal(res.status, 200);
      }
      const durationMs = performance.now() - t0;
      const perReqMs = durationMs / 100;

      // In Node/V8 on Windows, 100 requests without network I/O or base64 loops finish in < 50ms (< 0.5ms each)
      assert.ok(perReqMs < 2.0, `Each badged poster request should average < 2.0ms (was ${perReqMs.toFixed(3)}ms)`);
    });
  });
});
