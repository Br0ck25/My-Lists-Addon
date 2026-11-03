// Page memo and the HTML page response. Moved out of 02_http-and-creator-utils.js
// (unchanged apart from PERF-05's identity shortcut and PERF-06's body marker),
// because that file is over its size baseline and may only shrink.

// Rewritten pages are remembered so a repeat request for the same page does not
// re-scan ~2MB looking for the markers.
//
// Keyed on a cheap hash of the page, NOT on the page itself. The key used to be
// the whole pre-split HTML string -- measured at 1,979,374 characters -- with
// the rewritten page (~580KB) as the value, sixteen of them. That is tens of
// megabytes of strings pinned in an isolate that has 128MB for everything,
// alongside APP_BUNDLE (~1.3MB), APP_CSS (~97KB) and PER_USER_CACHE_MAP's
// thousand entries. Every distinct shared list URL, configure link and deep
// link renders different HTML, so the cache genuinely does fill.
//
// A 32-bit FNV-1a over the string is not collision-proof, and does not need to
// be: a collision would serve one visitor another visitor's PAGE, so the stored
// length is checked too and the hash is only ever a key into this isolate's own
// memory. Cheap enough that it costs less than the marker scan it avoids.
const SPLIT_PAGE_MEMO = new Map();

function splitPageMemoKey(html) {
  let h = 0x811c9dc5;
  for (let i = 0; i < html.length; i++) {
    h ^= html.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + ":" + html.length;
}

// The last few pages by identity. renderBuilderCached hands back the same string
// object for the default page, so a repeat request (a 304 included) is found with
// one reference comparison instead of an FNV pass over ~1.6 MB.
const RECENT_SPLIT_PAGES = [];
const RECENT_SPLIT_PAGES_MAX = 2;

async function pageWithExternalBundle(html) {
  for (const e of RECENT_SPLIT_PAGES) if (e.html === html) return e.page;
  const key = splitPageMemoKey(html);
  const memo = SPLIT_PAGE_MEMO.get(key);
  if (memo) {
    rememberRecentSplitPage(html, memo);
    return memo;
  }
  let page = html;
  try {
    page = (await splitAppBundle(html)).page;
    page = (await splitAppCss(page)).page;
  } catch {
    // Nothing unexpected here is worth costing somebody their page.
    return html;
  }
  if (SPLIT_PAGE_MEMO.size >= 16) {
    const oldest = SPLIT_PAGE_MEMO.keys().next().value;
    if (oldest !== undefined) SPLIT_PAGE_MEMO.delete(oldest);
  }
  SPLIT_PAGE_MEMO.set(key, page);
  rememberRecentSplitPage(html, page);
  return page;
}

function rememberRecentSplitPage(html, page) {
  RECENT_SPLIT_PAGES.unshift({ html, page });
  if (RECENT_SPLIT_PAGES.length > RECENT_SPLIT_PAGES_MAX) RECENT_SPLIT_PAGES.pop();
}

function pageResponseWithBody(html, init) {
  const res = new Response(html, init);
  res[PAGE_HTML_BODY] = html;
  return res;
}

async function htmlPageResponse(request, fullHtml, extraHeaders) {
  // The ~1.3MB client bundle is lifted out to /app.js?v=<hash> first, so
  // both the body sent below and the ETag computed from it describe the
  // small page rather than the page-plus-bundle.
  const html = await pageWithExternalBundle(fullHtml);
  let etag = "";
  try {
    etag = await htmlEtagFor(html);
  } catch {
    // No digest available -- fall through and just send the page, exactly
    // as this did before there was an ETag at all.
  }
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
    ...(extraHeaders || {}),
  };
  if (!etag) return pageResponseWithBody(html, { headers });
  headers["ETag"] = etag;

  // If-None-Match can carry a list, and a cache is allowed to weaken a tag
  // it stores, so compare against each entry with any W/ prefix removed
  // rather than string-equalling the whole header.
  const inm = request && request.headers ? (request.headers.get("If-None-Match") || "") : "";
  if (inm) {
    const match = inm
      .split(",")
      .map((s) => s.trim().replace(/^W\//, ""))
      .some((s) => s === etag || s === "*");
    if (match) {
      return new Response(null, { status: 304, headers });
    }
  }
  return pageResponseWithBody(html, { headers });
}

