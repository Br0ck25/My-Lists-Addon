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
