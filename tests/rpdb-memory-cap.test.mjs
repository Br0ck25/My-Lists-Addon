import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { makeKv } from "./harness.mjs";

// RPDB_USAGE and RPDB_BACKOFF get one entry per distinct RPDB key hash. They
// are per-isolate memory and must not grow without a bound.

async function load() {
  const src = readFileSync(new URL("../worker_entry_combined.js", import.meta.url), "utf8");
  const file = `${tmpdir()}/mla-rpdbcap-${process.pid}-${Date.now()}.mjs`;
  writeFileSync(file, src + "\nexport { RPDB_USAGE, RPDB_BACKOFF, rpdbUsage, rpdbFetchUpstream };\n");
  try { return await import(pathToFileURL(file).href); } finally { unlinkSync(file); }
}

describe("RPDB per-isolate maps stay bounded", () => {
  it("RPDB_USAGE does not grow past its cap, and still answers", async () => {
    const m = await load();
    const kv = makeKv();
    for (let i = 0; i < 1100; i++) {
      kv._store.set(`rpdb:usage:v1:h${i}`, JSON.stringify({ req: 1, limit: 100, at: Date.now() }));
    }
    for (let i = 0; i < 1100; i++) {
      const u = await m.rpdbUsage({ CONFIGS: kv }, "k", "h" + i);
      assert.equal(u.limit, 100);
    }
    assert.ok(m.RPDB_USAGE.size <= 1000, "size was " + m.RPDB_USAGE.size);
    assert.ok(m.RPDB_USAGE.size > 0, "the newest entries are kept");
  });

  it("RPDB_BACKOFF does not grow past its cap", async () => {
    const m = await load();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("", { status: 429 });
    try {
      for (let i = 0; i < 1100; i++) await m.rpdbFetchUpstream({ CONFIGS: makeKv() }, { waitUntil() {} }, "k", "b" + i, "tt0000001");
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.ok(m.RPDB_BACKOFF.size <= 1000, "size was " + m.RPDB_BACKOFF.size);
    assert.ok(m.RPDB_BACKOFF.size > 0);
  });
});
