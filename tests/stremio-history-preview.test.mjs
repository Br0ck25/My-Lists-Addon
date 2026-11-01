import { it } from 'node:test';
import assert from 'node:assert/strict';
import { makeKv, makeD1, makeEnv, call, createUser } from './harness.mjs';

it('history catalog supplies Stremio preview metadata without changing titles or other rows', async () => {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
  const user = await createUser(env, 'previewhistory');
  const config = 'prevcfg';
  await env.CONFIGS.put(`cfg:${config}`, JSON.stringify({ track: true, trackCreatorName: user.creatorName, trackCreatorKey: user.creatorKey, showBadgesStremio: false, provideMetadata: false, entries: [
    { id: 'history', type: 'movie', name: 'History', url: `autotrack:watch-history:movie:${user.creatorName}` },
    { id: 'shows', type: 'series', name: 'Shows', url: `autotrack:watch-history:series:${user.creatorName}` },
    { id: 'watchlist', type: 'movie', name: 'Watchlist', url: `autotrack:watchlist:movie:${user.creatorName}` },
  ] }));
  const saved = await call(env, '/api/creator/sync/save-tracking', { method: 'POST', json: { creatorName: user.creatorName, creatorKey: user.creatorKey,
    watchHistory: [{ id: 'tt8823456', type: 'movie', name: 'Saved title', poster: 'https://example.org/poster.jpg', watchedAt: 1234 }, { id: 'tt8823457:1:1', type: 'episode', showId: 'tt8823457', showTitle: 'Saved show', seasonNum: 1, episodeNum: 1, watchedAt: 1200 }],
    watchlist: [{ id: 'tt8823458', type: 'movie', name: 'Other' }], watchlistUpdatedAt: Date.now(),
  }});
  assert.equal(saved.body.ok, true);
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    const match = String(url).match(/\/meta\/(movie|series)\/(tt\d+)\.json$/);
    assert.ok(match, `unexpected lookup ${url}`);
    return Response.json({ meta: { id: match[2], type: match[1], name: 'Provider title', description: 'A synopsis', runtime: '120 min', releaseInfo: '2020', imdbRating: '7.5', genres: ['Drama'], links: [{ name: 'Actor', category: 'Cast', url: 'https://example.org/actor' }], videos: [{ id: 'unwanted' }] } });
  };
  try {
    const movie = (await call(env, `/${config}/catalog/movie/history.json`)).body.metas;
    const shows = (await call(env, `/${config}/catalog/series/shows.json`)).body.metas;
    assert.equal(movie.length, 1); assert.equal(shows.length, 1);
    assert.equal(movie[0].name, 'Saved title'); assert.equal(movie[0].poster, 'https://example.org/poster.jpg');
    assert.equal(movie[0].description, 'A synopsis'); assert.equal(movie[0].runtime, '120 min');
    assert.equal(movie[0].imdbRating, '7.5'); assert.deepEqual(movie[0].genres, ['Drama']);
    assert.equal(movie[0].links[0].category, 'Cast'); assert.equal(movie[0].videos, undefined);
    assert.equal(shows[0].description, 'A synopsis'); assert.equal(shows[0].id, 'tt8823457');
    assert.ok(requests.some(u => u.includes('/movie/tt8823456.json')));
    assert.ok(requests.some(u => u.includes('/series/tt8823457.json')));
    const count = requests.length;
    await call(env, `/${config}/catalog/movie/history.json`);
    assert.equal(requests.length, count, 'cached history makes no new metadata request');
    const watchlist = (await call(env, `/${config}/catalog/movie/watchlist.json`)).body.metas;
    assert.equal(watchlist[0].description, 'A synopsis');
  } finally { globalThis.fetch = originalFetch; }
});

it('history survives missing, mismatched, or unavailable metadata', async () => {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
  const user = await createUser(env, 'previewoffline');
  await env.CONFIGS.put('cfg:offlinecfg', JSON.stringify({ track: true, trackCreatorName: user.creatorName, trackCreatorKey: user.creatorKey, showBadgesStremio: false, entries: [{ id: 'history', type: 'movie', name: 'History', url: `autotrack:watch-history:movie:${user.creatorName}` }] }));
  await call(env, '/api/creator/sync/save-tracking', { method: 'POST', json: { creatorName: user.creatorName, creatorKey: user.creatorKey, watchHistory: [
    { id: 'tt8823461', type: 'movie', name: 'Mismatch', watchedAt: 3 }, { id: 'tt8823462', type: 'movie', name: 'Offline', watchedAt: 2 }, { id: 'tmdb:42', type: 'movie', name: 'TMDB only', watchedAt: 1 },
  ] } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { if (String(url).includes('tt8823462')) throw new Error('offline'); return Response.json({ meta: { id: 'tt8823461', type: 'series', description: 'Wrong type' } }); };
  try {
    const metas = (await call(env, '/offlinecfg/catalog/movie/history.json')).body.metas;
    assert.deepEqual(metas.map(m => m.name), ['Mismatch', 'Offline', 'TMDB only']);
    assert.ok(metas.every(m => !m.description));
  } finally { globalThis.fetch = originalFetch; }
});
