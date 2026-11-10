// Trakt pages hold 100 raw rows, but one page can map to fewer titles (several
// episodes of one show become one title). An app sends the number of titles it
// already holds as the next `skip`, so "skip / 100" asked Trakt for the same
// page again and the row repeated itself (audit API-04). This continues where
// the app is: it walks Trakt pages from the start, each cached on its own,
// drops a title already seen, and returns the window the app asked for.
//
// loadPage(rawSkip) is the existing fetcher for one Trakt page (rawSkip is
// 0, 100, 200, ...). At most TRAKT_WINDOW_MAX_PAGES pages are read for one
// request (each is cached, so a long scroll mostly re-reads cached pages). A skip the
// walk cannot reach in that many pages falls back to the old page arithmetic, which
// may repeat a few titles but never ends the row early.
const TRAKT_WINDOW_MAX_PAGES = 30;

async function traktWindowedPage(skip, loadPage) {
  if (skip >= TRAKT_WINDOW_MAX_PAGES * PAGE_SIZE) return loadPage(Math.floor(skip / PAGE_SIZE) * PAGE_SIZE);
  const want = skip + PAGE_SIZE;
  const seen = new Set();
  const titles = [];
  let total = null;
  let reachedEnd = false;
  for (let i = 0; i < TRAKT_WINDOW_MAX_PAGES && titles.length < want; i++) {
    let metas;
    try {
      metas = await loadPage(i * PAGE_SIZE);
    } catch (err) {
      if (i === 0) throw err;
      break; // the first page worked: give what there is rather than nothing
    }
    if (!Array.isArray(metas)) break;
    if (total == null && metas.totalItems != null) total = metas.totalItems;
    if (i === 0 && metas.length === 0 && skip === 0) return metas; // keep the caller's empty-row handling
    for (const m of metas) {
      if (m && !seen.has(m.id)) { seen.add(m.id); titles.push(m); }
    }
    // The end of the list: nothing came back, Trakt sent a short page, or the total is reached.
    if (!metas.length || (metas.rawRows != null && metas.rawRows < PAGE_SIZE) || (total != null && (i + 1) * PAGE_SIZE >= total)) { reachedEnd = true; break; }
  }
  // The pages read did not get as far as `skip` and the list goes on: never answer empty.
  if (!reachedEnd && titles.length <= skip) return loadPage(Math.floor(skip / PAGE_SIZE) * PAGE_SIZE);
  const out = titles.slice(skip, skip + PAGE_SIZE);
  if (total != null) out.totalItems = total;
  return out;
}
