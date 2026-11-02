
// --- BetterPosters in R2, fetched by a job (Phase 5, P5-9) ----------------------
//
// Better Posters are drawn by btttr.cc, which can take 40 to 55 seconds for a
// poster it has not drawn lately. Until now this Worker kept its copies in KV
// (`bpimg:v1:`), and a poster it did not have yet was fetched while the tile
// (or the website's warm-up call) waited, up to BETTER_POSTER_PAGE_WAIT_MS.
//
// With both the BLOBS bucket and the JOBS queue bound, no request waits on
// btttr.cc any more (betterPostersInR2):
//   - copies live in R2, at img/bp/{style}/{imdb}/{tag}.{lang}.{rs}.jpg, with
//     their content type and fetch time as custom metadata. A copy still in KV
//     is served, and copied to R2 in the background;
//   - a poster with no copy is answered at once (an app gets the title's
//     ordinary poster from the same URL, the website its own stand-in, as
//     before) and a `poster.fetch` job is sent for it. A copy more than a day
//     old is served and refreshed the same way;
//   - the website's warm-up call (/api/bp/warm) reports what is stored and
//     sends the rest to the job.
// A poster is sent at most once per isolate every POSTER_FETCH_RESEND_MS, and
// btttr.cc's recent misses (the edge-cache note) are not sent again.
//
// Without either binding nothing changes: KV copies, fetched on the request,
// as before. The KV keys (bpimg:v1:, bp:retry:v1, bp:variants:v1,
// bp:sharedids:v1) and the cron's warm-up (prewarmBetterPosters, which now
// stores into R2 when this is on) are deleted once the owner has turned this
// on for good.
//
// Module level, after the Worker's exports, like 27_ onward.

const POSTER_FETCH_JOB_TYPE = "poster.fetch";
const POSTER_FETCH_PER_JOB = 10;
const POSTER_FETCH_RESEND_MS = 10 * 60 * 1000;
const POSTER_FETCH_SENT = new Map(); // bp.path -> when this isolate last sent it

function betterPostersInR2(env) {
  return !!(env && env.BLOBS && typeof env.BLOBS.put === "function" && jobsQueueBound(env));
}

function betterPosterR2Key(bp) {
  return `img/bp/${bp.style}/${bp.imdbId}/${bp.tag || "-"}.${bp.lang || "-"}.${bp.rs || "-"}.jpg`;
}

async function storeBetterPosterR2(env, bp, bytes, contentType) {
  await env.BLOBS.put(betterPosterR2Key(bp), bytes, {
    httpMetadata: { contentType: contentType || "image/jpeg" },
    customMetadata: { ct: contentType || "image/jpeg", at: String(Date.now()) },
  });
}

// The stored copy: R2, else a KV copy from before (copied over in the
// background). A copy more than a day old is refreshed by a job.
async function readBetterPosterR2(env, ctx, bp) {
  const background = (p) => { if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p); };
  try {
    const obj = await env.BLOBS.get(betterPosterR2Key(bp));
    if (obj) {
      const m = obj.customMetadata || {};
      const at = Number(m.at) || 0;
      if (Date.now() - at > BETTER_POSTER_REFRESH_MS) background(sendBetterPosterFetch(env, bp));
      return { bytes: await obj.arrayBuffer(), contentType: m.ct || (obj.httpMetadata && obj.httpMetadata.contentType) || "image/jpeg", at };
    }
  } catch {
    // R2 unavailable: try the KV copy.
  }
  if (!env.CONFIGS) return null;
  try {
    const got = await env.CONFIGS.getWithMetadata(bp.kvKey, { type: "arrayBuffer" });
    if (!got || !got.value) return null;
    const meta = got.metadata || {};
    const at = Number(meta.at) || 0;
    background(storeBetterPosterR2(env, bp, got.value, meta.ct).catch(() => {}));
    if (Date.now() - at > BETTER_POSTER_REFRESH_MS) background(sendBetterPosterFetch(env, bp));
    return { bytes: got.value, contentType: meta.ct || "image/jpeg", at };
  } catch {
    return null;
  }
}

// Sends a poster.fetch job for one poster, unless this isolate sent it
// lately. Never throws.
async function sendBetterPosterFetch(env, bp) {
  const now = Date.now();
  const last = POSTER_FETCH_SENT.get(bp.path);
  if (last && now - last < POSTER_FETCH_RESEND_MS) return false;
  if (POSTER_FETCH_SENT.size > 5000) POSTER_FETCH_SENT.clear();
  POSTER_FETCH_SENT.set(bp.path, now);
  const sent = await enqueueJob(env, POSTER_FETCH_JOB_TYPE, { paths: [bp.path] });
  return sent.ok;
}

// The job: fetches each poster from btttr.cc (with its own long timeout) into
// R2, a few at a time. A poster stored less than a day ago is skipped; one
// btttr.cc could not supply is noted as a miss, as on the request path.
async function runPosterFetch(env, payload) {
  const out = { posters: 0, fetched: 0, fresh: 0, failed: 0 };
  const bps = [];
  for (const raw of (Array.isArray(payload.paths) ? payload.paths : []).slice(0, POSTER_FETCH_PER_JOB)) {
    let u;
    try {
      u = new URL(String(raw), "https://x.invalid");
    } catch {
      continue;
    }
    const bp = parseBetterPosterPath(u.pathname, u.searchParams);
    if (bp) bps.push(bp);
  }
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, bps.length) }, async () => {
    while (next < bps.length) {
      const bp = bps[next++];
      out.posters++;
      try {
        const head = await env.BLOBS.head(betterPosterR2Key(bp));
        const at = head && head.customMetadata ? Number(head.customMetadata.at) || 0 : 0;
        if (head && Date.now() - at <= BETTER_POSTER_REFRESH_MS) {
          out.fresh++;
          continue;
        }
      } catch {
        // Fetch it anyway.
      }
      if (await fetchBetterPosterUpstream(env, bp, BETTER_POSTER_UPSTREAM_TIMEOUT_MS)) out.fetched++;
      else out.failed++;
    }
  }));
  return out;
}

defineJobType(POSTER_FETCH_JOB_TYPE, {
  run: (env, payload) => runPosterFetch(env, payload),
});
