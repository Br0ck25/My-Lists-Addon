// getCreator (02_http-and-creator-utils.js) reads an account from D1 and keeps
// a copy in KV as a fallback for the day D1 errors. It used to write that copy
// on EVERY read: each catalog request for a signed-in install, and each call to
// /api/creator/*, was one billed KV write of a record that had not changed
// (about $5 per million). It now writes when the record is new or has changed,
// and otherwise at most once an hour per account per isolate.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeKv, makeD1, makeEnv, call, createUser } from "./harness.mjs";

async function setup() {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
  const user = await createUser(env, "mirror" + Math.random().toString(36).slice(2, 8));
  await env.CONFIGS.put("cfg:mir1", JSON.stringify({
    trackCreatorName: user.creatorName, trackCreatorKey: user.creatorKey,
    entries: [{ id: "shared", type: "movie", name: "Shared", enabled: true, url: "https://example.test/lists/someone/some-list" }],
  }));
  const puts = [];
  env.CONFIGS._hooks.beforePut = async (k) => { puts.push(k); };
  return { env, user, puts };
}

describe("the KV copy of an account", () => {
  it("is not rewritten by every catalog request when nothing changed", async () => {
    const { env, user, puts } = await setup();
    for (let i = 0; i < 5; i++) {
      const res = await call(env, "/mir1/catalog/movie/shared.json");
      assert.equal(res.status, 200);
    }
    const writes = puts.filter((k) => k === `creator:${user.creatorName}`);
    assert.ok(writes.length <= 1, `5 reads of an unchanged account wrote its KV copy ${writes.length} times`);
  });

  it("is still written when the account's record changes", async () => {
    const { env, user, puts } = await setup();
    await call(env, "/mir1/catalog/movie/shared.json");
    puts.length = 0;
    await env.DB.prepare("UPDATE creators SET display_name = ? WHERE username = ?").bind("Renamed", user.creatorName).run();
    await call(env, "/mir1/catalog/movie/shared.json");
    assert.ok(puts.includes(`creator:${user.creatorName}`), "a changed record must reach the KV fallback copy");
  });
});

// One request reading the same KV key twice paid for two reads of one answer
// (a shared list's record was read twice, an account's tracking record up to
// three times). The wrapper in instrumentEnv now answers a repeat from the first
// read, within that request only -- a later request always reads KV afresh, and
// a write to the key in between clears it.
describe("repeated KV reads inside one request", () => {
  it("a catalog request reads each key once", async () => {
    const { env } = await setup();
    const reads = [];
    env.CONFIGS._hooks.beforeGet = async (k) => { reads.push(k); };
    const res = await call(env, "/mir1/catalog/movie/shared.json");
    assert.equal(res.status, 200);
    const dupes = reads.filter((k, i) => reads.indexOf(k) !== i);
    assert.deepEqual(dupes, [], "keys read more than once in one request");
  });

  it("a later request still reads KV afresh", async () => {
    const { env } = await setup();
    const reads = [];
    env.CONFIGS._hooks.beforeGet = async (k) => { reads.push(k); };
    await call(env, "/mir1/catalog/movie/shared.json");
    const first = reads.length;
    await call(env, "/mir1/catalog/movie/shared.json");
    assert.equal(reads.length, first * 2, "the second request must not be served from the first one's reads");
  });
});
