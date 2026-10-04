// Fixes from the 2026-10-04 review of the Phase 8-10 work.
//
//  - ensureTrackingMigrated (05_catalog-core.js) was emptied by P10-4. An
//    account whose tracking still sat inside creatorsync:{username} then lost
//    it on its first autosave, because /api/creator/sync/save writes that record
//    without the tracking fields.
//  - sync/load's sunset_notices were sent but never shown. The page shows the
//    one a visitor can act on, once per browser session.
//  - wrangler.toml names the live Worker, so a plain `wrangler deploy` must not
//    be able to drop its dashboard variables or its activity database.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { call, createUser, makeEnv } from "./harness.mjs";
import { loadClient } from "./client-harness.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

describe("an old account's watch history survives its first autosave", () => {
  it("moves tracking out of creatorsync: before sync/save rewrites it", async () => {
    const env = makeEnv();
    const u = await createUser(env, "oldtracker");
    const history = [{ id: "tt0111161", type: "movie", watchedAt: 1000 }];
    env.CONFIGS._store.delete(`creatorsynctracking:${u.creatorName}`);
    env.CONFIGS._store.set(`creatorsync:${u.creatorName}`, JSON.stringify({
      config: [], updatedAt: 1, watchHistory: history, continueWatching: [], trackPlayback: true,
    }));

    const r = await call(env, "/api/creator/sync/save", {
      method: "POST",
      json: { creatorName: u.creatorName, creatorKey: u.creatorKey, config: [] },
    });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));

    const tracking = JSON.parse(env.CONFIGS._store.get(`creatorsynctracking:${u.creatorName}`) || "null");
    assert.ok(tracking, "the tracking record was written before the save");
    assert.deepEqual(tracking.watchHistory, history);
    assert.equal(tracking.trackPlayback, true);
  });

  it("leaves an account that already has its own tracking record alone", async () => {
    const env = makeEnv();
    const u = await createUser(env, "newtracker");
    const own = { watchHistory: [{ id: "tt1", watchedAt: 5 }], continueWatching: [], updatedAt: 5 };
    env.CONFIGS._store.set(`creatorsynctracking:${u.creatorName}`, JSON.stringify(own));
    env.CONFIGS._store.set(`creatorsync:${u.creatorName}`, JSON.stringify({ config: [], watchHistory: [{ id: "tt-stale" }] }));
    await call(env, "/api/creator/sync/save", {
      method: "POST",
      json: { creatorName: u.creatorName, creatorKey: u.creatorKey, config: [] },
    });
    assert.deepEqual(JSON.parse(env.CONFIGS._store.get(`creatorsynctracking:${u.creatorName}`)).watchHistory, own.watchHistory);
  });
});

describe("sunset notices on the page", () => {
  const NOTICES = [
    { feature: "sync-shims", urgency: "info", daysRemaining: 40, message: "routes going" },
    { feature: "scrobble-legacy-auth", urgency: "urgent", daysRemaining: 5, message: "Update your media server webhook URL." },
  ];

  it("shows only the webhook notice, and only once per session", () => {
    const client = loadClient({});
    const shown = [];
    client.set("showToast", (msg, type) => shown.push({ msg, type }));
    client.call("showSunsetNoticesOnce", NOTICES);
    client.call("showSunsetNoticesOnce", NOTICES);
    assert.deepEqual(shown, [{ msg: "Update your media server webhook URL.", type: "error" }]);
  });

  it("shows nothing when the server sends none, or none for people", () => {
    const client = loadClient({});
    const shown = [];
    client.set("showToast", (msg) => shown.push(msg));
    client.call("showSunsetNoticesOnce", []);
    client.call("showSunsetNoticesOnce", undefined);
    client.call("showSunsetNoticesOnce", [NOTICES[0]]);
    assert.equal(shown.length, 0);
  });
});

describe("wrangler.toml cannot quietly undo the live settings", () => {
  const toml = fs.readFileSync(path.join(REPO_ROOT, "wrangler.toml"), "utf8");
  const top = toml.slice(0, toml.indexOf("[env.staging]"));

  it("keeps the dashboard's variables on deploy", () => {
    assert.match(top, /^keep_vars = true$/m);
  });

  it("binds DB_ACTIVITY, with an id that fails a deploy until it is filled in", () => {
    const block = top.match(/\[\[d1_databases\]\]\s*\nbinding = "DB_ACTIVITY"\s*\ndatabase_name = "mylists-activity"\s*\ndatabase_id = "([^"]+)"/);
    assert.ok(block, "an uncommented DB_ACTIVITY binding");
    assert.doesNotMatch(block[1], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "a placeholder until the owner fills it in");
  });
});
