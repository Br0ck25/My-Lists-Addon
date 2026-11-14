// Audit API-04: Trakt rows paged by "skip / 100", but an app sends the number
// of items it already holds as the next skip. A Trakt page of 100 episode rows
// can map to 80 titles; skip=80 then asked Trakt for page 1 again and returned
// the same 80. A page now continues where the app is: it walks Trakt pages
// (each cached on its own) until it has the titles the app asked for.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeEnv, makeD1, makeKv, call, nextIp } from "./harness.mjs";

const realFetch = globalThis.fetch;

// Trakt page 1: 100 rows for 80 distinct shows (20 shows twice); page 2: 100
// new shows; page 3: 100 more; page 4: empty. 280 titles in all.
function traktRows(page) {
  const show = (n) => ({ type: "show", show: { title: "Show " + n, year: 2000, ids: { imdb: "tt" + String(1000000 + n), tmdb: 5000 + n } } });
  if (page === 1) return Array.from({ length: 100 }, (_, i) => show(i % 80));
  if (page === 2) return Array.from({ length: 100 }, (_, i) => show(100 + i));
  if (page === 3) return Array.from({ length: 100 }, (_, i) => show(300 + i));
  return [];
}

async function rowPages(skips) {
  const traktPagesAsked = [];
  globalThis.fetch = async (u) => {
    const href = typeof u === "string" ? u : u.url;
    if (/api\.trakt\.tv\/users\/bob\/lists\/best\/items/.test(href)) {
      const page = Number((href.match(/[?&]page=(\d+)/) || [])[1] || 1);
      traktPagesAsked.push(page);
      return new Response(JSON.stringify(traktRows(page)), { status: 200, headers: { "content-type": "application/json", "X-Pagination-Item-Count": "300" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), TRAKT_CLIENT_ID: "cid" });
    const saved = await call(env, "/api/save", { method: "POST", json: { entries: [{ id: "tl", url: "https://trakt.tv/users/bob/lists/best", name: "Best", type: "series" }], traktKey: "cid" } });
    assert.equal(saved.body.ok, true, JSON.stringify(saved.body));
    const out = [];
    for (const skip of skips) {
      const r = await call(env, `/${saved.body.id}/catalog/series/tl${skip ? `/skip=${skip}` : ""}.json`, { ip: nextIp() });
      assert.equal(r.status, 200, r.text);
      out.push(r.body.metas.map((m) => m.id));
    }
    return { out, traktPagesAsked };
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe("API-04: Trakt rows continue where the app is", () => {
  it("each page the app asks for, using the count it holds as skip, brings new titles and none twice", async () => {
    // Step 1: skip 0. Step 2: skip = how many titles came back. And so on.
    const first = await rowPages([0]);
    const held1 = first.out[0].length;
    const second = await rowPages([0, held1]);
    const a = second.out[0];
    const b = second.out[1];
    assert.ok(a.length > 0 && b.length > 0, "both pages have titles");
    const overlap = b.filter((id) => a.includes(id));
    assert.deepEqual(overlap, [], "the second page repeats nothing the first had");
    const third = await rowPages([0, held1, held1 + b.length]);
    const all = third.out.flat();
    assert.equal(new Set(all).size, all.length, "no title twice across the whole walk");
    assert.ok(all.length >= 200, "walked past Trakt's first page: " + all.length);
  });

  it("a full first page still costs one Trakt request", async () => {
    const r = await rowPages([0]);
    assert.ok(r.traktPagesAsked.length <= 2, "pages asked: " + r.traktPagesAsked.join(","));
  });
});

// Audit API-04 verification: a long list whose pages all shrink (watch history: many episodes of
// one show) stopped after five Trakt pages, so 400 of 800 titles were reachable.
// Each walk uses its own list name: the Worker keeps fetched Trakt pages in memory between tests.
async function walkAll(pages, titlesPerPage, rawTotal) {
  const slug = "long" + pages + "x" + titlesPerPage;
  const rows = (page) => {
    if (page > pages) return [];
    const show = (n) => ({ type: "show", show: { title: "S" + n, year: 2000, ids: { imdb: "tt" + String(2000000 + n), tmdb: 9000 + n } } });
    return Array.from({ length: 100 }, (_, j) => show(page * 1000 + (j % titlesPerPage)));
  };
  globalThis.fetch = async (u) => {
    const href = typeof u === "string" ? u : u.url;
    if (href.includes("/users/bob/lists/" + slug + "/items")) {
      const page = Number((href.match(/[?&]page=(\d+)/) || [])[1] || 1);
      return new Response(JSON.stringify(rows(page)), { status: 200, headers: { "content-type": "application/json", "X-Pagination-Item-Count": String(rawTotal) } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), TRAKT_CLIENT_ID: "cid" });
    const saved = await call(env, "/api/save", { method: "POST", json: { entries: [{ id: "tl", url: "https://trakt.tv/users/bob/lists/" + slug, name: "Best", type: "series" }], traktKey: "cid" } });
    const all = [];
    let held = 0;
    for (let guard = 0; guard < 400; guard++) {
      const r = await call(env, `/${saved.body.id}/catalog/series/tl${held ? `/skip=${held}` : ""}.json`, { ip: nextIp() });
      const metas = r.body.metas || [];
      if (!metas.length) break;
      all.push(...metas.map((m) => m.id));
      held += metas.length;
    }
    return all;
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe("API-04: a long list of shrinking pages is reachable to its end", () => {
  it("10 Trakt pages of 80 titles each: all 800 titles, none twice", async () => {
    const all = await walkAll(10, 80, 1000);
    assert.equal(new Set(all).size, all.length, "no title twice");
    assert.equal(all.length, 800);
  });

  it("40 shrinking pages (past the walk's page cap) still reach the end instead of stopping half way", async () => {
    const all = await walkAll(40, 80, 4000);
    assert.ok(all.length >= 3000, "reached " + all.length + " of 3200 titles");
  });

  // Second review: 35 pages of 20 titles (watch history, ~5 episodes a show). Past the page cap the
  // fallback served pages the app already had, so the app got 2,880 titles but only 600 distinct.
  it("35 pages of 20 titles: every title once, in order (the old cap lost them after 600)", async () => {
    const all = await walkAll(35, 20, 3500);
    assert.equal(new Set(all).size, 700, "all 700 distinct titles reached");
    assert.equal(all.length, 700, "and none sent twice");
  });

  it("120 pages of 30 titles (past even the larger cap): the row still moves forward to the end", async () => {
    const all = await walkAll(120, 30, 12000);
    const distinct = new Set(all).size;
    assert.ok(all.includes("tt" + (2000000 + 120 * 1000)), "the last page's titles were reached");
    assert.ok(distinct >= 0.8 * 3600, `only ${distinct} of 3600 distinct titles over ${all.length} delivered`);
    assert.ok(all.length <= 1.3 * 3600, `${all.length} delivered: the row keeps resending the same pages`);
  });
});

// Third review: past the walk's page cap the next page was estimated and the row could end early, and
// a deep request read up to 100 Trakt pages from page 1. The walk now remembers, per list, how many
// titles each Trakt page held, so a request starts at the right page and reads one or two.
async function walkShape(shape, slug, { startSkip = 0, maxRequests = 400 } = {}) {
  const pageTitles = shape.flatMap(([count, per]) => Array.from({ length: count }, () => per));
  const rawTotal = pageTitles.length * 100;
  let traktCalls = 0;
  globalThis.fetch = async (u) => {
    const href = typeof u === "string" ? u : u.url;
    if (href.includes("/users/bob/lists/" + slug + "/items")) {
      traktCalls++;
      const page = Number((href.match(/[?&]page=(\d+)/) || [])[1] || 1);
      const per = pageTitles[page - 1];
      const rows = per == null ? [] : Array.from({ length: 100 }, (_, j) => ({ type: "show", show: { title: "S", year: 2000, ids: { imdb: "tt" + String(3000000 + page * 1000 + (j % per)), tmdb: 7000 + page * 1000 + (j % per) } } }));
      return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json", "X-Pagination-Item-Count": String(rawTotal) } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), TRAKT_CLIENT_ID: "cid" });
    const saved = await call(env, "/api/save", { method: "POST", json: { entries: [{ id: "tl", url: "https://trakt.tv/users/bob/lists/" + slug, name: "Best", type: "series" }], traktKey: "cid" } });
    const all = [];
    let held = startSkip, worst = 0;
    for (let n = 0; n < maxRequests; n++) {
      const before = traktCalls;
      const r = await call(env, `/${saved.body.id}/catalog/series/tl${held ? `/skip=${held}` : ""}.json`, { ip: nextIp() });
      worst = Math.max(worst, traktCalls - before);
      const metas = r.body.metas || [];
      if (!metas.length) break;
      all.push(...metas.map((m) => m.id));
      held += metas.length;
    }
    return { all, worst, traktCalls, total: pageTitles.reduce((a, b) => a + b, 0) };
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe("API-04: the walk remembers where each Trakt page starts", () => {
  it("110 pages of 10 titles then 40 pages of 100 (5,100 titles): all reached once, the row never ends early", async () => {
    const r = await walkShape([[110, 10], [40, 100]], "shapeA");
    assert.equal(new Set(r.all).size, r.total, `reached ${new Set(r.all).size} of ${r.total}`);
    assert.equal(r.all.length, r.total, "none sent twice");
  });

  it("scrolling a long list is exact, and a request reads only the pages its 100 titles need", async () => {
    // 10-title pages need ten pages for one answer; the walk must not add a walk from page 1 on top.
    const r = await walkShape([[60, 90], [90, 10]], "shapeB");
    assert.ok(r.worst <= 12, `one request made ${r.worst} Trakt calls`);
    assert.ok(r.traktCalls <= 150 + 12, `${r.traktCalls} Trakt calls for a 150-page list: each page should be read about once`);
    assert.equal(r.all.length, r.total);
    assert.equal(new Set(r.all).size, r.total);
  });

  it("a first request far down a list nobody has scrolled reads a bounded number of pages", async () => {
    const r = await walkShape([[120, 100]], "shapeC", { startSkip: 9000, maxRequests: 1 });
    assert.ok(r.traktCalls <= 20, `${r.traktCalls} Trakt calls for one deep request`);
  });
});


// Fourth review: the page memory also dropped the de-duplication across Trakt pages, so in a watch
// history (a show recurs on many pages) every show was sent again on every page.
async function walkShows(pageShows, slug, { startSkip = 0, maxRequests = 400 } = {}) {
  globalThis.fetch = async (u) => {
    const href = typeof u === "string" ? u : u.url;
    if (href.includes("/users/bob/lists/" + slug + "/items")) {
      const page = Number((href.match(/[?&]page=(\d+)/) || [])[1] || 1);
      const shows = pageShows[page - 1];
      const rows = shows == null ? [] : Array.from({ length: 100 }, (_, j) => { const n = shows[j % shows.length]; return { type: "show", show: { title: "S" + n, year: 2000, ids: { imdb: "tt" + String(4000000 + n), tmdb: 6000 + n } } }; });
      return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json", "X-Pagination-Item-Count": String(pageShows.length * 100) } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const env = makeEnv({ DB: makeD1(), CONFIGS: makeKv(), TRAKT_CLIENT_ID: "cid" });
    const saved = await call(env, "/api/save", { method: "POST", json: { entries: [{ id: "tl", url: "https://trakt.tv/users/bob/lists/" + slug, name: "Best", type: "series" }], traktKey: "cid" } });
    const all = [];
    let held = startSkip;
    for (let n = 0; n < maxRequests; n++) {
      const r = await call(env, `/${saved.body.id}/catalog/series/tl${held ? `/skip=${held}` : ""}.json`, { ip: nextIp() });
      const metas = r.body.metas || [];
      if (!metas.length) break;
      all.push(...metas.map((m) => m.id));
      held += metas.length;
    }
    return { all, requests: all.length };
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe("API-04: a title that recurs on neighbouring Trakt pages is sent once", () => {
  it("5 shows watched in turn over 20 pages: 5 titles, not 100", async () => {
    const r = await walkShows(Array.from({ length: 20 }, () => [1, 2, 3, 4, 5]), "histA");
    assert.equal(r.all.length, 5);
    assert.equal(new Set(r.all).size, 5);
  });

  it("shows that each span two and a half pages: every show once", async () => {
    // page k holds show floor(k*0.4) and the next one, so every show covers 2-3 neighbouring pages.
    const pages = Array.from({ length: 20 }, (_, k) => [Math.floor(k / 2.5), Math.floor(k / 2.5) + (k % 5 === 2 ? 1 : 0)]);
    const distinct = new Set(pages.flat()).size;
    const r = await walkShows(pages, "histB");
    assert.equal(new Set(r.all).size, distinct, "every show reached");
    assert.equal(r.all.length, distinct, "none sent twice");
  });

  it("after the memory is gone, the end of a list ends the row instead of re-sending the last page", async () => {
    // 150 pages of 60 distinct titles; resume at the very end with nothing remembered.
    const pages = Array.from({ length: 150 }, (_, p) => Array.from({ length: 60 }, (_, j) => p * 100 + j));
    const r = await walkShows(pages, "histC", { startSkip: 150 * 60 - 60 });
    assert.ok(r.all.length <= 120, `${r.all.length} titles sent for the last 60 that exist`);
  });
});

// Fifth review: a cold request into a list whose early pages collapse (a binge in a watch history) but
// whose later pages are full estimated too many titles per page, jumped past the last Trakt page and
// ended the row while thousands of titles were still to come.
describe("API-04: a cold request into an uneven list never ends the row early", () => {
  it("60 pages of 20 titles then 60 of 90, resumed cold at skip 2,500, 4,000 and 6,000: titles come back and the last page is reached", async () => {
    for (const startSkip of [2500, 4000, 6000]) {
      const r = await walkShape([[60, 20], [60, 90]], "uneven" + startSkip, { startSkip, maxRequests: 400 });
      assert.ok(r.all.length > 0, `skip ${startSkip}: the row ended at once with ${r.total - startSkip} titles to come`);
      assert.ok(r.all.includes("tt" + (3000000 + 120 * 1000)), `skip ${startSkip}: the last Trakt page was never reached`);
    }
  });
});
