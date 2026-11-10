// "+ New Catalog": the Content Type follows the link as it is typed. Only the
// path and query are read, never the site's name ("trakt.tv" has "tv" in it),
// and only whole words (audit PROD-01). Written without a regex slash: this
// file sits inside a template literal.
function guessShelfTypeFromLink(value, typeSelect) {
  const raw = String(value || '').trim().toLowerCase();
  let link = raw;
  try { const u = new URL(raw); link = u.pathname + u.search; } catch (e) { link = raw; }
  const words = link.split(/[^a-z0-9]+/);
  const isShow = link.includes('type=show') || words.includes('shows') || words.includes('series') || link.split('?')[0].split('/').includes('tv');
  // Only auto-switch type if it's the first input or type is currently 'movie' and we detect a show
  if (isShow) {
    typeSelect.value = 'series';
  } else if (link.includes('movie') && typeSelect.value === 'series' && document.querySelectorAll('.addShelfModalLinkInput').length === 1) {
    typeSelect.value = 'movie';
  }
}
