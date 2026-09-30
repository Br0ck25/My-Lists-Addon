// P5-6: imports resolved by the import.resolve job, with progress, review of
// ambiguous matches and the result list. Through the real Worker and queue,
// with TMDB faked.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeEnv, makeD1, makeQueue, drainQueue, call, createUser, runScheduledTick } from "./harness.mjs";

async function signInSession(env, username, key) {
  const r = await call(env, "/api/session", { method: "POST", json: { username, key } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return (r.headers.get("set-cookie") || "").split(";")[0];
}

// "Film N" (year 2000 + N % 20) exists once; "Twin" exists as 1990 and 2010;
// "Nothing" is unknown. Every movie's IMDb id is tt + (1000000 + id).
function fakeTmdb() {
  const calls = { search: 0, external: 0 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname !== "api.themoviedb.org") throw new Error("network disabled in test: " + url);
    const ext = /^\/3\/(movie|tv)\/(\d+)\/external_ids$/.exec(url.pathname);
    if (ext) {
      calls.external++;
      return Response.json({ imdb_id: "tt" + String(1000000 + Number(ext[2])) });
    }
    if (url.pathname === "/3/search/movie") {
      calls.search++;
      const q = url.searchParams.get("query");
      const year = url.searchParams.get("primary_release_year");
      let results = [];
      const m = /^Film (\d+)$/.exec(q);
      if (m) results = [{ id: Number(m[1]) + 1, title: q, release_date: `${2000 + (Number(m[1]) % 20)}-05-01` }, { id: 99999, title: q + ": The Sequel", release_date: "2024-01-01" }];
      if (q === "Twin") results = [{ id: 501, title: "Twin", release_date: "1990-01-01" }, { id: 502, title: "Twin", release_date: "2010-01-01" }];
      if (year) results = results.filter((r) => r.release_date.startsWith(year));
      return Response.json({ page: 1, results });
    }
    return new Response("{}", { status: 404 });
  };
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

async function setup(extra = {}) {
  const env = makeEnv({ DB: makeD1(), JOBS: makeQueue(), TMDB_API_KEY: "k", ...extra });
  const u = await createUser(env, "importer");
  const cookie = await signInSession(env, "importer", u.creatorKey);
  return { env, cookie };
}

describe("P5-6: imports", () => {
  it("a 1,000-row Letterboxd import completes with no page open", async () => {
    const tmdb = fakeTmdb();
    try {
      const { env, cookie } = await setup();
      const rows = Array.from({ length: 1000 }, (_, n) => ({ title: `Film ${n}`, year: String(2000 + (n % 20)) }));
      const r = await call(env, "/api/imports", { method: "POST", json: { rows, source: "letterboxd", name: "My diary" }, cookie });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      const id = r.body.id;
      // The tab is closed: only the queue works from here.
      const log = await drainQueue(env, { rounds: 100 });
      assert.equal(log.deliveries.filter((d) => d.type === "import.resolve").length, 10, "ten chunks of 100");
      const status = await call(env, `/api/imports/${id}`, { cookie });
      assert.deepEqual(
        [status.body.status, status.body.total, status.body.done, status.body.matched, status.body.ambiguous, status.body.unmatched],
        ["done", 1000, 1000, 1000, 0, 0],
      );
      const result = await call(env, `/api/imports/${id}/result`, { cookie });
      assert.equal(result.body.items.length, 1000);
      assert.deepEqual(result.body.items[0], { id: "tt1000001", type: "movie", name: "Film 0", year: 2000 });
      assert.deepEqual(result.body.items[999].id, "tt1001000");
    } finally {
      tmdb.restore();
    }
  });

  it("keeps ambiguous titles for review, and the choice goes into the result", async () => {
    const tmdb = fakeTmdb();
    try {
      const { env, cookie } = await setup();
      const rows = [{ title: "Twin" }, { title: "Nothing" }, { title: "Film 3", year: 2003 }, { imdbId: "tt0133093", title: "The Matrix" }, { title: "Twin", year: 1990 }];
      const r = await call(env, "/api/imports", { method: "POST", json: { rows }, cookie });
      await drainQueue(env);
      const status = await call(env, `/api/imports/${r.body.id}`, { cookie });
      assert.deepEqual([status.body.matched, status.body.ambiguous, status.body.unmatched], [3, 1, 1]);
      const review = await call(env, `/api/imports/${r.body.id}/review`, { cookie });
      assert.deepEqual(review.body.review.map((x) => [x.row, x.title, x.candidates.map((c) => c.year)]), [[0, "Twin", [1990, 2010]]]);

      const chose = await call(env, `/api/imports/${r.body.id}/review`, { method: "POST", json: { choices: [{ row: 0, tmdbId: 502 }] }, cookie });
      assert.deepEqual([chose.body.matched, chose.body.ambiguous], [4, 0]);
      const result = await call(env, `/api/imports/${r.body.id}/result`, { cookie });
      assert.deepEqual(result.body.items.map((i) => i.id), ["tt1000502", "tt1000004", "tt0133093", "tt1000501"]);
    } finally {
      tmdb.restore();
    }
  });

  it("needs an account, is private to it, and runs one import at a time", async () => {
    const tmdb = fakeTmdb();
    try {
      const { env, cookie } = await setup();
      assert.equal((await call(env, "/api/imports", { method: "POST", json: { rows: [{ title: "Film 1" }] } })).status, 401);
      const r = await call(env, "/api/imports", { method: "POST", json: { rows: [{ title: "Film 1" }] }, cookie });
      assert.equal(r.status, 202);
      const again = await call(env, "/api/imports", { method: "POST", json: { rows: [{ title: "Film 2" }] }, cookie });
      assert.equal(again.status, 409);
      assert.equal(again.body.id, r.body.id);

      const other = await createUser(env, "someoneelse");
      const otherCookie = await signInSession(env, "someoneelse", other.creatorKey);
      assert.equal((await call(env, `/api/imports/${r.body.id}`, { cookie: otherCookie })).status, 404);
      assert.equal((await call(env, `/api/imports/${r.body.id}/result`, { cookie: otherCookie })).status, 404);

      assert.equal((await call(env, "/api/imports", { method: "POST", json: { rows: Array.from({ length: 5001 }, () => ({ title: "x" })) }, cookie })).status, 413);
      assert.equal((await call(env, "/api/imports", { method: "POST", json: { rows: [{}, { title: "" }] }, cookie: otherCookie })).status, 400);
    } finally {
      tmdb.restore();
    }
  });

  it("without the queue, the cron tick works through it", async () => {
    const tmdb = fakeTmdb();
    try {
      const { env, cookie } = await setup({ JOBS: undefined });
      const rows = Array.from({ length: 150 }, (_, n) => ({ title: `Film ${n}`, year: 2000 + (n % 20) }));
      const r = await call(env, "/api/imports", { method: "POST", json: { rows }, cookie });
      assert.equal(r.status, 202);
      await runScheduledTick(env);
      assert.equal((await call(env, `/api/imports/${r.body.id}`, { cookie })).body.done, 100);
      await runScheduledTick(env);
      const status = await call(env, `/api/imports/${r.body.id}`, { cookie });
      assert.deepEqual([status.body.status, status.body.matched], ["done", 150]);
    } finally {
      tmdb.restore();
    }
  });
});
