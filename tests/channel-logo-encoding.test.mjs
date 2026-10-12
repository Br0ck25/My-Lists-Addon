// /api/channel-logo embeds the TMDB image in its SVG as a base64 data URI. The
// endpoint used to encode with its own byte-by-byte loop although
// bytesToBase64 (chunked) exists in the same file; at the 2 MB cap the loop is
// roughly ten times slower. These pin what must not change when the two are
// merged: the data URI decodes back to exactly the bytes TMDB sent, including
// an image longer than one encoding chunk and bytes outside ASCII.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { call, makeEnv } from "./harness.mjs";

async function logoFor(bytes, contentType = "image/png") {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(bytes, { status: 200, headers: { "content-type": contentType } });
  try {
    const r = await call(makeEnv(), "/api/channel-logo?path=" + encodeURIComponent("/logo123.png"));
    assert.equal(r.status, 200);
    return r.text;
  } finally {
    globalThis.fetch = realFetch;
  }
}

const embedded = (svg) => {
  const m = svg.match(/href="data:([^;"]+);base64,([A-Za-z0-9+/=]+)"/);
  assert.ok(m, "the SVG carries a base64 data URI");
  return { type: m[1], bytes: Uint8Array.from(Buffer.from(m[2], "base64")) };
};

describe("/api/channel-logo data URI", () => {
  it("decodes to exactly the bytes upstream sent (every byte value, longer than one chunk)", async () => {
    const sent = new Uint8Array(100000).map((_, i) => (i * 7 + (i >> 8)) & 255);
    const { type, bytes } = embedded(await logoFor(sent));
    assert.equal(type, "image/png");
    assert.equal(bytes.length, sent.length);
    assert.ok(bytes.every((b, i) => b === sent[i]), "the embedded image is the one that was sent");
  });

  it("a tiny image survives too, and the content type comes from upstream", async () => {
    const sent = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const { type, bytes } = embedded(await logoFor(sent, "image/webp; charset=binary"));
    assert.equal(type, "image/webp");
    assert.deepEqual([...bytes], [...sent]);
  });
});
