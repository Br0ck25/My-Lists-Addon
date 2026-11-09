// Nuvio's rate limit and error answers (public API: 100 requests per second per
// user as a client-side guideline; 429 when limited; 409 duplicate key; 422
// unprocessable). A 429 is waited out and tried again, which is safe for the
// writes too: a refused request was not applied. Anything still refused after
// NUVIO_RETRIES waits becomes a message the settings page can show.

const NUVIO_RETRIES = 3;
const NUVIO_RETRY_MAX_MS = 3000;

// Waits before trying again: Nuvio's Retry-After (seconds) if it sent one, else
// 0.4 s, 0.8 s, 1.6 s; never more than NUVIO_RETRY_MAX_MS.
async function nuvioBackoff(res, attempt) {
  const asked = Number(res.headers && res.headers.get && res.headers.get("retry-after"));
  const ms = Number.isFinite(asked) && asked >= 0 ? asked * 1000 : 400 * 2 ** attempt;
  const wait = Math.min(ms, NUVIO_RETRY_MAX_MS);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

// The error for a Nuvio answer that is not a success, in words. nuvioStatus marks
// it as one of these so the pull can show the message.
function nuvioStatusError(status) {
  let message = `Nuvio answered ${status}.`;
  if (status === 429) message = "Nuvio is busy. It will try again.";
  else if (status === 409) message = "Nuvio reported a conflict with something already saved. It will try again.";
  else if (status === 422) message = "Nuvio could not accept that data.";
  const e = mediaAppError("unreachable", message);
  e.nuvioStatus = status;
  return e;
}
