// What a My Catalogs row shows when its preview could not be loaded. A server
// hiccup (a 502 page that is not JSON) lands in the same catch as a lost
// connection, so it must not say "network"; Retry re-runs the catalogs preview,
// the same action as the Refresh button above the rows.
function catalogLoadErrorHtml() {
  return '<p class="testresult err">&#x2717; Could not load this catalog. ' +
    '<button type="button" class="lc-btn secondary" data-act="renderLivePreview">Retry</button></p>';
}
