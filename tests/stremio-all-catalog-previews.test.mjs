import { it } from 'node:test';
import assert from 'node:assert/strict';
import { makeKv, makeD1, makeEnv, call, createUser } from './harness.mjs';

it('user-created movie and series lists enrich TMDB-only IDs with truthful metadata', async () => {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1(), TMDB_API_KEY: 'testkey' });
  const user = await createUser(env, 'universalpreview');
  const list = (id, name, type) => 'customlist:v1:' + JSON.stringify({ listSlug: name, items: [{ id, type, title: name, poster: 'https://example.org/saved.jpg', year: '1990' }] });
  await env.CONFIGS.put('cfg:allprev', JSON.stringify({ trackCreatorName: user.creatorName, trackCreatorKey: user.creatorKey, showBadgesStremio: false, entries: [
    { id: 'm', type: 'movie', name: 'My Movies', url: list('tmdb:99871', 'My Movie', 'movie') },
    { id: 's', type: 'series', name: 'My Shows', url: list('tmdb:99872', 'My Show', 'series') },
  ] }));
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const m = String(url).match(/\/3\/(movie|tv)\/(9987[12])\?/);
    if (!m) throw new Error(`unexpected ${url}`);
    return Response.json({ id: +m[2], overview: 'TMDB plot', runtime: 125, episode_run_time: [45], release_date: '2020-01-01', first_air_date: '2021-01-01', vote_average: 8.1,
      genres: [{ id: 18, name: 'Drama' }], images: { logos: [{ iso_639_1: 'fr', file_path: '/french.png' }, { iso_639_1: null, file_path: '/neutral.png' }, { iso_639_1: 'en', file_path: '/english.png' }] }, credits: { cast: [{ id: 123, name: 'Actor' }], crew: [{ id: 456, name: 'Director', job: 'Director' }] } });
  };
  try {
    const movies = (await call(env, '/allprev/catalog/movie/m.json')).body.metas;
    const shows = (await call(env, '/allprev/catalog/series/s.json')).body.metas;
    assert.equal(movies[0].id, 'tmdb:99871'); assert.equal(movies[0].name, 'My Movie');
    assert.equal(movies[0].poster, 'https://example.org/saved.jpg'); assert.equal(movies[0].releaseInfo, '1990');
    assert.equal(movies[0].description, 'TMDB plot'); assert.equal(movies[0].runtime, '125 min');
    assert.deepEqual(movies[0].genres, ['Drama']); assert.equal(movies[0].imdbRating, undefined);
    assert.ok(movies[0].links.some(l => l.category === 'Cast' && l.name === 'Actor'));
    assert.ok(movies[0].links.some(l => l.category === 'Directors' && l.name === 'Director'));
    assert.equal(shows[0].runtime, '45 min');
    assert.equal(movies[0].logo, 'https://image.tmdb.org/t/p/original/english.png');
    assert.equal(shows[0].logo, 'https://image.tmdb.org/t/p/original/english.png');
    assert.ok(urls.every(u => u.includes('append_to_response=credits,images') && u.includes('include_image_language=en,null')));
    assert.ok(urls.some(u => u.includes('/movie/99871?'))); assert.ok(urls.some(u => u.includes('/tv/99872?')));
    const count = urls.length; await call(env, '/allprev/catalog/movie/m.json'); assert.equal(urls.length, count);
  } finally { globalThis.fetch = originalFetch; }
});

it('search catalogs use the same preview fields without labelling TMDB votes as IMDb', async () => {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1(), TMDB_API_KEY: 'testkey' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const s = String(url);
    if (s.includes('/search/movie?')) return Response.json({ results: [{ id: 99441, title: 'Search Movie', overview: 'Search plot', vote_average: 8.5 }] });
    if (s.includes('/movie/99441?') && s.includes('external_ids,videos,release_dates')) return Response.json({ id: 99441, external_ids: {} });
    if (s.includes('/movie/99441?') && s.includes('append_to_response=credits')) return Response.json({ id: 99441, overview: 'Detail plot', runtime: 90, genres: [{ id: 18, name: 'Drama' }], credits: {} });
    throw new Error(`unexpected ${s}`);
  };
  try {
    const m = (await call(env, '/catalog/movie/search_movies/search=previewexample.json')).body.metas[0];
    assert.equal(m.id, 'tmdb:99441'); assert.equal(m.description, 'Search plot'); assert.equal(m.runtime, '90 min');
    assert.equal(m.imdbRating, undefined); assert.equal(m.vote_average, 8.5);
  } finally { globalThis.fetch = originalFetch; }
});

