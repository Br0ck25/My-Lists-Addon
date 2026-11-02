
// --- Imports: import.resolve (Phase 5, P5-6) -----------------------------------
//
// A Letterboxd or CSV import used to be resolved by the browser: it posted the
// titles to /api/bulk-resolve 200 at a time and waited, so closing the tab
// stopped the import, and a title TMDB could not place with its first search
// result was simply dropped. Here the rows are handed over once and resolved
// by a job (45_jobs-dispatcher.js), with progress the page can poll:
//
//   POST /api/imports              { rows: [{ title, year?, imdbId?, tmdbId? }],
//                                    kind?: "movie" | "series", source?, name? }
//                                  -> 202 { id }   (a signed-in account; one
//                                  import at a time; at most IMPORT_ROWS_MAX rows)
//   GET  /api/imports/:id          progress: { status, total, done, matched,
//                                  ambiguous, unmatched }
//   GET  /api/imports/:id/review   the ambiguous rows, each with up to three
//                                  candidates
//   POST /api/imports/:id/review   { choices: [{ row, tmdbId | null }] }: pick a
//                                  candidate (or none) for ambiguous rows
//   GET  /api/imports/:id/result   the matched titles as list items, in the
//                                  import's order, ready for the existing list
//                                  routes to save
//
// The job (`import.resolve`, a one-off job) resolves IMPORT_CHUNK rows per run
// and carries on in a new run until every row is done; the results live in
// the job's progress_json. A row with an IMDb or TMDB id is matched as given.
// Otherwise TMDB is searched (with the year when there is one):
//   - one candidate whose title matches, or the top result when its title and
//     year both match: matched (its IMDb id fetched);
//   - several candidates that could be it: ambiguous, kept for review;
//   - nothing: unmatched.
//
// /api/bulk-resolve stays until the page's import screen moves to this (P6-6);
// it is then kept one more release as a shim.
//
// Module level, after the Worker's exports, like 27_ onward.

const IMPORT_JOB_TYPE = "import.resolve";
const IMPORT_ROWS_MAX = 5000;
const IMPORT_CHUNK = 100;
const IMPORT_CANDIDATES_MAX = 3;
const IMPORT_TITLE_MAX = 300;

function importTitleKey(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^(the|a|an) /, "")
    .trim();
}

function importCleanRows(rows) {
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const title = String(r.title || r.name || "").trim().slice(0, IMPORT_TITLE_MAX);
    const imdbId = /^tt\d{1,10}$/.test(String(r.imdbId || "")) ? String(r.imdbId) : null;
    const tmdbId = Number(r.tmdbId) > 0 ? Math.floor(Number(r.tmdbId)) : null;
    const year = /^\d{4}$/.test(String(r.year || "").trim()) ? Number(String(r.year).trim()) : null;
    if (!title && !imdbId && !tmdbId) continue;
    out.push({ title, year, imdbId, tmdbId });
  }
  return out;
}

async function importTmdb(path, key) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`https://api.themoviedb.org/3${path}${sep}api_key=${encodeURIComponent(key)}`, {
    headers: { "User-Agent": `my-lists-addon/${ADDON_VERSION}` },
    cf: { cacheTtl: 86400, cacheEverything: true },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`TMDB answered ${res.status}`);
  return res.json();
}

function importCandidate(r, kind) {
  const date = kind === "series" ? r.first_air_date : r.release_date;
  return {
    tmdbId: r.id,
    title: (kind === "series" ? r.name || r.original_name : r.title || r.original_title) || "",
    year: date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null,
    poster: r.poster_path || null,
  };
}

// Decides a searched row from TMDB's results. Pure.
function importDecide(row, results, kind) {
  const want = importTitleKey(row.title);
  const cands = (results || []).slice(0, 10).map((r) => importCandidate(r, kind));
  if (!cands.length) return { status: "unmatched" };
  const sameTitle = cands.filter((c) => importTitleKey(c.title) === want);
  if (row.year) {
    const exact = sameTitle.filter((c) => c.year === row.year);
    if (exact.length === 1) return { status: "matched", pick: exact[0] };
    // A year off by one is common (festival and release years differ).
    const near = sameTitle.filter((c) => c.year && Math.abs(c.year - row.year) <= 1);
    if (!exact.length && near.length === 1) return { status: "matched", pick: near[0] };
    const pool = exact.length ? exact : near.length ? near : sameTitle;
    if (pool.length) return { status: "ambiguous", candidates: pool.slice(0, IMPORT_CANDIDATES_MAX) };
    return { status: "ambiguous", candidates: cands.slice(0, IMPORT_CANDIDATES_MAX) };
  }
  if (sameTitle.length === 1) return { status: "matched", pick: sameTitle[0] };
  if (sameTitle.length > 1) return { status: "ambiguous", candidates: sameTitle.slice(0, IMPORT_CANDIDATES_MAX) };
  if (cands.length === 1) return { status: "matched", pick: cands[0] };
  return { status: "ambiguous", candidates: cands.slice(0, IMPORT_CANDIDATES_MAX) };
}

