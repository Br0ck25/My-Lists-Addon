import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { call, createUser, makeD1, makeEnv } from "./harness.mjs";

// PERF-02 (audit 2026-11-10): on the older tracking storage (no activity database), a save
// upserted EVERY Watch History entry, so one play cost one row write per play ever made.
// Only entries that are new or changed may be written.

function history(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `tt${5000000 + i}`, type: "movie", name: `Film ${i}`, watchedAt: 1700000000000 + i }));
}

async function save(env, user, watchHistory) {
  const r = await call(env, "/api/creator/sync/save-tracking", {
    method: "POST",
    json: { creatorName: user.creatorName, creatorKey: user.creatorKey, watchHistory },
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await new Promise((res) => setTimeout(res, 100)); // the D1 copy is written after the reply
}

// Counts the watch_history upsert statements that were actually run.
function countWrites(env) {
  const counter = { n: 0 };
  const batch = env.DB.batch.bind(env.DB);
  env.DB.batch = async (stmts) => {
    counter.n += stmts.filter((s) => /INSERT INTO watch_history\b/i.test(String(s._spec?.sql))).length;
    return batch(stmts);
  };
  return counter;
}

describe("PERF-02: the legacy tracking write only touches what changed", () => {
  it("a play added to a 300-entry history writes one watch_history row, not 301", async () => {
    const env = makeEnv({ DB: makeD1() });
    const user = await createUser(env, "legacyping");
    const base = history(300);
    await save(env, user, base);
    const c = countWrites(env);
    await save(env, user, [{ id: "tt9999999", type: "movie", name: "New play", watchedAt: 1800000000000 }, ...base]);
    assert.equal(c.n, 1, `wrote ${c.n} watch_history rows for one new play`);
    const rows = await env.DB.prepare("SELECT count(*) AS n FROM watch_history WHERE username = ?").bind(user.creatorName).first();
    assert.equal(rows.n, 301);
  });

  it("an entry whose details changed is still rewritten", async () => {
    const env = makeEnv({ DB: makeD1() });
    const user = await createUser(env, "legacyedit");
    const base = history(100);
    await save(env, user, base);
    const c = countWrites(env);
    await save(env, user, base.map((h, i) => (i === 2 ? { ...h, name: "Renamed" } : h)));
    assert.equal(c.n, 1);
    const row = await env.DB.prepare("SELECT title FROM watch_history WHERE username = ? AND item_id = ?").bind(user.creatorName, base[2].id).first();
    assert.equal(row.title, "Renamed");
  });
});
