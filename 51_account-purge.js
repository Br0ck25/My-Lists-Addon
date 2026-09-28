
// --- Account deletion: account.purge (Phase 5, P5-8) ----------------------------
//
// Deleting an account used to be one long request (/api/creator/delete-account,
// purgeCreatorData): every KV key, every D1 table, then the identity. A person
// waited on it, and a failure part way left them to retry by hand.
//
//   DELETE /api/me  { confirm: "DELETE" }  (signed in with a session)
//     At once: the username is tombstoned (it stops authenticating and cannot
//     be registered again while the purge runs), `accounts.deleted_at` is set,
//     every session is revoked, every install link is revoked (and its
//     snapshot forgotten), and an `account.purge` job is started. 202.
//
//   account.purge (one-off job, dedupe key account.purge:{id})
//     The same complete sweep as before, purgeCreatorData with the identity,
//     which now also clears the account's rows in the v2 and activity tables
//     (purgeAccountRowsById, below, through deleteAccountRow). A sweep that
//     did not finish throws, and the job tries again; the tombstone keeps the
//     username out of reach meanwhile. The legacy KV sweep stays inside
//     purgeCreatorData until Phase 10 retires those keys.
//
// purgeAccountRowsById is what makes a deleted account's id safe to reuse.
// `accounts.id` is an INTEGER PRIMARY KEY without AUTOINCREMENT, so SQLite
// hands the highest deleted id to the next account created, and everything
// filed under the number (watch history in the activity database above all)
// would otherwise belong to whoever registers next. deleteAccountRow calls it
// before the accounts row goes, on every path that removes one: this job, the
// old delete-account route, and the clean-up before a username is registered
// again (which stays, as the last line of defence).
//
// Module level, after the Worker's exports, like 27_ onward.

const ACCOUNT_PURGE_JOB_TYPE = "account.purge";

// Every row filed under an account id outside the tables deleteAccountRow and
// listsV2PurgeAccount already clear: the activity database, likes it cast (the
// counts they added are taken back), recommendations, list preferences,
// presets, its private channels (and their R2 pools; shared ones stay, with no
// owner), and its other jobs. { ok }. Missing tables are skipped.
async function purgeAccountRowsById(env, accountId) {
  const id = Number(accountId);
  if (!env || !env.DB || !Number.isInteger(id) || id <= 0) return { ok: true };
  let ok = true;
  const run = async (label, fn) => {
    try {
      await fn();
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (/no such table/i.test(msg)) return;
      console.error(`[AccountPurge] ${label} failed for account ${id}:`, err);
      ok = false;
    }
  };

  // Watch history and progress, in the account's activity database.
  const actDb = typeof activityDb === "function" ? activityDb(env, id) : null;
  if (actDb) {
    await run("activity", () => actDb.batch([
      actDb.prepare("DELETE FROM watch_events WHERE account_id = ?").bind(id),
      actDb.prepare("DELETE FROM show_progress WHERE account_id = ?").bind(id),
      actDb.prepare("DELETE FROM user_media_state WHERE account_id = ?").bind(id),
    ]));
  }

  const voter = `acct:${id}`;
  await run("likes", () => env.DB.batch([
    env.DB.prepare(
      "UPDATE lists SET like_count = max(0, like_count - 1) WHERE public_id IN (SELECT target_id FROM likes WHERE voter = ? AND target_type = 'list')"
    ).bind(voter),
    env.DB.prepare(
      "UPDATE channels SET like_count = max(0, like_count - 1) WHERE public_code IN (SELECT target_id FROM likes WHERE voter = ? AND target_type = 'channel')"
    ).bind(voter),
    env.DB.prepare(
      "UPDATE channels SET add_count = max(0, add_count - 1) WHERE public_code IN (SELECT target_id FROM likes WHERE voter = ? AND target_type = 'channel_add')"
    ).bind(voter),
    env.DB.prepare("DELETE FROM likes WHERE voter = ?").bind(voter),
  ]));

  await run("recommendations", () => env.DB.prepare("DELETE FROM account_recommendations WHERE account_id = ?").bind(id).run());
  await run("preferences", () => env.DB.batch([
    env.DB.prepare("DELETE FROM account_list_prefs WHERE account_id = ?").bind(id),
    env.DB.prepare("DELETE FROM presets WHERE account_id = ?").bind(id),
  ]));

  await run("channels", async () => {
    const { results } = await env.DB.prepare(
      "SELECT id, public_code FROM channels WHERE owner_account_id = ? AND visibility = 'private'"
    ).bind(id).all();
    for (const ch of results || []) {
      if (env.BLOBS && typeof env.BLOBS.list === "function") {
        const listed = await env.BLOBS.list({ prefix: `channels/${ch.public_code}/` });
        const keys = ((listed && listed.objects) || []).map((o) => o.key);
        if (keys.length) await env.BLOBS.delete(keys);
      }
      await env.DB.batch([
        env.DB.prepare("DELETE FROM likes WHERE target_type IN ('channel', 'channel_add') AND target_id = ?").bind(ch.public_code),
        env.DB.prepare("DELETE FROM channels WHERE id = ?").bind(ch.id),
      ]);
    }
    // Shared and published channels stay for the people who added them.
    await env.DB.prepare("UPDATE channels SET owner_account_id = NULL WHERE owner_account_id = ?").bind(id).run();
  });

  await run("jobs", () => env.DB.prepare(
    "DELETE FROM jobs WHERE account_id = ? AND type != ?"
  ).bind(id, ACCOUNT_PURGE_JOB_TYPE).run());

  return { ok };
}

