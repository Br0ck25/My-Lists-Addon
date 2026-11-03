// The badged poster JPEG that Stremio users see (audit TEST-03).
//
// Stremio cannot draw an SVG, so with the Cloudflare Images binding the badges
// are laid over the poster as a JPEG; the pills and fades are small PNGs the
// Worker encodes by hand. Before this test nothing ran that branch, and a
// failure inside it was swallowed, so a break meant blank posters with no error
// anywhere. Here an IMAGES stub records what would be drawn and the test checks
// the overlays are real PNGs (signature, chunk CRCs, pixel data size).
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { call, makeEnv } from "./harness.mjs";

const realFetch = globalThis.fetch;
const realError = console.error;
const realWarn = console.warn;
afterEach(() => { globalThis.fetch = realFetch; console.error = realError; console.warn = realWarn; });

const POSTER = "https://image.tmdb.org/t/p/w500/poster.jpg";
let seq = 0;
const badgeUrl = (extra) => `/api/poster-badge?poster=${encodeURIComponent(POSTER)}&d=${++seq}-${Date.now()}${extra}`;

function stubPoster() {
  globalThis.fetch = async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } });
}

// Cloudflare's Images binding, just enough: input(stream) -> pipeline with
// transform / draw / output; text() -> a text overlay. The main pipeline's
// draws are recorded with the bytes of each overlay.
function makeImages({ failOutput = false } = {}) {
  const log = { overlays: [], texts: [], formats: [] };
  const bytesOf = async (stream) => new Uint8Array(await new Response(stream).arrayBuffer());
  const pipeline = (stream) => {
    const p = { stream, transformed: false, draws: [] };
    p.transform = () => { p.transformed = true; return p; };
    p.draw = (what, pos) => { p.draws.push([what, pos]); return p; };
    p.output = async (opts) => {
      if (failOutput) throw new Error("Images binding exploded");
      log.formats.push(opts.format);
      const base = await bytesOf(p.stream);
      if (p.transformed) {
        for (const [what, pos] of p.draws) log.overlays.push({ bytes: await bytesOf(what.stream), pos });
      }
      return { response: (init = {}) => new Response(base, { status: 200, headers: { "Content-Type": opts.format, ...(init.headers || {}) } }) };
    };
    return p;
  };
  return {
    log,
    input: (stream) => pipeline(stream),
    text: (text, opts) => { log.texts.push({ text, opts }); return { text }; },
  };
}

// Independent CRC-32 (not the Worker's own), so a wrong CRC in the Worker is caught.
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function checkPng(bytes) {
  assert.deepEqual(Array.from(bytes.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10], "PNG signature");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 8; const chunks = []; let w = 0, h = 0, idat = null;
  while (off < bytes.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(...bytes.subarray(off + 4, off + 8));
    const body = bytes.subarray(off + 8, off + 8 + len);
    const stored = dv.getUint32(off + 8 + len);
    assert.equal(stored, crc32(bytes.subarray(off + 4, off + 8 + len)), `${type} chunk CRC`);
    if (type === "IHDR") { w = dv.getUint32(off + 8); h = dv.getUint32(off + 12); }
    if (type === "IDAT") idat = body;
    chunks.push(type);
    off += 12 + len;
  }
  assert.deepEqual(chunks, ["IHDR", "IDAT", "IEND"]);
  assert.equal(zlib.inflateSync(Buffer.from(idat)).length, (w * 4 + 1) * h, "pixel data matches width x height");
  return { w, h };
}

describe("badged poster as a JPEG (Stremio)", () => {
  it("with the Images binding the answer is a JPEG, drawn from valid PNG overlays", async () => {
    stubPoster();
    const images = makeImages();
    const env = makeEnv({ IMAGES: images });
    const res = await call(env, badgeUrl("&airDate=2099-01-05&airTime=9PM&premiere=1"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/jpeg", "Stremio gets a JPEG, not the SVG it cannot draw");
    // top fade + date pill + 2 words, bottom fade + pill + 1 word  -> overlays on the poster
    const sizes = images.log.overlays.map((o) => checkPng(o.bytes));
    assert.ok(sizes.length >= 7, `expected the fades, pills and words to be drawn, got ${sizes.length}`);
    assert.deepEqual(sizes[0], { w: 500, h: 220 }, "top fade");
    assert.ok(sizes.some((s) => s.h === 96), "the date + time pill");
    assert.ok(images.log.texts.some((t) => t.text === "SEASON PREMIERE"), "the bottom badge words are drawn");
    assert.ok(images.log.texts.some((t) => t.text === "9PM"));
  });

  it("without the Images binding it still answers with the SVG (Nuvio)", async () => {
    stubPoster();
    const res = await call(makeEnv(), badgeUrl("&airDate=2099-01-05&premiere=1"));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /image\/svg\+xml/);
  });

  it("a failure inside the JPEG branch falls back to the SVG and is logged, not thrown away", async () => {
    stubPoster();
    const logged = [];
    console.error = (...a) => logged.push(a.map(String).join(" "));
    console.warn = (...a) => logged.push(a.map(String).join(" "));
    const env = makeEnv({ IMAGES: makeImages({ failOutput: true }) });
    const res = await call(env, badgeUrl("&airDate=2099-01-05&premiere=1"));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /image\/svg\+xml/, "the poster is still shown");
    const lines = logged.filter((l) => /poster-badge/.test(l) && /Images binding exploded/.test(l));
    assert.equal(lines.length, 1, `one log line per failure, got: ${JSON.stringify(logged)}`);
  });
});
