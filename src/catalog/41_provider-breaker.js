
// --- Provider breaker (Phase 4, P4-4) -----------------------------------------
//
// When a provider goes down, every request that needs it used to wait out the
// timeout (10 s on the catalog paths, 30 s elsewhere) before the cache tiers
// served the last good copy. During an outage that is every request, each one
// holding a Stremio row open and adding load to a provider already in trouble.
//
// The breaker counts consecutive failures per provider, at the one place every
// outbound call goes through (the fetch guard, 02_http-and-creator-utils.js).
// After PROVIDER_BREAKER_THRESHOLD in a row it opens for
// PROVIDER_BREAKER_OPEN_MS: calls to that provider are refused at once with a
// ProviderUnavailable error, which the cache tiers treat like any failure, so
// the last good copy is served straight away. When the time is up the next
// call is let through; one success closes it, one more failure opens it again.
//
//   A failure is: no answer (a network error or a timeout), a 5xx, or a 429.
//   A 401, 403 or 404 is an answer about that request (a wrong key, a title
//   that does not exist), not about the provider, so it closes the count.
//
// Which provider a call belongs to comes from the adapters' hosts
// (PROVIDER_ADAPTERS, 04_config-resolution.js). A call to any other host is
// left alone.
//
// The state lives in this isolate's memory, where the fetch guard can read it
// without waiting. Isolates share it through KV: an isolate that opens a
// breaker writes `pb:{provider}` (60 s, KV's shortest lifetime), and an
// isolate about to serve a catalog row from a provider reads that key, at most
// once a minute per provider, so a provider found to be down in one place is
// skipped everywhere within about a minute. The fetch guard has no `env`, so
// the KV side runs where there is one: the catalog path reads
// (providerBreakerRefresh, from fetchCatalog), and the end of every request
// and cron tick writes (providerBreakerFlush).
//
// Metrics: providerBreakerFlush writes one Analytics Engine point per provider
// at most once a minute per isolate: blobs ["provider", id, "open"|"closed"],
// doubles [calls, failures, refused, latency ms summed, times opened].
//
// Behind FF_PROVIDER_BREAKER (off). Off, the fetch guard does exactly what it
// did before. Module level, after the Worker's exports, like 27_ onward.

const PROVIDER_BREAKER_THRESHOLD = 5;
const PROVIDER_BREAKER_OPEN_MS = 60 * 1000;
const PROVIDER_BREAKER_KV_PREFIX = "pb:";
const PROVIDER_BREAKER_KV_TTL_SEC = 60;
// How often an isolate re-reads one provider's pb: key. KV is eventually
// consistent over about a minute anyway, so reading more often buys nothing.
const PROVIDER_BREAKER_READ_EVERY_MS = 60 * 1000;
const PROVIDER_METRICS_EVERY_MS = 60 * 1000;

const PROVIDER_BREAKERS = new Map(); // provider id -> state (providerBreakerState)
let providerBreakerOn = false;
let providerBreakerHostIndex = null;
let providerMetricsFlushedAt = 0;

function isProviderBreakerEnabled(env) {
  const v = env && env.FF_PROVIDER_BREAKER;
  return v === "1" || v === "true" || v === true;
}

// Called at the start of every request and cron tick, with that invocation's
// env, like applyEnvApiKeys.
function configureProviderBreaker(env) {
  providerBreakerOn = isProviderBreakerEnabled(env);
}

function providerBreakerState(provider) {
  let st = PROVIDER_BREAKERS.get(provider);
  if (!st) {
    st = {
      failures: 0,      // consecutive
      openUntil: 0,
      publish: false,   // opened here, not yet written to KV
      readAt: 0,        // last read of pb:{provider}
      // Since the last metrics point:
      calls: 0, failed: 0, refused: 0, latencyMs: 0, opened: 0,
    };
    PROVIDER_BREAKERS.set(provider, st);
  }
  return st;
}

function providerForHost(host) {
  if (!providerBreakerHostIndex) {
    const index = new Map();
    if (typeof PROVIDER_ADAPTERS === "object" && PROVIDER_ADAPTERS) {
      for (const adapter of Object.values(PROVIDER_ADAPTERS)) {
        for (const h of adapter.hosts || []) index.set(h, adapter.id);
      }
    }
    providerBreakerHostIndex = index;
  }
  return providerBreakerHostIndex.get(String(host || "").toLowerCase()) || null;
}

// The provider an outbound call belongs to, or null (the breaker is off, or
// the host is nobody's). Called by the fetch guard on every call, so it
// returns as early as it can.
function providerBreakerFor(input) {
  if (!providerBreakerOn) return null;
  try {
    const raw = input && typeof input === "object" && typeof input.url === "string" ? input.url : String(input);
    return providerForHost(new URL(raw).hostname);
  } catch {
    return null;
  }
}

function providerBreakerIsOpen(provider, now = Date.now()) {
  const st = PROVIDER_BREAKERS.get(provider);
  return !!st && st.openUntil > now;
}

