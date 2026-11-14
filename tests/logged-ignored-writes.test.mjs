// CQ-07: a best-effort KV write that fails must leave a trace in the logs
// instead of vanishing in an empty catch. The request itself must still succeed
// (the write is best-effort), so the test checks both halves.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, makeD1, makeKv, call, accountProof } from "./harness.mjs";

describe("ignored KV write failures are logged", () => {
  it("logs a failed schedule save but still serves the schedule", async () => {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
    const proof = await accountProof(env, "logw1");
    await call(env, "/api/save", { method: "POST", json: { ...proof, entries: [{ id: "custom_movie_list", name: "Movies", type: "movie" }] } });
    await env.CONFIGS.put("creatorsyncchannels:logw1", JSON.stringify({
      channels: { ch_a: { id: "ch_a", channelId: "ch_a", name: "A", items: [{ kind: "movie", imdbId: "tt0133093", title: "The Matrix", runtime: 136 }] } },
      updatedAt: Date.now(),
    }));
    env.CONFIGS._hooks.beforePut = async (key) => { if (key.startsWith("nuviotvsched:")) throw new Error("kv down"); };
    const logged = [];
    const realWarn = console.warn;
    console.warn = (...a) => logged.push(a.map(String).join(" "));
    try {
      const res = await call(env, "/api/nuvio-tv/schedule/logw1/ch_a");
      assert.equal(res.status, 200);
      assert.ok(res.body.slots.length > 0, "the schedule is still served");
    } finally {
      console.warn = realWarn;
    }
    assert.ok(logged.some((l) => l.includes("kv down") && l.includes("nuviotvsched")), `expected a logged failure, got: ${JSON.stringify(logged)}`);
  });
});
