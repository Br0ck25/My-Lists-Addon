import { it } from 'node:test';
import assert from 'node:assert/strict';
import { makeKv, makeD1, makeEnv, call, createUser } from './harness.mjs';

it('Recommended movie and series catalog items include Discover previews, retaining order and posters', async () => {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1(), TMDB_API_KEY: 'test' });
  const user = await createUser(env, 'recommendedpreview');
  await env.CONFIGS.put('cfg:reccfg', JSON.stringify({ track: true, trackCreatorName: user.creatorName, trackCreatorKey: user.creatorKey, showBadgesStremio: false, provideMetadata: false, entries: [
    { id: 'movies', type: 'movie', name: 'Recommended', url: 'custom:curated:recommended-movies' },
    { id: 'shows', type: 'series', name: 'Recommended', url: 'custom:curated:recommended-shows' },
  ] }));
  const saved = await call(env, '/api/creator/sync/save-tracking', { method: 'POST', json: { creatorName: user.creatorName, creatorKey: user.creatorKey, curatedRecommendations: {
    movies: [{ tmdbId: '81001', name: 'Movie A', poster: 'https://example.org/a.jpg', year: '2015' }, { tmdbId: '81002', name: 'Movie B' }],
    shows: [{ tmdbId: '81003', name: 'Show C' }], updatedAt: Date.now(),
  } } });
  assert.equal(saved.body.ok, true);
  const realFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    const s = String(url); requests.push(s);
    const tmdb = s.match(/\/3\/(movie|tv)\/(8100[123])\/external_ids/);
    if (tmdb) return Response.json({ imdb_id: `tt${tmdb[2]}99` });
    const cin = s.match(/\/meta\/(movie|series)\/(tt\d+)\.json/);
    if (cin) return Response.json({ meta: { id: cin[2], type: cin[1], name: 'Provider', description: 'Full plot', runtime: '118 min', imdbRating: '7.2', genres: ['Comedy'], links: [{ name: 'Actor', category: 'Cast', url: 'https://example.org/actor' }] } });
    throw new Error(`unexpected fetch ${s}`);
  };
  try {
    const movies = (await call(env, '/reccfg/catalog/movie/movies.json')).body.metas;
    const shows = (await call(env, '/reccfg/catalog/series/shows.json')).body.metas;
    assert.deepEqual(movies.map(x => x.name), ['Movie A', 'Movie B']);
    assert.equal(movies[0].id, 'tt8100199');
    assert.equal(movies[0].poster, 'https://example.org/a.jpg');
    assert.equal(movies[0].releaseInfo, '2015');
    assert.equal(movies[0].description, 'Full plot');
    assert.equal(movies[0].runtime, '118 min');
    assert.equal(movies[0].imdbRating, '7.2');
    assert.equal(movies[0].links[0].category, 'Cast');
    assert.equal(shows[0].description, 'Full plot');
    assert.ok(requests.some(s => s.includes('/meta/series/tt8100399.json')));
    assert.ok(requests.some(s => s.includes('/meta/movie/tt8100199.json')));
  } finally { globalThis.fetch = realFetch; }
});

it('an older Recommended custom-list wrapper gets previews too, without enriching unrelated lists', async () => {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
  const user = await createUser(env, 'wrappedrec');
  const wrap = (name, id) => 'customlist:v1:' + JSON.stringify({ name, listSlug: name === 'Recommended' ? 'curated:recommended-movies' : 'ordinary', items: [{ id, type: 'movie', title: name }] });
  await env.CONFIGS.put('cfg:wrapcfg', JSON.stringify({ trackCreatorName: user.creatorName, trackCreatorKey: user.creatorKey, showBadgesStremio: false, entries: [
    { id: 'rec', type: 'movie', name: 'Recommended', url: wrap('Recommended', 'tt8877001') },
    { id: 'ordinary', type: 'movie', name: 'Ordinary', url: wrap('Ordinary', 'tt8877002') },
  ] }));
  const realFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return Response.json({ meta: { id: 'tt8877001', type: 'movie', name: 'Recommended', description: 'Wrapped plot' } });
  };
  try {
    const rec = (await call(env, '/wrapcfg/catalog/movie/rec.json')).body.metas;
    const ordinary = (await call(env, '/wrapcfg/catalog/movie/ordinary.json')).body.metas;
    assert.equal(rec[0].description, 'Wrapped plot');
    assert.equal(ordinary[0].description, undefined);
    assert.equal(requests.length, 1);
  } finally { globalThis.fetch = realFetch; }
});
