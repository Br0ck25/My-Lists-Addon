import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { makeKv } from "./harness.mjs";

// noteBetterPosterVariant remembers "already noted" in memory for six hours.
// That memory must not be set for good when the KV write failed, or the variant
// is not retried until the isolate is recycled.

async function load() {
  const src = readFileSync(new URL("../worker_entry_combined.js", import.meta.url), "utf8");
  const file = `${tmpdir()}/mla-bpvariant-${process.pid}-${Date.now()}.mjs`;
  writeFileSync(file, src + "\nexport { noteBetterPosterVariant };\n");
  try { return await import(pathToFileURL(file).href); } finally { unlinkSync(file); }
}

describe("noteBetterPosterVariant", () => {
  it("retries on the next call after a failed KV write", async () => {
    const { noteBetterPosterVariant } = await load();
    const kv = makeKv();
    const realPut = kv.put.bind(kv);
    let failNext = true;
    kv.put = async (...a) => { if (failNext) { failNext = false; throw new Error("KV write failed"); } return realPut(...a); };
    const env = { CONFIGS: kv };
    const bp = { style: "s", tag: "t", lang: "en", rs: "1" };

    await noteBetterPosterVariant(env, bp); // write fails
    assert.equal(kv._store.get("bp:variants:v1"), undefined);
    await noteBetterPosterVariant(env, bp); // must try again, not wait six hours
    assert.ok(JSON.parse(kv._store.get("bp:variants:v1"))["s|t|en|1"], "the variant was never retried");
  });

  it("does not hit KV again for a variant just noted", async () => {
    const { noteBetterPosterVariant } = await load();
    const kv = makeKv();
    let puts = 0;
    const realPut = kv.put.bind(kv);
    kv.put = async (...a) => { puts++; return realPut(...a); };
    const env = { CONFIGS: kv };
    const bp = { style: "s", tag: "t", lang: "en", rs: "1" };
    await noteBetterPosterVariant(env, bp);
    await noteBetterPosterVariant(env, bp);
    assert.equal(puts, 1);
  });
});