it('enriches every page of merged custom sources without changing order', async () => {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1() });
  const user = await createUser(env, 'previewpaging');
  const items = Array.from({ length: 101 }, (_, i) => ({ id: 'tt' + String(7300000 + i), type: 'movie', title: `Movie ${i}` }));
  const list = (slug, arr) => 'customlist:v1:' + JSON.stringify({ listSlug: slug, items: arr });
  await env.CONFIGS.put('cfg:pageprev', JSON.stringify({ trackCreatorName: user.creatorName, trackCreatorKey: user.creatorKey, showBadgesStremio: false, entries: [
    { id: 'page', type: 'movie', name: 'Large List', url: list('large', items) },
    { id: 'merged', type: 'movie', name: 'Merged', url: `${list('left', items.slice(0, 1))}\n${list('right', items.slice(1, 2))}` },
  ] }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const match = String(url).match(/\/meta\/movie\/(tt\d+)\.json/);
    if (!match) throw new Error(`unexpected ${url}`);
    return Response.json({ meta: { id: match[1], type: 'movie', description: `Plot ${match[1]}`, logo: `https://images.metahub.space/logo/medium/${match[1]}/img` } });
  };
  try {
    const first = (await call(env, '/pageprev/catalog/movie/page.json')).body.metas;
    const second = (await call(env, '/pageprev/catalog/movie/page/skip=100.json')).body.metas;
    const merged = (await call(env, '/pageprev/catalog/movie/merged.json')).body.metas;
    assert.equal(first.length, 100); assert.equal(first[99].description, 'Plot tt7300099');
    assert.equal(second.length, 1); assert.equal(second[0].description, 'Plot tt7300100');
    assert.deepEqual(merged.map(m => m.name), ['Movie 0', 'Movie 1']);
    assert.ok(merged.every(m => m.description));
    assert.ok([...first, ...second, ...merged].every(m => m.logo === `https://images.metahub.space/logo/medium/${m.id}/img`));
  } finally { globalThis.fetch = originalFetch; }
});

it('falls back to same-type TMDB when Cinemeta has no IMDb record', async () => {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1(), TMDB_API_KEY: 'testkey' });
  const user = await createUser(env, 'previewfallback');
  const items = [{ id: 'tt7399961', title: 'Movie', type: 'movie' }, { id: 'tt7399962', title: 'Wrong kind', type: 'movie' }];
  await env.CONFIGS.put('cfg:fallprev', JSON.stringify({ trackCreatorName: user.creatorName, trackCreatorKey: user.creatorKey, showBadgesStremio: false, entries: [{ id: 'list', type: 'movie', name: 'List', url: 'customlist:v1:' + JSON.stringify({ listSlug: 'fallback', items }) }] }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('v3-cinemeta')) return new Response('{}', { status: 404 });
    if (u.includes('/find/tt7399961')) return Response.json({ movie_results: [{ id: 99111 }], tv_results: [{ id: 99999 }] });
    if (u.includes('/find/tt7399962')) return Response.json({ movie_results: [], tv_results: [{ id: 99999 }] });
    if (u.includes('/movie/99111?')) return Response.json({ id: 99111, overview: 'TMDB fallback plot', genres: [], credits: {}, images: { logos: [{ iso_639_1: null, file_path: '/fallback.png' }] } });
    throw new Error(`unexpected ${u}`);
  };
  try {
    const metas = (await call(env, '/fallprev/catalog/movie/list.json')).body.metas;
    assert.equal(metas[0].id, 'tt7399961'); assert.equal(metas[0].description, 'TMDB fallback plot');
    assert.equal(metas[1].description, undefined);
    assert.equal(metas[0].logo, 'https://image.tmdb.org/t/p/original/fallback.png');
    assert.equal(metas[1].logo, undefined);
  } finally { globalThis.fetch = realFetch; }
});

it('missing or unsafe title art leaves usable text titles, while neutral TMDB art is supported', async () => {
  const env = makeEnv({ CONFIGS: makeKv(), DB: makeD1(), TMDB_API_KEY: 'testkey' });
  const user = await createUser(env, 'logofallback');
  const ids = ['tt7399971', 'tt7399972', 'tt7399973', 'tmdb:99774', 'tmdb:99775', 'tmdb:99776'];
  await env.CONFIGS.put('cfg:logocfg', JSON.stringify({ trackCreatorName: user.creatorName, trackCreatorKey: user.creatorKey, showBadgesStremio: false, entries: [{ id: 'list', type: 'movie', name: 'Logos', url: 'customlist:v1:' + JSON.stringify({ listSlug: 'logos', items: ids.map(id => ({ id, type: 'movie', title: id })) }) }] }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const cin = u.match(/\/meta\/movie\/(tt\d+)\.json/);
    if (cin) return Response.json({ meta: { id: cin[1], type: cin[1] === ids[2] ? 'series' : 'movie', logo: cin[1] === ids[0] ? undefined : 'javascript:alert(1)' } });
    if (u.includes('/find/')) return Response.json({ movie_results: [] });
    const tmdb = u.match(/\/movie\/(9977[456])\?/);
    if (tmdb) return Response.json({ id: +tmdb[1], images: { logos: tmdb[1] === '99774' ? [{ iso_639_1: null, file_path: '/neutral.png' }] : tmdb[1] === '99775' ? [{ iso_639_1: 'fr', file_path: '/fr.png' }] : [{ iso_639_1: 'en', file_path: '//evil.example/logo.png' }] } });
    throw new Error(`unexpected ${u}`);
  };
  try {
    const metas = (await call(env, '/logocfg/catalog/movie/list.json')).body.metas;
    assert.deepEqual(metas.map(m => m.name), ids);
    assert.equal(metas[3].logo, 'https://image.tmdb.org/t/p/original/neutral.png');
    assert.ok(metas.filter((_, i) => i !== 3).every(m => m.logo === undefined));
  } finally { globalThis.fetch = realFetch; }
});
