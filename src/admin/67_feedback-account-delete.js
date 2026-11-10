// Deleting an account deletes the support/feedback threads filed under its
// username (audit SEC-04, owner decision 2026-11-10): the D1 row and the KV
// copy. A reset keeps them (detachFeedbackThreadsFromCreator, 03_admin.js, is
// still what runs for that). Throws if one could not be deleted, so the caller
// does not free the username. Returns how many were deleted.
async function deleteFeedbackThreadsFromCreator(env, username) {
  const name = String(username || "").trim().toLowerCase();
  let deleted = 0;
  if (!name) return deleted;
  // Each round takes up to FEEDBACK_CREATOR_THREAD_CAP; the ceiling only stops
  // a loop that somehow makes no progress.
  for (let round = 0; round < 20; round++) {
    const entries = await findFeedbackThreadsByCreator(env, name, { strict: true });
    if (!entries.length) break;
    for (const entry of entries) {
      if (env.DB) await env.DB.prepare("DELETE FROM feedback WHERE id = ?").bind(entry.id).run();
      if (env.CONFIGS) await env.CONFIGS.delete(`feedback:${entry.id}`);
      deleted++;
    }
    // Without a database the KV scan is the only lookup and it is one pass.
    if (!env.DB) break;
  }
  return deleted;
}
