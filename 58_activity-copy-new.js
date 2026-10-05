
// --- New accounts' history copy: activity.copy-new (Release 17) ------------------
//
// With FF_EVENT_TRACKING on, an account is served from the activity database
// once its history copy (migrate.activity, 37_activity-backfill.js) is done.
// The copy only ever ran when an operator pressed it, so an account made after
// it finished stayed on the legacy stores (39 of 748 accounts, 2026-10-04).
// This hourly job runs copy steps for them: runActivityBackfillStep picks up
// accounts made after a finished run, and is a single cheap count when there
// are none. Up to ACTIVITY_COPY_NEW_STEPS steps a run.
//
// Module level, after the Worker's exports, like 27_ onward.

const ACTIVITY_COPY_NEW_EVERY_MS = 60 * 60 * 1000;
const ACTIVITY_COPY_NEW_STEPS = 3;

async function runActivityCopyNew(env, job = {}) {
  const progress = { ...(job.progress || {}) };
  if (!env || !env.DB || typeof isEventTrackingEnabled !== "function" || !isEventTrackingEnabled(env)) {
    return { progress, skipped: "FF_EVENT_TRACKING is off" };
  }
  let out = null;
  for (let i = 0; i < ACTIVITY_COPY_NEW_STEPS; i++) {
    out = await runActivityBackfillStep(env, {});
    if (!out || !out.ok || out.done) break;
  }
  return {
    progress: {
      ...progress,
      lastRun: {
        at: Date.now(),
        ok: !!(out && out.ok),
        done: !!(out && out.done),
        accountsDone: out ? out.accountsDone : null,
        accountsTotal: out ? out.accountsTotal : null,
        error: out && !out.ok ? out.error || null : null,
      },
    },
  };
}

definePeriodicJob("activity.copy-new", {
  everyMs: ACTIVITY_COPY_NEW_EVERY_MS,
  run: (env, payload, job) => runActivityCopyNew(env, job),
});
