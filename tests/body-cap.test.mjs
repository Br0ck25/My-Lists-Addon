// API-02: a size limit must not trust the Content-Length header, which the sender controls.
// A chunked request has no Content-Length, so the endpoints read the body in full before
// looking at its size. These tests send a streamed body with no length header and check
// that the endpoint stops reading once the cap is passed.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { freshIsolate, makeEnv, makeKv, nextIp } from "./harness.mjs";

const CHUNK = 4096;

// A request body that counts how much of it the endpoint pulled.
function streamBody(totalBytes) {
  const seen = { pulled: 0 };
  let sent = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (sent >= totalBytes) return controller.close();
      const n = Math.min(CHUNK, totalBytes - sent);
      controller.enqueue(new TextEncoder().encode("a".repeat(n)));
      sent += n;
      seen.pulled = sent;
    },
  });
  return { body, seen };
}

async function post(env, path, contentType, totalBytes) {
  const w = await freshIsolate();
  const { body, seen } = streamBody(totalBytes);
  const req = new Request("https://example.test" + path, {
    method: "POST", body, duplex: "half",
    headers: { "Content-Type": contentType, "CF-Connecting-IP": nextIp(), Origin: "https://ko-fi.com" },
  });
  assert.equal(req.headers.get("content-length"), null, "the sender gave no length");
  const res = await w.fetch(req, env, { waitUntil() {} });
  return { status: res.status, seen };
}

describe("API-02: request bodies are capped by what is read, not by the header", () => {
  it("Ko-fi webhook: a streamed body over the cap gets 413 and is not read in full", async () => {
    const env = makeEnv({ CONFIGS: makeKv(), KOFI_VERIFICATION_TOKEN: "t" });
    const total = 20000 * 20;
    const { status, seen } = await post(env, "/api/kofi-webhook", "application/x-www-form-urlencoded", total);
    assert.equal(status, 413);
    assert.ok(seen.pulled < total / 4, `stopped reading early (read ${seen.pulled} of ${total})`);
  });

  it("CSP report sink: a streamed body over the cap is dropped without being read in full", async () => {
    const env = makeEnv();
    const total = 8192 * 20;
    const { status, seen } = await post(env, "/api/csp-report", "application/csp-report", total);
    assert.equal(status, 204);
    assert.ok(seen.pulled < total / 4, `stopped reading early (read ${seen.pulled} of ${total})`);
  });
});