function providerUnavailableError(provider) {
  const adapter = typeof providerAdapter === "function" ? providerAdapter(provider) : null;
  const err = new Error(`${adapter ? adapter.label : provider} is not answering right now; trying again shortly.`);
  err.name = "ProviderUnavailable";
  err.provider = provider;
  err.breakerOpen = true;
  return err;
}

function isProviderFailureStatus(status) {
  return !status || status >= 500 || status === 429;
}

function providerBreakerRecord(provider, status, latencyMs) {
  const st = providerBreakerState(provider);
  const now = Date.now();
  st.calls++;
  st.latencyMs += Math.max(0, latencyMs || 0);
  if (!isProviderFailureStatus(status)) {
    st.failures = 0;
    return;
  }
  st.failed++;
  st.failures++;
  if (st.failures >= PROVIDER_BREAKER_THRESHOLD && st.openUntil <= now) {
    st.openUntil = now + PROVIDER_BREAKER_OPEN_MS;
    st.opened++;
    st.publish = true;
    console.warn(`[ProviderBreaker] ${provider}: ${st.failures} failures in a row; refusing calls for ${PROVIDER_BREAKER_OPEN_MS / 1000}s.`);
  }
}

// The fetch guard's call for a provider's request. `run` makes the real call.
function providerBreakerFetch(provider, run) {
  const now = Date.now();
  if (providerBreakerIsOpen(provider, now)) {
    providerBreakerState(provider).refused++;
    return Promise.reject(providerUnavailableError(provider));
  }
  let pending;
  try {
    pending = run();
  } catch (err) {
    // A call that could not even be made (a malformed URL) says nothing
    // about the provider.
    return Promise.reject(err);
  }
  return Promise.resolve(pending).then(
    (res) => {
      providerBreakerRecord(provider, res && res.status, Date.now() - now);
      return res;
    },
    (err) => {
      providerBreakerRecord(provider, 0, Date.now() - now);
      throw err;
    },
  );
}

// Before a catalog row calls a provider: take up an open breaker another
// isolate published. At most one KV read per provider per minute; never
// throws, and never delays a row by more than that one read.
async function providerBreakerRefresh(env, provider) {
  if (!providerBreakerOn || !provider || !env || !env.CONFIGS) return;
  if (typeof providerAdapter === "function") {
    const adapter = providerAdapter(provider);
    if (!adapter || !adapter.hosts || !adapter.hosts.length) return;
  }
  const st = providerBreakerState(provider);
  const now = Date.now();
  if (st.openUntil > now || now - st.readAt < PROVIDER_BREAKER_READ_EVERY_MS) return;
  st.readAt = now;
  try {
    const shared = await env.CONFIGS.get(PROVIDER_BREAKER_KV_PREFIX + provider, "json");
    const until = shared ? Number(shared.openUntil) : 0;
    if (until > now && until > st.openUntil) {
      st.openUntil = Math.min(until, now + PROVIDER_BREAKER_OPEN_MS);
      // Someone else's failures: the next trial call after this is judged
      // on its own, like one here after an opening.
      st.failures = Math.max(st.failures, PROVIDER_BREAKER_THRESHOLD);
    }
  } catch {
    // KV unavailable: the breaker works from this isolate's own count.
  }
}

// End of a request or cron tick: publish breakers opened here, and write the
// metrics point when one is due. Cheap when there is nothing to do (no I/O).
async function providerBreakerFlush(env) {
  if (!providerBreakerOn || !env || !PROVIDER_BREAKERS.size) return;
  const now = Date.now();
  const writes = [];
  for (const [provider, st] of PROVIDER_BREAKERS) {
    if (!st.publish) continue;
    st.publish = false;
    if (st.openUntil <= now || !env.CONFIGS) continue;
    writes.push(env.CONFIGS.put(
      PROVIDER_BREAKER_KV_PREFIX + provider,
      JSON.stringify({ openUntil: st.openUntil, failures: st.failures, at: now }),
      { expirationTtl: PROVIDER_BREAKER_KV_TTL_SEC },
    ).catch(() => {}));
  }
  if (writes.length) await Promise.all(writes);
  if (now - providerMetricsFlushedAt < PROVIDER_METRICS_EVERY_MS) return;
  providerMetricsFlushedAt = now;
  const analytics = env.ANALYTICS && typeof env.ANALYTICS.writeDataPoint === "function" ? env.ANALYTICS : null;
  for (const [provider, st] of PROVIDER_BREAKERS) {
    if (!st.calls && !st.refused && !st.opened) continue;
    if (analytics) {
      try {
        analytics.writeDataPoint({
          blobs: ["provider", provider, st.openUntil > now ? "open" : "closed"],
          doubles: [st.calls, st.failed, st.refused, st.latencyMs, st.opened],
          indexes: ["provider"],
        });
      } catch {
        // Metrics must never affect a response.
      }
    }
    st.calls = 0;
    st.failed = 0;
    st.refused = 0;
    st.latencyMs = 0;
    st.opened = 0;
  }
}
