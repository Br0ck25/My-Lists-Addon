// --- media.retry: titles TMDB could not place yet, tried again ----------------
//
// The list copy (P3b-3), the history copy (P3c-3) and every list save keep a
// title TMDB could not place -- or was not asked about, because the step's
// lookup budget ran out -- as a stub: a media row with resolved_at NULL that
// keeps the id and name it came with (29_media.js). Nothing is lost by that:
// a list item is rebuilt exactly as it was saved either way. What waits on the
// match is the work that needs a TMDB id: the show schedule (46_), canonical
// ids (43_), recommendations (53_).
//
// retryUnresolvedMedia tries the oldest stubs again, and nothing called it.
// On the live site the two copies left 13,631 list titles and 7,373 watched
// titles as stubs (docs/RELEASES.md, Releases 4 and 5). This job asks TMDB
// about MEDIA_RETRY_PER_RUN of them an hour. A stub TMDB still does not know
// waits MEDIA_RETRY_AFTER_MS before it is asked again, so once the ones TMDB
// can place are done the job costs next to nothing.
//
// Without the queue the cron runs it itself, like every periodic job (the
// dispatcher's fallback, 45_). Without migration 0016 or a TMDB key it does
// nothing.
//
// Module level, after the Worker's exports, like 27_ onward.

const MEDIA_RETRY_EVERY_MS = 60 * 60 * 1000;
const MEDIA_RETRY_PER_RUN = 200;
const MEDIA_RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

async function runMediaRetry(env, job = {}) {
  const progress = { ...(job.progress || {}) };
  const tmdbKey = (env && env.TMDB_API_KEY) || TMDB_API_KEY;
  if (!env || !env.DB || !tmdbKey) return { progress };
  let out;
  try {
    out = await retryUnresolvedMedia(env, { limit: MEDIA_RETRY_PER_RUN, tmdbKey, retryAfterMs: MEDIA_RETRY_AFTER_MS });
  } catch (err) {
    // No media table yet (migration 0016): nothing to retry.
    if (/no such table/i.test(jobErrorText(err))) return { progress };
    throw err;
  }
  return {
    progress: {
      ...progress,
      lastRun: { at: Date.now(), tried: out.tried, resolved: out.resolved },
      totalResolved: (Number(progress.totalResolved) || 0) + out.resolved,
    },
  };
}

definePeriodicJob("media.retry", {
  everyMs: MEDIA_RETRY_EVERY_MS,
  run: (env, payload, job) => runMediaRetry(env, job),
});