async function importImdbFor(kind, tmdbId, key) {
  const ext = await importTmdb(`/${kind === "series" ? "tv" : "movie"}/${Number(tmdbId)}/external_ids`, key);
  return ext && /^tt\d+$/.test(String(ext.imdb_id || "")) ? ext.imdb_id : null;
}

// Resolves one row: { status, imdbId?, tmdbId?, title?, year?, candidates? }.
async function importResolveRow(row, kind, key) {
  if (row.imdbId) return { status: "matched", imdbId: row.imdbId, tmdbId: row.tmdbId, title: row.title, year: row.year };
  if (row.tmdbId) {
    const imdbId = await importImdbFor(kind, row.tmdbId, key);
    return { status: "matched", imdbId, tmdbId: row.tmdbId, title: row.title, year: row.year };
  }
  const yearParam = row.year ? (kind === "series" ? `&first_air_date_year=${row.year}` : `&primary_release_year=${row.year}`) : "";
  const path = `/search/${kind === "series" ? "tv" : "movie"}?query=${encodeURIComponent(row.title)}&include_adult=false${yearParam}`;
  let data = await importTmdb(path, key);
  // A year filter that finds nothing: the year may be wrong; search without it.
  if (row.year && (!data || !Array.isArray(data.results) || !data.results.length)) {
    data = await importTmdb(`/search/${kind === "series" ? "tv" : "movie"}?query=${encodeURIComponent(row.title)}&include_adult=false`, key);
  }
  const d = importDecide(row, data && data.results, kind);
  if (d.status !== "matched") return d;
  return { status: "matched", tmdbId: d.pick.tmdbId, imdbId: await importImdbFor(kind, d.pick.tmdbId, key), title: d.pick.title, year: d.pick.year };
}

function importCounts(results, total) {
  const c = { total, done: results.length, matched: 0, ambiguous: 0, unmatched: 0 };
  for (const r of results) {
    if (r.status === "matched" || r.status === "chosen") c.matched++;
    else if (r.status === "ambiguous") c.ambiguous++;
    else c.unmatched++;
  }
  return c;
}

defineDurableJob(IMPORT_JOB_TYPE, {
  // A chunk is 100 rows at up to three TMDB calls each.
  leaseMs: 10 * 60 * 1000,
  async run(env, payload, job) {
    const key = showScheduleTmdbKey(env);
    if (!key) throw new Error("TMDB_API_KEY is not set");
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    const kind = payload.kind === "series" ? "series" : "movie";
    const results = Array.isArray(job.progress.results) ? job.progress.results.slice() : [];
    const end = Math.min(rows.length, results.length + IMPORT_CHUNK);
    for (let i = results.length; i < end; i += 10) {
      const part = rows.slice(i, Math.min(end, i + 10));
      // Ten at a time, as /api/bulk-resolve does. A row whose lookup fails is
      // tried again with the chunk (the job's retry), not dropped.
      const done = await Promise.all(part.map((r) => importResolveRow(r, kind, key)));
      results.push(...done);
    }
    const progress = { results, ...importCounts(results, rows.length) };
    return results.length < rows.length ? { progress, again: true } : { progress };
  },
});

function importPublicStatus(row) {
  const progress = parseJobProgress(row.progress_json);
  const payload = parseJobProgress(row.payload_json);
  const total = Array.isArray(payload.rows) ? payload.rows.length : 0;
  const counts = importCounts(Array.isArray(progress.results) ? progress.results : [], total);
  const status = row.status === "done" ? "done" : row.status === "failed" ? "failed" : row.status === "running" ? "running" : "queued";
  return {
    ok: true,
    id: row.id,
    status,
    kind: payload.kind === "series" ? "series" : "movie",
    name: payload.name || null,
    source: payload.source || null,
    ...counts,
    error: row.status === "failed" ? "The import stopped after several tries. Please try again later." : null,
  };
}

async function loadAccountImport(env, account, id) {
  if (!/^\d{1,15}$/.test(String(id))) return null;
  const row = await env.DB.prepare(
    "SELECT id, account_id, status, payload_json, progress_json FROM jobs WHERE id = ? AND type = ?"
  ).bind(Number(id), IMPORT_JOB_TYPE).first();
  return row && row.account_id === account.id ? row : null;
}

