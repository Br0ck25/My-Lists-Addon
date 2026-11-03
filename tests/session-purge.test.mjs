// SEC-06: expired and revoked sign-in sessions (each keeps a user agent and
// timestamps) are deleted a week after they stopped being usable. A live
// session and a just-revoked one stay, so Settings' session list is unchanged.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createUser, drainQueue, makeD1, makeEnv, makeKv, makeQueue, runScheduledTick } from "./harness.mjs";

const DAY = 86400000;

async function runPeriodic(env, type) {
  await runScheduledTick(env);
  env.DB._db.exec("UPDATE jobs SET run_after = 9999999999999 WHERE dedupe_key LIKE 'periodic:%'");
  env.DB._db.prepare("UPDATE jobs SET run_after = 1 WHERE dedupe_key = ?").run(`periodic:${type}`);
  env.JOBS._pending.length = 0;
  await runScheduledTick(env);
  env.JOBS._pending.splice(0, env.JOBS._pending.length, ...env.JOBS._pending.filter((m) => m.body.type === type));
  return drainQueue(env, { rounds: 20 });
}

async function setup() {
  const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), JOBS: makeQueue() });
  await createUser(env, "sessionowner");
  const id = env.DB._db.prepare("SELECT id FROM accounts WHERE username = 'sessionowner'").get().id;
  const now = Date.now();
  const add = (hash, expiresAt, revokedAt) => env.DB._db
    .prepare("INSERT INTO sessions (id_hash, account_id, created_at, last_seen_at, expires_at, user_agent, revoked_at) VALUES (?, ?, ?, ?, ?, 'UA', ?)")
    .run(hash, id, now - 90 * DAY, now - 40 * DAY, expiresAt, revokedAt);
  add("live", now + 10 * DAY, null);
  add("expired-long-ago", now - 8 * DAY, null);
  add("expired-yesterday", now - 1 * DAY, null);
  add("revoked-long-ago", now + 10 * DAY, now - 8 * DAY);
  add("revoked-just-now", now + 10 * DAY, now - 1000);
  return { env, left: () => env.DB._db.prepare("SELECT id_hash FROM sessions ORDER BY id_hash").all().map((r) => r.id_hash) };
}

describe("SEC-06: sessions.purge", () => {
  it("deletes sessions expired or revoked more than 7 days ago and keeps the rest", async () => {
    const { env, left } = await setup();
    await runPeriodic(env, "sessions.purge");
    assert.deepEqual(left(), ["expired-yesterday", "live", "revoked-just-now"]);
  });

  it("works through more rows than one batch holds", async () => {
    const { env, left } = await setup();
    const id = env.DB._db.prepare("SELECT id FROM accounts WHERE username = 'sessionowner'").get().id;
    const ins = env.DB._db.prepare("INSERT INTO sessions (id_hash, account_id, created_at, last_seen_at, expires_at) VALUES (?, ?, 1, 1, ?)");
    for (let i = 0; i < 1200; i++) ins.run("old" + i, id, Date.now() - 30 * DAY);
    await runPeriodic(env, "sessions.purge");
    assert.deepEqual(left(), ["expired-yesterday", "live", "revoked-just-now"]);
  });
});
