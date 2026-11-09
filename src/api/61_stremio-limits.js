// Stremio's rate-limit and error answers, the same handling Nuvio gets (61_nuvio-limits.js).
// Stremio's API (api.strem.io) states no limits, so this is ordinary good manners: a 429 is
// waited out and tried again (a refused request was not applied, so a write is safe to repeat),
// and what still fails is said in words on the settings card instead of "Stremio answered 429".

// The error for a Stremio answer that is not a success. stremioStatus marks it as one of these.
function stremioStatusError(status) {
  let message = `Stremio answered ${status}.`;
  if (status === 429) message = "Stremio is busy. It will try again.";
  else if (status >= 500) message = `Stremio had a problem (${status}). It will try again.`;
  const e = mediaAppError("unreachable", message);
  e.stremioStatus = status;
  return e;
}

// What to show on the settings card for a failed read of this app, or null to show nothing.
async function mediaAppFailureMessage(env, provider, e) {
  if (provider === "nuvio") return nuvioFailureMessage(env, e);
  return e && e.stremioStatus ? e.message : null;
}