async function handleImportsApi(request, env, url, path) {
  if (path !== "/api/imports" && !path.startsWith("/api/imports/")) return null;
  const account = request.account || null;
  if (!account) return json({ ok: false, error: "Sign in to import titles.", signInRequired: true }, 401);
  if (!env || !env.DB) return json({ ok: false, error: "Imports aren't available right now." }, 503);
  try {
    const parts = path.split("/").filter(Boolean); // ["api", "imports", id?, sub?]
    if (parts.length === 2) {
      if (request.method !== "POST") return json({ ok: false, error: "Not found." }, 404);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      if (!body || !Array.isArray(body.rows)) {
        if (body && body.url) return json({ ok: false, error: "Importing from a link isn't supported yet: add the list as a row instead, or upload the file." }, 400);
        return json({ ok: false, error: "Expected a `rows` array." }, 400);
      }
      if (body.rows.length > IMPORT_ROWS_MAX) return json({ ok: false, error: `Too many titles in one import (limit ${IMPORT_ROWS_MAX}).` }, 413);
      const rows = importCleanRows(body.rows);
      if (!rows.length) return json({ ok: false, error: "No titles found in that file." }, 400);
      const busy = await env.DB.prepare(
        "SELECT id FROM jobs WHERE type = ? AND account_id = ? AND status IN ('queued', 'running') LIMIT 1"
      ).bind(IMPORT_JOB_TYPE, account.id).first();
      if (busy) return json({ ok: false, error: "An import is already running. Wait for it to finish.", id: busy.id }, 409);
      const created = await createJob(env, IMPORT_JOB_TYPE, {
        accountId: account.id,
        payload: {
          rows,
          kind: body.kind === "series" ? "series" : "movie",
          source: typeof body.source === "string" ? body.source.slice(0, 30) : null,
          name: typeof body.name === "string" ? body.name.slice(0, 120) : null,
        },
      });
      if (!created.ok) return json({ ok: false, error: "Imports aren't available right now." }, 503);
      return json({ ok: true, id: created.id, total: rows.length }, 202);
    }

    const row = await loadAccountImport(env, account, parts[2]);
    if (!row) return json({ ok: false, error: "Not found." }, 404);
    const sub = parts[3] || "";
    const progress = parseJobProgress(row.progress_json);
    const results = Array.isArray(progress.results) ? progress.results : [];

    if (!sub && request.method === "GET" && parts.length === 3) return json(importPublicStatus(row));

    if (sub === "review" && parts.length === 4 && request.method === "GET") {
      const payload = parseJobProgress(row.payload_json);
      const rows = Array.isArray(payload.rows) ? payload.rows : [];
      const review = [];
      results.forEach((r, i) => {
        if (r.status === "ambiguous") review.push({ row: i, title: rows[i] && rows[i].title, year: rows[i] && rows[i].year, candidates: r.candidates || [] });
      });
      return json({ ok: true, id: row.id, review });
    }

    if (sub === "review" && parts.length === 4 && request.method === "POST") {
      if (row.status !== "done") return json({ ok: false, error: "The import is still running." }, 409);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON body." }, 400);
      }
      const choices = body && Array.isArray(body.choices) ? body.choices.slice(0, IMPORT_ROWS_MAX) : null;
      if (!choices) return json({ ok: false, error: "Expected a `choices` array." }, 400);
      const payload = parseJobProgress(row.payload_json);
      const kind = payload.kind === "series" ? "series" : "movie";
      const key = showScheduleTmdbKey(env);
      const next = results.slice();
      let lookups = 0;
      for (const c of choices) {
        const i = Number(c && c.row);
        const r = Number.isInteger(i) ? next[i] : null;
        if (!r || r.status !== "ambiguous") continue;
        const pick = c.tmdbId == null ? null : (r.candidates || []).find((cand) => cand.tmdbId === Number(c.tmdbId));
        if (!pick) {
          next[i] = { status: "skipped" };
          continue;
        }
        // One IMDb lookup per choice, at most 50 per request.
        if (lookups >= 50) break;
        lookups++;
        const imdbId = key ? await importImdbFor(kind, pick.tmdbId, key) : null;
        next[i] = { status: "chosen", tmdbId: pick.tmdbId, imdbId, title: pick.title, year: pick.year };
      }
      const counts = importCounts(next, Array.isArray(payload.rows) ? payload.rows.length : next.length);
      const saved = await env.DB.prepare(
        "UPDATE jobs SET progress_json = ?, updated_at = ? WHERE id = ? AND status = 'done' AND progress_json = ?"
      ).bind(JSON.stringify({ ...progress, results: next, ...counts }), Date.now(), row.id, row.progress_json).run();
      if (!saved.meta || saved.meta.changes !== 1) return json({ ok: false, error: "The import changed meanwhile; try again." }, 409);
      return json({ ok: true, ...counts });
    }

    if (sub === "result" && parts.length === 4 && request.method === "GET") {
      const payload = parseJobProgress(row.payload_json);
      const type = payload.kind === "series" ? "series" : "movie";
      const items = [];
      const seen = new Set();
      for (const r of results) {
        if (r.status !== "matched" && r.status !== "chosen") continue;
        const id = r.imdbId || (r.tmdbId ? `tmdb:${r.tmdbId}` : null);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        items.push({ id, type, name: r.title || undefined, year: r.year || undefined });
      }
      return json({ ok: true, id: row.id, done: row.status === "done", items });
    }

    return json({ ok: false, error: "Not found." }, 404);
  } catch (e) {
    console.error("Imports API failed:", e);
    return json({ ok: false, error: "Imports aren't available right now." }, 503);
  }
}
