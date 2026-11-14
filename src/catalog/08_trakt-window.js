// Trakt pages hold 100 raw rows, but one page can map to fewer titles (several
// episodes of one show become one title). An app sends the number of titles it
// already holds as the next `skip`, so "skip / 100" asked Trakt for the same
// page again and the row repeated itself (audit API-04). This continues where
// the app is.
//
// For each list it remembers how many titles each Trakt page held (`cum`:
// cum[i] titles before page i). A request starts at the last page that begins
// at or before `skip` and reads forward from there, so a long scroll reads one
// or two pages a request, not a walk from page 1. The memory lives in the
// isolate and in KV for ten minutes (a list changes under it, so it must not
// last), and grows only by what a request reads. A title already on the page
// just before is dropped (and not counted in `cum`), so a show that recurs on
// neighbouring pages, as in a watch history, is sent once. The rule looks one
// page back only, so every request agrees on what each page holds.
//
// loadPage(rawSkip) is the existing fetcher for one Trakt page (rawSkip is
// 0, 100, 200, ...); each page is cached on its own by the fetchers.
const TRAKT_WINDOW_MAX_PAGES = 12; // pages read for one request
const TRAKT_WINDOW_MEMO_TTL_SEC = 600;
const TRAKT_WINDOW_MEMO_MAX = 300; // lists remembered in the isolate
const traktWindowMemory = new Map();

async function traktWindowMemo(env, key) {
  const hit = traktWindowMemory.get(key);
  if (hit && Date.now() - hit.at < TRAKT_WINDOW_MEMO_TTL_SEC * 1000) return hit;
  const memo = { cum: [0], total: null, at: Date.now() };
  if (env && env.CONFIGS) {
    try {
      const saved = JSON.parse((await env.CONFIGS.get("trakt:win:" + key)) || "null");
      if (saved && Array.isArray(saved.cum) && saved.cum[0] === 0) {
        memo.cum = saved.cum.filter((n) => Number.isFinite(n)).slice(0, 2000);
        memo.total = saved.total == null ? null : Number(saved.total);
      }
    } catch {
      // No memory of this list: start from page one.
    }
  }
  if (traktWindowMemory.size >= TRAKT_WINDOW_MEMO_MAX) traktWindowMemory.clear();
  traktWindowMemory.set(key, memo);
  return memo;
}

