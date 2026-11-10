// POST /api/preview with validateOnly: true answers only whether the pasted
// link(s) are a supported list source, the same check the preview itself makes,
// with no provider call and no rate-limit charge (audit PROD-02). The New
// Catalog dialog asks before it saves a row.
function previewSourceCheckResponse(testUrl) {
  const sourceUrls = previewSourceUrls(testUrl);
  if (!sourceUrls.length || !sourceUrls.every(isAllowedCatalogSourceUrl)) {
    return json({ ok: false, error: "That URL isn't a supported list source." }, 400, { "Cache-Control": "no-store" });
  }
  return json({ ok: true }, 200, { "Cache-Control": "no-store" });
}

// The first page of a public TMDB or Trakt chart: shared data that is cached,
// so a preview of it is not charged to the per-address budget (audit PERF-03).
// A deep page is, since each distinct page is its own cache entry.
function isFreeChartPreview(testUrl, skip) {
  if (skip !== 0) return false;
  const urls = previewSourceUrls(testUrl);
  return urls.length > 0 && urls.every((u) => /^(?:tmdb|trakt):chart:[a-z0-9_-]+$/i.test(u));
}

// Catalog rows past the first page: every distinct `skip` is its own cache
// entry and its own provider call, so one address asking for hundreds of them
// could spend the shared TMDB and Trakt keys (audit API-05). They share a
// budget of 120 a minute per address; the first page is never charged and
// normal scrolling never gets near it. null when allowed.
const CATALOG_SKIP_MAX_PER_MINUTE = 120;
async function catalogSkipLimitResponse(request, env, ctx, skip) {
  if (!(skip > 0)) return null;
  const ip = clientIpKey(request);
  if (!ip || !(await consumeRateLimit(env, ctx, "catalog-skip", ip, CATALOG_SKIP_MAX_PER_MINUTE, 60))) return null;
  return jsonPublic({ metas: [] }, 429, { "Cache-Control": "no-store", "Retry-After": "30" });
}
