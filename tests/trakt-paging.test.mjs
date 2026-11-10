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
    for (let guard = 0; guard < 80; guard++) {
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
});