// A short hash of the list's identity (it may contain an access token, which must not be a KV key).
async function traktWindowKey(id) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(id)));
  return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function traktWindowedPage(skip, loadPage, { env = null, id = "" } = {}) {
  const key = id ? await traktWindowKey(id) : "";
  const memo = key ? await traktWindowMemo(env, key) : { cum: [0], total: null, at: Date.now() };
  let start = 0;
  for (let i = memo.cum.length - 1; i >= 0; i--) if (memo.cum[i] <= skip) { start = i; break; }
  const offset = skip - memo.cum[start];
  const titles = [];
  let page = start;
  let reachedEnd = false;
  let grew = false;
  let prevIds = new Set();
  if (start > 0 && memo.tail && memo.tail.page === start - 1) {
    prevIds = memo.tail.ids; // the page this isolate read last time: no extra Trakt call
  } else if (start > 0) {
    // The page before the first one read: its titles are not repeated by the next page.
    try {
      const before = await loadPage((start - 1) * PAGE_SIZE);
      if (Array.isArray(before)) prevIds = new Set(before.filter(Boolean).map((m) => m.id));
    } catch {
      // Without it a title at the seam may repeat once.
    }
  }
  for (let n = 0; n < TRAKT_WINDOW_MAX_PAGES && titles.length < offset + PAGE_SIZE; n++, page++) {
    let metas;
    try {
      metas = await loadPage(page * PAGE_SIZE);
    } catch (err) {
      if (n === 0) throw err;
      break; // the first page worked: give what there is rather than nothing
    }
    if (!Array.isArray(metas)) break;
    if (memo.total == null && metas.totalItems != null) memo.total = metas.totalItems;
    if (page === 0 && skip === 0 && !metas.length) return metas; // keep the caller's empty-row handling
    const fresh = metas.filter((m) => m && !prevIds.has(m.id));
    prevIds = new Set(metas.filter(Boolean).map((m) => m.id));
    memo.tail = { page, ids: prevIds };
    if (memo.cum.length === page + 1) { memo.cum.push(memo.cum[page] + fresh.length); grew = true; }
    titles.push(...fresh);
    // The end of the list: nothing came back, Trakt sent a short page, or the total is reached.
    if (!metas.length || (metas.rawRows != null && metas.rawRows < PAGE_SIZE) || (memo.total != null && (page + 1) * PAGE_SIZE >= memo.total)) { reachedEnd = true; break; }
  }
  if (grew && key && env && env.CONFIGS) {
    try {
      await env.CONFIGS.put("trakt:win:" + key, JSON.stringify({ cum: memo.cum, total: memo.total }), { expirationTtl: TRAKT_WINDOW_MEMO_TTL_SEC });
    } catch {
      // The isolate keeps it; another isolate starts from what it can read.
    }
  }
  const out = titles.slice(offset, offset + PAGE_SIZE);
  if (out.length || reachedEnd) {
    if (memo.total != null) out.totalItems = memo.total;
    return out;
  }
  // A first request far down a list nobody has scrolled: the pages read did not reach `skip`.
  // Estimate the page from the titles per page seen so far and answer from there (a few titles
  // may repeat or be missed at the seam); the memory has grown, so scrolling on gets exact.
  const known = memo.cum.length - 1;
  const lastPage = memo.total != null ? Math.max(0, Math.ceil(memo.total / PAGE_SIZE) - 1) : null;
  let perPage = Math.max(1, memo.cum[known] / Math.max(1, known));
  if (lastPage != null && lastPage > known + 1) {
    // The first pages of a watch history collapse most, so they say little about the rest: also
    // measure a few pages spread over the unread part (each is cached on its own).
    const counts = [];
    for (let k = 1; k <= 4; k++) {
      try {
        const sample = await loadPage((known + Math.round(((lastPage - known) * k) / 4)) * PAGE_SIZE);
        if (Array.isArray(sample) && sample.length) counts.push(sample.length);
      } catch {
        // A page that will not load only makes the guess rougher.
      }
    }
    if (counts.length) perPage = Math.max(1, counts.reduce((a, b) => a + b, 0) / counts.length);
  }
  let estimate = known + Math.floor((skip - memo.cum[known]) / perPage);
  if (memo.endSkip != null && skip >= memo.endSkip) {
    // This isolate already served the last Trakt page for this list and the app has taken it.
    const none = [];
    none.totalItems = memo.total;
    return none;
  }
  if (lastPage != null && estimate > lastPage) {
    // The guess must not end the row. A page holds at most PAGE_SIZE titles, so this is the
    // earliest page `skip` can be on: only past the last page has the row really ended.
    estimate = known + Math.floor((skip - memo.cum[known]) / PAGE_SIZE);
    if (estimate > lastPage) {
      const none = [];
      none.totalItems = memo.total;
      return none;
    }
  }
  const more = [];
  let sawLast = false;
  for (let k = 0; k < 4 && more.length < PAGE_SIZE; k++) {
    let metas;
    try { metas = await loadPage((estimate + k) * PAGE_SIZE); } catch (err) { if (k === 0) throw err; break; }
    if (!Array.isArray(metas) || !metas.length) break;
    for (const m of metas) if (m) more.push(m);
    if (lastPage != null && estimate + k >= lastPage) { sawLast = true; break; }
  }
  const served = more.slice(0, PAGE_SIZE);
  if (sawLast && served.length === more.length) memo.endSkip = skip + served.length;
  return served;
}
