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
