
// --- The materializer (Phase 5, P5-11) ------------------------------------------
//
// "Remove duplicate items across lists" (dedupeAcrossLists) used to cost a
// whole home screen's worth of rows per row: dedupeAcrossListEntries rebuilt
// every earlier row of the same type to know what to strip, so a 20-row
// install did 1 + 2 + ... + 20 = 210 row builds for one home screen.
//
// With FF_MATERIALIZER on, the first page of every non-personal row of an
// install is built once (MATERIALIZER_CONCURRENCY at a time), de-duplicated in
// one pass in the rows' order, and kept for an hour: in this isolate's memory
// and in KV as one value per install, `snap:mat:{hash}` (the hash of the
// install's id and its rows, so an edited install is a new key). Each row's
// first page is then read from there; concurrent requests of one isolate
// share one build. At most one build per row per install per hour.
//
// It also finishes P4-2's metas: each materialized meta carries its `media_id`
// where the media table knows the title (read only), and a title or poster the
// row left empty is taken from there.
//
// Pages after the first, search, and personal shelves (which are never
// de-duplicated) take the usual path, as does everything with the flag off.
// dedupeAcrossListEntries is deleted once the flag is on for good.
//
// Metrics: one Analytics Engine point per build, index `materializer`,
// doubles [rows built, milliseconds].
//
// Module level, after the Worker's exports, like 27_ onward.

const MATERIALIZER_KV_PREFIX = "snap:mat:";
const MATERIALIZER_TTL_SEC = 60 * 60;
const MATERIALIZER_MEMO_MS = 60 * 1000;
const MATERIALIZER_MEMO_MAX = 200;
const MATERIALIZER_CONCURRENCY = 6;
const MATERIALIZER_MEMO = new Map();     // key -> { at, value }
const MATERIALIZER_BUILDING = new Map(); // key -> promise

function isMaterializerEnabled(env) {
  const v = env && env.FF_MATERIALIZER;
  return v === "1" || v === "true" || v === true;
}

function materializerRowKey(entry) {
  return `${entry.type}:${entry.id}`;
}

async function materializerKey(config, entries) {
  const shape = JSON.stringify(entries.map((e) => [e.id, e.type, e.url, e.enabled !== false]));
  const bytes = new TextEncoder().encode(String(config) + "\n" + shape);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return MATERIALIZER_KV_PREFIX + Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

function materializerRows(entries) {
  return entries.filter((e) => e && e.enabled !== false && !isPersonalShelfUrl(e.url));
}

// P4-2's remainder: media_id (and a missing title or poster) from `media`.
async function attachMaterializedMedia(env, pages) {
  if (!env || !env.DB) return;
  const imdb = new Set();
  const tmdb = new Set();
  for (const page of pages) {
    for (const m of page) {
      const id = String((m && m.id) || "");
      if (id.startsWith("tt")) imdb.add(id.split(":")[0]);
      else if (/^tmdb:\d+$/.test(id)) tmdb.add(Number(id.slice(5)));
    }
  }
  if (!imdb.size && !tmdb.size) return;
  let rows = [];
  try {
    ({ results: rows } = await env.DB.prepare(
      `SELECT id, kind, imdb_id, tmdb_id, title, poster_path FROM media
       WHERE imdb_id IN (SELECT value FROM json_each(?)) OR tmdb_id IN (SELECT value FROM json_each(?))`
    ).bind(JSON.stringify([...imdb]), JSON.stringify([...tmdb])).all());
  } catch {
    return; // No media table: the metas are served as built.
  }
  const byImdb = new Map();
  const byTmdb = new Map();
  for (const r of rows || []) {
    if (r.imdb_id) byImdb.set(r.imdb_id, r);
    if (r.tmdb_id) byTmdb.set(`${r.kind}:${r.tmdb_id}`, r);
  }
  for (const page of pages) {
    for (let i = 0; i < page.length; i++) {
      const m = page[i];
      if (!m || !m.id) continue;
      const id = String(m.id);
      const kind = m.type === "series" ? "series" : "movie";
      const row = id.startsWith("tt") ? byImdb.get(id.split(":")[0]) : /^tmdb:\d+$/.test(id) ? byTmdb.get(`${kind}:${id.slice(5)}`) : null;
      if (!row) continue;
      const patch = { media_id: row.id };
      if (!m.name && row.title) patch.name = row.title;
      if (!m.poster && row.poster_path) patch.poster = String(row.poster_path).startsWith("http") ? row.poster_path : `https://image.tmdb.org/t/p/w500${row.poster_path}`;
      page[i] = { ...m, ...patch };
    }
  }
}

// Builds page 0 of every row, de-duplicated. { builtAt, rows: { rowKey: { items, totalItems } } }.
async function buildMaterializedInstall(env, entries, keys) {
  const startedAt = Date.now();
  const rows = materializerRows(entries);
  const pages = new Array(rows.length).fill(null);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(MATERIALIZER_CONCURRENCY, rows.length) }, async () => {
    while (next < rows.length) {
      const i = next++;
      try {
        const metas = await fetchCatalog(rows[i], 0, keys);
        pages[i] = Array.isArray(metas) ? metas : null;
      } catch {
        pages[i] = null; // This row takes the usual path; it strips nothing.
      }
    }
  }));
  const seenByType = new Map();
  const out = {};
  const deduped = [];
  rows.forEach((row, i) => {
    const page = pages[i];
    if (!page) return;
    const seen = seenByType.get(row.type) || new Set();
    seenByType.set(row.type, seen);
    const kept = page.filter((m) => !m || !m.id || !seen.has(m.id));
    for (const m of page) if (m && m.id) seen.add(m.id);
    const tot = page.totalItems;
    const totalItems = typeof tot === "number" ? Math.max(kept.length, tot - (page.length - kept.length)) : null;
    deduped.push(kept);
    out[materializerRowKey(row)] = { items: kept, totalItems };
  });
  await attachMaterializedMedia(env, deduped);
  // attachMaterializedMedia replaced items in place in each `kept` array.
  const analytics = env && env.ANALYTICS && typeof env.ANALYTICS.writeDataPoint === "function" ? env.ANALYTICS : null;
  if (analytics) {
    try {
      analytics.writeDataPoint({ blobs: ["materializer"], doubles: [rows.length, Date.now() - startedAt], indexes: ["materializer"] });
    } catch {}
  }
  return { builtAt: Date.now(), rows: out };
}

