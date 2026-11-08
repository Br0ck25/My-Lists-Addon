// Poster-tile text for Nuvio and Stremio list cards. An episode reads like the
// other lists ("Show S04E05", its title underneath) via formatWatchItemLabel;
// a movie keeps its own name. listUrl picks the app lists; resumeLabel is "44m left" style text, or ''.
function mediaAppTileText(s, resumeLabel, listUrl) {
  const isMediaApp = /^autotrack:(nuvio|stremio)-/.test(String(listUrl || ''));
  const isEpisode = isMediaApp && s.seasonNum != null && s.episodeNum != null && !!(s.showTitle || s.name);
  const ep = isEpisode && typeof formatWatchItemLabel === 'function'
    ? formatWatchItemLabel({ showTitle: s.showTitle || s.name, seasonNum: s.seasonNum, episodeNum: s.episodeNum, title: s.episodeTitle || '', isSeasonPremiere: s.isSeasonPremiere })
    : null;
  const code = s.seasonNum != null && s.episodeNum != null && !ep ? 'S' + s.seasonNum + 'E' + s.episodeNum + ' · ' : '';
  const resume = resumeLabel ? code + resumeLabel : '';
  return { name: ep ? ep.title : (s.name || ''), sub: resume || (ep ? ep.subtitle : '') || s.year || '' };
}
