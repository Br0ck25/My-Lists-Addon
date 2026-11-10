// Add title on a Nuvio or Stremio Watch History page: the episode numbers of a whole season.

// [1..n] for the season, or null when the site could not list it.
async function mediaHistorySeasonEpisodes(tmdbId, season) {
  try {
    const res = await fetch(ORIGIN + '/api/show-episodes?tmdbId=' + encodeURIComponent(tmdbId) + '&season=' + encodeURIComponent(season));
    const data = await res.json();
    const list = data && data.ok && Array.isArray(data.episodes) ? data.episodes.map(function (e) { return Number(e.episode); }).filter(function (n) { return Number.isInteger(n) && n >= 1; }) : [];
    return list.length ? list : null;
  } catch (e) { return null; }
}