async function readMaterializedInstall(env, key) {
  const now = Date.now();
  const memo = MATERIALIZER_MEMO.get(key);
  if (memo && now - memo.at < MATERIALIZER_MEMO_MS) return memo.value;
  let value = null;
  try {
    const raw = env.CONFIGS ? await env.CONFIGS.get(key, "json") : null;
    if (raw && raw.rows && now - (Number(raw.builtAt) || 0) < MATERIALIZER_TTL_SEC * 1000) value = raw;
  } catch {
    value = null;
  }
  if (value) rememberMaterialized(key, value);
  return value;
}

function rememberMaterialized(key, value) {
  if (MATERIALIZER_MEMO.size >= MATERIALIZER_MEMO_MAX) {
    const oldest = MATERIALIZER_MEMO.keys().next().value;
    if (oldest !== undefined) MATERIALIZER_MEMO.delete(oldest);
  }
  MATERIALIZER_MEMO.set(key, { at: Date.now(), value });
}

// The catalog route's call: this row's de-duplicated first page, or null for
// the usual path (the row is not materialized, or its build failed).
async function materializedRowPage(env, ctx, { config, entries, entryIndex, keys }) {
  const entry = entries[entryIndex];
  if (!entry || isPersonalShelfUrl(entry.url)) return null;
  const key = await materializerKey(config, entries);
  let value = await readMaterializedInstall(env, key);
  if (!value) {
    let building = MATERIALIZER_BUILDING.get(key);
    if (!building) {
      building = (async () => {
        const built = await buildMaterializedInstall(env, entries, keys);
        rememberMaterialized(key, built);
        if (env.CONFIGS) {
          const write = env.CONFIGS.put(key, JSON.stringify(built), { expirationTtl: MATERIALIZER_TTL_SEC }).catch(() => {});
          if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(write);
          else await write;
        }
        return built;
      })();
      MATERIALIZER_BUILDING.set(key, building);
      building.then(() => MATERIALIZER_BUILDING.delete(key), () => MATERIALIZER_BUILDING.delete(key));
    }
    try {
      value = await building;
    } catch {
      return null;
    }
  }
  const row = value && value.rows ? value.rows[materializerRowKey(entry)] : null;
  if (!row || !Array.isArray(row.items)) return null;
  const items = row.items.slice();
  if (typeof row.totalItems === "number") items.totalItems = row.totalItems;
  return items;
}
