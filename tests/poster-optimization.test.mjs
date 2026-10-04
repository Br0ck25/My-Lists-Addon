// Badged posters and the precomputed icon (P8-4, PF-B4, PF-B5).
//
// P8-4 also stopped putting the poster inside a badged poster's SVG and linked
// to it instead. An SVG shown as an image (an <img>, a Stremio tile) may not
// load anything from outside itself, so every badged TMDB or Metahub poster
// showed the badge on a blank card on the live site (2026-10-02 to the fix).
// The poster is embedded again; what P8-4 keeps is the isolate cache, now
// bounded by size.

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

  describe("/api/poster-badge", () => {
    // A 1x1 PNG, as TMDB would send a poster.
    const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

    function fakePosterHost(answer) {
      const realFetch = globalThis.fetch;
      const asked = [];
      globalThis.fetch = async (input, init) => {
        const u = String(input && input.url ? input.url : input);
        if (u.startsWith("https://image.tmdb.org/")) {
          asked.push(u);
          return answer(u);
        }
        return realFetch(input, init);
      };
      return { asked, restore: () => { globalThis.fetch = realFetch; } };
    }
    const png = () => new Response(PNG, { status: 200, headers: { "Content-Type": "image/png" } });

    it("rejects non-allowlisted poster hosts with 404 (SSRF & open redirect prevention)", async () => {
      const env = makeEnv();
      const res1 = await call(env, "/api/poster-badge?poster=" + encodeURIComponent("https://malicious.example/phish.jpg"));
      assert.equal(res1.status, 404);
      const res2 = await call(env, "/api/poster-badge?poster=" + encodeURIComponent("https://evil.site/bad.jpg") + "&premiere=1");
      assert.equal(res2.status, 404);
    });

    it("redirects to the untouched poster when no badge is due", async () => {
      const env = makeEnv();
      const poster = "https://image.tmdb.org/t/p/w500/sample.jpg";
      const resNoBadges = await call(env, "/api/poster-badge?poster=" + encodeURIComponent(poster));
      assert.equal(resNoBadges.status, 302);
      assert.equal(resNoBadges.headers.get("location"), poster);
      const resAired = await call(env, "/api/poster-badge?poster=" + encodeURIComponent(poster) + "&airDate=2020-01-01");
      assert.equal(resAired.status, 302);
      assert.equal(resAired.headers.get("location"), poster);
    });

    it("puts the poster inside the SVG, because an SVG shown as an image loads nothing from outside", async () => {
      const host = fakePosterHost(png);
      try {
        const env = makeEnv();
        const poster = "https://image.tmdb.org/t/p/w500/embedded.jpg";
        const res = await call(env, "/api/poster-badge?poster=" + encodeURIComponent(poster) + "&airDate=2028-09-15&premiere=1");
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("content-type"), "image/svg+xml; charset=utf-8");
        const svg = res.text;
        assert.ok(svg.includes("data:image/png;base64," + PNG.toString("base64")), "the poster's own bytes");
        assert.ok(!svg.includes(`href="${poster}"`), "no link out to the poster host");
        assert.ok(svg.includes("Season Premiere"));
        assert.equal(host.asked.length, 1);
      } finally {
        host.restore();
      }
    });

    it("renders finale, air date and companion badges", async () => {
      const host = fakePosterHost(png);
      try {
        const env = makeEnv();
        const finale = await call(env, "/api/poster-badge?poster=" + encodeURIComponent("https://image.tmdb.org/t/p/w500/finale_show.jpg") + "&finale=1&airDate=2028-04-10");
        assert.equal(finale.status, 200);
        assert.ok(finale.text.includes("Season Finale"));
        assert.ok(finale.text.includes("#ff9500"));
        const companion = await call(env, "/api/poster-badge?poster=" + encodeURIComponent("https://image.tmdb.org/t/p/w500/companion.jpg") + "&companion=" + encodeURIComponent("Sequel Film"));
        assert.equal(companion.status, 200);
        assert.ok(companion.text.includes("Sequel Film"));
        assert.ok(companion.text.includes("rgba(37, 99, 235, 0.95)"));
        assert.ok(companion.text.includes("data:image/png;base64,"));
      } finally {
        host.restore();
      }
    });

    it("sends the plain poster rather than a blank badge when the poster cannot be had", async () => {
      const host = fakePosterHost((u) => (u.includes("missing") ? new Response("nope", { status: 404 }) : new Response("<html>", { status: 200, headers: { "Content-Type": "text/html" } })));
      try {
        const env = makeEnv();
        for (const name of ["missing.jpg", "not-an-image.jpg"]) {
          const poster = "https://image.tmdb.org/t/p/w500/" + name;
          const res = await call(env, "/api/poster-badge?poster=" + encodeURIComponent(poster) + "&airDate=2028-11-20");
          assert.equal(res.status, 302, name);
          assert.equal(res.headers.get("location"), poster);
        }
      } finally {
        host.restore();
      }
    });

    it("answers a repeat from the isolate cache, without fetching the poster again", async () => {
      const host = fakePosterHost(png);
      try {
        const env = makeEnv();
        const path = "/api/poster-badge?poster=" + encodeURIComponent("https://image.tmdb.org/t/p/w500/cached_poster.jpg") + "&airDate=2028-11-21";
        const res1 = await call(env, path);
        const res2 = await call(env, path);
        assert.equal(res1.status, 200);
        assert.equal(res1.text, res2.text);
        assert.equal(host.asked.length, 1);
      } finally {
        host.restore();
      }
    });

    it("does not keep a poster too big for the cache's share of memory", async () => {
      // A 900 KB poster is ~1.2 MB as base64: over the per-entry cap, so it is
      // fetched again rather than held.
      const big = Buffer.alloc(900 * 1024, 7);
      const host = fakePosterHost(() => new Response(big, { status: 200, headers: { "Content-Type": "image/jpeg" } }));
      try {
        const env = makeEnv();
        const path = "/api/poster-badge?poster=" + encodeURIComponent("https://image.tmdb.org/t/p/w500/huge.jpg") + "&airDate=2028-11-22";
        assert.equal((await call(env, path)).status, 200);
        assert.equal((await call(env, path)).status, 200);
        assert.equal(host.asked.length, 2);
      } finally {
        host.restore();
      }
    });
  });
});
