// Audit BUG-01: one empty entry in a synced config used to make the whole
// username install link answer "not found" (resolveCreatorSyncConfig threw on
// `null.id` and swallowed it). The save now drops entries that are not objects,
// and the read skips any already stored.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeEnv, makeD1, makeKv, call, createUser } from "./harness.mjs";

const good = { id: "trakt-1", name: "Popular", type: "movie", url: "tmdb:chart:popular" };

async function setup() {
  const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv() });
  const user = await createUser(env, "nullentry");
  return { env, user };
}
const save = (env, user, config) => call(env, "/api/creator/sync/save", { method: "POST", json: { creatorName: user.creatorName, creatorKey: user.creatorKey, config } });
const manifest = (env) => call(env, "/nullentry/manifest.json");

describe("BUG-01: bad entries in a synced config", () => {
  it("a save with null and number entries keeps the good row and the install link works", async () => {
    const { env, user } = await setup();
    const r = await save(env, user, [good, null, 5, "x", [1]]);
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    const stored = JSON.parse(env.CONFIGS._store.get("creatorsync:nullentry")).config;
    assert.deepEqual(stored, [good], "only the object entry is stored");
    const m = await manifest(env);
    assert.equal(m.status, 200, JSON.stringify(m.body));
  });

  it("a config already stored with a null entry still serves the manifest", async () => {
    const { env, user } = await setup();
    await save(env, user, [good]);
    const rec = JSON.parse(env.CONFIGS._store.get("creatorsync:nullentry"));
    rec.config = [good, null];
    env.CONFIGS._store.set("creatorsync:nullentry", JSON.stringify(rec));
    const m = await manifest(env);
    assert.equal(m.status, 200, JSON.stringify(m.body));
  });
});