async function writeDeletionTombstone(env, username) {
  try {
    await env.CONFIGS.put(creatorTombstoneKey(username), "1", { expirationTtl: CREATOR_TOMBSTONE_TTL_SEC });
  } catch (e) {
    console.error("[AccountPurge] could not write the KV tombstone:", e);
  }
  if (env.DB) {
    try {
      await env.DB.prepare(
        "INSERT INTO creator_tombstones (username, until) VALUES (?, ?) ON CONFLICT(username) DO UPDATE SET until = excluded.until"
      ).bind(username, Date.now() + CREATOR_TOMBSTONE_TTL_SEC * 1000).run();
    } catch (e) {
      console.error("[AccountPurge] could not write the D1 tombstone:", e);
    }
  }
}

async function runAccountPurge(env, payload) {
  const username = String(payload.username || "").trim().toLowerCase();
  if (!username) return;
  // The username stays out of reach while this runs, however many tries it
  // takes.
  await writeDeletionTombstone(env, username);
  const purged = await purgeCreatorData(env, username, { deleteIdentity: true });
  if (!purged.ok) throw new Error("The account's data could not all be removed yet.");
  // deleteAccountRow (inside the purge) removed the accounts row by name. An
  // account renamed or already gone is still cleared by its id.
  const leftover = await purgeAccountRowsById(env, payload.accountId);
  if (!leftover.ok) throw new Error("Some of the account's rows could not be removed yet.");
  console.log(`[AccountPurge] account ${payload.accountId} removed (${purged.listsCleared} lists, ${purged.keysCleared} keys).`);
}

defineDurableJob(ACCOUNT_PURGE_JOB_TYPE, {
  // Tried for about a day before it gives up and the admin has to look.
  maxAttempts: 12,
  run: (env, payload) => runAccountPurge(env, payload),
});

// DELETE /api/me
async function handleAccountDeleteApi(request, env, url, path) {
  if (path !== "/api/me" || request.method !== "DELETE") return null;
  const account = request.account || null;
  if (!account) return json({ ok: false, error: "Sign in to delete your account.", signInRequired: true }, 401);
  if (!env || !env.DB || !env.CONFIGS) return json({ ok: false, error: "Accounts aren't available right now." }, 503);
  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  if (String((body && body.confirm) || "") !== "DELETE") return json({ ok: false, error: "Missing confirmation." }, 400);
  const username = String(account.username || "").toLowerCase();
  const now = Date.now();

  await writeDeletionTombstone(env, username);
  try {
    await env.DB.prepare("UPDATE accounts SET deleted_at = ? WHERE id = ?").bind(now, account.id).run();
  } catch (e) {
    console.error("[AccountPurge] could not mark the account deleted:", e);
  }
  await revokeAccountSessions(env, account.id);
  // Revoked first, then their snapshots forgotten, so a request in between
  // cannot put a live copy back.
  try {
    await env.DB.prepare("UPDATE installs SET revoked_at = ?, version = version + 1, updated_at = ? WHERE account_id = ? AND revoked_at IS NULL").bind(now, now, account.id).run();
  } catch (e) {
    if (!/no such table/i.test(String((e && e.message) || e))) console.error("[AccountPurge] could not revoke install links:", e);
  }
  if (typeof forgetAccountInstallSnapshots === "function") await forgetAccountInstallSnapshots(env, account.id);

  const payload = { accountId: account.id, username };
  const created = await createJob(env, ACCOUNT_PURGE_JOB_TYPE, { dedupeKey: `${ACCOUNT_PURGE_JOB_TYPE}:${account.id}`, accountId: account.id, payload });
  request._sessionCookie = buildClearSessionCookieHeader();
  if (created.ok) return json({ ok: true, deleting: true, id: created.id }, 202);

  // No jobs table (migration 0016 not applied): the purge runs now, as the
  // old route did.
  try {
    await runAccountPurge(env, payload);
    return json({ ok: true, deleting: false });
  } catch (e) {
    console.error("[AccountPurge] inline purge failed:", e);
    return json({ ok: false, error: "Couldn't finish deleting this account. Some of it is still being removed; nothing more is needed from you." }, 500);
  }
}
