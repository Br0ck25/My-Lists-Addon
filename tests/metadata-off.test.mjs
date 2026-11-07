import { it } from 'node:test';
import assert from 'node:assert/strict';
import { makeKv, makeD1, makeEnv, call } from './harness.mjs';

// "Use My Lists Addon metadata" off must leave this add-on lists-only: no
// detail pages (meta) and no search rows, so Stremio/Nuvio send both to
// whichever other add-on provides them.
async function install(env, name, extra) {
  await env.CONFIGS.put(`cfg:${name}`, JSON.stringify({ entries: [{ id: 'a', type: 'movie', name: 'A', url: 'https://mdblist.com/lists/u/a' }], ...extra }));
}

it('manifest with metadata off declares no title meta and no search catalogs', async () => {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
  await install(env, 'metaoff', { provideMetadata: false });
  await install(env, 'metaon', {});
  const off = (await call(env, '/metaoff/manifest.json')).body;
  const on = (await call(env, '/metaon/manifest.json')).body;
  const metaOff = off.resources.find((r) => r && r.name === 'meta');
  assert.deepEqual(metaOff.idPrefixes, ['channel_']);
  assert.equal(off.catalogs.some((c) => c.id === 'search_movies' || c.id === 'search_series'), false);
  assert.equal(on.catalogs.some((c) => c.id === 'search_movies'), true);
  assert.equal(on.catalogs.some((c) => c.id === 'search_series'), true);
});

it('meta and search routes answer nothing for real titles when metadata is off', async () => {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
  await install(env, 'metaoff', { provideMetadata: false });
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => { requests.push(String(url)); return Response.json({}); };
  try {
    const meta = await call(env, '/metaoff/meta/series/tt0903747.json');
    assert.equal(meta.body.meta, null);
    const search = await call(env, '/metaoff/catalog/movie/search_movies/search=matrix.json');
    assert.deepEqual(search.body.metas, []);
    assert.equal(requests.length, 0, 'no provider lookups when metadata is off');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
