import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Nuvio and Stremio list cards must name an episode "Show S04E05" with its
// title underneath, like the other lists; a movie keeps its plain name.
const src = fs.readFileSync(new URL('../src/client/20_client-app-episode-label.js', import.meta.url), 'utf8');
const ctx = {
  formatWatchItemLabel: (it) => ({ title: it.showTitle + ' S' + String(it.seasonNum).padStart(2, '0') + 'E' + String(it.episodeNum).padStart(2, '0'), subtitle: it.title || 'Episode ' + it.episodeNum }),
};
vm.createContext(ctx);
vm.runInContext(src, ctx);
const tile = ctx.mediaAppTileText;
const nuvio = 'autotrack:nuvio-watch-history:mixed:me';

test('app episode shows SxEx and its title', () => {
  const t = tile({ name: 'Person of Interest', showTitle: 'Person of Interest', seasonNum: 5, episodeNum: 9, episodeTitle: 'Sotto Voce' }, '', nuvio);
  assert.equal(t.name, 'Person of Interest S05E09');
  assert.equal(t.sub, 'Sotto Voce');
});

test('resume text replaces the subtitle and does not repeat SxEx', () => {
  const t = tile({ name: 'Silo', showTitle: 'Silo', seasonNum: 2, episodeNum: 1 }, '44m left', nuvio);
  assert.equal(t.name, 'Silo S02E01');
  assert.equal(t.sub, '44m left');
});

test('movies and non-app lists are unchanged', () => {
  assert.deepEqual({ ...tile({ name: 'Vehicle 19', year: '2013' }, '', nuvio) }, { name: 'Vehicle 19', sub: '2013' });
  assert.equal(tile({ name: 'Show', seasonNum: 1, episodeNum: 2 }, '', 'trakt:history').name, 'Show');
});
