// Nuvio/Stremio Watch History: Episodes opens <app>-watch-episodes, the other pills <app>-watch-history.

const APP_HISTORY_URL = /^(autotrack:(?:nuvio|stremio)-)watch-(history|episodes):/;

function mediaAppHistoryFilter(listUrl) {
  const m = APP_HISTORY_URL.exec(String(listUrl || ''));
  return m && m[2] === 'episodes' ? 'episode' : '';
}

function mediaAppHistoryPill(listUrl, filter) {
  const btn = document.getElementById('detailTypeEpisodeBtn');
  if (!btn) return;
  const on = APP_HISTORY_URL.test(String(listUrl || ''));
  btn.style.display = on ? '' : 'none';
  btn.classList.toggle('active', on && filter === 'episode');
}

// True when the pill opened the other list.
function mediaAppHistorySwitch(params, newType) {
  const btn = document.getElementById('detailTypeEpisodeBtn');
  if (btn) btn.classList.toggle('active', newType === 'episode');
  const m = APP_HISTORY_URL.exec(String(params.listUrl || ''));
  if (!m || (newType === 'episode') === (m[2] === 'episodes')) return false;
  openListDetailsPage(params.name, 'mixed', params.listUrl.replace(APP_HISTORY_URL, '$1watch-' + (newType === 'episode' ? 'episodes' : 'history') + ':'), null, { preserveScroll: true, initialFilter: newType });
  return true;
}

// A tile's remove-button properties, or null for none. An episode tile removes one episode.
function mediaAppRemoveFields(listUrl, item) {
  const m = /^autotrack:(nuvio|stremio)-(watch-history|watch-episodes|continue-watching|library):/.exec(String(listUrl || ''));
  if (!m) return null;
  const fields = { removeExternalProvider: m[1], removeExternalTarget: m[2] === 'library' || m[2] === 'continue-watching' ? m[2] : 'history', removeExternalListId: m[2] === 'watch-episodes' ? 'watch-history' : m[2] };
  if (m[2] !== 'watch-episodes') return fields;
  return Object.assign(fields, { removeExternalId: item.showId, removeExternalSeason: item.seasonNum, removeExternalEpisode: item.episodeNum });
}

// {season, episode} from a remove button, {} for a whole title.
function mediaAppEpisodeBody(btn) {
  const season = Number(btn.dataset.season);
  const episode = Number(btn.dataset.episode);
  return btn.dataset.season != null && btn.dataset.episode != null && Number.isFinite(season) && Number.isFinite(episode) ? { season: season, episode: episode } : {};
}
